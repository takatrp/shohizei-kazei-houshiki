const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../cashflow-defaults.js');

const dateCases = [
  ['corporation','2028-03-31','2028-05','2028-06'],
  ['corporation','2028-09-30','2028-11','2028-12'],
  ['corporation','2028-10-31','2028-12','2029-01'],
  ['corporation','2028-11-30','2029-01','2029-02'],
  ['corporation','2028-12-31','2029-02','2029-03'],
  ['corporation','2028-02-29','2028-04','2028-05'],
  ['corporation','2028-09-15','2028-11','2028-12'],
  ['individual','2028-12-31','2029-03','2029-04'],
  ['individual','2029-12-31','2030-03','2030-04'],
  ['individual','2028-09-30','2028-12','2029-01'],
  ['individual','2028-10-31','2029-01','2029-02'],
  ['individual','2028-11-30','2029-02','2029-03'],
  ['individual','2028-02-29','2028-05','2028-06'],
  ['individual','2028-09-15','2028-12','2029-01']
];

test('DF01-04,13: 添付固定日付例は区分別の暦月加算で一致する', () => {
  assert.equal(D.DEFAULT_INTERIM_MODE,'auto');
  assert.equal(D.DEFAULT_POLICY_VERSION,2);
  for(const [entityType,periodEnd,payment,refund] of dateCases){
    const result = D.defaultMonths({entityType,periodEnd});
    assert.equal(result.status,'ready',`${entityType}/${periodEnd}`);
    assert.equal(result.interimMode,'auto');
    assert.equal(result.payment.value,payment,`${entityType}/${periodEnd} payment`);
    assert.equal(result.refund.value,refund,`${entityType}/${periodEnd} refund`);
    assert.equal(result.payment.origin,'defaultOffset');
    assert.equal(result.refund.basedOnEntityType,entityType);
    assert.equal(result.payment.basedOnPeriodEnd,periodEnd);
  }
  assert.equal(D.addCalendarMonths('2028-02-29',2),'2028-04');
});

test('DF05,25: 区分・期末が不正なら法人に暗黙フォールバックせず自動月を出さない', () => {
  const invalid = [
    ['corporation',''], ['individual','2027-02-29'], ['corporation','2028-13-31'],
    ['individual','not-a-date'], ['', '2028-12-31'], ['unknown','2028-12-31'],
    [null,'2028-12-31'], ['corporate','2028-12-31']
  ];
  for(const [entityType,periodEnd] of invalid){
    const result = D.defaultMonths({entityType,periodEnd});
    assert.notEqual(result.status,'ready');
    assert.equal(result.payment.value,'');
    assert.equal(result.refund.value,'');
    assert.equal(result.payment.needsReconfirmation,true);
  }
  const later = D.reconcileMonth(D.defaultMonths({entityType:'',periodEnd:'2028-12-31'}).payment,
    'payment',{entityType:'individual',periodEnd:'2028-12-31'});
  assert.equal(later.value,'2029-03');
});

test('DF06,17-20: 初期値だけ区分・期末へ追従し、偶然同額の手入力を保持する', () => {
  const corporate = {entityType:'corporation',periodEnd:'2028-12-31'};
  const individual = {entityType:'individual',periodEnd:'2028-12-31'};
  const first = D.defaultMonths(corporate);
  assert.equal(D.reconcileMonth(first.payment,'payment',individual).value,'2029-03');
  assert.equal(D.reconcileMonth(first.refund,'refund',individual).value,'2029-04');
  assert.equal(D.reconcileMonth(D.createDefaultMonth('payment',individual),'payment',corporate).value,'2029-02');
  const manualSameAsDefault = D.setManualMonth('2029-02','payment',corporate);
  const preserved = D.reconcileMonth(manualSameAsDefault,'payment',individual);
  assert.equal(preserved.value,'2029-02');
  assert.equal(preserved.origin,'manual');
  assert.equal(preserved.needsReconfirmation,true);
  assert.equal(preserved.confirmed,false);
  assert.equal(preserved.reason,'contextChanged');
  const refund = D.reconcileMonth(first.refund,'refund',individual);
  assert.equal(refund.value,'2029-04');
  assert.equal(refund.origin,'defaultOffset');
  const changedPeriod = D.reconcileMonth(refund,'refund',{entityType:'individual',periodEnd:'2029-12-31'});
  assert.equal(changedPeriod.value,'2030-04');
});

test('DF07-08: 明示クリアは保存復元後も空欄、標準月へ戻すと再び追従する', () => {
  const c1={entityType:'individual',periodEnd:'2028-12-31'};
  const c2={entityType:'individual',periodEnd:'2029-12-31'};
  const cleared=D.setManualMonth('','payment',c1);
  assert.equal(cleared.origin,'manualCleared');
  const restored=D.restoreSavedMonth(JSON.parse(JSON.stringify(cleared)),'payment',c1);
  assert.equal(restored.value,'');
  assert.equal(restored.origin,'manualCleared');
  assert.equal(D.reconcileMonth(restored,'payment',c2).value,'');
  const reset=D.restoreDefaultMonth('payment',c1);
  assert.equal(reset.value,'2029-03');
  assert.equal(reset.origin,'defaultOffset');
  assert.equal(D.reconcileMonth(reset,'payment',c2).value,'2030-03');
});

test('DF22-23: 出典付き旧初期値だけv2へ移行し、出典不明の旧非空値は保持する', () => {
  const context={entityType:'individual',periodEnd:'2028-12-31'};
  const prior={value:'2029-02',origin:'defaultOffset',offset:2,basedOnPeriodEnd:'2028-12-31',
    basedOnEntityType:'individual',defaultPolicyVersion:1};
  const migrated=D.restoreSavedMonth(prior,'payment',context);
  assert.equal(migrated.value,'2029-03');
  assert.equal(migrated.defaultPolicyVersion,2);
  assert.match(migrated.migrationNotice,/旧版/);
  const legacy=D.restoreSavedMonth('2029-02','payment',context);
  assert.equal(legacy.value,'2029-02');
  assert.equal(legacy.origin,'restoredLegacy');
  assert.equal(legacy.needsReconfirmation,true);
  assert.equal(legacy.confirmed,false);
  assert.equal(D.restoreSavedMonth(null,'payment',context).value,'2029-03');
});

test('区分・期間が不正になった後は古い自動月を使わず、手入力は確認対象として保持する', () => {
  const context={entityType:'corporation',periodEnd:'2028-12-31'};
  const bad={entityType:'invalid',periodEnd:'2028-12-31'};
  const auto=D.reconcileMonth(D.createDefaultMonth('refund',context),'refund',bad);
  assert.equal(auto.value,'');
  assert.equal(auto.reason,'invalidEntity');
  assert.equal(auto.needsReconfirmation,true);
  const manual=D.reconcileMonth(D.setManualMonth('2029-05','refund',context),'refund',bad);
  assert.equal(manual.value,'2029-05');
  assert.equal(manual.needsReconfirmation,true);
});

test('手入力に不正月があれば文字列を失わず結果検証に渡せる理由を付ける', () => {
  const context={entityType:'individual',periodEnd:'2028-12-31'};
  const meta=D.setManualMonth('2029-13','refund',context);
  assert.equal(meta.value,'2029-13');
  assert.equal(meta.reason,'invalidMonth');
  assert.equal(meta.needsReconfirmation,true);
  assert.equal(D.validMonth(meta.value),false);
  assert.throws(()=>D.createDefaultMonth('settlement',context),/paymentまたはrefund/);
});
