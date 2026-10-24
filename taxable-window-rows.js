(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.ShohizeiTaxableWindowRows=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const USE={'5':'taxableOnly','6':'nonTaxableOnly','7':'common','52':'taxableOnly','62':'nonTaxableOnly','72':'common'};
  const EXEMPT=new Set(['52','62','72']);
  const POLICY={start:'2027-04-01',end:'2029-03-31'};
  const text=v=>String(v??'').trim();
  const value=v=>text(v)===''?null:Number(text(v).replace(/,/g,''));
  const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-7+Math.max(Math.abs(a),Math.abs(b))*Number.EPSILON*16;
  function date(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(text(v)))return false;const d=new Date(v+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===v;}
  function period(p){return date(p?.start)&&date(p?.end)&&p.start<=p.end;}
  const same=(a,b)=>a?.start===b?.start&&a?.end===b?.end;
  const inside=(v,p)=>v>=p.start&&v<=p.end;
  function monthEnd(month){return new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);}
  function ratio(v){const n=value(v);return n===null?'':String(n<=1&&n!==0?n*100:n);}
  function key(kind,row){const code=text(row.code??row.taxCode),rate=code==='3'?'':text(row.rate??row.ratePercent);
    return JSON.stringify([kind,code,rate,kind==='sales'?text(row.businessType):'',kind==='purchases'?USE[code]||text(row.usage):'',EXEMPT.has(code)?ratio(row.creditRatio):'']);}
  function actualKey(e){return key(e.kind==='sale'?'sales':'purchases',{...e,code:e.taxCode|| (e.kind==='sale'?'1':e.kind==='exemptPurchase'?{'taxableOnly':'52','nonTaxableOnly':'62','common':'72'}[e.usage||'taxableOnly']:{'taxableOnly':'5','nonTaxableOnly':'6','common':'7'}[e.usage||'taxableOnly']),rate:'1'});}
  function signed(kind,row,n){return kind==='sales'&&text(row.code)==='11'?-n:n;}
  function add(map,k,n){map.set(k,(map.get(k)||0)+n);}
  function failure(reason){return {ready:false,rows:null,actualOnePercentEntries:[],method:'unavailable',label:'対象取引額未確認',reason,notes:[],foodPeriodAmountsById:{}};}
  function slice(input={}){
    const p=input.period,w=input.window;
    if(!period(p)||!period(w)||w.start<p.start||w.end>p.end)return failure('登録後の取引期間と対象課税期間を確認してください。');
    const source=input.csvSource?.status==='resolved'?input.csvSource.value:null;
    if(!source||source.periodConfirmed!==true||source.fullMonthCoverageConfirmed!==true)return failure('元CSVの正式期間・全月網羅が未確認です。');
    if(!source.sourceId||source.sourceId!==input.currentSourceId)return failure('現在のCSVと共有された元資料の同一性を確認できません。');
    if(!same(source.period,p))return failure('正式CSV期間と当該課税期間が一致しません。前年の構成を登録後の実額にはしません。');
    if(Number(input.dateUnknownCount||0)>0)return failure('CSVに取引日不明の明細があり、登録日前後を区分できません。');
    if((input.currentAggregateId||input.monthlyAggregateId)&&input.currentAggregateId!==input.monthlyAggregateId)return failure('補正後の現在行とCSV日付集計版が一致しません。');
    const daily=Array.isArray(input.dailyGroups)&&input.dailyGroups.length>0;
    const groups=daily?input.dailyGroups:input.monthlyGroups;
    if(!Array.isArray(groups)||!groups.length)return failure('CSVの日別・月別内訳がありません。');
    if(!daily){
      const startFull=w.start===p.start||w.start.endsWith('-01');
      const endFull=w.end===p.end||w.end===monthEnd(w.end.slice(0,7));
      if(!startFull||!endFull)return failure('月途中の登録境界には日別実額が必要です。旧保存の月額だけから正確な日次額を作りません。');
    }
    const totals=new Map(),selected=new Map(),policySelected=new Map(),adjusted=new Set();
    for(const g of groups){
      const kind=text(g.kind),code=text(g.code),rate=text(g.rate),n=value(g.amount);
      if(!['sales','purchases'].includes(kind)||!Number.isFinite(n)||!Number.isSafeInteger(n)
        ||!(kind==='sales'?['1','11','3'].includes(code):Object.hasOwn(USE,code))
        ||code!=='3'&&!['1','8','10'].includes(rate))return failure('日付別CSVに未対応の課税区分・税率・金額があります。');
      let selectedHere=false,policyHere=false;
      if(daily){
        if(!date(g.date)||!inside(g.date,p))return failure('日付別CSVの取引日が不明又は正式期間の範囲外です。');
        selectedHere=inside(g.date,w);policyHere=selectedHere&&inside(g.date,POLICY);
      }else{
        if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(text(g.month))||g.month<p.start.slice(0,7)||g.month>p.end.slice(0,7))return failure('月別CSVの日付が不明又は正式期間の範囲外です。');
        selectedHere=g.month>=w.start.slice(0,7)&&g.month<=w.end.slice(0,7);
        policyHere=selectedHere&&g.month>=POLICY.start.slice(0,7)&&g.month<=POLICY.end.slice(0,7);
      }
      const k=key(kind,g);add(totals,k,n);if(selectedHere)add(selected,k,n);if(policyHere)add(policySelected,k,n);
      if(g.transactionKind==='adjustment'&&code!=='11')adjusted.add(k);
    }
    const current=new Map(),rowsByKey=new Map();
    for(const kind of ['sales','purchases'])for(const [index,row]of(input.rows?.[kind]||[]).entries()){
      if(!text(row.code)&&!text(row.amount)&&!text(row.foodAmount))continue;
      if(!['csv','csv-edited'].includes(row.source))return failure('現在行に手入力が含まれるため、対象取引の実額CSVとして転用しません。');
      const n=value(row.amount),code=text(row.code);
      if(!Number.isFinite(n)||!Number.isSafeInteger(n)||!(kind==='sales'?['1','11','3'].includes(code):Object.hasOwn(USE,code)))return failure('現在行の金額・輸入等の区分は日付別CSVへ対応できません。');
      const k=key(kind,row);add(current,k,signed(kind,row,n));const list=rowsByKey.get(k)||[];list.push({kind,row,index});rowsByKey.set(k,list);
    }
    const actuals=input.actualOnePercentEntries||[];
    for(const e of actuals){const n=value(e.amount);if(!Number.isSafeInteger(n)||!date(e.date)||!inside(e.date,p))return failure('明示1％実績の日付・金額が正式期間へ対応しません。');add(current,actualKey(e),n);}
    for(const k of new Set([...totals.keys(),...current.keys()]))if(!near(totals.get(k)||0,current.get(k)||0))return failure('現在の入力行・明示1％実績とCSV日付別総額が一致しません。手修正又は異なる集計を確認してください。');
    // A zero annual purchase bucket can still contain post-registration
    // movements. Reconstruct its known classification from anonymous dates;
    // missing actual-1% sidecars, however, cannot become confirmed actuals.
    for(const [k,total]of totals){
      if(current.has(k)||rowsByKey.has(k))continue;
      const g=groups.find(item=>key(item.kind,item)===k);
      if(text(g.rate)==='1')return failure('明示1％の元実績行がなく、日付別取引を安全に照合できません。');
      if(!near(total,0))continue;
      rowsByKey.set(k,[{kind:g.kind,row:{id:`window-zero-${rowsByKey.size}`,source:'csv',code:text(g.code),rate:text(g.rate),businessType:text(g.businessType),creditRatio:text(g.creditRatio),amount:'0',foodAmount:''},index:rowsByKey.size}]);
    }
    const output={sales:[],purchases:[]},foodPeriodAmountsById={},notes=[];
    for(const [k,list]of rowsByKey){
      const first=list[0],kind=first.kind,code=text(first.row.code),rate=text(first.row.rate),gross=totals.get(k)||0;
      const picked=selected.get(k)||0,policy=policySelected.get(k)||0;
      const base=code==='11'?-gross:gross,part=code==='11'?-picked:picked;
      // A return entirely before registration cannot require evidence for a
      // zero post-registration return credit. Keep annual source matching above.
      if(code==='11'&&part===0)continue;
      if(rate==='8'&&list.some(({row})=>{const f=value(row.foodAmount),n=value(row.amount);return text(row.foodAmount)!==''&&(!Number.isFinite(f)||Math.abs(f)>Math.abs(n)+1e-7||f!==0&&Math.sign(f)!==Math.sign(n));}))return failure('食品内数・符号が不正です。未確認・不正額を0円へ置き換えません。');
      const food=list.reduce((sum,{row})=>sum+(value(row.foodAmount)||0),0);
      const missingFood=list.some(({row})=>text(row.foodAmount)==='');
      if(rate==='8'&&code!=='11'&&food!==0&&adjusted.has(k))return failure('食品を含む通常取引と調整の元内訳を、日付別の食品額へ対応できません。');
      if(rate==='8'&&food!==0&&(!near(base,0)&&Math.abs(food)>Math.abs(base)+1e-7||near(base,0)))return failure('食品内数の比率を日付別の金額へ対応できません。');
      const fraction=rate==='8'&&!missingFood&&base!==0?food/base:0;
      const id=first.row.id||`window-${kind}-${first.index}`;
      const next={...first.row,id,amount:String(part),source:'csv-window'};
      if(rate==='8'){
        next.foodAmount=missingFood?'':String(code==='11'?part*fraction:part*fraction);
        next.foodAmountSource='manual';
        foodPeriodAmountsById[id]=code==='11'?0:policy*fraction;
        if(!missingFood&&food!==0&&!near(fraction,1))notes.push('食品内数は課税区分グループの日別・月別構成と同じと仮定した代理額です。食品の日次実額ではありません。');
      }
      output[kind].push(next);
    }
    const pickedActuals=actuals.filter(e=>inside(e.date,w)).map(e=>({...e}));
    // Anonymous signed date aggregates are evidence only; the returned 1%
    // entries stay in their sidecar and never become duplicate ordinary rows.
    return {ready:true,rows:output,actualOnePercentEntries:pickedActuals,method:daily?'csv-daily':'csv-monthly',
      label:daily?'登録後のCSV日別実額を集計':'登録後のCSV月別実額を集計',reason:'',notes:[...new Set(notes)],foodPeriodAmountsById,
      window:{...w},source:{id:source.sourceId,period:{...p}},knownZeros:{...(input.knownZeros||{})}};
  }
  return Object.freeze({slice});
});
