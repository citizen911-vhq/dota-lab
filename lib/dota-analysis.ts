import type { Forecast, Market } from './dota-types';
import type { AnalysisHistory, AnalysisMap, AnalysisSeries, FixtureInput, ForecastBuild, TeamSample, TrackedTeam } from './dota-analysis-types';

export const TRACKED_TEAMS: TrackedTeam[] = [
  {id:'55',name:'Power Rangers',reference_roster:[295697470,194979527,294135421,363739653,1675898897],scope_note:'История тега; состав по всем 30 картам не подтверждён как неизменный.'},
  {id:'10020555',name:'PlayTime',reference_roster:[9403474,140297552,164962869,104334048,50580004],scope_note:'Только подтверждённый европейский состав Shad / No!ob / Xibbe / yamich / Kidaro. Исторический тег и другие составы исключены.'},
  {id:'10242397',name:'Xipto Esports',reference_roster:[375507918,181716137,156328257,193815691,101259972],scope_note:'История тега; непрерывность состава по всей выборке не подтверждена.'},
  {id:'10252232',name:'Zenith',reference_roster:[250547284,248388120,903184860,164530809,135607261],scope_note:'История тега; непрерывность состава по всей выборке не подтверждена.'},
  {id:'5014799',name:'Nemiga Gaming',reference_roster:[1220993352,127530803,383788462,114162163,120840516],scope_note:'История тега; непрерывность состава по всей выборке не подтверждена.'},
  {id:'10212329',name:'Team Synapse',reference_roster:[968545762,163061132,860264647,123717676,163152486],scope_note:'История тега; в исходном аудите состав подтверждён на 22 из 30 карт.'},
  {id:'10331884',name:'Froglings',reference_roster:[81306398,126212866,152455523,262476000,326327879],scope_note:'Только текущий тег Froglings; история LEGION исключена. Исходная выборка — пять карт.'},
  {id:'10271553',name:'potn9ki',reference_roster:[1074436691,1302599438,993824087,297380131,296702734],scope_note:'История тега; спорный административный результат с HellNight исключён из статистики BO3.'},
];

export const ANALYSIS_LIMITATION = 'Экспериментальная базовая оценка, ещё не проверенная на будущих матчах. До 30 последних доступных подтверждённых карт; полнота источника не гарантирована. Не учтены сила соперников, драфт, сторона, патч и номер карты. Тоталы относятся к первой карте, обучающая выборка включает карты всех номеров. Состав на будущий матч не гарантирован.';
export const EXPERIMENT_FIRST_DAY = '2026-11-08';
export const EXPERIMENT_LAST_DAY = '2026-12-07';
const validScores = new Set(['2:0','2:1','1:2','0:2']);
const rosterKey = (players: number[]) => [...players].sort((a,b)=>a-b).join(',');
const hasRoster = (players?: number[]) => !!players && players.length === 5 && new Set(players).size === 5 && players.every(n => Number.isSafeInteger(n) && n > 0);
const knownBy = (at: string | undefined, cutoffMs: number) => !at || (Number.isFinite(Date.parse(at)) && Date.parse(at) <= cutoffMs);
const validUrl = (value: string) => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
const numericId = (value: string) => /^\d+$/.test(value);

function validMap(m: AnalysisMap): boolean {
  const opponentKnown = numericId(m.opponent_team_id) || (m.audit_origin === 'baseline-2026-11-08' && m.opponent_team_id === '' && !!m.opponent);
  return numericId(m.match_id) && numericId(m.team_id) && opponentKnown && m.team_id !== m.opponent_team_id
    && Number.isSafeInteger(m.start_time) && m.start_time > 0
    && Number.isInteger(m.duration_seconds) && m.duration_seconds > 0 && m.duration_seconds <= 86400
    && Number.isInteger(m.team_kills) && m.team_kills >= 0 && m.team_kills <= 500
    && Number.isInteger(m.opponent_kills) && m.opponent_kills >= 0 && m.opponent_kills <= 500
    && typeof m.win === 'boolean' && Array.isArray(m.sources) && m.sources.length > 0 && m.sources.every(validUrl);
}

