'use strict';

// Independent, anonymous UI regression for the STEP4 review. No network or
// customer files are used. Supply PLAYWRIGHT_MODULE and CHROME_PATH as needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {REQUIRED_HEADERS} = require('../journal-csv.js');

const toolUrl = pathToFileURL(path.resolve(__dirname,'..','index.html')).href;
const record = {};

function csv(entries){
  const row = (side,code,rate,amount,date) => ({月日:date,
    [`${side}科目名`]:'架空の取引', [`${side}課税区分`]:String(code),
    [`${side}事業区分`]:'2', [`${side}軽減税率か否か`]:rate === 8 ? '1' : '',
    [`${side}税率`]:String(rate), [`${side}取引金額`]:String(amount)});
  return [REQUIRED_HEADERS,...entries.map(item => REQUIRED_HEADERS.map(header =>
    row(...item)[header] ?? ''))].map(cells => cells.join(',')).join('\r\n');
}

async function setup(page, start, end){
  await page.goto(toolUrl);
  await page.locator('#workflowStepSummary').waitFor();
  await page.locator('#compareRegular').check({force:true});
  await page.locator('label[for="entityCorporation"]').click();
  await page.locator('label[for="taxScenarioFood1"]').click();
  await page.locator('#periodStart').fill(start);
  await page.locator('#periodEnd').fill(end);
}

async function enterStep2(page){
  await page.locator('[data-workflow-step="2"]').click();
  assert.equal(await page.locator('#workflowScreen2').isVisible(),true);
}

async function row(page,side,index,{code,rate,amount,food}){
  while(await page.locator(`[data-row-side="${side}"][data-row-field="code"]`).count() <= index){
    await page.locator(side === 'sales' ? '#addTaxSalesRow' : '#addTaxPurchaseRow').click();
  }
  const field = key => page.locator(`[data-row-side="${side}"][data-row-field="${key}"]`).nth(index);
  await field('code').fill(String(code));
  await field('code').press('Tab');
  if(rate != null) await field('rate').fill(String(rate));
  await field('amount').fill(String(amount));
  if(food != null) await field('foodAmount').fill(String(food));
}

async function confirmFood(page){
  if(await page.locator('#proposalFoodClassificationState option[value="confirmed"]').isEnabled())
    await page.locator('#proposalFoodClassificationState').selectOption('confirmed');
  if(await page.locator('#proposalPurchaseClassificationState option[value="confirmed"]').isEnabled())
    await page.locator('#proposalPurchaseClassificationState').selectOption('confirmed');
}

async function step4(page){
  await page.locator('#workflowNext').click();
  assert.equal(await page.locator('#workflowScreen4').isVisible(),true,'STEP3 should be visible');
  await page.locator('#workflowNext').click();
  assert.equal(await page.locator('#workflowScreen5').isVisible(),true,'STEP4 should be visible');
}

async function importCsv(page,text){
  await page.locator('#openJournalImportBtn').click();
  await page.locator('#journalCsvFile').setInputFiles({name:'anonymous-review.csv',mimeType:'text/csv',buffer:Buffer.from(text)});
  await page.locator('#applyJournalImportBtn').click();
  assert.equal(await page.locator('#workflowScreen2').isVisible(),true,'CSV should open STEP2');
}

async function newPage(context,errors){
  const page = await context.newPage();
  page.on('pageerror',error => errors.push(error.message));
  page.on('dialog',dialog => dialog.accept());
  return page;
}

