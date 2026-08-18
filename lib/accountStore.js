// SQLite-backed account store (node:sqlite - built into Node, no npm
// dependency). Exposes the same small set of operations server.js used to
// perform directly against an in-memory array loaded from data/accounts.json,
// so the storage swap doesn't ripple through the rest of the file. On first
// startup against a fresh database path, migrates any existing legacy
// accounts.json into it once (see migrateFromJson) and leaves the JSON file
// in place afterward.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const COLUMN_TO_FIELD = {
  id: 'id',
  email: 'email',
  email_lower: 'emailLower',
  display_name: 'displayName',
  display_name_lower: 'displayNameLower',
  password_hash: 'passwordHash',
  password_salt: 'passwordSalt',
  created_at: 'createdAt',
  remember_token_hash: 'rememberTokenHash',
  remember_token_issued_at: 'rememberTokenIssuedAt'
};

function rowToAccount(row) {
  if (!row) {
    return null;
  }
  const account = {};
  Object.keys(COLUMN_TO_FIELD).forEach(function (column) {
    const value = row[column];
    if (value !== null && value !== undefined) {
      account[COLUMN_TO_FIELD[column]] = value;
    }
  });
  return account;
}

function createSchema(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS accounts (' +
    'id TEXT PRIMARY KEY,' +
    'email TEXT UNIQUE NOT NULL,' +
    'email_lower TEXT UNIQUE NOT NULL,' +
    'display_name TEXT NOT NULL,' +
    'display_name_lower TEXT UNIQUE NOT NULL,' +
    'password_hash TEXT NOT NULL,' +
    'password_salt TEXT NOT NULL,' +
    'created_at TEXT NOT NULL,' +
    'remember_token_hash TEXT,' +
    'remember_token_issued_at TEXT' +
    ');' +
    'CREATE TABLE IF NOT EXISTS game_results (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'account_id TEXT NOT NULL,' +
    'game_type TEXT NOT NULL,' +
    'result TEXT NOT NULL,' +
    'finished_at TEXT NOT NULL' +
    ');' +
    'CREATE INDEX IF NOT EXISTS idx_game_results_account ON game_results (account_id, game_type);'
  );
}

function migrateFromJson(db, legacyJsonPath, log) {
  if (!legacyJsonPath || !fs.existsSync(legacyJsonPath)) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8'));
  } catch (error) {
    log('Unable to read legacy accounts.json for migration: ' + error.message);
    return;
  }

  const legacyAccounts = parsed && Array.isArray(parsed.accounts) ? parsed.accounts : [];
  if (legacyAccounts.length === 0) {
    return;
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO accounts (id, email, email_lower, display_name, display_name_lower, password_hash, password_salt, created_at, remember_token_hash, remember_token_issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  db.exec('BEGIN');
  try {
    legacyAccounts.forEach(function (account) {
      insert.run(
        account.id, account.email, account.emailLower, account.displayName, account.displayNameLower,
        account.passwordHash, account.passwordSalt, account.createdAt,
        account.rememberTokenHash || null, account.rememberTokenIssuedAt || null
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  log('Migrated ' + legacyAccounts.length + ' account(s) from ' + legacyJsonPath + ' into ' + 'the SQLite account store.');
}

function createAccountStore(options) {
  const dbPath = options.dbPath;
  const legacyJsonPath = options.legacyJsonPath;
  const log = options.log || function () {};

  const dirPath = path.dirname(dbPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const isNewDatabase = !fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  createSchema(db);
  if (isNewDatabase) {
    migrateFromJson(db, legacyJsonPath, log);
  }

  const statements = {
    findByEmail: db.prepare('SELECT * FROM accounts WHERE email_lower = ?'),
    findByDisplayName: db.prepare('SELECT * FROM accounts WHERE display_name_lower = ?'),
    findById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    findByRememberTokenHash: db.prepare('SELECT * FROM accounts WHERE remember_token_hash = ?'),
    insert: db.prepare(
      'INSERT INTO accounts (id, email, email_lower, display_name, display_name_lower, password_hash, password_salt, created_at, remember_token_hash, remember_token_issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    update: db.prepare(
      'UPDATE accounts SET email = ?, email_lower = ?, display_name = ?, display_name_lower = ?, password_hash = ?, password_salt = ?, remember_token_hash = ?, remember_token_issued_at = ? WHERE id = ?'
    ),
    remove: db.prepare('DELETE FROM accounts WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS c FROM accounts'),
    insertGameResult: db.prepare('INSERT INTO game_results (account_id, game_type, result, finished_at) VALUES (?, ?, ?, ?)')
  };

  return {
    findByEmail: function (emailLower) {
      return rowToAccount(statements.findByEmail.get(emailLower));
    },
    findByDisplayName: function (displayNameLower) {
      return rowToAccount(statements.findByDisplayName.get(displayNameLower));
    },
    findById: function (id) {
      return rowToAccount(statements.findById.get(id));
    },
    findByRememberTokenHash: function (tokenHash) {
      return rowToAccount(statements.findByRememberTokenHash.get(tokenHash));
    },
    insert: function (account) {
      statements.insert.run(
        account.id, account.email, account.emailLower, account.displayName, account.displayNameLower,
        account.passwordHash, account.passwordSalt, account.createdAt,
        account.rememberTokenHash || null, account.rememberTokenIssuedAt || null
      );
      return account;
    },
    update: function (account) {
      statements.update.run(
        account.email, account.emailLower, account.displayName, account.displayNameLower,
        account.passwordHash, account.passwordSalt,
        account.rememberTokenHash || null, account.rememberTokenIssuedAt || null,
        account.id
      );
      return account;
    },
    remove: function (id) {
      statements.remove.run(id);
    },
    count: function () {
      return statements.count.get().c;
    },
    recordGameResult: function (accountId, gameType, result) {
      if (!accountId) {
        return;
      }
      statements.insertGameResult.run(accountId, gameType, result, new Date().toISOString());
    }
  };
}

module.exports = { createAccountStore: createAccountStore };
