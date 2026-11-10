import { env } from 'cloudflare:workers';
import { readPaperDashboard, recordOddsQuote, recordPaperBet } from './dota-paper-store';
import { fetchOddsLink, oddsLinkEvents, oddsLinkQuote, oddsLinkCoverage, ODDSLINK_BOOKS, type ScheduleProof } from './dota-oddslink';
import { TEAM_NAMES, checkedFixture } from './dota-auto-core';
import { fetchCurrentPatch } from './dota-patch';
import { evaluateValue, ODDS_REFRESH_MS, sameBetFamily, valuePolicy, VALUE_POLICY_VERSION } from './dota-value';
import type { Forecast } from './dota-types';

export function paperAutoConfiguration() {
  const keyed=!!env.ODDSLINK_API_KEY?.trim(),policy=valuePolicy(env);
  const limit=env.ODDSLINK_MAX_REQUESTS_PER_DAY==null?(keyed?144:2):Number(env.ODDSLINK_MAX_REQUESTS_PER_DAY);
  if(!Number.isInteger(limit)||limit<0||limit>144)throw new Error('ODDSLINK_MAX_REQUESTS_PER_DAY должен быть целым числом от 0 до 144.');
  return {provider:'OddsLink',access:keyed?'api_key':'guest',enabled:env.AUTO_PAPER_ENABLED!=='false',key_required:false,
    supported_markets:['series_winner','map_handicap','map_kills'],duration_supported:false,bookmaker_priority:ODDSLINK_BOOKS,
    max_requests_per_utc_day:keyed?limit:Math.min(limit,2),refresh_interval_minutes:10,value_policy:policy,
    cadence:'Серверная проверка каждые 10 минут при доступной квоте и подходящих будущих матчах. Без вызовов OpenAI.',
    policy:`Отбор по ожидаемой доходности: (p − ${policy.probability_reserve}) × коэффициент − 1 ≥ ${policy.min_ev}; коэффициент ≥ ${policy.min_odds}. До двух разных семейств рынков на серию. Цена подтверждена букмекером не более 10 минут назад. Состав и текущий патч обязательны.`,
    limitation:keyed?'Частота ограничена настроенной дневной квотой и тарифом источника. Модель и пороги экспериментальные.':'Гостевой режим: не более двух загрузок в сутки. Для регулярной линии раз в 10 минут нужен API-ключ с достаточной квотой.'};
}
export async function paperAutoStatus(){
  const r=await env.DB!.prepare("SELECT payload FROM dota_analysis_records WHERE key='paper:auto:last'").first<{payload:string}>();
  return {...paperAutoConfiguration(),last_run:r?JSON.parse(r.payload):null};
}

