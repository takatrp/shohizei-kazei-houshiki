'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../tax-engine.js');
const switchDecision = require('../switch-decision.js');
const taxRows = require('../tax-entry-rows.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function functionSource(name){
  const functionStart = html.indexOf(`function ${name}(`);
  const start = html.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6 : functionStart;
  assert.notEqual(start, -1, `${name} must exist`);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

function deferred(){
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function flowHarness(names){
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)) elements.set(id, {
      value:'', files:[], checked:false, open:false, disabled:false,
      className:'', textContent:'', innerHTML:'', focusCount:0,
      classList:{ add(){}, remove(){}, toggle(){} },
      focus(){ this.focusCount += 1; }, setAttribute(){}
    });
    return elements.get(id);
  };
  let updates = 0;
  const context = vm.createContext({
    $:element,
    document:{ querySelector(selector){
      if(selector === 'input[name="amountMode"]:checked') return { value:'included' };
      return null;
    } },
    parseAmountInput:engine.parseAmountInput,
    normalizeExemptPurchaseRatio:engine.normalizeExemptPurchaseRatio,
    summarizeActualOnePercentEntries:taxRows.summarizeActualOnePercentEntries,
    engineTaxFromAmount:engine.taxFromAmount,
    engineTaxableBaseFromAmount:engine.taxableBaseFromAmount,
    calculateSimplifiedTax:engine.calculateSimplifiedTax,
    FOOD_PROPOSAL:engine.FOOD_PROPOSAL,
    BUSINESS_TYPES:[{ key:'type2', name:'第２種', deemed:0.8 }],
    CSV_EXEMPT_RATIOS:['80'],
    visibleBusinessTypes:new Set(),
    pendingJournalImport:null,
    journalImportMappings:{},
    journalImportRequestId:0,
    workflowStep:1,
    importedActualOnePercent:null,
    importedUnsupportedEntries:[],
    importedCsvRecovery:null,
    importedCsvOrigin:null,
    appliedJournalImport:null,
    importedExemptTransactionCount:0,
    window:{confirm:() => true},
    getExemptPurchaseInputIds:() => [],
    currentJournalImportTotals:() => ({totals:{sales:0,nonTaxableSales:0,invoicePurchases:0,exemptPurchases:0},invalid:false}),
    update(){ updates += 1; },
    renderJournalImport(){},
    decodeCsvBytes(){ return { text:'fixture', encoding:'UTF-8' }; },
    analyzeTkcJournalText(){ return { errors:[], actualOnePercentEntries:[] }; }
  });
  vm.runInContext([...new Set(['normalizeCsvRecovery', 'csvRecoverySummaryText', ...names])].map(functionSource).join('\n'), context);
  return { context, element, updates:() => updates };
}

const salesFunctions = [
  'formatInput', 'amountState', 'taxFromAmount', 'taxableBaseFromAmount',
  'actualOneAmount', 'actualOneTax', 'actualOneBase', 'inclusiveDayCount',
  'proposalOverlapFraction', 'proposalFoodOriginalAmount', 'repriceFoodAmount',
  'collectSales'
];

function salesContext(){
  return {
    start:'2027-01-01', end:'2027-12-31', amountMode:'included',
    taxScenario:'current', foodForecastMethod:'manual', foodSalesPriceBasis:'netFixed'
  };
}

test('[M01][M13][U01-U03] 手入力とCSVは対等な入口で、旧冒頭案内を置かない', () => {
  assert.doesNotMatch(html, /CSVがなくても使えます|manual-entry-intro/);
  assert.match(html, /class="btn" id="workflowNext"/);
  assert.match(html, /class="btn" id="openJournalImportBtn"/);
  assert.match(html, /<details[^>]*id="journalImportDisclosure"/);
  assert.match(html, />CSVから金額を取り込む<\/button>/);
  assert.doesNotMatch(html, /<details[^>]*id="journalImportDisclosure"[^>]*\sopen(?:\s|=|>)/);
  assert.match(functionSource('renderWorkflow'), /金額を手入力して進む/);
});

test('[M02][M03][M10][M14] CSV未選択の手入力は直接2画面目へ進み既存値を保持して見出しにフォーカスする', () => {
  const h = flowHarness(['clearJournalImport', 'enterManualAmountInput']);
  h.element('periodStart').value = '2027-01-01';
  h.element('periodEnd').value = '2027-12-31';
  h.element('type2Sale8').value = '2,500,000';
  h.element('modeTaxExcluded').checked = true;
  h.element('switchFoodSalesState').value = 'yes';
  h.context.enterManualAmountInput();
  assert.equal(h.context.workflowStep, 2);
  assert.equal(h.element('salesInputHeading').focusCount, 1);
  assert.equal(h.element('periodStart').value, '2027-01-01');
  assert.equal(h.element('periodEnd').value, '2027-12-31');
  assert.equal(h.element('type2Sale8').value, '2,500,000');
  assert.equal(h.element('modeTaxExcluded').checked, true);
  assert.equal(h.element('switchFoodSalesState').value, 'yes');
  assert.equal(h.updates(), 1);
  assert.match(functionSource('bindEvents'), /workflowNext[\s\S]*enterManualAmountInput/);
});

