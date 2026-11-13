import {buildForecasts} from './dota-analysis';
import type {AnalysisHistory,FixtureInput} from './dota-analysis-types';
import type {Forecast} from './dota-types';
import {invariant} from './dota-core';

export function recalculateBetForecast(original:Forecast,history:AnalysisHistory,fixture:FixtureInput,now:number):Forecast{
  const result=buildForecasts(history,{...fixture,fixture_id:original.fixture_id},now);
  const f=result.forecasts.find(f=>f.market===original.market&&f.selection===original.selection&&f.threshold===original.threshold&&f.map_number===original.map_number);
  invariant(f,result.skip_reason??'Свежая история не позволяет пересчитать этот рынок.');
  return {...f,forecast_id:original.forecast_id,created_utc:original.created_utc,forecast_stage:'bet-confirmed',recalculated_at:new Date(now).toISOString(),preliminary_probability:original.probability};
}

export function checkedBetSnapshot(original:Forecast,snapshot:Forecast|undefined,placed:number):Forecast{
  if(!snapshot)return original; // Legacy immutable bets remain readable.
  invariant((snapshot.best_of??3)===(original.best_of??3),'Формат серии в снимке пересчёта изменён.');
  for(const k of ['forecast_id','fixture_id','team_a_id','team_b_id','scheduled_start_utc','market','family','selection','threshold','map_number','created_utc'] as const)
    invariant(snapshot[k]===original[k],'Снимок пересчёта относится к другому событию.');
  const at=Date.parse(String(snapshot.recalculated_at));
  invariant(snapshot.forecast_stage==='bet-confirmed'&&Number.isFinite(at)&&at<=placed&&placed-at<=600000,'Нет свежего снимка пересчёта перед ставкой.');
  invariant(Number.isFinite(snapshot.probability)&&snapshot.probability>=0&&snapshot.probability<=1,'Некорректная вероятность пересчёта.');
  invariant(snapshot.data_cutoff_utc===snapshot.recalculated_at,'Время истории пересчёта не совпадает.');
  return snapshot;
}
