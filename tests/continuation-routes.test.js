'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../tax-engine.js');
const obligation=require('../tax-obligation.js');

const annual=(y,methods,extra={})=>({start:`${y}-01-01`,end:`${y}-12-31`,label:`${y}年`,methods,...extra});
const methods=(regular=100,simplified=200)=>[{key:'regular',amount:regular,eligible:true},{key:'simplified',amount:simplified,eligible:true}];
function historyFor(y,base,specified){return [
  {start:`${y-2}-01-01`,end:`${y-2}-12-31`,taxableSales:base,source:'forecast'},
  {start:`${y-1}-01-01`,end:`${y-1}-06-30`,taxableSales:specified,source:'forecast'}
];}

test('R36 routes: 未算定null・空欄・非有限額を0円候補へ変換しない',()=>{
  for(const missing of [null,undefined,'','  ',false,[],{},NaN,Infinity]){
    const periods=[2027,2028,2029,2030].map(y=>annual(y,[{key:'regular',amount:missing,eligible:true},{key:'simplified',amount:500,eligible:true}]));
    const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'free',periods});
    assert.equal(result.cumulative,2000,String(missing));
    assert.ok(result.bestRoute.every(row=>row.method==='simplified'));
    assert.equal(result.periodAssessments[0].methods[0].calculationStatus,'unavailable');
    assert.equal(result.periodAssessments[0].methods[0].selectionStatus,'available');
  }
  const zero=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods:[2027,2028,2029,2030].map(y=>annual(y,methods(0,500)))});
  assert.equal(zero.cumulative,0);
});

test('R36 routes: 食品不適用の対象期だけ2年拘束を解除し、届出効力を終了する',()=>{
  const first=annual(2027,methods(-1000,100),{discontinuanceReady:'no',foodDiscontinuanceInput:{
    scenario:'foodProposal',foodSalesState:'yes',noOtherRestrictionsState:'yes',filingStatus:'planned',filingDate:'2027-09-30'
  }});
  const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'first',periods:[first,...[2028,2029,2030].map(y=>annual(y,methods(100,1)))]});
  assert.equal(result.ok,true);
  assert.deepEqual(result.bestRoute.map(row=>row.method),['regular','regular','regular','regular']);
  assert.equal(result.cumulative,-700); // -1000 + 100 + 100 + 100
  assert.equal(result.bestRoute[0].electionActive,false);
  assert.equal(result.selectionStatus,'planned');
  assert.equal(result.policyScenario,true);
  assert.ok(result.bestConfirmedRoute.every(row=>row.method==='simplified'));
  assert.equal(result.confirmedCumulative,103);
  // 2028 is outside the one-time discontinuance waiver despite still being
  // inside the proposed tax-rate period.
  const outside={...first,start:'2028-01-01',end:'2028-12-31'};
  outside.foodDiscontinuanceInput={...first.foodDiscontinuanceInput,filingDate:'2028-09-30'};
  const rejected=engine.optimizeFourPeriodRoutes({initialElectionStatus:'first',periods:[outside,...[2029,2030,2031].map(y=>annual(y,methods(100,1)))]});
  assert.equal(rejected.bestRoute[0].method,'simplified');
});

test('R36 routes: 売上超過では届出効力を残し、不適用後は自動復帰しない',()=>{
  const first=annual(2027,[{key:'regular',amount:100,eligible:true}],{simplifiedUnavailablePreservesElection:true});
  const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'first',periods:[first,...[2028,2029,2030].map(y=>annual(y,methods(100,1)))]});
  assert.equal(result.bestRoute[0].electionActive,true);
  assert.equal(result.bestRoute[1].method,'simplified');
});

test('R36 projection: 原則4期、終了後に始まる期を含むまで最小延長する',()=>{
  const rows=obligation.buildProjectionPeriods({entity:'individual',start:'2025-01-01',end:'2025-12-31',scenario:'foodProposal'});
  assert.equal(rows.length,6);
  assert.equal(rows.at(-1).start,'2030-01-01');
  assert.equal(obligation.buildProjectionPeriods({entity:'corporation',start:'2027-04-01',end:'2028-03-31',scenario:'foodProposal'}).length,4);
  const extended=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods:rows.map(row=>({...row,methods:[{key:'regular',amount:10,eligible:true}]}))});
  assert.equal(extended.cumulative,60);
});

