import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { TECHNICAL_CHAT, bridgeCodexArguments, bundleHash, codexClient, createTechnicalBridge, prepareTechnicalTransport, validateSendInput, validateTechnicalBundle, verifyLocalRequest } from '../scripts/dota-technical-bridge.mjs';
import { dotaTechnicalBridge } from '../scripts/vite/dota-technical-plugin.mjs';

const at = '2026-11-14T09:00:00.000Z';
const event = { id: 'e1', project: 'dota-lab', source: 'server', severity: 'error', code: 'DB_ERROR', message: 'Database error', details: 'Statement failed', route: '/api/analyze', first_seen: at, last_seen: at, count: 1 };
const report = { id: 'r1', created_at: at, context_at: at, event_ids: ['e1'], events: [event], status: 'completed', text: 'Проверить схему БД.', reason: 'Ответ готов', input_tokens: 10, output_tokens: 20 };
function bundle() { return { project: 'dota-lab', title: TECHNICAL_CHAT.thread_title, export_id: 'export1', generated_at: at, events: [structuredClone(event)], reports: [structuredClone(report)], retention: { max_events: 500, max_reports: 20 } }; }
function safeConfig(names = [], disabled = false) {
  const args = bridgeCodexArguments(names), features = {};
  for (let index = 0; index < args.length; index++) if (args[index] === '--disable') features[args[index + 1]] = false;
  return { features, web_search: 'disabled', skills: { bundled: { enabled: false } }, apps: { _default: { enabled: false } }, mcp_servers: Object.fromEntries(names.map(name => [name, { enabled: !disabled, bearer_token: 'must-never-be-exported' }])) };
}
function mockProtocol(target, options = {}) {
  const calls = [], closed = []; let sequence = 0;
  const factory = (receivedTarget, disabledNames) => {
    assert.deepEqual(receivedTarget, target);
    const current = sequence++; const names = ['local_test'];
    const thread = { id: target.thread_id, name: target.thread_title, cwd: target.workspace, status: { type: 'notLoaded' }, ephemeral: false, parentThreadId: null, model: 'preserve-this-model' };
    const client = {
      async request(method, params) {
        calls.push({ method, params, disabledNames, current });
        if (method === 'initialize') return {};
        if (method === 'config/read') { const config = safeConfig(names, disabledNames.length > 0); if (options.unsafe && disabledNames.length) config.features.shell_tool = true; if (options.rogueMcp && disabledNames.length) config.mcp_servers.rogue = { enabled: true }; return { config }; }
        if (method === 'thread/read') return { thread: { ...thread, ...(options.wrongThread ? { cwd: '/another-project' } : {}) } };
        if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status: options.busy ? 'inProgress' : 'completed' }] };
        if (method === 'thread/resume') return { thread, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, model: options.modelChange ? 'wrong-model' : thread.model };
        if (method === 'turn/start') { if (options.startError) throw Error('secret should not reach user'); return { turn: { id: 'new-turn' } }; }
        throw Error(`Unexpected method ${method}`);
      },
      notify(method) { assert.equal(method, 'initialized'); },
      async waitTurn(turnId) { assert.equal(turnId, 'new-turn'); if (options.timeout) throw Error('provider-secret'); return { unsafeTool: Boolean(options.toolAttempt), turn: { id: turnId, status: options.failed ? 'failed' : 'completed', error: null } }; },
      close() { closed.push(current); },
    };
    return client;
  };
  return { factory, calls, closed };
}
async function localFixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dota-technical-bridge-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'app'), workspace = path.join(directory, 'technical');
  await mkdir(path.join(root, '.sites-runtime'), { recursive: true });
  await mkdir(workspace);
  const target = { ...TECHNICAL_CHAT, workspace, codex_binary: process.execPath };
  await writeFile(path.join(root, '.sites-runtime', 'technical-chat.json'), JSON.stringify(target));
  const protocol = mockProtocol(target, options);
  const requests = [];
  const bridge = createTechnicalBridge({ root, expected: target, clientFactory: protocol.factory, fetchImpl: async (url, init) => { requests.push({ url: url.toString(), init }); return Response.json(options.bundle ?? bundle()); } });
  return { root, workspace, target, bridge, protocol, requests };
}

