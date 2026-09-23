'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../tax-engine.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

function harness(){
  const context = vm.createContext({
    calculateDetailedRegular:engine.calculateDetailedRegular,
    calculateRegularAmount:engine.calculateRegularAmount,
    ELIGIBILITY:engine.ELIGIBILITY,
    importedCsvRecovery:null,
    importedCsvOrigin:null,
    validateTaxPeriod:engine.validateTaxPeriod,
    assessCurrentMethodChoice:engine.assessCurrentMethodChoice,
    creditModeLabel:() => '旧概算率'
  });
  vm.runInContext(['normalizeCsvRecovery', 'csvRecoverySummaryText', 'periodMonthsForAnnualization', 'calculateRegularForContext',
    'detailedRegularEligibility', 'regularMethodLabel', 'csvOriginPremise', 'selectionEligibilityForCurrent', 'mergeCalculationAvailability'].map(source).join('\n'), context);
  return context;
}

function fixture(overrides = {}){
  return {
    ctx:{ start:'2027-01-01', end:'2027-12-31', advancedMode:false,
      regularDetailMethod:'proportional', nonTaxableSales:2000000,
      nonTaxableSalesEntered:true, nonTaxableSalesValid:true,
      taxableOnlyPurchaseTax:300000, commonPurchaseTax:200000,
      taxableOnlyPurchaseTaxEntered:true, commonPurchaseTaxEntered:true,
      taxableOnlyPurchaseTaxValid:true, commonPurchaseTaxValid:true,
      regularInputErrors:[], creditMode:'partial', creditPercent:12,
      baseSales:0, baseSalesEntered:true, ...overrides },
    sales:{ totalTax:800000, totalTaxableBase:8000000, anyEntered:true },
    purchases:{ invoiceTax:500000, exemptCreditableTax:100000,
      adjustment:10000, creditRatio:.12, errors:[] }
  };
}

test('[R03-R04] 詳細試算オフでも選択した本則方式が既存詳細エンジンと一致する', () => {
  const h = harness();
  for(const method of ['individual', 'proportional']){
    const { ctx, sales, purchases } = fixture({ regularDetailMethod:method });
    const result = h.calculateRegularForContext(ctx, sales, purchases);
    const expected = engine.calculateDetailedRegular({ salesTax:800000, purchaseTax:600000,
      adjustment:10000, method, taxableSales:8000000, totalSales:10000000,
      periodMonths:12, taxableOnlyTax:300000, commonTax:200000 });
    assert.equal(result.amount, expected.amount);
    assert.equal(result.regularCredit, expected.regularCredit);
    assert.equal(result.appliedMethod, method);
    assert.equal(result.taxableSalesRatio, .8);
    assert.equal(h.regularMethodLabel(ctx, result), method === 'individual' ? '個別対応方式' : '一括比例配分方式');
    assert.equal(result.amount, method === 'individual' ? 350000 : 330000);
    const advanced = h.calculateRegularForContext({ ...ctx, advancedMode:true }, sales, purchases);
    assert.deepEqual(JSON.parse(JSON.stringify(advanced)), JSON.parse(JSON.stringify(result)));
  }
});

test('[r23最終調整] 調整0円の表示例は個別340000円・比例320000円・全額200000円を維持する', () => {
  const h = harness();
  for(const [method, nonTaxableSales, expected, appliedMethod] of [
    ['individual', 2000000, 340000, 'individual'],
    ['proportional', 2000000, 320000, 'proportional'],
    ['auto', 0, 200000, 'full']
  ]){
    const { ctx, sales, purchases } = fixture({ regularDetailMethod:method, nonTaxableSales });
    purchases.adjustment = 0;
    const result = h.calculateRegularForContext(ctx, sales, purchases);
    assert.equal(result.amount, expected);
    assert.equal(result.appliedMethod, appliedMethod);
    assert.equal(sales.totalTax - result.regularCredit + purchases.adjustment, expected);
  }
});

test('[R05-R06] 5億円・95％の境界は当期売上で判定し、基準期間を使わない', () => {
  const h = harness();
  for(const [taxableSales, nonTaxableSales, expected] of [
    [500000000, 0, true], [500000001, 0, false],
    [95000000, 5000000, true], [94999999, 5000001, false]
  ]){
    const { ctx, sales, purchases } = fixture({ regularDetailMethod:'auto', nonTaxableSales });
    sales.totalTaxableBase = taxableSales;
    for(const baseSales of [1, 999999999]){
      const result = h.calculateRegularForContext({ ...ctx, baseSales, baseTaxableSales:baseSales }, sales, purchases);
      assert.equal(result.fullCreditEligible, expected, `${taxableSales}/${nonTaxableSales}`);
      const eligibility = h.detailedRegularEligibility(ctx, result, 600000);
      assert.equal(eligibility.eligibility, expected ? engine.ELIGIBILITY.ELIGIBLE : engine.ELIGIBILITY.UNKNOWN);
      if(expected) assert.equal(result.appliedMethod, 'full');
      else assert.match(eligibility.reasons.join(' '), /個別対応方式|一括比例配分方式/);
    }
  }
});