test('比較方式は初期状態で全て未選択、選択するまで手入力へ進めない', () => {
  for(const id of ['compareRegular','compareSimplified','compareSpecial2','compareSpecial3']){
    assert.match(html, new RegExp(`id="${id}"[^>]*value="[^"]+">`));
  }
  assert.match(html, /比較対象課税期間 開始日/);
  assert.match(html, /比較対象課税期間 終了日/);
  const h = flowHarness(['clearJournalImport','enterManualAmountInput']);
  h.context.selectedComparisonMethods = () => [];
  h.context.enterManualAmountInput();
  assert.equal(h.context.workflowStep,1);
  h.context.selectedComparisonMethods = () => ['regular'];
  h.context.enterManualAmountInput();
  assert.equal(h.context.workflowStep,2);
});

test('[M05][M07] ファイル取消し・未反映プレビューから手入力へ戻っても既存金額は上書きしない', async () => {
  const h = flowHarness(['clearJournalImport', 'handleJournalCsvFile', 'enterManualAmountInput']);
  h.element('type2Sale8').value = '1,080,000';
  h.element('journalCsvFile').files = [];
  await h.context.handleJournalCsvFile();
  assert.equal(h.context.pendingJournalImport, null);
  assert.equal(h.element('type2Sale8').value, '1,080,000');

  h.element('journalImportDisclosure').open = true;
  h.element('journalCsvFile').files = [{ name:'sample.csv', arrayBuffer:async () => new ArrayBuffer(1) }];
  await h.context.handleJournalCsvFile();
  assert.equal(h.context.pendingJournalImport.applied, false);
  assert.equal(h.element('type2Sale8').value, '1,080,000');
  h.context.enterManualAmountInput();
  assert.equal(h.context.pendingJournalImport, null);
  assert.equal(h.element('type2Sale8').value, '1,080,000');
  assert.equal(h.context.workflowStep, 2);
});

test('[M06] 解析中に手入力へ進んだ後の非同期完了はプレビュー・金額・画面を戻さない', async () => {
  const h = flowHarness(['clearJournalImport', 'handleJournalCsvFile', 'enterManualAmountInput']);
  const reading = deferred();
  h.element('type2Sale8').value = '900,000';
  h.element('journalImportDisclosure').open = true;
  h.element('journalCsvFile').files = [{ name:'slow.csv', arrayBuffer:() => reading.promise }];
  const importTask = h.context.handleJournalCsvFile();
  h.context.enterManualAmountInput();
  reading.resolve(new ArrayBuffer(1));
  await importTask;
  assert.equal(h.context.workflowStep, 2);
  assert.equal(h.context.pendingJournalImport, null);
  assert.equal(h.element('type2Sale8').value, '900,000');
});

test('[M06] CSV読込み失敗後も手入力へ進める', async () => {
  const h = flowHarness(['clearJournalImport', 'handleJournalCsvFile', 'enterManualAmountInput']);
  h.element('journalCsvFile').files = [{ name:'broken.csv', arrayBuffer:async () => { throw new Error('read failed'); } }];
  await h.context.handleJournalCsvFile();
  assert.match(h.element('journalImportStatus').textContent, /手入力で続けられます/);
  h.context.enterManualAmountInput();
  assert.equal(h.context.workflowStep, 2);
});

test('[M11] 反映済み1％元行と金額は手入力画面への移動で破棄しない', () => {
  const h = flowHarness(['clearJournalImport', 'enterManualAmountInput']);
  const actual = { entries:[{ row:17, transactionKind:'adjustment', rate:1, grossAmount:1010 }] };
  h.context.importedActualOnePercent = actual;
  h.context.importedExemptTransactionCount = 1;
  h.context.pendingJournalImport = { applied:true, analysis:{ actualOnePercentEntries:actual.entries } };
  h.element('type2Sale8').value = '1,080,000';
  h.context.enterManualAmountInput();
  assert.equal(h.context.workflowStep, 2);
  assert.equal(h.context.importedActualOnePercent, actual);
  assert.equal(h.context.importedExemptTransactionCount, 1);
  assert.equal(h.element('type2Sale8').value, '1,080,000');
});

test('[M11] 反映済み返品の要確認と期間外通常取引のエラーは手入力移動で解除されない', () => {
  const h = flowHarness(['clearJournalImport', 'enterManualAmountInput', 'validateImportedOnePercentEntries']);
  h.context.assessCsvOnePercentEntry = engine.assessCsvOnePercentEntry;
  h.context.importedActualOnePercent = { source:'csvActual', entries:[
    { row:7, side:'貸方', taxCode:'1', date:'2028-01-15', amount:1010, ratePercent:1, transactionKind:'adjustment' },
    { row:8, side:'貸方', taxCode:'1', date:'2027-03-31', amount:1010, ratePercent:1, transactionKind:'ordinary' }
  ] };
  h.context.pendingJournalImport = { applied:true, analysis:{} };
  const period = { taxScenario:'foodProposal', start:'2027-01-01', end:'2028-12-31' };
  const before = h.context.validateImportedOnePercentEntries(period);
  assert.equal(before.reviewItems.length, 1);
  assert.equal(before.adjustmentCount, 1);
  assert.equal(before.errors.length, 1);
  h.context.enterManualAmountInput();
  const after = h.context.validateImportedOnePercentEntries(period);
  assert.equal(after.reviewItems.length, 1);
  assert.equal(after.errors.length, 1);
  assert.match(after.reviewItems[0].source, /CSV 7行目/);
  assert.match(after.errors[0], /CSV 8行目/);
});

