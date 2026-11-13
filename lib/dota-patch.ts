/** Explicit IDs in OpenDota's maintained constants, not array positions or the
 * newest match in a possibly stale local history. Betting uses the numeric ID;
 * a letter suffix in the human label is deliberately ignored.
 * Schema verified against the OpenDota dotaconstants repository. */
export const PATCH_SOURCE_URL = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/patch.json';

export interface CurrentPatch {
  patch_id: string | null;
  patch_name: string | null;
  released_at: string | null;
  verified_at: string;
  source_url: string;
  warnings: string[];
}

export function parseCurrentPatch(value: unknown, now = Date.now()): Pick<CurrentPatch, 'patch_id' | 'patch_name' | 'released_at'> | null {
  if (!Array.isArray(value) || !value.length || !Number.isFinite(now)) return null;
  const entries: { id: number; name: string; date: number }[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      !Number.isSafeInteger(row.id) || row.id < 0 || typeof row.name !== 'string' || !/^\d+\.\d+[a-z]?$/.test(row.name) ||
      typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date))) return null;
    entries.push({ id: row.id, name: row.name, date: Date.parse(row.date) });
  }
  if (new Set(entries.map(row => row.id)).size !== entries.length || new Set(entries.map(row => row.date)).size !== entries.length) return null;
  const latest = entries.filter(row => row.date <= now).sort((a, b) => b.date - a.date)[0];
  return latest ? { patch_id: String(latest.id), patch_name: latest.name.replace(/[a-z]$/, ''), released_at: new Date(latest.date).toISOString() } : null;
}

export async function fetchCurrentPatch(fetchFn: typeof fetch = fetch, now = Date.now()): Promise<CurrentPatch> {
  if (!Number.isFinite(now)) throw new Error('Некорректное время проверки патча.');
  const result: CurrentPatch = { patch_id: null, patch_name: null, released_at: null, verified_at: new Date(now).toISOString(), source_url: PATCH_SOURCE_URL, warnings: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetchFn(PATCH_SOURCE_URL, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: controller.signal, cache: 'no-store' });
    if (!response.ok || response.redirected || response.type === 'opaqueredirect') {
      await response.body?.cancel();
      result.warnings.push(`Текущий патч не подтверждён: источник OpenDota вернул HTTP ${response.status}. Ставки заблокированы.`);
      return result;
    }
    const parsed = parseCurrentPatch(await response.json(), now);
    if (!parsed) {
      result.warnings.push('Текущий патч не подтверждён: неизвестная или противоречивая схема справочника OpenDota. Ставки заблокированы.');
      return result;
    }
    Object.assign(result, parsed);
    return result;
  } catch {
    result.warnings.push('Текущий патч не подтверждён: справочник OpenDota недоступен. Ставки заблокированы.');
    return result;
  } finally {
    clearTimeout(timer);
  }
}
