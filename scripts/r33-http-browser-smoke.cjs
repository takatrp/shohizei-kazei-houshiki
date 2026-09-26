'use strict';
// Synthetic local-HTTP smoke test. Uses real origin storage across a reload.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const evidence=process.env.R33_EVIDENCE_DIR;
if(!evidence) throw new Error('Set R33_EVIDENCE_DIR to extracted synthetic review evidence');
const seed=fs.readFileSync(path.join(evidence,'fixture-seed.js'),'utf8');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg'};
const server=http.createServer((request,response)=>{
  const target=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(target!==root && !target.startsWith(root+path.sep)){response.writeHead(403).end();return}
  const file=target===root?path.join(root,'index.html'):target;
  fs.readFile(file,(error,body)=>{
    if(error){response.writeHead(404).end();return}
    response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'}).end(body);
  });
});
(async()=>{
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ja-JP'});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route=>route.abort());
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const url=`http://127.0.0.1:${server.address().port}/`;
    await page.goto(url,{waitUntil:'domcontentloaded'});
    await page.evaluate(`(${seed})({scenario:'foodProposal'})`);
    await page.evaluate(()=>{workflowStep=5;update()});
    await page.locator('#cashflowInterimStatus').selectOption('scheduled');
    await page.locator('#cashflowBaseInterim').fill('2028-08,123000');
    await page.locator('#cashflowBaseInterim').blur();
    await page.locator('input[name=cashflowComparisonType][value=methodImpact]').check();
    await page.locator('#cashflowInterimStatus').selectOption('none');
    await page.evaluate(()=>{workflowStep=1;update()});
    await page.locator('#saveToDevice').check();
    await page.evaluate(()=>{workflowStep=5;update()});
    const saved=await page.evaluate(()=>({key:STORAGE_KEY,stored:localStorage.getItem(STORAGE_KEY)}));
    assert.ok(saved.stored,'localStorage must contain the saved app state');
    await page.reload({waitUntil:'domcontentloaded'});
    const method=await page.evaluate(()=>({step:workflowStep,mode:cashflowComparisonType(),interim:$('cashflowInterimStatus').value}));
    await page.locator('input[name=cashflowComparisonType][value=rateImpact]').check();
    const rate=await page.evaluate(()=>({interim:$('cashflowInterimStatus').value,base:$('cashflowBaseInterim').value}));
    assert.deepEqual(method,{step:5,mode:'methodImpact',interim:'none'});
    assert.deepEqual(rate,{interim:'scheduled',base:'2028-08,123000'});
    await page.locator('input[name=cashflowComparisonType][value=methodImpact]').check();
    await page.locator('#cashflowSameSettlement').uncheck();
    await page.locator('#cashflowBaseSettlementMonth').fill('2029-06');
    await page.locator('#cashflowBaseSettlementMonth').blur();
    const beforeSwap=await page.evaluate(()=>({base:$('cashflowBaseMethod').value,changed:$('cashflowChangedMethod').value}));
    await page.locator('#cashflowSwapPlans').click();
    const swapped=await page.evaluate(()=>({base:$('cashflowBaseMethod').value,changed:$('cashflowChangedMethod').value,
      changedMonth:$('cashflowChangedSettlementMonth').value}));
    assert.equal(swapped.base,beforeSwap.changed);
    assert.equal(swapped.changed,beforeSwap.base);
    assert.equal(swapped.changedMonth,'2029-06');
    await page.evaluate(()=>{document.body.dataset.printTarget='cashflow';prepareComparisonPrint()});
    const printText=await page.locator('#cashflowPrintReport').innerText();
    const copy=await page.evaluate(()=>cashflowExportText(latestCashflow));
    const csv=await page.evaluate(()=>cashflowCsvText(latestCashflow));
    assert.match(copy,/課税方式別の資金推移/);
    assert.match(csv,/課税方式別の資金推移/);
    assert.match(printText,/課税方式別の資金推移/);
    const output=process.env.R33_RESULTS_DIR;
    if(output){
      fs.mkdirSync(output,{recursive:true});
      await page.screenshot({path:path.join(output,'R33_HTTP_method_after_swap.png'),fullPage:true});
      await page.pdf({path:path.join(output,'R33_HTTP_cashflow_print.pdf'),format:'A4',printBackground:true});
    }
    await page.evaluate(()=>resetAll());
    const reset=await page.evaluate(()=>({stored:localStorage.getItem(STORAGE_KEY),
      interim:$('cashflowInterimStatus').value,rate:cashflowModeStates.rateImpact,method:cashflowModeStates.methodImpact}));
    assert.equal(reset.stored,null);
    assert.equal(reset.interim,'auto');
    for(const mode of [reset.rate,reset.method]){
      assert.notEqual(mode?.values?.cashflowBaseInterim,'2028-08,123000');
      assert.notEqual(mode?.values?.cashflowInterimStatus,'none');
      assert.notEqual(mode?.values?.cashflowChangedSettlementMonth,'2029-06');
    }
    await page.evaluate(`(${seed})({scenario:'current'})`);
    const next=await page.evaluate(()=>({interim:$('cashflowInterimStatus').value,
      base:$('cashflowBaseInterim').value}));
    assert.deepEqual(next,{interim:'auto',base:''});
    assert.deepEqual(errors,[]);
    process.stdout.write(JSON.stringify({status:'PASS',origin:url,realLocalStorage:true,reloaded:true,
      method,rate,swapped,reset,next,copyCsvPrint:true,pageErrors:errors})+'\n');
  }finally{await browser.close()}
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1}).finally(()=>server.close());
