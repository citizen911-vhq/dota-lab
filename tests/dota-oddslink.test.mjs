import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {oddsLinkEvents,oddsLinkQuote,fetchOddsLink,oddsLinkCoverage,ODDSLINK_URL} from '../lib/dota-oddslink.ts';
const sample=JSON.parse(readFileSync(new URL('./fixtures/oddslink-observed.json',import.meta.url),'utf8'));
const now=Date.parse(sample.captured_at),e=sample.event;
const f={team_a:'Team Synapse',team_b:'Froglings',scheduled_start_utc:e.commence_time,market:'map_handicap',selection:'a',threshold:1.5};
const proof={...f,best_of:3,status:'scheduled',verified_at:sample.captured_at,source_url:'https://cyberscore.live/en/matches/'};
const line=(overrides={})=>({...e,bookmakers:[{key:'1xbet',markets:[{key:'kills_total',period:'map1',last_update:sample.captured_at,outcomes:[{name:'Over',point:49.5,price:1.81}],...overrides}]}]});
test('observed response matches only with independent BO3 proof',()=>{
 assert.equal(oddsLinkEvents([e],f,[proof],now).length,1);
 assert.equal(oddsLinkEvents([e],f,[],now).length,0);
 for(const p of [{best_of:2},{verified_at:new Date(now-21600001).toISOString()},{source_url:'https://example.com'},{team_a:'Synapse Academy'}])assert.equal(oddsLinkEvents([e],f,[{...proof,...p}],now).length,0);
 for(const p of [{best_of:5},{is_live:true},{status:'ended'},{sport_key:'cs2'},{commence_time:new Date(now-1).toISOString()},{home_team:'Team Synapse Academy'}])assert.equal(oddsLinkEvents([{...e,...p}],f,[proof],now).length,0);
 assert.equal(oddsLinkEvents([e,e],f,[proof],now).length,2,'caller rejects ambiguous events');
});
test('actual signed handicap selects named team even when home/away reverse',()=>{
 const q=oddsLinkQuote(e,f,now); assert.equal(q.decimal_odds,1.47);assert.match(q.source_market_label,/updated 2026/);
 assert.equal(oddsLinkQuote({...e,home_team:e.away_team,away_team:e.home_team},f,now).decimal_odds,1.47);
 assert.equal(oddsLinkQuote(e,{...f,selection:'b',threshold:-1.5},now).decimal_odds,2.48);
 assert.equal(oddsLinkQuote(e,{...f,threshold:2.5},now),null);
});
test('freshness is market time, never request time or bookmaker fallback',()=>{
 for(const time of [null,undefined,'bad',new Date(now-900001).toISOString(),new Date(now+1).toISOString()]){
  const b=structuredClone(e);for(const m of b.bookmakers[0].markets)m.last_update=time;
  b.bookmakers[0].last_update=sample.captured_at;assert.equal(oddsLinkQuote(b,f,now),null);
 }
});
test('duplicate outcomes, exchange and unknown books rejected',()=>{
 const b=structuredClone(e);const m=b.bookmakers[0].markets.find(m=>m.key==='maps_handicap');m.outcomes.push(...structuredClone(m.outcomes));assert.equal(oddsLinkQuote(b,f,now),null);
 for(const key of ['kalshi','polymarket','sxbet','unknown'])assert.equal(oddsLinkQuote({...e,bookmakers:[{...e.bookmakers[0],key}]},f,now),null);
});
test('kills require exact first-map half-line and direction; duration rejected',()=>{
 const k={...f,market:'map_kills',map_number:1,threshold:49.5,selection:'over'};
 assert.equal(oddsLinkQuote(line(),k,now).decimal_odds,1.81);
 for(const p of [{period:'full'},{period:'map2'},{key:'maps_total'},{period:undefined}])assert.equal(oddsLinkQuote(line(p),k,now),null);
 for(const p of [{threshold:44.5},{selection:'under'},{map_number:2},{market:'map_duration'},{selection:'over_or_equal'}])assert.equal(oddsLinkQuote(line(),{...k,...p},now),null);
});
test('series winner does not pick map winner and chooses the highest fresh exact price',()=>{
 const winner={...f,market:'series_winner',selection:'b',threshold:null};
 const q=oddsLinkQuote(e,winner,now);assert.equal(q.decimal_odds,1.54);
 const b=structuredClone(e);for(const m of b.bookmakers[0].markets)m.period='map1';assert.equal(oddsLinkQuote(b,winner,now),null);
 const alternative=structuredClone(e.bookmakers[0]);alternative.key='thunderpick';for(const m of alternative.markets)for(const o of m.outcomes)o.price=10;
 assert.equal(oddsLinkQuote({...e,bookmakers:[alternative,...e.bookmakers]},winner,now).decimal_odds,10);
});
test('coverage reports stale line as absent',()=>{assert.equal(oddsLinkCoverage([e],now).fresh_events,1);assert.equal(oddsLinkCoverage([e],now+1800000).fresh_events,0);});
test('transport is one no-key request, decimal explicitly requested, redirects and 429 not retried',async()=>{
 let calls=0;const result=await fetchOddsLink(async(url,opts)=>{calls++;assert.equal(url,ODDSLINK_URL);assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,undefined);return Response.json([e],{headers:{'X-Tryit-Remaining':'4'}});});
 assert.equal(calls,1);assert.equal(result.remaining,'4');assert.equal(result.usage.guest_remaining,4);assert.equal(result.usage.monthly_remaining,null);
 for(const status of [302,403,429]){let count=0;await assert.rejects(fetchOddsLink(async()=>{count++;return new Response('',{status});}),new RegExp(String(status)));assert.equal(count,1);}
 await assert.rejects(fetchOddsLink(async()=>Response.json({error:'wrong schema'})),/некорректный/);
});

test('authenticated usage separates monthly allowance from the one-second speed window',async()=>{
 const result=await fetchOddsLink(async(url,opts)=>{
  assert.equal(url,'https://oddslink.app'+new URL(ODDSLINK_URL).searchParams.get('path'));
  assert.equal(opts.headers['X-API-Key'],'test-only-key');
  return Response.json([e],{headers:{'x-requests-used':'17','x-requests-remaining':'983','x-requests-last':'1','X-RateLimit-Limit':'2','X-RateLimit-Remaining':'1','X-RateLimit-Reset':'1'}});
 },'test-only-key');
 assert.equal(result.remaining,'983');
 assert.deepEqual(result.usage,{monthly_used:17,monthly_remaining:983,request_cost:1,speed_limit:2,speed_remaining:1,speed_reset_seconds:1,guest_remaining:null});
});

test('authenticated allowance errors preserve the safe provider code without retrying',async()=>{
 let calls=0;
 await assert.rejects(fetchOddsLink(async()=>{calls++;return Response.json({error:{code:'ALLOWANCE_SPENT'}},{status:429});},'test-only-key'),/429 ALLOWANCE_SPENT/);
 assert.equal(calls,1);
});

test('observed Stake ladder accepts exact alternate kill total, not a nearest available line',()=>{
 const event=sample.kills_event;const k={...f,team_a:event.home_team,team_b:event.away_team,scheduled_start_utc:event.commence_time,market:'map_kills',map_number:1,threshold:49.5,selection:'over'};
 const q=oddsLinkQuote(event,k,now);assert.equal(q.bookmaker,'OddsLink / stake');assert.equal(q.decimal_odds,1.55);
 assert.equal(oddsLinkQuote(event,{...k,threshold:39.5},now),null);
 assert.ok(oddsLinkCoverage([event],now).events[0].markets.includes('kills_total:map1'));
});
