import { experimentJournal, inCurrentExperiment, JOURNAL_START_MS } from './dota-experiment';
import { runPaperAuto } from './dota-paper-auto';
import { rankPrimaryTeams } from './dota-ranking';
import {expandTeamPool,expansionPool,expansionHistory,expansionGate,EXPANSION_POLICY,type ExpansionSnapshot} from './dota-expansion';
import { runOpenaiSearch } from './dota-openai-store';
import { env } from 'cloudflare:workers';
import historySeed from '../data/history-seed.json';
import { BASELINE_ROSTERS } from './dota-rosters';
import type { AnalysisHistory, AnalysisSeries, FixtureInput, TeamRating } from './dota-analysis-types';
import type { NormalizedMatch } from './dota-opendota';
import { primaryTeamPool, type DynamicTeamPoolEntry } from './dota-team-pool';
import type { Forecast, Team } from './dota-types';
import { collectOpenDota } from './dota-opendota';
import { fetchHaglundSchedule, parseHaglundSchedule, TRACKED_SCHEDULE_TEAMS } from './dota-schedule-source';
import { fetchCurrentPatch, type CurrentPatch } from './dota-patch';
import { buildForecasts, buildTeamRatings, fixtureKey, sampleTeam, TRACKED_TEAMS } from './dota-analysis';
import { checkedFixture, confirmSeries, firstMapEvidence, historyFromMatches, knownFixture, mergeMatchEvidence, mergeVerifiedSeries, rosterAlerts, TEAM_NAMES } from './dota-auto-core';
import { canonical, dashboard, DataError, invariant, latestObservations } from './dota-core';
import { loadJournal, recordResult, syncJournal } from './dota-store';

type Uncertainty = {fixture_id:string;fixture:string;reason:string};
type Run = {run_id:string;status:'running'|'ok'|'partial'|'failed';started_at:string;finished_at:string|null;maps_added:number;forecasts_added:number;observations_added:number;fixtures_seen:number;backlog_count:number;source_requests:number;opendota_requests:number;collection_healthy:boolean;rate_limited:boolean;history_maps:number;warnings:string[];skipped:Uncertainty[]};
type RecordRow = {key:string;payload:string;updated_utc:string};
type Schedule = {enabled:boolean;id?:string;time?:string;timezone?:string;until?:string};
const seed=historySeed as AnalysisHistory;
const HISTORY_REFRESH_MS=10*60_000;
// At OpenDota's current $0.01 / 100 calls this is $14.50 per UTC month,
// leaving a $0.50 safety margin below the requested $15 ceiling.
const OPENDOTA_MONTHLY_REQUEST_CAP=145_000;
const hasRoster=(players?:unknown[])=>Array.isArray(players)&&players.length===5&&new Set(players.map(String)).size===5&&players.every(id=>/^[1-9]\d*$/.test(String(id))&&Number.isSafeInteger(Number(id))&&Number(id)<4294967295);
const COVERAGE='Открытый календарь охватывает только часть турниров; DreamLeague Division 2 требует отдельной проверки расписания. Индекс OpenDota может пропускать карты. История сохраняется, пропуски не заменяются нулями.';
const SERVICE_ROUTES={access:'Use a fresh get_site service token only on this owner-private Site: OAI-Sites-Authorization: Bearer TOKEN. Never log or persist it.',status:'GET /api/analysis/status',run:'POST /api/analysis/run with JSON {} or {fixtures:[{team_a_id,team_b_id,scheduled_start_utc,source_url,best_of:2|3,status:"scheduled",verified_at,provider_id?,rosters:{team_a:{account_ids:[5 Valve IDs],verified_at,source_url,has_standin:false},team_b:{...}}}]}',confirm:'POST /api/analysis/confirm-series with JSON {team_a_id,team_b_id,map_ids:[ordered Valve IDs as strings],score:[integer,integer],source_url,verified_at}. Use explicitly checked CyberScore/Liquipedia evidence and maps already in history.'};
function db(){if(!env.DB)throw new DataError('Хранилище автоанализа недоступно.',503);return env.DB;}
async function records(prefix:string){return (await db().prepare('SELECT key,payload,updated_utc FROM dota_analysis_records WHERE key LIKE ?').bind(prefix+'%').all<RecordRow>()).results;}
async function writeRecord(key:string,value:unknown){await db().prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(key,canonical(value),new Date().toISOString()).run();}
async function openDotaMonthlyUsage(now:number){
  const date=new Date(now),monthStart=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)).toISOString();
  const rows=await db().prepare('SELECT payload FROM dota_analysis_runs WHERE started_utc>=?').bind(monthStart).all<{payload:string}>();
  const used=rows.results.reduce((sum,row)=>{
    try{
      const run=JSON.parse(row.payload) as Partial<Run>;
      const requests=Number(run.opendota_requests??Math.max(0,Number(run.source_requests??0)-2));
      return sum+(Number.isSafeInteger(requests)&&requests>0?requests:0);
    }catch{return sum;}
  },0);
  return {month_start_utc:monthStart,cap:OPENDOTA_MONTHLY_REQUEST_CAP,used,remaining:Math.max(0,OPENDOTA_MONTHLY_REQUEST_CAP-used),estimated_usd:used/10_000};
}

