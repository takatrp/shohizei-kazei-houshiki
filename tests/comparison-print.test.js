'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEFERRED_LIMITATIONS } = require('../release-history.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

function harness(names){
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)){
      const classes = new Set();
      elements.set(id, {
        value:'', checked:false, open:false, style:{}, dataset:{}, innerHTML:'', listeners:{},
        clientHeight:1040, clientWidth:718, scrollHeight:700, scrollWidth:718,
        classList:{ add:value => classes.add(value), remove:value => classes.delete(value), contains:value => classes.has(value), toggle(value,force){ if(force === undefined ? !classes.has(value) : force) classes.add(value); else classes.delete(value); } },
        addEventListener(type, callback){ this.listeners[type] = callback; },
        querySelector(){ return null; }, querySelectorAll(){ return []; }
      });
    }
    return elements.get(id);
  };
  const windowListeners = {};
  const actions = [];
  const calc = {
    ctx:{ taxScenario:'current', taxScenarioLabel:'現行税率', officeInternalMemo:'OFFICE_MEMO_SECRET' },
    methods:[{ key:'regular', calculationMethod:'全額控除', reason:'仕入の用途確認が必要' }],
    regular:{ unavailableReasons:['用途別税額が未入力'] }, inputErrors:[],
    csvReview:{ reviewItems:[{ source:'SOURCE_CSV_SECRET', amount:987654 }] },
    sourceText:'RAW_CSV_SECRET', office:{ laborCost:'OFFICE_COST_SECRET' },
    decision:{ office:{ suggestion:'PRIVATE_SUGGESTION_SECRET' } },
    assumptions:[
      ['課税期間','2028-01-01 から 2028-12-31'], ['入力金額','税込'],
      ['未確認事項','基準期間売上高は未確認'],
      ['CSV集計範囲','仮除外2明細、金額11,000円、金額不明1明細'],
      ['明示1％CSVの計算前提','元取引の税率は未確認・入力税率を仮定']
    ]
  };
  const context = vm.createContext({
    $:element,
    document:{ body:{ dataset:{} }, querySelectorAll:() => [], querySelector:() => null, addEventListener(){} },
    window:{ addEventListener:(type, callback) => { windowListeners[type] = callback; }, print:() => actions.push('print') },
    APP_META:{ version:'r28', updatedAt:'2026-09-23' }, METHOD_LABELS:{ regular:'本則課税' },
    DEFERRED_LIMITATIONS,
    csvReviewNotice:() => '',
    buildAssumptionRows:current => current.assumptions,
    calculate:() => { actions.push('calculate'); return calc; },
    renderCurrentRateComparison:current => { assert.equal(current, calc); actions.push('render'); },
    handleJournalCsvFile(){}, applyJournalImport(){}, clearJournalImport(){}, resetAll(){},
    prepareCustomerPrint:report => actions.push(['customer', report]),
    latestCalculation:{ decision:{ customer:{ title:'顧客用切替判断' } } }
  });
  vm.runInContext(['escapeHtml', ...names].map(source).join('\n'), context);
  return { context, element, actions, windowListeners, calc };
}

test('[r28印刷03] 専用帳票は確認前提と計算方法を保持し、CSV個別情報・内部費用・エラー原文を載せない', () => {
  const h = harness(['renderComparisonPrint']);
  h.calc.ctx.taxScenario = 'foodProposal';
  h.calc.ctx.taxScenarioLabel = '飲食料品1％・大綱に基づく試算';
  h.calc.inputErrors = ['ERROR_SOURCE_SECRET', '<script>PRIVATE_ERROR_SECRET</script>'];
  h.calc.smallDifference = true;
  h.context.renderComparisonPrint(h.calc, {
    rows:[{ key:'regular', reasons:['用途別税額は入力値固定'] }],
    notes:['差額は飲食料品1％試算 − 現行税率','入力した価格を仮定']
  }, '<tr><th>課税方式</th></tr>', '<tr><td>未算定</td></tr>');
  const markup = h.element('comparisonPrintContent').innerHTML;
  for(const text of ['未算定','入力エラー2件','2028-01-01','基準期間売上高は未確認','仮除外2明細','11,000円','金額不明1明細',
    '元取引の税率は未確認','入力税率を仮定','全額控除','仕入の用途確認が必要','用途別税額が未入力','用途別税額は入力値固定',
    '差額は飲食料品1％試算 − 現行税率','大綱','未施行']) assert.ok(markup.includes(text), text);
  assert.doesNotMatch(markup, /SECRET|987654|<script>|trace-body|<details|calculation-trace/);
  for(const note of DEFERRED_LIMITATIONS.filter(item => !item.startsWith('4期試算'))) assert.ok(markup.includes(h.context.escapeHtml(note)), '当期の個別確認事項を帳票にも保持する');
  assert.match(markup, /1億円/);
  assert.match(markup, /棚卸資産/);
  assert.match(markup, /原則2年/);
  assert.match(markup, /高額/);
  assert.match(markup, /差が小さい|僅差/);
  assert.doesNotMatch(source('renderComparisonPrint'), /renderCalculationTrace|renderSwitchBreakdown|officeInternalMemo|customerComment|sourceText/);
});

