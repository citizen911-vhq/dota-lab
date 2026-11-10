import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectOpenDota, TRACKED_TEAM_IDS } from '../lib/dota-opendota.ts';

const now = Date.parse('2026-11-08T09:45:00Z');
const seconds = now / 1000;
const api = 'https://api.opendota.com/api/';
const map = (extra = {}) => ({
  match_id: 9080101215, start_time: seconds - 3600, duration: 2400,
  radiant_team_id: 55, dire_team_id: 10252232, leagueid: 20511,
  radiant_score: 27, dire_score: 20, radiant_win: true,
  series_id: 1165389, series_type: 1, patch: 60,
  players: Array.from({ length: 10 }, (_, n) => ({ account_id: 100 + n, player_slot: n < 5 ? n : 128 + n - 5, kills: 999 })),
  ...extra,
});
const teamRow = (raw) => ({ ...raw, radiant: true, opposing_team_id: raw.dire_team_id });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
function mock(routes = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    const value = routes[String(url).slice(api.length)];
    if (typeof value === 'function') return value(url, options);
    return value instanceof Response ? value : json(value ?? []);
  };
  return { calls, fetchFn };
}

test('deduplicates discovery, reads final scores and seconds, and keeps public roster IDs', async () => {
  const raw = map();
  const { fetchFn, calls } = mock({ 'teams/55/matches': [teamRow(raw)], 'leagues/20511/matches': [raw], proMatches: [raw], [`matches/${raw.match_id}`]: raw });
  const result = await collectOpenDota([], now, fetchFn);
  assert.equal(result.requested, 12);
  assert.equal(result.healthy, true);
  assert.equal(result.successful_indexes, 11);
  assert.equal(result.discovered, 1);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.unfetched_ids, []);
  const match = result.matches[0];
  assert.equal(match.id, String(raw.match_id));
  assert.equal(match.radiant_kills, 27); // players.kills intentionally does not agree
  assert.equal(match.dire_kills, 20);
  assert.equal(match.duration_seconds, 2400);
  assert.equal(match.patch_id, '60');
  assert.equal(match.end_time, raw.start_time + 2400);
  assert.deepEqual(match.players.radiant, ['100', '101', '102', '103', '104']);
  assert.equal(match.sources.length, 5);
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.redirect === 'manual' && call.options.signal instanceof AbortSignal));
  assert.ok(!('map_number' in match)); // index order cannot prove first-map order
});

test('only explicit numeric patch IDs enter normalized history; missing or malformed patch stays unknown', async () => {
  for (const patch of [undefined,null,'60',-1,60.5]) {
    const raw=map({patch});
    const {fetchFn}=mock({'teams/55/matches':[teamRow(raw)],[`matches/${raw.match_id}`]:raw});
    const result=await collectOpenDota([],now,fetchFn);
    assert.equal(result.matches[0].patch_id,null);
    assert.match(result.warnings.join(' '),/ID патча не подтверждён/);
  }
  const raw=map({patch:0});
  const {fetchFn}=mock({'teams/55/matches':[teamRow(raw)],[`matches/${raw.match_id}`]:raw});
  assert.equal((await collectOpenDota([],now,fetchFn)).matches[0].patch_id,'0');
});

test('known maps and curated remakes are not fetched, ancient index rows do not create backlog', async () => {
  const known = map();
  const old = map({ match_id: 100, start_time: Date.parse('2026-11-01T00:00:00Z') / 1000 });
  const excluded = map({ match_id: 9074604699 });
  const { fetchFn, calls } = mock({ 'teams/55/matches': [teamRow(known), teamRow(old), teamRow(excluded)] });
  const result = await collectOpenDota([`valve:${known.match_id}`], now, fetchFn);
  assert.equal(calls.length, 11);
  assert.equal(result.discovered, 0);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.unfetched_ids, []);
  assert.match(result.warnings[0], /пропуски/);
});

