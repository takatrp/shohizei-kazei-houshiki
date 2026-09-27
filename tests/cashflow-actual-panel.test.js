const test=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../cashflow-engine.js');
const {buildPanelData}=require('../cashflow-panel-data.js');
const view=require('../cashflow-panel-view.js');

function actual(months,commonDelta={}){
  return {status:'complete',selectedAccounts:['現金','普通預金'],
    sourcePeriod:{start:'2026-01-01',end:'2026-02-28'},periodMapped:true,
    months:months.map((month,index)=>({month,sourceMonth:`2026-0${index+1}`,gross:index?200000:100000,
      excludedOpening:0,excludedTax:0,base:index?200000:100000,entryCount:1})),commonDelta};
}
function panel(mode,food=false){
  const rate=mode==='rateImpact';
  const interim={status:'none'};
  const calculated=engine.calculate({periodStart:'2027-01',periodEnd:'2027-02',
    salesDeltas:rate?[{month:'2027-01',amount:-10000}]:[],purchaseDeltas:[],
    annualTax:{base:20000,changed:10000},interim,settlementMonth:'2027-03'});
  const delta=food?{'2027-01':-10000}:{};
  const base=actual(['2027-01','2027-02'],delta);
  const baselineFlows=base.months.map(row=>({month:row.month,amount:row.base+(delta[row.month]||0)}));
  return {calculated,model:buildPanelData({engine:calculated,mode,interim,
    adapter:{annualTax:{base:20000,changed:10000}},baselineFlows,actualCash:base})};
}

test('MCF09 税率変更は C と C+D に同じ月軸の税イベントを載せる',()=>{
  const {calculated,model}=panel('rateImpact');
  assert.equal(model.status.integrity,'ok');
  assert.equal(model.cases.A.rows[0].flow,100000);
  assert.equal(model.cases.B.rows[0].flow,90000);
  assert.equal(model.cases.A.rows[2].events[0].amount,20000);
  assert.equal(model.cases.B.rows[2].events[0].amount,10000);
  model.expectedDiff.forEach((row,index)=>assert.equal(model.cases.B.rows[index].monthTotal-model.cases.A.rows[index].monthTotal,calculated.rows[index].net));
});
test('MCF10 方式比較・現行制度は共通Cと案別税金だけを用いる',()=>{
  const {calculated,model}=panel('methodImpact');
  assert.equal(model.cases.A.rows[0].flow,100000);
  assert.equal(model.cases.B.rows[0].flow,100000);
  assert.equal(model.cases.B.rows[2].monthTotal-model.cases.A.rows[2].monthTotal,10000);
  assert.equal(model.expectedDiff.at(-1).cumulative,calculated.finalCumulative);
});
test('MCF11 方式比較・食品1％は食品取引差DをA/B共通額に加え方式差を変えない',()=>{
  const {calculated,model}=panel('methodImpact',true);
  assert.equal(model.cases.A.rows[0].flow,90000);
  assert.equal(model.cases.B.rows[0].flow,90000);
  assert.equal(model.actualCash.commonDelta['2027-01'],-10000);
  assert.equal(model.expectedDiff.at(-1).cumulative,calculated.finalCumulative);
  const html=view.renderCashflowPanelHtml(model,{width:900});
  assert.match(html,/CSV実績の月別資金増減/);
  assert.match(html,/食品1％取引差（両案共通）/);
});
test('MCF16 全月のB−Aは円単位で既存STEP4月次・累積に一致し、1円差でも止める',()=>{
  const {calculated,model}=panel('rateImpact');
  model.expectedDiff.forEach((row,index)=>{
    assert.equal(model.cases.B.rows[index].monthTotal-model.cases.A.rows[index].monthTotal,calculated.rows[index].net);
    assert.equal(model.cases.B.rows[index].cumulative-model.cases.A.rows[index].cumulative,calculated.rows[index].cumulative);
  });
  const altered=structuredClone(model);altered.expectedDiff[0].monthTotal+=1;
  assert.match(view.renderCashflowPanelHtml(altered),/内部整合エラー/);
});
test('未確認のCSV現預金実績はA/B完成図にせず、従来の表示用参考額モードを残す',()=>{
  const {calculated}=panel('rateImpact');
  const waiting=buildPanelData({engine:calculated,mode:'rateImpact',actualCash:{status:'unconfirmed',reason:'資金科目が未確認です。'}});
  assert.equal(waiting.status.renderable,false);
  assert.match(view.renderCashflowPanelHtml(waiting),/未算定/);
  const reference=buildPanelData({engine:calculated,mode:'rateImpact',baselineFlows:[{month:'2027-01',amount:100000}]});
  assert.equal(reference.status.renderable,true);
  assert.equal(reference.actualCash,null);
});
test('CSV主グラフは共通棒とA/Bイベントレーン、印刷も同じ数値',()=>{
  const {model}=panel('rateImpact');
  const screen=view.renderCashflowPanelHtml(model,{width:390});
  const print=view.renderCashflowPanelHtml(model,{print:true,width:680});
  for(const html of [screen,print]){
    assert.match(html,/cf-actual-bar/);
    assert.match(html,/A案税金/);
    assert.match(html,/B案税金/);
    assert.match(html,/CSV実績の月別資金増減（共通）/);
    assert.match(html,/20/);
  }
});
