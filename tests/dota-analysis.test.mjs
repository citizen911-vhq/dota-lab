import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,nextResolve){
  try{return nextResolve(specifier,context);}catch(error){
    if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!/\.[a-z]+$/.test(specifier))return nextResolve(specifier+'.ts',context);
    throw error;
  }
}});
const {buildForecasts,buildTeamRatings,analyzeMatchup,sampleTeam,TRACKED_TEAMS}=await import('../lib/dota-analysis.ts');
import {evaluateValue,valuePolicy} from '../lib/dota-value.ts';

const now=Date.parse('2026-11-14T00:00:00Z');
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

test('bet recalculation uses new completed history without rewriting preliminary forecast',async()=>{
  const {recalculateBetForecast,checkedBetSnapshot}=await import('../lib/dota-bet-recalculation.ts');
  const original=buildForecasts(history,fixture,now).forecasts[0];
  const before=structuredClone(original);
  const updated={...history,maps:[...history.maps,...map(9904,'99',false,3)]};
  const final=recalculateBetForecast(original,updated,fixture,now+1000);
  assert.deepEqual(original,before);
  assert.equal(final.forecast_id,original.forecast_id);
  assert.equal(final.n_maps_a,4);
  assert.notEqual(final.probability,original.probability);
  assert.equal(final.preliminary_probability,original.probability);
  assert.equal(checkedBetSnapshot(original,final,now+1000),final);
  assert.throws(()=>checkedBetSnapshot(original,{...final,selection:'wrong'},now+1000));
  assert.throws(()=>checkedBetSnapshot(original,final,now+601001));
  assert.throws(()=>recalculateBetForecast(original,{maps:[],series:[]},fixture,now));
  assert.throws(()=>recalculateBetForecast(original,updated,fixture,Date.parse(fixture.scheduled_start_utc)));
});

test('forecast horizon includes 144 hours exactly and excludes later starts',()=>{
  assert.equal(buildForecasts(history,{...fixture,scheduled_start_utc:new Date(now+144*3600000).toISOString()},now).skip_reason,null);
  assert.match(buildForecasts(history,{...fixture,scheduled_start_utc:new Date(now+144*3600000+1).toISOString()},now).skip_reason,/144/);
});

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

test('September history keeps a rolling latest 30 completed maps',()=>{
  const start=Date.parse('2026-08-31T15:00:00Z')/1000;
  const rows=Array.from({length:32},(_,i)=>map(9700+i,'99',true,0).map(m=>({...m,start_time:start+i*86400})));
  const old=map(9699,'99',true,0).map(m=>({...m,start_time:start-1}));
  const h={maps:[...old,...rows.flat()],series:[]};
  const first=sampleTeam(h,a.id,(start+30*86400)*1000,'99');
  assert.equal(first.maps.length,30);
  assert.equal(first.maps.at(-1).match_id,'9700');
  const next=sampleTeam(h,a.id,(start+31*86400)*1000,'99');
  assert.equal(next.maps.length,30);
  assert.equal(next.maps[0].match_id,'9730');
  assert.equal(next.maps.at(-1).match_id,'9701');
});

test('each team keeps its own window even when the opponent played 30 newer maps',()=>{
  const shared=map(9500,'99',true,0).map(m=>({...m,start_time:now/1000-40*86400}));
  const newer=Array.from({length:30},(_,i)=>map(9501+i,'99',true,0).map(m=>({...m,
    team_id:m.team_id===a.id?b.id:'999',opponent_team_id:m.opponent_team_id===b.id?'999':b.id,
    start_time:now/1000-(31-i)*86400})));
  const h={maps:[...shared,...newer.flat()],series:[]};
  const ratings=buildTeamRatings(h,now,'99');
  assert.equal(ratings.find(r=>r.team_id===a.id).maps,1);
  assert.equal(ratings.find(r=>r.team_id===b.id).maps,30);
  assert.ok(ratings.every(r=>r.maps<=30));
  const m=analyzeMatchup(h,a.id,b.id,now,'99');
  assert.deepEqual(m.form.team_a,{maps:1,wins:1,losses:0,win_rate:1});
  assert.equal(m.head_to_head.current_patch.maps,1);
  const reversed=analyzeMatchup(h,b.id,a.id,now,'99');
  assert.ok(Math.abs(m.map_win_probability_a+reversed.map_win_probability_a-1)<1e-12);
  assert.deepEqual(buildTeamRatings({...h,maps:[...h.maps,...h.maps]},now,'99'),ratings);
});

