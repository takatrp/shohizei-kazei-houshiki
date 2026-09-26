(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiMethodCashflowAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const METHOD_LABELS = Object.freeze({
    regular:'一般課税（本則課税）',simplified:'簡易課税',special2:'2割特例',special3:'3割特例'
  });

  function validDate(value){
    if(typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
    const year = Number(value.slice(0,4));
    const month = Number(value.slice(5,7));
    const day = Number(value.slice(8,10));
    const date = new Date(0);
    date.setUTCFullYear(year,month-1,day);
    date.setUTCHours(0,0,0,0);
    return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month-1 && date.getUTCDate() === day;
  }

  function roundedYen(value){
    if(typeof value !== 'number' || !Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    return Number.isSafeInteger(rounded) ? rounded || 0 : null;
  }

  function taxPrecision(calc, key){
    if(calc.ctx?.taxScenario === 'foodProposal') return '食品政策概算';
    const result = key === 'regular' ? calc.returnCalculation : calc.salesMethodCalculations?.[key];
    if(result?.referenceCalculable) return result.exactComplete ? '申告書段階' : '申告書段階・参考算定';
    return '現行制度概算';
  }

  // The regular return keeps its final national/local amounts under mainReturn;
  // simplified and special returns expose the same fields at the top level.
  // Never infer a national amount from the annual total or a displayed label.
  function nationalTaxForMethod(calc, key, expectedAmount){
    const unavailable = reason => ({calculable:false,national:null,local:null,totalBeforeInterim:null,
      precision:null,reference:false,reasons:[reason]});
    if(calc?.ctx?.taxScenario !== 'current')
      return unavailable('現行制度の申告書計算結果を確認してください。');
    if(!['regular','simplified','special2','special3'].includes(key))
      return unavailable('前期代理額に使う課税方式を確認してください。');
    const result = key === 'regular' ? calc.returnCalculation : calc.salesMethodCalculations?.[key];
    if(result?.referenceCalculable !== true)
      return unavailable('申告書段階の国税内訳は未算定です。');
    const returnAmounts = key === 'regular' ? result.mainReturn : result;
    const national = returnAmounts?.national;
    const local = returnAmounts?.local;
    const total = returnAmounts?.totalBeforeInterim;
    const method = calc.methods?.find(item => item.key === key);
    const annualAmount = expectedAmount === undefined ? method?.amount : expectedAmount;
    if(!Number.isSafeInteger(national) || !Number.isSafeInteger(local)
      || !Number.isSafeInteger(total) || !Number.isSafeInteger(annualAmount)
      || !Number.isSafeInteger(national + local) || national + local !== total
      || total !== annualAmount)
      return unavailable('国税・地方税の内訳とSTEP3の当期税額が一致しません。');
    const reference = result.exactComplete !== true;
    return {calculable:true,national,local,totalBeforeInterim:total,
      precision:reference ? '申告書段階・参考算定' : '申告書段階',reference,
      reasons:Array.isArray(result.reasons) ? result.reasons.filter(Boolean) : []};
  }

  function sameSnapshot(ctx, source){
    if(!ctx || !source) return true;
    const keys = ['start','end','taxScenario','foodSalesPriceBasis','foodPurchasePriceBasis',
      'foodForecastMethod','foodRate','entityType'];
    return keys.every(key => ctx[key] === source[key]);
  }

  function create({ctx,calc,baseKey,changedKey} = {}){
    const sourceCtx = calc?.ctx || null;
    const currentCtx = ctx || sourceCtx || {};
    const reasons = [];
    const assumptions = [];
    const start = currentCtx.start || '';
    const end = currentCtx.end || '';
    if(!validDate(start) || !validDate(end) || start > end){
      reasons.push('STEP1の対象課税期間の開始日・終了日を確認してください。');
    }
    if(!sameSnapshot(ctx,sourceCtx)) reasons.push('STEP3とSTEP4の対象期・税率・価格前提が一致しません。再計算してください。');
    if(!['current','foodProposal'].includes(currentCtx.taxScenario)) reasons.push('STEP1の税率シナリオを確認してください。');
    if(calc?.comparisonReady !== true) reasons.push('STEP3の現在入力で当期税額を算定できません。入力内容を確認してください。');

    const methods = Array.isArray(calc?.methods) ? calc.methods : [];
    const selected = new Map(methods.map(method => [method.key,method]));
    if(!baseKey || !selected.has(baseKey)) reasons.push('STEP3で選択した基準案Aの課税方式を指定してください。');
    if(!changedKey || !selected.has(changedKey)) reasons.push('STEP3で選択した比較案Bの課税方式を指定してください。');
    if(baseKey && changedKey && baseKey === changedKey) reasons.push('基準案Aと比較案Bには異なる2方式を選択してください。');

    function plan(key,label){
      const method = selected.get(key) || null;
      const amount = roundedYen(method?.amount);
      const eligibility = method?.eligibility || 'unknown';
      const methodReasons = Array.isArray(method?.reasons) ? method.reasons.filter(Boolean) : [];
      if(method && amount === null) reasons.push(`${label}（${METHOD_LABELS[key] || key}）の当期税額は未算定です。${methodReasons.join(' / ')}`);
      if(method && eligibility === 'ineligible') reasons.push(`${label}（${METHOD_LABELS[key] || key}）は現在の入力条件では適用対象外です。${methodReasons.join(' / ')}`);
      const reference = Boolean(method?.reference || calc?.comparisonProvisional || eligibility === 'unknown');
      if(method && eligibility === 'unknown') assumptions.push(`${label}（${METHOD_LABELS[key] || key}）の適用・届出条件は未確認です。${methodReasons.join(' / ')}`);
      return {
        key:key || '',label:METHOD_LABELS[key] || key || '未選択',
        rawAmount:method?.amount ?? null,amount,eligibility,
        amountStatus:amount === null ? 'unavailable' : reference ? 'reference' : 'calculated',
        reference,conditional:method?.conditional === true,
        selectionRoute:method?.selectionRoute || 'ordinary',filingExecution:method?.filingExecution || '',
        precision:method ? taxPrecision(calc,key) : null,
        reasons:methodReasons,calculationMethod:method?.calculationMethod || ''
      };
    }
    const base = plan(baseKey,'基準案A');
    const changed = plan(changedKey,'比較案B');
    if(calc?.csvRecoveryText) assumptions.push(calc.csvRecoveryText);
    if(calc?.csvOriginText) assumptions.push(calc.csvOriginText);
    if(calc?.csvReview?.reviewItems?.length) assumptions.push('CSVの明示1％仕訳に元取引の未確認事項があります。');
    if(calc?.inputUnconfirmedItems?.length) assumptions.push(...calc.inputUnconfirmedItems);
    if(currentCtx.taxScenario === 'foodProposal') assumptions.push('飲食料品1％は未施行の政策に基づく参考試算です。');
    for(const [label,plan] of [['基準案A',base],['比較案B',changed]]){
      if(plan.conditional) assumptions.push(`${label}は食品特例の${plan.filingExecution === 'planned' ? '届出予定を満たすことが条件' : '提出済みとの入力仮定'}による参考試算です。${plan.reasons.join(' / ')}`);
    }
    assumptions.push('両案の売上・仕入と決済条件は同一です。ここでの取引入出金差は0円であり、税金による資金差だけを比較します。');
    const ready = reasons.length === 0 && base.amount !== null && changed.amount !== null;
    return {
      ready,mode:'methodImpact',periodStart:start.slice(0,7),periodEnd:end.slice(0,7),
      periodStartDate:start,periodEndDate:end,scenario:currentCtx.taxScenario || '',
      baseKey:base.key,changedKey:changed.key,plans:{base,changed},
      annualTax:{
        base:ready ? base.amount : null,changed:ready ? changed.amount : null,
        status:ready ? base.reference || changed.reference ? 'reference' : 'calculated' : 'unavailable',
        raw:{base:base.rawAmount,changed:changed.rawAmount},
        reasons:[...new Set([...base.reasons,...changed.reasons])],
        reference:base.reference || changed.reference
      },
      annualSalesDelta:0,annualPurchaseDelta:0,salesDeltas:[],purchaseDeltas:[],
      distribution:{requested:'not-applicable',used:'not-applicable',bySide:{sales:'not-applicable',purchases:'not-applicable'},notes:[]},
      assumptions:[...new Set(assumptions.filter(Boolean))],reasons:[...new Set(reasons)],
      source:{scenario:currentCtx.taxScenario || '',taxPeriod:{start,end},
        priceBasis:{sales:currentCtx.foodSalesPriceBasis || null,purchases:currentCtx.foodPurchasePriceBasis || null},
        amountOrigin:'STEP3の同一入力スナップショット'}
    };
  }

  return Object.freeze({create,roundedYen,nationalTaxForMethod});
});
