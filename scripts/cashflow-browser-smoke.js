'use strict';

// Optional local browser check. Supply PLAYWRIGHT_MODULE and CHROME_PATH when
// Playwright is provided by the workspace runtime rather than this project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {REQUIRED_HEADERS} = require('../journal-csv.js');

function anonymousCsv(){
  const entry = (side,code,amount,date,business = '') => ({月日:date,
    [`${side}科目名`]:'架空の取引', [`${side}課税区分`]:code,[`${side}事業区分`]:business,
    [`${side}軽減税率か否か`]:'1',[`${side}税率`]:'8',[`${side}取引金額`]:amount});
  const entries = [entry('貸方','1',54000000,'2027/04/15','2'),entry('貸方','1',54000000,'2028/03/15','2'),
    entry('借方','5',37800000,'2027/04/15'),entry('借方','5',37800000,'2028/03/15')];
  return [REQUIRED_HEADERS,...entries.map(item => REQUIRED_HEADERS.map(header => item[header] ?? ''))]
    .map(cells => cells.join(',')).join('\r\n');
}

async function run(){
  const outputDir = path.resolve(process.argv[2] || path.join(__dirname,'..','..','shohizei-step4-review'));
  fs.mkdirSync(outputDir,{recursive:true});
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined});
  try{
    const context = await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
    await context.route('**/*',route => route.request().url().startsWith('file:') || route.request().url().startsWith('data:')
      ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(__dirname,'..','index.html')).href);
    await page.locator('#workflowStepSummary').waitFor();
    await page.locator('#compareRegular').check({force:true});
    await page.locator('label[for="entityCorporation"]').click();
    await page.locator('label[for="taxScenarioFood1"]').click();
    await page.locator('#periodStart').fill('2027-04-01');
    await page.locator('#periodEnd').fill('2028-03-31');
    await page.locator('[data-workflow-step="2"]').click();
    assert.equal(await page.locator('#workflowScreen2').isVisible(),true);
    for(const [side,code,amount] of [['sales','1','108000000'],['purchases','5','75600000']]){
      const row = page.locator(`[data-row-side="${side}"][data-row-field="code"]`).first();
      await row.fill(code);
      await row.press('Tab');
      await page.locator(`[data-row-side="${side}"][data-row-field="rate"]`).first().fill('8');
      await page.locator(`[data-row-side="${side}"][data-row-field="amount"]`).first().fill(amount);
      await page.locator(`[data-row-side="${side}"][data-row-field="foodAmount"]`).first().fill(amount);
    }
    await page.locator('#addTaxSalesRow').click();
    await page.locator('[data-row-side="sales"][data-row-field="code"]').last().fill('3');
    await page.locator('[data-row-side="sales"][data-row-field="amount"]').last().fill('0');
    await page.locator('#proposalFoodClassificationState').selectOption('confirmed');
    await page.locator('#proposalPurchaseClassificationState').selectOption('confirmed');
    await page.locator('#workflowNext').click();
    assert.equal(await page.locator('#workflowScreen4').isVisible(),true);
    const step3 = await page.locator('#methodComparisonTable').innerText();
    await page.locator('#workflowNext').click();
    assert.equal(await page.locator('#workflowScreen5').isVisible(),true);
    const partial = await page.locator('#cashflowResult').innerText();
    assert.match(partial,/部分試算|未算定/);
    await page.locator('#cashflowInterimStatus').selectOption('none');
    await page.locator('#cashflowSettlementMonth').fill('2028-05');
    await page.locator('#cashflowRefundMonth').fill('2028-05');
    const result = await page.locator('#cashflowResult').innerText();
    const table = await page.locator('#cashflowMonthlyTable').innerText();
    assert.match(result,/精算後の累積差/);
    assert.match(result,/2,100,000円/);
    assert.match(result,/0円/);
    assert.match(table,/2028-05/);
    assert.match(step3,/2,400,000円[\s\S]*300,000円/);
    const copied = await page.evaluate(() => cashflowExportText(latestCashflow));
    assert.match(copied,/2,100,000円/);
    assert.match(copied,/中間納付|確定納付/);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#downloadCsvBtn').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(),/^shohizei-cashflow-/);
    const exportedCsv = fs.readFileSync(await download.path(),'utf8');
    assert.match(exportedCsv,/最大一時資金減少,2100000/);
    assert.match(exportedCsv,/基準案|変更案/);
    await page.screenshot({path:path.join(outputDir,'step4-anonymous-screen.png'),fullPage:true});
    const printRoute = await page.evaluate(() => {
      window.__printCount = 0;
      window.print = () => { window.__printCount++; };
      document.getElementById('printBtn').click();
      return {target:document.body.dataset.printTarget,count:window.__printCount};
    });
    assert.deepEqual(printRoute,{target:'cashflow',count:1});
    await page.pdf({path:path.join(outputDir,'step4-anonymous-print.pdf'),format:'A4',printBackground:true});
    const printText = await page.locator('#cashflowPrintReport').innerText();
    assert.match(printText,/月別内訳/);
    assert.doesNotMatch(printText,/TKC 5|所内原価|顧客名/);
    await page.locator('#workflowBack').click();
    assert.equal(await page.locator('#workflowScreen4').isVisible(),true);
    await page.locator('[data-workflow-step="2"]').click();
    await page.locator('[data-row-side="sales"][data-row-field="foodAmount"]').first().fill('54000000');
    await page.locator('#workflowNext').click();
    await page.locator('#workflowNext').click();
    const changed = await page.locator('#cashflowResult').innerText();
    assert.notEqual(changed,result,'食品対象額を変えるとSTEP4も再計算する');

    const csvPage = await context.newPage();
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
    assert.equal(await csvPage.locator('#workflowScreen2').isVisible(),true,'CSV反映後の金額画面');
    await csvPage.locator('[data-row-side="sales"][data-row-field="foodAmount"]').first().fill('108000000');
    await csvPage.locator('[data-row-side="purchases"][data-row-field="foodAmount"]').first().fill('75600000');
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
    const csvDetails = await csvPage.locator('#cashflowDetails').textContent();
    const csvDistribution = await csvPage.evaluate(() => latestCashflow?.adapter?.distribution);
    assert.match(csvDetails,/CSV月別構成比による配分概算/);
    assert.equal(csvDistribution.used,'csv',JSON.stringify(csvDistribution.notes));
    await csvPage.screenshot({path:path.join(outputDir,'step4-anonymous-csv-screen.png'),fullPage:true});
    await csvPage.locator('[data-workflow-step="1"]').click();
    await csvPage.locator('#saveToDevice').check();
    await csvPage.locator('[data-workflow-step="5"]').click();
    await csvPage.reload();
    assert.equal(await csvPage.locator('#workflowScreen5').isVisible(),true,'STEP4を復元');
    assert.equal(await csvPage.locator('#cashflowDistribution').inputValue(),'csv','CSV配分設定を復元');
    const restoredDistribution = await csvPage.evaluate(() => latestCashflow?.adapter?.distribution);
    assert.equal(restoredDistribution.used,'csv',JSON.stringify(restoredDistribution.notes));
    assert.deepEqual(errors,[],'page errors');
    console.log(JSON.stringify({step3:step3.slice(0,300),partial:partial.slice(0,250),result:result.slice(0,400),changed:changed.slice(0,250),csvDistribution,csv:csvDetails.slice(0,450),print:printText.slice(0,200),printRoute,exportFile:download.suggestedFilename(),errors,outputDir},null,2));
    await context.close();
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
