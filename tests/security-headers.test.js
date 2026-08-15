const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for server on port ${port}`));
    }, 10000);

    child.stdout.on('data', (chunk) => {
      const output = chunk.toString();
      if (output.includes(`listening on port ${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr.on('data', (chunk) => {
      const output = chunk.toString();
      if (output.includes('ReferenceError')) {
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

function getHeaders(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${requestPath}`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers));
    }).on('error', reject);
  });
}

test('helmet security headers (including CSP) are applied to served pages', async () => {
  const port = 3194;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, port);

    const headers = await getHeaders(port, '/');

    assert.ok(headers['content-security-policy'], 'expected a Content-Security-Policy header');
    assert.match(headers['content-security-policy'], /default-src 'self'/);
    assert.doesNotMatch(headers['content-security-policy'], /unsafe-inline/);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
  } finally {
    child.kill('SIGTERM');
  }
});
