'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {REQUIRED_HEADERS,analyzeTkcJournalText} = require('../journal-csv.js');
const {analyzeCashJournalText,buildMonthlyCashMovement} = require('../cash-journal.js');

const HEADERS = [...REQUIRED_HEADERS,'摘要'];
function csvCell(value){
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g,'""')}"` : text;
}
function fixture(entries){
  return [HEADERS,...entries.map(entry => HEADERS.map(header => entry[header] ?? ''))]
    .map(row => row.map(csvCell).join(',')).join('\r\n');
}
function entry({date='2025/01/15',debit='',credit='',amount=0,debitAmount=amount,creditAmount=amount,memo='',debitCode='',creditCode=''}){
  return {月日:date,借方科目名:debit,貸方科目名:credit,借方取引金額:debitAmount,
    貸方取引金額:creditAmount,借方課税区分:debitCode,貸方課税区分:creditCode,摘要:memo};
}
function calculate(entries,override={}){
  const analysis = analyzeCashJournalText(fixture(entries));
  const result = buildMonthlyCashMovement(analysis,{fileKey:analysis.fileKey,
    selectedAccounts:['普通預金','現金'].filter(name => analysis.accounts.includes(name)),sourcePeriodStart:'2025-01-01',sourcePeriodEnd:'2025-12-31',
    sourcePeriodConfirmed:true,sourceCoverageConfirmed:true,
    targetStart:'2025-01-01',targetEnd:'2025-12-31',...override});
  return {analysis,result};
}

test('MCF01 普通預金への入金は借方の資金増加として100万円',() => {
  const {result} = calculate([entry({debit:'普通預金',credit:'売上',amount:1000000})]);
  assert.equal(result.status,'complete');
  assert.equal(result.months[0].base,1000000);
});

test('MCF02 普通預金からの支払は貸方の資金減少として60万円',() => {
  const {result} = calculate([entry({debit:'仕入',credit:'普通預金',amount:600000})]);
  assert.equal(result.months[0].base,-600000);
});

test('MCF03 資金科目間振替は同一行の借方と貸方が相殺して0円',() => {
  const {result} = calculate([entry({debit:'普通預金',credit:'現金',amount:1000000})]);
  assert.equal(result.months[0].gross,0);
  assert.equal(result.months[0].base,0);
});

test('MCF04 開始残高は自動削除せず候補提示し、確認後に除外',() => {
  const entries = [entry({debit:'普通預金',credit:'開始残高',amount:10000000})];
  const initial = calculate(entries);
  assert.equal(initial.analysis.openingCandidates.length,1);
  assert.equal(initial.result.status,'unconfirmed');
  assert.equal(initial.result.months[0].gross,10000000);
  const id = initial.analysis.openingCandidates[0].id;
  const confirmed = calculate(entries,{openingDecisions:{[id]:'exclude'}}).result;
  assert.equal(confirmed.status,'complete');
  assert.equal(confirmed.months[0].excludedOpening,10000000);
  assert.equal(confirmed.months[0].base,0);
});

test('MCF05 元CSVの消費税納付120万円を除き、A/B案の税金を二重計上しないベース',() => {
  const entries = [entry({debit:'未払消費税等',credit:'普通預金',amount:1200000,memo:'消費税中間納付'})];
  const initial = calculate(entries);
  assert.equal(initial.result.months[0].gross,-1200000);
  assert.equal(initial.result.status,'unconfirmed');
  const id = initial.analysis.taxCandidates[0].id;
  const result = calculate(entries,{taxDecisions:{[id]:'exclude'}}).result;
  assert.equal(result.months[0].excludedTax,-1200000);
  assert.equal(result.months[0].base,0);
  assert.equal(result.months[0].base - 1200000,-1200000);
});

test('MCF06 元CSVの消費税還付はプラスの実績から除いて案別還付に置換',() => {
  const entries = [entry({debit:'普通預金',credit:'未収消費税等',amount:300000})];
  const initial = calculate(entries);
  const id = initial.analysis.taxCandidates[0].id;
  const result = calculate(entries,{taxDecisions:{[id]:'exclude'}}).result;
  assert.equal(result.months[0].gross,300000);
  assert.equal(result.months[0].excludedTax,300000);
  assert.equal(result.months[0].base,0);
  assert.equal(result.months[0].base + 300000,300000);
});

test('MCF07 過年度12か月は確認済み期間の月順で対象期へ対応',() => {
  const {result} = calculate([
    entry({date:'2025/01/15',debit:'普通預金',credit:'売上',amount:100}),
    entry({date:'2025/12/15',debit:'普通預金',credit:'売上',amount:900})
  ],{targetStart:'2027-01-01',targetEnd:'2027-12-31'});
  assert.equal(result.status,'complete');
  assert.equal(result.periodMapped,true);
  assert.equal(result.months.length,12);
  assert.deepEqual(result.months[0],{month:'2027-01',sourceMonth:'2025-01',gross:100,excludedOpening:0,excludedTax:0,base:100,entryCount:1});
  assert.equal(result.months[11].base,900);
});

