import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const INTERVAL_MS=4*3600_000;
export const RETRY_MS=15*60_000;
const root=fileURLToPath(new URL('../',import.meta.url));
const runtime=path.join(root,'.sites-runtime/dota-scheduler');
const base='http://127.0.0.1:5173';
const label='local.dotalab.analysis';
export function dueAt(lastRun,lastAttempt=0){
  const completed=lastRun && ['ok','partial'].includes(lastRun.status) && lastRun.collection_healthy && lastRun.finished_at;
  const completedAt=completed?Date.parse(lastRun.finished_at):0;
  return Math.max(Number.isFinite(completedAt)&&completedAt>0?completedAt+INTERVAL_MS:0,lastAttempt+RETRY_MS);
}
export function runningNow(run,now){
  // The app's lease expires after five minutes; a crashed old run must not
  // prevent every subsequent launch. Leave an extra minute of safety.
  return run?.status==='running' && now-Date.parse(run.started_at)<6*60_000;
}
async function api(route,body,timeout=15_000){
  const response=await fetch(base+route,{redirect:'error',signal:AbortSignal.timeout(timeout),
    ...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  if(!response.ok)throw new Error(`Local API HTTP ${response.status}`);
  return response.json();
}
async function occupied(){
  return new Promise(resolve=>{
    const socket=createConnection({host:'127.0.0.1',port:5173});
    const done=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(2000,()=>done(true));
    socket.once('connect',()=>done(true));
    socket.once('error',e=>done(e.code!=='ECONNREFUSED'));
  });
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child;
async function ensureServer(){
  if(await occupied())return;
  if(child&&child.exitCode===null)return;
  const log=await open(path.join(runtime,'server.log'),'a',0o600);
  child=spawn(process.execPath,['scripts/run-framework.mjs','dev','--hostname','127.0.0.1'],{
    cwd:root,env:{...process.env,PATH:`${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`},stdio:['ignore',log.fd,log.fd]});
  await log.close();
  child.on('error',()=>{});
  for(let i=0;i<30;i++){if(await occupied())return;await pause(1000);}
  throw new Error('Local server did not start');
}
async function save(state){
  const target=path.join(runtime,'status.json');
  await writeFile(target+'.tmp',JSON.stringify(state,null,2),{mode:0o600});
  await rename(target+'.tmp',target);
}
export async function serve(){
  await mkdir(runtime,{recursive:true,mode:0o700});
  const lockPath=path.join(runtime,'owner.pid');
  let lock;
  try{lock=await open(lockPath,'wx',0o600);}catch(e){
    if(e.code!=='EEXIST')throw e;
    const pid=Number(await readFile(lockPath,'utf8'));
    if(!Number.isInteger(pid)||pid<=0)throw new Error('Invalid scheduler lock; inspect before restarting');
    try{process.kill(pid,0);throw new Error('Scheduler is already running');}catch(err){if(err.code!=='ESRCH')throw err;}
    await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
  }
  await lock.writeFile(String(process.pid));await lock.close();
  let stopping=false;
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;child?.kill('SIGTERM');});
  let state={};
  try{state=JSON.parse(await readFile(path.join(runtime,'status.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let registered=false;
  try{while(!stopping){
    try{
      await ensureServer();
      const status=await api('/api/analysis/status');
      if(status.coverage!=='dynamic-top20'||!Array.isArray(status.team_pool))throw new Error('Port 5173 is not the expected Dota Lab');
      if(!registered){
        await api('/api/analysis/configuration',{enabled:true,id:label,kind:'local',interval_hours:4,timezone:'Asia/Yakutsk'});
        registered=true;
      }
      const now=Date.now(),next=dueAt(status.last_run,Number(state.last_attempt_ms)||0);
      state={...state,phase:'waiting',checked_at:new Date(now).toISOString(),next_due_at:new Date(next||now).toISOString(),error:null};
      if(now>=next && !runningNow(status.last_run,now)){
        state.last_attempt_ms=now;state.phase='checking_connection';await save(state);
        // Public connectivity probe only. Do not read API keys or spend API quota.
        const online=await fetch('https://dota.haglund.dev/v1/matches',{redirect:'error',signal:AbortSignal.timeout(10_000)});
        if(!online.ok)throw new Error(`Schedule connectivity HTTP ${online.status}`);
        await online.body?.cancel();
        state.phase='running';await save(state);
        const run=await api('/api/analysis/run',{},300_000);
        if(!['ok','partial'].includes(run.status)||!run.finished_at)throw new Error('Analysis did not complete successfully');
        state={...state,phase:'waiting',last_run_id:run.run_id,last_completed_at:run.finished_at,
          result:{status:run.status,healthy:run.collection_healthy,backlog:run.backlog_count,forecasts:run.forecasts_added,bets:run.paper?.bets_added??null},
          next_due_at:new Date(dueAt(run,now)).toISOString()};
      }
      await save(state);
    }catch(e){
      // Never persist response bodies, environment values or API keys.
      state={...state,phase:'retry',checked_at:new Date().toISOString(),error:e instanceof Error?e.name:'Error'};
      await save(state);console.error(new Date().toISOString(),'Local scheduler retry; inspect API status and server.log');
    }
    if(process.argv.includes('--once'))break;
    for(let i=0;i<60&&!stopping;i++)await pause(1000);
  }}finally{await unlink(lockPath).catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await serve();
