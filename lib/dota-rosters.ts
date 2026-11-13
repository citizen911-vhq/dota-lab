import type { AnalysisHistory, FixtureInput } from './dota-analysis-types';

export interface BaselineRoster {
  account_ids: number[];
  match_id: string;
  observed_at: string;
  source_url: string;
  adopted_on: string;
}

// Observed past lineups approved as references, NOT verified future lineups.
const observed: Record<string, [number[], string, string]> = {
  '9964962': [[90423751,154974246,160119017,177203952,191362875], '9088161900', '2026-11-13T12:38:08Z'],
  '7119388': [[106305042,140835095,218231587,321580662,847565596], '9087439951', '2026-11-12T19:52:03Z'],
  '8255888': [[165564598,172099728,175311897,196878136,317880638], '9064490683', '2026-10-27T16:00:14Z'],
  '9467224': [[100058342,126842529,256156323,301750126,320219866], '9087068600', '2026-11-12T15:16:34Z'],
  '2163': [[16497807,77490514,97658618,292921272,898455820], '9069021061', '2026-10-30T19:53:24Z'],
  '9823272': [[93817671,103735745,171262902,183719386,312436974], '9071885340', '2026-11-01T15:49:50Z'],
  '2576071': [[333351042,418942836,860145568,1150772339,1202267677], '9086220626', '2026-11-11T21:03:19Z'],
  '36': [[130991304,185590374,835864135,919735867,957204049], '9077861870', '2026-11-05T22:06:39Z'],
  '2586976': [[94054712,100594231,181267255,355168766,402583877], '9076056982', '2026-11-04T15:05:32Z'],
  '10282069': [[93526520,196482746,340421206,1092267175,1682179459], '9088161900', '2026-11-13T12:38:08Z'],
  '10182357': [[86698277,136829091,162798290,331855530,346412363], '9087439951', '2026-11-12T19:52:03Z'],
  '9824702': [[73401082,106573901,164199202,195108598,1044002267], '9087276030', '2026-11-12T17:46:35Z'],
};
export const BASELINE_ROSTERS: Record<string, BaselineRoster> = Object.fromEntries(
  Object.entries(observed).map(([id,[account_ids,match_id,observed_at]]) => [id,
    {account_ids,match_id,observed_at,source_url:`https://www.opendota.com/matches/${match_id}`,adopted_on:'2026-11-13'}]),
);

const valid = (ids?: number[]) => !!ids && ids.length===5 && new Set(ids).size===5 && ids.every(n=>Number.isSafeInteger(n)&&n>0&&n<4294967295);
const key = (ids: number[]) => [...ids].sort((a,b)=>a-b).join(',');

/** Advisory only: callers must never use these strings as eligibility gates. */
export function rosterNotices(fixture: FixtureInput, history: AnalysisHistory, now: number): string[] {
  const notes: string[] = [];
  for (const side of ['team_a','team_b'] as const) {
    const id=fixture[`${side}_id`],name=fixture[`${side}_name`]??id;
    const baseline=BASELINE_ROSTERS[id];
    const proof=fixture.rosters?.[side];
    const proofAt=Date.parse(proof?.verified_at??'');
    const fresh=!!proof && valid(proof.account_ids) && Number.isFinite(proofAt) && proofAt<=now && now-proofAt<=6*3600000;
    if (!fresh) notes.push(`${name}: состав на предстоящий матч не подтверждён свежими данными.`);
    if (proof?.has_standin) notes.push(`${name}: источник сообщает о замене.`);
    if (!baseline) { notes.push(`${name}: базовая пятёрка ещё не закреплена.`); continue; }
    if (fresh && key(proof!.account_ids)!==key(baseline.account_ids)) notes.push(`${name}: заявленные аккаунты отличаются от базовой пятёрки.`);
    const latest=history.maps.filter(m=>m.team_id===id && (m.start_time+m.duration_seconds)*1000<=now && (!m.verified_at||Date.parse(m.verified_at)<=now)).sort((a,b)=>b.start_time-a.start_time)[0];
    if (latest && latest.start_time*1000>=Date.parse(baseline.observed_at)) {
      if (!valid(latest.players)) notes.push(`${name}: в последней карте нет полной пятёрки аккаунтов.`);
      else if (key(latest.players!)!==key(baseline.account_ids)) notes.push(`${name}: в последней карте аккаунты отличаются от базовой пятёрки; личность владельцев требует проверки.`);
    }
  }
  return [...new Set(notes)];
}
