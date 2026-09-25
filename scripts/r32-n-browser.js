'use strict';
// Anonymous local-HTTP Chrome check. No customer file is loaded or copied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main(){
  const root = path.resolve(__dirname,'..');
  const output = path.resolve(process.argv[2] || path.join(root,'..','shohizei-r32-n-browser'));
  fs.mkdirSync(output,{recursive:true});
  const server = http.createServer((request,response)=>{
    const requested = decodeURIComponent((request.url || '/').split('?')[0]);
    const file = path.resolve(root,'.' + (requested === '/' ? '/index.html' : requested));
    if(!file.startsWith(root + path.sep)){response.writeHead(403).end();return;}
    response.setHeader('Content-Type',file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    fs.createReadStream(file).on('error',()=>response.writeHead(404).end()).pipe(response);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined});
  const context = await browser.newContext({viewport:{width:1365,height:900},acceptDownloads:true});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  try{
    await page.goto(url);
    await page.locator('#compareRegular').check({force:true});
    await page.locator('label[for="entityCorporation"]').click();
    await page.locator('label[for="taxScenarioFood1"]').click();
    await page.locator('#periodStart').fill('2027-04-01');
    await page.locator('#periodEnd').fill('2028-03-31');
    await page.locator('#saveToDevice').check();
    await page.locator('[data-workflow-step="2"]').click();
    for(const [side,amount] of [['sales','108000000'],['purchases','75600000']]){
      const row=`[data-row-side="${side}"]`;
      await page.locator(`${row}[data-row-field="code"]`).first().fill(side==='sales'?'1':'5');
      await page.locator(`${row}[data-row-field="rate"]`).first().fill('8');
      await page.locator(`${row}[data-row-field="amount"]`).first().fill(amount);
      await page.locator(`${row}[data-row-field="foodAmount"]`).first().fill(amount);
    }
    await page.locator('#addTaxSalesRow').click();
    await page.locator('[data-row-side="sales"][data-row-field="code"]').last().fill('3');
    await page.locator('[data-row-side="sales"][data-row-field="amount"]').last().fill('0');
    await page.locator('#proposalFoodClassificationState').selectOption('confirmed');
    await page.locator('#proposalPurchaseClassificationState').selectOption('confirmed');
    await page.locator('[data-workflow-step="5"]').click();
    await page.locator('#cashflowInterimStatus').selectOption('auto');
    await page.locator('#cashflowPeriodShortening').selectOption('none');
    await page.locator('#cashflowAutoBasis').selectOption('actual');
    await page.locator('#cashflowPriorNationalTax').fill('1872000');
    await page.locator('#cashflowPriorStart').fill('2026-04-01');
    await page.locator('#cashflowPriorEnd').fill('2027-03-31');
    await page.locator('#cashflowAutoSeparate').check();
    await page.locator('#cashflowPriorChangedNationalTax').fill('0');
    await page.locator('#cashflowSettlementMonth').fill('2028-05');
    await page.locator('#cashflowRefundMonth').fill('2028-06');
    const snapshot = () => page.evaluate(()=>({checked:document.getElementById('cashflowAutoSeparate').checked,
      base:document.getElementById('cashflowPriorNationalTax').value,
      changed:document.getElementById('cashflowPriorChangedNationalTax').value,
      start:document.getElementById('cashflowPriorStart').value,end:document.getElementById('cashflowPriorEnd').value,
      basis:document.getElementById('cashflowAutoBasis').value,
      baseCount:latestCashflow.autoInterim.base.count,changedCount:latestCashflow.autoInterim.changed.count,
      baseDue:latestCashflow.autoInterim.base.installments.map(x=>[x.adjustedDueDate,x.total]),
      changedDue:latestCashflow.autoInterim.changed.installments.map(x=>[x.adjustedDueDate,x.total]),
      status:latestCashflow.engine.status,monthly:latestCashflow.engine.rows.map(x=>[x.month,x.net,x.cumulative]),
      max:latestCashflow.engine.maxDrawdown?.amount ?? 0,final:latestCashflow.engine.finalCumulative}));
    const separate = await snapshot();
    assert.equal(separate.checked,true);
    assert.equal(separate.baseCount,1);
    assert.equal(separate.changedCount,0);
    assert.equal(separate.status,'complete',JSON.stringify(await page.evaluate(()=>({reasons:latestCashflow.engine?.reasons,adapter:latestCashflow.adapter?.annualTax,auto:latestCashflow.autoInterim?.basis}))));
    await page.screenshot({path:path.join(output,'n02-one-zero-anonymous.png'),fullPage:true});
    await page.reload();
    assert.deepEqual(await snapshot(),separate,'actual localStorage reload must recalculate identical inputs and monthly result');
    await page.locator('#cashflowAutoToManual').click();
    assert.equal(await page.locator('#cashflowChangedNoInterim').isChecked(),true);
    assert.equal(await page.evaluate(()=>latestCashflow.engine.status),'complete');
    await page.locator('#cashflowInterimStatus').selectOption('auto');
    await page.locator('#cashflowPriorNationalTax').fill('0');
    const bothZero = await snapshot();
    assert.equal(bothZero.baseCount,0);
    assert.equal(bothZero.changedCount,0);
    assert.equal(bothZero.status,'complete');
    await page.locator('#cashflowAutoToManual').click();
    assert.equal(await page.locator('#cashflowBaseNoInterim').isChecked(),true);
    assert.equal(await page.locator('#cashflowChangedNoInterim').isChecked(),true);
    assert.equal(await page.evaluate(()=>latestCashflow.engine.status),'complete');
    await page.locator('#cashflowChangedNoInterim').uncheck();
    assert.equal(await page.evaluate(()=>latestCashflow.engine.status),'partial');
    await page.locator('#cashflowChangedNoInterim').check();
    await page.locator('#cashflowInterimStatus').selectOption('auto');
    await page.locator('#cashflowAutoSeparate').uncheck();
    const shared = await snapshot();
    assert.equal(shared.checked,false);
    await page.reload();
    assert.deepEqual(await snapshot(),shared,'unchecked state must survive actual localStorage reload');
    await page.evaluate(()=>{
      const key='shohizeiKazeiHoushiki.v13';
      const data=JSON.parse(localStorage.getItem(key));
      data.schemaVersion=17;data.cashflowAutoSeparate='on';delete data.cashflowAutoSeparateUnconfirmed;
      localStorage.setItem(key,JSON.stringify(data));
    });
    await page.reload();
    assert.equal(await page.locator('#cashflowAutoSeparateMigration').isVisible(),true);
    assert.equal(await page.evaluate(()=>latestCashflow.autoInterim.ready),false);
    assert.equal(await page.evaluate(()=>latestCashflow.engine.status),'partial');
    const legacyOutputs = await page.evaluate(()=>({screen:document.getElementById('cashflowAutoSummary').innerText,
      copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),
      print:document.getElementById('cashflowPrintReport').innerText}));
    for(const value of Object.values(legacyOutputs)) assert.match(value,/旧保存データ|前期額の設定が未確認/);
    await page.screenshot({path:path.join(output,'n01-legacy-unconfirmed-anonymous.png'),fullPage:true});
    await page.reload();
    assert.equal(await page.locator('#cashflowAutoSeparateMigration').isVisible(),true,'ambiguity must survive another save/reload');
    await page.locator('#cashflowConfirmSharedPrior').click();
    assert.equal(await page.evaluate(()=>latestCashflow.engine.status),'complete');
    await page.locator('#cashflowAutoBasis').selectOption('step3');
    await page.evaluate(()=>{const el=document.getElementById('regularAdjustment');el.value='4,000,000';el.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.evaluate(()=>latestCashflow.autoInterim.basis.national),null);
    assert.equal(await page.evaluate(()=>latestCashflow.engine.status),'partial');
    assert.match(await page.locator('#cashflowAutoSummary').innerText(),/前期確定国税額を入力して計算/);
    await page.screenshot({path:path.join(output,'n03-adjustment-stop-anonymous.png'),fullPage:true});
    await page.locator('#cashflowAutoBasis').selectOption('actual');
    await page.locator('#cashflowPriorNationalTax').fill('1872000');
    assert.equal(await page.evaluate(()=>latestCashflow.engine.status),'complete');
    const exportTexts = await page.evaluate(()=>({screen:document.getElementById('cashflowResult').innerText + document.getElementById('cashflowAutoSummary').innerText,
      copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:document.getElementById('cashflowPrintReport').innerText}));
    for(const value of Object.values(exportTexts)){
      assert.match(value,/1,200,000|1200000/);
      assert.match(value,/前期実績入力/);
    }
    assert.match(exportTexts.screen,/2,100,000/);
    for(const name of ['copy','csv']) assert.match(exportTexts[name],/6,400,000|6400000/);
    assert.match(exportTexts.print,/2,100,000/);
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(url).origin});
    await page.locator('#copySummaryBtn').click();
    assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),exportTexts.copy);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#downloadCsvBtn').click();
    const download = await downloadPromise;
    assert.equal(fs.readFileSync(await download.path(),'utf8').replace(/^\uFEFF/,''),exportTexts.csv);
    await page.evaluate(()=>{window.__printInvoked=false;window.print=()=>{window.__printInvoked=true;};});
    await page.locator('#printBtn').click();
    assert.equal(await page.evaluate(()=>window.__printInvoked),true);
    await page.pdf({path:path.join(output,'n03-direct-prior-anonymous.pdf'),format:'A4',printBackground:true});
    await page.locator('[data-workflow-step="4"]').click();
    await page.locator('#resetBtn').click();
    // Start another anonymous case with exactly the same period after reset.
    await page.locator('#periodStart').fill('2027-04-01');
    await page.locator('#periodEnd').fill('2028-03-31');
    assert.equal(await page.locator('#cashflowAutoSeparate').isChecked(),false);
    assert.equal(await page.locator('#cashflowPriorChangedNationalTax').inputValue(),'');
    assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'unknown');
    assert.equal(await page.locator('#cashflowBaseNoInterim').isChecked(),false);
    assert.equal(await page.locator('#cashflowChangedNoInterim').isChecked(),false);
    assert.equal(await page.locator('#cashflowAutoSeparateMigration').isVisible(),false);
    assert.deepEqual(errors,[]);
    const result = {url,storage:'real localStorage + page reload',separate,shared,bothZero,
      outputConsistency:Object.fromEntries(Object.entries(exportTexts).map(([key,value])=>[key,value.length])),
      legacyUnconfirmed:true,adjustmentStopped:true,errors,output};
    fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  }finally{
    await context.close();await browser.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
