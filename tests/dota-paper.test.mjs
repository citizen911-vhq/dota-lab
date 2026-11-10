import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Production uses the bundler's extensionless imports; Node's TS loader needs the extension.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './dota-core' && context.parentURL?.endsWith('/dota-paper-core.ts')) return nextResolve('./dota-core.ts', context);
  if (specifier === './dota-value' && context.parentURL?.endsWith('/dota-paper-core.ts')) return nextResolve('./dota-value.ts', context);
  return nextResolve(specifier, context);
} });
const { defaultPaperSettings, paperDashboard, validatePaperSettings, validateQuote, validateBet } = await import('../lib/dota-paper-core.ts');

const BASE = Date.parse('2026-11-09T00:00:00Z');
const at = hours => BASE + hours * 3600000;
const iso = hours => new Date(at(hours)).toISOString();
const settings = (patch = {}) => ({ ...defaultPaperSettings(at(0)), ...patch });
const forecast = (id, patch = {}) => ({
  forecast_id: id, fixture_id: `fixture-${id}`, team_a: 'A', team_b: 'B',
  scheduled_start_utc: iso(3), created_utc: iso(1), data_cutoff_utc: iso(1),
  cohort_date: '2026-11-09', model_version: 'test-only', selection_version: 'test-only',
  market: 'series_winner', family: 'series', selection: 'a', threshold: null,
  probability: 0.6, label: 'Победа A', map_number: null, selected: true, n_maps_a: 30, n_maps_b: 30,
  ...patch,
});
const quoteValue = (f, patch = {}) => ({
  quote_id: `q-${f.forecast_id}`, forecast_id: f.forecast_id, bookmaker: 'Test bookmaker',
  decimal_odds: 2, observed_utc: iso(2), source_url: 'https://example.com/event', entry_method: 'manual', ...patch,
});
const quote = (f, patch = {}, when = at(2)) => validateQuote(quoteValue(f, patch), f, when);
const bet = (f, q, stake = 1, when = at(2.01)) => validateBet({ bet_id: `b-${f.forecast_id}`, forecast_id: f.forecast_id, quote_id: q.quote_id, stake }, q, f, when);
const observation = (f, patch = {}) => ({ observation_id: `o-${f.forecast_id}`, fixture_id: f.fixture_id, recorded_utc: iso(4), sources: ['https://example.com/result'], series_score: [2, 0], ...patch });
const portfolio = (entries, observations = [], config = settings(), now = at(10)) => paperDashboard(config, entries.map(e => e.q), entries.map(e => e.b), entries.map(e => e.f), observations, now);
const entry = (id, odds = 2, stake = 1, patch = {}) => {
  const f = forecast(id, patch), q = quote(f, { decimal_odds: odds });
  return { f, q, b: bet(f, q, stake) };
};

test('empty bank is explicit, ROI is absent, and no fictional equity/results are generated', () => {
  const result = paperDashboard(settings(), [], [], [], [], at(2));
  assert.equal(result.settings.locked, false);
  assert.equal(result.metrics.bankroll, 100);
  assert.equal(result.metrics.available_bankroll, 100);
  assert.equal(result.metrics.profit, 0);
  assert.equal(result.metrics.roi, null);
  assert.equal(result.metrics.mean_odds, null);
  assert.equal(result.metrics.max_drawdown, 0);
  assert.deepEqual(result.curve, []);
});

