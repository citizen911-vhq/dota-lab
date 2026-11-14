import {PRIMARY_TEAM_POOL,primaryTeamPool,type DynamicTeamPoolEntry,type OpenDotaTeamDirectoryEntry} from './dota-team-pool';
import type {AnalysisHistory,AnalysisMap} from './dota-analysis-types';

export const EXPANSION_POLICY={version:'anchored-top20-v3',maxTeams:20,minMaps:15,windowDays:30,maxMaps:30,halfLifeDays:14,priorMaps:10,minScore:0.5,analysis:'pool-versus-verified-opponents',refresh:'completed-map-evidence'} as const;
const DAY=86400000,coreIds=new Set<string>(PRIMARY_TEAM_POOL.map(t=>t[0]));
export type Admission={id:string;from:string;until?:string};
export type ExpansionRow={team_id:string;team:string;rank:number|null;maps:number;wins:number;losses:number;win_rate:number|null;score:number;effective_maps:number;status:'core'|'admitted'|'candidate'|'insufficient'|'watch';reason:string;match_ids:string[]};
export type ExpansionSnapshot={version:string;at:string;patch_id:string|null;rows:ExpansionRow[];admissions:Admission[];active_ids:string[];healthy:boolean;analysis_team_ids?:string[];analysis_verified_at?:string;analysis_healthy?:boolean;result_signature?:string};
const eligibleMap=(m:AnalysisMap,now:number,patch:string|null)=>m.forecast_sample!==false&&!m.series_excluded_reason&&patch!==null&&m.patch_id===patch&&/^[1-9]\d*$/.test(m.team_id)&&/^[1-9]\d*$/.test(m.opponent_team_id)&&/^[1-9]\d*$/.test(m.match_id)&&m.team_id!==m.opponent_team_id&&typeof m.win==='boolean'&&Number.isSafeInteger(m.start_time)&&Number.isInteger(m.duration_seconds)&&m.duration_seconds>0&&m.duration_seconds<=86400&&(m.start_time+m.duration_seconds)*1000<=now&&m.start_time*1000>=now-30*DAY&&(!m.verified_at||Date.parse(m.verified_at)<=now);

