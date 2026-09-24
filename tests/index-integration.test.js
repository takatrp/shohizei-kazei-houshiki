'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../tax-engine.js');
const journal = require('../journal-csv.js');
const switchDecision = require('../switch-decision.js');
const taxRows = require('../tax-entry-rows.js');
const { rowsFromJournalAnalysis } = require('../tax-entry-csv.js');
const { DEFERRED_LIMITATIONS } = require('../release-history.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function functionSource(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}
const names = [
  'normalizeCsvRecovery', 'csvRecoverySummaryText', 'renderJournalRecovery', 'journalRowHasInput', 'journalManualRows', 'journalImportHasExistingInput',
  'journalImportTotals', 'currentJournalImportTotals', 'journalImportTotalsText', 'updateJournalRecovery', 'excludeUnresolvedJournalEntries', 'openAppliedJournalRecovery',
  'formatInput', 'amountState', 'formatCtxAmount', 'confirmationLabel', 'simpleElectionLabel', 'taxScenarioKey', 'taxScenarioConfig', 'selectedValue', 'selectedComparisonMethods', 'foodConfirmationEvidence', 'conditionInputLinks', 'percent',
  'taxFromAmount', 'taxableBaseFromAmount', 'actualOneAmount', 'actualOneTax', 'actualOneBase',
  'inclusiveDayCount', 'proposalOverlapFraction', 'proposalFoodOriginalAmount', 'repriceFoodAmount',
  'currentLawProjectionNotice', 'validateImportedOnePercentEntries', 'csvReviewNotice', 'csvOriginPremise', 'selectionEligibilityForCurrent', 'mergeCalculationAvailability', 'cashBenefitBasisNote',
  'traceNumber', 'traceMoney', 'tracePercent', 'traceDisplayNote', 'traceLine', 'traceTaxLine', 'traceFoodRows', 'traceRounding', 'renderCalculationTrace', 'renderSwitchBreakdown',
  'setImportedAmount', 'applyJournalImport', 'syncTaxEntryRows', 'collectSales', 'exemptPurchaseInputId',
  'getExemptPurchaseInputIds', 'activeExemptPurchaseInputIds', 'collectExemptPurchases',
  'taxRowRatioOverlapsPeriod', 'purchaseRatioContext', 'purchaseRatioConflictsForContext', 'collectPurchases', 'projectProposalPurchases', 'validateProposalClassification', 'calculateProjectionPlan', 'renderProjection', 'renderTaxScenarioNotice', 'switchMetric', 'filingStatusLabel', 'calculateSwitchDecision', 'renderSwitchDecision',
  'buildAssumptionRows', 'buildSummaryText', 'buildCsvText', 'renderPrintAssumptions', 'renderHero',
  'customerDecisionText', 'customerDecisionCsv', 'prepareCustomerPrint'
];

function harness(csv){
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)) elements.set(id, {
      value:'', checked:false, open:false, style:{}, innerHTML:'', textContent:'',
      querySelector(){ return null; }, querySelectorAll(){ return []; },
      classList:{ toggle(){}, add(){}, remove(){} }, setAttribute(){}, closest(){ return this; }
    });
    return elements.get(id);
  };
  element('periodStart').value = '2028-01-01';
  element('periodEnd').value = '2028-12-31';
  element('exemptPurchaseState').value = 'unknown';
  element('modeTaxIncluded').checked = true;
  element('taxScenarioCurrent').checked = true;
  const types = [
    ['type1',.9],['type2',.8],['type3',.7],['type4',.6],['type5',.5],['type6',.4]
  ].map(([key,deemed]) => ({ key, name:key, deemed }));
  const boundaries = {80:['2023-10-01','2026-09-30'],70:['2026-10-01','2028-09-30'],
    50:['2028-10-01','2030-09-30'],30:['2030-10-01','2031-09-30'],0:['2031-10-01','']};
  const buckets = ['80','70','50','30','0'].map(key => ({ key, label:key, ratio:Number(key)/100,
    start:boundaries[key][0], end:boundaries[key][1] }));
  const context = vm.createContext({
    $:element,
    document:{ querySelector(selector){
      if(selector === 'input[name="amountMode"]:checked') return { value:element('modeTaxExcluded').checked ? 'excluded' : 'included' };
      if(selector === 'input[name="taxScenario"]:checked') return { value:element('taxScenarioFood1').checked ? 'foodProposal' : 'current' };
      return null;
    }, querySelectorAll(){ return []; } },
    parseAmountInput:engine.parseAmountInput,
    engineTaxFromAmount:engine.taxFromAmount,
    engineTaxableBaseFromAmount:engine.taxableBaseFromAmount,
    aggregateTaxRows:taxRows.aggregateTaxRows,
    aggregateScenarioPurchases:taxRows.aggregateScenarioPurchases,
    summarizeActualOnePercentEntries:taxRows.summarizeActualOnePercentEntries,
    weightedExemptPurchaseRatio:engine.weightedExemptPurchaseRatio,
    normalizeExemptPurchaseRatio:engine.normalizeExemptPurchaseRatio,
    calculateSimplifiedTax:engine.calculateSimplifiedTax,
    projectPrice:engine.projectPrice,
    assessFoodSimplifiedDiscontinuance:engine.assessFoodSimplifiedDiscontinuance,
    assessCsvOnePercentEntry:engine.assessCsvOnePercentEntry,
    assessCurrentMethodChoice:engine.assessCurrentMethodChoice,
    validateTaxPeriod:engine.validateTaxPeriod,
    FOOD_PROPOSAL:engine.FOOD_PROPOSAL,
    sanitizeCsvCell:engine.sanitizeCsvCell,
    calculateQuotedCost:switchDecision.calculateQuotedCost,
    calculateCustomerEconomics:switchDecision.calculateCustomerEconomics,
    calculateOfficeProfitability:switchDecision.calculateOfficeProfitability,
    buildCustomerReportData:switchDecision.buildCustomerReportData,
    ELIGIBILITY:engine.ELIGIBILITY,
    DEFERRED_LIMITATIONS,
    CONFIRMATION:engine.CONFIRMATION,
    resolveImportValues:journal.resolveImportValues,
    prepareEstimatedImport:journal.prepareEstimatedImport,
    analyzeTkcJournalText:journal.analyzeTkcJournalText,
    BUSINESS_TYPES:types,
    EXEMPT_PURCHASE_BUCKETS:buckets,
    CSV_EXEMPT_RATIOS:journal.EXEMPT_RATIOS,
    TAX_SCENARIOS:{ current:{}, foodProposal:{} },
    METHOD_LABELS:{},
    APP_META:{ name:'消費税課税方式検討ツール', audience:'所内試算', version:'r20', updatedAt:'2026-09-17', latestReleaseTitle:'手入力と確認事項の整理', currentLawBasisLabel:'現行', proposalBasisLabel:'提供パンフレットに基づく未施行試算' },
    yen(value){ return `${Math.round(value)}円`; },
    regularMethodLabel(){ return '通常試算'; },
    taxRateLabel(){ return '軽減8％'; },
    escapeHtml(value){ return String(value); },
    amountClass(){ return ''; },
    switchDecisionOpen:false,
    journalImportMappings:{},
    pendingJournalImport:{ analysis:journal.analyzeTkcJournalText(csv), sourceText:csv, decisions:{}, applied:false },
    importedExemptTransactionCount:0,
    importedUnsupportedEntries:[],
    importedCsvRecovery:null,
    importedCsvOrigin:null,
    appliedJournalImport:null,
    window:{ confirm:() => true },
    importedActualOnePercent:null,
    visibleBusinessTypes:new Set(),
    renderJournalImport(){}, update(){},
    renderSalesRowVisibility(){},
    sumRateAmounts:amounts => ['10','8','1'].reduce((sum, rate) => sum + Number(amounts?.[rate] || 0), 0),
    projectionPeriods(){ return [{ label:'2028年' }]; },
    workflowStep:1
  });
  vm.runInContext(names.map(functionSource).join('\n'), context);
  const ctx = {
    start:'2028-01-01', end:'2028-12-31', amountMode:'included', taxScenario:'foodProposal',
    foodForecastMethod:'manual', foodSalesPriceBasis:'netFixed', foodPurchasePriceBasis:'netFixed', creditRatio:1
  };
  return { context, element, ctx };
}

