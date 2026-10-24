(function(root,factory){
  const engine = typeof module === 'object' && module.exports ? require('./tax-engine.js') : root.ShohizeiTaxEngine;
  const api = factory(engine);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiSalesScenario = api;
})(typeof globalThis !== 'undefined' ? globalThis : this,function(engine){
  'use strict';
  const DEFAULT_TYPES = [90,80,70,60,50,40].map((rate,index) => ({key:`type${index+1}`,name:`第${index+1}種`,deemed:rate/100}));
  const parse = value => engine.parseAmountInput(value,{allowNegative:true});

  // Row amounts are always gross. Keep original-rate returns separate from
  // projected ordinary food transactions until their tax has been computed.
  // This avoids projecting a signed annual net at 1%, or losing a return when
  // a sale and return net to zero. No source row or actual CSV entry is edited.
  function collectSalesScenario(input = {},options = {}){
    const sales = Array.isArray(input.sales) ? input.sales : [];
    const actualEntries = Array.isArray(input.actualOnePercentEntries) ? input.actualOnePercentEntries : [];
    const foodScenario = options.taxScenario === 'foodProposal';
    const excluded = options.amountMode === 'excluded';
    const types = Array.isArray(options.businessTypes) ? options.businessTypes : DEFAULT_TYPES;
    const errors = [];
    const assumptions = [];
    const fraction = options.foodForecastMethod === 'uniform' ? Number(options.proposalFraction ?? 0) : 1;
    const rowMap = new Map();
    const rowFor = key => {
      if(!rowMap.has(key)){
        const type = types.find(item => item.key === key);
        rowMap.set(key,{...(type || {key:'unclassified',name:'事業区分未確認',deemed:null,businessTypeUnknown:true}),
          amount10:0,amount8:0,amountFood1:0,originalAmount8:0,foodInputAmount:0,foodOneOriginalAmount:0,
          forecastFood1:0,forecastFood1Tax:0,actualFood1:0,actualFood1Tax:0,actualOneGross:0,
          taxableBase10:0,taxableBase8:0,taxableBaseFood1:0,tax10:0,tax8:0,taxFood1:0,
          foodOnePercentTax:0,foodOnePercentTaxableBase:0,rowTax:0,rowAmount:0,rowTaxableBase:0,
          hasReturns:false,entered:false});
      }
      return rowMap.get(key);
    };
    types.forEach(type => rowFor(type.key));
    const amountFor = (gross,rate) => excluded ? engine.taxableBaseFromAmount(gross,rate,'included') : gross;
    function add(row,gross,rate,{forecast = false,actual = false} = {}){
      const tax = engine.taxFromAmount(gross,rate,'included');
      const base = engine.taxableBaseFromAmount(gross,rate,'included');
      const amount = amountFor(gross,rate);
      row[`amount${rate === 1 ? 'Food1' : rate}`] += amount;
      row[`tax${rate === 1 ? 'Food1' : rate}`] += tax;
      row[`taxableBase${rate === 1 ? 'Food1' : rate}`] += base;
      row.rowAmount += amount; row.rowTax += tax; row.rowTaxableBase += base;
      if(rate === 1){
        row.foodOnePercentTax += tax; row.foodOnePercentTaxableBase += base;
        if(forecast){row.forecastFood1 += amount; row.forecastFood1Tax += tax;}
        if(actual){row.actualFood1 += amount; row.actualFood1Tax += tax; row.actualOneGross += gross;}
      }
    }
    sales.forEach((source,index) => {
      const code = String(source?.code || '');
      if(code === '3') return;
      if(!code && !String(source?.amount ?? '').trim()) return;
      const parsed = parse(source.amount);
      const rate = Number(source.rate);
      if(!['1','11'].includes(code) || ![8,10].includes(rate) || !parsed.entered || !parsed.valid){
        errors.push(`売上行${index+1}の課税区分・税率・税込金額を確認してください。`);return;
      }
      const food = parse(source.foodAmount);
      if(!food.valid || (food.entered && (rate !== 8 || Math.abs(food.value) > Math.abs(parsed.value) + 1e-8
        || (food.value && Math.sign(food.value) !== Math.sign(parsed.value))))){
        errors.push(`売上行${index+1}の食品対象額・符号を確認してください。`);return;
      }
      const key = types.some(type => type.key === source.businessType) ? source.businessType : 'unclassified';
      const row = rowFor(key);
      const returned = code === '11' || parsed.value < 0 || source.transactionKind === 'adjustment';
      if(code==='11'&&source.originalTaxableState==='exempt'){
        assumptions.push('免税事業者であった期間の元売上に係る返品は、返還等対価に係る税額控除へ含めていません。元の返金額・符号は入力行に保持しています。');
        return;
      }
      if(code==='11'&&source.originalTaxableState!==undefined&&source.originalTaxableState!=='taxable'){
        errors.push(`売上行${index+1}の元取引時の課税・免税状態が未確認のため、返還控除を確定できません。`);
        return;
      }
      // Code 11 stores return-direction input: invert once, including a
      // negative cancellation of a return. CSV actual entries below already
      // have ledger signs and are never inverted on account of code 11.
      const gross = code === '11' ? -parsed.value : parsed.value;
      row.entered = true; row.hasReturns ||= returned;
      if(rate === 8) row.originalAmount8 += amountFor(gross,8);
      const eligible = !returned && !(Number(source.sourceAdjustmentCount) > 0);
      if(foodScenario && rate === 8 && food.entered && food.value !== 0 && !returned && !eligible)
        errors.push(`売上行${index+1}は通常取引と返品・調整の集計内訳が未確認のため、食品1％対象額を確定できません。元税率別の行内訳を確認してください。`);
      let foodOriginal = 0;
      if(foodScenario && rate === 8 && food.entered && eligible){
        row.foodInputAmount += amountFor(food.value,8);
        foodOriginal = typeof options.foodPeriodAmount === 'function' ? options.foodPeriodAmount(source,food.value)
          : food.value * fraction;
        if(!Number.isFinite(foodOriginal) || foodOriginal < 0 || foodOriginal > gross + 1e-8){
          errors.push(`売上行${index+1}の食品対象期間額が未算定又は元金額を超えています。`);foodOriginal = 0;
        }
      }else if(foodScenario && rate === 8 && returned){
        assumptions.push('返品・調整は元の8％税率を維持し、食品1％の通常取引予測へ含めていません。');
      }
      row.foodOneOriginalAmount += amountFor(foodOriginal,8);
      add(row,gross-foodOriginal,rate);
      if(foodOriginal){
        const projected = engine.projectPrice({netAmount:foodOriginal/1.08,grossAmount:foodOriginal,
          ratePercent:1,priceBasis:options.foodSalesPriceBasis});
        add(row,projected.grossAmount,1,{forecast:true});
      }
    });
    actualEntries.filter(entry => entry?.kind === 'sale').forEach((entry,index) => {
      const parsed = parse(entry.amount);
      const assessment = engine.assessCsvOnePercentEntry(entry);
      if((options.periodStart && (!entry.date || entry.date < options.periodStart))
        || (options.periodEnd && (!entry.date || entry.date > options.periodEnd))){
        errors.push(`CSV明示1％売上${index+1}件目の取引日は対象課税期間外です。将来期の実績へ流用しません。`);return;
      }
      if(!foodScenario || !parsed.valid || !parsed.entered || assessment.status !== 'confirmed'){
        errors.push(`CSV明示1％売上${index+1}件目: ${assessment.reason || '食品1％シナリオと元取引を確認してください。'}`);return;
      }
      const row = rowFor(types.some(type => type.key === entry.businessType) ? entry.businessType : 'unclassified');
      row.entered = true;
      row.hasReturns ||= entry.transactionKind === 'adjustment';
      // The sidecar already owns the ledger sign. A positive adjustment can
      // cancel an earlier return and must not be forced into a second return.
      const gross = parsed.value;
      if(entry.transactionKind==='adjustment'&&entry.originalTaxableState==='exempt'){
        assumptions.push('免税期間の元売上に係る明示1％返還実績は、返還控除へ含めていません。');return;
      }
      if(entry.transactionKind==='adjustment'&&entry.originalTaxableState!==undefined&&entry.originalTaxableState!=='taxable'){
        errors.push(`CSV明示1％売上${index+1}件目の元取引時の課税・免税状態が未確認のため、返還控除を確定できません。`);return;
      }
      if(entry.transactionKind !== 'adjustment' && gross < 0){errors.push(`CSV明示1％売上${index+1}件目の符号を確認してください。`);return;}
      add(row,gross,1,{actual:true});
    });
    const rows = [...rowMap.values()];
    const simplifiedBusinessUnknown = rows.some(row => row.businessTypeUnknown && row.entered);
    const base = engine.calculateSimplifiedTax(rows.filter(row => !row.businessTypeUnknown));
    const simplified = simplifiedBusinessUnknown ? {...base,amount:null,deemedCredit:null,methodLabel:'事業区分未確認',
      foodOnePercentTax:rows.reduce((sum,row) => sum + row.foodOnePercentTax,0)} : base;
    // Keep method-specific limitations apart from transaction calculation:
    // regular-tax amounts remain usable when a negative other-sale basis
    // prevents simplified/75% computation.
    return {rows,totalAmount:rows.reduce((sum,row) => sum+row.rowAmount,0),
      totalTaxableBase:rows.reduce((sum,row) => sum+row.rowTaxableBase,0),
      totalTax:rows.reduce((sum,row) => sum+row.rowTax,0),
      deemedCredit:simplified.deemedCredit,simplified,simplifiedBusinessUnknown,
      anyEntered:rows.some(row => row.entered),errors,methodErrors:simplified.allocationErrors,
      assumptions:[...new Set(assumptions)]};
  }
  // Re-express actual 1% ordinary trade as the 8% source-price basis for a
  // future scenario. Keep the selected price premise; returns need their own
  // original transaction and are never converted into ordinary forecasts.
  function forecastActualOneBasis(entry,priceBasis='netFixed'){
    const value=parse(entry?.amount);
    if(entry?.transactionKind!=='ordinary'||!value.entered||!value.valid||value.value<0)
      return {available:false,amount:null,reason:'明示1％の返品・元取引を将来の通常取引へ変換できません。'};
    return {available:true,amount:priceBasis==='grossFixed'?value.value:value.value/1.01*1.08,reason:''};
  }
  return Object.freeze({collectSalesScenario,forecastActualOneBasis});
});
