(function(root, factory){
  const engine = typeof module === 'object' && module.exports
    ? require('./tax-engine.js') : root.ShohizeiTaxEngine;
  const api = factory(engine);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiFoodPeriodEstimator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(engine){
  'use strict';

  const DAY = 86400000;
  const PURCHASE_CODES = ['5','6','7','52','62','72'];
  const EXEMPT_CODES = ['52','62','72'];
  const USAGES = {'5':'taxableOnly','52':'taxableOnly','6':'nonTaxableOnly','62':'nonTaxableOnly','7':'common','72':'common'};
  const close = (a,b) => Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a-b) <= 1e-7 + Math.max(Math.abs(a),Math.abs(b)) * Number.EPSILON * 16;
  const sum = rows => rows.reduce((total,row) => total + row.amount,0);

  function day(value){
    const text = String(value || '');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === text ? parsed.getTime() : null;
  }
  function days(start,end){
    const first = day(start), last = day(end);
    return first !== null && last !== null && last >= first ? (last-first)/DAY + 1 : 0;
  }
  function overlap(a,b,c,d){return days([a,c].sort().at(-1),[b,d].sort()[0]);}
  function monthNumber(value){return Number(value.slice(0,4))*12 + Number(value.slice(5,7))-1;}
  function monthLabel(value){return `${String(Math.floor(value/12)).padStart(4,'0')}-${String(value%12+1).padStart(2,'0')}`;}
  function monthEnd(month){
    return new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
  }
  function months(start,end){
    if(!days(start,end)) return [];
    const first=monthNumber(start),last=monthNumber(end);
    if(last-first>239) return [];
    return Array.from({length:last-first+1},(_,index)=>monthLabel(first+index));
  }
  function parsed(value){
    const result = engine.parseAmountInput(value,{allowNegative:true});
    return result.valid && result.entered ? result.value : null;
  }
  function key(kind,row){
    const code = String(row.code || '');
    return JSON.stringify([kind,code,String(row.rate || ''),kind === 'sales' ? String(row.businessType || '') : '',
      kind === 'purchases' ? USAGES[code] || String(row.usage || '') : '',
      EXEMPT_CODES.includes(code) ? String(row.creditRatio || '').replace(/%$/,'') : '']);
  }
  function signed(kind,row,value){return kind === 'sales' && String(row.code) === '11' ? -value : value;}
  function emptyMonths(targetMonths){return targetMonths.map(month=>({month,amount:0}));}
  function addMonths(target,items){
    for(let index=0;index<target.length;index++) target[index].amount += items[index].amount;
  }
  function uniformMonthly(amount,targetMonths,start,end,policyStart,policyEnd,manual){
    const divisor = manual ? overlap(start,end,policyStart,policyEnd) : days(start,end);
    return targetMonths.map(month=>({month,amount:divisor
      ? amount * overlap([`${month}-01`,start].sort().at(-1),[monthEnd(month),end].sort()[0],policyStart,policyEnd)/divisor : 0}));
  }
  function eligibleRows(input){
    const kind = input.kind === 'purchases' ? 'purchases' : 'sales';
    const candidates = input.row ? [input.row] : Array.isArray(input.rows) ? input.rows : input.rows?.[kind] || [];
    return candidates.filter(row=>{
      const code=String(row.code || '');
      if(String(row.rate || '') !== '8' || !(kind === 'sales' ? ['1','11'].includes(code) : PURCHASE_CODES.includes(code))) return false;
      if(input.rowId !== undefined && row.id !== input.rowId) return false;
      if(input.businessType !== undefined && String(row.businessType || '') !== input.businessType) return false;
      if(input.creditRatio !== undefined && String(row.creditRatio || '') !== String(input.creditRatio)) return false;
      if(input.usage !== undefined && USAGES[code] !== input.usage) return false;
      if(input.purchaseKind === 'invoice' && EXEMPT_CODES.includes(code)) return false;
      if(input.purchaseKind === 'exempt' && !EXEMPT_CODES.includes(code)) return false;
      return true;
    });
  }
  function sourceFailure(input,start,end){
    const facts = input.sourceFacts;
    const value = facts?.status === 'resolved' ? facts.value : null;
    if(!value || value.periodConfirmed !== true || value.fullMonthCoverageConfirmed !== true)
      return '元CSVの正式期間・全月網羅が未確認です。';
    if(!value.sourceId || value.sourceId !== input.currentSourceId)
      return '元CSVの同一性を確認できません。期間の一致だけでは同じ資料と扱いません。';
    if((input.currentAggregateId || input.monthlyAggregateId)
      && (!input.currentAggregateId || input.currentAggregateId !== input.monthlyAggregateId))
      return '現在の補正後集計とCSV月別集計の対応を確認できません。';
    if(Number(input.dateUnknownCount || 0) > 0){
      const kind=input.kind==='purchases'?'purchases':'sales';
      const selected=new Set(eligibleRows(input).map(row=>key(kind,row)));
      const unknown=(Array.isArray(input.monthlyGroups)?input.monthlyGroups:[]).filter(group=>!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(group.month||'')));
      // Legacy saves with only a global count cannot locate missing dates.
      // New anonymous groups let unaffected classifications keep their shape.
      if(!selected.size||!unknown.length||unknown.some(group=>!['sales','purchases'].includes(group.kind||group.side)
        ||(group.kind||group.side)===kind&&selected.has(key(kind,group))))
        return '対応するCSV内訳に取引日不明の明細があります（又は不明箇所を特定できません）。';
    }
    const period=value.period || {};
    if(!days(period.start,period.end)) return '元CSVの正式期間が不正です。';
    const same=period.start === start && period.end === end;
    // Prior-year shape is a forecast, not source-period actuals. A changed
    // fiscal year, a missing leap-day endpoint or another source year is not
    // silently mapped by ordinal month.
    const prior=Number(start.slice(0,4))-Number(period.start.slice(0,4)) === 1
      && Number(end.slice(0,4))-Number(period.end.slice(0,4)) === 1
      && start.slice(5) === period.start.slice(5) && end.slice(5) === period.end.slice(5);
    if(!same && !prior) return '対象期と前年資料の月・期間対応が一致しません（決算期変更・異なる短期等）。';
    if(months(period.start,period.end).length !== months(start,end).length)
      return '元CSVと対象期の月数が一致しません。';
    return '';
  }

  // `amount` is the legacy input's food subset. For uniform mode it is an
  // annual source-price amount; manual mode already denotes the policy-period
  // amount. No repricing or tax computation occurs in this module.
  function estimate(input={}){
    const start=input.periodStart || '',end=input.periodEnd || '';
    const policyStart=input.policyStart || engine.FOOD_PROPOSAL.start;
    const policyEnd=input.policyEnd || engine.FOOD_PROPOSAL.end;
    const targetMonths=months(start,end);
    const amount=parsed(input.amount);
    const manual=input.mode === 'manual';
    const result={amount:null,method:'unavailable',label:'対象期間額未算定',reason:'',notes:[],monthly:[],parts:[],alreadyPeriodAmount:true};
    if(amount === null || !targetMonths.length || !days(policyStart,policyEnd)){
      result.reason='食品対象額または対象期間を確認できません。';return result;
    }
    const selectedRows=eligibleRows(input);
    if(input.kind !== 'purchases' && selectedRows.length
      && selectedRows.every(row=>String(row.code) === '11'))
      return {...result,amount:0,method:'original-rate-return',label:'返還は元取引の8％を維持',monthly:emptyMonths(targetMonths),
        notes:['旧8％売上の返品を食品1％の予測へ振り替えません。']};
    const periodOverlap=overlap(start,end,policyStart,policyEnd);
    if(manual){
      if(!periodOverlap && amount !== 0){result.reason='食品対象期間と重ならない期間に手入力対象額があります。';return result;}
      const monthly=uniformMonthly(amount,targetMonths,start,end,policyStart,policyEnd,true);
      return {...result,amount,method:'manual',label:'対象期間額を手入力',monthly,
        notes:['明示された対象期間額を使用しています。CSVや日数割合を再適用しません。']};
    }
    const fallback=reason=>{
      const monthly=uniformMonthly(amount,targetMonths,start,end,policyStart,policyEnd,false);
      return {...result,amount:sum(monthly),method:'uniform',label:'期間内日数均等配分',reason,monthly,
        notes:reason ? [`${reason}この部分は日数按分による仮定です。`] : ['取引は期間内に日数で均等発生すると仮定しています。']};
    };
    if(!periodOverlap) return {...result,amount:0,method:'outside',label:'食品1％対象期間外',monthly:emptyMonths(targetMonths)};
    const failure=sourceFailure(input,start,end);
    if(failure) return fallback(failure);
    const value=input.sourceFacts.value;
    const sourceMonths=months(value.period.start,value.period.end);
    const samePeriod=value.period.start === start && value.period.end === end;
    const rows=selectedRows;
    if(!rows.length) return fallback('現在の食品入力に対応するCSV行がありません。');
    const kind=input.kind === 'purchases' ? 'purchases' : 'sales';
    const rowGroups=new Map();
    for(const row of rows){
      const gross=parsed(row.amount),food=parsed(row.foodAmount);
      if(gross === null || food === null || Math.abs(food)>Math.abs(gross)+1e-7
        || (food !== 0 && Math.sign(food)!==Math.sign(gross))) return fallback('現在行の税込金額・食品内数を確認できません。');
      if(row.source !== 'csv' && row.source !== 'csv-edited') return fallback('手入力行には元CSVの月別構成を対応付けられません。');
      const groupKey=key(kind,row);
      const group=rowGroups.get(groupKey) || {gross:0,food:0,rows:[]};
      group.gross+=signed(kind,row,gross);group.food+=signed(kind,row,food);group.rows.push(row);
      rowGroups.set(groupKey,group);
    }
    const rowFood=[...rowGroups.values()].reduce((total,group)=>total+group.food,0);
    if(!close(rowFood,amount)) return fallback('食品内数と現在行の合計が一致しません。');
    const rawGroups=Array.isArray(input.monthlyGroups) ? input.monthlyGroups : [];
    const detailGroups=Array.isArray(input.foodMonthlyGroups) ? input.foodMonthlyGroups : null;
    const sourceByKey=new Map(),foodByKey=new Map();
    for(const [sourceGroups,destination] of [[rawGroups,sourceByKey],[detailGroups || [],foodByKey]]){
      for(const group of sourceGroups){
        if((group.kind || group.side) !== kind || String(group.rate) !== '8') continue;
        const groupKey=key(kind,group);
        if(!rowGroups.has(groupKey)) continue;
        if(!sourceMonths.includes(String(group.month || '')) || typeof group.amount !== 'number' || !Number.isFinite(group.amount))
          return fallback('対応するCSV月別集計に期間外・日付不明・不正金額があります。');
        const monthly=destination.get(groupKey) || [];
        monthly.push({month:group.month,amount:group.amount});destination.set(groupKey,monthly);
      }
    }
    const monthly=emptyMonths(targetMonths),parts=[],usedMethods=new Set();
    for(const [groupKey,group] of rowGroups){
      // A return uses its original rate. It must not be converted to 1%
      // merely because its return date lies inside the policy period.
      if(kind === 'sales' && group.rows.some(row=>String(row.code) === '11')){
        parts.push({key:groupKey,rowIds:group.rows.map(row=>row.id),amount:0,method:'original-rate-return',monthly:emptyMonths(targetMonths)});
        usedMethods.add('original-rate-return');continue;
      }
      const source=sourceByKey.get(groupKey);
      if(!source || !close(sum(source),group.gross)) return fallback('CSV月別合計と現在行が一致しません。金額・区分の修正を確認してください。');
      const detailed=foodByKey.get(groupKey);
      if(detailed && !close(sum(detailed),group.food)) return fallback('食品明細の月別合計と現在の食品内数が一致しません。');
      if(detailed){
        for(const sourceMonth of sourceMonths){
          const gross=sum(source.filter(item=>item.month === sourceMonth));
          const food=sum(detailed.filter(item=>item.month === sourceMonth));
          if(Math.abs(food)>Math.abs(gross)+1e-7 || (food !== 0 && Math.sign(food)!==Math.sign(gross)))
            return fallback('食品明細の月別内数が対応グループの範囲・符号と一致しません。');
        }
      }
      let pattern,method;
      if(detailed){
        pattern=detailed;method=samePeriod ? 'direct-food' : 'prior-food';
      }else if(group.food === 0 && group.rows.every(row=>row.foodAmountSource === 'manual')){
        pattern=[];method=samePeriod ? 'group-proxy' : 'prior-group-proxy';
      }else if(close(group.food,group.gross)){
        // Whole-group food classification allows signed direct sums even
        // when annual sales and adjustments cancel to zero. No division.
        pattern=source;method=samePeriod ? 'group-proxy' : 'prior-group-proxy';
      }else{
        const positive=source.some(row=>row.amount>0),negative=source.some(row=>row.amount<0);
        if(close(group.gross,0) || (positive && negative))
          return fallback('正負が混在又は年間差引0円のグループでは、食品内数の構成比を安全に求められません。');
        pattern=source.map(row=>({...row,amount:row.amount*group.food/group.gross}));
        method=samePeriod ? 'group-proxy' : 'prior-group-proxy';
      }
      const partMonths=emptyMonths(targetMonths);
      for(const entry of pattern){
        const index=sourceMonths.indexOf(entry.month),targetMonth=targetMonths[index];
        const monthStart=[`${targetMonth}-01`,start].sort().at(-1);
        const monthLast=[monthEnd(targetMonth),end].sort()[0];
        const coveredDays=days(monthStart,monthLast);
        partMonths[index].amount+=entry.amount*overlap(monthStart,monthLast,policyStart,policyEnd)/coveredDays;
      }
      addMonths(monthly,partMonths);usedMethods.add(method);
      parts.push({key:groupKey,rowIds:group.rows.map(row=>row.id),amount:sum(partMonths),method,monthly:partMonths});
    }
    const method=usedMethods.size === 1 ? [...usedMethods][0] : 'mixed';
    const labels={'direct-food':'対象期の食品明細を月別集計','prior-food':'前年の食品月別構成による推計',
      'group-proxy':'食品を含む課税区分グループの月別構成を代理利用','prior-group-proxy':'前年の課税区分グループの月別構成を代理利用',
      'original-rate-return':'返還は元取引の8％を維持',mixed:'食品明細・グループ別の月別推計'};
    const notes=[];
    if([...usedMethods].some(item=>item.includes('proxy')))
      notes.push('食品内数は同じ課税区分・事業区分・用途・控除割合のグループと同じ月別構成と仮定します。食品実額の月次内訳ではありません。');
    if(!samePeriod) notes.push(`元資料${value.period.start}〜${value.period.end}の前年同月を対象期へ対応させた予測です。`);
    if(targetMonths.some(month=>{
      const a=[`${month}-01`,start].sort().at(-1),b=[monthEnd(month),end].sort()[0];
      const affected=overlap(a,b,policyStart,policyEnd);return affected>0 && affected<days(a,b);
    })) notes.push('月途中の境界は、その月の対象期内日数で均等按分した概算です。日次実額ではありません。');
    if(usedMethods.has('original-rate-return')) notes.push('旧8％売上の返品を食品1％の予測へ振り替えません。');
    return {...result,amount:sum(monthly),method,label:labels[method],notes,monthly,parts};
  }

  // Reuse the exact selected period amounts for STEP4, rather than applying
  // the policy-period fraction again or normalising a signed zero-net ratio.
  function transactionDeltas({estimates,priceBasis='netFixed',annualDelta}={}){
    if(!Array.isArray(estimates) || !estimates.length || !Number.isSafeInteger(annualDelta))
      return {ready:false,reason:'税額計算と共有する対象期間額・年間取引差額がありません。',monthly:[]};
    if(estimates.some(item=>item?.amount === null || !Array.isArray(item?.monthly)))
      return {ready:false,reason:'対象期間額が未算定です。',monthly:[]};
    const monthKeys=estimates[0].monthly.map(item=>item.month);
    if(estimates.some(item=>JSON.stringify(item.monthly.map(row=>row.month))!==JSON.stringify(monthKeys)))
      return {ready:false,reason:'対象期間額の月列が一致しません。',monthly:[]};
    const gross=monthKeys.map((month,index)=>({month,amount:estimates.reduce((total,item)=>total+item.monthly[index].amount,0)}));
    const factor=priceBasis === 'grossFixed' ? 0 : -7/108;
    const monthly=gross.map(item=>({...item,amount:Math.round(item.amount*factor) || 0}));
    if(monthly.some(item=>!Number.isSafeInteger(item.amount)))
      return {ready:false,reason:'月別取引差額が安全な整数円の範囲を超えています。',monthly:[]};
    const residual=annualDelta-sum(monthly);
    const active=gross.findLastIndex(item=>item.amount !== 0);
    // Only ordinary yen rounding differences may be reconciled. A larger
    // mismatch is a stale/different calculation, not a reason to rescale.
    if(Math.abs(residual)>gross.filter(item=>item.amount !== 0).length || (active<0 && residual!==0))
      return {ready:false,reason:'対象期間額から作る月別差額とSTEP3の年間差額が一致しません。',monthly:[]};
    if(residual) monthly[active].amount+=residual;
    return {ready:true,monthly,reason:'',notes:['年税額に採用した同じ食品対象期間額を月別差額へ使用しています。対象期間割合を再適用しません。']};
  }
  return Object.freeze({estimate,transactionDeltas});
});
