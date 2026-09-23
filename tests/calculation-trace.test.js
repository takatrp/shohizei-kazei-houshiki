'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../tax-engine.js');
const switchDecision = require('../switch-decision.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function functionSource(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

function traceHarness(){
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)) elements.set(id, { innerHTML:'', style:{}, classList:{ toggle(){} }, querySelectorAll(){ return []; }, querySelector(){ return null; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    $:element,
    document:{ activeElement:null, querySelectorAll(){ return []; } },
    yen:value => `${Math.round(value).toLocaleString('ja-JP')}円`,
    escapeHtml:value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[char])),
    amountClass:() => '',
    renderComparisonPrint(){},
    METHOD_LABELS:{ regular:'一般課税（本則課税）', simplified:'簡易課税', special2:'２割特例', special3:'３割特例' },
    ELIGIBILITY:engine.ELIGIBILITY,
    FOOD_PROPOSAL:engine.FOOD_PROPOSAL,
    proposalOverlapFraction:() => 1,
    inclusiveDayCount:() => 365,
    csvReviewNotice:review => review?.reviewItems?.length ? '元取引税率は未確認・入力税率を仮定した参考値' : ''
  });
  const names = [
    'normalizeCsvRecovery', 'csvRecoverySummaryText',
    'traceNumber', 'traceMoney', 'tracePercent', 'traceDisplayNote', 'traceLine', 'traceTaxLine', 'traceFoodRows', 'traceRounding',
    'renderCalculationTrace', 'renderMethodCards', 'renderSwitchBreakdown'
  ];
  vm.runInContext(names.map(functionSource).join('\n'), context);
  return { context, element };
}

function saleRow({ key='type2', name='第２種', deemed=.8, amount10=0, amount8=0, amountFood1=0, foodOnePercentTax=0, foodOnePercentTaxableBase=0 }){
  const tax10 = amount10 * .1;
  const tax8 = amount8 * .08;
  const taxFood1 = amountFood1 * .01;
  return {
    key, name, deemed, amount10, amount8, amountFood1,
    originalAmount8:amount8 + amountFood1, foodInputAmount:amountFood1,
    foodOneOriginalAmount:amountFood1, forecastFood1:amountFood1,
    forecastFood1Tax:taxFood1, actualOneGross:0, actualFood1:0, actualFood1Tax:0,
    taxableBase10:amount10, taxableBase8:amount8, taxableBaseFood1:amountFood1,
    tax10, tax8, taxFood1, rowTax:tax10 + tax8 + taxFood1,
    rowTaxableBase:amount10 + amount8 + amountFood1,
    rowAmount:amount10 + amount8 + amountFood1,
    foodOnePercentTax:foodOnePercentTax || taxFood1,
    foodOnePercentTaxableBase:foodOnePercentTaxableBase || amountFood1,
    entered:true
  };
}

function baseCalc({ amountMode='included', taxScenario='current', rows, purchases, regular, methods }){
  const totalTax = rows.reduce((sum, row) => sum + row.rowTax, 0);
  const totalAmount = rows.reduce((sum, row) => sum + row.rowAmount, 0);
  const totalTaxableBase = rows.reduce((sum, row) => sum + row.rowTaxableBase, 0);
  const simplified = engine.calculateSimplifiedTax(rows);
  const special2Base = engine.calculateSpecialMethodAmount({ totalSalesTax:totalTax,
    foodOnePercentTax:simplified.foodOnePercentTax, burdenRatio:.2 });
  const special3Base = engine.calculateSpecialMethodAmount({ totalSalesTax:totalTax,
    foodOnePercentTax:simplified.foodOnePercentTax, burdenRatio:.3 });
  return {
    ctx:{ start:'2027-01-01', end:'2027-12-31', amountMode, taxScenario, advancedMode:false,
      taxScenarioLabel:taxScenario === 'current' ? '現行税率' : '食品1％案', creditMode:'confirmed',
      foodForecastMethod:'manual', foodSalesPriceBasis:'netFixed', foodPurchasePriceBasis:'netFixed' },
    sales:{ rows, totalTax, totalAmount, totalTaxableBase, simplified, anyEntered:true, errors:[] },
    purchases:purchases || { amount10:0, amount8:0, amountFood1:0, originalAmount8:0,
      foodInputAmount:0, actualOneGross:0, tax10:0, tax8:0, taxFood1:0,
      invoiceTax:0, exemptCreditableTax:0, exemptBuckets:[], creditRatio:1,
      adjustment:0, adjustmentEntered:false, errors:[] },
    regular:regular || { amount:totalTax, regularCredit:0, appliedMethod:'estimate', taxableSalesRatio:null },
    special2Base, special3Base,
    creditablePurchaseTax:(purchases?.invoiceTax || 0) + (purchases?.exemptCreditableTax || 0),
    methods:methods || [], comparisonReady:true, csvReview:{ reviewItems:[] }, inputErrors:[], unconfirmedItems:[]
  };
}

