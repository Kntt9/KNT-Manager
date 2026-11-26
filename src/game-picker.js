/* Shared Roblox catalog requests and reusable account/group destination picker. */
const _gameRequestCache = new Map();
function cachedGameRequest(key, request) {
  const cached = _gameRequestCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const entry = {expires:Date.now()+300000,promise:null};
  entry.promise = Promise.resolve().then(request).catch(error=>{
    if (_gameRequestCache.get(key) === entry) _gameRequestCache.delete(key);
    throw error;
  });
  _gameRequestCache.set(key,entry);
  if (_gameRequestCache.size>40) _gameRequestCache.delete(_gameRequestCache.keys().next().value);
  return entry.promise;
}
function fetchRobloxGames(sortId) {
  return cachedGameRequest('sort:'+sortId,()=>fetchRobloxGamesUncached(sortId));
}
function searchRobloxGames(query) {
  return cachedGameRequest('search:'+query.trim().toLocaleLowerCase(),()=>searchRobloxGamesUncached(query));
}
function validGameTarget(value) {
  const target = String(value || '').trim();
  if (/^[1-9]\d*(?:[:,][\w-]+)?$/.test(target)) return Number.isSafeInteger(Number(target.split(/[:,]/)[0]));
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || !['roblox.com','www.roblox.com'].includes(url.hostname) || url.username || url.password || url.port) return false;
    if (/^\/games\/[1-9]\d*(?:\/|$)/.test(url.pathname)) return true;
    if (url.pathname === '/share') return Boolean(url.searchParams.get('code')) && url.searchParams.get('type')?.toLowerCase() === 'server';
    return url.pathname === '/games/start' && /^[1-9]\d*$/.test(url.searchParams.get('placeId') || '');
  } catch { return false; }
}
let _gamePicker = null;
function installGamePicker() {
  if (document.getElementById('m-game-picker')) return;
  const overlay = document.createElement('div'); overlay.className='overlay'; overlay.id='m-game-picker';
  overlay.dataset.backdropClose='true';
  overlay.innerHTML = `<div class="modal game-picker-modal">
    <div class="modal-title" data-i18n="rework.pickerTitle"></div>
    <div class="modal-sub" id="game-picker-account"></div>
    <div class="game-picker-search"><span class="material-icons-round" aria-hidden="true">search</span><input id="game-picker-search" type="search" autocomplete="off" data-i18n-ph="rework.pickerSearch" data-i18n-aria="rework.pickerSearch"/></div>
    <div class="game-picker-tabs"><button class="btn btn-ghost" id="picker-popular" data-i18n="rework.popular"></button><button class="btn btn-ghost" id="picker-favorites" data-i18n="rework.favorites"></button></div>
    <div id="game-picker-status" class="game-picker-status" role="status" aria-live="polite"></div>
    <div id="game-picker-grid" class="game-picker-grid"></div>
    <label class="game-picker-target" for="game-picker-target"><span data-i18n="rework.pickerTarget"></span><input class="sr-input" id="game-picker-target" autocomplete="off" spellcheck="false"/></label>
    <div id="game-picker-chosen" class="game-picker-chosen" aria-live="polite"></div>
    <p class="game-picker-hint" data-i18n="rework.pickerHint"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="game-picker-cancel" data-i18n="common.cancel"></button><button class="btn btn-primary" id="game-picker-apply" data-i18n="rework.pickerTitle" disabled></button></div>
  </div>`;
  document.body.append(overlay);
  overlay.onclick = event=>{if(event.target === overlay && !_gamePicker?.busy) closeModal(overlay.id);};
  overlay.addEventListener('knt:dialog-closed',()=>{if (_gamePicker) {clearTimeout(_gamePicker.timer);_gamePicker.sequence++;}});
  document.getElementById('game-picker-search').oninput=()=>{
    const state=_gamePicker; clearTimeout(state.timer); state.sequence++;
    state.timer=setTimeout(()=>loadGamePicker(),400);
  };
  document.getElementById('game-picker-target').oninput=()=>{
    _gamePicker.target=document.getElementById('game-picker-target').value.trim();
    _gamePicker.selected=null; updateGamePickerSelection();
  };
  document.getElementById('picker-popular').onclick=()=>{_gamePicker.favorites=false;loadGamePicker();};
  document.getElementById('picker-favorites').onclick=()=>{_gamePicker.favorites=true;loadGamePicker();};
  document.getElementById('game-picker-cancel').onclick=()=>closeModal(overlay.id);
  document.getElementById('game-picker-apply').onclick=()=>applyGamePicker();
}
function openGamePicker(ids) {
  if (_gamePicker?.busy) return;
  const targets=[...new Set(ids)].filter(id=>accounts.some(account=>account.id===id));
  if (!targets.length) {toast(t('batch.none'),'err');return;}
  const account=targets.length===1 ? accounts.find(a=>a.id===targets[0]) : null;
  showGamePicker({ids:targets,target:account?.gameTarget || '',
    caption:account ? t('rework.pickerFor',{name:account.nickname || account.username}) : t('rework.pickerMany',{n:targets.length})});
}
function openGroupGamePicker(id) {
  if (_gamePicker?.busy || _pkgLaunchJobs.has(id)) return;
  const group=packages.find(item=>item.id===id);
  if (!group) return;
  showGamePicker({groupId:id,target:group.link || '',caption:t('rework.pickerGroup',{name:group.name})});
}
function showGamePicker(context) {
  installGamePicker();
  if (_gamePicker) clearTimeout(_gamePicker.timer);
  _gamePicker={...context,selected:null,games:[],sequence:0,timer:null,busy:false,favorites:false};
  const overlay=document.getElementById('m-game-picker');
  overlay.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n));
  overlay.querySelectorAll('[data-i18n-ph]').forEach(el=>{el.placeholder=t(el.dataset.i18nPh);el.setAttribute('aria-label',el.placeholder);});
  overlay.querySelectorAll('input,button').forEach(el=>el.disabled=false);
  document.getElementById('game-picker-account').textContent=context.caption;
  overlay.querySelector('.game-picker-hint').textContent=t(context.groupId ? 'rework.pickerGroupHint' : 'rework.pickerHint');
  document.getElementById('game-picker-search').value='';
  document.getElementById('game-picker-target').value=_gamePicker.target;
  updateGamePickerSelection(); openModal('m-game-picker'); loadGamePicker();
}
async function loadGamePicker() {
  const state=_gamePicker, sequence=++state.sequence;
  const query=document.getElementById('game-picker-search').value.trim();
  const status=document.getElementById('game-picker-status'), grid=document.getElementById('game-picker-grid');
  status.textContent=t('charts.loading'); grid.replaceChildren();
  ['popular','favorites'].forEach(tab=>{
    const active=(tab==='favorites')===state.favorites;
    document.getElementById('picker-'+tab).setAttribute('aria-pressed',String(active));
  });
  try {
    let games=query ? await searchRobloxGames(query) : (allCharts.popular?.length ? allCharts.popular : await fetchRobloxGames('top-playing-now'));
    if (_gamePicker!==state || sequence!==state.sequence) return;
    games=games.filter(game=>game.placeId);
    if (state.favorites) games=games.filter(game=>_favGames.has(_gameKey(game)));
    state.games=games;
    status.textContent=games.length ? '' : t('rework.pickerNone');
    grid.innerHTML=games.map((game,index)=>'<button class="game-picker-card" data-game-index="'+index+'" aria-pressed="false">'+(game.thumbUrl ? '<img src="'+esc(game.thumbUrl)+'" alt="" loading="lazy"/>' : '<span class="game-picker-placeholder material-icons-round">videogame_asset</span>')+'<strong>'+esc(game.name || game.placeId)+'</strong><small>ID '+esc(game.placeId)+'</small><span class="game-picker-check material-icons-round" aria-hidden="true">check_circle</span></button>').join('');
    grid.querySelectorAll('[data-game-index]').forEach(button=>button.onclick=()=>{
      if(state.busy)return;
      state.selected=state.games[Number(button.dataset.gameIndex)];state.target=String(state.selected.placeId);
      document.getElementById('game-picker-target').value=state.target;updateGamePickerSelection();
    });
    updateGamePickerSelection();
  } catch {
    if (_gamePicker!==state || sequence!==state.sequence) return;
    status.textContent=t('rework.pickerError');
    const retry=document.createElement('button');retry.className='btn btn-ghost';retry.textContent=t('rework.retry');retry.onclick=()=>loadGamePicker();status.append(retry);
  }
}
function updateGamePickerSelection() {
  const state=_gamePicker;
  document.getElementById('game-picker-apply').disabled=state.busy || !validGameTarget(state.target);
  document.getElementById('game-picker-chosen').textContent=state.target ? (validGameTarget(state.target) ? t('rework.gameChosen',{name:state.selected?.name || state.target}) : t('rework.targetInvalid')) : t('rework.pickGame');
  document.querySelectorAll('[data-game-index]').forEach(button=>button.setAttribute('aria-pressed',String(String(state.games[Number(button.dataset.gameIndex)]?.placeId)===state.target)));
}
async function saveGameDestinations(ids, target) {
  const failed=[];let ok=0;
  for (const id of ids) {
    const account=accounts.find(item=>item.id===id);
    if (!account) {failed.push(id);continue;}
    try {
      const updated = await api.updateAccount(id,{gameTarget:target});
      if (!updated || updated.ok === false || updated.id !== id) throw new Error('Account was not saved');
      account.gameTarget=target;delete _gameNameCache[id];ok++;
    } catch {failed.push(id);}
  }
  return {ok,failed};
}
async function applyGamePicker() {
  const state=_gamePicker;
  if (!state || state.busy || !validGameTarget(state.target)) return;
  state.busy=true;state.sequence++;clearTimeout(state.timer);
  const overlay=document.getElementById('m-game-picker');
  overlay.querySelectorAll('input,button').forEach(el=>el.disabled=true);
  const apply=document.getElementById('game-picker-apply');apply.textContent=t('rework.saving');
  const total=state.groupId ? 1 : state.ids.length;
  const result=state.groupId
    ? {ok:await workspaceSaveGroup(state.groupId,{link:state.target}) ? 1 : 0}
    : await saveGameDestinations([...state.ids],state.target);
  const saved=state.groupId ? result.ok===1 : !result.failed.length;
  if (!state.groupId) render();
  if (_gamePicker!==state) return;
  state.busy=false;
  overlay.querySelectorAll('input,button').forEach(el=>el.disabled=false);
  apply.textContent=t('rework.pickerTitle');updateGamePickerSelection();
  if (state.groupId) {
    if (saved) toast(t('rework.groupGameSet'),'ok');
  } else toast(t('batch.gameSet',{ok:result.ok,total}),saved ? 'ok' : 'err');
  if (saved) closeModal('m-game-picker');
  else {
    if (!state.groupId) {
      state.ids=result.failed;
      document.getElementById('game-picker-account').textContent=t('rework.pickerMany',{n:state.ids.length});
    }
    document.getElementById('game-picker-status').textContent=t('rework.saveError');
  }
}
