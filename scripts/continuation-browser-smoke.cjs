'use strict';
// Anonymous fixtures only; bind localhost and block every external request.
// PLAYWRIGHT_MODULE and CHROMIUM_PATH can point to installed cloud tools.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.KAZEI_ROOT || path.join(__dirname,'..'));
const publicUrl = process.env.KAZEI_PUBLIC_URL || '';
if(publicUrl && publicUrl !== 'https://takatrp.github.io/shohizei-kazei-houshiki/') throw new Error('Unexpected public verification target');
const output = path.resolve(process.env.KAZEI_EVIDENCE_DIR || '/tmp/kazei-continuation-browser');
if(output === root || output.startsWith(root + path.sep)) throw new Error('Browser evidence must be outside the repository');
const server = http.createServer((request,response) => {
  const pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
  let target = path.resolve(root,'.' + pathname);
  if(target !== root && !target.startsWith(root + path.sep)){response.writeHead(403).end();return;}
  if(target === root) target = path.join(root,'index.html');
  const type = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.pdf':'application/pdf'}[path.extname(target)] || 'application/octet-stream';
  fs.readFile(target,(error,body) => error ? response.writeHead(404).end() : response.writeHead(200,{'Content-Type':type}).end(body));
});

(async() => {
  fs.mkdirSync(output,{recursive:true});
  if(!publicUrl) await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const report = {checks:[],dialogs:[],pageErrors:[],requestsBlocked:0,root,publicUrl};
  try{
    const context = await browser.newContext({viewport:{width:1440,height:1050},locale:'ja-JP'});
    await context.route(/^https?:\/\//,route => {
      const url=new URL(route.request().url());
      if(publicUrl ? url.origin===new URL(publicUrl).origin : url.hostname==='127.0.0.1') return route.continue();
      report.requestsBlocked++;return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror',error => report.pageErrors.push(error.message));
    let dismissNext = false;
    page.on('dialog',async dialog => {
      report.dialogs.push({message:dialog.message(),dismissed:dismissNext});
      if(dismissNext){dismissNext=false;await dialog.dismiss();}else await dialog.accept();
    });
    const check = async(name,fn) => {
      try{await fn();report.checks.push({name,status:'PASS'});}
      catch(error){report.checks.push({name,status:'FAIL',error:error.message});throw error;}
    };
    const rowValues = rows => Object.fromEntries(['sales','purchases'].map(side => [side,
      rows[side].map(row => Object.fromEntries(['code','businessType','rate','amount','foodAmount','foodAmountSource',
        'creditRatio','importComponent','source','quickEntryField','quickEntrySignature'].map(key => [key,String(row[key] ?? '')])))]));
    const response=await page.goto(publicUrl || `http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    report.httpStatus=response.status();
    if(publicUrl){
      assert.equal(response.status(),200);
      report.release=await page.evaluate(()=>({version:ShohizeiRelease.APP_META.version,title:document.title,notice:ShohizeiRelease.APP_META.proposalBasisLabel}));
      assert.equal(report.release.version,process.env.KAZEI_EXPECTED_VERSION || 'r36.0');
      assert.match(report.release.notice,/政策試算/);
    }
    const visible = () => page.evaluate(() => ({step:workflowStep,
      controls:[...document.querySelectorAll('input,select,textarea')].filter(el => !el.disabled && el.getClientRects().length > 0).map(el => ({id:el.id,type:el.type,label:el.labels?.[0]?.textContent?.trim().replace(/\s+/g,' ')})),
      requiredBadges:[...document.querySelectorAll('.field-badge.required')].filter(el => el.getClientRects().length > 0).map(el => el.parentElement.textContent.trim().replace(/\s+/g,' '))}));
    report.initial = await visible();

    await check('食品販売型・食品仕入型は既存4ステップ3遷移を維持',async() => {
      report.samples = {};
      for(const kind of ['manufacturer','restaurant']){
        await page.evaluate(kind => loadSampleInput(kind),kind);
        await page.evaluate(() => {workflowStep=1;update();});
        const sample = {steps:[1],step1:await visible()};
        await page.locator('#workflowNext').click();
        sample.steps.push(await page.evaluate(() => workflowStep));sample.step2 = await visible();
        await page.screenshot({path:path.join(output,`${kind}-step2.png`),fullPage:true});
        await page.locator('#workflowNext').click();
        sample.steps.push(await page.evaluate(() => workflowStep));sample.step3 = await visible();
        const tax = await page.evaluate(() => ({methods:calculate().methods.map(m=>({key:m.key,amount:m.amount,status:m.status})),copy:buildSummaryText(calculate()),csv:buildCsvText(calculate())}));
        sample.outputs = tax;
        assert.ok(tax.copy.length > 0 && tax.csv.length > 0);
        await page.locator('#workflowNext').click();
        sample.steps.push(await page.evaluate(() => workflowStep));sample.step4 = await visible();
        assert.deepEqual(sample.steps,[1,2,4,5]);
        report.samples[kind] = sample;
      }
      if(process.env.KAZEI_BASELINE_REPORT){
        const before = JSON.parse(fs.readFileSync(process.env.KAZEI_BASELINE_REPORT,'utf8'));
        report.inputComparison = {beforeStep2VisibleControls:before.step2.controls.length,
          afterStep2VisibleControls:report.samples.manufacturer.step2.controls.length,
          beforeStep2RequiredBadges:before.step2.requiredBadges.length,
          afterStep2RequiredBadges:report.samples.manufacturer.step2.requiredBadges.length,
          beforeTransitions:before.transitions.length - 1,afterTransitions:report.samples.manufacturer.steps.length - 1};
        assert.ok(report.inputComparison.afterStep2RequiredBadges <= report.inputComparison.beforeStep2RequiredBadges,'Existing case must not gain mandatory fields');
      }
    });

    await check('終了日編集のblur取消は日付と両食品確認状態を復元',async() => {
      await page.evaluate(() => loadSampleInput('manufacturer'));
      await page.evaluate(() => {workflowStep=1;update();});
      const before = await page.evaluate(() => ({start:$('periodStart').value,end:$('periodEnd').value,sales:$('proposalFoodClassificationState').value,purchases:$('proposalPurchaseClassificationState').value}));
      const count = report.dialogs.length;
      await page.locator('#periodEnd').focus();
      await page.locator('#periodEnd').press('ArrowRight');
      await page.locator('#periodEnd').press('ArrowRight');
      report.periodYearTyping = [];
      for(const digit of '2028'){
        await page.keyboard.type(digit);
        report.periodYearTyping.push({digit,value:await page.locator('#periodEnd').inputValue()});
        assert.equal(report.dialogs.length,count,'No dialog while typing a year one character at a time');
      }
      await page.locator('#periodEnd').fill('2028-11-30');
      assert.equal(report.dialogs.length,count,'No dialog during input');
      dismissNext = true;
      await page.locator('#periodEnd').blur();
      const after = await page.evaluate(() => ({start:$('periodStart').value,end:$('periodEnd').value,sales:$('proposalFoodClassificationState').value,purchases:$('proposalPurchaseClassificationState').value}));
      assert.equal(report.dialogs.length,count+1);
      assert.deepEqual(after,before);
      report.periodCancellation = {before,after,dialogs:1};
      await page.screenshot({path:path.join(output,'period-cancel-restored.png'),fullPage:true});
    });

    await check('期間編集中に売上だけ修正した取消は売上確認解除・仕入確認復元',async() => {
      await page.evaluate(() => loadSampleInput('manufacturer'));
      await page.evaluate(() => {workflowStep=1;update();});
      // Start-date edits do not prompt. The end-date blur later commits or
      // cancels the same period edit, after a user has reviewed another screen.
      const before=await page.evaluate(()=>({start:$('periodStart').value,end:$('periodEnd').value,
        sales:$('proposalFoodClassificationState').value,purchases:$('proposalPurchaseClassificationState').value}));
      const dialogCount=report.dialogs.length;
      await page.locator('#periodStart').fill('2028-02-01');
      await page.locator('[data-workflow-step="2"]').click();
      assert.equal(report.dialogs.length,dialogCount);
      const amount=page.locator('[data-row-side="sales"][data-row-field="amount"]').first();
      await amount.evaluate(el=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      await amount.fill('216000000');await amount.blur();
      await page.locator('[data-workflow-step="1"]').click();
      await page.locator('#periodEnd').focus();dismissNext=true;await page.locator('#periodEnd').blur();
      const after=await page.evaluate(()=>({start:$('periodStart').value,end:$('periodEnd').value,
        sales:$('proposalFoodClassificationState').value,purchases:$('proposalPurchaseClassificationState').value,
        salesAmount:taxEntryRows.sales[0].amount}));
      assert.equal(after.start,before.start);assert.equal(after.end,before.end);
      assert.equal(after.sales,'unknown');assert.equal(after.purchases,'confirmed');
      assert.equal(Number(after.salesAmount.replaceAll(',','')),216000000);
      assert.equal(report.dialogs.length,dialogCount+1);
      report.periodCancellationAfterSalesEdit={before,after};
      await page.screenshot({path:path.join(output,'period-cancel-sales-edit.png'),fullPage:true});
    });

    await check('4金額→詳細入力は税込一致し比較・CSV・保存復元へ接続',async() => {
      await page.evaluate(() => {
        resetAll();$('entityCorporation').checked=true;$('entityIndividual').checked=false;
        $('periodStart').value='2028-01-01';$('periodEnd').value='2028-12-31';
        $('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;
        $('compareRegular').checked=true;$('baseTaxableSales').value='40000000';
        $('currentReturnMethod').value='regular';resetProposalPeriodConfirmation();update();
      });
      await page.locator('#workflowNext').click();
      await page.locator('#quickIndustry').selectOption('manufacturing');
      for(const [id,value] of Object.entries({quickFoodSales:'1080000',quickOtherSales:'110000',quickFoodPurchases:'540000',quickOtherPurchases:'220000'})) await page.locator('#'+id).fill(value);
      await page.locator('#quickOtherPurchases').blur();
      const state = await page.evaluate(() => ({rows:taxEntryRows,aggregate:aggregateTaxRows(taxEntryRows),salesConfirmation:$('proposalFoodClassificationState').value,purchaseConfirmation:$('proposalPurchaseClassificationState').value}));
      assert.equal(state.aggregate.ready,true);
      for(const [id,value] of Object.entries({type3Sale8:1080000,type3Sale10:110000,type3SaleFood1:1080000,purchase8:540000,purchase10:220000,purchaseFood1:540000})) assert.equal(state.aggregate.fields[id].value,value,id);
      assert.equal(state.salesConfirmation,'unknown');assert.equal(state.purchaseConfirmation,'unknown');
      report.quickRows = state.rows;
      await page.screenshot({path:path.join(output,'quick-four-amounts.png'),fullPage:true});
      await page.evaluate(() => {$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});
      assert.deepEqual(rowValues(await page.evaluate(() => taxEntryRows)),rowValues(state.rows),'Saved rows keep their detailed structure');
      assert.equal(await page.evaluate(() => ShohizeiFourAmountEntry.editable({rows:taxEntryRows})),true,'Untouched compact rows remain editable after reload');
      await page.locator('#workflowNext').click();
      const outputs = await page.evaluate(() => {const calc=calculate();return {methods:calc.methods.map(m=>({key:m.key,amount:m.amount,status:m.status})),copy:buildSummaryText(calc),csv:buildCsvText(calc)};});
      // Independent check: sales 1,000,000*1%+100,000*10%=20,000;
      // purchases 500,000*1%+200,000*10%=25,000, therefore a 5,000 refund.
      assert.equal(outputs.methods.find(m=>m.key==='regular').amount,-5000);
      assert.match(outputs.copy,/5,000/);assert.match(outputs.csv,/-5000/);
      report.quickOutputs = outputs;
    });

    await check('詳細手修正後は4金額による上書きを止めて入力を保存',async() => {
      await page.evaluate(() => {workflowStep=2;update();});
      // Open an optional enclosing details through the DOM before interacting.
      const detail = page.locator('[data-row-side="sales"][data-row-field="amount"]').first();
      await detail.evaluate(el => {for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      await detail.fill('2160000');await detail.blur();
      const edited = await page.evaluate(() => structuredClone(taxEntryRows));
      assert.equal(Number(edited.sales[0].amount.replaceAll(',','')),2160000);
      assert.equal(await page.evaluate(() => ShohizeiFourAmountEntry.editable({rows:taxEntryRows})),false);
      assert.equal(await page.locator('#quickFoodSales').isDisabled(),true);
      assert.equal(await page.locator('#quickFoodSales').isVisible(),false,'Hide stale compact draft after a detailed edit');
      assert.match(await page.locator('#quickEntryStatus').innerText(),/2,160,000/,'Read-only compact summary follows detailed amount');
      await page.evaluate(() => saveState());await page.reload({waitUntil:'domcontentloaded'});
      assert.deepEqual(rowValues(await page.evaluate(() => taxEntryRows)),rowValues(edited));
      report.detailsAfterReload = edited;
    });

    await check('390px表示・印刷の実ブラウザ出力',async() => {
      await page.setViewportSize({width:390,height:844});
      const width = await page.evaluate(() => ({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      assert.ok(width.document <= width.viewport + 1,JSON.stringify(width));
      await page.screenshot({path:path.join(output,'quick-detail-390.png'),fullPage:true});
      await page.setViewportSize({width:1440,height:1050});
      await page.evaluate(() => {workflowStep=4;update();});
      await page.emulateMedia({media:'print'});
      await page.pdf({path:path.join(output,'comparison-print.pdf'),format:'A4',printBackground:true});
      report.printPdfCreated = true;
    });
    assert.deepEqual(report.pageErrors,[],'No browser JavaScript errors');
    console.log(JSON.stringify({checks:report.checks,inputComparison:report.inputComparison,pageErrors:report.pageErrors,evidence:output},null,2));
  }finally{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    await browser.close();server.close();
  }
})().catch(error => {console.error(error);process.exitCode=1;server.close();});
