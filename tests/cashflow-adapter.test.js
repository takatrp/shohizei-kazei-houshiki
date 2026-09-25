const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../cashflow-adapter.js');

function input(overrides = {}){
  const ctx = {start:'2027-04-01',end:'2028-03-31',taxScenario:'foodProposal'};
  const calc = {
    ctx, sales:{totalAmount:101000000}, purchases:{totalAmount:70700000},
    methods:[{key:'regular',eligibility:'eligible'}]
  };
  const comparison = {
    current:{sales:{totalAmount:108000000},purchases:{totalAmount:75600000}},
    rows:[{key:'regular',currentAmount:2400000,proposalAmount:300000,
      currentMethod:{eligibility:'eligible'},proposalMethod:{eligibility:'eligible'},reference:false,reasons:[]}]
  };
  return {ctx,calc,comparison,methodKey:'regular',taxEntryRows:{sales:[],purchases:[]},...overrides};
}

function sum(deltas){ return deltas.reduce((total,item) => total + item.amount,0); }

test('STEP3 の同一税額と税込取引差を年額の正本とし、対象月へ日数配分する', () => {
  const result = adapter.create(input());
  assert.equal(result.ready,true);
  assert.deepEqual(result.annualTax.raw,{base:2400000,changed:300000});
  assert.equal(result.annualTax.base,2400000);
  assert.equal(result.annualTax.changed,300000);
  assert.equal(result.annualSalesDelta,-7000000);
  assert.equal(result.annualPurchaseDelta,-4900000);
  assert.equal(sum(result.salesDeltas),-7000000);
  assert.equal(sum(result.purchaseDeltas),-4900000);
  assert.equal(result.salesDeltas.length,12);
  assert.equal(result.distribution.used,'uniform');
});

test('CF08 明示0円の食品差額は未入力と区別し、全対象月を0円で配分する', () => {
  const data = input();
  data.calc.sales.totalAmount = data.comparison.current.sales.totalAmount;
  data.calc.purchases.totalAmount = data.comparison.current.purchases.totalAmount;
  data.comparison.rows[0].proposalAmount = data.comparison.rows[0].currentAmount;
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.equal(result.annualSalesDelta,0);
  assert.equal(result.annualPurchaseDelta,0);
  assert.equal(result.salesDeltas.length,12);
  assert.ok(result.salesDeltas.every(item => item.amount === 0));
  assert.ok(result.purchaseDeltas.every(item => item.amount === 0));
});

test('CF09 食品1％対象期間と重ならない期の既知0円差は未算定にしない', () => {
  const data = input();
  data.ctx.start = data.calc.ctx.start = '2030-04-01';
  data.ctx.end = data.calc.ctx.end = '2031-03-31';
  data.calc.sales.totalAmount = data.comparison.current.sales.totalAmount;
  data.calc.purchases.totalAmount = data.comparison.current.purchases.totalAmount;
  data.comparison.rows[0].proposalAmount = data.comparison.rows[0].currentAmount;
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.equal(result.annualSalesDelta,0);
  assert.equal(result.annualPurchaseDelta,0);
  assert.ok(result.salesDeltas.every(item => item.amount === 0));
});

test('STEP3 に税額がない場合はゼロにせず、取引差だけ部分試算に渡す', () => {
  const {comparison,...rest} = input();
  comparison.rows[0].currentAmount = null;
  comparison.current = null;
  const result = adapter.create({...rest,comparison});
  assert.equal(result.annualTax.status,'unavailable');
  assert.equal(result.annualTax.base,null);
  assert.equal(result.annualTax.changed,null);
  assert.equal(result.ready,false,'税込取引差の正本もない');
});

test('一方式の税額だけ未算定でも税込取引差が分かれば部分試算を作る', () => {
  const data = input();
  data.comparison.rows[0].currentAmount = null;
  data.comparison.rows[0].reasons = ['現行税率側の税額を確認'];
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.equal(result.annualTax.status,'unavailable');
  assert.equal(result.annualTax.base,null);
  assert.match(result.annualTax.reasons.join(''),/税額を確認/);
  assert.equal(sum(result.salesDeltas),-7000000);
});