test('[M04][M08][M09] 手入力とCSV反映は同じ入力欄・計算関数で同額になり、CSV後も修正できる', () => {
  const manual = flowHarness(salesFunctions);
  manual.element('type2Sale8').value = '1,080,000';
  const manualSales = manual.context.collectSales(salesContext());
  assert.equal(manualSales.errors.length, 0);
  assert.equal(manualSales.totalTax, 80000);

  const imported = flowHarness([...salesFunctions, 'journalRowHasInput', 'journalManualRows',
    'journalImportHasExistingInput', 'journalImportTotals', 'journalImportTotalsText', 'setImportedAmount', 'applyJournalImport']);
  imported.context.pendingJournalImport = {
    applied:false, analysis:{ actualOnePercentEntries:[], unsupportedEntries:[], exemptTransactionCount:0 }
  };
  imported.context.resolveImportValues = () => ({ ready:true, values:{
    salesByType:{ type2:{ '10':0, '8':1080000, '1':0 } },
    invoicePurchases:{ '10':0, '8':0, '1':0 },
    exemptPurchases:{ '80':{ '10':0, '8':0, '1':0 } },
    nonTaxableSales:0, taxableOnlyPurchaseTax:0, commonPurchaseTax:0,
    dateRange:{ start:'2027-02-01', end:'2027-11-30' }
  } });
  imported.element('periodStart').value = '2027-01-01';
  imported.element('periodEnd').value = '2027-12-31';
  imported.context.applyJournalImport();
  assert.equal(imported.context.workflowStep, 2);
  assert.equal(imported.element('salesInputHeading').focusCount, 1);
  assert.equal(imported.element('type2Sale8').value, '1,080,000');
  assert.equal(imported.element('periodStart').value, '2027-01-01');
  assert.equal(imported.element('periodEnd').value, '2027-12-31');
  const csvSales = imported.context.collectSales(salesContext());
  assert.equal(csvSales.totalTax, manualSales.totalTax);
  assert.equal(csvSales.simplified.amount, manualSales.simplified.amount);
  imported.element('type2Sale8').value = '1,188,000';
  assert.equal(imported.context.collectSales(salesContext()).totalTax, 88000);
  assert.match(html, /売上の事業区分を選ぶと入力欄が表示されます/);
});

test('[M12] 空欄・明示0円・不正文字列を別状態として扱い、CSV不足に読み替えない', () => {
  const h = flowHarness(['amountState']);
  const input = h.element('type2Sale8');
  const empty = h.context.amountState('type2Sale8');
  assert.equal(empty.entered, false);
  assert.equal(empty.valid, true);
  input.value = '0';
  const zero = h.context.amountState('type2Sale8');
  assert.equal(zero.entered, true);
  assert.equal(zero.value, 0);
  input.value = '不明';
  const invalid = h.context.amountState('type2Sale8');
  assert.equal(invalid.entered, true);
  assert.equal(invalid.valid, false);
  assert.equal(input.value, '不明');
});

test('[M10][M14] 保存復元後も手入力額・課税期間・税率前提・確認状態・CSV元行を保持する', () => {
  const storage = new Map();
  const selected = { amountMode:'excluded', taxScenario:'foodProposal', workflowPurpose:'regular' };
  const make = () => {
    const h = flowHarness(['saveState', 'restoreState']);
    Object.assign(h.context, {
      STORAGE_KEY:'manual-flow-test',
      serializeStateIfEnabled:engine.serializeStateIfEnabled,
      migrateSavedState:switchDecision.migrateSavedState,
      storageGet:key => storage.get(key) || null,
      storageSet(key, value){ storage.set(key, value); return true; },
      storageRemove:key => storage.delete(key),
      getExemptPurchaseInputIds:() => [],
      selectedValue:name => selected[name] || '',
      costWorkflowActive:() => false,
      taxScenarioKey:() => selected.taxScenario,
      foodConfirmationSignatures:{},
      switchDecisionOpen:false
    });
    h.context.document.querySelector = selector => selector.startsWith('input[name=')
      ? h.element(selector) : null;
    return h;
  };
  const before = make();
  before.element('saveToDevice').checked = true;
  before.element('periodStart').value = '2027-01-01';
  before.element('periodEnd').value = '2027-12-31';
  before.element('type2Sale8').value = '2,500,000';
  before.element('switchFoodSalesState').value = 'yes';
  before.context.workflowStep = 2;
  before.context.importedActualOnePercent = {
    source:'csvActual', entries:[{ row:23, transactionKind:'adjustment', amount:1010 }]
  };
  before.context.importedCsvOrigin = {
    dateRange:{start:'2025-01-15',end:'2025-02-15'},
    effectiveDateRange:{start:'2025-01-15',end:'2025-02-15'},
    rowCount:2,mappedEntries:2,manualChanged:true
  };
  before.context.selectedComparisonMethods = () => ['regular'];
  before.context.saveState();
  assert.equal(before.element('saveStatus').textContent, 'この端末に保存中');
  assert.equal(JSON.parse(storage.get('manual-flow-test')).amountMode, 'excluded');
  assert.deepEqual(JSON.parse(storage.get('manual-flow-test')).comparisonMethods, ['regular']);

  const after = make();
  after.context.restoreState();
  assert.equal(after.context.workflowStep, 2);
  assert.equal(after.element('periodStart').value, '2027-01-01');
  assert.equal(after.element('periodEnd').value, '2027-12-31');
  assert.equal(after.element('type2Sale8').value, '2,500,000');
  assert.equal(after.element('switchFoodSalesState').value, 'yes');
  assert.equal(after.element('input[name="amountMode"][value="excluded"]').checked, true);
  assert.equal(after.element('input[name="taxScenario"][value="foodProposal"]').checked, true);
  assert.equal(after.element('compareRegular').checked, true);
  assert.equal(after.element('compareSimplified').checked, false);
  assert.equal(after.context.importedActualOnePercent.entries[0].row, 23);
  assert.equal(after.context.importedActualOnePercent.entries[0].transactionKind, 'adjustment');
  assert.equal(after.context.importedCsvOrigin.dateRange.start, '2025-01-15');
  assert.equal(after.context.importedCsvOrigin.effectiveDateRange.end, '2025-02-15');
  assert.equal(after.context.importedCsvOrigin.manualChanged, true);
});

