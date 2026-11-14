import test from 'node:test';
import assert from 'node:assert/strict';
import {searchPublicOdds,extractSearchReport,publicSourceUrl,searchDay} from '../lib/dota-openai.ts';
const now=Date.parse('2026-11-09T01:00:00Z');
const response={status:'completed',usage:{input_tokens:10,output_tokens:20},output:[{type:'web_search_call',status:'completed',action:{sources:[{url:'https://example.com/line',title:'Line'}]}},{type:'message',content:[{type:'output_text',text:'Candidate quote; not verified.',annotations:[{type:'url_citation',url:'https://example.com/line',title:'Line'},{type:'url_citation',url:'javascript:alert(1)'}]}]}]};
test('search results stay research, deduplicate sources and never create bets',()=>{
 const r=extractSearchReport(response,now);assert.equal(r.status,'completed');assert.equal(r.sources.length,1);assert.equal(r.verified_quotes,0);assert.equal(r.bets_added,0);assert.equal(r.input_tokens,10);
});
test('incomplete and non-search answers cannot count as a completed search',()=>{
 assert.equal(extractSearchReport({...response,status:'incomplete'},now).status,'blocked');
 assert.equal(extractSearchReport({...response,output:response.output.slice(1)},now).status,'blocked');
});
test('unsafe or credential-bearing source URLs are not exposed as links',()=>{
 for(const url of ['http://example.com','javascript:alert(1)','https://user:password@example.com','https://localhost','https://127.0.0.1/'])assert.equal(publicSourceUrl(url),null);
});
test('day limit resets at Yakutsk midnight',()=>{
 assert.equal(searchDay(Date.parse('2026-11-09T14:59:59Z')),'2026-11-09');assert.equal(searchDay(Date.parse('2026-11-09T15:00:00Z')),'2026-11-10');
});
test('request uses fixed OpenAI endpoint, bounded search, no store or redirects; key only in auth',async()=>{
 let calls=0;const r=await searchPublicOdds('unit-secret',['A'],[],now,async(url,opts)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(opts.headers.Authorization,'Bearer unit-secret');assert.equal(opts.redirect,'manual');assert.ok(!opts.body.includes('unit-secret'));
  const b=JSON.parse(opts.body);assert.equal(b.store,false);assert.equal(b.max_tool_calls,3);assert.equal(b.max_output_tokens,2200);assert.equal(b.tool_choice,'required');
  return Response.json(response);
 });assert.equal(calls,1);assert.equal(r.status,'completed');assert.ok(!JSON.stringify(r).includes('unit-secret'));
});
test('auth, quota and transport failures are redacted and not retried',async()=>{
 for(const status of [401,429,500]) {let calls=0;const r=await searchPublicOdds('unit-secret',[],[],now,async()=>{calls++;return new Response('unit-secret',{status});});assert.equal(calls,1);assert.equal(r.status,'blocked');assert.ok(!JSON.stringify(r).includes('unit-secret'));}
 const r=await searchPublicOdds('unit-secret',[],[],now,async()=>{throw Error('unit-secret');});assert.ok(!JSON.stringify(r).includes('unit-secret'));
});
test('missing key never sends a request',async()=>{
 const r=await searchPublicOdds('',[],[],now,async()=>{throw Error('Unexpected fetch');});assert.equal(r.status,'blocked');assert.match(r.reason,/отсутствует/);
});
test('provider Retry-After survives into the report for manual refresh protection',async()=>{
 const before=Date.now();
 const r=await searchPublicOdds('unit-secret',[],[],now,async()=>new Response('',{status:429,headers:{'Retry-After':'120'}}));
 assert.ok(Date.parse(r.retry_after)>=before+120000);
 assert.ok(Date.parse(r.retry_after)<=Date.now()+120000);
});

test('redirect responses are rejected without following Location',async()=>{
 let calls=0; const r=await searchPublicOdds('unit-secret',[],[],now,async(url,opts)=>{calls++;assert.equal(opts.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://example.com'}});});
 assert.equal(calls,1);assert.equal(r.status,'blocked');assert.match(r.reason,/302/);
});
