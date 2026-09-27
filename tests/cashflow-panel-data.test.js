const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../cashflow-engine.js');
const {buildPanelData} = require('../cashflow-panel-data.js');

const months = (year, first, count) => Array.from({length:count},(_,index) => {
  const number = year * 12 + first - 1 + index;
  return `${Math.floor(number / 12)}-${String(number % 12 + 1).padStart(2,'0')}`;
});

function sample(){
  const interim = {status:'auto',base:[{month:'2027-11',amount:700000}],changed:[{month:'2027-11',amount:700000}]};
  const adapter = {annualTax:{base:1440000,changed:-720000}};
  const actual = engine.calculate({periodStart:'2027-04',periodEnd:'2028-03',
    salesDeltas:months(2027,4,12).map(month => ({month,amount:-180000})),purchaseDeltas:[],salesLag:1,
    annualTax:{base:1440000,changed:-720000},interim,
    settlementMonth:'2028-05',refundMonth:'2028-07'});
  const baselineFlows = months(2027,5,12).map(month => ({month,amount:120000}));
  return {engine:actual,adapter,interim,baselineFlows,mode:'rateImpact',
    labels:{A:'A案（食品8％維持）',B:'B案（食品1％）'},priceBasis:'taxExclusiveFixed'};
}

test('基本サンプル: A/B月次、納付・還付、2028年4月の最大216万円差が既存差額と一致',()=>{
  const input=sample();
  const before=JSON.stringify(input.engine);
  const panel=buildPanelData(input);
  assert.equal(panel.status.renderable,true);
  assert.equal(panel.status.integrity,'ok');
  assert.equal(panel.unitLabel,'千円');
  assert.equal(panel.months.length,16);
  assert.equal(panel.months[0],'2027-04');
  assert.equal(panel.months.at(-1),'2028-07');
  const index=panel.months.indexOf('2027-11');
  assert.deepEqual(panel.cases.A.rows[index],{month:'2027-11',flow:120000,
    events:[{kind:'interim',amount:700000}],monthTotal:-580000,cumulative:140000});
  assert.deepEqual(panel.cases.B.rows[index],{month:'2027-11',flow:-60000,
    events:[{kind:'interim',amount:700000}],monthTotal:-760000,cumulative:-1120000});
  const max=panel.expectedDiff.reduce((winner,row) => Math.abs(row.cumulative)>Math.abs(winner.cumulative)?row:winner);
  assert.deepEqual(max,{month:'2028-04',monthTotal:-180000,cumulative:-2160000});
  assert.deepEqual(panel.cases.A.rows[panel.months.indexOf('2028-05')].events,[{kind:'final',amount:740000}]);
  assert.deepEqual(panel.cases.B.rows.at(-1).events,[{kind:'refund',amount:1420000}]);
  assert.equal(panel.cases.A.rows.at(-1).cumulative,0);
  assert.equal(panel.cases.B.rows.at(-1).cumulative,0);
  panel.expectedDiff.forEach((row,index) => assert.equal(row.cumulative,input.engine.rows[index].cumulative));
  assert.equal(JSON.stringify(input.engine),before);
});

test('方式比較は共通取引を0の基準線に相殺し、実営業収支0円と誤記しない',()=>{
  const interim={status:'none'};
  const actual=engine.calculate({periodStart:'2027-01',periodEnd:'2027-01',salesDeltas:[],purchaseDeltas:[],
    annualTax:{base:300000,changed:100000},interim,settlementMonth:'2027-03'});
  const panel=buildPanelData({engine:actual,mode:'methodImpact',interim,
    adapter:{annualTax:{base:300000,changed:100000}}});
  assert.equal(panel.status.renderable,true);
  assert.equal(panel.cases.A.rows[0].flow,0);
  assert.equal(panel.cases.B.rows[0].flow,0);
  assert.match(panel.status.sourceNote,/実際の営業収支0円を意味しません/);
  assert.equal(panel.expectedDiff.at(-1).cumulative,200000);
});

