'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const engine = require('../tax-engine.js');
const journal = require('../journal-csv.js');
const rows = require('../tax-entry-rows.js');
const {rowsFromJournalAnalysis} = require('../tax-entry-csv.js');
const {migrateSavedState} = require('../switch-decision.js');

// Extract the existing DOM harness, but keep the actual import, restore,
// aggregation, eligibility, calculation, candidate and export functions.
const integrationPath = path.join(__dirname,'index-integration.test.js');
const integrationRequire = createRequire(integrationPath);
const integrationModule = {exports:{}};
new Function('require','module','exports','__dirname','__filename',
  fs.readFileSync(integrationPath,'utf8') + '\nmodule.exports={fourFixRowHarness,functionSource};'
)(id => id === 'node:test' ? (() => {}) : integrationRequire(id),integrationModule,
  integrationModule.exports,__dirname,integrationPath);
const {fourFixRowHarness,functionSource} = integrationModule.exports;
const fixture = fs.readFileSync(path.join(__dirname,'fixtures','r29-r02-explicit-one-percent.csv'),'utf8')
  .replace(',52,5,1,1,1010000,,80,',',52,5,1,1,1010000,,70,');

function savedCsvCase(method, savedRatio, savedAmount){
  const h = fourFixRowHarness({start:'2027-04-01',end:'2028-03-31',scenario:'foodProposal',purchases:[]});
  Object.assign(h.context,{
    rowsFromJournalAnalysis,
    newTaxEntry:side => rows.createTaxEntryRow(side,{id:`empty-${side}`}),
    renderTaxEntryRows:() => {},
    document:{...h.context.document,body:{dataset:{}}},
    calculateEligibility:engine.calculateEligibility,
    STORAGE_KEY:'r29-r02-saved-ratio-synthetic',
    serializeStateIfEnabled:engine.serializeStateIfEnabled,
    migrateSavedState,
    createTaxEntryRow:rows.createTaxEntryRow,
    nextTaxEntryId:100,
    foodConfirmationSignatures:{}
  });
  vm.runInContext([functionSource('percent'),functionSource('getEligibility'),
    functionSource('saveState'),functionSource('restoreState')].join('\n'),h.context);
  h.element('currentReturnMethod').value = 'regular';
  h.element('simpleElectionStatus').value = 'none';
  h.element('baseTaxableSales').value = '10,000,000';
  h.element('journalImportMode').value = 'replace';
  h.element('saveToDevice').checked = true;
  const analysis = journal.analyzeTkcJournalText(fixture);
  assert.equal(journal.resolveImportValues(analysis,{}).ready,true);
  h.context.pendingJournalImport = {sourceText:fixture,analysis,decisions:{},applied:false};
  h.context.applyJournalImport();
  assert.equal(h.context.pendingJournalImport.applied,true);
  const entry = h.context.importedActualOnePercent.entries.find(item => item.kind === 'exemptPurchase');
  assert.equal(entry.creditRatio,0.7,'The ordinary CSV route supplies calculation-form 0.7');
  if(method === 'full'){
    h.context.taxEntryRows.sales.find(row => row.code === '3').amount = '0';
    h.context.syncTaxEntryRows();
    h.element('regularDetailMethod').value = 'auto';
  }else{
    h.element('regularDetailMethod').value = method;
  }
  assert.equal(h.context.calculate().regular.amount,
    {individual:943000,full:793000,proportional:896500}[method],
    `${method}: the unmodified CSV import must remain correct before saving`);
  let saved = null;
  h.context.storageGet = () => saved;
  h.context.storageSet = (_key,value) => { saved = value; return true; };
  h.context.storageRemove = () => { saved = null; };
  h.context.saveState();
  assert.ok(saved,'The production save function must serialize the CSV case');
  const altered = JSON.parse(saved);
  const savedEntry = altered.importedActualOnePercent.entries.find(item => item.kind === 'exemptPurchase');
  savedEntry.creditRatio = savedRatio;
  if(arguments.length >= 3) savedEntry.amount = savedAmount;
  saved = JSON.stringify(altered);
  h.context.importedActualOnePercent = null;
  h.context.importedCsvOrigin = null;
  h.context.restoreState();
  assert.ok(h.context.importedActualOnePercent?.entries?.length,'The production restore function must restore entries');
  return {h,getSaved:() => saved};
}

function regularMethod(calc){ return calc.methods.find(method => method.key === 'regular'); }
function exportedPremises(h,calc){
  h.context.renderPrintAssumptions(calc);
  return [h.context.buildSummaryText(calc),h.context.buildCsvText(calc),h.element('printAssumptions').innerHTML];
}

