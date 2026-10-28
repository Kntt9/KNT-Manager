import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');
function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'renderer test boundaries exist');
  return source.slice(start, end);
}
const code = [
  block('async function doLaunch()', '// ── Server list'),
  block('function _extractPlaceId(', '// Only accept a real public-server record'),
  block('function _srvHasSlots(', '// ── Central server data layer'),
  block('async function _srvValidateServer(', '// Keeps the cache bounded:'),
  block('const _srvPendingEntries =', '// ── Packages'),
  block('function pkgMembers(', 'function pkgState('),
  block('async function relaunchDownedPackage(', 'async function trimPackage('),
  block('// Only plain place IDs', 'async function killPackage('),
].join('\n');

const server = (id, playing = 1, maxPlayers = 10, ping = 30) => ({ id, playing, maxPlayers, ping });
const response = (data, nextPageCursor = null) => ({ ok: true, status: 200, data: { data, nextPageCursor } });
function harness({ pages = [response([server('s1'), server('s2'), server('s3')])], launch, members = 3, link = '12345', presence = {}, rawServers = [] } = {}) {
  const calls = [], urls = [], messages = [], joined = [], validations = [], cancelled = [], opened = [];
  const accounts = Array.from({ length: members }, (_, i) => ({ id: 'a' + i, username: 'Account ' + i, cookie: 'fake-' + i }));
  const packages = [{ id: 'p', name: 'Group', accountIds: accounts.map(a => a.id), link, launchDelay: 0 }];
  const launchedIds = new Set();
  const context = vm.createContext({
    Map, Set, Math, Number, Object, String, Infinity, Promise, setTimeout, clearTimeout,
    accounts, packages, settings: { multiInstance: true }, _launchingId: null, launchAcc: null,
    _srvCtx: { packageId: 'p', placeId: '12345' }, _srvList: [], _srvPresence: presence,
    _launchedIds: launchedIds, _homeIds: new Set(), _sessionLaunched: new Set(), _cookieStatus: {},
    api: {
      robloxGet: async url => { urls.push(url); const next = pages[Math.min(urls.length - 1, pages.length - 1)]; return typeof next === 'function' ? next(url) : next; },
      robloxGetAuth: async () => { throw new Error('public metadata must not use account cookies'); },
      launchRoblox: async (id, cookie, target) => { calls.push({ id, target }); return launch ? launch(id, target, calls.length) : { success: true }; },
      cancelLaunch: async id => { cancelled.push(id); },
    },
    document: { querySelector: () => null, getElementById: () => null },
    renderPackages() {}, _srvEnterSpinner() {}, closeModal() {}, openLaunch: id => opened.push(id), logEntry() {}, setStatus() {}, esc: value => String(value),
    markLaunched: id => launchedIds.add(id),
    _flagCookieMaybeDead() {},
    _srvAddJoined: (id, placeId, jobId) => { joined.push({ id, placeId, jobId }); presence[jobId] = [...(presence[jobId] || []), id]; },
    _srvAccountLeft() {},
    _srvFetchRaw: async (...args) => { validations.push(args); return { servers: rawServers }; },
    toast: (message, type) => messages.push({ message, type }),
    t: (key, values = {}) => key + (Object.keys(values).length ? ' ' + JSON.stringify(values) : ''),
  });
  vm.runInContext(code + '\nglobalThis.flow = { _srvFetchCandidates, _srvValidateServer, _pkgPublicPlace, doLaunch, distributePkg, launchPackage, launchPkgToServer, launchPkgToPasted, launchToServer, joinRandomServer, cancelPackageLaunch, relaunchDownedPackage, pkgMembers, jobs: _pkgLaunchJobs, reservations: _pkgReservedServers };', context);
  return { flow: context.flow, context, accounts, packages, calls, urls, messages, joined, validations, cancelled, opened };
}

test('distribution selects distinct occupied servers by population and ping, including a single free slot', async () => {
  const h = harness({ members: 4, pages: [response([
    server('zero', 0), server('full', 10), server('three', 3), server('one-slow', 1, 10, 80),
    server('one-fast', 1, 10, 20), server('one-slot', 9), server('invalid', '1'),
    { id: 'missing' }, server('own', 1), server('negative', -1),
  ])], presence: { own: ['managed-live-account'] } });
  await h.flow.distributePkg('p');
  assert.deepEqual(h.calls.map(c => c.target), ['12345:one-fast', '12345:one-slow', '12345:three', '12345:one-slot']);
  assert.equal(h.urls.length, 1, 'no duplicate full-list validation pass');
  assert.equal(h.joined.length, 4);
});

