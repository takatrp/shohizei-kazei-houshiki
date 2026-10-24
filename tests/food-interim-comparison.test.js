const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../food-interim-comparison.js');
const I = require('../interim-tax-engine.js');

const ordinaryInput = extra => ({priorNationalTax:1092000,priorStart:'2026-04-01',priorEnd:'2027-03-31',
  currentStart:'2027-04-01',currentEnd:'2028-03-31',entityType:'corporation',periodShortening:'none',
  corporateExtension:'none',specialCircumstances:'none',taxScenario:'foodProposal',...extra});
const transaction = (side,amount,originalRate,category,extra={}) => ({side,amount,originalRate,category,
  businessType:'type2',usage:'taxableOnly',creditRatio:1,...extra});
function qaPrior(extra={}){
  return {source:'actual',period:{start:'2026-04-01',end:'2027-03-31'},exactMethod:'regular',
    nonTaxableSales:0,adjustmentNational:0,creditMethod:'full',transactions:[
      transaction('sales',32400000,8,'food'),transaction('sales',22000000,10,'other'),
      transaction('purchases',21600000,8,'food'),transaction('purchases',15400000,10,'other')],...extra};
}
const comparison = extra => F.compare({ordinaryInput:ordinaryInput(),priorActual:qaPrior(),annualTax:{A:1400000,B:700000},...extra});

test('国税庁Q3-8 p21の例示を前期取引から再計算し、中間総額70万円→35万円', () => {
  const result = comparison();
  assert.equal(result.status,'ready');
  assert.equal(result.ordinary.count,1);
  // Example: food sales 30m*1% + other sales 20m*10%
  // minus food purchases 20m*1% + other purchases 14m*10% = 700,000.
  assert.equal(result.recalculationByStage.reduction.total,700000);
  assert.equal(result.recalculationByStage.reduction.national,546000);
  assert.deepEqual(result.special.totals,{national:273000,local:77000,total:350000});
  assert.deepEqual(result.ordinary.totals,{national:546000,local:154000,total:700000});
  assert.equal(result.retainedDuringPeriod,350000);
  assert.equal(result.special.installments[0].interimStart,'2027-04-01');
  assert.equal(result.special.installments[0].interimEnd,'2027-09-30');
  assert.equal(result.special.installments[0].adjustedDueDate,result.ordinary.installments[0].adjustedDueDate);
});

test('前期確定国税の単純な1/8ではない独立値', () => {
  const result = comparison();
  assert.notEqual(result.special.totals.national,result.ordinary.totals.national/8);
  assert.equal(result.special.totals.national,273000);
});

test('比較表示は利用予定に切り替えず、A/B別の明示選択だけを反映する', () => {
  const result = comparison();
  assert.equal(result.selectedPlans.A,result.ordinary);
  assert.equal(result.selectedPlans.B,result.ordinary);
  const selected = comparison({selection:{B:'special'}});
  assert.equal(selected.selectedPlans.A,selected.ordinary);
  assert.equal(selected.selectedPlans.B,selected.special);
  const manual = comparison({selection:{B:'special'},manualPlanned:{B:true}});
  assert.equal(manual.selectedPlans.B,manual.ordinary);
  assert.match(manual.selectionReasons.join(' '),/手入力予定を保持/);
});

test('中間額の低下は年税額を変えず、確定納付・還付と円単位で精算する', () => {
  const result = comparison({annualTax:{A:1400000,B:200000}});
  assert.deepEqual(result.settlements.B.ordinary,{annualTax:200000,interim:700000,finalPayment:0,refund:500000,reconciled:true});
  assert.deepEqual(result.settlements.B.special,{annualTax:200000,interim:350000,finalPayment:0,refund:150000,reconciled:true});
  assert.equal(result.settlements.A.ordinary.finalPayment,700000);
  assert.equal(result.settlements.A.special.finalPayment,1050000);
  assert.match(result.notice,/年税額の減少ではありません/);
});

