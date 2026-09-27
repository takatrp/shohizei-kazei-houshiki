'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const adapter=require('../cashflow-adapter.js');
const engine=require('../cashflow-engine.js');
const panel=require('../cashflow-panel-data.js');
const view=require('../cashflow-panel-view.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');

function source(name){
  const start=html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} exists`);
  const end=html.indexOf('\nfunction ',start+1);
  return html.slice(start,end<0?undefined:end);
}
function fixture(){
  const ctx={start:'2027-04-01',end:'2028-03-31',taxScenario:'foodProposal'};
  const calc={ctx,sales:{totalAmount:101000000},purchases:{totalAmount:70700000},
    methods:[{key:'regular',eligibility:'eligible'},{key:'simplified',eligibility:'eligible'}]};
  const comparison={current:{sales:{totalAmount:108000000},purchases:{totalAmount:75600000}},rows:[
    {key:'regular',currentAmount:2400000,proposalAmount:300000,currentMethod:{eligibility:'eligible'},proposalMethod:{eligibility:'eligible'},reference:false,reasons:[]},
    {key:'simplified',currentAmount:1600000,proposalAmount:0,currentMethod:{eligibility:'eligible'},proposalMethod:{eligibility:'eligible'},reference:false,reasons:[]}
  ]};
  return {ctx,calc,comparison,taxEntryRows:{sales:[],purchases:[]}};
}
function calculateMethod(input,key,basis){
  const adapted=adapter.create({...input,methodKey:key,transactionBasis:basis});
  assert.equal(adapted.ready,true);
  const interim={status:'scheduled',base:[{month:'2027-10',amount:100000}],changed:[{month:'2027-10',amount:100000}]};
  const calculated=engine.calculate({periodStart:adapted.periodStart,periodEnd:adapted.periodEnd,
    salesDeltas:adapted.salesDeltas,purchaseDeltas:adapted.purchaseDeltas,
    annualTax:{base:adapted.annualTax.base,changed:adapted.annualTax.changed},
    salesLag:0,purchaseLag:0,interim,settlementMonth:'2028-06',refundMonth:'2028-07'});
  assert.equal(calculated.status,'complete');
  const baselineFlows=Array.from({length:12},(_,index)=>({month:`${2027+Math.floor((index+3)/12)}-${String((index+3)%12+1).padStart(2,'0')}`,amount:250000}));
  const model=panel.buildPanelData({engine:calculated,adapter:adapted,mode:'rateImpact',interim,
    baselineFlows,baseSource:{kind:'manual'},
    labels:{A:`現行8％・${key}`,B:`食品1％・${key}`}});
  model.displayStyle='staircase';
  return {adapted,calculated,model};
}

test('SW01/11 通常STEP4は方式ボタンのみを表示し、旧モードは不可視の内部回帰として保持',()=>{
  assert.match(html,/id="step4DisplayTaxMethodButtons"/);
  assert.match(html,/id="step4PanelMethodButtons"[^>]*role="group" aria-label="グラフに表示する課税方式"/);
  assert.match(html,/class="is-hidden" aria-hidden="true"><span id="cashflowComparisonTypeLabel"/);
  assert.match(source('renderCashflow'),/const chosen = selectedComparisonMethods\(\)/);
  assert.match(source('renderStep4MethodPicker'),/chosen\.map\(key/);
  assert.match(source('renderStep4MethodPicker'),/\$\('step4PanelMethodButtons'\)\.innerHTML = buttonsHtml/);
  assert.match(source('bindEvents'),/for\(const id of \['step4DisplayTaxMethodButtons','step4PanelMethodButtons'\]\)/);
  assert.match(source('renderCashflow'),/if\(methodImpact\)\{ renderMethodCashflow\(calc,comparison\); return; \}/);
});

test('SW02/03/04/05/06 STEP3年税額だけを方式で切替え、取引差と全月B−Aを保持',()=>{
  const input=fixture();
  const regular=calculateMethod(input,'regular');
  const basis={salesDeltas:regular.adapted.salesDeltas,purchaseDeltas:regular.adapted.purchaseDeltas,
    distribution:regular.adapted.distribution};
  const simplified=calculateMethod(input,'simplified',basis);
  assert.deepEqual(regular.adapted.annualTax.raw,{base:2400000,changed:300000});
  assert.deepEqual(simplified.adapted.annualTax.raw,{base:1600000,changed:0});
  assert.strictEqual(simplified.adapted.salesDeltas,regular.adapted.salesDeltas,'月別取引差スナップショットを再生成しない');
  assert.strictEqual(simplified.adapted.purchaseDeltas,regular.adapted.purchaseDeltas);
  for(const side of ['A','B']){
    const byMonth=result=>new Map(result.model.cases[side].rows.map(row=>[row.month,row.flow]));
    const a=byMonth(regular),b=byMonth(simplified);
    for(const month of new Set([...a.keys(),...b.keys()])) assert.equal(a.get(month)||0,b.get(month)||0,`${side} ${month}`);
  }
  assert.notDeepEqual(simplified.model.cases.A.rows.map(row=>row.events),regular.model.cases.A.rows.map(row=>row.events));
  for(const result of [regular,simplified]){
    assert.equal(result.model.status.integrity,'ok');
    result.calculated.rows.forEach((row,index)=>{
      assert.equal(result.model.cases.B.rows[index].monthTotal-result.model.cases.A.rows[index].monthTotal,row.net);
      assert.equal(result.model.cases.B.rows[index].cumulative-result.model.cases.A.rows[index].cumulative,row.cumulative);
    });
  }
  assert.notEqual(simplified.calculated.finalCumulative,regular.calculated.finalCumulative);
});

test('SW07 一般→簡易→一般で元のSTEP3税額・税イベント・月末累積に戻る',()=>{
  const input=fixture();
  const first=calculateMethod(input,'regular');
  const basis={salesDeltas:first.adapted.salesDeltas,purchaseDeltas:first.adapted.purchaseDeltas,
    distribution:first.adapted.distribution};
  calculateMethod(input,'simplified',basis);
  const again=calculateMethod(input,'regular',basis);
  assert.deepEqual(again.adapted.annualTax,first.adapted.annualTax);
  assert.deepEqual(again.calculated.rows,first.calculated.rows);
  assert.deepEqual(again.model.cases,first.model.cases);
});

test('SW08/09 参考額・手入力の基準と月別額は方式切替で変更しない',()=>{
  const src=source('renderCashflow');
  assert.match(src,/transactionBasis=step4TransactionBasis\?\.key === transactionKey/);
  assert.match(src,/cashflowAutoPlan\(calc,comparison,proxySelect\.value\)/);
  assert.doesNotMatch(src,/cashManualRows\s*=/);
  assert.doesNotMatch(src,/cashActualMode\s*=/);
  const input=fixture();
  const regular=calculateMethod(input,'regular');
  const simplified=calculateMethod(input,'simplified');
  const a=new Map(regular.model.baseSource.months.map(item=>[item.month,item.base]));
  const b=new Map(simplified.model.baseSource.months.map(item=>[item.month,item.base]));
  for(const month of new Set([...a.keys(),...b.keys()])) assert.equal(a.get(month)||0,b.get(month)||0,month);
});

test('SW10 自動中間納付の前期代理方式は現在表示方式に連動しない',()=>{
  const src=source('renderCashflow');
  assert.match(src,/if\(!chosen\.includes\(proxySelect\.value\)\) proxySelect\.value=chosen\.includes\(calc\.ctx\.currentReturnMethod\)/);
  assert.match(src,/cashflowAutoPlan\(calc,comparison,proxySelect\.value\)/);
  assert.doesNotMatch(src,/cashflowAutoPlan\(calc,comparison,methodKey\)/);
});

test('SW12 未算定と適用不可を0円年税額の完成グラフにしない',()=>{
  for(const invalid of ['missing','ineligible']){
    const input=fixture();
    if(invalid==='missing') input.comparison.rows[1].proposalAmount=null;
    else input.comparison.rows[1].proposalMethod.eligibility='ineligible';
    const result=adapter.create({...input,methodKey:'simplified'});
    assert.equal(result.annualTax.status,'unavailable');
    assert.equal(result.annualTax.changed,null);
    if(invalid==='ineligible') assert.equal(result.ready,false);
  }
  assert.match(source('renderCashflow'),/if\(!adapter\.ready \|\| adapter\.annualTax\.status === 'unavailable'\)/);
  assert.match(source('renderCashflow'),/data-cashflow-step3/);
});

test('SW13/15 画面・帳票は選択方式を示し、狭幅はボタン折返しと表スクロール',()=>{
  const result=calculateMethod(fixture(),'regular');
  const rendered=view.renderCashflowPanelHtml(result.model,{width:390});
  assert.match(rendered,/cf-staircase-view/);
  assert.match(rendered,/現行8％・regular/);
  assert.match(rendered,/食品1％・regular/);
  assert.match(html,/@media\(max-width:390px\)\{\.step4-method-buttons button\{flex:1 1 100%/);
  assert.match(html,/\.cashflow-panel-heading \.step4-method-buttons button\{flex:1 1 calc\(50% - 7px\)/);
  assert.match(view.styles,/overflow-x:auto|overflow:auto/);
  assert.match(source('cashflowExportText'),/食品1％による資金繰りへの影響（\$\{methodLabel\}）/);
  assert.match(source('cashflowCsvText'),/食品1％による資金繰りへの影響（\$\{methodLabel\}）/);
  assert.match(source('renderCashflow'),/cashflowPrintReport'\)\.innerHTML = `<h1>食品1％による資金繰りへの影響（\$\{escapeHtml\(methodLabel\)\}）/);
});

test('SW14 選択方式を保存し、STEP3比較対象から外れた保存値は再選択',()=>{
  assert.match(source('saveState'),/step4DisplayTaxMethod:typeof step4DisplayTaxMethod/);
  assert.match(source('restoreState'),/savedMethods\.includes\(data\.step4DisplayTaxMethod\)/);
  const context=vm.createContext({});
  vm.runInContext(`let step4DisplayTaxMethod='';\n${source('resolveStep4DisplayMethod')}`,context);
  const calc={ctx:{currentReturnMethod:'regular'}};
  assert.equal(context.resolveStep4DisplayMethod(calc,['regular','simplified']),'regular');
  vm.runInContext("step4DisplayTaxMethod='simplified'",context);
  assert.equal(context.resolveStep4DisplayMethod(calc,['regular','simplified']),'simplified');
  assert.equal(context.resolveStep4DisplayMethod(calc,['regular']),'regular');
});
