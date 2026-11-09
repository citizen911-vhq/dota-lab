import { env } from 'cloudflare:workers';
import { readPaperDashboard, recordOddsQuote, recordPaperBet } from './dota-paper-store';
import { fetchOddsLink, oddsLinkEvents, oddsLinkQuote, oddsLinkCoverage, ODDSLINK_BOOKS, type ScheduleProof } from './dota-oddslink';
import { TEAM_NAMES, checkedFixture } from './dota-auto-core';

export function paperAutoConfiguration() { return { provider: 'OddsLink', access: 'guest', enabled: env.AUTO_PAPER_ENABLED !== 'false', key_required: false, supported_markets: ['series_winner', 'map_handicap', 'map_kills'], duration_supported: false, bookmaker_priority: ODDSLINK_BOOKS, max_requests_per_utc_day: 2, cadence: 'При ежедневном автоанализе в 17:00 Якутска. Не более двух загрузок в сутки UTC, с интервалом от 30 минут; новый прогноз может использовать второй запрос раньше.', policy: 'Только заранее выбранные прогнозы: максимум два на серию, стандартная сумма банка, без фильтра коэффициента. Точное совпадение рынка, линии и подтверждённого BO3; цена не старше 15 минут.', limitation: 'Гостевой доступ OddsLink: до 5 запросов в сутки у источника, без гарантии доступности. Отсутствующие рынки пропускаем.' }; }
export async function paperAutoStatus() {
  const r = await env.DB!.prepare("SELECT payload FROM dota_analysis_records WHERE key='paper:auto:last'").first<{ payload: string }>();
  return { ...paperAutoConfiguration(), last_run: r ? JSON.parse(r.payload) : null };
}
export async function runPaperAuto() {
  const cfg = paperAutoConfiguration(), now = Date.now(), owner = crypto.randomUUID(), db = env.DB!;
  const report = { at: new Date(now).toISOString(), provider: 'OddsLink', policy_version: 'paper-oddslink-v1', status: 'blocked', bets_added: 0, quotes_added: 0, eligible_forecasts: 0, skipped: [] as string[], reason: '', coverage: null as ReturnType<typeof oddsLinkCoverage> | null, provider_remaining: null as string | null };
  if (!cfg.enabled) { report.reason = 'Автоматические виртуальные ставки выключены.'; return report; }
  const lease = await db.prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) VALUES('paper-auto',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(owner, now + 300000, now).first<{ owner: string }>();
  if (lease?.owner !== owner) { report.reason = 'Запуск уже выполняется.'; return report; }
  let saveReport = false;
  try {
    const p = await readPaperDashboard();
    const counts = new Map<string, number>();
    for (const bet of p.bets) counts.set(bet.forecast.fixture_id, (counts.get(bet.forecast.fixture_id) ?? 0) + 1);
    const forecasts = p.eligible_forecasts.filter(f => f.selected).sort((a, b) => Number(a.selection_rank) - Number(b.selection_rank) || a.forecast_id.localeCompare(b.forecast_id)).filter(f => { const n = counts.get(f.fixture_id) ?? 0; counts.set(f.fixture_id, n + 1); return n < 2; }).slice(0, 20);
    report.eligible_forecasts = forecasts.length;
    const dayKey = 'paper:oddslink:quota:' + new Date(now).toISOString().slice(0, 10);
    const previous = await db.prepare('SELECT payload FROM dota_analysis_records WHERE key=?').bind(dayKey).first<{ payload: string }>();
    const quota = previous ? JSON.parse(previous.payload) : { count: 0, last: 0 };
    const hasNewForecast = forecasts.some(f => !(quota.forecast_ids ?? []).includes(f.forecast_id));
    if (quota.blocked || quota.count >= 2 || (now - quota.last < 1800000 && !hasNewForecast)) { return { ...report, cached: true, reason: 'Лимит загрузок: до двух в сутки UTC, интервал 30 минут (кроме новых прогнозов); после 403/429 ждём следующего дня. Последний отчёт сохранён; старые цены не используются для новых ставок.' }; }
    // Reserve before the request. Errors consume the attempt; no retries.
    await db.prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(dayKey, JSON.stringify({ count: quota.count + 1, last: now, forecast_ids: forecasts.map(f => f.forecast_id) }), report.at).run();
    saveReport = true;
    let feed;
    try { feed = await fetchOddsLink(); } catch (e) {
      if (e instanceof Error && /HTTP (403|429)/.test(e.message)) await db.prepare('UPDATE dota_analysis_records SET payload=? WHERE key=?').bind(JSON.stringify({count: quota.count + 1, last: now, blocked: true}), dayKey).run();
      throw e;
    }
    report.coverage = oddsLinkCoverage(feed.rows, Date.now()); report.provider_remaining = feed.remaining;
    const rows = await db.prepare("SELECT payload FROM dota_analysis_records WHERE key LIKE 'fixture:%'").all<{ payload: string }>();
    const proofs: ScheduleProof[] = [];
    for (const row of rows.results) {
      try { const f = checkedFixture(JSON.parse(row.payload), Date.now()); proofs.push({ ...f, team_a: TEAM_NAMES[f.team_a_id], team_b: TEAM_NAMES[f.team_b_id] }); } catch {}
    }
    report.status = 'ok';
    if (!forecasts.length) { report.reason = 'Линия получена. Нет будущих выбранных прогнозов без ставки: ожидаем успешного обновления статистики и подтверждения расписания.'; return report; }
    for (const f of forecasts) {
      if (f.market === 'map_duration') { report.skipped.push(`${f.forecast_id}: длительность не поддерживается источником.`); continue; }
      const matches = oddsLinkEvents(feed.rows, f, proofs, Date.now());
      if (matches.length !== 1) { report.skipped.push(`${f.forecast_id}: нет однозначного совпадения команд, старта и независимо подтверждённого BO3.`); continue; }
      const quote = oddsLinkQuote(matches[0], f, Date.now());
      if (!quote) { report.skipped.push(`${f.forecast_id}: точная линия отсутствует, неоднозначна или старше 15 минут.`); continue; }
      try {
        const fresh = await readPaperDashboard();
        if (fresh.bets.some(b => b.forecast_id === f.forecast_id)) continue;
        if (fresh.bets.filter(b => b.forecast.fixture_id === f.fixture_id).length >= 2) { report.skipped.push(`${f.forecast_id}: уже две ставки на серию.`); continue; }
        if (fresh.metrics.available_bankroll < fresh.settings.default_stake) { report.skipped.push(`${f.forecast_id}: недостаточно свободного банка.`); continue; }
        const q = await recordOddsQuote({ ...quote, forecast_id: f.forecast_id }, 'agent'); report.quotes_added += Number(q.inserted);
        const b = await recordPaperBet({ quote_id: q.quote.quote_id, bet_id: 'auto:' + f.forecast_id, stake: fresh.settings.default_stake }); report.bets_added += Number(b.inserted);
      } catch { report.skipped.push(`${f.forecast_id}: запись отклонена; проверьте начало серии, банк или уже существующую ставку.`); }
    }
    report.reason = `Получена свежая линия. Виртуальных ставок добавлено: ${report.bets_added}; пропущено: ${report.skipped.length}.`;
  } catch (e) { report.status = 'blocked'; report.reason = e instanceof Error ? e.message : 'Источник недоступен.'; }
  finally {
    if (saveReport) await db.prepare("INSERT INTO dota_analysis_records(key,payload,updated_utc) SELECT 'paper:auto:last',?,? WHERE EXISTS(SELECT 1 FROM dota_analysis_lease WHERE id='paper-auto' AND owner=?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc").bind(JSON.stringify(report), new Date().toISOString(), owner).run();
    await db.prepare("DELETE FROM dota_analysis_lease WHERE id='paper-auto' AND owner=?").bind(owner).run();
  }
  return report;
}
