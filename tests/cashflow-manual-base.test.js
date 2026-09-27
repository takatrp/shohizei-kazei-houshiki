const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const cashflow=require('../cashflow-engine.js');
const {parseManualThousand,buildManualBase,buildPanelData}=require('../cashflow-panel-data.js');
const view=require('../cashflow-panel-view.js');

const page=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');

function fixture(source){
  const interim={status:'auto',base:[{month:'2027-02',amount:7000}],changed:[{month:'2027-02',amount:7000}]};
  const calculated=cashflow.calculate({periodStart:'2027-01',periodEnd:'2027-02',
    salesDeltas:[{month:'2027-01',amount:-1000}],purchaseDeltas:[],
    annualTax:{base:10000,changed:-2000},interim,settlementMonth:'2027-03',refundMonth:'2027-04'});
  const common={engine:calculated,mode:'rateImpact',interim,
    adapter:{annualTax:{base:10000,changed:-2000}},baseSource:{kind:source}};
  if(source==='manual'){
    const manual=buildManualBase('2027-01-01','2027-02-28','2027-01-01|2027-02-28',{'2027-01':'250','2027-02':'-120'});
    return {calculated,model:buildPanelData({...common,baselineFlows:manual.months})};
  }
  // Reference basis is the existing display-only r35 flow; this fixture
  // supplies its deterministic output rather than changing that provider.
  return {calculated,model:buildPanelData({...common,baselineFlows:[{month:'2027-01',amount:100000},{month:'2027-02',amount:200000}]})};
}

test('UI01-02 初期選択は参考額で、CSV実績は試験機能の折りたたみ内',()=>{
  assert.match(page,/<input type="radio" name="cashActualMode" value="reference" checked>/);
  assert.match(page,/<input type="radio" name="cashActualMode" value="manual">/);
  assert.match(page,/<details id="cashActualExperimental"[^>]*>[\s\S]*?<input type="radio" name="cashActualMode" value="csv">/);
});

test('UI11 千円入力は符号・明示0・1円精度を保持し、空欄を0円にしない',()=>{
  assert.equal(parseManualThousand('250'),250000);
  assert.equal(parseManualThousand('-120.001'),-120001);
  assert.equal(parseManualThousand('0'),0);
  assert.equal(parseManualThousand('0.001'),1);
  assert.equal(parseManualThousand(''),null);
  assert.throws(()=>parseManualThousand('0.0001'),/小数第3位/);
  assert.throws(()=>parseManualThousand('9007199254741'),/整数円/);
  const missing=buildManualBase('2027-01-01','2027-02-28','2027-01-01|2027-02-28',{'2027-01':'0'});
  assert.equal(missing.status,'unconfirmed');
  assert.match(missing.reason,/2027-02.*未入力/);
  const complete=buildManualBase('2027-01-01','2027-02-28','2027-01-01|2027-02-28',{'2027-01':'0','2027-02':'-1.001'});
  assert.deepEqual(complete.months,[{month:'2027-01',amount:0},{month:'2027-02',amount:-1001}]);
});

test('UI03-10 参考額と手入力は同じ構造・税イベント・B−Aで、Cだけ変更する',()=>{
  const reference=fixture('reference'),manual=fixture('manual');
  for(const {calculated,model} of [reference,manual]){
    assert.equal(model.status.renderable,true);
    assert.equal(model.status.integrity,'ok');
    assert.deepEqual(model.months,reference.model.months);
    model.months.forEach((month,index)=>{
      assert.equal(model.cases.B.rows[index].monthTotal-model.cases.A.rows[index].monthTotal,calculated.rows[index].net,month);
      assert.equal(model.cases.B.rows[index].cumulative-model.cases.A.rows[index].cumulative,calculated.rows[index].cumulative,month);
    });
  }
  for(const key of ['A','B'])
    assert.deepEqual(manual.model.cases[key].rows.map(row=>row.events),reference.model.cases[key].rows.map(row=>row.events));
  assert.equal(manual.model.cases.A.rows[0].monthTotal-reference.model.cases.A.rows[0].monthTotal,150000);
  assert.equal(manual.model.cases.B.rows[0].monthTotal-reference.model.cases.B.rows[0].monthTotal,150000);
  assert.equal(manual.model.cases.A.rows[1].monthTotal-reference.model.cases.A.rows[1].monthTotal,-320000);
  const refHtml=view.renderCashflowPanelHtml(reference.model,{width:680});
  const manualHtml=view.renderCashflowPanelHtml(manual.model,{width:680});
  for(const html of [refHtml,manualHtml]){
    assert.match(html,/cf-shared-chart/);
    assert.match(html,/cf-shared-table/);
    assert.match(html,/A案\s*税金/);
    assert.match(html,/B案\s*税金/);
    assert.match(html,/A・B共通 中間納付/);
    assert.match(html,/差額（B−A）累積/);
  }
  assert.match(refHtml,/表示用参考額（共通ベース）/);
  assert.match(manualHtml,/手入力の月別資金増減（共通ベース）/);
});

test('対象期変更では同じ月が含まれていても旧手入力額を流用しない',()=>{
  const stale=buildManualBase('2027-02-01','2027-03-31','2027-01-01|2027-02-28',{'2027-02':'999'});
  assert.equal(stale.status,'unconfirmed');
  assert.match(stale.reason,/対象期が変更/);
  assert.deepEqual(stale.months,[]);
});

test('手入力の不足と内部不一致を区別し、B−Aを円単位で照合する',()=>{
  const {calculated}=fixture('manual');
  const missing=buildPanelData({engine:calculated,mode:'rateImpact',baseSource:{kind:'manual',status:'unconfirmed',reason:'2027-02が未入力'}});
  assert.equal(missing.status.renderable,false);
  assert.match(missing.status.reason,/未入力/);
  const tampered=structuredClone(calculated);
  tampered.rows[0].net+=1;
  const failed=buildPanelData({engine:tampered,mode:'rateImpact',baseSource:{kind:'manual'},baselineFlows:[{month:'2027-01',amount:0},{month:'2027-02',amount:0}]});
  assert.equal(failed.status.renderable,false);
  assert.equal(failed.status.integrity,'mismatch');
});
