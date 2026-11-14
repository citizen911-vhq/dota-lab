// Offline D1 logger tests: no network and no real project database.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const worker=`import {recordTechnicalError,readTechnicalEvents,captureBrowserErrors} from './lib/dota-technical-log';
import {fail,json} from './lib/dota-http';import {DataError} from './lib/dota-core';
import {runPaperAuto} from './lib/dota-paper-auto';
export default {async fetch(r){const path=new URL(r.url).pathname;try{
 if(path==='/read')return json(await readTechnicalEvents());
 if(path==='/paper-run')return json(await runPaperAuto({force_refresh:true}));
 const body=await r.json();
 if(path==='/error')return fail(body.expected?new DataError(body.message,body.status):new Error(body.message),'/api/test');
 if(path==='/capture')return json(await captureBrowserErrors(body));
 if(path==='/batch'){await Promise.all(body.map(recordTechnicalError));return json({ok:true});}
 await recordTechnicalError(body);return json({ok:true});
}catch(e){return fail(e);}}};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let providerFailure=false,providerCalls=0;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'technical-test-only'},bindings:{OPENAI_API_KEY:'unit-private-key'},outboundService:request=>{assert.ok(providerFailure,'Technical logger must never call external APIs');assert.equal(new URL(request.url).hostname,'oddslink.app');providerCalls++;return new Response('Mocked provider error',{status:429});}});
async function request(path,body){const r=await mf.dispatchFetch('http://localhost'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
try{
 const db=await mf.getD1Database('DB');
 // Missing table: logger must still let the original operation finish.
 assert.equal((await request('/log',{source:'server',code:'X',message:'Before migration'})).status,200);
 assert.equal((await request('/error',{expected:true,status:503,message:'Original storage problem'})).status,503);
 for(const name of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+name,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('other:record','{"preserve":true}',new Date().toISOString()).run();
 const incident={source:'server',code:'CACHE_ERROR',message:'unit-private-key token=querysecret',details:'at /Users/alice/repo/a.ts',route:'/api/test?key=secret'};
 assert.equal((await request('/batch',Array.from({length:30},()=>incident))).status,200);
 let events=(await request('/read')).body;assert.equal(events.length,1);assert.equal(events[0].count,30);assert.equal(events[0].project,'dota-lab');assert.equal(events[0].route,'/api/test');
 assert.ok(!JSON.stringify(events).includes('unit-private-key'));assert.ok(!JSON.stringify(events).includes('querysecret'));assert.ok(!JSON.stringify(events).includes('alice'));
 assert.ok(Date.parse(events[0].last_seen)>=Date.parse(events[0].first_seen));
 const before=JSON.stringify(events);
 for(const status of [400,401,403,409,429])assert.equal((await request('/error',{expected:true,status,message:'Business skip'})).status,status);
 assert.equal(JSON.stringify((await request('/read')).body),before);
 const failed=await request('/error',{expected:false,message:'Broken unit-private-key'});assert.equal(failed.status,500);assert.ok(!JSON.stringify(failed).includes('unit-private-key'));
 assert.equal((await request('/error',{expected:true,status:503,message:'Unavailable unit-private-key'})).status,503);
 assert.equal((await request('/capture',{events:[{code:'browser.runtime',message:'UI failed',source:'server',project:'other',first_seen:'1900',count:999}]})).body.accepted,1);
 const captured=(await request('/read')).body.find(e=>e.code==='browser.runtime');assert.equal(captured.source,'browser');assert.equal(captured.project,'dota-lab');assert.equal(captured.count,1);assert.notEqual(captured.first_seen,'1900');
 assert.equal((await request('/capture',{events:[]})).status,400);
 const older='2020-01-01T00:00:00.000Z';
 await db.batch(Array.from({length:505},(_,i)=>db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('tech:v1:event:seed'+i,JSON.stringify({id:'seed'+i,project:'dota-lab',source:'server',severity:'error',code:'SEED',message:'old',details:'',route:null,first_seen:older,last_seen:older,count:1}),older)));
 await request('/log',{source:'server',code:'AFTER_SEEDS',message:'Retention trigger'});
 assert.equal((await request('/read')).body.length,500);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM dota_analysis_records WHERE key LIKE 'tech:v1:event:%'").first()).n,500);
 assert.equal((await db.prepare("SELECT payload FROM dota_analysis_records WHERE key='other:record'").first()).payload,'{"preserve":true}');
 for(const table of ['dota_forecasts','dota_observations','dota_odds_quotes','dota_paper_bets'])assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM '+table).first()).n,0);
 await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('state:current_patch',JSON.stringify({patch_id:'99',verified_at:new Date().toISOString()}),new Date().toISOString()).run();
 providerFailure=true;
 assert.equal((await request('/paper-run')).status,200);assert.equal(providerCalls,1);
 const providerEvents=(await request('/read')).body.filter(e=>e.code==='ODDSLINK_FETCH_FAILED');assert.equal(providerEvents.length,1);assert.equal(providerEvents[0].count,1);assert.equal(providerEvents[0].source,'provider');assert.equal(providerEvents[0].severity,'warning');
 assert.ok(!(await request('/read')).body.some(e=>e.code==='PAPER_REFRESH_FAILED'),'same provider failure not logged twice');
 assert.equal((await request('/paper-run')).status,200);assert.equal(providerCalls,1,'normal quota skip never requests provider or creates incident');
 assert.equal((await request('/read')).body.find(e=>e.code==='ODDSLINK_FETCH_FAILED').count,1);
 console.log('Technical logger passed: atomic concurrent dedup, max500 retention, sanitized credentials, browser provenance, expected-error exclusion, logging-failure isolation and provider capture without duplicates/business skips. No real external APIs.');
}finally{await mf.dispose();}
