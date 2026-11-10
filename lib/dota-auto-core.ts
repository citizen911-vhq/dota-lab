import type { AnalysisHistory, AnalysisMap, AnalysisSeries, FixtureInput, RosterConfirmation } from './dota-analysis-types';
import type { NormalizedMatch } from './dota-opendota';
import type { Forecast, Journal, Observation } from './dota-types';
import { invariant, latestObservations, validSource } from './dota-core';

export const TEAM_NAMES: Record<string,string> = {'55':'Power Rangers','10020555':'PlayTime','10242397':'Xipto Esports','10252232':'Zenith','5014799':'Nemiga Gaming','10212329':'Team Synapse','10331884':'Froglings','10271553':'potn9ki'};
const teamId = (name: string) => Object.entries(TEAM_NAMES).find(([,n])=>n===name)?.[0];
const allowedSources = new Set(['cyberscore.live','www.cyberscore.live','liquipedia.net','dota.haglund.dev']);
const excludedRemakes = new Set(['9074604699','9044544461','9074615771']);
const validScores = new Set(['2:0','2:1','1:2','0:2']);
const knownTeam = (id: unknown): id is string => typeof id==='string' && Object.hasOwn(TEAM_NAMES,id);
const validAccounts = (accounts: (number|string)[]) => accounts.length===5 && new Set(accounts.map(String)).size===5 && accounts.every(id=>/^[1-9]\d*$/.test(String(id))&&Number.isSafeInteger(Number(id))&&Number(id)<4294967295);
const validPatch = (value: unknown): value is string => typeof value==='string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));

function checkedRoster(value: unknown, now: number): RosterConfirmation {
  invariant(!!value && typeof value==='object' && !Array.isArray(value),'Нужно подтверждение состава команды.');
  const roster=value as RosterConfirmation;
  invariant(Array.isArray(roster.account_ids) && roster.account_ids.every(id=>typeof id==='number') && validAccounts(roster.account_ids),'Нужны пять различных публичных account_id состава.');
  const verified=Date.parse(roster.verified_at);
  invariant(Number.isFinite(verified) && verified<=now && verified>=now-6*3600000,'Подтверждение состава должно быть не старше шести часов и не из будущего.');
  invariant(typeof roster.has_standin==='boolean','Нужно явно указать наличие или отсутствие замены.');
  invariant(validSource(roster.source_url) && new URL(roster.source_url).protocol==='https:' && ['cyberscore.live','www.cyberscore.live','liquipedia.net'].includes(new URL(roster.source_url).hostname),'Нужна HTTPS-ссылка на подтверждение состава в CyberScore или Liquipedia.');
  return {account_ids:[...roster.account_ids].sort((a,b)=>a-b),verified_at:new Date(verified).toISOString(),source_url:roster.source_url,has_standin:roster.has_standin};
}

function matchFacts(m:NormalizedMatch): string {
  return JSON.stringify([m.id,m.start_time,m.end_time,m.duration_seconds,m.radiant_team_id,m.dire_team_id,m.radiant_kills,m.dire_kills,m.radiant_win,m.league_id,m.series_id,m.series_type]);
}

/** Enrich missing provider context while keeping original score evidence stable. */
export function mergeMatchEvidence(old:NormalizedMatch,incoming:NormalizedMatch):NormalizedMatch {
  const conflict=matchFacts(old)!==matchFacts(incoming) ||
    (old.patch_id!=null && incoming.patch_id!=null && old.patch_id!==incoming.patch_id) ||
    (['radiant','dire'] as const).some(side=>{
      const a=old.players[side],b=incoming.players[side];
      return a.length>0 && b.length>0 && !a.every(id=>b.includes(id)) && !b.every(id=>a.includes(id));
    });
  if(conflict)return {...old,context_conflict:old.context_conflict??'Противоречие повторной проверки карты, патча или состава.'};
  return {...old,patch_id:old.patch_id??incoming.patch_id??null,
    players:{radiant:validAccounts(incoming.players.radiant)&&!validAccounts(old.players.radiant)?incoming.players.radiant:old.players.radiant,
      dire:validAccounts(incoming.players.dire)&&!validAccounts(old.players.dire)?incoming.players.dire:old.players.dire},
    sources:[...new Set([...old.sources,...incoming.sources])],
    ...(incoming.context_conflict?{context_conflict:old.context_conflict??incoming.context_conflict}:{}),
  };
}

