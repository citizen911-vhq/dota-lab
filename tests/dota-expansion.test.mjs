import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {expandTeamPool,advanceTeamPool,poolWarnings,expansionPool,expansionHistory,expansionGate}=await import('../lib/dota-expansion.ts');
const {PRIMARY_TEAM_POOL}=await import('../lib/dota-team-pool.ts');
const now=Date.parse('2026-11-14T00:00:00Z'),day=86400000,core=PRIMARY_TEAM_POOL[0][0];
const directory=(ids)=>ids.map(id=>({id,name:'Team '+id,tag:null,rating:1000,last_match_time:now/1000-1}));
function maps(team,opponent,count,wins=count,start=now-2*day){
  return Array.from({length:count},(_,i)=>({team_id:team,team:'Team '+team,opponent_team_id:opponent,opponent:'Team '+opponent,match_id:String(Number(team)*1000+i),start_time:start/1000+i*3600,duration_seconds:1800,win:i<wins,patch_id:'99',team_kills:30,opponent_kills:10,league_id:'1',series_id:null,series_type:null,sources:['https://www.opendota.com/matches/1'],forecast_sample:true}));
}
const run=(m,ids=['900'],prior,at=now,healthy=true)=>expandTeamPool({maps:m,series:[]},directory(ids),prior,at,'99',healthy);

test('15 maps admits position 13; 14 maps and poor results do not',()=>{
 const s=run([...maps('900',core,15),...maps('901',core,14),...maps('902',core,15,0)],['900','901','902']);
 assert.equal(s.rows.find(r=>r.team_id==='900').rank,13);
 assert.equal(s.rows.find(r=>r.team_id==='901').status,'insufficient');
 assert.equal(s.rows.find(r=>r.team_id==='902').status,'candidate');
 assert.equal(expansionPool(s).length,13);
 assert.equal(expansionGate(s,'900',core,now),null);
 assert.match(expansionGate(s,'901',core,now),/собственной истории/);
});
test('fixed 12 remain; no more than eight expanded teams and deterministic ordering',()=>{
 const ids=Array.from({length:12},(_,i)=>String(900+i)),m=ids.flatMap(id=>maps(id,core,15));
 const s=run(m,ids);assert.equal(s.active_ids.length,20);
 assert.deepEqual(s.active_ids.slice(0,12),PRIMARY_TEAM_POOL.map(t=>t[0]));
 assert.deepEqual(s,run([...m].reverse(),ids));
});
test('rolling window, current patch, completion time and known-at cutoff exclude leakage',()=>{
 const m=maps('900',core,15);
 const dirty=[...m,...maps('901',core,15,15,now-35*day),...maps('902',core,15).map(m=>({...m,patch_id:'98'})),...maps('903',core,15,15,now),...maps('904',core,15).map(m=>({...m,verified_at:new Date(now+1).toISOString()}))];
 const s=run(dirty,['900','901','902','903','904']);
 assert.deepEqual(s.active_ids,run(m).active_ids);
 assert.throws(()=>run(m,['900'],s,now-1),/Future/);
 assert.equal(run(m,['900'],s,now+31*day).rows.find(r=>r.team_id==='900').status,'watch');
});
test('same-cycle candidate chains and pre-admission games never qualify opponents',()=>{
 const m=[...maps('900',core,15),...maps('901','900',15)];
 const first=run(m,['900','901']);
 assert.ok(first.active_ids.includes('900'));assert.ok(!first.active_ids.includes('901'));
 const later=[...m,...maps('901','900',15,15,now+day).map(m=>({...m,match_id:String(Number(m.match_id)+100)}))];
 const second=run(later,['900','901'],first,now+3*day);
 assert.ok(second.active_ids.includes('901'));
 assert.equal(second.rows.find(r=>r.team_id==='901').maps,15);
 const projected=expansionHistory({maps:later,series:[]},second,now+3*day);
 assert.equal(projected.maps.filter(m=>m.team_id==='901'&&m.forecast_sample!==false).length,30);
 assert.equal(second.rows.find(r=>r.team_id==='901').maps,15,'ranking still excludes pre-admission opponents');
});
test('insufficient collection freezes membership and blocks bets, preserving admission history',()=>{
 const first=run(maps('900',core,15));
 const partial=run([],['900'],first,now+day,false);
 assert.deepEqual(partial.active_ids,first.active_ids);
 assert.match(expansionGate(partial,'900',core,now+day),/базы рейтинга/);
 const demoted=run([],['900'],first,now+day);
 assert.equal(demoted.rows.find(r=>r.team_id==='900').status,'watch');
 assert.equal(demoted.admissions[0].until,new Date(now+day).toISOString());
});
test('duplicate and contradictory maps do not inflate qualifying counts; unknown IDs cannot be admitted',()=>{
 const m=maps('900',core,14),dup=[...m,...m];
 assert.equal(run(dup).rows.find(r=>r.team_id==='900').maps,14);
 const conflict=[...maps('900',core,15),{...maps('900',core,15)[0],win:false}];
 assert.equal(run(conflict).rows.find(r=>r.team_id==='900').maps,14);
 assert.ok(!run(maps('999',core,15),[]).active_ids.includes('999'));
});
test('latest 30 qualifying maps cap, weak-opponent games ignored, older results weighted less',()=>{
 const good=maps('900',core,15,15,now-25*day),bad=maps('900',core,15,0).map(m=>({...m,match_id:String(Number(m.match_id)+100)}));
 const s=run([...good,...bad,...maps('900','888',15).map(m=>({...m,match_id:String(Number(m.match_id)+200)}))]);
 const r=s.rows.find(r=>r.team_id==='900');assert.equal(r.maps,30);assert.equal(r.win_rate,.5);assert.ok(r.score<.5);
});

