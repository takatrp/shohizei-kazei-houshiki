const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../prior-actual-evidence.js');
const F=require('../food-interim-comparison.js');
const J=require('../journal-csv.js');
const C=require('../tax-entry-csv.js');
const Rows=require('../tax-entry-rows.js');
const P={start:'2026-04-01',end:'2027-03-31'};
const clone=x=>JSON.parse(JSON.stringify(x));
function input(extra={}){
  return {priorFacts:{status:'resolved',value:{period:{...P},nationalTax:'1092000'}},
    csvSource:{status:'resolved',value:{sourceId:'original-A',period:{...P},periodConfirmed:true,fullMonthCoverageConfirmed:true}},
    currentSourceId:'original-A',rows:{sales:[
      {id:'s1',source:'csv',code:'1',rate:'8',businessType:'type2',amount:'32400000',foodAmount:'32400000'},
      {id:'s2',source:'csv',code:'1',rate:'10',businessType:'type2',amount:'22000000',foodAmount:''}],
    purchases:[{id:'p1',source:'csv',code:'5',rate:'8',amount:'21600000',foodAmount:'21600000'},
      {id:'p2',source:'csv',code:'5',rate:'10',amount:'15400000',foodAmount:''}]},
    monthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2026-04',amount:32400000,transactionKind:'ordinary'},
      {kind:'sales',code:'1',rate:'10',businessType:'type2',month:'2026-05',amount:22000000,transactionKind:'ordinary'},
      {kind:'purchases',code:'5',rate:'8',usage:'taxableOnly',month:'2026-04',amount:21600000,transactionKind:'ordinary'},
      {kind:'purchases',code:'5',rate:'10',usage:'taxableOnly',month:'2026-05',amount:15400000,transactionKind:'ordinary'}],
    actualOnePercentEntries:[],foodSalesConfirmed:true,foodPurchasesConfirmed:'confirmed',exactMethod:'regular',
    creditMethod:'full',adjustmentNational:0,knownNonTaxableZero:true,...extra};
}

test('共有の正式前期CSVを再利用し、4金額を二重入力せず国税庁例示を再現する',()=>{
  const data=input();const before=clone(data);const evidence=E.fromSharedCsv(data);
  assert.equal(evidence.available,true,evidence.reasons.join(' / '));
  assert.equal(evidence.reusedRows,4);
  assert.equal(evidence.priorActual.source,'actual');
  assert.deepEqual(evidence.priorActual.period,P);
  assert.equal(evidence.priorActual.evidence.sourceId,'original-A');
  const comparison=F.compare({ordinaryInput:{priorNationalTax:1092000,priorStart:P.start,priorEnd:P.end,
    currentStart:'2027-04-01',currentEnd:'2028-03-31',entityType:'corporation',periodShortening:'none',
    corporateExtension:'none',specialCircumstances:'none'},priorActual:evidence.priorActual});
  assert.equal(comparison.status,'ready');
  assert.equal(comparison.special.totals.total,350000);
  assert.deepEqual(data,before,'共有資料・現在行・確認を変更しない');
});

test('食品内数と新聞等8％を分割し、用途・控除割合・複数事業を保持する',()=>{
  const data=input();data.rows.sales[0].foodAmount='10800000';
  data.rows.purchases[0]={...data.rows.purchases[0],code:'72',creditRatio:'80'};
  data.monthlyGroups[2]={...data.monthlyGroups[2],code:'72',usage:'common',creditRatio:'80'};
  const result=E.fromSharedCsv(data);
  assert.equal(result.available,true,result.reasons.join(' / '));
  assert.deepEqual(result.priorActual.transactions.filter(x=>x.side==='sales'&&x.originalRate===8).map(x=>[x.category,x.amount]),
    [['food',10800000],['other',21600000]]);
  const purchase=result.priorActual.transactions.find(x=>x.side==='purchases'&&x.originalRate===8);
  assert.equal(purchase.usage,'common');assert.equal(purchase.creditRatio,.8);
  assert.equal(F.recalculatePrior(result.priorActual,'reduction').status,'ready');
});

test('正式期間一致だけでは別CSV・ID不明・未確認・競合を同一資料にしない',()=>{
  for(const change of [
    d=>d.currentSourceId='different',d=>d.currentSourceId='',d=>d.csvSource.value.sourceId='',
    d=>d.csvSource.status='conflict',d=>d.priorFacts.status='conflict',
    d=>d.csvSource.value.periodConfirmed=false,d=>d.csvSource.value.fullMonthCoverageConfirmed=false,
    d=>d.csvSource.value.period.end='2027-02-28',d=>d.priorFacts.value.period={start:'2027-04-01',end:'2028-03-31'}
  ]){const d=input();change(d);const r=E.fromSharedCsv(d);assert.equal(r.available,false);assert.equal(r.priorActual,null);assert.ok(r.reasons.length);}
});

