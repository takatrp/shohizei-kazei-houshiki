'use strict';
// Local HTTP + synthetic TKC rows only. Writes evidence outside the repository.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {REQUIRED_HEADERS}=require('../journal-csv.js');

const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.MONTHLY_CASH_RESULTS_DIR||path.join(root,'..','shohizei-monthly-cash-evidence'));
if(output===root||output.startsWith(root+path.sep))throw new Error('証跡の保存先はリポジトリ外を指定してください。');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer((request,response)=>{
  const target=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(target!==root&&!target.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  fs.readFile(target===root?path.join(root,'index.html'):target,(error,body)=>{
    if(error){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':target===root?types['.html']:types[path.extname(target)]||'text/plain; charset=utf-8'}).end(body);
  });
});

function cell(value){
  const text=String(value??'');
  return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}
const headers=[...REQUIRED_HEADERS,'摘要'];
function journal(rows){return [headers,...rows.map(row=>headers.map(header=>row[header]??''))].map(row=>row.map(cell).join(',')).join('\r\n');}
function entry(date,debit,credit,amount,{code='',side='貸方',rate='8',business='',memo=''}={}){
  const result={月日:date,借方科目名:debit,貸方科目名:credit,借方取引金額:amount,貸方取引金額:amount,摘要:memo};
  if(code){result[`${side}課税区分`]=code;result[`${side}税率`]=rate;
    result[`${side}軽減税率か否か`]=rate==='8'||rate==='1'?'1':'0';
    if(business)result[`${side}事業区分`]=business;}
  return result;
}
function syntheticRows({offset=0}={}){
  const rows=[];
  for(let month=1;month<=12;month++){
    const day=`2025/${String(month).padStart(2,'0')}/15`;
    rows.push(entry(day,month%2?'普通預金':'当座預金','架空売上',9000000+offset,{code:'1',side:'貸方',business:'2'}));
    rows.push(entry(day,'架空仕入','普通預金',6300000,{code:'5',side:'借方'}));
  }
  rows.push(entry('2025/01/01','普通預金','前期繰越',10000000,{memo:'開始残高'}));
  rows.push(entry('2025/03/15','当座預金','現金',1000000));
  rows.push(entry('2025/05/15','未払消費税等','普通預金',1200000,{memo:'消費税中間納付'}));
  rows.push(entry('2025/08/15','普通預金','未収消費税等',300000,{memo:'消費税還付'}));
  return rows;
}

async function seed(page){
  await page.evaluate(()=>{
    resetAll();
    const set=(id,value)=>{$(id).value=String(value);};
    $('entityCorporation').checked=true;$('entityIndividual').checked=false;
    $('taxScenarioFood1').checked=true;$('taxScenarioCurrent').checked=false;
    $('compareRegular').checked=true;$('compareSimplified').checked=true;
    $('compareSpecial2').checked=false;$('compareSpecial3').checked=false;
    set('periodStart','2028-01-01');set('periodEnd','2028-12-31');
    set('currentReturnMethod','regular');set('baseTaxableSales','30000000');
    set('exemptPurchaseState','no');set('regularDetailMethod','auto');
    set('proposalFoodClassificationState','confirmed');set('proposalPurchaseClassificationState','confirmed');
    set('foodSalesPriceBasis','netFixed');set('foodPurchasePriceBasis','netFixed');
    workflowStep=1;update();
  });
}
async function upload(page,rows,name){
  await page.evaluate(()=>{workflowStep=1;$('journalImportDisclosure').open=true;update();});
  await page.locator('#journalCsvFile').setInputFiles({name,mimeType:'text/csv',buffer:Buffer.from(journal(rows),'utf8')});
  await page.waitForFunction(()=>Boolean(pendingJournalImport?.analysis));
  await page.locator('#applyJournalImportBtn').click();
  await page.waitForFunction(()=>Boolean(appliedJournalImport?.applied));
}
async function toStep4(page,{food=true,method=false}={}){
  await page.evaluate(({food,method})=>{
    $('taxScenarioFood1').checked=food;$('taxScenarioCurrent').checked=!food;
    $('proposalFoodClassificationState').value='confirmed';
    $('proposalPurchaseClassificationState').value='confirmed';
    for(const row of taxEntryRows.sales)if(row.code==='1'&&row.rate==='8')row.foodAmount=row.amount;
    for(const row of taxEntryRows.purchases)if(row.code==='5'&&row.rate==='8')row.foodAmount=row.amount;
    renderTaxEntryRows('sales');renderTaxEntryRows('purchases');
    document.querySelector(`input[name="cashflowComparisonType"][value="${method?'methodImpact':'rateImpact'}"]`).checked=true;
    $('cashflowMethod').value='regular';$('cashflowBaseMethod').value='regular';$('cashflowChangedMethod').value='simplified';
    $('cashflowInterimStatus').value='none';
    $('cashflowSettlementMonth').value='2029-02';$('cashflowRefundMonth').value='2029-03';
    workflowStep=5;update();
  },{food,method});
}
async function confirmCash(page){
  await page.locator('input[name="cashActualMode"][value="csv"]').check();
  await page.locator('#cashActualSourceStart').fill('2025-01-01');
  await page.locator('#cashActualSourceEnd').fill('2025-12-31');
  await page.locator('#cashAccountConfirmed').check();
  await page.locator('#cashActualPeriodConfirmed').check();
  await page.locator('#cashActualCoverageConfirmed').check();
  await page.locator('#cashTaxCoverageConfirmed').check();
  await page.locator('#cashActualCandidates details').first().evaluate(element=>{element.open=true;});
  await page.locator('#cashActualCandidates [data-cash-decision="opening"][value="exclude"]').check();
  await page.locator('#cashActualCandidates details').last().evaluate(element=>{element.open=true;});
  await page.locator('#cashActualCandidates [data-cash-decision="tax"][value="exclude"]').first().check();
  await page.locator('#cashActualCandidates details').last().evaluate(element=>{element.open=true;});
  await page.locator('#cashActualCandidates [data-cash-decision="tax"][value="exclude"]').last().check();
}
function snapshot(page){return page.evaluate(()=>({
  mode:document.querySelector('input[name="cashflowComparisonType"]:checked')?.value,
  actual:latestCashflow?.panelData?.actualCash,
  status:latestCashflow?.panelData?.status,
  months:latestCashflow?.panelData?.months,
  rowsA:latestCashflow?.panelData?.cases?.A?.rows,
  rowsB:latestCashflow?.panelData?.cases?.B?.rows,
  engine:latestCashflow?.engine?.rows,
  csv:cashflowCsvText(latestCashflow),copy:cashflowExportText(latestCashflow),
  print:$('cashflowPrintReport').textContent,
  source:cashActualAnalysis?.fileKey || cashActualSavedSnapshot?.fileKey,
  currentChoices:cashActualSelectedAccounts,
  candidateCount:Object.keys(cashActualOpeningDecisions).length+Object.keys(cashActualTaxDecisions).length
}));}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const evidence={checks:[],errors:[],output};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ja-JP',acceptDownloads:true});
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route=>route.abort());
    const page=await context.newPage();
    page.on('pageerror',error=>evidence.errors.push(error.message));
    page.on('dialog',dialog=>dialog.accept());
    const check=async(name,fn)=>{try{const detail=await fn();evidence.checks.push({name,status:'PASS',detail});}
      catch(error){evidence.checks.push({name,status:'FAIL',error:String(error.stack||error)});throw error;}};
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    await seed(page);
    await check('架空の12か月TKC CSVを画面から反映',async()=>{
      await upload(page,syntheticRows(),'synthetic-cash-2025.csv');
      const state=await page.evaluate(()=>({rows:cashActualAnalysis?.rowCount,candidates:cashActualAnalysis?.taxCandidates?.length,
        accounts:cashActualAnalysis?.suggestedAccounts?.length,workflow:workflowStep}));
      assert.deepEqual(state,{rows:28,candidates:2,accounts:3,workflow:2});
      return state;
    });
    await toStep4(page);
    await check('未確認候補は完成扱いにならず、科目・期間・除外の画面確認',async()=>{
      await page.locator('input[name="cashActualMode"][value="csv"]').check();
      const before=await page.evaluate(()=>({status:cashActualResult(latestCalculation.calc).status,
        candidateText:$('cashActualCandidates').textContent,screen:$('cashflowChart').textContent}));
      assert.equal(before.status,'unconfirmed');
      assert.match(before.screen,/未算定|確認/);
      await confirmCash(page);
      const after=await page.evaluate(()=>({status:cashActualResult(latestCalculation.calc).status,
        base:cashActualResult(latestCalculation.calc).months.reduce((sum,row)=>sum+row.base,0),
        gross:cashActualResult(latestCalculation.calc).months.reduce((sum,row)=>sum+row.gross,0)}));
      assert.equal(after.status,'complete');
      assert.equal(after.base,32400000);
      assert.equal(after.gross,41500000);
      assert.doesNotMatch(before.candidateText,/架空売上|架空仕入|消費税中間納付/);
      return after;
    });
    await check('税率変更：月別CSV実績とA/B税イベント、STEP4差額の円単位一致',async()=>{
      const state=await snapshot(page);
      assert.equal(state.status.integrity,'ok');
      assert.equal(state.actual.months.reduce((sum,row)=>sum+row.base,0),32400000);
      for(let i=0;i<state.months.length;i++)assert.equal(state.rowsB[i].monthTotal-state.rowsA[i].monthTotal,state.engine[i].net);
      assert.match(state.csv,/CSV実績共通ベース/);
      assert.match(state.copy,/CSV現預金実績/);
      assert.match(state.print,/CSV実績の月別資金増減/);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'monthly-cash-rate.png')});
      return {months:state.months.length,base:state.actual.months.reduce((sum,row)=>sum+row.base,0),lastDiff:state.engine.at(-1).cumulative};
    });
    await check('方式比較・現行税率：共通実績とSTEP4差額の一致',async()=>{
      await toStep4(page,{food:false,method:true});
      const state=await snapshot(page);
      assert.equal(state.status.integrity,'ok');
      assert.equal(state.actual.months.reduce((sum,row)=>sum+row.base,0),32400000);
      for(let i=0;i<state.months.length;i++)assert.equal(state.rowsB[i].monthTotal-state.rowsA[i].monthTotal,state.engine[i].net);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'monthly-cash-method-current.png')});
      return {lastDiff:state.engine.at(-1).cumulative};
    });
    await check('方式比較・食品1％：両案に共通Dを加えて差額不変',async()=>{
      await toStep4(page,{food:true,method:true});
      const unconfirmed=await page.evaluate(()=>cashActualResult(latestCalculation.calc).status);
      assert.equal(unconfirmed,'unconfirmed');
      await page.locator('#cashActualFoodEightConfirmed').check();
      const state=await snapshot(page);
      assert.equal(state.status.integrity,'ok');
      for(let i=0;i<state.months.length;i++)assert.equal(state.rowsB[i].monthTotal-state.rowsA[i].monthTotal,state.engine[i].net);
      const commonD=Object.values(state.actual.commonDelta||{}).reduce((sum,value)=>sum+value,0);
      assert.equal(commonD,-2100000);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'monthly-cash-method-food.png')});
      return {foodEightBeforeConfirmation:unconfirmed,commonD};
    });
    await check('390pxで横スクロール・ラベルの重なりなし',async()=>{
      await page.setViewportSize({width:390,height:840});
      const widths=await page.evaluate(()=>({document:document.documentElement.scrollWidth,
        scroller:$('cashflowChart').querySelector('.cf-scroll')?.scrollWidth,
        client:$('cashflowChart').querySelector('.cf-scroll')?.clientWidth}));
      assert.equal(widths.document,390);
      assert.ok(widths.scroller>widths.client);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'monthly-cash-390.png')});
      await page.setViewportSize({width:1440,height:1000});
      return widths;
    });
    await check('端末保存から実再読込し匿名月別集計を復元',async()=>{
      const before=await snapshot(page);
      await page.evaluate(()=>{$('saveToDevice').checked=true;saveState();});
      await page.reload({waitUntil:'domcontentloaded'});
      const after=await snapshot(page);
      assert.equal(after.actual?.restored,true);
      assert.deepEqual(after.actual.months,before.actual.months);
      assert.equal(after.status.integrity,'ok');
      assert.match(after.csv,/CSV実績共通ベース/);
      return {source:after.source,months:after.actual.months.length};
    });
    await check('完成したCSV実績パネルのA4印刷PDF',async()=>{
      const before=await snapshot(page);
      await page.evaluate(()=>{document.body.dataset.printTarget='cashflow';});
      await page.emulateMedia({media:'print'});
      await page.pdf({path:path.join(output,'monthly-cash-complete-print.pdf'),format:'A4',printBackground:true});
      await page.emulateMedia({media:'screen'});
      const text=await page.locator('#cashflowPrintReport').textContent();
      assert.match(text,/CSV実績の月別資金増減/);
      assert.match(text,/2,700/);
      assert.match(text,/A案 当月資金増減/);
      assert.match(text,/B案 当月資金増減/);
      const a=Math.round(before.rowsA[0].monthTotal/1000).toLocaleString('ja-JP');
      const b=Math.round(before.rowsB[0].monthTotal/1000).toLocaleString('ja-JP');
      assert.ok(text.includes(a)&&text.includes(b),`A/Bの初月値 ${a}/${b} が印刷にありません`);
      return {pdf:path.join(output,'monthly-cash-complete-print.pdf'),printTextLength:text.length,
        commonFirstMonthThousands:2700,aFirstMonthThousands:a,bFirstMonthThousands:b};
    });
    await check('明示1％仕訳を含むCSVでは、8％実績確認後も共通Dを二重加算しない',async()=>{
      const rows=[...syntheticRows(),entry('2025/09/15','普通預金','架空食品1％売上',101000,
        {code:'1',rate:'1',side:'貸方',business:'2'})];
      await upload(page,rows,'synthetic-explicit-one-percent.csv');
      await toStep4(page,{food:true,method:true});
      await confirmCash(page);
      await page.locator('#cashActualFoodEightConfirmed').check();
      const state=await page.evaluate(()=>({count:cashActualAnalysis?.explicitOnePercentCount,
        status:cashActualResult(latestCalculation.calc).status,
        reason:cashActualResult(latestCalculation.calc).reasons.join('／'),
        panelRenderable:latestCashflow?.panelData?.status?.renderable ?? false,
        panelExists:Boolean(latestCashflow?.panelData),
        cashStatus:$('cashActualStatus').textContent,
        displayed:$('cashflowChart').textContent}));
      assert.equal(state.count,1);
      assert.equal(state.status,'unconfirmed');
      assert.match(state.reason,/明示1％.*二重加算しない/);
      assert.equal(state.panelRenderable,false);
      assert.match(state.cashStatus,/要確認/);
      assert.doesNotMatch(state.displayed,/CSV実績の月別資金増減（共通）/);
      await page.locator('#cashflowPanel').screenshot({path:path.join(output,'monthly-cash-explicit-one-percent-unconfirmed.png')});
      return {count:state.count,status:state.status,reason:state.reason,panelExists:state.panelExists};
    });
    await check('別CSVへの差し替えで旧除外判断を引き継がない',async()=>{
      await upload(page,syntheticRows({offset:10000}),'synthetic-cash-replacement.csv');
      await toStep4(page,{food:true,method:true});
      await page.locator('input[name="cashActualMode"][value="csv"]').check();
      const state=await page.evaluate(()=>({accountConfirmed:$('cashAccountConfirmed').checked,
        sourceStart:$('cashActualSourceStart').value,opening:Object.keys(cashActualOpeningDecisions).length,
        tax:Object.keys(cashActualTaxDecisions).length,status:cashActualResult(latestCalculation.calc).status}));
      assert.deepEqual(state,{accountConfirmed:false,sourceStart:'',opening:0,tax:0,status:'unconfirmed'});
      return state;
    });
    await check('別CSV未確認状態もA4印刷で隠さない',async()=>{
      await page.evaluate(()=>{document.body.dataset.printTarget='cashflow';});
      await page.emulateMedia({media:'print'});
      await page.pdf({path:path.join(output,'monthly-cash-print.pdf'),format:'A4',printBackground:true});
      await page.emulateMedia({media:'screen'});
      const text=await page.locator('#cashflowPrintReport').textContent();
      assert.match(text,/CSV|資金/);
      return {pdf:path.join(output,'monthly-cash-print.pdf'),printTextLength:text.length};
    });
    assert.deepEqual(evidence.errors,[]);
  }finally{
    fs.writeFileSync(path.join(output,'monthly-cash-browser-evidence.json'),JSON.stringify(evidence,null,2),'utf8');
    await browser.close();server.close();
  }
  console.log(JSON.stringify({checks:evidence.checks,errors:evidence.errors,output},null,2));
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
