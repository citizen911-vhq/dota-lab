import {env} from 'cloudflare:workers';
import {emptySearchReport,SEARCH_MODEL,searchDay,searchPublicOdds,type SearchReport} from './dota-openai';
import {loadJournal} from './dota-store';
import {TEAM_NAMES} from './dota-auto-core';

// Preserve the failed pre-fetch v1 report; fixed transport gets one fresh attempt.
const RECORD='openai:search:v2:last';
async function lastReport():Promise<SearchReport|null>{
  const row=await env.DB!.prepare('SELECT payload FROM dota_analysis_records WHERE key=?').bind(RECORD).first<{payload:string}>();
  return row?JSON.parse(row.payload):null;
}
async function saveReport(r:SearchReport){
  await env.DB!.prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(RECORD,JSON.stringify(r),new Date().toISOString()).run();
}
export async function openaiStatus(){return {key_configured:!!env.OPENAI_API_KEY?.trim(),model:SEARCH_MODEL,automatic:true,max_runs_per_yakutsk_day:1,max_search_calls:3,automatic_bets_from_search:false,last_run:await lastReport()};}
export async function runOpenaiSearch(){
  const now=Date.now(),day=searchDay(now),owner=crypto.randomUUID();
  if(!env.OPENAI_API_KEY?.trim())return {report:{...emptySearchReport(now),status:'blocked',reason:'Серверный ключ OpenAI отсутствует.'},cached:false};
  const lease=await env.DB!.prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('openai-search',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(owner,now+180000,now).first<{owner:string}>();
  if(lease?.owner!==owner)return {report:await lastReport(),cached:true,reason:'Поиск уже выполняется.'};
  try{
    const previous=await lastReport();
    if(previous&&searchDay(Date.parse(previous.at))===day)return {report:previous,cached:true,reason:'Сегодня попытка уже выполнялась. Показываем сохранённый результат без расхода API.'};
    const {journal}=await loadJournal();
    const fixtures=[...new Map(journal.forecasts.filter(f=>Date.parse(f.scheduled_start_utc)>now&&Date.parse(f.scheduled_start_utc)<now+86400000).map(f=>[f.fixture_id,{team_a:f.team_a,team_b:f.team_b,scheduled_start_utc:f.scheduled_start_utc}])).values()].slice(0,6);
    // Reserve the day's attempt BEFORE spending credits, including failures/timeouts.
    await saveReport(emptySearchReport(now));
    const report=await searchPublicOdds(env.OPENAI_API_KEY,Object.values(TEAM_NAMES),fixtures,now);
    await saveReport(report);
    return {report,cached:false};
  }finally{await env.DB!.prepare("DELETE FROM dota_analysis_lease WHERE id='openai-search' AND owner=?").bind(owner).run();}
}
