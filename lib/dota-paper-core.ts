import { invariant, latestObservations, settle } from './dota-core';
import {checkedBetSnapshot} from './dota-bet-recalculation';
import type { Forecast, Market, Observation, Status } from './dota-types';
import type { OddsQuote, PaperBet, PaperBetView, PaperCurvePoint, PaperDashboard, PaperMarketSummary, PaperSettings } from './dota-paper-types';
import { evaluateValue, ODDS_REFRESH_MS, valuePolicy, VALUE_POLICY_VERSION } from './dota-value';

export const QUOTE_MAX_AGE_MS = ODDS_REFRESH_MS;
const MAX_MONEY = 1_000_000;
const MARKETS: Market[] = ['map_handicap', 'series_winner', 'map_kills', 'map_duration'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const date = (value: unknown): value is string => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const units = (minor: number) => minor / 100;
const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

function validNow(now: number): void {
  invariant(Number.isFinite(now) && Number.isFinite(new Date(now).getTime()), 'Некорректное серверное время.');
}

function minorUnits(value: unknown, name: string): number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_MONEY,
    `${name}: укажите число от 0,01 до ${MAX_MONEY}.`);
  const minor = Math.round(value * 100);
  invariant(Math.abs(value * 100 - minor) < 0.0000001 && minor > 0,
    `${name}: допускается не более двух знаков после запятой.`);
  return minor;
}

function oddsUnits(value: unknown): number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= 1.01 && value <= 1000,
    'Десятичный коэффициент должен быть от 1,01 до 1000.');
  const scaled = Math.round(value * 10000);
  invariant(Math.abs(value * 10000 - scaled) < 0.0000001, 'Коэффициент: не более четырёх знаков после запятой.');
  return scaled;
}

function futureForecast(forecast: Forecast | undefined, now: number): asserts forecast is Forecast {
  invariant(forecast && text(forecast.forecast_id), 'Прогноз не найден.');
  invariant(date(forecast.created_utc) && date(forecast.scheduled_start_utc), 'Некорректное время прогноза.');
  invariant(Date.parse(forecast.created_utc) <= now, 'Прогноз ещё не зарегистрирован.');
  invariant(now < Date.parse(forecast.scheduled_start_utc), 'После начала серии нельзя регистрировать коэффициенты и виртуальные ставки.');
  invariant(forecast.status == null || forecast.status === 'pending', 'Прогноз уже рассчитан.');
  invariant(typeof forecast.probability === 'number' && Number.isFinite(forecast.probability) && forecast.probability >= 0 && forecast.probability <= 1,
    'Некорректная вероятность прогноза.');
}