test('[R05] 1年未満の当期売上高は年換算して全額控除を判定する', () => {
  const h = harness();
  const { ctx, sales, purchases } = fixture({ regularDetailMethod:'auto',
    end:'2027-06-30', nonTaxableSales:0 });
  sales.totalTaxableBase = 250000000;
  let result = h.calculateRegularForContext(ctx, sales, purchases);
  assert.equal(result.periodMonths, 6);
  assert.equal(result.annualizedTaxableSales, 500000000);
  assert.equal(result.fullCreditEligible, true);
  sales.totalTaxableBase += 1;
  result = h.calculateRegularForContext(ctx, sales, purchases);
  assert.equal(result.fullCreditEligible, false);
});

test('[R07] 非課税売上等の空欄は明示0円と異なり確認済みにしない', () => {
  const h = harness();
  const { ctx, sales, purchases } = fixture({ regularDetailMethod:'auto', nonTaxableSales:0 });
  const valid = h.calculateRegularForContext(ctx, sales, purchases);
  assert.equal(h.detailedRegularEligibility(ctx, valid, 600000).eligibility, engine.ELIGIBILITY.ELIGIBLE);
  const blank = { ...ctx, nonTaxableSalesEntered:false };
  const missing = h.calculateRegularForContext(blank, sales, purchases);
  const eligibility = h.detailedRegularEligibility(blank, missing, 600000);
  assert.equal(eligibility.eligibility, engine.ELIGIBILITY.UNKNOWN);
  assert.match(eligibility.reasons.join(' '), /非課税売上/);
  assert.equal(missing.amount, null);
  assert.equal(missing.regularCredit, null);
  assert.equal(missing.fullCreditEligible, false);
});

test('[R08] 必要な個別内訳の不足と超過は未確認、比例では未使用内訳を要求しない', () => {
  const h = harness();
  const { ctx, sales, purchases } = fixture({ regularDetailMethod:'individual',
    taxableOnlyPurchaseTaxEntered:false, commonPurchaseTaxEntered:false });
  let result = h.calculateRegularForContext(ctx, sales, purchases);
  assert.equal(h.detailedRegularEligibility(ctx, result, 600000).eligibility, engine.ELIGIBILITY.UNKNOWN);
  const excessive = { ...ctx, taxableOnlyPurchaseTaxEntered:true, commonPurchaseTaxEntered:true,
    taxableOnlyPurchaseTax:600000, commonPurchaseTax:200000 };
  result = h.calculateRegularForContext(excessive, sales, purchases);
  assert.equal(h.detailedRegularEligibility(excessive, result, 600000).eligibility, engine.ELIGIBILITY.UNKNOWN);
  const proportional = { ...excessive, regularDetailMethod:'proportional',
    taxableOnlyPurchaseTaxEntered:false, commonPurchaseTaxEntered:false };
  result = h.calculateRegularForContext(proportional, sales, purchases);
  assert.equal(h.detailedRegularEligibility(proportional, result, 600000).eligibility, engine.ELIGIBILITY.ELIGIBLE);
  assert.equal(result.amount, 330000);
});

test('[R08-R09] 全額控除では内訳不要、方式切替も保存済み内訳を変更しない', () => {
  const h = harness();
  const { ctx, sales, purchases } = fixture({ regularDetailMethod:'individual',
    nonTaxableSales:0, taxableOnlyPurchaseTaxEntered:false, commonPurchaseTaxEntered:false });
  const snapshot = JSON.stringify({ ctx, sales, purchases });
  const result = h.calculateRegularForContext(ctx, sales, purchases);
  assert.equal(result.appliedMethod, 'full');
  assert.equal(result.amount, 210000);
  assert.equal(h.detailedRegularEligibility(ctx, result, 600000).eligibility, engine.ELIGIBILITY.ELIGIBLE);
  h.calculateRegularForContext({ ...ctx, regularDetailMethod:'proportional' }, sales, purchases);
  assert.equal(JSON.stringify({ ctx, sales, purchases }), snapshot);
});

test('[R09] 旧概算率は選択方式を上書きせず経過措置控除を二重適用しない', () => {
  const h = harness();
  const { ctx, sales, purchases } = fixture();
  const result = h.calculateRegularForContext(ctx, sales, purchases);
  const oldRateChanged = h.calculateRegularForContext({ ...ctx, creditMode:'confirmed', creditPercent:100 },
    sales, { ...purchases, creditRatio:1 });
  assert.equal(result.amount, oldRateChanged.amount);
  assert.equal(result.regularCredit, (500000 + 100000) * .8);
  const forecast = h.calculateRegularForContext(ctx, sales, purchases, 50000);
  assert.equal(forecast.regularCredit, (500000 + 50000) * .8);
});

test('[R07-R08] 本則の不正な必要入力を0円扱いせず未算定にする', () => {
  const h = harness();
  for(const invalid of [
    { nonTaxableSalesValid:false },
    { regularDetailMethod:'individual', taxableOnlyPurchaseTaxValid:false },
    { regularDetailMethod:'individual', commonPurchaseTaxValid:false }
  ]){
    const { ctx, sales, purchases } = fixture(invalid);
    const result = h.calculateRegularForContext(ctx, sales, purchases);
    assert.equal(result.amount, null);
    assert.equal(result.regularCredit, null);
    assert.equal(h.detailedRegularEligibility(ctx, result, 600000).eligibility, engine.ELIGIBILITY.UNKNOWN);
  }
});

