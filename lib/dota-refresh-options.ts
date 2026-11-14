import { invariant } from './dota-core';

/** Explicit manual refresh bypasses application cadence, never validation or API budgets. */
export type RefreshOptions = { force_refresh?: boolean };
export function refreshOptions(input: unknown = {}): RefreshOptions {
  invariant(!!input && typeof input === 'object' && !Array.isArray(input), 'Некорректные параметры запуска.');
  const value = (input as RefreshOptions).force_refresh;
  invariant(value === undefined || typeof value === 'boolean', 'force_refresh должен быть логическим значением.');
  return { force_refresh: value === true };
}