test('[TKC行保存] 行の順序・出所・0円と空欄・控除割合を保存復元し旧集計値を二重編集しない', () => {
  const storage = new Map();
  const make = () => {
    const h = flowHarness(['saveState','restoreState']);
    Object.assign(h.context, {
      STORAGE_KEY:'tkc-row-save-test', serializeStateIfEnabled:engine.serializeStateIfEnabled,
      migrateSavedState:switchDecision.migrateSavedState,
      storageGet:key => storage.get(key), storageSet(key,value){storage.set(key,value);return true;},
      storageRemove:key => storage.delete(key), getExemptPurchaseInputIds:() => [],
      selectedValue:() => 'included', taxScenarioKey:() => 'current',
      foodConfirmationSignatures:{}, switchDecisionOpen:false,
      entryMode:'rows', rowCsvKnownZeros:{nonTaxableSales:true,purchase10:false,purchase8:false},
      taxEntryRows:{sales:[],purchases:[]}, nextTaxEntryId:1,
      createTaxEntryRow:taxRows.createTaxEntryRow,
      newTaxEntry:side => taxRows.createTaxEntryRow(side,{id:`new-${side}`}),
      renderTaxEntryRows(){},
      document:{...h.context.document,body:{dataset:{}},querySelector:selector => selector.startsWith('input[name=') ? h.element(selector) : null}
    });
    return h;
  };
  const before = make();
  before.element('saveToDevice').checked = true;
  before.context.taxEntryRows = {
    sales:[
      {id:'1',code:'1',businessType:'type2',rate:'8',amount:'1,080,000',foodAmount:'',source:'manual'},
      {id:'2',code:'3',rate:'',amount:'0',foodAmount:'',source:'csv'},
      {id:'blank',code:'',rate:'',amount:'',foodAmount:'',source:'manual'}
    ],
    purchases:[{id:'3',code:'52',rate:'8',amount:'100,000',foodAmount:'0',creditRatio:'80',creditRatioSource:'manual',source:'csv-edited',
      sourceDateStart:'2026-09-30',sourceDateEnd:'2026-09-30',sourceAdjustmentCount:1,sourceDateUnknownCount:0}]
  };
  before.context.saveState();
  const saved = JSON.parse(storage.get('tkc-row-save-test'));
  assert.equal(saved.taxEntryRows.sales.length, 2);
  assert.equal(saved.taxEntryRows.sales[1].amount, '0');
  assert.equal(saved.taxEntryRows.sales[0].foodAmount, '');
  const after = make();
  after.context.restoreState();
  assert.equal(after.context.entryMode, 'rows');
  assert.deepEqual(Array.from(after.context.taxEntryRows.sales, row => row.code), ['1','3']);
  assert.equal(after.context.taxEntryRows.sales[1].source, 'csv');
  assert.equal(after.context.taxEntryRows.purchases[0].source, 'csv-edited');
  assert.equal(after.context.taxEntryRows.purchases[0].creditRatio, '80');
  assert.equal(after.context.taxEntryRows.purchases[0].sourceDateStart, '2026-09-30');
  assert.equal(after.context.taxEntryRows.purchases[0].sourceDateEnd, '2026-09-30');
  assert.equal(after.context.taxEntryRows.purchases[0].sourceAdjustmentCount, 1);
  assert.equal(after.context.taxEntryRows.purchases[0].foodAmount, '0');
  assert.equal(after.context.rowCsvKnownZeros.nonTaxableSales, true);
  assert.equal(after.element('modeTaxExcluded').disabled, true);
  const aggregate = taxRows.aggregateTaxRows(after.context.taxEntryRows);
  assert.equal(aggregate.fields.nonTaxableSales.entered, true);
  assert.equal(aggregate.fields.nonTaxableSales.value, 0);
  assert.equal(aggregate.fields.type2SaleFood1.entered, false);
  storage.set('tkc-row-save-test',JSON.stringify({...saved,taxEntryRows:undefined,rowCsvKnownZeros:undefined,type2Sale10:'1,100,000'}));
  const old = make();
  old.element('storageNotice').style = {};
  old.context.restoreState();
  assert.equal(old.context.entryMode,'legacy');
  assert.equal(old.context.document.body.dataset.entryMode,'legacy');
  assert.equal(old.element('type2Sale10').value,'1,100,000');
  assert.match(old.element('storageNotice').textContent,/旧形式の集計データ/);
});

