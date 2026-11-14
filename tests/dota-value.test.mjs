import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_PAPER_BETS_PER_SERIES,sameBetFamily} from '../lib/dota-value.ts';

const winner={fixture_id:'series',market:'series_winner',family:'series_result',selection:'a',threshold:null};
const handicap={...winner,market:'map_handicap',threshold:1.5};
const kills={...winner,market:'map_kills',family:'map_kills',selection:'over',threshold:49.5,map_number:1};

test('winner, handicap and map kills have separate betting slots without rewriting stored families',()=>{
  assert.equal(MAX_PAPER_BETS_PER_SERIES,3);
  for(const [a,b] of [[winner,handicap],[winner,kills],[handicap,kills]]){
    assert.equal(sameBetFamily(a,b),false);
    assert.equal(sameBetFamily(b,a),false);
  }
  assert.equal(winner.family,'series_result');
  assert.equal(handicap.family,'series_result');
});

test('alternate sides and lines cannot create another bet in the same market',()=>{
  assert.equal(sameBetFamily(winner,{...winner,selection:'b'}),true);
  assert.equal(sameBetFamily(handicap,{...handicap,selection:'b',threshold:-1.5}),true);
  assert.equal(sameBetFamily(kills,{...kills,selection:'under',threshold:44.5}),true);
  // Stored display/analysis family labels cannot bypass the market limit.
  assert.equal(sameBetFamily(handicap,{...handicap,family:'another-label'}),true);
  for(const f of [winner,handicap,kills])assert.equal(sameBetFamily(f,{...f,fixture_id:'other-series'}),false);
});