function csvRow({date='2028/01/15', side='貸方', account='売上', code='1', business='2', rate='8', amount=0, credit=''}){
  const row = Object.fromEntries(journal.REQUIRED_HEADERS.map(header => [header, '']));
  row['月日'] = date;
  row[`${side}科目名`] = account;
  row[`${side}課税区分`] = code;
  row[`${side}事業区分`] = business;
  row[`${side}軽減税率か否か`] = rate === '8' || rate === '1' ? '1' : '0';
  row[`${side}税率`] = rate;
  row[`${side}取引金額`] = String(amount);
  row[`${side}控除割合`] = String(credit);
  return row;
}
function csv(rows){
  return [journal.REQUIRED_HEADERS, ...rows.map(row => journal.REQUIRED_HEADERS.map(header => row[header]))]
    .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

function recoveryFixture(){
  return csv([
    csvRow({ rate:'10', amount:1100000 }),
    csvRow({ side:'借方', account:'仕入', code:'5', rate:'10', amount:110000 }),
    csvRow({ side:'借方', account:'内部科目SECRET', code:'5', rate:'不明', amount:11000 })
  ]);
}

function installCurrentCalculation(h){
  Object.assign(h.context, {
    viewModeKey:() => 'single', calculateDetailedRegular:engine.calculateDetailedRegular,
    calculateSpecialMethodAmount:engine.calculateSpecialMethodAmount,
    getEligibility:() => Object.fromEntries(['regular', 'simplified', 'special2', 'special3'].map(key =>
      [key, { eligibility:engine.ELIGIBILITY.ELIGIBLE, reasons:[] }])),
    assessHighAssetForMethod:() => ({ status:'clear' }), calcExemptCreditLabel:() => 'なし'
  });
  vm.runInContext(['getContext', 'periodMonthsForAnnualization', 'calculateRegularForContext',
    'detailedRegularEligibility', 'regularMethodLabel', 'declarationRoundedAmount', 'calculate'].map(functionSource).join('\n'), h.context);
  h.element('regularDetailMethod').value = 'auto';
  h.element('exemptPurchaseState').value = 'no';
}

function currentRateComparisonHarness(){
  const h = harness(csv([csvRow({ rate:'8', amount:1080000 })]));
  installCurrentCalculation(h);
  Object.assign(h.context, {
    calculateNationalSalesTax:engine.calculateNationalSalesTax,
    calculateDeclarationAmount:engine.calculateDeclarationAmount,
    METHOD_LABELS:{ regular:'本則課税', simplified:'簡易課税', special2:'2割特例', special3:'3割特例' },
    TAX_SCENARIOS:{
      current:{ label:'現行税率（標準10％・軽減8％）', reducedRate:8 },
      foodProposal:{ label:'飲食料品1％・大綱に基づく試算', reducedRate:8, foodRate:1 }
    }
  });
  vm.runInContext(['yen','renderComparisonPrint','renderMethodCards','buildCurrentRateComparison','renderCurrentRateComparison'].map(functionSource).join('\n'), h.context);
  for(const [id, value] of Object.entries({
    type2Sale8:'1,080,000', type2SaleFood1:'1,080,000', purchase8:'540,000', purchaseFood1:'540,000',
    nonTaxableSales:'0', foodForecastMethod:'manual', foodSalesPriceBasis:'netFixed', foodPurchasePriceBasis:'netFixed',
    proposalFoodClassificationState:'confirmed', proposalPurchaseClassificationState:'confirmed'
  })) h.element(id).value = value;
  h.element('taxScenarioFood1').checked = true;
  h.element('taxScenarioCurrent').checked = false;
  return h;
}

function comparisonRow(comparison, key){
  return comparison.rows.find(row => row.key === key);
}

test('[現行差額01] 同じ手入力から本則40000円対5000円・簡易16000円対0円を計算し元入力と結果を変えない', () => {
  const h = currentRateComparisonHarness();
  const calc = h.context.calculate();
  const before = JSON.stringify(calc);
  const comparison = h.context.buildCurrentRateComparison(calc);
  const regular = comparisonRow(comparison, 'regular');
  const simplified = comparisonRow(comparison, 'simplified');
  assert.equal(regular.currentAmount, 40000);
  assert.ok(Math.abs(regular.proposalAmount - 5000) < 1e-8);
  assert.equal(regular.difference, -35000);
  assert.equal(simplified.currentAmount, 16000);
  assert.equal(simplified.proposalAmount, 0);
  assert.equal(simplified.difference, -16000);
  assert.equal(comparison.current.ctx.taxScenario, 'current');
  assert.equal(JSON.stringify(calc), before);
  assert.equal(h.context.taxScenarioKey(), 'foodProposal');
  assert.equal(h.element('type2Sale8').value, '1,080,000');
  assert.equal(h.element('type2SaleFood1').value, '1,080,000');
});

test('比較方式を一般課税だけにすると簡易・特例の確認を要求せず、結果・出力・現行差額から除く', () => {
  const h = currentRateComparisonHarness();
  const all = h.context.calculate();
  h.context.selectedComparisonMethods = () => ['regular'];
  h.element('baseTaxableSales').value = '不明';
  const calc = h.context.calculate();
  assert.equal(calc.inputErrors.length,0);
  assert.equal(calc.regular.amount,all.regular.amount,'既存の本則計算額を変えない');
  assert.deepEqual(Array.from(calc.methods, method => method.key),['regular']);
  assert.ok(!calc.unconfirmedItems.join(' ').includes('簡易課税'));
  assert.doesNotMatch(h.context.conditionInputLinks(calc),/簡易課税|基準期間|特定期間|インボイス登録/);
  const comparison = h.context.buildCurrentRateComparison(calc);
  assert.deepEqual(Array.from(comparison.rows, row => row.key),['regular']);
  const summary = h.context.buildSummaryText(calc);
  assert.match(summary,/比較する申告方式: 本則課税/);
  assert.doesNotMatch(summary,/簡易課税の採用計算|簡易課税届出/);
  h.context.renderCurrentRateComparison(calc);
  assert.equal((h.element('methodCards').innerHTML.match(/class="method-row/g) || []).length,1);
});

test('一般課税だけの行入力は事業区分が空欄でも売上税額を使い、簡易の確認待ちにしない', () => {
  const h = currentRateComparisonHarness();
  h.context.selectedComparisonMethods = () => ['regular'];
  h.context.entryMode = 'rows';
  h.context.taxEntryRows = {sales:[{id:'sale',code:'1',rate:'10',amount:'1100000',businessType:'',source:'manual'}],
    purchases:[{id:'purchase',code:'5',rate:'10',amount:'0',source:'manual'}]};
  h.context.latestTaxRowAggregate = taxRows.aggregateTaxRows(h.context.taxEntryRows);
  for(const [id,state] of Object.entries(h.context.latestTaxRowAggregate.fields)) h.element(id).value = state.entered ? String(state.value) : '';
  h.element('nonTaxableSales').value = '0';
  h.element('taxScenarioFood1').checked = false;
  h.element('taxScenarioCurrent').checked = true;
  const calc = h.context.calculate();
  assert.equal(calc.sales.simplifiedBusinessUnknown,true);
  assert.equal(calc.inputErrors.length,0);
  assert.equal(calc.regular.amount,100000);
  assert.deepEqual(Array.from(calc.methods, method => method.key),['regular']);
  assert.equal(calc.methods[0].include,true);
  assert.doesNotMatch(calc.unconfirmedItems.join(' '),/事業区分/);
});

test('[TKC行結合01] 行集計を従来計算入力へ渡すと食品1％の本則・簡易と現行差額が一致する', () => {
  const h = currentRateComparisonHarness();
  const legacy = h.context.buildCurrentRateComparison(h.context.calculate());
  const aggregate = taxRows.aggregateTaxRows({
    sales:[
      {code:'1',businessType:'type2',rate:'8',amount:'1080000',foodAmount:'1080000'},
      {code:'3',amount:'0'}
    ],
    purchases:[{code:'5',rate:'8',amount:'540000',foodAmount:'540000'}]
  });
  assert.deepEqual(aggregate.errors, []);
  for(const [id, state] of Object.entries(aggregate.fields)) h.element(id).value = state.entered ? String(state.value) : '';
  const fromRows = h.context.buildCurrentRateComparison(h.context.calculate());
  for(const key of ['regular','simplified']){
    const a = comparisonRow(legacy, key);
    const b = comparisonRow(fromRows, key);
    assert.equal(b.currentAmount, a.currentAmount, key);
    assert.equal(b.proposalAmount, a.proposalAmount, key);
    assert.equal(b.difference, a.difference, key);
  }
  assert.equal(comparisonRow(fromRows, 'regular').currentAmount, 40000);
  assert.ok(Math.abs(comparisonRow(fromRows, 'regular').proposalAmount - 5000) < 1e-8);
});

test('[TKC行結合02] 明示的な追加では手入力行を保ちCSV行だけ置換し課税区分を推測しない', () => {
  const first = csv([csvRow({rate:'10',amount:1100000}),csvRow({side:'借方',code:'5',rate:'10',amount:110000})]);
  const h = harness(first);
  Object.assign(h.context, {
    entryMode:'rows',
    taxEntryRows:{sales:[{id:'manual-1',code:'3',amount:'0',source:'manual'}],purchases:[]},
    rowCsvKnownZeros:{}, rowsFromJournalAnalysis,
    newTaxEntry:side => taxRows.createTaxEntryRow(side,{id:`blank-${side}`}),
    renderTaxEntryRows(){},
    document:{...h.context.document, body:{dataset:{}}}
  });
  h.element('journalImportMode').value = 'add';
  h.context.applyJournalImport();
  assert.equal(h.context.taxEntryRows.sales.filter(row => row.source === 'manual').length, 1);
  assert.equal(h.context.taxEntryRows.sales.find(row => row.source === 'csv').code, '1');
  assert.equal(h.context.taxEntryRows.purchases.find(row => row.source === 'csv').code, '5');
  const firstAggregate = taxRows.aggregateTaxRows(h.context.taxEntryRows);
  assert.equal(firstAggregate.fields.type2Sale10.value, 1100000);
  assert.equal(firstAggregate.fields.purchase10.value, 110000);
  const second = csv([csvRow({rate:'10',amount:2200000}),csvRow({side:'借方',code:'7',rate:'10',amount:220000})]);
  h.context.pendingJournalImport = {analysis:journal.analyzeTkcJournalText(second),sourceText:second,decisions:{},applied:false};
  h.context.applyJournalImport();
  assert.equal(h.context.taxEntryRows.sales.filter(row => row.source === 'manual').length, 1);
  assert.equal(h.context.taxEntryRows.sales.filter(row => row.source === 'csv').length, 1);
  assert.equal(h.context.taxEntryRows.purchases.filter(row => row.source === 'csv').length, 1);
  assert.equal(h.context.taxEntryRows.purchases[0].code, '7');
  const secondAggregate = taxRows.aggregateTaxRows(h.context.taxEntryRows);
  assert.equal(secondAggregate.fields.type2Sale10.value, 2200000);
  assert.equal(secondAggregate.fields.purchase10.value, 220000);
  assert.equal(secondAggregate.fields.commonPurchaseTax.value, 20000);
  assert.equal(h.context.importedCsvOrigin.importMode, 'add');
});

test('[F02/T03] 標準置換は手入力を加算せず、明示追加は再反映してもCSVを二重計上しない', () => {
  const fixture = csv([csvRow({rate:'10',amount:11000000}),csvRow({side:'借方',code:'5',rate:'10',amount:1100000})]);
  const setup = mode => {
    const h = harness(fixture);
    Object.assign(h.context, {
      entryMode:'rows', taxEntryRows:{
        sales:[{id:'manual-sale',code:'1',businessType:'type2',rate:'10',amount:'11000000',source:'manual'}],
        purchases:[{id:'manual-purchase',code:'5',rate:'10',amount:'1100000',source:'manual'}]
      }, rowCsvKnownZeros:{}, rowsFromJournalAnalysis,
      newTaxEntry:side => taxRows.createTaxEntryRow(side,{id:`blank-${side}`}),
      renderTaxEntryRows(){}, document:{...h.context.document,body:{dataset:{}}}
    });
    h.element('journalImportMode').value = mode;
    return h;
  };
  const replace = setup('replace');
  replace.context.applyJournalImport();
  assert.equal(taxRows.aggregateTaxRows(replace.context.taxEntryRows).fields.type2Sale10.value, 11000000);
  assert.equal(replace.context.taxEntryRows.sales.some(row => row.source === 'manual'), false);
  replace.context.applyJournalImport();
  assert.equal(taxRows.aggregateTaxRows(replace.context.taxEntryRows).fields.type2Sale10.value, 11000000);
  const add = setup('add');
  add.context.applyJournalImport();
  assert.equal(taxRows.aggregateTaxRows(add.context.taxEntryRows).fields.type2Sale10.value, 22000000);
  add.context.applyJournalImport();
  assert.equal(taxRows.aggregateTaxRows(add.context.taxEntryRows).fields.type2Sale10.value, 22000000);
  assert.equal(add.context.importedCsvOrigin.manualRowsKept, 2);
});

test('[F02/T03] 反映をキャンセルするとCSV後の手修正を含め既存状態が不変', () => {
  const fixture = csv([csvRow({rate:'10',amount:11000000})]);
  const h = harness(fixture);
  const edited = {id:'csv-edited-1',code:'1',businessType:'type2',rate:'10',amount:'12000000',source:'csv-edited'};
  Object.assign(h.context, {
    entryMode:'rows',taxEntryRows:{sales:[edited],purchases:[]},rowCsvKnownZeros:{purchase10:true},
    importedCsvOrigin:{dateRange:{start:'2025-01-01',end:'2025-12-31'},manualChanged:true},
    importedActualOnePercent:{entries:[{kind:'sale',amount:1000}]},
    rowsFromJournalAnalysis,newTaxEntry:side => taxRows.createTaxEntryRow(side,{id:`blank-${side}`}),
    renderTaxEntryRows(){},document:{...h.context.document,body:{dataset:{}}}
  });
  h.element('journalImportMode').value = 'replace';
  h.element('type2Sale10').value = '12,000,000';
  let prompt = '';
  h.context.window.confirm = text => { prompt = text; return false; };
  const before = JSON.stringify({rows:h.context.taxEntryRows,origin:h.context.importedCsvOrigin,actual:h.context.importedActualOnePercent,known:h.context.rowCsvKnownZeros,pending:h.context.pendingJournalImport,form:h.element('type2Sale10').value});
  h.context.applyJournalImport();
  assert.match(prompt,/CSV後の手修正/);
  assert.equal(JSON.stringify({rows:h.context.taxEntryRows,origin:h.context.importedCsvOrigin,actual:h.context.importedActualOnePercent,known:h.context.rowCsvKnownZeros,pending:h.context.pendingJournalImport,form:h.element('type2Sale10').value}),before);
});

function fourFixRowHarness({start,end,scenario,purchases}){
  const h = currentRateComparisonHarness();
  h.context.entryMode = 'rows';
  h.context.rowCsvKnownZeros = {};
  h.context.taxEntryRows = {
    sales:[
      {id:'sale-1',code:'1',businessType:'type5',rate:'10',amount:'11000000',foodAmount:'',source:'manual'},
      {id:'sale-3',code:'3',rate:'',amount:'10000000',foodAmount:'',source:'manual'}
    ], purchases:purchases.map((row,index) => ({id:`purchase-${index}`,source:'manual',foodAmount:'',...row}))
  };
  h.element('periodStart').value = start;
  h.element('periodEnd').value = end;
  h.element('regularDetailMethod').value = 'individual';
  h.element('exemptPurchaseState').value = purchases.some(row => ['52','62','72'].includes(row.code)) ? 'yes' : 'no';
  h.element('foodForecastMethod').value = 'manual';
  h.element('foodSalesPriceBasis').value = 'netFixed';
  h.element('foodPurchasePriceBasis').value = 'netFixed';
  h.element('proposalFoodClassificationState').value = 'none';
  h.element('proposalPurchaseClassificationState').value = 'confirmed';
  h.element('taxScenarioFood1').checked = scenario === 'foodProposal';
  h.element('taxScenarioCurrent').checked = scenario !== 'foodProposal';
  h.context.syncTaxEntryRows();
  return h;
}

test('[F01/T01] 行入力の食品1％個別対応は3用途の税額から940000円、現行との差70000円', () => {
  const h = fourFixRowHarness({start:'2027-04-01',end:'2028-03-31',scenario:'foodProposal',purchases:[
    {code:'5',rate:'8',amount:'1080000',foodAmount:'1080000'},
    {code:'6',rate:'10',amount:'1100000'},
    {code:'7',rate:'10',amount:'1100000'}
  ]});
  const before = JSON.stringify(h.context.taxEntryRows);
  const calc = h.context.calculate();
  const comparison = h.context.buildCurrentRateComparison(calc);
  assert.ok(Math.abs(calc.purchases.purchaseTaxByUse.taxableOnly - 10000) < 1e-7);
  assert.equal(calc.purchases.purchaseTaxByUse.nonTaxableOnly,100000);
  assert.equal(calc.purchases.purchaseTaxByUse.common,100000);
  assert.ok(Math.abs(calc.creditablePurchaseTax - 210000) < 1e-7);
  assert.ok(Math.abs(calc.regular.regularCredit - 60000) < 1e-7);
  assert.ok(Math.abs(calc.regular.amount - 940000) < 1e-7);
  assert.equal(comparisonRow(comparison,'regular').currentAmount,870000);
  assert.ok(Math.abs(comparisonRow(comparison,'regular').proposalAmount - 940000) < 1e-7);
  assert.ok(Math.abs(comparisonRow(comparison,'regular').difference - 70000) < 1e-7);
  assert.doesNotMatch(comparison.notes.join(' '),/用途別には配分していません/);
  assert.doesNotMatch(comparisonRow(comparison,'regular').reasons.join(' '),/入力値固定/);
  assert.match(h.context.renderCalculationTrace(calc,calc.methods.find(method => method.key === 'regular')),/課税売上対応 10,000円/);
  assert.equal(JSON.stringify(h.context.taxEntryRows),before);
});

test('[F01/T02] 食品の税込据置・比例配分・全額控除・区分52の70％を同じ行経路で検証', () => {
  const create = () => fourFixRowHarness({start:'2027-04-01',end:'2028-03-31',scenario:'foodProposal',purchases:[
    {code:'5',rate:'8',amount:'1080000',foodAmount:'1080000'},
    {code:'6',rate:'10',amount:'1100000'},
    {code:'7',rate:'10',amount:'1100000'}
  ]});
  const gross = create();
  gross.element('foodPurchasePriceBasis').value = 'grossFixed';
  assert.ok(Math.abs(gross.context.calculate().regular.amount - 939306.9306930693) < 1e-6);
  const proportional = create();
  proportional.element('regularDetailMethod').value = 'proportional';
  assert.ok(Math.abs(proportional.context.calculate().regular.amount - 895000) < 1e-7);
  const full = create();
  full.context.taxEntryRows.sales[1].amount = '0';
  full.context.syncTaxEntryRows();
  assert.ok(Math.abs(full.context.calculate().regular.amount - 790000) < 1e-7);
  const exempt = create();
  Object.assign(exempt.context.taxEntryRows.purchases[0],{code:'52',creditRatio:'70',creditRatioSource:'manual'});
  exempt.element('exemptPurchaseState').value = 'yes';
  exempt.context.syncTaxEntryRows();
  const result = exempt.context.calculate();
  assert.ok(Math.abs(result.purchases.purchaseTaxByUse.taxableOnly - 7000) < 1e-7);
  assert.ok(Math.abs(result.regular.amount - 943000) < 1e-7);
});

test('[F03/T04] 4期の次期70％は元の区分52税額から再集計し本則880000円', () => {
  const h = fourFixRowHarness({start:'2025-10-01',end:'2026-09-30',scenario:'current',purchases:[
    {code:'52',rate:'10',amount:'1100000',creditRatio:'80',creditRatioSource:'manual'},
    {code:'6',rate:'10',amount:'1100000'},
    {code:'7',rate:'10',amount:'1100000'}
  ]});
  const calc = h.context.calculate();
  assert.equal(calc.regular.amount,870000);
  const futureCtx = {...calc.ctx,start:'2026-10-01',end:'2027-09-30'};
  const futurePurchase = h.context.projectProposalPurchases(calc.purchases,futureCtx,1);
  const futureRegular = h.context.calculateRegularForContext(futureCtx,calc.sales,futurePurchase);
  assert.equal(futurePurchase.purchaseTaxByUse.taxableOnly,70000);
  assert.equal(futurePurchase.purchaseTaxByUse.nonTaxableOnly,100000);
  assert.equal(futurePurchase.purchaseTaxByUse.common,100000);
  assert.equal(futurePurchase.invoiceTax + futurePurchase.exemptCreditableTax,270000);
  assert.equal(futureRegular.regularCredit,120000);
  assert.equal(futureRegular.amount,880000);
});

test('[F03/T04] 50％・30％・0％と境界をまたぐ日数按分で元行から用途別に再計算', () => {
  const h = fourFixRowHarness({start:'2025-10-01',end:'2026-09-30',scenario:'current',purchases:[
    {code:'52',rate:'10',amount:'1100000',creditRatio:'80',creditRatioSource:'manual'},
    {code:'6',rate:'10',amount:'1100000'}, {code:'7',rate:'10',amount:'1100000'}
  ]});
  const calc = h.context.calculate();
  for(const [start,end,ratio,tax] of [
    ['2028-10-01','2029-09-30',.5,900000],
    ['2030-10-01','2031-09-30',.3,920000],
    ['2031-10-01','2032-09-30',0,950000]
  ]){
    const ctx = {...calc.ctx,start,end};
    const snapshot = h.context.projectProposalPurchases(calc.purchases,ctx,1);
    assert.ok(Math.abs(snapshot.purchaseTaxByUse.taxableOnly - 100000 * ratio) < 1e-7);
    assert.ok(Math.abs(h.context.calculateRegularForContext(ctx,calc.sales,snapshot).amount - tax) < 1e-7);
  }
  const ctx = {...calc.ctx,start:'2026-07-01',end:'2027-06-30'};
  const ratio = engine.weightedExemptPurchaseRatio(ctx.start,ctx.end).ratio;
  const snapshot = h.context.projectProposalPurchases(calc.purchases,ctx,1);
  assert.ok(ratio > .7 && ratio < .8);
  assert.ok(Math.abs(snapshot.purchaseTaxByUse.taxableOnly - 100000 * ratio) < 1e-7);
  assert.ok(Math.abs(snapshot.invoiceTax + snapshot.exemptCreditableTax - (200000 + 100000 * ratio)) < 1e-7);
});

test('[F04/T05] 2027年通常取引の手動80％矛盾は本則と4期累計を未算定、他方式は残す', () => {
  const h = fourFixRowHarness({start:'2027-01-01',end:'2027-12-31',scenario:'current',purchases:[
    {code:'52',rate:'10',amount:'1100000',creditRatio:'80',creditRatioSource:'manual'},
    {code:'6',rate:'10',amount:'1100000'},
    {code:'7',rate:'10',amount:'1100000'}
  ]});
  const calc = h.context.calculate();
  assert.equal(h.context.taxEntryRows.purchases[0].creditRatio,'80');
  assert.equal(calc.regular.amount,null);
  assert.match(calc.regular.unavailableReasons.join(' '),/80％.*課税期間|課税期間.*80％/);
  assert.equal(calc.methods.find(method => method.key === 'regular').include,false);
  assert.equal(typeof calc.methods.find(method => method.key === 'simplified').amount,'number');
  const plan = h.context.calculateProjectionPlan(calc);
  assert.equal(plan.optimized.ok,false);
  assert.match(plan.optimized.reason,/控除割合/);
  assert.match(h.context.buildSummaryText(calc),/80％.*課税期間|課税期間.*80％/);
  assert.match(h.context.buildCsvText(calc),/80％.*課税期間|課税期間.*80％/);
  const print = h.context.buildAssumptionRows(calc).map(([,value]) => value).join(' ');
  assert.match(print,/80％.*課税期間|課税期間.*80％/);
  h.context.taxEntryRows.purchases[0].creditRatio = '70';
  h.context.syncTaxEntryRows();
  assert.equal(h.context.calculate().regular.amount,880000);
});

test('[F04/T05] CSV元日付の境界を検証し過年度80％実績は2027年70％予測へ換算', () => {
  const crossing = fourFixRowHarness({start:'2026-01-01',end:'2026-12-31',scenario:'current',purchases:[
    {code:'52',rate:'10',amount:'1100000',creditRatio:'80',source:'csv',sourceDateStart:'2026-09-30',sourceDateEnd:'2026-09-30'},
    {code:'62',rate:'10',amount:'1100000',creditRatio:'70',source:'csv',sourceDateStart:'2026-10-01',sourceDateEnd:'2026-10-01'},
    {code:'7',rate:'10',amount:'1100000'}
  ]});
  assert.equal(crossing.context.calculate().purchases.purchaseRatioConflicts.length,0);
  crossing.context.taxEntryRows.purchases[0].sourceDateStart = '2026-10-01';
  crossing.context.taxEntryRows.purchases[0].sourceDateEnd = '2026-10-01';
  assert.match(crossing.context.calculate().regular.unavailableReasons.join(' '),/CSV元取引日/);
  crossing.context.taxEntryRows.purchases[0].sourceDateStart = '2026-09-30';
  crossing.context.taxEntryRows.purchases[0].sourceDateEnd = '2026-09-30';
  const beforeAdjustment = crossing.context.calculate().regular.amount;
  crossing.context.taxEntryRows.purchases[0].sourceAdjustmentCount = 1;
  assert.equal(crossing.context.calculate().regular.amount,beforeAdjustment,
    '返品・値引きは同区分・同税率の純額として試算し、元取引日だけを理由に止めない');
  crossing.context.taxEntryRows.purchases[0].sourceAdjustmentCount = 0;
  const historical = fourFixRowHarness({start:'2027-01-01',end:'2027-12-31',scenario:'current',purchases:[
    {code:'52',rate:'10',amount:'1100000',creditRatio:'80',source:'csv',sourceDateStart:'2025-04-01',sourceDateEnd:'2025-04-01'},
    {code:'6',rate:'10',amount:'1100000'}, {code:'7',rate:'10',amount:'1100000'}
  ]});
  const result = historical.context.calculate();
  assert.equal(result.purchases.purchaseRatioConflicts.length,0);
  assert.equal(result.purchases.purchaseTaxByUse.taxableOnly,70000);
  assert.equal(result.regular.amount,880000);
  assert.equal(result.purchases.historicalRatioAdjustment,-10000);
  assert.match(historical.context.renderCalculationTrace(result,result.methods.find(method => method.key === 'regular')),/過年度CSVを対象期に換算/);
});

test('[現行差額02] 税込据置・税抜入力・日数配分の変更を同じ価格前提と計算値で比較する', () => {
  const h = currentRateComparisonHarness();
  h.element('foodSalesPriceBasis').value = 'grossFixed';
  h.element('foodPurchasePriceBasis').value = 'grossFixed';
  let calc = h.context.calculate();
  let comparison = h.context.buildCurrentRateComparison(calc);
  let row = comparisonRow(comparison, 'regular');
  assert.equal(row.currentAmount, 40000);
  assert.ok(Math.abs(row.proposalAmount - 540000 / 101) < 1e-8);
  assert.equal(row.proposalAmount, calc.methods.find(method => method.key === 'regular').amount);
  assert.equal(row.difference, row.proposalAmount - row.currentAmount);

  h.element('modeTaxExcluded').checked = true;
  h.element('modeTaxIncluded').checked = false;
  for(const [id, value] of Object.entries({ type2Sale8:'1000000', type2SaleFood1:'1000000', purchase8:'500000', purchaseFood1:'500000', foodSalesPriceBasis:'netFixed', foodPurchasePriceBasis:'netFixed' })) h.element(id).value = value;
  comparison = h.context.buildCurrentRateComparison(h.context.calculate());
  assert.equal(comparisonRow(comparison, 'regular').currentAmount, 40000);
  assert.equal(comparisonRow(comparison, 'regular').proposalAmount, 5000);

  h.element('periodStart').value = '2026-01-01';
  h.element('periodEnd').value = '2026-12-31';
  h.element('foodForecastMethod').value = 'uniform';
  calc = h.context.calculate();
  comparison = h.context.buildCurrentRateComparison(calc);
  row = comparisonRow(comparison, 'regular');
  const fraction = h.context.proposalOverlapFraction(calc.ctx.start, calc.ctx.end);
  assert.equal(row.currentAmount, 40000);
  assert.ok(Math.abs(row.proposalAmount - (40000 - 35000 * fraction)) < 1e-8);
});

test('[現行差額03] 10％だけなら差額0円、売上変更後は結果カードと同時に再計算する', () => {
  const h = currentRateComparisonHarness();
  for(const id of ['type2Sale8','type2SaleFood1','purchase8','purchaseFood1']) h.element(id).value = '';
  h.element('type2Sale10').value = '1100000';
  h.element('purchase10').value = '550000';
  h.element('proposalFoodClassificationState').value = 'none';
  h.element('proposalPurchaseClassificationState').value = 'none';
  let calc = h.context.calculate();
  let comparison = h.context.buildCurrentRateComparison(calc);
  for(const row of comparison.rows) assert.equal(row.difference, 0);
  assert.equal(comparisonRow(comparison, 'regular').currentAmount, 50000);
  h.element('type2Sale10').value = '2200000';
  calc = h.context.calculate();
  comparison = h.context.buildCurrentRateComparison(calc);
  assert.equal(comparisonRow(comparison, 'regular').currentAmount, 150000);
  assert.equal(comparisonRow(comparison, 'regular').proposalAmount, calc.methods[0].amount);
  assert.equal(comparisonRow(comparison, 'regular').difference, 0);
});

test('[現行差額04] 明示1％CSVは通常明細・相殺ゼロ・旧保存の集計のみでも8％へ変換しない', () => {
  for(const source of [
    { salesByType:{ type2:101000 }, entries:[{ kind:'sale', businessType:'type2', date:'2028-01-15', ratePercent:1, transactionKind:'ordinary', amount:101000 }] },
    { salesByType:{ type2:0 }, entries:[{ kind:'sale', businessType:'type2', date:'2028-01-15', ratePercent:1, transactionKind:'ordinary', amount:1010 }, { kind:'sale', businessType:'type2', date:'2028-01-15', ratePercent:1, transactionKind:'adjustment', amount:-1010 }] },
    { salesByType:{ type2:101000 }, entries:[] },
    { salesByType:{}, invoicePurchase:10100, entries:[] },
    { salesByType:{}, exemptPurchases:{70:10100}, entries:[] }
  ]){
    const h = currentRateComparisonHarness();
    h.context.importedActualOnePercent = { invoicePurchase:0, exemptPurchases:{}, ...source };
    const calc = h.context.calculate();
    assert.equal(calc.comparisonReady, true);
    const comparison = h.context.buildCurrentRateComparison(calc);
    assert.equal(comparison.current, null);
    for(const row of comparison.rows){
      assert.equal(row.currentAmount, null);
      assert.equal(row.difference, null);
      assert.equal(row.proposalAmount, calc.methods.find(method => method.key === row.key).amount);
    }
    assert.match(comparison.notes.join(' '), /明示1％/);
    assert.match(comparison.notes.join(' '), /現行|8％/);
    h.context.renderCurrentRateComparison(calc);
    const print = h.element('comparisonPrintContent').innerHTML;
    assert.match(print, /明示1％/);
    for(const note of comparison.notes) assert.ok(print.includes(h.context.escapeHtml(note)), '明示1％実績から現行へ逆算できない前提を帳票にも残す');
    const currentCells = [...print.matchAll(/data-column="current"[^>]*>([\s\S]*?)<\/td>/g)];
    assert.equal(currentCells.length, 4);
    for(const cell of currentCells) assert.match(cell[1], /未算定/);
  }
});

test('[現行差額05] 未入力・不正入力を0円にせず、明示0円だけは差額0円を表示できる', () => {
  const h = currentRateComparisonHarness();
  for(const id of ['type2Sale8','type2SaleFood1','purchase8','purchaseFood1']) h.element(id).value = '';
  h.element('proposalFoodClassificationState').value = 'unknown';
  h.element('proposalPurchaseClassificationState').value = 'unknown';
  let comparison = h.context.buildCurrentRateComparison(h.context.calculate());
  assert.equal(comparison.current, null);
  for(const row of comparison.rows){
    assert.equal(row.currentAmount, null);
    assert.equal(row.proposalAmount, null);
    assert.equal(row.difference, null);
  }
  h.element('type2Sale10').value = '0';
  comparison = h.context.buildCurrentRateComparison(h.context.calculate());
  assert.equal(comparisonRow(comparison, 'simplified').currentAmount, 0);
  assert.equal(comparisonRow(comparison, 'simplified').proposalAmount, 0);
  assert.equal(comparisonRow(comparison, 'simplified').difference, 0);
  h.element('type2Sale10').value = '金額不明';
  comparison = h.context.buildCurrentRateComparison(h.context.calculate());
  assert.equal(comparison.current, null);
  assert.ok(comparison.rows.every(row => row.currentAmount === null && row.proposalAmount === null && row.difference === null));
});

test('[現行差額06] 未確認方式は参考、適用不可方式は非数値とし本則未算定でも他方式を比較する', () => {
  const h = currentRateComparisonHarness();
  h.context.getEligibility = () => ({
    regular:{ eligibility:engine.ELIGIBILITY.ELIGIBLE, reasons:[] },
    simplified:{ eligibility:engine.ELIGIBILITY.UNKNOWN, reasons:['届出未確認'] },
    special2:{ eligibility:engine.ELIGIBILITY.INELIGIBLE, reasons:['対象期間外'] },
    special3:{ eligibility:engine.ELIGIBILITY.UNKNOWN, reasons:['登録未確認'] }
  });
  h.element('nonTaxableSales').value = '';
  const comparison = h.context.buildCurrentRateComparison(h.context.calculate());
  for(const key of ['regular','special2']){
    const row = comparisonRow(comparison, key);
    assert.equal(row.currentAmount, null);
    assert.equal(row.proposalAmount, null);
    assert.equal(row.difference, null);
  }
  assert.equal(comparisonRow(comparison, 'simplified').difference, -16000);
  assert.equal(comparisonRow(comparison, 'simplified').reference, true);
  assert.equal(comparisonRow(comparison, 'special3').reference, true);
  h.context.renderCurrentRateComparison(h.context.calculate());
  assert.match(h.element('methodCards').innerHTML, /参考/);
  assert.match(h.element('methodCards').innerHTML, /対象外|対象期間外/);
  h.element('proposalFoodClassificationState').value = 'unknown';
  h.element('proposalPurchaseClassificationState').value = 'unknown';
  const unconfirmed = h.context.calculate();
  h.context.renderCurrentRateComparison(unconfirmed);
  const print = h.element('comparisonPrintContent').innerHTML;
  assert.match(print, /1％対象食品の区分は未確認/);
  assert.match(print, /現在の食品内数を仮定した参考差額/);
  assert.match(print, /参考/);
  assert.equal(h.element('proposalFoodClassificationState').value, 'unknown');
  assert.equal(h.element('proposalPurchaseClassificationState').value, 'unknown');
});

test('[現行差額07] 両列の端数条件を概算にそろえ、詳細設定と既存計算値は変更しない', () => {
  const h = currentRateComparisonHarness();
  h.element('advancedMode').checked = true;
  h.element('declarationRounding').checked = true;
  h.element('type2Sale8').value = '1080123';
  h.element('type2SaleFood1').value = '1080123';
  const calc = h.context.calculate();
  const before = JSON.stringify(calc);
  const comparison = h.context.buildCurrentRateComparison(calc);
  assert.equal(comparison.current.ctx.declarationRounding, false);
  assert.equal(h.element('declarationRounding').checked, true);
  assert.equal(JSON.stringify(calc), before);
  assert.equal(comparisonRow(comparison, 'regular').currentAmount, engine.taxFromAmount(1080123,8,'included') - 40000);
  assert.match(comparison.notes.join(' '), /概算|丸め/);
});

test('[現行差額08] CSVからの8％入力と仮定・除外要約を保持して参考差額を生成する', () => {
  const h = currentRateComparisonHarness();
  h.context.pendingJournalImport = {
    sourceText:csv([csvRow({rate:'8',amount:1080000}),csvRow({side:'借方',code:'5',rate:'8',amount:540000})]), decisions:{}, applied:false
  };
  h.context.pendingJournalImport.analysis = journal.analyzeTkcJournalText(h.context.pendingJournalImport.sourceText);
  h.context.applyJournalImport();
  h.element('type2SaleFood1').value = '1080000';
  h.element('purchaseFood1').value = '540000';
  h.context.importedCsvRecovery = {temporaryExcludedCount:1,excludedAbsAmount:11000,unknownAmountCount:0};
  const calc = h.context.calculate();
  const comparison = h.context.buildCurrentRateComparison(calc);
  assert.equal(comparisonRow(comparison, 'regular').difference, -35000);
  assert.ok(comparison.rows.every(row => row.reference));
  assert.equal(comparison.current.csvRecovery.temporaryExcludedCount, 1);
  h.context.renderCurrentRateComparison(calc);
  assert.match(h.element('currentRateComparisonNotes').innerHTML || h.element('currentRateComparisonNotes').textContent, /仮除外1明細/);
  assert.match(h.element('comparisonPrintContent').innerHTML, /仮除外1明細/);
  assert.match(h.element('comparisonPrintContent').innerHTML, /11,000円|11000円/);
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 1);
});

test('[現行差額09][r27] 同じ方式表で円単位の増減を示し現行モードでは差額列だけを除く', () => {
  const h = currentRateComparisonHarness();
  h.context.renderCurrentRateComparison(h.context.calculate());
  const rows = h.element('methodCards').innerHTML;
  assert.match(rows, /40,000円/);
  assert.match(rows, /5,000円/);
  assert.match(rows, /35,000円/);
  assert.match(rows, /減少/);
  assert.doesNotMatch(rows, /\d\.\d+円/);
  h.element('type2Sale8').value = '0';
  h.element('type2SaleFood1').value = '0';
  h.element('type2Sale10').value = '110000';
  h.context.renderCurrentRateComparison(h.context.calculate());
  assert.match(h.element('methodCards').innerHTML, /増加/);
  h.element('taxScenarioFood1').checked = false;
  h.element('taxScenarioCurrent').checked = true;
  const current = h.context.calculate();
  assert.equal(h.context.buildCurrentRateComparison(current), null);
  h.context.renderCurrentRateComparison(current);
  assert.match(h.element('methodCards').innerHTML, /本則課税|簡易課税/);
  assert.doesNotMatch(h.element('methodComparisonHead').innerHTML, /現行税率との差額|1％試算/);
  assert.equal(h.element('currentRateComparisonNotes').innerHTML, '');
  assert.doesNotMatch(html, /id="currentRateComparison(?:Panel|Rows|Heading)"/);
  assert.match(html, /<table[^>]*id="methodComparisonTable"/);
  assert.match(html, /<tbody[^>]*id="methodCards"/);
});

test('[現行差額10] 表を生成しても既存の顧客用コピー・CSV・印刷へ自動追加しない', () => {
  const h = currentRateComparisonHarness();
  const calc = h.context.calculate();
  const textBefore = h.context.buildSummaryText(calc);
  const csvBefore = h.context.buildCsvText(calc);
  h.context.renderPrintAssumptions(calc);
  const printBefore = h.element('printAssumptions').innerHTML;
  h.context.renderCurrentRateComparison(calc);
  assert.equal(h.context.buildSummaryText(calc), textBefore);
  assert.equal(h.context.buildCsvText(calc), csvBefore);
  h.context.renderPrintAssumptions(calc);
  assert.equal(h.element('printAssumptions').innerHTML, printBefore);
});

test('[現行差額11] 旧形式の食品1％用途別税額は推定換算せず本則を未算定にする', () => {
  const h = currentRateComparisonHarness();
  h.element('regularDetailMethod').value = 'individual';
  h.element('nonTaxableSales').value = '100000';
  h.element('taxableOnlyPurchaseTax').value = '2000';
  h.element('commonPurchaseTax').value = '1000';
  const calc = h.context.calculate();
  const comparison = h.context.buildCurrentRateComparison(calc);
  const row = comparisonRow(comparison, 'regular');
  assert.equal(calc.regular.appliedMethod, 'unresolved');
  assert.equal(calc.regular.amount, null);
  assert.match(calc.regular.unavailableReasons.join(' '), /旧形式.*食品1％/);
  assert.equal(comparison.current.regular.appliedMethod, 'individual');
  assert.equal(comparison.current.ctx.taxableOnlyPurchaseTax, calc.ctx.taxableOnlyPurchaseTax);
  assert.equal(comparison.current.ctx.commonPurchaseTax, calc.ctx.commonPurchaseTax);
  assert.equal(row.reference, true);
  assert.equal(typeof row.currentAmount, 'number');
  assert.equal(row.difference, null);
  assert.match(row.reasons.join(' '), /用途別仕入税額.*入力値固定/);
  assert.match(comparison.notes.join(' '), /税率変更を用途別には配分していません/);
  assert.equal(h.element('taxableOnlyPurchaseTax').value, '2000');
  assert.equal(h.element('commonPurchaseTax').value, '1000');
  h.context.renderCurrentRateComparison(calc);
  const print = h.element('comparisonPrintContent').innerHTML;
  assert.match(print, /用途別仕入税額.*入力値固定/);
  assert.match(print, /税率変更を用途別には配分していません/);
  assert.match(print, /旧形式の用途別仕入税額は食品1％へ再計算できません/);
});

test('[現行差額12] 実際の適用判定を再利用し2028年の2割対象外と3割24000円対0円を区別する', () => {
  const h = currentRateComparisonHarness();
  h.context.calculateEligibility = engine.calculateEligibility;
  vm.runInContext(functionSource('getEligibility'), h.context);
  const ctx = {
    ...h.context.getContext(), invoiceRegistered:'yes', invoiceTransition:'yes',
    noSpecialExclusion:'yes', simpleNoticeReady:'yes', baseTaxableSales:1000000, baseSalesEntered:true,
    specificTaxableSales:1000000, specificSalesEntered:true, specificInputEntered:true, specificUnder10m:true
  };
  const calc = h.context.calculate(ctx);
  const comparison = h.context.buildCurrentRateComparison(calc);
  const special2 = comparisonRow(comparison, 'special2');
  const special3 = comparisonRow(comparison, 'special3');
  assert.equal(special2.proposalMethod.eligibility, engine.ELIGIBILITY.INELIGIBLE);
  assert.equal(special2.currentMethod.eligibility, engine.ELIGIBILITY.INELIGIBLE);
  assert.equal(special2.currentAmount, null);
  assert.equal(special2.proposalAmount, null);
  assert.equal(special2.difference, null);
  assert.equal(special3.proposalMethod.eligibility, engine.ELIGIBILITY.ELIGIBLE);
  assert.equal(special3.currentAmount, 24000);
  assert.equal(special3.proposalAmount, 0);
  assert.equal(special3.difference, -24000);
});

test('[F01] 簡易課税の当期継続制限は本則の計算済み還付額より優先され、画面と通常帳票に理由を残す', () => {
  for(const initialElectionStatus of ['first', 'second', 'free']){
    const h = currentRateComparisonHarness();
    h.element('taxScenarioFood1').checked = false;
    h.element('taxScenarioCurrent').checked = true;
    h.element('type2Sale8').value = '';
    h.element('type2SaleFood1').value = '';
    h.element('purchase8').value = '';
    h.element('purchaseFood1').value = '';
    h.element('type2Sale10').value = '11,000,000';
    h.element('purchase10').value = '22,000,000';
    const ctx = {
      ...h.context.getContext(), entity:'corporation', advancedMode:true,
      simpleElectionStatus:initialElectionStatus, currentDiscontinuanceReady:'no',
      simpleNoticeReady:'yes', baseSalesEntered:true, baseTaxableSales:20000000
    };
    const calc = h.context.calculate(ctx);
    const regular = calc.methods.find(method => method.key === 'regular');
    const simplified = calc.methods.find(method => method.key === 'simplified');
    assert.equal(calc.comparisonReady, true, initialElectionStatus);
    assert.equal(regular.amount, -1000000, initialElectionStatus);
    assert.equal(regular.selectionEligibility.eligibility, engine.ELIGIBILITY.INELIGIBLE);
    assert.equal(regular.calculationAvailability.eligibility, engine.ELIGIBILITY.ELIGIBLE);
    assert.equal(regular.eligibility, engine.ELIGIBILITY.INELIGIBLE);
    assert.equal(regular.include, false);
    assert.match(regular.reasons.join(''), initialElectionStatus === 'free' ? /不適用届出書/ : /2年継続/);
    assert.equal(simplified.amount, 200000);
    assert.equal(calc.best?.key, 'simplified');
    h.context.renderCurrentRateComparison(calc);
    assert.match(h.element('methodCards').innerHTML, initialElectionStatus === 'free' ? /不適用届出書/ : /2年継続/);
    assert.match(h.element('comparisonPrintContent').innerHTML, initialElectionStatus === 'free' ? /不適用届出書/ : /2年継続/);
    assert.match(h.context.buildSummaryText(calc), /本則課税: 入力条件では適用対象外/);
  }
});

function electionToggleHarness(){
  const h = currentRateComparisonHarness();
  h.element('taxScenarioFood1').checked = false;
  h.element('taxScenarioCurrent').checked = true;
  h.element('type2Sale8').value = '';
  h.element('type2SaleFood1').value = '';
  h.element('purchase8').value = '';
  h.element('purchaseFood1').value = '';
  h.element('type2Sale10').value = '11,000,000';
  h.element('purchase10').value = '22,000,000';
  h.element('baseTaxableSales').value = '20,000,000';
  h.element('currentReturnMethod').value = 'simplified';
  h.element('simpleElectionStatus').value = 'unknown';
  h.element('currentDiscontinuanceReady').value = 'unknown';
  const priorSelected = h.context.selectedValue;
  h.context.selectedValue = (name,fallback) => ({entityType:'corporation',creditMode:'confirmed',simpleNoticeReadyState:'yes'})[name] || priorSelected(name,fallback);
  h.context.calculateEligibility = engine.calculateEligibility;
  vm.runInContext(functionSource('getEligibility'),h.context);
  return h;
}

function regularChoiceSnapshot(calc){
  const regular = calc.methods.find(method => method.key === 'regular');
  return {
    selection:regular.selectionEligibility.eligibility,
    eligibility:regular.eligibility,
    include:regular.include,
    status:regular.status,
    amount:regular.amount,
    unconfirmed:[...calc.unconfirmedItems],
    best:calc.best?.key || null
  };
}

test('[第2次P1-1] 簡易利用中の未確認・初年度・2年目・不適用届出の各状態は詳細表示OFF→ON→OFFで不変', () => {
  const h = electionToggleHarness();
  const cases = [
    ['unknown','unknown',engine.ELIGIBILITY.UNKNOWN],
    ['first','no',engine.ELIGIBILITY.INELIGIBLE],
    ['second','no',engine.ELIGIBILITY.INELIGIBLE],
    ['free','yes',engine.ELIGIBILITY.ELIGIBLE],
    ['free','no',engine.ELIGIBILITY.INELIGIBLE],
    ['free','unknown',engine.ELIGIBILITY.UNKNOWN]
  ];
  for(const [position,filing,expected] of cases){
    h.element('simpleElectionStatus').value = position;
    h.element('currentDiscontinuanceReady').value = filing;
    const snapshots = [];
    for(const advanced of [false,true,false]){
      h.element('advancedMode').checked = advanced;
      const calc = h.context.calculate();
      snapshots.push(regularChoiceSnapshot(calc));
      assert.equal(snapshots.at(-1).selection,expected,`${position}/${filing}/詳細${advanced}`);
      assert.equal(snapshots.at(-1).amount,-1000000,'計算可能な仮想税額は保持');
      assert.equal(snapshots.at(-1).include,expected === engine.ELIGIBILITY.ELIGIBLE);
      if(expected !== engine.ELIGIBILITY.ELIGIBLE) assert.notEqual(calc.best?.key,'regular');
    }
    assert.deepEqual(snapshots[1],snapshots[0],`${position}/${filing}: 開いただけでは変化しない`);
    assert.deepEqual(snapshots[2],snapshots[0],`${position}/${filing}: 戻しても変化しない`);
  }
  h.element('simpleElectionStatus').value = 'unknown';
  h.element('currentDiscontinuanceReady').value = 'unknown';
  const unknown = h.context.calculate();
  assert.match(unknown.methods.find(method => method.key === 'regular').status,/選択可否未確認/);
  assert.match(unknown.unconfirmedItems.join(''),/適用年数・不適用届出/);
});

test('[第2次P1-1] 簡易利用中で届出位置なしという矛盾は確認待ち、基準期間要件は当期売上で代替しない', () => {
  const h = electionToggleHarness();
  h.element('simpleElectionStatus').value = 'none';
  const conflicted = h.context.calculate();
  assert.equal(conflicted.methods.find(method => method.key === 'regular').selectionEligibility.eligibility,engine.ELIGIBILITY.UNKNOWN);
  assert.match(conflicted.unconfirmedItems.join(''),/適用履歴/);
  h.element('simpleElectionStatus').value = 'first';
  h.element('baseTaxableSales').value = '50,000,001';
  const exception = h.context.calculate();
  assert.equal(exception.methods.find(method => method.key === 'regular').selectionEligibility.eligibility,engine.ELIGIBILITY.ELIGIBLE);
  assert.equal(exception.methods.find(method => method.key === 'simplified').eligibility,engine.ELIGIBILITY.INELIGIBLE);
});

test('[第2次P1-1] 保存復元後も届出の確認状態と選択可否を保持する', () => {
  const h = electionToggleHarness();
  let saved = null;
  Object.assign(h.context, {
    STORAGE_KEY:'test-second-review',
    storageGet:() => saved,
    storageSet:(_key,value) => { saved = value; return true; },
    storageRemove:() => { saved = null; },
    serializeStateIfEnabled:engine.serializeStateIfEnabled,
    migrateSavedState:switchDecision.migrateSavedState,
    foodConfirmationSignatures:{}
  });
  vm.runInContext([functionSource('saveState'),functionSource('restoreState')].join('\n'),h.context);
  h.element('saveToDevice').checked = true;
  h.element('advancedMode').checked = false;
  h.element('simpleElectionStatus').value = 'free';
  h.element('currentDiscontinuanceReady').value = 'unknown';
  const before = regularChoiceSnapshot(h.context.calculate());
  h.context.saveState();
  assert.ok(saved);
  h.element('simpleElectionStatus').value = 'none';
  h.element('currentDiscontinuanceReady').value = 'no';
  h.element('currentReturnMethod').value = 'regular';
  h.element('advancedMode').checked = true;
  h.context.restoreState();
  assert.equal(h.element('currentReturnMethod').value,'simplified');
  assert.equal(h.element('simpleElectionStatus').value,'free');
  assert.equal(h.element('currentDiscontinuanceReady').value,'unknown');
  assert.equal(h.element('advancedMode').checked,false);
  assert.deepEqual(regularChoiceSnapshot(h.context.calculate()),before);
  h.element('advancedMode').checked = true;
  assert.deepEqual(regularChoiceSnapshot(h.context.calculate()),before);
});

test('[第2次P1-1] 当期比較と4期比較の当期行は同じ選択可否を使う', () => {
  const h = electionToggleHarness();
  vm.runInContext(['projectionBaseForIndex','contextWithProjectionBase','projectionSnapshot',
    'calculateProjectionRegular','calculateProjectionMethods'].map(functionSource).join('\n'),h.context);
  const period = {start:'2028-01-01',end:'2028-12-31',label:'2028年分'};
  for(const [position,filing] of [['unknown','unknown'],['first','no'],['second','no'],['free','yes'],['free','no'],['free','unknown']]){
    h.element('simpleElectionStatus').value = position;
    h.element('currentDiscontinuanceReady').value = filing;
    for(const advanced of [false,true]){
      h.element('advancedMode').checked = advanced;
      const calc = h.context.calculate();
      const current = calc.methods.find(method => method.key === 'regular');
      const projection = h.context.calculateProjectionMethods(calc,period,0);
      const periodMethod = projection.methods.find(method => method.key === 'regular');
      assert.equal(projection.selectionEligibility.regular.eligibility,current.selectionEligibility.eligibility,`${position}/${filing}/${advanced}`);
      assert.equal(periodMethod.eligibility,current.eligibility);
      assert.equal(periodMethod.include,current.include);
      assert.equal(periodMethod.amount,current.amount);
    }
  }
});

test('[第2次P1-1] 詳細欄を閉じても保存済み資産・届出・端数の採用状況を帳票で隠さない', () => {
  const h = electionToggleHarness();
  h.context.assessHighAssetForMethod = () => ({status:'restricted',reason:'高額資産の取得制限あり'});
  h.element('advancedMode').checked = false;
  h.element('declarationRounding').checked = true;
  h.element('futureElectionPlan').value = 'yes';
  const calc = h.context.calculate();
  const facts = new Map(h.context.buildAssumptionRows(calc));
  assert.equal(facts.get('将来期の届出計画'),'はい・確認済み');
  assert.equal(facts.get('高額特定資産等'),'高額資産の取得制限あり');
  assert.equal(facts.get('端数処理'),'申告書段階の端数処理を反映');
  h.context.renderCurrentRateComparison(calc);
  assert.match(h.element('comparisonPrintContent').innerHTML,/高額資産の取得制限あり/);
  assert.doesNotMatch(h.element('comparisonPrintContent').innerHTML,/詳細試算未使用/);
});

test('[第2次P2-2] 対象外方式にはCSV仮定による一般的な参考値ラベルを付けない', () => {
  const h = electionToggleHarness();
  h.element('simpleElectionStatus').value = 'first';
  h.element('exemptPurchaseState').value = 'unknown';
  const calc = h.context.calculate();
  assert.equal(calc.comparisonProvisional,true);
  h.context.renderCurrentRateComparison(calc);
  const row = h.element('methodCards').innerHTML.match(/<tr class="method-row[^"]*ineligible"[\s\S]*?<\/tr>/)?.[0];
  assert.ok(row);
  assert.match(row,/適用対象外/);
  assert.doesNotMatch(row,/未確認・仮定を含む参考値|参考 1,000,000円/);
  const detail = h.element('methodCards').innerHTML.match(/<tr class="method-row[^"]*ineligible"[\s\S]*?<\/tr>\s*<tr class="method-trace-row[\s\S]*?<\/tr>/)?.[0];
  assert.ok(detail);
  assert.doesNotMatch(detail,/未確認・仮定を含む参考値/);
  assert.match(h.element('comparisonPrintContent').innerHTML,/適用対象外/);
  h.element('taxScenarioFood1').checked = true;
  h.element('taxScenarioCurrent').checked = false;
  const proposal = h.context.calculate();
  assert.equal(h.context.buildCurrentRateComparison(proposal).rows.find(item => item.key === 'regular').reference,false);
});

test('[F02] 逆転・欠落した課税期間は全方式の比較と4期累計を止め、日付修正で復帰する', () => {
  const h = currentRateComparisonHarness();
  h.element('taxScenarioFood1').checked = false;
  h.element('taxScenarioCurrent').checked = true;
  const normal = h.context.getContext();
  for(const dates of [
    { start:'2028-12-31', end:'2028-01-01' },
    { start:'', end:'2028-12-31' },
    { start:'2028-01-01', end:'' }
  ]){
    const calc = h.context.calculate({ ...normal, ...dates });
    assert.equal(calc.comparisonReady, false);
    assert.ok(calc.inputErrors.some(error => /課税期間/.test(error)));
    assert.equal(calc.best, null);
    assert.ok(calc.methods.every(method => !method.include));
    h.context.renderHero(calc);
    h.context.renderCurrentRateComparison(calc);
    assert.match(h.element('resultHero').innerHTML, /入力エラー/);
    assert.match(h.element('methodCards').innerHTML, /未算定/);
    assert.match(h.element('comparisonPrintContent').innerHTML, /入力エラー\d+件.*未算定/);
    const plan = h.context.calculateProjectionPlan({ ...calc, ctx:{ ...calc.ctx, viewMode:'projection' } });
    assert.equal(plan.optimized.ok, false);
    assert.equal(plan.optimized.cumulative ?? null, null);
  }
  const restored = h.context.calculate(normal);
  assert.equal(restored.comparisonReady, true);
  assert.equal(restored.inputErrors.length, 0);
  assert.ok(restored.methods.some(method => method.include));
});

test('[F03] 免税仕入の未確認は税額を止めず比較全体を参考とし確認済みなしと区別する', () => {
  const h = currentRateComparisonHarness();
  h.element('taxScenarioFood1').checked = false;
  h.element('taxScenarioCurrent').checked = true;
  h.element('exemptPurchaseState').value = 'unknown';
  const unknown = h.context.calculate();
  assert.equal(unknown.comparisonReady, true);
  assert.equal(unknown.comparisonProvisional, true);
  assert.ok(unknown.inputUnconfirmedItems.some(item => /免税事業者等/.test(item)));
  assert.equal(unknown.methods.find(method => method.key === 'regular').reference, true);
  h.context.renderCurrentRateComparison(unknown);
  assert.match(h.element('comparisonPrintContent').innerHTML, /免税事業者等仕入の確認.*未確認/);
  h.element('exemptPurchaseState').value = 'no';
  const checked = h.context.calculate();
  assert.equal(checked.inputUnconfirmedItems.length, 0);
  assert.equal(checked.comparisonProvisional, false);
  h.context.renderCurrentRateComparison(checked);
  assert.match(h.element('comparisonPrintContent').innerHTML, /なし・確認済み/);
});

test('[F04] 過去年のCSV元範囲は対象期変更後も再評価し帳票に残る', () => {
  const h = currentRateComparisonHarness();
  h.element('taxScenarioFood1').checked = false;
  h.element('taxScenarioCurrent').checked = true;
  h.context.importedCsvOrigin = {
    dateRange:{start:'2025-01-15',end:'2025-02-15'},
    effectiveDateRange:{start:'2025-01-15',end:'2025-02-15'},
    rowCount:2,mappedEntries:2,manualChanged:false
  };
  const future = h.context.calculate();
  assert.equal(future.comparisonReady,true);
  assert.equal(future.csvOriginReference,true);
  assert.match(future.csvOriginText,/2025-01-15〜2025-02-15.*2028-01-01〜2028-12-31.*参考試算/);
  h.context.renderCurrentRateComparison(future);
  assert.match(h.element('comparisonPrintContent').innerHTML,/2025-01-15〜2025-02-15/);
  h.element('periodStart').value = '2025-01-01';
  h.element('periodEnd').value = '2025-12-31';
  const samePeriod = h.context.calculate();
  assert.equal(samePeriod.csvOriginReference,false);
  assert.match(samePeriod.csvOriginText,/2025-01-01〜2025-12-31/);
  h.context.importedCsvOrigin.manualChanged = true;
  const amended = h.context.calculate();
  assert.equal(amended.csvOriginReference,true);
  assert.match(amended.csvOriginText,/手修正/);
});

test('[現行差額13] 非有限な税額を差額や0円へ変換せず未算定で表示する', () => {
  const h = currentRateComparisonHarness();
  const calc = h.context.calculate();
  calc.methods.find(method => method.key === 'simplified').amount = NaN;
  calc.methods.find(method => method.key === 'special3').amount = Infinity;
  const comparison = h.context.buildCurrentRateComparison(calc);
  for(const key of ['simplified','special3']){
    const row = comparisonRow(comparison, key);
    assert.equal(typeof row.currentAmount, 'number');
    assert.equal(row.proposalAmount, null);
    assert.equal(row.difference, null);
  }
  h.context.renderCurrentRateComparison(calc);
  const rendered = h.element('methodCards').innerHTML;
  assert.match(rendered, /未算定/);
  assert.doesNotMatch(rendered, /NaN|Infinity/);
});

test('[r27一覧01] 四方式を一つの表に並べ、その金額列を現行税率と食品1％の比較に共用する', () => {
  const h = currentRateComparisonHarness();
  const calc = h.context.calculate();
  const comparison = h.context.buildCurrentRateComparison(calc);
  h.context.renderCurrentRateComparison(calc);
  const markup = h.element('methodCards').innerHTML;
  const rows = [...markup.matchAll(/<tr\b[^>]*class="method-row(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1]);
  assert.equal(rows.length,4);
  assert.equal((markup.match(/class="method-trace-row no-print"/g) || []).length,4);
  assert.equal((markup.match(/<details[^>]*data-method=/g) || []).length,4);
  assert.doesNotMatch(markup, /<article|class="[^"]*\bmethod-card\b|class="bar/);
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:\s|=|>)/);
  for(const [index,row] of comparison.rows.entries()){
    for(const [column,value] of [['current',row.currentAmount],['proposal',row.proposalAmount],['difference',row.difference]]){
      const match = rows[index].match(new RegExp(`<td[^>]*data-column="${column}"[^>]*>([\\s\\S]*?)<\\/td>`));
      assert.ok(match,`${row.key} ${column} 金額列がある`);
      assert.match(match[1],new RegExp(Math.abs(Math.round(value)).toLocaleString('ja-JP')+'円'));
      assert.doesNotMatch(match[0], /no-print/, '現行税率と差額も専用帳票で再利用できる');
    }
    assert.match(rows[index],new RegExp(h.context.METHOD_LABELS[row.key]));
  }
  assert.equal((html.match(/id="methodComparisonTable"/g) || []).length,1);
  assert.doesNotMatch(html, /id="currentRateComparison(?:Panel|Rows)"/);
  const updateSource=functionSource('update');
  assert.match(updateSource,/renderCurrentRateComparison\(calc\)/);
  assert.doesNotMatch(updateSource,/renderMethodCards\(calc\)/);
  vm.runInContext(functionSource('renderSummary'),h.context);
  h.context.renderSummary(calc);
  const summary=h.element('taxSummary').innerHTML;
  assert.match(html,/<tbody[^>]*id="taxSummary"/);
  assert.match(summary,/<th scope="row">売上税額<\/th><td>10,000円<\/td>/);
  assert.match(summary,/<th scope="row">仕入税額<\/th><td>5,000円<\/td>/);
  assert.doesNotMatch(summary,/summary-item|class="[kv]"/);
});

test('[r28印刷01] 通常3列・食品5列に絞り、専用帳票は画面と同じ四方式の金額・差額を使う', () => {
  const h = currentRateComparisonHarness();
  const rowMarkup = markup => [...markup.matchAll(/<tr\b[^>]*class="method-row(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/tr>/g)].map(match => match[0]);
  for(const scenario of ['current','foodProposal']){
    h.element('taxScenarioCurrent').checked = scenario === 'current';
    h.element('taxScenarioFood1').checked = scenario === 'foodProposal';
    const calc = h.context.calculate();
    const before = JSON.stringify(calc);
    h.context.renderCurrentRateComparison(calc);
    const screen = h.element('methodCards').innerHTML;
    const print = h.element('comparisonPrintContent').innerHTML;
    const rows = rowMarkup(screen);
    assert.equal(rows.length, 4);
    assert.deepEqual(rowMarkup(print), rows, '印刷税額は同じHTML行を再利用し計算し直さない');
    assert.equal((h.element('methodComparisonHead').innerHTML.match(/<th\b/g) || []).length, scenario === 'current' ? 3 : 5);
    for(const row of rows){
      assert.equal((row.match(/<(?:td|th)\b/g) || []).length, scenario === 'current' ? 3 : 5);
      assert.doesNotMatch(row, /class="method-conditions"|計算方法:/);
    }
    assert.match(screen, new RegExp(`colspan="${scenario === 'current' ? 3 : 5}"`));
    assert.match(screen, /計算過程を見る/);
    assert.doesNotMatch(print, /calculation-trace|trace-body|計算過程を見る/);
    assert.match(print, /2028-01-01|2028\/01\/01/);
    assert.match(print, /申告|参考/);
    for(const method of calc.methods) assert.ok(print.includes(h.context.escapeHtml(method.calculationMethod)), `${method.key} の計算方法を残す`);
    if(scenario === 'foodProposal'){
      assert.match(print, /40,000円/);
      assert.match(print, /5,000円/);
      assert.match(print, /35,000円/);
      assert.match(print, /減少/);
      assert.match(print, /大綱|未施行/);
    }else assert.doesNotMatch(print, /data-column="(?:current|difference)"/);
    assert.equal(JSON.stringify(calc), before);
  }
});

test('[r28印刷02] 帳票も還付・未算定・適用対象外・未確認を0円や確認済みに変えない', () => {
  const h = currentRateComparisonHarness();
  h.element('taxScenarioCurrent').checked = true;
  h.element('taxScenarioFood1').checked = false;
  const calc = h.context.calculate();
  Object.assign(calc.methods[0], { amount:-12345 });
  Object.assign(calc.methods[1], { amount:null });
  Object.assign(calc.methods[2], { amount:87654, eligibility:engine.ELIGIBILITY.INELIGIBLE, status:'適用対象外' });
  Object.assign(calc.methods[3], { amount:23456, eligibility:engine.ELIGIBILITY.UNKNOWN, status:'未確認' });
  h.context.renderCurrentRateComparison(calc);
  const print = h.element('comparisonPrintContent').innerHTML;
  const rows = [...print.matchAll(/<tr\b[^>]*class="method-row(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1]);
  assert.match(rows[0], /還付見込/);
  assert.match(rows[0], /-12,345円|−12,345円|△ 12,345円/);
  assert.match(rows[1], /未算定/);
  assert.doesNotMatch(rows[1], />0円</);
  assert.match(rows[2], /適用対象外/);
  assert.doesNotMatch(rows[2], /87,654円/);
  assert.match(rows[3], /未確認|参考/);
  assert.match(rows[3], /23,456円/);
  assert.doesNotMatch(rows[3], /確認済み|class="method-row best/);
});

test('[r27一覧02] 税率切替と金額更新も同じ表を再描画し、計算過程の開閉とフォーカスを保持する', () => {
  const h = currentRateComparisonHarness();
  const priorDetail = { open:true, dataset:{ method:'regular' } };
  let focusCount=0;
  h.context.document.querySelectorAll=()=>[priorDetail];
  h.context.document.activeElement={closest:()=>priorDetail};
  h.element('methodCards').querySelector=()=>({focus(){focusCount++;}});
  h.context.renderCurrentRateComparison(h.context.calculate());
  assert.match(h.element('methodCards').innerHTML, /data-method="regular" open/);
  assert.match(h.element('methodCards').innerHTML, /data-column="difference"/);
  assert.equal(focusCount,1);
  h.element('taxScenarioFood1').checked=false;
  h.element('taxScenarioCurrent').checked=true;
  h.context.renderCurrentRateComparison(h.context.calculate());
  assert.match(h.element('methodCards').innerHTML, /data-method="regular" open/);
  assert.doesNotMatch(h.element('methodCards').innerHTML, /data-column="(?:current|difference)"/);
  assert.equal(h.element('currentRateComparisonNotes').innerHTML,'');
  assert.equal(focusCount,2);
  h.element('type2Sale8').value='2160000';
  const current=h.context.calculate();
  h.context.renderCurrentRateComparison(current);
  assert.equal(current.methods.find(method=>method.key==='regular').amount,120000);
  assert.match(h.element('methodCards').innerHTML,/120,000円/);
  priorDetail.open=false;
  h.context.document.activeElement=null;
  h.element('taxScenarioFood1').checked=true;
  h.element('taxScenarioCurrent').checked=false;
  h.context.renderCurrentRateComparison(h.context.calculate());
  assert.match(h.element('methodCards').innerHTML, /data-column="difference"/);
  assert.doesNotMatch(h.element('methodCards').innerHTML, /data-method="regular" open/);
  assert.equal(focusCount,3);
});

test('[概算UI01] 問題明細・未分類売上でも主ボタンから進め、正常CSVには追加確認がない', () => {
  for(const source of [recoveryFixture(), csv([csvRow({rate:'10', business:'', amount:1100000})])]){
    const h = harness(source);
    vm.runInContext(['sumRateAmounts','importedTaxableSalesTotal','importedExemptPurchaseTotal','importBusinessOptions','renderJournalImport'].map(functionSource).join('\n'), h.context);
    h.context.renderJournalImport();
    assert.equal(h.element('applyJournalImportBtn').disabled, false);
    assert.equal(h.element('applyJournalImportBtn').textContent, '仮定を置いて概算へ進む');
    assert.match(h.element('journalImportStatus').innerHTML, /すべての明細を直さなくても/);
  }
  const normal = harness(csv([csvRow({rate:'10', amount:1100000})]));
  normal.context.window.confirm = () => { throw new Error('正常CSVでは確認を増やさない'); };
  normal.context.applyJournalImport();
  assert.equal(normal.context.workflowStep, 2);
  assert.equal(normal.element('type2Sale10').value, '1,100,000');
});

test('[概算UI02] 税率不明は一度確認して10％を仮定し89000円、原文と手動判断は変更しない', () => {
  const h = harness(recoveryFixture());
  installCurrentCalculation(h);
  let count = 0;
  h.context.window.confirm = message => {
    count++;
    if(count === 1){ assert.match(message, /税率10％を仮定/); assert.match(message, /11000円/); }
    else { assert.match(message, /現在の金額入力を置き換える/); assert.match(message, /今回CSV/); }
    return true;
  };
  const original = JSON.stringify(h.context.pendingJournalImport.analysis);
  h.context.applyJournalImport();
  const calc = h.context.calculate();
  assert.equal(count, 1);
  assert.equal(calc.regular.amount, 89000);
  assert.equal(calc.purchases.invoiceTax, 11000);
  assert.equal(calc.csvRecovery.assumedDetailCount, 1);
  assert.equal(calc.csvRecovery.correctedCount, 0);
  assert.equal(calc.csvRecovery.temporaryExcludedCount, 0);
  assert.equal(calc.csvPartial, true);
  assert.equal(JSON.stringify(h.context.pendingJournalImport.analysis), original);
  assert.equal(Object.keys(h.context.pendingJournalImport.decisions).length, 0);
  const regular = calc.methods.find(method => method.key === 'regular');
  for(const output of [h.context.buildSummaryText(calc),h.context.buildCsvText(calc),h.context.renderCalculationTrace(calc,regular)]){
    assert.match(output, /税率10％を仮定/);
    assert.doesNotMatch(output, /内部科目SECRET/);
  }
  assert.match(h.context.buildAssumptionRows(calc).find(row => row[0] === '未確認事項')[1], /CSVの仮定/);
  h.context.renderHero(calc);
  assert.match(h.element('resultHero').innerHTML, /CSVに仮定/);
  const id = h.context.pendingJournalImport.analysis.problemEntries[0].id;
  h.context.updateJournalRecovery(id,'action','correct');
  h.context.updateJournalRecovery(id,'rate','10');
  h.context.applyJournalImport();
  assert.equal(count,2,'再反映で既存入力を置換するときは別途確認する');
  const corrected = h.context.calculate();
  assert.equal(corrected.regular.amount, 89000);
  assert.equal(corrected.csvPartial, false);
  assert.equal(corrected.csvRecovery.correctedCount, 1);
});

test('[概算UI03] 未分類売上を失わず第6種へ仮置きし、実際の選択で前提と税額を更新する', () => {
  const h = harness(csv([csvRow({rate:'10',business:'',account:'PRIVATE業務',amount:1100000})]));
  installCurrentCalculation(h);
  h.context.applyJournalImport();
  let calc = h.context.calculate();
  assert.equal(h.element('type6Sale10').value, '1,100,000');
  assert.equal(calc.sales.totalTax, 100000);
  assert.equal(calc.methods.find(method => method.key === 'simplified').amount, 60000);
  assert.equal(calc.csvPartial, true);
  assert.match(calc.csvRecoveryText, /第6種.*40％/);
  assert.doesNotMatch(calc.csvRecoveryText, /PRIVATE/);
  const key = h.context.pendingJournalImport.analysis.unclassifiedSales[0].key;
  assert.equal(h.context.journalImportMappings[key], undefined);
  h.context.journalImportMappings[key] = 'type2';
  h.context.applyJournalImport();
  calc = h.context.calculate();
  assert.equal(h.element('type6Sale10').value, '');
  assert.equal(calc.methods.find(method => method.key === 'simplified').amount, 20000);
  assert.equal(calc.csvPartial, false);
});

test('[概算UI04] 仮定確認のキャンセルは現在値・反映済み前提・補正内容を一切変えない', () => {
  const h = harness(recoveryFixture());
  h.element('purchase10').value = '123,456';
  h.context.importedCsvRecovery = {temporaryExcludedCount:2};
  const pending = JSON.stringify(h.context.pendingJournalImport);
  h.context.window.confirm = () => false;
  h.context.applyJournalImport();
  assert.equal(h.element('purchase10').value, '123,456');
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 2);
  assert.equal(JSON.stringify(h.context.pendingJournalImport), pending);
  assert.equal(h.context.appliedJournalImport, null);
  assert.equal(h.context.workflowStep, 1);
});

test('[概算UI05] 負の仕入集計は明示0円仮置きと用途別税額が一致し参考状態になる', () => {
  const h = harness(csv([
    csvRow({rate:'10',amount:1100000}),
    csvRow({side:'借方',code:'5',rate:'10',amount:110000}),
    csvRow({side:'貸方',code:'51',rate:'10',amount:220000})
  ]));
  installCurrentCalculation(h);
  h.context.applyJournalImport();
  const calc = h.context.calculate();
  assert.equal(h.element('purchase10').value, '0');
  assert.equal(h.element('taxableOnlyPurchaseTax').value, '0');
  assert.equal(calc.purchases.invoiceTax, 0);
  assert.equal(calc.regular.amount, 100000);
  assert.equal(calc.csvPartial, true);
  assert.match(calc.csvRecoveryText, /-110000円→0円/);
  assert.equal(calc.csvRecovery.negativeBucketCount, 1);
});

test('[概算UI06] 読めない売上は未入力のまま、明示した負売上の0円仮置きと区別する', () => {
  const unknown = harness(csv([csvRow({rate:'10',amount:'不明'})]));
  installCurrentCalculation(unknown);
  unknown.context.applyJournalImport();
  let calc = unknown.context.calculate();
  assert.equal(unknown.context.workflowStep, 2);
  assert.equal(calc.comparisonReady, false);
  assert.equal(calc.csvRecovery.unknownAmountCount, 1);
  assert.match(unknown.context.renderCalculationTrace(calc,calc.methods[0]), /仮除外1明細/);
  const negative = harness(csv([csvRow({side:'借方',code:'11',rate:'10',amount:11000})]));
  installCurrentCalculation(negative);
  negative.context.applyJournalImport();
  calc = negative.context.calculate();
  assert.equal(negative.element('type2Sale10').value, '0');
  assert.equal(calc.salesEntryRequired, false);
  assert.equal(calc.csvPartial, true);
});

test('[概算UI07] 負の明示1％は自動0円化せず入力を保持して手入力経路を案内する', () => {
  const h = harness(csv([csvRow({side:'借方',code:'11',rate:'1',amount:1010})]));
  h.element('type2Sale10').value = '555';
  h.context.window.confirm = () => { throw new Error('不正な推測を反映しない'); };
  h.context.applyJournalImport();
  assert.equal(h.element('type2Sale10').value,'555');
  assert.equal(h.context.importedCsvRecovery,null);
  assert.match(h.element('journalImportStatus').textContent,/明示1％.*手入力して進む/);
});

test('[概算UI08] 仮定のみでも顧客出力・印刷・未算定の計算過程へ前提を保持する', () => {
  const {h,calc} = switchCase();
  const estimate = journal.prepareEstimatedImport(recoveryFixture());
  calc.csvPartial = true;
  calc.csvRecovery = h.context.normalizeCsvRecovery(estimate.recoverySummary);
  calc.csvRecoveryText = h.context.csvRecoverySummaryText(calc.csvRecovery);
  const decision = h.context.calculateSwitchDecision(calc);
  assert.equal(decision.confirmed,false);
  h.context.renderSwitchDecision(calc,decision);
  for(const output of [h.context.customerDecisionText(decision.customer),h.context.customerDecisionCsv(decision.customer),h.element('customerPrintReport').innerHTML]){
    assert.match(output,/税率10％を仮定/);
    assert.doesNotMatch(output,/内部科目SECRET/);
  }
  decision.economics.errors = ['テスト用未算定'];
  assert.match(h.context.renderSwitchBreakdown(calc,decision), /税率10％を仮定/);
});

test('[C03-C16] 税率補正はプレビューだけでは入力を変えず反映後本則89000円・再反映も同額', () => {
  const h = harness(recoveryFixture());
  installCurrentCalculation(h);
  h.element('purchase10').value = '777';
  const id = h.context.pendingJournalImport.analysis.problemEntries[0].id;
  h.context.updateJournalRecovery(id, 'action', 'correct');
  h.context.updateJournalRecovery(id, 'rate', '10');
  assert.equal(h.element('purchase10').value, '777');
  assert.equal(h.context.importedCsvRecovery, null);
  h.context.applyJournalImport();
  let calc = h.context.calculate();
  assert.equal(calc.purchases.amount10, 121000);
  assert.equal(calc.purchases.invoiceTax, 11000);
  assert.equal(calc.regular.amount, 89000);
  assert.equal(h.context.importedCsvRecovery.correctedCount, 1);
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 0);
  h.context.applyJournalImport();
  calc = h.context.calculate();
  assert.equal(calc.purchases.amount10, 121000);
  assert.equal(calc.regular.amount, 89000);
  assert.match(h.context.pendingJournalImport.sourceText, /不明/);
});

test('CSV免税仕入の返品・値引きは個別操作なしで純額試算し、画面・コピー・CSV・印刷に前提を残す', () => {
  const source = csv([
    csvRow({date:'2025/01/15',rate:'10',business:'5',amount:11000000}),
    csvRow({date:'2025/01/15',side:'借方',code:'52',rate:'10',amount:1100000,credit:'80'}),
    csvRow({date:'2025/02/09',side:'貸方',code:'52',rate:'10',amount:20000,credit:'80'}),
    csvRow({date:'2025/02/28',side:'貸方',code:'52',rate:'10',amount:500,credit:'80'}),
    csvRow({date:'2025/12/31',side:'貸方',code:'52',rate:'10',amount:30000,credit:'80'})
  ]);
  const h = harness(source);
  installCurrentCalculation(h);
  Object.assign(h.context, {
    entryMode:'rows',
    taxEntryRows:{sales:[],purchases:[]},
    rowCsvKnownZeros:{},rowsFromJournalAnalysis,
    newTaxEntry:side => taxRows.createTaxEntryRow(side,{id:`blank-${side}`}),
    renderTaxEntryRows(){},document:{...h.context.document,body:{dataset:{}}}
  });
  h.element('periodStart').value = '2025-01-01';
  h.element('periodEnd').value = '2025-12-31';
  assert.equal(h.context.pendingJournalImport.analysis.problemEntries.length,0);
  h.context.applyJournalImport();
  const aggregate = taxRows.aggregateTaxRows(h.context.taxEntryRows);
  h.context.latestTaxRowAggregate = aggregate;
  for(const [id,state] of Object.entries(aggregate.fields)) h.element(id).value = state.entered ? String(state.value) : '';
  for(const id of ['nonTaxableSales','purchase10','purchase8']) if(h.context.rowCsvKnownZeros[id]) h.element(id).value = '0';
  const calc = h.context.calculate();
  const netPurchase = 1100000 - 20000 - 500 - 30000;
  assert.equal(h.context.taxEntryRows.purchases.find(row => row.code === '52').amount,String(netPurchase));
  assert.equal(calc.purchases.purchaseRatioConflicts.length,0);
  assert.ok(Math.abs(calc.regular.amount - (1000000 - engine.taxFromAmount(netPurchase,10,'included') * .8)) < 1e-7,
    `本則税額の実測 ${calc.regular.amount}`);
  assert.equal(calc.csvRecovery.nettedExemptAdjustmentCount,3);
  assert.equal(calc.csvPartial,true);
  assert.equal(calc.methods.find(method => method.key === 'regular').include,true);
  h.context.renderPrintAssumptions(calc);
  for(const output of [calc.csvRecoveryText,h.context.buildSummaryText(calc),h.context.buildCsvText(calc),h.element('printAssumptions').innerHTML]){
    assert.match(output,/返品・値引き等3明細/);
    assert.match(output,/元取引.*照合していない/);
  }
  h.context.renderHero(calc);
  assert.match(h.element('csvRecoveryNotice').innerHTML,/参考試算.*返品・値引き等/);
});

test('[C04-C19-C20] 仮除外で本則90000円を参考表示し通常出力・計算過程に中立的要約を残す', () => {
  const h = harness(recoveryFixture());
  installCurrentCalculation(h);
  let confirmation = '';
  h.context.window.confirm = text => { confirmation = text; return true; };
  h.context.excludeUnresolvedJournalEntries();
  assert.match(confirmation, /1明細/);
  assert.match(confirmation, /11000円|11,000円/);
  const calc = h.context.calculate();
  assert.equal(calc.purchases.amount10, 110000);
  assert.equal(calc.regular.amount, 90000);
  assert.equal(calc.csvPartial, true);
  assert.equal(calc.csvRecovery.temporaryExcludedCount, 1);
  assert.equal(calc.csvRecovery.excludedAbsAmount, 11000);
  h.context.renderHero(calc);
  assert.match(h.element('resultHero').innerHTML, /参考/);
  assert.doesNotMatch(h.element('resultHero').innerHTML, /最少|最有利|確認できている方式/);
  const regular = calc.methods.find(method => method.key === 'regular');
  const outputs = [h.context.buildSummaryText(calc), h.context.buildCsvText(calc), h.context.renderCalculationTrace(calc, regular)];
  h.context.renderPrintAssumptions(calc);
  outputs.push(h.element('printAssumptions').innerHTML);
  for(const output of outputs){
    assert.match(output, /仮除外1明細/);
    assert.match(output, /11000円|11,000円/);
    assert.match(output, /税額影響.*未算定/);
    assert.doesNotMatch(output, /内部科目SECRET/);
  }
  h.element('purchase10').value = '999,999';
  assert.equal(h.context.calculate().csvRecovery.temporaryExcludedCount, 1);
});

test('[C05-C19] 一括除外は補正済みを残し取消し・再補正は明示反映まで旧結果を維持する', () => {
  const sourceText = csv([
    csvRow({ rate:'10', amount:1100000 }),
    ...[11000,22000,33000].map(amount => csvRow({ side:'借方', code:'5', rate:'不明', amount }))
  ]);
  const h = harness(sourceText);
  const ids = h.context.pendingJournalImport.analysis.problemEntries.map(entry => entry.id);
  h.context.updateJournalRecovery(ids[0], 'action', 'correct');
  h.context.updateJournalRecovery(ids[0], 'rate', '10');
  h.context.excludeUnresolvedJournalEntries();
  assert.equal(h.element('purchase10').value, '11,000');
  assert.equal(h.context.importedCsvRecovery.correctedCount, 1);
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 2);
  assert.equal(h.context.importedCsvRecovery.excludedAbsAmount, 55000);
  h.context.updateJournalRecovery(ids[1], 'action', 'correct');
  h.context.updateJournalRecovery(ids[1], 'rate', '10');
  assert.equal(h.element('purchase10').value, '11,000');
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 2);
  h.context.applyJournalImport();
  assert.equal(h.element('purchase10').value, '33,000');
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 1);
  h.context.updateJournalRecovery(ids[1], 'action', '');
  assert.equal(h.context.pendingJournalImport.analysis.recoverySummary.unresolvedCount, 1);
  h.context.applyJournalImport();
  assert.equal(h.element('purchase10').value, '33,000');
});

test('[C17-C19-C21] 新CSVのプレビューと一括除外取消しは現在の入力・除外前提を変えない', () => {
  const h = harness(recoveryFixture());
  h.context.excludeUnresolvedJournalEntries();
  const applied = JSON.stringify(h.context.importedCsvRecovery);
  const prior = h.element('purchase10').value;
  const other = recoveryFixture().replace('11000"', '22000"');
  h.context.pendingJournalImport = { sourceText:other, decisions:{}, analysis:journal.analyzeTkcJournalText(other), applied:false };
  h.context.window.confirm = () => false;
  h.context.excludeUnresolvedJournalEntries();
  assert.equal(h.element('purchase10').value, prior);
  assert.equal(JSON.stringify(h.context.importedCsvRecovery), applied);
  assert.equal(Object.keys(h.context.pendingJournalImport.decisions).length, 0);
  const normal = csv([csvRow({ rate:'10', amount:2200000 })]);
  h.context.pendingJournalImport = { sourceText:normal, decisions:{}, analysis:journal.analyzeTkcJournalText(normal), applied:false };
  assert.equal(JSON.stringify(h.context.importedCsvRecovery), applied);
  h.context.window.confirm = () => true;
  h.context.applyJournalImport();
  assert.equal(h.context.importedCsvRecovery?.temporaryExcludedCount || 0, 0);
  assert.equal(h.element('type2Sale10').value, '2,200,000');
});

test('[C14-C20-C21] 問題明細はエスケープ表示し金額不明件数を除外要約へ保持する', () => {
  const h = harness(csv([
    csvRow({ rate:'10', amount:1100000 }),
    csvRow({ side:'借方', code:'9', account:'<img src=x onerror=alert(1)>', rate:'不明', amount:'金額不明<script>' })
  ]));
  h.context.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[character]));
  const preview = h.context.renderJournalRecovery(h.context.pendingJournalImport.analysis);
  assert.match(preview, /&lt;img/);
  assert.doesNotMatch(preview, /<img|<script>/);
  assert.match(preview, /未処理/);
  assert.equal(h.context.pendingJournalImport.analysis.problemEntries.length, 1);
  h.context.excludeUnresolvedJournalEntries();
  const summary = h.context.csvRecoverySummaryText(h.context.importedCsvRecovery);
  assert.match(summary, /仮除外1明細/);
  assert.match(summary, /金額不明1明細/);
  assert.match(summary, /税額影響.*未算定/);
  assert.doesNotMatch(summary, /img|script|alert/);
});