/** One bounded, deterministic price refresh. Never calls OpenAI or rewrites forecasts. */
export async function runPaperAuto(){
  const cfg=paperAutoConfiguration(),now=Date.now(),owner=crypto.randomUUID(),db=env.DB!;
  const report={at:new Date(now).toISOString(),provider:'OddsLink',policy_version:VALUE_POLICY_VERSION,status:'blocked',bets_added:0,quotes_added:0,eligible_forecasts:0,skipped:[] as string[],reason:'',coverage:null as ReturnType<typeof oddsLinkCoverage>|null,provider_remaining:null as string|null,cached:false};
  if(!cfg.enabled){report.reason='Автоматические виртуальные ставки выключены.';return report;}
  const lease=await db.prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('paper-auto',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(owner,now+300000,now).first<{owner:string}>();
  if(lease?.owner!==owner){report.reason='Запуск уже выполняется.';return report;}
  const save=async(key:string,value:unknown)=>db.prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(key,JSON.stringify(value),new Date().toISOString()).run();
  try{
    const patchRow=await db.prepare("SELECT payload FROM dota_analysis_records WHERE key='state:current_patch'").first<{payload:string}>();
    const patch=patchRow?JSON.parse(patchRow.payload):null;
    if(!patch?.patch_id||!Number.isFinite(Date.parse(patch.verified_at))||Date.parse(patch.verified_at)>now||now-Date.parse(patch.verified_at)>ODDS_REFRESH_MS)await save('state:current_patch',await fetchCurrentPatch(fetch,now));
    const p=await readPaperDashboard();
    const forecasts=p.eligible_forecasts.filter(f=>f.market!=='map_duration'&&p.bets.filter(b=>b.forecast.fixture_id===f.fixture_id).length<2&&!p.bets.some(b=>sameBetFamily(b.forecast,f)));
    report.eligible_forecasts=forecasts.length;
    if(!forecasts.length){report.reason='Нет подходящих будущих прогнозов: проверьте состав, патч, историю внутри патча и уже записанные ставки. Запрос линии не расходуется.';return report;}
    const dayKey='paper:oddslink:quota:'+new Date(now).toISOString().slice(0,10);
    const [previous,lastRow]=await Promise.all([
      db.prepare('SELECT payload FROM dota_analysis_records WHERE key=?').bind(dayKey).first<{payload:string}>(),
      db.prepare("SELECT payload FROM dota_analysis_records WHERE key='paper:oddslink:last-fetch'").first<{payload:string}>(),
    ]);
    const quota=previous?JSON.parse(previous.payload):{count:0,last:0};
    const last=lastRow?JSON.parse(lastRow.payload).at:quota.last;
    if(quota.blocked||quota.count>=cfg.max_requests_per_utc_day||now-last<ODDS_REFRESH_MS){report.cached=true;report.reason='Интервал 10 минут или квота источника ещё не позволяют загрузку. Старые цены для новых ставок не используются.';return report;}
    await save(dayKey,{count:quota.count+1,last:now});
    await save('paper:oddslink:last-fetch',{at:now});
    let feed;
    try{feed=await fetchOddsLink(fetch,env.ODDSLINK_API_KEY);}catch(e){
      if(e instanceof Error&&/HTTP (401|403|429)/.test(e.message))await save(dayKey,{count:quota.count+1,last:now,blocked:true});
      throw e;
    }
    if(feed.remaining==='0')await save(dayKey,{count:quota.count+1,last:now,blocked:true});
    report.coverage=oddsLinkCoverage(feed.rows,Date.now());report.provider_remaining=feed.remaining;
    const rows=await db.prepare("SELECT payload FROM dota_analysis_records WHERE key LIKE 'fixture:%'").all<{payload:string}>();
    const proofs:ScheduleProof[]=[];
    for(const row of rows.results){try{const f=checkedFixture(JSON.parse(row.payload),Date.now());proofs.push({...f,team_a:TEAM_NAMES[f.team_a_id],team_b:TEAM_NAMES[f.team_b_id]});}catch{}}
    const choices:{forecast:Forecast;quote:NonNullable<ReturnType<typeof oddsLinkQuote>>;ev:number}[]=[];
    for(const f of forecasts){
      const events=oddsLinkEvents(feed.rows,f,proofs,Date.now());
      if(events.length!==1){report.skipped.push(`${f.forecast_id}: нет однозначного совпадения подтверждённой BO3.`);continue;}
      const quote=oddsLinkQuote(events[0],f,Date.now());
      if(!quote){report.skipped.push(`${f.forecast_id}: точной линии нет или цена старше 10 минут.`);continue;}
      const value=evaluateValue(f.probability,quote.decimal_odds,cfg.value_policy);
      if(!value.eligible){report.skipped.push(`${f.forecast_id}: ${value.reason}`);continue;}
      choices.push({forecast:f,quote,ev:value.conservative_ev!});
    }
    choices.sort((a,b)=>b.ev-a.ev||a.forecast.forecast_id.localeCompare(b.forecast.forecast_id));
    for(const {forecast:f,quote} of choices){
      try{
        const fresh=await readPaperDashboard();
        if(!fresh.eligible_forecasts.some(x=>x.forecast_id===f.forecast_id)||fresh.bets.some(b=>sameBetFamily(b.forecast,f))||fresh.bets.filter(b=>b.forecast.fixture_id===f.fixture_id).length>=2)continue;
        if(fresh.metrics.available_bankroll<fresh.settings.default_stake){report.skipped.push(`${f.forecast_id}: недостаточно свободного банка.`);continue;}
        const q=await recordOddsQuote({...quote,forecast_id:f.forecast_id},'agent');report.quotes_added+=Number(q.inserted);
        const b=await recordPaperBet({quote_id:q.quote.quote_id,bet_id:'auto:'+f.forecast_id,stake:fresh.settings.default_stake});report.bets_added+=Number(b.inserted);
      }catch{report.skipped.push(`${f.forecast_id}: повторная проверка ставки отклонена; проверьте время, состав, патч и банк.`);}
    }
    report.status='ok';report.reason=`Свежая линия проверена по ожидаемой выгоде. Ставок: ${report.bets_added}. Пропуск — нормальное решение при отсутствии преимущества.`;
  }catch(e){report.reason=e instanceof Error?e.message:'Источник недоступен.';}
  finally{
    await db.prepare("INSERT INTO dota_analysis_records(key,payload,updated_utc) SELECT 'paper:auto:last',?,? WHERE EXISTS(SELECT 1 FROM dota_analysis_lease WHERE id='paper-auto' AND owner=?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc").bind(JSON.stringify(report),new Date().toISOString(),owner).run();
    await db.prepare("DELETE FROM dota_analysis_lease WHERE id='paper-auto' AND owner=?").bind(owner).run();
  }
  return report;
}