function regularCase(mode='included', adjustment=0){
  const gross = mode === 'included';
  const saleAmount = gross ? 11000000 : 10000000;
  const purchaseAmount = gross ? 6600000 : 6000000;
  const salesTax = engine.taxFromAmount(saleAmount, 10, mode);
  const purchaseTax = engine.taxFromAmount(purchaseAmount, 10, mode);
  const regular = { ...engine.calculateRegularAmount({ salesTax, invoiceTax:purchaseTax,
    exemptCreditableTax:0, creditRatio:1, adjustment }),
    appliedMethod:'estimate', taxableSalesRatio:null };
  const row = saleRow({ amount10:10000000 });
  row.amount10 = saleAmount;
  row.rowAmount = saleAmount;
  row.tax10 = salesTax;
  row.rowTax = salesTax;
  row.taxableBase10 = 10000000;
  row.rowTaxableBase = 10000000;
  const purchases = { amount10:purchaseAmount, amount8:0, amountFood1:0,
    originalAmount8:0, foodInputAmount:0, actualOneGross:0,
    tax10:purchaseTax, tax8:0, taxFood1:0, invoiceTax:purchaseTax,
    exemptCreditableTax:0, exemptBuckets:[], creditRatio:1,
    adjustment, adjustmentEntered:adjustment !== 0, errors:[] };
  const calc = baseCalc({ amountMode:mode, rows:[row], purchases, regular });
  const method = { key:'regular', amount:regular.amount, eligibility:engine.ELIGIBILITY.ELIGIBLE,
    status:'確認済み候補', calculationMethod:'仕入控除率 100％', reason:'', reasons:[] };
  calc.methods = [method];
  calc.regularCredit = regular.regularCredit;
  return { calc, method };
}

test('[P01][P03][P04] 方式表の任意の詳細は同じ入力額・税額・納付見込を示す', () => {
  const h = traceHarness();
  for(const mode of ['included','excluded']){
    const { calc, method } = regularCase(mode);
    const process = h.context.renderCalculationTrace(calc, method);
    assert.match(process, /11,000,000円|10,000,000円/);
    assert.match(process, /6,600,000円|6,000,000円/);
    assert.match(process, /1,000,000円/);
    assert.match(process, /600,000円/);
    assert.match(process, /400,000円/);
    assert.match(process, mode === 'included' ? /税込/ : /税抜/);
    assert.match(process, /10％|10%/);
    h.context.renderMethodCards(calc);
    const cards = h.element('methodCards').innerHTML;
    assert.match(cards, /計算過程を見る/);
    assert.match(cards, /400,000円/);
    assert.doesNotMatch(cards, /<details[^>]*\sopen(?:\s|=|>)/);
  }
});

test('[P05][P14] 負の計算額は負数の式と還付見込の表示を両立する', () => {
  const h = traceHarness();
  const { calc, method } = regularCase('included', -500000);
  method.amount = calc.regular.amount;
  assert.equal(method.amount, -100000);
  const process = h.context.renderCalculationTrace(calc, method);
  assert.match(process, /-100,000円|−100,000円/);
  h.context.renderMethodCards(calc);
  assert.match(h.element('methodCards').innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), /還付見込 100,000円|還付見込 -100,000円/);
});

