import type { PaperDashboard } from '@/lib/dota-paper-types';

const amount = (n:number) => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n);
export default function PaperOverview({data,onOpen}: {data:PaperDashboard|null;onOpen:()=>void}) {
  if (!data) return <section className="panel"><div className="panel-heading"><p>Статистика виртуальных ставок недоступна. Обновите данные.</p></div></section>;
  const m=data.metrics, decided=m.won+m.lost;
  const winRate=decided?`${amount(m.won/decided*100)}%`:'—';
  const cards=[
    {label:'Записано ставок',value:String(m.registered),note:`${m.distinct_series} игровых серий`},
    {label:'Рассчитано ставок',value:String(decided+m.void),note:`${m.pending} ожидают · ${m.void} возвратов`},
    {label:'Доля выигранных ставок',value:winRate,note:decided?`${m.won} из ${decided} ставок без возвратов`:'После первой победы или проигрыша'},
    {label:'Прибыль по результатам',value:`${m.profit>0?'+':''}${amount(m.profit)} ед.`,note:`ROI: ${m.roi===null?'—':amount(m.roi*100)+'%'}`},
  ];
  return <>
    <div className="overview-banner"><div><span className="banner-kicker">ВИРТУАЛЬНЫЕ СТАВКИ</span><h2>Результаты ставок<br/><em>и движение банка.</em></h2><p>Банк: {amount(m.bankroll)} ед. · свободно: {amount(m.available_bankroll)} ед. · в ставках: {amount(m.open_stakes)} ед.</p><button className="banner-link" onClick={onOpen}>Открыть журнал ставок →</button></div></div>
    <div className="stat-grid">{cards.map(c=><div className="stat-card" key={c.label}><span className="stat-label">{c.label}</span><div className="stat-value">{c.value}</div><div className="stat-note">{c.note}</div></div>)}</div>
    <p className="outside-note">Учитываются только записанные виртуальные ставки. Ожидающие ставки и возвраты не входят в долю побед. Все оценки исходов и ошибка вероятностей находятся в разделе «Прогнозы».</p>
  </>;
}
