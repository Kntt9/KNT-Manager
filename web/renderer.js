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
  if (typeof renderThemePage === 'function') renderThemePage();
  if (typeof renderHistory === 'function' && document.getElementById('page-history')?.classList.contains('active')) renderHistory();
  if (typeof renderPrivateServers === 'function' && typeof chartTab !== 'undefined' && chartTab === 'private' && document.getElementById('page-charts')?.classList.contains('active')) renderPrivateServers();
  if (persist !== false) {
    try { localStorage.setItem('mr-lang', _lang); } catch {}
    if (typeof settings !== 'undefined' && settings) settings.language = _lang;
    try { api.saveSettings({ language: _lang }).catch(() => {}); } catch {}
    _syncUiPrefsToSettings();
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

// ── Account status history (persistent, survives restarts) ───────────────
// One row per transition: running/idle/home/cookie-dead/cookie-ok.
const _HIST_KEY = 'mr-status-history';
const MAX_HIST = 200;
let _statusHistory = [];
function _loadStatusHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(_HIST_KEY) || '[]');
    _statusHistory = Array.isArray(raw) ? raw.filter(e => e && e.ts && e.id && e.to).slice(-MAX_HIST) : [];
  } catch { _statusHistory = []; }
}
function _saveStatusHistory() {
  try { localStorage.setItem(_HIST_KEY, JSON.stringify(_statusHistory)); } catch {}
}
function _histAcctName(id) {
  const a = (typeof accounts !== 'undefined' ? accounts : []).find(x => x.id === id)
    || (typeof trashedAccounts !== 'undefined' ? trashedAccounts : []).find(x => x.id === id);
  return a ? (a.nickname || a.username || id) : id;
}
function pushStatusHistory(id, to, from) {
  if (!id || !to) return;
  const last = _statusHistory[_statusHistory.length - 1];
  if (last && last.id === id && last.to === to) return; // no repeat rows
  _statusHistory.push({ ts: Date.now(), id, name: _histAcctName(id), from: from || '', to });
  if (_statusHistory.length > MAX_HIST) _statusHistory = _statusHistory.slice(-MAX_HIST);
  _saveStatusHistory();
  if (document.getElementById('page-history')?.classList.contains('active')) renderHistory();
}
const _HIST_META = {
  running: ['rocket_launch', 'green'],
  idle: ['stop_circle', 'muted'],
  home: ['home', 'amber'],
  'cookie-dead': ['error_outline', 'red'],
  'cookie-ok': ['check_circle', 'green'],
};
function renderHistory() {
  const el = document.getElementById('hist-list');
  if (!el) return;
  if (!_statusHistory.length) {
    el.innerHTML = '<div class="logs-empty"><span class="material-icons-round">history</span>' + esc(t('hist.empty')) + '</div>';
    return;
  }
  el.innerHTML = '<div class="dash-feed">' + [..._statusHistory].reverse().map(e => {
    const meta = _HIST_META[e.to] || ['info', 'muted'];
    const label = t('hist.' + (e.to === 'cookie-dead' ? 'cookieDead' : e.to === 'cookie-ok' ? 'cookieOk' : e.to));
    const when = esc(_actTime(e.ts));
    return '<div class="dash-feed-row"><span class="dash-ic ' + meta[1] + '" style="width:22px;height:22px;font-size:12px"><span class="material-icons-round" style="font-size:13px">' + meta[0] + '</span></span>' +
      '<span class="dash-feed-text"><b>' + esc(e.name || e.id) + '</b> · ' + esc(label) + '</span><span class="dash-feed-time">' + when + '</span></div>';
  }).join('') + '</div>';
}
function clearHistory() {
  confirmAction(t('hist.clearConfirm'), () => {
    _statusHistory = [];
    _saveStatusHistory();
    renderHistory();
  });
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
  // mode: 'normal' | 'loading' | 'success'
  const action = document.getElementById('enc-action');
  if (!action) return;
  const skip = document.getElementById('enc-skip');
  if (skip) skip.disabled = mode !== 'normal';
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
  // reflow to restart the animation
  void card.offsetWidth;
  card.classList.add('shake');
  setTimeout(() => card.classList.remove('shake'), 320);
}
let _encSubmitting = false;
async function submitEnc() {
  if (_encSubmitting) return;
  const inp = document.getElementById('enc-input');
  const val = inp ? inp.value : '';
  const err = document.getElementById('enc-err');
  if (err) err.classList.remove('show');
  if (!val) { _encErr(_encMode === 'setup' ? t('enc.errSetupEmpty') : t('enc.errEmpty')); _encShake(); inp && inp.focus(); return; }
  _encSubmitting = true;
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
      if (!r || !r.ok) {
        _encErr(r?.error || t('enc.errWrong'));
        logEntry('warn', 'enc', r?.error ? 'Could not finish encryption unlock' : 'Failed encryption unlock attempt (wrong key)');
        _encSetBtnState('normal'); _encShake();
        if (!r?.error) inp.value = '';
        inp.focus();
        return;
      }
      logEntry('ok', 'enc', 'Encryption key accepted, accounts unlocked');
    }
    // Success: brief check state, then a smooth fade-out. The unlock has
    // already finished — the animation never blocks the real operation.
    _encSetBtnState('success');
    await new Promise(r => setTimeout(r, 260));
    closeModal('m-enc');
    try { await continueInit(); } catch (e) { hideBootCover(); console.error(e); }
  } catch (e) { _encErr(t('enc.errGeneric')); _encSetBtnState('normal'); _encShake(); }
  finally { _encSubmitting = false; }
}
async function skipEnc() {
  if (_encSubmitting) return;
  _encSubmitting = true;
  const skip = document.getElementById('enc-skip');
  if (skip) skip.disabled = true;
  _encSetBtnState('loading');
  try {
    const result = await api.encSetKey('');
    if (!result || !result.ok) throw new Error(result?.error || t('enc.errSetGeneric'));
    closeModal('m-enc');
    try { await continueInit(); } catch (e) { hideBootCover(); console.error(e); }
  } catch (error) {
    _encErr(error.message || t('enc.errGeneric'));
    _encSetBtnState('normal');
  } finally {
    _encSubmitting = false;
    if (skip) skip.disabled = false;
  }
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
  // The boot cover stays up behind the lock screen (and until first render when
  // unlocked), so the window never flashes the empty shell.
  try {
    const st = await api.encStatus();
    window.__kntBootDone = true;
    if (st && st.mode === 'locked') { showEncModal('locked'); return; }
    if (st && st.mode === 'setup') { showEncModal('setup'); return; }
  } catch { window.__kntBootDone = true; }
  // A failed boot must never leave the cover spinning forever: drop it so
  // the (empty) app shell is usable instead of a frozen spinner.
  try {
    await continueInit();
  } catch (e) {
    hideBootCover();
    console.error(e);
  }
}

// Fades the boot cover out once real content is painted. Idempotent: later
// render() calls are unaffected.
function hideBootCover() {
  const c = document.getElementById('boot-cover');
  if (!c || c.classList.contains('hide')) return;
  c.classList.add('hide');
  setTimeout(() => c.remove(), 350);
}

