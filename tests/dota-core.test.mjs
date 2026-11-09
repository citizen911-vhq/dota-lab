import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonical,dashboard,latestObservations,mergeJournal,settle,validateObservation} from '../lib/dota-core.ts';

const seed = JSON.parse(fs.readFileSync(new URL('../data/seed.json',import.meta.url),'utf8'));
const now = Date.parse('2026-11-08T07:00:00Z');
const after = Date.parse('2026-11-09T07:00:00Z');
const empty = {...seed,forecasts:[],observations:[],durationSupplement:null};
const f = seed.forecasts.find(f => f.market === 'map_handicap' && f.selection === 'a' && f.threshold === 1.5);
const fixtures = new Map(seed.forecasts.map(f => [f.fixture_id,f]));
const observation = (extra={}) => ({observation_id:'obs-1',fixture_id:f.fixture_id,recorded_utc:'2026-11-08T16:00:00Z',sources:['https://www.opendota.com/matches/12345'],series_score:[1,2],...extra});

test('initial snapshot remains pending, selected 12 vs six series, no invented accuracy', () => {
  const d = dashboard(seed,'seed',null);
  assert.equal(d.selected_forecasts.length,12); assert.equal(d.forecasts.length,120);
  assert.equal(d.minute_forecasts.length,7); assert.equal(d.summary.selected.distinct_series,6);
  assert.equal(d.summary.selected.pending,12); assert.equal(d.summary.selected.hit_rate,null);
  assert.equal(d.summary.selected.brier,null); assert.equal(d.summary.selected.settled,0);
});
test('+1.5 and -1.5 use the team map difference in BO3', () => {
  for (const score of [[2,0],[2,1],[1,2],[0,2]]) {
    assert.equal(settle(f,observation({series_score:score})).outcome,Number(score[0]>=1));
    assert.equal(settle({...f,threshold:-1.5},observation({series_score:score})).outcome,Number(score[0]===2 && score[1]===0));
  }
});
test('41:00 belongs to >=41, 50-minute supplement uses its own threshold', () => {
  const t = seed.forecasts.find(f => f.market==='map_duration' && f.selection==='over_or_equal');
  assert.equal(settle(t,observation({map1:{duration_seconds:2460}})).outcome,1);
  assert.equal(settle({...t,selection:'under'},observation({map1:{duration_seconds:2460}})).outcome,0);
  assert.equal(settle({...t,selection:'under',threshold:3000},observation({map1:{duration_seconds:2999}})).outcome,1);
  assert.equal(settle({...t,selection:'under',threshold:3000},observation({map1:{duration_seconds:3000}})).outcome,0);
});
test('40 total kills wins >39.5; a missing first map stays pending', () => {
  const k = seed.forecasts.find(f=>f.market==='map_kills' && f.threshold===39.5 && f.selection==='over');
  assert.equal(settle(k,observation({map1:{kills_a:21,kills_b:19}})).outcome,1);
  assert.equal(settle(k,observation()).status,'pending');
  assert.equal(settle(k,observation({map1_void:true})).status,'void');
});
test('same snapshot sync is idempotent and does not delete stored observations', () => {
  const initial = mergeJournal(empty,seed,now,seed);
  assert.equal(initial.newForecasts.length,120);
  assert.equal(mergeJournal(initial.journal,seed,after,seed).newForecasts.length,0);
  const stored = {...seed,observations:[observation()]};
  const next = mergeJournal(stored,seed,after,seed);
  assert.equal(next.journal.observations.length,1);
});
test('changed immutable forecast and duration supplement are rejected', () => {
  const changed = structuredClone(seed); changed.forecasts[0].probability=.123;
  assert.throws(()=>mergeJournal(seed,changed,now,seed),/нельзя изменить/);
  const altered = structuredClone(seed); altered.durationSupplement.additional_candidate.probability=.123;
  assert.throws(()=>mergeJournal(seed,altered,now,seed),/дополнительный прогноз/);
});
test('late new forecasts rejected; exact frozen bootstrap remains importable', () => {
  assert.equal(mergeJournal(empty,seed,after,seed).newForecasts.length,120);
  const malicious = {...seed,forecasts:[{...seed.forecasts[0],forecast_id:'new-late-pick'}],durationSupplement:null};
  assert.throws(()=>mergeJournal(empty,malicious,after,seed),/после начала/);
});
test('corrections are append-only, latest map is preserved when series completes later', () => {
  const one = observation({series_score:null,map1:{kills_a:21,kills_b:19,duration_seconds:2460}});
  const two = observation({observation_id:'obs-2',supersedes:'obs-1',recorded_utc:'2026-11-08T17:00:00Z',series_score:[2,1]});
  const d = latestObservations([two,one]).get(f.fixture_id);
  assert.equal(d.map1.duration_seconds,2460); assert.deepEqual(d.series_score,[2,1]);
  const merged = mergeJournal({...seed,observations:[one]},{...seed,observations:[two]},after,seed);
  assert.equal(merged.journal.observations.length,2);
  const overwrite = {...one,series_score:[0,2]};
  assert.throws(()=>mergeJournal({...seed,observations:[one]},{...seed,observations:[overwrite]},after,seed),/нельзя переписать/);
  const branch = {...two,observation_id:'obs-3'};
  assert.throws(()=>latestObservations([one,two,branch]),/последовательность/);
});
test('invalid source, future pre-match result and incomplete kill score rejected', () => {
  assert.throws(()=>validateObservation(observation({sources:['javascript:alert(1)']}),fixtures,after),/ссылку/);
  assert.throws(()=>validateObservation(observation({recorded_utc:'2026-11-08T09:00:00Z'}),fixtures,after),/до начала/);
  assert.throws(()=>validateObservation(observation({map1:{kills_a:30}}),fixtures,after),/обеих команд/);
  assert.throws(()=>validateObservation(observation({series_score:[1,1]}),fixtures,after),/BO3/);
});
test('canonical payload hashes ignore object key order but preserve changed values', () => {
  assert.equal(canonical({b:2,a:{d:4,c:3}}),canonical({a:{c:3,d:4},b:2}));
  assert.notEqual(canonical({x:0}),canonical({x:false}));
});
