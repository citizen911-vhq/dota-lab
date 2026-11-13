export interface OpenDotaTeamDirectoryEntry {
  id: string;
  name: string;
  tag: string | null;
  rating: number;
  last_match_time: number;
}

export interface DynamicTeamPoolEntry extends OpenDotaTeamDirectoryEntry {
  qualification: 'tier1-rating' | 'frequent-tier1-opponent' | 'legacy-fallback' | 'primary-pool' | 'expanded-top';
  tier1_rank: number | null;
  tier1_opponent_maps: number;
  recent_maps: number;
}

type Raw = Record<string, unknown>;
// Owner-approved observation cohort, selected on 2026-11-13.
// Membership is fixed by Valve team ID; roster approval is a separate gate.
export const PRIMARY_TEAM_POOL = [
  ['9964962', 'GamerLegion'], ['7119388', 'Team Spirit'],
  ['8255888', 'BETBOOM TEAM'], ['9467224', 'Aurora Gaming'],
  ['2163', 'Team Liquid'], ['9823272', 'Team Yandex'],
  ['2576071', 'Yellow Submarine'], ['36', 'Natus Vincere'],
  ['2586976', 'OG'], ['10282069', 'CyberHero'],
  ['10182357', '1win'], ['9824702', 'PARIVISION'],
] as const;

export function primaryTeamPool(directory: OpenDotaTeamDirectoryEntry[] = [], previous: DynamicTeamPoolEntry[] = []): DynamicTeamPoolEntry[] {
  const current = new Map(directory.map(team => [team.id, team]));
  const saved = new Map(previous.map(team => [team.id, team]));
  return PRIMARY_TEAM_POOL.map(([id, name]) => {
    const metadata = current.get(id) ?? saved.get(id);
    return { id, name: metadata?.name ?? name, tag: metadata?.tag ?? null,
      rating: metadata?.rating ?? 0, last_match_time: metadata?.last_match_time ?? 0,
      qualification: 'primary-pool', tier1_rank: null, tier1_opponent_maps: 0, recent_maps: 0 };
  });
}

const ACTIVE_WINDOW_SECONDS = 30 * 24 * 60 * 60;
export const TIER1_TEAM_COUNT = 15;
export const RECENT_MAP_COUNT = 30;
export const TIER1_OPPONENT_MIN_MAPS = 21;

const object = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  return null;
};
const cleanName = (value: unknown): string | null => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;

export function parseOpenDotaTeamDirectory(payload: unknown): OpenDotaTeamDirectoryEntry[] {
  if (!Array.isArray(payload) || payload.length > 20_000) return [];
  const teams = new Map<string, OpenDotaTeamDirectoryEntry>();
  for (const value of payload) {
    if (!object(value)) continue;
    const teamId = id(value.team_id), name = cleanName(value.name);
    // Identity does not require an OpenDota rating: unrated teams can still enter the history queue.
    const rating = value.rating == null ? 0 : value.rating, last = value.last_match_time == null ? 0 : value.last_match_time;
    if (!teamId || !name || typeof rating !== 'number' || !Number.isFinite(rating) || typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) continue;
    const team = { id: teamId, name, tag: cleanName(value.tag), rating, last_match_time: last };
    const previous = teams.get(teamId);
    if (!previous || team.last_match_time > previous.last_match_time || team.last_match_time === previous.last_match_time && team.rating > previous.rating) teams.set(teamId, team);
  }
  return [...teams.values()];
}

export function selectTier1Core(directory: OpenDotaTeamDirectoryEntry[], nowSeconds: number): DynamicTeamPoolEntry[] {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) return [];
  return directory
    .filter(team => team.last_match_time < nowSeconds && team.last_match_time >= nowSeconds - ACTIVE_WINDOW_SECONDS)
    .sort((a, b) => b.rating - a.rating || b.last_match_time - a.last_match_time || a.id.localeCompare(b.id))
    .slice(0, TIER1_TEAM_COUNT)
    .map((team, index) => ({ ...team, qualification: 'tier1-rating', tier1_rank: index + 1, tier1_opponent_maps: 0, recent_maps: 0 }));
}

function opponentId(row: Raw, teamId: string): string | null {
  const opposing = id(row.opposing_team_id);
  if (opposing) return opposing;
  const radiant = id(row.radiant_team_id), dire = id(row.dire_team_id);
  if (radiant === teamId) return dire;
  if (dire === teamId) return radiant;
  return null;
}

function matchId(row: Raw): string | null { return id(row.match_id); }
function startTime(row: Raw): number { return typeof row.start_time === 'number' && Number.isSafeInteger(row.start_time) ? row.start_time : 0; }

export function frequentTier1CandidateIds(core: DynamicTeamPoolEntry[], histories: Map<string, Raw[]>): string[] {
  const coreIds = new Set(core.map(team => team.id));
  const matches = new Map<string, Set<string>>();
  for (const team of core) for (const row of histories.get(team.id) ?? []) {
    const opponent = opponentId(row, team.id), match = matchId(row);
    if (!opponent || !match || coreIds.has(opponent)) continue;
    if (!matches.has(opponent)) matches.set(opponent, new Set());
    matches.get(opponent)!.add(match);
  }
  return [...matches].filter(([, ids]) => ids.size >= TIER1_OPPONENT_MIN_MAPS).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([teamId]) => teamId);
}

export function qualifyFrequentTier1Teams(core: DynamicTeamPoolEntry[], directory: OpenDotaTeamDirectoryEntry[], histories: Map<string, Raw[]>): DynamicTeamPoolEntry[] {
  const coreIds = new Set(core.map(team => team.id));
  const byId = new Map(directory.map(team => [team.id, team]));
  const qualified: DynamicTeamPoolEntry[] = [];
  for (const [teamId, rows] of histories) {
    if (coreIds.has(teamId)) continue;
    const seen = new Set<string>();
    const recent = rows.filter(object).sort((a, b) => startTime(b) - startTime(a) || String(matchId(b)).localeCompare(String(matchId(a)))).filter(row => {
      const match = matchId(row);
      if (!match || seen.has(match)) return false;
      seen.add(match);
      return true;
    }).slice(0, RECENT_MAP_COUNT);
    if (recent.length < RECENT_MAP_COUNT) continue;
    const versusTier1 = recent.filter(row => {
      const opponent = opponentId(row, teamId);
      return opponent !== null && coreIds.has(opponent);
    }).length;
    const team = byId.get(teamId);
    if (team && versusTier1 >= TIER1_OPPONENT_MIN_MAPS) qualified.push({ ...team, qualification: 'frequent-tier1-opponent', tier1_rank: null, tier1_opponent_maps: versusTier1, recent_maps: recent.length });
  }
  return qualified.sort((a, b) => b.tier1_opponent_maps - a.tier1_opponent_maps || b.rating - a.rating || a.id.localeCompare(b.id));
}