test('enforces 23-request limit and preserves unprocessed candidate IDs', async () => {
  const maps = Array.from({ length: 20 }, (_, index) => map({ match_id: 9080200000 + index }));
  const routes = { 'teams/55/matches': maps.map(teamRow) };
  for (const raw of maps) routes[`matches/${raw.match_id}`] = raw;
  const { fetchFn, calls } = mock(routes);
  const result = await collectOpenDota([], now, fetchFn);
  assert.equal(result.requested, 23);
  assert.equal(calls.length, 23);
  assert.equal(result.matches.length, 12);
  assert.equal(result.discovered, 20);
  assert.equal(result.unfetched_ids.length, 8);
  assert.equal(result.healthy, true); // the caller must separately gate on the remaining backlog
  assert.equal(result.matches[0].id, '9080200019');
});

test('429 stops all further requests and exposes Retry-After without retrying', async () => {
  const { fetchFn, calls } = mock({ 'teams/55/matches': json({ error: 'limited' }, 429, { 'Retry-After': '60' }) });
  const result = await collectOpenDota([], now, fetchFn);
  assert.equal(calls.length, 1);
  assert.equal(result.requested, 1);
  assert.equal(result.healthy, false);
  assert.equal(result.successful_indexes, 0);
  assert.match(result.warnings.join(' '), /Retry-After: 60/);
});

test('Workers-compatible manual redirects are rejected without requesting Location', async () => {
  const { fetchFn, calls } = mock({ 'teams/55/matches': new Response(null, { status: 302, headers: { Location: 'https://example.org/redirect-target' } }) });
  const result = await collectOpenDota([], now, fetchFn);
  assert.equal(result.healthy, false);
  assert.equal(result.successful_indexes, 10);
  assert.equal(result.requested, 11);
  assert.ok(calls.every(call => call.url.startsWith(api) && call.options.redirect === 'manual'));
  assert.match(result.warnings.join(' '), /перенаправление/);
});

test('rate limit on detail retains the entire queue; unavailable index does not erase another source', async () => {
  const raw = map();
  const { fetchFn, calls } = mock({ 'teams/55/matches': json({}, 503), 'leagues/20511/matches': [raw], [`matches/${raw.match_id}`]: json({}, 429) });
  const result = await collectOpenDota([], now, fetchFn);
  assert.equal(calls.length, 12);
  assert.equal(result.matches.length, 0);
  assert.equal(result.healthy, false);
  assert.equal(result.successful_indexes, 10);
  assert.deepEqual(result.unfetched_ids, [String(raw.match_id)]);
  assert.match(result.warnings.join(' '), /503/);
});

test('rejects null scores, mismatched detail identity, and not-yet-completed games', async () => {
  for (const change of [{ radiant_score: null }, { match_id: 999 }, { duration: 7200 }, { radiant_team_id: null }]) {
    const raw = map();
    const { fetchFn } = mock({ 'teams/55/matches': [teamRow(raw)], [`matches/${raw.match_id}`]: map(change) });
    const result = await collectOpenDota([], now, fetchFn);
    assert.equal(result.matches.length, 0);
    assert.equal(result.healthy, false);
    assert.deepEqual(result.unfetched_ids, [String(raw.match_id)]);
  }
});

test('merges missing series metadata only from matching league, teams and match IDs', async () => {
  const detail = map({ series_id: null, series_type: null });
  const { fetchFn } = mock({ 'leagues/20511/matches': [map()], [`matches/${detail.match_id}`]: detail });
  const result = await collectOpenDota([], now, fetchFn);
  assert.equal(result.matches[0].series_id, 1165389);
  assert.equal(result.matches[0].series_type, 1);
  for (const change of [{ dire_team_id: 999 }, { leagueid: 20486 }]) {
    const source = map(change);
    const { fetchFn } = mock({ proMatches: [source], [`matches/${detail.match_id}`]: detail });
    const result = await collectOpenDota([], now, fetchFn);
    assert.equal(result.matches[0].series_id, null);
    assert.equal(result.matches[0].series_type, null);
  }
});

