import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const text=fs.readFileSync(new URL('../src/renderer.js',import.meta.url),'utf8');
const source=text.slice(text.indexOf('const _pkgCoverCache'),text.indexOf('// Only plain place IDs'));
function setup(responder){
 const calls=[], nodes=[];
 const h=vm.createContext({Map,Date,Promise, packages:[],t:()=> 'Destinos individuais',esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),document:{getElementById:()=>null,querySelectorAll:()=>nodes},api:{robloxGet:async url=>{calls.push(url);return responder(url);}}});
 vm.runInContext(source,h);return {h,calls,nodes};
}
const good=url=>url.includes('/universe')?{data:{universeId:42}}:url.includes('/v1/games?')?{data:{data:[{id:42,name:'Game <test>'}]}}:{data:{data:[{targetId:42,state:'Completed',imageUrl:'https://tr.rbxcdn.com/example.png'}]}};
test('shared group metadata resolves name and image once without account credentials',async()=>{
 const {h,calls}=setup(good);
 await Promise.all([h.loadPkgCover('a','12345'),h.loadPkgCover('b','12345')]);
 assert.equal(calls.length,3);await h.loadPkgCover('c','12345');assert.equal(calls.length,3);
 const html=h.pkgGameMarkup('12345');assert.match(html,/Game &lt;test>/);assert.match(html,/<img/);assert.doesNotMatch(html,/Place ID/);
});
test('failed lookup has cooldown and never blocks group actions',async()=>{
 const {h,calls}=setup(()=>{throw new Error('offline');});
 await h.loadPkgCover('a','12345');await h.loadPkgCover('b','12345');assert.equal(calls.length,1);assert.match(h.pkgGameMarkup('12345'),/Place ID · 12345/);
});
test('late response cannot replace another destination',async()=>{
 const {h,nodes}=setup(good);const current={dataset:{gamePlace:'67890'},outerHTML:'unchanged'};nodes.push(current);
 await h.loadPkgCover('a','12345');assert.equal(current.outerHTML,'unchanged');
});
test('private share code never becomes an invented place or leaks into fallback',async()=>{
 const {h,calls}=setup(good);await h.loadPkgCover('a','https://www.roblox.com/share?code=SECRET&type=Server');
 assert.equal(calls.length,0);assert.doesNotMatch(h.pkgGameMarkup('https://www.roblox.com/share?code=SECRET'),/SECRET/);
});
test('different games use a serialized metadata queue',async()=>{
 let active=0,max=0;const {h}=setup(async url=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return good(url);});
 await Promise.all([h.loadPkgCover('a','12345'),h.loadPkgCover('b','67890')]);assert.equal(max,1);
});
test('pending thumbnail preserves resolved name and does not trigger immediate retry',async()=>{
 const {h,calls}=setup(url=>url.includes('thumbnails.')?{data:{data:[{targetId:42,state:'Pending',imageUrl:null}]}}:good(url));
 await h.loadPkgCover('a','12345');await h.loadPkgCover('a','12345');assert.equal(calls.length,3);assert.match(h.pkgGameMarkup('12345'),/Game/);assert.doesNotMatch(h.pkgGameMarkup('12345'),/<img/);
});
