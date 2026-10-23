'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const engine = require('../tax-engine.js');
const journal = require('../journal-csv.js');
const cashJournal = require('../cash-journal.js');
const taxRows = require('../tax-entry-rows.js');
const {rowsFromJournalAnalysis} = require('../tax-entry-csv.js');
const shared = require('../shared-case-facts.js');
const calendar = require('../tax-calendar.js');
const {migrateSavedState} = require('../switch-decision.js');

// Reuse the existing minimal DOM harness without registering its tests. The
// import, save/restore, mode and shared-fact functions below are production code.
const integrationPath = path.join(__dirname,'index-integration.test.js');
const integrationRequire = createRequire(integrationPath);
const integrationModule = {exports:{}};
new Function('require','module','exports','__dirname','__filename',
  fs.readFileSync(integrationPath,'utf8') + '\nmodule.exports={harness,functionSource,csv,csvRow};'
)(id => id === 'node:test' ? (() => {}) : integrationRequire(id),integrationModule,
  integrationModule.exports,__dirname,integrationPath);
const {harness:integrationHarness,functionSource,csv,csvRow} = integrationModule.exports;
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const defaultSource = html.match(/const CASHFLOW_INPUT_DEFAULTS = Object\.freeze\(\{[\s\S]*?\n\}\);/);
assert.ok(defaultSource,'The production cashflow defaults must be available');
const defaults = vm.runInNewContext(defaultSource[0] + '\nCASHFLOW_INPUT_DEFAULTS;');
const clone = value => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = 'shared-facts-ui-test';
const sourcePeriod = {start:'2025-01-01',end:'2025-12-31'};
const target = {ctx:{start:'2028-01-01',end:'2028-12-31',taxScenario:'current'},purchases:{adjustment:0}};

function sourceCsv({amount=108000,rate='8'} = {}){
  const row = csvRow({date:'2025/01/15',amount,rate});
  row['借方科目名'] = '普通預金';
  row['借方取引金額'] = String(amount);
  return csv([row]);
}

