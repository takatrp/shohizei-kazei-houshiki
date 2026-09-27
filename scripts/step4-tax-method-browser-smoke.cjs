'use strict';
// Synthetic STEP4 browser acceptance. Evidence is written outside the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.STEP4_TAX_METHOD_RESULTS_DIR || path.join(root, '..', 'shohizei-step4-tax-method-evidence'));
if (output === root || output.startsWith(root + path.sep)) throw new Error('Evidence output must stay outside the repository.');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const server = http.createServer((request, response) => {
  const target = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  if (target !== root && !target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.readFile(target === root ? path.join(root, 'index.html') : target, (error, bytes) => {
    if (error) { response.writeHead(404).end(); return; }
    response.writeHead(200, {'Content-Type':target === root ? mime['.html'] : mime[path.extname(target)] || 'text/plain; charset=utf-8'}).end(bytes);
  });
});

async function seed(page) {
  await page.evaluate(() => {
    resetAll();
    const set = (id, value) => { $(id).value = String(value); };
    $('entityCorporation').checked = true; $('entityIndividual').checked = false;
    $('taxScenarioFood1').checked = true; $('taxScenarioCurrent').checked = false;
    $('compareRegular').checked = true; $('compareSimplified').checked = true;
    $('compareSpecial2').checked = false; $('compareSpecial3').checked = false;
    $('simpleNoticeReadyYes').checked = true;
    set('periodStart', '2028-01-01'); set('periodEnd', '2028-12-31');
    set('currentReturnMethod', 'regular'); set('baseTaxableSales', '30000000');
    set('exemptPurchaseState', 'no'); set('regularDetailMethod', 'auto');
    set('proposalFoodClassificationState', 'confirmed'); set('proposalPurchaseClassificationState', 'confirmed');
    set('foodSalesPriceBasis', 'netFixed'); set('foodPurchasePriceBasis', 'netFixed');
    taxEntryRows = {sales:[
      {...newTaxEntry('sales'), code:'1', rate:'8', businessType:'type2', amount:'108000000', foodAmount:'108000000', source:'manual'},
      {...newTaxEntry('sales'), code:'3', amount:'0', rate:'', businessType:'', foodAmount:'', source:'manual'}
    ], purchases:[
      {...newTaxEntry('purchases'), code:'5', rate:'8', amount:'75600000', foodAmount:'75600000', source:'manual'}
    ]};
    rowCsvKnownZeros = {nonTaxableSales:true, exemptPurchase:true};
    entryMode = 'rows'; renderTaxEntryRows('sales'); renderTaxEntryRows('purchases');
    workflowStep = 5; update();
    $('cashflowInterimStatus').value = 'none';
    $('cashflowSettlementMonth').value = '2029-02'; $('cashflowRefundMonth').value = '2029-03';
    update();
  });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const comparison = buildCurrentRateComparison(latestCalculation.calc);
    const snap = latestCashflow;
    const panel = snap?.panelData;
    return {
      selected: [...document.querySelectorAll('#step4DisplayTaxMethodButtons button')]
        .find(button => button.getAttribute('aria-pressed') === 'true' || button.classList.contains('active'))?.dataset.step4Method || null,
      buttons: [...document.querySelectorAll('#step4DisplayTaxMethodButtons button[data-step4-method]')]
        .map(button => ({method:button.dataset.step4Method, text:button.textContent.trim(), disabled:button.disabled})),
      panelButtons: [...document.querySelectorAll('#step4PanelMethodButtons button[data-step4-method]')]
        .map(button => ({method:button.dataset.step4Method, text:button.textContent.trim(), pressed:button.getAttribute('aria-pressed')})),
      summary: $('step4MethodSummary').textContent, title: $('cashflowPanelTitle').textContent,
      status:panel?.status, labels:panel ? {A:panel.cases.A.label, B:panel.cases.B.label} : null,
      months:panel?.months, flowA:panel?.cases.A.rows.map(row => row.flow),
      flowB:panel?.cases.B.rows.map(row => row.flow),
      totalsA:panel?.cases.A.rows.map(row => row.monthTotal),
      totalsB:panel?.cases.B.rows.map(row => row.monthTotal),
      cumulativeA:panel?.cases.A.rows.map(row => row.cumulative),
      cumulativeB:panel?.cases.B.rows.map(row => row.cumulative),
      annualTax:snap?.adapter?.annualTax,
      taxEvents:snap?.engine?.rows.map(row => ({month:row.month, A:row.baseTax, B:row.changedTax})),
      deltaRows:snap?.engine?.rows.map(row => ({month:row.month, net:row.net, cumulative:row.cumulative,
        sales:row.sales, purchase:row.purchase})),
      comparisonRows:comparison?.rows.map(row => ({key:row.key, currentAmount:row.currentAmount,
        proposalAmount:row.proposalAmount, reference:row.reference, reasons:row.reasons})),
      mode:document.querySelector('input[name="cashActualMode"]:checked')?.value,
      manualValues:[...$('cashManualInputs').querySelectorAll('input[data-month]')].map(input => input.value),
      copy:cashflowExportText(snap), csv:cashflowCsvText(snap), print:$('cashflowPrintReport').textContent,
      panelText:$('cashflowPanel').textContent,
      resultText:$('cashflowResult').textContent,
      warning:$('cashflowDetails').textContent
    };
  });
}

