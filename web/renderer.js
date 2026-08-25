let accounts = [], launchAcc = null, editAcc = null, toastTimer;
let packages = [], editingPackageId = null;
// Soft-deleted accounts live here until restored or purged (see Trash UI).
let trashedAccounts = [];
// Account categories, persisted inside settings.json as [{id, name}].
let categories = [];
const _launchedIds = new Set();
const _launchedAt = {}; // id -> timestamp ms (for uptime display)
// Accounts whose game went to the Roblox "home" (tray). The UI shows them
// amber instead of plain closed. Populated by onRobloxHome and reconciled
// by the poll loop.
const _homeIds = new Set();

// ── i18n ────────────────────────────────────────────────────────────────────
// Language dictionaries live in i18n/en.js and i18n/pt.js (window.I18N).
// Add a language by creating i18n/<code>.js and adding it to LANG_META + the
// index.html <script> tags.
const LANG_META = {
  en: { label: 'English' },
  pt: { label: 'Português (Brasil)' },
};
let _lang = 'en';

function t(key, vars) {
  const I = window.I18N || {};
  let s = (I[_lang] && I[_lang][key]) != null ? I[_lang][key]
        : (I.en && I.en[key]) != null ? I.en[key]
        : null;
  if (s == null) s = key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return s;
}

// Applies translations to the static tree ([data-i18n*] attributes). Dynamic
// parts are re-rendered by the callers (render(), renderPackages(), ...) with
// t() baked into their templates.
function applyI18n() {
  document.documentElement.lang = _lang;
  document.title = t('app.name');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}

function setLanguage(lang, persist) {
  if (!LANG_META[lang]) lang = 'en';
  _lang = lang;
  applyI18n();
  const lbl = document.getElementById('lang-label');
  if (lbl) lbl.textContent = LANG_META[_lang].label;
  const ttl = document.querySelector('.tb-name');
  if (ttl) ttl.textContent = t('app.name');
  // Rebuild the JS-rendered surfaces so their texts switch language too.
  if (typeof render === 'function') render();
  if (typeof renderPackages === 'function') renderPackages();
  if (typeof renderFilterCategories === 'function') renderFilterCategories();
  if (typeof renderCategories === 'function') renderCategories();
  if (typeof renderTrash === 'function') renderTrash();
  if (typeof renderTrackingAccounts === 'function') renderTrackingAccounts();
  if (typeof genRenderHistory === 'function') genRenderHistory();
  if (typeof renderLogs === 'function') renderLogs();
  // Settings labels rendered dynamically from t() (language, auto-backup
  // frequency/keep, channel) are not [data-i18n] nodes -- re-run the UI sync
  // so they switch language along with everything else.
  if (typeof applySettings === 'function' && typeof settings !== 'undefined' && settings) applySettings();
  if (typeof renderBackupHistory === 'function') renderBackupHistory();
  if (persist !== false) {
    try { localStorage.setItem('mr-lang', _lang); } catch {}
    settings.language = _lang;
    api.saveSettings({ language: _lang }).catch(() => {});
  }
}

// Language dropdown option clicked in Settings -> General.
function pickLanguage(lang) {
  setLanguage(lang);
  closeAllCdd();
  document.querySelectorAll('#cdd-lang-menu .cdd-option').forEach(o => {
    o.classList.toggle('selected', o.dataset.value === _lang);
  });
}

// ── Logs ─────────────────────────────────────────────────────────────────────
const _logs = [];
const MAX_LOGS = 2000;
const LOG_CATS = { launch:'launch', crash:'crash', kill:'kill', cookie:'cookie', afk:'afk', enc:'enc', system:'system', close:'close' };

function logEntry(level, category, message, meta) {
  const entry = { ts: Date.now(), level, category, message, meta: meta || {} };
  _logs.push(entry);
  if (_logs.length > MAX_LOGS) _logs.shift(); // keep the most-recent tail
  if (document.getElementById('page-logs')?.classList.contains('active')) _appendLogRow(entry);
}

// Surface uncaught invoke() rejections in the Logs page instead of losing them silently.
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && (e.reason.message || e.reason)) || 'Unknown error';
  logEntry('err', 'system', `Unhandled error: ${msg}`);
});

// Enter/Space activates role="button" elements for keyboard/AT users.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[role="button"]');
  if (!el) return;
  e.preventDefault();
  el.click();
});

function _logLine(e) {
  const t = new Date(e.ts);
  const ts = t.toLocaleTimeString('en-GB', { hour12:false }) + '.' + String(t.getMilliseconds()).padStart(3,'0');
  const cat = String(e.category || '').toUpperCase();
  const keys = Object.keys(e.meta || {}).filter(k => e.meta[k] !== null && e.meta[k] !== undefined);
  const meta = keys.length ? ' <span class="lg-meta">' + keys.map(k => `${esc(k)}=${esc(e.meta[k])}`).join(' ') + '</span>' : '';
  return `<div class="log-row log-row-${esc(e.level)}"><span class="lg-ts">${esc(ts)}</span><span class="lg-cat">${esc(cat)}</span><span class="lg-msg">${esc(e.message)}${meta}</span></div>`;
}

function renderLogs() {
  const el = document.getElementById('logs-list');
  if (!el) return;
  if (!_logs.length) { el.innerHTML = '<div class="logs-empty"><span class="material-icons-round">terminal</span>No log entries yet.</div>'; return; }
  // Tail behaviour: only auto-scroll to the newest line if already near the end.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = _logs.map(_logLine).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// Appends one row instead of rejoining/replacing the whole log list.
function _appendLogRow(entry) {
  const el = document.getElementById('logs-list');
  if (!el) return;
  if (el.querySelector('.logs-empty')) el.innerHTML = '';
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.insertAdjacentHTML('beforeend', _logLine(entry));
  while (el.children.length > MAX_LOGS) el.removeChild(el.firstChild);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// Native-style find (Ctrl+F) over the rendered log text. Uses window.find so
// selection, scroll-to-match and Ctrl+A/Ctrl+C all behave like a normal viewer.
function openLogFind() {
  const bar = document.getElementById('log-find');
  const inp = document.getElementById('log-find-input');
  if (!bar || !inp) return;
  bar.style.display = 'flex';
  inp.focus(); inp.select();
}
function closeLogFind() {
  const bar = document.getElementById('log-find');
  if (bar) bar.style.display = 'none';
  const sel = window.getSelection && window.getSelection();
  if (sel) sel.removeAllRanges();
  const c = document.getElementById('log-find-count');
  if (c) c.textContent = '';
}
function logFind(backwards) {
  const inp = document.getElementById('log-find-input');
  const c = document.getElementById('log-find-count');
  if (!inp) return;
  const q = inp.value;
  if (!q) { if (c) c.textContent = ''; return; }
  const found = window.find(q, false, !!backwards, true, false, false, false);
  if (c) c.textContent = found ? '' : t('logs.noMatches');
}
const _avatarCache = {};
let settings = {};

let _encMode = null;
function showEncModal(mode) {
  _encMode = mode;
  const title = document.getElementById('enc-title');
  const desc = document.getElementById('enc-desc');
  const action = document.getElementById('enc-action');
  const skip = document.getElementById('enc-skip');
  const err = document.getElementById('enc-err');
  const inp = document.getElementById('enc-input');
  if (err) { err.textContent = ''; err.classList.remove('show'); }
  if (inp) inp.value = '';
  _encSetBtnState('normal');
  if (mode === 'setup') {
    title.textContent = t('enc.titleSetup');
    desc.textContent = t('enc.descSetup');
    const lbl = action ? action.querySelector('span:last-child') : null;
    if (lbl) lbl.textContent = t('enc.setKey');
    if (skip) if (skip) skip.style.display = 'none';
  } else {
    title.textContent = t('enc.title');
    desc.textContent = t('enc.desc');
    if (skip) skip.style.display = 'none';
  }
  openModal('m-enc');
  setTimeout(() => inp && inp.focus(), 60);
}
function _encErr(m) {
  const e = document.getElementById('enc-err');
  if (e) { e.textContent = m; e.classList.add('show'); }
}
function _encSetBtnState(mode) {
  const action = document.getElementById('enc-action');
  if (!action) return;
  const label = action.querySelector('span:last-child') || action;
  if (mode === 'loading') {
    action.disabled = true;
    action.innerHTML = '<span class="spin" style="width:14px;height:14px"></span><span>' + esc(t('enc.unlocking')) + '</span>';
  } else if (mode === 'success') {
    action.disabled = true;
    action.innerHTML = '<span class="material-icons-round" style="font-size:16px">check</span><span>' + esc(t('enc.unlocked')) + '</span>';
  } else {
    action.disabled = false;
    action.innerHTML = '<span class="material-icons-round enc-submit-ic">lock_open</span><span>' + esc(t('enc.unlock')) + '</span>';
  }
}
function _encShake() {
  const card = document.querySelector('.enc-card');
  if (!card) return;
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
  setTimeout(() => card.classList.remove('shake'), 320);
}
async function submitEnc() {
  const inp = document.getElementById('enc-input');
  const val = inp ? inp.value : '';
  const err = document.getElementById('enc-err');
  if (err) err.classList.remove('show');
  if (!val) { _encErr(_encMode === 'setup' ? t('enc.errSetupEmpty') : t('enc.errEmpty')); _encShake(); inp && inp.focus(); return; }
  _encSetBtnState('loading');
  try {
    if (_encMode === 'setup') {
      const r = await api.encSetKey(val);
      if (!r || !r.ok) {
        const reason = r && r.error === 'decrypt failed'
          ? t('enc.errDecrypt')
          : (r && r.error ? t('enc.errSetFail', { err: r.error }) : t('enc.errSetGeneric'));
        _encErr(reason);
        _encSetBtnState('normal');
        _encShake();
        return;
      }
    } else {
      const r = await api.encUnlock(val);
      if (!r || !r.ok) { _encErr(t('enc.errWrong')); logEntry('warn', 'enc', 'Failed encryption unlock attempt (wrong key)'); _encSetBtnState('normal'); _encShake(); inp.value = ''; inp.focus(); return; }
      logEntry('ok', 'enc', 'Encryption key accepted, accounts unlocked');
    }
    _encSetBtnState('success');
    await new Promise(r => setTimeout(r, 260));
    closeModal('m-enc');
    await continueInit();
  } catch (e) { _encErr(t('enc.errGeneric')); _encSetBtnState('normal'); _encShake(); }
}
async function skipEnc() {
  const skip = document.getElementById('enc-skip');
  if (skip) skip.disabled = true;
  try { await api.encSetKey(''); } catch {}
  closeModal('m-enc');
  await continueInit();
}

function clearAppData() {
  confirmAction(t('settings.deleteAllConfirm'), async () => {
    const btn = document.getElementById('enc-clear-data');
    if (btn) { btn.disabled = true; btn.textContent = t('enc.clearing'); }
    let res;
    try { res = await api.clearAppData(); } catch (e) { res = { ok: false, error: e?.message || String(e) }; }
    if (res && res.ok) {
      // Full reload, not just re-running init(): the Rust side's own
      // in-memory caches get reset by the backend, but this is the simplest
      // way to guarantee every bit of frontend state (accounts, settings,
      // caches) starts completely fresh against the now-empty storage too.
      location.reload();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = t('enc.clearData'); }
      _encErr(res && res.error ? 'Could not clear data: ' + res.error : 'Could not clear data. Please try again.');
    }
  });
}

async function init() {
  // Encryption gate: in passphrase mode the cookies can't be read until the key is
  // entered for this boot session. Show the popup first; only load data once ready.
  try {
    const st = await api.encStatus();
    if (st && st.mode === 'locked') { showEncModal('locked'); return; }
    if (st && st.mode === 'setup') { showEncModal('setup'); return; }
  } catch {}
  await continueInit();
}

// Decrypt failure is itself proof a cookie is unusable -- flag it instantly
// (no network round-trip needed) instead of waiting on recheckAllCookies.
function flagInvalidCookies(list) {
  for (const a of list) {
    if (a._cookieInvalid) {
      _cookieStatus[a.id] = 'dead';
      logEntry('warn', 'cookie', `Cookie could not be decrypted for ${a.username || a.id} (corrupted or wrong key)`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
    }
  }
}

async function continueInit() {
  // Trashed records come back in the same list; split them here so the main
  // grid, cookie checks and package pickers only ever see active accounts.
  const loaded = await api.loadAccounts();
  accounts = loaded.filter(a => !a.trashed);
  trashedAccounts = loaded.filter(a => a.trashed);
  [settings, packages] = await Promise.all([api.loadSettings(), api.loadPackages()]);
  categories = Array.isArray(settings.categories) ? settings.categories : [];
  categories.forEach(c => { if (!c.color) c.color = catColor(c.id); }); // backfill color for categories saved before colors existed
  // Restore interface language (persisted setting, with localStorage fallback).
  let lang0 = 'en';
  if (settings.language && LANG_META[settings.language]) lang0 = settings.language;
  else { try { const ls = localStorage.getItem('mr-lang'); if (ls && LANG_META[ls]) lang0 = ls; } catch {} }
  _lang = lang0;
  applyI18n();
  const langLbl = document.getElementById('lang-label');
  if (langLbl) langLbl.textContent = LANG_META[_lang].label;
  logEntry('info', 'system', `Loaded ${accounts.length} account${accounts.length === 1 ? '' : 's'} from storage` + (trashedAccounts.length ? ` (${trashedAccounts.length} in trash)` : ''));
  flagInvalidCookies(accounts);
  recheckAllCookies(true); // kick a full check off the moment cookies are readable, not on the 60s tick
  renderFilterCategories();
  updateTrashBadge();
  render();
  renderDashboard();
  _initSliderFills();
  // put the toolbar back to the saved view + filter
  document.getElementById('vt-grid').classList.toggle('active', _acctView === 'grid');
  document.getElementById('vt-list').classList.toggle('active', _acctView === 'list');
  document.getElementById('vt-compact').classList.toggle('active', _acctView === 'compact');
  document.querySelectorAll('#filter-menu button').forEach(b => b.classList.toggle('active', b.dataset.f === _acctFilter));
  document.getElementById('filter-btn').classList.toggle('on', _acctFilter !== 'all');
  renderPackages();
  applySettings();
  refreshMultiStatus();
  positionNavSlider(); // covers landing on the default page without a goTo() call
  detectRobloxVersion();
  showAppVersion();
  checkForUpdates(false); // background check; modal appears only if a newer version is hosted
  startStatusPoll();
  if (settings.autoTrim) startAutoTrimLoop();
  startTrackingLoop();
  ensureAutoPassword(); // create the auto-backup password on first run
  startAutoBackupLoop();
  renderBackupHistory();
  logEntry('info', 'system', 'KNT Manager started', { version: 'v1', accounts: accounts.length, platform: navigator.platform });
  try { const k = localStorage.getItem('bloxgen_apikey'); if (k) { const el = document.getElementById('gen-apikey'); if (el) el.value = k; } } catch {}
  genOnKeyInput();
  try {
    const saved = localStorage.getItem('mr_manual_creds');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.username && parsed.password) { _manualCreds = parsed; manRenderCreds(); }
    }
  } catch {}
  try {
    const t = GEN_TYPES.find(x => x.value === localStorage.getItem('bloxgen_type'));
    if (t) genSetType(t.value, t.label, t.desc);
  } catch {}
  try { const afkStat = await api.antiAfkStatus(); if (afkStat && afkStat.enabled) logEntry('info', 'afk', `Anti-AFK is enabled on startup (active: ${afkStat.active})`, { enabled: afkStat.enabled, active: afkStat.active }); } catch {}
  try { _genHistory = (await api.readGenHistory()) || []; genRenderHistory(); } catch {}

  // Forward main-process log events into the renderer log
  api.onLogEntry(data => logEntry(data.level, data.category, data.message, data.meta));

  // main pushes the count off the watch tick; the local poll backs off below
  api.onRobloxCount(n => { _lastCountPushAt = Date.now(); _mixRunning = n; setRunningBadges(n); });

  // Fires the moment the process actually exists (see native.rs do_launch),
  // instead of waiting on the whole launch call -- CSRF fetch, auth ticket,
  // inter-launch stagger, trailing bookkeeping -- to resolve back to the
  // caller. markLaunched() is idempotent, so the doLaunch() success path
  // below calling it again once its own await resolves is harmless.
  api.onRobloxStarted(id => {
    markLaunched(id);
    pushActivity('rocket_launch', 'green', t('act.started', { u: esc(_acctLabel(id)) }));
  });

  api.onRobloxClosed(id => {
    _launchedIds.delete(id);
    _homeIds.delete(id);
    delete _launchedAt[id];
    const closedAcct = accounts.find(a => a.id === id);
    logEntry('info', 'close', `Roblox closed for ${closedAcct ? closedAcct.username : id}`, { accountId: id, username: closedAcct?.username || null, userId: closedAcct?.userId || null });
    pushActivity('stop_circle', 'muted', t('act.closed', { u: esc(_acctLabel(id)) }));
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) {
      card.classList.remove('is-live');
      card.classList.remove('is-home');
      const up = card.querySelector('.card-up');
      if (up) up.remove();
      const badge = card.querySelector('.card-home-badge');
      if (badge) badge.remove();
    }
    const dot = document.querySelector(`.card[data-id="${id}"] .card-dot`);
    if (dot) { dot.classList.remove('launched'); dot.classList.remove('home'); dot.title = 'Not launched'; }
    refreshPkgAvatarStatus();
    pollRunningCount();
    reorderCardsByStatus();
    updateCloseHomeBtn();
  });

  api.onRobloxHome(id => {
    _homeIds.add(id);
    _launchedIds.delete(id);
    delete _launchedAt[id];
    pushActivity('home', 'amber', t('act.home', { u: esc(_acctLabel(id)) }));
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) {
      card.classList.remove('is-live');
      card.classList.add('is-home');
      const up = card.querySelector('.card-up');
      if (up) up.remove();
      const uid = card.querySelector('.card-uid');
      if (uid && !card.querySelector('.card-home-badge')) uid.insertAdjacentHTML('afterend', `<div class="card-home-badge">${esc(t('accounts.home'))}</div>`);
    }
    const dot = document.querySelector(`.card[data-id="${id}"] .card-dot`);
    if (dot) { dot.classList.remove('launched'); dot.classList.add('home'); dot.title = t('accounts.home'); }
    refreshPkgAvatarStatus();
    reorderCardsByStatus();
    updateCloseHomeBtn();
  });

  api.onAllRobloxClosed(() => {
    logEntry('warn', 'close', 'All Roblox instances closed');
    _launchedIds.clear();
    _homeIds.clear();
    Object.keys(_launchedAt).forEach(k => delete _launchedAt[k]);
    document.querySelectorAll('.card.is-live').forEach(c => c.classList.remove('is-live'));
    document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched'); d.title = 'Not launched'; });
    document.querySelectorAll('.card .card-up').forEach(u => u.remove());
    refreshPkgAvatarStatus();
    pollRunningCount();
    reorderCardsByStatus();
    updateCloseHomeBtn();
    if (document.getElementById('page-mixer')?.classList.contains('active')) mixRefreshRunning();
  });

  // Chrome download progress
  api.onChromeProgress(data => {
    const dlDiv = document.getElementById('login-dl');
    const waitDiv = document.getElementById('login-waiting');
    if (!dlDiv || !waitDiv) return;
    if (data.status === 'downloading') {
      dlDiv.style.display = '';
      waitDiv.style.display = 'none';
      if (data.percent !== undefined) {
        document.getElementById('dl-bar').style.width = data.percent + '%';
        document.getElementById('dl-pct').textContent = data.percent + '%';
      }
    } else if (data.status === 'done') {
      dlDiv.style.display = 'none';
      waitDiv.style.display = '';
    }
  });
}
init();

// ── Theme ──────────────────────────────────────────────────────────────────
var THEMES = ['dark','light','midnight','aurora','sunset','crimson','ocean','grape','forest','amber','rose','graphite'];
function applyTheme(name) {
  if (THEMES.indexOf(name) < 0) name = 'dark';
  document.body.classList.remove('light');
  THEMES.forEach(t => { if (t !== 'dark' && t !== 'light') document.body.classList.remove('theme-' + t); });
  if (name === 'light') document.body.classList.add('light');
  else if (name !== 'dark') document.body.classList.add('theme-' + name);
  document.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('sel', c.dataset.theme === name));
  _applyTextureIntensity();
  _renderTexturePatternSelect();
}
function currentTheme() { try { return localStorage.getItem('ui-theme') || 'dark'; } catch { return 'dark'; } }
function setTheme(name) {
  if (THEMES.indexOf(name) < 0) name = 'dark';
  applyTheme(name);
  try { localStorage.setItem('ui-theme', name); } catch {}
}
// ── Texture intensity (off | subtle | medium) ─────────────────────────────
const _TEX_PATTERNS = ['grain','dots','stars','rays','triangles','crosses','waves','hex','grid','diagonal','mesh','circuit'];
function _themeTexture() { try { return localStorage.getItem('mr-theme-texture') || 'subtle'; } catch { return 'subtle'; } }
function _themePattern() { try { return localStorage.getItem('mr-theme-pattern') || ''; } catch { return ''; } }
function _themeTexSize() { try { return parseInt(localStorage.getItem('mr-theme-tex-size'), 10) || 0; } catch { return 0; } }
function _applyTextureIntensity() {
  const v = _themeTexture();
  const opacity = v === 'off' ? 0 : (v === 'medium' ? 1 : 0.55);
  document.documentElement.style.setProperty('--theme-texture-opacity', String(opacity));
  // Pattern override ('' = follow the active theme's own texture).
  // Set on BODY, not :root — body.theme-* declares --theme-texture on the
  // body itself, so an :root inline value would lose the cascade for
  // body::before. An inline style on body beats the stylesheet.
  const pat = _themePattern();
  if (pat === 'none') document.body.style.setProperty('--theme-texture', 'none');
  else if (pat) document.body.style.setProperty('--theme-texture', 'var(--tex-' + pat + ')');
  else document.body.style.removeProperty('--theme-texture');
  const sz = _themeTexSize();
  if (sz) document.body.style.setProperty('--theme-texture-size', sz + 'px');
  else document.body.style.removeProperty('--theme-texture-size');
  document.querySelectorAll('#texture-seg .vt').forEach(b => b.classList.toggle('active', b.dataset.tex === v));
  const sel = document.getElementById('texture-pattern');
  if (sel) sel.value = pat;
  const slider = document.getElementById('texture-size');
  if (slider) slider.value = sz;
  const lbl = document.getElementById('texture-size-val');
  if (lbl) lbl.textContent = sz ? sz + 'px' : t('themes.sizeAuto');
}
function setThemeTexture(v) {
  try { localStorage.setItem('mr-theme-texture', v); } catch {}
  _applyTextureIntensity();
}
function setThemePattern(v) {
  try { localStorage.setItem('mr-theme-pattern', v); } catch {}
  _applyTextureIntensity();
}
function setThemeTexSize(v) {
  const n = parseInt(v, 10) || 0;
  try { localStorage.setItem('mr-theme-tex-size', n ? String(n) : ''); } catch {}
  _applyTextureIntensity();
}
function _renderTexturePatternSelect() {
  const sel = document.getElementById('texture-pattern');
  if (!sel) return;
  let html = '<option value="">' + esc(t('themes.patternAuto')) + '</option>';
  html += '<option value="none">' + esc(t('themes.patternNone')) + '</option>';
  for (const p of _TEX_PATTERNS) html += '<option value="' + p + '">' + esc(t('themes.pattern' + p)) + '</option>';
  sel.innerHTML = html;
  sel.value = _themePattern();
}
function openDiscord() {
  api.openExternal('https://discord.gg/6eNAcGKmpC');
}
(function() {
  let t;
  try {
    t = localStorage.getItem('ui-theme');
    if (!t) { const old = localStorage.getItem('theme'); t = (old === 'light') ? 'light' : 'dark'; }
  } catch { t = 'dark'; }
  setTheme(t || 'dark');
})();

// ── BloxGen API key persistence ────────────────────────────────────────────
(function() {
  try {
    const saved = localStorage.getItem('bloxgen_apikey');
    if (saved) {
      const el = document.getElementById('gen-apikey');
      if (el) el.value = saved;
    }
  } catch {}
})();
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('gen-apikey');
  if (el) el.addEventListener('input', () => {
    try { localStorage.setItem('bloxgen_apikey', el.value); } catch {}
  });
});


async function detectRobloxVersion() {
  try {
    const ver = await api.getRobloxVersion(settings.lockChannel ? settings.robloxChannel : '');
    if (ver) {
      // Show full hash in titlebar badge, also update settings stat
      document.getElementById('tb-roblox-ver').textContent = ver;
      const el = document.getElementById('stat-rblx-ver');
      if (el) el.textContent = ver;
    } else {
      document.getElementById('tb-roblox-ver').textContent = '-';
      const el = document.getElementById('stat-rblx-ver');
      if (el) el.textContent = t('settings.notDetected');
    }
  } catch {
    document.getElementById('tb-roblox-ver').textContent = '-';
    const el = document.getElementById('stat-rblx-ver');
    if (el) el.textContent = t('settings.notDetected');
  }
}

async function showAppVersion() {
  let v;
  try { v = await api.getAppVersion(); } catch { return; }
  const verEl = document.getElementById('stat-app-ver');
  if (verEl && v) verEl.textContent = t('misc.version') + ' ' + v.replace(/\.0$/, '');
}

function applySettings() {
  // Reports what the backend actually writes rather than offering a choice it
  // doesn't honour: scrypt-derived AES-256-GCM once a key is set, otherwise
  // Windows DPAPI tied to the logged-in account (see encryption.rs).
  const encAlgo = document.getElementById('stat-enc-algo');
  const encDesc = document.getElementById('stat-enc-algo-desc');
  if (encAlgo) encAlgo.textContent = settings.keySet ? 'AES-256-GCM' : 'Windows DPAPI';
  if (encDesc) {
    encDesc.textContent = settings.keySet
      ? t('settings.encDescKey')
      : t('settings.encDescDpapi');
  }
  const keyIn = document.getElementById('custom-key');
  if (keyIn) { keyIn.value = ''; keyIn.placeholder = settings.keySet ? t('settings.encKeySetPh') : t('settings.encKeyPh'); }
  const afk = document.getElementById('set-antiafk');
  if (afk) afk.checked = !!settings.antiAfk;
  const afkSb = document.getElementById('sb-antiafk');
  if (afkSb) afkSb.checked = !!settings.antiAfk;
  const afkIv = document.getElementById('set-antiafk-interval');
  if (afkIv) {
    const mins = Math.round((settings.antiAfkInterval || 19 * 60) / 60);
    afkIv.value = mins;
    updateSliderFill(afkIv);
    const afkIvVal = document.getElementById('set-antiafk-interval-val');
    if (afkIvVal) afkIvVal.textContent = mins + ' min';
  }
  const trim = document.getElementById('set-autotrim');
  if (trim) trim.checked = !!settings.autoTrim;
  const trimIv = document.getElementById('set-autotrim-interval');
  if (trimIv) {
    const mins = settings.autoTrimIntervalMin || 5;
    trimIv.value = mins;
    updateSliderFill(trimIv);
    const trimIvVal = document.getElementById('set-autotrim-interval-val');
    if (trimIvVal) trimIvVal.textContent = mins + ' min';
  }
  const relaunch = document.getElementById('set-autorelaunch');
  if (relaunch) relaunch.checked = !!settings.autoRelaunch;
  const lowPriority = document.getElementById('set-lowpriority');
  if (lowPriority) lowPriority.checked = settings.lowPriorityMultiInstance !== false;
  const lockChannel = document.getElementById('set-lockchannel');
  if (lockChannel) lockChannel.checked = !!settings.lockChannel;
  robloxChannelUpdateUI(settings.robloxChannel || '');
  const lpEl = document.getElementById('set-launcher-path');
  if (lpEl) lpEl.value = settings.launcherPath || '';
  // Automatic backup controls
  const ab = settings.autoBackup || {};
  const abToggle = document.getElementById('set-autobackup');
  if (abToggle) abToggle.checked = !!ab.enabled;
  const freqLbl = document.getElementById('cdd-autofreq-label');
  if (freqLbl) freqLbl.textContent = _autoBackupFreqLabel(ab.intervalHours || 24);
  document.querySelectorAll('#cdd-autofreq-menu .cdd-option').forEach(o => o.classList.toggle('selected', Number(o.dataset.value) === (ab.intervalHours || 24)));
  const keepLbl = document.getElementById('cdd-autokeep-label');
  if (keepLbl) keepLbl.textContent = String(ab.keep || 5);
  document.querySelectorAll('#cdd-autokeep-menu .cdd-option').forEach(o => o.classList.toggle('selected', Number(o.dataset.value) === (ab.keep || 5)));
  const pwEl = document.getElementById('auto-backup-pw');
  if (pwEl) pwEl.textContent = ab.password || '—';
}

