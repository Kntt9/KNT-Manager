import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const _cookieStatus = {};'), source.indexOf('const _gameNameCache = {};'));

function harness(validateCookie, list = [{ id: 'a', cookie: 'session-a' }]) {
  let now = 1_000_000;
  const context = vm.createContext({
    api: { validateCookie }, accounts: list,
    document: { querySelector: () => null },
    renderDashboard() {}, render() {}, pushStatusHistory() {}, logEntry() {}, setInterval() {},
    Date: { now: () => now },
  });
  vm.runInContext(block + '\n globalThis.health = { checkCookieHealth, recheckAllCookies, _flagCookieMaybeDead, status: _cookieStatus };', context);
  return { health: context.health, list, advance: ms => { now += ms; } };
}

for (const status of [0, 403, 429, 500, 503]) {
  test(`HTTP ${status} does not label a session expired`, async () => {
    const { health, list } = harness(async () => ({ ok: false, status }));
    await health.checkCookieHealth(list);
    assert.equal(health.status.a, 'unknown');
  });
}

test('a confirmed 401 is not retried every minute, including forced refresh', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { ok: false, status: 401 }; });
  await h.health.checkCookieHealth(h.list);
  assert.equal(h.health.status.a, 'dead');
  h.advance(600_000);
  await h.health.recheckAllCookies(false);
  await h.health.recheckAllCookies(true);
  assert.equal(calls, 1);
  h.list[0].cookie = 'replacement';
  await h.health.recheckAllCookies(false);
  assert.equal(calls, 2);
});

test('successful initial validation records the five minute interval', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { ok: true, status: 200 }; });
  await h.health.checkCookieHealth(h.list);
  h.advance(60_000);
  await h.health.recheckAllCookies(false);
  assert.equal(calls, 1);
  h.advance(240_000);
  await h.health.recheckAllCookies(false);
  assert.equal(calls, 2);
});

test('initial and periodic checks share one in-flight guard', async () => {
  let finish;
  let calls = 0;
  const h = harness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const running = h.health.checkCookieHealth(h.list);
  await h.health.recheckAllCookies(true);
  assert.equal(calls, 1);
  finish({ ok: true, status: 200 });
  await running;
});

test('a network rejection releases the guard and can be checked again later', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error('offline'); });
  await h.health.checkCookieHealth(h.list);
  assert.equal(h.health.status.a, 'unknown');
  await h.health.recheckAllCookies(false);
  assert.equal(calls, 1);
  h.advance(60_000);
  await h.health.recheckAllCookies(false);
  assert.equal(calls, 2);
});

test('stale validation cannot mark a replacement cookie dead', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const running = h.health.checkCookieHealth(h.list);
  h.list[0].cookie = 'new';
  finish({ ok: false, status: 401 });
  await running;
  assert.equal(h.health.status.a, undefined);
});

test('launch error text marks expiry only for an explicit HTTP 401', () => {
  const { health } = harness(async () => null);
  for (const error of ['Cookie may be expired', 'HTTP 403', 'HTTP 429', 'CSRF request timed out']) {
    health._flagCookieMaybeDead('a', error);
    assert.equal(health.status.a, undefined);
  }
  health._flagCookieMaybeDead('a', 'Authentication stopped (HTTP 401)');
  assert.equal(health.status.a, 'dead');
});
