const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');
const CARDS_DIR = path.join(REPO_ROOT, 'public', 'images', 'lumo', 'cards');

function fetchStatus(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: body }));
    });
    req.on('error', reject);
  });
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for server on port ${port}`));
    }, 10000);

    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`listening on port ${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr.on('data', (chunk) => {
      const output = chunk.toString();
      if (output.includes('Unable to start server') || output.includes('EADDRINUSE')) {
        clearTimeout(timeout);
        reject(new Error(output));
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

function getServerExports(port) {
  return new Promise((resolve, reject) => {
    const script = [
      `process.env.PORT = '${port}';`,
      "const s = require('./server.js');",
      "const deck = s.createDeck();",
      "const giveCards = deck.filter((c) => s.cardType(c) === 'GivePlusOne');",
      "const summary = {",
      "  total: deck.length,",
      "  giveCount: giveCards.length,",
      "  giveColors: giveCards.map((c) => s.cardColor(c)).sort(),",
      "  giveScore: s.cardScore(1000),",
      "  giveDescription: s.describeCard(1000, null)",
      "};",
      "console.log('__RESULT__' + JSON.stringify(summary));",
      "process.exit(0);"
    ].join('\n');

    const child = spawn(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('exit', () => {
      const marker = '__RESULT__';
      const index = out.indexOf(marker);
      if (index === -1) {
        reject(new Error('Did not get deck summary from server.js: ' + err));
        return;
      }
      try {
        resolve(JSON.parse(out.slice(index + marker.length).trim()));
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.on('error', reject);
  });
}

test('the Lumo deck includes two Give Plus One cards per color worth 20 points each', async () => {
  const summary = await getServerExports(3130);

  assert.equal(summary.total, 116, 'the deck must total 116 cards per public/lumo-rules.md');
  assert.equal(summary.giveCount, 8, 'two Give Plus One cards per color (4 colors)');
  assert.deepEqual(summary.giveColors, ['blue', 'blue', 'green', 'green', 'red', 'red', 'yellow', 'yellow']);
  assert.equal(summary.giveScore, 20);
  assert.match(summary.giveDescription, /Give Plus One/i);
});

test('every Lumo card SVG referenced by the card model can be requested from the running server', async () => {
  const port = 3131;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, port);

    const fileListPath = path.join(CARDS_DIR, 'FILE_LIST.txt');
    assert.ok(fs.existsSync(fileListPath), 'FILE_LIST.txt should ship alongside the card artwork');

    const files = fs.readFileSync(fileListPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.svg'));

    assert.ok(files.length > 0);

    for (const file of files) {
      const response = await fetchStatus(port, '/images/lumo/cards/' + encodeURIComponent(file));
      assert.equal(response.statusCode, 200, `${file} should be served with a 200 status`);
      assert.match(response.body, /<svg/i, `${file} should be an SVG document`);
    }

    // A Give Plus One card for every color must exist among the shipped files.
    ['red', 'yellow', 'green', 'blue'].forEach((color) => {
      assert.ok(files.indexOf(color + '_give_plus_1.svg') !== -1, `${color}_give_plus_1.svg must be present`);
    });
  } finally {
    child.kill('SIGTERM');
  }
});

test('the old UNO sprite-sheet artwork is no longer shipped or referenced', async () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'public', 'images', 'deck.svg')), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'public', 'images', 'uno.svg')), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'public', 'lumo-cards')), false, 'card artwork should have moved into public/images/lumo/cards');

  // Card artwork path handling lives in the Lumo client module (public/games/lumo/lumo-client.js),
  // not the shared app shell (public/main.js) - see the games/lumo split.
  const mainJsSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'main.js'), 'utf8');
  const lumoClientSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'games', 'lumo', 'lumo-client.js'), 'utf8');
  const combinedClientSource = mainJsSource + '\n' + lumoClientSource;
  assert.doesNotMatch(combinedClientSource, /images\/deck\.svg/);
  assert.doesNotMatch(combinedClientSource, /images\/uno\.svg/);
  assert.match(combinedClientSource, /images\/lumo\/cards\//);

  const indexHtmlSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(indexHtmlSource, /images\/uno\.svg/);
});

test('the Lumo rules page is reachable and the table/lobby view exposes a Read Lumo Rules control', async () => {
  const port = 3132;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, port);

    const rulesResponse = await fetchStatus(port, '/lumo-rules.md');
    assert.equal(rulesResponse.statusCode, 200);
    assert.match(rulesResponse.body, /Give \+1/i);

    const indexResponse = await fetchStatus(port, '/index.html');
    assert.equal(indexResponse.statusCode, 200);
    assert.match(indexResponse.body, /Read Lumo Rules/);
    assert.match(indexResponse.body, /id="rules-overlay"/);
    assert.match(indexResponse.body, /id="rules-title"/);
    assert.match(indexResponse.body, />Close Rules</);
  } finally {
    child.kill('SIGTERM');
  }
});

test('Q and Shift+Q speech helpers never include the internal card sort/score value', () => {
  const mainJsSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'main.js'), 'utf8');
  const lumoClientSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'games', 'lumo', 'lumo-client.js'), 'utf8');
  const combinedClientSource = mainJsSource + '\n' + lumoClientSource;

  // Regression guard for the old behavior that appended entry.score to the spoken text.
  assert.doesNotMatch(combinedClientSource, /describeCardForSpeech\(entry\.card\)\s*\+\s*['"]\s*['"]\s*\+\s*entry\.score/);
  assert.match(combinedClientSource, /function formatCardTypeForSpeech/);
  assert.match(combinedClientSource, /Give Plus One/);
});

test('all user-facing UNO references in the client and server were renamed to Lumo', () => {
  const mainJsSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'main.js'), 'utf8');
  const lumoClientSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'games', 'lumo', 'lumo-client.js'), 'utf8');
  const combinedClientSource = mainJsSource + '\n' + lumoClientSource;
  const indexHtmlSource = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');
  const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  const lumoServerSource = fs.readFileSync(path.join(REPO_ROOT, 'games', 'lumo', 'index.js'), 'utf8');
  const combinedServerSource = serverSource + '\n' + lumoServerSource;

  assert.doesNotMatch(indexHtmlSource, /<title>Uno<\/title>/i);
  assert.match(indexHtmlSource, /<title>Lumo<\/title>/);
  assert.match(indexHtmlSource, /<h1>Lumo Online<\/h1>/);
  assert.doesNotMatch(combinedClientSource, /says UNO/);
  assert.match(combinedClientSource, /says Lumo/);
  assert.doesNotMatch(combinedServerSource, /says UNO/);
  assert.match(combinedServerSource, /name: 'Lumo'/);
});
