/* Workspace presentation, inspector state and group editing.
   Existing account/process commands remain in renderer.js; writes use the shared bridge. */
var _workspaceGroup = '';
var _workspaceMenuTrigger = null;
var _workspaceRendering = false;

function workspaceFilterState(list, filter, stateFor) {
  return list.filter(account => {
    const state = stateFor(account).state;
    if (filter === 'running') return state === 'running';
    if (filter === 'waiting') return state === 'waiting' || state === 'starting';
    if (filter === 'idle') return !['running','waiting','starting'].includes(state);
    return true;
  });
}
function workspaceStateCounts(list, stateFor) {
  const counts={all:list.length,running:0,idle:0,waiting:0};
  for (const account of list) {
    const state=stateFor(account).state;
    if(state==='running') counts.running++;
    else if(state==='waiting' || state==='starting') counts.waiting++;
    else counts.idle++;
  }
  return counts;
}

function workspaceAccountGroups(account, groups = packages) {
  return groups.filter(group => (group.accountIds || []).includes(account.id));
}
function workspaceSelectionIds(list, selected, checked) {
  const next = new Set(selected);
  for (const account of list) checked ? next.add(account.id) : next.delete(account.id);
  return next;
}
function workspaceSelect(input) {
  const id = input.closest('[data-id]').dataset.id;
  if (input.checked) _selectedIds.add(id); else _selectedIds.delete(id);
  _selectMode = _selectedIds.size > 0;
  document.getElementById('acct-select-btn')?.classList.toggle('on',_selectMode);
  updateBatchBar(); render();
  [...document.querySelectorAll('#grid .account-select')].find(box => box.closest('[data-id]').dataset.id === id)?.focus();
}
function workspaceSelectAll(input) {
  const next = workspaceSelectionIds(visibleAccounts(), _selectedIds, input.checked);
  _selectedIds.clear(); next.forEach(id => _selectedIds.add(id));
  _selectMode = _selectedIds.size > 0;
  document.getElementById('acct-select-btn')?.classList.toggle('on', _selectMode);
  updateBatchBar(); render();
}
function workspaceRowAction(event) {
  const button = event.target.closest('[data-account-action]');
  const row = button?.closest('[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  event.stopPropagation();
  if (button.dataset.accountAction === 'game') { openGamePicker([id]); }
  else if (button.dataset.accountAction === 'start') { closeCardMenu(); openLaunch(id); }
  else {
    showCardMenu(id, Math.min(event.clientX || button.getBoundingClientRect().left, innerWidth - 220), event.clientY || button.getBoundingClientRect().bottom);
    _workspaceMenuTrigger=button;
    document.querySelector('#card-ctx-menu button')?.focus();
  }
}
function workspaceCloseMenu(event) {
  if(!document.getElementById('card-ctx-menu')) return false;
  closeCardMenu();event.preventDefault();return true;
}
function workspaceAccountRow(account) {
  const state = accountUiState(account);
  const groups = workspaceAccountGroups(account);
  const groupNames = groups.map(group => group.name).join(', ');
  const category = categories.find(item => item.id === account.categoryId);
  const selected = _selectedIds.has(account.id);
  const target = account.gameTarget || '';
  const targetName = target ? (_gameNameCache[account.id] || extractTargetLabel(target)) : t('layout.home');
  return `<div class="card account-table-row${selected ? ' is-selected' : ''}" data-id="${esc(account.id)}" role="row">
    <div class="account-selection" role="cell"><input class="account-select" type="checkbox" onchange="workspaceSelect(this)" ${selected ? 'checked' : ''} aria-label="${esc(t('layout.selectAccount',{name:account.nickname || account.username}))}"/></div>
    <div class="account-identity" role="cell"><span class="material-icons-round drag-handle" aria-hidden="true">drag_indicator</span><div class="card-av" id="av-${esc(account.id)}">${esc((account.username || '?')[0].toUpperCase())}</div><div class="card-id"><div class="card-name">${esc(account.nickname || account.username || '?')}</div><div class="card-uid">@${esc(account.username || '?')}${category ? ' · '+esc(category.name) : ''}</div></div></div>
    <div class="account-groups" role="cell" title="${esc(groupNames)}">${groups.length ? '<span>'+esc(groups[0].name)+'</span>'+(groups.length > 1 ? '<small>+'+(groups.length-1)+'</small>' : '') : '<span class="text-muted">—</span>'}</div>
    <div role="cell"><span class="card-state" data-state="${state.state}">${esc(state.label)}</span></div>
    <div class="account-destination" role="cell"><span class="material-icons-round" aria-hidden="true">${target ? 'sports_esports' : 'home'}</span><div><strong id="gt-${esc(account.id)}">${esc(targetName)}</strong><small>${esc(target || t('layout.noGame'))}</small></div></div>
    <div class="account-row-actions" role="cell" onclick="workspaceRowAction(event)"><button class="btn btn-launch" data-account-action="start" aria-label="${esc(t('launch.start'))}" title="${esc(t('launch.start'))}"><span class="material-icons-round" aria-hidden="true">play_arrow</span></button><button class="btn btn-ghost" data-account-action="game" aria-label="${esc(t('batch.setGame'))}" title="${esc(t('batch.setGame'))}"><span class="material-icons-round" aria-hidden="true">videogame_asset</span></button><button class="btn btn-ghost" data-account-action="more" aria-label="${esc(t('layout.moreActions'))}" title="${esc(t('layout.moreActions'))}"><span class="material-icons-round" aria-hidden="true">more_vert</span></button></div>
  </div>`;
}
function workspaceSyncAccounts() {
  const page = document.getElementById('page-accounts');
  if (!page) return;
  page.classList.toggle('table-mode', _acctView === 'list');
  const counts = workspaceStateCounts(accounts,accountUiState);
  document.querySelectorAll('[data-account-filter]').forEach(button => {
    const filter = button.dataset.accountFilter;
    button.classList.toggle('active',_acctFilter === filter);
    button.setAttribute('aria-pressed', String(_acctFilter === filter));
    button.querySelector('b').textContent = counts[filter];
  });
  const summary = document.getElementById('account-summary');
  if (summary) summary.textContent = t('layout.summary', {total:accounts.length,running:counts.running,waiting:counts.waiting});
  const memberships=new Map();
  packages.forEach(group=>(group.accountIds || []).forEach(id=>{if(!memberships.has(String(id)))memberships.set(String(id),[]);memberships.get(String(id)).push(group);}));
  document.querySelectorAll('#grid .account-table-row').forEach(row=>{
    const groups=memberships.get(row.dataset.id) || [], column=row.querySelector('.account-groups');
    if(!column) return;
    const markup=groups.length ? '<span>'+esc(groups[0].name)+'</span>'+(groups.length>1?'<small>+'+(groups.length-1)+'</small>':'') : '<span class="text-muted">—</span>';
    if(column.innerHTML!==markup)column.innerHTML=markup;
    column.title=groups.map(group=>group.name).join(', ');
  });
  const byGroup=new Map(packages.map(group=>[String(group.id),group]));
  document.querySelectorAll('#group-catalog [data-group-id]').forEach(button=>{
    const group=byGroup.get(button.dataset.groupId),counter=button.querySelector('.catalog-destination b');
    if(group && counter){const state=pkgState(group);counter.textContent=state.running+'/'+state.total;}
  });
  const category = document.getElementById('account-category-filter');
  if (category) {
    const options = '<option value="">'+esc(t('layout.allCategories'))+'</option><option value="nocat">'+esc(t('accounts.noCategory'))+'</option>'+categories.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join('');
    if (category.dataset.options !== options) { category.innerHTML = options; category.dataset.options = options; }
    category.value = _acctCategory;
  }
  const launchCategory = document.getElementById('launch-category');
  if (launchCategory) launchCategory.hidden = !_acctCategory;
  const selectAll = document.getElementById('account-select-all');
  if (selectAll) {
    const visible = visibleAccounts();
    const selected = visible.filter(account => _selectedIds.has(account.id)).length;
    selectAll.checked = visible.length > 0 && selected === visible.length;
    selectAll.indeterminate = selected > 0 && selected < visible.length;
  }
  if(!_workspaceRendering && page.classList.contains('active') && _acctView==='list' && ['running','idle','waiting'].includes(_acctFilter)) {
    const expected=visibleAccounts().map(account=>String(account.id));
    const shown=[...document.querySelectorAll('#grid .account-table-row')].map(row=>row.dataset.id);
    if(expected.length!==shown.length || expected.some((id,index)=>id!==shown[index])) render();
  }
}
function workspaceCategory(value) {
  _acctCategory = value;
  render();
}
function workspaceLaunchCategory() {
  if (_acctCategory) folderLaunch(_acctCategory === 'nocat' ? 'none' : _acctCategory);
}
function workspaceGroupCatalog() {
  const catalog = document.getElementById('group-catalog');
  if (!catalog) return;
  const visible = visiblePackages();
  catalog.closest('.groups-workspace')?.classList.toggle('is-empty',!visible.length);
  if (!visible.some(group => group.id === _workspaceGroup)) _workspaceGroup = visible[0]?.id || '';
  catalog.innerHTML = visible.map(group => {
    const members = pkgMembers(group), state = pkgState(group);
    return '<button class="group-catalog-item'+(group.id === _workspaceGroup ? ' selected' : '')+'" data-group-id="'+esc(group.id)+'" aria-pressed="'+String(group.id === _workspaceGroup)+'"><div class="catalog-top"><span class="catalog-icon material-icons-round" aria-hidden="true">groups</span><div><strong>'+esc(group.name)+'</strong><small>'+esc(t('groups.memberCount',{n:members.length,s:members.length !== 1 ? 's' : ''}))+'</small></div><span class="material-icons-round" aria-hidden="true">chevron_right</span></div><div class="catalog-avatars">'+members.slice(0,5).map(account=>'<span title="'+esc(account.nickname || account.username)+'">'+(account.userId && _avatarCache[account.userId] ? '<img alt="" src="'+esc(_avatarCache[account.userId])+'"/>' : esc((account.username || '?')[0].toUpperCase()))+'</span>').join('')+'</div><div class="catalog-destination">'+pkgGameMarkup(group.link)+'<b>'+state.running+'/'+state.total+'</b></div></button>';
  }).join('');
  catalog.onclick = event => {
    const button = event.target.closest('[data-group-id]');
    if (button) { _workspaceGroup = button.dataset.groupId; workspaceGroupCatalog(); }
  };
  document.querySelectorAll('#pkg-list > .pkg-card').forEach(card => {
    const selected = card.dataset.id === _workspaceGroup;
    card.hidden = !selected;
    if (!card.dataset.workspace) {
      card.dataset.workspace = '1';
      const actions = card.querySelector('.pkg-card-actions');
      if (actions) {
        const more = document.createElement('details'); more.className = 'group-secondary-actions';
        const summary = document.createElement('summary'); summary.textContent = t('layout.moreActions');
        more.append(summary,actions); card.appendChild(more);
      }
    }
    if (selected) { card.querySelector('.pkg-members')?.classList.add('open'); workspaceGroupEditor(card); }
  });
  document.getElementById('group-detail-placeholder').hidden = true;
  const empty = document.getElementById('pkg-empty');
  if (!visible.length && empty) {
    const title = empty.querySelector('.empty-title'), sub = empty.querySelector('.empty-sub');
    if (title) title.textContent = t(packages.length ? 'rework.noGroupResults' : 'groups.emptyTitle');
    if (sub) sub.textContent = t(packages.length ? 'rework.clearFilters' : 'groups.emptySub');
  }
  const title = document.getElementById('group-detail-title');
  if (title) title.textContent = t('layout.groupDetails');
}
function workspaceLaunchDetails(account, gameName) {
  const target = account._srvTarget || account.gameTarget || '';
  const box = document.getElementById('launch-destination');
  if (!box) return;
  box.innerHTML = '<div class="launch-destination-icon material-icons-round" aria-hidden="true">sports_esports</div><span class="dialog-section-label">'+esc(t('ui.destination'))+'</span><strong>'+esc(gameName || t('layout.home'))+'</strong><code>'+esc(target || t('layout.noGame'))+'</code>';
}
function workspaceDistribute(id) {
  const group = packages.find(item => item.id === id);
  if (!group) return;
  const members = pkgMembers(group).filter(account => !_launchedIds.has(account.id));
  document.getElementById('distribute-group-name').textContent = group.name;
  document.getElementById('distribute-members').innerHTML = members.map(account=>'<div class="distribution-member"><span class="inspector-avatar">'+esc((account.username || '?')[0].toUpperCase())+'</span><strong>'+esc(account.nickname || account.username)+'</strong><span>'+esc(t('layout.pendingDestination'))+'</span></div>').join('') || '<p>'+esc(t('layout.noPendingMembers'))+'</p>';
  const start = document.getElementById('distribute-start');
  start.disabled = !members.length;
  start.onclick = () => { closeModal('m-distribute'); distributePkg(id); };
  openModal('m-distribute');
}

// Compose existing form controls into stable regions without recreating them:
// IDs, event handlers, pending-operation state and focus remain attached.
function workspaceInstall() {
  document.querySelectorAll('.page > .ph').forEach(header=>{
    const title=header.querySelector(':scope > .ph-title'), subtitle=header.querySelector(':scope > .ph-sub');
    if(title && subtitle){const heading=document.createElement('div');heading.className='page-heading';title.before(heading);heading.append(title,subtitle);}
  });
  const settings = document.getElementById('page-settings');
  if (settings && !settings.querySelector('.settings-workspace')) {
    const shell = document.createElement('div'); shell.className = 'settings-workspace';
    const menu = settings.querySelector(':scope > .tab-bar');
    menu.classList.add('settings-navigation');
    const content = document.createElement('div'); content.className = 'settings-content';
    [...settings.querySelectorAll(':scope > .sw')].forEach(panel=>content.appendChild(panel));
    shell.append(menu,content); settings.appendChild(shell);
  }
  const privacy=document.getElementById('stab-panel-privacy');
  if(privacy && !privacy.dataset.workspace){
    privacy.dataset.workspace='1';
    const sections=privacy.querySelectorAll(':scope > .sc');
    const crypto=sections[0], backup=sections[1];
    if(crypto){
      crypto.classList.add('privacy-crypto');
      const rows=crypto.querySelectorAll(':scope > .sr');
      if(rows[0]){
        rows[0].classList.add('privacy-explainer');
        const badge=rows[0].querySelector('.badge'),title=crypto.querySelector('.sc-head');
        if(badge && title){const heading=document.createElement('div');heading.className='crypto-heading';title.before(heading);heading.append(title,badge);}
        crypto.appendChild(rows[0]);
      }
    }
    if(backup){
      const grid=document.createElement('div');grid.className='backup-grid';
      [...backup.querySelectorAll(':scope > .sr')].forEach(row=>grid.appendChild(row));backup.appendChild(grid);
    }
  }
  const groupPage = document.getElementById('page-packages');
  if (groupPage && !groupPage.querySelector('.groups-workspace')) {
    const shell = document.createElement('div'); shell.className = 'groups-workspace';
    const catalog = document.createElement('div'); catalog.id = 'group-catalog'; catalog.className = 'group-catalog';
    const detail = document.createElement('section'); detail.className = 'group-detail';
    detail.innerHTML = '<div class="group-detail-heading" id="group-detail-title" data-i18n="layout.groupDetails">Group details</div><div id="group-detail-placeholder" class="detail-placeholder" data-i18n="layout.chooseGroup">Choose a group to see its members and actions.</div>';
    const list = document.getElementById('pkg-list');
    const empty = document.getElementById('pkg-empty');
    const old = list.parentElement;
    detail.append(list,empty); shell.append(catalog,detail); old.replaceWith(shell);
  }
  const mixer = document.querySelector('#page-mixer > .sw');
  if (mixer && !mixer.classList.contains('mixer-workspace')) {
    mixer.classList.add('mixer-workspace');
    [...mixer.children].forEach((section,index)=>{
      if (!section.classList.contains('sc')) {section.classList.add('mixer-actions'); return;}
      section.classList.add('mixer-setting');
      const icon = document.createElement('span'); icon.className = 'mixer-setting-icon material-icons-round'; icon.setAttribute('aria-hidden','true');
      icon.textContent = ['desktop_windows','speed','volume_up'][index] || 'tune'; section.prepend(icon);
    });
  }
  const generator = document.querySelector('#page-generator > .sw');
  generator?.classList.add('generator-workspace');
  const tracking = document.querySelector('#page-tracking > .sw');
  tracking?.classList.add('tracking-workspace');
  const batch = document.getElementById('batch-bar');
  document.getElementById('accounts-main')?.appendChild(batch);
  workspaceInstallControls(batch);
  const logs = document.getElementById('logs-list');
  if (logs && !document.getElementById('log-columns')) {
    const columns = document.createElement('div'); columns.id='log-columns'; columns.className='log-columns';
    columns.innerHTML='<span data-i18n="layout.time">Time</span><span data-i18n="layout.category">Category</span><span data-i18n="layout.message">Message</span>';
    logs.before(columns);
    const button = document.createElement('button'); button.className='btn btn-ghost'; button.id='open-log-search'; button.setAttribute('onclick','openLogFind()'); button.setAttribute('data-i18n','layout.searchLogs'); button.textContent='Search logs';
    document.querySelector('#page-logs .ph').appendChild(button);
  }
}
function workspacePrepareDialog(overlay) {
  const modal = overlay.querySelector('.modal');
  if (!modal || modal.dataset.workspace) return;
  modal.dataset.workspace = '1';
  const title = modal.querySelector(':scope > .modal-title');
  if (title) {
    const header = document.createElement('header'); header.className='dialog-heading';
    const icon = document.createElement('span'); icon.className='dialog-icon material-icons-round'; icon.setAttribute('aria-hidden','true');
    icon.textContent = ({'m-login':'person_add','m-launch':'play_arrow','m-edit':'manage_accounts','m-key-change':'lock','m-backup':'inventory_2','m-confirm-delete':'delete_outline','m-distribute':'call_split','m-text-input':'edit'})[overlay.id] || 'tune';
    const text = document.createElement('div'); title.before(header); text.appendChild(title);
    const subtitle = modal.querySelector(':scope > .modal-sub'); if (subtitle) text.appendChild(subtitle);
    header.append(icon,text);
  }
  if (overlay.id === 'm-package') {
    const body = modal.querySelector('.pm-body');
    const basics = document.createElement('section'); basics.className='group-form-basics';
    const picker = document.createElement('section'); picker.className='group-form-members';
    [...body.children].forEach((element,index)=>(index < 3 ? basics : picker).appendChild(element));
    body.append(basics,picker);
  }
  if (overlay.id === 'm-edit') {
    modal.querySelectorAll('.edit-col').forEach((column,index)=>{
      const heading = document.createElement('div'); heading.className='dialog-section-label'; heading.setAttribute('data-i18n',index ? 'layout.gameAndAccess' : 'layout.accountProfile'); heading.textContent = t(index ? 'layout.gameAndAccess' : 'layout.accountProfile'); column.prepend(heading);
    });
  }
}
function workspaceInstallControls(batch) {
  const more = document.querySelector('.account-option-actions > .workspace-more');
  if (more) {
    const actions = document.createElement('div'); actions.className = 'account-direct-actions';
    actions.append(...more.querySelector('.workspace-more-panel').children);
    more.replaceWith(actions);
  }
  if (batch) {
    const header = document.createElement('div'); header.className = 'selection-heading';
    const actions = document.createElement('div'); actions.className = 'selection-actions';
    const cancel = batch.querySelector('[onclick="clearSelection()"]');
    cancel.removeAttribute('data-i18n');
    cancel.innerHTML = '<span class="material-icons-round">close</span><span data-i18n="rework.cancelSelection">Cancel selection</span>';
    header.append(document.getElementById('batch-count'),cancel);
    const order = ['batchLaunch()','openBatchTarget()','batchToGroup()','toggleBatchCats(event)','batchTrim()','batchCopyLogins()','batchKill()'];
    const icons = ['play_arrow','videogame_asset','group_add','label','memory','content_copy','power_settings_new'];
    order.forEach((command,index)=>{
      const button = batch.querySelector('[onclick="'+command+'"]');
      if (!button) return;
      const key = button.getAttribute('data-i18n'); button.removeAttribute('data-i18n');
      button.innerHTML = '<span class="material-icons-round" aria-hidden="true">'+icons[index]+'</span><span data-i18n="'+key+'"></span>';
      actions.append(button.closest('.filter-wrap') || button);
    });
    batch.replaceChildren(header,actions);
  }
  const workspace = document.querySelector('.account-workspace');
  const toggle = document.createElement('button'); toggle.id = 'group-panel-toggle';
  toggle.className = 'group-panel-toggle'; toggle.setAttribute('aria-controls','account-group-panel');
  toggle.innerHTML = '<span class="material-icons-round" aria-hidden="true">chevron_right</span>';
  toggle.onclick = () => workspaceToggleInspector();
  workspace.append(toggle);
  let collapsed = false;
  try { collapsed = localStorage.getItem('knt_group_panel_collapsed') === '1'; } catch {}
  workspace.classList.toggle('group-panel-collapsed',collapsed);
  document.getElementById('account-group-panel').hidden = collapsed;
}

function workspaceToggleInspector() {
  const workspace = document.querySelector('.account-workspace');
  const collapsed = workspace.classList.toggle('group-panel-collapsed');
  document.getElementById('account-group-panel').hidden = collapsed;
  try { localStorage.setItem('knt_group_panel_collapsed',collapsed ? '1' : '0'); } catch {}
  workspaceInspectorToggleLabel();
}
function workspaceInspectorToggleLabel() {
  const button = document.getElementById('group-panel-toggle');
  if (!button) return;
  const collapsed = document.getElementById('account-group-panel').hidden;
  button.title = t(collapsed ? 'rework.showGroup' : 'rework.hideGroup');
  button.setAttribute('aria-label',button.title);
  button.setAttribute('aria-expanded',String(!collapsed));
  button.firstElementChild.textContent = collapsed ? 'chevron_left' : 'chevron_right';
}
function workspaceInspectorOptions(query = '') {
  const select = document.getElementById('account-group-select');
  if (!select) return;
  const needle = query.trim().toLocaleLowerCase();
  select.innerHTML = '<option value="">'+esc(t('rework.chooseGroup'))+'</option>'+packages
    .filter(group=>group.id === _inspectorGroupId || group.name.toLocaleLowerCase().includes(needle))
    .map(group=>'<option value="'+esc(group.id)+'">'+esc(group.name)+' · '+pkgMembers(group).length+'</option>').join('');
  select.value = _inspectorGroupId;
}
function workspaceRenderInspector() {
  const panel = document.getElementById('account-group-panel');
  if (!panel) return;
  workspaceInspectorToggleLabel();
  if (!packages.some(group=>group.id === _inspectorGroupId)) _inspectorGroupId = '';
  const signature = JSON.stringify([_lang,_inspectorGroupId,packages.map(g=>[g.id,g.name,g.accountIds,g.launchOrder,g.link]),accounts.map(a=>[a.id,a.username,a.nickname])]);
  if (signature === _inspectorSignature) { refreshAccountStatuses(); return; }
  _inspectorSignature = signature;
  const group = packages.find(g=>g.id === _inspectorGroupId);
  const heading = '<div class="inspector-heading"><span class="material-icons-round" aria-hidden="true">groups</span>'+esc(t('ui.groupPanel'))+'</div>';
  const selector = packages.length ? '<label class="inspector-label" for="inspector-search">'+esc(t('ui.chooseGroup'))+'</label><input id="inspector-search" class="sr-input inspector-search" placeholder="'+esc(t('rework.searchGroup'))+'" oninput="workspaceInspectorOptions(this.value)"/><select id="account-group-select" class="inspector-select" aria-label="'+esc(t('ui.chooseGroup'))+'" onchange="_inspectorGroupId=this.value;renderGroupInspector()"></select>' : '';
  panel.innerHTML = heading+selector+(group ?
    '<div class="inspector-destination-heading"><span class="inspector-label">'+esc(t('ui.destination'))+'</span><button class="btn btn-ghost group-game-picker-btn" data-group-action="game" title="'+esc(t('rework.pickerTitle'))+'" aria-label="'+esc(t('rework.pickerTitle'))+'"><span class="material-icons-round" aria-hidden="true">videogame_asset</span></button></div><div class="inspector-game">'+pkgGameMarkup(group.link || '')+'</div><div class="inspector-actions"><button class="btn btn-primary" data-group-action="start">'+esc(t('groups.startAll'))+'</button><button class="btn btn-ghost" data-group-action="distribute">'+esc(t('pkg.distribute'))+'</button><button class="btn btn-ghost" data-group-action="edit">'+esc(t('ui.manageGroup'))+'</button></div><span class="inspector-label">'+esc(t('ui.members'))+' · '+pkgMembers(group).length+'</span>'+pkgMembers(group).map(account=>{
      const state = accountUiState(account);
      return '<div class="inspector-member" data-account-id="'+esc(account.id)+'"><span class="inspector-avatar">'+esc((account.username || '?')[0].toUpperCase())+'</span><strong>'+esc(account.nickname || account.username)+'</strong><span class="card-state" data-state="'+state.state+'">'+esc(state.label)+'</span></div>';
    }).join('') : '<div class="inspector-empty"><span class="material-icons-round">group_work</span><p>'+esc(t(packages.length ? 'rework.chooseGroup' : 'groups.emptyTitle'))+'</p><button class="btn btn-ghost" data-group-action="create">'+esc(t('groups.new'))+'</button></div>');
  workspaceInspectorOptions();
  panel.onclick = event=>{
    const action = event.target.closest('[data-group-action]')?.dataset.groupAction;
    if (action === 'create') openCreatePackage();
    if (action === 'edit') { _workspaceGroup = _inspectorGroupId; goTo('packages'); }
    if (action === 'game') openGroupGamePicker(_inspectorGroupId);
    if (action === 'start') launchPackage(_inspectorGroupId);
    if (action === 'distribute') workspaceDistribute(_inspectorGroupId);
  };
  refreshAccountStatuses();
}

var _workspaceGroupSaving = false;
async function workspacePersistGroups(next) {
  const result = await api.savePackages(next);
  if (result === false || result?.ok === false) throw new Error('Group persistence failed');
}
async function workspaceSaveGroup(id, patch) {
  if (_workspaceGroupSaving || _pkgLaunchJobs.has(id)) return false;
  const group = packages.find(item=>item.id === id);
  if (!group) return false;
  _workspaceGroupSaving = true;
  try {
    const next = packages.map(item=>item.id === id ? {...item,...patch} : item);
    await workspacePersistGroups(next);
    Object.assign(group,patch);
    renderPackages(); workspaceSyncAccounts();
    return true;
  } catch { toast(t('rework.saveError'),'err'); return false; }
  finally { _workspaceGroupSaving = false; }
}
function workspaceGroupEditor(card) {
  if (card.querySelector('.group-editor')) return;
  const group = packages.find(item=>item.id === card.dataset.id);
  if (!group) return;
  const busy = _pkgLaunchJobs.has(group.id);
  const editor = document.createElement('form'); editor.className = 'group-editor';
  editor.innerHTML = '<h3>'+esc(t('rework.groupSettings'))+'</h3><div class="group-fields"><label>'+esc(t('groups.name'))+'<input class="sr-input" name="name" required maxlength="100" value="'+esc(group.name)+'"/></label><label>'+esc(t('groups.delay'))+' (ms)<input class="sr-input" name="delay" type="number" min="0" max="60000" step="100" value="'+Number(group.launchDelay || 0)+'"/></label><label>'+esc(t('groups.color'))+'<input name="color" type="color" value="'+(/^#[a-fA-F0-9]{6}$/.test(group.color) ? group.color : '#8b6cef')+'"/></label></div><button class="btn btn-ghost" type="submit">'+esc(t('groups.save'))+'</button>';
  editor.onsubmit = async event=>{
    event.preventDefault(); const data = new FormData(editor);
    const name = String(data.get('name')).trim(); if (!name) return;
    const button = editor.querySelector('button'); button.disabled = true;
    await workspaceSaveGroup(group.id,{name,launchDelay:Math.min(60000,Math.max(0,Number(data.get('delay')) || 0)),color:data.get('color')});
    button.disabled = false;
  };
  editor.querySelectorAll('input,button').forEach(el=>el.disabled=busy);
  card.querySelector('.pkg-status').after(editor);
  const members = card.querySelector('.pkg-members');
  const toolbar = document.createElement('div'); toolbar.className = 'group-members-toolbar';
  toolbar.innerHTML = '<div><h3>'+esc(t('ui.members'))+' · '+pkgMembers(group).length+'</h3><p>'+esc(t('rework.membersHint'))+'</p></div><div class="group-member-actions"><button class="btn btn-primary" data-member-add><span class="material-icons-round">person_add</span>'+esc(t('rework.addMembers'))+'</button><button class="btn btn-ghost" data-member-remove disabled>'+esc(t('rework.removeMembers'))+'</button></div>';
  toolbar.querySelector('[data-member-add]').disabled = busy;
  toolbar.querySelector('[data-member-add]').onclick = ()=>openEditPackage(group.id);
  const remove = toolbar.querySelector('[data-member-remove]');
  remove.onclick = ()=>{
    const selected = [...members.querySelectorAll('input:checked')].map(input=>input.value);
    if (!selected.length) return;
    confirmAction(t('rework.removeConfirm',{n:selected.length}),()=>workspaceSaveGroup(group.id,{
      accountIds:(group.accountIds || []).filter(id=>!selected.includes(id)),
      launchOrder:(group.launchOrder || group.accountIds || []).filter(id=>!selected.includes(id)),
    }));
  };
  members.before(toolbar);
  const ordered = pkgMembers(group);
  members.querySelectorAll('[data-acc-id]').forEach((row,index)=>{
    const checkbox = document.createElement('input'); checkbox.type='checkbox'; checkbox.value=row.dataset.accId; checkbox.disabled=busy;
    checkbox.setAttribute('aria-label',t('layout.selectAccount',{name:ordered[index]?.nickname || ordered[index]?.username || ''}));
    checkbox.onchange=()=>remove.disabled=busy || !members.querySelector('input:checked');
    row.prepend(checkbox);
    const controls = document.createElement('span'); controls.className='member-order-controls';
    [-1,1].forEach(direction=>{
      const button=document.createElement('button'); button.className='btn btn-ghost';
      button.innerHTML='<span class="material-icons-round">'+(direction<0?'arrow_upward':'arrow_downward')+'</span>';
      button.setAttribute('aria-label',t('groups.launchOrder')+' '+(index+1)+' → '+(index+direction+1));
      button.disabled=busy || index+direction<0 || index+direction>=ordered.length;
      button.onclick=async()=>{
        const ids=ordered.map(a=>a.id); [ids[index],ids[index+direction]]=[ids[index+direction],ids[index]];
        button.disabled=true; await workspaceSaveGroup(group.id,{launchOrder:ids}); button.disabled=false;
      };
      controls.append(button);
    });
    row.append(controls);
  });
  const edit = card.querySelector('.pkg-card-actions [onclick^="openEditPackage"]');
  if (edit) edit.hidden=true;
}

workspaceInstall();
document.addEventListener('click',event=>{
  document.querySelectorAll('details.workspace-more[open]').forEach(menu=>{
    if(!menu.contains(event.target) || (event.target.closest('button') && !event.target.closest('.filter-wrap'))) menu.open=false;
  });
});