function fixture(storage = new Map()){
  const h = integrationHarness(sourceCsv());
  const {context,element} = h;
  const warnings = [];
  const radios = new Map();
  function radio(name,value){
    const key = `${name}:${value}`;
    if(!radios.has(key)){
      const control = {name,value,_checked:false};
      Object.defineProperty(control,'checked',{
        get(){return this._checked;},
        set(checked){
          if(checked) for(const other of radios.values()) if(other.name === name) other._checked = false;
          this._checked = checked === true;
        }
      });
      radios.set(key,control);
    }
    return radios.get(key);
  }
  const methods = ['regular','simplified','special2','special3'].map(value => {
    const control = element('compare'+value[0].toUpperCase()+value.slice(1));
    control.value = value;
    control.checked = value === 'regular';
    return control;
  });
  context.document = {
    body:{dataset:{}},
    querySelector(selector){
      const option = /^input\[name="([^"]+)"\]\[value="([^"]*)"\]$/.exec(selector);
      if(option) return radio(option[1],option[2]);
      const selected = /^input\[name="([^"]+)"\]:checked$/.exec(selector);
      if(!selected) return null;
      if(selected[1] === 'amountMode') return {value:element('modeTaxExcluded').checked ? 'excluded' : 'included'};
      if(selected[1] === 'taxScenario') return {value:element('taxScenarioFood1').checked ? 'foodProposal' : 'current'};
      return [...radios.values()].find(item => item.name === selected[1] && item.checked) || null;
    },
    querySelectorAll(selector){return selector === 'input[name="comparisonMethod"]' ? methods : [];}
  };
  for(const [name,value] of Object.entries({entityType:'individual',workflowPurpose:'regular',
    cashflowComparisonType:'rateImpact',cashActualMode:'csv',creditMode:'unknown'})) radio(name,value).checked = true;
  Object.assign(context,{
    console:{warn:(...args) => warnings.push(args.map(String).join(' '))},
    ShohizeiSharedCaseFacts:shared,ShohizeiCashJournal:cashJournal,ShohizeiTaxCalendar:calendar,
    CASHFLOW_INPUT_DEFAULTS:defaults,
    sharedCaseFacts:{version:1,priorActual:null,csvSource:null},
    importedCsvOriginalSourceId:'',cashActualOriginalSourceId:'',
    cashActualAnalysis:null,cashActualSavedSnapshot:null,cashActualSelectedAccounts:[],
    cashActualOpeningDecisions:{},cashActualTaxDecisions:{},
    cashflowModeStates:{rateImpact:null,methodImpact:null},activeCashflowMode:'rateImpact',
    cashflowMonthSources:{},cashflowManualFromAuto:false,cashflowAutoSeparateUnconfirmed:false,
    cashflowMethodPairTouched:false,step4DisplayTaxMethod:'',step4TransactionBasis:null,
    cashManualRows:{periodKey:'',values:{}},cashManualPreviousRows:null,cashManualInvalidated:false,
    cashManualObservedPeriodKey:'',cashManualRenderedKey:'',
    entryMode:'rows',nextTaxEntryId:1,createTaxEntryRow:taxRows.createTaxEntryRow,
    rowsFromJournalAnalysis,renderTaxEntryRows(){},foodConfirmationSignatures:{},
    importedCsvMonthlyGroups:null,importedCsvMonthlyDateUnknownCount:0,
    STORAGE_KEY,serializeStateIfEnabled:engine.serializeStateIfEnabled,migrateSavedState,
    storageGet:key => storage.get(key) || null,
    storageSet(key,value){storage.set(key,value);return true;},
    storageRemove:key => storage.delete(key),
    // This dependency supplies a fixed STEP3 result; the real basis function
    // must use it only as a proxy and never write it into actual inputs.
    declarationRoundedAmount(_calc,method,_credit,_amount,details){
      details[method] = {declaration:{nationalAmount:780000,total:1000000}};
      return 1000000;
    }
  });
  const functions = [
    'resetSharedCaseFacts','originalCsvSourceFromScope','syncSharedPriorActualInputs',
    'editSharedPriorMethod','editSharedPriorActual','chooseSharedPriorActual','sharedCsvSourceLinked',
    'syncSharedCsvSourceInputs','editSharedCsvSource','chooseSharedCsvSource',
    'acceptSharedCsvImport','restoreSharedCaseFacts',
    'captureCashflowModeState','applyCashflowModeState','activateCashflowMode',
    'cashflowComparisonType','cashflowAutoBasis','cashActualMode','cashActualSelected','cashActualResult',
    'newTaxEntry','saveState','restoreState'
  ];
  vm.runInContext(functions.map(functionSource).join('\n'),context);
  for(const [id,value] of Object.entries(defaults)){
    if(typeof value === 'boolean') element(id).checked = value;
    else element(id).value = value;
  }
  context.resetSharedCaseFacts();
  element('journalImportMode').value = 'replace';
  element('saveToDevice').checked = true;
  return {...h,storage,warnings,radio};
}

function editPrior(h,id,value){h.element(id).value=value;h.context.editSharedPriorActual(id);}
function actual(h,period=sourcePeriod,amount='1,872,000'){
  editPrior(h,'priorPeriodStart',period.start);
  editPrior(h,'priorPeriodEnd',period.end);
  editPrior(h,'cashflowPriorNationalTax',amount);
}
function importCsv(h,text=sourceCsv(),decisions={}){
  h.context.pendingJournalImport = {
    sourceText:text,analysis:journal.analyzeTkcJournalText(text,decisions),decisions,applied:false
  };
  h.context.applyJournalImport();
  assert.equal(h.context.pendingJournalImport.applied,true,h.element('journalImportStatus').textContent);
  assert.ok(h.context.cashActualAnalysis,'The real cash-journal path must have parsed the CSV');
}
function editSource(h,id,value){
  h.element(id)[typeof value === 'boolean' ? 'checked' : 'value'] = value;
  h.context.editSharedCsvSource(id);
}
function confirmSource(h,periodConfirmed=true,coverageConfirmed=true){
  editSource(h,'cashActualSourceStart',sourcePeriod.start);
  editSource(h,'cashActualSourceEnd',sourcePeriod.end);
  editSource(h,'cashActualPeriodConfirmed',periodConfirmed);
  editSource(h,'cashActualCoverageConfirmed',coverageConfirmed);
}
function restore(h){
  h.context.restoreState();
  assert.deepEqual(h.warnings,[],'restoreState must not swallow a harness or migration failure');
}
function assertNoSpecialConfirmations(h){
  for(const id of ['cashAccountConfirmed','cashTaxCoverageConfirmed','cashActualFoodEightConfirmed'])
    assert.equal(h.element(id).checked,false,`${id} must require its own decision`);
  assert.deepEqual(clone(h.context.cashActualOpeningDecisions),{});
  assert.deepEqual(clone(h.context.cashActualTaxDecisions),{});
}

