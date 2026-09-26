const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../cashflow-engine.js');

const i = (month,amount) => [{month,amount}];
// Independent arithmetic expectations from method_cashflow_fixtures.json. These
// fixed taxes test cash events, not the tax law calculation that produces them.
const fixtures = [
  {id:'F01',tax:[300000,100000],interim:[[],[]],months:[['2029-02',null],['2029-02',null]],
    events:{'2029-02':200000},final:200000,end:0,drawdown:[0,null],net:[[0,300000,0],[0,100000,0]]},
  {id:'F02',tax:[300000,-500000],interim:[i('2028-08',1200000),i('2028-08',1200000)],months:[[null,'2029-04'],[null,'2029-04']],
    events:{'2029-04':800000},final:800000,end:0,drawdown:[0,null],net:[[1200000,0,900000],[1200000,0,1700000]]},
  {id:'F03',tax:[100000,-500000],interim:[i('2028-08',1200000),i('2028-08',1200000)],months:[[null,'2029-03'],[null,'2029-05']],
    events:{'2029-03':-1100000,'2029-05':1700000},final:600000,end:0,drawdown:[1100000,'2029-03'],net:[[1200000,0,1100000],[1200000,0,1700000]],
    cumulative:{'2029-03':-1100000,'2029-04':-1100000,'2029-05':600000}},
  {id:'F04',tax:[300000,300000],interim:[i('2028-08',100000),i('2028-08',250000)],months:[['2029-02',null],['2029-02',null]],
    events:{'2028-08':-150000,'2029-02':150000},final:0,end:-150000,drawdown:[150000,'2028-08'],net:[[100000,200000,0],[250000,50000,0]]},
  {id:'F05',tax:[300000,500000],interim:[i('2028-08',1200000),i('2028-08',1200000)],months:[[null,'2029-03'],[null,'2029-03']],
    events:{'2029-03':-200000},final:-200000,end:0,drawdown:[200000,'2029-03'],net:[[1200000,0,900000],[1200000,0,700000]]},
  {id:'F06',tax:[0,-500000],interim:[[],[]],months:[[null,null],[null,'2029-06']],
    events:{'2029-06':500000},final:500000,end:0,drawdown:[0,null],net:[[0,0,0],[0,0,500000]]},
  {id:'F07',tax:[300000,-500000],interim:[i('2029-01',1200000),i('2029-01',1200000)],months:[[null,'2029-02'],[null,'2029-04']],
    events:{'2029-02':-900000,'2029-04':1700000},final:800000,end:0,drawdown:[900000,'2029-02'],net:[[1200000,0,900000],[1200000,0,1700000]]},
  {id:'F08',tax:[-500000,100000],interim:[i('2028-08',1200000),i('2028-08',1200000)],months:[[null,'2029-05'],[null,'2029-03']],
    events:{'2029-03':1100000,'2029-05':-1700000},final:-600000,end:0,drawdown:[600000,'2029-05'],net:[[1200000,0,1700000],[1200000,0,1100000]]}
];

function run(f){
  const anyInterim = f.interim.some(entries => entries.length);
  return engine.calculate({
    periodStart:'2028-01',periodEnd:'2028-12',periodEndDate:'2028-12-31',
    salesDeltas:[],purchaseDeltas:[],annualTax:{base:f.tax[0],changed:f.tax[1]},
    interim:anyInterim ? {status:'scheduled',base:f.interim[0],changed:f.interim[1]} : {status:'none'},
    settlementByPlan:{
      base:{paymentMonth:f.months[0][0],refundMonth:f.months[0][1]},
      changed:{paymentMonth:f.months[1][0],refundMonth:f.months[1][1]}
    }
  });
}

for(const f of fixtures){
  test(`${f.id} 案別の税金イベントと月末累積は独立固定値に一致する`, () => {
    const result = run(f);
    assert.equal(result.status,'complete');
    assert.equal(result.finalCumulative,f.final);
    assert.equal(result.periodEndCumulative,f.end);
    assert.deepEqual(result.maxDrawdown,{amount:f.drawdown[0],month:f.drawdown[1]});
    assert.deepEqual(Object.fromEntries(result.rows.filter(row => row.net !== 0).map(row => [row.month,row.net])),f.events);
    for(const [index,plan] of ['base','changed'].entries()){
      const actual = result.rows.reduce((sum,row) => ({
        interim:sum.interim + row[`${plan}Tax`].interim,
        settlement:sum.settlement + row[`${plan}Tax`].settlement,
        refund:sum.refund + row[`${plan}Tax`].refund
      }),{interim:0,settlement:0,refund:0});
      assert.deepEqual([actual.interim,actual.settlement,actual.refund],f.net[index]);
      assert.equal(actual.interim + actual.settlement - actual.refund,f.tax[index]);
    }
    for(const [month,amount] of Object.entries(f.cumulative || {})){
      assert.equal(result.rows.find(row => row.month === month).cumulative,amount);
    }
  });
}

