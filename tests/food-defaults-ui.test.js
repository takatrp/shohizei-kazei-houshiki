'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rows = require('../tax-entry-rows.js');
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,name);
  const end = html.indexOf('\nfunction ',start+1);
  return html.slice(start,end < 0 ? undefined : end);
}
function fixture(){
  const controls = new Map();
  const element = id => {
    if(!controls.has(id)) controls.set(id,{value:'confirmed',querySelector:() => null});
    return controls.get(id);
  };
  const context = vm.createContext({
    $:element,entryMode:'rows',showFoodAmountColumn:() => true,
    ShohizeiTaxEntryRows:rows,TAX_ROW_CODES:rows.CODE_DETAILS,
    taxEntryRows:{sales:[rows.createTaxEntryRow('sales',{
      id:'sale',code:'1',businessType:'type2',rate:'8',amount:'108000',source:'csv'
    })],purchases:[]},
    importedCsvOrigin:{manualChanged:false},
    document:{activeElement:null},
    formatInput:value => String(value),
    taxRowChoiceNumber:value => value,taxRowRateValue:value => value,
    updateAutomaticRowRatios(){},refreshTaxRowControls(){}
  });
  vm.runInContext(['updateAutomaticFoodAmounts','applyTaxRowEdit'].map(source).join('\n'),context);
  context.update = () => context.updateAutomaticFoodAmounts();
  const input = (field,value) => ({dataset:{rowSide:'sales',rowKey:'sale',rowField:field},value,closest:() => null});
  return {context,element,input,row:() => context.taxEntryRows.sales[0]};
}

test('食品既定UI: CSV行の初期補完で元帳の金額出典を変更せず食品分類を自動確認しない',()=>{
  const h=fixture();
  h.context.update();
  assert.equal(h.row().foodAmount,'108000');
  assert.equal(h.row().foodAmountSource,'auto');
  assert.equal(h.row().source,'csv');
  assert.equal(h.context.importedCsvOrigin.manualChanged,false);
  assert.equal(h.element('proposalFoodClassificationState').value,'unknown');
  h.element('proposalFoodClassificationState').value='confirmed';
  h.context.update();
  assert.equal(h.element('proposalFoodClassificationState').value,'confirmed','同額の再計算だけでは確認状態を変えない');
});

test('食品既定UI: 食品欄の通過だけでは自動追従を解除せず、明示入力した同じ0円は保持',()=>{
  const h=fixture();
  h.context.update();
  h.context.applyTaxRowEdit(h.input('foodAmount','108000'));
  assert.equal(h.row().foodAmountSource,'auto');
  h.context.applyTaxRowEdit(h.input('amount','0'),true);
  assert.equal(h.row().foodAmount,'0');
  h.context.applyTaxRowEdit(h.input('foodAmount','0'),true);
  assert.equal(h.row().foodAmountSource,'manual');
  h.context.applyTaxRowEdit(h.input('amount','216000'),true);
  assert.equal(h.row().foodAmount,'0');
});

test('食品既定UI: 対象額の手修正・意図的な空欄を再計算やシナリオ切替で上書きしない',()=>{
  for(const value of ['54000','']){
    const h=fixture();
    h.context.update();
    h.context.applyTaxRowEdit(h.input('foodAmount',value),true);
    assert.equal(h.row().source,'csv');
    assert.equal(h.context.importedCsvOrigin.manualChanged,false);
    h.context.showFoodAmountColumn=() => false;
    h.context.applyTaxRowEdit(h.input('amount','216000'),true);
    h.context.showFoodAmountColumn=() => true;
    h.context.update();
    assert.equal(h.row().foodAmount,value);
    assert.equal(h.row().foodAmountSource,'manual');
  }
});

test('食品既定UI: 現行税率中は補完せず、食品シナリオ選択で未修正額だけを補完',()=>{
  const h=fixture();
  h.context.showFoodAmountColumn=() => false;
  h.context.update();
  assert.equal(h.row().foodAmount,'');
  h.context.showFoodAmountColumn=() => true;
  h.context.update();
  assert.equal(h.row().foodAmount,'108000');
  h.context.applyTaxRowEdit(h.input('rate','10'),true);
  assert.equal(h.row().foodAmount,'');
  h.context.applyTaxRowEdit(h.input('rate','8'),true);
  assert.equal(h.row().foodAmount,'108000');
});

test('食品既定UI: 通常の更新が集計より前に補完し、入力イベントだけに明示入力を伝える',()=>{
  const update=source('update');
  assert.ok(update.indexOf('updateAutomaticFoodAmounts();') < update.indexOf('syncTaxEntryRows();'));
  const bind=source('bindTaxEntryRows');
  assert.match(bind,/addEventListener\('input'[\s\S]*?applyTaxRowEdit\(event.target, true\)/);
  assert.match(bind,/addEventListener\('blur'[\s\S]*?applyTaxRowEdit\(event.target\)/);
});

test('食品既定UI: 国内仕入を輸入区分へ変更したら国内食品の内数を残さない',()=>{
  for(const code of ['55','65','75']){
    const h=fixture();
    h.context.taxEntryRows.purchases=[rows.createTaxEntryRow('purchases',{
      id:'purchase',code:'5',rate:'8',amount:'108000'
    })];
    h.context.update();
    assert.equal(h.context.taxEntryRows.purchases[0].foodAmount,'108000');
    const input={dataset:{rowSide:'purchases',rowKey:'purchase',rowField:'code'},value:code,closest:() => null};
    h.context.applyTaxRowEdit(input,true);
    assert.equal(h.context.taxEntryRows.purchases[0].rate,'8');
    assert.equal(h.context.taxEntryRows.purchases[0].foodAmount,'');
    assert.equal(h.context.taxEntryRows.purchases[0].foodAmountSource,'');
  }
});