test('[R10] 本則固有の不足は本則だけ未算定とし独立した簡易・特例の計算を維持する', () => {
  const h = harness();
  const { ctx, sales, purchases } = fixture({ nonTaxableSalesEntered:false, inputErrors:[] });
  sales.errors = [];
  sales.simplified = { amount:160000, deemedCredit:640000, foodOnePercentTax:0, methodLabel:'事業区分別計算' };
  Object.assign(h, {
    getContext:() => ctx, collectSales:() => sales, collectPurchases:() => purchases,
    getEligibility:() => Object.fromEntries(['regular', 'simplified', 'special2', 'special3'].map(key =>
      [key, { eligibility:engine.ELIGIBILITY.ELIGIBLE, reasons:[] }])),
    validateProposalClassification:() => [], validateImportedOnePercentEntries:() => ({ errors:[], reviewItems:[] }),
    assessHighAssetForMethod:() => ({ status:'notApplicable' }),
    declarationRoundedAmount:(_calc, _method, _credit, amount) => amount,
    calculateSpecialMethodAmount:engine.calculateSpecialMethodAmount,
    calcExemptCreditLabel:() => '経過措置適用済み', yen:value => `${value}円`,
    importedUnsupportedEntries:[], CONFIRMATION:engine.CONFIRMATION
  });
  vm.runInContext(source('calculate'), h);
  const result = h.calculate();
  assert.equal(result.comparisonReady, true);
  assert.equal(result.inputErrors.length, 0);
  const regular = result.methods.find(method => method.key === 'regular');
  assert.equal(regular.amount, null);
  assert.equal(regular.include, false);
  assert.equal(regular.eligibility, engine.ELIGIBILITY.UNKNOWN);
  assert.equal(result.methods.find(method => method.key === 'simplified').amount, 160000);
  assert.equal(result.methods.find(method => method.key === 'simplified').include, true);
  assert.equal(result.methods.find(method => method.key === 'special2').amount, 160000);
  assert.notEqual(result.best.key, 'regular');
});

test('[R01-R02-R08-R12] 本則設定は基本画面で展開し必要な用途別欄だけ表示する', () => {
  const h = harness();
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)){
      const classes = new Set();
      elements.set(id, { value:'', open:false, textContent:'',
        classList:{ toggle(name, on){ if(on) classes.add(name); else classes.delete(name); },
          contains:name => classes.has(name) } });
    }
    return elements.get(id);
  };
  const individualFields = [element('taxableOnlyPurchaseTax'), element('commonPurchaseTax')];
  Object.assign(h, { $:element, yen:value => `${value}円`, CONFIRMATION:engine.CONFIRMATION,
    document:{ querySelectorAll:selector => selector === '.detail-individual-field' ? individualFields : [] } });
  vm.runInContext(source('renderAdvancedMode'), h);
  const { ctx, sales, purchases } = fixture({ regularDetailMethod:'individual' });
  const calc = { ctx, sales, regular:h.calculateRegularForContext(ctx, sales, purchases) };
  element('currentReturnMethod').value = 'regular';
  individualFields[0].value = '300000';
  individualFields[1].value = '200000';
  h.renderAdvancedMode(calc);
  assert.equal(element('regularBasicSettings').open, true);
  assert.equal(element('advancedFields').classList.contains('is-hidden'), true);
  assert.equal(individualFields[0].classList.contains('is-hidden'), false);
  assert.match(element('regularBasisSummary').textContent, /8000000円.*80\.00％.*個別対応方式/);
  for(const changed of [{ regularDetailMethod:'proportional' }, { nonTaxableSales:0 }]){
    const changedCtx = { ...ctx, ...changed };
    h.renderAdvancedMode({ ...calc, ctx:changedCtx, regular:h.calculateRegularForContext(changedCtx, sales, purchases) });
    assert.equal(individualFields[0].classList.contains('is-hidden'), true);
    assert.equal(individualFields[1].classList.contains('is-hidden'), true);
    assert.equal(individualFields[0].value, '300000');
    assert.equal(individualFields[1].value, '200000');
  }
  element('currentReturnMethod').value = 'simplified';
  element('regularBasicSettings').open = false;
  h.renderAdvancedMode(calc);
  assert.equal(element('regularBasicSettings').open, false);
  assert.equal(element('regularBasicSettings').classList.contains('is-hidden'), false);
  element('regularBasicSettings').open = true;
  h.renderAdvancedMode(calc);
  assert.equal(element('regularBasicSettings').open, true);
  assert.equal(element('currentReturnMethod').value, 'simplified');
  h.renderAdvancedMode({ ...calc, sales:{ ...sales, anyEntered:false } });
  assert.match(element('regularBasisSummary').textContent, /入力後/);
  assert.doesNotMatch(element('regularBasisSummary').textContent, /全額控除|確認済み/);
});
