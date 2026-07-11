'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../tax-engine.js');
const release = require('../release-history.js');

const {
  CONFIRMATION,
  ELIGIBILITY,
  parseAmountInput,
  taxFromAmount,
  calculateRegularAmount,
  calculateSimplifiedTax,
  weightedExemptPurchaseRatio,
  calculateEligibility,
  sanitizeCsvCell,
  serializeStateIfEnabled
} = engine;

function saleRow(key, name, taxableBase, deemed, rate = 10){
  return {
    key,
    name,
    deemed,
    rowTaxableBase:taxableBase,
    rowTax:taxableBase * rate / 100
  };
}

function eligibilityContext(overrides = {}){
  return {
    start:'2026-01-01',
    end:'2026-12-31',
    entity:'individual',
    individualCalendarYear:true,
    invoiceRegistered:CONFIRMATION.YES,
    invoiceTransition:CONFIRMATION.YES,
    noSpecialExclusion:CONFIRMATION.YES,
    simpleNoticeReady:CONFIRMATION.YES,
    regularCreditConfirmed:CONFIRMATION.YES,
    baseSalesEntered:true,
    baseTaxableSales:0,
    specificInputEntered:true,
    specificSalesEntered:true,
    specificTaxableSales:0,
    specificPayrollEntered:false,
    specificPayrollAmount:0,
    specificUnder10m:true,
    ...overrides
  };
}

test('空欄と0円を区別する', () => {
  assert.deepEqual(parseAmountInput(''), { entered:false, valid:true, value:0, normalized:'', error:'' });
  const zero = parseAmountInput('0');
  assert.equal(zero.entered, true);
  assert.equal(zero.valid, true);
  assert.equal(zero.value, 0);
});

test('全角数字とカンマを正規化する', () => {
  const parsed = parseAmountInput('１２，３４５，６７８円');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.value, 12345678);
});

test('無効文字列と禁止された負数をエラーにする', () => {
  assert.equal(parseAmountInput('abc').valid, false);
  assert.equal(parseAmountInput('-1').valid, false);
  assert.equal(parseAmountInput('-1', { allowNegative:true }).valid, true);
});

test('売上0円・税抜仕入1,000万円は本則で100万円の還付試算となる', () => {
  const salesTax = taxFromAmount(0, 10, 'excluded');
  const purchaseTax = taxFromAmount(10000000, 10, 'excluded');
  const result = calculateRegularAmount({ salesTax, invoiceTax:purchaseTax, exemptCreditableTax:0, creditRatio:1, adjustment:0 });
  assert.equal(result.amount, -1000000);
});

