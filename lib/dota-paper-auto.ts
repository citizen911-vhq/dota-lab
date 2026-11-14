import { env } from 'cloudflare:workers';
import { readPaperDashboard, recordOddsQuote, recordPaperBet, prepareBetForecast } from './dota-paper-store';
import { fetchOddsLink, oddsLinkEvents, oddsLinkQuote, oddsLinkCoverage, ODDSLINK_BOOKS, type ScheduleProof } from './dota-oddslink';
import { TEAM_NAMES, checkedFixture } from './dota-auto-core';
import { fetchCurrentPatch } from './dota-patch';
import { evaluateValue, MAX_PAPER_BETS_PER_SERIES, ODDS_REFRESH_MS, sameBetFamily, valuePolicy, VALUE_POLICY_VERSION } from './dota-value';
import type { Forecast } from './dota-types';
import {refreshOptions,type RefreshOptions} from './dota-refresh-options';
import {technicalFailure} from './dota-technical-core';
import {recordTechnicalError,redactServerTechnicalText} from './dota-technical-log';

const DEFAULT_ODDSLINK_MONTHLY_CAP=900;
const ODDSLINK_PROVIDER_RESERVE=100;
export function oddsRefreshIntervalMs(forecasts:Pick<Forecast,'scheduled_start_utc'>[],now:number) {
  const starts=forecasts.map(f=>Date.parse(f.scheduled_start_utc)).filter(start=>Number.isFinite(start)&&start>now);
  const hours=starts.length?(Math.min(...starts)-now)/3600000:Infinity;
  if(hours<=3)return 10*60_000;
  if(hours<=12)return 60*60_000;
  return 3*60*60_000;
}
function utcDaysRemaining(now:number) {
  const date=new Date(now),days=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  return days-date.getUTCDate()+1;
}
export function paperAutoConfiguration() {
  const keyed=!!env.ODDSLINK_API_KEY?.trim(),policy=valuePolicy(env);
  const limit=env.ODDSLINK_MAX_REQUESTS_PER_DAY==null?(keyed?144:2):Number(env.ODDSLINK_MAX_REQUESTS_PER_DAY);
  if(!Number.isInteger(limit)||limit<0||limit>144)throw new Error('ODDSLINK_MAX_REQUESTS_PER_DAY должен быть целым числом от 0 до 144.');
  const monthly=env.ODDSLINK_MAX_REQUESTS_PER_MONTH==null?(keyed?DEFAULT_ODDSLINK_MONTHLY_CAP:62):Number(env.ODDSLINK_MAX_REQUESTS_PER_MONTH);
  if(!Number.isInteger(monthly)||monthly<0||monthly>5_000_000)throw new Error('ODDSLINK_MAX_REQUESTS_PER_MONTH должен быть целым числом от 0 до 5000000.');
  return {provider:'OddsLink',access:keyed?'api_key':'guest',enabled:env.AUTO_PAPER_ENABLED!=='false',key_required:false,
    supported_markets:['series_winner','map_handicap','map_kills'],max_bets_per_series:MAX_PAPER_BETS_PER_SERIES,duration_supported:false,bookmaker_priority:ODDSLINK_BOOKS,
    max_requests_per_utc_day:keyed?limit:Math.min(limit,2),max_requests_per_utc_month:keyed?monthly:Math.min(monthly,62),provider_reserve:keyed?ODDSLINK_PROVIDER_RESERVE:0,refresh_interval_minutes:{far:180,near:60,imminent:10},value_policy:policy,
    cadence:'Линия загружается только при наличии подходящих будущих прогнозов: дальше 12 часов — раз в 3 часа, за 3–12 часов — раз в час, в последние 3 часа — раз в 10 минут. Месячный бюджет распределяется по оставшимся дням.',
    policy:`Отбор по ожидаемой доходности: (p − ${policy.probability_reserve}) × коэффициент − 1 ≥ ${policy.min_ev}; коэффициент ≥ ${policy.min_odds}. До ${MAX_PAPER_BETS_PER_SERIES} ставок на серию: одна на победу, одна на фору и одна на общий тотал убийств первой карты. Каждая проходит отбор отдельно; риски этих ставок связаны. Цена подтверждена букмекером не более 10 минут назад. Текущий патч обязателен; состав — информационная отметка.`,
    limitation:keyed?'По умолчанию используется не более 900 запросов в календарный месяц и сохраняется резерв 100 запросов у провайдера. Все рынки проверяются одним запросом; ограничивается только частота.':'Гостевой режим: не более двух загрузок в сутки. Для регулярной линии нужен API-ключ с достаточной месячной квотой.'};
}
export async function paperAutoStatus(){
  const r=await env.DB!.prepare("SELECT payload FROM dota_analysis_records WHERE key='paper:auto:last'").first<{payload:string}>();
  return {...paperAutoConfiguration(),last_run:r?JSON.parse(r.payload):null};
}

