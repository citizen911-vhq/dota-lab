import type {Forecast,Observation} from './dota-types';
import type {NormalizedMatch} from './dota-opendota';
import {distinctMatches,forecastTeamIds} from './dota-auto-core';

/** Two distinct wins prove the BO3 winner, never an exact 2:0 score. */
export function winnerEvidence(f:Forecast,matches:NormalizedMatch[],now=Date.now()):{winner:'a'|'b';map_ids:string[];sources:string[]}|null{
  const ids=forecastTeamIds(f),start=Date.parse(f.scheduled_start_utc)/1000;
  if((f.best_of??3)!==3||!ids||!Number.isFinite(start)||start*1000>now)return null;
  const [a,b]=ids;
  const raw=matches.filter(m=>m.start_time>=start-900&&m.start_time<=start+8*3600&&((m.radiant_team_id===a&&m.dire_team_id===b)||(m.radiant_team_id===b&&m.dire_team_id===a)));
  const valid=distinctMatches(raw,now);
  if(new Set(raw.map(m=>m.id)).size!==valid.length||valid.some(m=>m.context_conflict||m.series_type!==1||m.series_id==null||!m.league_id))return null;
  if(new Set(valid.map(m=>`${m.league_id}:${m.series_id}`)).size!==1||valid.length<2||valid.length>3)return null;
  const ordered=[...valid].sort((x,y)=>x.start_time-y.start_time);
  let wa=0,wb=0;
  for(const [i,m] of ordered.entries()){
    if(wa===2||wb===2||i>0&&m.start_time<ordered[i-1].end_time)return null;
    if(m.radiant_team_id===a?m.radiant_win:!m.radiant_win)wa++;else wb++;
  }
  if(wa!==2&&wb!==2)return null;
  return {winner:wa===2?'a':'b',map_ids:ordered.map(m=>m.id),sources:ordered.map(m=>`https://www.opendota.com/matches/${m.id}`)};
}

export function mapEvidenceConflicts(previous:Observation|undefined,map1:NonNullable<Observation['map1']>):boolean{
  return !!previous?.map1_void||!!previous?.map1&&(['match_id','kills_a','kills_b','duration_seconds'] as const).some(k=>previous.map1?.[k]!=null&&String(previous.map1[k])!==String(map1[k]));
}