test('browser input can only select a stored report, never a target or prompt', () => {
  assert.deepEqual(validateSendInput({}), { report_id: null });
  assert.deepEqual(validateSendInput({ report_id: 'r1' }), { report_id: 'r1' });
  for (const value of [null, [], { text: 'execute this' }, { thread_id: 'other' }, { url: 'https://outside.test' }, { workspace: '/' }, { report_id: '../other' }, { report_id: 1 }]) assert.throws(() => validateSendInput(value));
});
test('local bridge rejects cross-site, forwarded, non-loopback and non-JSON writes', () => {
  const request = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } });
  assert.equal(verifyLocalRequest(request(), 5173, true), 'http://localhost:5173');
  for (const headers of [{ origin: 'https://evil.test' }, { origin: undefined }, { host: 'evil.test:5173' }, { 'x-forwarded-host': 'localhost:5173' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) { const value = request(); Object.assign(value.headers, headers); assert.throws(() => verifyLocalRequest(value, 5173, true)); }
  const remote = request(); remote.socket.remoteAddress = '192.168.1.2'; assert.throws(() => verifyLocalRequest(remote, 5173, true));
});
test('bundle allowlist rejects other projects and sanitizes secrets without dropping events', () => {
  const value = bundle(); value.events[0].details = 'Authorization=Bearer abc123 api_key=secret sk-testtoken123456 https://user:pass@example.com/path?key=secret';
  const sanitized = validateTechnicalBundle(value, 'r1');
  assert.equal(sanitized.events.length, 1);
  for (const secret of ['abc123', 'api_key=secret', 'sk-testtoken123456', 'user:pass', '?key=secret']) assert.ok(!JSON.stringify(sanitized).includes(secret));
  for (const value of [{ ...bundle(), project: 'another' }, { ...bundle(), thread_id: 'another' }, { ...bundle(), title: 'Other' }]) assert.throws(() => validateTechnicalBundle(value));
  assert.throws(() => validateTechnicalBundle(bundle(), 'wrong-report'));
  const fiveHundred = bundle(); fiveHundred.events = Array.from({ length: 500 }, (_, index) => ({ ...event, id: `e${index}` })); assert.equal(validateTechnicalBundle(fiveHundred).events.length, 500);
  const longAnswer = bundle(); longAnswer.reports[0].text = 'a'.repeat(18000); assert.equal(validateTechnicalBundle(longAnswer).reports[0].text.length, 18000);
  assert.throws(() => validateTechnicalBundle({ ...bundle(), reports: Array.from({ length: 51 }, () => report) }));
});
test('timestamp-only refresh has stable archive hash', () => {
  const a = validateTechnicalBundle(bundle()), b = { ...a, export_id: 'new-id', generated_at: '2026-11-15T09:00:00Z' };
  assert.equal(bundleHash(a), bundleHash(b));
  assert.notEqual(bundleHash(a), bundleHash({ ...b, events: [{ ...event, count: 2 }] }));
});
test('status reads configuration only and never starts Codex or fetches an export', async t => {
  const { bridge, protocol, requests } = await localFixture(t);
  const status = await bridge.status(); assert.equal(status.available, true); assert.equal(status.readiness, 'checked_on_button');
  assert.equal(protocol.calls.length, 0); assert.equal(requests.length, 0);
});
test('protocol preflight disables every named MCP and rejects unsafe capabilities or wrong chat', async () => {
  const target = TECHNICAL_CHAT;
  for (const options of [{ unsafe: true }, { rogueMcp: true }, { wrongThread: true }, { busy: true }]) { const mock = mockProtocol(target, options); await assert.rejects(() => prepareTechnicalTransport(target, { clientFactory: mock.factory })); assert.equal(mock.calls.filter(call => call.method === 'turn/start').length, 0); }
  const mock = mockProtocol(target), prepared = await prepareTechnicalTransport(target, { clientFactory: mock.factory }); prepared.client.close();
  assert.deepEqual(mock.calls.find(call => call.current === 1).disabledNames, ['local_test']);
  assert.ok(bridgeCodexArguments(['local_test']).includes('mcp_servers.local_test.enabled=false'));
  assert.throws(() => bridgeCodexArguments(['a.b']));
  assert.ok(!JSON.stringify(mock.calls).includes('must-never-be-exported'));
});
test('manual send stores full archive and only acknowledges in fixed restricted chat', async t => {
  const { bridge, requests, protocol, workspace, target } = await localFixture(t);
  const result = await bridge.send('http://localhost:5173', { report_id: 'r1' });
  assert.equal(result.status, 'saved_to_thread'); assert.equal(result.delivered, true); assert.equal(result.turn_id, 'new-turn');
  assert.equal(requests[0].url, 'http://localhost:5173/api/technical/export?format=json&report_id=r1'); assert.equal(requests[0].init.redirect, 'error');
  assert.ok(result.archive.path.startsWith(workspace + '/outputs/'));
  const archive = JSON.parse(await readFile(result.archive.path, 'utf8')); assert.deepEqual(archive.events, [event]); assert.deepEqual(archive.reports, [report]);
  const resume = protocol.calls.find(call => call.method === 'thread/resume'); assert.equal(resume.params.model, 'preserve-this-model'); assert.equal(resume.params.threadId, target.thread_id);
  const turn = protocol.calls.find(call => call.method === 'turn/start'); assert.equal(turn.params.threadId, target.thread_id); assert.deepEqual(turn.params.environments, []); assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false }); assert.equal(turn.params.approvalPolicy, 'never'); assert.equal(turn.params.model, undefined); assert.ok(turn.params.input[0].text.includes('untrusted_dota_lab_technical_report'));
  const duplicate = await bridge.send('http://localhost:5173', {}); assert.equal(duplicate.delivered, true); assert.equal(duplicate.duplicate, true); assert.equal(protocol.calls.filter(call => call.method === 'turn/start').length, 1);
});
test('uncertain or failed acknowledgement never reports delivered and never silently retries', async t => {
  for (const options of [{ timeout: true }, { failed: true }, { toolAttempt: true }, { startError: true }, { modelChange: true }]) {
    const { bridge, protocol } = await localFixture(t, options);
    const first = await bridge.send('http://localhost:5173', {}); assert.equal(first.status, 'saved_locally'); assert.equal(first.delivered, false); assert.ok(!JSON.stringify(first).includes('provider-secret'));
    const count = protocol.calls.length;
    const second = await bridge.send('http://localhost:5173', {}); assert.equal(second.delivered, false); assert.equal(protocol.calls.length, count);
  }
});
test('unsupported guards still save archive, without sending any model request', async t => {
  const { bridge, protocol } = await localFixture(t, { unsafe: true });
  const value = await bridge.send('http://localhost:5173', {}); assert.equal(value.status, 'saved_locally'); assert.equal(value.delivered, false); assert.ok(await readFile(value.archive.path, 'utf8'));
  assert.equal(protocol.calls.filter(call => call.method === 'turn/start').length, 0);
});
test('empty journal is rejected server-side before archiving or starting Codex', async t => {
  const { bridge, protocol, workspace } = await localFixture(t, { bundle: { ...bundle(), events: [], reports: [] } });
  await assert.rejects(() => bridge.send('http://localhost:5173', {}), error => error.code === 'empty_journal');
  assert.equal(protocol.calls.length, 0);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(path.join(workspace, 'outputs')), []);
});
test('large full archive stays local with explicit size warning, never partial chat data', async t => {
  const large = bundle(); large.events = Array.from({ length: 100 }, (_, index) => ({ ...event, id: `large${index}`, details: 'a'.repeat(6000) }));
  const { bridge, protocol } = await localFixture(t, { bundle: large });
  const result = await bridge.send('http://localhost:5173', {}); assert.equal(result.delivered, false); assert.match(result.reason, /192 КБ/); assert.equal(protocol.calls.length, 0);
  const saved = JSON.parse(await readFile(result.archive.path, 'utf8')); assert.equal(saved.events.length, 100); assert.equal(saved.events[0].details.length, 6000);
});
test('configuration substitution and symlinked outputs cannot redirect the archive', async t => {
  const value = await localFixture(t);
  await writeFile(path.join(value.root, '.sites-runtime', 'technical-chat.json'), JSON.stringify({ ...value.target, thread_id: 'another' }));
  assert.equal((await value.bridge.status()).configured, false); await assert.rejects(() => value.bridge.send('http://localhost:5173', {}));
  await writeFile(path.join(value.root, '.sites-runtime', 'technical-chat.json'), JSON.stringify(value.target));
  await symlink(value.root, path.join(value.workspace, 'outputs'));
  await assert.rejects(() => value.bridge.send('http://localhost:5173', {}));
  assert.equal(value.requests.length, 0);
});
test('Vite development adapter preserves secret deny rules and only registers two endpoints', () => {
  const plugin = dotaTechnicalBridge(); assert.equal(plugin.apply, 'serve');
  const denied = plugin.config().server.fs.deny;
  for (const value of ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.sites-runtime/**']) assert.ok(denied.includes(value));
});

function fakeSubprocess() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  const messages = []; let buffered = '';
  child.stdin.on('data', data => { buffered += data.toString(); let end; while ((end = buffered.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffered.slice(0, end))); buffered = buffered.slice(end + 1); } });
  return { child, messages, emit: value => child.stdout.write(JSON.stringify(value) + '\n') };
}
test('raw protocol rejects dynamic tools and approvals without invoking handlers', async () => {
  const fake = fakeSubprocess();
  const client = codexClient(TECHNICAL_CHAT, [], { spawnImpl: (_binary, _args, options) => { assert.equal(options.stdio[2], 'ignore'); return fake.child; } });
  for (const method of ['item/tool/call', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
    fake.emit({ id: method, method, params: { threadId: TECHNICAL_CHAT.thread_id, command: 'do-not-execute' } });
    const answer = fake.messages.at(-1); assert.equal(answer.id, method); assert.equal(answer.error.code, -32601); assert.equal(answer.result, undefined);
  }
  fake.emit({ method: 'turn/completed', params: { threadId: TECHNICAL_CHAT.thread_id, turn: { id: 'turn', status: 'completed' } } });
  assert.equal((await client.waitTurn('turn')).unsafeTool, true);
  client.close(); assert.equal(fake.child.killed, true);
});
test('raw protocol stops if a tool execution appears despite capability guards', async () => {
  const fake = fakeSubprocess(), client = codexClient(TECHNICAL_CHAT, [], { spawnImpl: () => fake.child });
  fake.emit({ method: 'item/started', params: { threadId: TECHNICAL_CHAT.thread_id, item: { type: 'commandExecution' } } });
  assert.equal(fake.child.killed, true); await assert.rejects(() => client.waitTurn('unknown'));
});
test('raw protocol decodes split UTF-8 without corrupting Russian identity', async () => {
  const fake = fakeSubprocess(), client = codexClient(TECHNICAL_CHAT, [], { spawnImpl: () => fake.child });
  const waiting = client.request('thread/read', { threadId: TECHNICAL_CHAT.thread_id });
  const bytes = Buffer.from(JSON.stringify({ id: fake.messages[0].id, result: { name: TECHNICAL_CHAT.thread_title } }) + '\n');
  for (const byte of bytes) fake.child.stdout.write(Buffer.from([byte]));
  assert.equal((await waiting).name, TECHNICAL_CHAT.thread_title); client.close();
});
