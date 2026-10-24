'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../taxable-window-rows.js'),J=require('../journal-csv.js'),C=require('../tax-entry-csv.js'),R=require('../tax-return-engine.js');
const P={start:'2028-01-01',end:'2028-12-31'},WIN={start:'2028-07-01',end:P.end};
const clone=v=>JSON.parse(JSON.stringify(v));
function csv(entries){const headers=J.REQUIRED_HEADERS;return [headers,...entries.map(e=>headers.map(h=>e[h]??''))].map(row=>row.join(',')).join('\n');}
function entry(side,code,amount,date,rate='10',business='2',credit=''){
  return {月日:date,[side+'課税区分']:code,[side+'取引金額']:amount,[side+'税率']:rate,[side+'事業区分']:side==='貸方'||code==='11'?business:'',[side+'軽減税率か否か']:rate==='10'?'0':'1',[side+'控除割合']:credit,[side+'科目名']:'秘密の取引先科目',摘要:'秘密摘要'};
}
function fixture(){const a=J.analyzeTkcJournalText(csv([entry('貸方','1',990000,'2028/01/15'),entry('借方','5',495000,'2028/01/15'),entry('貸方','1',110000,'2028/07/01'),entry('借方','5',55000,'2028/07/01')]));const r=J.resolveImportValues(a);assert.equal(r.ready,true);const rows=C.rowsFromJournalAnalysis(a,r);return {period:P,window:WIN,rows,actualOnePercentEntries:rows.actualOnePercentEntries,csvSource:{status:'resolved',value:{sourceId:'one-source',period:P,periodConfirmed:true,fullMonthCoverageConfirmed:true}},currentSourceId:'one-source',dailyGroups:a.dailyGroups,monthlyGroups:a.monthlyGroups,dateUnknownCount:a.monthlyDateUnknownEntryCount,knownZeros:{nonTaxableSales:true}};}

