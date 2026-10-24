'use strict';
// Anonymous display regressions only. Serve localhost and block external requests.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.KAZEI_EVIDENCE_DIR||'/tmp/kazei-return-summary-browser');
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
    for(const sample of [
      {name:'mixed',values:[10800000,11000000,5400000,5500000],sales:1404000,credit:702000,national:702000,local:198000,total:900000},
      {name:'only8',values:[10800000,0,5400000,0],sales:624000,credit:312000,national:312000,local:88000,total:400000},
      {name:'only10',values:[0,11000000,0,5500000],sales:780000,credit:390000,national:390000,local:110000,total:500000}
    ]){
      await page.evaluate(()=>{
        resetAll();for(const id of ['compareRegular','compareSimplified','compareSpecial2','compareSpecial3'])if($(id))$(id).checked=id==='compareRegular';
        $('taxScenarioCurrent').checked=true;$('taxScenarioFood1').checked=false;$('currentReturnMethod').value='regular';$('exemptPurchaseState').value='no';$('regularDetailMethod').value='auto';workflowStep=2;update();
      });
      await page.locator('#quickIndustry').selectOption('manufacturing');
      for(const [i,id]of ['quickFoodSales','quickOtherSales','quickFoodPurchases','quickOtherPurchases'].entries())await page.locator('#'+id).fill(String(sample.values[i]));
      await page.locator('#quickOtherPurchases').blur();await page.locator('#workflowNext').click();
      await page.locator('#methodCards details[data-method="regular"] summary').click();
      const result=await page.evaluate(()=>{const c=calculate(),m=c.methods.find(m=>m.key==='regular');return {version:APP_META.version,method:m,main:c.returnCalculation.mainReturn,screen:$('methodCards').innerText,copy:buildSummaryText(c),csv:buildCsvText(c),print:$('comparisonPrintContent').innerText,summary:$('taxSummary').innerText,rows:taxEntryRows};});
      const y=n=>n.toLocaleString('ja-JP')+'円',formula=`第一表② ${y(sample.sales)} − ④ ${y(sample.credit)} − ⑤ 0円 → 国税 ${y(sample.national)} ＋ 地方税 ${y(sample.local)}`;
      assert.equal(result.version,process.env.KAZEI_EXPECTED_VERSION||'r36.0.4');assert.equal(result.method.amount,sample.total);assert.equal(result.main.fields['②'],sample.sales);
      for(const label of ['screen','copy','csv','print'])assert.ok(result[label].includes(formula),sample.name+':'+label);
      assert.ok(result.screen.includes('売上税額合計 '+y(sample.sales)));assert.ok(result.screen.includes('返還合計 0円'));
      if(sample.values[0])assert.match(result.screen,/②A 軽減8％売上消費税額/);
      await page.screenshot({path:path.join(output,sample.name+'.png'),fullPage:true});
      await page.emulateMedia({media:'print'});await page.pdf({path:path.join(output,sample.name+'.pdf'),format:'A4',printBackground:true});await page.emulateMedia({media:'screen'});
      report.checks.push({name:sample.name,status:'PASS',formula,total:sample.total});report[sample.name]=result;
    }
    assert.deepEqual(report.pageErrors,[]);console.log(JSON.stringify({checks:report.checks,pageErrors:report.pageErrors,evidence:output},null,2));
  }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
