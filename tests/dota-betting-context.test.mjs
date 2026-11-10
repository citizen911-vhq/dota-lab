import test from 'node:test';
import assert from 'node:assert/strict';
import {bettingContextReason} from '../lib/dota-betting-context.ts';

const now=Date.parse('2026-11-09T00:00:00Z'),at=ms=>new Date(now+ms).toISOString();
const r=(players)=>({account_ids:players,verified_at:at(-60_000),source_url:'https://cyberscore.live/en/matches/',has_standin:false});
const rosters={team_a:r([1,2,3,4,5]),team_b:r([6,7,8,9,10])};
const f={model_version:'prematch-elo-v2',betting_eligible:true,patch_id:'99',team_a_id:'55',team_b_id:'5014799',scheduled_start_utc:at(3600_000),roster_snapshots:rosters};
const fixture={team_a_id:f.team_a_id,team_b_id:f.team_b_id,scheduled_start_utc:f.scheduled_start_utc,verified_at:at(-60_000),status:'scheduled',best_of:3,patch_id:'99',rosters};
const context={patch:{patch_id:'99',verified_at:at(-60_000)},health:{healthy:true,verified_at:at(-60_000)},alerts:{},fixtures:[fixture]};

test('current clean proof permits value policy to decide',()=>assert.equal(bettingContextReason(f,context,now),null));
test('changed patch, invalid history and old patch proof block immutable forecast',()=>{
  assert.match(bettingContextReason(f,{...context,patch:{patch_id:'100',verified_at:at(-60_000)}},now),/Патч изменился/);
  assert.match(bettingContextReason(f,{...context,health:{healthy:false,verified_at:at(-60_000)}},now),/История/);
  assert.match(bettingContextReason(f,{...context,patch:{patch_id:'99',verified_at:at(-600_001)}},now),/патч/i);
});
test('new lineup, stand-in and unverified lineup block an existing forecast',()=>{
  const changed={...fixture,rosters:{...rosters,team_a:r([1,2,3,4,11])}};
  assert.match(bettingContextReason(f,{...context,fixtures:[changed]},now),/Состав изменился/);
  const standin={...fixture,rosters:{...rosters,team_a:{...rosters.team_a,has_standin:true}}};
  assert.match(bettingContextReason(f,{...context,fixtures:[standin]},now),/не подтверждён/);
  assert.match(bettingContextReason(f,{...context,fixtures:[]},now),/подтверждения/);
});
test('legacy probability-first forecast is never new betting authorization',()=>{
  assert.match(bettingContextReason({...f,model_version:'baseline-v1'},context,now),/Исторический/);
});
