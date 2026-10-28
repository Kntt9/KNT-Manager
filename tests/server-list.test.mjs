import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('async function _srvFetchRaw('), source.indexOf('// Re-validates a single server RIGHT BEFORE'));

function harness(authReply) {
  const calls = [];
  const cache = {};
  const context = vm.createContext({
    Date, _srvCache: cache, SRV_TTL: 20000, _srvCtx: { accountId: 'a' },
    accounts: [{ id: 'a', cookie: 'fake-session' }],
    api: {
      robloxGetAuth: async () => { calls.push('auth'); return authReply; },
      robloxGet: async () => { calls.push('public'); return { ok: true, status: 200, data: { data: [{ id: 'server-1', playing: 1, maxPlayers: 10 }] } }; },
    },
    _srvSortOrder: () => 'Asc', _srvCacheSweep() {}, _srvPruneHighlighted() {},
  });
  vm.runInContext(block + '\nglobalThis.load = _srvFetchRaw;', context);
  return { load: context.load, calls, cache };
}

for (const status of [401, 403, 429]) {
  test(`server list stops on HTTP ${status}, without caching or anonymous fallback`, async () => {
    const h = harness({ ok: false, status, data: {} });
    await assert.rejects(h.load('1818', 2, true, false), error => error.status === status);
    assert.deepEqual(h.calls, ['auth']);
    assert.equal(h.cache['1818'], undefined);
  });
}

test('temporary upstream failure can still use the existing public fallback', async () => {
  const h = harness({ ok: false, status: 503, data: {} });
  const result = await h.load('1818', 2, true, false);
  assert.equal(result.servers[0].id, 'server-1');
  assert.deepEqual(h.calls, ['auth', 'public']);
});
