export type AiMode = 'explain' | 'news' | 'daily';
export type AiIssue = { fixture_id: string | null; reason: string; source: string; at: string | null };
export type AiFixture = {
  fixture_id: string; team_a: string; team_b: string; scheduled_start_utc: string | null;
  forecasts: { forecast_id: string; label: string; probability: number; created_utc: string; n_maps_a: number; n_maps_b: number }[];
  bets: { label: string; status: string; odds: number; probability: number; stake: number; placed_utc: string }[];
  quotes: { label: string; odds: number; bookmaker: string; observed_utc: string }[];
};
export type AiSnapshot = {
  generated_at: string; day: string; timezone: 'Europe/Moscow'; storage: string;
  last_analysis: { at: string | null; status: string; backlog: number; warnings: string[] } | null;
  last_odds: { at: string | null; status: string; reason: string; eligible_forecasts: number; bets_added: number } | null;
  history: { healthy: boolean; verified_at: string | null } | null;
  rules: { min_odds: number; min_ev: number; probability_reserve: number; max_bets_per_series: number };
  bankroll: { bankroll: number; available_bankroll: number; open_stakes: number };
  daily: { forecasts: number; bets: number; settled: number; won: number; lost: number; void: number; profit: number; analyses: number; maps_added: number };
  fixtures: AiFixture[]; issues: AiIssue[]; fixtures_total: number; issues_total: number;
};
export type AiTextPart = { text: string; citations: { start: number; end: number; url: string; title: string }[] };
export type AiReport = {
  mode: AiMode; fixture_id: string | null; at: string; context_at: string; fingerprint: string;
  status: 'completed' | 'blocked'; reason: string; parts: AiTextPart[];
  sources: { url: string; title: string }[]; search_calls: number;
  input_tokens: number; output_tokens: number; retry_after?: string;
};
export type AiDashboard = {
  key_configured: boolean; model: string; snapshot: AiSnapshot;
  report: AiReport | null; report_stale: boolean; mode: AiMode; fixture_id: string | null;
};
