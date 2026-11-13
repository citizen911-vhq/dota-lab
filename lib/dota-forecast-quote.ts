import type {OddsQuote} from './dota-paper-types';
export function forecastQuote(id:string,quotes:OddsQuote[],now:number){
  const candidates=quotes.filter(q=>q.forecast_id===id&&Number.isFinite(q.decimal_odds)&&q.decimal_odds>=1.01&&
    Number.isFinite(Date.parse(q.observed_utc))&&Date.parse(q.observed_utc)<=now&&Number.isFinite(Date.parse(q.recorded_utc))&&Date.parse(q.recorded_utc)<=now);
  candidates.sort((a,b)=>Date.parse(b.observed_utc)-Date.parse(a.observed_utc)||Date.parse(b.recorded_utc)-Date.parse(a.recorded_utc)||a.quote_id.localeCompare(b.quote_id));
  const q=candidates[0];
  return q?{decimal_odds:q.decimal_odds,bookmaker:q.bookmaker,observed_utc:q.observed_utc,source_url:q.source_url}:null;
}
