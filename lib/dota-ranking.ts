import type { TeamRating } from './dota-analysis-types';

/** Display-only ranking of the approved pool, never a betting authorization. */
export function rankPrimaryTeams(pool: {id:string;name:string}[], ratings:TeamRating[]){
  return pool.map(team=>{
    const r=ratings.find(r=>r.team_id===team.id);
    const maps=r?.maps??0;
    return {team_id:team.id,team:team.name,rating:maps?r!.rating:null,maps,wins:r?.wins??0,losses:r?.losses??0,win_rate:maps?r!.wins/maps:null};
  }).sort((a,b)=>(b.rating??-Infinity)-(a.rating??-Infinity)||b.maps-a.maps||a.team_id.localeCompare(b.team_id))
    .map((team,index)=>({...team,rank:team.maps?index+1:null}));
}
