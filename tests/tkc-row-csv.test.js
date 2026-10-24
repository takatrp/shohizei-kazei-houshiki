'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const journal = require('../journal-csv.js');
const {rowsFromJournalAnalysis} = require('../tax-entry-csv.js');
const {aggregateTaxRows} = require('../tax-entry-rows.js');

function csv(entries, extraHeaders = []){
  const headers = [...journal.REQUIRED_HEADERS, ...extraHeaders];
  return [headers, ...entries.map(entry => headers.map(header => entry[header] ?? ''))]
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

test('CSV区分1に含まれた負額調整の出所を行へ残し、食品だけを要確認にする',()=>{
  const rows=converted([
    entry('貸方',{code:'1',business:'2',rate:'8',amount:216000,date:'2028/01/15'}),
    entry('借方',{code:'1',business:'2',rate:'8',amount:108000,date:'2028/02/15'})
  ]);
  const sale=rows.sales.find(row=>row.code==='1'&&row.rate==='8');
  assert.equal(sale.amount,'108000');
  assert.ok(sale.sourceAdjustmentCount>0);
  assert.deepEqual([sale.sourceDateStart,sale.sourceDateEnd],['2028-01-15','2028-02-15']);
  const {collectSalesScenario}=require('../sales-scenario');
  const withFood={sales:[{...sale,foodAmount:sale.amount}]};
  const current=collectSalesScenario(withFood,{taxScenario:'current'});
  assert.equal(current.totalTax,8000); // preserve 216000 - 108000 at 8%
  assert.equal(current.errors.length,0);
  const proposal=collectSalesScenario(withFood,{taxScenario:'foodProposal',foodForecastMethod:'manual',foodSalesPriceBasis:'netFixed'});
  assert.match(proposal.errors.join(' '),/通常取引と返品・調整/);
  assert.equal(aggregateTaxRows(rows).fields.type2Sale8.value,108000);
});

test('科目から事業区分へ補完したCSVも匿名の調整根拠を落とさない',()=>{
  const text=csv([
    entry('貸方',{code:'1',rate:'8',amount:216000,account:'匿名科目'}),
    entry('借方',{code:'1',rate:'8',amount:108000,account:'匿名科目'})
  ]);
  const analysis=journal.analyzeTkcJournalText(text);
  const mappings=Object.fromEntries(analysis.unclassifiedSales.map(group=>[group.key,'type2']));
  const resolved=journal.resolveImportValues(analysis,mappings);
  assert.equal(resolved.ready,true,resolved.errors.join(' / '));
  const rows=rowsFromJournalAnalysis(analysis,resolved);
  assert.equal(rows.sales[0].amount,'108000');
  assert.ok(rows.sales[0].sourceAdjustmentCount>0);
  assert.ok(!JSON.stringify(rows).includes('匿名科目'));
});

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

test('CSVの売上と返還を別行に保持し、純額0円と明示1％実績を区別する', () => {
  const rows = converted([
    entry('貸方',{code:'1',business:'2',rate:'10',amount:1100}),
    entry('借方',{code:'11',business:'2',rate:'10',amount:1100}),
    entry('貸方',{code:'1',business:'2',rate:'1',amount:1010,account:'秘密の科目名'})
  ]);
  assert.deepEqual(rows.sales.map(item => [item.code,item.amount,item.rate]),[['1','1100','10'],['11','1100','10']]);
  assert.equal(aggregateTaxRows(rows).fields.type2Sale10.value,0);
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

test('未分類売上は科目を横断して同じ課税区分・税率を合算し、事業区分を推測しない', () => {
  const analysis = journal.analyzeTkcJournalText(csv([
    entry('貸方',{code:'1',rate:'8',amount:1080,account:'売上科目A'}),
    entry('貸方',{code:'1',rate:'8',amount:2160,account:'売上科目B'}),
    entry('貸方',{code:'1',rate:'10',amount:1100,account:'売上科目A'}),
    entry('貸方',{code:'1',rate:'10',amount:2200,account:'売上科目B'})
  ]));
  const resolved = journal.resolveImportValues(analysis, {}, {allowUnclassifiedSales:true});
  assert.equal(resolved.ready, true, resolved.errors.join(' / '));
  assert.equal(resolved.unclassifiedSales.length, 2, '元の科目別マッピング候補は保持する');
  const rows = rowsFromJournalAnalysis(analysis, resolved);
  assert.deepEqual(rows.sales.map(({code,rate,amount,businessType,source}) =>
    ({code,rate,amount,businessType,source})), [
    {code:'1',rate:'10',amount:'3300',businessType:'',source:'csv'},
    {code:'1',rate:'8',amount:'3240',businessType:'',source:'csv'}
  ]);
  assert.equal(new Set(rows.sales.map(row => row.id)).size, rows.sales.length);
  assert.ok(!JSON.stringify(rows).includes('売上科目'));
  const aggregate = aggregateTaxRows(rows);
  assert.deepEqual(aggregate.unclassifiedSalesTotals, {'10':3300,'8':3240});
  assert.equal(aggregate.ready, false, '合算しても未確認の事業区分を確認済みにしない');
});

test('科目横断の合算後も売上1と返還11を分け、差引0円の実額を保持する', () => {
  const analysis = journal.analyzeTkcJournalText(csv([
    entry('貸方',{code:'1',rate:'8',amount:1080,account:'売上科目A'}),
    entry('借方',{code:'11',rate:'8',amount:1080,account:'売上科目A'}),
    entry('貸方',{code:'1',rate:'8',amount:2160,account:'売上科目B'}),
    entry('借方',{code:'11',rate:'8',amount:2160,account:'売上科目B'})
  ]));
  const resolved = journal.resolveImportValues(analysis, {}, {allowUnclassifiedSales:true});
  assert.equal(resolved.ready, true, resolved.errors.join(' / '));
  const rows = rowsFromJournalAnalysis(analysis, resolved);
  assert.deepEqual(rows.sales.map(({code,rate,amount}) => [code,rate,amount]),
    [['1','8','3240'],['11','8','3240']]);
  assert.equal(aggregateTaxRows(rows).unclassifiedSalesTotals['8'], 0);
  assert.equal(aggregateTaxRows(rows).errors.length, 0);
});

test('同じ課税区分・税率でも異なる事業区分と免税仕入控除割合は別行にする', () => {
  const rows = converted([
    entry('貸方',{code:'1',business:'1',rate:'8',amount:1080,account:'卸売A'}),
    entry('貸方',{code:'1',business:'1',rate:'8',amount:2160,account:'卸売B'}),
    entry('貸方',{code:'1',business:'2',rate:'8',amount:4320,account:'小売'}),
    entry('借方',{code:'52',rate:'8',amount:1080,credit:'80',date:'2026/09/30'}),
    entry('借方',{code:'52',rate:'8',amount:2160,credit:'70',date:'2026/10/01'})
  ]);
  assert.deepEqual(rows.sales.map(({code,rate,businessType,amount}) => [code,rate,businessType,amount]),
    [['1','8','type1','3240'],['1','8','type2','4320']]);
  assert.deepEqual(rows.purchases.map(({code,rate,creditRatio,amount,sourceDateStart}) =>
    [code,rate,creditRatio,amount,sourceDateStart]),
    [['52','8','80','1080','2026-09-30'],['52','8','70','2160','2026-10-01']]);
  const aggregate = aggregateTaxRows(rows);
  assert.equal(aggregate.fields.type1Sale8.value, 3240);
  assert.equal(aggregate.fields.type2Sale8.value, 4320);
  assert.equal(aggregate.fields.taxableOnlyPurchaseTax.value, 176,
    '80円×80％＋160円×70％の控除額を維持する');
});

test('輸入は同じ区分・税率でも本体・国税・地方税を分離し、同じ構成要素だけを合算する', () => {
  const imported = (code, component, amount, account) => ({
    ...entry('借方',{code,amount,account}), 借方輸入区分:component
  });
  const analysis = journal.analyzeTkcJournalText(csv([
    imported('55','goods',100000,'輸入本体A'),
    imported('55','goods',200000,'輸入本体B'),
    imported('55','national',7800,'輸入国税A'),
    imported('55','national',15600,'輸入国税B'),
    imported('55','local',6600,'輸入地方税'),
    imported('65','national',7800,'非課税対応の国税'),
    imported('65','local',2200,'非課税対応の地方税')
  ], ['借方輸入区分']));
  const resolved = journal.resolveImportValues(analysis);
  assert.equal(resolved.ready, true, resolved.errors.join(' / '));
  const rows = rowsFromJournalAnalysis(analysis, resolved);
  assert.deepEqual(rows.purchases.map(({code,rate,importComponent,amount,sourceCount}) =>
    [code,rate,importComponent,amount,sourceCount]), [
    ['55','10','goods','300000',2],
    ['55','10','national','23400',2],
    ['55','10','local','6600',1],
    ['65','10','national','7800',1],
    ['65','10','local','2200',1]
  ]);
});

test('STEP2の科目横断集約はCSVの月別配分・返品月・科目別確認情報を変更しない', () => {
  const analysis = journal.analyzeTkcJournalText(csv([
    entry('貸方',{code:'1',rate:'8',amount:1080,account:'売上科目A',date:'2028/01/15'}),
    entry('貸方',{code:'1',rate:'8',amount:2160,account:'売上科目B',date:'2028/02/15'}),
    entry('借方',{code:'11',rate:'8',amount:1080,account:'売上科目A',date:'2028/03/15'})
  ]));
  const resolved = journal.resolveImportValues(analysis, {}, {allowUnclassifiedSales:true});
  assert.equal(resolved.ready, true, resolved.errors.join(' / '));
  const originalAnalysis = structuredClone(analysis);
  const originalResolved = structuredClone(resolved);
  const rows = rowsFromJournalAnalysis(analysis, resolved);
  assert.deepEqual(rows.sales.map(({code,amount}) => [code,amount]), [['1','3240'],['11','1080']]);
  assert.deepEqual(analysis.monthlyGroups.map(({month,code,amount,transactionKind}) =>
    [month,code,amount,transactionKind]), [
    ['2028-01','1',1080,'ordinary'],
    ['2028-02','1',2160,'ordinary'],
    ['2028-03','11',-1080,'adjustment']
  ]);
  assert.deepEqual(analysis, originalAnalysis);
  assert.deepEqual(resolved, originalResolved);
  assert.deepEqual(rowsFromJournalAnalysis(analysis, resolved), rows);
});



test('日付不明で日別集計が空でも月別調整根拠を失わない',()=>{
  const analysis=journal.analyzeTkcJournalText(csv([
    entry('貸方',{code:'1',business:'2',rate:'8',amount:216000,date:''}),
    entry('借方',{code:'1',business:'2',rate:'8',amount:108000,date:''})]));
  const resolved=journal.resolveImportValues(analysis);assert.equal(resolved.ready,true);
  analysis.dailyGroups=[]; // Old summary without anonymous daily aggregates.
  const rows=rowsFromJournalAnalysis(analysis,resolved),sale=rows.sales.find(r=>r.code==='1');
  assert.equal(sale.amount,'108000');assert.ok(sale.sourceAdjustmentCount>0);assert.ok(sale.sourceDateUnknownCount>0);
  const result=require('../sales-scenario.js').collectSalesScenario({sales:[{...sale,foodAmount:'108000'}]},
    {taxScenario:'foodProposal',foodForecastMethod:'uniform',proposalFraction:1});
  assert.match(result.errors.join(' '),/通常取引と返品・調整/);
});
