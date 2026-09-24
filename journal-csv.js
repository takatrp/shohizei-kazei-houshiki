(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiJournalCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const BUSINESS_TYPE_KEYS = Object.freeze(['type1','type2','type3','type4','type5','type6']);
  const SUPPORTED_RATES = Object.freeze(['10','8','1']);
  const EXEMPT_RATIOS = Object.freeze(['80','70','50','30','0']);

  const TAXABLE_SALES_CODES = new Set(['1','11']);
  const ADJUSTMENT_TAX_CODES = new Set(['11','51','61','71','53','63','73']);
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
    let closedQuote = false;
    let recordNumber = 1;
    const appendRow = () => {
      Object.defineProperty(row, 'recordNumber', {value:recordNumber});
      if(row.some(value => value !== '') || row.length > 1) rows.push(row);
      recordNumber += 1;
    };

    for(let index = 0; index < source.length; index += 1){
      const char = source[index];
      if(quoted){
        if(char === '"'){
          if(source[index + 1] === '"'){
            cell += '"';
            index += 1;
          }else{
            quoted = false;
            closedQuote = true;
          }
        }else{
          cell += char;
        }
        continue;
      }
      if(char === '"'){
        if(cell !== '' || closedQuote) throw new Error('CSVの引用符の位置が不正です。');
        quoted = true;
      }else if(char === ','){
        row.push(cell);
        cell = '';
        closedQuote = false;
      }else if(char === '\n' || char === '\r'){
        if(char === '\r' && source[index + 1] === '\n') index += 1;
        row.push(cell);
        appendRow();
        row = [];
        cell = '';
        closedQuote = false;
      }else{
        if(closedQuote) throw new Error('CSVの引用符の後に不正な文字があります。');
        cell += char;
      }
    }
    if(quoted) throw new Error('CSVの引用符が閉じていません。');
    row.push(cell);
    appendRow();
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
    return { '10':0, '8':0, '1':0 };
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
    if(rateState.entered && rateState.valid && (rateState.value === 10 || rateState.value === 8 || rateState.value === 1)){
      if((rateState.value === 8 && reduced === '0') || (rateState.value === 10 && reduced === '1')) return '';
      if(rateState.value === 1 && reduced === '0') return '';
      return String(rateState.value);
    }
    if(rateState.entered) return '';
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
      .map(row => {
        if(row.length !== headers.length) throw new Error('CSVレコードの列数が見出しと一致しません。明細の境界を確認してください。');
        const entry = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
        Object.defineProperty(entry, '__recordNumber', {value:row.recordNumber});
        return entry;
      });
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
      key:`account-${encodeURIComponent(accountName)}`,
      accountName,
      amounts:emptyRateAmounts(),
      entryCounts:emptyRateAmounts()
    };
    current.amounts[rate] += amount;
    current.entryCounts[rate] += 1;
    unclassified.set(accountName, current);
  }

  function entryCategory(code){
    if(TAXABLE_SALES_CODES.has(code)) return 'sales';
    if(NON_TAXABLE_SALES_CODES.has(code)) return 'nonTaxableSales';
    if(INVOICE_PURCHASE_USAGE[code]) return 'invoicePurchase';
    if(EXEMPT_PURCHASE_USAGE[code]) return 'exemptPurchase';
    return '';
  }

  function entryProblems(entry, side){
    const code = normalizeCode(entry[`${side}課税区分`]);
    if(IGNORED_TAX_CODES.has(code)) return [];
    const problems = [];
    const category = entryCategory(code);
    const amount = parseNumber(entry[`${side}取引金額`]);
    if(!amount.entered || !amount.valid) problems.push(['amount', '取引金額を読み取れません。']);
    if(!category) problems.push(['category', '課税区分を自動集計できません。']);
    if(category && category !== 'nonTaxableSales' && !rateForEntry(entry, side)) problems.push(['rate', '税率を10％・軽減8％・1％として判定できません。']);
    if(category === 'exemptPurchase'){
      const ratio = parseNumber(entry[`${side}控除割合`]);
      if(!ratio.entered || !ratio.valid || !EXEMPT_RATIOS.includes(String(ratio.value))) problems.push(['creditRatio', '免税事業者等仕入の控除割合を判定できません。']);
    }
    return problems;
  }

  function prepareRecovery(text, sourceEntries, decisions){
    // Content-bound identifiers prevent a record-number decision from applying to a different CSV.
    let hash = 2166136261;
    for(const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const fileKey = `${String(text).length}-${hash.toString(16)}`;
    const problemEntries = [];
    const recoverySummary = { correctedCount:0, temporaryExcludedCount:0, confirmedExcludedCount:0, excludedAbsAmount:0, unknownAmountCount:0, unresolvedCount:0,
      nettedExemptAdjustmentCount:0, nettedExemptAdjustmentAbsAmount:0,
      directionalTotals:{sales:0,nonTaxableSales:0,invoicePurchase:0,exemptPurchase:0}, taxImpactUncalculated:false };
    const entries = sourceEntries.map((source, index) => {
      const entry = {...source, __recordNumber:source.__recordNumber, __adjustmentSides:[]};
      for(const side of ['借方','貸方']){
        const originalProblems = entryProblems(source, side);
        if(!originalProblems.length) continue;
        const code = normalizeCode(source[`${side}課税区分`]);
        if(ADJUSTMENT_TAX_CODES.has(code) || ['21','26','58','68','78'].includes(code)) entry.__adjustmentSides.push(side);
        const category = entryCategory(code);
        const row = source.__recordNumber || index + 2;
        const id = `${fileKey}:${row}:${side}`;
        const decision = decisions[id] || {};
        const overrides = decision.overrides || {};
        const original = Object.freeze({taxCode:code, rate:source[`${side}税率`], reduced:source[`${side}軽減税率か否か`], amount:source[`${side}取引金額`], creditRatio:source[`${side}控除割合`], businessType:source[`${side}事業区分`], usage:INVOICE_PURCHASE_USAGE[code] || EXEMPT_PURCHASE_USAGE[code] || '', category, memo:source['摘要'] || source['摘要欄'] || ''});
        const problem = {id,row,side,date:source['月日'],accountName:source[`${side}科目名`],original,reasonCodes:originalProblems.map(item => item[0]),issues:originalProblems.map(item => item[1]),status:'unresolved',overrides:{...overrides}};
        if(decision.action === 'exclude' || (decision.action === 'confirmedExclude' && String(decision.reason || '').trim())){
          problem.status = decision.action === 'exclude' ? 'temporaryExcluded' : 'confirmedExcluded';
          recoverySummary[`${problem.status === 'temporaryExcluded' ? 'temporaryExcluded' : 'confirmedExcluded'}Count`] += 1;
          const amount = parseNumber(original.amount);
          if(amount.entered && amount.valid){
            recoverySummary.excludedAbsAmount += Math.abs(amount.value);
            if(category) recoverySummary.directionalTotals[category] += amount.value * amountDirection(category === 'sales' || category === 'nonTaxableSales' ? 'sales' : 'purchase', side);
          }else recoverySummary.unknownAmountCount += 1;
          recoverySummary.taxImpactUncalculated = true;
          entry[`${side}課税区分`] = '0';
        }else if(decision.action === 'correct'){
          // Known classifications keep invoice status, usage and adjustment code unchanged.
          if(!category && overrides.category){
            const usageCodes = overrides.category === 'invoicePurchase' ? {taxableOnly:'5',nonTaxableOnly:'6',common:'7'} : {taxableOnly:'52',nonTaxableOnly:'62',common:'72'};
            const correctedCode = overrides.category === 'sales' ? '1' : overrides.category === 'nonTaxableSales' ? '3' : ['invoicePurchase','exemptPurchase'].includes(overrides.category) ? usageCodes[overrides.usage] : '';
            if(correctedCode) entry[`${side}課税区分`] = correctedCode;
          }
          if(SUPPORTED_RATES.includes(String(overrides.rate))){
            entry[`${side}税率`] = String(overrides.rate);
            entry[`${side}軽減税率か否か`] = String(overrides.rate) === '10' ? '0' : '1';
          }
          if(problem.reasonCodes.includes('amount') && Object.hasOwn(overrides,'amount')) entry[`${side}取引金額`] = overrides.amount;
          if((!category || problem.reasonCodes.includes('creditRatio')) && Object.hasOwn(overrides,'creditRatio')) entry[`${side}控除割合`] = overrides.creditRatio;
          if(!category && BUSINESS_TYPE_KEYS.includes(overrides.businessType)) entry[`${side}事業区分`] = overrides.businessType.slice(4);
          // Unknown sales must not inherit an incidental business code from an unclassified record.
          if(!category && overrides.category === 'sales' && !BUSINESS_TYPE_KEYS.includes(overrides.businessType)) entry[`${side}事業区分`] = '';
          const remaining = entryProblems(entry,side);
          if(!remaining.length){ problem.status = 'corrected'; recoverySummary.correctedCount += 1; }
          else problem.issues = remaining.map(item => item[1]);
        }
        if(problem.status === 'unresolved'){
          recoverySummary.unresolvedCount += 1;
          // No incomplete correction enters the aggregate, including its apparently readable parts.
          entry[`${side}課税区分`] = '0';
        }
        problemEntries.push(problem);
      }
      return entry;
    });
    return {entries,problemEntries,recoverySummary,fileKey};
  }

  function analyzeTkcJournalText(text, decisions = {}){
    const recovery = prepareRecovery(text, rowsToObjects(parseCsv(text)), decisions);
    const {entries,problemEntries,recoverySummary} = recovery;
    const problemPositions = new Set(problemEntries.map(item => `${item.row}:${item.side}`));
    const salesByType = emptySalesByType();
    const salesEntryCountsByTypeRate = emptySalesByType();
    const unclassified = new Map();
    const invoicePurchases = emptyRateAmounts();
    const exemptPurchases = emptyExemptPurchases();
    const purchaseAmountsByUse = emptyPurchaseAmountsByUse();
    // Only aggregate date evidence is retained here; no account, memo, or
    // other transaction-level detail is needed by the row-entry UI.
    const exemptPurchaseProvenanceByUse = {taxableOnly:{},nonTaxableOnly:{},common:{}};
    const unsupported = new Map();
    const errors = problemEntries.filter(item => item.status === 'unresolved').map(item => `${item.row}行目 ${item.side}: ${item.issues.join(' ')}`);
    let nonTaxableSales = 0;
    let mappedEntries = 0;
    let ignoredEntries = 0;
    let invalidEntries = recoverySummary.unresolvedCount;
    let exemptTransactionCount = 0;
    const actualOnePercentEntries = [];
    let start = '';
    let end = '';
    let effectiveStart = '';
    let effectiveEnd = '';

    entries.forEach((entry, rowIndex) => {
      const date = normalizeDate(entry['月日']);
      if(date){
        if(!start || date < start) start = date;
        if(!end || date > end) end = date;
      }
      ['借方','貸方'].forEach(side => {
        const code = normalizeCode(entry[`${side}課税区分`]);
        const transactionKind = entry.__adjustmentSides.includes(side) || ADJUSTMENT_TAX_CODES.has(code)
          || (code === '1' ? side === '借方' : side === '貸方')
          ? 'adjustment' : 'ordinary';
        if(IGNORED_TAX_CODES.has(code)){
          if(!problemPositions.has(`${entry.__recordNumber || rowIndex + 2}:${side}`)) ignoredEntries += 1;
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
            errors.push(`${rowIndex + 2}行目 ${side}: 課税売上の税率を10％・軽減8％・1％のいずれかとして判定できません。`);
            return;
          }
          const signedAmount = amountState.value * amountDirection('sales', side);
          const businessType = businessTypeForEntry(entry, side);
          if(businessType){
            salesByType[businessType][rate] += signedAmount;
            salesEntryCountsByTypeRate[businessType][rate] += 1;
          }
          else addUnclassified(unclassified, entry, side, rate, signedAmount);
          if(date){
            if(!effectiveStart || date < effectiveStart) effectiveStart = date;
            if(!effectiveEnd || date > effectiveEnd) effectiveEnd = date;
          }
          if(rate === '1'){
            const accountName = String(entry[`${side}科目名`] ?? '').trim() || '科目名未設定';
            actualOnePercentEntries.push({ row:entry.__recordNumber || rowIndex + 2, date, kind:'sale', businessType, mappingKey:`account-${encodeURIComponent(accountName)}`, amount:signedAmount, ratePercent:1, amountMode:'included', source:'csvActual', category:'foodUnconfirmed', taxCode:code, side, transactionKind });
          }
          mappedEntries += 1;
          return;
        }

        if(NON_TAXABLE_SALES_CODES.has(code)){
          nonTaxableSales += amountState.value * amountDirection('sales', side);
          if(date){
            if(!effectiveStart || date < effectiveStart) effectiveStart = date;
            if(!effectiveEnd || date > effectiveEnd) effectiveEnd = date;
          }
          mappedEntries += 1;
          return;
        }

        const invoiceUsage = INVOICE_PURCHASE_USAGE[code];
        if(invoiceUsage){
          const rate = rateForEntry(entry, side);
          if(!SUPPORTED_RATES.includes(rate)){
            invalidEntries += 1;
            errors.push(`${rowIndex + 2}行目 ${side}: 課税仕入の税率を10％・軽減8％・1％のいずれかとして判定できません。`);
            return;
          }
          const signedAmount = amountState.value * amountDirection('purchase', side);
          invoicePurchases[rate] += signedAmount;
          purchaseAmountsByUse[invoiceUsage].invoice[rate] += signedAmount;
          if(date){
            if(!effectiveStart || date < effectiveStart) effectiveStart = date;
            if(!effectiveEnd || date > effectiveEnd) effectiveEnd = date;
          }
          if(rate === '1') actualOnePercentEntries.push({ row:entry.__recordNumber || rowIndex + 2, date, kind:'invoicePurchase', usage:invoiceUsage, amount:signedAmount, ratePercent:1, amountMode:'included', source:'csvActual', category:'foodUnconfirmed', taxCode:code, side, transactionKind });
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
          if(transactionKind === 'adjustment'){
            recoverySummary.nettedExemptAdjustmentCount += 1;
            recoverySummary.nettedExemptAdjustmentAbsAmount += Math.abs(signedAmount);
          }
          const byRatio = exemptPurchaseProvenanceByUse[exemptUsage][ratio] ||= {};
          const provenance = byRatio[rate] ||= {
            sourceDateStart:'', sourceDateEnd:'', sourceAdjustmentCount:0, sourceDateUnknownCount:0
          };
          if(transactionKind === 'adjustment') provenance.sourceAdjustmentCount += 1;
          if(!date && transactionKind === 'ordinary') provenance.sourceDateUnknownCount += 1;
          // Returns/corrections identify their original transaction separately;
          // their own date must not establish a credit-ratio period.
          if(transactionKind === 'ordinary' && date){
            if(!provenance.sourceDateStart || date < provenance.sourceDateStart) provenance.sourceDateStart = date;
            if(!provenance.sourceDateEnd || date > provenance.sourceDateEnd) provenance.sourceDateEnd = date;
          }
          exemptTransactionCount += 1;
          if(date){
            if(!effectiveStart || date < effectiveStart) effectiveStart = date;
            if(!effectiveEnd || date > effectiveEnd) effectiveEnd = date;
          }
          if(rate === '1') actualOnePercentEntries.push({ row:entry.__recordNumber || rowIndex + 2, date, kind:'exemptPurchase', usage:exemptUsage, creditRatio:Number(ratio) / 100, amount:signedAmount, ratePercent:1, amountMode:'included', source:'csvActual', category:'foodUnconfirmed', taxCode:code, side, transactionKind });
          mappedEntries += 1;
          return;
        }

        addUnsupported(unsupported, code);
      });
    });

    const unclassifiedSales = [...unclassified.values()]
      .filter(group => SUPPORTED_RATES.some(rate => group.entryCounts[rate] > 0))
      .sort((a, b) => a.accountName.localeCompare(b.accountName, 'ja'));
    problemEntries.filter(item => item.reasonCodes.includes('category') && item.status === 'unresolved').forEach(item => addUnsupported(unsupported,item.original.taxCode));
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
    unclassifiedSales.forEach(group => SUPPORTED_RATES.forEach(rate => {
      if(group.amounts[rate] < 0) negativeFields.push(`${group.accountName} ${rate}％未分類売上`);
    }));
    Object.entries(purchaseAmountsByUse).forEach(([usage, groups]) => {
      const label = {taxableOnly:'課税売上対応',nonTaxableOnly:'非課税売上対応',common:'共通対応'}[usage];
      SUPPORTED_RATES.forEach(rate => {
        if(groups.invoice[rate] < 0) negativeFields.push(`${label}・${rate}％課税仕入`);
        EXEMPT_RATIOS.forEach(ratio => {
          if(groups.exempt[ratio][rate] < 0) negativeFields.push(`${label}・${ratio}％控除・${rate}％仕入`);
        });
      });
    });
    if(nonTaxableSales < 0) negativeFields.push('非課税売上等');
    const negativeAggregateError = negativeFields.length ? `返品等の差引後金額がマイナスです: ${negativeFields.join('、')}` : '';
    if(negativeAggregateError) errors.push(negativeAggregateError);
    const purchaseTaxByUse = calculatePurchaseTaxByUse(purchaseAmountsByUse);

    return {
      rowCount:entries.length,
      dateRange:{ start, end },
      effectiveDateRange:{ start:effectiveStart, end:effectiveEnd },
      salesByType,
      salesEntryCountsByTypeRate,
      unclassifiedSales,
      invoicePurchases,
      exemptPurchases,
      exemptTransactionCount,
      actualOnePercentEntries,
      nonTaxableSales,
      purchaseTaxByUse,
      purchaseAmountsByUse,
      exemptPurchaseProvenanceByUse,
      unsupportedEntries,
      problemEntries,
      recoverySummary,
      fileKey:recovery.fileKey,
      negativeAggregateError,
      errors,
      stats:{ mappedEntries, ignoredEntries, invalidEntries }
    };
  }

  function cloneSalesByType(source){
    return Object.fromEntries(BUSINESS_TYPE_KEYS.map(key => [key, {
      '10':Number(source[key]?.['10'] || 0),
      '8':Number(source[key]?.['8'] || 0),
      '1':Number(source[key]?.['1'] || 0)
    }]));
  }

  function resolveImportValues(analysis, mappings = {}, {allowUnclassifiedSales = false} = {}){
    const salesByType = cloneSalesByType(analysis.salesByType || {});
    const salesEntryCountsByTypeRate = cloneSalesByType(analysis.salesEntryCountsByTypeRate || {});
    const unresolved = [];
    const unclassifiedSales = [];
    (analysis.unclassifiedSales || []).forEach(group => {
      const selected = mappings[group.key];
      if(!BUSINESS_TYPE_KEYS.includes(selected)){
        if(allowUnclassifiedSales) unclassifiedSales.push(group);
        else unresolved.push(group.accountName);
        return;
      }
      SUPPORTED_RATES.forEach(rate => {
        salesByType[selected][rate] += Number(group.amounts[rate] || 0);
        salesEntryCountsByTypeRate[selected][rate] += Number(group.entryCounts?.[rate] || 0);
      });
    });
    const errors = [...(analysis.errors || [])];
    if(unresolved.length) errors.push(`簡易課税の事業区分が未選択です: ${unresolved.join('、')}`);
    return {
      ready:errors.length === 0,
      errors,
      unclassifiedSales,
      actualOnePercentEntries:(analysis.actualOnePercentEntries || []).map(item => {
        const {mappingKey, ...resolvedEntry} = item;
        if(item.kind === 'sale' && !item.businessType && BUSINESS_TYPE_KEYS.includes(mappings[mappingKey])) resolvedEntry.businessType = mappings[mappingKey];
        return resolvedEntry;
      }),
      values:{
        salesByType,
        salesEntryCountsByTypeRate,
        invoicePurchases:{
          '10':Number(analysis.invoicePurchases?.['10'] || 0),
          '8':Number(analysis.invoicePurchases?.['8'] || 0),
          '1':Number(analysis.invoicePurchases?.['1'] || 0)
        },
        exemptPurchases:Object.fromEntries(EXEMPT_RATIOS.map(ratio => [ratio, {
          '10':Number(analysis.exemptPurchases?.[ratio]?.['10'] || 0),
          '8':Number(analysis.exemptPurchases?.[ratio]?.['8'] || 0),
          '1':Number(analysis.exemptPurchases?.[ratio]?.['1'] || 0)
        }])),
        nonTaxableSales:Number(analysis.nonTaxableSales || 0),
        taxableOnlyPurchaseTax:Math.round(Number(analysis.purchaseTaxByUse?.taxableOnly || 0)),
        commonPurchaseTax:Math.round(Number(analysis.purchaseTaxByUse?.common || 0)),
        nonTaxableOnlyPurchaseTax:Math.round(Number(analysis.purchaseTaxByUse?.nonTaxableOnly || 0)),
        dateRange:{ ...(analysis.dateRange || { start:'', end:'' }) },
        effectiveDateRange:{ ...(analysis.effectiveDateRange || { start:'', end:'' }) }
      }
    };
  }

  function prepareEstimatedImport(text, decisions = {}, mappings = {}, {allowUnclassifiedSales = false} = {}){
    // This opt-in preparation is an estimate of input data, not another tax engine.
    // Every invocation starts from the CSV and the user's explicit choices so that
    // cancelling or switching back to strict import never confirms an assumption.
    const original = analyzeTkcJournalText(text, decisions);
    const estimateDecisions = Object.fromEntries(Object.entries(decisions).map(([id, decision]) => [id, {...decision, overrides:{...(decision.overrides || {})}}]));
    const assumptions = {
      assumedRate10Count:0, assumedRate10Amount:0,
      assumedRate8Count:0, assumedRate8Amount:0,
      assumedRate1Count:0, assumedRate1Amount:0,
      assumedCreditCount:0, assumedCreditAmount:0,
      assumedBusinessCount:0, assumedBusinessAmount:0,
      assumedDetailCount:0, negativeBucketCount:0, negativeAbsAmount:0, negativeBuckets:[]
    };
    const assumedIds = new Set();
    original.problemEntries.filter(problem => problem.status === 'unresolved').forEach(problem => {
      const explicit = estimateDecisions[problem.id] || {};
      // Cancelled edits may still be retained by the UI for convenience, but
      // they are not active input and must never be resurrected by estimation.
      const overrides = explicit.action === 'correct' ? {...(explicit.overrides || {})} : {};
      const source = problem.original;
      const category = source.category || (explicit.action === 'correct' ? overrides.category : '');
      const knownCategory = ['sales','nonTaxableSales','invoicePurchase','exemptPurchase'].includes(category);
      const usageKnown = source.category || !['invoicePurchase','exemptPurchase'].includes(category) || ['taxableOnly','nonTaxableOnly','common'].includes(overrides.usage);
      const amount = parseNumber(explicit.action === 'correct' && problem.reasonCodes.includes('amount') && Object.hasOwn(overrides,'amount') ? overrides.amount : source.amount);
      if(!knownCategory || !usageKnown || !amount.entered || !amount.valid){
        // Never guess the transaction category or amount. Only this debit/credit
        // detail is excluded; its readable opposite side remains in the aggregate.
        estimateDecisions[problem.id] = {...explicit, action:'exclude'};
        return;
      }
      // Reconstruct the effective rate after manual choices, including the flag
      // update performed by prepareRecovery for an explicit supported rate.
      const chosenRate = explicit.action === 'correct' && SUPPORTED_RATES.includes(String(overrides.rate));
      const rateEntry = {
        [`${problem.side}税率`]:chosenRate ? String(overrides.rate) : source.rate,
        [`${problem.side}軽減税率か否か`]:chosenRate ? (String(overrides.rate) === '10' ? '0' : '1') : source.reduced
      };
      let assumed = false;
      if(category !== 'nonTaxableSales' && !rateForEntry(rateEntry, problem.side)){
        const explicitOriginalRate = parseNumber(source.rate);
        // Only a source that explicitly says 1% can enter this special-rate path.
        const rate = explicitOriginalRate.valid && explicitOriginalRate.entered && explicitOriginalRate.value === 1
          ? '1' : normalizeCode(source.reduced) === '1' ? '8' : '10';
        overrides.rate = rate;
        assumptions[`assumedRate${rate}Count`] += 1;
        assumptions[`assumedRate${rate}Amount`] += Math.abs(amount.value);
        assumed = true;
      }
      if(category === 'exemptPurchase'){
        const mayOverrideRatio = !source.category || problem.reasonCodes.includes('creditRatio');
        const ratio = parseNumber(explicit.action === 'correct' && mayOverrideRatio && Object.hasOwn(overrides,'creditRatio') ? overrides.creditRatio : source.creditRatio);
        if(!ratio.entered || !ratio.valid || !EXEMPT_RATIOS.includes(String(ratio.value))){
          overrides.creditRatio = '0';
          assumptions.assumedCreditCount += 1;
          assumptions.assumedCreditAmount += Math.abs(amount.value);
          assumed = true;
        }
      }
      estimateDecisions[problem.id] = {...explicit, action:'correct', overrides};
      if(assumed) assumedIds.add(problem.id);
    });
    const analysis = analyzeTkcJournalText(text, estimateDecisions);
    const estimateMappings = {...mappings};
    analysis.unclassifiedSales.forEach(group => {
      if(allowUnclassifiedSales) return;
      if(BUSINESS_TYPE_KEYS.includes(estimateMappings[group.key])) return;
      // Type 6's 40% deemed deduction is a conservative estimate, not a legal
      // business classification. The caller must label it as unconfirmed.
      estimateMappings[group.key] = 'type6';
      assumptions.assumedBusinessCount += 1;
      assumptions.assumedBusinessAmount += SUPPORTED_RATES.reduce((sum, rate) => sum + Math.abs(group.amounts[rate]), 0);
    });
    const floorEstimate = (amounts, rate, kind) => {
      if(rate === '1' || !(amounts[rate] < 0)) return;
      const amount = amounts[rate];
      assumptions.negativeBuckets.push({kind, rate, amount});
      assumptions.negativeBucketCount += 1;
      assumptions.negativeAbsAmount += Math.abs(amount);
      amounts[rate] = 0;
    };
    BUSINESS_TYPE_KEYS.forEach(key => SUPPORTED_RATES.forEach(rate => floorEstimate(analysis.salesByType[key], rate, 'sales')));
    analysis.unclassifiedSales.forEach(group => SUPPORTED_RATES.forEach(rate => floorEstimate(group.amounts, rate, 'sales')));
    Object.values(analysis.purchaseAmountsByUse).forEach(groups => {
      SUPPORTED_RATES.forEach(rate => floorEstimate(groups.invoice, rate, 'invoicePurchase'));
      EXEMPT_RATIOS.forEach(ratio => SUPPORTED_RATES.forEach(rate => floorEstimate(groups.exempt[ratio], rate, 'exemptPurchase')));
    });
    if(analysis.nonTaxableSales < 0){
      // The non-taxable aggregate has no tax rate to assume or display.
      assumptions.negativeBuckets.push({kind:'nonTaxableSales', rate:'', amount:analysis.nonTaxableSales});
      assumptions.negativeBucketCount += 1;
      assumptions.negativeAbsAmount += Math.abs(analysis.nonTaxableSales);
      analysis.nonTaxableSales = 0;
    }
    if(assumptions.negativeBucketCount){
      // Rebuild totals from usage leaves, never floor both totals and leaves.
      analysis.invoicePurchases = emptyRateAmounts();
      analysis.exemptPurchases = emptyExemptPurchases();
      Object.values(analysis.purchaseAmountsByUse).forEach(groups => {
        SUPPORTED_RATES.forEach(rate => { analysis.invoicePurchases[rate] += groups.invoice[rate]; });
        EXEMPT_RATIOS.forEach(ratio => SUPPORTED_RATES.forEach(rate => { analysis.exemptPurchases[ratio][rate] += groups.exempt[ratio][rate]; }));
      });
      analysis.purchaseTaxByUse = calculatePurchaseTaxByUse(analysis.purchaseAmountsByUse);
    }
    const negativeOnePercent = BUSINESS_TYPE_KEYS.some(key => analysis.salesByType[key]['1'] < 0)
      || analysis.unclassifiedSales.some(group => group.amounts['1'] < 0)
      || Object.values(analysis.purchaseAmountsByUse).some(groups => groups.invoice['1'] < 0 || EXEMPT_RATIOS.some(ratio => groups.exempt[ratio]['1'] < 0));
    if(analysis.negativeAggregateError && !negativeOnePercent){
      // Only the explicitly handled aggregate guard can be removed. Individual
      // errors, unsupported categories and fatal CSV structure are never hidden.
      analysis.errors = analysis.errors.filter(error => error !== analysis.negativeAggregateError);
      analysis.negativeAggregateError = '';
    }
    if(negativeOnePercent) analysis.errors.push('明示1％取引の差引後金額がマイナスです。1％実績・返品の扱いは自動補完せず、元明細を確認して補正してください。');
    assumptions.assumedDetailCount = analysis.problemEntries.filter(problem => problem.status === 'corrected' && assumedIds.has(problem.id)).length;
    const recoverySummary = {...analysis.recoverySummary, ...assumptions, correctedCount:analysis.recoverySummary.correctedCount - assumptions.assumedDetailCount};
    analysis.recoverySummary = recoverySummary;
    return {analysis, resolved:resolveImportValues(analysis, estimateMappings, {allowUnclassifiedSales}), recoverySummary};
  }

  return Object.freeze({
    BUSINESS_TYPE_KEYS,
    SUPPORTED_RATES,
    EXEMPT_RATIOS,
    REQUIRED_HEADERS,
    parseCsv,
    decodeCsvBytes,
    analyzeTkcJournalText,
    resolveImportValues,
    prepareEstimatedImport
  });
});
