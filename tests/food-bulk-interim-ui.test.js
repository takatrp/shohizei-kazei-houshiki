'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const interim = require('../interim-tax-engine.js');
const calendar = require('../tax-calendar.js');

const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,name);
  const end = html.indexOf('\nfunction ',start+1);
  return html.slice(start,end < 0 ? undefined : end);
}
function fixture(overrides = {}){
  const controls = {
    cashflowAutoBasis:{value:'actual'},cashflowPriorNationalTax:{value:'1,872,000'},
    cashflowPriorStart:{value:'2025-01-01'},cashflowPriorEnd:{value:'2025-12-31'},
    cashflowPriorChangedNationalTax:{value:''},cashflowAutoSeparate:{checked:false},
    cashflowPeriodShortening:{value:'none'},cashflowCorporateExtension:{value:'none'},
    cashflowSpecialCircumstances:{value:'none'},...overrides
  };
  const context = vm.createContext({
    $:id => controls[id],
    parseAmountInput:value => ({entered:String(value).trim() !== '',valid:/^-?[\d,]+$/.test(String(value)),value:Number(String(value).replaceAll(',',''))}),
    selectedValue:() => 'individual',
    ShohizeiTaxCalendar:calendar,ShohizeiInterimTax:interim,
    METHOD_LABELS:{regular:'本則課税'},
    ELIGIBILITY:{INELIGIBLE:'ineligible'},
    yen:value => `${Number(value).toLocaleString('ja-JP')}円`,
    escapeHtml:value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
    declarationRoundedAmount:(_calc,_method,_credit,_amount,details) => {
      details.regular={declaration:{nationalAmount:1872000,total:2400000}};
      return 2400000;
    }
  });
  vm.runInContext(['cashflowAutoBasis','cashflowAutoPlan','cashflowAutoEntries','cashflowAutoHtml','cashflowAutoExportRows']
    .map(source).join('\n'),context);
  return {context,controls};
}
const calc = {ctx:{start:'2026-01-01',end:'2026-12-31'},purchases:{adjustment:0}};

test('B01-B12 一括転記はSTEP2の両表にのみあり、上書きは一度確認し、CSV月別出典を維持',()=>{
  assert.match(html,/id="bulkFoodSales"/);
  assert.match(html,/id="bulkFoodPurchases"/);
  assert.match(source('bindTaxEntryRows'),/result\.overwrittenCount && !confirm/);
  assert.match(source('bindTaxEntryRows'),/taxEntryRows\[side\] = result\.rows;[\s\S]*renderTaxEntryRows\(side\);[\s\S]*update\(\)/);
  assert.match(source('applyTaxRowEdit'),/field !== 'foodAmount'\) importedCsvOrigin\.manualChanged = true/);
  assert.match(source('applyTaxRowEdit'),/row\.source === 'csv' && field !== 'foodAmount'/);
});

test('I01-I02 実績の国税187.2万円から1回・120万円、STEP3税額は変えない',()=>{
  const {context} = fixture();
  const plan = context.cashflowAutoPlan(calc,null,'regular');
  assert.equal(plan.ready,true);
  assert.equal(plan.base.count,1);
  assert.equal(plan.base.totals.total,1200000);
  assert.equal(plan.base,plan.changed);
  assert.equal(plan.basis.national,1872000);
  assert.equal(context.cashflowAutoEntries(plan.base)[0].amount,1200000);
  assert.match(context.cashflowAutoHtml(plan),/1回・1,200,000円/);
  assert.match(context.cashflowAutoHtml(plan),/食品1％の中間申告特例・仮決算は自動適用しません/);
});

test('I03-I05 別前期額の明示、欠損は未算定、実績はSTEP3と独立',()=>{
  const {context,controls} = fixture({cashflowAutoSeparate:{checked:true}});
  const first = context.cashflowAutoPlan(calc,null,'regular');
  assert.equal(first.ready,false);
  assert.equal(first.changed.status,'unavailable');
  controls.cashflowPriorChangedNationalTax.value='4,800,001';
  const next = context.cashflowAutoPlan(calc,null,'regular');
  assert.equal(next.base.count,1);
  assert.equal(next.changed.count,3);
  assert.match(context.cashflowAutoHtml(next),/別前期仮定/);
});

test('I09-I20 期限と日付付き予定表は画面・コピー・CSVへ同じデータから渡す',()=>{
  const {context} = fixture();
  const plan = context.cashflowAutoPlan(calc,null,'regular');
  const [item] = plan.base.installments;
  const screen = context.cashflowAutoHtml(plan);
  const rows = context.cashflowAutoExportRows(plan);
  const text = JSON.stringify(rows);
  for(const value of [item.rawDueDate,item.adjustedDueDate,String(item.total)]){
    assert.ok(screen.includes(value === String(item.total) ? '1,200,000' : value));
    assert.ok(text.includes(value));
  }
  assert.ok(rows.some(row => row[0] === '前期国税の出典' && /前期実績入力/.test(row[1])));
  assert.ok(rows.some(row => row[0] === '基準案の申告回数' && row[1] === 1));
});

test('I17 STEP3代理は同じ現行税率・選択方式の国税内訳を概算として使用',()=>{
  const {context,controls} = fixture({cashflowAutoBasis:{value:'step3'}});
  const comparison={current:{ctx:{},sales:{},purchases:{},regularCredit:0},rows:[{key:'regular',currentMethod:{amount:2400000,eligibility:'eligible'},proposalMethod:{amount:300000}}]};
  const basis = context.cashflowAutoBasis(calc,comparison,'regular');
  assert.equal(basis.national,1872000);
  assert.equal(basis.quality,'概算');
  assert.equal(basis.priorStart,'2025-01-01');
  assert.match(basis.reasons.join(''),/実際の前期確定額ではなく/);
  controls.cashflowAutoSeparate.checked=true;
  assert.equal(context.cashflowAutoBasis(calc,comparison,'regular').changedNational,234000);
});

test('I08 短縮特例ありを前期額不足の0円扱いにしない',()=>{
  const {context} = fixture({cashflowPriorNationalTax:{value:''},cashflowPeriodShortening:{value:'yes'}});
  const plan = context.cashflowAutoPlan(calc,null,'regular');
  assert.equal(plan.base.status,'not_applicable');
  assert.equal(plan.ready,false);
  assert.match(context.cashflowAutoHtml(plan),/短縮特例のため対象外/);
  assert.ok(context.cashflowAutoExportRows(plan).some(row => row[0] === '基準案の中間納付合計' && row[1] === '対象外'));
});