test('適用不可を参考税額として通さず、未確認の適用可否は参考理由を保持する', () => {
  const invalid = input();
  invalid.comparison.rows[0].proposalMethod.eligibility = 'ineligible';
  const blocked = adapter.create(invalid);
  assert.equal(blocked.ready,false);
  assert.equal(blocked.annualTax.status,'unavailable');
  assert.match(blocked.reasons.join(''),/適用対象外/);
  const reference = input();
  reference.comparison.rows[0].reference = true;
  reference.comparison.rows[0].reasons = ['届出を確認'];
  const result = adapter.create(reference);
  assert.equal(result.ready,true);
  assert.equal(result.annualTax.status,'reference');
  assert.match(result.assumptions.join(''),/参考値/);
});

test('税込差と税額の小数円は表示円へ一度だけ丸め、原値を保持する', () => {
  const data = input();
  data.calc.sales.totalAmount = 101000000.49;
  data.calc.purchases.totalAmount = 70700000.6;
  data.comparison.rows[0].currentAmount = -100.49;
  data.comparison.rows[0].proposalAmount = -50.5;
  const result = adapter.create(data);
  assert.equal(result.annualSalesDelta,-7000000);
  assert.equal(result.annualPurchaseDelta,-4899999);
  assert.equal(result.annualTax.base,-100);
  assert.equal(result.annualTax.changed,-50);
  assert.equal(result.annualTax.raw.changed,-50.5);
  assert.equal(sum(result.purchaseDeltas),-4899999);
});

