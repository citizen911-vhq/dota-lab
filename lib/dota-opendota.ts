/** Public, bounded, append-only discovery. Callers must merge returned maps into history. */
export interface NormalizedMatch {
  id: string;
  match_id: string;
  start_time: number;
  end_time: number;
  duration_seconds: number;
  radiant_team_id: string;
  dire_team_id: string;
  radiant_kills: number;
  dire_kills: number;
  radiant_win: boolean;
  series_id: number | null;
  series_type: number | null;
  league_id: string;
  players: { radiant: string[]; dire: string[] };
  sources: string[];
}

export interface OpenDotaCollection {
  matches: NormalizedMatch[];
  warnings: string[];
  healthy: boolean;
  successful_indexes: number;
  requested: number;
  /** Number of unseen, recent candidate IDs, including the unfinished queue. */
  discovered: number;
  unfetched_ids: string[];
  fetched_at: string;
}

export const TRACKED_TEAM_IDS = ['55', '10020555', '10242397', '10252232', '5014799', '10212329', '10331884', '10271553'] as const;
const TRACKED = new Set<string>(TRACKED_TEAM_IDS);
const EXCLUDED_REMAKES = new Set(['9074604699', '9044544461', '9074615771']);
const API = 'https://api.opendota.com/api';
const MAX_DETAILS = 12;
const DEFAULT_SINCE_SECONDS = Date.parse('2026-11-07T06:29:06Z') / 1000;
type Raw = Record<string, unknown>;
type Candidate = { id: string; start: number; rows: Raw[]; sources: Set<string> };

function object(value: unknown): value is Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function id(value: unknown): string | null {
  if (integer(value, 1)) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  return null;
}

function seriesId(value: unknown): number | null {
  return integer(value, 1) ? value : null;
}

function seriesType(value: unknown): number | null {
  return integer(value) && value <= 2 ? value : null;
}

function playerAccounts(raw: Raw, side: 'radiant' | 'dire'): string[] {
  if (!Array.isArray(raw.players)) return [];
  const first = side === 'radiant' ? 0 : 128;
  const players = raw.players.filter((p): p is Raw => object(p) && integer(p.player_slot) && p.player_slot >= first && p.player_slot <= first + 4);
  const slots = new Set(players.map(p => p.player_slot));
  if (slots.size !== players.length) return [];
  return [...new Set(players.map(p => id(p.account_id)).filter((account): account is string => account !== null && Number(account) < 4294967295))].sort((a, b) => Number(a) - Number(b));
}

function normalize(raw: Raw, candidate: Candidate, nowSeconds: number, warnings: string[]): NormalizedMatch | null {
  const matchId = id(raw.match_id);
  const radiant = id(raw.radiant_team_id);
  const dire = id(raw.dire_team_id);
  const league = id(raw.leagueid);
  if (matchId !== candidate.id || !radiant || !dire || radiant === dire || !league || (!TRACKED.has(radiant) && !TRACKED.has(dire)) ||
      !integer(raw.start_time, 1) || !integer(raw.duration, 1) || !integer(raw.radiant_score) || !integer(raw.dire_score) || typeof raw.radiant_win !== 'boolean') {
    warnings.push(`OpenDota ${candidate.id}: неполные или противоречивые поля карты; запись не принята.`);
    return null;
  }
  if (raw.start_time + raw.duration >= nowSeconds) {
    warnings.push(`OpenDota ${candidate.id}: время окончания ещё не наступило; карта остаётся в очереди.`);
    return null;
  }
  const matching = candidate.rows.filter(row => id(row.match_id) === matchId && id(row.radiant_team_id) === radiant && id(row.dire_team_id) === dire && id(row.leagueid) === league);
  let sid = seriesId(raw.series_id);
  let stype = seriesType(raw.series_type);
  const indexSeries = [...new Set(matching.map(row => seriesId(row.series_id)).filter((value): value is number => value !== null))];
  if (indexSeries.length > 1 || (sid !== null && indexSeries.some(value => value !== sid))) {
    warnings.push(`OpenDota ${matchId}: источники расходятся по series_id; метаданные индекса не добавлены.`);
  } else {
    if (sid === null && indexSeries.length === 1) sid = indexSeries[0];
    const types = [...new Set(matching.filter(row => sid !== null && seriesId(row.series_id) === sid).map(row => seriesType(row.series_type)).filter((value): value is number => value !== null))];
    if (types.length === 1 && stype === null) stype = types[0];
    else if (types.length > 1 || (stype !== null && types.some(value => value !== stype))) warnings.push(`OpenDota ${matchId}: источники расходятся по формату серии.`);
  }
  const players = { radiant: playerAccounts(raw, 'radiant'), dire: playerAccounts(raw, 'dire') };
  if (players.radiant.length !== 5 || players.dire.length !== 5) warnings.push(`OpenDota ${matchId}: полный состав из пяти публичных account_id не подтверждён.`);
  return {
    id: matchId, match_id: matchId,
    start_time: raw.start_time, end_time: raw.start_time + raw.duration, duration_seconds: raw.duration,
    radiant_team_id: radiant, dire_team_id: dire,
    radiant_kills: raw.radiant_score, dire_kills: raw.dire_score, radiant_win: raw.radiant_win,
    series_id: sid, series_type: stype, league_id: league, players,
    sources: [...new Set([...candidate.sources, `${API}/matches/${matchId}`, `https://www.opendota.com/matches/${matchId}`])],
  };
}

