'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const estimator=require('../food-period-estimator.js');

const total=rows=>rows.reduce((sum,row)=>sum+row.amount,0);
function input(overrides={}){
  return {amount:1080,kind:'sales',businessType:'type2',periodStart:'2027-01-01',periodEnd:'2027-12-31',mode:'uniform',
    rows:{sales:[{id:'sale',code:'1',rate:'8',businessType:'type2',amount:'1080',foodAmount:'1080',foodAmountSource:'auto',source:'csv'}]},
    monthlyGroups:[
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-01',amount:972},
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:108}],
    currentSourceId:'source-one',sourceFacts:{status:'resolved',value:{sourceId:'source-one',period:{start:'2027-01-01',end:'2027-12-31'},
      periodConfirmed:true,fullMonthCoverageConfirmed:true}},...overrides};
}

test('年税額用の対象期間額をCSV季節構成から作り、日数按分との差を明示できる',()=>{
  const actual=estimator.estimate(input());
  assert.equal(actual.amount,108); // Only the April 108, not 1080 × 275 / 365.
  assert.equal(actual.method,'group-proxy');
  assert.equal(total(actual.monthly),108);
  assert.match(actual.notes.join(''),/食品実額.*ではありません/);
  const fallback=estimator.estimate(input({sourceFacts:null}));
  assert.equal(fallback.method,'uniform');
  assert.ok(Math.abs(fallback.amount-1080*275/365)<1e-9);
});

test('対象期の食品明細がある場合はグループ代理とは異なる月別額を使う',()=>{
  const data=input({amount:108,
    rows:{sales:[{id:'sale',code:'1',rate:'8',businessType:'type2',amount:'1080',foodAmount:'108',source:'csv'}]},
    foodMonthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-01',amount:8},
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:100}]});
  assert.equal(estimator.estimate(data).amount,100);
  assert.equal(estimator.estimate(data).method,'direct-food');
  const proxy=estimator.estimate({...data,foodMonthlyGroups:null});
  assert.equal(proxy.amount,10.8);
  assert.equal(proxy.method,'group-proxy');
});

test('前年食品構成を同月へ対応させ、実績ではなく予測として表示',()=>{
  const data=input();
  data.sourceFacts.value.period={start:'2026-01-01',end:'2026-12-31'};
  data.monthlyGroups=data.monthlyGroups.map(row=>({...row,month:row.month.replace('2027','2026')}));
  data.foodMonthlyGroups=data.monthlyGroups;
  const actual=estimator.estimate(data);
  assert.equal(actual.amount,108);
  assert.equal(actual.method,'prior-food');
  assert.match(actual.notes.join(''),/前年同月.*予測/);
});

test('同じ正式期間でも異なるCSV・未確認期間・全月不足・候補競合を使わない',()=>{
  for(const mutate of [
    data=>{data.currentSourceId='different';},
    data=>{data.sourceFacts.value.sourceId='';},
    data=>{data.sourceFacts.value.periodConfirmed=false;},
    data=>{data.sourceFacts.value.fullMonthCoverageConfirmed=false;},
    data=>{data.sourceFacts.status='conflict';}
  ]){
    const data=input();mutate(data);const result=estimator.estimate(data);
    assert.equal(result.method,'uniform');assert.ok(result.reason);
  }
});

