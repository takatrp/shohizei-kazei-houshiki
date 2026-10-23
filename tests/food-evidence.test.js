'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createTaxEntryRow, foodTargetEvidence, aggregateTaxRows} = require('../tax-entry-rows.js');

const sale = overrides => createTaxEntryRow('sales', {
  code:'1', businessType:'type2', rate:'8', amount:'108,000', foodAmount:'108,000', ...overrides
});
const purchase = overrides => createTaxEntryRow('purchases', {
  code:'5', rate:'8', amount:'108,000', foodAmount:'108,000', ...overrides
});

test('食品根拠: 事業区分未分類の軽減8％売上も「対象なし」と矛盾する対象額に含める', () => {
  const rows = [sale({businessType:''})];
  const aggregate = aggregateTaxRows({sales:rows});
  assert.equal(aggregate.fields.type2SaleFood1.value, 0, '従来の第1〜6種欄だけでは未分類の食品売上を拾えない');
  const evidence = foodTargetEvidence(rows, 'sales');
  assert.equal(evidence.targetPresent, true);
  assert.equal(evidence.targetEntered, true);
  assert.equal(evidence.available, true);
  assert.equal(evidence.states[0].target.value, 108000);
});

test('食品根拠: 売上返還等と負額調整を元の符号で読み、相殺後0円でも食品対象の存在を消さない', () => {
  for(const adjustment of [
    sale({code:'11', amount:'108,000', foodAmount:'108,000'}),
    sale({code:'1', amount:'-108,000', foodAmount:'-108,000'})
  ]){
    const rows = [sale(), adjustment];
    const aggregate = aggregateTaxRows({sales:rows});
    assert.equal(aggregate.fields.type2SaleFood1.value, 0);
    const evidence = foodTargetEvidence(rows, 'sales');
    assert.equal(evidence.targetPresent, true);
    assert.equal(evidence.valid, true);
    assert.equal(evidence.states[1].target.value, adjustment.code === '11' ? 108000 : -108000,
      '課税区分11の符号反転は集計側に任せ、根拠の読み取りで重複反転しない');
    const adjustmentOnly = foodTargetEvidence([adjustment], 'sales');
    assert.equal(adjustmentOnly.targetPresent, true);
    assert.equal(adjustmentOnly.available, true);
  }
});

test('食品根拠: 空欄と明示0円を区別し、どちらも食品対象の存在・照合済みに自動昇格しない', () => {
  for(const foodAmount of ['', '   ', undefined]){
    const evidence = foodTargetEvidence([sale({foodAmount})], 'sales');
    assert.equal(evidence.targetEntered, false);
    assert.equal(evidence.targetPresent, false);
    assert.equal(evidence.valid, true);
    assert.equal(evidence.available, false);
    assert.equal(Object.hasOwn(evidence, 'confirmed'), false);
  }
  for(const foodAmount of ['0', 0, '-0']){
    const evidence = foodTargetEvidence([sale({foodAmount,foodAmountSource:'manual'})], 'sales');
    assert.equal(evidence.targetEntered, true);
    assert.equal(evidence.targetPresent, false);
    assert.equal(evidence.available, true, '明示0円は利用者が照合できる根拠であり、照合済み自体ではない');
    assert.equal(Object.hasOwn(evidence, 'confirmed'), false);
  }
  assert.equal(foodTargetEvidence([], 'sales').available, false);
  assert.equal(foodTargetEvidence([sale({amount:'',foodAmount:'0'})], 'sales').available, false,
    '元金額未入力の食品0円だけでは照合根拠にしない');
});

test('食品根拠: 不正数値・内数超過・符号不一致を有効な対象額として扱わない', () => {
  const invalidRows = [
    sale({amount:'要確認'}), sale({foodAmount:'要確認'}),
    sale({amount:'',foodAmount:'108,000'}), sale({foodAmount:'108,001'}),
    sale({foodAmount:'-10,800'}), sale({amount:'-108,000',foodAmount:'10,800'})
  ];
  for(const row of invalidRows){
    const evidence = foodTargetEvidence([row], 'sales');
    assert.equal(evidence.valid, false);
    assert.equal(evidence.available, false);
    assert.equal(evidence.targetPresent, false);
    assert.equal(evidence.targetEntered, true);
  }
  const mixed = foodTargetEvidence([sale(), sale({foodAmount:'要確認'})], 'sales');
  assert.equal(mixed.targetPresent, true, '別行の妥当な対象額の存在は不正行によって消さない');
  assert.equal(mixed.available, false, '不正行を含む一式を照合可能にはしない');
});