export async function readTeamRanking(){
  const [meta,stored,loaded]=await Promise.all([records('state:'),records('match:'),loadJournal()]);
  const values=Object.fromEntries(meta.map(r=>[r.key,JSON.parse(r.payload)]));
  const patch=values['state:current_patch'] as CurrentPatch|undefined;
  const now=Date.now(),health=values['state:betting_health'];
  const history=historyFromMatches(seed,stored.map(r=>JSON.parse(r.payload)),loaded.journal,now);
  const snapshot=(values['state:expansion'] as ExpansionSnapshot|undefined)??expandTeamPool(history,[],undefined,now,patch?.patch_id??null,false);
  const pool=expansionPool(snapshot,[],values['state:team_pool']??[]);
  const previous=(await db().prepare("SELECT payload FROM dota_analysis_records WHERE key LIKE 'ranking:%' ORDER BY updated_utc DESC LIMIT 30").all<{payload:string}>()).results.map(r=>JSON.parse(r.payload) as ExpansionSnapshot);
  const fresh=(at:string|undefined,age:number)=>!!at&&Date.parse(at)<=now&&now-Date.parse(at)<=age;
  return {teams:rankPrimaryTeams(pool,patch?.patch_id?buildTeamRatings(expansionHistory(history,snapshot,now),now,patch.patch_id):[]),expansion:snapshot,policy:EXPANSION_POLICY,ranking_history:previous.map(s=>({at:s.at,teams:s.rows.map(r=>({team_id:r.team_id,rank:r.rank,win_rate:r.win_rate,status:r.status}))})),history_queue:values['state:history_queue']??[],exclusions:values['state:exclusions']??[],
    patch_name:patch?.patch_name??null,patch_verified_at:patch?.verified_at??null,patch_fresh:fresh(patch?.verified_at,600000),
    history_verified_at:health?.verified_at??null,history_healthy:health?.healthy===true&&fresh(health?.verified_at,6*3600000),calculated_at:new Date(now).toISOString()};
}