test('通常の0・1・3・11回と確定国税の閾値を特例再計算後も固定する', () => {
  for(const [national,count] of [[0,0],[480000,0],[480100,1],[4000000,1],[4000100,3],[48000000,3],[48000100,11]]){
    const result = comparison({ordinaryInput:ordinaryInput({priorNationalTax:national})});
    assert.equal(result.ordinary.count,count);
    if(!count){ assert.equal(result.status,'not_applicable'); continue; }
    assert.equal(result.special.count,count);
    assert.equal(result.special.installments.length,count);
    assert.equal(result.special.installments[0].adjustedDueDate,result.ordinary.installments[0].adjustedDueDate);
  }
});

test('個人暦年3回では2027年1月開始分は通常のまま、4月・7月開始だけ特例', () => {
  const result = comparison({ordinaryInput:ordinaryInput({entityType:'individual',priorNationalTax:4000100,
    priorStart:'2026-01-01',priorEnd:'2026-12-31',currentStart:'2027-01-01',currentEnd:'2027-12-31'}),
    priorActual:qaPrior({period:{start:'2026-01-01',end:'2026-12-31'}})});
  assert.equal(result.status,'ready');
  assert.deepEqual(result.special.installments.map(item=>item.specialApplied),[false,true,true]);
  assert.equal(result.special.installments[0].total,result.ordinary.installments[0].total);
  assert.equal(result.special.installments[1].national,136500);
  assert.equal(result.special.installments[1].local,38500);
});

test('開始日3/31・4/1、終了日3/31・4/1と直前期開始の境界', () => {
  assert.equal(F.stageForInstallment({interimStart:'2027-03-31'},'2026-03-31'),null);
  assert.equal(F.stageForInstallment({interimStart:'2027-04-01'},'2027-03-31'),'reduction');
  assert.equal(F.stageForInstallment({interimStart:'2028-04-01'},'2027-04-01'),null);
  assert.equal(F.stageForInstallment({interimStart:'2029-03-31'},'2028-03-31'),null);
  assert.equal(F.stageForInstallment({interimStart:'2029-04-01'},'2029-03-31'),'restoration');
  assert.equal(F.stageForInstallment({interimStart:'2030-04-01'},'2029-04-01'),null);
});

test('終了時は前期食品1％取引を8％として再計算、同額控除を使わない', () => {
  const prior = qaPrior({period:{start:'2028-04-01',end:'2029-03-31'},transactions:[
    transaction('sales',30300000,1,'food'),transaction('sales',22000000,10,'other'),
    transaction('purchases',20200000,1,'food'),transaction('purchases',15400000,10,'other')]});
  const result = comparison({ordinaryInput:ordinaryInput({priorStart:'2028-04-01',priorEnd:'2029-03-31',
    currentStart:'2029-04-01',currentEnd:'2030-03-31',priorNationalTax:546000}),priorActual:prior});
  assert.equal(result.status,'ready');
  assert.equal(result.recalculationByStage.restoration.total,1400000);
  assert.equal(result.special.totals.total,700000);
  assert.equal(result.ordinary.totals.total,350000);
  assert.equal(result.retainedDuringPeriod,-350000,'特例が増額する場合も隠さない');
});

test('前期方式別に食品同額控除・みなし仕入率・2割3割を再計算', () => {
  const transactions = [transaction('sales',32400000,8,'food'),transaction('sales',22000000,10,'other')];
  for(const [exactMethod,total] of [['simplified',400000],['special2',400000],['special3',600000]]){
    const result = F.recalculatePrior(qaPrior({exactMethod,transactions}),'reduction');
    assert.equal(result.status,'ready');
    assert.equal(result.total,total);
  }
  const restored = F.recalculatePrior(qaPrior({exactMethod:'simplified',transactions:[
    transaction('sales',30300000,1,'food'),transaction('sales',22000000,10,'other')]}),'restoration');
  assert.equal(restored.total,880000,'食品240万円とその他200万円の計440万円×20％');
});