async function resetCase(context,errors,outputDir){
  const page = await newPage(context,errors);
  await setup(page,'2028-01-01','2028-12-31');
  await importCsv(page,csv([['貸方',1,8,108000000,'2028/04/15'],['借方',5,8,75600000,'2028/05/15']]));
  await page.locator('[data-row-side="sales"][data-row-field="foodAmount"]').first().fill('108000000');
  await page.locator('[data-row-side="purchases"][data-row-field="foodAmount"]').first().fill('75600000');
  await confirmFood(page);
  await step4(page);
  await page.locator('#cashflowSalesLag').selectOption('2');
  await page.locator('#cashflowPurchaseLag').selectOption('1');
  await page.locator('#cashflowDistribution').selectOption('csv');
  await page.locator('#cashflowSourceStart').fill('2028-01-01');
  await page.locator('#cashflowSourceEnd').fill('2028-12-31');
  await page.locator('#cashflowSourceConfirmed').check();
  await page.locator('#cashflowInterimStatus').selectOption('scheduled');
  await page.locator('#cashflowSameInterim').uncheck();
  await page.locator('#cashflowBaseInterim').fill('2028-08,300000');
  await page.locator('#cashflowChangedInterim').fill('2028-08,600000');
  await page.locator('#cashflowSettlementMonth').fill('2029-02');
  await page.locator('#cashflowRefundMonth').fill('2029-03');
  assert.equal(await page.locator('#cashflowSourceConfirmed').isChecked(),true,'R01 source confirmed before reset');
  assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'scheduled','R01 schedule entered before reset');
  await page.locator('[data-workflow-step="4"]').click();
  await page.locator('#resetBtn').click();
  const after = await page.evaluate(() => Object.fromEntries([
    'cashflowMethod','cashflowDistribution','cashflowSalesLag','cashflowPurchaseLag',
    'cashflowSourceStart','cashflowSourceEnd','cashflowSourceConfirmed',
    'cashflowInterimStatus','cashflowSameInterim','cashflowBaseInterim',
    'cashflowChangedInterim','cashflowSettlementMonth','cashflowRefundMonth'
  ].map(id => { const el = document.getElementById(id); return [id,el.type === 'checkbox' ? el.checked : el.value]; })));
  assert.equal(after.cashflowInterimStatus,'unknown','R01 status must reset');
  assert.equal(after.cashflowBaseInterim,'','R01 base schedule must reset');
  assert.equal(after.cashflowChangedInterim,'','R01 changed schedule must reset');
  assert.equal(after.cashflowSourceConfirmed,false,'R01 source confirmation must reset');
  assert.equal(after.cashflowSourceStart,'','R01 source start must reset');
  assert.equal(after.cashflowSourceEnd,'','R01 source end must reset');
  assert.equal(after.cashflowSalesLag,'0','R01 sales lag must reset');
  assert.equal(after.cashflowPurchaseLag,'0','R01 purchase lag must reset');
  assert.equal(after.cashflowSettlementMonth,'','R01 settlement month must reset');
  assert.equal(after.cashflowRefundMonth,'','R01 refund month must reset');
  // New company, deliberately same period to expose stale settings.
  await page.locator('#compareRegular').check({force:true});
  await page.locator('label[for="entityCorporation"]').click();
  await page.locator('label[for="taxScenarioFood1"]').click();
  await page.locator('#periodStart').fill('2028-01-01');
  await page.locator('#periodEnd').fill('2028-12-31');
  await enterStep2(page);
  await row(page,'sales',0,{code:1,rate:8,amount:21600000,food:21600000});
  await row(page,'purchases',0,{code:5,rate:8,amount:10800000,food:10800000});
  await confirmFood(page);
  await step4(page);
  assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'unknown');
  const result = await page.locator('#cashflowResult').innerText();
  assert.match(result,/部分試算|未算定/,'R01 next company tax timeline remains unconfirmed');
  await page.screenshot({path:path.join(outputDir,'r01-reset-next-company.png'),fullPage:true});
  record.R01 = {afterReset:after,nextCompanyStatus:'unknown',nextCompanyResult:result.slice(0,350)};
  await page.close();
}

