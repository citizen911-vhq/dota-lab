import { env } from 'cloudflare:workers';
import { DataError, canonical } from './dota-core';
import { browserTechnicalInputs, normalizeTechnicalInput, redactTechnicalText, TECHNICAL_MAX_EVENTS, TECHNICAL_PROJECT } from './dota-technical-core';
import type { TechnicalEvent, TechnicalInput } from './dota-technical-types';

const PREFIX = 'tech:v1:event:';
const secrets = () => [env.OPENAI_API_KEY, env.OPENDOTA_API_KEY, env.ODDSLINK_API_KEY, env.ODDS_API_IO_KEY].filter((value): value is string => typeof value === 'string');
export const redactServerTechnicalText = (value: unknown, max = 6000) => redactTechnicalText(value, max, secrets());

export async function recordTechnicalError(input: TechnicalInput): Promise<void> {
  try {
    const db = env.DB;
    if (!db) return;
    const clean = normalizeTechnicalInput(input, secrets());
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(clean)));
    const id = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    const now = new Date().toISOString();
    const event: TechnicalEvent = { id, project: TECHNICAL_PROJECT, ...clean, first_seen: now, last_seen: now, count: 1 };
    // D1 transaction: atomic dedup/count and retention; no read-modify-write race.
    await db.batch([
      db.prepare(`INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET payload=json_set(excluded.payload,
          '$.first_seen',min(json_extract(dota_analysis_records.payload,'$.first_seen'),json_extract(excluded.payload,'$.first_seen')),
          '$.last_seen',max(json_extract(dota_analysis_records.payload,'$.last_seen'),json_extract(excluded.payload,'$.last_seen')),
          '$.count',min(coalesce(json_extract(dota_analysis_records.payload,'$.count'),0)+1,2147483647)),
          updated_utc=max(dota_analysis_records.updated_utc,excluded.updated_utc)`)
        .bind(PREFIX + id, canonical(event), now),
      db.prepare('DELETE FROM dota_analysis_records WHERE key IN (SELECT key FROM dota_analysis_records WHERE key LIKE ? ORDER BY updated_utc DESC,key DESC LIMIT -1 OFFSET ?)')
        .bind(PREFIX + '%', TECHNICAL_MAX_EVENTS),
    ]);
  } catch {
    // Logging must never break an analysis, mask the original exception or recurse.
  }
}

export async function readTechnicalEvents(): Promise<TechnicalEvent[]> {
  if (!env.DB) throw new DataError('Хранилище технического журнала недоступно.', 503);
  const rows = await env.DB.prepare('SELECT payload FROM dota_analysis_records WHERE key LIKE ? ORDER BY updated_utc DESC,key DESC LIMIT ?')
    .bind(PREFIX + '%', TECHNICAL_MAX_EVENTS).all<{ payload: string }>();
  return rows.results.flatMap(row => {
    try {
      const event = JSON.parse(row.payload) as TechnicalEvent;
      if (event.project !== TECHNICAL_PROJECT || typeof event.id !== 'string' || !Number.isInteger(event.count) || event.count < 1) return [];
      // Redact once more on export if a known key was added/rotated after capture.
      return [{ ...event, ...normalizeTechnicalInput(event, secrets()) }];
    } catch { return []; }
  });
}

export async function captureBrowserErrors(input: unknown): Promise<{ accepted: number }> {
  const events = browserTechnicalInputs(input);
  for (const event of events) await recordTechnicalError(event);
  return { accepted: events.length };
}
