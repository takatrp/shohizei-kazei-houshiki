'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../tax-engine.js');
const { aggregateTaxRows, aggregateScenarioPurchases, createTaxEntryRow, CODE_DETAILS } = require('../tax-entry-rows.js');

const sale = (code, amount, rate = '', businessType = '', foodAmount = '') =>
  createTaxEntryRow('sales', { code, amount, rate, businessType, foodAmount });
const purchase = (code, amount, rate = '10', creditRatio = '', foodAmount = '') =>
  createTaxEntryRow('purchases', { code, amount, rate, creditRatio, foodAmount });
const value = (result, id) => result.fields[id].value;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} !== ${expected}`);

test('T01: 元行から食品1％の総額と3用途を同時再集計し、現行8％値は不変', () => {
  const purchases = [
    purchase('5','1080000','8','','1080000'),
    purchase('6','1100000','10'),
    purchase('7','1100000','10')
  ];
  const original = structuredClone(purchases);
  const current = aggregateScenarioPurchases({purchases}, {taxScenario:'current'});
  const food = aggregateScenarioPurchases({purchases}, {
    taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1,foodPurchasePriceBasis:'netFixed'
  });
  assert.equal(current.complete,true);
  assert.equal(food.complete,true);
  closeTo(current.purchaseTaxByUse.taxableOnly,80000);
  closeTo(current.totalCreditableTax,280000);
  closeTo(food.invoiceTotalAmount,3210000);
  closeTo(food.purchaseTaxByUse.taxableOnly,10000);
  closeTo(food.purchaseTaxByUse.nonTaxableOnly,100000);
  closeTo(food.purchaseTaxByUse.common,100000);
  closeTo(food.totalCreditableTax,210000);
  closeTo(1000000 - (food.purchaseTaxByUse.taxableOnly + food.purchaseTaxByUse.common * .5),940000);
  closeTo(1000000 - (current.purchaseTaxByUse.taxableOnly + current.purchaseTaxByUse.common * .5),870000);
  assert.deepEqual(purchases,original);
});

test('T02: 税込据置・一部食品・期間手入力／均等配分と免税70％を二重適用しない', () => {
  const rows = [purchase('5','1080000','8','','1080000'),purchase('6','1100000'),purchase('7','1100000')];
  const grossFixed = aggregateScenarioPurchases({purchases:rows}, {
    taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1,foodPurchasePriceBasis:'grossFixed'
  });
  closeTo(grossFixed.purchaseTaxByUse.taxableOnly,1080000 / 101);
  closeTo(1000000 - (grossFixed.purchaseTaxByUse.taxableOnly + 50000),939306.9306930693);
  const manual = aggregateScenarioPurchases({purchases:rows}, {
    taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:.5,foodPurchasePriceBasis:'netFixed'
  });
  const uniform = aggregateScenarioPurchases({purchases:rows}, {
    taxScenario:'foodProposal',foodForecastMethod:'uniform',proposalFraction:.5,foodPurchasePriceBasis:'netFixed'
  });
  closeTo(manual.purchaseTaxByUse.taxableOnly,10000);
  closeTo(uniform.purchaseTaxByUse.taxableOnly,45000);
  const exempt = aggregateScenarioPurchases({purchases:[purchase('52','1080000','8','70','1080000'),...rows.slice(1)]}, {
    taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1,foodPurchasePriceBasis:'netFixed'
  });
  closeTo(exempt.purchaseTaxByUse.taxableOnly,7000);
  closeTo(exempt.totalCreditableTax,207000);
  closeTo(1000000 - (exempt.purchaseTaxByUse.taxableOnly + 50000),943000);
});

test('T04: 将来期の70・50・30・0％は元の免税仕入税額から用途別と総額へ同時反映', () => {
  const purchases = [purchase('52','1100000','10','80'),purchase('6','1100000'),purchase('7','1100000')];
  const current = aggregateScenarioPurchases({purchases}, {taxScenario:'current'});
  closeTo(current.purchaseTaxByUse.taxableOnly,80000);
  closeTo(current.totalCreditableTax,280000);
  for(const [ratio,taxableOnly,regularAmount] of [[.7,70000,880000],[.5,50000,900000],[.3,30000,920000],[0,0,950000]]){
    const future = aggregateScenarioPurchases({purchases}, {taxScenario:'current',exemptRatioOverride:ratio});
    assert.equal(future.complete,true);
    closeTo(future.purchaseTaxByUse.taxableOnly,taxableOnly);
    closeTo(future.purchaseTaxByUse.nonTaxableOnly,100000);
    closeTo(future.purchaseTaxByUse.common,100000);
    closeTo(future.totalCreditableTax,taxableOnly + 200000);
    closeTo(1000000 - (future.purchaseTaxByUse.taxableOnly + future.purchaseTaxByUse.common * .5),regularAmount);
  }
});

test('明示1％実績は予測8％行へ混ぜず、用途へ一度だけ加え、用途不明は未算定', () => {
  const purchases = [purchase('5','108000','8','','108000')];
  const entries = [
    {kind:'invoicePurchase',usage:'common',amount:10100},
    {kind:'exemptPurchase',usage:'nonTaxableOnly',amount:10100,creditRatio:.7}
  ];
  const result = aggregateScenarioPurchases({purchases,actualOnePercentEntries:entries}, {
    taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1,foodPurchasePriceBasis:'netFixed'
  });
  assert.equal(result.complete,true);
  closeTo(result.invoiceTax,1100);
  closeTo(result.exemptCreditableTax,70);
  closeTo(result.purchaseTaxByUse.taxableOnly,1000);
  closeTo(result.purchaseTaxByUse.common,100);
  closeTo(result.purchaseTaxByUse.nonTaxableOnly,70);
  closeTo(result.totalCreditableTax,1170);
  const unknown = aggregateScenarioPurchases({purchases,actualOnePercentEntries:[{kind:'invoicePurchase',amount:10100}]}, {
    taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1
  });
  assert.equal(unknown.complete,false);
  assert.equal(unknown.usageUnknown,true);
  assert.match(unknown.errors.join(' '),/用途区分/);
  const current = aggregateScenarioPurchases({purchases,actualOnePercentEntries:entries}, {taxScenario:'current'});
  assert.equal(current.complete,false);
  closeTo(current.invoiceTax,8000);
});

test('食品内数の返品は符号を保って換算し、差引後の正額を維持', () => {
  const result = aggregateScenarioPurchases({purchases:[
    purchase('5','216000','8','','216000'),purchase('5','-108000','8','','-108000')
  ]}, {taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1});
  assert.equal(result.complete,true);
  closeTo(result.invoiceTotalAmount,101000);
  closeTo(result.invoiceTax,1000);
  closeTo(result.purchaseTaxByUse.taxableOnly,1000);
});

test('TKC行モデルは指定の8区分のみを定義し、空の末尾行を取引にしない', () => {
  assert.deepEqual(Object.keys(CODE_DETAILS), ['1','3','5','6','7','52','62','72']);
  const result = aggregateTaxRows({ sales:[createTaxEntryRow('sales')], purchases:[createTaxEntryRow('purchases')] });
  assert.equal(result.ready, true);
  assert.equal(result.fields.type2Sale10.entered, false);
  assert.equal(result.fields.purchase10.entered, false);
  assert.equal(result.fields.nonTaxableSales.entered, false);
});

test('A-C: 売上1の事業区分・10％・軽8％食品内数と非課税売上3を従来欄へ集計', () => {
  const result = aggregateTaxRows({ sales:[
    sale('1','1,100,000','10','type2'),
    sale('1','1,080,000','8','type2','1,080,000'),
    sale('3','300,000')
  ] });
  assert.equal(result.ready, true);
  assert.deepEqual(result.fields.type2Sale10, {value:1100000,entered:true,valid:true});
  assert.deepEqual(result.fields.type2Sale8, {value:1080000,entered:true,valid:true});
  assert.deepEqual(result.fields.type2SaleFood1, {value:1080000,entered:true,valid:true});
  assert.deepEqual(result.fields.nonTaxableSales, {value:300000,entered:true,valid:true});
  const oldSalesTax = engine.taxFromAmount(1100000,10,'included')
    + engine.taxFromAmount(1080000,8,'included');
  const newSalesTax = engine.taxFromAmount(value(result,'type2Sale10'),10,'included')
    + engine.taxFromAmount(value(result,'type2Sale8'),8,'included');
  assert.equal(newSalesTax, oldSalesTax);
});

test('D-I: 5/6/7と52/62/72を総仕入と用途別税額へ別々に反映', () => {
  const result = aggregateTaxRows({ purchases:[
    purchase('5','250000'), purchase('6','100000'), purchase('7','120000'),
    purchase('52','80000','10','80'), purchase('62','50000','10','80'),
    purchase('72','60000','10','80')
  ] });
  assert.equal(result.ready, true);
  assert.equal(value(result,'purchase10'),470000);
  assert.equal(value(result,'exemptPurchase80_10'),190000);
  const tax = gross => engine.taxFromAmount(gross,10,'included');
  assert.equal(value(result,'taxableOnlyPurchaseTax'), Math.round(tax(250000) + tax(80000)*.8));
  assert.equal(value(result,'commonPurchaseTax'), Math.round(tax(120000) + tax(60000)*.8));
  assert.equal(result.nonTaxableOnlyPurchaseTax, Math.round(tax(100000) + tax(50000)*.8));
  assert.equal(result.invoiceByUse.nonTaxableOnly['10'],100000);
  assert.equal(result.exemptByUse.nonTaxableOnly['80']['10'],50000);
});

test('J-K: 重複行は集計時だけ合算し、明示0円は空欄と区別', () => {
  const result = aggregateTaxRows({ sales:[sale('3','0')], purchases:[
    purchase('5','100000'), purchase('5','150000'), purchase('7','0')
  ] });
  assert.equal(result.ready, true);
  assert.equal(value(result,'purchase10'),250000);
  assert.equal(result.fields.nonTaxableSales.entered,true);
  assert.equal(result.fields.nonTaxableSales.value,0);
  assert.equal(result.invoiceByUse.common['10'],0);
  assert.equal(result.fields.taxableOnlyPurchaseTax.entered,true);
});

test('L: 正負が相殺する0円は既知0円、負の最終バケットだけエラー', () => {
  const balanced = aggregateTaxRows({ sales:[sale('1','100000','10','type2'),sale('1','-100000','10','type2')],
    purchases:[purchase('5','50000'),purchase('5','-50000')] });
  assert.equal(balanced.ready,true);
  assert.equal(value(balanced,'type2Sale10'),0);
  assert.equal(balanced.fields.type2Sale10.entered,true);
  assert.equal(value(balanced,'purchase10'),0);
  assert.equal(balanced.fields.purchase10.entered,true);
  const negative = aggregateTaxRows({ purchases:[purchase('5','10000'),purchase('5','-20000')] });
  assert.equal(negative.ready,false);
  assert.match(negative.errors.map(error => error.message).join(' '), /マイナス/);
});

test('食品対象は空欄・0・全額を区別し、過大入力と符号違いを検出', () => {
  const blank = aggregateTaxRows({ sales:[sale('1','108000','8','type2','')] });
  const zero = aggregateTaxRows({ sales:[sale('1','108000','8','type2','0')] });
  const full = aggregateTaxRows({ sales:[sale('1','108000','8','type2','108000')] });
  assert.equal(blank.fields.type2SaleFood1.entered,false);
  assert.equal(zero.fields.type2SaleFood1.entered,true);
  assert.equal(zero.fields.type2SaleFood1.value,0);
  assert.equal(full.fields.type2SaleFood1.value,108000);
  assert.equal(aggregateTaxRows({ sales:[sale('1','108000','8','type2','108001')] }).ready,false);
  assert.equal(aggregateTaxRows({ sales:[sale('1','-108000','8','type2','100')] }).ready,false);
});

test('免税事業者等仕入の期間区分は推定せず、明示した比率別に保存', () => {
  const missing = aggregateTaxRows({ purchases:[purchase('52','80000')] });
  assert.equal(missing.ready,false);
  assert.match(missing.errors[0].message,/控除割合/);
  const split = aggregateTaxRows({ purchases:[
    purchase('52','80000','10','80'), purchase('52','50000','10','50')
  ] });
  assert.equal(split.ready,true);
  assert.equal(value(split,'exemptPurchase80_10'),80000);
  assert.equal(value(split,'exemptPurchase50_10'),50000);
  assert.equal(value(split,'taxableOnlyPurchaseTax'),Math.round(
    engine.taxFromAmount(80000,10,'included')*.8 + engine.taxFromAmount(50000,10,'included')*.5));
});

test('CSV明示1％実績は総仕入欄へ重複計上せず、用途別税額にだけ加える', () => {
  const result = aggregateTaxRows({ purchases:[purchase('5','110000')] }, {actualOnePercentEntries:[
    {kind:'invoicePurchase', usage:'taxableOnly', amount:10100},
    {kind:'exemptPurchase', usage:'common', amount:10100, creditRatio:0.8}
  ]});
  assert.equal(value(result,'purchase10'),110000);
  assert.equal(value(result,'purchase8'),0);
  assert.equal(value(result,'taxableOnlyPurchaseTax'),10100);
  assert.equal(value(result,'commonPurchaseTax'),80);
});

test('事業区分未確認は勝手に第1種等へ割り当てず、利用可能な税率別情報を返す', () => {
  const result = aggregateTaxRows({ sales:[sale('1','1100000','10','')] });
  assert.equal(result.ready,false);
  assert.equal(result.errors.length,0);
  assert.equal(result.unclassifiedSales[0].amount,1100000);
  assert.equal(value(result,'type1Sale10'),0);
  assert.equal(result.fields.type1Sale10.entered,false);
});

test('税込行から税抜の旧入力欄を使う場合も既存の換算関数に一致', () => {
  const result = aggregateTaxRows({ sales:[sale('1','1100000','10','type2')],
    purchases:[purchase('5','550000')] }, {amountMode:'excluded'});
  assert.equal(value(result,'type2Sale10'), engine.taxableBaseFromAmount(1100000,10,'included'));
  assert.equal(value(result,'purchase10'), engine.taxableBaseFromAmount(550000,10,'included'));
  assert.equal(engine.taxFromAmount(value(result,'type2Sale10'),10,'excluded'),100000);
  assert.equal(engine.taxFromAmount(value(result,'purchase10'),10,'excluded'),50000);
});

test('標準食品1％例の現行本則4万円・簡易1.6万円を既存エンジンへの同一入力で維持', () => {
  const result = aggregateTaxRows({ sales:[
    sale('1','1080000','8','type2','1080000'), sale('3','0')
  ], purchases:[purchase('5','540000','8','','540000')] });
  assert.equal(result.ready,true);
  const salesTax = engine.taxFromAmount(value(result,'type2Sale8'),8,'included');
  const purchaseTax = engine.taxFromAmount(value(result,'purchase8'),8,'included');
  const taxableBase = engine.taxableBaseFromAmount(value(result,'type2Sale8'),8,'included');
  const regular = engine.calculateDetailedRegular({
    salesTax, purchaseTax, adjustment:0, method:'auto', taxableSales:taxableBase,
    totalSales:taxableBase + value(result,'nonTaxableSales'), periodMonths:12,
    taxableOnlyTax:value(result,'taxableOnlyPurchaseTax'), commonTax:value(result,'commonPurchaseTax')
  });
  const simplified = engine.calculateSimplifiedTax([{key:'type2', deemed:.8,
    rowTax:salesTax, rowTaxableBase:taxableBase, foodOnePercentTax:0, foodOnePercentTaxableBase:0}]);
  assert.equal(regular.amount,40000);
  assert.equal(simplified.amount,16000);
  assert.equal(value(result,'type2SaleFood1'),1080000);
  assert.equal(value(result,'purchaseFood1'),540000);
});
