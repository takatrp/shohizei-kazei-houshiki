(function(root,factory){
  const rows = typeof module === 'object' && module.exports ? require('./tax-entry-rows.js') : root.ShohizeiTaxEntryRows;
  const engine = typeof module === 'object' && module.exports ? require('./tax-engine.js') : root.ShohizeiTaxEngine;
  const api = factory(rows,engine);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiFourAmountEntry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this,function(rowModel,engine){
  'use strict';
  const FIELDS = Object.freeze(['foodSales','otherSales','foodPurchases','otherPurchases']);
  const INDUSTRIES = Object.freeze([
    Object.freeze({key:'wholesale',label:'卸売業',businessType:'type1'}),
    Object.freeze({key:'retail',label:'小売業・食品の農林水産業',businessType:'type2'}),
    Object.freeze({key:'manufacturing',label:'食品加工・製造業',businessType:'type3'}),
    Object.freeze({key:'restaurant',label:'飲食店',businessType:'type4'}),
    Object.freeze({key:'services',label:'サービス業等',businessType:'type5'}),
    Object.freeze({key:'realEstate',label:'不動産業',businessType:'type6'})
  ]);
  const ASSUMPTIONS = Object.freeze([
    '4金額はすべて税込です。食品は軽減8％実績からの食品1％政策試算に用いる金額で、実際の1％取引ではありません。',
    'その他売上は10％課税売上、仕入・経費はインボイスあり・課税売上対応として仮定します。新聞8％・非課税・輸出・輸入・控除割合の異なる仕入・設備投資・返品は詳細入力で区分してください。',
    '業種型は事業区分の初期候補です。複数事業や法令上の事業区分、適用可否、届出・資料照合の確認を代替しません。'
  ]);
  function presentation(input={}){
    const policy=input.taxScenario==='foodProposal',restaurant=input.industry==='restaurant';
    return {labels:{foodSales:'食品売上（軽減8％・税込）',otherSales:'その他売上（10％・税込）',foodPurchases:'食品仕入（軽減8％・税込）',otherPurchases:'その他の課税仕入・経費（税込）'},
      intro:'税込金額を入力すると、同じ詳細行へ自動反映します。'+(restaurant?'飲食店の8％食品売上はテイクアウト・物販等、10％売上は店内飲食・酒類等です。':'')+(policy?'食品は軽減8％実績からの1％政策試算です。':'食品は軽減8％対象、その他売上は10％対象の金額です。'),
      assumptions:[policy?ASSUMPTIONS[0]:'4金額はすべて税込です。食品欄は軽減8％対象の金額として、現行税率で試算します。',...ASSUMPTIONS.slice(1)]};
  }
  const text = value => String(value ?? '').trim();
  const significant = row => ['amount','foodAmount','businessType','rate','creditRatio','importComponent'].some(key => text(row?.[key]) !== '')
    || !['','1','3'].includes(text(row?.code))
    || /^csv/.test(row?.source || '') || Boolean(row?.sourceRow || row?.sourceCount);
  // Only an untouched generated row can be rewritten by the compact editor.
  // A detailed edit, even of a generated row, transfers ownership to details.
  function signature(row){
    return JSON.stringify(['code','businessType','rate','amount','foodAmount','foodAmountSource',
      'creditRatio','importComponent'].map(key => text(row?.[key])));
  }
  function editable(context={}){
    if(context.hasCsvSource || (context.actualOnePercentEntries || []).length) return false;
    const all = [...(context.rows?.sales || []),...(context.rows?.purchases || [])];
    return all.every(row => !significant(row) || row?.source === 'four-amount'
      && row.quickEntrySignature === signature(row));
  }
  function build(input={},context={}){
    const errors = [];
    if(!editable(context)) errors.push({field:'rows',message:'CSV・詳細入力の内訳を保持しています。4金額で置き換えず、詳細入力で修正してください。'});
    const industry = INDUSTRIES.find(item => item.key === input.industry || item.businessType === input.industry);
    if(!industry) errors.push({field:'industry',message:'業種型を選択してください。'});
    const amounts = {};
    for(const field of FIELDS){
      const parsed = engine.parseAmountInput(input[field],{allowNegative:true});
      if(!parsed.entered) errors.push({field,message:'金額を入力してください。該当なしは0円を入力してください。'});
      else if(!parsed.valid) errors.push({field,message:'有効な税込金額を入力してください。'});
      else if(parsed.value < 0) errors.push({field,message:'返品・負額は元の税率を確認し、詳細入力で区分してください。'});
      amounts[field] = parsed;
    }
    if(errors.length) return {ready:false,rows:context.rows || null,errors,assumptions:[...ASSUMPTIONS]};
    const make = (side,field,rate) => {
      const food = field === 'foodSales' || field === 'foodPurchases';
      const row = rowModel.createTaxEntryRow(side,{
        id:`four-amount-${field}`,source:'four-amount',code:side === 'sales' ? '1' : '5',
        businessType:side === 'sales' ? industry.businessType : '',rate,
        amount:String(amounts[field].value),foodAmount:food ? String(amounts[field].value) : '',
        foodAmountSource:food ? 'auto' : '',quickEntryField:field
      });
      row.quickEntrySignature = signature(row);
      return row;
    };
    const nonTaxable = rowModel.createTaxEntryRow('sales',{id:'four-amount-nonTaxable',source:'four-amount',code:'3',amount:'0'});
    nonTaxable.quickEntrySignature = signature(nonTaxable);
    return {ready:true,rows:{sales:[make('sales','foodSales','8'),make('sales','otherSales','10'),nonTaxable],
      purchases:[make('purchases','foodPurchases','8'),make('purchases','otherPurchases','10')]},errors:[],
      assumptions:[...ASSUMPTIONS],industry:industry.key,amountMode:'included',foodBasis:'reduced8Forecast'};
  }
  function draft(input={},context={}){
    const built=build(input,context);
    if(built.ready||!editable(context))return built;
    const old=context.rows;
    if(!old||![...(old.sales||[]),...(old.purchases||[])].some(r=>r.source==='four-amount'))return built;
    const industry=INDUSTRIES.find(item=>item.key===input.industry||item.businessType===input.industry);
    const next=Object.fromEntries(['sales','purchases'].map(side=>[side,(old[side]||[]).map(row=>{
      if(row.source!=='four-amount')return {...row};
      const value={...row};
      if(FIELDS.includes(value.quickEntryField)){
        value.amount=String(input[value.quickEntryField]??'');
        if(side==='sales')value.businessType=industry?.businessType||'';
        if(value.rate==='8'){value.foodAmount=value.amount;value.foodAmountSource='manual';}
      }
      value.quickEntrySignature=signature(value);return value;
    })]));
    return {...built,rows:next,draft:true};
  }
  // A compact display of existing rows is read-only. It never collapses details.
  function summarize(rows={}){
    const totals = Object.fromEntries(FIELDS.map(field => [field,0]));
    const present = Object.fromEntries(FIELDS.map(field => [field,false]));
    const reasons = [];
    for(const side of ['sales','purchases']) for(const row of rows[side] || []){
      const amount = engine.parseAmountInput(row?.amount,{allowNegative:true});
      if(!amount.entered) continue;
      if(!amount.valid){ reasons.push('不正な金額を含みます。');continue; }
      const food = engine.parseAmountInput(row?.foodAmount,{allowNegative:true});
      const ordinary = side === 'sales' ? row.code === '1' : row.code === '5';
      if(!ordinary || !['8','10'].includes(row.rate) || amount.value < 0){
        if(row.code !== '3' || amount.value !== 0) reasons.push('4金額以外の課税区分・用途・返還を含むため詳細入力を保持しています。');
        continue;
      }
      const foodKey = side === 'sales' ? 'foodSales' : 'foodPurchases';
      const otherKey = side === 'sales' ? 'otherSales' : 'otherPurchases';
      if(row.rate === '8'){
        if(!food.entered || !food.valid || food.value < 0 || food.value > amount.value){reasons.push('食品内数が未確認です。');continue;}
        totals[foodKey] += food.value;present[foodKey] = true;
        totals[otherKey] += amount.value - food.value;present[otherKey] = true;
      }else{totals[otherKey] += amount.value;present[otherKey] = true;}
    }
    return {amounts:Object.fromEntries(FIELDS.map(field => [field,present[field] ? totals[field] : null])),
      complete:reasons.length === 0,reasons:[...new Set(reasons)],readOnly:!editable({rows})};
  }
  return {FIELDS,INDUSTRIES,ASSUMPTIONS,presentation,editable,build,draft,summarize};
});
