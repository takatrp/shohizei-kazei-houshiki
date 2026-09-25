(function(root, factory){
  const engine = typeof module === 'object' && module.exports
    ? require('./tax-engine.js')
    : root.ShohizeiTaxEngine;
  const api = factory(engine);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiTaxEntryRows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(engine){
  'use strict';

  const BUSINESS_TYPES = Object.freeze(['type1','type2','type3','type4','type5','type6']);
  const RATES = Object.freeze(['10','8']);
  const EXEMPT_RATIOS = Object.freeze(['80','70','50','30','0']);
  const CODE_DETAILS = Object.freeze({
    '1':Object.freeze({ side:'sales', label:'課税売上' }),
    '11':Object.freeze({ side:'sales', label:'売上返還等' }),
    '3':Object.freeze({ side:'sales', label:'非課税売上' }),
    '5':Object.freeze({ side:'purchases', label:'課税仕入れ（課税売上対応）', usage:'taxableOnly', exempt:false }),
    '6':Object.freeze({ side:'purchases', label:'課税仕入れ（非課税売上対応）', usage:'nonTaxableOnly', exempt:false }),
    '7':Object.freeze({ side:'purchases', label:'課税仕入れ（共通対応）', usage:'common', exempt:false }),
    '52':Object.freeze({ side:'purchases', label:'免税事業者等からの課税仕入れ（課税売上対応）', usage:'taxableOnly', exempt:true }),
    '62':Object.freeze({ side:'purchases', label:'免税事業者等からの課税仕入れ（非課税売上対応）', usage:'nonTaxableOnly', exempt:true }),
    '72':Object.freeze({ side:'purchases', label:'免税事業者等からの課税仕入れ（共通対応）', usage:'common', exempt:true })
  });
  const PURCHASE_USAGES = Object.freeze(['taxableOnly','nonTaxableOnly','common']);

  function emptyRateTotals(){ return { '10':0, '8':0 }; }
  function emptyRatePresence(){ return { '10':false, '8':false }; }
  function field(value = 0, entered = false){ return { value, entered, valid:true }; }
  function createTaxEntryRow(side, overrides = {}){
    if(side !== 'sales' && side !== 'purchases') throw new TypeError('side must be sales or purchases');
    return {
      id:'', code:'', businessType:'', rate:'', amount:'', foodAmount:'',
      creditRatio:'', source:'manual', ...overrides
    };
  }

  // One-shot input aid for the food 1% scenario. The row amount is already
  // gross, so do not convert its tax rate, apply a credit ratio, or reverse
  // TKC 11 here. The ordinary aggregation path owns the TKC 11 sign.
  function bulkFillFoodAmount(rows, side){
    if(!Array.isArray(rows)) throw new TypeError('rows must be an array');
    if(side !== 'sales' && side !== 'purchases') throw new TypeError('side must be sales or purchases');
    const skipped = [];
    let eligibleCount = 0;
    let changedCount = 0;
    let overwrittenCount = 0;
    const nextRows = rows.map((row, index) => {
      const code = String(row?.code ?? '').trim();
      const rate = String(row?.rate ?? '').trim();
      const amountText = String(row?.amount ?? '').trim();
      const foodText = String(row?.foodAmount ?? '').trim();
      const detail = CODE_DETAILS[code];
      let reason = '';
      if(!code && !rate && !amountText && !foodText) reason = 'emptyRow';
      else if(!code) reason = 'unconfirmedCode';
      else if(!detail || detail.side !== side || code === '3') reason = 'nonEligibleCode';
      else if(!RATES.includes(rate)) reason = 'unconfirmedRate';
      else if(rate !== '8') reason = 'nonReducedRate';
      else {
        const amount = engine.parseAmountInput(row.amount, {allowNegative:true});
        if(!amount.valid) reason = 'invalidAmount';
        else if(!amount.entered) reason = 'emptyAmount';
        else {
          eligibleCount += 1;
          const food = engine.parseAmountInput(row.foodAmount, {allowNegative:true});
          if(food.entered && food.valid && food.value === amount.value) return row;
          changedCount += 1;
          if(food.entered) overwrittenCount += 1;
          return {...row, foodAmount:amountText};
        }
      }
      skipped.push({index, reason});
      return row;
    });
    return {rows:nextRows, eligibleCount, changedCount, overwrittenCount, skipped};
  }

  // The rows are always entered as gross amounts. The caller may request the
  // legacy tax-exclusive field value when restoring an older amount-mode UI.
  function legacyAmount(gross, rate, amountMode){
    return amountMode === 'excluded'
      ? engine.taxableBaseFromAmount(gross, Number(rate), 'included')
      : gross;
  }

  function aggregateTaxRows(input = {}, options = {}){
    const amountMode = options.amountMode === 'excluded' ? 'excluded' : 'included';
    const sales = Array.isArray(input.sales) ? input.sales : [];
    const purchases = Array.isArray(input.purchases) ? input.purchases : [];
    const actualOnePercentEntries = Array.isArray(options.actualOnePercentEntries) ? options.actualOnePercentEntries : [];
    const errors = [];
    const warnings = [];
    const fields = {};
    const salesByType = Object.fromEntries(BUSINESS_TYPES.map(type => [type, emptyRateTotals()]));
    const salesPresence = Object.fromEntries(BUSINESS_TYPES.map(type => [type, emptyRatePresence()]));
    const salesFoodByType = Object.fromEntries(BUSINESS_TYPES.map(type => [type, 0]));
    const salesFoodPresence = Object.fromEntries(BUSINESS_TYPES.map(type => [type, false]));
    const unclassifiedSales = [];
    const unclassifiedSalesTotals = emptyRateTotals();
    let unclassifiedFoodTotal = 0;
    const invoiceByUse = Object.fromEntries(PURCHASE_USAGES.map(usage => [usage, emptyRateTotals()]));
    const invoicePresence = Object.fromEntries(PURCHASE_USAGES.map(usage => [usage, emptyRatePresence()]));
    const exemptByUse = Object.fromEntries(PURCHASE_USAGES.map(usage => [usage,
      Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, emptyRateTotals()]))]));
    const exemptPresence = Object.fromEntries(PURCHASE_USAGES.map(usage => [usage,
      Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, emptyRatePresence()]))]));
    const exemptFoodByRatio = Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, 0]));
    const exemptFoodPresence = Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, false]));
    let nonTaxableSales = 0;
    let nonTaxableSalesEntered = false;
    let invoiceFood = 0;
    let invoiceFoodEntered = false;
    let purchaseEntered = false;

    function addError(side, index, message){
      errors.push({ side, index, message });
    }
    function parseRowAmount(raw, side, index, label, required){
      const parsed = engine.parseAmountInput(raw, { allowNegative:true });
      if(!parsed.valid) addError(side, index, `${label}: ${parsed.error}`);
      else if(required && !parsed.entered) addError(side, index, `${label}を入力してください（該当なしは0円）。`);
      return parsed;
    }
    function processRows(rows, side){
      rows.forEach((row, index) => {
        if(!row || typeof row !== 'object') return;
        const code = String(row.code ?? '').trim();
        const rawAmount = String(row.amount ?? '').trim();
        const rawFood = String(row.foodAmount ?? '').trim();
        const untouched = !code && !rawAmount && !rawFood && !String(row.rate ?? '').trim()
          && !String(row.businessType ?? '').trim();
        if(untouched) return; // Empty trailing UI rows are not transactions.
        const detail = CODE_DETAILS[code];
        if(!detail || detail.side !== side){
          addError(side, index, '課税区分を確認してください。');
          return;
        }
        const amount = parseRowAmount(rawAmount, side, index, '税込金額', true);
        if(!amount.valid || !amount.entered) return;
        if(code === '3'){
          nonTaxableSales += amount.value;
          nonTaxableSalesEntered = true;
          if(rawFood) addError(side, index, '非課税売上に食品1％対象額は入力できません。');
          return;
        }
        const rate = String(row.rate ?? '').trim();
        if(!RATES.includes(rate)){
          addError(side, index, '税率は10％または軽減8％を選択してください。');
          return;
        }
        const food = engine.parseAmountInput(rawFood, { allowNegative:true });
        if(!food.valid) addError(side, index, `食品1％対象額: ${food.error}`);
        if(food.entered && rate !== '8') addError(side, index, '食品1％対象額は軽減8％の行に入力してください。');
        if(food.entered && food.valid && (Math.abs(food.value) > Math.abs(amount.value) + 1e-8
          || (food.value !== 0 && Math.sign(food.value) !== Math.sign(amount.value)))){
          addError(side, index, '食品1％対象額が行の税込金額を超えるか、符号が異なります。');
        }
        const legacyValue = (side === 'sales' && code === '11' ? -1 : 1) * legacyAmount(amount.value, rate, amountMode);
        const legacyFood = food.entered && food.valid
          ? (side === 'sales' && code === '11' ? -1 : 1) * legacyAmount(food.value, rate, amountMode) : 0;
        if(side === 'sales'){
          const type = String(row.businessType ?? '').trim();
          if(!BUSINESS_TYPES.includes(type)){
            unclassifiedSales.push({ index, code, rate, amount:code === '11' ? -amount.value : amount.value,
              foodAmount:food.entered && food.valid ? (code === '11' ? -food.value : food.value) : null,
              source:row.source || 'manual' });
            unclassifiedSalesTotals[rate] += legacyValue;
            if(rate === '8' && food.entered && food.valid) unclassifiedFoodTotal += legacyFood;
            warnings.push({ side, index, message:'事業区分が未確認です。課税売上は把握できますが、第1種〜第6種の欄へ推測して配分しません。' });
            return;
          }
          salesByType[type][rate] += legacyValue;
          salesPresence[type][rate] = true;
          if(rate === '8' && food.entered && food.valid){
            salesFoodByType[type] += legacyFood;
            salesFoodPresence[type] = true;
          }
          return;
        }
        purchaseEntered = true;
        if(detail.exempt){
          const ratio = String(row.creditRatio || row.bucket || '').trim().replace(/%$/, '');
          if(!EXEMPT_RATIOS.includes(ratio)){
            addError(side, index, '免税事業者等仕入の控除割合・期間区分を確認してください。');
            return;
          }
          exemptByUse[detail.usage][ratio][rate] += legacyValue;
          exemptPresence[detail.usage][ratio][rate] = true;
          if(rate === '8' && food.entered && food.valid){
            exemptFoodByRatio[ratio] += legacyFood;
            exemptFoodPresence[ratio] = true;
          }
          return;
        }
        invoiceByUse[detail.usage][rate] += legacyValue;
        invoicePresence[detail.usage][rate] = true;
        if(rate === '8' && food.entered && food.valid){
          invoiceFood += legacyFood;
          invoiceFoodEntered = true;
        }
      });
    }

    processRows(sales, 'sales');
    processRows(purchases, 'purchases');
    purchaseEntered ||= actualOnePercentEntries.some(entry => ['invoicePurchase','exemptPurchase'].includes(entry.kind));
    RATES.forEach(rate => {
      if(unclassifiedSalesTotals[rate] < 0) addError('sales', -1, `事業区分未確認・${rate}％売上の返品等差引後金額がマイナスです。`);
    });

    BUSINESS_TYPES.forEach(type => {
      RATES.forEach(rate => {
        fields[`${type}Sale${rate}`] = field(salesByType[type][rate], salesPresence[type][rate]);
        if(salesByType[type][rate] < 0) addError('sales', -1, `${type}・${rate}％の返品等差引後金額がマイナスです。`);
      });
      fields[`${type}SaleFood1`] = field(salesFoodByType[type], salesFoodPresence[type]);
      if(salesFoodByType[type] < 0) addError('sales', -1, `${type}の食品1％対象額がマイナスです。`);
    });
    fields.nonTaxableSales = field(nonTaxableSales, nonTaxableSalesEntered);
    if(nonTaxableSales < 0) addError('sales', -1, '非課税売上の返品等差引後金額がマイナスです。');

    const invoiceTotals = emptyRateTotals();
    const invoiceTotalPresence = emptyRatePresence();
    const exemptTotals = Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, emptyRateTotals()]));
    const exemptTotalPresence = Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, emptyRatePresence()]));
    const purchaseTaxByUse = {};
    PURCHASE_USAGES.forEach(usage => {
      let rawTax = 0;
      RATES.forEach(rate => {
        const amount = invoiceByUse[usage][rate];
        invoiceTotals[rate] += amount;
        invoiceTotalPresence[rate] ||= invoicePresence[usage][rate];
        rawTax += engine.taxFromAmount(amount, Number(rate), amountMode);
        if(amount < 0) addError('purchases', -1, `${usage}・${rate}％の返品等差引後金額がマイナスです。`);
      });
      EXEMPT_RATIOS.forEach(ratio => RATES.forEach(rate => {
        const amount = exemptByUse[usage][ratio][rate];
        exemptTotals[ratio][rate] += amount;
        exemptTotalPresence[ratio][rate] ||= exemptPresence[usage][ratio][rate];
        rawTax += engine.taxFromAmount(amount, Number(rate), amountMode) * Number(ratio) / 100;
        if(amount < 0) addError('purchases', -1, `${usage}・${ratio}％控除・${rate}％の返品等差引後金額がマイナスです。`);
      }));
      // CSV明示1％実績は既存の実績サイドカーが総額を計算する。
      // ここでは個別対応方式の用途別仕入税額にだけ同じ実績税額を加える。
      actualOnePercentEntries.forEach(entry => {
        if(entry.usage !== usage || !['invoicePurchase','exemptPurchase'].includes(entry.kind)) return;
        const gross = engine.parseAmountInput(entry.amount, {allowNegative:true});
        if(!gross.valid || !gross.entered || (entry.transactionKind === 'ordinary' && gross.value < 0)) return;
        const ratio = entry.kind === 'exemptPurchase'
          ? engine.normalizeExemptPurchaseRatio(entry.creditRatio) : 1;
        if(ratio === null) return;
        rawTax += engine.taxFromAmount(gross.value, 1, 'included') * ratio;
      });
      purchaseTaxByUse[usage] = Math.round(rawTax);
    });
    RATES.forEach(rate => {
      fields[`purchase${rate}`] = field(invoiceTotals[rate], invoiceTotalPresence[rate]);
      if(invoiceTotals[rate] < 0) addError('purchases', -1, `${rate}％課税仕入の返品等差引後金額がマイナスです。`);
    });
    fields.purchaseFood1 = field(invoiceFood, invoiceFoodEntered);
    EXEMPT_RATIOS.forEach(ratio => {
      RATES.forEach(rate => {
        fields[`exemptPurchase${ratio}_${rate}`] = field(exemptTotals[ratio][rate], exemptTotalPresence[ratio][rate]);
        if(exemptTotals[ratio][rate] < 0) addError('purchases', -1, `${ratio}％控除・${rate}％仕入の返品等差引後金額がマイナスです。`);
      });
      fields[`exemptPurchase${ratio}_1`] = field(exemptFoodByRatio[ratio], exemptFoodPresence[ratio]);
    });
    fields.taxableOnlyPurchaseTax = field(purchaseTaxByUse.taxableOnly, purchaseEntered);
    fields.commonPurchaseTax = field(purchaseTaxByUse.common, purchaseEntered);

    return {
      fields, salesByType, invoiceByUse, exemptByUse, purchaseTaxByUse,
      nonTaxableOnlyPurchaseTax:purchaseTaxByUse.nonTaxableOnly,
      unclassifiedSales, unclassifiedSalesTotals, unclassifiedFoodTotal,
      errors, warnings,
      ready:errors.length === 0 && unclassifiedSales.length === 0,
      amountMode
    };
  }

  // 元の税込行を変更せず、指定した税率シナリオ・対象期の控除割合から
  // 仕入税額の総額と3用途の内訳を同じ行計算で作る。表示用の円丸めは行わない。
  function aggregateScenarioPurchases(input = {}, options = {}){
    const purchases = Array.isArray(input.purchases) ? input.purchases : [];
    const actualEntries = Array.isArray(input.actualOnePercentEntries) ? input.actualOnePercentEntries : [];
    const taxScenario = options.taxScenario === 'foodProposal' ? 'foodProposal' : 'current';
    const fraction = options.foodForecastMethod === 'uniform' ? Number(options.proposalFraction) : 1;
    const override = options.exemptRatioOverride;
    const useOverride = override !== null && override !== undefined;
    const errors = aggregateTaxRows({purchases}).errors.map(error => error.message);
    const calculationErrors = [...errors];
    const addCalculationError = message => { errors.push(message); calculationErrors.push(message); };
    if(taxScenario === 'foodProposal' && (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)){
      addCalculationError('食品1％対象期間の割合を確認してください。');
    }
    if(useOverride && (!Number.isFinite(override) || override < 0 || override > 1)){
      addCalculationError('将来期の免税事業者等仕入の控除割合を確認してください。');
    }
    const purchaseTaxByUse = Object.fromEntries(PURCHASE_USAGES.map(usage => [usage, 0]));
    const invoiceByRate = {'10':0,'8':0,'1':0};
    const exemptByRate = {'10':0,'8':0,'1':0};
    let invoiceTotalAmount = 0;
    let invoiceTax = 0;
    let exemptTotalAmount = 0;
    let exemptTax = 0;
    let exemptCreditableTax = 0;
    let usageUnknown = false;
    const priceBasis = options.foodPurchasePriceBasis === 'grossFixed' ? 'grossFixed' : 'netFixed';
    const projectedFoodGross = gross => {
      if(!gross) return 0;
      const sign = Math.sign(gross);
      const absoluteGross = Math.abs(gross);
      return sign * engine.projectPrice({
        netAmount:absoluteGross / 1.08,
        grossAmount:absoluteGross,
        ratePercent:1,
        priceBasis
      }).grossAmount;
    };
    purchases.forEach(row => {
      const detail = CODE_DETAILS[String(row?.code ?? '').trim()];
      if(!detail || detail.side !== 'purchases') return;
      const amount = engine.parseAmountInput(row.amount, {allowNegative:true});
      const rate = String(row.rate ?? '').trim();
      if(!amount.valid || !amount.entered || !RATES.includes(rate)) return;
      const food = engine.parseAmountInput(row.foodAmount, {allowNegative:true});
      if(!food.valid) return;
      if(food.entered && (rate !== '8' || Math.abs(food.value) > Math.abs(amount.value) + 1e-8
        || (food.value !== 0 && Math.sign(food.value) !== Math.sign(amount.value)))) return;
      const foodOriginal = taxScenario === 'foodProposal' && rate === '8' && food.entered
        ? food.value * (Number.isFinite(fraction) ? fraction : 0) : 0;
      const originalRemainder = amount.value - foodOriginal;
      const foodGross = projectedFoodGross(foodOriginal);
      const taxOriginal = engine.taxFromAmount(originalRemainder, Number(rate), 'included');
      const taxFood = engine.taxFromAmount(foodGross, 1, 'included');
      const rowTax = taxOriginal + taxFood;
      const rowAmount = originalRemainder + foodGross;
      let ratio = 1;
      if(detail.exempt){
        const enteredRatio = String(row.creditRatio || row.bucket || '').trim().replace(/%$/, '');
        if(!EXEMPT_RATIOS.includes(enteredRatio)) return;
        ratio = useOverride ? override : Number(enteredRatio) / 100;
        exemptTotalAmount += rowAmount;
        exemptTax += rowTax;
        exemptCreditableTax += rowTax * ratio;
        exemptByRate[rate] += originalRemainder;
        exemptByRate['1'] += foodGross;
      }else{
        invoiceTotalAmount += rowAmount;
        invoiceTax += rowTax;
        invoiceByRate[rate] += originalRemainder;
        invoiceByRate['1'] += foodGross;
      }
      purchaseTaxByUse[detail.usage] += rowTax * ratio;
    });
    actualEntries.forEach((entry, index) => {
      if(!['invoicePurchase','exemptPurchase'].includes(entry?.kind)) return;
      if(taxScenario !== 'foodProposal'){
        addCalculationError(`CSV明示1％仕入${index + 1}件目は現行税率へ換算できません。`);
        return;
      }
      const parsedGross = engine.parseAmountInput(entry.amount, {allowNegative:true});
      if(!parsedGross.valid || !parsedGross.entered || (entry.transactionKind === 'ordinary' && parsedGross.value < 0)){
        addCalculationError(`CSV明示1％仕入${index + 1}件目の金額を確認してください。`);
        return;
      }
      const gross = parsedGross.value;
      const tax = engine.taxFromAmount(gross, 1, 'included');
      let ratio = 1;
      if(entry.kind === 'exemptPurchase'){
        ratio = engine.normalizeExemptPurchaseRatio(entry.creditRatio);
        if(ratio === null){
          addCalculationError(`CSV明示1％仕入${index + 1}件目の控除割合を確認してください。`);
          return;
        }
        if(useOverride) ratio = override;
        exemptTotalAmount += gross;
        exemptTax += tax;
        exemptCreditableTax += tax * ratio;
        exemptByRate['1'] += gross;
      }else{
        invoiceTotalAmount += gross;
        invoiceTax += tax;
        invoiceByRate['1'] += gross;
      }
      if(!PURCHASE_USAGES.includes(entry.usage)){
        usageUnknown = true;
        errors.push(`CSV明示1％仕入${index + 1}件目の用途区分を確認してください。`);
        return;
      }
      purchaseTaxByUse[entry.usage] += tax * ratio;
    });
    const totalCreditableTax = invoiceTax + exemptCreditableTax;
    const usageTotal = PURCHASE_USAGES.reduce((sum, usage) => sum + purchaseTaxByUse[usage], 0);
    const arithmeticTolerance = 1e-7 + Math.abs(totalCreditableTax) * Number.EPSILON * 16;
    if(!usageUnknown && Math.abs(usageTotal - totalCreditableTax) > arithmeticTolerance){
      errors.push('仕入税額の用途別合計と控除対象仕入税額総額が一致しません。');
    }
    return {
      invoiceTotalAmount, invoiceTax, exemptTotalAmount, exemptTax, exemptCreditableTax,
      totalAmount:invoiceTotalAmount + exemptTotalAmount,
      totalTax:invoiceTax + exemptTax,
      totalCreditableTax, purchaseTaxByUse, usageTotal,
      invoiceByRate, exemptByRate,
      usageUnknown, complete:errors.length === 0, errors, calculationErrors
    };
  }

  // Saved CSV summaries are display fields; entries remain the calculation
  // source. Rebuild summaries only when every entry can be read, so a corrupt
  // saved amount or ratio is never silently replaced with zero.
  function summarizeActualOnePercentEntries(entries){
    if(!Array.isArray(entries) || !entries.length) return null;
    const summary = {
      salesByType:Object.fromEntries(BUSINESS_TYPES.map(type => [type, 0])),
      invoicePurchase:0,
      exemptPurchases:Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, 0]))
    };
    for(const entry of entries){
      const amount = engine.parseAmountInput(entry?.amount, {allowNegative:true});
      if(!amount.valid || !amount.entered || (entry.transactionKind === 'ordinary' && amount.value < 0)) return null;
      if(entry.kind === 'sale'){
        if(!BUSINESS_TYPES.includes(entry.businessType)) return null;
        summary.salesByType[entry.businessType] += amount.value;
      }else if(entry.kind === 'invoicePurchase'){
        summary.invoicePurchase += amount.value;
      }else if(entry.kind === 'exemptPurchase'){
        const ratio = engine.normalizeExemptPurchaseRatio(entry.creditRatio);
        if(ratio === null) return null;
        const bucket = EXEMPT_RATIOS.find(value => Math.abs(Number(value) / 100 - ratio) < 1e-9);
        if(!bucket) return null;
        summary.exemptPurchases[bucket] += amount.value;
      }else return null;
    }
    return summary;
  }

  return Object.freeze({
    BUSINESS_TYPES, RATES, EXEMPT_RATIOS, CODE_DETAILS,
    createTaxEntryRow, bulkFillFoodAmount, aggregateTaxRows, aggregateScenarioPurchases,
    summarizeActualOnePercentEntries
  });
});