test('verified opponents may be analysed without promotion; unrelated pairs and stale history stay blocked',()=>{
 const history={maps:maps('900',core,5),series:[]};
 const s=expandTeamPool(history,directory(['900','901']),undefined,now,'99',true,['900','901'],['900','901','999']);
 assert.equal(s.rows.find(r=>r.team_id==='900').maps,5);
 assert.equal(s.rows.find(r=>r.team_id==='900').status,'insufficient');
 assert.equal(s.active_ids.includes('900'),false);
 assert.equal(s.admissions.length,0);
 assert.equal(expansionGate(s,core,'900',now),null);
 assert.equal(expansionGate(s,'900',core,now),null);
 assert.match(expansionGate(s,'900','901',now),/нет команды/);
 assert.match(expansionGate(s,core,'999',now),/Valve ID/);
 assert.match(expansionGate({...s,analysis_team_ids:[]},core,'900',now),/собственной истории/);
 assert.match(expansionGate({...s,healthy:false},core,'900',now),/базы рейтинга/);
 assert.equal(expansionGate(s,core,'900',now+600001),null,'ranking does not expire after ten minutes');
 assert.match(expansionGate(s,core,core,now),/нет команды/);
 const legacy={...s};delete legacy.analysis_team_ids;
 assert.match(expansionGate(legacy,core,'900',now),/собственной истории/);
});

test('prediction sample uses own latest 30 maps since September, not the top-only rolling month',async()=>{
 const {sampleTeam,buildForecasts}=await import('../lib/dota-analysis.ts');
 const frog='10331884';
 const older=maps(frog,'888',35,20,now-40*day);
 const recent=maps(frog,core,5,3).map(m=>({...m,match_id:String(Number(m.match_id)+100)}));
 const dirty=[{...recent[0],match_id:'999001',forecast_sample:false},
   {...recent[0],match_id:'999002',patch_id:'98'},
   {...recent[0],match_id:'999003',start_time:now/1000+100},
   {...recent[0],match_id:'999004',start_time:Date.parse('2026-08-30T00:00:00Z')/1000}];
 const h={maps:[...older,...recent,...dirty,...maps(core,'888',4)],series:[]};
 const s=expandTeamPool(h,directory([frog]),undefined,now,'99',true,[frog],[frog]);
 const projected=expansionHistory(h,s,now),before=JSON.stringify(h);
 const sample=sampleTeam(projected,frog,now,'99');
 assert.equal(s.rows.find(r=>r.team_id===frog).maps,5);
 assert.equal(sample.maps.length,30);
 assert.equal(sample.maps.filter(m=>m.opponent_team_id==='888').length,25);
 assert.ok(sample.maps.every(m=>!m.match_id.startsWith('99900')));
 assert.equal(JSON.stringify(h),before);
 assert.throws(()=>expansionHistory(h,s,now-1),/Future/);
 const fixture={team_a_id:core,team_b_id:frog,best_of:3,status:'scheduled',patch_id:'99',scheduled_start_utc:new Date(now+3600000).toISOString(),verified_at:new Date(now).toISOString(),source_url:'https://dota.haglund.dev/v1/matches'};
 const built=buildForecasts(projected,fixture,now);
 assert.equal(built.skip_reason,null);
 assert.equal(built.forecasts[0].n_maps_b,30);
 assert.ok(buildForecasts({maps:h.maps.filter(m=>m.team_id!==frog),series:[]},fixture,now).skip_reason);
});

