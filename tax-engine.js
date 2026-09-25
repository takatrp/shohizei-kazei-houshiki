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

  // CSV actual-one-percent entries store a calculation ratio (0.7), while an
  // older saved value may use the displayed percentage (70). Do not coerce a
  // blank/null/invalid value to the valid 0% transitional rate.
  function normalizeExemptPurchaseRatio(value){
    if(typeof value !== 'number' && typeof value !== 'string') return null;
    const raw = String(value).trim();
    if(!/^\d+(?:\.\d+)?(?:%|％)?$/.test(raw)) return null;
    const percentNotation = /[%％]$/.test(raw);
    const number = Number(raw.replace(/[%％]$/, ''));
    if(!Number.isFinite(number)) return null;
    const ratio = percentNotation || number > 1 ? number / 100 : number;
    return ratio >= 0 && ratio <= 1 ? ratio : null;
  }

  const FOOD_PROPOSAL = Object.freeze({
    status:'proposal',
    basisDate:'2026-09-15',
    sourceDate:'2026-09',
    start:'2027-04-01',
    end:'2029-03-31',
    foodRatePercent:1,
    foodNationalRatePercent:0.78,
    foodLocalRatePercent:0.22,
    reducedRatePercent:8,
    standardRatePercent:10
  });

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
    const suppliedPeriodMonths = finiteNumber(input.periodMonths, 12);
    const periodMonths = suppliedPeriodMonths > 0 && suppliedPeriodMonths < 12
      ? suppliedPeriodMonths
      : 12;
    const annualizedTaxableSales = periodMonths < 12
      ? taxableSales * 12 / periodMonths
      : taxableSales;
    const fullCreditEligible = annualizedTaxableSales <= 500000000
      && taxableSalesRatio + Number.EPSILON >= 0.95;

    let regularCredit;
    let appliedMethod;
    let creditBeforeCap;
    if(fullCreditEligible){
      creditBeforeCap = purchaseTax;
      regularCredit = creditBeforeCap;
      appliedMethod = 'full';
    }else if(input.method === 'individual'){
      creditBeforeCap = nonNegativeNumber(input.taxableOnlyTax)
        + nonNegativeNumber(input.commonTax) * taxableSalesRatio;
      regularCredit = Math.min(purchaseTax, creditBeforeCap);
      appliedMethod = 'individual';
    }else{
      creditBeforeCap = purchaseTax * taxableSalesRatio;
      regularCredit = Math.min(purchaseTax, creditBeforeCap);
      appliedMethod = 'proportional';
    }

    return {
      amount:salesTax - regularCredit + adjustment,
      regularCredit,
      taxableSalesRatio,
      periodMonths,
      annualizedTaxableSales,
      fullCreditEligible,
      appliedMethod,
      purchaseTax,
      taxableSales,
      totalSales,
      creditBeforeCap
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
      rawLocal,
      localAmount,
      total:nationalAmount + localAmount
    };
  }

  function calculateNationalSalesTax(input = {}){
    const hasFoodOnePercent = Object.prototype.hasOwnProperty.call(input, 'taxableBaseFood1')
      || Object.prototype.hasOwnProperty.call(input, 'foodNationalRatePercent');
    const taxableBase10 = Math.floor(nonNegativeNumber(input.taxableBase10) / 1000) * 1000;
    const taxableBaseReduced = Math.floor(nonNegativeNumber(input.taxableBaseReduced) / 1000) * 1000;
    const taxableBaseFood1 = Math.floor(nonNegativeNumber(input.taxableBaseFood1) / 1000) * 1000;
    const reducedNationalRatePercent = nonNegativeNumber(
      input.reducedNationalRatePercent ?? input.reducedNationalRate ?? 6.24
    );
    const foodNationalRatePercent = nonNegativeNumber(input.foodNationalRatePercent ?? 0.78);
    const nationalTax10 = Math.floor(taxableBase10 * 0.078);
    const nationalTaxReduced = Math.floor(taxableBaseReduced * reducedNationalRatePercent / 100);
    const nationalTaxFood1 = Math.floor(taxableBaseFood1 * foodNationalRatePercent / 100);
    const result = {
      taxableBase10,
      taxableBaseReduced,
      nationalTax10,
      nationalTaxReduced,
      total:nationalTax10 + nationalTaxReduced + nationalTaxFood1
    };
    if(hasFoodOnePercent){
      result.taxableBaseFood1 = taxableBaseFood1;
      result.nationalTaxFood1 = nationalTaxFood1;
    }
    return result;
  }

  function taxRateForProposalItem(input = {}){
    const category = String(input.category || 'unconfirmed');
    if(category === 'standard') return { ratePercent:10, status:'confirmed', reason:'' };
    if(category === 'newspaperOrOtherReduced') return { ratePercent:8, status:'confirmed', reason:'' };
    if(category !== 'food'){
      return { ratePercent:null, status:'unknown', reason:'飲食料品・新聞等・標準税率の区分が未確認です。' };
    }
    if(input.legacyReducedRate === true){
      return { ratePercent:8, status:'confirmed', reason:'旧税率適用の指定により8％で計算します。' };
    }
    const day = isoDateToEpochDay(input.date);
    const startDay = isoDateToEpochDay(FOOD_PROPOSAL.start);
    const endDay = isoDateToEpochDay(FOOD_PROPOSAL.end);
    if(day === null){
      return { ratePercent:null, status:'unknown', reason:'取引日を確認してください。' };
    }
    return day >= startDay && day <= endDay
      ? { ratePercent:1, status:'confirmed', reason:'' }
      : { ratePercent:8, status:'confirmed', reason:'' };
  }

  function assessCsvOnePercentEntry(input = {}){
    const expected = taxRateForProposalItem({ date:input.date, category:'food' });
    if(expected.status !== 'confirmed'){
      return { status:'unknown', reasonCode:'dateUnknown', reason:'取引日を確認してください。元のCSV仕訳と税率の照合が必要です。' };
    }
    if(input.transactionKind === 'adjustment'){
      return { status:'unknown', reasonCode:'adjustment', reason:'返品・調整のため、元取引の日付と適用税率の確認が必要です。返品日が1％対象期間内でも、元取引が8％なら1％とは確定できません。' };
    }
    if(input.transactionKind !== 'ordinary'){
      return { status:'unknown', reasonCode:'kindUnknown', reason:'取引種別が不明です。元のCSV仕訳の課税区分・貸借と元取引の確認が必要です。' };
    }
    if(expected.ratePercent === 1) return { status:'confirmed', reasonCode:'dateAligned', reason:'' };
    return { status:'invalid', reasonCode:'outsidePeriod', reason:'取引日が飲食料品1％の制度期間外です。元のCSV仕訳の税率・取引日を確認してください。' };
  }

  function projectPrice(input = {}){
    const netAmount = nonNegativeNumber(input.netAmount);
    const grossAmount = nonNegativeNumber(input.grossAmount);
    const ratePercent = nonNegativeNumber(input.ratePercent);
    if(input.priceBasis === 'grossFixed'){
      const projectedNet = grossAmount / (1 + ratePercent / 100);
      return { netAmount:projectedNet, grossAmount, taxAmount:grossAmount - projectedNet };
    }
    const taxAmount = netAmount * ratePercent / 100;
    return { netAmount, grossAmount:netAmount + taxAmount, taxAmount };
  }

  function calculateSpecialMethodAmount(input = {}){
    const totalSalesTax = nonNegativeNumber(input.totalSalesTax);
    const foodOnePercentTax = Math.min(totalSalesTax, nonNegativeNumber(input.foodOnePercentTax));
    const burdenRatio = Math.min(1, Math.max(0, finiteNumber(input.burdenRatio)));
    return {
      totalSalesTax,
      foodOnePercentTax,
      otherSalesTax:totalSalesTax - foodOnePercentTax,
      amount:(totalSalesTax - foodOnePercentTax) * burdenRatio
    };
  }

  function calculatePeriodTaxCase(input = {}){
    const sales = Array.isArray(input.sales) ? input.sales : [];
    const purchases = Array.isArray(input.purchases) ? input.purchases : [];
    const rowMap = new Map();
    const errors = [];
    sales.forEach((item, index) => {
      const ratePercent = nonNegativeNumber(item.ratePercent);
      const amount = finiteNumber(item.amount);
      const amountMode = item.amountMode === 'included' ? 'included' : 'excluded';
      const key = String(item.businessKey || 'unclassified');
      if(item.confirmed === false || !ratePercent || amount < 0 || !Number.isFinite(Number(item.amount))){
        errors.push(`売上${index + 1}の税率・金額・品目区分を確認してください。`);
        return;
      }
      const taxableBase = taxableBaseFromAmount(amount, ratePercent, amountMode);
      const tax = taxFromAmount(amount, ratePercent, amountMode);
      const current = rowMap.get(key) || {
        key,
        name:String(item.businessName || key),
        deemed:Math.min(1, Math.max(0, finiteNumber(item.deemed))),
        rowTax:0,
        rowTaxableBase:0,
        foodOnePercentTax:0,
        foodOnePercentTaxableBase:0
      };
      current.rowTax += tax;
      current.rowTaxableBase += taxableBase;
      if(item.foodOnePercent === true && Math.abs(ratePercent - 1) < 1e-9){
        current.foodOnePercentTax += tax;
        current.foodOnePercentTaxableBase += taxableBase;
      }
      rowMap.set(key, current);
    });
    let purchaseTax = 0;
    purchases.forEach((item, index) => {
      const ratePercent = nonNegativeNumber(item.ratePercent);
      const amount = finiteNumber(item.amount);
      const amountMode = item.amountMode === 'included' ? 'included' : 'excluded';
      const creditRatio = Math.min(1, Math.max(0, finiteNumber(item.creditRatio, 1)));
      if(item.confirmed === false || !ratePercent || amount < 0 || !Number.isFinite(Number(item.amount))){
        errors.push(`仕入${index + 1}の税率・金額・控除割合を確認してください。`);
        return;
      }
      purchaseTax += taxFromAmount(amount, ratePercent, amountMode) * creditRatio;
    });
    const rows = [...rowMap.values()];
    const simplified = calculateSimplifiedTax(rows);
    errors.push(...simplified.allocationErrors);
    const salesTax = simplified.totalSalesTax;
    const regularAmount = salesTax - purchaseTax + finiteNumber(input.adjustment);
    return {
      valid:errors.length === 0,
      errors,
      rows,
      salesTax,
      purchaseTax,
      regularAmount,
      simplified,
      special2:calculateSpecialMethodAmount({
        totalSalesTax:salesTax,
        foodOnePercentTax:simplified.foodOnePercentTax,
        burdenRatio:0.20
      }),
      special3:calculateSpecialMethodAmount({
        totalSalesTax:salesTax,
        foodOnePercentTax:simplified.foodOnePercentTax,
        burdenRatio:0.30
      })
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
      const fixedAssetCaveat = input.assetType === 'fixed' && amount >= 1000000
        ? ' ただし、課税事業者選択後2年以内や新設法人等が取得する100万円以上の調整対象固定資産には、別途3年間の制限が生じる場合があります。'
        : '';
      return highValueAssessment(
        'clear',
        `取得価額が高額特定資産の判定基準${threshold.toLocaleString('ja-JP')}円未満です。${fixedAssetCaveat}`
      );
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
    return [
      state.election ? 1 : 0,
      state.simplifiedApplied ? 1 : 0,
      state.binding,
      state.assetRestriction,
      state.previousMethod || ''
    ].join('|');
  }

  function isEligibleRouteMethod(method){
    return method && (method.eligible === true || method.eligible === ELIGIBILITY.ELIGIBLE);
  }

  function routeAction(methodKey, context){
    if(methodKey === 'regular'){
      if(context.discontinue) return '課税期間の初日の前日までに簡易課税制度選択不適用届出書を提出し、本則課税を適用';
      if(context.preserveElection) return '簡易課税の届出効力を維持し、本則課税を適用';
      return '本則課税を適用';
    }
    if(methodKey === 'simplified'){
      if(context.newElection){
        return context.relaxedElectionDeadline
          ? '直前期の2割・3割特例後の経過措置により、当期の確定申告期限までに簡易課税制度選択届出書を提出して簡易課税を適用'
          : '課税期間の初日の前日までに簡易課税制度選択届出書を提出して簡易課税を適用';
      }
      return '有効な届出により簡易課税を適用';
    }
    if(methodKey === 'special2') return '2割特例を適用（簡易課税の届出状態は維持）';
    if(methodKey === 'special3') return '3割特例を適用（簡易課税の届出状態は維持）';
    return `${methodKey}を適用`;
  }

  function futureElectionAction(methodKey){
    if(methodKey === 'special2' || methodKey === 'special3'){
      return '翌期の確定申告期限までに簡易課税制度選択届出書を提出する計画を反映';
    }
    return '翌期の課税期間の初日の前日までに簡易課税制度選択届出書を提出する計画を反映';
  }

  function transitionRouteStates(state, period, method, noticeReady){
    const key = method.key;
    const effectiveNoticeReady = noticeReady;
    const futureElectionReady = period.futureElectionReady ?? CONFIRMATION.UNKNOWN;
    const discontinuanceReady = period.discontinuanceReady ?? CONFIRMATION.UNKNOWN;
    const simplifiedUnavailablePreservesElection = period.simplifiedUnavailablePreservesElection === true;
    const context = {
      newElection:false,
      relaxedElectionDeadline:false,
      discontinue:false,
      preserveElection:false
    };
    let election = state.election;
    let simplifiedApplied = state.simplifiedApplied;
    let binding = Math.max(0, state.binding - 1);

    if(key === 'simplified'){
      if(state.assetRestriction > 0) return [];
      if(!election){
        const relaxedElectionDeadline = (state.previousMethod === 'special2' || state.previousMethod === 'special3')
          && futureElectionReady === CONFIRMATION.YES;
        if(effectiveNoticeReady !== CONFIRMATION.YES && !relaxedElectionDeadline) return [];
        election = true;
        context.newElection = true;
        context.relaxedElectionDeadline = relaxedElectionDeadline;
      }
      if(!simplifiedApplied){
        simplifiedApplied = true;
        binding = 1;
      }
    }else if(key === 'regular' && election){
      if(state.binding > 0 && !simplifiedUnavailablePreservesElection) return [];
      if(!simplifiedUnavailablePreservesElection){
        if(discontinuanceReady !== CONFIRMATION.YES) return [];
        election = false;
        simplifiedApplied = false;
        binding = 0;
        context.discontinue = true;
      }else{
        context.preserveElection = true;
      }
    }

    if((key === 'special2' || key === 'special3') && state.assetRestriction > 0) return [];

    const highValueAssetTriggered = key === 'regular' && period.highValueAssetTrigger === true;
    if(highValueAssetTriggered){
      election = false;
      simplifiedApplied = false;
      binding = 0;
    }
    const assetRestriction = highValueAssetTriggered
      ? 2
      : Math.max(0, state.assetRestriction - 1);
    const action = routeAction(key, context)
      + (highValueAssetTriggered ? '。高額資産取得による簡易課税届出の制限を反映' : '');
    const transitions = [{
      state:{ election, simplifiedApplied, binding, assetRestriction, previousMethod:key },
      action
    }];

    if(!election && !highValueAssetTriggered && assetRestriction === 0
      && futureElectionReady === CONFIRMATION.YES){
      transitions.push({
        state:{
          election:true,
          simplifiedApplied:false,
          binding:0,
          assetRestriction,
          previousMethod:key
        },
        action:`${action}。${futureElectionAction(key)}`
      });
    }
    return transitions;
  }

  const INITIAL_ROUTE_STATES = Object.freeze({
    none:{ election:false, simplifiedApplied:false, binding:0, assetRestriction:0, previousMethod:'' },
    first:{ election:true, simplifiedApplied:true, binding:2, assetRestriction:0, previousMethod:'simplified' },
    second:{ election:true, simplifiedApplied:true, binding:1, assetRestriction:0, previousMethod:'simplified' },
    free:{ election:true, simplifiedApplied:true, binding:0, assetRestriction:0, previousMethod:'simplified' }
  });

  // The transition is the single source of permission for both current and four-period comparisons.
  function assessRouteMethodChoice(state, period, methodKey, noticeReady){
    const transitions = transitionRouteStates(state, period, { key:methodKey }, noticeReady);
    if(transitions.length) return { eligibility:ELIGIBILITY.ELIGIBLE, reasons:[], transitions };
    if(methodKey === 'simplified'){
      if(state.assetRestriction > 0){
        return { eligibility:ELIGIBILITY.INELIGIBLE, reasons:['高額資産取得による簡易課税の選択制限があります。'], transitions };
      }
      if(!state.election){
        const relaxed = (state.previousMethod === 'special2' || state.previousMethod === 'special3')
          && period.futureElectionReady === CONFIRMATION.YES;
        if(!relaxed){
          const unknown = noticeReady !== CONFIRMATION.NO;
          return {
            eligibility:unknown ? ELIGIBILITY.UNKNOWN : ELIGIBILITY.INELIGIBLE,
            reasons:[unknown
              ? '簡易課税制度選択届出書の有効性・提出期限が未確認です。'
              : '簡易課税制度選択届出書が当該課税期間に有効ではなく、適用可能な期限内にも提出できません。'],
            transitions
          };
        }
      }
    }
    if(methodKey === 'regular' && state.election && period.simplifiedUnavailablePreservesElection !== true){
      if(state.binding > 0){
        return { eligibility:ELIGIBILITY.INELIGIBLE, reasons:['簡易課税の2年継続適用期間中のため、当期は本則課税を選択できません。'], transitions };
      }
      const unknown = period.discontinuanceReady !== CONFIRMATION.NO;
      return {
        eligibility:unknown ? ELIGIBILITY.UNKNOWN : ELIGIBILITY.INELIGIBLE,
        reasons:[unknown
          ? '簡易課税制度選択不適用届出書の当期適用が未確認です。'
          : '簡易課税制度選択不適用届出書を提出しないため、当期は本則課税を選択できません。'],
        transitions
      };
    }
    if((methodKey === 'special2' || methodKey === 'special3') && state.assetRestriction > 0){
      return { eligibility:ELIGIBILITY.INELIGIBLE, reasons:['高額資産取得による特例の選択制限があります。'], transitions };
    }
    return { eligibility:ELIGIBILITY.INELIGIBLE, reasons:['当期の届出・継続条件ではこの方式を選択できません。'], transitions };
  }

  function assessCurrentMethodChoice(input = {}){
    if(input.initialElectionStatus === 'unknown'){
      return { eligibility:ELIGIBILITY.UNKNOWN, reasons:['簡易課税制度選択届出書の現在の状態が未確認です。'], transitions:[] };
    }
    const state = INITIAL_ROUTE_STATES[input.initialElectionStatus];
    if(!state){
      return { eligibility:ELIGIBILITY.UNKNOWN, reasons:['簡易課税制度選択届出書の現在の状態を確認してください。'], transitions:[] };
    }
    return assessRouteMethodChoice(state, {
      discontinuanceReady:input.discontinuanceReady ?? CONFIRMATION.UNKNOWN,
      futureElectionReady:input.futureElectionReady ?? CONFIRMATION.UNKNOWN,
      simplifiedUnavailablePreservesElection:input.simplifiedUnavailablePreservesElection === true,
      highValueAssetTrigger:input.highValueAssetTrigger === true
    }, input.methodKey, input.noticeReady ?? CONFIRMATION.UNKNOWN);
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

    const initialState = INITIAL_ROUTE_STATES[input.initialElectionStatus];
    if(!initialState) return emptyResult('簡易課税制度選択届出書の状態が不正です。');

    let candidates = new Map([[
      routeStateKey(initialState),
      { state:initialState, cumulative:0, route:[] }
    ]]);

    for(const [periodIndex, period] of input.periods.entries()){
      if(!period || !Array.isArray(period.methods)) return emptyResult('各期の課税方式候補が必要です。');
      const nextCandidates = new Map();
      candidates.forEach(candidate => {
        period.methods.filter(isEligibleRouteMethod).forEach(method => {
          const currentNoticeReady = periodIndex === 0
            ? (period.noticeReady ?? input.noticeReady)
            : CONFIRMATION.UNKNOWN;
          const transitions = assessRouteMethodChoice(candidate.state, period, method.key, currentNoticeReady).transitions;
          transitions.forEach(transition => {
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
    const allocationErrors = rows.flatMap(row => {
      const errors = [];
      if(nonNegativeNumber(row.foodOnePercentTax) > nonNegativeNumber(row.rowTax) + 1e-8){
        errors.push(`${row.name || row.key || '事業区分'}の1％食品売上税額が売上税額を超えています。`);
      }
      if(nonNegativeNumber(row.foodOnePercentTaxableBase) > nonNegativeNumber(row.rowTaxableBase) + 1e-8){
        errors.push(`${row.name || row.key || '事業区分'}の1％食品売上高が課税売上高を超えています。`);
      }
      return errors;
    });
    const totalSalesTax = rows.reduce((sum, row) => sum + row.rowTax, 0);
    const totalTaxableBase = rows.reduce((sum, row) => sum + row.rowTaxableBase, 0);
    const foodOnePercentTax = rows.reduce((sum, row) => (
      sum + Math.min(nonNegativeNumber(row.rowTax), nonNegativeNumber(row.foodOnePercentTax))
    ), 0);
    const foodOnePercentTaxableBase = rows.reduce((sum, row) => (
      sum + Math.min(nonNegativeNumber(row.rowTaxableBase), nonNegativeNumber(row.foodOnePercentTaxableBase))
    ), 0);
    const otherRows = rows.map(row => ({
      ...row,
      rowTax:Math.max(0, nonNegativeNumber(row.rowTax) - nonNegativeNumber(row.foodOnePercentTax)),
      rowTaxableBase:Math.max(0, nonNegativeNumber(row.rowTaxableBase) - nonNegativeNumber(row.foodOnePercentTaxableBase))
    }));
    const otherSalesTax = otherRows.reduce((sum, row) => sum + row.rowTax, 0);
    const otherTaxableBase = otherRows.reduce((sum, row) => sum + row.rowTaxableBase, 0);
    const normalOtherCredit = otherRows.reduce((sum, row) => sum + row.rowTax * row.deemed, 0);
    const normalCredit = foodOnePercentTax + normalOtherCredit;
    const candidates = [{
      kind:'normal',
      otherDeemedCredit:normalOtherCredit,
      deemedCredit:normalCredit,
      methodLabel:'通常計算',
      share:0
    }];
    const activeRows = otherRows.filter(row => row.rowTaxableBase > 0);

    if(otherTaxableBase > 0 && activeRows.length >= 2){
      activeRows.forEach(row => {
        const share = row.rowTaxableBase / otherTaxableBase;
        if(share + Number.EPSILON >= 0.75){
          const otherDeemedCredit = otherSalesTax * row.deemed;
          candidates.push({
            kind:'single75',
            otherDeemedCredit,
            deemedCredit:foodOnePercentTax + otherDeemedCredit,
            methodLabel:`75％特例（${row.name}事業が${formatShare(share)}）`,
            share,
            keys:[row.key]
          });
        }
      });
    }

    if(otherTaxableBase > 0 && activeRows.length >= 3){
      for(let i = 0; i < activeRows.length - 1; i++){
        for(let j = i + 1; j < activeRows.length; j++){
          const first = activeRows[i];
          const second = activeRows[j];
          const share = (first.rowTaxableBase + second.rowTaxableBase) / otherTaxableBase;
          if(share + Number.EPSILON < 0.75) continue;
          const high = first.deemed >= second.deemed ? first : second;
          const low = high === first ? second : first;
          const otherDeemedCredit = high.rowTax * high.deemed + (otherSalesTax - high.rowTax) * low.deemed;
          candidates.push({
            kind:'pair75',
            otherDeemedCredit,
            deemedCredit:foodOnePercentTax + otherDeemedCredit,
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
      foodOnePercentTax,
      foodOnePercentTaxableBase,
      otherSalesTax,
      otherTaxableBase,
      normalCredit,
      deemedCredit:selected.deemedCredit,
      amount:totalSalesTax - selected.deemedCredit,
      method:selected.kind,
      methodLabel:selected.methodLabel,
      selectedCandidate:selected,
      otherRows,
      allocationErrors,
      valid:allocationErrors.length === 0,
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

  function validateTaxPeriod(start, end){
    const errors = [];
    if(!start) errors.push('課税期間の開始日を入力してください。');
    else if(isoDateToEpochDay(start) === null) errors.push('課税期間の開始日を正しい日付で入力してください。');
    if(!end) errors.push('課税期間の終了日を入力してください。');
    else if(isoDateToEpochDay(end) === null) errors.push('課税期間の終了日を正しい日付で入力してください。');
    if(errors.length === 0 && start > end) errors.push('課税期間の終了日は開始日以降の日付にしてください。');
    return { valid:errors.length === 0, errors };
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

  function assessFoodSimplifiedDiscontinuance(input = {}){
    const start = String(input.periodStart || '');
    const end = String(input.periodEnd || '');
    const periodValid = isoDateToEpochDay(start) !== null
      && isoDateToEpochDay(end) !== null
      && start <= end;
    const containsStartDate = periodValid && start <= FOOD_PROPOSAL.start && end >= FOOD_PROPOSAL.start;
    const reasons = [];
    const confirmations = [];

    if(input.scenario !== 'foodProposal') reasons.push('飲食料品1％・大綱に基づく試算ではありません。');
    if(!periodValid) reasons.push('課税期間の開始日と終了日を確認してください。');
    else if(!containsStartDate) reasons.push('2027年4月1日を含む課税期間ではないため、今回の届出特例の対象期ではありません。');

    const addConfirmation = (value, unknownReason, noReason) => {
      if(value === CONFIRMATION.NO) reasons.push(noReason);
      else if(value !== CONFIRMATION.YES) confirmations.push(unknownReason);
    };
    addConfirmation(
      input.foodSalesState,
      '飲食料品の販売を行うか未確認です。',
      '飲食料品の販売を行わないため、今回の届出特例の対象外です。'
    );
    addConfirmation(
      input.simplifiedAppliedState,
      '対象課税期間に簡易課税を適用する状態か未確認です。',
      '対象課税期間に簡易課税を適用しないため、今回の届出特例の対象外です。'
    );
    addConfirmation(
      input.noOtherRestrictionsState,
      '他制度の制限・特殊な課税期間の確認が必要です。',
      '今回の特例では解除されない他制度の制限等があります。'
    );

    const filingStatus = String(input.filingStatus || 'unknown');
    const filingDate = String(input.filingDate || '');
    const filingDateValid = isoDateToEpochDay(filingDate) !== null;
    const filingExecution = filingStatus === 'filed' ? 'filed' : filingStatus === 'planned' ? 'planned' : 'unknown';
    const prePeriodFiling = periodValid && filingDateValid && filingExecution !== 'unknown' && filingDate < start;
    if(filingStatus === 'none'){
      reasons.push('簡易課税制度選択不適用届出書を提出しないため、今回の届出特例を利用できません。');
    }else if(filingStatus !== 'filed' && filingStatus !== 'planned'){
      confirmations.push('不適用届出の提出状況が未確認です。');
    }else if(!filingDateValid){
      confirmations.push(filingStatus === 'filed' ? '不適用届出の提出日が未確認です。' : '不適用届出の予定日が未確認です。');
    }else if(prePeriodFiling){
      confirmations.push('期首前の届出です。通常の届出要件と、法案成立後の事前提出が今回の特例として扱われるかが未確認です。国税庁Q&A問３－５と成立後の法令・届出案内に基づく確認が必要です。'
        + (start === FOOD_PROPOSAL.start ? ' ４月１日期首の場合、４月１日前の提出は期首前にも当たります。今回の特例を除外せずに確認する必要があります。' : ''));
    }else if(!periodValid || filingDate > end){
      reasons.push('届出日が資料上の対象課税期間中ではありません。休日等の取扱いを含む個別確認が必要です。');
    }

    let eligibility = ELIGIBILITY.ELIGIBLE;
    if(reasons.length) eligibility = ELIGIBILITY.INELIGIBLE;
    else if(confirmations.length) eligibility = ELIGIBILITY.UNKNOWN;
    return {
      eligibility,
      reasons,
      confirmations,
      containsStartDate,
      prePeriodFiling,
      filingDateValid,
      effectiveFrom:eligibility === ELIGIBILITY.ELIGIBLE && filingExecution !== 'unknown' ? start : '',
      sourcePeriodEnd:periodValid ? end : '',
      filingExecution,
      filingReference:eligibility === ELIGIBILITY.ELIGIBLE && filingDateValid && periodValid && filingDate >= start && filingDate <= end
        ? '簡易課税制度選択不適用届出書の参考事項欄に「飲食料品特例」と記載' : '',
      twoYearBindingWaived:eligibility === ELIGIBILITY.ELIGIBLE,
      proposalStatus:FOOD_PROPOSAL.status
    };
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
    const periodValid = validateTaxPeriod(ctx.start, ctx.end).valid;
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

    // The caller supplies availability established from the current sales,
    // purchases and credit method. The retired creditMode control is not evidence.
    const regular = ctx.regularCalculationAvailability || {
      eligibility:ELIGIBILITY.UNKNOWN,
      reasons:['本則課税の入力金額と計算条件を確認してください']
    };

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
    normalizeExemptPurchaseRatio,
    FOOD_PROPOSAL,
    normalizeNumberString,
    parseAmountInput,
    taxFromAmount,
    taxableBaseFromAmount,
    calculateRegularAmount,
    calculateDetailedRegular,
    calculateDeclarationAmount,
    calculateNationalSalesTax,
    taxRateForProposalItem,
    assessCsvOnePercentEntry,
    projectPrice,
    calculateSpecialMethodAmount,
    calculatePeriodTaxCase,
    assessHighValueAsset,
    assessCurrentMethodChoice,
    optimizeFourPeriodRoutes,
    calculateSimplifiedTax,
    weightedExemptPurchaseRatio,
    periodIncludes,
    validateTaxPeriod,
    assessFoodSimplifiedDiscontinuance,
    calculateEligibility,
    sanitizeCsvCell,
    serializeStateIfEnabled
  });
});
