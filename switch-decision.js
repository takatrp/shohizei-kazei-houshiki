(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiSwitchDecision = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  function finiteNumber(value, fallback = 0){
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function metric(input, options = {}){
    const source = input && typeof input === 'object' ? input : { entered:input !== undefined, value:input };
    const entered = source.entered === true;
    const value = finiteNumber(source.value);
    const valid = source.valid !== false && (!entered || (Number.isFinite(Number(source.value)) && (options.allowNegative || value >= 0)));
    return { entered, valid, value, raw:source.raw ?? '', error:source.error || '' };
  }

  function calculateQuotedCost(input = {}){
    const quote = metric(input.quote);
    const taxBasis = input.taxBasis === 'included' ? 'included' : 'excluded';
    const grossSpend = quote.entered && quote.valid
      ? (taxBasis === 'excluded' ? quote.value + quote.value / 10 : quote.value)
      : null;
    const includedTax = grossSpend === null ? null : grossSpend / 11;
    const creditState = input.creditState === 'confirmed' || input.creditState === 'none'
      ? input.creditState : 'unknown';
    const zeroQuote = quote.entered && quote.valid && quote.value === 0;
    const credit = creditState === 'confirmed' ? metric(input.credit) : { entered:creditState === 'none' || zeroQuote, valid:true, value:0 };
    const creditIncludedInBTax = input.creditIncludedInBTax === true;
    const errors = [];
    if(!quote.valid) errors.push('追加報酬の見積額を数値で入力してください。');
    if(!credit.valid) errors.push('追加費用の仕入控除税額を数値で入力してください。');
    if(creditState === 'confirmed' && credit.entered && includedTax !== null && credit.value > includedTax + 1e-8){
      errors.push('追加報酬の控除税額が見積額に含まれる消費税額を超えています。');
    }
    return {
      quote, taxBasis, grossSpend, includedTax, creditState, credit,
      creditIncludedInBTax, errors,
      complete:quote.entered && quote.valid && (creditState !== 'unknown' || zeroQuote) && credit.entered && credit.valid && errors.length === 0,
      creditToAdd:creditState === 'confirmed' && !creditIncludedInBTax && credit.entered && credit.valid ? credit.value : 0
    };
  }

  function sumPeriodTaxes(periods){
    const list = Array.isArray(periods) ? periods : [];
    const aTax = list.reduce((sum, period) => sum + finiteNumber(period.aTax), 0);
    const bTax = list.reduce((sum, period) => sum + finiteNumber(period.bTax), 0);
    return { aTax, bTax, taxBenefit:aTax - bTax, periodCount:list.length };
  }

  function calculateRepeatedCosts(input = {}){
    const initialCost = Math.max(0, finiteNumber(input.initialCost));
    const perPeriodCost = Math.max(0, finiteNumber(input.perPeriodCost));
    const regularPeriods = Math.max(0, Math.floor(finiteNumber(input.regularPeriods)));
    const monthlyCost = Math.max(0, finiteNumber(input.monthlyCost));
    const futureMonths = Math.max(0, Math.floor(finiteNumber(input.futureMonths)));
    const backlogCost = Math.max(0, finiteNumber(input.backlogCost));
    return {
      initialCost,
      recurringPeriodCost:perPeriodCost * regularPeriods,
      recurringMonthlyCost:monthlyCost * futureMonths,
      backlogCost,
      total:initialCost + perPeriodCost * regularPeriods + monthlyCost * futureMonths + backlogCost
    };
  }

  function calculateCustomerEconomics(input = {}){
    const tax = sumPeriodTaxes(input.periods);
    const additionalFee = metric(input.additionalFee);
    const otherCosts = metric(input.otherCosts);
    const additionalCredit = metric(input.additionalCredit);
    const customerHours = metric(input.customerHours);
    const hourlyRate = metric(input.hourlyRate);
    const timeEvaluation = input.timeEvaluation === 'excluded' ? 'excluded' : 'included';
    const errors = [];
    const validations = [
      [additionalFee, '追加報酬等'],
      [otherCosts, 'その他追加支出'],
      [additionalCredit, '追加費用に係る未反映の仕入控除税額']
    ];
    if(timeEvaluation === 'included') validations.push([customerHours, '顧客の追加時間'], [hourlyRate, '顧客の時間単価']);
    validations.forEach(([state, label]) => {
      if(!state.valid) errors.push(`${label}は0以上の数値で入力してください。`);
    });

    const costComplete = additionalFee.entered && otherCosts.entered && additionalCredit.entered;
    const timeComplete = timeEvaluation === 'excluded' || (customerHours.entered && hourlyRate.entered);
    const creditIncludedInBTax = input.creditIncludedInBTax === true;
    const creditToAdd = additionalCredit.entered && !creditIncludedInBTax ? additionalCredit.value : 0;
    const additionalCashSpend = (additionalFee.entered ? additionalFee.value : 0)
      + (otherCosts.entered ? otherCosts.value : 0);
    const cashReferenceComplete = tax.periodCount > 0 && additionalFee.entered && otherCosts.entered && errors.length === 0;
    const cashBenefitBeforeCredit = cashReferenceComplete ? tax.taxBenefit - additionalCashSpend : null;
    const monetaryComplete = cashReferenceComplete && additionalCredit.entered;
    const cashBenefit = monetaryComplete ? tax.taxBenefit - additionalCashSpend + creditToAdd : null;
    const cashBenefitDisplay = cashBenefit !== null ? cashBenefit : cashBenefitBeforeCredit;
    const cashBenefitBasis = cashBenefit !== null
      ? (input.creditAssumption === 'zeroFee' ? 'zeroFee' : input.creditAssumption === 'noCredit' ? 'noCredit' : 'confirmed')
      : cashBenefitBeforeCredit !== null ? 'reference' : 'unavailable';
    const timeCost = timeEvaluation === 'included' && timeComplete && errors.length === 0 ? customerHours.value * hourlyRate.value : null;
    const economicBenefit = monetaryComplete && timeCost !== null ? cashBenefit - timeCost : null;

    let totalAllowableHours = null;
    let remainingAllowableHours = null;
    let breakEvenReason = '';
    if(monetaryComplete && timeCost !== null && hourlyRate.value > 0){
      totalAllowableHours = cashBenefit / hourlyRate.value;
      remainingAllowableHours = totalAllowableHours - customerHours.value;
    }else if(monetaryComplete && timeCost !== null && hourlyRate.value === 0){
      breakEvenReason = '時間単価0円のため時間の損益分岐点は算定しません。';
    }
    const allowableFee = monetaryComplete ? tax.taxBenefit
      - (otherCosts.entered ? otherCosts.value : 0)
      + creditToAdd
      - (timeCost ?? 0) : null;

    const complete = monetaryComplete && timeComplete;
    const missing = [];
    if(!tax.periodCount) missing.push('A案・B案の比較期間');
    if(!additionalFee.entered) missing.push('追加報酬等');
    if(!otherCosts.entered) missing.push('その他追加支出');
    if(!additionalCredit.entered) missing.push('追加費用に係る控除税額');
    if(timeEvaluation === 'included' && !customerHours.entered) missing.push('顧客の追加時間');
    if(timeEvaluation === 'included' && !hourlyRate.entered) missing.push('顧客の時間単価');

    let suggestion;
    if(errors.length){
      suggestion = '入力エラーを確認してください。';
    }else if(tax.taxBenefit < 0){
      suggestion = 'この前提では、一般課税への切替による税額面のメリットは生じません。';
    }else if(cashBenefitBasis === 'reference'){
      suggestion = `追加支出後に残る差額の参考額は${Math.round(cashBenefitDisplay).toLocaleString('ja-JP')}円です。追加費用の仕入控除効果は未反映です。`;
    }else if(!complete){
      suggestion = '税額面の差は参考表示できますが、確認項目が残っているため総合比較は未完了です。';
    }else if(timeEvaluation === 'excluded'){
      suggestion = `追加支出後の金銭収支は${Math.round(cashBenefit).toLocaleString('ja-JP')}円です。顧客の作業時間は金額換算していません。`;
    }else if(economicBenefit >= 0){
      suggestion = `入力した追加負担を考慮しても、期間累計で${Math.round(economicBenefit).toLocaleString('ja-JP')}円のメリットがある試算です。`;
    }else{
      suggestion = `税額面では${Math.round(tax.taxBenefit).toLocaleString('ja-JP')}円有利ですが、追加負担を含めると${Math.round(Math.abs(economicBenefit)).toLocaleString('ja-JP')}円の負担増となる試算です。`;
    }

    const sensitivity = input.sensitivity && input.sensitivity.entered
      ? {
          entered:true,
          taxBenefitMin:finiteNumber(input.sensitivity.taxBenefitMin),
          taxBenefitMax:finiteNumber(input.sensitivity.taxBenefitMax)
        }
      : { entered:false, taxBenefitMin:null, taxBenefitMax:null };
    if(sensitivity.entered && monetaryComplete){
      sensitivity.economicMin = sensitivity.taxBenefitMin - additionalCashSpend + creditToAdd - (timeCost ?? 0);
      sensitivity.economicMax = sensitivity.taxBenefitMax - additionalCashSpend + creditToAdd - (timeCost ?? 0);
      sensitivity.crossesBreakEven = sensitivity.economicMin <= 0 && sensitivity.economicMax >= 0;
      if(sensitivity.crossesBreakEven){
        suggestion = '工数・売上等の前提によって結論が変わります。下限・上限の根拠を確認してください。';
      }
    }

    return {
      ...tax,
      additionalFee:additionalFee.value,
      additionalFeeEntered:additionalFee.entered && additionalFee.valid,
      otherCosts:otherCosts.value,
      otherCostsEntered:otherCosts.entered && otherCosts.valid,
      additionalCredit:additionalCredit.value,
      creditIncludedInBTax,
      creditToAdd,
      additionalCashSpend,
      cashBenefitBeforeCredit,
      cashBenefit,
      cashBenefitDisplay,
      cashBenefitBasis,
      monetaryComplete,
      timeEvaluation,
      customerHours:customerHours.value,
      customerHoursEntered:timeEvaluation === 'included' && customerHours.entered && customerHours.valid,
      hourlyRate:hourlyRate.value,
      hourlyRateEntered:timeEvaluation === 'included' && hourlyRate.entered && hourlyRate.valid,
      timeCost,
      economicBenefit,
      totalAllowableHours,
      remainingAllowableHours,
      allowableFee,
      breakEvenReason,
      costComplete,
      timeComplete,
      complete,
      missing,
      errors,
      suggestion,
      sensitivity
    };
  }

  function calculateOfficeProfitability(input = {}){
    const fee = metric(input.additionalFeeExTax);
    const hours = metric(input.hours);
    const hourlyCost = metric(input.hourlyCost);
    const otherCost = metric(input.otherCost);
    const errors = [];
    if(!fee.valid) errors.push('所内の追加報酬は0以上の数値で入力してください。');
    if(!hours.valid) errors.push('所内の追加時間は0以上の数値で入力してください。');
    if(!hourlyCost.valid) errors.push('所内原価単価は0以上の数値で入力してください。');
    if(!otherCost.valid) errors.push('所内の追加外注・システム原価は0以上の数値で入力してください。');
    const complete = fee.entered && hours.entered && hourlyCost.entered && otherCost.entered && errors.length === 0;
    const laborCost = hours.value * hourlyCost.value;
    const profit = fee.value - laborCost - otherCost.value;
    return {
      complete,
      additionalFeeExTax:fee.value,
      hours:hours.value,
      hourlyCost:hourlyCost.value,
      laborCost,
      otherCost:otherCost.value,
      profit,
      errors,
      suggestion:!complete
        ? '所内採算は未計算です。'
        : profit >= 0
          ? `所内の追加採算は${Math.round(profit).toLocaleString('ja-JP')}円です。`
          : `顧客側の比較とは別に、所内では${Math.round(Math.abs(profit)).toLocaleString('ja-JP')}円の原価超過となるため、追加報酬又は対応方法の再検討が必要です。`
    };
  }

  function buildCustomerReportData(input = {}){
    const economics = input.economics || {};
    const execution = input.execution || {};
    const suppliedEligibility = ['eligible','unknown','ineligible'].includes(execution.eligibility)
      ? execution.eligibility : 'unknown';
    const filingExecution = ['filed','planned'].includes(execution.filingExecution)
      ? execution.filingExecution : 'unknown';
    const suppliedDate = String(execution.effectiveFrom || '');
    const executionEligibility = suppliedEligibility === 'eligible' && (!suppliedDate || filingExecution === 'unknown')
      ? 'unknown' : suppliedEligibility;
    const effectiveFrom = executionEligibility === 'eligible' ? suppliedDate : '';
    const effectiveFromLabel = executionEligibility === 'ineligible'
      ? 'この特例による適用開始日はありません'
      : executionEligibility === 'unknown' ? '適用開始は未確定'
        : filingExecution === 'planned'
          ? `期限内提出を条件とした適用開始予定日: ${effectiveFrom}（未提出）`
          : `適用開始見込み: ${effectiveFrom}`;
    const comparisonNotice = executionEligibility === 'ineligible'
      ? '今回の届出特例は対象外です。税額差は適用可否とは別の仮定比較であり、一般課税への切替全般の可否は判定していません。'
      : executionEligibility === 'unknown'
        ? '今回の届出特例の適用は要確認です。税額差は適用可否とは別の仮定比較です。'
        : '';
    const reportStatus = executionEligibility === 'ineligible'
      ? '参考試算・今回の届出特例は対象外'
      : executionEligibility === 'unknown'
        ? '参考試算・未確認事項あり'
        : String(input.reportStatus || '所内検討用・未確認事項あり');
    const suggestion = executionEligibility === 'eligible'
      ? String(economics.suggestion || '')
      : '適用条件を確認するまで、一般課税への切替を実行できるものとして提案しません。税額・費用差は仮定比較として確認してください。';
    return Object.freeze({
      title:'一般課税への切替比較',
      scenarioLabel:String(input.scenarioLabel || ''),
      proposalNotice:String(input.proposalNotice || ''),
      sourceBasis:String(input.sourceBasis || ''),
      comparisonPeriod:String(input.comparisonPeriod || ''),
      planA:String(input.planA || 'A案：簡易課税を継続'),
      planB:String(input.planB || 'B案：一般課税へ切替'),
      planATax:economics.periodCount === 0 ? null : finiteNumber(economics.aTax),
      planBTax:economics.periodCount === 0 ? null : finiteNumber(economics.bTax),
      taxBenefit:economics.periodCount === 0 ? null : finiteNumber(economics.taxBenefit),
      additionalFee:economics.additionalFeeEntered === false ? null : finiteNumber(economics.additionalFee),
      otherCosts:economics.otherCostsEntered === false ? null : finiteNumber(economics.otherCosts),
      cashBenefit:economics.cashBenefit === null ? null : finiteNumber(economics.cashBenefit),
      cashBenefitBeforeCredit:economics.cashBenefitBeforeCredit === null ? null : finiteNumber(economics.cashBenefitBeforeCredit),
      cashBenefitDisplay:economics.cashBenefitDisplay == null ? null : finiteNumber(economics.cashBenefitDisplay),
      cashBenefitBasis:String(economics.cashBenefitBasis || 'unavailable'),
      customerHours:economics.customerHoursEntered === false ? null : finiteNumber(economics.customerHours),
      hourlyRate:economics.hourlyRateEntered === false ? null : finiteNumber(economics.hourlyRate),
      timeCost:economics.timeCost === null ? null : finiteNumber(economics.timeCost),
      economicBenefit:economics.economicBenefit === null ? null : finiteNumber(economics.economicBenefit),
      complete:economics.complete === true,
      reportStatus,
      suggestion,
      executionEligibility,
      executionStatus:executionEligibility === 'eligible' ? '利用可能見込み' : executionEligibility === 'ineligible' ? '今回の届出特例は対象外' : '要確認',
      effectiveFrom,
      effectiveFromLabel,
      twoYearBindingWaived:executionEligibility === 'eligible' && execution.twoYearBindingWaived === true,
      comparisonNotice,
      filingStatus:String(execution.filingStatus || ''),
      executionReasons:Array.isArray(execution.reasons) ? execution.reasons.map(String) : [],
      confirmations:Array.isArray(execution.customerConfirmations) ? execution.customerConfirmations.map(String)
        : Array.isArray(execution.confirmations) ? execution.confirmations.map(String) : [],
      assumptions:Array.isArray(input.assumptions) ? input.assumptions.map(String) : [],
      customerComment:String(input.customerComment || '')
    });
  }

  function buildInternalReportData(input = {}){
    return Object.freeze({
      customer:buildCustomerReportData(input),
      office:input.office || null,
      internalComment:String(input.internalComment || '')
    });
  }

  function migrateSavedState(data = {}){
    const source = data && typeof data === 'object' ? data : {};
    const legacyFoodScenario = source.taxScenario === 'food1';
    const legacyFeeBasisUnknown = source.switchAdditionalFee && !source.switchFeeTaxBasis;
    const sourceVersion = Number(source.schemaVersion || 0);
    const purposeScenarioMismatch = sourceVersion < 17 && ((source.workflowPurpose === 'foodSwitch') !== (source.taxScenario === 'foodProposal' || legacyFoodScenario));
    const oldFoodInner = sourceVersion < 17 && Object.keys(source).some(key => /(?:SaleFood1|purchaseFood1|exemptPurchase(?:80|70|50|30|0)_1)$/.test(key) && String(source[key] || '').trim());
    const unresolvedLegacyFee = legacyFeeBasisUnknown ? source.switchAdditionalFee
      : !source.switchAdditionalFee ? source.legacyAdditionalFeeValue : '';
    return {
      ...source,
      schemaVersion:17,
      switchAdditionalFee:legacyFeeBasisUnknown ? '' : source.switchAdditionalFee,
      legacyAdditionalFeeValue:legacyFeeBasisUnknown ? source.switchAdditionalFee : (source.legacyAdditionalFeeValue || ''),
      taxScenario:legacyFoodScenario ? 'foodProposal' : (source.taxScenario || 'current'),
      workflowPurpose:sourceVersion < 17 ? 'regular' : (source.workflowPurpose || 'regular'),
      switchFeeTaxBasis:source.switchFeeTaxBasis || (sourceVersion < 17 ? 'excluded' : 'included'),
      switchCreditState:source.switchCreditState || 'unknown',
      proposalFoodClassificationState:purposeScenarioMismatch || oldFoodInner ? 'unknown' : (source.proposalFoodClassificationState || 'unknown'),
      proposalPurchaseClassificationState:purposeScenarioMismatch || oldFoodInner ? 'unknown' : (source.proposalPurchaseClassificationState || 'unknown'),
      switchDecisionOpen:source.switchDecisionOpen === true,
      migrationNotice:[
        legacyFoodScenario ? '旧1％試算は軽減8％欄全体を対象としていたため、食品・新聞等・旧税率の区分を再確認してください。' : '',
        unresolvedLegacyFee ? `旧版の追加報酬「${String(unresolvedLegacyFee)}」は税抜・税込・精算後の基準が特定できません。新しい見積額と税区分を再入力してください。` : '',
        purposeScenarioMismatch ? '旧版で検討目的と税率前提が不一致でした。税率前提と食品区分を再確認してください。' : '',
        oldFoodInner ? '旧版の1％内数は実績・予測の出所を判別できません。CSVから再取込するか、食品内数を再確認してください。' : ''
      ].filter(Boolean).join(' ')
    };
  }

  return Object.freeze({
    sumPeriodTaxes,
    calculateRepeatedCosts,
    calculateQuotedCost,
    calculateCustomerEconomics,
    calculateOfficeProfitability,
    buildCustomerReportData,
    buildInternalReportData,
    migrateSavedState
  });
});