/** Repeated discovery is harmless; conflicting copies are not usable evidence. */
function distinctMatches(matches:NormalizedMatch[],now=Date.now()): NormalizedMatch[] {
  const unique=new Map<string,NormalizedMatch>(),conflicts=new Set<string>();
  for(const m of matches) {
    if(excludedRemakes.has(m.id)||m.id!==m.match_id||!/^\d+$/.test(m.id)||m.radiant_team_id===m.dire_team_id)continue;
    if(!Number.isSafeInteger(m.start_time)||!Number.isInteger(m.duration_seconds)||m.duration_seconds<=0||m.duration_seconds>86400||m.end_time!==m.start_time+m.duration_seconds||m.end_time*1000>now)continue;
    if(typeof m.radiant_win!=='boolean'||![m.radiant_kills,m.dire_kills].every(k=>Number.isInteger(k)&&k>=0&&k<=500))continue;
    if(!m.sources?.length||!m.sources.every(validSource))continue;
    const old=unique.get(m.id);
    if(old&&matchFacts(old)!==matchFacts(m))conflicts.add(m.id);
    else if(!old)unique.set(m.id,m);
    else unique.set(m.id,mergeMatchEvidence(old,m));
  }
  return [...unique.values()].filter(m=>!conflicts.has(m.id));
}

function legalBo3Order(group:AnalysisMap[],score: number[]): boolean {
  if(!validScores.has(score.join(':'))||group.length!==score[0]+score[1]||new Set(group.map(m=>m.match_id)).size!==group.length)return false;
  if(group.some((m,i)=>i>0&&m.start_time<group[i-1].start_time+group[i-1].duration_seconds))return false;
  // A BO3 ends when either team reaches two wins.
  let a=0,b=0;
  for(let i=0;i<group.length;i++) {
    if(a===2||b===2)return false;
    if(group[i].win)a++;else b++;
  }
  return a===score[0]&&b===score[1];
}

export function checkedFixture(input: unknown, now=Date.now()): FixtureInput {
  invariant(!!input && typeof input==='object' && !Array.isArray(input),'Нужны данные подтверждённой серии.');
  const f=input as FixtureInput;
  invariant(knownTeam(f.team_a_id) && knownTeam(f.team_b_id) && f.team_a_id!==f.team_b_id,'Неизвестная команда: используйте подтверждённый Valve team ID.');
  invariant(f.best_of===3 && f.status==='scheduled','Поддерживаются только предстоящие BO3.');
  const start=Date.parse(f.scheduled_start_utc),verified=Date.parse(f.verified_at);
  invariant(Number.isFinite(start) && start>now && start<=now+48*3600000,'Нужен будущий матч в ближайшие 48 часов.');
  invariant(Number.isFinite(verified) && verified<=now && verified>=now-6*3600000,'Подтверждение расписания должно быть не старше шести часов и не из будущего.');
  invariant(validSource(f.source_url) && new URL(f.source_url).protocol==='https:' && allowedSources.has(new URL(f.source_url).hostname),'Используйте HTTPS-ссылку на CyberScore, Liquipedia или открытый календарь Haglund.');
  invariant(!f.provider_id || typeof f.provider_id==='string' && f.provider_id.length<=160,'Некорректный ID расписания.');
  invariant(f.patch_id===undefined || validPatch(f.patch_id),'Некорректный подтверждённый ID патча.');
  let rosters: FixtureInput['rosters'];
  if(f.rosters!==undefined) {
    invariant(!!f.rosters && typeof f.rosters==='object' && !Array.isArray(f.rosters),'Нужны подтверждённые составы обеих команд.');
    rosters={team_a:checkedRoster(f.rosters.team_a,now),team_b:checkedRoster(f.rosters.team_b,now)};
    invariant(!rosters.team_a.account_ids.some(id=>rosters!.team_b.account_ids.includes(id)),'Один игрок не может входить в оба состава предстоящей серии.');
  }
  return {team_a_id:f.team_a_id,team_b_id:f.team_b_id,scheduled_start_utc:new Date(start).toISOString(),source_url:f.source_url,best_of:3,status:'scheduled',verified_at:new Date(verified).toISOString(),...(f.provider_id?{provider_id:f.provider_id}:{}),...(f.league_id?{league_id:String(f.league_id)}:{}),...(f.league?{league:String(f.league).slice(0,200)}:{}),...(f.patch_id!==undefined?{patch_id:f.patch_id}:{}),...(rosters?{rosters}:{})};
}

