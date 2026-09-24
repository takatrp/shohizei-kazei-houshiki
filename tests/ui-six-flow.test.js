'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../tax-engine.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}
function harness(names){
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)) elements.set(id, {
      value:'', checked:false, open:false, disabled:false, style:{}, dataset:{},
      innerHTML:'', textContent:'', parentElement:null, listeners:{},
      classList:{add(){},remove(){},toggle(){}},
      addEventListener(type, cb){ this.listeners[type] = cb; },
      querySelector(){ return element(id + ':option'); }, closest(){ return null; },
      focus(){ this.focused = true; }, scrollIntoView(){ this.scrolled = true; },
      setAttribute(){}, removeAttribute(){}, append(){}, insertBefore(){}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    $:element, parseAmountInput:engine.parseAmountInput,
    BUSINESS_TYPES:[{key:'type2'}], EXEMPT_PURCHASE_BUCKETS:[{key:'80'}],
    importedActualOnePercent:null, importedCsvRecovery:null, appliedJournalImport:null, foodConfirmationSignatures:{},
    workflowStep:1, switchDecisionOpen:false, visibleBusinessTypes:new Set(),
    comparisonMethodAttempted:false, refreshTaxRowTableLayout(){}, selectedComparisonMethods:()=>['regular'],
    selectedValue:()=> 'included', taxScenarioKey:()=> 'foodProposal',
    escapeHtml:String, yen:n=>`${n}円`, amountClass:()=>'',
    METHOD_LABELS:{regular:'本則課税',simplified:'簡易課税'}, ELIGIBILITY:engine.ELIGIBILITY,
    update(){}, enterManualAmountInput(){context.workflowStep = 2;},
    document:{querySelectorAll:()=>[], querySelector:()=>null, addEventListener(){}},
    window:{addEventListener(){}},
    printMethodComparison(){}, prepareComparisonPrint(){},
    handleJournalCsvFile(){}, applyJournalImport(){}, clearJournalImport(){}, resetAll(){},
    navigator:{}, setTimeout(){}
  });
  vm.runInContext([...new Set(['normalizeCsvRecovery', 'csvRecoverySummaryText', ...names])].map(source).join('\n'), context);
  return {context,element};
}
const foodFunctions = ['amountState','exemptPurchaseInputId','foodConfirmationEvidence','normalizeFoodConfirmations'];

function navigationHarness(step){
  const h = harness(['renderWorkflow']);
  h.context.workflowStep = step;
  h.context.pendingJournalImport = null;
  h.context.importedUnsupportedEntries = [];
  h.context.renderExemptFields = () => {};
  const moves = [];
  for(const screen of [1, 2, 4]){
    const parent = h.element('workflowScreen' + screen);
    parent.append = node => {
      moves.push({ kind:'append', screen });
      node.parentElement = parent;
      node.nextElementSibling = null;
    };
    parent.insertBefore = (node, reference) => {
      moves.push({ kind:'insertBefore', screen });
      node.parentElement = parent;
      node.nextElementSibling = reference;
    };
  }
  const calc = { ctx:{ taxScenario:'current', entity:'individual', individualCalendarYear:true },
    inputErrors:[], methods:[], csvReview:{ reviewItems:[] } };
  return { ...h, moves, calc, render:() => h.context.renderWorkflow(calc, {}) };
}

