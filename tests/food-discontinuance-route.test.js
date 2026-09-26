'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ELIGIBILITY,
  assessCurrentMethodChoice,
  optimizeFourPeriodRoutes
} = require('../tax-engine.js');

function current(overrides = {}, foodOverrides = {}){
  return assessCurrentMethodChoice({
    initialElectionStatus:'first',
    methodKey:'regular',
    discontinuanceReady:'no',
    foodDiscontinuanceInput:{
      scenario:'foodProposal',
      periodStart:'2027-01-01',periodEnd:'2027-12-31',
      foodSalesState:'yes',simplifiedAppliedState:'yes',
      noOtherRestrictionsState:'yes',
      filingStatus:'planned',filingDate:'2027-09-30',
      ...foodOverrides
    },
    ...overrides
  });
}

test('R33-07: 食品の期中不適用届出予定は初年度・2年目・継続済みで条件付き参考経路になる', () => {
  for(const initialElectionStatus of ['first','second','free']){
    const result = current({initialElectionStatus});
    assert.equal(result.eligibility,ELIGIBILITY.ELIGIBLE,initialElectionStatus);
    assert.equal(result.route,'foodProposal');
    assert.equal(result.conditional,true);
    assert.equal(result.reference,true);
    assert.equal(result.filingExecution,'planned');
    assert.match(result.reasons.join(''),/予定日に提出/);
    assert.match(result.reasons.join(''),/未施行/);
    assert.equal(result.foodDiscontinuance.effectiveFrom,'2027-01-01');
    assert.equal(result.transitions[0].state.previousMethod,'regular');
  }
});

test('R33-07: 提出済みという仮定でも政策試算であり、予定と事実を同一視しない', () => {
  const planned = current();
  const filed = current({}, {filingStatus:'filed'});
  assert.equal(filed.eligibility,ELIGIBILITY.ELIGIBLE);
  assert.equal(filed.route,'foodProposal');
  assert.equal(filed.filingExecution,'filed');
  assert.equal(filed.reference,true);
  assert.match(filed.reasons.join(''),/提出済みとの入力仮定/);
  assert.notEqual(filed.reasons[0],planned.reasons[0]);
});

test('R33-07: 特例の対象外条件は通常の制限を解除しない', () => {
  for(const change of [
    {scenario:'current'},
    {periodStart:'2027-04-01',periodEnd:'2028-03-31',filingDate:'2028-04-01'},
    {periodStart:'2026-04-01',periodEnd:'2027-03-31',filingDate:'2027-03-31'},
    {periodStart:'2028-01-01',periodEnd:'2028-12-31',filingDate:'2028-06-01'},
    {foodSalesState:'no'},
    {simplifiedAppliedState:'no'},
    {noOtherRestrictionsState:'no'},
    {filingStatus:'none'},
    {filingDate:'2028-01-01'}
  ]){
    const result = current({},change);
    assert.equal(result.eligibility,ELIGIBILITY.INELIGIBLE,JSON.stringify(change));
    assert.equal(result.route,'ordinary',JSON.stringify(change));
    assert.deepEqual(result.transitions,[]);
  }
});

test('R33-07: 不明・期首前の予定を確認済みに変えない', () => {
  for(const change of [
    {foodSalesState:'unknown'},
    {simplifiedAppliedState:'unknown'},
    {noOtherRestrictionsState:'unknown'},
    {filingStatus:'unknown'},
    {filingDate:''},
    {filingDate:'2026-12-20'}
  ]){
    const result = current({},change);
    assert.equal(result.eligibility,ELIGIBILITY.UNKNOWN,JSON.stringify(change));
    assert.equal(result.route,'foodProposal-unconfirmed');
    assert.deepEqual(result.transitions,[]);
    assert.equal(result.foodDiscontinuance.effectiveFrom,'');
    assert.ok(result.reasons.length);
  }
});

test('R33-07: 4月1日開始期と対象外の3月31日終了期を区別する', () => {
  const target = current({}, {periodStart:'2027-04-01',periodEnd:'2028-03-31',filingDate:'2027-04-01'});
  assert.equal(target.eligibility,ELIGIBILITY.ELIGIBLE);
  assert.equal(target.route,'foodProposal');
  const before = current({}, {periodStart:'2026-04-01',periodEnd:'2027-03-31',filingDate:'2027-03-31'});
  assert.equal(before.eligibility,ELIGIBILITY.INELIGIBLE);
});

test('R33-07: 通常経路が有効なときは食品特例が対象外でも維持する', () => {
  const result = current({initialElectionStatus:'free',discontinuanceReady:'yes'},
    {scenario:'current',filingStatus:'none'});
  assert.equal(result.eligibility,ELIGIBILITY.ELIGIBLE);
  assert.match(result.transitions[0].action,/課税期間の初日の前日まで/);
  assert.equal(result.route,undefined);
});

test('R33-07: 他方式・届出履歴不明へ例外を漏らさない', () => {
  const simplified = current({methodKey:'simplified'});
  assert.equal(simplified.eligibility,ELIGIBILITY.ELIGIBLE);
  assert.equal(simplified.route,undefined);
  const unknown = current({initialElectionStatus:'unknown'});
  assert.equal(unknown.eligibility,ELIGIBILITY.UNKNOWN);
  assert.equal(unknown.route,undefined);
  const noElection = current({initialElectionStatus:'none'});
  assert.notEqual(noElection.route,'foodProposal');
});

test('R33-07: 食品の当期経路を4期最適化へ自動開放しない', () => {
  const periods = Array.from({length:4},(_,index) => ({
    start:`202${7+index}-01-01`,end:`202${7+index}-12-31`,
    methods:[{key:'regular',amount:100,eligible:true},{key:'simplified',amount:200,eligible:true}],
    discontinuanceReady:'no'
  }));
  const result = optimizeFourPeriodRoutes({initialElectionStatus:'first',periods});
  assert.equal(result.bestRoute[0].method,'simplified');
});
