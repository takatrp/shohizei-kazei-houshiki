'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {collectSalesScenario} = require('../sales-scenario.js');
const sale = (amount,foodAmount = amount,extra = {}) => ({code:'1',rate:'8',amount:String(amount),foodAmount:extra.rate === '10' ? '' : String(foodAmount),businessType:'type2',...extra});
const options = {taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1,foodSalesPriceBasis:'netFixed'};
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('⑤ 食品売上と旧8%返品を集計前に分け、本則を計算し簡易の不足だけを返す', () => {
  const sales = [sale(216000),sale(108000,108000,{code:'11'})];
  const before = structuredClone(sales);
  const result = collectSalesScenario({sales},options);
  assert.equal(result.totalAmount,94000);
  assert.equal(result.totalTax,-6000);
  assert.equal(result.totalTaxableBase,100000);
  assert.equal(result.rows[1].amountFood1,202000);
  assert.equal(result.rows[1].amount8,-108000);
  assert.equal(result.simplified.amount,null);
  assert.equal(result.errors.length,0);
  assert.match(result.methodErrors.join(' '),/個別確認/);
  assert.deepEqual(sales,before);
});

test('⑤ 食品売上と返品が年間0円でも、異なる税率の取引は消えない', () => {
  const result = collectSalesScenario({sales:[sale(108000),sale(108000,108000,{code:'11'})]},options);
  assert.equal(result.rows[1].originalAmount8,0);
  assert.equal(result.rows[1].forecastFood1,101000);
  assert.equal(result.rows[1].amount8,-108000);
  assert.equal(result.totalTax,-7000);
});

test('④⑤ 月別食品構成を一度だけ適用し、新聞8%・標準10%・旧8%返品を保持', () => {
  const result = collectSalesScenario({sales:[sale(216000),sale(108000,0),
    sale(110000,0,{rate:'10'}),sale(10800,10800,{code:'11'})]},
  {...options,foodForecastMethod:'uniform',proposalFraction:.25,foodPeriodAmount:(_row,food) => food/2});
  // Original 8%: 108000 remaining food + 108000 newspaper - 10800 return.
  assert.equal(result.rows[1].amount8,205200);
  assert.equal(result.rows[1].forecastFood1,101000);
  assert.equal(result.totalTax,15200+1000+10000);
  close(result.simplified.amount,(15200+10000)*.2);
});

test('⑤ 明示1%実績と食品8%予測を別々に一度だけ計上する', () => {
  const actual = [{kind:'sale',date:'2028-04-01',transactionKind:'ordinary',amount:10100,businessType:'type2'}];
  const result = collectSalesScenario({sales:[sale(108000)],actualOnePercentEntries:actual},options);
  assert.equal(result.totalAmount,111100);
  assert.equal(result.totalTax,1100);
  assert.equal(result.rows[1].forecastFood1,101000);
  assert.equal(result.rows[1].actualFood1,10100);
  assert.equal(result.simplified.amount,0);
});

test('⑤ 元1%取引が判明した終了直後返品は食品同額控除を維持、元不明はゼロ確定しない', () => {
  const known = {kind:'sale',date:'2029-04-01',transactionKind:'adjustment',amount:-10100,businessType:'type2',originalRatePercent:1,originalDate:'2028-06-01'};
  const result = collectSalesScenario({actualOnePercentEntries:[known]},options);
  assert.equal(result.errors.length,0);
  assert.equal(result.totalTax,-100);
  assert.equal(result.simplified.foodOnePercentTax,-100);
  assert.equal(result.simplified.deemedCredit,-100);
  assert.equal(result.simplified.amount,0);
  const unknown = collectSalesScenario({actualOnePercentEntries:[{...known,originalRatePercent:undefined}]},options);
  assert.match(unknown.errors.join(' '),/元取引/);
});

test('⑤ 現行シナリオの返品符号と税込→税抜の換算は一度だけ', () => {
  const sales = [sale(216000),sale(108000,108000,{code:'11'})];
  const gross = collectSalesScenario({sales},{...options,taxScenario:'current'});
  const net = collectSalesScenario({sales},{...options,taxScenario:'current',amountMode:'excluded'});
  assert.equal(gross.totalTax,8000);
  assert.equal(gross.totalAmount,108000);
  assert.equal(net.totalTax,8000);
  assert.equal(net.totalAmount,100000);
  close(net.simplified.amount,1600);
});