test('pagination deduplicates IDs, honors newer occupancy, and encodes the cursor', async () => {
  const h = harness({ pages: [
    response([server('s1'), server('changed')], 'page + 2'),
    response([server('s1'), server('changed', 10), server('s2')]),
  ] });
  const result = await h.flow._srvFetchCandidates('12345', { needed: 4, minPlayers: 1 });
  assert.deepEqual([...result].map(s => s.id), ['s1', 's2']);
  assert.match(h.urls[1], /cursor=page%20%2B%202$/);
});

test('repeated pagination cursor is bounded', async () => {
  const h = harness({ pages: [response([], 'same')] });
  await h.flow._srvFetchCandidates('12345', { needed: 4 });
  assert.equal(h.urls.length, 2);
});

test('a shortage leaves excess accounts untouched instead of reusing servers', async () => {
  const h = harness({ pages: [response([server('s1'), server('s1'), server('s2')])] });
  await h.flow.distributePkg('p');
  assert.deepEqual(h.calls, [{ id: 'a0', target: '12345:s1' }, { id: 'a1', target: '12345:s2' }]);
  assert.match(h.messages.at(-1).message, /pkg.distributedPartial/);
});

test('an isolated account failure is not retried or reused and does not skip later accounts', async () => {
  const h = harness({ launch: async id => id === 'a0' ? { success: false, error: 'Authentication stopped (HTTP 401)' } : { success: true } });
  await h.flow.distributePkg('p');
  assert.deepEqual(h.calls.map(c => c.id), ['a0', 'a1', 'a2']);
  assert.equal(new Set(h.calls.map(c => c.target)).size, 3);
  assert.equal(h.joined.length, 2);
  assert.match(h.messages.at(-1).message, /HTTP 401/);
  assert.doesNotMatch(h.messages.at(-1).message, /distributedPartial/);
});

test('a rejected launch still releases the operation lock and continues with distinct targets', async () => {
  const h = harness({ launch: async id => { if (id === 'a0') throw new Error('IPC disconnected'); return { success: true }; } });
  await h.flow.distributePkg('p');
  assert.equal(h.calls.length, 3);
  assert.equal(h.flow.jobs.size, 0);
  assert.equal(h.flow.reservations.size, 0);
});

for (const status of [401, 403, 429, 503]) {
  test(`HTTP ${status} while listing does not launch any account or fall back to a plain game join`, async () => {
    const pages = [{ ok: false, status, data: { data: [server('should-never-launch')] } }];
    for (const action of ['distributePkg', 'launchPackage']) {
      const h = harness({ pages });
      await h.flow[action]('p');
      assert.equal(h.calls.length, 0);
      assert.equal(h.urls.length, 1);
      assert.match(h.messages.at(-1).message, new RegExp('HTTP ' + status));
      assert.equal(h.flow.jobs.size, 0);
    }
  });
}

test('a malformed successful API reply is reported instead of looking like an empty list', async () => {
  const h = harness({ pages: [{ ok: true, status: 200, data: {} }] });
  await h.flow.distributePkg('p');
  assert.equal(h.calls.length, 0);
  assert.match(h.messages.at(-1).message, /Invalid server list/);
});

test('a later-page error aborts selection rather than launching from a partial unvalidated response', async () => {
  const h = harness({ pages: [response([server('s1')], 'next'), { ok: false, status: 429 }] });
  await h.flow.distributePkg('p');
  assert.equal(h.calls.length, 0);
  assert.equal(h.urls.length, 2);
});

test('a launch rate limit stops the batch without trying the remaining accounts', async () => {
  const h = harness({ launch: async () => ({ success: false, error: 'Authentication stopped (HTTP 429)' }) });
  await h.flow.distributePkg('p');
  assert.equal(h.calls.length, 1);
  assert.equal(h.flow.jobs.size, 0);
});

