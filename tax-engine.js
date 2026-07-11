(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiTaxEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const CONFIRMATION = Object.freeze({
    UNKNOWN:'unknown',
    YES:'yes',
    NO:'no'
  });

  const ELIGIBILITY = Object.freeze({
    ELIGIBLE:'eligible',
    UNKNOWN:'unknown',
    INELIGIBLE:'ineligible'
  });

  const EXEMPT_PURCHASE_RATES = Object.freeze([
    { start:'0001-01-01', end:'2023-10-01', ratio:1.00 },
    { start:'2023-10-01', end:'2026-10-01', ratio:0.80 },
    { start:'2026-10-01', end:'2028-10-01', ratio:0.70 },
    { start:'2028-10-01', end:'2030-10-01', ratio:0.50 },
    { start:'2030-10-01', end:'2031-10-01', ratio:0.30 },
    { start:'2031-10-01', end:'9999-12-31', ratio:0.00 }
  ]);

  function normalizeNumberString(raw){
    return String(raw ?? '')
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[．。]/g, '.')
      .replace(/[－−―]/g, '-')
      .replace(/[，,￥¥\s円]/g, '')
      .trim();
  }

  function parseAmountInput(raw, options = {}){
    const { allowNegative = false, min = null, max = null } = options;
    const normalized = normalizeNumberString(raw);
    if(normalized === ''){
      return { entered:false, valid:true, value:0, normalized:'', error:'' };
    }
    if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)){
      return { entered:true, valid:false, value:0, normalized, error:'数値として入力してください' };
    }
    const value = Number(normalized);
    if(!Number.isFinite(value)){
      return { entered:true, valid:false, value:0, normalized, error:'数値として入力してください' };
    }
    if(!allowNegative && value < 0){
      return { entered:true, valid:false, value, normalized, error:'負数は入力できません' };
    }
    if(min !== null && value < min){
      return { entered:true, valid:false, value, normalized, error:`${min}以上で入力してください` };
    }
    if(max !== null && value > max){
      return { entered:true, valid:false, value, normalized, error:`${max}以下で入力してください` };
    }
    return { entered:true, valid:true, value, normalized, error:'' };
  }

  function taxFromAmount(amount, rate, amountMode){
    if(amountMode === 'excluded') return amount * (rate / 100);
    return amount * (rate / (100 + rate));
  }

  function taxableBaseFromAmount(amount, rate, amountMode){
    if(amountMode === 'excluded') return amount;
    return amount - taxFromAmount(amount, rate, amountMode);
  }

  function calculateRegularAmount({ salesTax, invoiceTax, exemptCreditableTax, creditRatio, adjustment }){
    const creditablePurchaseTax = invoiceTax + exemptCreditableTax;
    const regularCredit = creditablePurchaseTax * creditRatio;
    return {
      creditablePurchaseTax,
      regularCredit,
      amount:salesTax - regularCredit + adjustment
    };
  }

  function formatShare(share){
    return `${(share * 100).toFixed(1)}％`;
  }

  function calculateSimplifiedTax(rows){
    const totalSalesTax = rows.reduce((sum, row) => sum + row.rowTax, 0);
    const totalTaxableBase = rows.reduce((sum, row) => sum + row.rowTaxableBase, 0);
    const normalCredit = rows.reduce((sum, row) => sum + row.rowTax * row.deemed, 0);
    const candidates = [{
      kind:'normal',
      deemedCredit:normalCredit,
      methodLabel:'通常計算',
      share:0
    }];
    const activeRows = rows.filter(row => row.rowTaxableBase > 0);

    if(totalTaxableBase > 0 && activeRows.length >= 2){
      activeRows.forEach(row => {
        const share = row.rowTaxableBase / totalTaxableBase;
        if(share + Number.EPSILON >= 0.75){
          candidates.push({
            kind:'single75',
            deemedCredit:totalSalesTax * row.deemed,
            methodLabel:`75％特例（${row.name}事業が${formatShare(share)}）`,
            share,
            keys:[row.key]
          });
        }
      });
    }

    if(totalTaxableBase > 0 && activeRows.length >= 3){
      for(let i = 0; i < activeRows.length - 1; i++){
        for(let j = i + 1; j < activeRows.length; j++){
          const first = activeRows[i];
          const second = activeRows[j];
          const share = (first.rowTaxableBase + second.rowTaxableBase) / totalTaxableBase;
          if(share + Number.EPSILON < 0.75) continue;
          const high = first.deemed >= second.deemed ? first : second;
          const low = high === first ? second : first;
          const deemedCredit = high.rowTax * high.deemed + (totalSalesTax - high.rowTax) * low.deemed;
          candidates.push({
            kind:'pair75',
            deemedCredit,
            methodLabel:`75％特例（${high.name}・${low.name}事業の合計が${formatShare(share)}）`,
            share,
            keys:[high.key, low.key]
          });
        }
      }
    }

    const selected = candidates.reduce((best, candidate) => (
      candidate.deemedCredit > best.deemedCredit + 1e-8 ? candidate : best
    ), candidates[0]);
    return {
      totalSalesTax,
      totalTaxableBase,
      normalCredit,
      deemedCredit:selected.deemedCredit,
      amount:totalSalesTax - selected.deemedCredit,
      method:selected.kind,
      methodLabel:selected.methodLabel,
      candidates
    };
  }

  function isoDateToEpochDay(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const [year, month, day] = value.split('-').map(Number);
    const time = Date.UTC(year, month - 1, day);
    const date = new Date(time);
    if(date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return Math.floor(time / 86400000);
  }

  function weightedExemptPurchaseRatio(startInclusive, endInclusive){
    const startDay = isoDateToEpochDay(startInclusive);
    const inclusiveEndDay = isoDateToEpochDay(endInclusive);
    if(startDay === null || inclusiveEndDay === null || inclusiveEndDay < startDay){
      return { valid:false, ratio:0, totalDays:0, breakdown:[] };
    }
    const endDay = inclusiveEndDay + 1;
    const totalDays = endDay - startDay;
    const breakdown = [];
    let weightedDays = 0;
    EXEMPT_PURCHASE_RATES.forEach(period => {
      const rateStart = isoDateToEpochDay(period.start);
      const rateEnd = isoDateToEpochDay(period.end);
      const overlapStart = Math.max(startDay, rateStart);
      const overlapEnd = Math.min(endDay, rateEnd);
      const days = Math.max(0, overlapEnd - overlapStart);
      if(!days) return;
      weightedDays += days * period.ratio;
      breakdown.push({ days, ratio:period.ratio, start:period.start, end:period.end });
    });
    return {
      valid:true,
      ratio:totalDays ? weightedDays / totalDays : 0,
      totalDays,
      breakdown
    };
  }

  function periodIncludes(start, end, targetStart, targetEnd){
    if(!start || !end || start > end) return false;
    return start <= targetEnd && end >= targetStart;
  }

  function eligibilityFrom(hardFailures, confirmations){
    const noReasons = confirmations.filter(item => item.value === CONFIRMATION.NO).map(item => item.noReason);
    if(hardFailures.length || noReasons.length){
      return { eligibility:ELIGIBILITY.INELIGIBLE, reasons:[...hardFailures, ...noReasons].filter(Boolean) };
    }
    const unknownReasons = confirmations.filter(item => item.value !== CONFIRMATION.YES).map(item => item.unknownReason);
    if(unknownReasons.length){
      return { eligibility:ELIGIBILITY.UNKNOWN, reasons:unknownReasons.filter(Boolean) };
    }
    return { eligibility:ELIGIBILITY.ELIGIBLE, reasons:[] };
  }

  function numericRequirement(entered, ok, overReason, unknownReason){
    if(!entered) return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason };
    return ok
      ? { value:CONFIRMATION.YES, noReason:'', unknownReason:'' }
      : { value:CONFIRMATION.NO, noReason:overReason, unknownReason:'' };
  }

  function specificPeriodRequirement(ctx){
    if(ctx.specificUnder10m){
      return { value:CONFIRMATION.YES, noReason:'', unknownReason:'' };
    }
    if(!ctx.specificInputEntered){
      return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason:'特定期間の課税売上高または給与等支払額が未確認です' };
    }
    if(ctx.specificSalesEntered && ctx.specificTaxableSales > 10000000 && !ctx.specificPayrollEntered){
      return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason:'特定期間の給与等支払額が未確認です' };
    }
    if(ctx.specificPayrollEntered && ctx.specificPayrollAmount > 10000000 && !ctx.specificSalesEntered){
      return { value:CONFIRMATION.UNKNOWN, noReason:'', unknownReason:'特定期間の課税売上高が未確認です' };
    }
    return { value:CONFIRMATION.NO, noReason:'特定期間の要件により免税点制度の適用が制限されます', unknownReason:'' };
  }

  function calculateEligibility(ctx){
    const periodValid = !!ctx.start && !!ctx.end && ctx.start <= ctx.end;
    const commonSpecialConfirmations = [
      {
        value:ctx.invoiceRegistered,
        noReason:'インボイス発行事業者の登録を受けていません',
        unknownReason:'インボイス発行事業者の登録が未確認です'
      },
      {
        value:ctx.invoiceTransition,
        noReason:'インボイス登録がなくても課税事業者となる期間です',
        unknownReason:'登録がなければ免税事業者となるか未確認です'
      },
      numericRequirement(
        ctx.baseSalesEntered,
        ctx.baseTaxableSales <= 10000000,
        '基準期間の課税売上高が1,000万円超です',
        '基準期間の課税売上高が未確認です'
      ),
      specificPeriodRequirement(ctx),
      {
        value:ctx.noSpecialExclusion,
        noReason:'2割特例・3割特例の適用除外に該当します',
        unknownReason:'2割特例・3割特例の適用除外が未確認です'
      }
    ];

    const twoHardFailures = [];
    if(!periodValid || !periodIncludes(ctx.start, ctx.end, '2023-10-01', '2026-09-30')) twoHardFailures.push('2割特例の対象期間外です');
    if(ctx.entity === 'individual' && !ctx.individualCalendarYear) twoHardFailures.push('個人事業者の暦年以外の課税期間は対象外として扱います');

    const threeHardFailures = [];
    if(ctx.entity !== 'individual') threeHardFailures.push('法人は3割特例の対象外です');
    if(ctx.entity === 'individual' && !ctx.individualCalendarYear) threeHardFailures.push('個人事業者の暦年以外の課税期間は対象外として扱います');
    if(!periodValid || !periodIncludes(ctx.start, ctx.end, '2027-01-01', '2028-12-31')) threeHardFailures.push('令和9年分・令和10年分ではありません');

    const simplifiedConfirmations = [
      numericRequirement(
        ctx.baseSalesEntered,
        ctx.baseTaxableSales <= 50000000,
        '基準期間の課税売上高が5,000万円超です',
        '基準期間の課税売上高が未確認です'
      ),
      {
        value:ctx.simpleNoticeReady,
        noReason:'簡易課税制度選択届出書が当該課税期間に有効ではなく、適用可能な期限内にも提出できません',
        unknownReason:'簡易課税制度選択届出書の有効性・提出期限が未確認です'
      }
    ];

    const regular = eligibilityFrom([], [{
      value:ctx.regularCreditConfirmed,
      noReason:'本則課税の仕入控除率を設定してください',
      unknownReason:'本則課税の仕入控除率が未確認です'
    }]);

    return {
      periodValid,
      regular,
      simplified:eligibilityFrom([], simplifiedConfirmations),
      special2:eligibilityFrom(twoHardFailures, commonSpecialConfirmations),
      special3:eligibilityFrom(threeHardFailures, commonSpecialConfirmations)
    };
  }

  function sanitizeCsvCell(value){
    const text = String(value ?? '');
    return typeof value === 'string' && /^[=+\-@]/.test(text) ? `'${text}` : text;
  }

  function serializeStateIfEnabled(enabled, data){
    return enabled ? JSON.stringify(data) : null;
  }

  return Object.freeze({
    CONFIRMATION,
    ELIGIBILITY,
    EXEMPT_PURCHASE_RATES,
    normalizeNumberString,
    parseAmountInput,
    taxFromAmount,
    taxableBaseFromAmount,
    calculateRegularAmount,
    calculateSimplifiedTax,
    weightedExemptPurchaseRatio,
    periodIncludes,
    calculateEligibility,
    sanitizeCsvCell,
    serializeStateIfEnabled
  });
});
