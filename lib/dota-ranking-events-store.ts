import {env} from 'cloudflare:workers';
import historySeed from '../data/history-seed.json';
import {historyFromMatches} from './dota-auto-core';
import {canonical} from './dota-core';
import {loadJournal} from './dota-store';
import {advanceTeamPool,expansionPool,type ExpansionSnapshot} from './dota-expansion';
import type {AnalysisHistory} from './dota-analysis-types';
import type {NormalizedMatch} from './dota-opendota';
import type {OpenDotaTeamDirectoryEntry} from './dota-team-pool';

/** Called under the standalone results lease. Full analysis updates its own
 * ranking later, after all map recovery. Never places bets or claims that a
 * result check refreshed every team's history index.
 */
export async function refreshRankingAfterResults(){
  const db=env.DB!,now=Date.now();
  const rows=await db.prepare("SELECT key,payload FROM dota_analysis_records WHERE key IN ('state:expansion','state:team_directory','state:current_patch','state:betting_health','state:history_queue') OR key LIKE 'match:%'").all<{key:string;payload:string}>();
  const state=Object.fromEntries(rows.results.map(r=>[r.key,JSON.parse(r.payload)]));
  const previous=state['state:expansion'] as ExpansionSnapshot|undefined;
  const directory=state['state:team_directory'] as OpenDotaTeamDirectoryEntry[]|undefined;
  const patch=state['state:current_patch']?.patch_id as string|undefined;
  if(!previous?.healthy||!directory?.length||!patch||state['state:betting_health']?.healthy!==true)return {changed:false};
  const matches=rows.results.filter(r=>r.key.startsWith('match:')).map(r=>JSON.parse(r.payload) as NormalizedMatch);
  const history=historyFromMatches(historySeed as AnalysisHistory,matches,(await loadJournal()).journal,now);
  const update=await advanceTeamPool(history,directory,previous,now,patch,true,state['state:history_queue']??[],previous.analysis_team_ids??[]);
  if(!update.changed)return {changed:false};
  const snapshot={...update.snapshot,analysis_verified_at:previous.analysis_verified_at,analysis_healthy:previous.analysis_healthy,analysis_team_ids:previous.analysis_team_ids};
  const at=new Date(now).toISOString();
  const records=[['state:expansion',snapshot],['state:team_pool',expansionPool(snapshot,directory)],['ranking:results:'+crypto.randomUUID(),snapshot]] as const;
  await db.batch(records.map(([key,value])=>db.prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(key,canonical(value),at)));
  return {changed:true,at:snapshot.at};
}
