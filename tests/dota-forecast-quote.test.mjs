import test from 'node:test';
import assert from 'node:assert/strict';
import {forecastQuote} from '../lib/dota-forecast-quote.ts';
const now=Date.parse('2026-11-14T00:00:00Z');
const q={quote_id:'1',forecast_id:'a',decimal_odds:1.8,bookmaker:'Book',observed_utc:new Date(now-60000).toISOString(),recorded_utc:new Date(now).toISOString(),source_url:'https://example.com'};
test('quote is bound to exact forecast, not another side of same series',()=>{
  assert.equal(forecastQuote('b',[q],now),null);
  assert.equal(forecastQuote('a',[q],now).decimal_odds,1.8);
});
test('latest observed quote wins, not an older higher price or a future quote',()=>{
  const older={...q,quote_id:'old',decimal_odds:9,observed_utc:new Date(now-7200000).toISOString()};
  const future={...q,quote_id:'future',observed_utc:new Date(now+1000).toISOString()};
  assert.equal(forecastQuote('a',[older,q,future],now).decimal_odds,1.8);
  assert.equal(forecastQuote('a',[{...q,decimal_odds:NaN}],now),null);
  assert.equal(forecastQuote('a',[],now),null);
});
