import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {expandTeamPool,expansionPool,expansionHistory,expansionGate}=await import('../lib/dota-expansion.ts');
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
 assert.match(expansionGate(s,'901',core,now),/не допущена/);
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
 assert.equal(projected.maps.filter(m=>m.team_id==='901'&&m.forecast_sample!==false).length,15);
});
test('insufficient collection freezes membership and blocks bets, preserving admission history',()=>{
 const first=run(maps('900',core,15));
 const partial=run([],['900'],first,now+day,false);
 assert.deepEqual(partial.active_ids,first.active_ids);
 assert.match(expansionGate(partial,'900',core,now+day),/обновления/);
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
