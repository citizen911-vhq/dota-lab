"use client";

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bug, ClipboardList, ExternalLink, Info, LoaderCircle, MessageSquareText, Newspaper, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import type { AiDashboard, AiMode, AiTextPart } from '@/lib/dota-ai-types';
import TechnicalPanel from './technical-panel';

const tabs = [
  { id: 'explain', label: 'Почему ставка пропущена', icon: MessageSquareText, action: 'Объяснить с ИИ', description: 'Причины из журнала и понятное объяснение — без догадок о решении системы.' },
  { id: 'news', label: 'Новости и контекст', icon: Newspaper, action: 'Найти новости', description: 'Замены, переносы и заявления команд. Ссылки на источники, без изменения прогнозов.' },
  { id: 'daily', label: 'Дневная сводка', icon: ClipboardList, action: 'Составить сводку', description: 'Что изменилось за день по Москве и какие вопросы требуют внимания.' },
  { id: 'technical', label: 'Технические ошибки', icon: Bug, action: 'Объяснить ошибки с ИИ', description: 'Отдельный журнал ошибок Dota Lab. Разбор — только по кнопке.' },
] as const;
const date = (v: string | null) => v && Number.isFinite(Date.parse(v)) ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(v)) + ' МСК' : 'Нет времени проверки';
const decimal = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v);
const percent = (v: number) => decimal(v * 100) + '%';

function CitedText({ part }: { part: AiTextPart }) {
  const nodes: ReactNode[] = []; let offset = 0;
  for (const [i, c] of part.citations.entries()) {
    if (c.start < offset || c.end > part.text.length) continue;
    nodes.push(part.text.slice(offset, c.start));
    nodes.push(<a key={i} href={c.url} target="_blank" rel="noreferrer" title={c.title} className="ai-citation">[источник {i + 1}]</a>);
    offset = c.end;
  }
  nodes.push(part.text.slice(offset));
  return <p className="ai-answer-text">{nodes}</p>;
}

