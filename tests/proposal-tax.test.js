const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ELIGIBILITY,
  FOOD_PROPOSAL,
  calculateNationalSalesTax,
  taxRateForProposalItem,
  assessCsvOnePercentEntry,
  projectPrice,
  calculateSpecialMethodAmount,
  calculatePeriodTaxCase,
  assessFoodSimplifiedDiscontinuance
} = require('../tax-engine.js');

const sale = (amount, ratePercent, businessKey, deemed, foodOnePercent = false) => ({
  amount,
  ratePercent,
  amountMode:'excluded',
  businessKey,
  businessName:businessKey,
  deemed,
  foodOnePercent,
  confirmed:true
});

const purchase = (amount, ratePercent, creditRatio = 1) => ({
  amount,
  ratePercent,
  creditRatio,
  amountMode:'excluded',
  confirmed:true
});

function eligibleSwitch(overrides = {}){
  return assessFoodSimplifiedDiscontinuance({
    scenario:'foodProposal',
    periodStart:'2027-01-01',
    periodEnd:'2027-12-31',
    foodSalesState:'yes',
    simplifiedAppliedState:'yes',
    noOtherRestrictionsState:'yes',
    filingStatus:'filed',
    filingDate:'2027-09-30',
    ...overrides
  });
}

test('[T01] 1％食品を除いて75％ルールを判定し主結果を8万円とする', () => {
  const result = calculatePeriodTaxCase({
    sales:[
      sale(20000000, 1, 'type2', 0.80, true),
      sale(3000000, 10, 'type2', 0.80),
      sale(1000000, 10, 'type4', 0.60)
    ]
  });
  assert.equal(result.valid, true);
  assert.equal(result.salesTax, 600000);
  assert.equal(result.simplified.normalCredit, 500000);
  assert.equal(result.simplified.candidates.find(item => item.kind === 'normal').deemedCredit, 500000);
  assert.equal(result.simplified.method, 'single75');
  assert.equal(result.simplified.deemedCredit, 520000);
  assert.equal(result.simplified.amount, 80000);
});

test('[A17] 第2種食品・第5種・第4種の検算例は37万／16万／24万円', () => {
  const result = calculatePeriodTaxCase({
    sales:[
      sale(25000000, 1, 'type2', 0.80, true),
      sale(5000000, 10, 'type5', 0.50),
      sale(3000000, 10, 'type4', 0.60)
    ]
  });
  assert.equal(result.salesTax, 1050000);
  assert.equal(result.simplified.deemedCredit, 680000);
  assert.equal(result.simplified.amount, 370000);
  assert.equal(result.special2.amount, 160000);
  assert.equal(result.special3.amount, 240000);
});

test('[T02] 全売上が1％対象食品なら簡易・2割・3割の計算額は0円', () => {
  const result = calculatePeriodTaxCase({ sales:[sale(20000000, 1, 'type2', 0.80, true)] });
  assert.equal(result.simplified.amount, 0);
  assert.equal(result.special2.amount, 0);
  assert.equal(result.special3.amount, 0);
});

test('[T03] 年途中の税率変更でも一般課税は課税期間全体で比較する', () => {
  const result = calculatePeriodTaxCase({
    sales:[
      sale(6000000, 8, 'type2', 0.80),
      sale(18000000, 1, 'type2', 0.80, true)
    ],
    purchases:[purchase(3000000, 8), purchase(9000000, 1), purchase(5000000, 10)]
  });
  assert.equal(result.salesTax, 660000);
  assert.equal(result.purchaseTax, 830000);
  assert.equal(result.simplified.amount, 96000);
  assert.equal(result.regularAmount, -170000);
  assert.equal(result.simplified.amount - result.regularAmount, 266000);
  assert.equal(eligibleSwitch().effectiveFrom, '2027-01-01');
});