test('[P05] 明示0円売上と課税仕入だけの案件は還付100,000円を示す', () => {
  const h = traceHarness();
  const { calc, method } = regularCase();
  const row = calc.sales.rows[0];
  Object.assign(row, { amount10:0, taxableBase10:0, tax10:0, rowAmount:0, rowTaxableBase:0, rowTax:0 });
  Object.assign(calc.sales, { totalAmount:0, totalTaxableBase:0, totalTax:0, anyEntered:true });
  Object.assign(calc.purchases, { amount10:1100000, tax10:100000, invoiceTax:100000 });
  calc.regular = { ...engine.calculateRegularAmount({ salesTax:0, invoiceTax:100000,
    exemptCreditableTax:0, creditRatio:1, adjustment:0 }), appliedMethod:'estimate', taxableSalesRatio:null };
  calc.regularCredit = calc.regular.regularCredit;
  method.amount = calc.regular.amount;
  assert.equal(method.amount, -100000);
  const process = h.context.renderCalculationTrace(calc, method);
  assert.match(process, /1,100,000円/);
  assert.match(process, /100,000円/);
  assert.match(process, /-100,000円|−100,000円/);
  h.context.renderMethodCards(calc);
  assert.match(h.element('methodCards').innerHTML, /還付見込/);
});

test('[P18] 再計算結果を描画すると古い式と金額を残さない', () => {
  const h = traceHarness();
  const before = regularCase();
  h.context.renderMethodCards(before.calc);
  assert.match(h.element('methodCards').innerHTML, /400,000円/);
  const after = regularCase('included', 100000);
  h.context.renderMethodCards(after.calc);
  const latest = h.element('methodCards').innerHTML;
  assert.match(latest, /500,000円/);
  assert.doesNotMatch(latest, /400,000円/);
});

test('[P02] 開いた方式だけを再描画後も開き、summaryのフォーカスを戻す', () => {
  const h = traceHarness();
  const { calc } = regularCase();
  const priorDetail = { open:true, dataset:{ method:'regular' } };
  let focusCount = 0;
  h.context.document.querySelectorAll = () => [priorDetail];
  h.context.document.activeElement = { closest:() => priorDetail };
  h.element('methodCards').querySelector = () => ({ focus(){ focusCount++; } });
  h.context.renderMethodCards(calc);
  assert.match(h.element('methodCards').innerHTML, /data-method="regular" open/);
  assert.equal(focusCount, 1);
  priorDetail.open = false;
  h.context.document.activeElement = null;
  h.context.renderMethodCards(calc);
  assert.doesNotMatch(h.element('methodCards').innerHTML, /data-method="regular" open/);
  assert.equal(focusCount, 1);
});

test('[P06] 免税事業者等仕入の経過措置を税率別に適用してから概算控除する', () => {
  const h = traceHarness();
  const { calc, method } = regularCase();
  const buckets = [
    { label:'70％対象', ratio:.7, amount10:1100000, amount8:0, rowAmount:1100000,
      tax10:100000, tax8:0, rowTax:100000, rowCreditableTax:70000 },
    { label:'50％対象', ratio:.5, amount10:0, amount8:108000, rowAmount:108000,
      tax10:0, tax8:8000, rowTax:8000, rowCreditableTax:4000 }
  ];
  calc.purchases.exemptBuckets = buckets;
  calc.purchases.exemptCreditableTax = 74000;
  calc.creditablePurchaseTax = 674000;
  calc.regular = { ...engine.calculateRegularAmount({ salesTax:1000000, invoiceTax:600000,
    exemptCreditableTax:74000, creditRatio:1, adjustment:0 }), appliedMethod:'estimate', taxableSalesRatio:null };
  method.amount = calc.regular.amount;
  assert.equal(method.amount, 326000);
  const process = h.context.renderCalculationTrace(calc, method);
  assert.match(process, /100,000円 × 経過措置70％ [＝≒] 70,000円/);
  assert.match(process, /8,000円 × 経過措置50％ [＝≒] 4,000円/);
  assert.match(process, /600,000円 ＋ 経過措置後 74,000円 [＝≒] 674,000円/);
  assert.match(process, /674,000円 × 100％ [＝≒] 674,000円/);
  assert.match(process, /326,000円/);
});