test('concurrent clicks cannot launch the same group twice while metadata is pending', async () => {
  let finish;
  const h = harness({ pages: [() => new Promise(resolve => { finish = resolve; })] });
  const first = h.flow.distributePkg('p');
  await h.flow.distributePkg('p');
  await h.flow.launchPackage('p');
  assert.equal(h.urls.length, 1);
  finish(response([server('s1'), server('s2'), server('s3')]));
  await first;
  assert.equal(h.calls.length, 3);
});

test('a pending individual modal launch blocks a batch using the same account', async () => {
  let finish;
  const h = harness({ members: 1, launch: () => new Promise(resolve => { finish = resolve; }) });
  h.context.launchAcc = h.accounts[0];
  h.context.document.getElementById = id => id === 'btn-launch' ? { disabled: false, innerHTML: '' } : null;
  const individual = h.flow.doLaunch();
  await h.flow.distributePkg('p');
  assert.equal(h.calls.length, 1);
  assert.equal(h.urls.length, 0);
  assert.match(h.messages.at(-1).message, /pkg.launchBusy/);
  finish({ success: false, error: 'Test launch stopped' });
  await individual;
});

test('a pending batch launch blocks the individual modal for the same account', async () => {
  let finish;
  const h = harness({ members: 1, launch: () => new Promise(resolve => { finish = resolve; }) });
  const batch = h.flow.distributePkg('p');
  await new Promise(resolve => setImmediate(resolve));
  h.context.launchAcc = h.accounts[0];
  await h.flow.doLaunch();
  assert.equal(h.calls.length, 1);
  assert.match(h.messages.at(-1).message, /pkg.launchBusy/);
  finish({ success: true });
  await batch;
});

test('cancellation while searching prevents every pending account launch', async () => {
  let finish;
  const h = harness({ pages: [() => new Promise(resolve => { finish = resolve; })] });
  const running = h.flow.distributePkg('p');
  await h.flow.cancelPackageLaunch('p');
  finish(response([server('s1'), server('s2'), server('s3')]));
  await running;
  assert.equal(h.calls.length, 0);
  assert.equal(h.flow.jobs.size, 0);
});

test('cancelling an in-flight launch invokes backend cancellation and starts no next account', async () => {
  let finish;
  const h = harness({ launch: () => new Promise(resolve => { finish = resolve; }) });
  const running = h.flow.distributePkg('p');
  await new Promise(resolve => setImmediate(resolve));
  await h.flow.cancelPackageLaunch('p');
  assert.deepEqual(h.cancelled, ['a0']);
  finish({ success: false, cancelled: true });
  await running;
  assert.equal(h.calls.length, 1);
});

test('cancelling the delay between accounts wakes the batch without another launch', async () => {
  const h = harness();
  h.packages[0].launchDelay = 1000;
  const running = h.flow.distributePkg('p');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  await h.flow.cancelPackageLaunch('p');
  await running;
  assert.equal(h.calls.length, 1);
  assert.equal(h.flow.jobs.size, 0);
});

test('parallel groups reserve different destinations while their launches are in flight', async () => {
  const resolvers = [];
  const h = harness({ members: 2, launch: () => new Promise(resolve => resolvers.push(resolve)) });
  h.packages[0].accountIds = ['a0'];
  h.packages.push({ ...h.packages[0], id: 'p2', accountIds: ['a1'] });
  const first = h.flow.distributePkg('p');
  await new Promise(resolve => setImmediate(resolve));
  const second = h.flow.distributePkg('p2');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.map(c => c.target), ['12345:s1', '12345:s2']);
  resolvers.forEach(resolve => resolve({ success: true }));
  await Promise.all([first, second]);
  assert.equal(h.flow.reservations.size, 0);
});

test('normal group launch selects one common destination with space for the whole group', async () => {
  const h = harness({ pages: [response([server('too-small', 8), server('room-for-all', 7)])] });
  await h.flow.launchPackage('p');
  assert.deepEqual(h.calls.map(c => c.target), ['12345:room-for-all', '12345:room-for-all', '12345:room-for-all']);
});

test('normal group launch preserves public URLs, private links, and explicit server targets', async () => {
  const publicUrl = harness({ link: 'https://www.roblox.com/games/12345/Example' });
  await publicUrl.flow.launchPackage('p');
  assert.equal(publicUrl.urls.length, 1);
  assert.equal(new Set(publicUrl.calls.map(c => c.target)).size, 1);
  for (const link of ['12345:specific-job', 'https://www.roblox.com/games/12345?privateServerLinkCode=abc', 'https://www.roblox.com/share?code=abc&type=Server']) {
    const h = harness({ link });
    await h.flow.launchPackage('p');
    assert.equal(h.urls.length, 0);
    assert.ok(h.calls.every(c => c.target === link));
  }
});

