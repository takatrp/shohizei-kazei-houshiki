'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('入力欄では名称を主に、該当するTKC区分を補助バッジで表示する', () => {
  assert.match(html, /課税売上 <span class="tkc-badge">TKC 1<\/span>：下表の10％・軽8％売上/);
  assert.match(html, /<label for="nonTaxableSales">非課税売上等（税抜） <span class="tkc-badge">TKC 3<\/span><\/label>/);
  assert.match(html, /<label for="taxableOnlyPurchaseTax">課税売上対応の仕入税額 <span class="tkc-badge">TKC 5<\/span> <span class="tkc-badge">TKC 52<\/span><\/label>/);
  assert.match(html, /<label for="commonPurchaseTax">共通対応の仕入税額 <span class="tkc-badge">TKC 7<\/span> <span class="tkc-badge">TKC 72<\/span><\/label>/);
});

test('CSVの用途区分と税率・期間別の合計入力欄の対応を示す', () => {
  const invoiceGuide = html.match(/上の仕入金額は税率別の合計です。([\s\S]*?)<\/div>/)?.[1];
  const exemptGuide = html.match(/下の内訳は期間・税率別の合計です。([\s\S]*?)<\/div>/)?.[1];
  assert.ok(invoiceGuide);
  assert.ok(exemptGuide);
  for (const [guide, codes] of [[invoiceGuide, [5, 6, 7]], [exemptGuide, [52, 62, 72]]]) {
    for (const code of codes) assert.match(guide, new RegExp(`<span class="tkc-badge">TKC ${code}<\\/span>`));
    for (const use of ['課税売上対応', '非課税売上対応', '共通対応']) assert.ok(guide.includes(use));
  }
  assert.match(html, /body:not\(\[data-print-target="customer"\]\):not\(\[data-print-target="cashflow"\]\) \.wrap > :not\(#comparisonPrintReport\)\{display:none!important\}/);
  assert.match(html, /body\[data-print-target="customer"\] \.wrap > :not\(#customerPrintReport\)\{display:none!important\}/);
});