test('[C12] 1％へ補正した返品は明示実績と元取引確認を維持し除外後だけ実績から外す', () => {
  const h = harness(csv([
    csvRow({ rate:'10', amount:1100000 }),
    csvRow({ side:'借方', code:'5', rate:'1', amount:10100 }),
    csvRow({ side:'貸方', code:'51', rate:'不明', amount:1010 })
  ]));
  const id = h.context.pendingJournalImport.analysis.problemEntries[0].id;
  h.context.updateJournalRecovery(id, 'action', 'correct');
  h.context.updateJournalRecovery(id, 'rate', '1');
  h.context.applyJournalImport();
  assert.equal(h.element('taxScenarioFood1').checked, true);
  assert.equal(h.context.importedActualOnePercent.entries.length, 2);
  const period = { taxScenario:'foodProposal', start:'2028-01-01', end:'2028-12-31' };
  let review = h.context.validateImportedOnePercentEntries(period);
  assert.equal(review.errors.length, 0);
  assert.equal(review.adjustmentCount, 1);
  assert.equal(h.context.importedActualOnePercent.entries[1].transactionKind, 'adjustment');
  assert.equal(h.context.importedActualOnePercent.entries[1].amount, -1010);
  assert.equal(h.context.validateImportedOnePercentEntries({ ...period, end:'2028-01-01' }).errors.length, 2);
  h.context.updateJournalRecovery(id, 'action', 'exclude');
  assert.equal(h.context.importedActualOnePercent.entries.length, 2);
  h.context.applyJournalImport();
  assert.equal(h.context.importedActualOnePercent.entries.length, 1);
  review = h.context.validateImportedOnePercentEntries(period);
  assert.equal(review.adjustmentCount, 0);
  assert.equal(h.element('proposalFoodClassificationState').value, 'unknown');
  assert.equal(h.context.importedCsvRecovery.temporaryExcludedCount, 1);
});