test('an explicit group server checks capacity for all members and uses one bounded sample', async () => {
  const h = harness({ rawServers: [server('s1', 8)] });
  await h.flow.launchPkgToServer('s1');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.validations, [['12345', 1, true, true]]);
  assert.match(h.messages.at(-1).message, /srv.fullNow/);
});

test('absence from a bounded server sample does not falsely declare an explicit destination dead', async () => {
  const h = harness({ rawServers: [server('other')] });
  await h.flow.launchPkgToServer('explicit-server');
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(c => c.target === '12345:explicit-server'));
  assert.equal(h.validations.length, 1);
});

test('individual server entry opens the confirmation for its explicit target without launching early', async () => {
  const h = harness();
  h.context._srvCtx = { accountId: 'a0', placeId: '12345' };
  await h.flow.launchToServer('specific-job');
  assert.deepEqual(h.opened, ['a0']);
  assert.equal(h.accounts[0]._srvTarget, '12345:specific-job');
  assert.equal(h.calls.length, 0);
});

test('a pasted individual destination retains the supplied place ID', async () => {
  const h = harness();
  h.context._srvCtx = { accountId: 'a0', placeId: '12345' };
  await h.flow.launchToServer('pasted-job', '67890');
  assert.equal(h.accounts[0]._srvTarget, '67890:pasted-job');
  assert.equal(h.validations[0][0], '67890');
});

test('an individual API error is shown and does not open confirmation or mark the session expired', async () => {
  const h = harness();
  h.context._srvCtx = { accountId: 'a0', placeId: '12345' };
  h.context._srvFetchRaw = async () => { throw new Error('Server list request failed (HTTP 429)'); };
  await h.flow.launchToServer('specific-job');
  assert.deepEqual(h.opened, []);
  assert.equal(h.calls.length, 0);
  assert.match(h.messages.at(-1).message, /HTTP 429/);
});

test('switching pickers while an individual check is pending does not launch into the new context', async () => {
  let finish;
  const h = harness();
  h.context._srvCtx = { accountId: 'a0', placeId: '12345' };
  h.context._srvFetchRaw = () => new Promise(resolve => { finish = resolve; });
  const first = h.flow.launchToServer('s1');
  await h.flow.launchToServer('s1');
  h.context._srvCtx = { accountId: 'a1', placeId: '67890' };
  finish({ servers: [] });
  await first;
  assert.equal(h.opened.length, 0);
  assert.equal(h.accounts[0]._srvTarget, undefined);
});

test('random group entry uses one distinct shared target with room for every member', async () => {
  const h = harness({ pages: [response([server('full-for-group', 8), server('fits-group', 6)])] });
  await h.flow.joinRandomServer();
  assert.deepEqual(h.calls.map(c => c.target), ['12345:fits-group', '12345:fits-group', '12345:fits-group']);
});

test('random entry reports a rate limit immediately without a retry loop or generic join', async () => {
  const h = harness({ pages: [{ ok: false, status: 429 }] });
  await h.flow.joinRandomServer();
  assert.equal(h.urls.length, 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.messages.at(-1).message, /HTTP 429/);
});

test('package membership deduplicates saved order and includes newly selected accounts', () => {
  const h = harness();
  h.packages[0].launchOrder = ['a1', 'a1', 'removed-account'];
  assert.deepEqual([...h.flow.pkgMembers(h.packages[0])].map(a => a.id), ['a1', 'a0', 'a2']);
});

test('relaunching downed group members is sequential and honors the group link even without account targets', async () => {
  const h = harness();
  h.accounts.forEach(a => h.context._sessionLaunched.add(a.id));
  let concurrent = 0, max = 0;
  h.context.api.launchRoblox = async (id, cookie, target) => {
    concurrent++; max = Math.max(max, concurrent); h.calls.push({ id, target });
    await new Promise(resolve => setImmediate(resolve)); concurrent--;
    return { success: true };
  };
  await h.flow.relaunchDownedPackage('p');
  assert.equal(max, 1);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(c => c.target === '12345'));
});