export function knownFixture(f:FixtureInput,forecasts:Forecast[]): Forecast|undefined {
  const a=TEAM_NAMES[f.team_a_id],b=TEAM_NAMES[f.team_b_id];
  return forecasts.find(x => ((x.team_a===a&&x.team_b===b)||(x.team_a===b&&x.team_b===a)) && Math.abs(Date.parse(x.scheduled_start_utc)-Date.parse(f.scheduled_start_utc))<18*3600000);
}

export function historyFromMatches(seed:AnalysisHistory,matches:NormalizedMatch[],journal:Journal,now=Date.now()): AnalysisHistory {
  const rows=new Map(seed.maps.map(m=>[`${m.team_id}:${m.match_id}`,m]));
  for(const m of distinctMatches(matches,now)) for(const radiant of [true,false]) {
    const id=radiant?m.radiant_team_id:m.dire_team_id,opponent=radiant?m.dire_team_id:m.radiant_team_id;
    const row:AnalysisMap={team_id:id,team:TEAM_NAMES[id]??`Team ${id}`,opponent_team_id:opponent,opponent:TEAM_NAMES[opponent]??`Team ${opponent}`,match_id:m.id,start_time:m.start_time,duration_seconds:m.duration_seconds,team_kills:radiant?m.radiant_kills:m.dire_kills,opponent_kills:radiant?m.dire_kills:m.radiant_kills,win:radiant?m.radiant_win:!m.radiant_win,league_id:m.league_id,series_id:m.series_id===null?null:String(m.series_id),series_type:m.series_type,series_key:m.series_id===null?null:`${m.league_id}:${m.series_id}`,patch_id:validPatch(m.patch_id)?m.patch_id:null,players:(radiant?m.players.radiant:m.players.dire).map(Number),sources:m.sources,forecast_sample:true,verified_at:new Date(now).toISOString()};
    const key=`${id}:${m.id}`,old=rows.get(key);
    if(m.context_conflict){row.forecast_sample=false;row.series_excluded_reason=m.context_conflict;}
    if(!old)rows.set(key,row);
    else {
      const oldPlayers=old.players??[],newPlayers=row.players??[];
      const playerConflict=oldPlayers.length>0 && newPlayers.length>0 && !oldPlayers.every(account=>newPlayers.includes(account)) && !newPlayers.every(account=>oldPlayers.includes(account));
      const conflict=!!m.context_conflict || analysisFacts(old)!==analysisFacts(row) ||
        (old.patch_id!=null && row.patch_id!=null && old.patch_id!==row.patch_id) || playerConflict ||
        (old.series_id!=null && row.series_id!=null && old.series_id!==row.series_id);
      if(conflict) {
        // Preserve the original audited evidence; quarantine it for modelling.
        rows.set(key,{...old,forecast_sample:false,series_excluded_reason:old.series_excluded_reason??'Противоречие повторной проверки карты, патча или состава.'});
      } else {
        const patch=old.patch_id??row.patch_id;
        const enrichedPlayers=validAccounts(newPlayers) && !validAccounts(oldPlayers)?newPlayers:old.players;
        if(patch!==old.patch_id || enrichedPlayers!==old.players)rows.set(key,{...old,patch_id:patch,players:enrichedPlayers,sources:[...new Set([...old.sources,...row.sources])],verified_at:new Date(now).toISOString()});
      }
    }
  }
  // A listing can omit a map. Only a verified official result and its explicit
  // first-map ID allow a newly collected series into the BO3 sample.
  const series=new Map(seed.series.map(s=>[`${s.team_id}:${s.series_key}`,s]));
  const excludedSeries=new Set(seed.series.filter(s=>!s.complete_bo3||s.forecast_sample===false||s.excluded_reason).map(s=>s.series_key));
  for(const [fixtureId,o] of latestObservations(journal.observations)) {
    const f=journal.forecasts.find(f=>f.fixture_id===fixtureId);
    if(!f||!o.series_score||!validScores.has(o.series_score.join(':'))||o.series_void||o.map1_void||!o.map1?.match_id||!Number.isFinite(Date.parse(o.recorded_utc))||Date.parse(o.recorded_utc)>now)continue;
    const a=teamId(f.team_a),b=teamId(f.team_b);if(!a||!b)continue;
    const first=rows.get(`${a}:${o.map1.match_id}`);if(!first?.series_key||first.series_type!==1||excludedSeries.has(first.series_key))continue;
    const fixtureStart=Date.parse(f.scheduled_start_utc)/1000;
    if(first.start_time<fixtureStart-900||first.start_time>fixtureStart+8*3600)continue;
    if(o.map1.kills_a!=null&&o.map1.kills_a!==first.team_kills||o.map1.kills_b!=null&&o.map1.kills_b!==first.opponent_kills||o.map1.duration_seconds!=null&&o.map1.duration_seconds!==first.duration_seconds)continue;
    const group=[...rows.values()].filter(m=>m.team_id===a&&m.opponent_team_id===b&&m.series_key===first.series_key).sort((x,y)=>x.start_time-y.start_time);
    if(!legalBo3Order(group,o.series_score)||group[0].match_id!==String(o.map1.match_id)||group.some(m=>m.series_type!==1||m.series_excluded_reason||m.forecast_sample===false||excludedRemakes.has(m.match_id)))continue;
    if(group.some(m=>(m.start_time+m.duration_seconds)*1000>Math.min(now,Date.parse(o.recorded_utc))))continue;
    for(const side of [0,1]) {
      const id=side?b:a,opponent=side?a:b;
      const s:AnalysisSeries={series_key:first.series_key,team_id:id,team:TEAM_NAMES[id],opponent_team_id:opponent,opponent:TEAM_NAMES[opponent],start_time:group[0].start_time,end_time:group.at(-1)!.start_time+group.at(-1)!.duration_seconds,score_team:o.series_score[side],score_opponent:o.series_score[1-side],map_ids:group.map(m=>m.match_id),complete_bo3:true,forecast_sample:true,sources:[...new Set([...o.sources,...group.flatMap(m=>m.sources)])],verified_at:o.recorded_utc};
      if(!series.has(`${id}:${s.series_key}`))series.set(`${id}:${s.series_key}`,s);
      for(const [index,map] of group.entries()) {
        const key=`${id}:${map.match_id}`,existing=rows.get(key);
        if(existing && (existing.map_number==null || existing.map_number===index+1))rows.set(key,{...existing,map_number:index+1});
        else if(existing)rows.set(key,{...existing,forecast_sample:false,series_excluded_reason:existing.series_excluded_reason??'Противоречивый номер карты в подтверждённой серии.'});
      }
    }
  }
  return {...seed,maps:[...rows.values()],series:[...series.values()]};
}