/** One bounded, deterministic price refresh. Never calls OpenAI or rewrites forecasts. */
export async function runPaperAuto(options:RefreshOptions={}){
  const force=refreshOptions(options).force_refresh;
  const cfg=paperAutoConfiguration(),now=Date.now(),owner=crypto.randomUUID(),db=env.DB!;
  const report={at:new Date(now).toISOString(),provider:'OddsLink',policy_version:VALUE_POLICY_VERSION,status:'blocked',bets_added:0,quotes_added:0,eligible_forecasts:0,skipped:[] as string[],reason:'',coverage:null as ReturnType<typeof oddsLinkCoverage>|null,provider_remaining:null as string|null,provider_monthly_used:null as number|null,provider_monthly_remaining:null as number|null,provider_speed_remaining:null as number|null,local_monthly_used:0,local_monthly_remaining:cfg.max_requests_per_utc_month,refresh_interval_minutes:null as number|null,cached:false};
  if(!cfg.enabled){report.reason='Автоматические виртуальные ставки выключены.';return report;}
  const lease=await db.prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('paper-auto',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(owner,now+300000,now).first<{owner:string}>();
  if(lease?.owner!==owner){report.reason='Запуск уже выполняется.';return report;}
  const save=async(key:string,value:unknown)=>db.prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(key,JSON.stringify(value),new Date().toISOString()).run();
  let capturedProviderError:unknown;
  try{
    const patchRow=await db.prepare("SELECT payload FROM dota_analysis_records WHERE key='state:current_patch'").first<{payload:string}>();
    const patch=patchRow?JSON.parse(patchRow.payload):null;
    if(!patch?.patch_id||!Number.isFinite(Date.parse(patch.verified_at))||Date.parse(patch.verified_at)>now||now-Date.parse(patch.verified_at)>ODDS_REFRESH_MS)await save('state:current_patch',await fetchCurrentPatch(fetch,now));
    const p=await readPaperDashboard();
    const candidates=p.eligible_forecasts.filter(f=>f.market!=='map_duration'&&p.bets.filter(b=>b.forecast.fixture_id===f.fixture_id).length<MAX_PAPER_BETS_PER_SERIES&&!p.bets.some(b=>sameBetFamily(b.forecast,f)));
    const forecasts:Forecast[]=[];
    for(const f of candidates){
      try{forecasts.push(await prepareBetForecast(f));}
      catch(e){
        const failure=technicalFailure(e,'/api/paper/automatic');
        if(failure)await recordTechnicalError({...failure,code:'FORECAST_PREPARATION_FAILED'});
        report.skipped.push(`${f.forecast_id}: ${redactServerTechnicalText(e instanceof Error?e.message:'Не удалось пересчитать прогноз.',1000)}`);
      }
    }
    report.eligible_forecasts=forecasts.length;
    if(!forecasts.length&&!force){report.reason='Нет подходящих будущих прогнозов: проверьте состав, патч, историю внутри патча и уже записанные ставки. Запрос линии не расходуется.';return report;}
    const day=new Date(now).toISOString().slice(0,10),month=day.slice(0,7);
    const dayKey='paper:oddslink:quota:'+day,monthKey='paper:oddslink:monthly:'+month;
    const [previous,monthRow,lastRow]=await Promise.all([
      db.prepare('SELECT payload FROM dota_analysis_records WHERE key=?').bind(dayKey).first<{payload:string}>(),
      db.prepare('SELECT payload FROM dota_analysis_records WHERE key=?').bind(monthKey).first<{payload:string}>(),
      db.prepare("SELECT payload FROM dota_analysis_records WHERE key='paper:oddslink:last-fetch'").first<{payload:string}>(),
    ]);
    const quota=previous?JSON.parse(previous.payload):{count:0,last:0},monthly=monthRow?JSON.parse(monthRow.payload):{count:0,provider_remaining:null,blocked:false};
    const last=lastRow?JSON.parse(lastRow.payload).at:quota.last;
    const localRemaining=Math.max(0,cfg.max_requests_per_utc_month-monthly.count);
    const providerSpendable=Number.isInteger(monthly.provider_remaining)?Math.max(0,monthly.provider_remaining-cfg.provider_reserve):Infinity;
    const spendable=Math.min(localRemaining,providerSpendable);
    const fairToday=spendable>0?Math.max(1,Math.ceil(spendable/utcDaysRemaining(now))):0;
    const todayLimit=force?cfg.max_requests_per_utc_day:Math.min(cfg.max_requests_per_utc_day,fairToday);
    const refreshMs=oddsRefreshIntervalMs(forecasts,now);
    report.local_monthly_used=monthly.count;report.local_monthly_remaining=localRemaining;report.provider_monthly_remaining=Number.isInteger(monthly.provider_remaining)?monthly.provider_remaining:null;report.refresh_interval_minutes=refreshMs/60_000;
    if(monthly.blocked||spendable<=0||(cfg.access==='guest'&&quota.blocked)||quota.count>=todayLimit||(!force&&now-last<refreshMs)){report.cached=true;report.reason=monthly.blocked||spendable<=0?'Месячный бюджет OddsLink исчерпан или достигнут защитный резерв. Новая линия не загружается до следующего месяца.':quota.count>=todayLimit?(force?'Достигнут настроенный суточный предел запросов OddsLink.':'Сегодняшняя доля месячного бюджета уже использована. Неизрасходованные запросы автоматически переносятся на оставшиеся дни месяца.'):`Следующая загрузка разрешена через ${Math.ceil((refreshMs-(now-last))/60_000)} мин.; все рынки будут проверены одним запросом.`;return report;}
    await Promise.all([
      save(dayKey,{count:quota.count+1,last:now}),
      save(monthKey,{...monthly,count:monthly.count+1}),
      save('paper:oddslink:last-fetch',{at:now}),
    ]);
    report.local_monthly_used=monthly.count+1;report.local_monthly_remaining=Math.max(0,localRemaining-1);
    let feed;
    try{feed=await fetchOddsLink(fetch,env.ODDSLINK_API_KEY);}catch(e){
      const failure=technicalFailure(e,'/api/paper/automatic');
      if(failure){await recordTechnicalError({...failure,source:'provider',code:'ODDSLINK_FETCH_FAILED',severity:e instanceof Error&&/HTTP 429/.test(e.message)?'warning':'error'});capturedProviderError=e;}
      if(e instanceof Error&&/HTTP (401|403)|ALLOWANCE_SPENT/.test(e.message))await save(monthKey,{...monthly,count:monthly.count+1,blocked:true});
      else if(cfg.access==='guest'&&e instanceof Error&&/HTTP 429/.test(e.message))await save(dayKey,{count:quota.count+1,last:now,blocked:true});
      throw e;
    }
    const providerRemaining=feed.usage.monthly_remaining??(Number.isInteger(monthly.provider_remaining)?monthly.provider_remaining:null);
    if(cfg.access==='api_key')await save(monthKey,{count:monthly.count+1,provider_remaining:providerRemaining,blocked:providerRemaining!==null&&providerRemaining<=cfg.provider_reserve});
    report.coverage=oddsLinkCoverage(feed.rows,now);report.provider_remaining=feed.remaining;report.provider_monthly_used=feed.usage.monthly_used;report.provider_monthly_remaining=providerRemaining;report.provider_speed_remaining=feed.usage.speed_remaining;
    const rows=await db.prepare("SELECT payload FROM dota_analysis_records WHERE key LIKE 'fixture:%'").all<{payload:string}>();
    const proofs:ScheduleProof[]=[];
    for(const row of rows.results){try{const f=checkedFixture(JSON.parse(row.payload),Date.now());proofs.push({...f,team_a:f.team_a_name??TEAM_NAMES[f.team_a_id]??f.team_a_id,team_b:f.team_b_name??TEAM_NAMES[f.team_b_id]??f.team_b_id});}catch{}}
    const choices:{forecast:Forecast;quote:NonNullable<ReturnType<typeof oddsLinkQuote>>;ev:number}[]=[];
    for(const f of forecasts){
      const events=oddsLinkEvents(feed.rows,f,proofs,Date.now());
      if(events.length!==1){report.skipped.push(`${f.forecast_id}: нет однозначного совпадения подтверждённой BO${f.best_of??3}.`);continue;}
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
        if(!fresh.eligible_forecasts.some(x=>x.forecast_id===f.forecast_id)||fresh.bets.some(b=>sameBetFamily(b.forecast,f))||fresh.bets.filter(b=>b.forecast.fixture_id===f.fixture_id).length>=MAX_PAPER_BETS_PER_SERIES)continue;
        if(fresh.metrics.available_bankroll<fresh.settings.default_stake){report.skipped.push(`${f.forecast_id}: недостаточно свободного банка.`);continue;}
        const q=await recordOddsQuote({...quote,forecast_id:f.forecast_id},'agent');report.quotes_added+=Number(q.inserted);
        const b=await recordPaperBet({quote_id:q.quote.quote_id,bet_id:'auto:'+f.forecast_id,stake:fresh.settings.default_stake});report.bets_added+=Number(b.inserted);
      }catch(e){
        const failure=technicalFailure(e,'/api/paper/automatic');
        if(failure)await recordTechnicalError({...failure,code:'PAPER_BET_WRITE_FAILED'});
        report.skipped.push(`${f.forecast_id}: повторная проверка ставки отклонена; проверьте время, состав, патч и банк.`);
      }
    }
    report.status='ok';report.reason=forecasts.length?`Свежая линия проверена по ожидаемой выгоде. Ставок: ${report.bets_added}. Пропуск — нормальное решение при отсутствии преимущества.`:'Линия обновлена вручную. Нет подходящих прогнозов для новых ставок; проверки истории, патча и уже записанных ставок сохраняются.';
  }catch(e){
    const failure=technicalFailure(e,'/api/paper/automatic');
    if(failure&&e!==capturedProviderError)await recordTechnicalError({...failure,code:'PAPER_REFRESH_FAILED'});
    report.reason=redactServerTechnicalText(e instanceof Error?e.message:'Источник недоступен.',1000);
  }
  finally{
    await db.prepare("INSERT INTO dota_analysis_records(key,payload,updated_utc) SELECT 'paper:auto:last',?,? WHERE EXISTS(SELECT 1 FROM dota_analysis_lease WHERE id='paper-auto' AND owner=?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc").bind(JSON.stringify(report),new Date().toISOString(),owner).run();
    await db.prepare("DELETE FROM dota_analysis_lease WHERE id='paper-auto' AND owner=?").bind(owner).run();
  }
  return report;
}
