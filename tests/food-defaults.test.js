'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyFoodAmountDefaults,
  createTaxEntryRow,
  aggregateTaxRows,
  aggregateScenarioPurchases
} = require('../tax-entry-rows.js');

const sale = overrides => createTaxEntryRow('sales', {
  code:'1', businessType:'type2', rate:'8', amount:'108,000', ...overrides
});
const purchase = overrides => createTaxEntryRow('purchases', {
  code:'5', rate:'8', amount:'108,000', ...overrides
});
const withoutFoodDefaults = ({foodAmount, foodAmountSource, ...rest}) => rest;

test('食品既定値: 売上・返還等と全6仕入用途の軽減8％税込額を100％対象とする', () => {
  const sales = [sale(), sale({code:'11', amount:'10,800'})];
  const purchases = ['5','6','7','52','62','72'].map((code, index) => purchase({
    code, amount:String(10800 * (index + 1)), creditRatio:code.length === 2 ? '70' : ''
  }));
  for(const [side, rows] of [['sales',sales],['purchases',purchases]]){
    const result = applyFoodAmountDefaults(rows, side);
    assert.equal(result.changedCount, rows.length);
    assert.deepEqual(result.rows.map(row => row.foodAmount), rows.map(row => row.amount));
    assert.ok(result.rows.every(row => row.foodAmountSource === 'auto'));
    assert.deepEqual(result.rows.map(withoutFoodDefaults), rows.map(withoutFoodDefaults),
      '税率・用途・控除割合・元の税込額を変更せず、食品の内数だけを設定する');
  }
});

test('食品既定値: 10％・明示1％・非課税・輸入・逆側区分・未確認は補完しない', () => {
  const sales = [
    sale({rate:'10'}), sale({rate:'1'}), sale({rate:''}), sale({rate:'9'}),
    sale({code:'3'}), sale({code:'5'}), sale({code:''}), sale({code:'99'})
  ];
  const purchases = [
    purchase({rate:'10'}), purchase({rate:'1'}), purchase({rate:''}),
    purchase({code:'55', importComponent:'goods'}),
    purchase({code:'65', importComponent:'national'}),
    purchase({code:'75', importComponent:'taxTotal'}),
    purchase({code:'1'}), purchase({code:''}), purchase({code:'99'})
  ];
  for(const [side, rows] of [['sales',sales],['purchases',purchases]]){
    const original = structuredClone(rows);
    const result = applyFoodAmountDefaults(rows, side);
    assert.equal(result.changedCount, 0);
    assert.deepEqual(result.rows, original);
  }
});

test('食品既定値: 金額未入力・不正額を既定0円にせず、明示0円だけを補完する', () => {
  const rows = ['', '   ', '確認中', '1,0x0'].map(amount => purchase({amount}));
  const result = applyFoodAmountDefaults([...rows, purchase({amount:'0'})], 'purchases');
  assert.equal(result.changedCount, 1);
  assert.deepEqual(result.rows.slice(0, rows.length), rows);
  assert.equal(result.rows.at(-1).foodAmount, '0');
  assert.equal(result.rows.at(-1).foodAmountSource, 'auto');
  const aggregate = aggregateTaxRows({purchases:[result.rows.at(-1)]});
  assert.equal(aggregate.fields.purchaseFood1.entered, true);
  assert.equal(aggregate.fields.purchaseFood1.value, 0);
});

test('食品既定値: 手修正した部分額・明示0円・意図的な空欄は金額変更後も保持する', () => {
  for(const side of ['sales','purchases']){
    const make = side === 'sales' ? sale : purchase;
    const rows = ['54,000','0',''].map(foodAmount => make({foodAmount,foodAmountSource:'manual'}));
    const first = applyFoodAmountDefaults(rows, side);
    assert.equal(first.changedCount, 0);
    assert.deepEqual(first.rows, rows);
    const edited = first.rows.map(row => ({...row, amount:'216,000'}));
    const next = applyFoodAmountDefaults(edited, side);
    assert.equal(next.changedCount, 0);
    assert.deepEqual(next.rows, edited);
  }
});

test('食品既定値: 出典項目のない旧保存の非空欄を既定値で上書きしない', () => {
  const rows = ['27,000','0',0,'要確認'].map(foodAmount => {
    const row = purchase({foodAmount});
    delete row.foodAmountSource;
    return row;
  });
  const first = applyFoodAmountDefaults(rows, 'purchases');
  assert.deepEqual(first.rows.map(row => row.foodAmount), rows.map(row => row.foodAmount));
  assert.ok(first.rows.every(row => row.foodAmountSource !== 'auto'));
  const second = applyFoodAmountDefaults(first.rows.map(row => ({...row,amount:'216,000'})), 'purchases');
  assert.deepEqual(second.rows.map(row => row.foodAmount), rows.map(row => row.foodAmount));
});