test('1,000万円・5,000万円の金額境界を判定する', () => {
  assert.equal(calculateEligibility(eligibilityContext({ baseTaxableSales:9999999 })).special2.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(calculateEligibility(eligibilityContext({ baseTaxableSales:10000000 })).special2.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(calculateEligibility(eligibilityContext({ baseTaxableSales:10000001 })).special2.eligibility, ELIGIBILITY.INELIGIBLE);
  assert.equal(calculateEligibility(eligibilityContext({ baseTaxableSales:49999999 })).simplified.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(calculateEligibility(eligibilityContext({ baseTaxableSales:50000000 })).simplified.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(calculateEligibility(eligibilityContext({ baseTaxableSales:50000001 })).simplified.eligibility, ELIGIBILITY.INELIGIBLE);
});

test('本則控除率の入力境界を検証する', () => {
  assert.equal(parseAmountInput('94.9999', { min:0, max:100 }).valid, true);
  assert.equal(parseAmountInput('95.0000', { min:0, max:100 }).valid, true);
  assert.equal(parseAmountInput('100.0000', { min:0, max:100 }).valid, true);
  assert.equal(parseAmountInput('100.0001', { min:0, max:100 }).valid, false);
});

test('簡易課税の1事業75％特例を適用する', () => {
  const result = calculateSimplifiedTax([
    saleRow('type1', '第1種', 8000000, 0.90),
    saleRow('type6', '第6種', 2000000, 0.40)
  ]);
  assert.equal(result.normalCredit, 800000);
  assert.equal(result.deemedCredit, 900000);
  assert.equal(result.amount, 100000);
  assert.equal(result.method, 'single75');
});

test('簡易課税の2事業75％特例を適用する', () => {
  const result = calculateSimplifiedTax([
    saleRow('type1', '第1種', 4000000, 0.90),
    saleRow('type2', '第2種', 4000000, 0.80),
    saleRow('type6', '第6種', 2000000, 0.40)
  ]);
  assert.equal(result.normalCredit, 760000);
  assert.equal(result.deemedCredit, 840000);
  assert.equal(result.amount, 160000);
  assert.equal(result.method, 'pair75');
});

test('75％境界を正しく判定する', () => {
  const atBoundary = calculateSimplifiedTax([
    saleRow('type1', '第1種', 7500000, 0.90),
    saleRow('type6', '第6種', 2500000, 0.40)
  ]);
  const belowBoundary = calculateSimplifiedTax([
    saleRow('type1', '第1種', 7499990, 0.90),
    saleRow('type6', '第6種', 2500010, 0.40)
  ]);
  assert.equal(atBoundary.method, 'single75');
  assert.equal(belowBoundary.method, 'normal');
});

test('2割特例の期間境界を判定する', () => {
  assert.equal(calculateEligibility(eligibilityContext()).special2.eligibility, ELIGIBILITY.ELIGIBLE);
  const after = calculateEligibility(eligibilityContext({ start:'2026-10-01', end:'2027-09-30', entity:'corporation' }));
  assert.equal(after.special2.eligibility, ELIGIBILITY.INELIGIBLE);
});

test('3割特例は個人のみ候補となる', () => {
  const individual = calculateEligibility(eligibilityContext({ start:'2027-01-01', end:'2027-12-31' }));
  const corporation = calculateEligibility(eligibilityContext({ start:'2027-04-01', end:'2028-03-31', entity:'corporation' }));
  assert.equal(individual.special3.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(corporation.special3.eligibility, ELIGIBILITY.INELIGIBLE);
});

test('三値の未確認を要確認として返す', () => {
  const result = calculateEligibility(eligibilityContext({ invoiceRegistered:CONFIRMATION.UNKNOWN }));
  assert.equal(result.special2.eligibility, ELIGIBILITY.UNKNOWN);
  assert.match(result.special2.reasons.join(' '), /未確認/);
});

test('基準期間売上高0円と特定期間売上高0円を入力済みとして扱う', () => {
  const result = calculateEligibility(eligibilityContext({ baseTaxableSales:0, specificTaxableSales:0 }));
  assert.equal(result.special2.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(result.simplified.eligibility, ELIGIBILITY.ELIGIBLE);
});

test('免税仕入控除率を期間内の日数で按分する', () => {
  const result = weightedExemptPurchaseRatio('2026-04-01', '2027-03-31');
  assert.equal(result.valid, true);
  assert.equal(result.totalDays, 365);
  assert.equal(result.breakdown[0].days, 183);
  assert.equal(result.breakdown[1].days, 182);
  assert.ok(Math.abs(result.ratio - 0.7501369863013699) < 1e-12);
  assert.equal(Math.round(1000000 * result.ratio), 750137);
});

test('免税仕入控除率の日付境界を判定する', () => {
  const boundaries = [
    ['2023-09-30', 1], ['2023-10-01', .8],
    ['2026-09-30', .8], ['2026-10-01', .7],
    ['2028-09-30', .7], ['2028-10-01', .5],
    ['2030-09-30', .5], ['2030-10-01', .3],
    ['2031-09-30', .3], ['2031-10-01', 0]
  ];
  boundaries.forEach(([date, ratio]) => {
    assert.equal(weightedExemptPurchaseRatio(date, date).ratio, ratio);
  });
});

test('保存オフでは保存データを生成しない', () => {
  assert.equal(serializeStateIfEnabled(false, { amount:100 }), null);
  assert.equal(typeof serializeStateIfEnabled(true, { amount:100 }), 'string');
});

test('CSVインジェクション文字列を無害化する', () => {
  assert.equal(sanitizeCsvCell('=1+1'), "'=1+1");
  assert.equal(sanitizeCsvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(sanitizeCsvCell(-100), '-100');
});

test('リリースメタデータを最新版から一元生成する', () => {
  assert.equal(release.APP_META.version, release.RELEASE_HISTORY[0].version);
  assert.equal(release.APP_META.updatedAt, release.RELEASE_HISTORY[0].date);
  assert.equal(release.APP_META.version, 'r11');
});

test('4期表示に最有利見込みを使わず、出力関数に版数と未確認事項がある', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /4期[^\n]{0,80}最有利見込み/);
  assert.match(html, /APP_META\.version/);
  assert.match(html, /未確認事項/);
});