test('[TKC行キーボード] 10行連続でもEnterの列順と条件付き列を維持する', () => {
  const h = flowHarness(['nextTaxRowField','focusNextTaxRow']);
  for(let i=0;i<10;i++){
    const sales = {code:'1',rate:i % 2 ? '10' : '8'};
    const saleOrder = ['code','businessType','rate','amount',...(sales.rate === '8' ? ['foodAmount'] : [])];
    for(let n=0;n<saleOrder.length;n++) assert.equal(h.context.nextTaxRowField(sales,'sales',saleOrder[n]),saleOrder[n+1] || '');
    const purchase = {code:i % 2 ? '5' : '52',rate:'8',creditRatio:i % 2 ? '' : '80'};
    const purchaseOrder = ['code','rate','amount','foodAmount'];
    for(let n=0;n<purchaseOrder.length;n++) assert.equal(h.context.nextTaxRowField(purchase,'purchases',purchaseOrder[n]),purchaseOrder[n+1] || '');
  }
  assert.equal(h.context.nextTaxRowField({code:'3'},'sales','code'),'amount');
  assert.equal(h.context.nextTaxRowField({code:'52',rate:'10',creditRatio:''},'purchases','amount'),'creditRatio');
  assert.equal(h.context.nextTaxRowField({code:'52',rate:'10',creditRatio:'70'},'purchases','amount'),'');
  const focuses = [];
  h.context.TAX_ROW_CODES = taxRows.CODE_DETAILS;
  h.context.taxEntryRows = {sales:Array.from({length:10},(_,index) => ({id:`row-${index}`,code:'1',rate:'10'})),purchases:[]};
  h.context.newTaxEntry = () => ({id:'row-10',code:'',rate:''});
  h.context.renderTaxEntryRows = () => {};
  h.element('taxSalesRowBody').querySelector = selector => ({focus(){focuses.push(selector);}});
  const input = {dataset:{rowSide:'sales',rowKey:'row-9',rowField:'amount'},closest:() => null};
  h.context.focusNextTaxRow(input);
  assert.equal(h.context.taxEntryRows.sales.length,11);
  assert.match(focuses[0],/row-10.*code/);
});

test('[TKC行表示] 金額の入力中に桁区切りし、選択肢は番号へ正規化する', () => {
  const h = flowHarness(['formatInput','formatAmountLive','taxRowChoiceNumber']);
  const input = {id:'',value:'2500000',selectionStart:7,cursor:-1,
    classList:{contains:name => name === 'row-amount'},
    setSelectionRange(start){this.cursor = start;}
  };
  h.context.formatAmountLive(input);
  assert.equal(input.value,'2,500,000');
  assert.equal(input.cursor,input.value.length);
  input.value = '-1234567';
  input.selectionStart = input.value.length;
  h.context.formatAmountLive(input);
  assert.equal(input.value,'-1,234,567');
  assert.equal(h.context.taxRowChoiceNumber('1　第1種 卸売業'),'1');
  assert.equal(h.context.taxRowChoiceNumber('52　免税事業者等（課税売上対応）'),'52');
  assert.equal(h.context.taxRowChoiceNumber('6'),'6');
  assert.match(functionSource('bindTaxEntryRows'),/formatAmountLive\(event\.target\)/);
});

test('[TKC行表示] 不要セルは入力不能かつ通常欄と別表示、売上追加は表の直下に置く', () => {
  assert.match(html,/\.tkc-row-table input:disabled,\.tkc-row-table select:disabled\{[^}]*border-color:transparent/);
  assert.match(html,/\.tkc-row-table input:disabled::placeholder\{[^}]*opacity:1/);
  assert.match(functionSource('refreshTaxRowControls'),/business\.disabled = row\.code !== '1'/);
  assert.match(functionSource('refreshTaxRowControls'),/rate\.disabled = row\.code === '3'/);
  assert.match(functionSource('refreshTaxRowControls'),/food\.disabled = row\.code === '3' \|\| row\.rate !== '8'/);
  assert.match(functionSource('initWorkflow'),/\$\('addTaxSalesRow'\)\.closest\('\.tkc-row-actions'\)\.after\(foodSaleConfirmation\)/);
  for(const text of ['1　第1種 卸売業','2　第2種 小売業','3　第3種 建設業','4　第4種 飲食店業','5　第5種 サービス業','6　第6種 不動産業']) assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/<datalist id="tax(?:SalesCode|PurchaseCode|BusinessType)List">[^<]*<option[^>]*label=/);
  assert.match(functionSource('renderTaxEntryRows'),/bucket\.key\}%｜\$\{escapeHtml\(bucket\.range\)\}/);
});

test('[TKC行表示] CSV由来の初期値を描画時から桁区切りし、税率候補を内部の8・10へ戻す', () => {
  const h = flowHarness(['escapeHtml','formatInput','rowCellInput','taxRowRateValue']);
  const row = {id:'csv-5-10',amount:'2500000',foodAmount:'-1200000'};
  assert.match(h.context.rowCellInput(row,'purchases','amount','税込金額'),/value="2,500,000"/);
  assert.match(h.context.rowCellInput(row,'purchases','foodAmount','食品対象'),/value="-1,200,000"/);
  assert.equal(row.amount,'2500000','CSV由来の行データは表示整形で変更しない');
  assert.equal(h.context.taxRowRateValue('10％'),'10');
  assert.equal(h.context.taxRowRateValue('軽減8％'),'8');
  assert.equal(h.context.taxRowRateValue('8'),'8');
  assert.match(html,/<datalist id="taxRowRateList"><option value="10％"><\/option><option value="軽減8％"><\/option><\/datalist>/);
});