test('[P07] 詳細計算は入力希望ではなく実際の全額・個別・比例の採用経路を示す', () => {
  const h = traceHarness();
  const { calc, method } = regularCase();
  Object.assign(calc.ctx, { advancedMode:true, regularDetailMethod:'individual',
    taxableOnlyPurchaseTax:100000, commonPurchaseTax:200000,
    taxableOnlyPurchaseTaxEntered:true, commonPurchaseTaxEntered:true });
  const base = { salesTax:1000000, purchaseTax:600000, adjustment:0,
    taxableSales:10000000, totalSales:20000000, periodMonths:12,
    taxableOnlyTax:100000, commonTax:200000 };
  calc.regular = engine.calculateDetailedRegular({ ...base, method:'individual' });
  method.amount = calc.regular.amount;
  let process = h.context.renderCalculationTrace(calc, method);
  assert.equal(method.amount, 800000);
  assert.match(process, /採用：個別対応方式/);
  assert.match(process, /100,000円 ＋ 共通対応 200,000円 × 50％ [＝≒] 200,000円/);
  assert.doesNotMatch(process, /採用：一括比例配分方式/);

  calc.ctx.regularDetailMethod = 'proportional';
  calc.regular = engine.calculateDetailedRegular({ ...base, method:'proportional' });
  method.amount = calc.regular.amount;
  process = h.context.renderCalculationTrace(calc, method);
  assert.equal(method.amount, 700000);
  assert.match(process, /採用：一括比例配分方式/);
  assert.doesNotMatch(process, /採用：個別対応方式/);

  calc.ctx.regularDetailMethod = 'individual';
  calc.regular = engine.calculateDetailedRegular({ ...base, totalSales:10000000, method:'individual' });
  method.amount = calc.regular.amount;
  process = h.context.renderCalculationTrace(calc, method);
  assert.equal(method.amount, 400000);
  assert.match(process, /採用：全額控除/);
  assert.doesNotMatch(process, /採用：個別対応方式/);
});

test('[P07][P17] 100％仮定とCSV返品の元取引未確認を計算過程にも残す', () => {
  const h = traceHarness();
  const { calc, method } = regularCase();
  calc.ctx.creditMode = 'unknown';
  calc.csvReview.reviewItems = [{ reason:'元取引の日付・税率を確認', amount:1010 }];
  const process = h.context.renderCalculationTrace(calc, method);
  assert.match(process, /100％は仮定・未確認/);
  assert.match(process, /元取引税率は未確認/);
  assert.match(process, /参考試算/);
  h.context.renderMethodCards(calc);
  assert.match(h.element('methodCards').innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), /参考 400,000円/);
});

test('[P08][P09][P10] 簡易課税の食品控除・75％判定・採用候補を実データから説明する', () => {
  const h = traceHarness();
  const cases = [
    {
      rows:[
        saleRow({ amountFood1:25000000 }),
        saleRow({ key:'type5', name:'第５種', deemed:.5, amount10:5000000 }),
        saleRow({ key:'type4', name:'第４種', deemed:.6, amount10:3000000 })
      ], amount:370000, denominator:'8,000,000円', selected:'通常'
    },
    {
      rows:[
        saleRow({ amountFood1:20000000, amount10:3000000 }),
        saleRow({ key:'type4', name:'第４種', deemed:.6, amount10:1000000 })
      ], amount:80000, denominator:'4,000,000円', selected:'75％'
    },
    {
      rows:[
        saleRow({ amount10:4000000 }),
        saleRow({ key:'type4', name:'第４種', deemed:.6, amount10:3000000 }),
        saleRow({ key:'type5', name:'第５種', deemed:.5, amount10:1000000 })
      ], amount:240000, denominator:'8,000,000円', selected:'75％'
    }
  ];
  for(const sample of cases){
    const calc = baseCalc({ taxScenario:'foodProposal', amountMode:'excluded', rows:sample.rows });
    const method = { key:'simplified', amount:calc.sales.simplified.amount,
      eligibility:engine.ELIGIBILITY.ELIGIBLE, status:'確認済み候補', calculationMethod:calc.sales.simplified.methodLabel, reason:'' };
    calc.methods = [method];
    assert.equal(method.amount, sample.amount);
    const process = h.context.renderCalculationTrace(calc, method);
    assert.match(process, new RegExp(sample.amount.toLocaleString('ja-JP') + '円'));
    assert.match(process, new RegExp(sample.denominator));
    assert.match(process, new RegExp(sample.selected));
    if(sample.amount === 80000){
      assert.match(process, /3,000,000円/);
      assert.match(process, /100,000円/);
      assert.match(process, /80,000円/);
      assert.doesNotMatch(process, /売上税額 300,000円 × みなし仕入率/);
    }
    if(sample.amount === 240000){
      assert.match(process, /第２種/);
      assert.match(process, /第４種/);
      assert.match(process, /２事業|2事業|２区分|2区分/);
    }
  }
});

