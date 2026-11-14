import type { Forecast, Market, Status } from './dota-types';
import type { ValuePolicy } from './dota-value';

export interface PaperSettings {
  initial_bankroll: number;
  default_stake: number;
  unit_label: 'ед.';
  created_utc: string;
}

/** A recorded real quote. Updating an existing quote must never change a bet. */
export interface OddsQuote {
  quote_id: string;
  forecast_id: string;
  bookmaker: string;
  decimal_odds: number;
  observed_utc: string;
  recorded_utc: string;
  source_url: string;
  source_market_label?: string;
  entry_method: 'manual' | 'agent';
}

/** Immutable paper entry; both model probability and quote are snapshotted. */
export interface PaperBet {
  analysis_snapshot?: Forecast;
  bet_id: string;
  forecast_id: string;
  quote_id: string;
  stake: number;
  placed_utc: string;
  probability_snapshot: number;
  odds_snapshot: number;
  policy_version?: 'expected-value-v1';
  policy_snapshot?: ValuePolicy;
  expected_value_snapshot?: number;
  conservative_ev_snapshot?: number;
}

export interface PaperBetView extends PaperBet {
  series_score?: [number,number] | null;
  series_winner?: 'a'|'b'|null;
  forecast: Forecast;
  quote: OddsQuote;
  status: Status;
  payout: number | null;
  profit: number | null;
  settled_utc: string | null;
  expected_value: number;
  expected_profit: number;
  observation_id: string | null;
}

export interface PaperCurvePoint {
  at: string;
  bankroll: number;
  profit: number;
  delta: number;
  drawdown: number;
  drawdown_pct: number;
}

/** ROI, return and drawdown percentages are fractions, not percentage points. */
export interface PaperMetrics {
  registered: number;
  distinct_series: number;
  pending: number;
  settled: number;
  won: number;
  lost: number;
  void: number;
  total_staked: number;
  settled_staked: number;
  refunded_stake: number;
  open_stakes: number;
  total_returned: number;
  profit: number;
  roi: number | null;
  bankroll_return: number;
  initial_bankroll: number;
  bankroll: number;
  available_bankroll: number;
  max_drawdown: number;
  max_drawdown_pct: number;
  current_drawdown: number;
  current_drawdown_pct: number;
  mean_odds: number | null;
  expected_profit: number;
}

export interface PaperMarketSummary {
  market: Market;
  registered: number;
  pending: number;
  settled: number;
  won: number;
  lost: number;
  void: number;
  total_staked: number;
  settled_staked: number;
  profit: number;
  roi: number | null;
}

export interface PaperDashboard {
  settings: PaperSettings & { locked: boolean };
  metrics: PaperMetrics;
  quotes: OddsQuote[];
  bets: PaperBetView[];
  eligible_forecasts: Forecast[];
  curve: PaperCurvePoint[];
  by_market: PaperMarketSummary[];
  notes: string[];
}
