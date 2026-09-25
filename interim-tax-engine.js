(function(root, factory){
  const calendar = typeof module === 'object' && module.exports ? require('./tax-calendar.js') : root.ShohizeiTaxCalendar;
  const api = factory(calendar);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiInterimTax = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(calendar){
  'use strict';

  const LAW_VERSION = 'nta-6609-2026-04-01';
  function unavailable(reason){
    return {status:'unavailable',count:null,installments:[],totals:null,distinctDueDateCount:null,calendarConfidence:'unknown',calendarVersion:calendar.VERSION,reasons:[reason],warnings:[],priorMonths:null,lawVersion:LAW_VERSION};
  }
  function exactYen(value){
    if(typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
    if(typeof value !== 'string' || !/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) return null;
    const parsed = Number(value.replaceAll(',',''));
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  function safeBigintToNumber(value){
    const result = Number(value);
    return Number.isSafeInteger(result) ? result : null;
  }
  function interimAmounts(national, months, priorMonths){
    const n = BigInt(national);
    const nationalTax = (n * BigInt(months) / (BigInt(priorMonths) * 100n)) * 100n;
    const localTax = (nationalTax * 22n / (78n * 100n)) * 100n;
    return {national:safeBigintToNumber(nationalTax),local:safeBigintToNumber(localTax),total:safeBigintToNumber(nationalTax + localTax)};
  }
  function category(national, priorMonths){
    const n = BigInt(national), p = BigInt(priorMonths);
    if(n > 4000000n * p) return 11;
    if(3n * n > 1000000n * p) return 3;
    if(6n * n > 240000n * p) return 1;
    return 0;
  }
  function taxPeriodLabel(start,end){ return `${start}～${end}`; }
  function plan(input){
    if(!input || typeof input !== 'object') return unavailable('中間納付の計算条件がありません。');
    if(input.periodShortening === 'yes') return {
      status:'not_applicable',count:0,installments:[],totals:{national:0,local:0,total:0},distinctDueDateCount:0,
      calendarConfidence:'not_needed',calendarVersion:calendar.VERSION,reasons:['課税期間短縮特例の適用により、通常の中間申告予定は生成しません。'],warnings:[],priorMonths:null,lawVersion:LAW_VERSION
    };
    if(input.periodShortening !== 'none') return unavailable('課税期間短縮特例の適用有無を確認してください。');
    const national = exactYen(input.priorNationalTax);
    if(national === null) return unavailable('前課税期間の国税分を安全な整数円で入力してください。国・地方合計や差額納付額は使用できません。');
    const entityType = input.entityType;
    if(entityType !== 'individual' && entityType !== 'corporation') return unavailable('個人・法人の区分を確認してください。');
    if(input.specialCircumstances !== 'none') return unavailable('合併・相続・期限の個別延長・前期税額の途中変更等は通常の自動計算範囲外です。手入力で確認してください。');
    const priorMonths = calendar.priorMonths(input.priorStart,input.priorEnd);
    if(priorMonths === null) return unavailable('前課税期間の法令上の月数を確認できません。日数による概算へ置き換えず、期間を確認してください。');
    const currentMonths = calendar.priorMonths(input.currentStart,input.currentEnd);
    if(currentMonths !== 12) return unavailable('当期が通常の12か月期ではありません。短期事業年度の対象期間数を個別確認してください。');
    if(calendar.shiftDays(input.priorEnd,1) !== input.currentStart) return unavailable('前課税期間と対象期が連続していません。前期期間を確認してください。');
    if(entityType === 'individual' && (!/^\d{4}-01-01$/.test(input.currentStart) || !/^\d{4}-12-31$/.test(input.currentEnd))) return unavailable('個人の通常暦年課税期間ではありません。期間を確認してください。');
    if(entityType === 'corporation' && !['yes','none','unknown'].includes(input.corporateExtension)) return unavailable('法人の消費税申告期限延長特例の有無を確認してください。');
    const count = national < 0 ? 0 : category(national,priorMonths);
    if(count === 11 && entityType === 'corporation' && input.corporateExtension === 'unknown') return unavailable('法人の年11回申告は、消費税申告期限延長特例の有無を確認するまで初回群の納期限を決められません。');
    const warnings = [];
    const reasons = [];
    if(national < 0) reasons.push('還付の前期を仮定しています。マイナスの中間納付や入金は生成しません。');
    if(count === 0) reasons.push('前期国税額の区分では中間申告義務はありません。任意の中間申告届出がある場合は手入力で確認してください。');
    if(count === 11 && entityType === 'corporation' && input.corporateExtension === 'yes') warnings.push('法人の消費税申告期限延長特例を初回群に適用します。法人税だけの延長ではありません。');
    const steps = count === 11 ? Array.from({length:11},(_,i) => ({offset:i,months:1})) : count === 3 ? [0,3,6].map(offset => ({offset,months:3})) : count === 1 ? [{offset:0,months:6}] : [];
    const installments = [];
    let confidence = 'official';
    for(let i=0;i<steps.length;i++){
      const step = steps[i];
      const interimStart = calendar.shiftMonths(input.currentStart,step.offset);
      const interimEnd = calendar.periodEnd(interimStart,step.months);
      if(!interimStart || !interimEnd || interimEnd >= input.currentEnd) return unavailable('中間申告対象期間を当期内に確定できません。');
      let rawDueDate = calendar.deadlineAfterPeriod(interimEnd);
      if(count === 11){
        if(entityType === 'individual' && i < 3) rawDueDate = calendar.deadlineFromStart(input.currentStart,3);
        if(entityType === 'corporation' && input.corporateExtension === 'none' && i === 0) rawDueDate = calendar.deadlineFromStart(input.currentStart,2);
        if(entityType === 'corporation' && input.corporateExtension === 'yes' && i < 2) rawDueDate = calendar.deadlineFromStart(input.currentStart,3);
      }
      const due = calendar.adjustDueDate(rawDueDate);
      if(due.status !== 'ready') return unavailable(`第${i+1}回の法定納期限を生成できません。`);
      if(due.confidence !== 'official') confidence = 'provisional';
      const amounts = interimAmounts(national,step.months,priorMonths);
      if(Object.values(amounts).some(value => value === null)) return unavailable('中間税額が安全な整数円の範囲を超えています。');
      installments.push({sequence:i+1,interimStart,interimEnd,...amounts,rawDueDate,adjustedDueDate:due.adjustedDueDate,
        adjustmentReasons:due.adjustmentReasons,appliesToTaxPeriod:taxPeriodLabel(input.currentStart,input.currentEnd)});
    }
    if(confidence === 'provisional') warnings.push('未公表年の祝日は現行ルールによる予定です。対象年の祝日公表後に納付日を再確認してください。');
    const sum = key => safeBigintToNumber(installments.reduce((acc,item) => acc + BigInt(item[key]),0n));
    const totals = {national:sum('national'),local:sum('local'),total:sum('total')};
    if(Object.values(totals).some(value => value === null)) return unavailable('中間納付の年間合計が安全な整数円の範囲を超えています。');
    return {status:'ready',count,installments,totals,distinctDueDateCount:new Set(installments.map(item => item.adjustedDueDate)).size,
      calendarConfidence:count ? confidence : 'not_needed',calendarVersion:calendar.VERSION,reasons,warnings,priorMonths,lawVersion:LAW_VERSION};
  }
  return {LAW_VERSION,exactYen,interimAmounts,category,plan};
});
