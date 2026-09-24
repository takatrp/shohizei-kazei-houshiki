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

// Reuse the existing fake DOM, but invoke current production functions. Its
// old all-eligible calculation stub is replaced with the real eligibility.
const integrationPath = path.join(__dirname, 'index-integration.test.js');
const integrationRequire = createRequire(integrationPath);
const integrationModule = {exports:{}};
new Function('require','module','exports','__dirname','__filename',
  fs.readFileSync(integrationPath,'utf8') + '\nmodule.exports={fourFixRowHarness,functionSource};'
)(id => id === 'node:test' ? (() => {}) : integrationRequire(id), integrationModule,
  integrationModule.exports, __dirname, integrationPath);
const {fourFixRowHarness,functionSource} = integrationModule.exports;

const originalCsv = fs.readFileSync(path.join(__dirname,'fixtures','r29-r02-explicit-one-percent.csv'),'utf8');
const PERIOD_2027 = {start:'2027-04-01',end:'2028-03-31'};

function importedCase(csvText = originalCsv, period = PERIOD_2027){
  const h = fourFixRowHarness({...period,scenario:'foodProposal',purchases:[]});
  h.context.rowsFromJournalAnalysis = rowsFromJournalAnalysis;
  h.context.newTaxEntry = side => rows.createTaxEntryRow(side,{id:`empty-${side}`});
  h.context.renderTaxEntryRows = () => {};
  h.context.document = {...h.context.document,body:{dataset:{}}};
  h.context.calculateEligibility = engine.calculateEligibility;
  vm.runInContext([functionSource('percent'),functionSource('getEligibility')].join('\n'),h.context);
  h.element('currentReturnMethod').value = 'regular';
  h.element('simpleElectionStatus').value = 'none';
  h.element('baseTaxableSales').value = '10,000,000';
  h.element('journalImportMode').value = 'replace';
  reflect(h,csvText);
  return h;
}

function reflect(h,csvText){
  const analysis = journal.analyzeTkcJournalText(csvText);
  assert.equal(journal.resolveImportValues(analysis,{}).ready,true,
    'The synthetic fixture must be accepted by the production CSV parser');
  h.context.pendingJournalImport = {sourceText:csvText,analysis,decisions:{},applied:false};
  h.context.applyJournalImport();
  assert.equal(h.context.pendingJournalImport.applied,true,'CSV must reach production reflection');
  assert.ok(h.context.importedActualOnePercent.entries.some(entry => entry.kind === 'exemptPurchase' || entry.kind === 'invoicePurchase'));
  return h.context.calculate();
}

function withExempt(csvText,{code='52',ratio='80',date='2027/05/01'} = {}){
  return csvText.replace(/^\d{4}\/\d{2}\/\d{2},テスト科目,52,5,1,1,1010000,,80,/m,
    `${date},テスト科目,${code},5,1,1,1010000,,${ratio},`);
}

function regularMethod(calc){ return calc.methods.find(method => method.key === 'regular'); }
function rejectionText(calc){
  return [calc.purchases.purchaseRatioConflicts,calc.regular.unavailableReasons,
    regularMethod(calc).reasons,calc.unconfirmedItems].flat(Infinity).join(' ');
}

test('[R02-A] CSV explicit 1% TKC 52 at 2027-05-01 rejects 80%, and corrected 70% yields 943,000 yen',()=>{
  const h = importedCase();
  const entry = h.context.importedActualOnePercent.entries.find(item => item.kind === 'exemptPurchase');
  assert.equal(entry.taxCode,'52');
  assert.equal(entry.date,'2027-05-01');
  assert.equal(entry.creditRatio,0.8);
  const wrong = h.context.calculate();
  assert.equal(wrong.regular.amount,null,'Wrong source ratio must not remain a 942,000-yen estimate');
  assert.equal(regularMethod(wrong).amount,null);
  assert.equal(regularMethod(wrong).include,false);
  assert.match(rejectionText(wrong),/元取引日|CSV.*取引日/);
  assert.match(rejectionText(wrong),/控除割合/);
  assert.ok(wrong.methods.some(method => method.key !== 'regular' && method.amount !== null),
    'Purchase-independent reference methods should remain available');
  h.context.renderPrintAssumptions(wrong);
  for(const output of [h.context.buildSummaryText(wrong),h.context.buildCsvText(wrong),
    h.element('printAssumptions').innerHTML]){
    assert.match(output,/CSV.*控除割合.*元取引日/,
      'Copy, CSV and ordinary print assumptions must preserve the source-date mismatch');
    assert.doesNotMatch(output,/本則課税[^\n]*942,000円/,
      'An invalid 80% ratio must not be exported as a regular-tax estimate');
  }

  const corrected = reflect(h,withExempt(originalCsv,{ratio:'70'}));
  assert.equal(h.context.importedActualOnePercent.entries.find(item => item.kind === 'exemptPurchase').creditRatio,0.7);
  assert.equal(corrected.sales.totalTax,1000000);
  assert.equal(corrected.purchases.purchaseTaxByUse.taxableOnly,7000);
  assert.equal(corrected.purchases.purchaseTaxByUse.common,100000);
  assert.equal(corrected.regular.amount,943000);
  assert.equal(regularMethod(corrected).amount,943000);
  assert.doesNotMatch(rejectionText(corrected),/元取引日.*控除割合|控除割合.*元取引日/);
});

