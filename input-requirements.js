/* Input guidance only. Tax, eligibility and CSV calculations remain authoritative elsewhere. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  root.ShohizeiInputRequirements=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const TARGETS=Object.freeze({inputFlow:'inputFlow',csvApply:'csvApply',regularTax:'regularTax',simplifiedTax:'simplifiedTax',foodTax:'foodTax',rateCashflow:'rateCashflow',methodCashflow:'methodCashflow',extraCostResult:'extraCostResult',fourPeriod:'fourPeriod'});
  const KNOWN_METHODS=new Set(['regular','simplified','special2','special3']);
  const hasValue=value=>value!==null && value!==undefined && String(value).trim()!=='';
  const text=value=>String(value??'').trim();
  function requirement(badge,requiredFor=[],reason='',options={}){
    const visible=options.visible!==false;
    const enabled=visible && options.enabled!==false;
    return {visible,enabled,badge:visible&&enabled?badge:null,requiredFor:visible&&enabled&&badge==='required'?requiredFor:[],reason,
      allowUnknown:Boolean(options.allowUnknown),emptyMeaning:options.emptyMeaning||'',value:options.value,
      source:options.source||'input',pending:Boolean(options.pending)};
  }
  const required=(targets,reason,options)=>requirement('required',targets,reason,options);
  const optional=(reason,options)=>requirement('optional',[],reason,options);
  const absent=(reason)=>requirement(null,[],reason,{visible:false,enabled:false});
  function evaluate(context={}){
    const v=context.values||{};
    const value=id=>Object.prototype.hasOwnProperty.call(v,id)?v[id]:context[id];
    const methods=Array.isArray(context.comparisonMethods)?context.comparisonMethods.filter(m=>KNOWN_METHODS.has(m)):[];
    const simplified=methods.includes('simplified');
    const regular=methods.includes('regular');
    const food=context.taxScenario==='foodProposal'||value('taxScenario')==='foodProposal';
    const legacy=context.entryMode==='legacy';
    const entity=context.entityType||value('entityType')||'unknown';
    const step4=Boolean(context.step4Active);
    const mode=context.cashflowMode||value('cashflowComparisonType')||'rateImpact';
    const methodMode=mode==='methodImpact'||mode==='method';
    const cashflowTarget=methodMode?'methodCashflow':'rateCashflow';
    const activeCashflow=step4?[cashflowTarget]:[];
    const interim=context.interimMode||value('cashflowInterimStatus')||'auto';
    const basis=context.autoBasis||value('cashflowAutoBasis')||'step3';
    const fields={};
    const put=(ids,rule)=>{for(const id of ids.split(/\s+/)) if(id) fields[id]=rule;};
    const input=req=>required([TARGETS.inputFlow],req);

    put('workflowPurpose',optional('操作の入口。税額比較はどちらからでも利用できます。'));
    put('entityType',input('事業者区分を1つ選択します。'));
    put('periodStart periodEnd',input('正式な比較対象課税期間です。'));
    put('individualYear',entity==='individual'&&context.individualYearApplies!==false?input('通常暦年入力の年を指定します。'):absent('法人・変則期間では対象外です。'));
    put('currentReturnMethod',optional('未確認を保持できます。',{allowUnknown:true,emptyMeaning:'現在方式は未確認'}));
    put('comparisonMethods',input('1方式以上を選択します。全方式は不要です。'));
    put('amountMode taxScenario',input('入力基準・税率の前提を1つ選択します。'));
    put('viewMode',optional('単期比較が標準です。'));
    put('advancedMode declarationRounding',optional('詳細表示または計算条件を選ぶときだけ変更します。'));
    put('saveToDevice',optional('オフでも試算できます。'));

    put('foodForecastMethod foodSalesPriceBasis foodPurchasePriceBasis',food?required([TARGETS.foodTax],'食品1％試算の価格・期間配分前提です。'):absent('現行税率では対象外です。'));
    put('proposalFoodClassificationState proposalPurchaseClassificationState',food?optional('未確認を選べます。確認済みとは扱いません。',{allowUnknown:true}):absent('現行税率では対象外です。'));
    put('purchaseFood1',legacy&&food?optional('従来形式の軽8％仕入内数。',{emptyMeaning:'未確認'}):absent('行入力または現行税率では対象外です。'));
    for(const type of ['type1','type2','type3','type4','type5','type6']){
      put(`${type}Sale10 ${type}Sale8`,legacy?optional('従来形式の事業区分別売上。',{emptyMeaning:'未入力'}):absent('行入力では集計欄です。'));
      put(`${type}SaleFood1`,legacy&&food?optional('従来形式の軽8％食品売上内数。空欄と0円を区別します。',{emptyMeaning:'未確認'}):absent('行入力または現行税率では対象外です。'));
    }
    for(const ratio of ['80','70','50','30','0']) put(`exemptPurchase${ratio}_1`,legacy&&food?optional('従来形式の免税仕入の食品内数。',{emptyMeaning:'未確認'}):absent('行入力または現行税率では対象外です。'));

    put('simpleElectionStatus futureElectionPlan currentDiscontinuanceReady',simplified?optional('届出の事実・計画は未確認を保持できます。',{allowUnknown:true}):absent('簡易課税を比較しない場合は対象外です。'));
    put('priorTaxMethod electionFilingStatus priorPeriodStart priorPeriodEnd electionFilingDate electionAsOfDate consumptionTaxExtension confirmedReturnDeadline',simplified?optional('期限判定の補足。空欄なら届出判定は未確認です。',{allowUnknown:true,emptyMeaning:'届出期限判定は未確認'}):absent('簡易課税を比較しない場合は対象外です。'));
    put('regularDetailMethod',regular?required([TARGETS.regularTax],'本則の控除方法を指定します。'):absent('本則課税を比較しない場合は対象外です。'));
    put('nonTaxableSales taxableOnlyPurchaseTax commonPurchaseTax',regular?optional('既存の用途別集計が必要な場合に照合します。空欄を自動0円と扱いません。',{emptyMeaning:'用途別金額は未確認'}):absent('本則課税を比較しない場合は対象外です。'));
    put('highAssetState highAssetAmount highAssetType highAssetSelfConstructed baseTaxableSales specificTaxableSales specificPayrollAmount invoiceRegisteredState invoiceTransitionState noSpecialExclusionState simpleNoticeReadyState',optional('適用判定用の事実は未確認を維持します。',{allowUnknown:true,emptyMeaning:'適用判定は未確認'}));
    put('creditMode',regular?optional('本則の控除率を資料で確認するまで未確認を選べます。',{allowUnknown:true}):absent('本則課税を比較しない場合は対象外です。'));
    put('creditPercent',regular&&value('creditMode')==='estimate'?required([TARGETS.regularTax],'概算率入力を選んだときに指定します。'):absent('控除率の概算入力を選んだ場合だけ入力します。'));
    put('regularAdjustment',regular?optional('個別調整がある場合だけ入力します。',{emptyMeaning:'調整を指定していない'}):absent('本則課税を比較しない場合は対象外です。'));
    put('exemptPurchaseState',regular?optional('未確認を維持できます。',{allowUnknown:true}):absent('本則課税を比較しない場合は対象外です。'));
    put('purchase10 purchase8',regular?optional('行入力から集計される従来欄。',{emptyMeaning:'未入力'}):absent('本則課税を比較しない場合は対象外です。'));
    put('exemptPurchase80_10 exemptPurchase80_8 exemptPurchase70_10 exemptPurchase70_8 exemptPurchase50_10 exemptPurchase50_8 exemptPurchase30_10 exemptPurchase30_8 exemptPurchase0_10 exemptPurchase0_8',regular?optional('該当する控除期間・仕入があるときだけ入力します。',{emptyMeaning:'該当額未入力'}):absent('本則課税を比較しない場合は対象外です。'));
    put('addBusinessType',simplified?optional('事業区分の行を追加するときだけ操作します。'):absent('簡易課税を比較しない場合は対象外です。'));

    put('journalCsvFile',context.csvApplying?required([TARGETS.csvApply],'CSV反映操作時には解析済みファイルが必要です。'):optional('手入力のみで試算できます。',{emptyMeaning:'CSV未使用'}));
    put('journalImportMode',context.csvApplying?required([TARGETS.csvApply],'CSV反映時に置換または追加を選択します。'):optional('CSV反映の操作時のみ使用します。'));
    put('applyCsvDateRange',optional('正式な対象期と照合して選びます。'));
    put('returnPurchaseAdjustment10',optional('申告書照合の差額がある場合のみ入力します。',{emptyMeaning:'調整額の指定なし'}));
    put('returnAdjustmentConfirmed',hasValue(value('returnPurchaseAdjustment10'))?required([TARGETS.csvApply],'照合調整を反映するには根拠と符号を確認します。'):optional('調整額が空欄なら不要です。'));

    put('cashflowComparisonType',step4?required(activeCashflow,'比較モードを1つ選択します。'):optional('STEP3税額比較には不要です。'));
    put('cashflowMethod',step4&&!methodMode?required(activeCashflow,'税率比較で1方式を選択します。'):absent('方式別資金推移ではA/B方式を利用します。'));
    put('cashflowBaseMethod cashflowChangedMethod',step4&&methodMode?required(activeCashflow,'STEP3の候補から異なる2方式を選択します。'):absent('税率比較では1方式を固定します。'));
    put('cashflowDistribution cashflowSalesLag cashflowPurchaseLag',step4&&!methodMode?required(activeCashflow,'税率比較の取引月・回収支払前提です。'):absent('方式比較は取引条件共通で入出金差0円です。'));
    const csvDistribution=step4&&!methodMode&&value('cashflowDistribution')==='csv';
    put('cashflowSourceStart cashflowSourceEnd cashflowSourceConfirmed',csvDistribution?required(activeCashflow,'CSV月別構成比を使う場合に元期間・網羅性を確認します。'):absent('CSV月別配分を使用しません。'));
    put('cashflowInterimStatus',step4?required(activeCashflow,'中間納付の設定を選択します。自動が初期値です。'):optional('STEP3税額には不要です。'));
    const sameSettlement=value('cashflowSameSettlement')!==false;
    put('cashflowSameSettlement',step4&&methodMode?optional('両案共通の精算月か、案別の精算月かを選びます。'):absent('税率比較では共通の精算月を使います。'));
    put('cashflowSameInterim',step4&&interim==='scheduled'?optional('共通予定を使うか選べます。'):absent('手入力予定を選んだ場合のみ使用します。'));
    const manual=step4&&interim==='scheduled';
    const baseNo=value('cashflowBaseNoInterim')===true;
    const changedNo=value('cashflowChangedNoInterim')===true;
    put('cashflowBaseNoInterim cashflowChangedNoInterim',manual?optional('明示的な中間納付なしを選べます。'):absent('手入力予定以外では対象外です。'));
    put('cashflowBaseInterim',manual&&!baseNo?required(activeCashflow,'手入力予定または中間納付なしの明示が必要です。'):absent('確認済み0回または自動予定を使用します。'));
    put('cashflowChangedInterim',manual&&value('cashflowSameInterim')===false&&!changedNo?required(activeCashflow,'変更案の予定または中間納付なしの明示が必要です。'):absent('両案共通・確認済み0回・自動予定を使用します。'));
    const auto=step4&&interim==='auto';
    put('cashflowAutoBasis cashflowPeriodShortening cashflowSpecialCircumstances',auto?required(activeCashflow,'前期実績による自動設定の前提です。未確認は0回とみなしません。',{allowUnknown:true}):absent('自動中間予定ではありません。'));
    put('cashflowPriorProxyMethod',auto&&basis==='step3'&&methodMode?required(activeCashflow,'前期代理額に使うSTEP3方式を選択します。'):absent('この比較では別の代理額設定を使います。'));
    put('cashflowPriorNationalTax cashflowPriorStart cashflowPriorEnd',auto&&basis==='actual'?required(activeCashflow,'前期確定国税額の直接入力を選んだため必要です。'):absent('STEP3代理または手入力予定を使用します。'));
    put('cashflowAutoSeparate',auto&&!methodMode?optional('両案の前期額を別々に仮定するときだけ選びます。'):absent('方式別比較では共通の前期額を使用します。'));
    put('cashflowPriorChangedNationalTax',auto&&!methodMode&&basis==='actual'&&value('cashflowAutoSeparate')===true?required(activeCashflow,'両案の前期実績を別々に入力します。'):absent('方式別比較または共通の前期額では使用しません。'));
    put('cashflowCorporateExtension',auto&&entity==='corporation'?(context.autoRequiresCorporateExtension
      ?required(activeCashflow,'年11回等で期限判定に必要です。未確認なら自動予定は未算定です。',{allowUnknown:true})
      :optional('年11回等で必要になる場合は、資料で確認します。',{allowUnknown:true})):absent('法人の自動中間予定に限ります。'));

    const settlement=context.settlement||{};
    const baseQ=settlement.baseQ,changedQ=settlement.changedQ;
    const qKnown=Number.isFinite(baseQ)&&Number.isFinite(changedQ);
    const month=(kind,q,field,known=qKnown)=>!step4?optional('STEP3年税額には不要です。'):
      !known?optional('税額・中間額確定後に必要月を判定します。',{pending:true,emptyMeaning:'必要性未判定'}):
      (kind==='payment'?q>0:q<0)?required(activeCashflow,'精算額が発生する案の予定月です。初期値でも法定期限の確認済みではありません。',{value:value(field)}):optional('今回はこの精算種別を使用しません。');
    put('cashflowSettlementMonth',month('payment',qKnown?(baseQ>0||changedQ>0?1:0):null,'cashflowSettlementMonth'));
    put('cashflowRefundMonth',month('refund',qKnown?(baseQ<0||changedQ<0?-1:0):null,'cashflowRefundMonth'));
    const planMonths=[['cashflowBaseSettlementMonth','cashflowBaseRefundMonth',baseQ],['cashflowChangedSettlementMonth','cashflowChangedRefundMonth',changedQ]];
    for(const [paymentId,refundId,q] of planMonths){
      fields[paymentId]=methodMode&&!sameSettlement?month('payment',q,paymentId,Number.isFinite(q)):absent('共通予定月を使用します。');
      fields[refundId]=methodMode&&!sameSettlement?month('refund',q,refundId,Number.isFinite(q)):absent('共通予定月を使用します。');
    }
    if(methodMode&&!sameSettlement){
      fields.cashflowSettlementMonth=absent('方式比較では案別の予定月を使います。');
      fields.cashflowRefundMonth=absent('方式比較では案別の予定月を使います。');
    }

    const extra=Boolean(context.extraCostsEnabled);
    put('switchFoodSalesState switchSimplifiedAppliedState switchFilingStatus switchFilingDate switchNoOtherRestrictionsState',extra?optional('追加費用を含む切替検討の確認。未確認で適用を確定しません。',{allowUnknown:true}):absent('追加費用比較は使用していません。'));
    put('switchAdditionalFee',extra?required([TARGETS.extraCostResult],'追加報酬を含める場合の額です。0円を明示できます。'):absent('追加費用比較は使用していません。'));
    put('switchFeeTaxBasis',extra?required([TARGETS.extraCostResult],'追加報酬の税込・税抜基準です。'):absent('追加費用比較は使用していません。'));
    put('switchOtherCostsNone',extra?optional('その他支出なしを明示できます。'):absent('追加費用比較は使用していません。'));
    put('switchOtherCosts',extra&&value('switchOtherCostsNone')===false?required([TARGETS.extraCostResult],'その他支出ありの場合に額を指定します。'):absent('その他支出なし、または追加費用比較を使用していません。'));
    put('switchTimeEvaluation',extra?optional('工数参考額を使う場合だけ選びます。'):absent('追加費用比較は使用していません。'));
    put('switchCustomerHours switchHourlyRate',extra&&value('switchTimeEvaluation')===true?required([TARGETS.extraCostResult],'工数参考額を含める場合に必要です。'):absent('工数参考額を使用していません。'));
    put('switchCreditState switchCreditIncludedInBTax',extra?optional('追加費用の仕入控除を別途確認する場合だけ指定します。',{allowUnknown:true}):absent('追加費用比較は使用していません。'));
    put('switchAdditionalCredit',extra&&value('switchCreditState')==='confirmed'?required([TARGETS.extraCostResult],'確認済み控除額を指定します。'):absent('確認済み控除額を反映しません。'));
    put('switchCustomerComment officeHours officeHourlyCost officeOtherCost officeInternalMemo',extra?optional('記載・所内検討に使う場合のみ入力します。'):absent('追加費用比較は使用していません。'));

    const rows={sales:[],purchases:[]};
    for(const side of ['sales','purchases']) for(const row of context.rows?.[side]||[]){
      const code=text(row.code),rate=text(row.rate),amount=text(row.amount),business=text(row.businessType),ratio=text(row.creditRatio);
      const active=[code,rate,amount,business,ratio,text(row.foodAmount)].some(Boolean);
      const fieldsForRow={};
      if(!active){
        for(const key of ['code','businessType','rate','amount','foodAmount','creditRatio']) fieldsForRow[key]=absent('未使用の追加行です。');
      }else{
        const taxable=code!=='3';
        fieldsForRow.code=required([TARGETS.inputFlow],'入力開始行の課税区分です。');
        fieldsForRow.amount=required([TARGETS.inputFlow],'入力開始行の税込金額です。0円は明示入力です。');
        fieldsForRow.rate=taxable?required([side==='sales'?TARGETS.inputFlow:TARGETS.regularTax],'課税取引の税率です。'):absent('非課税売上は税率を入力しません。');
        fieldsForRow.businessType=side==='sales'&&simplified&&['1','11'].includes(code)?required([TARGETS.simplifiedTax],'簡易課税の対象売上の事業区分です。'):absent('この行では事業区分を使用しません。');
        const foodEligible=side==='sales'?['1','11'].includes(code):['5','6','7','52','62','72'].includes(code);
        fieldsForRow.foodAmount=food&&taxable&&rate==='8'&&foodEligible?required([TARGETS.foodTax],'軽減8％額のうち1％対象。明示0円は有効です。'):absent('軽減8％・食品1％対象行以外は入力しません。');
        fieldsForRow.creditRatio=side==='purchases'&&['52','62','72'].includes(code)?(regular?required([TARGETS.regularTax],'免税事業者等仕入の取引時期に対応する控除割合です。'):optional('本則課税を比較する場合に控除割合を確認します。')):absent('適格仕入・売上等は控除割合を入力しません。');
      }
      rows[side].push({id:row.id,active,fields:fieldsForRow});
    }
    const recovery=[];
    for(const entry of context.recoveryEntries||[]){
      const action=entry.action||'';
      const category=entry.category||entry.original?.category||'';
      const reasonCodes=entry.reasonCodes||[];
      const unclassified=!['sales','nonTaxableSales','invoicePurchase','exemptPurchase'].includes(entry.original?.category);
      recovery.push({id:entry.id,fields:{
        action:context.csvRequireResolution||action?required([TARGETS.csvApply],'選択した補正・除外の処理を保持します。'):optional('問題明細は必要に応じて補正・除外します。未処理は未確認として残します。'),
        category:action==='correct'&&unclassified?required([TARGETS.csvApply],'補正する集計先です。'):absent('集計先の補正は不要です。'),
        rate:action==='correct'&&category&&category!=='nonTaxableSales'?(reasonCodes.includes('rate')?required([TARGETS.csvApply],'原税率を判定できなかったため、税率の補正が必要です。'):optional('原値を保持する場合は空欄です。')):absent('この分類では税率補正不要です。'),
        usage:action==='correct'&&unclassified&&['invoicePurchase','exemptPurchase'].includes(category)?required([TARGETS.csvApply],'仕入用途を選択します。'):absent('仕入用途補正は不要です。'),
        creditRatio:action==='correct'&&category==='exemptPurchase'&&(unclassified||reasonCodes.includes('creditRatio'))?(reasonCodes.includes('creditRatio')?required([TARGETS.csvApply],'原控除割合を判定できなかったため、割合の補正が必要です。'):optional('原値を保持できる場合は空欄です。')):absent('控除割合補正は不要です。'),
        amount:action==='correct'&&reasonCodes.includes('amount')?required([TARGETS.csvApply],'金額不明の補正は空欄と明示0円を区別します。'):absent('金額補正は不要です。'),
        reason:action==='confirmedExclude'?required([TARGETS.csvApply],'試算対象外と確認した理由です。'):absent('仮除外では理由入力を強制しません。')
      }});
    }
    return {fields,rows,recovery,meta:{mode,step4,methods,food,entity,settlementKnown:qKnown}};
  }
  function validate(evaluation,context={},target){
    const v=context.values||{};
    const result=[];
    const check=(key,rule,value)=>{
      if(!rule||rule.badge!=='required'||!rule.requiredFor.includes(target)) return;
      if(!hasValue(value)||value===false||(!rule.allowUnknown && text(value)==='unknown')) result.push({key,target,reason:rule.reason});
    };
    for(const [key,rule] of Object.entries(evaluation.fields||{})){
      if(key==='comparisonMethods') check(key,rule,evaluation.meta?.methods?.length?'selected':'');
      else if(key==='entityType') check(key,rule,context.entityType||v[key]);
      else if(key==='cashflowComparisonType') check(key,rule,context.cashflowMode||v[key]);
      else if(key==='cashflowInterimStatus') check(key,rule,context.interimMode||v[key]);
      else if(key==='cashflowAutoBasis') check(key,rule,context.autoBasis||v[key]);
      else if(key==='taxScenario') check(key,rule,context.taxScenario||v[key]);
      else check(key,rule,v[key]??context[key]);
    }
    for(const side of ['sales','purchases']) evaluation.rows?.[side]?.forEach((row,index)=>{
      const source=context.rows?.[side]?.[index]||{};
      for(const [key,rule] of Object.entries(row.fields)) check(`${side}:${row.id??index}:${key}`,rule,source[key]);
    });
    evaluation.recovery?.forEach((entry,index)=>{
      const source=context.recoveryEntries?.[index]||{};
      for(const [key,rule] of Object.entries(entry.fields)) check(`recovery:${entry.id??index}:${key}`,rule,
        key==='action'||key==='reason'?source[key]:source.overrides?.[key]??source[key]);
    });
    if(target===TARGETS.methodCashflow && evaluation.meta?.step4 && (evaluation.meta?.mode==='methodImpact'||evaluation.meta?.mode==='method')){
      const base=text(v.cashflowBaseMethod??context.cashflowBaseMethod);
      const changed=text(v.cashflowChangedMethod??context.cashflowChangedMethod);
      if(base&&changed&&base===changed) result.push({key:'cashflowChangedMethod',target,reason:'異なる2方式を選択してください。'});
    }
    return result;
  }
  return {TARGETS,evaluate,validate,hasValue};
});
