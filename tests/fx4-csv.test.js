'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const journal = require('../journal-csv.js');
const cash = require('../cash-journal.js');

// Entirely synthetic transactions. Only export column names mirror FX4.
const headers = ['月日','伝番','証番','税','業','小切手NO','借方CD','借方補助','借方科目名','借方口座名',
  '貸方CD','貸方補助','貸方科目名','貸方口座名','取引金額','税率','内、消費税等','税抜き金額','取引先CD',
  '取引先名（仕入先の氏名又は名称）','実際の仕入れ年月日（期間）','元帳摘要（仕入れ資産等の総称）','収支','内訳',
  '受注番号','Ｒ－Ｎｏ．','入力日','自動仕訳番号','入力者ID','承認者ID','プロジェクト','予定日',
  '借方内訳CD１','借方内訳CD２','貸方内訳CD１','貸方内訳CD２','借方内訳CD３','借方内訳CD４',
  '貸方内訳CD３','貸方内訳CD４','証','取引年月日','控','適格請求書発行事業者'];
const cell = value => `"${String(value ?? '').replace(/"/g,'""')}"`;
function build(rows, columns = headers){
  return [columns,...rows.map(row => columns.map(h=>row[h] ?? ''))].map(row=>row.map(cell).join(',')).join('\r\n');
}
function entry(overrides = {}){
  return {'月日':'* 4. 1','税':'5','業':'','借方CD':'5111','借方科目名':'仕入高','貸方CD':'1111',
    '貸方科目名':'現金','取引金額':'1,100','税率':'10.0%A','内、消費税等':'100','税抜き金額':'1,000',
    '取引年月日':'20260401','控':'',...overrides};
}
function analyze(rows, columns){ return journal.analyzeTkcJournalText(build(rows,columns)); }

test('FX4の44列・税込共通金額を一度だけ集計し、実日付・摘要・控除割合を引き継ぐ', () => {
  const text = build([
    entry({'税':'1','業':'2','借方科目名':'現金','貸方科目名':'売上高','取引金額':'11,000'}),
    entry(),
    entry({'税':'52','税率':'軽 8.0%A','取引金額':'1,080','内、消費税等':'80','控':'80%',
      '元帳摘要（仕入れ資産等の総称）':'匿名の例, "確認"\r\n二行目'})
  ]);
  const result = journal.analyzeTkcJournalText(text);
  assert.equal(result.rowCount,3);
  assert.equal(result.salesByType.type2['10'],11000);
  assert.equal(result.invoicePurchases['10'],1100);
  assert.equal(result.exemptPurchases['80']['8'],1080);
  assert.equal(result.stats.mappedEntries,3);
  assert.deepEqual(result.dateRange,{start:'2026-04-01',end:'2026-04-01'});
  assert.equal(result.monthlyDateUnknownEntryCount,0);
  assert.equal(result.recoverySummary.unresolvedCount,0);
  assert.deepEqual(result.errors,[]);
  const normalized = journal.rowsToObjects(journal.parseCsv(text));
  assert.equal(normalized[2]['摘要'],'匿名の例, "確認"\r\n二行目');
  assert.equal(normalized[2].__recordNumber,4);
  assert.equal(normalized[0]['借方課税区分'],'0');
  assert.equal(normalized[0]['貸方課税区分'],'1');
});

test('FX4の売上返還・仕入返還と負数を貸借方向と合わせて一度だけ反映する', () => {
  const result = analyze([
    entry({'税':'1','業':'2','取引金額':'11000'}),
    entry({'税':'1','業':'2','取引金額':'-1100'}),
    entry({'税':'11','業':'2','取引金額':'550'}),
    entry({'取引金額':'2200'}), entry({'税':'51','取引金額':'220'}),
    entry({'税':'52','控':'80%','取引金額':'1100'}), entry({'税':'53','控':'80%','取引金額':'110'})
  ]);
  assert.equal(result.salesByType.type2['10'],9350);
  assert.equal(result.returnSales.returnGross['10'],550);
  assert.equal(result.invoicePurchases['10'],1980);
  assert.equal(result.exemptPurchases['80']['10'],990);
  assert.equal(result.recoverySummary.nettedExemptAdjustmentCount,1);
});

test('FX4の仕入用途区分・非課税売上を保持する', () => {
  const result = analyze([
    entry({'税':'3','税率':'','取引金額':'300'}), entry({'税':'31','税率':'','取引金額':'30'}),
    ...['5','6','7'].map(税=>entry({税})), ...['52','62','72'].map(税=>entry({税,'控':'50%'}))
  ]);
  assert.equal(result.nonTaxableSales,270);
  for(const usage of ['taxableOnly','nonTaxableOnly','common']){
    assert.equal(result.purchaseAmountsByUse[usage].invoice['10'],1100);
    assert.equal(result.purchaseAmountsByUse[usage].exempt['50']['10'],1100);
  }
});