test('未選択では進行を止め、固定バーの計算前提を強調する', () => {
  const h = navigationHarness(1);
  h.calc.ctx.comparisonMethods = [];
  h.render();
  assert.equal(h.element('workflowNext').disabled,false);
  assert.match(h.element('workflowStepSummary').textContent,/^計算前提：現行制度｜対象期/);
  assert.match(h.element('comparisonMethodRequired').textContent,/まず、今回試算する方式を選んでください/);
  assert.match(html,/#workflowStepSummary\{[^}]*border-left:5px[^}]*font-weight:800/);
  h.context.comparisonMethodAttempted = true;
  h.render();
  assert.match(h.element('comparisonMethodRequired').textContent,/1つ以上選択してください/);
  h.calc.ctx.comparisonMethods = ['regular'];
  h.render();
  assert.equal(h.element('workflowNext').disabled,false);
  assert.equal(h.context.comparisonMethodAttempted,false);
});

test('未選択のまま手入力へ進もうとすると案内を強調し、方式選択へ戻す', () => {
  const h = harness(['bindEvents']);
  h.context.selectedComparisonMethods = () => [];
  h.context.bindEvents();
  h.element('workflowNext').listeners.click();
  assert.equal(h.context.workflowStep,1);
  assert.equal(h.context.comparisonMethodAttempted,true);
  assert.equal(h.element('comparisonMethodLabel').scrolled,true);
});

test('[r23残件1] 初期画面の同じ位置にあるナビゲーションは再挿入しない', () => {
  const h = navigationHarness(1);
  const nav = h.element('workflowNavigation');
  nav.parentElement = h.element('workflowScreen1');
  nav.nextElementSibling = h.element('journalImportPanel');
  h.render();
  h.render();
  assert.deepEqual(h.moves, []);
});

test('[r23残件1] 金額・結果画面の同じ親にあるナビゲーションは再appendしない', () => {
  for(const step of [2, 4]){
    const h = navigationHarness(step);
    const nav = h.element('workflowNavigation');
    nav.parentElement = h.element('workflowScreen' + step);
    h.render();
    h.render();
    assert.deepEqual(h.moves, [], `画面 ${step} の再描画でボタンを移動しない`);
  }
});

test('[r23残件1] 別画面への移動は一度だけ行い初期画面ではCSV領域直前へ置く', () => {
  for(const step of [1, 2, 4]){
    const h = navigationHarness(step);
    const nav = h.element('workflowNavigation');
    nav.parentElement = h.element('workflowScreen' + (step === 1 ? 2 : 1));
    nav.nextElementSibling = null;
    h.render();
    assert.deepEqual(h.moves, [{ kind:step === 1 ? 'insertBefore' : 'append', screen:step }]);
    assert.equal(nav.parentElement, h.element('workflowScreen' + step));
    if(step === 1) assert.equal(nav.nextElementSibling, h.element('journalImportPanel'));
    h.render();
    assert.equal(h.moves.length, 1);
  }
});

test('[r23残件1] 初期画面で親が同じでも位置が誤っている場合は修正する', () => {
  const h = navigationHarness(1);
  const nav = h.element('workflowNavigation');
  nav.parentElement = h.element('workflowScreen1');
  nav.nextElementSibling = h.element('otherSection');
  h.render();
  assert.deepEqual(h.moves, [{ kind:'insertBefore', screen:1 }]);
  assert.equal(nav.nextElementSibling, h.element('journalImportPanel'));
  h.render();
  assert.equal(h.moves.length, 1);
});

test('[U07-U08] 未入力・不正額は照合済みにできず、有効な保存値と明示0円を保持する',()=>{
  const h = harness(foodFunctions);
  const status = h.element('proposalFoodClassificationState');
  status.value = 'confirmed';
  h.context.normalizeFoodConfirmations();
  assert.equal(status.value,'unknown');
  assert.equal(status.querySelector().disabled,true);
  h.element('type2Sale8').value = '1000';
  h.element('type2SaleFood1').value = '500';
  h.context.normalizeFoodConfirmations();
  assert.equal(status.value,'unknown');
  status.value='confirmed';
  h.context.normalizeFoodConfirmations();
  assert.equal(status.value,'confirmed');
  h.context.foodConfirmationSignatures={};
  h.context.normalizeFoodConfirmations();
  assert.equal(status.value,'confirmed');
  h.element('type2SaleFood1').value='不明';
  h.context.normalizeFoodConfirmations();
  assert.equal(status.value,'unknown');
  assert.equal(h.element('type2SaleFood1').value,'不明');
  h.element('type2SaleFood1').value='0';
  h.context.normalizeFoodConfirmations();
  assert.equal(status.querySelector().disabled,false);
});

test('[U08] 食品金額変更は該当側だけ解除し、期間の変更は両側の確認を解除する',()=>{
  const h=harness(foodFunctions);
  for(const [base,target] of [['type2Sale8','type2SaleFood1'],['purchase8','purchaseFood1']]){
    h.element(base).value='1000'; h.element(target).value='500';
  }
  h.context.normalizeFoodConfirmations();
  h.element('proposalFoodClassificationState').value='confirmed';
  h.element('proposalPurchaseClassificationState').value='confirmed';
  h.element('type2SaleFood1').value='600';
  h.context.normalizeFoodConfirmations();
  assert.equal(h.element('proposalFoodClassificationState').value,'unknown');
  assert.equal(h.element('proposalPurchaseClassificationState').value,'confirmed');
  h.element('proposalFoodClassificationState').value='confirmed';
  h.element('periodEnd').value='2028-12-31';
  h.context.normalizeFoodConfirmations();
  assert.equal(h.element('proposalFoodClassificationState').value,'unknown');
  assert.equal(h.element('proposalPurchaseClassificationState').value,'unknown');
});

test('[U09-U25] 明示1％の純額0円の元行は確認の根拠として保持し、対象なしを自動解除しない',()=>{
  const h=harness(foodFunctions);
  const entries=[{kind:'sale',amount:1010},{kind:'sale',amount:-1010,transactionKind:'adjustment'}];
  h.context.importedActualOnePercent={entries};
  h.element('proposalFoodClassificationState').value='confirmed';
  h.context.normalizeFoodConfirmations();
  assert.equal(h.element('proposalFoodClassificationState').value,'confirmed');
  assert.equal(h.context.foodConfirmationEvidence('sale').available,true);
  assert.equal(h.context.importedActualOnePercent.entries,entries);
  h.element('proposalFoodClassificationState').value='none';
  h.context.normalizeFoodConfirmations();
  assert.equal(h.element('proposalFoodClassificationState').value,'none');
  assert.equal(entries[1].transactionKind,'adjustment');
});

test('[U10-U12] 実イベントで次へと戻るは費用の開閉に関係なく3段階を通る',()=>{
  const h=harness(['bindEvents']);
  h.context.bindEvents();
  for(const opened of [false,true]){
    h.context.switchDecisionOpen=opened;
    h.context.workflowStep=1;
    h.element('workflowNext').listeners.click();
    assert.equal(h.context.workflowStep,2);
    h.element('workflowNext').listeners.click();
    assert.equal(h.context.workflowStep,4);
    h.element('workflowBack').listeners.click();
    assert.equal(h.context.workflowStep,2);
    h.element('workflowBack').listeners.click();
    assert.equal(h.context.workflowStep,1);
  }
  assert.deepEqual([...html.matchAll(/<button[^>]*data-workflow-step="(\d)"/g)].map(m=>Number(m[1])),[1,2,4]);
});

test('[r27導線] CSV入口は取込領域を開くだけでファイル選択を自動起動しない',()=>{
  const h=harness(['bindEvents']);
  let pickerClicks=0;
  let updates=0;
  h.element('journalCsvFile').click=()=>{ pickerClicks++; };
  h.context.update=()=>{ updates++; };
  h.context.bindEvents();
  h.element('openJournalImportBtn').listeners.click();
  assert.equal(h.element('journalImportDisclosure').open,true);
  assert.equal(pickerClicks,0);
  assert.equal(updates,1);
  assert.equal(h.element('journalCsvFile').focused,true);
  assert.match(html, /<input[^>]*type="file"[^>]*id="journalCsvFile"/);
  h.element('journalCsvFile').listeners.change();
  assert.equal(pickerClicks,0);
});

test('[r27文字] 通常入力・売上表・免税仕入内訳の入力文字は親の補足サイズを継承せず14pxでそろえる',()=>{
  const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css,/--font-body:\s*14px/);
  assert.match(css,/--font-note:\s*12px/);
  assert.match(css,/--font-heading:\s*16px/);
  assert.match(css,/body\s*\{[^}]*font-size:\s*var\(--font-body\)/);
  assert.match(css,/button,input,select,textarea\s*\{[^}]*font-size:\s*var\(--font-body\)/);
  assert.match(css,/table\s*\{[^}]*font-size:\s*var\(--font-body\)/);
  assert.match(css,/\.field label,\.check-label[^}]*font-size:\s*var\(--font-body\)/);
  assert.match(css,/\.field small,\.check-row small,[\s\S]*?font-size:\s*var\(--font-note\)/);
  assert.match(css,/h2\s*\{[^}]*font-size:\s*var\(--font-heading\)/);
  const inputRules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>/\binput\b|\bselect\b|\.money\b|\.js-amount\b/.test(match[1]));
  for(const rule of inputRules){
    if(/font-size:/.test(rule[2])) assert.match(rule[2],/font-size:\s*var\(--font-body\)/,rule[1]);
    assert.doesNotMatch(rule[2],/font:\s*inherit/,`入力欄の文字サイズを親の11px・13pxに戻さない: ${rule[1]}`);
  }
  assert.doesNotMatch(html,/<input[^>]*style="[^"]*font-size/);
});

