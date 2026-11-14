import { readDashboard } from '@/lib/dota-store';
import { fail,json } from '@/lib/dota-http';
import { loadBettingContext, readStoredQuotes } from '@/lib/dota-paper-store';
import { forecastQuote } from '@/lib/dota-forecast-quote';
import { rosterNotices } from '@/lib/dota-rosters';
import {poolWarnings} from '@/lib/dota-expansion';
import type { ForecastView } from '@/lib/dota-types';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const data=await readDashboard(),now=Date.now();
    const quotes=await readStoredQuotes();
    const context=await loadBettingContext();
    const decorate=(f:ForecastView):ForecastView=>{
      if(!['prematch-elo-v3','prematch-elo-v4'].includes(f.model_version)||Date.parse(f.scheduled_start_utc)<=now)return f;
      const fixture=context.fixtures.find(x=>x.team_a_id===String(f.team_a_id)&&x.team_b_id===String(f.team_b_id)&&Date.parse(x.scheduled_start_utc)===Date.parse(f.scheduled_start_utc));
      const saved=Array.isArray(f.roster_warnings)?f.roster_warnings.filter((x):x is string=>typeof x==='string'):[];
      const warnings=fixture?rosterNotices({...fixture,team_a_name:f.team_a,team_b_name:f.team_b},{maps:[],series:[]},now):saved;
      for(const [id,name] of [[f.team_a_id,f.team_a],[f.team_b_id,f.team_b]])if(context.alerts[String(id)])warnings.push(`${name}: ${context.alerts[String(id)]}`);
      return {...f,roster_warnings:[...new Set(warnings)],pool_warnings:poolWarnings(context.expansion,[String(f.team_a_id),String(f.team_b_id)])};
    };
    const withQuote=(f:ForecastView)=>({...decorate(f),odds_quote:forecastQuote(f.forecast_id,quotes,now)});
    return json({...data,forecasts:data.forecasts.map(withQuote),selected_forecasts:data.selected_forecasts.map(withQuote),minute_forecasts:data.minute_forecasts.map(withQuote)});
  } catch(e) { return fail(e); }
}
