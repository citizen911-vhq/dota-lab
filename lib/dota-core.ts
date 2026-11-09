import type { Dashboard, Forecast, ForecastView, Journal, Metrics, Observation, Status } from './dota-types';

export class DataError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DataError(message);
}
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const validDate = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
const validId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200;
const integer = (x: unknown, max: number) => Number.isInteger(x) && Number(x) >= 0 && Number(x) <= max;

export function validSource(x: unknown): boolean {
  try { const u = new URL(String(x)); return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password; } catch { return false; }
}
export function validateForecast(value: unknown): Forecast {
  invariant(isObject(value), 'Прогноз должен быть объектом.');
  for (const key of ['forecast_id', 'fixture_id', 'team_a', 'team_b', 'model_version', 'selection_version', 'label']) invariant(validId(value[key]), 'Некорректное поле прогноза: ' + key);
  invariant(validDate(value.created_utc) && validDate(value.scheduled_start_utc) && validDate(value.data_cutoff_utc), 'Укажите время регистрации, начала и среза данных.');
  invariant(Date.parse(value.created_utc) < Date.parse(value.scheduled_start_utc), 'Прогноз должен быть зарегистрирован до начала серии.');
  invariant(Date.parse(value.data_cutoff_utc) <= Date.parse(value.created_utc), 'Срез данных не может быть позже регистрации.');
  invariant(typeof value.probability === 'number' && Number.isFinite(value.probability) && value.probability >= 0 && value.probability <= 1, 'Вероятность должна быть от 0 до 1.');
  invariant(typeof value.selected === 'boolean', 'Укажите selected для прогноза.');
  invariant(integer(value.n_maps_a, 10000) && integer(value.n_maps_b, 10000) && Number(value.n_maps_a) > 0 && Number(value.n_maps_b) > 0, 'Укажите размер обеих выборок.');
  invariant(typeof value.cohort_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.cohort_date), 'Некорректная дата прогноза.');
  const market = value.market;
  invariant(['map_handicap', 'series_winner', 'map_kills', 'map_duration'].includes(String(market)), 'Неизвестный тип прогноза.');
  if (market === 'series_winner' || market === 'map_handicap') {
    invariant(value.selection === 'a' || value.selection === 'b', 'Выберите команду a или b.');
    if (market === 'map_handicap') invariant(value.threshold === 1.5 || value.threshold === -1.5, 'Поддерживаются форы ±1,5 карты.');
  } else {
    invariant(value.map_number === 1, 'В этом эксперименте тоталы рассчитываются для первой карты.');
    invariant(typeof value.threshold === 'number' && value.threshold > 0 && value.threshold < 86400, 'Некорректный порог тотала.');
    invariant(market === 'map_duration' ? ['over_or_equal', 'under'].includes(String(value.selection)) : ['over', 'under'].includes(String(value.selection)), 'Неизвестное направление тотала.');
    if (market === 'map_kills') invariant(value.threshold % 1 === 0.5, 'Тотал убийств должен быть полуцелым.');
  }
  return value as unknown as Forecast;
}

export function validateObservation(value: unknown, fixtures: Map<string, Forecast>, now = Date.now()): Observation {
  invariant(isObject(value), 'Результат должен быть объектом.');
  invariant(validId(value.observation_id) && validId(value.fixture_id), 'Нужны идентификаторы результата и серии.');
  const fixture = fixtures.get(value.fixture_id);
  invariant(fixture, 'Серия не найдена в журнале.');
  invariant(validDate(value.recorded_utc), 'Некорректное время результата.');
  invariant(Date.parse(value.recorded_utc) <= now + 300000, 'Время результата не может быть в будущем.');
  invariant(Date.parse(value.recorded_utc) >= Date.parse(fixture.scheduled_start_utc), 'Нельзя записать результат до начала серии.');
  invariant(Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 20 && value.sources.every(validSource), 'Добавьте хотя бы одну корректную ссылку на источник результата.');
  if (value.supersedes != null) invariant(validId(value.supersedes), 'Некорректный supersedes.');
  if (value.note != null) invariant(typeof value.note === 'string' && value.note.length <= 3000, 'Слишком длинное примечание.');
  if (value.series_void != null) invariant(typeof value.series_void === 'boolean', 'Некорректная отмена серии.');
  if (value.map1_void != null) invariant(typeof value.map1_void === 'boolean', 'Некорректная отмена карты.');
  if (value.series_score != null) {
    invariant(Array.isArray(value.series_score) && ['[2,0]', '[2,1]', '[1,2]', '[0,2]'].includes(JSON.stringify(value.series_score)), 'Для завершённой BO3 допустимы 2:0, 2:1, 1:2 и 0:2.');
    invariant(!value.series_void, 'Нельзя одновременно указать счёт и отмену серии.');
  }
  if (value.map1 != null) {
    invariant(isObject(value.map1), 'Некорректная первая карта.');
    invariant(!value.map1_void, 'Нельзя одновременно указать карту и её отмену.');
    const m = value.map1;
    for (const k of ['kills_a', 'kills_b']) if (m[k] != null) invariant(integer(m[k], 500), 'Убийства должны быть целым числом от 0 до 500.');
    invariant((m.kills_a == null) === (m.kills_b == null), 'Укажите убийства обеих команд.');
    if (m.duration_seconds != null) invariant(integer(m.duration_seconds, 86400) && Number(m.duration_seconds) > 0, 'Длительность должна быть от 1 до 86400 секунд.');
    invariant(m.kills_a != null || m.duration_seconds != null, 'Укажите счёт убийств или длительность карты.');
  }
  invariant(value.series_score != null || value.map1 != null || value.series_void || value.map1_void, 'Укажите хотя бы один фактический результат.');
  return value as unknown as Observation;
}

