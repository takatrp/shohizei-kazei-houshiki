'use strict';
// Invented data only. Serve localhost, block external requests, and keep evidence outside the repo.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {REQUIRED_HEADERS}=require('../journal-csv');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.KAZEI_EVIDENCE_DIR||'/tmp/kazei-csv-return-estimates');
if(output===root||output.startsWith(root+path.sep))throw new Error('Evidence must remain outside repository');
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
const entry=(side,code,rate,amount,date='2028/05/01')=>({月日:date,[side+'科目名']:'匿名科目',
  [side+'課税区分']:code,[side+'事業区分']:code==='1'?'2':'',[side+'軽減税率か否か']:rate===8?'1':'0',
  [side+'税率']:String(rate),[side+'取引金額']:String(amount)});
function csv(adjustment=1080){
  const rows=[entry('貸方','1',8,10800),entry('借方','1',8,adjustment),entry('貸方','1',10,11000),
    entry('借方','5',8,5400),entry('貸方','5',8,540)];
  return [REQUIRED_HEADERS.join(','),...rows.map(row=>REQUIRED_HEADERS.map(key=>row[key]??'').join(','))].join('\r\n');
}
const server=http.createServer((request,response)=>{
  let file=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(file!==root&&!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  if(file===root)file=path.join(root,'index.html');
  fs.readFile(file,(error,data)=>error?response.writeHead(404).end():response.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'}).end(data));
});
(async()=>{
  fs.mkdirSync(output,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),headless:true,args:['--no-sandbox']});
  const target=process.env.KAZEI_URL||`http://127.0.0.1:${server.address().port}/`;
  const origin=new URL(target).origin;
  const report={target,checks:[],pageErrors:[],realCustomerCsv:'not available; not tested',originalScreenshot:'not available; not inspected'};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ja-JP'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(target,{waitUntil:'domcontentloaded'});
    assert.equal(await page.evaluate(()=>ShohizeiRelease.APP_META.version),'r'+require('../package.json').version);
    const check=async(name,run)=>{try{await run();report.checks.push({name,status:'PASS'});}catch(error){report.checks.push({name,status:'FAIL',error:error.message});throw error;}};
    const seed=async()=>page.evaluate(()=>{
      resetAll();$('entityCorporation').checked=true;$('entityIndividual').checked=false;
      $('periodStart').value='2027-04-01';$('periodEnd').value='2028-03-31';
      $('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;
      $('currentReturnMethod').value='regular';$('compareRegular').checked=true;$('compareSimplified').checked=true;
      $('baseTaxableSales').value='1000000';$('simpleElectionStatus').value='none';$('regularDetailMethod').value='auto';
      $('cashflowInterimStatus').value='none';workflowStep=1;update();
      $('journalImportDisclosure').open=true;
    });
    const upload=async(adjustment)=>{
      await page.locator('#journalCsvFile').setInputFiles({name:'anonymous-estimate.csv',mimeType:'text/csv',buffer:Buffer.from(csv(adjustment))});
      await page.waitForFunction(()=>!$('applyJournalImportBtn').disabled);
      await page.evaluate(()=>applyJournalImport());
    };
    const capture=()=>page.evaluate(()=>{
      const c=calculate();renderPrintAssumptions(c);
      return {ready:c.comparisonReady,errors:c.inputErrors,sales:c.sales.totalTax,purchases:c.purchases.totalTax,
        amount:c.methods.find(m=>m.key==='regular').amount,notes:c.inputUnconfirmedItems,
        copy:buildSummaryText(c),csv:buildCsvText(c),print:$('printAssumptions').textContent,
        cards:$('methodCards').textContent,rows:taxEntryRows,daily:importedCsvDailyGroups};
    });
    const cautions=r=>{for(const text of [r.copy,r.csv,r.print])assert.match(text,/通常取引と返品・調整を分離/);assert.doesNotMatch([r.copy,r.csv,r.print].join(' '),/→0円/);};

    await check('CSV取込み・元税率調整・現行/食品切替・注意のコピー/CSV/印刷',async()=>{
      await seed();await upload();const r=await capture();assert.equal(r.ready,true,JSON.stringify(r.errors));
      close(r.sales,1020);close(r.purchases,10);close(r.amount,1010);cautions(r);
      await page.evaluate(()=>{workflowStep=1;update();$('policySimulationDetails').open=true;});
      await page.locator('label[for="taxScenarioCurrent"]').click();const current=await capture();assert.equal(current.ready,true,JSON.stringify(current.errors));assert.ok(Number.isFinite(current.amount));
      await page.evaluate(()=>$('policySimulationDetails').open=true);
      await page.locator('label[for="taxScenarioFood1"]').click();const again=await capture();close(again.amount,1010);cautions(again);
      report.import={foodAmount:r.amount,currentAmount:current.amount,salesTax:r.sales,purchaseTax:r.purchases};
    });
    await check('端末保存・リロードで原行/日別内訳/注意/税額を保持し二重計上しない',async()=>{
      const before=await capture();await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});const after=await capture();
      const rows=value=>Object.fromEntries(['sales','purchases'].map(side=>[side,value[side].map(row=>Object.fromEntries(['code','businessType','rate','amount','foodAmount','foodAmountSource','creditRatio','source','sourceDateStart','sourceDateEnd','sourceAdjustmentCount','sourceDateUnknownCount'].map(key=>[key,key.endsWith('Count')?Number(row[key]||0):String(row[key]??'')])))]));
      close(after.amount,before.amount);assert.deepEqual(rows(after.rows),rows(before.rows));assert.deepEqual(after.daily,before.daily);cautions(after);
      const stored=await page.evaluate(()=>localStorage.getItem(STORAGE_KEY));assert.ok(!stored.includes('借方科目名'));assert.ok(!stored.includes('sourceText'));
    });
    await check('将来期+10％も通常/調整の構成を保持する',async()=>{
      const r=await page.evaluate(()=>{
        const state=ShohizeiContinuationUI.snapshot();state.periods['2028-04-01|2029-03-31']={salesGrowth:'10',purchaseGrowth:'10'};
        ShohizeiContinuationUI.restore(state);update();const c=calculate(),p=ShohizeiContinuationUI.projectionPlan(c);
        return p.projections[1].snapshot;
      });
      close(r.sales.totalTax,1122);close(r.purchases.totalTax,11);close(r.regular.amount,1111);
      close(Number(r.rows.sales.find(row=>row.estimatePart==='adjustment').amount),-1188);
      report.growth={salesTax:r.sales.totalTax,purchaseTax:r.purchases.totalTax,regular:r.regular.amount};
    });
    await check('STEP4の画面/コピー/CSV/印刷にも概算注意を伝える',async()=>{
      const r=await page.evaluate(()=>{workflowStep=5;update();return {text:$('cashflowDetails').textContent,copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent,annual:latestCashflow.adapter.annualTax};});
      for(const text of [r.text,r.copy,r.csv,r.print])assert.match(text,/通常取引と返品・調整を分離/);
      assert.ok(Number.isFinite(r.annual.changed));report.step4={annual:r.annual};
      await page.locator('#cashflowDetails').evaluate(el=>{for(let p=el;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      await page.screenshot({path:path.join(output,'step4-cautions.png'),fullPage:true});
      await page.evaluate(()=>{workflowStep=4;update();});
      await page.screenshot({path:path.join(output,'comparison-cautions.png'),fullPage:true});
    });
    await check('食品内数の手入力0円を保存復元して維持する',async()=>{
      const r=await capture();const row=r.rows.sales.find(row=>row.rate==='8');
      await page.evaluate(()=>{workflowStep=2;update();});
      await page.locator(`input[data-row-side="sales"][data-row-key="${row.id}"][data-row-field="foodAmount"]`).fill('0');
      await page.locator(`input[data-row-key="${row.id}"][data-row-field="foodAmount"]`).blur();
      const changed=await capture();close(changed.amount,1710);
      await page.evaluate(()=>saveState());await page.reload({waitUntil:'domcontentloaded'});close((await capture()).amount,1710);
    });
    await check('年間純額0でも通常分と返品を消さず概算する',async()=>{
      await seed();await upload(10800);const r=await capture();assert.equal(r.ready,true,JSON.stringify(r.errors));close(r.sales,300);cautions(r);
      const zero=r.rows.sales.find(row=>row.rate==='8');assert.equal(Number(zero.amount),0);assert.equal(zero.foodAmountSource,'auto');
    });
    const setRows=async({sales,purchases,actuals=null,detail='individual'})=>page.evaluate(({sales,purchases,actuals,detail})=>{
      resetAll();$('entityCorporation').checked=true;$('periodStart').value='2028-01-01';$('periodEnd').value='2028-12-31';
      $('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;$('compareRegular').checked=true;$('compareSimplified').checked=false;
      $('currentReturnMethod').value='regular';$('regularDetailMethod').value=detail;$('baseTaxableSales').value='1000000';
      taxEntryRows={sales,purchases};entryMode='rows';rowCsvKnownZeros={nonTaxableSales:true};
      importedActualOnePercent=actuals?{...actuals,...summarizeActualOnePercentEntries(actuals.entries)}:null;
      renderTaxEntryRows('sales');renderTaxEntryRows('purchases');workflowStep=4;update();
    },{sales,purchases,actuals,detail});
    const sale={id:'s',code:'1',rate:'10',businessType:'type2',amount:'11000',foodAmount:'',source:'csv'};
    const zero={id:'z',code:'3',amount:'0',foodAmount:'',source:'csv'};
    await check('部分控除の負仕入・非課税純負額も有限の注意付き概算',async()=>{
      await setRows({sales:[sale,{...zero,amount:'10000'}],purchases:[{id:'p',code:'7',rate:'10',amount:'-880',foodAmount:'',source:'csv'}]});
      const r=await capture();assert.equal(r.ready,true,JSON.stringify(r.errors));close(r.amount,1040);
      for(const text of [r.copy,r.csv,r.print])assert.match(text,/符号付き/);
      await setRows({sales:[sale,{...zero,amount:'10000'}],purchases:[{id:'p1',code:'5',rate:'10',amount:'1100',foodAmount:'',source:'csv'},{id:'p2',code:'6',rate:'10',amount:'-880',foodAmount:'',source:'csv'}]});
      const nonTaxableReturn=await capture();assert.equal(nonTaxableReturn.ready,true,JSON.stringify(nonTaxableReturn.errors));close(nonTaxableReturn.amount,900);
      await page.evaluate(()=>{taxEntryRows.sales.find(row=>row.code==='3').amount='-100';renderTaxEntryRows('sales');update();});
      assert.equal((await capture()).ready,true);
    });
    await check('明示1％返還の既知元8％と仕入の不明用途/割合を保持する',async()=>{
      await setRows({sales:[sale,zero],purchases:[{id:'p',code:'5',rate:'10',amount:'0',foodAmount:'',source:'csv'}],actuals:{source:'csvActual',entries:[
        {kind:'sale',amount:-1080,ratePercent:1,transactionKind:'adjustment',originalRatePercent:8,originalTaxableState:'taxable',businessType:'type2',date:'2028-05-01'},
        {kind:'exemptPurchase',amount:10100,ratePercent:1,date:'',usage:'',creditRatio:''}
      ]}});
      const r=await capture();assert.equal(r.ready,true,JSON.stringify(r.errors));close(r.sales,920);close(r.purchases,100);close(r.amount,920);
      for(const text of [r.copy,r.csv,r.print]){assert.match(text,/既知の元税率8％/);assert.match(text,/控除なし（0％）/);assert.match(text,/共通対応/);}
    });
    await check('CSV日付・割合の不一致は注意を残し当期と将来期を計算する',async()=>{
      await setRows({sales:[sale,zero],purchases:[{id:'p',code:'52',rate:'10',amount:'1100',creditRatio:'80',foodAmount:'',source:'csv',sourceDateUnknownCount:1}]});
      const r=await capture();assert.equal(r.ready,true,JSON.stringify(r.errors));close(r.amount,920);
      for(const text of [r.copy,r.csv,r.print])assert.match(text,/CSV元取引日.*不明/);
      const plan=await page.evaluate(()=>ShohizeiContinuationUI.projectionPlan(calculate()));assert.ok(plan.projections.length>=4);
      assert.ok(plan.projections.every(p=>Number.isFinite(p.methods.find(m=>m.key==='regular').amount)));
    });
    await check('将来期も既知元免税を維持し、割合キー欠落で再停止しない',async()=>{
      await setRows({sales:[sale,zero],purchases:[{id:'p',code:'5',rate:'10',amount:'0',foodAmount:'',source:'csv'}],actuals:{source:'csvActual',entries:[
        {kind:'sale',amount:-1080,ratePercent:1,transactionKind:'adjustment',originalRatePercent:8,originalTaxableState:'exempt',businessType:'type2',date:'2028-05-01'},
        {kind:'exemptPurchase',amount:10100,ratePercent:1,transactionKind:'ordinary',date:'2028-05-01',usage:'taxableOnly'}
      ]}});
      const r=await capture();assert.equal(r.ready,true,JSON.stringify(r.errors));close(r.sales,1000);
      const plan=await page.evaluate(()=>ShohizeiContinuationUI.projectionPlan(calculate()));
      assert.ok(plan.projections.every(p=>Number.isFinite(p.methods.find(m=>m.key==='regular').amount)));
      for(const p of plan.projections.slice(1)){close(p.snapshot.sales.totalTax,1000);assert.match(p.methods[0].reasons.join(' '),/元CSV仕入の控除割合は未確認/);}
    });
    await check('現行税率の4期概算も明示1％仕入を消さず注意付きで保持する',async()=>{
      await page.evaluate(()=>{$('taxScenarioCurrent').checked=true;$('taxScenarioFood1').checked=false;update();});
      const p=await page.evaluate(()=>calculateProjectionPlan(calculate()));
      assert.equal(p.projections.length,4);
      for(const row of p.projections.slice(1)){assert.ok(row.snapshot.purchases.exemptCreditableTax>0);assert.ok(Number.isFinite(row.projectedRegular.amount));assert.match(row.warning,/CSV明示1％実績.*参考概算/);}
    });
    await check('現行概算の明示1％実績を申告再現額で上書きせず保存・出力する',async()=>{
      await seed();
      const rows=[entry('貸方','1',10,1100000,'2028/01/15'),
        {...entry('貸方','1',1,101000,'2028/01/15'),'貸方軽減税率か否か':'1'},
        entry('借方','5',10,110000,'2028/01/15')];
      const text=[REQUIRED_HEADERS.join(','),...rows.map(row=>REQUIRED_HEADERS.map(key=>row[key]??'').join(','))].join('\r\n');
      await page.locator('#journalCsvFile').setInputFiles({name:'anonymous-current-one-percent.csv',mimeType:'text/csv',buffer:Buffer.from(text)});
      await page.waitForFunction(()=>!$('applyJournalImportBtn').disabled);
      await page.evaluate(()=>{
        applyJournalImport();$('periodStart').value='2028-01-01';$('periodEnd').value='2028-12-31';
        $('taxScenarioCurrent').checked=true;$('taxScenarioFood1').checked=false;workflowStep=4;update();
      });
      const r=await capture();assert.equal(r.ready,true,JSON.stringify(r.errors));close(r.sales,101000);close(r.purchases,10000);close(r.amount,91000);
      const exact=await page.evaluate(()=>{const c=calculate();return {regular:c.returnCalculation.referenceCalculable,sales:Object.values(c.salesMethodCalculations).filter(Boolean).map(value=>value.referenceCalculable),print:$('comparisonPrintContent').textContent};});
      assert.equal(exact.regular,false);assert.ok(exact.sales.every(value=>value===false));
      for(const text of [r.cards,r.copy,r.csv,exact.print])assert.match(text,/91,?000/);
      for(const text of [r.copy,r.csv,r.print])assert.match(text,/CSV明示1％実績.*参考概算/);
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});close((await capture()).amount,91000);
      await page.evaluate(()=>{$('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;update();});
      await page.evaluate(()=>{$('taxScenarioCurrent').checked=true;$('taxScenarioFood1').checked=false;update();});
      close((await capture()).amount,91000);
      await page.screenshot({path:path.join(output,'current-one-percent-retained.png'),fullPage:true});
      report.currentOnePercent={salesTax:r.sales,purchaseTax:r.purchases,regular:r.amount,exactDeclaration:false};
    });
    assert.deepEqual(report.pageErrors,[]);await context.close();
  }finally{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();await new Promise(resolve=>server.close(resolve));
    console.log(JSON.stringify({output,...report},null,2));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
