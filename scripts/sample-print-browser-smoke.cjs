'use strict';
// Synthetic-only UI and STEP4 print regression. Evidence stays outside the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.SAMPLE_PRINT_RESULTS_DIR || path.join(root, '..', 'shohizei-sample-print-evidence'));
if(output === root || output.startsWith(root + path.sep)) throw new Error('Evidence must stay outside the repository.');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'};
const server = http.createServer((request,response) => {
  const target = path.resolve(root, '.' + decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(target !== root && !target.startsWith(root + path.sep)){response.writeHead(403).end();return;}
  fs.readFile(target === root ? path.join(root,'index.html') : target,(error,bytes) => {
    if(error){response.writeHead(404).end();return;}
    response.writeHead(200, {'Content-Type':target === root ? mime['.html'] : mime[path.extname(target)] || 'text/plain; charset=utf-8'}).end(bytes);
  });
});

(async () => {
  fs.mkdirSync(output,{recursive:true});
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const evidence = {samples:[],errors:[],output};
  try{
    const context = await browser.newContext({viewport:{width:1365,height:900},locale:'ja-JP'});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route => route.abort());
    const page = await context.newPage();
    page.on('pageerror',error => evidence.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    const header = await page.locator('.head-actions button').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();return {top:rect.top,left:rect.left,right:rect.right};
    }));
    assert.equal(new Set(header.map(rect => rect.top)).size,1,'desktop header actions must share one row');
    await page.locator('#sampleInputMenu summary').click();
    page.once('dialog',dialog => dialog.dismiss());
    await page.locator('[data-sample-input="manufacturer"]').click();
    assert.equal(await page.evaluate(() => $('periodStart').value),'2026-01-01','cancel must keep current input');
    for(const [kind,expectedSign] of [['manufacturer',-1],['restaurant',1]]){
      page.once('dialog',dialog => dialog.accept());
      if(!(await page.locator('#sampleInputMenu').evaluate(menu => menu.open))) await page.locator('#sampleInputMenu summary').click();
      await page.locator(`[data-sample-input="${kind}"]`).click();
      const state = await page.evaluate(() => {
        const row = buildCurrentRateComparison(latestCalculation.calc).rows.find(item => item.key === 'regular');
        return {row,foodSales:taxEntryRows.sales.reduce((sum,item)=>sum+Number(item.foodAmount || 0),0),
          foodPurchases:taxEntryRows.purchases.reduce((sum,item)=>sum+Number(item.foodAmount || 0),0),
          importedCsvOrigin,entryMode,notice:$('sampleInputNotice').textContent,
          confirmed:[$('proposalFoodClassificationState').value,$('proposalPurchaseClassificationState').value]};
      });
      assert.equal(state.entryMode,'rows');assert.equal(state.importedCsvOrigin,null);
      assert.ok(state.foodSales > 0 && state.foodPurchases > 0);
      assert.equal(Math.sign(state.row.proposalAmount-state.row.currentAmount),expectedSign);
      assert.deepEqual(state.confirmed,['confirmed','confirmed']);
      assert.match(state.notice,/架空/);
      evidence.samples.push({kind,foodSales:state.foodSales,foodPurchases:state.foodPurchases,
        current:state.row.currentAmount,proposal:state.row.proposalAmount,
        difference:state.row.proposalAmount-state.row.currentAmount});
      await page.screenshot({path:path.join(output,`sample-${kind}.png`),fullPage:false});
    }
    await page.evaluate(() => {
      $('cashflowInterimStatus').value = 'none';workflowStep = 5;update();
      document.body.dataset.printTarget = 'cashflow';
    });
    await page.emulateMedia({media:'print'});
    await page.pdf({path:path.join(output,'sample-step4.pdf'),format:'A4',preferCSSPageSize:true,printBackground:true});
    await page.emulateMedia({media:'screen'});
    await page.setViewportSize({width:390,height:844});
    const mobile = await page.locator('.head-actions button').evaluateAll(buttons => buttons.map(button => {
      const rect=button.getBoundingClientRect();return {top:rect.top,right:rect.right};
    }));
    assert.equal(new Set(mobile.map(rect => rect.top)).size,1,'mobile header actions must share one row');
    assert.ok(mobile.every(rect => rect.right <= 390));
    evidence.mobileHeader = mobile;
    await page.screenshot({path:path.join(output,'sample-header-390.png')});
    assert.deepEqual(evidence.errors,[]);
    console.log(JSON.stringify(evidence,null,2));
    await context.close();
  }finally{
    fs.writeFileSync(path.join(output,'sample-print-browser-evidence.json'),JSON.stringify(evidence,null,2));
    await browser.close();server.close();
  }
})().catch(error => {console.error(error);server.close();process.exitCode=1;});
