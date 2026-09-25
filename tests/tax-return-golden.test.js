const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../tax-return-engine.js');

// Anonymized, aggregate-only accounting values. No source CSV/PDF or journal text.
function input(overrides = {}){
  return {
    taxableSalesGross:{'8':0,'10':600765511},
    salesReturnGross:{'8':0,'10':29477},
    nonTaxableSales:10965615,
    invoiceByUse:{taxableOnly:{'8':286961,'10':284161210},nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':0}},
    exemptByUse:{taxableOnly:{'80':{'8':24625,'10':28315922}},nonTaxableOnly:{},common:{}},
    unsupportedCodes:[],unresolvedCount:0,temporaryExcludedCount:0,
    ...overrides
  };
}

test('G01-G11 付表2-3→付表1-3→第一表の整数円と端数処理', () => {
  const result = R.calculateCurrentLawReturn(input());
  assert.equal(result.complete,true);
  const s23 = result.schedule23.fields, s13 = result.schedule13.fields, main = result.mainReturn.fields;
  assert.deepEqual({
    sales:s23['①B'],denominator:s23['⑦C'],ratio:s23['⑧C'],purchase8:s23['⑨A'],purchase10:s23['⑨B'],
    invoiceTax8:s23['⑩A'],invoiceTax10:s23['⑩B'],exempt8:s23['⑪A'],exempt10:s23['⑪B'],
    transitionTax8:s23['⑫A'],transitionTax10:s23['⑫B'],credit:s23['㉖C']
  },{
    sales:546123667,denominator:557089282,ratio:98.03,purchase8:286961,purchase10:284161210,
    invoiceTax8:16579,invoiceTax10:20149613,exempt8:24625,exempt10:28315922,
    transitionTax8:1138,transitionTax10:1606285,credit:21773615
  });
  assert.equal(s23['⑰C'],21773615);
  assert.equal(s23['⑲C'],21773615);
  assert.equal(s23['㉑C'],21773615);
  for(const prefix of ['⑰','⑲','㉑','㉖']){
    assert.deepEqual([s23[`${prefix}A`],s23[`${prefix}B`],s23[`${prefix}C`]],
      [17717,21755898,21773615],`${prefix}の税率別・合計`);
  }
  assert.equal(s23['④C'],546123667);
  assert.equal(s23['⑤C'],546123667);
  assert.equal(s23['⑥C'],10965615);
  assert.equal(s23['⑨C'],284448171);
  assert.equal(s23['⑩C'],20166192);
  assert.equal(s23['⑪C'],28340547);
  assert.equal(s23['⑫C'],1607423);
  assert.equal(result.schedule23.fullCreditEligible,false);
  assert.equal(result.schedule23.method,'individual');
  assert.equal(result.schedule23.returnTransfer['10'],26797);
  assert.equal(s13['①1B'],546150464);
  assert.equal(s13['①B'],546150000);
  assert.equal(s13['②B'],42599700);
  assert.equal(s13['④C'],21773615);
  assert.equal(s13['⑤B'],2090);
  assert.equal(s13['⑦C'],21775705);
  assert.equal(result.schedule13.nationalRaw,20823995);
  assert.equal(s13['⑨C'],20823900);
  assert.equal(s13['⑬C'],5873400);
  assert.deepEqual(main,{'①':546150000,'②':42599700,'④':21773615,'⑤':2090,'⑦':21775705,'⑨':20823900,'⑱':20823900,'⑳':5873400});
  assert.equal(result.mainReturn.totalBeforeInterim,26697300);
});

test('G12 返還等コード11を落とすと当期税額が2,700円ずれる', () => {
  const withoutReturn = R.calculateCurrentLawReturn(input({salesReturnGross:{'8':0,'10':0}}));
  assert.equal(withoutReturn.mainReturn.totalBeforeInterim,26700000);
  assert.equal(withoutReturn.mainReturn.totalBeforeInterim - R.calculateCurrentLawReturn(input()).mainReturn.totalBeforeInterim,2700);
});

test('未対応コード・未処理・仮除外は申告書再現を完了扱いにしない', () => {
  assert.equal(R.calculateCurrentLawReturn(input({unsupportedCodes:['51']})).complete,false);
  assert.equal(R.calculateCurrentLawReturn(input({unresolvedCount:1})).complete,false);
  assert.equal(R.calculateCurrentLawReturn(input({temporaryExcludedCount:1})).complete,false);
});

test('[R1-R3] 明示された仮除外だけは端数処理後の参考額を返し、厳密再現は未完了のままにする', () => {
  const sample = input({temporaryExcludedCount:1});
  const strict = R.calculateCurrentLawReturn(sample);
  assert.equal(strict.referenceCalculable,false);
  assert.equal(strict.mainReturn,undefined);
  const reference = R.calculateCurrentLawReturn(sample,'individual',{allowTemporaryExcluded:true,
    provisionalReasons:['CSV明細に税率の仮定があります。']});
  assert.equal(reference.complete,false);
  assert.equal(reference.exactComplete,false);
  assert.equal(reference.referenceCalculable,true);
  assert.equal(reference.precision,'provisional-declaration');
  assert.equal(reference.mainReturn.totalBeforeInterim,26697300);
  assert.match(reference.reasons.join(' '),/仮除外.*税額影響は未算定/);
  assert.match(reference.reasons.join(' '),/税率の仮定/);
  assert.equal(R.calculateCurrentLawReturn(input({unresolvedCount:1,temporaryExcludedCount:1}),'individual',
    {allowTemporaryExcluded:true}).referenceCalculable,false);
  assert.equal(R.calculateCurrentLawReturn(input({unsupportedCodes:['51'],temporaryExcludedCount:1}),'individual',
    {allowTemporaryExcluded:true}).referenceCalculable,false);
});

test('[R6] 簡易・2割・3割も厳密再現と端数処理後の参考額を分離する', () => {
  const sample = input({taxableSalesGross:{'8':0,'10':1100000},salesReturnGross:{'8':0,'10':0},
    nonTaxableSales:0,invoiceByUse:{taxableOnly:{'8':0,'10':0},nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':0}},
    exemptByUse:{taxableOnly:{},nonTaxableOnly:{},common:{}},salesByType:{type5:{gross:{'10':1100000},returns:{}}},
    temporaryExcludedCount:1});
  for(const method of ['simplified','special2','special3']){
    assert.equal(R.calculateCurrentLawSalesMethod(sample,method,{type5:0.5}).referenceCalculable,false);
    const result = R.calculateCurrentLawSalesMethod(sample,method,{type5:0.5},{allowTemporaryExcluded:true});
    assert.equal(result.complete,false);
    assert.equal(result.referenceCalculable,true);
    assert.equal(result.precision,'provisional-declaration');
    assert.equal(Number.isSafeInteger(result.totalBeforeInterim),true);
  }
});

test('全額控除要件は95％だけでは満たさず、用途別・比例を分離する', () => {
  assert.throws(() => R.calculateCurrentLawReturn(input(),'full'),/全額控除/);
  const common = input({invoiceByUse:{taxableOnly:{'8':0,'10':0},nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':11000}},exemptByUse:{taxableOnly:{},nonTaxableOnly:{},common:{}}});
  const individual = R.calculateCurrentLawReturn(common,'individual');
  const proportional = R.calculateCurrentLawReturn(common,'proportional');
  assert.equal(individual.schedule23.method,'individual');
  assert.equal(proportional.schedule23.method,'proportional');
  assert.equal(individual.schedule23.creditableTotal,Math.floor(780 * individual.schedule23.ratioRaw));
});

test('軽減8％の売上税額と返還税額は6.24％の国税率で別欄に計上する', () => {
  const reduced = input({taxableSalesGross:{'8':108000,'10':0},salesReturnGross:{'8':1080,'10':0},nonTaxableSales:0,
    invoiceByUse:{taxableOnly:{'8':0,'10':0},nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':0}},
    exemptByUse:{taxableOnly:{},nonTaxableOnly:{},common:{}}});
  const result = R.calculateCurrentLawReturn(reduced,'auto');
  assert.equal(result.complete,true);
  assert.equal(result.schedule23.method,'full');
  assert.equal(result.schedule13.fields['①A'],100000);
  assert.equal(result.schedule13.fields['②A'],6240);
  assert.equal(result.schedule13.fields['⑤A'],62);
  assert.equal(result.mainReturn.fields['⑤'],62);
});

test('用途別に丸めた税額が総額欄と一致しないときは再現完了にしない', () => {
  const split = input({
    invoiceByUse:{taxableOnly:{'8':0,'10':10},nonTaxableOnly:{'8':0,'10':0},common:{'8':0,'10':10}},
    exemptByUse:{taxableOnly:{},nonTaxableOnly:{},common:{}}
  });
  assert.throws(() => R.calculateCurrentLawReturn(split,'individual'), /端数/);
});
