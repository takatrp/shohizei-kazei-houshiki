'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const journal = require('../journal-csv.js');
const {rowsFromJournalAnalysis} = require('../tax-entry-csv.js');
const {aggregateTaxRows} = require('../tax-entry-rows.js');

function csv(entries){
  return [journal.REQUIRED_HEADERS, ...entries.map(entry => journal.REQUIRED_HEADERS.map(header => entry[header] ?? ''))]
    .map(cells => cells.map(value => {
      const text = String(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(',')).join('\r\n');
}

function entry(side, {code, amount, rate = '10', business = '', credit = '', account = '', date = '2028/01/15'}){
  return {
    月日:date,
    [`${side}科目名`]:account,
    [`${side}課税区分`]:code,
    [`${side}事業区分`]:business,
    [`${side}軽減税率か否か`]:rate === '10' ? '0' : '1',
    [`${side}税率`]:rate,
    [`${side}取引金額`]:amount,
    [`${side}消費税等`]:'',
    [`${side}控除割合`]:credit
  };
}

function converted(entries){
  const analysis = journal.analyzeTkcJournalText(csv(entries));
  const resolved = journal.resolveImportValues(analysis);
  assert.equal(resolved.ready, true, resolved.errors.join(' / '));
  return rowsFromJournalAnalysis(analysis, resolved);
}

test('CSVの売上・仕入をTKC用途、税率、控除割合ごとの行へ集約する', () => {
  const rows = converted([
    entry('貸方',{code:'1',business:'2',rate:'10',amount:1100000}),
    entry('貸方',{code:'1',business:'2',rate:'10',amount:220000}),
    entry('貸方',{code:'3',amount:300000}),
    entry('借方',{code:'5',amount:250000}),
    entry('借方',{code:'6',amount:100000}),
    entry('借方',{code:'7',rate:'8',amount:120000}),
    entry('借方',{code:'52',amount:80000,credit:'80'}),
    entry('借方',{code:'62',amount:60000,credit:'80'}),
    entry('借方',{code:'72',rate:'8',amount:70000,credit:'50'})
  ]);
  assert.deepEqual(rows.sales.map(({code,businessType,rate,amount,source}) => ({code,businessType,rate,amount,source})), [
    {code:'1',businessType:'type2',rate:'10',amount:'1320000',source:'csv'},
    {code:'3',businessType:'',rate:'',amount:'300000',source:'csv'}
  ]);
  assert.deepEqual(rows.purchases.map(({code,rate,amount,creditRatio}) => ({code,rate,amount,creditRatio})), [
    {code:'5',rate:'10',amount:'250000',creditRatio:''},
    {code:'52',rate:'10',amount:'80000',creditRatio:'80'},
    {code:'6',rate:'10',amount:'100000',creditRatio:''},
    {code:'62',rate:'10',amount:'60000',creditRatio:'80'},
    {code:'7',rate:'8',amount:'120000',creditRatio:''},
    {code:'72',rate:'8',amount:'70000',creditRatio:'50'}
  ]);
  assert.ok(rows.purchases.every(row => row.foodAmount === ''));
});

test('CSVの売上返品相殺0円は明示0行として保持し、明示1％実績は通常行に混ぜない', () => {
  const rows = converted([
    entry('貸方',{code:'1',business:'2',rate:'10',amount:1100}),
    entry('借方',{code:'11',business:'2',rate:'10',amount:1100}),
    entry('貸方',{code:'1',business:'2',rate:'1',amount:1010,account:'秘密の科目名'})
  ]);
  assert.equal(rows.sales.length, 1);
  assert.equal(rows.sales[0].amount, '0');
  assert.equal(rows.sales[0].rate, '10');
  assert.equal(rows.actualOnePercentEntries.length, 1);
  assert.equal(rows.actualOnePercentEntries[0].amount, 1010);
  assert.ok(!JSON.stringify(rows.actualOnePercentEntries).includes('秘密の科目名'));
  assert.ok(rows.sales.every(row => row.rate !== '1'));
});

test('概算時は補正・仮除外・負数下限を反映した後の用途別集計だけを行へ変換する', () => {
  const text = csv([
    entry('貸方',{code:'5',rate:'10',amount:1100}),
    entry('借方',{code:'6',rate:'10',amount:2200}),
    entry('借方',{code:'9',rate:'10',amount:3300})
  ]);
  const estimate = journal.prepareEstimatedImport(text);
  assert.equal(estimate.resolved.ready, true, estimate.resolved.errors.join(' / '));
  const rows = rowsFromJournalAnalysis(estimate.analysis, estimate.resolved);
  assert.deepEqual(rows.purchases.map(({code,amount}) => ({code,amount})), [{code:'6',amount:'2200'}]);
  assert.equal(estimate.recoverySummary.negativeBucketCount, 1);
  assert.equal(estimate.recoverySummary.temporaryExcludedCount, 1);
});

test('CSV集計に件数のない0円仕入用途は区分を推測して作らず、限界を明示する', () => {
  const rows = converted([entry('貸方',{code:'1',business:'2',rate:'10',amount:1100})]);
  assert.deepEqual(rows.purchases, []);
  assert.ok(rows.unrecoverable.includes('zero-purchase-code-counts'));
  assert.ok(rows.unrecoverable.includes('zero-non-taxable-sales-count'));
});

test('CSVの用途別仕入税額は端数・明示1％を含め旧集計額と一致する', () => {
  const analysis = journal.analyzeTkcJournalText(csv([
    entry('貸方',{code:'1',business:'2',rate:'10',amount:1100000}),
    entry('借方',{code:'5',rate:'10',amount:250001}),
    entry('借方',{code:'6',rate:'10',amount:100001}),
    entry('借方',{code:'7',rate:'8',amount:120001}),
    entry('借方',{code:'52',rate:'10',amount:80001,credit:'80'}),
    entry('借方',{code:'62',rate:'1',amount:10101,credit:'80'}),
    entry('借方',{code:'72',rate:'8',amount:70001,credit:'50'})
  ]));
  const resolved = journal.resolveImportValues(analysis);
  assert.equal(resolved.ready,true,resolved.errors.join(' / '));
  const rows = rowsFromJournalAnalysis(analysis,resolved);
  const aggregate = aggregateTaxRows(rows,{actualOnePercentEntries:rows.actualOnePercentEntries});
  assert.equal(aggregate.fields.purchase10.value,resolved.values.invoicePurchases['10']);
  assert.equal(aggregate.fields.purchase8.value,resolved.values.invoicePurchases['8']);
  assert.equal(aggregate.fields.taxableOnlyPurchaseTax.value,resolved.values.taxableOnlyPurchaseTax);
  assert.equal(aggregate.fields.commonPurchaseTax.value,resolved.values.commonPurchaseTax);
  assert.equal(aggregate.nonTaxableOnlyPurchaseTax,resolved.values.nonTaxableOnlyPurchaseTax);
});

test('免税仕入行は区分・控除割合・税率ごとに通常取引日だけの範囲と調整・日付不明件数を持つ', () => {
  const source = csv([
    entry('借方',{code:'52',rate:'10',amount:80000,credit:'80',date:'2026/09/30',account:'保存禁止の取引先'}),
    entry('借方',{code:'52',rate:'10',amount:20000,credit:'80',date:'2026/10/01'}),
    entry('貸方',{code:'53',rate:'10',amount:10000,credit:'80',date:'2026/12/01'}),
    entry('借方',{code:'52',rate:'10',amount:5000,credit:'80',date:'不明'}),
    entry('借方',{code:'62',rate:'10',amount:70000,credit:'70',date:'2026/10/01'}),
    entry('借方',{code:'72',rate:'8',amount:30000,credit:'80',date:'2026/09/30'})
  ]);
  const analysis = journal.analyzeTkcJournalText(source);
  const resolved = journal.resolveImportValues(analysis);
  assert.equal(resolved.ready,true,resolved.errors.join(' / '));
  const rows = rowsFromJournalAnalysis(analysis,resolved);
  const byCode = Object.fromEntries(rows.purchases.map(row => [row.code,row]));
  assert.deepEqual({amount:byCode['52'].amount,ratio:byCode['52'].creditRatio,
    start:byCode['52'].sourceDateStart,end:byCode['52'].sourceDateEnd,
    adjustments:byCode['52'].sourceAdjustmentCount,unknownDates:byCode['52'].sourceDateUnknownCount},
  {amount:'95000',ratio:'80',start:'2026-09-30',end:'2026-10-01',adjustments:1,unknownDates:1});
  assert.deepEqual([byCode['62'].creditRatio,byCode['62'].sourceDateStart,byCode['62'].sourceDateEnd],
    ['70','2026-10-01','2026-10-01']);
  assert.deepEqual([byCode['72'].creditRatio,byCode['72'].sourceDateStart,byCode['72'].sourceDateEnd],
    ['80','2026-09-30','2026-09-30']);
  assert.ok(!JSON.stringify(rows.purchases).includes('保存禁止の取引先'));
  assert.equal(analysis.exemptPurchaseProvenanceByUse.taxableOnly['80']['10'].sourceDateEnd,'2026-10-01',
    '80%の適用期間外となり得る日付を丸めて隠さない');
});

test('概算補正・除外後の免税仕入日付情報だけを行へ引き継ぐ', () => {
  const source = csv([
    entry('借方',{code:'52',rate:'10',amount:80000,credit:'?',date:'2026/09/30'}),
    entry('借方',{code:'52',rate:'10',amount:'不明',credit:'80',date:'2026/10/01'})
  ]);
  const estimate = journal.prepareEstimatedImport(source);
  assert.equal(estimate.resolved.ready,true,estimate.resolved.errors.join(' / '));
  const rows = rowsFromJournalAnalysis(estimate.analysis,estimate.resolved);
  assert.equal(rows.purchases.length,1);
  assert.deepEqual([rows.purchases[0].code,rows.purchases[0].creditRatio,rows.purchases[0].sourceDateStart,
    rows.purchases[0].sourceDateEnd,rows.purchases[0].sourceDateUnknownCount],
  ['52','0','2026-09-30','2026-09-30',0]);
  assert.equal(estimate.recoverySummary.temporaryExcludedCount,1);
});