// Three validated maps with an unbroken 2:1 finish establish map order. Two
// observed wins alone never establish a 2:0: a missing loss remains possible.
export function firstMapEvidence(f:Forecast,matches:NormalizedMatch[],now=Date.now()): Observation['map1']|null {
  const a=teamId(f.team_a),b=teamId(f.team_b),start=Date.parse(f.scheduled_start_utc)/1000;
  if(!a||!b||!Number.isFinite(start)||start*1000>now)return null;
  const groups=new Map<string,NormalizedMatch[]>();
  for(const m of distinctMatches(matches,now)) {
    if(m.series_type!==1||m.series_id===null||m.start_time<start-900||m.start_time>start+8*3600)continue;
    if(!((m.radiant_team_id===a&&m.dire_team_id===b)||(m.radiant_team_id===b&&m.dire_team_id===a)))continue;
    const key=`${m.league_id}:${m.series_id}`;groups.set(key,[...(groups.get(key)??[]),m]);
  }
  if(groups.size!==1)return null;
  const maps=[...groups.values()][0].sort((x,y)=>x.start_time-y.start_time);
  if(maps.length!==3||maps.some((m,i)=>i>0&&m.start_time<maps[i-1].end_time))return null;
  const wins=maps.map(m=>m.radiant_team_id===a?m.radiant_win:!m.radiant_win);
  if(wins[0]===wins[1]||![1,2].includes(wins.filter(Boolean).length))return null;
  const m=maps[0],aRadiant=m.radiant_team_id===a;
  return {match_id:m.id,kills_a:aRadiant?m.radiant_kills:m.dire_kills,kills_b:aRadiant?m.dire_kills:m.radiant_kills,duration_seconds:m.duration_seconds};
}

