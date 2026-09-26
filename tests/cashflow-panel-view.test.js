const test=require('node:test');
const assert=require('node:assert/strict');
const view=require('../cashflow-panel-view.js');

function monthRange(start,count){
  const [year,month]=start.split('-').map(Number);
  return Array.from({length:count},(_,index)=>{
    const date=new Date(Date.UTC(year,month-1+index,1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
  });
}
function sample(){
  const months=monthRange('2027-04',16),a=[],b=[];
  let aCum=0,bCum=0;
  for(let index=0;index<months.length;index++){
    const aFlow=index>=1&&index<=12?120000:0;
    const bFlow=index>=1&&index<=12?-60000:0;
    const aEvents=index===7?[{kind:'interim',amount:700000}]:index===13?[{kind:'final',amount:740000}]:[];
    const bEvents=index===7?[{kind:'interim',amount:700000}]:index===15?[{kind:'refund',amount:1420000}]:[];
    const aTotal=aFlow-aEvents.reduce((sum,item)=>sum+item.amount,0);
    const bTotal=bFlow-bEvents.filter(item=>item.kind!=='refund').reduce((sum,item)=>sum+item.amount,0)+bEvents.filter(item=>item.kind==='refund').reduce((sum,item)=>sum+item.amount,0);
    aCum+=aTotal;bCum+=bTotal;
    a.push({month:months[index],flow:aFlow,events:aEvents,monthTotal:aTotal,cumulative:aCum});
    b.push({month:months[index],flow:bFlow,events:bEvents,monthTotal:bTotal,cumulative:bCum});
  }
  return {months,unitLabel:'千円',priceBasis:'taxExclusiveFixed',cases:{A:{label:'A案（食品8％維持）',rows:a},B:{label:'B案（食品1％）',rows:b}},status:{mode:'rateImpact',interim:'auto',finalMonthEntered:true,refundMonthEntered:true,notes:[]},expectedDiff:months.map((month,index)=>({month,monthTotal:b[index].monthTotal-a[index].monthTotal,cumulative:b[index].cumulative-a[index].cumulative}))};
}
function withoutEvents(data){
  for(const key of ['A','B']){
    let cumulative=0;
    for(const row of data.cases[key].rows){
      row.events=[];row.monthTotal=row.flow;cumulative+=row.flow;row.cumulative=cumulative;
    }
  }
  data.expectedDiff=data.months.map((month,index)=>({month,monthTotal:data.cases.B.rows[index].monthTotal-data.cases.A.rows[index].monthTotal,cumulative:data.cases.B.rows[index].cumulative-data.cases.A.rows[index].cumulative}));
  return data;
}
function refresh(data){
  for(const key of ['A','B']){
    let cumulative=0;
    for(const row of data.cases[key].rows){
      row.monthTotal=row.flow+row.events.reduce((sum,event)=>sum+(event.kind==='refund'?event.amount:-event.amount),0);
      cumulative+=row.monthTotal;row.cumulative=cumulative;
    }
  }
  data.expectedDiff=data.months.map((month,index)=>({month,
    monthTotal:data.cases.B.rows[index].monthTotal-data.cases.A.rows[index].monthTotal,
    cumulative:data.cases.B.rows[index].cumulative-data.cases.A.rows[index].cumulative}));
  return data;
}

test('基本サンプルはB−A差額を既存STEP4と照合し、最大差が2028年4月・2,160千円',()=>{
  const data=sample(),model=view.buildViewModel(data);
  assert.equal(model.error,'');
  assert.equal(model.maxIndex,12);
  assert.equal(model.maxAbs,2160000);
  assert.equal(model.diffCum[15],0);
  const html=view.renderCashflowPanelHtml(data,{width:900,measureText:text=>text.length*6});
  assert.match(html,/最大差 2,160/);
  assert.match(html,/28\/4<small>最大差<\/small>/);
  assert.match(html,/B 還付 1,420/);
  const zeroY=Number(html.match(/class="cf-zero-line"[^>]*y1="([^"]+)"/)[1]);
  const refundLabelY=Number(html.match(/<text class="cf-event-label" x="[^"]+" y="([^"]+)" fill="#eb6834">B 還付 1,420<\/text>/)[1]);
  assert.ok(refundLabelY-11>zeroY+2||refundLabelY+3<zeroY-2,'還付ラベルはA案の0線と交差しない');
  assert.match(html,/cf-diff-negative cf-level-3/);
  assert.match(html,/cf-between" fill-rule="nonzero"/);
  assert.match(html,/aria-label="B案（食品1％）の手元資金はA案（食品8％維持）より最大2,160千円少なく/);
  assert.match(html,/class="cf-table-wrap"><table class="cf-table"/);
});

test('階段線、マーカー、表の月列は同じCW中心を使う',()=>{
  const html=view.renderCashflowPanelHtml(sample(),{width:900,measureText:text=>text.length*6});
  const cw=Number(html.match(/--cf-cw:(\d+)px/)[1]);
  const expectedX=(7+.5)*cw;
  assert.match(html,new RegExp(`H ${expectedX} V`));
  assert.match(html,new RegExp(`points="${expectedX},`));
  assert.match(html,/data-month-index="7"/);
  assert.match(html,new RegExp(`<col style="width:${cw}px">`));
});

test('不整合・照合欠落・不正金額は0へ補完せずグラフを停止する',()=>{
  const data=sample();data.expectedDiff[2].cumulative+=2;
  const html=view.renderCashflowPanelHtml(data,{logErrors:false});
  assert.match(html,/内部整合エラー/);
  assert.doesNotMatch(html,/class="cf-plot"/);
  const missing=sample();delete missing.expectedDiff;
  assert.match(view.renderCashflowPanelHtml(missing,{logErrors:false}),/照合値がありません/);
  const invalid=sample();invalid.cases.A.rows[0].flow=undefined;
  assert.match(view.renderCashflowPanelHtml(invalid,{logErrors:false}),/未算定/);
  const contradicted=sample();contradicted.status.interim='unconfirmed';
  assert.match(view.renderCashflowPanelHtml(contradicted,{logErrors:false}),/未確認状態と納付・還付額が一致しません/);
  const unavailable=sample();unavailable.status={renderable:false,integrity:'unavailable',reason:'中間納付を確認してください。',notes:[]};
  const unavailableHtml=view.renderCashflowPanelHtml(unavailable,{logErrors:false});
  assert.match(unavailableHtml,/未算定：中間納付を確認してください/);
  assert.doesNotMatch(unavailableHtml,/内部整合エラー/);
});

test('未確認・予定月なし・税込価格据置の注意は重複せずHTMLエスケープする',()=>{
  const data=withoutEvents(sample());data.status={mode:'rateImpact',interim:'unconfirmed',finalMonthEntered:false,refundMonthEntered:false,interimWasEdited:true,sourceNote:'A案は参考配分です。',notes:['<要確認>','<要確認>','A案は参考配分です。']};data.priceBasis='mixed';
  const html=view.renderCashflowPanelHtml(data);
  assert.match(html,/中間納付は未確認/);
  assert.match(html,/確定納付の予定月が未入力/);
  assert.match(html,/還付の入金予定月が未入力/);
  assert.match(html,/税込価格据置の前提/);
  assert.match(html,/中間納付予定は手修正後/);
  assert.equal((html.match(/A案は参考配分です。/g)||[]).length,1);
  assert.equal((html.match(/&lt;要確認&gt;/g)||[]).length,1);
  assert.doesNotMatch(html,/<要確認>/);
});

test('方式比較ではmixed前提だけで食品価格の警告を出さない',()=>{
  const data=sample();data.priceBasis='mixed';data.status.mode='methodImpact';
  assert.doesNotMatch(view.renderCashflowPanelHtml(data),/税込価格据置の前提/);
});

test('片案の予定月だけ未確認でも、もう一方の確認済みイベントは保持する',()=>{
  const data=sample();data.status.finalMonthEntered=false;
  const html=view.renderCashflowPanelHtml(data,{logErrors:false});
  assert.match(html,/確定納付の予定月が未入力/);
  assert.match(html,/A 確定 740/);
  assert.doesNotMatch(html,/内部整合エラー/);
});

test('20か月は画面で横スクロールし、印刷で同じ縦軸の2段になる',()=>{
  const data=sample(),extra=monthRange('2028-08',4);
  for(const month of extra){data.months.push(month);for(const key of ['A','B'])data.cases[key].rows.push({month,flow:0,events:[],monthTotal:0,cumulative:0});data.expectedDiff.push({month,monthTotal:0,cumulative:0});}
  const screen=view.renderCashflowPanelHtml(data,{width:375});
  assert.equal((screen.match(/class="cf-inner cf-segment"/g)||[]).length,1);
  assert.match(screen,/class="cf-scroll"/);
  assert.match(view.styles,/position:sticky;left:0/);
  const print=view.renderCashflowPanelHtml(data,{print:true,width:680});
  assert.equal((print.match(/class="cf-inner cf-segment"/g)||[]).length,2);
  assert.equal((print.match(/cf-zero-line/g)||[]).length,2);
  assert.match(print,/前半/);assert.match(print,/後半/);
});

test('A案の中間納付が11回ならマーカーを残し金額ラベルのみ省略する',()=>{
  const data=withoutEvents(sample());
  for(let index=0;index<11;index++)data.cases.A.rows[index].events=[{kind:'interim',amount:1000}];
  const html=view.renderCashflowPanelHtml(refresh(data),{width:900});
  assert.equal((html.match(/class="cf-marker cf-marker-A"/g)||[]).length,11);
  assert.doesNotMatch(html,/A 中間 1/);
  assert.match(html,/cf-payment/);
});

test('両案の中間納付月が異なる場合も案別の月へ配置する',()=>{
  const data=withoutEvents(sample());
  data.cases.A.rows[2].events=[{kind:'interim',amount:700000}];
  data.cases.B.rows[3].events=[{kind:'interim',amount:700000}];
  const html=view.renderCashflowPanelHtml(refresh(data),{width:900});
  assert.match(html,/A 中間 700/);
  assert.match(html,/B 中間 700/);
  assert.equal((html.match(/class="cf-marker cf-marker-A"/g)||[]).length,1);
  assert.equal((html.match(/class="cf-marker cf-marker-B"/g)||[]).length,1);
});

test('累積が交差する月でも塗りはnonzeroの単一パスで欠けない',()=>{
  const data=withoutEvents(sample());
  for(const key of ['A','B'])for(const row of data.cases[key].rows)row.flow=0;
  data.cases.A.rows[0].flow=100000;
  data.cases.B.rows[1].flow=200000;
  const html=view.renderCashflowPanelHtml(refresh(data),{width:900});
  assert.ok(data.expectedDiff[0].cumulative<0&&data.expectedDiff[1].cumulative>0);
  assert.match(html,/class="cf-between" fill-rule="nonzero" d="M [^";]+ Z"/);
});

test('実測文字幅で14か月が印刷幅を超す場合は2段へ分割する',()=>{
  const data=sample();data.months=data.months.slice(0,14);
  for(const key of ['A','B'])data.cases[key].rows=data.cases[key].rows.slice(0,14);
  data.expectedDiff=data.expectedDiff.slice(0,14);
  const html=view.renderCashflowPanelHtml(data,{print:true,width:680,measureText:()=>52});
  assert.equal((html.match(/class="cf-inner cf-segment"/g)||[]).length,2);
});

test('短期6か月・ゼロ差額でも96px上限と0円表示を維持する',()=>{
  const data=sample(),count=6;
  data.months=data.months.slice(0,count);
  for(const key of ['A','B'])data.cases[key].rows=data.cases[key].rows.slice(0,count);
  data.expectedDiff=data.expectedDiff.slice(0,count);
  const html=view.renderCashflowPanelHtml(data,{width:1200});
  assert.match(html,/--cf-cw:96px/);
  assert.match(html,/区分（千円）/);
  assert.match(html,/>0<\/td>/);
});

test('両案が全月0円でもゼロ線と5本の目盛を表示する',()=>{
  const data=withoutEvents(sample());
  for(const key of ['A','B'])for(const row of data.cases[key].rows){row.flow=0;row.monthTotal=0;row.cumulative=0;}
  data.expectedDiff=data.months.map(month=>({month,monthTotal:0,cumulative:0}));
  const html=view.renderCashflowPanelHtml(data);
  assert.equal((html.match(/class="cf-tick-line"|class="cf-zero-line"/g)||[]).length,5);
  assert.match(html,/cf-zero-line/);
  assert.doesNotMatch(html,/cf-max-line/);
});

test('案名・注記はエスケープし、入力は変えない',()=>{
  const data=sample(),before=JSON.stringify(data);
  data.cases.A.label='A案 <試算>';
  const expected=JSON.stringify(data);
  const html=view.renderCashflowPanelHtml(data);
  assert.match(html,/A案 &lt;試算&gt;/);
  assert.equal(JSON.stringify(data),expected);
  assert.notEqual(before,expected);
});
