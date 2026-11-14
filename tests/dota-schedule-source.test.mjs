import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {fetchHaglundSchedule, parseHaglundSchedule, TRACKED_SCHEDULE_TEAMS, HAGLUND_SCHEDULE_URL, SCHEDULE_TIMEOUT_MS} = await import('../lib/dota-schedule-source.ts');
const {VERIFIED_TEAM_IDENTITIES} = await import('../lib/dota-team-identity.ts');

const now = Date.parse('2026-11-08T09:00:00Z');
const fixture = (overrides = {}) => ({
  id: 'test-fixture:01', hash: 'a'.repeat(64),
  teams: [{ name: 'Power Rangers', url: 'https://liquipedia.net/dota2/Power_Rangers' }, { name: 'PlayTime', url: 'https://liquipedia.net/dota2/PlayTime' }],
  matchType: 'Bo3', startsAt: '2026-11-08T10:00:00Z',
  leagueUrl: 'https://liquipedia.net/dota2/Test_Only#Round_1',
  ...overrides,
});

test('Valve IDs, tags and saved aliases resolve consistently; collisions fail closed',()=>{
 const catalog=[{id:'1',name:'Alpha',tag:'AA',aliases:['Old Alpha'],eligible:true},{id:'2',name:'Beta',tag:'BB',aliases:[],eligible:false}];
 const resolve=teams=>parseHaglundSchedule([fixture({teams})],now,catalog);
 assert.equal(resolve([{team_id:1,name:'Alpha'},{tag:'BB'}]).fixtures.length,1);
 assert.equal(resolve([{name:'Old Alpha'},{name:'Beta'}]).fixtures.length,1);
 assert.equal(resolve([{team_id:2,name:'Alpha'},{name:'Beta'}]).fixtures.length,0);
 const unresolved=resolve([{name:'Unverified alias'},{name:'Beta'}]);
 assert.equal(unresolved.rejected.length,1);
 assert.deepEqual(unresolved.recognized_team_ids,['2']);
 const fixed=parseHaglundSchedule(unresolved.rejected.map(r=>r.row),now,[{...catalog[0],aliases:['Unverified alias']},catalog[1]]);
 assert.equal(fixed.fixtures.length,1);
 assert.equal(fixed.fixtures[0].provider_id,'test-fixture:01');
 assert.equal(parseHaglundSchedule([fixture({teams:[{tag:'AA'},{name:'Beta'}]})],now,[catalog[0],{...catalog[1],tag:'AA'}]).fixtures.length,0);
});
const jsonResponse = (body, options = {}) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}, ...options});

test('1win reviewed aliases, URLs and tags resolve to one Valve ID without weakening identity guards',()=>{
 const identity=VERIFIED_TEAM_IDENTITIES[0];
 const catalog=[{id:identity.id,name:'1win',tag:'1win',aliases:[],eligible:true},{id:'10331884',name:'Froglings',aliases:[],eligible:false}];
 const resolve=(team,entries=catalog)=>parseHaglundSchedule([fixture({teams:[team,{name:'Froglings'}]})],now,entries);
 for(const alias of identity.aliases){
   const r=resolve({name:'  '+alias.toUpperCase().replace(/ /g,'  ')+'  '});
   assert.equal(r.fixtures.length,1,alias);
   assert.equal(r.fixtures[0].team_a_id,identity.id);
 }
 for(const path of identity.liquipedia_paths)assert.equal(resolve({url:'https://liquipedia.net/dota2/'+path}).fixtures.length,1);
 assert.equal(resolve({tag:'1W'}).fixtures.length,1);
 for(const name of ['1win Academy','1w Junior','Team 1win','1winner','Tundra Esports'])assert.equal(resolve({name}).fixtures.length,0,name);
 assert.equal(resolve({name:'1w Team',team_id:'10331884'}).fixtures.length,0);
 assert.equal(resolve({name:'1w',team_id:'999'}).fixtures.length,0);
 assert.equal(resolve({name:'1w',url:'https://liquipedia.net/dota2/Froglings'},[catalog[0],{...catalog[1],liquipedia_url:'https://liquipedia.net/dota2/Froglings'}]).fixtures.length,0);
 assert.equal(resolve({name:'1w'},[catalog[0],{...catalog[1],aliases:['1w']}]).fixtures.length,0);
 assert.equal(resolve({name:'1w Team'},[{...catalog[0],id:'999'},catalog[1]]).fixtures.length,0);
 const old=resolve({name:'1w Team'},[catalog[1]]);
 assert.equal(old.rejected.length,1);
 const replay=parseHaglundSchedule(old.rejected.map(x=>x.row),now,catalog);
 assert.equal(replay.fixtures[0].provider_id,'test-fixture:01');
 assert.equal(parseHaglundSchedule([old.rejected[0].row,old.rejected[0].row],now,catalog).fixtures.length,1);
});

