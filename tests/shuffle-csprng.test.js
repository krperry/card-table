const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

function getShuffleReport(port) {
  return new Promise((resolve, reject) => {
    const script = [
      `process.env.PORT = '${port}';`,
      "process.env.NODE_ENV = 'test';",
      "const s = require('./server.js');",
      "let randomCalls = 0;",
      "const originalRandom = Math.random;",
      "Math.random = function () { randomCalls += 1; return originalRandom(); };",
      "const original = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];",
      "const deck = original.slice();",
      "for (let i = 0; i < 500; i++) { s.shuffle(deck); }",
      "Math.random = originalRandom;",
      "const sameElements = deck.slice().sort().join(',') === original.slice().sort().join(',');",
      "const summary = { randomCalls: randomCalls, length: deck.length, sameElements: sameElements };",
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
        reject(new Error('No result from child process. stdout=' + out + ' stderr=' + err));
        return;
      }
      try {
        resolve(JSON.parse(out.slice(index + marker.length).trim()));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

test('shuffle() never calls Math.random() and still produces a valid permutation', async () => {
  const report = await getShuffleReport(3195);

  assert.equal(report.randomCalls, 0, 'shuffle() should use a CSPRNG, not Math.random()');
  assert.equal(report.length, 10);
  assert.equal(report.sameElements, true, 'shuffle() must reorder, never drop/duplicate, cards');
});
