"use client";

import { useRef, useState } from 'react';
import { LoaderCircle, Play } from 'lucide-react';

type AnalysisReport = {
  status: string; maps_added: number; observations_added: number; forecasts_added: number;
  backlog_count: number; warnings: string[];
  skipped: {fixture: string; reason: string}[];
  paper?: {status: string; reason: string; bets_added: number; quotes_added: number; skipped?: string[]};
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const payload = await response.json() as {error?:string};
  if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить проверку.');
  return payload as T;
}

export default function MasterRun({onUpdated}: {onUpdated: () => Promise<void>}) {
  const active = useRef(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [research, setResearch] = useState('');
  const [error, setError] = useState('');
  async function run() {
    if (active.current) return;
    active.current = true;
    setRunning(true); setReport(null); setError(''); setResearch('');
    try {
      setPhase('История → результаты → прогнозы → коэффициенты и ставки…');
      try {
        const result = await post<AnalysisReport>('/api/analysis/run', {research:false, force_refresh:true});
        setReport(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Цикл анализа прерван.');
      }
      setPhase('Исследование открытых источников…');
      try {
        const search = await post<{reason?:string; cached?:boolean; report?:{status:string; reason?:string} | null}>('/api/openai', {force_refresh:true});
        setResearch(search.reason || search.report?.reason || (search.report?.status === 'ok' ? 'Исследование завершено.' : `Статус: ${search.report?.status || 'нет результата'}`));
      } catch {
        setResearch('Исследование недоступно. Результаты остальных проверок сохранены.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Цикл прерван.');
    } finally {
      setPhase('Обновляем журнал и банк…');
      try { await onUpdated(); } catch { setError('Не удалось обновить экран. Проверьте состояние анализа перед повторным запуском.'); }
      setRunning(false); active.current = false; setPhase('');
    }
  }
  return <section className="master-run" aria-label="Полный цикл анализа">
    <button className="button master-run-button" onClick={run} disabled={running} aria-busy={running}>
      {running ? <LoaderCircle size={17} className="spin"/> : <Play size={17}/>}
      {running ? 'Проверки выполняются…' : 'Запустить все проверки'}
    </button>
    <details className="master-run-details">
    <summary>Подробности</summary>
    <p>Ручной полный цикл без ожидания интервалов: история, результаты, прогнозы, линия, виртуальные ставки и OpenAI. Каждый запуск расходует доступную квоту API. Защитные бюджеты и проверки ставок сохраняются.</p>
    <div role="status" aria-live="polite">
      {phase && <p>{phase}</p>}
      {error && <p role="alert">{error}</p>}
      {report && <details open>
        <summary>{report.status === 'ok' ? 'Цикл завершён' : report.status === 'failed' ? 'Анализ не завершён' : 'Цикл завершён с замечаниями'}</summary>
        <p>Новых карт: {report.maps_added}. Результатов: {report.observations_added}. Прогнозов: {report.forecasts_added}. В очереди: {report.backlog_count}.</p>
        <p>Коэффициентов: {report.paper?.quotes_added ?? 0}. Ставок: {report.paper?.bets_added ?? 0}. {report.paper?.reason}</p>
        {!!report.paper?.skipped?.length && <details><summary>Почему ставки пропущены ({report.paper.skipped.length})</summary><ul>{report.paper.skipped.map((reason,i)=><li key={i}>{reason}</li>)}</ul></details>}
        {!!report.warnings?.length && <details><summary>Предупреждения ({report.warnings.length})</summary><ul>{report.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
        {!!report.skipped?.length && <details><summary>Пропущенные матчи ({report.skipped.length})</summary><ul>{report.skipped.map((s,i)=><li key={i}>{s.fixture}: {s.reason}</li>)}</ul></details>}
      </details>}
      {research && <p>OpenAI: {research}</p>}
    </div>
    </details>
  </section>;
}
