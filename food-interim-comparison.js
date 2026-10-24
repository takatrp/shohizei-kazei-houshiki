(function(root, factory){
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./tax-engine.js') : root.ShohizeiTaxEngine,
    isNode ? require('./interim-tax-engine.js') : root.ShohizeiInterimTax,
    isNode ? require('./tax-calendar.js') : root.ShohizeiTaxCalendar);
  if(isNode) module.exports = api;
  root.ShohizeiFoodInterimComparison = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(tax, interim, calendar){
  'use strict';
  const POLICY_VERSION = 'nta-food-qa-2026-09-q3-8-proposal';
  const SOURCE_URL = 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0026008-127_qa.pdf';
  const POLICY_NOTICE = '食品1％改正案の政策試算です。制度成立・正式様式の確認前で、特例の利用予定や申告を意味しません。中間納付の変更は年税額の減少ではありません。';
  const deemed = Object.freeze({type1:.9,type2:.8,type3:.7,type4:.6,type5:.5,type6:.4});
  const missing = (reasons,category = 'b') => ({status:'unavailable',national:null,local:null,total:null,
    reasons:[...new Set(reasons)],blockers:[...new Set(reasons)].map(reason => ({category,reason}))});
  const entered = value => value !== '' && value !== null && value !== undefined;
  const validMoney = value => entered(value) && interim.exactYen(value) !== null;

  // Q3-8 tests the start of each interim period and the start of its actual
  // immediately preceding taxable period. The filing-frequency basis is never
  // replaced by a hypothetical recalculation.
  function stageForInstallment(installment, priorStart){
    if(!calendar.parseDate(installment?.interimStart) || !calendar.parseDate(priorStart)) return null;
    if(installment.interimStart >= '2029-04-01' && priorStart <= '2029-03-31') return 'restoration';
    if(installment.interimStart >= '2027-04-01' && priorStart <= '2027-03-31') return 'reduction';
    return null;
  }

  // Reprice actual prior-period tax-exclusive turnover, not the amount of its
  // final tax. The 1%/8% fiction is limited to food. Other reduced-rate supplies
  // (newspapers), standard-rate transactions and their credit rules stay intact.
  function recalculatePrior(prior = {}, stage){
    const reasons = [];
    if(prior.source !== 'actual') reasons.push('実際の前期資料が必要です。当期入力・STEP3代理額は使えません。');
    if(!['reduction','restoration'].includes(stage)) reasons.push('中間特例の開始時・終了時の区分を確認してください。');
    if(!calendar.parseDate(prior.period?.start) || !calendar.parseDate(prior.period?.end)
      || prior.period.start > prior.period.end) reasons.push('実際の前課税期間を確認してください。');
    if(!['regular','simplified','special2','special3'].includes(prior.exactMethod))
      reasons.push('前期の正確な申告方式が必要です。旧保存の「一般課税など」は正確な一般課税の履歴として使えません。');
    if(!Array.isArray(prior.transactions) || !prior.transactions.length)
      reasons.push('前期の食品・その他の売上と、必要な仕入内訳を補足してください（該当なしは0円）。');
    if(reasons.length) return missing(reasons);
    const sales = [], purchases = [], nationalBases = {'1':0,'8':0,'10':0};
    const purchaseGroups = new Map();
    const salesReturnGroups = new Map();
    const salesBusinesses = new Set();
    const blockers = [];
    const block = (category,reason) => {reasons.push(reason);blockers.push({category,reason});};
    let taxableSales = 0;
    let salesSeen = false, purchasesSeen = false;
    const transactionSnapshot = [];
    prior.transactions.forEach((item,index) => {
      const label = `前期内訳${index+1}`;
      if(item?.side==='purchases' && prior.exactMethod!=='regular'){
        transactionSnapshot.push({side:'purchases',usedForMethod:false,reason:'この方式は売上税額を基礎とし、実仕入額を使用しません。'});
        return;
      }
      const amount = interim.exactYen(item?.amount);
      const originalRate = Number(item?.originalRate);
      const sourceCode = String(item?.sourceTaxCode ?? item?.taxCode ?? '');
      const kind = item?.transactionKind || 'ordinary';
      const returned = kind === 'return' || kind === 'adjustment'
        && (sourceCode === '11' || item?.returnConfirmed === true);
      if(item?.importComponent || ['55','65','75'].includes(sourceCode)){
        block('a',`${label}の輸入は、実額国税・地方税があっても中間特例の食品税率再計算方法を制度資料で確認する必要があります。`);return;
      }
      if(!['sales','purchases'].includes(item?.side) || amount === null
        || ![1,8,10].includes(originalRate) || !['food','other'].includes(item?.category)){
        block('b',`${label}の税込金額・元税率・食品区分を確認してください。`);return;
      }
      if(!returned && (kind !== 'ordinary' || amount < 0)){
        block('b',`${label}の負額・調整は返品か取消かを元取引で確認してください。`);return;
      }
      if(item.category === 'food' && originalRate === 10 || item.category === 'other' && originalRate === 1){
        block('b',`${label}の食品区分と元税率が整合しません。`);return;
      }
      if(returned && !['taxable','exempt'].includes(item.originalTaxableState)){
        block('b',`${label}の元取引時の課税・免税状態が未確認です。元税率だけで返還税額を控除しません。`);return;
      }
      if(returned && item.amountDirection !== undefined && !['return','signed'].includes(item.amountDirection)){
        block('b',`${label}の返還額の符号方向が未確認です。`);return;
      }
      // Return amounts are positive in code 11 rows, while journal sidecars
      // already carry tax-direction signs. Never apply both reversals.
      const returnAmount = returned ? item.amountDirection === 'signed' ? -amount : amount : 0;
      const direction = returned && returnAmount < 0 ? -1 : 1;
      const magnitude = returned ? Math.abs(returnAmount) : amount;
      const rate = returned ? originalRate : item.category === 'food' ? stage === 'reduction' ? 1 : 8 : originalRate;
      const net = tax.taxableBaseFromAmount(magnitude,originalRate,'included');
      if(!Number.isFinite(net)){block('b',`${label}の税抜換算額を算定できません。`);return;}
      transactionSnapshot.push({side:item.side,originalRate,rate,category:item.category,gross:amount,net,
        transactionKind:returned ? 'return' : 'ordinary',signedAmount:returned ? -returnAmount : amount,
        ...(returned ? {originalTaxableState:item.originalTaxableState,returnAmount,amountDirection:item.amountDirection || 'return'} : {})});
      if(returned && item.originalTaxableState === 'exempt'){
        // NTA 6359 / 6363: a return relating to a period when this taxpayer was
        // exempt cannot create a sales-return credit or reverse purchase credit.
        if(item.side === 'sales')salesSeen = true;else purchasesSeen = true;
        return;
      }
      if(item.side === 'sales'){
        salesSeen = true;
        if(magnitude>0)salesBusinesses.add(String(item.businessType||''));
        taxableSales += returned ? -direction * net : net;
        if(returned){
          const key = JSON.stringify([rate,direction]);
          const group = salesReturnGroups.get(key) || {rate,direction,tax:0,gross:0};
          group.tax += net * rate * .78 / 100;group.gross += magnitude;
          salesReturnGroups.set(key,group);
        }else nationalBases[rate] += net;
        if(prior.exactMethod === 'simplified' && !Object.hasOwn(deemed,item.businessType))
          block('b',`${label}の法令上の事業区分が未確認です。`);
        if(!returned)sales.push({ratePercent:rate,amount:net,amountMode:'excluded',businessKey:item.businessType,
          deemed:deemed[item.businessType],foodOnePercent:item.category === 'food' && rate === 1});
      }else{
        purchasesSeen = true;
        const ratio = item.creditRatio;
        if(prior.exactMethod === 'regular' && (!['taxableOnly','nonTaxableOnly','common'].includes(item.usage)
          || !entered(ratio) || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)){
          block('b',`${label}の仕入用途区分・控除割合が未確認です。`);return;
        }
        const transactionKind = returned ? 'return' : 'ordinary';
        const key = JSON.stringify([item.usage,rate,ratio,transactionKind,direction]);
        const group = purchaseGroups.get(key) || {usage:item.usage,rate,ratio,tax:0,transactionKind,direction};
        group.tax += net * rate * .78 / 100;
        purchaseGroups.set(key,group);
        if(!returned)purchases.push({ratePercent:rate,amount:net,amountMode:'excluded',creditRatio:ratio});
      }
    });
    if(!salesSeen) reasons.push('前期売上の内訳が未入力です（該当なしは0円）。');
    if(prior.exactMethod === 'regular' && !purchasesSeen) reasons.push('前期仕入の内訳が未入力です（該当なしは0円）。');
    const nonTaxable = interim.exactYen(prior.nonTaxableSales);
    const adjustment = interim.exactYen(prior.adjustmentNational);
    if(prior.exactMethod === 'regular'){
      if(nonTaxable === null || nonTaxable < 0) reasons.push('前期非課税売上を入力してください（該当なしは0円）。');
      if(adjustment === null) reasons.push('前期の国税個別調整を入力してください（該当なしは0円）。');
      if(!['full','individual','proportional'].includes(prior.creditMethod)) reasons.push('前期の仕入税額控除方法が未確認です。');
    }
    if(reasons.length){const result=missing(reasons);result.blockers=reasons.map(reason => blockers.find(item=>item.reason===reason)||{category:'b',reason});return result;}
    const nationalSales = tax.calculateNationalSalesTax({taxableBase10:nationalBases['10'],
      taxableBaseReduced:nationalBases['8'],taxableBaseFood1:nationalBases['1']});
    const nationalSalesReturnTax = [...salesReturnGroups.values()].reduce((sum,group) => sum + group.direction * Math.floor(group.tax + 1e-9),0);
    let nationalCredit = 0;
    let calculation;
    if(prior.exactMethod === 'regular'){
      if(taxableSales<0) return missing(['返品控除後の課税売上高が純負額です。この案件の元期・用途区分・返還調整を含む課税売上割合の資料を確認してください。0％や100％へ補完せず特例額だけ未算定です。'],'b');
      const assessment = tax.assessFullCreditPeriod({periodStart:prior.period.start,periodEnd:prior.period.end,
        taxableSales,nonTaxableSales:nonTaxable});
      if(!assessment.valid) return missing(assessment.reasons);
      if(prior.creditMethod === 'full' && !assessment.fullCreditEligible)
        return missing(['前期の全額控除要件（年換算5億円・課税売上割合95％）を満たしません。用途別又は比例配分の控除方法が必要です。']);
      const ratio = taxableSales + nonTaxable > 0 ? taxableSales / (taxableSales + nonTaxable) : null;
      if(prior.creditMethod !== 'full' && ratio === null) return missing(['前期の課税売上割合の分母が0円です。']);
      const grouped = [...purchaseGroups.values()].map(group => ({...group,credit:Math.floor(group.tax * group.ratio + 1e-9),
        sign:group.transactionKind === 'return' ? -group.direction : 1}));
      // Full/proportional methods round each tax-rate and exemption-ratio
      // aggregate, not each usage bucket. Individual allocation cannot silently
      // discard a one-yen discrepancy between those two stages.
      const byRate = new Map();
      for(const group of grouped){
        const key = JSON.stringify([group.rate,group.ratio,group.transactionKind,group.direction]);
        const aggregate=byRate.get(key)||{tax:0,sign:group.sign};
        aggregate.tax+=group.tax*group.ratio;byRate.set(key,aggregate);
      }
      const aggregateCredit = [...byRate.values()].reduce((sum,value) => sum + value.sign * Math.floor(value.tax + 1e-9),0);
      const useCredit = grouped.reduce((sum,group) => sum + group.sign * group.credit,0);
      if(prior.creditMethod === 'full') nationalCredit = aggregateCredit;
      else if(prior.creditMethod === 'individual'){
        if(useCredit !== aggregateCredit) return missing(['前期仕入の税率別総額と用途別端数に差があります。国税控除の端数配賦を照合してください。']);
        nationalCredit = grouped.reduce((sum,group) => sum
          + group.sign * (group.usage === 'taxableOnly' ? group.credit : group.usage === 'common' ? Math.floor(group.credit * ratio) : 0),0);
      }else{
        const positive = [...byRate.values()].filter(value=>value.sign>0).reduce((sum,value)=>sum+Math.floor(value.tax+1e-9),0);
        const returned = [...byRate.values()].filter(value=>value.sign<0).reduce((sum,value)=>sum+Math.floor(value.tax+1e-9),0);
        nationalCredit = Math.floor(positive*ratio)-Math.floor(returned*ratio);
      }
      calculation = {creditMethod:prior.creditMethod,taxableSalesRatio:ratio,purchaseGroups:grouped,aggregateCredit};
    }else{
      // All sales-based methods use the SAME already-rounded national-tax
      // basis, whether or not there is a return. Never multiply gross rounded
      // national tax by a ratio calculated from unrounded total tax.
      const hasReturns=[...salesReturnGroups.values()].some(group=>group.gross!==0);
      if(hasReturns && prior.exactMethod==='simplified' && salesBusinesses.size>1)
        return missing(['複数事業の返品を含む75％判定・税率別配賦について、当作業では必要な一次根拠と端数処理を確定できていません。該当する特例額だけ未算定です。'],'a');
      const returnNationalByRate=Object.fromEntries([1,8,10].map(rate=>[rate,[...salesReturnGroups.values()]
        .filter(group=>group.rate===rate).reduce((sum,group)=>sum+group.direction*Math.floor(group.tax+1e-9),0)]));
      const foodReturnBase = [...salesReturnGroups.values()].filter(group=>group.rate===1)
        .reduce((sum,group)=>sum+group.direction*tax.taxableBaseFromAmount(group.gross,1,'included'),0);
      const netNationalSales = nationalSales.total-nationalSalesReturnTax;
      const foodNetNational = stage==='reduction' ? nationalSales.nationalTaxFood1-returnNationalByRate[1] : 0;
      const foodNetBase = stage==='reduction' ? nationalBases['1']-foodReturnBase : 0;
      const otherNetNational = netNationalSales-foodNetNational;
      const otherNetBase = taxableSales-foodNetBase;
      if(otherNetNational < -1e-8 || otherNetBase < -1e-8)
        return missing(['食品以外の返還控除後の税額又は基礎が負です。この特殊な簡易課税等の申告計算について当作業で一次根拠を確定できていないため、該当特例額だけ未算定です。'],'a');
      if(![netNationalSales,foodNetNational,otherNetNational,nationalSalesReturnTax].every(Number.isSafeInteger))
        return missing(['前期の国税計算基礎が安全な整数円の範囲を超えています。']);
      const percentFloor=(value,percent)=>Number(BigInt(value)*BigInt(percent)/100n);
      let otherDeemedCredit=0,reference,candidates=[],selected;
      const businessType=[...salesBusinesses][0] || prior.transactions.find(item=>item?.side==='sales'&&Object.hasOwn(deemed,item.businessType))?.businessType;
      let deductionRate=prior.exactMethod==='simplified' ? deemed[businessType] : prior.exactMethod==='special2' ? .8 : .7;
      if(prior.exactMethod==='simplified'){
        const rowsByType=new Map();
        for(const sale of sales){
          const row=rowsByType.get(sale.businessKey)||{key:sale.businessKey,name:sale.businessKey,
            deemed:deemed[sale.businessKey],baseByRate:{'8':0,'10':0},nationalByRate:{'8':0,'10':0}};
          if(sale.ratePercent!==1)row.baseByRate[String(sale.ratePercent)]+=sale.amount;
          rowsByType.set(sale.businessKey,row);
        }
        const nationalByRate={'8':nationalSales.nationalTaxReduced-returnNationalByRate[8],
          '10':nationalSales.nationalTax10-returnNationalByRate[10]};
        if(stage==='restoration')nationalByRate['8']-=returnNationalByRate[1];
        const floorRatio=(a,b,d=100)=>Number(BigInt(a)*BigInt(b)/BigInt(d));
        if(hasReturns){
          if(!Number.isFinite(deductionRate))return missing(['前期の法令上の事業区分が未確認です。']);
          reference=tax.calculateSimplifiedTax([{key:businessType,name:businessType,deemed:deductionRate,
            rowTax:netNationalSales,rowTaxableBase:taxableSales,foodOnePercentTax:foodNetNational,
            foodOnePercentTaxableBase:foodNetBase,hasReturns:true}]);
          if(!reference.valid)return missing(reference.allocationErrors,'a');
          // A single business can use the direct Q3-6 basis. Negative original
          // rate columns remain a policy reference, never a 75% allocation.
          otherDeemedCredit=Object.values(nationalByRate).every(value=>value>=0)
            ? Object.values(nationalByRate).reduce((sum,value)=>sum+floorRatio(value,Math.round(deductionRate*100)),0)
            : percentFloor(otherNetNational,Math.round(deductionRate*100));
          selected={kind:'normal',credit:otherDeemedCredit};candidates=[selected];
        }else{
          const rows=[...rowsByType.values()].map(row=>{
            for(const rate of ['8','10'])row.nationalByRate[rate]=Math.floor(row.baseByRate[rate]*Number(rate)*.78/100+1e-9);
            return {...row,rowTax:row.nationalByRate['8']+row.nationalByRate['10'],
              rowTaxableBase:Math.floor(row.baseByRate['8']+1e-9)+Math.floor(row.baseByRate['10']+1e-9),
              foodOnePercentTax:0,foodOnePercentTaxableBase:0};
          });
          reference=tax.calculateSimplifiedTax(rows);
          if(!reference.valid)return missing(reference.allocationErrors);
          // Same schedule 5-3 order as current-law tax-return-engine: total
          // national tax by rate, business tax divisors, rounded deemed tax,
          // then select one common candidate across both tax-rate columns.
          const divisorByRate=Object.fromEntries(['8','10'].map(rate=>[rate,rows.reduce((sum,row)=>sum+row.nationalByRate[rate],0)]));
          for(const candidate of reference.candidates){
            const byRate={};
            for(const rate of ['8','10']){
              const basis=nationalByRate[rate],divisor=divisorByRate[rate];
              if(!Number.isSafeInteger(basis)||basis<0||!Number.isSafeInteger(divisor)||divisor<0)
                return missing(['前期の税率別国税計算基礎が整数円の範囲外です。']);
              if(basis>0&&divisor===0)return missing(['前期の税率別国税額と事業別配賦基礎が一致しません。']);
              if(candidate.kind==='single75'){
                byRate[rate]=floorRatio(basis,Math.round(deemed[candidate.keys[0]]*100));
              }else if(candidate.kind==='pair75'){
                const high=rows.find(row=>row.key===candidate.keys[0]);
                const low=rows.find(row=>row.key===candidate.keys[1]);
                const numerator=floorRatio(high.nationalByRate[rate],Math.round(high.deemed*100))
                  +floorRatio(divisor-high.nationalByRate[rate],Math.round(low.deemed*100));
                byRate[rate]=divisor===0?0:floorRatio(basis,numerator,divisor);
              }else if(rows.filter(row=>row.rowTaxableBase>0).length===1){
                const active=rows.find(row=>row.rowTaxableBase>0);
                byRate[rate]=floorRatio(basis,Math.round(active.deemed*100));
              }else{
                const numerator=rows.reduce((sum,row)=>sum+floorRatio(row.nationalByRate[rate],Math.round(row.deemed*100)),0);
                byRate[rate]=divisor===0?0:floorRatio(basis,numerator,divisor);
              }
            }
            candidates.push({kind:candidate.kind,keys:candidate.keys||[],byRate,credit:byRate['8']+byRate['10']});
          }
          selected=candidates.reduce((best,candidate)=>candidate.credit>best.credit?candidate:best,candidates[0]);
          otherDeemedCredit=selected.credit;
          deductionRate=salesBusinesses.size<=1?deductionRate:null;
        }
      }else{
        reference=tax.calculateSpecialMethodAmount({totalSalesTax:netNationalSales,
          foodOnePercentTax:foodNetNational,burdenRatio:1-deductionRate});
        if(!reference.valid)return missing(reference.reasons,'a');
        otherDeemedCredit=percentFloor(otherNetNational,Math.round(deductionRate*100));
      }
      nationalCredit=foodNetNational+otherDeemedCredit;
      calculation={method:prior.exactMethod,basis:'national-tax-after-returns',businessType,
        deductionRate,netNationalSales,foodNetNational,foodNetBase,otherNetNational,otherNetBase,
        otherDeemedCredit,foodSameCredit:foodNetNational,reference,candidates,selected,precision:'policy-reference'};
    }
    // The shared declaration function accepts a nonnegative credit. An excess
    // purchase return is an addition to output tax (NTA 6363), never clamped.
    const nationalPurchaseCredit = nationalCredit;
    const totalCredit = Math.max(0,nationalPurchaseCredit) + Math.max(0,nationalSalesReturnTax);
    const nationalAdjustment = (prior.exactMethod === 'regular' ? adjustment : 0)
      + Math.max(0,-nationalPurchaseCredit) + Math.max(0,-nationalSalesReturnTax);
    const declaration = tax.calculateDeclarationAmount({nationalSalesTax:nationalSales.total,
      nationalCredit:totalCredit,nationalAdjustment});
    return {status:'ready',national:declaration.nationalAmount,local:declaration.localAmount,total:declaration.total,
      reasons:[],blockers:[],stage,method:prior.exactMethod,nationalSales,nationalCredit:totalCredit,nationalPurchaseCredit,nationalSalesReturnTax,
      salesReturnGroups:[...salesReturnGroups.values()],calculation,declaration,transactionSnapshot,
      assumptions:['実際の前期取引の税抜金額を保持し、食品のみ開始時1％／終了時8％と仮定しています。',
        '返品は元取引時の課税状態・元税率で別控除し、食品通常取引の税率置換へ混ぜません。返品取消は符号を一度だけ反映します。',
        '国税・地方税は既存の申告書段階の端数処理を使う政策参考値です。輸入・個別調整の根拠不明は自動補完しません。']};
  }

  function settlement(annualTax, plan){
    if(!validMoney(annualTax) || plan?.status !== 'ready') return null;
    const annual = interim.exactYen(annualTax);
    const balance = annual - plan.totals.total;
    return {annualTax:annual,interim:plan.totals.total,finalPayment:Math.max(0,balance),refund:Math.max(0,-balance),
      reconciled:plan.totals.total + Math.max(0,balance) - Math.max(0,-balance) === annual};
  }

  function compare(input = {}){
    const ordinaryInput = input.ordinaryInput || {};
    const ordinary = interim.plan(ordinaryInput);
    const result = {policyOnly:true,policyVersion:POLICY_VERSION,sourceUrl:SOURCE_URL,notice:POLICY_NOTICE,
      status:'unavailable',blockers:[],ordinary,special:{status:'unavailable',installments:[],totals:null,reasons:[]},
      differences:[],retainedDuringPeriod:null,recalculationByStage:{},selectedPlans:{A:ordinary,B:ordinary},
      selectionReasons:[],settlements:{},reasons:[]};
    if(ordinary.status !== 'ready'){
      result.reasons.push(...ordinary.reasons); return result;
    }
    const stages = ordinary.installments.map(item => stageForInstallment(item,ordinaryInput.priorStart));
    if(!stages.some(Boolean)){
      result.status = 'not_applicable';
      result.special = {...ordinary,status:'not_applicable',reasons:['通常の中間申告義務がないか、中間申告対象期間・直前期が食品特例の対象外です。']};
    }else{
      const actual = input.priorActual || {};
      if(actual.period?.start !== ordinaryInput.priorStart || actual.period?.end !== ordinaryInput.priorEnd)
        result.reasons.push('食品内訳の前期期間と共有された実際の前期期間が一致しません。');
      for(const stage of [...new Set(stages.filter(Boolean))]){
        const value = result.reasons.length ? missing(result.reasons) : recalculatePrior(actual,stage);
        result.recalculationByStage[stage] = value;
        result.reasons.push(...value.reasons);
        result.blockers.push(...(value.blockers||[]));
      }
      if(result.reasons.length){
        for(const reason of result.reasons)if(!result.blockers.some(item=>item.reason===reason))result.blockers.push({category:'b',reason});
        result.special.reasons = [...new Set(result.reasons)];
      }else{
        const installments = ordinary.installments.map((item,index) => {
          const stage = stages[index];
          if(!stage) return {...item,policyStage:null,specialApplied:false};
          const months = calendar.priorMonths(item.interimStart,item.interimEnd);
          const national = Math.max(0,result.recalculationByStage[stage].national);
          const amounts = interim.interimAmounts(national,months,ordinary.priorMonths);
          return {...item,...amounts,policyStage:stage,specialApplied:true};
        });
        if(installments.some(item => !Number.isSafeInteger(item.total))){
          result.reasons.push('特例の中間税額が整数円の計算範囲を超えています。');
          result.special.reasons = result.reasons;
        }else{
          const totals = Object.fromEntries(['national','local','total'].map(key => [key,installments.reduce((sum,item) => sum + item[key],0)]));
          if(Object.values(totals).some(value => !Number.isSafeInteger(value))){
            result.reasons.push('特例の年間合計が整数円の計算範囲を超えています。');
            result.special.reasons = result.reasons;
            return result;
          }
          result.special = {...ordinary,installments,totals,policyOnly:true,reasons:[],warnings:[...ordinary.warnings,POLICY_NOTICE]};
          result.differences = installments.map((item,index) => ({sequence:item.sequence,interimStart:item.interimStart,
            interimEnd:item.interimEnd,dueDate:item.adjustedDueDate,ordinary:ordinary.installments[index].total,
            special:item.total,retained:ordinary.installments[index].total-item.total,specialApplied:item.specialApplied,policyStage:item.policyStage}));
          result.retainedDuringPeriod = result.differences.filter(item => item.dueDate <= ordinaryInput.currentEnd)
            .reduce((sum,item) => sum + item.retained,0);
          result.status = 'ready';
        }
      }
    }
    for(const side of ['A','B']){
      const wantsSpecial = input.selection?.[side] === 'special';
      const manuallyPlanned = input.manualPlanned?.[side] === true;
      if(wantsSpecial && manuallyPlanned) result.selectionReasons.push(`${side}案は手入力予定を保持しています。特例の自動額で上書きしません。`);
      else if(wantsSpecial && result.special.status === 'ready') result.selectedPlans[side] = result.special;
      else if(wantsSpecial) result.selectionReasons.push(`${side}案の特例額は未算定・対象外のため通常方式を保持しています。`);
      result.settlements[side] = {ordinary:settlement(input.annualTax?.[side],ordinary),special:settlement(input.annualTax?.[side],result.special)};
    }
    return result;
  }
  return Object.freeze({POLICY_VERSION,SOURCE_URL,POLICY_NOTICE,stageForInstallment,recalculatePrior,settlement,compare});
});