test('[C20] 部分集計の任意費用比較と顧客出力は除外前提を残し確認済み提案にしない', () => {
  const { h, calc } = switchCase();
  calc.csvPartial = true;
  calc.csvRecovery = { correctedCount:1, temporaryExcludedCount:2, confirmedExcludedCount:0,
    excludedAbsAmount:33000, unknownAmountCount:0, unresolvedCount:0 };
  calc.csvRecoveryText = h.context.csvRecoverySummaryText(calc.csvRecovery);
  const decision = h.context.calculateSwitchDecision(calc);
  assert.equal(decision.confirmed, false);
  assert.equal(decision.plannedConfirmed, false);
  assert.match(decision.customer.comparisonNotice, /参考比較/);
  assert.doesNotMatch(decision.customer.suggestion, /有利|おすすめ/);
  h.context.renderSwitchDecision(calc, decision);
  const outputs = [h.context.customerDecisionText(decision.customer),
    h.context.customerDecisionCsv(decision.customer), h.element('customerPrintReport').innerHTML,
    h.context.renderSwitchBreakdown(calc, decision)];
  for(const output of outputs){
    assert.match(output, /仮除外2明細/);
    assert.match(output, /33000円|33,000円/);
    assert.match(output, /税額影響.*未算定/);
    assert.doesNotMatch(output, /元帳.*相談してください/);
  }
  assert.equal(h.element('copyCustomerDecisionBtn').disabled, false);
});

