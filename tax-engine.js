(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiTaxEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const CONFIRMATION = Object.freeze({
    UNKNOWN:'unknown',
    YES:'yes',
    NO:'no'
  });

  const ELIGIBILITY = Object.freeze({
    ELIGIBLE:'eligible',
    UNKNOWN:'unknown',
    INELIGIBLE:'ineligible'
  });

  const EXEMPT_PURCHASE_RATES = Object.freeze([
    { start:'0001-01-01', end:'2023-10-01', ratio:1.00 },
    { start:'2023-10-01', end:'2026-10-01', ratio:0.80 },
    { start:'2026-10-01', end:'2028-10-01', ratio:0.70 },
    { start:'2028-10-01', end:'2030-10-01', ratio:0.50 },
    { start:'2030-10-01', end:'2031-10-01', ratio:0.30 },
    { start:'2031-10-01', end:'9999-12-31', ratio:0.00 }
  ]);

  function normalizeNumberString(raw){
    return String(raw ?? '')
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[．。]/g, '.')
      .replace(/[－−―]/g, '-')
      .replace(/[，,￥¥\s円]/g, '')
      .trim();
  }

  function parseAmountInput(raw, options = {}){
    const { allowNegative = false, min = null, max = null } = options;
    const normalized = normalizeNumberString(raw);
    if(normalized === ''){
      return { entered:false, valid:true, value:0, normalized:'', error:'' };
    }
    if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)){
      return { entered:true, valid:false, value:0, normalized, error:'数値として入力してください' };
    }
    const value = Number(normalized);
    if(!Number.isFinite(value)){
      return { entered:true, valid:false, value:0, normalized, error:'数値として入力してください' };
    }
    if(!allowNegative && value < 0){
      return { entered:true, valid:false, value, normalized, error:'負数は入力できません' };
    }
    if(min !== null && value < min){
      return { entered:true, valid:false, value, normalized, error:`${min}以上で入力してください` };
    }
    if(max !== null && value > max){
      return { entered:true, valid:false, value, normalized, error:`${max}以下で入力してください` };
    }
    return { entered:true, valid:true, value, normalized, error:'' };
  }

  function taxFromAmount(amount, rate, amountMode){
    if(amountMode === 'excluded') return amount * (rate / 100);
    return amount * (rate / (100 + rate));
  }

  function taxableBaseFromAmount(amount, rate, amountMode){
    if(amountMode === 'excluded') return amount;
    return amount - taxFromAmount(amount, rate, amountMode);
  }

  function calculateRegularAmount({ salesTax, invoiceTax, exemptCreditableTax, creditRatio, adjustment }){
    const creditablePurchaseTax = invoiceTax + exemptCreditableTax;
    const regularCredit = creditablePurchaseTax * creditRatio;
    return {
      creditablePurchaseTax,
      regularCredit,
      amount:salesTax - regularCredit + adjustment
    };
  }

  function finiteNumber(value, fallback = 0){
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nonNegativeNumber(value){
    return Math.max(0, finiteNumber(value));
  }

  function calculateDetailedRegular(input = {}){
    const salesTax = nonNegativeNumber(input.salesTax);
    const purchaseTax = nonNegativeNumber(input.purchaseTax);
    const adjustment = finiteNumber(input.adjustment);
    const taxableSales = nonNegativeNumber(input.taxableSales);
    const totalSales = nonNegativeNumber(input.totalSales);
    const taxableSalesRatio = totalSales > 0
      ? Math.min(1, Math.max(0, taxableSales / totalSales))
      : 0;
    const fullCreditEligible = taxableSales <= 500000000 && taxableSalesRatio + Number.EPSILON >= 0.95;

    let regularCredit;
    let appliedMethod;
    if(fullCreditEligible){
      regularCredit = purchaseTax;
      appliedMethod = 'full';
    }else if(input.method === 'individual'){
      const individualCredit = nonNegativeNumber(input.taxableOnlyTax)
        + nonNegativeNumber(input.commonTax) * taxableSalesRatio;
      regularCredit = Math.min(purchaseTax, individualCredit);
      appliedMethod = 'individual';
    }else{
      regularCredit = Math.min(purchaseTax, purchaseTax * taxableSalesRatio);
      appliedMethod = 'proportional';
    }

    return {
      amount:salesTax - regularCredit + adjustment,
      regularCredit,
      taxableSalesRatio,
      fullCreditEligible,
      appliedMethod
    };
  }

  function truncateBySign(value, positiveUnit){
    if(value >= 0) return Math.floor(value / positiveUnit) * positiveUnit;
    const magnitude = Math.floor(Math.abs(value));
    return magnitude === 0 ? 0 : -magnitude;
  }

  function calculateDeclarationAmount(input = {}){
    const rawNational = nonNegativeNumber(input.nationalSalesTax)
      - nonNegativeNumber(input.nationalCredit)
      + finiteNumber(input.nationalAdjustment);
    const nationalAmount = truncateBySign(rawNational, 100);
    const rawLocal = Math.abs(nationalAmount) * 22 / 78;
    const localMagnitude = nationalAmount >= 0
      ? Math.floor(rawLocal / 100) * 100
      : Math.floor(rawLocal);
    const localAmount = nationalAmount < 0 ? -localMagnitude : localMagnitude;
    return {
      rawNational,
      nationalAmount,
      localAmount,
      total:nationalAmount + localAmount
    };
  }

  function calculateNationalSalesTax(input = {}){
    const taxableBase10 = Math.floor(nonNegativeNumber(input.taxableBase10) / 1000) * 1000;
    const taxableBaseReduced = Math.floor(nonNegativeNumber(input.taxableBaseReduced) / 1000) * 1000;
    const suppliedReducedRate = finiteNumber(input.reducedNationalRate, 6.24);
    const reducedRate = suppliedReducedRate > 1 ? suppliedReducedRate / 100 : Math.max(0, suppliedReducedRate);
    const nationalTax10 = Math.floor(taxableBase10 * 0.078);
    const nationalTaxReduced = Math.floor(taxableBaseReduced * reducedRate);
    return {
      taxableBase10,
      taxableBaseReduced,
      nationalTax10,
      nationalTaxReduced,
      total:nationalTax10 + nationalTaxReduced
    };
  }

  function highValueAssessment(status, reason, restrictionPeriods = 0){
    return {
      status,
      restrictionPeriods,
      simplifiedNoticeRestricted:status === 'restricted',
      reason
    };
  }

  function assessHighValueAsset(input = {}){
    if(input.hasAcquisition === 'no'){
      return highValueAssessment('clear', '高額資産の取得はありません。');
    }
    if(input.hasAcquisition !== 'yes'){
      return highValueAssessment('unknown', '高額資産の取得有無が未確認です。');
    }
    if(input.selfConstructed){
      return highValueAssessment('unknown', '自己建設資産は取得時期と金額の個別確認が必要です。');
    }
    if(!input.amountEntered){
      return highValueAssessment('unknown', '取得価額が未入力です。');
    }

    const amount = Number(input.amount);
    if(!Number.isFinite(amount) || amount < 0){
      return highValueAssessment('unknown', '取得価額を0円以上の数値で確認してください。');
    }
    let threshold;
    if(input.assetType === 'gold') threshold = 2000000;
    else if(input.assetType === 'inventory' || input.assetType === 'fixed') threshold = 10000000;
    else if(input.assetType === 'other'){
      return highValueAssessment('clear', '高額特定資産または調整対象固定資産の判定対象外です。');
    }else{
      return highValueAssessment('unknown', '資産区分が未確認です。');
    }

    if(amount < threshold){
      return highValueAssessment('clear', `取得価額が判定基準の${threshold.toLocaleString('ja-JP')}円未満です。`);
    }
    if(input.acquisitionMethod === 'regular'){
      return highValueAssessment(
        'restricted',
        '一般課税で高額資産を取得するため、翌2期は簡易課税等の選択制限を確認してください。',
        2
      );
    }
    if(input.acquisitionMethod === 'simplified' || input.acquisitionMethod === 'special2'){
      return highValueAssessment('clear', '簡易課税または2割特例の適用期の取得として制限対象外です。');
    }
    if(input.acquisitionMethod === 'special3'){
      return highValueAssessment('unknown', '3割特例適用期の高額資産取得は個別確認が必要です。');
    }
    return highValueAssessment('unknown', '取得時の課税方式が未確認のため、安全側で要確認とします。');
  }

  function routeStateKey(state){
    return `${state.election ? 1 : 0}|${state.binding}|${state.assetRestriction}`;
  }

  function isEligibleRouteMethod(method){
    return method && (method.eligible === true || method.eligible === ELIGIBILITY.ELIGIBLE);
  }

  function routeAction(methodKey, context){
    if(methodKey === 'regular'){
      if(context.discontinue) return '簡易課税の不適用届出を行い、本則課税を適用';
      if(context.preserveElection) return '簡易課税の届出効力を維持し、本則課税を適用';
      return '本則課税を適用';
    }
    if(methodKey === 'simplified'){
      return context.newElection
        ? '簡易課税制度選択届出書を提出し、簡易課税を適用'
        : '有効な届出により簡易課税を適用';
    }
    if(methodKey === 'special2') return '2割特例を適用（簡易課税の届出状態は維持）';
    if(methodKey === 'special3') return '3割特例を適用（簡易課税の届出状態は維持）';
    return `${methodKey}を適用`;
  }

  function transitionRouteState(state, period, method, noticeReady){
    const key = method.key;
    const simplifiedUnavailablePreservesElection = period.simplifiedUnavailablePreservesElection === true;
    const context = { newElection:false, discontinue:false, preserveElection:false };
    let election = state.election;
    let binding = Math.max(0, state.binding - 1);

    if(key === 'simplified'){
      if(state.assetRestriction > 0) return null;
      if(!election){
        if(noticeReady !== 'yes') return null;
        election = true;
        binding = 1;
        context.newElection = true;
      }
    }else if(key === 'regular' && election){
      if(state.binding > 0 && !simplifiedUnavailablePreservesElection) return null;
      if(!simplifiedUnavailablePreservesElection){
        election = false;
        binding = 0;
        context.discontinue = true;
      }else{
        context.preserveElection = true;
      }
    }

    if((key === 'special2' || key === 'special3') && state.assetRestriction > 0) return null;

    const highValueAssetTriggered = key === 'regular' && period.highValueAssetTrigger === true;
    if(highValueAssetTriggered){
      election = false;
      binding = 0;
    }
    const assetRestriction = highValueAssetTriggered
      ? 2
      : Math.max(0, state.assetRestriction - 1);
    return {
      state:{ election, binding, assetRestriction },
      action:routeAction(key, context) + (highValueAssetTriggered ? '。高額資産取得による簡易課税届出の制限を反映' : '')
    };
  }

  function optimizeFourPeriodRoutes(input = {}){
    const emptyResult = reason => ({
      ok:false,
      bestRoute:[],
      cumulative:null,
      alternatives:[],
      reason
    });
    if(input.initialElectionStatus === 'unknown'){
      return emptyResult('簡易課税制度選択届出書の現在の状態が未確認です。');
    }
    if(!Array.isArray(input.periods) || input.periods.length !== 4){
      return emptyResult('4期分の候補が必要です。');
    }

    const initialStates = {
      none:{ election:false, binding:0, assetRestriction:0 },
      first:{ election:true, binding:2, assetRestriction:0 },
      second:{ election:true, binding:1, assetRestriction:0 },
      free:{ election:true, binding:0, assetRestriction:0 }
    };
    const initialState = initialStates[input.initialElectionStatus];
    if(!initialState) return emptyResult('簡易課税制度選択届出書の状態が不正です。');

    let candidates = new Map([[
      routeStateKey(initialState),
      { state:initialState, cumulative:0, route:[] }
    ]]);

    for(const period of input.periods){
      if(!period || !Array.isArray(period.methods)) return emptyResult('各期の課税方式候補が必要です。');
      const nextCandidates = new Map();
      candidates.forEach(candidate => {
        period.methods.filter(isEligibleRouteMethod).forEach(method => {
          const transition = transitionRouteState(candidate.state, period, method, input.noticeReady);
          if(!transition) return;
          const amount = finiteNumber(method.amount);
          const next = {
            state:transition.state,
            cumulative:candidate.cumulative + amount,
            route:[...candidate.route, {
              label:String(period.label ?? ''),
              action:transition.action,
              method:method.key,
              amount
            }]
          };
          const stateKey = routeStateKey(next.state);
          const current = nextCandidates.get(stateKey);
          if(!current || next.cumulative < current.cumulative) nextCandidates.set(stateKey, next);
        });
      });
      if(nextCandidates.size === 0) return emptyResult('選択可能な4期経路がありません。');
      candidates = nextCandidates;
    }

    const ranked = [...candidates.values()].sort((a, b) => a.cumulative - b.cumulative);
    const best = ranked[0];
    return {
      ok:true,
      bestRoute:best.route,
      cumulative:best.cumulative,
      alternatives:ranked.slice(1).map(candidate => ({
        route:candidate.route,
        cumulative:candidate.cumulative
      })),
      reason:''
    };
  }

  function formatShare(share){
    return `${(share * 100).toFixed(1)}％`;
  }

  function calculateSimplifiedTax(rows){
    const totalSalesTax = rows.reduce((sum, row) => sum + row.rowTax, 0);
    const totalTaxableBase = rows.reduce((sum, row) => sum + row.rowTaxableBase, 0);
    const normalCredit = rows.reduce((sum, row) => sum + row.rowTax * row.deemed, 0);
    const candidates = [{
      kind:'normal',
      deemedCredit:normalCredit,
      methodLabel:'通常計算',
      share:0
    }];
    const activeRows = rows.filter(row => row.rowTaxableBase > 0);

    if(totalTaxableBase > 0 && activeRows.length >= 2){
      activeRows.forEach(row => {
        const share = row.rowTaxableBase / totalTaxableBase;
        if(share + Number.EPSILON >= 0.75){
          candidates.push({
            kind:'single75',
            deemedCredit:totalSalesTax * row.deemed,
            methodLabel:`75％特例（${row.name}事業が${formatShare(share)}）`,
            share,
            keys:[row.key]
          });
        }
      });
    }

    if(totalTaxableBase > 0 && activeRows.length >= 3){
      for(let i = 0; i < activeRows.length - 1; i++){
        for(let j = i + 1; j < activeRows.length; j++){
          const first = activeRows[i];
          const second = activeRows[j];
          const share = (first.rowTaxableBase + second.rowTaxableBase) / totalTaxableBase;
          if(share + Number.EPSILON < 0.75) continue;
          const high = first.deemed >= second.deemed ? first : second;
          const low = high === first ? second : first;
          const deemedCredit = high.rowTax * high.deemed + (totalSalesTax - high.rowTax) * low.deemed;
          candidates.push({
            kind:'pair75',
            deemedCredit,
            methodLabel:`75％特例（${high.name}・${low.name}事業の合計が${formatShare(share)}）`,
            share,
            keys:[high.key, low.key]
          });
        }
      }
    }

    const selected = candidates.reduce((best, candidate) => (
      candidate.deemedCredit > best.deemedCredit + 1e-8 ? candidate : best
    ), candidates[0]);
    return {
      totalSalesTax,
      totalTaxableBase,
      normalCredit,
      deemedCredit:selected.deemedCredit,
      amount:totalSalesTax - selected.deemedCredit,
      method:selected.kind,
      methodLabel:selected.methodLabel,
      candidates
    };
  }

  function isoDateToEpochDay(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const [year, month, day] = value.split('-').map(Number);
    const time = Date.UTC(year, month - 1, day);
    const date = new Date(time);
    if(date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return Math.floor(time / 86400000);
  }

  function weightedExemptPurchaseRatio(startInclusive, endInclusive){
    const startDay = isoDateToEpochDay(startInclusive);
    const inclusiveEndDay = isoDateToEpochDay(endInclusive);
    if(startDay === null || inclusiveEndDay === null || inclusiveEndDay < startDay){
      return { valid:false, ratio:0, totalDays:0, breakdown:[] };
    }
    const endDay = inclusiveEndDay + 1;
    const totalDays = endDay - startDay;
    const breakdown = [];
    let weightedDays = 0;
    EXEMPT_PURCHASE_RATES.forEach(period => {
      const rateStart = isoDateToEpochDay(period.start);
      const rateEnd = isoDateToEpochDay(period.end);
      const overlapStart = Math.max(startDay, rateStart);
      const overlapEnd = Math.min(endDay, rateEnd);
      const days = Math.max(0, overlapEnd - overlapStart);
      if(!days) return;
      weightedDays += days * period.ratio;
      breakdown.push({ days, ratio:period.ratio, start:period.start, end:period.end });
    });
    return {
      valid:true,
      ratio:totalDays ? weightedDays / totalDays : 0,
      totalDays,
      breakdown
    };
  }

  function periodIncludes(start, end, targetStart, targetEnd){
    if(!start || !end || start > end) return false;
    return start <= targetEnd && end >= targetStart;
  }

  function eligibilityFrom(hardFailures, confirmations){
    const noReasons = confirmations.filter(item => item.value === CONFIRMATION.NO).map(item => item.noReason);
    if(hardFailures.length || noReasons.length){
      return { eligibility:ELIGIBILITY.INELIGIBLE, reasons:[...hardFailures, ...noReasons].filter(Boolean) };
    }
    const unknownReasons = confirmations.filter(item => item.value !== CONFIRMATION.YES).map(item => item.unknownReason);
    if(unknownReasons.length){
      return { eligibility:ELIGIBILITY.UNKNOWN, reasons:unknownReasons.filter(Boolean) };
    }
    return { eligibility:ELIGIBILITY.ELIGIBLE, reasons:[] };
  }

  function numericRequirement(entered, ok, overReason, unknownReason){
    if(!entered) return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason };
    return ok
      ? { value:CONFIRMATION.YES, noReason:'', unknownReason:'' }
      : { value:CONFIRMATION.NO, noReason:overReason, unknownReason:'' };
  }

  function specificPeriodRequirement(ctx){
    if(ctx.specificUnder10m){
      return { value:CONFIRMATION.YES, noReason:'', unknownReason:'' };
    }
    if(!ctx.specificInputEntered){
      return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason:'特定期間の課税売上高または給与等支払額が未確認です' };
    }
    if(ctx.specificSalesEntered && ctx.specificTaxableSales > 10000000 && !ctx.specificPayrollEntered){
      return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason:'特定期間の給与等支払額が未確認です' };
    }
    if(ctx.specificPayrollEntered && ctx.specificPayrollAmount > 10000000 && !ctx.specificSalesEntered){
      return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason:'特定期間の課税売上高が未確認です' };
    }
    return { value:CONFIRMATION.NO, noReason:'特定期間の要件により免税点制度の適用が制限されます', unknownReason:'' };
  }

  function calculateEligibility(ctx){
    const periodValid = !!ctx.start && !!ctx.end && ctx.start <= ctx.end;
    const commonSpecialConfirmations = [
      {
        value:ctx.invoiceRegistered,
        noReason:'インボイス発行事業者の登録を受けていません',
        unknownReason:'インボイス発行事業者の登録が未確認です'
      },
      {
        value:ctx.invoiceTransition,
        noReason:'インボイス登録がなくても課税事業者となる期間です',
        unknownReason:'登録がなければ免税事業者となるか未確認です'
      },
      numericRequirement(
        ctx.baseSalesEntered,
        ctx.baseTaxableSales <= 10000000,
        '基準期間の課税売上高が1,000万円超です',
        '基準期間の課税売上高が未確認です'
      ),
      specificPeriodRequirement(ctx),
      {
        value:ctx.noSpecialExclusion,
        noReason:'2割特例・3割特例の適用除外に該当します',
        unknownReason:'2割特例・3割特例の適用除外が未確認です'
      }
    ];

    const twoHardFailures = [];
    if(!periodValid || !periodIncludes(ctx.start, ctx.end, '2023-10-01', '2026-09-30')) twoHardFailures.push('2割特例の対象期間外です');
    if(ctx.entity === 'individual' && !ctx.individualCalendarYear) twoHardFailures.push('個人事業者の暦年以外の課税期間は対象外として扱います');

    const threeHardFailures = [];
    if(ctx.entity !== 'individual') threeHardFailures.push('法人は3割特例の対象外です');
    if(ctx.entity === 'individual' && !ctx.individualCalendarYear) threeHardFailures.push('個人事業者の暦年以外の課税期間は対象外として扱います');
    if(!periodValid || !periodIncludes(ctx.start, ctx.end, '2027-01-01', '2028-12-31')) threeHardFailures.push('令和9年分・令和10年分ではありません');

    const simplifiedConfirmations = [
      numericRequirement(
        ctx.baseSalesEntered,
        ctx.baseTaxableSales <= 50000000,
        '基準期間の課税売上高が5,000万円超です',
        '基準期間の課税売上高が未確認です'
      ),
      {
        value:ctx.simpleNoticeReady,
        noReason:'簡易課税制度選択届出書が当該課税期間に有効ではなく、適用可能な期限内にも提出できません',
        unknownReason:'簡易課税制度選択届出書の有効性・提出期限が未確認です'
      }
    ];

    const regular = eligibilityFrom([], [{
      value:ctx.regularCreditConfirmed,
      noReason:'本則課税の仕入控除率を設定してください',
      unknownReason:'本則課税の仕入控除率が未確認です'
    }]);

    return {
      periodValid,
      regular,
      simplified:eligibilityFrom([], simplifiedConfirmations),
      special2:eligibilityFrom(twoHardFailures, commonSpecialConfirmations),
      special3:eligibilityFrom(threeHardFailures, commonSpecialConfirmations)
    };
  }

  function sanitizeCsvCell(value){
    const text = String(value ?? '');
    return typeof value === 'string' && /^[=+\-@]/.test(text) ? `'${text}` : text;
  }

  function serializeStateIfEnabled(enabled, data){
    return enabled ? JSON.stringify(data) : null;
  }

  return Object.freeze({
    CONFIRMATION,
    ELIGIBILITY,
    EXEMPT_PURCHASE_RATES,
    normalizeNumberString,
    parseAmountInput,
    taxFromAmount,
    taxableBaseFromAmount,
    calculateRegularAmount,
    calculateDetailedRegular,
    calculateDeclarationAmount,
    calculateNationalSalesTax,
    assessHighValueAsset,
    optimizeFourPeriodRoutes,
    calculateSimplifiedTax,
    weightedExemptPurchaseRatio,
    periodIncludes,
    calculateEligibility,
    sanitizeCsvCell,
    serializeStateIfEnabled
  });
});
