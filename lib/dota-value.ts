import type { Forecast } from './dota-types';

export const ODDS_REFRESH_MS = 10 * 60_000;
export const MAX_PAPER_BETS_PER_SERIES = 3;
export interface ValuePolicy { min_odds: number; min_ev: number; probability_reserve: number }
export const DEFAULT_VALUE_POLICY: ValuePolicy = { min_odds: 1.7, min_ev: 0.05, probability_reserve: 0.03 };
export const VALUE_POLICY_VERSION = 'expected-value-v1';

/** These are experimental configurable gates, not a confidence interval or a profit guarantee. */
export function valuePolicy(values: { PAPER_MIN_ODDS?: string; PAPER_MIN_EV?: string; PAPER_PROBABILITY_RESERVE?: string } = {}): ValuePolicy {
  const read = (name: keyof typeof values, fallback: number, min: number, max: number) => {
    const raw = values[name];
    if (raw == null) return fallback;
    const n = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Некорректная настройка ${name}.`);
    return n;
  };
  return {
    min_odds: read('PAPER_MIN_ODDS', DEFAULT_VALUE_POLICY.min_odds, 1.01, 1000),
    min_ev: read('PAPER_MIN_EV', DEFAULT_VALUE_POLICY.min_ev, 0.001, 10),
    probability_reserve: read('PAPER_PROBABILITY_RESERVE', DEFAULT_VALUE_POLICY.probability_reserve, 0, 0.99),
  };
}

export function evaluateValue(probability: number, odds: number, policy: ValuePolicy = DEFAULT_VALUE_POLICY) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !Number.isFinite(odds) || odds < 1.01 || odds > 1000) {
    return { eligible: false, expected_value: null, conservative_ev: null, probability_used: null, reason: 'Некорректная вероятность или коэффициент.' };
  }
  const p = Math.max(0, probability - policy.probability_reserve);
  const ev = probability * odds - 1, conservative = p * odds - 1;
  const reason = odds < policy.min_odds ? `Коэффициент ниже ${policy.min_odds.toFixed(2)}.`
    : conservative + 1e-12 < policy.min_ev ? `Ожидаемая доходность с резервом ниже ${(policy.min_ev * 100).toFixed(1)}%.` : null;
  return { eligible: !reason, expected_value: ev, conservative_ev: conservative, probability_used: p, reason };
}

/** One bet per market type. Winner and handicap are separate slots, not independent risks.
 * Keep stored Forecast.family unchanged so historical forecast/bet snapshots stay valid.
 * Alternate sides and total/handicap lines still share their market's single slot.
 */
export function sameBetFamily(a: Forecast, b: Forecast): boolean {
  return a.fixture_id === b.fixture_id && a.market === b.market;
}
