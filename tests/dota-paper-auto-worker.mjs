// Entire pipeline in an isolated Workers + SQLite runtime. All network is intercepted.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=Date.parse('2026-11-09T00:00:00Z'),iso=offset=>new Date(base+offset).toISOString();
const f={forecast_id:'test-handicap',fixture_id:'test-series',team_a:'Power Rangers',team_b:'Nemiga Gaming',scheduled_start_utc:iso(3600000),created_utc:iso(-60000),data_cutoff_utc:iso(-60000),cohort_date:'2026-11-09',model_version:'test',selection_version:'test',market:'map_handicap',family:'series',selection:'a',threshold:1.5,probability:.7,label:'test handicap',map_number:null,selected:true,selection_rank:1,n_maps_a:30,n_maps_b:30};
const kills={...f,forecast_id:'test-kills',market:'map_kills',family:'kills',selection:'over',threshold:49.5,map_number:1,selection_rank:2};
const third={...f,forecast_id:'test-third',selection_rank:3};
const event={id:'test-provider-id',sport_key:'dota2',status:'scheduled',is_live:false,commence_time:f.scheduled_start_utc,home_team:f.team_a,away_team:f.team_b,bookmakers:[{key:'1xbet',markets:[{key:'maps_handicap',last_update:iso(-1000),outcomes:[{name:f.team_a,point:1.5,price:1.5}]},{key:'kills_total',period:'map1',last_update:iso(-1000),outcomes:[{name:'Over',point:49.5,price:2}]}]}]};
const worker=`import {runPaperAuto,paperAutoStatus} from './lib/dota-paper-auto';
import {readPaperDashboard} from './lib/dota-paper-store';
import {recordResult} from './lib/dota-store';
const RealDate=Date;let clock=${base};globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
export default {async fetch(r){try{const path=new URL(r.url).pathname;if(path==='/clock'){clock=Number(await r.text());return Response.json({clock});}if(path==='/run')return Response.json(await runPaperAuto());if(path==='/status')return Response.json(await paperAutoStatus());if(path==='/result')return Response.json(await recordResult(await r.json()));return Response.json(await readPaperDashboard());}catch(e){return Response.json({error:e.message},{status:500});}}};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let calls=0;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'test-only'},outboundService:async r=>{calls++;assert.equal(new URL(r.url).hostname,'oddslink.app');assert.equal(r.headers.get('authorization'),null);return Response.json([event],{headers:{'X-Tryit-Remaining':'4'}});}});
async function call(path,body){const r=await mf.dispatchFetch('http://localhost'+path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
try{
 const db=await mf.getD1Database('DB');
 for(const filename of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())for(const statement of (await readFile('drizzle/'+filename,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
 for(const forecast of [f,kills,third])await db.prepare('INSERT INTO dota_forecasts VALUES(?,?,?,?,?)').bind(forecast.forecast_id,forecast.fixture_id,JSON.stringify(forecast),'test-hash',forecast.created_utc).run();
 const fixture={team_a_id:'55',team_b_id:'5014799',scheduled_start_utc:f.scheduled_start_utc,best_of:3,status:'scheduled',source_url:'https://cyberscore.live/en/matches/',verified_at:iso(-1000)};
 await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('fixture:test',JSON.stringify(fixture),iso(-1000)).run();
 const runs=await Promise.all([call('/run'),call('/run')]);assert.equal(runs.reduce((s,r)=>s+r.bets_added,0),2,JSON.stringify(runs));assert.equal(calls,1);
 let paper=await call('/paper');assert.equal(paper.bets.length,2);assert.equal(paper.quotes.length,2);assert.equal(paper.metrics.available_bankroll,98);assert.equal(paper.metrics.pending,2);
 assert.deepEqual(paper.bets.map(b=>b.odds_snapshot).sort(),[1.5,2]);
 const again=await call('/run');assert.equal(again.cached,true);assert.equal(calls,1);assert.equal((await call('/status')).last_run.bets_added,2);
 await call('/clock',base+2*3600000);
 const result=await call('/result',{fixture_id:f.fixture_id,series_score:[1,2],map1:{kills_a:20,kills_b:20,duration_seconds:2400},sources:['https://cyberscore.live/en/matches/'],note:'Offline synthetic test only'});
 paper=await call('/paper');assert.equal(paper.metrics.won,1);assert.equal(paper.metrics.lost,1);assert.equal(paper.metrics.profit,-.5);assert.equal(paper.metrics.bankroll,99.5);assert.equal(paper.metrics.roi,-.25);assert.equal(paper.metrics.max_drawdown,.5);
 await call('/clock',base+2*3600000+60000);
 await call('/result',{fixture_id:f.fixture_id,series_void:true,map1_void:true,supersedes:result.observation.observation_id,sources:['https://cyberscore.live/en/matches/'],note:'Offline correction test only'});
 paper=await call('/paper');assert.equal(paper.metrics.void,2);assert.equal(paper.metrics.bankroll,100);assert.equal(paper.metrics.profit,0);
 console.log('Workers + D1 pipeline passed: concurrent run -> two immutable paper bets -> no duplicate requests/bets -> verified win/loss -> ROI and drawdown -> correction/refunds. No live requests or production writes.');
}finally{await mf.dispose();}
