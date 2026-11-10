"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, ArrowUpRight, Check, CheckCircle2, Clock3, Info, LoaderCircle, Plus, RefreshCw, Settings2, TrendingDown, TrendingUp, Wallet, X } from "lucide-react";
import type { OddsQuote, PaperBetView, PaperCurvePoint, PaperDashboard } from "@/lib/dota-paper-types";
import type { Forecast, Market } from "@/lib/dota-types";
import OpenaiSources from './openai-sources';
import AutomaticOdds from './automatic-odds';

type ValuePolicy = {min_odds: number; min_ev: number; probability_reserve: number};
type ResponseData = PaperDashboard & { forecasts?: Forecast[]; data_mode?: string; settings_persisted?: boolean; value_policy?: ValuePolicy };
const defaultValuePolicy: ValuePolicy = {min_odds: 1.8, min_ev: 0.05, probability_reserve: 0.03};
function valueDecision(forecast: Forecast, quote: OddsQuote, policy: ValuePolicy) {
  const adjustedProbability = Math.max(0, forecast.probability - policy.probability_reserve);
  const adjustedEv = adjustedProbability * quote.decimal_odds - 1;
  const reason = quote.decimal_odds < policy.min_odds ? `Коэффициент ниже ${policy.min_odds.toFixed(2)}` : adjustedEv < policy.min_ev ? 'Недостаточный EV после запаса погрешности' : null;
  return {adjustedProbability, adjustedEv, reason};
}
const markets: Record<Market, string> = { map_handicap: "Форы по картам", series_winner: "Победы в серии", map_kills: "Убийства", map_duration: "Длительность" };
const number = (value: number, digits = 2) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
const oddsNumber = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4, minimumFractionDigits: 2 }).format(value);
const signed = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;
const percent = (value: number | null) => value === null ? "—" : `${number(value * 100, 1)}%`;
const localDate = (value: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Yakutsk", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const yakutskInput = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 19);
const decimal = (value: string) => Number(value.replace(",", "."));
const safeUrl = (value: string) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; } };
const matchLabel = (forecast: Forecast) => `${forecast.team_a} — ${forecast.team_b}`;
function forecastLabel(forecast: Forecast) {
  if (forecast.market === "map_duration" && typeof forecast.threshold === "number") {
    const threshold = `${Math.floor(forecast.threshold / 60)}:${String(forecast.threshold % 60).padStart(2, "0")}`;
    if (forecast.selection === "under") return `Карта ${forecast.map_number || 1}: меньше ${threshold}`;
    if (forecast.selection === "over_or_equal") return `Карта ${forecast.map_number || 1}: ${threshold} и дольше`;
  }
  return forecast.label.replace(/(\d)\.(\d)/g, "$1,$2");
}
async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let result: Record<string, unknown>;
  try { result = await response.json(); } catch { throw new Error("Сервис не ответил. Обновите данные и попробуйте ещё раз."); }
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Не удалось сохранить запись.");
  return result;
}
function Notice({ children }: { children: React.ReactNode }) { return <div className="paper-notice"><Info size={16} /><p>{children}</p></div>; }
function EmptyState({ title, text, compact = false }: { title: string; text: string; compact?: boolean }) { return <div className={`paper-empty ${compact ? "compact" : ""}`}><span><Clock3 size={23} /></span><h3>{title}</h3><p>{text}</p></div>; }
function Source({ url }: { url: string }) { const safe = safeUrl(url); return safe ? <a className="paper-source" href={safe} target="_blank" rel="noreferrer">Источник <ArrowUpRight size={13} /></a> : <span className="paper-muted">Без ссылки</span>; }

