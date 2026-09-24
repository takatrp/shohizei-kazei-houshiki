'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}
function context(names, values){
  const target = vm.createContext({...values});
  vm.runInContext(names.map(source).join('\n'), target);
  return target;
}

test('[T01-T04] 列表示とEnter順序は同じ方式・シナリオ判定で切り替わり、値は保持する', () => {
  let methods = ['regular'];
  let scenario = 'current';
  const rows = {sales:[{id:'s',code:'1',rate:'8',amount:'1080000',businessType:'type5',foodAmount:'540000'}],
    purchases:[{id:'p',code:'5',rate:'8',amount:'540000',foodAmount:'270000'}]};
  const h = context(['showBusinessTypeColumn','showFoodAmountColumn','nextTaxRowField','purchaseRowsForScenario'], {
    selectedComparisonMethods:()=>methods, taxScenarioKey:()=>scenario, taxEntryRows:rows
  });
  const order = (row,side) => {
    const fields = ['code'];
    while(true){
      const next = h.nextTaxRowField(row,side,fields.at(-1));
      if(!next) return fields;
      fields.push(next);
    }
  };
  assert.deepEqual(order(rows.sales[0],'sales'),['code','rate','amount']);
  assert.deepEqual(order(rows.purchases[0],'purchases'),['code','rate','amount']);
  assert.equal(h.showBusinessTypeColumn(),false);
  assert.equal(h.showFoodAmountColumn(),false);
  assert.equal(h.purchaseRowsForScenario('current')[0].foodAmount,'');
  assert.equal(rows.purchases[0].foodAmount,'270000','非表示中の元行は変更しない');
  methods = ['regular','simplified'];
  assert.deepEqual(order(rows.sales[0],'sales'),['code','businessType','rate','amount']);
  assert.equal(rows.sales[0].businessType,'type5');
  methods = ['regular'];
  scenario = 'foodProposal';
  assert.deepEqual(order(rows.sales[0],'sales'),['code','rate','amount','foodAmount']);
  assert.deepEqual(order(rows.purchases[0],'purchases'),['code','rate','amount','foodAmount']);
  assert.deepEqual(order({...rows.sales[0],rate:'10'},'sales'),['code','rate','amount']);
  methods = ['regular','simplified'];
  assert.deepEqual(order(rows.sales[0],'sales'),['code','businessType','rate','amount','foodAmount']);
  assert.equal(rows.sales[0].foodAmount,'540000');
  assert.equal(h.purchaseRowsForScenario('foodProposal')[0].foodAmount,'270000');
});

test('[T01-T04][T09] 隠す列はth/tdとも非表示になり、表幅は必要列だけで決まる', () => {
  let business = false;
  let food = false;
  const cells = side => (side === 'sales' ? ['businessType','foodAmount'] : ['foodAmount'])
    .map(rowColumn => ({dataset:{rowColumn},hidden:false}));
  const tables = {sales:{dataset:{},columns:cells('sales')},purchases:{dataset:{},columns:cells('purchases')}};
  for(const table of Object.values(tables)) table.querySelectorAll = selector => selector === '[data-row-column]' ? table.columns : [];
  const h = context(['refreshTaxRowTableLayout'], {
    showBusinessTypeColumn:()=>business,showFoodAmountColumn:()=>food,refreshTaxRowControls(){},
    $:id => ({closest:()=>tables[id === 'taxSalesRowBody' ? 'sales' : 'purchases']})
  });
  const check = (expectedSales,expectedPurchases,salesHidden,purchaseHidden) => {
    h.refreshTaxRowTableLayout();
    assert.equal(tables.sales.dataset.rowLayout,expectedSales);
    assert.equal(tables.purchases.dataset.rowLayout,expectedPurchases);
    assert.deepEqual(tables.sales.columns.map(cell => cell.hidden),salesHidden);
    assert.deepEqual(tables.purchases.columns.map(cell => cell.hidden),purchaseHidden);
  };
  check('basic','basic',[true,true],[true]);
  business = true;
  check('business','basic',[false,true],[true]);
  business = false; food = true;
  check('food','food',[true,false],[false]);
  business = true;
  check('business-food','food',[false,false],[false]);
  assert.match(html,/\.tkc-row-table\{min-width:760px/);
  assert.doesNotMatch(html,/\.tkc-row-table\{min-width:1200px/);
  assert.match(html,/\.tkc-row-table \[hidden\]\{display:none!important\}/);
});

test('[T05-T06] 初期案内・全選択・警告への切替は進行ガードと結び付く', () => {
  assert.match(html,/比較・試算する方式（複数選択可）/);
  assert.match(html,/<div class="notice" id="comparisonMethodRequired" role="status">まず、今回試算する方式を選んでください/);
  assert.match(html,/id="selectAllComparisonMethods">すべて選択/);
  assert.match(source('bindEvents'),/selectAllComparisonMethods[\s\S]*input\.checked = true/);
  assert.match(source('bindEvents'),/workflowNext[\s\S]*comparisonMethodAttempted = true[\s\S]*comparisonMethodLabel/);
  assert.match(source('bindEvents'),/data-workflow-step[\s\S]*comparisonMethodAttempted = true[\s\S]*comparisonMethodLabel/);
  assert.match(source('renderWorkflow'),/methodNotice\.classList\.toggle\('warn', comparisonMethodAttempted && !methodSelected\)/);
  assert.match(source('resetAll'),/comparisonMethodAttempted = false/);
  assert.match(html,/#comparisonMethodChoices input:checked \+ label::before\{content:'✓ '/);
});

test('[T07-T08] 単独試算と比較可能範囲が限定された複数方式を区別する', () => {
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)) elements.set(id,{innerHTML:'',style:{},classList:{toggle(){}}});
    return elements.get(id);
  };
  const h = context(['renderHero'],{
    $:element,escapeHtml:String,yen:value=>`${value}円`,amountClass:()=>'',csvReviewNotice:()=>'',
    METHOD_LABELS:{regular:'本則課税',simplified:'簡易課税'},ELIGIBILITY:{INELIGIBLE:'ineligible'}
  });
  const base = {ctx:{comparisonMethods:['regular']},inputErrors:[],hasComparisonInput:true,salesEntryRequired:false,
    methods:[{key:'regular',eligibility:'eligible'}],best:{key:'regular',amount:500000},
    sorted:[{key:'regular',amount:500000}],unknownMethods:[],csvReview:{},comparisonProvisional:false};
  h.renderHero(base);
  assert.match(element('resultHero').innerHTML,/一般課税の試算結果/);
  assert.doesNotMatch(element('resultHero').innerHTML,/他方式|との差|最も有利/);
  h.renderHero({...base,ctx:{comparisonMethods:['regular','simplified']},
    methods:[{key:'regular',eligibility:'eligible'},{key:'simplified',eligibility:'unknown'}],unknownMethods:[{}]});
  assert.match(element('resultHero').innerHTML,/現在金額を比較できるのは1方式だけ/);
  assert.match(html,/id="resultMethodSelection"/);
  assert.match(source('bindEvents'),/changeComparisonMethods[\s\S]*workflowStep = 1/);
});