test('R36 reference: 参照期間完全一致だけ使い、前期・現在期を前々期へ流用しない',()=>{
  const p={start:'2029-01-01',end:'2029-12-31'};
  const resolved=obligation.resolveReferenceFacts({entity:'individual',period:p,history:[
    {start:'2028-01-01',end:'2028-12-31',taxableSales:1},
    {start:'2029-01-01',end:'2029-12-31',taxableSales:1}
  ]});
  assert.equal(resolved.baseFact.value,null);
  assert.deepEqual(resolved.base,{start:'2027-01-01',end:'2027-12-31'});
  assert.deepEqual(resolved.specified,{start:'2028-01-01',end:'2028-06-30'});
  assert.equal(obligation.referencePeriods({entity:'corporation',period:{start:'2028-04-01',end:'2028-12-31'}}).base,null);
});

test('R36 exemption: 基準期間1000万円境界と別期の予測変動を反映する',()=>{
  const common={entity:'individual',period:{start:'2029-01-01',end:'2029-12-31'},otherObligation:'no'};
  const at=obligation.assessTaxObligation({...common,history:historyFor(2029,10000000,0)});
  assert.equal(at.obligation,'exempt');
  assert.equal(at.forecast,true);
  assert.equal(obligation.assessTaxObligation({...common,history:historyFor(2029,10000001,0)}).obligation,'taxable');
  assert.equal(obligation.assessTaxObligation({...common,history:historyFor(2028,10000000,0)}).obligation,'unknown');
});

test('R36 exemption: 特定期間売上と給与の代替判定・未確認を区別する',()=>{
  const common={entity:'individual',period:{start:'2029-01-01',end:'2029-12-31'},otherObligation:'no',history:historyFor(2029,10000000,10000001)};
  assert.equal(obligation.assessTaxObligation(common).obligation,'unknown');
  assert.equal(obligation.assessTaxObligation({...common,specifiedPayroll:10000000}).obligation,'exempt');
  assert.equal(obligation.assessTaxObligation({...common,specifiedPayroll:10000001}).obligation,'taxable');
  assert.equal(obligation.assessTaxObligation({...common,specifiedPayroll:0,domesticBusiness:'no'}).obligation,'taxable');
  assert.equal(obligation.assessTaxObligation({...common,history:historyFor(2029,10000000,0),otherObligation:'unknown'}).obligation,'unknown');
});

test('R36 voluntary: 食品の選択届出は期首、登録経由は登録日からの取引を取り込む',()=>{
  const common={entity:'individual',period:{start:'2027-01-01',end:'2027-12-31'},confirmedStatus:'exempt',confirmedStatusPeriod:{start:'2027-01-01',end:'2027-12-31'},scenario:'foodProposal',foodSalesState:'yes',filingStatus:'planned',asOfDate:'2026-10-23',assetRestrictionState:'no'};
  const chosen=obligation.assessVoluntaryRoute({...common,route:'election',filingDate:'2027-09-30'});
  assert.equal(chosen.status,'planned');
  assert.deepEqual(chosen.taxableWindow,{start:'2027-01-01',end:'2027-12-31'});
  assert.equal(chosen.bindingThrough,'2028-12-31');
  assert.equal(chosen.policyScenario,true);
  const registered=obligation.assessVoluntaryRoute({...common,route:'invoice',registrationDate:'2027-04-01',filingDate:'2027-03-17'});
  assert.equal(registered.status,'planned');
  assert.deepEqual(registered.taxableWindow,{start:'2027-04-01',end:'2027-12-31'});
  assert.equal(registered.bindingThrough,'2029-12-31');
  assert.equal(registered.policyScenario,false);
  assert.equal(obligation.assessVoluntaryRoute({...common,route:'invoice',registrationDate:'2027-04-01',filingDate:'2027-03-18'}).status,'unavailable');
});