test('[P11] ２割・３割は１％食品税額を除いた売上税額に適用する', () => {
  const h = traceHarness();
  const calc = baseCalc({ taxScenario:'foodProposal', amountMode:'excluded', rows:[
    saleRow({ amountFood1:25000000 }),
    saleRow({ key:'type5', name:'第５種', deemed:.5, amount10:5000000 }),
    saleRow({ key:'type4', name:'第４種', deemed:.6, amount10:3000000 })
  ] });
  for(const [key, ratio, expected] of [['special2',.2,160000],['special3',.3,240000]]){
    const computed = engine.calculateSpecialMethodAmount({ totalSalesTax:calc.sales.totalTax,
      foodOnePercentTax:calc.sales.simplified.foodOnePercentTax, burdenRatio:ratio });
    assert.equal(computed.amount, expected);
    const method = { key, amount:computed.amount, eligibility:engine.ELIGIBILITY.ELIGIBLE,
      status:'確認済み候補', calculationMethod:'', reason:'' };
    const process = h.context.renderCalculationTrace(calc, method);
    assert.match(process, /1,050,000円/);
    assert.match(process, /250,000円/);
    assert.match(process, /800,000円/);
    assert.match(process, new RegExp(expected.toLocaleString('ja-JP') + '円'));
  }
});

test('[P12] 食品予測の日数配分と手入力期間額を分け、価格前提を数値で示す', () => {
  const h = traceHarness();
  const originalGross = 1080000;
  const allocatedGross = originalGross * 100 / 365;
  const forecastGross = allocatedGross / 1.08 * 1.01;
  const row = {
    name:'第２種', originalAmount8:originalGross, foodInputAmount:originalGross,
    foodOneOriginalAmount:allocatedGross, amount8:originalGross - allocatedGross,
    forecastFood1:forecastGross, forecastFood1Tax:engine.taxFromAmount(forecastGross, 1, 'included')
  };
  const ctx = { start:'2027-01-01', end:'2027-12-31', taxScenario:'foodProposal',
    amountMode:'included', foodForecastMethod:'uniform', foodSalesPriceBasis:'netFixed' };
  h.context.proposalOverlapFraction = () => 100 / 365;
  let process = h.context.traceFoodRows(ctx, 'sale', [row]);
  assert.match(process, /1,080,000円/);
  assert.match(process, /100日 ÷ 365日/);
  assert.match(process, /税抜価格据置/);
  assert.match(process, /税込1％/);
  ctx.foodForecastMethod = 'manual';
  row.foodOneOriginalAmount = originalGross;
  row.amount8 = 0;
  row.forecastFood1 = 1010000;
  row.forecastFood1Tax = 10000;
  process = h.context.traceFoodRows(ctx, 'sale', [row]);
  assert.match(process, /対象期間分を手入力/);
  assert.doesNotMatch(process, /日数配分.*100日/);
  ctx.foodSalesPriceBasis = 'grossFixed';
  process = h.context.traceFoodRows(ctx, 'sale', [row]);
  assert.match(process, /税込価格据置/);
});

test('[P13] CSV明示1％は税込実績からの換算として予測と別行で示す', () => {
  const h = traceHarness();
  const ctx = { start:'2027-01-01', end:'2027-12-31', taxScenario:'foodProposal',
    amountMode:'excluded', foodForecastMethod:'manual', foodSalesPriceBasis:'netFixed', foodPurchasePriceBasis:'netFixed' };
  const salesRow = {
    name:'第２種', originalAmount8:1080000, foodInputAmount:1080000,
    foodOneOriginalAmount:1080000, amount8:0, forecastFood1:1010000,
    forecastFood1Tax:10000, actualOneGross:1010000, actualFood1:1000000, actualFood1Tax:10000
  };
  const process = h.context.traceFoodRows(ctx, 'sale', [salesRow]);
  assert.match(process, /予測（税抜価格据置）/);
  assert.match(process, /CSV明示1％実績/);
  assert.match(process, /1,010,000円（CSV税込額） ÷ 1\.01 [＝≒] 1,000,000円/);
  assert.match(process, /1,010,000円 × 1 ÷ 101 [＝≒] 10,000円/);
  const purchase = h.context.traceFoodRows(ctx, 'purchase', [{
    actualOneGross:505000, actualFood1:500000, actualFood1Tax:5000
  }]);
  assert.match(purchase, /505,000円 × 1 ÷ 101 [＝≒] 5,000円/);
  assert.doesNotMatch(purchase, /1\.08/);
});

