const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../shared-case-facts.js');

const P = {start:'2027-04-01',end:'2028-03-31'};
const Q = {start:'2026-04-01',end:'2027-03-31'};
const actual = (nationalTax,period=P) => ({cashflowPriorStart:period.start,cashflowPriorEnd:period.end,cashflowPriorNationalTax:nationalTax});
const clone = value => JSON.parse(JSON.stringify(value));

test('共通前期: 届出と両モードの同じ実績をまとめ、方式・資料照合を推定しない', () => {
  const saved = {priorPeriodStart:P.start,priorPeriodEnd:P.end,priorTaxMethod:'regular',...actual('1,000'),
    cashflowModeStates:{rateImpact:{values:actual('1,000')},methodImpact:{values:actual('1000')}}};
  const before = clone(saved);
  const result = F.migratePriorActual(saved);
  assert.equal(result.status,'resolved');
  assert.deepEqual(result.value.period,P);
  assert.equal(Number(result.value.nationalTax.replace(/,/g,'')),1000);
  assert.equal(result.candidates.length,2);
  assert.deepEqual(result.candidates[1].origins,['topLevel','rateImpact','methodImpact']);
  assert.equal(Object.hasOwn(result.value,'method'),false);
  assert.equal(Object.hasOwn(result.value,'confirmed'),false);
  assert.deepEqual(saved,before);
});

test('共通前期: 空欄・明示0・負額・不正入力はそれぞれの値として保持する', () => {
  for(const [input,expected] of [['',''],['0','0'],[0,'0'],['-1,000','-1,000'],['未確認','未確認']]){
    const result = F.migratePriorActual(actual(input));
    assert.equal(result.status,'resolved');
    assert.equal(result.value.nationalTax,expected);
    assert.deepEqual(result.value.period,P);
  }
  assert.equal(F.migratePriorActual({}).status,'empty');
  assert.equal(F.migratePriorActual({cashflowPriorNationalTax:0}).value.nationalTax,'0');
});

test('共通前期: STEP3代理へ切り替えた後も隠れた実績入力を全モードから保持する', () => {
  const result = F.migratePriorActual({cashflowAutoBasis:'step3',...actual('-500'),
    cashflowModeStates:{rateImpact:{values:{cashflowAutoBasis:'step3',...actual('-500')}},
      methodImpact:{values:{cashflowAutoBasis:'step3',...actual('-500')}}}});
  assert.equal(result.status,'resolved');
  assert.equal(result.value.nationalTax,'-500');
  assert.deepEqual(result.candidates[0].origins,['topLevel','rateImpact','methodImpact']);
});

test('共通前期: 計算された代理額・代理期間・変更案の別仮定を実績へ昇格しない', () => {
  const proxyOnly = {cashflowAutoBasis:'step3',cashflowPriorProxyMethod:'regular',cashflowPriorChangedNationalTax:'1234',
    autoInterim:{basis:{priorStart:P.start,priorEnd:P.end,national:9999}},
    cashflowModeStates:{rateImpact:{values:{cashflowPriorChangedNationalTax:'5678',priorStart:Q.start,priorEnd:Q.end,national:5555}}}};
  assert.deepEqual(F.migratePriorActual(proxyOnly),{version:1,status:'empty',value:null,candidates:[],selectedId:null});
});

test('共通前期: 異なる期間と税額は候補に残し、部分的な日付をつなぎ合わせない', () => {
  const result = F.migratePriorActual({priorPeriodStart:P.start,priorPeriodEnd:P.end,...actual('0',Q),
    cashflowModeStates:{methodImpact:{values:actual('-100',Q)}}});
  assert.equal(result.status,'conflict');
  assert.equal(result.value,null);
  assert.equal(result.candidates.length,3);
  assert.deepEqual(result.candidates.map(item => item.period),[P,Q,Q]);
  const partial = F.migratePriorActual({priorPeriodStart:P.start,cashflowPriorEnd:P.end,cashflowPriorNationalTax:'0'});
  assert.equal(partial.status,'conflict');
  assert.deepEqual(partial.candidates.map(item => item.period),[{start:P.start,end:''},{start:'',end:P.end}]);
});

