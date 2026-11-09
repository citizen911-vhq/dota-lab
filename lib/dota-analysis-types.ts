import type { Forecast } from './dota-types';

/** A verified, completed map, from one team's perspective. IDs are Valve IDs. */
export interface AnalysisMap {
  team_id: string; team: string; opponent_team_id: string; opponent: string;
  match_id: string; start_time: number; duration_seconds: number;
  team_kills: number; opponent_kills: number; win: boolean;
  league_id: string; series_id: string | null; series_type: number | null;
  series_key?: string | null; players?: number[]; sources: string[];
  forecast_sample?: boolean; series_excluded_reason?: string | null;
  verified_at?: string; audit_origin?: string; map_number?: number | null;
}

/** A complete BO3 verified separately from the potentially incomplete map index. */
export interface AnalysisSeries {
  series_key: string; team_id: string; team: string;
  opponent_team_id: string; opponent: string;
  start_time: number; end_time?: number;
  score_team: number; score_opponent: number; map_ids: string[];
  complete_bo3: boolean; forecast_sample?: boolean; excluded_reason?: string | null;
  sources: string[]; verified_at?: string; audit_origin?: string;
}

export interface AnalysisHistory {
  maps: AnalysisMap[]; series: AnalysisSeries[]; seed_cutoff_utc?: string;
}

export interface FixtureInput {
  fixture_id?: string; provider_id?: string;
  team_a_id: string; team_b_id: string; scheduled_start_utc: string;
  source_url: string; best_of: 3; status: 'scheduled'; verified_at: string;
  league_id?: string; league?: string;
}

export interface TeamSample {
  team_id: string; team: string; maps: AnalysisMap[]; series: AnalysisSeries[];
  excluded_maps: number; conflicting_map_ids: string[];
  roster_changed: boolean; notes: string[];
}

export interface ForecastBuild {
  forecasts: Forecast[]; skip_reason: string | null;
  samples: { a: TeamSample; b: TeamSample } | null;
}

export interface TrackedTeam {
  id: string; name: string; reference_roster: number[]; scope_note: string;
}
