import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const moduleSource=readFileSync(new URL('../src/workspace-ui.js',import.meta.url),'utf8');
const source=moduleSource.slice(0,moduleSource.lastIndexOf('\nworkspaceInstall();'));
function harness() {
 const events=[], elements=new Map();
 const accounts=[{id:'a',username:'Example',cookie:'fake'},{id:'b',username:'Running',cookie:'fake'}];
 const packages=[{id:'g',name:'My group',accountIds:['a','b']}];
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',disabled:false});return elements.get(id);};
 const context=vm.createContext({
  packages,accounts,categories:[],_selectedIds:new Set(),_gameNameCache:{},_launchedIds:new Set(['b']),
  document:{getElementById:element},
  pkgMembers:group=>accounts.filter(account=>group.accountIds.includes(account.id)),
  t:(key,params={})=>key+(params.name || ''),
  esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),
  accountUiState:()=>({state:'stopped',label:'Stopped'}),extractTargetLabel:value=>value,
  openModal:id=>events.push(['open',id]),closeModal:id=>events.push(['close',id]),
  distributePkg:id=>events.push(['distribute',id]),
 });
 vm.runInContext(source,context);
 return {context,events,element,accounts,packages};
}
test('group membership uses saved account IDs and includes multiple groups',()=>{
 const {context:h}=harness();
 const groups=[{id:'one',accountIds:['a']},{id:'two',accountIds:['a','b']},{id:'three',accountIds:['b']}];
 assert.deepEqual(Array.from(h.workspaceAccountGroups({id:'a'},groups),group=>group.id),['one','two']);
});
test('select all affects visible rows and preserves selection outside the current filter',()=>{
 const {context:h}=harness();
 const initial=new Set(['hidden']);
 const selected=h.workspaceSelectionIds([{id:'a'},{id:'b'}],initial,true);
 assert.deepEqual([...selected],['hidden','a','b']);
 assert.deepEqual([...h.workspaceSelectionIds([{id:'a'}],selected,false)],['hidden','b']);
 assert.deepEqual([...initial],['hidden']);
});
test('status counts and filters agree; accounts waiting to start are not stopped',()=>{
 const {context:h}=harness();
 const list=['running','stopped','waiting','starting','home','invalid'].map((state,id)=>({id,state}));
 const stateFor=account=>({state:account.state});
 const counts=h.workspaceStateCounts(list,stateFor);
 for(const filter of ['running','idle','waiting'])assert.equal(counts[filter],h.workspaceFilterState(list,filter,stateFor).length);
 assert.deepEqual(Array.from(h.workspaceFilterState(list,'waiting',stateFor),item=>item.state),['waiting','starting']);
 assert.deepEqual(Array.from(h.workspaceFilterState(list,'idle',stateFor),item=>item.state),['stopped','home','invalid']);
});
test('opening distribution performs no launch and escapes account text in its preview',()=>{
 const h=harness();h.accounts[0].username='<img src=x onerror=alert(1)>';
 h.context.workspaceDistribute('g');
 assert.deepEqual(h.events,[['open','m-distribute']]);
 const markup=h.element('distribute-members').innerHTML;
 assert(markup.includes('&lt;img'));assert(!markup.includes('<img src=x'));
 assert(!markup.includes('Running'));
});
test('confirming distribution closes the preview then delegates to the existing group command',()=>{
 const h=harness();h.context.workspaceDistribute('g');h.element('distribute-start').onclick();
 assert.deepEqual(h.events,[['open','m-distribute'],['close','m-distribute'],['distribute','g']]);
});
test('a distribution with no pending accounts disables its action',()=>{
 const h=harness();h.context._launchedIds.add('a');h.context.workspaceDistribute('g');
 assert.equal(h.element('distribute-start').disabled,true);
 assert.deepEqual(h.events,[['open','m-distribute']]);
});
test('account row markup does not interpolate user values into executable handlers',()=>{
 const h=harness();const markup=h.context.workspaceAccountRow({id:'a',username:'<script>bad()</script>',nickname:'A" onclick="bad()'});
 assert(!markup.includes('<script>'));assert(markup.includes('&lt;script&gt;'));
 assert(!markup.includes('onclick="bad()'));
 assert(markup.includes('onclick="workspaceRowAction(event)"'));
});
test('the account menu opens the prepared launch preview rather than a stale dialog',()=>{
 const renderer=readFileSync(new URL('../src/renderer.js',import.meta.url),'utf8');
 const code=renderer.slice(renderer.indexOf('function ctxLaunch('),renderer.indexOf('function ctxEdit('));
 const events=[];
 const h=vm.createContext({closeCardMenu:()=>events.push('close'),openLaunch:id=>events.push('preview:'+id)});
 vm.runInContext(code,h);h.ctxLaunch('a');
 assert.deepEqual(events,['close','preview:a']);
});
test('secondary account actions preserve access to servers and the recoverable trash flow',()=>{
 const renderer=readFileSync(new URL('../src/renderer.js',import.meta.url),'utf8');
 const code=renderer.slice(renderer.indexOf('function ctxServers('),renderer.indexOf('function ctxCopyId('));
 const events=[];
 const h=vm.createContext({accounts:[{id:'a',gameTarget:'12345:server-id'}],closeCardMenu(){},openServerList:(place,options)=>events.push(['servers',place,options.accountId,options.placeId]),removeAcc:id=>events.push(['trash',id])});
 vm.runInContext(code,h);h.ctxServers('a');h.ctxRemove('a');
 assert.deepEqual(events,[['servers',12345,'a',12345],['trash','a']]);
});