test('[T04] 食品1％の境界と新聞・標準税率・旧税率を分離する', () => {
  const cases = [
    ['2027-03-31', 8],
    ['2027-04-01', 1],
    ['2029-03-31', 1],
    ['2029-04-01', 8]
  ];
  cases.forEach(([date, expected]) => {
    assert.equal(taxRateForProposalItem({ date, category:'food' }).ratePercent, expected);
  });
  assert.equal(taxRateForProposalItem({ date:'2028-01-01', category:'newspaperOrOtherReduced' }).ratePercent, 8);
  assert.equal(taxRateForProposalItem({ date:'2028-01-01', category:'standard' }).ratePercent, 10);
  assert.equal(taxRateForProposalItem({ date:'2028-01-01', category:'food', legacyReducedRate:true }).ratePercent, 8);
  assert.equal(taxRateForProposalItem({ date:'2028-01-01', category:'unconfirmed' }).status, 'unknown');
});

test('[r18-A] CSV明示1％の通常取引は共通の制度期間で検証し返還は要個別確認に分ける', () => {
  for(const [date, status] of [
    ['2027-03-31','invalid'], ['2027-04-01','confirmed'],
    ['2029-03-31','confirmed'], ['2029-04-01','invalid']
  ]){
    assert.equal(assessCsvOnePercentEntry({ date, transactionKind:'ordinary', kind:'sale' }).status, status, date);
    assert.equal(assessCsvOnePercentEntry({ date, transactionKind:'ordinary', kind:'invoicePurchase' }).status, status, date);
    assert.equal(assessCsvOnePercentEntry({ date, transactionKind:'ordinary', kind:'exemptPurchase' }).status, status, date);
  }
  const adjustment = assessCsvOnePercentEntry({ date:'2029-04-01', transactionKind:'adjustment', kind:'sale', taxCode:'11' });
  assert.equal(adjustment.status, 'unknown');
  assert.match(adjustment.reason, /元取引/);
  assert.equal(assessCsvOnePercentEntry({ date:'', transactionKind:'ordinary' }).status, 'unknown');
  assert.equal(assessCsvOnePercentEntry({ date:'2029-04-01' }).status, 'unknown');
});

test('[T05] 1％食品100万円の国税は7,800円、地方税は2,200円', () => {
  const result = calculateNationalSalesTax({ taxableBaseFood1:1000000, foodNationalRatePercent:0.78 });
  assert.equal(result.nationalTaxFood1, 7800);
  assert.equal(1000000 * FOOD_PROPOSAL.foodLocalRatePercent / 100, 2200);
  assert.equal(result.nationalTaxFood1 + 2200, 10000);
  const current = calculateNationalSalesTax({ taxableBase10:1000000, taxableBaseReduced:1000000 });
  assert.equal(current.nationalTax10, 78000);
  assert.equal(current.nationalTaxReduced, 62400);
});

test('[T06] 2割・3割は1％食品売上税額を除いた部分へ適用する', () => {
  assert.equal(calculateSpecialMethodAmount({ totalSalesTax:600000, foodOnePercentTax:200000, burdenRatio:0.20 }).amount, 80000);
  assert.equal(calculateSpecialMethodAmount({ totalSalesTax:600000, foodOnePercentTax:200000, burdenRatio:0.30 }).amount, 120000);
});

test('[T07] 旧税率食品・新聞は同額控除や75％判定除外へ含めない', () => {
  const result = calculatePeriodTaxCase({
    sales:[
      sale(10000000, 1, 'type2', 0.80, true),
      sale(1000000, 8, 'type2', 0.80),
      sale(1000000, 8, 'type4', 0.60)
    ]
  });
  assert.equal(result.simplified.foodOnePercentTaxableBase, 10000000);
  assert.equal(result.simplified.otherTaxableBase, 2000000);
  assert.equal(result.simplified.normalCredit, 100000 + 64000 + 48000);
});

test('[T08] 仕入税額へ明示した控除割合を取引単位で適用する', () => {
  const result = calculatePeriodTaxCase({ purchases:[purchase(100000, 1, 0.70)] });
  assert.equal(result.purchaseTax, 700);
  const crossed = calculatePeriodTaxCase({
    purchases:[purchase(1000000, 8, 0.80), purchase(1000000, 8, 0.70), purchase(1000000, 1, 0.70)]
  });
  assert.equal(crossed.purchaseTax, 127000);
});