/** Prior membership is time-stamped: no same-cycle promotion chains or future membership in backtests. */
export function expandTeamPool(history:AnalysisHistory,directory:OpenDotaTeamDirectoryEntry[],previous:ExpansionSnapshot|undefined,now:number,patch:string|null,healthy:boolean,watchedIds:string[]=[],analysisHistoryIds:string[]=[]):ExpansionSnapshot{
  if(!Number.isFinite(now))throw new Error('Invalid ranking time');
  if(previous&&Date.parse(previous.at)>now)throw new Error('Future pool snapshot cannot be used for a historical ranking');
  const metadata=new Map(directory.map(t=>[t.id,t.name]));
  for(const [id,name] of PRIMARY_TEAM_POOL)if(!metadata.has(id))metadata.set(id,name);
  for(const row of previous?.rows??[])if(!metadata.has(row.team_id))metadata.set(row.team_id,row.team);
  // Deduplicate each perspective; conflicting copies are excluded rather than arbitrarily chosen.
  const unique=new Map<string,AnalysisMap>(),conflicts=new Set<string>();
  for(const m of history.maps){
    const key=m.team_id+':'+m.match_id,old=unique.get(key);
    if(old&&(old.win!==m.win||old.opponent_team_id!==m.opponent_team_id||old.start_time!==m.start_time||old.duration_seconds!==m.duration_seconds||old.patch_id!==m.patch_id||old.forecast_sample!==m.forecast_sample||old.series_excluded_reason!==m.series_excluded_reason))conflicts.add(key);
    else unique.set(key,m);
  }
  const maps=[...unique.entries()].filter(([key,m])=>!conflicts.has(key)&&eligibleMap(m,now,patch)).map(([,m])=>m);
  for(const m of maps)if(!metadata.has(m.team_id))metadata.set(m.team_id,m.team);
  const admissions=(previous?.admissions??[]).map(a=>({...a}));
  const priorActive=new Set(previous?.active_ids.filter(id=>!coreIds.has(id))??[]);
  const isTopAt=(id:string,at:number,allowed:Set<string>)=>coreIds.has(id)||allowed.has(id)&&admissions.some(a=>a.id===id&&Date.parse(a.from)<=at&&(!a.until||at<Date.parse(a.until)));
  const rate=(allowed:Set<string>):ExpansionRow[]=>{
    // Opponent strength itself uses only completed eligible games, shrunk toward 50%.
    const strength=new Map<string,number>();
    for(const id of [...coreIds,...allowed]){
      const sample=maps.filter(m=>m.team_id===id&&isTopAt(m.opponent_team_id,m.start_time*1000,allowed)).sort((a,b)=>b.start_time-a.start_time).slice(0,30);
      strength.set(id,(sample.filter(m=>m.win).length+5)/(sample.length+10));
    }
    return [...metadata].map(([id,name])=>{
      const sample=maps.filter(m=>m.team_id===id&&isTopAt(m.opponent_team_id,m.start_time*1000,allowed)).sort((a,b)=>b.start_time-a.start_time||a.match_id.localeCompare(b.match_id)).slice(0,30);
      let weight=0,adjusted=0;
      for(const m of sample){const w=2**(-(now-(m.start_time+m.duration_seconds)*1000)/(14*DAY));weight+=w;adjusted+=w*Math.max(0,Math.min(1,Number(m.win)+((strength.get(m.opponent_team_id)??0.5)-0.5)*0.5));}
      const wins=sample.filter(m=>m.win).length,score=(adjusted+5)/(weight+10);
      return {team_id:id,team:name,rank:null,maps:sample.length,wins,losses:sample.length-wins,win_rate:sample.length?wins/sample.length:null,score,effective_maps:weight,status:'candidate' as ExpansionRow['status'],reason:'',match_ids:sample.map(m=>m.match_id)};
    }).filter(r=>coreIds.has(r.team_id)||r.maps>0||watchedIds.includes(r.team_id)||priorActive.has(r.team_id)||previous?.rows.some(p=>p.team_id===r.team_id));
  };
  // Remove unsupported dependencies until every retained member is grounded in the core.
  let allowed=new Set(priorActive),rows=rate(allowed);
  for(let pass=0;pass<9;pass++){
    const qualified=new Set(rows.filter(r=>allowed.has(r.team_id)&&r.maps>=15&&r.score>=0.5).map(r=>r.team_id));
    if(qualified.size===allowed.size)break;
    allowed=qualified;rows=rate(allowed);
  }
  const order=(a:ExpansionRow,b:ExpansionRow)=>b.score-a.score||b.maps-a.maps||a.team_id.localeCompare(b.team_id);
  let qualified:ExpansionRow[]=[];
  for(let pass=0;pass<9;pass++){
    qualified=rows.filter(r=>!coreIds.has(r.team_id)&&directory.some(t=>t.id===r.team_id)&&r.maps>=15&&r.score>=0.5).sort(order).slice(0,8);
    const retained=new Set([...allowed].filter(id=>qualified.some(r=>r.team_id===id)));
    if(retained.size===allowed.size)break;
    allowed=retained;rows=rate(allowed);
  }
  // On a failed/partial collection do not grant or revoke membership using incomplete data.
  const active=new Set(healthy?qualified.map(r=>r.team_id):priorActive);
  const at=new Date(now).toISOString();
  if(healthy){
    for(const a of admissions)if(!a.until&&!active.has(a.id))a.until=at;
    for(const id of active)if(!admissions.some(a=>a.id===id&&!a.until))admissions.push({id,from:at});
  }
  rows.sort((a,b)=>Number(coreIds.has(b.team_id))-Number(coreIds.has(a.team_id))||Number(active.has(b.team_id))-Number(active.has(a.team_id))||order(a,b));
  let rank=0;
  for(const r of rows){
    if(coreIds.has(r.team_id)){r.status='core';r.rank=++rank;r.reason='Постоянное ядро';}
    else if(active.has(r.team_id)){r.status='admitted';r.rank=++rank;r.reason=healthy?'Допущена: ≥15 карт и скорректированный WR ≥50%':'Допуск сохранён; обновление неполное, ставки заблокированы';}
    else if(priorActive.has(r.team_id)||admissions.some(a=>a.id===r.team_id)){r.status='watch';r.reason='Наблюдение: сейчас не выполняются условия TOP-20';}
    else if(r.maps<15){r.status='insufficient';r.reason=`Нужно ещё ${15-r.maps} карт против топов`;}
    else{r.status='candidate';r.reason=!directory.some(t=>t.id===r.team_id)?'Нужна проверка команды в каталоге OpenDota':!healthy?'Ожидает успешного обновления истории':r.score<0.5?'Скорректированный WR ниже 50%':'Нет свободного места в TOP-20';}
  }
  // Analysis permission is not TOP-20 membership. Only current directory IDs
  // whose own history index was read this cycle qualify as outside opponents.
  const directoryIds=new Set(directory.map(t=>t.id));
  const analysis_team_ids=healthy?[...new Set(analysisHistoryIds)].filter(id=>directoryIds.has(id)):[];
  return {version:EXPANSION_POLICY.version,at,patch_id:patch,rows,admissions,active_ids:[...coreIds,...active],healthy,analysis_team_ids};
}

