import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildForecasts,fixtureKey,sampleTeam,TRACKED_TEAMS} from '../lib/dota-analysis.ts';
import {validateForecast} from '../lib/dota-core.ts';

const history = JSON.parse(fs.readFileSync(new URL('../data/history-seed.json',import.meta.url),'utf8'));
const journal = JSON.parse(fs.readFileSync(new URL('../data/seed.json',import.meta.url),'utf8'));
const now = Date.parse('2026-11-08T07:00:00Z');
const fixtureFor = (f) => ({fixture_id:f.fixture_id,team_a_id:TRACKED_TEAMS.find(t=>t.name===f.team_a).id,
  team_b_id:TRACKED_TEAMS.find(t=>t.name===f.team_b).id,scheduled_start_utc:f.scheduled_start_utc,
  source_url:'https://cyberscore.live/en/matches/',best_of:3,status:'scheduled',verified_at:new Date(now).toISOString()});
const fixture = fixtureFor(journal.forecasts[0]);
const clone = () => structuredClone(history);

test('audited seed preserves all 215 team rows and 191 unique Valve maps', () => {
  assert.equal(history.maps.length,215);
  assert.equal(new Set(history.maps.map(m=>m.match_id)).size,191);
  assert.equal(history.series.length,94);
});

test('all 120 initial probabilities and the 12 selected picks match baseline-v1', () => {
  const fixtures = [...new Map(journal.forecasts.map(f=>[f.fixture_id,f])).values()];
  const before = JSON.stringify(history);
  for (const f of fixtures) {
    const r = buildForecasts(history,fixtureFor(f),now);
    assert.equal(r.skip_reason,null);
    assert.equal(r.forecasts.length,20);
    for (const actual of r.forecasts) {
      const expected = journal.forecasts.find(f=>f.forecast_id===actual.forecast_id);
      assert.ok(Math.abs(actual.probability-expected.probability)<1e-12,`${actual.forecast_id}: ${actual.probability} vs ${expected.probability}`);
      assert.equal(actual.selected,expected.selected);
      assert.equal(actual.selection_rank,expected.selection_rank);
      assert.equal(actual.n_maps_a,expected.n_maps_a);assert.equal(actual.n_maps_b,expected.n_maps_b);
      assert.equal(actual.n_series_a,expected.n_series_a);assert.equal(actual.n_series_b,expected.n_series_b);
      assert.equal(validateForecast(actual),actual);
    }
    assert.equal(new Set(r.forecasts.filter(f=>f.selected).map(f=>f.family)).size,2);
  }
  assert.equal(JSON.stringify(history),before,'Calculation must not mutate historical evidence');
});

test('maps are completed and known by the cutoff, duplicate discovery does not add samples', () => {
  const h = clone();
  const first = h.maps.find(m=>m.team_id==='55');
  h.maps.push({...first,sources:['https://api.opendota.com/api/proMatches']});
  h.maps.push({...first,match_id:'9900000001',start_time:Math.floor(now/1000)-30,duration_seconds:2460});
  h.maps.push({...first,match_id:'9900000002',verified_at:'2026-11-08T07:01:00Z'});
  const s = sampleTeam(h,'55',now);
  assert.equal(s.maps.length,30);assert.equal(new Set(s.maps.map(m=>m.match_id)).size,30);
  assert.ok(!s.maps.some(m=>m.match_id.startsWith('990')));
});

test('contradictory facts for the same map are excluded, not arbitrarily selected', () => {
  const h = clone();const first=h.maps.find(m=>m.team_id==='55');
  h.maps.push({...first,team_kills:first.team_kills+1});
  const s=sampleTeam(h,'55',now);
  assert.equal(s.maps.length,29);assert.deepEqual(s.conflicting_map_ids,[first.match_id]);
});

test('PlayTime uses six current-roster maps and excludes old tag, alias and unverified new roster', () => {
  const h = clone();const first=h.maps.find(m=>m.team_id==='10020555'&&m.forecast_sample);
  h.maps.push({...first,match_id:'9900000001',team_id:'10207983'});
  h.maps.push({...first,match_id:'9900000002',audit_origin:undefined,players:undefined});
  assert.equal(sampleTeam(h,'10020555',now).maps.length,6);
  h.maps.push({...first,match_id:'9900000003',audit_origin:undefined,players:TRACKED_TEAMS.find(t=>t.id==='10020555').reference_roster});
  assert.equal(sampleTeam(h,'10020555',now).maps.length,7);
});

test('a changed latest roster stops new forecasts, preserving the original baseline cohort', () => {
  const h=clone();const first=h.maps.find(m=>m.team_id==='55');
  h.maps.push({...first,match_id:'9900000001',start_time:Math.floor(now/1000)-4000,players:[1,2,3,4,5],audit_origin:undefined});
  assert.match(buildForecasts(h,fixture,now).skip_reason,/состав/);
});

test('exactly 41:00 belongs to the >=41 event and direction probabilities sum to one', () => {
  const h=clone();
  h.maps=h.maps.map(m=>({...m,duration_seconds:2460}));
  const r=buildForecasts(h,fixture,now);
  const duration=r.forecasts.filter(f=>f.market==='map_duration');
  assert.equal(duration[0].probability,((30+1)/(30+2)+(6+1)/(6+2))/2);
  assert.equal(duration[0].probability+duration[1].probability,1);
  const scores=r.forecasts[0].series_score_distribution;
  assert.ok(Math.abs(Object.values(scores).reduce((a,b)=>a+b,0)-1)<1e-12);
  assert.equal(r.forecasts[0].probability,1-scores['0:2']);
  assert.equal(r.forecasts[1].probability,scores['2:0']);
});

test('unverified or incomplete BO3 records cannot create a smoothed guess from no evidence', () => {
  const h=clone();h.series=h.series.map(s=>s.team_id==='10020555'?{...s,complete_bo3:false}:s);
  assert.match(buildForecasts(h,fixture,now).skip_reason,/BO3/);
  const x=clone();x.series=x.series.map(s=>s.team_id==='10020555'?{...s,excluded_reason:'Administrative result conflict'}:s);
  assert.equal(buildForecasts(x,fixture,now).forecasts.length,0);
});

test('late, stale, non-BO3, unknown-team and out-of-period fixtures are skipped', () => {
  for(const f of [
    {...fixture,scheduled_start_utc:new Date(now).toISOString()},
    {...fixture,verified_at:'2026-11-06T00:00:00Z'},
    {...fixture,best_of:1},{...fixture,status:'live'},
    {...fixture,team_b_id:'10291652'},
    {...fixture,scheduled_start_utc:'2026-12-08T10:00:00Z'},
  ]) {const r=buildForecasts(history,f,now);assert.equal(r.forecasts.length,0);assert.ok(r.skip_reason);}
});

test('stable fixture identity is orientation-independent and forecasts retain sample IDs', () => {
  const f={...fixture,fixture_id:undefined};
  assert.equal(fixtureKey(f),fixtureKey({...f,team_a_id:f.team_b_id,team_b_id:f.team_a_id}));
  const r=buildForecasts(history,f,now);
  assert.equal(r.forecasts[0].input_sample.team_a_match_ids.length,30);
  assert.equal(r.forecasts[0].input_sample.team_b_match_ids.length,6);
  assert.equal(r.forecasts[0].data_cutoff_utc,new Date(now).toISOString());
  assert.equal(r.forecasts[0].model_version,'baseline-v1');
});