test('R36 voluntary: 免税を0円方式へ追加せず納税義務を先に判定する',()=>{
  const p={start:'2029-01-01',end:'2029-12-31'};
  const result=obligation.assessVoluntaryRoute({entity:'individual',period:p,route:'maintain',history:historyFor(2029,20000000,0),otherObligation:'no'});
  assert.equal(result.status,'unavailable');
  assert.equal(result.obligation,'taxable');
  assert.equal(result.amount,undefined);
});

test('R36 voluntary: 継続制限・取消・将来期の免税判定を独立に引き継ぐ',()=>{
  const periods=obligation.buildProjectionPeriods({entity:'individual',start:'2027-01-01',end:'2027-12-31',scenario:'foodProposal'});
  const common={entity:'individual',periods,confirmedStatus:'exempt',confirmedStatusPeriod:periods[0],scenario:'foodProposal',foodSalesState:'yes',route:'invoice',registrationDate:'2027-04-01',filingDate:'2027-03-17',filingStatus:'filed',assetRestrictionState:'no',otherObligation:'no',
    history:[...historyFor(2030,5000000,0)],exit:{effectiveFrom:'2030-01-01',filingStatus:'planned',filingDate:'2029-12-17'},asOfDate:'2026-10-23'};
  const result=obligation.buildObligationProjection(common);
  assert.equal(result.periods[2].obligation,'taxable');
  assert.equal(result.periods[2].bindingKind,'invoiceRegistration');
  assert.equal(result.periods[3].obligation,'exempt');
  assert.equal(result.periods[3].status,'planned');
  const blocked=obligation.buildObligationProjection({...common,exit:{...common.exit,effectiveFrom:'2029-01-01',filingDate:'2028-12-17'}});
  assert.equal(blocked.periods[2].obligation,'taxable');
  assert.equal(blocked.periods[2].exitStatus,'unavailable');
  const unknownAssets=obligation.buildObligationProjection({...common,assetRestrictionState:'unknown'});
  assert.equal(unknownAssets.periods[3].obligation,'taxable');
  assert.equal(unknownAssets.periods[3].exitStatus,'unknown');
});

test('R36 voluntary: 現在申告方式の免税を対象期の免税事実へ読み替えない',()=>{
  const p={start:'2027-01-01',end:'2027-12-31'};
  const common={entity:'individual',period:p,route:'election',scenario:'foodProposal',foodSalesState:'yes',filingDate:'2027-09-30',filingStatus:'planned',assetRestrictionState:'no'};
  const unknown=obligation.assessVoluntaryRoute({...common,confirmedStatus:'exempt',confirmedStatusPeriod:{start:'2026-01-01',end:'2026-12-31'}});
  assert.equal(unknown.status,'unknown');
  assert.deepEqual(unknown.taxableWindow,p); // calculation remains possible
  const taxable=obligation.assessVoluntaryRoute({...common,history:historyFor(2027,10000001,0),otherObligation:'no'});
  assert.equal(taxable.status,'unavailable');
  assert.equal(taxable.obligation,'taxable');
});

test('R36 voluntary: 登録申請の提出済みを登録済みに格上げしない',()=>{
  const p={start:'2027-01-01',end:'2027-12-31'};
  const common={entity:'individual',period:p,confirmedStatus:'exempt',confirmedStatusPeriod:p,route:'invoice',registrationDate:'2027-04-01',filingDate:'2027-03-17',filingStatus:'filed',assetRestrictionState:'no'};
  assert.equal(obligation.assessVoluntaryRoute(common).status,'planned');
  assert.equal(obligation.assessVoluntaryRoute({...common,registrationStatus:'registered'}).status,'available');
});

test('R36 exemption: 明示免税状態と判明した売上超過を黙って両立させない',()=>{
  const p={start:'2029-01-01',end:'2029-12-31'};
  const result=obligation.assessTaxObligation({entity:'individual',period:p,confirmedStatus:'exempt',confirmedStatusPeriod:p,
    history:historyFor(2029,10000001,0),otherObligation:'no'});
  assert.equal(result.obligation,'taxable');
});