function assertReconciles(state) {
  assert.equal(state.status?.integrity, 'ok');
  assert.ok(state.months?.length >= 12);
  for (let i = 0; i < state.months.length; i++) {
    assert.equal(state.totalsB[i] - state.totalsA[i], state.deltaRows[i].net, `month ${state.months[i]}`);
    assert.equal(state.cumulativeB[i] - state.cumulativeA[i], state.deltaRows[i].cumulative,
      `cumulative ${state.months[i]}`);
  }
}
function taxValues(state, method) {
  const step3 = state.comparisonRows.find(row => row.key === method);
  assert.ok(step3, `STEP3 ${method} row missing`);
  assert.equal(state.annualTax.base, step3.currentAmount);
  assert.equal(state.annualTax.changed, step3.proposalAmount);
  return {A:step3.currentAmount, B:step3.proposalAmount};
}
async function selectMethod(page, method) {
  await page.locator(`#step4DisplayTaxMethodButtons button[data-step4-method="${method}"]`).click();
  const state = await snapshot(page);
  assert.equal(state.selected, method);
  return state;
}
async function printPdf(page, name) {
  await page.evaluate(() => { document.body.dataset.printTarget = 'cashflow'; });
  await page.emulateMedia({media:'print'});
  const file = path.join(output, name);
  await page.pdf({path:file, format:'A4', preferCSSPageSize:true, printBackground:true});
  await page.emulateMedia({media:'screen'});
  await page.evaluate(() => { delete document.body.dataset.printTarget; });
  return file;
}