test('[shared UI01] prior actual dates synchronize bidirectionally and a changed period invalidates its filing method',()=>{
  const h=fixture();
  h.element('priorTaxMethod').value='simplified';
  h.element('cashflowPriorProxyMethod').value='special2';
  actual(h);
  assert.equal(h.element('cashflowPriorStart').value,sourcePeriod.start);
  assert.equal(h.element('cashflowPriorEnd').value,sourcePeriod.end);
  assert.equal(h.element('priorTaxMethod').value,'simplified','The initial complete period keeps the explicit method');
  editPrior(h,'cashflowPriorStart','2024-04-01');
  editPrior(h,'cashflowPriorEnd','2025-03-31');
  editPrior(h,'cashflowPriorNationalTax','0');
  assert.equal(h.element('priorPeriodStart').value,'2024-04-01');
  assert.equal(h.element('priorPeriodEnd').value,'2025-03-31');
  assert.equal(h.context.sharedCaseFacts.priorActual.value.nationalTax,'0');
  assert.equal(h.element('priorTaxMethod').value,'unknown','The method for the previous period must not follow the new dates');
  assert.equal(h.element('cashflowPriorProxyMethod').value,'special2');
});

test('[shared UI02] amount-first initial date entry preserves it; editing a complete period clears it',()=>{
  const h=fixture();
  editPrior(h,'cashflowPriorNationalTax','1,872,000');
  editPrior(h,'priorPeriodStart',sourcePeriod.start);
  assert.equal(h.element('cashflowPriorNationalTax').value,'1,872,000');
  editPrior(h,'cashflowPriorEnd',sourcePeriod.end);
  assert.equal(h.element('cashflowPriorNationalTax').value,'1,872,000');
  editPrior(h,'priorPeriodStart','2024-01-01');
  assert.equal(h.element('cashflowPriorNationalTax').value,'');
  assert.equal(h.context.sharedCaseFacts.priorActual.value.nationalTax,'');
  h.element('cashflowAutoBasis').value='actual';
  assert.equal(h.context.cashflowAutoBasis(target,null,'regular').national,null);
});

test('[shared UI03] calculated proxy and changed-plan assumptions never replace prior actual facts',()=>{
  const h=fixture();
  actual(h);
  h.element('cashflowAutoBasis').value='actual';
  const actualBasis=h.context.cashflowAutoBasis(target,null,'regular');
  assert.equal(actualBasis.national,1872000);
  assert.equal(actualBasis.priorStart,sourcePeriod.start);
  const before=clone(h.context.sharedCaseFacts.priorActual);
  h.element('cashflowPriorChangedNationalTax').value='9,999,999';
  h.element('cashflowAutoBasis').value='step3';
  const proxy=h.context.cashflowAutoBasis(target,{
    current:{ctx:target.ctx,sales:{},purchases:{adjustment:0},regularCredit:0},
    rows:[{key:'regular',currentMethod:{amount:1000000,eligibility:'eligible'}}]
  },'regular');
  assert.equal(proxy.national,780000);
  assert.equal(proxy.priorStart,'2027-01-01');
  assert.equal(proxy.priorEnd,'2027-12-31');
  assert.match(proxy.source,/代理/);
  assert.deepEqual(clone(h.context.sharedCaseFacts.priorActual),before);
  assert.equal(h.element('cashflowPriorNationalTax').value,'1,872,000');
  h.element('cashflowAutoBasis').value='actual';
  assert.equal(h.context.cashflowAutoBasis(target,null,'regular').national,1872000);
});