function switchCase(){
  const h = harness(csv([csvRow({ rate:'8', amount:1080000 })]));
  h.element('switchFoodSalesState').value = 'yes';
  h.element('switchSimplifiedAppliedState').value = 'yes';
  h.element('switchNoOtherRestrictionsState').value = 'yes';
  h.element('switchFilingStatus').value = 'filed';
  h.element('switchFilingDate').value = '2027-06-15';
  h.element('currentReturnMethod').value = 'simplified';
  h.element('exemptPurchaseState').value = 'no';
  h.element('switchAdditionalFee').value = '0';
  h.element('switchFeeTaxBasis').value = 'included';
  h.element('switchOtherCostsNone').checked = true;
  h.element('switchCreditState').value = 'unknown';
  const calc = {
    ctx:{ ...h.ctx, start:'2027-01-01', end:'2027-12-31', taxScenarioLabel:'食品1％の未施行試算', proposalFoodClassificationState:'none', proposalPurchaseClassificationState:'none' },
    methods:[{ key:'simplified', amount:40000, eligible:true }, { key:'regular', amount:-225000, eligible:true }],
    comparisonReady:true
  };
  return { h, calc };
}

test('[A01] 売上のみCSVの0集計は免税仕入なしと矛盾しない', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.context.applyJournalImport();
  h.element('exemptPurchaseState').value = 'no';
  const purchases = h.context.collectPurchases(h.ctx);
  assert.equal(h.context.importedExemptTransactionCount, 0);
  assert.equal(h.element('exemptPurchase80_8').value, '');
  assert.equal(purchases.errors.length, 0);
});

