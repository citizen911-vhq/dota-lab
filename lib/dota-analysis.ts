import { BASELINE_ROSTERS, rosterNotices } from './dota-rosters';
import { HISTORY_START_MS, HISTORY_MAP_LIMIT } from './dota-history-policy';
import type { Forecast, Market } from './dota-types';
import type { AnalysisHistory, AnalysisMap, AnalysisSeries, FixtureInput, ForecastBuild, TeamSample, TrackedTeam, TeamRating, MatchupAnalysis, HeadToHeadSummary } from './dota-analysis-types';

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

export const ANALYSIS_LIMITATION = 'Экспериментальная оценка: до 30 доступных карт команды в текущем патче. Состав — информационный признак без влияния на вероятность и ставку. Elo учитывает соперников; вероятности BO2/BO3 считаются из оценки отдельной карты. BO3, завершившаяся 2:0, даёт две сыгранные карты в историю. Тоталы используют только подтверждённые первые карты. Прошлые патчи — только справка, их вес в прогнозе равен нулю. Драфт и сторона не учтены.';
export const EXPERIMENT_FIRST_DAY = '2026-11-14';
export const EXPERIMENT_LAST_DAY = '2026-12-13';
export const EXPERIMENT_START_UTC = Date.parse('2026-11-13T15:00:00.000Z');
export const EXPERIMENT_END_UTC = Date.parse('2026-12-13T15:00:00.000Z');
export const ROSTER_MAX_AGE_MS = 6 * 3600000;
export const MIN_BETTING_MAPS = 1;
export const MIN_TOTAL_MAPS = 1;
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
  return JSON.stringify([m.team_id,m.opponent_team_id,m.start_time,m.duration_seconds,m.team_kills,m.opponent_kills,m.win,m.patch_id ?? null,m.map_number ?? null]);
}

export function sampleTeam(history: AnalysisHistory, teamId: string, cutoffMs: number, patchId?: string, roster?: number[]): TeamSample {
  const definition = TRACKED_TEAMS.find(t=>t.id === teamId);
  const all = history.maps.filter(m=>m.team_id === teamId);
  const byId = new Map<string, AnalysisMap>();
  const conflicts = new Set<string>();
  for (const m of all) {
    if (!validMap(m) || !knownBy(m.verified_at,cutoffMs) || (m.start_time + m.duration_seconds) * 1000 > cutoffMs) continue;
    const previous = byId.get(m.match_id);
    if (previous && (mapFacts(previous) !== mapFacts(m) || hasRoster(previous.players) && hasRoster(m.players) && rosterKey(previous.players!) !== rosterKey(m.players!))) conflicts.add(m.match_id);
    // A source with player IDs enriches the same map without duplicating it.
    if (!previous || !hasRoster(previous.players) && hasRoster(m.players)) byId.set(m.match_id,m);
  }
  const completed = [...byId.values()].filter(m=>!conflicts.has(m.match_id)).sort((a,b)=>b.start_time-a.start_time || b.match_id.localeCompare(a.match_id));
  const reference = roster ?? BASELINE_ROSTERS[teamId]?.account_ids ?? definition?.reference_roster ?? [];
  const latest = completed[0];
  const rosterUncertain = !hasRoster(reference) || !latest || !hasRoster(latest.players) || conflicts.size > 0 && all.some(m=>conflicts.has(m.match_id) && (!latest || m.start_time >= latest.start_time));
  const rosterChanged = hasRoster(reference) && !!latest && hasRoster(latest.players) && rosterKey(latest.players!) !== rosterKey(reference);
  const eligible = completed.filter(m=> {
    return m.start_time * 1000 >= HISTORY_START_MS && !!patchId && m.patch_id === patchId && m.forecast_sample !== false;
  });
  const maps = eligible.slice(0,HISTORY_MAP_LIMIT);
  const mapIds = new Set(maps.map(m=>m.match_id));
  const seriesKeys = new Set(maps.map(m=>m.series_key).filter(Boolean));
  const seriesByKey = new Map<string,AnalysisSeries>();
  const conflictingSeries = new Set<string>();
  for (const s of history.series) {
    if (s.team_id !== teamId || !s.complete_bo3 || s.forecast_sample === false || s.excluded_reason || !validScores.has(`${s.score_team}:${s.score_opponent}`)) continue;
    if (!knownBy(s.verified_at,cutoffMs) || (s.end_time ?? s.start_time) * 1000 > cutoffMs || s.start_time * 1000 >= cutoffMs) continue;
    if (!s.sources.length || !s.sources.every(validUrl)) continue;
    if (!s.map_ids.length || !s.map_ids.every(id=>mapIds.has(id)) || !seriesKeys.has(s.series_key) && !s.map_ids.some(id=>mapIds.has(id))) continue;
    const old = seriesByKey.get(s.series_key);
    if (old && (old.score_team !== s.score_team || old.score_opponent !== s.score_opponent || old.opponent_team_id !== s.opponent_team_id)) conflictingSeries.add(s.series_key);
    if (!old) seriesByKey.set(s.series_key,s);
  }
  const series = [...seriesByKey.values()].filter(s=>!conflictingSeries.has(s.series_key)).sort((a,b)=>b.start_time-a.start_time || a.series_key.localeCompare(b.series_key));
  const notes = ['До 30 доступных карт команды текущего патча; состав — информационный признак, полнота источника не гарантирована.'];
  if (!patchId) notes.push('Текущий патч не подтверждён: выборка для ставки пуста.');
  if (maps.length < 30) notes.push(`Доступно ${maps.length} карт из целевых 30.`);
  if (conflicts.size) notes.push(`Исключено карт с противоречивыми фактами: ${conflicts.size}.`);
  if (rosterChanged) notes.push('Состав может отличаться*: последние аккаунты не совпадают с базовой пятёркой. Это не влияет на прогноз и ставку.');
  if (rosterUncertain) notes.push('Состав может отличаться*: нет полной информации о последней пятёрке. Это не блокирует прогноз и ставку.');
  return {team_id:teamId,team:definition?.name ?? completed[0]?.team ?? teamId,maps,series,excluded_maps:all.length-maps.length,conflicting_map_ids:[...conflicts].sort(),roster_changed:rosterChanged,roster_uncertain:rosterUncertain,notes};
}

