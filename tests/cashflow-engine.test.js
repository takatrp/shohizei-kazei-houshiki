const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../cashflow-engine.js');

function caseInput(overrides = {}){
  return {
    periodStart:'2027-01', periodEnd:'2027-12',
    salesDeltas:[{month:'2027-01',amount:-7000000}],
    purchaseDeltas:[{month:'2027-01',amount:-4900000}],
    annualTax:{base:2400000,changed:300000},
    interim:{status:'none'},
    settlementMonth:'2028-02', refundMonth:'2028-04',
    salesLag:0, purchaseLag:0,
    ...overrides
  };
}

test('CF01 食品販売・一般課税: 取引差-210万円、税金精算+210万円、最終0円', () => {
  const months = Array.from({length:12}, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`);
  const sales = C.allocateExact(-7000000, Array(12).fill(1));
  const purchase = C.allocateExact(-4900000, Array(12).fill(1));
  const result = C.calculate(caseInput({
    salesDeltas:months.map((month, index) => ({month,amount:sales[index]})),
    purchaseDeltas:months.map((month, index) => ({month,amount:purchase[index]}))
  }));
  assert.equal(result.status, 'complete');
  assert.equal(result.totals.sales, -7000000);
  assert.equal(result.totals.purchase, 4900000);
  assert.equal(result.periodEndCumulative, -2100000);
  assert.deepEqual(result.maxDrawdown, {amount:2100000,month:'2027-12'});
  assert.equal(result.totals.tax, 2100000);
  assert.equal(result.finalCumulative, 0);
  assert.equal(result.rows.at(-1).month, '2028-02');
  assert.equal(result.rows.at(-1).baseTax.settlement, 2400000);
  assert.equal(result.rows.at(-1).changedTax.settlement, 300000);
});

test('CF02 店内飲食・食材仕入のみ変更: 仕入代金差と税額差は相殺する', () => {
  const result = C.calculate(caseInput({
    salesDeltas:[],purchaseDeltas:[{month:'2027-01',amount:-2100000}],
    annualTax:{base:2600000,changed:4700000}
  }));
  assert.equal(result.totals.sales, 0);
  assert.equal(result.totals.purchase, 2100000);
  assert.equal(result.periodEndCumulative, 2100000);
  assert.equal(result.totals.tax, -2100000);
  assert.equal(result.finalCumulative, 0);
});

test('CF03 簡易課税: 一般課税と同じ0円に合わせ込まない', () => {
  const result = C.calculate(caseInput({annualTax:{base:1600000,changed:200000}}));
  assert.equal(result.periodEndCumulative, -2100000);
  assert.equal(result.totals.tax, 1400000);
  assert.equal(result.finalCumulative, -700000);
});

test('CF04 中間納付超過の還付は当期税額を二重計上しない', () => {
  for(const [tax, refund] of [[100000,200000],[-500000,800000]]){
    const result = C.calculate(caseInput({
      salesDeltas:[],purchaseDeltas:[], annualTax:{base:tax,changed:tax},
      interim:{status:'scheduled',base:[{month:'2027-06',amount:300000}],changed:[{month:'2027-06',amount:300000}]}
    }));
    assert.equal(result.settlement.base, -refund);
    assert.equal(result.settlement.changed, -refund);
    assert.equal(result.rows.find(row => row.month === '2028-04').baseTax.refund, refund);
    assert.equal(result.rows.find(row => row.month === '2028-04').changedTax.refund, refund);
    assert.equal(result.finalCumulative, 0);
  }
});

test('CF05 同じ当期税額でも中間納付時点の資金差を残し、精算後は0', () => {
  const result = C.calculate(caseInput({
    salesDeltas:[],purchaseDeltas:[], annualTax:{base:300000,changed:300000},
    interim:{status:'scheduled',base:[{month:'2027-08',amount:100000}],changed:[{month:'2027-08',amount:250000}]}
  }));
  assert.equal(result.rows.find(row => row.month === '2027-08').cumulative, -150000);
  assert.equal(result.rows.find(row => row.month === '2028-02').settlement, 150000);
  assert.equal(result.finalCumulative, 0);
});

test('CF06-07 税込据置や売上だけ値下げは独立した差額を受け取る', () => {
  const bothFixed = C.calculate(caseInput({salesDeltas:[],purchaseDeltas:[]}));
  assert.equal(bothFixed.totals.sales, 0);
  assert.equal(bothFixed.totals.purchase, 0);
  assert.equal(bothFixed.finalCumulative, 2100000);
  const saleOnly = C.calculate(caseInput({purchaseDeltas:[]}));
  assert.equal(saleOnly.totals.sales, -7000000);
  assert.equal(saleOnly.totals.purchase, 0);
  assert.equal(saleOnly.finalCumulative, -4900000);
});

test('CF14 年末取引の翌々月回収は翌年へ移動し、合計を保つ', () => {
  const result = C.calculate(caseInput({
    salesDeltas:[{month:'2027-12',amount:-1080}],purchaseDeltas:[{month:'2027-12',amount:-700}],
    annualTax:{base:100,changed:100}, salesLag:2, purchaseLag:0
  }));
  assert.equal(result.rows.find(row => row.month === '2028-02').sales, -1080);
  assert.equal(result.rows.find(row => row.month === '2027-12').purchase, 700);
  assert.equal(result.periodEndCumulative, 700);
  assert.equal(result.finalCumulative, -380);
});

test('CF15 還付予定が遅い場合は表示期間を自動延長する', () => {
  const result = C.calculate(caseInput({
    salesDeltas:[],purchaseDeltas:[],annualTax:{base:-100,changed:-200},refundMonth:'2029-03'
  }));
  assert.equal(result.rows.at(-1).month, '2029-03');
  assert.equal(result.rows.at(-1).phase, 'settlement');
  assert.equal(result.finalCumulative, 100);
});

test('CF16 中間納付が未確認なら取引のみ表示し、税額・最大減少・精算後は未算定', () => {
  const result = C.calculate(caseInput({interim:{status:'unknown'}}));
  assert.equal(result.status, 'partial');
  assert.equal(result.taxStatus, 'not-included');
  assert.equal(result.rows.find(row => row.month === '2027-01').cumulative, -2100000);
  assert.equal(result.rows.find(row => row.month === '2027-01').interim, null);
  assert.equal(result.maxDrawdown, null);
  assert.equal(result.finalCumulative, null);
  assert.equal(result.totals.tax, null);
  assert.match(result.reasons.join(''), /未確認/);
});

test('CF16 必要な納付・還付予定月の未入力も部分試算にする', () => {
  const missingPayment = C.calculate(caseInput({settlementMonth:null}));
  assert.equal(missingPayment.status, 'partial');
  assert.equal(missingPayment.finalCumulative, null);
  const missingRefund = C.calculate(caseInput({annualTax:{base:-1,changed:-2},refundMonth:null}));
  assert.equal(missingRefund.status, 'partial');
  assert.equal(missingRefund.finalCumulative, null);
});

test('CF26 最大減少は0起点の最小月末累積でありピークからの下落幅ではない', () => {
  const result = C.calculate(caseInput({
    salesDeltas:[{month:'2027-01',amount:100},{month:'2027-02',amount:-90},{month:'2027-03',amount:-20}],
    purchaseDeltas:[],annualTax:{base:0,changed:0}
  }));
  assert.deepEqual(result.maxDrawdown, {amount:10,month:'2027-03'});
  assert.equal(result.finalCumulative, -10);
});

test('CF27 日数按分は閏日を含み、円の端数を厳密に配り切る', () => {
  assert.deepEqual(C.monthDayWeights('2028-02-28','2028-03-02'), [
    {month:'2028-02',days:2},{month:'2028-03',days:2}
  ]);
  assert.deepEqual(C.allocateExact(101,[1,1,1]), [34,34,33]);
  assert.deepEqual(C.allocateExact(-101,[1,1,1]), [-34,-34,-33]);
  assert.deepEqual(C.allocateExact(0,[0,0]), [0,0]);
  assert.throws(() => C.allocateExact(1,[0,0]), /合計が0/);
});

test('CF27 負数の取引月、0円、年跨ぎ月加算、安全整数の検証', () => {
  assert.equal(C.shiftMonth('2027-12',2), '2028-02');
  const result = C.calculate(caseInput({
    salesDeltas:[{month:'2027-01',amount:100},{month:'2027-02',amount:-100}],
    purchaseDeltas:[],annualTax:{base:0,changed:0}
  }));
  assert.equal(result.rows.find(row => row.month === '2027-02').sales, -100);
  assert.equal(result.finalCumulative, 0);
  assert.throws(() => C.calculate(caseInput({annualTax:{base:NaN,changed:0}})), /安全な整数円/);
  assert.throws(() => C.calculate(caseInput({salesDeltas:[{month:'2027-01',amount:Infinity}]})), /安全な整数円/);
  assert.throws(() => C.calculate(caseInput({salesDeltas:[{month:'2027-01',amount:Number.MAX_SAFE_INTEGER}],purchaseDeltas:[{month:'2027-01',amount:-1}]})), /範囲/);
  assert.throws(() => C.calculate(caseInput({purchaseDeltas:[{month:'2026-12',amount:-1}]})), /対象期外/);
  assert.throws(() => C.calculate(caseInput({
    interim:{status:'scheduled',base:[{month:'2028-03',amount:100}],changed:[{month:'2028-03',amount:100}]}
  })), /精算予定月より後/);
});

test('税金予定入力中でも両案の予定が空欄なら0円扱いしない', () => {
  const result = C.calculate(caseInput({interim:{status:'scheduled',base:[],changed:[]}}));
  assert.equal(result.status, 'partial');
  assert.equal(result.finalCumulative, null);
  assert.match(result.reasons.join(''), /未入力/);
});

test('両案で還付・納付が異なる月でも税金イベントが年間税額と整合する', () => {
  const result = C.calculate(caseInput({
    salesDeltas:[],purchaseDeltas:[],annualTax:{base:200,changed:-300},
    settlementMonth:'2028-02',refundMonth:'2028-04'
  }));
  assert.equal(result.rows.find(row => row.month === '2028-02').baseTax.settlement, 200);
  assert.equal(result.rows.find(row => row.month === '2028-04').changedTax.refund, 300);
  assert.equal(result.finalCumulative, 500);
});
