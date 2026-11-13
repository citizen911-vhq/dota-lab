import test from 'node:test';
import assert from 'node:assert/strict';
import {BASELINE_ROSTERS,rosterNotices} from '../lib/dota-rosters.ts';
import {PRIMARY_TEAM_POOL} from '../lib/dota-team-pool.ts';

const now=Date.parse('2026-11-14T00:00:00Z');
const proof=id=>({account_ids:[...BASELINE_ROSTERS[id].account_ids],verified_at:new Date(now-60000).toISOString(),source_url:'https://cyberscore.live/en/matches/',has_standin:false});
const fixture={team_a_id:'7119388',team_b_id:'10182357',team_a_name:'Spirit',team_b_name:'1win',rosters:{team_a:proof('7119388'),team_b:proof('10182357')}};

test('all twelve primary teams have five distinct baseline IDs with real observation provenance',()=>{
  assert.deepEqual(Object.keys(BASELINE_ROSTERS).sort(),PRIMARY_TEAM_POOL.map(([id])=>id).sort());
  for(const r of Object.values(BASELINE_ROSTERS)){
    assert.equal(new Set(r.account_ids).size,5);
    assert.ok(r.account_ids.every(n=>Number.isSafeInteger(n)&&n>0));
    assert.equal(r.source_url,`https://www.opendota.com/matches/${r.match_id}`);
    assert.ok(Date.parse(r.observed_at)<=now);
  }
  assert.ok(BASELINE_ROSTERS['10182357'].account_ids.includes(162798290));
  assert.ok(!BASELINE_ROSTERS['10182357'].account_ids.includes(93618577));
});
test('same account IDs in any order match baseline; missing and stale proofs produce notices',()=>{
  assert.deepEqual(rosterNotices(fixture,{maps:[],series:[]},now),[]);
  const reversed=structuredClone(fixture);reversed.rosters.team_a.account_ids.reverse();
  assert.deepEqual(rosterNotices(reversed,{maps:[],series:[]},now),[]);
  assert.equal(rosterNotices({...fixture,rosters:undefined},{maps:[],series:[]},now).length,2);
  const stale=structuredClone(fixture);stale.rosters.team_a.verified_at=new Date(now-86400000).toISOString();
  assert.match(rosterNotices(stale,{maps:[],series:[]},now).join(' '),/не подтверждён/);
});
test('changed accounts create an advisory without overwriting baseline or merging identities',()=>{
  const before=JSON.stringify(BASELINE_ROSTERS);
  const changed=structuredClone(fixture);changed.rosters.team_b.account_ids[0]=999999;
  assert.match(rosterNotices(changed,{maps:[],series:[]},now).join(' '),/отличаются/);
  const m={team_id:'10182357',start_time:now/1000-3600,duration_seconds:1000,players:changed.rosters.team_b.account_ids};
  assert.match(rosterNotices(fixture,{maps:[m],series:[]},now).join(' '),/в последней карте/);
  assert.deepEqual(rosterNotices(fixture,{maps:[{...m,start_time:now/1000+1}],series:[]},now),[]);
  assert.equal(JSON.stringify(BASELINE_ROSTERS),before);
});
