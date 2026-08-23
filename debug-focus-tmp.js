const { chromium } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3221;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 15000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`listening on port ${PORT}`)) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', (chunk) => console.error('SERVER ERR:', chunk.toString()));
  });
}

(async () => {
  const server = spawn(process.execPath, [path.join('C:/repos/card-table', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '80' }
  });
  await waitForServer(server);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));

  await page.goto(`http://127.0.0.1:${PORT}`);
  const email = `debug-${Date.now()}@example.com`;
  await page.fill('#email-input', email);
  await page.fill('#password-input', 'secret123');
  await page.fill('#display-name-input', 'DebugTester');
  await page.click('#create-account-btn');
  await page.waitForFunction(() => typeof appState !== 'undefined' && appState.loggedIn === true, { timeout: 10000 });

  await page.click('#select-rummy-btn');
  await page.fill('#new-table-name', 'Debug Table');
  await page.click('#create-table-btn');
  await page.waitForSelector('#start-game-btn:not([disabled])', { timeout: 10000 });
  await page.click('#start-game-btn');

  await page.waitForFunction(() => {
    return typeof appState !== 'undefined' && appState.rummyTurnPlayerId === socket.id && appState.rummyTurnPhase === 'draw' && Array.isArray(appState.rummyHand) && appState.rummyHand.length > 0;
  }, { timeout: 20000 });

  await page.waitForFunction(() => {
    const hand = document.getElementById('rummy-hand');
    return !!(hand && hand.contains(document.activeElement));
  }, { timeout: 5000 });

  const before = await page.evaluate(() => {
    const a = document.activeElement;
    return { id: a.id, tag: a.tagName, card: a.dataset ? a.dataset.card : null };
  });
  console.log('BEFORE DRAW active element:', before);

  await page.evaluate(() => {
    window.__blurLog = [];
    const hand = document.getElementById('rummy-hand');
    document.getElementById('rummy-hand').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('blur', function () {
        window.__blurLog.push({ card: btn.dataset.card, stack: new Error().stack });
      });
    });
  });

  await page.keyboard.press('d');
  await page.waitForFunction(() => appState.rummyTurnPhase === 'action', { timeout: 5000 });
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => {
    const a = document.activeElement;
    return { id: a.id, tag: a.tagName, card: a.dataset ? a.dataset.card : null, className: a.className };
  });
  console.log('AFTER DRAW active element:', after);

  const bodyIsActive = await page.evaluate(() => document.activeElement === document.body);
  console.log('body is active:', bodyIsActive);

  await browser.close();
  server.kill();
})().catch(e => { console.error(e); process.exit(1); });
