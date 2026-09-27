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

  // The UI accepts thousand-yen amounts with up to three decimal places. Parse
  // the string as digits so even a one-yen entry never depends on FP rounding.
  function parseManualThousand(raw){
    const value=String(raw ?? '').trim().replace(/,/g,'');
    if(!value) return null;
    if(!/^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value))
      throw new TypeError('月別金額は千円単位で、小数第3位（1円）まで入力してください。');
    const negative=value.startsWith('-');
    const [whole,fraction='']=(negative?value.slice(1):value).split('.');
    const result=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
    const number=Number(negative?-result:result);
    return yen(number,'手入力の月別資金増減');
  }

  function buildManualBase(start,end,periodKey,values){
    const expected=`${start}|${end}`;
    if(periodKey && periodKey !== expected)
      return {status:'unconfirmed',reason:'対象期が変更されました。以前の対象期の月別金額は流用せず、現在期の各月を再入力してください。',months:[]};
    let weights;
    try{weights=cashflow.monthDayWeights(start,end);}
    catch{return {status:'unconfirmed',reason:'STEP1の比較対象課税期間を確認してください。',months:[]};}
    const months=[];
    for(const {month} of weights){
      let amount;
      try{amount=parseManualThousand(values?.[month]);}
      catch(error){return {status:'unconfirmed',reason:`${month}：${error.message}`,months:[]};}
      if(amount === null)
        return {status:'unconfirmed',reason:`${month}の月別資金増減が未入力です。0円の場合は0を入力してください。`,months:[]};
      months.push({month,amount});
    }
    return {status:'complete',periodKey:expected,months};
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

  // A案の表示専用配分。食品差額の月別比率はA案全体の比率ではないため流用しない。
  function csvBaselineWeights(input, kind, weights){
    const source = input.adapter?.source || {};
    if(input.adapter?.distribution?.requested !== 'csv' || source.sourcePeriodConfirmed !== true
      || source.csvMonthlyDateUnknownCount !== 0) return null;
    const rows = input.taxEntryRows?.[kind];
    const groups = input.csvMonthlyGroups;
    if(!Array.isArray(rows) || !Array.isArray(groups)) return null;
    const expectedCode = kind === 'sales' ? '1' : '5';
    const taxable = rows.filter(row => kind === 'sales'
      ? ['1','11'].includes(String(row.code))
      : ['5','6','7','52','62','72'].includes(String(row.code)));
    if(!taxable.length || taxable.some(row => String(row.code) !== expectedCode || row.source !== 'csv')) return null;
    const rate = String(taxable[0].rate);
    if(!['8','10'].includes(rate) || taxable.some(row => String(row.rate) !== rate)) return null;
    const keyOf = row => `${row.code}|${row.rate}|${kind === 'sales' ? row.businessType || '' : ''}`;
    const current = new Map();
    for(const row of taxable){
      const amount = Number(String(row.amount ?? '').replace(/,/g,''));
      if(!Number.isSafeInteger(amount) || amount <= 0) return null;
      const key = keyOf(row);
      current.set(key,(current.get(key) || 0)+amount);
    }
    let sourceMonths;
    try{ sourceMonths = cashflow.monthDayWeights(source.sourcePeriodStart,source.sourcePeriodEnd); }
    catch{ return null; }
    if(sourceMonths.length !== weights.length || !sourceMonths.length) return null;
    const selected = groups.filter(group => (group.kind || group.side) === kind && String(group.code) !== '3');
    if(!selected.length || selected.some(group => String(group.code) !== expectedCode
      || String(group.rate) !== rate || !current.has(keyOf(group))
      || !sourceMonths.some(item => item.month === group.month)
      || !Number.isSafeInteger(Number(group.amount)) || Number(group.amount) < 0)) return null;
    for(const [key,amount] of current){
      if(selected.filter(group => keyOf(group) === key).reduce((sum,group) => sum + Number(group.amount),0) !== amount) return null;
    }
    const byMonth = sourceMonths.map(item => selected.filter(group => group.month === item.month)
      .reduce((sum,group) => sum + Number(group.amount),0));
    if(byMonth.reduce((sum,value) => sum + value,0) <= 0) return null;
    // 期間の月順を対象期へ対応付ける。CSVから実際の入出金月は推定しない。
    return byMonth;
  }

  function baseline(input, mode, sourceNote){
    const map = new Map();
    if(input.baselineFlows !== undefined){
      if(!Array.isArray(input.baselineFlows)) throw new TypeError('明示した月別A案日常増減を確認してください。');
      for(const item of input.baselineFlows){
        addTo(map,item?.month,yen(item?.amount,'明示した月別A案日常増減'),'月別A案日常増減');
      }
      if(input.actualCash?.status === 'complete')
        sourceNote.push(`共通ベースはCSV実績の月別資金増減（過去の消費税納付・還付と開始残高等を確認して除外）です。確認した資金科目：${input.actualCash.selectedAccounts.join('・')}。${input.actualCash.periodMapped ? '元資料の月順を対象期へ対応させた参考試算です。' : '元資料期間と対象期は同じ月順です。'}${Object.values(input.actualCash.commonDelta||{}).some(Boolean) ? '食品1％の取引差額はA/B双方の共通額に加算しています。' : ''}${input.actualCash.restored ? '保存済みの匿名月別集計から復元しました。' : ''}`);
      else if(input.baseSource?.kind === 'manual') sourceNote.push('共通ベースは対象期の各月へ手入力した資金増減です。入力単位は千円、小数第3位までを円に変換しています。対象期外の共通ベースは0円とし、A/Bの税金イベントは既存STEP4の計算結果を使用します。');
      else sourceNote.push('A案の表示用参考額は明示された月別円額を使用しています。');
      return map;
    }
    if(mode === 'methodImpact'){
      sourceNote.push('表示用参考額（従来方式）：課税方式比較では両案に共通する取引を相殺し、納付・還付による差だけを表示します。共通ベース0円は実際の営業収支0円を意味しません。');
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
    const salesCsv = csvBaselineWeights(input,'sales',weights);
    const purchasesCsv = csvBaselineWeights(input,'purchases',weights);
    const saleParts = cashflow.allocateExact(salesTax,salesCsv || weights.map(item => item.days));
    const purchaseParts = cashflow.allocateExact(purchaseTax,purchasesCsv || weights.map(item => item.days));
    weights.forEach((item,index) => {
      addTo(map,cashflow.shiftMonth(item.month,lags.sales),saleParts[index],'売上側の日常増減');
      addTo(map,cashflow.shiftMonth(item.month,lags.purchases),-purchaseParts[index],'仕入側の日常増減');
    });
    const basis = side => side ? '照合済みCSV月別構成比' : '対象日数均等';
    sourceNote.push(`表示用参考額（従来方式）：売上は${basis(salesCsv)}、仕入は${basis(purchasesCsv)}で作成した参考用の月別資金増減です。STEP3の現行税率側の売上税額・仕入税額を設定した回収・支払月ずれへ配置しています。CSV実績や実際の月次入出金ではありません。`);
    if(input.adapter?.distribution?.requested === 'csv') sourceNote.push(`B−Aの取引差額：売上は${input.adapter.distribution.bySide?.sales === 'csv' ? 'CSV月別構成比' : '対象日数均等'}、仕入は${input.adapter.distribution.bySide?.purchases === 'csv' ? 'CSV月別構成比' : '対象日数均等'}。A/B線は同じ実績月次入出金から作成したものではありません。`);
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
      if(input.baseSource?.status === 'unconfirmed')
        return unrenderable(input.baseSource.reason || '月別資金増減を確認してください。',input,mode,sourceNote);
      if(input.actualCash?.status === 'unconfirmed')
        return unrenderable(`CSV現預金実績を使うには確認が必要です。${input.actualCash.reason || ''}`,input,mode,sourceNote);
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
      let mismatch = null, engineMismatch = null;
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
        const tolerance=input.baseSource || input.actualCash?.status === 'complete' ? 0 : 1;
        if(source && Math.abs(yen(source.cumulative,'既存STEP4の累積差額')-expectedCumulative) > tolerance)
          engineMismatch ||= month;
        if(Math.abs(add(bTotal,-aTotal,'月別B−A差額')-expectedMonth) > tolerance
          || Math.abs(add(bCumulative,-aCumulative,'累積B−A差額')-expectedCumulative) > tolerance){
          mismatch ||= month;
        }
      }
      if(engine.rows.at(-1).cumulative !== expectedCumulative && months.at(-1) === engine.rows.at(-1).month)
        engineMismatch ||= months.at(-1);
      const interimState = input.interim?.status === 'auto' ? 'auto'
        : input.interim?.status === 'scheduled' ? 'manual'
        : input.interim?.status === 'none' ? 'none'
        : input.interim?.status === 'unknown' || engine.status !== 'complete' ? 'unconfirmed' : 'confirmed';
      const settlements = engine.status === 'complete' ? engine.settlement : null;
      const reasons = Array.isArray(engine.reasons) ? engine.reasons : [];
      const finalMonthEntered = settlements ? ['base','changed'].every(plan => settlements[plan] <= 0 || Boolean(engine.settlementMonths?.[plan]?.paymentMonth))
        : !reasons.some(reason => /納付予定月が未設定/.test(reason));
      const refundMonthEntered = settlements ? ['base','changed'].every(plan => settlements[plan] >= 0 || Boolean(engine.settlementMonths?.[plan]?.refundMonth))
        : !reasons.some(reason => /還付入金予定月が未設定/.test(reason));
      const notices = [];
      if(interimState === 'unconfirmed') notices.push('中間納付は未確認のため、グラフと表に反映していません。');
      if(!finalMonthEntered) notices.push('確定納付の予定月が未入力のため、グラフと表に反映していません。');
      if(!refundMonthEntered) notices.push('還付の入金予定月が未入力のため、グラフと表に反映していません。');
      if(priceBasisOf(input,mode) !== 'taxExclusiveFixed' && mode === 'rateImpact')
        notices.push('税込価格据置の前提のため、B案の線には価格前提による本体（税抜）部分の差を含みます。');
      if(input.manualFromAuto === true) notices.push('中間納付予定は手修正後の値です。');
      if(engineMismatch) notices.unshift(`内部整合エラー：${engineMismatch}の既存STEP4累積値が月次差額の累計と一致しません。`);
      else if(mismatch && engine.status === 'complete') notices.unshift(`内部整合エラー：${mismatch}のA/B差額が既存STEP4の累積資金差額と一致しません。`);
      else if(mismatch) notices.unshift(`未算定：${reasons.join('／') || '税金の未確認条件があるため'}、税金込みのA/B資金推移を確定できません。`);
      const integrity = engineMismatch || mismatch && engine.status === 'complete' ? 'mismatch'
        : mismatch ? 'unavailable' : 'ok';
      const status = {renderable:!mismatch && !engineMismatch,integrity,mode,
        taxComplete:engine.status === 'complete',
        reason:engineMismatch || mismatch ? notices[0].replace(/^未算定：/,'') : '',
        interim:interimState,finalMonthEntered,refundMonthEntered,
        sourceNote:sourceNote[0] || '',notes:distinctNotes([...sourceNote.slice(1),...notices,...(Array.isArray(input.notes) ? input.notes : [])])};
      const actualCash=input.actualCash?.status === 'complete' ? input.actualCash : null;
      const sourceKind=input.baseSource?.kind;
      const baseSource=sourceKind ? {kind:sourceKind,
        label:sourceKind === 'manual' ? '手入力の月別資金増減（共通ベース）'
          : sourceKind === 'csv' ? 'CSV現預金実績（共通ベース）' : '表示用参考額（共通ベース）',
        months:months.map(month=>({month,base:aFlows.get(month)||0})),
        commonDelta:actualCash?.commonDelta || {},
        note:sourceNote[0] || ''} : null;
      return {months,unitLabel:'千円',priceBasis:priceBasisOf(input,mode),actualCash,baseSource,
        cases:{A:{label:input.labels?.A || 'A案',rows:rows.A},B:{label:input.labels?.B || 'B案',rows:rows.B}},
        expectedDiff,status};
    }catch(error){
      return unrenderable(error.message,input,mode,sourceNote);
    }
  }

  return Object.freeze({buildPanelData,parseManualThousand,buildManualBase});
});
