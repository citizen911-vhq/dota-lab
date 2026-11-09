import { runPaperAuto } from './dota-paper-auto';
import { runOpenaiSearch } from './dota-openai-store';
import { env } from 'cloudflare:workers';
import historySeed from '../data/history-seed.json';
import rosterBaseline from '../data/roster-baseline.json';
import type { AnalysisHistory, AnalysisSeries, FixtureInput } from './dota-analysis-types';
import type { NormalizedMatch } from './dota-opendota';
import type { Forecast, Team } from './dota-types';
import { collectOpenDota } from './dota-opendota';
import { fetchHaglundSchedule } from './dota-schedule-source';
import { buildForecasts, fixtureKey, sampleTeam, TRACKED_TEAMS } from './dota-analysis';
import { checkedFixture, confirmSeries, firstMapEvidence, historyFromMatches, knownFixture, mergeVerifiedSeries, rosterAlerts, TEAM_NAMES } from './dota-auto-core';
import { canonical, dashboard, DataError, invariant, latestObservations } from './dota-core';
import { loadJournal, recordResult, syncJournal } from './dota-store';

type Run = {run_id:string;status:'running'|'ok'|'partial'|'failed';started_at:string;finished_at:string|null;maps_added:number;forecasts_added:number;observations_added:number;fixtures_seen:number;backlog_count:number;source_requests:number;collection_healthy:boolean;rate_limited:boolean;history_maps:number;warnings:string[];skipped:{fixture:string;reason:string}[]};
type RecordRow = {key:string;payload:string;updated_utc:string};
type Schedule = {enabled:boolean;id?:string;time?:string;timezone?:string;until?:string};
const seed=historySeed as AnalysisHistory;
const COVERAGE='Открытый календарь охватывает только часть турниров; DreamLeague Division 2 требует отдельной проверки расписания. Индекс OpenDota может пропускать карты. История сохраняется, пропуски не заменяются нулями.';
const SERVICE_ROUTES={access:'Use a fresh get_site service token only on this owner-private Site: OAI-Sites-Authorization: Bearer TOKEN. Never log or persist it.',status:'GET /api/analysis/status',run:'POST /api/analysis/run with JSON {} or {fixtures:[{team_a_id,team_b_id,scheduled_start_utc,source_url,best_of:3,status:"scheduled",verified_at,provider_id?}]}',confirm:'POST /api/analysis/confirm-series with JSON {team_a_id,team_b_id,map_ids:[ordered Valve IDs as strings],score:[integer,integer],source_url,verified_at}. Use explicitly checked CyberScore/Liquipedia evidence and maps already in history.'};
function db(){if(!env.DB)throw new DataError('Хранилище автоанализа недоступно.',503);return env.DB;}
async function records(prefix:string){return (await db().prepare('SELECT key,payload,updated_utc FROM dota_analysis_records WHERE key LIKE ?').bind(prefix+'%').all<RecordRow>()).results;}
async function writeRecord(key:string,value:unknown){await db().prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(key,canonical(value),new Date().toISOString()).run();}

export async function analysisStatus(){
  const [runs,meta,matchRows,verifiedRows,loaded]=await Promise.all([
    db().prepare('SELECT payload FROM dota_analysis_runs ORDER BY started_utc DESC LIMIT 10').all<{payload:string}>(),
    records('state:'),records('match:'),records('verified:'),loadJournal(),
  ]);
  const values=Object.fromEntries(meta.map(r=>[r.key,JSON.parse(r.payload)]));
  const recent=runs.results.map(r=>JSON.parse(r.payload) as Run);
  const verified=verifiedRows.flatMap(r=>JSON.parse(r.payload) as AnalysisSeries[]),verifiedIds=new Set(verified.flatMap(s=>s.map_ids));
  const unknown=matchRows.map(r=>JSON.parse(r.payload) as NormalizedMatch).filter(m=>!verifiedIds.has(m.id));
  const d=dashboard(loaded.journal,loaded.storage,loaded.updated);
  return {coverage:'partial',coverage_note:COVERAGE,tracked_teams:8,history_maps:new Set(seed.maps.map(m=>m.match_id)).size+matchRows.length,schedule:values['state:schedule']??null,last_run:recent[0]??null,recent_runs:recent,roster_alerts:values['state:roster_alerts']??{},pending_review:d.fixtures.filter(f=>Date.parse(f.scheduled_start_utc)<Date.now()&&!f.observation?.series_void&&(!f.observation?.series_score||!f.observation?.map1||f.observation.map1.kills_a==null||f.observation.map1.duration_seconds==null)).map(f=>({fixture_id:f.fixture_id,team_a:f.team_a,team_b:f.team_b,scheduled_start_utc:f.scheduled_start_utc,observation:f.observation})),unverified_maps:unknown.slice(-100),unverified_maps_total:unknown.length,evaluation:{summary:d.summary,daily:d.daily,calibration:d.calibration},source_access:{opendota_key_configured:!!env.OPENDOTA_API_KEY},updater_instructions:{service_routes:SERVICE_ROUTES,forecast_window_hours:24,source:'https://api.opendota.com/api',schedule_source:'https://dota.haglund.dev/v1/matches',fallback_schedule_source:'https://cyberscore.live/en/matches/',rule:'Call run_analysis, then analysis_status. Review unverified_maps against explicit official BO3 score and ordered Valve match IDs on public CyberScore or Liquipedia. Use confirm_series for verified complete series, including opponents outside the tracked eight; never infer a sweep from a partial index. If the calendar omits DreamLeague Division 2, read the public CyberScore schedule and pass only verified future BO3 fixtures to run_analysis. Never scrape blocked sources or infer start times. Call run_analysis at most twice per daily task; stop retries on rate-limit/source errors. Use record_result for separately verified partial facts/corrections when needed; never revise forecasts. Finish with analysis_status evaluation. Forecasts stop after December 7; December 8 is final settlement and report only.',teams:TEAM_NAMES}};
}