function uniqueCompletedMaps(maps: AnalysisMap[], cutoffMs: number): AnalysisMap[] {
  const byId = new Map<string,AnalysisMap>();
  const conflicts = new Set<string>();
  for (const row of maps) {
    if (!validMap(row) || !numericId(row.opponent_team_id) || !knownBy(row.verified_at,cutoffMs) || (row.start_time + row.duration_seconds) * 1000 > cutoffMs) continue;
    // Both team-perspective rows represent ONE game. Canonical orientation also
    // lets contradictory mirrored outcomes fail closed instead of counting twice.
    const m = row.team_id < row.opponent_team_id ? row : {...row,team_id:row.opponent_team_id,team:row.opponent,opponent_team_id:row.team_id,opponent:row.team,team_kills:row.opponent_kills,opponent_kills:row.team_kills,win:!row.win};
    const previous = byId.get(m.match_id);
    // Missing map order on one mirrored row is not a contradictory result.
    // Two explicitly different orders remain a conflict.
    if (previous && (mapFacts({...previous,map_number:null}) !== mapFacts({...m,map_number:null}) ||
      previous.map_number!=null&&m.map_number!=null&&previous.map_number!==m.map_number)) conflicts.add(m.match_id);
    if (!previous) byId.set(m.match_id,m);
    else if(previous.map_number==null&&m.map_number!=null)byId.set(m.match_id,{...previous,map_number:m.map_number});
  }
  return [...byId.values()].filter(m=>!conflicts.has(m.match_id)).sort((a,b)=>a.start_time-b.start_time || a.match_id.localeCompare(b.match_id));
}

function ratingMaps(history: AnalysisHistory, cutoffMs: number, patchId: string): AnalysisMap[] {
  if (!patchId) return [];
  const teamIds = new Set(history.maps.map(m=>m.team_id));
  const eligibleRows: AnalysisMap[] = [];
  for (const teamId of teamIds) {
    const s = sampleTeam(history,teamId,cutoffMs,patchId);
    eligibleRows.push(...s.maps);
  }
  // Union, not intersection: an opponent's activity must not discard this team's game.
  return uniqueCompletedMaps(eligibleRows,cutoffMs);
}

const eloProbability = (a: number,b: number) => 1/(1+10**((b-a)/400));

export function buildTeamRatings(history: AnalysisHistory, cutoffMs: number, patchId: string): TeamRating[] {
  if (!patchId || !Number.isFinite(cutoffMs)) return [];
  const ratings = new Map<string,TeamRating>();
  const get = (id:string,name:string) => {
    if (!ratings.has(id)) ratings.set(id,{team_id:id,team:name,patch_id:patchId,rating:1500,maps:0,wins:0,losses:0,match_ids:[]});
    return ratings.get(id)!;
  };
  for (const t of TRACKED_TEAMS) get(t.id,t.name);
  const membership=new Set<string>();
  for(const id of new Set(history.maps.map(m=>m.team_id)))
    for(const m of sampleTeam(history,id,cutoffMs,patchId).maps)membership.add(`${m.match_id}:${id}`);
  for (const m of ratingMaps(history,cutoffMs,patchId)) {
    const a=get(m.team_id,m.team),b=get(m.opponent_team_id,m.opponent);
    const change=24*(Number(m.win)-eloProbability(a.rating,b.rating));
    // Windowed Elo: calculate both changes from pre-game ratings, but update a
    // team only for games in its OWN window. Never extend it via an opponent.
    for (const [team,won] of [[a,m.win],[b,!m.win]] as const) {
      if(!membership.has(`${m.match_id}:${team.team_id}`))continue;
      team.rating+=team===a?change:-change;
      team.maps++;team.wins+=Number(won);team.losses+=Number(!won);team.match_ids.push(m.match_id);
    }
  }
  return [...ratings.values()].sort((a,b)=>b.rating-a.rating || a.team_id.localeCompare(b.team_id));
}