test('共通前期: 単独の期間と期間未入力の実績額は共存し、同じ期間の税額相違は競合する', () => {
  const compatible = F.migratePriorActual({priorPeriodStart:P.start,priorPeriodEnd:P.end,cashflowPriorNationalTax:'0'});
  assert.equal(compatible.status,'resolved');
  assert.deepEqual(compatible.value,{period:P,nationalTax:'0'});
  const conflict = F.migratePriorActual({...actual('0'),cashflowModeStates:{methodImpact:{values:actual('-1')}}});
  assert.equal(conflict.status,'conflict');
  assert.deepEqual(conflict.candidates.map(item => item.nationalTax),['0','-1']);
});

test('共通前期: 未解決候補と明示選択は保存往復で保持され、古いモード値が再優先されない', () => {
  const legacy = {priorPeriodStart:P.start,priorPeriodEnd:P.end,...actual('2500',Q)};
  const conflict = F.migratePriorActual(legacy);
  const restore = facts => F.migratePriorActual(clone({...legacy,sharedCaseFacts:{priorActual:facts}}));
  assert.deepEqual(restore(conflict),conflict);
  const selected = F.selectPriorCandidate(conflict,conflict.candidates[1].id);
  assert.deepEqual(selected.value,{period:Q,nationalTax:'2500'});
  assert.deepEqual(restore(selected),selected);
  assert.equal(selected.candidates.length,2);
  assert.equal(conflict.status,'conflict');
  assert.throws(() => F.selectPriorCandidate(conflict,'absent'),RangeError);
});

test('共通前期: 手修正・明示クリアを優先し、旧値の候補を保持する', () => {
  const original = F.migratePriorActual(actual('0'));
  const edited = F.withPriorActual(original,{period:Q,nationalTax:'-100'});
  assert.deepEqual(edited.value,{period:Q,nationalTax:'-100'});
  assert.deepEqual(edited.candidates[0],original.candidates[0]);
  const cleared = F.withPriorActual(edited,{period:{start:'',end:''},nationalTax:''});
  assert.equal(cleared.status,'resolved');
  assert.deepEqual(cleared.value,{period:{start:'',end:''},nationalTax:''});
  assert.deepEqual(F.migratePriorActual({...actual('9999'),sharedCaseFacts:{priorActual:clone(cleared)}}),cleared);
});

test('モード保存: 共通6項目だけを外し、代理方式・別案仮定・予定等を残す', () => {
  const values = {...actual('0'),cashflowSourceStart:P.start,cashflowSourceEnd:P.end,cashflowSourceConfirmed:true,
    cashflowAutoBasis:'step3',cashflowPriorProxyMethod:'simplified',cashflowPriorChangedNationalTax:'10',
    cashflowBaseInterim:'2028-11,0',cashflowInterimStatus:'scheduled'};
  const before = clone(values);
  const stripped = F.stripSharedModeValues(values);
  assert.equal(F.COMMON_MODE_INPUT_IDS.length,6);
  for(const id of F.COMMON_MODE_INPUT_IDS){ assert.equal(F.isCommonModeInput(id),true);assert.equal(Object.hasOwn(stripped,id),false); }
  assert.deepEqual(stripped,{cashflowAutoBasis:'step3',cashflowPriorProxyMethod:'simplified',cashflowPriorChangedNationalTax:'10',
    cashflowBaseInterim:'2028-11,0',cashflowInterimStatus:'scheduled'});
  assert.deepEqual(values,before);
});