test('現行税率側の税額を日数均等配分し、回収・支払月ずれを別々に反映',()=>{
  const interim={status:'none'};
  const actual=engine.calculate({periodStart:'2027-01',periodEnd:'2027-01',
    salesDeltas:[{month:'2027-01',amount:-1000}],purchaseDeltas:[],salesLag:1,
    annualTax:{base:0,changed:0},interim});
  const panel=buildPanelData({engine:actual,mode:'rateImpact',interim,
    comparison:{current:{sales:{totalTax:12000},purchases:{totalTax:6000}}},
    calc:{ctx:{start:'2027-01-01',end:'2027-01-31',foodSalesPriceBasis:'netFixed',foodPurchasePriceBasis:'grossFixed'}},
    lags:{sales:1,purchases:0}});
  assert.equal(panel.status.renderable,true);
  assert.equal(panel.priceBasis,'mixed');
  assert.equal(panel.cases.A.rows[0].flow,-6000);
  assert.equal(panel.cases.A.rows[1].flow,12000);
  assert.equal(panel.cases.B.rows[1].flow,11000);
  assert.match(panel.status.sourceNote,/参考額/);
  assert.match(panel.status.notes.join(' '),/税込価格据置/);
});

test('中間未確認を0円確定と表示せず、既存取引差額と一致する範囲だけ表示',()=>{
  const interim={status:'unknown'};
  const actual=engine.calculate({periodStart:'2027-01',periodEnd:'2027-01',
    salesDeltas:[{month:'2027-01',amount:-1000}],purchaseDeltas:[],
    annualTax:{base:10000,changed:9000},interim});
  const panel=buildPanelData({engine:actual,mode:'rateImpact',interim,
    baselineFlows:[{month:'2027-01',amount:3000}]});
  assert.equal(panel.status.renderable,true);
  assert.equal(panel.status.interim,'unconfirmed');
  assert.equal(panel.status.taxComplete,false);
  assert.deepEqual(panel.cases.A.rows[0].events,[]);
  assert.deepEqual(panel.cases.B.rows[0].events,[]);
  assert.match(panel.status.notes.join(' '),/中間納付は未確認/);
  assert.equal(panel.expectedDiff[0].cumulative,-1000);
});

test('予定月欠落時も同額の既知中間納付を表示でき、精算予定を0円と見なさない',()=>{
  const interim={status:'scheduled',base:[{month:'2027-02',amount:3000}],changed:[{month:'2027-02',amount:3000}]};
  const actual=engine.calculate({periodStart:'2027-01',periodEnd:'2027-01',
    salesDeltas:[],purchaseDeltas:[],annualTax:{base:10000,changed:9000},interim});
  const panel=buildPanelData({engine:actual,mode:'methodImpact',interim,
    adapter:{annualTax:{base:10000,changed:9000}}});
  assert.equal(actual.status,'partial');
  assert.equal(panel.status.renderable,true);
  assert.equal(panel.status.taxComplete,false);
  assert.equal(panel.status.finalMonthEntered,false);
  assert.deepEqual(panel.cases.A.rows[1].events,[{kind:'interim',amount:3000}]);
  assert.deepEqual(panel.cases.B.rows[1].events,[{kind:'interim',amount:3000}]);
  assert.match(panel.status.notes.join(' '),/確定納付の予定月が未入力/);
});

test('異なる既知中間納付がある部分試算は入力待ちで描画停止し、内部エラーにしない',()=>{
  const interim={status:'scheduled',base:[{month:'2027-02',amount:3000}],changed:[{month:'2027-02',amount:5000}]};
  const actual=engine.calculate({periodStart:'2027-01',periodEnd:'2027-01',
    salesDeltas:[],purchaseDeltas:[],annualTax:{base:10000,changed:9000},interim});
  const panel=buildPanelData({engine:actual,mode:'methodImpact',interim,
    adapter:{annualTax:{base:10000,changed:9000}}});
  assert.equal(panel.status.renderable,false);
  assert.equal(panel.status.integrity,'unavailable');
  assert.match(panel.status.reason,/納付予定月が未設定/);
  assert.doesNotMatch(panel.status.reason,/内部整合エラー/);
});

test('現行税率側の税額や月ずれが不明なら日常増減0円で補完しない',()=>{
  const input=sample();
  delete input.baselineFlows;
  assert.equal(buildPanelData(input).status.renderable,false);
  input.lags={sales:1,purchases:1};
  assert.equal(buildPanelData(input).status.renderable,false);
  input.calc={ctx:{start:'2027-04-01',end:'2028-03-31'}};
  input.comparison={current:{sales:{totalTax:1000},purchases:{totalTax:900}}};
  assert.equal(buildPanelData(input).status.renderable,true);
});