test('mixed outcomes use variable stakes, refund void bets, and reserve pending exposure', () => {
  const a = entry('win', 2.5, 10), b = entry('loss', 2, 5), c = entry('void', 3, 7), d = entry('pending', 2, 3);
  const result = portfolio([a, b, c, d], [observation(a.f), observation(b.f, { series_score: [0, 2] }), observation(c.f, { series_score: null, series_void: true })]);
  assert.equal(result.settings.locked, true);
  assert.equal(result.metrics.registered, 4);
  assert.equal(result.metrics.settled, 2);
  assert.equal(result.metrics.total_staked, 25);
  assert.equal(result.metrics.settled_staked, 15);
  assert.equal(result.metrics.refunded_stake, 7);
  assert.equal(result.metrics.open_stakes, 3);
  assert.equal(result.metrics.total_returned, 32);
  assert.equal(result.metrics.profit, 10);
  assert.equal(result.metrics.roi, 10 / 15);
  assert.equal(result.metrics.bankroll_return, 0.1);
  assert.equal(result.metrics.bankroll, 110);
  assert.equal(result.metrics.available_bankroll, 107);
  assert.equal(result.bets.find(b => b.status === 'pending').payout, null);
  assert.equal(result.bets.find(b => b.status === 'pending').profit, null);
  assert.equal(result.bets.find(b => b.status === 'void').payout, 7);
  assert.equal(result.bets.find(b => b.status === 'void').profit, 0);
});

test('void-only ROI is null, while a break-even settled portfolio has zero ROI', () => {
  const a = entry('a'), b = entry('b');
  const voided = portfolio([a], [observation(a.f, { series_score: null, series_void: true })]);
  assert.equal(voided.metrics.roi, null);
  assert.equal(voided.metrics.settled_staked, 0);
  const flat = portfolio([a, b], [observation(a.f), observation(b.f, { series_score: [0, 2] })]);
  assert.equal(flat.metrics.roi, 0);
  assert.equal(flat.metrics.profit, 0);
});

test('winning payout rounds half a minor unit up using decimal odds', () => {
  const a = entry('rounding', 2.01, 0.5);
  const result = portfolio([a], [observation(a.f)]);
  assert.equal(result.bets[0].payout, 1.01);
  assert.equal(result.bets[0].profit, 0.51);
  assert.equal(result.metrics.bankroll, 100.51);
});

test('simultaneous settlements are one equity step, independent of input order', () => {
  const a = entry('a', 2, 100), b = entry('b', 2, 100);
  const observations = [observation(a.f), observation(b.f, { series_score: [0, 2] })];
  const left = portfolio([a, b], observations, settings({ initial_bankroll: 200 }));
  const right = portfolio([b, a], observations.toReversed(), settings({ initial_bankroll: 200 }));
  assert.deepEqual(left.curve, right.curve);
  assert.equal(left.curve.length, 2);
  assert.equal(left.curve[1].bankroll, 200);
  assert.equal(left.metrics.max_drawdown, 0);
});

test('correction changes cash at correction time and can create a negative available bank', () => {
  const first = entry('first', 2, 100);
  const f = forecast('later', { scheduled_start_utc: iso(8) });
  const q = quote(f, { observed_utc: iso(4.5) }, at(4.5));
  const later = { f, q, b: bet(f, q, 150, at(4.51)) };
  const original = observation(first.f);
  const correction = observation(first.f, { observation_id: 'correction', supersedes: original.observation_id, recorded_utc: iso(6), series_score: [0, 2] });
  const before = portfolio([first, later], [original, correction], settings(), at(5));
  assert.equal(before.metrics.bankroll, 200);
  assert.equal(before.metrics.available_bankroll, 50);
  const after = portfolio([first, later], [original, correction]);
  assert.deepEqual(after.curve.map(p => [p.at, p.bankroll, p.delta]), [[iso(0), 100, 0], [iso(4), 200, 100], [iso(6), 0, -200]]);
  assert.equal(after.metrics.available_bankroll, -150);
  assert.equal(after.metrics.open_stakes, 150);
  assert.equal(after.metrics.max_drawdown, 200);
  assert.equal(after.metrics.max_drawdown_pct, 1);
  assert.match(after.notes.join(' '), /отрицательный/);
  assert.equal(after.bets.find(b => b.bet_id === first.b.bet_id).settled_utc, iso(6));
  const final = portfolio([first, later], [original, correction, observation(f, { recorded_utc: iso(9), series_score: [0, 2] })]);
  assert.equal(final.metrics.bankroll, -150);
  assert.equal(final.metrics.max_drawdown_pct, 1.75);
});

