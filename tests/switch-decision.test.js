const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateRepeatedCosts,
  calculateQuotedCost,
  calculateCustomerEconomics,
  calculateOfficeProfitability,
  buildCustomerReportData,
  buildInternalReportData,
  migrateSavedState
} = require('../switch-decision.js');

const entered = value => ({ entered:true, value });

function economic(overrides = {}){
  return calculateCustomerEconomics({
    periods:[{ aTax:800000, bTax:200000 }],
    additionalFee:entered(180000),
    otherCosts:entered(70000),
    additionalCredit:entered(0),
    creditIncludedInBTax:false,
    customerHours:entered(40),
    hourlyRate:entered(2500),
    ...overrides
  });
}

test('[E01] 税額差、追加支出、時間評価を分けて計算する', () => {
  const result = economic();
  assert.equal(result.taxBenefit, 600000);
  assert.equal(result.cashBenefit, 350000);
  assert.equal(result.timeCost, 100000);
  assert.equal(result.economicBenefit, 250000);
});

test('[E02] 総許容時間・残り許容時間・追加報酬許容額を区別する', () => {
  const result = economic();
  assert.equal(result.totalAllowableHours, 140);
  assert.equal(result.remainingAllowableHours, 100);
  assert.equal(result.allowableFee, 430000);
});

test('[E03] 所内採算を顧客側の追加負担と別に計算する', () => {
  const result = calculateOfficeProfitability({
    additionalFeeExTax:entered(180000),
    hours:entered(32),
    hourlyCost:entered(4000),
    otherCost:entered(20000)
  });
  assert.equal(result.laborCost, 128000);
  assert.equal(result.profit, 32000);
  assert.equal(economic().economicBenefit, 250000);
});

test('[E04] B案未反映の仕入控除だけを追加支出計算へ加える', () => {
  const result = economic({
    additionalFee:entered(110000),
    otherCosts:entered(0),
    additionalCredit:entered(10000),
    customerHours:entered(0),
    hourlyRate:entered(0)
  });
  assert.equal(result.cashBenefit, 500000);
});

test('[E05] B案反映済みの控除税額を再加算しない', () => {
  const result = economic({
    periods:[{ aTax:810000, bTax:200000 }],
    additionalFee:entered(110000),
    otherCosts:entered(0),
    additionalCredit:entered(10000),
    creditIncludedInBTax:true,
    customerHours:entered(0),
    hourlyRate:entered(0)
  });
  assert.equal(result.taxBenefit, 610000);
  assert.equal(result.creditToAdd, 0);
  assert.equal(result.cashBenefit, 500000);
});

test('[E06] 還付を税額差へ二重加算しない', () => {
  const result = economic({
    periods:[{ aTax:80000, bTax:-420000 }],
    additionalFee:entered(0),
    otherCosts:entered(0),
    additionalCredit:entered(0),
    customerHours:entered(0),
    hourlyRate:entered(0)
  });
  assert.equal(result.taxBenefit, 500000);
  assert.equal(result.cashBenefit, 500000);
});

test('[E07] 未入力と確認済み0を区別し単価0でInfinityを出さない', () => {
  const incomplete = calculateCustomerEconomics({ periods:[{ aTax:1, bTax:0 }] });
  assert.equal(incomplete.complete, false);
  const zero = economic({
    additionalFee:entered(0),
    otherCosts:entered(0),
    additionalCredit:entered(0),
    customerHours:entered(0),
    hourlyRate:entered(0)
  });
  assert.equal(zero.complete, true);
  assert.equal(zero.totalAllowableHours, null);
  assert.match(zero.breakEvenReason, /時間単価0円/);
});

test('[E08] 初回費用を一度、継続費用を該当期数だけ計上する', () => {
  assert.equal(calculateRepeatedCosts({ initialCost:120000, perPeriodCost:30000, regularPeriods:3 }).total, 210000);
});

test('[E09] 税額差がプラスでも負担後のマイナスを隠さない', () => {
  const reversed = economic({
    periods:[{ aTax:100000, bTax:0 }],
    additionalFee:entered(120000),
    otherCosts:entered(0),
    additionalCredit:entered(0),
    customerHours:entered(0),
    hourlyRate:entered(0)
  });
  assert.equal(reversed.economicBenefit, -20000);
  const taxNegative = economic({ periods:[{ aTax:0, bTax:50000 }] });
  assert.equal(taxNegative.taxBenefit, -50000);
});

test('[E10] 感度幅が損益分岐点をまたぐ場合は結論を留保する', () => {
  const result = economic({
    periods:[{ aTax:600000, bTax:0 }],
    additionalFee:entered(0),
    otherCosts:entered(250000),
    additionalCredit:entered(0),
    customerHours:entered(40),
    hourlyRate:entered(2500),
    sensitivity:{ entered:true, taxBenefitMin:200000, taxBenefitMax:600000 }
  });
  assert.equal(result.sensitivity.economicMin, -150000);
  assert.equal(result.sensitivity.economicMax, 250000);
  assert.equal(result.sensitivity.crossesBreakEven, true);
  assert.match(result.suggestion, /結論が変わります/);
});