test('[P14] 申告書段階の端数処理は実際の国税・地方税中間値と最終額を示す', () => {
  const h = traceHarness();
  const nationalSales = engine.calculateNationalSalesTax({ taxableBase10:10001234, taxableBaseReduced:0 });
  const nationalCredit = 300123;
  const declaration = engine.calculateDeclarationAmount({ nationalSalesTax:nationalSales.total,
    nationalCredit, nationalAdjustment:0 });
  const calc = { ctx:{ taxScenario:'current', declarationRounding:true },
    sales:{ rows:[{ taxableBase10:10001234, taxableBase8:0 }] },
    regularCredit:nationalCredit / .78, purchases:{ adjustment:0 },
    roundingDetails:{ regular:{ nationalSales, nationalCredit, nationalAdjustment:0, declaration } } };
  const process = h.context.traceRounding(calc, { key:'regular', amount:declaration.total });
  assert.match(process, /内部値.*1,000円未満切捨て.*10,001,000円/);
  assert.match(process, new RegExp(declaration.nationalAmount.toLocaleString('ja-JP') + '円'));
  assert.match(process, /× 22 ÷ 78/);
  assert.doesNotMatch(process, /\d\.\d+円/);
  assert.match(process, new RegExp(declaration.localAmount.toLocaleString('ja-JP') + '円'));
  assert.match(process, new RegExp(declaration.total.toLocaleString('ja-JP') + '円'));
  const proposal = h.context.traceRounding({ ctx:{ taxScenario:'foodProposal', declarationRounding:true } },
    { key:'regular', amount:declaration.total });
  assert.match(proposal, /未対応/);
});

test('[P17] 未算定と適用不可は内部の仮計算額を納付見込として出さない', () => {
  const h = traceHarness();
  const { calc, method } = regularCase();
  calc.comparisonReady = false;
  calc.inputErrors = ['10％売上: 数値として入力してください'];
  let process = h.context.renderCalculationTrace(calc, method);
  assert.match(process, /未算定/);
  assert.doesNotMatch(process, /400,000円/);
  h.context.renderMethodCards(calc);
  assert.match(h.element('methodCards').innerHTML, /未算定/);
  calc.comparisonReady = true;
  calc.inputErrors = [];
  method.eligibility = engine.ELIGIBILITY.INELIGIBLE;
  method.status = '適用不可';
  method.reasons = ['届出要件を満たしません'];
  process = h.context.renderCalculationTrace(calc, method);
  assert.match(process, /適用対象外/);
  assert.doesNotMatch(process, /納付見込\s*400,000円/);
  h.context.renderMethodCards(calc);
  assert.match(h.element('methodCards').innerHTML, /適用対象外/);
});

function costDecision({ creditState='unknown', creditAmount=0, creditIncludedInBTax=false,
  timeEvaluation='excluded', quoteValue=110000 } = {}){
  const quote = switchDecision.calculateQuotedCost({
    quote:{ entered:true, valid:Number.isFinite(quoteValue), value:quoteValue },
    taxBasis:'included', creditState,
    credit:{ entered:creditState === 'confirmed', valid:true, value:creditAmount },
    creditIncludedInBTax
  });
  const creditEntered = creditState !== 'unknown' || quote.grossSpend === 0;
  const economics = switchDecision.calculateCustomerEconomics({
    periods:[{ aTax:40000, bTax:-225000 }],
    additionalFee:{ entered:quote.grossSpend !== null, valid:quote.errors.length === 0,
      value:quote.grossSpend ?? 0 },
    otherCosts:{ entered:true, valid:true, value:0 },
    additionalCredit:{ entered:creditEntered, valid:true, value:creditAmount },
    creditIncludedInBTax,
    creditAssumption:creditState === 'unknown' && quote.grossSpend === 0 ? 'zeroFee'
      : creditState === 'none' ? 'noCredit' : 'confirmed',
    timeEvaluation,
    customerHours:{ entered:timeEvaluation === 'included', valid:true, value:2 },
    hourlyRate:{ entered:timeEvaluation === 'included', valid:true, value:3000 }
  });
  return { quote, economics };
}