test('MCF08 元資料期間または全月網羅が未確認なら完成扱いにしない',() => {
  const entries = [entry({debit:'普通預金',credit:'売上',amount:100})];
  assert.equal(calculate(entries,{sourcePeriodConfirmed:false}).result.status,'unconfirmed');
  assert.equal(calculate(entries,{sourceCoverageConfirmed:false}).result.status,'unconfirmed');
});

test('MCF12 別CSVの確認状態はファイルキーが異なれば使用しない',() => {
  const first = analyzeCashJournalText(fixture([entry({debit:'普通預金',credit:'開始残高',amount:100})]));
  const second = analyzeCashJournalText(fixture([entry({debit:'普通預金',credit:'開始残高',amount:200})]));
  const id = first.openingCandidates[0].id;
  const result = calculate([entry({debit:'普通預金',credit:'開始残高',amount:200})],{
    fileKey:first.fileKey,selectedAccounts:['普通預金'],openingDecisions:{[id]:'exclude'}}).result;
  assert.notEqual(first.fileKey,second.fileKey);
  assert.equal(result.status,'unconfirmed');
  assert.deepEqual(result.selectedAccounts,[]);
  assert.equal(result.months[0].base,0);
  assert.equal(result.months[0].excludedOpening,0);
});

test('MCF13 税務上未対応の課税区分も現預金移動なら資金実績に含む',() => {
  const csv = fixture([entry({debit:'普通預金',credit:'輸出売上',amount:500000,creditCode:'2'})]);
  const taxAnalysis = analyzeTkcJournalText(csv);
  assert.ok(taxAnalysis.unsupportedEntries.some(item => item.code === '2'));
  const cashAnalysis = analyzeCashJournalText(csv);
  const cash = buildMonthlyCashMovement(cashAnalysis,{fileKey:cashAnalysis.fileKey,selectedAccounts:['普通預金'],
    sourcePeriodStart:'2025-01',sourcePeriodEnd:'2025-12',sourcePeriodConfirmed:true,sourceCoverageConfirmed:true,
    targetStart:'2025-01',targetEnd:'2025-12'});
  assert.equal(cash.months[0].base,500000);
});

test('MCF14 日付不明・金額不正は0円として補完せず警告と未確認',() => {
  const {result} = calculate([
    entry({date:'日付不明',debit:'普通預金',credit:'売上',amount:100}),
    entry({date:'2025/02/30',debit:'普通預金',credit:'売上',amount:200}),
    entry({debit:'普通預金',credit:'売上',amount:'不明'})
  ]);
  assert.equal(result.status,'unconfirmed');
  assert.equal(result.months[0].entryCount,0);
  assert.equal(result.warnings.length,3);
  assert.match(result.warnings.join(' '),/日付.*金額/);
});

test('MCF15 同月の複数銀行口座・現金と訂正負数を符号付き合算',() => {
  const entries = [
    entry({debit:'普通預金',credit:'売上',amount:1000}),
    entry({debit:'当座預金',credit:'売上',amount:600}),
    entry({debit:'現金',credit:'売上',amount:400}),
    entry({debit:'普通預金',credit:'売上',amount:-100}),
    entry({debit:'経費',credit:'現金',amount:250})
  ];
  const result = calculate(entries,{selectedAccounts:['普通預金','当座預金','現金']}).result;
  assert.equal(result.status,'complete');
  assert.equal(result.months[0].gross,1650);
  assert.equal(result.months[0].base,1650);
});

test('資金科目候補は口座類に限定し、預け金・貸付金を自動候補としない',() => {
  const analysis = analyzeCashJournalText(fixture([
    entry({debit:'普通預金',credit:'預け金',amount:100}),
    entry({debit:'当座預金（本店）',credit:'短期貸付金',amount:200})
  ]));
  assert.deepEqual(analysis.suggestedAccounts,['当座預金（本店）','普通預金']);
});

test('開始残高・税金候補を残す場合も利用者の明示判断が必要',() => {
  const entries = [
    entry({debit:'普通預金',credit:'開始残高',amount:100}),
    entry({debit:'未払消費税等',credit:'普通預金',amount:30})
  ];
  const analysis = analyzeCashJournalText(fixture(entries));
  const result = calculate(entries,{openingDecisions:{[analysis.openingCandidates[0].id]:'keep'},
    taxDecisions:{[analysis.taxCandidates[0].id]:'keep'}}).result;
  assert.equal(result.status,'complete');
  assert.equal(result.months[0].base,70);
});

test('月次合計が安全な整数円を超える場合は完成額として保存しない',()=>{
  const {result}=calculate([
    entry({debit:'普通預金',credit:'売上',amount:Number.MAX_SAFE_INTEGER}),
    entry({debit:'普通預金',credit:'売上',amount:Number.MAX_SAFE_INTEGER})
  ]);
  assert.equal(result.status,'unconfirmed');
  assert.match(result.reasons.join(' '),/安全な整数円/);
});

test('明示1％税率の仕訳は件数を保持し、食品差額を8％実績へ重ねる前提と混同しない',()=>{
  const row=entry({debit:'普通預金',credit:'売上',amount:101000});
  row['貸方税率']='1';
  const analysis=analyzeCashJournalText(fixture([row]));
  assert.equal(analysis.explicitOnePercentCount,1);
});
