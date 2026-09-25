(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiCashflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  function integer(value, label){
    if(!Number.isSafeInteger(value)) throw new TypeError(`${label}は安全な整数円で指定してください。`);
    return value;
  }

  function safeNumber(value, label){
    const result = Number(value);
    if(!Number.isSafeInteger(result)) throw new RangeError(`${label}が安全な整数円の範囲を超えています。`);
    return result;
  }

  function safeAdd(left, right, label){
    return safeNumber(BigInt(integer(left, label)) + BigInt(integer(right, label)), label);
  }

  function monthIndex(value, label = '年月'){
    if(typeof value !== 'string' || !/^(\d{4})-(0[1-9]|1[0-2])$/.test(value)){
      throw new TypeError(`${label}はYYYY-MM形式で指定してください。`);
    }
    const year = Number(value.slice(0, 4));
    if(year < 1) throw new RangeError(`${label}の年は1以上にしてください。`);
    return year * 12 + Number(value.slice(5, 7)) - 1;
  }

  function monthFromIndex(index){
    if(!Number.isInteger(index) || index < 12 || index > 119999) throw new RangeError('年月が対応範囲外です。');
    const year = Math.floor(index / 12);
    const month = index % 12 + 1;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  }

  function shiftMonth(month, offset){
    if(!Number.isInteger(offset) || offset < 0 || offset > 2) throw new RangeError('回収・支払のずれは0～2か月です。');
    return monthFromIndex(monthIndex(month) + offset);
  }

  function utcDate(year, month, day){
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }

  function parseDate(value, label){
    if(typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)){
      throw new TypeError(`${label}はYYYY-MM-DD形式で指定してください。`);
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const timestamp = utcDate(year, month, day);
    const date = new Date(timestamp);
    if(date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day){
      throw new RangeError(`${label}に存在しない日付があります。`);
    }
    return timestamp;
  }

  // Inclusive dates, including leap days. Each entry is an overlap count, not an annualization.
  function monthDayWeights(startDate, endDate){
    const start = parseDate(startDate, '開始日');
    const end = parseDate(endDate, '終了日');
    if(end < start) throw new RangeError('終了日は開始日以降にしてください。');
    const first = monthIndex(startDate.slice(0, 7));
    const last = monthIndex(endDate.slice(0, 7));
    const result = [];
    for(let index = first; index <= last; index++){
      const month = monthFromIndex(index);
      const year = Number(month.slice(0, 4));
      const monthNumber = Number(month.slice(5, 7));
      const firstDay = utcDate(year, monthNumber, 1);
      const nextMonth = utcDate(year, monthNumber + 1, 1);
      const overlapStart = Math.max(start, firstDay);
      const overlapEnd = Math.min(end, nextMonth - 86400000);
      result.push({month, days: Math.floor((overlapEnd - overlapStart) / 86400000) + 1});
    }
    return result;
  }

  // Split a signed annual amount using non-negative weights. The largest fractional
  // remainders receive the residual yen; stable index order breaks ties.
  function allocateExact(total, weights){
    integer(total, '配分元の金額');
    if(!Array.isArray(weights) || weights.length === 0) throw new TypeError('配分比率を指定してください。');
    const parsed = weights.map((weight, index) => {
      if(!Number.isSafeInteger(weight) || weight < 0) throw new TypeError(`配分比率${index + 1}は0以上の安全な整数で指定してください。`);
      return BigInt(weight);
    });
    const denominator = parsed.reduce((sum, weight) => sum + weight, 0n);
    if(denominator === 0n){
      if(total !== 0) throw new RangeError('配分比率の合計が0のため、金額を配分できません。');
      return weights.map(() => 0);
    }
    const magnitude = BigInt(Math.abs(total));
    const parts = parsed.map((weight, index) => {
      const numerator = magnitude * weight;
      return {index, amount:numerator / denominator, remainder:numerator % denominator};
    });
    let left = magnitude - parts.reduce((sum, part) => sum + part.amount, 0n);
    for(const part of [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)){
      if(left === 0n) break;
      part.amount += 1n;
      left -= 1n;
    }
    const sign = total < 0 ? -1n : 1n;
    return parts.map(part => safeNumber(sign * part.amount, '月別配分額'));
  }

  function sumEntries(entries, label){
    return entries.reduce((sum, entry) => safeAdd(sum, entry.amount, label), 0);
  }

  function normalizeEntries(entries, label, periodStart, periodEnd, nonNegative = false){
    if(!Array.isArray(entries)) throw new TypeError(`${label}は年月と金額の配列で指定してください。`);
    return entries.map((entry, index) => {
      if(!entry || typeof entry !== 'object') throw new TypeError(`${label}${index + 1}を確認してください。`);
      const month = entry.month;
      const currentIndex = monthIndex(month, `${label}${index + 1}の年月`);
      if(currentIndex < periodStart || (periodEnd !== null && currentIndex > periodEnd)){
        throw new RangeError(`${label}${index + 1}の年月が対象期外です。`);
      }
      const amount = integer(entry.amount, `${label}${index + 1}の金額`);
      if(nonNegative && amount < 0) throw new RangeError(`${label}${index + 1}は0円以上にしてください。`);
      return {month, amount};
    });
  }

  function zeroTaxEvents(){ return {interim:0, settlement:0, refund:0}; }

  function calculate(input){
    if(!input || typeof input !== 'object') throw new TypeError('資金繰りの入力を指定してください。');
    const periodStart = monthIndex(input.periodStart, '対象期開始月');
    const periodEnd = monthIndex(input.periodEnd, '対象期終了月');
    if(periodEnd < periodStart) throw new RangeError('対象期終了月は開始月以降にしてください。');
    const salesLag = input.salesLag ?? 0;
    const purchaseLag = input.purchaseLag ?? 0;
    shiftMonth(input.periodStart, salesLag);
    shiftMonth(input.periodStart, purchaseLag);
    const salesDeltas = normalizeEntries(input.salesDeltas, '売上入金差', periodStart, periodEnd);
    const purchaseDeltas = normalizeEntries(input.purchaseDeltas, '仕入支払差', periodStart, periodEnd);
    const interim = input.interim || {status:'unknown'};
    if(!['unknown', 'none', 'scheduled', 'auto'].includes(interim.status)) throw new TypeError('中間納付の確認状態を指定してください。');

    const reasons = [];
    let taxComplete = interim.status !== 'unknown';
    if(interim.status === 'unknown') reasons.push('中間納付予定が未確認のため、消費税の納付・還付は未反映です。');
    const annualTax = input.annualTax || {};
    if(annualTax.base === null || annualTax.base === undefined || annualTax.changed === null || annualTax.changed === undefined){
      taxComplete = false;
      reasons.push('両案の当期税額が未算定のため、消費税の納付・還付は未反映です。');
    } else {
      integer(annualTax.base, '基準案の当期税額');
      integer(annualTax.changed, '変更案の当期税額');
    }

    let baseInterim = [];
    let changedInterim = [];
    if(interim.status === 'scheduled' || interim.status === 'auto'){
      baseInterim = normalizeEntries(interim.base, '基準案の中間納付', periodStart, null, true);
      changedInterim = normalizeEntries(interim.changed, '変更案の中間納付', periodStart, null, true);
      // 'auto' is emitted only after both generated plans are ready; an empty
      // generated plan means a confirmed zero filing count, unlike a blank manual plan.
      const baseNoInterim = (interim.status === 'auto' && baseInterim.length === 0) || interim.baseNoInterim === true;
      const changedNoInterim = (interim.status === 'auto' && changedInterim.length === 0) || interim.changedNoInterim === true;
      if((baseNoInterim && baseInterim.length) || (changedNoInterim && changedInterim.length)){
        throw new RangeError('中間納付なしの確認と予定入力を同時に指定できません。');
      }
      if((baseInterim.length === 0 && !baseNoInterim) || (changedInterim.length === 0 && !changedNoInterim)){
        taxComplete = false;
        reasons.push('中間納付予定が未入力の案があります。中間納付なしの場合は案ごとに明示的に確認してください。');
      }
    } else if(interim.status === 'none'){
      if((interim.base && interim.base.length) || (interim.changed && interim.changed.length)){
        throw new RangeError('中間納付なしと予定入力を同時に指定できません。');
      }
    }

    const baseInterimTotal = sumEntries(baseInterim, '基準案の中間納付合計');
    const changedInterimTotal = sumEntries(changedInterim, '変更案の中間納付合計');
    const settlement = {base:null, changed:null};
    if(taxComplete){
      settlement.base = safeAdd(annualTax.base, -baseInterimTotal, '基準案の精算差額');
      settlement.changed = safeAdd(annualTax.changed, -changedInterimTotal, '変更案の精算差額');
      if((settlement.base > 0 || settlement.changed > 0) && !input.settlementMonth){
        taxComplete = false;
        reasons.push('確定差額の納付予定月が未設定のため、消費税の納付・還付は未反映です。');
      }
      if((settlement.base < 0 || settlement.changed < 0) && !input.refundMonth){
        taxComplete = false;
        reasons.push('還付入金予定月が未設定のため、消費税の納付・還付は未反映です。');
      }
    }
    for(const [field, label] of [['settlementMonth','納付予定月'],['refundMonth','還付予定月']]){
      if(input[field] !== null && input[field] !== undefined && input[field] !== ''){
        const index = monthIndex(input[field], label);
        if(index < periodEnd) throw new RangeError(`${label}は対象期の終了月以降にしてください。`);
      }
    }
    if(taxComplete){
      for(const [plan, entries] of [['base',baseInterim],['changed',changedInterim]]){
        const settlementMonth = settlement[plan] > 0 ? input.settlementMonth : settlement[plan] < 0 ? input.refundMonth : null;
        if(settlementMonth && entries.some(entry => monthIndex(entry.month) > monthIndex(settlementMonth))){
          throw new RangeError(`${plan === 'base' ? '基準案' : '変更案'}の中間納付予定月が精算予定月より後です。`);
        }
      }
    }

    const rowsByMonth = new Map();
    function row(month){
      if(!rowsByMonth.has(month)) rowsByMonth.set(month, {
        month, sales:0, purchase:0, interim:taxComplete ? 0 : null,
        settlement:taxComplete ? 0 : null, refund:taxComplete ? 0 : null,
        baseTax:taxComplete ? zeroTaxEvents() : null,
        changedTax:taxComplete ? zeroTaxEvents() : null
      });
      return rowsByMonth.get(month);
    }
    for(const entry of salesDeltas){
      const item = row(shiftMonth(entry.month, salesLag));
      item.sales = safeAdd(item.sales, entry.amount, '月別売上入金差');
    }
    for(const entry of purchaseDeltas){
      const item = row(shiftMonth(entry.month, purchaseLag));
      item.purchase = safeAdd(item.purchase, -entry.amount, '月別仕入支払の資金寄与');
    }

    if(taxComplete){
      for(const [plan, entries] of [['base',baseInterim],['changed',changedInterim]]){
        for(const entry of entries){
          const item = row(entry.month);
          const tax = plan === 'base' ? item.baseTax : item.changedTax;
          tax.interim = safeAdd(tax.interim, entry.amount, `${plan}中間納付月額`);
          item.interim = safeAdd(item.interim, plan === 'base' ? entry.amount : -entry.amount, '月別中間納付の資金寄与');
        }
      }
      for(const plan of ['base','changed']){
        const amount = settlement[plan];
        if(amount === 0) continue;
        const month = amount > 0 ? input.settlementMonth : input.refundMonth;
        const item = row(month);
        const tax = plan === 'base' ? item.baseTax : item.changedTax;
        if(amount > 0){
          tax.settlement = safeAdd(tax.settlement, amount, `${plan}確定差額月額`);
          item.settlement = safeAdd(item.settlement, plan === 'base' ? amount : -amount, '月別確定差額の資金寄与');
        } else {
          tax.refund = safeAdd(tax.refund, -amount, `${plan}還付月額`);
          item.refund = safeAdd(item.refund, plan === 'changed' ? -amount : amount, '月別還付の資金寄与');
        }
      }
    }

    const latest = Math.max(periodEnd, ...Array.from(rowsByMonth.keys(), value => monthIndex(value)));
    const rows = [];
    let cumulative = 0;
    let periodEndCumulative = null;
    let minimum = 0;
    let minimumMonth = null;
    for(let index = periodStart; index <= latest; index++){
      const month = monthFromIndex(index);
      const item = row(month);
      let net = safeAdd(item.sales, item.purchase, '月別取引資金差');
      if(taxComplete){
        net = safeAdd(net, item.interim, '月別資金差');
        net = safeAdd(net, item.settlement, '月別資金差');
        net = safeAdd(net, item.refund, '月別資金差');
      }
      cumulative = safeAdd(cumulative, net, '累積資金差');
      if(index === periodEnd) periodEndCumulative = cumulative;
      if(cumulative < minimum){ minimum = cumulative; minimumMonth = month; }
      rows.push({...item, net, cumulative, phase:index <= periodEnd ? 'transaction' : 'settlement'});
    }

    const totals = {
      sales:sumEntries(salesDeltas, '売上入金差合計'),
      purchase:safeNumber(-BigInt(sumEntries(purchaseDeltas, '仕入支払差合計')), '仕入支払の資金寄与合計'),
      interim:taxComplete ? rows.reduce((sum, item) => safeAdd(sum, item.interim, '中間納付の資金寄与合計'), 0) : null,
      settlement:taxComplete ? rows.reduce((sum, item) => safeAdd(sum, item.settlement, '確定差額の資金寄与合計'), 0) : null,
      refund:taxComplete ? rows.reduce((sum, item) => safeAdd(sum, item.refund, '還付の資金寄与合計'), 0) : null
    };
    totals.tax = taxComplete ? safeAdd(safeAdd(totals.interim, totals.settlement, '税金の資金寄与'), totals.refund, '税金の資金寄与') : null;
    totals.net = safeAdd(safeAdd(totals.sales, totals.purchase, '資金差合計'), totals.tax ?? 0, '資金差合計');
    if(totals.net !== cumulative) throw new Error('月別資金差額の検算に失敗しました。');
    if(taxComplete){
      for(const plan of ['base','changed']){
        const paid = safeAdd(plan === 'base' ? baseInterimTotal : changedInterimTotal, Math.max(0, settlement[plan]), `${plan}納付支出合計`);
        const netTax = safeAdd(paid, -Math.max(0, -settlement[plan]), `${plan}税金イベント検算`);
        if(netTax !== annualTax[plan]) throw new Error(`${plan}の税金イベント検算に失敗しました。`);
      }
      const expected = safeAdd(safeAdd(totals.sales, totals.purchase, '精算後資金差検算'), safeAdd(annualTax.base, -annualTax.changed, '当期税額差'), '精算後資金差検算');
      if(cumulative !== expected) throw new Error('精算後資金差額の検算に失敗しました。');
    }
    return {
      status:taxComplete ? 'complete' : 'partial',
      taxPeriod:{start:input.periodStart, end:input.periodEnd},
      reasons, rows, totals, periodEndCumulative,
      maxDrawdown:taxComplete ? {amount:-minimum, month:minimumMonth} : null,
      transactionOnlyMaxDrawdown:taxComplete ? null : {amount:-minimum, month:minimumMonth},
      finalCumulative:taxComplete ? cumulative : null,
      settlement:taxComplete ? settlement : null,
      taxStatus:taxComplete ? 'included' : 'not-included'
    };
  }

  return Object.freeze({calculate, allocateExact, monthDayWeights, shiftMonth});
});