function httpsSource(value: unknown): value is string {
  if (!text(value, 2000)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch { return false; }
}

export function defaultPaperSettings(now = Date.now()): PaperSettings {
  validNow(now);
  return { initial_bankroll: 100, default_stake: 1, unit_label: 'ед.', created_utc: new Date(now).toISOString() };
}

export function validatePaperSettings(value: unknown, now = Date.now()): PaperSettings {
  validNow(now);
  invariant(object(value), 'Настройки должны быть объектом.');
  const initial = minorUnits(value.initial_bankroll, 'Начальный банк');
  const stake = minorUnits(value.default_stake, 'Стандартная ставка');
  invariant(value.unit_label == null || value.unit_label === 'ед.', 'Для теста используются виртуальные единицы.');
  const created = value.created_utc ?? new Date(now).toISOString();
  invariant(date(created) && Date.parse(created) <= now, 'Некорректное время создания виртуального банка.');
  return { initial_bankroll: units(initial), default_stake: units(stake), unit_label: 'ед.', created_utc: new Date(created).toISOString() };
}

/** recorded_utc is always server-owned; observed_utc is the real quote capture time. */
export function validateQuote(value: unknown, forecast: Forecast | undefined, now = Date.now()): OddsQuote {
  validNow(now);
  invariant(object(value), 'Коэффициент должен быть объектом.');
  futureForecast(forecast, now);
  invariant(text(value.quote_id) && value.forecast_id === forecast.forecast_id, 'Нужны корректные идентификаторы коэффициента и прогноза.');
  invariant(text(value.bookmaker, 120), 'Укажите источник коэффициента / букмекера.');
  const odds = oddsUnits(value.decimal_odds);
  invariant(date(value.observed_utc), 'Укажите время получения коэффициента с часовым поясом.');
  const observed = Date.parse(value.observed_utc);
  invariant(observed <= now, 'Время получения коэффициента не может быть в будущем.');
  // A book may have confirmed an unchanged price shortly before forecast creation.
  // Keep that real timestamp; recording and placing must happen after the forecast.
  invariant(httpsSource(value.source_url), 'Нужна HTTPS-ссылка на источник без логина и пароля.');
  invariant(value.entry_method === 'manual' || value.entry_method === 'agent', 'Некорректный способ записи коэффициента.');
  if (value.source_market_label != null) invariant(text(value.source_market_label, 500), 'Укажите название рынка длиной до 500 символов.');
  return {
    quote_id: value.quote_id, forecast_id: forecast.forecast_id, bookmaker: value.bookmaker.trim(), decimal_odds: odds / 10000,
    observed_utc: new Date(observed).toISOString(), recorded_utc: new Date(now).toISOString(),
    source_url: value.source_url.trim(), entry_method: value.entry_method,
    ...(value.source_market_label != null ? { source_market_label: String(value.source_market_label).trim() } : {}),
  };
}

/** The API must also check current observations, uniqueness, and available bank under its write lease. */
export function validateBet(value: unknown, quote: OddsQuote | undefined, forecast: Forecast | undefined, now = Date.now(), historical = false): PaperBet {
  validNow(now);
  invariant(object(value), 'Виртуальная ставка должна быть объектом.');
  futureForecast(forecast, now);
  invariant(quote, 'Коэффициент не найден.');
  invariant(text(value.bet_id) && value.forecast_id === forecast.forecast_id && quote.forecast_id === forecast.forecast_id && value.quote_id === quote.quote_id,
    'Ставка, коэффициент и прогноз должны относиться к одному событию.');
  invariant(date(quote.observed_utc) && date(quote.recorded_utc), 'Некорректное время коэффициента.');
  const observed = Date.parse(quote.observed_utc);
  invariant(Date.parse(quote.recorded_utc) >= Date.parse(forecast.created_utc) && observed <= Date.parse(quote.recorded_utc) && Date.parse(quote.recorded_utc) <= now,
    'Коэффициент должен быть зарегистрирован до ставки.');
  const maxAge = historical && value.policy_version == null ? 15 * 60_000 : QUOTE_MAX_AGE_MS;
  invariant(now - observed <= maxAge, 'Коэффициент устарел: для новой ставки нужна цена не старше 10 минут.');
  const stake = minorUnits(value.stake, 'Виртуальная ставка');
  const odds = oddsUnits(quote.decimal_odds);
  const policyFields: Partial<PaperBet> = {};
  if (value.policy_version != null) {
    invariant(value.policy_version === VALUE_POLICY_VERSION && object(value.policy_snapshot), 'Некорректная версия политики ставки.');
    const policy = valuePolicy({ PAPER_MIN_ODDS: String(value.policy_snapshot.min_odds), PAPER_MIN_EV: String(value.policy_snapshot.min_ev), PAPER_PROBABILITY_RESERVE: String(value.policy_snapshot.probability_reserve) });
    const evaluated = evaluateValue(forecast.probability, odds / 10000, policy);
    invariant(evaluated.eligible, evaluated.reason ?? 'Недостаточная ожидаемая доходность.');
    Object.assign(policyFields, { policy_version: VALUE_POLICY_VERSION, policy_snapshot: policy, expected_value_snapshot: evaluated.expected_value, conservative_ev_snapshot: evaluated.conservative_ev });
  }
  return {
    bet_id: value.bet_id, forecast_id: forecast.forecast_id, quote_id: quote.quote_id,
    stake: units(stake), placed_utc: new Date(now).toISOString(),
    probability_snapshot: forecast.probability, odds_snapshot: odds / 10000,
    ...policyFields,
  };
}

function unique<T>(rows: T[], key: (row: T) => string, name: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    invariant(text(id) && !map.has(id), `Повторяющийся или некорректный идентификатор: ${name}.`);
    map.set(id, row);
  }
  return map;
}