export async function analysisStatus(){
  const [runs,meta,matchRows,verifiedRows,loaded,openDotaBudget]=await Promise.all([
    db().prepare('SELECT payload FROM dota_analysis_runs ORDER BY started_utc DESC LIMIT 10').all<{payload:string}>(),
    records('state:'),records('match:'),records('verified:'),loadJournal(),openDotaMonthlyUsage(Date.now()),
  ]);
  const values=Object.fromEntries(meta.map(r=>[r.key,JSON.parse(r.payload)]));
  const recent=runs.results.map(r=>JSON.parse(r.payload) as Run).filter(r=>Date.parse(r.started_at)>=JOURNAL_START_MS);
  const verified=verifiedRows.flatMap(r=>JSON.parse(r.payload) as AnalysisSeries[]),verifiedIds=new Set(verified.flatMap(s=>s.map_ids));
  const unknown=matchRows.map(r=>JSON.parse(r.payload) as NormalizedMatch).filter(m=>!verifiedIds.has(m.id));
  const d=dashboard(experimentJournal(loaded.journal,primaryTeamPool()),loaded.storage,loaded.updated);
  const currentPatch=values['state:current_patch'] as CurrentPatch|undefined;
  const currentHistory=mergeVerifiedSeries(historyFromMatches(seed,matchRows.map(r=>JSON.parse(r.payload)),loaded.journal),verified);
  const currentPatchFresh=currentPatch?.patch_id && Date.now()-Date.parse(currentPatch.verified_at)<=10*60000 && Date.parse(currentPatch.verified_at)<=Date.now();
  const teamPool=expansionPool(values['state:expansion'],[],(values['state:team_pool']??[]) as DynamicTeamPoolEntry[]);
  return {coverage:'dynamic-top20',coverage_note:COVERAGE,tracked_teams:teamPool.length,team_pool:teamPool,baseline_rosters:BASELINE_ROSTERS,roster_policy:'informational-v1',history_maps:new Set([...seed.maps.map(m=>m.match_id),...matchRows.map(r=>(JSON.parse(r.payload) as NormalizedMatch).id)]).size,current_patch:currentPatch??null,uncertainty_pool:recent.length?(values['state:uncertainty_pool']??[]):[],betting_health:values['state:betting_health']??null,team_ratings:currentPatchFresh?buildTeamRatings(currentHistory,Date.now(),currentPatch.patch_id!):[],schedule:values['state:schedule']??null,last_run:recent[0]??null,recent_runs:recent,roster_alerts:values['state:roster_alerts']??{},pending_review:d.fixtures.filter(f=>Date.parse(f.scheduled_start_utc)<Date.now()&&!f.observation?.series_void&&(!f.observation?.series_score||!f.observation?.map1||f.observation.map1.kills_a==null||f.observation.map1.duration_seconds==null)).map(f=>({fixture_id:f.fixture_id,team_a:f.team_a,team_b:f.team_b,scheduled_start_utc:f.scheduled_start_utc,observation:f.observation})),unverified_maps:unknown.slice(-100),unverified_maps_total:unknown.length,evaluation:{summary:d.summary,daily:d.daily,calibration:d.calibration},source_access:{opendota_key_configured:!!env.OPENDOTA_API_KEY},source_budget:{opendota:openDotaBudget,price_assumption:'$0.01 per 100 requests',monthly_ceiling_usd:15},updater_instructions:{service_routes:SERVICE_ROUTES,forecast_window_hours:144,schedule_window_hours:192,bet_recalculation_max_history_age_minutes:10,source:'https://api.opendota.com/api',schedule_source:'https://dota.haglund.dev/v1/matches',fallback_schedule_source:'https://cyberscore.live/en/matches/',rule:'Use the fixed 12-team core plus up to 8 qualified challengers from the rolling TOP-20; roster differences are informational and do not block forecasts or paper bets. Review unverified maps and roster evidence; never infer missing results or identities.',teams:Object.fromEntries(teamPool.map(team=>[team.id,team.name]))}};
}

async function settleConfirmed(history:AnalysisHistory,confirmed:AnalysisSeries[]){
  let added=0;const issues:string[]=[];
  const loaded=await loadJournal(),latest=latestObservations(loaded.journal.observations);
  for(const f of new Map(loaded.journal.forecasts.filter(inCurrentExperiment).map(f=>[f.fixture_id,f])).values()){
    const a=String(f.team_a_id??Object.keys(TEAM_NAMES).find(id=>TEAM_NAMES[id]===f.team_a)??''),b=String(f.team_b_id??Object.keys(TEAM_NAMES).find(id=>TEAM_NAMES[id]===f.team_b)??''),start=Date.parse(f.scheduled_start_utc)/1000;
    const candidates=confirmed.filter(s=>s.team_id===a&&s.opponent_team_id===b&&s.start_time>=start-900&&s.start_time<=start+8*3600);
    if(candidates.length!==1)continue;
    const s=candidates[0],first=history.maps.find(m=>m.team_id===a&&m.match_id===s.map_ids[0]);if(!first)continue;
    const previous=latest.get(f.fixture_id),map1={match_id:first.match_id,kills_a:first.team_kills,kills_b:first.opponent_kills,duration_seconds:first.duration_seconds},score=[s.score_team,s.score_opponent];
    const conflict=previous?.series_void||previous?.map1_void||(previous?.series_score&&canonical(previous.series_score)!==canonical(score))||(previous?.map1&&(['match_id','kills_a','kills_b','duration_seconds'] as const).some(k=>previous.map1?.[k]!=null&&String(previous.map1[k])!==String(map1[k])));
    if(conflict){issues.push(`${f.team_a} — ${f.team_b}: подтверждение расходится с журналом, требуется отдельное исправление.`);continue;}
    if(previous?.series_score&&previous.map1&&(['match_id','kills_a','kills_b','duration_seconds'] as const).every(k=>String(previous.map1?.[k])===String(map1[k])))continue;
    const r=await recordResult({fixture_id:f.fixture_id,series_score:score,map1,sources:s.sources.slice(0,20),...(previous?{supersedes:previous.observation_id}:{}),note:'Официальный счёт проверен по источнику; все карты серии сопоставлены с данными OpenDota.'},'automatic-verified');
    added+=r.inserted_observations;
  }
  return {added,issues};
}

