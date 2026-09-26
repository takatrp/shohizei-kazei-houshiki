const test=require('node:test');
const assert=require('node:assert/strict');
const chart=require('../cashflow-event-chart.js');
const zero=()=>({interim:0,settlement:0,refund:0});
test('A/B実額は差額が0円でも保持し、納付と還付の方向を区別する',()=>{
  const rows=[{month:'2028-08',baseTax:{...zero(),interim:120000},changedTax:{...zero(),interim:120000}},{month:'2029-03',baseTax:{...zero(),settlement:80000},changedTax:{...zero(),refund:40000}}];
  const model=chart.buildChartModel({rows});
  assert.equal(model.months.length,2);assert.equal(model.scale,120000);
  assert.equal(model.months[0].base[0].signedAmount,-120000);
  assert.equal(model.months[1].changed[2].signedAmount,40000);
  const html=chart.render({rows});assert.match(html,/中間納付 −120,000円/);assert.match(html,/還付 ＋40,000円/);
});
test('月内の中間・確定納付は共通スケール上で並べ、入力を変更しない',()=>{
  const rows=[{month:'2028-12',baseTax:{interim:100,settlement:300,refund:0},changedTax:{interim:0,settlement:0,refund:200}}];
  const copy=JSON.stringify(rows),model=chart.buildChartModel({rows});
  assert.equal(model.scale,400);assert.equal(JSON.stringify(rows),copy);
  const html=chart.render({rows});assert.match(html,/width:25%/);assert.match(html,/width:75%/);assert.match(html,/width:50%/);
});
test('未算定・0円・イベントのない空結果を混同しない',()=>{
  const rows=[{month:'2028-01',baseTax:zero(),changedTax:zero()}];
  assert.match(chart.render({rows}),/イベントはありません（0円）/);
  assert.match(chart.render({rows,taxComplete:false}),/未算定/);
  assert.doesNotMatch(chart.render({rows,taxComplete:false}),/イベントはありません（0円）/);
  assert.match(chart.render({rows:[],taxComplete:false}),/未算定/);
  assert.match(chart.render(),/未算定/);
  assert.match(chart.render({rows:[],taxComplete:true}),/イベントはありません（0円）/);
  const partial=chart.render({rows:[{month:'2028-01',baseTax:zero(),changedTax:null}]});
  assert.match(partial,/納付・還付なし（0円）/);assert.match(partial,/未算定/);
});
test('不正イベントを0円へ補完せず未算定とする',()=>{
  for(const bad of [NaN,Infinity,-1,'100',undefined]){
    assert.equal(chart.buildChartModel({rows:[{month:'2028-01',baseTax:{...zero(),interim:bad},changedTax:zero()}]}).hasUnknown,true);
  }
});
test('案名・期間・値を読み上げ可能にし、入力文字列をHTMLエスケープする',()=>{
  const html=chart.render({labels:{base:'現行<税率>',changed:'食品1％',title:'税率別の実額'},periodStart:'2028-01-01',periodEnd:'2028-12-31',rows:[{month:'2029-02',baseTax:{...zero(),settlement:500},changedTax:zero()}]});
  assert.match(html,/現行&lt;税率&gt;/);assert.match(html,/対象期間 2028-01-01〜2028-12-31/);assert.match(html,/aria-label="2029-02 現行&lt;税率&gt;：確定納付 −500円"/);assert.match(html,/食品1％/);
});
