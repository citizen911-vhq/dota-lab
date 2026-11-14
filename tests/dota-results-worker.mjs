// Isolated Workers+D1 test; no real provider, journal or account is touched.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {base,now,f,fixture,html,raw} from './dota-result-fixtures.mjs';
const {maps,row,page}=fixture([false,true,false]);
const future={...f,forecast_id:'future-winner',fixture_id:'future-series',scheduled_start_utc:new Date(now+86400000).toISOString()};
const worker=`import {updateMatchResults} from './lib/dota-result-store';
import {readPaperDashboard} from './lib/dota-paper-store';
const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[${now}]));}static now(){return ${now};}};
export default {async fetch(r){try{return Response.json(new URL(r.url).pathname==='/run'?await updateMatchResults():await readPaperDashboard());}catch(e){return Response.json({error:e.message},{status:500});}}};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let calls=0,details=0,allowMissing=false,sourceAvailable=false;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'results-test'},bindings:{OPENDOTA_API_KEY:'test-only-key'},outboundService:async r=>{
  calls++;const url=new URL(r.url);
  if(url.hostname==='api.opendota.com'){
    assert.equal(r.headers.get('authorization'),'Bearer test-only-key');
    if(url.pathname.includes('/teams/'))return Response.json([]);
    if(url.pathname.includes('/leagues/'))return Response.json(maps.map(raw));
    if(url.pathname==='/api/matches/'+maps[1].id){details++;return allowMissing?Response.json(raw(maps[1])):new Response('',{status:503});}
    throw new Error('Unexpected OpenDota request');
  }
  assert.equal(url.hostname,'hawk.live');assert.equal(r.headers.get('authorization'),null);
  if(!sourceAvailable)return new Response('',{status:503});
  return new Response(html(url.pathname.includes('/results/')?{seriesResultsByChampionships:[{seriesResults:[row]}]}:page),{headers:{'content-type':'text/html'}});
}});
async function call(path){const r=await mf.dispatchFetch('http://localhost'+path,{method:path==='/run'?'POST':'GET'});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
try{
  const db=await mf.getD1Database('DB');
  for(const file of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+file,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.prepare('INSERT INTO dota_paper_settings VALUES(?,?,?)').bind('main',JSON.stringify({initial_bankroll:100,default_stake:1,unit_label:'ед.',created_utc:new Date(base-120000).toISOString()}),new Date(base-120000).toISOString()).run();
  for(const forecast of [f,future]){
    await db.prepare('INSERT INTO dota_forecasts VALUES(?,?,?,?,?)').bind(forecast.forecast_id,forecast.fixture_id,JSON.stringify(forecast),'hash',forecast.created_utc).run();
    const time=new Date(base-30000).toISOString(),q={quote_id:'quote-'+forecast.forecast_id,forecast_id:forecast.forecast_id,bookmaker:'test-only',decimal_odds:11.5,observed_utc:time,recorded_utc:time,source_url:'https://example.com/odds',entry_method:'agent'};
    await db.prepare('INSERT INTO dota_odds_quotes VALUES(?,?,?,?,?)').bind(q.quote_id,q.forecast_id,JSON.stringify(q),'hash',time).run();
    const b={bet_id:'bet-'+forecast.forecast_id,forecast_id:forecast.forecast_id,quote_id:q.quote_id,stake:1,placed_utc:time,probability_snapshot:forecast.probability,odds_snapshot:11.5};
    await db.prepare('INSERT INTO dota_paper_bets VALUES(?,?,?,?,?,?)').bind(b.bet_id,b.forecast_id,b.quote_id,JSON.stringify(b),'hash',time).run();
  }
  for(const m of [maps[0],maps[2]])await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('match:'+m.id,JSON.stringify(m),new Date(now).toISOString()).run();
  const before=await call('/paper');assert.equal(before.metrics.pending,2);
  await db.prepare("INSERT INTO dota_analysis_lease VALUES('daily','test-updater',?)").bind(now+300000).run();
  assert.equal((await call('/run')).status,'busy');assert.equal(calls,0,'No external requests while the full updater owns history');
  await db.prepare("DELETE FROM dota_analysis_lease WHERE id='daily' AND owner='test-updater'").run();
  const partial=await call('/run');assert.equal(partial.observations_added,1,JSON.stringify(partial));assert.equal(partial.queue_count,1);assert.match(partial.checks[0].reason,/Победитель Froglings подтверждён/);
  const early=await call('/paper');assert.equal(early.metrics.won,1);assert.equal(early.metrics.profit,10.5);assert.equal(early.bets.find(b=>b.forecast_id===f.forecast_id).series_score,null);
  assert.equal((await call('/run')).observations_added,0,'Winner is idempotent even if the final score source stays unavailable');
  sourceAvailable=true;
  const first=await call('/run');assert.equal(first.observations_added,1,'Map 1 confirms without needing the missing middle map');assert.equal(first.queue_count,1);assert.match(first.checks[0].reason,/догрузка/);
  assert.equal((await call('/paper')).metrics.profit,10.5,'Map proof never pays winner twice');
  allowMissing=true;
  const attempts=await Promise.all([call('/run'),call('/run')]);
  assert.equal(attempts.reduce((sum,r)=>sum+r.observations_added,0),1,JSON.stringify(attempts));
  const success=attempts.find(r=>r.observations_added===1);assert.deepEqual(success.checks[0].score,[1,2]);assert.equal(success.maps_added,1);assert.equal(success.queue_count,0);assert.equal(details,4);
  const after=await call('/paper');assert.equal(after.metrics.won,1);assert.equal(after.metrics.pending,1);assert.equal(after.metrics.profit,10.5);
  const bet=after.bets.find(b=>b.forecast_id===f.forecast_id);assert.equal(bet.payout,11.5);assert.equal(bet.probability_snapshot,.258);assert.equal(bet.odds_snapshot,11.5);assert.deepEqual(bet.series_score,[1,2]);
  assert.equal(after.bets.length,before.bets.length,'Result refresh never places new bets');
  const count=calls;assert.equal((await call('/run')).observations_added,0);assert.equal(calls,count,'Completed series does not refetch or settle twice');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM dota_observations').first()).n,3);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM dota_analysis_records WHERE key LIKE 'match:%'").first()).n,3);
  assert.equal(after.bets.find(b=>b.forecast_id===f.forecast_id).settled_utc,early.bets.find(b=>b.forecast_id===f.forecast_id).settled_utc);
  console.log('Result worker passed: winner settles with missing middle map and unavailable Hawk; map 1 settles independently; exact score waits; later evidence never pays twice.');
}finally{await mf.dispose();}
