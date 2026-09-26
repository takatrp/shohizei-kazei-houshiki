const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {evaluate,validate,hasValue}=require('../input-requirements');

const base={entityType:'corporation',taxScenario:'current',comparisonMethods:['regular'],values:{periodStart:'2028-01-01',periodEnd:'2028-12-31',amountMode:'included',regularDetailMethod:'auto'}};
const check=(id,context,field,expected)=>test(id,()=>assert.equal(evaluate({...base,...context}).fields[field].badge,expected));
const row=(side,values,context={})=>evaluate({...base,...context,rows:{sales:side==='sales'?[{id:'s1',...values}]:[],purchases:side==='purchases'?[{id:'p1',...values}]:[]}}).rows[side][0];

test('BGC01 one comparison method is sufficient; every checkbox is not required',()=>{
  const snapshot=evaluate(base);
  assert.equal(snapshot.fields.comparisonMethods.badge,'required');
  assert.equal(validate(snapshot,base,'inputFlow').some(x=>x.key==='comparisonMethods'),false);
});
check('BGC02 regular only has no business-type entry',{comparisonMethods:['regular']},'addBusinessType',null);
test('BGC03 simplified needs business type without blocking regular tax',()=>{
  const context={...base,comparisonMethods:['regular','simplified'],rows:{sales:[{id:'s1',code:'1',rate:'10',amount:'1000'}],purchases:[]}};
  const snapshot=evaluate(context);
  assert.equal(snapshot.rows.sales[0].fields.businessType.badge,'required');
  assert.ok(validate(snapshot,context,'simplifiedTax').some(x=>x.key==='sales:s1:businessType'));
  assert.ok(!validate(snapshot,context,'regularTax').some(x=>x.key==='sales:s1:businessType'));
});
test('BGC04 method cashflow does not require month distribution or lags',()=>{
  const snapshot=evaluate({...base,step4Active:true,cashflowMode:'methodImpact',values:{...base.values,cashflowDistribution:'',cashflowSourceConfirmed:false}});
  for(const id of ['cashflowDistribution','cashflowSalesLag','cashflowPurchaseLag','cashflowSourceConfirmed']) assert.equal(snapshot.fields[id].badge,null,id);
});
test('BGC05 proxy auto does not demand actual national input',()=>{
  const snapshot=evaluate({...base,step4Active:true,cashflowMode:'rateImpact',interimMode:'auto',autoBasis:'step3'});
  assert.equal(snapshot.fields.cashflowInterimStatus.badge,'required');
  assert.equal(snapshot.fields.cashflowPriorNationalTax.badge,null);
  assert.equal(snapshot.fields.cashflowPriorProxyMethod.badge,null);
});
test('BGC06 actual prior requires tax and period only in STEP4',()=>{
  const snapshot=evaluate({...base,step4Active:true,interimMode:'auto',autoBasis:'actual'});
  for(const id of ['cashflowPriorNationalTax','cashflowPriorStart','cashflowPriorEnd']) assert.equal(snapshot.fields[id].badge,'required');
});
for(const [id,baseQ,changedQ,payment,refund] of [
  ['BGC07',200000,100000,'required','optional'],['BGC08',-200000,-100000,'optional','required'],
  ['BGC09',200000,-100000,'required','required'],['BGC11',0,0,'optional','optional']]){
  test(`${id} common settlement months follow signed Q`,()=>{
    const fields=evaluate({...base,step4Active:true,settlement:{baseQ,changedQ}}).fields;
    assert.equal(fields.cashflowSettlementMonth.badge,payment);
    assert.equal(fields.cashflowRefundMonth.badge,refund);
  });
}
test('BGC10 plan settlement months are independent',()=>{
  const fields=evaluate({...base,step4Active:true,cashflowMode:'methodImpact',values:{...base.values,cashflowSameSettlement:false},settlement:{baseQ:200000,changedQ:-100000}}).fields;
  assert.equal(fields.cashflowBaseSettlementMonth.badge,'required');
  assert.equal(fields.cashflowBaseRefundMonth.badge,'optional');
  assert.equal(fields.cashflowChangedSettlementMonth.badge,'optional');
  assert.equal(fields.cashflowChangedRefundMonth.badge,'required');
  assert.equal(fields.cashflowSettlementMonth.badge,null);
});
test('BGC12 unknown Q is pending, not signed zero',()=>{
  const fields=evaluate({...base,step4Active:true,settlement:{baseQ:null,changedQ:null}}).fields;
  assert.equal(fields.cashflowSettlementMonth.badge,'optional');
  assert.equal(fields.cashflowRefundMonth.badge,'optional');
  assert.equal(fields.cashflowSettlementMonth.pending,true);
});
test('BGC13 populated default is still required, not legally confirmed',()=>{
  const fields=evaluate({...base,entityType:'individual',step4Active:true,settlement:{baseQ:200000,changedQ:100000},values:{...base.values,cashflowSettlementMonth:'2029-03'}}).fields;
  assert.equal(fields.cashflowSettlementMonth.badge,'required');
  assert.equal(fields.cashflowSettlementMonth.value,'2029-03');
  assert.match(fields.cashflowSettlementMonth.reason,/確認済みではありません/);
});
test('BGC14 unused cost and local save do not block STEP3',()=>{
  const snapshot=evaluate({...base,extraCostsEnabled:false,values:{...base.values,saveToDevice:false}});
  assert.equal(snapshot.fields.saveToDevice.badge,'optional');
  assert.equal(snapshot.fields.switchAdditionalFee.badge,null);
  assert.deepEqual(validate(snapshot,base,'extraCostResult'),[]);
});
check('BGC15 CSV is optional for manual entry',{values:{...base.values,journalCsvFile:null}},'journalCsvFile','optional');
test('BGC16 exempt 8% food purchase needs ratio and food amount; zero is entered',()=>{
  const r=row('purchases',{code:'52',rate:'8',amount:'24625',foodAmount:'0'}, {taxScenario:'foodProposal'});
  assert.equal(r.fields.creditRatio.badge,'required');
  assert.equal(r.fields.foodAmount.badge,'required');
  assert.equal(hasValue('0'),true);
});
test('BGC17 ordinary 10% purchase has no ratio or food entry',()=>{
  const r=row('purchases',{code:'5',rate:'10',amount:'1000'},{taxScenario:'foodProposal'});
  assert.equal(r.fields.creditRatio.badge,null);
  assert.equal(r.fields.foodAmount.badge,null);
});
test('BGC18 unused trailing row is not a missing row',()=>{
  const context={...base,rows:{sales:[{id:'s1',code:'',rate:'',amount:''}],purchases:[]}};
  const snapshot=evaluate(context);
  assert.equal(snapshot.rows.sales[0].active,false);
  assert.deepEqual(validate(snapshot,context,'inputFlow').filter(x=>x.key.startsWith('sales:')),[]);
});
test('BGC19 STEP4-only deficiencies never block STEP3',()=>{
  const context={...base,step4Active:true,interimMode:'unknown',values:{...base.values,cashflowRefundMonth:''}};
  const snapshot=evaluate(context);
  assert.deepEqual(validate(snapshot,context,'regularTax').filter(x=>x.key.startsWith('cashflow')),[]);
});
test('BGC20 unknown applicability is not turned into yes',()=>{
  const context={...base,values:{...base.values,simpleNoticeReadyState:'unknown'}};
  const snapshot=evaluate(context);
  assert.equal(snapshot.fields.simpleNoticeReadyState.allowUnknown,true);
  assert.equal(context.values.simpleNoticeReadyState,'unknown');
});
test('CSV correction action limits required fields; confirmed exclusion needs a reason',()=>{
  const e={id:'issue-1',action:'correct',original:{category:''},category:'exemptPurchase',reasonCodes:['amount','creditRatio']};
  let snapshot=evaluate({...base,recoveryEntries:[e]});
  for(const key of ['action','category','usage','amount','creditRatio']) assert.equal(snapshot.recovery[0].fields[key].badge,'required');
  assert.ok(validate(snapshot,{...base,recoveryEntries:[e]},'csvApply').some(x=>x.key==='recovery:issue-1:creditRatio'));
  const corrected={...e,overrides:{category:'exemptPurchase',usage:'taxableOnly',amount:'0',creditRatio:'80'}};
  snapshot=evaluate({...base,recoveryEntries:[corrected]});
  assert.ok(!validate(snapshot,{...base,recoveryEntries:[corrected]},'csvApply').some(x=>x.key==='recovery:issue-1:creditRatio'));
  assert.equal(snapshot.recovery[0].fields.reason.badge,null);
  e.action='confirmedExclude';snapshot=evaluate({...base,recoveryEntries:[e]});
  assert.equal(snapshot.recovery[0].fields.reason.badge,'required');
  assert.equal(snapshot.recovery[0].fields.amount.badge,null);
});
test('CSV rate correction is required when original rate could not be read',()=>{
  const e={id:'issue-rate',action:'correct',original:{category:'sales'},reasonCodes:['rate'],overrides:{}};
  const snapshot=evaluate({...base,recoveryEntries:[e]});
  assert.equal(snapshot.recovery[0].fields.rate.badge,'required');
  assert.ok(validate(snapshot,{...base,recoveryEntries:[e]},'csvApply').some(x=>x.key==='recovery:issue-rate:rate'));
});
test('required checked confirmation rejects false but zero amount is entered',()=>{
  const context={...base,csvApplying:true,values:{...base.values,returnPurchaseAdjustment10:'0',returnAdjustmentConfirmed:false,journalImportMode:'replace'}};
  const snapshot=evaluate(context);
  assert.equal(snapshot.fields.returnAdjustmentConfirmed.badge,'required');
  assert.ok(validate(snapshot,context,'csvApply').some(x=>x.key==='returnAdjustmentConfirmed'));
});
test('CSV file is required only for applying CSV and not for manual entry',()=>{
  const context={...base,csvApplying:true,values:{...base.values,journalCsvFile:null,journalImportMode:'replace'}};
  const snapshot=evaluate(context);
  assert.equal(snapshot.fields.journalCsvFile.badge,'required');
  assert.ok(validate(snapshot,context,'csvApply').some(x=>x.key==='journalCsvFile'));
  assert.deepEqual(validate(snapshot,context,'regularTax').filter(x=>x.key==='journalCsvFile'),[]);
});
test('method cashflow rejects equal A/B but rate cashflow does not use A/B fields',()=>{
  const context={...base,step4Active:true,cashflowMode:'methodImpact',values:{...base.values,cashflowBaseMethod:'regular',cashflowChangedMethod:'regular'}};
  const snapshot=evaluate(context);
  assert.ok(validate(snapshot,context,'methodCashflow').some(x=>x.reason.includes('異なる2方式')));
  const rate=evaluate({...context,cashflowMode:'rateImpact'});
  assert.equal(rate.fields.cashflowBaseMethod.badge,null);
});
test('partial Q keeps known plan month required and unknown plan month pending',()=>{
  const snapshot=evaluate({...base,step4Active:true,cashflowMode:'methodImpact',values:{...base.values,cashflowSameSettlement:false},settlement:{baseQ:40000,changedQ:null}});
  assert.equal(snapshot.fields.cashflowBaseSettlementMonth.badge,'required');
  assert.equal(snapshot.fields.cashflowChangedSettlementMonth.badge,'optional');
  assert.equal(snapshot.fields.cashflowChangedSettlementMonth.pending,true);
});
test('short-period corporate input does not require individual year',()=>{
  assert.equal(evaluate({...base,entityType:'corporation'}).fields.individualYear.badge,null);
  assert.equal(evaluate({...base,entityType:'individual',individualYearApplies:false}).fields.individualYear.badge,null);
});
test('optional extra cost becomes required only inside enabled cost result',()=>{
  const context={...base,extraCostsEnabled:true,values:{...base.values,switchAdditionalFee:'',switchFeeTaxBasis:'included',switchOtherCostsNone:true}};
  const snapshot=evaluate(context);
  assert.equal(snapshot.fields.switchAdditionalFee.badge,'required');
  assert.ok(validate(snapshot,context,'extraCostResult').some(x=>x.key==='switchAdditionalFee'));
  assert.ok(!validate(snapshot,context,'regularTax').some(x=>x.key==='switchAdditionalFee'));
});
test('scheduled interim needs real events unless no-interim is explicitly confirmed',()=>{
  const context={...base,step4Active:true,interimMode:'scheduled',values:{...base.values,cashflowBaseInterim:'',cashflowBaseNoInterim:false,cashflowSameInterim:false,cashflowChangedInterim:'',cashflowChangedNoInterim:false}};
  const snapshot=evaluate(context);
  assert.equal(snapshot.fields.cashflowBaseInterim.badge,'required');
  assert.equal(snapshot.fields.cashflowChangedInterim.badge,'required');
  const confirmed=evaluate({...context,values:{...context.values,cashflowBaseNoInterim:true,cashflowChangedNoInterim:true}});
  assert.equal(confirmed.fields.cashflowBaseInterim.badge,null);
  assert.equal(confirmed.fields.cashflowChangedInterim.badge,null);
});
test('corporate extension is required only when an auto schedule needs that deadline',()=>{
  const ordinary=evaluate({...base,step4Active:true,interimMode:'auto'});
  assert.equal(ordinary.fields.cashflowCorporateExtension.badge,'optional');
  const eleven=evaluate({...base,step4Active:true,interimMode:'auto',autoRequiresCorporateExtension:true});
  assert.equal(eleven.fields.cashflowCorporateExtension.badge,'required');
  assert.equal(evaluate({...base,entityType:'individual',step4Active:true,interimMode:'auto',autoRequiresCorporateExtension:true}).fields.cashflowCorporateExtension.badge,null);
});
test('方式別モードは旧モード専用の別前期仮定を求めない',()=>{
  const method=evaluate({...base,step4Active:true,cashflowMode:'methodImpact',interimMode:'auto',autoBasis:'actual',
    values:{...base.values,cashflowAutoSeparate:true}});
  assert.equal(method.fields.cashflowAutoSeparate.badge,null);
  assert.equal(method.fields.cashflowPriorChangedNationalTax.badge,null);
  const rate=evaluate({...base,step4Active:true,cashflowMode:'rateImpact',interimMode:'auto',autoBasis:'actual',
    values:{...base.values,cashflowAutoSeparate:true}});
  assert.equal(rate.fields.cashflowAutoSeparate.badge,'optional');
  assert.equal(rate.fields.cashflowPriorChangedNationalTax.badge,'required');
});
test('DOM input inventory maps to a field or a group, except hidden legacy and dynamic templates',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const ids=[...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(match=>match[1]);
  const groupAliases={
    purposeRegular:'workflowPurpose',purposeFoodSwitch:'workflowPurpose',
    entityIndividual:'entityType',entityCorporation:'entityType',
    compareRegular:'comparisonMethods',compareSimplified:'comparisonMethods',compareSpecial2:'comparisonMethods',compareSpecial3:'comparisonMethods',
    modeTaxIncluded:'amountMode',modeTaxExcluded:'amountMode',taxScenarioCurrent:'taxScenario',taxScenarioFood1:'taxScenario',
    viewModeSingle:'viewMode',viewModeProjection:'viewMode',
    highAssetUnknown:'highAssetState',highAssetNo:'highAssetState',highAssetYes:'highAssetState',
    invoiceRegisteredUnknown:'invoiceRegisteredState',invoiceRegisteredYes:'invoiceRegisteredState',invoiceRegisteredNo:'invoiceRegisteredState',
    invoiceTransitionUnknown:'invoiceTransitionState',invoiceTransitionYes:'invoiceTransitionState',invoiceTransitionNo:'invoiceTransitionState',
    noSpecialExclusionUnknown:'noSpecialExclusionState',noSpecialExclusionYes:'noSpecialExclusionState',noSpecialExclusionNo:'noSpecialExclusionState',
    simpleNoticeReadyUnknown:'simpleNoticeReadyState',simpleNoticeReadyYes:'simpleNoticeReadyState',simpleNoticeReadyNo:'simpleNoticeReadyState',
    creditModeUnknown:'creditMode',creditModeConfirmed:'creditMode',creditModeEstimate:'creditMode'
  };
  const ignored=new Set(['legacyAdditionalFeeValue','officeAdditionalFeeExTax']);
  const inventory=evaluate(base).fields;
  const missed=ids.filter(id=>!id.includes('${')&&!ignored.has(id)&&!(groupAliases[id]||id in inventory));
  assert.deepEqual(missed,[]);
});
