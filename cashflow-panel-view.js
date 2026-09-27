(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ShohizeiCashflowPanelView=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const LW=160;
  const labelWidth=options=>!options.print && Number(options.width)>0 && Number(options.width)<=390 ? 140 : LW;
  const COLORS={A:'#2a78d6',B:'#eb6834'};
  const NOTICE={
    interim:'中間納付は未確認のため、グラフと表に反映していません。',
    final:'確定納付の予定月が未入力のため、グラフと表に反映していません。',
    refund:'還付の入金予定月が未入力のため、グラフと表に反映していません。',
    price:'税込価格据置の前提のため、B案の線には価格前提による本体（税抜）部分の差を含みます。',
    manual:'中間納付予定は手修正後の値です。'
  };
  const instances=new WeakMap();
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const isAmount=value=>Number.isSafeInteger(value);
  const roundThousand=value=>Math.round(Math.abs(value)/1000);
  const fmt=value=>`${value<0?'▲':''}${roundThousand(value).toLocaleString('ja-JP')}`;
  const fmtPositive=value=>roundThousand(value).toLocaleString('ja-JP');
  const monthLabel=month=>{const [year,part]=String(month).split('-');return `${year.slice(-2)}/${Number(part)}`;};
  const nextYear=(months,index)=>index>0&&String(months[index-1]).slice(0,4)!==String(months[index]).slice(0,4);
  const sumKind=(row,kind)=>row.events.filter(event=>event.kind===kind).reduce((total,event)=>total+event.amount,0);
  const sumPayments=row=>sumKind(row,'interim')+sumKind(row,'final');
  const usedKinds=row=>['interim','final'].filter(kind=>sumKind(row,kind)>0).map(kind=>kind==='interim'?'中間':'確定').join('・');
  const validMonth=value=>/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value));
  const nextMonth=value=>{const [year,month]=value.split('-').map(Number);return `${year+Number(month===12)}-${String(month===12?1:month+1).padStart(2,'0')}`;};

  function notices(data){
    const status=data.status||{};
    const values=[];
    if(status.interim==='unconfirmed')values.push(NOTICE.interim);
    if(status.finalMonthEntered===false)values.push(NOTICE.final);
    if(status.refundMonthEntered===false)values.push(NOTICE.refund);
    if(status.mode==='rateImpact'&&(data.priceBasis==='taxInclusiveFixed'||data.priceBasis==='mixed'))values.push(NOTICE.price);
    if(status.interimWasEdited===true)values.push(NOTICE.manual);
    if(typeof status.sourceNote==='string'&&status.sourceNote.trim())values.push(status.sourceNote);
    if(Array.isArray(status.notes))values.push(...status.notes.filter(note=>typeof note==='string'&&note.trim()));
    return [...new Set(values)];
  }

  function validate(data){
    if(!data||!Array.isArray(data.months)||!data.months.length)return '表示する月がありません。';
    if(data.unitLabel!=='千円')return '表示単位を確認できません。';
    const months=data.months;
    if(months.some((month,index)=>!validMonth(month)||(index>0&&month!==nextMonth(months[index-1]))))return '月の並びが連続していません。';
    if(data.baseSource){
      const source=data.baseSource;
      if(!['reference','manual','csv'].includes(source.kind)||typeof source.label!=='string'||!source.label.trim()
        ||!Array.isArray(source.months)||source.months.length!==months.length
        ||source.months.some((row,index)=>row?.month!==months[index]||!isAmount(row.base)))
        return '共通ベースの月別金額または出典を確認できません。';
      if(source.commonDelta && (typeof source.commonDelta!=='object'||Array.isArray(source.commonDelta)
        ||Object.entries(source.commonDelta).some(([month,value])=>!months.includes(month)||!isAmount(value))))
        return '共通ベースの取引差内訳を確認できません。';
    }
    for(const key of ['A','B']){
      const entry=data.cases?.[key];
      if(!entry||!Array.isArray(entry.rows)||entry.rows.length!==months.length)return `${key}案の月別データが不足しています。`;
      for(let index=0;index<months.length;index++){
        const row=entry.rows[index];
        if(!row||row.month!==months[index]||!['flow','monthTotal','cumulative'].every(field=>isAmount(row[field]))||!Array.isArray(row.events))return `${key}案 ${months[index]} の金額が未算定です。`;
        if(row.events.some(event=>!event||!['interim','final','refund'].includes(event.kind)||!isAmount(event.amount)||event.amount<0))return `${key}案 ${months[index]} の納付・還付額が未算定です。`;
        // 確定・還付の月は案別に一部確認済みの場合があるため、集約した false だけで既知イベントを消さない。
        if(data.status?.interim==='unconfirmed'&&row.events.some(event=>event.kind==='interim'&&event.amount>0))
          return `${key}案 ${months[index]} の未確認状態と納付・還付額が一致しません。`;
      }
    }
    if(!Array.isArray(data.expectedDiff)||data.expectedDiff.length!==months.length)return '既存STEP4との照合値がありません。';
    for(let index=0;index<months.length;index++){
      const expected=data.expectedDiff[index];
      if(!expected||expected.month!==months[index]||!isAmount(expected.cumulative))return `${months[index]} の既存STEP4照合値がありません。`;
    }
    return '';
  }

  function buildViewModel(data){
    if(data?.status?.renderable===false&&data.status.integrity==='unavailable'){
      return {error:'',unavailable:data.status.reason||'必要な前提を確認してください。',notices:notices(data),diffMonth:[],diffCum:[]};
    }
    if(data?.status?.renderable===false&&data.status.integrity==='mismatch'){
      return {error:data.status.reason||'既存STEP4の累積資金差額と一致しません。',notices:notices(data),diffMonth:[],diffCum:[]};
    }
    const error=validate(data);
    if(error)return {error,notices:notices(data||{}),diffMonth:[],diffCum:[]};
    const diffMonth=[],diffCum=[];
    for(let index=0;index<data.months.length;index++){
      const a=data.cases.A.rows[index],b=data.cases.B.rows[index];
      diffMonth.push(b.monthTotal-a.monthTotal);
      diffCum.push(b.cumulative-a.cumulative);
      if(Math.abs(diffCum[index]-data.expectedDiff[index].cumulative)>(data.actualCash||data.baseSource?0:1)
        || (data.actualCash||data.baseSource) && diffMonth[index]!==data.expectedDiff[index].monthTotal){
        return {error:`${data.months[index]} の累積資金差額が既存STEP4と一致しません。`,notices:notices(data),diffMonth,diffCum};
      }
    }
    let maxIndex=-1,maxAbs=0;
    diffCum.forEach((amount,index)=>{if(Math.abs(amount)>maxAbs){maxAbs=Math.abs(amount);maxIndex=index;}});
    return {error:'',notices:notices(data),diffMonth,diffCum,maxIndex,maxAbs};
  }

  function measureWidth(value,options={}){
    if(typeof options.measureText==='function')return options.measureText(String(value));
    if(typeof document!=='undefined'){
      const canvas=document.createElement('canvas');
      const ctx=canvas.getContext&&canvas.getContext('2d');
      if(ctx){ctx.font=options.print?'10px sans-serif':'11px sans-serif';return ctx.measureText(String(value)).width;}
    }
    return String(value).length*(options.print?6:6.5);
  }
  function minColumnWidth(data,model,options){
    const values=[...data.months.map(monthLabel),'最大差'];
    for(const key of ['A','B'])for(const row of data.cases[key].rows)values.push(fmt(row.flow),fmt(row.monthTotal),fmt(row.cumulative),fmtPositive(sumPayments(row)),fmtPositive(sumKind(row,'refund')));
    if(data.baseSource)values.push(...data.baseSource.months.map(row=>fmt(row.base)));
    values.push(...model.diffMonth.map(fmt),...model.diffCum.map(fmt));
    return Math.max(options.print?36:44,Math.ceil(Math.max(...values.map(value=>measureWidth(value,options)))+8));
  }
  function grid(data,model,options){
    const left=labelWidth(options);
    const width=Math.max(left+36,Number(options.width)||680);
    const minCW=minColumnWidth(data,model,options);
    const available=Math.floor((width-left)/data.months.length);
    const printSplit=Boolean(options.print&&(available<36||minCW>available)&&data.months.length>1);
    const slices=[];
    if(printSplit){
      const pivot=Math.ceil(data.months.length/2);
      slices.push([0,pivot],[pivot,data.months.length]);
    }else slices.push([0,data.months.length]);
    return {LW:left,minCW,printSplit,slices:slices.map(([start,end])=>{
      const count=end-start;
      const CW=Math.max(minCW,Math.min(96,Math.floor((width-left)/count)));
      return {start,end,count,CW,LW:left,width:left+count*CW,plotWidth:count*CW};
    })};
  }
  function niceStep(raw){
    if(raw<=0)return 1;
    const power=10**Math.floor(Math.log10(raw)),scaled=raw/power;
    return (scaled<=1?1:scaled<=2?2:scaled<=5?5:10)*power;
  }
  function axis(data,options={}){
    const values=[0,...data.cases.A.rows.map(row=>row.cumulative),...data.cases.B.rows.map(row=>row.cumulative)];
    const low=Math.min(...values),high=Math.max(...values),span=Math.max(1,high-low);
    const margin=Math.max(1,span*.1);
    let step=niceStep((span+2*margin)/4.5);
    let min=Math.floor((low-margin)/step)*step,max=Math.ceil((high+margin)/step)*step;
    if(low===0&&high===0){step=1000;min=-2000;max=2000;}
    while((max-min)/step>6)step=niceStep(step*1.01),min=Math.floor((low-margin)/step)*step,max=Math.ceil((high+margin)/step)*step;
    const height=options.print?220:280,top=24,bottom=height-24;
    const y=value=>top+(max-value)/(max-min)*(bottom-top);
    const ticks=[];
    for(let value=min;value<=max+step/2;value+=step)ticks.push(Math.round(value));
    return {min,max,step,height,top,bottom,y,ticks};
  }
  function linePath(rows,slice,CW,y){
    let path='';
    for(let local=0;local<slice.count;local++){
      const x=(local+.5)*CW,point=y(rows[slice.start+local].cumulative);
      path+=local?` H ${x} V ${point}`:`M ${x} ${point}`;
    }
    return path;
  }
  function fillPath(aRows,bRows,slice,CW,y){
    let path=linePath(aRows,slice,CW,y);
    const last=slice.count-1;
    path+=` L ${(last+.5)*CW} ${y(bRows[slice.start+last].cumulative)}`;
    for(let local=last;local>=1;local--)
      path+=` V ${y(bRows[slice.start+local-1].cumulative)} H ${(local-.5)*CW}`;
    return path+' Z';
  }
  const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  function labelPlacement(text,x,y,plotWidth,height,occupied,measure){
    const width=measure(text)+4,places=[[-width-10,4],[-width-10,20],[-width-10,-12],[8,-10],[8,20]];
    for(const [dx,dy] of places){
      const rect={left:x+dx,right:x+dx+width,top:y+dy-11,bottom:y+dy+3};
      if(rect.left>=1&&rect.right<=plotWidth-1&&rect.top>=1&&rect.bottom<=height-1&&!occupied.some(other=>overlaps(rect,other))){occupied.push(rect);return {x:rect.left,y:y+dy,rect,fallback:false};}
    }
    const rect={left:Math.max(1,Math.min(plotWidth-width-1,x-width-10)),right:0,top:Math.max(1,Math.min(height-15,y-7)),bottom:0};
    rect.right=rect.left+width;rect.bottom=rect.top+14;occupied.push(rect);
    return {x:rect.left,y:rect.top+11,rect,fallback:true};
  }
  function eventSvg(data,slice,ax,options,occupied){
    const out=[];
    const labelAllowed=Object.fromEntries(['A','B'].map(key=>[key,data.cases[key].rows.flatMap(row=>row.events.filter(event=>event.amount>0)).length<4]));
    for(let local=0;local<slice.count;local++){
      const index=slice.start+local;
      const aRow=data.cases.A.rows[index],bRow=data.cases.B.rows[index];
      const common=[];
      const unusedB=bRow.events.filter(event=>event.amount>0).map((event,position)=>({event,position}));
      for(const event of aRow.events.filter(item=>item.amount>0)){
        const match=unusedB.findIndex(item=>item.event.kind===event.kind && item.event.amount===event.amount);
        if(match>=0 && event.kind==='interim' && aRow.cumulative===bRow.cumulative){
          common.push(event);unusedB.splice(match,1);
        }
      }
      for(const event of common){
        const x=(local+.5)*slice.CW,y=ax.y(aRow.cumulative),up=event.kind==='refund';
        const points=up?`${x},${y-7} ${x-6},${y+5} ${x+6},${y+5}`:`${x},${y+7} ${x-6},${y-5} ${x+6},${y-5}`;
        out.push(`<polygon class="cf-marker cf-marker-common" points="${points}" fill="#526775" aria-label="A・B共通 ${event.kind==='interim'?'中間納付':event.kind==='final'?'確定納付':'還付'} ${fmtPositive(event.amount)}千円"/>`);
        occupied.push({left:x-6,right:x+6,top:y-7,bottom:y+7});
        if(labelAllowed.A && labelAllowed.B){
          const label=`A・B共通 ${event.kind==='interim'?'中間納付':event.kind==='final'?'確定納付':'還付'} ${fmtPositive(event.amount)}`;
          const placed=labelPlacement(label,x,y,slice.plotWidth,ax.height,occupied,value=>measureWidth(value,options));
          if(placed.fallback)out.push(`<rect class="cf-label-back" x="${placed.rect.left}" y="${placed.rect.top}" width="${placed.rect.right-placed.rect.left}" height="14"/>`);
          out.push(`<text class="cf-event-label" x="${placed.x}" y="${placed.y}">${escape(label)}</text>`);
        }
      }
      const remaining = Object.fromEntries(['A','B'].map(key => {
        const counts = new Map();
        for(const event of common) counts.set(`${event.kind}|${event.amount}`,(counts.get(`${event.kind}|${event.amount}`)||0)+1);
        return [key,data.cases[key].rows[index].events.filter(event => event.amount>0).filter(event => {
          const token=`${event.kind}|${event.amount}`;
          if(!counts.get(token)) return true;
          counts.set(token,counts.get(token)-1);
          return false;
        })];
      }));
      const nearSeparateMarkers=remaining.A.length>0 && remaining.B.length>0
        && Math.abs(ax.y(aRow.cumulative)-ax.y(bRow.cumulative))<=10;
      for(const key of ['A','B']){
        const rows=data.cases[key].rows;
        const row=rows[slice.start+local],x=(local+.5)*slice.CW+(nearSeparateMarkers?(key==='A'?-5:5):0),y=ax.y(row.cumulative);
        for(const event of remaining[key]){
          const up=event.kind==='refund';
          const points=up?`${x},${y-7} ${x-6},${y+5} ${x+6},${y+5}`:`${x},${y+7} ${x-6},${y-5} ${x+6},${y-5}`;
          out.push(`<polygon class="cf-marker cf-marker-${key}" points="${points}" fill="${COLORS[key]}" aria-label="${key} ${event.kind==='interim'?'中間納付':event.kind==='final'?'確定納付':'還付'} ${fmtPositive(event.amount)}千円"/>`);
          occupied.push({left:x-6,right:x+6,top:y-7,bottom:y+7});
          if(labelAllowed[key]){
            const kind=event.kind==='interim'?'中間':event.kind==='final'?'確定':'還付';
            const label=`${key} ${kind} ${fmtPositive(event.amount)}`;
            const placed=labelPlacement(label,x,y,slice.plotWidth,ax.height,occupied,value=>measureWidth(value,options));
            if(placed.fallback)out.push(`<rect class="cf-label-back" x="${placed.rect.left}" y="${placed.rect.top}" width="${placed.rect.right-placed.rect.left}" height="14"/>`);
            out.push(`<text class="cf-event-label" x="${placed.x}" y="${placed.y}">${escape(label)}</text>`);
          }
        }
      }
    }
    return out.join('');
  }
  function maxAnnotation(model,data,slice,ax,options,occupied){
    const index=model.maxIndex;
    if(index<slice.start||index>=slice.end)return '';
    const local=index-slice.start,x=(local+.5)*slice.CW+(local===slice.count-1?slice.CW*.3:slice.CW*.5);
    const a=ax.y(data.cases.A.rows[index].cumulative),b=ax.y(data.cases.B.rows[index].cumulative);
    const label=`最大差 ${fmtPositive(model.maxAbs)}`;
    const width=measureWidth(label,options)+4,mid=(a+b)/2;
    const textX=Math.max(2,x-width-4),textY=Math.max(14,Math.min(ax.height-4,mid-5));
    occupied.push({left:textX,right:textX+width,top:textY-11,bottom:textY+3});
    occupied.push({left:x-2,right:x+2,top:Math.min(a,b),bottom:Math.max(a,b)});
    return `<line class="cf-max-line" x1="${x}" x2="${x}" y1="${a}" y2="${b}"/><text class="cf-max-label" x="${textX}" y="${textY}">${escape(label)}</text>`;
  }
  function lineObstacles(data,slice,ax){
    const obstacles=[];
    for(const key of ['A','B']){
      const rows=data.cases[key].rows;
      for(let local=1;local<slice.count;local++){
        const left=(local-.5)*slice.CW,right=(local+.5)*slice.CW;
        const previous=ax.y(rows[slice.start+local-1].cumulative),current=ax.y(rows[slice.start+local].cumulative);
        obstacles.push({left,right,top:previous-2,bottom:previous+2});
        obstacles.push({left:right-2,right:right+2,top:Math.min(previous,current),bottom:Math.max(previous,current)});
      }
    }
    return obstacles;
  }
  function summary(data,model){
    const a=data.cases.A.label||'A案',b=data.cases.B.label||'B案';
    if(model.maxIndex<0)return `${b}と${a}の月末累積資金差額は、表示期間を通じて0千円です。`;
    const index=model.maxIndex,amount=model.diffCum[index];
    const direction=amount<0?'少なく':'多く';
    const readable=month=>{const [year,part]=month.split('-');return `${year}年${Number(part)}月`;};
    const month=readable(data.months[index])+'末';
    const refunds=data.cases.B.rows.flatMap(row=>row.events.some(event=>event.kind==='refund'&&event.amount>0)?[readable(row.month)]:[]);
    return `${b}の手元資金は${a}より最大${fmtPositive(model.maxAbs)}千円${direction}、差が最大になるのは${month}。${refunds.length?`${b}の還付入金は${refunds.join('・')}。`:''}`;
  }
  function chartHtml(data,model,slice,ax,options){
    const occupied=lineObstacles(data,slice,ax);
    const note=maxAnnotation(model,data,slice,ax,options,occupied);
    const markers=eventSvg(data,slice,ax,options,occupied);
    const yaxis=`<svg class="cf-yaxis" width="${slice.LW}" height="${ax.height}" viewBox="0 0 ${slice.LW} ${ax.height}" aria-hidden="true">${ax.ticks.map(tick=>`<text x="${slice.LW-9}" y="${ax.y(tick)+4}" text-anchor="end">${escape(fmt(tick))}</text>`).join('')}</svg>`;
    const tickLines=ax.ticks.map(tick=>`<line class="${tick===0?'cf-zero-line':'cf-tick-line'}" x1="0" x2="${slice.plotWidth}" y1="${ax.y(tick)}" y2="${ax.y(tick)}"/>`).join('');
    const paths=`<path class="cf-between" fill-rule="nonzero" d="${fillPath(data.cases.A.rows,data.cases.B.rows,slice,slice.CW,ax.y)}"/><path class="cf-line-A" d="${linePath(data.cases.A.rows,slice,slice.CW,ax.y)}"/><path class="cf-line-B" d="${linePath(data.cases.B.rows,slice,slice.CW,ax.y)}"/>`;
    const guides=Array.from({length:slice.count},(_,local)=>{
      const index=slice.start+local,x=(local+.5)*slice.CW;
      return `<g class="cf-guide" data-month-index="${index}" aria-hidden="true"><line x1="${x}" x2="${x}" y1="0" y2="${ax.height}"/><circle cx="${x}" cy="${ax.y(data.cases.A.rows[index].cumulative)}" r="4"/><circle cx="${x}" cy="${ax.y(data.cases.B.rows[index].cumulative)}" r="4"/></g>`;
    }).join('');
    const hits=Array.from({length:slice.count},(_,local)=>`<rect class="cf-hit" data-month-index="${slice.start+local}" x="${local*slice.CW}" y="0" width="${slice.CW}" height="${ax.height}"/>`).join('');
    return `<div class="cf-chart-row">${yaxis}<svg class="cf-plot" width="${slice.plotWidth}" height="${ax.height}" viewBox="0 0 ${slice.plotWidth} ${ax.height}" role="img" aria-label="${escape(summary(data,model))}">${tickLines}${paths}${note}${markers}${guides}${hits}</svg></div>`;
  }
  // Legacy/internal-only renderers below support saved experimental CSV cash
  // views and regression tests. The current STEP4 UI uses chartHtml/tableHtml.
  function actualAxis(data,options){
    const common=new Map(data.actualCash.months.map(item=>[item.month,item.base]));
    const values=[0,...data.months.map(month=>common.get(month)||0)];
    const extent=Math.max(1000,...values.map(Math.abs));
    const top=14,base=84,bottom=152;
    return {height:246,top,base,bottom,y:value=>base-value/extent*(value>=0?base-top:bottom-base)};
  }
  function actualEventGroups(aRow,bRow){
    const a=aRow.events.filter(item=>item.amount>0),b=[...bRow.events.filter(item=>item.amount>0)];
    const common=[];
    for(const event of a){const index=b.findIndex(item=>item.kind===event.kind&&item.amount===event.amount);
      if(index>=0){common.push(event);b.splice(index,1);}}
    const remaining=[...a];
    for(const event of common){const index=remaining.findIndex(item=>item.kind===event.kind&&item.amount===event.amount);if(index>=0)remaining.splice(index,1);}
    return {common,A:remaining,B:b};
  }
  function actualChartHtml(data,model,slice,ax){
    const common=new Map(data.actualCash.months.map(item=>[item.month,item.base]));
    const axis=`<svg class="cf-yaxis" width="${slice.LW}" height="${ax.height}" viewBox="0 0 ${slice.LW} ${ax.height}" aria-hidden="true"><text x="${slice.LW-8}" y="18" text-anchor="end">共通増減</text><text x="${slice.LW-8}" y="188" text-anchor="end">A案税金</text><text x="${slice.LW-8}" y="226" text-anchor="end">B案税金</text></svg>`;
    const bars=data.months.slice(slice.start,slice.end).map((month,local)=>{
      const amount=common.get(month)||0,x=local*slice.CW+slice.CW*.2,y=ax.y(amount);
      const top=Math.min(y,ax.base),height=Math.abs(y-ax.base);
      return `<rect class="cf-actual-bar${amount<0?' cf-actual-negative':''}" data-month-index="${slice.start+local}" x="${x}" y="${top}" width="${slice.CW*.6}" height="${height}" aria-label="${escape(month)} 共通ベース ${escape(fmt(amount))}千円"><title>${escape(month)} 共通ベース ${escape(fmt(amount))}千円</title></rect>`;
    }).join('');
    const events=data.months.slice(slice.start,slice.end).map((month,local)=>{
      const a=data.cases.A.rows[slice.start+local],b=data.cases.B.rows[slice.start+local],groups=actualEventGroups(a,b);
      const x=(local+.5)*slice.CW,out=[];
      for(const [key,y,items] of [['common',190,groups.common],['A',190,groups.A],['B',228,groups.B]]){
        for(const event of items){
          const label=`${key==='common'?'A・B共通':key+'案'} ${event.kind==='interim'?'中間納付':event.kind==='final'?'確定納付':'還付'} ${fmtPositive(event.amount)}千円`;
          const position=key==='common'?209:y;
          const points=event.kind==='refund'?`${x},${position-6} ${x-6},${position+5} ${x+6},${position+5}`
            :`${x},${position+6} ${x-6},${position-5} ${x+6},${position-5}`;
          out.push(`<polygon class="cf-actual-event cf-actual-event-${key}" points="${points}" aria-label="${escape(label)}"><title>${escape(label)}</title></polygon>`);
        }
      }
      return out.join('');
    }).join('');
    const hits=Array.from({length:slice.count},(_,local)=>`<rect class="cf-hit" data-month-index="${slice.start+local}" x="${local*slice.CW}" y="0" width="${slice.CW}" height="${ax.height}"/>`).join('');
    return `<div class="cf-chart-row cf-actual-chart">${axis}<svg class="cf-plot" width="${slice.plotWidth}" height="${ax.height}" viewBox="0 0 ${slice.plotWidth} ${ax.height}" role="img" aria-label="CSV現預金実績とA・Bの税金イベント"><line class="cf-zero-line" x1="0" x2="${slice.plotWidth}" y1="${ax.base}" y2="${ax.base}"/><line class="cf-actual-lane" x1="0" x2="${slice.plotWidth}" y1="171" y2="171"/><line class="cf-actual-lane" x1="0" x2="${slice.plotWidth}" y1="210" y2="210"/>${bars}${events}${hits}</svg></div>`;
  }
  function actualTableHtml(data,model,slice){
    const colgroup=`<colgroup><col style="width:${slice.LW-2}px">${Array.from({length:slice.count},()=>`<col style="width:${slice.CW}px">`).join('')}</colgroup>`;
    const td=(index,value,kind='')=>`<td data-month-index="${index}" class="${kind}${nextYear(data.months,index)?' cf-new-year':''}">${value}</td>`;
    const row=(label,values,className='')=>`<tr class="${className}"><th scope="row" class="cf-row-label">${escape(label)}</th>${values.map((value,local)=>td(slice.start+local,value.html,value.className||'')).join('')}</tr>`;
    const selected=key=>data.cases[key].rows.slice(slice.start,slice.end);
    const format=values=>values.map(value=>({html:fmt(value),className:value<0?'cf-negative':''}));
    const eventValues=(key,kind)=>selected(key).map(item=>({html:sumKind(item,kind)?fmtPositive(sumKind(item,kind)):'—',className:kind==='refund'?'cf-refund':'cf-payment'}));
    const common=new Map(data.actualCash.months.map(item=>[item.month,item.base]));
    const months=data.months.slice(slice.start,slice.end);
    const rows=[row('CSV実績の月別資金増減（共通）',format(months.map(month=>common.get(month)||0)),'cf-common-row')];
    if(Object.values(data.actualCash.commonDelta||{}).some(Boolean))rows.push(row('食品1％取引差（両案共通）',format(months.map(month=>data.actualCash.commonDelta[month]||0))));
    for(const key of ['A','B']){
      rows.push(row(`${key}案 中間納付`,eventValues(key,'interim')));
      rows.push(row(`${key}案 確定納付`,eventValues(key,'final')));
      rows.push(row(`${key}案 還付`,eventValues(key,'refund')));
      rows.push(row(`${key}案 当月資金増減`,format(selected(key).map(item=>item.monthTotal)),`cf-case-${key} cf-actual-total`));
    }
    rows.push(row('差額（B−A）当月',format(model.diffMonth.slice(slice.start,slice.end)),'cf-diff-start'));
    rows.push(row('差額（B−A）累積',format(model.diffCum.slice(slice.start,slice.end))));
    const header=months.map((month,local)=>`<th scope="col" data-month-index="${slice.start+local}" tabindex="0">${escape(monthLabel(month))}</th>`).join('');
    return `<div class="cf-table-wrap"><table class="cf-table cf-actual-table" style="width:${slice.width-2}px">${colgroup}<caption class="cf-sr-only">CSV実績から過去の消費税イベントを除いた共通資金増減とA・B案の税イベント。単位：千円。</caption><thead><tr><th scope="col" class="cf-row-label">区分（千円）</th>${header}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  // The common base is supplied by the display model. This view never derives or
  // reallocates business cash flows, transaction differences, or tax events.
  function sharedAxis(data){
    const amounts=[...data.baseSource.months.map(row=>row.base),
      ...data.cases.A.rows.map(row=>row.monthTotal),...data.cases.B.rows.map(row=>row.monthTotal)];
    const extent=Math.max(1000,...amounts.map(Math.abs));
    const baseline=84;
    return {height:254,baseline,y:amount=>baseline-amount/extent*66};
  }
  function sharedEventLabel(key,event){
    const kind=event.kind==='interim'?'中間納付':event.kind==='final'?'確定納付':'還付';
    return `${key==='common'?'A・B共通':key+'案'} ${kind} ${fmtPositive(event.amount)}千円`;
  }
  function sharedEventMarker(key,event,x,y,plotWidth,showLabel){
    const up=event.kind==='refund';
    const points=up?`${x},${y-6} ${x-6},${y+5} ${x+6},${y+5}`
      :`${x},${y+6} ${x-6},${y-5} ${x+6},${y-5}`;
    const label=sharedEventLabel(key,event);
    const nearRight=x>plotWidth-110;
    const text=showLabel?`<text class="cf-shared-event-label" x="${x+(nearRight?-8:8)}" y="${y-12}" text-anchor="${nearRight?'end':'start'}">${escape(label.replace(/千円$/,''))}</text>`:'';
    return `<polygon class="cf-shared-event cf-shared-event-${key}" points="${points}" aria-label="${escape(label)}"><title>${escape(label)}</title></polygon>${text}`;
  }
  function sharedChartHtml(data,slice,ax){
    const months=data.months.slice(slice.start,slice.end);
    const showEventLabels=['A','B'].reduce((count,key)=>count+data.cases[key].rows.reduce((total,row)=>total+row.events.filter(event=>event.amount>0).length,0),0)<=6;
    const axis=`<svg class="cf-yaxis" width="${slice.LW}" height="${ax.height}" viewBox="0 0 ${slice.LW} ${ax.height}" aria-hidden="true"><text x="${slice.LW-8}" y="21" text-anchor="end">共通ベース・当月増減</text><text x="${slice.LW-8}" y="194" text-anchor="end">A案 税金</text><text x="${slice.LW-8}" y="232" text-anchor="end">B案 税金</text></svg>`;
    const bars=months.map((month,local)=>{
      const amount=data.baseSource.months[slice.start+local].base;
      const x=local*slice.CW+slice.CW*.23,y=ax.y(amount),top=Math.min(y,ax.baseline),height=Math.abs(y-ax.baseline);
      const label=`${month} 共通ベース ${fmt(amount)}千円`;
      return `<rect class="cf-shared-bar${amount<0?' cf-shared-negative':''}" data-month-index="${slice.start+local}" x="${x}" y="${top}" width="${slice.CW*.54}" height="${height}" aria-label="${escape(label)}"><title>${escape(label)}</title></rect>`;
    }).join('');
    const lines=['A','B'].map(key=>{
      const points=months.map((month,local)=>`${(local+.5)*slice.CW},${ax.y(data.cases[key].rows[slice.start+local].monthTotal)}`).join(' ');
      const dots=months.map((month,local)=>{
        const value=data.cases[key].rows[slice.start+local].monthTotal;
        const label=`${key}案 ${month} 当月資金増減 ${fmt(value)}千円`;
        return `<circle class="cf-shared-point cf-shared-point-${key}" data-month-index="${slice.start+local}" cx="${(local+.5)*slice.CW}" cy="${ax.y(value)}" r="3.5" aria-label="${escape(label)}"><title>${escape(label)}</title></circle>`;
      }).join('');
      return `<polyline class="cf-shared-line cf-shared-line-${key}" points="${points}"/>${dots}`;
    }).join('');
    const events=months.map((month,local)=>{
      const index=slice.start+local;
      const groups=actualEventGroups(data.cases.A.rows[index],data.cases.B.rows[index]);
      const x=(local+.5)*slice.CW;
      return [
        ...groups.common.map(event=>sharedEventMarker('common',event,x,210,slice.plotWidth,showEventLabels)),
        ...groups.A.map(event=>sharedEventMarker('A',event,x,190,slice.plotWidth,showEventLabels)),
        ...groups.B.map(event=>sharedEventMarker('B',event,x,230,slice.plotWidth,showEventLabels))
      ].join('');
    }).join('');
    const hits=months.map((month,local)=>`<rect class="cf-hit" data-month-index="${slice.start+local}" x="${local*slice.CW}" y="0" width="${slice.CW}" height="${ax.height}"/>`).join('');
    return `<div class="cf-chart-row cf-shared-chart">${axis}<svg class="cf-plot" width="${slice.plotWidth}" height="${ax.height}" viewBox="0 0 ${slice.plotWidth} ${ax.height}" role="img" aria-label="${escape(data.baseSource.label)}を共通ベースとするA案・B案の当月資金増減と税金イベント"><line class="cf-zero-line" x1="0" x2="${slice.plotWidth}" y1="${ax.baseline}" y2="${ax.baseline}"/><line class="cf-actual-lane" x1="0" x2="${slice.plotWidth}" y1="170" y2="170"/><line class="cf-actual-lane" x1="0" x2="${slice.plotWidth}" y1="210" y2="210"/>${bars}${lines}${events}${hits}</svg></div>`;
  }
  function sharedTableHtml(data,model,slice){
    const colgroup=`<colgroup><col style="width:${slice.LW-2}px">${Array.from({length:slice.count},()=>`<col style="width:${slice.CW}px">`).join('')}</colgroup>`;
    const td=(index,value,kind='')=>`<td data-month-index="${index}" class="${kind}${nextYear(data.months,index)?' cf-new-year':''}">${value}</td>`;
    const row=(label,values,className='')=>`<tr class="${className}"><th scope="row" class="cf-row-label">${escape(label)}</th>${values.map((value,local)=>td(slice.start+local,value.html,value.className||'')).join('')}</tr>`;
    const selected=key=>data.cases[key].rows.slice(slice.start,slice.end);
    const format=values=>values.map(value=>({html:fmt(value),className:value<0?'cf-negative':''}));
    const eventValues=(key,kind)=>selected(key).map(item=>({html:sumKind(item,kind)?fmtPositive(sumKind(item,kind)):'—',className:kind==='refund'?'cf-refund':'cf-payment'}));
    const commonLabel=data.baseSource.kind==='manual'?'手入力の月別資金増減（共通ベース）'
      :data.baseSource.kind==='csv'?'CSV実績の月別資金増減（共通ベース）':'表示用参考額（共通ベース）';
    const rows=[row(commonLabel,format(data.baseSource.months.slice(slice.start,slice.end).map(item=>item.base)),'cf-common-row')];
    for(const key of ['A','B']){
      rows.push(row(`${key}案 中間納付`,eventValues(key,'interim')));
      rows.push(row(`${key}案 確定納付`,eventValues(key,'final')));
      rows.push(row(`${key}案 還付`,eventValues(key,'refund')));
      rows.push(row(`${key}案 当月資金増減`,format(selected(key).map(item=>item.monthTotal)),`cf-case-${key} cf-shared-total`));
    }
    rows.push(row('差額（B−A）当月',format(model.diffMonth.slice(slice.start,slice.end)),'cf-diff-start'));
    rows.push(row('差額（B−A）累積',format(model.diffCum.slice(slice.start,slice.end))));
    const header=data.months.slice(slice.start,slice.end).map((month,local)=>`<th scope="col" data-month-index="${slice.start+local}" tabindex="0">${escape(monthLabel(month))}</th>`).join('');
    return `<div class="cf-table-wrap"><table class="cf-table cf-shared-table" style="width:${slice.width-2}px">${colgroup}<caption class="cf-sr-only">共通ベース、案別の中間・確定納付と還付、当月資金増減、B−A差額。単位：千円。</caption><thead><tr><th scope="col" class="cf-row-label">区分（千円）</th>${header}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  function tableHtml(data,model,slice){
    // Collapsed outer borders add 2px in Chromium; reserve them so rendered month centers match SVG.
    const colgroup=`<colgroup><col style="width:${slice.LW-2}px">${Array.from({length:slice.count},()=>`<col style="width:${slice.CW}px">`).join('')}</colgroup>`;
    const td=(index,text,className='',detail='')=>`<td data-month-index="${index}" class="${className}${nextYear(data.months,index)?' cf-new-year':''}">${text}${detail?`<small>${escape(detail)}</small>`:''}</td>`;
    const tr=(label,type,values,extra='')=>`<tr class="${extra}"><th scope="row" class="cf-row-label">${escape(label)}</th>${values.map((value,local)=>td(slice.start+local,value.html,value.className||'',value.detail||'')).join('')}</tr>`;
    const rows=[];
    for(const key of ['A','B']){
      const selected=data.cases[key].rows.slice(slice.start,slice.end);
      rows.push(tr(data.cases[key].label||`${key}案`,'heading',selected.map(()=>({html:''})),`cf-case-heading cf-case-${key}`));
      if(data.status?.mode!=='methodImpact')rows.push(tr('日常の増減','flow',selected.map(row=>({html:fmt(row.flow),className:row.flow<0?'cf-negative':''}))));
      rows.push(tr('納付','payment',selected.map(row=>({html:sumPayments(row)>0?fmtPositive(sumPayments(row)):'',detail:usedKinds(row),className:sumPayments(row)>0?'cf-payment':''}))));
      rows.push(tr('還付','refund',selected.map(row=>({html:sumKind(row,'refund')>0?fmtPositive(sumKind(row,'refund')):'',className:sumKind(row,'refund')>0?'cf-refund':''}))));
      rows.push(tr('月末累積','cumulative',selected.map(row=>({html:fmt(row.cumulative),className:row.cumulative<0?'cf-negative':''}))));
    }
    rows.push(tr('差額（B−A） 月次','diff-month',model.diffMonth.slice(slice.start,slice.end).map(value=>({html:fmt(value),className:value<0?'cf-negative':''})),'cf-diff-start'));
    rows.push(tr('差額（B−A） 累積','diff-cumulative',model.diffCum.slice(slice.start,slice.end).map(value=>{
      const ratio=model.maxAbs?Math.abs(value)/model.maxAbs:0;
      const level=ratio<1/3?1:ratio<2/3?2:3;
      return {html:fmt(value),className:value<0?`cf-diff-negative cf-level-${level}`:value>0?`cf-diff-positive cf-level-${level}`:''};
    })));
    const header=Array.from({length:slice.count},(_,local)=>{
      const index=slice.start+local,max=index===model.maxIndex;
      return `<th scope="col" data-month-index="${index}" tabindex="0" class="${max?'cf-max-month':''}${nextYear(data.months,index)?' cf-new-year':''}">${escape(monthLabel(data.months[index]))}${max?'<small>最大差</small>':''}</th>`;
    }).join('');
    return `<div class="cf-table-wrap"><table class="cf-table" style="width:${slice.width-2}px">${colgroup}<caption class="cf-sr-only">A案・B案の月別資金増減、納付、還付、月末累積と両案の差額。単位：千円。</caption><thead><tr><th scope="col" class="cf-row-label">区分（千円）</th>${header}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  function renderCashflowPanelHtml(data,options={}){
    const model=buildViewModel(data);
    if(model.unavailable)return `<section class="cf-panel cf-panel-unavailable" aria-label="資金繰りの月別比較"><p role="status">未算定：${escape(model.unavailable)}</p></section>`;
    if(model.error){
      if(options.logErrors!==false&&typeof console!=='undefined'&&console.error)console.error('STEP4 資金繰りパネル内部整合エラー:',model.error);
      return `<section class="cf-panel cf-panel-error" aria-label="資金繰りの月別比較"><p role="alert">内部整合エラー：${escape(model.error)} グラフは表示しません。</p></section>`;
    }
    // The approved tax-method switch keeps the r35 month-end staircase as the
    // primary view. baseSource remains metadata for the common cash basis only.
    const staircase=data.displayStyle==='staircase';
    const layout=grid(data,model,options),ax=staircase?axis(data,options):data.baseSource?sharedAxis(data):data.actualCash?actualAxis(data,options):axis(data,options);
    const remainingNotices=data.baseSource?model.notices.filter(note=>note!==data.baseSource.note):model.notices;
    const noticeHtml=remainingNotices.length?`<div class="cf-notices">${remainingNotices.map(note=>`<p>${escape(note)}</p>`).join('')}</div>`:'';
    // Non-staircase branches are legacy/internal-only; not the current STEP4 UI.
    const segments=layout.slices.map((slice,index)=>`<div class="cf-inner cf-segment" style="--cf-lw:${slice.LW}px;--cf-cw:${slice.CW}px;width:${slice.width}px">${layout.printSplit?`<h5 class="cf-segment-label">${index===0?'前半':'後半'} ${escape(monthLabel(data.months[slice.start]))}〜${escape(monthLabel(data.months[slice.end-1]))}</h5>`:''}${staircase?chartHtml(data,model,slice,ax,options):data.baseSource?sharedChartHtml(data,slice,ax):data.actualCash?actualChartHtml(data,model,slice,ax):chartHtml(data,model,slice,ax,options)}${staircase?tableHtml(data,model,slice):data.baseSource?sharedTableHtml(data,model,slice):data.actualCash?actualTableHtml(data,model,slice):tableHtml(data,model,slice)}</div>`).join('');
    const sourceNote=typeof data.baseSource?.note==='string' ? data.baseSource.note.trim().replace(/^表示用参考額（従来方式）[:：]\s*/,'') : '';
    const sourceDisclosure=data.baseSource?`<p class="cf-source">資金増減の基準：${escape(data.baseSource.label)}${sourceNote?` — ${escape(sourceNote)}`:''}${Object.values(data.baseSource.commonDelta||{}).some(Boolean)?'（食品1％取引差を共通ベースに含む）':''}</p>`:'';
    const baseLegend=staircase?'<span><i class="cf-legend-between" aria-hidden="true"></i>A/B差の塗り</span>'
      :data.baseSource?'<span><i class="cf-legend-base" aria-hidden="true"></i>棒：共通ベース（緑：増加／赤：減少）</span><span>青・橙の点と線：A/B当月資金増減</span>'
      :data.actualCash?'<span><i class="cf-legend-between" aria-hidden="true"></i>棒：過去の消費税除外後の共通ベース</span>'
      :'<span><i class="cf-legend-between" aria-hidden="true"></i>A/B差の塗り</span>';
    return `<section class="cf-panel${options.print?' cf-print-view':''}${staircase?' cf-staircase-view':data.baseSource?' cf-shared-view':data.actualCash?' cf-actual-view':''}" aria-label="資金繰りの月別比較"><div class="cf-legend"><span><i class="cf-swatch cf-swatch-A" aria-hidden="true"></i>${escape(data.cases.A.label||'A案')}</span><span><i class="cf-swatch cf-swatch-B" aria-hidden="true"></i>${escape(data.cases.B.label||'B案')}</span><span><i class="cf-legend-pay" aria-hidden="true"></i>納付</span><span><i class="cf-legend-refund" aria-hidden="true"></i>還付</span>${baseLegend}<span class="cf-unit">単位：${escape(data.unitLabel||'千円')}</span></div>${sourceDisclosure}${noticeHtml}<div class="cf-scroll">${segments}</div>${data.actualCash&&!data.baseSource&&!staircase?`<details class="cf-auxiliary"><summary>A/B月末累積差を見る</summary>${layout.slices.map(slice=>chartHtml(data,model,slice,axis(data,options),options)).join('')}</details>`:''}</section>`;
  }

  const styles=`
.cf-panel{min-width:0;color:#183b4a;font-size:12px}.cf-panel *{box-sizing:border-box}.cf-legend{display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap;margin:5px 0 8px;font-size:12px}.cf-legend span{white-space:nowrap}.cf-swatch{display:inline-block;width:22px;height:0;vertical-align:middle;margin-right:5px;border-top:2px solid}.cf-swatch-A{border-color:#2a78d6}.cf-swatch-B{border-color:#eb6834;border-top-style:dashed}.cf-unit{margin-left:auto;color:#526775}.cf-notices{padding:6px 9px;margin-bottom:8px;border:1px solid #e3c88f;border-radius:5px;background:#fff8e9;color:#704c18}.cf-notices p{margin:2px 0}.cf-panel-error{padding:8px;border:1px solid #a32d2d;color:#a32d2d;background:#fff4f4}.cf-panel-error p{margin:0}.cf-scroll{max-width:100%;overflow-x:auto;overflow-y:hidden}.cf-segment{max-width:none}.cf-chart-row{display:flex;align-items:start}.cf-yaxis{flex:none;position:sticky;left:0;z-index:3;background:#fff;overflow:visible}.cf-yaxis text{font:11px sans-serif;fill:#465b68}.cf-plot{flex:none;overflow:visible;font:10px sans-serif}.cf-zero-line{stroke:#c3c2b7;stroke-width:1}.cf-tick-line{stroke:#dce3e8;stroke-width:.5}.cf-between{fill:#888780;fill-opacity:.2;stroke:none}.cf-line-A{fill:none;stroke:#2a78d6;stroke-width:2}.cf-line-B{fill:none;stroke:#eb6834;stroke-width:2;stroke-dasharray:6 4}.cf-max-line{stroke:#526775;stroke-width:1;stroke-dasharray:3 3}.cf-max-label{font-weight:bold;fill:#a32d2d}.cf-event-label{font-weight:bold}.cf-label-back{fill:#fff;fill-opacity:.8}.cf-hit{fill:transparent;pointer-events:all}.cf-guide{display:none;pointer-events:none}.cf-guide line{stroke:#5892bb;stroke-width:1}.cf-guide circle{fill:#fff;stroke:#326b9e;stroke-width:2}.cf-guide.cf-active{display:block}.cf-table-wrap{width:max-content;max-width:none}.cf-table{table-layout:fixed;border-collapse:collapse;margin:0;font-size:11px;line-height:1.25}.cf-table th,.cf-table td{padding:4px;text-align:right;border:1px solid #d9e2e7;white-space:nowrap;overflow:hidden}.cf-table thead th{background:#e9f2f5;font-weight:700}.cf-table .cf-row-label{position:sticky;left:0;z-index:2;background:#fff;text-align:left;white-space:normal;overflow-wrap:anywhere}.cf-table thead .cf-row-label{z-index:4;background:#e9f2f5}.cf-table .cf-case-heading .cf-row-label{font-weight:700;border-left:3px solid}.cf-table .cf-case-A .cf-row-label{border-left-color:#2a78d6}.cf-table .cf-case-B .cf-row-label{border-left-color:#eb6834}.cf-table .cf-case-heading td,.cf-table .cf-case-heading .cf-row-label{background:#f0f5f7}.cf-table .cf-new-year{border-left:2px solid #899ba7}.cf-table small{display:block;font-size:9px;font-weight:400}.cf-table .cf-payment{background:#fcebeb;color:#a32d2d}.cf-table .cf-refund{background:#eaf3de;color:#3b6d11}.cf-table .cf-negative{color:#a32d2d}.cf-table .cf-max-month{color:#a32d2d;font-weight:700}.cf-table .cf-diff-start>*{border-top:2px solid #8a9ea9}.cf-table .cf-diff-negative.cf-level-1{background:rgba(163,45,45,.12)}.cf-table .cf-diff-negative.cf-level-2{background:rgba(163,45,45,.22)}.cf-table .cf-diff-negative.cf-level-3{background:rgba(163,45,45,.34)}.cf-table .cf-diff-positive.cf-level-1{background:rgba(42,120,214,.12)}.cf-table .cf-diff-positive.cf-level-2{background:rgba(42,120,214,.22)}.cf-table .cf-diff-positive.cf-level-3{background:rgba(42,120,214,.34)}.cf-table [data-month-index].cf-active{box-shadow:inset 0 0 0 999px rgba(78,153,220,.10)}.cf-sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.cf-segment-label{margin:8px 0 3px;font-size:11px}
.cf-event-label{fill:#233a46}.cf-legend-pay,.cf-legend-refund{display:inline-block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;margin-right:5px;vertical-align:middle}.cf-legend-pay{border-top:9px solid #526775}.cf-legend-refund{border-bottom:9px solid #526775}.cf-legend-between{display:inline-block;width:16px;height:9px;margin-right:5px;background:rgba(136,135,128,.25);vertical-align:middle}
/* Legacy/internal-only styles for the old actual/CSV bar renderers; current STEP4 uses the staircase chart. */
.cf-actual-bar{fill:#879ba5;opacity:.75}.cf-actual-negative{fill:#b29390}.cf-actual-lane{stroke:#e1e8ec;stroke-width:1}.cf-actual-event-A{fill:#2a78d6}.cf-actual-event-B{fill:#eb6834}.cf-actual-event-common{fill:#526775}.cf-actual-table .cf-common-row th,.cf-actual-table .cf-common-row td{background:#f0f5f7}.cf-actual-table .cf-actual-total th{font-weight:700}.cf-auxiliary{margin-top:8px}.cf-auxiliary summary{cursor:pointer;color:#315f76}.cf-panel-unavailable{padding:8px;border:1px solid #d7b56b;border-radius:5px;background:#fff8e9}
.cf-source{margin:4px 0 8px;padding:5px 8px;border-left:3px solid #607e89;background:#f1f6f8;color:#314a57;line-height:1.45;overflow-wrap:anywhere}.cf-legend-base{display:inline-block;width:12px;height:12px;margin-right:5px;background:#4b9a65;vertical-align:middle}.cf-shared-bar{fill:#4b9a65;opacity:.55}.cf-shared-negative{fill:#c86158}.cf-shared-line{fill:none;stroke-width:2.3}.cf-shared-line-A{stroke:#2a78d6}.cf-shared-line-B{stroke:#eb6834;stroke-dasharray:5 3}.cf-shared-point{stroke-width:1.5;fill:#fff}.cf-shared-point-A{stroke:#2a78d6}.cf-shared-point-B{stroke:#eb6834}.cf-shared-event-A{fill:#2a78d6}.cf-shared-event-B{fill:#eb6834}.cf-shared-event-common{fill:#526775}.cf-shared-event-label{font:600 9px sans-serif;fill:#233a46}.cf-shared-table .cf-common-row th,.cf-shared-table .cf-common-row td{background:#eaf3ec}.cf-shared-table .cf-shared-total th{font-weight:800}
@media print{.cf-panel,.cf-panel *{-webkit-print-color-adjust:exact;print-color-adjust:exact}.cf-scroll{overflow:visible!important}.cf-segment{break-inside:auto;page-break-inside:auto;max-width:280mm!important}.cf-chart-row{break-inside:avoid;page-break-inside:avoid}.cf-segment+.cf-segment{margin-top:12px}.cf-yaxis{position:static!important}.cf-table .cf-row-label{position:static!important}.cf-guide{display:none!important}.cf-plot{font-size:9px}.cf-table{font-size:10px}.cf-table th,.cf-table td{padding:2px}.cf-table small{font-size:9px}.cf-panel .cf-unit{margin-left:0}}
`;

  function ensureStyles(doc){
    if(!doc||doc.querySelector('style[data-cf-panel-view]'))return;
    const style=doc.createElement('style');style.setAttribute('data-cf-panel-view','');style.textContent=styles;doc.head.appendChild(style);
  }
  function renderCashflowPanel(container,data,options={}){
    if(!container||typeof container.innerHTML!=='string')throw new TypeError('描画先の要素が必要です。');
    const old=instances.get(container);if(old)old();
    const doc=container.ownerDocument||document;
    ensureStyles(doc);
    const win=doc.defaultView||globalThis;
    let print=Boolean(options.print),timer=null,active=-1,tapped=false,observer=null,lastWidth=0;
    const drawing=()=>{
      const width=print?680:(Number(options.width)||container.clientWidth||680);
      lastWidth=width;
      container.innerHTML=renderCashflowPanelHtml(data,{...options,width,print});
      active=-1;tapped=false;
    };
    const highlight=index=>{
      container.querySelectorAll('[data-month-index]').forEach(node=>node.classList.toggle('cf-active',Number(node.getAttribute('data-month-index'))===index&&index>=0));
      active=index;
    };
    const indexed=target=>target&&target.closest?target.closest('[data-month-index]'):null;
    const onPointer=event=>{if(print||event.pointerType==='touch'||tapped)return;const node=indexed(event.target);if(node&&container.contains(node))highlight(Number(node.getAttribute('data-month-index')));};
    const onLeave=()=>{if(!tapped)highlight(-1);};
    const onClick=event=>{const node=indexed(event.target);if(!node||!container.contains(node))return;const index=Number(node.getAttribute('data-month-index'));if(tapped&&active===index){tapped=false;highlight(-1);}else{tapped=true;highlight(index);}};
    const onKey=event=>{if(event.key!=='Enter'&&event.key!==' ')return;const node=indexed(event.target);if(!node||!container.contains(node))return;event.preventDefault();onClick(event);};
    const onBeforePrint=()=>{print=true;drawing();};
    const onAfterPrint=()=>{print=false;drawing();};
    const onMedia=event=>event.matches?onBeforePrint():onAfterPrint();
    drawing();
    container.addEventListener('pointerover',onPointer);container.addEventListener('pointermove',onPointer);container.addEventListener('pointerleave',onLeave);container.addEventListener('click',onClick);container.addEventListener('keydown',onKey);
    if(win.addEventListener){win.addEventListener('beforeprint',onBeforePrint);win.addEventListener('afterprint',onAfterPrint);}
    const media=win.matchMedia?win.matchMedia('print'):null;
    if(media&&media.addEventListener)media.addEventListener('change',onMedia);
    if(win.ResizeObserver){observer=new win.ResizeObserver(()=>{if(print||options.width||container.clientWidth===lastWidth)return;if(timer)win.clearTimeout(timer);timer=win.setTimeout(drawing,100);});observer.observe(container);}
    const cleanup=()=>{
      if(observer)observer.disconnect();if(timer)win.clearTimeout(timer);
      container.removeEventListener('pointerover',onPointer);container.removeEventListener('pointermove',onPointer);container.removeEventListener('pointerleave',onLeave);container.removeEventListener('click',onClick);container.removeEventListener('keydown',onKey);
      if(win.removeEventListener){win.removeEventListener('beforeprint',onBeforePrint);win.removeEventListener('afterprint',onAfterPrint);}
      if(media&&media.removeEventListener)media.removeEventListener('change',onMedia);
      if(instances.get(container)===cleanup)instances.delete(container);
    };
    instances.set(container,cleanup);
    return cleanup;
  }
  return {buildViewModel,renderCashflowPanel,renderCashflowPanelHtml,styles};
});