test('[shared UI04] capture/apply/mode switches keep shared facts while restoring local assumptions',()=>{
  const h=fixture();
  actual(h);
  importCsv(h);
  confirmSource(h);
  const before=clone(h.context.sharedCaseFacts);
  const signedScope=h.context.cashflowConfirmedScope;
  h.element('cashflowPriorProxyMethod').value='regular';
  h.element('cashflowSalesLag').value='1';
  const captured=h.context.captureCashflowModeState();
  for(const id of shared.COMMON_MODE_INPUT_IDS) assert.equal(Object.hasOwn(captured.values,id),false,id);
  assert.equal(Object.hasOwn(captured,'confirmedScope'),false);
  h.context.cashflowModeStates.methodImpact={values:{
    cashflowPriorStart:'1999-01-01',cashflowPriorEnd:'1999-12-31',cashflowPriorNationalTax:'999',
    cashflowSourceStart:'1999-01-01',cashflowSourceEnd:'1999-12-31',cashflowSourceConfirmed:false,
    cashflowPriorProxyMethod:'simplified',cashflowSalesLag:'2'
  },confirmedScope:'obsolete'};
  h.context.activateCashflowMode('methodImpact');
  assert.equal(h.element('cashflowSalesLag').value,'2');
  assert.equal(h.element('cashflowPriorProxyMethod').value,'simplified');
  assert.equal(h.element('cashflowPriorNationalTax').value,'1,872,000');
  assert.equal(h.element('cashflowPriorStart').value,sourcePeriod.start);
  assert.equal(h.element('cashflowSourceConfirmed').checked,true);
  assert.equal(h.context.cashflowConfirmedScope,signedScope);
  h.context.activateCashflowMode('rateImpact');
  assert.equal(h.element('cashflowSalesLag').value,'1');
  assert.equal(h.element('cashflowPriorProxyMethod').value,'regular');
  assert.deepEqual(clone(h.context.sharedCaseFacts),before);
  for(const state of Object.values(h.context.cashflowModeStates))
    for(const id of shared.COMMON_MODE_INPUT_IDS) assert.equal(Object.hasOwn(state.values,id),false,id);
});

test('[shared UI05] production save/restore roundtrip uses canonical facts in a fresh VM',()=>{
  const storage=new Map(),before=fixture(storage);
  actual(before,sourcePeriod,'0');
  before.element('priorTaxMethod').value='simplified';
  importCsv(before);
  confirmSource(before,true,false);
  before.element('cashflowAutoBasis').value='step3';
  before.element('cashflowPriorProxyMethod').value='special2';
  before.context.saveState();
  const saved=JSON.parse(storage.get(STORAGE_KEY));
  assert.equal(saved.sharedCaseFacts.priorActual.value.nationalTax,'0');
  assert.equal(saved.cashActualSavedSnapshot,null);
  for(const id of shared.COMMON_MODE_INPUT_IDS)
    assert.equal(Object.hasOwn(saved.cashflowModeStates.rateImpact.values,id),false,id);
  assert.equal(storage.get(STORAGE_KEY).includes(sourceCsv()),false,'Raw CSV must not be saved');
  const after=fixture(storage);
  restore(after);
  assert.deepEqual(clone(after.context.sharedCaseFacts),saved.sharedCaseFacts);
  assert.equal(after.context.importedCsvOriginalSourceId,saved.importedCsvOriginalSourceId);
  assert.equal(after.context.cashActualOriginalSourceId,saved.cashActualOriginalSourceId);
  assert.equal(after.element('priorTaxMethod').value,'simplified');
  assert.equal(after.element('cashflowPriorNationalTax').value,'0');
  assert.equal(after.element('cashflowPriorProxyMethod').value,'special2');
  assert.equal(after.element('cashActualPeriodConfirmed').checked,true);
  assert.equal(after.element('cashActualCoverageConfirmed').checked,false);
  assert.equal(after.element('cashflowSourceConfirmed').checked,false);
  assertNoSpecialConfirmations(after);
});