export function expansionPool(snapshot:ExpansionSnapshot|undefined,directory:OpenDotaTeamDirectoryEntry[]=[],previous:DynamicTeamPoolEntry[]=[]):DynamicTeamPoolEntry[]{
  const pool=primaryTeamPool(directory,previous),metadata=new Map([...previous,...directory].map(t=>[t.id,t]));
  for(const id of snapshot?.active_ids??[]){
    if(coreIds.has(id)||pool.length>=20)continue;
    const row=snapshot!.rows.find(r=>r.team_id===id);if(!row)continue;
    const m=metadata.get(id);
    pool.push({id,name:m?.name??row.team,tag:m?.tag??null,rating:m?.rating??0,last_match_time:m?.last_match_time??0,qualification:'expanded-top',tier1_rank:row.rank,tier1_opponent_maps:row.maps,recent_maps:row.maps});
  }
  return pool;
}

/** Ranking qualification never trims a team's prediction history.
 * sampleTeam applies the current patch, September cutoff, completion/quality
 * checks and each team's own latest-30 limit. Never revive quarantined maps.
 */
export function expansionHistory(history:AnalysisHistory,snapshot:ExpansionSnapshot,now:number):AnalysisHistory{
  if(Date.parse(snapshot.at)>now)throw new Error('Future ranking snapshot');
  return history;
}

export function expansionGate(snapshot:ExpansionSnapshot|undefined,a:string,b:string,now:number):string|null{
  if(!snapshot)return coreIds.has(a)&&coreIds.has(b)?null:'Команда ещё не допущена в TOP-20.';
  // Ranking age is not data freshness: an unchanged result set stays valid.
  // Patch/history/quote freshness is checked separately before a bet.
  if(!snapshot.healthy||!Number.isFinite(Date.parse(snapshot.at))||Date.parse(snapshot.at)>now)return 'Нет подтверждённой базы рейтинга TOP-20.';
  if(snapshot.analysis_healthy===false)return 'Последняя проверка истории не завершена; анализ отложен.';
  if(snapshot.analysis_verified_at&&(!Number.isFinite(Date.parse(snapshot.analysis_verified_at))||Date.parse(snapshot.analysis_verified_at)>now))return 'Некорректное время проверки истории.';
  if(a===b||!snapshot.active_ids.includes(a)&&!snapshot.active_ids.includes(b))return 'В матче нет команды из активного пула TOP-20.';
  const known=new Set([...snapshot.active_ids,...(snapshot.analysis_team_ids??[])]);
  if(!known.has(a)||!known.has(b))return 'Для соперника пула нужны подтверждённый Valve ID и успешная загрузка собственной истории.';
  return null;
}

/** A poll updates collection evidence; only changed completed-map facts (or a
 * patch/policy transition) advance ranking time, positions and admission dates.
 * verified_at and the clock are deliberately not fingerprint inputs.
 */
export async function advanceTeamPool(history:AnalysisHistory,directory:OpenDotaTeamDirectoryEntry[],previous:ExpansionSnapshot|undefined,now:number,patch:string|null,healthy:boolean,watchedIds:string[]=[],analysisHistoryIds:string[]=[]){
  if(!Number.isFinite(now)||previous&&Date.parse(previous.at)>now)throw new Error('Future or invalid ranking time');
  const directoryIds=new Set(directory.map(t=>t.id));
  const evidence={analysis_healthy:healthy,analysis_verified_at:new Date(now).toISOString(),analysis_team_ids:healthy?[...new Set(analysisHistoryIds)].filter(id=>directoryIds.has(id)):[]};
  if(!healthy&&previous)return {snapshot:{...previous,...evidence},changed:false};
  const facts=[...new Set(history.maps.filter(m=>m.patch_id===patch&&(m.start_time+m.duration_seconds)*1000<=now&&(!m.verified_at||Date.parse(m.verified_at)<=now)).map(m=>JSON.stringify([m.match_id,m.team_id,m.opponent_team_id,m.start_time,m.duration_seconds,m.win,m.patch_id,m.forecast_sample!==false,m.series_excluded_reason??null])))].sort();
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([EXPANSION_POLICY.version,patch,facts])));
  const result_signature=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(previous?.healthy&&previous.result_signature===result_signature)return {snapshot:{...previous,...evidence},changed:false};
  const snapshot=expandTeamPool(history,directory,previous,now,patch,healthy,watchedIds,analysisHistoryIds);
  return {snapshot:{...snapshot,...evidence,...(healthy?{result_signature}:{})},changed:healthy};
}

/** Informational only: never used by value/settlement eligibility checks. */
export function poolWarnings(snapshot:ExpansionSnapshot|undefined,ids:readonly string[]):string[]{
  if(!snapshot)return [];
  return [...new Set(ids)].flatMap(id=>{
    const row=snapshot.rows.find(r=>r.team_id===id);
    if(!row)return [`Valve ID ${id}: число карт против топов пока не подтверждено; экспериментальный прогноз.`];
    return row.maps<EXPANSION_POLICY.minMaps?[`${row.team}: нет 15 карт против топов (${row.maps}/15). Экспериментальный прогноз; отметка не блокирует виртуальную ставку.`]:[];
  });
}