export default function PaperBets({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<ResponseData | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [quoteOpen, setQuoteOpen] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [betQuote, setBetQuote] = useState<OddsQuote | null>(null);
  const loadData = useCallback(async () => {
    try { setData(await request("/api/paper") as unknown as ResponseData); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось открыть журнал ставок."); }
    finally { setLoading(false); setBusy(false); }
  }, []);
  const refresh = useCallback(async () => { setBusy(true); await loadData(); }, [loadData]);
  useEffect(() => {
    let active = true;
    request("/api/paper").then(value => { if (active) { setData(value as unknown as ResponseData); setError(""); } })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Не удалось открыть журнал ставок."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshKey]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 7000); return () => clearTimeout(timer); }, [notice]);
  const lookup = useMemo(() => new Map<string, Forecast>([...(data?.forecasts || []), ...(data?.eligible_forecasts || []), ...(data?.bets.map(bet => bet.forecast) || [])].map(forecast => [forecast.forecast_id, forecast])), [data]);
  const eligible = useMemo(() => (data?.eligible_forecasts || []).filter(forecast => new Date(forecast.scheduled_start_utc).getTime() > now), [data, now]);
  const saved = async (message: string) => { setQuoteOpen(false); setSettingsOpen(false); setBetQuote(null); await refresh(); setNotice(message); };
  const exportCsv = () => {
    if (!data) return;
    const cell = (value: unknown) => { const text = String(value ?? ""); return `"${(typeof value === "string" && /^[\s]*[=+@-]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`; };
    const rows: unknown[][] = [["ID ставки", "Матч", "Начало UTC", "Событие", "Букмекер", "Коэффициент", "Сумма, ед.", "Вероятность модели", "Статус", "Выплата, ед.", "Прибыль, ед.", "Ставка создана UTC", "Коэффициент замечен UTC", "Коэффициент сохранён UTC", "Результат записан UTC", "Источник"]];
    for (const bet of data.bets) rows.push([bet.bet_id, matchLabel(bet.forecast), bet.forecast.scheduled_start_utc, forecastLabel(bet.forecast), bet.quote.bookmaker, bet.odds_snapshot, bet.stake, bet.probability_snapshot, statusLabel(bet.status), bet.payout, bet.profit, bet.placed_utc, bet.quote.observed_utc, bet.quote.recorded_utc, bet.settled_utc, bet.quote.source_url]);
    const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8;" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `dota-lab-paper-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
    setNotice(`Экспортировано ставок: ${data.bets.length}`);
  };

  if (loading) return <div className="loading-state"><LoaderCircle className="spin" size={28} /><h2>Открываем виртуальный банк</h2><p>Загружаем коэффициенты и журнал ставок.</p></div>;
  if (!data) return <div className="panel"><EmptyState title="Журнал пока недоступен" text={error || "Попробуйте обновить данные."} /><div className="paper-empty-action"><button className="button button-primary" onClick={refresh}>Попробовать снова</button></div></div>;
  const m = data.metrics;
  const valuePolicy = data.value_policy || defaultValuePolicy;
  const hasResults = data.curve.length > 1;
  return <div className="paper-lab">
    <div className="paper-toolbar"><span className="paper-mode"><span className="green-dot" />Виртуальные единицы · реальные коэффициенты</span><div><button className="button button-light" onClick={exportCsv} disabled={!data.bets.length}><ArrowDownToLine size={15} />Экспорт CSV</button><button className="icon-button" onClick={refresh} disabled={busy} aria-label="Обновить виртуальные ставки"><RefreshCw size={17} className={busy ? "spin" : ""} /></button></div></div>
    {error && <div className="error-banner" role="alert"><Info size={17} /><span>{error}</span><button onClick={refresh}>Повторить</button></div>}
    {notice && <div className="paper-success" role="status"><CheckCircle2 size={17} />{notice}</div>}
    <section className="paper-bank">
      <div className="paper-bank-main"><span className="paper-kicker"><Wallet size={16} />БАНК ЭКСПЕРИМЕНТА</span><h2>{number(m.bankroll)} <span>ед.</span></h2><p>Стартовый банк {number(m.initial_bankroll)} ед. <span>·</span> {m.registered} ставок в журнале</p><button onClick={() => setSettingsOpen(true)}><Settings2 size={14} />Настроить банк и сумму</button></div>
      <div className="paper-bank-balance"><div><span>Доступно для ставок</span><strong>{number(m.available_bankroll)} <small>ед.</small></strong></div><div><span>В ожидании результата</span><strong>{number(m.open_stakes)} <small>ед.</small></strong></div><p>Открытая ставка резервирует сумму до расчёта.</p></div>
    </section>
    <div className="paper-metrics">
      <Metric label="Чистая прибыль" value={`${signed(m.profit)} ед.`} note={`${m.settled} рассчитано · ${m.void} возвратов`} icon={TrendingUp} tone={m.profit} />
      <Metric label="ROI ставок" value={percent(m.roi)} note={m.settled ? `На ${number(m.settled_staked)} ед. рассчитанных ставок` : "Появится после первого расчёта"} icon={TrendingUp} tone={m.roi || 0} />
      <Metric label="Доходность банка" value={hasResults ? percent(m.bankroll_return) : "—"} note="Прибыль / стартовый банк" icon={Wallet} tone={m.bankroll_return} />
      <Metric label="Максимальная просадка" value={hasResults ? percent(m.max_drawdown_pct) : "—"} note={hasResults ? `${number(m.max_drawdown)} ед. от предыдущего максимума` : "Появится после первого расчёта"} icon={TrendingDown} />
    </div>
    <section className="panel paper-curve-panel"><div className="panel-heading"><div><h2>Динамика банка</h2><p>По времени регистрации результатов · Якутск UTC+9</p></div><span className="soft-tag">{m.pending} ожидают</span></div>{data.curve.length ? <EquityCurve points={data.curve} initialBankroll={m.initial_bankroll} /> : <EmptyState title="История банка начнётся с первой ставки" text="После расчёта увидим прибыль и падения от достигнутого максимума. До этого график остаётся пустым." />}</section>
    <AutomaticOdds onUpdated={loadData} refreshKey={refreshKey} />
    <OpenaiSources />
    <section className="panel paper-quote-panel">
      <div className="panel-heading"><div><h2>Реальные коэффициенты <span className="count-chip">{data.quotes.length}</span></h2><p>Фиксируем цену, источник и время до начала серии</p></div><button className="button button-primary" onClick={() => setQuoteOpen(true)} disabled={!eligible.length}><Plus size={16} />Добавить коэффициент</button></div>
      <Notice>Порог коэффициента: {oddsNumber(valuePolicy.min_odds)}. Минимальный EV после запаса: {percent(valuePolicy.min_ev)}; вероятность уменьшается на {number(valuePolicy.probability_reserve * 100, 1)} п.п. Ручные ставки проходят те же проверки состава, патча, свежести и ожидаемой доходности. Сохранение цены само по себе не создаёт ставку.</Notice>
      {!eligible.length && <div className="paper-future-note"><Clock3 size={18} /><div><strong>Нужен прогноз на будущий матч</strong><p>Прошлые коэффициенты не восстанавливаем. Когда в журнале появится будущая серия, здесь можно будет зафиксировать её цену.</p></div></div>}
      {data.quotes.length ? <div className="paper-quotes">{[...data.quotes].sort((a, b) => b.recorded_utc.localeCompare(a.recorded_utc)).map(quote => {
        const forecast = lookup.get(quote.forecast_id);
        const started = !forecast || new Date(forecast.scheduled_start_utc).getTime() <= now;
        const expired = now - new Date(quote.observed_utc).getTime() > 10 * 60_000;
        const alreadyBet = data.bets.some(bet => bet.forecast_id === quote.forecast_id);
        const decision = forecast ? valueDecision(forecast, quote, valuePolicy) : null;
        return <article className="paper-quote" key={quote.quote_id}><div className="paper-quote-event"><span>{forecast ? matchLabel(forecast) : "Прогноз в журнале"}</span><h3>{forecast ? forecastLabel(forecast) : quote.source_market_label || quote.forecast_id}</h3><div className="paper-time">Замечен {localDate(quote.observed_utc)} · сохранён {localDate(quote.recorded_utc)}</div><Source url={quote.source_url} /></div><div className="paper-quote-price"><span>{quote.bookmaker}</span><strong>{oddsNumber(quote.decimal_odds)}</strong>{decision && <small>EV с запасом: {percent(decision.adjustedEv)}</small>}</div><div className="paper-quote-action"><button className="button button-light" onClick={() => setBetQuote(quote)} disabled={started || expired || alreadyBet || !!decision?.reason || m.available_bankroll <= 0}>{alreadyBet ? <><Check size={14} />Ставка записана</> : "Виртуальная ставка"}</button>{!alreadyBet && <small>{started ? "Серия уже началась" : expired ? "Нужен свежий коэффициент" : decision?.reason ? decision.reason : m.available_bankroll <= 0 ? "Нет свободных единиц" : "Сумму выберем следующим шагом"}</small>}</div></article>;
      })}</div> : <EmptyState compact title="Коэффициентов пока нет" text="Добавляем только цену, которую действительно увидели до начала матча." />}
    </section>
    <section className="panel paper-history"><div className="panel-heading"><div><h2>Журнал виртуальных ставок <span className="count-chip">{data.bets.length}</span></h2><p>Коэффициент, сумма и вероятность сохраняются на момент ставки</p></div></div>{data.bets.length ? <div className="table-scroll"><table className="paper-table"><thead><tr><th>Матч и событие</th><th>Коэффициент</th><th>Сумма</th><th>Результат</th><th>Выплата / прибыль</th><th>Зафиксировано</th></tr></thead><tbody>{[...data.bets].sort((a, b) => b.placed_utc.localeCompare(a.placed_utc)).map(bet => <tr key={bet.bet_id}><td><strong>{matchLabel(bet.forecast)}</strong><span>{forecastLabel(bet.forecast)}</span><small>Модель: {percent(bet.probability_snapshot)}</small></td><td><strong>{oddsNumber(bet.odds_snapshot)}</strong><small>{bet.quote.bookmaker}</small><Source url={bet.quote.source_url} /></td><td className="paper-numeric">{number(bet.stake)} ед.</td><td><span className={`status ${bet.status}`}>{statusLabel(bet.status)}</span></td><td className="paper-numeric">{bet.payout === null ? "—" : `${number(bet.payout)} ед.`}<small className={bet.profit && bet.profit < 0 ? "paper-negative" : bet.profit && bet.profit > 0 ? "paper-positive" : ""}>{bet.profit === null ? "Ожидает расчёта" : `${signed(bet.profit)} ед.`}</small></td><td><span className="paper-time">{localDate(bet.placed_utc)}</span>{bet.settled_utc && <small>Расчёт {localDate(bet.settled_utc)}</small>}</td></tr>)}</tbody></table></div> : <EmptyState title="Первая ставка ещё впереди" text={`Банк готов: ${number(m.available_bankroll)} ед. Сначала фиксируем реальный коэффициент, затем выбираем сумму виртуальной ставки.`} />}</section>
    {!!data.bets.length && <section className="panel paper-market-panel"><div className="panel-heading"><div><h2>Результаты по событиям</h2><p>Форы, убийства и минуты оцениваем отдельно</p></div></div><div className="table-scroll"><table className="paper-table"><thead><tr><th>События</th><th>Рассчитано / всего</th><th>Прошли</th><th>Прибыль</th><th>ROI</th></tr></thead><tbody>{data.by_market.map(row => <tr key={row.market}><td><strong>{markets[row.market]}</strong></td><td>{row.settled} / {row.registered}</td><td>{row.won}</td><td>{signed(row.profit)} ед.</td><td>{percent(row.roi)}</td></tr>)}</tbody></table></div></section>}
    <details className="panel paper-method"><summary>Как считаем прибыль и просадку <Info size={16} /></summary><div><p><strong>Выигрыш:</strong> выплата = сумма × коэффициент; прибыль = выплата − сумма. <strong>Проигрыш:</strong> теряем сумму ставки. <strong>Возврат:</strong> сумма возвращается, прибыль равна нулю.</p><p><strong>ROI</strong> — чистая прибыль / сумма выигравших и проигравших ставок. Возвраты и открытые ставки в знаменатель не входят. <strong>Доходность банка</strong> — прибыль / начальный банк.</p><p><strong>Просадка</strong> — падение рассчитанного банка от достигнутого максимума, в единицах и процентах. Резерв по открытым ставкам показываем отдельно. Исправленный результат меняет банк отдельной корректировкой в момент регистрации.</p><p>Каждую ставку фиксируем до начала серии по коэффициенту не старше 10 минут. Результаты пересчитываются при внесении факта в общий журнал. Ставки на один матч могут зависеть друг от друга; виртуальная прибыль проверяет эксперимент, а не гарантирует будущий доход.</p></div></details>
    {quoteOpen && <QuoteDialog forecasts={eligible} onClose={() => setQuoteOpen(false)} onSaved={() => saved("Коэффициент сохранён. Теперь можно выбрать сумму виртуальной ставки.")} />}
    {settingsOpen && <SettingsDialog data={data} onClose={() => setSettingsOpen(false)} onSaved={() => saved("Настройки виртуального банка сохранены.")} />}
    {betQuote && lookup.get(betQuote.forecast_id) && <BetDialog quote={betQuote} forecast={lookup.get(betQuote.forecast_id)!} data={data} onClose={() => setBetQuote(null)} onSaved={() => saved("Виртуальная ставка зафиксирована. Дождёмся результата матча.")} />}
  </div>;
}

function statusLabel(status: PaperBetView["status"]) { return { pending: "Ожидает", won: "Выигрыш", lost: "Проигрыш", void: "Возврат" }[status]; }
function Metric({ label, value, note, icon: Icon, tone = 0 }: { label: string; value: string; note: string; icon: typeof Wallet; tone?: number }) { return <div className="paper-metric"><div>{label}<Icon size={17} /></div><strong className={tone < 0 ? "paper-negative" : tone > 0 ? "paper-positive" : ""}>{value}</strong><p>{note}</p></div>; }
function EquityCurve({ points, initialBankroll }: { points: PaperCurvePoint[]; initialBankroll: number }) {
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(840);
  useEffect(() => {
    if (!element.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.round(entries[0].contentRect.width))));
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const values = points.map(point => point.bankroll);
  const min = Math.min(...values), max = Math.max(...values), margin = Math.max(1, (max - min) * 0.2), low = min - margin, high = max + margin;
  const height = 210, left = 55, right = 20, top = 20, bottom = 30;
  const firstTime = new Date(points[0].at).getTime(), lastTime = new Date(points[points.length - 1].at).getTime();
  const x = (index: number) => left + (lastTime > firstTime ? (new Date(points[index].at).getTime() - firstTime) / (lastTime - firstTime) : index / Math.max(1, points.length - 1)) * (width - left - right);
  const y = (value: number) => top + (high - value) / (high - low) * (height - top - bottom);
  const path = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`).join(" ");
  return <div className="paper-chart" ref={element}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Банк: от ${number(initialBankroll)} до ${number(values[values.length - 1])} единиц, ${points.length} изменений`}><title>Изменения рассчитанного банка по зарегистрированным результатам</title>{[low, (low + high) / 2, high].map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e7ece2" strokeDasharray="4 5" /><text x={left - 12} y={y(value) + 4} textAnchor="end" fill="#8e9b85" fontSize="11">{number(value, 1)}</text></g>)}<line x1={left} x2={width - right} y1={y(initialBankroll)} y2={y(initialBankroll)} stroke="#b5c8a6" strokeDasharray="4 5" /><path d={path} fill="none" stroke="#287756" strokeWidth="2.5" strokeLinejoin="round" />{points.map((point, index) => <circle key={`${point.at}-${index}`} cx={x(index)} cy={y(point.bankroll)} r="3.5" fill="#287756"><title>{localDate(point.at)}: {number(point.bankroll)} ед. ({signed(point.delta)} ед.)</title></circle>)}<text x={left} y={height - 5} fill="#8e9b85" fontSize="11">Старт</text><text x={width - right} y={height - 5} textAnchor="end" fill="#8e9b85" fontSize="11">{localDate(points[points.length - 1].at)}</text></svg><p>Старт {number(initialBankroll)} ед. · последнее изменение {signed(points[points.length - 1].delta)} ед. · текущая просадка {percent(points[points.length - 1].drawdown_pct)}</p></div>;
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const tabbable = () => Array.from(element.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]') || []).filter(item => item.offsetParent !== null);
    tabbable()[0]?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); if (event.key !== "Tab") return; const items = tabbable(), first = items[0], last = items[items.length - 1]; if (!items.length) { event.preventDefault(); return; } if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } };
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", key); prior?.focus(); };
  }, []);
  return <div className="modal-backdrop centered" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="paper-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-dialog-title" ref={element}><div className="drawer-header"><strong id="paper-dialog-title">{title}</strong><button className="icon-button" onClick={onClose} aria-label="Закрыть окно"><X size={19} /></button></div>{children}</div></div>;
}
function useSubmission() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const key = useRef<{ payload: string; id: string } | null>(null);
  const submit = async (path: string, body: Record<string, unknown>, idField?: "quote_id" | "bet_id") => {
    setBusy(true); setError("");
    try { const signature = JSON.stringify(body); if (!key.current || key.current.payload !== signature) key.current = { payload: signature, id: crypto.randomUUID() }; await request(path, idField ? { ...body, [idField]: key.current.id } : body); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить запись."); return false; }
    finally { setBusy(false); }
  };
  return { busy, error, setError, submit };
}
function QuoteDialog({ forecasts, onClose, onSaved }: { forecasts: Forecast[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [scope, setScope] = useState("all"), [market, setMarket] = useState("all"), [forecastId, setForecastId] = useState(""), [bookmaker, setBookmaker] = useState("PARI"), [odds, setOdds] = useState(""), [observed, setObserved] = useState(yakutskInput), [url, setUrl] = useState(""), [sourceLabel, setSourceLabel] = useState("");
  const { busy, error, setError, submit } = useSubmission();
  const rows = forecasts.filter(forecast => (scope === "all" || forecast.selected) && (market === "all" || forecast.market === market));
  const selected = rows.find(forecast => forecast.forecast_id === forecastId);
  const save = async (event: FormEvent) => { event.preventDefault(); if (!selected) { setError("Выберите прогноз на будущий матч."); return; } const date = new Date(`${observed}+09:00`); if (!Number.isFinite(date.getTime())) { setError("Укажите время, когда вы увидели коэффициент, по Якутску."); return; } if (!safeUrl(url)) { setError("Укажите полную ссылку на источник коэффициента."); return; } if (await submit("/api/paper/quotes", { forecast_id: selected.forecast_id, bookmaker: bookmaker.trim(), decimal_odds: decimal(odds), observed_utc: date.toISOString(), source_url: url.trim(), ...(sourceLabel.trim() ? { source_market_label: sourceLabel.trim() } : {}) }, "quote_id")) await onSaved(); };
  return <Dialog title="Зафиксировать реальный коэффициент" onClose={onClose}><form onSubmit={save}><div className="paper-dialog-body"><p className="paper-form-lead">Перенесите цену, которую сейчас видите у букмекера. Она сохранится вместе с источником и временем.</p><div className="paper-form-grid"><label className="form-label">Набор прогнозов<select value={scope} onChange={event => { setScope(event.target.value); setForecastId(""); }}><option value="all">Все оценки</option><option value="selected">Исторический отбор</option></select></label><label className="form-label">Тип события<select value={market} onChange={event => { setMarket(event.target.value); setForecastId(""); }}><option value="all">Все события</option>{Object.entries(markets).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label className="form-label">Прогноз<select required value={selected ? forecastId : ""} onChange={event => setForecastId(event.target.value)}><option value="">Выберите матч и событие</option>{rows.map(forecast => <option key={forecast.forecast_id} value={forecast.forecast_id}>{matchLabel(forecast)} · {forecastLabel(forecast)}</option>)}</select></label>{selected && <div className="paper-selected"><strong>{matchLabel(selected)}</strong><span>{forecastLabel(selected)}</span><small>Начало {localDate(selected.scheduled_start_utc)} · вероятность модели {percent(selected.probability)}</small>{selected.market === "map_duration" && selected.threshold === 2460 && <small>Ровно 41:00 относится к «41:00 и дольше». Правило в источнике должно совпадать.</small>}</div>}<div className="paper-form-grid"><label className="form-label">Букмекер<input required maxLength={80} value={bookmaker} onChange={event => setBookmaker(event.target.value)} /></label><label className="form-label">Реальный коэффициент<input required inputMode="decimal" placeholder="Например, 2,20" value={odds} onChange={event => setOdds(event.target.value)} /></label></div><label className="form-label">Ссылка на матч / линию<input required type="url" placeholder="https://…" maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} /></label><label className="form-label">Название события у букмекера <span>Необязательно, если формулировка полностью совпадает</span><input maxLength={240} placeholder="Скопируйте название из линии" value={sourceLabel} onChange={event => setSourceLabel(event.target.value)} /></label><label className="form-label">Когда увидели коэффициент · Якутск UTC+9<input required type="datetime-local" step="1" value={observed} onChange={event => setObserved(event.target.value)} /></label><button className="text-button" type="button" onClick={() => setObserved(yakutskInput())}><Clock3 size={14} />Указать текущее время</button><Notice>Событие и правила расчёта должны совпадать с прогнозом, включая номер карты. Ставку можно записать до начала серии по цене не старше 10 минут.</Notice>{error && <div className="form-error" role="alert">{error}</div>}</div><div className="modal-actions"><button type="button" className="button button-light" onClick={onClose} disabled={busy}>Отмена</button><button className="button button-primary" disabled={busy || !selected}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Сохранить коэффициент</button></div></form></Dialog>;
}
function SettingsDialog({ data, onClose, onSaved }: { data: ResponseData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [bankroll, setBankroll] = useState(String(data.settings.initial_bankroll)), [stake, setStake] = useState(String(data.settings.default_stake));
  const { busy, error, submit } = useSubmission();
  const save = async (event: FormEvent) => { event.preventDefault(); if (await submit("/api/paper/settings", { initial_bankroll: decimal(bankroll), default_stake: decimal(stake) })) await onSaved(); };
  return <Dialog title="Настройки виртуального банка" onClose={onClose}><form onSubmit={save}><div className="paper-dialog-body"><p className="paper-form-lead">Все суммы — условные единицы. Настоящие деньги в приложении не используются.</p><label className="form-label">Стартовый банк, ед.<input required inputMode="decimal" disabled={data.settings.locked} value={bankroll} onChange={event => setBankroll(event.target.value)} /><span>{data.settings.locked ? "Зафиксирован первой ставкой и больше не меняется." : "Можно изменить до первой виртуальной ставки."}</span></label><label className="form-label">Сумма ставки по умолчанию, ед.<input required inputMode="decimal" value={stake} onChange={event => setStake(event.target.value)} /><span>Подставляем в новую ставку. Сумму можно изменить перед записью.</span></label>{error && <div className="form-error" role="alert">{error}</div>}</div><div className="modal-actions"><button type="button" className="button button-light" onClick={onClose} disabled={busy}>Отмена</button><button className="button button-primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}Сохранить настройки</button></div></form></Dialog>;
}
function BetDialog({ quote, forecast, data, onClose, onSaved }: { quote: OddsQuote; forecast: Forecast; data: ResponseData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [stake, setStake] = useState(String(data.settings.default_stake));
  const { busy, error, submit } = useSubmission();
  const policy = data.value_policy || defaultValuePolicy, decision = valueDecision(forecast, quote, policy);
  const amount = decimal(stake), ev = forecast.probability * quote.decimal_odds - 1, valid = Number.isFinite(amount) && amount > 0 && amount <= data.metrics.available_bankroll && !decision.reason;
  const save = async (event: FormEvent) => { event.preventDefault(); if (await submit("/api/paper/bets", { quote_id: quote.quote_id, stake: amount }, "bet_id")) await onSaved(); };
  return <Dialog title="Записать виртуальную ставку" onClose={onClose}><form onSubmit={save}><div className="paper-dialog-body"><div className="paper-selected"><strong>{matchLabel(forecast)}</strong><span>{forecastLabel(forecast)}</span><small>Начало {localDate(forecast.scheduled_start_utc)} · Якутск UTC+9</small></div><div className="paper-bet-price"><span>{quote.bookmaker}<small>Замечен {localDate(quote.observed_utc)}</small></span><strong>{oddsNumber(quote.decimal_odds)}</strong></div><Source url={quote.source_url} /><label className="form-label">Виртуальная сумма, ед.<input required inputMode="decimal" value={stake} onChange={event => setStake(event.target.value)} autoFocus /><span>Доступно {number(data.metrics.available_bankroll)} ед. · после ставки {valid ? number(data.metrics.available_bankroll - amount) : "—"} ед.</span></label><div className="paper-bet-preview"><div><span>Если выиграет</span><strong>{valid ? `+${number(amount * (quote.decimal_odds - 1))}` : "—"} ед.</strong></div><div><span>Если проиграет</span><strong>{valid ? `−${number(amount)}` : "—"} ед.</strong></div></div><Notice>Вероятность модели: {percent(forecast.probability)}; исходный EV: {percent(ev)}. После запаса {number(policy.probability_reserve * 100, 1)} п.п.: вероятность {percent(decision.adjustedProbability)}, EV {percent(decision.adjustedEv)}. {decision.reason || "Числовые пороги пройдены; сервер дополнительно проверит актуальный патч и состав."} Положительный расчёт EV не гарантирует прибыль.</Notice><p className="paper-form-lead">Коэффициент, вероятность и сумма фиксируются сейчас. После записи изменить ставку нельзя.</p>{error && <div className="form-error" role="alert">{error}</div>}</div><div className="modal-actions"><button type="button" className="button button-light" onClick={onClose} disabled={busy}>Отмена</button><button className="button button-primary" disabled={busy || !valid}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Записать {valid ? `${number(amount)} ед.` : "ставку"}</button></div></form></Dialog>;
}
