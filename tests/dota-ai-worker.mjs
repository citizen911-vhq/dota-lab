// Offline end-to-end API test. Separate D1, every outbound call intercepted.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {f,now} from './dota-result-fixtures.mjs';
const worker=`import {GET,POST} from './app/api/ai/route';
const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[${now}]));}static now(){return ${now};}};
export default {fetch:r=>r.method==='POST'?POST(r):GET(r)};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let calls=0,limited=false;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'test-only'},bindings:{OPENAI_API_KEY:'unit-secret'},outboundService:async request=>{
 calls++;assert.equal(request.url,'https://api.openai.com/v1/responses');
 const b=await request.json();assert.equal(b.store,false);assert.ok(!JSON.stringify(b).includes('unit-secret'));
 if(limited)return new Response('',{status:429,headers:{'Retry-After':'120'}});
 return Response.json({status:'completed',output:[...(b.tools?[{type:'web_search_call',status:'completed'}]:[]),{type:'message',content:[{type:'output_text',text:'Test [1]',annotations:b.tools?[{type:'url_citation',start_index:5,end_index:8,url:'https://example.com/news',title:'Source'}]:[]}]}]});
}});
async function post(input,headers={}){const r=await mf.dispatchFetch('http://localhost/api/ai',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});return{status:r.status,data:await r.json()};}
async function get(query='mode=explain'){const r=await mf.dispatchFetch('http://localhost/api/ai?'+query);assert.equal(r.headers.get('Cache-Control'),'no-store');return{status:r.status,data:await r.json()};}
try{
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+name,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 await db.prepare('INSERT INTO dota_forecasts VALUES(?,?,?,?,?)').bind(f.forecast_id,f.fixture_id,JSON.stringify(f),'test-hash',f.created_utc).run();
 async function facts(){const out={};for(const table of ['dota_forecasts','dota_observations','dota_odds_quotes','dota_paper_bets','dota_paper_settings'])out[table]=(await db.prepare('SELECT * FROM '+table).all()).results;return out;}
 const before=await facts();const dashboard=await get();assert.equal(dashboard.status,200);assert.equal(dashboard.data.key_configured,true);assert.equal(dashboard.data.report,null);assert.equal(calls,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM dota_analysis_records').first()).n,0,'GET does not write reports');
 for(const input of [{mode:'bet'},{mode:'daily',fixture_id:'s'},{mode:'news',force_refresh:'true'}])assert.equal((await post(input)).status,400);
 assert.equal((await post({mode:'news'},{Origin:'https://another.example'})).status,403);
 assert.equal((await post({mode:'explain',fixture_id:'missing'})).status,400);assert.equal(calls,0);
 const first=await post({mode:'explain',fixture_id:f.fixture_id});assert.equal(first.status,200);assert.equal(first.data.report.status,'completed');assert.equal(calls,1);
 assert.equal((await post({mode:'explain',fixture_id:f.fixture_id})).data.cached,true);assert.equal(calls,1);
 assert.equal((await post({mode:'explain',fixture_id:f.fixture_id,force_refresh:true})).data.cached,false);assert.equal(calls,2);
 for(const mode of ['news','daily'])assert.equal((await post({mode})).data.report.status,'completed');assert.equal(calls,4);
 assert.equal((await get('mode=explain&fixture_id='+f.fixture_id)).data.report_stale,false);
 await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('paper:auto:last',JSON.stringify({at:new Date(now).toISOString(),reason:'Changed reason',skipped:[f.forecast_id+': no price']}),new Date(now).toISOString()).run();
 assert.equal((await get('mode=explain&fixture_id='+f.fixture_id)).data.report_stale,true);
 await db.prepare('INSERT INTO dota_analysis_lease VALUES(?,?,?)').bind('openai-search','other',now+60000).run();
 assert.equal((await post({mode:'daily',force_refresh:true})).status,409);assert.equal(calls,4);
 await db.prepare("DELETE FROM dota_analysis_lease WHERE owner='other'").run();
 limited=true;assert.equal((await post({mode:'daily',force_refresh:true})).data.report.status,'blocked');assert.equal(calls,5);
 assert.equal((await post({mode:'news',force_refresh:true})).status,429);assert.equal(calls,5);
 assert.deepEqual(await facts(),before,'AI must never alter forecasts, results, prices, bets or bankroll settings');
 assert.ok(!JSON.stringify((await get('mode=daily')).data).includes('unit-secret'));
 console.log('AI API passed: 3 modes, read-only GET, authorization, cache, stale reports, shared lease/cooldown and unchanged betting tables. No real API calls.');
}finally{await mf.dispose();}
