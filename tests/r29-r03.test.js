'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const journal = require('../journal-csv.js');
const taxRows = require('../tax-entry-rows.js');
const { rowsFromJournalAnalysis } = require('../tax-entry-csv.js');
const { APP_META } = require('../release-history.js');
const engine = require('../tax-engine.js');
const { migrateSavedState } = require('../switch-decision.js');

// Reuse the existing DOM harness without registering its own test cases twice.
// Its functionSource() always extracts the current production index.html code.
const integrationPath = path.join(__dirname, 'index-integration.test.js');
const integrationRequire = createRequire(integrationPath);
const harnessScope = {
  __dirname,
  require(id){ return id === 'node:test' ? () => {} : integrationRequire(id); }
};
vm.runInNewContext(`${fs.readFileSync(integrationPath, 'utf8')}\n` +
  'globalThis.r03Harness = { currentRateComparisonHarness, csvRow, csv, functionSource };',
  harnessScope, { filename:integrationPath });
const { currentRateComparisonHarness, csvRow, csv, functionSource } = harnessScope.r03Harness;

function historicalCsv({ purchases = [{ date:'2026/05/01', credit:'80', amount:1100000 }] } = {}){
  return csv([
    csvRow({ date:'2026/05/01', rate:'10', amount:11000000, business:'5' }),
    csvRow({ date:'2026/05/01', code:'3', rate:'10', amount:10000000, business:'5' }),
    ...purchases.map(item => csvRow({ side:'借方', account:'仕入', code:'52', rate:'10', ...item })),
    csvRow({ date:'2026/05/01', side:'借方', account:'仕入', code:'6', rate:'10', amount:1100000 }),
    csvRow({ date:'2026/05/01', side:'借方', account:'仕入', code:'7', rate:'10', amount:1100000 })
  ]);
}

function importedComparison(source, start, end){
  const h = currentRateComparisonHarness();
  h.context.APP_META = APP_META;
  h.context.entryMode = 'rows';
  h.context.taxEntryRows = { sales:[], purchases:[] };
  h.context.rowCsvKnownZeros = {};
  h.context.rowsFromJournalAnalysis = rowsFromJournalAnalysis;
  h.context.newTaxEntry = side => taxRows.createTaxEntryRow(side,{id:`blank-${side}`});
  h.context.renderTaxEntryRows = () => {};
  h.context.document.body = {dataset:{}};
  h.context.pendingJournalImport = {
    analysis:journal.analyzeTkcJournalText(source), sourceText:source, decisions:{}, applied:false
  };
  h.element('periodStart').value = start;
  h.element('periodEnd').value = end;
  h.element('applyCsvDateRange').checked = false;
  h.element('journalImportMode').value = 'replace';
  h.element('taxScenarioFood1').checked = false;
  h.element('taxScenarioCurrent').checked = true;
  h.element('regularDetailMethod').value = 'individual';
  h.context.applyJournalImport();
  assert.equal(h.context.pendingJournalImport.applied,true,'the production CSV reflection path must succeed');
  h.context.syncTaxEntryRows();
  return h;
}

function premiseOutputs(h, calc){
  h.context.renderPrintAssumptions(calc);
  h.context.renderComparisonPrint(calc,null,'<tr><th>方式</th></tr>','<tr><td>本則課税</td></tr>');
  return {
    copy:h.context.buildSummaryText(calc),
    csv:h.context.buildCsvText(calc),
    print:h.element('printAssumptions').innerHTML,
    comparisonPrint:h.element('comparisonPrintContent').innerHTML
  };
}

test('[R03-A] 過年度CSVの元80％→対象期70％・控除対象仕入税額差額を通常コピー・CSV・印刷へ残す', () => {
  const h = importedComparison(historicalCsv(), '2026-10-01', '2027-09-30');
  const calc = h.context.calculate();
  assert.equal(calc.regular.amount,880000);
  assert.equal(calc.purchases.purchaseTaxByUse.taxableOnly,70000);
  assert.equal(calc.purchases.historicalRatioAdjustment,-10000);
  for(const [kind, output] of Object.entries(premiseOutputs(h,calc))){
    assert.match(output,/2026-05-01|2026年5月1日/,`${kind}: original transaction date`);
    assert.match(output,/2026-10-01|2026年10月1日/,`${kind}: target start`);
    assert.match(output,/2027-09-30|2027年9月30日/,`${kind}: target end`);
    assert.match(output,/元(?:資料|取引|CSV)[^\n]{0,100}80％/u,`${kind}: source ratio`);
    assert.match(output,/対象期[^\n]{0,100}70％/u,`${kind}: applied target ratio`);
    assert.match(output,/控除対象仕入税額[^\n]{0,40}(?:換算差額|差額)[^\n]{0,30}(?:−|-)10,000円/u,`${kind}: creditable tax difference is not payment difference`);
    assert.match(output,/均等|日数/u,`${kind}: weighted target-period conversion method`);
    assert.match(output,/金額[^\n]{0,40}(?:期間按分|年換算)/u,`${kind}: amount must not be confused with ratio conversion`);
  }
});

