'use strict';
// Synthetic, local-only browser verification for the STEP4 panel.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.STEP4_PANEL_RESULTS_DIR||path.join(root,'..','shohizei-step4-panel-evidence'));
if(output===root||output.startsWith(root+path.sep))throw new Error('Evidence output must be outside the repository');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer((request,response)=>{
  const target=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(target!==root&&!target.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  fs.readFile(target===root?path.join(root,'index.html'):target,(error,body)=>{
    if(error){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':target===root?types['.html']:types[path.extname(target)]||'text/plain; charset=utf-8'}).end(body);
  });
});

async function seed(page,scenario='foodProposal'){
  return page.evaluate(scenario=>{
    resetAll();
    const set=(id,value)=>{$(id).value=String(value);};
    $('entityCorporation').checked=true;
    $('entityIndividual').checked=false;
    $('taxScenarioFood1').checked=scenario==='foodProposal';
    $('taxScenarioCurrent').checked=scenario!=='foodProposal';
    $('compareRegular').checked=true;
    $('compareSimplified').checked=true;
    $('compareSpecial2').checked=false;
    $('compareSpecial3').checked=false;
    set('periodStart','2028-01-01');set('periodEnd','2028-12-31');
    set('currentReturnMethod','regular');set('baseTaxableSales','30000000');
    set('exemptPurchaseState','no');set('regularDetailMethod','auto');
    set('proposalFoodClassificationState','confirmed');
    set('proposalPurchaseClassificationState','confirmed');
    set('foodSalesPriceBasis','netFixed');set('foodPurchasePriceBasis','netFixed');
    const sale={...newTaxEntry('sales'),code:'1',rate:'8',businessType:'type2',amount:'108000000',foodAmount:'108000000',source:'manual'};
    const nonTax={...newTaxEntry('sales'),code:'3',amount:'0',rate:'',businessType:'',foodAmount:'',source:'manual'};
    const purchase={...newTaxEntry('purchases'),code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'manual'};
    if(scenario!=='foodProposal'){sale.foodAmount='';purchase.foodAmount='';}
    taxEntryRows={sales:[sale,nonTax],purchases:[purchase]};
    rowCsvKnownZeros={nonTaxableSales:true,exemptPurchase:true};
    entryMode='rows';renderTaxEntryRows('sales');renderTaxEntryRows('purchases');
    workflowStep=5;update();
    $('cashflowInterimStatus').value='none';
    $('cashflowSettlementMonth').value='2029-02';
    $('cashflowRefundMonth').value='2029-03';
    update();
    return {calc:Boolean(latestCalculation?.calc),cashflow:Boolean(latestCashflow),result:$('cashflowResult').textContent.slice(0,300)};
  },scenario);
}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const evidence={checks:[],pageErrors:[]};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ja-JP',acceptDownloads:true});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route=>route.abort());
    const page=await context.newPage();
    page.on('pageerror',error=>evidence.pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    evidence.loaded=await page.evaluate(()=>({title:document.title,resetAll:typeof resetAll,workflow:typeof workflowStep,body:document.body?.textContent?.slice(0,120)}));
    if(evidence.loaded.resetAll!=='function')throw new Error(JSON.stringify({loaded:evidence.loaded,pageErrors:evidence.pageErrors}));
    evidence.seed=await seed(page);
    const check=async(name,fn)=>{await fn();evidence.checks.push({name,status:'PASS'});};
    await check('食品1％モードのSTEP4エンジンと新パネル',async()=>{
      evidence.rate=await page.evaluate(()=>({engine:latestCashflow?.engine?.status,
        panel:latestCashflow?.panelData?.status,
        months:latestCashflow?.panelData?.months?.length,
        same:latestCashflow?.panelData?.expectedDiff?.every((row,index)=>
          row.cumulative===latestCashflow.panelData.cases.B.rows[index].cumulative-latestCashflow.panelData.cases.A.rows[index].cumulative),
        chart:Boolean(document.querySelector('#cashflowChart .cf-plot')),
        table:Boolean(document.querySelector('#cashflowChart .cf-table'))}));
      assert.equal(evidence.rate.engine,'complete',JSON.stringify(evidence));
      assert.equal(evidence.rate.panel.integrity,'ok');
      assert.equal(evidence.rate.same,true);
      assert.equal(evidence.rate.chart,true);
      assert.equal(evidence.rate.table,true);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'step4-rate-desktop.png')});
    });
    await check('グラフと表の列中心、ホバー',async()=>{
      evidence.alignment=await page.evaluate(()=>{
        const panel=document.querySelector('#cashflowChart');
        const plot=panel.querySelector('.cf-plot');
        const cell=panel.querySelector('.cf-table thead [data-month-index="0"]');
        const hit=plot.querySelector('.cf-hit[data-month-index="0"]');
        const a=cell.getBoundingClientRect(),b=hit.getBoundingClientRect();
        const table=panel.querySelector('.cf-table').getBoundingClientRect(),axis=panel.querySelector('.cf-yaxis').getBoundingClientRect(),plotRect=plot.getBoundingClientRect();
        return {cellX:a.x+a.width/2,hitX:b.x+b.width/2,delta:Math.abs(a.x+a.width/2-b.x-b.width/2),cell:a.toJSON(),hit:b.toJSON(),table:table.toJSON(),axis:axis.toJSON(),plot:plotRect.toJSON()};
      });
      assert.ok(evidence.alignment.delta<=1,JSON.stringify(evidence.alignment));
      await page.locator('#cashflowChart .cf-table thead [data-month-index="0"]').hover();
      assert.equal(await page.locator('#cashflowChart .cf-table [data-month-index="0"].cf-active').count()>1,true);
    });
    await check('375pxで横スクロールと固定見出し',async()=>{
      await page.setViewportSize({width:375,height:800});
      await page.waitForTimeout(200);
      evidence.narrow=await page.evaluate(()=>{
        const scroll=document.querySelector('#cashflowChart .cf-scroll');
        const y=document.querySelector('#cashflowChart .cf-yaxis');
        const heading=document.querySelector('#cashflowChart .cf-row-label');
        return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
          scroll:scroll.scrollWidth,client:scroll.clientWidth,yPosition:getComputedStyle(y).position,
          headingPosition:getComputedStyle(heading).position};
      });
      assert.ok(evidence.narrow.scroll>evidence.narrow.client);
      assert.equal(evidence.narrow.yPosition,'sticky');
      assert.equal(evidence.narrow.headingPosition,'sticky');
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'step4-rate-375.png')});
      await page.setViewportSize({width:1440,height:1000});
    });
    await check('CSV月別円額と印刷用パネル',async()=>{
      evidence.export=await page.evaluate(()=>({csv:cashflowCsvText(latestCashflow),print:$('cashflowPrintReport').textContent,
        panelData:latestCashflow.panelData}));
      assert.match(evidence.export.csv,/年月,A日常の増減,A中間納付/);
      assert.match(evidence.export.csv,/差額累積/);
      assert.match(evidence.export.print,/月別資金推移と内訳/);
      const monthRow=evidence.export.csv.split(/\r?\n/).find(line=>line.startsWith(evidence.export.panelData.months[0]+','));
      const columns=monthRow?.split(',')||[];
      assert.equal(columns.length,15,monthRow);
      assert.equal(Number(columns[1]),evidence.export.panelData.cases.A.rows[0].flow);
      assert.equal(Number(columns[7]),evidence.export.panelData.cases.B.rows[0].flow);
      assert.equal(Number(columns[14]),evidence.export.panelData.expectedDiff[0].cumulative);
      assert.equal(await page.locator('#cashflowPrintReport .cf-segment').count(),2);
      await page.emulateMedia({media:'print'});
      await page.pdf({path:path.join(output,'step4-rate-print.pdf'),format:'A4',printBackground:true});
      await page.emulateMedia({media:'screen'});
      delete evidence.export.panelData;
      evidence.export={csvHeader:evidence.export.csv.split(/\r?\n/).find(line=>line.startsWith('年月,')),printTitle:evidence.export.print.slice(0,70)};
    });
    await check('方式比較モードでも同じパネル',async()=>{
      await page.locator('input[name="cashflowComparisonType"][value="methodImpact"]').check();
      await page.locator('#cashflowInterimStatus').selectOption('none');
      evidence.method=await page.evaluate(()=>({engine:latestCashflow?.engine?.status,panel:latestCashflow?.panelData?.status,
        chart:Boolean(document.querySelector('#cashflowChart .cf-plot'))}));
      assert.equal(evidence.method.engine,'complete',JSON.stringify(evidence.method));
      assert.equal(evidence.method.panel.integrity,'ok');
      assert.equal(evidence.method.chart,true);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'step4-method-desktop.png')});
    });
    await check('中間未確認は未算定のまま、既知の月別部分だけ表示',async()=>{
      await page.locator('#cashflowInterimStatus').selectOption('unknown');
      evidence.partial=await page.evaluate(()=>({result:$('cashflowResult').textContent,
        panel:latestCashflow?.panelData?.status,
        interimEvents:latestCashflow?.panelData?.cases?.A?.rows?.flatMap(row=>row.events.filter(event=>event.kind==='interim')).length,
        notices:document.querySelector('#cashflowChart .cf-notices')?.textContent||'',
        csv:cashflowCsvText(latestCashflow)}));
      assert.match(evidence.partial.result,/未算定/);
      assert.equal(evidence.partial.panel.interim,'unconfirmed');
      assert.equal(evidence.partial.interimEvents,0);
      assert.match(evidence.partial.notices,/中間納付は未確認/);
      const partialRow=evidence.partial.csv.split(/\r?\n/).find(line=>/^\d{4}-\d{2},/.test(line))?.split(',')||[];
      assert.equal(partialRow.length,15);
      for(const index of [2,3,4,8,9,10])assert.equal(partialRow[index],'','未確認の税額を0円CSVにしない');
      delete evidence.partial.csv;
      await page.locator('#cashflowInterimStatus').selectOption('none');
    });
    await check('保存・再読込で同じSTEP4月別結果を再構成',async()=>{
      const before=await page.evaluate(()=>latestCashflow.panelData.expectedDiff);
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});
      const after=await page.evaluate(()=>latestCashflow?.panelData?.expectedDiff);
      assert.deepEqual(after,before);
      assert.equal(await page.locator('#cashflowChart .cf-plot').count(),1);
    });
    await check('指示書ケース1の実ブラウザ描画とマーカー列中心',async()=>{
      const example=await page.evaluate(()=>{
        const months=Array.from({length:12},(_,index)=>`${2027+Math.floor((index+3)/12)}-${String((index+3)%12+1).padStart(2,'0')}`);
        const interim={status:'auto',base:[{month:'2027-11',amount:700000}],changed:[{month:'2027-11',amount:700000}]};
        const engine=ShohizeiCashflow.calculate({periodStart:'2027-04',periodEnd:'2028-03',
          salesDeltas:months.map(month=>({month,amount:-180000})),purchaseDeltas:[],salesLag:1,
          annualTax:{base:1440000,changed:-720000},interim,settlementMonth:'2028-05',refundMonth:'2028-07'});
        const baselineFlows=months.map(month=>({month:ShohizeiCashflow.shiftMonth(month,1),amount:120000}));
        const data=ShohizeiCashflowPanelData.buildPanelData({engine,interim,baselineFlows,
          mode:'rateImpact',priceBasis:'taxExclusiveFixed',labels:{A:'A案（食品8％維持）',B:'B案（食品1％）'}});
        window.__step4AcceptanceCase1=data;
        const container=document.createElement('div');container.id='acceptanceCase1';container.style.width='1280px';
        document.body.appendChild(container);
        ShohizeiCashflowPanelView.renderCashflowPanel(container,data);
        const markers=[...container.querySelectorAll('.cf-marker')];
        const positions=[['2027-11',markers[0]],['2027-11',markers[1]],['2028-05',markers[2]],['2028-07',markers[3]]].map(([month,marker])=>{
          const index=data.months.indexOf(month),box=marker.getBoundingClientRect();
          const table=container.querySelector(`.cf-table thead [data-month-index="${index}"]`).getBoundingClientRect();
          const chart=container.querySelector(`.cf-hit[data-month-index="${index}"]`).getBoundingClientRect();
          return {month,markerX:box.x+box.width/2,tableX:table.x+table.width/2,chartX:chart.x+chart.width/2};
        });
        return {integrity:data.status.integrity,max:data.expectedDiff.find(row=>row.month==='2028-04')?.cumulative,
          finalA:data.cases.A.rows.at(-1).cumulative,finalB:data.cases.B.rows.at(-1).cumulative,positions};
      });
      assert.equal(example.integrity,'ok');assert.equal(example.max,-2160000);
      assert.equal(example.finalA,0);assert.equal(example.finalB,0);
      for(const item of example.positions){assert.ok(Math.abs(item.markerX-item.tableX)<=1,JSON.stringify(item));assert.ok(Math.abs(item.markerX-item.chartX)<=1,JSON.stringify(item));}
      evidence.case1=example;
      await page.locator('#acceptanceCase1').screenshot({path:path.join(output,'step4-acceptance-case1.png')});
    });
    await check('20か月の実ブラウザ印刷パネルは同じ縦軸で2段',async()=>{
      evidence.print20=await page.evaluate(()=>{
        const data=structuredClone(window.__step4AcceptanceCase1);
        for(const month of ['2028-08','2028-09','2028-10','2028-11']){
          data.months.push(month);
          for(const key of ['A','B'])data.cases[key].rows.push({month,flow:0,events:[],monthTotal:0,cumulative:0});
          data.expectedDiff.push({month,monthTotal:0,cumulative:0});
        }
        const container=document.createElement('div');container.id='acceptanceCase20';container.style.width='680px';
        container.innerHTML=ShohizeiCashflowPanelView.renderCashflowPanelHtml(data,{print:true,width:680});
        document.body.appendChild(container);
        const segments=[...container.querySelectorAll('.cf-segment')];
        return {segments:segments.length,axis:segments.map(segment=>[...segment.querySelectorAll('.cf-yaxis text')].map(item=>item.textContent)),
          widths:segments.map(segment=>segment.getBoundingClientRect().width)};
      });
      assert.equal(evidence.print20.segments,2);
      assert.deepEqual(evidence.print20.axis[0],evidence.print20.axis[1]);
      assert.ok(evidence.print20.widths.every(width=>width<=681),JSON.stringify(evidence.print20));
      await page.locator('#acceptanceCase20').screenshot({path:path.join(output,'step4-acceptance-20months.png')});
    });
    await check('390pxでも見出しを140pxへ縮め月列の横スクロールを維持',async()=>{
      await page.evaluate(()=>{document.querySelector('#acceptanceCase1').style.display='none';document.querySelector('#acceptanceCase20').style.display='none';});
      await page.setViewportSize({width:390,height:800});
      await page.waitForTimeout(200);
      evidence.narrow390=await page.evaluate(()=>{
        const panel=document.querySelector('#cashflowChart');
        return {axis:panel.querySelector('.cf-yaxis').getBoundingClientRect().width,
          scroll:panel.querySelector('.cf-scroll').scrollWidth,
          client:panel.querySelector('.cf-scroll').clientWidth,
          document:document.documentElement.scrollWidth};
      });
      assert.equal(evidence.narrow390.axis,140);
      assert.ok(evidence.narrow390.scroll>evidence.narrow390.client);
      assert.equal(evidence.narrow390.document,390);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'step4-rate-390.png')});
      await page.setViewportSize({width:1440,height:1000});
    });
    await check('年11回の共通中間納付は重複せず、A/B表の納付額は両方残る',async()=>{
      evidence.eleven=await page.evaluate(()=>{
        const months=Array.from({length:12},(_,i)=>`2027-${String(i+1).padStart(2,'0')}`);
        const rows=[];let cumulative=0;
        for(let i=0;i<12;i++){
          const events=i<11?[{kind:'interim',amount:1000}]:[];
          cumulative-=i<11?1000:0;
          rows.push({month:months[i],flow:0,events,monthTotal:i<11?-1000:0,cumulative});
        }
        const data={months,unitLabel:'千円',priceBasis:'mixed',status:{mode:'methodImpact',interim:'auto',finalMonthEntered:true,refundMonthEntered:true,notes:[]},
          cases:{A:{label:'A案',rows:structuredClone(rows)},B:{label:'B案',rows:structuredClone(rows)}},
          expectedDiff:months.map(month=>({month,monthTotal:0,cumulative:0}))};
        const container=document.createElement('div');container.id='acceptanceEleven';container.style.width='1000px';
        document.body.appendChild(container);ShohizeiCashflowPanelView.renderCashflowPanel(container,data);
        return {common:container.querySelectorAll('.cf-marker-common').length,
          separate:container.querySelectorAll('.cf-marker-A,.cf-marker-B').length,
          payments:[...container.querySelectorAll('.cf-payment')].length,
          flowRows:[...container.querySelectorAll('.cf-row-label')].filter(item=>item.textContent==='日常の増減').length};
      });
      assert.deepEqual(evidence.eleven,{common:11,separate:0,payments:22,flowRows:0});
      await page.locator('#acceptanceEleven').screenshot({path:path.join(output,'step4-11-interims.png')});
    });
    await check('部分試算の不足月は未算定表示、不要な予定月は警告しない',async()=>{
      evidence.partialMonths=await page.evaluate(()=>{
        const interim={status:'scheduled',base:[{month:'2027-02',amount:3000}],changed:[{month:'2027-02',amount:5000}]};
        const engine=ShohizeiCashflow.calculate({periodStart:'2027-01',periodEnd:'2027-01',salesDeltas:[],purchaseDeltas:[],
          annualTax:{base:10000,changed:9000},interim});
        const data=ShohizeiCashflowPanelData.buildPanelData({engine,interim,mode:'methodImpact',adapter:{annualTax:{base:10000,changed:9000}}});
        const container=document.createElement('div');container.id='acceptancePartial';document.body.appendChild(container);
        ShohizeiCashflowPanelView.renderCashflowPanel(container,data);
        const refund=ShohizeiCashflow.calculate({periodStart:'2027-01',periodEnd:'2027-01',salesDeltas:[],purchaseDeltas:[],
          annualTax:{base:-1000,changed:-2000},interim:{status:'none'}});
        const refundData=ShohizeiCashflowPanelData.buildPanelData({engine:refund,interim:{status:'none'},mode:'methodImpact',adapter:{annualTax:{base:-1000,changed:-2000}}});
        return {integrity:data.status.integrity,text:container.textContent,refundFlags:{payment:refundData.status.finalMonthEntered,refund:refundData.status.refundMonthEntered}};
      });
      assert.equal(evidence.partialMonths.integrity,'unavailable');
      assert.match(evidence.partialMonths.text,/未算定.*納付予定月が未設定/);
      assert.doesNotMatch(evidence.partialMonths.text,/内部整合エラー/);
      assert.deepEqual(evidence.partialMonths.refundFlags,{payment:true,refund:false});
      await page.locator('#acceptancePartial').screenshot({path:path.join(output,'step4-partial-input-wait.png')});
    });
    await check('CSV月別構成の安全なA案配分とB−A別前提を実ブラウザに表示',async()=>{
      evidence.csvBasis=await page.evaluate(()=>{
        const interim={status:'none'};
        const engine=ShohizeiCashflow.calculate({periodStart:'2027-01',periodEnd:'2027-03',salesDeltas:[],purchaseDeltas:[],annualTax:{base:0,changed:0},interim});
        const data=ShohizeiCashflowPanelData.buildPanelData({engine,interim,mode:'rateImpact',lags:{sales:0,purchases:0},
          calc:{ctx:{start:'2027-01-01',end:'2027-03-31'}},comparison:{current:{sales:{totalTax:12000},purchases:{totalTax:6000}}},
          adapter:{distribution:{requested:'csv',bySide:{sales:'csv',purchases:'csv'}},source:{sourcePeriodStart:'2025-01-01',sourcePeriodEnd:'2025-03-31',sourcePeriodConfirmed:true,csvMonthlyDateUnknownCount:0}},
          taxEntryRows:{sales:[{code:'1',rate:'8',amount:'600',source:'csv'}],purchases:[{code:'5',rate:'8',amount:'300',source:'csv'}]},
          csvMonthlyGroups:[...[100,200,300].map((amount,i)=>({kind:'sales',code:'1',rate:'8',month:`2025-0${i+1}`,amount})),
            ...[100,100,100].map((amount,i)=>({kind:'purchases',code:'5',rate:'8',month:`2025-0${i+1}`,amount}))]});
        const container=document.createElement('div');container.id='acceptanceCsv';container.style.width='680px';document.body.appendChild(container);
        ShohizeiCashflowPanelView.renderCashflowPanel(container,data);
        const csv=cashflowCsvText({adapter:{periodStart:'2027-01',periodEnd:'2027-03',annualTax:{base:0,changed:0},distribution:{used:'csv',bySide:{sales:'csv',purchases:'csv'}}},
          engine,methodLabel:'架空例',notes:[],panelData:data});
        return {flow:data.cases.A.rows.map(row=>row.flow),note:container.querySelector('.cf-notices')?.textContent||'',plot:Boolean(container.querySelector('.cf-plot')),
          csvBasis:csv.includes('表示用配分前提,B−Aの取引差額：')};
      });
      assert.deepEqual(evidence.csvBasis.flow,[0,2000,4000]);
      assert.match(evidence.csvBasis.note,/照合済みCSV月別構成比/);
      assert.match(evidence.csvBasis.note,/B−Aの取引差額/);
      assert.equal(evidence.csvBasis.plot,true);
      assert.equal(evidence.csvBasis.csvBasis,true);
      await page.locator('#acceptanceCsv').screenshot({path:path.join(output,'step4-csv-monthly-basis.png')});
    });
    assert.deepEqual(evidence.pageErrors,[]);
    fs.writeFileSync(path.join(output,'browser-evidence.json'),JSON.stringify(evidence,null,2),'utf8');
    console.log(JSON.stringify({checks:evidence.checks,rate:evidence.rate,alignment:evidence.alignment,narrow:evidence.narrow,method:evidence.method,pageErrors:evidence.pageErrors,output},null,2));
    await context.close();
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
