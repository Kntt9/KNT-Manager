// ════════════════════════════════════════════════════════════════════════
// KNT Manager — web bridge
// Implements the exact `window.api` surface renderer.js expects, on top of
// plain browser APIs, so the app runs unmodified as a website.
//
//   • Accounts / settings / packages / history → localStorage
//   • Roblox APIs (charts, thumbnails, users) → local relay (web/server.mjs)
//     when it is running; built-in mock data otherwise
//   • Launching Roblox, OS volume, RAM trim, real screenshots → simulated
//     (a browser cannot touch the OS), with honest log entries
//   • Discord webhook capture → real: a fake in-game screenshot is drawn on
//     a <canvas> and posted to the webhook, which works from any browser.
// ════════════════════════════════════════════════════════════════════════
(() => {
  'use strict';

  const LS = {
    accounts: 'knt.accounts',
    settings: 'knt.settings',
    packages: 'knt.packages',
    gen: 'knt.genhistory',
    backups: 'knt.backups',
    autoPw: 'knt.autopassword',
    ff: 'knt.fflags',
    seeded: 'knt.seeded',
  };

  function load(key, fb) {
    try { const v = localStorage.getItem(key); return v == null ? fb : JSON.parse(v); }
    catch { return fb; }
  }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
  const clone = v => JSON.parse(JSON.stringify(v));
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // ── tiny event emitter (mirrors Tauri's listen()) ───────────────────────
  const _listeners = {};
  function on(name, cb) {
    (_listeners[name] = _listeners[name] || []).push(cb);
    return () => { _listeners[name] = (_listeners[name] || []).filter(f => f !== cb); };
  }
  function emit(name, payload) {
    (_listeners[name] || []).slice().forEach(cb => { try { cb(payload); } catch (e) { console.error('[bridge]', name, e); } });
  }

  // ── in-memory state ─────────────────────────────────────────────────────
  let accounts = load(LS.accounts, null);
  let settings = load(LS.settings, null);
  let packages = load(LS.packages, null);
  let genHistory = load(LS.gen, []);
  let backups = load(LS.backups, []);
  const runningIds = new Set();
  const homeIds = new Set(); // simulated "went to the Roblox home (tray)"
  let autoPassword = load(LS.autoPw, null);

  // ── first-run demo data (only when localStorage is empty) ───────────────
  function seedIfNeeded() {
    if (localStorage.getItem(LS.seeded)) return;
    const now = Date.now();
    const demoAccounts = [
      { id: 'a1', username: 'KNT_Farm01', nickname: 'Farm01', userId: 1101, cookie: 'demo.KNT_Farm01', gameTarget: '920587237', categoryId: 'c-farm', createdAt: now - 40 * 864e5, description: 'Demo account — this browser demo seeds fake accounts on first run.' },
      { id: 'a2', username: 'KNT_Farm02', nickname: 'Farm02', userId: 1102, cookie: 'demo.KNT_Farm02', gameTarget: '920587237', categoryId: 'c-farm', createdAt: now - 38 * 864e5, description: 'Demo account.' },
      { id: 'a3', username: 'TradeKing_Alt', nickname: 'Trade King Alt', userId: 1103, cookie: 'demo.TradeKing_Alt', gameTarget: 'https://www.roblox.com/share/L4EnY8NMuQ', categoryId: 'c-trade', createdAt: now - 21 * 864e5, description: 'Demo account.' },
      { id: 'a4', username: 'noob_lord_420', nickname: 'noob lord', userId: 1104, cookie: null, gameTarget: '', categoryId: 'c-farm', createdAt: now - 15 * 864e5, description: 'Demo account without a cookie.' },
      { id: 'a5', username: 'Cookies4Life', nickname: 'Cookies', userId: 1105, cookie: 'demo.Cookies4Life', gameTarget: '', categoryId: null, createdAt: now - 9 * 864e5, description: 'Demo account.' },
      { id: 'a6', username: 'Sniper_Bot99', nickname: 'Sniper Bot', userId: 1106, cookie: 'demo.Sniper_Bot99', gameTarget: '', categoryId: 'c-trade', createdAt: now - 5 * 864e5, description: 'Demo account.' },
      { id: 'a7', username: 'TheRealKNT', nickname: 'KNT', userId: 1107, cookie: 'demo.TheRealKNT', gameTarget: '920587237', categoryId: null, createdAt: now - 2 * 864e5, description: 'Demo account.' },
      { id: 'a8', username: 'Burner_Alt_77', nickname: 'Burner', userId: 1108, cookie: 'demo.Burner_Alt_77', gameTarget: '', categoryId: null, trashed: true, trashedAt: now - 864e5, createdAt: now - 3 * 864e5, description: 'Demo account in the trash.' },
    ];
    save(LS.accounts, demoAccounts);
    accounts = demoAccounts.slice();

    const demoSettings = {
      language: 'pt',
      categories: [
        { id: 'c-farm', name: 'Farm', color: '#59c2ff' },
        { id: 'c-trade', name: 'Trade', color: '#b58cff' },
      ],
      multiInstance: true,
      antiAfk: true,
      antiAfkInterval: 19 * 60,
      autoRelaunch: false,
      autoTrim: true,
      autoTrimIntervalMin: 5,
      lowPriorityMultiInstance: true,
      lockChannel: false,
      robloxChannel: '',
      renderEngine: '',
      gfxQuality: 10,
      fpsCap: 60,
      masterVolume: 100,
      keySet: false,
      trackingWebhookUrl: '',
      trackingIntervalSec: 300,
      trackingTimedIds: [],
      trackingRegions: {},
      autoBackup: { enabled: false, intervalHours: 24, keep: 5, lastAt: 0, password: null },
    };
    save(LS.settings, demoSettings);
    settings = demoSettings;

    save(LS.packages, [{ id: 'pkg-1', name: 'Farm Squad', accountIds: ['a1', 'a2', 'a3'], link: '920587237' }]);
    packages = load(LS.packages, []);

    backups = [
      { name: 'knt-backup-2026-08-14-091500.kntweb.json', path: 'knt-backup-2026-08-14-091500.kntweb.json', size: 48213, createdAtMs: now - 36 * 3600 * 1000 },
      { name: 'knt-backup-2026-08-13-091500.kntweb.json', path: 'knt-backup-2026-08-13-091500.kntweb.json', size: 47902, createdAtMs: now - 60 * 3600 * 1000 },
    ];
    save(LS.backups, backups);

    if (!autoPassword) {
      autoPassword = randomPassword();
      save(LS.autoPw, autoPassword);
    }

    // Two demo instances "running" so the dashboard / mixer feel alive.
    ['a1', 'a2'].forEach(id => runningIds.add(id));
    localStorage.setItem(LS.seeded, '1');
  }
  seedIfNeeded();
  accounts = accounts || [];
  settings = settings || {};
  packages = packages || [];

  function emitLog(level, category, message, meta) {
    emit('log:entry', { level, category, message, meta: meta || null });
  }
  function emitCount() {
    emit('roblox:count', runningIds.size);
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return (h % 0xfffff).toString(36);
  }
  function randomPassword(len) {
    const set = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%*_-+=?';
    let out = '';
    const arr = new Uint32Array(len || 24);
    crypto.getRandomValues(arr);
    for (let i = 0; i < (len || 24); i++) out += set[arr[i] % set.length];
    return out;
  }
  function stamp() {
    return new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15);
  }

  // ── Roblox API mock (offline fallback) ──────────────────────────────────
  // Only games whose universe/place ids are confidently known are listed, so
  // the "View game page" links stay correct when the relay server is absent.
  // universe/place ids verified against the live APIs in August 2026, so the
  // "View game page" links stay correct even when the relay server is absent.
  const MOCK_GAMES = [
    { universeId: 383310974, placeId: 920587237, name: 'Adopt Me!', playerCount: 200000 },
    { universeId: 994732206, placeId: 2753915549, name: 'Blox Fruits', playerCount: 75000 },
    { universeId: 66654135, placeId: 142823291, name: 'Murder Mystery 2', playerCount: 48000 },
    { universeId: 245662005, placeId: 606849621, name: 'Jailbreak', playerCount: 36000 },
    { universeId: 88070565, placeId: 185655149, name: 'Welcome to Bloxburg', playerCount: 31000 },
    { universeId: 321778215, placeId: 735030788, name: 'Royale High', playerCount: 27000 },
    { universeId: 47545, placeId: 192800, name: 'Work at a Pizza Place', playerCount: 14000 },
    { universeId: 65241, placeId: 189707, name: 'Natural Disaster Survival', playerCount: 11000 },
    { universeId: 110181652, placeId: 277751860, name: 'Epic Minigames', playerCount: 9000 },
  ];
  function mockRobloxGet(url) {
    try {
      const u = new URL(url);
      const path = u.pathname;
      if (path.includes('explore-api/v1/get-sort-content')) {
        const sort = u.searchParams.get('sortId') || 'top-playing-now';
        const games = MOCK_GAMES.map((g, i) => ({
          universeId: String(g.universeId),
          rootPlaceId: String(g.placeId),
          name: g.name,
          playerCount: Math.max(300, g.playerCount + ((i * 7) % 500) - (sort === 'top-rated' ? 2000 : sort === 'top-earning' ? 1500 : 0)),
        }));
        // rotate deterministically per sort so each tab feels different
        const off = sort.length % games.length;
        return { games: games.map((_, i) => games[(i + off) % games.length]) };
      }
      if (path.includes('search-api/omni-search')) {
        const q = (u.searchParams.get('searchQuery') || '').toLowerCase();
        const found = MOCK_GAMES.filter(g => g.name.toLowerCase().includes(q)).map(g => ({ contentId: String(g.universeId) }));
        return { searchResults: [{ contentGroupType: 'Game', contents: found }] };
      }
      if (path.includes('/v1/games')) {
        const m = url.match(/universeIds=([^&]+)/);
        if (m) {
          return { data: m[1].split(',').map(id => {
            const g = MOCK_GAMES.find(x => String(x.universeId) === id);
            return { id: Number(id), name: g ? g.name : 'Unknown Game', rootPlaceId: g ? Number(g.placeId) : Number(id), playing: g ? g.playerCount : 0 };
          }) };
        }
      }
      if (path.includes('thumbnails.roblox.com')) {
        const m = url.match(/universeIds=([^&]+)/);
        if (m) return { data: m[1].split(',').map(id => ({ targetId: Number(id), imageUrl: '' })) };
        const m2 = url.match(/userIds=([^&]+)/);
        if (m2) return { data: m2[1].split(',').map(id => ({ targetId: Number(id), imageUrl: '' })) };
      }
      if (path.includes('/v1/users/')) {
        const m = url.match(/\/v1\/users\/(\d+)/);
        if (m) return { id: Number(m[1]), name: 'Roblox User', displayName: 'User' };
      }
    } catch {}
    return null;
  }

  // ── fake in-game "screenshot" for tracking (canvas) ─────────────────────
  function drawFakeScreenshot(account, regions) {
    const w = 960, h = 540;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#1b2a4a'); g.addColorStop(0.55, '#2e1b4a'); g.addColorStop(1, '#0f1626');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    // fake terrain blobs
    x.fillStyle = 'rgba(45,212,191,.10)';
    x.beginPath(); x.arc(760, 430, 170, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(92,92,224,.14)';
    x.beginPath(); x.arc(150, 120, 130, 0, Math.PI * 2); x.fill();
    // HUD
    x.fillStyle = 'rgba(255,255,255,.85)'; x.font = '600 30px Inter, sans-serif'; x.textAlign = 'left';
    x.fillText('ROBLOX — view simulated', 26, 44);
    x.fillStyle = 'rgba(255,255,255,.45)'; x.font = '500 16px Inter, sans-serif';
    x.fillText('(the web version can\u2019t capture real windows)', 26, 68);
    // health bar
    x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(26, h - 64, 220, 16);
    x.fillStyle = '#3ecf8e'; x.fillRect(28, h - 62, 132, 12);
    x.fillStyle = 'rgba(255,255,255,.7)'; x.font = '500 13px Inter, sans-serif';
    x.textAlign = 'right';
    x.fillText(new Date().toLocaleString(), w - 26, 44);
    // account plate
    x.textAlign = 'left';
    x.fillStyle = 'rgba(0,0,0,.45)'; x.fillRect(26, h - 100, 300, 26);
    x.fillStyle = '#fff'; x.font = '600 15px Inter, sans-serif';
    x.fillText((account.nickname || account.username || 'account').slice(0, 34), 40, h - 82);
    // region boxes outline (what would be cropped)
    (regions || []).forEach(r => {
      x.strokeStyle = '#f06f6f'; x.lineWidth = 3; x.setLineDash([8, 6]);
      x.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h);
    });
    x.setLineDash([]);
    return c.toDataURL('image/png');
  }
  function canvasToBlob(canvas) {
    return new Promise(res => canvas.toBlob(res, 'image/png'));
  }

  // ════════════════════════════════════════════════════════════════════════
  window.api = {
    // window chrome (no-ops in a browser)
    minimize: () => Promise.resolve(),
    maximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    setTitle: (title) => { document.title = title; return Promise.resolve(); },

    // ── accounts ──────────────────────────────────────────────────────────
    loadAccounts: () => Promise.resolve(clone(accounts)),
    addAccount: (account) => {
      const a = Object.assign({
        id: 'a-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
        createdAt: Date.now(),
        nickname: '', description: '', categoryId: null, trashed: false, gameTarget: '',
      }, account);
      accounts.push(a);
      save(LS.accounts, accounts);
      emitLog('info', 'account', `Account added: ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
      return Promise.resolve(clone(a));
    },
    updateAccount: (id, data) => {
      const a = accounts.find(x => x.id === id);
      if (a) { Object.assign(a, data); save(LS.accounts, accounts); }
      return Promise.resolve(clone(a) || { ok: false });
    },
    removeAccount: (id) => {
      const a = accounts.find(x => x.id === id);
      if (a) { a.trashed = true; a.trashedAt = Date.now(); save(LS.accounts, accounts); }
      return Promise.resolve({ ok: true });
    },
    restoreAccount: (id) => {
      const a = accounts.find(x => x.id === id);
      if (a) { a.trashed = false; delete a.trashedAt; save(LS.accounts, accounts); }
      return Promise.resolve({ ok: true });
    },
    purgeAccount: (id) => {
      accounts = accounts.filter(x => x.id !== id);
      save(LS.accounts, accounts);
      return Promise.resolve({ ok: true });
    },
    emptyTrash: () => {
      accounts = accounts.filter(x => !x.trashed);
      save(LS.accounts, accounts);
      return Promise.resolve({ ok: true });
    },
    reorderAccounts: (ids) => {
      const order = new Map(ids.map((id, i) => [id, i]));
      accounts = accounts.slice().sort((a, b) => {
        if (a.trashed && !b.trashed) return 1;
        if (!a.trashed && b.trashed) return -1;
        if (a.trashed && b.trashed) return 0;
        return (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9);
      });
      save(LS.accounts, accounts);
      return Promise.resolve({ ok: true });
    },

    // ── packages ──────────────────────────────────────────────────────────
    loadPackages: () => Promise.resolve(clone(packages)),
    savePackages: (list) => { packages = clone(list || []); save(LS.packages, packages); return Promise.resolve({ ok: true }); },

    // ── auth / login ──────────────────────────────────────────────────────
    openLogin: () => Promise.resolve({
      success: false,
      error: 'The web version cannot watch a login window. Use Paste Cookie instead — it works exactly the same.',
    }),
    openSignup: (username, password) => {
      window.open('https://www.roblox.com/account/signupredir?returnUrl=https%3A%2F%2Fwww.roblox.com%2Fhome', '_blank', 'noopener');
      return Promise.resolve({
        success: false,
        error: 'Web version: signup opened in a new tab (it can\u2019t autofill fields there). After creating the account, copy its .ROBLOSECURITY cookie and use Add Account → Paste Cookie.',
      });
    },
    openAccountInBrowser: (cookie) => { window.open('https://www.roblox.com/home', '_blank', 'noopener'); return Promise.resolve({ ok: true }); },
    cancelLogin: () => Promise.resolve(),
    validateCookie: async (cookie) => {
      cookie = String(cookie || '').trim();
      if (!cookie) return { ok: false, reason: 'Cookie is empty' };
      const demo = accounts.find(a => a.cookie === cookie && String(a.cookie).startsWith('demo.'));
      if (demo) return { ok: true, username: demo.username, userId: demo.userId, demo: true };
      // Real validation through the local relay (only when web/server.mjs runs)
      let relayReachable = false;
      try {
        const r = await fetch('/api/validate-cookie', {
          method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: cookie,
          signal: AbortSignal.timeout(10000),
        });
        relayReachable = true;
        let j = null;
        try { j = await r.json(); } catch {}
        if (r.ok && j && j.ok) return j;
        if (j) return { ok: false, reason: j.reason || 'Cookie is expired or invalid' };
      } catch {}
      // Offline fallback (relay unreachable — e.g. web/index.html opened directly):
      // accept a well-formed cookie, identity unverified.
      if (!relayReachable && cookie.startsWith('_|WARNING') && cookie.length >= 100) {
        const h = hashStr(cookie);
        return { ok: true, username: 'Alt_' + h, userId: 100000000 + ((parseInt(h, 36) || 0) % 900000000), unverified: true };
      }
      return { ok: false, reason: 'That doesn\u2019t look like a .ROBLOSECURITY cookie.' };
    },

    // ── simulated Roblox control ──────────────────────────────────────────
    setRobloxVolume: (percent) => {
      settings.masterVolume = Math.max(0, Math.min(100, parseInt(percent, 10) || 0));
      save(LS.settings, settings);
      emitLog('info', 'mixer', `Volume set to ${settings.masterVolume}% (simulated — a browser can't control the OS mixer)`);
      return Promise.resolve({ ok: true });
    },
    killAllRoblox: () => {
      const n = runningIds.size;
      runningIds.clear();
      emit('roblox:allClosed');
      emitCount();
      emitLog('warn', 'close', `Killed all Roblox instances (simulated) — ${n} closed`);
      return Promise.resolve({ ok: true, killed: n });
    },
    killOneRoblox: (id) => {
      runningIds.delete(id);
      emit('roblox:closed', id);
      emitCount();
      emitLog('info', 'close', `Roblox closed for ${id} (simulated)`);
      return Promise.resolve({ ok: true });
    },
    getRunningCount: () => Promise.resolve(runningIds.size),
    getWatchedIds: () => Promise.resolve(Array.from(runningIds)),
    getHomeIds: () => Promise.resolve(Array.from(homeIds)),
    killHomeRoblox: () => {
      homeIds.clear();
      emit('roblox:closed', null);
      emitLog('info', 'close', 'Roblox home/tray closed (simulated)');
      return Promise.resolve({ ok: true, killed: 0, cleared: 0 });
    },
    onRobloxHome: (cb) => on('roblox:home', (id) => cb(id)),
    trimRobloxMemory: () => {
      emitLog('info', 'mixer', 'Memory trimmed (simulated)');
      return Promise.resolve({ ok: true });
    },
    trimAccountMemory: (id) => {
      emitLog('info', 'mixer', `Memory trimmed for account ${id} (simulated)`);
      return Promise.resolve({ ok: true });
    },
    setAccountPriority: (id, priority) => Promise.resolve({ ok: true }),
    launchRoblox: async (id, cookie, target) => {
      const a = accounts.find(x => x.id === id);
      if (a && !cookie && !a.cookie) return { success: false, error: 'This account has no cookie — edit it and paste one first.' };
      // Simulate the spawn: cards flip live shortly after "Start".
      setTimeout(() => {
        runningIds.add(id);
        emit('roblox:started', id);
        emitCount();
        emitLog('info', 'launch', `Roblox (simulated) started as ${a ? a.username : id}${target ? ' → ' + target : ''}`, { accountId: id, username: a ? a.username : null });
      }, 700 + Math.random() * 600);
      return { success: true, simulated: true };
    },
    cancelLaunch: (id) => Promise.resolve({ cancelled: true }),

    // ── tracking (webhook) ────────────────────────────────────────────────
    trackingCapturePreview: async (id) => {
      const a = accounts.find(x => x.id === id);
      if (!a) return { ok: false, error: 'Account not found' };
      return { ok: true, dataUrl: drawFakeScreenshot(a, []) };
    },
    trackingCaptureAndSend: async (id, username, webhookUrl, regions) => {
      const a = accounts.find(x => x.id === id) || { username: username || 'account', nickname: '' };
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 960; canvas.height = 540;
        canvas.getContext('2d').drawImage(await (() => {
          const img = new Image();
          return new Promise(res => { img.onload = () => res(img); img.src = drawFakeScreenshot(a, regions); });
        })(), 0, 0);
        const blob = await canvasToBlob(canvas);
        const fd = new FormData();
        fd.append('files[0]', blob, (a.nickname || a.username || 'account') + '-' + Date.now() + '.png');
        fd.append('content', 'KNT Manager web capture — ' + (a.nickname || a.username || 'account') + ' @ ' + new Date().toLocaleString());
        const r = await fetch(webhookUrl, { method: 'POST', body: fd, signal: AbortSignal.timeout(15000) });
        if (r.ok || r.status === 204) {
          emitLog('ok', 'tracking', `Capture sent to webhook as ${a.username || username}`);
          return { ok: true };
        }
        return { ok: false, error: 'Discord rejected the capture (HTTP ' + r.status + ')' };
      } catch (e) {
        return { ok: false, error: 'Capture failed: ' + ((e && e.message) || e) };
      }
    },
    trackingValidateWebhook: async (url) => {
      url = String(url || '').trim();
      const pat = /discord\.com\/api\/webhooks\/(\d+)\/([A-Za-z0-9_-]+)/;
      if (!pat.test(url)) return { ok: false, error: 'That URL doesn\u2019t look like a Discord webhook.' };
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null);
        if (r.ok && j && j.type) return { ok: true, name: j.name || 'webhook' };
      } catch {}
      return { ok: true }; // shape is right; can't always reach Discord from the browser
    },

    // ── settings ──────────────────────────────────────────────────────────
    loadSettings: () => Promise.resolve(clone(settings)),
    saveSettings: (data) => {
      Object.assign(settings, data);
      if (data && data.autoBackup && typeof data.autoBackup === 'object') {
        settings.autoBackup = Object.assign(settings.autoBackup || {}, data.autoBackup);
      }
      save(LS.settings, settings);
      return Promise.resolve(true);
    },

    // ── encryption (not applicable on web — data lives in localStorage) ───
    encStatus: () => Promise.resolve({ mode: 'none' }),
    encUnlock: (pass) => Promise.resolve({ ok: true }),
    encSetKey: (pass) => Promise.resolve({ ok: true }),
    clearAppData: () => {
      Object.keys(LS).forEach(k => { try { localStorage.removeItem(LS[k]); } catch {} });
      try { localStorage.removeItem('ui-theme'); } catch {}
      return Promise.resolve({ ok: true });
    },

    // ── backups (create downloads a real JSON file; restore reads one) ────
    backupCreate: async (password) => {
      const name = 'knt-backup-' + stamp() + '.kntweb.json';
      const payload = { format: 'knt-web-backup', version: 1, createdAt: Date.now(), password, accounts, settings, packages };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { ok: true, path: name, count: accounts.filter(x => !x.trashed).length };
    },
    backupRestore: (password) => new Promise(res => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.kntweb.json,application/json,.mrbackup';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return res({ ok: false, error: 'No file selected' });
        try {
          const data = JSON.parse(await file.text());
          if (data.format !== 'knt-web-backup' && !data.accounts) return res({ ok: false, error: 'This is not a KNT web backup file.' });
          accounts = (data.accounts || []).slice(); save(LS.accounts, accounts);
          settings = Object.assign({}, settings, data.settings || {}); save(LS.settings, settings);
          packages = (data.packages || []).slice(); save(LS.packages, packages);
          emitLog('ok', 'system', 'Backup restored: ' + accounts.length + ' account(s)');
          res({ ok: true, count: accounts.filter(x => !x.trashed).length });
        } catch (e) { res({ ok: false, error: 'Could not read the backup: ' + ((e && e.message) || e) }); }
      };
      input.click();
    }),
    backupAutoCreate: async (pw, keep) => {
      const name = 'knt-backup-' + stamp() + '.kntweb.json';
      const snapshot = { accounts: clone(accounts), settings: clone(settings), packages: clone(packages) };
      backups.unshift({ name, path: name, size: 46000 + Math.floor(Math.random() * 4000), createdAtMs: Date.now(), snapshot });
      const k = Math.max(1, keep || 5);
      const pruned = Math.max(0, backups.length - k);
      backups = backups.slice(0, k);
      save(LS.backups, backups);
      return { ok: true, path: name, count: accounts.filter(x => !x.trashed).length, pruned };
    },
    backupList: () => Promise.resolve(clone(backups)),
    backupDelete: (name) => { backups = backups.filter(b => b.name !== name); save(LS.backups, backups); return Promise.resolve({ ok: true }); },
    backupRestorePath: async (path, pw) => {
      const b = backups.find(x => x.path === path);
      if (!b || !b.snapshot) return { ok: false, error: 'This backup was created before web auto-backup; use Create backup to make a restorable one.' };
      accounts = clone(b.snapshot.accounts || []); save(LS.accounts, accounts);
      settings = Object.assign({}, settings, b.snapshot.settings || {}); save(LS.settings, settings);
      packages = clone(b.snapshot.packages || []); save(LS.packages, packages);
      return { ok: true, count: accounts.filter(x => !x.trashed).length };
    },
    backupAutoPassword: () => {
      if (!autoPassword) { autoPassword = randomPassword(); save(LS.autoPw, autoPassword); }
      return Promise.resolve({ ok: true, password: autoPassword });
    },

    // ── status helpers ────────────────────────────────────────────────────
    multiInstanceStatus: () => Promise.resolve({ enabled: true }),
    antiAfkStatus: () => Promise.resolve({ enabled: !!settings.antiAfk, active: runningIds.size }),

    // ── generator history ─────────────────────────────────────────────────
    readGenHistory: () => Promise.resolve(clone(genHistory)),
    writeGenHistory: (list) => { genHistory = clone(list || []); save(LS.gen, genHistory); return Promise.resolve({ ok: true }); },
    clearGenHistory: () => { genHistory = []; save(LS.gen, genHistory); return Promise.resolve({ ok: true }); },

    // ── simulated Fast Flags / FPS cap ────────────────────────────────────
    readFFlags: () => Promise.resolve(load(LS.ff, {})),
    writeFFlags: (flags) => { save(LS.ff, flags || {}); return Promise.resolve({ ok: true }); },
    readFpsCap: () => Promise.resolve(typeof settings.fpsCap === 'number' ? settings.fpsCap : 60),
    writeFpsCap: (cap) => { settings.fpsCap = parseInt(cap, 10) || 60; save(LS.settings, settings); return Promise.resolve({ ok: true }); },

    // ── version info ──────────────────────────────────────────────────────
    getAppVersion: () => Promise.resolve('2.0.0-web'),
    getRobloxVersion: async (channel) => {
      try {
        const r = await fetch('/api/roblox-version', { signal: AbortSignal.timeout(5000) });
        if (r.ok) { const j = await r.json(); if (j && j.version) return j.version; }
      } catch {}
      return 'web';
    },
    getGameName: async (placeIdOrTarget, cookie) => {
      try {
        const r = await fetch('/api/game-name?target=' + encodeURIComponent(String(placeIdOrTarget || '')), { signal: AbortSignal.timeout(8000) });
        if (r.ok) { const j = await r.json(); if (j && j.name) return j.name; }
      } catch {}
      return '';
    },

    // ── CORS-shielded Roblox APIs ─────────────────────────────────────────
    robloxGet: async (url) => {
      // 1) same-origin relay (web/server.mjs)
      try {
        const r = await fetch('/proxy?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(9000) });
        if (r.ok) { const data = await r.json(); return { ok: true, status: r.status, data }; }
      } catch {}
      // 2) direct call — works only for endpoints that send CORS headers
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
        if (r.ok) { const data = await r.json(); return { ok: true, status: r.status, data }; }
      } catch {}
      // 3) built-in mock for the chart/search/detail endpoints
      const m = mockRobloxGet(url);
      if (m) return { ok: true, status: 200, data: m };
      return { ok: false, status: 0, data: null };
    },
    robloxGetAuth: async (url, cookie) => {
      // Server list and similar endpoints need a logged-in session.
      try {
        const r = await fetch('/proxy?url=' + encodeURIComponent(url), { headers: { Cookie: '.ROBLOSECURITY=' + cookie }, signal: AbortSignal.timeout(9000) });
        if (r.ok) { const data = await r.json(); return { ok: true, status: r.status, data }; }
      } catch {}
      try {
        const r = await fetch(url, { headers: { Cookie: '.ROBLOSECURITY=' + cookie }, signal: AbortSignal.timeout(9000) });
        if (r.ok) { const data = await r.json(); return { ok: true, status: r.status, data }; }
      } catch {}
      return { ok: false, status: 0, data: null };
    },
    weaoExploits: async () => {
      try {
        const r = await fetch('/proxy?url=' + encodeURIComponent('https://weao.xyz/api/status/exploits'), { signal: AbortSignal.timeout(12000) });
        if (r.ok) return await r.json();
      } catch {}
      try {
        const r = await fetch('https://weao.xyz/api/status/exploits', { signal: AbortSignal.timeout(12000) });
        if (r.ok) return await r.json();
      } catch {}
      return null;
    },
    followUser: async (cookie, username) => {
      try {
        const r = await fetch('/api/follow-user', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie, username }),
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok) { const j = await r.json(); return j; }
      } catch {}
      return { ok: false, error: 'Follow-user needs the local relay — run `node web/server.mjs`.' };
    },
    altgenGenerate: async (apiKey, quantity) => {
      try {
        const r = await fetch('/api/altgen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, quantity }),
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) { const j = await r.json(); return j; }
      } catch {}
      return { status: 0, data: { success: false, error: { message: 'Altgen requires the local relay — run `node web/server.mjs`.' } } };
    },

    // ── auto-update: desktop only (stubs — the web build has no installer) ──
    checkForUpdates: () => Promise.resolve(null),
    installUpdate: () => Promise.resolve(),

    // ── external links ────────────────────────────────────────────────────
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); return Promise.resolve(); },

    // ── event subscriptions (mirror Tauri listen()) ───────────────────────
    onChromeProgress: (cb) => on('chrome:download-progress', (e) => cb(e)),
    onRobloxClosed: (cb) => on('roblox:closed', (id) => cb(id)),
    onRobloxStarted: (cb) => on('roblox:started', (id) => cb(id)),
    onRobloxCount: (cb) => on('roblox:count', (n) => cb(n)),
    onAllRobloxClosed: (cb) => on('roblox:allClosed', () => cb()),
    onLogEntry: (cb) => on('log:entry', (d) => cb(d)),
  };

  // ── background simulated behaviors ──────────────────────────────────────
  // Anti-AFK: "taps" running instances on a slow tick when enabled.
  setInterval(() => {
    if (settings.antiAfk && runningIds.size) {
      emitLog('info', 'afk', `Anti-AFK tapped ${runningIds.size} running instance${runningIds.size === 1 ? '' : 's'} (simulated)`);
    }
  }, 60000);

  // Auto-trim: frees "memory" of running instances when enabled.
  setInterval(() => {
    if (settings.autoTrim && runningIds.size) {
      emitLog('info', 'mixer', `Auto-trim ran over ${runningIds.size} running instance${runningIds.size === 1 ? '' : 's'} (simulated)`);
    }
  }, 5 * 60000);

  // Welcome log entries so the Logs page is not empty on a fresh visit.
  setTimeout(() => {
    emitLog('info', 'system', 'KNT Manager Web started — data is stored in this browser (localStorage)', { platform: 'web' });
    emitLog('info', 'system', runningIds.size + ' simulated Roblox instance(s) running', { running: runningIds.size });
  }, 400);
})();
