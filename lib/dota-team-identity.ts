/** Reviewed aliases, not fuzzy matching. Never merge historical Valve IDs.
 * Evidence: https://liquipedia.net/dota2/1w_Team and its redirects /1win,
 * /1w, /1win_Team, /Iron_Wing; OpenDota team 10182357. Reviewed 2026-11-14.
 */
export const VERIFIED_TEAM_IDENTITIES = [{
  id: '10182357',
  name: '1win',
  aliases: ['1win', '1win Team', '1w', '1w Team', 'Iron Wing'],
  liquipedia_paths: ['1w_Team', '1win', '1w', '1win_Team', 'Iron_Wing'],
}] as const;

const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

export function verifiedTeamIdByName(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const name = normalized(value);
  return VERIFIED_TEAM_IDENTITIES.find(t => t.aliases.some(alias => normalized(alias) === name))?.id;
}

export function verifiedTeamIdByUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  return VERIFIED_TEAM_IDENTITIES.find(t => t.liquipedia_paths.some(path => value === `https://liquipedia.net/dota2/${path}`))?.id;
}

/** An explicit expected Valve ID must agree with the reviewed alias. */
export function sameTeamName(value: unknown, expected: string, expectedId?: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (expectedId != null && typeof expectedId !== 'string' && typeof expectedId !== 'number') return false;
  const actualId = verifiedTeamIdByName(value), namedId = verifiedTeamIdByName(expected);
  if (expectedId != null && [actualId, namedId].some(id => id != null && id !== String(expectedId))) return false;
  if (actualId && namedId) return actualId === namedId;
  return normalized(value) === normalized(expected);
}