test('[R02 saved ratio] 70, "70", 0.7 and "0.7" take identical production paths for all three regular methods',()=>{
  for(const [method,expected] of [['individual',943000],['full',793000],['proportional',896500]]){
    for(const notation of [70,'70',0.7,'0.7']){
      const {h} = savedCsvCase(method,notation);
      const calc = h.context.calculate();
      const label = `${method}/${JSON.stringify(notation)}`;
      assert.equal(calc.regular.amount,expected,label);
      assert.equal(regularMethod(calc).amount,expected,label);
      assert.equal(regularMethod(calc).include,true,`${label} must be a comparison candidate`);
      assert.equal(calc.purchases.purchaseRatioConflicts.length,0,label);
      const [copy,csv,printPremises] = exportedPremises(h,calc);
      assert.match(copy,new RegExp(expected.toLocaleString('en-US')),`${label} copy amount`);
      assert.match(csv,new RegExp(`本則課税,[^\\n]*,${expected}(?:,|\\n)`),`${label} CSV amount`);
      assert.match(printPremises,/CSVの取引日範囲/,`${label} print assumptions retain CSV origin`);
      h.context.saveState();
      const resaved = JSON.parse(h.context.storageGet());
      const resavedEntry = resaved.importedActualOnePercent.entries.find(item => item.kind === 'exemptPurchase');
      assert.equal(resavedEntry.creditRatio,0.7,`${label} save must retain a single normalized ratio`);
      h.context.importedActualOnePercent = null;
      h.context.restoreState();
      assert.equal(h.context.calculate().regular.amount,expected,`${label} repeated restore`);
    }
  }
});

test('[R02 saved amount] malformed explicit 1% purchase amounts cannot silently disappear from any regular method',()=>{
  for(const bad of ['',null,'not-an-amount',-1]){
    for(const method of ['individual','full','proportional']){
      const {h} = savedCsvCase(method,0.7,bad);
      const calc = h.context.calculate();
      const label = `${method}/${JSON.stringify(bad)}`;
      assert.equal(calc.regular.amount,null,label);
      assert.equal(regularMethod(calc).amount,null,label);
      assert.equal(regularMethod(calc).include,false,label);
      const reason = [calc.regular.unavailableReasons,regularMethod(calc).reasons,calc.unconfirmedItems]
        .flat(Infinity).join(' ');
      assert.match(reason,/金額|CSV/,`${label} must preserve a reason for the omitted purchase`);
      for(const output of exportedPremises(h,calc)){
        assert.match(output,/金額|CSV/,`${label} export must not hide the invalid input`);
      }
    }
  }
});

test('[R02 saved ratio] wrong 80%, missing and malformed percentages cannot become partial regular estimates',()=>{
  for(const bad of [80,'80','',null,'not-a-ratio',101,-1]){
    for(const method of ['individual','full','proportional']){
      const {h} = savedCsvCase(method,bad);
      const calc = h.context.calculate();
      const label = `${method}/${JSON.stringify(bad)}`;
      assert.equal(calc.regular.amount,null,label);
      assert.equal(regularMethod(calc).amount,null,label);
      assert.equal(regularMethod(calc).include,false,label);
      const reason = [calc.purchases.purchaseRatioConflicts,calc.regular.unavailableReasons,
        regularMethod(calc).reasons,calc.unconfirmedItems].flat(Infinity).join(' ');
      assert.match(reason,/控除割合/,`${label} must retain its reason`);
      assert.ok(calc.methods.some(item => item.key !== 'regular' && item.amount !== null),
        `${label} should not stop purchase-independent estimates`);
      for(const output of exportedPremises(h,calc)){
        assert.match(output,/控除割合/,`${label} export must retain the unresolved premise`);
      }
    }
  }
});

test('[R02 saved summary] restored entries reconcile stale 1% display summaries without duplicate tax',()=>{
  const {h,getSaved} = savedCsvCase('full',70);
  const altered = JSON.parse(getSaved());
  altered.importedActualOnePercent.exemptPurchases['70'] = 0;
  altered.importedActualOnePercent.invoicePurchase = 123456;
  h.context.storageGet = () => JSON.stringify(altered);
  h.context.restoreState();
  assert.equal(h.context.importedActualOnePercent.exemptPurchases['70'],1010000);
  assert.equal(h.context.importedActualOnePercent.invoicePurchase,0);
  assert.equal(h.context.calculate().regular.amount,793000);
});

test('[R02 usage only] unknown usage blocks individual allocation but not a known purchase total',()=>{
  const {h,getSaved} = savedCsvCase('individual',70);
  const altered = JSON.parse(getSaved());
  altered.importedActualOnePercent.entries.find(item => item.kind === 'exemptPurchase').usage = '';
  h.context.storageGet = () => JSON.stringify(altered);
  h.context.restoreState();
  let calc = h.context.calculate();
  assert.equal(calc.regular.amount,null);
  assert.equal(calc.purchases.purchaseCalculationErrors.length,0);
  assert.ok(calc.purchases.purchaseUsageErrors.length);
  h.context.taxEntryRows.sales.find(row => row.code === '3').amount = '0';
  h.context.syncTaxEntryRows();
  h.element('regularDetailMethod').value = 'auto';
  calc = h.context.calculate();
  assert.equal(calc.regular.amount,793000);
  h.context.taxEntryRows.sales.find(row => row.code === '3').amount = '10000000';
  h.context.syncTaxEntryRows();
  h.element('regularDetailMethod').value = 'proportional';
  calc = h.context.calculate();
  assert.equal(calc.regular.amount,896500);
});
