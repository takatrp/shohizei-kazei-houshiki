'use strict';
// Independent review regressions. Anonymous data; localhost; external requests blocked.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.KAZEI_EVIDENCE_DIR||'/tmp/kazei-review-browser');
if(output===root||output.startsWith(root+path.sep))throw new Error('Evidence must remain outside repository');
const server=http.createServer((request,response)=>{
  const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
  let file=path.resolve(root,'.'+pathname);if(file!==root&&!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  if(file===root)file=path.join(root,'index.html');
  fs.readFile(file,(error,data)=>error?response.writeHead(404).end():response.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'}).end(data));
});
(async()=>{
  fs.mkdirSync(output,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const report={checks:[],pageErrors:[]};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ja-JP'});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route=>route.abort());
    const page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    const check=async(name,action)=>{try{await action();report.checks.push({name,status:'PASS'});}catch(error){report.checks.push({name,status:'FAIL',error:error.message});throw error;}};
    const input=async(id,value)=>{
      const node=page.locator('#'+id);await node.evaluate(element=>{for(let p=element.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      if(await node.evaluate(element=>element.tagName==='SELECT'))await node.selectOption(String(value));else await node.fill(String(value));await node.blur();
    };
    const seed=async(options={})=>page.evaluate(options=>{
      resetAll();$('compareRegular').checked=true;$('compareSimplified').checked=options.simplified===true;
      $('entityCorporation').checked=options.individual!==true;$('entityIndividual').checked=options.individual===true;
      $('periodStart').value=options.start||'2028-01-01';$('periodEnd').value=options.end||'2028-12-31';
      $('taxScenarioFood1').checked=options.current!==true;$('taxScenarioCurrent').checked=options.current===true;
      $('currentReturnMethod').value=options.exempt?'exempt':'regular';$('exemptPurchaseState').value='no';
      $('regularDetailMethod').value=options.detail||'auto';$('baseTaxableSales').value='';$('specificTaxableSales').value='';$('specificPayrollAmount').value='';
      const built=ShohizeiFourAmountEntry.build({industry:'manufacturing',foodSales:1080000,otherSales:110000,foodPurchases:540000,otherPurchases:220000});
      taxEntryRows=built.rows;rowCsvKnownZeros={nonTaxableSales:true};entryMode='rows';
      renderTaxEntryRows('sales');renderTaxEntryRows('purchases');resetProposalPeriodConfirmation();workflowStep=options.step||1;update();
    },options);
    const currentResult=()=>page.evaluate(()=>{
      const calc=calculate();return {ready:calc.comparisonReady,amount:calc.methods.find(m=>m.key==='regular').amount,
        included:calc.methods.find(m=>m.key==='regular').include,errors:calc.inputErrors,copy:buildSummaryText(calc),csv:buildCsvText(calc),
        state:ShohizeiContinuationUI.snapshot(),rows:taxEntryRows};
    });

    await check('R1 有効4金額の空欄・不正・負額編集は旧完成税額をコピー/CSV/保存へ残さない',async()=>{
      await page.evaluate(()=>{resetAll();$('compareRegular').checked=true;$('entityCorporation').checked=true;$('entityIndividual').checked=false;$('periodStart').value='2028-01-01';$('periodEnd').value='2028-12-31';$('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;$('currentReturnMethod').value='regular';$('exemptPurchaseState').value='no';workflowStep=2;update();});
      await input('quickIndustry','manufacturing');for(const [id,value]of [['quickFoodSales','1080000'],['quickOtherSales','110000'],['quickFoodPurchases','540000'],['quickOtherPurchases','220000']])await input(id,value);
      assert.equal((await currentResult()).amount,-5000);
      report.invalidDraft=[];
      for(const value of ['', 'abc', '-1']){
        await input('quickFoodSales',value);const result=await currentResult();
        assert.equal(result.ready,false);assert.equal(result.included,false);assert.ok(result.errors.length);
        assert.match(result.copy,/本則課税:.*未算定/);assert.doesNotMatch(result.copy,/本則課税:.*-5,000円/);
        const line=result.csv.split('\n').find(row=>row.startsWith('本則課税,'));assert.ok(line);assert.equal(line.split(',')[2],'');
        assert.equal(result.state.quick.foodSales,value);report.invalidDraft.push({value,ready:result.ready,amount:result.amount,errors:result.errors});
      }
      await input('quickFoodSales','');await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});
      const restored=await currentResult();assert.equal(restored.state.quick.foodSales,'');assert.equal(restored.ready,false);assert.match(restored.copy,/本則課税:.*未算定/);
      report.invalidReload={state:restored.state.quick,ready:restored.ready};
    });

    await check('R2 対象期の免税確認は年度変更・保存reloadで別期の確認事実へ再結合しない',async()=>{
      await seed({exempt:true});await input('voluntaryTargetStatus','exempt');await input('voluntaryOther','no');await input('voluntaryAsset','no');
      const before=await page.evaluate(()=>ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討'));
      assert.equal(before[0][2],'available');
      await input('periodStart','2029-01-01');await input('periodEnd','2029-12-31');
      const after=await page.evaluate(()=>({rows:ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討'),state:ShohizeiContinuationUI.snapshot()}));
      assert.equal(after.rows[0][1],'2029-01-01〜2029-12-31');assert.equal(after.rows[0][2],'unknown');assert.match(after.rows[0][7],/基準期間|特定期間/);
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});
      const restored=await page.evaluate(()=>ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討'));
      assert.equal(restored[0][2],'unknown');await input('voluntaryTargetStatus','exempt');
      const explicitlyConfirmed=await page.evaluate(()=>ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討'));
      assert.equal(explicitlyConfirmed[0][2],'available');report.targetPeriod={before,after,restored,explicitlyConfirmed};
    });

    await check('R3 到達可能な旧8％返還と新1％売上/仕入の本則税額は符号を保持する',async()=>{
      report.signed={};
      for(const reverse of [false,true]){
        await seed();const result=await page.evaluate(reverse=>{
          const row=(code,rate,amount,food,businessType='')=>({id:'review-'+code+'-'+amount,source:'manual',code,rate,amount:String(amount),foodAmount:String(food),foodAmountSource:'manual',businessType});
          taxEntryRows=reverse?{sales:[row('1','10',110000,'','type3'),row('3','',0,'')],purchases:[row('5','8',216000,216000),row('5','8',-108000,-108000)]}:
            {sales:[row('1','8',216000,216000,'type3'),row('11','8',108000,108000,'type3'),row('3','',0,'')],purchases:[row('5','10',0,'')]};
          renderTaxEntryRows('sales');renderTaxEntryRows('purchases');update();const c=calculate();return {ready:c.comparisonReady,regular:c.methods.find(m=>m.key==='regular'),sales:c.sales.totalTax,purchases:c.purchases.invoiceTax,copy:buildSummaryText(c),csv:buildCsvText(c)};
        },reverse);
        assert.equal(result.ready,true);assert.equal(result.regular.amount,reverse?16000:-6000);
        assert.equal(result.sales,reverse?10000:-6000);assert.equal(result.purchases,reverse?-6000:0);
        assert.match(result.copy,reverse?/16,000円/:/6,000円/);report.signed[reverse?'purchaseReturn':'salesReturn']=result;
      }
    });

    await check('R4 明示1％実績の将来100％増と非課税/共通用途は通常行へ保持して渡す',async()=>{
      await seed({detail:'individual'});
      await page.evaluate(()=>{
        taxEntryRows={sales:[{id:'review-zero-sale',source:'manual',code:'1',rate:'10',businessType:'type3',amount:'11000',foodAmount:''},{id:'review-nontax',source:'manual',code:'3',amount:'1000000',foodAmount:''}],purchases:[{id:'review-zero-buy',source:'manual',code:'5',rate:'10',amount:'0',foodAmount:''}]};
        importedActualOnePercent={source:'csvActual',amountMode:'included',ratePercent:1,salesByType:{type3:101000},invoicePurchase:50500,exemptPurchases:{},entries:[{kind:'sale',amount:101000,transactionKind:'ordinary',businessType:'type3',date:'2028-07-01',ratePercent:1,source:'csvActual'},{kind:'invoicePurchase',amount:50500,transactionKind:'ordinary',usage:'nonTaxableOnly',taxCode:'6',date:'2028-07-01',ratePercent:1,source:'csvActual'}]};
        ShohizeiContinuationUI.restore({version:1,periods:{'2029-01-01|2029-12-31':{salesGrowth:'100',purchaseGrowth:'100'}}});
        renderTaxEntryRows('sales');renderTaxEntryRows('purchases');workflowStep=4;update();
      });
      const data=await page.evaluate(()=>{const c=calculate(),plan=ShohizeiContinuationUI.projectionPlan(c);return {ready:c.comparisonReady,errors:c.inputErrors,plan};});
      assert.equal(data.ready,true);const snapshot=data.plan.projections[1].snapshot;
      assert.equal(Number(snapshot.rows.sales.find(r=>r.source==='forecast').amount),216000);
      const purchase=snapshot.rows.purchases.find(r=>r.source==='forecast');assert.equal(purchase.code,'6');assert.equal(Number(purchase.amount),108000);
      assert.equal(snapshot.purchases.purchaseTaxByUse.taxableOnly,0);assert.ok(snapshot.purchases.purchaseTaxByUse.nonTaxableOnly>0);
      report.actualOneGrowth={rows:snapshot.rows,purchaseTaxByUse:snapshot.purchases.purchaseTaxByUse,regular:snapshot.regular};
    });

    await check('R5 未算定の食品対象期間額は前提・コピー・CSV・印刷で0円化しない',async()=>{
      await seed({individual:true,start:'2026-01-01',end:'2026-12-31'});await input('foodForecastMethod','manual');
      const result=await page.evaluate(()=>{const c=calculate();return {ready:c.comparisonReady,assumptions:ShohizeiContinuationUI.assumptions(c),rows:ShohizeiContinuationUI.exportRows(c),copy:buildSummaryText(c),csv:buildCsvText(c),print:ShohizeiContinuationUI.printHtml(c)};});
      assert.equal(result.ready,false);const unavailable=result.rows.filter(r=>r[0]==='食品対象期間額'&&r[3]==='対象期間額未算定');assert.ok(unavailable.length>0);
      assert.ok(unavailable.every(r=>r[2]==='未算定'));assert.doesNotMatch(JSON.stringify(result.assumptions),/0円／対象期間額未算定/);
      assert.match(result.copy,/未算定.*対象期間額未算定/);assert.match(result.csv,/未算定/);assert.match(result.print,/未算定/);report.unavailable=result;
    });


    await check('R6 実CSVの登録日以後の実額を優先・月途中/保存reload/月額旧保存/日数概算を区別する',async()=>{
      const csv='月日,借方科目名,借方課税区分,借方事業区分,借方軽減税率か否か,借方税率,借方取引金額,借方消費税等,借方控除割合,貸方科目名,貸方課税区分,貸方事業区分,貸方軽減税率か否か,貸方税率,貸方取引金額,貸方消費税等,貸方控除割合\n'+
        '2028/01/01,,,,,,,,,売上,1,3,0,10,660000,,\n2028/07/14,,,,,,,,,売上,1,3,0,10,330000,,\n2028/07/15,,,,,,,,,売上,1,3,0,10,110000,,\n'+
        '2028/01/01,仕入,5,,0,10,385000,,,,,,,,,,\n2028/07/14,仕入,5,,0,10,110000,,,,,,,,,,\n2028/07/15,仕入,5,,0,10,55000,,,,,,,,,,\n2028/01/01,,,,,,,,,非課税,3,,0,10,0,,\n';
      await seed({exempt:true,current:true,step:2});
      await page.evaluate(()=>$('journalImportDisclosure').open=true);
      await page.locator('#journalCsvFile').setInputFiles({name:'review-anonymous.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
      await page.waitForFunction(()=>pendingJournalImport?.analysis&&typeof pendingJournalImport.sourceText==='string');
      const prepared=await page.evaluate(()=>{
        applyJournalImport();const period={start:'2028-01-01',end:'2028-12-31'};
        sharedCaseFacts.csvSource=ShohizeiSharedCaseFacts.withCsvSource(sharedCaseFacts.csvSource,{sourceId:importedCsvOriginalSourceId,period,periodConfirmed:true,fullMonthCoverageConfirmed:true});
        ShohizeiContinuationUI.restore({version:1,voluntary:{route:'invoice',targetStatus:'exempt',targetStatusPeriod:period,filingStatus:'filed',filingDate:'2028-06-01',registrationDate:'2028-07-15',registrationStatus:'registered',assetRestrictionState:'no',otherObligation:'no'}});
        syncSharedCsvSourceInputs();workflowStep=1;update();return {applied:appliedJournalImport?.applied,daily:importedCsvDailyGroups,rows:ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討')};
      });
      assert.equal(prepared.applied,true);assert.ok(prepared.daily.length>0);assert.equal(prepared.rows[0][3],'2028-07-15〜2028-12-31');
      // Independent hand check: post-registration sales tax10,000 - input5,000 =5,000.
      assert.equal(prepared.rows[0][4],5000);assert.match(prepared.rows[0][8],/CSV日別実額/);
      assert.ok(prepared.daily.every(group=>!Object.keys(group).some(k=>/account|description|partner|text/i.test(k))));
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem(STORAGE_KEY)));assert.ok(saved.importedCsvDailyGroups.length);assert.ok(!JSON.stringify(saved).includes('借方科目名'));
      await page.reload({waitUntil:'domcontentloaded'});
      const restored=await page.evaluate(()=>({daily:importedCsvDailyGroups,raw:appliedJournalImport?.sourceText,rows:ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討')}));
      assert.ok(restored.daily.length);assert.equal(restored.raw,undefined);assert.equal(restored.rows[0][4],5000);assert.match(restored.rows[0][8],/CSV日別実額/);
      await input('voluntaryRegistrationDate','2028-07-01');
      const monthStart=await page.evaluate(()=>ShohizeiContinuationUI.exportRows(calculate()).find(r=>r[0]==='免税・課税選択の検討'));
      assert.equal(monthStart[4],25000);assert.match(monthStart[8],/CSV日別実額/);
      const oldMonthly=await page.evaluate(()=>{importedCsvDailyGroups=null;update();return ShohizeiContinuationUI.exportRows(calculate()).find(r=>r[0]==='免税・課税選択の検討');});
      assert.equal(oldMonthly[4],25000);assert.match(oldMonthly[8],/CSV月別実額/);
      await input('voluntaryRegistrationDate','2028-07-15');
      const fallback=await page.evaluate(()=>ShohizeiContinuationUI.exportRows(calculate()).find(r=>r[0]==='免税・課税選択の検討'));
      assert.equal(typeof fallback[4],'number');assert.notEqual(fallback[4],5000);assert.match(fallback[8],/日数.*概算/);assert.match(fallback[8],/月途中/);
      report.registrationCsv={prepared,restored,monthStart,oldMonthly,fallback};
    });

    await check('R7 既入力の基準期間・特定期間・給与額は課税選択の方式可否へ共用する',async()=>{
      await seed({exempt:true,current:true,individual:true});
      const result=await page.evaluate(()=>{
        $('baseTaxableSales').value='1000000';$('specificTaxableSales').value='500000';$('specificPayrollAmount').value='500000';
        ShohizeiContinuationUI.restore({version:1,quick:{industry:'manufacturing',foodSales:'1080000',otherSales:'110000',foodPurchases:'540000',otherPurchases:'220000'},voluntary:{route:'election',targetStatus:'unknown',filingStatus:'filed',filingDate:'2027-12-01',assetRestrictionState:'no',otherObligation:'no'}});update();
        const c=calculate();return {ready:c.comparisonReady,regular:c.methods.find(m=>m.key==='regular'),row:ShohizeiContinuationUI.exportRows(c).find(r=>r[0]==='免税・課税選択の検討')};
      });
      assert.equal(result.row[2],'available');assert.equal(result.regular.eligibility,'eligible');assert.equal(result.ready,true);
      assert.ok(!result.regular.reasons.some(x=>/基準期間.*未確認|特定期間.*未確認/.test(x)));report.sharedObligationFacts=result;
    });


    await check('R8 免税年の1080万円売上は税抜1000万円へ縮めず2年後の基準期間へ渡す',async()=>{
      await seed({exempt:true,current:true,individual:true});
      const result=await page.evaluate(()=>{
        taxEntryRows=ShohizeiFourAmountEntry.build({industry:'manufacturing',foodSales:10800000,otherSales:0,foodPurchases:0,otherPurchases:0}).rows;
        for(const rows of Object.values(taxEntryRows))for(const row of rows)row.source='manual';
        ShohizeiContinuationUI.restore({version:1,voluntary:{route:'maintain',targetStatus:'exempt',targetStatusPeriod:{start:'2028-01-01',end:'2028-12-31'},assetRestrictionState:'no',otherObligation:'no'}});
        renderTaxEntryRows('sales');renderTaxEntryRows('purchases');update();return ShohizeiContinuationUI.exportRows(calculate()).filter(r=>r[0]==='免税・課税選択の検討');
      });
      const future=result.find(row=>row[1]==='2030-01-01〜2030-12-31');assert.equal(future[2],'unavailable');assert.match(future[7],/基準期間.*1,000万円.*超/);assert.equal(future[3],'2030-01-01〜2030-12-31');
      report.exemptGrossHistory={source:'https://www.nta.go.jp/law/shitsugi/shohi/22/05.htm',independentGross:10800000,wrongTaxExclusive:10000000,rows:result};
    });

    await check('R9 資産制限あり/不明と将来設備投資は免税維持・復帰の利用可能へ補完しない',async()=>{
      await seed({exempt:true,current:true,individual:true});
      await page.evaluate(()=>{for(const rows of Object.values(taxEntryRows))for(const row of rows)row.source='manual';$('baseTaxableSales').value='1000000';$('specificTaxableSales').value='500000';$('specificPayrollAmount').value='500000';});
      const assetRows=[];
      for(const asset of ['yes','unknown']){
        const result=await page.evaluate(asset=>{ShohizeiContinuationUI.restore({version:1,voluntary:{route:'maintain',targetStatus:'unknown',assetRestrictionState:asset,otherObligation:'no'}});update();const c=calculate();return {row:ShohizeiContinuationUI.exportRows(c).find(r=>r[0]==='免税・課税選択の検討'),regular:c.methods.find(m=>m.key==='regular')};},asset);
        assert.equal(result.row[2],'unknown');assert.equal(result.regular.include,false);assert.match(result.row[7],/資産/);assetRows.push({asset,...result});
      }
      const investment=await page.evaluate(()=>{
        ShohizeiContinuationUI.restore({version:1,periods:{'2029-01-01|2029-12-31':{investment:'1100000'}},voluntary:{route:'election',targetStatus:'exempt',targetStatusPeriod:{start:'2028-01-01',end:'2028-12-31'},filingStatus:'filed',filingDate:'2027-12-01',assetRestrictionState:'no',otherObligation:'no',exitDate:'2030-01-01',exitStatus:'planned',exitFilingDate:'2029-12-01'}});update();const c=calculate();return {state:ShohizeiContinuationUI.snapshot(),rows:ShohizeiContinuationUI.exportRows(c).filter(r=>r[0]==='免税・課税選択の検討')};
      });
      const exit=investment.rows.find(r=>r[1]==='2030-01-01〜2030-12-31');assert.equal(exit[3],'2030-01-01〜2030-12-31');assert.match(exit[7],/設備投資/);assert.match(exit[7],/資産.*未確認/);assert.equal(investment.state.voluntary.assetRestrictionState,'no');
      report.assetRestrictions={assetRows,investment};
    });


    await check('R10 既入力の当期資産情報は別欄の制限なしに消されず免税復帰判定へ共用する',async()=>{
      await seed({exempt:true,current:true,individual:true});
      await page.evaluate(()=>{
        for(const rows of Object.values(taxEntryRows))for(const row of rows)row.source='manual';
        $('baseTaxableSales').value='1000000';$('specificTaxableSales').value='500000';$('specificPayrollAmount').value='500000';
        ShohizeiContinuationUI.restore({version:1,voluntary:{route:'election',targetStatus:'exempt',targetStatusPeriod:{start:'2028-01-01',end:'2028-12-31'},filingStatus:'filed',filingDate:'2027-12-01',assetRestrictionState:'no',otherObligation:'no',exitDate:'2030-01-01',exitStatus:'planned',exitFilingDate:'2029-12-01'}});
        workflowStep=Number($('highAssetAmount').closest('.workflow-screen').id.replace('workflowScreen',''));update();
      });
      await page.locator('#advancedMode').evaluate(element=>{for(let p=element.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      await page.locator('#advancedMode').check();await page.locator('label[for="highAssetYes"]').click();
      const cases=[];
      for(const asset of [{amount:1000000,type:'fixed',status:'clear'},{amount:10000000,type:'fixed',status:'restricted'},{amount:10000000,type:'unknown',status:'unknown'}]){
        await input('highAssetAmount',asset.amount);await input('highAssetType',asset.type);
        const result=await page.evaluate(()=>{const c=calculate();return {asset:c.highAssetRegular,ctx:{state:c.ctx.highAssetState,amount:c.ctx.highAssetAmount,type:c.ctx.highAssetType},voluntary:ShohizeiContinuationUI.snapshot().voluntary,rows:ShohizeiContinuationUI.exportRows(c).filter(r=>r[0]==='免税・課税選択の検討'),copy:buildSummaryText(c),csv:buildCsvText(c),print:ShohizeiContinuationUI.printHtml(c)};});
        assert.equal(result.ctx.state,'yes');assert.equal(result.ctx.amount,asset.amount);assert.equal(result.ctx.type,asset.type);assert.equal(result.asset.status,asset.status);assert.equal(result.voluntary.assetRestrictionState,'no');
        const exit=result.rows.find(r=>r[1]==='2030-01-01〜2030-12-31');assert.equal(exit[3],'2030-01-01〜2030-12-31');assert.match(exit[7],/当期の入力済み高額資産.*共有/);assert.match(exit[7],/免税復帰.*未確認/);
        for(const output of [result.copy,result.csv,result.print])assert.match(output,/当期の入力済み高額資産/);
        cases.push({input:asset,...result});
      }
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});
      const restored=await page.evaluate(()=>{const c=calculate();return {ctx:{state:c.ctx.highAssetState,amount:c.ctx.highAssetAmount,type:c.ctx.highAssetType},rows:ShohizeiContinuationUI.exportRows(c).filter(r=>r[0]==='免税・課税選択の検討')};});
      assert.equal(restored.ctx.state,'yes');assert.equal(restored.ctx.amount,10000000);assert.equal(restored.ctx.type,'unknown');const exit=restored.rows.find(r=>r[1]==='2030-01-01〜2030-12-31');assert.equal(exit[3],'2030-01-01〜2030-12-31');assert.match(exit[7],/当期の入力済み高額資産/);
      report.sharedCurrentAsset={cases,restored};
    });


    await check('R11 元8％返品の不足事実を実画面で補足し一般/単一業種簡易の中間特例・出力・保存へ接続する',async()=>{
      await seed({start:'2027-04-01',end:'2028-03-31',step:5});
      await page.evaluate(()=>{
        const period={start:'2026-04-01',end:'2027-03-31'};importedCsvOriginalSourceId='review-anonymous-prior-return';
        sharedCaseFacts.priorActual=ShohizeiSharedCaseFacts.withPriorActual(sharedCaseFacts.priorActual,{period,nationalTax:'1029600'});
        sharedCaseFacts.csvSource=ShohizeiSharedCaseFacts.withCsvSource(sharedCaseFacts.csvSource,{sourceId:importedCsvOriginalSourceId,period,periodConfirmed:true,fullMonthCoverageConfirmed:true});
        taxEntryRows={sales:[createTaxEntryRow('sales',{id:'review-prior-food',source:'csv',code:'1',rate:'8',businessType:'type2',amount:'32400000',foodAmount:'32400000',foodAmountSource:'manual'}),createTaxEntryRow('sales',{id:'review-prior-other',source:'csv',code:'1',rate:'10',businessType:'type2',amount:'22000000'}),createTaxEntryRow('sales',{id:'review-prior-return',source:'csv',code:'11',rate:'8',businessType:'type2',amount:'1080000',foodAmount:'1080000',foodAmountSource:'manual',originalTaxableState:'unknown'})],purchases:[createTaxEntryRow('purchases',{id:'review-prior-pfood',source:'csv',code:'5',rate:'8',amount:'21600000',foodAmount:'21600000',foodAmountSource:'manual'}),createTaxEntryRow('purchases',{id:'review-prior-pother',source:'csv',code:'5',rate:'10',amount:'15400000'})]};
        importedCsvMonthlyGroups=[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2026-04',amount:32400000,transactionKind:'ordinary'},{kind:'sales',code:'1',rate:'10',businessType:'type2',month:'2026-05',amount:22000000,transactionKind:'ordinary'},{kind:'sales',code:'11',rate:'8',businessType:'type2',month:'2027-02',amount:-1080000,transactionKind:'adjustment'},{kind:'purchases',code:'5',rate:'8',usage:'taxableOnly',month:'2026-04',amount:21600000,transactionKind:'ordinary'},{kind:'purchases',code:'5',rate:'10',usage:'taxableOnly',month:'2026-05',amount:15400000,transactionKind:'ordinary'}];
        importedCsvDailyGroups=null;importedCsvMonthlyDateUnknownCount=0;rowCsvKnownZeros={nonTaxableSales:true};
        syncSharedPriorActualInputs();syncSharedCsvSourceInputs();renderTaxEntryRows('sales');renderTaxEntryRows('purchases');
        $('cashflowAutoBasis').value='actual';$('cashflowInterimStatus').value='auto';$('cashflowPeriodShortening').value='none';$('cashflowCorporateExtension').value='none';$('cashflowSpecialCircumstances').value='none';
        workflowStep=5;update();$('proposalFoodClassificationState').value='confirmed';$('proposalPurchaseClassificationState').value='confirmed';update();
      });
      for(const [id,value]of Object.entries({foodPriorMethod:'regular',foodPriorCredit:'full',foodPriorAdjustment:'0'}))await input(id,value);
      const before=await page.evaluate(()=>({special:latestCashflow.autoInterim.foodSpecial,ordinary:latestCashflow.autoInterim.base,select:document.querySelector('#foodReturnEvidence select[data-return-key="originalTaxableState"]').value}));
      assert.equal(before.select,'unknown');assert.equal(before.special.status,'unavailable');assert.equal(before.special.special.totals,null);assert.match(before.special.reasons.join(' '),/課税・免税状態|未確認/);
      const evidence=page.locator('#foodReturnEvidence select[data-return-key="originalTaxableState"]');
      await evidence.evaluate(element=>{for(let p=element.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});await evidence.selectOption('taxable');
      const regular=await page.evaluate(()=>({auto:latestCashflow.autoInterim,open:$('foodReturnEvidence').querySelector('details').open,value:document.querySelector('#foodReturnEvidence select[data-return-key="originalTaxableState"]').value,scope:$('foodPriorScope').textContent}));
      // Original8% return tax80,000 => national62,400. Policy national546,000-62,400=483,600.
      // Half-year national241,800 + local68,200 =310,000; actual-prior ordinary660,000.
      assert.equal(regular.value,'taxable');assert.equal(regular.open,true);assert.match(regular.scope,/同じ元CSV.*共用/);assert.equal(regular.auto.foodSpecial.status,'ready');assert.equal(regular.auto.foodSpecial.recalculationByStage.reduction.nationalSalesReturnTax,62400);assert.equal(regular.auto.foodSpecial.recalculationByStage.reduction.national,483600);assert.equal(regular.auto.foodSpecial.special.totals.total,310000);assert.equal(regular.auto.foodSpecial.ordinary.totals.total,660000);assert.equal(regular.auto.foodSpecial.retainedDuringPeriod,350000);
      await input('foodInterimB','special');
      const selectedRegular=await page.evaluate(()=>({auto:latestCashflow.autoInterim,copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent}));
      assert.equal(selectedRegular.auto.changed.totals.total,310000);assert.equal(selectedRegular.auto.foodSpecial.settlements.B.special.reconciled,true);for(const output of [selectedRegular.copy,selectedRegular.csv,selectedRegular.print])assert.match(output,/310,?000/);
      await input('foodPriorMethod','simplified');await input('cashflowPriorNationalTax','673900');
      const simplified=await page.evaluate(()=>({auto:latestCashflow.autoInterim,copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent,open:$('foodReturnEvidence').querySelector('details').open}));
      // National other1,560,000 - original return62,400; type2 burden20%=299,520.
      // Final national299,500; half-year149,700 + local42,200 =191,900.
      assert.equal(simplified.auto.foodSpecial.status,'ready');assert.equal(simplified.auto.foodSpecial.recalculationByStage.reduction.national,299500);assert.equal(simplified.auto.foodSpecial.special.totals.total,191900);assert.equal(simplified.auto.foodSpecial.ordinary.totals.total,431900);assert.equal(simplified.auto.changed.totals.total,191900);assert.equal(simplified.auto.foodSpecial.settlements.B.special.reconciled,true);assert.equal(simplified.open,true);for(const output of [simplified.copy,simplified.csv,simplified.print])assert.match(output,/191,?900/);
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});await page.reload({waitUntil:'domcontentloaded'});
      const restored=await page.evaluate(()=>({auto:latestCashflow.autoInterim,returnRow:taxEntryRows.sales.find(r=>r.code==='11'),value:document.querySelector('#foodReturnEvidence select[data-return-key="originalTaxableState"]').value,copy:cashflowExportText(latestCashflow),csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent}));
      assert.equal(restored.returnRow.amount,'1080000');assert.equal(restored.returnRow.originalTaxableState,'taxable');assert.equal(restored.value,'taxable');assert.equal(restored.auto.foodSpecial.status,'ready');assert.equal(restored.auto.changed.totals.total,191900);for(const output of [restored.copy,restored.csv,restored.print])assert.match(output,/191,?900/);
      report.sharedPriorReturnUi={before,regular,selectedRegular,simplified,restored};
    });

    assert.deepEqual(report.pageErrors,[]);await page.screenshot({path:path.join(output,'review-final.png'),fullPage:true});
    console.log(JSON.stringify({checks:report.checks,pageErrors:report.pageErrors,evidence:output},null,2));
  }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