/** No retries or redirects. At most 11 indexes + 12 details per cycle. */
export async function collectOpenDota(knownIds: string[], now = Date.now(), fetchFn: typeof fetch = fetch, sinceSeconds = DEFAULT_SINCE_SECONDS, apiKey?: string): Promise<OpenDotaCollection> {
  if (!Number.isFinite(now) || !integer(sinceSeconds, 1)) throw new Error('Некорректное время сбора OpenDota.');
  // Official OpenAPI securitySchemes also permits Authorization: Bearer:
  // https://github.com/odota/core/blob/master/svc/api/spec.ts
  // Keep the optional server credential out of URLs, provenance and metadata.
  const authenticationKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const nowSeconds = Math.floor(now / 1000);
  const known = new Set(knownIds.map(value => String(value).replace(/^valve:/, '')));
  const warnings = ['Индексы OpenDota имеют подтверждённые пропуски: обновление дополняет сохранённую историю, но не доказывает полноту последних 30 карт.'];
  const candidates = new Map<string, Candidate>();
  let requested = 0;
  let stopped = false;
  let successfulIndexes = 0;
  let attemptedDetails = 0;

  async function request(url: string): Promise<unknown | null> {
    if (stopped) return null;
    requested++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      // Workers supports follow/manual, while redirect:'error' throws before
      // network I/O. Manual plus the explicit rejection below follows no URL.
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (authenticationKey) headers.Authorization = `Bearer ${authenticationKey}`;
      const response = await fetchFn(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        warnings.push(`OpenDota: перенаправление ${url} отклонено; другой адрес не запрашивался.`);
        await response.body?.cancel();
        return null;
      }
      if (response.status === 429) {
        stopped = true;
        const rawRetry = response.headers.get('Retry-After') ?? '';
        // Never echo arbitrary upstream header text, which could reflect a key.
        const retry = /^\d{1,10}$/.test(rawRetry) ? rawRetry
          : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(rawRetry) && Number.isFinite(Date.parse(rawRetry))
            ? new Date(rawRetry).toUTCString() : null;
        warnings.push(`OpenDota: лимит запросов (429); сбор остановлен${retry ? `, Retry-After: ${retry}` : ''}.`);
        await response.body?.cancel();
        return null;
      }
      if (response.status === 401 || response.status === 403) {
        stopped = true;
        warnings.push(`OpenDota: доступ отклонён (${response.status}); сбор остановлен.`);
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        warnings.push(`OpenDota: HTTP ${response.status} для ${url}; повтор перенесён на следующий цикл.`);
        await response.body?.cancel();
        return null;
      }
      if (response.headers.get('x-rate-limit-remaining-minute') === '0' || response.headers.get('x-rate-limit-remaining-day') === '0') {
        stopped = true;
        warnings.push('OpenDota: доступный лимит исчерпан; дальнейшие запросы остановлены.');
      }
      const result: unknown = await response.json();
      if (object(result) && 'error' in result) {
        warnings.push(`OpenDota: ответ с ошибкой для ${url}; данные не приняты.`);
        return null;
      }
      return result;
    } catch (error) {
      // Public fixed-origin URL and bounded exception text only: never log
      // request/response headers, bodies, credentials, or an entire error object.
      const safeText = (value: unknown) => typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').slice(0, 300) : undefined;
      const cause = error instanceof Error && object(error.cause) ? error.cause : undefined;
      if (authenticationKey) {
        // A transport can echo headers/URLs in any error property, including
        // name/cause/code. Only locally chosen class labels are safe here.
        console.error('OpenDota request failed', {
          url,
          error_name: error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error',
        });
      } else {
        console.error('OpenDota request failed', {
          url,
          error_name: error instanceof Error ? safeText(error.name) : 'UnknownError',
          error_message: error instanceof Error ? safeText(error.message) : 'Non-Error exception',
          cause_name: safeText(cause?.name),
          cause_code: safeText(cause?.code),
          cause_message: safeText(cause?.message),
        });
      }
      warnings.push(`OpenDota: запрос ${url} не выполнен за отведённое время или ответ не читается; повтор перенесён.`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const indexes: Array<{ path: string; team?: string }> = [
    ...TRACKED_TEAM_IDS.map(team => ({ path: `teams/${team}/matches`, team })),
    { path: 'leagues/20511/matches' }, { path: 'leagues/20486/matches' }, { path: 'proMatches' },
  ];
  for (const index of indexes) {
    if (stopped) break;
    const url = `${API}/${index.path}`;
    const result = await request(url);
    if (result === null) continue;
    if (!Array.isArray(result)) {
      warnings.push(`OpenDota: индекс ${url} не содержит список карт.`);
      continue;
    }
    successfulIndexes++;
    for (const value of result) {
      if (!object(value)) continue;
      const row: Raw = { ...value };
      if (index.team && typeof row.radiant === 'boolean') {
        row.radiant_team_id = row.radiant ? index.team : row.opposing_team_id;
        row.dire_team_id = row.radiant ? row.opposing_team_id : index.team;
      }
      const matchId = id(row.match_id);
      if (!matchId || known.has(matchId) || EXCLUDED_REMAKES.has(matchId) || !integer(row.start_time, 1) || row.start_time >= nowSeconds || row.start_time < sinceSeconds ||
          (!TRACKED.has(id(row.radiant_team_id) ?? '') && !TRACKED.has(id(row.dire_team_id) ?? ''))) continue;
      const candidate = candidates.get(matchId) ?? { id: matchId, start: row.start_time, rows: [], sources: new Set<string>() };
      candidate.rows.push(row);
      candidate.sources.add(url);
      candidates.set(matchId, candidate);
    }
  }
  const queue = [...candidates.values()].sort((a, b) => b.start - a.start || Number(b.id) - Number(a.id));
  const matches: NormalizedMatch[] = [];
  const accepted = new Set<string>();
  for (const candidate of queue.slice(0, MAX_DETAILS)) {
    if (stopped) break;
    attemptedDetails++;
    const raw = await request(`${API}/matches/${candidate.id}`);
    if (!object(raw)) continue;
    const match = normalize(raw, candidate, nowSeconds, warnings);
    if (match) { matches.push(match); accepted.add(match.id); }
  }
  if (queue.length > MAX_DETAILS) warnings.push(`OpenDota: ${queue.length - MAX_DETAILS} новых карт отложено из-за лимита 12 подробных запросов за цикл.`);
  return {
    matches, warnings,
    healthy: successfulIndexes === indexes.length && attemptedDetails === matches.length,
    successful_indexes: successfulIndexes,
    requested, discovered: queue.length,
    unfetched_ids: queue.filter(candidate => !accepted.has(candidate.id)).map(candidate => candidate.id),
    fetched_at: new Date(now).toISOString(),
  };
}
