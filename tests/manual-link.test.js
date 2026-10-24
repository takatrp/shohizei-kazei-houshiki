'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manualVideo = require('../manual-video.js');

test('固定ステップ欄の再生ボタンはページ内の動画ダイアログを開く', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sticky = html.match(/<div class="panel workflow-sticky no-print" id="workflowSticky">([\s\S]*?)<div class="screen-note" id="workflowStepSummary">/);
  assert.ok(sticky, '印刷対象外の固定ステップ欄が存在する');
  assert.match(sticky[1], /<button[^>]+id="manualVideoOpen"[^>]+aria-haspopup="dialog"[^>]+aria-controls="manualVideoDialog"/);
  assert.match(sticky[1], /<svg[^>]+aria-hidden="true"/);
  assert.match(sticky[1], /<span>マニュアル動画<\/span>/);
  assert.match(html, /<dialog[^>]+id="manualVideoDialog"[^>]+aria-labelledby="manualVideoTitle"[^>]+aria-describedby="manualVideoDescription"/);
  assert.match(html, /<video[^>]+id="manualVideo"[^>]+controls playsinline preload="metadata"/);
  assert.match(html, /<source src="\.\/manual\/csv-import-guide\.mp4" type="video\/mp4">/);
  assert.doesNotMatch(html.match(/<video[^>]+id="manualVideo"[^>]*>/)[0], /autoplay/);
});

test('文章マニュアルPDFは削除せず動画ダイアログから引き続き開ける', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dialog=html.match(/<dialog[^>]+id="manualVideoDialog"[\s\S]*?<\/dialog>/)[0];
  assert.match(dialog,/href="\.\/manual\/usage-manual\.pdf" target="_blank" rel="noopener" type="application\/pdf"/);
  const pdf = fs.readFileSync(path.join(root, 'manual', 'usage-manual.pdf'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 100_000, '空のPDFを配布しない');
});

test('動画を自動再生せず、閉じたら一時停止してボタンへフォーカスを戻す',()=>{
  const listeners={},open={dataset:{},addEventListener:(name,fn)=>listeners['open:'+name]=fn,focus:options=>{open.focusOptions=options;}};
  const dialog={open:false,addEventListener:(name,fn)=>listeners['dialog:'+name]=fn,showModal(){this.open=true;this.opens=(this.opens||0)+1;},close(){this.open=false;listeners['dialog:close']();}};
  const close={addEventListener:(name,fn)=>listeners['close:'+name]=fn},video={play(){throw new Error('Do not autoplay');},pause(){this.pauses=(this.pauses||0)+1;}};
  const nodes={manualVideoOpen:open,manualVideoDialog:dialog,manualVideoClose:close,manualVideo:video},doc={getElementById:id=>nodes[id]};
  manualVideo.init(doc);manualVideo.init(doc);listeners['open:click']();listeners['open:click']();assert.equal(dialog.opens,1);assert.equal(video.pauses,undefined);
  listeners['close:click']();assert.equal(dialog.open,false);assert.equal(video.pauses,1);assert.deepEqual(open.focusOptions,{preventScroll:true});
  listeners['open:click']();dialog.close();assert.equal(video.pauses,2);
});

test('動画ボタンの通常色・ホバー色は白文字と4.5以上、フォーカスは白背景と3以上のコントラスト',()=>{
  const luminance=hex=>{const rgb=hex.match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const contrast=hex=>1.05/(luminance(hex)+.05);
  for(const color of ['0b6678','084f5e'])assert.ok(contrast(color)>=4.5);
  assert.ok(contrast('995b00')>=3);
});
