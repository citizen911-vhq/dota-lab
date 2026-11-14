import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const worker=`import {GET,POST} from './app/api/technical/route';import {GET as EXPORT} from './app/api/technical/export/route';export default {fetch:r=>new URL(r.url).pathname.endsWith('/export')?EXPORT(r):r.method==='POST'?POST(r):GET()};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let calls=0,limited=false;
async function setup(key='unit-secret'){
 const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'tech-only'},bindings:{OPENAI_API_KEY:key,ODDSLINK_API_KEY:'custom-odds-secret'},outboundService:async req=>{
  calls++;assert.equal(req.url,'https://api.openai.com/v1/responses');const payload=await req.json();assert.equal(payload.store,false);assert.equal(payload.tools,undefined);assert.ok(!JSON.stringify(payload).includes('unit-secret'));assert.ok(!JSON.stringify(payload).includes('custom-odds-secret'));
  if(limited)return new Response('',{status:429,headers:{'Retry-After':'120'}});
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Тестовое объяснение сохранённой ошибки.'}]}]});
 }});
 const db=await mf.getD1Database('DB');for(const name of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+name,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 return {mf,db};
}
let {mf,db}=await setup();
const api=async(input,headers={})=>{const r=await mf.dispatchFetch('http://localhost/api/technical',input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});return {status:r.status,data:await r.json()};};
const capture=(message='Database failed; token=unit-secret; custom-odds-secret')=>api({action:'capture',events:[{code:'CLIENT_ERROR',message,details:'at /Users/private/project/main.ts:10',route:'/api/dashboard?token=secret',source:'server',project:'other'}]});
try{
 const initial=await api();assert.equal(initial.status,200);assert.deepEqual(initial.data.events,[]);assert.deepEqual(initial.data.reports,[]);assert.equal(calls,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM dota_analysis_records').first()).n,0,'read opens no job');
 assert.equal((await api({action:'explain'})).status,400);assert.equal(calls,0);
 assert.equal((await api({action:'capture',events:[]},{Origin:'https://evil.example'})).status,403);
 assert.equal((await api({action:'explain',event_ids:['invalid']})).status,400);
 assert.equal((await capture()).status,200);assert.equal(calls,0,'capture never uses AI');
 const event=(await api()).data.events[0];assert.equal(event.project,'dota-lab');assert.equal(event.source,'browser');assert.equal(event.route,'/api/dashboard');
 assert.ok(!JSON.stringify(event).includes('unit-secret'));assert.ok(!JSON.stringify(event).includes('custom-odds-secret'));assert.ok(!JSON.stringify(event).includes('/Users/private'));
 const first=await api({action:'explain',event_ids:[event.id]});assert.equal(first.status,200);assert.equal(first.data.report.status,'completed');assert.equal(calls,1);
 const same=await api({action:'explain',event_ids:[event.id]});assert.equal(same.data.cached,true);assert.equal(calls,1);
 await capture();assert.equal((await api()).data.events[0].count,2);
 const next=await api({action:'explain'});assert.equal(next.data.cached,false);assert.equal(calls,2);assert.notEqual(next.data.report.id,first.data.report.id);
 const exported=await mf.dispatchFetch('http://localhost/api/technical/export?format=json');const packet=await exported.json();assert.equal(packet.events.length,1);assert.equal(packet.reports.length,2);assert.equal(packet.project,'dota-lab');assert.ok(/^[a-f0-9]{64}$/.test(packet.export_id));assert.equal(calls,2);
 const text=await (await mf.dispatchFetch('http://localhost/api/technical/export')).text();assert.match(text,/СОХРАНЁННЫЕ ОБЪЯСНЕНИЯ/);assert.ok(!text.includes('unit-secret'));
 const selected=await (await mf.dispatchFetch('http://localhost/api/technical/export?format=json&report_id='+first.data.report.id)).json();assert.equal(selected.reports.length,1);assert.equal(selected.events[0].count,1,'historical report preserves its original event snapshot');
 await db.prepare('INSERT INTO dota_analysis_lease VALUES(?,?,?)').bind('openai-search','other',Date.now()+60000).run();assert.equal((await api({action:'explain'})).status,409);assert.equal(calls,2);await db.prepare("DELETE FROM dota_analysis_lease WHERE owner='other'").run();
 limited=true;await capture('New error');assert.equal((await api({action:'explain'})).data.report.status,'blocked');assert.equal(calls,3);assert.equal((await api({action:'explain'})).status,429);assert.equal(calls,3);
 for(const table of ['dota_forecasts','dota_observations','dota_paper_bets','dota_odds_quotes','dota_paper_settings'])assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM '+table).first()).n,0,'technical journal cannot change '+table);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM dota_analysis_records WHERE key NOT LIKE 'tech:v1:%' AND key<>'ai:provider:cooldown'").first()).n,0);
 console.log('Technical API passed: passive capture, isolated/redacted records, button-only AI, cache/history/export, lease/cooldown, unchanged betting tables. No real API calls.');
}finally{await mf.dispose();}
({mf,db}=await setup(''));limited=false;
try{await capture();const before=calls;const report=await api({action:'explain'});assert.equal(report.data.report.status,'blocked');assert.equal(calls,before);assert.equal((await api()).data.key_configured,false);console.log('Technical missing-key mode passed: log/export work, no AI request.');}finally{await mf.dispose();}