export async function confirmAnalysisSeries(value:unknown){
  const [stored,verifiedRows,loaded]=await Promise.all([records('match:'),records('verified:'),loadJournal()]);
  const previous=verifiedRows.flatMap(r=>JSON.parse(r.payload) as AnalysisSeries[]);
  let history=mergeVerifiedSeries(historyFromMatches(seed,stored.map(r=>JSON.parse(r.payload)),loaded.journal),previous);
  const confirmed=confirmSeries(history,value,Date.now());
  history=mergeVerifiedSeries(history,confirmed);
  const key='verified:'+confirmed[0].series_key;
  const existing=verifiedRows.find(r=>r.key===key);
  if(!existing)await writeRecord(key,confirmed);
  const settlement=await settleConfirmed(history,existing?JSON.parse(existing.payload):confirmed);
  return {ok:true,inserted_series:existing?0:1,inserted_observations:settlement.added,issues:settlement.issues,series:confirmed.map(s=>({team:s.team,opponent:s.opponent,score:[s.score_team,s.score_opponent],map_ids:s.map_ids}))};
}

export async function configureAnalysisSchedule(value:unknown){
  invariant(!!value&&typeof value==='object'&&!Array.isArray(value),'Нужны сведения о сохранённом расписании.');
  const s=value as Schedule;
  invariant(typeof s.enabled==='boolean','Укажите enabled.');
  invariant(!s.enabled||(typeof s.id==='string'&&s.id.length>0&&s.id.length<200&&s.time==='17:00'&&s.timezone==='Asia/Yakutsk'&&s.until==='2026-12-08'),'Нужно уже сохранённое расписание ежедневного эксперимента.');
  await writeRecord('state:schedule',{enabled:s.enabled,id:s.id??null,time:s.time??'17:00',timezone:s.timezone??'Asia/Yakutsk',until:s.until??'2026-12-08'});
  return {ok:true,schedule:(await analysisStatus()).schedule};
}

function refreshedTeams(history:AnalysisHistory,now:number,alerts:Record<string,string>,patchId:string|null,ratings:TeamRating[],pool:DynamicTeamPoolEntry[]):Team[]{
  return pool.map(t=>{
    const fixed=TRACKED_TEAMS.find(team=>team.id===t.id);
    const latest=history.maps.filter(m=>m.team_id===t.id&&m.players?.length===5).sort((a,b)=>b.start_time-a.start_time)[0];
    const reference=BASELINE_ROSTERS[t.id]?.account_ids??fixed?.reference_roster??latest?.players;
    const s=sampleTeam(history,t.id,now,patchId??undefined,reference),maps=s.maps,n=maps.length;
    const sorted=maps.map(m=>m.duration_seconds).sort((a,b)=>a-b);
    const qualification=t.qualification==='primary-pool'?'Основной пул из 12 команд.':t.qualification==='expanded-top'?`Допущена в TOP-20: ${t.tier1_opponent_maps} карт против топов за 30 дней.`:t.qualification==='tier1-rating'?`Tier-1: №${t.tier1_rank} активного рейтинга OpenDota.`:t.qualification==='frequent-tier1-opponent'?`${t.tier1_opponent_maps} из последних ${t.recent_maps} карт против Tier-1.`:'Временный резервный пул.';
    return {team:t.name,team_id:t.id,maps:n,patch_id:patchId,pool_qualification:t.qualification,tier1_rank:t.tier1_rank,tier1_opponent_maps:t.tier1_opponent_maps,recent_pool_maps:t.recent_maps,rating:ratings.find(r=>r.team_id===t.id)??null,mean_duration_seconds:n?maps.reduce((a,m)=>a+m.duration_seconds,0)/n:undefined,median_duration_seconds:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:undefined,over_41_count:maps.filter(m=>m.duration_seconds>=2460).length,mean_total_kills:n?maps.reduce((a,m)=>a+m.team_kills+m.opponent_kills,0)/n:undefined,n_series:s.series.length,date_from:maps.at(-1)?new Date(maps.at(-1)!.start_time*1000).toISOString().slice(0,10):null,date_to:maps[0]?new Date(maps[0].start_time*1000).toISOString().slice(0,10):null,note:[qualification,...s.notes,...(alerts[t.id]?[alerts[t.id]]:[])].join(' '),source_urls:[`https://api.opendota.com/api/teams/${t.id}/matches`],recent_maps:maps.map(m=>({...m,total_kills:m.team_kills+m.opponent_kills,start_utc:new Date(m.start_time*1000).toISOString(),source_urls:m.sources}))};
  });
}