export function analyzeMatchup(history: AnalysisHistory, teamAId: string, teamBId: string, cutoffMs: number, patchId: string): MatchupAnalysis {
  const ratings=buildTeamRatings(history,cutoffMs,patchId);
  const a=ratings.find(t=>t.team_id===teamAId) ?? null,b=ratings.find(t=>t.team_id===teamBId) ?? null;
  const pair = (m:AnalysisMap) => m.team_id===teamAId && m.opponent_team_id===teamBId || m.team_id===teamBId && m.opponent_team_id===teamAId;
  const summarize = (maps:AnalysisMap[],eligible:boolean):HeadToHeadSummary => {
    const rows=maps.filter(pair),winsA=rows.filter(m=>m.team_id===teamAId?m.win:!m.win).length;
    return {maps:rows.length,wins_a:winsA,wins_b:rows.length-winsA,match_ids:rows.map(m=>m.match_id),eligible_for_betting:eligible};
  };
  return {patch_id:patchId,ratings:{team_a:a,team_b:b},map_win_probability_a:a?.maps && b?.maps?eloProbability(a.rating,b.rating):null,
    head_to_head:{current_patch:summarize(ratingMaps(history,cutoffMs,patchId),true),historical_context:summarize(uniqueCompletedMaps(history.maps,cutoffMs).filter(m=>!!m.patch_id && m.patch_id!==patchId),false)},
    form:{team_a:formSummary(a),team_b:formSummary(b)},
    notes:['Оконный Elo: старт 1500, K=24. Каждая команда обновляется только на своих последних 30 подходящих картах; окно соперника не исключает её карты. Это экспериментальная модификация Elo.','Винрейт — доля побед в собственной выборке, не вероятность победы над конкретным соперником. Вероятность карты рассчитана по разнице рейтингов.','Очные встречи в объединении двух выборок показаны отдельно, но уже учтены в рейтинге и не получают повторного веса. Прошлые патчи — только контекст.']};
}