test('連続編集は1件へまとめ、移行時の競合候補を消さない', () => {
  const original = F.migratePriorActual({priorPeriodStart:P.start,priorPeriodEnd:P.end,...actual('0',Q)});
  let edited = original;
  for(let i=0;i<40;i++) edited = F.withPriorActual(edited,{period:P,nationalTax:String(i)});
  assert.equal(edited.candidates.length,original.candidates.length+1);
  assert.deepEqual(edited.candidates.slice(0,-1),original.candidates);
  assert.equal(edited.value.nationalTax,'39');
  assert.equal(edited.selectedId,edited.candidates.at(-1).id);
});

test('CSV: 同一原文・同一期の期間と網羅性だけ共有し、別集計版や用途別確認を混同しない', () => {
  const records = [
    {sourceId:'raw-A',period:P,periodConfirmed:true,fullMonthCoverageConfirmed:false,origin:'distribution',aggregateId:'v1',cashAccountConfirmed:true},
    {sourceId:'raw-A',period:P,periodConfirmed:false,fullMonthCoverageConfirmed:true,origin:'cashActual',aggregateId:'v2',cashTaxCoverageConfirmed:true}
  ];
  const before = clone(records);
  const result = F.mergeCsvSourceFacts(records);
  assert.equal(result.status,'resolved');
  assert.deepEqual(result.value,{sourceId:'raw-A',period:P,periodConfirmed:true,fullMonthCoverageConfirmed:true});
  assert.deepEqual(result.candidates[0].origins,['distribution','cashActual']);
  assert.deepEqual(result.candidates[0].aggregateIds,['v1','v2']);
  assert.equal(Object.hasOwn(result.value,'cashAccountConfirmed'),false);
  assert.equal(Object.hasOwn(result.value,'cashTaxCoverageConfirmed'),false);
  assert.deepEqual(records,before);
});

test('CSV: 原文ID不明の資料は日付や加工版IDが一致しても結び付けない', () => {
  const records = ['distribution','cashActual'].map(origin => ({period:P,origin,aggregateId:'same-legacy-key',
    periodConfirmed:true,fullMonthCoverageConfirmed:true}));
  const result = F.mergeCsvSourceFacts(records);
  assert.equal(result.status,'conflict');
  assert.equal(result.candidates.length,2);
  assert.equal(result.value,null);
  const selected = F.selectCsvSourceCandidate(result,result.candidates[0].id);
  assert.equal(selected.value.sourceId,'');
  assert.equal(selected.candidates.length,2);
  assert.equal(F.mergeCsvSourceFacts([{...records[0],sourceId:'A'},{...records[1],sourceId:'B'}]).status,'conflict');
  assert.throws(() => F.selectCsvSourceCandidate(result,'absent'),RangeError);
});

test('CSV: 同一原文でも異なる正式期間は競合し、期間ペアを混ぜない', () => {
  const result = F.mergeCsvSourceFacts([
    {sourceId:'A',period:P,origin:'distribution',periodConfirmed:true,fullMonthCoverageConfirmed:true},
    {sourceId:'A',period:Q,origin:'cashActual',periodConfirmed:true,fullMonthCoverageConfirmed:true}
  ]);
  assert.equal(result.status,'conflict');
  assert.deepEqual(result.candidates.map(item => item.period),[P,Q]);
  const selected = F.selectCsvSourceCandidate(result,result.candidates[1].id);
  assert.deepEqual(selected.value.period,Q);
  const partial = F.mergeCsvSourceFacts([
    {sourceId:'A',period:{start:P.start,end:''}}, {sourceId:'A',period:{start:'',end:P.end}}
  ]);
  assert.equal(partial.status,'conflict');
});