test('[R03-R09] CSV反映は本則方式と詳細オフを保持し、基本条件から個別対応を計算する', () => {
  const h = harness(csv([
    csvRow({ rate:'10', amount:8800000 }),
    csvRow({ code:'3', rate:'0', amount:2000000 }),
    csvRow({ side:'借方', account:'仕入', code:'5', rate:'10', amount:3300000 }),
    csvRow({ side:'借方', account:'共通経費', code:'7', rate:'10', amount:2200000 })
  ]));
  h.element('regularDetailMethod').value = 'individual';
  h.element('advancedMode').checked = false;
  h.element('currentReturnMethod').value = 'simplified';
  h.context.applyJournalImport();
  assert.equal(h.element('regularDetailMethod').value, 'individual');
  assert.equal(h.element('advancedMode').checked, false);
  assert.equal(h.element('currentReturnMethod').value, 'simplified');
  Object.assign(h.context, { viewModeKey:() => 'single',
    calculateDetailedRegular:engine.calculateDetailedRegular });
  vm.runInContext(['getContext', 'periodMonthsForAnnualization', 'calculateRegularForContext',
    'detailedRegularEligibility', 'regularMethodLabel'].map(functionSource).join('\n'), h.context);
  const ctx = h.context.getContext();
  const sales = h.context.collectSales(ctx);
  const purchases = h.context.collectPurchases(ctx);
  const result = h.context.calculateRegularForContext(ctx, sales, purchases);
  assert.equal(ctx.nonTaxableSales, 2000000);
  assert.equal(ctx.taxableOnlyPurchaseTax, 300000);
  assert.equal(ctx.commonPurchaseTax, 200000);
  assert.equal(ctx.advancedMode, false);
  assert.equal(result.appliedMethod, 'individual');
  assert.equal(result.taxableSalesRatio, .8);
  assert.equal(result.regularCredit, 460000);
  assert.equal(result.amount, 340000);
  h.element('commonPurchaseTax').value = '100000';
  const editedCtx = h.context.getContext();
  const edited = h.context.calculateRegularForContext(editedCtx, sales, purchases);
  assert.equal(edited.amount, 420000);
  assert.equal(h.element('advancedMode').checked, false);
});