function formSummary(r:TeamRating|null){
  return {maps:r?.maps??0,wins:r?.wins??0,losses:r?.losses??0,win_rate:r?.maps?r.wins/r.maps:null};
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
  if(startMs>nowMs+144*3600000)return skip('Матч вне ближайших 144 часов.');
  if (verifiedMs > nowMs || nowMs - verifiedMs > 24 * 3600000) return skip('Расписание не подтверждено за последние 24 часа.');
  if (![2,3].includes(fixture.best_of) || fixture.status !== 'scheduled') return skip('Для прогноза нужна подтверждённая будущая серия BO2 или BO3.');
  if (!validUrl(fixture.source_url)) return skip('Нет корректной HTTPS-ссылки на расписание.');
  const day = new Date(startMs + 9*3600000).toISOString().slice(0,10);
  if (startMs < EXPERIMENT_START_UTC || startMs >= EXPERIMENT_END_UTC) return skip('Матч вне периода эксперимента: с 13 ноября 18:00 до 13 декабря 18:00 МСК.');
  if (fixture.team_a_id === fixture.team_b_id || !numericId(fixture.team_a_id) || !numericId(fixture.team_b_id)) return skip('Обе команды должны иметь подтверждённые Valve ID из каталога OpenDota.');
  if (typeof fixture.patch_id!=='string' || !fixture.patch_id.trim()) return skip('Текущий патч не подтверждён: прогноз и ставка пропущены.');
  const warnings=rosterNotices(fixture,history,nowMs);
  const a = sampleTeam(history,fixture.team_a_id,Math.min(nowMs,startMs),fixture.patch_id);
  const b = sampleTeam(history,fixture.team_b_id,Math.min(nowMs,startMs),fixture.patch_id);
  const samples = {a,b};
  if (!a.maps.length || !b.maps.length) return skip('В текущем патче нет подтверждённых карт одной из команд: вероятность не вычислить.',samples);
  const matchup=analyzeMatchup(history,a.team_id,b.team_id,nowMs,fixture.patch_id);
  if (matchup.map_win_probability_a===null || matchup.ratings.team_a!.maps<MIN_BETTING_MAPS || matchup.ratings.team_b!.maps<MIN_BETTING_MAPS) return skip('Нет пригодных карт текущего патча обеих сторон для рейтинга соперников.',samples);
  const fixtureId = fixtureKey(fixture);
  if (!fixtureId.length || fixtureId.length > 190) return skip('Некорректный идентификатор матча.',samples);
  const firstA=a.maps.filter(m=>m.map_number===1),firstB=b.maps.filter(m=>m.map_number===1);
  const firstMaps=uniqueCompletedMaps([...firstA,...firstB],nowMs);
  const binary = (predicate: (m:AnalysisMap)=>boolean) => (firstMaps.filter(predicate).length+1)/(firstMaps.length+2);
  const p=matchup.map_win_probability_a,q=1-p;
  // Coherent series distribution derived from opponent-adjusted map strength.
  const scores:Record<string,number>=fixture.best_of===2
    ? {'2:0':p*p,'1:1':2*p*q,'0:2':q*q}
    : {'2:0':p*p,'2:1':2*p*p*q,'1:2':2*p*q*q,'0:2':q*q};
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
      team_a_id:a.team_id,team_b_id:b.team_id,scheduled_start_utc:new Date(startMs).toISOString(),created_utc:created,data_cutoff_utc:created,best_of:fixture.best_of,
      cohort_date:day,model_version:'prematch-elo-v4',selection_version:'expected-value-v1',forecast_stage:'preliminary',market,family,selection,threshold,probability,label,map_number:mapNumber,
      selected:false,selection_rank:null,candidate_order:order,n_maps_a:a.maps.length,n_maps_b:b.maps.length,n_series_a:a.series.length,n_series_b:b.series.length,
      sources,limitation:ANALYSIS_LIMITATION,fixture_source:fixture.source_url,provider_id:fixture.provider_id ?? null,
      input_sample:{team_a_match_ids:a.maps.map(m=>m.match_id),team_b_match_ids:b.maps.map(m=>m.match_id),team_a_series_keys:a.series.map(s=>s.series_key),team_b_series_keys:b.series.map(s=>s.series_key),notes:[...a.notes,...b.notes]},
      series_score_distribution:scores,
      betting_eligible:true,patch_id:fixture.patch_id,roster_snapshots:structuredClone(fixture.rosters),matchup_analysis:matchup,
      roster_policy:'informational-v1',roster_warnings:warnings,baseline_rosters:structuredClone({team_a:BASELINE_ROSTERS[fixture.team_a_id]??null,team_b:BASELINE_ROSTERS[fixture.team_b_id]??null}),
      rating_match_ids:[...new Set([...matchup.ratings.team_a!.match_ids,...matchup.ratings.team_b!.match_ids])],
      total_sample_match_ids:firstMaps.map(m=>m.match_id),n_map1_a:firstA.length,n_map1_b:firstB.length,
    });
  };
  add('map_handicap','series_result','a',1.5,1-scores['0:2'],`${a.team} +1.5 карты`);
  add('map_handicap','series_result','a',-1.5,scores['2:0'],`${a.team} -1.5 карты`);
  add('map_handicap','series_result','b',1.5,1-scores['2:0'],`${b.team} +1.5 карты`);
  add('map_handicap','series_result','b',-1.5,scores['0:2'],`${b.team} -1.5 карты`);
  const pa = fixture.best_of===2?scores['2:0']:scores['2:0']+scores['2:1'];
  const pb = fixture.best_of===2?scores['0:2']:1-pa;
  add('series_winner','series_result','a',null,pa,`Победа ${a.team}`);
  add('series_winner','series_result','b',null,pb,`Победа ${b.team}`);
  if (firstA.length>=MIN_TOTAL_MAPS && firstB.length>=MIN_TOTAL_MAPS) {
    for (const threshold of [39.5,44.5,49.5,54.5,59.5,64.5]) {
      const probability = binary(m=>m.team_kills+m.opponent_kills > threshold);
      add('map_kills','map_kills','over',threshold,probability,`Карта 1: убийства >${threshold}`,1);
      add('map_kills','map_kills','under',threshold,1-probability,`Карта 1: убийства <${threshold}`,1);
    }
    const duration = binary(m=>m.duration_seconds >= 2460);
    add('map_duration','map_duration','over_or_equal',2460,duration,'Карта 1: длительность ≥41:00',1);
    add('map_duration','map_duration','under',2460,1-duration,'Карта 1: длительность <41:00',1);
  }
  // A probability alone cannot select a bet. The paper layer evaluates these
  // frozen candidates against fresh odds, EV and sample/uncertainty limits.
  return {forecasts:candidates,skip_reason:null,samples};
}
