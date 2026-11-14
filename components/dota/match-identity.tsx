type MatchIdentityProps = {team_a:string;team_b:string;team_a_id?:unknown;team_b_id?:unknown;pool_warnings?:string[]};

/** Names are presentation; persisted Valve IDs identify the teams. */
export default function MatchIdentity(match:MatchIdentityProps){
  return <div className="match-identity" aria-label={`${match.team_a} — ${match.team_b}`}>
    {[['a',match.team_a,match.team_a_id],['b',match.team_b,match.team_b_id]].map(([side,name,id],index)=><div className="match-identity-side" key={String(side)}>
      {index===1&&<span className="match-identity-separator" aria-hidden="true">—</span>}
      <div className="match-identity-team"><strong>{String(name)}</strong><small>{/^[1-9]\d*$/.test(String(id))?`Valve ID ${id}`:'Valve ID не подтверждён'}</small></div>
    </div>)}
    {!!match.pool_warnings?.length&&<span className="tiny-warning" style={{flexBasis:'100%'}} title={match.pool_warnings.join('\n')}>Мало игр против топов · эксперимент*</span>}
  </div>;
}
