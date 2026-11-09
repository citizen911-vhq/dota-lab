// Offline Workers-runtime smoke test: outboundService intercepts all external calls.
import {Miniflare} from 'miniflare';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const code=ts.transpileModule(await readFile(new URL('../lib/dota-openai.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
let calls=0;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:code.replace(/^export /gm,'')+`\nexport default {async fetch(){return Response.json(await searchPublicOdds('unit-secret',['A'],[],Date.now()));}};`,outboundService:async request=>{
 calls++;assert.equal(request.url,'https://api.openai.com/v1/responses');assert.equal(request.headers.get('authorization'),'Bearer unit-secret');
 return Response.json({status:'completed',output:[{type:'web_search_call',status:'completed',action:{sources:[]}},{type:'message',content:[{type:'output_text',text:'No verified quotes.',annotations:[]}]}]});
}});
try{const response=await mf.dispatchFetch('http://localhost/');const report=await response.json();assert.equal(report.status,'completed');assert.equal(calls,1);assert.equal(report.bets_added,0);console.log('Workers runtime OpenAI transport passed; outbound request intercepted, no live API usage.');}finally{await mf.dispose();}
