import type {MatchupAnalysis} from '@/lib/dota-analysis-types';

export interface Forecast {
  odds_quote?: {decimal_odds:number;bookmaker:string;observed_utc:string;source_url:string}|null;
  forecast_id: string; fixture_id: string; team_a: string; team_b: string;
  scheduled_start_utc: string; created_utc: string; data_cutoff_utc?: string; cohort_date?: string;
  best_of?: 2 | 3;
  label: string; probability: number; market: string; family: string; selected: boolean;
  selection_rank?: number | null; selection?: string; threshold?: number | null; map_number?: number | null;
  n_maps_a?: number; n_maps_b?: number; n_series_a?: number; n_series_b?: number;
  model_version?: string; limitation?: string; status: string; outcome: number | null; brier?: number | null;
  sources?: string[]; observation?: Observation | null;
  patch_id?: string; matchup_analysis?: MatchupAnalysis; roster_warnings?: string[];
}
export interface Observation {
  fixture_id: string; observation_id: string; recorded_utc: string;
  series_score?: number[] | null; series_void?: boolean; map1_void?: boolean;
  map1?: { kills_a?: number; kills_b?: number; duration_seconds?: number; match_id?: string } | null;
  sources?: string[];
}
export interface Team {
  team: string; maps: number; mean_duration_seconds?: number; mean_total_kills?: number;
  pari_41_count?: number; over_41_count?: number; date_from?: string; date_to?: string; note?: string;
}
export interface DashboardData {
  updated_at: string; protocol: Record<string, unknown>; forecasts: Forecast[]; minutes: Forecast[];
  teams: Team[]; observations: Observation[]; source_status?: string; storage?: string;
}
const statuses: Record<string, string> = {pending:'ожидает',won:'прошёл',lost:'не прошёл',void:'не разыграно'};
export function normalizeDashboard(raw: any): DashboardData {
  const source = raw.data || raw;
  const normalize = (r: any): Forecast => ({...r, status: statuses[r.status] || r.status_label || r.status || 'ожидает', outcome: r.outcome ?? null});
  const forecasts = (source.forecasts || source.all_forecasts || []).map(normalize);
  const minutes = (source.minute_forecasts || source.minutes || []).map(normalize);
  const observations = [...new Map<string, Observation>([...forecasts,...minutes].filter((r:Forecast)=>r.observation).map((r:Forecast)=>[r.fixture_id,r.observation!])).values()];
  return { updated_at: source.data_updated_at || source.generated_at || source.generated_utc || new Date().toISOString(),
    protocol: source.protocol || {}, forecasts, minutes, teams: (source.teams || source.team_summary || []).map((t: any) => ({ ...t, team: t.team || t.name, over_41_count: t.over_or_equal_41_count ?? t.over_41_count ?? t.pari_41_count })),
    observations: source.observations || observations, source_status: source.source_status, storage: source.storage };
}
