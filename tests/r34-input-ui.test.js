'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function source(name){const start=html.indexOf(`function ${name}(`);assert.ok(start>=0);return html.slice(start,html.indexOf('\nfunction ',start+1));}
test('r34 新規売上行はコード1/3だけを選択し、金額を0円補完しない',()=>{
  let next=0;
  const ctx=vm.createContext({newTaxEntry:side=>require('../tax-entry-rows').createTaxEntryRow(side,{id:String(++next)})});
  vm.runInContext(source('initialSalesTaxEntries'),ctx);
  const rows=JSON.parse(JSON.stringify(ctx.initialSalesTaxEntries()));
  assert.deepEqual(rows.map(row=>row.code),['1','3']);
  assert.ok(rows.every(row=>row.amount===''&&row.foodAmount===''));
  assert.notEqual(rows[0].id,rows[1].id);
  const aggregate=require('../tax-entry-rows').aggregateTaxRows({sales:rows,purchases:[]});
  assert.equal(aggregate.fields.nonTaxableSales.entered,false);
  rows[1].amount='0';
  assert.equal(require('../tax-entry-rows').aggregateTaxRows({sales:rows,purchases:[]}).fields.nonTaxableSales.entered,true);
});
test('r34 税率必須バッジは選択群見出しを参照し、売上見出しを修正する',()=>{
  assert.match(html,/id="taxScenarioHeading">消費税率の前提/);
  assert.match(html,/role="radiogroup" aria-labelledby="taxScenarioHeading"/);
  assert.match(source('renderInputRequirementBadges'),/taxScenario:\(\) => \$\('taxScenarioHeading'\)/);
  assert.match(html,/id="salesInputHeading"[^>]*>売上の金額を入力・確認/);
});
test('r34 短縮特例のHTMLとリセット共通初期値は適用なし',()=>{
  assert.match(html,/id="cashflowPeriodShortening"[^]*?<option value="none" selected>適用なし/);
  assert.match(html,/cashflowPeriodShortening:'none'/);
  assert.match(source('resetCashflowInputs'),/CASHFLOW_INPUT_DEFAULTS/);
});
