import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

let server;
let base;
before(async () => {
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [fileURLToPath(new URL('../web/server.mjs', import.meta.url)), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(([code]) => { throw new Error('Server exited: ' + code); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000); timer.unref(); }),
  ]);
});
after(async () => {
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
});

test('web relay serves its local page without permissive CORS', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /KNT Manager/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('malformed JSON returns 400 and the process stays alive', async () => {
  const response = await fetch(base + '/api/altgen', { method: 'POST', body: '{bad' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /JSON/);
  assert.equal((await fetch(base)).status, 200);
});

test('oversized request is rejected before parsing or calling an upstream', async () => {
  const response = await fetch(base + '/api/altgen', { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal(response.status, 413);
  assert.equal((await fetch(base)).status, 200);
});

test('foreign web pages cannot submit session data to the local relay', async () => {
  const response = await fetch(base + '/api/validate-cookie', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: 'fake-session' });
  assert.equal(response.status, 403);
});

test('foreign Host headers are rejected', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(base, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('invalid URL encoding returns 400 without crashing', async () => {
  assert.equal((await fetch(base + '/%ZZ')).status, 400);
  assert.equal((await fetch(base)).status, 200);
});
