'use strict';
// Anonymous, local-only Chrome regression. Evidence is written outside this repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {REQUIRED_HEADERS} = require('../journal-csv.js');

function anonymousCsv(){
  const entry = (side,code,amount,date,business = '') => ({月日:date,
    [`${side}科目名`]:'架空の取引',[`${side}課税区分`]:code,[`${side}事業区分`]:business,
    [`${side}軽減税率か否か`]:'1',[`${side}税率`]:'8',[`${side}取引金額`]:amount});
  const entries = [entry('貸方','1',54000000,'2027/04/15','2'),entry('貸方','1',54000000,'2028/03/15','2'),
    entry('借方','5',37800000,'2027/04/15'),entry('借方','5',37800000,'2028/03/15')];
  return [REQUIRED_HEADERS,...entries.map(item => REQUIRED_HEADERS.map(header => item[header] ?? ''))]
    .map(cells => cells.join(',')).join('\r\n');
}

async function run(){
  const outputDir = path.resolve(process.argv[2] || path.join(__dirname,'..','..','shohizei-food-bulk-interim-review'));
  fs.mkdirSync(outputDir,{recursive:true});
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined});
  try{
    const context = await browser.newContext({viewport:{width:1365,height:900},acceptDownloads:true});
    await context.route('**/*',route => ['file:','data:','blob:'].some(prefix => route.request().url().startsWith(prefix)) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror',error => errors.push(error.message));
    let acceptOverwrite = false, overwriteDialogs = 0;
    page.on('dialog',async dialog => {
      overwriteDialogs++;
      if(acceptOverwrite) await dialog.accept(); else await dialog.dismiss();
    });
    await page.goto(pathToFileURL(path.join(__dirname,'..','index.html')).href);
    await page.locator('#compareRegular').check({force:true});
    await page.locator('label[for="entityCorporation"]').click();
    await page.locator('label[for="taxScenarioFood1"]').click();
    await page.locator('#periodStart').fill('2027-04-01');
    await page.locator('#periodEnd').fill('2028-03-31');
    await page.locator('[data-workflow-step="2"]').click();
    assert.equal(await page.locator('#bulkFoodSales').isDisabled(),true);
    assert.match(await page.locator('#bulkFoodSalesStatus').innerText(),/転記できる軽減8％行がありません/);
    for(const [side,code,amount] of [['sales','1','108000000'],['purchases','5','75600000']]){
      await page.locator(`[data-row-side="${side}"][data-row-field="code"]`).first().fill(code);
      await page.locator(`[data-row-side="${side}"][data-row-field="rate"]`).first().fill('8');
      await page.locator(`[data-row-side="${side}"][data-row-field="amount"]`).first().fill(amount);
    }
    const food = side => page.locator(`[data-row-side="${side}"][data-row-field="foodAmount"]`).first();
    await page.locator('#bulkFoodSales').click();
    await page.locator('#bulkFoodPurchases').click();
    assert.equal(await food('sales').inputValue(),'108,000,000');
    assert.equal(await food('purchases').inputValue(),'75,600,000');
    await food('sales').fill('54,000,000');
    await page.locator('#bulkFoodSales').click();
    assert.equal(await food('sales').inputValue(),'54,000,000','cancel must preserve every row');
    acceptOverwrite = true;
    await page.locator('#bulkFoodSales').click();
    assert.equal(await food('sales').inputValue(),'108,000,000');
    assert.equal(overwriteDialogs,2,'one confirmation per bulk operation');
    await page.locator('#addTaxSalesRow').click();
    await page.locator('[data-row-side="sales"][data-row-field="code"]').last().fill('3');
    await page.locator('[data-row-side="sales"][data-row-field="amount"]').last().fill('0');
    await page.locator('#proposalFoodClassificationState').selectOption('confirmed');
    await page.locator('#proposalPurchaseClassificationState').selectOption('confirmed');
    await page.screenshot({path:path.join(outputDir,'bulk-food-input-anonymous.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    const mobileButton = await page.locator('#bulkFoodSales').boundingBox();
    assert.ok(mobileButton && mobileButton.x >= 0 && mobileButton.x + mobileButton.width <= 390,'narrow-screen button remains in view');
    await page.screenshot({path:path.join(outputDir,'bulk-food-narrow-anonymous.png'),fullPage:true});
    await page.setViewportSize({width:1365,height:900});
    await page.locator('#workflowNext').click();
    const step3 = await page.locator('#methodComparisonTable').innerText();
    assert.match(step3,/2,400,000円[\s\S]*300,000円/);
    await page.locator('#workflowNext').click();
    await page.locator('#cashflowInterimStatus').selectOption('auto');
    await page.locator('#cashflowPeriodShortening').selectOption('none');
    const proxy = await page.locator('#cashflowAutoSummary').innerText();
    assert.match(proxy,/STEP3現行税率額の前期代理仮定/);
    assert.match(proxy,/概算/);
    assert.equal(await page.evaluate(() => latestCashflow.autoInterim.basis.national),1872000);
    await page.locator('[data-workflow-step="2"]').click();
    await page.locator('[data-row-side="sales"][data-row-field="amount"]').first().fill('109000000');
    await page.locator('[data-workflow-step="5"]').click();
    assert.notEqual(await page.evaluate(() => latestCashflow.autoInterim.basis.national),1872000,'STEP3 current input changes auto basis');
    await page.locator('[data-workflow-step="2"]').click();
    await page.locator('[data-row-side="sales"][data-row-field="amount"]').first().fill('108000000');
    await page.locator('[data-workflow-step="5"]').click();
    assert.equal(await page.evaluate(() => latestCashflow.autoInterim.basis.national),1872000);
    await page.locator('#cashflowAutoBasis').selectOption('actual');
    await page.locator('#cashflowPriorNationalTax').fill('1872000');
    await page.locator('#cashflowPriorStart').fill('2026-04-01');
    await page.locator('#cashflowPriorEnd').fill('2027-03-31');
    await page.locator('#cashflowSettlementMonth').fill('2028-05');
    await page.locator('#cashflowRefundMonth').fill('2028-05');
    const one = await page.evaluate(() => latestCashflow.autoInterim);
    assert.equal(one.base.count,1);
    assert.equal(one.base.totals.total,1200000);
    assert.equal(one.base,one.changed);
    assert.equal(await page.evaluate(() => latestCashflow.engine?.status),'complete');
    const reconciliation = await page.evaluate(() => ({annual:latestCashflow.adapter.annualTax,
      baseInterim:latestCashflow.engine.rows.reduce((sum,row) => sum + row.baseTax.interim,0),
      changedInterim:latestCashflow.engine.rows.reduce((sum,row) => sum + row.changedTax.interim,0),
      baseSettlement:latestCashflow.engine.rows.reduce((sum,row) => sum + row.baseTax.settlement,0),
      changedRefund:latestCashflow.engine.rows.reduce((sum,row) => sum + row.changedTax.refund,0),
      final:latestCashflow.engine.finalCumulative}));
    assert.equal(reconciliation.annual.base,2400000);
    assert.equal(reconciliation.annual.changed,300000);
    assert.equal(reconciliation.baseInterim,1200000);
    assert.equal(reconciliation.changedInterim,1200000);
    assert.equal(reconciliation.baseSettlement,1200000);
    assert.equal(reconciliation.changedRefund,900000);
    assert.equal(reconciliation.final,0);
    await page.screenshot({path:path.join(outputDir,'auto-interim-one-anonymous.png'),fullPage:true});
    const copied = await page.evaluate(() => cashflowExportText(latestCashflow));
    const csv = await page.evaluate(() => cashflowCsvText(latestCashflow));
    const print = await page.locator('#cashflowPrintReport').innerText();
    for(const output of [copied,csv,print]){
      assert.match(output,/1,200,000|1200000/);
      assert.match(output,/2027-11-30/);
      assert.match(output,/前期実績入力/);
    }
    const dlWait = page.waitForEvent('download');
    await page.locator('#downloadCsvBtn').click();
    const dl = await dlWait;
    assert.match(fs.readFileSync(await dl.path(),'utf8'),/2027-11-30/);
    await page.evaluate(() => {window.print = () => {}; document.getElementById('printBtn').click();});
    await page.pdf({path:path.join(outputDir,'auto-interim-anonymous-print.pdf'),format:'A4',printBackground:true});
    await page.locator('#cashflowPriorNationalTax').fill('4800001');
    assert.equal(await page.evaluate(() => latestCashflow.autoInterim.base.count),3);
    await page.locator('#cashflowPriorNationalTax').fill('48000001');
    assert.equal(await page.evaluate(() => latestCashflow.autoInterim.base.status),'unavailable','11 times requires extension confirmation');
    await page.locator('#cashflowAutoFields details summary').click();
    await page.locator('#cashflowCorporateExtension').selectOption('none');
    assert.equal(await page.evaluate(() => latestCashflow.autoInterim.base.count),11);
    await page.locator('#cashflowPriorNationalTax').fill('480000');
    assert.equal(await page.evaluate(() => latestCashflow.autoInterim.base.count),0);
    await page.locator('#cashflowPriorNationalTax').fill('1872000');
    await page.locator('#cashflowAutoToManual').click();
    assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'scheduled');
    assert.match(await page.locator('#cashflowBaseInterim').inputValue(),/2027-11,1200000/);
    await page.locator('#cashflowBaseInterim').fill('2027-11,1100000');
    await page.locator('[data-workflow-step="2"]').click();
    await food('sales').fill('54,000,000');
    await page.locator('[data-workflow-step="5"]').click();
    assert.equal(await page.locator('#cashflowBaseInterim').inputValue(),'2027-11,1100000','manual edits never overwritten');
    await page.locator('#cashflowInterimStatus').selectOption('auto');
    assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'auto');
    await page.locator('#cashflowPriorNationalTax').fill('48000001');
    await page.locator('[data-workflow-step="1"]').click();
    await page.locator('#periodStart').fill('2026-01-01');
    await page.locator('#periodEnd').fill('2026-12-31');
    await page.locator('[data-workflow-step="5"]').click();
    await page.locator('#cashflowPriorStart').fill('2025-01-01');
    await page.locator('#cashflowPriorEnd').fill('2025-12-31');
    const holiday = await page.evaluate(() => latestCashflow.autoInterim.base);
    assert.equal(holiday.count,11);
    assert.ok(holiday.installments.some(item => item.rawDueDate === '2026-10-31' && item.adjustedDueDate === '2026-11-02'));
    await page.locator('[data-workflow-step="1"]').click();
    await page.locator('label[for="entityIndividual"]').click();
    await page.locator('[data-workflow-step="5"]').click();
    const individual = await page.evaluate(() => latestCashflow.autoInterim.base);
    assert.deepEqual(individual.installments.slice(0,3).map(item => item.adjustedDueDate),['2026-06-01','2026-06-01','2026-06-01']);
    await page.locator('[data-workflow-step="1"]').click();
    await page.locator('#saveToDevice').check();
    await page.locator('[data-workflow-step="5"]').click();
    await page.reload();
    assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'auto');
    assert.equal(await page.evaluate(() => latestCashflow.autoInterim.base.count),11);
    const csvContext = await browser.newContext({viewport:{width:1280,height:900}});
    await csvContext.route('**/*',route => ['file:','data:','blob:'].some(prefix => route.request().url().startsWith(prefix)) ? route.continue() : route.abort());
    const csvPage = await csvContext.newPage();
    csvPage.on('pageerror',error => errors.push(error.message));
    csvPage.on('dialog',dialog => dialog.accept());
    await csvPage.goto(pathToFileURL(path.join(__dirname,'..','index.html')).href);
    await csvPage.locator('#compareRegular').check({force:true});
    await csvPage.locator('label[for="entityCorporation"]').click();
    await csvPage.locator('label[for="taxScenarioFood1"]').click();
    await csvPage.locator('#periodStart').fill('2027-04-01');
    await csvPage.locator('#periodEnd').fill('2028-03-31');
    await csvPage.locator('#openJournalImportBtn').click();
    await csvPage.locator('#journalCsvFile').setInputFiles({name:'anonymous.csv',mimeType:'text/csv',buffer:Buffer.from(anonymousCsv())});
    await csvPage.locator('#applyJournalImportBtn').click();
    await csvPage.locator('#bulkFoodSales').click();
    await csvPage.locator('#bulkFoodPurchases').click();
    assert.equal(await csvPage.evaluate(() => importedCsvOrigin.manualChanged),false);
    assert.equal(await csvPage.locator('[data-row-side="sales"][data-row-field="foodAmount"]').first().inputValue(),'108,000,000');
    await csvPage.locator('#addTaxSalesRow').click();
    await csvPage.locator('[data-row-side="sales"][data-row-field="code"]').last().fill('3');
    await csvPage.locator('[data-row-side="sales"][data-row-field="amount"]').last().fill('0');
    await csvPage.locator('#proposalFoodClassificationState').selectOption('confirmed');
    await csvPage.locator('#proposalPurchaseClassificationState').selectOption('confirmed');
    await csvPage.locator('#workflowNext').click();
    await csvPage.locator('#workflowNext').click();
    await csvPage.locator('#cashflowDistribution').selectOption('csv');
    await csvPage.locator('#cashflowSourceStart').fill('2027-04-01');
    await csvPage.locator('#cashflowSourceEnd').fill('2028-03-31');
    await csvPage.locator('#cashflowSourceConfirmed').check();
    assert.equal(await csvPage.evaluate(() => latestCashflow.adapter.distribution.used),'csv');
    await csvPage.locator('#cashflowInterimStatus').selectOption('auto');
    await csvPage.locator('#cashflowPeriodShortening').selectOption('none');
    await csvPage.locator('#cashflowSettlementMonth').fill('2028-05');
    await csvPage.locator('#cashflowRefundMonth').fill('2028-05');
    assert.equal(await csvPage.evaluate(() => latestCashflow.autoInterim.base.count),1);
    await csvPage.screenshot({path:path.join(outputDir,'csv-bulk-auto-anonymous.png'),fullPage:true});
    await csvPage.locator('[data-workflow-step="4"]').click();
    await csvPage.locator('#resetBtn').click();
    assert.equal(await csvPage.locator('#cashflowInterimStatus').inputValue(),'unknown');
    assert.equal(await csvPage.locator('#cashflowPriorNationalTax').inputValue(),'');
    assert.equal(await csvPage.locator('#cashflowAutoSeparate').isChecked(),false);
    await csvContext.close();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({bulk:{overwriteDialogs,step3:step3.slice(0,150)},proxy:proxy.slice(0,300),one:{count:one.base.count,total:one.base.totals.total},reconciliation,
      holiday:holiday.installments.find(item => item.rawDueDate === '2026-10-31'),individualFirst3:individual.installments.slice(0,3).map(item => item.adjustedDueDate),
      exported:dl.suggestedFilename(),errors,outputDir},null,2));
    await context.close();
  }finally{await browser.close();}
}
run().catch(error => {console.error(error);process.exitCode=1;});