test('[P15][P16] 追加支出差額は既存の税額差・費用・確認済み控除をつなぐ', () => {
  const h = traceHarness();
  const calc = { ctx:{ start:'2027-01-01', end:'2027-12-31' } };
  const unknown = costDecision();
  assert.equal(unknown.economics.cashBenefitBeforeCredit, 155000);
  assert.equal(unknown.economics.cashBenefit, null);
  let process = h.context.renderSwitchBreakdown(calc, unknown);
  for(const amount of ['40,000円','-225,000円','265,000円','110,000円','155,000円']){
    assert.match(process, new RegExp(amount));
  }
  assert.match(process, /未反映|未確認/);

  const confirmed = costDecision({ creditState:'confirmed', creditAmount:10000 });
  assert.equal(confirmed.economics.cashBenefitDisplay, 165000);
  process = h.context.renderSwitchBreakdown(calc, confirmed);
  assert.match(process, /10,000円/);
  assert.match(process, /165,000円/);

  const alreadyIncluded = costDecision({ creditState:'confirmed', creditAmount:10000, creditIncludedInBTax:true });
  assert.equal(alreadyIncluded.economics.cashBenefitDisplay, 155000);
  process = h.context.renderSwitchBreakdown(calc, alreadyIncluded);
  assert.match(process, /再加算なし|反映済み/);
  assert.match(process, /155,000円/);

  const withTime = costDecision({ creditState:'confirmed', creditAmount:10000, timeEvaluation:'included' });
  assert.equal(withTime.economics.timeCost, 6000);
  process = h.context.renderSwitchBreakdown(calc, withTime);
  assert.match(process, /2\s*時間|2\s*×/);
  assert.match(process, /3,000円/);
  assert.match(process, /6,000円/);
  assert.doesNotMatch(h.context.renderSwitchBreakdown(calc, confirmed), /6,000円/);

  const zeroFee = costDecision({ quoteValue:0 });
  process = h.context.renderSwitchBreakdown(calc, zeroFee);
  assert.match(process, /追加報酬0円のため控除調整なし/);
  assert.doesNotMatch(process, /B案に未反映の確認済み控除/);
  const noCredit = costDecision({ creditState:'none' });
  process = h.context.renderSwitchBreakdown(calc, noCredit);
  assert.match(process, /仕入控除なし・確認済み/);
});

test('[P16] 不正な追加報酬は0円費用として差額を組み立てない', () => {
  const h = traceHarness();
  const invalid = costDecision({ quoteValue:Number.NaN });
  assert.ok(invalid.quote.errors.length);
  const process = h.context.renderSwitchBreakdown({ ctx:{} }, invalid);
  assert.match(process, /未算定/);
  assert.doesNotMatch(process, /265,000円 − 税込追加報酬 0円/);
});

