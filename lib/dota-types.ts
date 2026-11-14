export type Status = 'pending' | 'won' | 'lost' | 'void';
export type Market = 'map_handicap' | 'series_winner' | 'map_kills' | 'map_duration';
export interface Forecast {
  pool_warnings?: string[];
  forecast_id: string; fixture_id: string; team_a: string; team_b: string;
  scheduled_start_utc: string; created_utc: string; data_cutoff_utc: string;
  best_of?: 2 | 3;
  cohort_date: string; model_version: string; selection_version: string;
  market: Market; family: string; selection: string; threshold: number | null;
  probability: number; label: string; map_number: number | null;
  selected: boolean; selection_rank?: number | null;
  n_maps_a: number; n_maps_b: number; n_series_a?: number; n_series_b?: number;
  sources?: string[]; [key: string]: unknown;
}
export interface Observation {
  /** Proven BO3 winner; does not imply an exact series score or map order. */
  series_winner?: 'a' | 'b' | null;
  winner_map_ids?: string[];
  observation_id: string; fixture_id: string; recorded_utc: string; sources: string[];
  series_score?: [number, number] | null; series_void?: boolean; map1_void?: boolean;
  map1?: { match_id?: string | number | null; kills_a?: number | null; kills_b?: number | null; duration_seconds?: number | null } | null;
  supersedes?: string | null; note?: string; [key: string]: unknown;
}
export interface ForecastView extends Forecast {
  status: Status; status_label: string; outcome: number | null; brier: number | null;
  observation: Observation | null; sources: string[];
}
export interface Metrics {
  registered: number; distinct_series: number; pending: number; settled: number;
  passed: number; failed: number; void: number; hit_rate: number | null;
  brier: number | null; mean_probability_settled: number | null;
  sum_predicted_passes: number; sum_predicted_settled: number;
}
export interface Team {
  team?: string; name?: string; maps: number; mean_duration_seconds?: number;
  median_duration_seconds?: number; over_41_count?: number; mean_total_kills?: number;
  note?: string; notes?: string; source_urls?: string[]; [key: string]: unknown;
}
export interface Journal {
  forecasts: Forecast[]; observations: Observation[]; teams: Team[];
  protocol: Record<string, unknown>; durationSupplement?: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}
export interface Fixture {
  fixture_id: string; team_a: string; team_b: string; scheduled_start_utc: string;
  observation: Observation | null; n_maps_a: number; n_maps_b: number;
}
export interface Dashboard {
  generated_at: string; data_updated_at: string | null; storage: 'database' | 'seed';
  forecasts_count: number; observations_count: number;
  metadata: Record<string, unknown>; protocol: Record<string, unknown>;
  forecasts: ForecastView[]; selected_forecasts: ForecastView[]; minute_forecasts: ForecastView[];
  fixtures: Fixture[]; teams: Team[];
  summary: { selected: Metrics; minutes: Metrics; by_market: Record<string, Metrics> };
  daily: Array<{ date: string; registered: number; settled: number; passed: number; hit_rate: number | null; mean_probability: number | null }>;
  calibration: Array<{ from: number; to: number; count: number; mean_probability: number | null; hit_rate: number | null }>;
}