test('parserは匿名分類・日付・符号だけの日別集計を保持する',()=>{
  const f=fixture();assert.equal(f.dailyGroups.length,4);const json=JSON.stringify(f.dailyGroups);assert.doesNotMatch(json,/秘密|科目|摘要|account|row/);
  assert.deepEqual(f.dailyGroups.map(g=>[g.date,g.amount]),[['2028-01-15',495000],['2028-01-15',990000],['2028-07-01',55000],['2028-07-01',110000]]);
});
test('期中登録は季節CSV実額を優先し、一般課税5000円を独立検算する',()=>{
  const f=fixture(),before=clone(f),r=W.slice(f);assert.equal(r.ready,true,r.reason);assert.equal(r.method,'csv-daily');
  assert.equal(r.rows.sales[0].amount,'110000');assert.equal(r.rows.purchases[0].amount,'55000');
  const built=R.aggregateReturnRows(r.rows,{knownNonTaxableZero:true});built.input.periodStart=WIN.start;built.input.periodEnd=WIN.end;built.input.periodMonths=6;
  const tax=R.calculateCurrentLawReturn(built.input,'auto');assert.equal(tax.mainReturn.totalBeforeInterim,5000); // 10000 - 5000.
  assert.deepEqual(f,before);
});
test('日別があれば月途中も実額、月別だけなら月初・月末境界だけ実額',()=>{
  const f=fixture();f.window={start:'2028-01-16',end:P.end};assert.equal(W.slice(f).rows.sales[0].amount,'110000');
  const legacy=fixture();delete legacy.dailyGroups;assert.equal(W.slice(legacy).method,'csv-monthly');assert.equal(W.slice(legacy).rows.sales[0].amount,'110000');
  legacy.window={start:'2028-07-02',end:P.end};const missing=W.slice(legacy);assert.equal(missing.ready,false);assert.match(missing.reason,/月途中.*日別/);
});
test('別CSV・前年度・全月不明・日付不明・現在行修正を実額へ昇格しない',()=>{
  for(const change of [f=>f.currentSourceId='different',f=>f.csvSource.value.period={start:'2027-01-01',end:'2027-12-31'},f=>f.csvSource.value.fullMonthCoverageConfirmed=false,f=>f.dateUnknownCount=1,f=>f.rows.sales[0].amount='1100001',f=>f.rows.purchases[0].source='manual',f=>f.dailyGroups[0].date='']){
    const f=fixture();change(f);const r=W.slice(f);assert.equal(r.ready,false);assert.equal(r.rows,null);assert.ok(r.reason);
  }
});
test('食品政策期間額は日別交差を先に算定し、部分食品だけ代理と明示する',()=>{
  const f=fixture();f.period={start:'2027-01-01',end:'2027-12-31'};f.window={start:'2027-02-01',end:f.period.end};f.csvSource.value.period={...f.period};
  f.rows.sales[0].rate='8';f.rows.sales[0].amount='1080000';f.rows.sales[0].foodAmount='540000';
  f.rows.purchases[0].rate='8';f.rows.purchases[0].amount='540000';f.rows.purchases[0].foodAmount='540000';
  f.dailyGroups=[{kind:'sales',code:'1',rate:'8',businessType:'type2',date:'2027-01-15',amount:972000,transactionKind:'ordinary'},{kind:'sales',code:'1',rate:'8',businessType:'type2',date:'2027-04-01',amount:108000,transactionKind:'ordinary'},{kind:'purchases',code:'5',rate:'8',usage:'taxableOnly',date:'2027-01-15',amount:486000,transactionKind:'ordinary'},{kind:'purchases',code:'5',rate:'8',usage:'taxableOnly',date:'2027-04-01',amount:54000,transactionKind:'ordinary'}];
  const r=W.slice(f);assert.equal(r.ready,true,r.reason);assert.equal(r.rows.sales[0].amount,'108000');assert.equal(r.rows.sales[0].foodAmount,'54000');assert.equal(r.foodPeriodAmountsById[r.rows.sales[0].id],54000);assert.equal(r.foodPeriodAmountsById[r.rows.purchases[0].id],54000);assert.match(r.notes.join(''),/代理額.*日次実額ではありません/);
});
test('明示1％は日付別サイドカーだけに保持し8％予測行へ重複しない',()=>{
  const f=fixture();const e1={kind:'sale',date:'2028-01-10',taxCode:'1',ratePercent:1,businessType:'type2',amount:101000,source:'csvActual',transactionKind:'ordinary'},e2={...e1,date:'2028-07-01',amount:202000};
  f.actualOnePercentEntries=[e1,e2];f.dailyGroups.push(...[e1,e2].map(e=>({kind:'sales',code:'1',rate:'1',businessType:'type2',date:e.date,amount:e.amount,transactionKind:'ordinary'})));
  const r=W.slice(f);assert.equal(r.ready,true,r.reason);assert.equal(r.rows.sales.length,1);assert.deepEqual(r.actualOnePercentEntries,[e2]);
  const missing=clone(f);missing.actualOnePercentEntries=[];assert.equal(W.slice(missing).ready,false);
});
test('元税率別売上・返品の符号を一度だけ切り出す',()=>{
  const f=fixture();f.rows.sales.push({id:'return',source:'csv',code:'11',rate:'10',businessType:'type2',amount:'11000',foodAmount:''});f.dailyGroups.push({kind:'sales',code:'11',rate:'10',businessType:'type2',date:'2028-07-02',amount:-11000,transactionKind:'adjustment'});
  const r=W.slice(f);assert.equal(r.ready,true,r.reason);assert.equal(r.rows.sales.find(row=>row.code==='11').amount,'11000');assert.equal(r.rows.sales[0].amount,'110000');
  f.rows.sales[1].amount='-11000';f.dailyGroups.at(-1).amount=11000;assert.equal(W.slice(f).rows.sales[1].amount,'-11000');
});
test('年間差引0の仕入は登録後の正負を消さず、ゼロ分母を比率化しない',()=>{
  const f=fixture();f.rows.purchases=[];f.dailyGroups=f.dailyGroups.filter(g=>g.kind!=='purchases');f.dailyGroups.push({kind:'purchases',code:'5',rate:'10',usage:'taxableOnly',date:'2028-01-01',amount:55000,transactionKind:'ordinary'},{kind:'purchases',code:'5',rate:'10',usage:'taxableOnly',date:'2028-07-01',amount:-55000,transactionKind:'adjustment'});
  const r=W.slice(f);assert.equal(r.ready,true,r.reason);assert.equal(r.rows.purchases[0].amount,'-55000');
  const zero=fixture();zero.window={start:'2028-12-01',end:P.end};assert.equal(W.slice(zero).rows.sales[0].amount,'0');assert.equal(W.slice(zero).rows.purchases[0].amount,'0');
});
test('不正な食品額・輸入を黙って0円又は国内実額へ変換しない',()=>{
  const f=fixture();f.rows.sales[0].rate='8';f.rows.sales[0].foodAmount='bad';for(const g of f.dailyGroups)if(g.kind==='sales')g.rate='8';assert.equal(W.slice(f).ready,false);
  f.rows.sales[0].foodAmount='-100';assert.equal(W.slice(f).ready,false);
  const imported=fixture();imported.rows.purchases.push({source:'csv',code:'55',rate:'8',amount:'100',importComponent:'national'});assert.equal(W.slice(imported).ready,false);
});


test('登録前だけの未確認返品は登録後取引の計算を止めない',()=>{
  const f=fixture();f.rows.sales.push({source:'csv',code:'11',rate:'8',businessType:'type2',amount:'10800',foodAmount:'',originalTaxableState:'unknown'});
  f.dailyGroups.push({kind:'sales',code:'11',rate:'8',businessType:'type2',date:'2028-06-01',amount:-10800,transactionKind:'adjustment'});
  const result=W.slice(f);assert.equal(result.ready,true,result.reason);assert.ok(!result.rows.sales.some(row=>row.code==='11'));
  const built=R.aggregateReturnRows(result.rows,{knownNonTaxableZero:true});assert.deepEqual(built.reasons,[]);
  built.input.periodStart=WIN.start;built.input.periodEnd=WIN.end;built.input.periodMonths=6;
  assert.equal(R.calculateCurrentLawReturn(built.input,'auto').mainReturn.totalBeforeInterim,5000);
});