test('⑤ 事業区分未確認でも本則取引税額を返し、簡易だけを未算定にする', () => {
  const result = collectSalesScenario({sales:[sale(108000,108000,{businessType:''})]},options);
  assert.equal(result.totalTax,1000);
  assert.equal(result.simplifiedBusinessUnknown,true);
  assert.equal(result.simplified.amount,null);
  assert.equal(result.errors.length,0);
});

test('⑤ 複数事業の1%食品を75%判定から除外する国税庁例を独立検算', () => {
  // Q&A p19 example: food 25m, other type2 8m, type4 2m (all net).
  // Other type2 share 80%; all other tax 1m * 20% = 200000.
  const result = collectSalesScenario({sales:[sale(27000000),sale(8800000,0,{rate:'10'}),
    sale(2200000,0,{rate:'10',businessType:'type4'})]},options);
  assert.equal(result.simplified.method,'single75');
  assert.equal(result.simplified.otherTaxableBase,10000000);
  close(result.simplified.amount,200000);
});


test('明示1％実績の将来仮定は税抜/税込据置を別に保持し、返品を通常取引へ変換しない',()=>{
  const api=require('../sales-scenario.js');
  const entry={amount:101000,transactionKind:'ordinary'};
  assert.equal(Math.round(api.forecastActualOneBasis(entry,'netFixed').amount),108000);
  assert.equal(api.forecastActualOneBasis(entry,'grossFixed').amount,101000);
  assert.equal(api.forecastActualOneBasis({...entry,transactionKind:'adjustment'}).available,false);
  assert.equal(api.forecastActualOneBasis({...entry,amount:-101000}).amount,null);
});

test('明示1％の返品取消は元帳の正符号を保持し、再び負の返品へ変えない',()=>{
  const known={kind:'sale',date:'2029-04-01',transactionKind:'adjustment',amount:10100,
    businessType:'type2',originalRatePercent:1,originalDate:'2028-06-01',originalTaxableState:'taxable'};
  const before=structuredClone(known);
  const result=collectSalesScenario({actualOnePercentEntries:[known]},options);
  assert.equal(result.errors.length,0);
  assert.equal(result.totalAmount,10100);
  assert.equal(result.totalTax,100); // 10100 / 101 * 1
  assert.equal(result.simplified.foodOnePercentTax,100);
  assert.equal(result.simplified.deemedCredit,100);
  assert.equal(result.simplified.amount,0);
  assert.deepEqual(known,before);
  const unresolved=collectSalesScenario({actualOnePercentEntries:[{...known,originalDate:''}]},options);
  assert.match(unresolved.errors.join(' '),/元取引/);
});

test('売上返還11の元取引が免税なら控除せず、明示未確認と旧未指定を区別',()=>{
  const sales=[sale(216000),sale(108000,108000,{code:'11',originalTaxableState:'exempt'})];
  const before=structuredClone(sales);
  const proposal=collectSalesScenario({sales},options);
  assert.equal(proposal.totalTax,2000); // food net 200000 * 1%; no prior-exempt return credit
  assert.equal(proposal.errors.length,0);
  assert.match(proposal.assumptions.join(' '),/免税.*返還/);
  const current=collectSalesScenario({sales},{...options,taxScenario:'current'});
  assert.equal(current.totalTax,16000); // net 200000 * 8%
  const unknown=collectSalesScenario({sales:[sales[0],{...sales[1],originalTaxableState:'unknown'}]},options);
  assert.match(unknown.errors.join(' '),/課税・免税状態/);
  assert.equal(unknown.rows[1].forecastFood1,202000,'関係する返品不足で他の食品売上を消さない');
  const legacy=collectSalesScenario({sales:[sales[0],sale(108000,108000,{code:'11'})]},options);
  assert.equal(legacy.totalTax,-6000,'旧未指定の分類意味を変更しない');
  assert.deepEqual(sales,before,'返金額・符号と資料の分類状態を変更しない');
});

test('明示1％返還の元課税状態も免税・未確認・旧未指定を区別する',()=>{
  const entry={kind:'sale',date:'2029-04-01',transactionKind:'adjustment',amount:-10100,
    businessType:'type2',originalRatePercent:1,originalDate:'2028-06-01'};
  const exempt=collectSalesScenario({actualOnePercentEntries:[{...entry,originalTaxableState:'exempt'}]},options);
  assert.equal(exempt.totalTax,0);
  assert.equal(exempt.errors.length,0);
  const unknown=collectSalesScenario({actualOnePercentEntries:[{...entry,originalTaxableState:'unknown'}]},options);
  assert.match(unknown.errors.join(' '),/課税・免税状態/);
  assert.equal(collectSalesScenario({actualOnePercentEntries:[entry]},options).totalTax,-100);
});