test('[UI-P0] 不正な追加報酬・支出・顧客時間を0円に読み替えず、比較を完了しない', () => {
  for(const key of ['additionalFee','otherCosts','customerHours','hourlyRate']){
    const result = economic({ [key]:{ entered:true, valid:false, value:0, raw:'不明' } });
    assert.equal(result.complete, false, key);
    assert.match(result.suggestion, /入力エラー/, key);
    assert.ok(result.errors.length, key);
    assert.equal(result.cashBenefit, null);
  }
  const office = calculateOfficeProfitability({
    additionalFeeExTax:entered(100000), hours:{ entered:true, valid:false, value:0, raw:'不明' },
    hourlyCost:entered(4000), otherCost:entered(0)
  });
  assert.equal(office.complete, false);
  assert.ok(office.errors.length);
  assert.equal(economic({ additionalFee:entered(0) }).complete, true);
});

test('[UI-P0] 税込11万円・未反映控除1万円と精算後10万円が同じ48万円になる', () => {
  const gross = calculateQuotedCost({ quote:entered(110000), taxBasis:'included', creditState:'confirmed', credit:entered(10000) });
  assert.equal(gross.grossSpend, 110000);
  assert.equal(gross.creditToAdd, 10000);
  const result = calculateCustomerEconomics({
    periods:[{ aTax:580000, bTax:0 }],
    additionalFee:entered(gross.grossSpend), otherCosts:entered(0), additionalCredit:entered(gross.creditToAdd),
    timeEvaluation:'excluded'
  });
  assert.equal(result.cashBenefit, 480000);
  const netCost = calculateCustomerEconomics({
    periods:[{ aTax:580000, bTax:0 }],
    additionalFee:entered(100000), otherCosts:entered(0), additionalCredit:entered(0), timeEvaluation:'excluded'
  });
  assert.equal(netCost.cashBenefit, result.cashBenefit);
  assert.equal(result.complete, true);
  assert.equal(result.timeCost, null);
  assert.equal(result.economicBenefit, null);
  assert.match(result.suggestion, /金額換算していません/);
});

test('[UI-P0] B案に反映済みの控除を再加算せず、控除未確認を確定しない', () => {
  const included = calculateQuotedCost({ quote:entered(110000), taxBasis:'included', creditState:'confirmed', credit:entered(10000), creditIncludedInBTax:true });
  assert.equal(included.creditToAdd, 0);
  const unknown = calculateQuotedCost({ quote:entered(110000), taxBasis:'included', creditState:'unknown' });
  assert.equal(unknown.complete, false);
  const invalid = calculateQuotedCost({ quote:{ entered:true, valid:false, value:0, raw:'不明' }, creditState:'none' });
  assert.equal(invalid.grossSpend, null);
  assert.equal(invalid.complete, false);
  assert.ok(invalid.errors.length);
});

test('[UI-P1] 未入力の追加費用と時間は顧客用モデルでも0円にしない', () => {
  const economics = calculateCustomerEconomics({
    periods:[{ aTax:580000, bTax:0 }],
    additionalFee:{ entered:false, valid:true, value:0 },
    otherCosts:entered(0), additionalCredit:entered(0),
    timeEvaluation:'excluded'
  });
  const report = buildCustomerReportData({ economics });
  assert.equal(report.additionalFee, null);
  assert.equal(report.otherCosts, 0);
  assert.equal(report.cashBenefit, null);
  assert.equal(report.customerHours, null);
  assert.equal(report.timeCost, null);
  const noPeriod = buildCustomerReportData({ economics:calculateCustomerEconomics({ periods:[] }) });
  assert.equal(noPeriod.planATax, null);
  assert.equal(noPeriod.taxBenefit, null);
});

test('[UI-P0] 旧見積の金額基準は推測せず、旧値を表示して再入力する', () => {
  const legacy = migrateSavedState({ saveEnabled:true, taxScenario:'foodProposal', switchAdditionalFee:'100,000' });
  assert.equal(legacy.workflowPurpose, 'regular');
  assert.equal(legacy.switchAdditionalFee, '');
  assert.equal(legacy.legacyAdditionalFeeValue, '100,000');
  assert.match(legacy.migrationNotice, /100,000/);
  const restoredAgain = migrateSavedState(legacy);
  assert.match(restoredAgain.migrationNotice, /再入力/);
  assert.equal(restoredAgain.switchCreditState, 'unknown');
});

