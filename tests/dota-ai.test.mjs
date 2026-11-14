import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {aiRequest,buildAiSnapshot,aiContext,moscowDay,moscowDayStart}=await import('../lib/dota-ai-context.ts');
const {extractAiContent,generateAiContent}=await import('../lib/dota-ai.ts');
const now=Date.parse('2026-11-14T22:00:00Z'), at='2026-11-14T21:30:00Z';
const f={forecast_id:'f1',fixture_id:'s1',team_a:'Alpha',team_b:'Beta',label:'Alpha wins',probability:.5,created_utc:at,scheduled_start_utc:'2026-11-15T01:00:00Z',n_maps_a:30,n_maps_b:29};
const policy={min_odds:1.7,min_ev:.05,probability_reserve:.03};
function snapshot(){
 const bets=[{forecast:f,status:'won',odds_snapshot:2,probability_snapshot:.6,stake:1,placed_utc:'2026-11-14T19:00:00Z',settled_utc:at,profit:1},{forecast:f,status:'pending',odds_snapshot:1.9,probability_snapshot:.7,stake:1,placed_utc:at,settled_utc:null,profit:null}];
 return buildAiSnapshot([f,{...f,forecast_id:'f2',label:'Beta wins'}],{bets,quotes:[],metrics:{bankroll:101,available_bankroll:100,open_stakes:1}},{'paper:auto:last':{at,reason:'Cycle done',skipped:['f1: Price too low']},secret:'never-send-me'},null,[{maps_added:40}],policy,'database',now);
}
const response={status:'completed',usage:{input_tokens:10,output_tokens:20},output:[{type:'web_search_call',status:'completed'},{type:'message',content:[{type:'output_text',text:'News [1]',annotations:[{type:'url_citation',start_index:5,end_index:8,url:'https://example.com/news',title:'Official source'}]}]}]};
test('AI modes and fixture inputs are strictly validated',()=>{
 for(const bad of [null,[],{}, {mode:'bet'},{mode:'news',fixture_id:2},{mode:'daily',fixture_id:'s1'},{mode:'explain',force_refresh:'true'}])assert.throws(()=>aiRequest(bad));
 assert.deepEqual(aiRequest({mode:'news'}),{mode:'news',fixture_id:null,force_refresh:false});
});
test('daily boundary uses Moscow midnight, not browser or Yakutsk day',()=>{
 assert.equal(moscowDay(Date.parse('2026-11-14T20:59:59Z')),'2026-11-14');
 assert.equal(moscowDay(Date.parse('2026-11-14T21:00:00Z')),'2026-11-15');
 assert.equal(moscowDayStart(now),Date.parse('2026-11-14T21:00:00Z'));
});
test('daily counters distinguish forecasts, bets placed and bets settled',()=>{
 const s=snapshot();assert.deepEqual(s.daily,{forecasts:2,bets:1,settled:1,won:1,lost:0,void:0,profit:1,analyses:1,maps_added:40});
 assert.equal(s.fixtures[0].bets[0].probability,.6);assert.equal(s.fixtures[0].forecasts[0].probability,.5);
});
test('facts map recorded reasons to series without inventing absent reasons',()=>{
 const s=snapshot();assert.equal(s.issues.length,1);assert.equal(s.issues[0].fixture_id,'s1');assert.equal(s.issues[0].reason,'Alpha wins: Price too low');
 assert.equal(s.fixtures[0].quotes.length,0);assert.ok(!JSON.stringify(s).includes('never-send-me'));
 const clean=buildAiSnapshot([f],{bets:[],quotes:[],metrics:{}},{},null,[],policy,'database',now);assert.deepEqual(clean.issues,[]);
 assert.throws(()=>aiContext(s,'explain','missing'));
});
test('news context includes only team names and schedule, no bankroll or bet details',()=>{
 const c=aiContext(snapshot(),'news','s1');assert.deepEqual(c.fixtures,[{team_a:'Alpha',team_b:'Beta',scheduled_start_utc:f.scheduled_start_utc}]);
 for(const word of ['bankroll','probability','Price too low','never-send-me'])assert.ok(!JSON.stringify(c).includes(word));
});
test('news needs a completed search plus valid clickable inline citations',()=>{
 const good=extractAiContent(response,'news');assert.equal(good.status,'completed');assert.equal(good.parts[0].citations[0].start,5);assert.equal(good.sources.length,1);
 for(const change of [{status:'incomplete'},{output:response.output.slice(1)},{output:[response.output[0],{type:'message',content:[{type:'output_text',text:'Rumour',annotations:[]}]}]}]){
  const bad=extractAiContent({...response,...change},'news');assert.equal(bad.status,'blocked');assert.deepEqual(bad.parts,[]);
 }
});
test('invalid, unsafe and overlapping citations cannot become links',()=>{
 for(const url of ['javascript:alert(1)','http://example.com','https://localhost','https://user:secret@example.com']){
  const bad=structuredClone(response);bad.output[1].content[0].annotations[0].url=url;assert.equal(extractAiContent(bad,'news').status,'blocked');
 }
 const overlap=structuredClone(response),content=overlap.output[1].content[0];content.text='123456789';content.annotations=[{...content.annotations[0],start_index:0,end_index:5},{...content.annotations[0],start_index:3,end_index:8},{...content.annotations[0],start_index:5,end_index:9}];
 assert.deepEqual(extractAiContent(overlap,'news').parts[0].citations.map(c=>[c.start,c.end]),[[0,5],[5,9]]);
});
test('only news receives web search, no mode receives app writer tools or secrets in context',async()=>{
 for(const mode of ['explain','news','daily']){
  let calls=0;const r=await generateAiContent('unit-secret',mode,{day:'2026-11-15'},async(url,opts)=>{
   calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(opts.headers.Authorization,'Bearer unit-secret');assert.equal(opts.redirect,'manual');assert.ok(!opts.body.includes('unit-secret'));
   const body=JSON.parse(opts.body);assert.equal(body.store,false);assert.ok(body.max_output_tokens<=3000);
   if(mode==='news'){assert.equal(body.max_tool_calls,3);assert.equal(body.tool_choice,'required');assert.deepEqual(body.tools.map(t=>t.type),['web_search']);}else assert.equal(body.tools,undefined);
   return Response.json(response);
  });assert.equal(calls,1);assert.equal(r.status,'completed');
 }
});
test('missing key, oversized input, auth errors, cooldown and transport failures are safe',async()=>{
 const unexpected=async()=>{assert.fail('unexpected API call');};
 assert.equal((await generateAiContent('','daily',{},unexpected)).status,'blocked');
 assert.equal((await generateAiContent('unit-secret','daily','x'.repeat(120001),unexpected)).status,'blocked');
 for(const status of [401,429,503,302]){let calls=0;const r=await generateAiContent('unit-secret','explain',{},async()=>{calls++;return new Response('unit-secret',{status,headers:{'Retry-After':'120'}});});assert.equal(calls,1);assert.equal(r.status,'blocked');assert.ok(!JSON.stringify(r).includes('unit-secret'));if([429,503].includes(status))assert.ok(Date.parse(r.retry_after)>Date.now()+119000);}
 const r=await generateAiContent('unit-secret','explain',{},async()=>{throw Error('unit-secret');});assert.ok(!JSON.stringify(r).includes('unit-secret'));
});
