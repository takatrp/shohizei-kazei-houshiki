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
        const legacyValue = legacyAmount(amount.value, rate, amountMode);
        const legacyFood = food.entered && food.valid ? legacyAmount(food.value, rate, amountMode) : 0;
        if(side === 'sales'){
          const type = String(row.businessType ?? '').trim();
          if(!BUSINESS_TYPES.includes(type)){
            unclassifiedSales.push({ index, code, rate, amount:amount.value,
              foodAmount:food.entered && food.valid ? food.value : null,
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
        const gross = Number(entry.amount);
        if(!Number.isFinite(gross)) return;
        const ratio = entry.kind === 'exemptPurchase' ? Number(entry.creditRatio) : 1;
        if(!Number.isFinite(ratio)) return;
        rawTax += engine.taxFromAmount(gross, 1, 'included') * ratio;
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

  return Object.freeze({
    BUSINESS_TYPES, RATES, EXEMPT_RATIOS, CODE_DETAILS,
    createTaxEntryRow, aggregateTaxRows
  });
});