test('[R10-R11] 本則未算定を任意費用比較・顧客コピーCSV印刷で0円に変換しない', () => {
  const { h, calc } = switchCase();
  calc.methods.find(method => method.key === 'regular').amount = null;
  calc.methods.find(method => method.key === 'regular').eligible = false;
  const decision = h.context.calculateSwitchDecision(calc);
  assert.equal(decision.economics.periodCount, 0);
  assert.equal(decision.economics.cashBenefitDisplay, null);
  assert.equal(decision.customer.planBTax, null);
  assert.equal(decision.customer.taxBenefit, null);
  assert.equal(decision.confirmed, false);
  h.context.renderSwitchDecision(calc, decision);
  assert.match(h.element('switchCustomerComparison').innerHTML, /B案：一般課税へ切替.*?未算定/s);
  const text = h.context.customerDecisionText(decision.customer);
  const csvText = h.context.customerDecisionCsv(decision.customer);
  assert.match(text, /一般課税.*未算定/);
  assert.match(csvText, /一般課税.*未算定/);
  assert.match(h.element('customerPrintReport').innerHTML, /一般課税.*?未算定/s);
});

test('[A02][A04] 正額または不正文字列の免税仕入を「なし」で隠さない', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.context.applyJournalImport();
  h.element('exemptPurchase50_8').value = '1080';
  h.element('exemptPurchaseState').value = 'no';
  assert.match(h.context.collectPurchases(h.ctx).errors.join(' '), /期間別内訳/);
  assert.equal(h.element('exemptPurchase50_8').value, '1080');
  h.element('exemptPurchase50_8').value = '不明';
  const invalid = h.context.collectPurchases(h.ctx).errors.join(' ');
  assert.match(invalid, /期間別内訳/);
  assert.match(invalid, /数値/);
});

test('[A03] 免税仕入と返品の純額0はCSV反映後も対象仕訳ありを保持する', () => {
  const h = harness(csv([
    csvRow({ side:'借方', account:'免税仕入', code:'52', business:'', rate:'10', amount:1100, credit:'80' }),
    csvRow({ side:'貸方', account:'免税仕入返品', code:'53', business:'', rate:'10', amount:1100, credit:'80' })
  ]));
  h.context.applyJournalImport();
  assert.equal(h.context.importedExemptTransactionCount, 2);
  assert.equal(h.element('exemptPurchase80_10').value, '');
  assert.equal(h.element('exemptPurchaseState').value, 'yes');
  h.element('exemptPurchaseState').value = 'no';
  assert.match(h.context.collectPurchases(h.ctx).errors.join(' '), /期間別内訳/);
});

test('[A05][A07] CSV明示1％税込額は8％内数に混ぜず元税率で連携する', () => {
  const h = harness(csv([
    csvRow({ rate:'1', amount:1010000 }),
    csvRow({ rate:'8', amount:1080000 }),
    csvRow({ rate:'10', amount:1100000, business:'4' }),
    csvRow({ side:'借方', account:'食品仕入', code:'5', business:'', rate:'1', amount:505000 }),
    csvRow({ side:'借方', account:'免税食品仕入', code:'52', business:'', rate:'1', amount:101000, credit:'50' })
  ]));
  h.context.applyJournalImport();
  assert.equal(h.element('taxScenarioFood1').checked, true);
  assert.equal(h.element('type2Sale8').value, '1,080,000');
  assert.equal(h.element('type2SaleFood1').value, '');
  const sales = h.context.collectSales(h.ctx);
  const purchases = h.context.collectPurchases(h.ctx);
  assert.equal(sales.rows.find(row => row.key === 'type2').taxFood1, 10000);
  assert.equal(sales.totalTax, 190000);
  assert.equal(purchases.taxFood1, 5000);
  assert.equal(purchases.exemptBuckets.find(row => row.key === '50').taxFood1, 1000);
  assert.equal(h.context.importedActualOnePercent.entries.length, 3);
});

test('[P04][P13][P18] CSV反映後の現在入力額から計算過程を作り、手修正で更新する', () => {
  const h = harness(csv([
    csvRow({ rate:'1', amount:1010000 }),
    csvRow({ rate:'8', amount:1080000 }),
    csvRow({ side:'借方', account:'食品仕入', code:'5', rate:'1', amount:505000 })
  ]));
  h.context.applyJournalImport();
  const trace = () => {
    const ctx = { ...h.ctx, taxScenarioLabel:'食品1％の未施行試算', advancedMode:false, creditMode:'unknown', declarationRounding:false };
    const sales = h.context.collectSales(ctx);
    const purchases = h.context.collectPurchases(ctx);
    const regular = engine.calculateRegularAmount({ salesTax:sales.totalTax, invoiceTax:purchases.invoiceTax,
      exemptCreditableTax:purchases.exemptCreditableTax, creditRatio:ctx.creditRatio, adjustment:purchases.adjustment });
    const method = { key:'regular', amount:regular.amount, eligibility:engine.ELIGIBILITY.UNKNOWN,
      reasons:['仕入控除率未確認'], reason:'仕入控除率未確認' };
    return h.context.renderCalculationTrace({ ctx, sales, purchases, regular, regularCredit:regular.regularCredit,
      creditablePurchaseTax:purchases.invoiceTax + purchases.exemptCreditableTax,
      comparisonReady:true, csvReview:{ reviewItems:[] }, inputErrors:[] }, method);
  };
  const before = trace();
  assert.match(before, /CSV明示1％実績/);
  assert.match(before, /1,010,000円 × 1 ÷ 101 [＝≒] 10,000円/);
  assert.match(before, /505,000円 × 1 ÷ 101 [＝≒] 5,000円/);
  assert.match(before, /1,080,000円/);
  h.element('type2Sale8').value = '1,188,000';
  const after = trace();
  assert.match(after, /1,188,000円/);
  assert.doesNotMatch(after, /1,080,000円/);
  assert.match(after, /CSV明示1％実績/);
});

test('[r18-A][r20] CSVの通常1％は制度期間で検証し、調整は元仕訳を残して参考確認に分ける', () => {
  for(const date of ['2027/03/31','2027/04/01','2029/03/31','2029/04/01']){
    const h = harness(csv([
      csvRow({ date, rate:'1', amount:1010 }),
      csvRow({ date, side:'借方', code:'5', rate:'1', amount:1010 }),
      csvRow({ date, side:'借方', code:'52', rate:'1', amount:1010, credit:'80' })
    ]));
    h.context.applyJournalImport();
    const entries = h.context.importedActualOnePercent.entries;
    assert.equal(entries.length, 3);
    assert.deepEqual(Array.from(entries, entry => entry.transactionKind), ['ordinary','ordinary','ordinary']);
    assert.equal(entries[0].taxCode, '1');
    assert.equal(entries[0].side, '貸方');
    const selectedYear = date.slice(0,4);
    const errors = h.context.validateImportedOnePercentEntries({ ...h.ctx, start:`${selectedYear}-01-01`, end:`${selectedYear}-12-31` }).errors;
    assert.equal(errors.length, date === '2027/04/01' || date === '2029/03/31' ? 0 : 3, date);
    if(errors.length) assert.match(errors[0], /1％の制度期間外/);
  }
  const adjustment = harness(csv([
    csvRow({ date:'2029/03/31', rate:'1', amount:1010 }),
    csvRow({ date:'2029/04/01', side:'借方', code:'11', rate:'1', amount:1010 })
  ]));
  assert.equal(journal.resolveImportValues(adjustment.context.pendingJournalImport.analysis, {}).ready, true, JSON.stringify(adjustment.context.pendingJournalImport.analysis.errors));
  adjustment.context.applyJournalImport();
  assert.equal(adjustment.context.importedActualOnePercent.entries[1].transactionKind, 'adjustment');
  const adjustmentReview = adjustment.context.validateImportedOnePercentEntries({ ...adjustment.ctx, start:'2029-01-01', end:'2029-12-31' });
  assert.equal(adjustmentReview.reviewItems.length, 1);
  assert.match(adjustmentReview.reviewItems[0].reason, /元取引/);
  const missingDate = harness(csv([csvRow({ date:'', rate:'1', amount:1010 })]));
  missingDate.context.applyJournalImport();
  assert.match(missingDate.context.validateImportedOnePercentEntries(missingDate.ctx).errors.join(' '), /日付不明/);
});

test('[A06][A10] 通常の方式比較でも8％実績から1％仕入を予測できる', () => {
  const h = harness(csv([csvRow({ rate:'10', amount:20000000, business:'4' })]));
  h.element('modeTaxExcluded').checked = true;
  h.ctx.amountMode = 'excluded';
  h.context.applyJournalImport();
  h.element('modeTaxExcluded').checked = true;
  h.element('purchase8').value = '10000000';
  h.element('purchaseFood1').value = '10000000';
  const sales = h.context.collectSales(h.ctx);
  const purchases = h.context.collectPurchases(h.ctx);
  assert.equal(sales.totalTax, 2000000);
  assert.equal(purchases.invoiceTax, 100000);
  assert.equal(sales.totalTax - purchases.invoiceTax, 1900000);
  assert.equal(sales.simplified.amount, 800000);
});

test('[A08] 食品シナリオの4期経路は手入力・日数配分とも内部関数でも停止', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  for(const foodForecastMethod of ['manual','uniform']){
    const plan = h.context.calculateProjectionPlan({ ctx:{ ...h.ctx, foodForecastMethod }, comparisonReady:true });
    assert.equal(plan.optimized.ok, false);
    assert.equal(plan.projections.length, 0);
    assert.match(plan.optimized.reason, /単期で比較/);
  }
  h.element('projectionRows').innerHTML = '<tr><td>以前の最適経路</td></tr>';
  h.context.renderProjection({ ctx:{ ...h.ctx, viewMode:'single' }, comparisonReady:true });
  assert.equal(h.element('projectionRows').innerHTML, '');
  assert.match(h.element('projectionRouteSummary').innerHTML, /未対応/);
});

test('[A09] 現行税率では従来どおり4期経路エンジンへ渡す', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.context.calculateProjectionMethods = (calc, period) => ({
    period, base:{ entered:true, value:1000000 },
    methods:[{ key:'regular', amount:100000, include:true }]
  });
  h.context.assessHighAssetForMethod = () => ({ status:'clear' });
  h.context.optimizeFourPeriodRoutes = input => ({ ok:true, received:input.periods, initialElectionStatus:input.initialElectionStatus });
  const result = h.context.calculateProjectionPlan({
    ctx:{ ...h.ctx, taxScenario:'current', advancedMode:true, simpleElectionStatus:'none', simpleNoticeReady:'yes', futureElectionPlan:'yes', currentDiscontinuanceReady:'yes' },
    comparisonReady:true,
    highAssetRegular:{ status:'clear' }
  });
  assert.equal(result.optimized.ok, true);
  assert.equal(result.projections.length, 1);
  assert.equal(result.optimized.received[0].methods[0].amount, 100000);
  const regularOnly = h.context.calculateProjectionPlan({
    ctx:{ ...h.ctx, taxScenario:'current', comparisonMethods:['regular'], currentReturnMethod:'regular',
      simpleElectionStatus:'unknown', simpleNoticeReady:'unknown', futureElectionPlan:'unknown' },
    methods:[{key:'regular'}], comparisonReady:true, highAssetRegular:{status:'clear'}
  });
  assert.equal(regularOnly.optimized.initialElectionStatus,'none',
    '現行が一般課税で簡易を比較しない場合は簡易の届出位置を必須にしない');
});

test('[端数06] 4期の計算過程は円表示・注記1回とし累計の内部値を変更しない', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  const bestRoute = Array.from({ length:4 }, (_, index) => ({
    label:`第${index + 1}期`, method:'regular', amount:1000.4, action:'届出状態を維持'
  }));
  const cumulative = bestRoute.reduce((sum, item) => sum + item.amount, 0);
  const plan = { periods:bestRoute.map(item => ({ label:item.label })),
    projections:bestRoute.map(() => ({ base:{ entered:false }, projectedRegular:{ exemptRatioLabel:'なし' } })),
    optimized:{ ok:true, bestRoute, cumulative } };
  const before = JSON.stringify(plan);
  h.context.calculateProjectionPlan = () => plan;
  h.context.currentLawProjectionNotice = () => '';
  h.context.yen = value => `${Math.round(value).toLocaleString('ja-JP')}円`;
  h.context.renderProjection({ ctx:{ taxScenario:'current', viewMode:'projection', advancedMode:true } });
  const rendered = h.element('projectionRouteSummary').innerHTML;
  assert.match(rendered, /1,000円/);
  assert.match(rendered, /累計 4,002円/);
  assert.match(rendered, /≒/);
  assert.doesNotMatch(rendered, /\d\.\d+円/);
  assert.equal(rendered.split(h.context.traceDisplayNote()).length - 1, 1);
  assert.equal(JSON.stringify(plan), before);
  assert.equal(cumulative, 4001.6);
  const recoveryText = '参考試算（一部明細を仮除外）。仮除外2明細、除外金額33,000円。税額影響は未算定。';
  h.context.renderProjection({ ctx:{ taxScenario:'current', viewMode:'projection', advancedMode:true },
    csvPartial:true, csvRecoveryText:recoveryText });
  const partial = h.element('projectionRouteSummary').innerHTML;
  assert.match(partial, /除外を含む集計範囲での4期参考比較/);
  assert.match(partial, /仮除外2明細/);
  assert.doesNotMatch(partial, /確認済み届出条件内の4期累計最少経路/);
  assert.equal(JSON.stringify(plan), before);
});

test('[A16] 条件確認済み・期限内提出計画は未提出と明記した顧客説明状態になる', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.element('periodStart').value = '2027-01-01';
  h.element('periodEnd').value = '2027-12-31';
  h.element('switchFoodSalesState').value = 'yes';
  h.element('switchSimplifiedAppliedState').value = 'yes';
  h.element('switchNoOtherRestrictionsState').value = 'yes';
  h.element('switchFilingStatus').value = 'planned';
  h.element('switchFilingDate').value = '2027-09-30';
  h.element('currentReturnMethod').value = 'simplified';
  h.element('exemptPurchaseState').value = 'no';
  h.element('switchAdditionalFee').value = '0';
  h.element('switchFeeTaxBasis').value = 'included';
  h.element('switchCreditState').value = 'unknown';
  h.element('switchOtherCostsNone').checked = true;
  const calc = {
    ctx:{ ...h.ctx, start:'2027-01-01', end:'2027-12-31', taxScenarioLabel:'飲食料品1％・大綱', proposalFoodClassificationState:'none', proposalPurchaseClassificationState:'none' },
    methods:[{ key:'simplified', amount:800000, eligible:true }, { key:'regular', amount:500000, eligible:true }],
    comparisonReady:true
  };
  const result = h.context.calculateSwitchDecision(calc);
  assert.equal(result.execution.eligibility, engine.ELIGIBILITY.ELIGIBLE);
  assert.equal(result.plannedConfirmed, true);
  assert.equal(result.confirmed, false);
  assert.match(result.customer.reportStatus, /条件付き顧客説明用/);
  assert.match(result.customer.reportStatus, /未提出/);
  assert.equal(result.customer.cashBenefitBeforeCredit, 300000);
});

test('[r19-T10] 期首前の提出予定は画面・顧客前提とも特例の事前提出を要確認とする', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.element('switchFoodSalesState').value = 'yes';
  h.element('switchSimplifiedAppliedState').value = 'yes';
  h.element('switchNoOtherRestrictionsState').value = 'yes';
  h.element('switchFilingStatus').value = 'planned';
  h.element('switchFilingDate').value = '2026-12-20';
  h.element('switchAdditionalFee').value = '0';
  h.element('switchFeeTaxBasis').value = 'included';
  h.element('switchOtherCostsNone').checked = true;
  h.element('switchCreditState').value = 'unknown';
  const calc = { ctx:{ ...h.ctx, start:'2027-01-01', end:'2027-12-31', taxScenarioLabel:'食品試算' }, methods:[{ key:'simplified', amount:40000, eligible:true }, { key:'regular', amount:-225000, eligible:true }], comparisonReady:true };
  const decision = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, decision);
  assert.equal(decision.execution.status, '要確認');
  assert.equal(decision.execution.twoYearBindingWaived, false);
  assert.match(h.element('switchExecutionResult').innerHTML, /法案成立後の事前提出/);
  assert.match(decision.customer.assumptions.join(' '), /法案成立後の事前提出/);
  assert.doesNotMatch(decision.customer.assumptions.join(' '), /期中届出特例と区別/);
  assert.match(h.context.customerDecisionText(decision.customer), /法案成立後の事前提出/);
  assert.match(h.context.customerDecisionCsv(decision.customer), /法案成立後の事前提出/);
  assert.match(h.element('customerPrintReport').innerHTML, /法案成立後の事前提出/);
});

