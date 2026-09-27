'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('固定ステップ欄から利用マニュアルPDFを新しいタブで開ける', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sticky = html.match(/<div class="panel workflow-sticky no-print" id="workflowSticky">([\s\S]*?)<div class="screen-note" id="workflowStepSummary">/);
  assert.ok(sticky, '印刷対象外の固定ステップ欄が存在する');
  assert.match(sticky[1], /<a class="btn secondary workflow-manual-link" href="\.\/manual\/usage-manual\.pdf" target="_blank" rel="noopener" type="application\/pdf" aria-label="利用マニュアル（PDFを新しいタブで開く）">利用マニュアル<\/a>/);
  const pdf = fs.readFileSync(path.join(root, 'manual', 'usage-manual.pdf'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 100_000, '空のPDFを配布しない');
});
