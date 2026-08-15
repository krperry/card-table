const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const io = require('socket.io-client');

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
      if (output.includes('Unable to start server') || output.includes('EADDRINUSE') || output.includes('ReferenceError')) {
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

function connectAndRegister(port, email, displayName) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Timed out waiting for loginResult'));
    }, 10000);

    socket.on('connect', () => {
      socket.emit('registerAccount', {
        email: email,
        password: 'secret123',
        displayName: displayName,
        rememberMe: true
      });
    });

    socket.on('loginResult', (payload) => {
      if (!payload.success) {
        clearTimeout(timeout);
        socket.disconnect();
        reject(new Error(payload.message || 'Login failed'));
        return;
      }

      clearTimeout(timeout);
      resolve({ socket, payload });
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(err);
    });
  });
}

function waitForEvent(socket, eventName, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs || 10000);

    function handler(payload) {
      if (predicate && !predicate(payload)) {
        return;
      }

      clearTimeout(timeout);
      socket.off(eventName, handler);
      resolve(payload);
    }

    socket.on(eventName, handler);
  });
}

test('on reconnect, tableState always reaches the client before game-specific resync events', async () => {
  const port = 3196;
  const email = `reorder-${Date.now()}@example.com`;
  const displayName = `Reorder${Date.now()}`.slice(0, 20);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '40' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let firstSocket;
  let secondSocket;

  try {
    await waitForServer(child, port);

    const auth = await connectAndRegister(port, email, displayName);
    firstSocket = auth.socket;
    const rememberToken = auth.payload.rememberToken;

    const tableName = `Reorder Table ${Date.now()}`;
    const createdTablePromise = waitForEvent(firstSocket, 'tableState', function (payload) {
      return payload && payload.table && payload.table.name === tableName;
    }, 5000).then((payload) => payload.table);
    firstSocket.emit('createTable', { name: tableName, gameType: 'uno', computerPlayers: 3 });
    const createdTable = await createdTablePromise;

    const inGamePromise = waitForEvent(firstSocket, 'tableState', function (payload) {
      return payload && payload.table && payload.table.status === 'in_game';
    }, 5000);
    firstSocket.emit('startGame');
    await inGamePromise;

    // Give the bots a moment to take their first couple of turns, so a
    // reconnect actually has in-flight turn/discard state to resync.
    await new Promise((resolve) => setTimeout(resolve, 300));

    firstSocket.disconnect();

    // Reconnect as the same account and record every event in the exact
    // order the client receives it - this is what actually broke before the
    // fix (a game-specific resync event like 'turnPlayer' or 'haveCard'
    // arriving before 'tableState', which the real browser client assumes
    // never happens).
    secondSocket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const receivedOrder = [];
    secondSocket.onAny((eventName) => {
      receivedOrder.push(eventName);
    });

    const reconnectedTableState = waitForEvent(secondSocket, 'tableState', function (payload) {
      return payload && payload.table && payload.table.id === createdTable.id;
    }, 5000);

    secondSocket.on('connect', () => {
      secondSocket.emit('resumeLogin', { token: rememberToken });
    });

    await reconnectedTableState;
    // Let any immediately-following resync events (haveCard, turnPlayer,
    // discardCard, ...) arrive too before inspecting the recorded order.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const tableStateIndex = receivedOrder.indexOf('tableState');
    assert.ok(tableStateIndex !== -1, 'expected a tableState event on reconnect');

    const resyncEvents = ['haveCard', 'turnPlayer', 'discardCard'];
    const resyncIndexes = resyncEvents
      .map((name) => receivedOrder.indexOf(name))
      .filter((index) => index !== -1);

    assert.ok(resyncIndexes.length > 0, 'expected at least one game-specific resync event on reconnect: ' + JSON.stringify(receivedOrder));
    resyncIndexes.forEach((index) => {
      assert.ok(index > tableStateIndex, 'tableState must arrive before resync events, got order: ' + JSON.stringify(receivedOrder));
    });
  } finally {
    if (firstSocket && firstSocket.connected) {
      firstSocket.disconnect();
    }
    if (secondSocket && secondSocket.connected) {
      secondSocket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