export function latestObservations(observations: Observation[]): Map<string, Observation> {
  const latest = new Map<string, Observation>();
  const pending = [...observations];
  while (pending.length) {
    const index = pending.findIndex(o => (!o.supersedes && !latest.has(o.fixture_id)) || latest.get(o.fixture_id)?.observation_id === o.supersedes);
    invariant(index >= 0, 'Нарушена последовательность исправлений результатов.');
    const [o] = pending.splice(index, 1);
    const previous = latest.get(o.fixture_id);
    // An observation may add the series result after the first map is known.
    // Missing fields preserve earlier facts; explicit null/void clears them.
    const merged = {...previous, ...o} as Observation;
    if (o.map1 && previous?.map1) merged.map1 = {...previous.map1, ...o.map1};
    if (o.series_score) merged.series_void = false;
    if (o.map1) merged.map1_void = false;
    if (o.series_void) merged.series_score = null;
    if (o.map1_void) merged.map1 = null;
    latest.set(o.fixture_id, merged);
  }
  return latest;
}

export function settle(f: Forecast, o?: Observation): {outcome: number | null; status: Status} {
  if (!o) return {outcome: null, status: 'pending'};
  let won: boolean;
  if (f.market === 'map_handicap' || f.market === 'series_winner') {
    if (o.series_void) return {outcome: null, status: 'void'};
    if (!o.series_score) return {outcome: null, status: 'pending'};
    let [a, b] = o.series_score; if (f.selection === 'b') [a, b] = [b, a];
    won = f.market === 'series_winner' ? a > b : a + Number(f.threshold) > b;
  } else {
    if (o.map1_void) return {outcome: null, status: 'void'};
    if (!o.map1) return {outcome: null, status: 'pending'};
    if (f.market === 'map_duration') {
      if (o.map1.duration_seconds == null) return {outcome: null, status: 'pending'};
      won = f.selection === 'under' ? o.map1.duration_seconds < Number(f.threshold) : o.map1.duration_seconds >= Number(f.threshold);
    } else {
      if (o.map1.kills_a == null || o.map1.kills_b == null) return {outcome: null, status: 'pending'};
      const kills = o.map1.kills_a + o.map1.kills_b;
      won = f.selection === 'under' ? kills < Number(f.threshold) : kills > Number(f.threshold);
    }
  }
  return {outcome: Number(won), status: won ? 'won' : 'lost'};
}

export function metrics(rows: ForecastView[]): Metrics {
  const settled = rows.filter(r => r.outcome != null);
  const passed = settled.reduce((a, r) => a + Number(r.outcome), 0);
  return {registered: rows.length, distinct_series: new Set(rows.map(r => r.fixture_id)).size,
    pending: rows.filter(r => r.status === 'pending').length, settled: settled.length,
    passed, failed: settled.length - passed, void: rows.filter(r => r.status === 'void').length,
    hit_rate: settled.length ? passed / settled.length : null,
    brier: settled.length ? settled.reduce((a, r) => a + Number(r.brier), 0) / settled.length : null,
    mean_probability_settled: settled.length ? settled.reduce((a, r) => a + r.probability, 0) / settled.length : null,
    sum_predicted_passes: rows.reduce((a, r) => a + r.probability, 0),
    sum_predicted_settled: settled.reduce((a, r) => a + r.probability, 0)};
}