test('[TKC行期間] 対象期と重ならない控除割合だけを無効化し既入力値は消さず警告する', () => {
  const h = flowHarness(['taxRowRatioOverlapsPeriod','taxRowRatioPeriod','purchaseRatioContext','taxRowCodeName','refreshTaxRowControls']);
  const buckets = [
    {key:'80',start:'2023-10-01',end:'2026-09-30',range:'令和5年10月1日から令和8年9月30日まで'},
    {key:'70',start:'2026-10-01',end:'2028-09-30',range:'令和8年10月1日から令和10年9月30日まで'},
    {key:'50',start:'2028-10-01',end:'2030-09-30',range:'令和10年10月1日から令和12年9月30日まで'},
    {key:'30',start:'2030-10-01',end:'2031-09-30',range:'令和12年10月1日から令和13年9月30日まで'},
    {key:'0',start:'2031-10-01',end:'',range:'令和13年10月1日以後'}
  ];
  h.context.EXEMPT_PURCHASE_BUCKETS = buckets;
  h.context.TAX_ROW_CODES = taxRows.CODE_DETAILS;
  h.context.taxEntryRows = {sales:[],purchases:[{id:'p1',code:'52',rate:'10',amount:'80000',creditRatio:'80',creditRatioSource:'manual'}]};
  h.element('periodStart').value = '2027-01-01';
  h.element('periodEnd').value = '2027-12-31';
  const control = () => ({disabled:false,placeholder:''});
  const ratio = {disabled:false,value:'80',options:[{value:'',textContent:'未確認'},...buckets.map(bucket => ({value:bucket.key,disabled:false}))],
    classList:{toggle(){}},setAttribute(name,value){this[name]=value;}};
  const period = {textContent:'',classList:{toggle(){}}};
  const controls = {'[data-row-field="businessType"]':null,'[data-row-field="rate"]':control(),
    '[data-row-field="foodAmount"]':control(),'[data-row-field="creditRatio"]':ratio,
    '.row-ratio-period':period,'.row-code-name':{textContent:''}};
  const tr = {dataset:{rowSide:'purchases',taxRowKey:'p1'},querySelector:selector => controls[selector]};
  h.context.refreshTaxRowControls(tr);
  assert.equal(ratio.options.find(option => option.value === '80').disabled,true);
  assert.equal(ratio.options.find(option => option.value === '70').disabled,false);
  assert.equal(ratio.options.find(option => option.value === '50').disabled,true);
  assert.equal(ratio.value,'80','対象期変更でCSV・手入力の既存値を消さない');
  assert.equal(ratio['aria-invalid'],'true');
  assert.match(period.textContent,/対象期と重なりません/);
  h.element('periodStart').value = '2026-01-01';
  h.element('periodEnd').value = '2026-12-31';
  h.context.refreshTaxRowControls(tr);
  assert.equal(ratio.options.find(option => option.value === '80').disabled,false);
  assert.equal(ratio.options.find(option => option.value === '70').disabled,false);
  assert.equal(ratio['aria-invalid'],'false');
  assert.equal(h.context.taxRowRatioOverlapsPeriod(buckets[2],'2028-10-01','2028-10-01'),true);
  assert.equal(h.context.taxRowRatioOverlapsPeriod(buckets[1],'2028-10-01','2028-10-01'),false);
  assert.equal(h.context.taxRowRatioOverlapsPeriod(buckets[0],'',''),true,'対象期不明なら候補を推測で除外しない');
});

