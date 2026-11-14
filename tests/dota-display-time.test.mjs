import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DISPLAY_TIME_ZONE,displayDateTimeInput,parseDisplayDateTimeInput,displayDay,displayScheduleTime} from '../lib/dota-display-time.ts';
import {JOURNAL_START_MS,JOURNAL_END_MS} from '../lib/dota-experiment.ts';
import {HISTORY_START_MS} from '../lib/dota-history-policy.ts';

test('MSK display and calendar day change at Moscow midnight, independent of the host timezone',()=>{
  assert.equal(DISPLAY_TIME_ZONE,'Europe/Moscow');
  assert.equal(displayDateTimeInput(Date.parse('2026-11-14T20:59:59Z')),'2026-11-14T23:59:59');
  assert.equal(displayDateTimeInput(Date.parse('2026-11-14T21:00:00Z')),'2026-11-15T00:00:00');
  assert.equal(displayDay('2026-11-14T17:00:00Z'),'2026-11-14');
  assert.equal(displayDay('2026-11-14T21:00:00Z'),'2026-11-15');
  assert.equal(displayDateTimeInput(Date.parse('2026-12-31T23:30:00Z')),'2027-01-01T02:30:00');
});

test('quote input round-trips the same UTC instant and rejects invalid dates and injected offsets',()=>{
  for(const utc of ['2026-11-14T17:00:00.000Z','2026-11-14T21:00:00.000Z','2026-12-31T23:30:12.000Z']){
    assert.equal(parseDisplayDateTimeInput(displayDateTimeInput(Date.parse(utc))).toISOString(),utc);
  }
  assert.equal(parseDisplayDateTimeInput('2026-11-15T00:00').toISOString(),'2026-11-14T21:00:00.000Z');
  for(const input of ['', 'bad', '2026-02-30T12:00', '2026-11-14T25:00', '2026-11-14T12:00Z', '2026-11-14T12:00+09:00']){
    assert.ok(Number.isNaN(parseDisplayDateTimeInput(input).getTime()),input);
  }
});

test('schedule is converted only for display; stored journal and history boundaries are unchanged',()=>{
  assert.equal(displayScheduleTime('17:00','Asia/Yakutsk'),'11:00');
  assert.equal(displayScheduleTime('02:30','Asia/Yakutsk'),'20:30');
  assert.equal(displayScheduleTime('17:00','Europe/Moscow'),'17:00');
  assert.equal(displayScheduleTime('23:00','UTC'),'02:00');
  assert.equal(displayScheduleTime('25:00','Asia/Yakutsk'),null);
  assert.equal(displayScheduleTime('17:00','Unknown/Zone'),null);
  assert.equal(JOURNAL_START_MS,Date.parse('2026-11-13T15:00:00Z'));
  assert.equal(JOURNAL_END_MS,Date.parse('2026-12-13T15:00:00Z'));
  assert.equal(HISTORY_START_MS,Date.parse('2026-08-31T15:00:00Z'));
});

const require=createRequire(import.meta.url);
async function component(path){
  const built=await build({entryPoints:[path],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},external:['react','react/jsx-runtime']});
  const componentModule={exports:{}};
  vm.runInNewContext(built.outputFiles[0].text,{module:componentModule,exports:componentModule.exports,require,URL,Date,Intl,Map,Set,Error});
  return componentModule.exports.default;
}

test('dashboard shows MSK on the initial non-AI page and quote time keeps its UTC machine value',async()=>{
  const Dashboard=await component('components/dota/dashboard.tsx');
  const dashboard=renderToStaticMarkup(React.createElement(Dashboard));
  assert.match(dashboard,/МСК <span>UTC\+3<\/span>/);
  assert.doesNotMatch(dashboard,/Якутск|UTC\+9/);
  const Odds=await component('components/dota/forecast-odds.tsx');
  const observed='2026-11-14T21:30:00Z';
  const html=renderToStaticMarkup(React.createElement(Odds,{forecast:{scheduled_start_utc:'2026-11-16T00:00:00Z',odds_quote:{decimal_odds:1.8,bookmaker:'OddsLink / test',observed_utc:observed}},now:Date.parse(observed)}));
  assert.match(html,/dateTime="2026-11-14T21:30:00Z"/i);
  assert.match(html,/15 нояб/);
  assert.match(html,/00:30/);
  assert.match(html,/Время котировки · МСК/);
});

test('all existing time-rendering surfaces and quote input use Moscow presentation',async()=>{
  const files=['dashboard','paper-bets','auto-status','forecast-odds','team-ranking','automatic-odds','openai-sources','ai-panel','technical-panel'];
  for(const file of files){
    const source=await readFile(`components/dota/${file}.tsx`,'utf8');
    assert.doesNotMatch(source,/Якутск|Якутску|UTC\+9|timeZone:\s*['"]Asia\/Yakutsk['"]/,file);
    assert.match(source,/DISPLAY_TIME_ZONE|Europe\/Moscow/,file);
  }
  const paper=await readFile('components/dota/paper-bets.tsx','utf8');
  assert.match(paper,/parseDisplayDateTimeInput\(observed\)/);
  assert.doesNotMatch(paper,/\+09:00|yakutskInput/);
});
