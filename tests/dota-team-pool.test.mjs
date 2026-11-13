import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOpenDotaTeamDirectory,selectTier1Core,frequentTier1CandidateIds,qualifyFrequentTier1Teams} from '../lib/dota-team-pool.ts';
import {primaryTeamPool, PRIMARY_TEAM_POOL} from '../lib/dota-team-pool.ts';

test('primary cohort preserves twelve IDs through rating, name and availability changes',()=>{
  const pool=primaryTeamPool();
  assert.equal(pool.length,12);
  assert.equal(new Set(pool.map(t=>t.id)).size,12);
  assert.ok(pool.some(t=>t.id==='10182357'));
  const directory=[{id:'10182357',name:'Renamed 1win',tag:null,rating:1,last_match_time:1},
    {id:'999',name:'New rating leader',tag:null,rating:99999,last_match_time:2}];
  const updated=primaryTeamPool(directory,pool);
  assert.deepEqual(updated.map(t=>t.id),PRIMARY_TEAM_POOL.map(([id])=>id));
  assert.equal(updated.find(t=>t.id==='10182357').name,'Renamed 1win');
  assert.deepEqual(primaryTeamPool([],updated),updated);
  assert.ok(updated.every(t=>t.qualification==='primary-pool'&&t.tier1_rank===null));
});

const now=2_000_000_000;
test('unrated teams retain their Valve identity without becoming rating-core members',()=>{
  const parsed=parseOpenDotaTeamDirectory([{team_id:123,name:'New team',tag:'NEW',rating:null,last_match_time:null}]);
  assert.equal(parsed[0].id,'123');
  assert.equal(selectTier1Core(parsed,now).length,0);
});
const directory=Array.from({length:15},(_,index)=>({team_id:index+1,name:`Core ${index+1}`,tag:`C${index+1}`,rating:3000-index,last_match_time:now-60}));
directory.push({team_id:99,name:'Frequent challenger',tag:'FC',rating:1800,last_match_time:now-60});
directory.push({team_id:100,name:'Inactive leader',tag:'OLD',rating:9999,last_match_time:now-31*86400});

test('active OpenDota rating creates a dynamic top 15 and ignores inactive teams',()=>{
  const parsed=parseOpenDotaTeamDirectory(directory);
  const core=selectTier1Core(parsed,now);
  assert.equal(core.length,15);
  assert.deepEqual(core.map(team=>team.id),Array.from({length:15},(_,index)=>String(index+1)));
  assert.equal(core[0].tier1_rank,1);
  assert.ok(!core.some(team=>team.id==='100'));
});

test('a team qualifies only with at least 21 of its latest 30 maps against the tier 1 core',()=>{
  const parsed=parseOpenDotaTeamDirectory(directory),core=selectTier1Core(parsed,now);
  const histories=new Map();
  for(const team of core)histories.set(team.id,[]);
  let match=1;
  for(const team of core.slice(0,3))for(let n=0;n<7;n++)histories.get(team.id).push({match_id:match++,start_time:now-match,radiant:true,opposing_team_id:99});
  assert.deepEqual(frequentTier1CandidateIds(core,histories),['99']);
  const recent=[];
  for(let n=0;n<30;n++)recent.push({match_id:10_000+n,start_time:now-n-1,radiant:true,opposing_team_id:n<21?(n%15)+1:500+n});
  histories.set('99',recent);
  const qualified=qualifyFrequentTier1Teams(core,parsed,histories);
  assert.equal(qualified.length,1);
  assert.equal(qualified[0].id,'99');
  assert.equal(qualified[0].tier1_opponent_maps,21);
  histories.set('99',recent.map((row,index)=>index===20?{...row,opposing_team_id:999}:row));
  assert.equal(qualifyFrequentTier1Teams(core,parsed,histories).length,0);
});

test('fewer than 30 recorded maps never satisfies the 70 percent rule',()=>{
  const parsed=parseOpenDotaTeamDirectory(directory),core=selectTier1Core(parsed,now);
  const histories=new Map([['99',Array.from({length:21},(_,index)=>({match_id:20_000+index,start_time:now-index-1,radiant:true,opposing_team_id:(index%15)+1}))]]);
  assert.equal(qualifyFrequentTier1Teams(core,parsed,histories).length,0);
});
