import test from 'node:test';
import assert from 'node:assert/strict';
import {rankPrimaryTeams} from '../lib/dota-ranking.ts';
test('ranking uses approved IDs, opponent-adjusted score and null for missing data',()=>{
  const pool=[{id:'1',name:'A'},{id:'2',name:'B'},{id:'3',name:'C'}];
  const rows=[{team_id:'1',rating:1550,maps:30,wins:21,losses:9},{team_id:'2',rating:1600,maps:20,wins:12,losses:8},{team_id:'outside',rating:1900,maps:30,wins:30,losses:0}];
  const ranked=rankPrimaryTeams(pool,rows);
  assert.deepEqual(ranked.map(r=>r.team_id),['2','1','3']);
  assert.equal(ranked[0].win_rate,.6);
  assert.equal(ranked[1].win_rate,.7);
  assert.equal(ranked[2].win_rate,null);
  assert.equal(ranked[2].rank,null);
});
