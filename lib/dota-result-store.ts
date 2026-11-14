import {env} from 'cloudflare:workers';
import {loadJournal,recordResult} from './dota-store';
import {latestObservations,canonical,settle} from './dota-core';
import {inCurrentExperiment} from './dota-experiment';
import {forecastTeamIds,mergeMatchEvidence,confirmSeries,historyFromMatches} from './dota-auto-core';
import {recoverResultMaps,type ResultMapQueue} from './dota-result-recovery';
import {fetchHawk,resultRows,resultOrientation,resultUrl,verifiedResult,verifiedFirstMap,HAWK_RESULTS} from './dota-result-source';
import {winnerEvidence,mapEvidenceConflicts} from './dota-market-evidence';
import {refreshRankingAfterResults} from './dota-ranking-events-store';
import type {NormalizedMatch} from './dota-opendota';
import historySeed from '../data/history-seed.json';
import type {AnalysisHistory} from './dota-analysis-types';

type Check={fixture_id:string;fixture:string;team_a_id?:string;team_b_id?:string;status:string;reason:string;checked_at:string;map_ids?:string[];source_url?:string;score?:[number,number];name_warnings?:string[];winner?:string;market_status?:{market:string;status:string}[]};
async function record(key:string,value:unknown){await env.DB!.prepare('INSERT INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_utc=excluded.updated_utc').bind(key,canonical(value),new Date().toISOString()).run();}
async function read(key:string){const row=await env.DB!.prepare('SELECT payload FROM dota_analysis_records WHERE key=?').bind(key).first<{payload:string}>();return row?JSON.parse(row.payload):null;}