test('食品根拠: 全6仕入区分の正負を含め、控除割合未確認でも食品対象の存在は保持する', () => {
  for(const code of ['5','6','7','52','62','72']){
    for(const sign of ['', '-']){
      const evidence = foodTargetEvidence([purchase({
        code, amount:`${sign}108,000`, foodAmount:`${sign}54,000`, creditRatio:''
      })], 'purchases');
      assert.equal(evidence.targetPresent, true, `課税区分${code}の食品対象を見落とさない`);
      assert.equal(evidence.available, true);
      assert.equal(evidence.states[0].target.value, sign ? -54000 : 54000);
    }
  }
  const offset = foodTargetEvidence([
    purchase(), purchase({amount:'-108,000',foodAmount:'-108,000'})
  ], 'purchases');
  assert.equal(offset.targetPresent, true);
});

test('食品根拠: 10％・非課税・輸入・不明区分・逆側区分を国内軽減8％の根拠へ混入しない', () => {
  const sales = [
    sale({rate:'10'}), sale({rate:'1'}), sale({rate:''}), sale({code:'3'}),
    sale({code:'99'}), sale({code:'5'}), sale({code:''})
  ];
  const purchases = [
    purchase({rate:'10'}), purchase({rate:'1'}), purchase({rate:''}),
    purchase({code:'55'}), purchase({code:'65'}), purchase({code:'75'}),
    purchase({code:'99'}), purchase({code:'1'}), purchase({code:''})
  ];
  for(const [side, rows] of [['sales',sales],['purchases',purchases]]){
    const evidence = foodTargetEvidence(rows, side);
    assert.deepEqual(evidence.states, []);
    assert.equal(evidence.targetPresent, false);
    assert.equal(evidence.targetEntered, false);
    assert.equal(evidence.available, false);
  }
});

test('食品根拠: CSV明示1％をsidecarから側別に読み、負額・相殺・0円・空欄・不正値を区別する', () => {
  const entries = [
    {kind:'sale', amount:10100, transactionKind:'ordinary'},
    {kind:'sale', amount:-10100, transactionKind:'adjustment'},
    {kind:'invoicePurchase', amount:-1010, transactionKind:'adjustment'},
    {kind:'exemptPurchase', amount:2020, transactionKind:'ordinary', creditRatio:'70'},
    {kind:'unrecognized', amount:999999}
  ];
  const sales = foodTargetEvidence([], 'sales', {actualOnePercentEntries:entries});
  assert.equal(sales.actualEntryCount, 2);
  assert.equal(sales.targetPresent, true);
  assert.equal(sales.available, true);
  assert.deepEqual(sales.actualEntries, entries.slice(0,2));
  const purchases = foodTargetEvidence([], 'purchases', {actualOnePercentEntries:entries});
  assert.equal(purchases.actualEntryCount, 2);
  assert.equal(purchases.targetPresent, true);
  assert.equal(purchases.available, true);
  assert.deepEqual(purchases.actualEntries, entries.slice(2,4));
  for(const kind of ['sale','invoicePurchase','exemptPurchase']){
    const side = kind === 'sale' ? 'sales' : 'purchases';
    const get = amount => foodTargetEvidence([], side, {actualOnePercentEntries:[{kind,amount}]});
    assert.equal(get(-1010).targetPresent, true);
    assert.equal(get(0).targetPresent, false);
    assert.equal(get(0).targetEntered, true);
    assert.equal(get(0).available, true);
    assert.equal(get('').targetEntered, false);
    assert.equal(get('').available, false);
    assert.equal(get('不正').valid, false);
    assert.equal(get('不正').available, false);
    assert.equal(get('不正').targetPresent, false);
  }
});

test('食品根拠: 既定入力・手修正・CSV出典と負額を変更せず、確認状態を作らない', () => {
  const rows = [sale({
    amount:'-10,800',foodAmount:'-5,400',foodAmountSource:'auto',source:'csv',
    csvKey:'sale-8-unclassified',businessType:'',date:'2027-04-01',confirmed:false
  })];
  const entries = [{kind:'sale',amount:-1010,transactionKind:'adjustment',date:'2027-04-01',sourceRow:42}];
  const originalRows = structuredClone(rows);
  const originalEntries = structuredClone(entries);
  Object.freeze(rows[0]);
  Object.freeze(rows);
  Object.freeze(entries[0]);
  Object.freeze(entries);
  const evidence = foodTargetEvidence(rows, 'sales', {actualOnePercentEntries:entries});
  assert.equal(evidence.targetPresent, true);
  assert.equal(evidence.available, true);
  assert.equal(Object.hasOwn(evidence, 'confirmed'), false);
  assert.deepEqual(rows, originalRows);
  assert.deepEqual(entries, originalEntries);
  assert.equal(evidence.states[0].amount.value, -10800);
  assert.equal(evidence.states[0].target.value, -5400);
});