function mapFacts(m: AnalysisMap): string {
  // Discovery endpoints may attach different source URLs to the same facts.
  return JSON.stringify([m.team_id,m.opponent_team_id,m.start_time,m.duration_seconds,m.team_kills,m.opponent_kills,m.win]);
}

export function sampleTeam(history: AnalysisHistory, teamId: string, cutoffMs: number): TeamSample {
  const definition = TRACKED_TEAMS.find(t=>t.id === teamId);
  const all = history.maps.filter(m=>m.team_id === teamId);
  const byId = new Map<string, AnalysisMap>();
  const conflicts = new Set<string>();
  for (const m of all) {
    if (!validMap(m) || !knownBy(m.verified_at,cutoffMs) || (m.start_time + m.duration_seconds) * 1000 > cutoffMs) continue;
    const previous = byId.get(m.match_id);
    if (previous && mapFacts(previous) !== mapFacts(m)) conflicts.add(m.match_id);
    // A source with player IDs enriches the same map without duplicating it.
    if (!previous || !hasRoster(previous.players) && hasRoster(m.players)) byId.set(m.match_id,m);
  }
  const completed = [...byId.values()].filter(m=>!conflicts.has(m.match_id)).sort((a,b)=>b.start_time-a.start_time || b.match_id.localeCompare(a.match_id));
  const reference = definition?.reference_roster ?? [];
  const latestKnownRoster = completed.find(m=>hasRoster(m.players));
  const rosterChanged = reference.length === 5 && !!latestKnownRoster && rosterKey(latestKnownRoster.players!) !== rosterKey(reference);
  const eligible = completed.filter(m=> {
    if (m.forecast_sample === false) return false;
    if (teamId !== '10020555') return true;
    if (m.audit_origin === 'baseline-2026-11-08' && m.forecast_sample === true) return true;
    return hasRoster(m.players) && rosterKey(m.players!) === rosterKey(reference);
  });
  const maps = eligible.slice(0,30);
  const mapIds = new Set(maps.map(m=>m.match_id));
  const seriesKeys = new Set(maps.map(m=>m.series_key).filter(Boolean));
  const seriesByKey = new Map<string,AnalysisSeries>();
  const conflictingSeries = new Set<string>();
  for (const s of history.series) {
    if (s.team_id !== teamId || !s.complete_bo3 || s.forecast_sample === false || s.excluded_reason || !validScores.has(`${s.score_team}:${s.score_opponent}`)) continue;
    if (!knownBy(s.verified_at,cutoffMs) || (s.end_time ?? s.start_time) * 1000 > cutoffMs || s.start_time * 1000 >= cutoffMs) continue;
    if (!s.sources.length || !s.sources.every(validUrl)) continue;
    if (!seriesKeys.has(s.series_key) && !s.map_ids.some(id=>mapIds.has(id))) continue;
    const old = seriesByKey.get(s.series_key);
    if (old && (old.score_team !== s.score_team || old.score_opponent !== s.score_opponent || old.opponent_team_id !== s.opponent_team_id)) conflictingSeries.add(s.series_key);
    if (!old) seriesByKey.set(s.series_key,s);
  }
  const series = [...seriesByKey.values()].filter(s=>!conflictingSeries.has(s.series_key)).sort((a,b)=>b.start_time-a.start_time || a.series_key.localeCompare(b.series_key));
  const notes = [definition?.scope_note ?? 'Неизвестная команда.', 'Выборка доступных карт, а не гарантия полноты последних 30 игр.'];
  if (maps.length < 30) notes.push(`Доступно ${maps.length} карт из целевых 30.`);
  if (conflicts.size) notes.push(`Исключено карт с противоречивыми фактами: ${conflicts.size}.`);
  if (rosterChanged) notes.push('Последний известный состав отличается от исходного; новые прогнозы остановлены до проверки состава.');
  return {team_id:teamId,team:definition?.name ?? teamId,maps,series,excluded_maps:all.length-maps.length,conflicting_map_ids:[...conflicts].sort(),roster_changed:rosterChanged,notes};
}

