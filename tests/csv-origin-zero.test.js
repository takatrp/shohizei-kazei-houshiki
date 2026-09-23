'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const journal = require('../journal-csv.js');
const engine = require('../tax-engine.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

function row({date='2028/01/15', side='貸方', code='1', business='2', rate='10', amount='0', account='合成売上'} = {}){
  const values = Object.fromEntries(journal.REQUIRED_HEADERS.map(header => [header,'']));
  values['月日'] = date;
  values[`${side}科目名`] = account;
  values[`${side}課税区分`] = code;
  values[`${side}事業区分`] = business;
  values[`${side}軽減税率か否か`] = rate === '10' ? '0' : '1';
  values[`${side}税率`] = rate;
  values[`${side}取引金額`] = String(amount);
  return values;
}

function csv(rows){
  return [journal.REQUIRED_HEADERS, ...rows.map(item => journal.REQUIRED_HEADERS.map(header => item[header]))]
    .map(items => items.map(value => `"${String(value).replace(/"/g,'""')}"`).join(','))
    .join('\r\n');
}

function harness(text){
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)) elements.set(id, {value:'', checked:false, open:false, textContent:'', focus(){}});
    return elements.get(id);
  };
  element('periodStart').value = '2028-01-01';
  element('periodEnd').value = '2028-12-31';
  const types = ['type1','type2','type3','type4','type5','type6'].map(key => ({key}));
  const context = vm.createContext({
    $:element,
    parseAmountInput:engine.parseAmountInput,
    resolveImportValues:journal.resolveImportValues,
    prepareEstimatedImport:journal.prepareEstimatedImport,
    BUSINESS_TYPES:types,
    CSV_EXEMPT_RATIOS:journal.EXEMPT_RATIOS,
    pendingJournalImport:{analysis:journal.analyzeTkcJournalText(text), sourceText:text, decisions:{}, applied:false},
    appliedJournalImport:null,
    importedCsvRecovery:null,
    importedExemptTransactionCount:0,
    importedUnsupportedEntries:[],
    importedActualOnePercent:null,
    journalImportMappings:{},
    visibleBusinessTypes:new Set(),
    workflowStep:1,
    window:{confirm(){ throw new Error('正常CSVに追加確認は不要'); }},
    yen:value => `${Math.round(value)}円`,
    sumRateAmounts:amounts => ['10','8','1'].reduce((sum,rate)=>sum+Number(amounts?.[rate] || 0),0),
    renderJournalImport(){}, update(){}
  });
  vm.runInContext(['formatInput','normalizeCsvRecovery','csvRecoverySummaryText','setImportedAmount','applyJournalImport'].map(source).join('\n'),context);
  return {context, element};
}

test('[F05画面] 通常の売上返品が相殺した0円は追加入力なしで0として反映する', () => {
  const h = harness(csv([
    row({amount:1100000}),
    row({date:'2028/02/15', side:'借方', code:'11', amount:1100000}),
    row({date:'2028/03/15', side:'借方', code:'5', business:'', amount:550000, account:'合成仕入'})
  ]));
  h.context.applyJournalImport();
  assert.equal(h.context.workflowStep,2);
  assert.equal(h.element('type2Sale10').value,'0');
  assert.equal(h.element('purchase10').value,'550,000');
  assert.equal(h.element('type2Sale8').value,'');
  assert.equal(h.element('periodStart').value,'2028-01-01');
  assert.equal(h.element('periodEnd').value,'2028-12-31');
});

test('[F05画面] 売上明細なし・未読・除外済みでは空欄を既知0円に変えない', () => {
  const purchaseOnly = harness(csv([row({side:'借方', code:'5', business:'', amount:550000, account:'合成仕入'})]));
  purchaseOnly.context.applyJournalImport();
  assert.equal(purchaseOnly.element('type2Sale10').value,'');

  const unreadSource = csv([row({amount:'不明'})]);
  const unread = harness(unreadSource);
  unread.context.window.confirm = () => true;
  unread.context.applyJournalImport();
  assert.equal(unread.element('type2Sale10').value,'');

  const excluded = harness(unreadSource);
  const problemId = excluded.context.pendingJournalImport.analysis.problemEntries[0].id;
  excluded.context.pendingJournalImport.decisions = {[problemId]:{action:'exclude'}};
  excluded.context.pendingJournalImport.analysis = journal.analyzeTkcJournalText(unreadSource,excluded.context.pendingJournalImport.decisions);
  excluded.context.applyJournalImport();
  assert.equal(excluded.element('type2Sale10').value,'');
});

test('[F05画面] 新しいCSVの反映で前回の既知0円を引き継がない', () => {
  const zero = csv([row({amount:1100}),row({side:'借方', code:'11', amount:1100})]);
  const next = csv([row({amount:2200, business:'3'})]);
  const h = harness(zero);
  h.context.applyJournalImport();
  assert.equal(h.element('type2Sale10').value,'0');
  h.context.pendingJournalImport = {analysis:journal.analyzeTkcJournalText(next), sourceText:next, decisions:{}, applied:false};
  h.context.applyJournalImport();
  assert.equal(h.element('type2Sale10').value,'');
  assert.equal(h.element('type3Sale10').value,'2,200');
});

test('[F04画面] 過去・一部期間外の通常税率CSVは対象期を変えず正常額を概算へ反映する', () => {
  const h = harness(csv([
    row({date:'2025/01/15', amount:1100000}),
    row({date:'2028/02/15', side:'借方', code:'5', business:'', amount:550000, account:'合成仕入'})
  ]));
  h.element('applyCsvDateRange').checked = false;
  h.context.applyJournalImport();
  assert.equal(h.context.workflowStep,2);
  assert.equal(h.element('periodStart').value,'2028-01-01');
  assert.equal(h.element('periodEnd').value,'2028-12-31');
  assert.equal(h.element('type2Sale10').value,'1,100,000');
  assert.equal(h.element('purchase10').value,'550,000');
  assert.equal(h.context.appliedJournalImport.applied,true);
});