test('旧regular分類・当期手入力・4金額仮定を前期実績に昇格しない',()=>{
  for(const change of [d=>d.exactMethod='',d=>d.exactMethod='regular-or-other',
    d=>d.rows.sales[0].source='manual',d=>d.rows.sales[0].source='four-amount']){
    const d=input();change(d);const r=E.fromSharedCsv(d);assert.equal(r.available,false);assert.equal(r.priorActual,null);
  }
});

test('同じCSVの同額補足・食品内数手修正は再利用、税区分・金額・事業変更は拒否',()=>{
  const same=input();same.rows.sales[0].source='csv-edited';same.rows.sales[0].foodAmount='10800000';
  assert.equal(E.fromSharedCsv(same).available,true);
  for(const change of [d=>d.rows.sales[0].amount='32400001',d=>d.rows.sales[0].businessType='type3',
    d=>d.rows.purchases[0].code='6',d=>d.rows.purchases.splice(0,1),
    d=>d.monthlyGroups.push({...d.monthlyGroups[0],businessType:'type3',amount:1}),
    d=>{d.currentAggregateId='new';d.monthlyAggregateId='old';}]){
    const d=input();change(d);const r=E.fromSharedCsv(d);assert.equal(r.available,false);assert.ok(r.reasons.some(x=>/一致|用途/.test(x)));
  }
});

test('食品の自動初期値は照合済みへ変換せず、対象なし・明示0・空欄を区別',()=>{
  const d=input();d.rows.sales[0].foodAmountSource='auto';d.foodSalesConfirmed='unknown';
  assert.equal(E.fromSharedCsv(d).available,false);
  d.foodSalesConfirmed='none';assert.equal(E.fromSharedCsv(d).available,false,'食品額と対象なしが矛盾');
  d.rows.sales[0].foodAmount='0';let r=E.fromSharedCsv(d);assert.equal(r.available,true,r.reasons.join(' / '));
  assert.equal(r.priorActual.transactions.some(x=>x.side==='sales'&&x.category==='food'),false);
  d.foodSalesConfirmed='confirmed';d.rows.sales[0].foodAmount='';assert.equal(E.fromSharedCsv(d).available,false);
  d.foodSalesConfirmed='none';assert.equal(E.fromSharedCsv(d).available,true,'対象なしは空欄食品を0と区分できる');
});

test('非課税売上・国税調整・控除方法の空欄は0や全額控除に補完しない',()=>{
  for(const change of [d=>d.knownNonTaxableZero=false,d=>d.adjustmentNational='',d=>d.creditMethod='']){
    const d=input();change(d);assert.equal(E.fromSharedCsv(d).available,false);
  }
  const d=input({knownNonTaxableZero:false});d.rows.sales.push({id:'n',code:'3',amount:'0',source:'csv'});
  d.monthlyGroups.push({kind:'sales',code:'3',month:'2026-06',amount:0,transactionKind:'ordinary'});
  const r=E.fromSharedCsv(d);assert.equal(r.available,true,r.reasons.join(' / '));
  assert.equal(r.priorActual.nonTaxableSales,0);
});

test('日付不明・正式期間外・返品・年間相殺0・輸入は特例証拠だけ不足にする',()=>{
  for(const change of [d=>d.monthlyGroups[0].month='',d=>d.monthlyGroups[0].month='2026-03',
    d=>d.monthlyGroups[0].amount=-1,d=>d.monthlyGroups[0].transactionKind='adjustment',
    d=>d.rows.sales[0].code='11',d=>d.rows.purchases[0].code='55',d=>d.dateUnknownCount=1,
    d=>d.rows.purchases[0].sourceAdjustmentCount=1]){
    const d=input();change(d);const r=E.fromSharedCsv(d);assert.equal(r.available,false);assert.equal(r.priorActual,null);
  }
});

test('明示1％実績は元税率と日付を照合し、8％予測へ二重追加しない',()=>{
  const d=input();d.priorFacts.value.period={start:'2027-04-01',end:'2028-03-31'};d.csvSource.value.period={...d.priorFacts.value.period};
  d.monthlyGroups=d.monthlyGroups.map(g=>({...g,month:g.month.replace('2026','2027')}));
  const actual={kind:'sale',taxCode:'1',businessType:'type2',date:'2027-05-01',amount:1010000,
    ratePercent:1,amountMode:'included',source:'csvActual',transactionKind:'ordinary'};
  d.actualOnePercentEntries=[actual];
  d.monthlyGroups.push({kind:'sales',code:'1',rate:'1',businessType:'type2',month:'2027-05',amount:1010000,transactionKind:'ordinary'});
  const r=E.fromSharedCsv(d);assert.equal(r.available,true,r.reasons.join(' / '));
  assert.equal(r.priorActual.transactions.filter(x=>x.originalRate===1).length,1);
  assert.equal(r.priorActual.transactions.reduce((sum,x)=>sum+x.amount,0),91400000+1010000);
  for(const change of [x=>x.actualOnePercentEntries=[],x=>x.actualOnePercentEntries[0].date='2027-03-31',
    x=>x.actualOnePercentEntries[0].date='2028-04-01',x=>x.actualOnePercentEntries[0].ratePercent=8,
    x=>x.actualOnePercentEntries[0].transactionKind='adjustment',x=>x.foodSalesConfirmed='none',
    x=>x.actualOnePercentEntries[0].amount=1010001]){
    const invalid=clone(d);change(invalid);assert.equal(E.fromSharedCsv(invalid).available,false);
  }
});