let _acctQuery = '', _acctFilter = (() => { try { const f = localStorage.getItem('mr-acct-filter'); return (f && f !== 'running' && f !== 'idle') ? f : 'all'; } catch { return 'all'; } })(), _acctView = (() => { try { const v = localStorage.getItem('mr-acct-view'); return (v === 'list' || v === 'compact') ? v : 'grid'; } catch { return 'grid'; } })();
// Active category filter: '' = any, 'nocat' = uncategorized, else a category id.
let _acctCategory = '';

// What the filter menu should highlight as the current selection.
function _currentFilterKey() {
  if (_acctCategory === 'nocat') return 'nocat';
  if (_acctCategory) return 'cat:' + _acctCategory;
  return _acctFilter;
}

function accountSearchHaystack(a) {
  const cat = categories.find(c => c.id === a.categoryId);
  return ((a.nickname || '') + ' ' + (a.username || '') + ' ' + String(a.userId || '') + ' ' + (cat ? cat.name : '') + ' ' + (a.description || '')).toLowerCase();
}

function visibleAccounts() {
  let list = [...accounts];
  if (_acctQuery) {
    const q = _acctQuery;
    // Search across alias, username, user ID, category name and description.
    list = list.filter(a => accountSearchHaystack(a).includes(q));
  }
  if (_acctCategory === 'nocat') list = list.filter(a => !a.categoryId);
  else if (_acctCategory) list = list.filter(a => a.categoryId === _acctCategory);
  if (_acctFilter === 'running') list = list.filter(a => _launchedIds.has(a.id));
  else if (_acctFilter === 'idle') list = list.filter(a => !_launchedIds.has(a.id));
  else if (_acctFilter === 'valid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 1 : 0;
    return s(a.id) - s(b.id);
  });
  else if (_acctFilter === 'invalid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 0 : 1;
    return s(a.id) - s(b.id);
  });
  // Default order: running instances first (stable sort keeps the rest in
  // their existing relative order, so drag reorder still works). Applied for
  // EVERY filter so the live-float and the post-render order can't disagree
  // (previously valid/invalid-first skipped it, which made accounts that
  // floated to the top fall back down after a Sync).
  list.sort((a, b) => (_launchedIds.has(a.id) ? 0 : 1) - (_launchedIds.has(b.id) ? 0 : 1));
  return list;
}

