import type {Forecast} from './dota-types';
import {forecastTeamIds} from './dota-auto-core';
import {normalizeResultMap,type NormalizedMatch} from './dota-opendota';
type Row=Record<string,any>;
export type ResultMapQueue={id:string;rows:Row[];sources:string[]};
export async function recoverResultMaps(fixtures:Forecast[],existing:NormalizedMatch[],queue:ResultMapQueue[],apiKey:string|undefined,budget:number,now=Date.now(),fetcher:typeof fetch=fetch){
  let requests=0,stopped=false;const warnings:string[]=[],candidates=new Map<string,ResultMapQueue>();
  const matches:NormalizedMatch[]=[],cache=new Map<string,unknown>();
  const pairMatches=(r:Row,f:Forecast)=>{
    const ids=forecastTeamIds(f);const pair=[String(r.radiant_team_id),String(r.dire_team_id)];
    return ids&&ids.every(id=>pair.includes(id))&&pair[0]!==pair[1]&&Number.isSafeInteger(r.start_time)&&r.start_time*1000>=Date.parse(f.scheduled_start_utc)-900000&&r.start_time*1000<=Math.min(now,Date.parse(f.scheduled_start_utc)+8*3600000);
  };
  const known=new Set(existing.filter(m=>!m.context_conflict&&m.players.radiant.length===5&&m.players.dire.length===5&&m.series_id!=null).map(m=>m.id));
  function add(row:Row,source:string){
    const id=String(row.match_id);
    if(!/^[1-9]\d*$/.test(id)||known.has(id)||!fixtures.some(f=>pairMatches(row,f)))return;
    const prior=candidates.get(id)??{id,rows:[],sources:[]};
    if(!prior.rows.some(r=>JSON.stringify(r)===JSON.stringify(row)))prior.rows.push(row);
    prior.rows=prior.rows.slice(-8);prior.sources=[...new Set([...prior.sources,source])];candidates.set(id,prior);
  }
  for(const q of queue)for(const row of q.rows)for(const source of q.sources)if(/^https:\/\/api\.opendota\.com\/api\//.test(source))add(row,source);
  async function get(path:string):Promise<any>{
    if(cache.has(path))return cache.get(path);
    if(stopped||requests>=Math.min(budget,24)){warnings.push('Догрузка результатов: достигнут лимит запросов; очередь сохранена.');return null;}
    requests++;
    try{
      const r=await fetcher('https://api.opendota.com/api/'+path,{redirect:'manual',signal:AbortSignal.timeout(6000),headers:{Accept:'application/json',...(apiKey?.trim()?{Authorization:`Bearer ${apiKey.trim()}`}:{})}});
      if([401,403,429].includes(r.status))stopped=true;
      if(!r.ok||r.redirected){await r.body?.cancel();throw new Error('HTTP');}
      const text=await r.text();if(text.length>4_000_000)throw new Error('Size');
      const data=JSON.parse(text);cache.set(path,data);return data;
    }catch{warnings.push(`OpenDota: не удалось проверить ${path}; повтор в следующем цикле.`);cache.set(path,null);return null;}
  }
  const leagues=new Set<string>();
  for(const f of fixtures){
    for(const id of forecastTeamIds(f)??[]){
      const path=`teams/${id}/matches`,rows=await get(path);
      if(!Array.isArray(rows))continue;
      for(const row of rows){
        if(!row||typeof row!=='object')continue;
        const normalized=typeof row.radiant==='boolean'?{...row,radiant_team_id:row.radiant?id:row.opposing_team_id,dire_team_id:row.radiant?row.opposing_team_id:id}:row;
        add(normalized,'https://api.opendota.com/api/'+path);
        if(pairMatches(normalized,f)&&/^[1-9]\d*$/.test(String(row.leagueid)))leagues.add(String(row.leagueid));
      }
    }
    for(const m of existing)if(pairMatches({...m,radiant_team_id:m.radiant_team_id,dire_team_id:m.dire_team_id},f))leagues.add(m.league_id);
  }
  for(const id of [...leagues].slice(0,4)){
    const path=`leagues/${id}/matches`,rows=await get(path);
    if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object')add(row,'https://api.opendota.com/api/'+path);
  }
  const accepted=new Set<string>();
  for(const q of [...candidates.values()].slice(0,12)){
    const raw=await get(`matches/${q.id}`);
    const match=normalizeResultMap(raw,q.id,fixtures.flatMap(f=>forecastTeamIds(f)??[]),q.rows,q.sources,now,warnings);
    if(match){matches.push(match);accepted.add(q.id);}
  }
  // Keep work for other pending fixtures too; four-series batches must not erase it.
  const remaining=new Map(queue.filter(q=>!known.has(q.id)&&!accepted.has(q.id)).map(q=>[q.id,q]));
  for(const q of candidates.values())if(!accepted.has(q.id))remaining.set(q.id,q);
  return {matches,requests,warnings:[...new Set(warnings)],queue:[...remaining.values()].slice(0,500)};
}