/** Half-up rounding is performed in integer arithmetic, once per winning payout. */
function cashflow(bet: PaperBet, status: Status): { payout: number | null; profit: number | null } {
  const stake = minorUnits(bet.stake, 'Виртуальная ставка');
  if (status === 'pending') return { payout: null, profit: null };
  if (status === 'void') return { payout: stake, profit: 0 };
  if (status === 'lost') return { payout: 0, profit: -stake };
  const product = stake * oddsUnits(bet.odds_snapshot);
  invariant(Number.isSafeInteger(product + 5000), 'Сумма выплаты превышает точность расчёта.');
  const payout = Math.floor((product + 5000) / 10000);
  return { payout, profit: payout - stake };
}

function marketSummary(market: Market, bets: PaperBetView[]): PaperMarketSummary {
  const rows = bets.filter(b => b.forecast.market === market);
  const decided = rows.filter(b => b.status === 'won' || b.status === 'lost');
  const stake = decided.reduce((sum, b) => sum + minorUnits(b.stake, 'Виртуальная ставка'), 0);
  const profit = rows.reduce((sum, b) => sum + Math.round((b.profit ?? 0) * 100), 0);
  return {
    market, registered: rows.length, pending: rows.filter(b => b.status === 'pending').length,
    settled: decided.length, won: rows.filter(b => b.status === 'won').length, lost: rows.filter(b => b.status === 'lost').length,
    void: rows.filter(b => b.status === 'void').length,
    total_staked: units(rows.reduce((sum, b) => sum + minorUnits(b.stake, 'Виртуальная ставка'), 0)),
    settled_staked: units(stake), profit: units(profit), roi: stake ? profit / stake : null,
  };
}

