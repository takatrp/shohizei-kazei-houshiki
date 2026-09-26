(function(root, factory){
  const calendar = typeof module === 'object' && module.exports
    ? require('./tax-calendar.js')
    : root.ShohizeiTaxCalendar;
  const api = factory(calendar);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiElectionDeadline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(calendar){
  'use strict';

  if(!calendar) throw new Error('届出期限の判定には税務カレンダーが必要です。');
  const SPECIAL_BOUNDARY = '2026-09-30';
  const RULE = Object.freeze({
    ORDINARY:'ordinaryPriorPeriod',
    WITHIN:'postSpecialWithinPeriod',
    RETURN:'postSpecialReturnDeadline'
  });

  function date(value){ return calendar.parseDate(value) ? value : null; }
  function period(value){
    const start = date(value?.start), end = date(value?.end);
    return start && end && start <= end ? { start, end } : null;
  }
  function result(input, fields){
    return {
      rule:null,
      previousPeriod:period(input.previousPeriod),
      previousMethod:input.previousMethod ?? 'unknown',
      targetPeriod:period(input.targetPeriod),
      rawDeadline:null,
      effectiveDeadline:null,
      deadlineQuality:'requiresConfirmation',
      basisLabel:'簡易課税制度選択届出書の提出期限を確認してください。',
      reasons:[],
      filingAssessment:'unknown',
      ...fields
    };
  }

  // The filing-date rules are deliberately separate from the tax method and
  // other simplified-tax eligibility conditions. A conditional filing plan is
  // never a confirmed filing, and an old yes/no cannot be upgraded here.
  function assessFiling(deadline, input){
    const status = input.filingStatus ?? 'unknown';
    if(!deadline.targetPeriod){
      return { status:'unknown', reason:'既存届出も対象期を確認してから判定してください。' };
    }
    if(status === 'existingValid') return { status:'eligible', reason:'既存の有効な簡易課税制度選択届出書を確認済みです。' };
    if(!deadline.effectiveDeadline || deadline.deadlineQuality !== 'confirmed'){
      return { status:'unknown', reason:'届出期限を確定できないため提出時期を判定できません。' };
    }
    if(status === 'filed'){
      const filed = date(input.filingDate);
      if(!filed) return { status:'unknown', reason:'提出済みの届出日を確認してください。' };
      return filed <= deadline.effectiveDeadline
        ? { status:'eligible', reason:`${filed}の提出は期限内です。` }
        : { status:'ineligible', reason:`${filed}の新規提出は${deadline.effectiveDeadline}の期限後です。` };
    }
    if(status === 'planned'){
      const asOf = date(input.asOfDate);
      if(!asOf) return { status:'unknown', reason:'提出計画の判定基準日を確認してください。' };
      if(asOf > deadline.effectiveDeadline){
        return { status:'ineligible', reason:`${asOf}時点で${deadline.effectiveDeadline}の期限を過ぎています。` };
      }
      const planned = input.filingDate == null || input.filingDate === '' ? null : date(input.filingDate);
      if(input.filingDate && !planned) return { status:'unknown', reason:'予定提出日が不正です。' };
      if(planned && planned > deadline.effectiveDeadline){
        return { status:'ineligible', reason:`予定提出日${planned}は${deadline.effectiveDeadline}の期限後です。` };
      }
      if(planned && planned < asOf) return { status:'unknown', reason:'過去の予定提出日は提出済みか確認してください。' };
      return { status:'conditional', reason:`${deadline.effectiveDeadline}までの提出計画です。提出完了の確認が必要です。` };
    }
    if(status === 'notFiled' && date(input.asOfDate) > deadline.effectiveDeadline){
      return { status:'ineligible', reason:`未提出のまま${deadline.effectiveDeadline}の期限を過ぎています。` };
    }
    return { status:'unknown', reason:'既存の有効届出、提出済みの事実、期限内提出計画を確認してください。' };
  }

  function finish(input, fields){
    const deadline = result(input, fields);
    const filing = assessFiling(deadline, input);
    deadline.filingAssessment = filing.status;
    if(filing.reason) deadline.reasons.push(filing.reason);
    return deadline;
  }

  function assessElectionDeadline(input = {}){
    const target = period(input.targetPeriod), previous = period(input.previousPeriod);
    if(!target) return finish(input, { reasons:['適用対象期の開始日・終了日を確認してください。'] });

    const method = input.previousMethod;
    if(!method || method === 'unknown'){
      return finish(input, { reasons:['前期に実際に適用した課税方式を確認してください。'] });
    }
    if(method !== 'special2' && method !== 'special3'){
      const raw = calendar.shiftDays(target.start, -1);
      return finish(input, {
        rule:RULE.ORDINARY,rawDeadline:raw,effectiveDeadline:raw,
        deadlineQuality:'confirmed',
        basisLabel:`通常の事前届出：${target.start}の前日（${raw}）まで`,
        reasons:['簡易課税の基準期間・継続適用等の要件は別途確認してください。']
      });
    }
    if(!previous || calendar.shiftDays(previous.end, 1) !== target.start){
      return finish(input, {
        reasons:['2割・3割特例を適用した前期と対象期が連続することを確認してください。']
      });
    }
    if(method === 'special2' && (previous.end < '2023-10-01' || previous.start > '2026-09-30')){
      return finish(input, {
        reasons:['2割特例の法定対象期間と前期が重なりません。前期の適用事実を確認してください。']
      });
    }
    if(method === 'special3' && (
      input.entityType !== 'individual' || previous.start < '2027-01-01' || previous.end > '2028-12-31'
    )){
      return finish(input, {
        reasons:['3割特例の対象は令和9年・10年に含まれる個人の課税期間です。前期の適用事実を確認してください。']
      });
    }
    if(target.end <= SPECIAL_BOUNDARY){
      return finish(input, {
        rule:RULE.WITHIN,rawDeadline:target.end,effectiveDeadline:target.end,
        deadlineQuality:'confirmed',
        basisLabel:`前期${method === 'special2' ? '2割' : '3割'}特例後：対象期中（${target.end}）までに届出`,
        reasons:['対象期中提出の期限は、末日が土日祝でも翌日へ繰り延べません。']
      });
    }

    let raw = null, basis = '';
    const confirmed = input.confirmedReturnDeadline;
    if(confirmed){
      if(!date(confirmed)) return finish(input, { rule:RULE.RETURN, reasons:['確認済みの消費税確定申告期限の日付が不正です。'] });
      const ordinaryRaw = input.entityType === 'individual' && target.end.endsWith('-12-31')
        ? `${Number(target.end.slice(0,4)) + 1}-03-31`
        : calendar.deadlineAfterPeriod(target.end);
      const minimumRaw = input.entityType === 'corporation' && input.consumptionTaxExtension === 'confirmed'
        ? calendar.shiftMonths(ordinaryRaw, 1) : ordinaryRaw;
      if(!minimumRaw || confirmed < minimumRaw){
        return finish(input, { rule:RULE.RETURN, reasons:['確認済みの消費税確定申告期限が通常期限または確認済みの延長期限より前です。根拠を確認してください。'] });
      }
      basis = '担当者が確認した対象期の消費税確定申告期限';
      return finish(input, {
        rule:RULE.RETURN,rawDeadline:ordinaryRaw,effectiveDeadline:confirmed,
        deadlineQuality:'confirmed',
        basisLabel:`前期${method === 'special2' ? '2割' : '3割'}特例後：確認済みの対象期確定申告期限（${confirmed}）までに届出`,
        reasons:[basis]
      });
    }else if(input.entityType === 'individual'){
      raw = target.end.endsWith('-12-31')
        ? `${Number(target.end.slice(0,4)) + 1}-03-31`
        : calendar.deadlineAfterPeriod(target.end);
      basis = '個人事業者の消費税確定申告期限';
    }else if(input.entityType === 'corporation'){
      if(input.consumptionTaxExtension === 'unknown' || !['none','confirmed'].includes(input.consumptionTaxExtension)){
        return finish(input, {
          rule:RULE.RETURN,
          rawDeadline:calendar.deadlineAfterPeriod(target.end),
          reasons:['法人の消費税申告期限延長の有無を確認してください。法人税だけの延長は消費税の延長とは扱いません。']
        });
      }
      raw = calendar.deadlineAfterPeriod(target.end);
      if(input.consumptionTaxExtension === 'confirmed') raw = calendar.shiftMonths(raw, 1);
      basis = input.consumptionTaxExtension === 'confirmed'
        ? '法人の消費税申告期限1か月延長を確認済み'
        : '法人の消費税申告期限延長なしを確認済み';
    }else{
      return finish(input, {rule:RULE.RETURN,reasons:['個人・法人の区分を確認してください。']});
    }
    const adjusted = calendar.adjustDueDate(raw);
    const quality = adjusted.status === 'ready' && adjusted.confidence === 'official'
      ? 'confirmed' : 'requiresConfirmation';
    const effective = quality === 'confirmed' ? adjusted.adjustedDueDate : null;
    return finish(input, {
      rule:RULE.RETURN,rawDeadline:raw,effectiveDeadline:effective,
      deadlineQuality:quality,
      basisLabel:`前期${method === 'special2' ? '2割' : '3割'}特例後：対象期の確定申告期限（${effective || '要確認'}）までに届出`,
      reasons:[basis,...(quality === 'confirmed' ? [] : ['休日・個別延長を含む確定申告期限を確認してください。'])]
    });
  }

  return { RULE,SPECIAL_BOUNDARY,assessElectionDeadline };
});
