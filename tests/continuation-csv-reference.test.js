'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const obligation=require('../tax-obligation.js'),sales=require('../sales-scenario.js'),windowRows=require('../taxable-window-rows.js');
const sourcePeriod={start:'2026-01-01',end:'2026-12-31'};
function fixture(){
  let seen;
  const sandbox={document:{getElementById:()=>null},BUSINESS_TYPES:[{key:'type2',name:'小売',deemed:.8}],
    ShohizeiTaxObligation:{...obligation,assessVoluntaryRoute(input){seen=input;return obligation.assessVoluntaryRoute(input);}},
    ShohizeiSalesScenario:sales,ShohizeiTaxableWindowRows:windowRows,
    taxEntryRows:{sales:[{id:'prior-sale',source:'csv',code:'1',rate:'8',businessType:'type2',amount:'1080000',foodAmount:'1080000'}],purchases:[]},
    importedActualOnePercent:null,importedCsvOriginalSourceId:'confirmed-prior',
    importedCsvDailyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',date:'2026-01-15',amount:972000,transactionKind:'ordinary'},{kind:'sales',code:'1',rate:'8',businessType:'type2',date:'2026-07-15',amount:108000,transactionKind:'ordinary'}],
    importedCsvMonthlyGroups:null,importedCsvMonthlyDateUnknownCount:0,rowCsvKnownZeros:{nonTaxableSales:true},
    sharedCaseFacts:{priorActual:{status:'resolved',value:{period:{...sourcePeriod},nationalTax:'78000'}},csvSource:{status:'resolved',value:{sourceId:'confirmed-prior',period:{...sourcePeriod},periodConfirmed:true,fullMonthCoverageConfirmed:true}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../continuation-ui.js'),'utf8'),sandbox);
  sandbox.ShohizeiContinuationUI.restore({version:1,prior:{period:{...sourcePeriod},exactMethod:'regular'},voluntary:{route:'election',targetStatus:'unknown',filingStatus:'filed',filingDate:'2026-12-01',assetRestrictionState:'no',otherObligation:'no'}});
  const ctx={start:'2027-01-01',end:'2027-12-31',entity:'individual',taxScenario:'current',currentReturnMethod:'exempt',baseSalesEntered:true,baseTaxableSales:1000000,specificSalesEntered:false,specificPayrollEntered:false};
  return {sandbox,ctx,run:()=>sandbox.ShohizeiContinuationUI.selectionEligibility(ctx,'regular',{eligibility:'eligible',reasons:[]}),history:()=>seen.history};
}
test('対象年の前年CSVを正式資料期で切り出し、特定期間の実績を方式可否へ共有する',()=>{
  const f=fixture(),result=f.run();assert.equal(result.eligibility,'eligible');
  const fact=f.history().find(p=>p.start==='2026-01-01'&&p.end==='2026-06-30');
  // Taxable source year: January972,000 / 1.08 = 900,000; July is outside the window.
  assert.equal(fact.taxableSales,900000);assert.equal(fact.source,'csv-actual');assert.equal(fact.entered,true);
  assert.equal(f.history().length,2);assert.equal(f.ctx.specificSalesEntered,false);
});
test('資料期の方式不明・期間違い・競合は現在の免税方式から推定しない',()=>{
  for(const change of [s=>delete s.prior.exactMethod,s=>s.prior.period={start:'2025-01-01',end:'2025-12-31'}]){
    const f=fixture(),saved=f.sandbox.ShohizeiContinuationUI.snapshot();change(saved);f.sandbox.ShohizeiContinuationUI.restore(saved);
    assert.equal(f.run().eligibility,'unknown');assert.equal(f.history().length,1);
  }
  const f=fixture();f.sandbox.sharedCaseFacts.priorActual.status='conflict';assert.equal(f.run().eligibility,'unknown');assert.equal(f.history().length,1);
});
test('資料期が課税なら現在免税でも1050万円を税込閾値で誤判定しない',()=>{
  const f=fixture(),row=f.sandbox.taxEntryRows.sales[0];row.rate='10';row.amount='11000000';row.foodAmount='';
  for(const [i,g]of f.sandbox.importedCsvDailyGroups.entries()){g.rate='10';g.amount=i?500000:10500000;}
  f.ctx.specificPayrollEntered=true;f.ctx.specificPayrollAmount=20000000;
  assert.equal(f.run().eligibility,'eligible');const fact=f.history().find(p=>p.start==='2026-01-01');
  assert.ok(Math.abs(fact.taxableSales-10500000/1.1)<1e-7);assert.ok(fact.taxableSales<10000000);
});
test('資料期自体の明示免税は税込を使い、課税方式の事実と競合すれば未確認を保つ',()=>{
  const f=fixture(),saved=f.sandbox.ShohizeiContinuationUI.snapshot();
  saved.prior={};saved.voluntary.targetStatus='exempt';saved.voluntary.targetStatusPeriod={...sourcePeriod};f.sandbox.ShohizeiContinuationUI.restore(saved);
  assert.equal(f.run().eligibility,'eligible');assert.equal(f.history().find(p=>p.start==='2026-01-01').taxableSales,972000);
  saved.prior={period:{...sourcePeriod},exactMethod:'regular'};f.sandbox.ShohizeiContinuationUI.restore(saved);
  assert.equal(f.run().eligibility,'unknown');assert.equal(f.history().length,1);
});
test('参照期間CSVでも同一性・正式期間・全月網羅・日付・現在行対応のguardを維持する',()=>{
  for(const change of [f=>f.sandbox.importedCsvOriginalSourceId='other',f=>f.sandbox.sharedCaseFacts.csvSource.value.period={start:'2027-01-01',end:'2027-12-31'},f=>f.sandbox.sharedCaseFacts.csvSource.value.fullMonthCoverageConfirmed=false,f=>f.sandbox.sharedCaseFacts.csvSource.status='conflict',f=>f.sandbox.importedCsvMonthlyDateUnknownCount=1,f=>f.sandbox.taxEntryRows.sales[0].amount='1080001']){
    const f=fixture();change(f);assert.equal(f.run().eligibility,'unknown');assert.equal(f.history().length,1);
    assert.ok(!f.history().some(p=>p.source==='csv-actual'));
  }
});
test('明示された特定期間の入力はCSV実績で上書きしない',()=>{
  const f=fixture();f.ctx.specificSalesEntered=true;f.ctx.specificTaxableSales=500000;
  assert.equal(f.run().eligibility,'eligible');const fact=f.history().find(p=>p.start==='2026-01-01');
  assert.equal(fact.taxableSales,500000);assert.equal(fact.source,'actual');assert.equal(f.history().length,2);
});
