const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../tax-return-engine.js');

const rates = ['8','10'];
const zero = () => ({'8':0,'10':0});
const percentages = {type1:90,type2:80,type3:70,type4:60,type5:50,type6:40};
const deemed = Object.fromEntries(Object.entries(percentages).map(([key,value]) => [key,value / 100]));
function makeInput(groups){
  const taxableSalesGross = zero(), salesReturnGross = zero(), salesByType = {};
  for(const [key,gross,returns = zero()] of groups){
    salesByType[key] = {gross,returns};
    for(const rate of rates){
      taxableSalesGross[rate] += gross[rate] || 0;
      salesReturnGross[rate] += returns[rate] || 0;
    }
  }
  return {taxableSalesGross,salesReturnGross,salesByType};
}
const ten = value => ({'8':0,'10':value});
const eight = value => ({'8':value,'10':0});
const calculate = input => R.calculateCurrentLawSalesMethod(input,'simplified',deemed);
const floor = (value,numerator,denominator) => Number(BigInt(value) * BigInt(numerator) / BigInt(denominator));

test('S01 区分別千円切捨ての差では止めず、付表5-3④と⑬を分ける', () => {
  const result = calculate(makeInput([['type2',ten(1100660)],['type4',ten(1100660)]]));
  assert.equal(result.complete,true);
  assert.deepEqual(result.schedule53.basisTaxByRate,{'8':0,'10':156078});
  assert.deepEqual(result.schedule53.divisorByRate,{'8':0,'10':156092});
  assert.deepEqual(result.basisRows.map(row => row.byRate['10'].national),[78046,78046]);
  assert.equal(result.selection.candidates[0].numeratorByRate['10'],109263);
  assert.equal(result.credit,109253); // National Tax Agency intermediate floors: 62,436 + 46,827.
  assert.deepEqual([result.national,result.local,result.totalBeforeInterim],[46800,13200,60000]);
});

test('S02/S03 国税庁付表5-3記載例：税率・区分・返還をそれぞれ丸め、同一75％候補を採用', () => {
  const result = calculate(makeInput([
    ['type2',{'8':19192000,'10':7712000},{'8':1250000,'10':456000}],
    ['type4',ten(3804000),ten(300000)]
  ]));
  assert.deepEqual(result.schedule53.basisTaxByRate,{'8':1036626,'10':762975});
  assert.deepEqual(result.schedule53.divisorByRate,{'8':1036649,'10':762982});
  assert.deepEqual(result.basisRows[0].byRate['8'].grossTax,1108871);
  assert.equal(result.basisRows[0].byRate['8'].returnTax,72222);
  assert.deepEqual(result.basisRows.map(row => row.byRate['10'].national),[514516,248466]);
  assert.deepEqual(result.selection.candidates[0].byRate,{'8':829300,'10':560685});
  assert.deepEqual(result.selection.candidates[0].numeratorByRate,{'8':829319,'10':560691});
  assert.equal(result.selection.candidates[0].credit,1389985);
  assert.deepEqual(result.selection.byRate,{'8':829300,'10':610380});
  assert.equal(result.credit,1439680);
  assert.equal(result.selection.kind,'single75');
});

test('S04/S05 税率ごとの国税率と単一区分の直接乗算を維持', () => {
  const single = calculate(makeInput([['type2',ten(1100660)]]));
  assert.equal(single.schedule53.basisTaxByRate['10'],78000);
  assert.equal(single.schedule53.divisorByRate['10'],78046);
  assert.equal(single.credit,62400); // floor(78,000 × 80%), not A × floor(D × 80%) / D.
  const mixed = calculate(makeInput([['type2',{'8':108000,'10':110000}],['type4',{'8':108000,'10':110000}]]));
  assert.deepEqual(mixed.schedule53.divisorByRate,{'8':12480,'10':15600});
  assert.equal(mixed.credit,mixed.selection.byRate['8'] + mixed.selection.byRate['10']);
  const all = calculate(makeInput(Object.keys(percentages).map((key,index) => [key,ten((index + 1) * 110000)])));
  assert.equal(all.basisRows.length,6);
  assert.equal(all.referenceCalculable,true);
});

