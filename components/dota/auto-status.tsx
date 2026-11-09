"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import {Activity, CalendarClock, CheckCircle2, ChevronDown, Clock3, Info, LoaderCircle, RefreshCw} from 'lucide-react';

interface AnalysisRun {
  run_id: string;
  status: 'ok' | 'partial' | 'failed' | 'running';
  started_at: string;
  finished_at?: string | null;
  maps_added: number;
  forecasts_added: number;
  observations_added: number;
  fixtures_seen: number;
  backlog_count: number;
  source_requests: number;
  warnings: string[];
  skipped: Array<{fixture: string; reason: string}>;
  history_maps: number;
}

interface AnalysisStatus {
  coverage: 'partial';
  tracked_teams: number;
  history_maps: number;
  schedule: {enabled: boolean; id?: string; time?: string; timezone?: string; until?: string} | null;
  last_run: AnalysisRun | null;
  recent_runs: AnalysisRun[];
  roster_alerts: Record<string, string>;
}

const runLabels: Record<AnalysisRun['status'], string> = {
  ok: 'Проверка завершена', partial: 'Обновлено частично', failed: 'Обновление не завершено', running: 'Анализ выполняется',
};

function date(value?: string | null, withTime = true, timezone = 'Asia/Yakutsk') {
  if (!value || !Number.isFinite(Date.parse(value))) return 'дата не указана';
  try {
    return new Intl.DateTimeFormat('ru-RU', {timeZone: timezone, day: 'numeric', month: 'long', ...(withTime ? {hour: '2-digit', minute: '2-digit'} as const : {})}).format(new Date(value));
  } catch { return 'дата не указана'; }
}

function number(value?: number) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—'; }

function scheduleLabel(schedule: AnalysisStatus['schedule']) {
  if (!schedule?.enabled) return 'Расписание ещё не включено';
  const time = schedule.time || '17:00';
  const timezone = schedule.timezone || 'Asia/Yakutsk';
  return `Ежедневно в ${time} · ${timezone === 'Asia/Yakutsk' ? 'Якутск' : timezone}`;
}

