'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const view=fs.readFileSync(path.join(root,'cashflow-panel-view.js'),'utf8');
const release=require('../release-history.js');
function source(name){
  const start=html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,name);
  const end=html.indexOf('\nfunction ',start+1);
  return html.slice(start,end<0?undefined:end);
}

test('FINAL05-06 金額の負数は▲、イベント凡例は文字でない上下三角形',()=>{
  const context=vm.createContext({});
  vm.runInContext(source('yen'),context);
  assert.equal(context.yen(-350000),'▲350,000円');
  assert.equal(context.yen(350000),'350,000円');
  assert.match(view,/class="cf-legend-pay" aria-hidden="true"/);
  assert.match(view,/class="cf-legend-refund" aria-hidden="true"/);
  assert.match(view,/\.cf-legend-pay\{border-top:9px/);
  assert.match(view,/\.cf-legend-refund\{border-bottom:9px/);
  assert.doesNotMatch(view,/▼納付|▲還付|△/);
});

test('FINAL09-10 印刷は要約の直後にパネルを置き、グラフを先送りしない',()=>{
  for(const name of ['renderCashflow','renderMethodCashflow']){
    const code=source(name);
    const printed=code.slice(code.indexOf("$('cashflowPrintReport').innerHTML = `<h1>${escapeHtml(APP_META.name)}</h1>"));
    assert.ok(printed.indexOf('${cards}')<printed.indexOf('cashflow-print-visual')
      || printed.indexOf('${taxRows}')<printed.indexOf('cashflow-print-visual'));
    assert.ok(printed.indexOf('cashflow-print-visual')<printed.indexOf('cashflow-print-tax'));
    assert.ok(printed.indexOf('cashflow-print-tax')<printed.indexOf('cashflow-print-assumptions'));
  }
  assert.match(html,/\.cashflow-print-visual\{break-inside:auto\}/);
  assert.doesNotMatch(html,/\.cashflow-print-visual\{break-before:page/);
  assert.match(view,/\.cf-segment\{break-inside:auto;page-break-inside:auto/);
  assert.match(view,/\.cf-chart-row\{break-inside:avoid/);
});

test('FINAL11 旧描画は内部回帰専用と明示し、現行は階段線を正本にする',()=>{
  assert.match(view,/Legacy\/internal-only renderers/);
  assert.match(view,/Non-staircase branches are legacy\/internal-only/);
  assert.match(view,/Legacy\/internal-only styles/);
  assert.match(view,/staircase\?chartHtml\(/);
  assert.match(view,/staircase\?tableHtml\(/);
});

test('FINAL12-14 新名称は画面・帳票・コピー・CSV・READMEへ伝わる',()=>{
  const name='課税方式・資金繰り検討ツール';
  assert.equal(release.APP_META.name,name);
  assert.match(html,new RegExp(`<title>${name}`));
  assert.match(html,new RegExp(`<h1>${name}`));
  assert.match(source('renderCashflow'),/cashflowPrintReport'\)\.innerHTML = `<h1>\$\{escapeHtml\(APP_META\.name\)\}/);
  assert.match(source('renderMethodCashflow'),/cashflowPrintReport'\)\.innerHTML = `<h1>\$\{escapeHtml\(APP_META\.name\)\}/);
  assert.match(source('cashflowExportText'),/\[APP_META\.name/);
  assert.match(source('cashflowCsvText'),/\['ツール名',APP_META\.name\]/);
  assert.match(fs.readFileSync(path.join(root,'README.md'),'utf8'),new RegExp(`^# ${name}`));
});

test('食品販売型・食品仕入型サンプルは5,000万円未満の基準売上高で簡易課税も比較する',()=>{
  const code=source('loadSampleInput');
  const sampleBlock=code.match(/const samples = (\{[\s\S]*?\n  \});/);
  assert.ok(sampleBlock);
  const samples=vm.runInNewContext(`(${sampleBlock[1]})`);
  assert.equal(samples.manufacturer.label,'食品販売型（食品加工業など）');
  assert.equal(samples.restaurant.label,'食品仕入型（飲食店など）');
  for(const sample of Object.values(samples)){
    assert.ok(Number(sample.baseSales)>0&&Number(sample.baseSales)<50000000);
    assert.ok(sample.sales.length&&sample.purchases.length);
  }
  assert.match(html,/data-sample-input="manufacturer">食品販売型（食品加工業など）/);
  assert.match(html,/data-sample-input="restaurant">食品仕入型（飲食店など）/);
  assert.match(code,/\$\('baseTaxableSales'\)\.value = sample\.baseSales/);
  assert.match(code,/\$\('compareSimplified'\)\.checked = true/);
});