test('maximum drawdown uses each prior peak, not initial bankroll or final profit', () => {
  const a = entry('gain', 2, 50), b = entry('loss', 2, 30), c = entry('gain2', 2, 10);
  const result = portfolio([a, b, c], [observation(a.f), observation(b.f, { recorded_utc: iso(5), series_score: [0, 2] }), observation(c.f, { recorded_utc: iso(6) })]);
  assert.equal(result.metrics.bankroll, 130);
  assert.equal(result.metrics.max_drawdown, 30);
  assert.equal(result.metrics.max_drawdown_pct, 0.2);
  assert.equal(result.metrics.current_drawdown, 20);
  assert.equal(result.metrics.current_drawdown_pct, 20 / 150);
});

test('cumulative partial observations settle only new facts and preserve prior results', () => {
  const series = entry('series', 2, 2, { fixture_id: 'same' });
  const duration = entry('duration', 2, 2, { fixture_id: 'same', market: 'map_duration', selection: 'under', map_number: 1, threshold: 2460 });
  const kills = entry('kills', 2, 2, { fixture_id: 'same', market: 'map_kills', selection: 'over', map_number: 1, threshold: 49.5 });
  const first = observation(series.f, { observation_id: 'map-kills', series_score: undefined, map1: { kills_a: 30, kills_b: 25 } });
  const second = observation(series.f, { observation_id: 'map-duration', recorded_utc: iso(5), supersedes: 'map-kills', series_score: undefined, map1: { duration_seconds: 2300 } });
  const third = observation(series.f, { observation_id: 'series-result', recorded_utc: iso(6), supersedes: 'map-duration' });
  const result = portfolio([series, duration, kills], [third, first, second]);
  assert.equal(result.metrics.won, 3);
  assert.deepEqual(result.curve.map(p => p.profit), [0, 2, 4, 6]);
  assert.equal(result.bets.find(b => b.forecast_id === 'kills').settled_utc, iso(4));
  assert.equal(result.bets.find(b => b.forecast_id === 'duration').settled_utc, iso(5));
  assert.equal(result.by_market.find(m => m.market === 'map_duration').profit, 2);
});

test('correction to pending reverses realization and restores exposure; correction to void refunds', () => {
  const a = entry('a', 2, 10);
  const original = observation(a.f);
  const pending = observation(a.f, { observation_id: 'pending', supersedes: original.observation_id, recorded_utc: iso(5), series_score: null });
  const reopened = portfolio([a], [original, pending]);
  assert.equal(reopened.metrics.profit, 0);
  assert.equal(reopened.metrics.open_stakes, 10);
  assert.equal(reopened.bets[0].profit, null);
  assert.equal(reopened.bets[0].settled_utc, null);
  assert.deepEqual(reopened.curve.map(p => p.bankroll), [100, 110, 100]);
  const voided = portfolio([a], [original, pending, observation(a.f, { observation_id: 'void', supersedes: 'pending', recorded_utc: iso(6), series_score: null, series_void: true })]);
  assert.equal(voided.metrics.open_stakes, 0);
  assert.equal(voided.metrics.refunded_stake, 10);
  assert.equal(voided.metrics.roi, null);
  assert.equal(voided.curve.at(-1).at, iso(6));
});

test('quote and bet registration cannot be backdated after start, even with an older observed quote', () => {
  const f = forecast('a'), q = quote(f);
  assert.throws(() => validateQuote({ ...quoteValue(f), recorded_utc: iso(2) }, f, at(3)), /начала серии/);
  assert.throws(() => validateBet({ bet_id: 'b', forecast_id: 'a', quote_id: q.quote_id, stake: 1, placed_utc: iso(2) }, q, f, at(3)), /начала серии/);
  assert.throws(() => validateQuote(quoteValue(f), undefined, at(2)), /не найден/);
  assert.throws(() => validateQuote(quoteValue(f), { ...f, status: 'won' }, at(2)), /рассчитан/);
});

