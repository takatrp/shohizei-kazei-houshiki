'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../tax-engine.js');
const rowsApi = require('../tax-entry-rows.js');
const sale = (amount, ratePercent = 1, extra = {}) => ({amount,ratePercent,amountMode:'excluded',
  businessKey:'type2',deemed:.8,foodOnePercent:ratePercent === 1,confirmed:true,...extra});
const returned = (amount, ratePercent = 1, extra = {}) => sale(amount,ratePercent,{
  transactionKind:'adjustment',originalRatePercent:ratePercent,originalDate:'2028-06-01',...extra});

test('現行法の返還控除も元免税・明示未確認・旧未指定を区別する',()=>{
  const R=require('../tax-return-engine');
  const original={sales:[{code:'1',rate:'8',businessType:'type2',amount:'216000'},
    {code:'11',rate:'8',businessType:'type2',amount:'108000',originalTaxableState:'exempt'},
    {code:'3',amount:'0'}],purchases:[{code:'5',rate:'10',amount:'0'}]};
  const before=structuredClone(original);
  const aggregate=rowsApi.aggregateTaxRows(original);
  assert.equal(aggregate.ready,true);
  assert.equal(aggregate.fields.type2Sale8.value,216000);
  assert.match(aggregate.warnings.map(x=>x.message).join(' '),/免税/);
  const built=R.aggregateReturnRows(original);
  assert.equal(built.reasons.length,0);
  assert.equal(built.input.salesReturnGross['8'],0);
  Object.assign(built.input,{periodStart:'2028-01-01',periodEnd:'2028-12-31',periodMonths:12});
  const current=R.calculateCurrentLawReturn(built.input);
  // 216000 / 1.08 * 6.24%=12480 => national12400 + local3400.
  assert.equal(current.mainReturn.totalBeforeInterim,15800);
  const unknown={...original,sales:original.sales.map(row=>row.code==='11'?{...row,originalTaxableState:'unknown'}:row)};
  const unknownBefore=structuredClone(unknown);
  const uncertain=rowsApi.aggregateTaxRows(unknown);
  assert.equal(uncertain.ready,true);
  assert.deepEqual(uncertain.errors,[]);
  assert.equal(uncertain.fields.type2Sale8.value,108000,'元8％の返還を一度だけ差し引く');
  assert.ok(uncertain.warnings.length>0,'課税状態未確認の代理仮定を明示する');
  assert.equal(uncertain.fields.purchase10.entered,true,'関係しない仕入の入力状態を維持する');
  assert.deepEqual(unknown,unknownBefore,'元課税状態unknownを確認済みにしない');
  // Exact return reconstruction still requires the original taxable state;
  // keeping a raw estimate does not certify a filing reproduction.
  const unresolved=R.aggregateReturnRows(unknown);
  assert.match(unresolved.reasons.join(' '),/課税・免税/);
  assert.equal(R.calculateCurrentLawReturn(unresolved.input).referenceCalculable,false);
  assert.equal(R.calculateCurrentLawSalesMethod(unresolved.input,'simplified',{type2:.8}).referenceCalculable,false);
  const legacy={...original,sales:original.sales.map(row=>{const copy={...row};delete copy.originalTaxableState;return copy;})};
  assert.equal(rowsApi.aggregateTaxRows(legacy).fields.type2Sale8.value,108000);
  assert.equal(R.aggregateReturnRows(legacy).input.salesReturnGross['8'],108000);
  assert.deepEqual(original,before);
});

test('⑤ 再現: 一般行UIの純負額も注意付きで保持し、食品負額の同額控除へ符号を渡す', () => {
  const rows={sales:[{code:'11',amount:'108000',rate:'8',businessType:'type2',foodAmount:'108000'}]};
  const before=structuredClone(rows);
  const entered = rowsApi.aggregateTaxRows(rows);
  assert.equal(entered.ready,true);
  assert.deepEqual(entered.errors,[]);
  assert.ok(entered.warnings.length>0);
  assert.equal(entered.fields.type2Sale8.value,-108000);
  assert.equal(entered.fields.type2SaleFood1.value,-108000);
  assert.deepEqual(rows,before);
  const calculated = engine.calculateSimplifiedTax([{key:'type2',name:'小売',deemed:.8,
    rowTax:-10000,rowTaxableBase:-1000000,foodOnePercentTax:-10000,foodOnePercentTaxableBase:-1000000}]);
  assert.equal(calculated.foodOnePercentTax,-10000);
  assert.equal(calculated.deemedCredit,-10000);
  assert.equal(calculated.amount,0);
});

test('⑤ 通常食品売上・一部返品・売上超過返品・年間相殺0円は食品税額と同額控除が一致する', () => {
  for(const [gross,refund,expected] of [[1000000,0,10000],[1000000,200000,8000],[1000000,1500000,-5000],[1000000,1000000,0]]){
    const result = engine.calculatePeriodTaxCase({sales:[sale(gross),...(refund ? [returned(refund)] : [])]});
    assert.equal(result.valid,true);
    assert.equal(result.salesTax,expected);
    assert.equal(result.simplified.foodOnePercentTax,expected);
    assert.equal(result.simplified.deemedCredit,expected);
    assert.equal(result.simplified.amount,0);
    assert.equal(result.special2.amount,0);
    assert.equal(result.special3.amount,0);
    assert.equal(result.regularAmount,expected);
  }
});