test('[P19] 計算過程は一般印刷から除外し顧客向け生成関数に渡さない', () => {
  const card = functionSource('renderMethodCards');
  assert.match(card, /no-print/);
  for(const name of ['buildSummaryText','buildCsvText','customerDecisionText','customerDecisionCsv','prepareCustomerPrint']){
    assert.doesNotMatch(functionSource(name), /renderCalculationTrace|renderSwitchBreakdown/);
  }
  assert.match(html, /@media print\{[\s\S]*?\.head-actions,\.no-print\{display:none!important\}/);
});

test('[端数01] 10％・8％・食品1％は分数を保持し金額だけ円単位で表示する', () => {
  const h = traceHarness();
  for(const [rate, divisor, expected] of [[10, 110, '90,909円'], [8, 108, '74,074円'], [1, 101, '9,901円']]){
    const amount = 1000000;
    const tax = engine.taxFromAmount(amount, rate, 'included');
    const line = h.context.traceTaxLine('税込売上', amount, rate, tax, 'included');
    assert.match(line, new RegExp(`1,000,000円 × ${rate} ÷ ${divisor} ≒ ${expected}`));
    assert.doesNotMatch(line, /\d\.\d+円/);
    assert.equal(h.context.traceMoney(tax), `${Math.round(tax).toLocaleString('ja-JP')}円`);
  }
});

test('[端数02] 未算定・負数・半端値・負のゼロをカードと同じ丸めで表示する', () => {
  const h = traceHarness();
  for(const value of [null, undefined, NaN, Infinity, -Infinity, '', '100', {}, false]){
    assert.equal(h.context.traceMoney(value), '未算定');
  }
  for(const value of [-1000.5, -1000.51, -0.5, -0.1, -0, 0, 0.5, 1000.5]){
    const rounded = Math.round(value);
    const money = `${(rounded === 0 ? 0 : rounded).toLocaleString('ja-JP')}円`;
    assert.equal(h.context.traceMoney(value), rounded < 0 ? `(${money})` : money);
  }
  assert.equal(h.context.traceMoney(-0.1), '0円');
  assert.equal(h.context.traceNumber(1.5), '1.5');
});

test('[端数03] 算出割合は2桁まで、75％・95％未満を丸めて境界到達と表示しない', () => {
  const h = traceHarness();
  assert.equal(h.context.tracePercent(81.23456789), '81.23％');
  assert.equal(h.context.tracePercent(94.999999, 95), '95％未満');
  assert.equal(h.context.tracePercent(74.999999, 75), '75％未満');
  assert.equal(h.context.tracePercent(95, 95), '95％');
  assert.equal(h.context.tracePercent(75, 75), '75％');
  assert.equal(h.context.tracePercent(null), '未確認');
  for(const rate of [6.24, .78]){
    const line = h.context.traceTaxLine('固定税率', 100000, rate, 1000, 'excluded');
    assert.match(line, new RegExp(String(rate).replace('.', '\\.') + ' ÷ 100'));
  }
});

test('[端数04] 丸めた内訳と合計が違っても注記と概算表現だけを加え内部値を変えない', () => {
  const h = traceHarness();
  const { calc, method } = regularCase();
  calc.sales.totalTax = 1.4;
  calc.purchases.invoiceTax = .8;
  calc.purchases.tax10 = .8;
  calc.creditablePurchaseTax = .8;
  calc.regular = { ...engine.calculateRegularAmount({ salesTax:1.4, invoiceTax:.8,
    exemptCreditableTax:0, creditRatio:1, adjustment:0 }), appliedMethod:'estimate', taxableSalesRatio:null };
  calc.regularCredit = calc.regular.regularCredit;
  method.amount = calc.regular.amount;
  assert.notEqual(Math.round(calc.sales.totalTax) - Math.round(calc.regularCredit), Math.round(method.amount));
  const before = JSON.stringify(calc);
  const process = h.context.renderCalculationTrace(calc, method);
  assert.equal(JSON.stringify(calc), before);
  assert.equal(process.split(h.context.traceDisplayNote()).length - 1, 1);
  assert.match(process, /1円 − 1円.*≒ 1円/);
  assert.doesNotMatch(process, /差額調整|\d\.\d+円/);
  assert.match(h.context.traceRounding(calc, method), /表示額.*1円/);
  assert.doesNotMatch(h.context.traceRounding(calc, method), /1円 → 1円/);
});

test('[端数05] 追加費用の端数と1.5時間は金額・数量を別精度で表示し状態を保持する', () => {
  const h = traceHarness();
  const decision = costDecision({ creditState:'confirmed', creditAmount:10000, timeEvaluation:'included', quoteValue:110001 });
  decision.economics.customerHours = 1.5;
  decision.economics.timeCost = 4500;
  const before = JSON.stringify(decision);
  const process = h.context.renderSwitchBreakdown({ ctx:{} }, decision);
  assert.match(process, /1\.5時間/);
  assert.match(process, /4,500円/);
  assert.doesNotMatch(process, /\d\.\d+円/);
  assert.equal(process.split(h.context.traceDisplayNote()).length - 1, 1);
  assert.equal(JSON.stringify(decision), before);
});
