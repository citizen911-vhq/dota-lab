import type { FixtureInput } from './dota-analysis-types';
import type { Forecast } from './dota-types';
import {expansionGate,type ExpansionSnapshot} from './dota-expansion';

export interface BettingContext {
  expansion?:ExpansionSnapshot;
  patch: { patch_id: string | null; verified_at: string } | null;
  health: { healthy: boolean; verified_at: string } | null;
  alerts: Record<string, string>;
  fixtures: FixtureInput[];
}
const recent = (at: string | undefined, now: number, age: number) => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= age;

/** Rechecked at write time: schedule, patch and history remain mandatory; roster notices are informational. */
export function bettingContextReason(f: Forecast, context: BettingContext, now = Date.now()): string | null {
  if (!['prematch-elo-v2','prematch-elo-v3','prematch-elo-v4'].includes(f.model_version) || f.betting_eligible !== true) return 'Исторический или справочный прогноз не прошёл проверку допуска текущей модели.';
  if (!context.patch?.patch_id || !recent(context.patch.verified_at, now, 10 * 60_000)) return 'Текущий патч не подтверждён за последние 10 минут.';
  if (f.patch_id !== context.patch.patch_id) return 'Патч изменился после расчёта прогноза; ставка запрещена.';
  if (!context.health?.healthy || !recent(context.health.verified_at, now, 6 * 3600_000)) return 'История не подтверждена полностью за последние шесть часов.';
  const a = String(f.team_a_id ?? ''), b = String(f.team_b_id ?? '');
  const gate=expansionGate(context.expansion,a,b,now);if(gate)return gate;
  const fixtures = context.fixtures.filter(x=>x.team_a_id === a && x.team_b_id === b && Date.parse(x.scheduled_start_utc) === Date.parse(f.scheduled_start_utc));
  if (fixtures.length !== 1) return 'Нет однозначного подтверждения будущей серии.';
  const fixture = fixtures[0];
  if (fixture.status !== 'scheduled' || ![2,3].includes(fixture.best_of) || fixture.best_of !== (f.best_of??3) || Date.parse(fixture.scheduled_start_utc) <= now || !recent(fixture.verified_at, now, 6 * 3600_000)) return 'Формат или подтверждение расписания устарели, либо серия уже началась.';
  if (fixture.patch_id !== context.patch.patch_id) return 'Патч серии не совпадает с текущим.';
  return null;
}