// Decrypt failure is itself proof a cookie is unusable -- flag it instantly
// (no network round-trip needed) instead of waiting on recheckAllCookies.
function flagInvalidCookies(list) {
  for (const a of list) {
    if (a._cookieInvalid) {
      _cookieStatus[a.id] = 'dead';
      pushStatusHistory(a.id, 'cookie-dead', '');
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
  // Restore visual prefs carried inside settings.json (backup-safe).
  // On a fresh PC localStorage is empty but settings.uiPrefs comes from restore.
  try {
    if (settings && settings.uiPrefs) {
      const hadLocalTheme = _lsGet('ui-theme');
      _restoreUiPrefsFromSettings();
      _loadCustomThemes();
      const tCur = currentTheme();
      applyTheme(tCur);
      _applyBorderRadius();
      _applyTextureIntensity();
      document.body.classList.toggle('high-contrast', _highContrast());
      // First boot with no local prefs yet: persist what restore just gave us.
      if (!hadLocalTheme) _syncUiPrefsToSettings();
    } else {
      // No uiPrefs yet (old install): create it from current localStorage.
      _syncUiPrefsToSettings();
    }
  } catch {}
  // Hydrate persisted server highlights (settings.srvHighlights) so featured
  // servers survive an app restart. Malformed/legacy entries are dropped.
  _srvHighlighted = {};
  const _srvH = settings.srvHighlights;
  if (_srvH && typeof _srvH === 'object' && !Array.isArray(_srvH)) {
    for (const k of Object.keys(_srvH)) {
      const j = _srvH[k];
      if (j && typeof j === 'object' && typeof j.jobId === 'string' &&
          /^\d+$/.test(String(j.placeId))) {
        _srvHighlighted[k] = { placeId: j.placeId, jobId: j.jobId, lastSeen: j.lastSeen || 0 };
      }
    }
  }
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
  hideBootCover();
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
  // Automatic backup removed from the UI — keep it force-disabled so a
  // previously-enabled timer can never run again in the background.
  if (settings.autoBackup) { settings.autoBackup.enabled = false; }
  renderBackupHistory();
  logEntry('info', 'system', 'KNT Manager started', { version: 'v1', accounts: accounts.length, platform: navigator.platform });
  try { genKeysInit(); } catch {}
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

  // Suspend visual rendering while the window is minimized (backend pushes
  // -- roblox:count/closed/started -- keep flowing regardless, so state stays
  // in sync; only the visual polling/compositing work is dropped). Restored
  // on focus with an immediate re-poll so nothing looks stale.
  api.onWindowVisibility(hidden => {
    // Stale/misordered focus events can stick app-hidden ON, freezing every
    // CSS animation app-wide (all spinners included): a "hidden" that arrives
    // while the document actually has focus is bogus — ignore it.
    if (hidden && document.hasFocus()) hidden = false;
    document.documentElement.classList.toggle('app-hidden', !!hidden);
    if (hidden) {
      if (_statusPoll) { clearInterval(_statusPoll); _statusPoll = null; }
      if (_uptimeTimer) { clearInterval(_uptimeTimer); _uptimeTimer = null; }
    } else {
      startStatusPoll();
    }
  });

  // main pushes the count off the watch tick; the local poll backs off below
  api.onRobloxCount(n => { _lastCountPushAt = Date.now(); _mixRunning = n; setRunningBadges(n); });

  // Fires the moment the process actually exists (see native.rs do_launch),
  // instead of waiting on the whole launch call -- CSRF fetch, auth ticket,
  // inter-launch stagger, trailing bookkeeping -- to resolve back to the
  // caller. markLaunched() is idempotent, so the doLaunch() success path
  // below calling it again once its own await resolves is harmless.
  api.onRobloxStarted(id => {
    const from = _homeIds.has(id) ? 'home' : 'idle';
    markLaunched(id);
    pushActivity('rocket_launch', 'green', t('act.started', { u: esc(_acctLabel(id)) }));
    pushStatusHistory(id, 'running', from);
  });

  api.onRobloxClosed(id => {
    const from = _launchedIds.has(id) ? 'running' : (_homeIds.has(id) ? 'home' : 'idle');
    _launchedIds.delete(id);
    _homeIds.delete(id);
    _srvAccountLeft(id);
    delete _launchedAt[id];
    const closedAcct = accounts.find(a => a.id === id);
    logEntry('info', 'close', `Roblox closed for ${closedAcct ? closedAcct.username : id}`, { accountId: id, username: closedAcct?.username || null, userId: closedAcct?.userId || null });
    pushActivity('stop_circle', 'muted', t('act.closed', { u: esc(_acctLabel(id)) }));
    pushStatusHistory(id, 'idle', from);
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
    _srvAccountLeft(id);
    delete _launchedAt[id];
    pushActivity('home', 'amber', t('act.home', { u: esc(_acctLabel(id)) }));
    pushStatusHistory(id, 'home', 'running');
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

// ── Theme engine ──────────────────────────────────────────────────────────
var THEMES = ['dark','light','midnight','aurora','sunset','crimson','ocean','grape','forest','amber','rose','graphite'];
var _previewedKeys = [];
var _customThemes = [];
var _themeCat = 'all';

// ── WCAG luminance helpers ────────────────────────────────────────────────
function _srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function _luminance(r, g, b) { return 0.2126 * _srgbToLinear(r) + 0.7152 * _srgbToLinear(g) + 0.0722 * _srgbToLinear(b); }
function _contrastRatio(l1, l2) { const lighter = Math.max(l1, l2), darker = Math.min(l1, l2); return (lighter + 0.05) / (darker + 0.05); }
function _hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return [parseInt(hex.substr(0,2),16), parseInt(hex.substr(2,2),16), parseInt(hex.substr(4,2),16)];
}
function _lighten(hex, amt) {
  const [r,g,b] = _hexToRgb(hex);
  const lr = Math.min(255, r + Math.round((255-r)*amt));
  const lg = Math.min(255, g + Math.round((255-g)*amt));
  const lb = Math.min(255, b + Math.round((255-b)*amt));
  return '#'+[lr,lg,lb].map(c=>c.toString(16).padStart(2,'0')).join('');
}
function _darken(hex, amt) {
  const [r,g,b] = _hexToRgb(hex);
  const dr = Math.max(0, Math.round(r*(1-amt)));
  const dg = Math.max(0, Math.round(g*(1-amt)));
  const db = Math.max(0, Math.round(b*(1-amt)));
  return '#'+[dr,dg,db].map(c=>c.toString(16).padStart(2,'0')).join('');
}
function _rgba(hex, alpha) {
  const [r,g,b] = _hexToRgb(hex);
  return 'rgba('+r+','+g+','+b+','+alpha+')';
}

// ── Core theme variable generator ─────────────────────────────────────────
function generateThemeVars(accent, bg, surface, isDark) {
  const bgLum = _luminance(..._hexToRgb(bg));
  const isLight = bgLum > 0.5;
  // Surfaces: derive from surface input
  const s2 = isDark ? _darken(surface, 0.05) : _lighten(surface, 0.04);
  const s3 = isDark ? _darken(surface, 0.12) : _lighten(surface, 0.08);
  const s4 = isDark ? _darken(surface, 0.18) : _lighten(surface, 0.14);
  // Borders
  const bdAlpha = isDark ? 0.065 : 0.09;
  const bd2Alpha = isDark ? 0.12 : 0.16;
  const bd3Alpha = isDark ? 0.2 : 0.28;
  const bdBase = isDark ? '255,255,255' : '10,14,30';
  // Accent
  const acH = _lighten(accent, 0.12);
  const [acR,acG,acB] = _hexToRgb(accent);
  // Text: WCAG-based
  let t1, t2, t3;
  if (isLight) {
    t1 = '#10121a'; t2 = '#4f5462'; t3 = '#8b90a0';
  } else {
    t1 = '#f2f3f6'; t2 = '#a7aab3'; t3 = '#70737c';
  }
  // Enforce minimum 4.5:1 contrast on t1
  const t1Lum = _luminance(..._hexToRgb(t1));
  const ratio = _contrastRatio(t1Lum, bgLum);
  if (ratio < 4.5) { t1 = isLight ? '#000000' : '#ffffff'; }
  // Semantic colors
  const green = isLight ? '#128a57' : '#3ecf8e';
  const red = isLight ? '#d64646' : '#f06f6f';
  const amber = isLight ? '#b45309' : '#f5a623';
  const blue = isLight ? '#2563eb' : '#3b82f6';
  // Shadows
  const shBase = isDark ? 'rgba(0,0,0,' : 'rgba(20,24,40,';
  const sh1a = isDark ? '.3' : '.08';
  const sh2a = isDark ? '.55' : '.18';
  const sh3a = isDark ? '.65' : '.25';
  return {
    '--bg': bg, '--s1': surface, '--s2': s2, '--s3': s3, '--s4': s4,
    '--bd': 'rgba('+bdBase+','+bdAlpha+')', '--bd2': 'rgba('+bdBase+','+bd2Alpha+')', '--bd3': 'rgba('+bdBase+','+bd3Alpha+')',
    '--t1': t1, '--t2': t2, '--t3': t3,
    '--ac': accent, '--ac-h': acH, '--ac2': _rgba(accent, 0.3), '--ac3': _rgba(accent, 0.5),
    '--green': green, '--gd': _rgba(green, 0.12),
    '--blue': blue, '--bld': _rgba(blue, 0.12),
    '--red': red, '--rd': _rgba(red, 0.12),
    '--amber': amber, '--ad': _rgba(amber, 0.12),
    '--red-rgb': _hexToRgb(red).join(','),
    '--shadow-1': '0 1px 2px '+shBase+sh1a+')',
    '--shadow-2': '0 10px 28px -10px '+shBase+sh2a+')',
    '--shadow-3': '0 24px 64px -14px '+shBase+sh3a+')',
  };
}

// ── Reapply everything (theme + radius + high contrast) ───────────────────
function _reapplyActiveTheme(name = currentTheme()) {
  // Clear custom inline styles first
  const customKeys = Object.keys(generateThemeVars('#5c5ce0','#0b0c0f','#141519',true));
  customKeys.forEach(k => document.documentElement.style.removeProperty(k));
  document.documentElement.style.removeProperty('--r');
  document.documentElement.style.removeProperty('--r2');
  document.documentElement.style.removeProperty('--r3');
  // Apply class-based theme
  document.body.classList.remove('light');
  THEMES.forEach(t => { if (t !== 'dark' && t !== 'light') document.body.classList.remove('theme-' + t); });
  document.body.classList.remove('custom-theme');
  if (name.startsWith('custom:')) {
    const id = name.slice(7);
    const ct = _customThemes.find(t => t.id === id);
    if (ct) {
      const vars = generateThemeVars(ct.accent, ct.bg, ct.surface, ct.isDark);
      Object.entries(vars).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
      document.body.classList.add('custom-theme');
    } else { document.body.classList.add('light'); }
  } else if (name === 'light') {
    document.body.classList.add('light');
  } else if (THEMES.indexOf(name) >= 0) {
    document.body.classList.add('theme-' + name);
  }
  // High contrast
  document.body.classList.toggle('high-contrast', _highContrast());
  // Border radius
  _applyBorderRadius();
  // Texture intensity
  _applyTextureIntensity();
  // Update cards
  document.querySelectorAll('.theme-card').forEach(c => {
    const v = c.dataset.theme || '';
    const isSel = (name === v) || (name.startsWith('custom:') && v === name);
    c.classList.toggle('sel', isSel);
  });
  document.querySelectorAll('.theme-custom-card').forEach(c => {
    c.classList.toggle('sel', name === 'custom:' + c.dataset.themeId);
  });
}

// ── Theme apply with smooth transition ────────────────────────────────────
function applyTheme(name) {
  document.body.classList.add('theme-transitioning');
  _reapplyActiveTheme(name);
  setTimeout(() => document.body.classList.remove('theme-transitioning'), 300);
}
function setTheme(name) {
  if (!name) return;
  try { localStorage.setItem('ui-theme', name); } catch {}
  applyTheme(name);
  _syncUiPrefsToSettings();
  renderThemePage();
}
function currentTheme() { try { return localStorage.getItem('ui-theme') || 'graphite'; } catch { return 'graphite'; } }

// ── Custom themes persistence ─────────────────────────────────────────────
function _loadCustomThemes() {
  try { _customThemes = JSON.parse(localStorage.getItem('mr-custom-themes') || '[]'); } catch { _customThemes = []; }
}
function _saveCustomThemes() {
  try { localStorage.setItem('mr-custom-themes', JSON.stringify(_customThemes)); } catch {}
  _syncUiPrefsToSettings();
}
// Mirror visual prefs into settings.json so encrypted backups carry them.
// Purely additive: old backups without uiPrefs still restore fine.
function _lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function _lsSet(k, v) { try { if (v === null || v === undefined || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} }
function _collectUiPrefs() {
  let customs = [];
  try {
    const raw = JSON.parse(localStorage.getItem('mr-custom-themes') || '[]');
    if (Array.isArray(raw)) {
      customs = raw.slice(-30).map(x => ({
        id: String(x.id || '').slice(0, 64),
        name: String(x.name || '').slice(0, 40),
        accent: _isHexColor(x.accent) ? x.accent.trim() : '#5c5ce0',
        bg: _isHexColor(x.bg) ? x.bg.trim() : '#0b0c0f',
        surface: _isHexColor(x.surface) ? x.surface.trim() : '#141519',
        isDark: !!x.isDark
      })).filter(x => x.id);
    }
  } catch { customs = []; }
  return {
    v: 1,
    theme: _lsGet('ui-theme') || 'graphite',
    customThemes: customs,
    lang: _lsGet('mr-lang') || '',
    radius: _lsGet('mr-border-radius') || '',
    highContrast: _lsGet('mr-high-contrast') || '',
    texture: _lsGet('mr-theme-texture') || '',
    pattern: _lsGet('mr-theme-pattern') || '',
    texSize: _lsGet('mr-theme-tex-size') || '',
    autoTheme: _lsGet('mr-auto-theme') || '',
    autoThemeBase: _lsGet('mr-auto-theme-base') || ''
  };
}
let _uiPrefsTimer = null;
function _syncUiPrefsToSettings() {
  if (typeof api === 'undefined' || !api.saveSettings) return;
  if (typeof settings === 'undefined' || !settings) return;
  clearTimeout(_uiPrefsTimer);
  _uiPrefsTimer = setTimeout(() => {
    try {
      const prefs = _collectUiPrefs();
      const json = JSON.stringify(prefs);
      if (json.length > 100 * 1024) return; // never bloat settings.json
      settings.uiPrefs = prefs;
      api.saveSettings({ uiPrefs: prefs }).catch(() => {});
    } catch {}
  }, 800);
}
function _restoreUiPrefsFromSettings() {
  try {
    const p = settings && settings.uiPrefs;
    if (!p || typeof p !== 'object') return false;
    if (p.theme && typeof p.theme === 'string') _lsSet('ui-theme', p.theme.slice(0, 64));
    if (Array.isArray(p.customThemes)) {
      try { localStorage.setItem('mr-custom-themes', JSON.stringify(p.customThemes.slice(-30))); } catch {}
      _loadCustomThemes();
    }
    if (p.lang) _lsSet('mr-lang', String(p.lang).slice(0, 8));
    if (p.radius !== undefined) _lsSet('mr-border-radius', String(p.radius).slice(0, 8));
    if (p.highContrast !== undefined) _lsSet('mr-high-contrast', String(p.highContrast).slice(0, 8));
    if (p.texture) _lsSet('mr-theme-texture', String(p.texture).slice(0, 16));
    if (p.pattern !== undefined) _lsSet('mr-theme-pattern', String(p.pattern).slice(0, 16));
    if (p.texSize !== undefined) _lsSet('mr-theme-tex-size', String(p.texSize).slice(0, 8));
    if (p.autoTheme !== undefined) _lsSet('mr-auto-theme', String(p.autoTheme).slice(0, 8));
    if (p.autoThemeBase) _lsSet('mr-auto-theme-base', String(p.autoThemeBase).slice(0, 32));
    return true;
  } catch { return false; }
}
function _uniqueThemeName(name, excludeId) {
  const all = THEMES.map(t => t).concat(_customThemes.filter(t => t.id !== excludeId).map(t => t.name));
  let n = name, i = 2;
  while (all.some(t => t.toLowerCase() === n.toLowerCase())) { n = name + ' (' + i + ')'; i++; }
  return n;
}

// ── Hover preview ─────────────────────────────────────────────────────────
function previewTheme(accent, bg, surface, isDark) {
  clearPreview();
  const vars = generateThemeVars(accent, bg, surface, isDark);
  _previewedKeys = Object.keys(vars);
  document.body.classList.add('theme-transitioning');
  Object.entries(vars).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
}
function clearPreview() {
  // Preview only ever adds inline vars on top of the untouched active theme
  // classes, so removing them restores the theme by itself. A full
  // _reapplyActiveTheme() here (class churn + card queries + radius +
  // texture on EVERY card mouseleave) was the main themes-tab jank.
  _previewedKeys.forEach(k => document.documentElement.style.removeProperty(k));
  _previewedKeys = [];
  document.body.classList.remove('theme-transitioning');
  // Exception: custom themes THEMSELVES live as inline vars, which the wipe
  // above just removed together with the preview ones — lay them back.
  // Built-in themes need nothing (their classes were never touched).
  const name = currentTheme();
  if (name.startsWith('custom:')) {
    const ct = _customThemes.find(t => t.id === name.slice(7));
    if (ct) {
      const vars = generateThemeVars(ct.accent, ct.bg, ct.surface, ct.isDark);
      Object.entries(vars).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
    }
  }
}
// Hover preview, debounced: sweeping the mouse across cards used to repaint
// the whole app once per card. Now a card previews only if the cursor rests
// on it (~120ms); leaving early cancels the pending preview.
let _previewTimer = null;
function previewThemeSoon(accent, bg, surface, isDark) {
  cancelPreviewTheme();
  _previewTimer = setTimeout(() => { _previewTimer = null; previewTheme(accent, bg, surface, isDark); }, 120);
}
function cancelPreviewTheme() {
  if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }
  else clearPreview();
}

// ── Texture intensity (off | subtle | medium) ─────────────────────────────
const _TEX_PATTERNS = ['grain','dots','stars','rays','triangles','crosses','waves','hex','grid','diagonal','mesh','circuit'];
function _themeTexture() { try { return localStorage.getItem('mr-theme-texture') || 'subtle'; } catch { return 'subtle'; } }
function _themePattern() { try { return localStorage.getItem('mr-theme-pattern') || 'none'; } catch { return 'none'; } }
function _themeTexSize() { try { return parseInt(localStorage.getItem('mr-theme-tex-size'), 10) || 0; } catch { return 0; } }
function _applyTextureIntensity() {
  const v = _themeTexture();
  // The textures are internally already very faint; intensity only scales
  // the whole layer's opacity on top of that.
  const opacity = v === 'off' ? 0 : (v === 'medium' ? 1 : 0.55);
  document.documentElement.style.setProperty('--theme-texture-opacity', String(opacity));
  // Pattern override ('none' = no background pattern, the default; '' =
  // follow the active theme's own texture for users who had it set before).
  // Set on BODY, not :root — body.theme-* declares --theme-texture on the
  // body itself, so an :root inline value would lose the cascade for
  // body::before. An inline style on body beats the stylesheet.
  const pat = _themePattern();
  if (pat === 'none') document.body.style.setProperty('--theme-texture', 'none');
  else if (pat) document.body.style.setProperty('--theme-texture', 'var(--tex-' + pat + ')');
  else document.body.style.removeProperty('--theme-texture');
  // Size override (0 = follow the theme's default size)
  const sz = _themeTexSize();
  if (sz) document.body.style.setProperty('--theme-texture-size', sz + 'px');
  else document.body.style.removeProperty('--theme-texture-size');
  // Sync controls
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
  _syncUiPrefsToSettings();
}
function setThemePattern(v) {
  try { localStorage.setItem('mr-theme-pattern', v); } catch {}
  _applyTextureIntensity();
  _syncUiPrefsToSettings();
}
function setThemeTexSize(v) {
  const n = parseInt(v, 10) || 0;
  try { localStorage.setItem('mr-theme-tex-size', n ? String(n) : ''); } catch {}
  _applyTextureIntensity();
  updateSliderFill(document.getElementById('texture-size'));
  _syncUiPrefsToSettings();
}
function _renderTexturePatternSelect() {
  const sel = document.getElementById('texture-pattern');
  if (!sel) return;
  let html = '<option value="none">' + esc(t('themes.patternNone')) + '</option>';
  html += '<option value="">' + esc(t('themes.patternAuto')) + '</option>';
  for (const p of _TEX_PATTERNS) html += '<option value="' + p + '">' + esc(t('themes.pattern' + p.charAt(0).toUpperCase() + p.slice(1))) + '</option>';
  sel.innerHTML = html;
  sel.value = _themePattern();
}

// ── High contrast ─────────────────────────────────────────────────────────
function _highContrast() { try { return localStorage.getItem('mr-high-contrast') === '1'; } catch { return false; } }
function toggleHighContrast() {
  const on = !_highContrast();
  try { localStorage.setItem('mr-high-contrast', on ? '1' : '0'); } catch {}
  document.body.classList.toggle('high-contrast', on);
  const el = document.getElementById('set-highcontrast');
  if (el) el.checked = on;
  _syncUiPrefsToSettings();
}

// ── Border radius ─────────────────────────────────────────────────────────
function _savedRadius() { try { return parseInt(localStorage.getItem('mr-border-radius'), 10) || 12; } catch { return 12; } }
function _applyBorderRadius() {
  const r = _savedRadius();
  document.documentElement.style.setProperty('--r', r + 'px');
  document.documentElement.style.setProperty('--r2', Math.round(r * 0.67) + 'px');
  document.documentElement.style.setProperty('--r3', Math.round(r * 0.5) + 'px');
}
function setBorderRadius(v) {
  try { localStorage.setItem('mr-border-radius', String(v)); } catch {}
  _applyBorderRadius();
  const lbl = document.getElementById('radius-val');
  if (lbl) lbl.textContent = v + 'px';
  updateSliderFill(document.getElementById('set-radius'));
  _syncUiPrefsToSettings();
}

// ── Auto theme (day/night) ────────────────────────────────────────────────
let _autoThemeTimer = null;
function _autoThemeEnabled() { try { return localStorage.getItem('mr-auto-theme') === '1'; } catch { return false; } }
function _autoThemeBase() { try { return localStorage.getItem('mr-auto-theme-base') || 'dark'; } catch { return 'dark'; } }
function _autoThemeTick() {
  if (!_autoThemeEnabled()) return;
  const h = new Date().getHours();
  const isDay = h >= 7 && h < 19;
  const base = _autoThemeBase();
  const isDarkBase = THEMES.indexOf(base) >= 0 && base !== 'light';
  const target = isDay ? (isDarkBase ? 'light' : base) : base;
  if (currentTheme() !== target) setTheme(target);
}
function toggleAutoTheme() {
  const on = !_autoThemeEnabled();
  try { localStorage.setItem('mr-auto-theme', on ? '1' : '0'); } catch {}
  const base = currentTheme();
  if (on) {
    try { localStorage.setItem('mr-auto-theme-base', base.startsWith('custom:') ? 'dark' : base); } catch {}
    _autoThemeTick();
    _autoThemeTimer = setInterval(_autoThemeTick, 5 * 60 * 1000);
  } else {
    if (_autoThemeTimer) { clearInterval(_autoThemeTimer); _autoThemeTimer = null; }
  }
  const el = document.getElementById('set-autotheme');
  if (el) el.checked = on;
  _syncUiPrefsToSettings();
}
function _startAutoTheme() {
  if (!_autoThemeEnabled()) return;
  _autoThemeTick();
  _autoThemeTimer = setInterval(_autoThemeTick, 5 * 60 * 1000);
}

// ── Custom theme CRUD ─────────────────────────────────────────────────────
function openCustomThemePanel(editId) {
  const panel = document.getElementById('theme-custom-panel');
  if (!panel) return;
  panel.style.display = '';
  const titleEl = document.getElementById('theme-custom-title');
  const nameEl = document.getElementById('custom-theme-name');
  const accentEl = document.getElementById('custom-accent');
  const bgEl = document.getElementById('custom-bg');
  const surfaceEl = document.getElementById('custom-surface');
  const darkEl = document.getElementById('custom-isdark');
  const saveBtn = document.getElementById('custom-theme-save');
  const delBtn = document.getElementById('custom-theme-delete');
  if (editId) {
    const ct = _customThemes.find(t => t.id === editId);
    if (!ct) return;
    if (titleEl) titleEl.textContent = t('themes.editTheme');
    if (nameEl) nameEl.value = ct.name;
    if (accentEl) accentEl.value = ct.accent;
    if (bgEl) bgEl.value = ct.bg;
    if (surfaceEl) surfaceEl.value = ct.surface;
    if (darkEl) darkEl.checked = ct.isDark;
    if (delBtn) { delBtn.style.display = ''; delBtn.dataset.editId = editId; }
    if (saveBtn) saveBtn.dataset.editId = editId;
    previewTheme(ct.accent, ct.bg, ct.surface, ct.isDark);
  } else {
    if (titleEl) titleEl.textContent = t('themes.newTheme');
    if (nameEl) nameEl.value = '';
    if (accentEl) accentEl.value = '#5c5ce0';
    if (bgEl) bgEl.value = '#0b0c0f';
    if (surfaceEl) surfaceEl.value = '#141519';
    if (darkEl) darkEl.checked = true;
    if (delBtn) delBtn.style.display = 'none';
    if (saveBtn) saveBtn.dataset.editId = '';
    previewTheme('#5c5ce0', '#0b0c0f', '#141419', true);
  }
}
function closeCustomThemePanel() {
  const panel = document.getElementById('theme-custom-panel');
  if (panel) panel.style.display = 'none';
  clearPreview();
}
function onCustomColorChange() {
  const a = document.getElementById('custom-accent')?.value || '#5c5ce0';
  const b = document.getElementById('custom-bg')?.value || '#0b0c0f';
  const s = document.getElementById('custom-surface')?.value || '#141519';
  const d = document.getElementById('custom-isdark')?.checked || false;
  const ah = document.getElementById('custom-accent-hex');
  const bh = document.getElementById('custom-bg-hex');
  const sh = document.getElementById('custom-surface-hex');
  if (ah) ah.textContent = a;
  if (bh) bh.textContent = b;
  if (sh) sh.textContent = s;
  // Color inputs fire per tick while dragging the picker: coalesce to one
  // full-page preview per animation frame instead of one per tick.
  window.__ccArgs = [a, b, s, d];
  if (window.__ccRaf) return;
  window.__ccRaf = requestAnimationFrame(() => {
    window.__ccRaf = null;
    previewTheme(...window.__ccArgs);
  });
}
function saveCustomTheme() {
  const nameEl = document.getElementById('custom-theme-name');
  const accentEl = document.getElementById('custom-accent');
  const bgEl = document.getElementById('custom-bg');
  const surfaceEl = document.getElementById('custom-surface');
  const darkEl = document.getElementById('custom-isdark');
  const saveBtn = document.getElementById('custom-theme-save');
  let name = (nameEl?.value || '').trim().slice(0, 40);
  if (!name) { name = t('themes.newTheme'); }
  const accent = _isHexColor(accentEl?.value) ? accentEl.value.trim() : '#5c5ce0';
  const bg = _isHexColor(bgEl?.value) ? bgEl.value.trim() : '#0b0c0f';
  const surface = _isHexColor(surfaceEl?.value) ? surfaceEl.value.trim() : '#141519';
  const isDark = darkEl?.checked || false;
  const editId = saveBtn?.dataset.editId || '';
  name = _uniqueThemeName(name, editId);
  let activeId = editId;
  if (editId) {
    const ct = _customThemes.find(t => t.id === editId);
    if (ct) { ct.name = name; ct.accent = accent; ct.bg = bg; ct.surface = surface; ct.isDark = isDark; }
    else { activeId = ''; }
  }
  if (!activeId) {
    activeId = 'ct_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    _customThemes.push({ id: activeId, name, accent, bg, surface, isDark });
  }
  _saveCustomThemes();
  setTheme('custom:' + activeId);
  closeCustomThemePanel();
}
function deleteCustomTheme(id) {
  const ct = _customThemes.find(t => t.id === id);
  const name = ct ? ct.name : '';
  confirmAction(t('themes.deleteConfirm', { name: name || t('themes.newTheme') }), () => {
    _customThemes = _customThemes.filter(t => t.id !== id);
    _saveCustomThemes();
    if (currentTheme() === 'custom:' + id) setTheme('dark');
    closeCustomThemePanel();
    renderThemePage();
  });
}
function duplicateTheme(name) {
  // Built-ins are immutable: copy the preset into a new editable custom theme.
  const m = (typeof THEME_META !== 'undefined' && THEME_META[name]) ? THEME_META[name] : null;
  if (!m) { toast(t('themes.exportFailed'), 'err'); return; }
  const base = t('settings.theme' + name.charAt(0).toUpperCase() + name.slice(1));
  const newName = _uniqueThemeName(base, '').slice(0, 40);
  const ct = { id: 'ct_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), name: newName, accent: m.accent, bg: m.bg, surface: m.surface, isDark: !!m.isDark };
  _customThemes.push(ct);
  _saveCustomThemes();
  setTheme('custom:' + ct.id);
  renderThemePage();
  toast(t('themes.duplicated', { name: newName }), 'ok');
  openCustomThemePanel(ct.id);
}

// ── Import / Export ────────────────────────────────────────────────────────
function exportTheme() {
  const name = currentTheme();
  let data;
  if (name.startsWith('custom:')) {
    data = _customThemes.find(t => t.id === name.slice(7));
  } else if (typeof THEME_META !== 'undefined' && THEME_META[name]) {
    const m = THEME_META[name];
    data = { name: name, accent: m.accent, bg: m.bg, surface: m.surface, isDark: m.isDark };
  } else {
    // Fallback — use default dark colors
    data = { name: name, accent: '#5c5ce0', bg: '#0b0c0f', surface: '#141519', isDark: name !== 'light' };
  }
  if (!data) { toast(t('themes.exportFailed'), 'err'); return; }
  const json = JSON.stringify({ name: data.name, accent: data.accent, bg: data.bg, surface: data.surface, isDark: data.isDark }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (data.name || 'theme') + '.json';
  a.click(); URL.revokeObjectURL(url);
  toast(t('themes.exported'), 'ok');
}
function _isHexColor(v) {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}
function importTheme() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024) { toast(t('themes.importError'), 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!_isHexColor(data.accent) || !_isHexColor(data.bg) || !_isHexColor(data.surface)) { toast(t('themes.importError'), 'err'); return; }
        const rawName = String(data.name || t('themes.newTheme')).slice(0, 40);
        const name = _uniqueThemeName(rawName, '');
        const ct = { id: 'ct_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), name, accent: data.accent.trim(), bg: data.bg.trim(), surface: data.surface.trim(), isDark: !!data.isDark };
        _customThemes.push(ct);
        _saveCustomThemes();
        setTheme('custom:' + ct.id);
        renderThemePage();
        toast(t('themes.imported'), 'ok');
      } catch { toast(t('themes.importError'), 'err'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Theme page rendering ──────────────────────────────────────────────────
// tex: which background texture the theme uses (see --tex-* vars in CSS).
const THEME_META = {
  dark: { accent:'#5c5ce0', bg:'#0e0e10', surface:'#18181d', isDark:true, tex:'grain' },
  light: { accent:'#5c5ce0', bg:'#f4f4f8', surface:'#ffffff', isDark:false, tex:'grain' },
  midnight: { accent:'#4f7cff', bg:'#0a0e1a', surface:'#141a2e', isDark:true, tex:'grid' },
  aurora: { accent:'#2dd4bf', bg:'#07140f', surface:'#11221b', isDark:true, tex:'stars' },
  sunset: { accent:'#ff7a59', bg:'#170b12', surface:'#281320', isDark:true, tex:'rays' },
  crimson: { accent:'#f43f5e', bg:'#160a0c', surface:'#271216', isDark:true, tex:'hex' },
  ocean: { accent:'#38bdf8', bg:'#07121a', surface:'#0f2030', isDark:true, tex:'waves' },
  grape: { accent:'#a855f7', bg:'#120a1c', surface:'#211333', isDark:true, tex:'dots' },
  forest: { accent:'#4ade80', bg:'#0a1410', surface:'#13251c', isDark:true, tex:'triangles' },
  amber: { accent:'#f59e0b', bg:'#161106', surface:'#271e0d', isDark:true, tex:'rays' },
  rose: { accent:'#fb7185', bg:'#170b11', surface:'#29131f', isDark:true, tex:'dots' },
  graphite: { accent:'#8b6cf0', bg:'#101419', surface:'#171d24', isDark:true, tex:'' },
};
function _themeCardMiniHtml(accent, bg, surface, isDark, tex) {
  const text = isDark ? '#f0f0f5' : '#0e0e1a';
  const dim = isDark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.14)';
  const bd = isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.08)';
  const texVar = tex ? 'var(--tex-' + tex + ')' : 'none';
  const texSize = (tex === 'waves' || tex === 'mesh') ? 'auto' : (tex === 'stars' ? '150px' : (tex === 'rays' ? '210px' : (tex === 'triangles' ? '96px' : (tex === 'hex' ? '40px' : '26px'))));
  return '<div class="tc-mini" style="--m-bg:'+bg+';--m-panel:'+surface+';--m-ac:'+accent+';--m-text:'+text+';--m-dim:'+dim+';--m-bd:'+bd+';--m-tex:'+texVar+';--m-tex-size:'+texSize+'"><span class="tcm-bg"></span><span class="tcm-side"><i></i><i class="on"></i><i></i><i></i></span><span class="tcm-card"><b></b><u></u><span class="tcm-btn"></span></span></div>';
}
function _swatchesHtml(accent, bg, surface) {
  return '<span class="tc-sws"><span class="tc-sw" style="background:'+bg+'"></span><span class="tc-sw" style="background:'+surface+'"></span><span class="tc-sw" style="background:'+accent+'"></span></span>';
}
function renderThemePage() {
  const grid = document.getElementById('themes-grid-inner');
  if (!grid) return;
  const active = currentTheme();
  // Category tabs
  const catBar = document.getElementById('theme-cat-bar');
  if (catBar) {
    catBar.querySelectorAll('.theme-cat-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.cat === _themeCat);
    });
  }
  let html = '';
  // Filter themes by category
  const darkThemes = ['dark','midnight','aurora','sunset','crimson','ocean','grape','forest','amber','rose','graphite'];
  const lightThemes = ['light'];
  let visibleBuiltins = THEMES;
  if (_themeCat === 'dark') visibleBuiltins = darkThemes;
  else if (_themeCat === 'light') visibleBuiltins = lightThemes;
  else if (_themeCat === 'custom') visibleBuiltins = [];
  // Built-in themes
  for (const name of visibleBuiltins) {
    const m = THEME_META[name];
    if (!m) continue;
    html += '<div class="theme-card" data-theme="'+name+'" onclick="setTheme(\''+name+'\')" onmouseenter="previewThemeSoon(\''+m.accent+'\',\''+m.bg+'\',\''+m.surface+'\','+m.isDark+')" onmouseleave="cancelPreviewTheme()" role="button" tabindex="0">';
    html += _themeCardMiniHtml(m.accent, m.bg, m.surface, m.isDark, m.tex);
    html += '<div class="tc-foot"><span class="tc-name"><span class="tc-check"><span class="material-icons-round">check</span></span>'+esc(t('settings.theme'+name.charAt(0).toUpperCase()+name.slice(1)))+' <button class="btn btn-sm btn-ghost" style="margin-left:6px;padding:2px 6px;font-size:10px" title="'+esc(t('themes.duplicate'))+'" onclick="event.stopPropagation();duplicateTheme(\''+name+'\')"><span class="material-icons-round" style="font-size:12px">content_copy</span></button></span>';
    html += _swatchesHtml(m.accent, m.bg, m.surface);
    html += '</div></div>';
  }
  // Custom themes
  if (_themeCat !== 'dark' && _themeCat !== 'light') {
    for (const ct of _customThemes) {
      html += '<div class="theme-card theme-custom-card" data-theme-id="'+ct.id+'" onclick="setTheme(\'custom:'+ct.id+'\')" onmouseenter="previewThemeSoon(\''+ct.accent+'\',\''+ct.bg+'\',\''+ct.surface+'\','+ct.isDark+')" onmouseleave="cancelPreviewTheme()" role="button" tabindex="0">';
      html += _themeCardMiniHtml(ct.accent, ct.bg, ct.surface, ct.isDark, 'grain');
      html += '<div class="tc-foot"><span class="tc-name"><span class="tc-check"><span class="material-icons-round">check</span></span>'+esc(ct.name)+' <button class="btn btn-sm btn-ghost" style="margin-left:6px;padding:2px 6px;font-size:10px" onclick="event.stopPropagation();openCustomThemePanel(\''+ct.id+'\')"><span class="material-icons-round" style="font-size:12px">edit</span></button></span>';
      html += _swatchesHtml(ct.accent, ct.bg, ct.surface);
      html += '</div></div>';
    }
    // "New theme" card
    html += '<div class="theme-card theme-card-add" onclick="openCustomThemePanel()" role="button" tabindex="0"><div class="theme-card-add-inner"><span class="material-icons-round">add</span><span>'+esc(t('themes.newTheme'))+'</span></div></div>';
  }
  grid.innerHTML = html;
    // Restore scroll
    _renderTexturePatternSelect();
  }
function setThemeCat(cat) {
  _themeCat = cat;
  // Close the custom-theme editor panel when switching sub-tabs so it
  // doesn't linger open over the grid.
  const panel = document.getElementById('theme-custom-panel');
  if (panel) panel.style.display = 'none';
  clearPreview();
  renderThemePage();
}

// ── Theme init ────────────────────────────────────────────────────────────
function openDiscord() {
  api.openExternal('https://discord.gg/6eNAcGKmpC');
}
(function() {
  _loadCustomThemes();
  _loadStatusHistory();
  let t0;
  try {
    t0 = localStorage.getItem('ui-theme');
    if (!t0) { const old = localStorage.getItem('theme'); t0 = ['light','dark'].includes(old) ? old : 'graphite'; }
  } catch { t0 = 'graphite'; }
  applyTheme(t0 || 'graphite');
  _applyBorderRadius();
  _startAutoTheme();
  document.body.classList.toggle('high-contrast', _highContrast());
})();

// ── API key profiles + per-key cooldown ────────────────────────────────────
// Multiple BloxGen/Altgen keys can be saved (e.g. 4 free BloxGen accounts to
// rotate around the 30-minute cooldown). Profiles live in localStorage; the
// old single-key value is migrated into "Conta 1" on first run.
const FREE_ALT_CD_MS = 30 * 60 * 1000;
let _genKeys = [];
let _genKeysReady = false;

function _genUid() { return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function genKeysLoad() { try { const raw = localStorage.getItem('bloxgen_keys'); const arr = raw ? JSON.parse(raw) : null; if (Array.isArray(arr)) return arr.filter(k => k && typeof k.key === 'string'); } catch {} return null; }
function genKeysSave() { try { localStorage.setItem('bloxgen_keys', JSON.stringify(_genKeys)); } catch {} }
function genActiveId() { try { return localStorage.getItem('bloxgen_active') || null; } catch { return null; } }
function genSetActiveId(id) { try { localStorage.setItem('bloxgen_active', id); } catch {} }
function genActiveKey() { let k = _genKeys.find(x => x.id === genActiveId()); if (!k && _genKeys.length) k = _genKeys[0]; return k || null; }
function genMask(key) { const s = (key || '').trim(); if (s.length <= 4) return s ? '····' : '—'; return '···' + s.slice(-4); }

function genKeysInit() {
  if (_genKeysReady) return;
  _genKeysReady = true;
  const stored = genKeysLoad();
  if (stored && stored.length) { _genKeys = stored; }
  else {
    let old = '';
    try { old = localStorage.getItem('bloxgen_apikey') || ''; } catch {}
    _genKeys = [{ id: _genUid(), label: 'Conta 1', key: old }];
    genKeysSave();
    if (old) { try { localStorage.removeItem('bloxgen_apikey'); } catch {} }
  }
  if (!genActiveId() || !_genKeys.some(k => k.id === genActiveId())) genSetActiveId(_genKeys[0].id);
  genRenderKeySelect();
  const inp = document.getElementById('gen-apikey');
  const act = genActiveKey();
  if (inp && act && !inp.value) inp.value = act.key || '';
  genOnKeyInput();
  genKeysTick();
  // Immediate stock readout for the active key (genOnKeyInput only schedules
  // a debounced one for typing, so cancel it and fetch now).
  try { clearTimeout(window._genStockT); } catch {}
  genRefreshStock();
  try { if (!window._genCdTimer) window._genCdTimer = setInterval(genKeysTick, 1000); } catch {}
}

function genRenderKeySelect() {
  const sel = document.getElementById('gen-key-select');
  if (!sel) return;
  const aid = genActiveId();
  sel.innerHTML = '';
  _genKeys.forEach(k => {
    const o = document.createElement('option');
    o.value = k.id;
    o.textContent = (k.label || 'Conta') + ' (' + genMask(k.key) + ')';
    if (k.id === aid) o.selected = true;
    sel.appendChild(o);
  });
}

function genSelectKey(id) {
  if (_genWatch && id !== _genWatch.keyId) genStopWatch(false);
  genSetActiveId(id);
  const k = genActiveKey();
  const inp = document.getElementById('gen-apikey');
  if (inp) inp.value = (k && k.key) || '';
  genOnKeyInput();
  genRefreshStock();
}

function genAddKey() {
  const k = { id: _genUid(), label: 'Conta ' + (_genKeys.length + 1), key: '' };
  _genKeys.push(k); genKeysSave(); genSetActiveId(k.id);
  genRenderKeySelect();
  const inp = document.getElementById('gen-apikey');
  if (inp) { inp.value = ''; inp.focus(); }
  genOnKeyInput();
}
async function genRenameKey() {
  const k = genActiveKey(); if (!k) return;
  const name = await KntUi.requestText({title:t('gen.keyName'), value:k.label || ''});
  if (name === null) return;
  if (name.trim()) k.label = name.trim();
  genKeysSave(); genRenderKeySelect(); genKeysTick();
}
function genRemoveKey() {
  const k = genActiveKey(); if (!k) return;
  _genKeys = _genKeys.filter(x => x.id !== k.id);
  if (!_genKeys.length) _genKeys = [{ id: _genUid(), label: 'Conta 1', key: '' }];
  genKeysSave(); genSetActiveId(_genKeys[0].id);
  genRenderKeySelect();
  const inp = document.getElementById('gen-apikey');
  if (inp) inp.value = genActiveKey().key || '';
  genOnKeyInput();
}

// Cooldown deadlines per profile id (persisted so they survive restarts).
function genCdMap() { try { return JSON.parse(localStorage.getItem('bloxgen_cooldowns') || '{}') || {}; } catch { return {}; } }
function genCdGet(id) { const m = genCdMap(); return m[id] || 0; }
function genCdSet(id, deadline) { try { const m = genCdMap(); m[id] = deadline; localStorage.setItem('bloxgen_cooldowns', JSON.stringify(m)); } catch {} }
function genCdLeft(id) { return Math.max(0, genCdGet(id) - Date.now()); }
function genFmtMs(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + 'm ' + String(r).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
// Live countdown under the active key: selecting a key that was used minutes
// ago immediately shows exactly how long is left.
function genKeysTick() {
  const lbl = document.getElementById('gen-cooldown-label');
  if (!lbl) return;
  const k = genActiveKey();
  if (!k || !(k.key || '').trim()) { lbl.textContent = ''; return; }
  const left = genCdLeft(k.id);
  lbl.textContent = left > 0
    ? t('gen.keyInCooldown', { label: k.label, t: genFmtMs(left) })
    : t('gen.keyReady', { label: k.label });
  // Watch armed: refresh its elapsed timer on the same 1s tick.
  if (typeof _genWatch !== 'undefined' && _genWatch) genWatchUi();
}
(function() {
  const boot = () => { try { genKeysInit(); } catch {} };
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('gen-apikey');
  if (el) el.addEventListener('input', () => {
    try {
      if (_genKeys.length) {
        const k = genActiveKey();
        if (k) { k.key = el.value; genKeysSave(); }
      } else {
        localStorage.setItem('bloxgen_apikey', el.value);
      }
    } catch {}
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

// ── Slider fill (visual only) ────────────────────────────────────────────
// Single system: updateSliderFill() below owns the --fill var, the delegated
// input listener keeps drags in sync, and refreshAllSliderFills() covers
// programmatic changes. No per-slider wiring needed.
function _initSliderFills() {
  refreshAllSliderFills();
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
  const killOnClose = document.getElementById('set-killonclose');
  if (killOnClose) killOnClose.checked = !!settings.killOnClose;
  const arr = document.getElementById('set-autoarrange');
  if (arr) arr.checked = !!settings.autoArrangeWindows;
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

let _acctQuery = '', _acctFilter = (() => { try { const f = localStorage.getItem('mr-acct-filter'); return (f && f !== 'running' && f !== 'idle') ? f : 'all'; } catch { return 'all'; } })(), _acctView = (() => { try { const v = localStorage.getItem('mr-workspace-view'); return ['grid','list','compact'].includes(v) ? v : 'list'; } catch { return 'list'; } })();
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
  if (['running','idle','waiting'].includes(_acctFilter)) list = workspaceFilterState(list,_acctFilter,accountUiState);
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
  const persist = (f === 'running' || f === 'idle' || f === 'waiting' || (f && f.startsWith('cat:')) || f === 'nocat') ? 'all' : f;
  try { localStorage.setItem('mr-acct-filter', persist); } catch {}
  const key = _currentFilterKey();
  document.querySelectorAll('#filter-menu button[data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === key));
  document.getElementById('filter-menu').classList.remove('open');
  document.getElementById('filter-btn').classList.toggle('on', key !== 'all');
  render();
}
function setAcctView(v) {
  _acctView = v;
  try { localStorage.setItem('mr-workspace-view', v); } catch {}
  document.getElementById('vt-grid').classList.toggle('active', v === 'grid');
  document.getElementById('vt-list').classList.toggle('active', v === 'list');
  document.getElementById('vt-compact').classList.toggle('active', v === 'compact');
  render();
}
document.addEventListener('click', e => {
  const fm = document.getElementById('filter-menu');
  if (fm && fm.classList.contains('open') && !e.target.closest('.filter-wrap')) fm.classList.remove('open');
});
// Backstop for a stuck app-hidden freeze: any real user interaction or DOM
// focus proves the window is visible, so drop the animation freeze at once.
// (Without this, one missed focus event leaves every spinner static forever.)
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, () => document.documentElement.classList.remove('app-hidden'), { passive: true, capture: true })
);
window.addEventListener('focus', () => document.documentElement.classList.remove('app-hidden'));

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
function toggleKillOnClose() {
  const el = document.getElementById('set-killonclose');
  const on = el.checked;
  settings.killOnClose = on;
  api.saveSettings({ killOnClose: on });
  toast(on ? t('settings.killOnCloseOn') : t('settings.killOnCloseOff'), 'ok');
}
// Tiles the KNT-managed Roblox windows into a grid after launches/closes.
// On enable it arranges the currently open instances right away.
function toggleAutoArrange() {
  const el = document.getElementById('set-autoarrange');
  const on = el.checked;
  settings.autoArrangeWindows = on;
  api.saveSettings({ autoArrangeWindows: on });
  toast(on ? t('settings.autoArrangeOn') : t('settings.autoArrangeOff'), 'ok');
  if (on && api.arrangeRobloxWindows) api.arrangeRobloxWindows().catch(() => {});
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
  document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
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
  if (tab === 'themes') {
    renderThemePage();
    const radiusEl = document.getElementById('set-radius');
    const radiusVal = document.getElementById('radius-val');
    if (radiusEl) radiusEl.value = _savedRadius();
    if (radiusVal) radiusVal.textContent = _savedRadius() + 'px';
    const hcEl = document.getElementById('set-highcontrast');
    if (hcEl) hcEl.checked = _highContrast();
    const atEl = document.getElementById('set-autotheme');
    if (atEl) atEl.checked = _autoThemeEnabled();
  }
  refreshAllSliderFills();
  positionTabSlider(document.getElementById('stab-general')?.closest('.tab-bar'));
}

function goTo(p) {
  if (p === 'themes') { goTo('settings'); settingsTab(p); return; }
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  document.getElementById('nav-' + p).classList.add('active');
  if (['dashboard','charts','generator','tracking','exploits','credits'].includes(p)) document.getElementById('nav-tools')?.classList.add('active');
  positionNavSlider();
  if (p === 'settings') {
    document.getElementById('stat-count').textContent = accounts.length;
    refreshMultiStatus();
    // Covers landing here without ever clicking a tab -- the default-active
    // tab still needs the pill positioned under it at least once.
    positionTabSlider(document.getElementById('stab-general')?.closest('.tab-bar'));
  }
  if (p === 'logs') renderLogs();
  if (p === 'history') renderHistory();
  if (p === 'charts') {
    if (typeof chartTab !== 'undefined' && chartTab === 'private') {
      renderPrivateServers();
      positionTabSlider(document.getElementById('ctab-private')?.closest('.tab-bar'));
    } else {
      if (!chartsLoaded) loadCharts();
      positionTabSlider(document.getElementById('ctab-popular')?.closest('.tab-bar'));
    }
  }
  if (p === 'packages') renderPackages();
  if (p === 'mixer') mixInit();
  if (p === 'tracking') renderTrackingPage();
  if (p === 'exploits') {
    if (exploitsNeedsConsent()) openModal('m-exploits-consent');
    else loadExploits();
  }
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
// With folders each folder body sorts internally; the flat grid sorts at root.
function reorderCardsByStatus() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const bodies = Array.from(grid.querySelectorAll('.folder-body'));
  const scopes = bodies.length ? bodies : [grid];
  const addCard = grid.querySelector(':scope > .card-add');
  scopes.forEach(scope => {
    const cards = Array.from(scope.querySelectorAll(':scope > .card[data-id]'));
    if (cards.length < 2) return;
    cards.sort((a, b) => (_launchedIds.has(a.dataset.id) ? 0 : 1) - (_launchedIds.has(b.dataset.id) ? 0 : 1));
    const frag = document.createDocumentFragment();
    cards.forEach(c => frag.appendChild(c));
    if (scope === grid && addCard) grid.insertBefore(frag, addCard);
    else scope.appendChild(frag);
  });
  updateFolderCounts();
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
    ${isLive ? `<button class="ctx-item ctx-danger" onclick="ctxKill('${id}')"><span class="material-icons-round">power_settings_new</span>${esc(t('layout.killInstance'))}</button>` : ''}
    ${isLive ? `<button class="ctx-item" onclick="ctxTrim('${id}')"><span class="material-icons-round">memory</span>${esc(t('layout.trimMemory'))}</button>` : ''}
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
    <button class="ctx-item" onclick="ctxLaunch('${id}')"><span class="material-icons-round">rocket_launch</span>${esc(t(isLive ? 'layout.relaunch' : 'launch.start'))}</button>
    <button class="ctx-item" onclick="ctxEdit('${id}')"><span class="material-icons-round">edit</span>${esc(t('edit.title'))}</button>
    ${/^\d+/.test(String(a?.gameTarget || '')) ? `<button class="ctx-item" onclick="ctxServers('${id}')"><span class="material-icons-round">dns</span>${esc(t('srv.title'))}</button>` : ''}
    <div class="ctx-sep"></div>
    <button class="ctx-item" onclick="ctxCopyId('${id}')"><span class="material-icons-round">tag</span>${esc(t('layout.copyId'))}</button>
    <button class="ctx-item" onclick="ctxCopyUser('${id}')"><span class="material-icons-round">person</span>${esc(t('layout.copyUsername'))}</button>
    <button class="ctx-item" onclick="ctxCopyCookie('${id}')"><span class="material-icons-round">cookie</span>${esc(t('layout.copyCookie'))}</button>
    <button class="ctx-item" onclick="ctxCopyPassword('${id}')"><span class="material-icons-round">lock</span>${esc(t('layout.copyPassword'))}</button>
    <button class="ctx-item" onclick="ctxCopyCombo('${id}')"><span class="material-icons-round">content_copy</span>${esc(t('layout.copyCombo'))}</button>
    <button class="ctx-item" onclick="ctxOpenBrowser('${id}')"><span class="material-icons-round">open_in_browser</span>${esc(t('layout.openBrowser'))}</button>
    <div class="ctx-sep"></div><button class="ctx-item ctx-danger" onclick="ctxRemove('${id}')"><span class="material-icons-round">delete_outline</span>${esc(t('layout.moveToTrash'))}</button>
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
function closeCardMenu(event) {
  const m = document.getElementById('card-ctx-menu'); if (m) m.remove(); _ctxMenuId = null;
  if (typeof _workspaceMenuTrigger !== 'undefined') {
    if (!event && _workspaceMenuTrigger?.isConnected) _workspaceMenuTrigger.focus();
    _workspaceMenuTrigger = null;
  }
}
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

function ctxLaunch(id) { closeCardMenu(); openLaunch(id); }
function ctxEdit(id) { closeCardMenu(); openEdit(id); }
function ctxServers(id) {
  closeCardMenu();
  const account=accounts.find(item=>item.id===id);
  if (!/^\d+/.test(String(account?.gameTarget || ''))) return;
  const placeId=parseInt(String(account.gameTarget).split(/[:,]/)[0],10);
  openServerList(placeId,{accountId:id,placeId});
}
function ctxRemove(id) { closeCardMenu(); removeAcc(id); }
function ctxCopyId(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.userId) navigator.clipboard.writeText(a.userId).then(() => toast(t('acct.copyId'), 'ok')); else toast(t('acct.noId'), 'err'); }
function ctxCopyUser(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.username) navigator.clipboard.writeText(a.username).then(() => toast(t('acct.copyUser'), 'ok')); else toast(t('acct.noUser'), 'err'); }
function _copySecretWithClear(text, okKey, vars) {
  const val = text;
  try { navigator.clipboard.writeText(val).then(() => toast(t(okKey, vars), 'ok')); } catch { toast(t(okKey, vars), 'ok'); }
  clearTimeout(_copySecretWithClear._t);
  _copySecretWithClear._t = setTimeout(() => {
    try {
      // Only clear if clipboard still holds our secret (best-effort).
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(cur => {
          if (cur === val) navigator.clipboard.writeText('').then(() => toast(t('acct.clipCleared'), 'ok')).catch(() => {});
        }).catch(() => {});
      }
    } catch {}
  }, 30000);
}
function ctxCopyCookie(id) {
  const a = accounts.find(x => x.id === id);
  if (!a?.cookie) { closeCardMenu(); toast(t('acct.noCookie'), 'err'); return; }
  const label = a.nickname || a.username || 'account';
  closeCardMenu();
  confirmAction(t('acct.copyCookieConfirm', { name: label }), () => _copySecretWithClear(a.cookie, 'acct.copyCookie'), { confirmLabel: t('common.copy'), danger: false });
}
function ctxCopyPassword(id) {
  const a = accounts.find(x => x.id === id);
  if (!a?.password) { closeCardMenu(); toast(t('acct.noPassword'), 'err'); return; }
  const label = a.nickname || a.username || 'account';
  closeCardMenu();
  confirmAction(t('acct.copyPasswordConfirm', { name: label }), () => _copySecretWithClear(a.password, 'acct.copyPassword'), { confirmLabel: t('common.copy'), danger: false });
}
function ctxCopyCombo(id) {
  const a = accounts.find(x => x.id === id);
  if (!a?.username || !a?.password) { closeCardMenu(); toast(t('acct.noCombo'), 'err'); return; }
  const label = a.nickname || a.username || 'account';
  closeCardMenu();
  confirmAction(t('acct.copyComboConfirm', { name: label }), () => _copySecretWithClear(a.username + ':' + a.password, 'acct.copyCombo'), { confirmLabel: t('common.copy'), danger: false });
}
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
  refreshAccountStatuses();
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
    // Expanded member list status dots
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

// ── Folders (accounts grouped by category) ─────────────────────────────────
// Nível 1: reuses the existing categories as collapsible folder sections.
// No data migration: moving a card across folders just changes categoryId.
function getCollapsedFolders() {
  try {
    const raw = JSON.parse(localStorage.getItem('mr-folder-collapsed') || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
function toggleFolder(key) {
  const set = getCollapsedFolders();
  if (set.has(key)) set.delete(key); else set.add(key);
  try { localStorage.setItem('mr-folder-collapsed', JSON.stringify([...set])); } catch {}
  const f = document.querySelector(`#grid .folder[data-cat="${CSS.escape(key)}"]`);
  if (f) f.classList.toggle('collapsed', set.has(key));
}
// Groups the visible list by category (settings order, uncategorized last).
// Orphaned categoryIds (category deleted but account kept it) fall back to
// the uncategorized group instead of vanishing.
function groupAccountsByFolder(list) {
  const groups = [];
  const byKey = new Map();
  for (const a of list) {
    let key = a.categoryId || 'none';
    if (key !== 'none' && !categories.some(c => c.id === key)) key = 'none';
    let g = byKey.get(key);
    if (!g) {
      g = { key, cat: key === 'none' ? null : categories.find(c => c.id === key), cards: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.cards.push(a);
  }
  groups.sort((x, y) => {
    if (x.key === 'none') return 1;
    if (y.key === 'none') return -1;
    return categories.findIndex(c => c.id === x.key) - categories.findIndex(c => c.id === y.key);
  });
  return groups;
}
function folderHtml(g, viewCls) {
  const collapsed = getCollapsedFolders().has(g.key);
  const run = g.cards.filter(a => _launchedIds.has(a.id)).length;
  const color = g.cat ? (g.cat.color || catColor(g.cat.id)) : 'var(--t3)';
  const name = g.cat ? g.cat.name : t('accounts.noCategory');
  return `<div class="folder${collapsed ? ' collapsed' : ''}" data-cat="${esc(g.key)}">
    <div class="folder-head" onclick="toggleFolder('${esc(g.key)}')">
      <span class="material-icons-round folder-chev">expand_more</span>
      <span class="folder-dot" style="background:${esc(color)}"></span>
      <span class="folder-name">${esc(name)}</span>
      <span class="folder-count"><b>${run}</b> / ${g.cards.length}</span>
      <span class="folder-sp"></span>
      <button class="btn btn-ghost folder-launch" onclick="event.stopPropagation();folderLaunch('${esc(g.key)}')" title="${esc(t('folders.launch'))}" aria-label="${esc(t('folders.launch'))}">
        <span class="material-icons-round" style="font-size:14px">play_arrow</span><span>${esc(t('folders.launch'))}</span>
      </button>
    </div>
    <div class="grid folder-body${viewCls}" data-cat="${esc(g.key)}">${g.cards.map((a, i) => cardHtml(a, i)).join('')}</div>
  </div>`;
}
// Recomputes the running/total pills after live status changes (the push
// handlers move cards without a full render).
function updateFolderCounts() {
  refreshAccountStatuses();
  document.querySelectorAll('#grid .folder').forEach(f => {
    const cards = f.querySelectorAll('.card[data-id]');
    let run = 0;
    cards.forEach(c => { if (_launchedIds.has(c.dataset.id)) run++; });
    const el = f.querySelector('.folder-count');
    if (el) el.innerHTML = '<b>' + run + '</b> / ' + cards.length;
  });
}
let _folderLaunchBusy = false;
async function folderLaunch(key) {
  if (_folderLaunchBusy) return;
  const inFolder = a => {
    let k = a.categoryId || 'none';
    if (k !== 'none' && !categories.some(c => c.id === k)) k = 'none';
    return k === key;
  };
  const idle = accounts.filter(a => inFolder(a) && !_launchedIds.has(a.id) && a.cookie);
  if (!idle.length) { toast(t('folders.nothingToLaunch'), 'err'); return; }
  if (settings.multiInstance === false && (idle.length > 1 || _launchedIds.size > 0)) {
    toast(t('settings.multiInstanceBlocked'), 'err');
    return;
  }
  _folderLaunchBusy = true;
  let ok = 0;
  for (const a of idle) {
    const target = a.gameTarget || null;
    logEntry('info', 'launch', `Launching Roblox for ${a.username || a.id} (folder)...`, { accountId: a.id, username: a.username || null, userId: a.userId || null, target: target || 'Roblox home' });
    let res = null;
    try { res = await api.launchRoblox(a.id, a.cookie, target); } catch (e) { res = { success: false, error: e?.message || String(e) }; }
    if (res && res.success) {
      ok++;
      logEntry('ok', 'launch', `Roblox launched successfully as ${a.username || a.id} (folder)`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
      markLaunched(a.id);
    } else if (res && !res.cancelled) {
      logEntry('err', 'launch', `Launch failed for ${a.username || a.id} (folder): ${res.error}`, { accountId: a.id });
      _flagCookieMaybeDead(a.id, res.error);
    }
  }
  _folderLaunchBusy = false;
  pollRunningCount();
  toast(t('folders.launchedN', { ok, total: idle.length }), ok > 0 ? 'ok' : 'err');
}
// Presentation derives from existing process/session and group-job state.
// It never validates a cookie, queries servers or schedules a launch.
function accountUiState(account) {
  if (_launchedIds.has(account.id)) return {state:'running',label:t('ui.running')};
  if (_homeIds.has(account.id)) return {state:'home',label:t('accounts.home')};
  if (_cookieStatus[account.id] === 'dead' || account._cookieInvalid) return {state:'invalid',label:t('ui.invalid')};
  if (_launchingId === account.id) return {state:'starting',label:t('ui.starting')};
  for (const job of _pkgLaunchJobs.values()) {
    if (job.cancelled || job.completed?.has(account.id)) continue;
    if (job.members.some(member => member.id === account.id)) {
      return job.currentAccount === account.id ? {state:'starting',label:t('ui.starting')} : {state:'waiting',label:t('ui.queue')};
    }
  }
  return {state:'stopped',label:t('ui.stopped')};
}
function refreshAccountStatuses() {
  if (typeof workspaceSyncAccounts === 'function') workspaceSyncAccounts();
  const byId = new Map(accounts.map(account => [String(account.id), account]));
  document.querySelectorAll('.card[data-id] .card-state,.inspector-member[data-account-id] .card-state').forEach(pill => {
    const parent = pill.closest('[data-id],[data-account-id]');
    const account = byId.get(parent?.dataset.accountId || parent?.dataset.id);
    if (!account) return;
    const state = accountUiState(account);
    pill.dataset.state = state.state;
    pill.textContent = state.label;
  });
  const summary = document.getElementById('acct-sub');
  if (summary) summary.textContent = t('ui.accountSummary',{total:accounts.length,running:accounts.filter(account => _launchedIds.has(account.id)).length});
  const select = document.getElementById('account-group-select');
  const busy = Boolean(select && _pkgLaunchJobs.has(select.value));
  const group = packages.find(group => group.id === select?.value);
  const hasMembers = Boolean(group && pkgMembers(group).length);
  document.querySelectorAll('#account-group-panel [data-group-action]').forEach(button => {
    const action = button.dataset.groupAction;
    if (['start','distribute','edit'].includes(action)) {
      button.disabled = busy || (action !== 'edit' && !hasMembers) || (action === 'distribute' && !_pkgPublicPlace(group?.link));
    }
  });
}
var _inspectorGroupId = '';
var _inspectorSignature = '';
function renderGroupInspector() {
  const panel = document.getElementById('account-group-panel');
  if (!panel) return;
  if (!packages.some(group => group.id === _inspectorGroupId)) _inspectorGroupId = packages.find(group => group.pinned)?.id || packages[0]?.id || '';
  const signature = JSON.stringify([_lang,_inspectorGroupId,packages.map(group => [group.id,group.name,group.accountIds,group.launchOrder,group.link]),accounts.map(account => [account.id,account.username,account.nickname])]);
  if (signature === _inspectorSignature) { refreshAccountStatuses(); return; }
  _inspectorSignature = signature;
  const group = packages.find(group => group.id === _inspectorGroupId);
  const heading = '<div class="inspector-heading"><span class="material-icons-round" aria-hidden="true">groups</span>'+esc(t('ui.groupPanel'))+'</div>';
  if (!group) {
    panel.innerHTML = heading+'<p class="inspector-hint">'+esc(t('ui.noGroups'))+'</p><div class="inspector-actions"><button class="btn btn-primary" data-group-action="create">'+esc(t('groups.new'))+'</button></div>';
  } else {
    const members = pkgMembers(group);
    const target = group.link || '—';
    panel.innerHTML = heading+'<label class="inspector-label" for="account-group-select">'+esc(t('ui.chooseGroup'))+'</label>'+
      '<select id="account-group-select" class="inspector-select">'+packages.map(item=>'<option value="'+esc(item.id)+'"'+(item.id===group.id?' selected':'')+'>'+esc(item.name)+'</option>').join('')+'</select>'+
      '<span class="inspector-label">'+esc(t('ui.destination'))+'</span><div class="inspector-game">'+pkgGameMarkup(target)+'</div>'+
      '<div class="inspector-actions"><button class="btn btn-primary" data-group-action="start">'+esc(t('groups.startAll'))+'</button><button class="btn btn-ghost" data-group-action="distribute">'+esc(t('pkg.distribute'))+'</button><button class="btn btn-ghost" data-group-action="edit">'+esc(t('ui.manageGroup'))+'</button></div>'+
      '<p class="inspector-hint">'+esc(t('ui.groupHint'))+'</p><span class="inspector-label">'+esc(t('ui.members'))+' · '+members.length+'</span>'+
      members.map(account=>{const state=accountUiState(account);return '<div class="inspector-member" data-account-id="'+esc(account.id)+'"><span class="inspector-avatar">'+esc((account.username||'?')[0].toUpperCase())+'</span><strong>'+esc(account.nickname||account.username||'?')+'</strong><span class="card-state" data-state="'+state.state+'">'+esc(state.label)+'</span></div>';}).join('');
    loadPkgCover(group.id, group.link || '');
    document.getElementById('account-group-select').onchange = event => {_inspectorGroupId = event.target.value; renderGroupInspector();};
  }
  panel.onclick = event => {
    const action = event.target.closest('[data-group-action]')?.dataset.groupAction;
    if (action === 'create') openCreatePackage();
    else if (action === 'edit') openEditPackage(_inspectorGroupId);
    else if (action === 'start') launchPackage(_inspectorGroupId);
    else if (action === 'distribute') workspaceDistribute(_inspectorGroupId);
  };
  refreshAccountStatuses();
}
function openKeySettings() {
  if (_savingKey) return;
  document.getElementById('custom-key').value = '';
  document.getElementById('custom-key-confirm').value = '';
  document.getElementById('custom-key').type = 'password';
  document.getElementById('key-vis-icon').textContent = 'visibility';
  onKeyInput();
  openModal('m-key-change');
}


function cardHtml(a, i) {
  return `
    <div class="card${_launchedIds.has(a.id) ? ' is-live' : ''}${_homeIds.has(a.id) ? ' is-home' : ''}${_cookieStatus[a.id] === 'dead' ? ' cookie-dead' : ''}${_selectMode && _selectedIds.has(a.id) ? ' is-selected' : ''}${_selectMode ? ' select-mode' : ''}" data-id="${a.id}" style="animation-delay:${Math.min(i, 20) * 18}ms" onclick="${_selectMode ? `if(!event.target.closest('button'))toggleSelectCard('${a.id}')` : ''}">
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
      <span class="card-state" data-state="${accountUiState(a).state}">${esc(accountUiState(a).label)}</span>
      <div class="card-game ${a.gameTarget ? 'visible' : ''}" id="gt-${a.id}" title="${esc(a.gameTarget || '')}">${a.gameTarget ? esc(truncate(_gameNameCache[a.id] || extractTargetLabel(a.gameTarget), 36)) : esc(t('accounts.noTarget') === 'accounts.noTarget' ? '—' : t('accounts.noTarget'))}</div>
      <div class="card-row">
        <button class="btn btn-launch" onclick="openLaunch('${a.id}')" title="${esc(t('launch.start'))}" aria-label="${esc(t('launch.start'))}">
          <span class="material-icons-round" style="font-size:15px">play_arrow</span>
        </button>
        ${/^\d+/.test(String(a.gameTarget || '').split(/[:,]/)[0]) ? `<button class="btn btn-edit" onclick="openServerList(${parseInt(String(a.gameTarget).split(/[:,]/)[0], 10)}, { accountId: '${a.id}', placeId: ${parseInt(String(a.gameTarget).split(/[:,]/)[0], 10)} })" title="${esc(t('srv.title'))}" aria-label="${esc(t('srv.title'))}">
          <span class="material-icons-round">dns</span>
        </button>` : ''}
        <button class="btn btn-edit" onclick="openEdit('${a.id}')" title="${esc(t('edit.title'))}" aria-label="${esc(t('edit.title'))}">
          <span class="material-icons-round">edit</span>
        </button>
        <button class="btn btn-del" onclick="removeAcc('${a.id}')" title="${esc(t('common.delete'))}" aria-label="${esc(t('common.delete'))}">
          <span class="material-icons-round">delete_outline</span>
        </button>
      </div>
    </div>`;
}
function render() {
  const previousRendering = _workspaceRendering;
  _workspaceRendering = true;
  try {
  if (typeof workspaceSyncAccounts === 'function') workspaceSyncAccounts();
  renderGroupInspector();
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
    grid.classList.remove('has-folders');
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12.5px;padding:40px 0">' + esc(t('accounts.noMatch')) + '</div>';
    return;
  }
  const viewCls = _acctView === 'list' ? ' list-view' : _acctView === 'compact' ? ' compact-view' : '';
  const groups = groupAccountsByFolder(list);
  const addTile = `<div class="card-add" onclick="openLogin()"><span class="material-icons-round card-add-icon">add</span><span class="card-add-label">${esc(t('accounts.addAccount'))}</span></div>`;
  // Folder mode when there is anything to group by: several groups, or a
  // single categorized one. A lone uncategorized list keeps the classic flat
  // grid so users without categories see zero visual change.
  if (_acctView === 'list') {
    grid.classList.remove('has-folders');
    grid.innerHTML = list.map(workspaceAccountRow).join('');
  } else if (groups.length > 1 || (groups.length === 1 && groups[0].cat)) {
    grid.classList.add('has-folders');
    grid.innerHTML = groups.map(g => folderHtml(g, viewCls)).join('') + addTile;
  } else {
    grid.classList.remove('has-folders');
    grid.innerHTML = list.map((a, i) => cardHtml(a, i)).join('') + addTile;
  }
  loadAvatarsBatch(list);
  list.forEach(a => { if (a.gameTarget && !_gameNameCache[a.id]) fetchGameName(a.id, a.gameTarget); });
  checkCookieHealth(list);
  document.querySelectorAll('.card[data-id]').forEach(card => {
    card.addEventListener('contextmenu', e => { e.preventDefault(); showCardMenu(card.dataset.id, e.clientX, e.clientY); });
  });
  initDrag();
  refreshAccountStatuses();
  renderDashboard();
  } finally { _workspaceRendering = previousRendering; }
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
  confirmAction(t('batch.killConfirm', { n: ids.length }), async () => {
    let ok = 0;
    for (const id of ids) {
      const res = await api.killOneRoblox(id).catch(() => null);
      if (res && res.ok) ok++;
    }
    toast(t('batch.killedN', { ok, total: ids.length }), ok === ids.length ? 'ok' : 'err');
    clearSelection();
  }, { confirmLabel: t('batch.kill') });
}
let _batchLaunchBusy = false;
async function batchLaunch() {
  if (_batchLaunchBusy) return;
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  if (settings.multiInstance === false && (ids.length > 1 || _launchedIds.size > 0)) {
    toast(t('settings.multiInstanceBlocked'), 'err');
    return;
  }
  _batchLaunchBusy = true;
  let ok = 0, skipped = 0;
  for (const id of ids) {
    const a = accounts.find(x => x.id === id);
    if (!a) continue;
    if (_launchedIds.has(id)) { skipped++; continue; }
    if (!a.cookie) { logEntry('warn', 'launch', `Skipped ${a.username || id}: no cookie`, { accountId: id }); continue; }
    const target = a.gameTarget || null;
    logEntry('info', 'launch', `Launching Roblox for ${a.username || id} (selection)...`, { accountId: id, username: a.username || null, userId: a.userId || null, target: target || 'Roblox home' });
    let res = null;
    try { res = await api.launchRoblox(a.id, a.cookie, target); } catch (e) { res = { success: false, error: e?.message || String(e) }; }
    if (res && res.success) {
      ok++;
      logEntry('ok', 'launch', `Roblox launched successfully as ${a.username || id} (selection)`, { accountId: id, username: a.username || null, userId: a.userId || null });
      markLaunched(a.id);
    } else if (res && !res.cancelled) {
      logEntry('err', 'launch', `Launch failed for ${a.username || id} (selection): ${res.error}`, { accountId: id });
      _flagCookieMaybeDead(a.id, res.error);
    }
  }
  _batchLaunchBusy = false;
  pollRunningCount();
  reorderCardsByStatus();
  const parts = t('batch.launchedN', { ok, total: ids.length });
  toast(skipped ? parts + ' ' + t('batch.skippedRunning', { n: skipped }) : parts, ok > 0 ? 'ok' : 'err');
}
function batchCopyLogins() {
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  const list = ids.map(id => accounts.find(x => x.id === id)).filter(Boolean);
  const valid = list.filter(a => a.username && a.password);
  const missing = list.filter(a => !(a.username && a.password));
  if (!valid.length) {
    const names = missing.map(a => a.nickname || a.username || 'account').slice(0, 5).join(', ');
    toast(t('batch.missingPw', { names: names || '-' }), 'err');
    return;
  }
  const label = t('batch.copyConfirm', { n: valid.length });
  confirmAction(label, () => {
    const text = valid.map(a => a.username + ':' + a.password).join('\n');
    _copySecretWithClear(text, 'batch.copiedN', { ok: valid.length, total: list.length });
    if (missing.length) {
      const names = missing.map(a => a.nickname || a.username || 'account').slice(0, 5).join(', ');
      setTimeout(() => toast(t('batch.missingPw', { names }), 'err'), 600);
    }
  }, { confirmLabel: t('common.copy'), danger: false });
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
  // Pre-check the selected accounts in the new group's picker.
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
function openBatchTarget() {
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  const inp = document.getElementById('batch-target-input');
  if (inp) { inp.value = ''; }
  const sub = document.getElementById('batch-target-sub');
  if (sub) sub.textContent = t('batch.gameDescN', { n: ids.length, s: ids.length === 1 ? '' : 's' });
  openModal('m-batch-target');
  setTimeout(() => inp && inp.focus(), 60);
}
async function submitBatchTarget() {
  const ids = [..._selectedIds];
  if (!ids.length) { toast(t('batch.none'), 'err'); return; }
  const inp = document.getElementById('batch-target-input');
  const btn = document.getElementById('batch-target-save');
  const target = (inp ? inp.value : '').trim();
  if (!target) { toast(t('batch.gameEmpty'), 'err'); if (inp) inp.focus(); return; }
  if (btn) btn.disabled = true;
  let ok = 0;
  for (const id of ids) {
    const a = accounts.find(x => x.id === id);
    if (!a) continue;
    a.gameTarget = target;
    try { delete _gameNameCache[id]; } catch {}
    try { await api.updateAccount(id, { gameTarget: target }); ok++; } catch {}
  }
  if (btn) btn.disabled = false;
  closeModal('m-batch-target');
  render();
  toast(t('batch.gameSet', { ok, total: ids.length }), ok === ids.length ? 'ok' : 'err');
}

// Double-click the card nickname (or the pencil icon) to rename it inline.
function inlineEditNickname(id, el) {
  if (_selectMode) return;
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
    // Save even when empty: clearing the nickname returns the card to the
    // account's real username (a.nickname || a.username).
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

// ── Dashboard activity feed ────────────────────────────────────────────────
// Tiny in-memory timeline of what happened (launch, home, close, kill,
// group, backup). Rendered on the dashboard "Activity" panel.
const _activityFeed = []; // { icon, tone, text, ts }
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

const _cookieStatus = {}; // id -> checking | ok | dead | unknown
const _cookieCheckedAt = {};
const _cookieCheckedValue = {};
const OK_RECHECK_MS = 5 * 60 * 1000;
const UNKNOWN_RECHECK_MS = 60 * 1000;
let _cookieCheckRunning = false;

function applyCookieStatus(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.classList.toggle('cookie-dead', _cookieStatus[id] === 'dead');
  renderDashboard();
}

// Permission failures, throttling and transport errors do not prove expiry.
function _flagCookieMaybeDead(id, error) {
  if (id && /\bHTTP\s+401\b/i.test(String(error || ''))) {
    if (_cookieStatus[id] !== 'dead') pushStatusHistory(id, 'cookie-dead', _cookieStatus[id] || '');
    _cookieStatus[id] = 'dead';
    const account = accounts.find(a => a.id === id);
    if (account) _cookieCheckedValue[id] = account.cookie;
    applyCookieStatus(id);
  }
}

async function _runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function lane() {
    while (next < items.length) await worker(items[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

function _cookieValidationStatus(result) {
  if (result && result.ok) return 'ok';
  return result && result.status === 401 ? 'dead' : 'unknown';
}

async function _validateAccountCookie(account) {
  const cookie = account.cookie;
  const previous = _cookieStatus[account.id];
  _cookieStatus[account.id] = 'checking';
  let result;
  try { result = await api.validateCookie(cookie); }
  catch { result = null; }
  // A deleted account or a replacement session must not inherit a stale reply.
  const current = accounts.find(a => a.id === account.id);
  if (!current || current.cookie !== cookie) {
    delete _cookieStatus[account.id];
    return;
  }
  const next = _cookieValidationStatus(result);
  _cookieStatus[account.id] = next;
  _cookieCheckedAt[account.id] = Date.now();
  _cookieCheckedValue[account.id] = cookie;
  if (next === 'dead' && previous !== 'dead') {
    pushStatusHistory(account.id, 'cookie-dead', previous || '');
    logEntry('warn', 'cookie', 'Session rejected for ' + (account.username || account.id), { accountId: account.id });
  } else if (next === 'ok' && previous === 'dead') {
    pushStatusHistory(account.id, 'cookie-ok', previous);
  }
  applyCookieStatus(account.id);
}

async function checkCookieHealth(list) {
  if (_cookieCheckRunning) return;
  const todo = list.filter(a => a.cookie && _cookieStatus[a.id] === undefined);
  if (!todo.length) return;
  _cookieCheckRunning = true;
  try { await _runWithConcurrency(todo, 2, _validateAccountCookie); }
  finally { _cookieCheckRunning = false; }
}

async function recheckAllCookies(force) {
  if (_cookieCheckRunning) return;
  const now = Date.now();
  const todo = accounts.filter(a => {
    if (!a.cookie) return false;
    if (_cookieCheckedValue[a.id] !== a.cookie) return true;
    // A confirmed rejection stays stopped until the session is replaced.
    if (_cookieStatus[a.id] === 'dead') return false;
    const interval = _cookieStatus[a.id] === 'ok' ? OK_RECHECK_MS : UNKNOWN_RECHECK_MS;
    return force || _cookieCheckedAt[a.id] === undefined || now - _cookieCheckedAt[a.id] >= interval;
  });
  if (!todo.length) return;
  _cookieCheckRunning = true;
  try {
    await _runWithConcurrency(todo, 2, _validateAccountCookie);
    render();
  } finally { _cookieCheckRunning = false; }
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
let _dragging = null, _dragClone = null, _dragOffX = 0, _dragOffY = 0, _dragOverId = null, _dragFromCat = null;

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
      _dragFromCat = card.closest('.folder')?.dataset.cat || null;
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

  // Move the dragged node in place instead of a full re-render. The drop
  // container is the target's own parent, so cards can move across folders.
  const grid = document.getElementById('grid');
  const cards = Array.from(grid.querySelectorAll('.card[data-id]'));
  const srcPos = cards.indexOf(_dragging);
  const tgtPos = cards.indexOf(target);
  if (srcPos < 0 || tgtPos < 0) return;
  target.parentNode.insertBefore(_dragging, srcPos < tgtPos ? target.nextSibling : target);
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
  // Dropped into another folder: adopt the target folder's category.
  if (_dragging) {
    _dragging.style.opacity = '';
    const toCat = _dragging.closest('.folder')?.dataset.cat || null;
    if (toCat !== _dragFromCat) {
      const id = _dragging.dataset.id;
      const a = accounts.find(x => x.id === id);
      const newCat = toCat && toCat !== 'none' ? toCat : null;
      if (a && (a.categoryId || null) !== newCat) {
        a.categoryId = newCat;
        api.updateAccount(id, { categoryId: newCat }).catch(() => {});
      }
    }
    _dragging = null;
  }
  _dragOverId = null;
  _dragFromCat = null;

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
  await finishLogin(res, { askPassword: true });
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
    setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(res.reason || t('login.err')));
    return;
  }
  await finishLogin({ success: true, cookie, username: res.username, userId: res.userId }, { askPassword: true });
}

function cancelLogin() {
  closeModal('m-login');
  api.cancelLogin && api.cancelLogin();
}

async function finishLogin(res, opts) {
  opts = opts || {};
  setStatus('login-status', 'ok', '<span class="material-icons-round">check_circle</span>' + esc(t('login.signedIn', { user: res.username })));
  const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: res.cookie, gameTarget: '' });
  accounts.push(a); render();
  setTimeout(() => {
    closeModal('m-login');
    toast(t('login.added', { user: res.username }), 'ok');
    // Browser/cookie login never sees the password (Roblox page is isolated),
    // so offer to complete it right away instead of hunting the card later.
    if (opts.askPassword && a && !a.password) {
      openEdit(a.id);
      setTimeout(() => {
        const pw = document.getElementById('in-password');
        if (pw) { pw.focus(); pw.placeholder = t('edit.passwordPh') + ' — ' + t('login.passwordOptional'); }
      }, 300);
    } else {
      const grid = document.getElementById('grid');
      if (grid) grid.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 800);
  return a;
}

function openEdit(id) {
  editAcc = accounts.find(a => a.id === id); if (!editAcc) return;
  document.getElementById('edit-title').textContent = t('edit.title');
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
  if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.innerHTML = '<span class="material-icons-round" style="font-size:15px">refresh</span>'+esc(t('edit.refresh')); }
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

function confirmAction(message, onConfirm, opts) {
  opts = opts || {};
  document.getElementById('m-confirm-delete-msg').textContent = message;
  const titleEl = document.getElementById('m-confirm-delete-title');
  if (titleEl) titleEl.textContent = opts.title || t('confirm.title');
  const btn = document.getElementById('m-confirm-delete-btn');
  const newBtn = btn.cloneNode(true); // clone to remove old listeners
  btn.parentNode.replaceChild(newBtn, btn);
  // Reset every time: clone keeps the previous custom label/class.
  newBtn.textContent = opts.confirmLabel || t('common.delete');
  if (opts.danger === false) newBtn.classList.remove('btn-danger');
  else newBtn.classList.add('btn-danger');
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
      <input type="color" class="cat-dot" data-i18n-title="cat.colorTip" title="Click to change color" value="${_hexOrFallback(c.color || catColor(c.id))}" onchange="catSetColor('${c.id}', this.value)"/>
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

function _hexOrFallback(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#5c5ce0';
}
async function catSetColor(id, color) {
  const c = categories.find(x => x.id === id);
  if (!c) return;
  if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) { renderCategories(); return; }
  c.color = color;
  await api.saveSettings({ categories });
  renderCategories();
  renderFilterCategories();
  render();
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
      }, { confirmLabel: t('backup.restore'), title: t('backup.titleRestore'), danger: false });
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
  // After a backup restore, settings.uiPrefs holds theme/language.
  try {
    if (settings && settings.uiPrefs) {
      _restoreUiPrefsFromSettings();
      _loadCustomThemes();
      applyTheme(currentTheme());
      _applyBorderRadius();
      _applyTextureIntensity();
      document.body.classList.toggle('high-contrast', _highContrast());
      if (settings.language && LANG_META[settings.language]) setLanguage(settings.language, false);
      renderThemePage();
    }
  } catch {}
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
  let gameName = _gameNameCache[launchAcc.id] || (target ? extractTargetLabel(target) : '');
  // A specific-server target (from the picker or a pasted id) is shown in
  // the preview so the user sees which server they're about to join.
  if (launchAcc._srvTarget && String(launchAcc._srvTarget).includes(':')) {
    const jobId = String(launchAcc._srvTarget).split(':').slice(1).join(':');
    gameName = (gameName ? gameName + ' · ' : '') + t('srv.server') + ' #' + String(jobId).slice(0, 8);
  }
  const p = document.getElementById('launch-prev');
  if (typeof workspaceLaunchDetails === 'function') workspaceLaunchDetails(launchAcc,gameName);
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
  btn.disabled = false; btn.textContent = t('launch.start');
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
  // Drop any stale specific-server target from a cancelled launch.
  if (launchAcc) { launchAcc._srvTarget = null; launchAcc._srvPlaceId = null; }
  closeModal('m-launch');
}

async function doLaunch() {
  if (!launchAcc) return;
  if (_pkgLaunchingAccounts.has(launchAcc.id)) { toast(t('pkg.launchBusy'), 'err'); return; }
  const btn = document.getElementById('btn-launch');
  if (btn.disabled) return;
  // When multi-instance is off, refuse to launch a second account.
  if (settings.multiInstance === false && _launchedIds.size > 0) {
    toast(t('settings.multiInstanceBlocked'), 'err');
    closeModal('m-launch');
    return;
  }
  _launchingId = launchAcc.id;
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Launching';
  setStatus('launch-status', 'load', '<div class="spin"></div>' + esc(t('launch.gettingTicket')));
  logEntry('info', 'launch', `Launching Roblox for ${launchAcc.username || launchAcc.id}...`, { accountId: launchAcc.id, username: launchAcc.username, userId: launchAcc.userId, target: launchAcc.gameTarget || 'Roblox home' });
  let res;
  let target = null;
  try {
    // _srvTarget is a one-shot override set by "join this specific server".
    target = launchAcc._srvTarget || launchAcc.gameTarget || null;
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
  // If this launch targeted a specific server (placeId:jobId), remember it
  // so every account's server picker can highlight where this account is.
  // Anything else (plain place id, a URL, or a home launch) means the
  // account isn't on a tracked specific server, so drop it from any
  // previous highlight.
  if (target && /^\d+[,:][0-9a-fA-F-]{20,}$/.test(target)) {
    const [pid, ...rest] = target.split(/[:,]/);
    _srvAddJoined(launchAcc.id, pid, rest.join(':'));
  } else {
    _srvAccountLeft(launchAcc.id);
  }
  setTimeout(() => { closeModal('m-launch'); toast(t('acct.launchedAs', { u: launchAcc.username }), 'ok'); }, 700);
}

// ── Server list (pick a specific server to join) ────────────────────────
let _srvCtx = null;   // { placeId, accountId }
let _srvList = [];
let _srvHideFull = false;   // "hide full servers" filter
let _srvSort = 'recommended';
// Persisted recent-server highlights (settings.srvHighlights). Keyed by job
// id so several servers can be highlighted at once and a server is never
// duplicated. Contains only server metadata — never accounts (account
// presence is runtime-only, see _srvPresence).
let _srvHighlighted = {};   // jobId -> { placeId, jobId, lastSeen }
// Runtime account presence on tracked servers. Not persisted — rebuilt on
// startup as accounts launch and join servers. This is what drives the
// "ST1 is here" labels in the server picker.
let _srvPresence = {};      // jobId -> [accountId, ...]

// Roblox job ids are UUIDs; anything else (URL fragments etc.) is not a
// joinable server and must never pollute the highlight store.
const _SRV_JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _srvPersist() {
  try {
    if (api && api.saveSettings) api.saveSettings({ srvHighlights: _srvHighlighted }).catch(() => {});
  } catch (e) { /* persistence must never break the flow */ }
}

// Registers that `accountId` is now in server `jobId` of game `placeId`.
// Idempotent: the same account joining the same server again only refreshes
// lastSeen. Multiple accounts on the same server share one entry.
function _srvAddJoined(accountId, placeId, jobId) {
  if (!accountId || !placeId || !jobId) return;
  const pid = String(placeId);
  const jid = String(jobId);
  if (!/^\d+$/.test(pid) || !_SRV_JOB_RE.test(jid)) return;
  // Update runtime presence (in-memory only — not persisted).
  if (!_srvPresence[jid]) _srvPresence[jid] = [];
  if (!_srvPresence[jid].includes(accountId)) _srvPresence[jid].push(accountId);
  // Update persisted highlight metadata (never accounts).
  _srvHighlighted[jid] = { placeId: pid, jobId: jid, lastSeen: Date.now() };
  _srvPersist();
}

// The account left its game(s) (closed / went home / launched without a
// specific server). It is removed from every highlight, but the highlighted
// server records themselves are KEPT — they stay visible as recently-used
// until a fresh API sample confirms they no longer exist (_srvPruneHighlighted).
function _srvAccountLeft(accountId) {
  // Collect highlight keys where this account was present.
  const touched = Object.keys(_srvPresence).filter(key => _srvPresence[key].includes(accountId));
  if (!touched.length) return;
  // Remove account from runtime presence.
  for (const key of touched) {
    const arr = _srvPresence[key];
    const idx = arr.indexOf(accountId);
    if (idx !== -1) {
      arr.splice(idx, 1);
      if (!arr.length) delete _srvPresence[key];
    }
  }
  // Touch lastSeen on corresponding highlights (server was recently active).
  let changed = false;
  for (const key of touched) {
    if (_srvHighlighted[key]) { _srvHighlighted[key].lastSeen = Date.now(); changed = true; }
  }
  if (changed) _srvPersist();
}

// Called after a successful fresh API sample: highlighted servers for this
// placeId that (a) nobody is on anymore and (b) are not in the sample have
// almost certainly ceased to exist — drop them. Servers with accounts on
// them are always kept (the account's presence is the evidence they are
// alive). An empty sample (API hiccup / rate limit) never prunes anything.
function _srvPruneHighlighted(placeId, sample) {
  const pid = String(placeId);
  const inSample = new Set((sample || []).map(s => s.id));
  let changed = false;
  for (const key of Object.keys(_srvHighlighted)) {
    const j = _srvHighlighted[key];
    if (!j || String(j.placeId) !== pid) continue;
    // If any account is currently on this server (runtime presence), keep it.
    if ((_srvPresence[key] || []).length > 0) continue;
    if (inSample.has(key)) continue;
    delete _srvHighlighted[key];
    changed = true;
  }
  if (changed) _srvPersist();
}

function toggleSrvFilter(el) {
  _srvHideFull = !!el && el.checked;
  // Turning the filter ON re-fetches (needs more pages to find free
  // slots); turning it OFF re-renders what we already have.
  if (_srvHideFull) {
    _fetchServers();
  } else {
    const list = document.getElementById('srv-list');
    if (list) _renderSrvList(list);
  }
}

function toggleSrvSort(el) {
  _srvSort = el ? el.value : 'recommended';
  // least/most/recommended are sorted server-side via sortOrder, so a
  // re-fetch is needed; ping is re-sorted client-side only.
  if (_srvSort === 'ping') {
    const list = document.getElementById('srv-list');
    if (list) _renderSrvList(list);
  } else {
    // Force fresh: the API orders by occupancy (Asc/Desc) and the 20s cache
    // is per-place — reusing it after a sort change would keep showing the
    // previous sort's data (e.g. "most players" stuck on 1-person servers).
    _fetchServers(true);
  }
}

function _srvSortFn() {
  const fns = {
    // least occupied first — the original "recommended" behaviour
    recommended: (a, b) => (a.s.playing / (a.s.maxPlayers || 1)) - (b.s.playing / (b.s.maxPlayers || 1)),
    least: (a, b) => a.s.playing - b.s.playing,
    most: (a, b) => b.s.playing - a.s.playing,
    ping: (a, b) => (a.s.ping != null ? a.s.ping : 99999) - (b.s.ping != null ? b.s.ping : 99999),
  };
  return fns[_srvSort] || fns.recommended;
}

function _srvHereCount(s) {
  if (!_srvCtx) return 0;
  const pid = String(_srvCtx.placeId);
  const j = _srvHighlighted[s.id];
  return (j && String(j.placeId) === pid) ? (_srvPresence[s.id] || []).length : 0;
}

function _srvHereLabel(s) {
  if (!_srvCtx) return '';
  const pid = String(_srvCtx.placeId);
  const j = _srvHighlighted[s.id];
  if (!j || String(j.placeId) !== pid) return '';
  return (_srvPresence[s.id] || []).map(aid => {
    const a = accounts.find(x => x.id === aid);
    return a ? (a.nickname || a.username || aid) : aid;
  }).join(', ');
}

// Servers where accounts are joined (this one or others) may not be in the
// API sample. Inject them as synthetic top entries so the user always sees
// where every account is, including their own.
function _srvInjectJoined() {
  if (!_srvCtx) return;
  const pid = String(_srvCtx.placeId);
  const known = new Set(_srvList.map(s => s.id));
  const injected = [];
  Object.keys(_srvHighlighted).forEach(jobId => {
    const j = _srvHighlighted[jobId];
    if (!j || String(j.placeId) !== pid) return;
    if (known.has(jobId)) return;
    // Server not in the fresh API sample: it may have closed/emptied since
    // the account joined. Keep the marker so the user still sees it; it is
    // re-validated right before joining and pruned once the API confirms
    // it is gone (see _srvPruneHighlighted).
    injected.push({ id: jobId, playing: 0, maxPlayers: 0, ping: null, region: '?', _synthetic: true, _joinedBy: (_srvPresence[jobId] || []).slice() });
    known.add(jobId);
  });
  if (injected.length) _srvList = injected.concat(_srvList);
}

function _renderSrvList(list) {
  const servers = _srvList;
  if (!servers.length) {
    list.innerHTML = '<div class="srv-state"><span class="material-icons-round srv-state-ic">dns</span><div class="srv-state-title" data-i18n="srv.noneTitle">No servers found</div><div class="srv-state-desc" data-i18n="srv.noneDesc">This game has no public servers right now.</div><button class="btn btn-ghost" onclick="refreshServerList()" style="gap:6px"><span class="material-icons-round" style="font-size:14px">refresh</span><span data-i18n="srv.refresh">Refresh</span></button></div>';
    return;
  }
  const sorted = servers.map((s, i) => ({ s, i, here: _srvHereCount(s) }))
    .sort((a, b) => (b.here - a.here) || _srvSortFn()(a, b))
    .filter(x => {
      // "Most players": populated but not full — at least 2 players, still a
      // free slot — sorted most -> least by the client sort. Empty and full
      // servers stay in the general list under the other sorts.
      if (_srvSort === 'most') return x.s.playing >= 2 && x.s.playing < (x.s.maxPlayers || 1);
      return !(_srvHideFull && x.s.playing >= (x.s.maxPlayers || 1));
    });
  if (!sorted.length) {
    list.innerHTML = '<div class="srv-state"><span class="material-icons-round srv-state-ic">filter_alt_off</span><div class="srv-state-title" data-i18n="srv.noFreeTitle">No servers with free slots</div><div class="srv-state-desc" data-i18n="srv.noFreeDesc">Try turning off the &quot;hide full servers&quot; filter.</div></div>';
    return;
  }
  list.innerHTML = sorted.map((x, idx) => {
      const s = x.s;
      // Synthetic: server where another account is joined but not in the API sample
      if (s._synthetic) {
        const joinedBy = (s._joinedBy || []).map(aid => { const a = accounts.find(x => x.id === aid); return a ? (a.nickname || a.username || aid) : aid; }).join(', ');
        return '<div class="srv-item srv-item-synthetic" style="animation-delay:' + (idx * 35) + 'ms">' +
          '<div class="srv-item-left" style="display:flex;align-items:center;gap:10px;flex:1">' +
            (joinedBy ? '<span class="srv-here"><span class="material-icons-round">person_pin</span>' + esc(joinedBy) + ' ' + esc(t('srv.isHere')) + '</span>' : '') +
            '<span class="srv-item-id">' + esc(t('srv.server')) + ' #' + esc(String(s.id).slice(0, 8)) + '</span>' +
          '</div>' +
          '<div class="srv-item-right">' +
            '<button class="btn btn-ghost srv-copy" onclick="copyServerId(\'' + s.id + '\')" title="' + esc(t('srv.copy')) + '"><span class="material-icons-round">content_copy</span></button>' +
            ((_srvCtx.accountId || _srvCtx.packageId) ? '<button class="btn btn-primary srv-enter" data-srv-job="' + s.id + '" onclick="' + (_srvCtx.packageId ? 'launchPkgToServer' : 'launchToServer') + '(\'' + s.id + '\')"><span class="material-icons-round" style="font-size:14px">play_arrow</span>' + esc(t('srv.enter')) + '</button></div>' : '') +
        '</div>';
      }
      const max = s.maxPlayers || 1;
    const playing = Math.min(s.playing, max);
    const full = s.playing >= max;
    const pct = Math.round((playing / max) * 100);
    const ping = s.ping != null ? s.ping + ' ms' : '—';
    const status = full ? t('srv.full') : t('srv.available');
    const statusCls = full ? 'srv-status-full' : 'srv-status-ok';
    const srvHere = _srvHereLabel(s);
    const act = (_srvCtx.accountId || _srvCtx.packageId)
          ? '<button class="btn srv-enter' + (full ? ' btn-ghost' : ' btn-primary') + '" data-srv-job="' + s.id + '" onclick="' + (_srvCtx.packageId ? 'launchPkgToServer' : 'launchToServer') + '(\'' + s.id + '\')"><span class="material-icons-round" style="font-size:14px">play_arrow</span>' + esc(t('srv.enter')) + '</button>'
          : '';
    return '<div class="srv-item' + (full ? ' srv-item-full' : '') + '" style="animation-delay:' + (idx * 35) + 'ms">' +
      '<div class="srv-item-left">' +
        '<div class="srv-item-top">' +
          '<span class="srv-item-id-wrap"><span class="srv-item-id">' + esc(t('srv.server')) + ' #' + esc(String(s.id).slice(0, 8)) + '</span>' +
            // Highlight servers where other accounts are joined
            (srvHere ? '<span class="srv-here"><span class="material-icons-round">person_pin</span>' + esc(srvHere) + '</span>' : '') +
            '<button class="srv-copy" onclick="copyServerId(\'' + s.id + '\')" title="' + esc(t('srv.copyId')) + '" aria-label="' + esc(t('srv.copyId')) + '"><span class="material-icons-round">content_copy</span></button></span>' +
          '<span class="srv-item-ping"><span class="material-icons-round">speed</span>' + ping + '</span>' +
        '</div>' +
        '<div class="srv-item-players"><b>' + playing + '</b><span class="srv-item-max"> / ' + max + ' ' + esc(t('srv.players')) + '</span></div>' +
        '<div class="srv-bar"><div class="srv-bar-fill' + (full ? ' srv-bar-full' : '') + '" style="width:' + pct + '%"></div></div>' +
        '<div class="srv-item-bottom"><span class="srv-status ' + statusCls + '"><span class="srv-dot"></span>' + esc(status) + '</span>' + (s.region ? '<span class="srv-region">' + esc(s.region) + '</span>' : '') + '</div>' +
      '</div>' +
      (act ? '<div class="srv-item-act">' + act + '</div>' : '') +
    '</div>';
  }).join('');
}

async function openServerList(placeId, ctx) {
  _srvCtx = ctx || { placeId };
  _srvList = [];
  const sub = document.getElementById('srv-sub');
  if (sub) {
    if (ctx && ctx.packageId) {
      const p = packages.find(x => x.id === ctx.packageId);
      sub.textContent = (p ? p.name + ' · ' : '') + t('srv.game') + ' ' + placeId;
    } else {
      sub.textContent = t('srv.game') + ' ' + placeId;
    }
  }
  openModal('m-servers');
  _srvStartPolling();
  await _fetchServers();
}

async function refreshServerList() {
  const btn = document.getElementById('srv-refresh');
  const ic = document.getElementById('srv-refresh-ic');
  if (btn) btn.disabled = true;
  if (ic) ic.classList.add('spinning');
  try {
    // Bounded retry rides out a transient API drop before showing an error,
    // so a single failed force-refresh doesn't look like a hang.
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      ok = await _fetchServers(true); // force fresh — never reuse the cache
      if (!ok && attempt === 0) await new Promise(r => setTimeout(r, 1200));
    }
    if (!ok) toast(t('srv.refreshFail'), 'err');
  } finally {
    if (btn) btn.disabled = false;
    if (ic) ic.classList.remove('spinning');
  }
}

function _srvSortOrder() {
  // The API itself sorts servers by occupancy via sortOrder:
  //   Asc  -> least occupied first (1/28, 2/28, ...)
  //   Desc -> most occupied first (28/28, 27/28, ...)
  // "recommended" maps to Asc too: showing free servers first is the
  // useful default for someone who wants to join.
  if (_srvSort === 'least' || _srvSort === 'recommended') return 'Asc';
  if (_srvSort === 'most') return 'Desc';
  return ''; // ping — the API has no ping sort; the client re-sorts
}

// Extracts a numeric placeId from any common format: a pure id, a
// "placeId:jobId" pair, or a roblox.com/games/<id> URL. Returns '' when
// nothing numeric is found.
function _extractPlaceId(str) {
  const s = String(str || '').trim();
  if (!s) return '';
  const m = s.match(/^\d+/);
  if (m) return m[0];
  const u = s.match(/roblox\.com\/games\/(\d+)/);
  if (u) return u[1];
  return '';
}

// Only accept a real public-server record with measured occupancy.
function _srvHasSlots(s, requiredSlots = 1, minPlayers = 0) {
  return !!s && typeof s.id === 'string' && /^[a-zA-Z0-9-]+$/.test(s.id)
    && Number.isInteger(s.playing) && Number.isInteger(s.maxPlayers)
    && s.playing >= minPlayers && s.maxPlayers > 0
    && s.maxPlayers - s.playing >= requiredSlots;
}

function _srvCandidateOrder(a, b) {
  return a.playing - b.playing || (a.ping ?? Infinity) - (b.ping ?? Infinity)
    || a.id.localeCompare(b.id);
}

// Public metadata never needs an account cookie. Fail explicitly on HTTP
// errors; do not turn an unavailable server list into a generic game join.
async function _srvFetchCandidates(placeId, { needed = 1, slots = 1, minPlayers = 0, maxPages = 8, exclude = new Set(), cancelled = () => false } = {}) {
  const servers = new Map();
  const cursors = new Set();
  let cursor = '';
  for (let page = 0; page < maxPages && !cancelled(); page++) {
    const url = 'https://games.roblox.com/v1/games/' + placeId + '/servers/Public?limit=50&sortOrder=Asc'
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await api.robloxGet(url);
    if (cancelled()) break;
    if (!r?.ok) {
      const error = new Error('Server list request failed (HTTP ' + (r?.status || 0) + ')');
      error.status = r?.status || 0;
      throw error;
    }
    if (!Array.isArray(r.data?.data)) throw new Error('Invalid server list response');
    for (const s of r.data.data) {
      if (s?.id) servers.delete(s.id); // the newest duplicate wins, even if now full
      if (_srvHasSlots(s, slots, minPlayers) && !exclude.has(s.id)) servers.set(s.id, s);
    }
    cursor = r.data.nextPageCursor || '';
    if (servers.size >= needed || !cursor || cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  return [...servers.values()].sort(_srvCandidateOrder);
}

// ── Central server data layer ─────────────────────────────────────────────
// One cache per placeId so multiple accounts/groups using the same game
// share the same fetch (no duplicate API calls). Entries expire after
// SRV_TTL so the picker never shows stale servers for long.
let _srvCache = {};    // placeId -> { at, servers }
const SRV_TTL = 20000; // ms — how long a fetched list is considered fresh
const SRV_POLL = 30000; // ms — auto-refresh while the picker is open

// Fetches the public server list for a placeId, reusing a short-lived
// cache unless forceFresh. Always Asc (least occupied first) so free slots
// are found fast; the visual sort is applied client-side when rendering.
// When `full` is true, ALL requested pages are fetched (no early stop) —
// used for validation, where the target jobId may live on a later page.
async function _srvFetchRaw(placeId, maxPages, forceFresh, full) {
  const now = Date.now();
  if (!forceFresh && _srvCache[placeId] && now - _srvCache[placeId].at < SRV_TTL) {
    return _srvCache[placeId];
  }
  const acc = _srvCtx && _srvCtx.accountId ? accounts.find(a => a.id === _srvCtx.accountId) : null;
  const fetchers = [];
  if (acc && acc.cookie) fetchers.push((u) => api.robloxGetAuth(u, acc.cookie));
  fetchers.push((u) => api.robloxGet(u));
  let lastErr = null;
  for (const fetcher of fetchers) {
    try {
      let allServers = [];
      let cursor = '';
      for (let page = 0; page < maxPages; page++) {
        const srvUrl = 'https://games.roblox.com/v1/games/' + placeId + '/servers/Public?limit=50&sortOrder=' + (_srvSortOrder() || 'Asc') + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const r = await fetcher(srvUrl);
        if (!r || !r.ok) {
          const error = new Error('Server list request failed (HTTP ' + (r?.status || 0) + ')');
          error.status = r?.status || 0;
          throw error;
        }
        const data = (r && r.data) || {};
        const batch = (data.data) || [];
        allServers = allServers.concat(batch);
        cursor = data.nextPageCursor || '';
        if (!full && allServers.some(s => s.playing < (s.maxPlayers || 1))) break;
        if (!cursor) break;
      }
      // Deduplicate by job id (a server can appear across pages).
      const seen = new Set();
      allServers = allServers.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
      _srvCache[placeId] = { at: Date.now(), servers: allServers };
      _srvCacheSweep();
      // A fresh, non-empty sample is the API's current truth: highlighted
      // servers for this game that nobody is on anymore and that are not in
      // the sample have ceased to exist — drop them (no extra requests).
      if (allServers.length) _srvPruneHighlighted(placeId, allServers);
      return _srvCache[placeId];
    } catch (e) {
      if ([401, 403, 429].includes(e.status)) throw e;
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  _srvCache[placeId] = { at: Date.now(), servers: [] };
  return _srvCache[placeId];
}

// Re-validates a single server RIGHT BEFORE joining with a bounded sample.
// A bounded sample can confirm that a server is full; it cannot prove a
// missing server is dead. Roblox resolves an explicit jobId when it is not
// in the sample, avoiding twenty API pages and false "server gone" errors.
async function _srvValidateServer(placeId, jobId, requiredSlots = 1) {
  try {
    const fresh = await _srvFetchRaw(placeId, 1, true, true);
    const server = fresh.servers.find(s => String(s.id) === String(jobId));
    if (server && !_srvHasSlots(server, requiredSlots)) return { ok: false, reason: 'full', server };
    return { ok: true, server: server || null };
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message || String(e) };
  }
}

function _srvValidationFailed(result) {
  if (result.ok) return false;
  toast(result.reason === 'error' ? result.error : t('srv.fullNow'), 'err');
  return true;
}

// Keeps the cache bounded: drops expired entries once it grows past a
// sane size (placeIds accumulate as the user opens different games).
function _srvCacheSweep() {
  const keys = Object.keys(_srvCache);
  if (keys.length > 12) {
    const now = Date.now();
    keys.forEach(k => { if (now - _srvCache[k].at > SRV_TTL) delete _srvCache[k]; });
  }
}

// Overlapping fetches (30s poll vs manual refresh vs sort change) used to
// race: an older response rendered last and the skeleton flashed on every
// background tick. The seq guard drops stale responses; quiet background
// ticks never wipe the list (no skeleton, no error screen on hiccup).
let _srvFetchSeq = 0;
async function _fetchServers(force, quiet) {
  const list = document.getElementById('srv-list');
  if (!_srvCtx) return false;
  const placeId = _srvCtx.placeId;
  const seq = ++_srvFetchSeq;
  if (list && !quiet) list.innerHTML = '<div class="srv-skeleton"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div>';
  try {
    // "Most players" needs deeper pages: Desc puts the fullest servers
    // first, and the populated-but-not-full ones sit past the full pages —
    // a single page would often return only full servers.
    const maxPages = _srvSort === 'most' ? 8 : (_srvHideFull ? 10 : 1);
    const data = await _srvFetchRaw(placeId, maxPages, !!force, false);
    if (seq !== _srvFetchSeq) return true; // a newer fetch started: ignore
    // Empty sample on a background tick is almost always a hiccup/429, not
    // a game that suddenly has zero servers: keep the old list.
    if (!data.servers.length && quiet && _srvList.length) return true;
    _srvList = data.servers.slice();
    _srvInjectJoined();
    if (list) _renderSrvList(list);
    return true;
  } catch (e) {
    if (seq !== _srvFetchSeq) return true;
    if (quiet) return false; // background tick hiccup: keep the old list
    if (list) list.innerHTML = '<div class="srv-state"><span class="material-icons-round srv-state-ic srv-state-err">error_outline</span><div class="srv-state-title" data-i18n="srv.errTitle">Could not load servers</div><div class="srv-state-desc">' + esc(e.message || String(e)) + '</div><button class="btn btn-ghost" onclick="refreshServerList()" style="gap:6px"><span class="material-icons-round" style="font-size:14px">refresh</span><span data-i18n="srv.retry">Try again</span></button></div>';
    return false;
  }
}

// Keeps the open picker list fresh while the user is looking at it.
let _srvPollTimer = null;
function _srvStartPolling() {
  _srvStopPolling();
  _srvPollTimer = setInterval(() => {
    const modal = document.getElementById('m-servers');
    if (modal && modal.classList.contains('open')) _fetchServers(false, true);
  }, SRV_POLL);
}
function _srvStopPolling() {
  if (_srvPollTimer) { clearInterval(_srvPollTimer); _srvPollTimer = null; }
}
// Finds the picker's "Enter" button for a given server so we can show a
// spinner and disable it while the fresh API re-check runs (avoids the
// feeling of a hang and double-clicks). The button is re-rendered often, so
// it's located by its data attribute at call time.
function _srvEnterBtn(jobId) {
  const q = String(jobId).replace(/"/g, '\\"');
  return document.querySelector('.srv-enter[data-srv-job="' + q + '"]');
}
function _srvEnterSpinner(jobId, on) {
  const btn = _srvEnterBtn(jobId);
  if (!btn) return;
  if (on) {
    btn._srvPrevHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="spin"></div>';
  } else {
    btn.disabled = false;
    if (btn._srvPrevHtml != null) { btn.innerHTML = btn._srvPrevHtml; btn._srvPrevHtml = null; }
  }
}

const _srvPendingEntries = new Set();
async function launchToServer(jobId, explicitPlaceId = null) {
  const ctx = _srvCtx;
  const s = _srvList.find(x => x.id === jobId) || { id: jobId };
  if (!s.id || !ctx?.accountId) return;
  const id = ctx.accountId;
  const placeId = explicitPlaceId || ctx.placeId;
  const acc = accounts.find(a => a.id === id);
  if (!acc || _srvPendingEntries.has(id) || _pkgLaunchingAccounts.has(id)) return;
  _srvPendingEntries.add(id);
  // Visual-only: spinner + disable the clicked Enter button while the fresh
  // re-check runs, so the API delay doesn't look like a hang.
  _srvEnterSpinner(jobId, true);
  try {
    // Synthetic cards where an account IS currently joined are known-live —
    // the account sitting there proves the server exists — so skip the fresh
    // re-check. Empty highlights (account left; kept as "recently used") are
    // re-validated so nobody tries to join a server that is already gone.
    // Any server an account is CURRENTLY on (runtime presence) is provably
    // live, so skip the re-check there too — the launch modal opens instantly
    // instead of waiting on a fresh API fetch (which can lag a couple seconds).
    if (!(_srvPresence[s.id] || []).length) {
      const v = await _srvValidateServer(placeId, s.id);
      if (_srvValidationFailed(v)) return;
    }
    if (_srvCtx !== ctx) return; // a different picker was opened while waiting
    const target = placeId + ':' + s.id;
    closeModal('m-servers');
    // Temporarily override the account's target for this single launch only.
    acc._srvTarget = target;
    acc._srvPlaceId = placeId;
    openLaunch(id);
    logEntry('info', 'launch', 'Targeting specific server for ' + (acc.username || id), { accountId: id, target });
  } finally {
    _srvPendingEntries.delete(id);
    _srvEnterSpinner(jobId, false);
  }
}

// Opens the server picker for a group's game. Every server's "Enter" button
// then launches ALL accounts of the group into that server.
function openPkgServerList(pkgId) {
  const p = packages.find(x => x.id === pkgId);
  if (!p) return;
  const link = String(p.link || '').trim();
  const placeId = _extractPlaceId(link);
  if (!placeId) { toast(t('srv.errResolve'), 'err'); return; }
  openServerList(parseInt(placeId, 10), { packageId: pkgId, placeId: parseInt(placeId, 10) });
}

async function launchPkgToServer(jobId) {
  const ctx = _srvCtx;
  if (!ctx?.packageId || !jobId) return;
  const p = packages.find(x => x.id === ctx.packageId);
  if (!p) return;
  _srvEnterSpinner(jobId, true);
  try { await _launchPkgAtServer(p, ctx.placeId, jobId); }
  finally { _srvEnterSpinner(jobId, false); }
}

async function _launchPkgAtServer(p, placeId, jobId) {
  const members = pkgMembers(p);
  if (!members.length) { toast(t('pkg.noAccounts'), 'err'); return; }
  if (settings.multiInstance === false) { toast(t('settings.multiInstanceGroupBlocked'), 'err'); return; }
  const job = _pkgBeginLaunch(p, members);
  if (!job) return;
  try {
    const validation = await _srvValidateServer(placeId, jobId, members.length);
    if (job.cancelled || _srvValidationFailed(validation)) return;
    const target = placeId + ':' + jobId;
    closeModal('m-servers');
    const entries = members.map(account => ({ account, target }));
    const result = await _pkgExecuteLaunches(job, entries, Math.max(0, Math.min(60000, Number(p.launchDelay) || 0)));
    _pkgReportLaunch(job, p, result, members.length);
  } catch (e) {
    if (!job.cancelled) toast(e?.message || String(e), 'err');
  } finally { _pkgFinishLaunch(job); }
}

// Group operations use state, not DOM attributes, as the concurrency lock.
// Re-rendering a card must never permit a second launch of the same accounts.
const _pkgLaunchJobs = new Map();
const _pkgLaunchingAccounts = new Set();
const _pkgReservedServers = new Map();

function _refreshLaunchPresentation() {
  if (typeof refreshAccountStatuses === 'function') refreshAccountStatuses();
}

function _pkgBeginLaunch(p, members) {
  if (_pkgLaunchJobs.has(p.id) || members.some(m => _pkgLaunchingAccounts.has(m.id) || _srvPendingEntries.has(m.id) || _launchingId === m.id)) {
    toast(t('pkg.launchBusy'), 'err');
    return null;
  }
  const card = document.querySelector('.pkg-card[data-id="' + p.id + '"]');
  if (card?.querySelector('.pkg-kill-btn')?.dataset.busy === '1') {
    toast(t('pkg.killBusy'), 'err');
    return null;
  }
  const job = { id: p.id, members, cancelled: false, currentAccount: null, completed: new Set(), reserved: [], wake: null };
  _pkgLaunchJobs.set(p.id, job);
  members.forEach(m => _pkgLaunchingAccounts.add(m.id));
  renderPackages();
  return job;
}

function _pkgFinishLaunch(job) {
  _pkgLaunchJobs.delete(job.id);
  job.members.forEach(m => _pkgLaunchingAccounts.delete(m.id));
  job.reserved.forEach(key => { if (_pkgReservedServers.get(key) === job) _pkgReservedServers.delete(key); });
  renderPackages();
}

async function cancelPackageLaunch(id) {
  const job = _pkgLaunchJobs.get(id);
  if (!job || job.cancelled) return;
  job.cancelled = true;
  if (job.wake) job.wake();
  if (job.currentAccount) {
    try { await api.cancelLaunch(job.currentAccount); } catch (e) {
      logEntry('warn', 'launch', e?.message || String(e), { accountId: job.currentAccount });
    }
  }
  renderPackages();
}

async function _pkgLaunchDelay(job, delay) {
  if (delay <= 0 || job.cancelled) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, delay);
    job.wake = () => { clearTimeout(timer); resolve(); };
  });
  job.wake = null;
}

// An uncertain/failed spawn is never retried with a different server: the
// first process may already exist. Each account gets exactly one attempt.
async function _pkgExecuteLaunches(job, entries, delay = 0) {
  const result = { ok: 0, errors: [], attempted: 0 };
  for (let i = 0; i < entries.length && !job.cancelled; i++) {
    const { account: m, target } = entries[i];
    job.currentAccount = m.id;
    _refreshLaunchPresentation();
    logEntry('info', 'launch', 'Launching Roblox for ' + (m.username || m.id), { accountId: m.id, target: target || 'Roblox home' });
    let res;
    try { res = await api.launchRoblox(m.id, m.cookie, target); }
    catch (e) { res = { success: false, error: e?.message || String(e) }; }
    finally { job.currentAccount = null; }
    result.attempted++;
    job.completed?.add(m.id);
    if (res?.success) {
      result.ok++;
      markLaunched(m.id);
      const specific = String(target || '').match(/^(\d+):([a-zA-Z0-9-]+)$/);
      if (specific) _srvAddJoined(m.id, specific[1], specific[2]);
      else _srvAccountLeft(m.id);
    } else if (res?.cancelled) {
      job.cancelled = true;
    } else {
      const error = res?.error || 'Launch failed';
      result.errors.push(error);
      _flagCookieMaybeDead(m.id, error);
      logEntry('err', 'launch', error, { accountId: m.id, target });
      // Respect a global rate limit instead of marching through the group.
      if (res?.status === 429 || /HTTP\s*429|rate[ -]?limit|cooldown|Retry-After/i.test(error)) break;
    }
    _refreshLaunchPresentation();
    if (i < entries.length - 1) await _pkgLaunchDelay(job, delay);
  }
  return result;
}

function _pkgReportLaunch(job, p, result, total, distributed = false) {
  if (job.cancelled) toast(t('common.cancel') + ' · ' + result.ok + '/' + total, '');
  else if (result.errors.length) toast(result.ok + '/' + total + ' · ' + result.errors[0], 'err');
  else toast(t(distributed ? (result.ok < total ? 'pkg.distributedPartial' : 'pkg.distributedN') : 'pkg.launchedN', { ok: result.ok, total, name: p.name }), result.ok === total ? 'ok' : 'err');
}

function _srvDistributionExclusions(placeId) {
  const exclude = new Set();
  for (const [jobId, ids] of Object.entries(_srvPresence)) {
    if (ids.length) exclude.add(jobId);
  }
  for (const key of _pkgReservedServers.keys()) {
    if (key.startsWith(placeId + ':')) exclude.add(key.slice(String(placeId).length + 1));
  }
  return exclude;
}

// One distinct nonempty public server per account, lowest population first.
// Leave excess accounts untouched when there are fewer suitable servers.
async function distributePkg(pkgId) {
  const p = packages.find(x => x.id === pkgId);
  if (!p) return;
  const members = pkgMembers(p);
  if (!members.length) { toast(t('pkg.noAccounts'), 'err'); return; }
  if (settings.multiInstance === false) {
    toast(t('settings.multiInstanceGroupBlocked'), 'err');
    return;
  }
  const link = String(p.link || '').trim();
  const placeId = _extractPlaceId(link);
  if (!placeId) { toast(t('srv.errResolve'), 'err'); return; }
  const job = _pkgBeginLaunch(p, members);
  if (!job) return;
  try {
    const servers = await _srvFetchCandidates(placeId, {
      needed: members.length, minPlayers: 1,
      exclude: _srvDistributionExclusions(placeId), cancelled: () => job.cancelled,
    });
    if (job.cancelled) return;
    // Another group may have reserved a server while this fetch was pending.
    const excludedNow = _srvDistributionExclusions(placeId);
    const chosen = servers.filter(s => !excludedNow.has(s.id)).slice(0, members.length);
    if (!chosen.length) { toast(t('pkg.noLivelyServers'), 'err'); return; }
    for (const s of chosen) {
      const key = placeId + ':' + s.id;
      _pkgReservedServers.set(key, job);
      job.reserved.push(key);
    }
    const entries = chosen.map((s, i) => ({ account: members[i], target: placeId + ':' + s.id }));
    const result = await _pkgExecuteLaunches(job, entries, Math.max(0, Math.min(60000, Number(p.launchDelay) || 0)));
    _pkgReportLaunch(job, p, result, members.length, true);
  } catch (e) {
    logEntry('err', 'launch', e?.message || String(e), { packageId: p.id });
    if (!job.cancelled) toast(e?.message || String(e), 'err');
  } finally { _pkgFinishLaunch(job); }
}

// A random join uses one bounded fresh search and never retries failed auth.
let _srvRandomPending = false;
async function joinRandomServer() {
  const ctx = _srvCtx;
  if (!ctx || (!ctx.accountId && !ctx.packageId) || _srvRandomPending) return;
  _srvRandomPending = true;
  const btn = document.getElementById('srv-random');
  const previousHtml = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>'; }
  try {
    const p = ctx.packageId ? packages.find(x => x.id === ctx.packageId) : null;
    const pool = await _srvFetchCandidates(ctx.placeId, {
      needed: 5, slots: p ? Math.max(1, pkgMembers(p).length) : 1, maxPages: 3,
      exclude: _srvDistributionExclusions(String(ctx.placeId)), cancelled: () => _srvCtx !== ctx,
    });
    if (_srvCtx !== ctx) return;
    if (!pool.length) { toast(t('srv.randomNone'), 'err'); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (ctx.packageId) await launchPkgToServer(pick.id);
    else await launchToServer(pick.id);
  } catch (e) {
    toast(e?.message || String(e), 'err');
  } finally {
    _srvRandomPending = false;
    if (btn) { btn.disabled = false; btn.innerHTML = previousHtml; }
  }
}

async function joinPastedServer() {
  const el = document.getElementById('srv-paste');
  if (!el || !_srvCtx) return;
  const raw = el.value.trim();
  if (!raw) return;
  let placeId = _srvCtx.placeId;
  let jobId = raw;
  if (raw.includes(':')) {
    const parts = raw.split(':');
    if (/^\d+$/.test(parts[0])) placeId = parts[0];
    jobId = parts.slice(1).join(':');
  }
  if (!/^\d+$/.test(String(placeId)) || !jobId) { toast(t('srv.pasteBad'), 'err'); return; }
  if (_srvCtx.packageId) await launchPkgToPasted(placeId, jobId);
  else await launchToServer(jobId, placeId);
}

async function launchPkgToPasted(placeId, jobId) {
  const p = packages.find(x => x.id === _srvCtx?.packageId);
  if (p) await _launchPkgAtServer(p, placeId, jobId);
}

async function copyServerId(jobId) {
  const s = _srvList.find(x => x.id === jobId);
  if (!s || !_srvCtx) return;
  const target = _srvCtx.placeId + ':' + s.id;
  try {
    await navigator.clipboard.writeText(target);
    toast(t('srv.copied'), 'ok');
  } catch (e) {
    toast(t('srv.copyFail'), 'err');
  }
}

// ── Packages ──────────────────────────────────────────────────────────────
let _pkgQuery = '', _pkgFilter = 'all', _pkgSort = 'manual', _pkgExpanded = new Set();
// Accounts the app launched (or restored) at least once this session — used by
// the group "relaunch downed" action so it only touches accounts that were
// actually running before, never ones the user never started.
const _sessionLaunched = new Set();

function pkgMembers(p) {
  const selected = new Set(p.accountIds || []);
  const order = [...new Set([...(p.launchOrder || []), ...selected])].filter(id => selected.has(id));
  const byId = new Map(accounts.filter(a => selected.has(a.id)).map(a => [a.id, a]));
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

function togglePkgFilter(e) {
  if (e) e.stopPropagation();
  const m = document.getElementById('pkg-filter-menu');
  if (m) m.classList.toggle('open');
}
function setPkgFilter(f) {
  _pkgFilter = f;
  document.querySelectorAll('#pkg-filter-menu button[data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  document.getElementById('pkg-filter-btn')?.classList.toggle('on', f !== 'all');
  document.getElementById('pkg-filter-menu')?.classList.remove('open');
  renderPackages();
}
function togglePkgSort() {
  _pkgSort = _pkgSort === 'manual' ? 'alpha' : 'manual';
  renderPackages();
}
function togglePkgPin(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  p.pinned = !p.pinned;
  api.savePackages(packages);
  renderPackages();
}
function togglePkgExpand(id) {
  if (_pkgExpanded.has(id)) _pkgExpanded.delete(id); else _pkgExpanded.add(id);
  const body = document.querySelector(`.pkg-card[data-id="${id}"] .pkg-members`);
  if (body) body.classList.toggle('open');
  const btn = document.querySelector(`.pkg-card[data-id="${id}"] .pkg-expand-btn`);
  if (btn) btn.classList.toggle('open');
}
function duplicatePackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  packages.push({ id: crypto.randomUUID(), name: t('groups.copyOf', { name: p.name }), accountIds: [...(p.accountIds || [])], link: p.link || '', color: p.color || '', pinned: false, launchOrder: p.launchOrder ? [...p.launchOrder] : undefined, launchDelay: p.launchDelay || 0 });
  api.savePackages(packages);
  renderPackages();
  toast(t('pkg.duplicated'), 'ok');
}
function exportPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const data = { name: p.name, accountIds: p.accountIds || [], link: p.link || '', color: p.color || '', launchDelay: p.launchDelay || 0 };
  navigator.clipboard?.writeText(JSON.stringify(data, null, 2)).then(
    () => toast(t('pkg.exported'), 'ok'),
    () => toast(t('pkg.exportFail'), 'err')
  );
}
async function importPackage() {
  const raw = await KntUi.requestText({title:t('groups.importPrompt'), multiline:true});
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.name !== 'string') throw new Error('bad json');
    const ids = Array.isArray(data.accountIds) ? data.accountIds.filter(id => accounts.some(a => a.id === id)) : [];
    packages.push({ id: crypto.randomUUID(), name: data.name, accountIds: ids, link: typeof data.link === 'string' ? data.link : '', color: typeof data.color === 'string' ? data.color : '', pinned: false, launchOrder: undefined, launchDelay: Number(data.launchDelay) || 0 });
    api.savePackages(packages);
    renderPackages();
    toast(t('pkg.imported'), 'ok');
  } catch {
    toast(t('pkg.importFail'), 'err');
  }
}
async function relaunchDownedPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const members = pkgMembers(p);
  const downed = members.filter(m => (p.link || m.gameTarget) && _sessionLaunched.has(m.id) && !_launchedIds.has(m.id) && !_homeIds.has(m.id) && !(_cookieStatus[m.id] === 'dead' || m._cookieInvalid));
  if (!downed.length) { toast(t('pkg.noDowned'), 'ok'); return; }
  if (settings.multiInstance === false) { toast(t('settings.multiInstanceGroupBlocked'), 'err'); return; }
  const job = _pkgBeginLaunch(p, downed);
  if (!job) return;
  try {
    const link = String(p.link || '').trim();
    const entries = downed.map(account => ({ account, target: link || account.gameTarget || null }));
    const result = await _pkgExecuteLaunches(job, entries, Math.max(0, Math.min(60000, Number(p.launchDelay) || 0)));
    _pkgReportLaunch(job, p, result, downed.length);
  } finally { _pkgFinishLaunch(job); }
}
async function trimPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const running = pkgMembers(p).filter(m => _launchedIds.has(m.id));
  if (!running.length) { toast(t('pkg.noRunning'), 'err'); return; }
  let okCount = 0;
  await Promise.all(running.map(async (m) => {
    const res = await api.trimAccountMemory(m.id);
    if (res && res.ok) okCount++;
  }));
  toast(t('pkg.trimmedN', { ok: okCount, total: running.length, name: p.name }), okCount === running.length ? 'ok' : 'err');
}

function renderPackages() {
  _refreshLaunchPresentation();
  if (typeof renderGroupInspector === 'function') renderGroupInspector();
  const list = document.getElementById('pkg-list'), empty = document.getElementById('pkg-empty');
  if (!list) return;
  const vis = visiblePackages();
  if (!vis.length) { list.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  list.innerHTML = vis.map((p, i) => {
    const members = pkgMembers(p);
    const st = pkgState(p);
    const launchJob = _pkgLaunchJobs.get(p.id);
    const busy = !!launchJob;
    const shown = members.slice(0, 6);
    const extra = members.length - shown.length;
    const avatarsHtml = shown.map(m => `<div class="pkg-avatar${_launchedIds.has(m.id) ? ' online' : ''}${_homeIds.has(m.id) ? ' home' : ''}" id="pkg-av-${p.id}-${m.id}" data-acc-id="${m.id}" data-uid="${m.userId || ''}" data-uname="${esc(m.username || '')}" data-nick="${esc(m.nickname || '')}">${esc((m.username || '?')[0].toUpperCase())}<span class="pkg-avatar-dot"></span></div>`).join('')
      + (extra > 0 ? `<div class="pkg-avatar more">+${extra}</div>` : '');
    const pct = st.total ? Math.round((st.running + st.home) / st.total * 100) : 0;
    const pkgPlace = _extractPlaceId(p.link);
    const membersHtml = members.map(m => {
      const cls = _homeIds.has(m.id) ? 'home' : (_launchedIds.has(m.id) ? 'running' : (_cookieStatus[m.id] === 'dead' ? 'dead' : 'idle'));
      const lbl = _homeIds.has(m.id) ? t('accounts.home') : (_launchedIds.has(m.id) ? t('accounts.launched') : (_cookieStatus[m.id] === 'dead' ? t('accounts.expired') : t('accounts.notLaunched')));
      return `<div class="pkg-member ${cls}" data-acc-id="${m.id}"><span class="pkg-member-dot"></span><span class="group-member-avatar">${m.userId && _avatarCache[m.userId] ? '<img alt="" src="'+esc(_avatarCache[m.userId])+'"/>' : esc((m.username || '?')[0].toUpperCase())}</span>${esc(m.nickname || m.username || 'Unknown')}<span class="pkg-member-st">${esc(lbl)}</span></div>`;
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
          <button class="btn btn-edit" onclick="openEditPackage('${p.id}')" ${busy ? 'disabled' : ''} aria-label="Manage accounts">
            <span class="material-icons-round">group</span>
          </button>
          <button class="btn btn-ghost" onclick="duplicatePackage('${p.id}')" aria-label="Duplicate group">
            <span class="material-icons-round">copy</span>
          </button>
          <button class="btn btn-ghost" onclick="exportPackage('${p.id}')" aria-label="Export group to clipboard">
            <span class="material-icons-round">file_upload</span>
          </button>
          <button class="btn btn-del" onclick="deletePackage('${p.id}')" ${busy ? 'disabled' : ''} aria-label="Delete package">
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
            value="${esc(p.link || '')}" ${busy ? 'disabled' : ''} onchange="setPackageLink('${p.id}', this.value)"
            onkeydown="if(event.key==='Enter'){this.blur();}"/>
        </div>
        ${pkgPlace ? `<button class="btn btn-ghost pkg-srv-btn" onclick="openPkgServerList('${p.id}')" ${busy ? 'disabled' : ''} title="${esc(t('srv.title'))}" aria-label="${esc(t('srv.title'))}"><span class="material-icons-round">dns</span></button>` : ''}
        ${pkgPlace ? `<button class="btn btn-ghost pkg-srv-btn pkg-distribute-btn" onclick="workspaceDistribute('${p.id}')" ${busy ? 'disabled' : ''} title="${esc(t('pkg.distribute'))}" aria-label="${esc(t('pkg.distribute'))}"><span class="material-icons-round">call_split</span><span>${esc(t('ui.distribute'))}</span></button>` : ''}
        <button class="btn btn-launch pkg-launch-btn" onclick="launchPackage('${p.id}')" data-busy="${busy ? '1' : '0'}" ${members.length && !busy ? '' : 'disabled'}>
          ${busy ? '<div class="spin"></div>' : esc(t('groups.startAll'))}
        </button>
        ${busy ? `<button class="btn btn-ghost" onclick="cancelPackageLaunch('${p.id}')" ${launchJob.cancelled ? 'disabled' : ''}>${esc(t('common.cancel'))}</button>` : ''}
        <button class="btn btn-out pkg-relaunch-btn" onclick="relaunchDownedPackage('${p.id}')" ${st.downed && !busy ? '' : 'disabled'} title="${esc(t('groups.relaunchTip'))}">
          <span class="material-icons-round">refresh</span>
        </button>
        <button class="btn btn-out pkg-trim-btn" onclick="trimPackage('${p.id}')" ${st.running && !busy ? '' : 'disabled'} title="${esc(t('groups.trimTip'))}">
          <span class="material-icons-round">memory</span>
        </button>
        <button class="btn btn-del pkg-kill-btn" onclick="killPackage('${p.id}')" ${st.running && !busy ? '' : 'disabled'}>
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
  if (typeof workspaceGroupCatalog === 'function') workspaceGroupCatalog();
  renderDashboard();
}

function openCreatePackage() {
  editingPackageId = null;
  document.getElementById('pkg-modal-title').textContent = t('groups.titleNew');
  document.getElementById('in-pkg-name').value = '';
  document.getElementById('in-pkg-delay').value = 0;
  document.getElementById('pkg-picker-search').value = '';
  document.getElementById('pkg-order-row').innerHTML = '';
  document.querySelector('#pkg-color-row .pkg-color-swatch[data-custom="1"]')?.remove();
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
  // Load the saved launch order (fall back to the account list order).
  _pkgOrderIds = (p.launchOrder && p.launchOrder.length) ? [...p.launchOrder] : (p.accountIds || []);
  renderPackagePicker(p.accountIds || []);
  renderPkgOrder();
  openModal('m-package');
}

function setPkgColorSel(color) {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) pkgEnsureCustomSwatch(color);
  document.querySelectorAll('#pkg-color-row .pkg-color-swatch').forEach(b => b.classList.toggle('sel', (b.dataset.color || '').toLowerCase() === String(color || '').toLowerCase()));
  const customInput = document.getElementById('pkg-color-custom');
  if (customInput && /^#[0-9a-fA-F]{6}$/.test(color || '')) customInput.value = color;
}
function pkgEnsureCustomSwatch(color) {
  const row = document.getElementById('pkg-color-row');
  if (!row) return;
  let custom = row.querySelector('.pkg-color-swatch[data-custom="1"]');
  if (!custom) {
    custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'pkg-color-swatch';
    custom.dataset.custom = '1';
    row.appendChild(custom);
  }
  custom.dataset.color = color;
  custom.style.background = color;
  custom.title = color;
}
function pkgCustomColor(v) {
  if (!/^#[0-9a-fA-F]{6}$/.test(v || '')) return;
  pkgEnsureCustomSwatch(v);
  setPkgColorSel(v);
}

function collectPkgChecked() {
  return Array.from(document.querySelectorAll('#pkg-account-picker input:checked')).map(c => c.value);
}

function pkgPickAll(sel) {
  document.querySelectorAll('#pkg-account-picker input').forEach(c => { c.checked = sel; });
  updatePkgCount();
  renderPkgOrder();
}

// The picker shows accounts filtered by the search box; the launch-order row
// always reflects the currently selected set.
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

// Editable launch order: shows the selected accounts in sequence with
// up/down arrows. Defaults to the picker selection order.
function renderPkgOrder() {
  const wrap = document.getElementById('pkg-order-row');
  if (!wrap) return;
  const checked = collectPkgChecked();
  const byId = new Map(accounts.filter(a => checked.includes(a.id)).map(a => [a.id, a]));
  // Keep the existing order for accounts still checked, then append any
  // newly checked accounts at the end (they were never in _pkgOrderIds, so a
  // plain filter would silently drop them — the bug where only the first
  // selected account made it into the group).
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

// Color swatch selection (delegated — the swatches are static in the modal).
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
  // Re-render so the server-picker (🖥️) and distribute (↗️) buttons show
  // up as soon as a numeric placeId is present.
  renderPackages();
}

// ── Game cover images ─────────────────────────────────────────────────────
// Each group's link (place ID, roblox.com/games/<id> URL, or private-server
// link) resolves to a place → universe → thumbnail cover, shown as a banner
// on the group card.
const _pkgCoverCache = {}; // placeId -> imageUrl
const _pkgPlaceCache = {}; // placeId -> { universeId, name }
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
// Metadata requests are shared across groups and serialized. A failed lookup
// waits five minutes before another render may retry; no automatic retry loop.
const _pkgMetadataPending = new Map();
const _pkgMetadataRetry = new Map();
let _pkgMetadataQueue = Promise.resolve();
function pkgGameMarkup(link) {
  const placeId = extractPlaceId(link);
  const name = placeId && _pkgPlaceCache[placeId]?.name;
  const image = placeId && _pkgCoverCache[placeId];
  const label = name || (placeId ? 'Place ID · ' + placeId : t('layout.memberDestinations'));
  return '<div class="group-game-preview" data-game-place="'+esc(placeId || '')+'">'+
    '<span class="group-game-art"><span class="material-icons-round" aria-hidden="true">sports_esports</span>'+
    (image ? '<img src="'+esc(image)+'" alt="" loading="lazy" onerror="this.remove()"/>' : '')+'</span>'+
    '<strong class="group-game-name">'+esc(label)+'</strong></div>';
}
function refreshPkgMetadata(placeId) {
  // Update only matching destinations, never a previously selected group.
  document.querySelectorAll('[data-game-place]').forEach(el => {
    if (el.dataset.gamePlace === placeId) el.outerHTML = pkgGameMarkup(placeId);
  });
  packages.forEach(group => {
    if (extractPlaceId(group.link) === placeId) renderPkgCover(group.id, _pkgCoverCache[placeId]);
  });
}
function loadPkgCover(pkgId, link) {
  const placeId = extractPlaceId(link);
  if (!placeId) { renderPkgCover(pkgId, null); return Promise.resolve(); }
  if (_pkgCoverCache[placeId]) renderPkgCover(pkgId, _pkgCoverCache[placeId]);
  if (_pkgPlaceCache[placeId]?.name && _pkgCoverCache[placeId]) return Promise.resolve();
  if (_pkgMetadataPending.has(placeId)) return _pkgMetadataPending.get(placeId);
  if (Date.now() < (_pkgMetadataRetry.get(placeId) || 0)) return Promise.resolve();
  const task = _pkgMetadataQueue.then(async () => {
    try {
      let uni = _pkgPlaceCache[placeId];
      if (!uni) {
        const res = await api.robloxGet('https://apis.roblox.com/universes/v1/places/' + placeId + '/universe');
        if (!res?.data?.universeId) return;
        uni = _pkgPlaceCache[placeId] = { universeId: res.data.universeId };
      }
      if (!uni.name) {
        const res = await api.robloxGet('https://games.roblox.com/v1/games?universeIds=' + uni.universeId);
        const game = res?.data?.data?.find(game => String(game.id) === String(uni.universeId));
        if (typeof game?.name === 'string' && game.name.trim()) uni.name = game.name;
        // Stop after a rejected request rather than continuing to thumbnails.
        if (!res?.data?.data) return;
      }
      if (!_pkgCoverCache[placeId]) {
        const res = await api.robloxGet('https://thumbnails.roblox.com/v1/games/icons?universeIds=' + uni.universeId + '&size=512x512&format=Png');
        const icon = res?.data?.data?.find(icon => String(icon.targetId) === String(uni.universeId));
        if (icon?.state === 'Completed' && /^https:\/\//.test(icon.imageUrl || '')) _pkgCoverCache[placeId] = icon.imageUrl;
      }
    } catch { /* Metadata is optional; keep the destination usable offline. */ }
    finally {
      _pkgMetadataPending.delete(placeId);
      _pkgMetadataRetry.set(placeId, Date.now() + 5 * 60 * 1000);
      refreshPkgMetadata(placeId);
    }
  });
  _pkgMetadataPending.set(placeId, task);
  _pkgMetadataQueue = task.catch(() => {});
  return task;
}

// Only plain place IDs and public game URLs should auto-select a server.
// Private/VIP links and explicit job IDs keep their original destination.
function _pkgPublicPlace(link) {
  if (/^\d+$/.test(link)) return link;
  if (/^https?:\/\/(?:www\.)?roblox\.com\/games\/\d+(?:[/?#]|$)/i.test(link)
      && !/[?&](?:privateServerLinkCode|linkCode)=/i.test(link)) return _extractPlaceId(link);
  return '';
}

async function launchPackage(id) {
  const p = packages.find(x => x.id === id);
  if (!p) return;
  const members = pkgMembers(p);
  if (!members.length) { toast(t('pkg.noAccounts'), 'err'); return; }
  if (settings.multiInstance === false) { toast(t('settings.multiInstanceGroupBlocked'), 'err'); return; }
  const job = _pkgBeginLaunch(p, members);
  if (!job) return;
  try {
    const link = String(p.link || '').trim();
    const placeId = _pkgPublicPlace(link);
    let sharedTarget = link;
    if (placeId) {
      const servers = await _srvFetchCandidates(placeId, {
        needed: 1, slots: members.length, cancelled: () => job.cancelled,
      });
      if (job.cancelled) return;
      if (!servers.length) { toast(t('pkg.noGoodServers'), 'err'); return; }
      sharedTarget = placeId + ':' + servers[0].id;
    }
    const entries = members.map(account => ({ account, target: sharedTarget || account.gameTarget || null }));
    const result = await _pkgExecuteLaunches(job, entries, Math.max(0, Math.min(60000, Number(p.launchDelay) || 0)));
    _pkgReportLaunch(job, p, result, members.length);
  } catch (e) {
    logEntry('err', 'launch', e?.message || String(e), { packageId: p.id });
    if (!job.cancelled) toast(e?.message || String(e), 'err');
  } finally { _pkgFinishLaunch(job); }
}

async function killPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  if (_pkgLaunchJobs.has(id)) { toast(t('pkg.launchBusy'), 'err'); return; }
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
let _savingKey = false;
function onKeyInput() {
  if (_savingKey) return;
  const btn = document.getElementById('btn-save-key');
  if (btn) { btn.disabled = false; btn.textContent = t('ui.savePassword'); }
}
async function saveKeySettings() {
  const input = document.getElementById('custom-key');
  const confirmation = document.getElementById('custom-key-confirm');
  const cancel = document.getElementById('key-change-cancel');
  const keyVal = input.value;
  const btn = document.getElementById('btn-save-key');
  if (_savingKey || btn.disabled) return;
  if (!keyVal.trim()) { toast('Encryption key cannot be empty.', 'err'); return; }
  if (confirmation && keyVal !== confirmation.value) { toast(t('ui.passwordMismatch'), 'err'); return; }
  clearTimeout(_saveKeyTimer);
  _savingKey = true;
  if (confirmation) confirmation.disabled = true;
  if (cancel) cancel.disabled = true;
  input.disabled = true;
  btn.disabled = true; btn.textContent = t('ui.saving');
  _saveKeyTimer = setTimeout(async () => {
    try {
      // enc:setKey changes the key and re-encrypts accounts in one step.
      const r = await api.encSetKey(keyVal);
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'could not update key');
      settings.keySet = true;
      if (confirmation) confirmation.value = '';
      closeModal('m-key-change');
      document.getElementById('custom-key').value = '';
      // Reload accounts so the renderer holds cookies under the new key.
      try { accounts = await api.loadAccounts(); flagInvalidCookies(accounts); render(); } catch {}
      toast(t('enc.keyUpdated'), 'ok');
      applySettings();
    } catch (e) {
      toast(t('common.saveFailed', { msg: e.message }), 'err');
    } finally {
      _savingKey = false;
      if (confirmation) confirmation.disabled = false;
      if (cancel) cancel.disabled = false;
      input.disabled = false;
      btn.disabled = false; btn.textContent = t('ui.savePassword');
    }
  }, 300);
}

function openModal(id) { KntUi.open(id); }
function closeModal(id) { KntUi.close(id); }
function setStatus(id, type, html) { const el = document.getElementById(id); el.className = 'mst ' + type; el.setAttribute('role', type === 'err' ? 'alert' : 'status'); el.innerHTML = html; }
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
    if (e.target === o && o.dataset.backdropClose === 'true') closeModal(o.id);
  });
});
document.addEventListener('keydown', e => {
  // Ctrl/Cmd+F opens native-style find on the logs page.
  if (!KntUi.top() && (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && document.getElementById('page-logs')?.classList.contains('active')) {
    e.preventDefault(); openLogFind(); return;
  }
  // Find-bar keys: Enter = next, Shift+Enter = previous, Esc = close.
  if (e.target && e.target.id === 'log-find-input') {
    if (e.key === 'Enter') { e.preventDefault(); logFind(e.shiftKey); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeLogFind(); return; }
  }
  if (e.key === 'Escape') {
    if (typeof workspaceCloseMenu === 'function' && workspaceCloseMenu(e)) return;
    const lf = document.getElementById('log-find');
    if (lf && lf.style.display !== 'none') { closeLogFind(); return; }
    closeAllCdd();
    const modal = KntUi.top();
    if (modal?.id === 'm-edit') {
      // Escape shouldn't discard the modal out from under someone mid-typing.
      const typing = ['in-target', 'in-nickname', 'in-description', 'in-follow']
        .some(f => document.activeElement === document.getElementById(f));
      if (!typing) closeModal('m-edit');
    } else {
      if (modal?.id === 'm-launch') { e.preventDefault(); cancelLaunchOrClose(); }
      else if (modal?.id === 'm-login') cancelLogin();
      else if (modal && modal.dataset.backdropClose === 'true') closeModal(modal.id);
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && KntUi.top()?.id === 'm-edit') {
    e.preventDefault(); saveEdit(); return;
  }
  if (KntUi.top()) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openLogin(); }
  // "/" focuses the account search (when not already typing in a field).
  if (e.key === '/' && document.getElementById('page-accounts')?.classList.contains('active')
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    document.getElementById('acct-search')?.focus();
  }
});

let chartTab = 'popular';
let allCharts = {};
let chartsLoaded = false;

function switchChartTab(tab) {
  chartTab = tab;
  document.querySelectorAll('#page-charts .tab-btn').forEach(t => t.classList.remove('active'));
  document.getElementById('ctab-' + tab).classList.add('active');
  const isPriv = tab === 'private';
  const searchWrap = document.querySelector('#page-charts .chart-search-wrap');
  if (searchWrap) searchWrap.style.display = isPriv ? 'none' : '';
  document.getElementById('charts-private').style.display = isPriv ? '' : 'none';
  const grid = document.getElementById('charts-grid');
  const loading = document.getElementById('charts-loading');
  const empty = document.getElementById('charts-empty');
  if (isPriv) {
    // Hide the games surfaces so only the private panel shows.
    if (grid) grid.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (empty) empty.style.display = 'none';
    renderPrivateServers();
    positionTabSlider(document.getElementById('ctab-' + tab).closest('.tab-bar'));
    return;
  }
  const s = document.getElementById('chart-search'); if (s) s.value = '';
  _searchMode = false;
  if (chartsLoaded) renderCharts(allCharts[tab] || [], false);
  else loadCharts();
  positionTabSlider(document.getElementById('ctab-' + tab).closest('.tab-bar'));
}

// ── Saved private/VIP servers ──────────────────────────────────────────
// Roblox exposes no API listing other people's private servers, so links
// are saved here once and joined in one click. Stored in settings.json,
// which means they ride along with encrypted backups.
function _savedServers() {
  if (typeof settings === 'undefined' || !settings) return [];
  if (!Array.isArray(settings.savedServers)) settings.savedServers = [];
  return settings.savedServers;
}
function _privLooksLikeGameLink(link) {
  if (!link) return false;
  return /(\d{6,})|roblox\.com|privateServerLinkCode|share|code=|placeId=/i.test(link);
}
function privAdd() {
  const nameEl = document.getElementById('priv-name');
  const linkEl = document.getElementById('priv-link');
  const name = (nameEl ? nameEl.value : '').trim().slice(0, 40) || t('priv.untitled');
  const link = (linkEl ? linkEl.value : '').trim();
  if (!_privLooksLikeGameLink(link)) { toast(t('priv.invalid'), 'err'); if (linkEl) linkEl.focus(); return; }
  const list = _savedServers();
  list.unshift({ id: 'ps_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name, link });
  if (list.length > 50) list.length = 50;
  try { api.saveSettings({ savedServers: list }).catch(() => {}); } catch {}
  if (nameEl) nameEl.value = '';
  if (linkEl) linkEl.value = '';
  renderPrivateServers();
  toast(t('priv.added', { name }), 'ok');
}
function privRemove(id) {
  const list = _savedServers();
  const e = list.find(x => x.id === id);
  confirmAction(t('priv.removeConfirm', { name: e ? e.name : '' }), () => {
    settings.savedServers = _savedServers().filter(x => x.id !== id);
    try { api.saveSettings({ savedServers: settings.savedServers }).catch(() => {}); } catch {}
    renderPrivateServers();
  });
}
function privCopy(id) {
  const e = _savedServers().find(x => x.id === id);
  if (!e) return;
  navigator.clipboard.writeText(e.link).then(() => toast(t('priv.copied'), 'ok')).catch(() => {});
}
async function privJoin(id) {
  const e = _savedServers().find(x => x.id === id);
  if (!e) return;
  const sel = document.getElementById('priv-acc-' + id);
  const acc = accounts.find(a => a.id === (sel ? sel.value : ''));
  if (!acc) { toast(t('priv.noAccounts'), 'err'); return; }
  if (!acc.cookie) { toast(t('acct.noCookie'), 'err'); return; }
  logEntry('info', 'launch', `Launching ${acc.username || acc.id} into saved server "${e.name}"...`, { accountId: acc.id, target: e.link });
  let res = null;
  try { res = await api.launchRoblox(acc.id, acc.cookie, e.link); } catch (err) { res = { success: false, error: err?.message || String(err) }; }
  if (res && res.success) {
    markLaunched(acc.id);
    toast(t('priv.launched', { u: acc.nickname || acc.username || '', name: e.name }), 'ok');
  } else if (!(res && res.cancelled)) {
    if (res && res.error) _flagCookieMaybeDead(acc.id, res.error);
    toast((res && res.error) || t('priv.failed'), 'err');
  }
}
function renderPrivateServers() {
  const wrap = document.getElementById('priv-list');
  if (!wrap) return;
  const list = _savedServers();
  if (!list.length) {
    wrap.innerHTML = '<div class="logs-empty"><span class="material-icons-round">lock</span>' + esc(t('priv.empty')) + '</div>';
    return;
  }
  const accOpts = accounts.map(a => '<option value="' + a.id + '">' + esc(a.nickname || a.username || a.id) + '</option>').join('');
  wrap.innerHTML = '<div class="dash-feed">' + list.map(e => {
    const shortLink = e.link.length > 46 ? e.link.slice(0, 46) + '…' : e.link;
    return '<div class="dash-feed-row" style="align-items:center">' +
      '<span class="dash-ic purple" style="width:22px;height:22px;font-size:12px"><span class="material-icons-round" style="font-size:13px">lock</span></span>' +
      '<span class="dash-feed-text" style="min-width:0"><b>' + esc(e.name) + '</b><br/><span style="opacity:.65;font-size:11px;word-break:break-all">' + esc(shortLink) + '</span></span>' +
      (accounts.length ? '<select class="sr-input" id="priv-acc-' + e.id + '" style="height:30px;max-width:150px;font-size:11.5px">' + accOpts + '</select>' : '') +
      '<button class="btn btn-primary btn-sm" onclick="privJoin(\'' + e.id + '\')" title="' + esc(t('priv.join')) + '"><span class="material-icons-round">play_arrow</span></button>' +
      '<button class="btn btn-ghost btn-sm" onclick="privCopy(\'' + e.id + '\')" title="' + esc(t('priv.copyLink')) + '"><span class="material-icons-round">content_copy</span></button>' +
      '<button class="btn btn-ghost btn-sm" onclick="privRemove(\'' + e.id + '\')" title="' + esc(t('priv.remove')) + '"><span class="material-icons-round">delete_outline</span></button>' +
      '</div>';
  }).join('') + '</div>';
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
// Favorited games (by universe/place id) — pinned to the top of every chart
// tab. Persisted in localStorage so the stars survive restarts.
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
  // Pinned favourites float to the top of the chart (search results keep
  // their own ordering).
  if (!searchMode && _favGames.size) {
    games = [...games.filter(g => _favGames.has(_gameKey(g))), ...games.filter(g => !_favGames.has(_gameKey(g)))];
  }
  emptyEl.style.display = 'none';
  grid.style.display = 'grid';
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
let _uptimeTimer = null;
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
  // Refresh uptime labels in place (no re-render) while the Accounts page is
  // visible, so "há 2h 34min" keeps ticking without flashing the grid.
  if (_uptimeTimer) return;
  _uptimeTimer = setInterval(() => {
    if (!document.getElementById('page-accounts')?.classList.contains('active')) return;
    document.querySelectorAll('.card.is-live .card-up').forEach(el => {
      const id = el.closest('.card')?.dataset.id;
      if (id && _launchedAt[id]) el.textContent = fmtUptime(_launchedAt[id]);
    });
  }, 30000);
}

// ── Sync instances ────────────────────────────────────────────────────────
// Reloads the running count and watched IDs from the backend
let _syncInFlight = false;
async function syncInstances(src) {
  if (_syncInFlight) return;
  _syncInFlight = true;
  const btnDash = document.getElementById('dash-sync-btn');
  const btnAcct = document.getElementById('acct-sync-btn');
  const btns = [btnDash, btnAcct].filter(Boolean);
  const origLabels = btns.map(b => b ? b.textContent : '');
  btns.forEach(b => {
    if (b) {
      b.disabled = true;
      b.textContent = 'Syncing...';
      b.style.opacity = '0.6';
    }
  });
  try {
    await api.syncInstances();
    await pollRunningCount();
    await pollWatchedIds();
    renderDashboard();
    render();
    logEntry('info', 'system', 'Instances synced with reality');
  } catch (e) {
    logEntry('warn', 'system', `Sync failed: ${e}`);
  } finally {
    btns.forEach((b, i) => {
      if (b) {
        b.disabled = false;
        b.textContent = origLabels[i] || 'Sync';
        b.style.opacity = '';
      }
    });
    _syncInFlight = false;
  }
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
let _fflagWriteLock = Promise.resolve();
async function mixWriteFlag(key, value) {
  _fflagWriteLock = _fflagWriteLock.then(async () => {
    let flags = {};
    try { flags = (await api.readFFlags()) || {}; } catch {}
    if (value === null) delete flags[key];
    else flags[key] = String(value);
    try { await api.writeFFlags(flags); } catch {}
  });
  await _fflagWriteLock;
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
  logEntry('info', 'settings', v ? 'Custom launcher set: ' + v : 'Custom launcher cleared');
}
async function pickLauncherPath() {
  try {
    const pick = window.__TAURI__ && window.__TAURI__.dialog
      ? await window.__TAURI__.dialog.open({ title: 'Select Roblox launcher', filters: [{ name: 'Executable', extensions: ['exe'] }], multiple: false })
      : null;
    const path = typeof pick === 'string' && pick ? pick : null;
    if (path) {
      const el = document.getElementById('set-launcher-path');
      if (el) el.value = path;
      saveLauncherPath();
    }
  } catch (e) { logEntry('err', 'settings', 'Launcher picker failed: ' + (e?.message || e)); }
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
// Single system: the track is painted from the --fill var (see styles.css).
// The old inline-background gradient is cleared so the two never fight.
function updateSliderFill(el) {
  if (!el || !el.style) return;
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100, v = parseFloat(el.value) || 0;
  const pct = max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0;
  el.style.setProperty('--fill', pct + '%');
  el.style.background = '';
}

// Delegated listener so slider fill stays correct without every call site remembering to update it.
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('input[type="range"]')) updateSliderFill(e.target);
});

// Graphics
function mixGfxInput(v) {
  document.getElementById('mix-gfx-val').textContent = v;
  updateSliderFill(document.getElementById('mix-gfx'));
}
async function mixGfxAutoToggle() {
  const auto = document.getElementById('mix-gfx-auto').checked;
  document.getElementById('mix-gfx').disabled = auto;
  if (auto) {
    document.getElementById('mix-gfx-val').textContent = 'Auto';
    await mixWriteFlag(FF_GFX, null);
    toast(t('mixer.gfxAuto'), 'ok');
  } else {
    await mixGfxCommit();
  }
}
async function mixGfxCommit() {
  if (document.getElementById('mix-gfx-auto').checked) return;
  const v = document.getElementById('mix-gfx').value;
  document.getElementById('mix-gfx-val').textContent = v;
  await mixWriteFlag(FF_GFX, v);
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
  // Only wipe the UI-side running state if the backend actually confirmed
  // the processes are gone. The Rust side now clears watched_accounts /
  // account_pids only after verification, so a successful ok:true means the
  // count is truly zero. If it failed, leave the UI alone so the user can
  // retry or kill per-account.
  if (res && res.ok) {
    _launchedIds.clear();
    _homeIds.clear();
    document.querySelectorAll('.card.is-live').forEach(c => c.classList.remove('is-live'));
    document.querySelectorAll('.card.is-home').forEach(c => c.classList.remove('is-home'));
    document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched'); d.title = 'Not launched'; });
    document.querySelectorAll('.card-dot.home').forEach(d => { d.classList.remove('home'); d.title = 'Not launched'; });
    document.querySelectorAll('.card-home-badge').forEach(b => b.remove());
    refreshPkgAvatarStatus();
    await mixRefreshRunning();
    // Sync tracking state after killing
    await pollWatchedIds();
    render();
    renderDashboard();
  }
  btns.forEach(b => { b.disabled = false; });
  if (res && res.ok) {
    // `killed` is computed by the backend after verifying each target PID is
    // actually gone (targets minus survivors), so it is the real count of
    // instances this run managed to close. Always show that count, even when
    // it is 0, and keep the toast red (kill operation message).
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

  await mixGfxCommit();
  await mixFpsCommit();
  const volValue = parseInt(document.getElementById('mix-vol').value, 10);
  try { await api.setRobloxVolume(volValue); } catch {}

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
  const inp = document.getElementById('gen-apikey');
  const apiKey = ((inp && inp.value) || '').trim();
  const k = genActiveKey();
  if (k && (k.key || '') !== (inp ? inp.value : '')) { k.key = inp ? inp.value : ''; genKeysSave(); genRenderKeySelect(); }
  const row = document.getElementById('gen-type-row');
  if (row) row.style.display = apiKey.startsWith('BLOX-') ? '' : 'none';
  genKeysTick();
  // Debounced stock readout while typing a key (not on every keystroke).
  try { clearTimeout(window._genStockT); } catch {}
  try {
    window._genStockT = setTimeout(() => {
      const cur = ((document.getElementById('gen-apikey') || {}).value || '').trim();
      if (cur.startsWith('BLOX-') && cur.length > 10) genRefreshStock();
      else { const l = document.getElementById('gen-stock-label'); if (l) l.textContent = ''; }
    }, 1000);
  } catch {}
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
  if (_genWatch && value !== _genWatch.type) genStopWatch(false);
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
  genRefreshStock();
}

// Live stock readout from the server (GET /api/stock): shows whether the
// selected type is actually available before spending a generate call.
// Free accounts only ever see `alt` here; regions stay empty below Ultra.
async function genBloxgenStock(apiKey) {
  try {
    const resp = await fetch('https://core.bloxgen.net/api/stock?apiKey=' + encodeURIComponent(apiKey));
    const j = await resp.json();
    if (j && j.success && j.data) return j.data;
  } catch {}
  return null;
}
async function genRefreshStock() {
  const lbl = document.getElementById('gen-stock-label');
  if (!lbl) return;
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();
  if (!apiKey.startsWith('BLOX-')) { lbl.textContent = ''; return; }
  lbl.style.color = '';
  lbl.textContent = t('gen.stockChecking');
  const data = await genBloxgenStock(apiKey);
  // Key or type changed while fetching -- drop the stale answer.
  const cur = (document.getElementById('gen-apikey').value || '').trim();
  if (cur !== apiKey) return;
  if (!data || !data[_genType]) { lbl.textContent = ''; return; }
  const ok = data[_genType].available === true;
  lbl.textContent = ok ? t('gen.stockYes', { type: _genType }) : t('gen.stockNo', { type: _genType });
  lbl.style.color = ok ? 'var(--ok, #22c55e)' : 'var(--warn, #f59e0b)';
}

// ── Stock watch: auto-generate the moment a wave restocks ──────────────────
// Free API stock arrives in waves ("Restocks on Discord") and is consumed in
// seconds, so clicking Generate manually almost always loses. Arming the watch
// polls /api/stock every 30s and fires one generate with the armed key+type
// when it turns available. Session-only: it never survives a restart.
let _genWatch = null; // { keyId, type, started, timer }
function genToggleWatch() {
  if (_genWatch) { genStopWatch(false); return; }
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();
  if (!apiKey.startsWith('BLOX-')) { toast(t('gen.apiKeyBad'), 'err'); return; }
  const prof = genActiveKey();
  _genWatch = { keyId: prof ? prof.id : null, type: _genType, started: Date.now(), timer: null };
  genWatchUi();
  toast(t('gen.watchOn', { type: _genType }), 'ok');
  genWatchPoll();
  _genWatch.timer = setInterval(genWatchPoll, 30000);
}
async function genWatchPoll() {
  if (!_genWatch) return;
  const prof = genActiveKey();
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();
  // Key switched or cleared mid-watch: stand down instead of ever firing a
  // generate on a credential the user didn't arm.
  if (!prof || prof.id !== _genWatch.keyId || apiKey !== (prof.key || '').trim()) { genStopWatch(false); return; }
  if (_genType !== _genWatch.type) { genStopWatch(false); return; }
  const stock = await genBloxgenStock(apiKey);
  if (!_genWatch) return;
  if (stock && stock[_genWatch.type] && stock[_genWatch.type].available === true) {
    _genWatch = null;
    genWatchUi();
    toast(t('gen.stockFound'), 'ok');
    genCombo();
  }
}
function genStopWatch(silent) {
  if (!_genWatch) return;
  clearInterval(_genWatch.timer);
  _genWatch = null;
  genWatchUi();
  if (!silent) toast(t('gen.watchOff'), 'warn');
}
function genWatchUi() {
  const btn = document.getElementById('gen-watch-btn');
  if (!btn) return;
  btn.classList.toggle('btn-primary', !!_genWatch);
  btn.classList.toggle('btn-ghost', !_genWatch);
  const lbl = document.getElementById('gen-watch-label');
  if (lbl) lbl.textContent = _genWatch
    ? t('gen.watching', { t: genElapsed(Date.now() - _genWatch.started) })
    : t('gen.watch');
}
function genElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// Provider is auto-detected from the key's prefix so the single API-key field
// works for either service: BLOX- = BloxGen, MG_ = Altgen (altgen.me/docs).
async function genCombo() {
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();

  let provider;
  if (apiKey.startsWith('BLOX-')) provider = 'bloxgen';
  else if (apiKey.startsWith('MG_')) provider = 'altgen';
  else {
    toast(t('gen.apiKeyBad'), 'err');
    return;
  }
  const prof = genActiveKey();

  // Pre-check: a key still inside its cooldown fails immediately with the
  // exact remaining time instead of spending an API call to get a 429.
  if (provider === 'bloxgen' && prof) {
    const left = genCdLeft(prof.id);
    if (left > 0) {
      const msg = t('gen.keyInCooldown', { label: prof.label, t: genFmtMs(left) });
      if (_genClearPromise) await _genClearPromise;
      _genHistory.unshift({ username: null, password: null, cookie: null, ts: Date.now(), ok: false, provider, type: _genType, key: prof.label, error: msg });
      if (_genHistory.length > 500) _genHistory.length = 500;
      api.writeGenHistory(_genHistory).catch(() => {});
      _ghPrepend();
      toast(msg, 'err');
      return;
    }
  }

  // Stock pre-check: ask the server if this type is available at all. A
  // confirmed "out of stock" fails immediately with an exact message instead
  // of spending a generate call to get a 404. If the stock endpoint itself
  // fails, generation proceeds normally (telemetry must never block it).
  if (provider === 'bloxgen') {
    const stock = await genBloxgenStock(apiKey);
    if (stock && stock[_genType] && stock[_genType].available === false) {
      const msg = t('gen.stockNo', { type: _genType }) + ' — ' + t('gen.noStock');
      if (_genClearPromise) await _genClearPromise;
      _genHistory.unshift({ username: null, password: null, cookie: null, ts: Date.now(), ok: false, provider, type: _genType, key: prof ? prof.label : null, error: msg });
      if (_genHistory.length > 500) _genHistory.length = 500;
      api.writeGenHistory(_genHistory).catch(() => {});
      _ghPrepend();
      genRefreshStock();
      toast(msg, 'err');
      return;
    }
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
    if (_genClearPromise) await _genClearPromise; // let a pending Clear's disk write land first
    _lastGenData = d;
    _genHistory.unshift({ username: d.username, password: d.password, cookie: d.cookie, ts: Date.now(), ok: true, provider, type: _genType, key: prof ? prof.label : null });
    if (_genHistory.length > 500) _genHistory.length = 500; // bound the persisted history
    api.writeGenHistory(_genHistory).catch(() => {});
    _ghPrepend();

    // A fresh free-tier alt costs a 30-minute cooldown on this key, so arm
    // the exact deadline now instead of waiting for the next 429 to tell us.
    if (provider === 'bloxgen' && prof && _genType === 'alt') {
      genCdSet(prof.id, Date.now() + FREE_ALT_CD_MS);
      genKeysTick();
    }
    // A manual success supersedes any armed watch for this key.
    if (typeof _genWatch !== 'undefined' && _genWatch) genStopWatch(true);
    const toCopy = d.cookie || (d.username + ':' + d.password); // copy cookie if available, else username:password
    navigator.clipboard.writeText(toCopy).catch(() => {});
    genRefreshStock();

    if (btn) { btn.disabled = false; if (btnLabel) btnLabel.textContent = 'Generate'; }

  } catch (e) {
    // Failed generations land in the history too so the status filter and the
    // error messages make sense for mass runs.
    if (_genClearPromise) await _genClearPromise;
    _genHistory.unshift({ username: null, password: null, cookie: null, ts: Date.now(), ok: false, provider, type: _genType, key: prof ? prof.label : null, error: e.message || t('gen.genFailed') });
    if (_genHistory.length > 500) _genHistory.length = 500;
    api.writeGenHistory(_genHistory).catch(() => {});
    _ghPrepend();
    toast(e.message || t('gen.genFailed'), 'err');
    genRefreshStock();
    if (btn) { btn.disabled = false; if (btnLabel) btnLabel.textContent = t('gen.generate'); }
  }
}

async function genBloxgen(apiKey) {
  // 503 "inventory is syncing" is transient -- retry briefly instead of
  // surfacing it as a failure.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
    const resp = await fetch('https://core.bloxgen.net/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ apiKey, type: _genType })
    });
    let data = null;
    try { data = await resp.json(); } catch { lastErr = new Error(t('gen.genFailed')); continue; }
    if (data.success) return data.data;
    if (resp.status === 503 && /syncing/i.test(data.message || '')) {
      lastErr = new Error(data.message);
      continue;
    }
    // Cooldown is HTTP 429 with timeRemaining in ms -- arm the exact deadline
    // on this key so selecting it later shows precisely how long is left.
    const prof = genActiveKey();
    const wait = data.timeRemaining != null ? +data.timeRemaining : NaN;
    if (resp.status === 429 && prof && !isNaN(wait)) {
      genCdSet(prof.id, Date.now() + wait);
      genKeysTick();
      throw new Error(t('gen.keyInCooldown', { label: prof.label, t: genFmtMs(wait) }));
    }
    // Empty stock for this type: the key is valid (the API answered), there
    // is just nothing to pull right now. Say so plainly instead of showing
    // the raw API text alone.
    const raw = data.message || data.error || t('gen.genFailed');
    if (/no accounts available/i.test(raw)) throw new Error(raw + ' — ' + t('gen.noStock'));
    throw new Error(raw);
  }
  throw lastErr || new Error(t('gen.genFailed'));
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

// ASCII-only on purpose: Roblox usernames allow letters/numbers/underscore.
const MAN_ADJ = [
  'Swift','Brave','Clever','Silent','Rapid','Golden','Silver','Iron','Stormy','Frosty',
  'Shadow','Neon','Cosmic','Turbo','Quantum','Mighty','Sneaky','Lucky','Wild','Bold',
  'Crimson','Azure','Jade','Amber','Onyx','Solar','Lunar','Aero','Blaze','Vivid',
  'Prime','Ultra','Mega','Hyper','Alpha','Omega','Pixel','Ninja','Samurai','Viking',
  'Pirate','Astro','Retro','Magic','Dark','Light','Rapid','Feroz','Veloz','Astuto',
];
const MAN_NOUN = [
  'Wolf','Dragon','Falcon','Tiger','Shark','Eagle','Storm','Frost','Thunder','Viper',
  'Panther','Cobra','Raptor','Comet','Nova','Pulse','Bolt','Raven','Ember','Gale',
  'Fox','Bear','Lion','Panda','Koala','Otter','Hawk','Crow','Frog','Crab',
  'Knight','Wizard','Ranger','Hunter','Scout','Pilot','Captain','Sniper','Reaper','Ghost',
  'Robot','Cyborg','Ninja','Pirate','Titan','Golem','Phoenix','Griffin','Hydra','Kraken',
  'Castle','Tower','Bridge','River','Ocean','Desert','Forest','Mountain','Valley','Canyon',
  'Rocket','Satellite','Meteor','Planet','Galaxy','Engine','Circuit','Radar','Laser','Drift',
  'Blast','Surge','Dash','Flip','Spin','Jump','Rush','Storm','Flame','Wave',
];
// Readable password words: short, unambiguous spelling (no l/1/I/O/0 traps).
const MAN_PASS_WORDS = [
  'Lobo','Tigre','Falcao','Urso','Raposa','Aguia','Tubarao','Coruja','Gaviao','Panda',
  'Verde','Azul','Vermelho','Amarelo','Roxo','Cinza','Preto','Branco','Dourado','Prata',
  'Ninja','Pirata','Mago','Cacador','Piloto','Capitao','Escudo','Espada','Flecha','Martelo',
  'Solar','Lunar','Vento','Chuva','Neve','Ondas','Areia','Pedra','Fogo','Gelo',
  'Turbo','Pixel','Laser','Radar','Motor','Foguete','Meteoro','Planeta','Orbita','Sinal',
];

function manRandomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function manRandomUsername() {
  // Keep generating until the username doesn't collide with an existing
  // account (the user asked for this to avoid wasting signup attempts).
  const existing = new Set(accounts.map(a => (a.username || '').toLowerCase()));
  const pickNoun = () => MAN_NOUN[manRandomInt(MAN_NOUN.length)];
  const pickAdj = () => MAN_ADJ[manRandomInt(MAN_ADJ.length)];
  const digits = n => {
    let s = '';
    for (let i = 0; i < n; i++) s += String(manRandomInt(10));
    return s;
  };
  let tries = 0;
  while (tries++ < 200) {
    const style = manRandomInt(4);
    let username;
    if (style === 0) {
      username = pickNoun() + String(10000 + manRandomInt(90000)); // Wolf48392
    } else if (style === 1) {
      username = (pickAdj() + pickNoun() + digits(2 + manRandomInt(2))).slice(0, 20); // SwiftWolf42
    } else if (style === 2) {
      username = pickNoun() + '_' + digits(3 + manRandomInt(2)); // Wolf_482
    } else {
      username = (pickAdj() + digits(3 + manRandomInt(2)) + pickNoun()).slice(0, 20); // Swift482Wolf
    }
    if (username.length < 3 || username.length > 20) continue;
    if (!existing.has(username.toLowerCase())) return username;
  }
  // Fallback: extremely unlikely, but if every possible combo collides (e.g.
  // tens of thousands of accounts), append a counter.
  return MAN_NOUN[manRandomInt(MAN_NOUN.length)] + Date.now().toString(36);
}

function manRandomPassword() {
  // Readable but strong: Word-Word-NN! — always has upper, lower, digits and
  // symbols, ~13-16 chars, easy to read and type (no more alphabet soup).
  const w = () => MAN_PASS_WORDS[manRandomInt(MAN_PASS_WORDS.length)];
  const seps = ['-', '_', '.', '#'];
  const end = ['!', '?', '*', '#'];
  let a = w(), b = w();
  if (a === b) b = MAN_PASS_WORDS[(MAN_PASS_WORDS.indexOf(a) + 1 + manRandomInt(MAN_PASS_WORDS.length - 1)) % MAN_PASS_WORDS.length];
  const num = String(10 + manRandomInt(90));
  return a + seps[manRandomInt(seps.length)] + b + seps[manRandomInt(seps.length)] + num + end[manRandomInt(end.length)];
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
  // Generate a username that is BOTH unused locally and free on Roblox itself
  // (the Roblox username-validation endpoint: code 0 = available, code 1 =
  // already in use, other codes = invalid format).
  let username = manRandomUsername();
  for (let i = 0; i < 20; i++) {
    try {
      const res = await api.robloxGet('https://auth.roblox.com/v1/usernames/validate?Username=' + encodeURIComponent(username) + '&Birthday=2000-01-01');
      const code = res && res.data && res.data.code;
      if (code === 0) break; // free on Roblox → done
      username = manRandomUsername(); // taken or invalid → try another
    } catch {
      break; // offline / rate-limited → accept the generated one rather than block
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
let _ghFilter = 'all'; // all | ok | err

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
      '<span class="gh-user"><span class="gh-badge err">' + esc(t('gen.histErr')) + '</span> ' + esc(h.error || t('gen.genFailed')) + (h.key ? ' <span style="color:var(--t3)">· ' + esc(h.key) + '</span>' : '') + '</span>' +
      '<span class="gh-time">' + esc(ghTime(h.ts)) + '</span>' +
      '<div class="gh-actions">' +
        '<button class="btn btn-ghost" onclick="genHistRegen(' + i + ')"><span class="material-icons-round" style="font-size:15px">refresh</span></button>' +
      '</div></div>';
  }
  return '<div class="gen-hist-item" data-idx="' + i + '">' +
    '<span class="gh-user"><span style="color:var(--t3)">' + esc(t('gen.user')) + '</span> ' + esc(h.username) + '  <span style="color:var(--t3)">' + esc(t('gen.pass')) + '</span> ' + esc(h.password) + (h.key ? ' <span style="color:var(--t3)">· ' + esc(h.key) + '</span>' : '') + '</span>' +
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
  // Re-index existing rows so their onclick indices stay correct
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

// Switches to a saved key of the given provider prefix (BLOX-/MG_) when the
// active one doesn't match. Returns false when no such key exists.
function genEnsureProvider(prefix) {
  const cur = (document.getElementById('gen-apikey').value || '').trim();
  if (cur.startsWith(prefix)) return true;
  const found = _genKeys.find(k => (k.key || '').trim().startsWith(prefix));
  if (!found) return false;
  genSelectKey(found.id);
  return true;
}

// Re-runs the same provider + account type as the stored generation.
function genHistRegen(i) {
  const h = genHistVisible()[i];
  if (!h) return;
  if (h.provider === 'altgen') {
    if (!genEnsureProvider('MG_')) { toast(t('gen.needAltgenKey'), 'err'); return; }
  } else if (h.provider === 'bloxgen') {
    if (!genEnsureProvider('BLOX-')) { toast(t('gen.needBloxgenKey'), 'err'); return; }
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

// ── Exploits page (WEAO directory) ────────────────────────────────────────
let _exploits = null;
let _exploitsTab = 'exec';

function exploitsTab(tab) {
  _exploitsTab = tab;
  document.querySelectorAll('#exploits-tabs .tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('etab-' + tab);
  if (btn) btn.classList.add('active');
  positionTabSlider(document.getElementById('exploits-tabs'));
  renderExploits();
}

async function loadExploits() {
  const list = document.getElementById('exploits-list');
  const ic = document.getElementById('exploits-refresh-ic');
  if (ic) ic.classList.add('spin');
  if (list) list.innerHTML = '<div class="srv-skeleton" style="padding:18px 20px"><div class="skel-line" style="width:60%"></div><div class="skel-line" style="width:85%"></div><div class="skel-line" style="width:45%"></div></div>';
  try {
    const data = await api.weaoExploits();
    _exploits = Array.isArray(data) ? data : [];
    renderExploits();
  } catch (e) {
    if (list) list.innerHTML = '<div class="srv-state"><span class="material-icons-round srv-state-ic srv-state-err">error_outline</span><div class="srv-state-title">' + esc(t('exploits.errTitle')) + '</div><div class="srv-state-desc">' + esc(e.message || String(e)) + '</div><button class="btn btn-ghost" onclick="loadExploits()" style="gap:6px"><span class="material-icons-round" style="font-size:14px">refresh</span><span>' + esc(t('srv.retry')) + '</span></button></div>';
  } finally {
    if (ic) ic.classList.remove('spin');
  }
}

function renderExploits() {
  const list = document.getElementById('exploits-list');
  if (!list) return;
  const platform = (document.getElementById('exploits-platform') || {}).value || '';
  const statusF = (document.getElementById('exploits-status') || {}).value || '';
  let items = _exploits || [];
  if (_exploitsTab === 'exec') items = items.filter(e => e.extype !== 'wexternal');
  if (_exploitsTab === 'free') items = items.filter(e => !!e.free);
  if (_exploitsTab === 'paid') items = items.filter(e => !e.free);
  if (_exploitsTab === 'external') items = items.filter(e => e.extype === 'wexternal');
  if (platform) items = items.filter(e => e.platform === platform);
  if (statusF === 'updated') items = items.filter(e => !!e.updateStatus);
  if (statusF === 'notupdated') items = items.filter(e => !e.updateStatus);
  // Hierarchy: the most-used/stable executors are pinned on top (in order),
  // then the rest ranked by highest sUNC% first, then by name.
  const PRIORITY = ['Wave', 'Madium', 'Potassium', 'Volt', 'Real'];
  items = items.slice().sort((a, b) => {
    const ia = PRIORITY.indexOf(a.title);
    const ib = PRIORITY.indexOf(b.title);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    const ua = a.suncPercentage != null ? a.suncPercentage : (a.uncStatus ? 99 : 0);
    const ub = b.suncPercentage != null ? b.suncPercentage : (b.uncStatus ? 99 : 0);
    return ub - ua || String(a.title).localeCompare(String(b.title));
  });
  if (!items.length) {
    list.innerHTML = '<div class="srv-state"><span class="material-icons-round srv-state-ic">bolt</span><div class="srv-state-title">' + esc(t('exploits.none')) + '</div><div class="srv-state-desc">' + esc(t('exploits.noneDesc')) + '</div></div>';
    return;
  }
  list.innerHTML = items.map((e, i) => {
    const updated = !!e.updateStatus;
    const logo = (e.slug && e.slug.logo) || '';
    const unc = e.suncPercentage != null ? e.suncPercentage : (e.uncStatus ? 'UNC' : '');
    const price = e.cost || (e.free ? t('exploits.free') : '');
    return '<div class="exploit-item" style="animation-delay:' + (i * 25) + 'ms">' +
      '<span class="exploit-dot" style="background:' + (updated ? '#22c55e' : '#ef4444') + '" title="' + esc(updated ? t('exploits.updated') : t('exploits.notUpdated')) + '"></span>' +
      (logo ? '<img class="exploit-logo" src="' + esc(logo) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'"/>' : '<div class="exploit-logo exploit-logo-ph"><span class="material-icons-round">bolt</span></div>') +
      '<div class="exploit-info">' +
        '<div class="exploit-top"><span class="exploit-name">' + esc(e.title || '?') + '</span>' +
          '<span class="badge ' + (updated ? 'g' : 'r') + '" style="flex-shrink:0">' + esc(updated ? t('exploits.updated') : t('exploits.notUpdated')) + '</span></div>' +
        '<div class="exploit-meta">' +
          (e.version ? '<span class="exploit-ver">v' + esc(e.version) + '</span>' : '') +
          (e.platform ? '<span class="exploit-plat">' + esc(e.platform) + '</span>' : '') +
          (unc ? '<span class="exploit-unc">' + esc(String(unc)) + '% sUNC</span>' : '') +
          (price ? '<span class="exploit-price">' + esc(price) + '</span>' : '') +
        '</div>' +
        (e.updatedDate ? '<div class="exploit-date">' + esc(e.updatedDate) + '</div>' : '') +
      '</div>' +
      '<div class="exploit-actions">' +
        (e.websitelink ? '<a class="btn btn-ghost exploit-link" href="' + esc(e.websitelink) + '" target="_blank" rel="noopener" title="Website"><span class="material-icons-round" style="font-size:14px">language</span></a>' : '') +
        (e.discordlink ? '<a class="btn btn-ghost exploit-link" href="' + esc(e.discordlink) + '" target="_blank" rel="noopener" title="Discord"><span class="material-icons-round" style="font-size:14px">forum</span></a>' : '') +
        (e.purchaselink ? '<a class="btn btn-primary exploit-link" href="' + esc(e.purchaselink) + '" target="_blank" rel="noopener" title="Buy"><span class="material-icons-round" style="font-size:14px">shopping_cart</span></a>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Exploits consent (first-time disclaimer) ──────────────────────────────
function exploitsNeedsConsent() {
  try { return !localStorage.getItem('knt.exploits.consent'); }
  catch (e) { return true; }
}

function exploitsAccept() {
  try { localStorage.setItem('knt.exploits.consent', '1'); } catch (e) {}
  closeModal('m-exploits-consent');
  loadExploits();
}

function exploitsDecline() {
  closeModal('m-exploits-consent');
  goTo('dashboard');
}
