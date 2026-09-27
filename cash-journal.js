(function(root, factory){
  const api = factory(typeof module === 'object' && module.exports ? require('./journal-csv.js') : root.ShohizeiJournalCsv);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiCashJournal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(journal){
  'use strict';

  const REQUIRED = ['月日','借方科目名','借方取引金額','貸方科目名','貸方取引金額'];
  const OPENING = /前期繰越|開始残高|期首残高|繰越残高/;
  const TAX = /消費税|地方消費税/;
  const CASH = /^(?:(?:現金|小口現金)(?:$|[\s（(【\[0-9０-９]|[・／/])|(?:普通預金|当座預金|定期預金|通知預金|外貨預金|郵便貯金|通常貯金))/;

  function fileKey(text){
    let hash = 2166136261;
    for(const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0),16777619) >>> 0;
    return `${String(text).length}-${hash.toString(16)}`;
  }

  function dateValue(value){
    const match = String(value ?? '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if(!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year,month-1,day));
    if(date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${match[1]}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  function amountValue(value){
    const normalized = String(value ?? '').trim()
      .replace(/[０-９]/g,char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/[－−―]/g,'-').replace(/[，,￥¥\s円]/g,'');
    if(!normalized) return {entered:false,valid:false,value:null};
    if(!/^-?\d+$/.test(normalized)) return {entered:true,valid:false,value:null};
    const number = Number(normalized);
    return {entered:true,valid:Number.isSafeInteger(number),value:Number.isSafeInteger(number) ? number : null};
  }

  function normalizeSourceRows(text){
    const source = journal.parseCsv(text);
    if(source.length < 2) throw new Error('CSVに見出し行と仕訳データが必要です。');
    const headers = source[0].map(value => String(value ?? '').replace(/^\uFEFF/,'').trim());
    const missing = REQUIRED.filter(header => !headers.includes(header));
    if(missing.length) throw new Error(`資金集計に必要なCSV列が不足しています: ${missing.join('、')}`);
    const duplicates = headers.filter((header,index) => header && headers.indexOf(header) !== index);
    if(duplicates.length) throw new Error(`CSVに重複した見出しがあります: ${[...new Set(duplicates)].join('、')}`);
    return source.slice(1).filter(row => row.some(cell => String(cell ?? '').trim())).map((row,index) => {
      if(row.length !== headers.length) throw new Error('CSVレコードの列数が見出しと一致しません。');
      const entry = Object.fromEntries(headers.map((header,column) => [header,row[column] ?? '']));
      entry.recordNumber = row.recordNumber || index + 2;
      return entry;
    });
  }

  function analyzeCashJournalText(text){
    const key = fileKey(text);
    const rows = [];
    const accounts = new Set();
    const openingCandidates = [];
    const taxCandidates = [];
    let explicitOnePercentCount = 0;
    for(const source of normalizeSourceRows(text)){
      if(['借方税率','貸方税率'].some(header => /^\s*1\s*[%％]?\s*$/.test(String(source[header] ?? ''))))
        explicitOnePercentCount += 1;
      const debitAccount = String(source['借方科目名'] ?? '').trim();
      const creditAccount = String(source['貸方科目名'] ?? '').trim();
      const debitAmount = amountValue(source['借方取引金額']);
      const creditAmount = amountValue(source['貸方取引金額']);
      const date = dateValue(source['月日']);
      const memo = String(source['摘要'] || source['摘要欄'] || '').trim();
      if(debitAccount) accounts.add(debitAccount);
      if(creditAccount) accounts.add(creditAccount);
      const id = `${key}:${source.recordNumber}`;
      const row = {id,row:source.recordNumber,date,debitAccount,creditAccount,debitAmount,creditAmount};
      rows.push(row);
      const candidate = {id,row:source.recordNumber,month:date ? date.slice(0,7) : '',
        debitAmount:debitAmount.valid ? debitAmount.value : null,
        creditAmount:creditAmount.valid ? creditAmount.value : null};
      if(OPENING.test(`${debitAccount} ${creditAccount} ${memo}`)) openingCandidates.push({...candidate,label:`${candidate.month || '日付不明'} 開始残高等の候補`});
      else if(TAX.test(`${debitAccount} ${creditAccount} ${memo}`)) taxCandidates.push({...candidate,label:`${candidate.month || '日付不明'} 消費税納付・還付の候補`});
    }
    const accountNames = [...accounts].sort((a,b) => a.localeCompare(b,'ja'));
    return {fileKey:key, rowCount:rows.length, rows, accounts:accountNames,explicitOnePercentCount,
      suggestedAccounts:accountNames.filter(name => CASH.test(name)),openingCandidates,taxCandidates};
  }

  function toMonth(value){
    const date = dateValue(value);
    if(date) return date.slice(0,7);
    const match = String(value ?? '').match(/^(\d{4})-(\d{2})$/);
    if(!match || Number(match[2]) < 1 || Number(match[2]) > 12) return '';
    return value;
  }

  function monthSequence(start,end){
    const first = toMonth(start), last = toMonth(end);
    if(!first || !last || first > last) return [];
    const months = [];
    for(let year = Number(first.slice(0,4)), month = Number(first.slice(5));
      `${year}-${String(month).padStart(2,'0')}` <= last && months.length < 121;){
      months.push(`${year}-${String(month).padStart(2,'0')}`);
      month += 1;
      if(month === 13){month = 1; year += 1;}
    }
    return months;
  }

  function decision(decisions,id){
    if(decisions instanceof Set) return decisions.has(id) ? 'exclude' : '';
    if(Array.isArray(decisions)) return decisions.includes(id) ? 'exclude' : '';
    const value = decisions?.[id];
    return value === true || value === 'exclude' ? 'exclude' : value === false || value === 'keep' ? 'keep' : '';
  }
  function safeAdd(left,right){
    const value=left+right;
    return Number.isSafeInteger(value) ? value : null;
  }
  function safeSubtract(left,right){
    const value=left-right;
    return Number.isSafeInteger(value) ? value : null;
  }

  function buildMonthlyCashMovement(analysis, options = {}){
    const reasons = [];
    if(!analysis || !analysis.fileKey || !Array.isArray(analysis.rows)) throw new TypeError('資金CSVの解析結果が必要です。');
    const sourceChanged = Boolean(options.fileKey && options.fileKey !== analysis.fileKey);
    if(sourceChanged) reasons.push('別CSVの確認状態は引き継げません。資金科目と除外候補を再確認してください。');
    const selected = new Set(sourceChanged ? [] : (options.selectedAccounts || []).filter(name => analysis.accounts.includes(name)));
    if(!selected.size) reasons.push('資金科目が未確認です。');
    if(!sourceChanged && (options.selectedAccounts || []).some(name => !analysis.accounts.includes(name))) reasons.push('現在のCSVに存在しない資金科目が含まれます。');
    const sourceMonths = monthSequence(options.sourcePeriodStart,options.sourcePeriodEnd);
    const targetMonths = monthSequence(options.targetStart,options.targetEnd);
    if(!options.sourcePeriodConfirmed || !options.sourceCoverageConfirmed) reasons.push('元資料期間と全月網羅を確認してください。');
    if(!sourceMonths.length || !targetMonths.length || sourceMonths.length !== targetMonths.length)
      reasons.push('元資料期間と対象期の月数が一致しません。');
    const openingById = new Set(analysis.openingCandidates.map(item => item.id));
    const taxById = new Set(analysis.taxCandidates.map(item => item.id));
    const openingDecisions = sourceChanged ? {} : options.openingDecisions || {};
    const taxDecisions = sourceChanged ? {} : options.taxDecisions || {};
    const detail = sourceMonths.map((sourceMonth,index) => ({month:targetMonths[index] || '',sourceMonth,
      gross:0,excludedOpening:0,excludedTax:0,base:0,entryCount:0}));
    const byMonth = new Map(detail.map(item => [item.sourceMonth,item]));
    const warnings = [];
    const candidates = {opening:[],tax:[]};
    for(const row of analysis.rows){
      const debitSelected = selected.has(row.debitAccount);
      const creditSelected = selected.has(row.creditAccount);
      if(!debitSelected && !creditSelected) continue;
      if(!row.date){warnings.push(`${row.row}行目: 資金仕訳の日付を読み取れません。`);continue;}
      const target = byMonth.get(row.date.slice(0,7));
      if(!target){warnings.push(`${row.row}行目: 資金仕訳が確認した元資料期間の外にあります。`);continue;}
      if((debitSelected && !row.debitAmount.valid) || (creditSelected && !row.creditAmount.valid)){
        warnings.push(`${row.row}行目: 資金科目側の金額を読み取れません。`);continue;
      }
      const cashDelta = safeSubtract(debitSelected ? row.debitAmount.value : 0,creditSelected ? row.creditAmount.value : 0);
      if(cashDelta === null || safeAdd(target.gross,cashDelta) === null){
        warnings.push(`${row.row}行目: 資金増減の合計が安全な整数円の範囲を超えます。`);continue;
      }
      target.gross = safeAdd(target.gross,cashDelta);
      target.entryCount += 1;
      if(openingById.has(row.id)){
        candidates.opening.push({id:row.id,row:row.row,month:row.date.slice(0,7),amount:cashDelta,
          label:`${row.date.slice(0,7)} 開始残高等の候補`});
        const selectedDecision = decision(openingDecisions,row.id);
        if(!selectedDecision) warnings.push(`${row.row}行目: 開始残高等の除外を確認してください。`);
        if(selectedDecision === 'exclude'){
          const excluded=safeAdd(target.excludedOpening,cashDelta);
          if(excluded === null) warnings.push(`${row.row}行目: 開始残高等の除外合計が安全な整数円の範囲を超えます。`);
          else target.excludedOpening=excluded;
        }
      }else if(taxById.has(row.id)){
        const direction = cashDelta < 0 ? '納付候補' : cashDelta > 0 ? '還付候補' : '資金増減なし';
        candidates.tax.push({id:row.id,row:row.row,month:row.date.slice(0,7),amount:cashDelta,direction,
          label:`${row.date.slice(0,7)} ${direction}`});
        const selectedDecision = decision(taxDecisions,row.id);
        if(!selectedDecision) warnings.push(`${row.row}行目: 過去の消費税納付・還付の除外を確認してください。`);
        if(selectedDecision === 'exclude'){
          const excluded=safeAdd(target.excludedTax,cashDelta);
          if(excluded === null) warnings.push(`${row.row}行目: 消費税イベント除外合計が安全な整数円の範囲を超えます。`);
          else target.excludedTax=excluded;
        }
      }
    }
    detail.forEach(item => {
      const withoutOpening=safeSubtract(item.gross,item.excludedOpening);
      const base=withoutOpening === null ? null : safeSubtract(withoutOpening,item.excludedTax);
      if(base === null) warnings.push(`${item.sourceMonth}: 除外後の資金増減が安全な整数円の範囲を超えます。`);
      item.base=base;
    });
    if(warnings.length) reasons.push(...warnings);
    return {status:reasons.length ? 'unconfirmed' : 'complete',reasons,warnings,
      fileKey:analysis.fileKey,selectedAccounts:[...selected],sourcePeriod:{start:options.sourcePeriodStart || '',end:options.sourcePeriodEnd || ''},
      targetPeriod:{start:options.targetStart || '',end:options.targetEnd || ''},periodMapped:sourceMonths.length && targetMonths.length && sourceMonths[0] !== targetMonths[0],
      months:detail,candidates};
  }

  return Object.freeze({analyzeCashJournalText,buildMonthlyCashMovement});
});
