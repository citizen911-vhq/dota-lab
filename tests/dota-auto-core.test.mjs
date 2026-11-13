import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// The application uses bundler-style extensionless TypeScript imports. Keep
// this test resolver local to Node rather than changing production imports.
registerHooks({resolve(specifier,context,nextResolve){
  try{return nextResolve(specifier,context);}catch(error){
    if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!/\.[a-z]+$/.test(specifier))return nextResolve(specifier+'.ts',context);
    throw error;
  }
}});
const {checkedFixture,knownFixture,historyFromMatches,firstMapEvidence,rosterAlerts,confirmSeries,mergeVerifiedSeries}=await import('../lib/dota-auto-core.ts');

const start=Date.parse('2026-11-08T10:00:00Z')/1000;
const now=Date.parse('2026-11-08T16:00:00Z');
const players={radiant:['1','2','3','4','5'],dire:['6','7','8','9','10']};
const forecast={fixture_id:'test-fixture',team_a:'Power Rangers',team_b:'Xipto Esports',scheduled_start_utc:new Date(start*1000).toISOString()};
const match=(index,win=true,extra={})=>({id:String(9900000000+index),match_id:String(9900000000+index),start_time:start+index*3600,end_time:start+index*3600+2000,duration_seconds:2000,radiant_team_id:'55',dire_team_id:'10242397',radiant_kills:30,dire_kills:20,radiant_win:win,series_id:123456,series_type:1,league_id:'20511',players,sources:['https://api.opendota.com/api/matches/'+(9900000000+index)],...extra});
const three=()=>[match(0,true),match(1,false),match(2,true)];
const empty={maps:[],series:[]};
const observation=(extra={})=>({observation_id:'obs-1',fixture_id:'test-fixture',recorded_utc:new Date(now).toISOString(),sources:['https://cyberscore.live/en/matches/test-123/'],series_score:[2,1],map1:{match_id:'9900000000',kills_a:30,kills_b:20,duration_seconds:2000},...extra});
const journal=(observations=[])=>({forecasts:[forecast],observations,teams:[],metadata:{},protocol:{}});

test('only three distinct, sequential BO3 maps establish first-map evidence',()=>{
  const maps=three();
  assert.deepEqual(firstMapEvidence(forecast,maps,now),{match_id:'9900000000',kills_a:30,kills_b:20,duration_seconds:2000});
  assert.equal(firstMapEvidence(forecast,maps.slice(0,2),now),null);
  assert.equal(firstMapEvidence(forecast,[match(0),match(1)],now),null,'Two wins do not prove a sweep');
  assert.equal(firstMapEvidence(forecast,[match(0),match(1),match(2,false)],now),null,'A BO3 cannot continue after an early sweep');
  assert.equal(firstMapEvidence(forecast,[match(0),match(1,false,{series_type:2}),match(2)],now),null);
  assert.equal(firstMapEvidence(forecast,[...maps,match(3,false,{series_id:654321})],now),null,'Ambiguous same-pair series stay pending');
});

test('first map keeps team orientation and rejects overlaps, future maps and remakes',()=>{
  const maps=three();maps[0]=match(0,false,{radiant_team_id:'10242397',dire_team_id:'55',radiant_kills:11,dire_kills:44});
  assert.equal(firstMapEvidence(forecast,maps,now).kills_a,44);
  assert.equal(firstMapEvidence(forecast,maps,now).kills_b,11);
  assert.equal(firstMapEvidence(forecast,[match(0),match(1,false,{start_time:start+1,end_time:start+2001}),match(2)],now),null);
  assert.equal(firstMapEvidence(forecast,three(),(start+2*3600+1000)*1000),null);
  assert.equal(firstMapEvidence(forecast,[match(0,true,{id:'9074604699',match_id:'9074604699'}),match(1,false),match(2)],now),null);
});

test('duplicate discovery is idempotent; conflicting copies do not settle a map',()=>{
  const maps=three();
  assert.deepEqual(firstMapEvidence(forecast,[...maps,maps[0]],now),firstMapEvidence(forecast,maps,now));
  assert.equal(firstMapEvidence(forecast,[...maps,{...maps[0],radiant_kills:99}],now),null);
  const h=historyFromMatches(empty,[...maps,maps[0]],journal(),now);
  assert.equal(h.maps.length,6);assert.equal(h.series.length,0);
});

