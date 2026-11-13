// End-to-end paper policy in an isolated Workers + D1 runtime; all external I/O is intercepted.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';

const base=Date.parse('2026-11-14T00:00:00Z'),iso=offset=>new Date(base+offset).toISOString();
const roster=(ids)=>({account_ids:ids,verified_at:iso(-60_000),source_url:'https://cyberscore.live/en/matches/',has_standin:false});
const ra=roster([295697470,194979527,294135421,363739653,1675898897]);
const rb=roster([1220993352,127530803,383788462,114162163,120840516]);
const f={forecast_id:'test-handicap',fixture_id:'test-series',team_a:'Team Spirit',team_b:'Team Liquid',team_a_id:'7119388',team_b_id:'2163',scheduled_start_utc:iso(3600000),created_utc:iso(-60000),data_cutoff_utc:iso(-60000),cohort_date:'2026-11-14',model_version:'prematch-elo-v3',selection_version:'expected-value-v1',market:'map_handicap',family:'series_result',selection:'a',threshold:1.5,probability:.62,label:'test handicap',map_number:null,selected:false,n_maps_a:3,n_maps_b:3,betting_eligible:true,patch_id:'99',roster_snapshots:{team_a:ra,team_b:rb}};
const kills={...f,forecast_id:'test-kills',market:'map_kills',family:'map_kills',selection:'over',threshold:49.5,map_number:1,probability:.55};
const poor={...f,forecast_id:'test-poor',market:'series_winner',selection:'b',threshold:null,probability:.4};
const event={id:'test-provider-id',sport_key:'dota2',status:'scheduled',is_live:false,commence_time:f.scheduled_start_utc,home_team:f.team_a,away_team:f.team_b,bookmakers:[{key:'1xbet',markets:[{key:'maps_handicap',last_update:iso(-1000),outcomes:[{name:f.team_a,point:1.5,price:2.4}]},{key:'kills_total',period:'map1',last_update:iso(-1000),outcomes:[{name:'Over',point:49.5,price:2.2}]},{key:'h2h',last_update:iso(-1000),outcomes:[{name:f.team_b,price:1.79}]}]}]};
const worker=`import {runPaperAuto,paperAutoStatus} from './lib/dota-paper-auto';
import {readPaperDashboard} from './lib/dota-paper-store';
import {recordResult} from './lib/dota-store';
const RealDate=Date;let clock=${base};globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
export default {async fetch(r){try{const path=new URL(r.url).pathname;if(path==='/clock'){clock=Number(await r.text());return Response.json({clock});}if(path==='/run')return Response.json(await runPaperAuto());if(path==='/status')return Response.json(await paperAutoStatus());if(path==='/result')return Response.json(await recordResult(await r.json()));return Response.json(await readPaperDashboard());}catch(e){return Response.json({error:e.message},{status:500});}}};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let calls=0;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'test-only'},bindings:{ODDSLINK_API_KEY:'test-only-key'},outboundService:async r=>{calls++;assert.equal(new URL(r.url).hostname,'oddslink.app');assert.equal(r.headers.get('authorization'),null);assert.equal(r.headers.get('x-api-key'),'test-only-key');return Response.json([event],{headers:{'x-requests-used':'1','x-requests-remaining':'999','x-requests-last':'1','X-RateLimit-Limit':'2','X-RateLimit-Remaining':'1','X-RateLimit-Reset':'1'}});}});
async function call(path,body){const r=await mf.dispatchFetch('http://localhost'+path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
try{
  const db=await mf.getD1Database('DB');
  for(const filename of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())for(const statement of (await readFile('drizzle/'+filename,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
  for(const forecast of [f,kills,poor])await db.prepare('INSERT INTO dota_forecasts VALUES(?,?,?,?,?)').bind(forecast.forecast_id,forecast.fixture_id,JSON.stringify(forecast),'test-hash',forecast.created_utc).run();
  const fixture={team_a_id:'7119388',team_b_id:'2163',scheduled_start_utc:f.scheduled_start_utc,team_a_name:f.team_a,team_b_name:f.team_b,best_of:3,status:'scheduled',source_url:'https://cyberscore.live/en/matches/',verified_at:iso(-1000),patch_id:'99'};
  // Stored completed history, independent of the deliberately stale preliminary probabilities.
  const maps=[true,false,true].map((win,i)=>({id:String(999001+i),match_id:String(999001+i),start_time:base/1000-20000+i*3600,end_time:base/1000-17600+i*3600,duration_seconds:2400,radiant_team_id:'7119388',dire_team_id:'2163',radiant_name:f.team_a,dire_name:f.team_b,radiant_kills:win?40:20,dire_kills:win?20:40,radiant_win:win,league_id:'999',series_id:999,series_type:1,patch_id:'99',players:{radiant:ra.account_ids,dire:rb.account_ids},sources:[`https://www.opendota.com/matches/${999001+i}`]}));
  for(const m of maps)await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('match:'+m.id,JSON.stringify(m),iso(-1000)).run();
  const verified=[0,1].map(side=>({series_key:'999:999',team_id:side?'2163':'7119388',team:side?f.team_b:f.team_a,opponent_team_id:side?'7119388':'2163',opponent:side?f.team_a:f.team_b,start_time:maps[0].start_time,end_time:maps[2].end_time,score_team:side?1:2,score_opponent:side?2:1,map_ids:maps.map(m=>m.id),complete_bo3:true,forecast_sample:true,sources:maps[0].sources,verified_at:iso(-1000)}));
  await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('verified:test',JSON.stringify(verified),iso(-1000)).run();
  for(const [key,payload] of [
    ['fixture:test',fixture],['state:current_patch',{patch_id:'99',verified_at:iso(-1000)}],
    ['state:betting_health',{healthy:true,verified_at:iso(-1000)}],['state:roster_alerts',{'7119388':'Состав отличается от базовой пятёрки'}],
  ])await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind(key,JSON.stringify(payload),iso(-1000)).run();
  await db.prepare("UPDATE dota_analysis_records SET payload=? WHERE key='state:betting_health'").bind(JSON.stringify({healthy:true,verified_at:iso(-600001)})).run();
  const stale=await call('/run');assert.equal(stale.bets_added,0);assert.equal(calls,0);assert.ok(stale.skipped.some(s=>s.includes('10 минут')));
  await db.prepare("UPDATE dota_analysis_records SET payload=? WHERE key='state:betting_health'").bind(JSON.stringify({healthy:true,verified_at:iso(-1000)})).run();
  const runs=await Promise.all([call('/run'),call('/run')]);
  assert.equal(runs.reduce((sum,r)=>sum+r.bets_added,0),2,JSON.stringify(runs));assert.equal(calls,1);
  const auto=await call('/status');assert.equal(auto.max_requests_per_utc_month,900);assert.equal(auto.last_run.provider_monthly_remaining,999);assert.equal(auto.last_run.provider_speed_remaining,1);assert.equal(auto.last_run.local_monthly_remaining,899);
  let paper=await call('/paper');assert.equal(paper.bets.length,2);assert.equal(paper.quotes.length,2);
  assert.deepEqual(paper.bets.map(b=>b.odds_snapshot).sort(),[2.2,2.4]);
  assert.ok(paper.bets.every(b=>b.policy_version==='expected-value-v1'&&b.conservative_ev_snapshot>=.05));
  assert.ok(paper.bets.every(b=>b.analysis_snapshot.forecast_stage==='bet-confirmed'&&b.probability_snapshot!==b.analysis_snapshot.preliminary_probability));
  const again=await call('/run');assert.equal(again.bets_added,0);assert.equal(calls,1);
  await call('/clock',base+2*3600000);
  const result=await call('/result',{fixture_id:f.fixture_id,series_score:[1,2],map1:{kills_a:20,kills_b:20,duration_seconds:2400},sources:['https://cyberscore.live/en/matches/'],note:'Offline synthetic test only'});
  paper=await call('/paper');assert.equal(paper.metrics.won,1);assert.equal(paper.metrics.lost,1);
  await call('/clock',base+2*3600000+60000);
  await call('/result',{fixture_id:f.fixture_id,series_void:true,map1_void:true,supersedes:result.observation.observation_id,sources:['https://cyberscore.live/en/matches/'],note:'Offline correction test only'});
  paper=await call('/paper');assert.equal(paper.metrics.void,2);assert.equal(paper.metrics.bankroll,100);
  console.log('Workers + D1 policy passed: roster warning and missing lineup do not block bets; EV ranking, one quote refresh, two distinct market families, immutable snapshots, settlement and correction.');
}finally{await mf.dispose();}
