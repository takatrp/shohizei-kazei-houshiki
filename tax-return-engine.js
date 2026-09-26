(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiTaxReturn = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const RATES = Object.freeze({ '8':{national:624,total:10800,base:10000}, '10':{national:78,total:1100,base:1000} });
  const fullCreditPeriod = typeof module === 'object' && module.exports
    ? require('./tax-engine.js').assessFullCreditPeriod
    : globalThis.ShohizeiTaxEngine?.assessFullCreditPeriod;
  const USAGES = Object.freeze(['taxableOnly','nonTaxableOnly','common']);
  const floorUnit = (value, unit) => Math.floor(value / unit) * unit;
  const emptyRates = () => ({'8':0,'10':0});
  const sumRates = values => values['8'] + values['10'];
  function integer(value, label){
    if(!Number.isSafeInteger(value)) throw new TypeError(`${label}は整数円で指定してください。`);
    return value;
  }
  function amount(values, rate, label){ return integer(Number(values?.[rate] ?? 0), `${label} ${rate}％`); }
  function nationalFromGross(gross, rate){
    const spec = RATES[rate];
    if(!spec) throw new TypeError(`未対応税率: ${rate}`);
    return Math.floor(integer(gross,'税込金額') * spec.national / spec.total);
  }
  function exemptNationalFromGross(gross, rate, ratio){
    if(!Number.isInteger(ratio) || ratio < 0 || ratio > 100) throw new RangeError('免税仕入の控除割合を確認してください。');
    return Math.floor(integer(gross,'免税仕入税込金額') * RATES[rate].national / RATES[rate].total * ratio / 100);
  }

  function aggregateReturnInputs(analysis, options = {}){
    if(!analysis || !analysis.returnSales || !analysis.purchaseAmountsByUse) throw new TypeError('CSVの申告書用集計がありません。');
    const adjustments = options.purchaseAdjustments || {};
    const invoiceByUse = {};
    const exemptByUse = {};
    for(const usage of USAGES){
      invoiceByUse[usage] = emptyRates();
      exemptByUse[usage] = {};
      for(const rate of Object.keys(RATES)){
        invoiceByUse[usage][rate] = amount(analysis.purchaseAmountsByUse[usage]?.invoice,rate,`${usage}仕入`)
          + amount(adjustments[usage],rate,`${usage}申告調整`);
        if(invoiceByUse[usage][rate] < 0) throw new RangeError('調整後の課税仕入額がマイナスです。');
      }
      for(const ratio of ['80','70','50','30','0']){
        exemptByUse[usage][ratio] = Object.fromEntries(Object.keys(RATES).map(rate => [rate,
          amount(analysis.purchaseAmountsByUse[usage]?.exempt?.[ratio],rate,`${usage}免税仕入${ratio}％`)]));
      }
    }
    const hasOnePercent = Boolean(analysis.returnSales.taxableGross?.['1'] || analysis.returnSales.returnGross?.['1']
      || analysis.invoicePurchases?.['1'] || Object.values(analysis.exemptPurchases || {}).some(group => group?.['1']));
    return {
      taxableSalesGross:analysis.returnSales.taxableGross,
      salesReturnGross:analysis.returnSales.returnGross,
      nonTaxableSales:integer(analysis.nonTaxableSales,'非課税売上'),
      invoiceByUse, exemptByUse,
      unsupportedCodes:[...(analysis.unsupportedEntries || []).map(item => item.code),...(analysis.unhandledReturnCodes || []),...(hasOnePercent ? ['1％'] : [])],
      unresolvedCount:(analysis.problemEntries || []).filter(item => item.status === 'unresolved').length,
      temporaryExcludedCount:(analysis.problemEntries || []).filter(item => item.status === 'temporaryExcluded').length,
      adjustments
    };
  }

  // Current rows, not the CSV import snapshot, own every subsequent result.
  function aggregateReturnRows(rows, options = {}){
    const errors = [];
    const taxableSalesGross = emptyRates();
    const salesReturnGross = emptyRates();
    const invoiceByUse = Object.fromEntries(USAGES.map(usage => [usage,emptyRates()]));
    const exemptByUse = Object.fromEntries(USAGES.map(usage => [usage,{}]));
    const salesByType = {};
    let nonTaxableSales = 0;
    let nonTaxableEntered = options.knownNonTaxableZero === true;
    const parseRow = (row,label) => {
      const raw = String(row.amount ?? '').trim().replace(/,/g,'');
      if(!/^[+-]?\d+$/.test(raw)) { errors.push(`${label}の税込金額を整数円で入力してください。`); return null; }
      const value = Number(raw);
      if(!Number.isSafeInteger(value)){ errors.push(`${label}の税込金額が整数円の範囲外です。`); return null; }
      return value;
    };
    for(const [side,list] of [['sales',rows?.sales],['purchases',rows?.purchases]]){
      for(const row of Array.isArray(list) ? list : []){
        if(!row || !String(row.code || '').trim() && !String(row.amount ?? '').trim()) continue;
        const code = String(row.code || '').trim();
        const value = parseRow(row,`課税区分${code || '未選択'}`);
        if(value === null) continue;
        if(side === 'sales' && code === '3'){
          nonTaxableSales += value;
          nonTaxableEntered = true;
          continue;
        }
        const rate = String(row.rate || '').trim();
        if(!RATES[rate]){ errors.push(`課税区分${code}の税率を10％または軽減8％で指定してください。`); continue; }
        if(side === 'sales' && (code === '1' || code === '11')){
          if(value < 0){ errors.push('売上返還等は課税区分11へ正の税込金額で入力してください。'); continue; }
          if(code === '1') taxableSalesGross[rate] += value;
          else salesReturnGross[rate] += value;
          const type = String(row.businessType || '').trim();
          if(type){
            salesByType[type] ||= {gross:emptyRates(),returns:emptyRates()};
            salesByType[type][code === '1' ? 'gross' : 'returns'][rate] += value;
          }
          continue;
        }
        const use = {'5':'taxableOnly','6':'nonTaxableOnly','7':'common','52':'taxableOnly','62':'nonTaxableOnly','72':'common'}[code];
        if(side !== 'purchases' || !use){ errors.push(`未対応の課税区分${code}があります。`); continue; }
        if(['52','62','72'].includes(code)){
          const ratio = String(row.creditRatio || '').trim().replace(/%$/,'');
          if(!['80','70','50','30','0'].includes(ratio)){ errors.push(`課税区分${code}の控除割合を確認してください。`); continue; }
          exemptByUse[use][ratio] ||= emptyRates();
          exemptByUse[use][ratio][rate] += value;
        }else invoiceByUse[use][rate] += value;
      }
    }
    if(nonTaxableSales < 0) errors.push('非課税売上等の合計がマイナスです。');
    return {input:{taxableSalesGross,salesReturnGross,nonTaxableSales,invoiceByUse,exemptByUse,
      nonTaxableEntered,salesByType,unsupportedCodes:options.unsupportedCodes || [],
      unresolvedCount:options.unresolvedCount || 0,temporaryExcludedCount:options.temporaryExcludedCount || 0},reasons:errors};
  }

  function buildSchedule23(input, method = 'individual'){
    if(!['auto','individual','proportional','full'].includes(method)) throw new TypeError('控除方法を確認してください。');
    const taxableTransfer = emptyRates();
    const returnTransfer = emptyRates();
    const taxableSalesNet = emptyRates();
    const returnNationalTax = emptyRates();
    const invoiceGross = emptyRates();
    const invoiceNationalTax = emptyRates();
    const exemptGross = emptyRates();
    const exemptCreditableTax = emptyRates();
    const exemptGrossByRatio = {};
    const exemptTaxByRatio = {};
    const purchaseTaxTotal = emptyRates();
    const purchaseTaxByUse = Object.fromEntries(USAGES.map(usage => [usage,emptyRates()]));
    const useRoundingDifferences = [];
    for(const rate of Object.keys(RATES)){
      const gross = amount(input.taxableSalesGross,rate,'課税売上');
      const returned = amount(input.salesReturnGross,rate,'売上返還');
      if(gross < 0 || returned < 0) throw new RangeError('売上・売上返還等の集計額がマイナスです。元仕訳を確認してください。');
      taxableTransfer[rate] = Math.floor(gross * 100 / (100 + Number(rate)));
      returnTransfer[rate] = Math.floor(returned * 100 / (100 + Number(rate)));
      taxableSalesNet[rate] = taxableTransfer[rate] - returnTransfer[rate];
      returnNationalTax[rate] = nationalFromGross(returned,rate);
      for(const usage of USAGES){
        const invoice = amount(input.invoiceByUse?.[usage],rate,`${usage}仕入`);
        if(invoice < 0) throw new RangeError('仕入の集計額がマイナスです。元仕訳を確認してください。');
        invoiceGross[rate] += invoice;
        const invoiceTax = nationalFromGross(invoice,rate);
        invoiceNationalTax[rate] += invoiceTax;
        purchaseTaxByUse[usage][rate] += invoiceTax;
        for(const [ratio, group] of Object.entries(input.exemptByUse?.[usage] || {})){
          const exempt = amount(group,rate,`${usage}免税仕入${ratio}％`);
          if(exempt < 0) throw new RangeError('免税仕入の集計額がマイナスです。元仕訳を確認してください。');
          exemptGrossByRatio[ratio] ||= emptyRates();
          exemptTaxByRatio[ratio] ||= emptyRates();
          exemptGross[rate] += exempt;
          exemptGrossByRatio[ratio][rate] += exempt;
          const tax = exemptNationalFromGross(exempt,rate,Number(ratio));
          exemptCreditableTax[rate] += tax;
          exemptTaxByRatio[ratio][rate] += tax;
          purchaseTaxByUse[usage][rate] += tax;
        }
      }
      if(invoiceNationalTax[rate] !== nationalFromGross(invoiceGross[rate],rate))
        useRoundingDifferences.push('付表2-3⑩の税率別総額と用途別端数に差があります。');
      invoiceNationalTax[rate] = nationalFromGross(invoiceGross[rate],rate);
      for(const ratio of Object.keys(exemptGrossByRatio)){
        if(exemptTaxByRatio[ratio][rate] !== exemptNationalFromGross(exemptGrossByRatio[ratio][rate],rate,Number(ratio)))
          useRoundingDifferences.push('付表2-3⑫の税率・経過措置別総額と用途別端数に差があります。');
        exemptTaxByRatio[ratio][rate] = exemptNationalFromGross(exemptGrossByRatio[ratio][rate],rate,Number(ratio));
      }
      exemptCreditableTax[rate] = Object.values(exemptTaxByRatio).reduce((sum,group) => sum + group[rate],0);
      purchaseTaxTotal[rate] = invoiceNationalTax[rate] + exemptCreditableTax[rate];
    }
    const taxableSales = sumRates(taxableSalesNet);
    if(taxableSales < 0) throw new RangeError('売上返還等控除後の課税売上がマイナスです。元仕訳を確認してください。');
    const denominator = taxableSales + integer(input.nonTaxableSales,'非課税売上');
    const ratioRaw = denominator > 0 ? taxableSales / denominator : null;
    if(ratioRaw === null) throw new RangeError('課税売上割合の分母が0円のため、申告書計算を確定できません。');
    const ratioDisplayPercent = ratioRaw === null ? null : Math.floor(ratioRaw * 10000) / 100;
    if(typeof fullCreditPeriod !== 'function') throw new Error('課税期間の全額控除判定を読み込めません。');
    const periodAssessment = fullCreditPeriod({
      periodStart:input.periodStart,periodEnd:input.periodEnd,periodMonths:input.periodMonths,
      taxableSales,nonTaxableSales:input.nonTaxableSales
    });
    const fullCreditEligible = periodAssessment.valid && periodAssessment.fullCreditEligible;
    if(method === 'auto'){
      if(!periodAssessment.valid) throw new RangeError(`${periodAssessment.reasons.join(' ')}全額控除の可否を確認してください。`);
      if(!fullCreditEligible){
        const threshold = periodAssessment.salesThresholdEligible ? ''
          : `5億円判定用の年換算額は${Math.ceil(periodAssessment.annualizedTaxableSales).toLocaleString('ja-JP')}円（1円未満切上げ表示）です。`;
        const ratio = periodAssessment.ratioEligible ? '' : '当期の課税売上割合は95％未満です。';
        throw new RangeError(`当期${periodAssessment.periodMonths}か月・課税売上${taxableSales.toLocaleString('ja-JP')}円。${threshold}${ratio}全額控除の要件を満たしません。個別対応方式か一括比例配分方式を選択してください。`);
      }
      method = 'full';
    }
    if(method === 'full' && !periodAssessment.valid)
      throw new RangeError(`${periodAssessment.reasons.join(' ')}全額控除の可否を確認してください。`);
    if(method === 'full' && !fullCreditEligible) throw new RangeError('年換算課税売上5億円超または当期の課税売上割合95％未満のため全額控除は選択できません。');
    if(method === 'individual' && useRoundingDifferences.length)
      throw new RangeError(`${[...new Set(useRoundingDifferences)].join(' ')}申告書で端数配賦を確認してください。`);
    const creditableByRate = emptyRates();
    for(const rate of Object.keys(RATES)){
      creditableByRate[rate] = method === 'full' ? purchaseTaxTotal[rate]
        : method === 'individual' ? purchaseTaxByUse.taxableOnly[rate] + Math.floor(purchaseTaxByUse.common[rate] * (ratioRaw ?? 0))
          : Math.floor(purchaseTaxTotal[rate] * (ratioRaw ?? 0));
    }
    return {
      method, fullCreditEligible, periodAssessment, periodMonths:periodAssessment.periodMonths,
      annualizedTaxableSales:periodAssessment.annualizedTaxableSales,
      periodReasons:periodAssessment.reasons,taxableTransfer, returnTransfer, taxableSalesNet, taxableSales,
      nonTaxableSales:input.nonTaxableSales, denominator, ratioRaw, ratioDisplayPercent,
      invoiceGross, invoiceNationalTax, exemptGross, exemptCreditableTax, exemptGrossByRatio, exemptTaxByRatio, purchaseTaxTotal,
      purchaseTaxByUse, creditableByRate, creditableTotal:sumRates(creditableByRate), returnNationalTax,
      fields:{'①A':taxableSalesNet['8'],'①B':taxableSalesNet['10'],'①C':taxableSales,'④C':taxableSales,'⑤C':taxableSales,'⑥C':input.nonTaxableSales,
        '⑦C':denominator,'⑧C':ratioDisplayPercent,'⑨A':invoiceGross['8'],'⑨B':invoiceGross['10'],'⑨C':sumRates(invoiceGross),
        '⑩A':invoiceNationalTax['8'],'⑩B':invoiceNationalTax['10'],'⑩C':sumRates(invoiceNationalTax),
        '⑪A':exemptGross['8'],'⑪B':exemptGross['10'],'⑪C':sumRates(exemptGross),
        '⑫A':exemptCreditableTax['8'],'⑫B':exemptCreditableTax['10'],'⑫C':sumRates(exemptCreditableTax),
        '⑰A':purchaseTaxTotal['8'],'⑰B':purchaseTaxTotal['10'],'⑰C':sumRates(purchaseTaxTotal),
        '⑲A':purchaseTaxByUse.taxableOnly['8'],'⑲B':purchaseTaxByUse.taxableOnly['10'],'⑲C':sumRates(purchaseTaxByUse.taxableOnly),
        '㉑A':creditableByRate['8'],'㉑B':creditableByRate['10'],'㉑C':sumRates(creditableByRate),
        '㉖A':creditableByRate['8'],'㉖B':creditableByRate['10'],'㉖C':sumRates(creditableByRate)}
    };
  }

  function buildSchedule13(input, schedule23){
    const taxableBase = Object.fromEntries(Object.keys(RATES).map(rate => [rate,
      floorUnit(schedule23.taxableTransfer[rate],1000)]));
    const salesTax = Object.fromEntries(Object.keys(RATES).map(rate => [rate,
      Math.floor(taxableBase[rate] * RATES[rate].national / RATES[rate].base)]));
    const deductionSubtotal = schedule23.creditableTotal + sumRates(schedule23.returnNationalTax);
    const nationalRaw = sumRates(salesTax) - deductionSubtotal;
    const national = nationalRaw >= 0 ? floorUnit(nationalRaw,100) : -Math.floor(-nationalRaw);
    const local = national >= 0 ? floorUnit(Math.floor(national * 22 / 78),100) : -Math.floor(-national * 22 / 78);
    return {taxableBase,salesTax,returnNationalTax:schedule23.returnNationalTax,deductionSubtotal,nationalRaw,national,local,
      fields:{'①A':taxableBase['8'],'①B':taxableBase['10'],'①1A':schedule23.taxableTransfer['8'],'①1B':schedule23.taxableTransfer['10'],
        '②A':salesTax['8'],'②B':salesTax['10'],
        '④A':schedule23.creditableByRate['8'],'④B':schedule23.creditableByRate['10'],'④C':schedule23.creditableTotal,
        '⑤A':schedule23.returnNationalTax['8'],'⑤B':schedule23.returnNationalTax['10'],'⑦C':deductionSubtotal,'⑨C':national,'⑪C':national,'⑬C':local}};
  }

  function buildMainReturn(schedule13){
    return {fields:{'①':sumRates(schedule13.taxableBase),'②':sumRates(schedule13.salesTax),
      '④':schedule13.fields['④C'],'⑤':sumRates(schedule13.returnNationalTax),
      '⑦':schedule13.deductionSubtotal,'⑨':schedule13.national,'⑱':schedule13.national,'⑳':schedule13.local},
      national:schedule13.national,local:schedule13.local,totalBeforeInterim:schedule13.national + schedule13.local};
  }

  function salesStage(input){
    const grossTax = emptyRates(), returnsTax = emptyRates(), taxableBase = emptyRates();
    for(const rate of Object.keys(RATES)){
      const gross = amount(input.taxableSalesGross,rate,'課税売上');
      const returned = amount(input.salesReturnGross,rate,'売上返還');
      if(gross < 0 || returned < 0 || returned > gross) throw new RangeError('課税売上と売上返還等の税込額・符号を確認してください。');
      taxableBase[rate] = floorUnit(Math.floor(gross * 100 / (100 + Number(rate))),1000);
      grossTax[rate] = Math.floor(taxableBase[rate] * RATES[rate].national / RATES[rate].base);
      returnsTax[rate] = nationalFromGross(returned,rate);
    }
    return {grossTax,returnsTax,taxableBase,nationalSales:sumRates(grossTax)-sumRates(returnsTax)};
  }

  function finishNational(raw){
    const national = raw >= 0 ? floorUnit(raw,100) : -Math.floor(-raw);
    const local = national >= 0 ? floorUnit(Math.floor(national * 22 / 78),100) : -Math.floor(-national * 22 / 78);
    return {national,local,totalBeforeInterim:national+local};
  }

  // Schedule 5-3 keeps the tax base in ④ separate from the business-type
  // composition in ⑬. Use integer ratios for every intermediate yen floor.
  function floorPositiveRatio(value, numerator, denominator){
    if(!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(numerator) || numerator < 0
      || !Number.isSafeInteger(denominator) || denominator <= 0) throw new RangeError('付表5-3の計算基礎を確認してください。');
    const result = Number(BigInt(value) * BigInt(numerator) / BigInt(denominator));
    if(!Number.isSafeInteger(result)) throw new RangeError('付表5-3の計算額が整数円の範囲外です。');
    return result;
  }

  function simplifiedSchedule53(input, stage, deemedByType){
    const keys = Object.keys(input.salesByType || {});
    const statutoryPercent = {type1:90,type2:80,type3:70,type4:60,type5:50,type6:40};
    const basisTaxByRate = Object.fromEntries(Object.keys(RATES).map(rate =>
      [rate,stage.grossTax[rate] - stage.returnsTax[rate]]));
    const grossByRate = emptyRates(), returnsByRate = emptyRates(), divisorByRate = emptyRates();
    const rows = keys.map(key => {
      const deemedPercent = statutoryPercent[key];
      if(!deemedPercent || Number(deemedByType[key]) !== deemedPercent / 100)
        throw new RangeError('簡易課税の事業区分とみなし仕入率を確認してください。');
      const group = input.salesByType[key];
      const byRate = {};
      for(const rate of Object.keys(RATES)){
        const gross = amount(group?.gross,rate,`${key}売上`);
        const returned = amount(group?.returns,rate,`${key}返還`);
        if(gross < 0 || returned < 0 || returned > gross)
          throw new RangeError(`${key}の税込売上・返還額を確認してください。`);
        const grossBase = floorPositiveRatio(gross,100,100 + Number(rate));
        const returnBase = floorPositiveRatio(returned,100,100 + Number(rate));
        const base = grossBase - returnBase;
        const grossTax = floorPositiveRatio(gross,RATES[rate].national,RATES[rate].total);
        const returnTax = floorPositiveRatio(returned,RATES[rate].national,RATES[rate].total);
        const national = grossTax - returnTax;
        if(base < 0 || national < 0) throw new RangeError(`${key}の返還等控除後の税額を確認してください。`);
        grossByRate[rate] += gross;
        returnsByRate[rate] += returned;
        divisorByRate[rate] += national;
        byRate[rate] = {gross,returned,grossBase,returnBase,base,grossTax,returnTax,national};
      }
      return {key,deemed:deemedPercent / 100,deemedPercent,byRate,
        national:Object.values(byRate).reduce((sum,rate) => sum + rate.national,0),
        base:Object.values(byRate).reduce((sum,rate) => sum + rate.base,0)};
    });
    for(const rate of Object.keys(RATES)){
      if(grossByRate[rate] !== amount(input.taxableSalesGross,rate,'課税売上')
        || returnsByRate[rate] !== amount(input.salesReturnGross,rate,'売上返還'))
        throw new RangeError(`税率${rate}％の税込売上・返還額と事業区分別の内訳が一致しません。`);
      if(basisTaxByRate[rate] < 0 || (basisTaxByRate[rate] > 0 && divisorByRate[rate] <= 0))
        throw new RangeError(`税率${rate}％の付表5-3計算基礎・事業区分別税額を確認してください。`);
    }
    const totalBase = rows.reduce((sum,row) => sum + row.base,0);
    if(!Number.isSafeInteger(totalBase) || totalBase <= 0)
      throw new RangeError('簡易課税の事業区分別課税売上高を確認してください。');
    const active = rows.filter(row => row.base > 0);
    const candidates = [];
    const addCandidate = (kind,label,numeratorForRate) => {
      const byRate = {}, numeratorByRate = {};
      for(const rate of Object.keys(RATES)){
        const denominator = divisorByRate[rate];
        const numerator = numeratorForRate(rate,denominator);
        numeratorByRate[rate] = numerator;
        byRate[rate] = denominator === 0 ? 0
          : floorPositiveRatio(basisTaxByRate[rate],numerator,denominator);
      }
      candidates.push({kind,label,byRate,numeratorByRate,credit:sumRates(byRate)});
    };
    if(active.length === 1){
      const row = active[0];
      const byRate = Object.fromEntries(Object.keys(RATES).map(rate =>
        [rate,floorPositiveRatio(basisTaxByRate[rate],row.deemedPercent,100)]));
      candidates.push({kind:'normal',label:'通常計算',byRate,numeratorByRate:null,credit:sumRates(byRate)});
    }else{
      addCandidate('normal','通常計算',rate => rows.reduce((sum,row) =>
        sum + floorPositiveRatio(row.byRate[rate].national,row.deemedPercent,100),0));
      for(const row of active){
        if(BigInt(row.base) * 4n >= BigInt(totalBase) * 3n){
          const byRate = Object.fromEntries(Object.keys(RATES).map(rate =>
            [rate,floorPositiveRatio(basisTaxByRate[rate],row.deemedPercent,100)]));
          candidates.push({kind:'single75',label:`75％特例（${row.key}）`,byRate,
            numeratorByRate:null,credit:sumRates(byRate),businessTypes:[row.key]});
        }
      }
      if(active.length >= 3) for(let i=0;i<active.length-1;i++) for(let j=i+1;j<active.length;j++){
        const a = active[i],b = active[j];
        if(BigInt(a.base + b.base) * 4n < BigInt(totalBase) * 3n) continue;
        const high = a.deemedPercent >= b.deemedPercent ? a : b;
        const low = high === a ? b : a;
        addCandidate('pair75',`75％特例（${high.key}・${low.key}）`,rate =>
          floorPositiveRatio(high.byRate[rate].national,high.deemedPercent,100)
          + floorPositiveRatio(divisorByRate[rate]-high.byRate[rate].national,low.deemedPercent,100));
        candidates[candidates.length-1].businessTypes = [high.key,low.key];
      }
    }
    const chosen = candidates.reduce((best,item) => item.credit > best.credit ? item : best,candidates[0]);
    return {rows,totalBase,grossByRate,returnsByRate,basisTaxByRate,divisorByRate,candidates,chosen,
      source:'付表5-3（R1.10.1以後終了課税期間用）',selectionReason:'税率を通じて同一方式を適用し、控除額合計が最大の候補を採用'};
  }

  function calculateCurrentLawSalesMethod(input, method, deemedByType = {}, options = {}){
    if(!['simplified','special2','special3'].includes(method)) throw new TypeError('申告方式を確認してください。');
    const reasons = [];
    if(input.unresolvedCount) reasons.push(`未処理のCSV明細${input.unresolvedCount}件`);
    if(input.temporaryExcludedCount && !options.allowTemporaryExcluded) reasons.push(`仮除外のCSV明細${input.temporaryExcludedCount}件`);
    if(input.unsupportedCodes?.length) reasons.push(`未対応課税区分${[...new Set(input.unsupportedCodes)].join('・')}`);
    if(reasons.length) return {complete:false,exactComplete:false,referenceCalculable:false,reasons};
    const provisionalReasons = [...new Set([...(options.provisionalReasons || []),
      ...(input.temporaryExcludedCount ? [`仮除外のCSV明細${input.temporaryExcludedCount}件。除外部分の税額影響は未算定`] : [])])];
    const exactComplete = provisionalReasons.length === 0;
    const stage = salesStage(input);
    let credit = 0, methodLabel = '', selection = null, basisRows = [];
    let schedule53 = null;
    if(method === 'simplified'){
      schedule53 = simplifiedSchedule53(input,stage,deemedByType);
      credit = schedule53.chosen.credit;
      methodLabel = schedule53.chosen.label;
      selection = {...schedule53.chosen,totalBase:schedule53.totalBase,candidates:schedule53.candidates,
        reason:schedule53.selectionReason};
      basisRows = schedule53.rows;
    }else{
      credit = Math.floor(stage.nationalSales * (method === 'special2' ? 0.8 : 0.7));
      methodLabel = method === 'special2' ? '2割特例' : '3割特例';
    }
    return {complete:exactComplete,exactComplete,referenceCalculable:true,reasons:provisionalReasons,
      precision:exactComplete ? 'declaration' : 'provisional-declaration',...finishNational(stage.nationalSales-credit),
      stage,credit,methodLabel,selection,basisRows,schedule53};
  }

  function calculateCurrentLawReturn(input, method = 'individual', options = {}){
    const reasons = [];
    if(input.unresolvedCount) reasons.push(`未処理のCSV明細${input.unresolvedCount}件`);
    if(input.temporaryExcludedCount && !options.allowTemporaryExcluded) reasons.push(`仮除外のCSV明細${input.temporaryExcludedCount}件`);
    if(input.unsupportedCodes?.length) reasons.push(`未対応課税区分${[...new Set(input.unsupportedCodes)].join('・')}`);
    if(reasons.length) return {complete:false,exactComplete:false,referenceCalculable:false,reasons};
    const provisionalReasons = [...new Set([...(options.provisionalReasons || []),
      ...(input.temporaryExcludedCount ? [`仮除外のCSV明細${input.temporaryExcludedCount}件。除外部分の税額影響は未算定`] : [])])];
    const exactComplete = provisionalReasons.length === 0;
    const schedule23 = buildSchedule23(input,method);
    const schedule13 = buildSchedule13(input,schedule23);
    const mainReturn = buildMainReturn(schedule13);
    return {complete:exactComplete,exactComplete,referenceCalculable:true,reasons:provisionalReasons,
      precision:exactComplete ? 'declaration' : 'provisional-declaration',schedule23,schedule13,mainReturn};
  }
  return Object.freeze({aggregateReturnInputs,aggregateReturnRows,buildSchedule23,buildSchedule13,buildMainReturn,
    calculateCurrentLawReturn,calculateCurrentLawSalesMethod});
});