test('[U17] 確認リンクは該当画面へ移動して折り畳みを開きスクロールとフォーカスを行う',()=>{
  const h=harness(['goToInput']);
  const input=h.element('baseTaxableSales');
  input.closest=selector=>selector==='#workflowScreen2'?{}:null;
  const details={tagName:'DETAILS',open:false,parentElement:null};
  input.parentElement=details;
  h.context.goToInput('baseTaxableSales');
  assert.equal(h.context.workflowStep,2);
  assert.equal(details.open,true);
  assert.equal(input.focused,true);
  assert.equal(input.scrolled,true);
  assert.equal(h.element('advancedMode').checked,false);
});

test('[U15-U17] 特定期間は一方が判定済みなら他方の不足リンクを出さない',()=>{
  const h=harness(['conditionInputLinks']);
  const resolved=h.context.conditionInputLinks({inputErrors:[],comparisonReady:true,ctx:{baseSalesEntered:true,specificUnder10m:true,specificInputEntered:true,specificSalesEntered:true,specificTaxableSales:9000000,specificPayrollEntered:false}});
  assert.doesNotMatch(resolved,/data-input-target="(?:specificTaxableSales|specificPayrollAmount)"/);
  const missing=h.context.conditionInputLinks({inputErrors:[],comparisonReady:true,ctx:{baseSalesEntered:false,specificInputEntered:false}});
  assert.match(missing,/data-input-target="baseTaxableSales"/);
  assert.match(missing,/data-input-target="specificTaxableSales"/);
  const payrollNeeded=h.context.conditionInputLinks({inputErrors:[],comparisonReady:true,ctx:{baseSalesEntered:true,specificUnder10m:false,specificSalesEntered:true,specificTaxableSales:11000000,specificPayrollEntered:false}});
  assert.match(payrollNeeded,/data-input-target="specificPayrollAmount"/);
  assert.doesNotMatch(payrollNeeded,/data-input-target="specificTaxableSales"/);
});

