'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_HEADERS,
  parseCsv,
  decodeCsvBytes,
  analyzeTkcJournalText,
  resolveImportValues
} = require('../journal-csv.js');

function csvCell(value){
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(entries){
  const rows = [REQUIRED_HEADERS, ...entries.map(entry => REQUIRED_HEADERS.map(header => entry[header] ?? ''))];
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function entry(side, values){
  return {
    月日:'2026/01/01',
    [`${side}科目名`]:values.account || '',
    [`${side}課税区分`]:values.code || '',
    [`${side}事業区分`]:values.business || '',
    [`${side}軽減税率か否か`]:values.reduced ?? '',
    [`${side}税率`]:values.rate ?? '',
    [`${side}取引金額`]:values.amount ?? '',
    [`${side}消費税等`]:values.tax ?? '',
    [`${side}控除割合`]:values.credit ?? ''
  };
}

test('引用符・カンマ・セル内改行・BOMを含むCSVを解析する', () => {
  const rows = parseCsv('\uFEFFA,B\r\n1,"二重""引用符,あり"\r\n2,"セル内\n改行"\r\n');
  assert.deepEqual(rows, [
    ['A','B'],
    ['1','二重"引用符,あり'],
    ['2','セル内\n改行']
  ]);
});

test('UTF-8 BOMとShift_JISを判定して復号する', () => {
  const utf8 = decodeCsvBytes(Buffer.from([0xEF, 0xBB, 0xBF, 0x41]));
  assert.equal(utf8.encoding, 'UTF-8 BOM');
  assert.equal(utf8.text, 'A');

  const shiftJis = decodeCsvBytes(Buffer.from([0x8C, 0x8E, 0x93, 0xFA]));
  assert.equal(shiftJis.encoding, 'Shift_JIS');
  assert.equal(shiftJis.text, '月日');
});

test('TKC課税区分、借貸、税率、事業区分、控除割合から必要額を集計する', () => {
  const csv = buildCsv([
    entry('貸方', { account:'売上高', code:'1', business:'5', reduced:'0', rate:'10', amount:'1,100' }),
    entry('借方', { account:'売上値引', code:'11', business:'5', reduced:'0', rate:'10', amount:110 }),
    entry('貸方', { account:'飲食収入', code:'1', reduced:'1', rate:'8', amount:108 }),
    entry('貸方', { account:'非課税収入', code:'3', amount:500 }),
    entry('借方', { account:'非課税売上返還', code:'31', amount:50 }),
    entry('借方', { account:'消耗品費', code:'5', reduced:'0', rate:'10', amount:1100, tax:100 }),
    entry('貸方', { account:'仕入値引', code:'51', reduced:'0', rate:'10', amount:110, tax:10 }),
    entry('借方', { account:'共通経費', code:'7', reduced:'1', rate:'8', amount:108, tax:8 }),
    entry('借方', { account:'免税仕入', code:'52', reduced:'0', rate:'10', amount:1100, tax:80, credit:80 }),
    entry('貸方', { account:'免税仕入返還', code:'53', reduced:'0', rate:'10', amount:110, tax:8, credit:80 }),
    entry('借方', { account:'保険料', code:'8', amount:1000 })
  ]);
  const result = analyzeTkcJournalText(csv);

  assert.equal(result.rowCount, 11);
  assert.equal(result.salesByType.type5['10'], 990);
  assert.equal(result.unclassifiedSales.length, 1);
  assert.equal(result.unclassifiedSales[0].accountName, '飲食収入');
  assert.equal(result.unclassifiedSales[0].amounts['8'], 108);
  assert.equal(result.nonTaxableSales, 450);
  assert.deepEqual(result.invoicePurchases, { '10':990, '8':108 });
  assert.equal(result.exemptPurchases['80']['10'], 990);
  assert.equal(result.purchaseTaxByUse.taxableOnly, 162);
  assert.equal(result.purchaseTaxByUse.common, 8);
  assert.deepEqual(result.errors, []);

  const unresolved = resolveImportValues(result, {});
  assert.equal(unresolved.ready, false);
  assert.match(unresolved.errors.join(' '), /飲食収入/);

  const resolved = resolveImportValues(result, { [result.unclassifiedSales[0].key]:'type4' });
  assert.equal(resolved.ready, true);
  assert.equal(resolved.values.salesByType.type4['8'], 108);
  assert.equal(resolved.values.salesByType.type5['10'], 990);
  assert.equal(resolved.values.taxableOnlyPurchaseTax, 162);
  assert.equal(resolved.values.commonPurchaseTax, 8);
});

test('未対応の輸入課税仕入は集計へ混ぜず注意対象にする', () => {
  const result = analyzeTkcJournalText(buildCsv([
    entry('借方', { account:'輸入仕入', code:'55', reduced:'0', rate:'10', amount:1100 })
  ]));
  assert.deepEqual(result.invoicePurchases, { '10':0, '8':0 });
  assert.equal(result.unsupportedEntries.length, 1);
  assert.equal(result.unsupportedEntries[0].code, '55');
});

test('必須列が不足するCSVは取り込まない', () => {
  assert.throws(
    () => analyzeTkcJournalText('月日,借方科目名\n2026/01/01,現金'),
    /必須列が不足/
  );
});