test('missing mirrored map number does not discard a valid result, contradictory numbers do',()=>{
  const rows=map(9400,'99',true,0);
  const h={maps:[rows[0],{...rows[1],map_number:undefined}],series:[]};
  assert.equal(buildTeamRatings(h,now,'99').find(r=>r.team_id===a.id).maps,1);
  assert.equal(buildTeamRatings({maps:[rows[0],{...rows[1],map_number:2}],series:[]},now,'99').find(r=>r.team_id===a.id).maps,0);
});

test('one current-patch map is enough to calculate, and no old map is borrowed',()=>{
  const tiny={maps:map(9901,'99',true,0),series:[]};
  assert.equal(buildForecasts(tiny,fixture,now).skip_reason,null);
  const onlyOld={maps:map(9801,'98',true,0),series:[]};
  assert.match(buildForecasts(onlyOld,fixture,now).skip_reason,/текущем патче/);
});

test('lineup changes and missing evidence only add notices, with identical probabilities and samples',()=>{
  const base=buildForecasts(history,fixture,now);
  for(const changedHistory of [history,{...history,maps:history.maps.map(m=>({...m,players:[1,2,3,4,5]}))},{...history,maps:history.maps.map(m=>({...m,players:undefined}))}]) {
    for(const f of [fixture,{...fixture,rosters:undefined},{...fixture,rosters:{...fixture.rosters,team_a:{...fixture.rosters.team_a,has_standin:true}}}]) {
      const result=buildForecasts(changedHistory,f,now);
      assert.equal(result.skip_reason,null);
      assert.deepEqual(result.forecasts.map(r=>r.probability),base.forecasts.map(r=>r.probability));
      assert.deepEqual(result.forecasts[0].input_sample.team_a_match_ids,base.forecasts[0].input_sample.team_a_match_ids);
      assert.ok(result.forecasts.every(r=>r.betting_eligible&&r.roster_policy==='informational-v1'&&r.model_version==='prematch-elo-v4'));
      assert.ok(result.forecasts[0].roster_warnings.length);
    }
  }
});

test('BO2 keeps the draw and uses a two-map score distribution',()=>{
  const result=buildForecasts(history,{...fixture,best_of:2},now);
  assert.equal(result.skip_reason,null);
  assert.ok(result.forecasts.every(f=>f.best_of===2));
  assert.deepEqual(Object.keys(result.forecasts[0].series_score_distribution),['2:0','1:1','0:2']);
  assert.ok(result.forecasts[0].series_score_distribution['1:1']>0);
  const winners=result.forecasts.filter(f=>f.market==='series_winner');
  assert.ok(winners[0].probability+winners[1].probability<1);
});

test('value gate prefers 1.8, permits fallback to 1.7, and keeps conservative expected return',()=>{
  const policy=valuePolicy();assert.equal(policy.min_odds,1.7);
  assert.equal(evaluateValue(.65,1.69,policy).eligible,false);
  assert.equal(evaluateValue(.65,1.7,policy).eligible,true);
  assert.equal(evaluateValue(.6,1.8,policy).eligible,false);
  assert.equal(evaluateValue(.62,1.8,policy).eligible,true);
  assert.ok(Math.abs(evaluateValue(.62,1.8,policy).conservative_ev-.062)<1e-12);
});
