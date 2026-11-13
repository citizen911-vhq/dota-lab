import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCurrentPatch,parseCurrentPatch,PATCH_SOURCE_URL} from '../lib/dota-patch.ts';

const now=Date.parse('2026-11-09T12:00:00Z');
const patches=[{id:60,name:'7.41',date:'2026-03-24T00:50:59.580Z'},{id:59,name:'7.40',date:'2025-12-16T00:50:40.281Z'},{id:72,name:'7.42',date:'2026-12-01T00:00:00Z'}];

test('current patch uses explicit ID and release date, not array order/index or a future release',()=>{
  assert.deepEqual(parseCurrentPatch(patches,now),{patch_id:'60',patch_name:'7.41',released_at:'2026-03-24T00:50:59.580Z'});
  assert.equal(parseCurrentPatch(patches.slice().reverse(),now).patch_id,'60');
  assert.deepEqual(parseCurrentPatch([...patches,{id:61,name:'7.41b',date:'2026-11-01T00:00:00Z'}],now),{patch_id:'61',patch_name:'7.41',released_at:'2026-11-01T00:00:00.000Z'});
  assert.equal(parseCurrentPatch(patches,Date.parse('2025-01-01')),null);
  for(const value of [{},[],[{name:'7.41',date:patches[0].date}],patches.map(p=>({...p,id:String(p.id)})),[...patches,patches[0]],patches.map(p=>({...p,date:'invalid'}))])assert.equal(parseCurrentPatch(value,now),null);
});

test('patch request has fixed verified origin, bounded signal and no cache or redirects',async()=>{
  let count=0;
  const result=await fetchCurrentPatch(async(url,options)=>{
    count++;assert.equal(url,PATCH_SOURCE_URL);assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(patches));
  },now);
  assert.equal(count,1);assert.equal(result.patch_id,'60');assert.equal(result.verified_at,new Date(now).toISOString());
  assert.deepEqual(result.warnings,[]);
});

test('unavailable, redirected, malformed and contradictory constants fail closed without guessing patch',async()=>{
  for(const fetchFn of [async()=>new Response(null,{status:302,headers:{Location:'https://example.com'}}),async()=>new Response(null,{status:503}),async()=>new Response('{'),async()=>new Response(JSON.stringify([{id:60,name:'7.41',date:'invalid'}])),async()=>{throw new Error('network');}]) {
    const result=await fetchCurrentPatch(fetchFn,now);
    assert.equal(result.patch_id,null);assert.equal(result.patch_name,null);assert.match(result.warnings.join(' '),/Ставки заблокированы/);
  }
});
