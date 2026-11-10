import { env } from 'cloudflare:workers';
import { canonical, dashboard, DataError, invariant, supplementForecasts } from './dota-core';
import { loadJournal } from './dota-store';
import { defaultPaperSettings, paperDashboard, validateBet, validatePaperSettings, validateQuote } from './dota-paper-core';
import type { OddsQuote, PaperBet, PaperSettings } from './dota-paper-types';
import { bettingContextReason, type BettingContext } from './dota-betting-context';
import { sameBetFamily, valuePolicy, VALUE_POLICY_VERSION } from './dota-value';

type Row={id:string;payload:string};
function db(){if(!env.DB)throw new DataError('Хранилище виртуальных ставок недоступно.',503);return env.DB;}
function object(value:unknown):Record<string,unknown>{invariant(!!value&&typeof value==='object'&&!Array.isArray(value),'Нужны данные записи.');return value as Record<string,unknown>;}
async function hash(value:unknown){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function loadPaper(){
  const [settings,quotes,bets,loaded]=await Promise.all([
    db().prepare("SELECT id,payload FROM dota_paper_settings WHERE id='main'").first<Row>(),
    db().prepare('SELECT id,payload FROM dota_odds_quotes ORDER BY recorded_utc,id').all<Row>(),
    db().prepare('SELECT id,payload FROM dota_paper_bets ORDER BY placed_utc,id').all<Row>(),
    loadJournal(),
  ]);
  const base=dashboard(loaded.journal,loaded.storage,loaded.updated);
  const forecasts=[...new Map([...base.forecasts,...base.minute_forecasts].map(f=>[f.forecast_id,f])).values()];
  const rawForecasts=[...new Map([...loaded.journal.forecasts,...supplementForecasts(loaded.journal)].map(f=>[f.forecast_id,f])).values()];
  return {settings:settings?JSON.parse(settings.payload) as PaperSettings:defaultPaperSettings(),settingsPersisted:!!settings,quotes:quotes.results.map(r=>JSON.parse(r.payload) as OddsQuote),bets:bets.results.map(r=>JSON.parse(r.payload) as PaperBet),forecasts,rawForecasts,observations:loaded.journal.observations};
}
function compute(p:Awaited<ReturnType<typeof loadPaper>>){return paperDashboard(p.settings,p.quotes,p.bets,p.rawForecasts,p.observations);}
export async function loadBettingContext(): Promise<BettingContext> {
  const rows = await db().prepare("SELECT key,payload FROM dota_analysis_records WHERE key IN ('state:current_patch','state:betting_health','state:roster_alerts') OR key LIKE 'fixture:%'").all<{key:string;payload:string}>();
  const records = Object.fromEntries(rows.results.map(r=>[r.key,JSON.parse(r.payload)]));
  return {patch:records['state:current_patch'] ?? null, health:records['state:betting_health'] ?? null, alerts:records['state:roster_alerts'] ?? {}, fixtures:rows.results.filter(r=>r.key.startsWith('fixture:')).map(r=>JSON.parse(r.payload))};
}
export async function readPaperDashboard(){
  const [p,context]=await Promise.all([loadPaper(),loadBettingContext()]);
  const computed=compute(p),now=Date.now();
  const uncertainty_pool=computed.eligible_forecasts.map(f=>({forecast_id:f.forecast_id,fixture_id:f.fixture_id,reason:bettingContextReason(f,context,now)})).filter(x=>x.reason);
  return {...computed,eligible_forecasts:computed.eligible_forecasts.filter(f=>!bettingContextReason(f,context,now)),uncertainty_pool,value_policy:valuePolicy(env),forecasts:p.forecasts,settings_persisted:p.settingsPersisted,data_mode:env.ODDSLINK_API_KEY?'oddslink_api_and_manual':'oddslink_guest_and_manual',automatic_odds_feed_configured:env.AUTO_PAPER_ENABLED!=='false',generated_at:new Date(now).toISOString(),source_note:'Проверка линии каждые 10 минут при настроенном серверном расписании и доступной квоте OddsLink. Новые ставки проходят фильтры состава, текущего патча и ожидаемой доходности. Токены OpenAI для этого цикла не используются.'};
}

// All balance-affecting writes share a database lease. It prevents two tabs or
// assistant retries from concurrently spending the same available virtual funds.
async function withLock<T>(operation:(owner:string)=>Promise<T>):Promise<T>{
  const now=Date.now(),owner=crypto.randomUUID();
  const lease=await db().prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('paper',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(owner,now+60000,now).first<{owner:string}>();
  if(lease?.owner!==owner)throw new DataError('Журнал сейчас обновляется. Повторите запрос через несколько секунд.',409);
  try{return await operation(owner);}finally{await db().prepare("DELETE FROM dota_analysis_lease WHERE id='paper' AND owner=?").bind(owner).run();}
}
// The owner predicate is checked in the same SQLite transaction as each write.
// A request resumed after lease takeover cannot commit an obsolete balance read.
const fence="EXISTS(SELECT 1 FROM dota_analysis_lease WHERE id='paper' AND owner=?)";
function committed(result:D1Result){if(result.meta.changes!==1)throw new DataError('Обновление журнала устарело. Повторите запрос.',409);}

export async function savePaperSettings(value:unknown){
  const input=object(value);
  return withLock(async owner=>{
    const p=await loadPaper();
    const next=validatePaperSettings({...p.settings,...input,unit_label:'ед.',created_utc:p.settingsPersisted?p.settings.created_utc:new Date().toISOString()});
    if(p.bets.length&&next.initial_bankroll!==p.settings.initial_bankroll)throw new DataError('Начальный банк зафиксирован первой виртуальной ставкой и больше не меняется.',409);
    committed(await db().prepare("INSERT INTO dota_paper_settings(id,payload,updated_utc) SELECT 'main',?,? WHERE "+fence+" ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc").bind(canonical(next),new Date().toISOString(),owner).run());
    return {ok:true,settings:{...next,locked:p.bets.length>0}};
  });
}

export async function recordOddsQuote(value:unknown,entryMethod:'manual'|'agent'='manual'){
  const input=object(value);
  return withLock(async owner=>{
    const p=await loadPaper(),now=Date.now(),quoteId=input.quote_id??crypto.randomUUID();
    const f=p.forecasts.find(f=>f.forecast_id===input.forecast_id);
    invariant(f,'Прогноз не найден. Сначала зарегистрируйте прогноз на будущую серию.');
    const old=p.quotes.find(q=>q.quote_id===quoteId);
    if(old){
      const candidate=validateQuote({...input,quote_id:quoteId,recorded_utc:old.recorded_utc,observed_utc:input.observed_utc??old.observed_utc,entry_method:old.entry_method},{...f,status:'pending'},Date.parse(old.recorded_utc));
      if(canonical(candidate)!==canonical(old))throw new DataError('Сохранённый коэффициент нельзя переписать. Запишите новую котировку.',409);
      return {ok:true,inserted:false,quote:old};
    }
    invariant(f.status==='pending'&&!f.observation,'Коэффициент нельзя добавлять после появления результата серии.');
    const q=validateQuote({...input,quote_id:quoteId,recorded_utc:new Date(now).toISOString(),observed_utc:input.observed_utc??new Date(now).toISOString(),entry_method:entryMethod},f,now);
    committed(await db().prepare('INSERT INTO dota_odds_quotes(id,forecast_id,payload,content_hash,recorded_utc) SELECT ?,?,?,?,? WHERE '+fence).bind(q.quote_id,q.forecast_id,canonical(q),await hash(q),q.recorded_utc,owner).run());
    return {ok:true,inserted:true,quote:q};
  });
}

export async function recordPaperBet(value:unknown){
  const input=object(value);
  return withLock(async owner=>{
    const p=await loadPaper(),now=Date.now(),betId=input.bet_id??crypto.randomUUID();
    const q=p.quotes.find(q=>q.quote_id===input.quote_id);
    invariant(q,'Котировка не найдена. Сначала сохраните реальный коэффициент.');
    const f=p.forecasts.find(f=>f.forecast_id===q.forecast_id);invariant(f,'Прогноз не найден.');
    const old=p.bets.find(b=>b.bet_id===betId);
    if(old){
      const candidate=validateBet({...input,bet_id:betId,forecast_id:q.forecast_id,stake:input.stake??old.stake,placed_utc:old.placed_utc,policy_version:old.policy_version,policy_snapshot:old.policy_snapshot},q,{...f,status:'pending'},Date.parse(old.placed_utc),true);
      if(canonical(candidate)!==canonical(old))throw new DataError('Зафиксированную виртуальную ставку нельзя изменить.',409);
      return {ok:true,inserted:false,bet:old};
    }
    if(p.bets.some(b=>b.forecast_id===q.forecast_id))throw new DataError('Для этого прогноза виртуальная ставка уже зарегистрирована.',409);
    invariant(f.status==='pending'&&!f.observation,'Ставку нельзя записать после появления результата серии.');
    const risk=bettingContextReason(f,await loadBettingContext(),now);
    invariant(!risk,risk??'Матч в пуле неопределённости.');
    const existing=p.bets.map(b=>p.rawForecasts.find(x=>x.forecast_id===b.forecast_id)).filter(x=>!!x);
    invariant(existing.filter(x=>x.fixture_id===f.fixture_id).length<2,'На серию уже зарегистрированы две ставки.');
    invariant(!existing.some(x=>sameBetFamily(x,f)),'На это семейство рынков серии ставка уже зарегистрирована.');
    const bet=validateBet({...input,bet_id:betId,forecast_id:q.forecast_id,quote_id:q.quote_id,stake:input.stake??p.settings.default_stake,placed_utc:new Date(now).toISOString(),policy_version:VALUE_POLICY_VERSION,policy_snapshot:valuePolicy(env)},q,f,now);
    const available=compute(p).metrics.available_bankroll;
    invariant(Math.round(bet.stake*100)<=Math.round(available*100),'В виртуальном банке недостаточно свободных средств.');
    const statements:D1PreparedStatement[]=[];
    if(!p.settingsPersisted){const settings={...p.settings,created_utc:new Date(now).toISOString()};statements.push(db().prepare("INSERT INTO dota_paper_settings(id,payload,updated_utc) SELECT 'main',?,? WHERE "+fence).bind(canonical(settings),new Date(now).toISOString(),owner));}
    statements.push(db().prepare('INSERT INTO dota_paper_bets(id,forecast_id,quote_id,payload,content_hash,placed_utc) SELECT ?,?,?,?,?,? WHERE '+fence).bind(bet.bet_id,bet.forecast_id,bet.quote_id,canonical(bet),await hash(bet),bet.placed_utc,owner));
    for(const result of await db().batch(statements))committed(result);
    return {ok:true,inserted:true,bet};
  });
}