async function replaceCsvCase(context,errors,outputDir){
  const page = await newPage(context,errors);
  await setup(page,'2028-01-01','2028-12-31');
  const oldCsv = csv([['貸方',1,8,5400000,'2028/01/15'],['貸方',1,8,5400000,'2028/12/15']]);
  const newCsv = csv([['貸方',1,8,2160000,'2028/01/19']]);
  await importCsv(page,oldCsv);
  await page.locator('[data-row-side="sales"][data-row-field="foodAmount"]').first().fill('10800000');
  await confirmFood(page);
  await step4(page);
  await page.locator('#cashflowDistribution').selectOption('csv');
  await page.locator('#cashflowSourceStart').fill('2028-01-01');
  await page.locator('#cashflowSourceEnd').fill('2028-12-31');
  await page.locator('#cashflowSourceEnd').press('Tab');
  await page.locator('#cashflowSourceConfirmed').check();
  assert.equal(await page.locator('#cashflowSourceConfirmed').isChecked(),true,'R04 first CSV must be confirmed before replacement');
  const before = await page.evaluate(() => ({checked:document.getElementById('cashflowSourceConfirmed').checked,
    start:document.getElementById('cashflowSourceStart').value,
    end:document.getElementById('cashflowSourceEnd').value,
    scope:importedCsvCashflowScopeKey}));
  await page.locator('[data-workflow-step="1"]').click();
  await importCsv(page,newCsv);
  const after = await page.evaluate(() => ({
    checked:document.getElementById('cashflowSourceConfirmed').checked,
    start:document.getElementById('cashflowSourceStart').value,
    end:document.getElementById('cashflowSourceEnd').value,
    scope:importedCsvCashflowScopeKey,
    groups:importedCsvMonthlyGroups?.map(group => ({month:group.month,amount:group.amount}))
  }));
  assert.equal(after.checked,false,'R04 new CSV cannot inherit confirmation');
  assert.notEqual(after.scope,before.scope,'R04 replacement should have a different CSV scope');
  await page.screenshot({path:path.join(outputDir,'r04-new-csv-unconfirmed.png'),fullPage:true});
  record.R04 = {before,after};
  await page.close();
}

async function returnCase(context,errors,outputDir,whole){
  const page = await newPage(context,errors);
  await setup(page,'2028-01-01','2028-12-31');
  const entries = whole
    ? [['貸方',1,8,10800000,'2028/04/15'],['借方',11,8,10800000,'2028/05/15']]
    : [['貸方',1,8,108000000,'2028/04/15'],['借方',11,8,10800000,'2028/05/15'],['貸方',1,10,11000000,'2028/06/15']];
  await importCsv(page,csv(entries));
  const saleFood = whole ? 10800000 : 54000000;
  const returnFood = whole ? 10800000 : 5400000;
  const salesRows = await page.evaluate(() => [...document.querySelectorAll('[data-row-side="sales"][data-row-field="code"]')]
    .map((el,index) => ({index,code:el.value,rate:document.querySelectorAll('[data-row-side="sales"][data-row-field="rate"]')[index]?.value})));
  const saleIndex = salesRows.find(row => row.code === '1' && row.rate === '8')?.index ?? -1;
  const returnIndex = salesRows.find(row => row.code === '11')?.index ?? -1;
  assert.ok(saleIndex >= 0 && returnIndex >= 0,'CSV must import code 1 and 11');
  await page.locator('[data-row-side="sales"][data-row-field="foodAmount"]').nth(saleIndex).fill(String(saleFood));
  await page.locator('[data-row-side="sales"][data-row-field="foodAmount"]').nth(returnIndex).fill(String(returnFood));
  await confirmFood(page);
  await step4(page);
  const calc = await page.evaluate(() => ({
    food:latestCalculation?.calc?.current?.sales?.foodAmount,
    step3:document.getElementById('methodComparisonTable').innerText,
    adapter:latestCashflow?.adapter,
    result:document.getElementById('cashflowResult').innerText
  }));
  if(!whole){
    assert.match(calc.step3,/8,200,000円[\s\S]*5,050,000円/,'R02 expected tax in STEP3');
    assert.match(calc.result,/3,150,000円/,'R02 expected STEP4 annual sales cash delta');
    record.R02 = {food:calc.food,step3:calc.step3.slice(0,500),step4:calc.result.slice(0,500)};
    await page.screenshot({path:path.join(outputDir,'r02-partial-return.png'),fullPage:true});
  } else {
    await page.locator('#cashflowDistribution').selectOption('csv');
    await page.locator('#cashflowSourceStart').fill('2028-01-01');
    await page.locator('#cashflowSourceEnd').fill('2028-12-31');
    await page.locator('#cashflowSourceConfirmed').check();
    const monthly = await page.evaluate(() => ({
      adapter:latestCashflow?.adapter,
      result:document.getElementById('cashflowResult').innerText,
      table:document.getElementById('cashflowMonthlyTable').innerText
    }));
    assert.equal(monthly.adapter?.distribution?.bySide?.sales,'csv','R03 sales uses CSV composition');
    assert.equal(monthly.adapter?.salesDeltas?.find(item => item.month === '2028-04')?.amount,-700000);
    assert.equal(monthly.adapter?.salesDeltas?.find(item => item.month === '2028-05')?.amount,700000);
    assert.equal(monthly.adapter?.salesDeltas?.reduce((sum,item) => sum + item.amount,0),0);
    record.R03 = {food:calc.food,distribution:monthly.adapter.distribution,
      april:monthly.adapter.salesDeltas.find(item => item.month === '2028-04'),
      may:monthly.adapter.salesDeltas.find(item => item.month === '2028-05'),
      result:monthly.result.slice(0,400)};
    await page.screenshot({path:path.join(outputDir,'r03-full-return.png'),fullPage:true});
  }
  await page.close();
}