test('[T09] 免税事業者仕入がなくても各期を元取引から再計算する', () => {
  const foodPeriod = calculatePeriodTaxCase({
    sales:[sale(1000000, 1, 'type2', 0.80, true)],
    purchases:[purchase(500000, 1), purchase(1000000, 10)]
  });
  const nextFoodPeriod = calculatePeriodTaxCase({
    sales:[sale(1000000, 1, 'type2', 0.80, true)],
    purchases:[purchase(500000, 1)]
  });
  const restoredPeriod = calculatePeriodTaxCase({
    sales:[sale(1000000, 8, 'type2', 0.80)],
    purchases:[purchase(500000, 8)]
  });
  assert.equal(foodPeriod.regularAmount, -95000);
  assert.equal(nextFoodPeriod.regularAmount, 5000);
  assert.equal(restoredPeriod.regularAmount, 40000);
});

test('[T10] 税抜据置と税込据置を入力金額モードから独立して計算する', () => {
  assert.deepEqual(projectPrice({ netAmount:1000000, grossAmount:1080000, ratePercent:1, priceBasis:'netFixed' }), {
    netAmount:1000000, grossAmount:1010000, taxAmount:10000
  });
  const grossFixed = projectPrice({ netAmount:1000000, grossAmount:1080000, ratePercent:1, priceBasis:'grossFixed' });
  assert.equal(grossFixed.grossAmount, 1080000);
  assert.ok(Math.abs(grossFixed.taxAmount - 1080000 / 101) < 1e-8);
});