test('[shared UI06] legacy prior conflicts stay unresolved through resave, then preserve alternatives when chosen',()=>{
  const storage=new Map();
  storage.set(STORAGE_KEY,JSON.stringify({saveEnabled:true,schemaVersion:20,
    periodStart:target.ctx.start,periodEnd:target.ctx.end,priorTaxMethod:'simplified',
    priorPeriodStart:'2024-01-01',priorPeriodEnd:'2024-12-31',
    cashflowAutoBasis:'step3',cashflowPriorStart:sourcePeriod.start,cashflowPriorEnd:sourcePeriod.end,
    cashflowPriorNationalTax:'1,872,000',cashflowPriorChangedNationalTax:'9,999,999',
    cashflowModeStates:{rateImpact:{values:{cashflowAutoBasis:'step3',cashflowPriorProxyMethod:'regular',
      cashflowPriorStart:sourcePeriod.start,cashflowPriorEnd:sourcePeriod.end,cashflowPriorNationalTax:'2,000,000'}},
      methodImpact:{values:{cashflowAutoBasis:'step3',cashflowPriorProxyMethod:'simplified',
        cashflowPriorStart:'2023-01-01',cashflowPriorEnd:'2023-12-31',cashflowPriorNationalTax:'3,000,000'}}}
  }));
  const first=fixture(storage);
  restore(first);
  const unresolved=clone(first.context.sharedCaseFacts.priorActual);
  assert.equal(unresolved.status,'conflict');
  assert.equal(unresolved.candidates.length,4);
  assert.equal(unresolved.value,null);
  assert.equal(first.element('cashflowPriorNationalTax').value,'');
  assert.equal(first.element('priorPeriodStart').value,'');
  assert.ok(!unresolved.candidates.some(candidate=>candidate.nationalTax==='9,999,999'));
  first.context.saveState();
  const second=fixture(storage);
  restore(second);
  assert.deepEqual(clone(second.context.sharedCaseFacts.priorActual),unresolved);
  const chosen=unresolved.candidates.find(candidate=>candidate.origins.includes('topLevel'));
  second.context.chooseSharedPriorActual(chosen.id);
  assert.equal(second.element('priorPeriodStart').value,sourcePeriod.start);
  assert.equal(second.element('cashflowPriorNationalTax').value,'1,872,000');
  assert.equal(second.element('priorTaxMethod').value,'unknown','The elected 2024 method cannot be assigned to chosen 2025 actuals');
  assert.equal(second.context.sharedCaseFacts.priorActual.selectedId,chosen.id);
  assert.deepEqual(clone(second.context.sharedCaseFacts.priorActual.candidates),unresolved.candidates);
  second.context.saveState();
  const third=fixture(storage);
  restore(third);
  assert.equal(third.context.sharedCaseFacts.priorActual.selectedId,chosen.id);
  assert.deepEqual(clone(third.context.sharedCaseFacts.priorActual.candidates),unresolved.candidates);
});

