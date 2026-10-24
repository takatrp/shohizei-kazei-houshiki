(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./tax-calendar.js'):root.ShohizeiTaxCalendar);
  if(typeof module==='object' && module.exports) module.exports=api;
  root.ShohizeiTaxObligation=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(calendar){
  'use strict';
  const POLICY=Object.freeze({start:'2027-04-01',end:'2029-03-31',status:'proposal'});
  const SOURCES=Object.freeze({
    exemption:'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm',
    reference:'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6503.htm',
    food:'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0026008-127_qa.pdf'
  });
  function date(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const d=new Date(`${value}T00:00:00Z`);
    return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value?d:null;
  }
  function iso(d){ return d.toISOString().slice(0,10); }
  function day(value,offset){ const d=date(value);if(!d)return '';d.setUTCDate(d.getUTCDate()+offset);return iso(d); }
  function year(value,offset){
    const d=date(value);if(!d)return '';
    const month=d.getUTCMonth();d.setUTCFullYear(d.getUTCFullYear()+offset);
    if(d.getUTCMonth()!==month)d.setUTCDate(0);
    return iso(d);
  }
  function period(p){ return date(p?.start)&&date(p?.end)&&p.start<=p.end?{start:p.start,end:p.end}:null; }
  function annual(p){ return !!period(p)&&calendar.isFullYearPeriod(p.start,p.end); }
  function samePeriod(a,b){ return !!a&&!!b&&a.start===b.start&&a.end===b.end; }
  function label(p,entity){ return entity==='individual'&&p.start.endsWith('-01-01')&&p.end.endsWith('-12-31')?`${p.start.slice(0,4)}年分`:`${p.start}〜${p.end}`; }
  function buildProjectionPeriods(input={}){
    const first=period(input);if(!first)return [];
    const count=Number.isInteger(input.minPeriods)?Math.max(4,Math.min(16,input.minPeriods)):4;
    const scenario=input.scenario==='foodProposal'||input.taxScenario==='foodProposal';
    const rows=[];let next=first;
    while(rows.length<16){
      rows.push({...next,label:label(next,input.entity),assumed:rows.length>0});
      if(rows.length>=count&&(!scenario||next.start>POLICY.end))break;
      const supplied=input.futurePeriods?.[rows.length-1];
      if(supplied){
        const checked=period(supplied);if(!checked||checked.start!==day(next.end,1))break;
        next=checked;
      }else{
        const start=day(next.end,1);
        next={start,end:calendar.annualPeriodEnd(start)};
      }
    }
    return rows;
  }
  // Do not infer the legal base-period window of an irregular corporate year
  // from its label. The caller must supply actual fiscal-period history there.
  function referencePeriods(input={}){
    const p=period(input.period||input);
    if(!p)return {base:null,specified:null,reasons:['対象課税期間を確認してください。']};
    if(input.entity==='individual'){
      const y=Number(p.start.slice(0,4));
      return {base:{start:`${y-2}-01-01`,end:`${y-2}-12-31`},specified:{start:`${y-1}-01-01`,end:`${y-1}-06-30`},reasons:[]};
    }
    if(!annual(p))return {base:null,specified:null,reasons:['短期・決算期変更の法人は実際の事業年度から基準期間・特定期間を確認してください。']};
    const base={start:year(p.start,-2),end:year(p.end,-2)};
    if(!annual(base))return {base:null,specified:null,reasons:['うるう日の境界を含む基準期間・特定期間は、実際の事業年度履歴で確認してください。年次期間を短期とは扱いません。']};
    const previousStart=year(p.start,-1);
    const middle=date(previousStart);middle.setUTCMonth(middle.getUTCMonth()+6);
    return {base,specified:{start:previousStart,end:day(iso(middle),-1)},reasons:[]};
  }
  function readFact(record,expected){
    if(!record||!samePeriod(record,expected))return {entered:false,value:null,period:expected,source:'unknown'};
    const raw=record.taxableSales??record.sales??record.value;
    const valid=record.entered!==false&&raw!==''&&raw!==null&&raw!==undefined&&Number.isFinite(Number(raw));
    return {entered:valid,value:valid?Number(raw):null,period:expected,source:record.source||'unknown'};
  }
  function resolveReferenceFacts(input={}){
    const refs=referencePeriods(input);
    const history=Array.isArray(input.history)?input.history:[];
    const get=key=>readFact(history.find(row=>samePeriod(row,refs[key])),refs[key]);
    const base=get('base'),specified=get('specified');
    return {...refs,baseFact:base,specifiedFact:specified,
      reasons:[...refs.reasons,...(!base.entered?['該当する基準期間の実績又は明示した予測値がありません。']:[]),
        ...(!specified.entered?['該当する特定期間の実績又は予測値がありません。']:[])]};
  }
  function assessment(status,reasons,extra={}){
    return {status,eligibility:status==='available'||status==='planned'?'eligible':status==='unknown'?'unknown':'ineligible',reasons,...extra};
  }
  function assessTaxObligation(input={}){
    const p=period(input.period||input);
    if(!p)return assessment('unknown',['対象課税期間が未確認です。'],{obligation:'unknown'});
    if(input.invoiceActive===true||input.electionActive===true||input.otherObligation==='yes'){
      return assessment('available',['登録・課税選択又は他の納税義務により課税事業者となる期間です。'],{obligation:'taxable'});
    }
    if(input.confirmedStatus==='taxable'&&samePeriod(input.confirmedStatusPeriod,p)){
      return assessment('available',['この対象期間について入力された納税義務の状態を使用しています。'],{obligation:'taxable'});
    }
    const resolved=resolveReferenceFacts({...input,period:p});
    const base=input.baseFact?readFact(input.baseFact,resolved.base):resolved.baseFact;
    const specified=input.specifiedFact?readFact(input.specifiedFact,resolved.specified):resolved.specifiedFact;
    if(base.entered&&base.value>10000000)return assessment('available',['基準期間課税売上高が1,000万円を超えるため、免税を維持できません。'],{obligation:'taxable',baseFact:base,specifiedFact:specified});
    const payroll=input.specifiedPayroll;
    const payrollEntered=payroll!==null&&payroll!==undefined&&payroll!==''&&Number.isFinite(Number(payroll));
    const payrollPermitted=input.domesticBusiness!=='no';
    const specifiedExempt=input.specifiedNotApplicable===true
      ||specified.entered&&specified.value<=10000000
      ||payrollPermitted&&payrollEntered&&Number(payroll)<=10000000;
    if(specified.entered&&specified.value>10000000&&!specifiedExempt&&(!payrollPermitted||payrollEntered)){
      return assessment('available',['特定期間の判定基準が1,000万円を超えるため、免税を維持できません。'],{obligation:'taxable',baseFact:base,specifiedFact:specified});
    }
    if(input.assetRestrictionState==='yes')return assessment('unknown',['資産取得による制限ありと入力されています。該当取得期・単位額・申告方式から、この期の免税制限期間を確認してください。'],{obligation:'unknown',baseFact:base,specifiedFact:specified});
    if(input.confirmedStatus==='exempt'&&samePeriod(input.confirmedStatusPeriod,p)){
      return assessment('available',['この対象期間について入力された納税義務の状態を使用しています。'],{obligation:'exempt',baseFact:base,specifiedFact:specified});
    }
    const reasons=[];
    if(!base.entered)reasons.push('該当する基準期間の課税売上高が未確認です。');
    if(!specifiedExempt)reasons.push('該当する特定期間の売上高又は利用可能な給与等支払額の判定が未確認です。');
    if(input.assetRestrictionState==='unknown')reasons.push('資産取得によるこの期の免税制限が未確認です。');
    if(input.otherObligation!=='no')reasons.push('新設法人・資産取得・相続等による他の納税義務が未確認です。');
    if(reasons.length)return assessment('unknown',reasons,{obligation:'unknown',baseFact:base,specifiedFact:specified});
    return assessment('available',['基準期間等の入力条件では免税を維持できます。'],{obligation:'exempt',baseFact:base,specifiedFact:specified,
      forecast:base.source==='forecast'||specified.source==='forecast'});
  }
  function filingStatus(input,deadline){
    const status=input.filingStatus||'unknown';
    if(status==='none'||status==='notFiled')return assessment('unavailable',['必要な届出・登録の提出を予定していません。']);
    if(status!=='filed'&&status!=='planned')return assessment('unknown',['提出済みの事実又は期限内の提出予定が未確認です。']);
    if(!date(input.filingDate))return assessment('unknown',['届出・登録の提出日又は予定日が未入力です。']);
    if(input.filingDate>deadline)return assessment('unavailable',[`提出日が${deadline}の期限後です。`]);
    if(status==='planned'&&date(input.asOfDate)&&input.asOfDate>deadline)return assessment('unavailable',[`${input.asOfDate}時点で提出期限を過ぎています。`]);
    if(status==='planned'&&date(input.asOfDate)&&input.filingDate<input.asOfDate)return assessment('unknown',['過去の提出予定日です。提出済みか確認してください。']);
    return assessment(status==='filed'?'available':'planned',[status==='filed'?'提出済みとの入力を使用しています。受付記録を確認してください。':'期限内の提出を仮定した経路です。提出済みではありません。']);
  }
  function coveredPeriodForDate(dayValue,periods){ return periods.find(p=>p.start<=dayValue&&dayValue<=p.end)||null; }
  function assessVoluntaryRoute(input={}){
    const p=period(input.period||input);
    if(!p)return assessment('unknown',['対象課税期間を確認してください。'],{taxableWindow:null});
    const route=input.route||'maintain';
    if(route==='maintain'||route==='none'){
      const obligation=assessTaxObligation({...input,period:p});
      if(obligation.obligation==='taxable')return assessment('unavailable',obligation.reasons,{taxableWindow:p,obligation:'taxable'});
      return {...obligation,taxableWindow:null,route:'maintain'};
    }
    if(route!=='election'&&route!=='invoice')return assessment('unknown',['課税選択届出と登録経由を区別してください。'],{taxableWindow:null});
    const baseline=assessTaxObligation({...input,period:p});
    if(baseline.obligation==='taxable')return assessment('unavailable',[
      '対象期間は既に納税義務があるため、免税維持と任意の課税選択の比較対象ではありません。',...baseline.reasons
    ],{route,obligation:'taxable',taxableWindow:p});
    let effectiveFrom=p.start,deadline=day(p.start,-1),policyScenario=false;
    if(route==='election'){
      if(input.scenario==='foodProposal'&&p.start<=POLICY.start&&p.end>=POLICY.start&&input.foodSalesState==='yes'){
        deadline=p.end;policyScenario=true;
      }
      if(input.newBusiness===true)deadline=p.end;
    }else{
      effectiveFrom=input.registrationDate||input.effectiveFrom;
      if(!date(effectiveFrom)||effectiveFrom<p.start||effectiveFrom>p.end)return assessment('unknown',['対象期間内の登録日又は登録希望日を確認してください。'],{taxableWindow:null,route});
      // The transitional mid-period route applies only to the tax period
      // containing a day from 2023-10-01 through 2029-09-30.
      if(p.end<'2023-10-01'||p.start>'2029-09-30')return assessment('unavailable',['登録経過措置の対象課税期間外です。通常の課税選択手続を確認してください。'],{taxableWindow:null,route});
      deadline=day(effectiveFrom,-15);
    }
    let filed=filingStatus(input,deadline);
    if(route==='invoice'&&filed.status==='available'&&input.registrationStatus!=='registered'){
      filed=assessment('planned',[...filed.reasons,'登録申請の提出と実際の登録効力は別です。登録を受けることを仮定しています。']);
    }
    if(baseline.obligation==='unknown'&&filed.status!=='unavailable'){
      filed=assessment('unknown',[...filed.reasons,...baseline.reasons,'課税した場合の概算と、対象期間の納税義務・選択可否を分けて表示します。']);
    }
    const until=day(year(effectiveFrom,2),-1);
    const knownPeriods=input.periods||buildProjectionPeriods({...p,entity:input.entity});
    const through=route==='invoice'?coveredPeriodForDate(until,knownPeriods)?.end||until:until;
    return {...filed,route,effectiveFrom,taxableWindow:{start:effectiveFrom,end:p.end},deadline,
      policyScenario,obligation:'taxable',bindingKind:route==='election'?'taxableElection':'invoiceRegistration',bindingThrough:through,
      exitStatus:input.assetRestrictionState==='no'?'requiresCancellation':input.assetRestrictionState==='yes'?'restricted':'unknown',
      reasons:[...filed.reasons,...(policyScenario?['食品1％の課税選択届出特例は成立前の改正案に基づく仮定です。']:[]),
        input.assetRestrictionState==='no'?'免税へ戻るには拘束期間経過後の不適用届出又は登録取消と、その期の納税義務判定が必要です。':input.assetRestrictionState==='yes'?'資産取得による免税復帰の制限があります。制限対象期間を確認してください。':'調整対象固定資産・高額特定資産等による免税復帰の制限が未確認です。']};
  }
  function assessExit(input,entry,p){
    const exit=input.exit||{};
    if(!date(exit.effectiveFrom)||exit.effectiveFrom>p.start)return null;
    const exitPeriod=(input.periods||[]).find(item=>item.start===exit.effectiveFrom);
    if(!exitPeriod)return assessment('unknown',['免税復帰の適用開始期と取消の効力を確認してください。']);
    if(exit.effectiveFrom<=entry.bindingThrough)return assessment('unavailable',['課税選択又は登録経由の継続制限中です。']);
    if(input.assetRestrictionState==='yes')return assessment('unavailable',['資産取得による免税復帰の制限があります。']);
    if(input.assetRestrictionState!=='no')return assessment('unknown',['資産取得による免税復帰の制限が未確認です。']);
    const deadline=day(exit.effectiveFrom,entry.route==='invoice'?-15:-1);
    const filed=filingStatus({...exit,asOfDate:input.asOfDate},deadline);
    if(filed.status==='unavailable'||filed.status==='unknown')return filed;
    if(entry.route==='election'){
      const elapsedDay=day(year(entry.effectiveFrom,2),-1);
      const noticePeriod=coveredPeriodForDate(elapsedDay,input.periods||[]);
      if(!noticePeriod)return assessment('unknown',['課税選択不適用届出を提出できる期間が未確認です。']);
      if(exit.filingDate<noticePeriod.start)return assessment('unavailable',['課税選択不適用届出の提出可能期間より前の日付です。']);
    }
    const obligation=assessTaxObligation({...input,period:p,confirmedStatus:undefined,invoiceActive:false,electionActive:false});
    if(obligation.obligation==='taxable')return assessment('unavailable',obligation.reasons);
    if(obligation.obligation!=='exempt')return assessment('unknown',obligation.reasons);
    return {...filed,obligation:'exempt',forecast:obligation.forecast===true};
  }
  function buildObligationProjection(input={}){
    const periods=(input.periods||buildProjectionPeriods(input)).map(value=>{
      const p=period(value);return p?{...p,label:value.label||label(p,input.entity),assumed:value.assumed===true}:null;
    }).filter(Boolean);
    if(!periods.length)return {periods:[],entry:null,reasons:['比較対象期間がありません。']};
    const entry=assessVoluntaryRoute({...input,...input.periodFacts?.[0],period:periods[0],periods});
    const rows=periods.map((p,index)=>{
      const factInput={...input,...input.periodFacts?.[index],period:p,periods};
      if(index===0)return {...p,...entry};
      if(input.route==='maintain'||input.route==='none'||!input.route)return {...p,...assessVoluntaryRoute({...factInput,confirmedStatus:undefined,route:'maintain'})};
      if(entry.status==='unknown'||entry.status==='unavailable')return {...p,...assessment(entry.status,entry.reasons),taxableWindow:p,obligation:'unknown'};
      const exit=assessExit(factInput,entry,p);
      if(exit?.obligation==='exempt')return {...p,...exit,
        status:entry.status==='planned'||exit.status==='planned'?'planned':'available',
        taxableWindow:null,policyScenario:entry.policyScenario,
        reasons:[...entry.reasons,...(factInput.assetReasons||[]),...exit.reasons]};
      return {...p,status:entry.status,eligibility:entry.eligibility,obligation:'taxable',taxableWindow:p,
        bindingKind:entry.bindingKind,bindingThrough:entry.bindingThrough,
        reasons:[...entry.reasons,...(factInput.assetReasons||[]),...(exit?exit.reasons:[])],exitStatus:exit?.status||'notRequested',
        policyScenario:entry.policyScenario};
    });
    return {periods:rows,entry,reasons:[],completeThroughPolicyEnd:periods.some(p=>p.start>POLICY.end)};
  }
  return Object.freeze({POLICY,SOURCES,buildProjectionPeriods,referencePeriods,resolveReferenceFacts,assessTaxObligation,assessVoluntaryRoute,buildObligationProjection});
});
