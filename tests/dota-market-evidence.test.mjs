import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {f,fixture,now} from './dota-result-fixtures.mjs';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {winnerEvidence}=await import('../lib/dota-market-evidence.ts');
const {settle,latestObservations,validateObservation}=await import('../lib/dota-core.ts');
const {verifiedFirstMap}=await import('../lib/dota-result-source.ts');
const obs=(extra={})=>({observation_id:'winner-1',fixture_id:f.fixture_id,recorded_utc:new Date(now).toISOString(),sources:['https://www.opendota.com/matches/99998000'],...extra});
test('two wins prove only the winner for both a sweep and an incomplete 2:1',()=>{
  for(const wins of [[false,false],[false,true,false],[true,false,true]]){
    const {maps}=fixture(wins),e=winnerEvidence(f,maps.length===3?[maps[0],maps[2]]:maps,now);
    assert.equal(e.winner,wins[0]?'a':'b');assert.equal(e.score,undefined);
    const o=obs({series_winner:e.winner});
    assert.equal(settle({...f,selection:e.winner},o).status,'won');
    assert.equal(settle({...f,selection:e.winner==='a'?'b':'a'},o).status,'lost');
    for(const selection of ['a','b'])for(const threshold of [-1.5,1.5])assert.equal(settle({...f,market:'map_handicap',selection,threshold},o).status,'pending');
  }
});
test('winner proof requires one unambiguous finished BO3, not names or a count across series',()=>{
  const {maps}=fixture();
  assert.equal(winnerEvidence(f,[maps[0]],now),null);
  assert.equal(winnerEvidence(f,[maps[0],maps[0]],now),null);
  assert.equal(winnerEvidence(f,fixture([true,false]).maps,now),null);
  for(const change of [{series_id:444},{series_type:2},{radiant_team_id:'555'},{context_conflict:'conflict'},{start_time:maps[0].start_time+100,end_time:maps[0].start_time+2500}])assert.equal(winnerEvidence(f,[maps[0],{...maps[1],...change}],now),null);
  assert.equal(winnerEvidence({...f,best_of:2},maps,now),null);
  assert.equal(winnerEvidence(f,maps,maps[1].start_time*1000),null);
  assert.equal(winnerEvidence(f,[...maps,{...maps[0],radiant_win:true}],now),null);
  assert.equal(winnerEvidence(f,fixture([true,true,false]).maps,now),null);
  assert.equal(winnerEvidence({...f,team_a:'New name'},maps,now).winner,'b');
});
test('later full score settles handicaps without changing already known winner',()=>{
  const w=obs({series_winner:'b'}),s=obs({observation_id:'score-2',supersedes:w.observation_id,series_score:[1,2]});
  const merged=latestObservations([w,s]).get(f.fixture_id);
  assert.equal(settle(f,merged).status,'won');assert.equal(merged.series_winner,'b');
  assert.equal(settle({...f,market:'map_handicap',selection:'b',threshold:-1.5},merged).status,'lost');
  assert.equal(settle({...f,market:'map_handicap',selection:'a',threshold:1.5},merged).status,'won');
});
test('first-map totals are independent of series, missing other map and opponent winner',()=>{
  const x=fixture([false,true,false]),map1=verifiedFirstMap(x.row,x.page,f,[x.maps[0]],now);
  const o=obs({map1});
  assert.equal(settle(f,o).status,'pending');
  assert.equal(settle({...f,market:'map_kills',map_number:1,selection:'over',threshold:59.5},o).status,'won');
  assert.equal(settle({...f,market:'map_duration',map_number:1,selection:'under',threshold:2460},o).status,'won');
  assert.equal(settle({...f,market:'map_duration',map_number:2,selection:'under',threshold:2460},o).status,'pending');
  assert.throws(()=>verifiedFirstMap(x.row,x.page,f,[x.maps[1]],now));
  assert.throws(()=>verifiedFirstMap(x.row,x.page,f,[x.maps[0]],x.maps[0].start_time*1000));
});
test('winner validation, corrections, void and invalid BO2 proof',()=>{
  const w=obs({series_winner:'b'}),fixtures=new Map([[f.fixture_id,f]]);
  assert.equal(validateObservation(w,fixtures,now).series_winner,'b');
  for(const fields of [{series_winner:'x'},{series_winner:'b',series_void:true},{series_winner:'b',series_score:[2,0]}])assert.throws(()=>validateObservation(obs(fields),fixtures,now));
  assert.throws(()=>validateObservation(w,new Map([[f.fixture_id,{...f,best_of:2}]]),now));
  const corrected=latestObservations([w,obs({observation_id:'correction',supersedes:w.observation_id,series_score:[2,1]})]).get(f.fixture_id);
  assert.equal(corrected.series_winner,'a');assert.equal(settle(f,corrected).status,'lost');
  const voided=latestObservations([w,obs({observation_id:'void',supersedes:w.observation_id,series_void:true})]).get(f.fixture_id);
  assert.equal(voided.series_winner,null);assert.equal(settle(f,voided).status,'void');
});