export function rosterAlerts(matches:NormalizedMatch[],baseline:Record<string,{account_ids:(string|number)[];observed_start_time?:number;start_time?:number}>,now=Date.now()): Record<string,string> {
  const result:Record<string,string>={};
  const verifiedMatches=distinctMatches(matches,now);
  for(const id of Object.keys(TEAM_NAMES)) {
    const latest=verifiedMatches.filter(m=>m.radiant_team_id===id||m.dire_team_id===id).sort((a,b)=>b.start_time-a.start_time)[0],base=baseline[id];
    if(!latest)continue;
    if(!base||!validAccounts(base.account_ids)){result[id]='Нет подтверждённого исходного состава для сравнения.';continue;}
    if(latest.start_time<(base.observed_start_time??base.start_time??0))continue;
    const accounts=latest.radiant_team_id===id?latest.players.radiant:latest.players.dire;
    if(!validAccounts(accounts)){result[id]='Последний состав не подтверждён полностью.';continue;}
    if(accounts.map(String).sort().join(',')!==base.account_ids.map(String).sort().join(','))result[id]='Состав отличается от исходной выборки; требуется проверка истории состава.';
  }
  return result;
}

export interface ConfirmSeriesInput {
  team_a_id: string; team_b_id: string;
  /** All played maps, in official order, including the explicitly identified map 1. */
  map_ids: string[]; score: [number,number]; source_url: string; verified_at: string;
}

function orientedMap(row:AnalysisMap,teamId:string):AnalysisMap {
  if(row.team_id===teamId)return row;
  return {...row,team_id:row.opponent_team_id,team:row.opponent,opponent_team_id:row.team_id,opponent:row.team,
    team_kills:row.opponent_kills,opponent_kills:row.team_kills,win:!row.win,players:undefined};
}

function analysisFacts(row:AnalysisMap):string {
  return JSON.stringify([row.team_id,row.opponent_team_id,row.start_time,row.duration_seconds,row.team_kills,row.opponent_kills,row.win,row.league_id]);
}

/** Turn independently checked official evidence into two complete BO3 records.
 * A winning map count alone is never sufficient. Sources must explicitly identify
 * the series score and the complete ordered map list supplied by the caller.
 */