test('canonical mapping contains eight distinct verified Valve identities and no LEGION alias', () => {
  assert.equal(new Set(TRACKED_SCHEDULE_TEAMS.map(t => t.id)).size, 8);
  assert.equal(TRACKED_SCHEDULE_TEAMS.find(t => t.name === 'PlayTime').id, '10020555');
  assert.equal(TRACKED_SCHEDULE_TEAMS.find(t => t.name === 'Froglings').aliases.includes('LEGION'), false);
});

test('parser preserves real provider provenance, UTC time, BO3 and cached-feed warning', () => {
  const result = parseHaglundSchedule([fixture()], now);
  assert.deepEqual(result.fixtures[0], {
    provider_id: 'test-fixture:01', team_a_id: '55', team_b_id: '10020555',
    team_a_name: 'Power Rangers', team_b_name: 'PlayTime',
    scheduled_start_utc: '2026-11-08T10:00:00.000Z', best_of: 3, status: 'scheduled',
    verified_at: new Date(now).toISOString(),
    sources: [HAGLUND_SCHEDULE_URL, 'https://liquipedia.net/dota2/Test_Only#Round_1'],
  });
  assert.match(result.warnings[0], /кэшируется до 3 часов/);
  assert.match(result.warnings[0], /не независимого подтверждения/);
  assert.equal(result.source, HAGLUND_SCHEDULE_URL);
});

test('parser accepts a real BO2 without turning it into BO3',()=>{
  const result=parseHaglundSchedule([fixture({id:'test-bo2',matchType:'Bo2'})],now);
  assert.equal(result.fixtures.length,1);
  assert.equal(result.fixtures[0].best_of,2);
});

test('exact URLs and exact observed aliases work; fuzzy names, TBD, former teams and identity conflicts do not', () => {
  const teamPairs = [
    [{name: 'Unrecognized display name', url: 'https://liquipedia.net/dota2/Power_Rangers'}, {name: 'PlayTime'}],
    [{name: 'Xipto Esports (page does not exist)'}, {name: 'Team Synapse'}],
    [{name: 'Power Ranger'}, {name: 'PlayTime'}],
    [{name: 'TBD'}, {name: 'PlayTime'}],
    [{name: 'LEGION'}, {name: 'Power Rangers'}],
    [{name: 'PlayTime', url: 'https://liquipedia.net/dota2/Power_Rangers'}, {name: 'Synapse'}],
    [{name: 'power rangers'}, {name: 'PlayTime'}],
    [{name: 'PlayTime'}, {name: 'PlayTime'}],
  ];
  const result = parseHaglundSchedule(teamPairs.map((teams, i) => fixture({id: `test:${i}`, teams})), now);
  assert.deepEqual(result.fixtures.map(f => f.provider_id), ['test:0', 'test:1']);
});

test('only strictly future starts within 192 hours are emitted', () => {
  const dates = ['2026-11-08T08:59:59Z', '2026-11-08T09:00:00Z', '2026-11-08T09:00:01Z', '2026-11-16T09:00:00Z', '2026-11-16T09:00:01Z'];
  assert.deepEqual(parseHaglundSchedule(dates.map((startsAt, i) => fixture({id: `test:${i}`, startsAt})), now).fixtures.map(f => f.provider_id), ['test:2', 'test:3']);
});

