import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../src/game-picker.js',import.meta.url),'utf8');
function harness(extra={}) {
  const context=vm.createContext({URL,Promise,Date,Map,Set,...extra});
  vm.runInContext(source,context);return context;
}
test('game destinations accept IDs, explicit servers and private Roblox links',()=>{
  const h=harness();
  for(const target of ['123','123:job-id','123,job-id','https://www.roblox.com/games/123/Title?privateServerLinkCode=private','https://www.roblox.com/share?code=private&type=Server','https://www.roblox.com/games/start?placeId=123']) assert(h.validGameTarget(target),target);
  for(const target of ['', '0','-1','abc','https://example.com/games/123','https://roblox.com.evil.com/games/123','javascript:alert(1)','https://www.roblox.com/users/123','https://www.roblox.com/share?code=private','999999999999999999999999']) assert(!h.validGameTarget(target),target);
});
test('catalog requests share pending work across the page and account picker',async()=>{
  let calls=0,resolve;
  const h=harness({fetchRobloxGamesUncached:()=>{calls++;return new Promise(r=>resolve=r);}});
  const a=h.fetchRobloxGames('popular'),b=h.fetchRobloxGames('popular');
  await Promise.resolve(); assert.equal(calls,1);
  resolve([{placeId:123}]);assert.deepEqual(await a,await b);
  await h.fetchRobloxGames('popular');assert.equal(calls,1);
});
test('a failed catalog request can be retried and is not cached as success',async()=>{
  let calls=0;const h=harness({searchRobloxGamesUncached:async()=>{if(++calls===1)throw Error('offline');return [];}});
  await assert.rejects(h.searchRobloxGames('Example'));
  await h.searchRobloxGames('example');assert.equal(calls,2);
});
test('destination persistence only updates successful accounts and reports failed IDs for retry',async()=>{
  const accounts=[{id:'one',gameTarget:'old-1'},{id:'two',gameTarget:'old-2'}];
  const cache={one:'Old One',two:'Old Two'},calls=[];
  const h=harness({accounts,_gameNameCache:cache,api:{updateAccount:async(id,data)=>{calls.push([id,data.gameTarget]);if(id==='two')throw Error('disk full');return {id,...data};}}});
  const result=await h.saveGameDestinations(['one','two','deleted'],'123');
  assert.equal(result.ok,1);assert.deepEqual([...result.failed],['two','deleted']);
  assert.equal(accounts[0].gameTarget,'123');assert.equal(accounts[1].gameTarget,'old-2');
  assert.equal(cache.one,undefined);assert.equal(cache.two,'Old Two');
  assert.deepEqual(calls,[['one','123'],['two','123']]);
});

test('backend null or negative acknowledgement does not change the account destination',async()=>{
  for (const response of [null,{ok:false}]) {
    const accounts=[{id:'one',gameTarget:'old'}];
    const h=harness({accounts,_gameNameCache:{},api:{updateAccount:async()=>response}});
    const result=await h.saveGameDestinations(['one'],'123');
    assert.equal(result.ok,0);assert.equal(accounts[0].gameTarget,'old');
  }
});

test('late search responses cannot overwrite newer picker results',async()=>{
  const elements=new Map();
  const get=id=>{
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,replaceChildren(){this.innerHTML='';},setAttribute(){},querySelectorAll(){return [];}});
    return elements.get(id);
  };
  let oldResolve;
  const h=harness({document:{getElementById:get,querySelectorAll:()=>[]},t:key=>key,esc:String,allCharts:{},_favGames:new Set(),_gameKey:g=>g.placeId,
    searchRobloxGamesUncached:q=>q==='old' ? new Promise(r=>oldResolve=r) : Promise.resolve([{placeId:222,name:'New result'}])});
  vm.runInContext('_gamePicker={sequence:0,games:[],target:"",favorites:false}',h);
  get('game-picker-search').value='old';const old=h.loadGamePicker();await Promise.resolve();
  get('game-picker-search').value='new';await h.loadGamePicker();
  oldResolve([{placeId:111,name:'Old result'}]);await old;
  assert(get('game-picker-grid').innerHTML.includes('New result'));
  assert(!get('game-picker-grid').innerHTML.includes('Old result'));
});

for (const saved of [true,false]) test(`group picker ${saved ? 'saves only the group destination' : 'stays open for retry after a rejected save'}`,async()=>{
  const elements=new Map(),writes=[],closed=[];
  const get=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,querySelectorAll:()=>[]});
    return elements.get(id);
  };
  const h=harness({document:{getElementById:get,querySelectorAll:()=>[]},clearTimeout(){},t:key=>key,toast(){},
    workspaceSaveGroup:async(id,patch)=>{writes.push([id,patch.link]);return saved;},
    api:{updateAccount(){throw Error('Group picker must not change individual accounts');}},
    closeModal:id=>closed.push(id)});
  vm.runInContext('_gamePicker={groupId:"g",target:"123",sequence:0,games:[],busy:false}',h);
  await h.applyGamePicker();
  assert.deepEqual(writes,[['g','123']]);
  assert.deepEqual(closed,saved ? ['m-game-picker'] : []);
  assert.equal(get('game-picker-apply').disabled,false);
  assert.equal(vm.runInContext('_gamePicker.busy',h),false);
  if(!saved)assert.equal(get('game-picker-status').textContent,'rework.saveError');
});