test('[shared UI07] a full CSV import shares source metadata both ways without confirming cash decisions',()=>{
  const h=fixture();
  importCsv(h);
  assert.equal(h.context.sharedCsvSourceLinked(),true);
  assert.equal(h.context.importedCsvOriginalSourceId,h.context.cashflowScopeDigest(sourceCsv()));
  confirmSource(h);
  assert.equal(h.element('cashflowSourceStart').value,sourcePeriod.start);
  assert.equal(h.element('cashflowSourceEnd').value,sourcePeriod.end);
  assert.equal(h.element('cashflowSourceConfirmed').checked,true);
  assertNoSpecialConfirmations(h);
  const incomplete=h.context.cashActualResult(target);
  assert.equal(incomplete.status,'unconfirmed');
  assert.equal(h.context.cashActualSavedSnapshot,null);
  assert.match(incomplete.reasons.join(' '),/資金科目/);
  assert.match(incomplete.reasons.join(' '),/消費税納付・還付/);
  editSource(h,'cashflowSourceConfirmed',false);
  assert.equal(h.element('cashActualPeriodConfirmed').checked,false);
  assert.equal(h.element('cashActualCoverageConfirmed').checked,false);
  editSource(h,'cashflowSourceConfirmed',true);
  assert.equal(h.element('cashActualPeriodConfirmed').checked,true);
  assert.equal(h.element('cashActualCoverageConfirmed').checked,true);
  h.element('cashAccountConfirmed').checked=true;
  h.element('cashTaxCoverageConfirmed').checked=true;
  assert.equal(h.context.cashActualResult(target).status,'complete','Independent cash checks still unlock the real result');
});

test('[shared UI08] editing either shared CSV period invalidates period and coverage checks',()=>{
  const h=fixture();
  importCsv(h);
  confirmSource(h);
  editSource(h,'cashflowSourceStart','2024-01-01');
  assert.equal(h.element('cashActualSourceStart').value,'2024-01-01');
  for(const id of ['cashflowSourceConfirmed','cashActualPeriodConfirmed','cashActualCoverageConfirmed'])
    assert.equal(h.element(id).checked,false,id);
  assert.equal(h.context.cashflowConfirmedScope,'');
  editSource(h,'cashflowSourceConfirmed',true);
  editSource(h,'cashActualSourceEnd','2024-12-31');
  assert.equal(h.element('cashflowSourceEnd').value,'2024-12-31');
  assert.equal(h.element('cashflowSourceConfirmed').checked,false);
  assert.equal(h.element('cashActualPeriodConfirmed').checked,false);
  assert.equal(h.element('cashActualCoverageConfirmed').checked,false);
});

test('[shared UI09] a different original CSV invalidates source and all cash-specific decisions',()=>{
  const h=fixture();
  importCsv(h);
  confirmSource(h);
  const firstId=h.context.importedCsvOriginalSourceId;
  for(const id of ['cashAccountConfirmed','cashTaxCoverageConfirmed','cashActualFoodEightConfirmed']) h.element(id).checked=true;
  h.context.cashActualOpeningDecisions={old:'exclude'};
  h.context.cashActualTaxDecisions={old:'keep'};
  h.context.cashActualSavedSnapshot={fileKey:h.context.cashActualAnalysis.fileKey,months:[]};
  importCsv(h,sourceCsv({amount:216000}));
  assert.notEqual(h.context.importedCsvOriginalSourceId,firstId);
  for(const id of ['cashflowSourceStart','cashflowSourceEnd','cashActualSourceStart','cashActualSourceEnd'])
    assert.equal(h.element(id).value,'',id);
  for(const id of ['cashflowSourceConfirmed','cashActualPeriodConfirmed','cashActualCoverageConfirmed'])
    assert.equal(h.element(id).checked,false,id);
  assertNoSpecialConfirmations(h);
  assert.equal(h.context.cashActualSavedSnapshot,null);
  assert.equal(h.context.cashflowConfirmedScope,'');
});

test('[shared UI10] correcting tax aggregation for the same original preserves only shared source evidence',()=>{
  const h=fixture(),text=sourceCsv({rate:'?'});
  importCsv(h,text);
  confirmSource(h);
  const firstId=h.context.importedCsvOriginalSourceId;
  const firstAggregate=h.context.importedCsvCashflowScopeKey;
  const firstCashKey=h.context.cashActualAnalysis.fileKey;
  const beforeGroups=clone(h.context.importedCsvMonthlyGroups);
  const problem=journal.analyzeTkcJournalText(text).problemEntries[0];
  assert.ok(problem,'The fixture must contain an actual tax-code recovery choice');
  importCsv(h,text,{[problem.id]:{action:'correct',overrides:{rate:'8'}}});
  assert.equal(h.context.importedCsvOriginalSourceId,firstId);
  assert.equal(h.context.cashActualOriginalSourceId,firstId);
  assert.equal(h.context.cashActualAnalysis.fileKey,firstCashKey);
  assert.notEqual(h.context.importedCsvCashflowScopeKey,firstAggregate);
  assert.notDeepEqual(clone(h.context.importedCsvMonthlyGroups),beforeGroups);
  assert.equal(h.element('cashflowSourceStart').value,sourcePeriod.start);
  assert.equal(h.element('cashflowSourceEnd').value,sourcePeriod.end);
  assert.equal(h.element('cashflowSourceConfirmed').checked,true);
  assert.equal(h.element('cashActualPeriodConfirmed').checked,true);
  assert.equal(h.element('cashActualCoverageConfirmed').checked,true);
  assertNoSpecialConfirmations(h);
});