test('食品既定値: autoの額は税込金額に追従し、0円・負額も元の符号で保持する', () => {
  let rows = applyFoodAmountDefaults([purchase()], 'purchases').rows;
  for(const amount of ['216,000','0','-10,800']){
    const result = applyFoodAmountDefaults(rows.map(row => ({...row,amount})), 'purchases');
    assert.equal(result.changedCount, 1);
    assert.equal(result.rows[0].foodAmount, amount);
    assert.equal(result.rows[0].foodAmountSource, 'auto');
    rows = result.rows;
  }
});

test('食品既定値: autoの元金額を削除・不正入力したら古い食品額を消し、再入力で復帰する', () => {
  for(const amount of ['', '不正']){
    const rows = [purchase({amount,foodAmount:'108,000',foodAmountSource:'auto'})];
    const cleared = applyFoodAmountDefaults(rows, 'purchases');
    assert.equal(cleared.changedCount, 1);
    assert.equal(cleared.rows[0].foodAmount, '');
    assert.equal(cleared.rows[0].foodAmountSource, 'auto');
    assert.equal(applyFoodAmountDefaults(cleared.rows, 'purchases').changedCount, 0);
    const restored = applyFoodAmountDefaults(cleared.rows.map(row => ({...row,amount:'21,600'})), 'purchases');
    assert.equal(restored.rows[0].foodAmount, '21,600');
    assert.equal(restored.rows[0].foodAmountSource, 'auto');
  }
  const manual = purchase({amount:'不正',foodAmount:'54,000',foodAmountSource:'manual'});
  assert.deepEqual(applyFoodAmountDefaults([manual], 'purchases').rows, [manual]);
});

test('食品既定値: 負の仕入調整と区分11の符号を集計に渡し、返品を二重反転しない', () => {
  const sales = applyFoodAmountDefaults([
    sale(), sale({code:'11',amount:'10,800'}), sale({code:'11',amount:'-1,080'})
  ], 'sales').rows;
  const purchases = applyFoodAmountDefaults([
    purchase({amount:'21,600'}), purchase({amount:'-10,800'})
  ], 'purchases').rows;
  assert.deepEqual(sales.map(row => row.foodAmount), ['108,000','10,800','-1,080']);
  assert.deepEqual(purchases.map(row => row.foodAmount), ['21,600','-10,800']);
  const aggregate = aggregateTaxRows({sales,purchases});
  assert.equal(aggregate.ready, true);
  assert.equal(aggregate.fields.type2Sale8.value, 98280);
  assert.equal(aggregate.fields.type2SaleFood1.value, 98280);
  assert.equal(aggregate.fields.purchase8.value, 10800);
  assert.equal(aggregate.fields.purchaseFood1.value, 10800);
});

test('食品既定値: CSV由来・手修正区分・取引日・控除割合などの出典を変更しない', () => {
  const rows = ['csv','csv-edited'].map((source, index) => purchase({
    id:`csv-52-${index}`, code:'52', source, creditRatio:'70', creditRatioSource:'manual',
    sourceDateStart:'2027-10-01', sourceDateEnd:'2027-12-31',
    sourceAdjustmentCount:2, sourceDateUnknownCount:0, sourceCount:7,
    sourceRow:12, customProvenance:{fileKey:'fixture',month:'2027-10'}
  }));
  const original = structuredClone(rows);
  const result = applyFoodAmountDefaults(rows, 'purchases');
  assert.deepEqual(result.rows.map(withoutFoodDefaults), original.map(withoutFoodDefaults));
  assert.deepEqual(rows, original, '返却値を採用する前に元行を変更しない');
});

test('食品既定値: 再計算は冪等で、追加された行だけに既定値を入れる', () => {
  const first = applyFoodAmountDefaults([sale()], 'sales');
  const again = applyFoodAmountDefaults(first.rows, 'sales');
  assert.equal(again.changedCount, 0);
  assert.deepEqual(again.rows, first.rows);
  const added = applyFoodAmountDefaults([...again.rows,sale({amount:'21,600'})], 'sales');
  assert.equal(added.changedCount, 1);
  assert.deepEqual(added.rows.map(row => row.foodAmount), ['108,000','21,600']);
});

test('食品既定値: CSV明示1％実績は8％の予測内数に混ぜず、一度だけ別集計する', () => {
  const actualEntries = [{kind:'invoicePurchase',usage:'common',amount:10100}];
  const originalActual = structuredClone(actualEntries);
  const purchases = applyFoodAmountDefaults([purchase({amount:'108000',source:'csv'})], 'purchases').rows;
  const aggregate = aggregateScenarioPurchases({purchases,actualOnePercentEntries:actualEntries}, {
    taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1,foodPurchasePriceBasis:'netFixed'
  });
  assert.equal(purchases[0].foodAmount, '108000');
  assert.equal(aggregate.complete, true);
  assert.ok(Math.abs(aggregate.totalCreditableTax - 1100) < 1e-7);
  assert.deepEqual(actualEntries, originalActual);
});