test('明示1％免税仕入の用途・控除割合を月別集計と照合',()=>{
  const d=input();d.priorFacts.value.period={start:'2027-04-01',end:'2028-03-31'};d.csvSource.value.period={...d.priorFacts.value.period};
  d.monthlyGroups=d.monthlyGroups.map(g=>({...g,month:g.month.replace('2026','2027')}));
  d.actualOnePercentEntries=[{kind:'exemptPurchase',taxCode:'72',usage:'common',creditRatio:.8,date:'2027-05-01',amount:101000,
    ratePercent:1,amountMode:'included',source:'csvActual',transactionKind:'ordinary'}];
  d.monthlyGroups.push({kind:'purchases',code:'72',rate:'1',usage:'common',creditRatio:'80',month:'2027-05',amount:101000,transactionKind:'ordinary'});
  const r=E.fromSharedCsv(d);assert.equal(r.available,true,r.reasons.join(' / '));
  assert.deepEqual(r.priorActual.transactions.find(x=>x.originalRate===1),{side:'purchases',amount:101000,originalRate:1,category:'food',
    businessType:'',usage:'common',creditRatio:.8,transactionKind:'ordinary'});
});

test('実際のCSV parser→集約行→共有前期アダプター→特例を一貫して接続する',()=>{
  const headers=[...J.REQUIRED_HEADERS];
  const entries=[
    {月日:'2026/04/10',貸方課税区分:'1',貸方事業区分:'2',貸方税率:'8',貸方軽減税率か否か:'1',貸方取引金額:'32400000'},
    {月日:'2026/05/10',貸方課税区分:'1',貸方事業区分:'2',貸方税率:'10',貸方軽減税率か否か:'0',貸方取引金額:'22000000'},
    {月日:'2026/04/11',借方課税区分:'5',借方税率:'8',借方軽減税率か否か:'1',借方取引金額:'21600000'},
    {月日:'2026/05/11',借方課税区分:'5',借方税率:'10',借方軽減税率か否か:'0',借方取引金額:'15400000'}];
  const csv=[headers.join(','),...entries.map(e=>headers.map(h=>e[h]||'').join(','))].join('\n');
  const analysis=J.analyzeTkcJournalText(csv);const resolved=J.resolveImportValues(analysis);
  assert.equal(resolved.ready,true,resolved.errors?.join(' / '));
  const rows=C.rowsFromJournalAnalysis(analysis,resolved);
  rows.sales=Rows.applyFoodAmountDefaults(rows.sales,'sales').rows;
  rows.purchases=Rows.applyFoodAmountDefaults(rows.purchases,'purchases').rows;
  const r=E.fromSharedCsv(input({rows,monthlyGroups:analysis.monthlyGroups}));
  assert.equal(r.available,true,r.reasons.join(' / '));
  assert.equal(F.recalculatePrior(r.priorActual,'reduction').total,700000);
});

function withCsvReturn({amount=1080000,originalTaxableState='taxable'}={}){
  const d=input();d.rows.sales.push({id:'r',source:'csv',code:'11',rate:'8',businessType:'type2',amount:String(amount),
    foodAmount:String(amount),originalTaxableState});
  d.monthlyGroups.push({kind:'sales',code:'11',rate:'8',businessType:'type2',month:'2026-06',amount:-amount,transactionKind:'adjustment'});
  return d;
}

test('元の課税状態を照合済みのCSV返還11は元税率のまま再利用する',()=>{
  const d=withCsvReturn();const result=E.fromSharedCsv(d);
  assert.equal(result.available,true,result.reasons.join(' / '));
  const returned=result.priorActual.transactions.find(x=>x.transactionKind==='return');
  assert.deepEqual(returned,{side:'sales',originalRate:8,businessType:'type2',transactionKind:'return',originalTaxableState:'taxable',
    sourceTaxCode:'11',amountDirection:'return',amount:1080000,category:'food'});
  assert.equal(F.recalculatePrior(result.priorActual,'reduction').total,620000);
  const exempt=E.fromSharedCsv(withCsvReturn({originalTaxableState:'exempt'}));
  assert.equal(exempt.available,true);assert.equal(F.recalculatePrior(exempt.priorActual,'reduction').total,700000);
  const unknown=E.fromSharedCsv(withCsvReturn({originalTaxableState:'unknown'}));
  assert.equal(unknown.available,false);assert.equal(unknown.priorActual,null);assert.match(unknown.reasons.join(' '),/元取引時の課税/);
});

