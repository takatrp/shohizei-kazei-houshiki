'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../tax-engine.js');
const R = require('../tax-return-engine.js');

const zeros = () => ({'8':0,'10':0});
function shortReturn(overrides = {}){
  return {
    taxableSalesGross:{'8':0,'10':363000000},salesReturnGross:zeros(),
    nonTaxableSales:10000000,
    invoiceByUse:{taxableOnly:{'8':0,'10':55000000},nonTaxableOnly:{'8':0,'10':11000000},common:{'8':0,'10':44000000}},
    exemptByUse:{taxableOnly:{},nonTaxableOnly:{},common:{}},
    periodStart:'2026-01-01',periodEnd:'2026-06-30',periodMonths:6,
    ...overrides
  };
}

test('[P01-P04] 6か月3.3億円は全額控除不可、個別24,117,500円、12か月対照23,000,000円', () => {
  const input = shortReturn();
  const six = R.calculateCurrentLawReturn(input,'individual');
  assert.equal(six.schedule23.periodMonths,6);
  assert.equal(six.schedule23.annualizedTaxableSales,660000000);
  assert.equal(six.schedule23.fullCreditEligible,false);
  assert.equal(six.schedule23.creditableTotal,6928235);
  assert.equal(six.mainReturn.national,18811700);
  assert.equal(six.mainReturn.local,5305800);
  assert.equal(six.mainReturn.totalBeforeInterim,24117500);
  assert.throws(() => R.calculateCurrentLawReturn(input,'auto'),/全額控除|個別対応/);
  assert.throws(() => R.calculateCurrentLawReturn(input,'full'),/全額控除/);
  const year = R.calculateCurrentLawReturn(shortReturn({periodEnd:'2026-12-31',periodMonths:12}),'auto');
  assert.equal(year.schedule23.fullCreditEligible,true);
  assert.equal(year.mainReturn.totalBeforeInterim,23000000);
});

test('[P05-P07] 5億円・95％境界は当期整数円の積で判定', () => {
  const full = E.assessFullCreditPeriod({periodMonths:6,taxableSales:250000000,nonTaxableSales:0});
  assert.equal(full.fullCreditEligible,true);
  assert.equal(full.annualizedTaxableSales,500000000);
  assert.equal(E.assessFullCreditPeriod({periodMonths:6,taxableSales:250000001,nonTaxableSales:0}).fullCreditEligible,false);
  assert.equal(E.assessFullCreditPeriod({periodMonths:12,taxableSales:95000000,nonTaxableSales:5000000}).fullCreditEligible,true);
  assert.equal(E.assessFullCreditPeriod({periodMonths:12,taxableSales:94999999,nonTaxableSales:5000001}).fullCreditEligible,false);
});

test('[P08-P09] 暦月・端数月・閏年と欠落・矛盾を区別', () => {
  for(const [start,end,months] of [
    ['2026-01-01','2026-01-31',1],['2026-01-15','2026-02-14',1],
    ['2026-01-15','2026-02-15',2],['2024-02-29','2024-03-28',1],
    ['2026-01-15','2027-01-14',12]
  ]) assert.equal(E.periodMonthsForAnnualization(start,end),months,`${start}～${end}`);
  for(const data of [
    {},{periodMonths:0},{periodMonths:-1},{periodMonths:1.5},{periodMonths:Infinity},
    {periodStart:'2026-07-01',periodEnd:'2026-06-30'},
    {periodStart:'2026-01-01',periodEnd:'2026-06-30',periodMonths:12}
  ]){
    const result=E.assessFullCreditPeriod({...data,taxableSales:100000000,nonTaxableSales:0});
    assert.equal(result.valid,false,JSON.stringify(data));
    assert.equal(result.fullCreditEligible,false);
    assert.ok(result.reasons.length);
  }
});

test('[P10] 取引日範囲は正式な12か月の課税期間を縮めない', () => {
  const input=shortReturn({periodEnd:'2026-12-31',periodMonths:12,
    csvDateRange:{start:'2026-01-10',end:'2026-06-10'}});
  const result=R.calculateCurrentLawReturn(input,'auto');
  assert.equal(result.schedule23.periodMonths,12);
  assert.equal(result.schedule23.annualizedTaxableSales,330000000);
  assert.equal(result.mainReturn.totalBeforeInterim,23000000);
});