test('[R03-B] 複数の元割合と手入力行を区別して予測換算の範囲を出力する', () => {
  const source = historicalCsv({ purchases:[
    {date:'2026/05/01',credit:'80',amount:1100000},
    {date:'2027/05/01',credit:'70',amount:1100000}
  ]});
  const h = importedComparison(source,'2028-10-01','2029-09-30');
  h.context.taxEntryRows.purchases.push({id:'manual-purchase',code:'5',rate:'10',amount:'110000',source:'manual'});
  h.context.syncTaxEntryRows();
  const calc = h.context.calculate();
  assert.equal(calc.purchases.purchaseTaxByUse.taxableOnly,110000);
  assert.equal(calc.regular.amount,840000);
  const premise = new Map(h.context.buildAssumptionRows(calc));
  const note = [...premise.values()].join(' ');
  assert.match(note,/80％/u);
  assert.match(note,/70％/u);
  assert.match(note,/50％/u);
  assert.match(note,/CSV/u);
  assert.match(note,/手入力/u);
  assert.doesNotMatch(note,/手入力[^。\n]*元(?:CSV|資料)[^。\n]*80％/u);
});

test('[R03-C] うるう年の境界日数加重と表示の採用割合は内部計算に一致する', () => {
  const h = importedComparison(historicalCsv(),'2028-01-01','2028-12-31');
  const calc = h.context.calculate();
  const targetRatio = (274 * .7 + 92 * .5) / 366;
  assert.ok(Math.abs(calc.purchases.historicalForecastRatio - targetRatio) < 1e-12);
  assert.ok(Math.abs(calc.purchases.purchaseTaxByUse.taxableOnly - 100000 * targetRatio) < 1e-7);
  const note = [...new Map(h.context.buildAssumptionRows(calc)).values()].join(' ');
  assert.match(note,/274日/u);
  assert.match(note,/92日/u);
  assert.match(note,/日数/u);
});

test('[R03-D] 換算なしには注記不要、換算差額0円でも実施した換算は落とさない', () => {
  const samePeriod = importedComparison(historicalCsv(),'2026-04-01','2026-09-30');
  const sameCalc = samePeriod.context.calculate();
  assert.equal(sameCalc.purchases.historicalForecastRatio,null);
  assert.doesNotMatch(samePeriod.context.buildSummaryText(sameCalc),/控除対象仕入税額の換算差額/u);
  const priorSameRatio = importedComparison(historicalCsv(),'2026-07-01','2026-09-30');
  const priorCalc = priorSameRatio.context.calculate();
  assert.equal(priorCalc.purchases.historicalRatioAdjustment,0);
  assert.equal(priorCalc.purchases.historicalForecastRatio,.8);
  assert.match(priorSameRatio.context.buildSummaryText(priorCalc),/控除対象仕入税額[^\n]{0,40}換算差額[^\n]{0,20}0円/u);
});

test('[R03-E] 過年度CSVの保存復元と対象期変更で換算前提を現在の元行・計算に合わせて更新する', () => {
  const h = importedComparison(historicalCsv(),'2026-10-01','2027-09-30');
  let saved = null;
  Object.assign(h.context, {
    STORAGE_KEY:'r29-r03-state',
    storageGet:() => saved,
    storageSet:(_key,value) => { saved = value; return true; },
    storageRemove:() => { saved = null; },
    serializeStateIfEnabled:engine.serializeStateIfEnabled,
    migrateSavedState,
    createTaxEntryRow:taxRows.createTaxEntryRow,
    nextTaxEntryId:100,
    foodConfirmationSignatures:{}
  });
  vm.runInContext([functionSource('saveState'),functionSource('restoreState')].join('\n'),h.context);
  h.element('saveToDevice').checked = true;
  const initial = h.context.calculate();
  const initialNote = new Map(h.context.buildAssumptionRows(initial)).get('過年度CSVの控除割合換算');
  assert.equal(initial.regular.amount,880000);
  assert.match(initialNote,/元資料の控除割合80％[^。]*対象期[^。]*70％/u);
  h.context.saveState();
  assert.ok(saved);
  const persisted = JSON.parse(saved);
  assert.equal(persisted.taxEntryRows.purchases.find(row => row.code === '52').sourceDateStart,'2026-05-01');
  assert.equal(persisted.taxEntryRows.purchases.find(row => row.code === '52').creditRatio,'80');
  h.element('periodStart').value = '2029-01-01';
  h.element('periodEnd').value = '2029-12-31';
  h.context.taxEntryRows.purchases.find(row => row.code === '52').creditRatio = '50';
  h.context.importedCsvOrigin = null;
  h.context.restoreState();
  const restored = h.context.calculate();
  const restoredNote = new Map(h.context.buildAssumptionRows(restored)).get('過年度CSVの控除割合換算');
  assert.equal(restored.regular.amount,880000);
  assert.equal(restoredNote,initialNote);
  assert.equal(h.element('periodStart').value,'2026-10-01');
  assert.equal(h.element('periodEnd').value,'2027-09-30');
  h.element('periodStart').value = '2028-01-01';
  h.element('periodEnd').value = '2028-12-31';
  const changed = h.context.calculate();
  const changedNote = new Map(h.context.buildAssumptionRows(changed)).get('過年度CSVの控除割合換算');
  const weighted = (274 * .7 + 92 * .5) / 366;
  assert.ok(Math.abs(changed.purchases.historicalForecastRatio - weighted) < 1e-12);
  assert.ok(Math.abs(changed.purchases.purchaseTaxByUse.taxableOnly - 100000 * weighted) < 1e-7);
  assert.match(changedNote,/元資料の控除割合80％/u);
  assert.match(changedNote,/試算対象期2028-01-01〜2028-12-31/u);
  assert.match(changedNote,/274日×70％＋92日×50％/u);
  assert.doesNotMatch(changedNote,/試算対象期2026-10-01〜2027-09-30/u);
  assert.notEqual(changedNote,initialNote);
});