test('new BO3 history requires official score, explicit matching first map, and all results',()=>{
  const maps=three();
  assert.equal(historyFromMatches(empty,maps,journal(),now).series.length,0);
  assert.equal(historyFromMatches(empty,maps,journal([observation({map1:undefined})]),now).series.length,0);
  const h=historyFromMatches(empty,maps,journal([observation()]),now);
  assert.equal(h.series.length,2);
  assert.deepEqual(h.series.map(s=>[s.team_id,s.score_team,s.score_opponent]),[['55',2,1],['10242397',1,2]]);
  assert.ok(h.maps.every(m=>m.verified_at===new Date(now).toISOString()));
  assert.equal(h.series[0].end_time,maps[2].end_time);
  assert.equal(historyFromMatches(empty,maps.slice(0,2),journal([observation()]),now).series.length,0);
  assert.equal(historyFromMatches(empty,maps,journal([observation({series_score:[1,2]})]),now).series.length,0);
});

test('void, mismatched, pre-completion and impossible series results remain excluded',()=>{
  for(const o of [
    observation({map1_void:true}),observation({series_void:true}),
    observation({map1:{match_id:'9900000000',kills_a:999}}),
    observation({map1:{match_id:'9900000001'}}),
    observation({recorded_utc:new Date((start+1000)*1000).toISOString()}),
    observation({recorded_utc:'not-a-date'}),
  ])assert.equal(historyFromMatches(empty,three(),journal([o]),now).series.length,0);
  assert.equal(historyFromMatches(empty,[match(0),match(1),match(2,false)],journal([observation()]),now).series.length,0);
});

test('explicitly verified 2:0 can join history, but cannot by itself prove first-map order',()=>{
  const maps=[match(0),match(1)];
  const h=historyFromMatches(empty,maps,journal([observation({series_score:[2,0]})]),now);
  assert.equal(h.series.length,2);
  assert.equal(firstMapEvidence(forecast,maps,now),null);
});

test('audited exclusions cannot be reintroduced by a later collector or manual result',()=>{
  const completed=historyFromMatches(empty,three(),journal([observation()]),now);
  const excluded={...completed.series[0],complete_bo3:false,excluded_reason:'Conflicting administrative result'};
  const h=historyFromMatches({maps:[],series:[excluded]},three(),journal([observation()]),now);
  assert.deepEqual(h.series,[excluded]);
  const seed={maps:completed.maps.map(m=>({...m,forecast_sample:false})),series:[]};
  assert.equal(historyFromMatches(seed,three(),journal([observation()]),now).series.length,0);
  const remake=match(0,true,{id:'9044544461',match_id:'9044544461'});
  assert.equal(historyFromMatches(empty,[remake],journal(),now).maps.length,0);
});

test('roster checks ignore older evidence and block missing, duplicated or changed players',()=>{
  const baseline={'55':{account_ids:players.radiant,observed_start_time:start},'10242397':{account_ids:players.dire,observed_start_time:start}};
  assert.deepEqual(rosterAlerts([match(0)],baseline,now),{});
  assert.match(rosterAlerts([match(0,true,{players:{...players,radiant:[]}})],baseline,now)['55'],/не подтверждён/);
  assert.match(rosterAlerts([match(0,true,{players:{...players,radiant:['1','1','2','3','4']}})],baseline,now)['55'],/не подтверждён/);
  assert.match(rosterAlerts([match(0,true,{players:{...players,radiant:['11','12','13','14','15']}})],baseline,now)['55'],/отличается/);
  assert.deepEqual(rosterAlerts([match(0,true,{start_time:start-3600,end_time:start-1600,players:{...players,radiant:[]}})],baseline,now),{});
  assert.match(rosterAlerts([match(0),match(1,true,{players:{...players,radiant:[]}})],baseline,now)['55'],/не подтверждён/,'The latest incomplete lineup must not fall back to an older complete roster');
});

test('backfill enriches missing patch and roster only when map facts agree, without altering the seed',()=>{
  const raw=match(0,true,{patch_id:'60'});
  const old=historyFromMatches(empty,[{...raw,patch_id:null,players:{radiant:[],dire:[]}}],journal(),now);
  old.maps[0].forecast_sample=false; // an audit exclusion survives enrichment
  const h=historyFromMatches(old,[raw],journal(),now);
  assert.equal(h.maps.length,2);
  assert.ok(h.maps.every(m=>m.patch_id==='60'&&m.players.length===5));
  assert.equal(h.maps[0].forecast_sample,false);
  assert.ok(old.maps.every(m=>m.patch_id===null&&m.players.length===0));
  assert.deepEqual(historyFromMatches(h,[raw],journal(),now),h);
  for(const delta of [{patch_id:'59'},{radiant_kills:99},{players:{...players,radiant:['11','12','13','14','15']}}]) {
    const changed=historyFromMatches(h,[{...raw,...delta}],journal(),now);
    const a=changed.maps.find(m=>m.team_id==='55');
    assert.equal(a.patch_id,'60');assert.equal(a.team_kills,30);assert.deepEqual(a.players,[1,2,3,4,5]);
    assert.equal(a.forecast_sample,false);assert.match(a.series_excluded_reason,/Противоречие/);
  }
});