test('新聞8％を食品に読み替えない', () => {
  const result = F.recalculatePrior(qaPrior({transactions:[
    transaction('sales',10800000,8,'other'),transaction('purchases',0,10,'other')]}),'reduction');
  assert.equal(result.status,'ready');
  assert.equal(result.total,800000);
});

test('特例再計算が還付・ゼロでも義務回数は通常のまま、各回納付は0円下限', () => {
  for(const purchase of [40400000,80800000]){
    const result = comparison({priorActual:qaPrior({transactions:[
      transaction('sales',21600000,8,'food'),transaction('purchases',purchase,1,'food')]})});
    assert.equal(result.status,'ready');
    assert.equal(result.ordinary.count,1);
    assert.equal(result.special.count,1);
    assert.equal(result.special.totals.total,0);
    assert.ok(result.recalculationByStage.reduction.national<0);
    assert.equal(result.special.installments[0].national,0);
    assert.equal(result.special.installments[0].local,0);
  }
});

test('資料不足・旧方式分類・期間不一致・代理額は特例だけ未算定', () => {
  for(const priorActual of [undefined,qaPrior({source:'step3'}),qaPrior({exactMethod:'regular-or-other'}),
    qaPrior({period:{start:'2025-04-01',end:'2026-03-31'}}),qaPrior({transactions:[]}),
    qaPrior({nonTaxableSales:''}),qaPrior({adjustmentNational:''}),qaPrior({creditMethod:''})]){
    const result = comparison({priorActual});
    assert.equal(result.ordinary.status,'ready');
    assert.equal(result.special.status,'unavailable');
    assert.equal(result.special.totals,null);
    assert.equal(result.selectedPlans.A,result.ordinary);
    assert.ok(result.reasons.length);
  }
});

test('空欄を0円にせず、税込内訳と元税率・用途・控除割合を要求する', () => {
  const invalid = [
    transaction('sales','',8,'food'),transaction('sales',0,undefined,'food'),
    transaction('purchases',0,8,'food',{creditRatio:''}),
    transaction('purchases',1000,10,'other',{usage:''}),
    transaction('sales',1000,10,'food'),transaction('sales',1000,1,'other'),
    transaction('sales',-1000,8,'food'),transaction('sales',1000,8,'food',{transactionKind:'return'})
  ];
  for(const row of invalid){
    const result = F.recalculatePrior(qaPrior({transactions:[row]}),'reduction');
    assert.equal(result.status,'unavailable');
    assert.equal(result.total,null);
  }
});

test('全額控除不可と用途別控除を区別する', () => {
  const prior = qaPrior({nonTaxableSales:60000000,transactions:[
    transaction('sales',10800000,8,'food'),
    transaction('purchases',11000000,10,'other',{usage:'nonTaxableOnly'})]});
  assert.equal(F.recalculatePrior(prior,'reduction').status,'unavailable');
  const individual = F.recalculatePrior({...prior,creditMethod:'individual'},'reduction');
  assert.equal(individual.status,'ready');
  assert.equal(individual.total,100000);
});

test('国税100円・地方100円未満切捨てと実際の通常納期限を共有', () => {
  const result = comparison({ordinaryInput:ordinaryInput({priorNationalTax:48000100}),priorActual:qaPrior({transactions:[
    transaction('sales',10801350,8,'food'),transaction('sales',11000000,10,'other'),
    transaction('purchases',0,10,'other')]})});
  assert.equal(result.status,'ready');
  for(const [index,row] of result.special.installments.entries()){
    assert.equal(row.national%100,0);
    assert.equal(row.local%100,0);
    assert.equal(row.adjustedDueDate,result.ordinary.installments[index].adjustedDueDate);
    assert.equal(row.national,I.interimAmounts(result.recalculationByStage.reduction.national,1,12).national);
  }
});

test('通常計算不能・短期・短縮は元の制限を維持する', () => {
  for(const overrides of [{currentEnd:'2027-06-30'},{periodShortening:'unknown'},{specialCircumstances:'unknown'}]){
    const result = comparison({ordinaryInput:ordinaryInput(overrides)});
    assert.equal(result.ordinary.status,'unavailable');
    assert.equal(result.special.status,'unavailable');
  }
  const shortened = comparison({ordinaryInput:ordinaryInput({periodShortening:'yes'})});
  assert.equal(shortened.ordinary.status,'not_applicable');
});

