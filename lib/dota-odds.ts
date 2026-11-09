import type { Forecast } from './dota-types';
type Obj=Record<string,any>;
const same=(a:unknown,b:string)=>typeof a==='string'&&a.trim().toLowerCase()===b.trim().toLowerCase();
export function matchingEvents(rows:unknown,f:Forecast,now:number):Obj[]{
 if(!Array.isArray(rows))return [];
 return rows.filter(e=>e&&e.status==='pending'&&['dota-2','dota2'].includes(e.esports?.game?.slug)&&e.esports?.format?.type==='bestOf'&&e.esports?.format?.games===3&&Number.isFinite(Date.parse(e.date))&&Date.parse(e.date)>now&&Math.abs(Date.parse(e.date)-Date.parse(f.scheduled_start_utc))<=60000&&((same(e.home,f.team_a)&&same(e.away,f.team_b))||(same(e.home,f.team_b)&&same(e.away,f.team_a))));
}
export function quoteFromBoard(board:Obj,event:Obj,f:Forecast,books:string[],now:number){
 if(!board||String(board.id)!==String(event.id)||board.status!=='pending'||board.home!==event.home||board.away!==event.away||Date.parse(board.date)!==Date.parse(event.date)||now>=Date.parse(board.date))return null;
 const market=f.market==='series_winner'?'ML':f.market==='map_handicap'?'Spread':f.market==='map_kills'&&f.map_number===1?'1st Map Total Kills':null;
 if(!market)return null; // Duration semantics are not documented; never substitute another total.
 const team=f.selection==='a'?f.team_a:f.team_b,side=same(board.home,team)?'home':'away';
 for(const book of books){
  const markets=board.bookmakers?.[book];if(!Array.isArray(markets))continue;
  const candidates=[];
  for(const m of markets){
   if(m.name!==market||!Number.isFinite(Date.parse(m.updatedAt))||now-Date.parse(m.updatedAt)>900000||Date.parse(m.updatedAt)>now||!Array.isArray(m.odds))continue;
   for(const o of m.odds){
    if(f.market==='map_handicap'&&(typeof o.hdp!=='number'||(side==='home'?o.hdp:-o.hdp)!==f.threshold))continue;
    if(f.market==='map_kills'&&(typeof o.hdp!=='number'||o.hdp!==f.threshold))continue;
    const raw=o[f.market==='map_kills'?f.selection:side];if(typeof raw!=='number'&&typeof raw!=='string')continue;
    const price=Number(raw);if(!Number.isFinite(price)||price<1.01||price>1000)continue;
    candidates.push({bookmaker:book,decimal_odds:price,observed_utc:new Date(now).toISOString(),source_url:`https://api.odds-api.io/v3/odds?eventId=${encodeURIComponent(String(event.id))}`,source_market_label:`${market}; event ${event.id}; line ${f.threshold??'winner'}; updated ${m.updatedAt}`});
   }
  }
  if(candidates.length===1)return candidates[0]; // Ambiguous duplicate lines are skipped.
 }
 return null;
}
export async function fetchOdds(path:'events'|'odds',params:Record<string,string>,key:string,fetcher:typeof fetch=fetch){
 const url=new URL('https://api.odds-api.io/v3/'+path);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);url.searchParams.set('apiKey',key);
 try{
  const r=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  const raw=await r.text();if(raw.length>4000000)throw new Error('Response too large');return JSON.parse(raw);
 }catch(e){const code=e instanceof Error?e.message.match(/^HTTP (\d{3})$/)?.[1]:null;throw new Error(code?`Источник коэффициентов: HTTP ${code}; повторных запросов нет.`:'Источник коэффициентов недоступен или вернул некорректный ответ.');}
}
