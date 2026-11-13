import type { Forecast, Journal } from './dota-types';

// Midnight November 14 in Yakutsk (UTC+9), through December 13 inclusive.
export const JOURNAL_START_MS=Date.parse('2026-11-13T15:00:00.000Z');
export const JOURNAL_END_MS=Date.parse('2026-12-13T15:00:00.000Z');
export function inCurrentExperiment(f: Pick<Forecast,'scheduled_start_utc'|'model_version'>): boolean {
  const at=Date.parse(f.scheduled_start_utc);
  return at>=JOURNAL_START_MS&&at<JOURNAL_END_MS&&['prematch-elo-v2','prematch-elo-v3','prematch-elo-v4'].includes(f.model_version);
}

/** Public experiment view. Raw history and immutable records stay in storage. */
export function experimentJournal(journal: Journal, pool: {id:string;name:string}[]): Journal {
  const forecasts=journal.forecasts.filter(inCurrentExperiment);
  const fixtures=new Set(forecasts.map(f=>f.fixture_id));
  const observations=journal.observations.filter(o=>fixtures.has(o.fixture_id));
  const ids=new Set(pool.map(t=>t.id));
  const teams=journal.teams.filter(t=>ids.has(String(t.team_id??'')));
  return {forecasts,observations,teams,durationSupplement:null,
    protocol:{title:'Dota Lab: эксперимент с 14 ноября',start_date:'2026-11-14',last_forecast_date:'2026-12-13',final_report_date:'2026-12-14',timezone:'Asia/Yakutsk',model_version:'prematch-elo-v4',roster_policy:'informational-v1',tracked_teams:pool.map(t=>t.name)},
    metadata:{experiment_id:'2026-11-14',start_date:'2026-11-14',forecasts_count:forecasts.length,observations_count:observations.length,selected_count:forecasts.filter(f=>f.selected).length,series_count:fixtures.size},
  };
}