test('⑤ 1％返品と新聞8％・10％・複数事業を混在させても食品だけを同額控除する', () => {
  // Food net tax -5000. Other tax 80000 + 100000, with normal deemed
  // credits 64000 + 50000. No business has a 75% share (1m each).
  const result = engine.calculatePeriodTaxCase({sales:[sale(1000000),returned(1500000),
    sale(1000000,8),sale(1000000,10,{businessKey:'type5',deemed:.5})]});
  assert.equal(result.valid,true);
  assert.equal(result.salesTax,175000);
  assert.equal(result.simplified.otherSalesTax,180000);
  assert.equal(result.simplified.deemedCredit,109000);
  assert.equal(result.simplified.amount,66000);
  assert.equal(result.special2.amount,36000);
  assert.equal(result.special3.amount,54000);
});

test('⑤ 元8％返品を1％へ移さず、元税率不明だけを要確認にする', () => {
  assert.equal(engine.taxRateForProposalItem({date:'2027-04-01',category:'food',transactionKind:'adjustment',originalRatePercent:8}).ratePercent,8);
  assert.equal(engine.taxRateForProposalItem({date:'2027-04-01',category:'food',transactionKind:'adjustment'}).status,'unknown');
  const result = engine.calculatePeriodTaxCase({sales:[sale(1000000),returned(100000,8)]});
  assert.equal(result.salesTax,2000);
  assert.equal(result.regularAmount,2000);
  assert.equal(result.simplified.otherSalesTax,-8000);
  assert.equal(result.simplified.amount,null);
  assert.equal(result.special2.amount,null);
  assert.match(result.errors.join(' '),/個別確認/);
});

test('⑤ 開始・終了直後の明示1％返品は元取引日と元税率に基づく', () => {
  for(const date of ['2027-04-01','2029-04-01']){
    const result = engine.assessCsvOnePercentEntry({date,transactionKind:'adjustment',originalRatePercent:1,originalDate:'2027-04-01'});
    assert.equal(result.status,'confirmed');
  }
  assert.equal(engine.assessCsvOnePercentEntry({date:'2029-04-01',transactionKind:'adjustment',originalRatePercent:1,originalDate:'2027-03-31'}).status,'unknown');
  assert.equal(engine.assessCsvOnePercentEntry({date:'2029-04-01',transactionKind:'adjustment',originalRatePercent:8,originalDate:'2027-03-31'}).status,'unknown');
});

test('⑤ 区分11は返還方向へ一度だけ反転し、負入力の返還取消と元行を保持する', () => {
  for(const amount of ['108000','-108000']){
    const rows = [{code:'11',amount,rate:'8',businessType:'type2',foodAmount:amount}];
    const before = structuredClone(rows);
    const result = rowsApi.aggregateTaxRows({sales:rows});
    assert.equal(result.fields.type2Sale8.value,-Number(amount));
    assert.equal(result.fields.type2SaleFood1.value,-Number(amount));
    assert.deepEqual(result.forecastFoodFields,{});
    assert.equal(result.forecastFoodReasons.length,1);
    assert.deepEqual(rows,before);
  }
});

test('⑤ 食品予測用内数は正の通常取引に限定し、旧保存の差引内数と混同しない', () => {
  const result = rowsApi.aggregateTaxRows({sales:[
    {code:'1',amount:'216000',rate:'8',businessType:'type2',foodAmount:'216000'},
    {code:'11',amount:'108000',rate:'8',businessType:'type2',foodAmount:'108000'}]});
  assert.equal(result.fields.type2SaleFood1.value,108000);
  assert.equal(result.forecastFoodFields.type2SaleFood1.value,216000);
});

test('④⑤ 月別対象額callbackは対象期間割合を再適用せず、返品へ呼び出さない', () => {
  let calls = 0;
  const result = rowsApi.aggregateScenarioPurchases({purchases:[
    {code:'5',amount:'216000',rate:'8',foodAmount:'216000'},
    {code:'5',amount:'-108000',rate:'8',foodAmount:'-108000'}]},
  {taxScenario:'foodProposal',foodForecastMethod:'uniform',proposalFraction:.25,
    foodPeriodAmount:(_row,value) => {calls++; return value / 2;}});
  assert.equal(calls,1);
  // First row: 108000 old 8% + 101000 new 1%; second: -108000 old8%.
  assert.equal(result.invoiceTotalAmount,101000);
  assert.equal(result.invoiceTax,1000);
});


test('元8％返品と1％売上が混在した一般課税は売上税額の負号を保持する',()=>{
  const api=require('../tax-engine.js');
  // 216000 / 1.08 * 1% = 2000, old return108000 *8/108 =8000.
  const result=api.calculateDetailedRegular({salesTax:-6000,purchaseTax:0,adjustment:0,taxableSales:100000,totalSales:100000,periodMonths:12,method:'auto'});
  assert.equal(result.fullCreditEligible,true);assert.equal(result.amount,-6000);
  const positive=api.calculateDetailedRegular({salesTax:6000,purchaseTax:0,taxableSales:100000,totalSales:100000,periodMonths:12,method:'auto'});
  assert.equal(positive.amount,6000);
});


test('税込純額が正でも元8％仕入返品で負になる全額控除を0円へ切り上げない',()=>{
  const E=require('../tax-engine.js');
  const full=E.calculateDetailedRegular({salesTax:10000,purchaseTax:-6000,taxableSales:100000,totalSales:100000,periodMonths:12,method:'auto'});
  assert.equal(full.regularCredit,-6000);assert.equal(full.amount,16000);
  const partial=E.calculateDetailedRegular({salesTax:10000,purchaseTax:-6000,taxableSales:100000,totalSales:200000,periodMonths:12,method:'individual',taxableOnlyTax:-6000,commonTax:0});
  assert.equal(partial.amount,16000);assert.equal(partial.regularCredit,-6000);assert.match(partial.assumptions.join(''),/符号付き/);
});