test('元資料期間・全月網羅が未確認なら CSV 構成を使わず均等へ明示フォールバック', () => {
  const data = input({distribution:'csv',sourcePeriodStart:'2025-04-01',sourcePeriodEnd:'2026-03-31',
    csvMonthlyGroups:[{kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2025-04',amount:108000000}]});
  const result = adapter.create(data);
  assert.equal(result.distribution.requested,'csv');
  assert.equal(result.distribution.used,'uniform');
  assert.match(result.distribution.notes.join(''),/全月網羅が未確認/);
});

test('CSV 月別構成は対応する売上・仕入グループ別に採用し、元資料月順を対象期へ対応させる', () => {
  const rows = {sales:[{code:'1',rate:'8',businessType:'type2',amount:'108000000',foodAmount:'108000000',source:'csv-edited'}],
    purchases:[{code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'csv-edited'}]};
  const data = input({distribution:'csv',sourcePeriodStart:'2025-04-01',sourcePeriodEnd:'2026-03-31',
    sourcePeriodConfirmed:true,taxEntryRows:rows,
    csvMonthlyGroups:[
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2025-04',amount:86400000},
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2025-05',amount:21600000},
      {kind:'purchases',code:'5',rate:'8',month:'2025-04',amount:18900000},
      {kind:'purchases',code:'5',rate:'8',month:'2025-05',amount:56700000}
    ]});
  const result = adapter.create(data);
  assert.equal(result.ready,true);
  assert.equal(result.distribution.used,'csv');
  assert.equal(result.salesDeltas[0].month,'2027-04');
  assert.equal(result.salesDeltas[0].amount,-5600000);
  assert.equal(result.salesDeltas[1].amount,-1400000);
  assert.equal(result.purchaseDeltas[0].amount,-1225000);
  assert.equal(result.purchaseDeltas[1].amount,-3675000);
  assert.equal(sum(result.salesDeltas),result.annualSalesDelta);
  assert.equal(sum(result.purchaseDeltas),result.annualPurchaseDelta);
  assert.match(result.distribution.notes.join(''),/CSV月別構成比/);
});

test('CSV後に同じ区分の金額を手修正しても年額差を正本とし、旧月別構成は参考扱いにする', () => {
  const rows = {sales:[{code:'1',rate:'8',businessType:'type2',amount:'120000000',foodAmount:'120000000',source:'csv-edited'}],
    purchases:[{code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'csv'}]};
  const groups = [
    {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:81000000},
    {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-05',amount:27000000},
    {kind:'purchases',code:'5',rate:'8',month:'2027-04',amount:75600000}
  ];
  const result = adapter.create(input({distribution:'csv',sourcePeriodStart:'2027-04-01',
    sourcePeriodEnd:'2028-03-31',sourcePeriodConfirmed:true,taxEntryRows:rows,csvMonthlyGroups:groups}));
  assert.equal(result.distribution.used,'csv');
  assert.match(result.distribution.notes.join(''),/金額修正/);
  assert.equal(sum(result.salesDeltas),result.annualSalesDelta);
});

test('区分不一致と差引ゼロで構成比が使えない場合は、負値を0へ変えず均等に戻す', () => {
  const rows = {sales:[{code:'1',rate:'8',businessType:'type2',amount:'108000000',foodAmount:'108000000',source:'csv'}],
    purchases:[{code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'csv'}]};
  const groups = [
    {kind:'sales',code:'1',rate:'8',businessType:'type1',month:'2027-04',amount:108000000},
    {kind:'purchases',code:'5',rate:'8',month:'2027-04',amount:75600000}
  ];
  const result = adapter.create(input({distribution:'csv',sourcePeriodStart:'2027-04-01',
    sourcePeriodEnd:'2028-03-31',sourcePeriodConfirmed:true,taxEntryRows:rows,csvMonthlyGroups:groups}));
  assert.equal(result.distribution.used,'uniform');
  assert.match(result.distribution.notes.join(''),/対応するCSV月別構成がありません/);
  assert.equal(sum(result.salesDeltas),-7000000);
});

test('取引日不明のCSVは全月網羅チェックがあっても月別構成を採用しない', () => {
  const rows = {sales:[{code:'1',rate:'8',businessType:'type2',amount:'108000000',foodAmount:'108000000',source:'csv'}],
    purchases:[{code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'csv'}]};
  const result = adapter.create(input({distribution:'csv',sourcePeriodStart:'2027-04-01',
    sourcePeriodEnd:'2028-03-31',sourcePeriodConfirmed:true,csvMonthlyDateUnknownCount:1,
    taxEntryRows:rows,csvMonthlyGroups:[
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:108000000},
      {kind:'purchases',code:'5',rate:'8',month:'2027-04',amount:75600000}
    ]}));
  assert.equal(result.distribution.used,'uniform');
  assert.match(result.distribution.notes.join(''),/取引日不明明細が1件/);
});

test('未修正CSV行と月次総額が食い違えば手修正とみなさず均等へ戻す', () => {
  const rows = {sales:[{code:'1',rate:'8',businessType:'type2',amount:'108000000',foodAmount:'108000000',source:'csv'}],
    purchases:[{code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'csv'}]};
  const result = adapter.create(input({distribution:'csv',sourcePeriodStart:'2027-04-01',
    sourcePeriodEnd:'2028-03-31',sourcePeriodConfirmed:true,taxEntryRows:rows,csvMonthlyGroups:[
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:107000000},
      {kind:'purchases',code:'5',rate:'8',month:'2027-04',amount:75600000}
    ]}));
  assert.equal(result.distribution.used,'uniform');
  assert.match(result.distribution.notes.join(''),/未修正の入力行が一致しません/);
});

test('古いSTEP3比較値や null の税込総額を有効値として再利用しない', () => {
  const stale = input();
  stale.calc.methods[0].amount = 299999;
  const staleResult = adapter.create(stale);
  assert.equal(staleResult.ready,false);
  assert.match(staleResult.reasons.join(''),/STEP3比較額/);
  const missing = input();
  missing.comparison.current.sales.totalAmount = null;
  const missingResult = adapter.create(missing);
  assert.equal(missingResult.ready,false);
  assert.equal(missingResult.annualSalesDelta,null);
});

test('別月の返品による負の月別構成を0円に丸めず、正負を保持して配分する', () => {
  const rows = {sales:[{code:'1',rate:'8',businessType:'type2',amount:'108000000',foodAmount:'108000000',source:'csv'}],
    purchases:[{code:'5',rate:'8',amount:'75600000',foodAmount:'75600000',source:'csv'}]};
  const result = adapter.create(input({distribution:'csv',sourcePeriodStart:'2027-04-01',
    sourcePeriodEnd:'2028-03-31',sourcePeriodConfirmed:true,taxEntryRows:rows,csvMonthlyGroups:[
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-04',amount:135000000,transactionKind:'ordinary'},
      {kind:'sales',code:'1',rate:'8',businessType:'type2',month:'2027-05',amount:-27000000,transactionKind:'adjustment'},
      {kind:'purchases',code:'5',rate:'8',month:'2027-04',amount:75600000}
    ]}));
  assert.equal(result.distribution.used,'csv');
  assert.equal(result.salesDeltas[0].amount,-8750000);
  assert.equal(result.salesDeltas[1].amount,1750000);
  assert.equal(sum(result.salesDeltas),-7000000);
});