test('[画面ガイド] タイトルを除いた進行ボタンと対象期の要約を固定表示する構造', () => {
  const introStart = html.indexOf('<section class="panel workflow-intro');
  const introEnd = html.indexOf('</section>',introStart);
  const stickyStart = html.indexOf('<div class="panel workflow-sticky',introEnd);
  const firstScreen = html.indexOf('<div id="workflowScreen1"',stickyStart);
  assert.ok(introStart >= 0 && introEnd < stickyStart && stickyStart < firstScreen);
  assert.doesNotMatch(html.slice(stickyStart,firstScreen),/課税方式を比較します/);
  assert.match(html.slice(stickyStart,firstScreen),/workflow-steps[\s\S]*workflowStepSummary/);
  assert.match(html,/\.workflow-sticky\{position:sticky;top:0;z-index:30/);
  assert.match(html,/@media print\{[\s\S]*?\.head-actions,\.no-print\{display:none!important\}/);
});

test('[食品1％入力] 価格前提は初期値を示す任意の折りたたみ、注意文と課税区分名は1行表示', () => {
  const priceDetails = html.match(/<details id="foodPriceBasisDetails"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(priceDetails);
  assert.doesNotMatch(priceDetails[0], /<details[^>]*\sopen(?:\s|=|>)/);
  for(const id of ['foodSalesPriceBasis','foodPurchasePriceBasis']){
    assert.match(priceDetails[1], new RegExp(`<select id="${id}">[\\s\\S]*?<option value="netFixed">税抜価格据置<\\/option>`));
  }
  assert.match(priceDetails[1], /現在：売上・仕入とも税抜価格据置/);
  assert.match(html, /class="notice food-exclusion-guide"/);
  assert.match(html, /\.food-exclusion-guide\{[^}]*grid-column:1\/-1;white-space:nowrap/);
  assert.match(html, /\.tkc-row-table th:first-child,\.tkc-row-table td:first-child\{[^}]*width:340px;white-space:nowrap/);
  assert.match(html, /\.tkc-row-table \.row-code-name\{[^}]*white-space:nowrap/);
  assert.match(functionSource('renderTaxEntryRows'), /class="row-code-name" title="\$\{escapeHtml\(taxRowCodeName\(row\.code\)\)\}"/);
});

test('[C17-C19] 保存は除外要約だけを残し復元後も注意を維持、元CSVの再選択を案内する', () => {
  const storage = new Map();
  const make = () => {
    const h = flowHarness(['saveState', 'restoreState', 'openAppliedJournalRecovery', 'clearJournalImport', 'enterManualAmountInput']);
    Object.assign(h.context, { STORAGE_KEY:'csv-recovery-test',
      serializeStateIfEnabled:engine.serializeStateIfEnabled, migrateSavedState:switchDecision.migrateSavedState,
      storageGet:key => storage.get(key), storageSet(key,value){ storage.set(key,value); return true; },
      storageRemove:key => storage.delete(key), getExemptPurchaseInputIds:() => [],
      selectedValue:() => '', taxScenarioKey:() => 'current', switchDecisionOpen:false,
      foodConfirmationSignatures:{}, yen:value => `${value}円` });
    h.element('journalImportPanel').scrollIntoView = () => {};
    return h;
  };
  const before = make();
  before.element('saveToDevice').checked = true;
  before.element('type2Sale10').value = '1,100,000';
  before.context.importedCsvRecovery = { correctedCount:1, temporaryExcludedCount:2,
    confirmedExcludedCount:1, excludedAbsAmount:11000, unknownAmountCount:1, unresolvedCount:0,
    sourceText:'保存禁止の元CSV', accountName:'保存禁止の科目', reason:'保存禁止の内部判断' };
  before.context.pendingJournalImport = { sourceText:'元CSV全文SECRET', decisions:{ private:{ reason:'秘密メモ' } } };
  before.context.appliedJournalImport = before.context.pendingJournalImport;
  before.context.saveState();
  const saved = storage.get('csv-recovery-test');
  assert.doesNotMatch(saved, /保存禁止|元CSV全文SECRET|秘密メモ|sourceText|accountName/);
  assert.equal(JSON.parse(saved).importedCsvRecovery.temporaryExcludedCount, 2);
  const after = make();
  after.context.restoreState();
  assert.equal(after.element('type2Sale10').value, '1,100,000');
  assert.equal(after.context.importedCsvRecovery.temporaryExcludedCount, 2);
  assert.equal(after.context.importedCsvRecovery.unknownAmountCount, 1);
  assert.equal(after.context.appliedJournalImport, null);
  after.context.openAppliedJournalRecovery();
  assert.match(after.element('journalImportStatus').textContent, /同じCSVを再選択/);
  after.context.enterManualAmountInput();
  assert.equal(after.context.importedCsvRecovery.temporaryExcludedCount, 2);
  assert.equal(after.element('type2Sale10').value, '1,100,000');
  after.element('saveToDevice').checked = false;
  after.context.saveState();
  assert.equal(storage.has('csv-recovery-test'), false);
});

test('[概算保存] 仮除外なしの仮定も保存復元し個別情報や元CSVを混入させない', () => {
  const storage = new Map();
  const make = () => {
    const h = flowHarness(['saveState','restoreState']);
    Object.assign(h.context, {
      STORAGE_KEY:'estimate-save-test', serializeStateIfEnabled:engine.serializeStateIfEnabled,
      migrateSavedState:switchDecision.migrateSavedState,
      storageGet:key => storage.get(key), storageSet(key,value){storage.set(key,value);return true;},
      storageRemove:key => storage.delete(key), getExemptPurchaseInputIds:() => [],
      selectedValue:() => '', taxScenarioKey:() => 'current',switchDecisionOpen:false,
      foodConfirmationSignatures:{}, yen:value => `${value}円`
    });
    return h;
  };
  const before = make();
  before.element('saveToDevice').checked = true;
  before.context.importedCsvRecovery = {
    assumedDetailCount:1,assumedRate10Count:1,assumedRate10Amount:11000,
    assumedBusinessCount:2,assumedBusinessAmount:1100000,
    negativeBucketCount:1,negativeAbsAmount:110,
    negativeBuckets:[{kind:'invoicePurchase',rate:'10',amount:-110,account:'PRIVATE_ACCOUNT',memo:'PRIVATE_MEMO'}],
    sourceText:'PRIVATE_CSV',reason:'PRIVATE_REASON'
  };
  before.context.saveState();
  assert.doesNotMatch(storage.get('estimate-save-test'),/PRIVATE_/);
  const after = make();
  after.context.restoreState();
  const summary = after.context.importedCsvRecovery;
  assert.equal(summary.temporaryExcludedCount,0);
  assert.equal(summary.assumedDetailCount,1);
  assert.equal(summary.assumedRate10Amount,11000);
  assert.equal(summary.assumedBusinessCount,2);
  assert.equal(summary.negativeBucketCount,1);
  assert.equal(summary.negativeBuckets[0].amount,-110);
  assert.match(after.context.csvRecoverySummaryText(summary), /CSVに仮定あり.*税率10％.*40％.*-110円→0円/);
});

test('[C17-C21] 同名CSVの新しい解析へ補正を流用せず遅れて完了した解析も採用しない', async () => {
  const h = flowHarness(['handleJournalCsvFile']);
  const old = deferred();
  h.context.pendingJournalImport = { sourceText:'old source', decisions:{ old:{ action:'exclude' } }, applied:true };
  h.context.importedCsvRecovery = { temporaryExcludedCount:1, excludedAbsAmount:11000 };
  h.element('journalImportDisclosure').open = true;
  h.element('journalCsvFile').files = [{ name:'same.csv', arrayBuffer:() => old.promise }];
  const slow = h.context.handleJournalCsvFile();
  h.element('journalCsvFile').files = [{ name:'same.csv', arrayBuffer:async () => new ArrayBuffer(2) }];
  await h.context.handleJournalCsvFile();
  const newest = h.context.pendingJournalImport;
  assert.equal(Object.keys(newest.decisions).length, 0);
  assert.equal(newest.sourceText, 'fixture');
  old.resolve(new ArrayBuffer(1));
  await slow;
  assert.equal(h.context.pendingJournalImport, newest);
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 1);
});

test('[C19-C21] 新CSV読込み中に反映済み明細へ戻ると後着解析は表示と補正状態を上書きしない', async () => {
  const h = flowHarness(['handleJournalCsvFile', 'openAppliedJournalRecovery']);
  const reading = deferred();
  const previous = { sourceText:'applied source', applied:true,
    decisions:{ appliedEntry:{ action:'exclude' } }, mappings:{ account:'type2' },
    analysis:{ marker:'applied', errors:[], actualOnePercentEntries:[] } };
  h.context.appliedJournalImport = previous;
  h.context.pendingJournalImport = previous;
  h.context.importedCsvRecovery = { temporaryExcludedCount:1, excludedAbsAmount:11000 };
  h.element('purchase10').value = '110,000';
  h.element('journalImportPanel').scrollIntoView = () => {};
  h.element('journalImportDisclosure').open = true;
  h.element('journalCsvFile').files = [{ name:'new.csv', arrayBuffer:() => reading.promise }];
  const importing = h.context.handleJournalCsvFile();
  assert.equal(h.context.pendingJournalImport, null, '新CSV読込み中に旧プレビューを再反映できない');
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 1);
  assert.equal(h.element('purchase10').value, '110,000');
  h.context.openAppliedJournalRecovery();
  const reopened = h.context.pendingJournalImport;
  assert.equal(reopened.sourceText, 'applied source');
  assert.equal(reopened.decisions.appliedEntry.action, 'exclude');
  assert.equal(h.context.journalImportMappings.account, 'type2');
  reading.resolve(new ArrayBuffer(1));
  await importing;
  assert.equal(h.context.pendingJournalImport, reopened);
  assert.equal(h.context.pendingJournalImport.analysis.marker, 'applied');
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 1);
  assert.equal(h.element('purchase10').value, '110,000');
  assert.equal(h.context.workflowStep, 1);
});

