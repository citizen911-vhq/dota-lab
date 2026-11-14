// Isolated D1 and mocked outbound transport: no real API credits or application data.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';

const now=Date.parse('2026-11-14T08:00:00Z');
const worker=`import {POST} from './app/api/openai/route';
const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[${now}]));}static now(){return ${now};}};
export default {fetch:POST};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let calls=0,limited=false;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'test-only'},bindings:{OPENAI_API_KEY:'unit-secret'},outboundService:async request=>{
  calls++;assert.equal(request.url,'https://api.openai.com/v1/responses');
  if(limited)return new Response('',{status:429,headers:{'Retry-After':'120'}});
  return Response.json({status:'completed',output:[{type:'web_search_call',status:'completed',action:{sources:[]}},{type:'message',content:[{type:'output_text',text:'Offline research only.',annotations:[]}]}]});
}});
async function call(input={},headers={}){
  const r=await mf.dispatchFetch('http://localhost/api/openai',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
  return {status:r.status,data:await r.json()};
}
try{
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+name,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const value of ['true',1,null,[]])assert.equal((await call({force_refresh:value})).status,400);
  assert.equal((await call({force_refresh:true},{Origin:'https://another-site.example'})).status,403);
  assert.equal(calls,0);
  assert.equal((await call()).data.cached,false);assert.equal(calls,1);
  assert.equal((await call()).data.cached,true);assert.equal(calls,1,'automatic daily cache preserved');
  assert.equal((await call({force_refresh:false})).data.cached,true);assert.equal(calls,1);
  const forced=await call({force_refresh:true});assert.equal(forced.status,200);assert.equal(forced.data.cached,false);assert.equal(calls,2);
  assert.equal(forced.data.report.bets_added,0,'research never writes bets');
  assert.equal((await call()).data.cached,true);assert.equal(calls,2);
  await db.prepare('INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES(?,?,?)').bind('openai-search','another-run',now+60000).run();
  assert.match((await call({force_refresh:true})).data.reason,/уже выполняется/);assert.equal(calls,2);
  await db.prepare("DELETE FROM dota_analysis_lease WHERE owner='another-run'").run();
  limited=true;
  assert.equal((await call({force_refresh:true})).data.report.status,'blocked');assert.equal(calls,3);
  assert.match((await call({force_refresh:true})).data.reason,/ограничил частоту/);assert.equal(calls,3,'manual refresh respects provider Retry-After');
  console.log('Manual OpenAI refresh passed: real route validation, automatic cache, forced fresh search, lease, provider cooldown, no real API calls.');
}finally{await mf.dispose();}
