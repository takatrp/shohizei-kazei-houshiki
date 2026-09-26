(function(root,factory){
  if(typeof module==='object' && module.exports) module.exports=factory();
  else root.ShohizeiCashflowEventChart=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const yen=value=>Number(value).toLocaleString('ja-JP')+'円';
  const kinds=[['interim','中間納付'],['settlement','確定納付'],['refund','還付']];
  function events(value){
    if(!value || kinds.some(([key])=>typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<0))return null;
    return kinds.map(([key,label])=>({key,label,amount:value[key],signedAmount:key==='refund'?value[key]:-value[key]}));
  }
  function buildChartModel(input={}){
    const rows=Array.isArray(input.rows)?input.rows:[];
    const complete=input.taxComplete!==false;
    const months=rows.map(row=>({month:String(row.month??''),base:complete?events(row.baseTax):null,changed:complete?events(row.changedTax):null}));
    const visible=months.filter(row=>!row.base||!row.changed||[...row.base,...row.changed].some(event=>event.amount!==0));
    let scale=0;
    for(const row of visible)for(const plan of ['base','changed']){
      const list=row[plan];if(!list)continue;
      scale=Math.max(scale,list[0].amount+list[1].amount,list[2].amount);
    }
    return {months:visible,scale,hasUnknown:!complete||(!months.length&&input.taxComplete!==true)||months.some(row=>!row.base||!row.changed),omittedZeroMonths:months.length-visible.length};
  }
  function render(input={}){
    const model=buildChartModel(input),labels=input.labels||{};
    const names={base:labels.base||'基準案A',changed:labels.changed||'変更案B'};
    const period=input.periodStart&&input.periodEnd?`対象期間 ${escape(input.periodStart)}〜${escape(input.periodEnd)}。`:'';
    const legend=kinds.map(([key,label])=>`<span><i class="cf-event-swatch cf-event-${key}" aria-hidden="true"></i>${label}</span>`).join('');
    const width=amount=>model.scale?Math.min(100,amount/model.scale*100):0;
    function plan(row,key){
      const list=row[key],label=escape(names[key]);
      if(!list)return `<div class="cf-event-plan"><div class="cf-event-plan-name">${label}</div><div class="cf-event-unknown">未算定（必要な前提を確認してください）</div></div>`;
      const description=list.filter(event=>event.amount>0).map(event=>`${event.label} ${event.signedAmount<0?'−':'＋'}${yen(event.amount)}`).join(' ／ ')||'納付・還付なし（0円）';
      const segment=event=>event.amount?`<span class="cf-event-segment cf-event-${event.key}" style="width:${width(event.amount)}%" title="${escape(event.label+' '+(event.signedAmount<0?'−':'＋')+yen(event.amount))}"></span>`:'';
      return `<div class="cf-event-plan"><div class="cf-event-plan-name">${label}</div><div class="cf-event-bars" role="img" aria-label="${escape(row.month+' '+names[key]+'：'+description)}"><div class="cf-event-negative">${segment(list[0])}${segment(list[1])}</div><div class="cf-event-positive">${segment(list[2])}</div></div><div class="cf-event-values">${escape(description)}</div></div>`;
    }
    const content=model.months.map(row=>`<div class="cf-event-month"><div class="cf-event-month-name">${escape(row.month)}</div>${plan(row,'base')}${plan(row,'changed')}</div>`).join('');
    const empty=model.hasUnknown?'未算定（必要な前提を確認してください）':'この期間の納付・還付イベントはありません（0円）。';
    return `<section class="cf-event-chart" aria-label="${escape(labels.title||'両案の納付・還付予定額')}"><h4>${escape(labels.title||'両案の納付・還付予定額')}</h4><p class="cf-event-guide">${period}納付・還付がある月を表示します。両案で同じ金額の目盛りを使います。対象期後の精算月も含みます。</p><div class="cf-event-legend">${legend}</div><div class="cf-event-axis"><span>← 納付（資金減少）</span><span>還付（資金増加）→</span></div>${content||`<p class="cf-event-empty">${empty}</p>`}${model.omittedZeroMonths?'<p class="cf-event-guide">両案とも納付・還付が0円の月は省略しています。</p>':''}</section>`;
  }
  const styles=`
.cf-event-chart{min-width:0;margin:12px 0;color:inherit}.cf-event-chart h4{font-size:1em;margin:0 0 6px}.cf-event-guide{font-size:.85em;line-height:1.5;margin:5px 0}.cf-event-legend{display:flex;gap:8px 14px;flex-wrap:wrap;font-size:.85em}.cf-event-swatch{display:inline-block;width:12px;height:12px;margin-right:4px;vertical-align:middle;border:1px solid #425466}.cf-event-interim{background:#6386ad}.cf-event-settlement{background:#253d5c}.cf-event-refund{background:#357b64}.cf-event-axis{display:flex;justify-content:space-between;font-size:.8em;gap:8px;margin:8px 0 3px}.cf-event-month{padding:7px 0;border-top:1px solid #ccd6df;break-inside:avoid}.cf-event-month-name{font-weight:700;font-size:.9em}.cf-event-plan{margin-top:5px;min-width:0}.cf-event-plan-name{font-size:.85em;overflow-wrap:anywhere}.cf-event-bars{display:flex;height:16px;margin:3px 0;position:relative;background:linear-gradient(to right,transparent calc(50% - .5px),#667 50%,transparent calc(50% + .5px))}.cf-event-negative,.cf-event-positive{display:flex;width:50%;min-width:0}.cf-event-negative{justify-content:flex-end}.cf-event-segment{height:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.3);min-width:1px}.cf-event-values,.cf-event-unknown{font-size:.85em;line-height:1.5;overflow-wrap:anywhere}.cf-event-unknown{color:#805000}@media print{.cf-event-chart{font-size:9pt}.cf-event-chart *{-webkit-print-color-adjust:exact;print-color-adjust:exact}.cf-event-month{break-inside:avoid}.cf-event-bars{height:12px}.cf-event-guide,.cf-event-values,.cf-event-plan-name,.cf-event-axis,.cf-event-legend{font-size:8pt}}
`;
  return {buildChartModel,render,styles};
});