test('年税額未算定と明示0円を区別して精算する', () => {
  assert.equal(F.settlement(null,{status:'ready',totals:{total:100}}),null);
  assert.equal(F.settlement('',{status:'ready',totals:{total:100}}),null);
  assert.deepEqual(F.settlement(0,{status:'ready',totals:{total:100}}),
    {annualTax:0,interim:100,finalPayment:0,refund:100,reconciled:true});
});

test('全額控除は用途別の小額端数を税率合計で処理し、個別配賦の不一致を黙認しない', () => {
  const prior = qaPrior({transactions:[
    transaction('sales',1100000,10,'other'),
    transaction('purchases',8,10,'other',{usage:'taxableOnly'}),
    transaction('purchases',8,10,'other',{usage:'common'})]});
  const full = F.recalculatePrior(prior,'reduction');
  assert.equal(full.status,'ready');
  assert.equal(full.nationalCredit,1,'16円×7.8/110の国税は総額で1円、各8円から0+0にしない');
  assert.equal(full.national,77900);
  const individual = F.recalculatePrior({...prior,creditMethod:'individual'},'reduction');
  assert.equal(individual.status,'unavailable');
  assert.match(individual.reasons.join(' '),/端数配賦/);
});

const priorReturn=(side,amount,originalRate,category='food',extra={})=>transaction(side,amount,originalRate,category,{
  transactionKind:'return',originalTaxableState:'taxable',...extra});

test('一般課税の旧8％売上返品は元税率で別控除し、食品通常売上1％と相殺計算しない',()=>{
  const prior=qaPrior();prior.transactions.push(priorReturn('sales',1080000,8));
  const result=F.recalculatePrior(prior,'reduction');
  // Existing policy national 546,000 minus original 8% return tax 62,400.
  assert.equal(result.status,'ready');
  assert.equal(result.national,483600);assert.equal(result.local,136400);assert.equal(result.total,620000);
  assert.equal(result.nationalSalesReturnTax,62400);
  assert.equal(result.nationalSales.taxableBaseFood1,30000000,'通常食品の課税標準を返品で減らさない');
  assert.equal(result.transactionSnapshot.at(-1).rate,8);
  const comparison=comparisonWithReturn(prior);
  assert.equal(comparison.special.totals.total,310000);
  assert.equal(comparison.ordinary.count,1);assert.equal(comparison.special.count,1);
});
function comparisonWithReturn(prior){return F.compare({ordinaryInput:ordinaryInput(),priorActual:prior,annualTax:{A:1400000,B:620000},selection:{B:'special'}});}

test('1％返品は1％を保持し、終了時の通常食品8％読み替えとは別に扱う',()=>{
  const prior=qaPrior({period:{start:'2028-04-01',end:'2029-03-31'},transactions:[
    transaction('sales',30300000,1,'food'),transaction('sales',22000000,10,'other'),
    transaction('purchases',20200000,1,'food'),transaction('purchases',15400000,10,'other'),
    priorReturn('sales',1010000,1)]});
  const result=F.recalculatePrior(prior,'restoration');
  assert.equal(result.status,'ready');assert.equal(result.nationalSalesReturnTax,7800);
  assert.equal(result.national,1084200);assert.equal(result.total,1390000);
  assert.equal(result.transactionSnapshot.at(-1).rate,1);
});

test('売上返還額の負額取消と既に署名済みのsidecarを1回だけ反転する',()=>{
  const positive=qaPrior();positive.transactions.push(priorReturn('sales',1080000,8));
  const signed=qaPrior();signed.transactions.push(priorReturn('sales',-1080000,8,'food',{amountDirection:'signed'}));
  assert.equal(F.recalculatePrior(positive,'reduction').total,F.recalculatePrior(signed,'reduction').total);
  const cancellation=qaPrior();cancellation.transactions.push(priorReturn('sales',-1080000,8));
  const result=F.recalculatePrior(cancellation,'reduction');
  assert.equal(result.status,'ready');assert.equal(result.nationalSalesReturnTax,-62400);assert.equal(result.total,780000);
  cancellation.transactions.at(-1).amountDirection='unknown';
  assert.equal(F.recalculatePrior(cancellation,'reduction').status,'unavailable');
});

