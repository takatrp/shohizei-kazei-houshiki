'use strict';
// Browser-only acceptance with synthetic amounts. Evidence stays outside the repository.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.STEP4_MANUAL_RESULTS_DIR||path.join(root,'..','shohizei-step4-manual-evidence'));
if(output===root||output.startsWith(root+path.sep))throw new Error('Evidence output must be outside the repository.');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer((request,response)=>{
  const target=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(target!==root&&!target.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  fs.readFile(target===root?path.join(root,'index.html'):target,(error,body)=>{
    if(error){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':target===root?types['.html']:types[path.extname(target)]||'text/plain; charset=utf-8'}).end(body);
  });
});

async function seed(page){
  await page.evaluate(()=>{
    resetAll();
    const set=(id,value)=>{$(id).value=String(value);};
    $('entityCorporation').checked=true;$('entityIndividual').checked=false;
    $('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;
    $('compareRegular').checked=true;$('compareSimplified').checked=true;
    $('compareSpecial2').checked=false;$('compareSpecial3').checked=false;
    set('periodStart','2028-01-01');set('periodEnd','2028-12-31');
    set('currentReturnMethod','regular');set('baseTaxableSales','30000000');
    set('exemptPurchaseState','no');set('regularDetailMethod','auto');
    set('proposalFoodClassificationState','confirmed');set('proposalPurchaseClassificationState','confirmed');
    set('foodSalesPriceBasis','netFixed');set('foodPurchasePriceBasis','netFixed');
    taxEntryRows={sales:[{...newTaxEntry('sales'),code:'1',rate:'8',businessType:'type2',amount:'108000000',foodAmount:'108000000',source:'manual'},
      {...newTaxEntry('sales'),code:'3',amount:'0',rate:'',businessType:'',foodAmount:'',source:'manual'}],
      purchases:[{...newTaxEntry('purchases'),code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'manual'}]};
    rowCsvKnownZeros={nonTaxableSales:true,exemptPurchase:true};
    entryMode='rows';renderTaxEntryRows('sales');renderTaxEntryRows('purchases');
    workflowStep=5;update();
    $('cashflowInterimStatus').value='none';
    $('cashflowSettlementMonth').value='2029-02';$('cashflowRefundMonth').value='2029-03';
    update();
  });
}

async function snapshot(page){
  return page.evaluate(()=>({
    mode:document.querySelector('input[name="cashActualMode"]:checked')?.value,
    status:latestCashflow?.panelData?.status,
    panel:latestCashflow?.panelData,
    engine:latestCashflow?.engine,
    text:$('cashflowChart').textContent,
    copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),
    print:$('cashflowPrintReport').textContent,
    taxSettings:{interim:$('cashflowInterimStatus').value,settlement:$('cashflowSettlementMonth').value,
      refund:$('cashflowRefundMonth').value,method:$('cashflowMethod').value}
  }));
}

function assertDiff(state){
  assert.equal(state.status?.integrity,'ok');
  for(let index=0;index<state.panel.months.length;index++){
    assert.equal(state.panel.cases.B.rows[index].monthTotal-state.panel.cases.A.rows[index].monthTotal,state.engine.rows[index].net);
    assert.equal(state.panel.cases.B.rows[index].cumulative-state.panel.cases.A.rows[index].cumulative,state.engine.rows[index].cumulative);
  }
}
function taxEvents(state){
  return state.engine?.rows.map(row=>({month:row.month,base:row.baseTax,changed:row.changedTax}));
}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const evidence={checks:[],pageErrors:[],output};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ja-JP',acceptDownloads:true});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route=>route.abort());
    const page=await context.newPage();
    page.on('pageerror',error=>evidence.pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    const check=async(name,fn)=>{try{const detail=await fn();evidence.checks.push({name,status:'PASS',detail});}
      catch(error){evidence.checks.push({name,status:'FAIL',error:String(error.stack||error)});throw error;}};
    await seed(page);
    let referenceState;
    await check('新規は表示用参考額、CSV試験機能は通常UIから隠す',async()=>{
      referenceState=await snapshot(page);
      assert.equal(referenceState.mode,'reference');
      assertDiff(referenceState);
      assert.equal(await page.locator('#cashManualControls').isVisible(),false);
      assert.equal(await page.locator('input[name="cashActualMode"][value="csv"]').isVisible(),false);
      assert.match(referenceState.text,/表示用参考額/);
      assert.match(referenceState.copy,/表示用参考額/);
      assert.match(referenceState.csv,/表示用参考額/);
      assert.match(referenceState.print,/表示用参考額/);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'step4-reference-desktop.png')});
      return {months:referenceState.panel.months.length,source:referenceState.status.sourceNote?.slice(0,130)};
    });
    await check('手入力へ切替、空欄は0円ではなく不足',async()=>{
      await page.locator('input[name="cashActualMode"][value="manual"]').check();
      assert.equal(await page.locator('#cashManualControls').isVisible(),true);
      const fields=page.locator('#cashManualInputs input[data-month]');
      assert.equal(await fields.count(),12);
      const first=await fields.first().inputValue();
      assert.equal(first,'');
      const state=await snapshot(page);
      assert.equal(state.mode,'manual');
      assert.equal(state.status.renderable,false);
      assert.match(state.text,/未入力|未算定|不足/);
      return {fields:await fields.count(),first,status:state.status.integrity};
    });
    await check('未入力月を明示0へ変換し、符号付き千円の変更を即時反映',async()=>{
      await page.locator('#cashManualFillZeros').click();
      const fields=page.locator('#cashManualInputs input[data-month]');
      assert.equal(await fields.first().inputValue(),'0');
      await fields.nth(0).fill('250');
      await fields.nth(1).fill('-120');
      const state=await snapshot(page);
      assertDiff(state);
      const jan=state.panel.months.indexOf('2028-01'),feb=state.panel.months.indexOf('2028-02');
      assert.equal(state.panel.cases.A.rows[jan].flow,250000);
      assert.equal(state.panel.cases.A.rows[feb].flow,-120000);
      assert.deepEqual(taxEvents(state),taxEvents(referenceState));
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'step4-manual-desktop.png')});
      return {januaryYen:state.panel.cases.A.rows[jan].flow,februaryYen:state.panel.cases.A.rows[feb].flow,
        finalDiff:state.engine.finalCumulative};
    });
    await check('参考額と手入力の往復で税イベント・入力値を維持',async()=>{
      const before=await snapshot(page);
      await page.locator('input[name="cashActualMode"][value="reference"]').check();
      const referenceAgain=await snapshot(page);
      assertDiff(referenceAgain);
      assert.deepEqual(taxEvents(referenceAgain),taxEvents(before));
      await page.locator('input[name="cashActualMode"][value="manual"]').check();
      const after=await snapshot(page);
      assertDiff(after);
      assert.deepEqual(taxEvents(after),taxEvents(before));
      assert.equal(after.panel.cases.A.rows[after.panel.months.indexOf('2028-01')].flow,250000);
      assert.deepEqual(after.taxSettings,before.taxSettings);
      return {before:before.mode,after:after.mode,taxEventMonths:taxEvents(after)?.filter(row=>
        Object.values(row.base).some(Boolean)||Object.values(row.changed).some(Boolean)).length};
    });
    await check('手入力の出典とA/B当月額をコピー・CSV・印刷に表示',async()=>{
      const state=await snapshot(page);
      assert.match(state.copy,/手入力/);
      assert.match(state.csv,/手入力/);
      assert.match(state.csv,/共通ベース/);
      assert.match(state.print,/手入力/);
      assert.match(state.print,/250/);
      await page.evaluate(()=>{document.body.dataset.printTarget='cashflow';});
      await page.emulateMedia({media:'print'});
      await page.pdf({path:path.join(output,'step4-manual-print.pdf'),format:'A4',printBackground:true});
      await page.emulateMedia({media:'screen'});
      return {copyChars:state.copy.length,csvChars:state.csv.length,printChars:state.print.length};
    });
    await check('390pxで文書全体をはみ出さず月別表は横スクロール',async()=>{
      await page.setViewportSize({width:390,height:840});
      const state=await page.evaluate(()=>({document:document.documentElement.scrollWidth,
        scroll:$('cashflowChart').querySelector('.cf-scroll')?.scrollWidth,
        client:$('cashflowChart').querySelector('.cf-scroll')?.clientWidth,
        manualScroll:$('cashManualInputs').scrollWidth,manualClient:$('cashManualInputs').clientWidth}));
      assert.equal(state.document,390);
      assert.ok(state.scroll>state.client);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'step4-manual-390.png')});
      await page.setViewportSize({width:1440,height:1000});
      return state;
    });
    await check('実ブラウザの端末保存・再読込でモードと金額を復元',async()=>{
      const before=await snapshot(page);
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});
      const after=await snapshot(page);
      assert.equal(after.mode,'manual');
      assertDiff(after);
      assert.equal(after.panel.cases.A.rows[after.panel.months.indexOf('2028-01')].flow,250000);
      assert.equal(await page.locator('#cashManualInputs input[data-month]').first().inputValue(),'250');
      assert.deepEqual(taxEvents(after),taxEvents(before));
      return {mode:after.mode,jan:after.panel.cases.A.rows[after.panel.months.indexOf('2028-01')].flow};
    });
    await check('対象期変更で旧期間の月額を新期間へ流用しない',async()=>{
      await page.evaluate(()=>{$('periodStart').value='2029-01-01';$('periodEnd').value='2029-12-31';update();});
      const state=await page.evaluate(()=>({mode:cashActualMode(),oldPeriod:cashManualRows.periodKey,
        current:cashManualResult(latestCalculation.calc).status,
        warning:$('cashManualStatus').textContent,
        first:$('cashManualInputs').querySelector('input[data-month]')?.value}));
      assert.equal(state.mode,'manual');
      assert.equal(state.oldPeriod,'2028-01-01|2028-12-31');
      assert.equal(state.current,'unconfirmed');
      assert.equal(state.first,'');
      assert.match(state.warning,/以前の対象期/);
      await page.evaluate(()=>{$('periodStart').value='2028-01-01';$('periodEnd').value='2028-12-31';update();});
      const returned=await page.evaluate(()=>({mode:cashActualMode(),status:cashManualResult(latestCalculation.calc).status,
        invalidated:cashManualInvalidated,first:$('cashManualInputs').querySelector('input[data-month]')?.value,
        note:$('cashManualStatus').textContent}));
      assert.equal(returned.mode,'manual');
      assert.equal(returned.status,'unconfirmed');
      assert.equal(returned.invalidated,true);
      assert.equal(returned.first,'');
      assert.match(returned.note,/再利用しません/);
      return {changed:state,returned};
    });
    await check('旧CSV試験機能の保存状態を無断で通常2モードへ変換しない',async()=>{
      await page.locator('#cashActualExperimental').evaluate(element=>{element.open=true;});
      await page.locator('input[name="cashActualMode"][value="csv"]').check();
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});
      const state=await page.evaluate(()=>({mode:cashActualMode(),open:$('cashActualExperimental').open,
        radioVisible:document.querySelector('input[name="cashActualMode"][value="csv"]').getBoundingClientRect().width>0}));
      assert.deepEqual(state,{mode:'csv',open:true,radioVisible:true});
      return state;
    });
    await check('完全リセットで初期参考額へ戻り旧月額を残さない',async()=>{
      const reset=await page.evaluate(()=>{
        resetAll();
        return {mode:document.querySelector('input[name="cashActualMode"]:checked')?.value,
          values:cashManualRows.values,previous:cashManualPreviousRows};
      });
      assert.equal(reset.mode,'reference');
      assert.deepEqual(reset.values,{});
      assert.equal(reset.previous,null);
      await seed(page);
      await page.locator('input[name="cashActualMode"][value="manual"]').check();
      assert.equal(await page.locator('#cashManualInputs input[data-month]').first().inputValue(),'');
      return {resetMode:reset.mode,manualRows:await page.locator('#cashManualInputs input[data-month]').count(),
        firstMonth:await page.locator('#cashManualInputs input[data-month]').first().inputValue()};
    });
    await check('月別額未入力の期間変更では旧入力再利用の警告を誤表示しない',async()=>{
      await page.evaluate(()=>{
        $('periodStart').value='2029-01-01';$('periodEnd').value='2029-12-31';update();
        $('periodStart').value='2028-01-01';$('periodEnd').value='2028-12-31';update();
      });
      const state=await page.evaluate(()=>({invalidated:cashManualInvalidated,
        status:cashManualResult(latestCalculation.calc).status,
        note:$('cashManualStatus').textContent,
        first:$('cashManualInputs').querySelector('input[data-month]')?.value}));
      assert.equal(state.invalidated,false);
      assert.equal(state.status,'unconfirmed');
      assert.equal(state.first,'');
      assert.doesNotMatch(state.note,/以前の月別金額を再利用しません/);
      return state;
    });
    assert.deepEqual(evidence.pageErrors,[]);
    console.log(JSON.stringify({checks:evidence.checks,pageErrors:evidence.pageErrors,output},null,2));
    await context.close();
  }finally{
    fs.writeFileSync(path.join(output,'step4-manual-browser-evidence.json'),JSON.stringify(evidence,null,2),'utf8');
    await browser.close();server.close();
  }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