test('[W01][W02][W03] 明示1％返品は確認案内に資料・照合項目・見解・途中相談を示す', () => {
  const h = flowHarness(['csvReviewNotice', 'renderEligibilityNotice']);
  h.context.METHOD_LABELS = {};
  h.context.DEFERRED_LIMITATIONS = [];
  h.context.escapeHtml = value => String(value);
  h.context.conditionInputLinks = () => '';
  h.context.yen = value => `${value}円`;
  const review = {
    errors:[], adjustmentCount:1, kindUnknownCount:0,
    reviewItems:[{ source:'CSV 7行目 貸方 課税区分1 取引日2028-01-15・明示1％', amount:1010, ratePercent:1,
      reason:'返品・調整のため、元取引の日付と適用税率の確認が必要です。' }]
  };
  const calc = {
    ctx:{ taxScenario:'current' }, eligibility:{ periodValid:true }, methods:[],
    unconfirmedItems:[], csvReview:review, salesEntryRequired:false, smallDifference:false
  };
  h.context.renderEligibilityNotice(calc);
  const shown = h.element('eligibilityNotice').innerHTML;
  assert.match(shown, /返品・調整1件/);
  assert.match(shown, /元帳・請求書/);
  assert.match(shown, /元取引の日付と税率/);
  assert.match(shown, /確認結果/);
  assert.match(shown, /<details>/);
  assert.match(shown, /CSV 7行目/);
  assert.match(shown, /確認した範囲と不足する資料/);
  assert.match(shown, /早めに相談/);
  assert.match(shown, /自分の見解と根拠/);
  assert.match(shown, /確認途中でも/);
  assert.doesNotMatch(shown, /確認済み/);
});

test('[W04] 所内の相談指導文は顧客用コピー・CSV・印刷に転記しない', () => {
  const h = flowHarness(['customerDecisionText', 'customerDecisionCsv', 'prepareCustomerPrint']);
  h.context.yen = value => `${Math.round(value)}円`;
  h.context.cashBenefitBasisNote = () => '未確認の参考値';
  h.context.sanitizeCsvCell = value => String(value ?? '');
  h.context.escapeHtml = value => String(value ?? '');
  const report = switchDecision.buildCustomerReportData({
    scenarioLabel:'食品1％の未施行試算', proposalNotice:'改正案に基づく試算',
    comparisonPeriod:'2027-01-01〜2027-12-31',
    execution:{ eligibility:'unknown', filingExecution:'unknown', filingStatus:'未確認',
      confirmations:['元帳・請求書を確認し、見解と不明点を添えて相談してください。'],
      customerConfirmations:['元取引の税率が未確認のため、税額は参考値です。'] },
    economics:{ periodCount:0 }
  });
  const outputs = [
    h.context.customerDecisionText(report),
    h.context.customerDecisionCsv(report)
  ];
  h.context.prepareCustomerPrint(report);
  outputs.push(h.element('customerPrintReport').innerHTML);
  for(const output of outputs){
    assert.match(output, /元取引の税率が未確認/);
    assert.match(output, /参考値/);
    assert.doesNotMatch(output, /見解と不明点を添えて相談/);
    assert.doesNotMatch(output, /元帳・請求書を確認し/);
  }
  assert.match(functionSource('calculateSwitchDecision'), /customerConfirmations/);
});