test('[r28印刷04] 長い確認事項を省略・切詰めず残し、HTML文字を安全に表示する', () => {
  const h = harness(['renderComparisonPrint']);
  const longNote = '確認事項の詳細。'.repeat(200) + '末尾も保持';
  h.calc.assumptions.push(['未確認事項', longNote]);
  h.calc.methods[0].reason = '<img src=x onerror=alert(1)>照合が必要';
  h.context.renderComparisonPrint(h.calc, null, '', '');
  const markup = h.element('comparisonPrintContent').innerHTML;
  assert.ok(markup.includes(longNote));
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;照合が必要/);
  assert.doesNotMatch(markup, /<img/);
  assert.doesNotMatch(source('renderComparisonPrint'), /\.slice\(|\.substring\(/);
});

test('[第2次印刷04] CSV元期間・補正範囲・確認事項は専用欄に一度だけ残す', () => {
  const h = harness(['renderComparisonPrint']);
  const origin = 'CSVの取引日範囲：2025-01-15〜2025-02-15。試算対象：2028-01-01〜2028-12-31。';
  const recovery = '仮除外2明細、金額11,000円';
  const review = 'CSV返品の元取引税率は未確認';
  h.context.csvReviewNotice = () => review;
  h.calc.csvOriginText = origin;
  h.calc.csvRecoveryText = recovery;
  h.calc.unconfirmedItems = [origin, review, '資料照合が必要'];
  h.calc.assumptions = [
    ['課税期間','2028-01-01〜2028-12-31'],
    ['未確認事項',`${origin} / ${review} / 資料照合が必要`],
    ['CSV集計範囲',recovery], ['CSVの元期間',origin], ['明示1％CSVの計算前提',review]
  ];
  h.context.renderComparisonPrint(h.calc, {rows:[{key:'regular',reasons:[]}],notes:[origin,recovery,review]}, '', '');
  const markup = h.element('comparisonPrintContent').innerHTML;
  for(const fact of [origin,recovery,review]) assert.equal(markup.split(fact).length - 1, 1, fact);
  assert.match(markup,/資料照合が必要/);
});

test('[第3次印刷A] 同じ確認理由は未確認欄・方式・現行／1％理由から一度に集約し、異なる理由は残す', () => {
  const h = harness(['renderComparisonPrint']);
  const common = '基準期間の課税売上高が未確認です';
  const regular = '本則課税の仕入控除率が未確認です';
  const distinct = '現行税率の比較元資料が必要';
  h.calc.methods = ['regular','simplified','special2','special3'].map(key => ({
    key, calculationMethod:`${key}の計算方法`, reason:common,
    reasons:key === 'regular' ? [common,regular] : [common]
  }));
  h.context.METHOD_LABELS = {regular:'本則課税',simplified:'簡易課税',special2:'2割特例',special3:'3割特例'};
  h.calc.regular.unavailableReasons = [regular];
  h.calc.unconfirmedItems = [common,regular,'資料照合が必要'];
  h.calc.assumptions = [['未確認事項',`${common} / ${regular} / 資料照合が必要`]];
  const rows = h.calc.methods.map(method => ({key:method.key,reasons:[`1％試算：${common}。`,`現行税率：${common}`, ...(method.key === 'regular' ? [`現行税率：${regular}`,distinct] : [])]}));
  h.context.renderComparisonPrint(h.calc,{rows,notes:[common]},'', '');
  const markup = h.element('comparisonPrintContent').innerHTML;
  assert.equal(markup.split(common).length - 1,1,'基準期間の同一確認理由は1回');
  assert.equal(markup.split(regular).length - 1,1,'本則の同一確認理由は1回');
  assert.match(markup,/全方式：基準期間の課税売上高が未確認です/);
  assert.match(markup,/資料照合が必要/);
  assert.match(markup,new RegExp(distinct));
  assert.match(markup,/4期累計・追加費用・計算過程は対象外/);
});

test('[第3次印刷B/C] 専用帳票だけを合理的に圧縮し、7pt下限・複数ページ・白背景を維持する', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css,/\.comparison-print-table th,\.comparison-print-table td\{[^}]*padding:1\.2mm 1\.5mm/);
  assert.match(css,/#comparisonPrintContent\{[^}]*font-size:8\.5pt;line-height:1\.25/);
  assert.match(css,/\.comparison-print-facts>div\{[^}]*padding:\.6mm 0/);
  assert.match(css,/\.comparison-print-footer\{[^}]*margin-top:1\.5mm;padding-top:1mm/);
  assert.match(css,/@media print\{[\s\S]*?html,body\{background:#fff!important\}/);
  assert.match(css,/#comparisonPrintPage\{height:auto;min-height:0\}/);
  assert.match(source('fitComparisonPrint'),/7 \/ baseMinimumPt/);
  assert.match(source('fitComparisonPrint'),/attempt < 4/);
});

test('[第3次印刷D] 注記長44段階のDOM代替は7pt下限と複数ページ予告を保つ', () => {
  const h = harness(['fitComparisonPrint']);
  const page = h.element('comparisonPrintPage');
  const content = h.element('comparisonPrintContent');
  page.clientHeight = 1040; page.clientWidth = 718; content.scrollWidth = 700;
  let multipage = 0;
  for(let index = 0; index < 44; index++){
    content.scrollHeight = 700 + index * 36;
    h.context.fitComparisonPrint();
    assert.ok(Number(h.element('comparisonPrintReport').dataset.printMinimumFontPt) >= 7,`段階${index}`);
    assert.ok(Number(content.style.zoom) >= 0.875,`段階${index}`);
    if(Number(h.element('comparisonPrintReport').dataset.printPages) > 1) multipage++;
  }
  assert.ok(multipage > 0,'長文ケースは2ページ以上を許容する');
});

test('[第2次印刷01] 再印刷は等倍から測り直し、7pt未満へ縮めず複数ページを明示する', () => {
  const h = harness(['fitComparisonPrint']);
  const page = h.element('comparisonPrintPage');
  const content = h.element('comparisonPrintContent');
  page.clientHeight = 1000; page.clientWidth = 700;
  content.scrollHeight = 1800; content.scrollWidth = 900;
  content.style.zoom = '0.1';
  h.context.fitComparisonPrint();
  assert.equal(Number(content.style.zoom), 0.875);
  assert.equal(h.element('comparisonPrintReport').dataset.printMinimumFontPt, '7.00');
  assert.equal(h.element('comparisonPrintReport').dataset.printPages, 'unknown', '横幅不足を2ページ成功と誤認しない');
  assert.match(h.element('comparisonPrintFitNotice').textContent, /横幅/);
  assert.equal(h.element('comparisonPrintReport').classList.contains('is-measuring'), false);
  content.scrollHeight = 800; content.scrollWidth = 650;
  h.context.fitComparisonPrint();
  assert.equal(content.style.zoom, '1');
  assert.equal(h.element('comparisonPrintReport').dataset.printPages, '1');
  content.scrollHeight = 800; content.scrollWidth = 1400;
  h.context.fitComparisonPrint();
  assert.equal(Number(content.style.zoom), 0.875, '横長の数値だけのために7pt未満へ縮めない');
  assert.match(h.element('comparisonPrintFitNotice').textContent, /横幅/);
});

test('[第2次印刷02] 注記が縦方向だけ長い場合は7ptで止め、2ページ見込と末尾確認を示す', () => {
  const h = harness(['fitComparisonPrint']);
  const page = h.element('comparisonPrintPage');
  const content = h.element('comparisonPrintContent');
  page.clientHeight = 1040; page.clientWidth = 718;
  content.scrollHeight = 1900; content.scrollWidth = 700;
  h.context.fitComparisonPrint();
  assert.equal(Number(content.style.zoom), 0.875);
  assert.equal(h.element('comparisonPrintReport').dataset.printPages, '2');
  assert.equal(h.element('comparisonPrintReport').dataset.printMinimumFontPt, '7.00');
  assert.match(h.element('comparisonPrintFitNotice').textContent, /2ページ以上.*末尾/);
});

test('[第2次印刷03] 縮小後の実寸が再流動しても有限回で再測定・補正する', () => {
  const h = harness(['fitComparisonPrint']);
  const content = h.element('comparisonPrintContent');
  const page = h.element('comparisonPrintPage');
  page.clientHeight = 1040; page.clientWidth = 718;
  let measurements = 0;
  content.getBoundingClientRect = () => {
    measurements++;
    const zoom = Number(content.style.zoom);
    const height = zoom === 1 ? 1100 : zoom > 0.91 ? 1050 : 1000;
    return {top:0,left:0,bottom:height,right:700 * zoom};
  };
  h.context.fitComparisonPrint();
  assert.ok(measurements >= 3 && measurements <= 5, `測定回数=${measurements}`);
  assert.ok(Number(content.style.zoom) >= 0.875);
  assert.equal(h.element('comparisonPrintReport').dataset.printPages, '1');
});

test('[r28印刷06] 測定不能のときは不正な縮小率を適用せず、測定後の一時表示を解除する', () => {
  const h = harness(['fitComparisonPrint']);
  const page = h.element('comparisonPrintPage');
  const content = h.element('comparisonPrintContent');
  for(const invalid of [0, 1, 2, -1, NaN, Infinity]){
    page.clientHeight = invalid;
    content.style.zoom = '0.2';
    h.context.fitComparisonPrint();
    assert.equal(content.style.zoom, '1');
    assert.equal(h.element('comparisonPrintReport').classList.contains('is-measuring'), false);
  }
  page.clientHeight = 1000;
  Object.defineProperty(content, 'scrollHeight', { get(){
    assert.equal(content.style.zoom, '1', '再測定の前に等倍へ戻す');
    assert.equal(h.element('comparisonPrintReport').classList.contains('is-measuring'), true);
    throw new Error('measurement unavailable');
  } });
  assert.throws(() => h.context.fitComparisonPrint(), /measurement unavailable/);
  assert.equal(h.element('comparisonPrintReport').classList.contains('is-measuring'), false);
});

test('[r28印刷07] 2つの通常印刷ボタンとCtrl+Pはいずれも最新入力から帳票を準備する', () => {
  const h = harness(['fitComparisonPrint','prepareComparisonPrint','printMethodComparison','bindEvents']);
  h.context.bindEvents();
  for(const button of ['printBtn','printComparisonBtn']){
    h.actions.length = 0;
    h.context.document.body.dataset.printTarget = 'customer';
    h.element(button).listeners.click();
    assert.deepEqual(h.actions, ['calculate','render','print']);
    assert.equal(h.context.document.body.dataset.printTarget, undefined);
  }
  h.actions.length = 0;
  h.element('comparisonPrintContent').style.zoom = '0.3';
  h.windowListeners.beforeprint();
  assert.deepEqual(h.actions, ['calculate','render']);
  assert.notEqual(h.element('comparisonPrintContent').style.zoom, '0.3');
});

test('[r28印刷08] 顧客用の印刷は別ターゲットを維持し、印刷終了後は状態と縮小を解除する', () => {
  const h = harness(['fitComparisonPrint','prepareComparisonPrint','printMethodComparison','bindEvents']);
  h.context.bindEvents();
  h.element('printCustomerDecisionBtn').listeners.click();
  assert.equal(h.context.document.body.dataset.printTarget, 'customer');
  assert.deepEqual(h.actions, [['customer', h.context.latestCalculation.decision.customer], 'print']);
  h.actions.length = 0;
  h.windowListeners.beforeprint();
  assert.deepEqual(h.actions, [], '顧客印刷に方式別帳票の再計算や描画を混入させない');
  h.element('comparisonPrintContent').style.zoom = '0.4';
  h.windowListeners.afterprint();
  assert.equal(h.context.document.body.dataset.printTarget, undefined);
  assert.equal(h.element('comparisonPrintContent').style.zoom, '1');
});

test('[r28印刷09] 印刷CSSは専用A4帳票だけを表示し、画面側の入力・計算過程を印刷しない', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /@page\s*\{size:A4 portrait;margin:10mm\}/);
  assert.match(css, /#comparisonPrintPage\s*\{width:190mm;height:275mm\}/);
  assert.match(css, /@media print\{[\s\S]*?#comparisonPrintPage\{height:auto;min-height:0\}/, '複数ページが必要でも高さで切らない');
  assert.match(css, /\.comparison-print-table \.comparison-number\{white-space:normal;overflow-wrap:anywhere;word-break:break-word\}/, '長い金額も印刷で切らない');
  assert.match(css, /body:not\(\[data-print-target="customer"\]\) \.wrap > :not\(#comparisonPrintReport\)\{display:none!important\}/);
  assert.match(css, /body\[data-print-target="customer"\] \.wrap > :not\(#customerPrintReport\)\{display:none!important\}/);
  assert.match(css, /\.comparison-number\{[^}]*white-space:nowrap/);
  assert.match(css, /#methodComparisonTable td\[data-column="current"\]\{font-size:16px/);
  assert.match(css, /#methodComparisonTable td\.num\{[^}]*font-size:20px/);
  for(const rule of [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => /comparisonPrint|comparison-print/.test(match[1]))){
    assert.doesNotMatch(rule[2], /overflow(?:-y)?:hidden|line-clamp|text-overflow:ellipsis/, '印刷は説明を切り落として1ページ化しない');
  }
  assert.equal((html.match(/id="comparisonPrintReport"/g) || []).length, 1);
  assert.equal((html.match(/id="printComparisonBtn"/g) || []).length, 1);
});
