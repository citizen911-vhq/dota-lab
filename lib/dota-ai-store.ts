import { env } from 'cloudflare:workers';
import { loadJournal } from './dota-store';
import { readPaperDashboard } from './dota-paper-store';
import { inCurrentExperiment } from './dota-experiment';
import { canonical, DataError } from './dota-core';
import { valuePolicy } from './dota-value';
import { aiContext, aiRequest, buildAiSnapshot, moscowDayStart } from './dota-ai-context';
import { blockedAi, generateAiContent } from './dota-ai';
import { SEARCH_MODEL } from './dota-openai';
import type { AiDashboard, AiReport } from './dota-ai-types';

type Row = { key: string; payload: string };
const PREFIX = 'ai:v1:report:';
const COOLDOWN = 'ai:provider:cooldown';
const db = () => { if (!env.DB) throw new DataError('Хранилище ИИ недоступно.', 503); return env.DB; };
async function read(key: string) { const r = await db().prepare('SELECT payload FROM dota_analysis_records WHERE key=?').bind(key).first<{ payload: string }>(); return r ? JSON.parse(r.payload) : null; }
const reportKey = (args: ReturnType<typeof aiRequest>, day: string) => PREFIX + args.mode + ':' + (args.mode === 'daily' ? day : args.fixture_id ?? 'all');
async function fingerprint(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function contextFor(input: unknown) {
  const args = aiRequest(input), now = Date.now();
  const [loaded, paper, rows, latest, dayRows] = await Promise.all([
    loadJournal(), readPaperDashboard(),
    db().prepare("SELECT key,payload FROM dota_analysis_records WHERE key IN ('paper:auto:last','state:betting_health')").all<Row>(),
    db().prepare('SELECT payload FROM dota_analysis_runs ORDER BY started_utc DESC LIMIT 1').first<{ payload: string }>(),
    db().prepare('SELECT payload FROM dota_analysis_runs WHERE started_utc>=? AND started_utc<=?').bind(new Date(moscowDayStart(now)).toISOString(), new Date(now).toISOString()).all<{ payload: string }>(),
  ]);
  const snapshot = buildAiSnapshot(loaded.journal.forecasts.filter(inCurrentExperiment), paper, Object.fromEntries(rows.results.map(r => [r.key, JSON.parse(r.payload)])), latest ? JSON.parse(latest.payload) : null, dayRows.results.map(r => JSON.parse(r.payload)), valuePolicy(env), loaded.storage, now);
  const context = aiContext(snapshot, args.mode, args.fixture_id);
  const { generated_at, ...stable } = context;
  const hash = await fingerprint({ version: 1, mode: args.mode, fixture_id: args.fixture_id, model: SEARCH_MODEL, context: stable });
  return { args, snapshot, context, hash, key: reportKey(args, snapshot.day) };
}
export async function readAiDashboard(input: unknown): Promise<AiDashboard> {
  const c = await contextFor(input), report = await read(c.key) as AiReport | null;
  return { key_configured: !!env.OPENAI_API_KEY?.trim(), model: SEARCH_MODEL, snapshot: c.snapshot, mode: c.args.mode, fixture_id: c.args.fixture_id, report,
    report_stale: !!report && (report.fingerprint !== c.hash || c.args.mode === 'news' && Date.now() - Date.parse(report.at) > 3600000) };
}
export async function runAiReport(input: unknown) {
  const args = aiRequest(input), now = Date.now(), owner = crypto.randomUUID();
  // Shared with legacy research: one OpenAI request at a time, independent of analysis/bets.
  const lease = await db().prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('openai-search',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(owner, now + 180000, now).first<{ owner: string }>();
  if (lease?.owner !== owner) throw new DataError('Запрос ИИ уже выполняется. Основное меню остаётся доступным.', 409);
  try {
    const c = await contextFor(args), previous = await read(c.key) as AiReport | null;
    if (!args.force_refresh && previous?.status === 'completed' && previous.fingerprint === c.hash && (args.mode !== 'news' || now - Date.parse(previous.at) <= 3600000)) return { report: previous, cached: true, reason: 'Показан сохранённый отчёт по тому же срезу данных. API не расходовался.' };
    const legacy = await read('openai:search:v2:last'), cooldown = await read(COOLDOWN);
    if ([legacy?.retry_after, cooldown?.retry_after].some(v => Date.parse(v ?? '') > now)) throw new DataError('OpenAI запросил паузу. Дождитесь окончания ограничения провайдера.', 429);
    const content = !env.OPENAI_API_KEY?.trim() ? blockedAi('Серверный ключ OpenAI не настроен. Факты и дневные счётчики доступны без ИИ.')
      : args.mode === 'news' && !c.snapshot.fixtures.length ? blockedAi('В журнале пока нет серий для поиска новостей. Запрос OpenAI не отправлен.')
      : await generateAiContent(env.OPENAI_API_KEY, args.mode, c.context);
    const report: AiReport = { ...content, mode: args.mode, fixture_id: args.fixture_id, at: new Date(now).toISOString(), context_at: c.snapshot.generated_at, fingerprint: c.hash };
    // Fenced report-only writes. No forecast, observation, quote or bet writers are called.
    const save = async (key: string, value: unknown) => {
      const result = await db().prepare("INSERT INTO dota_analysis_records(key,payload,updated_utc) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM dota_analysis_lease WHERE id='openai-search' AND owner=?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc").bind(key, canonical(value), new Date().toISOString(), owner).run();
      if (result.meta.changes !== 1) throw new DataError('Запрос ИИ устарел. Обновите сохранённый отчёт.', 409);
    };
    if (report.retry_after) await save(COOLDOWN, { retry_after: report.retry_after });
    await save(c.key, report);
    return { report, cached: false, reason: report.reason };
  } finally { await db().prepare("DELETE FROM dota_analysis_lease WHERE id='openai-search' AND owner=?").bind(owner).run(); }
}