test('fixture context preserves historical roster evidence and rejects malformed data',()=>{
  const before=start*1000-3600000;
  const f={team_a_id:'55',team_b_id:'10242397',scheduled_start_utc:new Date(start*1000).toISOString(),verified_at:new Date(before).toISOString(),best_of:3,status:'scheduled',source_url:'https://cyberscore.live/en/matches/test-123/'};
  const proof=(account_ids)=>({account_ids,verified_at:f.verified_at,source_url:f.source_url,has_standin:false});
  const rosters={team_a:proof([1,2,3,4,5]),team_b:proof([6,7,8,9,10])};
  assert.deepEqual(checkedFixture({...f,patch_id:'60',rosters},before).rosters,rosters);
  assert.equal(checkedFixture({...f,patch_id:'60',rosters},before).patch_id,'60');
  assert.equal(checkedFixture(f,before).rosters,undefined,'Schedule discovery can collect fixtures without claiming roster proof');
  assert.ok(checkedFixture({...f,rosters:{...rosters,team_a:{...rosters.team_a,verified_at:new Date(before-7*3600000).toISOString()}}},before).rosters);
  assert.equal(checkedFixture({...f,rosters:{...rosters,team_a:{...rosters.team_a,has_standin:true}}},before).rosters.team_a.has_standin,true,'Keep a stand-in confirmation as informational evidence');
  for(const patch_id of ['7.41','060',-1,null])assert.throws(()=>checkedFixture({...f,patch_id},before));
  for(const delta of [{account_ids:[1,2,3,4,4]},{account_ids:[1,2,3,4]},{account_ids:['1','2','3','4','5']},{has_standin:undefined},{verified_at:new Date(before+1).toISOString()},{source_url:'https://example.com'}]) {
    assert.throws(()=>checkedFixture({...f,rosters:{...rosters,team_a:{...rosters.team_a,...delta}}},before));
  }
  assert.throws(()=>checkedFixture({...f,rosters:{team_a:rosters.team_a}},before));
  assert.throws(()=>checkedFixture({...f,rosters:{team_a:rosters.team_a,team_b:rosters.team_a}},before));
});

test('fixture validation requires supported IDs, fresh source and HTTPS',()=>{
  const before=start*1000-3600000;
  const f={team_a_id:'55',team_b_id:'10242397',scheduled_start_utc:new Date(start*1000).toISOString(),verified_at:new Date(before).toISOString(),best_of:3,status:'scheduled',source_url:'https://cyberscore.live/en/matches/test-123/'};
  assert.equal(checkedFixture(f,before).team_a_id,'55');
  assert.equal(knownFixture({...f,team_a_id:'10242397',team_b_id:'55'},[forecast]),forecast);
  for(const changes of [{team_a_id:'constructor'},{team_b_id:'10291652'},{verified_at:new Date(before+1).toISOString()},{source_url:'http://cyberscore.live/en/matches/'},{source_url:'https://example.com'},{status:'live'},{best_of:1}])assert.throws(()=>checkedFixture({...f,...changes},before));
});

test('fixture validation preserves a verified BO2 format',()=>{
  const before=start*1000-3600000;
  const f={team_a_id:'55',team_b_id:'10242397',scheduled_start_utc:new Date(start*1000).toISOString(),verified_at:new Date(before).toISOString(),best_of:2,status:'scheduled',source_url:'https://cyberscore.live/en/matches/test-bo2/'};
  assert.equal(checkedFixture(f,before).best_of,2);
});

const official=(extra={})=>({team_a_id:'55',team_b_id:'10242397',map_ids:three().map(m=>m.id),score:[2,1],source_url:'https://cyberscore.live/en/matches/test-123/',verified_at:new Date(now).toISOString(),...extra});

