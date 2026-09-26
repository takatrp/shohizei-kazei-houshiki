const test = require('node:test');
const assert = require('node:assert/strict');
const { assessElectionDeadline: assess, RULE } = require('../election-deadline.js');
const { assessCurrentMethodChoice, optimizeFourPeriodRoutes } = require('../tax-engine.js');
const { migrateSavedState } = require('../switch-decision.js');

const septemberCompany = {
  previousMethod:'special2',
  previousPeriod:{start:'2024-10-01',end:'2025-09-30'},
  targetPeriod:{start:'2025-10-01',end:'2026-09-30'},
  entityType:'corporation',consumptionTaxExtension:'none',
  filingStatus:'unknown',asOfDate:'2026-09-25'
};
const marchCompany = {
  previousMethod:'special2',
  previousPeriod:{start:'2025-04-01',end:'2026-03-31'},
  targetPeriod:{start:'2026-04-01',end:'2027-03-31'},
  entityType:'corporation',consumptionTaxExtension:'none',
  filingStatus:'unknown',asOfDate:'2026-09-25'
};
const individual = {
  previousMethod:'special2',
  previousPeriod:{start:'2025-01-01',end:'2025-12-31'},
  targetPeriod:{start:'2026-01-01',end:'2026-12-31'},
  entityType:'individual',filingStatus:'unknown',asOfDate:'2026-09-25'
};

test('D01 対象期末9/29・9/30・10/1の境界は期末で分岐する', () => {
  for(const end of ['2026-09-29','2026-09-30']){
    const value = assess({...septemberCompany,targetPeriod:{...septemberCompany.targetPeriod,end}});
    assert.equal(value.rule,RULE.WITHIN);
    assert.equal(value.rawDeadline,end);
    assert.equal(value.effectiveDeadline,end);
    assert.equal(value.deadlineQuality,'confirmed');
  }
  const after = assess({...septemberCompany,targetPeriod:{...septemberCompany.targetPeriod,end:'2026-10-01'}});
  assert.equal(after.rule,RULE.RETURN);
  assert.equal(after.rawDeadline,'2026-12-01');
});

test('D02 9月期の9/30提出は期限内、10/1提出は期限後', () => {
  const inTime = assess({...septemberCompany,filingStatus:'filed',filingDate:'2026-09-30'});
  const late = assess({...septemberCompany,filingStatus:'filed',filingDate:'2026-10-01'});
  assert.equal(inTime.filingAssessment,'eligible');
  assert.equal(late.filingAssessment,'ineligible');
});

test('D03 法人3月期は消費税延長なし5/31、確認済み延長あり6/30、未確認なら期限未確定', () => {
  const normal = assess(marchCompany);
  const extended = assess({...marchCompany,consumptionTaxExtension:'confirmed'});
  const unknown = assess({...marchCompany,consumptionTaxExtension:'unknown'});
  assert.equal(normal.rawDeadline,'2027-05-31');
  assert.equal(normal.effectiveDeadline,'2027-05-31');
  assert.equal(extended.rawDeadline,'2027-06-30');
  assert.equal(extended.effectiveDeadline,'2027-06-30');
  assert.equal(unknown.effectiveDeadline,null);
  assert.equal(unknown.deadlineQuality,'requiresConfirmation');
  assert.equal(unknown.filingAssessment,'unknown');
  const conflicting = assess({...marchCompany,consumptionTaxExtension:'confirmed',
    confirmedReturnDeadline:'2027-05-31'});
  assert.equal(conflicting.deadlineQuality,'requiresConfirmation');
  assert.equal(conflicting.effectiveDeadline,null);
});

test('D04 個人2026年分は2027年3月31日であり法人2か月期限ではない', () => {
  const value = assess(individual);
  assert.equal(value.rule,RULE.RETURN);
  assert.equal(value.rawDeadline,'2027-03-31');
  assert.equal(value.effectiveDeadline,'2027-03-31');
});

test('D05 前期方式・対象期間が未確認なら特則を推定しない', () => {
  const noMethod = assess({...septemberCompany,previousMethod:'unknown'});
  const noPeriod = assess({...septemberCompany,targetPeriod:null});
  const noPrevious = assess({...septemberCompany,previousPeriod:null});
  for(const value of [noMethod,noPeriod,noPrevious]){
    assert.equal(value.effectiveDeadline,null);
    assert.equal(value.filingAssessment,'unknown');
  }
});

test('D06 過去の対象期でも期限内提出済みの事実は有効', () => {
  const value = assess({...septemberCompany,asOfDate:'2027-01-01',filingStatus:'filed',filingDate:'2026-09-30'});
  assert.equal(value.filingAssessment,'eligible');
});

test('D07 期限後の未提出・今後提出計画は条件付き経路にしない', () => {
  const expired = assess({...septemberCompany,asOfDate:'2026-10-01',filingStatus:'planned'});
  const latePlan = assess({...septemberCompany,filingStatus:'planned',filingDate:'2026-10-01'});
  const timelyPlan = assess({...septemberCompany,filingStatus:'planned',filingDate:'2026-09-30'});
  assert.equal(expired.filingAssessment,'ineligible');
  assert.equal(latePlan.filingAssessment,'ineligible');
  assert.equal(timelyPlan.filingAssessment,'conditional');
});

test('D08 既存有効届出は新規届出期限が過ぎても失効しない', () => {
  const value = assess({...septemberCompany,asOfDate:'2027-01-01',filingStatus:'existingValid'});
  assert.equal(value.filingAssessment,'eligible');
});

