'use strict';

// All amounts, dates and identifiers in this file are invented fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../tax-engine.js');
const {collectSalesScenario} = require('../sales-scenario.js');
const {aggregateTaxRows,aggregateScenarioPurchases} = require('../tax-entry-rows.js');

const close = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
const sum = (rows,key) => rows.reduce((total,row)=>total+Number(row[key]),0);
const options = {
  taxScenario:'foodProposal',foodForecastMethod:'manual',proposalFraction:1,
  foodSalesPriceBasis:'netFixed',foodPurchasePriceBasis:'netFixed',
  foodPeriodAmount:(_row,amount)=>amount
};
const frozen = value => {
  if(value && typeof value==='object'){
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
function fixture(side,{amount=9720,food=amount,foodSource='auto',monthly=false,...overrides}={}){
  const sales=side==='sales';
  const row={id:`synthetic-${side}`,code:sales?'1':'5',rate:'8',
    businessType:sales?'type2':'',creditRatio:'',amount:String(amount),foodAmount:String(food),
    foodAmountSource:foodSource,source:'csv',sourceAdjustmentCount:1,...overrides};
  const common={kind:side,code:row.code,rate:'8',businessType:row.businessType,
    usage:sales?'':'taxableOnly',creditRatio:row.creditRatio};
  const at = date => monthly?{month:date.slice(0,7)}:{date};
  const groups=[
    {...common,...at('2028-04-01'),amount:10800,transactionKind:'ordinary'},
    {...common,...at('2028-04-02'),amount:-1080,transactionKind:'adjustment'}
  ];
  return {row,groups};
}
function parts(row,side,groups){
  const before=structuredClone({row,groups});
  const result=engine.estimateCsvRowParts(frozen(row),{side,groups:frozen(groups)});
  assert.ok(Array.isArray(result.rows));
  assert.ok(Array.isArray(result.assumptions));
  assert.deepEqual({row,groups},before,'元行・匿名集計の金額、符号、区分、税率、日付を変更しない');
  return result;
}
const ordinary = result => result.rows.find(row=>row.transactionKind!=='adjustment' && Number(row.amount)>=0);
const adjustment = result => result.rows.find(row=>row.transactionKind==='adjustment' || Number(row.amount)<0);

test('概算継続：負の用途別仕入は個別・比例とも符号を保ち上限で潰さない',()=>{
  const input={salesTax:1000,purchaseTax:-80,taxableSales:10000,totalSales:20000,
    taxableOnlyTax:-80,commonTax:0,periodStart:'2028-01-01',periodEnd:'2028-12-31'};
  const individual=engine.calculateDetailedRegular({...input,method:'individual'});
  close(individual.regularCredit,-80);close(individual.amount,1080);
  const proportional=engine.calculateDetailedRegular({...input,method:'proportional'});
  close(proportional.regularCredit,-40);close(proportional.amount,1040);
  const mixed=engine.calculateDetailedRegular({...input,purchaseTax:20,taxableOnlyTax:100,commonTax:-80,method:'individual'});
  close(mixed.regularCredit,60);close(mixed.amount,940);
  const nonTaxableReturn=engine.calculateDetailedRegular({...input,purchaseTax:20,taxableOnlyTax:100,commonTax:0,nonTaxableOnlyTax:-80,method:'individual'});
  close(nonTaxableReturn.regularCredit,100);close(nonTaxableReturn.amount,900);
  for(const value of [individual,proportional,mixed,nonTaxableReturn])assert.match(value.assumptions.join(' '),/符号付き/);
});

test('概算継続：明示1％返品に既知の元8％・10％があれば双方のシナリオで優先する',()=>{
  for(const rate of [8,10])for(const taxScenario of ['current','foodProposal']){
    const amount=-(1000*(1+rate/100));
    const entry={kind:'sale',amount,ratePercent:1,transactionKind:'adjustment',originalRatePercent:rate,
      originalTaxableState:'taxable',businessType:'type2',date:'2028-05-01'};
    const before=structuredClone(entry);
    const sales=collectSalesScenario({actualOnePercentEntries:[entry]},{...options,taxScenario});
    close(sales.totalTax,-rate*10);close(sales.totalAmount,amount);
    close(sales.simplified.foodOnePercentTax,0);close(sales.simplified.amount,-rate*2);
    assert.match(sales.assumptions.join(' '),/既知の元税率/);
    const purchases=aggregateScenarioPurchases({actualOnePercentEntries:[{...entry,kind:'exemptPurchase',creditRatio:.7,usage:'common'}]},{...options,taxScenario});
    close(purchases.totalTax,-rate*10);close(purchases.totalAmount,amount);
    close(purchases.purchaseTaxByUse.common,-rate*7);close(purchases.usageTotal,purchases.totalCreditableTax);
    assert.deepEqual(purchases.errors,[]);assert.match(purchases.assumptions.join(' '),/既知の元税率/);
    assert.deepEqual(entry,before);
  }
});

test('概算継続：不明な仕入用途・割合は仮定を示し金額と税率を保持する',()=>{
  const result=aggregateScenarioPurchases({actualOnePercentEntries:[{kind:'exemptPurchase',amount:10100,ratePercent:1}]},options);
  assert.deepEqual(result.errors,[]);close(result.totalAmount,10100);close(result.totalTax,100);
  close(result.exemptCreditableTax,0);close(result.usageTotal,0);
  assert.match(result.assumptions.join(' '),/控除なし（0％）/);
  assert.match(result.assumptions.join(' '),/用途.*共通対応/);
});

for(const side of ['sales','purchases']){
  test(`CSV返品概算：${side}の日別・月別証拠から通常取引と元8％調整を分ける`,()=>{
    for(const monthly of [false,true])for(const source of ['csv','csv-edited']){
      const {row,groups}=fixture(side,{monthly,source});
      const result=parts(row,side,groups);
      assert.equal(result.rows.length,2);
      assert.equal(Number(ordinary(result).amount),10800);
      assert.equal(Number(ordinary(result).foodAmount),10800);
      assert.equal(Number(adjustment(result).amount),-1080);
      assert.ok(result.rows.every(part=>String(part.rate)==='8'));
      assert.equal(sum(result.rows,'amount'),9720,'元額を計算用内訳で一度だけ計上する');
    }
  });

  test(`CSV返品概算：${side}の食品内数は手入力0を尊重し、部分内数は同率配分の注意を返す`,()=>{
    const zero=fixture(side,{food:0,foodSource:'manual'});
    assert.equal(Number(ordinary(parts(zero.row,side,zero.groups)).foodAmount),0);
    const partial=fixture(side,{food:4860,foodSource:'manual'});
    const result=parts(partial.row,side,partial.groups);
    assert.equal(Number(ordinary(result).foodAmount),5400);
    assert.equal(Number(adjustment(result).amount),-1080);
    assert.ok(result.assumptions.length>0,'不明な食品構成の同率配分を確定扱いにしない');
  });

  test(`CSV返品概算：${side}の年間純額0・auto全量食品でも通常取引を消さない`,()=>{
    const data=fixture(side,{amount:0,food:0});
    data.groups[0].amount=1080;
    const result=parts(data.row,side,data.groups);
    assert.equal(sum(result.rows,'amount'),0);
    assert.equal(Number(ordinary(result).foodAmount),1080);
    assert.equal(Number(adjustment(result).amount),-1080);
    assert.ok(result.rows.every(row=>Number.isFinite(Number(row.foodAmount))));
  });

  test(`CSV返品概算：${side}の旧保存・不一致・壊れた匿名証拠は純額代理と注意へ戻す`,()=>{
    for(const variant of ['missing','sumMismatch','wrongRate','badAmount','nan','infinite']){
      const {row,groups}=fixture(side);
      if(variant==='missing') groups.length=0;
      if(variant==='sumMismatch') groups[0].amount+=1;
      if(variant==='wrongRate') groups.forEach(group=>group.rate='10');
      if(variant==='badAmount') groups[0].amount='not-an-amount';
      if(variant==='nan') groups[0].amount=NaN;
      if(variant==='infinite') groups[0].amount=Infinity;
      const result=parts(row,side,groups);
      assert.equal(sum(result.rows,'amount'),9720,variant);
      assert.equal(result.rows.length,1,variant);
      assert.equal(Number(result.rows[0].foodAmount),9720,variant);
      assert.ok(result.assumptions.length>0,variant);
    }
  });

  test(`CSV返品概算：${side}の負の純額代理は元税率の調整を維持する`,()=>{
    const {row}=fixture(side,{amount:-1080});
    const result=parts(row,side,[]);
    assert.equal(result.rows.length,1);
    assert.equal(Number(result.rows[0].amount),-1080);
    assert.equal(String(result.rows[0].rate),'8');
    assert.ok(result.assumptions.length>0);
  });

  test(`CSV返品概算：${side}の分離不能な純額も注意付きで計算を継続し、0円へ捨てない`,()=>{
    for(const [amount,food,foodSource,expectedAmount,expectedTax] of [
      [9720,9720,'auto',9090,90],[-1080,-1080,'auto',-1080,-80],
      [0,0,'auto',0,0],[9720,0,'manual',9720,720]
    ]){
      const {row}=fixture(side,{amount,food,foodSource});
      const result=side==='sales'
        ? collectSalesScenario({sales:[row]},{...options,sourceGroups:[]})
        : aggregateScenarioPurchases({purchases:[row]},{...options,sourceGroups:[]});
      assert.deepEqual(result.errors,[]);
      close(result.totalAmount,expectedAmount);close(result.totalTax,expectedTax);
      assert.ok(result.assumptions.length>0,'純額代理を確定又は無注記の0円にしない');
    }
  });
}

test('CSV返品概算：売上は通常分だけ1％へ投影し、調整は8％で一度だけ差し引く',()=>{
  const {row,groups}=fixture('sales');
  const before=structuredClone({row,groups});
  const result=collectSalesScenario({sales:[row]},{...options,sourceGroups:groups});
  assert.deepEqual(result.errors,[]);
  close(result.totalAmount,9020);
  close(result.totalTax,20);
  close(result.rows.reduce((n,row)=>n+row.forecastFood1,0),10100);
  close(result.rows.reduce((n,row)=>n+row.amount8,0),-1080);
  assert.ok(result.assumptions.length>0);
  const current=collectSalesScenario({sales:[row]},{...options,taxScenario:'current',sourceGroups:groups});
  assert.deepEqual(current.errors,[]);
  close(current.totalAmount,9720);
  close(current.totalTax,720);
  assert.deepEqual({row,groups},before);
});

test('CSV返品概算：仕入も通常分だけ1％へ投影し、用途別税額と合計を一致させる',()=>{
  const {row,groups}=fixture('purchases');
  const before=structuredClone({row,groups});
  const result=aggregateScenarioPurchases({purchases:[row]},{...options,sourceGroups:groups});
  assert.deepEqual(result.errors,[]);
  close(result.totalAmount,9020);
  close(result.totalTax,20);
  close(result.purchaseTaxByUse.taxableOnly,20);
  close(result.usageTotal,result.totalCreditableTax);
  assert.ok(result.assumptions.length>0);
  const current=aggregateScenarioPurchases({purchases:[row]},{...options,taxScenario:'current',sourceGroups:groups});
  assert.deepEqual(current.errors,[]);
  close(current.totalAmount,9720);
  close(current.totalTax,720);
  assert.deepEqual({row,groups},before);
});

test('CSV返品概算：食品を手入力0にした行は1％へ変更しない',()=>{
  for(const side of ['sales','purchases']){
    const {row,groups}=fixture(side,{food:0,foodSource:'manual'});
    const result=side==='sales'
      ? collectSalesScenario({sales:[row]},{...options,sourceGroups:groups})
      : aggregateScenarioPurchases({purchases:[row]},{...options,sourceGroups:groups});
    assert.deepEqual(result.errors,[]);
    close(result.totalAmount,9720);
    close(result.totalTax,720);
  }
});

test('CSV返品概算：分離した通常分の対象期間割合を一度だけ適用する',()=>{
  for(const side of ['sales','purchases']){
    const {row,groups}=fixture(side);
    const periodOptions={...options,foodForecastMethod:'uniform',proposalFraction:.25,
      foodPeriodAmount:(_row,amount)=>amount/2,sourceGroups:groups};
    const result=side==='sales'
      ? collectSalesScenario({sales:[row]},periodOptions)
      : aggregateScenarioPurchases({purchases:[row]},periodOptions);
    assert.deepEqual(result.errors,[]);
    close(result.totalAmount,9370);close(result.totalTax,370);
  }
});

test('CSV返品概算：10％・8％、売上・仕入、用途・控除割合が違う匿名集計を混ぜない',()=>{
  const sales=fixture('sales');
  const purchases=fixture('purchases');
  const tenSale={id:'synthetic-sale10',code:'1',rate:'10',businessType:'type4',amount:'11000',foodAmount:'',source:'csv'};
  const tenPurchase={id:'synthetic-buy10',code:'7',rate:'10',amount:'11000',foodAmount:'',source:'csv'};
  const foreignGroups=[...sales.groups,...purchases.groups,
    {...sales.groups[0],businessType:'type4',amount:10800},
    {...sales.groups[0],rate:'10',amount:11000},
    {...purchases.groups[0],code:'7',usage:'common',rate:'10',amount:11000},
    {...purchases.groups[0],code:'52',creditRatio:'80',amount:10800}];
  const saleResult=collectSalesScenario({sales:[sales.row,tenSale]},{...options,sourceGroups:foreignGroups});
  assert.deepEqual(saleResult.errors,[]);
  close(saleResult.totalAmount,20020);close(saleResult.totalTax,1020);
  const buyResult=aggregateScenarioPurchases({purchases:[purchases.row,tenPurchase]},{...options,sourceGroups:foreignGroups});
  assert.deepEqual(buyResult.errors,[]);
  close(buyResult.totalAmount,20020);close(buyResult.totalTax,1020);
  close(buyResult.purchaseTaxByUse.taxableOnly,20);close(buyResult.purchaseTaxByUse.common,1000);
});

test('CSV返品概算：免税事業者等仕入の元控除割合を計算用分離後も保持する',()=>{
  const {row,groups}=fixture('purchases',{code:'52',creditRatio:'80'});
  const result=aggregateScenarioPurchases({purchases:[row]},{...options,sourceGroups:groups});
  assert.deepEqual(result.errors,[]);
  close(result.totalTax,20);close(result.exemptCreditableTax,16);
  close(result.purchaseTaxByUse.taxableOnly,16);
  close(result.usageTotal,result.totalCreditableTax);
  assert.equal(row.creditRatio,'80');
});

test('CSV返品概算：元課税状態が不明のCSV返還は元8％仮定の注意付きで継続する',()=>{
  const row={id:'synthetic-return',code:'11',rate:'8',businessType:'type2',amount:'1080',foodAmount:'1080',
    source:'csv',originalTaxableState:'unknown'};
  const before=structuredClone(row);
  const result=collectSalesScenario({sales:[row]},options);
  assert.deepEqual(result.errors,[]);
  close(result.totalAmount,-1080);close(result.totalTax,-80);
  assert.ok(result.assumptions.length>0);
  const raw=aggregateTaxRows({sales:[row]});
  assert.deepEqual(raw.errors,[],'上流の行入力検査でも同じ未確認を停止扱いにしない');
  assert.ok(raw.warnings.length>0);
  assert.deepEqual(row,before,'unknownを照合済みへ書き換えない');
});

test('CSV返品概算：元免税と明示された返品を課税取引の仮定で上書きしない',()=>{
  const row={id:'synthetic-exempt-return',code:'11',rate:'8',businessType:'type2',amount:'1080',foodAmount:'1080',
    source:'csv',originalTaxableState:'exempt'};
  const before=structuredClone(row);
  const result=collectSalesScenario({sales:[row]},options);
  assert.deepEqual(result.errors,[]);close(result.totalTax,0);
  assert.deepEqual(row,before);
});

test('CSV返品概算：読めない元金額や食品内数の真の超過は概算で隠さない',()=>{
  for(const side of ['sales','purchases'])for(const change of [
    {amount:'not-an-amount'},{amount:''},{foodAmount:'not-an-amount'},{foodAmount:'9721'}
  ]){
    const {row,groups}=fixture(side,change);
    const before=structuredClone(row);
    const result=side==='sales'
      ? collectSalesScenario({sales:[row]},{...options,sourceGroups:groups})
      : aggregateScenarioPurchases({purchases:[row]},{...options,sourceGroups:groups});
    assert.ok(result.errors.length>0,`${side}: ${JSON.stringify(change)}`);
    assert.deepEqual(row,before);
  }
});
