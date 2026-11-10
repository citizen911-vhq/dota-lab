import type { Forecast } from './dota-types';
type Obj = Record<string, any>;
// Fixed priority, independent of probability and price. No exchanges/prediction markets.
export const ODDSLINK_BOOKS = ['pinnacle', '1xbet', 'thunderpick', 'bet365', 'stake'];
export const ODDSLINK_PATH = '/v1/sports/dota2/odds?markets=h2h,maps_handicap,kills_total&periods=full,map1&oddsFormat=decimal';
export const ODDSLINK_URL = 'https://oddslink.app/v1/tryit/run?path=' + encodeURIComponent(ODDSLINK_PATH);
function candidateQuote(bookKey:string,eventId:string,key:string,period:string,outcome:string,line:number|string,updated:string,price:number){
  return {bookmaker:`OddsLink / ${bookKey}`,decimal_odds:price,observed_utc:new Date(updated).toISOString(),source_url:'https://oddslink.app'+ODDSLINK_PATH,
    source_market_label:`OddsLink; event ${eventId}; ${key}; ${period}; ${outcome}; line ${line}; updated ${updated}`};
}
const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
const fresh = (v: unknown, now: number) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now && now - Date.parse(v) <= 600_000;
export interface ScheduleProof { team_a: string; team_b: string; scheduled_start_utc: string; best_of: number; status: string; verified_at: string; source_url: string }
function pair(e: Obj, a: string, b: string) { return (same(e.home_team, a) && same(e.away_team, b)) || (same(e.home_team, b) && same(e.away_team, a)); }
export function oddsLinkEvents(rows: unknown, f: Forecast, proofs: ScheduleProof[], now: number): Obj[] {
  if (!Array.isArray(rows) || !Number.isFinite(Date.parse(f.scheduled_start_utc)) || Date.parse(f.scheduled_start_utc) <= now) return [];
  const verified = proofs.some(p => {
    let source = false;
    try { const u = new URL(p.source_url); source = u.protocol === 'https:' && ['cyberscore.live', 'www.cyberscore.live', 'liquipedia.net', 'dota.haglund.dev'].includes(u.hostname); } catch {}
    return source && p.best_of === 3 && p.status === 'scheduled' && Date.parse(p.verified_at) <= now && now - Date.parse(p.verified_at) <= 6 * 3600_000 && Math.abs(Date.parse(p.scheduled_start_utc) - Date.parse(f.scheduled_start_utc)) <= 60_000 && pair({ home_team: p.team_a, away_team: p.team_b }, f.team_a, f.team_b);
  });
  if (!verified) return [];
  return rows.filter(e => e && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 200 && e.sport_key === 'dota2' && e.status === 'scheduled' && e.is_live === false && (e.best_of == null || e.best_of === 3) && Date.parse(e.commence_time) > now && Math.abs(Date.parse(e.commence_time) - Date.parse(f.scheduled_start_utc)) <= 60_000 && pair(e, f.team_a, f.team_b));
}
export function oddsLinkQuote(e: Obj, f: Forecast, now: number) {
  if (e.sport_key !== 'dota2' || e.status !== 'scheduled' || e.is_live !== false || !(Date.parse(e.commence_time) > now) || !pair(e, f.team_a, f.team_b) || !Number.isFinite(Date.parse(f.scheduled_start_utc)) || Math.abs(Date.parse(e.commence_time) - Date.parse(f.scheduled_start_utc)) > 60_000) return null;
  const key = f.market === 'series_winner' ? 'h2h' : f.market === 'map_handicap' ? 'maps_handicap' : f.market === 'map_kills' && f.map_number === 1 ? 'kills_total' : null;
  if (!key || !Array.isArray(e.bookmakers)) return null;
  if (f.market === 'map_kills' ? !['over', 'under'].includes(f.selection) || typeof f.threshold !== 'number' || f.threshold % 1 !== 0.5 : !['a', 'b'].includes(f.selection)) return null;
  const target = f.selection === 'a' ? f.team_a : f.team_b;
  let best: ReturnType<typeof candidateQuote> | null = null;
  for (const bookKey of ODDSLINK_BOOKS) {
    const books = e.bookmakers.filter((b: Obj) => b?.key === bookKey);
    if (books.length !== 1 || !Array.isArray(books[0].markets)) continue;
    const book = books[0], candidates = [];
    for (const m of book.markets) {
      if (!m || m.key !== key || !fresh(m.last_update, now) || !Array.isArray(m.outcomes)) continue;
      if (f.market === 'map_kills' ? m.period !== 'map1' : m.period != null && m.period !== 'full') continue;
      for (const o of m.outcomes) {
        if (!o || typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price < 1.01 || o.price > 1000) continue;
        if (f.market === 'map_kills' ? !same(o.name, f.selection) || o.point !== f.threshold : !same(o.name, target)) continue;
        // Signed points apply to the named team, including the away team.
        if (f.market === 'map_handicap' && (typeof o.point !== 'number' || o.point !== f.threshold)) continue;
        if (f.market === 'series_winner' && o.point != null) continue;
        candidates.push(candidateQuote(bookKey,e.id,key,m.period??'full',o.name,f.threshold??'winner',m.last_update,o.price));
      }
    }
    if (candidates.length === 1 && (!best || candidates[0].decimal_odds > best.decimal_odds)) best=candidates[0];
  }
  return best;
}
export function oddsLinkCoverage(rows: Obj[], now: number) {
  const future = rows.filter(e => e?.sport_key === 'dota2' && e.status === 'scheduled' && e.is_live === false && Date.parse(e.commence_time) > now);
  const events = future.map(e => ({ event_id: e.id, team_a: e.home_team, team_b: e.away_team, start: e.commence_time, markets: [...new Set((Array.isArray(e.bookmakers) ? e.bookmakers : []).filter((b: Obj) => ODDSLINK_BOOKS.includes(b?.key)).flatMap((b: Obj) => (Array.isArray(b.markets) ? b.markets : []).filter((m: Obj) => m && fresh(m.last_update, now) && Array.isArray(m.outcomes) && m.outcomes.some((o: Obj) => typeof o?.price === 'number' && o.price >= 1.01 && o.price <= 1000)).map((m: Obj) => `${m.key}:${m.period ?? 'full'}`)))] }));
  return { events_received: rows.length, future_events: future.length, fresh_events: events.filter(e => e.markets.length).length, events: events.slice(0, 40) };
}
export async function fetchOddsLink(fetcher: typeof fetch = fetch, apiKey?: string) {
  try {
    const key = apiKey?.trim();
    const r = await fetcher(key ? 'https://oddslink.app' + ODDSLINK_PATH : ODDSLINK_URL, { redirect: 'manual', signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json', ...(key ? { 'X-API-Key': key } : {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 4_000_000) throw new Error('oversize');
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 500) throw new Error('invalid');
    return { rows: rows as Obj[], remaining: r.headers.get(key ? 'X-RateLimit-Remaining' : 'X-Tryit-Remaining') };
  } catch (e) {
    const code = e instanceof Error ? e.message.match(/^HTTP (\d{3})$/)?.[1] : null;
    throw new Error(code ? `OddsLink: HTTP ${code}; повторных запросов нет.` : 'OddsLink недоступен или вернул некорректный ответ; повторных запросов нет.');
  }
}
