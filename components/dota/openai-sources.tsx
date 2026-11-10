"use client";
import {useEffect,useState} from 'react';
import {LoaderCircle,Search,ExternalLink} from 'lucide-react';
import type {SearchReport} from '@/lib/dota-openai';
type Status={key_configured:boolean;last_run:SearchReport|null};
export default function OpenaiSources(){
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  async function read(){const r=await fetch('/api/openai',{cache:'no-store'});if(!r.ok)throw Error('Не удалось проверить подключение OpenAI.');return await r.json() as Status;}
  useEffect(()=>{let active=true;void read().then(s=>{if(active)setStatus(s);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  async function search(){
    setBusy(true);setError('');setMessage('');
    try{const r=await fetch('/api/openai',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('Не удалось завершить поиск. Проверьте статус позже: повторный запрос сегодня не расходует API.');const result=await r.json() as {reason?:string};setMessage(result.reason??'');setStatus(await read());}
    catch(e){setError(e instanceof Error?e.message:'Поиск недоступен.');}finally{setBusy(false);}
  }
  const report=status?.last_run;
  return <section className="panel paper-quote-panel">
    <div className="panel-heading"><div><h2>Поиск открытых источников</h2><p>{status?status.key_configured?'Серверный ключ OpenAI настроен':'Серверный ключ OpenAI не настроен':'Проверяем подключение…'}</p></div><button className="button button-light" disabled={busy||!status?.key_configured} onClick={search}>{busy?<LoaderCircle size={16} className="spin"/>:<Search size={16}/>} {busy?'Ищем источники…':'Найти коэффициенты'}</button></div>
    <p className="paper-form-lead">Поиск запускается отдельно этой кнопкой: не более одной попытки в день по Якутску. Использует баланс OpenAI API. Десятиминутная проверка линии его не вызывает. Повторное нажатие показывает сохранённый отчёт.</p>
    <div className="paper-notice"><p>Это поисковый отчёт, а не подтверждённая линия. Свежесть цены, время начала и правила рынка проверяются отдельно. Найденный текст не создаёт прогнозы или виртуальные ставки.</p></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {message&&<p className="paper-form-lead" role="status">{message}</p>}
    {report&&<div style={{marginTop:16}}>
      <p className="paper-form-lead">{new Date(report.at).toLocaleString('ru-RU',{timeZone:'Asia/Yakutsk'})} · Якутск · {report.status==='completed'?'Ответ OpenAI получен':report.status==='running'?'Попытка зарегистрирована; результат пока не получен':'Поиск не завершён'}</p>
      <p className="paper-form-lead">{report.reason}</p>
      {report.text&&<details><summary style={{cursor:'pointer',fontWeight:600}}>Посмотреть отчёт и источники</summary><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',lineHeight:1.65}}>{report.text}</p><ul>{report.sources.map(s=><li key={s.url}><a className="paper-source" href={s.url} target="_blank" rel="noreferrer">{s.title} <ExternalLink size={13}/></a></li>)}</ul></details>}
      <p className="paper-form-lead">Поисковых вызовов: {report.search_calls} · Подтверждённых коэффициентов: 0 · Ставок из отчёта: 0</p>
    </div>}
  </section>;
}
