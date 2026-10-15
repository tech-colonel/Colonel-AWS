const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// A scratch home, so the test never touches the real connector settings.
process.env.COLONEL_CONNECTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'colonel-app-test-'));
const { createApp, APP_ID } = require('../src/app');

const get = (port, urlPath, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ code: res.statusCode, body }));
  });
  req.on('error', reject); req.end();
});
const post = async (port, urlPath, body, headers = { 'X-Colonel-UI': '1' }) => {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { code: r.status, ...(await r.json()) };
};

test('app window server: state, guards and input checks', async () => {
  const app = createApp();
  const { port, already } = await app.listen(0);
  try {
    assert.strictEqual(already, false);

    const page = await get(port, '/');
    assert.strictEqual(page.code, 200);
    assert.match(page.body, /Colonel Tally Connector/);

    const state = JSON.parse((await get(port, '/api/state')).body);
    assert.strictEqual(state.app, APP_ID);
    assert.strictEqual(state.logged_in, false);
    assert.strictEqual(state.token, undefined, 'the connector token must never reach the window');

    // Another site (DNS rebinding) or a page without the app header gets nothing.
    assert.strictEqual((await get(port, '/api/state', { Host: 'evil.example' })).code, 403);
    assert.strictEqual((await post(port, '/api/sync', {}, {})).code, 403);

    assert.strictEqual((await post(port, '/api/sync', {})).code, 400, 'no sync before login');
    assert.strictEqual((await post(port, '/api/tally', { host: 'bad host!', port: 9002 })).code, 400);
    assert.strictEqual((await post(port, '/api/tally', { host: 'localhost', port: 0 })).code, 400);
    assert.strictEqual((await post(port, '/api/login', { server_url: 'ftp://x', email: 'a@b.c', password: 'p' })).code, 400);
    assert.strictEqual((await post(port, '/api/settings', { interval_minutes: 0 })).code, 400);

    assert.strictEqual((await post(port, '/api/settings', { interval_minutes: 30, companies: ['Demo Traders Pvt Ltd'] })).ok, true);
    const after = JSON.parse((await get(port, '/api/state')).body);
    assert.strictEqual(after.interval_minutes, 30);
    assert.deepStrictEqual(after.companies, ['Demo Traders Pvt Ltd']);
    assert.strictEqual(after.next_sync_at, null, 'nothing is scheduled while logged out');
  } finally {
    app.stop();
  }
});