export function supplementForecasts(journal: Journal): Forecast[] {
  const s = journal.durationSupplement;
  if (!s || !isObject(s.additional_candidate) || !Array.isArray(s.series)) return [];
  const c = s.additional_candidate;
  const base = journal.forecasts.find(f => f.team_a === c.team_a && f.team_b === c.team_b && f.market === 'map_duration');
  if (!base || typeof c.probability !== 'number' || typeof c.minutes !== 'number') return [];
  return [{...base, forecast_id: base.fixture_id + '-supplement-duration-' + c.minutes,
    created_utc: typeof s.created_utc === 'string' ? s.created_utc : base.created_utc,
    threshold: c.minutes * 60, selection: 'under', probability: c.probability,
    label: `Карта 1: длительность <${c.minutes}:00`, selected: false,
    selection_version: 'duration-supplement-v1', supplement: true}];
}

export function dashboard(journal: Journal, storage: 'database' | 'seed', updated: string | null): Dashboard {
  const latest = latestObservations(journal.observations);
  const decorate = (f: Forecast): ForecastView => {
    const observation = latest.get(f.fixture_id) ?? null;
    const r = settle(f, observation ?? undefined);
    return {...f, ...r, status_label: {pending: 'Ожидает', won: 'Прошёл', lost: 'Не прошёл', void: 'Не разыграно'}[r.status],
      brier: r.outcome == null ? null : (f.probability - r.outcome) ** 2,
      observation, sources: observation?.sources ?? f.sources ?? []};
  };
  const forecasts = journal.forecasts.map(decorate);
  const selected = forecasts.filter(f => f.selected).sort((a,b) => a.scheduled_start_utc.localeCompare(b.scheduled_start_utc) || a.fixture_id.localeCompare(b.fixture_id) || Number(a.selection_rank)-Number(b.selection_rank));
  const minuteByFixture = new Map<string, ForecastView>();
  for (const f of forecasts.filter(r => r.market === 'map_duration' && r.threshold === 2460)) {
    if (!minuteByFixture.has(f.fixture_id) || minuteByFixture.get(f.fixture_id)!.probability < f.probability) minuteByFixture.set(f.fixture_id, f);
  }
  const minutes = [...minuteByFixture.values(), ...supplementForecasts(journal).map(decorate)];
  const fixtures = [...new Map(forecasts.map(f => [f.fixture_id, {fixture_id: f.fixture_id, team_a: f.team_a, team_b: f.team_b,
    scheduled_start_utc: f.scheduled_start_utc, n_maps_a: f.n_maps_a, n_maps_b: f.n_maps_b,
    observation: latest.get(f.fixture_id) ?? null}])).values()].sort((a,b) => a.scheduled_start_utc.localeCompare(b.scheduled_start_utc));
  const byMarket = Object.fromEntries(['map_handicap','series_winner','map_kills','map_duration'].map(k => [k, metrics(selected.filter(f => f.market === k))]));
  const daily = [...new Set(selected.map(f => f.cohort_date))].sort().map(date => {
    const m = metrics(selected.filter(f => f.cohort_date === date));
    return {date, registered:m.registered,settled:m.settled,passed:m.passed,hit_rate:m.hit_rate,mean_probability:m.mean_probability_settled};
  });
  const calibration = [0, .5, .6, .7, .8, .9].map((from,i,arr) => {
    const to = arr[i+1] ?? 1; const rows = selected.filter(f => f.outcome != null && f.probability >= from && (f.probability < to || to === 1 && f.probability === 1));
    const m = metrics(rows); return {from,to,count:m.settled,mean_probability:m.mean_probability_settled,hit_rate:m.hit_rate};
  });
  return {generated_at:new Date().toISOString(),data_updated_at:updated,storage,
    forecasts_count:journal.forecasts.length,observations_count:journal.observations.length,
    metadata:journal.metadata,protocol:journal.protocol,forecasts,selected_forecasts:selected,
    minute_forecasts:minutes,fixtures,teams:journal.teams,summary:{selected:metrics(selected),minutes:metrics(minutes),by_market:byMarket},daily,calibration};
}

function parseJournal(value: unknown): Journal {
  invariant(!!value && typeof value === 'object' && !Array.isArray(value), 'Загрузите объект журнала JSON.');
  const x = value as Partial<Journal>;
  invariant(Array.isArray(x.forecasts) && x.forecasts.length <= 10000, 'Нужен массив forecasts, не более 10000 записей за импорт.');
  invariant(Array.isArray(x.observations) && x.observations.length <= 10000, 'Нужен массив observations.');
  invariant(Array.isArray(x.teams) && x.teams.length <= 500, 'Нужен список teams.');
  invariant(x.metadata && typeof x.metadata === 'object' && x.protocol && typeof x.protocol === 'object', 'Нужны metadata и protocol.');
  invariant(!Array.isArray(x.metadata) && !Array.isArray(x.protocol), 'Некорректная метаинформация.');
  for (const f of x.forecasts) validateForecast(f);
  invariant(new Set(x.forecasts.map(f => f.forecast_id)).size === x.forecasts.length, 'В импорте повторяются ID прогнозов.');
  return x as Journal;
}

