import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {experimentJournal,inCurrentExperiment} from '../lib/dota-experiment.ts';
import {dashboard} from '../lib/dota-core.ts';

const seed=JSON.parse(fs.readFileSync(new URL('../data/seed.json',import.meta.url),'utf8'));
const pool=[{id:'7119388',name:'Team Spirit'}];
const current={...seed.forecasts[0],forecast_id:'new-14',fixture_id:'new-series',model_version:'prematch-elo-v3',selected:true,cohort_date:'2026-11-14',scheduled_start_utc:'2026-11-13T15:00:00.000Z',created_utc:'2026-11-13T14:00:00.000Z'};

test('Yakutsk midnight, not UTC midnight, defines new experiment eligibility',()=>{
  assert.equal(inCurrentExperiment(current),true);
  assert.equal(inCurrentExperiment({...current,scheduled_start_utc:'2026-11-13T14:59:59.999Z'}),false);
  assert.equal(inCurrentExperiment({...current,model_version:'baseline-v1'}),false);
  assert.equal(inCurrentExperiment({...current,scheduled_start_utc:'2026-12-13T15:00:00.000Z'}),false);
});
test('old journal is absent from every public aggregate and input storage is untouched',()=>{
  const before=JSON.stringify(seed);
  const visible=experimentJournal(seed,pool),d=dashboard(visible,'database',null);
  assert.equal(d.forecasts_count,0);assert.equal(d.observations_count,0);
  assert.deepEqual(d.forecasts,[]);assert.deepEqual(d.minute_forecasts,[]);assert.deepEqual(d.fixtures,[]);
  assert.equal(d.summary.selected.registered,0);assert.deepEqual(d.daily,[]);
  assert.equal(visible.durationSupplement,null);assert.deepEqual(visible.teams,[]);
  assert.equal(visible.protocol.start_date,'2026-11-14');
  assert.equal(visible.metadata.series_count,0);
  assert.ok(!JSON.stringify(visible).includes('2026-11-08'));
  assert.equal(JSON.stringify(seed),before);
});
test('new forecasts and their settled outcomes survive filtering alongside hidden old records',()=>{
  const observation={observation_id:'new-result',fixture_id:current.fixture_id,recorded_utc:'2026-11-14T10:00:00Z',series_score:[2,0],sources:['https://www.opendota.com/matches/1']};
  const mixed={...seed,forecasts:[...seed.forecasts,current],observations:[observation,{...observation,observation_id:'old-result',fixture_id:seed.forecasts[0].fixture_id}],teams:[...seed.teams,{team:'Team Spirit',team_id:'7119388',maps:30}]};
  const visible=experimentJournal(mixed,pool),d=dashboard(visible,'database',null);
  assert.deepEqual(visible.forecasts,[current]);assert.deepEqual(visible.observations,[observation]);
  assert.equal(visible.teams.length,1);assert.equal(d.summary.selected.settled,1);
  assert.equal(d.forecasts_count,1);assert.equal(d.observations_count,1);
  assert.deepEqual(d.daily.map(r=>r.date),['2026-11-14']);
  assert.equal(mixed.forecasts.length,121);
});
