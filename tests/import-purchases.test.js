'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const I=require('../import-purchases.js');
const T=require('../tax-entry-rows.js');
const R=require('../tax-return-engine.js');
const J=require('../journal-csv.js');
const C=require('../cash-journal.js');
const {rowsFromJournalAnalysis}=require('../tax-entry-csv.js');
const calendar=require('../tax-calendar.js');
const interim=require('../interim-tax-engine.js');
// All amounts and rows are invented. No customer source data is included.
const components=(code,national,local,goods=100000,rate='10')=>Object.entries({goods,national,local}).map(([importComponent,amount])=>({code,rate,importComponent,amount:String(amount)}));
const rows=()=>({sales:[{code:'1',businessType:'type2',rate:'10',amount:'1100000'},{code:'3',amount:'250000'}],
  purchases:[...components('55',7800,2199),...components('65',3900,1099),...components('75',7800,2198)]});
function input(source=rows()){
  const result=R.aggregateReturnRows(source);
  assert.deepEqual(result.reasons,[]);
  return {...result.input,periodStart:'2026-01-01',periodEnd:'2026-12-31',periodMonths:12};
}
function oracleCredit(n55,n65,n75,method,numerator=4n,denominator=5n){
  // Independent integer rational calculation, not the production aggregator.
  if(method==='full')return n55+n65+n75;
  if(method==='individual')return n55+n75*numerator/denominator;
  return (n55+n65+n75)*numerator/denominator;
}
for(const method of ['individual','proportional','full']) test(`輸入国税を直接控除・独立計算照合 ${method}`,()=>{
  const source=rows();if(method==='full')source.sales[1].amount='0';
  const result=R.calculateCurrentLawReturn(input(source),method);
  assert.equal(result.referenceCalculable,true);
  assert.equal(result.schedule23.creditableTotal,Number(oracleCredit(7800n,3900n,7800n,method)));
  assert.equal(result.schedule23.fields['⑮C'],19500);
  assert.equal(result.schedule23.fields['⑨C'],0,'輸入本体を国内税込額へ混ぜない');
  assert.equal(result.schedule23.fields['⑩C'],0);
});
test('地方税実額・仕入対価を変えても国税控除は変わらず、国地方合計の78％を使わない',()=>{
  const source=rows(),before=R.calculateCurrentLawReturn(input(source),'individual');
  source.purchases.filter(r=>r.importComponent==='local').forEach(r=>r.amount='123');
  source.purchases.filter(r=>r.importComponent==='goods').forEach(r=>r.amount='7654321');
  const after=R.calculateCurrentLawReturn(input(source),'individual');
  assert.equal(after.schedule23.creditableTotal,14040);
  assert.deepEqual(after.mainReturn,before.mainReturn);
  assert.notEqual(I.aggregate(source.purchases).national,(I.aggregate(source.purchases).national+369)*.78);
});
for(const method of ['simplified','special2','special3']) test(`輸入実額を追加控除しない ${method}`,()=>{
  const source=rows(),before=R.calculateCurrentLawSalesMethod(input(source),method,{type2:.8});
  source.purchases=[];
  const after=R.calculateCurrentLawSalesMethod(input(source),method,{type2:.8});
  assert.equal(before.totalBeforeInterim,after.totalBeforeInterim);
});
test('不足税額は前提付き概算とし、識別不能な行や空欄は0円にしない',()=>{
  for(const removed of ['national','local']){
    const source=rows();source.purchases=source.purchases.filter(r=>!(r.code==='55'&&r.importComponent===removed));
    const result=R.calculateCurrentLawReturn(input(source),'individual');
    assert.equal(result.referenceCalculable,true);assert.equal(result.exactComplete,false);assert.ok(result.reasons.length);
  }
  const unknown=rows();unknown.purchases[0].importComponent='';
  assert.equal(T.aggregateScenarioPurchases(unknown).complete,false);
  assert.equal(T.aggregateTaxRows(unknown).fields.taxableOnlyPurchaseTax.entered,false);
  assert.equal(T.aggregateTaxRows(unknown).fields.commonPurchaseTax.entered,false);
  assert.match(I.aggregate(unknown.purchases).errors.join(' '),/未分類/);
});
test('明示0円と空欄・不正値・安全整数外・不正税率を区別',()=>{
  assert.equal(I.aggregate(components('55',0,0,0)).complete,true);
  for(const amount of ['', 'abc', '1.5','9007199254740992']){
    const source=components('55',7800,2200);source[1].amount=amount;
    assert.equal(I.aggregate(source).complete,false,amount);
  }
  assert.equal(I.aggregate(components('55',7800,2200,100000,'5')).complete,false);
});
test('返品・訂正のマイナスは各構成要素を一度だけ差引き、差引後負数は停止',()=>{
  const source=[...components('55',7800,2199),...components('55',-780,-219,-10000)];
  const result=I.aggregate(source);
  assert.equal(result.complete,true);assert.equal(result.national,7020);assert.equal(result.local,1980);assert.equal(result.goods,90000);
  assert.equal(I.aggregate([...source,...components('55',-10000,0,0)]).complete,false);
});
test('短期の5億円判定は年換算し、輸入国税自体は年換算しない',()=>{
  const value=input();value.taxableSalesGross['10']=363000000;value.nonTaxableSales=10000000;
  value.periodEnd='2026-06-30';value.periodMonths=6;
  const result=R.calculateCurrentLawReturn(value,'individual');
  assert.equal(result.schedule23.fullCreditEligible,false);assert.equal(result.schedule23.annualizedTaxableSales,660000000);
  assert.equal(result.schedule23.importNationalTax['10'],19500);
});
test('国内税額と輸入国税を加え、元行の金額は変更しない',()=>{
  const source=rows();source.purchases.push({code:'5',rate:'10',amount:'11000'});
  const copy=JSON.stringify(source),result=T.aggregateScenarioPurchases(source);
  assert.equal(result.invoiceTax,1000);assert.equal(result.imported.national,19500);
  assert.equal(result.totalCreditableTax,1000+19500*100/78);
  assert.equal(JSON.stringify(source),copy);
  assert.equal(R.calculateCurrentLawReturn(input(source),'individual').schedule23.creditableTotal,14820);
});
test('軽減8％輸入は固定課税価格の概算で国地方税を8分の1、関税・本体は固定',()=>{
  const reduced={purchases:[...components('55',6240,1760,100000,'8'),{code:'55',rate:'8',importComponent:'duty',amount:'10000'}]};
  const copy=JSON.stringify(reduced),before=T.aggregateScenarioPurchases(reduced,{taxScenario:'current'});
  const future=T.aggregateScenarioPurchases(reduced,{taxScenario:'foodProposal'});
  assert.equal(future.complete,true);assert.equal(future.imported.estimated,true);
  assert.equal(future.imported.national,780);assert.equal(future.imported.local,220);
  assert.equal(future.imported.goods,100000);assert.equal(future.imported.duty,10000);
  assert.equal(future.totalAmount-before.totalAmount,-7000);
  assert.match(future.imported.assumptions.join(' '),/課税価格.*固定|8分の1/);
  const half=T.aggregateScenarioPurchases(reduced,{taxScenario:'foodProposal',importFoodFraction:.5,foodForecastMethod:'uniform',proposalFraction:.5});
  assert.equal(half.imported.national,4875);assert.equal(half.imported.local,1375);
  assert.equal(JSON.stringify(reduced),copy);
  assert.equal(T.aggregateScenarioPurchases({purchases:components('55',7800,2200)},{taxScenario:'foodProposal'}).complete,true);
  assert.equal(T.bulkFillFoodAmount(reduced.purchases,'purchases').eligibleCount,0);
});
const headers=['月日','税','業','借方CD','借方科目名','貸方CD','貸方科目名','取引金額','税率','内、消費税等','税抜き金額','取引年月日','控','輸入区分','元帳摘要（仕入れ資産等の総称）'];
function csv(records){return [headers,...records.map(r=>headers.map(h=>r[h]??''))].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');}
const fx=(amount,component='',rate='10.0%')=>({'月日':'1.15','税':'55','借方CD':'100','借方科目名':component==='goods'?'輸入仕入':'仮払消費税等','貸方CD':'200','貸方科目名':'普通預金','取引金額':amount,'税率':rate,'内、消費税等':'','税抜き金額':'','取引年月日':'20260115','輸入区分':component});
test('別行FX4の輸入を全行保持し、列空欄から国税・地方税・本体を推定しない',()=>{
  const analysis=J.analyzeTkcJournalText(csv([fx(100000),fx(7800),fx(2199)]));
  assert.equal(analysis.importEntries.length,3);assert.equal(analysis.unsupportedEntries.length,0);
  assert.equal(analysis.invoicePurchases['10'],0);assert.equal(analysis.monthlyGroups.length,0);
  const converted=rowsFromJournalAnalysis(analysis,J.resolveImportValues(analysis));
  assert.equal(converted.purchases.length,1);assert.equal(converted.purchases[0].sourceCount,3);assert.ok(converted.purchases.every(r=>r.importComponent===''));
  assert.equal(I.aggregate(converted.purchases).complete,false);
});
test('輸入区分が明記されたCSVは税額等を一度ずつ渡す',()=>{
  const analysis=J.analyzeTkcJournalText(csv([fx(100000,'goods'),fx(7800,'national'),fx(2199,'local')]));
  const converted=rowsFromJournalAnalysis(analysis,J.resolveImportValues(analysis));
  const imported=I.aggregate(converted.purchases);
  assert.equal(imported.complete,true);assert.equal(imported.national,7800);assert.equal(imported.local,2199);
  assert.equal(imported.paid,109999);
});
test('輸入時の国税・地方税は現金支出に一度残し、申告の納付除外候補にしない',()=>{
  const analysis=C.analyzeCashJournalText(csv([fx(100000,'goods'),fx(7800,'national'),fx(2199,'local')]));
  assert.equal(analysis.taxCandidates.length,0);
  const movement=C.buildMonthlyCashMovement(analysis,{selectedAccounts:['普通預金'],sourcePeriodStart:'2026-01-01',sourcePeriodEnd:'2026-12-31',sourcePeriodConfirmed:true,sourceCoverageConfirmed:true,targetStart:'2026-01-01',targetEnd:'2026-12-31'});
  assert.equal(movement.status,'complete');assert.equal(movement.months[0].base,-109999);assert.equal(movement.months[0].excludedTax,0);
});
for(const [start,end] of [['2024-01-01','2024-12-31'],['2023-03-01','2024-02-29'],['2024-02-29','2025-02-28'],['2025-01-31','2026-01-30'],['2025-04-30','2026-04-29']])test(`暦の1年判定 ${start}`,()=>assert.equal(calendar.isFullYearPeriod(start,end),true));
test('365日でも暦の1年でなければ確認が必要、無効日も除外',()=>{
  assert.equal(calendar.isFullYearPeriod('2024-01-01','2024-12-30'),false);
  assert.equal(calendar.isFullYearPeriod('2024-02-29','2025-02-27'),false);
  assert.equal(calendar.isFullYearPeriod('2025-02-29','2026-02-28'),false);
});
test('非1年の1％中間納付は承認・短縮設定にかかわらず未算定',()=>{
  for(const periodShortening of ['none','yes']){
    const result=interim.plan({taxScenario:'foodProposal',currentStart:'2028-01-01',currentEnd:'2028-06-30',periodShortening});
    assert.equal(result.status,'unavailable');assert.equal(result.count,null);assert.equal(result.totals,null);assert.deepEqual(result.installments,[]);
  }
});
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function source(name){const start=html.indexOf('function '+name+'(');const end=html.indexOf('\nfunction ',start+1);return html.slice(start,end<0?undefined:end);}
function periodHarness(){
  const fields={periodStart:{value:'2028-01-01'},periodEnd:{value:'2028-12-31'},taxScenarioFood1:{checked:true},taxScenarioCurrent:{checked:false},cashflowInterimStatus:{value:'auto'},proposalPeriodConfirmationNotice:{classList:{toggle(){}}}};
  const context=vm.createContext({$:id=>fields[id],ShohizeiTaxCalendar:calendar,validateTaxPeriod:require('../tax-engine.js').validateTaxPeriod,
    taxScenarioKey:()=>fields.taxScenarioFood1.checked?'foodProposal':'current',window:{confirm:()=>true},proposalPeriodLastAccepted:null,proposalPeriodConfirmedScope:'',latestCalculation:{calc:{sentinel:true}}});
  vm.runInContext(source('confirmProposalPeriod')+'\n'+source('update'),context);
  context.confirmProposalPeriod();return {fields,context};
}
test('期間確認キャンセルで計算・保存せず、直前の期間とモードへ戻す',()=>{
  const {fields,context}=periodHarness();let calls=0,question='';context.calculate=()=>{calls++;};context.window.confirm=text=>{question=text;return false;};
  fields.periodEnd.value='2028-06-30';
  assert.equal(context.update().sentinel,true);assert.equal(calls,0);assert.equal(fields.periodEnd.value,'2028-12-31');
  assert.equal(question,'中間納付が自動計算されませんがよろしいですか？');
});
test('期間確認承認は同じ対象期で一度、変更時は再確認し自動設定済みにしない',()=>{
  const {fields,context}=periodHarness();let calls=0;context.window.confirm=()=>{calls++;return true;};
  fields.periodEnd.value='2028-06-30';assert.equal(context.confirmProposalPeriod(),true);assert.equal(fields.cashflowInterimStatus.value,'unknown');
  context.confirmProposalPeriod();assert.equal(calls,1);fields.periodEnd.value='2028-09-30';context.confirmProposalPeriod();assert.equal(calls,2);
});
test('輸入の個別金額が安全整数でも合計が範囲外なら未算定',()=>{
  const value=I.aggregate([...components('55',0,0,Number.MAX_SAFE_INTEGER),...components('65',0,0,1)]);
  assert.equal(value.complete,false);assert.match(value.errors.join(' '),/合計.*安全/);
});
test('日付入力途中の空欄で直前の有効期間を失わない',()=>{
  const {fields,context}=periodHarness();
  fields.periodEnd.value='';context.confirmProposalPeriod();
  context.window.confirm=()=>false;fields.periodEnd.value='2028-06-30';
  assert.equal(context.confirmProposalPeriod(),false);assert.equal(fields.periodEnd.value,'2028-12-31');
});

test('摘要の地方税を国税として二重分類せず、関税は控除対象外、本体は候補にする',()=>{
  for(const [memo,component] of [['輸入消費税','national'],['地方消費税','local'],['輸入関税','duty'],['商品仕入','goods'],['消費税・地方消費税合計','taxTotal']]){
    const value=I.classify({memo});assert.equal(value.component,component);assert.equal(value.assumed,true);
  }
  assert.equal(I.classify({memo:'関税及び消費税'}).component,'');
  assert.equal(I.classify({memo:'分類不能',tax:'',net:'',value:'1000'}).component,'');
  assert.equal(I.classify({memo:'対価の調整',tax:'0',net:'1000',value:'1000'}).component,'goods');
  assert.equal(I.classify({component:'national',memo:'地方消費税'}).component,'national','明示区分を優先');
});
test('摘要候補CSVは集約しても税額合計・関税・件数を保持し、申告額の厳密再現と称しない',()=>{
  const source=csv([fx(100000,'','軽 8.0%'),fx(10000,'','軽 8.0%'),fx(6240,'','軽 8.0%'),fx(1760,'','軽 8.0%'),fx(200000,'','軽 8.0%')].map((row,i)=>({...row,'元帳摘要（仕入れ資産等の総称）':['商品仕入','輸入関税','輸入消費税','地方消費税','商品仕入'][i]})));
  const a=J.analyzeTkcJournalText(source),converted=rowsFromJournalAnalysis(a,J.resolveImportValues(a));
  assert.equal(a.importEntries.length,5);assert.equal(converted.purchases.length,4);assert.equal(converted.purchases.reduce((n,r)=>n+r.sourceCount,0),5);
  const imported=I.aggregate(converted.purchases);assert.equal(imported.complete,true);assert.equal(imported.national,6240);assert.equal(imported.local,1760);assert.equal(imported.duty,10000);assert.equal(imported.goods,300000);
  const raw=R.aggregateReturnRows({...rows(),purchases:converted.purchases}).input;
  const out=R.calculateCurrentLawReturn({...raw,periodStart:'2026-01-01',periodEnd:'2026-12-31',periodMonths:12},'individual');
  assert.equal(out.referenceCalculable,true);assert.equal(out.exactComplete,false);
});
test('国地方税合計の78/22概算は実額の別行を上書きせず支払を一度保持',()=>{
  const result=I.aggregate([...components('55',7800,2199),{code:'55',rate:'10',importComponent:'taxTotal',amount:'1001'}]);
  assert.equal(result.complete,true);assert.equal(result.national,8581);assert.equal(result.local,2419);assert.equal(result.recordedPaid,111000);
  assert.equal(result.paid,111000);assert.equal(result.estimated,true);assert.match(result.assumptions.join(' '),/78％.*22％.*端数/);
});
test('税額なし本体＋関税の課税価格代理概算は選択時のみ、税込割戻しを使わない',()=>{
  const source=[{code:'55',rate:'10',importComponent:'goods',amount:'100000'},{code:'55',rate:'10',importComponent:'duty',amount:'10000'}];
  assert.equal(I.aggregate(source).complete,false);
  const estimate=I.aggregate(source,{estimateFromBase:true});
  assert.equal(estimate.complete,true);assert.equal(estimate.national,8580);assert.equal(estimate.local,2420);assert.equal(estimate.recordedPaid,110000);assert.equal(estimate.estimated,true);
  const actual=I.aggregate([...source,{code:'55',rate:'10',importComponent:'national',amount:'7000'},{code:'55',rate:'10',importComponent:'local',amount:'1900'}],{estimateFromBase:true});
  assert.equal(actual.national,7000);assert.equal(actual.local,1900);assert.equal(actual.estimated,false);
});
test('輸入の食品対象割合・対象期間割合が空欄や範囲外なら0％にしない',()=>{
  for(const importFoodFraction of [NaN,-.1,1.1])assert.equal(I.aggregate(components('55',6240,1760,100000,'8'),{taxScenario:'foodProposal',importFoodFraction}).complete,false);
});

test('政策の輸入税支払差額を国内取引差額・現金支出へ二重に加えない',()=>{
  const adapter=require('../cashflow-adapter.js');
  const source=components('55',6240,1760,100000,'8');
  const before=I.aggregate(source),after=I.aggregate(source,{taxScenario:'foodProposal'});
  const ctx={start:'2028-01-01',end:'2028-12-31',taxScenario:'foodProposal'};
  const months=Array.from({length:12},(_,i)=>({month:`2028-${String(i+1).padStart(2,'0')}`,amount:0}));
  const base={ctx,calc:{ctx,sales:{totalAmount:1100000},purchases:{totalAmount:after.paid,imported:after},methods:[{key:'regular',amount:99000,eligibility:'eligible'}]},comparison:{current:{sales:{totalAmount:1100000},purchases:{totalAmount:before.paid,imported:before}},rows:[{key:'regular',currentAmount:92000,proposalAmount:99000,currentMethod:{eligibility:'eligible'},proposalMethod:{eligibility:'eligible'},reasons:[]}]},methodKey:'regular',taxEntryRows:{sales:[],purchases:source}};
  for(const transactionBasis of [null,{distribution:{notes:[],bySide:{sales:'uniform',purchases:'uniform'}},salesDeltas:months,purchaseDeltas:months}]){
    const result=adapter.create({...base,transactionBasis});
    assert.equal(result.ready,true);assert.equal(result.purchaseDeltas.reduce((s,r)=>s+r.amount,0),-7000);
    assert.equal(result.annualPurchaseDelta,-7000);
    assert.equal(-result.annualPurchaseDelta-(result.annualTax.changed-result.annualTax.base),0,'控除減少と輸入時支払減少が精算後に一致');
    assert.match(result.distribution.notes.join(' '),/輸入/);
  }
});
