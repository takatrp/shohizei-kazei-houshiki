(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiJournalCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const BUSINESS_TYPE_KEYS = Object.freeze(['type1','type2','type3','type4','type5','type6']);
  const SUPPORTED_RATES = Object.freeze(['10','8']);
  const EXEMPT_RATIOS = Object.freeze(['80','70','50','30','0']);

  const TAXABLE_SALES_CODES = new Set(['1','11']);
  const NON_TAXABLE_SALES_CODES = new Set(['3','31']);
  const INVOICE_PURCHASE_USAGE = Object.freeze({
    '5':'taxableOnly', '51':'taxableOnly',
    '6':'nonTaxableOnly', '61':'nonTaxableOnly',
    '7':'common', '71':'common'
  });
  const EXEMPT_PURCHASE_USAGE = Object.freeze({
    '52':'taxableOnly', '53':'taxableOnly',
    '62':'nonTaxableOnly', '63':'nonTaxableOnly',
    '72':'common', '73':'common'
  });
  const IGNORED_TAX_CODES = new Set(['', '0', '8']);
  const KNOWN_UNSUPPORTED_CODES = Object.freeze({
    '2':'輸出売上げ', '21':'輸出売上げの対価の返還',
    '25':'非課税品の輸出売上げ', '26':'同輸出売上げの対価の返還',
    '4':'有価証券等の譲渡', '12':'課税売上げの貸倒れ',
    '55':'輸入課税仕入れ（課税売上対応）', '65':'輸入課税仕入れ（非課税売上対応）',
    '75':'輸入課税仕入れ（共通対応）',
    '57':'特定課税仕入れ（課税売上対応）', '58':'同対価の返還',
    '67':'特定課税仕入れ（非課税売上対応）', '68':'同対価の返還',
    '77':'特定課税仕入れ（共通対応）', '78':'同対価の返還',
    '9':'課税区分未確定'
  });

  const REQUIRED_HEADERS = Object.freeze([
    '月日',
    ...['借方','貸方'].flatMap(side => [
      `${side}科目名`, `${side}課税区分`, `${side}事業区分`,
      `${side}軽減税率か否か`, `${side}税率`, `${side}取引金額`,
      `${side}消費税等`, `${side}控除割合`
    ])
  ]);

  function parseCsv(text){
    const source = String(text ?? '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for(let index = 0; index < source.length; index += 1){
      const char = source[index];
      if(quoted){
        if(char === '"'){
          if(source[index + 1] === '"'){
            cell += '"';
            index += 1;
          }else{
            quoted = false;
          }
        }else{
          cell += char;
        }
        continue;
      }
      if(char === '"'){
        quoted = true;
      }else if(char === ','){
        row.push(cell);
        cell = '';
      }else if(char === '\n' || char === '\r'){
        if(char === '\r' && source[index + 1] === '\n') index += 1;
        row.push(cell);
        if(row.some(value => value !== '') || row.length > 1) rows.push(row);
        row = [];
        cell = '';
      }else{
        cell += char;
      }
    }
    if(quoted) throw new Error('CSVの引用符が閉じていません。');
    row.push(cell);
    if(row.some(value => value !== '') || row.length > 1) rows.push(row);
    return rows;
  }

  function decodeCsvBytes(input){
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    if(hasUtf8Bom){
      return { text:new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding:'UTF-8 BOM' };
    }
    try{
      return { text:new TextDecoder('utf-8', { fatal:true }).decode(bytes), encoding:'UTF-8' };
    }catch(error){
      return { text:new TextDecoder('shift_jis', { fatal:true }).decode(bytes), encoding:'Shift_JIS' };
    }
  }

  function normalizeHeader(value){
    return String(value ?? '').replace(/^\uFEFF/, '').trim();
  }

  function normalizeCode(value){
    const text = String(value ?? '').trim().replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
    return /^\d+$/.test(text) ? String(Number(text)) : text;
  }

  function parseNumber(value){
    const normalized = String(value ?? '')
      .trim()
      .replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/[－−―]/g, '-')
      .replace(/[，,￥¥\s円]/g, '');
    if(normalized === '') return { entered:false, valid:true, value:0 };
    if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return { entered:true, valid:false, value:0 };
    const number = Number(normalized);
    return Number.isFinite(number)
      ? { entered:true, valid:true, value:number }
      : { entered:true, valid:false, value:0 };
  }

  function normalizeDate(value){
    const match = String(value ?? '').trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
    if(!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if(date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  function emptyRateAmounts(){
    return { '10':0, '8':0 };
  }

  function emptySalesByType(){
    return Object.fromEntries(BUSINESS_TYPE_KEYS.map(key => [key, emptyRateAmounts()]));
  }

  function emptyExemptPurchases(){
    return Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, emptyRateAmounts()]));
  }

  function emptyPurchaseAmountsByUse(){
    return Object.fromEntries(['taxableOnly','nonTaxableOnly','common'].map(usage => [usage, {
      invoice:emptyRateAmounts(),
      exempt:emptyExemptPurchases()
    }]));
  }

  function rateForEntry(entry, side){
    const rateState = parseNumber(entry[`${side}税率`]);
    const reduced = normalizeCode(entry[`${side}軽減税率か否か`]);
    if(rateState.entered && rateState.valid && (rateState.value === 10 || rateState.value === 8)){
      if((rateState.value === 8 && reduced === '0') || (rateState.value === 10 && reduced === '1')) return '';
      return String(rateState.value);
    }
    if(reduced === '1') return '8';
    if(reduced === '0') return '10';
    return '';
  }

  function businessTypeForEntry(entry, side){
    const value = normalizeCode(entry[`${side}事業区分`]);
    const match = value.match(/[1-6]/);
    return match ? `type${match[0]}` : '';
  }

  function amountDirection(kind, side){
    if(kind === 'sales') return side === '貸方' ? 1 : -1;
    return side === '借方' ? 1 : -1;
  }

  function calculatePurchaseTaxByUse(amountsByUse){
    return Object.fromEntries(Object.entries(amountsByUse).map(([usage, groups]) => {
      let tax = SUPPORTED_RATES.reduce((sum, rate) => (
        sum + groups.invoice[rate] * Number(rate) / (100 + Number(rate))
      ), 0);
      EXEMPT_RATIOS.forEach(ratio => {
        SUPPORTED_RATES.forEach(rate => {
          tax += groups.exempt[ratio][rate] * Number(rate) / (100 + Number(rate)) * Number(ratio) / 100;
        });
      });
      return [usage, tax];
    }));
  }

  function rowsToObjects(rows){
    if(rows.length < 2) throw new Error('CSVに見出し行と仕訳データが必要です。');
    const headers = rows[0].map(normalizeHeader);
    const missing = REQUIRED_HEADERS.filter(header => !headers.includes(header));
    if(missing.length) throw new Error(`TKC仕訳帳CSVの必須列が不足しています: ${missing.join('、')}`);
    const duplicateHeaders = headers.filter((header, index) => header && headers.indexOf(header) !== index);
    if(duplicateHeaders.length) throw new Error(`CSVに重複した見出しがあります: ${[...new Set(duplicateHeaders)].join('、')}`);
    return rows.slice(1)
      .filter(row => row.some(value => String(value ?? '').trim() !== ''))
      .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  }

  function addUnsupported(unsupported, code){
    const label = KNOWN_UNSUPPORTED_CODES[code] || '未対応の課税区分';
    const key = `${code}:${label}`;
    const current = unsupported.get(key) || { code, label, count:0 };
    current.count += 1;
    unsupported.set(key, current);
  }

  function addUnclassified(unclassified, entry, side, rate, amount){
    const accountName = String(entry[`${side}科目名`] ?? '').trim() || '科目名未設定';
    const current = unclassified.get(accountName) || {
      key:`account-${unclassified.size + 1}`,
      accountName,
      amounts:emptyRateAmounts()
    };
    current.amounts[rate] += amount;
    unclassified.set(accountName, current);
  }

  function analyzeTkcJournalText(text){
    const entries = rowsToObjects(parseCsv(text));
    const salesByType = emptySalesByType();
    const unclassified = new Map();
    const invoicePurchases = emptyRateAmounts();
    const exemptPurchases = emptyExemptPurchases();
    const purchaseAmountsByUse = emptyPurchaseAmountsByUse();
    const unsupported = new Map();
    const errors = [];
    let nonTaxableSales = 0;
    let mappedEntries = 0;
    let ignoredEntries = 0;
    let invalidEntries = 0;
    let start = '';
    let end = '';

    entries.forEach((entry, rowIndex) => {
      const date = normalizeDate(entry['月日']);
      if(date){
        if(!start || date < start) start = date;
        if(!end || date > end) end = date;
      }
      ['借方','貸方'].forEach(side => {
        const code = normalizeCode(entry[`${side}課税区分`]);
        if(IGNORED_TAX_CODES.has(code)){
          ignoredEntries += 1;
          return;
        }
        const amountState = parseNumber(entry[`${side}取引金額`]);
        if(!amountState.entered || !amountState.valid){
          invalidEntries += 1;
          errors.push(`${rowIndex + 2}行目 ${side}: 取引金額を読み取れません。`);
          return;
        }

        if(TAXABLE_SALES_CODES.has(code)){
          const rate = rateForEntry(entry, side);
          if(!SUPPORTED_RATES.includes(rate)){
            invalidEntries += 1;
            errors.push(`${rowIndex + 2}行目 ${side}: 課税売上の税率を10％または軽減8％として判定できません。`);
            return;
          }
          const signedAmount = amountState.value * amountDirection('sales', side);
          const businessType = businessTypeForEntry(entry, side);
          if(businessType) salesByType[businessType][rate] += signedAmount;
          else addUnclassified(unclassified, entry, side, rate, signedAmount);
          mappedEntries += 1;
          return;
        }

        if(NON_TAXABLE_SALES_CODES.has(code)){
          nonTaxableSales += amountState.value * amountDirection('sales', side);
          mappedEntries += 1;
          return;
        }

        const invoiceUsage = INVOICE_PURCHASE_USAGE[code];
        if(invoiceUsage){
          const rate = rateForEntry(entry, side);
          if(!SUPPORTED_RATES.includes(rate)){
            invalidEntries += 1;
            errors.push(`${rowIndex + 2}行目 ${side}: 課税仕入の税率を10％または軽減8％として判定できません。`);
            return;
          }
          const signedAmount = amountState.value * amountDirection('purchase', side);
          invoicePurchases[rate] += signedAmount;
          purchaseAmountsByUse[invoiceUsage].invoice[rate] += signedAmount;
          mappedEntries += 1;
          return;
        }

        const exemptUsage = EXEMPT_PURCHASE_USAGE[code];
        if(exemptUsage){
          const rate = rateForEntry(entry, side);
          const ratioState = parseNumber(entry[`${side}控除割合`]);
          const ratio = ratioState.entered && ratioState.valid ? String(ratioState.value) : '';
          if(!SUPPORTED_RATES.includes(rate) || !EXEMPT_RATIOS.includes(ratio)){
            invalidEntries += 1;
            errors.push(`${rowIndex + 2}行目 ${side}: 免税事業者等からの課税仕入の税率または控除割合を判定できません。`);
            return;
          }
          const signedAmount = amountState.value * amountDirection('purchase', side);
          exemptPurchases[ratio][rate] += signedAmount;
          purchaseAmountsByUse[exemptUsage].exempt[ratio][rate] += signedAmount;
          mappedEntries += 1;
          return;
        }

        addUnsupported(unsupported, code);
      });
    });

    const unclassifiedSales = [...unclassified.values()]
      .filter(group => group.amounts['10'] !== 0 || group.amounts['8'] !== 0)
      .sort((a, b) => a.accountName.localeCompare(b.accountName, 'ja'))
      .map((group, index) => ({ ...group, key:`account-${index + 1}` }));
    const unsupportedEntries = [...unsupported.values()].sort((a, b) => a.code.localeCompare(b.code, 'ja'));
    const negativeFields = [];
    BUSINESS_TYPE_KEYS.forEach(key => SUPPORTED_RATES.forEach(rate => {
      if(salesByType[key][rate] < 0) negativeFields.push(`${key} ${rate}％売上`);
    }));
    SUPPORTED_RATES.forEach(rate => {
      if(invoicePurchases[rate] < 0) negativeFields.push(`${rate}％課税仕入`);
    });
    EXEMPT_RATIOS.forEach(ratio => SUPPORTED_RATES.forEach(rate => {
      if(exemptPurchases[ratio][rate] < 0) negativeFields.push(`${ratio}％控除・${rate}％仕入`);
    }));
    if(nonTaxableSales < 0) negativeFields.push('非課税売上等');
    if(negativeFields.length){
      errors.push(`返品等の差引後金額がマイナスです: ${negativeFields.join('、')}`);
    }
    const purchaseTaxByUse = calculatePurchaseTaxByUse(purchaseAmountsByUse);

    return {
      rowCount:entries.length,
      dateRange:{ start, end },
      salesByType,
      unclassifiedSales,
      invoicePurchases,
      exemptPurchases,
      nonTaxableSales,
      purchaseTaxByUse,
      purchaseAmountsByUse,
      unsupportedEntries,
      errors,
      stats:{ mappedEntries, ignoredEntries, invalidEntries }
    };
  }

  function cloneSalesByType(source){
    return Object.fromEntries(BUSINESS_TYPE_KEYS.map(key => [key, {
      '10':Number(source[key]?.['10'] || 0),
      '8':Number(source[key]?.['8'] || 0)
    }]));
  }

  function resolveImportValues(analysis, mappings = {}){
    const salesByType = cloneSalesByType(analysis.salesByType || {});
    const unresolved = [];
    (analysis.unclassifiedSales || []).forEach(group => {
      const selected = mappings[group.key];
      if(!BUSINESS_TYPE_KEYS.includes(selected)){
        unresolved.push(group.accountName);
        return;
      }
      SUPPORTED_RATES.forEach(rate => { salesByType[selected][rate] += Number(group.amounts[rate] || 0); });
    });
    const errors = [...(analysis.errors || [])];
    if(unresolved.length) errors.push(`簡易課税の事業区分が未選択です: ${unresolved.join('、')}`);
    return {
      ready:errors.length === 0,
      errors,
      values:{
        salesByType,
        invoicePurchases:{
          '10':Number(analysis.invoicePurchases?.['10'] || 0),
          '8':Number(analysis.invoicePurchases?.['8'] || 0)
        },
        exemptPurchases:Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, {
          '10':Number(analysis.exemptPurchases?.[ratio]?.['10'] || 0),
          '8':Number(analysis.exemptPurchases?.[ratio]?.['8'] || 0)
        }])),
        nonTaxableSales:Number(analysis.nonTaxableSales || 0),
        taxableOnlyPurchaseTax:Math.round(Number(analysis.purchaseTaxByUse?.taxableOnly || 0)),
        commonPurchaseTax:Math.round(Number(analysis.purchaseTaxByUse?.common || 0)),
        nonTaxableOnlyPurchaseTax:Math.round(Number(analysis.purchaseTaxByUse?.nonTaxableOnly || 0)),
        dateRange:{ ...(analysis.dateRange || { start:'', end:'' }) }
      }
    };
  }

  return Object.freeze({
    BUSINESS_TYPE_KEYS,
    SUPPORTED_RATES,
    EXEMPT_RATIOS,
    REQUIRED_HEADERS,
    parseCsv,
    decodeCsvBytes,
    analyzeTkcJournalText,
    resolveImportValues
  });
});
