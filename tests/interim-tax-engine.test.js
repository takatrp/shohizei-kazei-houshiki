const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../interim-tax-engine.js');

function input(priorNationalTax, extra={}){
  return {priorNationalTax,priorStart:'2025-01-01',priorEnd:'2025-12-31',currentStart:'2026-01-01',currentEnd:'2026-12-31',
    entityType:'individual',periodShortening:'none',corporateExtension:'none',specialCircumstances:'none',...extra};
}

test('国税のみ・厳密な超過で0/1/3/11回を判定する', () => {
  for(const [national,count] of [[-100,0],[0,0],[480000,0],[480100,1],[4000000,1],[4000100,3],[48000000,3],[48000100,11]]){
    const result = I.plan(input(national));
    assert.equal(result.status,'ready',String(national));
    assert.equal(result.count,count,String(national));
    assert.equal(result.installments.length,count);
  }
  assert.equal(I.plan(input(468000)).count,0,'国・地方合計60万円であっても確定国税46.8万円は義務なし');
  assert.equal(I.plan(input(-100)).totals.total,0,'還付の前期からマイナスの中間納付を作らない');
});

test('国税・地方税を別々に100円未満切捨てする固定値', () => {
  for(const [n,p,k,national,local,total] of [
    [1872000,12,6,936000,264000,1200000],
    [12123400,12,3,3030800,854800,3885600],
    [48000100,12,1,4000000,1128200,5128200],
    [480100,12,6,240000,67600,307600],
    [4000100,12,3,1000000,282000,1282000],
    [2400000,6,3,1200000,338400,1538400]
  ]) assert.deepEqual(I.interimAmounts(n,k,p),{national,local,total});
  const six = I.plan(input(2400000,{priorStart:'2025-07-01'}));
  assert.equal(six.status,'ready');
  assert.equal(six.priorMonths,6);
  assert.equal(six.count,3);
  assert.equal(six.installments[0].total,1538400);
});

test('個人2026年の11回と異なる納付日9日を国税庁公表値で固定する', () => {
  const result = I.plan(input(48000100));
  assert.equal(result.status,'ready');
  assert.equal(result.count,11);
  assert.equal(result.distinctDueDateCount,9);
  assert.deepEqual(result.installments.map(row=>row.adjustedDueDate),[
    '2026-06-01','2026-06-01','2026-06-01','2026-06-30','2026-07-31','2026-08-31',
    '2026-09-30','2026-11-02','2026-11-30','2027-01-04','2027-02-01'
  ]);
  assert.equal(result.installments[0].interimStart,'2026-01-01');
  assert.equal(result.installments[10].interimEnd,'2026-11-30');
  assert.equal(result.installments[10].appliesToTaxPeriod,'2026-01-01～2026-12-31');
  assert.equal(result.totals.total,result.installments.reduce((sum,row)=>sum+row.total,0));
});

test('個人2026年の年1回・3回期限', () => {
  assert.deepEqual(I.plan(input(1872000)).installments.map(row=>row.adjustedDueDate),['2026-08-31']);
  assert.deepEqual(I.plan(input(12123400)).installments.map(row=>row.adjustedDueDate),['2026-06-01','2026-08-31','2026-11-30']);
});

test('法人の初回群・消費税延長・4月開始期を分ける', () => {
  const jan = {...input(48000100),entityType:'corporation'};
  assert.deepEqual(I.plan(jan).installments.slice(0,3).map(row=>row.adjustedDueDate),['2026-04-30','2026-04-30','2026-06-01']);
  assert.deepEqual(I.plan({...jan,corporateExtension:'yes'}).installments.slice(0,4).map(row=>row.adjustedDueDate),['2026-06-01','2026-06-01','2026-06-01','2026-06-30']);
  assert.equal(I.plan({...jan,corporateExtension:'unknown'}).status,'unavailable');
  const apr = {priorStart:'2025-04-01',priorEnd:'2026-03-31',currentStart:'2026-04-01',currentEnd:'2027-03-31',entityType:'corporation'};
  assert.deepEqual(I.plan(input(1872000,apr)).installments.map(row=>row.adjustedDueDate),['2026-11-30']);
  assert.deepEqual(I.plan(input(12123400,apr)).installments.map(row=>row.adjustedDueDate),['2026-08-31','2026-11-30','2027-03-01']);
  assert.deepEqual(I.plan(input(48000100,apr)).installments.slice(0,2).map(row=>row.adjustedDueDate),['2026-07-31','2026-07-31']);
});

test('適用範囲を超える入力は0回と表示せず理由付き未算定にする', () => {
  for(const overrides of [
    {priorNationalTax:''},{priorNationalTax:Infinity},{priorNationalTax:'1,2,3'},
    {periodShortening:'unknown'},{specialCircumstances:'priorAmended'},
    {priorStart:'2025-07-15',priorEnd:'2025-12-31'},
    {currentEnd:'2026-06-30'},
    {entityType:'unknown'},
    {priorNationalTax:Number.MAX_SAFE_INTEGER + 1}
  ]){
    const result = I.plan(input(1872000,overrides));
    assert.equal(result.status,'unavailable',JSON.stringify(overrides));
    assert.equal(result.count,null);
    assert.equal(result.installments.length,0);
    assert.ok(result.reasons[0]);
  }
  const shortened = I.plan(input(1872000,{periodShortening:'yes'}));
  assert.equal(shortened.status,'not_applicable');
  assert.equal(shortened.count,0);
  assert.equal(I.plan(input('',{periodShortening:'yes'})).status,'not_applicable','短縮特例は前期国税額の未入力と区別');
});

test('将来年は納付日を生成しても祝日未公表を示す', () => {
  const result = I.plan(input(1872000,{priorStart:'2027-01-01',priorEnd:'2027-12-31',currentStart:'2028-01-01',currentEnd:'2028-12-31'}));
  assert.equal(result.status,'ready');
  assert.equal(result.calendarConfidence,'provisional');
  assert.match(result.warnings.join(' '),/公表後/);
});
