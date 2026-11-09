import { env } from 'cloudflare:workers';
import seedData from '../data/seed.json';
import type { Journal, Forecast, Observation } from './dota-types';
import { canonical, dashboard, DataError, invariant, latestObservations, validateObservation, mergeJournal } from './dota-core';

const seed = seedData as unknown as Journal;
type Stored = {id: string; payload: string; content_hash: string};
type Meta = {key: string; payload: string; updated_utc: string};
function database(): D1Database {
  if (!env.DB) throw new DataError('Хранилище данных ещё не подключено.', 503);
  return env.DB;
}
async function sha(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function loadJournal(): Promise<{journal: Journal; storage: 'database'|'seed'; updated: string|null}> {
  const db = database();
  const [forecasts, observations, metadata] = await Promise.all([
    db.prepare('SELECT id,payload,content_hash FROM dota_forecasts ORDER BY registered_utc,id').all<Stored>(),
    db.prepare('SELECT id,payload,content_hash FROM dota_observations ORDER BY recorded_utc,id').all<Stored>(),
    db.prepare('SELECT key,payload,updated_utc FROM dota_metadata').all<Meta>(),
  ]);
  if (!forecasts.results.length) return {journal: seed, storage: 'seed', updated: String(seed.metadata.journal_updated_utc ?? seed.metadata.generated_at ?? '') || null};
  const meta = Object.fromEntries(metadata.results.map(r => [r.key, JSON.parse(r.payload)]));
  return {journal: {
    forecasts: forecasts.results.map(r => JSON.parse(r.payload)),
    observations: observations.results.map(r => JSON.parse(r.payload)),
    teams: meta.teams ?? seed.teams, protocol: meta.protocol ?? seed.protocol,
    durationSupplement: meta.durationSupplement ?? seed.durationSupplement,
    metadata: meta.metadata ?? seed.metadata,
  }, storage: 'database', updated: metadata.results.map(r => r.updated_utc).sort().at(-1) ?? null};
}
export async function readDashboard() {
  const {journal,storage,updated} = await loadJournal();
  return dashboard(journal,storage,updated);
}
export async function syncJournal(value: unknown) {
  const db = database();
  const existing = await loadJournal();
  // Seed is a read fallback until it is deliberately imported. It is not yet
  // stored, so the first write inserts the entire validated snapshot.
  const current: Journal = existing.storage === 'seed' ? {...existing.journal,forecasts:[],observations:[],durationSupplement:null} : existing.journal;
  const merged = mergeJournal(current,value,Date.now(),seed);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const f of merged.newForecasts) {
    statements.push(db.prepare(`INSERT INTO dota_forecasts(id,fixture_id,payload,content_hash,registered_utc) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET content_hash=CASE WHEN content_hash=excluded.content_hash THEN content_hash ELSE NULL END`)
      .bind(f.forecast_id,f.fixture_id,canonical(f),await sha(f),now));
  }
  for (const o of merged.newObservations) {
    statements.push(db.prepare(`INSERT INTO dota_observations(id,fixture_id,previous_id,payload,content_hash,recorded_utc) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET content_hash=CASE WHEN content_hash=excluded.content_hash THEN content_hash ELSE NULL END`)
      .bind(o.observation_id,o.fixture_id,o.supersedes ?? '',canonical(o),await sha(o),o.recorded_utc));
  }
  for (const key of ['teams','protocol','durationSupplement','metadata'] as const) {
    const conflict = key === 'durationSupplement'
      ? "payload=CASE WHEN payload=excluded.payload OR payload='null' THEN excluded.payload ELSE NULL END,updated_utc=excluded.updated_utc"
      : 'payload=excluded.payload,updated_utc=excluded.updated_utc';
    statements.push(db.prepare('INSERT INTO dota_metadata(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET ' + conflict)
      .bind(key,canonical(merged.journal[key] ?? null),now));
  }
  try { if (statements.length) await db.batch(statements); }
  catch (e) {
    if (/constraint|unique|not null/i.test(String(e))) throw new DataError('Конфликт одновременного обновления. Обновите журнал и повторите импорт.',409);
    throw e;
  }
  const persisted = await loadJournal();
  return {ok:true,inserted_forecasts:merged.newForecasts.length,inserted_observations:merged.newObservations.length,
    forecasts_count:persisted.journal.forecasts.length,observations_count:persisted.journal.observations.length,updated_at:now};
}

export async function recordResult(value: unknown, recordedVia='app') {
  invariant(!!value && typeof value === 'object' && !Array.isArray(value),'Некорректный результат.');
  const input = value as Record<string,unknown>;
  const loaded = await loadJournal();
  const latest = latestObservations(loaded.journal.observations);
  const previous = latest.get(String(input.fixture_id));
  if (previous && input.supersedes !== previous.observation_id) throw new DataError('Для исправления укажите актуальный supersedes: ' + previous.observation_id,409);
  const fixtures = new Map(loaded.journal.forecasts.map(f => [f.fixture_id,f]));
  const next = validateObservation({...input,observation_id:crypto.randomUUID(),recorded_utc:new Date().toISOString(),recorded_via:recordedVia},fixtures);
  const response = await syncJournal({...loaded.journal,observations:[...loaded.journal.observations,next]});
  return {...response,observation:next};
}