test('server timestamps and snapshots override client supplied values', () => {
  const f = forecast('a');
  const q = validateQuote(quoteValue(f, { recorded_utc: iso(1) }), f, at(2));
  const b = validateBet({ bet_id: 'b', forecast_id: 'a', quote_id: q.quote_id, stake: 1, placed_utc: iso(1), probability_snapshot: 1, odds_snapshot: 100 }, q, f, at(2.01));
  assert.equal(q.recorded_utc, iso(2));
  assert.equal(b.placed_utc, iso(2.01));
  assert.equal(b.probability_snapshot, 0.6);
  assert.equal(b.odds_snapshot, 2);
});

test('quote age is measured from book observation, with a strict ten minute maximum', () => {
  const f = forecast('a'), q = quote(f);
  assert.doesNotThrow(() => bet(f, q, 1, at(2 + 1/6)));
  assert.throws(() => bet(f, q, 1, at(2 + 1/6) + 1), /10 минут/);
  assert.throws(() => bet(f, { ...q, recorded_utc: iso(2.5) }, 1), /до ставки/);
  assert.throws(() => quote(f, { observed_utc: iso(2.1) }), /будущем/);
  assert.doesNotThrow(() => quote(f, { observed_utc: iso(0.5) }));
});

test('odds, money, explicit time zones, and source provenance are validated', () => {
  const f = forecast('a');
  for (const source_url of ['http://example.com', 'https://user:secret@example.com', 'javascript:alert(1)', '/relative', '']) {
    assert.throws(() => quote(f, { source_url }), /HTTPS/);
  }
  for (const decimal_odds of [1, 1000.01, Infinity, NaN, 1.12345, '2.00']) assert.throws(() => quote(f, { decimal_odds }));
  assert.doesNotThrow(() => quote(f, { decimal_odds: 1.1234 }));
  assert.throws(() => quote(f, { observed_utc: '2026-11-09T02:00:00' }), /часовым поясом/);
  const q = quote(f);
  for (const stake of [0, -1, 0.001, 1.234, Infinity, NaN, 1_000_001]) assert.throws(() => bet(f, q, stake));
  assert.doesNotThrow(() => bet(f, q, 1.1));
  assert.throws(() => validatePaperSettings(settings({ initial_bankroll: 0 }), at(2)));
  assert.throws(() => validatePaperSettings(settings({ initial_bankroll: null }), at(2)));
});

test('corrupt references, duplicate entries, and changed snapshots never double count', () => {
  const a = entry('a');
  assert.throws(() => paperDashboard(settings(), [a.q, a.q], [a.b], [a.f], [], at(10)), /идентификатор/);
  assert.throws(() => paperDashboard(settings(), [a.q], [a.b, a.b], [a.f], [], at(10)), /идентификатор/);
  assert.throws(() => paperDashboard(settings(), [a.q], [a.b, { ...a.b, bet_id: 'another' }], [a.f], [], at(10)), /ставка на прогноз/);
  assert.throws(() => paperDashboard(settings(), [], [a.b], [a.f], [], at(10)), /Коэффициент не найден/);
  assert.throws(() => paperDashboard(settings(), [a.q], [{ ...a.b, odds_snapshot: 99 }], [a.f], [], at(10)), /изменён/);
});

test('malformed historical results before placement are rejected, even when later corrected', () => {
  const a = entry('a');
  const early = observation(a.f, { recorded_utc: iso(1.5) });
  const correction = observation(a.f, { observation_id: 'later', supersedes: early.observation_id });
  assert.throws(() => portfolio([a], [early]), /предшествовать/);
  assert.throws(() => portfolio([a], [early, correction]), /предшествовать/);
});

test('only future unbet forecasts are eligible and future results never leak into current metrics', () => {
  const a = entry('a'), f = forecast('eligible');
  const future = observation(a.f);
  const result = paperDashboard(settings(), [a.q], [a.b], [a.f, f], [future], at(2.1));
  assert.equal(result.metrics.pending, 1);
  assert.equal(result.metrics.profit, 0);
  assert.deepEqual(result.eligible_forecasts.map(f => f.forecast_id), ['eligible']);
  assert.deepEqual(paperDashboard(settings(), [a.q], [a.b], [a.f, f], [future], at(10)).eligible_forecasts, []);
});
