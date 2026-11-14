import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {explainTechnicalErrors}=await import('../lib/dota-technical-ai.ts');
const event={id:'a'.repeat(64),project:'dota-lab',source:'server',severity:'error',code:'HTTP_503',message:'Storage unavailable',details:'at /lib/dota-store.ts:10',route:'/api/dashboard',count:2,first_seen:'2026-11-14T08:00:00Z',last_seen:'2026-11-14T08:01:00Z'};
const response={status:'completed',usage:{input_tokens:10,output_tokens:30},output:[{type:'message',content:[{type:'output_text',text:'Ошибка доступа к базе. Это гипотеза, не проверка сервера.'}]}]};
test('technical explanation uses existing model without tools, web search, writes or retries',async()=>{
 let calls=0;
 const answer=await explainTechnicalErrors('unit-secret',[event],async(url,opts)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(opts.redirect,'manual');
  assert.equal(opts.headers.Authorization,'Bearer unit-secret');assert.ok(!opts.body.includes('unit-secret'));
  const body=JSON.parse(opts.body);assert.equal(body.model,'gpt-5-mini');assert.equal(body.store,false);assert.equal(body.tools,undefined);assert.ok(body.max_output_tokens<=3000);
  assert.match(body.instructions,/недоверенными/);assert.match(body.instructions,/другим проектам/);
  return Response.json(response);
 });assert.equal(calls,1);assert.equal(answer.status,'completed');assert.equal(answer.input_tokens,10);
});
test('missing key or invalid event count never sends a request',async()=>{
 const never=()=>{assert.fail('unexpected outbound call');};
 assert.equal((await explainTechnicalErrors('',[event],never)).status,'blocked');
 assert.equal((await explainTechnicalErrors('key',[],never)).status,'blocked');
 assert.equal((await explainTechnicalErrors('key',Array(21).fill(event),never)).status,'blocked');
});
test('provider failures are redacted and shared Retry-After can be respected',async()=>{
 for(const status of [401,403,429,503,302]){let calls=0;const r=await explainTechnicalErrors('unit-secret',[event],async()=>{calls++;return new Response('unit-secret',{status,headers:{'Retry-After':'120'}});});assert.equal(calls,1);assert.equal(r.status,'blocked');assert.ok(!JSON.stringify(r).includes('unit-secret'));if([429,503].includes(status))assert.ok(Date.parse(r.retry_after)>=Date.now()+119000);}
 assert.equal((await explainTechnicalErrors('unit-secret',[event],async()=>{throw Error('unit-secret');})).status,'blocked');
});
test('partial/refusal/malformed answers do not become completed explanations',async()=>{
 for(const body of [{...response,status:'incomplete'},{status:'completed',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}]){
  const r=await explainTechnicalErrors('key',[event],async()=>Response.json(body));assert.equal(r.status,'blocked');assert.equal(r.text,'');
 }
 const r=await explainTechnicalErrors('unit-secret',[event],async()=>Response.json({...response,output:[{type:'message',content:[{type:'output_text',text:'token=unit-secret'}]}]}));assert.ok(!r.text.includes('unit-secret'));
});
