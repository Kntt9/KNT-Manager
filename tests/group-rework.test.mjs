import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const renderer=readFileSync(new URL('../src/renderer.js',import.meta.url),'utf8');
const workspace=readFileSync(new URL('../src/workspace-ui.js',import.meta.url),'utf8');
const workspaceSource=workspace.slice(0,workspace.lastIndexOf('\nworkspaceInstall();'));

test('empty group render clears the old card and refreshes catalog, inspector and dashboard',()=>{
  const list={innerHTML:'old card'},empty={style:{display:'none'}},calls=[];
  const code=renderer.slice(renderer.indexOf('function renderPackages()'),renderer.indexOf('function openCreatePackage()'));
  const h=vm.createContext({document:{getElementById:id=>id==='pkg-list'?list:empty},
    _refreshLaunchPresentation(){},renderGroupInspector:()=>calls.push('inspector'),visiblePackages:()=>[],
    workspaceGroupCatalog:()=>calls.push('catalog'),renderDashboard:()=>calls.push('dashboard')});
  vm.runInContext(code,h);h.renderPackages();
  assert.equal(list.innerHTML,'');assert.equal(empty.style.display,'flex');
  assert.deepEqual(calls,['inspector','catalog','dashboard']);
});
test('failed group persistence keeps the original name, members, and order',async()=>{
  const group={id:'g',name:'Original',accountIds:['a','b'],launchOrder:['b','a']};
  const h=vm.createContext({packages:[group],_pkgLaunchJobs:new Map(),api:{savePackages:async()=>false},
    toast(){},t:k=>k,renderPackages(){throw Error('must not render a failed save');},workspaceSyncAccounts(){}});
  vm.runInContext(workspaceSource,h);
  const saved=await h.workspaceSaveGroup('g',{name:'Changed',accountIds:['a'],launchOrder:['a']});
  assert.equal(saved,false);assert.equal(group.name,'Original');assert.deepEqual(group.accountIds,['a','b']);
  assert.deepEqual(group.launchOrder,['b','a']);assert.equal(h._workspaceGroupSaving,false);
});
test('editing a group preserves untouched metadata and leaves account inspector selection alone',async()=>{
  const group={id:'g',name:'Original',accountIds:['a','b'],launchOrder:['a','b'],link:'123',pinned:true,color:'#123456'};
  const calls=[];
  const h=vm.createContext({packages:[group],_inspectorGroupId:'another',_pkgLaunchJobs:new Map(),
    api:{savePackages:async next=>{calls.push(next);return true;}},toast(){},t:k=>k,renderPackages(){},document:{getElementById:()=>null}});
  vm.runInContext(workspaceSource,h);
  assert.equal(await h.workspaceSaveGroup('g',{launchOrder:['b','a']}),true);
  assert.equal(group.link,'123');assert.equal(group.pinned,true);assert.equal(group.color,'#123456');
  assert.deepEqual(group.launchOrder,['b','a']);assert.equal(h._inspectorGroupId,'another');assert.equal(calls.length,1);
});
test('a busy group rejects membership edits before writing',async()=>{
  const h=vm.createContext({_pkgLaunchJobs:new Map([['g',{}]]),api:{savePackages(){throw Error('unexpected write');}}});
  vm.runInContext(workspaceSource,h);
  assert.equal(await h.workspaceSaveGroup('g',{accountIds:[]}),false);
});