async function policyBoundaryCase(context,errors,outputDir){
  const page = await newPage(context,errors);
  await setup(page,'2029-01-01','2029-12-31');
  await enterStep2(page);
  await row(page,'sales',0,{code:1,rate:8,amount:108000000,food:108000000});
  await row(page,'purchases',0,{code:5,rate:8,amount:75600000,food:75600000});
  await confirmFood(page);
  await step4(page);
  const data = await page.evaluate(() => ({
    adapter:latestCashflow?.adapter,
    table:document.getElementById('cashflowMonthlyTable').innerText
  }));
  assert.ok(data.adapter?.salesDeltas?.some(item => item.amount !== 0),'R05 should have nonzero policy-month deltas');
  for(const side of ['salesDeltas','purchaseDeltas']){
    const outside = data.adapter[side].filter(item => item.month > '2029-03' && item.amount !== 0);
    assert.deepEqual(outside,[],`R05 ${side} after policy period should be zero`);
  }
  assert.equal(data.adapter.salesDeltas.reduce((sum,item) => sum + item.amount,0),-1726027,'R05 annual sales delta');
  assert.equal(data.adapter.purchaseDeltas.reduce((sum,item) => sum + item.amount,0),-1208219,'R05 annual purchase delta');
  record.R05 = {sales:data.adapter.salesDeltas,purchases:data.adapter.purchaseDeltas};
  await page.screenshot({path:path.join(outputDir,'r05-policy-boundary.png'),fullPage:true});
  await page.close();
}