// Rebuilds the dynamic category entries in the Accounts filter menu.
function renderFilterCategories() {
  const wrap = document.getElementById('filter-menu-cats');
  if (!wrap) return;
  if (!categories.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = categories.map(c =>
    `<button data-f="cat:${c.id}" onclick="setAcctFilter('cat:${c.id}')"><span class="cat-dot" style="background:${c.color || catColor(c.id)}"></span>${esc(c.name)}</button>`
  ).join('');
}
let _searchTimer;
function onAcctSearch(v) {
  _acctQuery = (v || '').trim().toLowerCase();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(render, 120); // debounce so a long list isn't rebuilt on every keystroke
}
function toggleFilterMenu(e) { if (e) e.stopPropagation(); document.getElementById('filter-menu').classList.toggle('open'); }
function setAcctFilter(f) {
  // Category selections are addressed as 'cat:<id>' and never persisted;
  // everything else maps straight onto the classic filter list.
  if (f && f.startsWith('cat:')) { _acctCategory = f.slice(4); _acctFilter = 'all'; }
  else if (f === 'nocat') { _acctCategory = 'nocat'; _acctFilter = 'all'; }
  else { _acctCategory = ''; _acctFilter = f; }
  // Only the classic filters are worth remembering across sessions; category
  // selections (and the empty-trash 'nocat') reset on reload.
  const persist = (f === 'running' || f === 'idle' || (f && f.startsWith('cat:')) || f === 'nocat') ? 'all' : f;
  try { localStorage.setItem('mr-acct-filter', persist); } catch {}
  const key = _currentFilterKey();
  document.querySelectorAll('#filter-menu button[data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === key));
  document.getElementById('filter-menu').classList.remove('open');
  document.getElementById('filter-btn').classList.toggle('on', key !== 'all');
  render();
}
function setAcctView(v) {
  _acctView = v;
  try { localStorage.setItem('mr-acct-view', v); } catch {}
  document.getElementById('vt-grid').classList.toggle('active', v === 'grid');
  document.getElementById('vt-list').classList.toggle('active', v === 'list');
  document.getElementById('vt-compact').classList.toggle('active', v === 'compact');
  render();
}
document.addEventListener('click', e => {
  const fm = document.getElementById('filter-menu');
  if (fm && fm.classList.contains('open') && !e.target.closest('.filter-wrap')) fm.classList.remove('open');
});

function toggleAntiAfk(src) {
  const el = document.getElementById(src === 'sb' ? 'sb-antiafk' : 'set-antiafk');
  const on = el.checked;
  settings.antiAfk = on;
  api.saveSettings({ antiAfk: on });
  const a = document.getElementById('set-antiafk'); if (a) a.checked = on;
  const b = document.getElementById('sb-antiafk'); if (b) b.checked = on;
  toast(on ? 'Anti-AFK on, accounts stay connected' : 'Anti-AFK off', on ? 'ok' : 'err');
}

function antiAfkIntervalInput(v) {
  document.getElementById('set-antiafk-interval-val').textContent = v + ' min';
  updateSliderFill(document.getElementById('set-antiafk-interval'));
}
function antiAfkIntervalCommit() {
  const mins = parseInt(document.getElementById('set-antiafk-interval').value, 10);
  const secs = mins * 60;
  settings.antiAfkInterval = secs;
  api.saveSettings({ antiAfkInterval: secs });
  toast(t('afk.interval', { min: mins }), 'ok');
}

// Silent trim -- no toast/button spinner, just logs. Skips the tasklist
// round-trip entirely when nothing is running.
let _autoTrimTimer = null;
async function _autoTrimTick() {
  if (_mixRunning <= 0) return;
  let res;
  try { res = await api.trimRobloxMemory(); } catch { return; }
  if (res && res.ok && res.total > 0) logEntry('info', 'system', `Auto-trimmed ${res.trimmed}/${res.total} Roblox instance(s)`);
}
function startAutoTrimLoop() {
  stopAutoTrimLoop();
  const mins = settings.autoTrimIntervalMin || 5;
  _autoTrimTimer = setInterval(_autoTrimTick, mins * 60 * 1000);
}
function stopAutoTrimLoop() {
  if (_autoTrimTimer) { clearInterval(_autoTrimTimer); _autoTrimTimer = null; }
}
function toggleAutoRelaunch() {
  const el = document.getElementById('set-autorelaunch');
  const on = el.checked;
  settings.autoRelaunch = on;
  api.saveSettings({ autoRelaunch: on });
  toast(on ? 'Relaunch on disconnect on' : 'Relaunch on disconnect off', on ? 'ok' : 'err');
}
// Releasing/re-acquiring the mutex happens inside the helper and isn't
// instant, so re-read the real state afterwards instead of assuming the badge
// can be derived from the checkbox.
async function toggleMultiInstance() {
  const el = document.getElementById('set-multiinstance');
  const on = el.checked;
  el.disabled = true;
  settings.multiInstance = on;
  try {
    await api.saveSettings({ multiInstance: on });
    toast(on ? 'Multi-instance on' : 'Multi-instance off, Roblox will allow one client', on ? 'ok' : 'err');
  } finally {
    el.disabled = false;
  }
  await refreshMultiStatus();
}
function toggleLowPriority() {
  const el = document.getElementById('set-lowpriority');
  const on = el.checked;
  settings.lowPriorityMultiInstance = on;
  api.saveSettings({ lowPriorityMultiInstance: on });
  toast(on ? 'Multi-instance priority lowering on' : 'Multi-instance priority lowering off', on ? 'ok' : 'err');
}
function toggleLockChannel() {
  const el = document.getElementById('set-lockchannel');
  const on = el.checked;
  settings.lockChannel = on;
  api.saveSettings({ lockChannel: on });
  toast(on ? 'Channel locked' : 'Channel unlocked', on ? 'ok' : 'err');
  detectRobloxVersion();
}
function toggleAutoTrim() {
  const el = document.getElementById('set-autotrim');
  const on = el.checked;
  settings.autoTrim = on;
  api.saveSettings({ autoTrim: on });
  if (on) startAutoTrimLoop(); else stopAutoTrimLoop();
  toast(on ? 'Auto trim on' : 'Auto trim off', on ? 'ok' : 'err');
}
function autoTrimIntervalInput(v) {
  document.getElementById('set-autotrim-interval-val').textContent = v + ' min';
  updateSliderFill(document.getElementById('set-autotrim-interval'));
}
function autoTrimIntervalCommit() {
  const mins = parseInt(document.getElementById('set-autotrim-interval').value, 10);
  settings.autoTrimIntervalMin = mins;
  api.saveSettings({ autoTrimIntervalMin: mins });
  if (settings.autoTrim) startAutoTrimLoop();
  toast(t('settings.trimInterval', { min: mins }), 'ok');
}

function toggleCdd(name) {
  const trigger = document.getElementById('cdd-' + name + '-trigger');
  const menu = document.getElementById('cdd-' + name + '-menu');
  const open = menu.classList.contains('open');
  closeAllCdd();
  if (!open) {
    trigger.classList.add('open');
    menu.classList.add('open');
    fitCddMenu(trigger, menu);
  }
}

// Dropdown menus are absolutely positioned inside panels that scroll (.sw,
// pages with overflow-y:auto), so an open menu is clipped at the panel's edge
// when the trigger sits low in it. Measure the room below the trigger and flip
// the menu to open upward when staying below would cut it off. Also falls back
// to the viewport when the menu isn't inside a scroll container (e.g. modals).
function fitCddMenu(trigger, menu) {
  let sc = trigger.parentElement;
  while (sc && sc !== document.body) {
    const cs = getComputedStyle(sc);
    if (/(auto|scroll|overlay)/.test(cs.overflowY)) break;
    sc = sc.parentElement;
  }
  menu.classList.remove('up');
  const trR = trigger.getBoundingClientRect();
  const menuH = menu.scrollHeight + 6; // 5px gap + a little slack
  let below, above;
  if (sc && sc !== document.body) {
    const scR = sc.getBoundingClientRect();
    below = scR.bottom - trR.bottom;
    above = trR.top - scR.top;
  } else {
    below = window.innerHeight - trR.bottom;
    above = trR.top;
  }
  // Only flip when the whole menu fits above the trigger — a flipped menu that
  // is taller than the space above would cover the page header instead.
  if (menuH > below && above >= menuH) menu.classList.add('up');
}

// A dropdown left open while its panel scrolls floats detached from the row it
// belongs to, so close any open menu the moment its scroll container moves.
// (Scrolling the menu's own option list doesn't count — that's browsing.)
document.addEventListener('scroll', e => {
  const t = e.target;
  if (!t || t === document || t.classList.contains('cdd-menu')) return;
  if (t.querySelector && t.querySelector('.cdd-menu.open')) closeAllCdd();
}, true);
function closeAllCdd() {
  document.querySelectorAll('.cdd-trigger.open').forEach(t => t.classList.remove('open'));
  document.querySelectorAll('.cdd-menu.open').forEach(m => m.classList.remove('open'));
}
document.addEventListener('click', e => { if (!e.target.closest('.cdd')) closeAllCdd(); });

// Called after any navigation/tab switch so slider fills are always correct.
function refreshAllSliderFills() {
  document.querySelectorAll('.fps-slider').forEach(updateSliderFill);
}

// Segments aren't equal width, so the pill's left/width are computed in
// real pixels from the active button's own rect rather than assumed from
// index -- this is also what lets one CSS rule work for both tab bars
// (Settings' 6 segments and Charts' 3) without hardcoding either count.
function positionTabSlider(barEl) {
  if (!barEl) return;
  let slider = barEl.querySelector('.tab-slider');
  const isNew = !slider;
  if (isNew) {
    slider = document.createElement('div');
    slider.className = 'tab-slider';
    barEl.insertBefore(slider, barEl.firstChild);
  }
  const active = barEl.querySelector('.tab-btn.active');
  if (!active) { slider.style.opacity = '0'; return; }
  if (isNew) slider.style.transition = 'none';
  // offsetLeft/offsetWidth, not getBoundingClientRect: they're relative to
  // the padding edge of the nearest positioned ancestor (here, barEl itself,
  // since both are its direct children) -- exactly what CSS `left` on an
  // absolutely-positioned sibling measures from. getBoundingClientRect
  // instead gives the border-box's outer edge, so subtracting two of those
  // was off by the bar's own border-width in every direction: a small,
  // constant, one-sided-looking gap.
  slider.style.left = active.offsetLeft + 'px';
  slider.style.width = active.offsetWidth + 'px';
  slider.style.opacity = '1';
  if (isNew) {
    void slider.offsetWidth; // force layout so the disabled transition applies before restoring it
    slider.style.transition = '';
  }
}
// Same technique as positionTabSlider, vertical instead of horizontal -- nav
// items are flex-stacked with gaps rather than a fixed row height, so top/
// height come from the active item's measured rect, not an assumed index.
function positionNavSlider() {
  const bar = document.getElementById('sidebar');
  if (!bar) return;
  let slider = bar.querySelector('.nav-slider');
  const isNew = !slider;
  if (isNew) {
    slider = document.createElement('div');
    slider.className = 'nav-slider';
    bar.insertBefore(slider, bar.firstChild);
  }
  const active = bar.querySelector('.nav-item.active');
  if (!active) { slider.style.opacity = '0'; return; }
  if (isNew) slider.style.transition = 'none';
  // See positionTabSlider's comment -- offsetTop/offsetHeight, not
  // getBoundingClientRect, for the same padding-edge-vs-border-edge reason.
  slider.style.top = active.offsetTop + 'px';
  slider.style.height = active.offsetHeight + 'px';
  slider.style.opacity = '1';
  if (isNew) {
    void slider.offsetWidth;
    slider.style.transition = '';
  }
}
window.addEventListener('resize', () => {
  document.querySelectorAll('.tab-bar').forEach(bar => {
    if (bar.querySelector('.tab-btn.active')) positionTabSlider(bar);
  });
  positionNavSlider();
});

function settingsTab(tab) {
  ['general','performance','roblox','privacy','themes','about'].forEach(t => {
    const panel = document.getElementById('stab-panel-' + t);
    const btn = document.getElementById('stab-' + t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'performance') renderEngineInit();
  if (tab === 'privacy') renderBackupHistory();
  refreshAllSliderFills();
  positionTabSlider(document.getElementById('stab-general')?.closest('.tab-bar'));
}

function goTo(p) {
  if (p === 'themes') { goTo('settings'); settingsTab(p); return; }
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  document.getElementById('nav-' + p).classList.add('active');
  positionNavSlider();
  if (p === 'settings') {
    document.getElementById('stat-count').textContent = accounts.length;
    refreshMultiStatus();
    // Covers landing here without ever clicking a tab -- the default-active
    // tab still needs the pill positioned under it at least once.
    positionTabSlider(document.getElementById('stab-general')?.closest('.tab-bar'));
  }
  if (p === 'logs') renderLogs();
  if (p === 'charts') {
    if (!chartsLoaded) loadCharts();
    positionTabSlider(document.getElementById('ctab-popular')?.closest('.tab-bar'));
  }
  if (p === 'packages') renderPackages();
  if (p === 'mixer') mixInit();
  if (p === 'tracking') renderTrackingPage();
  // generator page
  refreshAllSliderFills();
}

// Human-friendly uptime for the account card: "há 5min", "há 2h 34min",
// "há 1d 3h" — always counting from the moment the instance started.
function fmtUptime(startTs) {
  if (!startTs) return '';
  const s = Math.max(0, Math.floor((Date.now() - startTs) / 1000));
  if (s < 60) return t('accounts.upNow');
  const m = Math.floor(s / 60);
  if (m < 60) return t('accounts.upMin', { m });
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return t('accounts.upHour', { h, m: rm });
  const d = Math.floor(h / 24), rh = h % 24;
  return t('accounts.upDay', { d, h: rh });
}

// Creates/updates the uptime badge on a rendered card, without re-rendering.
function ensureCardUp(card, id) {
  if (!card || !_launchedAt[id]) return;
  let up = card.querySelector('.card-up');
  if (!up) {
    up = document.createElement('div');
    up.className = 'card-up';
    const idBox = card.querySelector('.card-id');
    if (idBox) idBox.appendChild(up);
  }
  up.textContent = fmtUptime(_launchedAt[id]);
}

// Moves the rendered cards so running instances float to the top, without a
// full re-render (no entrance-animation replay / grid flicker). Stable sort:
// non-running cards keep their relative order, so drag reorder survives.
function reorderCardsByStatus() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const addCard = grid.querySelector('.card-add');
  const cards = Array.from(grid.querySelectorAll('.card[data-id]'));
  if (cards.length < 2) return;
  cards.sort((a, b) => (_launchedIds.has(a.dataset.id) ? 0 : 1) - (_launchedIds.has(b.dataset.id) ? 0 : 1));
  const frag = document.createDocumentFragment();
  cards.forEach(c => frag.appendChild(c));
  if (addCard) grid.insertBefore(frag, addCard);
  else grid.appendChild(frag);
}

function markLaunched(id) {
  _launchedIds.add(id);
  _sessionLaunched.add(id);
  _homeIds.delete(id);
  if (!_launchedAt[id]) _launchedAt[id] = Date.now();
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.add('is-live');
    const dot = card.querySelector('.card-dot');
    if (dot) { dot.classList.add('launched'); dot.title = 'Launched'; }
    ensureCardUp(card, id);
  }
  reorderCardsByStatus();
  refreshPkgAvatarStatus();
  renderDashboard();
}

async function killOne(id) {
  const a = accounts.find(x => x.id === id);
  logEntry('warn', 'kill', `Killing Roblox instance for ${a ? a.username : id}...`, { accountId: id, username: a?.username, userId: a?.userId });
  const res = await api.killOneRoblox(id);
  if (!res || !res.ok) toast(res?.error || 'Could not kill that instance', 'err');
  else logEntry('ok', 'kill', `Killed instance for ${a ? a.username : id}`, { accountId: id });
}

// Shows/hides the "Close tray" button in the Accounts header depending on
// whether any account is sitting in the Roblox home (amber badge).
function updateCloseHomeBtn() {
  const btn = document.getElementById('acct-closehome-btn');
  if (btn) btn.style.display = _homeIds.size ? '' : 'none';
}

// Closes the shared Roblox "home" (tray) launcher — every account sitting in
// the home loses its amber badge at once (they share that one process).
async function closeHomeAll() {
  const btn = document.getElementById('acct-closehome-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await api.killHomeRoblox();
    logEntry('info', 'close', `Roblox home/tray closed (${res ? res.killed : 0} process${res && res.killed !== 1 ? 'es' : ''})`, { killed: res ? res.killed : 0, cleared: res ? res.cleared : 0 });
    if (res && !res.ok) toast(res.error || t('common.failed', { msg: 'home' }), 'err');
  } catch (e) {
    logEntry('warn', 'close', `Failed to close Roblox home: ${e}`);
    toast(t('common.failed', { msg: e && e.message ? e.message : e }), 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Card context menu ─────────────────────────────────────────────────────
let _ctxMenuId = null;
function showCardMenu(id, x, y) {
  closeCardMenu();
  _ctxMenuId = id;
  const a = accounts.find(x => x.id === id);
  const isLive = _launchedIds.has(id);
  const menu = document.createElement('div');
  menu.id = 'card-ctx-menu';
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-header">${esc(a ? (a.nickname || a.username || 'Unknown') : id)}</div>
    ${isLive ? `<button class="ctx-item ctx-danger" onclick="ctxKill('${id}')"><span class="material-icons-round">power_settings_new</span>Kill instance</button>` : ''}
    ${isLive ? `<button class="ctx-item" onclick="ctxTrim('${id}')"><span class="material-icons-round">memory</span>Trim memory</button>` : ''}
    ${isLive ? `
    <div class="ctx-item ctx-has-sub">
      <span class="material-icons-round">speed</span>Set priority
      <span class="material-icons-round ctx-sub-arrow">chevron_right</span>
      <div class="ctx-submenu">
        ${['realtime', 'high', 'abovenormal', 'normal', 'belownormal', 'low'].map(p =>
          `<button class="ctx-item${_accountPriority[id] === p ? ' ctx-active' : ''}" onclick="ctxSetPriority('${id}','${p}')">${PRIORITY_LABELS[p]}</button>`
        ).join('')}
      </div>
    </div>` : ''}
    <button class="ctx-item" onclick="ctxLaunch('${id}')"><span class="material-icons-round">rocket_launch</span>${isLive ? 'Relaunch' : 'Launch'}</button>
    <button class="ctx-item" onclick="ctxEdit('${id}')"><span class="material-icons-round">edit</span>Edit account</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" onclick="ctxCopyId('${id}')"><span class="material-icons-round">tag</span>Copy user ID</button>
    <button class="ctx-item" onclick="ctxCopyUser('${id}')"><span class="material-icons-round">person</span>Copy username</button>
    <button class="ctx-item" onclick="ctxCopyCookie('${id}')"><span class="material-icons-round">cookie</span>Copy cookie</button>
    ${a?.password ? `<button class="ctx-item" onclick="ctxCopyPassword('${id}')"><span class="material-icons-round">lock</span>Copy password</button>` : ''}
    <button class="ctx-item" onclick="ctxOpenBrowser('${id}')"><span class="material-icons-round">open_in_browser</span>Open in browser</button>
  `;
  document.body.appendChild(menu);
  positionCardMenu(menu, x, y);
  setTimeout(() => document.addEventListener('click', closeCardMenu, { once: true }), 0);
}

const CTX_EDGE_GAP = 8;

// Keeps the menu (and its submenu) fully on screen. Previously this assumed a
// 200px-wide menu and only clamped the far edge, so a menu wider than that --
// the width grows with the account name and the "Set priority" row -- still
// ran off the right, and a clamp that went negative pushed the top of the menu
// above the viewport where it couldn't be reached.
function positionCardMenu(menu, x, y) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  let h = rect.height;

  // Defensive: a menu taller than the window would otherwise have to be
  // positioned partly off-screen. Scroll it instead of hiding items.
  if (h > vh - CTX_EDGE_GAP * 2) {
    h = vh - CTX_EDGE_GAP * 2;
    menu.style.maxHeight = h + 'px';
    menu.style.overflowY = 'auto';
  }

  // Clamp both ends: Math.min alone keeps it off the right/bottom edge but
  // happily produces a negative left/top on a small window.
  menu.style.left = Math.max(CTX_EDGE_GAP, Math.min(x, vw - rect.width - CTX_EDGE_GAP)) + 'px';
  menu.style.top = Math.max(CTX_EDGE_GAP, Math.min(y, vh - h - CTX_EDGE_GAP)) + 'px';

  positionCardSubmenu(menu, vw, vh);
}

// The priority submenu opens to the right at left:100%. Near the right edge
// that put it entirely outside the window -- the row highlighted on hover but
// nothing appeared, which is the "menu goes invisible" case. It's laid out
// (opacity:0, not display:none), so it can be measured before it's shown.
function positionCardSubmenu(menu, vw, vh) {
  const parent = menu.querySelector('.ctx-has-sub');
  const sub = parent && parent.querySelector('.ctx-submenu');
  if (!sub) return;

  const menuRect = menu.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();

  // Flip to the left of the menu when there isn't room on the right, unless
  // there's even less room on that side.
  const roomRight = vw - menuRect.right;
  const roomLeft = menuRect.left;
  if (roomRight < subRect.width + CTX_EDGE_GAP && roomLeft > roomRight) {
    parent.classList.add('ctx-flip-x');
  }

  // And lift it when it would run past the bottom of the window.
  const overflowBelow = parent.getBoundingClientRect().top - 4 + subRect.height + CTX_EDGE_GAP - vh;
  if (overflowBelow > 0) sub.style.top = (-4 - overflowBelow) + 'px';
}
function closeCardMenu() { const m = document.getElementById('card-ctx-menu'); if (m) m.remove(); _ctxMenuId = null; }
async function ctxKill(id) { closeCardMenu(); await killOne(id); }
async function ctxTrim(id) {
  closeCardMenu();
  const a = accounts.find(x => x.id === id);
  let res;
  try { res = await api.trimAccountMemory(id); } catch { res = null; }
  if (res?.ok) {
    logEntry('info', 'system', `Trimmed memory for ${a?.username || id}`, { accountId: id, username: a?.username, userId: a?.userId });
    toast(`Trimmed memory for ${a?.nickname || a?.username || 'instance'}`, 'ok');
  } else {
    toast(res?.error || 'Could not trim this instance', 'err');
  }
}
const PRIORITY_LABELS = { realtime: 'Realtime', high: 'High', abovenormal: 'Above normal', normal: 'Normal', belownormal: 'Below normal', low: 'Low' };
const _accountPriority = {}; // id -> last priority manually set this session, drives the ctx-active highlight
async function ctxSetPriority(id, priority) {
  closeCardMenu();
  const a = accounts.find(x => x.id === id);
  let res;
  try { res = await api.setAccountPriority(id, priority); } catch { res = null; }
  if (res?.ok) {
    _accountPriority[id] = priority;
    toast(`Priority set to ${PRIORITY_LABELS[priority]} for ${a?.nickname || a?.username || 'instance'}`, 'ok');
  } else {
    toast(res?.error || 'Could not set priority', 'err');
  }
}

function ctxLaunch(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a) { launchAcc = a; openModal('m-launch'); } }
function ctxEdit(id) { closeCardMenu(); openEdit(id); }
function ctxCopyId(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.userId) navigator.clipboard.writeText(a.userId).then(() => toast(t('acct.copyId'), 'ok')); else toast(t('acct.noId'), 'err'); }
function ctxCopyUser(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.username) navigator.clipboard.writeText(a.username).then(() => toast(t('acct.copyUser'), 'ok')); else toast(t('acct.noUser'), 'err'); }
function ctxCopyCookie(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.cookie) navigator.clipboard.writeText(a.cookie).then(() => toast(t('acct.copyCookie'), 'ok')); else toast(t('acct.noCookie'), 'err'); }
function ctxCopyPassword(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.password) navigator.clipboard.writeText(a.password).then(() => toast(t('acct.copyPassword'), 'ok')); else toast(t('acct.noPassword'), 'err'); }
async function ctxOpenBrowser(id) {
  closeCardMenu();
  const a = accounts.find(x => x.id === id);
  if (!a?.cookie) { toast(t('acct.noCookie'), 'err'); return; }
  toast(t('login.opening'), 'ok');
  let res;
  try { res = await api.openAccountInBrowser(a.cookie); } catch { res = null; }
  if (!res || !res.ok) toast((res && res.error) || 'Could not open browser', 'err');
}

function refreshPkgAvatarStatus() {
  document.querySelectorAll('.pkg-avatar[data-acc-id]').forEach(av => {
    av.classList.toggle('online', _launchedIds.has(av.dataset.accId));
    av.classList.toggle('home', _homeIds.has(av.dataset.accId));
  });
  // Keeps each group's status bar / action buttons in sync even when
  // instances start/stop outside launchPackage/killPackage.
  packages.forEach(p => {
    const card = document.querySelector('.pkg-card[data-id="' + p.id + '"]');
    if (!card) return;
    const st = pkgState(p);
    const btn = card.querySelector('.pkg-kill-btn');
    if (btn && btn.dataset.busy !== '1') btn.disabled = !st.running;
    const relBtn = card.querySelector('.pkg-relaunch-btn');
    if (relBtn && relBtn.dataset.busy !== '1') relBtn.disabled = !st.downed;
    const trimBtn = card.querySelector('.pkg-trim-btn');
    if (trimBtn) trimBtn.disabled = !st.running;
    const pct = st.total ? Math.round((st.running + st.home) / st.total * 100) : 0;
    const fill = card.querySelector('.pkg-progress-fill');
    if (fill) fill.style.width = pct + '%';
    const txt = card.querySelector('.pkg-status-text');
    if (txt) {
      const run = txt.querySelector('.pkg-status-run'); if (run) run.textContent = st.running;
      const total = txt.querySelector('.pkg-status-total'); if (total) total.textContent = st.total;
      const home = txt.querySelector('.pkg-status-home'); if (home) home.textContent = st.home;
      const downed = txt.querySelector('.pkg-status-downed'); if (downed) downed.textContent = st.downed;
      const homeBlock = txt.querySelector('.pkg-status-home-sep');
      if (homeBlock) homeBlock.style.display = st.home ? '' : 'none';
      const downedBlock = txt.querySelector('.pkg-status-downed-sep');
      if (downedBlock) downedBlock.style.display = st.downed ? '' : 'none';
    }
    card.querySelectorAll('.pkg-member').forEach(row => {
      const id = row.dataset.accId;
      if (!id) return;
      const cls = _homeIds.has(id) ? 'home' : (_launchedIds.has(id) ? 'running' : (_cookieStatus[id] === 'dead' ? 'dead' : 'idle'));
      row.className = 'pkg-member ' + cls;
      const lbl = _homeIds.has(id) ? t('accounts.home') : (_launchedIds.has(id) ? t('accounts.launched') : (_cookieStatus[id] === 'dead' ? t('accounts.expired') : t('accounts.notLaunched')));
      const stEl = row.querySelector('.pkg-member-st');
      if (stEl) stEl.textContent = lbl;
    });
  });
}

// Small pill with the account's category, shown under the user ID on its card.
function _catTagHtml(a) {
  const c = categories.find(x => x.id === a.categoryId);
  if (!c) return '';
  const col = c.color || catColor(c.id);
  return `<div class="card-cat" style="--cc:${col}"><span class="cat-dot" style="background:${col}"></span>${esc(c.name)}</div>`;
}

function render() {
  const grid = document.getElementById('grid'), empty = document.getElementById('empty'), sub = document.getElementById('acct-sub');
  const savedTxt = accounts.length ? t('accounts.savedCount', { n: accounts.length, s: accounts.length !== 1 ? 's' : '' }) : t('accounts.none');
  sub.textContent = savedTxt;
  const savedCount = document.getElementById('sb-saved-count');
  if (savedCount) savedCount.textContent = savedTxt;
  const savedTime = document.getElementById('sb-saved-time'); if (savedTime) savedTime.textContent = t('nav.savedTime');
  if (!accounts.length) { grid.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  const list = visibleAccounts();
  grid.classList.toggle('list-view', _acctView === 'list');
  grid.classList.toggle('compact-view', _acctView === 'compact');
  if (!list.length) {
    grid.classList.remove('list-view');
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12.5px;padding:40px 0">' + esc(t('accounts.noMatch')) + '</div>';
    return;
  }
  grid.innerHTML = list.map((a, i) => `
    <div class="card${_launchedIds.has(a.id) ? ' is-live' : ''}${_homeIds.has(a.id) ? ' is-home' : ''}${_cookieStatus[a.id] === 'dead' ? ' cookie-dead' : ''}${_selectMode && _selectedIds.has(a.id) ? ' is-selected' : ''}${_selectMode ? ' select-mode' : ''}" data-id="${a.id}" style="animation-delay:${i * 18}ms" onclick="${_selectMode ? `if(!event.target.closest('button'))toggleSelectCard('${a.id}')` : ''}">
      ${_selectMode ? `<div class="card-check${_selectedIds.has(a.id) ? ' checked' : ''}" onclick="event.stopPropagation();toggleSelectCard('${a.id}')"><span class="material-icons-round">check</span></div>` : ''}
      <div class="card-dot${_launchedIds.has(a.id) ? ' launched' : ''}${_homeIds.has(a.id) ? ' home' : ''}" title="${_homeIds.has(a.id) ? esc(t('accounts.home')) : (_launchedIds.has(a.id) ? esc(t('accounts.launched')) : esc(t('accounts.notLaunched')))}"></div>
      <span class="material-icons-round drag-handle">drag_indicator</span>
      <div class="card-av" id="av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</div>
      <div class="card-id">
        <div class="card-name-row">
          <div class="card-name" ondblclick="inlineEditNickname('${a.id}', this)" title="${esc(t('accounts.renameTip'))}">${esc(a.nickname || a.username || 'Unknown')}<span class="card-name-edit"><span class="material-icons-round">edit</span></span></div>
          <span class="card-expired" title="${esc(t('accounts.expiredTip'))}"><span class="material-icons-round">error_outline</span>${esc(t('accounts.expired'))}</span>
        </div>
        <div class="card-uid">${a.userId ? 'ID ' + a.userId : esc(t('accounts.noId'))}</div>
        ${_launchedIds.has(a.id) && _launchedAt[a.id] ? `<div class="card-up">${esc(fmtUptime(_launchedAt[a.id]))}</div>` : ''}
        ${_homeIds.has(a.id) ? `<div class="card-home-badge">${esc(t('accounts.home'))}</div>` : ''}
        ${_catTagHtml(a)}
      </div>
      <div class="card-game ${a.gameTarget ? 'visible' : ''}" id="gt-${a.id}" title="${esc(a.gameTarget || '')}">${a.gameTarget ? esc(truncate(_gameNameCache[a.id] || extractTargetLabel(a.gameTarget), 22)) : ''}</div>
      <div class="card-row">
        <button class="btn btn-launch" onclick="openLaunch('${a.id}')" title="${esc(t('launch.start'))}" aria-label="${esc(t('launch.start'))}">
          <span class="material-icons-round" style="font-size:15px">play_arrow</span>
        </button>
        ${/^\d+/.test(String(a.gameTarget || '').split(/[:,]/)[0]) ? `<button class="btn btn-edit" onclick="openServerList(${parseInt(String(a.gameTarget).split(/[:,]/)[0], 10)}, { accountId: '${a.id}', placeId: ${parseInt(String(a.gameTarget).split(/[:,]/)[0], 10)} })" title="${esc(t('srv.title'))}" aria-label="Server list">
          <span class="material-icons-round">dns</span>
        </button>` : ''}
        <button class="btn btn-edit" onclick="openEdit('${a.id}')" aria-label="Edit account">
          <span class="material-icons-round">edit</span>
        </button>
        <button class="btn btn-del" onclick="removeAcc('${a.id}')" aria-label="Remove account">
          <span class="material-icons-round">delete_outline</span>
        </button>
      </div>
    </div>`).join('') + `<div class="card-add" onclick="openLogin()"><span class="material-icons-round card-add-icon">add</span><span class="card-add-label">Add account</span></div>`;
  loadAvatarsBatch(list);
  list.forEach(a => { if (a.gameTarget && !_gameNameCache[a.id]) fetchGameName(a.id, a.gameTarget); });
  checkCookieHealth(list);
  document.querySelectorAll('.card[data-id]').forEach(card => {
    card.addEventListener('contextmenu', e => { e.preventDefault(); showCardMenu(card.dataset.id, e.clientX, e.clientY); });
  });
  initDrag();
  renderDashboard();
}

// ── Multi-select & batch actions ─────────────────────────────────────────
let _selectMode = false;
const _selectedIds = new Set();

function toggleSelectMode() {
  _selectMode = !_selectMode;
  _selectedIds.clear();
  const btn = document.getElementById('acct-select-btn');
  if (btn) btn.classList.toggle('on', _selectMode);
  updateBatchBar();
  render();
}
function toggleSelectCard(id) {
  if (!_selectMode) return;
  if (_selectedIds.has(id)) _selectedIds.delete(id); else _selectedIds.add(id);
  updateBatchBar();
  render();
}
function clearSelection() {
  if (_selectMode) { _selectMode = false; document.getElementById('acct-select-btn')?.classList.remove('on'); }
  _selectedIds.clear();
  updateBatchBar();
  render();
}
function updateBatchBar() {
  const bar = document.getElementById('batch-bar');
  const count = document.getElementById('batch-count');
  if (!bar) return;
  const n = _selectedIds.size;
  bar.style.display = _selectMode ? 'flex' : 'none';
  if (count) count.textContent = n + ' ' + t('batch.selected');
}
async function batchKill() {
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  let ok = 0;
  for (const id of ids) {
    const res = await api.killOneRoblox(id).catch(() => null);
    if (res && res.ok) ok++;
  }
  toast(t('batch.killedN', { ok, total: ids.length }), ok === ids.length ? 'ok' : 'err');
  clearSelection();
}
async function batchTrim() {
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  let ok = 0;
  for (const id of ids) {
    const res = await api.trimAccountMemory(id).catch(() => null);
    if (res && res.ok) ok++;
  }
  toast(t('batch.trimmedN', { ok, total: ids.length }), ok === ids.length ? 'ok' : 'err');
  clearSelection();
}
function batchToGroup() {
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  openCreatePackage();
  const picker = document.getElementById('pkg-account-picker');
  if (picker) {
    picker.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = ids.includes(c.value); });
    updatePkgCount();
    renderPkgOrder();
  }
  clearSelection();
}
function toggleBatchCats(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('batch-cat-menu');
  if (!menu) return;
  menu.innerHTML = '<div class="filter-menu-label">' + esc(t('accounts.category')) + '</div>' +
    '<button data-f="" onclick="batchSetCategory(\'\')">' + esc(t('accounts.noCategory')) + '</button>' +
    categories.map(c => `<button data-f="${c.id}" onclick="batchSetCategory('${c.id}')"><span class="cat-dot" style="background:${c.color || catColor(c.id)}"></span>${esc(c.name)}</button>`).join('');
  menu.classList.toggle('open');
}
async function batchSetCategory(catId) {
  document.getElementById('batch-cat-menu')?.classList.remove('open');
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  for (const id of ids) {
    const a = accounts.find(x => x.id === id);
    if (!a) continue;
    a.categoryId = catId || null;
    await api.updateAccount(id, { categoryId: catId || null }).catch(() => {});
  }
  render();
  toast(t('batch.categorySet', { n: ids.length }), 'ok');
  clearSelection();
}

// Double-click the card nickname (or the pencil icon) to rename it inline.
function inlineEditNickname(id, el) {
  if (!el || el.dataset.editing) return;
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  el.dataset.editing = '1';
  const current = a.nickname || a.username || '';
  const input = document.createElement('input');
  input.className = 'card-name-input';
  input.value = current;
  input.maxLength = 32;
  input.spellcheck = false;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const val = input.value.trim();
    if (save && val !== current) {
      try {
        await api.updateAccount(id, { nickname: val });
        a.nickname = val;
        toast(val ? t('acct.nickSaved') : t('acct.nickCleared'), 'ok');
      } catch (e) { toast(t('common.failed', { msg: e.message }), 'err'); }
    }
    render();
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// ── Dashboard activity feed ──────────────────────────────────────────────
const _activityFeed = [];
function pushActivity(icon, tone, text) {
  _activityFeed.unshift({ icon, tone, text, ts: Date.now() });
  if (_activityFeed.length > 20) _activityFeed.length = 20;
  const actEl = document.getElementById('dash-activity');
  if (actEl) renderActivity(actEl);
}
function _actTime(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t('dash.agoSec', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('dash.agoMin', { n: m });
  const h = Math.round(m / 60);
  return t('dash.agoHour', { n: h });
}
function renderActivity(actEl) {
  const feedHtml = _activityFeed.length
    ? `<div class="dash-feed">` + _activityFeed.map(a =>
        `<div class="dash-feed-row"><span class="dash-ic ${a.tone}" style="width:22px;height:22px;font-size:12px"><span class="material-icons-round" style="font-size:13px">${a.icon}</span></span>` +
        `<span class="dash-feed-text">${a.text}</span><span class="dash-feed-time">${esc(_actTime(a.ts))}</span></div>`).join('') + `</div>`
    : `<div class="dash-empty"><span class="material-icons-round">bolt</span>${esc(t('dash.noActivity'))}</div>`;
  const last = settings.lastBackupAt ? _fmtBackupTime(settings.lastBackupAt) : t('dash.never');
  actEl.innerHTML = feedHtml +
    _dashRow('', 'archive', t('dash.lastBackup'), esc(last), "openBackupModal('create')") +
    '<div class="dash-actions">' +
    '<button class="btn btn-ghost" onclick="openBackupModal(\'create\')"><span class="material-icons-round" style="font-size:15px">archive</span>' + esc(t('dash.createBackup')) + '</button>' +
    '<button class="btn btn-ghost" onclick="openLogin()"><span class="material-icons-round" style="font-size:15px">person_add</span>' + esc(t('dash.addAccount')) + '</button>' +
    '<button class="btn btn-ghost" onclick="openCreatePackage()"><span class="material-icons-round" style="font-size:15px">create_new_folder</span>' + esc(t('dash.newGroup')) + '</button>' +
    '</div>';
}
function _acctLabel(id) {
  const a = accounts.find(x => x.id === id);
  return a ? (a.nickname || a.username || id) : id;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
// All numbers below come from state the app already holds (accounts, packages,
// categories, launch tracking, cookie checks) or from backend calls already
// being polled -- nothing is invented. Each card/row navigates to the exact
// screen that shows that information.
function _dashRunning() { return _launchedIds.size; }
function _dashExpired() {
  let n = 0;
  for (const a of accounts) if (_cookieStatus[a.id] === 'dead' || a._cookieInvalid) n++;
  return n;
}
function _dashStat(icon, tone, num, label, nav) {
  return `<button class="dash-card" onclick="${nav}"><span class="dash-ic ${tone}"><span class="material-icons-round">${icon}</span></span>` +
    `<span class="dash-num">${num}</span><span class="dash-lbl">${esc(label)}</span></button>`;
}
function _dashRow(iconCls, icon, name, val, nav) {
  return `<button class="dash-row ${iconCls}" onclick="${nav}"><span class="material-icons-round">${icon}</span>` +
    `<span class="dash-row-name">${esc(name)}</span><span class="dash-row-val">${val}</span></button>`;
}
function _fmtBackupTime(ts) {
  try { return new Date(ts).toLocaleString(_lang === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return String(ts); }
}
function renderDashboard() {
  const page = document.getElementById('page-dashboard');
  if (!page) return;
  const running = _dashRunning();
  const statsEl = document.getElementById('dash-stats');
  if (statsEl) {
    statsEl.innerHTML = [
      _dashStat('manage_accounts', 'ac', accounts.length, t('dash.total'), "goTo('accounts')"),
      _dashStat('rocket_launch', 'green', running, t('dash.running'), "goTo('accounts');setAcctFilter('running')"),
      _dashStat('pause_circle_outline', 'muted', Math.max(0, accounts.length - running), t('dash.offline'), "goTo('accounts');setAcctFilter('idle')"),
      _dashStat('videogame_asset', 'cyan', _mixRunning, t('dash.instances'), "goTo('mixer')"),
      _dashStat('label', 'purple', categories.length, t('dash.categories'), 'openCategories()'),
      _dashStat('label_off', 'amber', accounts.filter(a => !a.categoryId).length, t('dash.noCategory'), "goTo('accounts');setAcctFilter('nocat')"),
      _dashStat('inventory_2', 'blue', packages.length, t('dash.groups'), "goTo('packages')"),
      _dashStat('delete', 'red', trashedAccounts.length, t('dash.trash'), 'openTrash()'),
    ].join('');
  }
  const sub = document.getElementById('dash-sub');
  if (sub) sub.textContent = t('dash.summary', { total: accounts.length, running: running, cats: categories.length });
  const alertsEl = document.getElementById('dash-alerts');
  if (alertsEl) {
    const expired = _dashExpired(), trash = trashedAccounts.length;
    const rows = [];
    if (expired) rows.push(_dashRow('red', 'error_outline', t('dash.expiredCookies', { n: expired, s: expired !== 1 ? 's' : '' }), expired, "goTo('accounts');setAcctFilter('invalid-first')"));
    if (trash) rows.push(_dashRow('amber', 'delete', t('dash.accountsInTrash', { n: trash, s: trash !== 1 ? 's' : '' }), trash, 'openTrash()'));
    alertsEl.innerHTML = rows.length ? rows.join('') : '<div class="dash-empty"><span class="material-icons-round">check_circle</span>' + esc(t('dash.noAlerts')) + '</div>';
  }
  const catsEl = document.getElementById('dash-cats');
  if (catsEl) {
    const rows = categories.map(c => {
      const n = accounts.filter(a => a.categoryId === c.id).length;
      return `<button class="dash-row" onclick="goTo('accounts');setAcctFilter('cat:${c.id}')">` +
        `<span class="cat-dot" style="background:${c.color || catColor(c.id)}"></span>` +
        `<span class="dash-row-name">${esc(c.name)}</span><span class="dash-row-val">${n}</span></button>`;
    });
    const nocat = accounts.filter(a => !a.categoryId).length;
    if (rows.length || nocat) {
      if (rows.length) rows.push(_dashRow('', 'label_off', t('dash.noCategory'), nocat, "goTo('accounts');setAcctFilter('nocat')"));
      catsEl.innerHTML = rows.join('');
    } else {
      catsEl.innerHTML = '<div class="dash-empty"><span class="material-icons-round">label</span>' + esc(t('dash.noCats')) + '</div>';
    }
  }
  const actEl = document.getElementById('dash-activity');
  if (actEl) renderActivity(actEl);
}

const _cookieStatus = {}; // id -> 'checking' | 'ok' | 'dead' | 'unknown'
function applyCookieStatus(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.classList.toggle('cookie-dead', _cookieStatus[id] === 'dead');
  renderDashboard();
}
// Surfaces a likely-expired cookie right after a launch auth failure, without
// waiting for the periodic health check. Only genuine auth/cookie errors
// flip the badge, not rate-limits or transient HTTP errors.
function _flagCookieMaybeDead(id, error) {
  if (id && error && /cookie|expired|\b403\b/i.test(error)) {
    _cookieStatus[id] = 'dead';
    applyCookieStatus(id);
  }
}
// Runs `worker` over `items` with at most `limit` in flight at once.
async function _runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

let _cookieCheckRunning = false;
async function checkCookieHealth(list) {
  if (_cookieCheckRunning) return;
  const todo = list.filter(a => a.cookie && _cookieStatus[a.id] === undefined);
  if (!todo.length) return;
  _cookieCheckRunning = true;
  try {
    await _runWithConcurrency(todo, 4, async (a) => {
      if (_cookieStatus[a.id] !== undefined) return;
      _cookieStatus[a.id] = 'checking';
      try {
        const res = await api.validateCookie(a.cookie);
        const st = (res && res.ok) ? 'ok' : 'dead';
        _cookieStatus[a.id] = st;
        if (st === 'dead') logEntry('warn', 'cookie', `Cookie invalid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
        else logEntry('info', 'cookie', `Cookie valid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
      } catch { _cookieStatus[a.id] = 'unknown'; logEntry('warn', 'cookie', `Cookie check failed for ${a.username || a.id}`, { accountId: a.id }); }
      applyCookieStatus(a.id);
    });
  } finally { _cookieCheckRunning = false; }
}

// Recheck ALL cookies every 60s so status stays live
let _recheckRunning = false;
const _cookieCheckedAt = {};            // id -> last validation epoch ms
const OK_RECHECK_MS = 5 * 60 * 1000;    // re-check known-good cookies at most every 5 min
async function recheckAllCookies(force) {
  if (_recheckRunning) return; // bail if a previous pass is still going
  _recheckRunning = true;
  // Flag before the first await so checkCookieHealth's render() pass doesn't race us.
  for (const a of accounts) if (a.cookie && _cookieStatus[a.id] === undefined) _cookieStatus[a.id] = 'checking';
  try {
  let changed = false;
  const now = Date.now();
  const todo = accounts.filter(a => {
    if (!a.cookie) return false;
    // Known-good cookies recheck every few minutes; dead/unknown ones every tick.
    if (!force && _cookieStatus[a.id] === 'ok' && _cookieCheckedAt[a.id] && (now - _cookieCheckedAt[a.id]) < OK_RECHECK_MS) return false;
    return true;
  });
  await _runWithConcurrency(todo, 4, async (a) => {
    const prev = _cookieStatus[a.id];
    _cookieStatus[a.id] = 'checking';
    try {
      const res = await api.validateCookie(a.cookie);
      _cookieCheckedAt[a.id] = Date.now();
      const next = (res && res.ok) ? 'ok' : 'dead';
      if (next !== prev) {
        _cookieStatus[a.id] = next;
        applyCookieStatus(a.id); // toggles .cookie-dead on the card (badge + ring)
        changed = true;
        if (next === 'dead') logEntry('warn', 'cookie', `Cookie expired for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
        else if (prev === 'dead' && next === 'ok') logEntry('ok', 'cookie', `Cookie re-validated for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
      } else {
        _cookieStatus[a.id] = next;
      }
    } catch { _cookieStatus[a.id] = prev || 'unknown'; }
  });
  if (changed) render(); // rebuild once at the end so the cards match
  } finally { _recheckRunning = false; }
}
setInterval(() => { if (accounts.length) recheckAllCookies(false); }, 60000);


const _gameNameCache = {}; // accountId -> resolved game name
let _gameNamePersist = {}; // target -> resolved name, persisted to localStorage
try { _gameNamePersist = JSON.parse(localStorage.getItem('mr-gamenames') || '{}'); } catch { _gameNamePersist = {}; }
function _saveGameNames() { try { localStorage.setItem('mr-gamenames', JSON.stringify(_gameNamePersist)); } catch {} }

function extractTargetLabel(target) {
  if (!target) return '';
  const t = target.trim();
  if (/^\d+$/.test(t)) return t;
  try {
    const u = new URL(t.startsWith('http') ? t : 'https://' + t);
    const parts = u.pathname.split('/').filter(Boolean);
    // extract linkCode or share code for private servers
    const name = (parts[2] || parts[1] || '').replace(/-/g, ' ').trim();
    return name || u.hostname;
  } catch { return truncate(target, 22); }
}

async function fetchGameName(accountId, target) {
  if (!target) return;
  const t = target.trim();
  // Persistent cache hit: skip the network entirely.
  if (_gameNamePersist[t]) {
    _gameNameCache[accountId] = _gameNamePersist[t];
    updateGameLabel(accountId);
    return;
  }
  // Find the account to get its cookie for authenticated requests
  const acct = accounts.find(a => a.id === accountId);
  const cookie = acct ? acct.cookie : null;
  let placeId = null;
  if (/^\d+$/.test(t)) {
    placeId = t;
  } else {
    try {
      const u = new URL(t.startsWith('http') ? t : 'https://' + t);
      const parts = u.pathname.split('/').filter(Boolean);
      // /games/<placeId>/... or /games/<placeId>
      if (parts[0] === 'games' && parts[1] && /^\d+$/.test(parts[1])) placeId = parts[1];
      if (!placeId) placeId = u.searchParams.get('placeId');
      // PlaceLauncher URLs: ?placeId=...
      if (!placeId) { const m = t.match(/[?&]placeId=(\d+)/); if (m) placeId = m[1]; }
    } catch {}
  }
  if (!cookie) {
    _gameNameCache[accountId] = extractTargetLabel(target);
    updateGameLabel(accountId);
    return;
  }
  // Fetch via main process (authenticated with cookie)
  const name = await api.getGameName(placeId || t, cookie);
  _gameNameCache[accountId] = name || extractTargetLabel(target);
  // Persist only genuine resolved names (not the raw fallback label).
  if (name) { _gameNamePersist[t] = name; _saveGameNames(); }
  updateGameLabel(accountId);
}

function updateGameLabel(accountId) {
  const el = document.getElementById('gt-' + accountId);
  if (!el) return;
  const a = accounts.find(x => x.id === accountId);
  if (!a || !a.gameTarget) return;
  el.textContent = truncate(_gameNameCache[accountId] || extractTargetLabel(a.gameTarget), 22);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '\u2026' : s; }

let _dragSaveTimer = null;
let _dragging = null, _dragClone = null, _dragOffX = 0, _dragOffY = 0, _dragOverId = null;

function initDrag() {
  const grid = document.getElementById('grid');

  grid.querySelectorAll('.card').forEach(card => {
    const handle = card.querySelector('.drag-handle');
    const startEl = handle || card;

    startEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      e.preventDefault();

      _dragging = card;
      const rect = card.getBoundingClientRect();
      _dragOffX = e.clientX - rect.left;
      _dragOffY = e.clientY - rect.top;

      // Create floating clone
      _dragClone = card.cloneNode(true);
      _dragClone.querySelectorAll('.card-kill, .drag-handle').forEach(el => el.remove());
      _dragClone.style.cssText = `
        position:fixed;left:${rect.left}px;top:${rect.top}px;
        width:${rect.width}px;height:${rect.height}px;
        opacity:0.85;pointer-events:none;z-index:9999;
        box-shadow:0 16px 40px rgba(0,0,0,.6);
        transform:scale(1.04);border-color:var(--ac);
        transition:box-shadow .15s;border-radius:var(--r);
        background:var(--s2);border:1px solid var(--ac);
      `;
      if (grid.classList.contains('list-view')) _dragClone.classList.add('drag-list-clone');
      document.body.appendChild(_dragClone);
      card.style.opacity = '0.3';

      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });
  });
}

function onDragMove(e) {
  if (!_dragging || !_dragClone || !_dragging.isConnected) return;
  _dragClone.style.left = (e.clientX - _dragOffX) + 'px';
  _dragClone.style.top  = (e.clientY - _dragOffY) + 'px';

  // nudge the scroll when the cursor gets near the top/bottom edge
  const wrap = document.querySelector('.grid-wrap');
  if (wrap) {
    const wr = wrap.getBoundingClientRect();
    if (e.clientY < wr.top + 60) wrap.scrollTop -= 16;
    else if (e.clientY > wr.bottom - 60) wrap.scrollTop += 16;
  }

  // Find the card under the cursor (the clone is hidden for the hit-test so it
  // never matches itself).
  _dragClone.style.display = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  _dragClone.style.display = '';
  const target = el ? el.closest('.card[data-id]') : null;
  if (!target || target === _dragging) return;
  const newId = target.dataset.id;
  if (newId === _dragOverId) return; // already settled against this neighbour
  _dragOverId = newId;

  // Move the dragged node in place instead of a full re-render.
  const grid = document.getElementById('grid');
  const cards = Array.from(grid.querySelectorAll('.card[data-id]'));
  const srcPos = cards.indexOf(_dragging);
  const tgtPos = cards.indexOf(target);
  if (srcPos < 0 || tgtPos < 0) return;
  grid.insertBefore(_dragging, srcPos < tgtPos ? target.nextSibling : target);
  _syncAccountsOrderFromDom();
}

// Reorders `accounts` to match the on-screen card order; accounts hidden by
// an active search/filter keep their positions.
function _syncAccountsOrderFromDom() {
  const grid = document.getElementById('grid');
  const visIds = Array.from(grid.querySelectorAll('.card[data-id]')).map(c => c.dataset.id);
  const visSet = new Set(visIds);
  const byId = new Map(accounts.filter(a => visSet.has(a.id)).map(a => [a.id, a]));
  const queue = visIds.map(id => byId.get(id)).filter(Boolean);
  let qi = 0;
  accounts = accounts.map(a => (visSet.has(a.id) ? queue[qi++] : a));
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (_dragClone) { _dragClone.remove(); _dragClone = null; }
  if (_dragging) { _dragging.style.opacity = ''; _dragging = null; }
  _dragOverId = null;

  // settle the DOM and rebind the drag handlers with one render
  render();

  clearTimeout(_dragSaveTimer);
  _dragSaveTimer = setTimeout(() => {
    api.reorderAccounts(accounts.map(a => a.id));
  }, 400);
}

function loadAvatar(id, uid) {
  if (_avatarCache[uid]) {
    paintAccountAvatar(id, uid, _avatarCache[uid]);
    return;
  }
  api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + uid + '&size=48x48&format=Png')
    .then(res => res.data).then(d => {
      const url = d?.data?.[0]?.imageUrl;
      if (url) {
        _avatarCache[uid] = url;
        paintAccountAvatar(id, uid, url);
      }
    }).catch(() => {});
}

function paintAccountAvatar(id, uid, url) {
  ['av-' + id, 'pkg-picker-av-' + id, 'tracking-av-' + id].forEach(elId => {
    const el = document.getElementById(elId);
    if (el && !el.querySelector('img')) el.innerHTML = '<img src="' + esc(url) + '" alt=""/>';
  });
}

// One batched request for uncached accounts instead of one per account.
async function loadAvatarsBatch(list) {
  const paint = a => {
    if (a.userId && _avatarCache[a.userId]) {
      paintAccountAvatar(a.id, a.userId, _avatarCache[a.userId]);
    }
  };
  const need = [], seen = new Set();
  for (const a of list) {
    if (!a.userId) continue;
    if (_avatarCache[a.userId]) { paint(a); continue; }
    if (!seen.has(a.userId)) { seen.add(a.userId); need.push(a.userId); }
  }
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    try {
      const res = await api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + chunk.join(',') + '&size=48x48&format=Png');
      const d = res.data;
      (d?.data || []).forEach(item => { if (item && item.targetId && item.imageUrl) _avatarCache[item.targetId] = item.imageUrl; });
      list.forEach(paint);
    } catch {
      chunk.forEach(uid => { const a = list.find(x => x.userId === uid); if (a) loadAvatar(a.id, uid); });
    }
  }
}

function loadPkgAvatar(pkgId, accountId, uid, attempt) {
  const elId = 'pkg-av-' + pkgId + '-' + accountId;
  const paint = url => {
    _avatarCache[uid] = url;
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '<img src="' + esc(url) + '" alt=""/><span class="pkg-avatar-dot"></span>';
  };
  if (_avatarCache[uid]) { paint(_avatarCache[uid]); return; }
  api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + uid + '&size=48x48&format=Png')
    .then(res => res.data).then(d => {
      const item = d?.data?.[0];
      if (item && item.imageUrl && item.state === 'Completed') { paint(item.imageUrl); return; }
      // Roblox returns Pending while it generates the thumbnail; retry briefly.
      if (item && item.state === 'Pending' && (attempt || 0) < 3) {
        setTimeout(() => loadPkgAvatar(pkgId, accountId, uid, (attempt || 0) + 1), 1500);
      } else if (item && item.imageUrl) { paint(item.imageUrl); }
    }).catch(() => {});
}

// ── Avatar hover card ───────────────────────────────────────────────────────
const _userInfoCache = {};
function loadUserInfo(uid, cb) {
  if (_userInfoCache[uid]) { cb(_userInfoCache[uid]); return; }
  api.robloxGet('https://users.roblox.com/v1/users/' + uid)
    .then(res => res.data).then(d => { _userInfoCache[uid] = d; cb(d); })
    .catch(() => cb(null));
}

function positionAvTip(av, tip) {
  const rect = av.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = rect.top - th - 10;
  if (top < 8) top = rect.bottom + 10;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function showAvTip(av) {
  const uid = av.dataset.uid || '';
  const uname = av.dataset.uname || '';
  const nick = av.dataset.nick || '';
  const tip = document.getElementById('av-tip');
  tip.dataset.uid = uid;
  document.getElementById('av-tip-name').textContent = nick && nick !== uname ? nick : (uname || 'Unknown');
  document.getElementById('av-tip-uname').textContent = uname ? '@' + uname : (uid ? 'ID ' + uid : '');
  const avEl = document.getElementById('av-tip-av');
  avEl.innerHTML = _avatarCache[uid] ? '<img src="' + _avatarCache[uid] + '" alt=""/>' : (uname || '?')[0].toUpperCase();
  document.getElementById('av-tip-created').textContent = uid ? 'Loading\u2026' : 'Unknown';
  tip.classList.add('show');
  positionAvTip(av, tip);
  if (uid) {
    loadUserInfo(uid, info => {
      if (tip.dataset.uid !== uid || !tip.classList.contains('show')) return;
      const createdEl = document.getElementById('av-tip-created');
      if (info && info.created) {
        const d = new Date(info.created);
        createdEl.textContent = 'Created ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } else {
        createdEl.textContent = 'Unknown';
      }
      positionAvTip(av, tip);
    });
  }
}

function hideAvTip() {
  document.getElementById('av-tip').classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av) showAvTip(av);
});
document.addEventListener('mouseout', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av && !(e.relatedTarget && av.contains(e.relatedTarget))) hideAvTip();
});
window.addEventListener('scroll', hideAvTip, true);

function _showPanel(panel) {
  ['choose','cookie','browser'].forEach(p => {
    document.getElementById('login-panel-' + p).style.display = p === panel ? '' : 'none';
  });
  document.getElementById('btn-cookie-add').style.display = panel === 'cookie' ? '' : 'none';
  document.getElementById('btn-login-back').style.display = panel === 'choose' ? 'none' : '';
  setStatus('login-status', 'hidden', '');
}

function openLogin() {
  document.getElementById('cookie-input').value = '';
  _showPanel('choose');
  openModal('m-login');
}

function showCookiePanel() {
  _showPanel('cookie');
  setTimeout(() => document.getElementById('cookie-input').focus(), 50);
}

function backToChoose() {
  _showPanel('choose');
}

async function startBrowserLogin() {
  _showPanel('browser');
  // Show waiting state by default - only switch to download UI if Chrome needs to be downloaded
  document.getElementById('login-dl').style.display = 'none';
  document.getElementById('login-waiting').style.display = '';
  document.getElementById('dl-bar').style.width = '0%';
  document.getElementById('dl-pct').textContent = '0%';
  const res = await api.openLogin();
  if (!document.getElementById('m-login').classList.contains('open')) return;
  if (!res || !res.success) {
    if (res && res.error && res.error !== 'Login window closed') {
      _showPanel('choose');
      setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(res.error));
    } else {
      closeModal('m-login');
    }
    return;
  }
  await finishLogin(res);
}

async function addByCookie() {
  let cookie = document.getElementById('cookie-input').value.trim();
  if (!cookie) return;
  // Strip any prefix the user may have accidentally included
  if (cookie.startsWith('.ROBLOSECURITY=')) cookie = cookie.slice('.ROBLOSECURITY='.length);
  if (cookie.startsWith('ROBLOSECURITY=')) cookie = cookie.slice('ROBLOSECURITY='.length);
  // Remove any surrounding quotes
  cookie = cookie.replace(/^["']|["']$/g, '').trim();
  if (!cookie || cookie.length < 100) {
    setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(t('login.cookieShort')));
    return;
  }
  const btn = document.getElementById('btn-cookie-add');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin"></div>' + esc(t('login.verifyCookie'));
  setStatus('login-status', 'load', '<div class="spin"></div>' + esc(t('login.verifyCookie')));
  const res = await api.validateCookie(cookie);
  btn.disabled = false;
  btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">check</span>' + esc(t('login.addAccount'));
  if (!res.ok) {
    setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + (res.reason || t('login.err')));
    return;
  }
  await finishLogin({ success: true, cookie, username: res.username, userId: res.userId });
}

function cancelLogin() {
  closeModal('m-login');
  api.cancelLogin && api.cancelLogin();
}

async function finishLogin(res) {
  setStatus('login-status', 'ok', '<span class="material-icons-round">check_circle</span>' + esc(t('login.signedIn', { user: res.username })));
  const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: res.cookie, gameTarget: '' });
  accounts.push(a); render();
  setTimeout(() => {
    closeModal('m-login');
    toast(t('login.added', { user: res.username }), 'ok');
    const grid = document.getElementById('grid');
    if (grid) grid.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 800);
}

function openEdit(id) {
  editAcc = accounts.find(a => a.id === id); if (!editAcc) return;
  document.getElementById('edit-title').textContent = 'Edit account';
  document.getElementById('edit-head-name').textContent = editAcc.username || 'Unknown';
  document.getElementById('edit-head-meta').textContent =
    (editAcc.username ? '@' + editAcc.username : '') +
    (editAcc.userId ? (editAcc.username ? ' · ' : '') + 'ID ' + editAcc.userId : '');
  // Letter fallback first, then swap in the cached headshot if we have one.
  const av = document.getElementById('edit-av');
  av.innerHTML = esc((editAcc.username || '?')[0].toUpperCase());
  if (editAcc.userId && _avatarCache[editAcc.userId]) {
    av.innerHTML = '<img src="' + esc(_avatarCache[editAcc.userId]) + '" alt=""/>';
  }
  document.getElementById('in-nickname').value = editAcc.nickname || '';
  document.getElementById('in-description').value = editAcc.description || '';
  closeAllCdd();
  renderCategorySelector(editAcc.categoryId || '');
  const refreshBtn = document.getElementById('edit-refresh-btn');
  if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.innerHTML = '<span class="material-icons-round" style="font-size:15px">refresh</span>Refresh from Roblox'; }
  document.getElementById('in-target').value = editAcc.gameTarget || '';
  document.getElementById('in-password').value = editAcc.password || '';
  // Reset follow field/status -- it's a lookup tool, not a saved value.
  document.getElementById('in-follow').value = '';
  followSetStatus(t('edit.followHint'), '');
  openModal('m-edit');
  setTimeout(() => document.getElementById('in-nickname').focus(), 220);
}

function followSetStatus(msg, kind) {
  const el = document.getElementById('follow-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === 'err' ? 'var(--red)' : (kind === 'ok' ? 'var(--green)' : '');
}

// Uses this account's own cookie for the lookup -- presence/username APIs both
// need an authenticated session, and the account being edited is the one that
// would do the joining anyway.
async function followUserLookup() {
  const input = document.getElementById('in-follow');
  const btn = document.getElementById('follow-btn');
  const label = btn ? btn.querySelector('span:last-child') : null;
  const username = (input.value || '').trim();
  if (!username) { followSetStatus('Enter a username', 'err'); return; }
  if (!editAcc || !editAcc.cookie) { followSetStatus('This account has no saved cookie', 'err'); return; }

  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Finding';
  followSetStatus('Looking up ' + username + '...', '');
  try {
    const res = await api.followUser(editAcc.cookie, username);
    document.getElementById('in-target').value = res.target;
    followSetStatus('Found ' + res.username + " -- target set, click Save to keep it.", 'ok');
  } catch (e) {
    followSetStatus(typeof e === 'string' ? e : (e.message || 'Lookup failed'), 'err');
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.textContent = 'Find';
  }
}

function togglePassVis() {
  const inp = document.getElementById('in-password');
  const icon = document.getElementById('pass-vis-icon');
  if (!inp || !icon) return;
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  icon.textContent = isPass ? 'visibility' : 'visibility_off';
}

async function saveEdit() {
  if (!editAcc) return;
  const target = document.getElementById('in-target').value.trim();
  const nickname = document.getElementById('in-nickname').value.trim();
  const description = document.getElementById('in-description').value.trim();
  const password = document.getElementById('in-password').value;
  const categoryId = _editCatId || null;
  const updated = await api.updateAccount(editAcc.id, { gameTarget: target, nickname, description, categoryId, password });
  if (updated) {
    const idx = accounts.findIndex(a => a.id === editAcc.id);
    if (idx !== -1) {
      accounts[idx] = updated;
      delete _gameNameCache[editAcc.id]; // clear stale name
      render();
      if (target) fetchGameName(editAcc.id, target); // fetch new name immediately
    } else { render(); }
  }
  closeModal('m-edit');
  toast(t('common.saved'), 'ok');
}

// Re-fetches username + user ID from the account's saved cookie and updates
// the record in place, so renamed/merged accounts keep their card accurate.
async function refreshEditFromRoblox() {
  if (!editAcc) return;
  const btn = document.getElementById('edit-refresh-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Refreshing'; }
  try {
    const res = await api.validateCookie(editAcc.cookie);
    if (!res || !res.ok) { toast(res?.reason || 'Cookie is invalid or could not be verified', 'err'); return; }
    const updated = await api.updateAccount(editAcc.id, { username: res.username, userId: res.userId });
    if (updated) {
      const idx = accounts.findIndex(a => a.id === editAcc.id);
      if (idx !== -1) accounts[idx] = updated;
      editAcc = updated;
      document.getElementById('edit-head-name').textContent = updated.username || 'Unknown';
      document.getElementById('edit-head-meta').textContent =
        (updated.username ? '@' + updated.username : '') +
        (updated.userId ? (updated.username ? ' · ' : '') + 'ID ' + updated.userId : '');
      toast(t('acct.refreshed'), 'ok');
    }
  } catch (e) {
    toast(e?.message || 'Could not refresh account data', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">refresh</span>Refresh from Roblox'; }
  }
}

function confirmAction(message, onConfirm) {
  document.getElementById('m-confirm-delete-msg').textContent = message;
  const btn = document.getElementById('m-confirm-delete-btn');
  const newBtn = btn.cloneNode(true); // clone to remove old listeners
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => { closeModal('m-confirm-delete'); onConfirm(); });
  // All overlays share the same z-index, so equal-z stacking falls back to
  // DOM order -- moving this to the end of <body> guarantees it renders on
  // top even when triggered from inside another already-open modal (e.g.
  // "Clear data" on the encryption lock screen), instead of silently
  // rendering underneath it.
  document.body.appendChild(document.getElementById('m-confirm-delete'));
  openModal('m-confirm-delete');
}

async function removeAcc(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  confirmAction(t('trash.moveConfirm', { name: a.username }), async () => {
    await api.removeAccount(id);
    accounts = accounts.filter(x => x.id !== id);
    a.trashed = true;
    trashedAccounts.unshift(a);
    render();
    updateTrashBadge();
    if (packages.some(p => p.accountIds.includes(id))) {
      packages.forEach(p => { p.accountIds = p.accountIds.filter(aid => aid !== id); });
      api.savePackages(packages);
      renderPackages();
    }
    forgetTrackingAccount(id);
    toast(t('trash.moved', { name: a.username }), 'err');
  });
}
async function clearAll() {
  if (!accounts.length) return;
  const genCount = _genHistory.length;
  const msg = 'Remove all ' + accounts.length + ' account' + (accounts.length === 1 ? '' : 's')
    + (genCount ? ' and ' + genCount + ' generated account' + (genCount === 1 ? '' : 's') + ' from the generator history' : '')
    + '? This cannot be undone.';
  confirmAction(msg, async () => {
    // "Clear all accounts" keeps its hard-delete meaning (it's the full wipe
    // action), so purge instead of soft-deleting -- and empties the trash too.
    for (const a of accounts) { await api.purgeAccount(a.id); forgetTrackingAccount(a.id); }
    accounts = [];
    if (trashedAccounts.length) { await api.emptyTrash(); trashedAccounts = []; }
    updateTrashBadge();
    render(); document.getElementById('stat-count').textContent = '0';
    packages.forEach(p => { p.accountIds = []; });
    api.savePackages(packages);
    renderPackages();
    // The generator history holds usernames, passwords and cookies of its own,
    // so "remove all saved accounts and sign-in data" has to take it too --
    // otherwise the most sensitive records survive the wipe.
    if (genCount) {
      _genHistory = [];
      _lastGenData = null;
      genRenderHistory();
      try { await api.clearGenHistory(); } catch {}
    }
    toast(t('acct.allCleared'), 'err');
  });
}

// ── Trash (soft-deleted accounts) ──────────────────────────────────────────
function updateTrashBadge() {
  const el = document.getElementById('trash-count');
  if (!el) return;
  el.textContent = trashedAccounts.length;
  el.style.display = trashedAccounts.length ? '' : 'none';
  const btn = document.getElementById('btn-trash');
  if (btn) btn.classList.toggle('has-trash', trashedAccounts.length > 0);
  renderDashboard();
}

function openTrash() {
  renderTrash();
  openModal('m-trash');
}

function renderTrash() {
  const list = document.getElementById('trash-list');
  if (!list) return;
  const total = document.getElementById('trash-total');
  if (total) total.textContent = t('trash.total', { n: trashedAccounts.length, s: trashedAccounts.length !== 1 ? 's' : '' });
  const emptyBtn = document.getElementById('trash-empty-btn');
  if (emptyBtn) emptyBtn.style.display = trashedAccounts.length ? '' : 'none';
  if (!trashedAccounts.length) {
    list.innerHTML = '<div class="trash-empty"><span class="material-icons-round">delete_sweep</span>' + esc(t('trash.none')) + '</div>';
    return;
  }
  list.innerHTML = trashedAccounts.map(a => `
    <div class="trash-row">
      <span class="pm-av" id="trash-av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</span>
      <span class="trash-info">
        <span class="trash-name">${esc(a.nickname || a.username || 'Unknown')}</span>
        <span class="trash-meta">${a.userId ? 'ID ' + a.userId : esc(t('accounts.noId'))}${a.trashedAt ? ' · ' + new Date(a.trashedAt).toLocaleDateString() : ''}</span>
      </span>
      <button class="btn btn-ghost" onclick="trashRestore('${a.id}')" title="${esc(t('trash.restore'))}"><span class="material-icons-round" style="font-size:15px">restore</span></button>
      <button class="btn btn-del" onclick="trashPurge('${a.id}')" title="${esc(t('trash.purge'))}"><span class="material-icons-round" style="font-size:15px">delete_forever</span></button>
    </div>`).join('');
  loadAvatarsBatch(trashedAccounts);
}

async function trashRestore(id) {
  const res = await api.restoreAccount(id);
  if (!res) return;
  const a = trashedAccounts.find(x => x.id === id);
  if (a) {
    trashedAccounts = trashedAccounts.filter(x => x.id !== id);
    a.trashed = false;
    accounts.push(a);
  }
  render();
  renderTrash();
  updateTrashBadge();
  toast(t('trash.restored', { name: a ? (a.nickname || a.username) : '' }), 'ok');
}

function trashPurge(id) {
  const a = trashedAccounts.find(x => x.id === id);
  confirmAction(t('trash.purgeConfirm', { name: (a ? (a.nickname || a.username) : '') || t('trash.thisAccount') }), async () => {
    await api.purgeAccount(id);
    trashedAccounts = trashedAccounts.filter(x => x.id !== id);
    renderTrash();
    updateTrashBadge();
    toast(t('trash.purged'), 'err');
  });
}

function trashEmpty() {
  if (!trashedAccounts.length) return;
  confirmAction(t('trash.emptyConfirm', { n: trashedAccounts.length, s: trashedAccounts.length === 1 ? '' : 's' }), async () => {
    await api.emptyTrash();
    trashedAccounts = [];
    renderTrash();
    updateTrashBadge();
    toast(t('trash.emptied'), 'err');
  });
}

// ── Categories ─────────────────────────────────────────────────────────────
const CAT_COLORS = ['#5c5ce0', '#2dd4bf', '#f59e0b', '#f43f5e', '#38bdf8', '#a855f7', '#4ade80', '#fb7185'];
function catColor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAT_COLORS[h % CAT_COLORS.length];
}

// ── Category selector (edit modal) ─────────────────────────────────────────
// Replaces the old native <select> with the app's custom .cdd dropdown: color
// dot + name on the trigger, a search box when there are many categories, and
// a check mark on the selected row. Selection is tracked in _editCatId.
let _editCatId = '';

function renderCategorySelector(selectedId) {
  _editCatId = selectedId || '';
  const searchInput = document.getElementById('cat-search-input');
  if (searchInput) searchInput.value = '';
  const searchWrap = document.getElementById('cat-search-wrap');
  if (searchWrap) searchWrap.style.display = categories.length > 5 ? '' : 'none';
  renderCatOptions('', _editCatId);
  updateCatTrigger(_editCatId);
}

function renderCatOptions(q, selectedId) {
  const opts = document.getElementById('in-category-options');
  if (!opts) return;
  const list = categories.filter(c => !q || c.name.toLowerCase().includes(q));
  opts.innerHTML =
    `<div class="cat-opt${!selectedId ? ' selected' : ''}" onclick="catPick('')"><span class="cat-dot" style="background:var(--s4)"></span>${esc(t('edit.noCategory'))}<span class="material-icons-round cat-check">check</span></div>` +
    list.map(c => {
      const col = c.color || catColor(c.id);
      return `<div class="cat-opt${c.id === selectedId ? ' selected' : ''}" onclick="catPick('${c.id}')"><span class="cat-dot" style="background:${col}"></span>${esc(c.name)}<span class="material-icons-round cat-check">check</span></div>`;
    }).join('') +      (list.length === 0 ? '<div class="cat-opt cat-opt-empty">' + esc(t('cat.noMatch')) + '</div>' : '');
}

function catPick(id) {
  _editCatId = id;
  updateCatTrigger(id);
  const q = (document.getElementById('cat-search-input')?.value || '').trim().toLowerCase();
  renderCatOptions(q, id);
  closeAllCdd();
}

function updateCatTrigger(id) {
  const label = document.getElementById('in-category-label');
  const dot = document.getElementById('in-category-dot');
  if (!label) return;
  if (id) {
    const c = categories.find(x => x.id === id);
    if (c) { label.textContent = c.name; if (dot) dot.style.background = c.color || catColor(c.id); }
  } else {
    label.textContent = 'No category';
    if (dot) dot.style.background = 'var(--s4)';
  }
}

function catSearchInput(v) {
  renderCatOptions((v || '').trim().toLowerCase(), _editCatId);
}

function catTriggerKey(e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCdd('in-category'); }
  else if (e.key === 'Escape') closeAllCdd();
  else if (e.key === 'ArrowDown') {
    e.preventDefault();
    const m = document.getElementById('cdd-in-category-menu');
    if (m && !m.classList.contains('open')) toggleCdd('in-category');
  }
}

function openCategories() {
  closeAllCdd();
  const fm = document.getElementById('filter-menu');
  if (fm) fm.classList.remove('open');
  renderCategories();
  openModal('m-categories');
  setTimeout(() => document.getElementById('cat-new-name')?.focus(), 60);
}

function renderCategories() {
  const list = document.getElementById('cat-list');
  if (!list) return;
  if (!categories.length) {
    list.innerHTML = '<div class="trash-empty"><span class="material-icons-round">label</span>' + esc(t('cat.none')) + '</div>';
    return;
  }
  list.innerHTML = categories.map(c => {
    const n = accounts.filter(a => a.categoryId === c.id).length;
    return `<div class="trash-row" id="cat-row-${c.id}">
      <span class="cat-dot cat-dot-cycle" data-i18n-title="cat.colorTip" title="Click to change color" onclick="catCycleColor('${c.id}')" style="background:${c.color || catColor(c.id)}"></span>
      <span class="trash-info">
        <span class="trash-name cat-name">${esc(c.name)}</span>
        <span class="trash-meta">${esc(t('cat.accountCount', { n: n, s: n !== 1 ? 's' : '' }))}</span>
      </span>
      <button class="btn btn-ghost" onclick="catStartRename('${c.id}')" title="${esc(t('cat.rename'))}"><span class="material-icons-round" style="font-size:15px">edit</span></button>
      <button class="btn btn-del" onclick="catDelete('${c.id}')" title="${esc(t('cat.delete'))}"><span class="material-icons-round" style="font-size:15px">delete_outline</span></button>
    </div>`;
  }).join('');
  renderDashboard();
}

async function catAdd() {
  const input = document.getElementById('cat-new-name');
  const name = (input.value || '').trim();
  if (!name) { toast(t('cat.enterName'), 'err'); return; }
  if (categories.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast(t('cat.dup'), 'err'); return; }
  const id = crypto.randomUUID();    categories.push({ id, name, color: catColor(id) });
  input.value = '';
  await api.saveSettings({ categories });
  renderCategories();
  renderFilterCategories();
  render();
  toast(t('cat.created'), 'ok');
}

function catStartRename(id) {
  const row = document.getElementById('cat-row-' + id);
  if (!row) return;
  const cat = categories.find(c => c.id === id);
  if (!cat) return;
  const nameEl = row.querySelector('.cat-name');
  const old = cat.name;
  const input = document.createElement('input');
  input.className = 'sr-input cat-rename-input';
  input.value = old;
  const commit = async () => {
    const t = input.value.trim();
    if (t && t !== old) {
      if (categories.some(x => x.id !== id && x.name.toLowerCase() === t.toLowerCase())) { toast(t('cat.dup'), 'err'); renderCategories(); return; }
      cat.name = t;
      await api.saveSettings({ categories });
      renderCategories();
      renderFilterCategories();
      render();
      toast(t('cat.renamed'), 'ok');
    } else {
      renderCategories();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') renderCategories();
  };
  input.onblur = commit;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

function catDelete(id) {
  const c = categories.find(x => x.id === id);
  if (!c) return;
  confirmAction(t('cat.deleteConfirm', { name: c.name }), async () => {
    categories = categories.filter(x => x.id !== id);
    await api.saveSettings({ categories });
    // Unassign the accounts that pointed at it.
    for (const a of accounts.filter(x => x.categoryId === id)) {
      a.categoryId = null;
      await api.updateAccount(a.id, { categoryId: null });
    }
    if (_acctCategory === id) {
      _acctCategory = '';
      document.querySelectorAll('#filter-menu button[data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === 'all'));
      document.getElementById('filter-btn').classList.toggle('on', false);
    }
    renderCategories();
    renderFilterCategories();
    render();
    toast(t('cat.deleted'), 'ok');
  });
}

async function catCycleColor(id) {
  const c = categories.find(x => x.id === id);
  if (!c) return;
  const idx = CAT_COLORS.indexOf(c.color || catColor(c.id));
  c.color = CAT_COLORS[(idx + 1) % CAT_COLORS.length];
  await api.saveSettings({ categories });
  renderCategories();
  renderFilterCategories();
  render();
}

// ── Slider fill (visual only) ────────────────────────────────────────────
function _updateSliderFill(el) {
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100, val = parseFloat(el.value) || 0;
  const pct = max > min ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)) : 0;
  el.style.setProperty('--fill', pct + '%');
}
function _initSliderFills() {
  document.querySelectorAll('input[type="range"]').forEach(el => {
    _updateSliderFill(el);
    el.addEventListener('input', function() { _updateSliderFill(this); });
  });
}

// ── Backup / restore ───────────────────────────────────────────────────────
let _backupMode = null;

function openBackupModal(mode) {
  _backupMode = mode;
  const title = document.getElementById('bk-title');
  const desc = document.getElementById('bk-desc');
  const btn = document.getElementById('bk-action');
  const err = document.getElementById('bk-err');
  const inp = document.getElementById('bk-pass');
  if (err) err.style.display = 'none';
  if (inp) inp.value = '';
  if (btn) btn.disabled = false;
  if (title) title.textContent = mode === 'create' ? t('backup.titleCreate') : t('backup.titleRestore');
  if (desc) desc.textContent = mode === 'create'
    ? t('backup.descCreate')
    : t('backup.descRestore');
  if (btn) btn.textContent = mode === 'create' ? t('backup.create') : t('backup.restore');
  openModal('m-backup');
  setTimeout(() => inp && inp.focus(), 60);
}

async function submitBackup() {
  const inp = document.getElementById('bk-pass');
  const btn = document.getElementById('bk-action');
  const err = document.getElementById('bk-err');
  if (btn && btn.disabled) return;
  const val = inp ? inp.value : '';
  if (!val) { if (err) { err.textContent = t('backup.enterPass'); err.style.display = 'block'; } return; }
  if (btn) btn.disabled = true;
  try {
    if (_backupMode === 'create') {
      const r = await api.backupCreate(val);
      if (r && r.canceled) { closeModal('m-backup'); return; }
      if (!r || !r.ok) { if (err) { err.textContent = r?.error || t('backup.createFailed'); err.style.display = 'block'; } return; }
      closeModal('m-backup');
      settings.lastBackupAt = Date.now();
      api.saveSettings({ lastBackupAt: settings.lastBackupAt });
      renderDashboard();
      toast(t('backup.saved', { n: r.count, s: r.count === 1 ? '' : 's' }), 'ok');
      logEntry('ok', 'system', 'Backup created with ' + r.count + ' account(s)', { path: r.path });
    } else {
      // Restore replaces everything, so confirm before the native file dialog.
      confirmAction(t('backup.replaceConfirm'), async () => {
        const r = await api.backupRestore(val);
        if (r && r.canceled) return;
        if (!r || !r.ok) { if (err) { err.textContent = r?.error || t('backup.restoreFailed'); err.style.display = 'block'; } return; }
        closeModal('m-backup');
        await reloadAllData();
        toast(t('backup.restoredCount', { n: r.count, s: r.count === 1 ? '' : 's' }), 'ok');
        logEntry('ok', 'system', 'Backup restored with ' + r.count + ' account(s)');
      });
    }
  } catch (e) {
    if (err) { err.textContent = e?.message || 'Something went wrong.'; err.style.display = 'block'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Automatic backup ─────────────────────────────────────────────────────────
let _autoBackupTimer = null;
function _autoBackupCfg() {
  if (!settings.autoBackup) settings.autoBackup = {};
  return settings.autoBackup;
}
function _autoBackupFreqLabel(h) {
  const map = { 1: 'ab.hourly', 6: 'ab.hours6', 12: 'ab.hours12', 24: 'ab.daily', 168: 'ab.weekly' };
  return t(map[h] || 'ab.daily');
}
function _fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function toggleAutoBackup() {
  const ab = _autoBackupCfg();
  ab.enabled = !!document.getElementById('set-autobackup').checked;
  api.saveSettings({ autoBackup: ab });
  if (ab.enabled) startAutoBackupLoop(); else stopAutoBackupLoop();
  toast(t('settings.applied'), 'ok');
}
function setAutoBackupFreq(h) {
  const ab = _autoBackupCfg();
  ab.intervalHours = Number(h);
  api.saveSettings({ autoBackup: ab });
  const lbl = document.getElementById('cdd-autofreq-label');
  if (lbl) lbl.textContent = _autoBackupFreqLabel(ab.intervalHours);
  document.querySelectorAll('#cdd-autofreq-menu .cdd-option').forEach(o => o.classList.toggle('selected', Number(o.dataset.value) === ab.intervalHours));
  closeAllCdd();
  startAutoBackupLoop(); // re-arm at the new interval
  toast(t('settings.applied'), 'ok');
}
function setAutoBackupKeep(n) {
  const ab = _autoBackupCfg();
  ab.keep = Number(n);
  api.saveSettings({ autoBackup: ab });
  const lbl = document.getElementById('cdd-autokeep-label');
  if (lbl) lbl.textContent = String(ab.keep);
  document.querySelectorAll('#cdd-autokeep-menu .cdd-option').forEach(o => o.classList.toggle('selected', Number(o.dataset.value) === ab.keep));
  closeAllCdd();
  toast(t('settings.applied'), 'ok');
}
async function ensureAutoPassword() {
  try {
    const r = await api.backupAutoPassword();
    if (r && r.ok && r.password) {
      _autoBackupCfg().password = r.password;
      const el = document.getElementById('auto-backup-pw');
      if (el) el.textContent = r.password;
      return r.password;
    }
  } catch {}
  return null;
}
async function copyAutoBackupPassword() {
  const pw = await ensureAutoPassword();
  if (!pw) return;
  try {
    await navigator.clipboard.writeText(pw);
    toast(t('backup.copied'), 'ok');
  } catch { toast(t('common.failed', { msg: 'clipboard' }), 'err'); }
}
function startAutoBackupLoop() {
  stopAutoBackupLoop();
  if (!_autoBackupCfg().enabled) return;
  _autoBackupTimer = setInterval(_autoBackupTick, 60 * 1000);
}
function stopAutoBackupLoop() {
  if (_autoBackupTimer) { clearInterval(_autoBackupTimer); _autoBackupTimer = null; }
}
async function _autoBackupTick() {
  const ab = _autoBackupCfg();
  if (!ab.enabled) return;
  const intervalH = ab.intervalHours || 24;
  const last = ab.lastAt || 0;
  if (Date.now() - last < intervalH * 3600 * 1000) return;
  await runAutoBackup(false);
}
async function runAutoBackup(showToast) {
  const ab = _autoBackupCfg();
  const btn = document.getElementById('btn-backup-now');
  if (btn) btn.disabled = true;
  try {
    const pw = await ensureAutoPassword();
    if (!pw) throw new Error('no password');
    const r = await api.backupAutoCreate(pw, ab.keep || 5);
    if (r && r.ok) {
      ab.lastAt = Date.now();
      api.saveSettings({ autoBackup: ab });
      renderBackupHistory();
      logEntry('ok', 'system', 'Automatic backup created with ' + r.count + ' account(s)', { path: r.path });
      if (showToast) toast(t('backup.autoCreated', { n: r.count, s: r.count === 1 ? '' : 's' }), 'ok');
    } else {
      const msg = (r && r.error) || t('backup.autoFailed', { err: '' });
      logEntry('warn', 'system', 'Automatic backup failed: ' + msg);
      if (showToast) toast(t('backup.autoFailed', { err: msg }), 'err');
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    logEntry('warn', 'system', 'Automatic backup failed: ' + msg);
    if (showToast) toast(t('backup.autoFailed', { err: msg }), 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function backupNow() { await runAutoBackup(true); }
async function renderBackupHistory() {
  const list = document.getElementById('auto-backup-list');
  if (!list) return;
  let items = [];
  try { items = (await api.backupList()) || []; } catch {}
  if (!items.length) {
    list.innerHTML = '<div class="trash-empty" style="border:none"><span class="material-icons-round">archive</span>' + esc(t('settings.noBackups')) + '</div>';
    return;
  }
  list.innerHTML = items.map(b => {
    const when = b.createdAtMs ? _fmtBackupTime(b.createdAtMs) : '—';
    const size = _fmtBytes(b.size);
    return '<div class="trash-row">' +
      '<span class="material-icons-round" style="font-size:15px;color:var(--t3);flex-shrink:0">archive</span>' +
      '<span class="trash-info"><span class="trash-name">' + esc(when) + '</span><span class="trash-meta">' + esc(size) + '</span></span>' +
      '<button class="btn btn-ghost" title="' + esc(t('settings.restoreBackup')) + '" onclick="restoreAutoBackup(this)" data-name="' + esc(b.name) + '" data-path="' + esc(b.path) + '"><span class="material-icons-round" style="font-size:15px">restore</span></button>' +
      '<button class="btn btn-del" title="' + esc(t('common.delete')) + '" onclick="deleteAutoBackup(this)" data-name="' + esc(b.name) + '"><span class="material-icons-round" style="font-size:15px">delete_outline</span></button>' +
      '</div>';
  }).join('');
}
function restoreAutoBackup(btn) {
  const path = btn.dataset.path;
  confirmAction(t('backup.replaceConfirm'), async () => {
    const pw = await ensureAutoPassword();
    if (!pw) { toast(t('backup.restoreFailed'), 'err'); return; }
    const r = await api.backupRestorePath(path, pw);
    if (r && r.ok) {
      await reloadAllData();
      renderBackupHistory();
      toast(t('backup.restoredCount', { n: r.count, s: r.count === 1 ? '' : 's' }), 'ok');
    } else {
      toast((r && r.error) || t('backup.restoreFailed'), 'err');
    }
  });
}
function deleteAutoBackup(btn) {
  const name = btn.dataset.name;
  confirmAction(t('backup.deleteConfirm'), async () => {
    const r = await api.backupDelete(name);
    if (r && r.ok) {
      renderBackupHistory();
      toast(t('backup.deleted'), 'ok');
    } else {
      toast((r && r.error) || t('backup.deleteFailed'), 'err');
    }
  });
}

// Full reload of every data source the app holds, used after a backup restore
// (and anywhere else that replaces the on-disk data wholesale).
async function reloadAllData() {
  const loaded = await api.loadAccounts();
  accounts = loaded.filter(a => !a.trashed);
  trashedAccounts = loaded.filter(a => a.trashed);
  settings = await api.loadSettings();
  packages = await api.loadPackages();
  categories = Array.isArray(settings.categories) ? settings.categories : [];
  categories.forEach(c => { if (!c.color) c.color = catColor(c.id); }); // backfill color for categories saved before colors existed
  // A category filter pointing at a category the restore no longer has would
  // silently hide everything -- fall back to showing all accounts.
  if (_acctCategory && _acctCategory !== 'nocat' && !categories.some(c => c.id === _acctCategory)) {
    _acctCategory = '';
    document.querySelectorAll('#filter-menu button[data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === _acctFilter));
    document.getElementById('filter-btn').classList.toggle('on', _acctFilter !== 'all');
  }
  renderFilterCategories();
  updateTrashBadge();
  render();
  renderPackages();
  applySettings();
  refreshMultiStatus();
  detectRobloxVersion();
  if (settings.autoTrim) startAutoTrimLoop(); else stopAutoTrimLoop();
  startTrackingLoop();
}

function openLaunch(id) {
  launchAcc = accounts.find(a => a.id === id); if (!launchAcc) return;
  const target = launchAcc.gameTarget || '';
  const gameName = _gameNameCache[launchAcc.id] || (target ? extractTargetLabel(target) : '');
  const p = document.getElementById('launch-prev');
  p.innerHTML = '<div class="prev-av" id="prev-av">' + esc((launchAcc.username || '?')[0].toUpperCase()) + '</div>' +
    '<div><div class="prev-name">' + esc(launchAcc.username) + '</div>' +
    '<div class="prev-uid">' + esc(gameName || 'Opens home screen') + '</div></div>';
  // Avatar
  if (launchAcc.userId) {
    api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + launchAcc.userId + '&size=48x48&format=Png')
      .then(res => res.data).then(d => {
        const url = d?.data?.[0]?.imageUrl, el = document.getElementById('prev-av');
        if (url && el) el.innerHTML = '<img src="' + esc(url) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>';
      }).catch(() => {});
  }

  setStatus('launch-status', 'hidden', '');
  _launchingId = null;
  const btn = document.getElementById('btn-launch');
  btn.disabled = false; btn.innerHTML = 'Start';
  openModal('m-launch');
}
// The Cancel button doubles as "abandon the launch in progress": a launch can
// take ~30s (stagger, ticket retries, spawn retries), so closing the modal
// alone would leave it running with no way to stop it.
let _launchingId = null;
async function cancelLaunchOrClose() {
  if (_launchingId) {
    const id = _launchingId;
    try { await api.cancelLaunch(id); } catch {}
    logEntry('warn', 'launch', 'Launch cancelled', { accountId: id });
  }
  closeModal('m-launch');
}

async function doLaunch() {
  if (!launchAcc) return;
  const btn = document.getElementById('btn-launch');
  if (btn.disabled) return;
  _launchingId = launchAcc.id;
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Launching';
  setStatus('launch-status', 'load', '<div class="spin"></div>' + esc(t('launch.gettingTicket')));
  logEntry('info', 'launch', `Launching Roblox for ${launchAcc.username || launchAcc.id}...`, { accountId: launchAcc.id, username: launchAcc.username, userId: launchAcc.userId, target: launchAcc.gameTarget || 'Roblox home' });
  let res;
  try {
    // _srvTarget is a one-shot override set by "join this specific server".
    const target = launchAcc._srvTarget || launchAcc.gameTarget || null;
    launchAcc._srvTarget = null;
    res = await api.launchRoblox(launchAcc.id, launchAcc.cookie, target);
  } catch (e) {
    // Should never reject in practice (the backend command always resolves
    // with {success:false,...} on failure), but if it ever does, the button
    // must not stay stuck on "Launching..." forever with no way out.
    res = { success: false, error: e?.message || String(e) };
  }
  _launchingId = null;
  if (res.cancelled) {
    // The user already asked for this and the modal is closing - don't shout
    // an error at them on the way out.
    btn.disabled = false; btn.innerHTML = 'Start';
    closeModal('m-launch');
    return;
  }
  if (!res.success) {
    logEntry('err', 'launch', `Launch failed for ${launchAcc.username || launchAcc.id}: ${res.error}`, { accountId: launchAcc.id });
    setStatus('launch-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(res.error));
    _flagCookieMaybeDead(launchAcc.id, res.error);
    btn.disabled = false; btn.innerHTML = 'Start';
    return;
  }
  setStatus('launch-status', 'ok', '<span class="material-icons-round">check_circle</span>' + esc(t('acct.launchedAs', { u: launchAcc.username })));
  logEntry('ok', 'launch', `Roblox launched successfully as ${launchAcc.username || launchAcc.id}`, { accountId: launchAcc.id, username: launchAcc.username, userId: launchAcc.userId });
  markLaunched(launchAcc.id);
  setTimeout(() => { closeModal('m-launch'); toast(t('acct.launchedAs', { u: launchAcc.username }), 'ok'); }, 700);
}

// ── Server list (pick a specific server to join) ────────────────────────
let _srvCtx = null;
let _srvList = [];
let _srvHideFull = false;

function toggleSrvFilter(el) {
  _srvHideFull = !!el && el.checked;
  const list = document.getElementById('srv-list');
  if (list) _renderSrvList(list);
}

function _renderSrvList(list) {
  const servers = _srvList;
  if (!servers.length) {
    list.innerHTML = '<div style="padding:18px;text-align:center;color:var(--t3)" data-i18n="srv.none">No public servers available right now.</div>';
    return;
  }
  const sorted = servers.map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.playing / (a.s.maxPlayers || 1)) - (b.s.playing / (b.s.maxPlayers || 1)))
    .filter(x => !(_srvHideFull && x.s.playing >= (x.s.maxPlayers || 1)));
  if (!sorted.length) {
    list.innerHTML = '<div style="padding:18px;text-align:center;color:var(--t3)" data-i18n="srv.noFree">No servers with free slots.</div>';
    return;
  }
  list.innerHTML = sorted.map(x => {
    const s = x.s;
    const max = s.maxPlayers || 1;
    const full = s.playing >= max;
    const act = _srvCtx.accountId
      ? '<button class="btn btn-primary" style="height:28px;padding:0 12px;font-size:11.5px;flex-shrink:0" onclick="launchToServer(' + x.i + ')">' + esc(t('srv.joinHere')) + '</button>'
      : '';
    return '<div class="srv-item" style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid ' + (full ? 'rgba(var(--red-rgb),.4)' : 'var(--bd)') + ';border-radius:10px;margin-bottom:6px;background:var(--s1)">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:600;color:var(--t1)">' + esc(t('srv.server')) + ' <span style="color:var(--t3);font-weight:400;font-family:var(--mono);font-size:10.5px">#' + esc(String(s.id).slice(0, 8)) + '</span></div>' +
        '<div style="font-size:11px;color:' + (full ? 'var(--red)' : 'var(--t2)') + ';margin-top:1px">' + s.playing + '/' + max + ' ' + esc(t('srv.players')) + ' · ' + esc(s.region || '?') + ' · ' + (s.ping != null ? s.ping + 'ms' : '?') + (full ? ' · <b>' + esc(t('srv.full')) + '</b>' : '') + '</div>' +
      '</div>' + act + '</div>';
  }).join('');
}

async function openServerList(placeId, ctx) {
  _srvCtx = ctx || { placeId };
  _srvList = [];
  const list = document.getElementById('srv-list');
  const sub = document.getElementById('srv-sub');
  if (list) list.innerHTML = '<div style="padding:18px;text-align:center;color:var(--t3)"><div class="spin" style="margin:0 auto 8px;width:16px;height:16px"></div><span data-i18n="srv.loading">Looking for servers…</span></div>';
  if (sub) sub.textContent = t('srv.game') + ' ' + placeId;
  openModal('m-servers');
  try {
    // The server-list endpoint takes the PLACE ID directly — converting to
    // universeId first made it reject with "The place is invalid" and the
    // picker never showed anything.
    const acc = _srvCtx.accountId ? accounts.find(a => a.id === _srvCtx.accountId) : null;
    const srvUrl = 'https://games.roblox.com/v1/games/' + placeId + '/servers/Public?limit=50';
    const r2 = acc && acc.cookie
      ? await api.robloxGetAuth(srvUrl, acc.cookie)
      : await api.robloxGet(srvUrl);
    const servers = (r2 && r2.data && r2.data.data) || [];
    _srvList = servers;
    if (!servers.length) {
      if (list) list.innerHTML = '<div style="padding:18px;text-align:center;color:var(--t3)" data-i18n="srv.none">No public servers available right now.</div>';
      return;
    }
    if (list) _renderSrvList(list);
  } catch (e) {
    if (list) list.innerHTML = '<div style="padding:18px;text-align:center;color:var(--red)">' + esc(t('srv.errList')) + ': ' + esc(e.message || String(e)) + '</div>';
  }
}
function launchToServer(index) {
  const s = _srvList[index];
  if (!s || !_srvCtx || !_srvCtx.accountId) return;
  const target = _srvCtx.placeId + ':' + s.id;
  const id = _srvCtx.accountId;
  closeModal('m-servers');
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  acc._srvTarget = target;
  openLaunch(id);
  logEntry('info', 'launch', 'Targeting specific server for ' + (acc.username || id), { accountId: id, target });
}

// ── Packages ──────────────────────────────────────────────────────────────
let _pkgQuery = '', _pkgFilter = 'all', _pkgSort = 'manual', _pkgExpanded = new Set();
const _sessionLaunched = new Set();

function pkgMembers(p) {
  const order = (p.launchOrder && p.launchOrder.length) ? p.launchOrder : (p.accountIds || []);
  const byId = new Map(accounts.filter(a => order.includes(a.id)).map(a => [a.id, a]));
  return order.map(id => byId.get(id)).filter(Boolean);
}

function pkgState(p) {
  const members = pkgMembers(p);
  let running = 0, home = 0, dead = 0, downed = 0;
  for (const m of members) {
    if (_homeIds.has(m.id)) home++;
    else if (_launchedIds.has(m.id)) running++;
    if (_cookieStatus[m.id] === 'dead') dead++;
    if (_sessionLaunched.has(m.id) && !_launchedIds.has(m.id) && !_homeIds.has(m.id)) downed++;
  }
  return { total: members.length, running, home, dead, downed };
}

function visiblePackages() {
  let list = [...packages];
  if (_pkgQuery) {
    const q = _pkgQuery.toLowerCase();
    list = list.filter(p => (p.name || '').toLowerCase().includes(q));
  }
  if (_pkgFilter === 'running') list = list.filter(p => pkgState(p).running > 0);
  else if (_pkgFilter === 'downed') list = list.filter(p => pkgState(p).downed > 0);
  else if (_pkgFilter === 'pinned') list = list.filter(p => p.pinned);
  if (_pkgSort === 'alpha') list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  else list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return list;
}

function onPkgSearch(v) { _pkgQuery = v.trim(); renderPackages(); }
function togglePkgFilter(e) { if (e) e.stopPropagation(); const m = document.getElementById('pkg-filter-menu'); if (m) m.classList.toggle('open'); }
function setPkgFilter(f) {
  _pkgFilter = f;
  document.querySelectorAll('#pkg-filter-menu button[data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  document.getElementById('pkg-filter-btn')?.classList.toggle('on', f !== 'all');
  document.getElementById('pkg-filter-menu')?.classList.remove('open');
  renderPackages();
}
function togglePkgSort() { _pkgSort = _pkgSort === 'manual' ? 'alpha' : 'manual'; renderPackages(); }
function togglePkgPin(id) { const p = packages.find(x => x.id === id); if (!p) return; p.pinned = !p.pinned; api.savePackages(packages); renderPackages(); }
function togglePkgExpand(id) {
  if (_pkgExpanded.has(id)) _pkgExpanded.delete(id); else _pkgExpanded.add(id);
  const body = document.querySelector(`.pkg-card[data-id="${id}"] .pkg-members`);
  if (body) body.classList.toggle('open');
  const btn = document.querySelector(`.pkg-card[data-id="${id}"] .pkg-expand-btn`);
  if (btn) btn.classList.toggle('open');
}
function duplicatePackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  packages.push({ id: crypto.randomUUID(), name: 'Copy of ' + (p.name || ''), accountIds: [...(p.accountIds || [])], link: p.link || '', color: p.color || '', pinned: false, launchOrder: p.launchOrder ? [...p.launchOrder] : undefined, launchDelay: p.launchDelay || 0 });
  api.savePackages(packages); renderPackages(); toast('Duplicated', 'ok');
}
function exportPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  navigator.clipboard?.writeText(JSON.stringify({ name: p.name, accountIds: p.accountIds || [], link: p.link || '', color: p.color || '', launchDelay: p.launchDelay || 0 }, null, 2)).then(() => toast('Copied', 'ok'), () => toast('Copy failed', 'err'));
}
function importPackage() {
  const raw = prompt('Paste the group JSON here:');
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.name !== 'string') throw new Error();
    packages.push({ id: crypto.randomUUID(), name: data.name, accountIds: Array.isArray(data.accountIds) ? data.accountIds.filter(id => accounts.some(a => a.id === id)) : [], link: typeof data.link === 'string' ? data.link : '', color: typeof data.color === 'string' ? data.color : '', pinned: false, launchOrder: undefined, launchDelay: Number(data.launchDelay) || 0 });
    api.savePackages(packages); renderPackages(); toast('Imported', 'ok');
  } catch { toast('Invalid JSON', 'err'); }
}
async function relaunchDownedPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const downed = pkgMembers(p).filter(m => m.gameTarget && _sessionLaunched.has(m.id) && !_launchedIds.has(m.id) && !_homeIds.has(m.id) && !(_cookieStatus[m.id] === 'dead' || m._cookieInvalid));
  if (!downed.length) { toast('No downed', 'ok'); return; }
  let ok = 0;
  await Promise.all(downed.map(async (m) => {
    const res = await api.launchRoblox(m.id, m.cookie, (p.link || '').trim() || m.gameTarget || null);
    if (res.success) { ok++; markLaunched(m.id); }
  }));
  toast(ok + '/' + downed.length + ' relaunched', ok === downed.length ? 'ok' : 'err');
}
async function trimPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const running = pkgMembers(p).filter(m => _launchedIds.has(m.id));
  if (!running.length) { toast('No running', 'err'); return; }
  let ok = 0;
  await Promise.all(running.map(m => api.trimAccountMemory(m.id).then(r => { if (r && r.ok) ok++; })));
  toast(ok + '/' + running.length + ' trimmed', ok === running.length ? 'ok' : 'err');
}

function renderPackages() {
  const list = document.getElementById('pkg-list'), empty = document.getElementById('pkg-empty');
  if (!list) return;
  const vis = visiblePackages();
  if (!vis.length) { list.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  list.innerHTML = vis.map((p, i) => {
    const members = pkgMembers(p);
    const st = pkgState(p);
    const shown = members.slice(0, 6);
    const extra = members.length - shown.length;
    const avatarsHtml = shown.map(m => `<div class="pkg-avatar${_launchedIds.has(m.id) ? ' online' : ''}${_homeIds.has(m.id) ? ' home' : ''}" id="pkg-av-${p.id}-${m.id}" data-acc-id="${m.id}" data-uid="${m.userId || ''}" data-uname="${esc(m.username || '')}" data-nick="${esc(m.nickname || '')}">${esc((m.username || '?')[0].toUpperCase())}<span class="pkg-avatar-dot"></span></div>`).join('')
      + (extra > 0 ? `<div class="pkg-avatar more">+${extra}</div>` : '');
    const pct = st.total ? Math.round((st.running + st.home) / st.total * 100) : 0;
    const membersHtml = members.map(m => {
      const cls = _homeIds.has(m.id) ? 'home' : (_launchedIds.has(m.id) ? 'running' : (_cookieStatus[m.id] === 'dead' ? 'dead' : 'idle'));
      const lbl = _homeIds.has(m.id) ? t('accounts.home') : (_launchedIds.has(m.id) ? t('accounts.launched') : (_cookieStatus[m.id] === 'dead' ? t('accounts.expired') : t('accounts.notLaunched')));
      return `<div class="pkg-member ${cls}" data-acc-id="${m.id}"><span class="pkg-member-dot"></span>${esc(m.nickname || m.username || 'Unknown')}<span class="pkg-member-st">${esc(lbl)}</span></div>`;
    }).join('');
    return `
    <div class="pkg-card${_pkgExpanded.has(p.id) ? ' expanded' : ''}${p.pinned ? ' pinned' : ''}" data-id="${p.id}" style="animation-delay:${i * 18}ms;${p.color ? `--pkgc:${esc(p.color)}` : ''}">
      <div class="pkg-cover" id="pkg-cover-${p.id}"></div>
      <div class="pkg-card-top">
        <button class="pkg-pin${p.pinned ? ' pinned' : ''}" onclick="togglePkgPin('${p.id}')" title="Pin / unpin" aria-label="Pin group">
          <span class="material-icons-round">star</span>
        </button>
        <div class="sr-icon"><span class="material-icons-round">groups</span></div>
        <div class="pkg-card-info">
          <div class="pkg-name">${esc(p.name)}</div>
          <div class="pkg-meta">${esc(t('groups.memberCount', { n: members.length, s: members.length !== 1 ? 's' : '' }))}</div>
        </div>
        <div class="pkg-avatars">${avatarsHtml}</div>
        <div class="pkg-card-actions">
          <button class="btn btn-ghost pkg-expand-btn${_pkgExpanded.has(p.id) ? ' open' : ''}" onclick="togglePkgExpand('${p.id}')" aria-label="Expand members">
            <span class="material-icons-round">expand_more</span>
          </button>
          <button class="btn btn-edit" onclick="openEditPackage('${p.id}')" aria-label="Manage accounts">
            <span class="material-icons-round">group</span>
          </button>
          <button class="btn btn-ghost" onclick="duplicatePackage('${p.id}')" aria-label="Duplicate group">
            <span class="material-icons-round">copy</span>
          </button>
          <button class="btn btn-ghost" onclick="exportPackage('${p.id}')" aria-label="Export group to clipboard">
            <span class="material-icons-round">file_upload</span>
          </button>
          <button class="btn btn-del" onclick="deletePackage('${p.id}')" aria-label="Delete package">
            <span class="material-icons-round">delete_outline</span>
          </button>
        </div>
      </div>
      <div class="pkg-status">
        <div class="pkg-status-text"><span class="pkg-status-run">${st.running}</span>/<span class="pkg-status-total">${st.total}</span> ${esc(t('groups.running'))}<span class="pkg-status-home-sep" style="display:${st.home ? '' : 'none'}"> · <span class="pkg-status-home">${st.home}</span> ${esc(t('groups.inHome'))}</span><span class="pkg-status-downed-sep" style="display:${st.downed ? '' : 'none'}"> · <span class="pkg-status-downed">${st.downed}</span> ${esc(t('groups.downed'))}</span></div>
        <div class="pkg-progress-bar"><div class="pkg-progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="pkg-link-row">
        <div class="pkg-link-field">
          <span class="material-icons-round pkg-link-icon">link</span>
          <input type="text" class="pkg-link-input" id="pkg-link-${p.id}" placeholder="${esc(t('groups.linkPh'))}"
            value="${esc(p.link || '')}" onchange="setPackageLink('${p.id}', this.value)"
            onkeydown="if(event.key==='Enter'){this.blur();}"/>
        </div>
        <button class="btn btn-launch pkg-launch-btn" onclick="launchPackage('${p.id}')" ${members.length ? '' : 'disabled'}>
          ${esc(t('groups.startAll'))}
        </button>
        <button class="btn btn-out pkg-relaunch-btn" onclick="relaunchDownedPackage('${p.id}')" ${st.downed ? '' : 'disabled'} title="${esc(t('groups.relaunchTip'))}">
          <span class="material-icons-round">refresh</span>
        </button>
        <button class="btn btn-out pkg-trim-btn" onclick="trimPackage('${p.id}')" ${st.running ? '' : 'disabled'} title="${esc(t('groups.trimTip'))}">
          <span class="material-icons-round">memory</span>
        </button>
        <button class="btn btn-del pkg-kill-btn" onclick="killPackage('${p.id}')" ${st.running ? '' : 'disabled'}>
          <span class="material-icons-round">power_settings_new</span>
        </button>
      </div>
      <div class="pkg-members${_pkgExpanded.has(p.id) ? ' open' : ''}">${membersHtml || '<div class="pkg-member idle">—</div>'}</div>
      <div class="pkg-progress" id="pkg-progress-${p.id}"></div>
    </div>`;
  }).join('');
  vis.forEach(p => {
    pkgMembers(p).slice(0, 6).forEach(m => {
      if (m && m.userId) loadPkgAvatar(p.id, m.id, m.userId);
    });
    loadPkgCover(p.id, p.link || '');
  });
  refreshPkgAvatarStatus();
  renderDashboard();
}

function openCreatePackage() {
  editingPackageId = null;
  document.getElementById('pkg-modal-title').textContent = t('groups.titleNew');
  document.getElementById('in-pkg-name').value = '';
  document.getElementById('in-pkg-delay').value = 0;
  document.getElementById('pkg-picker-search').value = '';
  document.getElementById('pkg-order-row').innerHTML = '';
  setPkgColorSel('');
  renderPackagePicker([]);
  openModal('m-package');
  setTimeout(() => document.getElementById('in-pkg-name').focus(), 220);
}

function openEditPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  editingPackageId = id;
  document.getElementById('pkg-modal-title').textContent = t('groups.titleEdit');
  document.getElementById('in-pkg-name').value = p.name || '';
  document.getElementById('in-pkg-delay').value = p.launchDelay || 0;
  document.getElementById('pkg-picker-search').value = '';
  setPkgColorSel(p.color || '');
  _pkgOrderIds = (p.launchOrder && p.launchOrder.length) ? [...p.launchOrder] : (p.accountIds || []);
  renderPackagePicker(p.accountIds || []);
  renderPkgOrder();
  openModal('m-package');
}

function setPkgColorSel(color) {
  document.querySelectorAll('#pkg-color-row .pkg-color-swatch').forEach(b => b.classList.toggle('sel', b.dataset.color === color));
}

function collectPkgChecked() {
  return Array.from(document.querySelectorAll('#pkg-account-picker input:checked')).map(c => c.value);
}

function pkgPickAll(sel) {
  document.querySelectorAll('#pkg-account-picker input').forEach(c => { c.checked = sel; });
  updatePkgCount();
  renderPkgOrder();
}

function renderPackagePicker(selectedIds) {
  const wrap = document.getElementById('pkg-account-picker');
  if (!wrap) return;
  const q = (document.getElementById('pkg-picker-search')?.value || '').trim().toLowerCase();
  let list = accounts;
  if (q) list = list.filter(a => ((a.nickname || '') + ' ' + (a.username || '') + ' ' + String(a.userId || '')).toLowerCase().includes(q));
  if (!list.length) {
    wrap.innerHTML = '<div class="pkg-pick-empty">' + esc(t('groups.noMatch')) + '</div>';
    updatePkgCount();
    return;
  }
  wrap.innerHTML = list.map(a => `
    <label class="pm-row">
      <input type="checkbox" value="${a.id}" ${selectedIds.includes(a.id) ? 'checked' : ''} onchange="renderPkgOrder()"/>
      <span class="pm-av" id="pkg-picker-av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</span>
      <span class="pm-info">
        <span class="pm-name">${esc(a.nickname || a.username || 'Unknown')}</span>
        <span class="pm-meta">${a.userId ? 'ID ' + a.userId : 'No ID'}</span>
      </span>
      <span class="pm-check"><span class="material-icons-round">check</span></span>
    </label>`).join('');
  updatePkgCount();
  loadAvatarsBatch(list);
  renderPkgOrder();
}

function renderPkgOrder() {
  const wrap = document.getElementById('pkg-order-row');
  if (!wrap) return;
  const checked = collectPkgChecked();
  const byId = new Map(accounts.filter(a => checked.includes(a.id)).map(a => [a.id, a]));
  let current;
  if (_pkgOrderIds && _pkgOrderIds.length) {
    current = _pkgOrderIds.filter(id => checked.includes(id));
    const seen = new Set(current);
    checked.forEach(id => { if (!seen.has(id)) { current.push(id); seen.add(id); } });
  } else {
    current = checked;
  }
  _pkgOrderIds = current;
  if (!current.length) { wrap.innerHTML = '<div class="pkg-order-empty">' + esc(t('groups.orderEmpty')) + '</div>'; return; }
  wrap.innerHTML = current.map((id, i) => {
    const a = byId.get(id);
    if (!a) return '';
    return `<div class="pkg-order-item"><span class="pkg-order-n">${i + 1}</span><span class="pm-av sm">${esc((a.username || '?')[0].toUpperCase())}</span><span class="pm-name">${esc(a.nickname || a.username || 'Unknown')}</span>
      <button class="btn btn-ghost" onclick="movePkgOrder(${i},-1)" ${i === 0 ? 'disabled' : ''}><span class="material-icons-round">arrow_upward</span></button>
      <button class="btn btn-ghost" onclick="movePkgOrder(${i},1)" ${i === current.length - 1 ? 'disabled' : ''}><span class="material-icons-round">arrow_downward</span></button></div>`;
  }).join('');
}
let _pkgOrderIds = null;
function movePkgOrder(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= _pkgOrderIds.length) return;
  const t = _pkgOrderIds[i]; _pkgOrderIds[i] = _pkgOrderIds[j]; _pkgOrderIds[j] = t;
  renderPkgOrder();
}

document.addEventListener('click', e => {
  const sw = e.target.closest('#pkg-color-row .pkg-color-swatch');
  if (!sw) return;
  setPkgColorSel(sw.dataset.color || '');
});

function updatePkgCount() {
  const el = document.getElementById('pkg-count');
  if (!el) return;
  const n = document.querySelectorAll('#pkg-account-picker input:checked').length;
  el.textContent = t('groups.selected', { n: n, s: n !== 1 ? 's' : '' });
}

function savePackageModal() {
  const name = document.getElementById('in-pkg-name').value.trim();
  if (!name) { toast(t('pkg.giveName'), 'err'); return; }
  const checked = collectPkgChecked();
  const color = document.querySelector('#pkg-color-row .pkg-color-swatch.sel')?.dataset.color || '';
  const delay = Math.max(0, Math.min(60000, Number(document.getElementById('in-pkg-delay').value) || 0));
  const order = (_pkgOrderIds && _pkgOrderIds.length ? _pkgOrderIds : checked);
  if (editingPackageId) {
    const p = packages.find(x => x.id === editingPackageId);
    if (p) { p.name = name; p.accountIds = checked; p.color = color; p.launchDelay = delay; p.launchOrder = order; }
  } else {
    packages.push({ id: crypto.randomUUID(), name, accountIds: checked, link: '', color, pinned: false, launchDelay: delay, launchOrder: order });
  }
  api.savePackages(packages);
  renderPackages();
  closeModal('m-package');
  toast(t('pkg.saved'), 'ok');
}

function deletePackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  confirmAction(t('pkg.deleteConfirm', { name: p.name }), () => {
    packages = packages.filter(x => x.id !== id);
    api.savePackages(packages);
    renderPackages();
    toast(t('pkg.deleted'), 'err');
  });
}

function setPackageLink(id, value) {
  const p = packages.find(x => x.id === id); if (!p) return;
  p.link = value.trim();
  api.savePackages(packages);
  loadPkgCover(id, p.link);
}

const _pkgCoverCache = {};
const _pkgPlaceCache = {};
function extractPlaceId(link) {
  if (!link) return null;
  const s = String(link).trim();
  if (/^\d{4,}$/.test(s)) return s;
  const m = s.match(/roblox\.com\/(?:games|share)\/(\d{4,})/);
  return m ? m[1] : null;
}
function renderPkgCover(pkgId, url) {
  const el = document.getElementById('pkg-cover-' + pkgId);
  if (!el) return;
  if (url) {
    el.innerHTML = '<img src="' + esc(url) + '" alt="" loading="lazy"/>';
    el.classList.add('has');
  } else {
    el.innerHTML = '';
    el.classList.remove('has');
  }
}
async function loadPkgCover(pkgId, link) {
  const el = document.getElementById('pkg-cover-' + pkgId);
  const placeId = extractPlaceId(link);
  if (!el || !placeId) { if (el) renderPkgCover(pkgId, null); return; }
  if (_pkgCoverCache[placeId]) { renderPkgCover(pkgId, _pkgCoverCache[placeId]); return; }
  try {
    let uni = _pkgPlaceCache[placeId];
    if (!uni) {
      const res = await api.robloxGet('https://apis.roblox.com/universes/v1/places/' + placeId + '/universe');
      const d = res && res.data;
      if (!d || !d.universeId) return;
      uni = { universeId: d.universeId };
      _pkgPlaceCache[placeId] = uni;
    }
    const tres = await api.robloxGet('https://thumbnails.roblox.com/v1/games/icons?universeIds=' + uni.universeId + '&size=512x512&format=Png');
    const tdata = tres && tres.data;
    const url = tdata && tdata.data && tdata.data[0] && tdata.data[0].imageUrl;
    if (url) {
      _pkgCoverCache[placeId] = url;
      renderPkgCover(pkgId, url);
    }
  } catch { }
}

async function launchPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const members = pkgMembers(p);
  if (!members.length) { toast(t('pkg.noAccounts'), 'err'); return; }

  const card = document.querySelector('.pkg-card[data-id="' + id + '"]');
  const btn = card ? card.querySelector('.pkg-launch-btn') : null;
  const killBtn = card ? card.querySelector('.pkg-kill-btn') : null;
  if (btn && btn.dataset.busy === '1') return;
  if (killBtn && killBtn.dataset.busy === '1') { toast(t('pkg.killBusy'), 'err'); return; }
  if (btn) btn.dataset.busy = '1';
  if (killBtn) killBtn.disabled = true;
  const progress = document.getElementById('pkg-progress-' + id);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Launching'; }
  if (progress) {
    progress.innerHTML = members.map(m => `
      <span class="pkg-chip load" id="pkg-chip-${id}-${m.id}">
        <div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}
      </span>`).join('');
  }

  const link = (p.link || '').trim();
  let okCount = 0;
  const delay = Math.max(0, Math.min(60000, p.launchDelay || 0));
  for (const m of members) {
    const target = link || m.gameTarget || null;
    logEntry('info', 'launch', `Launching Roblox for ${m.username || m.id} (package)...`, { accountId: m.id, username: m.username || null, userId: m.userId || null, target: target || 'Roblox home' });
    const res = await api.launchRoblox(m.id, m.cookie, target);
    const chip = document.getElementById('pkg-chip-' + id + '-' + m.id);
    if (res.success) {
      okCount++;
      logEntry('ok', 'launch', `Launched as ${m.username || m.id} (package)`, { accountId: m.id, username: m.username || null });
      markLaunched(m.id);
      if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); }
    } else if (chip) {
      chip.className = 'pkg-chip err';
      chip.title = res.error || '';
      chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || '');
      _flagCookieMaybeDead(m.id, res.error);
    }
    if (delay > 0 && okCount < members.length) await new Promise(r => setTimeout(r, delay));
  }

  if (btn) { btn.disabled = false; btn.innerHTML = 'Start All'; delete btn.dataset.busy; }
  if (killBtn && killBtn.dataset.busy !== '1') killBtn.disabled = !members.some(m => _launchedIds.has(m.id));
  toast(t('pkg.launchedN', { ok: okCount, total: members.length, name: p.name }), okCount === members.length ? 'ok' : 'err');
}

async function killPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const members = pkgMembers(p);
  const running = members.filter(m => _launchedIds.has(m.id));
  if (!running.length) { toast(t('pkg.noRunning'), 'err'); return; }

  const card = document.querySelector('.pkg-card[data-id="' + id + '"]');
  const btn = card ? card.querySelector('.pkg-kill-btn') : null;
  const launchBtn = card ? card.querySelector('.pkg-launch-btn') : null;
  if (btn && btn.dataset.busy === '1') return;
  if (launchBtn && launchBtn.dataset.busy === '1') { toast(t('pkg.launchBusy'), 'err'); return; }
  if (btn) btn.dataset.busy = '1';
  if (launchBtn) launchBtn.disabled = true;
  const progress = document.getElementById('pkg-progress-' + id);
  if (btn) btn.disabled = true;
  if (progress) {
    progress.innerHTML = running.map(m => `
      <span class="pkg-chip load" id="pkg-chip-${id}-${m.id}">
        <div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}
      </span>`).join('');
  }

  let okCount = 0;
  await Promise.all(running.map(async (m) => {
    logEntry('warn', 'kill', `Killing Roblox instance for ${m.username || m.id} (package)...`, { accountId: m.id, username: m.username || null, userId: m.userId || null });
    const res = await api.killOneRoblox(m.id);
    const chip = document.getElementById('pkg-chip-' + id + '-' + m.id);
    if (res && res.ok) {
      okCount++;
      logEntry('ok', 'kill', `Killed instance for ${m.username || m.id} (package)`, { accountId: m.id });
      if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); }
    } else if (chip) {
      chip.className = 'pkg-chip err';
      chip.title = (res && res.error) || '';
      chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || '');
    }
  }));

  if (btn) { btn.disabled = !members.some(m => _launchedIds.has(m.id)); delete btn.dataset.busy; }
  if (launchBtn && launchBtn.dataset.busy !== '1') launchBtn.disabled = false;
  toast(t('pkg.killedN', { ok: okCount, total: running.length, name: p.name }), okCount === running.length ? 'ok' : 'err');
}

function toggleKeyVisibility(inputId = 'custom-key', iconId = 'key-vis-icon') {
  const input = document.getElementById(inputId), icon = document.getElementById(iconId);
  if (input.type === 'password') { input.type = 'text'; icon.textContent = 'visibility_off'; }
  else { input.type = 'password'; icon.textContent = 'visibility'; }
}
let _saveKeyTimer;
function onKeyInput() {
  const btn = document.getElementById('btn-save-key');
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}
async function saveKeySettings() {
  const keyVal = document.getElementById('custom-key').value;
  const btn = document.getElementById('btn-save-key');
  if (btn.disabled) return;
  clearTimeout(_saveKeyTimer);
  btn.disabled = true; btn.textContent = 'Saving';
  _saveKeyTimer = setTimeout(async () => {
    try {
      // enc:setKey changes the key and re-encrypts accounts in one step.
      const r = await api.encSetKey(keyVal);
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'could not update key');
      if (!keyVal.trim()) throw new Error('Encryption key cannot be empty.');
      settings.keySet = true;
      document.getElementById('custom-key').value = '';
      // Reload accounts so the renderer holds cookies under the new key.
      try { accounts = await api.loadAccounts(); flagInvalidCookies(accounts); render(); } catch {}
      toast(t('enc.keyUpdated'), 'ok');
      applySettings();
    } catch (e) {
      toast(t('common.saveFailed', { msg: e.message }), 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }, 300);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function setStatus(id, type, html) { const el = document.getElementById(id); el.className = 'mst ' + type; el.innerHTML = html; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(msg, type) {
  type = type || '';
  const el = document.getElementById('toast'), icon = type === 'ok' ? 'check_circle' : 'cancel';
  el.innerHTML = '<span class="material-icons-round">' + icon + '</span>' + esc(msg);
  el.className = 'toast show ' + type; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2700);
}

// Defaults multi-instance on for a fresh install, but leaves an explicit
// `false` alone -- this used to force it back on every time the Settings page
// was opened, so the setting could never stay off.
async function refreshMultiStatus() {
  const s = await api.multiInstanceStatus();
  // Driven off the backend's own view rather than the local settings copy, so
  // the switch can't sit out of sync with what the helper is actually doing.
  // That side defaults to on now, so a fresh install shows the switch already
  // enabled without needing the setting written out first.
  const cb = document.getElementById('set-multiinstance');
  if (cb) cb.checked = !!s.enabled;
}

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('mousedown', e => {
    if (e.target === o && o.dataset.backdropClose === 'true') o.classList.remove('open');
  });
});
document.addEventListener('keydown', e => {
  // Ctrl/Cmd+F opens native-style find on the logs page.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && document.getElementById('page-logs')?.classList.contains('active')) {
    e.preventDefault(); openLogFind(); return;
  }
  // Find-bar keys: Enter = next, Shift+Enter = previous, Esc = close.
  if (e.target && e.target.id === 'log-find-input') {
    if (e.key === 'Enter') { e.preventDefault(); logFind(e.shiftKey); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeLogFind(); return; }
  }
  if (e.key === 'Escape') {
    const lf = document.getElementById('log-find');
    if (lf && lf.style.display !== 'none') { closeLogFind(); return; }
    closeAllCdd();
    const editEl = document.getElementById('m-edit');
    if (editEl.classList.contains('open')) {
      // Escape shouldn't discard the modal out from under someone mid-typing.
      const typing = ['in-target', 'in-nickname', 'in-description', 'in-follow']
        .some(f => document.activeElement === document.getElementById(f));
      if (!typing) closeModal('m-edit');
    } else document.querySelectorAll('.overlay.open').forEach(m => m.classList.remove('open'));
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openLogin(); }
  // "/" focuses the account search (when not already typing in a field).
  if (e.key === '/' && document.getElementById('page-accounts')?.classList.contains('active')
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    document.getElementById('acct-search')?.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && document.getElementById('m-edit').classList.contains('open')) {
    e.preventDefault(); saveEdit();
  }
});

let chartTab = 'popular';
let allCharts = {};
let chartsLoaded = false;

function switchChartTab(tab) {
  chartTab = tab;
  document.querySelectorAll('#page-charts .tab-btn').forEach(t => t.classList.remove('active'));
  document.getElementById('ctab-' + tab).classList.add('active');
  const s = document.getElementById('chart-search'); if (s) s.value = '';
  _searchMode = false;
  if (chartsLoaded) renderCharts(allCharts[tab] || [], false);
  positionTabSlider(document.getElementById('ctab-' + tab).closest('.tab-bar'));
}

async function loadCharts() {
  const grid = document.getElementById('charts-grid');
  const loading = document.getElementById('charts-loading');
  const empty = document.getElementById('charts-empty');
  chartsLoaded = false;
  grid.style.display = 'none'; empty.style.display = 'none'; loading.style.display = 'flex';

  try {
    // Use official Roblox explore-api with a random sessionId per load
    const [popular, trending, favorited] = await Promise.all([
      fetchRobloxGames('top-playing-now'),
      fetchRobloxGames('top-rated'),
      fetchRobloxGames('top-earning'),
    ]);
    allCharts = { popular, trending, favorited };
    chartsLoaded = true;
    loading.style.display = 'none';
    renderCharts(allCharts[chartTab] || [], false);
  } catch(e) {
    console.error('Charts load error:', e);
    loading.style.display = 'none';
    empty.style.display = 'flex';
  }
}

function randomGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function fetchRobloxGames(sortId) {
  // Official Roblox explore API
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${sessionId}&sortId=${sortId}&device=computer&country=all`;
  const r = await api.robloxGet(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = r.data;

  // Response shape: { sorts: [{ games: [...] }] } or { games: [...] }
  const games = d.games || (d.sorts && d.sorts[0] && d.sorts[0].games) || [];
  if (!games.length) throw new Error('No games in response');

  // Fetch thumbnails for all universeIds
  let thumbMap = {};
  try {
    const universeIds = games.map(g => g.universeId).filter(Boolean).join(',');
    const thumbRes = await api.robloxGet(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    if (thumbRes.ok) {
      const thumbData = thumbRes.data;
      (thumbData.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
    }
  } catch {}

  return games.map(g => ({
    universeId: g.universeId,
    placeId: g.rootPlaceId || g.placeId,
    name: g.name,
    playerCount: g.playerCount,
    thumbUrl: thumbMap[g.universeId] || ''
  }));
}

let _chartGameMap = {};
let _favGames = new Set();
try { _favGames = new Set(JSON.parse(localStorage.getItem('mr_fav_games') || '[]')); } catch {}
function _gameKey(g) { return g.universeId || g.placeId || g.id || g.name || ''; }
function saveFavGames() { try { localStorage.setItem('mr_fav_games', JSON.stringify([..._favGames])); } catch {} }
function toggleFavGame(i) {
  const g = _chartGameMap[i]; if (!g) return;
  const key = _gameKey(g); if (!key) return;
  if (_favGames.has(key)) _favGames.delete(key); else _favGames.add(key);
  saveFavGames();
  const btn = document.querySelector(`.chart-card[data-idx="${i}"] .chart-fav`);
  if (btn) btn.classList.toggle('active', _favGames.has(key));
  if (!_searchMode) renderCharts(allCharts[chartTab] || [], false);
}
let _searchDebounce = null;
let _searchMode = false;

function renderCharts(games, searchMode) {
  const grid = document.getElementById('charts-grid');
  const emptyEl = document.getElementById('charts-empty');
  const loading = document.getElementById('charts-loading');
  loading.style.display = 'none';
  _chartGameMap = {};
  if (!games || !games.length) {
    emptyEl.style.display = 'flex';
    grid.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  grid.style.display = 'grid';
  if (!searchMode && _favGames.size) {
    games = [...games.filter(g => _favGames.has(_gameKey(g))), ...games.filter(g => !_favGames.has(_gameKey(g)))];
  }
  grid.innerHTML = games.map((g, i) => {
    _chartGameMap[i] = g;
    const players = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing' : '';
    // Rank only means something against the chart order; a search result list
    // has no ranking to show, so the overlay badge is skipped there instead of
    // labelling every card with the same "Search result" text.
    const rankLabel = searchMode ? '' : `<div class="chart-card-rank">#${i + 1}</div>`;
    const thumb = g.thumbUrl
      ? `<img class="chart-card-thumb" src="${esc(g.thumbUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=chart-card-thumb-ph><span class=material-icons-round>videogame_asset</span></div>'"/>`
      : `<div class="chart-card-thumb-ph"><span class="material-icons-round">videogame_asset</span></div>`;
    const favKey = _gameKey(g);
    const favCls = favKey && _favGames.has(favKey) ? ' active' : '';
    return `<div class="chart-card${favCls ? ' is-fav' : ''}" data-idx="${i}" style="animation-delay:${i * 12}ms" onclick="openGameModal(${i})" title="View game info">
      ${favKey ? `<button class="chart-fav${favCls}" onclick="event.stopPropagation();toggleFavGame(${i})" title="Favorite"><span class="material-icons-round">star</span></button>` : ''}
      ${thumb}
      ${rankLabel}
      <div class="chart-card-body">
        <div class="chart-card-name">${esc(g.name || 'Unknown')}</div>
        ${players ? `<div class="chart-card-stat"><span class="material-icons-round">people</span>${players}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function searchRobloxGames(query) {
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${sessionId}`;
  const r = await api.robloxGet(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = r.data;

  // Extract game universe IDs from omni-search results
  const contents = d.searchResults || [];
  const gameSection = contents.find(s => s.contentGroupType === 'Game') || contents[0];
  if (!gameSection || !gameSection.contents) return [];

  const universeIds = gameSection.contents.map(c => c.contentId).filter(Boolean);
  if (!universeIds.length) return [];

  // Fetch full game details
  const detailsRes = await api.robloxGet(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(',')}`);
  const details = detailsRes.ok ? detailsRes.data : { data: [] };
  const detailMap = {};
  (details.data || []).forEach(g => { detailMap[g.id] = g; });

  // Fetch thumbnails
  let thumbMap = {};
  try {
    const thumbRes = await api.robloxGet(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    if (thumbRes.ok) {
      const td = thumbRes.data;
      (td.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
    }
  } catch {}

  return universeIds.map(uid => {
    const det = detailMap[uid] || {};
    return {
      universeId: uid,
      placeId: det.rootPlaceId,
      name: det.name,
      playerCount: det.playing,
      thumbUrl: thumbMap[uid] || ''
    };
  }).filter(g => g.placeId);
}

function filterCharts(val) {
  clearTimeout(_searchDebounce);
  const query = val.trim();
  if (!query) {
    _searchMode = false;
    if (chartsLoaded) renderCharts(allCharts[chartTab] || [], false);
    else {
      document.getElementById('charts-grid').style.display = 'none';
      document.getElementById('charts-empty').style.display = 'none';
      document.getElementById('charts-loading').style.display = 'flex';
    }
    return;
  }
  _searchMode = true;
  _searchDebounce = setTimeout(async () => {
    const grid = document.getElementById('charts-grid');
    const loading = document.getElementById('charts-loading');
    const emptyEl = document.getElementById('charts-empty');
    grid.style.display = 'none';
    emptyEl.style.display = 'none';
    loading.style.display = 'flex';
    try {
      const results = await searchRobloxGames(query);
      // Only apply if search box still has same value
      if (document.getElementById('chart-search').value.trim() === query) {
        renderCharts(results, true);
      }
    } catch(e) {
      console.error('Search error:', e);
      loading.style.display = 'none';
      emptyEl.style.display = 'flex';
    }
  }, 420);
}

let _gameModal = {};
function openGameModal(idx) {
  const g = _chartGameMap[idx];
  if (!g) return;
  _gameModal = g;
  const thumb = document.getElementById('game-modal-thumb');
  if (g.thumbUrl) { thumb.src = g.thumbUrl; thumb.style.display = 'block'; }
  else { thumb.style.display = 'none'; }
  document.getElementById('game-modal-name').textContent = g.name || 'Unknown';
  document.getElementById('game-modal-id').textContent = g.placeId || '-';
  const stat = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing now' : '';
  document.getElementById('game-modal-stat').textContent = stat;
  openModal('m-game');
}
function copyGameId() {
  const id = String(_gameModal.placeId || '');
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => toast(t('acct.placeCopied'), 'ok'));
}
function gamePageOpen() {
  if (_gameModal.placeId) api.openExternal('https://www.roblox.com/games/' + _gameModal.placeId);
}


// ── Mixer (graphics / fps / volume / kill) ─────────────────────────────────
const FF_GFX = 'DFIntDebugFRMQualityLevelOverride';
const FF_FPS = 'DFIntTaskSchedulerTargetFps';
let _volTimer = null, _mixRunning = 0;

async function mixInit() {
  // Pull current values from saved Fast Flags + settings.
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}

  // Graphics
  const gfxRaw = flags[FF_GFX];
  const gfxAuto = (gfxRaw === undefined || gfxRaw === null || gfxRaw === '');
  document.getElementById('mix-gfx-auto').checked = gfxAuto;
  const gfxVal = clampInt(gfxRaw, 1, 21, 10);
  document.getElementById('mix-gfx').value = gfxVal;
  document.getElementById('mix-gfx-val').textContent = gfxAuto ? 'Auto' : gfxVal;
  document.getElementById('mix-gfx').disabled = gfxAuto;

  // FPS - read from GlobalBasicSettings_13.xml via new ipc
  try {
    const fpsCap = await api.readFpsCap();
    const fpsUnl = (fpsCap === 0);
    document.getElementById('mix-fps-unl').checked = fpsUnl;
    document.getElementById('mix-fps').value = fpsUnl ? 60 : Math.max(10, fpsCap || 60);
    document.getElementById('mix-fps-val').textContent = fpsUnl ? '\u221e' : (fpsCap || 60);
    document.getElementById('mix-fps').disabled = fpsUnl;
  } catch {}

  // Volume
  const vol = (typeof settings.masterVolume === 'number') ? settings.masterVolume : 100;
  document.getElementById('mix-vol').value = vol;
  document.getElementById('mix-vol-val').textContent = vol + '%';

  updateSliderFill(document.getElementById('mix-gfx'));
  updateSliderFill(document.getElementById('mix-fps'));
  updateSliderFill(document.getElementById('mix-vol'));
  mixRefreshRunning();
}

// FPS
function mixFpsInput(v) {
  v = parseInt(v, 10);
  const snapped = v >= 9999 ? 9999 : Math.round(v / 5) * 5;
  const sl = document.getElementById('mix-fps');
  if (sl.value != snapped) sl.value = snapped;
  document.getElementById('mix-fps-val').textContent = snapped;
  updateSliderFill(sl);
}
async function mixFpsUnlToggle() {
  const unl = document.getElementById('mix-fps-unl').checked;
  document.getElementById('mix-fps').disabled = unl;
  if (unl) {
    document.getElementById('mix-fps-val').textContent = '\u221e';
    const res = await api.writeFpsCap(0);
    if (res && res.ok === false) toast(res.error || 'Failed to set FPS cap', 'err');
    else toast(t('mixer.fpsUnlimited'), 'ok');
  } else {
    mixFpsCommit();
  }
}
async function mixFpsCommit() {
  if (document.getElementById('mix-fps-unl').checked) return;
  const v = parseInt(document.getElementById('mix-fps').value, 10);
  document.getElementById('mix-fps-val').textContent = v;
  const res = await api.writeFpsCap(v);
  if (res && res.ok === false) { toast(res.error || 'Failed to set FPS cap', 'err'); return; }
  toast(t('mixer.fpsCap', { v: v }), 'ok');
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function setRunningBadges(n) {
  const txt = n + ' running';
  const tb = document.getElementById('tb-running');
  if (tb) {
    tb.textContent = txt;
    tb.classList.toggle('live', n > 0);
    tb.style.display = n > 0 ? 'inline-flex' : 'none';
  }
  updateWindowTitle(n);
  renderDashboard();
}

// Reflects the running count in the window/tab title: "(3) KNT Manager".
function updateWindowTitle(n) {
  const base = t('app.name') || 'KNT Manager';
  const title = n > 0 ? `(${n}) ${base}` : base;
  document.title = title;
  if (api && typeof api.setTitle === 'function') api.setTitle(title);
}

let _statusPoll = null;
let _lastCountPushAt = 0;
async function pollRunningCount() {
  // Skip if a push from the backend landed recently.
  if (Date.now() - _lastCountPushAt < 6500) return;
  let n = 0;
  try { n = await api.getRunningCount(); } catch { n = 0; }
  _mixRunning = n;
  setRunningBadges(n);
}

// Reconciles card state against the backend's watched/alive list, in case a
// push event (onRobloxClosed etc) was missed or lagged.
async function pollWatchedIds() {
  let ids;
  try { ids = await api.getWatchedIds(); } catch { return; }
  // Backend returns [{ id, startedAt }] (real start time in ms epoch); older
  // shapes (plain string arrays) still work via the fallback below.
  const watched = new Map((Array.isArray(ids) && ids.length && typeof ids[0] === 'object' && ids[0])
    ? ids.map(x => [x.id, x.startedAt || 0])
    : (Array.isArray(ids) ? ids.map(id => [id, 0]) : []));
  // Cards that drop out of the active filter get pulled from the DOM
  // directly instead of a full render(), which would replay entrance
  // animations and flicker on every poll tick.
  const dropFromFilter = (_acctFilter === 'running' || _acctFilter === 'idle')
    ? id => (_acctFilter === 'running' ? !watched.has(id) : watched.has(id))
    : null;
  let changed = false;
  document.querySelectorAll('.card[data-id]').forEach(card => {
    const id = card.dataset.id;
    const shouldBeLive = watched.has(id);
    const isLive = card.classList.contains('is-live');
    if (shouldBeLive !== isLive) {
      changed = true;
      card.classList.toggle('is-live', shouldBeLive);
      const dot = card.querySelector('.card-dot');
      if (dot) {
        dot.classList.toggle('launched', shouldBeLive);
        dot.title = shouldBeLive ? 'Launched' : 'Not launched';
      }
      if (shouldBeLive) {
        _launchedIds.add(id);
        const st = watched.get(id);
        if (st > 0) _launchedAt[id] = st; // real start time from the backend
        else if (!_launchedAt[id]) _launchedAt[id] = Date.now();
        ensureCardUp(card, id);
      } else {
        _launchedIds.delete(id);
        delete _launchedAt[id];
        const up = card.querySelector('.card-up');
        if (up) up.remove();
      }
      if (dropFromFilter && dropFromFilter(id)) card.remove();
    }
  });
  // Live status changed → keep the running-first order in real time, no
  // manual Sync needed.
  if (changed) reorderCardsByStatus();

  // Reconcile home state (accounts that went to the Roblox tray)
  try {
    const homeIds = await api.getHomeIds();
    const homeSet = new Set(homeIds);
    const prevHome = new Set(_homeIds);
    _homeIds.clear();
    for (const id of homeIds) _homeIds.add(id);
    document.querySelectorAll('.card[data-id]').forEach(card => {
      const id = card.dataset.id;
      const wasHome = prevHome.has(id);
      const isNowHome = homeSet.has(id);
      if (wasHome !== isNowHome) {
        changed = true;
        card.classList.toggle('is-home', isNowHome);
        const dot = card.querySelector('.card-dot');
        if (dot) {
          dot.classList.toggle('home', isNowHome);
          const isLive = watched.has(id);
          dot.title = isNowHome ? t('accounts.home') : (isLive ? 'Launched' : 'Not launched');
        }
        const badge = card.querySelector('.card-home-badge');
        if (isNowHome && !badge) {
          const uid = card.querySelector('.card-uid');
          if (uid) uid.insertAdjacentHTML('afterend', `<div class="card-home-badge">${esc(t('accounts.home'))}</div>`);
        } else if (!isNowHome && badge) badge.remove();
      }
    });
  } catch {}
  updateCloseHomeBtn();
}
function pollStatus() {
  pollRunningCount();
  pollWatchedIds();
}
function startStatusPoll() {
  if (_statusPoll) return;
  pollStatus();
  _statusPoll = setInterval(pollStatus, 3000);
  setInterval(() => {
    if (!document.getElementById('page-accounts')?.classList.contains('active')) return;
    document.querySelectorAll('.card.is-live .card-up').forEach(el => {
      const id = el.closest('.card')?.dataset.id;
      if (id && _launchedAt[id]) el.textContent = fmtUptime(_launchedAt[id]);
    });
  }, 30000);
}

async function mixRefreshRunning() {
  try {
    _mixRunning = await api.getRunningCount();
  } catch { _mixRunning = 0; }
  setRunningBadges(_mixRunning);
  // No guessing which accounts are live from lastUsed any more: the count now
  // only includes instances the backend actually tracks, and pollWatchedIds()
  // syncs the real set every 3s, so a guess could only mislabel cards.
}

// Merge a single key into the on-disk Fast Flags without disturbing others.
async function mixWriteFlag(key, value) {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  if (value === null) delete flags[key];
  else flags[key] = String(value);
  try { await api.writeFFlags(flags); } catch {}
}

// ── Rendering engine (Settings > Performance) ────────────────────────────
// D3D9 removed -- Roblox dropped that render path, forcing it now crashes
// the client with a missing-DLL error instead of falling back.
const RENDER_ENGINE_FLAGS = {
  d3d11: 'FFlagDebugGraphicsPreferD3D11',
  opengl: 'FFlagDebugGraphicsPreferOpenGL',
  vulkan: 'FFlagDebugGraphicsPreferVulkan',
};
const RENDER_ENGINE_LABELS = { '': 'Automatic', d3d11: 'Direct3D 11', opengl: 'OpenGL', vulkan: 'Vulkan' };

async function renderEngineInit() {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  // Purge a stale D3D9 flag from before it was removed -- forcing it now
  // crashes the client on launch instead of degrading gracefully.
  if ('FFlagDebugGraphicsPreferD3D9' in flags) {
    delete flags['FFlagDebugGraphicsPreferD3D9'];
    try { await api.writeFFlags(flags); } catch {}
  }
  let current = '';
  for (const [engine, flagName] of Object.entries(RENDER_ENGINE_FLAGS)) {
    if (String(flags[flagName]).toLowerCase() === 'true') { current = engine; break; }
  }
  renderEngineUpdateUI(current);
}

function renderEngineUpdateUI(engine) {
  const label = document.getElementById('cdd-rendereng-label');
  if (label) label.textContent = RENDER_ENGINE_LABELS[engine] || 'Automatic';
  document.querySelectorAll('#cdd-rendereng-menu .cdd-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.value === engine));
}

async function setRenderEngine(engine) {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  for (const flagName of Object.values(RENDER_ENGINE_FLAGS)) delete flags[flagName];
  if (engine && RENDER_ENGINE_FLAGS[engine]) flags[RENDER_ENGINE_FLAGS[engine]] = 'True';
  try { await api.writeFFlags(flags); } catch {}
  renderEngineUpdateUI(engine);
  closeAllCdd();
  toast(t('mixer.renderEngine', { eng: RENDER_ENGINE_LABELS[engine] || t('settings.renderAutomatic') }), 'ok');
}

// ── Roblox deployment channel (Settings > Roblox) ─────────────────────────
const ROBLOX_CHANNEL_LABELS = { '': 'Production (LIVE)', zcanary: 'Canary', zintegration: 'Integration', znext: 'Next' };

function robloxChannelUpdateUI(channel) {
  const label = document.getElementById('cdd-channel-label');
  if (label) label.textContent = ROBLOX_CHANNEL_LABELS[channel] || 'Production (LIVE)';
  document.querySelectorAll('#cdd-channel-menu .cdd-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.value === channel));
}

// ── Custom launcher (e.g. Fishtrap) ──────────────────────────────────────
function saveLauncherPath() {
  const el = document.getElementById('set-launcher-path');
  const v = el ? el.value.trim() : '';
  settings.launcherPath = v;
  api.saveSettings({ launcherPath: v }).catch(() => {});
}
async function pickLauncherPath() {
  // Browser demo: native dialog unavailable — use a hidden file input.
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.exe';
    input.onchange = () => {
      const p = input.files && input.files[0];
      if (p) {
        const el = document.getElementById('set-launcher-path');
        if (el) { el.value = p.name; saveLauncherPath(); }
      }
    };
    input.click();
  } catch (e) { /* noop */ }
}

function setRobloxChannel(channel) {
  settings.robloxChannel = channel;
  api.saveSettings({ robloxChannel: channel });
  robloxChannelUpdateUI(channel);
  closeAllCdd();
  toast(t('mixer.robloxChannel', { ch: ROBLOX_CHANNEL_LABELS[channel] || 'Production (LIVE)' }) + (settings.lockChannel ? '' : t('mixer.channelHint')), 'ok');
  if (settings.lockChannel) detectRobloxVersion();
}

// Smoothly fill the slider track up to the current value.
function updateSliderFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100, v = parseFloat(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.background = 'linear-gradient(90deg, var(--ac) ' + pct + '%, var(--s4) ' + pct + '%)';
}

// Delegated listener so slider fill stays correct without every call site remembering to update it.
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('.fps-slider')) updateSliderFill(e.target);
});

// Graphics
function mixGfxInput(v) {
  document.getElementById('mix-gfx-val').textContent = v;
  updateSliderFill(document.getElementById('mix-gfx'));
}
function mixGfxAutoToggle() {
  const auto = document.getElementById('mix-gfx-auto').checked;
  document.getElementById('mix-gfx').disabled = auto;
  if (auto) {
    document.getElementById('mix-gfx-val').textContent = 'Auto';
    mixWriteFlag(FF_GFX, null);
    toast(t('mixer.gfxAuto'), 'ok');
  } else {
    mixGfxCommit();
  }
}
function mixGfxCommit() {
  if (document.getElementById('mix-gfx-auto').checked) return;
  const v = document.getElementById('mix-gfx').value;
  document.getElementById('mix-gfx-val').textContent = v;
  mixWriteFlag(FF_GFX, v);
  toast(t('mixer.gfxQuality', { v: v }), 'ok');
}

// Volume - applies live while dragging (debounced so we don't spawn the helper
// on every drag tick), and saves + confirms on release.
function mixVolInput(v) {
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  clearTimeout(_volTimer);
  _volTimer = setTimeout(() => { api.setRobloxVolume(parseInt(v, 10)); }, 90);
}
function mixVolCommit() {
  const v = parseInt(document.getElementById('mix-vol').value, 10);
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  settings.masterVolume = v;
  api.saveSettings({ masterVolume: v });
  clearTimeout(_volTimer);
  _volTimer = setTimeout(async () => {
    const res = await api.setRobloxVolume(v);
    if (res && res.ok) {
      toast(t('mixer.volumeSet', { v: v }), 'ok');
    } else {
      toast(t('mixer.volumeFail') + (res && res.error ? ': ' + res.error : ''), 'err');
    }
  }, 60);
}

// Kill all — safety confirm: first click starts a 3s countdown ("Confirmar
// (3)" → "(2)" → "(1)") during which the button is disabled, then the button
// stays armed for 5s. Clicking inside that window executes; otherwise the
// confirmation reverts on its own. All timers live in the single _killConfirm
// slot, so re-arming can never stack timers or listeners.
let _killConfirm = null; // { btn, phase: 'counting'|'ready', countTimer, timer }

function mixKillAll(btn) {
  if (!btn) btn = document.querySelector('.kill-roblox-btn');
  if (!btn || btn.disabled) return;
  // Armed and waiting for the click? Execute.
  if (_killConfirm && _killConfirm.btn === btn && _killConfirm.phase === 'ready') {
    clearTimeout(_killConfirm.timer);
    _killConfirm = null;
    _restoreKillBtn(btn);
    doKillAll();
    return;
  }
  // Any previous confirmation (stale or from another kill button) is dropped.
  _resetKillConfirm();
  btn.dataset.killOrig = btn.innerHTML;
  btn.classList.add('kill-confirming');
  let n = 3;
  _setKillLabel(btn, t('mixer.killCount', { n }));
  btn.disabled = true; // blocked during the countdown
  _killConfirm = {
    btn,
    phase: 'counting',
    countTimer: setInterval(() => {
      if (!_killConfirm || _killConfirm.btn !== btn) return;
      n--;
      if (n > 0) {
        _setKillLabel(btn, t('mixer.killCount', { n }));
      } else {
        clearInterval(_killConfirm.countTimer);
        _setKillLabel(btn, t('mixer.killConfirm'));
        btn.disabled = false;
        _killConfirm.phase = 'ready';
        // 5s to confirm; after that the confirmation disappears on its own.
        _killConfirm.timer = setTimeout(_resetKillConfirm, 5000);
      }
    }, 1000),
  };
}

function _setKillLabel(btn, text) {
  btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">warning</span><span>' + esc(text) + '</span>';
}

function _resetKillConfirm() {
  if (!_killConfirm) return;
  if (_killConfirm.countTimer) clearInterval(_killConfirm.countTimer);
  if (_killConfirm.timer) clearTimeout(_killConfirm.timer);
  const btn = _killConfirm.btn;
  _killConfirm = null;
  _restoreKillBtn(btn);
}
function _restoreKillBtn(btn) {
  if (!btn) return;
  btn.disabled = false;
  if (btn.dataset.killOrig === undefined) return;
  btn.innerHTML = btn.dataset.killOrig;
  delete btn.dataset.killOrig;
  btn.classList.remove('kill-confirming');
}

async function doKillAll() {
  const btns = Array.from(document.querySelectorAll('.kill-roblox-btn'));
  if (!btns.length || btns[0].disabled) return;
  btns.forEach(b => { b.disabled = true; });
  const res = await api.killAllRoblox();
  // Reset all dots / launched state.
  _launchedIds.clear();
  _homeIds.clear();
  document.querySelectorAll('.card.is-live').forEach(c => c.classList.remove('is-live'));
  document.querySelectorAll('.card.is-home').forEach(c => c.classList.remove('is-home'));
  document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched'); d.title = 'Not launched'; });
  document.querySelectorAll('.card-dot.home').forEach(d => { d.classList.remove('home'); d.title = 'Not launched'; });
  document.querySelectorAll('.card-home-badge').forEach(b => b.remove());
  refreshPkgAvatarStatus();
  await mixRefreshRunning();
  btns.forEach(b => { b.disabled = false; });
  if (res && res.ok) {
    const n = res.killed || 0;
    const msg = n === 1 ? t('mixer.closedOne', { n }) : t('mixer.closedN', { n });
    toast(msg, 'err');
  } else toast(t('acct.killFailed') + (res && res.error ? ': ' + res.error : ''), 'err');
}

// Re-pushes current graphics/fps/volume values and confirms; doesn't touch
// any running process (that's the separate Kill all Roblox button).
async function mixApply() {
  const btn = document.getElementById('mix-relaunch-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const orig = btn.innerHTML;

  mixGfxCommit();
  mixFpsCommit();
  try { await api.setRobloxVolume(document.getElementById('mix-vol').value); } catch {}

  btn.disabled = false;
  btn.innerHTML = orig;
  toast(t('settings.applied'), 'ok');
}

async function mixTrimMemory(btnId = 'set-trim-btn') {
  const btn = document.getElementById(btnId);
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.innerHTML;

  let res;
  try { res = await api.trimRobloxMemory(); } catch { res = null; }

  btn.disabled = false;
  btn.innerHTML = orig;
  if (res && res.ok) {
    toast(res.total > 0 ? t('mixer.trimmedN', { t: res.trimmed, tot: res.total }) : t('mixer.noRunning'), 'ok');
  } else {
    toast(t('acct.trimFailed'), 'err');
  }
}

function genToggleKey() {
  const inp = document.getElementById('gen-apikey');
  const icon = document.getElementById('gen-eye-icon');
  if (inp.type === 'password') { inp.type = 'text'; icon.textContent = 'visibility_off'; }
  else { inp.type = 'password'; icon.textContent = 'visibility'; }
}

// Literal values BloxGen's API expects for `type`, confirmed against their
// own /api/prices response (which echoes these back as its object keys) --
// the docs only ever show these as human-readable labels in prose, and
// guessing at slugs like "30day" instead would have silently 400'd.
const GEN_TYPES = [
  { value: 'alt', label: 'Alt', desc: 'Fresh alt accounts' },
  { value: '+30 days old', label: '+30 days old', desc: 'Accounts aged 30+ days' },
  { value: '+1 year old', label: '+1 year old', desc: 'Accounts aged 1+ year' },
  { value: '5+ years old', label: '5+ years old', desc: 'Accounts aged 5+ years' },
  { value: 'dump', label: 'Dump', desc: 'Dump accounts with extra account metadata' },
];
let _genType = 'alt';

// Account-type selection only applies to BloxGen (Altgen has no equivalent
// tiers in what this app sends it), so the row hides itself for an Altgen
// key instead of showing a control that does nothing.
function genOnKeyInput() {
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();
  const row = document.getElementById('gen-type-row');
  if (row) row.style.display = apiKey.startsWith('BLOX-') ? '' : 'none';
}

// Value -> i18n key pairs for the account-type dropdown; the passed label/desc
// args from the HTML onclick are ignored so the labels follow the UI language.
const GEN_TYPE_I18N = {
  'alt': ['gen.alt', 'gen.altDesc'],
  '+30 days old': ['gen.type30', 'gen.type30Desc'],
  '+1 year old': ['gen.type1y', 'gen.type1yDesc'],
  '5+ years old': ['gen.type5y', 'gen.type5yDesc'],
  'dump': ['gen.dump', 'gen.dumpDesc'],
};
function genSetType(value, label, desc) {
  _genType = value;
  const keys = GEN_TYPE_I18N[value] || ['gen.alt', 'gen.altDesc'];
  const lbl = document.getElementById('cdd-gentype-label');
  const dsc = document.getElementById('gen-type-desc');
  if (lbl) lbl.textContent = t(keys[0]);
  if (dsc) dsc.textContent = t(keys[1]);
  document.querySelectorAll('#cdd-gentype-menu .cdd-option').forEach(o => {
    o.classList.toggle('selected', o.dataset.value === value);
  });
  try { localStorage.setItem('bloxgen_type', value); } catch {}
  closeAllCdd();
}

// Provider is auto-detected from the key's prefix so the single API-key field
// works for either service: BLOX- = BloxGen, MG_ = Altgen (altgen.me/docs).
async function genCombo() {
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();
  try { localStorage.setItem('bloxgen_apikey', document.getElementById('gen-apikey').value); } catch {}

  let provider;
  if (apiKey.startsWith('BLOX-')) provider = 'bloxgen';
  else if (apiKey.startsWith('MG_')) provider = 'altgen';
  else {
    toast(t('gen.apiKeyBad'), 'err');
    return;
  }

  const btn = document.getElementById('gen-btn');
  const out = document.getElementById('gen-output');
  const btnLabel = btn ? btn.querySelector('span:last-child') : null;
  if (btn) { btn.disabled = true; if (btnLabel) btnLabel.textContent = t('gen.generating'); }

  try {
    const d = provider === 'bloxgen' ? await genBloxgen(apiKey) : await genAltgen(apiKey);

    out.value = d.username + ':' + d.password;
    out.select();

    const counter = document.getElementById('gen-counter');
    if (counter) counter.textContent = d.type ? ('Generated: ' + d.type + (d.cost != null ? ' · cost ' + d.cost : '')) : '';

    // Store in history
    if (_genClearPromise) await _genClearPromise;
    _lastGenData = d;
    _genHistory.unshift({ username: d.username, password: d.password, cookie: d.cookie, ts: Date.now(), ok: true, provider, type: _genType });
    if (_genHistory.length > 500) _genHistory.length = 500;
    api.writeGenHistory(_genHistory).catch(() => {});
    _ghPrepend();

    // Copy cookie to clipboard if available, else username:password
    const toCopy = d.cookie || (d.username + ':' + d.password);
    navigator.clipboard.writeText(toCopy).catch(() => {});

    if (btn) { btn.disabled = false; if (btnLabel) btnLabel.textContent = 'Generate'; }

  } catch (e) {
    if (_genClearPromise) await _genClearPromise;
    _genHistory.unshift({ username: null, password: null, cookie: null, ts: Date.now(), ok: false, provider, type: _genType, error: e.message || t('gen.genFailed') });
    if (_genHistory.length > 500) _genHistory.length = 500;
    api.writeGenHistory(_genHistory).catch(() => {});
    _ghPrepend();
    toast(e.message || t('gen.genFailed'), 'err');
    if (btn) { btn.disabled = false; if (btnLabel) btnLabel.textContent = t('gen.generate'); }
  }
}

async function genBloxgen(apiKey) {
  const resp = await fetch('https://core.bloxgen.net/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, type: _genType })
  });
  const data = await resp.json();
  if (!data.success) throw new Error(data.message || data.error || t('gen.genFailed'));
  return data.data;
}

async function genAltgen(apiKey) {
  const res = await api.altgenGenerate(apiKey, 1);
  const data = res.data;
  if (!data || !data.success) {
    throw new Error((data && data.error && data.error.message) || t('gen.genFailed'));
  }
  const acct = data.data && data.data.accounts && data.data.accounts[0];
  if (!acct) throw new Error(t('gen.noAccount'));
  return { username: acct.username, password: acct.password, cookie: acct.cookie };
}

// ── Manual account creation (Generator tab) ────────────────────────────────
// Completely independent from the BloxGen/Altgen flow above: generates a
// username + password here, then opens the official Roblox signup page with
// them (plus a random birthday, generated at autofill time by the backend)
// filled in automatically. Once the account is created, its session is
// captured and added through the same add-account path as a normal login.
let _manualCreds = null;
let _manualResult = null;

const MAN_WORDS = [
  'Wolf','Dragon','Falcon','Tiger','Shark','Eagle','Storm','Blaze','Frost','Shadow',
  'Thunder','Viper','Panther','Cobra','Raptor','Comet','Nova','Pulse','Bolt','Stealth',
  'Neon','Cosmo','Turbo','Quantum','Cipher','Phantom','Raven','Onyx','Ember','Gale',
];

function manRandomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function manRandomUsername() {
  const existing = new Set(accounts.map(a => (a.username || '').toLowerCase()));
  let tries = 0;
  while (tries++ < 200) {
    const word = MAN_WORDS[manRandomInt(MAN_WORDS.length)];
    const username = word + String(10000 + manRandomInt(90000));
    if (!existing.has(username.toLowerCase())) return username;
  }
  return MAN_WORDS[manRandomInt(MAN_WORDS.length)] + Date.now().toString(36);
}

function manRandomPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%*_-+=?';
  const all = upper + lower + digits + special;
  const pick = set => set[manRandomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(special)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = manRandomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function manRenderCreds() {
  const userEl = document.getElementById('man-user');
  const passEl = document.getElementById('man-pass');
  const creds = document.getElementById('man-creds');
  const genBtn = document.getElementById('man-gen-btn');
  const regBtn = document.getElementById('man-reg-btn');
  const addBtn = document.getElementById('man-add-btn');
  if (!_manualCreds || !_manualCreds.username || !_manualCreds.password) return;
  if (userEl) userEl.textContent = _manualCreds.username;
  if (passEl) passEl.textContent = _manualCreds.password;
  if (creds) creds.style.display = 'flex';
  if (genBtn) genBtn.style.display = 'none';
  if (regBtn) regBtn.style.display = '';
  if (addBtn) addBtn.disabled = false;
  manSetStatus('hidden', '');
}

async function manGen() {
  const genBtn = document.getElementById('man-gen-btn');
  if (genBtn) genBtn.disabled = true;
  manSetStatus('load', '<div class="spin"></div>' + esc(t('gen.man.checking')));
  let username = manRandomUsername();
  for (let i = 0; i < 20; i++) {
    try {
      const res = await api.robloxGet('https://auth.roblox.com/v1/usernames/validate?Username=' + encodeURIComponent(username) + '&Birthday=2000-01-01');
      const code = res && res.data && res.data.code;
      if (code === 0) break;
      username = manRandomUsername();
    } catch {
      break;
    }
  }
  _manualCreds = { username, password: manRandomPassword() };
  _manualResult = null;
  try { localStorage.setItem('mr_manual_creds', JSON.stringify(_manualCreds)); } catch {}
  if (genBtn) genBtn.disabled = false;
  manRenderCreds();
}

function manCopy(id) {
  const el = document.getElementById(id);
  if (!el || !el.textContent) { toast(t('gen.man.nothing'), 'err'); return; }
  navigator.clipboard.writeText(el.textContent).then(() => {
    toast(id === 'man-user' ? t('gen.man.copiedUser') : t('gen.man.copiedPass'), 'ok');
  }).catch(() => {});
}

function manSetStatus(cls, html) {
  const status = document.getElementById('man-status');
  if (!status) return;
  status.className = 'mst ' + cls;
  status.innerHTML = html;
}

async function manOpenSignup() {
  if (!_manualCreds) { toast(t('gen.man.genFirst'), 'err'); return; }
  const addBtn = document.getElementById('man-add-btn');
  if (addBtn) addBtn.disabled = true;
  manSetStatus('load', '<div class="spin"></div>' + esc(t('gen.man.opening')));
  let res;
  try {
    res = await api.openSignup(_manualCreds.username, _manualCreds.password);
  } catch (e) {
    manSetStatus('err', '<span class="material-icons-round">error_outline</span>' + esc(e.message || t('gen.man.failedOpen')));
    if (addBtn) addBtn.disabled = false;
    return;
  }
  if (!res) { if (addBtn) addBtn.disabled = false; return; }
  if (res.closed) {
    manSetStatus('', '<span style="color:var(--t3)">' + esc(t('gen.man.closed')) + '</span>');
    if (addBtn) addBtn.disabled = false;
    return;
  }
  if (!res.success) {
    manSetStatus('err', '<span class="material-icons-round">error_outline</span>' + esc(res.error || 'Could not create the account'));
    if (addBtn) addBtn.disabled = false;
    return;
  }
  _manualResult = res;
  manSetStatus('ok',
    '<span class="material-icons-round">check_circle</span>' + esc(t('gen.man.created', { user: res.username })) + ' ' +
    '<button class="btn btn-primary" onclick="manAddAccount()" style="margin-left:8px;height:30px;padding:0 12px;font-size:11.5px"><span class="material-icons-round" style="font-size:14px">person_add</span>' + esc(t('gen.man.addTo')) + '</button>' +
    '<button class="btn btn-ghost" onclick="manDiscard()" style="margin-left:6px;height:30px;padding:0 10px;font-size:11.5px">' + esc(t('common.discard')) + '</button>');
  if (addBtn) addBtn.disabled = false;
}

async function manAddAccount() {
  const res = _manualResult;
  if (!res || !res.cookie) { toast(t('gen.man.noSession'), 'err'); return; }
  const btn = document.querySelector('#man-status .btn-primary');
  if (btn) btn.disabled = true;
  try {
    const password = _manualCreds?.password || '';
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: res.cookie, gameTarget: '', nickname: '', password });
    if (a) {
      accounts.push(a); render();
      toast(t('gen.added', { user: res.username }), 'ok');
    }
    manDiscard();
  } catch (e) {
    toast(t('gen.addFailed', { err: (e && e.message) || e }), 'err');
    if (btn) btn.disabled = false;
  }
}

function manDiscard() {
  _manualResult = null;
  manSetStatus('hidden', '');
}

let _genHistory = [];
let _lastGenData = null;
let _ghQuery = '';
let _ghFilter = 'all';

const GH_ITEM_H = 36;
const GH_VISIBLE = 4;
const GH_BATCH = 40;
let _ghRendered = 0;

function genHistVisible() {
  let list = _genHistory;
  if (_ghQuery) {
    const q = _ghQuery.toLowerCase();
    list = list.filter(h => (h.username || '').toLowerCase().includes(q));
  }
  if (_ghFilter === 'ok') list = list.filter(h => h.ok);
  else if (_ghFilter === 'err') list = list.filter(h => !h.ok);
  return list;
}
function toggleGenHistFilter(e) {
  if (e) e.stopPropagation();
  document.getElementById('gen-hist-filter-menu')?.classList.toggle('open');
}
function setGenHistFilter(f) {
  _ghFilter = f;
  document.querySelectorAll('#gen-hist-filter-menu button[data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  const lbl = document.getElementById('gen-hist-filter-label');
  if (lbl) lbl.textContent = t(f === 'ok' ? 'gen.histOk' : f === 'err' ? 'gen.histErr' : 'gen.histAll');
  document.getElementById('gen-hist-filter-menu')?.classList.remove('open');
  genRenderHistory();
}
function ghTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function ghRowHtml(h, i) {
  if (h.ok === false) {
    return '<div class="gen-hist-item err" data-idx="' + i + '">' +
      '<span class="gh-user"><span class="gh-badge err">' + esc(t('gen.histErr')) + '</span> ' + esc(h.error || t('gen.genFailed')) + '</span>' +
      '<span class="gh-time">' + esc(ghTime(h.ts)) + '</span>' +
      '<div class="gh-actions"><button class="btn btn-ghost" onclick="genHistRegen(' + i + ')"><span class="material-icons-round" style="font-size:15px">refresh</span></button></div></div>';
  }
  return '<div class="gen-hist-item" data-idx="' + i + '">' +
    '<span class="gh-user"><span style="color:var(--t3)">' + esc(t('gen.user')) + '</span> ' + esc(h.username) + '  <span style="color:var(--t3)">' + esc(t('gen.pass')) + '</span> ' + esc(h.password) + '</span>' +
    '<span class="gh-time">' + esc(ghTime(h.ts)) + '</span>' +
    '<div class="gh-actions">' +
      '<button class="btn btn-ghost" onclick="genHistCopy(' + i + ')"><span class="material-icons-round" style="font-size:15px">content_copy</span></button>' +
      '<button class="btn btn-ghost" onclick="genHistAdd(' + i + ')"><span class="material-icons-round" style="font-size:15px">person_add</span></button>' +
      '<button class="btn btn-ghost" onclick="genHistRegen(' + i + ')"><span class="material-icons-round" style="font-size:15px">refresh</span></button>' +
    '</div></div>';
}

function genRenderHistory() {
  const list = document.getElementById('gen-history-list');
  const sc = document.getElementById('gen-history-sc');
  if (!list || !sc) return;
  _ghQuery = (document.getElementById('gen-hist-search')?.value || '').trim().toLowerCase();
  const vis = genHistVisible();
  if (vis.length === 0) {
    sc.style.display = 'none';
    list.innerHTML = '';
    list.style.maxHeight = '';
    _ghRendered = 0;
    return;
  }
  sc.style.display = '';
  if (vis.length > GH_VISIBLE) {
    list.style.maxHeight = (GH_ITEM_H * GH_VISIBLE) + 'px';
  } else {
    list.style.maxHeight = '';
  }
  _ghRendered = 0;
  list.innerHTML = '';
  _ghAppendBatch(list);
  list.onscroll = () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 20) _ghAppendBatch(list);
  };
}

function _ghAppendBatch(list) {
  const vis = genHistVisible();
  const end = Math.min(_ghRendered + GH_BATCH, vis.length);
  if (_ghRendered >= end) return;
  const frag = document.createDocumentFragment();
  for (let i = _ghRendered; i < end; i++) {
    const row = document.createElement('div');
    row.innerHTML = ghRowHtml(vis[i], i);
    frag.appendChild(row.firstChild);
  }
  list.appendChild(frag);
  _ghRendered = end;
}

function _ghPrepend() {
  const list = document.getElementById('gen-history-list');
  const sc = document.getElementById('gen-history-sc');
  if (!list || !sc) return;
  sc.style.display = '';
  if (genHistVisible().length > GH_VISIBLE) list.style.maxHeight = (GH_ITEM_H * GH_VISIBLE) + 'px';
  list.querySelectorAll('.gen-hist-item').forEach(row => {
    const old = +row.dataset.idx;
    const ni = old + 1;
    row.dataset.idx = ni;
    row.querySelectorAll('button').forEach(b => {
      const on = b.getAttribute('onclick');
      if (on) b.setAttribute('onclick', on.replace(/\(\d+\)/g, '(' + ni + ')'));
    });
  });
  _ghRendered++;
  const h = genHistVisible()[0];
  if (!h) return;
  const row = document.createElement('div');
  row.innerHTML = ghRowHtml(h, 0);
  list.insertBefore(row.firstChild, list.firstChild);
  list.scrollTop = 0;
}

function genHistCopy(i) {
  const h = genHistVisible()[i];
  if (!h || !h.username) return;
  navigator.clipboard.writeText(h.username + ':' + h.password).then(() => toast(t('gen.copied', { u: h.username }), 'ok'));
}

async function genHistAdd(i) {
  const h = genHistVisible()[i];
  if (!h || !h.cookie) { toast(t('gen.noCookie'), 'err'); return; }
  try {
    const res = await api.validateCookie(h.cookie);
    if (!res || !res.username) { toast(t('gen.cookieInvalid'), 'err'); return; }
    const password = h.password || '';
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: h.cookie, gameTarget: '', nickname: '', password });
    if (a) { accounts.push(a); render(); toast(t('gen.added', { user: res.username }), 'ok'); }
  } catch(e) { toast(t('acct.addFailed', { msg: e.message }), 'err'); }
}

function genHistRegen(i) {
  const h = genHistVisible()[i];
  if (!h) return;
  if (h.provider === 'altgen') {
    const key = (document.getElementById('gen-apikey').value || '').trim();
    if (!key.startsWith('MG_')) { toast(t('gen.needAltgenKey'), 'err'); return; }
  } else if (h.provider === 'bloxgen') {
    const key = (document.getElementById('gen-apikey').value || '').trim();
    if (!key.startsWith('BLOX-')) { toast(t('gen.needBloxgenKey'), 'err'); return; }
    if (h.type && GEN_TYPE_I18N[h.type]) genSetType(h.type, null, null);
  }
  genCombo();
}

async function genAddToAccounts() {
  if (!_lastGenData || !_lastGenData.cookie) { toast(t('gen.noCookie'), 'err'); return; }
  const btn = document.getElementById('gen-add-btn');
  if (btn) { btn.disabled = true; }
  try {
    const res = await api.validateCookie(_lastGenData.cookie);
    if (!res || !res.username) { toast(t('gen.cookieInvalid'), 'err'); if(btn)btn.disabled=false; return; }
    const password = _lastGenData.password || '';
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: _lastGenData.cookie, gameTarget: '', nickname: '', password });
    if (a) { accounts.push(a); render(); toast(t('gen.added', { user: res.username }), 'ok'); }
    if(btn)btn.disabled=false;
  } catch(e) { toast(t('common.failed', { msg: e.message }), 'err'); if(btn)btn.disabled=false; }
}

// Tracked so a Generate right after Clear can wait for the clear's write to land first.
let _genClearPromise = null;
async function genClearHistory() {
  _genHistory = [];
  _lastGenData = null;
  genRenderHistory();
  toast(t('gen.histCleared'), 'ok');
  _genClearPromise = api.clearGenHistory().catch(() => {});
  await _genClearPromise;
  _genClearPromise = null;
}

function genDetailsCopy() {
  const details = document.getElementById('gen-details');
  const text = details ? details.innerText.replace('copy', '').trim() : '';
  if (!text) { toast(t('gen.noDetails'), 'err'); return; }
  const btn = document.getElementById('gen-details-copy-btn');
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { const s = btn.querySelector('span:last-child'); if(s){s.textContent='done'; setTimeout(()=>{s.textContent='details';},1500);} }
    toast(t('gen.detailsCopied'), 'ok');
  });
}

function genCopy() {
  const val = document.getElementById('gen-output').value;
  if (!val) { toast(t('gen.nothingToCopy'), 'err'); return; }
  const btn = document.getElementById('gen-copy-btn');
  navigator.clipboard.writeText(val).then(() => {
    if (btn) {
      const icon = btn.querySelector('.material-icons-round');
      if (icon) { icon.textContent = 'check'; setTimeout(() => { icon.textContent = 'content_copy'; }, 1500); }
    }
    toast(t('gen.copiedClip'), 'ok');
  });
}

// ── Tracking (timed screenshots -> Discord webhook) ─────────────────────────
function getTrackingWebhookUrl() { return settings.trackingWebhookUrl || ''; }
function getTrackingIntervalSec() {
  const s = Number(settings.trackingIntervalSec);
  return Number.isFinite(s) ? Math.min(3600, Math.max(30, Math.round(s))) : 300;
}
function getTrackingTimedIds() { return new Set(Array.isArray(settings.trackingTimedIds) ? settings.trackingTimedIds : []); }
function getTrackingRegions(id) {
  const r = (settings.trackingRegions || {})[id];
  return Array.isArray(r) ? r : [];
}
function formatTrackingInterval(sec) {
  if (sec < 60) return sec + 's';
  return Math.round(sec / 60) + ' min';
}
// Strips orphaned tracking settings when an account is removed.
function forgetTrackingAccount(id) {
  let changed = false;
  const regions = Object.assign({}, settings.trackingRegions || {});
  if (id in regions) { delete regions[id]; settings.trackingRegions = regions; changed = true; }
  const timedIds = getTrackingTimedIds();
  if (timedIds.has(id)) { timedIds.delete(id); settings.trackingTimedIds = [...timedIds]; changed = true; }
  if (changed) api.saveSettings({ trackingRegions: settings.trackingRegions, trackingTimedIds: settings.trackingTimedIds });
}

function renderTrackingPage() {
  const urlInput = document.getElementById('tracking-webhook-url');
  if (urlInput) urlInput.value = getTrackingWebhookUrl();
  const interval = document.getElementById('tracking-interval');
  const intervalSec = getTrackingIntervalSec();
  if (interval) interval.value = intervalSec;
  const intervalVal = document.getElementById('tracking-interval-val');
  if (intervalVal) intervalVal.textContent = formatTrackingInterval(intervalSec);

  const container = document.getElementById('tracking-accounts');
  if (!container) return;
  const timedIds = getTrackingTimedIds();
  if (!accounts.length) {
    container.innerHTML = '<div class="tracking-empty">No accounts yet. Add an account first.</div>';
    return;
  }
  container.innerHTML = accounts.map(a => {
    const regions = getTrackingRegions(a.id);
    const metaText = regions.length ? (regions.length + ' spot' + (regions.length !== 1 ? 's' : '')) : 'Full window';
    return `
    <div class="tracking-account">
      <span class="pm-av" id="tracking-av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</span>
      <div class="tracking-account-info">
        <div class="tracking-account-name">${esc(a.nickname || a.username || 'Unknown')}</div>
        <div class="tracking-account-meta">${metaText}</div>
      </div>
      <div class="tracking-account-actions">
        <label class="toggle sm" title="Include in timed capture"><input type="checkbox" data-track-timed="${a.id}" onchange="toggleTimedTrackingAccount('${a.id}')" ${timedIds.has(a.id) ? 'checked' : ''}/><span class="toggle-trk"></span></label>
        <button class="btn btn-ghost" onclick="openRegionPicker('${a.id}')"><span class="material-icons-round" style="font-size:15px">crop</span></button>
        <button class="btn btn-ghost" data-track-capture="${a.id}" onclick="captureTrackingNow('${a.id}')" ${_launchedIds.has(a.id) ? '' : 'disabled'}><span class="material-icons-round" style="font-size:15px">photo_camera</span></button>
      </div>
    </div>`;
  }).join('');
  loadAvatarsBatch(accounts);
}

function trackingIntervalInput(v) {
  document.getElementById('tracking-interval-val').textContent = formatTrackingInterval(Number(v));
  updateSliderFill(document.getElementById('tracking-interval'));
}
function saveTrackingInterval() {
  const sec = Math.min(3600, Math.max(30, parseInt(document.getElementById('tracking-interval').value, 10) || 300));
  settings.trackingIntervalSec = sec;
  api.saveSettings({ trackingIntervalSec: sec });
  startTrackingLoop();
  toast(t('track.interval', { v: formatTrackingInterval(sec) }), 'ok');
}

async function saveTrackingWebhookUrl() {
  const input = document.getElementById('tracking-webhook-url');
  if (!input) return;
  const url = input.value.trim();
  // Clearing the field just turns tracking off; only a non-empty value has to
  // be a real Discord webhook (the backend enforces this too).
  if (url) {
    let check;
    try { check = await api.trackingValidateWebhook(url); } catch { check = null; }
    if (check && !check.ok) { toast(check.error || 'That webhook URL is not valid', 'err'); return; }
  }
  settings.trackingWebhookUrl = url;
  api.saveSettings({ trackingWebhookUrl: url });
  startTrackingLoop();
  toast(url ? 'Webhook saved' : 'Webhook cleared', 'ok');
}

function toggleTimedTrackingAccount(id) {
  const enabled = getTrackingTimedIds();
  const toggle = document.querySelector(`[data-track-timed="${id}"]`);
  if (toggle && toggle.checked) enabled.add(id); else enabled.delete(id);
  settings.trackingTimedIds = [...enabled];
  api.saveSettings({ trackingTimedIds: settings.trackingTimedIds });
  startTrackingLoop();
}

let _trackingTimer = null;
let _trackingRunning = false;
function startTrackingLoop() {
  if (_trackingTimer) clearInterval(_trackingTimer);
  _trackingTimer = null;
  if (!getTrackingTimedIds().size || !getTrackingWebhookUrl()) return;
  _trackingTimer = setInterval(captureTimedTracking, getTrackingIntervalSec() * 1000);
}

async function captureTimedTracking() {
  if (_trackingRunning) return;
  const webhookUrl = getTrackingWebhookUrl();
  if (!webhookUrl) return;
  _trackingRunning = true;
  try {
    for (const id of getTrackingTimedIds()) {
      if (!_launchedIds.has(id)) continue;
      const a = accounts.find(x => x.id === id);
      if (!a) continue;
      try { await api.trackingCaptureAndSend(id, a.nickname || a.username || id, webhookUrl, getTrackingRegions(id)); } catch {}
    }
  } finally {
    _trackingRunning = false;
  }
}

async function captureTrackingNow(id) {
  const webhookUrl = getTrackingWebhookUrl();
  if (!webhookUrl) { toast(t('track.setWebhook'), 'err'); return; }
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  const button = document.querySelector(`[data-track-capture="${id}"]`);
  if (button) button.disabled = true;
  try {
    const res = await api.trackingCaptureAndSend(id, a.nickname || a.username || id, webhookUrl, getTrackingRegions(id));
    if (res && res.ok) toast(t('track.sent'), 'ok');
    else toast((res && res.error) || 'Capture failed', 'err');
  } catch (e) {
    toast((e && e.message) || 'Capture failed', 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

// ── Region picker: drag rectangles to outline capture spots, saved as 0-1 fractions of the window.
let _regionPickerAccountId = null;
let _regionPickerDrag = null;
let _regionPickerRects = [];

async function openRegionPicker(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  if (!_launchedIds.has(id)) { toast(t('track.launchFirst'), 'err'); return; }
  _regionPickerAccountId = id;
  _regionPickerRects = getTrackingRegions(id).slice();
  openModal('m-region-picker');
  const img = document.getElementById('region-picker-img');
  img.removeAttribute('src');
  renderRegionBoxes();
  let res;
  try { res = await api.trackingCapturePreview(id); } catch { res = null; }
  if (!res || !res.ok) {
    toast((res && res.error) || 'Could not capture a preview', 'err');
    closeRegionPicker();
    return;
  }
  img.onload = renderRegionBoxes;
  img.src = res.dataUrl;
}

function closeRegionPicker() {
  closeModal('m-region-picker');
  _regionPickerAccountId = null;
  _regionPickerDrag = null;
}

function resetRegionPicker() {
  _regionPickerRects = [];
  renderRegionBoxes();
}

function renderRegionBoxes() {
  const img = document.getElementById('region-picker-img');
  const wrap = document.getElementById('region-picker-wrap');
  wrap.querySelectorAll('.region-picker-box').forEach(el => el.remove());
  if (!img.clientWidth || !img.clientHeight) return;
  _regionPickerRects.forEach((rect, i) => {
    const box = document.createElement('div');
    box.className = 'region-picker-box';
    box.dataset.idx = i;
    box.title = 'Click to remove';
    box.style.left = (rect.x * img.clientWidth) + 'px';
    box.style.top = (rect.y * img.clientHeight) + 'px';
    box.style.width = (rect.w * img.clientWidth) + 'px';
    box.style.height = (rect.h * img.clientHeight) + 'px';
    box.style.pointerEvents = 'auto';
    box.onclick = e => {
      e.stopPropagation();
      _regionPickerRects.splice(i, 1);
      renderRegionBoxes();
    };
    wrap.appendChild(box);
  });
}

function saveRegionPicker() {
  if (!_regionPickerAccountId) return;
  const regions = Object.assign({}, settings.trackingRegions || {});
  if (_regionPickerRects.length) regions[_regionPickerAccountId] = _regionPickerRects;
  else delete regions[_regionPickerAccountId];
  settings.trackingRegions = regions;
  api.saveSettings({ trackingRegions: regions });
  closeRegionPicker();
  renderTrackingPage();
  toast(t('track.spotsSaved'), 'ok');
}

(function initRegionPickerDrag() {
  const wrap = document.getElementById('region-picker-wrap');
  if (!wrap) return;
  let draftBox = null;
  wrap.addEventListener('mousedown', e => {
    if (e.target.classList.contains('region-picker-box')) return; // handled by its own onclick
    const img = document.getElementById('region-picker-img');
    if (!img.clientWidth) return;
    const rect = img.getBoundingClientRect();
    const startX = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const startY = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    _regionPickerDrag = { startX, startY, imgRect: rect };
    draftBox = document.createElement('div');
    draftBox.className = 'region-picker-box region-picker-box-draft';
    draftBox.style.left = startX + 'px';
    draftBox.style.top = startY + 'px';
    draftBox.style.width = '0px';
    draftBox.style.height = '0px';
    wrap.appendChild(draftBox);
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!_regionPickerDrag || !draftBox) return;
    const { startX, startY, imgRect } = _regionPickerDrag;
    const x = Math.min(Math.max(e.clientX - imgRect.left, 0), imgRect.width);
    const y = Math.min(Math.max(e.clientY - imgRect.top, 0), imgRect.height);
    draftBox.style.left = Math.min(x, startX) + 'px';
    draftBox.style.top = Math.min(y, startY) + 'px';
    draftBox.style.width = Math.abs(x - startX) + 'px';
    draftBox.style.height = Math.abs(y - startY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!_regionPickerDrag) return;
    const img = document.getElementById('region-picker-img');
    const left = draftBox ? parseFloat(draftBox.style.left) : 0;
    const top = draftBox ? parseFloat(draftBox.style.top) : 0;
    const w = draftBox ? parseFloat(draftBox.style.width) : 0;
    const h = draftBox ? parseFloat(draftBox.style.height) : 0;
    if (draftBox) { draftBox.remove(); draftBox = null; }
    _regionPickerDrag = null;
    if (w < 8 || h < 8 || !img.clientWidth || !img.clientHeight) return;
    _regionPickerRects.push({
      x: left / img.clientWidth,
      y: top / img.clientHeight,
      w: w / img.clientWidth,
      h: h / img.clientHeight,
    });
    renderRegionBoxes();
  });
})();

// ── Auto-update ─────────────────────────────────────────────────────────────
// Uses tauri-plugin-updater (see tauri-bridge.js + UPDATING.md). Checks at
// startup; shows a modal when a newer version is hosted. The web build stubs
// these calls out (api.checkForUpdates resolves null there).
let _updateAvailable = null;
let _updateChecking = false;

async function checkForUpdates(manual) {
  if (!api.checkForUpdates || _updateChecking) return;
  _updateChecking = true;
  const btn = document.getElementById('btn-check-updates');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>' + esc(t('update.checking')); }
  try {
    const u = await api.checkForUpdates();
    if (u && u.version) {
      _updateAvailable = u;
      logEntry('info', 'system', 'Update available: v' + u.version + (u.body ? ' — ' + u.body.split('\n')[0] : ''), { version: u.version });
      openUpdateModal();
    } else {
      _updateAvailable = null;
      if (manual) toast(t('update.uptodate'), 'ok');
    }
  } catch (e) {
    if (manual) toast(t('update.checkFailed', { err: (e && e.message) || e }), 'err');
  } finally {
    _updateChecking = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">system_update_alt</span>' + esc(t('update.check')); }
  }
}

function openUpdateModal() {
  if (!_updateAvailable) return;
  const u = _updateAvailable;
  const desc = document.getElementById('update-desc');
  if (desc) desc.textContent = t('update.downloadPrompt', { v: u.version });
  const notes = document.getElementById('update-notes');
  if (notes) {
    if (u.body) { notes.style.display = ''; notes.textContent = u.body; }
    else notes.style.display = 'none';
  }
  const st = document.getElementById('update-status');
  if (st) { st.className = 'mst hidden'; st.innerHTML = ''; }
  const btn = document.getElementById('btn-update-install');
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">download</span>' + esc(t('update.install')); }
  openModal('m-update');
}

async function installUpdate() {
  if (!_updateAvailable || !api.installUpdate) return;
  const btn = document.getElementById('btn-update-install');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>' + esc(t('update.downloading')); }
  try {
    await api.installUpdate(_updateAvailable);
    // Success: the installer relaunches the app (NSIS). Nothing else to do.
  } catch (e) {
    const st = document.getElementById('update-status');
    if (st) { st.className = 'mst err'; st.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(t('update.failed', { msg: (e && e.message) || e })); }
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">download</span>' + esc(t('update.install')); }
  }
}
