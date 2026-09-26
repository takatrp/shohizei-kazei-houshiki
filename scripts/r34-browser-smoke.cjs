'use strict';
// Synthetic HTTP browser checks. Real origin localStorage is retained across reloads.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
if(!process.env.R33_EVIDENCE_DIR)throw new Error('Set R33_EVIDENCE_DIR to synthetic fixture evidence');
const seed=fs.readFileSync(path.join(process.env.R33_EVIDENCE_DIR,'fixture-seed.js'),'utf8');
const output=path.resolve(process.env.R34_RESULTS_DIR||path.join(root,'..','r34-browser-results'));
if(output===root||output.startsWith(root+path.sep))throw new Error('R34_RESULTS_DIR must be outside the repository');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
const server=http.createServer((request,response)=>{
  const target=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(target!==root&&!target.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  fs.readFile(target===root?path.join(root,'index.html'):target,(error,body)=>{
    if(error){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':types[path.extname(target)]||'text/html; charset=utf-8'}).end(body);
  });
});
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  const evidence={checks:[],pageErrors:[],realLocalStorage:true};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ja-JP'});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route=>route.abort());
    const page=await context.newPage();
    page.on('pageerror',error=>evidence.pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    const check=async(name,fn)=>{await fn();evidence.checks.push({name,status:'PASS'});};
    await check('新規初期値：課税区分1/3の金額空欄、短縮特例なし',async()=>{
      const state=await page.evaluate(()=>({sales:taxEntryRows.sales.map(row=>({code:row.code,amount:row.amount})),shortening:$('cashflowPeriodShortening').value}));
      for(const code of ['1','3'])assert.ok(state.sales.some(row=>row.code===code&&row.amount===''),`TKC ${code} must initially be blank`);
      assert.equal(state.shortening,'none');evidence.initial=state;
    });
    await page.evaluate(`(${seed})({scenario:'foodProposal'})`);
    await check('グループ見出しと必須バッジ',async()=>{
      await page.evaluate(()=>{workflowStep=1;update();});
      const labels=await page.evaluate(()=>({headings:[...document.querySelectorAll('h2,h3,h4,legend')].map(el=>el.textContent.trim()),badgeCount:document.querySelectorAll('.field-badge.required').length}));
      assert.ok(labels.headings.length>0);
      assert.equal(await page.locator('#taxScenarioHeading .field-badge.required').count(),1);
      assert.equal(await page.locator('.segmented .field-badge').count(),0);
      assert.equal(await page.evaluate(()=>[...document.querySelectorAll('input[type=radio]')].reduce((count,input)=>count+[...input.labels].reduce((total,label)=>total+label.querySelectorAll('.field-badge').length,0),0)),0);
      evidence.headings=labels;
      await page.screenshot({path:path.join(output,'R34_step1_headings.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      const narrow=await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
        headingRight:document.getElementById('taxScenarioHeading').getBoundingClientRect().right}));
      assert.ok(narrow.documentWidth<=narrow.viewport+1);assert.ok(narrow.headingRight<=narrow.viewport+1);evidence.step1Narrow=narrow;
      await page.screenshot({path:path.join(output,'R34_step1_headings_390.png'),fullPage:true});
      await page.setViewportSize({width:1440,height:1050});
    });
    await check('明示unknown/yesの保存→実際の再読込',async()=>{
      for(const value of ['unknown','yes']){
        await page.evaluate(value=>{workflowStep=5;$('cashflowPeriodShortening').value=value;$('saveToDevice').checked=true;update();saveState();},value);
        assert.ok(await page.evaluate(()=>localStorage.getItem(STORAGE_KEY)));
        await page.reload({waitUntil:'domcontentloaded'});
        assert.equal(await page.locator('#cashflowPeriodShortening').inputValue(),value);
      }
    });
    await check('STEP3の未算定理由から該当食品内数へ移動・フォーカス',async()=>{
      await page.evaluate(`(${seed})({scenario:'foodProposal'})`);
      await page.evaluate(()=>{taxEntryRows.sales[0].foodAmount='';renderTaxEntryRows('sales');workflowStep=4;update();});
      const link=page.locator('.calculation-issue-link[data-input-target]').first();
      await link.waitFor({state:'visible'});
      const target=await link.getAttribute('data-input-target');
      const color=await link.evaluate(el=>getComputedStyle(el).color);
      const channels=color.match(/[\d.]+/g)?.map(Number)||[];
      assert.ok(channels.length>=3&&channels[0]>channels[1]*2&&channels[0]>channels[2]*2,`未算定理由 must be red; actual ${color}`);
      await page.screenshot({path:path.join(output,'R34_step3_missing_food_reason.png'),fullPage:true});
      await link.click();
      const focus=await page.evaluate(()=>({id:document.activeElement.id,field:document.activeElement.dataset.rowField,side:document.activeElement.dataset.rowSide,step:workflowStep}));
      assert.equal(focus.field,'foodAmount');assert.equal(focus.side,'sales');assert.equal(focus.step,2);
      evidence.issueNavigation={target,focus,color};
      await page.screenshot({path:path.join(output,'R34_missing_food_focus.png'),fullPage:true});
    });
    await page.evaluate(`(${seed})({scenario:'foodProposal'})`);
    await page.evaluate(()=>{workflowStep=5;update();});
    await page.locator('#cashflowInterimStatus').selectOption('scheduled');
    await page.locator('#cashflowBaseInterim').fill('2028-08,123000');
    await page.locator('#cashflowBaseInterim').blur();
    await page.locator('input[name=cashflowComparisonType][value=methodImpact]').check();
    await page.locator('#cashflowInterimStatus').selectOption('none');
    await check('方式別A/B実額グラフとエンジン数値一致',async()=>{
      const result=await page.evaluate(()=>({engine:latestCashflow.engine,chart:document.querySelector('.cf-event-chart')?.textContent}));
      assert.ok(result.engine?.rows?.length,'STEP4 engine must be calculated');assert.ok(result.chart);
      for(const row of result.engine.rows)for(const key of ['baseTax','changedTax'])for(const kind of ['interim','settlement','refund']){
        const amount=row[key]?.[kind];if(amount>0)assert.ok(result.chart.includes((kind==='refund'?'＋':'−')+amount.toLocaleString('ja-JP')+'円'),`${row.month} ${key} ${kind} ${amount}`);
      }
      evidence.eventRows=result.engine.rows.filter(row=>[row.baseTax,row.changedTax].some(tax=>tax&&Object.values(tax).some(amount=>amount>0)));
      await page.screenshot({path:path.join(output,'R34_method_actual_events_desktop.png'),fullPage:true});
    });
    await check('390pxで実額グラフのはみ出しなし',async()=>{
      await page.setViewportSize({width:390,height:844});
      const bounds=await page.locator('.cf-event-chart').first().evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,right:el.getBoundingClientRect().right,viewport:innerWidth}));
      assert.ok(bounds.scroll<=bounds.width+1);assert.ok(bounds.right<=bounds.viewport+1);evidence.narrowChart=bounds;
      await page.screenshot({path:path.join(output,'R34_method_actual_events_390.png'),fullPage:true});
      await page.setViewportSize({width:1440,height:1050});
    });
    await check('モード状態の保存・再読込・往復',async()=>{
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});
      assert.equal(await page.evaluate(()=>cashflowComparisonType()),'methodImpact');
      assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'none');
      await page.locator('input[name=cashflowComparisonType][value=rateImpact]').check();
      assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'scheduled');
      assert.equal(await page.locator('#cashflowBaseInterim').inputValue(),'2028-08,123000');
      assert.ok(await page.locator('.cf-event-chart').count());
      await page.screenshot({path:path.join(output,'R34_rate_actual_events.png'),fullPage:true});
      await page.locator('input[name=cashflowComparisonType][value=methodImpact]').check();
      assert.equal(await page.locator('#cashflowInterimStatus').inputValue(),'none');
    });
    await check('画面・コピー・CSV・印刷の実額一致とPDF出力',async()=>{
      const exports=await page.evaluate(()=>{document.body.dataset.printTarget='cashflow';prepareComparisonPrint();return {copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent,engine:latestCashflow.engine};});
      for(const format of ['copy','csv','print'])assert.match(exports[format],/課税方式別の資金推移/);
      for(const row of exports.engine.rows)for(const tax of [row.baseTax,row.changedTax])for(const amount of Object.values(tax||{}))if(amount>0){
        for(const format of ['copy','csv','print'])assert.ok(exports[format].replaceAll(',','').includes(String(amount)),`${format} lacks ${amount}`);
      }
      assert.doesNotMatch(exports.copy,/必須任意|任意必須/);
      await page.pdf({path:path.join(output,'R34_cashflow_actual_events.pdf'),format:'A4',printBackground:true});
      fs.writeFileSync(path.join(output,'R34_copy.txt'),exports.copy);fs.writeFileSync(path.join(output,'R34_export.csv'),exports.csv);
      evidence.copyCsvPrint=true;
      await page.evaluate(()=>{delete document.body.dataset.printTarget;});
    });
    await check('中間納付・確定納付・還付の3種類を同一月軸で照合',async()=>{
      await page.locator('#cashflowInterimStatus').selectOption('scheduled');
      await page.locator('#cashflowSameInterim').check();
      await page.locator('#cashflowBaseInterim').fill('2028-08,123000');
      await page.locator('#cashflowBaseInterim').blur();
      const actual=await page.evaluate(()=>({rows:latestCashflow.engine?.rows,
        chart:document.querySelector('#cashflowChart .cf-event-chart')?.textContent,
        table:[...document.querySelectorAll('#cashflowMonthlyTable tbody tr')].map(tr=>[...tr.cells].map(cell=>cell.textContent.trim()))}));
      assert.ok(actual.rows?.length);assert.ok(actual.chart);
      const sums={baseTax:{interim:0,settlement:0,refund:0},changedTax:{interim:0,settlement:0,refund:0}};
      for(const row of actual.rows){
        const cells=actual.table.find(cells=>cells[0]===row.month);assert.ok(cells,`${row.month} must exist in table`);
        for(const [index,key,kind] of [[1,'baseTax','interim'],[2,'changedTax','interim'],[3,'baseTax','settlement'],[4,'changedTax','settlement'],[5,'baseTax','refund'],[6,'changedTax','refund']]){
          const amount=row[key][kind];sums[key][kind]+=amount;
          assert.equal(Number(cells[index].replace(/[^\d.-]/g,'')),amount,`${row.month} ${key} ${kind} table value`);
          if(amount>0)assert.ok(actual.chart.includes((kind==='refund'?'＋':'−')+amount.toLocaleString('ja-JP')+'円'));
        }
      }
      assert.deepEqual(sums,{baseTax:{interim:123000,settlement:177000,refund:0},changedTax:{interim:123000,settlement:0,refund:123000}});
      const august=actual.rows.find(row=>row.month==='2028-08');assert.equal(august.baseTax.interim,123000);assert.equal(august.changedTax.interim,123000);
      assert.equal(actual.rows.find(row=>row.month==='2029-02').baseTax.settlement,177000);
      assert.equal(actual.rows.find(row=>row.month==='2029-03').changedTax.refund,123000);
      evidence.threeEvents={sums,rows:actual.rows.filter(row=>[row.baseTax,row.changedTax].some(tax=>Object.values(tax).some(amount=>amount>0)))};
      await page.screenshot({path:path.join(output,'R34_three_event_types_desktop.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      const bounds=await page.locator('#cashflowChart .cf-event-chart').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,right:el.getBoundingClientRect().right,viewport:innerWidth}));
      assert.ok(bounds.scroll<=bounds.width+1);assert.ok(bounds.right<=bounds.viewport+1);
      await page.screenshot({path:path.join(output,'R34_three_event_types_390.png'),fullPage:true});
      await page.setViewportSize({width:1440,height:1050});
      const exports=await page.evaluate(()=>{document.body.dataset.printTarget='cashflow';prepareComparisonPrint();return {copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent};});
      for(const format of ['copy','csv','print'])for(const amount of [123000,177000])assert.ok(exports[format].replaceAll(',','').includes(String(amount)),`${format} lacks ${amount}`);
      assert.equal(await page.locator('#cashflowPrintReport .cf-event-chart').count(),1);
      await page.pdf({path:path.join(output,'R34_three_event_types.pdf'),format:'A4',printBackground:true});
      fs.writeFileSync(path.join(output,'R34_three_event_copy.txt'),exports.copy);fs.writeFileSync(path.join(output,'R34_three_event_export.csv'),exports.csv);
      await page.evaluate(()=>{delete document.body.dataset.printTarget;});
    });
    await check('リセット後の短縮特例と別案件初期行',async()=>{
      await page.evaluate(()=>resetAll());
      assert.equal(await page.locator('#cashflowPeriodShortening').inputValue(),'none');
      const sales=await page.evaluate(()=>taxEntryRows.sales.map(row=>({code:row.code,amount:row.amount})));
      for(const code of ['1','3'])assert.ok(sales.some(row=>row.code===code&&row.amount===''));
    });
    assert.deepEqual(evidence.pageErrors,[]);evidence.status='PASS';
    fs.writeFileSync(path.join(output,'R34_browser_result.json'),JSON.stringify(evidence,null,2));
    process.stdout.write(JSON.stringify(evidence)+'\n');
  }catch(error){evidence.status='FAIL';evidence.error=error.stack;fs.writeFileSync(path.join(output,'R34_browser_result.json'),JSON.stringify(evidence,null,2));throw error;}
  finally{await browser.close();}
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;}).finally(()=>server.close());
