'use strict';
// Independent Chromium replay of the supplied B01-B07 and FDS01-FDS12 cases.
// Anonymous fixtures only; inlines the app into an isolated about:blank page.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const evidence=process.env.R33_EVIDENCE_DIR;
if(!evidence) throw new Error('R33_EVIDENCE_DIR must point to the extracted review evidence folder');
const out=path.resolve(process.env.R33_RESULTS_DIR||path.join(root,'..','r33_01_07_results'));
fs.mkdirSync(out,{recursive:true});
const read=name=>fs.readFileSync(path.join(evidence,name),'utf8');
let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
html=html.replace(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,(_match,name)=>{
  if(/^(?:https?:|\/\/)/.test(name)) return '';
  const file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)) throw new Error('Script path outside repository');
  return '<script>'+fs.readFileSync(file,'utf8').replace(/<\/script/gi,'<\\/script')+'</script>';
});
html=html.replace(/src="([^"\n]+\.(?:png|jpg|jpeg))"/gi,(whole,name)=>{
  const file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)) return whole;
  const mime=/\.png$/i.test(name)?'image/png':'image/jpeg';
  return `src="data:${mime};base64,${fs.readFileSync(file).toString('base64')}"`;
});
const seed=read('fixture-seed.js');
const snap=read('../../r33_01_06/evidence/fixture-snapshot.js');
const cases=[
  ['FDS01_first_planned','first','planned','allowed-reference'],
  ['FDS02_second_planned','second','planned','allowed-reference'],
  ['FDS03_free_planned','free','planned','allowed-reference'],
  ['FDS04_first_filed_hypothetical','first','filed','allowed-reference'],
  ['FDS05_2028_out_of_scope','first','planned','blocked',2028],
  ['FDS06_food_purchase_only','first','planned','blocked',2027,'no'],
  ['FDS07_no_filing','first','none','blocked'],
  ['FDS08_other_restriction','first','planned','blocked',2027,'yes','no'],
  ['FDS09_four_periods_remain_unsupported','first','planned','four-periods-blocked'],
  ['FDS10_ordinary_valid_out_of_food_scope','free','none','allowed-reference',2028,'yes','yes','yes'],
  ['FDS11_current_law_no_food_waiver','first','planned','blocked',2027,'yes','yes','no','current'],
  ['FDS12_filing_after_target_period','first','planned','blocked',2027,'yes','yes','no','foodProposal','2028-01-10']
];
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ja-JP'});
  await context.route('**/*',route=>route.abort());
  const results=[],pageErrors=[];
  async function load(saved={}){
    const page=await context.newPage();
    page.on('pageerror',error=>pageErrors.push(error.message));
    page.on('dialog',dialog=>dialog.accept());
    await page.evaluate(data=>{
      window.__reviewStore=new Map(Object.entries(data));
      Object.defineProperty(window,'localStorage',{value:{
        getItem(key){return window.__reviewStore.get(key)??null},
        setItem(key,value){window.__reviewStore.set(key,String(value))},
        removeItem(key){window.__reviewStore.delete(key)},
        clear(){window.__reviewStore.clear()},
        key(index){return [...window.__reviewStore.keys()][index]??null},
        get length(){return window.__reviewStore.size}
      }});
    },saved);
    await page.setContent(html,{waitUntil:'domcontentloaded'});
    return page;
  }
  async function step(page,n){await page.evaluate(value=>{workflowStep=value;update()},n)}
  async function mode(page,value){await page.locator(`input[name=cashflowComparisonType][value=${value}]`).check()}
  async function snapshot(page){return page.evaluate(`(${snap})()`)}
  async function record(id,pass,detail,page){
    results.push({id,pass:Boolean(pass),detail});
    process.stdout.write(`${pass?'PASS':'FAIL'} ${id}\n`);
    if(page&&(!pass||/B02|B03|B06|FDS01|FDS05/.test(id))) await page.screenshot({path:path.join(out,id+'.png'),fullPage:true});
  }
  const seeded=async(opts)=>{const page=await load();await page.evaluate(`(${seed})(${JSON.stringify(opts)})`);return page};
  let page=await seeded({scenario:'current'});await step(page,5);await mode(page,'methodImpact');await page.locator('#cashflowInterimStatus').selectOption('none');
  let corp=await snapshot(page);
  await page.locator('#cashflowSameSettlement').uncheck();
  await page.locator('#cashflowBaseSettlementMonth').fill('2029-06');await page.locator('#cashflowBaseSettlementMonth').blur();
  await step(page,1);await page.locator('label[for=entityIndividual]').click();await step(page,5);
  let individual=await snapshot(page);
  await page.evaluate(()=>{$('saveToDevice').checked=true;saveState()});
  const saved=await page.evaluate(()=>Object.fromEntries(window.__reviewStore));
  const restored=await load(saved);const restoredSnap=await snapshot(restored);
  await record('B01_defaults_and_memory_restore',corp.months.cashflowSettlementMonth.value==='2029-02'
    && corp.months.cashflowRefundMonth.value==='2029-03'
    && individual.months.cashflowBaseSettlementMonth.value==='2029-06'
    && individual.months.cashflowChangedSettlementMonth.value==='2029-03'
    && restoredSnap.months.cashflowBaseSettlementMonth.value==='2029-06'
    && restoredSnap.mode==='methodImpact',{corp,individual,restored:restoredSnap},page);await page.close();await restored.close();
  page=await seeded({scenario:'foodProposal'});
  await page.evaluate(()=>{const sale=taxEntryRows.sales[0];sale.amount='54000000';sale.foodAmount='54000000';
    taxEntryRows.sales.splice(1,0,{...sale,id:newTaxEntry('sales').id});renderTaxEntryRows('sales');update()});
  await step(page,2);
  await page.locator('tr[data-row-side=sales] [data-row-field=foodAmount]').nth(1).fill('');
  await page.locator('tr[data-row-side=sales] [data-row-field=foodAmount]').nth(1).blur();
  await page.locator('#proposalFoodClassificationState').selectOption('confirmed');
  await page.locator('#proposalPurchaseClassificationState').selectOption('confirmed');
  let food=await page.evaluate(()=>{const calc=latestCalculation.calc;const regular=calc.methods.find(m=>m.key==='regular');
    return {regular,missing:calc.foodRowMissing,comparisonReady:calc.comparisonReady}});
  await record('B02_required_food_affects_calculation',food.regular.amount===null && food.missing.sales.length>0,food,page);await page.close();
  page=await seeded({scenario:'foodProposal'});
  const foodScope=await page.evaluate(()=>{
    taxEntryRows.purchases[0].foodAmount='';update();
    const missing={regular:latestCalculation.calc.methods.find(m=>m.key==='regular').amount,
      simplified:latestCalculation.calc.methods.find(m=>m.key==='simplified').amount};
    taxEntryRows.purchases[0].foodAmount='0';update();
    const zero=latestCalculation.calc.methods.find(m=>m.key==='regular').amount;
    $('taxScenarioCurrent').checked=true;taxEntryRows.purchases[0].foodAmount='';update();
    const current=latestCalculation.calc.methods.find(m=>m.key==='regular').amount;
    return {missing,zero,current};
  });
  await record('R33_03_food_dependency_and_explicit_zero',foodScope.missing.regular===null
    && foodScope.missing.simplified!==null && foodScope.zero!==null && foodScope.current!==null,foodScope,page);
  await page.close();
  page=await seeded({scenario:'foodProposal'});await step(page,5);
  await page.locator('#cashflowInterimStatus').selectOption('scheduled');await page.locator('#cashflowSameInterim').uncheck();
  await page.locator('#cashflowBaseInterim').fill('2028-08,1200000');await page.locator('#cashflowBaseInterim').blur();
  await page.locator('#cashflowChangedInterim').fill('2028-08,0');await page.locator('#cashflowChangedInterim').blur();
  const before=await snapshot(page);await mode(page,'methodImpact');
  await page.locator('#cashflowInterimStatus').selectOption('none');
  const other=await snapshot(page);await mode(page,'rateImpact');const after=await snapshot(page);
  await record('B03_mode_isolation',JSON.stringify(before.manual)===JSON.stringify(after.manual)
    && JSON.stringify(before.engine?.maxDrawdown)===JSON.stringify(after.engine?.maxDrawdown)
    && other.interimMode==='none',{before,other,after},page);await page.close();
  page=await seeded({scenario:'foodProposal'});await step(page,5);
  await page.locator('#cashflowInterimStatus').selectOption('scheduled');
  await page.locator('#cashflowBaseInterim').fill('2028-08,123000');await page.locator('#cashflowBaseInterim').blur();
  await mode(page,'methodImpact');await page.locator('#cashflowInterimStatus').selectOption('none');
  await page.evaluate(()=>{$('saveToDevice').checked=true;update()});
  const modeSaved=await page.evaluate(()=>Object.fromEntries(window.__reviewStore));
  const modeRestored=await load(modeSaved);
  await mode(modeRestored,'rateImpact');
  const rateRestored=await snapshot(modeRestored);
  await mode(modeRestored,'methodImpact');
  const methodRestored=await snapshot(modeRestored);
  await modeRestored.evaluate(()=>resetAll());
  const afterResetModes=await modeRestored.evaluate(()=>({rate:cashflowModeStates.rateImpact?.cashflowBaseInterim,
    method:cashflowModeStates.methodImpact?.cashflowBaseInterim,interim:$('cashflowInterimStatus').value}));
  await record('R33_02_mode_save_restore_reset',rateRestored.manual.base==='2028-08,123000'
    && methodRestored.interimMode==='none' && !afterResetModes.rate && !afterResetModes.method
    && afterResetModes.interim==='auto',{rateRestored,methodRestored,afterResetModes},modeRestored);
  await page.close();await modeRestored.close();
  page=await seeded({scenario:'foodProposal'});await step(page,5);await page.locator('#cashflowInterimStatus').selectOption('none');
  await page.locator('#cashflowRefundMonth').fill('2029-03');await page.locator('#cashflowRefundMonth').blur();
  await step(page,1);await page.locator('#periodStart').fill('2029-01-01');await page.locator('#periodStart').blur();
  await page.locator('#periodEnd').fill('2029-12-31');await page.locator('#periodEnd').blur();await step(page,5);
  let old=await snapshot(page);await record('B04_unused_refund_does_not_block',old.engine?.status==='complete',old,page);await page.close();
  page=await seeded({scenario:'foodProposal'});await step(page,5);await page.locator('#cashflowInterimStatus').selectOption('scheduled');
  let badges=await page.evaluate(()=>['cashflowSameInterim','cashflowBaseNoInterim','saveToDevice'].map(id=>{
    const control=$(id),label=control.closest('label');return {id,visible:!!control.getClientRects().length,badge:label?.querySelector('.field-badge')?.textContent||null}}));
  await record('B05_wrapped_checkbox_badges',badges.filter(item=>item.visible).every(item=>item.badge),badges,page);await page.close();
  page=await seeded({scenario:'current'});await step(page,5);await mode(page,'methodImpact');
  await page.locator('#cashflowInterimStatus').selectOption('none');
  await page.locator('#cashflowSameSettlement').uncheck();
  await page.locator('#cashflowBaseSettlementMonth').fill('2029-05');await page.locator('#cashflowBaseSettlementMonth').blur();
  let beforeSwap=await snapshot(page);await page.locator('#cashflowSwapPlans').click();let afterSwap=await snapshot(page);
  await page.locator('#cashflowResetMonths').click();let afterReset=await snapshot(page);
  await record('B06_swap_and_reset_to_standard',beforeSwap.pair[0]===afterSwap.pair[1]
    && beforeSwap.months.cashflowBaseSettlementMonth.value===afterSwap.months.cashflowChangedSettlementMonth.value
    && afterReset.months.cashflowChangedSettlementMonth.meta.origin==='defaultOffset',
    {before:beforeSwap,swapped:afterSwap,reset:afterReset},page);
  const decorated=await snapshot(page);
  await record('B07_no_badge_text_in_export',!/(?:予定月)(?:必須|任意)/.test(decorated.notes.join('\n')),
    {notes:decorated.notes,copy:decorated.out.copy,csv:decorated.out.csv},page);await page.close();
  page=await seeded({scenario:'current'});await step(page,5);await mode(page,'methodImpact');
  const stale=await page.evaluate(()=>{
    const original=cashflowExportText(latestCashflow);
    $('cashflowBaseSettlementMonth').value='2030-01';
    const copy=cashflowExportText(latestCashflow),csv=cashflowCsvText(latestCashflow);
    update();
    const refreshed=cashflowExportText(latestCashflow);
    return {original,copy,csv,refreshed};
  });
  await record('R33_input_snapshot_export_guard',!stale.original.includes('入力が更新')
    && stale.copy.includes('入力が更新') && stale.csv.includes('入力が更新')
    && !stale.refreshed.includes('入力が更新'),stale,page);await page.close();
  for(const [id,election,filing,expected,year=2027,foodSale='yes',otherRestriction='yes',ordinary='no',scenario='foodProposal',filingDate] of cases){
    page=await seeded({scenario,start:`${year}-01-01`,end:`${year}-12-31`,current:'simplified'});
    const observed=await page.evaluate(o=>{
      $('advancedMode').checked=true;$('simpleElectionStatus').value=o.election;
      $('currentDiscontinuanceReady').value=o.ordinary;$('simpleNoticeReadyYes').checked=true;$('highAssetNo').checked=true;
      $('switchFoodSalesState').value=o.foodSale;$('switchSimplifiedAppliedState').value='yes';
      $('switchNoOtherRestrictionsState').value=o.otherRestriction;$('switchFilingStatus').value=o.filing;
      $('switchFilingDate').value=o.filingDate||`${o.year}-09-30`;
      $('proposalFoodClassificationState').value='confirmed';$('proposalPurchaseClassificationState').value='confirmed';
      if(o.foodSale==='no'){taxEntryRows.sales[0].rate='10';taxEntryRows.sales[0].amount='110000000';taxEntryRows.sales[0].foodAmount='';renderTaxEntryRows('sales')}
      switchDecisionOpen=true;workflowStep=4;update();
      activateCashflowMode('methodImpact');$('cashflowInterimStatus').value='none';
      $('cashflowBaseMethod').value='simplified';$('cashflowChangedMethod').value='regular';
      cashflowMethodPairTouched=true;workflowStep=5;update();
      const calc=latestCalculation.calc;
      return {regular:calc.methods.find(m=>m.key==='regular'),adapterReady:latestCashflow?.adapter?.ready,
        adapterReasons:latestCashflow?.adapter?.reasons,four:calculateProjectionPlan(calc).optimized,
        screen:$('cashflowResult').textContent,copy:cashflowExportText(latestCashflow),
        csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent};
    },{year,election,filing,foodSale,otherRestriction,ordinary,filingDate});
    const pass=expected==='four-periods-blocked'?!observed.four.ok&&/未対応/.test(observed.four.reason)
      :expected==='allowed-reference'?observed.regular.eligibility!=='ineligible'&&observed.adapterReady===true
      :observed.regular.eligibility==='ineligible'&&observed.adapterReady===false;
    await record(id,pass,observed,page);
    if(id==='FDS01_first_planned' || id==='FDS04_first_filed_hypothetical'){
      const status=id==='FDS01_first_planned' ? '届出予定' : '提出済みとの入力仮定';
      await record(`${id}_labels_and_outputs`,observed.regular.reference===true
        && observed.regular.conditional===true && observed.regular.filingExecution===(id==='FDS01_first_planned'?'planned':'filed')
        && observed.screen.includes('817,808円') && observed.copy.includes('817,808円')
        && observed.csv.includes('817808') && observed.print.includes('817,808円')
        && observed.copy.includes(status) && observed.csv.includes(status) && observed.print.includes(status),
      {status,regular:observed.regular,screen:observed.screen,copy:observed.copy,csv:observed.csv,print:observed.print},page);
    }
    if(id==='FDS01_first_planned'){
      await page.evaluate(()=>{document.body.dataset.printTarget='cashflow';prepareComparisonPrint()});
      await page.pdf({path:path.join(out,'FDS01_cashflow_print.pdf'),format:'A4',printBackground:true});
    }
    await page.close();
  }
  await browser.close();
  const report={source:'app',tests:results.length,pass:results.filter(item=>item.pass).length,
    fail:results.filter(item=>!item.pass).length,pageErrors,limitations:'Isolated about:blank Chromium and memory storage; not HTTP or persistent localStorage.',results};
  fs.writeFileSync(path.join(out,'r33-browser-results.json'),JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify({tests:report.tests,pass:report.pass,fail:report.fail,pageErrors})+'\n');
  if(report.fail||pageErrors.length) process.exitCode=1;
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1});