/** Result processing is independent of today's TOP-20 and never places bets. */
export async function updateMatchResults(inFlightOpenDotaRequests?:number){
  const now=Date.now(),owner=crypto.randomUUID(),db=env.DB!;
  // The full updater calls this itself after persisting its maps. A standalone
  // refresh must not overwrite map enrichment or race its in-flight budget.
  const lease=await db.prepare("INSERT INTO dota_analysis_lease(id,owner,expires_at) SELECT 'results',?,? WHERE (?=1 OR NOT EXISTS(SELECT 1 FROM dota_analysis_lease WHERE id='daily' AND expires_at>?)) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE dota_analysis_lease.expires_at<? RETURNING owner").bind(owner,now+300000,inFlightOpenDotaRequests===undefined?0:1,now,now).first<{owner:string}>();
  if(lease?.owner!==owner)return {status:'busy',observations_added:0,maps_added:0,checks:[]};
  try{
    const {journal}=await loadJournal(),latest=latestObservations(journal.observations);
    const pending=[...new Map(journal.forecasts.filter(inCurrentExperiment).map(f=>[f.fixture_id,f])).values()].filter(f=>{
      const o=latest.get(f.fixture_id);return Date.parse(f.scheduled_start_utc)<now&&!o?.series_void&&(!o?.series_score||!o?.map1_void&&(!o?.map1?.match_id||o.map1.kills_a==null||o.map1.kills_b==null||o.map1.duration_seconds==null));
    });
    const oldChecks=(await read('state:result_checks')??[]) as Check[];
    // Oldest checked first: a difficult old series cannot starve newer results.
    const fixtures=pending.sort((a,b)=>String(oldChecks.find(c=>c.fixture_id===a.fixture_id)?.checked_at??'').localeCompare(String(oldChecks.find(c=>c.fixture_id===b.fixture_id)?.checked_at??''))).slice(0,4);
    if(!fixtures.length){
      if(inFlightOpenDotaRequests===undefined)await refreshRankingAfterResults();
      return {status:'ok',observations_added:0,maps_added:0,checks:[]};
    }
    const stored=await db.prepare("SELECT payload FROM dota_analysis_records WHERE key LIKE 'match:%'").all<{payload:string}>();
    const maps=new Map(stored.results.map(r=>{const m=JSON.parse(r.payload) as NormalizedMatch;return [m.id,m];}));
    const month=new Date(now).toISOString().slice(0,7),usageKey='results:usage:'+month,usage=Number(await read(usageKey))||0;
    const runs=await db.prepare('SELECT payload FROM dota_analysis_runs WHERE started_utc>=?').bind(month+'-01T00:00:00.000Z').all<{payload:string}>();
    const historyRequests=runs.results.reduce((sum,r)=>sum+(Number(JSON.parse(r.payload).opendota_requests)||0),0);
    const recovery=await recoverResultMaps(fixtures,[...maps.values()],await read('state:result_map_queue')??[] as ResultMapQueue[],env.OPENDOTA_API_KEY,Math.max(0,145000-usage-historyRequests-(inFlightOpenDotaRequests??0)),now);
    await record(usageKey,usage+recovery.requests);
    let mapsAdded=0;
    for(const incoming of recovery.matches){const prior=maps.get(incoming.id),merged=prior?mergeMatchEvidence(prior,incoming):incoming;if(!prior)mapsAdded++;maps.set(merged.id,merged);await record('match:'+merged.id,merged);}
    await record('state:result_map_queue',recovery.queue);
    const pages=new Map<string,Promise<Record<string,any>>>(),get=(url:string)=>{if(!pages.has(url))pages.set(url,fetchHawk(url));return pages.get(url)!;};
    const checks:Check[]=[];let added=0;
    for(const f of fixtures){
      const ids=forecastTeamIds(f),check:Check={fixture_id:f.fixture_id,fixture:`${f.team_a} — ${f.team_b}`,team_a_id:ids?.[0],team_b_id:ids?.[1],status:'pending',reason:'',checked_at:new Date(now).toISOString()};
      try{
        if(!ids)throw new Error('Не подтверждены Valve ID участников серии.');
        // Settle the winner independently, even when the secondary source is down.
        const winner=winnerEvidence(f,[...maps.values()],Date.now());
        let previous=latestObservations((await loadJournal()).journal.observations).get(f.fixture_id);
        if(winner&&!previous?.series_void){
          const oldWinner=previous?.series_score?(previous.series_score[0]>previous.series_score[1]?'a':'b'):previous?.series_winner;
          if(oldWinner&&oldWinner!==winner.winner)throw new Error('Победитель OpenDota противоречит записанному результату; нужна отдельная проверка.');
          if(!oldWinner){
            const saved=await recordResult({fixture_id:f.fixture_id,series_winner:winner.winner,winner_map_ids:winner.map_ids,sources:winner.sources,...(previous?{supersedes:previous.observation_id}:{}),note:'Победитель BO3: две подтверждённые победы одной команды в одной серии Valve. Точный счёт и номер карты этим не устанавливаются.'},'automatic-winner');
            added+=saved.inserted_observations;
          }
        }
        const dates=[...new Set([Date.parse(f.scheduled_start_utc),Date.parse(f.scheduled_start_utc)+8*3600000].map(t=>new Date(t).toISOString().slice(0,10)))];
        const rows=new Map<number,Record<string,any>>();
        for(const day of dates)for(const row of resultRows(await get(HAWK_RESULTS+day)))if(resultOrientation(row,f)!==null)rows.set(row.id,row);
        if(rows.size!==1)throw new Error(rows.size?'Несколько подходящих серий: нужен точный источник.':'В источнике пока нет завершённой серии с этой парой и временем.');
        const row=[...rows.values()][0],page=await get(resultUrl(row));
        previous=latestObservations((await loadJournal()).journal.observations).get(f.fixture_id);
        if(!previous?.map1_void&&(!previous?.map1?.match_id||previous.map1.kills_a==null||previous.map1.kills_b==null||previous.map1.duration_seconds==null)){
          // A known first map must not wait for a missing later map.
          const firstMap=verifiedFirstMap(row,page,f,[...maps.values()],Date.now());
          if(mapEvidenceConflicts(previous,firstMap))throw new Error('Подтверждённая первая карта противоречит журналу.');
          const saved=await recordResult({fixture_id:f.fixture_id,map1:firstMap,sources:[resultUrl(row),'https://www.opendota.com/matches/'+firstMap.match_id],...(previous?{supersedes:previous.observation_id}:{}),note:'Карта 1 подтверждена отдельно: номер, команды по Valve ID, игроки, финальные убийства и длительность. Остальные карты не требуются для её тоталов.'},'automatic-map1');
          added+=saved.inserted_observations;
        }
        const proof=verifiedResult(row,page,f,[...maps.values()],Date.now());
        const current=await loadJournal();previous=latestObservations(current.journal.observations).get(f.fixture_id);
        const first=maps.get(proof.map_ids[0])!,aRadiant=first.radiant_team_id===ids[0];
        const map1={match_id:first.id,kills_a:aRadiant?first.radiant_kills:first.dire_kills,kills_b:aRadiant?first.dire_kills:first.radiant_kills,duration_seconds:first.duration_seconds};
        if(previous?.series_void||previous?.map1_void||previous?.series_winner&&previous.series_winner!==(proof.score[0]>proof.score[1]?'a':'b')||previous?.series_score&&canonical(previous.series_score)!==canonical(proof.score)||mapEvidenceConflicts(previous,map1))throw new Error('Новый источник противоречит записанному результату; автоматическое исправление запрещено.');
        const verified=(f.best_of??3)===3?confirmSeries(historyFromMatches(historySeed as AnalysisHistory,[...maps.values()],current.journal),proof):null;
        if(!previous?.series_score||!previous?.map1?.match_id||previous.map1.kills_a==null||previous.map1.kills_b==null||previous.map1.duration_seconds==null){
          const r=await recordResult({fixture_id:f.fixture_id,series_score:proof.score,map1,sources:[proof.source_url,...proof.map_ids.map(id=>'https://www.opendota.com/matches/'+id)],...(previous?{supersedes:previous.observation_id}:{}),note:'Автоматически: полный счёт и порядок карт Hawk Live сверены с Valve ID обеих команд, десятью игроками, победителями, убийствами и длительностью каждой карты OpenDota.'},'automatic-result');added+=r.inserted_observations;
        }
        if(verified){
          await db.prepare('INSERT OR IGNORE INTO dota_analysis_records(key,payload,updated_utc) VALUES(?,?,?)').bind('verified:'+verified[0].series_key,canonical(verified),new Date().toISOString()).run();
        }
        Object.assign(check,{status:'confirmed',reason:'Итог серии и все сыгранные карты подтверждены.',map_ids:proof.map_ids,score:proof.score,source_url:proof.source_url});
        check.name_warnings=proof.map_ids.flatMap(id=>{const m=maps.get(id)!;return [[m.radiant_team_id,m.radiant_name],[m.dire_team_id,m.dire_name]].flatMap(([id,name])=>name&&name!==(id===ids[0]?f.team_a:f.team_b)?[`Valve ID ${id}: в OpenDota название «${name}»; ID совпадает.`]:[]);});
      }catch(e){check.reason=e instanceof Error?e.message:'Проверка результата не завершена.';}
      const final=latestObservations((await loadJournal()).journal.observations).get(f.fixture_id);
      if(final?.series_winner&&!final.series_void){check.winner=final.series_winner==='a'?f.team_a:f.team_b;if(check.status!=='confirmed')check.reason=`Победитель ${check.winner} подтверждён; ставки на победу рассчитаны. ${check.reason}`;}
      check.market_status=journal.forecasts.filter(x=>x.fixture_id===f.fixture_id).map(x=>({market:x.label,status:settle(x,final).status}));
      checks.push(check);
    }
    await record('state:result_checks',[...oldChecks.filter(c=>!checks.some(x=>x.fixture_id===c.fixture_id)),...checks].slice(-500));
    const report={status:checks.some(c=>c.status!=='confirmed')?'partial':'ok',at:new Date().toISOString(),observations_added:added,maps_added:mapsAdded,opendota_requests:recovery.requests,source_requests:pages.size,warnings:recovery.warnings,queue_count:recovery.queue.length,checks};
    // Retry even if no new observation this cycle: a previous ranking write
    // may have failed after the result itself was already saved.
    if(inFlightOpenDotaRequests===undefined)await refreshRankingAfterResults();
    await record('results:last',report);return report;
  }finally{await db.prepare("DELETE FROM dota_analysis_lease WHERE id='results' AND owner=?").bind(owner).run();}
}
