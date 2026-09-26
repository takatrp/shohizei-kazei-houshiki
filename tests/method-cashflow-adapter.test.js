const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../method-cashflow-adapter.js');
const returnEngine = require('../tax-return-engine.js');
const interimTax = require('../interim-tax-engine.js');

function actualReturnInput(overrides = {}){
  return {taxableSalesGross:{'8':108000000,'10':0},salesReturnGross:{'8':0,'10':0},
    nonTaxableSales:0,invoiceByUse:{taxableOnly:{'8':75600000,'10':0},
      nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':0}},
    exemptByUse:{taxableOnly:{},nonTaxableOnly:{},common:{}},
    salesByType:{type2:{gross:{'8':108000000,'10':0},returns:{'8':0,'10':0}}},
    unsupportedCodes:[],unresolvedCount:0,temporaryExcludedCount:0,
    periodStart:'2028-01-01',periodEnd:'2028-12-31',periodMonths:12,...overrides};
}

function annualCalc(input = actualReturnInput(), options = {}){
  const regular = returnEngine.calculateCurrentLawReturn(input,'individual',options);
  const simplified = returnEngine.calculateCurrentLawSalesMethod(input,'simplified',{type2:0.8},options);
  return {ctx:{start:'2028-01-01',end:'2028-12-31',taxScenario:'current'},
    returnCalculation:regular,salesMethodCalculations:{simplified},
    methods:[{key:'regular',amount:regular.mainReturn?.totalBeforeInterim ?? null},
      {key:'simplified',amount:simplified.totalBeforeInterim ?? null}]};
}

function regularOnly(input){
  const regular=returnEngine.calculateCurrentLawReturn(input);
  return {ctx:{taxScenario:'current'},returnCalculation:regular,
    methods:[{key:'regular',amount:regular.mainReturn.totalBeforeInterim}]};
}

function interimPlan(national){
  return interimTax.plan({priorNationalTax:national,priorStart:'2027-01-01',priorEnd:'2027-12-31',
    currentStart:'2028-01-01',currentEnd:'2028-12-31',entityType:'corporation',
    periodShortening:'none',corporateExtension:'none',specialCircumstances:'none'});
}

test('R33-01 実申告書エンジンのmainReturnから一般課税国税を取り中間1回120万円へ接続',()=>{
  const calc=annualCalc();
  assert.equal(calc.returnCalculation.totalBeforeInterim,undefined,'本則のトップレベルに合計はない');
  assert.equal(calc.returnCalculation.mainReturn.totalBeforeInterim,2400000);
  const result=adapter.nationalTaxForMethod(calc,'regular');
  assert.deepEqual({calculable:result.calculable,national:result.national,local:result.local,
    total:result.totalBeforeInterim,precision:result.precision},
  {calculable:true,national:1872000,local:528000,total:2400000,precision:'申告書段階'});
  const interim=interimPlan(result.national);
  assert.equal(interim.status,'ready');
  assert.equal(interim.count,1);
  assert.equal(interim.totals.total,1200000);
});

test('R33-01 簡易課税はトップレベル国税124.8万円から中間80万円を維持',()=>{
  const calc=annualCalc();
  const result=adapter.nationalTaxForMethod(calc,'simplified');
  assert.equal(result.calculable,true);
  assert.equal(result.national,1248000);
  assert.equal(result.local,352000);
  assert.equal(result.totalBeforeInterim,1600000);
  const interim=interimPlan(result.national);
  assert.equal(interim.status,'ready');
  assert.equal(interim.count,1);
  assert.equal(interim.totals.total,800000);
});

test('R33-01 申告書段階の参考算定・0円・還付を数値状態と区別して保持',()=>{
  const reference=annualCalc(actualReturnInput({temporaryExcludedCount:1}),
    {allowTemporaryExcluded:true,provisionalReasons:['CSVの一部を仮除外']});
  const refResult=adapter.nationalTaxForMethod(reference,'regular');
  assert.equal(refResult.calculable,true);
  assert.equal(refResult.reference,true);
  assert.equal(refResult.precision,'申告書段階・参考算定');
  assert.match(refResult.reasons.join(' '),/仮除外/);
  const noSales=regularOnly(actualReturnInput({taxableSalesGross:{'8':0,'10':0},nonTaxableSales:1,
    invoiceByUse:{taxableOnly:{'8':0,'10':0},nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':0}},
    salesByType:{type2:{gross:{'8':0,'10':0},returns:{'8':0,'10':0}}}}));
  const zero=adapter.nationalTaxForMethod(noSales,'regular');
  assert.equal(zero.calculable,true);
  assert.equal(zero.national,0);
  const refund=regularOnly(actualReturnInput({invoiceByUse:{taxableOnly:{'8':129600000,'10':0},
    nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':0}}}));
  const negative=adapter.nationalTaxForMethod(refund,'regular');
  assert.equal(negative.calculable,true);
  assert.ok(negative.national < 0);
  assert.ok(negative.totalBeforeInterim < 0);
});

test('R33-01 国税内訳なし・STEP3不一致を合計×78％で代替しない',()=>{
  const calc=annualCalc();
  const withoutMain={...calc,returnCalculation:{referenceCalculable:true,exactComplete:true}};
  assert.equal(adapter.nationalTaxForMethod(withoutMain,'regular').calculable,false);
  const changed={...calc,methods:[{key:'regular',amount:2400100}]};
  assert.equal(adapter.nationalTaxForMethod(changed,'regular').calculable,false);
  const broken={...calc,returnCalculation:{...calc.returnCalculation,
    mainReturn:{...calc.returnCalculation.mainReturn,local:528100}}};
  assert.equal(adapter.nationalTaxForMethod(broken,'regular').calculable,false);
  const uncalculated=annualCalc(actualReturnInput({unresolvedCount:1}));
  assert.equal(adapter.nationalTaxForMethod(uncalculated,'regular').calculable,false);
  assert.equal(adapter.nationalTaxForMethod({...calc,ctx:{...calc.ctx,taxScenario:'foodProposal'}},'regular').calculable,false);
});

function fixture(overrides = {}){
  const ctx = {start:'2028-01-01',end:'2028-12-31',taxScenario:'foodProposal',
    foodSalesPriceBasis:'netFixed',foodPurchasePriceBasis:'netFixed'};
  const calc = {ctx,comparisonReady:true,methods:[
    {key:'simplified',amount:300000.49,eligibility:'eligible',reasons:[],reference:false,calculationMethod:'STEP3簡易課税'},
    {key:'regular',amount:100000.51,eligibility:'eligible',reasons:[],reference:false,calculationMethod:'STEP3一般課税'}
  ]};
  return {ctx,calc,baseKey:'simplified',changedKey:'regular',...overrides};
}

test('MC01/03 同じ食品1％シナリオのSTEP3方式別税額だけを受け取り、取引差を作らない', () => {
  const result = adapter.create(fixture());
  assert.equal(result.ready,true);
  assert.deepEqual({base:result.annualTax.base,changed:result.annualTax.changed},{base:300000,changed:100001});
  assert.deepEqual(result.annualTax.raw,{base:300000.49,changed:100000.51});
  assert.deepEqual(result.salesDeltas,[]);
  assert.deepEqual(result.purchaseDeltas,[]);
  assert.equal(result.annualSalesDelta,0);
  assert.equal(result.annualPurchaseDelta,0);
  assert.equal(result.plans.base.precision,'食品政策概算');
  assert.equal(result.distribution.used,'not-applicable');
});

test('MC02 現行制度では政策比較オブジェクトを要求せず申告書段階額を使用する', () => {
  const data = fixture();
  data.ctx.taxScenario = 'current';
  data.calc.salesMethodCalculations = {simplified:{referenceCalculable:true,exactComplete:true}};
  data.calc.returnCalculation = {referenceCalculable:true,exactComplete:true};
  data.calc.methods[0].amount = 300000;
  data.calc.methods[1].amount = 100000;
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.equal(result.scenario,'current');
  assert.equal(result.plans.base.precision,'申告書段階');
  assert.equal(result.plans.changed.precision,'申告書段階');
});

test('MC04/06 対象外・未選択・同じ方式を完成比較にしない', () => {
  const data = fixture();
  assert.equal(adapter.create({...data,changedKey:'simplified'}).ready,false);
  assert.equal(adapter.create({...data,changedKey:'special2'}).ready,false);
  data.calc.methods[1].eligibility = 'ineligible';
  assert.equal(adapter.create(data).ready,false);
  assert.match(adapter.create(data).reasons.join(' '),/適用対象外/);
});

test('MC06 適用未確認は金額算定と分け、参考のまま残す', () => {
  const data = fixture();
  data.calc.methods[1].eligibility = 'unknown';
  data.calc.methods[1].reasons = ['不適用届出の効力を確認'];
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.equal(result.annualTax.status,'reference');
  assert.equal(result.plans.changed.eligibility,'unknown');
  assert.match(result.assumptions.join(' '),/不適用届出/);
});

test('MC12 未算定・不正額を0円へ変換せず、参考グラフも完成させない', () => {
  for(const bad of [null,undefined,NaN,Infinity]){
    const data = fixture();
    data.calc.methods[1].amount = bad;
    const result = adapter.create(data);
    assert.equal(result.ready,false);
    assert.equal(result.annualTax.changed,null);
    assert.equal(result.plans.changed.amount,null);
  }
});

test('MC13 食品対象0円や食品期間外でも両案税額を0円へ強制しない', () => {
  const data = fixture();
  data.ctx.start = '2030-01-01';
  data.ctx.end = '2030-12-31';
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.equal(result.annualTax.base,300000);
  assert.equal(result.annualTax.changed,100001);
});

test('MC14 変更後スナップショットの額を使い、別時点のctxは混ぜない', () => {
  const data = fixture();
  data.calc.methods[0].amount = 500000;
  assert.equal(adapter.create(data).annualTax.base,500000);
  const stale = {...data.ctx,end:'2029-12-31'};
  const result = adapter.create({...data,ctx:stale});
  assert.equal(result.ready,false);
  assert.match(result.reasons.join(' '),/STEP3とSTEP4/);
});

test('MC15 旧税率変更アダプターのCSV月次・サイト要件を持ち込まない', () => {
  const data = fixture();
  data.calc.csvRecoveryText = 'CSVの2行を除外した参考試算';
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.match(result.assumptions.join(' '),/CSVの2行を除外/);
  assert.deepEqual(result.salesDeltas,[]);
  assert.deepEqual(result.purchaseDeltas,[]);
});