test('conflicting series metadata and anonymous accounts stay unknown', async () => {
  const detail = map({ series_id: null, series_type: null });
  detail.players[0].account_id = null;
  detail.players[1].account_id = 4294967295;
  const { fetchFn } = mock({ 'leagues/20511/matches': [map()], proMatches: [map({ series_id: 222 })], [`matches/${detail.match_id}`]: detail });
  const result = await collectOpenDota([], now, fetchFn);
  assert.equal(result.matches[0].series_id, null);
  assert.deepEqual(result.matches[0].players.radiant, ['102', '103', '104']);
  assert.match(result.warnings.join(' '), /расходятся/);
  assert.match(result.warnings.join(' '), /состав/);
});

test('explicit discovery boundary is honored and roster baselines describe observation, not future confirmation', async () => {
  const raw = map();
  const { fetchFn } = mock({ 'teams/55/matches': [teamRow(raw)] });
  const result = await collectOpenDota([], now, fetchFn, raw.start_time + 1);
  assert.equal(result.discovered, 0);
  const baselines = JSON.parse(fs.readFileSync(new URL('../data/roster-baseline.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(baselines).sort(), [...TRACKED_TEAM_IDS].sort());
  for (const baseline of Object.values(baselines)) {
    assert.equal(new Set(baseline.account_ids).size, 5);
    assert.equal(baseline.status, 'last_observed_not_confirmed_for_future_fixture');
    assert.ok(baseline.observed_start_time < seconds);
    assert.equal(baseline.source_url, `${api}matches/${baseline.observed_match_id}`);
  }
});

test('optional OpenDota key is sent only in the documented Bearer header and never in provenance', async () => {
  const key = '10203040-5060-4070-8090-a0b0c0d0e0f0'; // deliberately synthetic fixture credential
  const raw = map();
  const { fetchFn, calls } = mock({ 'teams/55/matches': [teamRow(raw)], [`matches/${raw.match_id}`]: raw });
  const result = await collectOpenDota([], now, fetchFn, undefined, key);
  assert.equal(result.matches.length, 1);
  assert.ok(calls.every(call => new URL(call.url).origin === 'https://api.opendota.com'));
  assert.ok(calls.every(call => call.options.headers.Authorization === `Bearer ${key}`));
  assert.ok(calls.every(call => !call.url.includes('?') && call.options.redirect === 'manual'));
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(result.matches[0].sources.every(source => !source.includes('api_key') && !source.includes(key)));
  const keyless = mock();
  await collectOpenDota([], now, keyless.fetchFn);
  assert.ok(keyless.calls.every(call => !('Authorization' in call.options.headers)));
});

test('authenticated exception diagnostics cannot leak echoed headers, URL keys, names or causes', async (t) => {
  const key = '10203040-5060-4070-8090-a0b0c0d0e0f0';
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const error = new TypeError(`Authorization: Bearer ${key}; ?api_key=${encodeURIComponent(key)}`);
  error.name = key;
  error.cause = { name: key, code: key, message: key };
  const result = await collectOpenDota([], now, async () => { throw error; }, undefined, key);
  assert.equal(result.healthy, false);
  assert.equal(logs.length, 11);
  assert.ok(!JSON.stringify({ result, logs }).includes(key));
  assert.ok(logs.every(entry => entry[1].error_name === 'TypeError' && !('error_message' in entry[1])));
});

test('authenticated rate-limit and redirect responses do not echo secret-bearing headers', async () => {
  const key = '10203040-5060-4070-8090-a0b0c0d0e0f0';
  const limited = mock({ 'teams/55/matches': json({ error: key }, 429, { 'Retry-After': key }) });
  const limitedResult = await collectOpenDota([], now, limited.fetchFn, undefined, key);
  assert.equal(limitedResult.requested, 1);
  assert.ok(!JSON.stringify(limitedResult).includes(key));
  const redirected = mock({ 'teams/55/matches': new Response(null, { status: 302, headers: { Location: `https://example.org/?api_key=${key}` } }) });
  const redirectedResult = await collectOpenDota([], now, redirected.fetchFn, undefined, key);
  assert.equal(redirectedResult.healthy, false);
  assert.ok(redirected.calls.every(call => call.url.startsWith(api) && !call.url.includes(key) && call.options.redirect === 'manual'));
  assert.ok(!JSON.stringify(redirectedResult).includes(key));
});