test('[A13][A14] 控除未確認でも参考差額を出し、0円見積なら控除確認で止めない', () => {
  const unknown = calculateQuotedCost({ quote:entered(110000), taxBasis:'included', creditState:'unknown' });
  const reference = calculateCustomerEconomics({
    periods:[{ aTax:580000, bTax:0 }], additionalFee:entered(unknown.grossSpend),
    otherCosts:entered(0), additionalCredit:{ entered:false, valid:true, value:0 }, timeEvaluation:'excluded'
  });
  assert.equal(reference.cashBenefitBeforeCredit, 470000);
  assert.equal(reference.cashBenefit, null);
  const zero = calculateQuotedCost({ quote:entered(0), taxBasis:'included', creditState:'unknown' });
  assert.equal(zero.includedTax, 0);
  assert.equal(zero.complete, true);
  const net = calculateQuotedCost({ quote:entered(100000), taxBasis:'excluded', creditState:'none' });
  const gross = calculateQuotedCost({ quote:entered(110000), taxBasis:'included', creditState:'none' });
  assert.equal(net.grossSpend, gross.grossSpend);
  assert.equal(net.includedTax, gross.includedTax);
});

test('[r19-T17] 顧客用データは古い開始日・適合ラベルを対象外へ持ち込まない', () => {
  const report = buildCustomerReportData({
    economics:economic(),
    comparisonPeriod:'2027-01-01 から 2027-12-31',
    reportStatus:'顧客説明用・入力条件確認済み',
    execution:{
      eligibility:'ineligible', filingExecution:'filed', filingStatus:'提出済み',
      status:'利用可能見込み', effectiveFrom:'2027-01-01', twoYearBindingWaived:true,
      reasons:['届出書を提出しないため対象外です。'], confirmations:[]
    },
    office:{ profit:999999 }, internalComment:'所内メモ'
  });
  assert.equal(report.executionEligibility, 'ineligible');
  assert.equal(report.effectiveFrom, '');
  assert.equal(report.twoYearBindingWaived, false);
  assert.match(report.effectiveFromLabel, /この特例による適用開始日はありません/);
  assert.match(report.executionReasons.join(' '), /対象外/);
  assert.doesNotMatch(report.reportStatus, /条件確認済み/);
  assert.equal(report.comparisonPeriod, '2027-01-01 から 2027-12-31');
  assert.equal(JSON.stringify(report).includes('999999'), false);
  assert.equal(JSON.stringify(report).includes('所内メモ'), false);
});

test('[A11] 旧保存値の目的・税率の不一致を警告し食品区分を未確認に戻す', () => {
  const old = migrateSavedState({ schemaVersion:16, workflowPurpose:'regular', taxScenario:'foodProposal', proposalFoodClassificationState:'confirmed', type2SaleFood1:'10,000' });
  assert.equal(old.taxScenario, 'foodProposal');
  assert.equal(old.workflowPurpose, 'regular');
  assert.equal(old.proposalFoodClassificationState, 'unknown');
  assert.match(old.migrationNotice, /不一致/);
  assert.match(old.migrationNotice, /再取込/);
});

test('[U01] r14保存値と旧1％モードを食品区分未確認で移行する', () => {
  const migrated = migrateSavedState({ taxScenario:'food1', periodStart:'2027-01-01', saveEnabled:true });
  assert.equal(migrated.taxScenario, 'foodProposal');
  assert.equal(migrated.proposalFoodClassificationState, 'unknown');
  assert.match(migrated.migrationNotice, /再確認/);
  assert.equal(migrateSavedState({}).switchDecisionOpen, false);
});

test('[U03] 上流値を変えると税額差とコメントを再計算する', () => {
  const before = economic({ periods:[{ aTax:600000, bTax:300000 }] });
  const after = economic({ periods:[{ aTax:600000, bTax:100000 }] });
  assert.notEqual(before.taxBenefit, after.taxBenefit);
  assert.notEqual(before.suggestion, after.suggestion);
});

test('[U04] 顧客用モデルへ所内原価・採算・内部メモを渡さない', () => {
  const secret = 'INTERNAL_SECRET_NEVER_EXPORT';
  const office = calculateOfficeProfitability({
    additionalFeeExTax:entered(987654321), hours:entered(1), hourlyCost:entered(1), otherCost:entered(0)
  });
  const customer = buildCustomerReportData({
    economics:economic(),
    scenarioLabel:'飲食料品1％・大綱に基づく試算',
    internalComment:secret,
    office,
    customerComment:'顧客向けコメント'
  });
  const customerText = JSON.stringify(customer);
  assert.equal(customerText.includes(secret), false);
  assert.equal(customerText.includes('987654321'), false);
  const internal = buildInternalReportData({ economics:economic(), office, internalComment:secret });
  assert.equal(JSON.stringify(internal).includes(secret), true);
  assert.equal(JSON.stringify(internal).includes('987654321'), true);
});
