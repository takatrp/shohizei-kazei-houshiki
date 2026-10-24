'use strict';
// Anonymous fixture state is injected through the same public calculation APIs.
// Field changes, disclosures, exports and tax-event reconciliations use Chromium.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.KAZEI_EVIDENCE_DIR || '/tmp/kazei-expanded-browser');
if(output===root || output.startsWith(root+path.sep))throw new Error('Evidence must be outside repository');
const server=http.createServer((req,res)=>{
  let target=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(target!==root && !target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  if(target===root)target=path.join(root,'index.html');
  fs.readFile(target,(err,data)=>err?res.writeHead(404).end():res.writeHead(200,{'Content-Type':target.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'}).end(data));
});
(async()=>{
  fs.mkdirSync(output,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const report={checks:[],pageErrors:[]};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ja-JP'});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
    const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    const check=async(name,fn)=>{try{await fn();report.checks.push({name,status:'PASS'});}catch(e){report.checks.push({name,status:'FAIL',error:e.message});throw e;}};
    const input=async(id,value)=>{
      const locator=page.locator('#'+id);
      await locator.evaluate(el=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      if(await locator.evaluate(el=>el.tagName==='SELECT'))await locator.selectOption(String(value));else await locator.fill(String(value));
      await locator.blur();
    };
    const seed=async(options={})=>page.evaluate(options=>{
      resetAll();$('entityCorporation').checked=true;$('entityIndividual').checked=false;
      $('periodStart').value=options.start||'2027-01-01';$('periodEnd').value=options.end||'2027-12-31';
      $('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;
      $('compareRegular').checked=true;$('compareSimplified').checked=options.simplified===true;
      $('baseTaxableSales').value='4000000';$('currentReturnMethod').value='regular';$('exemptPurchaseState').value='no';
      const quick=ShohizeiFourAmountEntry.build({industry:'manufacturing',foodSales:options.foodSales??1080000,otherSales:options.otherSales??110000,foodPurchases:options.foodPurchases??540000,otherPurchases:options.otherPurchases??220000});
      // These route/cashflow fixtures represent detailed manual rows. The
      // actual quick-input ownership and draft validation are tested separately.
      for(const side of ['sales','purchases'])for(const row of quick.rows[side])row.source='manual';
      taxEntryRows=quick.rows;entryMode='rows';rowCsvKnownZeros={nonTaxableSales:true};
      renderTaxEntryRows('sales');renderTaxEntryRows('purchases');resetProposalPeriodConfirmation();workflowStep=4;update();
    },options);

    await check('CSV季節構成を年税額へ使用しSTEP4へ同じ対象期間額を接続',async()=>{
      await seed();
      const data=await page.evaluate(()=>{
        const uniform=calculate();const uniformAmount=uniform.methods.find(m=>m.key==='regular').amount;
        for(const side of ['sales','purchases'])for(const row of taxEntryRows[side])row.source='csv';
        importedCsvOriginalSourceId='anonymous-seasonal-2027';
        sharedCaseFacts.csvSource=ShohizeiSharedCaseFacts.withCsvSource(sharedCaseFacts.csvSource,{sourceId:importedCsvOriginalSourceId,period:{start:'2027-01-01',end:'2027-12-31'},periodConfirmed:true,fullMonthCoverageConfirmed:true});
        importedCsvMonthlyGroups=[
          {kind:'sales',code:'1',rate:'8',businessType:'type3',month:'2027-01',amount:972000},
          {kind:'sales',code:'1',rate:'8',businessType:'type3',month:'2027-04',amount:108000},
          {kind:'sales',code:'1',rate:'10',businessType:'type3',month:'2027-04',amount:110000},
          {kind:'purchases',code:'5',rate:'8',usage:'taxableOnly',month:'2027-01',amount:486000},
          {kind:'purchases',code:'5',rate:'8',usage:'taxableOnly',month:'2027-04',amount:54000},
          {kind:'purchases',code:'5',rate:'10',usage:'taxableOnly',month:'2027-04',amount:220000}];
        importedCsvMonthlyDateUnknownCount=0;syncSharedCsvSourceInputs();update();
        const calc=calculate();return {uniformAmount,seasonalAmount:calc.methods.find(m=>m.key==='regular').amount,salesTax:calc.sales.totalTax,purchaseTax:calc.purchases.invoiceTax,copy:buildSummaryText(calc),csv:buildCsvText(calc)};
      });
      // Independent gross-to-net check: food sales tax 900,000*8%+100,000*1%=73,000;
      // other sales 10,000. Food purchases 450,000*8%+50,000*1%=36,500; other 20,000.
      assert.equal(data.salesTax,83000);assert.equal(data.purchaseTax,56500);assert.equal(data.seasonalAmount,26500);
      assert.notEqual(data.uniformAmount,data.seasonalAmount);assert.match(data.copy,/CSV|課税区分グループ/);
      await page.screenshot({path:path.join(output,'seasonal-annual-tax.png'),fullPage:true});
      const cash=await page.evaluate(()=>{workflowStep=5;$('cashflowInterimStatus').value='none';update();return {adapter:latestCashflow.adapter,engine:latestCashflow.engine};});
      assert.equal(cash.engine.status,'complete');
      assert.equal(cash.adapter.salesDeltas.reduce((s,r)=>s+r.amount,0),-7000);
      assert.equal(cash.adapter.purchaseDeltas.reduce((s,r)=>s+r.amount,0),-3500);
      assert.equal(cash.engine.totals.purchase,3500);
      assert.equal(cash.adapter.salesDeltas.find(r=>r.month==='2027-04').amount,-7000);
      assert.equal(cash.adapter.salesDeltas.find(r=>r.month==='2027-01').amount,0);
      report.seasonal={...data,cash};
    });

    await check('複数期は措置終了後を含め将来の売上閾値を正しい2期後へ反映',async()=>{
      await seed({simplified:true});await page.locator('#foodProjectionDetails > summary').click();
      await input('futureSales0','5000');
      const projection=await page.evaluate(()=>ShohizeiContinuationUI.projectionPlan(calculate()));
      assert.ok(projection.periods.length>=4);assert.ok(projection.periods.at(-1).start>'2029-03-31');
      const later=projection.projections[3];
      assert.ok(later.base.entered && later.base.value>50000000);
      assert.equal(later.methods.find(m=>m.key==='simplified').eligibility,'ineligible');
      assert.notEqual(later.methods.find(m=>m.key==='regular').amount,null);
      assert.equal(later.methods.find(m=>m.key==='regular').amount,30000);
      assert.match(await page.locator('#foodProjectionResults').innerText(),/2030/);
      report.projection=projection;await page.screenshot({path:path.join(output,'projection-post-policy.png'),fullPage:true});
    });

    await check('中間特例の開始・終了、A/B明示利用と確定精算は円単位一致',async()=>{
      report.interim={};
      for(const stage of ['reduction','restoration']){
        const ending=stage==='restoration';
        await seed(ending?{start:'2029-01-01',end:'2029-12-31',foodSales:259200000,otherSales:176000000,foodPurchases:172800000,otherPurchases:123200000}:
          {start:'2027-04-01',end:'2028-03-31',foodSales:32400000,otherSales:22000000,foodPurchases:21600000,otherPurchases:15400000});
        await page.evaluate(ending=>{
          const p=ending?{start:'2028-01-01',end:'2028-12-31'}:{start:'2026-04-01',end:'2027-03-31'};
          sharedCaseFacts.priorActual=ShohizeiSharedCaseFacts.withPriorActual(sharedCaseFacts.priorActual,{period:p,nationalTax:ending?'4368000':'1092000'});
          syncSharedPriorActualInputs();$('cashflowAutoBasis').value='actual';$('cashflowInterimStatus').value='auto';
          $('cashflowAutoSeparate').checked=false;cashflowAutoSeparateUnconfirmed=false;
          $('cashflowPeriodShortening').value='none';$('cashflowCorporateExtension').value='none';$('cashflowSpecialCircumstances').value='none';
          workflowStep=5;update();
        },ending);
        for(const [id,value] of Object.entries({foodPriorMethod:'regular',foodPriorFoodRate:ending?'1':'8',foodPriorSales:ending?'242400000':'32400000',foodPriorOtherSales:ending?'176000000':'22000000',foodPriorPurchases:ending?'161600000':'21600000',foodPriorOtherPurchases:ending?'123200000':'15400000',foodPriorNonTaxable:'0',foodPriorAdjustment:'0',foodPriorCredit:'full'}))await input(id,value);
        const before=await page.evaluate(()=>({comparison:latestCashflow.autoInterim.foodSpecial,base:latestCashflow.autoInterim.base.totals.total,changed:latestCashflow.autoInterim.changed.totals.total,engine:latestCashflow.engine,annual:latestCashflow.adapter.annualTax}));
        assert.equal(before.comparison.status,'ready');assert.equal(before.base,before.changed,'Comparison must not select special automatically');
        assert.equal(before.base,ending?4200000:700000);
        assert.equal(before.comparison.special.totals.total,ending?7000000:350000);
        await input('foodInterimB','special');
        const after=await page.evaluate(()=>({base:latestCashflow.autoInterim.base.totals.total,changed:latestCashflow.autoInterim.changed.totals.total,engine:latestCashflow.engine,annual:latestCashflow.adapter.annualTax,copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent}));
        assert.equal(after.base,before.base);assert.equal(after.changed,ending?7000000:350000);assert.equal(after.engine.status,'complete');
        assert.deepEqual(after.annual,before.annual,'Selecting interim schedule must not change annual tax');
        for(const [key,annual] of [['base',after.annual.base],['changed',after.annual.changed]]){
          const net=after.engine.rows.reduce((sum,row)=>sum+row[key+'Tax'].interim+row[key+'Tax'].settlement-row[key+'Tax'].refund,0);
          assert.equal(net,annual,stage+' '+key+' tax reconciliation');
        }
        assert.match(after.copy,/食品中間特例/);assert.match(after.csv,/食品中間特例/);assert.match(after.print,/通常納付と食品特例/);
        report.interim[stage]={before,after};await page.screenshot({path:path.join(output,`interim-${stage}.png`),fullPage:true});
      }
    });

    await check('共有前期の途中入力・別期間・元期間への復帰で補足と利用予定を適切に保持',async()=>{
      await seed({start:'2027-04-01',end:'2028-03-31',foodSales:32400000,otherSales:22000000,foodPurchases:21600000,otherPurchases:15400000});
      await page.evaluate(()=>{workflowStep=5;update();});
      await input('cashflowInterimStatus','auto');await input('cashflowAutoBasis','actual');
      await input('cashflowPriorStart','2026-04-01');await input('cashflowPriorEnd','2027-03-31');await input('cashflowPriorNationalTax','1092000');
      await input('cashflowCorporateExtension','none');await input('cashflowSpecialCircumstances','none');
      for(const [id,value] of Object.entries({foodPriorMethod:'regular',foodPriorFoodRate:'8',foodPriorSales:'32400000',foodPriorOtherSales:'22000000',foodPriorPurchases:'21600000',foodPriorOtherPurchases:'15400000',foodPriorNonTaxable:'0',foodPriorAdjustment:'0',foodPriorCredit:'full',foodInterimB:'special'}))await input(id,value);
      const old=await page.evaluate(()=>({state:ShohizeiContinuationUI.snapshot(),shared:sharedCaseFacts.priorActual,
        special:latestCashflow.autoInterim.foodSpecial.status,amount:latestCashflow.autoInterim.changed.totals?.total}));
      assert.equal(old.special,'ready');assert.equal(old.amount,350000);
      await input('cashflowPriorStart','');
      const partial=await page.evaluate(()=>({prior:ShohizeiContinuationUI.snapshot().prior,
        sales:$('foodPriorSales').value,choice:$('foodInterimB').value,ready:latestCashflow.autoInterim.ready}));
      assert.equal(partial.sales,'32400000');assert.equal(partial.choice,'special');
      assert.deepEqual(partial.prior.period,old.state.prior.period);assert.equal(partial.ready,false);
      await input('cashflowPriorStart','2025-04-01');await input('cashflowPriorEnd','2026-03-31');
      const other=await page.evaluate(()=>({state:ShohizeiContinuationUI.snapshot(),sales:$('foodPriorSales').value,
        choice:$('foodInterimB').value,national:$('cashflowPriorNationalTax').value,ready:latestCashflow.autoInterim.ready}));
      assert.equal(other.sales,'');assert.equal(other.choice,'ordinary');assert.equal(other.national,'');assert.equal(other.ready,false);
      assert.deepEqual(other.state.prior.period,{start:'2025-04-01',end:'2026-03-31'});
      assert.equal(other.state.priorHistory[JSON.stringify(old.state.prior.period)].foodSales,'32400000');
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});
      assert.equal(await page.locator('#foodPriorSales').inputValue(),'');assert.equal(await page.locator('#foodInterimB').inputValue(),'ordinary');
      // Set the end first to avoid overwriting the old history with an inverted period.
      await input('cashflowPriorEnd','2027-03-31');await input('cashflowPriorStart','2026-04-01');
      const restored=await page.evaluate(()=>({state:ShohizeiContinuationUI.snapshot(),sales:$('foodPriorSales').value,
        choice:$('foodInterimB').value,national:$('cashflowPriorNationalTax').value,ready:latestCashflow.autoInterim.ready}));
      assert.equal(restored.sales,'32400000');assert.equal(restored.choice,'special');assert.equal(restored.national,'');assert.equal(restored.ready,false);
      assert.deepEqual(restored.state.prior.period,old.state.prior.period);
      await input('cashflowPriorNationalTax','1092000');
      assert.equal(await page.evaluate(()=>latestCashflow.autoInterim.changed.totals.total),350000);
      report.sharedPriorScope={old,partial,other,restored};await page.screenshot({path:path.join(output,'shared-prior-scope-restored.png'),fullPage:true});
    });

    await check('同一正式前期CSVは4金額再入力なく再利用し別CSV・金額編集で通常納付へ戻す',async()=>{
      await seed({start:'2027-04-01',end:'2028-03-31'});
      await page.evaluate(()=>{
        const priorPeriod={start:'2026-04-01',end:'2027-03-31'};
        importedCsvOriginalSourceId='anonymous-actual-prior';
        sharedCaseFacts.priorActual=ShohizeiSharedCaseFacts.withPriorActual(sharedCaseFacts.priorActual,{period:priorPeriod,nationalTax:'1092000'});
        sharedCaseFacts.csvSource=ShohizeiSharedCaseFacts.withCsvSource(sharedCaseFacts.csvSource,{sourceId:importedCsvOriginalSourceId,period:priorPeriod,periodConfirmed:true,fullMonthCoverageConfirmed:true});
        taxEntryRows={sales:[
          createTaxEntryRow('sales',{id:'csv-prior-s1',source:'csv',code:'1',rate:'8',businessType:'type2',amount:'32400000',foodAmount:'32400000',foodAmountSource:'manual'}),
          createTaxEntryRow('sales',{id:'csv-prior-s2',source:'csv',code:'1',rate:'10',businessType:'type2',amount:'22000000'})],
        purchases:[
          createTaxEntryRow('purchases',{id:'csv-prior-p1',source:'csv',code:'5',rate:'8',amount:'21600000',foodAmount:'21600000',foodAmountSource:'manual'}),
          createTaxEntryRow('purchases',{id:'csv-prior-p2',source:'csv',code:'5',rate:'10',amount:'15400000'})]};
        importedCsvMonthlyGroups=[
          {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2026-04',amount:32400000,transactionKind:'ordinary'},
          {kind:'sales',code:'1',rate:'10',businessType:'type2',month:'2026-05',amount:22000000,transactionKind:'ordinary'},
          {kind:'purchases',code:'5',rate:'8',usage:'taxableOnly',month:'2026-04',amount:21600000,transactionKind:'ordinary'},
          {kind:'purchases',code:'5',rate:'10',usage:'taxableOnly',month:'2026-05',amount:15400000,transactionKind:'ordinary'}];
        importedCsvMonthlyDateUnknownCount=0;rowCsvKnownZeros={nonTaxableSales:true};
        syncSharedPriorActualInputs();syncSharedCsvSourceInputs();renderTaxEntryRows('sales');renderTaxEntryRows('purchases');
        $('cashflowAutoBasis').value='actual';$('cashflowInterimStatus').value='auto';
        $('cashflowPeriodShortening').value='none';$('cashflowCorporateExtension').value='none';$('cashflowSpecialCircumstances').value='none';
        workflowStep=5;update();$('proposalFoodClassificationState').value='confirmed';$('proposalPurchaseClassificationState').value='confirmed';update();
      });
      for(const [id,value]of Object.entries({foodPriorMethod:'regular',foodPriorCredit:'full',foodPriorAdjustment:'0'}))await input(id,value);
      const reused=await page.evaluate(()=>({scope:$('foodPriorScope').textContent,auto:latestCashflow.autoInterim,
        state:ShohizeiContinuationUI.snapshot(),sales:$('foodPriorSales').value,purchases:$('foodPriorPurchases').value}));
      assert.match(reused.scope,/同じ元CSV.*共用/);assert.equal(reused.auto.foodSpecial.status,'ready');
      assert.equal(reused.auto.foodSpecial.special.totals.total,350000);
      assert.equal(reused.sales,'');assert.equal(reused.purchases,'');
      assert.equal(await page.locator('#foodPriorSales').isVisible(),false);
      await input('foodInterimB','special');
      assert.equal(await page.evaluate(()=>latestCashflow.autoInterim.changed.totals.total),350000);
      const replaced=await page.evaluate(()=>{importedCsvOriginalSourceId='different-anonymous-source';update();return {scope:$('foodPriorScope').textContent,auto:latestCashflow.autoInterim};});
      assert.doesNotMatch(replaced.scope,/同じ元CSV.*共用/);assert.equal(replaced.auto.changed.totals.total,700000);
      assert.notEqual(replaced.auto.foodSpecial.status,'ready');
      await page.evaluate(()=>{importedCsvOriginalSourceId='anonymous-actual-prior';update();workflowStep=2;update();});
      const amount=page.locator('[data-row-side="sales"][data-row-field="amount"]').first();
      await amount.fill('32400001');await amount.blur();
      await page.locator('[data-workflow-step="5"]').click();
      const edited=await page.evaluate(()=>({scope:$('foodPriorScope').textContent,auto:latestCashflow.autoInterim,salesState:$('proposalFoodClassificationState').value}));
      assert.doesNotMatch(edited.scope,/同じ元CSV.*共用/);assert.equal(edited.auto.changed.totals.total,700000);
      assert.notEqual(edited.auto.foodSpecial.status,'ready');assert.equal(edited.salesState,'unknown');
      report.sharedPriorCsv={reused,replaced,edited};await page.screenshot({path:path.join(output,'shared-prior-csv-disabled-after-edit.png'),fullPage:true});
    });

    await check('表示更新前の新計算でも複数期出力と既存印刷は現在行の税額を使用',async()=>{
      await seed({simplified:true});await page.locator('#foodProjectionDetails > summary').click();
      const old=await page.evaluate(()=>ShohizeiContinuationUI.exportRows(calculate()));
      const before=old.find(r=>String(r[0]).startsWith('2030-')&&r[1]==='本則課税');assert.equal(before[2],30000);
      const fresh=await page.evaluate(()=>{
        taxEntryRows.sales[0].amount='2160000';
        // Deliberately do not call update(): export must not reuse last rendered projection.
        const calc=calculate(),rows=ShohizeiContinuationUI.exportRows(calc),html=ShohizeiContinuationUI.printHtml(calc);
        const node=document.createElement('div');node.innerHTML=html;
        return {rows,printRows:[...node.querySelectorAll('tr')].map(tr=>[...tr.cells].map(td=>td.textContent)),copy:buildSummaryText(calc),csv:buildCsvText(calc)};
      });
      const after=fresh.rows.find(r=>String(r[0]).startsWith('2030-')&&r[1]==='本則課税');
      assert.equal(after[2],110000);assert.deepEqual(fresh.printRows,fresh.rows.map(r=>r.map(v=>String(v??''))));
      assert.match(fresh.copy,/110000/);assert.match(fresh.csv,/110000/);
      const actualPrint=await page.evaluate(()=>{prepareComparisonPrint();return $('comparisonPrintContent').textContent;});
      assert.match(actualPrint,/措置終了後まで比較/);assert.match(actualPrint,/110000/);
      await page.emulateMedia({media:'print'});await page.pdf({path:path.join(output,'fresh-projection-print.pdf'),format:'A4',printBackground:true});await page.emulateMedia({media:'screen'});
      report.freshProjectionExport={before,after,...fresh};
    });

    await check('将来納税義務は2期前の予測売上を参照し当期給与判定を全期へ複写しない',async()=>{
      report.futureObligation={};
      for(const large of [false,true]){
        await seed(large?{foodSales:10800000,otherSales:1100000}:{});
        await page.evaluate(()=>{workflowStep=1;$('specificPayrollAmount').value='0';update();});
        await input('currentReturnMethod','exempt');await input('voluntaryTargetStatus','exempt');
        await input('voluntaryRoute','maintain');await input('voluntaryAsset','no');await input('voluntaryOther','no');
        const data=await page.evaluate(()=>({rows:ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討'),
          table:$('voluntaryResult').textContent,print:ShohizeiContinuationUI.printHtml(calculate())}));
        const later=data.rows.find(r=>r[1]==='2029-01-01〜2029-12-31');assert.ok(later);
        if(large){assert.equal(later[2],'unavailable');assert.match(later[7],/基準期間.*1,000万円/);assert.notEqual(later[4],'未算定');}
        else assert.equal(later[2],'unknown','Current payroll=0 must not satisfy an unknown future specified period');
        assert.match(data.print,/免税・課税選択の検討/);assert.match(data.print,/2029-01-01/);
        report.futureObligation[large?'overThreshold':'underThreshold']=data;
      }
    });

    await check('免税維持・課税選択・登録経由は取引対象期間と出力を分離',async()=>{
      await seed({start:'2028-01-01',end:'2028-12-31'});
      await page.evaluate(()=>{workflowStep=1;update();});
      await input('currentReturnMethod','exempt');await input('voluntaryOther','no');await input('voluntaryAsset','no');
      await input('voluntaryRoute','maintain');
      const maintain=await page.locator('#voluntaryResult').innerText();assert.match(maintain,/課税対象取引なし又は未確定/);
      await input('voluntaryTargetStatus','taxable');
      assert.match(await page.locator('#voluntaryResult').innerText(),/選択不可/);
      assert.equal(await page.locator('#currentReturnMethod').inputValue(),'exempt','Current return and target obligation must stay separate');
      await input('voluntaryTargetStatus','exempt');
      await input('voluntaryRoute','election');await input('voluntaryFiling','planned');await input('voluntaryFilingDate','2027-12-15');
      const election=await page.locator('#voluntaryResult').innerText();assert.match(election,/2028-01-01〜2028-12-31/);
      await input('voluntaryRoute','invoice');await input('voluntaryFilingDate','2028-06-15');await input('voluntaryRegistrationDate','2028-07-01');
      const invoice=await page.locator('#voluntaryResult').innerText();assert.match(invoice,/2028-07-01〜2028-12-31/);assert.notEqual(invoice,election);
      await input('voluntaryExit','2031-01-01');await input('voluntaryExitStatus','planned');await input('voluntaryExitFilingDate','2030-12-01');
      assert.equal(await page.locator('#voluntaryExitFilingDate').inputValue(),'2030-12-01');
      const exported=await page.evaluate(()=>({copy:buildSummaryText(calculate()),csv:buildCsvText(calculate())}));
      assert.match(exported.copy,/課税選択/);assert.match(exported.csv,/課税選択/);
      report.voluntary={maintain,election,invoice,...exported};await page.screenshot({path:path.join(output,'voluntary-invoice-period.png'),fullPage:true});
    });
    assert.deepEqual(report.pageErrors,[]);
    console.log(JSON.stringify({checks:report.checks,pageErrors:report.pageErrors,evidence:output},null,2));
  }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
