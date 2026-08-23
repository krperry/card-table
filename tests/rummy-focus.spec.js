// Playwright end-to-end regression test for the Rummy screen-reader focus
// requirement: every keyboard shortcut (draw from stock, draw from discard,
// sort) must speak its result WITHOUT moving keyboard focus off the hand
// grid - the player should never have to Tab back to the table after using
// a shortcut. Unlike tests/rummy-*.test.js (which drive the server directly
// over socket.io-client), this test drives a real browser so it can assert
// on real DOM focus (document.activeElement), which a socket-only test
// can't observe.
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3220;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for server on port ${PORT}`));
    }, 15000);

    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`listening on port ${PORT}`)) {
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

let serverProcess;

test.beforeAll(async () => {
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '80' }
  });
  await waitForServer(serverProcess);
});

test.afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

async function activeCardInfo(page) {
  return page.evaluate(() => {
    const hand = document.getElementById('rummy-hand');
    const active = document.activeElement;
    return {
      insideHand: !!(hand && active && hand.contains(active)),
      card: active && active.dataset ? active.dataset.card : null,
      tag: active ? active.tagName : null,
      id: active ? active.id : null
    };
  });
}

test('draw, sort, and draw-from-discard keep keyboard focus on the hand grid', async ({ page }) => {
  await page.goto(BASE_URL);

  const email = `focus-test-${Date.now()}@example.com`;
  await page.fill('#email-input', email);
  await page.fill('#password-input', 'secret123');
  await page.fill('#display-name-input', 'FocusTester');
  await page.click('#create-account-btn');

  await page.waitForFunction(() => typeof appState !== 'undefined' && appState.loggedIn === true, { timeout: 10000 });

  await page.click('#select-rummy-btn');
  await page.fill('#new-table-name', 'Focus Test Table');
  await page.click('#create-table-btn');

  await page.waitForSelector('#start-game-btn:not([disabled])', { timeout: 10000 });
  await page.click('#start-game-btn');

  // Two seats total (host + the one default computer player): the dealer is
  // always the host on hand 1, so the seat AFTER the dealer goes first - the
  // bot. Wait it out until it's this player's own draw turn.
  await page.waitForFunction(() => {
    return typeof appState !== 'undefined'
      && appState.rummyTurnPlayerId === socket.id
      && appState.rummyTurnPhase === 'draw'
      && Array.isArray(appState.rummyHand)
      && appState.rummyHand.length > 0;
  }, { timeout: 20000 });

  // rummyTurnState's handler moves focus onto the hand grid the moment this
  // player's draw turn begins (see rummyFocusHand() in rummy-client.js) -
  // confirm that landed before testing that it STAYS there.
  await page.waitForFunction(() => {
    const hand = document.getElementById('rummy-hand');
    return !!(hand && hand.contains(document.activeElement));
  }, { timeout: 5000 });

  const beforeDraw = await activeCardInfo(page);
  expect(beforeDraw.insideHand, 'focus should start on the hand grid').toBe(true);

  // --- 1. Draw from stock ('d') must announce the card and keep focus on the hand grid ---
  await page.keyboard.press('d');
  await page.waitForFunction(() => appState.rummyTurnPhase === 'action', { timeout: 5000 });
  await page.waitForTimeout(250);

  const afterDraw = await activeCardInfo(page);
  expect(afterDraw.insideHand, 'focus must stay on the hand grid after drawing from stock (no tabbing back required)').toBe(true);

  const drawStatus = await page.evaluate(() => document.getElementById('sr-status').textContent);
  expect(drawStatus).toMatch(/^You draw .+\.$/);
  expect(drawStatus).not.toMatch(/from the discard/i);

  // --- 2. Sort ('g') must re-sort, announce, and keep focus on the hand grid ---
  await page.keyboard.press('g');
  await page.waitForTimeout(250);

  const afterSort = await activeCardInfo(page);
  expect(afterSort.insideHand, 'focus must stay on the hand grid after sorting with g').toBe(true);

  const sortStatus = await page.evaluate(() => document.getElementById('sr-status').textContent);
  expect(sortStatus).toMatch(/sorted/i);

  // End this turn (Enter discards the focused card) so the next human turn
  // has a non-empty discard pile to test the 'w' shortcut against.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => appState.rummyTurnPlayerId !== socket.id || appState.rummyTurnPhase !== 'action', { timeout: 5000 });

  await page.waitForFunction(() => {
    return appState.rummyTurnPlayerId === socket.id && appState.rummyTurnPhase === 'draw';
  }, { timeout: 20000 });
  await page.waitForFunction(() => {
    const hand = document.getElementById('rummy-hand');
    return !!(hand && hand.contains(document.activeElement));
  }, { timeout: 5000 });

  const discardTopBefore = await page.evaluate(() => appState.rummyDiscardTop);
  expect(discardTopBefore, 'discard pile should have a card to draw by this point').toBeTruthy();

  // --- 3. Draw from the discard pile ('w') must announce it came from the
  // discard pile and keep focus on the hand grid ---
  await page.keyboard.press('w');
  await page.waitForFunction(() => appState.rummyTurnPhase === 'action', { timeout: 5000 });
  await page.waitForTimeout(250);

  const afterDrawDiscard = await activeCardInfo(page);
  expect(afterDrawDiscard.insideHand, 'focus must stay on the hand grid after drawing from the discard pile').toBe(true);

  const drawDiscardStatus = await page.evaluate(() => document.getElementById('sr-status').textContent);
  expect(drawDiscardStatus).toMatch(/from the discard/i);
});
