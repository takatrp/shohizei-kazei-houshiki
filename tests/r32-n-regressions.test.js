'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cashflow = require('../cashflow-engine.js');
const interim = require('../interim-tax-engine.js');
const calendar = require('../tax-calendar.js');
const {migrateSavedState} = require('../switch-decision.js');

const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,name);
  const end = html.indexOf('\nfunction ',start + 1);
  return html.slice(start,end < 0 ? undefined : end);
}
function input(interimInput){
  return {periodStart:'2027-04',periodEnd:'2028-03',salesDeltas:[{month:'2027-04',amount:-7000000}],
    purchaseDeltas:[{month:'2027-04',amount:-4900000}],annualTax:{base:2400000,changed:300000},
    salesLag:0,purchaseLag:0,interim:interimInput,settlementMonth:'2028-05',refundMonth:'2028-06'};
}
const one = [{month:'2027-11',amount:1200000}];

test('N02 自動1回／0回は両案の税額を精算し、架空の0円イベントを作らない',()=>{
  const result = cashflow.calculate(input({status:'auto',base:one,changed:[]}));
  assert.equal(result.status,'complete');
  assert.equal(result.settlement.base,1200000);
  assert.equal(result.settlement.changed,300000);
  assert.equal(result.finalCumulative,0);
  assert.equal(result.rows.reduce((sum,row)=>sum+row.changedTax.interim,0),0);
});

test('N02 自動0回／0回は完成するが、未確認空欄は完成しない',()=>{
  const zero = cashflow.calculate(input({status:'auto',base:[],changed:[]}));
  assert.equal(zero.status,'complete');
  assert.equal(zero.settlement.base,2400000);
  assert.equal(zero.settlement.changed,300000);
  for(const status of ['unknown','scheduled']){
    const result = cashflow.calculate(input({status,base:[],changed:[]}));
    assert.equal(result.status,'partial');
    assert.equal(result.settlement,null);
  }
});

test('N02 自動から手入力へ移した0回確認を保ち、一方だけ空欄未確認は止める',()=>{
  const confirmed = cashflow.calculate(input({status:'scheduled',base:one,changed:[],changedNoInterim:true}));
  assert.equal(confirmed.status,'complete');
  assert.equal(confirmed.settlement.changed,300000);
  assert.equal(cashflow.calculate(input({status:'scheduled',base:one,changed:[]})).status,'partial');
  assert.equal(cashflow.calculate(input({status:'scheduled',base:[],changed:[],baseNoInterim:true,changedNoInterim:true})).status,'complete');
  assert.throws(()=>cashflow.calculate(input({status:'scheduled',base:one,changed:[],baseNoInterim:true,changedNoInterim:true})),/同時に指定/);
});

test('N02 手入力の任意納付予定を中間納付なしへ勝手に変えない',()=>{
  const result = cashflow.calculate(input({status:'scheduled',base:[{month:'2027-11',amount:0}],changed:one}));
  assert.equal(result.status,'complete');
  assert.equal(result.settlement.base,2400000);
  assert.equal(result.settlement.changed,-900000);
});

function basisContext(adjustment,method='regular',actual=false){
  const controls = {cashflowAutoBasis:{value:actual?'actual':'step3'},cashflowAutoSeparate:{checked:true},
    cashflowPriorNationalTax:{value:'1,872,000'},cashflowPriorStart:{value:'2025-01-01'},cashflowPriorEnd:{value:'2025-12-31'}};
  const ctx = vm.createContext({$:id=>controls[id],ShohizeiTaxCalendar:calendar,ShohizeiInterimTax:interim,
    parseAmountInput:value=>({entered:true,valid:true,value:Number(String(value).replaceAll(',',''))}),
    ELIGIBILITY:{INELIGIBLE:'ineligible'},yen:value=>String(value),
    declarationRoundedAmount:(_calc,key,_credit,_amount,details)=>{details[key]={declaration:{nationalAmount:4992000,total:6400000}};}});
  vm.runInContext(source('cashflowAutoBasis'),ctx);
  const calc = {ctx:{start:'2027-04-01',end:'2028-03-31'},purchases:{adjustment}};
  const comparison = {current:{ctx:{start:'2027-04-01'},sales:{},purchases:{adjustment},regularCredit:0},
    rows:[{key:method,currentMethod:{amount:6400000,eligibility:'eligible'},proposalMethod:{amount:4300000}}]};
  return {basis:ctx.cashflowAutoBasis(calc,comparison,method),controls};
}

test('N03 本則の未配分調整は正負とも両案のSTEP3前期代理を止める',()=>{
  for(const amount of [4000000,-100000]){
    const {basis} = basisContext(amount);
    assert.equal(basis.national,null);
    assert.equal(basis.changedNational,null);
    assert.match(basis.reasons.join(' '),/前期確定国税額を入力して計算/);
  }
});

test('N03 調整0円・他方式・前期国税直接入力は不要に止めない',()=>{
  assert.equal(basisContext(0).basis.national,4992000);
  assert.equal(basisContext(4000000,'simplified').basis.national,4992000);
  assert.equal(basisContext(4000000,'regular',true).basis.national,1872000);
});

test('N01 旧r32のonと新項目のない古い保存値は区別できる',()=>{
  const ambiguous = migrateSavedState({saveEnabled:true,schemaVersion:17,cashflowAutoSeparate:'on'});
  const old = migrateSavedState({saveEnabled:true,schemaVersion:16});
  assert.equal(ambiguous.cashflowAutoSeparate,'on');
  assert.equal(Object.hasOwn(old,'cashflowAutoSeparate'),false);
  assert.match(source('restoreState'),/Object\.hasOwn\(data,'cashflowAutoSeparate'\)/);
  assert.match(source('cashflowAutoPlan'),/separateUnconfirmed \? unavailable/);
});
