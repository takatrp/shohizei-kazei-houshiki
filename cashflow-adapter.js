(function(root, factory){
  const api = factory(typeof module === 'object' && module.exports
    ? require('./tax-engine.js') : root.ShohizeiTaxEngine);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiCashflowAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(taxEngine){
  'use strict';

  const POLICY = taxEngine.FOOD_PROPOSAL;
  const PURCHASE_CODES = new Set(['5','6','7','52','62','72']);

  function isoDay(value){
    const text = String(value || '');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if(!match) return null;
    const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0,10) === text ? day : null;
  }

  function monthNumber(value){
    const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
    if(!match) return null;
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? Number(match[1]) * 12 + month - 1 : null;
  }

  function monthLabel(number){
    return `${String(Math.floor(number / 12)).padStart(4,'0')}-${String(number % 12 + 1).padStart(2,'0')}`;
  }

  function monthsBetween(start, end){
    const first = monthNumber(String(start || '').slice(0,7));
    const last = monthNumber(String(end || '').slice(0,7));
    if(first === null || last === null || last < first || last - first > 239) return [];
    return Array.from({length:last - first + 1}, (_, index) => monthLabel(first + index));
  }

  function overlapDays(aStart, aEnd, bStart, bEnd){
    const first = Math.max(isoDay(aStart)?.getTime() ?? NaN, isoDay(bStart)?.getTime() ?? NaN);
    const last = Math.min(isoDay(aEnd)?.getTime() ?? NaN, isoDay(bEnd)?.getTime() ?? NaN);
    return Number.isFinite(first) && Number.isFinite(last) && last >= first
      ? Math.round((last - first) / 86400000) + 1 : 0;
  }

  function eligibleMonthDays(month, periodStart, periodEnd){
    const start = `${month}-01`;
    const number = monthNumber(month);
    const end = new Date(Date.UTC(Math.floor((number + 1) / 12), (number + 1) % 12, 0)).toISOString().slice(0,10);
    const first = [start, periodStart, POLICY.start].sort().at(-1);
    const last = [end, periodEnd, POLICY.end].sort()[0];
    return overlapDays(first, last, first, last);
  }

  function roundedYen(value){
    if(typeof value !== 'number' || !Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    return Number.isSafeInteger(rounded) ? rounded || 0 : null;
  }

  function allocateExact(total, months, weights){
    if(!months.length || !Number.isSafeInteger(total)) return [];
    const sum = weights.reduce((value, weight) => value + weight, 0);
    if(!Number.isFinite(sum) || Math.abs(sum) < 1e-9) return [];
    // Put the rounding residual on the final eligible, non-zero-weight month.
    // The last calendar month can be outside the food proposal period.
    const lastActive = weights.findLastIndex(weight => Math.abs(weight) >= 1e-9);
    let allocated = 0;
    const result = [];
    for(let index = 0; index < months.length; index++){
      const amount = index === lastActive ? total - allocated
        : Math.abs(weights[index]) < 1e-9 ? 0 : Math.round(total * weights[index] / sum);
      if(!Number.isSafeInteger(amount)) return [];
      allocated += amount;
      result.push({month:months[index],amount});
    }
    return result;
  }

  function rowGroupKey(kind, row){
    const code = String(row.code || '').trim();
    const rate = String(row.rate || '').trim();
    const business = kind === 'sales' ? String(row.businessType || '').trim() : '';
    const ratio = ['52','62','72'].includes(code) ? String(row.creditRatio || '').replace(/%$/, '').trim() : '';
    return `${kind}|${code}|${rate}|${business}|${ratio}`;
  }

  function csvMonthDistribution(kind, rows, groups, months, periodStart, periodEnd, sourceStart, sourceEnd,
    sourcePeriodConfirmed, dateUnknownCount, annualDelta, priceBasis){
    const notes = [];
    if(sourcePeriodConfirmed !== true)
      return {deltas:null, reason:'元資料期間と全月網羅が未確認のため、CSV月別構成を使えません。'};
    if(dateUnknownCount > 0)
      return {deltas:null, reason:`CSVの取引日不明明細が${dateUnknownCount}件あり、月別構成を検算できません。`};
    const sourceMonths = monthsBetween(sourceStart, sourceEnd);
    if(!isoDay(sourceStart) || !isoDay(sourceEnd) || sourceMonths.length !== months.length){
      return {deltas:null, reason:'元CSVの正式な対象期間が未確認、または対象期と月数が異なるため、CSV月別構成を使えません。'};
    }
    if(!Array.isArray(groups) || !groups.length){
      return {deltas:null, reason:'保存データにCSV月別情報がないため、CSV月別構成を使えません。'};
    }
    const eligible = months.filter(month => eligibleMonthDays(month, periodStart, periodEnd) > 0);
    if(!eligible.length) return annualDelta === 0
      ? {deltas:months.map(month => ({month,amount:0})), notes}
      : {deltas:null, reason:'食品1％の対象期間と対象期が重ならないのに取引差額があります。'};

    // The editable rows remain authoritative. CSV groups supply only a shape.
    // A missing row/group or a zero-net group cannot supply a reliable ratio.
    const currentRows = (rows?.[kind] || []).filter(row => {
      const code = String(row.code || '').trim();
      return (kind === 'sales' ? ['1','11'].includes(code) : PURCHASE_CODES.has(code))
        && String(row.rate || '').trim() === '8'
        && String(row.foodAmount ?? '').trim() !== '';
    });
    const selected = new Map();
    for(const row of currentRows){
      const food = Number(String(row.foodAmount).replace(/,/g,''));
      const amount = Number(String(row.amount ?? '').replace(/,/g,''));
      if(!Number.isFinite(food) || !Number.isFinite(amount))
        return {deltas:null, reason:'現在の食品対象額または行金額を確認できません。'};
      if(food === 0) continue;
      if(row.source !== 'csv' && row.source !== 'csv-edited')
        return {deltas:null, reason:'手入力の食品対象行にはCSVの月別構成を対応付けられません。'};
      const key = rowGroupKey(kind,row);
      const item = selected.get(key) || {amount:0,food:0,edited:false};
      item.amount += (kind === 'sales' && String(row.code) === '11' ? -amount : amount);
      item.food += (kind === 'sales' && String(row.code) === '11' ? -food : food);
      item.edited ||= row.source === 'csv-edited';
      selected.set(key,item);
    }
    if(annualDelta === 0 && !selected.size) return {deltas:months.map(month => ({month,amount:0})), notes};
    if(!selected.size) return {deltas:null, reason:'現在行の食品対象額とCSV月別構成を対応付けられません。'};

    const byKey = new Map();
    for(const group of groups){
      if((group.kind || group.side) !== kind || String(group.rate || '') !== '8') continue;
      const month = String(group.month || '');
      if(!sourceMonths.includes(month))
        return {deltas:null, reason:'CSV月別情報に確認した元資料期間外または日付不明の取引があります。'};
      const amount = Number(group.amount);
      if(!Number.isFinite(amount)) return {deltas:null, reason:'CSV月別構成の金額を確認できません。'};
      const key = rowGroupKey(kind,group);
      const sums = byKey.get(key) || new Map();
      sums.set(month, (sums.get(month) || 0) + amount);
      byKey.set(key,sums);
    }
    const targetWeights = new Map(months.map(month => [month,0]));
    let edited = false;
    for(const [key, row] of selected){
      const source = byKey.get(key);
      if(!source) return {deltas:null, reason:'現在行の課税区分・税率・事業区分・控除割合に対応するCSV月別構成がありません。'};
      const sourceTotal = [...source.values()].reduce((sum,value) => sum + value,0);
      if(Math.abs(sourceTotal) < 1e-9 || Math.abs(row.amount) < 1e-9)
        return {deltas:null, reason:'差引0円のグループでは食品内数の月別構成を特定できません。'};
      if(Math.abs(sourceTotal - row.amount) > 1e-7){
        if(!row.edited) return {deltas:null, reason:'CSV月別合計と未修正の入力行が一致しません。日付不明・補正後の集計範囲を確認してください。'};
        edited = true;
      }
      for(let index = 0; index < sourceMonths.length; index++){
        const month = months[index];
        if(!targetWeights.has(month) || !eligible.includes(month)) continue;
        const sourceMonth = sourceMonths[index];
        const sourceGross = source.get(sourceMonth) || 0;
        // The food part is unlabelled in the journal; retain the selected
        // group's signed monthly pattern, not the whole-business pattern.
        const monthDays = eligibleMonthDays(month, periodStart, periodEnd);
        const calendarDays = new Date(Date.UTC(Math.floor((monthNumber(month) + 1) / 12),
          (monthNumber(month) + 1) % 12,0)).getUTCDate();
        targetWeights.set(month, targetWeights.get(month) + sourceGross * row.food / sourceTotal * monthDays / calendarDays);
      }
    }
    const weights = months.map(month => targetWeights.get(month));
    const weightSum = weights.reduce((sum,weight) => sum + weight,0);
    if(annualDelta === 0 && Math.abs(weightSum) < 1e-9 && weights.some(weight => Math.abs(weight) >= 1e-9)){
      // A sale and its later full return cancel annually but not month by month.
      // Use the same 8%-to-1% price projection helper as the main calculation,
      // and accept the restored shape only if it reconciles to STEP3's annual 0.
      const projected = taxEngine.projectPrice({netAmount:100,grossAmount:108,ratePercent:1,
        priceBasis:priceBasis === 'grossFixed' ? 'grossFixed' : 'netFixed'});
      const factor = (projected.grossAmount - 108) / 108;
      const amounts = weights.map(weight => roundedYen(weight * factor));
      if(amounts.some(amount => amount === null))
        return {deltas:null, reason:'CSVの正負月別構成を円単位へ換算できません。'};
      const remainder = -amounts.reduce((sum,amount) => sum + amount,0);
      if(Math.abs(remainder) > weights.filter(weight => Math.abs(weight) >= 1e-9).length)
        return {deltas:null, reason:'CSVの正負月別構成とSTEP3の年間差額が一致しません。'};
      if(remainder) amounts[weights.findLastIndex(weight => Math.abs(weight) >= 1e-9)] += remainder;
      notes.push('売上と返品等の年間差引が0円でも、復元できる月別の正負は保持しています。');
      notes.push('CSV月別構成比による配分概算です。実際の入出金を再現したものではありません。');
      notes.push('CSVに食品商品別の月次区分はないため、食品内数は同じ課税区分グループの月別構成と仮定しています。');
      return {deltas:months.map((month,index) => ({month,amount:amounts[index]})),notes};
    }
    const deltas = allocateExact(annualDelta, months, weights);
    if(!deltas.length) return {deltas:null, reason:'CSVの対象月構成比が差引0円となり、現在の年額差を配分できません。'};
    notes.push('CSV月別構成比による配分概算です。実際の入出金を再現したものではありません。');
    notes.push('CSVに食品商品別の月次区分はないため、食品内数は同じ課税区分グループの月別構成と仮定しています。');
    if(edited) notes.push('CSV取込後の金額修正を反映し、同じ区分の元CSV月別構成比を参考利用しています。');
    if(sourceStart !== periodStart || sourceEnd !== periodEnd)
      notes.push(`元資料期間${sourceStart}〜${sourceEnd}の月順を対象期${periodStart}〜${periodEnd}へ対応付けています。`);
    return {deltas,notes};
  }

  function uniformDistribution(total, months, periodStart, periodEnd){
    const weights = months.map(month => eligibleMonthDays(month,periodStart,periodEnd));
    if(!weights.some(Boolean)) return total === 0 ? months.map(month => ({month,amount:0})) : null;
    return allocateExact(total,months,weights);
  }

  function create({ctx,calc,comparison,methodKey,taxEntryRows,csvMonthlyGroups,
    distribution = 'uniform',sourcePeriodStart = '',sourcePeriodEnd = '',sourcePeriodConfirmed = false,
    csvMonthlyDateUnknownCount = 0} = {}){
    const reasons = [];
    const assumptions = [];
    const periodStart = ctx?.start || calc?.ctx?.start || '';
    const periodEnd = ctx?.end || calc?.ctx?.end || '';
    const months = monthsBetween(periodStart,periodEnd);
    if(!isoDay(periodStart) || !isoDay(periodEnd) || !months.length) reasons.push('対象期の開始日・終了日を確認してください。');
    if(ctx?.taxScenario !== 'foodProposal' && calc?.ctx?.taxScenario !== 'foodProposal')
      reasons.push('資金繰り差額は食品1％試算を選択した場合だけ計算します。');
    if(ctx && calc?.ctx && (ctx.start !== calc.ctx.start || ctx.end !== calc.ctx.end
      || ctx.taxScenario !== calc.ctx.taxScenario))
      reasons.push('STEP3とSTEP4の対象期・計算前提が一致しません。再計算してください。');
    const row = comparison?.rows?.find(item => item.key === methodKey) || null;
    if(!row) reasons.push('STEP3で比較する申告方式を選択してください。');
    const selectedMethod = calc?.methods?.find(item => item.key === methodKey);
    if(Number.isFinite(selectedMethod?.amount) && Number.isFinite(row?.proposalAmount)
      && Math.abs(selectedMethod.amount - row.proposalAmount) > 1e-7)
      reasons.push('STEP3比較額と現在の入力に基づく計算額が一致しません。再計算してください。');
    if(selectedMethod?.eligibility === 'ineligible' || row?.proposalMethod?.eligibility === 'ineligible'
      || row?.currentMethod?.eligibility === 'ineligible') reasons.push('選択した方式は入力条件では適用対象外です。');
    const taxReasons = [...(row?.reasons || []),...(comparison?.current ? [] : ['現行税率側の税額を算定できません。'])];
    const baselineTax = roundedYen(row?.currentAmount);
    const proposalTax = roundedYen(row?.proposalAmount);
    const taxReady = reasons.length === 0 && baselineTax !== null && proposalTax !== null;
    if(!taxReady && row && !taxReasons.length) taxReasons.push('STEP3の両案の当期税額を確認できません。');
    if(row?.reference) assumptions.push('税額は適用・区分等の未確認を含む参考値です。');
    if(calc?.csvRecoveryText) assumptions.push(calc.csvRecoveryText);
    if(calc?.csvOriginText) assumptions.push(calc.csvOriginText);
    if(calc?.csvReview?.reviewItems?.length) assumptions.push('CSVの明示1％仕訳には元取引未確認事項があります。');
    const rawSalesDelta = typeof calc?.sales?.totalAmount === 'number' && typeof comparison?.current?.sales?.totalAmount === 'number'
      ? calc.sales.totalAmount - comparison.current.sales.totalAmount : null;
    const rawPurchaseDelta = typeof calc?.purchases?.totalAmount === 'number' && typeof comparison?.current?.purchases?.totalAmount === 'number'
      ? calc.purchases.totalAmount - comparison.current.purchases.totalAmount : null;
    const annualSalesDelta = roundedYen(rawSalesDelta);
    const annualPurchaseDelta = roundedYen(rawPurchaseDelta);
    if(annualSalesDelta === null || annualPurchaseDelta === null)
      reasons.push('STEP3の両案の税込売上・仕入額を確認できません。');
    const distributionNotes = [];
    const bySide = {sales:'uniform',purchases:'uniform'};
    const signedZeroNetSales = annualSalesDelta === 0 && calc?.ctx?.foodSalesPriceBasis !== 'grossFixed'
      && (taxEntryRows?.sales || []).some(row => String(row.code) === '11'
        && String(row.rate) === '8' && Number(String(row.foodAmount || '').replace(/,/g,'')) > 0);
    const allocate = (kind,total) => {
      if(total === null || !months.length) return null;
      if(distribution === 'csv'){
        const source = csvMonthDistribution(kind,taxEntryRows,csvMonthlyGroups,months,periodStart,periodEnd,
          sourcePeriodStart,sourcePeriodEnd,sourcePeriodConfirmed,csvMonthlyDateUnknownCount,total,
          kind === 'sales' ? calc?.ctx?.foodSalesPriceBasis : calc?.ctx?.foodPurchasePriceBasis);
        if(source.deltas){
          bySide[kind] = 'csv';
          distributionNotes.push(...(source.notes || []));
          return source.deltas;
        }
        if(kind === 'sales' && signedZeroNetSales){
          reasons.push(`年間差引0円の食品売上・返品について、月別の正負を復元できません。${source.reason}`);
          return null;
        }
        distributionNotes.push(`${kind === 'sales' ? '売上' : '仕入'}：${source.reason}日数均等配分へ切り替えました。`);
      }
      if(kind === 'sales' && signedZeroNetSales){
        reasons.push('年間差引0円の食品売上・返品について、月別内訳がないため資金の増減時期を算定できません。CSV月別構成を確認してください。');
        return null;
      }
      return uniformDistribution(total,months,periodStart,periodEnd);
    };
    const salesDeltas = allocate('sales',annualSalesDelta);
    const purchaseDeltas = allocate('purchases',annualPurchaseDelta);
    const used = bySide.sales === bySide.purchases ? bySide.sales : 'mixed';
    if(!salesDeltas || !purchaseDeltas){
      reasons.push(months.some(month => eligibleMonthDays(month,periodStart,periodEnd) > 0)
        ? 'STEP3の取引差額を月別に配分できません。CSV月別内訳と配分前提を確認してください。'
        : '食品1％の対象期間と対象期が重ならず、STEP3の取引差額を配分できません。');
    }
    if(used === 'uniform') distributionNotes.push('対象期の取引差額を食品1％対象期間と重なる各月の日数で均等配分した概算です。');
    return {
      ready:reasons.length === 0,
      periodStart:periodStart.slice(0,7), periodEnd:periodEnd.slice(0,7), methodKey,
      annualTax:{base:taxReady ? baselineTax : null,changed:taxReady ? proposalTax : null,
        status:taxReady ? row?.reference ? 'reference' : 'calculated' : 'unavailable',
        reasons:taxReady ? row?.reasons || [] : taxReasons,reference:Boolean(row?.reference),
        raw:{base:row?.currentAmount ?? null,changed:row?.proposalAmount ?? null}},
      annualSalesDelta, annualPurchaseDelta,
      salesDeltas:salesDeltas || [], purchaseDeltas:purchaseDeltas || [],
      distribution:{requested:distribution === 'csv' ? 'csv' : 'uniform',used,bySide,
        notes:[...new Set(distributionNotes)]},
      assumptions:[...new Set(assumptions)],reasons,
      source:{policyStart:POLICY.start,policyEnd:POLICY.end,
        originalSalesDelta:rawSalesDelta,originalPurchaseDelta:rawPurchaseDelta,
        sourcePeriodStart,sourcePeriodEnd,sourcePeriodConfirmed,csvMonthlyDateUnknownCount}
    };
  }

  return Object.freeze({create});
});
