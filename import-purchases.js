(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.ShohizeiImportPurchases=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const USAGE=Object.freeze({'55':'taxableOnly','65':'nonTaxableOnly','75':'common'});
  const COMPONENTS=Object.freeze({goods:'仕入対価・本体',duty:'関税（消費税控除なし）',national:'輸入消費税（国税）',local:'輸入地方消費税',taxTotal:'国地方の輸入税合計（概算分割）'});
  const empty=()=>Object.fromEntries(Object.values(USAGE).map(use=>[use,{'8':0,'10':0}]));
  const amount=value=>{const s=String(value??'').trim().replace(/,/g,'');return /^-?\d+$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):null;};
  function classify({component='',memo='',tax='',net='',value=''}={}){
    const explicit=({本体:'goods',関税:'duty',国税:'national',地方税:'local',税合計:'taxTotal',goods:'goods',duty:'duty',national:'national',local:'local',taxTotal:'taxTotal'})[String(component).trim()];
    if(explicit)return {component:explicit,basis:'explicit',reason:'CSVの輸入区分明示',assumed:false};
    const text=String(memo).normalize('NFKC');
    const local=/地方消費税|地方税/.test(text);
    const national=/国税|消費税/.test(text.replace(/地方消費税|地方税/g,''));
    const duty=/関税/.test(text);
    let role='',reason='';
    if(duty&&(local||national))return {component:'',basis:'unknown',reason:'関税と消費税の併記。内訳をまとめて確認',assumed:false};
    if((local&&national)||/消費税等|国地方合計|輸入税合計/.test(text)){role='taxTotal';reason='摘要の国地方合計・消費税等';}
    else if(local){role='local';reason='摘要の地方消費税・地方税';}
    else if(national){role='national';reason='摘要の消費税・国税（地方税以外）';}
    else if(duty){role='duty';reason='摘要の関税（控除対象外）';}
    else if(/仕入|本体|輸入対価|課税価格/.test(text)){role='goods';reason='摘要の仕入・本体等';}
    else if(amount(tax)===0&&amount(net)!==null&&amount(net)===amount(value)){role='goods';reason='税額0・税抜額一致の本体候補（返品等の符号は確認）';}
    return {component:role,basis:role?'candidate':'unknown',reason:reason||'税種を識別できる記載なし',assumed:Boolean(role)};
  }
  function aggregate(rows=[],options={}){
    const groups=new Map(),errors=[],rowErrors=[],assumptions=[];
    const issue=(index,message)=>{errors.push(message);rowErrors.push({side:'purchases',index,message,importOnly:true});};
    rows.forEach((row,index)=>{
      const code=String(row?.code||'').trim();if(!USAGE[code])return;
      const label=`輸入区分${code}・${index+1}行目`,rate=String(row.rate||'').trim();
      if(!['8','10'].includes(rate)){issue(index,`${label}: 税率を10％または軽減8％で確認してください。`);return;}
      const key=code+':'+rate;
      const group=groups.get(key)||{code,rate,usage:USAGE[code],goods:0,duty:0,national:0,local:0,taxTotal:0,present:new Set()};groups.set(key,group);
      const component=String(row.importComponent||'');
      if(!Object.hasOwn(COMPONENTS,component)){issue(index,`${label}: 未分類の輸入行です。行区分をまとめて確認・補正できます。`);return;}
      const value=amount(row.amount);
      if(value===null){issue(index,`${label}: ${COMPONENTS[component]}を整数円で入力してください。空欄を0円にしません。`);return;}
      group[component]+=value;group.present.add(component);
      if(row.importAssumed||row.importBasis==='candidate') assumptions.push('輸入の摘要・税額欄から分類した候補を使用しています。国税・地方税・関税の集計をまとめて確認してください。');
      if(String(row.foodAmount??'').trim())issue(index,`${label}: 輸入の食品割合は共通の「輸入軽減8％の食品対象割合」で指定してください。国内の税込食品内数へ混ぜません。`);
    });
    const nationalByUse=empty(),localByUse=empty(),goodsByUse=empty(),dutyByUse=empty();
    let recordedPaid=0,originalNational=0,originalLocal=0,projectedDifference=0;
    const reduced=[...groups.values()].some(g=>g.rate==='8');
    const foodFraction=options.importFoodFraction??1;
    const periodFraction=options.foodForecastMethod==='uniform'?Number(options.proposalFraction):1;
    const policy=options.taxScenario==='foodProposal'&&reduced;
    if(policy&&(!Number.isFinite(foodFraction)||foodFraction<0||foodFraction>1||!Number.isFinite(periodFraction)||periodFraction<0||periodFraction>1))errors.push('輸入の食品対象割合と1％対象期間割合を0〜100％で確認してください。');
    for(const group of groups.values()){
      for(const component of Object.keys(COMPONENTS)) if(!Number.isSafeInteger(group[component])||group[component]<0)errors.push(`輸入区分${group.code}・${group.rate}％: ${COMPONENTS[component]}の返品・訂正差引後金額を確認してください。`);
      let n=group.national,l=group.local;
      if(group.present.has('taxTotal')){
        const split=Math.round(group.taxTotal*.78);n+=split;l+=group.taxTotal-split;
        assumptions.push(`輸入${group.rate}％の国地方税合計を国税78％・地方税22％で概算分割（円単位四捨五入）。輸入許可時の各端数と差が出ます。`);
      }
      if(group.present.has('national')&&!group.present.has('local')){l+=Math.round(group.national*22/78);assumptions.push('地方税の別額がない国税分は22/78で地方税を概算。支払実額の追加計上はしません。');}
      if(group.present.has('local')&&!group.present.has('national')){n+=Math.round(group.local*78/22);assumptions.push('国税の別額がない地方税分は78/22で国税を概算。輸入時の端数差があります。');}
      if(!['national','local','taxTotal'].some(key=>group.present.has(key))){
        if(options.estimateFromBase===true&&(group.present.has('goods')||group.present.has('duty'))){
          const base=group.goods+group.duty;n=Math.round(base*Number(group.rate)*.78/100);l=Math.round(base*Number(group.rate)*.22/100);
          assumptions.push(`輸入${group.rate}％の税額がないため、本体＋関税をCIF等課税価格の代理として国税・地方税を概算。その他内国税・為替・税関端数等は未反映です。`);
        }else errors.push(`輸入区分${group.code}・${group.rate}％: 税額がありません。国税・地方税・税合計を入力するか、課税価格代理の概算を選択してください。`);
      }
      originalNational+=n;originalLocal+=l;
      recordedPaid+=Object.keys(COMPONENTS).reduce((s,key)=>s+group[key],0);
      if(policy&&group.rate==='8'&&Number.isFinite(foodFraction)&&Number.isFinite(periodFraction)){
        const fraction=foodFraction*periodFraction,factor=1-fraction*7/8;
        projectedDifference+=(n+l)*(factor-1);n*=factor;l*=factor;
        if(fraction)assumptions.push(`輸入軽減8％の食品対象${foodFraction*100}％・対象期間割合${Math.round(periodFraction*10000)/100}％を1％へ概算。課税価格・数量・本体・関税を固定し、対象国税・地方税を8分の1（輸入時の端数・為替等は未反映）とします。`);
      }
      nationalByUse[group.usage][group.rate]+=n;localByUse[group.usage][group.rate]+=l;
      goodsByUse[group.usage][group.rate]+=group.goods;dutyByUse[group.usage][group.rate]+=group.duty;
    }
    const sum=values=>Object.values(values).reduce((s,r)=>s+r['8']+r['10'],0);
    const national=sum(nationalByUse),local=sum(localByUse),goods=sum(goodsByUse),duty=sum(dutyByUse);
    if(![recordedPaid,originalNational,originalLocal,goods,duty,goods+duty+originalNational+originalLocal].every(Number.isSafeInteger))errors.push('輸入金額の合計が安全な整数円の範囲を超えています。');
    const comparisonCreditByUse=Object.fromEntries(Object.keys(nationalByUse).map(use=>[use,(nationalByUse[use]['8']+nationalByUse[use]['10'])*100/78]));
    return {present:groups.size>0,complete:errors.length===0,policyUnknown:policy&&errors.length>0,errors:[...new Set(errors)],rowErrors,
      assumptions:[...new Set(assumptions)],estimated:assumptions.length>0,nationalByUse,localByUse,goodsByUse,dutyByUse,national,local,goods,duty,
      originalNational,originalLocal,recordedPaid,projectedDifference,paid:goods+duty+national+local,
      comparisonCredit:national*100/78,comparisonCreditByUse};
  }
  return Object.freeze({USAGE,COMPONENTS,classify,aggregate});
});
