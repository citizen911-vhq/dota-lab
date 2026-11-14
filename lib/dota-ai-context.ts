import type { Forecast } from './dota-types';
import type { PaperDashboard } from './dota-paper-types';
import type { AiFixture, AiIssue, AiMode, AiSnapshot } from './dota-ai-types';
import { invariant } from './dota-core';
import { MAX_PAPER_BETS_PER_SERIES, type ValuePolicy } from './dota-value';

type Row = Record<string, any>;
const text = (v: unknown, limit = 1000) => typeof v === 'string' ? v.slice(0, limit) : '';
const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 1000)) : [];
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
export const moscowDay = (now: number) => new Date(now + 3 * 3600000).toISOString().slice(0, 10);
export const moscowDayStart = (now: number) => Date.parse(moscowDay(now) + 'T00:00:00+03:00');

export function aiRequest(input: unknown): { mode: AiMode; fixture_id: string | null; force_refresh: boolean } {
  invariant(!!input && typeof input === 'object' && !Array.isArray(input), 'Нужны параметры анализа ИИ.');
  const value = input as Row;
  invariant(['explain', 'news', 'daily'].includes(value.mode), 'Неизвестная вкладка ИИ.');
  invariant(value.fixture_id == null || typeof value.fixture_id === 'string' && value.fixture_id.length > 0 && value.fixture_id.length <= 200, 'Некорректный идентификатор серии.');
  invariant(value.force_refresh === undefined || typeof value.force_refresh === 'boolean', 'force_refresh должен быть логическим значением.');
  invariant(value.mode !== 'daily' || value.fixture_id == null, 'Дневная сводка относится ко всем сериям.');
  return { mode: value.mode, fixture_id: value.fixture_id ?? null, force_refresh: value.force_refresh === true };
}

