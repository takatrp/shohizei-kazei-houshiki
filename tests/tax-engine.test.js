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
  calculateDetailedRegular,
  calculateDeclarationAmount,
  calculateNationalSalesTax,
  assessHighValueAsset,
  optimizeFourPeriodRoutes,
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

function routePeriod(label, amounts, overrides = {}){
  return {
    label,
    highValueAssetTrigger:false,
    methods:Object.entries(amounts).map(([key, amount]) => ({ key, amount, eligible:true })),
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

test('課税売上割合95％かつ5億円以下では方式にかかわらず全額控除する', () => {
  const result = calculateDetailedRegular({
    salesTax:50000000,
    purchaseTax:30000000,
    adjustment:100,
    method:'proportional',
    taxableSales:500000000,
    totalSales:500000000 / 0.95,
    taxableOnlyTax:0,
    commonTax:0
  });
  assert.equal(result.fullCreditEligible, true);
  assert.equal(result.regularCredit, 30000000);
  assert.equal(result.appliedMethod, 'full');
  assert.equal(result.amount, 20000100);
});

test('課税売上割合95％未満または5億円超では指定した控除方式を使う', () => {
  const below95 = calculateDetailedRegular({
    salesTax:1000, purchaseTax:800, adjustment:0, method:'proportional',
    taxableSales:949999, totalSales:1000000, taxableOnlyTax:0, commonTax:0
  });
  assert.equal(below95.fullCreditEligible, false);
  assert.equal(below95.regularCredit, 759.9992);

  const over500m = calculateDetailedRegular({
    salesTax:1000, purchaseTax:800, adjustment:0, method:'individual',
    taxableSales:500000001, totalSales:500000001, taxableOnlyTax:300, commonTax:200
  });
  assert.equal(over500m.fullCreditEligible, false);
  assert.equal(over500m.regularCredit, 500);
  assert.equal(over500m.appliedMethod, 'individual');
});

test('個別対応方式の区分税額と異常入力を仕入税額の範囲内に収める', () => {
  const result = calculateDetailedRegular({
    salesTax:-100, purchaseTax:500, adjustment:-50, method:'individual',
    taxableSales:50, totalSales:100, taxableOnlyTax:600, commonTax:Infinity
  });
  assert.equal(result.regularCredit, 500);
  assert.equal(result.amount, -550);
  assert.equal(result.taxableSalesRatio, 0.5);
});

test('本則精密計算は控除増となる負の調整額を反映する', () => {
  const result = calculateDetailedRegular({
    salesTax:100000,
    purchaseTax:50000,
    adjustment:-10000,
    method:'individual',
    taxableSales:10000000,
    totalSales:10000000,
    taxableOnlyTax:50000,
    commonTax:0
  });
  assert.equal(result.amount, 40000);
});

test('申告額は納付100円未満、還付1円未満を切り捨てて地方税を計算する', () => {
  assert.deepEqual(calculateDeclarationAmount({
    nationalSalesTax:2000.75,
    nationalCredit:766,
    nationalAdjustment:0
  }), {
    rawNational:1234.75,
    nationalAmount:1200,
    localAmount:300,
    total:1500
  });
  assert.deepEqual(calculateDeclarationAmount({
    nationalSalesTax:0,
    nationalCredit:1234.75,
    nationalAdjustment:0
  }), {
    rawNational:-1234.75,
    nationalAmount:-1234,
    localAmount:-348,
    total:-1582
  });
  assert.equal(Object.is(calculateDeclarationAmount({
    nationalSalesTax:0,
    nationalCredit:0.5,
    nationalAdjustment:0
  }).nationalAmount, -0), false);
});

test('国税売上税額は税率別課税標準の1000円未満と税額の1円未満を切り捨てる', () => {
  assert.deepEqual(calculateNationalSalesTax({
    taxableBase10:1234999,
    taxableBaseReduced:1001999
  }), {
    taxableBase10:1234000,
    taxableBaseReduced:1001000,
    nationalTax10:96252,
    nationalTaxReduced:62462,
    total:158714
  });
  assert.equal(calculateNationalSalesTax({
    taxableBase10:0,
    taxableBaseReduced:1000,
    reducedNationalRate:6
  }).nationalTaxReduced, 60);
});

test('高額資産の200万円・1000万円境界を資産区分別に判定する', () => {
  const goldBelow = assessHighValueAsset({
    hasAcquisition:'yes', amountEntered:true, amount:1999999, assetType:'gold',
    selfConstructed:false, acquisitionMethod:'regular'
  });
  const goldAt = assessHighValueAsset({
    hasAcquisition:'yes', amountEntered:true, amount:2000000, assetType:'gold',
    selfConstructed:false, acquisitionMethod:'regular'
  });
  const fixedAt = assessHighValueAsset({
    hasAcquisition:'yes', amountEntered:true, amount:10000000, assetType:'fixed',
    selfConstructed:false, acquisitionMethod:'regular'
  });
  const inventoryBelow = assessHighValueAsset({
    hasAcquisition:'yes', amountEntered:true, amount:9999999, assetType:'inventory',
    selfConstructed:false, acquisitionMethod:'regular'
  });
  assert.equal(goldBelow.status, 'clear');
  assert.equal(goldAt.status, 'restricted');
  assert.equal(goldAt.restrictionPeriods, 2);
  assert.equal(goldAt.simplifiedNoticeRestricted, true);
  assert.equal(inventoryBelow.status, 'clear');
  assert.equal(fixedAt.status, 'restricted');
});

test('高額資産は取得方式と未確認・自己建設を安全側で判定する', () => {
  const base = {
    hasAcquisition:'yes', amountEntered:true, amount:10000000,
    assetType:'inventory', selfConstructed:false
  };
  assert.equal(assessHighValueAsset({ hasAcquisition:'no' }).status, 'clear');
  assert.equal(assessHighValueAsset({ hasAcquisition:'unknown' }).status, 'unknown');
  assert.equal(assessHighValueAsset({ ...base, acquisitionMethod:'simplified' }).status, 'clear');
  assert.equal(assessHighValueAsset({ ...base, acquisitionMethod:'special2' }).status, 'clear');
  assert.equal(assessHighValueAsset({ ...base, acquisitionMethod:'special3' }).status, 'unknown');
  assert.equal(assessHighValueAsset({ ...base, acquisitionMethod:'unknown' }).status, 'unknown');
  assert.equal(assessHighValueAsset({ ...base, selfConstructed:true, acquisitionMethod:'regular' }).status, 'unknown');
  assert.equal(assessHighValueAsset({ ...base, amount:-1, acquisitionMethod:'regular' }).status, 'unknown');
});

test('新規の簡易課税選択は現在期と次期の2期を拘束する', () => {
  const result = optimizeFourPeriodRoutes({
    initialElectionStatus:'none',
    noticeReady:'yes',
    periods:[
      routePeriod('1期', { regular:100, simplified:10 }),
      routePeriod('2期', { regular:0, simplified:20 }),
      routePeriod('3期', { regular:30, simplified:200 }),
      routePeriod('4期', { regular:40, simplified:200 })
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bestRoute.map(step => step.method), ['simplified', 'simplified', 'regular', 'regular']);
  assert.equal(result.cumulative, 100);
  assert.match(result.bestRoute[0].action, /選択届出書/);
  assert.match(result.bestRoute[2].action, /不適用届出/);
});

test('5000万円超で簡易課税が使えない期も届出効力を保って次期に復活する', () => {
  const unavailableSimplified = routePeriod('1期', { regular:100, simplified:1 });
  unavailableSimplified.methods.find(method => method.key === 'simplified').eligible = false;
  const result = optimizeFourPeriodRoutes({
    initialElectionStatus:'second',
    noticeReady:'no',
    periods:[
      unavailableSimplified,
      routePeriod('2期', { regular:500, simplified:10 }),
      routePeriod('3期', { regular:500, simplified:10 }),
      routePeriod('4期', { regular:500, simplified:10 })
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bestRoute.map(step => step.method), ['regular', 'simplified', 'simplified', 'simplified']);
  assert.match(result.bestRoute[0].action, /届出効力を維持/);
});

test('高額資産取得後2期は簡易の新規選択と2割・3割特例を除外する', () => {
  const result = optimizeFourPeriodRoutes({
    initialElectionStatus:'none',
    noticeReady:'yes',
    periods:[
      routePeriod('1期', { regular:0 }, { highValueAssetTrigger:true }),
      routePeriod('2期', { regular:100, simplified:1, special2:0, special3:0 }),
      routePeriod('3期', { regular:100, simplified:1, special2:0, special3:0 }),
      routePeriod('4期', { regular:100, simplified:1, special2:50, special3:50 })
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bestRoute.map(step => step.method), ['regular', 'regular', 'regular', 'simplified']);
  assert.equal(result.cumulative, 201);
});

test('届出有効中でも本則で高額資産を取得した後は簡易課税へ復帰させない', () => {
  const first = routePeriod('1期', { regular:0, simplified:1 }, { highValueAssetTrigger:true });
  first.methods.find(method => method.key === 'simplified').eligible = false;
  const result = optimizeFourPeriodRoutes({
    initialElectionStatus:'free',
    noticeReady:'yes',
    periods:[
      first,
      routePeriod('2期', { regular:100, simplified:1 }),
      routePeriod('3期', { regular:100, simplified:1 }),
      routePeriod('4期', { regular:100, simplified:1 })
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bestRoute.map(step => step.method), ['regular', 'regular', 'regular', 'simplified']);
  assert.match(result.bestRoute[0].action, /高額資産取得/);
});

test('2割・3割特例は簡易届出を維持しながら拘束期間を経過させる', () => {
  const result = optimizeFourPeriodRoutes({
    initialElectionStatus:'first',
    noticeReady:'no',
    periods:[
      routePeriod('1期', { regular:100, simplified:20, special2:5 }),
      routePeriod('2期', { regular:100, simplified:20, special3:5 }),
      routePeriod('3期', { regular:1, simplified:20 }),
      routePeriod('4期', { regular:1, simplified:20 })
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bestRoute.map(step => step.method), ['special2', 'special3', 'regular', 'regular']);
  assert.equal(result.cumulative, 12);
});

test('簡易届出状態が未確認なら4期最適化を行わない', () => {
  const result = optimizeFourPeriodRoutes({
    initialElectionStatus:'unknown',
    noticeReady:'yes',
    periods:Array.from({ length:4 }, (_, index) => routePeriod(`${index + 1}期`, { regular:0 }))
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /未確認/);
  assert.deepEqual(result.bestRoute, []);
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
  assert.equal(release.APP_META.version, 'r12');
});

test('4期表示に最有利見込みを使わず、出力関数に版数と未確認事項がある', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /4期[^\n]{0,80}最有利見込み/);
  assert.match(html, /APP_META\.version/);
  assert.match(html, /未確認事項/);
});