(async () => {
  fs.mkdirSync(output, {recursive:true});
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const evidence = {checks:[], pageErrors:[], output};
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}, locale:'ja-JP',
      acceptDownloads:true, permissions:['clipboard-read','clipboard-write']});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => evidence.pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil:'domcontentloaded'});
    const check = async (name, callback) => {
      try { const detail = await callback(); evidence.checks.push({name, status:'PASS', detail}); }
      catch (error) { evidence.checks.push({name, status:'FAIL', error:String(error.stack || error)}); throw error; }
    };
    await seed(page);
    let regular, simplified;
    await check('SW01-02 一般・簡易だけを表示し、一般の年税額はSTEP3一致', async () => {
      regular = await snapshot(page);
      assert.deepEqual(regular.buttons.map(button => button.method), ['regular','simplified']);
      assert.deepEqual(regular.panelButtons.map(button => button.method), ['regular','simplified']);
      assert.equal(regular.panelButtons.find(button => button.pressed === 'true')?.method,'regular');
      assert.equal(regular.selected, 'regular');
      assertReconciles(regular);
      const tax = taxValues(regular, 'regular');
      assert.match(regular.summary, /本則課税|一般課税/);
      assert.match(regular.labels.A, /本則課税|一般課税/); assert.match(regular.labels.B, /本則課税|一般課税/);
      assert.match(regular.title, /本則課税|一般課税/);
      await page.locator('#step4DisplayTaxMethodButtons').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output, 'step4-tax-method-regular-header.png')});
      await page.locator('#cashflowPanel').screenshot({path:path.join(output, 'step4-tax-method-regular.png')});
      await printPdf(page, 'step4-tax-method-regular.pdf');
      return {tax, months:regular.months.length, selected:regular.selected};
    });
    await check('SW03-07 簡易切替は日常額不変・税イベント更新・B−A一致・往復一致', async () => {
      await page.locator('#step4PanelMethodButtons button[data-step4-method="simplified"]').click();
      simplified = await snapshot(page);
      assert.equal(simplified.selected,'simplified');
      assert.equal(simplified.panelButtons.find(button => button.pressed === 'true')?.method,'simplified');
      assertReconciles(simplified);
      const tax = taxValues(simplified, 'simplified');
      assert.deepEqual(simplified.flowA, regular.flowA);
      assert.deepEqual(simplified.flowB, regular.flowB);
      assert.notDeepEqual(simplified.taxEvents, regular.taxEvents);
      assert.match(simplified.summary, /簡易課税/);
      assert.match(simplified.labels.A, /簡易課税/); assert.match(simplified.labels.B, /簡易課税/);
      assert.match(simplified.title, /簡易課税/);
      await page.locator('#step4DisplayTaxMethodButtons').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output, 'step4-tax-method-simplified-header.png')});
      await page.locator('#cashflowPanel').screenshot({path:path.join(output, 'step4-tax-method-simplified.png')});
      await printPdf(page, 'step4-tax-method-simplified.pdf');
      const again = await selectMethod(page, 'regular');
      assert.equal(again.panelButtons.find(button => button.pressed === 'true')?.method,'regular');
      assert.deepEqual(again.flowA, regular.flowA); assert.deepEqual(again.flowB, regular.flowB);
      assert.deepEqual(again.taxEvents, regular.taxEvents);
      assert.deepEqual(again.cumulativeA, regular.cumulativeA);
      assert.deepEqual(again.cumulativeB, regular.cumulativeB);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output, 'step4-tax-method-return-regular.png')});
      return {tax, regularTax:{A:regular.annualTax.base,B:regular.annualTax.changed},
        simplifiedTax:{A:simplified.annualTax.base,B:simplified.annualTax.changed}};
    });
    await check('SW10 共通の前期確定国税額による自動中間納付は当期方式切替で変わらない', async () => {
      await page.evaluate(() => {
        $('cashflowInterimStatus').value = 'auto';
        $('cashflowAutoBasis').value = 'actual';
        $('cashflowPriorNationalTax').value = '1000000';
        $('cashflowPriorStart').value = '2027-01-01';
        $('cashflowPriorEnd').value = '2027-12-31';
        $('cashflowCorporateExtension').value = 'none';
        update();
      });
      const before = await snapshot(page);
      assertReconciles(before);
      const after = await selectMethod(page, 'simplified');
      assertReconciles(after);
      const interim = state => state.taxEvents.map(row => ({month:row.month,
        A:row.A.interim, B:row.B.interim}));
      assert.ok(interim(before).some(row => row.A > 0 || row.B > 0));
      assert.deepEqual(interim(after), interim(before));
      assert.notDeepEqual(after.taxEvents, before.taxEvents);
      await page.evaluate(() => { $('cashflowInterimStatus').value = 'none'; update(); });
      await selectMethod(page, 'regular');
      return {events:interim(before).filter(row => row.A || row.B)};
    });
    await check('SW08-09 参考額と手入力の基準・月額は方式切替で不変', async () => {
      await page.locator('input[name="cashActualMode"][value="manual"]').check();
      await page.locator('#cashManualFillZeros').click();
      await page.locator('#cashManualInputs input[data-month]').nth(0).fill('250');
      await page.locator('#cashManualInputs input[data-month]').nth(1).fill('-120');
      const before = await snapshot(page);
      assertReconciles(before);
      const after = await selectMethod(page, 'simplified');
      assertReconciles(after);
      assert.equal(after.mode, 'manual'); assert.deepEqual(after.manualValues, before.manualValues);
      assert.deepEqual(after.flowA, before.flowA); assert.deepEqual(after.flowB, before.flowB);
      await page.locator('input[name="cashActualMode"][value="reference"]').check();
      const reference = await snapshot(page);
      assert.equal(reference.mode, 'reference');
      await selectMethod(page, 'regular');
      assert.equal((await snapshot(page)).mode, 'reference');
      return {manualFirstTwo:before.manualValues.slice(0,2), baseModeAfter:'reference'};
    });
    await check('SW11 比較対象から簡易を外すとボタン・旧イベントが消える', async () => {
      await selectMethod(page, 'simplified');
      await page.evaluate(() => { $('compareSimplified').checked = false; update(); });
      const state = await snapshot(page);
      assert.deepEqual(state.buttons.map(button => button.method), ['regular']);
      assert.equal(state.selected, 'regular');
      taxValues(state, 'regular');
      return {buttons:state.buttons.map(button => button.method), selected:state.selected};
    });
    await check('SW13 画面・コピー・CSV・印刷は選択方式だけを表示', async () => {
      await page.evaluate(() => { $('compareSimplified').checked = true; update(); });
      const state = await selectMethod(page, 'simplified');
      for (const text of [state.summary,state.title,state.copy,state.csv,state.print]) assert.match(text, /簡易課税/);
      assert.doesNotMatch(state.copy, /表示する課税方式：一般課税/);
      assert.doesNotMatch(state.csv, /表示する課税方式,一般課税/);
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#downloadCsvBtn').click();
      const download = await downloadPromise;
      const downloaded = path.join(output, 'step4-tax-method-simplified-download.csv');
      await download.saveAs(downloaded);
      const bytes = fs.readFileSync(downloaded, 'utf8');
      assert.match(bytes, /簡易課税/);
      await page.locator('#copySummaryBtn').click();
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(clipboard, /簡易課税/);
      return {copyChars:clipboard.length, csvChars:bytes.length, printChars:state.print.length};
    });
    await check('SW14 保存・再読込で選択した方式とSTEP3結果を復元', async () => {
      const before = await snapshot(page);
      await page.evaluate(() => { $('saveToDevice').checked = true; saveState(); });
      await page.reload({waitUntil:'domcontentloaded'});
      const after = await snapshot(page);
      assert.equal(after.selected, 'simplified');
      assertReconciles(after);
      assert.deepEqual(after.flowA, before.flowA); assert.deepEqual(after.flowB, before.flowB);
      assert.deepEqual(after.taxEvents, before.taxEvents);
      taxValues(after, 'simplified');
      return {selected:after.selected, tax:{A:after.annualTax.base,B:after.annualTax.changed}};
    });
    await check('SW12 簡易課税が適用不可になれば0円完成グラフではなく理由を表示', async () => {
      await page.evaluate(() => { $('baseTaxableSales').value = '60000000'; update(); });
      const state = await snapshot(page);
      assert.equal(state.selected, 'simplified');
      assert.ok(state.status?.renderable !== true || !state.deltaRows,
        'Ineligible simplified method must not yield a completed cashflow chart');
      assert.match(state.summary + state.resultText + state.warning, /適用対象外|適用不可|算定できません|未算定/);
      await page.evaluate(() => { $('baseTaxableSales').value = '30000000'; update(); });
      const restored = await snapshot(page);
      assertReconciles(restored);
      return {ineligible:state.resultText.slice(0,180), restored:restored.status.integrity};
    });
    await check('SW15 390pxでボタンが収まり月別表は横スクロール', async () => {
      await page.setViewportSize({width:390,height:840});
      await page.locator('#step4PanelMethodButtons button[data-step4-method="regular"]').click();
      assert.equal((await snapshot(page)).selected,'regular');
      await page.locator('#step4PanelMethodButtons button[data-step4-method="simplified"]').click();
      assert.equal((await snapshot(page)).selected,'simplified');
      const state = await page.evaluate(() => ({document:document.documentElement.scrollWidth,
        buttons:$('step4DisplayTaxMethodButtons').getBoundingClientRect().width,
        panel:$('cashflowPanel').getBoundingClientRect().width,
        buttonRects:[...$('step4DisplayTaxMethodButtons').querySelectorAll('button')].map(button => {
          const rect=button.getBoundingClientRect(); return {left:rect.left,right:rect.right,top:rect.top};
        }),
        panelButtonRects:[...$('step4PanelMethodButtons').querySelectorAll('button')].map(button => {
          const rect=button.getBoundingClientRect(); return {left:rect.left,right:rect.right,top:rect.top};
        }),
        tableScroll:$('cashflowChart').querySelector('.cf-scroll')?.scrollWidth,
        tableClient:$('cashflowChart').querySelector('.cf-scroll')?.clientWidth}));
      assert.equal(state.document, 390);
      assert.ok(state.tableScroll > state.tableClient);
      assert.ok(state.buttonRects.every(rect => rect.left >= 0 && rect.right <= 390));
      assert.ok(state.panelButtonRects.every(rect => rect.left >= 0 && rect.right <= 390));
      assert.equal(state.panelButtonRects[0].top,state.panelButtonRects[1].top);
      await page.locator('#step4DisplayTaxMethodButtons').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output, 'step4-tax-method-390-header.png')});
      await page.locator('#cashflowPanel').screenshot({path:path.join(output, 'step4-tax-method-390.png')});
      await page.setViewportSize({width:1440,height:1000});
      return state;
    });
    assert.deepEqual(evidence.pageErrors, []);
    console.log(JSON.stringify({checks:evidence.checks, pageErrors:evidence.pageErrors, output}, null, 2));
    await context.close();
  } finally {
    fs.writeFileSync(path.join(output, 'step4-tax-method-browser-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    await browser.close(); server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
