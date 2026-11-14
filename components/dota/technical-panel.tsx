"use client";

import { useEffect, useRef, useState } from 'react';
import { Bug, Check, ClipboardCopy, Download, Info, LoaderCircle, RefreshCw, Send, ShieldCheck, Sparkles } from 'lucide-react';
import type { TechnicalDashboard } from '@/lib/dota-technical-types';

const date = (value: string) => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) + ' МСК'
  : 'Время не указано';
const sourceName = { server: 'Сервер', browser: 'Интерфейс', provider: 'Внешний API' };
type BridgeStatus = { available: boolean; configured: boolean; local_archive_available: boolean; thread_title: string; reason: string };
type DeliveryResult = { delivered?: boolean; reason?: string; error?: string; archive?: { name: string } };

export default function TechnicalPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<TechnicalDashboard | null>(null);
  const [loadedKey, setLoadedKey] = useState(''), [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false), [selectedId, setSelectedId] = useState('');
  const [bridge, setBridge] = useState<BridgeStatus | null>(null), [bridgeChecking, setBridgeChecking] = useState(true);
  const [includeChat, setIncludeChat] = useState(false), [sending, setSending] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [revision, setRevision] = useState(0);
  const requestKey = `${refreshKey}:${revision}`, loading = loadedKey !== requestKey;
  const mounted = useRef(true), active = useRef(false), exportActive = useRef(false), sendActive = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // This local readiness check never sends logs, generates an answer or starts polling.
    void fetch('/__dota_technical/status', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
      const value = await response.json() as BridgeStatus;
      if (!controller.signal.aborted && mounted.current) { setBridge(value); setIncludeChat(value.available === true && value.configured === true); }
    }).catch(() => { /* Remote deployments retain the manual export workflow. */ })
      .finally(() => { clearTimeout(timeout); if (mounted.current) setBridgeChecking(false); });
    return () => { controller.abort(); clearTimeout(timeout); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/technical', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const body = await response.json() as TechnicalDashboard & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Не удалось прочитать технический журнал.');
      if (!controller.signal.aborted) { setData(body); setError(''); }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Технический журнал недоступен.');
    }).finally(() => { if (!controller.signal.aborted) setLoadedKey(requestKey); });
    return () => controller.abort();
  }, [requestKey]);

  const selectedEvent = data?.events.find(event => event.id === selectedId);
  const events = data?.events ?? [];
  const visibleEvents = selectedId ? events.filter(event => event.id === selectedId) : events;
  const explanationEvents = visibleEvents.slice(0, 20);
  const reports = (data?.reports ?? []).filter(report => !selectedId || report.event_ids.includes(selectedId));
  const newestReport = reports[0];
  const changedSinceReport = newestReport && explanationEvents.some(event => Date.parse(event.last_seen) > Date.parse(newestReport.context_at) || !newestReport.event_ids.includes(event.id));
  const deliveryAvailable = bridge?.available === true && bridge.configured === true;

  async function deliverJournal() {
    if (sendActive.current) throw new Error('Отправка уже выполняется.');
    sendActive.current = true; if (mounted.current) setSending(true);
    try {
      const response = await fetch('/__dota_technical/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json() as DeliveryResult;
      if (!response.ok) throw new Error(result.reason || result.error || 'Отправка не выполнена. Журнал остаётся доступен для экспорта.');
      return result.delivered === true
        ? 'Доставлено в отдельный технический чат. ' + (result.reason || '')
        : 'В чат не отправлено. ' + (result.reason || 'Доступна ручная выгрузка журнала.') + (result.archive?.name ? ' Файл: ' + result.archive.name : '');
    } finally { sendActive.current = false; if (mounted.current) setSending(false); }
  }

  async function sendManually() {
    if (sendActive.current || active.current || !data || !data.events.length && !data.reports.length) return;
    setError(''); setMessage('');
    try { const result = await deliverJournal(); if (mounted.current) setMessage(result); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Отправка не выполнена.'); }
  }

  async function explain() {
    if (active.current || sendActive.current || !data?.key_configured || !visibleEvents.length) return;
    const sendAfterExplanation = includeChat && deliveryAvailable;
    active.current = true; setRunning(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/technical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'explain', ...(selectedId ? { event_ids: [selectedId] } : {}) }) });
      const body = await response.json() as { error?: string; reason?: string };
      if (!response.ok) throw new Error(body.error || 'Не удалось получить техническое объяснение.');
      if (mounted.current) { setMessage(body.reason || 'Разбор сохранён в техническом журнале.'); setRevision(value => value + 1); }
      if (sendAfterExplanation) {
        try { const delivery = await deliverJournal(); if (mounted.current) setMessage((body.reason || 'Разбор сохранён.') + ' ' + delivery); }
        catch (reason) { if (mounted.current) setError('Разбор сохранён, но отправить журнал не удалось. ' + (reason instanceof Error ? reason.message : 'Воспользуйтесь экспортом.')); }
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Запрос не завершён.');
    } finally { active.current = false; if (mounted.current) setRunning(false); }
  }

  async function exportJournal(copy: boolean) {
    if (exportActive.current) return;
    exportActive.current = true; setExporting(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/technical/export', { cache: 'no-store' });
      if (!response.ok) throw new Error('Не удалось выгрузить технический журнал.');
      const text = await response.text();
      if (copy) {
        if (!navigator.clipboard?.writeText) throw new Error('Буфер обмена недоступен. Скачайте журнал и приложите файл к техническому чату.');
        await navigator.clipboard.writeText(text);
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'dota-lab-technical-journal.txt';
        document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (mounted.current) setMessage(copy ? 'Журнал скопирован. Вставьте его в отдельный технический чат.' : 'Журнал скачан: ошибки и сохранённые ответы ИИ.');
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Экспорт не выполнен.');
    } finally { exportActive.current = false; if (mounted.current) setExporting(false); }
  }

  return <div className="technical-workspace">
    <div className="ai-toolbar"><div><h2>Технические ошибки</h2><p>Ошибки программы и интеграций Dota Lab. Причины пропуска ставок остаются в первой вкладке.</p></div><button className="button button-light" onClick={() => setRevision(value => value + 1)} disabled={loading} aria-label="Обновить технический журнал без запроса к ИИ"><RefreshCw size={15}/>Обновить журнал</button></div>
    <div className="technical-privacy"><ShieldCheck size={19}/><p>Ошибки сохраняются без запуска ИИ. Разбор расходует API-баланс только по кнопке и не меняет код, настройки или ставки. Перед сохранением скрываются распознанные ключи, параметры URL и локальные пути.</p></div>
    {error && <div className="error-banner" role="alert"><Info size={18}/><span>{error}</span></div>}
    {message && <p className="ai-status" role="status">{message}</p>}
    {loading && !data ? <div className="ai-loading" role="status"><LoaderCircle className="spin" size={22}/>Читаем технический журнал…</div> : data && <>
      <div className={`ai-connection ${data.key_configured ? '' : 'unavailable'}`}><span className="green-dot"/><span>{data.key_configured ? 'OpenAI настроен · разбор по запросу' : 'OpenAI не настроен · журнал работает без ключа'}</span><small>Срез: {date(data.generated_at)}</small></div>
      <div className="technical-summary"><span><Bug size={17}/>{events.length} групп ошибок</span><span>{events.reduce((total, event) => total + event.count, 0)} повторений в сохранённом журнале</span><span>{data.reports.length} ответов ИИ</span></div>
      {!!events.length && <label className="ai-fixture-label">Что объяснить<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setMessage(''); }}><option value="">Последние {Math.min(20, events.length)} групп ошибок</option>{events.map(event => <option key={event.id} value={event.id}>{event.code} · {event.message.slice(0, 110)}</option>)}</select></label>}
      {selectedId && !selectedEvent && <p className="ai-stale">Эта запись уже вышла за лимит хранения. <button className="text-button" onClick={() => setSelectedId('')}>Показать текущие ошибки</button></p>}
      <section className="panel ai-facts technical-journal"><div className="ai-card-heading"><Bug size={19}/><h3>Журнал Dota Lab</h3><span>Записи системы, не выводы ИИ</span></div>
        {!events.length ? <div className="technical-empty"><Check size={25}/><div><strong>Сохранённых технических ошибок нет</strong><p>Это не гарантия отсутствия всех ошибок. Здесь появятся перехваченные ошибки интерфейса и подключённых серверных проверок.</p></div></div> : <ul className="technical-events">{visibleEvents.map(event => <li key={event.id}>
          <div className="technical-event-heading"><span className={`technical-severity ${event.severity}`}>{event.severity === 'error' ? 'Ошибка' : 'Предупреждение'}</span><code>{event.code}</code><span className="technical-count">×{event.count}</span></div>
          <h4>{event.message}</h4><p className="technical-meta">{sourceName[event.source]}{event.route ? ` · ${event.route}` : ''}</p>
          <p className="technical-meta">Впервые: {date(event.first_seen)}<br/>Последний раз: {date(event.last_seen)}</p>
          {event.details && <details className="technical-details"><summary>Технические детали</summary><pre>{event.details}</pre></details>}
          {selectedId !== event.id && <button className="text-button technical-focus" onClick={() => { setSelectedId(event.id); setMessage(''); }}>Выбрать для объяснения</button>}
        </li>)}</ul>}
        <p className="ai-muted technical-retention">Хранятся до {data.retention.max_events} групп ошибок и {data.retention.max_reports} разборов. Повторы объединяются; старые записи вытесняются. Данные других проектов не подмешиваются.</p>
      </section>
      <section className="panel ai-report"><div className="ai-report-header"><div><span className="ai-kicker"><Sparkles size={15}/>БЫСТРОЕ ОБЪЯСНЕНИЕ</span><h3>{selectedEvent ? 'Разбор выбранной ошибки' : 'Разбор технических ошибок'}</h3></div><button className="button button-primary" onClick={explain} disabled={running || sending || !data.key_configured || !visibleEvents.length} aria-busy={running}>{running ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>} {running ? sending ? 'Отправляем журнал…' : 'ИИ разбирает ошибки…' : includeChat && deliveryAvailable ? 'Объяснить и отправить в чат' : 'Объяснить ошибки с ИИ'}</button></div>
        <p className="ai-muted">За один раз — выбранная ошибка или до 20 последних групп. Только сведения этого проекта после удаления распознанных секретов. Нет автоматических запусков или исправления кода. Можно переключать меню — ответ сохранится на сервере.</p>
        {deliveryAvailable && <label className="technical-send-choice"><input type="checkbox" checked={includeChat} onChange={event => setIncludeChat(event.target.checked)} disabled={running || sending}/><span>После объяснения также отправить весь сохранённый журнал и ответы в «{bridge.thread_title || data.delivery.thread_title}»</span></label>}
        {deliveryAvailable && <p className="ai-muted">Передача в чат использует короткий запрос-подтверждение Codex и его лимит; это не повторный разбор.</p>}
        {changedSinceReport && <div className="ai-stale" role="status">После этого разбора появились новые записи или повторы. Ответ относится к срезу, указанному ниже.</div>}
        {newestReport ? <><p className="ai-report-meta">Ответ: {date(newestReport.created_at)} · данные на {date(newestReport.context_at)} · групп ошибок: {newestReport.event_ids.length}</p>{newestReport.status === 'completed' ? <p className="ai-answer-text">{newestReport.text}</p> : <p className="ai-empty-note">{newestReport.reason}</p>}</> : <div className="ai-report-empty"><Sparkles size={25}/><p>{!visibleEvents.length ? 'Пока нечего объяснять: технических ошибок в выбранном срезе нет.' : data.key_configured ? 'Нажмите кнопку, чтобы получить объяснение: что произошло, на что влияет и что проверить.' : 'Для объяснения нужен OPENAI_API_KEY в серверных секретах. Не вставляйте ключ в журнал или чат.'}</p></div>}
        {reports.length > 1 && <details className="technical-history"><summary>Предыдущие разборы · {reports.length - 1}</summary>{reports.slice(1).map(report => <article key={report.id}><h4>{date(report.created_at)}</h4><p className="technical-meta">Данные на {date(report.context_at)} · групп ошибок: {report.event_ids.length}</p><p className="ai-answer-text">{report.status === 'completed' ? report.text : report.reason}</p></article>)}</details>}
      </section>
      <section className="panel ai-facts technical-delivery"><h3>{data.delivery.thread_title || 'DOTA 2 LAB ТЕХНИЧЕСКИЙ АНАЛИЗ'}</h3><p>{bridgeChecking ? 'Проверяем доступность локальной связи с отдельным чатом…' : bridge?.reason || data.delivery.reason}</p><p className="ai-muted">Передаётся весь сохранённый журнал: до {data.retention.max_events} групп ошибок и до {data.retention.max_reports} ответов со срезами, даже если выше выбрана одна ошибка. Данные других проектов не включаются. Перед отправкой проверьте экспорт.</p><div className="technical-export-actions">{(deliveryAvailable || bridge?.local_archive_available) && <button className="button button-primary" onClick={() => void sendManually()} disabled={sending || running || !events.length && !data.reports.length} aria-busy={sending}>{sending ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>} {sending ? 'Передаём журнал…' : deliveryAvailable ? 'Отправить журнал в чат' : 'Сохранить в техническом проекте'}</button>}<button className="button button-light" onClick={() => void exportJournal(true)} disabled={exporting}><ClipboardCopy size={16}/>Скопировать для чата</button><button className="button button-light" onClick={() => void exportJournal(false)} disabled={exporting}><Download size={16}/>Скачать журнал</button></div></section>
    </>}
  </div>;
}