// Pure preflight lets tests exercise the same conflict and correction rules used
// by D1. Existing rows are never removed by a smaller incoming snapshot.
export function mergeJournal(current: Journal, incomingValue: unknown, now = Date.now(), bootstrap?: Journal): {journal: Journal; newForecasts: Forecast[]; newObservations: Observation[]} {
  const incoming = parseJournal(incomingValue);
  const forecasts = new Map(current.forecasts.map(f => [f.forecast_id, f]));
  const newForecasts: Forecast[] = [];
  for (const f of incoming.forecasts) {
    const old = forecasts.get(f.forecast_id);
    if (old && canonical(old) !== canonical(f)) throw new DataError('Зарегистрированный прогноз нельзя изменить: ' + f.forecast_id, 409);
    if (!old) {
      const allowedBootstrap = bootstrap?.forecasts.find(r => r.forecast_id === f.forecast_id);
      invariant(Date.parse(f.scheduled_start_utc) > now || (allowedBootstrap && canonical(allowedBootstrap) === canonical(f)), 'Новый прогноз нельзя импортировать после начала серии: ' + f.forecast_id);
      forecasts.set(f.forecast_id, f); newForecasts.push(f);
    }
  }
  const fixtures = new Map<string, Forecast>();
  for (const f of forecasts.values()) {
    const old = fixtures.get(f.fixture_id);
    invariant(!old || old.team_a === f.team_a && old.team_b === f.team_b && old.scheduled_start_utc === f.scheduled_start_utc, 'Данные одной серии должны совпадать во всех прогнозах.');
    fixtures.set(f.fixture_id,f);
  }
  if (current.durationSupplement && incoming.durationSupplement && canonical(current.durationSupplement) !== canonical(incoming.durationSupplement)) {
    throw new DataError('Зарегистрированный дополнительный прогноз по времени нельзя изменить.',409);
  }
  const durationSupplement = incoming.durationSupplement ?? current.durationSupplement ?? null;
  if (!current.durationSupplement && durationSupplement) {
    invariant(validDate(durationSupplement.created_utc), 'Нужно время регистрации дополнительного прогноза.');
    const rows = Array.isArray(durationSupplement.series) ? durationSupplement.series : [];
    for (const row of rows) {
      invariant(isObject(row) && validId(row.fixture_id) && fixtures.has(row.fixture_id), 'Серия дополнительного прогноза не найдена.');
      const fixture = fixtures.get(row.fixture_id)!;
      invariant(row.team_a === fixture.team_a && row.team_b === fixture.team_b && row.scheduled_start_utc === fixture.scheduled_start_utc, 'Данные серии в дополнительном прогнозе не совпадают.');
      invariant(Date.parse(durationSupplement.created_utc) < Date.parse(fixture.scheduled_start_utc), 'Дополнительный прогноз зарегистрирован после начала.');
    }
    if (durationSupplement.additional_candidate != null) {
      const c = durationSupplement.additional_candidate;
      invariant(isObject(c) && typeof c.probability === 'number' && c.probability >= 0 && c.probability <= 1 && typeof c.minutes === 'number' && c.minutes > 0 && c.minutes < 1440 && c.direction === 'under', 'Некорректный дополнительный прогноз времени.');
    }
    const allFuture = rows.length > 0 && rows.every(r => !!r && typeof r === 'object' && Date.parse(String((r as Record<string,unknown>).scheduled_start_utc)) > now);
    invariant(allFuture || (bootstrap?.durationSupplement && canonical(durationSupplement) === canonical(bootstrap.durationSupplement)), 'Дополнительные прогнозы по времени нельзя создавать после начала серии.');
  }
  const observations = new Map(current.observations.map(o => [o.observation_id,o]));
  const newObservations: Observation[] = [];
  for (const value of incoming.observations) {
    const o = validateObservation(value, fixtures, now);
    const old = observations.get(o.observation_id);
    if (old && canonical(old) !== canonical(o)) throw new DataError('Исходный результат нельзя переписать; создайте исправление: ' + o.observation_id, 409);
    if (!old) { observations.set(o.observation_id,o); newObservations.push(o); }
  }
  // Validate the full correction graph, regardless of input order.
  latestObservations([...observations.values()]);
  for (const o of newObservations) {
    if (o.supersedes) {
      const previous = observations.get(o.supersedes);
      invariant(previous && previous.fixture_id === o.fixture_id, 'Исправление должно ссылаться на предыдущий результат той же серии.');
      invariant(Date.parse(o.recorded_utc) >= Date.parse(previous.recorded_utc), 'Исправление не может предшествовать исходной записи.');
    }
  }
  return {journal:{...incoming,durationSupplement,forecasts:[...forecasts.values()],observations:[...observations.values()]},newForecasts,newObservations};
}

