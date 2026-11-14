import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {base,now,f,fixture,html,raw} from './dota-result-fixtures.mjs';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {verifiedResult,fetchHawk,hawkProps,resultRows,resultUrl}=await import('../lib/dota-result-source.ts');
const {recoverResultMaps}=await import('../lib/dota-result-recovery.ts');
const {firstMapEvidence}=await import('../lib/dota-auto-core.ts');

test('completed sweep has independently verified score, Valve map IDs and exact map order',()=>{
  const {maps,row,page}=fixture();const proof=verifiedResult(row,page,f,maps,now);
  assert.deepEqual(proof.score,[0,2]);assert.deepEqual(proof.map_ids,maps.map(m=>m.id));
  assert.equal(proof.team_a_id,'7119388');assert.notEqual(proof.team_a_id,String(row.team1.id));
  assert.deepEqual(verifiedResult(row,page,{...f,team_a:f.team_b,team_b:f.team_a,team_a_id:f.team_b_id,team_b_id:f.team_a_id},maps,now).score,[2,0]);
});
test('every map in a 2:1 must be present, not just two winning maps',()=>{
  const {maps,row,page}=fixture([false,true,false]);
  assert.deepEqual(verifiedResult(row,page,f,maps,now).score,[1,2]);
  assert.throws(()=>verifiedResult(row,page,f,[maps[0],maps[2]],now),/догрузка/);
  assert.deepEqual(firstMapEvidence(f,maps,now),{match_id:maps[0].id,kills_a:20,kills_b:40,duration_seconds:2400});
  assert.ok(firstMapEvidence({...f,team_a:'Renamed Spirit'},maps,now),'Valve ID overrides display name');
  assert.equal(firstMapEvidence({...f,team_a_id:'999'},maps,now),null,'Matching name cannot override wrong ID');
});
for(const [label,change] of [
  ['wrong Valve ID',x=>x.maps[0].radiant_team_id='999'],
  ['wrong player',x=>x.page.seriesPageData.matches[0].picks[0].player.id=999],
  ['wrong duration',x=>x.page.seriesPageData.matches[0].states[0].gameTime++],
  ['missing public map',x=>x.page.seriesPageData.matches.pop()],
  ['live score',x=>x.row.team2Score=1],
  ['wrong map order',x=>x.page.seriesPageData.matches[0].number=2],
  ['conflicting facts',x=>x.maps[0].context_conflict='conflict'],
  ['different Valve series',x=>x.maps[0].series_id++],
  ['mismatched page',x=>x.page.seriesPageData.id++],
  ['extra Valve map',x=>x.maps.push({...x.maps[0],id:'99999999',match_id:'99999999',start_time:base/1000+7200,end_time:base/1000+9600})],
])test('never settle with '+label,()=>{const x=fixture();change(x);assert.throws(()=>verifiedResult(x.row,x.page,f,x.maps,now));});
test('map names are only a double check, IDs and facts determine identity',()=>{
  const x=fixture();x.maps[0].radiant_name='New display name';
  assert.deepEqual(verifiedResult(x.row,x.page,f,x.maps,now).score,[0,2]);
});
test('public HTML adapter parses only expected data, validates URLs and never retries 403',async()=>{
  const x=fixture();const props={seriesResultsByChampionships:[{seriesResults:[x.row]}]};
  assert.deepEqual(resultRows(hawkProps(html(props))),[x.row]);
  assert.throws(()=>resultUrl({championship:{}}));assert.throws(()=>hawkProps('<html>Challenge</html>'));
  let calls=0;await assert.rejects(fetchHawk(resultUrl(x.row),async()=>{calls++;return new Response('',{status:403});}),/HTTP 403/);assert.equal(calls,1);
  await assert.rejects(fetchHawk('https://evil.test/',()=>{throw new Error('must not fetch');}),/URL/);
});
test('recovery reads both teams plus league index to restore missing middle map',async()=>{
  const {maps}=fixture([false,true,false]),calls=[];
  const fetcher=async(url,options)=>{calls.push(url);assert.equal(options.headers.Authorization,'Bearer test-key');
    if(url.includes('/teams/'))return Response.json([]);
    if(url.includes('/leagues/'))return Response.json(maps.map(raw));
    return Response.json(raw(maps[1]));
  };
  const result=await recoverResultMaps([f],[maps[0],maps[2]],[],'test-key',24,now,fetcher);
  assert.deepEqual(result.matches.map(m=>m.id),[maps[1].id]);assert.equal(result.queue.length,0);assert.equal(calls.length,4);
});
test('limit leaves explicit queue and resumes; unrelated fixture queue survives',async()=>{
  const {maps}=fixture(),q={id:maps[0].id,rows:[raw(maps[0])],sources:['https://api.opendota.com/api/leagues/20486/matches']},other={id:'888',rows:[{...raw(maps[0]),match_id:888,radiant_team_id:111}],sources:q.sources};
  const limited=await recoverResultMaps([f],[],[q,other],undefined,0,now,()=>{throw new Error('no budget');});
  assert.equal(limited.requests,0);assert.equal(limited.queue.length,2);
  const next=await recoverResultMaps([f],[],limited.queue,undefined,24,now,async url=>Response.json(url.includes('/matches/')?raw(maps[0]):[]));
  assert.equal(next.matches.length,1);assert.deepEqual(next.queue.map(q=>q.id),['888']);
});
test('rate limit and denied access stop collection without discarding queue',async()=>{
  const {maps}=fixture(),q={id:maps[0].id,rows:[raw(maps[0])],sources:['https://api.opendota.com/api/leagues/20486/matches']};
  for(const status of [401,403,429]){let calls=0;const result=await recoverResultMaps([f],[],[q],undefined,24,now,async()=>{calls++;return new Response('',{status});});assert.equal(calls,1);assert.equal(result.queue.length,1);}
});
