(function(root,factory){
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./interim-tax-engine.js') : root.ShohizeiInterimTax,
    node ? require('./tax-calendar.js') : root.ShohizeiTaxCalendar,
    node ? require('./tax-engine.js') : root.ShohizeiTaxEngine);
  if(node) module.exports = api;
  root.ShohizeiPriorActualEvidence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this,function(interim,calendar,tax){
  'use strict';
  const USAGE = Object.freeze({'5':'taxableOnly','6':'nonTaxableOnly','7':'common',
    '52':'taxableOnly','62':'nonTaxableOnly','72':'common'});
  const EXEMPT = new Set(['52','62','72']);
  const EXEMPT_RATIOS = new Set(['80','70','50','30','0']);
  const methods = new Set(['regular','simplified','special2','special3']);
  const text = value => String(value ?? '').trim();
  const amount = value => interim.exactYen(typeof value === 'string' ? value.trim() : value);
  const checked = value => value === true || value === 'confirmed' || value === 'none';
  const samePeriod = (a,b) => a?.start === b?.start && a?.end === b?.end;
  function keyFor(side,item){
    const code = text(item.code ?? item.taxCode);
    if(code === '3') return JSON.stringify(['sales','3','','','']);
    return JSON.stringify([side,code,text(item.rate ?? item.ratePercent),
      side === 'sales' ? text(item.businessType) : '',EXEMPT.has(code) ? text(item.creditRatio).replace(/%$/,'') : '']);
  }
  function add(map,key,value){ map.set(key,(map.get(key)||0)+value); }
  function fromSharedCsv(input = {}){
    const reasons = [];
    const prior = input.priorFacts;
    const usesPurchases=input.exactMethod==='regular';
    const csv = input.csvSource;
    const result = {available:false,priorActual:null,reasons,source:null,reusedRows:0};
    if(prior?.status !== 'resolved' || !prior.value?.period
      || !calendar.parseDate(prior.value.period.start) || !calendar.parseDate(prior.value.period.end)
      || prior.value.period.start > prior.value.period.end) reasons.push('共有された実際の前課税期間が未確認・競合中です。');
    if(csv?.status !== 'resolved' || !csv.value) reasons.push('共有CSV元資料が未確認・競合中です。');
    const source = csv?.value;
    if(!source?.sourceId || !input.currentSourceId || source.sourceId !== input.currentSourceId)
      reasons.push('現在のCSVと共有元資料の同一性を確認できません。正式期間だけでは同じ資料と扱いません。');
    if(source?.periodConfirmed !== true || source?.fullMonthCoverageConfirmed !== true)
      reasons.push('CSVの正式期間・全月網羅の確認が必要です。');
    if(!samePeriod(source?.period,prior?.value?.period)) reasons.push('CSVの正式期間が共有された実際の前課税期間と一致しません。');
    if(!methods.has(input.exactMethod)) reasons.push('前期の正確な適用方式が未確認です。旧保存の「一般課税など」からは補完しません。');
    if(!Array.isArray(input.monthlyGroups) || !input.monthlyGroups.length)
      reasons.push('前期CSVの月別税区分集計がありません。');
    if(input.currentAggregateId && input.monthlyAggregateId && input.currentAggregateId !== input.monthlyAggregateId)
      reasons.push('現在行と月別集計の補正後集計版が一致しません。');
    if(usesPurchases && Number(input.dateUnknownCount || 0) > 0) reasons.push('CSVに日付不明の取引があり、正式前期への対応を確認できません。');
    if(reasons.length) return result;
    result.source = {id:source.sourceId,period:{...source.period}};
    const groupTotals = new Map();
    for(const [index,group] of input.monthlyGroups.entries()){
      const side = group.kind;
      if(side==='purchases'&&!usesPurchases)continue;
      const code = text(group.code);
      const value = amount(group.amount);
      const returned = side === 'sales' && code === '11';
      if(!['sales','purchases'].includes(side) || value === null || value < 0 && !returned
        || group.transactionKind && group.transactionKind !== 'ordinary' && !returned || code === '31'){
        reasons.push(`前期CSV月別集計${index+1}に返品・負額又は未対応の内訳があります。特例の再計算方法を確認してください。`); continue;
      }
      if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(text(group.month))
        || group.month < source.period.start.slice(0,7) || group.month > source.period.end.slice(0,7)){
        reasons.push(`前期CSV月別集計${index+1}の日付が不明又は正式前期の範囲外です。`); continue;
      }
      if(side === 'sales' ? !['1','11','3'].includes(code) : !USAGE[code]){
        reasons.push(`前期CSV月別集計${index+1}の課税区分${code || '不明'}は特例再計算に未対応です。`); continue;
      }
      if(code !== '3' && !['1','8','10'].includes(text(group.rate))){
        reasons.push(`前期CSV月別集計${index+1}の元税率が未確認です。`); continue;
      }
      if(side === 'purchases' && group.usage && group.usage !== USAGE[code]){
        reasons.push(`前期CSV月別集計${index+1}の用途と課税区分が一致しません。`); continue;
      }
      if(EXEMPT.has(code) && !EXEMPT_RATIOS.has(text(group.creditRatio))){
        reasons.push(`前期CSV月別集計${index+1}の控除割合が未確認です。`); continue;
      }
      add(groupTotals,keyFor(side,group),value);
    }
    const rowTotals = new Map();
    const transactions = [];
    let nonTaxable = 0,nonTaxableSeen = false,purchasesSeen = false,salesSeen = false;
    function append(side,row,value,rate,foodAmount,returned=false){
      const common = {side,originalRate:rate,businessType:text(row.businessType),transactionKind:returned ? 'return' : 'ordinary',
        ...(returned ? {originalTaxableState:row.originalTaxableState,sourceTaxCode:text(row.code),amountDirection:'return'} : {})};
      if(side === 'purchases'){
        common.usage = USAGE[text(row.code ?? row.taxCode)];
        common.creditRatio = EXEMPT.has(text(row.code ?? row.taxCode))
          ? Number(text(row.creditRatio).replace(/%$/,''))/100 : 1;
      }
      if(foodAmount !== 0 || value === 0 && rate === 8)
        transactions.push({...common,amount:foodAmount,category:'food'});
      if(value-foodAmount !== 0 || value === 0 && rate === 10)
        transactions.push({...common,amount:value-foodAmount,category:'other'});
    }
    for(const side of usesPurchases?['sales','purchases']:['sales']){
      for(const [index,row] of (Array.isArray(input.rows?.[side]) ? input.rows[side] : []).entries()){
        if(!text(row.code) && !text(row.amount) && !text(row.foodAmount)) continue;
        const value = amount(row.amount),code = text(row.code);
        if(!['csv','csv-edited'].includes(row.source)){
          reasons.push(`前期${side === 'sales' ? '売上' : '仕入'}行${index+1}はCSV由来ではありません。当期手入力を実前期資料へ転用しません。`); continue;
        }
        const returned = side === 'sales' && code === '11';
        if(value === null || value < 0 && !returned || row.transactionKind && row.transactionKind !== 'ordinary' && !returned
          || Number(row.sourceAdjustmentCount||0)>0 && !returned || code === '31'){
          reasons.push(`前期CSV行${index+1}の負額・返品・金額を確認してください。`); continue;
        }
        if(Number(row.sourceDateUnknownCount||0)>0){ reasons.push(`前期CSV行${index+1}に日付不明の取引があります。`); continue; }
        if(code === '3' && side === 'sales'){
          nonTaxable += value;nonTaxableSeen = true;
          add(rowTotals,keyFor(side,row),value);result.reusedRows++;continue;
        }
        if(side === 'sales' ? !['1','11'].includes(code) : !USAGE[code]){
          reasons.push(`前期CSV行${index+1}の輸入・未対応課税区分${code || '不明'}は内訳確認が必要です。`);continue;
        }
        if(returned && !['taxable','exempt'].includes(row.originalTaxableState)){
          reasons.push(`前期CSV返還行${index+1}の元取引時の課税・免税状態が未確認です。元税率だけで返還控除を補完しません。`);continue;
        }
        const rate = Number(row.rate);
        if(![8,10].includes(rate)){ reasons.push(`前期CSV行${index+1}の元税率が未確認です。明示1％は実績サイドカーと照合します。`); continue; }
        if(EXEMPT.has(code) && !EXEMPT_RATIOS.has(text(row.creditRatio).replace(/%$/,''))){
          reasons.push(`前期CSV行${index+1}の控除割合が未確認です。`); continue;
        }
        if(input.exactMethod === 'simplified' && side === 'sales' && !/^type[1-6]$/.test(text(row.businessType))){
          reasons.push(`前期CSV売上行${index+1}の法令上の事業区分が未確認です。`); continue;
        }
        let food = 0;
        if(rate === 8){
          const confirmation = side === 'sales' ? input.foodSalesConfirmed : input.foodPurchasesConfirmed;
          if(!checked(confirmation)){reasons.push(`前期CSVの食品${side === 'sales' ? '売上' : '仕入'}区分が未確認です。自動初期値を照合済みとは扱いません。`);continue;}
          food = confirmation === 'none' && !text(row.foodAmount) ? 0 : amount(row.foodAmount);
          if(food === null || Math.abs(food) > Math.abs(value)
            || food !== 0 && Math.sign(food) !== Math.sign(value) || confirmation === 'none' && food !== 0){
            reasons.push(`前期CSV行${index+1}の食品内数が未入力又は確認状態と矛盾しています。`);continue;
          }
        }else if(text(row.foodAmount) && amount(row.foodAmount) !== 0){
          reasons.push(`前期CSV行${index+1}の標準税率行に食品1％内数があります。`);continue;
        }
        add(rowTotals,keyFor(side,row),returned ? -value : value);
        append(side,row,value,rate,food,returned);
        if(side === 'sales')salesSeen = true;else purchasesSeen = true;
        result.reusedRows++;
      }
    }
    const actualTotals = new Map();
    for(const [index,entry] of (Array.isArray(input.actualOnePercentEntries) ? input.actualOnePercentEntries : []).entries()){
      if(!usesPurchases&&['invoicePurchase','exemptPurchase'].includes(entry.kind))continue;
      const side = entry.kind === 'sale' ? 'sales' : ['invoicePurchase','exemptPurchase'].includes(entry.kind) ? 'purchases' : '';
      const value = amount(entry.amount);
      const date = text(entry.date);
      const confirmation = side === 'sales' ? input.foodSalesConfirmed : input.foodPurchasesConfirmed;
      const assessed = tax.assessCsvOnePercentEntry(entry);
      const returned = entry.transactionKind === 'adjustment' && (text(entry.taxCode)==='11' || entry.returnConfirmed===true);
      if(!side || value === null || value < 0 && !returned || Number(entry.ratePercent) !== 1 || assessed.status !== 'confirmed'
        || !calendar.parseDate(date) || date < source.period.start || date > source.period.end
        || entry.transactionKind !== 'ordinary' && !returned || returned && !['taxable','exempt'].includes(entry.originalTaxableState)
        || entry.amountMode && entry.amountMode !== 'included'
        || entry.source && entry.source !== 'csvActual' || !checked(confirmation) || confirmation === 'none'){
        reasons.push(`前期明示1％実績${index+1}の食品区分・元税率・取引日・返品区分が未確認又は正式前期の範囲外です。`);continue;
      }
      const code = text(entry.taxCode || (side === 'sales' ? '1' : entry.kind === 'exemptPurchase'
        ? {taxableOnly:'52',nonTaxableOnly:'62',common:'72'}[entry.usage]
        : {taxableOnly:'5',nonTaxableOnly:'6',common:'7'}[entry.usage]));
      const ratio = entry.kind === 'exemptPurchase' ? Number(entry.creditRatio) : 1;
      const row = {...entry,code,rate:'1',creditRatio:entry.kind === 'exemptPurchase' ? String(ratio*100) : ''};
      if(side === 'sales' && (returned ? code !== '11' && !entry.returnConfirmed : code !== '1') || side === 'purchases' && (!USAGE[code] || USAGE[code] !== entry.usage)
        || entry.kind === 'exemptPurchase' && (!EXEMPT.has(code) || !EXEMPT_RATIOS.has(String(ratio*100)))
        || input.exactMethod === 'simplified' && side === 'sales' && !/^type[1-6]$/.test(text(entry.businessType))){
        reasons.push(`前期明示1％実績${index+1}の課税区分・用途・事業区分・控除割合を確認してください。`);continue;
      }
      add(actualTotals,keyFor(side,row),value);
      transactions.push({side,amount:value,originalRate:1,category:'food',businessType:text(entry.businessType),
        ...(side === 'purchases' ? {usage:USAGE[code],creditRatio:ratio} : {}),transactionKind:returned ? 'return' : 'ordinary',
        ...(returned ? {originalTaxableState:entry.originalTaxableState,amountDirection:'signed',sourceTaxCode:code} : {})});
      if(side === 'sales')salesSeen=true;else purchasesSeen=true;
    }
    for(const [key,value] of actualTotals)add(rowTotals,key,value);
    const keys = new Set([...groupTotals.keys(),...rowTotals.keys()]);
    for(const key of keys){
      if(!groupTotals.has(key) || !rowTotals.has(key) || groupTotals.get(key) !== rowTotals.get(key)
        || !Number.isSafeInteger(groupTotals.get(key)) || !Number.isSafeInteger(rowTotals.get(key)))
        reasons.push('現在のCSV行と元資料の税区分・税率・事業・控除割合別月総額が一致しません。編集後の金額を実前期資料へ推定統合しません。');
    }
    if(!nonTaxableSeen && input.knownNonTaxableZero === true){nonTaxable = 0;nonTaxableSeen = true;}
    if(input.exactMethod === 'regular' && !nonTaxableSeen) reasons.push('前期CSVの非課税売上が未確認です。既存のCSV由来の該当なし情報又は内訳が必要です。');
    if(!salesSeen) reasons.push('実前期CSVの課税売上内訳がありません。明示0円の資料確認が必要です。');
    if(input.exactMethod === 'regular' && !purchasesSeen){
      if(input.knownPurchaseZero === true){
        transactions.push({side:'purchases',amount:0,originalRate:10,category:'other',usage:'taxableOnly',creditRatio:1,transactionKind:'ordinary'});
      }else reasons.push('実前期CSVの課税仕入内訳がありません。明示0円の資料確認が必要です。');
    }
    if(input.exactMethod === 'regular'){
      if(!['full','individual','proportional'].includes(input.creditMethod)) reasons.push('実前期の仕入税額控除方法が未確認です。');
      if(amount(input.adjustmentNational) === null) reasons.push('実前期の国税調整額が未入力です（該当なしは0円）。');
    }
    result.reasons = [...new Set(reasons)];
    if(result.reasons.length)return result;
    result.available = true;
    result.priorActual = {source:'actual',period:{...prior.value.period},exactMethod:input.exactMethod,transactions,
      ...(nonTaxableSeen ? {nonTaxableSales:nonTaxable} : {}),
      ...(input.exactMethod === 'regular' ? {creditMethod:input.creditMethod,adjustmentNational:amount(input.adjustmentNational)} : {}),
      evidence:{sourceId:source.sourceId,period:{...source.period},basis:'shared-prior-csv',
        monthlyTotalsMatched:true,foodClassificationVerified:true,
        usedSides:usesPurchases?['sales','purchases']:['sales'],
        foodClassificationVerifiedSides:usesPurchases?['sales','purchases']:['sales']}};
    return result;
  }
  return Object.freeze({fromSharedCsv});
});
