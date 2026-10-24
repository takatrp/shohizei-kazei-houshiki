'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quick = require('../four-amount-entry.js');
const rows = require('../tax-entry-rows.js');
const input = {industry:'manufacturing',foodSales:'1,080,000',otherSales:'110000',foodPurchases:'540000',otherPurchases:'220000'};

test('飲食店の4金額案内は8％テイクアウト等と10％店内・酒類を分け、現行税率を政策試算と呼ばない',()=>{
  const view=quick.presentation({industry:'restaurant',taxScenario:'current'});
  assert.match(view.labels.foodSales,/軽減8％/);assert.match(view.labels.otherSales,/10％/);assert.match(view.intro,/テイクアウト・物販.*店内飲食・酒類/);
  assert.doesNotMatch(view.intro+view.assumptions.join(' '),/1％|政策試算/);assert.equal(Object.keys(view.labels).length,4);
});
test('4金額の政策前提・業種案内を変えても入力値と変換行を変更しない',()=>{
  const original=JSON.stringify(input),before=quick.build(input);
  for(const industry of ['restaurant','manufacturing']){const view=quick.presentation({industry,taxScenario:'foodProposal'});assert.match(view.intro,/8％実績.*1％政策試算/);assert.match(view.assumptions[0],/実際の1％取引ではありません/);}
  assert.equal(JSON.stringify(input),original);assert.deepEqual(quick.build(input).rows,before.rows);
});

test('4金額: 同じ税込行を既存集計エンジンへ渡し二重換算しない',()=>{
  const result = quick.build(input);
  assert.equal(result.ready,true);
  const aggregate = rows.aggregateTaxRows(result.rows);
  assert.equal(aggregate.ready,true);
  assert.equal(aggregate.fields.type3Sale8.value,1080000);
  assert.equal(aggregate.fields.type3Sale10.value,110000);
  assert.equal(aggregate.fields.type3SaleFood1.value,1080000);
  assert.equal(aggregate.fields.purchase8.value,540000);
  assert.equal(aggregate.fields.purchase10.value,220000);
  assert.equal(aggregate.fields.nonTaxableSales.value,0);
  assert.equal(result.foodBasis,'reduced8Forecast');
  assert.ok(result.rows.sales.every(row=>row.rate !== '1'));
  assert.match(result.assumptions.join(' '),/税込/);
  assert.match(result.assumptions.join(' '),/実際の1％取引ではありません/);
});

test('4金額: 空欄を0円へ補完せず明示0円と業種未選択を区別',()=>{
  const zero = quick.build({...input,foodSales:'0',foodPurchases:0});
  assert.equal(zero.ready,true);
  assert.equal(zero.rows.sales[0].amount,'0');
  assert.equal(zero.rows.sales[0].foodAmount,'0');
  for(const value of ['',undefined,'不正','-1']){
    const result = quick.build({...input,foodSales:value});
    assert.equal(result.ready,false);
    assert.ok(result.errors.some(error=>error.field === 'foodSales'));
  }
  assert.equal(quick.build({...input,industry:''}).ready,false);
});

test('4金額: 未入力の既存初期行から開始し生成行の再編集が可能',()=>{
  const context = {rows:{sales:[rows.createTaxEntryRow('sales',{code:'1'}),rows.createTaxEntryRow('sales',{code:'3'})],purchases:[rows.createTaxEntryRow('purchases')]}};
  const first = quick.build(input,context);
  assert.equal(first.ready,true);
  assert.equal(quick.editable({rows:first.rows}),true);
  const next = quick.build({...input,otherSales:'330000'},{rows:first.rows});
  assert.equal(next.ready,true);
  assert.equal(rows.aggregateTaxRows(next.rows).fields.type3Sale10.value,330000);
});

test('4金額: CSV・詳細・実際1%取引の内訳をまとめて上書きしない',()=>{
  const first = quick.build(input);
  for(const context of [
    {rows:first.rows,hasCsvSource:true},
    {rows:first.rows,actualOnePercentEntries:[{kind:'sale',amount:101}]},
    {rows:{sales:[{code:'1',rate:'8',businessType:'type2',amount:'',source:'manual'}],purchases:[]}},
    {rows:{sales:[],purchases:[{code:'52',creditRatio:'70',amount:'',source:'manual'}]}},
    {rows:{sales:[{code:'1',rate:'8',amount:'108000',foodAmount:'54000',source:'manual'}],purchases:[]}},
    {rows:{sales:[{code:'1',rate:'8',amount:'0',source:'csv'}],purchases:[]}}
  ]){
    const before = structuredClone(context);
    const result = quick.build(input,context);
    assert.equal(result.ready,false);
    assert.strictEqual(result.rows,context.rows);
    assert.deepEqual(context,before);
  }
});

test('4金額: 詳細へ移行後の区分・部分額・意図的な空欄は生成行でも上書きしない',()=>{
  for(const edits of [{foodAmount:'0',foodAmountSource:'manual'},{foodAmount:'',foodAmountSource:'manual'},
    {businessType:'type2'},{code:'11'},{rate:'10'},{amount:'1'}]){
    const first = quick.build(input);
    Object.assign(first.rows.sales[0],edits);
    const result = quick.build(input,{rows:first.rows});
    assert.equal(result.ready,false,JSON.stringify(edits));
    assert.strictEqual(result.rows,first.rows);
  }
});

test('4金額: 詳細の読み取り要約は食品内数とその他を分け元行を保持',()=>{
  const detailed = {sales:[{code:'1',businessType:'type2',rate:'8',amount:'108000',foodAmount:'54000',source:'csv'},
    {code:'1',businessType:'type3',rate:'10',amount:'110000',source:'csv'}],
    purchases:[{code:'5',rate:'8',amount:'10800',foodAmount:'10800',source:'csv'},
      {code:'7',rate:'10',amount:'11000',source:'csv'}]};
  const before = structuredClone(detailed);
  const summary = quick.summarize(detailed);
  assert.equal(summary.readOnly,true);
  assert.equal(summary.amounts.foodSales,54000);
  assert.equal(summary.amounts.otherSales,164000);
  assert.equal(summary.amounts.foodPurchases,10800);
  assert.equal(summary.complete,false);
  assert.deepEqual(detailed,before);
});

test('4金額: 全6業種は候補だけを設定し確認事実や実績へ格上げしない',()=>{
  for(const industry of quick.INDUSTRIES){
    const result = quick.build({...input,industry:industry.key});
    assert.equal(result.rows.sales[0].businessType,industry.businessType);
    assert.ok(result.rows.sales.every(row=>!row.classificationConfirmed));
    assert.match(result.assumptions.join(' '),/初期候補/);
  }
});


test('4金額の空欄・不正draftは旧金額を残さず、詳細保護と再編集を維持する',()=>{
  const first=quick.build(input);
  for(const text of ['', '不正']){
    const d=quick.draft({...input,foodSales:text},{rows:first.rows});
    assert.equal(d.ready,false);assert.equal(d.draft,true);
    assert.equal(d.rows.sales[0].amount,text);assert.equal(d.rows.sales[0].foodAmount,text);
    assert.equal(quick.editable({rows:d.rows}),true);
    assert.equal(rows.aggregateTaxRows(d.rows).ready,false);
    assert.equal(quick.build(input,{rows:d.rows}).ready,true);
  }
  const edited=structuredClone(first.rows);edited.sales[0].amount='999';
  assert.strictEqual(quick.draft({...input,foodSales:''},{rows:edited}).rows,edited);
});