test('[r19-T01-T06] 届出状態の切替とHTML追加確認で開始日・解除表示・印刷内容が再整合する', () => {
  const { h, calc } = switchCase();
  const filed = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, filed);
  assert.equal(filed.execution.eligibility, engine.ELIGIBILITY.ELIGIBLE);
  assert.equal(filed.customer.effectiveFrom, '2027-01-01');
  assert.match(h.element('switchExecutionResult').innerHTML, /適用開始見込み: 2027-01-01/);
  assert.match(h.element('customerPrintReport').innerHTML, /適用開始見込み: 2027-01-01/);

  h.element('switchFilingStatus').value = 'none';
  const none = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, none);
  assert.equal(none.execution.eligibility, engine.ELIGIBILITY.INELIGIBLE);
  assert.equal(none.customer.effectiveFrom, '');
  assert.equal(none.customer.twoYearBindingWaived, false);
  assert.match(none.customer.executionReasons.join(' '), /提出しない/);
  assert.match(none.customer.comparisonNotice, /適用可否とは別の仮定比較/);
  assert.match(h.element('switchExecutionResult').innerHTML, /この特例による適用開始日はありません/);
  assert.doesNotMatch(h.element('switchExecutionResult').innerHTML, /2027-01-01|解除する扱い/);
  for(const output of [h.context.customerDecisionText(none.customer), h.context.customerDecisionCsv(none.customer), h.element('customerPrintReport').innerHTML]){
    assert.match(output, /この特例による適用開始日はありません/);
    assert.match(output, /提出しない/);
    assert.doesNotMatch(output, /適用開始見込み: 2027-01-01|条件確認済み/);
  }
  assert.match(h.context.customerDecisionText(none.customer), /比較期間: 2027-01-01 から 2027-12-31/);

  h.element('switchFilingStatus').value = 'filed';
  h.element('exemptPurchaseState').value = 'unknown';
  const downgraded = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, downgraded);
  assert.equal(downgraded.execution.eligibility, engine.ELIGIBILITY.UNKNOWN);
  assert.equal(downgraded.customer.effectiveFrom, '');
  assert.equal(downgraded.customer.twoYearBindingWaived, false);
  assert.match(h.element('customerPrintReport').innerHTML, /適用開始は未確定/);
  assert.doesNotMatch(h.element('customerPrintReport').innerHTML, /適用開始見込み: 2027-01-01/);
  h.element('switchAdditionalFee').value = '不明';
  h.context.renderSwitchDecision(calc, h.context.calculateSwitchDecision(calc));
  assert.equal(h.element('printCustomerDecisionBtn').disabled, true);
  assert.equal(h.element('customerPrintReport').innerHTML, '');
});

test('[r19-T04-T05] 提出済みと提出予定は画面・コピー・CSV・印刷で開始日ラベルを分ける', () => {
  const { h, calc } = switchCase();
  for(const [status, label] of [['filed','適用開始見込み'],['planned','期限内提出を条件とした適用開始予定日']]){
    h.element('switchFilingStatus').value = status;
    const decision = h.context.calculateSwitchDecision(calc);
    h.context.renderSwitchDecision(calc, decision);
    assert.equal(decision.execution.eligibility, engine.ELIGIBILITY.ELIGIBLE);
    assert.match(decision.customer.effectiveFromLabel, new RegExp(label));
    for(const output of [h.element('switchExecutionResult').innerHTML, h.context.customerDecisionText(decision.customer), h.context.customerDecisionCsv(decision.customer), h.element('customerPrintReport').innerHTML]){
      assert.match(output, new RegExp(label));
      assert.match(output, /2027-01-01/);
    }
    if(status === 'planned') assert.match(decision.customer.effectiveFromLabel, /未提出/);
  }
});

test('[r19-T02-T03] 明確な対象外理由と未確認事項を顧客出力で区別する', () => {
  const { h, calc } = switchCase();
  h.element('switchFoodSalesState').value = 'no';
  const excluded = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, excluded);
  assert.equal(excluded.customer.executionEligibility, 'ineligible');
  assert.match(excluded.customer.executionReasons.join(' '), /販売を行わない/);
  assert.match(h.context.customerDecisionCsv(excluded.customer), /対象外理由,.*販売を行わない/);
  assert.match(h.element('customerPrintReport').innerHTML, /対象外理由:.*販売を行わない/);
  assert.match(excluded.customer.comparisonNotice, /仮定比較/);
  h.element('switchFoodSalesState').value = 'unknown';
  const uncertain = h.context.calculateSwitchDecision(calc);
  assert.equal(uncertain.customer.executionEligibility, 'unknown');
  assert.equal(uncertain.customer.executionReasons.length, 0);
  assert.match(uncertain.customer.confirmations.join(' '), /販売を行うか未確認/);
  assert.match(h.context.customerDecisionText(uncertain.customer), /適用開始は未確定/);
});

test('[r19-T14-T16][r20] CSV各経路の返品と旧保存値の種別不明は行別確認として保持する', () => {
  const normal = csvRow({ date:'2027/04/02', rate:'1', amount:1010000 });
  const saleReturn = csvRow({ date:'2027/04/03', side:'借方', code:'11', rate:'1', amount:1010 });
  const purchase = csvRow({ date:'2027/04/02', side:'借方', code:'5', rate:'1', amount:1010000 });
  const purchaseReturn = csvRow({ date:'2027/04/03', side:'貸方', code:'51', rate:'1', amount:1010 });
  const exempt = csvRow({ date:'2027/04/02', side:'借方', code:'52', rate:'1', amount:1010000, credit:'80' });
  const exemptReturn = csvRow({ date:'2027/04/03', side:'貸方', code:'53', rate:'1', amount:1010, credit:'80' });
  const h = harness(csv([normal,saleReturn,purchase,purchaseReturn,exempt,exemptReturn]));
  h.context.applyJournalImport();
  const entries = h.context.importedActualOnePercent.entries;
  assert.equal(entries.length, 6);
  assert.deepEqual(Array.from(entries, entry => entry.transactionKind), ['ordinary','adjustment','ordinary','adjustment','ordinary','adjustment']);
  assert.deepEqual(Array.from(entries, entry => entry.row), [2,3,4,5,6,7]);
  assert.deepEqual(Array.from(entries, entry => entry.ratePercent), [1,1,1,1,1,1]);
  assert.equal(entries[0].amount, 1010000);
  assert.equal(entries[1].amount, -1010);
  const ctx = { ...h.ctx, start:'2027-01-01', end:'2027-12-31' };
  const review = h.context.validateImportedOnePercentEntries(ctx);
  assert.equal(review.errors.length, 0);
  assert.equal(review.reviewItems.length, 3);
  for(const row of [3,5,7]) assert.match(review.reviewItems.map(item => item.source).join(' '), new RegExp(`CSV ${row}行目`));
  assert.equal(h.context.validateImportedOnePercentEntries({ ...ctx, start:'2028-01-01', end:'2028-12-31' }).errors.filter(error => error.includes('対象課税期間外')).length, 6);
  delete entries[0].transactionKind;
  assert.match(h.context.validateImportedOnePercentEntries(ctx).reviewItems.map(item => item.source + item.reason).join(' '), /CSV 2行目.*取引種別が不明/);

  const restored = switchDecision.migrateSavedState({
    schemaVersion:17, taxScenario:'foodProposal',
    importedActualOnePercent:{ source:'csvActual', entries:[{ ...entries[0], row:8, date:'2027-04-02' }] }
  });
  const old = harness(csv([normal]));
  old.context.importedActualOnePercent = restored.importedActualOnePercent;
  assert.equal(old.context.importedActualOnePercent.entries[0].transactionKind, undefined);
  assert.match(old.context.validateImportedOnePercentEntries(ctx).reviewItems.map(item => item.source + item.reason).join(' '), /CSV 8行目.*取引種別が不明/);

  const ordinaryOnly = harness(csv([normal]));
  ordinaryOnly.context.applyJournalImport();
  assert.equal(ordinaryOnly.context.validateImportedOnePercentEntries(ctx).errors.length, 0);
  assert.equal(ordinaryOnly.context.validateImportedOnePercentEntries(ctx).reviewItems.length, 0);
  assert.equal(ordinaryOnly.context.collectSales(ctx).rows.find(row => row.key === 'type2').taxFood1, 10000);
});

test('[r20-W03-W04] 1％返品が未確認でも計算可能なら参考表示に留め、顧客用へ所内指導文を渡さない', () => {
  const { h, calc } = switchCase();
  calc.csvReview = { errors:[], reviewItems:[{ source:'CSV 3行目', kind:'adjustment', reason:'元取引税率が未確認です。', amount:-1010, ratePercent:1 }], adjustmentCount:1, kindUnknownCount:0 };
  const decision = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, decision);
  assert.equal(decision.execution.eligibility, engine.ELIGIBILITY.UNKNOWN);
  assert.equal(decision.customer.effectiveFrom, '');
  assert.match(decision.customer.reportStatus, /参考試算/);
  assert.match(decision.customer.confirmations.join(' '), /入力された1％を仮定した参考値/);
  assert.doesNotMatch(decision.customer.confirmations.join(' '), /元帳・請求書で.*確認してください/);
  for(const output of [h.context.customerDecisionText(decision.customer), h.context.customerDecisionCsv(decision.customer), h.element('customerPrintReport').innerHTML]){
    assert.match(output, /入力された1％を仮定した参考値/);
    assert.doesNotMatch(output, /確認結果と見解を添えて相談/);
  }
  h.context.renderHero({ ...calc, inputErrors:[], hasComparisonInput:true, salesEntryRequired:false, comparisonProvisional:true, best:{ key:'regular', amount:10000 }, sorted:[{ key:'regular', amount:10000 },{ key:'simplified', amount:12000 }], unknownMethods:[], smallDifference:false });
  assert.match(h.element('resultHero').innerHTML, /入力済み金額に基づく参考比較/);
  assert.match(h.element('resultHero').innerHTML, /元取引の税率は未確認/);
  assert.doesNotMatch(h.element('resultHero').innerHTML, /最有利見込み/);
});

test('[r18-C] 現行4期の将来重複は売上構成に依存せず画面・出力前提へ表示し単期で消える', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.context.projectionPeriods = () => [2026,2027,2028,2029].map(year => ({ start:`${year}-01-01`, end:`${year}-12-31`, label:`${year}年` }));
  const ctx = { ...h.ctx, start:'2026-01-01', end:'2026-12-31', viewMode:'projection', taxScenario:'current' };
  const note = h.context.currentLawProjectionNotice(ctx);
  assert.match(note, /全期を現行税率/);
  assert.match(note, /食品1％提案を反映していません/);
  const calc = { ctx, regular:{ taxableSalesRatio:null }, purchases:{ adjustment:0, exemptBuckets:[] }, sales:{ simplified:{ methodLabel:'通常' }, rows:[] }, highAssetRegular:{ reason:'' }, unconfirmedItems:[], methods:[], best:null };
  assert.match(h.context.buildAssumptionRows(calc).map(row => row.join(':')).join(' '), /4期試算の税率前提.*全期を現行税率/);
  h.context.calculateProjectionPlan = () => ({ optimized:{ ok:false, reason:'経路確認中' } });
  h.context.renderProjection(calc);
  assert.match(h.element('projectionPolicyNotice').textContent, /食品1％提案を反映していません/);
  assert.match(h.context.buildSummaryText(calc), /4期試算の税率前提:.*食品1％提案を反映していません/);
  assert.match(h.context.buildCsvText(calc), /4期試算の税率前提,.*食品1％提案を反映していません/);
  h.context.renderPrintAssumptions(calc);
  assert.match(h.element('printAssumptions').innerHTML, /食品1％提案を反映していません/);
  assert.equal(h.context.currentLawProjectionNotice({ ...ctx, viewMode:'single' }), '');
  assert.equal(h.context.currentLawProjectionNotice({ ...ctx, taxScenario:'foodProposal' }), '');
  h.context.renderProjection({ ctx:{ ...ctx, viewMode:'single' } });
  assert.equal(h.element('projectionPolicyNotice').style.display, 'none');
});

test('[r18-D] 顧客差額は未確認155000円・控除確認165000円・B案反映済155000円で統一する', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.element('switchAdditionalFee').value = '110000';
  h.element('switchFeeTaxBasis').value = 'included';
  h.element('switchOtherCostsNone').checked = true;
  h.element('switchCreditState').value = 'unknown';
  const calc = { ctx:{ ...h.ctx, taxScenarioLabel:'食品試算' }, methods:[{ key:'simplified', amount:40000, eligible:true }, { key:'regular', amount:-225000, eligible:true }], comparisonReady:true };
  const reference = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, reference);
  assert.equal(reference.customer.cashBenefitDisplay, 155000);
  assert.equal(reference.customer.cashBenefitBasis, 'reference');
  assert.doesNotMatch(reference.economics.suggestion, /追加負担未入力/);
  assert.match(h.element('switchCustomerComparison').innerHTML, /追加支出後に残る差額.*155000円.*参考額・追加費用の仕入控除効果は未反映/);
  assert.match(h.context.customerDecisionText(reference.customer), /追加支出後に残る差額: 155000円\n差額の前提: 参考額/);
  assert.match(h.context.customerDecisionCsv(reference.customer), /追加支出後に残る差額,155000/);
  h.context.prepareCustomerPrint(reference.customer);
  assert.match(h.element('customerPrintReport').innerHTML, /追加支出後に残る差額.*155000円.*差額の前提/);

  h.element('switchCreditState').value = 'confirmed';
  h.element('switchAdditionalCredit').value = '10000';
  const confirmed = h.context.calculateSwitchDecision(calc);
  assert.equal(confirmed.customer.cashBenefitDisplay, 165000);
  assert.equal(confirmed.customer.cashBenefitBasis, 'confirmed');
  h.element('switchCreditIncludedInBTax').checked = true;
  const included = h.context.calculateSwitchDecision(calc);
  assert.equal(included.customer.cashBenefitDisplay, 155000);
  h.element('switchCreditState').value = 'none';
  const noCredit = h.context.calculateSwitchDecision(calc);
  assert.equal(noCredit.customer.cashBenefitDisplay, 155000);
  assert.equal(noCredit.customer.cashBenefitBasis, 'noCredit');
});

test('[A12] 不正な追加報酬は参考差額も未算定で顧客出力を停止する', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.element('switchAdditionalFee').value = '不明';
  h.element('switchFeeTaxBasis').value = 'included';
  h.element('switchOtherCostsNone').checked = true;
  h.element('switchCreditState').value = 'unknown';
  const calc = {
    ctx:{ ...h.ctx, taxScenarioLabel:'飲食料品1％・大綱', proposalFoodClassificationState:'unknown', proposalPurchaseClassificationState:'unknown' },
    methods:[{ key:'simplified', amount:800000, eligible:true }, { key:'regular', amount:500000, eligible:true }],
    comparisonReady:true
  };
  const result = h.context.calculateSwitchDecision(calc);
  h.context.renderSwitchDecision(calc, result);
  assert.ok(result.quote.errors.length);
  assert.equal(result.economics.cashBenefitBeforeCredit, null);
  assert.equal(h.element('copyCustomerDecisionBtn').disabled, true);
  assert.equal(h.element('downloadCustomerDecisionCsvBtn').disabled, true);
  assert.equal(h.element('printCustomerDecisionBtn').disabled, true);
});

test('[A19] 食品内数が空欄なら区分の確認だけでは0円確定しない', () => {
  const h = harness(csv([csvRow({ rate:'8', amount:1080000 })]));
  h.context.applyJournalImport();
  const ctx = { ...h.ctx, proposalFoodClassificationState:'confirmed', proposalPurchaseClassificationState:'none' };
  assert.match(h.context.validateProposalClassification(ctx).join(' '), /対象額を入力/);
  ctx.proposalFoodClassificationState = 'none';
  assert.equal(h.context.validateProposalClassification(ctx).length, 0);
});

test('[A20] 現行税率へ戻しても非ゼロ・不正な1％予測値の不採用を表示する', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  h.element('type2SaleFood1').value = '不明';
  h.element('purchaseFood1').value = '1000';
  h.context.renderTaxScenarioNotice({ ctx:{ ...h.ctx, taxScenario:'current', proposalFoodClassificationState:'unknown', proposalPurchaseClassificationState:'unknown' } });
  assert.match(h.element('taxScenarioNotice').textContent, /保持/);
  assert.match(h.element('taxScenarioNotice').textContent, /現行税率の計算には含めていません/);
  assert.equal(h.element('type2SaleFood1').value, '不明');
});

test('[食品1％価格前提] 折りたたみ中も現在の売上・仕入前提を更新して表示する', () => {
  const h = harness(csv([csvRow({ amount:1080000 })]));
  const ctx = { ...h.ctx, proposalFoodClassificationState:'confirmed', proposalPurchaseClassificationState:'confirmed' };
  h.context.renderTaxScenarioNotice({ ctx });
  assert.equal(h.element('foodPriceBasisSummary').textContent, '現在：売上・仕入とも税抜価格据置');
  assert.equal(h.element('foodPriceBasisDetails').open, false);
  h.context.renderTaxScenarioNotice({ ctx:{ ...ctx, foodSalesPriceBasis:'grossFixed' } });
  assert.equal(h.element('foodPriceBasisSummary').textContent, '現在：売上税込価格据置／仕入税抜価格据置');
  assert.equal(h.element('foodPriceBasisDetails').open, false);
  h.context.renderTaxScenarioNotice({ ctx:{ ...ctx, foodSalesPriceBasis:'grossFixed', foodPurchasePriceBasis:'grossFixed' } });
  assert.equal(h.element('foodPriceBasisSummary').textContent, '現在：売上・仕入とも税込価格据置');
});