test('R36 voluntary: 課税選択不適用の提出可能時期と資産の既知制限を守る',()=>{
  const periods=obligation.buildProjectionPeriods({entity:'individual',start:'2027-01-01',end:'2027-12-31',scenario:'foodProposal'});
  const common={entity:'individual',periods,confirmedStatus:'exempt',confirmedStatusPeriod:periods[0],scenario:'foodProposal',foodSalesState:'yes',route:'election',filingDate:'2027-09-30',filingStatus:'filed',assetRestrictionState:'no',otherObligation:'no',
    history:[...historyFor(2029,5000000,0),...historyFor(2030,5000000,0)],asOfDate:'2026-10-23'};
  const tooEarly=obligation.buildObligationProjection({...common,exit:{effectiveFrom:'2029-01-01',filingStatus:'filed',filingDate:'2027-12-31'}});
  assert.equal(tooEarly.periods[2].exitStatus,'unavailable');
  const ready=obligation.buildObligationProjection({...common,exit:{effectiveFrom:'2029-01-01',filingStatus:'filed',filingDate:'2028-01-01'}});
  assert.equal(ready.periods[2].obligation,'exempt');
  assert.equal(ready.periods[3].obligation,'exempt'); // cancellation remains effective
  // Acquisition restrictions begin after the confirmed exempt entry period.
  const assets=obligation.buildObligationProjection({...common,periodFacts:periods.map((p,i)=>({assetRestrictionState:i===0?'no':'yes'})),exit:{effectiveFrom:'2029-01-01',filingStatus:'filed',filingDate:'2028-01-01'}});
  assert.equal(assets.periods[2].obligation,'taxable');
  assert.equal(assets.periods[2].exitStatus,'unavailable');
});

test('R36 routes: 未確認の安値を選択可能経路と呼ばず、他の算定を保つ',()=>{
  const periods=[2027,2028,2029,2030].map(y=>annual(y,[
    {key:'regular',amount:100,eligible:true},
    {key:'simplified',amount:1,eligible:false,eligibility:'unknown',reasons:['基準期間が未確認']}
  ]));
  const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods});
  assert.equal(result.cumulative,400);
  assert.equal(result.periodAssessments[0].methods[1].amount,1);
  assert.equal(result.periodAssessments[0].methods[1].selectionStatus,'unknown');
});

test('R36 routes: 将来の不適用予定を提出済みの経路に格上げしない',()=>{
  const periods=[annual(2027,[{key:'simplified',amount:100,eligible:true}]),
    ...[2028,2029,2030].map(y=>annual(y,[{key:'regular',amount:1,eligible:true}],{discontinuanceReady:'yes'}))];
  const planned=engine.optimizeFourPeriodRoutes({initialElectionStatus:'free',periods});
  assert.equal(planned.selectionStatus,'planned');
  assert.equal(planned.confirmedCumulative,null);
  const filed=engine.optimizeFourPeriodRoutes({initialElectionStatus:'free',periods:periods.map((p,i)=>i===1?{...p,discontinuanceFilingStatus:'filed'}:p)});
  assert.equal(filed.selectionStatus,'available');
  assert.equal(filed.confirmedCumulative,103);
});

test('R36 routes defense: 明示unknown・ineligibleは古いeligible:trueより優先する',()=>{
  for(const [flags,expected] of [
    [{eligibility:'unknown'},'unknown'],
    [{eligibility:'ineligible'},'unavailable'],
    [{selectionStatus:'unknown'},'unknown'],
    [{selectionStatus:'unavailable'},'unavailable'],
    [{eligible:'unknown',eligibility:'eligible'},'unknown'],
    [{eligible:'ineligible',eligibility:'eligible'},'unavailable'],
    [{eligible:false,eligibility:'eligible',selectionStatus:'available'},'unavailable']
  ]){
    const periods=[2027,2028,2029,2030].map(y=>annual(y,[{key:'regular',amount:1,eligible:true,...flags}]));
    const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods});
    assert.equal(result.ok,false,JSON.stringify(flags));
    assert.equal(result.cumulative,null);
    assert.deepEqual(result.bestRoute,[]);
    assert.equal(result.periodAssessments[0].methods[0].selectionStatus,expected);
    assert.equal(result.periodAssessments[0].methods[0].calculationStatus,'calculated');
  }
});