test('MC25 案別の必須月を明示クリアした場合、旧共通月に戻さない', () => {
  const f = fixtures[0];
  const input = {
    periodStart:'2028-01',periodEnd:'2028-12',salesDeltas:[],purchaseDeltas:[],
    annualTax:{base:300000,changed:100000},interim:{status:'none'},
    settlementMonth:'2029-02',refundMonth:'2029-04',
    settlementByPlan:{base:{paymentMonth:'2029-02'},changed:{paymentMonth:''}}
  };
  const result = engine.calculate(input);
  assert.equal(result.status,'partial');
  assert.equal(result.finalCumulative,null);
  assert.match(result.reasons.join(' '),/変更案の確定差額/);
  assert.equal(result.rows.at(-1).month,'2028-12');
  assert.equal(f.id,'F01');
});

test('MC24 案別精算月は期末・最後の中間より前を許さない', () => {
  const input = {
    periodStart:'2028-01',periodEnd:'2028-12',periodEndDate:'2028-12-31',
    salesDeltas:[],purchaseDeltas:[],annualTax:{base:300000,changed:100000},interim:{status:'none'},
    settlementByPlan:{base:{paymentMonth:'2028-12'},changed:{paymentMonth:'2029-02'}}
  };
  assert.throws(() => engine.calculate(input),/月末終了の対象期より後/);
  input.settlementByPlan.base.paymentMonth = '2028-11';
  assert.throws(() => engine.calculate(input),/対象期の終了月以降/);
  input.settlementByPlan.base.paymentMonth = '2028-12';
  input.periodEndDate = '2028-12-15';
  assert.throws(() => engine.calculate(input),/申告・処理時期を確認/);
  input.sameMonthSettlementConfirmed = true;
  assert.equal(engine.calculate(input).status,'complete');
  input.periodEndDate = '2028-12-31';
  input.sameMonthSettlementConfirmed = true;
  assert.throws(() => engine.calculate(input),/月末終了の対象期より後/);
  input.settlementByPlan.base.paymentMonth = '2029-01';
  input.interim = {status:'scheduled',base:i('2029-02',100000),changed:i('2029-02',100000)};
  assert.throws(() => engine.calculate(input),/中間納付予定月が精算予定月より後/);
});

test('旧入力契約の共通予定月を保ち、案別予定はあれば優先する', () => {
  const legacy = engine.calculate({periodStart:'2028-01',periodEnd:'2028-12',salesDeltas:[],purchaseDeltas:[],
    annualTax:{base:300000,changed:100000},interim:{status:'none'},settlementMonth:'2029-02',refundMonth:'2029-04'});
  assert.equal(legacy.status,'complete');
  assert.equal(legacy.rows.find(row => row.month === '2029-02').net,200000);
  assert.equal(legacy.settlementMonths.byPlan,false);
});

test('MC27 固定シードの正負・中間額で案入替えは毎月差を反転し、各案の税額を検算する', () => {
  let seed = 20260926;
  function next(){ seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; return seed; }
  for(let index = 0; index < 80; index++){
    const tax = [Number(next() % 2000001) - 1000000,Number(next() % 2000001) - 1000000];
    const paid = [Number(next() % 1200000),Number(next() % 1200000)];
    const interim = paid.map(amount => amount ? i('2028-09',amount) : []);
    const plans = [0,1].map(plan => {
      const q = tax[plan] - paid[plan];
      return {paymentMonth:q > 0 ? '2029-02' : '',refundMonth:q < 0 ? '2029-04' : ''};
    });
    const input = (a,b) => ({periodStart:'2028-01',periodEnd:'2028-12',periodEndDate:'2028-12-31',
      salesDeltas:[],purchaseDeltas:[],annualTax:{base:tax[a],changed:tax[b]},
      interim:{status:'auto',base:interim[a],changed:interim[b]},
      settlementByPlan:{base:plans[a],changed:plans[b]}});
    const forward = engine.calculate(input(0,1));
    const swapped = engine.calculate(input(1,0));
    assert.equal(forward.status,'complete');
    assert.equal(swapped.status,'complete');
    assert.equal(forward.finalCumulative,tax[0]-tax[1]);
    assert.equal(swapped.finalCumulative,-forward.finalCumulative);
    assert.deepEqual(forward.rows.map(row => row.net),swapped.rows.map(row => -row.net || 0));
    assert.deepEqual(forward.rows.map(row => row.cumulative),swapped.rows.map(row => -row.cumulative || 0));
  }
});