export function paperDashboard(settings: PaperSettings, quotes: OddsQuote[], bets: PaperBet[], forecasts: Forecast[], observations: Observation[], now = Date.now()): PaperDashboard {
  validNow(now);
  const checkedSettings = validatePaperSettings(settings, now);
  const forecastMap = unique(forecasts, f => f.forecast_id, 'прогноз');
  const quoteMap = unique(quotes, q => q.quote_id, 'коэффициент');
  unique(bets, b => b.bet_id, 'ставка');
  unique(bets, b => b.forecast_id, 'ставка на прогноз');
  unique(observations, o => o.observation_id, 'результат');
  for (const quote of quotes) {
    invariant(date(quote.recorded_utc), 'Некорректное время регистрации коэффициента.');
    validateQuote(quote, forecastMap.get(quote.forecast_id), Date.parse(quote.recorded_utc));
  }
  for (const bet of bets) {
    invariant(date(bet.placed_utc), 'Некорректное время ставки.');
    invariant(Date.parse(bet.placed_utc) >= Date.parse(settings.created_utc), 'Ставка не может предшествовать созданию виртуального банка.');
    const original = forecastMap.get(bet.forecast_id);
    invariant(original, 'Прогноз ставки не найден.');
    const checked = validateBet(bet, quoteMap.get(bet.quote_id), checkedBetSnapshot(original,bet.analysis_snapshot,Date.parse(bet.placed_utc)), Date.parse(bet.placed_utc), true);
    invariant(checked.probability_snapshot === bet.probability_snapshot && checked.odds_snapshot === bet.odds_snapshot, 'Снимок вероятности или коэффициента ставки изменён.');
  }
  const activeBets = bets.filter(b => Date.parse(b.placed_utc) <= now);
  const recorded = observations.filter(o => {
    invariant(date(o.recorded_utc), 'Некорректное время результата.');
    return Date.parse(o.recorded_utc) <= now;
  }).sort((a, b) => Date.parse(a.recorded_utc) - Date.parse(b.recorded_utc));
  for (const bet of activeBets) {
    const forecast = forecastMap.get(bet.forecast_id)!;
    invariant(!recorded.some(o => o.fixture_id === forecast.fixture_id && Date.parse(o.recorded_utc) < Date.parse(bet.placed_utc)),
      'Результат не может предшествовать регистрации ставки.');
  }
  // A correction must be recorded after its predecessor; same-time additions are grouped atomically.
  const observationsById = new Map(recorded.map(o => [o.observation_id, o]));
  for (const o of recorded) if (o.supersedes) {
    const previous = observationsById.get(o.supersedes);
    invariant(previous && previous.fixture_id === o.fixture_id && Date.parse(previous.recorded_utc) <= Date.parse(o.recorded_utc), 'Нарушена хронология исправлений результатов.');
  }
  const initial = minorUnits(settings.initial_bankroll, 'Начальный банк');
  let peak = initial, realized = 0, maxDrawdown = 0, maxDrawdownPct = 0;
  const curve: PaperCurvePoint[] = activeBets.length ? [{ at: checkedSettings.created_utc, bankroll: units(initial), profit: 0, delta: 0, drawdown: 0, drawdown_pct: 0 }] : [];
  const previousStatuses = new Map<string, Status>();
  const settlementTimes = new Map<string, string>();
  const relevantObservationIds = new Map<string, string>();
  let latest = new Map<string, Observation>();
  const included: Observation[] = [];
  for (let index = 0; index < recorded.length;) {
    const at = Date.parse(recorded[index].recorded_utc);
    while (index < recorded.length && Date.parse(recorded[index].recorded_utc) === at) included.push(recorded[index++]);
    latest = latestObservations(included);
    let nextRealized = 0, changed = false;
    for (const bet of activeBets) {
      if (Date.parse(bet.placed_utc) > at) continue;
      const forecast = forecastMap.get(bet.forecast_id)!;
      const observation = latest.get(forecast.fixture_id);
      if (observation) invariant(Date.parse(observation.recorded_utc) >= Date.parse(bet.placed_utc), 'Результат не может предшествовать регистрации ставки.');
      const status = settle(forecast, observation).status;
      const previous = previousStatuses.get(bet.bet_id) ?? 'pending';
      if (status !== previous) {
        changed = true;
        if (status === 'pending') { settlementTimes.delete(bet.bet_id); relevantObservationIds.delete(bet.bet_id); }
        else {
          settlementTimes.set(bet.bet_id, new Date(at).toISOString());
          if (observation) relevantObservationIds.set(bet.bet_id, observation.observation_id);
        }
      }
      previousStatuses.set(bet.bet_id, status);
      nextRealized += cashflow(bet, status).profit ?? 0;
    }
    invariant(Number.isSafeInteger(nextRealized + initial), 'Банк превышает точность расчёта.');
    if (changed) {
      const equity = initial + nextRealized;
      peak = Math.max(peak, equity);
      const drawdown = peak - equity;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      maxDrawdownPct = Math.max(maxDrawdownPct, drawdown / peak);
      curve.push({ at: new Date(at).toISOString(), bankroll: units(equity), profit: units(nextRealized), delta: units(nextRealized - realized), drawdown: units(drawdown), drawdown_pct: drawdown / peak });
    }
    realized = nextRealized;
  }
  const views: PaperBetView[] = activeBets.map(bet => {
    const forecast = checkedBetSnapshot(forecastMap.get(bet.forecast_id)!,bet.analysis_snapshot,Date.parse(bet.placed_utc));
    const quote = quoteMap.get(bet.quote_id)!;
    const observation = latest.get(forecast.fixture_id);
    if (observation) invariant(Date.parse(observation.recorded_utc) >= Date.parse(bet.placed_utc), 'Результат не может предшествовать регистрации ставки.');
    const status = settle(forecast, observation).status;
    const cash = cashflow(bet, status);
    return { ...bet, forecast, quote, status,
      payout: cash.payout == null ? null : units(cash.payout), profit: cash.profit == null ? null : units(cash.profit),
      settled_utc: settlementTimes.get(bet.bet_id) ?? null,
      observation_id: relevantObservationIds.get(bet.bet_id) ?? null,
      expected_value: bet.probability_snapshot * bet.odds_snapshot - 1,
      expected_profit: roundMoney(bet.stake * (bet.probability_snapshot * bet.odds_snapshot - 1)),
    };
  });
  const decided = views.filter(b => b.status === 'won' || b.status === 'lost');
  const stakeSum = (rows: PaperBetView[]) => rows.reduce((sum, b) => sum + minorUnits(b.stake, 'Виртуальная ставка'), 0);
  const settledStakes = stakeSum(decided);
  const openStakes = stakeSum(views.filter(b => b.status === 'pending'));
  const bankroll = initial + realized;
  const currentDrawdown = peak - bankroll;
  const betForecastIds = new Set(activeBets.map(b => b.forecast_id));
  const notes = [
    'Только виртуальные ставки. Коэффициент сохраняется с источником и временем до начала серии; автоматического потока котировок нет.',
    'ROI = чистая прибыль / сумма рассчитанных ставок (выигрыш и проигрыш). Возвраты и открытые ставки исключены из знаменателя.',
    'Доходность банка = прибыль / начальный банк. Просадка считается от предыдущего максимума банка по времени регистрации результатов, без оценки открытых позиций.',
    'Исправления результатов меняют банк в момент записи исправления; прежние точки графика сохраняются. Ожидаемая прибыль — оценка модели, а не полученный результат.',
  ];
  if (bankroll - openStakes < 0) notes.push('После исправления результата доступный банк отрицательный. Новые виртуальные ставки недоступны до восстановления средств.');
  return {
    settings: { ...checkedSettings, locked: bets.length > 0 },
    metrics: {
      registered: views.length, distinct_series: new Set(views.map(b => b.forecast.fixture_id)).size,
      pending: views.filter(b => b.status === 'pending').length, settled: decided.length,
      won: views.filter(b => b.status === 'won').length, lost: views.filter(b => b.status === 'lost').length, void: views.filter(b => b.status === 'void').length,
      total_staked: units(stakeSum(views)), settled_staked: units(settledStakes), refunded_stake: units(stakeSum(views.filter(b => b.status === 'void'))),
      open_stakes: units(openStakes), total_returned: units(views.reduce((sum, b) => sum + Math.round((b.payout ?? 0) * 100), 0)),
      profit: units(realized), roi: settledStakes ? realized / settledStakes : null, bankroll_return: realized / initial,
      initial_bankroll: units(initial), bankroll: units(bankroll), available_bankroll: units(bankroll - openStakes),
      max_drawdown: units(maxDrawdown), max_drawdown_pct: maxDrawdownPct,
      current_drawdown: units(currentDrawdown), current_drawdown_pct: currentDrawdown / peak,
      mean_odds: views.length ? views.reduce((sum, b) => sum + b.odds_snapshot, 0) / views.length : null,
      expected_profit: roundMoney(views.reduce((sum, b) => sum + b.stake * (b.probability_snapshot * b.odds_snapshot - 1), 0)),
    },
    quotes: quotes.filter(q => Date.parse(q.recorded_utc) <= now).sort((a, b) => Date.parse(b.recorded_utc) - Date.parse(a.recorded_utc)),
    bets: views.sort((a, b) => Date.parse(b.placed_utc) - Date.parse(a.placed_utc)),
    eligible_forecasts: forecasts.filter(f => Date.parse(f.created_utc) <= now && Date.parse(f.scheduled_start_utc) > now && !betForecastIds.has(f.forecast_id) && settle(f, latest.get(f.fixture_id)).status === 'pending')
      .sort((a, b) => Date.parse(a.scheduled_start_utc) - Date.parse(b.scheduled_start_utc) || Number(b.selected) - Number(a.selected)),
    curve, by_market: MARKETS.map(market => marketSummary(market, views)), notes,
  };
}