export function fixtureKey(fixture: FixtureInput): string {
  if (fixture.fixture_id) return fixture.fixture_id;
  // Time + canonical IDs form a stable, orientation-independent identity.
  const pair = [fixture.team_a_id,fixture.team_b_id].sort().join('-');
  return `auto-${new Date(fixture.scheduled_start_utc).toISOString().replace(/[^0-9]/g,'')}-${pair}`;
}

export function buildForecasts(history: AnalysisHistory, fixture: FixtureInput, nowMs = Date.now()): ForecastBuild {
  const skip = (reason: string, samples: ForecastBuild['samples'] = null): ForecastBuild => ({forecasts:[],skip_reason:reason,samples});
  const startMs = Date.parse(fixture.scheduled_start_utc);
  const verifiedMs = Date.parse(fixture.verified_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs) || !Number.isFinite(verifiedMs)) return skip('Некорректное время матча или проверки источника.');
  if (startMs <= nowMs) return skip('Матч уже начался: прогноз задним числом запрещён.');
  if (verifiedMs > nowMs || nowMs - verifiedMs > 24 * 3600000) return skip('Расписание не подтверждено за последние 24 часа.');
  if (fixture.best_of !== 3 || fixture.status !== 'scheduled') return skip('Для прогноза нужна подтверждённая будущая серия BO3.');
  if (!validUrl(fixture.source_url)) return skip('Нет корректной HTTPS-ссылки на расписание.');
  const day = new Date(startMs).toISOString().slice(0,10);
  if (day < EXPERIMENT_FIRST_DAY || day > EXPERIMENT_LAST_DAY) return skip('Матч за пределами 30-дневного эксперимента.');
  if (fixture.team_a_id === fixture.team_b_id || !TRACKED_TEAMS.some(t=>t.id === fixture.team_a_id) || !TRACKED_TEAMS.some(t=>t.id === fixture.team_b_id)) return skip('Обе команды должны иметь подтверждённые ID из списка эксперимента.');
  const a = sampleTeam(history,fixture.team_a_id,Math.min(nowMs,startMs));
  const b = sampleTeam(history,fixture.team_b_id,Math.min(nowMs,startMs));
  const samples = {a,b};
  if (a.roster_changed || b.roster_changed) return skip('Изменился последний известный состав; нужна проверка новой выборки.',samples);
  if (!a.maps.length || !b.maps.length) return skip('Недостаточно подтверждённых карт одной из команд.',samples);
  if (!a.series.length || !b.series.length) return skip('Нет подтверждённых завершённых BO3 одной из команд; набор прогнозов пропущен.',samples);
  const fixtureId = fixtureKey(fixture);
  if (!fixtureId.length || fixtureId.length > 190) return skip('Некорректный идентификатор матча.',samples);
  const binary = (predicate: (m:AnalysisMap)=>boolean) => ((a.maps.filter(predicate).length+1)/(a.maps.length+2)+(b.maps.filter(predicate).length+1)/(b.maps.length+2))/2;
  const scores: Record<string,number> = {};
  for (const [x,y] of [[2,0],[2,1],[1,2],[0,2]]) {
    const ka = a.series.filter(s=>s.score_team === x && s.score_opponent === y).length;
    const kb = b.series.filter(s=>s.score_team === y && s.score_opponent === x).length;
    scores[`${x}:${y}`] = ((ka+1)/(a.series.length+4)+(kb+1)/(b.series.length+4))/2;
  }
  // Every map's original evidence remains in history; the frozen input IDs below
  // identify the exact sample. Keep the ledger's per-candidate source list small.
  const historySources = [...new Set([...a.maps.flatMap(m=>m.sources),...b.maps.flatMap(m=>m.sources),...a.series.flatMap(s=>s.sources),...b.series.flatMap(s=>s.sources)])].sort();
  const indexSources = historySources.filter(url=>/api\/(teams|leagues)\/\d+\/matches/.test(url));
  const sources = [...new Set([fixture.source_url,...indexSources.slice(0,8),`https://www.opendota.com/matches/${a.maps[0].match_id}`,`https://www.opendota.com/matches/${b.maps[0].match_id}`])];
  const created = new Date(nowMs).toISOString();
  const candidates: Forecast[] = [];
  const add = (market: Market,family:string,selection:string,threshold:number|null,probability:number,label:string,mapNumber:number|null=null) => {
    const order = candidates.length;
    candidates.push({forecast_id:`${fixtureId}-${String(order).padStart(2,'0')}`,fixture_id:fixtureId,team_a:a.team,team_b:b.team,
      team_a_id:a.team_id,team_b_id:b.team_id,scheduled_start_utc:new Date(startMs).toISOString(),created_utc:created,data_cutoff_utc:created,
      cohort_date:day,model_version:'baseline-v1',selection_version:'selection-v2',market,family,selection,threshold,probability,label,map_number:mapNumber,
      selected:false,selection_rank:null,candidate_order:order,n_maps_a:a.maps.length,n_maps_b:b.maps.length,n_series_a:a.series.length,n_series_b:b.series.length,
      sources,limitation:ANALYSIS_LIMITATION,fixture_source:fixture.source_url,provider_id:fixture.provider_id ?? null,
      input_sample:{team_a_match_ids:a.maps.map(m=>m.match_id),team_b_match_ids:b.maps.map(m=>m.match_id),team_a_series_keys:a.series.map(s=>s.series_key),team_b_series_keys:b.series.map(s=>s.series_key),notes:[...a.notes,...b.notes]},
      series_score_distribution:scores,
    });
  };
  add('map_handicap','series_result','a',1.5,1-scores['0:2'],`${a.team} +1.5 карты`);
  add('map_handicap','series_result','a',-1.5,scores['2:0'],`${a.team} -1.5 карты`);
  add('map_handicap','series_result','b',1.5,1-scores['2:0'],`${b.team} +1.5 карты`);
  add('map_handicap','series_result','b',-1.5,scores['0:2'],`${b.team} -1.5 карты`);
  const pa = scores['2:0']+scores['2:1'];
  add('series_winner','series_result','a',null,pa,`Победа ${a.team}`);
  add('series_winner','series_result','b',null,1-pa,`Победа ${b.team}`);
  for (const threshold of [39.5,44.5,49.5,54.5,59.5,64.5]) {
    const p = binary(m=>m.team_kills+m.opponent_kills > threshold);
    add('map_kills','map_kills','over',threshold,p,`Карта 1: убийства >${threshold}`,1);
    add('map_kills','map_kills','under',threshold,1-p,`Карта 1: убийства <${threshold}`,1);
  }
  const duration = binary(m=>m.duration_seconds >= 2460);
  add('map_duration','map_duration','over_or_equal',2460,duration,'Карта 1: длительность ≥41:00',1);
  add('map_duration','map_duration','under',2460,1-duration,'Карта 1: длительность <41:00',1);
  const rounded = (p:number) => Math.round(p*1e12)/1e12;
  const ranked = [...candidates].sort((a,b)=>rounded(b.probability)-rounded(a.probability) || Number(a.candidate_order)-Number(b.candidate_order));
  const chosen = [ranked[0],ranked.find(f=>f.family !== ranked[0].family)!];
  chosen.forEach((f,index)=>{f.selected=true;f.selection_rank=index+1;});
  return {forecasts:candidates,skip_reason:null,samples};
}
