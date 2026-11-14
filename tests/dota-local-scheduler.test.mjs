import test from 'node:test';
import assert from 'node:assert/strict';
import {dueAt,runningNow,INTERVAL_MS,RETRY_MS} from '../scripts/dota-local-scheduler.mjs';
const now=Date.parse('2026-11-14T00:00:00Z');
const run={status:'partial',collection_healthy:true,finished_at:new Date(now).toISOString()};
test('local cycle waits four hours after healthy collection, including ordinary partial coverage',()=>{
 assert.equal(dueAt(run),now+INTERVAL_MS);
 assert.ok(dueAt(run)<now+6*3600_000,'overdue wake catches up once, not each missed tick');
});
test('first launch is due and failed or offline cycles back off fifteen minutes',()=>{
 assert.ok(dueAt(null)<now);
 assert.equal(dueAt(null,now),now+RETRY_MS);
 assert.equal(dueAt({...run,status:'failed'},now),now+RETRY_MS);
 assert.equal(dueAt({...run,collection_healthy:false},now),now+RETRY_MS);
 assert.equal(dueAt({...run,finished_at:'bad'},now),now+RETRY_MS);
});
test('active analysis is not duplicated but an expired crashed run cannot block forever',()=>{
 assert.equal(runningNow({status:'running',started_at:new Date(now).toISOString()},now+60_000),true);
 assert.equal(runningNow({status:'running',started_at:new Date(now).toISOString()},now+360_000),false);
 assert.equal(runningNow(run,now),false);
});