test('負のCSV返還額は返品取消として1回だけ反転し、元の月額との一致を要求する',()=>{
  const d=withCsvReturn({amount:-1080000});const r=E.fromSharedCsv(d);
  assert.equal(r.available,true,r.reasons.join(' / '));
  assert.equal(F.recalculatePrior(r.priorActual,'reduction').total,780000);
  d.monthlyGroups.at(-1).amount=-1080000;
  const mismatch=E.fromSharedCsv(d);assert.equal(mismatch.available,false);assert.match(mismatch.reasons.join(' '),/一致/);
});

test('明示1％の返還sidecarは元1％時期・課税状態・月額を確認し、署名済み金額を保持する',()=>{
  const d=input();d.priorFacts.value.period={start:'2027-04-01',end:'2028-03-31'};d.csvSource.value.period={...d.priorFacts.value.period};
  d.monthlyGroups=d.monthlyGroups.map(g=>({...g,month:g.month.replace('2026','2027')}));
  d.actualOnePercentEntries=[{kind:'sale',taxCode:'11',businessType:'type2',date:'2028-02-01',amount:-1010000,
    ratePercent:1,amountMode:'included',source:'csvActual',transactionKind:'adjustment',
    originalRatePercent:1,originalDate:'2027-05-01',originalTaxableState:'taxable'}];
  d.monthlyGroups.push({kind:'sales',code:'11',rate:'1',businessType:'type2',month:'2028-02',amount:-1010000,transactionKind:'adjustment'});
  const r=E.fromSharedCsv(d);assert.equal(r.available,true,r.reasons.join(' / '));
  const returned=r.priorActual.transactions.at(-1);assert.equal(returned.amount,-1010000);assert.equal(returned.amountDirection,'signed');
  assert.equal(F.recalculatePrior(r.priorActual,'reduction').nationalSalesReturnTax,7800);
  for(const rate of [8,10]){
    const differentRate=clone(d);differentRate.actualOnePercentEntries[0].originalRatePercent=rate;
    const evidence=E.fromSharedCsv(differentRate);
    assert.equal(evidence.available,false,'既知元税率が違う返品を確認済み1％実前期へ変換しない');
    assert.equal(evidence.priorActual,null);assert.match(evidence.reasons.join(' '),/元税率/);
    assert.equal(differentRate.actualOnePercentEntries[0].originalRatePercent,rate);
  }
  delete d.actualOnePercentEntries[0].originalTaxableState;
  assert.equal(E.fromSharedCsv(d).available,false);
});

test('簡易・2割・3割の共有証拠は使う売上側だけ照合し、不明仕入で売上計算を止めない',()=>{
  for(const exactMethod of ['simplified','special2','special3']){
    const d=input({exactMethod,foodPurchasesConfirmed:'unknown',creditMethod:'',adjustmentNational:'',dateUnknownCount:1});
    d.rows.purchases=[{id:'unknown-import',source:'manual',code:'55',rate:'',amount:'-100',importComponent:'unknown'}];
    d.monthlyGroups=d.monthlyGroups.filter(group=>group.kind==='sales');
    d.monthlyGroups.push({kind:'purchases',code:'55',month:'',amount:-100,transactionKind:'adjustment'});
    d.actualOnePercentEntries=[{kind:'invoicePurchase',amount:'',date:'',transactionKind:'adjustment'}];
    const before=clone(d);const evidence=E.fromSharedCsv(d);
    assert.equal(evidence.available,true,evidence.reasons.join(' / '));
    assert.ok(evidence.priorActual.transactions.every(item=>item.side==='sales'));
    assert.deepEqual(evidence.priorActual.evidence.usedSides,['sales']);
    assert.deepEqual(evidence.priorActual.evidence.foodClassificationVerifiedSides,['sales']);
    assert.equal(F.recalculatePrior(evidence.priorActual,'reduction').total,exactMethod==='special3'?600000:400000);
    assert.deepEqual(d,before,'仕入入力や確認を変更・削除しない');
    assert.equal(E.fromSharedCsv({...d,exactMethod:'regular'}).available,false);
    d.monthlyGroups[0].month='';assert.equal(E.fromSharedCsv(d).available,false,'使う売上側の日付不足は維持');
  }
});