test('[R02-B] TKC 62 and 72 wrong ratios are checked even when individual credit is zero or shared',()=>{
  for(const [code,expected] of [['62',950000],['72',946500]]){
    const h = importedCase(withExempt(originalCsv,{code}));
    const wrong = h.context.calculate();
    assert.equal(wrong.regular.amount,null,`TKC ${code} mismatch`);
    assert.match(rejectionText(wrong),/控除割合/);
    const corrected = reflect(h,withExempt(originalCsv,{code,ratio:'70'}));
    assert.equal(corrected.regular.amount,expected,`TKC ${code} corrected amount`);
  }
  const invoice = importedCase(originalCsv.replace(',52,5,1,1,1010000,,80,',',5,5,1,1,1010000,,,'));
  assert.equal(invoice.context.importedActualOnePercent.entries[0].kind,'invoicePurchase');
  assert.equal(invoice.context.calculate().purchases.purchaseRatioConflicts.length,0,
    'Invoice purchase must not require an exempt-supplier credit ratio');
});

test('[R02-C] source-date boundary 2028-09-30 is 70%, 2028-10-01 is 50%',()=>{
  const period = {start:'2028-04-01',end:'2029-03-31'};
  for(const [date,ratio,wrongRatio,amount] of [
    ['2028/09/30','70','50',943000],
    ['2028/10/01','50','70',945000]
  ]){
    const originalAtDate = originalCsv.replaceAll('2027/05/01',date);
    const wrong = importedCase(withExempt(originalAtDate,{code:'52',ratio:wrongRatio,date}),period);
    assert.equal(wrong.context.calculate().regular.amount,null,`${date} wrong ${wrongRatio}%`);
    const right = reflect(wrong,withExempt(originalAtDate,{code:'52',ratio,date}));
    assert.equal(right.regular.amount,amount,`${date} correct ${ratio}%`);
  }
});

test('[R02-D] a zero-net ordinary/return pair retains the wrong ordinary source ratio',()=>{
  const returnLine = '2027/05/02,,,,,,,,,テスト科目,53,5,1,1,1010000,,80';
  const pair = `${originalCsv.trimEnd()}\n${returnLine}\n`;
  const h = importedCase(pair);
  const entries = h.context.importedActualOnePercent.entries.filter(entry => entry.kind === 'exemptPurchase');
  assert.equal(entries.length,2);
  assert.equal(entries.reduce((sum,entry) => sum + entry.amount,0),0);
  assert.equal(entries[1].transactionKind,'adjustment');
  const calc = h.context.calculate();
  assert.equal(calc.regular.amount,null);
  assert.match(rejectionText(calc),/控除割合/);
  assert.ok(calc.csvReview.reviewItems.length > 0,'The return still needs its original transaction checked');
});

test('[R02-E] saving/restoring preserves the wrong source ratio; corrected re-import removes only the old conflict',()=>{
  const h = importedCase();
  let saved = null;
  Object.assign(h.context,{
    STORAGE_KEY:'r29-r02-synthetic',
    storageGet:() => saved,
    storageSet:(_key,value) => { saved = value; return true; },
    storageRemove:() => { saved = null; },
    serializeStateIfEnabled:engine.serializeStateIfEnabled,
    migrateSavedState,
    createTaxEntryRow:rows.createTaxEntryRow,
    nextTaxEntryId:100,
    foodConfirmationSignatures:{}
  });
  vm.runInContext([functionSource('saveState'),functionSource('restoreState')].join('\n'),h.context);
  h.element('saveToDevice').checked = true;
  const restore = () => {
    h.context.saveState();
    assert.ok(saved);
    h.context.importedActualOnePercent = null;
    h.context.importedCsvOrigin = null;
    h.context.restoreState();
    assert.ok(h.context.importedActualOnePercent?.entries?.length);
    return h.context.calculate();
  };
  const wrong = restore();
  assert.equal(wrong.regular.amount,null);
  assert.match(rejectionText(wrong),/控除割合/);
  reflect(h,withExempt(originalCsv,{ratio:'70'}));
  const corrected = restore();
  assert.equal(corrected.regular.amount,943000);
  assert.doesNotMatch(rejectionText(corrected),/元取引日.*控除割合|控除割合.*元取引日/);
});

test('[R02-F] saved percentage notation and invalid source date cannot bypass source validation',()=>{
  const h = importedCase(withExempt(originalCsv,{ratio:'70'}));
  const entry = h.context.importedActualOnePercent.entries.find(item => item.kind === 'exemptPurchase');
  entry.creditRatio = 80; // An older save may retain percentage units, not 0..1 units.
  const mismatch = h.context.calculate();
  assert.equal(mismatch.regular.amount,null);
  assert.match(rejectionText(mismatch),/80[％%].*70[％%]/);
  assert.doesNotMatch(rejectionText(mismatch),/8000[％%]/);
  entry.creditRatio = 0.7;
  entry.date = '2027-02-30';
  const invalidDate = h.context.calculate();
  assert.ok(invalidDate.csvReview.errors.length > 0);
  assert.equal(regularMethod(invalidDate).include,false);
  assert.match(invalidDate.csvReview.errors.join(' '),/日付/);
});