test('補正後集計版が異なる場合・日付不明・行修正は局所的に日数へ戻す',()=>{
  for(const data of [input({currentAggregateId:'new',monthlyAggregateId:'old'}),input({dateUnknownCount:1}),
    input({rows:{sales:[{code:'1',rate:'8',businessType:'type2',amount:'2080',foodAmount:'1080',source:'csv-edited'}]}}),
    input({monthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2026-12',amount:1080}]})]){
    const actual=estimator.estimate(data);assert.equal(actual.method,'uniform');assert.ok(actual.reason);
  }
});

test('明示手入力はCSVで置き換えず、対象期間割合を二重適用しない',()=>{
  const actual=estimator.estimate(input({mode:'manual',amount:540}));
  assert.equal(actual.amount,540);assert.equal(actual.method,'manual');
  assert.ok(Math.abs(total(actual.monthly)-540)<1e-9);
  assert.equal(estimator.estimate(input({mode:'manual',amount:0})).amount,0);
  assert.equal(estimator.estimate(input({mode:'manual',amount:''})).amount,null);
});

test('明示0円食品内数は年間純額0円グループの正負へ展開しない',()=>{
  const result=estimator.estimate(input({amount:0,
    rows:{sales:[{code:'1',rate:'8',businessType:'type2',amount:'0',foodAmount:'0',foodAmountSource:'manual',source:'csv'}]},
    monthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:1080},
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-05',amount:-1080}]}));
  assert.equal(result.amount,0);assert.ok(result.monthly.every(item=>item.amount === 0));
});

test('月途中の境界は対象期内日数で月額を按分し、日次実額と称しない',()=>{
  const actual=estimator.estimate(input({policyStart:'2027-04-16'}));
  assert.equal(actual.amount,54); // April 16–30: 15 / 30.
  assert.match(actual.notes.join(''),/月途中.*概算.*日次実額ではありません/);
});

test('同じ対象期の短期CSVはその月の対象期内日数を分母にする',()=>{
  const data=input({amount:108,periodStart:'2027-04-16',periodEnd:'2027-04-30',policyStart:'2027-04-21',
    row:{id:'sale',code:'1',rate:'8',businessType:'type2',amount:'108',foodAmount:'108',source:'csv'},
    monthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:108}]});
  data.sourceFacts.value.period={start:'2027-04-16',end:'2027-04-30'};
  assert.equal(estimator.estimate(data).amount,72); // Ten affected days / fifteen source days.
});

test('年度対応・決算期変更・短期不一致を黙って月順対応しない',()=>{
  for(const sourcePeriod of [{start:'2025-01-01',end:'2025-12-31'},
    {start:'2026-04-01',end:'2027-03-31'},{start:'2026-01-01',end:'2026-06-30'}]){
    const data=input();data.sourceFacts.value.period=sourcePeriod;
    const result=estimator.estimate(data);assert.equal(result.method,'uniform');
    assert.match(result.reason,/対応|月数/);
  }
});

test('閏年2月は29日、前年同月の月次額を月途中15/29で按分',()=>{
  const data=input({periodStart:'2028-01-01',periodEnd:'2028-12-31',policyStart:'2028-02-15',policyEnd:'2028-02-29',amount:290,
    row:{code:'1',rate:'8',businessType:'type2',amount:'290',foodAmount:'290',source:'csv'},
    monthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-02',amount:290}]});
  data.sourceFacts.value.period={start:'2027-01-01',end:'2027-12-31'};
  assert.equal(estimator.estimate(data).amount,150);
});

for(const [start,end,expected] of [
  ['2027-03-31','2027-03-31',0],['2027-04-01','2027-04-01',108],
  ['2029-03-31','2029-03-31',108],['2029-04-01','2029-04-01',0]
]) test(`開始・終了の閉区間境界 ${start}`,()=>{
  const result=estimator.estimate({amount:108,periodStart:start,periodEnd:end});
  assert.equal(result.amount,expected);
});

test('年差引0円でも食品グループの月別正負を直接合計し、構成比分母にしない',()=>{
  const result=estimator.estimate(input({amount:0,
    row:{code:'1',rate:'8',businessType:'type2',amount:'0',foodAmount:'0',foodAmountSource:'auto',source:'csv'},
    monthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:1080},
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-05',amount:-1080}]}));
  assert.equal(result.amount,0);assert.equal(result.method,'group-proxy');
  assert.equal(result.monthly[3].amount,1080);assert.equal(result.monthly[4].amount,-1080);
  const cash=estimator.transactionDeltas({estimates:[result],annualDelta:0});
  assert.equal(cash.ready,true);assert.equal(cash.monthly[3].amount,-70);assert.equal(cash.monthly[4].amount,70);
});

test('部分食品の同じグループ内に正負が混在したら比率を強制しない',()=>{
  const result=estimator.estimate(input({amount:540,
    row:{code:'1',rate:'8',businessType:'type2',amount:'1080',foodAmount:'540',source:'csv'},
    monthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:2160},
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-05',amount:-1080}]}));
  assert.equal(result.method,'uniform');assert.match(result.reason,/正負が混在/);
});

test('旧8％返品はCSV有無や手入力期間額によらず元税率を維持',()=>{
  for(const mode of ['uniform','manual']){
    const result=estimator.estimate(input({amount:-108,mode,sourceFacts:null,
      row:{code:'11',rate:'8',businessType:'type2',amount:'108',foodAmount:'108',source:'csv'}}));
    assert.equal(result.amount,0);assert.equal(result.method,'original-rate-return');
  }
});

test('用途・控除割合の異なる仕入を混ぜず、単行callbackでも同じ対象期間額',()=>{
  const row={id:'buy',code:'52',rate:'8',creditRatio:'80',amount:'1080',foodAmount:'1080',source:'csv'};
  const data=input({kind:'purchases',businessType:undefined,row,amount:1080,
    monthlyGroups:[{kind:'purchases',code:'52',rate:'8',creditRatio:'80',month:'2027-01',amount:972},
      {kind:'purchases',code:'52',rate:'8',creditRatio:'80',month:'2027-04',amount:108},
      {kind:'purchases',code:'52',rate:'8',creditRatio:'50',month:'2027-04',amount:4000}]});
  assert.equal(estimator.estimate(data).amount,108);
  assert.equal(estimator.estimate({...data,row:undefined,rows:{purchases:[row]},rowId:'buy'}).amount,108);
});

test('対象期とCSVの期間以外の税率1％実績は推計に加算しない',()=>{
  const data=input();data.monthlyGroups.push({kind:'sales',code:'1',rate:'1',businessType:'type2',month:'2027-04',amount:1010});
  assert.equal(estimator.estimate(data).amount,108);
});

test('同じ対象期間額をSTEP4へ再利用し、二重割合を掛けず円単位で照合',()=>{
  const result=estimator.estimate(input());
  const cash=estimator.transactionDeltas({estimates:[result],annualDelta:-7});
  assert.equal(cash.ready,true);assert.equal(total(cash.monthly),-7);
  assert.equal(cash.monthly[3].amount,-7);
  assert.equal(estimator.transactionDeltas({estimates:[result],annualDelta:-70}).ready,false);
  assert.equal(estimator.transactionDeltas({estimates:[result],priceBasis:'grossFixed',annualDelta:0}).ready,true);
  assert.equal(estimator.transactionDeltas({estimates:[result],annualDelta:null}).ready,false);
});

test('食品明細がグループ月額の内数でなければ直接実額と称しない',()=>{
  const result=estimator.estimate(input({foodMonthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:1080}]}));
  assert.equal(result.method,'uniform');assert.match(result.reason,/内数/);
});


test('別分類の不明日付では確認できる食品月別構成まで解除しない',()=>{
  const data=input({dateUnknownCount:1});data.monthlyGroups.push({kind:'purchases',code:'5',rate:'10',usage:'taxableOnly',month:'',amount:1100});
  const result=estimator.estimate(data);assert.equal(result.method,'group-proxy');assert.equal(result.amount,108);
  data.monthlyGroups.push({kind:'sales',code:'1',rate:'8',businessType:'type2',month:'',amount:108});
  const affected=estimator.estimate(data);assert.equal(affected.method,'uniform');assert.match(affected.reason,/不明/);
});
