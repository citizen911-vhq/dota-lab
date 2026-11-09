"use client";
import { useEffect, useState } from 'react';
import { RefreshCw, Info } from 'lucide-react';
interface Run { at: string; status: string; reason: string; bets_added: number; quotes_added: number; skipped: string[]; coverage: {events_received: number; fresh_events: number; events: {event_id: string; team_a: string; team_b: string; markets: string[]}[]} | null }
interface AutoStatus {provider: string; enabled: boolean; cadence: string; policy: string; limitation: string; last_run: Run | null}
async function api(method = 'GET') { const r = await fetch('/api/paper/automatic', {method, cache: 'no-store', ...(method === 'POST' ? {headers: {'Content-Type':'application/json'}, body:'{}'} : {})}); const d = await r.json() as AutoStatus & {reason?: string; error?: string}; if (!r.ok) throw new Error(d.error || 'Источник временно недоступен.'); return d; }
export default function AutomaticOdds({onUpdated, refreshKey}: {onUpdated: () => Promise<void>; refreshKey: number}) {
 const [data,setData] = useState<AutoStatus|null>(null),[busy,setBusy] = useState(false),[message,setMessage] = useState('');
 useEffect(()=>{let active=true;api().then(d=>{if(active)setData(d);}).catch(()=>{if(active)setMessage('Не удалось загрузить состояние источника.');});return ()=>{active=false;};},[refreshKey]);
 const run=async()=>{setBusy(true);setMessage('');try{const result=await api('POST');setMessage(result.reason ?? 'Проверка выполнена.');setData(await api());await onUpdated();}catch(e){setMessage(e instanceof Error?e.message:'Не удалось обновить линию.');}finally{setBusy(false);}};
 const last=data?.last_run;
 return <section className="panel paper-quote-panel">
  <div className="panel-heading"><div><h2>Автоматическая линия · OddsLink</h2><p>Победитель серии, форы по картам и тоталы убийств карты 1</p></div><button className="button button-light" onClick={run} disabled={busy || !data?.enabled}><RefreshCw size={15} className={busy?'spin':''}/>{busy?'Проверяем линию…':'Проверить линию'}</button></div>
  <div className="paper-notice"><Info size={16}/><p>{data?.enabled ? 'Включено: бесплатный гостевой доступ, без ключа и платной подписки.' : data ? 'Автоматические ставки выключены.' : 'Проверяем подключение…'} {data?.cadence}</p></div>
  {message && <p role="status" className="paper-future-note">{message}</p>}
  {last && <div className="paper-future-note"><div><strong>{last.status==='ok'?'Последняя загрузка выполнена':'Последняя загрузка не завершена'} · {new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Yakutsk',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(last.at))} (Якутск)</strong><p>{last.coverage ? `Событий: ${last.coverage.events_received}. Со свежей линией разрешённых букмекеров: ${last.coverage.fresh_events}. ` : ''}Записано виртуальных ставок: {last.bets_added}. {last.reason}</p></div></div>}
  {!!last?.skipped?.length && <details className="paper-method"><summary>Почему пропущены ставки ({last.skipped.length})</summary><ul>{last.skipped.map((s,i)=><li key={i}>{s}</li>)}</ul></details>}
  <details className="paper-method"><summary>Правила автоматического теста</summary><p>{data?.policy} После подтверждения результата ежедневным сбором банк, ROI и просадка пересчитываются автоматически.</p><p>{data?.limitation} Длительность 41:00 источник не предоставляет. Обменные рынки исключены. Ставки остаются только виртуальными.</p><p>Приоритет источников цен фиксирован: Pinnacle → 1xBet → Thunderpick → bet365 → Stake. Цена выбирается только для уже сохранённого прогноза; нет линии — нет ставки.</p><a href="https://oddslink.app/docs/api-reference/operations/runtryit/" target="_blank" rel="noreferrer">Документация гостевого доступа</a></details>
 </section>;
}