test('R36 routes defense: 数値が残っていても計算状態未算定なら利用しない',()=>{
  for(const status of ['unknown','unavailable']){
    const periods=[2027,2028,2029,2030].map(y=>annual(y,[{key:'regular',amount:0,eligible:'eligible',calculationStatus:status}]));
    const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods});
    assert.equal(result.ok,false);
    assert.equal(result.cumulative,null);
    assert.equal(result.periodAssessments[0].methods[0].selectionStatus,'available');
    assert.equal(result.periodAssessments[0].methods[0].calculationStatus,status);
  }
});

test('R36 routes defense: 肯定bool・enum互換と明示0円を維持する',()=>{
  for(const flags of [{eligible:true},{eligible:'eligible'},{eligibility:'eligible'}]){
    const periods=[2027,2028,2029,2030].map(y=>annual(y,[{key:'regular',amount:0,...flags}]));
    const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods});
    assert.equal(result.ok,true,JSON.stringify(flags));
    assert.equal(result.cumulative,0);
    assert.equal(result.selectionStatus,'available');
    assert.equal(result.bestConfirmedRoute.length,4);
  }
});

test('R36 routes defense: 明示planned候補を提出済み最安経路へ混ぜない',()=>{
  const periods=[2027,2028,2029,2030].map(y=>annual(y,[
    {key:'regular',amount:1,eligible:true,selectionStatus:'planned'},
    {key:'regular',amount:100,eligible:true,selectionStatus:'available'}
  ]));
  const result=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods});
  assert.equal(result.cumulative,4);
  assert.equal(result.selectionStatus,'planned');
  assert.equal(result.confirmedCumulative,400);
  assert.equal(result.bestConfirmedRoute.length,4);
  assert.ok(result.bestConfirmedRoute.every(row=>row.amount===100&&row.selectionStatus==='available'));
});

test('R36 routes defense: 不正候補と累計overflowを0円又は完成値へ補完しない',()=>{
  const malformed=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods:[2027,2028,2029,2030].map(y=>annual(y,[null]))});
  assert.equal(malformed.ok,false);
  assert.equal(malformed.periodAssessments[0].methods[0].selectionStatus,'unknown');
  const overflow=engine.optimizeFourPeriodRoutes({initialElectionStatus:'none',periods:[2027,2028,2029,2030].map(y=>annual(y,[{key:'regular',amount:1e308,eligible:true}]))});
  assert.equal(overflow.ok,false);
  assert.equal(overflow.cumulative,null);
});


test('うるう日開始は年次期間と認識し、過去の不規則な参照期間は実績履歴を要求する',()=>{
  const p=obligation.buildProjectionPeriods({entity:'corporation',start:'2028-02-29',end:'2029-02-28',scenario:'foodProposal'});
  assert.equal(p[0].end,'2029-02-28');assert.equal(p[1].start,'2029-03-01');
  const refs=obligation.referencePeriods({entity:'corporation',period:p[0]});
  assert.equal(refs.base,null);assert.match(refs.reasons.join(''),/うるう日.*履歴/);
  assert.doesNotMatch(refs.reasons.join(''),/短期・決算期変更の法人/);
});

test('既知資産制限と未確認を免税維持の無制限へ変換しない',()=>{
  const input={entity:'individual',period:{start:'2027-01-01',end:'2027-12-31'},route:'maintain',otherObligation:'no',history:[
    {start:'2025-01-01',end:'2025-12-31',taxableSales:0},
    {start:'2026-01-01',end:'2026-06-30',taxableSales:0}]};
  for(const assetRestrictionState of ['yes','unknown']){
    const result=obligation.assessVoluntaryRoute({...input,assetRestrictionState});
    assert.equal(result.status,'unknown');assert.equal(result.obligation,'unknown');
    assert.match(result.reasons.join(' '),/資産/);
  }
  assert.equal(obligation.assessVoluntaryRoute({...input,assetRestrictionState:'no'}).obligation,'exempt');
});
