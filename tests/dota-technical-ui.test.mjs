import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const capturedModule = (await build({ entryPoints: ['components/dota/technical-error-capture.tsx'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] })).outputFiles[0].text;
const panelModule = (await build({ entryPoints: ['components/dota/ai-panel.tsx'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react/jsx-runtime', 'react-dom/server'] })).outputFiles[0].text;
const technicalPanelModule = (await build({ entryPoints: ['components/dota/technical-panel.tsx'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react/jsx-runtime'] })).outputFiles[0].text;

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function textOf(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  return tree?.props ? textOf(tree.props.children) : '';
}
function panelHarness({ ready = true, delivered = true } = {}) {
  const states = [], effects = [], requests = []; let cursor = 0;
  const hooks = {
    ...React,
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect(callback, dependencies) { const i = cursor++; if (!(i in states) || dependencies.some((value, n) => value !== states[i][n])) { states[i] = dependencies; effects.push(callback); } },
  };
  const event = { id: 'event-a', project: 'dota-lab', source: 'server', severity: 'error', code: 'TEST_ERROR', message: 'Сбой тестового API', details: '', route: '/api/test', first_seen: '2026-11-14T00:00:00Z', last_seen: '2026-11-14T00:00:00Z', count: 1 };
  const dashboard = { project: 'dota-lab', title: 'DOTA 2 LAB ТЕХНИЧЕСКИЙ АНАЛИЗ', generated_at: event.last_seen, key_configured: true, events: [event], reports: [], retention: { max_events: 500, max_reports: 50 }, delivery: { thread_title: 'DOTA 2 LAB ТЕХНИЧЕСКИЙ АНАЛИЗ', reason: 'Ручной экспорт' } };
  const module = { exports: {} };
  vm.runInNewContext(technicalPanelModule, {
    module, exports: module.exports, require: name => name === 'react' ? hooks : require(name), URL, Error, Date, Intl, Map, Set, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      const body = url === '/__dota_technical/status' ? { available: ready, configured: ready, local_archive_available: true, thread_title: dashboard.title, reason: 'Статус локальной связи' }
        : url === '/__dota_technical/send' ? { delivered, reason: delivered ? 'Доставка подтверждена.' : 'Сохранён только локальный архив.', archive: { name: 'journal.json' } }
          : options.method === 'POST' ? { reason: 'Объяснение сохранено.' } : dashboard;
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => body };
    },
  });
  return {
    requests,
    render() { cursor = 0; return module.exports.default({ refreshKey: 0 }); },
    async effects() { while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

function collector({ reject = false } = {}) {
  const listeners = new Map(), timers = [], requests = [], cleanups = [];
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, URL, Date, Map, Error, AbortSignal,
    require: name => name === 'react' ? { useEffect: fn => cleanups.push(fn()) } : require(name),
    setTimeout: fn => { timers.push(fn); return timers.length; },
    fetch: async (url, init) => { requests.push({ url, ...init, body: JSON.parse(init.body) }); if (reject) throw Error('collector offline'); return { ok: true }; },
    window: { location: { origin: 'http://localhost:5173', pathname: '/' }, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) },
  });
  vm.runInContext(capturedModule, context);
  module.exports.default();
  return {
    listeners, requests, cleanups, captureRender: module.exports.captureRenderError,
    async flush() { for (let i = 0; timers.length && i < 20; i++) { timers.shift()(); await new Promise(resolve => setImmediate(resolve)); } },
  };
}

function runtime(message = 'render failed', filename = 'http://localhost:5173/app.js') {
  const error = new Error(message); error.stack = `Error: ${message}\n at render (${filename}:1:2)`;
  return { message, filename, error, lineno: 1, colno: 2 };
}

test('technical tab is fourth and does not replace the three analysis tabs', () => {
  const module = { exports: {} };
  vm.runInNewContext(panelModule, { module, exports: module.exports, require, URL, Error, Date, Intl, Map, Set });
  const html = renderToStaticMarkup(React.createElement(module.exports.default, { refreshKey: 0 }));
  const tabIds = [...html.matchAll(/id="ai-tab-(explain|news|daily|technical)"/g)].map(match => match[1]);
  assert.deepEqual(tabIds, ['explain', 'news', 'daily', 'technical']);
  assert.match(html, /Технические ошибки/);
});

test('passive browser capture only queues application-origin errors and redacts before transmission', async () => {
  const c = collector();
  assert.equal(c.requests.length, 0);
  c.listeners.get('error')(runtime('remote', 'https://unrelated.example/app.js'));
  c.listeners.get('error')(runtime('extension', 'chrome-extension://unrelated/app.js'));
  c.listeners.get('unhandledrejection')({ reason: 'unattributed failure' });
  c.listeners.get('error')(runtime('failed token=super-secret', 'http://localhost:5173/app.js?api_key=super-secret'));
  assert.equal(c.requests.length, 0, 'capture is batched and never starts AI');
  await c.flush();
  assert.equal(c.requests.length, 1);
  const request = c.requests[0];
  assert.equal(request.url, '/api/technical');
  assert.equal(request.body.action, 'capture');
  assert.equal(request.body.events.length, 1);
  assert.equal(request.body.events[0].route, '/');
  assert.doesNotMatch(JSON.stringify(request.body), /super-secret/);
  assert.equal(request.body.events[0].code, 'browser.runtime');
});

test('browser errors are deduplicated, bounded to ten per batch and sixty per page session', async () => {
  const c = collector();
  for (let batch = 0; batch < 8; batch++) {
    for (let i = 0; i < 20; i++) {
      const event = runtime(`failure ${batch}-${i}`);
      c.listeners.get('error')(event); c.listeners.get('error')(event);
    }
    await c.flush();
  }
  assert.equal(c.requests.length, 6);
  assert.equal(c.requests.reduce((sum, request) => sum + request.body.events.length, 0), 60);
  assert.ok(c.requests.every(request => request.body.events.length <= 10));
});

test('collector failure is swallowed without retries or recursive logging; render boundary can log known application error', async () => {
  const c = collector({ reject: true });
  c.captureRender(new Error('own render failure'));
  await c.flush(); await c.flush();
  assert.equal(c.requests.length, 1);
  assert.equal(c.requests[0].body.events[0].code, 'browser.render');
  c.cleanups.forEach(cleanup => cleanup());
  assert.equal(c.listeners.size, 0);
});

test('only attributed Error promise rejections are captured', async () => {
  const c = collector();
  const external = runtime('external promise', 'https://other.example/app.js').error;
  const own = runtime('own promise').error;
  c.listeners.get('unhandledrejection')({ reason: external });
  c.listeners.get('unhandledrejection')({ reason: own });
  await c.flush();
  assert.equal(c.requests.length, 1);
  assert.equal(c.requests[0].body.events.length, 1);
  assert.equal(c.requests[0].body.events[0].code, 'browser.unhandled_rejection');
});

test('technical section load reads facts and readiness but never explains or sends automatically', async () => {
  const h = panelHarness(); h.render(); await h.effects();
  const tree = h.render();
  assert.deepEqual(h.requests.map(request => [request.url, request.method]), [['/__dota_technical/status', 'GET'], ['/api/technical', 'GET']]);
  const checkbox = nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkbox.props.checked, true);
  assert.ok(nodes(tree).some(node => node.type === 'button' && textOf(node).includes('Объяснить и отправить в чат')));
  assert.match(textOf(tree), /до 20 последних групп/);
});

test('explicit explain-and-send button sends only after explanation, and delivery needs positive confirmation', async () => {
  const h = panelHarness({ delivered: false }); h.render(); await h.effects();
  const tree = h.render();
  const explain = nodes(tree).find(node => node.type === 'button' && textOf(node).includes('Объяснить и отправить в чат'));
  await explain.props.onClick();
  assert.deepEqual(h.requests.filter(request => request.method === 'POST').map(request => [request.url, request.body]), [['/api/technical', { action: 'explain' }], ['/__dota_technical/send', {}]]);
  const finalText = textOf(h.render());
  assert.match(finalText, /Объяснение сохранено/);
  assert.match(finalText, /В чат не отправлено/);
  assert.doesNotMatch(finalText, /Доставлено в отдельный технический чат/);
});

test('archive-only mode never adds automatic-send choice or labels archival as chat delivery', async () => {
  const h = panelHarness({ ready: false }); h.render(); await h.effects();
  const tree = h.render();
  assert.equal(nodes(tree).some(node => node.type === 'input' && node.props.type === 'checkbox'), false);
  assert.ok(nodes(tree).some(node => node.type === 'button' && textOf(node).includes('Сохранить в техническом проекте')));
  const explain = nodes(tree).find(node => node.type === 'button' && textOf(node).includes('Объяснить ошибки с ИИ'));
  await explain.props.onClick();
  assert.equal(h.requests.filter(request => request.url === '/__dota_technical/send').length, 0);
});