test('D10 3割特例は個人の令和9・10年に含まれる前期だけ', () => {
  const valid = assess({
    ...individual,previousMethod:'special3',
    previousPeriod:{start:'2027-01-01',end:'2027-12-31'},
    targetPeriod:{start:'2028-01-01',end:'2028-12-31'}
  });
  assert.equal(valid.rule,RULE.RETURN);
  const old = assess({...septemberCompany,previousMethod:'special3'});
  assert.equal(old.effectiveDeadline,null);
  assert.equal(old.deadlineQuality,'requiresConfirmation');
});

test('D12 期中の土日末日は繰延べず、確定申告期限の将来暦未確認は期限を推測しない', () => {
  const weekend = assess({...septemberCompany,targetPeriod:{...septemberCompany.targetPeriod,end:'2026-09-27'}});
  assert.equal(weekend.effectiveDeadline,'2026-09-27');
  const futureInput = {...individual,targetPeriod:{start:'2028-01-01',end:'2028-12-31'},previousPeriod:{start:'2027-01-01',end:'2027-12-31'},previousMethod:'special3'};
  const future = assess(futureInput);
  assert.equal(future.deadlineQuality,'requiresConfirmation');
  assert.equal(future.effectiveDeadline,null);
  const confirmed = assess({...futureInput,confirmedReturnDeadline:'2029-04-02'});
  assert.equal(confirmed.deadlineQuality,'confirmed');
  assert.equal(confirmed.rawDeadline,'2029-03-31');
  assert.equal(confirmed.effectiveDeadline,'2029-04-02');
});

test('D09 当期の簡易課税選択は曖昧な旧yesで期限後提出を通さない', () => {
  const current = assessCurrentMethodChoice({
    initialElectionStatus:'none',methodKey:'simplified',noticeReady:'yes',
    electionDeadlineInput:{...septemberCompany,filingStatus:'filed',filingDate:'2026-10-01'}
  });
  assert.equal(current.eligibility,'ineligible');
  assert.match(current.reasons.join(''),/期限後/);
});

test('D09 4期の先行届出計画は対象期で検証し、計画の条件付き状態を後続へ保持する', () => {
  const periods = [
    {start:'2025-04-01',end:'2026-03-31',label:'1期',
      methods:[{key:'regular',amount:100,eligible:true},{key:'special2',amount:1,eligible:true}],
      futureElectionReady:'yes',
      futureElectionDetails:{entityType:'corporation',consumptionTaxExtension:'none',
        filingStatus:'planned',asOfDate:'2026-09-25'}},
    {start:'2026-04-01',end:'2027-03-31',label:'2期',
      methods:[{key:'regular',amount:100,eligible:true},{key:'special2',amount:1,eligible:true}]},
    {start:'2027-04-01',end:'2028-03-31',label:'3期',
      methods:[{key:'regular',amount:100,eligible:true},{key:'simplified',amount:1,eligible:true}]},
    {start:'2028-04-01',end:'2029-03-31',label:'4期',
      methods:[{key:'regular',amount:100,eligible:true},{key:'simplified',amount:1,eligible:true}]}
  ];
  const route = optimizeFourPeriodRoutes({initialElectionStatus:'none',noticeReady:'no',periods});
  assert.equal(route.ok,true);
  assert.deepEqual(route.bestRoute.map(row => row.method),['special2','special2','simplified','simplified']);
  assert.match(route.bestRoute[0].action,/2027-05-31/);
  assert.match(route.bestRoute[1].action,/条件付き/);
  assert.match(route.bestRoute[2].action,/条件付き/);

  periods[0].futureElectionDetails.asOfDate = '2027-06-01';
  const expired = optimizeFourPeriodRoutes({initialElectionStatus:'none',noticeReady:'no',periods});
  assert.equal(expired.ok,true);
  assert.notEqual(expired.bestRoute[2].method,'simplified');
});

test('D11 現在期の提出済み入力を次期の別の新規届出として流用しない', () => {
  const periods = Array.from({length:4},(_,index) => {
    const year = 2026 + index;
    return {
      start:`${year}-01-01`,end:`${year}-12-31`,label:`${year}年`,
      methods:index === 0 ? [{key:'regular',amount:10,eligible:true}]
        : [{key:'regular',amount:10,eligible:true},{key:'simplified',amount:1,eligible:true}],
      electionDeadlineInput:{...individual,filingStatus:'filed',filingDate:'2026-09-30',
        targetPeriod:{start:`${year}-01-01`,end:`${year}-12-31`}}
    };
  });
  const result = optimizeFourPeriodRoutes({initialElectionStatus:'none',noticeReady:'no',periods});
  assert.equal(result.ok,true);
  assert.deepEqual(result.bestRoute.map(row => row.method),['regular','regular','regular','regular']);
});

test('D11 旧保存の包括的な期限内提出yesは新期限の確認済みへ移行しない', () => {
  const old = migrateSavedState({schemaVersion:18,simpleElectionStatus:'none',
    simpleNoticeReadyState:'yes',futureElectionPlan:'yes'});
  assert.equal(old.simpleNoticeReadyState,'unknown');
  assert.equal(old.futureElectionPlan,'unknown');
  assert.equal(old.electionFilingStatus,'unknown');
  assert.match(old.migrationNotice,/届出状況と対象期を再確認/);
  const current = migrateSavedState({schemaVersion:19,simpleElectionStatus:'none',
    simpleNoticeReadyState:'yes',futureElectionPlan:'yes',electionFilingStatus:'filed'});
  assert.equal(current.simpleNoticeReadyState,'yes');
  assert.equal(current.futureElectionPlan,'yes');
  assert.equal(current.electionFilingStatus,'filed');
});
