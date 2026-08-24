// ════════════════════════════════════════════════════════════════════════
// KNT Manager Web — local relay server (zero dependencies, Node ≥ 18)
//
// Serves the web/ site and unlocks the features a static page cannot reach:
//   • Roblox APIs (charts, thumbnails, users, game names) are CORS-blocked
//     from the browser → GET /proxy?url=... forwards them with CORS headers
//   • Cookie validation needs an HTTP header a browser cannot set →
//     POST /api/validate-cookie
//   • Altgen / follow-user also need server-side requests
//
//   node web/server.mjs          → http://localhost:4173
//   node web/server.mjs 8080     → custom port
// ════════════════════════════════════════════════════════════════════════
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const ALLOWED_PROXY_HOSTS = [
  'roblox.com', 'rbxcdn.com', 'altgen.me', 'discord.com', 'core.bloxgen.net',
];
const UA = 'Mozilla/5.0 (KNT-Manager-Web/1.0)';
const ok = (res, body, type = 'application/json; charset=utf-8', status = 200) => {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function hostAllowed(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return ALLOWED_PROXY_HOSTS.some(a => h === a || h.endsWith('.' + a));
  } catch { return false; }
}

async function proxy(req, res, url) {
  if (!hostAllowed(url)) return ok(res, JSON.stringify({ error: 'host not allowed' }), undefined, 403);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(12000) });
    const ct = r.headers.get('content-type') || 'application/json';
    const body = await r.arrayBuffer();
    res.writeHead(r.status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
    res.end(Buffer.from(body));
  } catch (e) {
    ok(res, JSON.stringify({ error: String(e && e.message || e) }), undefined, 502);
  }
}

// POST /api/validate-cookie — body is the raw .ROBLOSECURITY cookie
async function validateCookie(req, res) {
  const cookie = (await readBody(req)).trim();
  if (!cookie) return ok(res, JSON.stringify({ ok: false, reason: 'empty cookie' }));
  try {
    const r = await fetch('https://users.roblox.com/v1/users/authenticated', {
      headers: { 'Cookie': '.ROBLOSECURITY=' + cookie, 'User-Agent': UA },
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 200) {
      const j = await r.json();
      return ok(res, JSON.stringify({ ok: true, username: j.name, userId: j.id }));
    }
    let reason = 'HTTP ' + r.status;
    if (r.status === 401 || r.status === 403) reason = 'Cookie is expired or invalid';
    return ok(res, JSON.stringify({ ok: false, reason }));
  } catch (e) {
    ok(res, JSON.stringify({ ok: false, reason: String(e && e.message || e) }));
  }
}

// POST /api/altgen — { apiKey, quantity } → api.altgen.me (same shape as the Rust backend)
async function altgen(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const quantity = Math.max(1, Math.min(100, Number(body.quantity) || 1));
  try {
    const r = await fetch('https://api.altgen.me/api/v1/generate', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (body.apiKey || ''),
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ type: 'ROBLOX_NORMAL', quantity }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    ok(res, JSON.stringify({ status: r.status, data }));
  } catch (e) {
    ok(res, JSON.stringify({ status: 0, data: { success: false, error: { message: String(e && e.message || e) } } }));
  }
}

async function csrfToken(cookie) {
  const r = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST',
    headers: { 'Cookie': '.ROBLOSECURITY=' + cookie, 'User-Agent': UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  });
  return r.headers.get('x-csrf-token') || '';
}

// POST /api/follow-user — { cookie, username } → "placeId:gameId" target
async function followUser(req, res) {
  const { cookie, username } = JSON.parse((await readBody(req)) || '{}');
  const name = String(username || '').trim().replace(/^@/, '');
  if (!name) return ok(res, JSON.stringify({ ok: false, error: 'Enter a username' }));
  if (!cookie) return ok(res, JSON.stringify({ ok: false, error: 'No cookie on this account' }));
  try {
    const lu = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(8000),
    });
    const luData = await lu.json();
    const user = luData.data && luData.data[0];
    if (!user) return ok(res, JSON.stringify({ ok: false, error: 'No Roblox user named "' + name + '"' }));
    const csrf = await csrfToken(cookie);
    const pr = await fetch('https://presence.roblox.com/v1/presence/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(cookie ? { 'Cookie': '.ROBLOSECURITY=' + cookie } : {}),
      },
      body: JSON.stringify({ userIds: [user.id] }),
      signal: AbortSignal.timeout(8000),
    });
    const prData = await pr.json();
    const presence = prData.userPresences && prData.userPresences[0];
    if (!presence || !presence.placeId) {
      return ok(res, JSON.stringify({ ok: false, error: 'That user is not in a joinable server right now (privacy or offline).' }));
    }
    const target = presence.gameId ? presence.placeId + ':' + presence.gameId : String(presence.placeId);
    ok(res, JSON.stringify({ ok: true, username: name, userId: user.id, target }));
  } catch (e) {
    ok(res, JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
}

// GET /api/game-name?target=... — resolves a game id / link to its display name
async function gameName(req, res, url) {
  const target = new URL('http://internal' + url).searchParams.get('target') || '';
  let placeId = null;
  const m = target.match(/\d{6,}/);
  if (m) placeId = m[0];
  if (!placeId) return ok(res, JSON.stringify({ name: '' }));
  try {
    const univ = await fetch('https://apis.roblox.com/universes/v1/places/' + placeId + '/universe', {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
    });
    if (univ.ok) {
      const uj = await univ.json();
      const det = await fetch('https://games.roblox.com/v1/games?universeIds=' + uj.universeId, {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
      });
      if (det.ok) {
        const dj = await det.json();
        const g = dj.data && dj.data[0];
        if (g && g.name) return ok(res, JSON.stringify({ name: g.name, universeId: uj.universeId }));
      }
    }
  } catch {}
  ok(res, JSON.stringify({ name: '' }));
}

// GET /api/roblox-version
async function robloxVersion(res) {
  try {
    const r = await fetch('https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer', {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
    });
    if (r.ok) { const j = await r.json(); return ok(res, JSON.stringify({ version: j.version || 'web' })); }
  } catch {}
  ok(res, JSON.stringify({ version: 'web' }));
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) return ok(res, 'forbidden', 'text/plain', 403);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    ok(res, '404 — not found (did you run the build? try `node web/build-web.mjs`)', 'text/plain', 404);
  }
}

createServer((req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];
  try {
    if (pathname === '/proxy') return proxy(req, res, new URL('http://internal' + url).searchParams.get('url') || '');
    if (pathname === '/api/validate-cookie' && req.method === 'POST') return validateCookie(req, res);
    if (pathname === '/api/altgen' && req.method === 'POST') return altgen(req, res);
    if (pathname === '/api/follow-user' && req.method === 'POST') return followUser(req, res);
    if (pathname === '/api/game-name') return gameName(req, res, url);
    if (pathname === '/api/roblox-version') return robloxVersion(res);
    return serveStatic(req, res, pathname);
  } catch (e) {
    ok(res, JSON.stringify({ error: String(e && e.message || e) }), undefined, 500);
  }
}).listen(PORT, () => {
  console.log('KNT Manager Web — http://localhost:' + PORT);
  console.log('  open the site, or open web/index.html directly for offline demo mode');
});