test('既存エンジンの累積値の改変を検知し、A/Bの線を提示しない',()=>{
  const input=sample();
  input.engine.rows[3].cumulative += 2;
  const panel=buildPanelData(input);
  assert.equal(panel.status.renderable,false);
  assert.equal(panel.status.integrity,'mismatch');
  assert.match(panel.status.reason,/2027-07/);
});

test('部分試算の必要月はQの符号だけで判定し、不要な納付・還付警告を出さない',()=>{
  const make=(base,changed,settlementMonth,refundMonth)=>{
    const interim={status:'none'};
    const actual=engine.calculate({periodStart:'2027-01',periodEnd:'2027-01',salesDeltas:[],purchaseDeltas:[],
      annualTax:{base,changed},interim,settlementMonth,refundMonth});
    return buildPanelData({engine:actual,mode:'methodImpact',interim,adapter:{annualTax:{base,changed}}});
  };
  const pay=make(1000,2000,null,null);
  assert.equal(pay.status.finalMonthEntered,false);
  assert.equal(pay.status.refundMonthEntered,true);
  assert.doesNotMatch(pay.status.notes.join(' '),/還付.*未入力/);
  const refund=make(-1000,-2000,null,null);
  assert.equal(refund.status.finalMonthEntered,true);
  assert.equal(refund.status.refundMonthEntered,false);
  assert.doesNotMatch(refund.status.notes.join(' '),/納付.*未入力/);
  const mixed=make(1000,-1000,null,null);
  assert.equal(mixed.status.finalMonthEntered,false);
  assert.equal(mixed.status.refundMonthEntered,false);
  const zero=make(0,0,null,null);
  assert.equal(zero.status.finalMonthEntered,true);
  assert.equal(zero.status.refundMonthEntered,true);
  assert.equal(zero.status.taxComplete,true);
  const oneMissing=make(1000,-1000,'2027-03',null);
  assert.equal(oneMissing.status.integrity,'unavailable');
  assert.match(oneMissing.status.reason,/還付入金予定月が未設定/);
  assert.doesNotMatch(oneMissing.status.reason,/納付予定月が未設定/);
});

test('安全に照合したCSV月別構成だけをA案表示に使い、不能なら日数均等とB−A別前提を注記',()=>{
  const interim={status:'none'};
  const actual=engine.calculate({periodStart:'2027-01',periodEnd:'2027-03',salesDeltas:[],purchaseDeltas:[],
    annualTax:{base:0,changed:0},interim});
  const input={engine:actual,mode:'rateImpact',interim,
    calc:{ctx:{start:'2027-01-01',end:'2027-03-31'}},
    comparison:{current:{sales:{totalTax:12000},purchases:{totalTax:6000}}},
    lags:{sales:0,purchases:0},
    adapter:{distribution:{requested:'csv',bySide:{sales:'csv',purchases:'csv'}},
      source:{sourcePeriodStart:'2025-01-01',sourcePeriodEnd:'2025-03-31',sourcePeriodConfirmed:true,csvMonthlyDateUnknownCount:0}},
    taxEntryRows:{sales:[{code:'1',rate:'8',amount:'600',source:'csv'}],
      purchases:[{code:'5',rate:'8',amount:'300',source:'csv'}]},
    csvMonthlyGroups:[
      ...[100,200,300].map((amount,index)=>({kind:'sales',code:'1',rate:'8',month:`2025-0${index+1}`,amount})),
      ...[100,100,100].map((amount,index)=>({kind:'purchases',code:'5',rate:'8',month:`2025-0${index+1}`,amount}))]
  };
  const csv=buildPanelData(input);
  assert.equal(csv.status.renderable,true);
  assert.deepEqual(csv.cases.A.rows.map(row=>row.flow),[0,2000,4000]);
  assert.match(csv.status.sourceNote,/売上は照合済みCSV月別構成比、仕入は照合済みCSV月別構成比/);
  assert.match(csv.status.notes.join(' '),/B−Aの取引差額：売上はCSV月別構成比/);
  const fallback=buildPanelData({...input,taxEntryRows:{...input.taxEntryRows,
    sales:[...input.taxEntryRows.sales,{code:'1',rate:'10',amount:'1',source:'manual'}]}});
  assert.equal(fallback.status.renderable,true);
  assert.match(fallback.status.sourceNote,/売上は対象日数均等、仕入は照合済みCSV月別構成比/);
  assert.notDeepEqual(fallback.cases.A.rows.map(row=>row.flow),csv.cases.A.rows.map(row=>row.flow));
});
