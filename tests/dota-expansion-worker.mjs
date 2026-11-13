// Entire runAnalysis pipeline with a disposable D1 database and mocked public sources.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const now=Date.parse('2026-11-14T00:00:00Z'),iso=n=>new Date(now+n).toISOString();
const core=[['9964962','GamerLegion'],['7119388','Team Spirit'],['8255888','BETBOOM TEAM'],['9467224','Aurora Gaming'],['2163','Team Liquid'],['9823272','Team Yandex'],['2576071','Yellow Submarine'],['36','Natus Vincere'],['2586976','OG'],['10282069','CyberHero'],['10182357','1win'],['9824702','PARIVISION']];
const challengers=Array.from({length:9},(_,i)=>String(900+i));
const directory=[...core,...challengers.map(id=>[id,'Challenger '+id])].map(([team_id,name])=>({team_id:Number(team_id),name,tag:'T'+team_id,rating:1000,last_match_time:now/1000-1}));
const fixtures=[
 {id:'qualified',teams:[{team_id:900,name:'Challenger 900'},{team_id:9964962,name:'GamerLegion'}],matchType:'Bo3',startsAt:iso(3600000)},
 {id:'needs-alias',teams:[{name:'Corrected alias'},{name:'GamerLegion'}],matchType:'Bo3',startsAt:iso(7200000)},
 {id:'not-in-top',teams:[{team_id:908,name:'Challenger 908'},{name:'GamerLegion'}],matchType:'Bo3',startsAt:iso(10800000)},
];
const worker=`import {runAnalysis,readTeamRanking} from './lib/dota-auto-store';
import {readDashboard} from './lib/dota-store';
const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[${now}]));}static now(){return ${now};}};
export default {async fetch(r){try{const path=new URL(r.url).pathname;if(path==='/run')return Response.json(await runAnalysis(await r.json()));if(path==='/ranking')return Response.json(await readTeamRanking());return Response.json(await readDashboard());}catch(e){return Response.json({error:e.message},{status:500});}}};`;
const built=await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
let requests=[];
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:built.outputFiles[0].text,d1Databases:{DB:'expansion-test-only'},bindings:{AUTO_PAPER_ENABLED:'false'},outboundService:async r=>{
 const u=new URL(r.url);requests.push(u.pathname);
 if(u.hostname==='raw.githubusercontent.com')return Response.json([{id:99,name:'7.40',date:'2026-09-01T00:00:00Z'}]);
 if(u.hostname==='dota.haglund.dev')return Response.json(fixtures);
 assert.equal(u.hostname,'api.opendota.com');
 return Response.json(u.pathname==='/api/teams'?directory:[]);
}});
async function call(path,body){const r=await mf.dispatchFetch('http://localhost'+path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
try{
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir('drizzle')).filter(n=>n.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+name,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 for(const id of challengers)for(let i=0;i<15;i++){
   const match=String(Number(id)*1000+i),start=now/1000-2*86400+i*3600;
   const m={id:match,match_id:match,start_time:start,end_time:start+1800,duration_seconds:1800,radiant_team_id:id,dire_team_id:'9964962',radiant_name:'Challenger '+id,dire_name:'GamerLegion',radiant_kills:30,dire_kills:10,radiant_win:true,league_id:'999',series_id:null,series_type:null,patch_id:'99',players:{radiant:['1','2','3','4','5'],dire:['6','7','8','9','10']},sources:['https://www.opendota.com/matches/'+match]};
   await db.prepare('INSERT INTO dota_analysis_records VALUES(?,?,?)').bind('match:'+match,JSON.stringify(m),iso(-1000)).run();
 }
 const first=await call('/run',{history_only:true});assert.notEqual(first.status,'failed',JSON.stringify(first));
 let ranking=await call('/ranking');
 assert.equal(ranking.expansion.healthy,true);assert.equal(ranking.expansion.active_ids.length,20);
 assert.equal(ranking.expansion.rows.find(r=>r.team_id==='900').maps,15);
 assert.ok(ranking.history_queue.includes('908'));
 assert.ok(ranking.exclusions.some(x=>x.fixture_id==='needs-alias'));
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM dota_forecasts').first()).n,0);
 const aliases=JSON.parse((await db.prepare("SELECT payload FROM dota_analysis_records WHERE key='state:team_aliases'").first()).payload);
 aliases['901'].push('Corrected alias');
 await db.prepare("UPDATE dota_analysis_records SET payload=? WHERE key='state:team_aliases'").bind(JSON.stringify(aliases)).run();
 const second=await call('/run',{});assert.notEqual(second.status,'failed',JSON.stringify(second));
 assert.ok(second.forecasts_added>0,JSON.stringify(second));
 const dashboard=await call('/dashboard');
 assert.ok(dashboard.forecasts.some(f=>f.team_a_id==='901'));
 assert.ok(!dashboard.forecasts.some(f=>f.team_a_id==='908'));
 const count=(await db.prepare('SELECT COUNT(*) AS n FROM dota_forecasts').first()).n;
 const third=await call('/run',{});assert.equal(third.forecasts_added,0,JSON.stringify(third));
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM dota_forecasts').first()).n,count);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM dota_paper_bets').first()).n,0);
 ranking=await call('/ranking');assert.equal(ranking.ranking_history.length,3);
 assert.ok(requests.includes('/api/teams/900/matches'),'promoted teams must be collected next cycle');
 console.log('TOP-20 Workers + D1 passed: promotion cap, queue, alias correction, forecast gating, duplicate-free retry, persisted ranking history, no live bets.');
}finally{await mf.dispose();}