test('元売上時に免税だった返品は控除しないと明示し、未確認とは区別する',()=>{
  const prior=qaPrior();prior.transactions.push(priorReturn('sales',1080000,8,'food',{originalTaxableState:'exempt'}));
  const result=F.recalculatePrior(prior,'reduction');
  assert.equal(result.status,'ready');assert.equal(result.total,700000);
  assert.equal(result.nationalSalesReturnTax,0);assert.equal(result.transactionSnapshot.at(-1).originalTaxableState,'exempt');
  for(const value of [undefined,'unknown']){
    prior.transactions.at(-1).originalTaxableState=value;
    const missing=F.recalculatePrior(prior,'reduction');assert.equal(missing.status,'unavailable');assert.equal(missing.total,null);
    assert.ok(missing.blockers.some(item=>item.category==='b'));
    const compared=comparisonWithReturn(prior);assert.equal(compared.ordinary.status,'ready');assert.equal(compared.special.status,'unavailable');
  }
});

test('一般課税の仕入返品は元税率で控除を戻し、控除超過分は課税売上税額へ加算する',()=>{
  const prior=qaPrior();prior.transactions.push(priorReturn('purchases',1080000,8));
  const result=F.recalculatePrior(prior,'reduction');assert.equal(result.status,'ready');assert.equal(result.total,780000);
  const over=qaPrior({transactions:[transaction('sales',11000000,10,'other'),
    transaction('purchases',0,10,'other'),priorReturn('purchases',11000000,10,'other')]});
  const exceeded=F.recalculatePrior(over,'reduction');assert.equal(exceeded.status,'ready');
  assert.equal(exceeded.nationalPurchaseCredit,-780000);assert.equal(exceeded.national,1560000);assert.equal(exceeded.total,2000000);
});

test('輸入特例算式と複数事業返品の当作業一次根拠不足(a)、原取引資料不足(b)を分離する',()=>{
  const imported=qaPrior();imported.transactions.push(transaction('purchases',62400,8,'food',{sourceTaxCode:'55',importComponent:'nationalTax'}));
  const a=F.recalculatePrior(imported,'reduction');assert.equal(a.status,'unavailable');assert.ok(a.blockers.some(x=>x.category==='a'));
  const simple=qaPrior({exactMethod:'simplified'});simple.transactions.push(priorReturn('sales',1080000,8,'food',{businessType:'type4'}));
  const simpleResult=F.recalculatePrior(simple,'reduction');assert.equal(simpleResult.status,'unavailable');assert.ok(simpleResult.blockers.some(x=>x.category==='a'));
  const generic=qaPrior();generic.transactions.push(transaction('sales',-1080000,8,'food',{transactionKind:'adjustment'}));
  const b=F.recalculatePrior(generic,'reduction');assert.equal(b.status,'unavailable');assert.ok(b.blockers.some(x=>x.category==='b'));
});


test('既知の単一業種・正のその他基礎では旧8％返品を控除後のみなし率で計算する',()=>{
  for(const [exactMethod,total] of [['simplified',240000],['special2',240000],['special3',360000]]){
    const prior=qaPrior({exactMethod});prior.transactions.push(priorReturn('sales',10800000,8));
    const result=F.recalculatePrior(prior,'reduction');
    assert.equal(result.status,'ready',result.reasons.join(' / '));
    // Other tax: 2m standard output - 800k original 8% return = 1.2m.
    // Food policy output (300k) is an equal deduction; type2/2wari => 20%, 3wari => 30%.
    assert.equal(result.total,total,exactMethod);
    assert.equal(result.calculation.foodSameCredit,234000);
    assert.equal(result.calculation.otherNetNational,936000);
    assert.equal(result.calculation.basis,'national-tax-after-returns');
    assert.equal(result.transactionSnapshot.at(-1).rate,8);
    assert.equal(result.calculation.reference.valid,true);
  }
});