test('dynamic catalog includes every supported series involving at least one eligible team',()=>{
  const catalog=[
    {id:'1',name:'Tier One',eligible:true},
    {id:'2',name:'Ordinary Opponent',eligible:false},
    {id:'3',name:'Other Team',eligible:false},
  ];
  const rows=[
    fixture({id:'dynamic:1',teams:[{name:'tier one'},{name:'Ordinary Opponent'}]}),
    fixture({id:'dynamic:2',teams:[{name:'Ordinary Opponent'},{name:'Other Team'}]}),
  ];
  const result=parseHaglundSchedule(rows,now,catalog);
  assert.deepEqual(result.fixtures.map(row=>row.provider_id),['dynamic:1']);
  assert.equal(result.fixtures[0].team_b_id,'2');
});

test('malformed calendar dates, timezone-free dates, missing IDs and unsupported series formats are rejected', () => {
  const rows = [fixture({startsAt: '2026-02-30T10:00:00Z'}), fixture({startsAt: '2026-11-08T10:00:00'}), fixture({startsAt: 'tomorrow'}), fixture({startsAt: null}), fixture({id: null, hash: 'bad'}), fixture({matchType: 'Bo5'}), fixture({matchType: 3}), fixture({teams: null}), null];
  assert.equal(parseHaglundSchedule(rows, now).fixtures.length, 0);
  assert.equal(parseHaglundSchedule({error: 'bad'}, now).fixtures.length, 0);
  assert.throws(() => parseHaglundSchedule([], NaN), RangeError);
});

test('duplicate IDs deduplicate; conflicting schedule identities are all excluded', () => {
  assert.equal(parseHaglundSchedule([fixture(), fixture()], now).fixtures.length, 1);
  const conflict = parseHaglundSchedule([fixture(), fixture({startsAt: '2026-11-08T13:00:00Z'}), fixture()], now);
  assert.equal(conflict.fixtures.length, 0);
  assert.ok(conflict.warnings.some(w => w.includes('противоречивые')));
});

test('hash fallback stays provider-supplied and untrusted source URLs are not published', () => {
  const result = parseHaglundSchedule([fixture({id: null, leagueUrl: 'https://liquipedia.net.evil.example/dota2/Test'})], now);
  assert.equal(result.fixtures[0].provider_id, 'a'.repeat(64));
  assert.deepEqual(result.fixtures[0].sources, [HAGLUND_SCHEDULE_URL]);
});

test('one bounded JSON request uses no credentials and declines redirects', async () => {
  const result = await fetchHaglundSchedule(async (url, init) => {
    assert.equal(url, HAGLUND_SCHEDULE_URL);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    return jsonResponse([fixture()]);
  }, now);
  assert.equal(result.fixtures.length, 1);
  const redirect = await fetchHaglundSchedule(async () => new Response(null, {status: 302, headers: {location: 'https://example.com'}}), now);
  assert.equal(redirect.fixtures.length, 0);
  assert.ok(redirect.warnings.some(w => w.includes('Перенаправление')));
});

test('429 never retries; HTML, malformed JSON and API errors do not become fixtures', async () => {
  let calls = 0;
  const limited = await fetchHaglundSchedule(async () => { calls++; return new Response('', {status: 429}); }, now);
  assert.equal(calls, 1);
  assert.match(limited.warnings.at(-1), /429/);
  for (const response of [new Response('<html>login</html>', {headers: {'content-type': 'text/html'}}), new Response('{broken', {headers: {'content-type': 'application/json'}}), jsonResponse({error: 'not a feed'})]) {
    assert.equal((await fetchHaglundSchedule(async () => response, now)).fixtures.length, 0);
  }
});

test('network failure is explicit and does not change coverage claims', async () => {
  const result = await fetchHaglundSchedule(async () => { throw new Error('network failed'); }, now);
  assert.equal(result.fixtures.length, 0);
  assert.match(result.warnings.at(-1), /не обновлено/);
  assert.match(result.warnings[0], /Неполное расписание/);
});

test('eight-second deadline aborts even a fetch implementation that does not reject itself', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let signal;
  const pending = fetchHaglundSchedule(async (_url, init) => { signal = init.signal; return new Promise(() => {}); }, now);
  t.mock.timers.tick(SCHEDULE_TIMEOUT_MS);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.fixtures.length, 0);
  assert.match(result.warnings.at(-1), /Тайм-аут/);
});
