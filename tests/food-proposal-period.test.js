'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateFoodProposalPeriod}=require('../tax-engine.js');

for(const [name,start,end,outside] of [
  ['直前まで','2026-04-01','2027-03-31',true],
  ['直後から','2029-04-01','2030-03-31',true],
  ['開始端点だけ','2027-04-01','2027-04-01',false],
  ['終了端点だけ','2029-03-31','2029-03-31',false],
  ['開始端点で終了','2026-04-02','2027-04-01',false],
  ['終了端点で開始','2029-03-31','2030-03-30',false],
  ['両端をまたぐ','2026-01-01','2030-12-31',false],
  ['閏日だけ','2028-02-29','2028-02-29',false]
]) test(`法人1％の閉区間判定: ${name}`,()=>{
  const result=validateFoodProposalPeriod({entity:'corporation',taxScenario:'foodProposal',start,end});
  assert.equal(result.applicable,true);
  assert.equal(result.outside,outside);
  assert.equal(result.valid,!outside);
  assert.equal(result.errors.length,outside?1:0);
});

for(const [start,end] of [
  ['',''],['','2028-12-31'],['2028-01-01',''],
  ['2028-02-30','2028-12-31'],['2028-01-01','2029-02-29'],
  ['invalid','2028-12-31'],['2028-12-31','2028-01-01'],
  ['2029-04-01','2027-03-31']
]) test(`法人1％の日付エラーを期間外と混同しない: ${start}/${end}`,()=>{
  const result=validateFoodProposalPeriod({entity:'corporation',taxScenario:'foodProposal',start,end});
  assert.equal(result.applicable,true);
  assert.equal(result.valid,false);
  assert.equal(result.outside,false);
  assert.ok(result.errors.length>0);
});

for(const [entity,taxScenario] of [['individual','foodProposal'],['corporation','current'],['individual','current']]){
  test(`法人1％以外では期間外の禁止を適用しない: ${entity}/${taxScenario}`,()=>{
    const result=validateFoodProposalPeriod({entity,taxScenario,start:'2026-01-01',end:'2026-12-31'});
    assert.equal(result.applicable,false);assert.equal(result.outside,false);assert.equal(result.valid,true);
  });
}