export default function AiPanel({ refreshKey }: { refreshKey: number }) {
  const [mode, setMode] = useState<AiMode | 'technical'>('explain'), [fixture, setFixture] = useState('');
  const [data, setData] = useState<AiDashboard | null>(null), [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<AiMode | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0), active = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (mode === 'technical') return;
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    const query = new URLSearchParams({ mode, ...(mode !== 'daily' && fixture ? { fixture_id: fixture } : {}) });
    void fetch('/api/ai?' + query, { cache: 'no-store', signal: controller.signal }).then(async r => {
      const result = await r.json() as AiDashboard & { error?: string }; if (!r.ok) throw Error(result.error || 'Не удалось прочитать данные ИИ.');
      if (!controller.signal.aborted) setData(result);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Данные недоступны.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [mode, fixture, revision, refreshKey]);
  async function generate() {
    if (mode === 'technical' || active.current || !data?.key_configured) return;
    active.current = true; setRunning(mode); setError(''); setMessage('');
    const title = tabs.find(t => t.id === mode)!.label;
    try {
      const r = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, fixture_id: mode === 'daily' ? null : fixture || null, force_refresh: !!data.report }) });
      const result = await r.json() as { error?: string; reason: string };
      if (!r.ok) throw Error(result.error || 'Не удалось получить ответ ИИ.');
      if (mounted.current) { setMessage(title + ': ' + result.reason); setRevision(n => n + 1); }
    } catch (e) { if (mounted.current) setError(title + ': ' + (e instanceof Error ? e.message : 'Запрос не завершён.')); }
    finally { active.current = false; if (mounted.current) setRunning(null); }
  }
  const current = tabs.find(t => t.id === mode)!;
  const snapshot = data?.snapshot, report = data?.report;
  const selected = snapshot?.fixtures.find(f => f.fixture_id === fixture);
  const issues = snapshot?.issues.filter(i => !fixture || !i.fixture_id || i.fixture_id === fixture) ?? [];

  return <section className="ai-workspace" aria-label="ИИ-помощник">
    <div className="ai-intro"><span className="ai-symbol"><Sparkles size={25}/></span><div><strong>Помощник, а не управляющий</strong><p>Объясняет данные и находит контекст. Не меняет вероятности, результаты и виртуальные ставки.</p></div><ShieldCheck size={23}/></div>
    <div className="ai-tabs" role="tablist" aria-label="Инструменты ИИ">
      {tabs.map((t, i) => <button key={t.id} id={'ai-tab-' + t.id} role="tab" aria-selected={mode === t.id} aria-controls="ai-tab-content" tabIndex={mode === t.id ? 0 : -1} className={mode === t.id ? 'active' : ''} onClick={() => { setMode(t.id); setMessage(''); }} onKeyDown={e => {
        const target = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (target === null) return; e.preventDefault(); setMode(tabs[target].id); document.getElementById('ai-tab-' + tabs[target].id)?.focus();
      }}><t.icon size={18}/><span>{t.label}</span></button>)}
    </div>
    <div role="tabpanel" id="ai-tab-content" aria-labelledby={'ai-tab-' + mode} className="ai-tab-content">
      {mode === 'technical' ? <TechnicalPanel refreshKey={refreshKey}/> : <>
      <div className="ai-toolbar"><div><h2>{current.label}</h2><p>{current.description}</p></div><button className="button button-light" onClick={() => setRevision(n => n + 1)} disabled={loading} aria-label="Обновить факты без запроса к ИИ"><RefreshCw size={15}/>Обновить факты</button></div>
      {error && <div className="error-banner" role="alert"><Info size={18}/><span>{error}</span><button onClick={() => { setFixture(''); setRevision(n => n + 1); }}>Обновить список</button></div>}
      {message && <p className="ai-status" role="status">{message}</p>}
      {loading ? <div className="ai-loading" role="status"><LoaderCircle className="spin" size={22}/>Читаем сохранённые данные…</div> : data && snapshot && <>
        <div className={`ai-connection ${data.key_configured ? '' : 'unavailable'}`}><span className="green-dot"/><span>{data.key_configured ? 'Ключ OpenAI задан' : 'OpenAI не настроен'} · {data.key_configured ? data.model : 'Основной анализ и факты ниже работают без ключа'}</span><small>Срез: {date(snapshot.generated_at)}</small></div>
        {mode !== 'daily' && <label className="ai-fixture-label">Серия для разбора<select value={fixture} onChange={e => setFixture(e.target.value)}><option value="">Общий обзор последних серий</option>{snapshot.fixtures.map(f => <option key={f.fixture_id} value={f.fixture_id}>{f.team_a}{f.team_b ? ' — ' + f.team_b : ''}{f.scheduled_start_utc ? ' · ' + date(f.scheduled_start_utc) : ''}</option>)}</select></label>}
        {mode === 'explain' && <>
          <section className="panel ai-facts"><div className="ai-card-heading"><MessageSquareText size={19}/><h3>Что записала система</h3><span>Без участия ИИ</span></div>
            {snapshot.last_odds ? <div className="ai-cycle"><strong>Общее состояние проверки коэффициентов</strong><p>{snapshot.last_odds.reason}</p><small>{date(snapshot.last_odds.at)} · допущено прогнозов: {snapshot.last_odds.eligible_forecasts} · новых ставок: {snapshot.last_odds.bets_added}</small></div> : <p>Отчёта проверки коэффициентов ещё нет. Это не означает, что подходящих ставок нет.</p>}
            {issues.length ? <ul className="ai-issues">{issues.map((issue, i) => { const f = snapshot.fixtures.find(f => f.fixture_id === issue.fixture_id); return <li key={i}><strong>{f ? `${f.team_a}${f.team_b ? ' — ' + f.team_b : ''}` : 'Общая проверка'}</strong><p>{issue.reason}</p><small>{issue.source} · {date(issue.at)}</small></li>; })}</ul> : <p className="ai-empty-note">Для {fixture ? 'этой серии' : 'последней проверки'} конкретные причины пропуска не записаны. ИИ не должен их придумывать. Общая причина выше относится ко всему циклу.</p>}
            <details className="ai-details"><summary>Правила и состояние истории</summary><p>Коэффициент от {decimal(snapshot.rules.min_odds)}. EV с запасом — от {percent(snapshot.rules.min_ev)}; запас к вероятности — {percent(snapshot.rules.probability_reserve)}. Не более {snapshot.rules.max_bets_per_series} ставок разных рынков на серию.</p><p>История: {snapshot.history ? snapshot.history.healthy ? 'последняя загрузка успешна' : 'есть проблемы загрузки' : 'нет проверки'} · {date(snapshot.history?.verified_at ?? null)}. В очереди: {snapshot.last_analysis?.backlog ?? 'неизвестно'}.</p>{snapshot.last_analysis?.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>
          </section>
          {selected && <section className="panel ai-facts"><h3>{selected.team_a}{selected.team_b && ' — ' + selected.team_b}</h3><p className="ai-muted">{selected.scheduled_start_utc ? date(selected.scheduled_start_utc) : 'Время серии в отчёте не указано'} · прогнозов: {selected.forecasts.length} · записано ставок: {selected.bets.length}</p>
            {selected.bets.map((b, i) => <p key={i}>Записана ставка: <strong>{b.label}</strong> · коэффициент {decimal(b.odds)} · {decimal(b.stake)} ед. · {date(b.placed_utc)}</p>)}
            {!!selected.forecasts.length && <details className="ai-details"><summary>Предварительные оценки и сохранённые цены</summary><ul>{selected.forecasts.map(f => <li key={f.forecast_id}>{f.label}: {percent(f.probability)} · выборки {f.n_maps_a}/{f.n_maps_b} карт</li>)}</ul><p>Это предварительные оценки, не подтверждение допуска ставки.</p>{selected.quotes.length ? selected.quotes.map((q, i) => <p key={i}>{q.label} · {decimal(q.odds)} · {q.bookmaker} · цена на {date(q.observed_utc)}</p>) : <p>Сохранённых цен нет. Наличие линии у букмекера из этого не следует.</p>}</details>}
          </section>}
        </>}
        {mode === 'news' && <section className="panel ai-facts"><div className="ai-card-heading"><Newspaper size={19}/><h3>Контекст, который стоит проверить</h3></div><div className="ai-topics"><span>Замены в составе</span><span>Переносы серий</span><span>Заявления команд</span></div><p>Поиск за последние 72 часа по командам выбранной серии или последним сериям журнала. В ответе нужны даты и ссылки. Слух не становится фактом, а новость не меняет вероятность автоматически.</p><p className="ai-muted">При открытии вкладки поиск не запускается. Нажмите «Найти новости» ниже.</p></section>}
        {mode === 'daily' && <>
          <p className="ai-period">{snapshot.day.split('-').reverse().join('.')} · с 00:00 по Москве до времени среза</p>
          <div className="ai-stats">{[['Новых прогнозов', String(snapshot.daily.forecasts)], ['Новых ставок', String(snapshot.daily.bets)], ['Рассчитано ставок', String(snapshot.daily.settled)], ['Итог расчётов', decimal(snapshot.daily.profit) + ' ед.']].map(([label, value]) => <div className="panel" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
          <section className="panel ai-facts"><h3>Факты дня</h3><p>Циклов анализа: {snapshot.daily.analyses}. Добавлено карт в циклах: {snapshot.daily.maps_added}.</p><p>Выиграно: {snapshot.daily.won}; проиграно: {snapshot.daily.lost}; возвратов: {snapshot.daily.void}.</p><p>Текущий банк: {decimal(snapshot.bankroll.bankroll)} ед. Свободно: {decimal(snapshot.bankroll.available_bankroll)} ед. В открытых ставках: {decimal(snapshot.bankroll.open_stakes)} ед.</p><p className="ai-muted">Счётчики вычисляет код. Дневной итог — результат ставок, рассчитанных сегодня, а не всех ставок, созданных сегодня. Уточнения результатов могут изменить итог.</p></section>
        </>}
        <section className="panel ai-report"><div className="ai-report-header"><div><span className="ai-kicker"><Sparkles size={15}/>ОТВЕТ ИИ</span><h3>{mode === 'explain' ? 'Объяснение простым языком' : mode === 'news' ? 'Обзор новостей с источниками' : 'Итоги и вопросы на сегодня'}</h3></div><button className="button button-primary" onClick={generate} disabled={!!running || !data.key_configured} aria-busy={!!running}>{running ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>} {running ? 'ИИ работает…' : report ? 'Обновить ответ ИИ' : current.action}</button></div>
          <p className="ai-muted">По нажатию кнопки в этом разделе. Новый ответ расходует баланс OpenAI API; чтение вкладок — нет. Можно переключать вкладки и меню: готовый ответ сохранится.</p>
          {data.report_stale && <div className="ai-stale" role="status">Сохранённый ответ относится к прежнему срезу или устаревшему поиску. Обновите его перед использованием.</div>}
          {report ? <><p className="ai-report-meta">Сформирован: {date(report.at)} · данные на {date(report.context_at)}</p>{report.status === 'completed' ? report.parts.map((part, i) => <CitedText key={i} part={part}/>) : <p className="ai-empty-note">{report.reason}</p>}{!!report.sources.length && <div className="ai-sources"><h4>Источники</h4>{report.sources.map(s => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title}<ExternalLink size={13}/></a>)}</div>}</> : <div className="ai-report-empty"><Sparkles size={25}/><p>{data.key_configured ? 'Ответ ещё не сформирован. Факты выше уже доступны.' : 'Для ответа ИИ добавьте OPENAI_API_KEY в серверные секреты. Не вводите ключ в поле серии или текст отчёта.'}</p></div>}
        </section>
        <p className="ai-footnote">ИИ не может подтвердить спорный матч, объявить его договорным или записать ставку. В общий отчёт попадает ограниченный набор серий; для подробностей выберите конкретную. {snapshot.fixtures_total > snapshot.fixtures.length && `В списке ${snapshot.fixtures.length} из ${snapshot.fixtures_total} серий.`}</p>
      </>}
      </>}
    </div>
  </section>;
}
