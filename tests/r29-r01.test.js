'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const engine = require('../tax-engine.js');
const {APP_META} = require('../release-history.js');
const taxRows = require('../tax-entry-rows.js');
const {migrateSavedState} = require('../switch-decision.js');

const integrationPath = path.join(__dirname,'index-integration.test.js');
const integrationRequire = createRequire(integrationPath);
const integrationModule = {exports:{}};
new Function('require','module','exports','__dirname','__filename',
  fs.readFileSync(integrationPath,'utf8') + '\nmodule.exports={fourFixRowHarness,functionSource};'
)(id => id === 'node:test' ? (() => {}) : integrationRequire(id), integrationModule,
  integrationModule.exports, __dirname, integrationPath);
const {fourFixRowHarness,functionSource} = integrationModule.exports;

function realCase(purchases = [{code:'5',rate:'10',amount:'8800000'}]){
  const h = fourFixRowHarness({start:'2027-04-01',end:'2028-03-31',scenario:'current',purchases});
  h.context.APP_META = APP_META;
  h.context.calculateEligibility = engine.calculateEligibility;
  h.context.assessHighValueAsset = engine.assessHighValueAsset;
  h.context.optimizeFourPeriodRoutes = engine.optimizeFourPeriodRoutes;
  vm.runInContext(['getEligibility','assessHighAssetForMethod','dateAddYears','projectionPeriods',
    'projectionBaseForIndex','contextWithProjectionBase','projectProposalSales',
    'projectionSnapshot','calculateProjectionRegular','calculateProjectionMethods']
    .map(functionSource).join('\n'),h.context);
  const selected = h.context.selectedValue;
  h.context.legacyCreditMode = 'unknown';
  h.context.selectedValue = (name,fallback) => ({
    entityType:'corporation', creditMode:h.context.legacyCreditMode,
    simpleNoticeReadyState:'yes', highAssetState:'no',
    invoiceRegisteredState:'no', invoiceTransitionState:'no', noSpecialExclusionState:'yes'
  })[name] || selected(name,fallback);
  h.element('baseTaxableSales').value = '10,000,000';
  h.element('currentReturnMethod').value = 'regular';
  h.element('simpleElectionStatus').value = 'none';
  // The new-election comparison needs the actual ordinary-prior-period
  // filing fact; the former broad "yes" had no dated evidence.
  h.element('priorTaxMethod').value = 'regular';
  h.element('electionFilingStatus').value = 'filed';
  h.element('electionFilingDate').value = '2027-03-31';
  h.element('regularDetailMethod').value = 'auto';
  h.element('exemptPurchaseState').value = 'no';
  h.context.taxEntryRows.sales.find(row => row.code === '3').amount = '0';
  h.context.syncTaxEntryRows();
  return h;
}

function regular(calc){ return calc.methods.find(method => method.key === 'regular'); }
function simplified(calc){ return calc.methods.find(method => method.key === 'simplified'); }

test('[R01-A] 新規行入力と実際の制度判定で本則200,000円・簡易500,000円・差300,000円',()=>{
  const h = realCase();
  const calc = h.context.calculate();
  assert.equal(calc.ctx.creditMode,'unknown','hidden legacy control is untouched');
  assert.equal(calc.regular.amount,200000);
  assert.equal(regular(calc).eligibility,engine.ELIGIBILITY.ELIGIBLE);
  assert.equal(regular(calc).include,true);
  assert.equal(simplified(calc).amount,500000);
  assert.equal(simplified(calc).include,true);
  assert.equal(calc.best.key,'regular');
  assert.equal(calc.second,undefined);
  assert.equal(calc.sorted[1].amount - calc.sorted[0].amount,300000);
  assert.match(h.context.buildSummaryText(calc),/本則課税.*200,000円/);
  assert.match(h.context.buildCsvText(calc),/本則課税[^\n]*200000/);
  h.context.renderPrintAssumptions(calc);
  assert.match(h.element('printAssumptions').innerHTML,/本則計算/);
  h.context.renderComparisonPrint(calc,null,'', '<tr><td>本則課税</td><td>200,000円</td></tr>');
  assert.match(h.element('comparisonPrintContent').innerHTML,/200,000円/);
});