test('S06 1種類75％の境界は税抜課税売上高の整数比較', () => {
  const candidate = first => calculate(makeInput([['type1',ten(first)],['type6',ten(1100000-first)]]));
  assert.ok(candidate(825000).selection.candidates.some(item => item.kind === 'single75' && item.businessTypes[0] === 'type1'));
  assert.ok(!candidate(824999).selection.candidates.some(item => item.kind === 'single75' && item.businessTypes[0] === 'type1'));
  assert.ok(candidate(825001).selection.candidates.some(item => item.kind === 'single75' && item.businessTypes[0] === 'type1'));
});

test('S07 2種類合計75％の境界は第3区分を含む税抜額で判定', () => {
  const candidate = first => calculate(makeInput([
    ['type2',ten(first)],['type4',ten(385000)],['type6',ten(1100000-first-385000)]
  ]));
  const hasPair = first => candidate(first).selection.candidates.some(item =>
    item.kind === 'pair75' && item.businessTypes.join() === 'type2,type4');
  assert.equal(hasPair(440000),true);
  assert.equal(hasPair(439999),false);
  assert.equal(hasPair(440001),true);
});

test('S08 候補は全税率で同一のものを選び、税率別の最有利額を継ぎ接ぎしない', () => {
  const result = calculate(makeInput([
    ['type1',{'8':108000,'10':0}],['type2',{'8':0,'10':110000}],['type6',{'8':216000,'10':220000}]
  ]));
  const candidate = result.selection.candidates.find(item => item.kind === result.selection.kind && item.label === result.selection.label);
  assert.deepEqual(result.selection.byRate,candidate.byRate);
  assert.equal(result.credit,candidate.credit);
  assert.equal(result.credit,Math.max(...result.selection.candidates.map(item => item.credit)));
});

test('S09 税込親合計と内訳の不一致、無効区分、未処理CSVは未算定にする', () => {
  const input = makeInput([['type2',ten(110000)]]);
  input.taxableSalesGross['10']++;
  assert.throws(() => calculate(input),/税込売上.*一致しません/);
  assert.throws(() => calculate(makeInput([['unclassified',ten(110000)]])),/事業区分/);
  const unresolved = makeInput([['type2',ten(110000)]]);
  unresolved.unresolvedCount = 1;
  assert.equal(calculate(unresolved).referenceCalculable,false);
});

test('S10 行分割・並び替えで税率×区分集計と税額は不変', () => {
  const rows = {sales:[
    {code:'1',rate:'10',businessType:'type2',amount:'55,033'},
    {code:'1',rate:'10',businessType:'type2',amount:'55,033'},
    {code:'1',rate:'10',businessType:'type4',amount:'110,066'},
    {code:'3',amount:'0'}],purchases:[]};
  const split = R.aggregateReturnRows(rows);
  const joined = R.aggregateReturnRows({...rows,sales:[{code:'1',rate:'10',businessType:'type2',amount:'110,066'},
    rows.sales[2],rows.sales[3]]});
  assert.deepEqual(split.input,joined.input);
  assert.equal(calculate(split.input).credit,calculate(joined.input).credit);
});

test('S11 全額返品・負純額・ゼロ分母を完成額にしない', () => {
  assert.throws(() => calculate(makeInput([['type2',ten(110000),ten(110000)]])),/課税売上高/);
  assert.throws(() => calculate(makeInput([['type2',ten(110000),ten(110001)]])),/返還/);
  assert.throws(() => calculate(makeInput([])),/課税売上高/);
});

test('S12 固定seedの端数入力を独立BigInt式の中間額と照合', () => {
  let state = 20260925;
  const next = () => ((state = (Math.imul(state,1664525) + 1013904223) >>> 0) % 1000000) + 110000;
  for(let index=0;index<80;index++){
    const a=next(),b=next();
    const result = calculate(makeInput([['type2',ten(a)],['type4',ten(b)]]));
    const base = floor(a+b,100,110);
    const A = floor(Math.floor(base/1000)*1000,78,1000);
    const tA = floor(a,78,1100), tB = floor(b,78,1100);
    const numerator = floor(tA,80,100) + floor(tB,60,100);
    const expected = floor(A,numerator,tA+tB);
    assert.equal(result.schedule53.candidates[0].byRate['10'],expected,`seed=20260925 iteration=${index}, a=${a}, b=${b}`);
  }
});
