'use strict';
// Anonymous local UI regressions. No external requests or repository writes.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.KAZEI_EVIDENCE_DIR||'/tmp/kazei-light-browser');
if(output===root||output.startsWith(root+path.sep))throw new Error('Evidence must remain outside repository');
const server=http.createServer((request,response)=>{
  let file=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(file!==root&&!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}if(file===root)file=path.join(root,'index.html');
  fs.readFile(file,(error,data)=>error?response.writeHead(404).end():response.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'}).end(data));
});
(async()=>{
  fs.mkdirSync(output,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const report={checks:[],pageErrors:[]};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ja-JP'});await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
    const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    const check=async(name,action)=>{try{await action();report.checks.push({name,status:'PASS'});}catch(e){report.checks.push({name,status:'FAIL',error:e.message});throw e;}};
    const input=async(id,value)=>{const node=page.locator('#'+id);await node.evaluate(el=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});if(await node.evaluate(el=>el.tagName==='SELECT'))await node.selectOption(value);else await node.fill(value);await node.blur();};
    const seed=async(scenario='foodProposal',mode='rateImpact',selection={A:'special',B:'ordinary'})=>page.evaluate(({scenario,mode,selection})=>{
      resetAll();$('entityCorporation').checked=true;$('entityIndividual').checked=false;$('periodStart').value='2027-04-01';$('periodEnd').value='2028-03-31';
      $('taxScenarioFood1').checked=scenario==='foodProposal';$('taxScenarioCurrent').checked=scenario==='current';$('currentReturnMethod').value='regular';$('exemptPurchaseState').value='no';$('baseTaxableSales').value='4000000';
      $('compareRegular').checked=true;$('compareSimplified').checked=true;$('simpleNoticeReadyYes').checked=true;$('simpleElectionStatus').value='none';$('electionFilingStatus').value='filed';$('electionFilingDate').value='2027-03-01';
      const quick=ShohizeiFourAmountEntry.build({industry:'manufacturing',foodSales:32400000,otherSales:22000000,foodPurchases:21600000,otherPurchases:15400000});
      for(const side of ['sales','purchases'])for(const row of quick.rows[side])row.source='manual';taxEntryRows=quick.rows;entryMode='rows';rowCsvKnownZeros={nonTaxableSales:true};
      const period={start:'2026-04-01',end:'2027-03-31'};sharedCaseFacts.priorActual=ShohizeiSharedCaseFacts.withPriorActual(sharedCaseFacts.priorActual,{period,nationalTax:'1092000'});syncSharedPriorActualInputs();
      ShohizeiContinuationUI.restore({version:1,prior:{period,exactMethod:'regular',foodRate:'8',foodSales:'32400000',otherSales:'22000000',foodPurchases:'21600000',otherPurchases:'15400000',nonTaxableSales:'0',adjustmentNational:'0',creditMethod:'full',...selection}});
      renderTaxEntryRows('sales');renderTaxEntryRows('purchases');activateCashflowMode(mode);
      $('cashflowInterimStatus').value='auto';$('cashflowAutoBasis').value='actual';$('cashflowPeriodShortening').value='none';$('cashflowCorporateExtension').value='none';$('cashflowSpecialCircumstances').value='none';
      $('cashflowBaseMethod').value='regular';$('cashflowChangedMethod').value='simplified';workflowStep=5;update();
    },{scenario,mode,selection});
    const capture=()=>page.evaluate(()=>({auto:latestCashflow.autoInterim,engine:latestCashflow.engine,panel:latestCashflow.panelData,annual:latestCashflow.adapter.annualTax,
      methods:calculate().methods.map(m=>({key:m.key,amount:m.amount,status:m.status,include:m.include})),state:ShohizeiContinuationUI.snapshot(),
      summary:$('cashflowAutoSummary').textContent,copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent}));
    const totals=r=>Object.fromEntries(['base','changed'].map(key=>[key,r.engine.rows.reduce((sum,row)=>sum+row[key+'Tax'].interim,0)]));
    const reconcile=r=>{assert.equal(r.engine.status,'complete');for(const key of ['base','changed'])assert.equal(r.engine.rows.reduce((sum,row)=>sum+row[key+'Tax'].interim+row[key+'Tax'].settlement-row[key+'Tax'].refund,0),r.annual[key]);};

    await check('現行税率は特例欄・中間特例出力を出さず通常納付',async()=>{
      await seed('current','methodImpact',{A:'special',B:'special'});const r=await capture();
      assert.equal(await page.locator('#foodInterimDetails').isVisible(),false);assert.equal(r.auto.foodSpecial,undefined);assert.equal(r.auto.base.totals.total,700000);
      for(const t of [r.summary,r.copy,r.csv,r.print])assert.doesNotMatch(t,/食品中間特例|明示した利用予定/);assert.match(r.summary,/通常の前期実績方式/);report.current=r;
    });
    await check('食品税率比較は入口を残し、通常納付表示・旧A指定の無効化・保存復元',async()=>{
      await seed();assert.equal(await page.locator('#foodInterimDetails > summary').isVisible(),true);
      await page.locator('#foodInterimDetails').evaluate(el=>el.open=true);assert.equal(await page.locator('#foodInterimA').isDisabled(),true);assert.equal(await page.locator('#foodInterimA').inputValue(),'ordinary');assert.equal(await page.locator('#foodInterimB').isDisabled(),false);
      const before=await capture();assert.match(before.summary,/A・Bとも通常納付/);assert.doesNotMatch(before.summary,/明示した利用予定/);assert.equal(before.auto.foodSpecial.status,'ready');
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});
      const restored=await capture();assert.equal(restored.state.prior.A,'special');assert.equal(restored.auto.base.totals.total,700000);assert.equal(restored.auto.changed.totals.total,700000);assert.equal(await page.locator('#foodInterimA').inputValue(),'ordinary');
      await input('foodInterimB','special');const r=await capture();assert.equal(r.auto.base.totals.total,700000);assert.equal(r.auto.changed.totals.total,350000);assert.deepEqual(totals(r),{base:700000,changed:350000});reconcile(r);
      for(const t of [r.summary,r.copy,r.csv,r.print])assert.match(t,/A：通常納付／B：食品特例を利用予定/);assert.ok(r.panel.status.notes.some(t=>t.includes(r.auto.interimMethodLabel)));
      report.rate={before,restored,selected:r};await page.screenshot({path:path.join(output,'rate-selected.png'),fullPage:true});
    });
    await check('食品1％の方式比較ではA/Bを独立指定してグラフと出力へ反映',async()=>{
      await seed('foodProposal','methodImpact',{A:'special',B:'ordinary'});await page.locator('#foodInterimDetails').evaluate(el=>el.open=true);assert.equal(await page.locator('#foodInterimA').isDisabled(),false);
      const first=await capture();assert.deepEqual(totals(first),{base:350000,changed:700000});reconcile(first);
      for(const t of [first.summary,first.copy,first.csv,first.print])assert.match(t,/A：食品特例を利用予定／B：通常納付/);
      await input('foodInterimB','special');const both=await capture();assert.deepEqual(totals(both),{base:350000,changed:350000});reconcile(both);assert.ok(both.panel.status.notes.some(t=>t.includes(both.auto.interimMethodLabel)));
      assert.equal(both.auto.foodSpecial.settlements.A.special.annualTax,both.annual.base);assert.equal(both.auto.foodSpecial.settlements.B.special.annualTax,both.annual.changed);
      report.method={first,both};await page.screenshot({path:path.join(output,'method-selected.png'),fullPage:true});
    });
    await check('特例資料不足は通常納付を継続し選択入口・不足理由を保持',async()=>{
      await seed('foodProposal','rateImpact',{A:'special',B:'special'});await input('foodPriorSales','');const r=await capture();
      assert.equal(r.auto.foodSpecial.special.totals,null);assert.equal(r.auto.ready,true);assert.deepEqual(totals(r),{base:700000,changed:700000});assert.match(r.summary,/A・Bとも通常納付/);
      for(const t of [r.copy,r.csv,r.print])assert.match(t,/未算定.*通常方式/);assert.equal(await page.locator('#foodInterimB').isDisabled(),false);report.missing=r;
    });
    await check('飲食店の4金額は既存5欄で税率を案内し業種・シナリオ変更で金額を保持',async()=>{
      await page.evaluate(()=>{resetAll();$('periodStart').value='2028-01-01';$('periodEnd').value='2028-12-31';$('currentReturnMethod').value='regular';$('compareRegular').checked=true;$('exemptPurchaseState').value='no';$('taxScenarioCurrent').checked=true;$('taxScenarioFood1').checked=false;workflowStep=2;update();});
      await input('quickIndustry','restaurant');const ids=['quickFoodSales','quickOtherSales','quickFoodPurchases','quickOtherPurchases'];
      for(const [i,id]of ids.entries())await input(id,String([10800000,11000000,5400000,5500000][i]));
      const snapshot=()=>page.evaluate(()=>({intro:$('quickEntryIntro').textContent,assumptions:$('quickEntryAssumptions').textContent,labels:[...$('quickEntryPanel').querySelectorAll('label')].map(el=>el.textContent),values:['quickFoodSales','quickOtherSales','quickFoodPurchases','quickOtherPurchases'].map(id=>$(id).value),amounts:[...taxEntryRows.sales,...taxEntryRows.purchases].map(r=>r.amount),controls:$('quickEntryPanel').querySelectorAll('input,select').length}));
      const initial=await snapshot();assert.equal(initial.controls,5);assert.match(initial.intro,/テイクアウト・物販.*店内飲食・酒類/);assert.doesNotMatch(initial.intro+initial.assumptions,/1％|政策試算/);assert.match(initial.labels[1],/軽減8％/);assert.match(initial.labels[2],/10％/);
      assert.equal(await page.locator('#quickFoodSales').isVisible(),true);await page.screenshot({path:path.join(output,'restaurant-current.png'),fullPage:true});
      await input('quickIndustry','manufacturing');const changed=await snapshot();assert.deepEqual(changed.values,initial.values);assert.deepEqual(changed.amounts,initial.amounts);
      await input('quickIndustry','restaurant');await page.evaluate(()=>{$('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;update();});const policy=await snapshot();assert.match(policy.intro,/1％政策試算/);assert.deepEqual(policy.values,initial.values);assert.deepEqual(policy.amounts,initial.amounts);
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});const restored=await snapshot();assert.deepEqual(restored.values,initial.values);assert.equal(await page.locator('#quickFoodSales').isVisible(),true);await page.evaluate(()=>{$('saveToDevice').checked=false;saveState();});
      report.restaurant={initial,changed,policy,restored,basis:await page.evaluate(()=>({date:APP_META.proposalBasisDate,label:APP_META.proposalBasisLabel}))};assert.equal(report.restaurant.basis.date,'2026-09-15');await page.screenshot({path:path.join(output,'restaurant.png'),fullPage:true});
    });
    assert.deepEqual(report.pageErrors,[]);console.log(JSON.stringify({checks:report.checks,pageErrors:report.pageErrors,evidence:output},null,2));
  }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