test('[R01-B/C] 非表示の旧控除設定に依存せず、空欄仕入と明示0円を区別',()=>{
  const h = realCase();
  const original = h.context.calculate();
  for(const mode of ['unknown','confirmed','estimate']){
    h.context.legacyCreditMode = mode;
    h.element('creditPercent').value = '37';
    const calc = h.context.calculate();
    assert.equal(calc.regular.amount,200000);
    assert.equal(regular(calc).eligibility,original.eligibility.regular.eligibility);
  }
  h.context.taxEntryRows.purchases = [];
  h.element('regularAdjustment').value = '0';
  h.context.syncTaxEntryRows();
  const missing = h.context.calculate();
  assert.equal(missing.purchases.purchaseAmountEntered,false,JSON.stringify({purchase10:h.element('purchase10').value,purchase8:h.element('purchase8').value,knownZeros:h.context.rowCsvKnownZeros,rows:h.context.taxEntryRows.purchases}));
  assert.equal(missing.regular.amount,null);
  assert.equal(regular(missing).include,false);
  assert.match(regular(missing).reason,/仕入.*未入力/);
  h.context.taxEntryRows.purchases.push({id:'zero-purchase',code:'5',rate:'10',amount:'0',foodAmount:'',source:'manual'});
  h.context.syncTaxEntryRows();
  const zero = h.context.calculate();
  assert.equal(zero.regular.amount,1000000);
  assert.equal(regular(zero).include,true);
});

test('[R01-D/E] 非課税売上不足・届出継続制限は計算可否と選択可否を別々に止める',()=>{
  const h = realCase();
  h.context.taxEntryRows.sales.find(row => row.code === '3').amount = '';
  h.context.syncTaxEntryRows();
  const missingSales = h.context.calculate();
  assert.equal(missingSales.regular.amount,null);
  assert.match(regular(missingSales).reason,/非課税売上/);
  h.context.taxEntryRows.sales.find(row => row.code === '3').amount = '0';
  h.context.syncTaxEntryRows();
  h.element('currentReturnMethod').value = 'simplified';
  h.element('simpleElectionStatus').value = 'first';
  const restricted = h.context.calculate();
  assert.equal(restricted.regular.amount,200000);
  assert.equal(regular(restricted).include,false);
  assert.notEqual(regular(restricted).selectionEligibility.eligibility,engine.ELIGIBILITY.ELIGIBLE);
  assert.match(h.context.buildSummaryText(restricted),/本則課税.*(?:未確認|対象外)/);
});

test('[R01-F] 本番の4期計算と経路判定で各期200,000円・累計800,000円',()=>{
  const h = realCase();
  h.context.viewModeKey = () => 'projection';
  const calc = h.context.calculate();
  const plan = h.context.calculateProjectionPlan(calc);
  assert.equal(plan.projections.length,4);
  assert.deepEqual(Array.from(plan.projections,projection => projection.methods.find(method => method.key === 'regular').amount),
    [200000,200000,200000,200000]);
  assert.equal(plan.optimized.ok,true);
  assert.equal(plan.optimized.cumulative,800000);
});

test('[R01-B保存] 旧控除設定が未確認のまま行入力を保存・復元しても本則の候補と金額を維持',()=>{
  const h = realCase();
  let saved = null;
  Object.assign(h.context,{
    STORAGE_KEY:'r29-r01-synthetic', storageGet:() => saved,
    storageSet:(_key,value) => {saved = value; return true;}, storageRemove:() => {saved = null;},
    serializeStateIfEnabled:engine.serializeStateIfEnabled, migrateSavedState,
    createTaxEntryRow:taxRows.createTaxEntryRow, newTaxEntry:side => taxRows.createTaxEntryRow(side),
    renderTaxEntryRows:() => {}, nextTaxEntryId:200, foodConfirmationSignatures:{}
  });
  h.context.document = {...h.context.document,body:{dataset:{}}};
  vm.runInContext([functionSource('saveState'),functionSource('restoreState')].join('\n'),h.context);
  h.element('saveToDevice').checked = true;
  h.context.saveState();
  assert.ok(saved);
  assert.equal(JSON.parse(saved).creditMode,'unknown');
  h.context.taxEntryRows = {sales:[],purchases:[]};
  h.context.restoreState();
  const restored = h.context.calculate();
  assert.equal(restored.regular.amount,200000);
  assert.equal(regular(restored).include,true);
});
