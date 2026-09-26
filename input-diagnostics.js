/* Display diagnostics only: the existing calculation remains authoritative. */
(function(root,factory){
  const api=factory(typeof module==='object' && module.exports ? require('./input-requirements') : root.ShohizeiInputRequirements);
  if(typeof module==='object' && module.exports) module.exports=api;
  root.ShohizeiInputDiagnostics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(requirements){
  'use strict';
  const METHODS=['regular','simplified','special2','special3'];
  const FIELD_LABELS={code:'課税区分',amount:'税込金額',rate:'税率',businessType:'事業区分',foodAmount:'食品1％対象額',creditRatio:'控除割合',action:'補正・除外の処理',category:'集計先',usage:'仕入用途',reason:'対象外と判断した理由'};
  const INPUT_LABELS={comparisonMethods:'比較する申告方式',periodStart:'比較対象課税期間 開始日',periodEnd:'比較対象課税期間 終了日',entityType:'事業者区分',taxScenario:'消費税率の前提',amountMode:'金額の税込・税抜区分',regularDetailMethod:'仕入控除税額の計算方法',foodForecastMethod:'期間別金額の扱い',foodSalesPriceBasis:'食品売上価格の前提',foodPurchasePriceBasis:'食品仕入価格の前提'};
  const NON_TAXABLE_REASONS=new Set(['非課税売上等を確認して入力してください（該当なしは0円）','非課税売上等を入力してください（該当なしは0円）。']);
  const KNOWN_MISSING_ROW_FIELDS=new Map([['税込金額を入力してください（該当なしは0円）。','amount']]);
  const fingerprint=text=>{let value=2166136261;for(const char of String(text)){value^=char.charCodeAt(0);value=Math.imul(value,16777619);}return (value>>>0).toString(16);};
  function evaluate({context={},calc={},aggregate={}}={}){
    const evaluation=requirements.evaluate(context);
    const chosen=context.comparisonMethods || calc.ctx?.comparisonMethods || METHODS;
    const byMethod=Object.fromEntries(METHODS.map(key=>[key,[]]));
    const ctx=calc.ctx || {};
    const validation=target=>requirements.validate(evaluation,context,target);
    const rowTarget=(side,index,field)=>{
      const row=context.rows?.[side]?.[index];
      return row?.id!==undefined ? `${side}:${row.id}${field ? `:${field}` : ''}` : side==='sales'?'addTaxSalesRow':'addTaxPurchaseRow';
    };
    for(const key of chosen){
      const method=calc.methods?.find(item=>item.key===key);
      if(!method || !byMethod[key] || (method.eligibility==='ineligible' && calc.comparisonReady)) continue;
      if(calc.comparisonReady && typeof method.amount==='number' && Number.isFinite(method.amount)) continue;
      const issues=byMethod[key],seen=new Set(),suppressedReasons=new Set();
      const nonTaxableMissing=key==='regular' && (ctx.nonTaxableSalesEntered===false || ctx.nonTaxableSalesValid===false);
      const selectionReasons=new Set(method.selectionEligibility?.reasons || []);
      const add=(stableKey,text,target=null)=>{
        if(!text || seen.has(stableKey)) return;
        seen.add(stableKey);issues.push({key:stableKey,text:String(text),target});
      };
      const addValidation=item=>{
        const match=/^(sales|purchases):/.exec(item.key);
        if(match?.[1]==='purchases' && key!=='regular') return;
        let text=`${INPUT_LABELS[item.key] || item.key}が未入力・未選択です。`;
        if(match){
          const field=item.key.slice(item.key.lastIndexOf(':')+1);
          const id=item.key.slice(match[0].length,item.key.lastIndexOf(':'));
          const index=context.rows?.[match[1]]?.findIndex(row=>String(row.id)===id) ?? -1;
          if(nonTaxableMissing && match[1]==='sales' && field==='amount' && String(context.rows?.sales?.[index]?.code)==='3') return;
          text=`${match[1]==='sales'?'売上':'仕入'}${index>=0?index+1:''}行目：${FIELD_LABELS[field] || field}が未入力・未選択です。`;
        }
        const issueKey=item.key==='regularDetailMethod'?'regular.creditMethod':item.key;
        add(issueKey,text,item.key);
        const issue=issues.find(value=>value.key===issueKey);
        if(issue) issue.hint=item.reason;
      };
      if(!calc.comparisonReady){
        validation(requirements.TARGETS.inputFlow).forEach(addValidation);
        for(const error of aggregate.errors || []){
          if(error.side==='purchases' && key!=='regular') continue;
          const field=error.field || KNOWN_MISSING_ROW_FIELDS.get(error.message);
          if((field && seen.has(rowTarget(error.side,error.index,field)))
            || (nonTaxableMissing && error.side==='sales' && field==='amount' && String(context.rows?.sales?.[error.index]?.code)==='3')){
            suppressedReasons.add(error.message);continue;
          }
          const target=rowTarget(error.side,error.index,error.field);
          add(`row:${error.side}:${context.rows?.[error.side]?.[error.index]?.id ?? error.index}:${error.code || fingerprint(error.message)}`,error.message,target);
        }
      }
      if(key==='regular'){
        validation(requirements.TARGETS.regularTax).forEach(addValidation);
        if(nonTaxableMissing){
          const index=context.rows?.sales?.findIndex(row=>String(row.code)==='3') ?? -1;
          add('regular.nonTaxableSales','非課税売上等を入力・確認してください（該当なしは0円）。',context.entryMode==='rows'?rowTarget('sales',index,'amount'):'nonTaxableSales');
        }
        if(calc.regular?.purchaseAmountEntered===false) add('regular.purchaseAmount','課税仕入れの金額を入力してください（該当なしは0円）。','addTaxPurchaseRow');
        if((ctx.regularDetailMethod==='auto' && calc.regular?.fullCreditEligible===false)
          || (ctx.regularDetailMethod!==undefined && !['auto','individual','proportional'].includes(ctx.regularDetailMethod)))
          add('regular.creditMethod','仕入控除税額の計算方法を確認してください。','regularDetailMethod');
      }
      if(key==='simplified') validation(requirements.TARGETS.simplifiedTax).forEach(addValidation);
      if(ctx.taxScenario==='foodProposal' || context.taxScenario==='foodProposal') validation(requirements.TARGETS.foodTax).forEach(addValidation);
      // Missing/invalid food values are already diagnosed by the calculation.
      // Preserve their exact wording without deriving a target from Japanese text.
      const structuredFood=issues.some(issue=>issue.key.endsWith(':foodAmount'));
      const foodReasons=structuredFood?[]:[...(calc.foodRowMissing?.sales || []),...(key==='regular'?calc.foodRowMissing?.purchases || []:[])];
      const duplicateFoodReasons=new Set(structuredFood?[...(calc.foodRowMissing?.sales || []),...(key==='regular'?calc.foodRowMissing?.purchases || []:[])]:[]);
      const reasons=[...(method.calculationAvailability?.reasons || []),...foodReasons,
        ...(key==='regular'?calc.returnCalculation?.reasons || []:calc.salesMethodCalculations?.[key]?.reasons || []),
        ...(!calc.comparisonReady?calc.inputErrors || []:[]),...(method.reasons || []).filter(text=>!selectionReasons.has(text))];
      if((aggregate.errors || []).length && issues.length) suppressedReasons.add(`行入力の確認が${aggregate.errors.length}件あります。該当する売上・仕入行を確認してください。`);
      for(const text of reasons){
        if(issues.some(issue=>issue.text===text) || duplicateFoodReasons.has(text) || suppressedReasons.has(text)
          || (seen.has('regular.nonTaxableSales') && NON_TAXABLE_REASONS.has(text))) continue;
        add(`calculation:${key}:${fingerprint(text)}`,text,key==='regular'?'regularDetailMethod':'salesInputHeading');
      }
      if(!issues.length) add(`calculation:${key}:unavailable`,'現在の入力では算定できません。入力金額・計算条件を確認してください。',key==='regular'?'regularDetailMethod':'salesInputHeading');
    }
    // Pending CSV edits are not current tax inputs until explicitly applied.
    const recovery=validation(requirements.TARGETS.csvApply)
      .filter(item=>item.key.startsWith('recovery:'))
      .map(item=>({key:item.key,text:`CSV補正：${FIELD_LABELS[item.key.slice(item.key.lastIndexOf(':')+1)] || '必要な項目'}が未入力・未選択です。`,target:item.key}));
    return {byMethod,all:Object.values(byMethod).flat(),recovery,evaluation};
  }
  return {evaluate};
});
