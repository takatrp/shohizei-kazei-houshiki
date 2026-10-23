'use strict';
// Invented fixtures only. Screenshots and results must remain outside the repository.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.IMPORT_PERIOD_RESULTS_DIR||path.join(root,'..','shohizei-import-period-evidence'));
if(output===root||output.startsWith(root+path.sep)) throw new Error('Evidence must stay outside the repository.');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.pdf':'application/pdf'};
const server=http.createServer((request,response)=>{
  const target=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(target!==root&&!target.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  const file=target===root?path.join(root,'index.html'):target;
  fs.readFile(file,(error,body)=>{if(error){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain; charset=utf-8'}).end(body);});
});
const headers=['月日','税','業','借方CD','借方科目名','貸方CD','貸方科目名','取引金額','税率','内、消費税等','控','税抜き金額','取引年月日','元帳摘要（仕入れ資産等の総称）'];
const fx=(code,amount,memo,rate='軽 8.0%')=>({'月日':'1.15','税':code,'業':code==='1'?'2':'','借方CD':'100','借方科目名':'合成仕入','貸方CD':'200','貸方科目名':'普通預金','取引金額':amount,'税率':rate,'取引年月日':'20280115','元帳摘要（仕入れ資産等の総称）':memo});
const csv=()=>[headers,...[
  fx('1',1080000,'合成売上'),fx('3',250000,'合成非課税売上',''),
  fx('55',100000,'商品仕入'),fx('55',200000,'商品仕入'),fx('55',10000,'輸入関税'),
  fx('55',6240,'輸入消費税'),fx('55',1760,'地方消費税'),
  fx('65',3120,'輸入消費税'),fx('65',880,'地方消費税'),
  fx('75',6240,'輸入消費税'),fx('75',1760,'地方消費税'),fx('75',800,'分類不能')
].map(row=>headers.map(key=>row[key]??''))].map(row=>row.map(value=>`"${String(value).replace(/"/g,'""')}"`).join(',')).join('\r\n');

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const target=process.env.IMPORT_PERIOD_BASE_URL||`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/chromium'});
  const evidence={target,checks:[],dialogs:[],pageErrors:[],consoleErrors:[],consoleWarnings:[],expectedInvalidDateWarnings:[]};
  const check=async(name,fn)=>{await fn();evidence.checks.push({name,status:'PASS'});};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ja-JP',acceptDownloads:true});
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      return url.origin===new URL(target).origin?route.continue():route.fulfill({status:200,body:''});
    });
    const page=await context.newPage();let accept=true;
    page.on('dialog',async dialog=>{evidence.dialogs.push(dialog.message());await (accept?dialog.accept():dialog.dismiss());});
    page.on('pageerror',error=>evidence.pageErrors.push(error.message));
    page.on('console',message=>{
      if(message.type()==='error')evidence.consoleErrors.push(message.text());
      if(message.type()==='warning'){
        if(message.text().startsWith('The specified value "2028-02-30"')) evidence.expectedInvalidDateWarnings.push(message.text());
        else evidence.consoleWarnings.push(message.text());
      }
    });
    await page.goto(target,{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>loadSampleInput('manufacturer'));
    const period=async(start,end)=>page.evaluate(({start,end})=>{
      $('entityCorporation').checked=true;$('entityIndividual').checked=false;
      $('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;
      $('periodStart').value=start;$('periodEnd').value=end;update();
    },{start,end});
    const snapshot=()=>page.evaluate(()=>({check:latestCalculation.calc.proposalPeriodCheck,step:workflowStep,
      methods:latestCalculation.calc.methods.map(row=>({key:row.key,amount:row.amount,include:row.include})),
      ready:latestCalculation.calc.comparisonReady,alert:!$('proposalPeriodBlockedNotice').classList.contains('is-hidden'),
      next:$('workflowNext').disabled,nav:[...document.querySelectorAll('[data-workflow-step]')].filter(button=>button.dataset.workflowStep!=='1').map(button=>button.disabled),
      output:['copySummaryBtn','downloadCsvBtn','printBtn','printComparisonBtn'].map(id=>$(id).disabled),
      csv:buildCsvText(latestCalculation.calc),interim:$('cashflowInterimStatus').value}));
    await check('法人1％の両側期間外で警告・画面進行・税額・出力を停止',async()=>{
      for(const [start,end] of [['2026-04-01','2027-03-31'],['2029-04-01','2030-03-31']]){
        await period(start,end);const state=await snapshot();
        assert.equal(state.check.outside,true);assert.equal(state.alert,true);assert.equal(state.step,1);
        assert.equal(state.ready,false);assert.equal(state.next,true);assert.ok(state.nav.every(Boolean));assert.ok(state.output.every(Boolean));
        assert.ok(state.methods.every(row=>row.amount===null&&!row.include));
        assert.match(state.csv,/課税期間.*2027年4月1日|比較対象課税期間/);
        await page.evaluate(()=>{workflowStep=5;update();});assert.equal((await snapshot()).step,1);
      }
      await page.locator('#proposalPeriodBlockedNotice').screenshot({path:path.join(output,'period-block-desktop.png')});
    });
    await check('閉区間両端の1日重複と両端をまたぐ期間で解除',async()=>{
      for(const [start,end] of [['2027-04-01','2027-04-01'],['2029-03-31','2029-03-31'],['2026-04-02','2027-04-01'],['2029-03-31','2030-03-30'],['2026-01-01','2030-12-31']]){
        await period(start,end);const state=await snapshot();assert.equal(state.check.valid,true);assert.equal(state.alert,false);assert.equal(state.next,false);assert.ok(state.output.every(value=>!value));
      }
    });
    await check('空欄・HTMLで無効な日付・逆順は未算定、修正すると復帰',async()=>{
      for(const [start,end] of [['','2028-12-31'],['2028-01-01',''],['2028-02-30','2028-12-31'],['2028-12-31','2028-01-01']]){
        await period(start,end);const state=await snapshot();assert.equal(state.check.valid,false);assert.equal(state.check.outside,false);assert.equal(state.alert,true);assert.ok(state.methods.every(row=>row.amount===null));
      }
      await period('2028-01-01','2028-12-31');assert.equal((await snapshot()).alert,false);
    });
    await check('現行・個人へのモード切替で解除し、法人1％へ戻すと再停止',async()=>{
      await period('2026-01-01','2026-12-31');
      await page.locator('label[for="taxScenarioCurrent"]').click();assert.equal((await snapshot()).alert,false);
      await page.locator('label[for="taxScenarioFood1"]').click();assert.equal((await snapshot()).alert,true);
      await page.locator('label[for="entityIndividual"]').click();assert.equal((await snapshot()).alert,false);
      await page.locator('label[for="entityCorporation"]').click();assert.equal((await snapshot()).alert,true);
    });
    await check('期間外・有効期間の保存復元は警告と進行状態を再評価',async()=>{
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});
      assert.equal((await snapshot()).alert,true);assert.equal((await snapshot()).step,1);
      await period('2028-01-01','2028-12-31');await page.reload({waitUntil:'domcontentloaded'});assert.equal((await snapshot()).alert,false);
    });
    await check('非1年の取消では期間・計算・端末保存を変えず、承認後も自動中間未算定',async()=>{
      const before=await page.evaluate(()=>({saved:storageGet(STORAGE_KEY),end:$('periodEnd').value,amount:latestCalculation.calc.methods.map(row=>row.amount)}));
      accept=false;await page.locator('#periodEnd').fill('2028-06-30');await page.locator('#periodEnd').dispatchEvent('change');
      const after=await page.evaluate(()=>({saved:storageGet(STORAGE_KEY),end:$('periodEnd').value,amount:latestCalculation.calc.methods.map(row=>row.amount)}));assert.deepEqual(after,before);
      accept=true;await page.locator('#periodEnd').fill('2028-06-30');await page.locator('#periodEnd').dispatchEvent('change');
      assert.equal(await page.locator('#proposalPeriodConfirmationNotice').isVisible(),true);assert.equal((await snapshot()).interim,'unknown');
      assert.ok(evidence.dialogs.includes('中間納付が自動計算されませんがよろしいですか？'));
      await period('2028-01-01','2028-12-31');
    });
    await check('匿名FX4 CSVを選択し、55・65・75の候補を集約、未分類は未算定',async()=>{
      await page.locator('#openJournalImportBtn').click();
      await page.locator('#journalCsvFile').setInputFiles({name:'invented-fx4.csv',mimeType:'text/csv',buffer:Buffer.from(csv(),'utf8')});
      await page.waitForFunction(()=>Boolean(pendingJournalImport?.analysis));
      await page.locator('#applyJournalImportBtn').click();
      const imported=await page.evaluate(()=>({applied:pendingJournalImport.applied,rows:taxEntryRows.purchases.map(row=>({code:row.code,component:row.importComponent,count:row.sourceCount})),value:latestCalculation.calc.purchases.imported}));
      assert.equal(imported.applied,true);assert.equal(imported.rows.length,9);assert.ok(imported.rows.some(row=>row.count===2));assert.equal(imported.value.complete,false);
      await page.locator('#importBulkComponent').selectOption('local');await page.locator('#importBulkApply').click();
      const value=await page.evaluate(()=>latestCalculation.calc.purchases.imported);assert.equal(value.complete,true);assert.equal(value.originalNational,15600);assert.equal(value.originalLocal,5200);assert.equal(value.goods,300000);assert.equal(value.duty,10000);
      await page.locator('#rowPurchaseInput').screenshot({path:path.join(output,'import-aggregate-desktop.png')});
    });
    await check('集約行の金額を編集すると国税の概算へ反映し、元の金額へ戻せる',async()=>{
      const amount=page.locator('[data-row-key="csv-import-55-8-national"][data-row-field="amount"]');
      await amount.fill('12480');await amount.dispatchEvent('change');
      assert.equal(await page.evaluate(()=>latestCalculation.calc.purchases.imported.originalNational),21840);
      await amount.fill('6240');await amount.dispatchEvent('change');
      assert.equal(await page.evaluate(()=>latestCalculation.calc.purchases.imported.originalNational),15600);
    });
    await check('輸入の食品対象割合100・50・0％と空欄、保存復元',async()=>{
      for(const [percent,national] of [['100',1950],['50',8775],['0',15600]]){
        await page.locator('#importFoodPercent').fill(percent);await page.locator('#importFoodPercent').dispatchEvent('change');
        assert.equal(await page.evaluate(()=>latestCalculation.calc.purchases.imported.national),national);
      }
      await page.locator('#importFoodPercent').fill('');await page.locator('#importFoodPercent').dispatchEvent('change');assert.equal(await page.evaluate(()=>latestCalculation.calc.purchases.imported.complete),false);
      await page.locator('#importFoodPercent').fill('50');await page.locator('#importFoodPercent').dispatchEvent('change');
      await page.evaluate(()=>{$('importEstimateBase').checked=false;update();});await page.reload({waitUntil:'domcontentloaded'});
      assert.equal(await page.locator('#importFoodPercent').inputValue(),'50');assert.equal(await page.locator('#importEstimateBase').isChecked(),false);assert.equal(await page.evaluate(()=>latestCalculation.calc.purchases.imported.national),8775);
    });
    await check('期間外へ変更後はCSVの再反映で金額・反映状態を変えない',async()=>{
      const before=await page.evaluate(()=>JSON.stringify(taxEntryRows));await period('2029-04-01','2030-03-31');
      await page.evaluate(source=>{pendingJournalImport={analysis:analyzeTkcJournalText(source),sourceText:source,applied:false};applyJournalImport();},csv());
      assert.equal(await page.evaluate(()=>JSON.stringify(taxEntryRows)),before);assert.equal(await page.evaluate(()=>pendingJournalImport.applied),false);
    });
    await check('390pxで大きな警告が収まり、修正後に進行できる',async()=>{
      await page.setViewportSize({width:390,height:844});
      const layout=await page.locator('#proposalPeriodBlockedNotice').evaluate(node=>({width:document.documentElement.scrollWidth,rect:node.getBoundingClientRect().toJSON(),titleSize:parseFloat(getComputedStyle(node.querySelector('strong')).fontSize)}));
      assert.equal(layout.width,390);assert.ok(layout.rect.left>=0&&layout.rect.right<=390);assert.ok(layout.titleSize>=20);
      await page.locator('#proposalPeriodBlockedNotice').screenshot({path:path.join(output,'period-block-390.png')});
      await period('2028-01-01','2028-12-31');await page.locator('#workflowNext').click();assert.equal(await page.evaluate(()=>workflowStep),2);
      const scroll=await page.locator('#rowPurchaseInput .table-wrap').evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));assert.ok(scroll.scroll>scroll.client);
      await page.locator('#rowPurchaseInput').screenshot({path:path.join(output,'import-aggregate-390.png')});
    });
    assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.consoleErrors,[]);assert.deepEqual(evidence.consoleWarnings,[]);
    console.log(JSON.stringify({checks:evidence.checks.length,status:'PASS',output},null,2));
    await context.close();
  }finally{
    fs.writeFileSync(path.join(output,'import-period-browser-evidence.json'),JSON.stringify(evidence,null,2));
    await browser.close();server.close();
  }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
