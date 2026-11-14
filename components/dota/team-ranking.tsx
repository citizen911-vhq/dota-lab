"use client";
import {DISPLAY_TIME_ZONE} from '@/lib/dota-display-time';
import {useCallback,useEffect,useState} from 'react';
import {Info,RefreshCw} from 'lucide-react';
import type {ExpansionSnapshot,ExpansionRow} from '@/lib/dota-expansion';
type Point={at:string;teams:{team_id:string;rank:number|null;win_rate:number|null;status:string}[]};
type Snapshot={expansion:ExpansionSnapshot;ranking_history:Point[];history_queue:string[];exclusions:{fixture_id:string|null;fixture:string;reason:string}[];patch_name:string|null;patch_fresh:boolean;history_verified_at:string|null;history_healthy:boolean};
const date=(s:string|null)=>s?new Intl.DateTimeFormat('ru-RU',{timeZone:DISPLAY_TIME_ZONE,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(s)):'нет данных';
const pct=(v:number|null)=>v==null?'—':(v*100).toFixed(1).replace('.',',')+'%';
const statuses={core:'Ядро',admitted:'Допущена',candidate:'Кандидат',insufficient:'Мало карт',watch:'Наблюдение'};
const cell={padding:'14px 16px',borderBottom:'1px solid #edf0e9'};
export default function TeamRanking({refreshKey}:{refreshKey:string}){
  const[data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState('');
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    setBusy(true);setError('');
    try{const r=await fetch('/api/ranking',{cache:'no-store',signal});const j=await r.json() as Snapshot&{error?:string};if(!r.ok||!j.expansion)throw new Error(j.error||'Рейтинг пока недоступен');setData(j);}
    catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить рейтинг');}
    finally{if(!signal?.aborted)setBusy(false);}
  },[]);
  useEffect(()=>{const c=new AbortController();void refresh(c.signal);const t=setInterval(()=>void refresh(c.signal),60000);return()=>{c.abort();clearInterval(t);};},[refresh,refreshKey]);
  const table=(rows:ExpansionRow[])=><div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:900}}>
    <thead><tr>{['Место','Команда','Карты против топов','WR против топов','Скорр. WR¹','Статус'].map(x=><th key={x} scope="col" style={{...cell,textAlign:'left'}}>{x}</th>)}</tr></thead>
    <tbody>{rows.map(t=>{
      const old=data?.ranking_history.find(s=>s.at<data.expansion.at)?.teams.find(r=>r.team_id===t.team_id);
      const movement=t.rank!=null&&old?.rank!=null?old.rank-t.rank:0;
      return <tr key={t.team_id}><td style={cell}>{t.rank??'—'}{movement!==0&&<small style={{display:'block'}}>{movement>0?'↑':'↓'}{Math.abs(movement)}</small>}</td>
        <th scope="row" style={{...cell,textAlign:'left'}}><button className="text-button" onClick={()=>setSelected(t.team_id)}>{t.team}</button><small style={{display:'block'}}>Valve ID: {t.team_id}</small></th>
        <td style={cell}>{t.maps}/30<small style={{display:'block'}}>{t.wins} побед · {t.losses} поражений</small></td>
        <td style={cell}>{pct(t.win_rate)}</td><td style={cell}><strong>{t.maps?pct(t.score):'—'}</strong></td>
        <td style={cell}>{statuses[t.status]}<small style={{display:'block',maxWidth:260}}>{t.reason}</small></td></tr>;
    })}</tbody></table></div>;
  return <section className="panel">
    <div className="panel-heading"><div><h2>Динамический TOP-20</h2><p>12 команд ядра + до 8 допущенных претендентов</p></div><button className="text-button" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={16}/>{busy?'Загрузка…':'Обновить'}</button></div>
    {error&&<div className="inline-note" role="alert"><Info size={16}/>{error}</div>}
    {!data&&!error&&<p role="status" style={{padding:24}}>Загружаем рейтинг…</p>}
    {data&&<>
      {(!data.patch_fresh||!data.history_healthy||!data.expansion.healthy)&&<div className="inline-note"><Info size={16}/><span>Справочный снимок: требуется успешное обновление анализа. Новые допуски и ставки по неполным данным запрещены.</span></div>}
      <p style={{padding:'0 24px'}}>Патч {data.patch_name??'не подтверждён'} · скользящие 30 дней · до 30 последних подходящих карт. Допущено {data.expansion.active_ids.length}/20.</p>
      <p style={{padding:'0 24px'}}>Рейтинг пересчитывается после новых завершённых карт или исправления результатов. Без новых данных позиции сохраняются: возраст снимка сам по себе не блокирует прогноз. Порог 15 карт против топов — только для входа в TOP-20; в прогнозе и виртуальной ставке недостаток таких игр отмечается предупреждением.</p>
      {table(data.expansion.rows.filter(t=>t.rank!==null))}
      <details style={{padding:24}} open><summary>Кандидаты и наблюдение · {data.expansion.rows.filter(t=>t.rank===null).length}</summary>{table(data.expansion.rows.filter(t=>t.rank===null))}</details>
      <div style={{padding:24}}><p>¹ Скорректированный WR учитывает силу соперника, давность и объём выборки. Новые команды: минимум 15 карт против топов, оценка ≥50%, не более 8 дополнительных мест. Это экспериментальный рейтинг, не вероятность победы в следующем матче.</p>
      <p>Ядро занимает места 1–12; расширение — 13–20. Матчи против нового топа учитываются только после его допуска. Изменения состава остаются информационными. Неподходящие команды переходят в наблюдение; история не удаляется.</p>
      <p>Рейтинг и прогноз — разные выборки. Требование 15 карт против топов относится только к входу в TOP-20. Для анализа матча с командой пула сопернику не нужно место в рейтинге: после проверки Valve ID и загрузки истории используются до 30 его последних пригодных карт текущего патча с 1 сентября 2026 года, против любых команд. Пустая или непроверенная история не даёт прогноз.</p>
      <p>Очередь сбора истории: {data.history_queue.length} команд. Не более 8 дополнительных команд и 12 подробных запросов карт за цикл.</p>
      <label>История команды <select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Выберите команду</option>{data.expansion.rows.map(t=><option key={t.team_id} value={t.team_id}>{t.team}</option>)}</select></label>
      {selected&&<ul>{data.ranking_history.map(s=>{const t=s.teams.find(t=>t.team_id===selected);return t?<li key={s.at}>{date(s.at)} · место {t.rank??'—'} · WR {pct(t.win_rate)} · {statuses[t.status as keyof typeof statuses]??t.status}</li>:null;})}</ul>}
      <details><summary>Почему матчи исключены · {data.exclusions.length}</summary><ul>{data.exclusions.map((x,i)=><li key={String(x.fixture_id)+i}>{x.fixture}: {x.reason}</li>)}</ul></details>
      <small>История проверена: {date(data.history_verified_at)} · снимок рейтинга: {date(data.expansion.at)} · МСК. Кнопка перечитывает таблицу; новые карты загружает запуск анализа.</small></div>
    </>}
  </section>;
}