test('ranking advances on completed results, not polling, timestamps or directory ratings',async()=>{
 const h={maps:maps('900',core,5),series:[]},dir=directory(['900']);
 const first=await advanceTeamPool(h,dir,undefined,now,'99',true,['900'],['900']);
 assert.equal(first.changed,true);
 const repeat=await advanceTeamPool({...h,maps:[...h.maps,...h.maps].reverse().map(m=>({...m,verified_at:new Date(now+day).toISOString()}))},dir.map(t=>({...t,rating:9999})),first.snapshot,now+day,'99',true,['900'],['900']);
 assert.equal(repeat.changed,false);
 assert.equal(repeat.snapshot.at,first.snapshot.at);
 assert.deepEqual(repeat.snapshot.rows,first.snapshot.rows);
 assert.equal(repeat.snapshot.analysis_verified_at,new Date(now+day).toISOString());
 assert.equal(expansionGate(repeat.snapshot,core,'900',now+day),null);
 const newer={...h.maps[0],match_id:'999999',start_time:(now+day)/1000,duration_seconds:1800};
 const live=await advanceTeamPool({maps:[...h.maps,newer],series:[]},dir,repeat.snapshot,now+day+1000,'99',true,['900'],['900']);
 assert.equal(live.changed,false,'unfinished map cannot change ranking');
 const ended=await advanceTeamPool({maps:[...h.maps,newer],series:[]},dir,live.snapshot,now+day+1800000,'99',true,['900'],['900']);
 assert.equal(ended.changed,true);
 assert.equal(ended.snapshot.rows.find(r=>r.team_id==='900').maps,6);
 const corrected=await advanceTeamPool({maps:[...h.maps,{...newer,win:false}],series:[]},dir,ended.snapshot,now+day+1800001,'99',true,['900'],['900']);
 assert.equal(corrected.changed,true);
 assert.equal(corrected.snapshot.rows.find(r=>r.team_id==='900').wins,5);
});

test('failed collection preserves ranking, blocks analysis, and recovery does not fabricate a ranking event',async()=>{
 const h={maps:maps('900',core,5),series:[]},dir=directory(['900']);
 const first=await advanceTeamPool(h,dir,undefined,now,'99',true,['900'],['900']);
 const failure=await advanceTeamPool({maps:[],series:[]},[],first.snapshot,now+day,'99',false);
 assert.equal(failure.changed,false);
 assert.deepEqual(failure.snapshot.rows,first.snapshot.rows);
 assert.equal(failure.snapshot.at,first.snapshot.at);
 assert.match(expansionGate(failure.snapshot,core,'900',now+day),/проверка истории/);
 const recovery=await advanceTeamPool(h,dir,failure.snapshot,now+day+1000,'99',true,['900'],['900']);
 assert.equal(recovery.changed,false);
 assert.equal(expansionGate(recovery.snapshot,core,'900',now+day+1000),null);
 const patch=await advanceTeamPool(h,dir,recovery.snapshot,now+day+2000,'100',true,['900'],['900']);
 assert.equal(patch.changed,true);
 await assert.rejects(advanceTeamPool(h,dir,patch.snapshot,now,'99',true),/Future/);
});

test('under-15 warning is informational; it does not block a verified opponent or promote it',()=>{
 const h={maps:maps('900',core,5),series:[]};
 const s=expandTeamPool(h,directory(['900']),undefined,now,'99',true,['900'],['900']);
 assert.match(poolWarnings(s,['900'])[0],/нет 15 карт.*5\/15/);
 assert.equal(expansionGate(s,core,'900',now),null);
 assert.equal(s.active_ids.includes('900'),false);
 assert.equal(s.rows.find(r=>r.team_id==='900').status,'insufficient');
 assert.deepEqual(poolWarnings(run(maps('900',core,15)),['900']),[]);
});
