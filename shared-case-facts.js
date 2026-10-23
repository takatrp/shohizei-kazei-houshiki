(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiSharedCaseFacts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const VERSION = 1;
  const COMMON_MODE_INPUT_IDS = Object.freeze([
    'cashflowPriorStart','cashflowPriorEnd','cashflowPriorNationalTax',
    'cashflowSourceStart','cashflowSourceEnd','cashflowSourceConfirmed'
  ]);
  const commonModeIds = new Set(COMMON_MODE_INPUT_IDS);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const period = value => ({start:text(value?.start),end:text(value?.end)});
  const periodKey = value => JSON.stringify([value.start,value.end]);
  const hasPeriod = value => value.start !== '' || value.end !== '';
  const fullPeriod = value => value.start !== '' && value.end !== '';
  const origins = value => [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && item))];
  const empty = () => ({version:VERSION,status:'empty',value:null,candidates:[],selectedId:null});

  // Equate ordinary integer formatting without parsing a tax amount into a float.
  // Invalid input is retained for the existing input validator, never made into 0.
  function amountKey(value){
    return /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)
      ? `integer:${BigInt(value.replace(/,/g,''))}` : `text:${value}`;
  }
  function priorValue(value){
    return {period:period(value?.period),nationalTax:text(value?.nationalTax)};
  }
  function priorKey(value){
    return JSON.stringify([periodKey(value.period),amountKey(value.nationalTax)]);
  }
  function copyPriorCandidate(candidate, index){
    return {id:text(candidate.id) || `prior-${index+1}`,...priorValue(candidate),origins:origins(candidate.origins)};
  }
  function resolvePrior(candidates){
    if(!candidates.length) return empty();
    const periods = new Map(), amounts = new Map();
    for(const candidate of candidates){
      if(hasPeriod(candidate.period)) periods.set(periodKey(candidate.period),candidate.period);
      if(candidate.nationalTax !== '') amounts.set(amountKey(candidate.nationalTax),candidate.nationalTax);
    }
    const conflict = periods.size > 1 || amounts.size > 1;
    return {version:VERSION,status:conflict ? 'conflict' : 'resolved',
      value:conflict ? null : {period:period(periods.values().next().value),nationalTax:amounts.values().next().value ?? ''},
      candidates,selectedId:!conflict && candidates.length === 1 ? candidates[0].id : null};
  }

  function migratePriorActual(saved = {}){
    const stored = saved?.sharedCaseFacts?.priorActual;
    if(object(stored) && stored.version === VERSION && Array.isArray(stored.candidates)){
      const candidates = stored.candidates.filter(object).map(copyPriorCandidate);
      if(stored.status === 'resolved' && object(stored.value)) return {
        version:VERSION,status:'resolved',value:priorValue(stored.value),candidates,
        selectedId:candidates.some(item => item.id === stored.selectedId) ? stored.selectedId : null
      };
      return resolvePrior(candidates);
    }
    const candidates = [];
    function add(value, origin){
      const candidate = priorValue(value);
      if(!hasPeriod(candidate.period) && candidate.nationalTax === '') return;
      const existing = candidates.find(item => priorKey(item) === priorKey(candidate));
      if(existing){ existing.origins.push(origin); return; }
      candidates.push({id:`prior-${candidates.length+1}`,...candidate,origins:[origin]});
    }
    add({period:{start:saved?.priorPeriodStart,end:saved?.priorPeriodEnd}},'election');
    function addControls(values, origin){
      if(!object(values)) return;
      // These dedicated actual-input controls may be hidden while proxy mode is
      // active. Preserve them; computed proxy results and changed-plan inputs
      // are deliberately not read. No exact method is inferred from "regular".
      add({period:{start:values.cashflowPriorStart,end:values.cashflowPriorEnd},
        nationalTax:values.cashflowPriorNationalTax},origin);
    }
    addControls(saved,'topLevel');
    for(const mode of ['rateImpact','methodImpact']) addControls(saved?.cashflowModeStates?.[mode]?.values,mode);
    return resolvePrior(candidates);
  }

  function selectPriorCandidate(facts, id){
    const candidates = (facts?.candidates || []).map(copyPriorCandidate);
    const selected = candidates.find(candidate => candidate.id === id);
    if(!selected) throw new RangeError('前期実績の候補が見つかりません。');
    return {version:VERSION,status:'resolved',value:priorValue(selected),candidates,selectedId:selected.id};
  }
  function withPriorActual(facts, value){
    const previous = (facts?.candidates || []).map(copyPriorCandidate);
    // Keep the migration alternatives, but coalesce keystrokes into one edit.
    const editId = previous.find(candidate => candidate.id.startsWith('prior-edit-'))?.id || 'prior-edit-1';
    const candidates = previous.filter(candidate => !candidate.id.startsWith('prior-edit-'));
    const candidate = {id:editId,...priorValue(value),origins:['manual']};
    candidates.push(candidate);
    // Explicit clearing is a selected value, not a request to revive legacy data.
    return {version:VERSION,status:'resolved',value:priorValue(candidate),candidates,selectedId:candidate.id};
  }

  function csvValue(value){
    const sourcePeriod = period(value?.period);
    return {sourceId:text(value?.sourceId),period:sourcePeriod,
      periodConfirmed:fullPeriod(sourcePeriod) && value?.periodConfirmed === true,
      fullMonthCoverageConfirmed:fullPeriod(sourcePeriod) && value?.fullMonthCoverageConfirmed === true};
  }
  function copyCsvCandidate(candidate, index){
    return {id:text(candidate.id) || `csv-${index+1}`,...csvValue(candidate),
      origins:origins(candidate.origins),aggregateIds:origins(candidate.aggregateIds)};
  }
  function mergeCsvSourceFacts(records = []){
    if(!Array.isArray(records)) throw new TypeError('CSV元資料の候補は配列で指定してください。');
    const candidates = [];
    for(const [index, record] of records.entries()){
      if(!object(record)) continue;
      const value = csvValue(record);
      if(!value.sourceId && !hasPeriod(value.period)) continue;
      const origin = text(record.origin) || `record-${index+1}`;
      // Unknown identities never become linked merely because dates or derived
      // aggregate IDs match. A proved original ID can survive re-aggregation.
      const existing = value.sourceId ? candidates.find(candidate => candidate.sourceId === value.sourceId
        && periodKey(candidate.period) === periodKey(value.period)) : null;
      if(existing){
        existing.periodConfirmed ||= value.periodConfirmed;
        existing.fullMonthCoverageConfirmed ||= value.fullMonthCoverageConfirmed;
        existing.origins = origins([...existing.origins,origin]);
        existing.aggregateIds = origins([...existing.aggregateIds,text(record.aggregateId)]);
      }else candidates.push({id:`csv-${candidates.length+1}`,...value,origins:[origin],
        aggregateIds:origins([text(record.aggregateId)])});
    }
    return resolveCsv(candidates);
  }
  function resolveCsv(candidates){
    if(!candidates.length) return empty();
    if(candidates.length === 1) return {version:VERSION,status:'resolved',value:csvValue(candidates[0]),candidates,selectedId:candidates[0].id};
    const sourceIds = new Set(candidates.map(candidate => candidate.sourceId));
    const periods = new Map(candidates.filter(candidate => hasPeriod(candidate.period)).map(candidate => [periodKey(candidate.period),candidate.period]));
    if(sourceIds.size !== 1 || sourceIds.has('') || periods.size > 1)
      return {version:VERSION,status:'conflict',value:null,candidates,selectedId:null};
    const sourcePeriod = period(periods.values().next().value);
    const matching = candidates.filter(candidate => periodKey(candidate.period) === periodKey(sourcePeriod));
    return {version:VERSION,status:'resolved',value:csvValue({sourceId:candidates[0].sourceId,period:sourcePeriod,
      periodConfirmed:matching.some(candidate => candidate.periodConfirmed),
      fullMonthCoverageConfirmed:matching.some(candidate => candidate.fullMonthCoverageConfirmed)}),candidates,selectedId:null};
  }
  function restoreCsvSourceFacts(stored){
    if(!object(stored) || stored.version !== VERSION || !Array.isArray(stored.candidates)) return empty();
    const candidates = stored.candidates.filter(object).map(copyCsvCandidate);
    if(stored.status === 'resolved' && object(stored.value)) return {
      version:VERSION,status:'resolved',value:csvValue(stored.value),candidates,
      selectedId:candidates.some(candidate => candidate.id === stored.selectedId) ? stored.selectedId : null
    };
    return resolveCsv(candidates);
  }
  function selectCsvSourceCandidate(facts, id){
    const candidates = (facts?.candidates || []).map(copyCsvCandidate);
    const selected = candidates.find(candidate => candidate.id === id);
    if(!selected) throw new RangeError('CSV元資料の候補が見つかりません。');
    return {version:VERSION,status:'resolved',value:csvValue(selected),candidates,selectedId:selected.id};
  }
  function withCsvSource(facts, record){
    const previous = (facts?.candidates || []).map(copyCsvCandidate);
    // A source/period form edit is one candidate, not an unbounded event log.
    const editId = previous.find(candidate => candidate.id.startsWith('csv-edit-'))?.id || 'csv-edit-1';
    const candidates = previous.filter(candidate => !candidate.id.startsWith('csv-edit-'));
    const candidate = {id:editId,...csvValue(record),
      origins:[text(record?.origin) || 'manual'],aggregateIds:origins([text(record?.aggregateId)])};
    candidates.push(candidate);
    // An explicit edit is authoritative: old checked candidates cannot restore
    // confirmations that the caller has cleared for a changed period/source.
    return {version:VERSION,status:'resolved',value:csvValue(candidate),candidates,selectedId:candidate.id};
  }
  function isCommonModeInput(id){return commonModeIds.has(id);}
  function stripSharedModeValues(values){
    return Object.fromEntries(Object.entries(object(values) ? values : {}).filter(([id]) => !isCommonModeInput(id)));
  }

  return Object.freeze({VERSION,COMMON_MODE_INPUT_IDS,isCommonModeInput,stripSharedModeValues,
    migratePriorActual,selectPriorCandidate,withPriorActual,
    mergeCsvSourceFacts,restoreCsvSourceFacts,selectCsvSourceCandidate,withCsvSource});
});