test('FX4の既知未対応区分は要確認に残し、未知区分は行番号つきで停止する', () => {
  const result = analyze(['4','55','75'].map(税=>entry({税})));
  assert.deepEqual(result.unsupportedEntries.map(x=>x.code),['4']);
  assert.equal(result.recoverySummary.unresolvedCount,1);
  assert.equal(result.importEntries.length,2);
  assert.ok(result.importEntries.every(row=>row.importComponent===''));
  assert.equal(result.stats.mappedEntries,2);
  assert.equal(journal.resolveImportValues(result).ready,false);
  for(const 税 of ['99','?','','9']){
    assert.throws(()=>analyze([entry({税})]),/FX4 CSV 2行目: 課税区分/);
  }
});

test('FX4の未判定税率・控除割合・不正金額は補正対象として残る', () => {
  const result = analyze([
    entry({'税率':'8.0%'}), entry({'税率':'10.0%Z'}), entry({'税':'52','控':'?'}),
    entry({'取引金額':'不明'})
  ]);
  assert.deepEqual(result.problemEntries.map(p=>p.reasonCodes),[['rate'],['rate'],['creditRatio'],['amount']]);
  assert.equal(result.recoverySummary.unresolvedCount,4);
  assert.equal(result.stats.mappedEntries,0);
  const problem = result.problemEntries[0];
  const corrected = journal.analyzeTkcJournalText(build([entry({'税率':'8.0%'})]),{
    [problem.id]:{action:'correct',overrides:{rate:'8'}}
  });
  // Content-bound decisions from a different file must not be reused.
  assert.equal(corrected.recoverySummary.unresolvedCount,1);
  const sameFile = analyze([entry({'税率':'8.0%'})]);
  const fixed = journal.analyzeTkcJournalText(build([entry({'税率':'8.0%'})]),{
    [sameFile.problemEntries[0].id]:{action:'correct',overrides:{rate:'8'}}
  });
  assert.equal(fixed.invoicePurchases['8'],1100);
});

test('FX4の合計行・不正日付・重複列・列数不整合・不足列を集計しない', () => {
  assert.throws(()=>analyze([entry(),{'月日':'合計','取引金額':'2200','税':'0'}]),/3行目.*合計行/);
  assert.throws(()=>analyze([entry({'月日':'当月合計','取引年月日':'20260430','税':'0'})]),/2行目.*合計行/);
  assert.throws(()=>analyze([entry({'取引年月日':'20260230'})]),/取引年月日/);
  assert.throws(()=>analyze([entry()],headers.filter(h=>h!=='控')),/必須列.*控/);
  assert.throws(()=>analyze([entry()],[...headers,'税']),/重複/);
  assert.throws(()=>journal.analyzeTkcJournalText(build([entry()])+',"余分"'),/列数/);
  assert.throws(()=>analyze([entry()],[...headers,'借方取引金額']),/混在/);
});

test('FX4のCSVは列順・余分な列・UTF-8 BOMを許容し、事業区分空欄を推測しない', () => {
  const result = journal.analyzeTkcJournalText('\uFEFF'+build([entry({'税':'1'})],[...headers].reverse()));
  assert.equal(result.unclassifiedSales.length,1);
  assert.equal(result.unclassifiedSales[0].amounts['10'],1100);
  assert.equal(result.salesByType.type1['10'],0);
  for(const bom of ['', '\uFEFF']){
    const decoded = journal.decodeCsvBytes(Buffer.from(bom+build([entry()])));
    assert.equal(journal.analyzeTkcJournalText(decoded.text).invoicePurchases['10'],1100);
  }
  // Minimal Shift_JIS bytes for 月日. The full private customer file is never a fixture.
  assert.deepEqual(journal.decodeCsvBytes(Uint8Array.from([0x8c,0x8e,0x93,0xfa])),{text:'月日',encoding:'Shift_JIS'});
});

test('FX4の現預金集計も同じ正規化を使い、税込金額と符号・実日付を保持する', () => {
  const result = cash.analyzeCashJournalText(build([
    entry({'借方科目名':'現金','貸方科目名':'売上高','税':'1','取引金額':'11000'}), entry(),
    entry({'税':'51','取引金額':'-220'}), entry({'税':'0','元帳摘要（仕入れ資産等の総称）':'開始残高'})
  ]));
  assert.equal(result.rowCount,4);
  assert.equal(result.rows[0].debitAmount.value,11000);
  assert.equal(result.rows[0].creditAmount.value,11000);
  assert.equal(result.rows[1].debitAmount.value,1100);
  assert.equal(result.rows[2].creditAmount.value,-220);
  assert.equal(result.rows[0].date,'2026-04-01');
  assert.equal(result.openingCandidates.length,1);
});

test('従来の貸借別CSVは追加の共通列があっても既存の集計を維持する', () => {
  const columns = [...journal.REQUIRED_HEADERS,'税','取引金額'];
  const text = build([{'月日':'2026/04/01','借方科目名':'仕入高','借方課税区分':'5','借方税率':'10',
    '借方軽減税率か否か':'0','借方取引金額':'1100','貸方科目名':'現金','貸方取引金額':'1100','税':'99','取引金額':'999'}],columns);
  assert.equal(journal.analyzeTkcJournalText(text).invoicePurchases['10'],1100);
  assert.equal(cash.analyzeCashJournalText(text).rows[0].debitAmount.value,1100);
});
