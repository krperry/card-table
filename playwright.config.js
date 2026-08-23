// Minimal Playwright config, scoped to *.spec.js files only so the
// existing node:test suite (tests/*.test.js) is never picked up by the
// Playwright runner (and vice versa - node --test tests/*.test.js already
// ignores *.spec.js).
module.exports = {
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true
  }
};