async function settleConfirmed(history:AnalysisHistory,confirmed:AnalysisSeries[]){
  let added=0;const issues:string[]=[];
  const loaded=await loadJournal(),latest=latestObservations(loaded.journal.observations);
  for(const f of new Map(loaded.journal.forecasts.map(f=>[f.fixture_id,f])).values()){
    const a=Object.keys(TEAM_NAMES).find(id=>TEAM_NAMES[id]===f.team_a),b=Object.keys(TEAM_NAMES).find(id=>TEAM_NAMES[id]===f.team_b),start=Date.parse(f.scheduled_start_utc)/1000;
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

function refreshedTeams(history:AnalysisHistory,now:number,alerts:Record<string,string>):Team[]{
  return TRACKED_TEAMS.map(t=>{
    const s=sampleTeam(history,t.id,now),maps=s.maps,n=maps.length;
    const sorted=maps.map(m=>m.duration_seconds).sort((a,b)=>a-b);
    return {team:t.name,team_id:t.id,maps:n,mean_duration_seconds:n?maps.reduce((a,m)=>a+m.duration_seconds,0)/n:undefined,median_duration_seconds:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:undefined,over_41_count:maps.filter(m=>m.duration_seconds>=2460).length,mean_total_kills:n?maps.reduce((a,m)=>a+m.team_kills+m.opponent_kills,0)/n:undefined,n_series:s.series.length,date_from:maps.at(-1)?new Date(maps.at(-1)!.start_time*1000).toISOString().slice(0,10):null,date_to:maps[0]?new Date(maps[0].start_time*1000).toISOString().slice(0,10):null,note:[...s.notes,...(alerts[t.id]?[alerts[t.id]]:[])].join(' '),source_urls:[`https://api.opendota.com/api/teams/${t.id}/matches`],recent_maps:maps.map(m=>({...m,total_kills:m.team_kills+m.opponent_kills,start_utc:new Date(m.start_time*1000).toISOString(),source_urls:m.sources}))};
  });
}

export async function runAnalysis(input:unknown={}){
  invariant(!!input&&typeof input==='object'&&!Array.isArray(input),'Некорректные параметры запуска.');
  const args=input as {fixtures?:unknown[]};
  invariant(!args.fixtures||Array.isArray(args.fixtures)&&args.fixtures.length<=30,'Допустимо до 30 подтверждённых серий за запуск.');
  const start=Date.now(),now=new Date(start).toISOString(),runId=crypto.randomUUID();
  const supplied=(args.fixtures??[]).map(f=>checkedFixture(f,start));
  const lease=await db().prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('daily',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(runId,start+300000,start).first<{owner:string}>();
  if(lease?.owner!==runId)throw new DataError('Обновление уже выполняется. Повторите чтение статуса немного позже.',409);
  const run:Run={run_id:runId,status:'running',started_at:now,finished_at:null,maps_added:0,forecasts_added:0,observations_added:0,fixtures_seen:0,backlog_count:0,source_requests:0,collection_healthy:false,rate_limited:false,history_maps:191,warnings:[],skipped:[]};
  await db().prepare('INSERT INTO dota_analysis_runs(id,started_utc,status,payload) VALUES(?,?,?,?)').bind(runId,now,'running',canonical(run)).run();
  try{
    const stored=await records('match:');
    const matches=stored.map(r=>JSON.parse(r.payload) as NormalizedMatch);
    const known=[...new Set([...seed.maps.map(m=>m.match_id),...matches.map(m=>m.id)])];
    const [collected,calendar]=await Promise.all([collectOpenDota(known,start,fetch,undefined,env.OPENDOTA_API_KEY),fetchHaglundSchedule(fetch,start)]);
    run.source_requests=collected.requested+1;run.collection_healthy=collected.healthy;run.rate_limited=collected.warnings.some(w=>w.includes('(429)'));
    run.backlog_count=collected.unfetched_ids.length;
    run.warnings.push(...collected.warnings,...calendar.warnings);
    const inserts=collected.matches.map(m=>db().prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind('match:'+m.id,canonical(m),now));
    if(inserts.length)await db().batch(inserts);
    matches.push(...collected.matches);run.maps_added=collected.matches.length;
    run.history_maps=known.length+run.maps_added;
    const alerts=rosterAlerts(matches,rosterBaseline);
    await writeRecord('state:roster_alerts',alerts);

    let {journal}=await loadJournal();
    const latest=latestObservations(journal.observations),pendingReview:{fixture_id:string;teams:string;reason:string}[]=[];
    for(const f of new Map(journal.forecasts.map(f=>[f.fixture_id,f])).values()){
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
    const history=mergeVerifiedSeries(historyFromMatches(seed,matches,journal),verified);
    const settlement=await settleConfirmed(history,verified);
    run.observations_added+=settlement.added;run.warnings.push(...settlement.issues);
    const candidates:FixtureInput[]=[...calendar.fixtures.map(f=>checkedFixture({...f,source_url:f.sources[0]},start)),...supplied];
    run.fixtures_seen=candidates.length;
    const newForecasts:Forecast[]=[];
    for(const f of candidates){
      const label=`${TEAM_NAMES[f.team_a_id]} — ${TEAM_NAMES[f.team_b_id]}`;
      await writeRecord('fixture:'+fixtureKey(f),f);
      const existingFixture=knownFixture(f,[...journal.forecasts,...newForecasts]);
      if(existingFixture){
        if(Math.abs(Date.parse(existingFixture.scheduled_start_utc)-Date.parse(f.scheduled_start_utc))>15*60000)run.skipped.push({fixture:label,reason:'Для этой пары уже есть прогноз близко по времени. Повторная серия или перенос требуют проверки; исходный прогноз сохранён.'});
        continue;
      }
      if(Date.parse(f.scheduled_start_utc)>start+24*3600000){run.skipped.push({fixture:label,reason:'Матч вне ближайших 24 часов; проверим перед следующим запуском.'});continue;}
      if(!collected.healthy||run.backlog_count){run.skipped.push({fixture:label,reason:'Свежая история загружена не полностью; прогноз отложен до успешного обновления.'});continue;}
      if(alerts[f.team_a_id]||alerts[f.team_b_id]){run.skipped.push({fixture:label,reason:alerts[f.team_a_id]??alerts[f.team_b_id]});continue;}
      const built=buildForecasts(history,f,Date.now());
      if(built.skip_reason)run.skipped.push({fixture:label,reason:built.skip_reason});
      else if(built.samples&&[built.samples.a,built.samples.b].some(s=>s.maps.some(m=>m.audit_origin!=='baseline-2026-11-08'&&(m.series_type===1||m.series_type===null)&&!s.series.some(series=>series.map_ids.includes(m.match_id)))))run.skipped.push({fixture:label,reason:'Нужен подтверждённый итог одной из недавних серий; расчёт фор отложен, чтобы не исказить выборку.'});
      else newForecasts.push(...built.forecasts);
    }
    // Reload immediately before the append to preserve observations entered in
    // the browser during network collection. D1 constraints guard concurrent edits.
    journal=(await loadJournal()).journal;
    const accepted=newForecasts.filter(f=>Date.parse(f.scheduled_start_utc)>Date.now());
    const merged=await syncJournal({...journal,forecasts:[...journal.forecasts,...accepted],teams:refreshedTeams(history,Date.now(),alerts),metadata:{...journal.metadata,automatic_analysis_last_run:now,history_coverage:'partial'}});
    run.forecasts_added=merged.inserted_forecasts;
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
  const paper=await runPaperAuto();
  // Search is isolated from prediction and settlement failures and never writes bets.
  const openai=await runOpenaiSearch().catch(()=>({reason:'Поиск источников не завершён; результаты анализа сохранены.'}));
  return {...run,paper,openai};
}