test('official evidence confirms 2:1 and 2:0 without needing a saved forecast',()=>{
  const h=historyFromMatches(empty,three(),journal(),now);
  const result=confirmSeries(h,official(),now);
  assert.equal(result.length,2);assert.deepEqual(result.map(s=>[s.score_team,s.score_opponent]),[[2,1],[1,2]]);
  assert.equal(result[0].series_key,'20511:123456');assert.equal(result[0].verified_at,new Date(now).toISOString());
  const sweepHistory=historyFromMatches(empty,[match(0),match(1)],journal(),now);
  const sweep=confirmSeries(sweepHistory,official({score:[2,0],map_ids:['9900000000','9900000001']}),now);
  assert.deepEqual(sweep.map(s=>[s.score_team,s.score_opponent]),[[2,0],[0,2]]);
});

test('all-null series metadata and an untracked opponent can be confirmed and linked',()=>{
  const maps=[match(0,true,{dire_team_id:'999',series_id:null,series_type:null}),match(1,true,{dire_team_id:'999',series_id:null,series_type:null})];
  const h=historyFromMatches(empty,maps,journal(),now);
  assert.equal(h.maps.length,4);
  assert.ok(h.maps.some(m=>m.team_id==='999'&&m.team==='Team 999'&&m.players.length===5),'Keep opponent context for ratings and roster checks');
  const input=official({team_b_id:'999',score:[2,0],map_ids:maps.map(m=>m.id)});
  const confirmation=confirmSeries(h,input,now);
  assert.equal(confirmation[0].series_key,'verified:9900000000-9900000001');
  assert.equal(confirmation[1].team_id,'999');
  const merged=mergeVerifiedSeries(h,confirmation);
  assert.equal(merged.series.length,2);assert.ok(merged.maps.every(m=>m.series_key===confirmation[0].series_key));
  assert.ok(merged.maps.every(m=>m.series_id===null&&m.series_type===null),'Verified linkage must not invent provider metadata');
  assert.deepEqual(merged.maps.map(m=>m.map_number),[1,1,2,2]);
  assert.ok(h.maps.every(m=>m.series_key===null),'Input history remains unchanged');
  assert.deepEqual(mergeVerifiedSeries(merged,confirmation),merged,'Retry is idempotent');
  assert.throws(()=>mergeVerifiedSeries({...h,maps:h.maps.map(m=>({...m,map_number:2}))},confirmation),'An existing conflicting map number cannot be overwritten');
  const reverse=confirmSeries(h,{...input,team_a_id:'999',team_b_id:'55',score:[0,2]},now);
  assert.deepEqual(reverse.map(s=>[s.team_id,s.score_team,s.score_opponent]),[['999',0,2],['55',2,0]]);
});

test('official confirmation rejects stale checks, partial IDs and mismatched order, series or league',()=>{
  const h=historyFromMatches(empty,three(),journal(),now);
  for(const changes of [
    {map_ids:['9900000000','9900000001']},{map_ids:['9900000000','9900000000','9900000002']},
    {map_ids:['9900000001','9900000000','9900000002']},{score:[1,2]},
    {team_b_id:'999'},{source_url:'https://example.com/'},
    {verified_at:new Date(now-7*3600000).toISOString()},
    {verified_at:new Date(now+1).toISOString()},
  ])assert.throws(()=>confirmSeries(h,official(changes),now));
  for(const change of [
    {league_id:'333'},{series_id:'999999'},{series_type:2},{forecast_sample:false},
    {series_excluded_reason:'Administrative conflict'},
    {start_time:start+1,duration_seconds:999999},
  ]){
    const altered={...h,maps:h.maps.map(m=>m.match_id==='9900000001'?{...m,...change}:m)};
    assert.throws(()=>confirmSeries(altered,official(),now));
  }
  const earlySweep=historyFromMatches(empty,[match(0),match(1),match(2,false)],journal(),now);
  assert.throws(()=>confirmSeries(earlySweep,official(),now));
});

test('verified merge rejects conflicts with audited scores, exclusions and map linkage',()=>{
  const h=historyFromMatches(empty,three(),journal(),now);
  const result=confirmSeries(h,official(),now);
  const merged=mergeVerifiedSeries(h,result);
  const changed=result.map(s=>({...s,score_team:s.score_opponent,score_opponent:s.score_team}));
  assert.throws(()=>mergeVerifiedSeries(merged,changed));
  assert.throws(()=>mergeVerifiedSeries(h,[result[0]]));
  const otherKey={...h,maps:h.maps.map(m=>({...m,series_key:'other-series'}))};
  assert.throws(()=>mergeVerifiedSeries(otherKey,result));
  const excluded={...h,series:[{...result[0],complete_bo3:false,excluded_reason:'Audit exclusion'}]};
  assert.throws(()=>confirmSeries(excluded,official(),now));
  assert.throws(()=>mergeVerifiedSeries(excluded,result));
});
