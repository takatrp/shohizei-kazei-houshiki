'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const defaults = require('../cashflow-defaults.js');
const methodAdapter = require('../method-cashflow-adapter.js');
const {sanitizeCsvCell,ELIGIBILITY} = require('../tax-engine.js');

const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function source(name){
  const start=html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} must exist`);
  const end=html.indexOf('\nfunction ',start+1);
  return html.slice(start,end<0?undefined:end);
}

test('STEP3から方式別STEP4への専用導線と旧モードの並存',()=>{
  for(const snippet of ['id="methodToCashflowBtn"','value="methodImpact"','value="rateImpact"',
    'id="cashflowBaseMethod"','id="cashflowChangedMethod"','id="cashflowBaseSettlementMonth"',
    'id="cashflowChangedRefundMonth"','src="method-cashflow-adapter.js"',
    'src="cashflow-defaults.js"','src="input-requirements.js"']) assert.ok(html.includes(snippet),snippet);
  assert.match(source('renderCashflow'),/if\(methodImpact\)\{ renderMethodCashflow\(calc,comparison\); return; \}/);
  assert.match(source('renderMethodCashflow'),/ShohizeiMethodCashflowAdapter\.create\(\{ctx:calc\.ctx,calc,baseKey,changedKey\}\)/);
  assert.match(source('renderMethodCashflow'),/settlementByPlan:\$\('cashflowSameSettlement'\)\.checked/);
  assert.match(source('renderMethodCashflow'),/periodEndDate:adapter\.periodEndDate/);
});

test('画面接続の初期予定月は区分・期末に追従し、手入力は上書きせず復元する',()=>{
  const values=new Map();
  const $=id=>{
    if(!values.has(id)) values.set(id,{value:'',title:''});
    return values.get(id);
  };
  let entity='corporation';
  const context=vm.createContext({$,selectedValue:()=>entity,ShohizeiCashflowDefaults:defaults,
    cashflowMonthSources:{},Object});
  vm.runInContext(`const CASHFLOW_MONTH_IDS = Object.freeze({
    cashflowSettlementMonth:'payment',cashflowRefundMonth:'refund',
    cashflowBaseSettlementMonth:'payment',cashflowBaseRefundMonth:'refund',
    cashflowChangedSettlementMonth:'payment',cashflowChangedRefundMonth:'refund'});
    ${source('cashflowMonthContext')}\n${source('syncCashflowMonthDefaults')}\n${source('restoreCashflowMonthSources')}`,context);
  $('periodEnd').value='2028-12-31';
  context.syncCashflowMonthDefaults();
  assert.equal($('cashflowBaseSettlementMonth').value,'2029-02');
  assert.equal($('cashflowChangedRefundMonth').value,'2029-03');
  const manual=defaults.setManualMonth('2029-05','payment',{entityType:entity,periodEnd:$('periodEnd').value});
  context.manual=manual;
  vm.runInContext('cashflowMonthSources.cashflowBaseSettlementMonth = manual',context);
  entity='individual';
  $('periodEnd').value='2029-12-31';
  context.syncCashflowMonthDefaults();
  assert.equal($('cashflowBaseSettlementMonth').value,'2029-05');
  assert.equal($('cashflowChangedSettlementMonth').value,'2030-03');
  assert.equal($('cashflowChangedRefundMonth').value,'2030-04');
  const saved=vm.runInContext('cashflowMonthSources',context);
  context.restoreCashflowMonthSources({cashflowMonthSources:saved});
  assert.equal($('cashflowBaseSettlementMonth').value,'2029-05');
  assert.equal(vm.runInContext('cashflowMonthSources.cashflowBaseSettlementMonth.needsReconfirmation',context),true);
  context.manual={...manual,forMethod:'regular'};
  vm.runInContext('cashflowMonthSources.cashflowBaseSettlementMonth = manual',context);
  $('cashflowBaseMethod').value='simplified';
  context.syncCashflowMonthDefaults();
  assert.equal($('cashflowBaseSettlementMonth').value,'2029-05');
  assert.equal(vm.runInContext('cashflowMonthSources.cashflowBaseSettlementMonth.reason',context),'methodChanged');
});

test('方式別コピー・CSVは同じ税額と月別イベント、対象外は数値化しない',()=>{
  const context=vm.createContext({ELIGIBILITY,yen:value=>`${value.toLocaleString('ja-JP')}円`,sanitizeCsvCell,
    cashflowAutoExportRows:()=>[]});
  vm.runInContext(`${source('methodPlanDisplay')}\n${source('methodPlanStatusLabel')}\n${source('cashflowExportText')}\n${source('cashflowCsvText')}`,context);
  const plan=(label,amount)=>({label,amount,amountStatus:'calculated',eligibility:ELIGIBILITY.ELIGIBLE});
  const snapshot={mode:'methodImpact',adapter:{source:{taxPeriod:{start:'2028-01-01',end:'2028-12-31'}},
    scenario:'current',plans:{base:plan('一般課税',100000),changed:plan('簡易課税',70000)}},
    engine:{maxDrawdown:{amount:20000,month:'2028-08'},finalCumulative:30000,rows:[{
      month:'2028-08',baseTax:{interim:30000,settlement:0,refund:0},
      changedTax:{interim:10000,settlement:0,refund:0},net:20000,cumulative:20000}]},
    notes:['前期国税額は仮定'],autoInterim:null};
  const copy=context.cashflowExportText(snapshot),csv=context.cashflowCsvText(snapshot);
  for(const value of ['100,000円','70,000円','30,000円','2028-08']) assert.ok(copy.includes(value),value);
  for(const value of ['100000','70000','30000','2028-08','前期国税額は仮定']) assert.ok(csv.includes(value),value);
  assert.doesNotMatch(copy,/食品1％試算：資金繰りへの影響/);
  snapshot.adapter.plans.changed={...snapshot.adapter.plans.changed,eligibility:ELIGIBILITY.INELIGIBLE};
  assert.match(context.cashflowExportText(snapshot),/適用対象外/);
  assert.match(context.cashflowCsvText(snapshot),/適用対象外/);
});

test('方式別の画面・印刷はSTEP3の同じ税額を受け取り、案別予定月を渡す',()=>{
  const elements=new Map();
  const $=id=>{
    if(!elements.has(id)) elements.set(id,{value:'',innerHTML:'',textContent:'',checked:false,
      classList:{add(){},remove(){},toggle(){}},options:[],selectedOptions:[{textContent:id}],
      closest(){ return this; },querySelector(){ return {textContent:id}; }});
    return elements.get(id);
  };
  const options=()=>['','regular','simplified','special2','special3'].map(value=>({value,hidden:false,disabled:false}));
  for(const id of ['cashflowBaseMethod','cashflowChangedMethod','cashflowPriorProxyMethod']) $(id).options=options();
  $('cashflowInterimStatus').value='none';
  $('cashflowAutoBasis').value='step3';
  $('cashflowBaseSettlementMonth').value='2029-02';
  $('cashflowChangedSettlementMonth').value='2029-03';
  $('cashflowSameInterim').checked=true;
  const adapter={ready:true,scenario:'current',periodStart:'2028-01',periodEnd:'2028-12',periodEndDate:'2028-12-31',
    annualTax:{base:100000,changed:70000},plans:{base:{label:'一般課税',amount:100000,amountStatus:'calculated',precision:'申告書段階',eligibility:ELIGIBILITY.ELIGIBLE},
      changed:{label:'簡易課税',amount:70000,amountStatus:'calculated',precision:'申告書段階',eligibility:ELIGIBILITY.ELIGIBLE}},
    assumptions:[],reasons:[]};
  const engine={status:'complete',reasons:[],maxDrawdown:{amount:0,month:null},finalCumulative:30000,
    periodEndCumulative:0,settlement:{base:100000,changed:70000},
    settlementMonths:{base:{paymentMonth:'2029-02'},changed:{paymentMonth:'2029-03'}},rows:[{
    month:'2029-03',baseTax:{interim:0,settlement:0,refund:0},changedTax:{interim:0,settlement:70000,refund:0},net:-70000,cumulative:30000}]};
  let received;
  const context=vm.createContext({$,ELIGIBILITY,METHOD_LABELS:{regular:'一般課税',simplified:'簡易課税'},
    selectedValue:()=> 'individual',
    selectedComparisonMethods:()=>['regular','simplified'],cashflowMethodPairTouched:false,
    ShohizeiMethodCashflowAdapter:{create:()=>adapter},ShohizeiCashflow:{calculate:input=>{received=input;return engine;}},
    cashflowManualFromAuto:false,cashflowAutoSeparateUnconfirmed:false,importedCsvRecovery:null,cashflowMonthSources:{},
    CASHFLOW_MONTH_IDS:{cashflowSettlementMonth:'payment',cashflowRefundMonth:'refund',
      cashflowBaseSettlementMonth:'payment',cashflowBaseRefundMonth:'refund',
      cashflowChangedSettlementMonth:'payment',cashflowChangedRefundMonth:'refund'},
    CASHFLOW_MONTH_LABELS:{cashflowSettlementMonth:'確定納付予定月',cashflowRefundMonth:'還付入金予定月',
      cashflowBaseSettlementMonth:'基準案A・確定納付予定月',cashflowBaseRefundMonth:'基準案A・還付入金予定月',
      cashflowChangedSettlementMonth:'変更案B・確定納付予定月',cashflowChangedRefundMonth:'変更案B・還付入金予定月'},
    cashflowPlanCharts:(result,partial,labels)=>require('../cashflow-event-chart').render({rows:result.rows,taxComplete:!partial,labels}),methodCashflowTableHtml:()=>'<table>month</table>',
    cashflowAutoHtml:()=>'',yen:value=>`${value.toLocaleString('ja-JP')}円`,escapeHtml:value=>String(value),
    latestCashflow:null});
  vm.runInContext(`${source('methodPlanDisplay')}\n${source('methodPlanStatusLabel')}\n${source('renderMethodCashflow')}`,context);
  context.renderMethodCashflow({ctx:{start:'2028-01-01',end:'2028-12-31',taxScenario:'current',currentReturnMethod:'regular'}});
  assert.deepEqual(JSON.parse(JSON.stringify(received.annualTax)),{base:100000,changed:70000});
  assert.equal(received.settlementByPlan.base.paymentMonth,'2029-02');
  assert.equal(received.settlementByPlan.changed.paymentMonth,'2029-03');
  assert.match($('cashflowResult').innerHTML,/100,000円/);
  assert.match($('cashflowResult').innerHTML,/70,000円/);
  assert.match($('cashflowPrintReport').innerHTML,/100,000円/);
  assert.match($('cashflowPrintReport').innerHTML,/70,000円/);
  assert.equal(context.latestCashflow.engine,engine);
});

test('前期代理額はA/Bの入替えに連動せず、国税内訳不明の本則調整は停止する',()=>{
  const controls=new Map();
  const $=id=>{ if(!controls.has(id)) controls.set(id,{value:''}); return controls.get(id); };
  $('cashflowAutoBasis').value='step3';
  $('cashflowPriorProxyMethod').value='regular';
  $('cashflowPeriodShortening').value='none';
  $('cashflowCorporateExtension').value='none';
  $('cashflowSpecialCircumstances').value='none';
  const context=vm.createContext({$,METHOD_LABELS:{regular:'一般課税',simplified:'簡易課税'},
    ELIGIBILITY,selectedComparisonMethods:()=>['regular','simplified'],selectedValue:()=> 'corporation',
    ShohizeiMethodCashflowAdapter:methodAdapter,
    cashflowAutoSeparateUnconfirmed:false,ShohizeiTaxCalendar:{shiftMonths:()=> '2027-01-01',shiftDays:()=> '2027-12-31'},
    declarationRoundedAmount:(_calc,key,_credit,_amount,details)=>{ details[key]={declaration:{nationalAmount:key==='regular'?78000:55000}}; },
    ShohizeiInterimTax:{plan:input=>({status:'ready',count:0,installments:[],totals:{total:0},priorNationalTax:input.priorNationalTax})},
    parseAmountInput:()=>({entered:false,valid:false}),yen:value=>`${value}円`});
  vm.runInContext(source('methodCashflowAutoPlan'),context);
  const calc={ctx:{start:'2028-01-01',end:'2028-12-31',taxScenario:'current'},methods:[
    {key:'regular',amount:100000,eligibility:ELIGIBILITY.ELIGIBLE},
    {key:'simplified',amount:70000,eligibility:ELIGIBILITY.ELIGIBLE}],purchases:{adjustment:0},regularCredit:{},
    returnCalculation:{referenceCalculable:true,mainReturn:{national:78000,local:22000,totalBeforeInterim:100000}}};
  const first=context.methodCashflowAutoPlan(calc,{baseKey:'regular',changedKey:'simplified'});
  const swapped=context.methodCashflowAutoPlan(calc,{baseKey:'simplified',changedKey:'regular'});
  assert.equal(first.basis.national,78000);
  assert.equal(swapped.basis.national,78000);
  assert.equal(swapped.base,swapped.changed);
  calc.ctx.taxScenario='current';
  calc.returnCalculation={referenceCalculable:true,mainReturn:{national:79000,local:21000,totalBeforeInterim:100000}};
  assert.equal(context.methodCashflowAutoPlan(calc,{}).basis.national,79000);
  calc.returnCalculation.mainReturn.totalBeforeInterim=100001;
  assert.equal(context.methodCashflowAutoPlan(calc,{}).basis.national,null);
  calc.purchases.adjustment=1000;
  const unsafe=context.methodCashflowAutoPlan(calc,{});
  assert.equal(unsafe.ready,false);
  assert.equal(unsafe.basis.national,null);
  assert.match(unsafe.basis.reasons.join(' '),/個別調整額/);
  calc.ctx.taxScenario='foodProposal';
  const current={comparisonReady:true,ctx:{taxScenario:'current'},sales:{},purchases:{adjustment:0},regularCredit:0,
    methods:[{key:'regular',amount:90000,eligibility:ELIGIBILITY.ELIGIBLE}]};
  assert.equal(context.methodCashflowAutoPlan(calc,{current}).basis.national,78000);
  current.purchases.adjustment=500;
  assert.equal(context.methodCashflowAutoPlan(calc,{current}).basis.national,null);
});