test('[U18-U20] 参考試算・全対象外・1方式・不正入力を異なる結果として表示する',()=>{
  const h=harness(['conditionInputLinks','renderHero']);
  const base={ctx:{},inputErrors:[],hasComparisonInput:true,salesEntryRequired:false,
    best:null, sorted:[],unknownMethods:[],methods:[],csvReview:{reviewItems:[]}};
  const render=overrides=>{h.context.renderHero({...base,...overrides});return h.element('resultHero').innerHTML;};
  assert.match(render({methods:[{eligibility:engine.ELIGIBILITY.UNKNOWN}],unknownMethods:[{}]}),/税額の参考試算/);
  assert.match(render({methods:[{eligibility:engine.ELIGIBILITY.INELIGIBLE}]}),/適用対象外/);
  assert.match(render({best:{key:'regular',amount:400000},sorted:[{key:'regular',amount:400000}],methods:[{key:'regular',eligibility:engine.ELIGIBILITY.ELIGIBLE}]}),/一般課税の試算結果/);
  assert.match(render({inputErrors:['不正な金額']}),/計算できません/);
  assert.match(render({hasComparisonInput:false}),/金額を入力/);
  assert.doesNotMatch(h.element('resultHero').innerHTML,/確認済み候補がありません/);
});

test('[U11-U27] 費用画面を指す旧保存値は費用額と開閉状態を保持して税額結果へ復元する',()=>{
  const h=harness(['restoreState']);
  Object.assign(h.context, {
    STORAGE_KEY:'test', storageGet:()=>JSON.stringify({saveEnabled:true,workflowStep:3,
      workflowPurpose:'foodSwitch',switchDecisionOpen:true,switchAdditionalFee:'110000',
      type2Sale8:'1080000',periodStart:'2028-01-01'}),
    migrateSavedState:value=>value, storageRemove(){}, console,
    importedExemptTransactionCount:0, importedUnsupportedEntries:[]
  });
  h.context.restoreState();
  assert.equal(h.context.workflowStep,4);
  assert.equal(h.context.switchDecisionOpen,true);
  assert.equal(h.element('switchAdditionalFee').value,'110000');
  assert.equal(h.element('type2Sale8').value,'1080000');
  h.context.taxScenarioKey=()=> 'current';
  h.context.restoreState();
  assert.equal(h.context.workflowStep,4);
  assert.equal(h.context.switchDecisionOpen,false);
  assert.equal(h.element('switchAdditionalFee').value,'110000');
});

test('[U13-U26] 通常税額出力は不正な任意費用から独立し、適用対象外方式の金額を出さない',()=>{
  const h=harness(['buildSummaryText','buildCsvText']);
  h.context.buildAssumptionRows=()=>[['課税期間','2028年']];
  h.context.sanitizeCsvCell=String;
  h.context.taxRateLabel=()=> '8％';
  const calc={ctx:{viewMode:'single'},comparisonReady:true,best:null,unknownMethods:[],
    csvReview:{reviewItems:[]},purchases:{exemptBuckets:[]},sales:{rows:[]},methods:[
      {key:'regular',amount:400000,eligibility:engine.ELIGIBILITY.ELIGIBLE,status:'入力条件では適用可能',calculationMethod:'全額控除',reason:''},
      {key:'simplified',amount:987654,eligibility:engine.ELIGIBILITY.INELIGIBLE,status:'入力条件では適用対象外',calculationMethod:'区分別',reason:'対象外'}]};
  const before=[h.context.buildSummaryText(calc),h.context.buildCsvText(calc)];
  for(const value of ['', '不明', '0']){
    h.element('switchAdditionalFee').value=value;
    const after=[h.context.buildSummaryText(calc),h.context.buildCsvText(calc)];
    assert.deepEqual(after,before);
    after.forEach(output=>{
      assert.match(output,/400000/);
      assert.doesNotMatch(output,/987654|計算過程を見る|工数原価/);
      assert.match(output,/適用対象外/);
    });
  }
});
