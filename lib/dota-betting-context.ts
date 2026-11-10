import type { FixtureInput, RosterConfirmation } from './dota-analysis-types';
import type { Forecast } from './dota-types';

export interface BettingContext {
  patch: { patch_id: string | null; verified_at: string } | null;
  health: { healthy: boolean; verified_at: string } | null;
  alerts: Record<string, string>;
  fixtures: FixtureInput[];
}
const recent = (at: string | undefined, now: number, age: number) => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= age;
const rosterKey = (r: RosterConfirmation | undefined) => r?.account_ids?.slice().sort((a,b)=>a-b).join(',');
function rosterValid(r: RosterConfirmation | undefined, now: number): boolean {
  if (!r || r.has_standin !== false || !recent(r.verified_at, now, 6 * 3600_000) || !Array.isArray(r.account_ids) || r.account_ids.length !== 5 || new Set(r.account_ids).size !== 5 || !r.account_ids.every(n=>Number.isSafeInteger(n)&&n>0&&n<4294967295)) return false;
  try { const u = new URL(r.source_url); return u.protocol === 'https:' && !u.username && !u.password && ['cyberscore.live','www.cyberscore.live','liquipedia.net'].includes(u.hostname); } catch { return false; }
}

/** Rechecked at write time: a frozen forecast is not authorization to bet after a roster or patch change. */
export function bettingContextReason(f: Forecast, context: BettingContext, now = Date.now()): string | null {
  if (f.model_version !== 'prematch-elo-v2' || f.betting_eligible !== true) return 'Исторический или справочный прогноз не прошёл новую проверку патча и состава.';
  if (!context.patch?.patch_id || !recent(context.patch.verified_at, now, 10 * 60_000)) return 'Текущий патч не подтверждён за последние 10 минут.';
  if (f.patch_id !== context.patch.patch_id) return 'Патч изменился после расчёта прогноза; ставка запрещена.';
  if (!context.health?.healthy || !recent(context.health.verified_at, now, 6 * 3600_000)) return 'История не подтверждена полностью за последние шесть часов.';
  const a = String(f.team_a_id ?? ''), b = String(f.team_b_id ?? '');
  if (context.alerts[a] || context.alerts[b]) return context.alerts[a] ?? context.alerts[b];
  const fixtures = context.fixtures.filter(x=>x.team_a_id === a && x.team_b_id === b && Date.parse(x.scheduled_start_utc) === Date.parse(f.scheduled_start_utc));
  if (fixtures.length !== 1) return 'Нет однозначного подтверждения будущей серии.';
  const fixture = fixtures[0];
  if (fixture.status !== 'scheduled' || fixture.best_of !== 3 || Date.parse(fixture.scheduled_start_utc) <= now || !recent(fixture.verified_at, now, 6 * 3600_000)) return 'Подтверждение расписания устарело или серия уже началась.';
  if (fixture.patch_id !== context.patch.patch_id) return 'Патч серии не совпадает с текущим.';
  const snapshots = f.roster_snapshots as FixtureInput['rosters'];
  if (!snapshots || !rosterValid(fixture.rosters?.team_a, now) || !rosterValid(fixture.rosters?.team_b, now)) return 'Состав с заменой или не подтверждён: матч в пуле неопределённости.';
  if (rosterKey(snapshots.team_a) !== rosterKey(fixture.rosters?.team_a) || rosterKey(snapshots.team_b) !== rosterKey(fixture.rosters?.team_b)) return 'Состав изменился после прогноза: ставка запрещена.';
  return null;
}
