/**
 * Limited discovery feed documented at https://github.com/beeequeue/dota-matches-api.
 * Audited 2026-11-08: upstream selects Liquipedia tiers 1/2, at most 50 matches,
 * and caches for three hours. It did not include DreamLeague Division 2.
 *
 * Cloud fallback: the daily task may read public CyberScore match pages, verify
 * missing fixtures and submit structured fixtures with the actual source URLs.
 * Keep that verification separate from deterministic probability calculations.
 * Do not scrape DotaScore.org RSC/HTML: no documented public API was confirmed.
 */

import { verifiedTeamIdByName, verifiedTeamIdByUrl } from './dota-team-identity';

export interface TrackedScheduleTeam {
  id: string;
  name: string;
  liquipedia_url: string | null;
  aliases: readonly string[];
}

// Valve IDs come from the existing verified map collection. Null means that a
// Liquipedia URL has not been verified, rather than an invented wiki path.
export const TRACKED_SCHEDULE_TEAMS: readonly TrackedScheduleTeam[] = [
  { id: '55', name: 'Power Rangers', liquipedia_url: 'https://liquipedia.net/dota2/Power_Rangers', aliases: ['Power Rangers'] },
  { id: '10020555', name: 'PlayTime', liquipedia_url: 'https://liquipedia.net/dota2/PlayTime', aliases: ['PlayTime'] },
  { id: '10242397', name: 'Xipto Esports', liquipedia_url: 'https://liquipedia.net/dota2/Xipto_Esports', aliases: ['Xipto Esports', 'Xipto Esports (page does not exist)'] },
  { id: '10252232', name: 'Zenith', liquipedia_url: null, aliases: ['Zenith', 'Team Zenith', 'ZENITH (stack)'] },
  { id: '5014799', name: 'Nemiga Gaming', liquipedia_url: 'https://liquipedia.net/dota2/Nemiga_Gaming', aliases: ['Nemiga Gaming'] },
  { id: '10212329', name: 'Team Synapse', liquipedia_url: null, aliases: ['Team Synapse', 'Synapse'] },
  { id: '10331884', name: 'Froglings', liquipedia_url: 'https://liquipedia.net/dota2/Froglings', aliases: ['Froglings', 'Froglings (page does not exist)'] },
  { id: '10271553', name: 'potn9ki', liquipedia_url: null, aliases: ['potn9ki'] },
];

export const HAGLUND_SCHEDULE_URL = 'https://dota.haglund.dev/v1/matches';
export const SCHEDULE_TIMEOUT_MS = 8_000;
export const SCHEDULE_COVERAGE_WARNING = 'Неполное расписание: Haglund/Liquipedia охватывает tier 1–2 и кэшируется до 3 часов; DreamLeague Division 2 может отсутствовать. verified_at — время получения ответа, а не независимого подтверждения актуального старта.';
const MAX_RESPONSE_BYTES = 1_000_000;
const HORIZON_MS = 192 * 60 * 60 * 1_000;

export interface DiscoveredScheduleFixture {
  provider_id: string;
  team_a_id: string;
  team_b_id: string;
  team_a_name: string;
  team_b_name: string;
  scheduled_start_utc: string;
  best_of: 2 | 3;
  status: 'scheduled';
  /** Receipt time of a potentially cached schedule, not upstream refresh time. */
  verified_at: string;
  sources: string[];
}

export interface ScheduleSourceResult {
  fixtures: DiscoveredScheduleFixture[];
  warnings: string[];
  fetched_at: string;
  source: string;
  recognized_team_ids?:string[];
  rejected?: {provider_id:string|null;reason:string;row:unknown;received_at:string}[];
}

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;
type JsonObject = Record<string, unknown>;
export interface ScheduleTeamIdentity { id: string; name: string; tag?:string|null; aliases?: readonly string[]; liquipedia_url?: string | null; eligible?: boolean }

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveTeam(value: unknown, catalog: readonly ScheduleTeamIdentity[]): ScheduleTeamIdentity | undefined {
  if (!object(value)) return;
  const reviewedNameId = verifiedTeamIdByName(value.name);
  const reviewedUrlId = verifiedTeamIdByUrl(value.url);
  const reviewedTagId = verifiedTeamIdByName(value.tag);
  // Reviewed aliases only resolve an identity present in the current directory.
  if ([reviewedNameId, reviewedUrlId, reviewedTagId].some(id => id != null && !catalog.some(t => t.id === id))) return;
  const urlMatches = catalog.filter(team => team.liquipedia_url != null && team.liquipedia_url === value.url || team.id === reviewedUrlId);
  if (urlMatches.length > 1) return;
  const byUrl = urlMatches[0];
  const observed = typeof value.name === 'string' ? value.name.trim() : '';
  const nameMatches = observed ? catalog.filter(team => team.id === reviewedNameId || (team.aliases ? [team.name,...team.aliases].includes(observed) : team.name.toLocaleLowerCase('en-US') === observed.toLocaleLowerCase('en-US'))) : [];
  const byName = nameMatches.length === 1 ? nameMatches[0] : undefined;
  const rawId=value.valve_team_id??value.team_id;
  const byId=rawId==null?undefined:catalog.find(t=>t.id===String(rawId));
  if(rawId!=null&&!byId)return;
  const tag=typeof value.tag==='string'?value.tag.trim():observed;
  const tagMatches=tag?catalog.filter(t=>t.tag===tag || t.id===reviewedTagId):[];
  const byTag=tagMatches.length===1?tagMatches[0]:undefined;
  if(nameMatches.length>1||tagMatches.length>1)return;
  const resolved=[byId,byUrl,byName,byTag].filter((t):t is ScheduleTeamIdentity=>!!t);
  if(new Set(resolved.map(t=>t.id)).size>1)return;
  return resolved[0];
}

function utcDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  // Date.parse normalizes e.g. February 30; that must not become a real fixture.
  const normalized = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, digits: string) => `.${digits.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  return new Date(time).toISOString() === normalized ? time : null;
}

function sourcePage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'liquipedia.net' && !url.port && !url.username && !url.password && url.pathname.startsWith('/dota2/') ? value : null;
  } catch { return null; }
}

function providerId(row: JsonObject): string | null {
  if (typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 256 && !/[\s\x00-\x1f]/.test(row.id)) return row.id;
  // The provider documents hash as fallback when Liquipedia does not expose id.
  return typeof row.hash === 'string' && /^[a-f0-9]{64}$/.test(row.hash) ? row.hash : null;
}

/** Pure parser, also useful for replaying an audited response in tests. */
export function parseHaglundSchedule(payload: unknown, now = Date.now(), catalog: readonly ScheduleTeamIdentity[] = TRACKED_SCHEDULE_TEAMS.map(team => ({...team,eligible:true}))): ScheduleSourceResult {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new RangeError('Invalid schedule collection time');
  const fetched_at = new Date(now).toISOString();
  const result: ScheduleSourceResult = { fixtures: [], warnings: [SCHEDULE_COVERAGE_WARNING], fetched_at, source: HAGLUND_SCHEDULE_URL,rejected:[],recognized_team_ids:[] };
  if (!Array.isArray(payload) || payload.length > 1_000) {
    result.warnings.push('Источник расписания вернул некорректный JSON-массив; прогнозы из него не создаются.');
    return result;
  }
  const selected = new Map<string, DiscoveredScheduleFixture>();
  const conflicts = new Set<string>();
  let malformed = 0;
  let unknownTeams = 0;
  let outsideWindow = 0;
  for (const row of payload) {
    if (!object(row) || !['Bo2','Bo3'].includes(String(row.matchType)) || !Array.isArray(row.teams) || row.teams.length !== 2) { malformed++; continue; }
    const start = utcDate(row.startsAt);
    const id = providerId(row);
    if (start === null || id === null) { malformed++; continue; }
    if (start <= now || start > now + HORIZON_MS) { outsideWindow++; continue; }
    const a = resolveTeam(row.teams[0],catalog);
    const b = resolveTeam(row.teams[1],catalog);
    for(const team of [a,b])if(team&&!result.recognized_team_ids!.includes(team.id))result.recognized_team_ids!.push(team.id);
    if (!a || !b || a.id === b.id || a.eligible === false && b.eligible === false) { unknownTeams++;result.rejected!.push({provider_id:id,reason:'Неоднозначный Valve ID либо нет команды из активного пула',row,received_at:fetched_at});continue; }
    const page = sourcePage(row.leagueUrl);
    const fixture: DiscoveredScheduleFixture = {
      provider_id: id, team_a_id: a.id, team_b_id: b.id, team_a_name:a.name, team_b_name:b.name,
      scheduled_start_utc: new Date(start).toISOString(), best_of: row.matchType === 'Bo2' ? 2 : 3, status: 'scheduled',
      verified_at: fetched_at, sources: page ? [HAGLUND_SCHEDULE_URL, page] : [HAGLUND_SCHEDULE_URL],
    };
    const previous = selected.get(id);
    if (previous && (previous.team_a_id !== a.id || previous.team_b_id !== b.id || previous.scheduled_start_utc !== fixture.scheduled_start_utc)) conflicts.add(id);
    else selected.set(id, fixture);
  }
  for (const id of conflicts) selected.delete(id);
  result.fixtures = [...selected.values()].sort((a, b) => a.scheduled_start_utc.localeCompare(b.scheduled_start_utc) || a.provider_id.localeCompare(b.provider_id));
  if (malformed) result.warnings.push(`Пропущено строк с неподтверждённым форматом BO2/BO3, датой или идентификатором: ${malformed}.`);
  if (unknownTeams) result.warnings.push(`Пропущено серий без двух однозначно сопоставленных Valve ID или без команды из динамического пула: ${unknownTeams}.`);
  if (outsideWindow) result.warnings.push(`Пропущено серий вне будущего окна 192 часов: ${outsideWindow}.`);
  if (conflicts.size) result.warnings.push(`Исключены противоречивые идентификаторы серий: ${conflicts.size}.`);
  return result;
}

/** One bounded public request; no redirects, credentials, retry or 429 bypass. */
export async function fetchHaglundSchedule(fetchFn: FetchFunction = fetch, now = Date.now(), catalog?: readonly ScheduleTeamIdentity[]): Promise<ScheduleSourceResult> {
  const empty = parseHaglundSchedule([], now, catalog);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Тайм-аут источника расписания (8 секунд).'));
    }, SCHEDULE_TIMEOUT_MS);
  });
  try {
    const request = (async () => {
      const response = await fetchFn(HAGLUND_SCHEDULE_URL, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw new Error('Перенаправление источника расписания отклонено.');
      if (!response.ok) throw new Error(`Источник расписания вернул HTTP ${response.status}; повторный запрос не выполнялся.`);
      if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Источник расписания вернул страницу вместо JSON.');
      const declaredSize = Number(response.headers.get('content-length'));
      if (declaredSize > MAX_RESPONSE_BYTES) throw new Error('Ответ расписания превышает допустимый размер.');
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new Error('Ответ расписания превышает допустимый размер.');
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new Error('Источник расписания вернул повреждённый JSON.'); }
      return parseHaglundSchedule(payload, now, catalog);
    })();
    return await Promise.race([request, deadline]);
  } catch (error) {
    controller.abort();
    const message = error instanceof Error ? error.message : 'Ошибка получения расписания.';
    empty.warnings.push(`Расписание не обновлено: ${message}`);
    return empty;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