export function confirmSeries(history:AnalysisHistory,value:unknown,now=Date.now()):AnalysisSeries[] {
  invariant(!!value&&typeof value==='object'&&!Array.isArray(value),'Нужны подтверждённые данные серии.');
  const input=value as ConfirmSeriesInput;
  invariant(typeof input.team_a_id==='string'&&typeof input.team_b_id==='string'&&/^[1-9]\d*$/.test(input.team_a_id)&&/^[1-9]\d*$/.test(input.team_b_id)&&input.team_a_id!==input.team_b_id,'Нужны разные подтверждённые Valve team ID.');
  invariant(Array.isArray(input.score)&&input.score.length===2&&input.score.every(Number.isInteger)&&validScores.has(input.score.join(':')),'Нужен официальный счёт завершённой BO3.');
  invariant(Array.isArray(input.map_ids)&&input.map_ids.length===input.score[0]+input.score[1]&&new Set(input.map_ids).size===input.map_ids.length&&input.map_ids.every(id=>typeof id==='string'&&/^[1-9]\d*$/.test(id)),'Укажите все уникальные ID карт в официальном порядке.');
  const verified=Date.parse(input.verified_at);
  invariant(Number.isFinite(now)&&Number.isFinite(verified)&&verified<=now&&verified>=now-6*3600000,'Официальный результат должен быть проверен за последние шесть часов.');
  invariant(validSource(input.source_url)&&new URL(input.source_url).protocol==='https:'&&['cyberscore.live','www.cyberscore.live','liquipedia.net'].includes(new URL(input.source_url).hostname),'Нужна HTTPS-ссылка на официальный результат в CyberScore или Liquipedia.');
  const pair=new Set([input.team_a_id,input.team_b_id]);
  const allRows:AnalysisMap[]=[];
  const maps=input.map_ids.map(id=>{
    invariant(!excludedRemakes.has(id),'Ремейк нельзя включать в подтверждённую BO3.');
    const records=history.maps.filter(m=>m.match_id===id&&pair.has(m.team_id)&&pair.has(m.opponent_team_id)&&m.team_id!==m.opponent_team_id);
    invariant(records.length>0,'Карта отсутствует в проверенной истории этой пары: '+id);
    invariant(records.every(m=>m.forecast_sample!==false&&!m.series_excluded_reason),'Карта исключена из выборки: '+id);
    const oriented=records.map(m=>orientedMap(m,input.team_a_id));
    invariant(new Set(oriented.map(analysisFacts)).size===1,'Противоречивые данные карты: '+id);
    const row=oriented[0];
    invariant(Number.isSafeInteger(row.start_time)&&row.start_time>0&&Number.isInteger(row.duration_seconds)&&row.duration_seconds>0&&row.duration_seconds<=86400&&typeof row.win==='boolean','Некорректные факты карты: '+id);
    invariant([row.team_kills,row.opponent_kills].every(k=>Number.isInteger(k)&&k>=0&&k<=500),'Некорректный финальный счёт убийств карты: '+id);
    invariant((row.start_time+row.duration_seconds)*1000<=verified,'Карта ещё не завершилась на момент проверки результата: '+id);
    invariant(records.every(m=>!m.verified_at||Number.isFinite(Date.parse(m.verified_at))&&Date.parse(m.verified_at)<=now),'Карта ещё не была подтверждена на момент этого среза: '+id);
    invariant(records.every(m=>m.series_type===null||m.series_type===1),'Одна из карт не относится к BO3.');
    invariant(records.every(m=>m.sources.length>0&&m.sources.every(validSource)),'Нет источников фактов карты: '+id);
    allRows.push(...records);
    return row;
  });
  invariant(new Set(maps.map(m=>m.league_id)).size===1&&maps[0].league_id.length>0,'Карты относятся к разным турнирам.');
  invariant(legalBo3Order(maps,input.score),'Порядок карт или число побед не соответствуют завершённой BO3.');
  const rawIds=[...new Set(allRows.map(m=>m.series_id).filter((id):id is string=>id!==null))];
  invariant(rawIds.length<=1,'Карты имеют разные series_id источника.');
  const keys=[...new Set(allRows.map(m=>m.series_key).filter((key):key is string=>!!key))];
  invariant(keys.length<=1,'Карты уже привязаны к разным сериям.');
  const key=keys[0]??`verified:${input.map_ids.join('-')}`;
  invariant(!history.series.some(s=>(s.series_key===key||s.map_ids.some(id=>input.map_ids.includes(id)))&&(!s.complete_bo3||s.forecast_sample===false||!!s.excluded_reason)),'Серия уже исключена из аудированной истории; нужна отдельная проверка конфликта.');
  const sourceUrls=[...new Set([input.source_url,...allRows.flatMap(m=>m.sources)])];
  return [0,1].map(side=>({series_key:key,team_id:side?input.team_b_id:input.team_a_id,
    team:side?(TEAM_NAMES[input.team_b_id]??maps[0].opponent):(TEAM_NAMES[input.team_a_id]??maps[0].team),
    opponent_team_id:side?input.team_a_id:input.team_b_id,
    opponent:side?(TEAM_NAMES[input.team_a_id]??maps[0].team):(TEAM_NAMES[input.team_b_id]??maps[0].opponent),
    start_time:maps[0].start_time,end_time:maps.at(-1)!.start_time+maps.at(-1)!.duration_seconds,
    score_team:input.score[side],score_opponent:input.score[1-side],map_ids:[...input.map_ids],complete_bo3:true,forecast_sample:true,
    sources:sourceUrls,verified_at:new Date(now).toISOString(),
  }));
}

