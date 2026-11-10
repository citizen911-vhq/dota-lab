import test from 'node:test';
import assert from 'node:assert/strict';
import {buildForecasts,buildTeamRatings,analyzeMatchup,sampleTeam,TRACKED_TEAMS} from '../lib/dota-analysis.ts';
import {evaluateValue,valuePolicy} from '../lib/dota-value.ts';

const now=Date.parse('2026-11-09T12:00:00Z');
const [a,b]=[TRACKED_TEAMS[0],TRACKED_TEAMS[4]];
const roster=(t)=>({account_ids:t.reference_roster,verified_at:new Date(now-60_000).toISOString(),source_url:'https://cyberscore.live/en/matches/',has_standin:false});
const fixture={team_a_id:a.id,team_b_id:b.id,scheduled_start_utc:new Date(now+3600_000).toISOString(),source_url:'https://cyberscore.live/en/matches/',best_of:3,status:'scheduled',verified_at:new Date(now-60_000).toISOString(),patch_id:'99',rosters:{team_a:roster(a),team_b:roster(b)}};
const map=(id,patch,win,index)=>{
  const common={match_id:String(id),start_time:Math.floor((now-(8-index)*3600_000)/1000),duration_seconds:2400,league_id:'1',series_id:String(id),series_type:1,series_key:`1:${id}`,patch_id:patch,map_number:1,sources:[`https://www.opendota.com/matches/${id}`]};
  return [
    {...common,team_id:a.id,team:a.name,opponent_team_id:b.id,opponent:b.name,team_kills:win?30:20,opponent_kills:win?20:30,win,players:a.reference_roster},
    {...common,team_id:b.id,team:b.name,opponent_team_id:a.id,opponent:a.name,team_kills:win?20:30,opponent_kills:win?30:20,win:!win,players:b.reference_roster},
  ];
};
const history={maps:[...map(9901,'99',true,0),...map(9902,'99',true,1),...map(9903,'99',false,2)],series:[]};

test('only current patch enters the 30-map sample, rating, and probability',()=>{
  const previous={maps:[...history.maps,...map(9801,'98',false,3),...map(9802,'98',false,4)],series:[]};
  const left=buildForecasts(history,fixture,now),right=buildForecasts(previous,fixture,now);
  assert.equal(left.skip_reason,null);assert.equal(left.forecasts.length,20);
  assert.deepEqual(left.forecasts.map(f=>f.probability),right.forecasts.map(f=>f.probability));
  assert.ok(left.forecasts.every(f=>f.patch_id==='99'&&!f.selected&&f.betting_eligible));
  assert.equal(sampleTeam(previous,a.id,now,'99',a.reference_roster).maps.length,3);
  assert.equal(right.forecasts[0].matchup_analysis.head_to_head.current_patch.maps,3);
  assert.equal(right.forecasts[0].matchup_analysis.head_to_head.historical_context.maps,2);
});

test('mirrored team rows count each map once and rating reflects opponent-adjusted results',()=>{
  const ratings=buildTeamRatings(history,now,'99');
  assert.equal(ratings.find(r=>r.team_id===a.id).maps,3);
  assert.equal(ratings.find(r=>r.team_id===b.id).maps,3);
  assert.equal(analyzeMatchup(history,a.id,b.id,now,'99').head_to_head.current_patch.wins_a,2);
  assert.ok(ratings.find(r=>r.team_id===a.id).rating>ratings.find(r=>r.team_id===b.id).rating);
});

test('one current-patch map is enough to calculate, and no old map is borrowed',()=>{
  const tiny={maps:map(9901,'99',true,0),series:[]};
  assert.equal(buildForecasts(tiny,fixture,now).skip_reason,null);
  const onlyOld={maps:map(9801,'98',true,0),series:[]};
  assert.match(buildForecasts(onlyOld,fixture,now).skip_reason,/текущем патче/);
});

test('lineup change, stand-in or missing proof blocks new forecast',()=>{
  const changed={maps:[...history.maps,...map(9904,'99',true,7).map(m=>m.team_id===a.id?{...m,players:[1,2,3,4,5]}:m)],series:[]};
  assert.match(buildForecasts(changed,fixture,now).skip_reason,/состав/);
  assert.match(buildForecasts(history,{...fixture,rosters:undefined},now).skip_reason,/состав/);
  assert.match(buildForecasts(history,{...fixture,rosters:{...fixture.rosters,team_a:{...fixture.rosters.team_a,has_standin:true}}},now).skip_reason,/состав/);
});

test('value gate uses 1.8 floor and conservative expected return',()=>{
  const policy=valuePolicy();assert.equal(policy.min_odds,1.8);
  assert.equal(evaluateValue(.6,1.79,policy).eligible,false);
  assert.equal(evaluateValue(.6,1.8,policy).eligible,false);
  assert.equal(evaluateValue(.62,1.8,policy).eligible,true);
  assert.ok(Math.abs(evaluateValue(.62,1.8,policy).conservative_ev-.062)<1e-12);
});
