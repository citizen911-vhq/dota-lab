import type {Forecast} from './dota-types';
import type {NormalizedMatch} from './dota-opendota';
import {distinctMatches,forecastTeamIds,type ConfirmSeriesInput} from './dota-auto-core';
import {sameTeamName} from './dota-team-identity';

type Row=Record<string,any>;
export const HAWK_RESULTS='https://hawk.live/dota-2/matches/results/';
// Public server-rendered page data, observed 2026-11-14. No login, challenge
// bypass, hidden API or provider-specific IDs treated as Valve IDs.
export function hawkProps(html:string):Row {
  const value=html.match(/\bdata-page="([^"]+)"/)?.[1];
  if(!value)throw new Error('Hawk Live: структура страницы недоступна.');
  const decoded=value.replace(/&quot;/g,'"').replace(/&#039;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  const parsed=JSON.parse(decoded);
  if(!parsed?.props||typeof parsed.props!=='object')throw new Error('Hawk Live: некорректная структура данных.');
  return parsed.props;
}
export async function fetchHawk(url:string,fetcher:typeof fetch=fetch):Promise<Row>{
  if(!/^https:\/\/hawk\.live\/dota-2\/matches\/[a-z0-9/-]+$/.test(url))throw new Error('Некорректный URL результата.');
  const response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{Accept:'text/html'}});
  if(!response.ok||response.redirected){await response.body?.cancel();throw new Error(`Hawk Live: HTTP ${response.status}; результат пока не подтверждён.`);}
  const reader=response.body?.getReader();if(!reader)throw new Error('Hawk Live: пустой ответ.');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000){await reader.cancel();throw new Error('Hawk Live: ответ слишком большой.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return hawkProps(new TextDecoder().decode(bytes));
}
export function resultRows(props:Row):Row[]{
  if(!Array.isArray(props.seriesResultsByChampionships))throw new Error('Hawk Live: нет списка результатов.');
  return props.seriesResultsByChampionships.flatMap((group:Row)=>Array.isArray(group.seriesResults)?group.seriesResults:[]);
}
export function resultOrientation(row:Row,f:Forecast):boolean|null {
  const ids=forecastTeamIds(f);if(!ids)return null;
  if(row.bestOf!==(f.best_of??3)||!Number.isFinite(Date.parse(row.startAt))||Math.abs(Date.parse(row.startAt)-Date.parse(f.scheduled_start_utc))>8*3600000)return null;
  const direct=sameTeamName(row.team1?.name,f.team_a,ids[0])&&sameTeamName(row.team2?.name,f.team_b,ids[1]);
  const reverse=sameTeamName(row.team1?.name,f.team_b,ids[1])&&sameTeamName(row.team2?.name,f.team_a,ids[0]);
  return direct!==reverse?direct:null;
}
export function resultUrl(row:Row):string {
  const slug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if(typeof row.slug!=='string'||typeof row.championship?.slug!=='string'||!slug.test(row.slug)||!slug.test(row.championship.slug))throw new Error('Hawk Live: нет корректной ссылки серии.');
  return `https://hawk.live/dota-2/matches/${row.championship.slug}/${row.slug}`;
}
/** Confirm map 1 without requiring map 2/3 or a complete series score. */
export function verifiedFirstMap(row:Row,page:Row,f:Forecast,matches:NormalizedMatch[],now:number){
  const ids=forecastTeamIds(f),direct=resultOrientation(row,f),data=page.seriesPageData;
  if(!ids||direct===null||!data||data.id!==row.id||data.team1?.id!==row.team1?.id||data.team2?.id!==row.team2?.id||data.bestOf!==row.bestOf||Date.parse(data.startAt)!==Date.parse(row.startAt)||resultOrientation(data,f)!==direct)throw new Error('Не подтверждена идентичность серии для карты 1.');
  const first=Array.isArray(data.matches)?data.matches.filter((m:Row)=>m.number===1):[];
  if(first.length!==1)throw new Error('Не подтверждён номер первой карты.');
  const m=first[0],state=m.states?.at(-1),[a,b]=ids,team1Id=direct?a:b,team2Id=direct?b:a;
  if(typeof m.isTeam1Radiant!=='boolean'||typeof m.isRadiantWinner!=='boolean')throw new Error('Первая карта ещё не завершена.');
  const accounts=(radiant:boolean)=>Array.isArray(m.picks)?m.picks.filter((p:Row)=>p.isRadiant===radiant).map((p:Row)=>String(p.player?.id)).sort():[];
  const rp=accounts(true),dp=accounts(false);
  if(rp.length!==5||dp.length!==5||new Set([...rp,...dp]).size!==10||![...rp,...dp].every(id=>/^[1-9]\d*$/.test(id)))throw new Error('Не подтверждены игроки первой карты.');
  const candidates=distinctMatches(matches,now).filter(v=>!v.context_conflict&&v.series_id!=null&&v.series_type===((f.best_of??3)===3?1:0)&&v.start_time*1000>=Date.parse(f.scheduled_start_utc)-900000&&v.start_time*1000<=Date.parse(f.scheduled_start_utc)+8*3600000&&v.radiant_team_id===(m.isTeam1Radiant?team1Id:team2Id)&&v.dire_team_id===(m.isTeam1Radiant?team2Id:team1Id)&&v.radiant_win===m.isRadiantWinner&&v.radiant_kills===state?.radiantScore&&v.dire_kills===state?.direScore&&v.duration_seconds===state?.gameTime&&JSON.stringify([...v.players.radiant].sort())===JSON.stringify(rp)&&JSON.stringify([...v.players.dire].sort())===JSON.stringify(dp));
  if(candidates.length!==1)throw new Error('Нет однозначного подтверждения первой карты OpenDota.');
  const v=candidates[0],aRadiant=v.radiant_team_id===a;
  return {match_id:v.id,kills_a:aRadiant?v.radiant_kills:v.dire_kills,kills_b:aRadiant?v.dire_kills:v.radiant_kills,duration_seconds:v.duration_seconds};
}
export function verifiedResult(row:Row,page:Row,f:Forecast,matches:NormalizedMatch[],now:number):ConfirmSeriesInput {
  const fail=(message:string):never=>{throw new Error(message);};
  const ids=forecastTeamIds(f),direct=resultOrientation(row,f);
  if(!ids||direct===null)fail('Не совпадают команды, формат или время серии.');
  const data=page.seriesPageData;
  if(!data||data.id!==row.id||data.team1?.id!==row.team1?.id||data.team2?.id!==row.team2?.id||data.bestOf!==row.bestOf||Date.parse(data.startAt)!==Date.parse(row.startAt)||resultOrientation(data,f)!==direct)fail('Страница и список результатов расходятся.');
  const score=[row.team1Score,row.team2Score];
  const legal=(f.best_of??3)===3?['2:0','2:1','0:2','1:2']:['2:0','1:1','0:2'];
  if(!score.every(Number.isInteger)||!legal.includes(score.join(':'))||score[0]!==score[1]&&row.isTeam1Winner!==(score[0]>score[1]))fail('Нет окончательного счёта серии.');
  const maps=data.matches;
  if(!Array.isArray(maps)||maps.length!==score[0]+score[1])fail('Список сыгранных карт не соответствует итоговому счёту.');
  const ordered=[...maps].sort((a,b)=>a.number-b.number);
  if(ordered.some((m,i)=>m.number!==i+1||typeof m.isTeam1Radiant!=='boolean'||typeof m.isRadiantWinner!=='boolean'))fail('Не подтверждён порядок или результат каждой карты.');
  const [a,b]=ids!;const team1Id=direct?a:b,team2Id=direct?b:a;
  const valid=distinctMatches(matches,now).filter(m=>new Set([m.radiant_team_id,m.dire_team_id]).has(a)&&new Set([m.radiant_team_id,m.dire_team_id]).has(b)&&m.start_time*1000>=Date.parse(f.scheduled_start_utc)-900000&&m.start_time*1000<=Date.parse(f.scheduled_start_utc)+8*3600000);
  if(valid.some(m=>m.context_conflict))fail('Есть противоречивые данные карты этой пары; требуется проверка.');
  const mapped=ordered.map(m=>{
    const state=m.states?.at(-1);
    const accounts=(radiant:boolean)=>Array.isArray(m.picks)?m.picks.filter((p:Row)=>p.isRadiant===radiant).map((p:Row)=>String(p.player?.id)).sort():[];
    const rp=accounts(true),dp=accounts(false);
    if(rp.length!==5||dp.length!==5||new Set([...rp,...dp]).size!==10||![...rp,...dp].every(x=>/^[1-9]\d*$/.test(x)))fail(`Карта ${m.number}: источник не подтверждает игроков.`);
    const candidates=valid.filter(v=>v.radiant_team_id===(m.isTeam1Radiant?team1Id:team2Id)&&v.dire_team_id===(m.isTeam1Radiant?team2Id:team1Id)&&v.radiant_win===m.isRadiantWinner&&v.radiant_kills===state?.radiantScore&&v.dire_kills===state?.direScore&&v.duration_seconds===state?.gameTime&&JSON.stringify([...v.players.radiant].sort())===JSON.stringify(rp)&&JSON.stringify([...v.players.dire].sort())===JSON.stringify(dp));
    if(candidates.length!==1)fail(`Карта ${m.number}: ${candidates.length?'неоднозначное совпадение':'нет полной карты OpenDota; требуется догрузка'}.`);
    return candidates[0];
  });
  if(new Set(mapped.map(m=>m.id)).size!==mapped.length||new Set(mapped.map(m=>`${m.league_id}:${m.series_id}`)).size!==1||mapped.some(m=>m.series_id===null||m.series_type!==((f.best_of??3)===3?1:0)))fail('Карты не принадлежат одной серии Valve.');
  const seriesMaps=valid.filter(m=>m.league_id===mapped[0].league_id&&m.series_id===mapped[0].series_id);
  if(seriesMaps.some(m=>!mapped.some(x=>x.id===m.id)))fail('В OpenDota есть дополнительная карта: конфликт полноты серии.');
  let w1=0,w2=0;
  for(const [i,m] of mapped.entries()){
    if(i&&m.start_time<mapped[i-1].end_time||(f.best_of??3)===3&&(w1===2||w2===2))fail('Нарушен порядок завершения серии.');
    if(m.radiant_team_id===team1Id?m.radiant_win:!m.radiant_win)w1++;else w2++;
  }
  if(w1!==score[0]||w2!==score[1])fail('Победители карт не совпадают с итоговым счётом.');
  return {team_a_id:a,team_b_id:b,map_ids:mapped.map(m=>m.id),score:(direct?score:[score[1],score[0]]) as [number,number],source_url:resultUrl(row),verified_at:new Date(now).toISOString()};
}
