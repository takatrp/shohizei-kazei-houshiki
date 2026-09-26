const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluate}=require('../input-diagnostics');
const context={comparisonMethods:['regular','simplified'],entryMode:'rows',taxScenario:'foodProposal',values:{foodForecastMethod:'manual',foodSalesPriceBasis:'excludedFixed',foodPurchasePriceBasis:'excludedFixed',regularDetailMethod:'individual'},rows:{sales:[{id:'s1',code:'1',rate:'8',amount:'108000',foodAmount:'0',businessType:'1'}],purchases:[{id:'p1',code:'5',rate:'8',amount:'54000',foodAmount:''}]}};
const method=(key,amount,reasons=[])=>({key,amount,eligibility:'eligible',calculationAvailability:{reasons},reasons:[]});
const snapshot=(methods,extra={})=>({ctx:{taxScenario:'foodProposal',regularDetailMethod:'individual',nonTaxableSalesEntered:true},comparisonReady:true,methods,...extra});
test('diagnostics preserve calculable methods even when another method needs food purchases',()=>{
  const calc=snapshot([method('regular',null),method('simplified',1000)]);
  const before=JSON.stringify(calc);
  const result=evaluate({context,calc});
  assert.ok(result.byMethod.regular.some(x=>x.target==='purchases:p1:foodAmount'));
  assert.deepEqual(result.byMethod.simplified,[]);
  assert.equal(JSON.stringify(calc),before);
});
test('food sales missing targets the same stable row for every unavailable method',()=>{
  const rows={...context.rows,sales:[{...context.rows.sales[0],foodAmount:''}]};
  const result=evaluate({context:{...context,rows},calc:snapshot([method('regular',null),method('simplified',null)])});
  for(const key of ['regular','simplified']) assert.ok(result.byMethod[key].some(x=>x.target==='sales:s1:foodAmount'));
  assert.ok(!result.byMethod.simplified.some(x=>x.target==='purchases:p1:foodAmount'));
});
test('non-taxable missing uses code 3 row or add button, not an unrelated sales row',()=>{
  const calc=snapshot([method('regular',null)],{ctx:{taxScenario:'current',nonTaxableSalesEntered:false,regularDetailMethod:'individual'}});
  let result=evaluate({context:{...context,taxScenario:'current'},calc});
  assert.equal(result.byMethod.regular.find(x=>x.key==='regular.nonTaxableSales').target,'addTaxSalesRow');
  result=evaluate({context:{...context,rows:{...context.rows,sales:[...context.rows.sales,{id:'n1',code:'3',amount:''}]}},calc});
  assert.equal(result.byMethod.regular.find(x=>x.key==='regular.nonTaxableSales').target,'sales:n1:amount');
});
test('credit method deficiency has explicit fixed target and fallback reason remains intact',()=>{
  const calc=snapshot([method('regular',null,['独立した既存計算理由'])],{ctx:{regularDetailMethod:'auto'},regular:{fullCreditEligible:false}});
  const result=evaluate({context,calc});
  assert.ok(result.byMethod.regular.some(x=>x.target==='regularDetailMethod'));
  assert.ok(result.byMethod.regular.some(x=>x.text==='独立した既存計算理由' && x.target==='regularDetailMethod'));
});
test('ineligible method has no misleading missing-calculation diagnostics',()=>{
  const result=evaluate({context,calc:snapshot([{...method('regular',null),eligibility:'ineligible'}])});
  assert.deepEqual(result.byMethod.regular,[]);
});
test('aggregate structured fields target exact rows; unidentified errors target row only',()=>{
  const calc=snapshot([method('regular',null)],{comparisonReady:false});
  const aggregate={errors:[{side:'purchases',index:0,field:'amount',code:'invalidAmount',message:'金額形式不正'},{side:'sales',index:0,message:'集計エラー'}]};
  const result=evaluate({context,calc,aggregate});
  assert.ok(result.byMethod.regular.some(x=>x.text==='金額形式不正' && x.target==='purchases:p1:amount'));
  assert.ok(result.byMethod.regular.some(x=>x.text==='集計エラー' && x.target==='sales:s1'));
});
test('unmapped reasons have stable keys and a fixed calculation guidance target',()=>{
  const calc=snapshot([method('regular',null,['非課税の文字がある別の理由'])]);
  const first=evaluate({context,calc}).byMethod.regular.find(x=>x.text==='非課税の文字がある別の理由');
  const second=evaluate({context,calc}).byMethod.regular.find(x=>x.text===first.text);
  assert.equal(first.target,'regularDetailMethod');assert.equal(first.key,second.key);
});
test('pending CSV correction targets remain separate from already calculated results',()=>{
  const recoveryEntries=[{id:'record:3:debit',action:'correct',original:{category:'sales'},reasonCodes:['amount'],amount:''}];
  const result=evaluate({context:{...context,recoveryEntries,csvApplying:true},calc:snapshot([method('regular',100)])});
  assert.ok(result.recovery.some(x=>x.target==='recovery:record:3:debit:amount'));
  assert.deepEqual(result.byMethod.regular,[]);
});
test('explicit food zero yields no food missing target',()=>{
  const rows={...context.rows,purchases:[{...context.rows.purchases[0],foodAmount:'0'}]};
  const result=evaluate({context:{...context,rows},calc:snapshot([method('regular',null,['別の不足'])])});
  assert.ok(!result.byMethod.regular.some(x=>x.target?.endsWith(':foodAmount')));
});
test('food missing diagnostic names the row and removes duplicate calculation wording',()=>{
  const reason='仕入1行目の「うち食品1％対象」を入力してください（対象なしは0円を明示）。';
  const calc=snapshot([method('regular',null,[reason])],{foodRowMissing:{sales:[],purchases:[reason]}});
  const issues=evaluate({context,calc}).byMethod.regular;
  assert.equal(issues.filter(x=>x.key.endsWith(':foodAmount')).length,1);
  assert.ok(issues.some(x=>x.text==='仕入1行目：食品1％対象額が未入力・未選択です。'));
  assert.ok(!issues.some(x=>x.text===reason));
});
test('non-taxable known reason is represented once with the exact input target',()=>{
  const reason='非課税売上等を入力してください（該当なしは0円）。';
  const calc=snapshot([method('regular',null,[reason])],{ctx:{nonTaxableSalesEntered:false},returnCalculation:{reasons:[reason]}});
  const issues=evaluate({context,calc}).byMethod.regular;
  assert.equal(issues.filter(x=>x.key==='regular.nonTaxableSales').length,1);
  assert.ok(!issues.some(x=>x.text===reason));
});
test('global input failure has guidance even for an otherwise ineligible method',()=>{
  const calc=snapshot([{...method('regular',null),eligibility:'ineligible'}],{comparisonReady:false,inputErrors:['期間を確認してください']});
  const issues=evaluate({context,calc}).byMethod.regular;
  assert.ok(issues.length>0);assert.ok(issues.every(x=>x.target));
});
test('empty code 3 amount is represented once across requirements, aggregation and calculation',()=>{
  const reason='税込金額を入力してください（該当なしは0円）。';
  const rows={...context.rows,sales:[{id:'n1',code:'3',amount:''}]};
  const calc=snapshot([method('regular',null,[reason])],{comparisonReady:false,ctx:{nonTaxableSalesEntered:false},inputErrors:['行入力の確認が1件あります。該当する売上・仕入行を確認してください。']});
  const result=evaluate({context:{...context,taxScenario:'current',rows},calc,aggregate:{errors:[{side:'sales',index:0,message:reason}]}});
  assert.equal(result.byMethod.regular.filter(x=>x.target==='sales:n1:amount').length,1);
  assert.ok(!result.byMethod.regular.some(x=>x.key==='sales:n1:amount'||x.text===reason||x.text.startsWith('行入力の確認が')));
});
test('existing row empty amount error does not duplicate the shared required-field diagnostic',()=>{
  const reason='税込金額を入力してください（該当なしは0円）。';
  const rows={...context.rows,sales:[{...context.rows.sales[0],amount:''}]};
  const calc=snapshot([method('regular',null,[reason])],{comparisonReady:false});
  const result=evaluate({context:{...context,rows},calc,aggregate:{errors:[{side:'sales',index:0,message:reason}]}});
  assert.equal(result.byMethod.regular.filter(x=>x.target==='sales:s1:amount').length,1);
  assert.ok(!result.byMethod.regular.some(x=>x.text===reason));
});
test('filing selection reasons stay outside calculation missing-input diagnostics',()=>{
  const reason='届出実績を確認してください。';
  const regular={...method('regular',null),reasons:[reason],reason,selectionEligibility:{reasons:[reason]}};
  const calc=snapshot([regular],{ctx:{taxScenario:'current'}});
  const issues=evaluate({context:{...context,taxScenario:'current'},calc}).byMethod.regular;
  assert.ok(issues.length);assert.ok(!issues.some(x=>x.text.includes(reason)));
  assert.deepEqual(regular.reasons,[reason]);
});