test('[shared UI11] partial true/false source checks survive fresh-VM restore and same-file reimport without a snapshot',()=>{
  for(const [periodConfirmed,coverageConfirmed] of [[true,false],[false,true],[false,false]]){
    const storage=new Map(),first=fixture(storage);
    importCsv(first);
    confirmSource(first,periodConfirmed,coverageConfirmed);
    // The user may have finished the cash account review while source coverage
    // is incomplete. Losing the absent snapshot must not erase that decision.
    first.element('cashAccountConfirmed').checked=true;
    assert.equal(first.context.cashActualResult(target).status,'unconfirmed');
    assert.equal(first.context.cashActualSavedSnapshot,null);
    first.context.saveState();
    const second=fixture(storage);
    restore(second);
    assert.equal(second.context.cashActualAnalysis,null);
    assert.equal(second.context.cashActualSavedSnapshot,null);
    importCsv(second);
    assert.equal(second.element('cashActualSourceStart').value,sourcePeriod.start);
    assert.equal(second.element('cashActualSourceEnd').value,sourcePeriod.end);
    assert.equal(second.element('cashActualPeriodConfirmed').checked,periodConfirmed);
    assert.equal(second.element('cashActualCoverageConfirmed').checked,coverageConfirmed);
    assert.equal(second.element('cashflowSourceConfirmed').checked,false);
    assert.equal(second.element('cashAccountConfirmed').checked,true);
    assert.equal(second.element('cashTaxCoverageConfirmed').checked,false);
    assert.equal(second.element('cashActualFoodEightConfirmed').checked,false);
  }
});

test('[shared UI12] unlinked legacy cash data remains independent and conflicting source periods await a choice',()=>{
  const storage=new Map(),seed=fixture();
  const aggregate=seed.context.cashflowImportScopeKey(sourceCsv(),journal.analyzeTkcJournalText(sourceCsv()));
  storage.set(STORAGE_KEY,JSON.stringify({saveEnabled:true,schemaVersion:20,
    periodStart:target.ctx.start,periodEnd:target.ctx.end,importedCsvCashflowScopeKey:aggregate,
    cashflowSourceStart:sourcePeriod.start,cashflowSourceEnd:sourcePeriod.end,cashflowSourceConfirmed:true,
    cashflowConfirmedScope:JSON.stringify([aggregate,sourcePeriod.start,sourcePeriod.end]),
    cashActualSourceStart:sourcePeriod.start,cashActualSourceEnd:sourcePeriod.end,
    cashActualPeriodConfirmed:true,cashActualCoverageConfirmed:false,
    cashflowModeStates:{methodImpact:{values:{cashflowSourceStart:'2024-01-01',cashflowSourceEnd:'2024-12-31',cashflowSourceConfirmed:true},
      confirmedScope:JSON.stringify([aggregate,'2024-01-01','2024-12-31'])}}
  }));
  const h=fixture(storage);
  restore(h);
  assert.equal(h.context.sharedCsvSourceLinked(),false,'Matching legacy dates cannot prove the same original CSV');
  assert.equal(h.context.sharedCaseFacts.csvSource.status,'conflict');
  assert.equal(h.element('cashflowSourceStart').value,'');
  assert.equal(h.element('cashflowSourceConfirmed').checked,false);
  assert.equal(h.element('cashActualSourceStart').value,sourcePeriod.start);
  assert.equal(h.element('cashActualPeriodConfirmed').checked,true);
  const candidates=clone(h.context.sharedCaseFacts.csvSource.candidates);
  h.context.saveState();
  const after=fixture(storage);
  restore(after);
  assert.equal(after.context.sharedCaseFacts.csvSource.status,'conflict');
  assert.deepEqual(clone(after.context.sharedCaseFacts.csvSource.candidates),candidates);
  const choice=candidates.find(candidate=>candidate.period.start==='2024-01-01');
  after.context.chooseSharedCsvSource(choice.id);
  assert.equal(after.element('cashflowSourceStart').value,'2024-01-01');
  assert.equal(after.element('cashflowSourceConfirmed').checked,true);
  assert.equal(after.element('cashActualSourceStart').value,sourcePeriod.start);
  assert.equal(after.element('cashActualCoverageConfirmed').checked,false);
  assert.deepEqual(clone(after.context.sharedCaseFacts.csvSource.candidates),candidates);
});