/** Explicit allowlist: no keys, raw environment, player identities or unrelated journal metadata. */
export function buildAiSnapshot(forecasts: Forecast[], paper: PaperDashboard, state: Row, lastRun: Row | null, dayRuns: Row[], policy: ValuePolicy, storage: string, now: number): AiSnapshot {
  const fixtures = new Map<string, AiFixture>();
  for (const f of forecasts) {
    const row = fixtures.get(f.fixture_id) ?? { fixture_id: f.fixture_id, team_a: text(f.team_a, 200), team_b: text(f.team_b, 200), scheduled_start_utc: f.scheduled_start_utc, forecasts: [], bets: [], quotes: [] };
    row.forecasts.push({ forecast_id: f.forecast_id, label: text(f.label, 300), probability: f.probability, created_utc: f.created_utc, n_maps_a: f.n_maps_a, n_maps_b: f.n_maps_b });
    fixtures.set(f.fixture_id, row);
  }
  for (const b of paper.bets) fixtures.get(b.forecast.fixture_id)?.bets.push({ label: text(b.forecast.label, 300), status: b.status, odds: b.odds_snapshot, probability: b.probability_snapshot, stake: b.stake, placed_utc: b.placed_utc });
  for (const q of [...paper.quotes].sort((a, b) => b.recorded_utc.localeCompare(a.recorded_utc))) {
    const f = forecasts.find(f => f.forecast_id === q.forecast_id), row = f && fixtures.get(f.fixture_id);
    if (f && row && row.quotes.length < 12) row.quotes.push({ label: text(f.label, 300), odds: q.decimal_odds, bookmaker: text(q.bookmaker, 200), observed_utc: q.observed_utc });
  }
  const odds = state['paper:auto:last'], issues: AiIssue[] = [];
  for (const s of Array.isArray(lastRun?.skipped) ? lastRun.skipped : []) {
    if (!s || typeof s.reason !== 'string') continue;
    const id = text(s.fixture_id, 200) || null;
    if (id && !fixtures.has(id)) fixtures.set(id, { fixture_id: id, team_a: text(s.fixture, 400) || id, team_b: '', scheduled_start_utc: null, forecasts: [], bets: [], quotes: [] });
    issues.push({ fixture_id: id, reason: text(s.reason), source: 'Последний цикл анализа', at: text(lastRun?.finished_at) || text(lastRun?.started_at) || null });
  }
  for (const reason of strings(odds?.skipped)) {
    const f = forecasts.find(f => reason.startsWith(f.forecast_id + ':'));
    issues.push({ fixture_id: f?.fixture_id ?? null, reason: f ? `${f.label}: ${reason.slice(f.forecast_id.length + 1).trim()}` : reason, source: 'Последняя проверка коэффициентов', at: text(odds?.at) || null });
  }
  const start = moscowDayStart(now), today = (v: string | null) => !!v && Date.parse(v) >= start && Date.parse(v) <= now;
  const settled = paper.bets.filter(b => b.status !== 'pending' && today(b.settled_utc));
  const ordered = [...fixtures.values()].sort((a, b) => {
    const aFuture = Date.parse(a.scheduled_start_utc ?? '') > now, bFuture = Date.parse(b.scheduled_start_utc ?? '') > now;
    return Number(bFuture) - Number(aFuture) || (aFuture ? String(a.scheduled_start_utc).localeCompare(String(b.scheduled_start_utc)) : String(b.scheduled_start_utc).localeCompare(String(a.scheduled_start_utc)));
  });
  return {
    generated_at: new Date(now).toISOString(), day: moscowDay(now), timezone: 'Europe/Moscow', storage,
    last_analysis: lastRun ? { at: text(lastRun.finished_at) || text(lastRun.started_at) || null, status: text(lastRun.status), backlog: number(lastRun.backlog_count), warnings: strings(lastRun.warnings).slice(0, 30) } : null,
    last_odds: odds ? { at: text(odds.at) || null, status: text(odds.status), reason: text(odds.reason), eligible_forecasts: number(odds.eligible_forecasts), bets_added: number(odds.bets_added) } : null,
    history: state['state:betting_health'] ? { healthy: state['state:betting_health'].healthy === true, verified_at: text(state['state:betting_health'].verified_at) || null } : null,
    rules: { ...policy, max_bets_per_series: MAX_PAPER_BETS_PER_SERIES },
    bankroll: { bankroll: paper.metrics.bankroll, available_bankroll: paper.metrics.available_bankroll, open_stakes: paper.metrics.open_stakes },
    daily: { forecasts: forecasts.filter(f => today(f.created_utc)).length, bets: paper.bets.filter(b => today(b.placed_utc)).length, settled: settled.length, won: settled.filter(b => b.status === 'won').length, lost: settled.filter(b => b.status === 'lost').length, void: settled.filter(b => b.status === 'void').length, profit: Math.round(settled.reduce((sum, b) => sum + (b.profit ?? 0), 0) * 100) / 100, analyses: dayRuns.length, maps_added: dayRuns.reduce((sum, r) => sum + number(r.maps_added), 0) },
    fixtures: ordered.slice(0, 80).map(f => ({ ...f, forecasts: f.forecasts.slice(0, 24) })), issues: issues.slice(0, 120), fixtures_total: ordered.length, issues_total: issues.length,
  };
}

export function aiContext(snapshot: AiSnapshot, mode: AiMode, fixtureId: string | null) {
  invariant(!fixtureId || snapshot.fixtures.some(f => f.fixture_id === fixtureId), 'Серия не найдена в текущем контексте. Обновите список.');
  const selected = fixtureId ? snapshot.fixtures.filter(f => f.fixture_id === fixtureId) : snapshot.fixtures;
  const issues = fixtureId ? snapshot.issues.filter(i => !i.fixture_id || i.fixture_id === fixtureId) : snapshot.issues;
  if (mode === 'news') return { generated_at: snapshot.generated_at, day: snapshot.day, timezone: snapshot.timezone,
    fixtures: selected.slice(0, 24).map(f => ({ team_a: f.team_a, team_b: f.team_b, scheduled_start_utc: f.scheduled_start_utc })),
    context_note: 'Ограниченный список серий из журнала, а не полное расписание. Ищи сведения только об этих командах. Время начала в журнале само по себе не подтверждает свежесть расписания.' };
  return { ...snapshot, fixtures: selected.slice(0, mode === 'explain' ? 12 : 24), issues: issues.slice(0, 60),
    context_note: 'Срез сохранённых данных, не новая проверка API. Причины из отчётов относятся к указанному времени. Отсутствие сохранённой котировки не доказывает отсутствие линии у букмекера. Вероятности прогнозов предварительные; ставки содержат отдельные зафиксированные оценки. Дневной итог рассчитан по текущим записям расчёта ставок: исправления могут его изменить. Список серий и причин ограничен; общий счётчик указан отдельно.' };
}
