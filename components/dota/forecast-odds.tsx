import type {Forecast} from './types';
import './forecast-odds.css';
export default function ForecastOdds({forecast,now}:{forecast:Forecast;now:number}){
  const q=forecast.odds_quote;
  if(!q)return <span className="forecast-odds-missing">Нет котировки</span>;
  const historic=Date.parse(forecast.scheduled_start_utc)<=now;
  const stale=now-Date.parse(q.observed_utc)>600000;
  const time=new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Yakutsk',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(q.observed_utc));
  return <div className={`forecast-odds ${historic||stale?'outdated':''}`}>
    <strong>{q.decimal_odds.toFixed(2).replace('.',',')}</strong>
    <small>{q.bookmaker.replace(/^OddsLink\s*\/\s*/,'')}</small>
    <time dateTime={q.observed_utc} title="Время котировки · Якутск">{time}</time>
    <span>{historic?'До матча':stale?'Устарел · >10 мин':'Свежая котировка'}</span>
  </div>;
}
