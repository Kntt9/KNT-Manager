import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/renderer.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function accountUiState('),source.indexOf('function refreshAccountStatuses('));
function harness(){
 const context=vm.createContext({_launchedIds:new Set(),_homeIds:new Set(),_cookieStatus:{},_launchingId:null,_pkgLaunchJobs:new Map(),t:key=>key});
 vm.runInContext(code+'\nglobalThis.stateFor=accountUiState',context);
 return context;
}
test('idle, active, home and unavailable states use actual local state',()=>{
 const h=harness(),account={id:'a'};
 assert.equal(h.stateFor(account).state,'stopped');
 h._launchedIds.add('a');assert.equal(h.stateFor(account).state,'running');
 h._launchedIds.clear();h._homeIds.add('a');assert.equal(h.stateFor(account).state,'home');
 h._homeIds.clear();h._cookieStatus.a='dead';assert.equal(h.stateFor(account).state,'invalid');
});
test('waiting means an actual pending member, not an attempted or cancelled launch',()=>{
 const h=harness(),account={id:'a'};
 const job={members:[account,{id:'b'}],completed:new Set(),currentAccount:'b',cancelled:false};
 h._pkgLaunchJobs.set('g',job);
 assert.equal(h.stateFor(account).state,'waiting');
 job.currentAccount='a';assert.equal(h.stateFor(account).state,'starting');
 job.currentAccount=null;job.completed.add('a');assert.equal(h.stateFor(account).state,'stopped');
 job.completed.clear();job.cancelled=true;assert.equal(h.stateFor(account).state,'stopped');
 h._pkgLaunchJobs.clear();assert.equal(h.stateFor(account).state,'stopped');
});
test('a confirmed process is never displayed as still waiting and the state read is pure',()=>{
 const h=harness(),account={id:'a',username:'Example'};
 const job={members:[account],completed:new Set(),currentAccount:null,cancelled:false};
 h._pkgLaunchJobs.set('g',job);h._launchedIds.add('a');
 assert.equal(h.stateFor(account).state,'running');
 assert.equal(job.completed.size,0);assert.equal(job.currentAccount,null);
 assert.deepEqual(account,{id:'a',username:'Example'});
});