test('[D01][D02] 対象期の期中提出で期首から一般課税となり当該期の2年縛りだけを解除する', () => {
  const result = eligibleSwitch();
  assert.equal(result.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(result.effectiveFrom, '2027-01-01');
  assert.equal(result.twoYearBindingWaived, true);
  assert.match(result.filingReference, /飲食料品特例/);
});

test('[D03] 期末後提出を期中提出として扱わない', () => {
  const result = eligibleSwitch({ filingDate:'2028-01-01' });
  assert.equal(result.eligibility, ELIGIBILITY.INELIGIBLE);
  assert.match(result.reasons.join(' '), /対象課税期間中ではありません/);
});

test('[D04] 法人の期ずれでも2027年4月1日を含む期だけ対象とする', () => {
  assert.equal(eligibleSwitch({ periodStart:'2026-09-01', periodEnd:'2027-08-31', filingDate:'2027-06-01' }).eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(eligibleSwitch({ periodStart:'2027-04-01', periodEnd:'2028-03-31', filingDate:'2027-04-01' }).eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(eligibleSwitch({ periodStart:'2026-04-01', periodEnd:'2027-03-31', filingDate:'2027-03-31' }).eligibility, ELIGIBILITY.INELIGIBLE);
});

test('[D05] 食品販売なしと未確認、簡易課税未確認を区別する', () => {
  assert.equal(eligibleSwitch({ foodSalesState:'no' }).eligibility, ELIGIBILITY.INELIGIBLE);
  assert.equal(eligibleSwitch({ foodSalesState:'unknown' }).eligibility, ELIGIBILITY.UNKNOWN);
  assert.equal(eligibleSwitch({ simplifiedAppliedState:'unknown' }).eligibility, ELIGIBILITY.UNKNOWN);
});

test('[D06] 2028年の期中提出へ届出特例を誤適用しない', () => {
  assert.equal(eligibleSwitch({ periodStart:'2028-01-01', periodEnd:'2028-12-31', filingDate:'2028-06-01' }).eligibility, ELIGIBILITY.INELIGIBLE);
});

test('[D07] 提出予定と提出済みを分離して保持する', () => {
  assert.equal(eligibleSwitch({ filingStatus:'planned', filingDate:'2027-11-30' }).filingExecution, 'planned');
  assert.equal(eligibleSwitch({ filingStatus:'filed', filingDate:'2027-11-30' }).filingExecution, 'filed');
});

test('[r18-B] 期首前提出予定は一律の切替不可でも特例の無条件適用でもない', () => {
  for(const [periodStart, periodEnd, filingDate] of [
    ['2027-04-01','2028-03-31','2027-03-15'],
    ['2027-01-01','2027-12-31','2026-12-20']
  ]){
    const result = eligibleSwitch({ periodStart, periodEnd, filingStatus:'planned', filingDate });
    assert.equal(result.eligibility, ELIGIBILITY.UNKNOWN);
    assert.equal(result.filingExecution, 'planned');
    assert.equal(result.twoYearBindingWaived, false);
    assert.match(result.confirmations.join(' '), /通常の届出/);
  }
  assert.equal(eligibleSwitch({ filingStatus:'planned', filingDate:'2027-09-30' }).eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(eligibleSwitch({ filingStatus:'planned', filingDate:'2028-01-01' }).eligibility, ELIGIBILITY.INELIGIBLE);
});

test('[r19-T01-T05] 最終適用可否と開始日を一致させ、提出予定と提出済みを区別する', () => {
  const noFiling = eligibleSwitch({ filingStatus:'none', filingDate:'2027-06-15' });
  assert.equal(noFiling.eligibility, ELIGIBILITY.INELIGIBLE);
  assert.equal(noFiling.effectiveFrom, '');
  assert.equal(noFiling.twoYearBindingWaived, false);
  assert.match(noFiling.reasons.join(' '), /提出しない/);
  for(const input of [
    { foodSalesState:'no' }, { simplifiedAppliedState:'no' },
    { periodStart:'2028-01-01', periodEnd:'2028-12-31', filingDate:'2028-06-15' }
  ]){
    const result = eligibleSwitch(input);
    assert.equal(result.eligibility, ELIGIBILITY.INELIGIBLE);
    assert.equal(result.effectiveFrom, '');
    assert.ok(result.reasons.length);
  }
  for(const input of [
    { filingStatus:'unknown' }, { filingStatus:'planned', filingDate:'' },
    { foodSalesState:'unknown' }
  ]){
    const result = eligibleSwitch(input);
    assert.equal(result.eligibility, ELIGIBILITY.UNKNOWN);
    assert.equal(result.effectiveFrom, '');
    assert.equal(result.twoYearBindingWaived, false);
  }
  for(const filingStatus of ['filed','planned']){
    const result = eligibleSwitch({ filingStatus, filingDate:'2027-06-15' });
    assert.equal(result.eligibility, ELIGIBILITY.ELIGIBLE);
    assert.equal(result.effectiveFrom, '2027-01-01');
    assert.equal(result.filingExecution, filingStatus);
  }
});

test('[r19-T07-T09] 期首前届出は特例の事前提出も確認し、4月1日前の期中提出と分ける', () => {
  for(const filingStatus of ['filed','planned']){
    const result = eligibleSwitch({ periodStart:'2027-04-01', periodEnd:'2028-03-31', filingStatus, filingDate:'2027-03-15' });
    assert.equal(result.eligibility, ELIGIBILITY.UNKNOWN);
    assert.equal(result.effectiveFrom, '');
    assert.match(result.confirmations.join(' '), /法案成立後の事前提出/);
    assert.match(result.confirmations.join(' '), /４月１日期首/);
  }
  const calendar = eligibleSwitch({ filingStatus:'planned', filingDate:'2026-12-20' });
  assert.equal(calendar.eligibility, ELIGIBILITY.UNKNOWN);
  assert.match(calendar.confirmations.join(' '), /国税庁Q&A問３－５/);
  assert.equal(eligibleSwitch({ filingDate:'2027-01-20' }).eligibility, ELIGIBILITY.ELIGIBLE);
  const noFood = eligibleSwitch({ filingStatus:'planned', filingDate:'2026-12-20', foodSalesState:'no' });
  assert.equal(noFood.eligibility, ELIGIBILITY.INELIGIBLE);
  assert.equal(noFood.effectiveFrom, '');
});

test('[r19-T11-T14] 明示1％CSVの通常・調整・種別不明を日付と独立に評価する', () => {
  for(const date of ['2027-04-02','2029-04-01']){
    const result = assessCsvOnePercentEntry({ date, transactionKind:'adjustment' });
    assert.equal(result.status, 'unknown');
    assert.match(result.reason, /元取引/);
  }
  for(const transactionKind of [undefined, 'unknown', 'unsupported']){
    for(const date of ['2027-04-02','2029-04-01']){
      assert.equal(assessCsvOnePercentEntry({ date, transactionKind }).status, 'unknown');
    }
  }
  assert.equal(assessCsvOnePercentEntry({ date:'2027-02-30', transactionKind:'ordinary' }).status, 'unknown');
});
