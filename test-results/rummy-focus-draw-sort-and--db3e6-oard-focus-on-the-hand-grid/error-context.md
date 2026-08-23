# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: rummy-focus.spec.js >> draw, sort, and draw-from-discard keep keyboard focus on the hand grid
- Location: tests\rummy-focus.spec.js:73:1

# Error details

```
Error: focus must stay on the hand grid after drawing from stock (no tabbing back required)

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  19  |       child.kill();
  20  |       reject(new Error(`Timed out waiting for server on port ${PORT}`));
  21  |     }, 15000);
  22  | 
  23  |     child.stdout.on('data', (chunk) => {
  24  |       if (chunk.toString().includes(`listening on port ${PORT}`)) {
  25  |         clearTimeout(timeout);
  26  |         resolve();
  27  |       }
  28  |     });
  29  | 
  30  |     child.stderr.on('data', (chunk) => {
  31  |       const output = chunk.toString();
  32  |       if (output.includes('Unable to start server') || output.includes('EADDRINUSE') || output.includes('ReferenceError')) {
  33  |         clearTimeout(timeout);
  34  |         reject(new Error(output));
  35  |       }
  36  |     });
  37  | 
  38  |     child.on('exit', (code) => {
  39  |       clearTimeout(timeout);
  40  |       reject(new Error(`Server exited early with code ${code}`));
  41  |     });
  42  |   });
  43  | }
  44  | 
  45  | let serverProcess;
  46  | 
  47  | test.beforeAll(async () => {
  48  |   serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  49  |     env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '80' }
  50  |   });
  51  |   await waitForServer(serverProcess);
  52  | });
  53  | 
  54  | test.afterAll(async () => {
  55  |   if (serverProcess) {
  56  |     serverProcess.kill();
  57  |   }
  58  | });
  59  | 
  60  | async function activeCardInfo(page) {
  61  |   return page.evaluate(() => {
  62  |     const hand = document.getElementById('rummy-hand');
  63  |     const active = document.activeElement;
  64  |     return {
  65  |       insideHand: !!(hand && active && hand.contains(active)),
  66  |       card: active && active.dataset ? active.dataset.card : null,
  67  |       tag: active ? active.tagName : null,
  68  |       id: active ? active.id : null
  69  |     };
  70  |   });
  71  | }
  72  | 
  73  | test('draw, sort, and draw-from-discard keep keyboard focus on the hand grid', async ({ page }) => {
  74  |   await page.goto(BASE_URL);
  75  | 
  76  |   const email = `focus-test-${Date.now()}@example.com`;
  77  |   await page.fill('#email-input', email);
  78  |   await page.fill('#password-input', 'secret123');
  79  |   await page.fill('#display-name-input', 'FocusTester');
  80  |   await page.click('#create-account-btn');
  81  | 
  82  |   await page.waitForFunction(() => typeof appState !== 'undefined' && appState.loggedIn === true, { timeout: 10000 });
  83  | 
  84  |   await page.click('#select-rummy-btn');
  85  |   await page.fill('#new-table-name', 'Focus Test Table');
  86  |   await page.click('#create-table-btn');
  87  | 
  88  |   await page.waitForSelector('#start-game-btn:not([disabled])', { timeout: 10000 });
  89  |   await page.click('#start-game-btn');
  90  | 
  91  |   // Two seats total (host + the one default computer player): the dealer is
  92  |   // always the host on hand 1, so the seat AFTER the dealer goes first - the
  93  |   // bot. Wait it out until it's this player's own draw turn.
  94  |   await page.waitForFunction(() => {
  95  |     return typeof appState !== 'undefined'
  96  |       && appState.rummyTurnPlayerId === socket.id
  97  |       && appState.rummyTurnPhase === 'draw'
  98  |       && Array.isArray(appState.rummyHand)
  99  |       && appState.rummyHand.length > 0;
  100 |   }, { timeout: 20000 });
  101 | 
  102 |   // rummyTurnState's handler moves focus onto the hand grid the moment this
  103 |   // player's draw turn begins (see rummyFocusHand() in rummy-client.js) -
  104 |   // confirm that landed before testing that it STAYS there.
  105 |   await page.waitForFunction(() => {
  106 |     const hand = document.getElementById('rummy-hand');
  107 |     return !!(hand && hand.contains(document.activeElement));
  108 |   }, { timeout: 5000 });
  109 | 
  110 |   const beforeDraw = await activeCardInfo(page);
  111 |   expect(beforeDraw.insideHand, 'focus should start on the hand grid').toBe(true);
  112 | 
  113 |   // --- 1. Draw from stock ('d') must announce the card and keep focus on the hand grid ---
  114 |   await page.keyboard.press('d');
  115 |   await page.waitForFunction(() => appState.rummyTurnPhase === 'action', { timeout: 5000 });
  116 |   await page.waitForTimeout(250);
  117 | 
  118 |   const afterDraw = await activeCardInfo(page);
> 119 |   expect(afterDraw.insideHand, 'focus must stay on the hand grid after drawing from stock (no tabbing back required)').toBe(true);
      |                                                                                                                        ^ Error: focus must stay on the hand grid after drawing from stock (no tabbing back required)
  120 | 
  121 |   const drawStatus = await page.evaluate(() => document.getElementById('sr-status').textContent);
  122 |   expect(drawStatus).toMatch(/^You draw .+\.$/);
  123 |   expect(drawStatus).not.toMatch(/from the discard/i);
  124 | 
  125 |   // --- 2. Sort ('g') must re-sort, announce, and keep focus on the hand grid ---
  126 |   await page.keyboard.press('g');
  127 |   await page.waitForTimeout(250);
  128 | 
  129 |   const afterSort = await activeCardInfo(page);
  130 |   expect(afterSort.insideHand, 'focus must stay on the hand grid after sorting with g').toBe(true);
  131 | 
  132 |   const sortStatus = await page.evaluate(() => document.getElementById('sr-status').textContent);
  133 |   expect(sortStatus).toMatch(/sorted/i);
  134 | 
  135 |   // End this turn (Enter discards the focused card) so the next human turn
  136 |   // has a non-empty discard pile to test the 'w' shortcut against.
  137 |   await page.keyboard.press('Enter');
  138 |   await page.waitForFunction(() => appState.rummyTurnPlayerId !== socket.id || appState.rummyTurnPhase !== 'action', { timeout: 5000 });
  139 | 
  140 |   await page.waitForFunction(() => {
  141 |     return appState.rummyTurnPlayerId === socket.id && appState.rummyTurnPhase === 'draw';
  142 |   }, { timeout: 20000 });
  143 |   await page.waitForFunction(() => {
  144 |     const hand = document.getElementById('rummy-hand');
  145 |     return !!(hand && hand.contains(document.activeElement));
  146 |   }, { timeout: 5000 });
  147 | 
  148 |   const discardTopBefore = await page.evaluate(() => appState.rummyDiscardTop);
  149 |   expect(discardTopBefore, 'discard pile should have a card to draw by this point').toBeTruthy();
  150 | 
  151 |   // --- 3. Draw from the discard pile ('w') must announce it came from the
  152 |   // discard pile and keep focus on the hand grid ---
  153 |   await page.keyboard.press('w');
  154 |   await page.waitForFunction(() => appState.rummyTurnPhase === 'action', { timeout: 5000 });
  155 |   await page.waitForTimeout(250);
  156 | 
  157 |   const afterDrawDiscard = await activeCardInfo(page);
  158 |   expect(afterDrawDiscard.insideHand, 'focus must stay on the hand grid after drawing from the discard pile').toBe(true);
  159 | 
  160 |   const drawDiscardStatus = await page.evaluate(() => document.getElementById('sr-status').textContent);
  161 |   expect(drawDiscardStatus).toMatch(/from the discard/i);
  162 | });
  163 | 
```