test('[shared UI13] selecting another actual amount for the same prior period preserves its explicit method',()=>{
  const storage=new Map();
  storage.set(STORAGE_KEY,JSON.stringify({saveEnabled:true,schemaVersion:20,
    periodStart:target.ctx.start,periodEnd:target.ctx.end,priorTaxMethod:'special2',
    priorPeriodStart:sourcePeriod.start,priorPeriodEnd:sourcePeriod.end,
    cashflowPriorStart:sourcePeriod.start,cashflowPriorEnd:sourcePeriod.end,cashflowPriorNationalTax:'1,872,000',
    cashflowModeStates:{methodImpact:{values:{cashflowPriorStart:sourcePeriod.start,
      cashflowPriorEnd:sourcePeriod.end,cashflowPriorNationalTax:'2,000,000'}}}
  }));
  const h=fixture(storage);
  restore(h);
  assert.equal(h.context.sharedCaseFacts.priorActual.status,'conflict');
  const choice=h.context.sharedCaseFacts.priorActual.candidates.find(candidate=>candidate.origins.includes('methodImpact'));
  h.context.chooseSharedPriorActual(choice.id);
  assert.equal(h.element('cashflowPriorNationalTax').value,'2,000,000');
  assert.equal(h.element('priorTaxMethod').value,'special2');
  assert.deepEqual(clone(h.context.sharedCaseFacts.priorMethodPeriod),sourcePeriod);
});

test('[shared UI14] prior method scope survives A to blank to saved/restored B; an explicit method choice renews it',()=>{
  const storage=new Map(),first=fixture(storage);
  actual(first);
  first.element('priorTaxMethod').value='simplified';
  first.context.editSharedPriorMethod();
  editPrior(first,'priorPeriodStart','');
  editPrior(first,'priorPeriodEnd','');
  assert.deepEqual(clone(first.context.sharedCaseFacts.priorMethodPeriod),sourcePeriod);
  assert.equal(first.element('priorTaxMethod').value,'simplified');
  first.context.saveState();
  const second=fixture(storage);
  restore(second);
  assert.deepEqual(clone(second.context.sharedCaseFacts.priorMethodPeriod),sourcePeriod);
  assert.equal(second.element('priorTaxMethod').value,'simplified');
  editPrior(second,'cashflowPriorStart','2026-01-01');
  assert.equal(second.element('priorTaxMethod').value,'simplified','A partial date must not discard the old method scope');
  editPrior(second,'cashflowPriorEnd','2026-12-31');
  assert.equal(second.element('priorTaxMethod').value,'unknown');
  assert.equal(second.element('cashflowPriorNationalTax').value,'');
  second.element('priorTaxMethod').value='special2';
  second.context.editSharedPriorMethod();
  editPrior(second,'cashflowPriorNationalTax','1872000');
  assert.equal(second.element('priorTaxMethod').value,'special2');
  assert.deepEqual(clone(second.context.sharedCaseFacts.priorMethodPeriod),{start:'2026-01-01',end:'2026-12-31'});
});