test('CSV: 空期間の新しい原文IDは未確認として保持し、別期間の確認を移さない', () => {
  const initial = F.mergeCsvSourceFacts([{sourceId:'A',period:{},periodConfirmed:true,fullMonthCoverageConfirmed:true}]);
  assert.equal(initial.status,'resolved');
  assert.deepEqual(initial.value,{sourceId:'A',period:{start:'',end:''},periodConfirmed:false,fullMonthCoverageConfirmed:false});
  const filled = F.mergeCsvSourceFacts([{...initial.value,origin:'distribution'},
    {sourceId:'A',period:P,origin:'cashActual',periodConfirmed:false,fullMonthCoverageConfirmed:false}]);
  assert.equal(filled.status,'resolved');
  assert.deepEqual(filled.value,{sourceId:'A',period:P,periodConfirmed:false,fullMonthCoverageConfirmed:false});
});

test('CSV: 期間編集で解除した確認は旧候補から復活せず、明示クリアも保持する', () => {
  const original = F.mergeCsvSourceFacts([{sourceId:'A',period:P,periodConfirmed:true,fullMonthCoverageConfirmed:true}]);
  const edited = F.withCsvSource(original,{sourceId:'A',period:Q,periodConfirmed:false,fullMonthCoverageConfirmed:false});
  assert.deepEqual(edited.value,{sourceId:'A',period:Q,periodConfirmed:false,fullMonthCoverageConfirmed:false});
  assert.equal(edited.candidates[0].periodConfirmed,true);
  assert.equal(original.candidates.length,1);
  const cleared = F.withCsvSource(edited,{sourceId:'A',period:{}});
  assert.deepEqual(cleared.value,{sourceId:'A',period:{start:'',end:''},periodConfirmed:false,fullMonthCoverageConfirmed:false});
  assert.deepEqual(F.selectCsvSourceCandidate(clone(cleared),cleared.selectedId),cleared);
  const newSource = F.withCsvSource(edited,{sourceId:'B',period:P,periodConfirmed:false,fullMonthCoverageConfirmed:false});
  assert.equal(newSource.value.sourceId,'B');
  assert.equal(newSource.value.fullMonthCoverageConfirmed,false);
});

test('CSV: 保存復元は競合候補と選択値を維持し、解除した確認を再昇格しない', () => {
  const original = F.mergeCsvSourceFacts([
    {sourceId:'A',period:P,periodConfirmed:true,fullMonthCoverageConfirmed:true,origin:'distribution'},
    {sourceId:'A',period:Q,periodConfirmed:true,fullMonthCoverageConfirmed:true,origin:'cashActual'}
  ]);
  assert.equal(original.status,'conflict');
  assert.deepEqual(F.restoreCsvSourceFacts(clone(original)),original);
  const selected = F.selectCsvSourceCandidate(original,original.candidates[1].id);
  assert.deepEqual(F.restoreCsvSourceFacts(clone(selected)),selected);
  let edited = selected;
  for(let i=0;i<40;i++) edited = F.withCsvSource(edited,{sourceId:'A',period:P,
    periodConfirmed:false,fullMonthCoverageConfirmed:false});
  assert.equal(edited.candidates.length,original.candidates.length+1);
  assert.deepEqual(edited.candidates.slice(0,-1),original.candidates);
  assert.deepEqual(F.restoreCsvSourceFacts(clone(edited)),edited);
  assert.equal(F.restoreCsvSourceFacts(clone(edited)).value.periodConfirmed,false);
  assert.equal(F.restoreCsvSourceFacts(clone(edited)).value.fullMonthCoverageConfirmed,false);
  assert.equal(F.restoreCsvSourceFacts(null).status,'empty');
});

test('UMDはDOMやNodeモジュールなしで利用でき、共通情報を計算確定とは扱わない', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','shared-case-facts.js'),'utf8'),context);
  const api = context.ShohizeiSharedCaseFacts;
  assert.equal(api.VERSION,1);
  const result = api.migratePriorActual(actual('0'));
  assert.equal(result.status,'resolved');
  assert.equal(result.value.nationalTax,'0');
  assert.equal(Object.hasOwn(result.value,'confirmed'),false);
});