export async function runAnalysis(input:unknown={}){
  invariant(!!input&&typeof input==='object'&&!Array.isArray(input),'Некорректные параметры запуска.');
  const args=input as {fixtures?:unknown[];research?:boolean;history_only?:boolean};
  invariant(!args.fixtures||Array.isArray(args.fixtures)&&args.fixtures.length<=30,'Допустимо до 30 подтверждённых серий за запуск.');
  const start=Date.now(),now=new Date(start).toISOString(),runId=crypto.randomUUID();
  const suppliedInput=args.fixtures??[];
  const lease=await db().prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('daily',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(runId,start+300000,start).first<{owner:string}>();
  if(lease?.owner!==runId)throw new DataError('Обновление уже выполняется. Повторите чтение статуса немного позже.',409);
  const run:Run={run_id:runId,status:'running',started_at:now,finished_at:null,maps_added:0,forecasts_added:0,observations_added:0,fixtures_seen:0,backlog_count:0,source_requests:0,opendota_requests:0,collection_healthy:false,rate_limited:false,history_maps:191,warnings:[],skipped:[]};
  await db().prepare('INSERT INTO dota_analysis_runs(id,started_utc,status,payload) VALUES(?,?,?,?)').bind(runId,now,'running',canonical(run)).run();
  await writeRecord('state:betting_health',{healthy:false,verified_at:now});
  try{
    const stored=await records('match:');
    const matches=stored.map(r=>JSON.parse(r.payload) as NormalizedMatch);
    const patch=await fetchCurrentPatch(fetch,start);
    const release=Date.parse(patch.released_at??'')/1000;
    // Backfill only maps that could belong to the current patch. Older seed IDs
    // remain historical context and do not consume the bounded detail budget.
    const known=[...new Set([
      ...seed.maps.filter(m=>m.patch_id!=null||!Number.isFinite(release)||m.start_time<release).map(m=>m.match_id),
      ...matches.filter(m=>m.patch_id!=null&&hasRoster(m.players?.radiant)&&hasRoster(m.players?.dire)).map(m=>m.id),
    ])];
    const savedPoolRow=(await records('state:team_pool'))[0];
    const savedPool=savedPoolRow?JSON.parse(savedPoolRow.payload) as DynamicTeamPoolEntry[]:[];
    const budget=await openDotaMonthlyUsage(start);
    const expansionRows=await records('state:');
    const expansionState=Object.fromEntries(expansionRows.map(r=>[r.key,JSON.parse(r.payload)]));
    const previousExpansion=expansionState['state:expansion'] as ExpansionSnapshot|undefined;
    const previousQueue=(expansionState['state:history_queue']??[]) as string[];
    const collected=await collectOpenDota(known,start,fetch,undefined,env.OPENDOTA_API_KEY,expansionPool(previousExpansion,[],savedPool),budget.remaining,true,previousQueue);
    run.opendota_requests=collected.requested;
    const poolIds=new Set(collected.team_pool.map(team=>team.id));
    const legacyById=new Map(TRACKED_SCHEDULE_TEAMS.map(team=>[team.id,team]));
    const catalog=collected.team_directory.map(team=>{
      const legacy=legacyById.get(team.id);
      const savedAliases=(expansionState['state:team_aliases']?.[team.id]??[]) as string[];
      return {id:team.id,name:team.name,tag:team.tag,aliases:[...new Set([...(legacy?.aliases??[]),...savedAliases])],liquipedia_url:legacy?.liquipedia_url??null,eligible:poolIds.has(team.id)};
    });
    if(!catalog.length)for(const team of TRACKED_SCHEDULE_TEAMS)catalog.push({...team,tag:null,aliases:[...team.aliases],eligible:poolIds.has(team.id)});
    const allowedTeams=new Map<string,string>(catalog.map(team=>[team.id,team.name]));
    for(const team of collected.team_pool)allowedTeams.set(team.id,team.name);
    const calendar=await fetchHaglundSchedule(fetch,start,catalog);
    // Replay recent unresolved rows without changing their original receipt time.
    const pending=(expansionState['state:schedule_pending']??[]) as NonNullable<typeof calendar.rejected>;
    for(const item of pending){
      if(start-Date.parse(item.received_at)>3*3600000||Date.parse(item.received_at)>start)continue;
      const replay=parseHaglundSchedule([item.row],start,catalog);
      for(const f of replay.fixtures)if(!calendar.fixtures.some(x=>x.provider_id===f.provider_id))calendar.fixtures.push({...f,verified_at:item.received_at});
    }
    const pendingById=new Map([...pending,...(calendar.rejected??[])].filter(x=>start-Date.parse(x.received_at)<=3*3600000).map(x=>[x.provider_id,x]));
    for(const f of calendar.fixtures)pendingById.delete(f.provider_id);
    await writeRecord('state:schedule_pending',[...pendingById.values()].slice(0,1000));
    const aliases=Object.fromEntries(collected.team_directory.map(t=>[t.id,[...new Set([...(expansionState['state:team_aliases']?.[t.id]??[]),t.name,...(t.tag?[t.tag]:[])])].slice(-20)]));
    if(collected.team_directory.length)await writeRecord('state:team_aliases',aliases);
    const supplied=suppliedInput.map(f=>checkedFixture(f,start,allowedTeams));
    await writeRecord('state:current_patch',patch);
    await writeRecord('state:team_pool',collected.team_pool);
    run.source_requests=collected.requested+2;run.collection_healthy=collected.healthy&&!!patch.patch_id;run.rate_limited=collected.warnings.some(w=>w.includes('(429)'));
    run.backlog_count=collected.unfetched_ids.length;
    run.warnings.push(...collected.warnings,...calendar.warnings,...patch.warnings);
    const previousMatches=new Map(matches.map(m=>[m.id,m]));
    const inserts=collected.matches.map(m=>{
      const old=previousMatches.get(m.id),combined=old?mergeMatchEvidence(old,m):m;
      previousMatches.set(m.id,combined);
      return db().prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind('match:'+m.id,canonical(combined),now);
    });
    if(inserts.length)await db().batch(inserts);
    matches.splice(0,matches.length,...previousMatches.values());run.maps_added=collected.matches.filter(m=>!stored.some(r=>r.key==='match:'+m.id)).length;
    run.history_maps=new Set([...seed.maps.map(m=>m.match_id),...matches.map(m=>m.id)]).size;
    const alerts=rosterAlerts(matches,Object.fromEntries(Object.entries(BASELINE_ROSTERS).map(([id,r])=>[id,{account_ids:r.account_ids,observed_start_time:Date.parse(r.observed_at)/1000}])));
    await writeRecord('state:roster_alerts',alerts);

    const rankingNow=Date.now();
    const rawHistory=historyFromMatches(seed,matches,(await loadJournal()).journal,rankingNow);
    const expansion=expandTeamPool(rawHistory,collected.team_directory,previousExpansion,rankingNow,patch.patch_id,collected.healthy&&run.backlog_count===0&&!!patch.patch_id,[...previousQueue,...collected.discovered_team_ids,...(calendar.recognized_team_ids??[])]);
    const activePool=expansionPool(expansion,collected.team_directory,savedPool);
    await writeRecord('state:expansion',expansion);
    await writeRecord('state:team_pool',activePool);
    await db().prepare('INSERT OR IGNORE INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?)').bind('ranking:'+runId,canonical(expansion),now).run();
    const discovered=[...(calendar.recognized_team_ids??[]),...collected.discovered_team_ids,...expansion.rows.map(r=>r.team_id),...calendar.fixtures.flatMap(f=>[f.team_a_id,f.team_b_id]),...supplied.flatMap(f=>[f.team_a_id,f.team_b_id])];
    const activeIds=new Set(expansion.active_ids),catalogIds=new Set(collected.team_directory.map(t=>t.id));
    const nextQueue=[...new Set([...previousQueue.filter(id=>!collected.history_attempted_ids.includes(id)),...discovered,...collected.history_attempted_ids])].filter(id=>!activeIds.has(id)&&catalogIds.has(id)).slice(0,500);
    await writeRecord('state:history_queue',nextQueue);
    await writeRecord('state:exclusions',[...pendingById.values()].map(x=>({fixture_id:x.provider_id,fixture:'Расписание: '+String(x.provider_id),reason:x.reason})));

    // Explicit backfill must not place paper bets or rewrite prediction outcomes.
    if(args.history_only===true){
      await writeRecord('state:betting_health',{healthy:collected.healthy&&run.backlog_count===0&&!!patch.patch_id,verified_at:new Date().toISOString()});
      run.status=run.warnings.length||run.backlog_count?'partial':'ok';
      return {...run,history_only:true};
    }

    let {journal}=await loadJournal();
    const latest=latestObservations(journal.observations),pendingReview:{fixture_id:string;teams:string;reason:string}[]=[];
    for(const f of new Map(journal.forecasts.filter(inCurrentExperiment).map(f=>[f.fixture_id,f])).values()){
      if(Date.parse(f.scheduled_start_utc)>start)continue;
      const previous=latest.get(f.fixture_id);
      const mapComplete=previous?.map1?.kills_a!=null&&previous?.map1?.kills_b!=null&&previous?.map1?.duration_seconds!=null;
      if(mapComplete&&previous?.series_score||previous?.series_void)continue;
      const evidence=firstMapEvidence(f,matches);
      const conflict=evidence&&previous?.map1&&(['match_id','kills_a','kills_b','duration_seconds'] as const).some(k=>previous.map1?.[k]!=null&&String(previous.map1[k])!==String(evidence[k]));
      if(conflict)run.warnings.push(`${f.team_a} — ${f.team_b}: автоматически найденная карта расходится с внесённым результатом; нужна проверка.`);
      if(evidence&&!mapComplete&&!previous?.map1_void&&!conflict){
        const result=await recordResult({fixture_id:f.fixture_id,map1:evidence,sources:[`https://www.opendota.com/matches/${evidence.match_id}`],...(previous?{supersedes:previous.observation_id}:{}),note:'Первая карта подтверждена порядком трёх завершённых карт одной BO3. Официальный итог серии проверяется отдельно.'},'automatic');
        run.observations_added+=result.inserted_observations;
      }
      if(!previous?.series_score||!mapComplete&&!evidence||conflict)pendingReview.push({fixture_id:f.fixture_id,teams:`${f.team_a} — ${f.team_b}`,reason:'Нужны официальный счёт серии и явное подтверждение номера первой карты; неполный индекс не позволяет их угадывать.'});
    }
    await writeRecord('state:pending_review',pendingReview);
    journal=(await loadJournal()).journal;
    const verified=(await records('verified:')).flatMap(r=>JSON.parse(r.payload) as AnalysisSeries[]);
    const history=expansionHistory(mergeVerifiedSeries(historyFromMatches(seed,matches,journal),verified),expansion,Date.now());
    const settlement=await settleConfirmed(history,verified);
    run.observations_added+=settlement.added;run.warnings.push(...settlement.issues);
    const existingFixtures=new Map((await records('fixture:')).map(r=>[r.key.slice('fixture:'.length),JSON.parse(r.payload) as FixtureInput]));
    const candidates:FixtureInput[]=[...calendar.fixtures.map(f=>checkedFixture({...f,source_url:f.sources[0]},start,allowedTeams)),...supplied].map(f=>{
      const previous=existingFixtures.get(fixtureKey(f));
      return {...f,patch_id:patch.patch_id??undefined,rosters:f.rosters??previous?.rosters};
    });
    run.fixtures_seen=candidates.length;
    const newForecasts:Forecast[]=[];
    for(const f of candidates){
      const label=`${f.team_a_name??allowedTeams.get(f.team_a_id)??f.team_a_id} — ${f.team_b_name??allowedTeams.get(f.team_b_id)??f.team_b_id}`;
      if(supplied.some(s=>fixtureKey(s)===fixtureKey(f)&&s.patch_id&&s.patch_id!==patch.patch_id)){
        run.skipped.push({fixture_id:fixtureKey(f),fixture:label,reason:'Указанный патч серии не совпадает с подтверждённым текущим патчем.'});continue;
      }
      await writeRecord('fixture:'+fixtureKey(f),f);
      const existingFixture=knownFixture(f,[...journal.forecasts,...newForecasts]);
      if(existingFixture){
        if(Math.abs(Date.parse(existingFixture.scheduled_start_utc)-Date.parse(f.scheduled_start_utc))>15*60000)run.skipped.push({fixture_id:fixtureKey(f),fixture:label,reason:'Для этой пары уже есть прогноз близко по времени. Повторная серия или перенос требуют проверки; исходный прогноз сохранён.'});
        continue;
      }
      const poolReason=expansionGate(expansion,f.team_a_id,f.team_b_id,Date.now());
      if(poolReason){run.skipped.push({fixture_id:fixtureKey(f),fixture:label,reason:poolReason});continue;}
      if(Date.parse(f.scheduled_start_utc)>start+144*3600000){run.skipped.push({fixture_id:fixtureKey(f),fixture:label,reason:'Матч вне ближайших 144 часов; проверим перед следующим запуском.'});continue;}
      if(!collected.healthy||run.backlog_count){run.skipped.push({fixture_id:fixtureKey(f),fixture:label,reason:'Свежая история загружена не полностью; прогноз отложен до успешного обновления.'});continue;}
      const built=buildForecasts(history,f,Date.now());
      if(built.skip_reason)run.skipped.push({fixture_id:fixtureKey(f),fixture:label,reason:built.skip_reason});
      else newForecasts.push(...built.forecasts.map(f=>({...f,pool_snapshot_at:expansion.at,pool_policy:expansion.version})));
    }
    // Reload immediately before the append to preserve observations entered in
    // the browser during network collection. D1 constraints guard concurrent edits.
    journal=(await loadJournal()).journal;
    const accepted=newForecasts.filter(f=>Date.parse(f.scheduled_start_utc)>Date.now());
    const ratings=patch.patch_id?buildTeamRatings(history,Date.now(),patch.patch_id):[];
    const merged=await syncJournal({...journal,forecasts:[...journal.forecasts,...accepted],teams:refreshedTeams(history,Date.now(),alerts,patch.patch_id,ratings,activePool),metadata:{...journal.metadata,automatic_analysis_last_run:now,history_coverage:'dynamic-top20'}});
    run.forecasts_added=merged.inserted_forecasts;
    await writeRecord('state:exclusions',[...run.skipped,...[...pendingById.values()].map(x=>({fixture_id:x.provider_id,fixture:'Расписание: '+String(x.provider_id),reason:x.reason}))]);
    await writeRecord('state:uncertainty_pool',run.skipped.filter(s=>/патч|состав|замен|неопредел|истори|карт/i.test(s.reason)));
    await writeRecord('state:betting_health',{healthy:collected.healthy&&run.backlog_count===0&&!!patch.patch_id,verified_at:new Date().toISOString()});
    run.status=run.warnings.length||run.skipped.length||run.backlog_count?'partial':'ok';
  }catch(e){
    run.status='failed';
    run.warnings.push(e instanceof DataError?e.message:'Сбор не завершён. Уже подтверждённые данные сохранены; повторный запуск безопасен.');
    console.error('Automatic Dota analysis failed',e instanceof Error?e.message:'Unknown error');
  }finally{
    run.finished_at=new Date().toISOString();
    await db().prepare('UPDATE dota_analysis_runs SET finished_utc=?,status=?,payload=? WHERE id=?').bind(run.finished_at,run.status,canonical(run),runId).run();
    await db().prepare("DELETE FROM dota_analysis_lease WHERE id='daily' AND owner=?").bind(runId).run();
  }
  if(args.history_only===true)return {...run,history_only:true};
  const paper=await runPaperAuto();
  const openai=args.research===true?await runOpenaiSearch().catch(()=>({reason:'Поиск источников не завершён; результаты анализа сохранены.'})):null;
  return {...run,paper,openai};
}

/** Called by a separately configured 10-minute scheduler; deterministic refresh, no OpenAI calls. */
export async function runPrematchRefresh(){
  const last=await db().prepare('SELECT started_utc,status,payload FROM dota_analysis_runs ORDER BY started_utc DESC LIMIT 1').first<{started_utc:string;status:string;payload:string}>();
  const age=last?Date.now()-Date.parse(last.started_utc):Infinity;
  let backlog=0;
  try{backlog=last?Number(JSON.parse(last.payload).backlog_count)||0:0;}catch{}
  const interval=last?.status==='failed'||backlog>0?3600_000:HISTORY_REFRESH_MS;
  if(!last||!Number.isFinite(age)||age>=interval)return runAnalysis({research:false});
  const patch=await fetchCurrentPatch(fetch,Date.now());
  await writeRecord('state:current_patch',patch);
  return runPaperAuto();
}
