'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tax = require('../tax-engine.js');

const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function functionSource(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} exists`);
  const end = html.indexOf('\nfunction ',start+1);
  return html.slice(start,end < 0 ? undefined : end);
}
function screenFunctions(){
  const context = vm.createContext({yen:value => `${value}円`,escapeHtml:value => String(value)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),sanitizeCsvCell:tax.sanitizeCsvCell});
  vm.runInContext(['cashflowChartHtml','cashflowTableHtml','cashflowExportText','cashflowCsvText']
    .map(functionSource).join('\n'),context);
  return context;
}

const example = {
  adapter:{periodStart:'2027-04',periodEnd:'2028-03',annualTax:{base:2400000,changed:300000},
    distribution:{used:'uniform'}},methodLabel:'一般課税',notes:['=HYPERLINK("https://invalid.example","非公開")'],
  engine:{status:'complete',totals:{sales:-7000000,purchase:4900000},periodEndCumulative:-2100000,
    maxDrawdown:{amount:2100000,month:'2028-03'},finalCumulative:0,rows:[{
      month:'2028-05',sales:0,purchase:0,interim:0,settlement:2100000,refund:0,net:2100000,cumulative:0,
      phase:'settlement',baseTax:{interim:0,settlement:2400000,refund:0},
      changedTax:{interim:0,settlement:300000,refund:0}
    }]}
};

test('CF24 表示4段階を内部1,2,4,5へ対応させ、旧STEP3の復元を残す',()=>{
  assert.match(html,/const WORKFLOW_STEPS = Object\.freeze\(\[\s*\{id:1,[\s\S]*\{id:2,[\s\S]*\{id:4,[\s\S]*\{id:5,/);
  assert.match(html,/if\(workflowStep === 3\) workflowStep = 4/);
  assert.match(html,/data-workflow-step="5">4\. 資金繰りへの影響/);
  assert.match(html,/id="workflowScreen5"/);
});

test('CF16,25 部分試算のコピー・CSVは税金イベントと最終差額を0円にしない',()=>{
  const ui=screenFunctions();
  const partial={...example,engine:{...example.engine,status:'partial',maxDrawdown:null,finalCumulative:null,
    rows:example.engine.rows.map(row => ({...row,interim:null,settlement:null,refund:null,baseTax:null,changedTax:null}))}};
  const text=ui.cashflowExportText(partial);
  const csv=ui.cashflowCsvText(partial);
  assert.match(text,/最大一時資金減少：税金込みは未算定/);
  assert.match(text,/精算後累積：未算定/);
  assert.match(csv,/未反映/);
  assert.match(csv,/精算後累積,未算定/);
});

test('CF25 資金繰りCSVは両案の納付内訳を持ち、式注入を中和する',()=>{
  const csv=screenFunctions().cashflowCsvText(example);
  assert.match(csv,/基準案確定納付,変更案確定納付/);
  assert.match(csv,/2400000,300000/);
  assert.doesNotMatch(csv,/\r\n前提・未確認,=HYPERLINK/);
  assert.match(csv,/\r\n前提・未確認,"'=HYPERLINK/);
});

test('CF29 対象期後の月を表とグラフで分け、税金未反映を単独表示する',()=>{
  const ui=screenFunctions();
  const rows=[{...example.engine.rows[0],month:'2028-03',phase:'transaction',cumulative:-2100000},example.engine.rows[0]];
  const chart=ui.cashflowChartHtml(rows,true,null);
  const table=ui.cashflowTableHtml(rows,true);
  assert.match(chart,/税金未反映・取引差額のみ/);
  assert.match(chart,/対象期後の精算/);
  assert.match(table,/class="after-period"/);
  assert.match(table,/未反映/);
});

test('CF25 顧客用の専用帳票と資金繰り印刷をCSSで分離する',()=>{
  assert.match(html,/body\[data-print-target="cashflow"\] \.wrap > :not\(#cashflowPrintReport\)/);
  assert.match(html,/body\[data-print-target="customer"\] \.wrap > :not\(#customerPrintReport\)/);
  assert.match(functionSource('prepareComparisonPrint'),/dataset\.printTarget === 'customer'\) return/);
});