export default function AutoStatus({onUpdated}: {onUpdated: () => Promise<void>}) {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const previousRunning = useRef(false);

  const refreshStatus = useCallback(async () => {
    const response = await fetch('/api/analysis/status', {cache: 'no-store'});
    const payload = await response.json() as Partial<AnalysisStatus> & {error?: string};
    if (!response.ok) throw new Error(payload?.error || 'Не удалось проверить состояние анализа.');
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.recent_runs)) throw new Error('Не удалось прочитать состояние анализа. Попробуйте ещё раз.');
    if (mounted.current) {
      setStatus(payload as AnalysisStatus);
      setError('');
    }
    return payload as AnalysisStatus;
  }, []);

  useEffect(() => {
    mounted.current = true;
    refreshStatus().catch(e => {if (mounted.current) setError(e instanceof Error ? e.message : 'Не удалось проверить состояние анализа.');}).finally(() => {if (mounted.current) setLoading(false);});
    return () => {mounted.current = false;};
  }, [refreshStatus]);

  // A cloud run may already be in progress when the page is opened.
  useEffect(() => {
    const isRunning = status?.last_run?.status === 'running';
    if (!isRunning) {
      if (previousRunning.current) void onUpdated();
      previousRunning.current = false;
      return;
    }
    previousRunning.current = true;
    const timer = setTimeout(() => {
      refreshStatus().catch(e => {if (mounted.current) setError(e instanceof Error ? e.message : 'Не удалось проверить завершение анализа.');});
    }, 5_000);
    return () => clearTimeout(timer);
  }, [status, refreshStatus, onUpdated]);

  const run = async () => {
    if (pending || status?.last_run?.status === 'running') return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/analysis/run', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
      const payload = await response.json() as {error?: string};
      if (!response.ok) throw new Error(payload?.error || 'Не удалось запустить анализ. Попробуйте ещё раз.');
      const updated = await refreshStatus();
      await onUpdated();
      if (mounted.current) setNotice(updated.last_run?.status === 'running' ? 'Проверка продолжается. Результат появится здесь.' : updated.last_run?.status === 'failed' ? 'Проверка завершилась с ошибкой. Причины указаны ниже.' : 'Журнал обновлён. Сохранённые прогнозы остаются в истории.');
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Не удалось завершить обновление.');
    } finally { if (mounted.current) setPending(false); }
  };

  const last = status?.last_run;
  const running = pending || last?.status === 'running';
  const warnings = last?.warnings || [];
  const skipped = last?.skipped || [];
  const rosterAlerts = Object.entries(status?.roster_alerts || {});
  const hasDetails = warnings.length > 0 || skipped.length > 0 || rosterAlerts.length > 0;

  return <section className="panel auto-status" aria-labelledby="auto-status-title">
    <div className="auto-status-heading">
      <div className="auto-status-title"><span className="auto-status-icon"><Activity size={20}/></span><div><h2 id="auto-status-title">Автоматический анализ</h2><p>Новые карты, прогнозы и проверка результатов</p></div></div>
      <button className="button button-primary auto-status-run" onClick={run} disabled={loading || running}>{running ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>}<span>{running ? 'Проверяем матчи…' : 'Обновить анализ'}</span></button>
    </div>

    <div className="auto-status-schedule"><CalendarClock size={17}/><div><strong>{loading ? 'Проверяем расписание…' : status ? scheduleLabel(status.schedule) : 'Состояние расписания недоступно'}</strong>{status?.schedule?.enabled && <span>{status.schedule.until ? `До ${date(status.schedule.until, false)} · работает, даже когда приложение закрыто` : 'Работает, даже когда приложение закрыто'}</span>}{status && !status.schedule?.enabled && <span>Анализ можно запустить кнопкой выше.</span>}</div>{status && <span className={`auto-status-pill ${status.schedule?.enabled ? 'active' : 'paused'}`}>{status.schedule?.enabled ? 'Включено' : 'Не включено'}</span>}</div>

    <div className="auto-status-body" aria-live="polite" aria-busy={running}>
      {loading ? <div className="auto-status-loading"><LoaderCircle size={16} className="spin"/>Загружаем состояние анализа</div> : <>
        <div className="auto-status-runline"><div>{running ? <LoaderCircle size={15} className="spin"/> : last?.status === 'ok' ? <CheckCircle2 size={15}/> : <Clock3 size={15}/>}<strong>{running ? 'Собираем карты и проверяем журнал' : last ? runLabels[last.status] : status ? 'Первый запуск ещё не выполнен' : 'Состояние последней проверки недоступно'}</strong></div>{last && <span>{date(last.finished_at || last.started_at)} · Якутск</span>}</div>
        {running && <p className="auto-status-progress">Обновление может занять около минуты. Новые прогнозы появятся только для подтверждённых будущих серий.</p>}
        <div className="auto-status-counts"><div><strong>{number(status?.history_maps)}</strong><span>карт в истории</span></div><div><strong>{last ? `+${number(last.maps_added)}` : '—'}</strong><span>новых карт</span></div><div><strong>{last ? `+${number(last.forecasts_added)}` : '—'}</strong><span>новых прогнозов</span></div><div><strong>{last ? `+${number(last.observations_added)}` : '—'}</strong><span>записей результатов</span></div></div>
        {last && <p className="auto-status-small">Серий проверено: {number(last.fixtures_seen)}{last.backlog_count > 0 ? ` · Осталось проверить: ${number(last.backlog_count)}` : ''}{status ? ` · Команд в исследовании: ${number(status.tracked_teams)}` : ''}</p>}
      </>}
      {error && <div className="auto-status-error" role="alert"><Info size={16}/><span>{error}</span><button className="text-button" onClick={() => {setLoading(true); refreshStatus().catch(e => setError(e instanceof Error ? e.message : 'Не удалось обновить состояние.')).finally(() => setLoading(false));}}>Проверить снова</button></div>}
      {notice && !error && <p className="auto-status-notice" role="status">{notice}</p>}
    </div>

    <div className="auto-status-coverage"><Info size={16}/><p><strong>Расписание покрыто частично.</strong> Автоматическая лента охватывает турниры tier 1–2 и может отставать до трёх часов. Матчи DreamLeague добавляются после отдельной проверки расписания на CyberScore.</p></div>
    {hasDetails && <details className="auto-status-details"><summary><span>Ограничения и пропущенные матчи <span className="count-chip">{warnings.length + skipped.length + rosterAlerts.length}</span></span><ChevronDown size={16}/></summary><div className="auto-status-detail-content">{warnings.length > 0 && <ul>{warnings.map((warning, i) => <li key={`warning-${i}`}>{warning}</li>)}</ul>}{rosterAlerts.length > 0 && <div className="auto-status-rosters"><h3>Изменения составов</h3><ul>{rosterAlerts.map(([id, message]) => <li key={id}>{message}</li>)}</ul></div>}{skipped.length > 0 && <div className="auto-status-skipped"><h3>Прогноз не выпущен</h3>{skipped.map((item, i) => <div key={`${item.fixture}-${i}`}><strong>{item.fixture}</strong><p>{item.reason}</p></div>)}</div>}</div></details>}
  </section>;
}
