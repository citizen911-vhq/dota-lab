import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {bettingContextReason}=await import('../lib/dota-betting-context.ts');

const now=Date.parse('2026-11-09T00:00:00Z'),at=ms=>new Date(now+ms).toISOString();
const r=(players)=>({account_ids:players,verified_at:at(-60_000),source_url:'https://cyberscore.live/en/matches/',has_standin:false});
const rosters={team_a:r([1,2,3,4,5]),team_b:r([6,7,8,9,10])};
const f={model_version:'prematch-elo-v2',betting_eligible:true,patch_id:'99',team_a_id:'7119388',team_b_id:'2163',scheduled_start_utc:at(3600_000),roster_snapshots:rosters};
const fixture={team_a_id:f.team_a_id,team_b_id:f.team_b_id,scheduled_start_utc:f.scheduled_start_utc,verified_at:at(-60_000),status:'scheduled',best_of:3,patch_id:'99',rosters};
const context={patch:{patch_id:'99',verified_at:at(-60_000)},health:{healthy:true,verified_at:at(-60_000)},alerts:{},fixtures:[fixture]};

test('current clean proof permits value policy to decide',()=>assert.equal(bettingContextReason(f,context,now),null));
test('changed patch, invalid history and old patch proof block immutable forecast',()=>{
  assert.match(bettingContextReason(f,{...context,patch:{patch_id:'100',verified_at:at(-60_000)}},now),/Патч изменился/);
  assert.match(bettingContextReason(f,{...context,health:{healthy:false,verified_at:at(-60_000)}},now),/История/);
  assert.match(bettingContextReason(f,{...context,patch:{patch_id:'99',verified_at:at(-600_001)}},now),/патч/i);
});
test('new lineup, stand-in, stale or absent roster and roster alerts never block a valid forecast',()=>{
  const changed={...fixture,rosters:{...rosters,team_a:r([1,2,3,4,11])}};
  assert.equal(bettingContextReason(f,{...context,fixtures:[changed]},now),null);
  const standin={...fixture,rosters:{...rosters,team_a:{...rosters.team_a,has_standin:true}}};
  assert.equal(bettingContextReason(f,{...context,fixtures:[standin]},now),null);
  assert.equal(bettingContextReason({...f,model_version:'prematch-elo-v3',roster_snapshots:undefined},{...context,alerts:{55:'Changed lineup'},fixtures:[{...fixture,rosters:undefined}]},now),null);
  assert.equal(bettingContextReason(f,{...context,fixtures:[{...fixture,rosters:{...rosters,team_a:{...rosters.team_a,verified_at:at(-86400000)}}}]},now),null);
  assert.match(bettingContextReason(f,{...context,fixtures:[]},now),/подтверждения/);
});
test('legacy probability-first forecast is never new betting authorization',()=>{
  assert.match(bettingContextReason({...f,model_version:'baseline-v1'},context,now),/Исторический/);
});
