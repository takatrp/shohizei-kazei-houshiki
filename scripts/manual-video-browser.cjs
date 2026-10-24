'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.KAZEI_EVIDENCE_DIR||'/tmp/kazei-manual-video-browser');
if(output===root||output.startsWith(root+path.sep))throw new Error('Evidence must stay outside repository');
const server=http.createServer((req,res)=>{
  let file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}if(file===root)file=path.join(root,'index.html');
  if(!fs.existsSync(file)){res.writeHead(404).end();return;}
  const size=fs.statSync(file).size,type=file.endsWith('.mp4')?'video/mp4':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8';
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);let start=0,end=size-1;
  if(range){start=Number(range[1]);end=Math.min(range[2]?Number(range[2]):size-1,size-1);if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}}
  res.writeHead(range?206:200,{'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
  if(req.method==='HEAD')res.end();else fs.createReadStream(file,{start,end}).pipe(res);
});
(async()=>{
  fs.mkdirSync(output,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const report={checks:[],pageErrors:[]};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ja-JP'});await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
    const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    const check=async(name,fn)=>{try{await fn();report.checks.push({name,status:'PASS'});}catch(e){report.checks.push({name,status:'FAIL',reason:e.message});throw e;}};
    const luminance=rgb=>rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    await check('再生アイコン・高コントラスト・キーボードフォーカス',async()=>{
      const button=page.getByRole('button',{name:'マニュアル動画',exact:true});assert.equal(await button.count(),1);await page.keyboard.press('Tab');await button.focus();
      const style=await button.evaluate(el=>{const s=getComputedStyle(el);return {bg:s.backgroundColor,fg:s.color,outline:s.outlineColor,width:parseFloat(s.outlineWidth),visible:el.matches(':focus-visible'),icons:el.querySelectorAll('svg[aria-hidden="true"]').length};});
      assert.equal(style.icons,1);assert.ok(contrast(style.bg,style.fg)>=4.5);assert.equal(style.visible,true);assert.ok(style.width>=3);assert.ok(contrast(style.outline,'rgb(255,255,255)')>=3);report.button=style;
    });
    await check('Enterでモーダル・標準controls/playsinline・自動再生なし',async()=>{
      await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'マニュアル動画'}).waitFor({state:'visible'});
      const state=await page.locator('#manualVideo').evaluate(v=>({controls:v.controls,inline:v.playsInline,preload:v.preload,autoplay:v.autoplay,paused:v.paused,time:v.currentTime}));
      assert.deepEqual(state,{controls:true,inline:true,preload:'metadata',autoplay:false,paused:true,time:0});assert.equal(await page.evaluate(()=>document.activeElement.id),'manualVideoClose');
      report.focus=[];
      for(let i=0;i<8;i++){await page.keyboard.press('Tab');const focus=await page.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName,inDialog:$('manualVideoDialog').contains(document.activeElement),documentFocus:document.hasFocus()}));report.focus.push(focus);assert.ok(focus.inDialog||!focus.documentFocus&&focus.tag==='BODY',JSON.stringify(focus));}
      report.initial=state;
    });
    await check('Esc・閉じるボタン・フォーカス復帰・文章PDF維持',async()=>{
      await page.keyboard.press('Escape');assert.equal(await page.locator('#manualVideoDialog').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'manualVideoOpen');
      await page.locator('#manualVideoOpen').click();assert.equal(await page.locator('#manualVideoDialog a[href="./manual/usage-manual.pdf"]').count(),1);await page.locator('#manualVideoClose').click();
      assert.equal(await page.locator('#manualVideo').evaluate(v=>v.paused),true);assert.equal(await page.evaluate(()=>document.activeElement.id),'manualVideoOpen');
    });
    await check('390pxスマホ・横向きでプレイヤーと閉じるボタンが画面内',async()=>{
      for(const viewport of [{width:390,height:844},{width:844,height:390}]){
        await page.setViewportSize(viewport);await page.locator('#manualVideoOpen').click();
        for(const id of ['manualVideoDialog','manualVideo','manualVideoClose']){const b=await page.locator('#'+id).boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=viewport.width+1&&b.y+b.height<=viewport.height+1,JSON.stringify({id,b,viewport}));}
        await page.screenshot({path:path.join(output,`modal-${viewport.width}.png`),fullPage:true});await page.locator('#manualVideoClose').click();
      }
    });
    const asset=path.join(root,'manual/csv-import-guide.mp4');
    if(!fs.existsSync(asset)){report.playback={status:'BLOCKED',reason:'Approved video asset has not been materialized'};throw new Error(report.playback.reason);}
    await check('承認動画のMIME/bytes・Range配信・実再生と閉じた際の停止',async()=>{
      assert.equal(fs.statSync(asset).size,8126620);const url=`http://127.0.0.1:${server.address().port}/manual/csv-import-guide.mp4`;
      const head=await context.request.head(url);assert.equal(head.status(),200);assert.equal(head.headers()['content-type'],'video/mp4');assert.equal(Number(head.headers()['content-length']),8126620);
      const part=await context.request.get(url,{headers:{Range:'bytes=0-1023'}});assert.equal(part.status(),206);assert.equal((await part.body()).length,1024);assert.equal(part.headers()['content-range'],'bytes 0-1023/8126620');
      await page.setViewportSize({width:1440,height:1000});await page.locator('#manualVideoOpen').click();await page.waitForFunction(()=>$('manualVideo').readyState>=1);
      const metadata=await page.locator('#manualVideo').evaluate(v=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight,paused:v.paused,muted:v.muted}));assert.ok(metadata.duration>174&&metadata.duration<176);assert.equal(metadata.width,1920);assert.equal(metadata.height,1080);assert.equal(metadata.paused,true);assert.equal(metadata.muted,false);
      await page.locator('#manualVideo').evaluate(async v=>{v.muted=true;await v.play();});await page.waitForFunction(()=>$('manualVideo').currentTime>.2);await page.locator('#manualVideoClose').click();const stopped=await page.locator('#manualVideo').evaluate(v=>({paused:v.paused,time:v.currentTime}));assert.equal(stopped.paused,true);
      await page.locator('#manualVideoOpen').click();assert.equal(await page.locator('#manualVideo').evaluate(v=>v.paused),true);await page.locator('#manualVideo').evaluate(v=>v.play());await page.waitForFunction(()=>$('manualVideo').paused===false);await page.keyboard.press('Escape');assert.equal(await page.locator('#manualVideo').evaluate(v=>v.paused),true);
      report.playback={status:'PASS',mime:head.headers()['content-type'],bytes:Number(head.headers()['content-length']),metadata,stopped};
    });
    assert.deepEqual(report.pageErrors,[]);console.log(JSON.stringify(report,null,2));
  }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
