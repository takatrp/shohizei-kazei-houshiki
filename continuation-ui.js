/* Optional continuations share ordinary rows and computed results. No network or storage API. */
(function(root){
  'use strict';
  const byId = id => document.getElementById(id);
  const esc = value => escapeHtml(String(value ?? ''));
  const initial = () => ({version:1,quick:{},periods:{},prior:{},priorHistory:{},voluntary:{route:'maintain'}});
  let state=initial(), estimates=[],periodRollback=null,lastProjection=null;
  const periodKey = ctx => `${ctx.start}|${ctx.end}`;
  function number(value){return String(value ?? '').trim()==='' ? null : Number(String(value).replace(/,/g,''));}
  function field(id,label,type='text',value=''){
    return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value)}"${type==='text'?' inputmode="decimal"':''}></div>`;
  }
  function select(id,label,options){return `<div class="field"><label for="${id}">${label}</label><select id="${id}">${options.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></div>`;}
  function bind(id,get,set){
    byId(id).value=get()??'';
    byId(id).addEventListener('input',e=>{e.stopPropagation();set(e.target.value);if(id==='voluntaryTargetStatus')state.voluntary.targetStatusPeriod={start:byId('periodStart').value,end:byId('periodEnd').value};update();});
    byId(id).addEventListener('change',e=>{e.stopPropagation();set(e.target.value);if(id==='voluntaryTargetStatus')state.voluntary.targetStatusPeriod={start:byId('periodStart').value,end:byId('periodEnd').value};update();});
  }
  function quickContext(){return {rows:taxEntryRows,actualOnePercentEntries:importedActualOnePercent?.entries||[],hasCsvSource:Boolean(importedCsvOriginalSourceId||importedCsvOrigin)};}
  function applyQuick(){
    if(entryMode!=='rows') return;
    const built=ShohizeiFourAmountEntry.draft(state.quick,quickContext());
    if(!built.ready){if(built.draft){taxEntryRows=built.rows;renderTaxEntryRows('sales');renderTaxEntryRows('purchases');}byId('quickEntryStatus').textContent=built.errors.map(x=>x.message).join(' ');return;}
    taxEntryRows=built.rows;rowCsvKnownZeros={nonTaxableSales:true};
    byId('modeTaxIncluded').checked=true;
    byId('proposalFoodClassificationState').value='unknown';byId('proposalPurchaseClassificationState').value='unknown';
    renderTaxEntryRows('sales');renderTaxEntryRows('purchases');
    byId('quickEntryStatus').textContent='4金額を詳細行に反映しました。下の内訳も同じ金額です。資料未確認の仮定として比較します。';
  }
  function init(){
    const panel=document.createElement('section');panel.className='panel no-print';panel.id='quickEntryPanel';
    panel.innerHTML='<h3>業種型と4金額から入力</h3><p id="quickEntryIntro" class="mini"></p>'+
      select('quickIndustry','業種型（事業区分の初期候補）',[['','選択してください'],...ShohizeiFourAmountEntry.INDUSTRIES.map(x=>[x.key,x.label])])+
      '<div class="grid two">'+field('quickFoodSales','食品売上（税込）')+field('quickOtherSales','その他売上（税込）')+field('quickFoodPurchases','食品仕入（税込）')+field('quickOtherPurchases','その他の課税仕入・経費（税込）')+'</div><p id="quickEntryAssumptions" class="mini"></p><p id="quickEntryStatus" class="mini" role="status"></p>';
    byId('workflowScreen2').prepend(panel);
    for(const [key,id] of Object.entries({industry:'quickIndustry',foodSales:'quickFoodSales',otherSales:'quickOtherSales',foodPurchases:'quickFoodPurchases',otherPurchases:'quickOtherPurchases'})){
      byId(id).addEventListener('input',e=>{e.stopPropagation();state.quick[key]=e.target.value;applyQuick();update();});
      byId(id).addEventListener('change',e=>{e.stopPropagation();state.quick[key]=e.target.value;applyQuick();update();});
    }
    for(const id of ['rowSalesInput','rowPurchaseInput']){
      const node=byId(id),details=document.createElement('details');details.className='quick-details';details.innerHTML='<summary>課税区分別の詳細入力・内訳を見る</summary>';node.before(details);details.append(node);
    }
    const projection=document.createElement('section');projection.className='panel';projection.id='foodContinuationPanel';
    projection.innerHTML='<details id="foodProjectionDetails"><summary>措置終了後まで比較</summary><p class="mini">当期の金額・構成・価格前提を引継いだ予測です。変わる期だけ修正できます。届出済み・期限内提出の仮定・可否未確認・選択不可を分けます。</p><div id="foodProjectionInputs"></div><div id="foodProjectionResults"></div></details>';
    byId('methodComparisonPanel').after(projection);
    const voluntary=document.createElement('section');voluntary.className='panel is-hidden';voluntary.id='voluntaryPanel';
    voluntary.innerHTML='<h3>免税から課税を選択した場合</h3><p class="mini">現在の免税と対象期の納税義務は別に判定します。税額比較は課税選択した場合の参考額です。</p><div class="grid two">'+
      select('voluntaryTargetStatus','対象期の納税義務（現在の申告方式とは別）',[['unknown','未確認'],['exempt','この対象期は免税'],['taxable','この対象期は課税']])+select('voluntaryRoute','検討経路',[['maintain','免税維持を検討'],['election','課税事業者選択届出による経路'],['invoice','インボイス登録による経路']])+
      select('voluntaryFiling','選択届出・登録申請の状態',[['unknown','未確認'],['planned','提出予定'],['filed','提出済み'],['none','提出しない']])+
      field('voluntaryFilingDate','提出日・予定日','date')+select('voluntaryRegistrationStatus','登録の効力',[['unknown','未確認'],['planned','登録希望・予定'],['registered','登録済み']])+field('voluntaryRegistrationDate','登録開始日・希望日','date')+
      select('voluntaryAsset','資産取得等による制限',[['unknown','未確認'],['no','制限対象なし'],['yes','制限あり']])+
      select('voluntaryOther','基準期間等以外の納税義務',[['unknown','未確認'],['no','該当なし'],['yes','該当あり']])+
      field('voluntaryExit','課税選択・登録をやめたい期の開始日','date')+select('voluntaryExitStatus','取消・不適用届出の状態',[['unknown','未確認'],['planned','提出予定'],['filed','提出済み'],['none','提出しない']])+field('voluntaryExitFilingDate','取消・不適用届出の提出日・予定日','date')+'</div><div id="voluntaryResult" role="status"></div>';
    voluntary.querySelector('p').textContent+=' CSVの特定期間実績は資料期の課税・免税を確認できる場合に共用します。不明な場合は既存の特定期間売上高で補足できます。';
    byId('currentReturnMethod').closest('.grid').after(voluntary);
    for(const [key,id] of Object.entries({registrationStatus:'voluntaryRegistrationStatus',targetStatus:'voluntaryTargetStatus',exitStatus:'voluntaryExitStatus',exitFilingDate:'voluntaryExitFilingDate',route:'voluntaryRoute',filingStatus:'voluntaryFiling',filingDate:'voluntaryFilingDate',registrationDate:'voluntaryRegistrationDate',assetRestrictionState:'voluntaryAsset',otherObligation:'voluntaryOther',exitDate:'voluntaryExit'})) bind(id,()=>state.voluntary[key],v=>state.voluntary[key]=v);
    const prior=document.createElement('details');prior.id='foodInterimDetails';prior.innerHTML='<summary>通常中間納付と食品特例を比較（政策試算）</summary><p class="mini">実際の前期資料を使います。STEP3の代理額・当期入力からは自動転記しません。旧保存の「一般課税など」は正確な方式へ推定しません。</p><div id="foodPriorScope" class="mini"></div><div class="grid two">'+
      select('foodPriorMethod','前期の正確な適用方式',[['','未確認'],['regular','一般課税'],['simplified','簡易課税'],['special2','2割特例'],['special3','3割特例']])+
      select('foodPriorBusiness','前期の事業区分（複数事業は未対応）',[['','未確認'],...ShohizeiFourAmountEntry.INDUSTRIES.map(x=>[x.businessType,x.label])])+
      select('foodPriorFoodRate','前期食品の実際の元税率',[['','未確認'],['8','8％実績'],['1','1％実績'],['mixed','8％・1％が混在']])+field('foodPriorSales','前期食品売上（税込合計）')+field('foodPriorOtherSales','前期その他売上（税込10％）')+
      field('foodPriorPurchases','前期食品仕入（税込合計）')+field('foodPriorSalesOne','混在時：うち実際1％の食品売上（税込）')+field('foodPriorPurchasesOne','混在時：うち実際1％の食品仕入（税込）')+field('foodPriorOtherPurchases','前期その他課税仕入（税込10％）')+
      field('foodPriorNonTaxable','前期非課税売上等（該当なしは0円）')+field('foodPriorAdjustment','前期の国税個別調整（該当なしは0円）')+
      select('foodPriorCredit','前期の控除方法',[['','未確認'],['full','全額控除の要件を満たす'],['individual','個別対応方式（資料の用途区分を使用）'],['proportional','一括比例配分方式']])+
      select('foodInterimA','A＝現行税率側の利用予定',[['ordinary','通常納付を維持'],['special','算定できた食品特例を利用予定']])+
      select('foodInterimB','B＝食品1％側の利用予定',[['ordinary','通常納付を維持'],['special','算定できた食品特例を利用予定']])+
      '</div><div id="foodReturnEvidence"></div><p class="mini">補足4金額は元税率を確認した食品・その他10％、通常仕入・課税売上対応の資料に限ります。返品は元取引の税率・課税状態を補足すると対応範囲の特例を計算できます。輸入、複雑な負額・複数事業等の未対応範囲は理由を表示し、通常納付を続けます。年税額は変わらず確定納付・還付で精算します。</p>';
    byId('cashflowAutoSummary').before(prior);
    byId('foodReturnEvidence').addEventListener('change',e=>{
      const kind=e.target.dataset.returnKind,index=Number(e.target.dataset.returnIndex),key=e.target.dataset.returnKey;
      if(!['originalTaxableState','originalRatePercent','originalDate'].includes(key)||!Number.isInteger(index))return;
      const item=kind==='actual'?importedActualOnePercent?.entries?.[index]:taxEntryRows.sales[index];
      if(item){item[key]=e.target.value;update();}e.stopPropagation();
    });
    for(const [key,id] of Object.entries({exactMethod:'foodPriorMethod',businessType:'foodPriorBusiness',foodRate:'foodPriorFoodRate',foodSalesOne:'foodPriorSalesOne',foodPurchasesOne:'foodPriorPurchasesOne',foodSales:'foodPriorSales',otherSales:'foodPriorOtherSales',foodPurchases:'foodPriorPurchases',otherPurchases:'foodPriorOtherPurchases',nonTaxableSales:'foodPriorNonTaxable',adjustmentNational:'foodPriorAdjustment',creditMethod:'foodPriorCredit',A:'foodInterimA',B:'foodInterimB'})) bind(id,()=>state.prior[key],v=>{const p=sharedCaseFacts.priorActual?.value?.period;state.prior={...state.prior,[key]:v,period:p?{...p}:null};});
    for(const id of ['periodStart','periodEnd']) byId(id).addEventListener('focus',capturePeriod);
  }
  function nonPeriodEvidence(side){return JSON.stringify([taxEntryRows[side],(importedActualOnePercent?.entries||[]).filter(e=>side==='sales'?e.kind==='sale':e.kind!=='sale'),selectedValue('amountMode'),taxScenarioKey(),byId('foodForecastMethod').value,byId(side==='sales'?'foodSalesPriceBasis':'foodPurchasePriceBasis').value]);}
  function capturePeriod(){
    if(!periodRollback || periodRollback.start===byId('periodStart').value&&periodRollback.end===byId('periodEnd').value)
      periodRollback={start:byId('periodStart').value,end:byId('periodEnd').value,evidence:{sales:nonPeriodEvidence('sales'),purchases:nonPeriodEvidence('purchases')},sales:byId('proposalFoodClassificationState').value,purchases:byId('proposalPurchaseClassificationState').value};
  }
  function rollbackPeriod(){
    if(periodRollback&&periodRollback.start===byId('periodStart').value&&periodRollback.end===byId('periodEnd').value){
      if(periodRollback.evidence.sales===nonPeriodEvidence('sales')){byId('proposalFoodClassificationState').value=periodRollback.sales;delete foodConfirmationSignatures.sale;}
      if(periodRollback.evidence.purchases===nonPeriodEvidence('purchases')){byId('proposalPurchaseClassificationState').value=periodRollback.purchases;delete foodConfirmationSignatures.purchase;}
    }
    periodRollback=null;
  }
  function foodAmount(amount,ctx,selection={}){
    const kind=['purchases','invoicePurchase','exemptPurchase'].includes(selection.kind)?'purchases':'sales';
    const filter={...selection,kind,...(selection.kind==='invoicePurchase'?{purchaseKind:'invoice'}:selection.kind==='exemptPurchase'?{purchaseKind:'exempt'}:{})};
    const result=ShohizeiFoodPeriodEstimator.estimate({amount,...filter,
      periodStart:ctx.start,periodEnd:ctx.end,mode:ctx.foodForecastMethod||'uniform',rows:ctx.entryRows||taxEntryRows,
      monthlyGroups:importedCsvMonthlyGroups,sourceFacts:sharedCaseFacts.csvSource,currentSourceId:importedCsvOriginalSourceId,
      dateUnknownCount:importedCsvMonthlyDateUnknownCount});
    if(!ctx.projection && (entryMode!=='rows'||selection.row)){
      const key=JSON.stringify([kind,selection.row?.id||selection.row||filter.businessType||filter.purchaseKind||'',ctx.start,ctx.end]);
      const saved={...result,kind,key};const index=estimates.findIndex(e=>e.key===key);if(index<0)estimates.push(saved);else estimates[index]=saved;
    }
    return result.amount;
  }
  function scaleRow(row,multiplier){const next={...row};if(multiplier===1)return next;for(const key of ['amount','foodAmount']) if(String(next[key]??'').trim()!=='') next[key]=String(Math.round(Number(String(next[key]).replace(/,/g,''))*multiplier));return next;}
  function periodAssumptions(period){return state.periods[periodKey(period)]||{};}
  function csvWindow(period,window){
    return ShohizeiTaxableWindowRows.slice({rows:taxEntryRows,actualOnePercentEntries:importedActualOnePercent?.entries||[],period,window,
      csvSource:sharedCaseFacts.csvSource,currentSourceId:importedCsvOriginalSourceId,
      dailyGroups:importedCsvDailyGroups,monthlyGroups:importedCsvMonthlyGroups,dateUnknownCount:importedCsvMonthlyDateUnknownCount,knownZeros:rowCsvKnownZeros});
  }
  function initialReferenceHistory(ctx){
    const refs=ShohizeiTaxObligation.referencePeriods({entity:ctx.entity,period:{start:ctx.start,end:ctx.end}}),history=[];
    if(refs.base&&ctx.baseSalesEntered)history.push({...refs.base,taxableSales:ctx.baseTaxableSales,source:'actual',entered:true});
    if(refs.specified&&ctx.specificSalesEntered)history.push({...refs.specified,taxableSales:ctx.specificTaxableSales,source:'actual',entered:true});
    appendCsvReference(history,ctx,refs.specified);
    return history;
  }
  function appendCsvReference(history,ctx,window){
    if(!window||history.some(p=>p.start===window.start&&p.end===window.end))return;
    const sourcePeriod=sharedCaseFacts.csvSource?.status==='resolved'?sharedCaseFacts.csvSource.value?.period:null;
    const sliced=csvWindow(sourcePeriod,window);if(!sliced.ready)return;
    const same=p=>p?.start===sourcePeriod.start&&p?.end===sourcePeriod.end;
    const priorTaxable=sharedCaseFacts.priorActual?.status==='resolved'&&same(sharedCaseFacts.priorActual.value?.period)&&same(state.prior.period)&&['regular','simplified','special2','special3'].includes(state.prior.exactMethod);
    const confirmed=same(state.voluntary.targetStatusPeriod)?state.voluntary.targetStatus:null;
    if(priorTaxable&&confirmed==='exempt')return;
    const sourceStatus=priorTaxable?'taxable':['exempt','taxable'].includes(confirmed)?confirmed:null;
    // The present method does not establish the historical CSV period's status.
    if(!sourceStatus)return;
    const actual=ShohizeiSalesScenario.collectSalesScenario({sales:sliced.rows.sales,actualOnePercentEntries:sliced.actualOnePercentEntries},
      {businessTypes:BUSINESS_TYPES,taxScenario:ctx.taxScenario,amountMode:'included',foodForecastMethod:'uniform',proposalFraction:0,foodPeriodAmount:()=>0,periodStart:window.start,periodEnd:window.end});
    const amount=sourceStatus==='exempt'?actual.totalAmount:actual.totalTaxableBase;
    if(!actual.errors.length&&Number.isFinite(amount))history.push({...window,taxableSales:amount,source:'csv-actual',entered:true});
  }
  function periodAssetFacts(calc,periods){
    const facts=periods.map(()=>({assetRestrictionState:state.voluntary.assetRestrictionState||'unknown',assetReasons:[]}));
    const shift=(date,years)=>{const d=new Date(date+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()+years);return d.toISOString().slice(0,10);};
    const adjustedCurrent=state.voluntary.route==='election'&&calc.ctx.highAssetType==='fixed'&&calc.ctx.highAssetAmountEntered&&calc.ctx.highAssetAmount>=1000000;
    if(calc.ctx.highAssetState==='yes'&&(['restricted','unknown'].includes(calc.highAssetRegular.status)||adjustedCurrent)){
      for(let j=0;j<periods.length&&periods[j].start<shift(periods[0].start,3);j++){
        if(facts[j].assetRestrictionState!=='yes')facts[j].assetRestrictionState='unknown';
        facts[j].assetReasons.push('当期の入力済み高額資産について、一般課税を選択した場合の制限を共有しています。取得日・取引単位・実際の申告方式を確認するまで免税復帰は未確認です。');
      }
    }
    for(let i=1;i<periods.length;i++){
      const investment=number(periodAssumptions(periods[i]).investment)||0;
      if(investment<11000000&&!(state.voluntary.route==='election'&&periods[i].start<shift(periods[0].start,2)&&investment>=1100000))continue;
      const through=shift(periods[i].start,3);
      for(let j=i;j<periods.length&&periods[j].start<through;j++){
        if(facts[j].assetRestrictionState!=='yes')facts[j].assetRestrictionState='unknown';
        facts[j].assetReasons.push(`${periods[i].label}の設備投資について、一取引単位・取得日・申告方式により資産制限が生じる可能性があり、免税復帰・簡易課税を未確認とします。投資合計だけで制限ありとは認定しません。`);
      }
    }
    return facts;
  }
  function grossTurnover(snapshot){
    return snapshot.rows.sales.reduce((total,r)=>total+(['1','11'].includes(String(r.code))?(number(r.amount)||0)*(String(r.code)==='11'?-1:1):0),0)
      +(snapshot.actuals||[]).filter(e=>e.kind==='sale').reduce((total,e)=>total+(number(e.amount)||0),0);
  }
  function projectionSnapshotFor(calc,period,index,window){
    const a=periodAssumptions(period),sg=number(a.salesGrowth)??0,pg=number(a.purchaseGrowth)??0,investment=number(a.investment)??0;
    if(sg < -100 || pg < -100 || investment < 0 || ![sg,pg,investment].every(Number.isFinite))return {error:'増減率は−100％以上、設備投資は0円以上で入力してください。'};
    const windowFraction=window?inclusiveDayCount(window.start,window.end)/inclusiveDayCount(period.start,period.end):1;
    const sliced=index===0&&window?csvWindow(period,window):null;
    const sourceRows=sliced?.ready?sliced.rows:taxEntryRows;
    const fraction=sliced?.ready?1:windowFraction;
    const rows={sales:sourceRows.sales.map(r=>scaleRow(r,(1+sg/100)*fraction)),purchases:sourceRows.purchases.map(r=>scaleRow(r,(1+pg/100)*fraction))};
    if(investment)rows.purchases.push({code:'5',rate:'10',amount:String(investment),foodAmount:'',source:'forecast'});
    const actuals=index===0?(sliced?.ready?sliced.actualOnePercentEntries:(importedActualOnePercent?.entries||[]).filter(e=>!window||e.date>=window.start&&e.date<=window.end)):[];
    // Only future forecasts re-express ordinary actual 1% transactions at the
    // source 8% price basis. Current dated actuals remain separate signed data.
    if(index>0)for(const e of importedActualOnePercent?.entries||[]){
      const side=e.kind==='sale'?'sales':'purchases';
      const basis=ShohizeiSalesScenario.forecastActualOneBasis(e,side==='sales'?calc.ctx.foodSalesPriceBasis:calc.ctx.foodPurchasePriceBasis);
      if(!basis.available)return {error:basis.reason};
      const usageCodes={taxableOnly:['5','52'],nonTaxableOnly:['6','62'],common:['7','72']};
      const use=usageCodes[e.usage];if(side==='purchases'&&!use)return {error:'明示1％仕入の用途が未確認です。'};
      const amount=Math.round(basis.amount*(side==='sales'?1+sg/100:1+pg/100)*fraction);
      rows[side].push({code:side==='sales'?'1':use[e.kind==='exemptPurchase'?1:0],rate:'8',businessType:e.businessType||'',creditRatio:e.creditRatio===undefined?'':String(e.creditRatio*100),amount:String(amount),foodAmount:String(amount),source:'forecast'});
    }
    const ctx={...calc.ctx,start:window?.start||period.start,end:window?.end||period.end,foodForecastMethod:'uniform',entryRows:rows,projection:true};
    const options={businessTypes:BUSINESS_TYPES,taxScenario:calc.ctx.taxScenario,foodForecastMethod:'uniform',proposalFraction:proposalOverlapFraction(ctx.start,ctx.end),amountMode:'included',periodStart:ctx.start,periodEnd:ctx.end,foodSalesPriceBasis:ctx.foodSalesPriceBasis,foodPurchasePriceBasis:ctx.foodPurchasePriceBasis,importFoodFraction:ctx.importFoodFraction,estimateFromBase:ctx.importEstimateBase===true,
      foodPeriodAmount:(row,value)=>sliced?.ready&&Object.hasOwn(sliced.foodPeriodAmountsById,row.id)?sliced.foodPeriodAmountsById[row.id]*(row.code==='1'?1+sg/100:1+pg/100):foodAmount(value,ctx,{kind:['1','11'].includes(String(row.code))?'sales':'purchases',row})};
    const sales=ShohizeiSalesScenario.collectSalesScenario({sales:rows.sales,actualOnePercentEntries:actuals},options);
    const raw=ShohizeiTaxEntryRows.aggregateScenarioPurchases({purchases:rows.purchases,actualOnePercentEntries:actuals}, {...options,exemptRatioOverride:weightedExemptPurchaseRatio(ctx.start,ctx.end).ratio});
    const nonTaxable=rows.sales.filter(r=>r.code==='3').reduce((t,r)=>t+(number(r.amount)||0),0);
    const purchases={...calc.purchases,...raw,adjustment:calc.purchases.adjustment*(1+pg/100)*fraction,purchaseUsageErrors:raw.errors,purchaseCalculationErrors:raw.calculationErrors,purchaseRatioConflicts:[],purchaseAmountEntered:rows.purchases.some(r=>String(r.amount??'').trim()!==''),exemptBuckets:[]};
    ctx.nonTaxableSales=nonTaxable;
    const regular=calculateRegularForContext(ctx,sales,purchases,purchases.exemptCreditableTax);
    const allocation=sliced?.ready?`${sliced.label}。${sliced.notes.join(' ')}`:windowFraction<1?`登録後の日数で売上・仕入を均等配分した概算（行ごとに税込1円へ四捨五入）。${sliced?.reason||'実際の日付別取引額は未確認です。'}`:'当期の金額・構成を引継いだ課税選択の概算。';
    return {ctx,rows,actuals,sales,purchases,regular,investment,allocation,allocationMethod:sliced?.ready?sliced.method:windowFraction<1?'days':'forecast',errors:[...sales.errors,...raw.errors,...raw.calculationErrors]};
  }
  function projectionPlan(calc){
    const periods=ShohizeiTaxObligation.buildProjectionPeriods({entity:calc.ctx.entity,start:calc.ctx.start,end:calc.ctx.end,scenario:'foodProposal'});
    if(!calc.comparisonReady||entryMode!=='rows')return {periods,projections:[],optimized:{ok:false,reason:'当期の入力・詳細行を確認すると将来期を比較できます。'}};
    const projections=[],routePeriods=[],history=initialReferenceHistory(calc.ctx),assetFacts=periodAssetFacts(calc,periods);let assetUnknownThrough=-1;
    const initialRefs=ShohizeiTaxObligation.referencePeriods({entity:calc.ctx.entity,period:periods[0]});
    if(initialRefs.base&&calc.ctx.baseSalesEntered)history.push({...initialRefs.base,taxableSales:calc.ctx.baseTaxableSales,source:'actual',entered:true});
    for(let index=0;index<periods.length;index++){
      const period=periods[index],a=periodAssumptions(period),snapshot=index===0?{ctx:calc.ctx,sales:calc.sales,purchases:calc.purchases,regular:calc.regular,investment:0,errors:[]}:projectionSnapshotFor(calc,period,index);
      const refs=ShohizeiTaxObligation.referencePeriods({entity:calc.ctx.entity,period});
      if(index===1&&refs.base&&number(a.baseSales)!==null)history.push({...refs.base,taxableSales:number(a.baseSales),source:'actual',entered:true});
      appendCsvReference(history,calc.ctx,refs.specified);
      const resolved=ShohizeiTaxObligation.resolveReferenceFacts({entity:calc.ctx.entity,period,history}),fact=resolved.baseFact;
      const reference={value:fact.value,entered:fact.entered,label:refs.base?`${refs.base.start}〜${refs.base.end}／${fact.source==='forecast'?'予測':'実績又は未確認'}`:'基準期間を個別確認'};
      const methods=(calc.ctx.comparisonMethods||[]).map(key=>{
        let amount=null,reasons=[],eligibility='eligible';
        if(index===0){const m=calc.methods.find(m=>m.key===key);amount=m?.amount??null;eligibility=m?.eligibility||'unknown';reasons=m?.reasons||[];}
        else if(!snapshot.error){
          if(key==='regular')amount=snapshot.regular.amount;
          else if(key==='simplified')amount=snapshot.sales.simplified.amount;
          else amount=calculateSpecialMethodAmount({totalSalesTax:snapshot.sales.totalTax,foodOnePercentTax:snapshot.sales.simplified.foodOnePercentTax,burdenRatio:key==='special2'?.2:.3}).amount;
          if(snapshot.errors.length){amount=null;reasons.push(...snapshot.errors.map(x=>x.message||x));}
          if(key==='regular'&&amount===null)reasons.push(...snapshot.regular.unavailableReasons||[]);
          if(key==='simplified'){
            if(!reference.entered){eligibility='unknown';reasons.push('この期の基準期間売上高が未確認です。');}
            else if(reference.value>50000000){eligibility='ineligible';reasons.push('基準期間売上高が5,000万円超です。届出効力は終了しません。');}
            if(index<=assetUnknownThrough||(calc.ctx.currentReturnMethod==='exempt'&&snapshot.investment>=1100000)){eligibility='unknown';reasons.push('資産取得・継続制限を個別に確認してください。');}
          }
          if(key!=='regular'&&((calc.ctx.highAssetState==='yes'&&calc.highAssetRegular.status==='unknown')||assetFacts[index].assetReasons.length)){eligibility='unknown';reasons.push(...(calc.highAssetRegular.status==='unknown'?calc.highAssetRegular.reasons||[]:[]),...assetFacts[index].assetReasons,'資産取得による適用制限の対象期・取得方式が未確認です。');}
          if(key==='special2'||key==='special3'){const ctx={...snapshot.ctx,baseTaxableSales:reference.value,baseSalesEntered:reference.entered,specificTaxableSales:resolved.specifiedFact.value,specificSalesEntered:resolved.specifiedFact.entered,specificPayrollEntered:false,specificInputEntered:resolved.specifiedFact.entered,specificUnder10m:resolved.specifiedFact.entered&&resolved.specifiedFact.value<=10000000};const e=getEligibility(ctx)[key];eligibility=eligibility==='unknown'&&reasons.length?'unknown':e.eligibility;reasons.push(...e.reasons);}
        }else reasons.push(snapshot.error);
        return {key,amount,eligibility,reasons,include:amount!==null&&eligibility==='eligible'};
      });
      if(calc.ctx.currentReturnMethod==='exempt'&&snapshot.investment>=1100000)assetUnknownThrough=index+2;
      if(snapshot.sales)history.push({...period,taxableSales:snapshot.sales.totalTaxableBase,source:'forecast',entered:true});
      projections.push({period,methods,base:reference,snapshot});
      routePeriods.push({label:period.label,start:period.start,end:period.end,targetPeriod:period,methods:methods.map(m=>({...m,eligible:m.include})),
        previousPeriod:index===0?calc.ctx.electionDeadlineInput.previousPeriod:periods[index-1],
        noticeReady:index===0?calc.ctx.simpleNoticeReady:calc.ctx.futureElectionPlan,futureElectionReady:calc.ctx.futureElectionPlan,
        discontinuanceReady:index===0?calc.ctx.currentDiscontinuanceReady:calc.ctx.futureElectionPlan,
        simplifiedUnavailablePreservesElection:reference.entered&&reference.value>50000000,
        highValueAssetTrigger:index===0&&calc.highAssetRegular.status==='restricted'||snapshot.investment>=11000000,
        futureElectionDetails:index<periods.length-1?{entityType:calc.ctx.entity,consumptionTaxExtension:calc.ctx.electionDeadlineInput.consumptionTaxExtension,asOfDate:calc.ctx.electionDeadlineInput.asOfDate,filingStatus:calc.ctx.futureElectionPlan==='yes'?'planned':calc.ctx.futureElectionPlan==='no'?'notFiled':'unknown',filingDate:''}:null,
        foodDiscontinuanceInput:{scenario:'foodProposal',foodSalesState:byId('switchFoodSalesState').value,simplifiedAppliedState:byId('switchSimplifiedAppliedState').value,noOtherRestrictionsState:byId('switchNoOtherRestrictionsState').value,filingStatus:byId('switchFilingStatus').value,filingDate:byId('switchFilingDate').value},
        electionDeadlineInput:{...calc.ctx.electionDeadlineInput,targetPeriod:period,previousPeriod:index===0?calc.ctx.electionDeadlineInput.previousPeriod:periods[index-1],filingStatus:index===0?calc.ctx.electionDeadlineInput.filingStatus:calc.ctx.futureElectionPlan==='yes'?'planned':'unknown',filingDate:index===0?calc.ctx.electionDeadlineInput.filingDate:'',previousMethod:index===0?calc.ctx.electionDeadlineInput.previousMethod:'unknown'}});
    }
    const optimized=optimizeFourPeriodRoutes({periods:routePeriods,initialElectionStatus:!calc.ctx.comparisonMethods.includes('simplified')&&calc.ctx.currentReturnMethod==='regular'&&calc.ctx.simpleElectionStatus==='unknown'?'none':calc.ctx.simpleElectionStatus,noticeReady:calc.ctx.simpleNoticeReady});
    if(!periods.some(p=>p.start>'2029-03-31')){optimized.ok=false;optimized.reason='表示可能な期間内で措置終了後へ到達していません。開始期・将来期の期間を確認してください。';}
    return {periods,projections,optimized};
  }
  function projectionRows(plan){
    const labels={eligible:'税額算定可・届出経路は別判定',unknown:'資料不足で可否未確認',ineligible:'選択不可'};
    return plan.projections.flatMap((p,i)=>p.methods.map(m=>[p.period.label,METHOD_LABELS[m.key],m.amount===null?'未算定':Math.round(m.amount),labels[m.eligibility],m.reasons.join(' / '),`基準期間 ${p.base.entered?Math.round(p.base.value):'未確認'} (${p.base.label})`]));
  }
  function renderReturnEvidence(){
    const items=[...taxEntryRows.sales.flatMap((r,i)=>r.code==='11'?[{row:r,index:i,kind:'row',label:`CSV売上返還 ${i+1}行目（元${r.rate}％）`}]:[]),...(importedActualOnePercent?.entries||[]).flatMap((e,i)=>e.transactionKind==='adjustment'?[{row:e,index:i,kind:'actual',label:`明示1％返品 ${i+1}件目`}]:[])];
    const host=byId('foodReturnEvidence'),key=JSON.stringify([importedCsvOriginalSourceId,items.map(i=>[i.kind,i.index,i.row.id,i.row.code,i.row.rate,i.row.amount,i.row.originalTaxableState,i.row.originalRatePercent,i.row.originalDate])]);
    if(host.dataset.key===key)return;const wasOpen=host.querySelector('details')?.open;host.dataset.key=key;
    host.innerHTML=items.length?'<details><summary>CSV返品の元取引について不足する情報だけ補足</summary><p class="mini">補足は元CSVの返品行に反映します。正式CSV期間が実前期と一致するときだけ中間特例にも共用します。元取引不明の該当税額は未算定です。区分11の金額は正が返品、負が返品取消です。</p>'+items.map(i=>`<div class="grid three"><label>${esc(i.label)}／元取引時の課税状態<select data-return-kind="${i.kind}" data-return-index="${i.index}" data-return-key="originalTaxableState">${[['unknown','未確認'],['taxable','課税取引'],['exempt','当事業者が免税の期間の取引']].map(([v,l])=>`<option value="${v}"${(i.row.originalTaxableState||'unknown')===v?' selected':''}>${l}</option>`).join('')}</select></label>${i.kind==='actual'?`<label>元税率<select data-return-kind="actual" data-return-index="${i.index}" data-return-key="originalRatePercent">${[['','未確認'],['1','1％'],['8','8％'],['10','10％']].map(([v,l])=>`<option value="${v}"${String(i.row.originalRatePercent||'')===v?' selected':''}>${l}</option>`).join('')}</select></label><label>元取引日<input type="date" value="${esc(i.row.originalDate||'')}" data-return-kind="actual" data-return-index="${i.index}" data-return-key="originalDate"></label>`:''}</div>`).join('')+'</details>':'';
    if(wasOpen&&host.querySelector('details'))host.querySelector('details').open=true;
  }
  function syncPriorScope(){
    const value=sharedCaseFacts.priorActual?.status==='resolved'?sharedCaseFacts.priorActual.value:null;
    if(!value||!validateTaxPeriod(value.period.start,value.period.end).valid)return;
    if(state.prior.period?.start===value.period.start&&state.prior.period?.end===value.period.end)return;
    if(state.prior.period)state.priorHistory[JSON.stringify(state.prior.period)]={...state.prior};
    state.prior={...(state.priorHistory[JSON.stringify(value.period)]||{}),period:{...value.period}};
    const ids={exactMethod:'foodPriorMethod',businessType:'foodPriorBusiness',foodRate:'foodPriorFoodRate',foodSales:'foodPriorSales',otherSales:'foodPriorOtherSales',foodPurchases:'foodPriorPurchases',otherPurchases:'foodPriorOtherPurchases',foodSalesOne:'foodPriorSalesOne',foodPurchasesOne:'foodPriorPurchasesOne',nonTaxableSales:'foodPriorNonTaxable',adjustmentNational:'foodPriorAdjustment',creditMethod:'foodPriorCredit'};
    for(const [k,id]of Object.entries(ids))byId(id).value=state.prior[k]??'';
    byId('foodInterimA').value=state.prior.A||'ordinary';byId('foodInterimB').value=state.prior.B||'ordinary';
  }
  function render(calc){
    syncPriorScope();renderReturnEvidence();
    const quickView=ShohizeiFourAmountEntry.presentation({industry:state.quick.industry,taxScenario:calc.ctx.taxScenario});
    byId('quickEntryIntro').textContent=quickView.intro;byId('quickEntryAssumptions').textContent=quickView.assumptions.join(' ');
    for(const [key,id]of Object.entries({foodSales:'quickFoodSales',otherSales:'quickOtherSales',foodPurchases:'quickFoodPurchases',otherPurchases:'quickOtherPurchases'}))document.querySelector(`label[for="${id}"]`).textContent=quickView.labels[key];
    const editable=entryMode==='rows'&&ShohizeiFourAmountEntry.editable(quickContext());
    for(const id of ['quickIndustry','quickFoodSales','quickOtherSales','quickFoodPurchases','quickOtherPurchases'])byId(id).disabled=!editable;
    const quickSummary=ShohizeiFourAmountEntry.summarize(taxEntryRows);
    for(const id of ['quickIndustry','quickFoodSales','quickOtherSales','quickFoodPurchases','quickOtherPurchases'])byId(id).closest('.field').classList.toggle('is-hidden',!editable);
    if(!editable){const labels={foodSales:'食品売上',otherSales:'その他売上',foodPurchases:'食品仕入',otherPurchases:'その他の課税仕入・経費'};byId('quickEntryStatus').textContent=Object.entries(quickSummary.amounts).map(([k,v])=>`${labels[k]} ${v===null?'未確認':yen(v)}`).join('／')+'。詳細・CSVの内訳を保持しています。金額は下の詳細入力で修正できます。'+quickSummary.reasons.join(' ');}
    for(const d of document.querySelectorAll('.quick-details'))if(!editable)d.open=true;
    const active=calc.ctx.taxScenario==='foodProposal';byId('foodContinuationPanel').classList.toggle('is-hidden',!active);
    byId('foodInterimDetails').classList.toggle('is-hidden',!active);
    const bothPolicy=cashflowComparisonType()==='methodImpact';
    byId('foodInterimA').disabled=!bothPolicy;byId('foodInterimA').value=bothPolicy&&state.prior.A==='special'?'special':'ordinary';
    byId('foodInterimB').value=state.prior.B==='special'?'special':'ordinary';
    document.querySelector('label[for="foodInterimA"]').textContent=bothPolicy?'A＝食品1％側の利用予定':'A＝現行税率側（通常納付に固定）';
    document.querySelector('label[for="foodInterimB"]').textContent='B＝食品1％側の利用予定';
    const exempt=calc.ctx.currentReturnMethod==='exempt';
    for(const id of ['voluntaryRegistrationStatus','voluntaryRegistrationDate'])byId(id).closest('.field').classList.toggle('is-hidden',state.voluntary.route!=='invoice');
    for(const id of ['voluntaryExitStatus','voluntaryExitFilingDate'])byId(id).closest('.field').classList.toggle('is-hidden',!state.voluntary.exitDate);byId('voluntaryPanel').classList.toggle('is-hidden',!exempt);
    byId('voluntaryTargetStatus').value=state.voluntary.targetStatusPeriod?.start===calc.ctx.start&&state.voluntary.targetStatusPeriod?.end===calc.ctx.end?state.voluntary.targetStatus||'unknown':'unknown';
    if(exempt)renderVoluntary(calc);
    for(const id of ['foodPriorSalesOne','foodPriorPurchasesOne'])byId(id).closest('.field').classList.toggle('is-hidden',state.prior.foodRate!=='mixed');
    const reuse=sharedPriorEvidence();
    const usingCsv=reuse.available&&!['foodSales','otherSales','foodPurchases','otherPurchases'].some(key=>String(state.prior[key]??'').trim()!=='');
    for(const id of ['foodPriorSales','foodPriorOtherSales','foodPriorPurchases','foodPriorOtherPurchases','foodPriorFoodRate'])byId(id).closest('.field').classList.toggle('is-hidden',usingCsv);
    const salesOnlyPrior=['simplified','special2','special3'].includes(state.prior.exactMethod);
    for(const id of ['foodPriorPurchases','foodPriorOtherPurchases'])byId(id).closest('.field').classList.toggle('is-hidden',usingCsv||salesOnlyPrior);
    byId('foodPriorPurchasesOne').closest('.field').classList.toggle('is-hidden',salesOnlyPrior||state.prior.foodRate!=='mixed');
    for(const id of ['foodPriorCredit','foodPriorNonTaxable','foodPriorAdjustment'])byId(id).closest('.field').classList.toggle('is-hidden',salesOnlyPrior);
    byId('foodPriorBusiness').closest('.field').classList.toggle('is-hidden',state.prior.exactMethod!=='simplified'||usingCsv);
    const prior=sharedCaseFacts.priorActual;byId('foodPriorScope').textContent=(usingCsv?'同じ元CSVから前期取引内訳を共用しています。4金額の再入力は不要です。 ':'')+(prior?.status==='resolved'?`共有された実際の前期：${prior.value.period.start||'未入力'}〜${prior.value.period.end||'未入力'}／国税額 ${prior.value.nationalTax||'未入力'}円。食品内訳はこの期にだけ使用します。`:'共有された実際の前期が未入力又は競合しています。通常中間納付の前期実績欄で解消してください。');
    if(active){
      lastProjection=projectionPlan(calc);
      const input=byId('foodProjectionInputs'),key=lastProjection.periods.map(periodKey).join(';');
      if(input.dataset.periods!==key){
        input.dataset.periods=key;input.innerHTML=lastProjection.periods.slice(1).map((p,i)=>`<details><summary>${esc(p.label)}の変更（任意）</summary><div class="grid three">${field('futureSales'+i,'売上増減％（当期比）')}${field('futurePurchases'+i,'仕入増減％（当期比）')}${field('futureInvestment'+i,'追加設備投資（税込10％、円）')}${i===0?field('futureBase'+i,'この期の基準期間売上高（円）'):''}</div></details>`).join('');
        lastProjection.periods.slice(1).forEach((p,i)=>{for(const [key,id] of [['salesGrowth','futureSales'+i],['purchaseGrowth','futurePurchases'+i],['investment','futureInvestment'+i],...(i===0?[['baseSales','futureBase'+i]]:[])])bind(id,()=>periodAssumptions(p)[key],v=>{state.periods[periodKey(p)]={...periodAssumptions(p),[key]:v};});});
      }
      const rows=projectionRows(lastProjection),opt=lastProjection.optimized;
      byId('foodProjectionResults').innerHTML='<p class="notice warn">改正案の政策シナリオ。各期の税率・参照期間で再計算しています。未確認の方式は最適経路へ含めません。</p>'+(opt.ok?`<p>${opt.selectionStatus==='planned'?'期限内提出を仮定した経路':'入力済み届出条件内の経路'}：${yen(opt.cumulative)}。${opt.bestRoute.map(x=>esc(METHOD_LABELS[x.method])).join(' → ')}</p>`:`<p>選択可能な累計経路は未確定：${esc(opt.reason)}</p>`)+`<div class="table-wrap"><table><thead><tr>${['課税期間','方式','参考税額（円）','状態','不足理由','参照期間'].map(x=>'<th>'+x+'</th>').join('')}</tr></thead><tbody>${rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>').join('')}</tbody></table></div><p class="mini">将来期は年額・現在の構成を引き継ぐ予測です。特定期間や資産制限は確認できない期だけ未確認とし、免税復帰を自動確定しません。</p>`;
      if(calc.ctx.viewMode==='projection')byId('foodProjectionDetails').open=true;
    }else lastProjection=null;
  }
  function voluntaryAssessment(calc){
    const periods=ShohizeiTaxObligation.buildProjectionPeriods({entity:calc.ctx.entity,start:calc.ctx.start,end:calc.ctx.end,scenario:calc.ctx.taxScenario});
    const history=initialReferenceHistory(calc.ctx);
    for(const period of periods)appendCsvReference(history,calc.ctx,ShohizeiTaxObligation.referencePeriods({entity:calc.ctx.entity,period}).specified);
    const assetFacts=periodAssetFacts(calc,periods);
    const periodFacts=periods.map((p,i)=>({...assetFacts[i],specifiedPayroll:i===0&&calc.ctx.specificPayrollEntered?calc.ctx.specificPayrollAmount:undefined}));
    const input={entity:calc.ctx.entity,periods,route:state.voluntary.route||'maintain',scenario:calc.ctx.taxScenario,foodSalesState:calc.sales.rows.some(r=>r.foodInputAmount>0)?'yes':'unknown',...state.voluntary,assetRestrictionState:state.voluntary.assetRestrictionState||'unknown',confirmedStatus:state.voluntary.targetStatus==='unknown'?undefined:state.voluntary.targetStatus,confirmedStatusPeriod:state.voluntary.targetStatusPeriod,periodFacts,history,exit:state.voluntary.exitDate?{effectiveFrom:state.voluntary.exitDate,filingStatus:state.voluntary.exitStatus||'unknown',filingDate:state.voluntary.exitFilingDate||''}:null};
    // Build forecast reference facts in order. An exempt year's receipts are
    // gross; a taxable year uses the taxable base. Unknown status supplies no
    // invented reference amount to later exemption decisions.
    for(let i=0;i<periods.length;i++){
      const route=ShohizeiTaxObligation.buildObligationProjection(input).periods[i];
      const forecast=projectionSnapshotFor(calc,periods[i],i);if(!forecast.sales||forecast.errors.length)continue;
      let turnover=null;
      if(route.obligation==='exempt')turnover=grossTurnover(forecast);
      else if(route.obligation==='taxable'&&['available','planned','unavailable'].includes(route.status)){
        if(i===0&&route.taxableWindow?.start>periods[i].start){
          const post=projectionSnapshotFor(calc,periods[i],i,route.taxableWindow);
          if(post.sales&&!post.errors.length)turnover=grossTurnover(forecast)-grossTurnover(post)+post.sales.totalTaxableBase;
        }else turnover=forecast.sales.totalTaxableBase;
      }
      if(Number.isFinite(turnover))history.push({...periods[i],taxableSales:turnover,entered:true,source:'forecast'});
    }
    const projection=ShohizeiTaxObligation.buildObligationProjection(input);
    projection.periods=projection.periods.map((p,index)=>{
      if(!p.taxableWindow&&p.obligation!=='taxable')return {...p,taxComparison:null,taxAssumption:p.obligation==='exempt'?'納税義務のない経路（方式の最適化とは別）':'義務又は開始期が未確定'};
      const window=p.taxableWindow||{start:p.start,end:p.end};
      const snapshot=projectionSnapshotFor(calc,p,index,window);
      let regular=snapshot.error||snapshot.errors?.length?null:snapshot.regular.amount;
      let simplified=snapshot.error||snapshot.errors?.length?null:snapshot.sales.simplified.amount;
      if(calc.ctx.taxScenario==='current' && !snapshot.error){
        try{
          const built=aggregateReturnRows(snapshot.rows,{knownNonTaxableZero:calc.ctx.nonTaxableSalesEntered&&calc.ctx.nonTaxableSales===0});
          built.input.periodStart=window.start;built.input.periodEnd=window.end;built.input.periodMonths=periodMonthsForAnnualization(window.start,window.end);
          if(built.reasons.length){regular=null;simplified=null;}
          else{
            const r=calculateCurrentLawReturn(built.input,calc.ctx.regularDetailMethod,currentReturnOptions());
            regular=r.referenceCalculable?r.mainReturn.totalBeforeInterim:null;
            const q=calculateCurrentLawSalesMethod(built.input,'simplified',Object.fromEntries(BUSINESS_TYPES.map(t=>[t.key,t.deemed])),currentReturnOptions());
            simplified=q.referenceCalculable?q.totalBeforeInterim:null;
          }
        }catch{regular=null;simplified=null;}
      }
      return {...p,taxComparison:{regular,simplified},taxAssumption:`${snapshot.allocation||snapshot.error||'対象取引額が未確認です。'} 方式の届出・資産制限、移行時棚卸・固定資産調整は別確認の概算です。`};
    });
    return projection;
  }
  function renderVoluntary(calc){
    const assessment=voluntaryAssessment(calc);
    const labels={available:'入力条件では選択可能',planned:'期限内提出を仮定した経路',unknown:'資料不足で可否未確認',unavailable:'選択不可'};
    const periodRows=assessment.periods.map(p=>[p.label||`${p.start}〜${p.end}`,labels[p.status]||'未確認',p.taxableWindow?`${p.taxableWindow.start}〜${p.taxableWindow.end}`:'課税対象取引なし又は未確定',p.bindingThrough||'未確認',p.taxComparison?.regular===null?'未算定':p.taxComparison?yen(p.taxComparison.regular):'—',p.taxComparison?.simplified===null?'未算定':p.taxComparison?yen(p.taxComparison.simplified):'—',[...(p.reasons||[]),p.taxAssumption].join(' / ')]);
    byId('voluntaryResult').innerHTML='<p class="notice warn">課税選択の拘束と簡易課税の継続制限は別です。還付額だけで有利とは判定しません。'+(state.voluntary.route==='invoice'?'登録日以後の取引だけが対象です。期中登録の取引額を特定できない場合、当期の全期間額を登録後の税額として使えません。':'課税選択は対象課税期間の初日からの取引を比較します。')+'</p><div class="table-wrap"><table><thead><tr>'+['期間','経路の可否','課税対象となる取引期間','拘束期間の終期','一般課税の概算','簡易課税の計算額（届出別判定）','不足理由・仮定'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+periodRows.map(r=>'<tr>'+r.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  }
  function sharedPriorEvidence(){
    const period=sharedCaseFacts.priorActual?.value?.period;
    const same=period&&period.start===state.prior.period?.start&&period.end===state.prior.period?.end;
    const legacyMethod=sharedCaseFacts.priorMethodPeriod?.start===period?.start&&sharedCaseFacts.priorMethodPeriod?.end===period?.end&&['special2','special3'].includes(byId('priorTaxMethod').value)?byId('priorTaxMethod').value:'';
    return ShohizeiPriorActualEvidence.fromSharedCsv({priorFacts:sharedCaseFacts.priorActual,csvSource:sharedCaseFacts.csvSource,currentSourceId:importedCsvOriginalSourceId,rows:taxEntryRows,monthlyGroups:importedCsvMonthlyGroups,actualOnePercentEntries:importedActualOnePercent?.entries||[],foodSalesConfirmed:byId('proposalFoodClassificationState').value,foodPurchasesConfirmed:byId('proposalPurchaseClassificationState').value,exactMethod:same?state.prior.exactMethod||legacyMethod:'',creditMethod:same?state.prior.creditMethod:undefined,adjustmentNational:same?number(state.prior.adjustmentNational):null,knownNonTaxableZero:rowCsvKnownZeros.nonTaxableSales===true,knownPurchaseZero:rowCsvKnownZeros.purchase10===true&&rowCsvKnownZeros.purchase8===true});
  }
  function priorActual(){
    const fact=sharedCaseFacts.priorActual;
    const p=state.prior;
    const shared=sharedPriorEvidence();
    if(shared.available&&!['foodSales','otherSales','foodPurchases','otherPurchases'].some(key=>String(p[key]??'').trim()!==''))return shared.priorActual;
    if(fact?.status!=='resolved'||!fact.value||JSON.stringify(fact.value.period)!==JSON.stringify(p.period))return {source:'unavailable'};
    const tx=[];
    for(const [field,side,rate,category] of [['foodSales','sales',8,'food'],['otherSales','sales',10,'other'],['foodPurchases','purchases',8,'food'],['otherPurchases','purchases',10,'other']]){
      const amount=number(p[field]);if((amount===null||!Number.isSafeInteger(amount)) && !(side==='purchases'&&p.exactMethod!=='regular'))return {source:'unavailable',period:p.period,reasons:[`前期${side==='sales'?'売上':'仕入'}の食品・その他内訳が未入力です。`,...shared.reasons]};
      if(amount===null&&side==='purchases')continue;
      if(category==='food'){
        if(!['8','1','mixed'].includes(p.foodRate))return {source:'unavailable'};
        const one=p.foodRate==='mixed'?number(side==='sales'?p.foodSalesOne:p.foodPurchasesOne):p.foodRate==='1'?amount:0;
        if(one===null||!Number.isSafeInteger(one)||one<0||one>amount)return {source:'unavailable'};
        tx.push({side,amount:one,originalRate:1,category,businessType:p.businessType,usage:'taxableOnly',creditRatio:1});
        tx.push({side,amount:amount-one,originalRate:8,category,businessType:p.businessType,usage:'taxableOnly',creditRatio:1});
      }else tx.push({side,amount,originalRate:rate,category,businessType:p.businessType,usage:'taxableOnly',creditRatio:1});
    }
    return {source:'actual',period:{...p.period},exactMethod:p.exactMethod,transactions:tx,nonTaxableSales:number(p.nonTaxableSales),creditMethod:p.creditMethod,adjustmentNational:number(p.adjustmentNational)};
  }
  function interimPlan(auto,calc,comparison){
    if(calc.ctx.taxScenario!=='foodProposal')return auto;
    const bothPolicy=auto.mode==='methodImpact';
    const annualTax=bothPolicy?{A:calc.methods.find(x=>x.key===byId('cashflowBaseMethod').value)?.amount??null,B:calc.methods.find(x=>x.key===byId('cashflowChangedMethod').value)?.amount??null}
      :{A:comparison?.rows?.find(x=>x.key===byId('cashflowMethod').value)?.currentAmount??null,B:comparison?.rows?.find(x=>x.key===byId('cashflowMethod').value)?.proposalAmount??null};
    const selection={A:bothPolicy&&state.prior.A==='special'?'special':'ordinary',B:state.prior.B==='special'?'special':'ordinary'};
    const actual=byId('cashflowAutoBasis').value==='actual';
    const prior=actual?priorActual():{source:'proxy',reasons:['STEP3代理額は実際の前期資料へ変換しません。実前期に切り替えてください。']};
    const result=ShohizeiFoodInterimComparison.compare({ordinaryInput:{...auto.options,priorNationalTax:auto.basis.national},priorActual:prior,annualTax,selection,manualPlanned:{A:false,B:false}});
    if(result.status==='unavailable'&&prior.reasons?.length)result.reasons=[...new Set([...prior.reasons,...result.reasons])];
    const same=!auto.separate&&!auto.separateUnconfirmed;
    const applied=Object.fromEntries(['A','B'].map(side=>[side,actual&&same&&result.special.status==='ready'&&result.selectedPlans[side]===result.special?'special':'ordinary']));
    if(!same&&Object.values(selection).includes('special'))result.selectionReasons.push('前期額を別々に仮定した案には食品特例の自動額を反映せず、通常納付を保持しています。');
    result.selection=selection;result.appliedSelection=applied;
    const label=side=>`${side}：${applied[side]==='special'?'食品特例を利用予定':'通常納付'}`;
    const extra={foodSpecial:result,interimSelection:applied,interimMethodLabel:Object.values(applied).includes('special')?`${label('A')}／${label('B')}（食品特例は政策試算）`:'通常の前期実績方式（A・Bとも通常納付）'};
    if(actual&&same){return {...auto,...extra,base:result.selectedPlans.A,changed:result.selectedPlans.B,ready:result.selectedPlans.A?.status==='ready'&&result.selectedPlans.B?.status==='ready'};}
    return {...auto,...extra};
  }
  function interimExport(auto){
    const c=auto?.foodSpecial;if(!c)return [];
    const label=value=>value==='special'?'食品特例':'通常納付';
    return [['食品中間特例の比較（利用予定とは別）','改正案の政策試算'],['中間納付の利用指定',`A：${label(c.selection?.A)}／B：${label(c.selection?.B)}`],['資金繰りへの反映',auto.interimMethodLabel],['中間特例の状態',c.status],...[...(c.reasons||[]),...(c.selectionReasons||[])].map(x=>['中間特例の不足・前提',x]),...(c.differences||[]).map(x=>['中間特例比較',x.sequence,x.dueDate,x.ordinary,x.special??'未算定',x.retained??'未算定']),['特例を使った場合に当期中に残る額（年税額差ではありません）',c.retainedDuringPeriod??'未算定']];
  }
  function interimHtml(auto){const rows=interimExport(auto);return rows.length?'<div class="notice warn"><strong>通常納付と食品特例の自動比較</strong>'+rows.map(r=>'<p>'+r.map(esc).join(' / ')+'</p>').join('')+'</div>':'';}
  function selectionEligibility(ctx,key,base){
    const result=ShohizeiTaxObligation.assessVoluntaryRoute({history:initialReferenceHistory(ctx),specifiedPayroll:ctx.specificPayrollEntered?ctx.specificPayrollAmount:undefined,entity:ctx.entity,period:{start:ctx.start,end:ctx.end},periods:ShohizeiTaxObligation.buildProjectionPeriods({entity:ctx.entity,start:ctx.start,end:ctx.end,scenario:ctx.taxScenario}),scenario:ctx.taxScenario,foodSalesState:taxEntryRows.sales.some(r=>Number(r.foodAmount)>0)?'yes':'unknown',...state.voluntary,assetRestrictionState:state.voluntary.assetRestrictionState||'unknown',confirmedStatus:state.voluntary.targetStatus==='unknown'?undefined:state.voluntary.targetStatus,confirmedStatusPeriod:state.voluntary.targetStatusPeriod});
    if((state.voluntary.route||'maintain')==='maintain')return {...base,eligibility:'unknown',reference:true,reasons:[...base.reasons,'課税を選択した場合の参考額です。免税維持は下の納税義務・経路で判定します。',...result.reasons]};
    return {...base,eligibility:result.status==='available'?base.eligibility:result.status==='unavailable'?'ineligible':'unknown',reference:true,reasons:[...base.reasons,'課税選択した場合の概算。開始期間・拘束・取消は免税経路欄で確認してください。',...result.reasons]};
  }
  function inputErrors(){return ShohizeiFourAmountEntry.editable(quickContext())&&taxEntryRows.sales.some(r=>r.source==='four-amount')?ShohizeiFourAmountEntry.build(state.quick,quickContext()).errors.map(e=>e.message):[];}
  function methodCalculationReasons(ctx){return ctx.currentReturnMethod==='exempt'&&state.voluntary.route==='invoice'&&state.voluntary.registrationDate&&state.voluntary.registrationDate>ctx.start?['期中登録は登録後の取引だけで計算します。免税経路欄の対象取引期間・概算を確認してください。']:[];}
  function assumptions(calc){
    const rows=[];
    if(taxEntryRows.sales.some(r=>r.source==='four-amount')) rows.push(['4金額入力の仮定',ShohizeiFourAmountEntry.presentation({industry:state.quick.industry,taxScenario:calc.ctx.taxScenario}).assumptions.join(' ')]);
    if(calc.ctx.taxScenario==='foodProposal')for(const e of estimates)rows.push(['食品対象期間額',`${e.kind==='sales'?'売上':'仕入'} ${typeof e.amount==='number'&&Number.isFinite(e.amount)?Math.round(e.amount)+'円':'未算定'}／${e.label}。${e.reason||''} ${(e.notes||[]).join(' ')}`]);
    if(calc.ctx.currentReturnMethod==='exempt')rows.push(['課税選択した場合の概算','方式別の金額は全期間を課税とした参考値。免税維持・登録経由の納税義務と対象取引期間は別に判定。']);
    return rows;
  }
  function monthlyAdapter(adapter,calc){
    const chosen=kind=>estimates.filter(e=>e.kind===kind);
    const sales=ShohizeiFoodPeriodEstimator.transactionDeltas({estimates:chosen('sales'),priceBasis:calc.ctx.foodSalesPriceBasis,annualDelta:adapter.annualSalesDelta});
    const purchases=ShohizeiFoodPeriodEstimator.transactionDeltas({estimates:chosen('purchases'),priceBasis:calc.ctx.foodPurchasePriceBasis,annualDelta:adapter.annualPurchaseDelta});
    const notes=[...adapter.distribution.notes];
    let result={...adapter,distribution:{...adapter.distribution,bySide:{...adapter.distribution.bySide}}};
    for(const [kind,part] of [['sales',sales],['purchases',purchases]]){
      if(part.ready){result[kind==='sales'?'salesDeltas':'purchaseDeltas']=part.monthly;result.distribution.bySide[kind]='shared-period';notes.push(...part.notes);}
      else notes.push(`${kind==='sales'?'売上':'仕入'}の対象期間額共用：${part.reason}`);
    }
    result.distribution.notes=[...new Set(notes)];
    return result;
  }
  function exportRows(calc){
    const rows=[];
    if(calc.ctx.taxScenario==='foodProposal'){
      for(const e of estimates)rows.push(['食品対象期間額',e.kind,e.amount??'未算定',e.label,e.reason||'']);
      if(byId('foodProjectionDetails')?.open||calc.ctx.viewMode==='projection'){
        const p=projectionPlan(calc);rows.push(['措置終了後まで比較','政策シナリオ'],...projectionRows(p));
        rows.push(['累計経路',p.optimized.ok?Math.round(p.optimized.cumulative):'未確定',p.optimized.reason||p.optimized.selectionStatus]);
      }
    }
    if(calc.ctx.currentReturnMethod==='exempt')for(const p of voluntaryAssessment(calc).periods)rows.push(['免税・課税選択の検討',`${p.start}〜${p.end}`,p.status,p.taxableWindow?`${p.taxableWindow.start}〜${p.taxableWindow.end}`:'未確定又は非課税期間',p.taxComparison?.regular??'未算定',p.taxComparison?.simplified??'未算定',p.bindingThrough||'',(p.reasons||[]).join(' / '),p.taxAssumption]);
    return rows;
  }
  function printHtml(calc){
    const rows=exportRows(calc);return rows.length?'<h2>追加検討・対象期間と前提</h2><table class="comparison-print-table"><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+esc(cell)+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'';
  }
  function restore(saved){state=saved?.version===1?{...initial(),...saved,quick:saved.quick||{},periods:saved.periods||{},prior:saved.prior||{},priorHistory:saved.priorHistory||{},voluntary:saved.voluntary||{route:'maintain'}}:initial();
    const fields={quickIndustry:state.quick.industry,quickFoodSales:state.quick.foodSales,quickOtherSales:state.quick.otherSales,quickFoodPurchases:state.quick.foodPurchases,quickOtherPurchases:state.quick.otherPurchases,voluntaryRegistrationStatus:state.voluntary.registrationStatus||'unknown',voluntaryTargetStatus:state.voluntary.targetStatus||'unknown',voluntaryExitStatus:state.voluntary.exitStatus||'unknown',voluntaryExitFilingDate:state.voluntary.exitFilingDate,voluntaryRoute:state.voluntary.route,voluntaryFiling:state.voluntary.filingStatus,voluntaryFilingDate:state.voluntary.filingDate,voluntaryRegistrationDate:state.voluntary.registrationDate,voluntaryAsset:state.voluntary.assetRestrictionState,voluntaryOther:state.voluntary.otherObligation,voluntaryExit:state.voluntary.exitDate,foodPriorMethod:state.prior.exactMethod,foodPriorBusiness:state.prior.businessType,foodPriorFoodRate:state.prior.foodRate,foodPriorSalesOne:state.prior.foodSalesOne,foodPriorPurchasesOne:state.prior.foodPurchasesOne,foodPriorSales:state.prior.foodSales,foodPriorOtherSales:state.prior.otherSales,foodPriorPurchases:state.prior.foodPurchases,foodPriorOtherPurchases:state.prior.otherPurchases,foodPriorNonTaxable:state.prior.nonTaxableSales,foodPriorAdjustment:state.prior.adjustmentNational,foodPriorCredit:state.prior.creditMethod,foodInterimA:state.prior.A||'ordinary',foodInterimB:state.prior.B||'ordinary'};
    for(const [id,v] of Object.entries(fields))if(byId(id))byId(id).value=v??'';
    if(byId('foodProjectionInputs'))byId('foodProjectionInputs').dataset.periods='';if(!saved)for(const d of document.querySelectorAll('.quick-details'))d.open=false;periodRollback=null;lastProjection=null;
  }
  root.ShohizeiContinuationUI={init,render,inputErrors,selectionEligibility,methodCalculationReasons,assumptions,monthlyAdapter,foodAmount,projectionPlan,interimPlan,interimHtml,interimExport,exportRows,printHtml,capturePeriod,rollbackPeriod,restore,periodAccepted:()=>{periodRollback=null;},snapshot:()=>JSON.parse(JSON.stringify(state)),reset:()=>restore(null),beginCalculation:()=>{estimates=[];}};
})(globalThis);
