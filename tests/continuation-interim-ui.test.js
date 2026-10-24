'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const interim=require('../interim-tax-engine.js'),food=require('../food-interim-comparison.js'),priorEvidence=require('../prior-actual-evidence.js');
const read=file=>process.env.KAZEI_UI_BASELINE_REF?cp.execFileSync('git',['show',process.env.KAZEI_UI_BASELINE_REF+':'+file],{cwd:path.join(__dirname,'..'),encoding:'utf8'}):fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const uiSource=read('continuation-ui.js'),html=read('index.html');
function source(name){const start=html.indexOf(`function ${name}(`),end=html.indexOf('\nfunction ',start+1);assert.notEqual(start,-1);return html.slice(start,end<0?undefined:end);}
const P={start:'2026-04-01',end:'2027-03-31'};
function fixture(selection={A:'ordinary',B:'ordinary'}){
  const controls={cashflowMethod:{value:'regular'},cashflowBaseMethod:{value:'regular'},cashflowChangedMethod:{value:'simplified'},cashflowAutoBasis:{value:'actual'},priorTaxMethod:{value:'regular'},proposalFoodClassificationState:{value:'confirmed'},proposalPurchaseClassificationState:{value:'confirmed'}};
  const options={priorStart:P.start,priorEnd:P.end,currentStart:'2027-04-01',currentEnd:'2028-03-31',entityType:'corporation',taxScenario:'foodProposal',periodShortening:'none',corporateExtension:'none',specialCircumstances:'none'};
  const plan=interim.plan({...options,priorNationalTax:1092000});assert.equal(plan.totals.total,700000);
  const auto={mode:'rateImpact',basis:{national:1092000,priorStart:P.start,priorEnd:P.end,source:'実前期',quality:'実績',reasons:[]},options,base:plan,changed:plan,separate:false,separateUnconfirmed:false,ready:true};
  const saved={version:1,prior:{period:{...P},exactMethod:'regular',foodRate:'8',foodSales:'32400000',otherSales:'22000000',foodPurchases:'21600000',otherPurchases:'15400000',nonTaxableSales:'0',adjustmentNational:'0',creditMethod:'full',...selection}};
  let calls=0;
  const sandbox={document:{getElementById:id=>controls[id]||null},$:id=>controls[id],yen:value=>Number(value).toLocaleString('ja-JP')+'円',escapeHtml:value=>String(value),
    ShohizeiFoodInterimComparison:{...food,compare(input){calls++;return food.compare(input);}},ShohizeiPriorActualEvidence:priorEvidence,
    sharedCaseFacts:{priorActual:{status:'resolved',value:{period:{...P},nationalTax:'1092000'}},csvSource:{status:'empty'}},
    importedCsvOriginalSourceId:'',importedCsvMonthlyGroups:null,importedActualOnePercent:null,taxEntryRows:{sales:[],purchases:[]},rowCsvKnownZeros:{}};
  vm.runInNewContext(uiSource,sandbox);vm.runInNewContext(['cashflowAutoHtml','cashflowAutoExportRows'].map(source).join('\n'),sandbox);sandbox.ShohizeiContinuationUI.restore(saved);
  const run=(scenario='foodProposal',mode='rateImpact',overrides={})=>sandbox.ShohizeiContinuationUI.interimPlan({...auto,mode,...overrides},{ctx:{taxScenario:scenario},methods:[{key:'regular',amount:1300000},{key:'simplified',amount:2600000}]},{rows:[{key:'regular',currentAmount:1400000,proposalAmount:700000}]});
  return {run,sandbox,controls,auto,saved,calls:()=>calls};
}
test('現行税率は保存済み特例指定を使わず、比較計算・見出し・出力へ食品特例を追加しない',()=>{
  const f=fixture({A:'special',B:'special'}),r=f.run('current');assert.equal(f.calls(),0);assert.equal(r.foodSpecial,undefined);assert.equal(r.base.totals.total,700000);
  for(const text of [f.sandbox.cashflowAutoHtml(r),JSON.stringify(f.sandbox.cashflowAutoExportRows(r))]){assert.match(text,/通常の前期実績方式/);assert.doesNotMatch(text,/食品.*特例|明示.*利用予定/);}
});
test('食品シナリオで通常納付だけなら特例比較を残し、利用予定と表示しない',()=>{
  const f=fixture(),r=f.run();assert.equal(r.foodSpecial.status,'ready');assert.equal(r.foodSpecial.special.totals.total,350000);
  assert.equal(r.base.totals.total,700000);assert.equal(r.changed.totals.total,700000);assert.match(r.interimMethodLabel,/A・Bとも通常納付/);
  const rows=f.sandbox.cashflowAutoExportRows(r);assert.match(rows.find(x=>x[0]==='中間納付方式')[1],/通常/);assert.ok(rows.some(x=>/比較（利用予定とは別）/.test(x[0])));
  assert.doesNotMatch(f.sandbox.cashflowAutoHtml(r),/明示した利用予定/);
});
test('税率比較Aは古い特例指定を無視して通常700000円、Bだけ特例350000円を反映',()=>{
  const f=fixture({A:'special',B:'special'}),r=f.run();assert.equal(r.base.totals.total,700000);assert.equal(r.changed.totals.total,350000);
  assert.equal(r.foodSpecial.selection.A,'ordinary');assert.equal(r.foodSpecial.appliedSelection.A,'ordinary');assert.equal(r.foodSpecial.appliedSelection.B,'special');
  assert.equal(f.sandbox.ShohizeiContinuationUI.snapshot().prior.A,'special','保存値を勝手に書換えず適用境界で制限');
  for(const s of ['A','B'])for(const p of ['ordinary','special'])assert.equal(r.foodSpecial.settlements[s][p].reconciled,true);
  const screen=f.sandbox.cashflowAutoHtml(r),rows=f.sandbox.cashflowAutoExportRows(r);assert.match(screen,/A：通常納付／B：食品特例を利用予定/);
  assert.ok(rows.some(x=>x[0]==='変更案'&&x[5]===350000));
  for(const row of screen.matchAll(/<tr>(.*?)<\/tr>/g))assert.equal((row[1].match(/<(?:th|td)>/g)||[]).length,9);
});
test('食品1％世界の方式比較はA/B双方を選べ、精算は各方式の年税額を使う',()=>{
  const f=fixture({A:'special',B:'special'}),r=f.run('foodProposal','methodImpact');assert.equal(r.base.totals.total,350000);assert.equal(r.changed.totals.total,350000);
  assert.equal(r.foodSpecial.settlements.A.special.annualTax,1300000);assert.equal(r.foodSpecial.settlements.B.special.annualTax,2600000);
  assert.equal(r.foodSpecial.settlements.A.special.finalPayment,950000);assert.equal(r.foodSpecial.settlements.B.special.finalPayment,2250000);
  f.saved.prior.B='ordinary';f.sandbox.ShohizeiContinuationUI.restore(f.saved);const next=f.run('foodProposal','methodImpact');assert.equal(next.base.totals.total,350000);assert.equal(next.changed.totals.total,700000);
});
test('特例未算定でも通常納付を続け、指定と実反映を区別して不足理由を出す',()=>{
  const f=fixture({B:'special'});f.saved.prior.foodSales='';f.sandbox.ShohizeiContinuationUI.restore(f.saved);const r=f.run();assert.equal(r.foodSpecial.status,'unavailable');assert.equal(r.foodSpecial.special.totals,null);
  assert.equal(r.ready,true);assert.equal(r.base.totals.total,700000);assert.equal(r.changed.totals.total,700000);assert.match(r.interimMethodLabel,/通常納付/);
  assert.equal(r.foodSpecial.selection.B,'special');assert.equal(r.foodSpecial.appliedSelection.B,'ordinary');assert.match(JSON.stringify(f.sandbox.cashflowAutoExportRows(r)),/未算定.*通常方式/);
});
test('別前期仮定・代理値の予定を特例自動額で上書きしない',()=>{
  const f=fixture({A:'special',B:'special'}),separate=interim.plan({...f.auto.options,priorNationalTax:1872000});
  const r=f.run('foodProposal','rateImpact',{separate:true,changed:separate});assert.equal(r.base.totals.total,700000);assert.equal(r.changed.totals.total,1200000);assert.match(JSON.stringify(f.sandbox.cashflowAutoExportRows(r)),/別々.*通常納付/);
  f.controls.cashflowAutoBasis.value='step3';const proxy=f.run();assert.equal(proxy.base.totals.total,700000);assert.equal(proxy.changed.totals.total,700000);assert.equal(proxy.foodSpecial.special.totals,null);
});