test('単一業種の1％返品は符号付き食品同額控除へ反映し、旧8％返品と区別する',()=>{
  for(const exactMethod of ['simplified','special2','special3'])for(const returnGross of [10100000,40400000]){
    const prior=qaPrior({exactMethod});prior.transactions.push(priorReturn('sales',returnGross,1));
    const result=F.recalculatePrior(prior,'reduction');assert.equal(result.status,'ready',result.reasons.join(' / '));
    assert.equal(result.calculation.foodSameCredit,returnGross===10100000?156000:-78000,'食品国税234000から元1％返還を符号付きで減額');
    assert.equal(result.total,exactMethod==='special3'?600000:400000);
  }
});

test('単一業種の旧8％返品取消・署名済みsidecarは元方向を一度だけ反映する',()=>{
  const prior=qaPrior({exactMethod:'simplified'});prior.transactions.push(priorReturn('sales',-10800000,8));
  const result=F.recalculatePrior(prior,'reduction');assert.equal(result.status,'ready');assert.equal(result.total,560000);
  prior.transactions.at(-1).amount=10800000;prior.transactions.at(-1).amountDirection='signed';
  assert.equal(F.recalculatePrior(prior,'reduction').total,560000);
});

test('終了時の単一業種は同額控除を使わず、元1％返品を引いた通常みなし率へ戻す',()=>{
  const prior=qaPrior({exactMethod:'simplified',period:{start:'2028-04-01',end:'2029-03-31'},transactions:[
    transaction('sales',30300000,1,'food'),transaction('sales',22000000,10,'other'),
    priorReturn('sales',10100000,1)]});
  const result=F.recalculatePrior(prior,'restoration');assert.equal(result.status,'ready',result.reasons.join(' / '));
  // Food 30m*8% + other 20m*10% - original food return 10m*1% = 4.3m; type2 burden 20%.
  assert.equal(result.total,860000);assert.equal(result.calculation.foodSameCredit,0);
});

test('簡易等のその他負基礎のみ局所未算定、元課税不明は案件資料不足を維持する',()=>{
  for(const exactMethod of ['simplified','special2','special3']){
    const prior=qaPrior({exactMethod});prior.transactions.push(priorReturn('sales',32400000,8));
    const result=F.recalculatePrior(prior,'reduction');assert.equal(result.status,'unavailable');
    assert.ok(result.blockers.some(x=>x.category==='a'&&/当作業/.test(x.reason)));
    prior.transactions.at(-1).amount=1080000;prior.transactions.at(-1).originalTaxableState='unknown';
    const unknown=F.recalculatePrior(prior,'reduction');assert.equal(unknown.status,'unavailable');
    assert.ok(unknown.blockers.some(x=>x.category==='b'));
  }
});

test('査読端数例：返品なしと国税0円の1円返品で国税段階の控除・年税額が一致する',()=>{
  for(const [exactMethod,nationalCredit,national,total] of [
    ['simplified',7518,1700,2100],['special2',7518,1700,2100],['special3',6668,2500,3200]
  ]){
    const prior=qaPrior({exactMethod,transactions:[transaction('sales',100001,8,'food'),transaction('sales',119932,10,'other')]});
    const noReturn=F.recalculatePrior(prior,'reduction');assert.equal(noReturn.status,'ready');
    // Food: floor(92,000*0.78%)=717. Other: 109,000*7.8%=8,502.
    // Type2/2wari credit:717+floor(8,502*.8)=7,518; raw national=1,701.
    assert.equal(noReturn.nationalSales.nationalTaxFood1,717);assert.equal(noReturn.nationalSales.nationalTax10,8502);
    assert.equal(noReturn.nationalCredit,nationalCredit);assert.equal(noReturn.national,national);assert.equal(noReturn.total,total);
    prior.transactions.push(priorReturn('sales',1,8));
    const tinyReturn=F.recalculatePrior(prior,'reduction');assert.equal(tinyReturn.nationalSalesReturnTax,0);
    assert.equal(tinyReturn.nationalCredit,nationalCredit);assert.equal(tinyReturn.total,total);
  }
});