/** Enrich map-to-series linkage without changing audited score or source facts. */
export function mergeVerifiedSeries(history:AnalysisHistory,incoming:AnalysisSeries[]):AnalysisHistory {
  const groups=new Map<string,AnalysisSeries[]>();
  for(const s of incoming)groups.set(s.series_key,[...(groups.get(s.series_key)??[]),s]);
  for(const [key,pair] of groups) {
    invariant(pair.length===2&&pair[0].team_id===pair[1].opponent_team_id&&pair[1].team_id===pair[0].opponent_team_id&&pair[0].team_id!==pair[1].team_id,'Подтверждение серии должно содержать обе командные перспективы.');
    invariant(pair.every(s=>s.complete_bo3&&s.forecast_sample!==false&&!s.excluded_reason&&validScores.has(`${s.score_team}:${s.score_opponent}`)),'Нельзя добавить неполную или исключённую серию.');
    invariant(pair.every(s=>s.map_ids.length===s.score_team+s.score_opponent&&new Set(s.map_ids).size===s.map_ids.length),'Подтверждение должно содержать полный список уникальных карт.');
    invariant(pair[0].score_team===pair[1].score_opponent&&pair[0].score_opponent===pair[1].score_team&&JSON.stringify(pair[0].map_ids)===JSON.stringify(pair[1].map_ids),'Командные перспективы серии противоречат друг другу.');
    for(const s of pair) {
      for(const old of history.series.filter(old=>old.series_key===key||old.map_ids.some(id=>s.map_ids.includes(id)))) {
        invariant(old.series_key===key&&old.complete_bo3&&old.forecast_sample!==false&&!old.excluded_reason,'Подтверждение конфликтует с аудированной серией.');
        if(old.team_id===s.team_id)invariant(old.opponent_team_id===s.opponent_team_id&&old.score_team===s.score_team&&old.score_opponent===s.score_opponent&&old.map_ids.every(id=>s.map_ids.includes(id)),'Нельзя переписать ранее подтверждённый счёт или список карт.');
      }
      for(const id of s.map_ids) {
        const records=history.maps.filter(m=>m.match_id===id);
        invariant(records.length>0&&records.every(m=>!m.series_key||m.series_key===key),'Карта отсутствует в истории или уже принадлежит другой серии.');
      }
    }
  }
  const mapKeys=new Map<string,string>(),mapNumbers=new Map<string,number>();
  for(const s of incoming)for(const id of s.map_ids) {
    invariant(!mapKeys.has(id)||mapKeys.get(id)===s.series_key,'Одна карта не может принадлежать двум сериям.');
    mapKeys.set(id,s.series_key);
    const position=s.map_ids.indexOf(id)+1;
    invariant(!mapNumbers.has(id)||mapNumbers.get(id)===position,'Подтверждения содержат разный порядок карт.');
    invariant(history.maps.filter(m=>m.match_id===id).every(m=>m.map_number==null||m.map_number===position),'Нельзя переписать ранее подтверждённый номер карты.');
    mapNumbers.set(id,position);
  }
  const series=new Map(history.series.map(s=>[`${s.team_id}:${s.series_key}`,s]));
  for(const s of incoming)if(!series.has(`${s.team_id}:${s.series_key}`))series.set(`${s.team_id}:${s.series_key}`,s);
  return {...history,maps:history.maps.map(m=>mapKeys.has(m.match_id)?{...m,series_key:m.series_key??mapKeys.get(m.match_id)!,map_number:mapNumbers.get(m.match_id)!}:m),series:[...series.values()]};
}
