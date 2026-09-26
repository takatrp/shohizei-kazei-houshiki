(function(root, factory){
  const api = factory(typeof module === 'object' && module.exports
    ? require('./cashflow-engine.js') : root.ShohizeiCashflow);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiCashflowPanelData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(cashflow){
  'use strict';

  const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const PRICE_BASIS = new Set(['taxExclusiveFixed','taxInclusiveFixed','mixed']);

  function yen(value, label){
    if(!Number.isSafeInteger(value)) throw new TypeError(`${label}は整数円で確認してください。`);
    return value;
  }

  function add(left, right, label){
    const total = BigInt(yen(left,label)) + BigInt(yen(right,label));
    const number = Number(total);
    return yen(number,label);
  }

  function monthIndex(month){
    const match = MONTH.exec(month || '');
    if(!match || Number(match[1]) < 1) throw new TypeError('対象年月を確認してください。');
    return Number(match[1]) * 12 + Number(match[2]) - 1;
  }

  function monthAt(index){
    return `${String(Math.floor(index / 12)).padStart(4,'0')}-${String(index % 12 + 1).padStart(2,'0')}`;
  }

  function roundedYen(value, label){
    if(typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label}を確認できません。`);
    return yen(Math.round(value),label);
  }

  function priceBasisOf(input, mode){
    if(mode === 'methodImpact') return 'mixed';
    if(PRICE_BASIS.has(input.priceBasis)) return input.priceBasis;
    const basis = input.priceBasis || input.calc?.ctx || {};
    const sales = basis.sales || basis.foodSalesPriceBasis;
    const purchases = basis.purchases || basis.foodPurchasePriceBasis;
    if(sales === 'netFixed' && purchases === 'netFixed') return 'taxExclusiveFixed';
    if(sales === 'grossFixed' && purchases === 'grossFixed') return 'taxInclusiveFixed';
    return 'mixed';
  }

  function addTo(map, month, amount, label){
    monthIndex(month);
    map.set(month,add(map.get(month) || 0,amount,label));
  }

  function baseline(input, mode, sourceNote){
    const map = new Map();
    if(input.baselineFlows !== undefined){
      if(!Array.isArray(input.baselineFlows)) throw new TypeError('明示した月別A案日常増減を確認してください。');
      for(const item of input.baselineFlows){
        addTo(map,item?.month,yen(item?.amount,'明示した月別A案日常増減'),'月別A案日常増減');
      }
      sourceNote.push('A案の日常増減は明示された月別円額を使用しています。');
      return map;
    }
    if(mode === 'methodImpact'){
      sourceNote.push('課税方式比較では両案に共通する日常取引を相殺し、納付・還付による差だけを表示します。日常増減0円は実際の営業収支0円を意味しません。');
      return map;
    }
    const start = input.calc?.ctx?.start;
    const end = input.calc?.ctx?.end;
    const lags = input.lags;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || ''))
      throw new TypeError('STEP1の対象期間が未確認のため、A案の日常増減を表示できません。');
    if(!lags || !Number.isInteger(lags.sales) || !Number.isInteger(lags.purchases)
      || lags.sales < 0 || lags.sales > 2 || lags.purchases < 0 || lags.purchases > 2)
      throw new TypeError('売上回収・仕入支払の月ずれが未確認のため、A案の日常増減を表示できません。');
    const salesTax = roundedYen(input.comparison?.current?.sales?.totalTax,'現行税率の売上税額');
    const purchaseTax = roundedYen(input.comparison?.current?.purchases?.totalTax,'現行税率の仕入税額');
    const weights = cashflow.monthDayWeights(start,end);
    const saleParts = cashflow.allocateExact(salesTax,weights.map(item => item.days));
    const purchaseParts = cashflow.allocateExact(purchaseTax,weights.map(item => item.days));
    weights.forEach((item,index) => {
      addTo(map,cashflow.shiftMonth(item.month,lags.sales),saleParts[index],'売上側の日常増減');
      addTo(map,cashflow.shiftMonth(item.month,lags.purchases),-purchaseParts[index],'仕入側の日常増減');
    });
    sourceNote.push('A案の日常増減は、STEP3の現行税率側の売上税額・仕入税額を対象期の日数で均等配分し、設定した回収・支払月ずれへ配置した参考額です。実際の月次入出金ではありません。');
    return map;
  }

  function eventsFromTax(tax){
    if(!tax) return [];
    const entries = [['interim',tax.interim],['final',tax.settlement],['refund',tax.refund]];
    return entries.flatMap(([kind,value]) => {
      if(value === undefined || value === null) return [];
      yen(value,`${kind}のイベント金額`);
      if(value < 0) throw new RangeError('納付・還付の金額が負数です。');
      return value ? [{kind,amount:value}] : [];
    });
  }

  function addEvent(map, month, kind, amount){
    if(amount === 0) return;
    if(amount < 0) throw new RangeError('納付・還付の金額が負数です。');
    monthIndex(month);
    const items = map.get(month) || [];
    items.push({kind,amount:yen(amount,'イベント金額')});
    map.set(month,items);
  }

  function partialEvents(input, engine, plan){
    const map = new Map();
    const interim = input.interim || {};
    const entries = interim[plan];
    const confirmed = interim.status === 'none'
      || ((interim.status === 'scheduled' || interim.status === 'auto') && Array.isArray(entries)
        && (entries.length > 0 || interim.status === 'auto' || interim[plan + 'NoInterim'] === true));
    if(!confirmed) return map;
    const scheduled = Array.isArray(entries) ? entries : [];
    let paid = 0;
    for(const entry of scheduled){
      const amount = yen(entry?.amount,'確認済みの中間納付額');
      paid = add(paid,amount,'中間納付合計');
      addEvent(map,entry.month,'interim',amount);
    }
    const annual = input.adapter?.annualTax?.[plan];
    if(!Number.isSafeInteger(annual)) return map;
    const due = add(annual,-paid,'中間納付控除後の差額');
    const field = due > 0 ? 'paymentMonth' : 'refundMonth';
    const month = engine.settlementMonths?.[plan]?.[field];
    if(due > 0 && month) addEvent(map,month,'final',due);
    if(due < 0 && month) addEvent(map,month,'refund',-due);
    return map;
  }

  function eventImpact(events){
    return events.reduce((sum,event) => add(sum,event.kind === 'refund' ? event.amount : -event.amount,'月別納付・還付の資金増減'),0);
  }

  function distinctNotes(items){ return [...new Set(items.filter(Boolean))]; }

  function unrenderable(reason, input, mode, sourceNote){
    const interim = input.interim?.status === 'auto' ? 'auto'
      : input.interim?.status === 'scheduled' ? 'manual'
      : input.interim?.status === 'none' ? 'none' : 'unconfirmed';
    return {months:[],unitLabel:'千円',priceBasis:priceBasisOf(input,mode),
      cases:{A:{label:input.labels?.A || 'A案',rows:[]},B:{label:input.labels?.B || 'B案',rows:[]}},
      expectedDiff:[],status:{renderable:false,integrity:'unavailable',mode,reason,interim,
        finalMonthEntered:false,refundMonthEntered:false,notes:distinctNotes([reason,...sourceNote])}};
  }

  function buildPanelData(input = {}){
    if(!input || typeof input !== 'object') input = {};
    const mode = input.mode === 'methodImpact' ? 'methodImpact' : 'rateImpact';
    const sourceNote = [];
    try{
      const engine = input.engine;
      if(!engine || !Array.isArray(engine.rows) || !engine.rows.length)
        return unrenderable('STEP4の月別計算結果がありません。',input,mode,sourceNote);
      const first = monthIndex(engine.taxPeriod?.start || engine.rows[0].month);
      let last = Math.max(monthIndex(engine.taxPeriod?.end || engine.rows.at(-1).month),
        ...engine.rows.map(row => monthIndex(row.month)));
      const aFlows = baseline(input,mode,sourceNote);
      for(const month of aFlows.keys()){
        if(monthIndex(month) < first) throw new RangeError('対象期前のA案日常増減は、このパネルに持ち越せません。');
        last = Math.max(last,monthIndex(month));
      }
      const engineRows = new Map(engine.rows.map(row => [row.month,row]));
      const known = {base:new Map(),changed:new Map()};
      if(engine.status !== 'complete'){
        known.base = partialEvents(input,engine,'base');
        known.changed = partialEvents(input,engine,'changed');
        for(const map of Object.values(known)) for(const month of map.keys()) last = Math.max(last,monthIndex(month));
      }
      const months = Array.from({length:last-first+1},(_,index) => monthAt(first+index));
      const rows = {A:[],B:[]};
      const expectedDiff = [];
      let aCumulative = 0, bCumulative = 0, expectedCumulative = 0;
      let mismatch = null;
      const originalLast = monthIndex(engine.rows.at(-1).month);
      for(const month of months){
        const source = engineRows.get(month);
        if(!source && monthIndex(month) <= originalLast)
          throw new TypeError(`既存STEP4の${month}の月別結果がありません。`);
        const aFlow = aFlows.get(month) || 0;
        const transactionDelta = add(source ? yen(source.sales,'既存STEP4の売上差') : 0,
          source ? yen(source.purchase,'既存STEP4の仕入差') : 0,'月別取引差額');
        const bFlow = add(aFlow,transactionDelta,'B案の日常増減');
        const aEvents = engine.status === 'complete' ? eventsFromTax(source?.baseTax) : known.base.get(month) || [];
        const bEvents = engine.status === 'complete' ? eventsFromTax(source?.changedTax) : known.changed.get(month) || [];
        const aTotal = add(aFlow,eventImpact(aEvents),'A案の月次計');
        const bTotal = add(bFlow,eventImpact(bEvents),'B案の月次計');
        aCumulative = add(aCumulative,aTotal,'A案の月末累積');
        bCumulative = add(bCumulative,bTotal,'B案の月末累積');
        rows.A.push({month,flow:aFlow,events:aEvents,monthTotal:aTotal,cumulative:aCumulative});
        rows.B.push({month,flow:bFlow,events:bEvents,monthTotal:bTotal,cumulative:bCumulative});
        const expectedMonth = source ? yen(source.net,'既存STEP4の月次差額') : 0;
        expectedCumulative = add(expectedCumulative,expectedMonth,'既存STEP4の累積差額');
        expectedDiff.push({month,monthTotal:expectedMonth,cumulative:expectedCumulative});
        if(source && Math.abs(yen(source.cumulative,'既存STEP4の累積差額')-expectedCumulative) > 1)
          mismatch ||= month;
        if(Math.abs(add(bTotal,-aTotal,'月別B−A差額')-expectedMonth) > 1
          || Math.abs(add(bCumulative,-aCumulative,'累積B−A差額')-expectedCumulative) > 1){
          mismatch ||= month;
        }
      }
      if(engine.rows.at(-1).cumulative !== expectedCumulative && months.at(-1) === engine.rows.at(-1).month)
        mismatch ||= months.at(-1);
      const interimState = input.interim?.status === 'auto' ? 'auto'
        : input.interim?.status === 'scheduled' ? 'manual'
        : input.interim?.status === 'none' ? 'none'
        : input.interim?.status === 'unknown' || engine.status !== 'complete' ? 'unconfirmed' : 'confirmed';
      const settlements = engine.status === 'complete' ? engine.settlement : null;
      const finalMonthEntered = settlements ? ['base','changed'].every(plan => settlements[plan] <= 0 || Boolean(engine.settlementMonths?.[plan]?.paymentMonth))
        : ['base','changed'].every(plan => Boolean(engine.settlementMonths?.[plan]?.paymentMonth));
      const refundMonthEntered = settlements ? ['base','changed'].every(plan => settlements[plan] >= 0 || Boolean(engine.settlementMonths?.[plan]?.refundMonth))
        : ['base','changed'].every(plan => Boolean(engine.settlementMonths?.[plan]?.refundMonth));
      const notices = [];
      if(interimState === 'unconfirmed') notices.push('中間納付は未確認のため、グラフと表に反映していません。');
      if(engine.reasons?.some(reason => /納付予定月が未設定/.test(reason))) notices.push('確定納付の予定月が未入力のため、グラフと表に反映していません。');
      if(engine.reasons?.some(reason => /還付入金予定月が未設定/.test(reason))) notices.push('還付の入金予定月が未入力のため、グラフと表に反映していません。');
      if(priceBasisOf(input,mode) !== 'taxExclusiveFixed' && mode === 'rateImpact')
        notices.push('税込価格据置の前提のため、B案の線には価格前提による本体（税抜）部分の差を含みます。');
      if(input.manualFromAuto === true) notices.push('中間納付予定は手修正後の値です。');
      if(mismatch) notices.unshift(`内部整合エラー：${mismatch}のA/B差額が既存STEP4の累積資金差額と一致しません。`);
      const status = {renderable:!mismatch,integrity:mismatch ? 'mismatch' : 'ok',mode,
        taxComplete:engine.status === 'complete',
        reason:mismatch ? notices[0] : '',
        interim:interimState,finalMonthEntered,refundMonthEntered,
        sourceNote:sourceNote[0] || '',notes:distinctNotes([...notices,...(Array.isArray(input.notes) ? input.notes : [])])};
      return {months,unitLabel:'千円',priceBasis:priceBasisOf(input,mode),
        cases:{A:{label:input.labels?.A || 'A案',rows:rows.A},B:{label:input.labels?.B || 'B案',rows:rows.B}},
        expectedDiff,status};
    }catch(error){
      return unrenderable(error.message,input,mode,sourceNote);
    }
  }

  return Object.freeze({buildPanelData});
});