test('複数業種通常の国税基礎・事業配賦・途中端数を現行方式の不変条件で照合する',()=>{
  const R=require('../tax-return-engine.js');
  const groups=[['type2',0,1100660],['type4',0,1100660]];
  const tx=groups.flatMap(([businessType,eight,ten])=>[transaction('sales',eight,8,'other',{businessType}),transaction('sales',ten,10,'other',{businessType})]);
  const policy=F.recalculatePrior(qaPrior({exactMethod:'simplified',transactions:tx}),'reduction');
  assert.equal(policy.status,'ready',policy.reasons.join(' / '));
  // Schedule5-3: national basis156078, per-business nationals78046 each;
  // numerator floor(78046*.8)+floor(78046*.6)=109263;
  // floor(156078*109263/156092)=109253.
  assert.equal(policy.nationalSales.total,156078);assert.equal(policy.nationalCredit,109253);
  assert.equal(policy.national,46800);assert.equal(policy.local,13200);assert.equal(policy.total,60000);
  const input={taxableSalesGross:{'8':0,'10':2201320},salesReturnGross:{'8':0,'10':0},
    salesByType:Object.fromEntries(groups.map(([type,eight,ten])=>[type,{gross:{'8':eight,'10':ten},returns:{'8':0,'10':0}}]))};
  const current=R.calculateCurrentLawSalesMethod(input,'simplified',{type2:.8,type4:.6});
  assert.equal(policy.nationalCredit,current.credit);assert.equal(policy.total,current.totalBeforeInterim);
});

test('食品を除いた通常75％判定と税率を通じた同一候補の選択を維持する',()=>{
  const prior=qaPrior({exactMethod:'simplified',transactions:[
    transaction('sales',27000000,8,'food',{businessType:'type2'}),
    transaction('sales',8800000,10,'other',{businessType:'type2'}),
    transaction('sales',2200000,10,'other',{businessType:'type4'})]});
  const result=F.recalculatePrior(prior,'reduction');assert.equal(result.status,'ready');
  // Q3-7: exclude food25m, other type2 8m/(8m+2m)=80% >=75%.
  // Other national780000*.8=624000; annual national156000+local44000=200000.
  assert.equal(result.calculation.selected.kind,'single75');assert.deepEqual(result.calculation.selected.keys,['type2']);
  assert.equal(result.calculation.otherDeemedCredit,624000);assert.equal(result.national,156000);assert.equal(result.total,200000);
});

test('売上基礎の3方式は不使用仕入の輸入・負額・未確認を理由に止めず、一般課税は止める',()=>{
  const unused=[transaction('purchases',62400,8,'food',{sourceTaxCode:'55',importComponent:'nationalTax'}),
    transaction('purchases',-108000,8,'food'),{side:'purchases',amount:'',originalRate:'',category:''}];
  for(const exactMethod of ['simplified','special2','special3'])for(const item of unused){
    const prior=qaPrior({exactMethod,transactions:[transaction('sales',32400000,8,'food'),transaction('sales',22000000,10,'other'),item]});
    const result=F.recalculatePrior(prior,'reduction');assert.equal(result.status,'ready',result.reasons.join(' / '));
    assert.equal(result.total,exactMethod==='special3'?600000:400000);
    assert.equal(result.transactionSnapshot.at(-1).usedForMethod,false);
    const regular=F.recalculatePrior({...prior,exactMethod:'regular'},'reduction');assert.equal(regular.status,'unavailable');
    const invalid=F.recalculatePrior({...prior,transactions:[...prior.transactions,{side:'unknown',amount:100,originalRate:10,category:'other'}]},'reduction');
    assert.equal(invalid.status,'unavailable','不正なsideを無条件に無視しない');
  }
});