async function outputAndPrintCase(context,errors,outputDir){
  const page = await newPage(context,errors);
  await setup(page,'2028-01-01','2028-12-31');
  await importCsv(page,csv([['貸方',1,8,108000000,'2028/04/15']]));
  await page.locator('[data-row-side="sales"][data-row-field="foodAmount"]').first().fill('108000000');
  await row(page,'purchases',0,{code:5,rate:8,amount:75600000,food:75600000});
  await confirmFood(page);
  await step4(page);
  await page.locator('#cashflowDistribution').selectOption('csv');
  await page.locator('#cashflowSourceStart').fill('2028-01-01');
  await page.locator('#cashflowSourceEnd').fill('2028-12-31');
  await page.locator('#cashflowSourceEnd').press('Tab');
  await page.locator('#cashflowSourceConfirmed').check();
  await page.locator('#cashflowSalesLag').selectOption('2');
  await page.locator('#cashflowPurchaseLag').selectOption('2');
  await page.locator('#cashflowInterimStatus').selectOption('none');
  await page.locator('#cashflowSettlementMonth').fill('2029-02');
  await page.locator('#cashflowRefundMonth').fill('2029-03');
  const ui = await page.evaluate(() => ({distribution:latestCashflow?.adapter?.distribution,
    result:document.getElementById('cashflowResult').innerText,
    table:document.getElementById('cashflowMonthlyTable').innerText,
    print:document.getElementById('cashflowPrintReport').innerText}));
  assert.equal(ui.distribution?.used,'mixed','R08 overall distribution should be mixed');
  assert.deepEqual(ui.distribution?.bySide,{sales:'csv',purchases:'uniform'},'R08 sale CSV / purchase uniform');
  for(const value of [ui.table,ui.print]){
    assert.match(value,/仕入支払\s*資金増減/,'R06 purchase cash-effect heading');
    assert.match(value,/確定納付\s*資金増減/,'R06 settlement cash-effect heading');
    assert.match(value,/プラスは資金増、マイナスは資金減/,'R06 sign note');
    assert.match(value,/対象期の取引に係る期後の回収・支払・税金精算月/,'R06 post-period note');
  }
  assert.match(ui.print,/売上：CSV月別構成比／仕入：対象日数均等配分/,'R08 mixed print heading');
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
    writeText:async text => { window.__copiedReviewText = text; }
  }}));
  await page.locator('#copySummaryBtn').click();
  const copied = await page.evaluate(() => window.__copiedReviewText);
  assert.match(copied,/売上：CSV月別構成比／仕入：対象日数均等配分/,'R08 copied mixed label');
  assert.match(copied,/仕入支払による資金増減/,'R06 copied sign label');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadCsvBtn').click();
  const download = await downloadPromise;
  const exportedCsv = fs.readFileSync(await download.path(),'utf8');
  assert.match(exportedCsv,/売上：CSV月別構成比／仕入：対象日数均等配分/,'R08 CSV mixed label');
  assert.match(exportedCsv,/仕入支払による資金増減/,'R06 CSV sign label');
  assert.match(exportedCsv,/確定納付による資金増減/,'R06 CSV settlement label');
  await page.screenshot({path:path.join(outputDir,'r06-r08-mixed-output.png'),fullPage:true});
  const printRoute = await page.evaluate(() => {
    window.__reviewPrintCount = 0;
    window.print = () => { window.__reviewPrintCount++; };
    document.getElementById('printBtn').click();
    return {target:document.body.dataset.printTarget,count:window.__reviewPrintCount};
  });
  assert.deepEqual(printRoute,{target:'cashflow',count:1},'STEP4 print button route');
  const pdfPath = path.join(outputDir,'r06-r08-mixed-print.pdf');
  await page.pdf({path:pdfPath,format:'A4',printBackground:true});
  record.R06_R08 = {distribution:ui.distribution,printRoute,copied:copied.slice(0,500),
    csv:exportedCsv.slice(0,500),print:ui.print.slice(0,700),pdfPath};
  await page.close();
}

async function run(){
  const outputDir = path.resolve(process.argv[2] || path.join(__dirname,'..','..','shohizei-step4-review-r31'));
  fs.mkdirSync(outputDir,{recursive:true});
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined});
  const errors = [];
  try{
    const context = await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
    await context.route('**/*',route => route.request().url().startsWith('file:') || route.request().url().startsWith('data:')
      ? route.continue() : route.abort());
    const cases = {
      R01:() => resetCase(context,errors,outputDir),
      R04:() => replaceCsvCase(context,errors,outputDir),
      R02:() => returnCase(context,errors,outputDir,false),
      R03:() => returnCase(context,errors,outputDir,true),
      R05:() => policyBoundaryCase(context,errors,outputDir),
      R06_R08:() => outputAndPrintCase(context,errors,outputDir)
    };
    const selected = process.env.STEP4_REVIEW_CASE;
    if(selected && !cases[selected]) throw new Error(`Unknown STEP4_REVIEW_CASE: ${selected}`);
    for(const [id,fn] of Object.entries(cases)) if(!selected || selected === id) await fn();
    assert.deepEqual(errors,[],'browser page errors');
    fs.writeFileSync(path.join(outputDir,'step4-review-browser-results.json'),JSON.stringify({...record,errors},null,2),'utf8');
    console.log(JSON.stringify({...record,errors,outputDir},null,2));
    await context.close();
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
