const test = require('node:test');
const assert = require('node:assert/strict');
const cashflow = require('../cashflow-engine.js');

function input(override = {}){
  return {
    periodStart:'2029-01', periodEnd:'2029-12', periodEndDate:'2029-12-31',
    salesDeltas:[], purchaseDeltas:[], annualTax:{base:300000, changed:100000},
    interim:{status:'none'}, settlementMonth:'2030-02', refundMonth:'2029-03',
    ...override
  };
}

test('R33-05 共通月: 納付のみなら保持した古い還付月で停止しない', () => {
  const result = cashflow.calculate(input());
  assert.equal(result.status,'complete');
  assert.equal(result.finalCumulative,200000);
  assert.equal(result.settlementMonths.base.refundMonth,'2029-03');
  assert.equal(result.rows.some(row => row.month === '2029-03'),true);
  assert.equal(result.rows.find(row => row.month === '2029-03').refund,0);
});

test('R33-05 案別月も不要月を無視し、明示空欄は旧共通月へ戻さない', () => {
  const plans = {base:{paymentMonth:'2030-02',refundMonth:'2029-03'},
    changed:{paymentMonth:'2030-02',refundMonth:''}};
  const result = cashflow.calculate(input({settlementByPlan:plans}));
  assert.equal(result.status,'complete');
  assert.equal(result.finalCumulative,200000);
  assert.equal(result.settlementMonths.changed.refundMonth,'');
  const reversed = cashflow.calculate(input({annualTax:{base:300000,changed:-100000},settlementByPlan:plans}));
  assert.equal(reversed.status,'partial');
  assert.match(reversed.reasons.join(' '),/変更案の還付入金予定月が未設定/);
});

test('R33-05 共通月: 還付だけなら古い納付月を無視し、反転時は再検証する', () => {
  const original = input({annualTax:{base:-300000,changed:-100000},settlementMonth:'2029-03',refundMonth:'2030-03'});
  assert.equal(cashflow.calculate(original).status,'complete');
  assert.throws(() => cashflow.calculate({...original,annualTax:{base:300000,changed:-100000}}),/納付予定月は対象期の終了月以降/);
});

test('R33-05 共通月: 片方が納付・片方が還付なら両月を必要とする', () => {
  const mixed = input({annualTax:{base:300000,changed:-100000}});
  assert.throws(() => cashflow.calculate(mixed),/還付予定月は対象期の終了月以降/);
  assert.equal(cashflow.calculate({...mixed,refundMonth:'2030-03'}).finalCumulative,400000);
  const missing = cashflow.calculate({...mixed,refundMonth:''});
  assert.equal(missing.status,'partial');
  assert.match(missing.reasons.join(' '),/還付入金予定月が未設定/);
});

test('R33-05 精算0円では両月不要、税額未算定を0円と推定しない', () => {
  const zero = cashflow.calculate(input({annualTax:{base:0,changed:0},settlementMonth:'2029-03',refundMonth:'2029-03'}));
  assert.equal(zero.status,'complete');
  assert.equal(zero.finalCumulative,0);
  const unknown = cashflow.calculate(input({annualTax:{base:null,changed:0},settlementMonth:'2029-03',refundMonth:'2029-03'}));
  assert.equal(unknown.status,'partial');
  assert.equal(unknown.finalCumulative,null);
  assert.match(unknown.reasons.join(' '),/当期税額が未算定/);
  const interimUnknown = cashflow.calculate(input({interim:{status:'unknown'},settlementMonth:'2029-03',refundMonth:'2029-03'}));
  assert.equal(interimUnknown.status,'partial');
  assert.match(interimUnknown.reasons.join(' '),/中間納付予定が未確認/);
});

test('R33-05 必要月だけは最後の中間納付より前へ動かせない', () => {
  const withInterim = input({annualTax:{base:300000,changed:100000},
    interim:{status:'scheduled',base:[{month:'2030-03',amount:50000}],changed:[{month:'2030-03',amount:50000}]}});
  assert.throws(() => cashflow.calculate(withInterim),/中間納付予定月が精算予定月より後/);
  assert.equal(cashflow.calculate({...withInterim,settlementMonth:'2030-04'}).status,'complete');
});
