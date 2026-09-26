(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiCashflowDefaults = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const SCHEMA_VERSION = 2;
  const DEFAULT_POLICY_VERSION = 2;
  const DEFAULT_INTERIM_MODE = 'auto';
  const OFFSETS = Object.freeze({
    corporation:Object.freeze({payment:2, refund:3}),
    individual:Object.freeze({payment:3, refund:4})
  });
  const KINDS = Object.freeze(['payment', 'refund']);

  function validDate(value){
    if(typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if(year < 1) return false;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
  }

  function validMonth(value){
    return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) >= 1;
  }

  function contextStatus(context){
    if(!context || !Object.hasOwn(OFFSETS, context.entityType)) return 'invalidEntity';
    if(!validDate(context.periodEnd)) return 'invalidPeriod';
    return 'ready';
  }

  function assertKind(kind){
    if(!KINDS.includes(kind)) throw new TypeError('予定月の種類はpaymentまたはrefundです。');
  }

  function addCalendarMonths(periodEnd, offset){
    if(!validDate(periodEnd)) throw new TypeError('対象課税期間終了日は実在するYYYY-MM-DD形式で指定してください。');
    if(!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('月の加算値は0以上の整数で指定してください。');
    const year = Number(periodEnd.slice(0, 4));
    const month = Number(periodEnd.slice(5, 7));
    const monthIndex = (year - 1) * 12 + month - 1 + offset;
    const nextYear = Math.floor(monthIndex / 12) + 1;
    const nextMonth = monthIndex % 12 + 1;
    if(nextYear > 9999) throw new RangeError('予定月が対応範囲を超えています。');
    return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
  }

  function snapshot(context){
    return {
      basedOnPeriodEnd:validDate(context?.periodEnd) ? context.periodEnd : null,
      basedOnEntityType:Object.hasOwn(OFFSETS, context?.entityType) ? context.entityType : null
    };
  }

  function createDefaultMonth(kind, context){
    assertKind(kind);
    const status = contextStatus(context);
    const offset = status === 'ready' ? OFFSETS[context.entityType][kind] : null;
    return {
      value:status === 'ready' ? addCalendarMonths(context.periodEnd, offset) : '',
      origin:'defaultOffset',
      offset,
      ...snapshot(context),
      defaultPolicyVersion:DEFAULT_POLICY_VERSION,
      confirmed:false,
      needsReconfirmation:status !== 'ready',
      reason:status === 'ready' ? null : status
    };
  }

  function defaultMonths(context){
    return {
      status:contextStatus(context),
      interimMode:DEFAULT_INTERIM_MODE,
      payment:createDefaultMonth('payment', context),
      refund:createDefaultMonth('refund', context)
    };
  }

  function setManualMonth(value, kind, context){
    assertKind(kind);
    if(typeof value !== 'string') throw new TypeError('予定月は文字列で指定してください。');
    const status = contextStatus(context);
    const cleared = value === '';
    return {
      value,
      origin:cleared ? 'manualCleared' : 'manual',
      offset:null,
      ...snapshot(context),
      defaultPolicyVersion:DEFAULT_POLICY_VERSION,
      confirmed:false,
      needsReconfirmation:status !== 'ready' || (!cleared && !validMonth(value)),
      reason:status !== 'ready' ? status : (!cleared && !validMonth(value) ? 'invalidMonth' : null)
    };
  }

  function restoreDefaultMonth(kind, context){
    return createDefaultMonth(kind, context);
  }

  function reconcileMonth(meta, kind, context){
    assertKind(kind);
    if(!meta || typeof meta !== 'object' || !['defaultOffset', 'manual', 'manualCleared', 'restoredLegacy'].includes(meta.origin)){
      return restoreSavedMonth(meta, kind, context);
    }
    if(meta.origin === 'defaultOffset'){
      const next = createDefaultMonth(kind, context);
      if(meta.defaultPolicyVersion !== DEFAULT_POLICY_VERSION &&
        meta.basedOnEntityType === 'individual' && contextStatus(context) === 'ready' &&
        context.entityType === 'individual' && meta.basedOnPeriodEnd === context.periodEnd &&
        meta.value && meta.value !== next.value){
        next.migrationNotice = '旧版の個人用初期予定月を、現在の区分別初期値へ更新しました。';
      }
      return next;
    }
    const status = contextStatus(context);
    const changed = meta.basedOnEntityType !== context?.entityType || meta.basedOnPeriodEnd !== context?.periodEnd;
    const cleared = meta.origin === 'manualCleared';
    const value = cleared ? '' : (typeof meta.value === 'string' ? meta.value : '');
    const invalidValue = !cleared && !validMonth(value);
    const legacy = meta.origin === 'restoredLegacy';
    const needsReconfirmation = legacy || changed || status !== 'ready' || invalidValue || meta.needsReconfirmation === true;
    return {
      value,
      origin:meta.origin,
      offset:null,
      basedOnPeriodEnd:typeof meta.basedOnPeriodEnd === 'string' ? meta.basedOnPeriodEnd : null,
      basedOnEntityType:typeof meta.basedOnEntityType === 'string' ? meta.basedOnEntityType : null,
      defaultPolicyVersion:DEFAULT_POLICY_VERSION,
      confirmed:!needsReconfirmation && meta.confirmed === true,
      needsReconfirmation,
      reason:status !== 'ready' ? status : invalidValue ? 'invalidMonth' : changed ? 'contextChanged' : legacy ? 'legacyOriginUnknown' : meta.reason || null
    };
  }

  function restoreSavedMonth(saved, kind, context){
    assertKind(kind);
    if(saved == null || saved === '') return createDefaultMonth(kind, context);
    if(typeof saved === 'object' && ['defaultOffset', 'manual', 'manualCleared', 'restoredLegacy'].includes(saved.origin)){
      return reconcileMonth(saved, kind, context);
    }
    const value = typeof saved === 'string' ? saved : typeof saved?.value === 'string' ? saved.value : '';
    if(value === '') return createDefaultMonth(kind, context);
    return reconcileMonth({
      value,
      origin:'restoredLegacy',
      basedOnPeriodEnd:typeof saved?.basedOnPeriodEnd === 'string' ? saved.basedOnPeriodEnd : null,
      basedOnEntityType:typeof saved?.basedOnEntityType === 'string' ? saved.basedOnEntityType : null,
      needsReconfirmation:true
    }, kind, context);
  }

  return {
    SCHEMA_VERSION,
    DEFAULT_POLICY_VERSION,
    DEFAULT_INTERIM_MODE,
    OFFSETS,
    validDate,
    validMonth,
    contextStatus,
    addCalendarMonths,
    createDefaultMonth,
    defaultMonths,
    setManualMonth,
    restoreDefaultMonth,
    reconcileMonth,
    restoreSavedMonth
  };
});
