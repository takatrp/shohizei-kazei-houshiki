'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_HEADERS,
  parseCsv,
  decodeCsvBytes,
  analyzeTkcJournalText,
  resolveImportValues,
  prepareEstimatedImport
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

function recoveryFixture(extra = []){
  return buildCsv([
    entry('貸方',{code:'1',business:'2',rate:10,reduced:0,amount:1100000}),
    entry('借方',{code:'5',rate:10,reduced:0,amount:110000}),
    entry('借方',{code:'5',rate:'?',reduced:1,amount:11000}), ...extra
  ]);
}

test('[C02-C04 C10 C16] 補正と仮除外は同一原文から再集計し対照CSVと一致する', () => {
  const text = recoveryFixture();
  const before = analyzeTkcJournalText(text);
  const id = before.problemEntries[0].id;
  assert.equal(before.problemEntries.length,1);
  assert.equal(resolveImportValues(before).ready,false);
  const decision = {[id]:{action:'correct',overrides:{rate:'10'}}};
  const corrected = analyzeTkcJournalText(text,decision);
  const control = analyzeTkcJournalText(text.replace(',1,?,11000,',',0,10,11000,'));
  assert.deepEqual(corrected.purchaseAmountsByUse,control.purchaseAmountsByUse);
  assert.equal(corrected.invoicePurchases['10'],121000);
  assert.equal(corrected.purchaseTaxByUse.taxableOnly,11000);
  assert.equal(100000-corrected.purchaseTaxByUse.taxableOnly,89000);
  assert.deepEqual(analyzeTkcJournalText(text,decision),corrected);
  const excluded = analyzeTkcJournalText(text,{[id]:{action:'exclude'}});
  assert.equal(excluded.invoicePurchases['10'],110000);
  assert.equal(100000-excluded.purchaseTaxByUse.taxableOnly,90000);
  assert.equal(excluded.recoverySummary.excludedAbsAmount,11000);
  assert.equal(excluded.recoverySummary.temporaryExcludedCount,1);
  assert.equal(excluded.recoverySummary.directionalTotals.invoicePurchase,11000);
  assert.equal(resolveImportValues(excluded).ready,true);
  assert.equal(analyzeTkcJournalText(text).problemEntries[0].status,'unresolved');
});

test('[C05 C06] 18件の区分9を構造化し一括除外しても正常分と補正分を保持する', () => {
  const text = recoveryFixture(Array.from({length:18},()=>entry('借方',{code:'9',amount:100})));
  const initial = analyzeTkcJournalText(text);
  assert.equal(initial.problemEntries.length,19);
  const decisions = Object.fromEntries(initial.problemEntries.map((item,i)=>[item.id,i===0?{action:'correct',overrides:{rate:'10'}}:{action:'exclude'}]));
  const result = analyzeTkcJournalText(text,decisions);
  assert.equal(result.recoverySummary.correctedCount,1);
  assert.equal(result.recoverySummary.temporaryExcludedCount,18);
  assert.equal(result.recoverySummary.excludedAbsAmount,1800);
  assert.equal(result.invoicePurchases['10'],121000);
  assert.equal(resolveImportValues(result).ready,true);
});

test('[C07 C11] 不明分類の補正は用途別免税割合・非課税分母・事業区分へ一度だけ反映する', () => {
  const text = buildCsv([
    entry('借方',{code:'9',amount:1100}),entry('貸方',{code:'9',amount:2200}),entry('貸方',{code:'9',amount:300})
  ]);
  const initial = analyzeTkcJournalText(text);
  const options = [
    {category:'exemptPurchase',usage:'common',rate:'10',creditRatio:'80'},
    {category:'sales',rate:'10',businessType:'type3'},
    {category:'nonTaxableSales'}
  ];
  const decisions = Object.fromEntries(initial.problemEntries.map((item,i)=>[item.id,{action:'correct',overrides:options[i]}]));
  const result = analyzeTkcJournalText(text,decisions);
  assert.equal(result.exemptPurchases['80']['10'],1100);
  assert.equal(result.exemptTransactionCount,1);
  assert.equal(result.purchaseTaxByUse.common,80);
  assert.equal(result.invoicePurchases['10'],0);
  assert.equal(result.salesByType.type3['10'],2200);
  assert.equal(result.nonTaxableSales,300);
  assert.equal(result.recoverySummary.correctedCount,3);
  delete decisions[initial.problemEntries[1].id].overrides.businessType;
  const unmapped = analyzeTkcJournalText(text,decisions);
  assert.equal(unmapped.unclassifiedSales.length,1);
  assert.equal(resolveImportValues(unmapped).ready,false);
});

test('[C08 C09 C14] 借貸別に除外し金額と税率の複合問題を一明細として扱う', () => {
  const text = buildCsv([{...entry('借方',{code:'5',rate:'?',amount:'不明'}),...entry('貸方',{code:'1',business:'2',rate:10,reduced:0,amount:1100})}]);
  const initial = analyzeTkcJournalText(text);
  assert.deepEqual(initial.problemEntries[0].reasonCodes,['amount','rate']);
  const id=initial.problemEntries[0].id;
  const excluded=analyzeTkcJournalText(text,{[id]:{action:'exclude'}});
  assert.equal(excluded.recoverySummary.unknownAmountCount,1);
  assert.equal(excluded.recoverySummary.temporaryExcludedCount,1);
  assert.equal(excluded.salesByType.type2['10'],1100);
  assert.equal(excluded.recoverySummary.excludedAbsAmount,0);
  const corrected=analyzeTkcJournalText(text,{[id]:{action:'correct',overrides:{rate:'10',amount:'0'}}});
  assert.equal(corrected.recoverySummary.correctedCount,1);
  const blank=analyzeTkcJournalText(text,{[id]:{action:'correct',overrides:{rate:'10',amount:''}}});
  assert.equal(blank.recoverySummary.unresolvedCount,1);
});

test('[C11 C12] 率だけの補正は用途・免税割合・返品区分を維持し明示1％経路へ入る', () => {
  const text=buildCsv([
    entry('借方',{code:'52',rate:1,reduced:1,credit:80,amount:2020}),
    entry('貸方',{code:'53',rate:'?',reduced:0,credit:80,amount:1010})
  ]);
  const id=analyzeTkcJournalText(text).problemEntries[0].id;
  const result=analyzeTkcJournalText(text,{[id]:{action:'correct',overrides:{rate:'1',category:'invoicePurchase',usage:'common',creditRatio:'50'}}});
  assert.equal(result.exemptPurchases['80']['1'],1010);
  assert.equal(result.purchaseTaxByUse.taxableOnly,8);
  assert.equal(result.actualOnePercentEntries[1].transactionKind,'adjustment');
  assert.equal(result.actualOnePercentEntries[1].taxCode,'53');
  const excluded=analyzeTkcJournalText(text,{[id]:{action:'exclude'}});
  assert.equal(excluded.actualOnePercentEntries.length,1);
});

test('[C15] 相殺除外の件数・絶対値と純額を区別し負バケットは停止する', () => {
  const text=buildCsv([entry('借方',{code:'5',rate:'?',amount:110}),entry('貸方',{code:'51',rate:'?',amount:110})]);
  const problems=analyzeTkcJournalText(text).problemEntries;
  const excluded=analyzeTkcJournalText(text,Object.fromEntries(problems.map(item=>[item.id,{action:'exclude'}])));
  assert.equal(excluded.recoverySummary.temporaryExcludedCount,2);
  assert.equal(excluded.recoverySummary.excludedAbsAmount,220);
  assert.equal(excluded.recoverySummary.directionalTotals.invoicePurchase,0);
  const negative=analyzeTkcJournalText(text,{[problems[0].id]:{action:'exclude'},[problems[1].id]:{action:'correct',overrides:{rate:'10'}}});
  assert.equal(negative.invoicePurchases['10'],-110);
  assert.equal(resolveImportValues(negative).ready,false);
});

test('[C17 C18 C21] 内容別ID・CSVレコード位置・構造不良と正常行編集拒否', () => {
  const text=recoveryFixture().replace('\r\n','\r\n\r\n');
  const initial=analyzeTkcJournalText(text);
  assert.equal(initial.problemEntries[0].row,5);
  const id=initial.problemEntries[0].id;
  const other=analyzeTkcJournalText(text.replace('11000','22000'),{[id]:{action:'exclude'}});
  assert.equal(other.recoverySummary.unresolvedCount,1);
  assert.equal(other.recoverySummary.temporaryExcludedCount,0);
  const confirmed=analyzeTkcJournalText(text,{[id]:{action:'confirmedExclude',reason:''}});
  assert.equal(confirmed.recoverySummary.unresolvedCount,1);
  assert.equal(analyzeTkcJournalText(text,{[id]:{action:'confirmedExclude',reason:'対象期間外'}}).recoverySummary.confirmedExcludedCount,1);
  assert.throws(()=>analyzeTkcJournalText(`${text},extra`),/列数/);
  assert.throws(()=>parseCsv('a,b\n"bad"oops,x'),/引用符/);
  const normalId=id.replace(':5:',':3:').replace('借方','貸方');
  assert.equal(analyzeTkcJournalText(text,{[normalId]:{action:'exclude'}}).salesByType.type2['10'],1100000);
});

test('[C16] 売上科目の対応キーは他の補正科目が増えても安定する', () => {
  const text=buildCsv([entry('貸方',{account:'乙',code:'1',rate:10,reduced:0,amount:110}),entry('貸方',{account:'甲',code:'9',amount:220})]);
  const initial=analyzeTkcJournalText(text);
  const result=analyzeTkcJournalText(text,{[initial.problemEntries[0].id]:{action:'correct',overrides:{category:'sales',rate:'10'}}});
  assert.equal(result.unclassifiedSales.find(item=>item.accountName==='乙').key,initial.unclassifiedSales[0].key);
});

test('[C12 C15] 純額ゼロの明示1％売上も全件維持し科目対応を実績へ適用する', () => {
  const text = buildCsv([
    entry('貸方',{account:'食品売上',code:'9',amount:1010}),
    entry('借方',{account:'食品売上',code:'11',rate:1,reduced:1,amount:1010})
  ]);
  const initial = analyzeTkcJournalText(text);
  const result = analyzeTkcJournalText(text,{[initial.problemEntries[0].id]:{action:'correct',overrides:{category:'sales',rate:'1'}}});
  assert.equal(result.unclassifiedSales.length,1);
  assert.equal(result.unclassifiedSales[0].amounts['1'],0);
  assert.equal(result.actualOnePercentEntries.length,2);
  assert.equal(resolveImportValues(result).ready,false);
  const resolved = resolveImportValues(result,{[result.unclassifiedSales[0].key]:'type2'});
  assert.equal(resolved.ready,true);
  assert.equal(resolved.actualOnePercentEntries.length,2);
  assert.ok(resolved.actualOnePercentEntries.every(item=>item.businessType==='type2'));
  assert.ok(resolved.actualOnePercentEntries.every(item=>!Object.hasOwn(item,'mappingKey')));
  assert.equal(resolved.actualOnePercentEntries[1].transactionKind,'adjustment');
  assert.deepEqual(result.unsupportedEntries,[]);
});

test('[C15] 合計が正でも負の用途別仕入・未分類売上バケットを隠さない', () => {
  const invoice = analyzeTkcJournalText(buildCsv([
    entry('借方',{code:'5',rate:10,reduced:0,amount:1100}),
    entry('貸方',{code:'71',rate:10,reduced:0,amount:110})
  ]));
  assert.equal(invoice.invoicePurchases['10'],990);
  assert.equal(invoice.purchaseAmountsByUse.common.invoice['10'],-110);
  assert.equal(resolveImportValues(invoice).ready,false);
  assert.match(invoice.errors.join(' '),/共通対応/);
  const exempt = analyzeTkcJournalText(buildCsv([
    entry('借方',{code:'52',rate:10,reduced:0,amount:1100,credit:80}),
    entry('貸方',{code:'73',rate:10,reduced:0,amount:110,credit:80})
  ]));
  assert.equal(exempt.exemptPurchases['80']['10'],990);
  assert.equal(resolveImportValues(exempt).ready,false);
  const sales = analyzeTkcJournalText(buildCsv([
    entry('貸方',{account:'通常売上',code:'1',rate:10,reduced:0,amount:1100,business:'2'}),
    entry('借方',{account:'返品',code:'11',rate:10,reduced:0,amount:110})
  ]));
  assert.equal(sales.unclassifiedSales[0].amounts['10'],-110);
  assert.match(sales.errors.join(' '),/未分類売上/);
});

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
  assert.deepEqual(result.invoicePurchases, { '10':990, '8':108, '1':0 });
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
  assert.deepEqual(result.invoicePurchases, { '10':0, '8':0, '1':0 });
  assert.equal(result.unsupportedEntries.length, 1);
  assert.equal(result.unsupportedEntries[0].code, '55');
});

test('必須列が不足するCSVは取り込まない', () => {
  assert.throws(
    () => analyzeTkcJournalText('月日,借方科目名\n2026/01/01,現金'),
    /必須列が不足/
  );
});

test('[U02] 明示された1％取引を8％へ補完せず別区分で保持する', () => {
  const result = analyzeTkcJournalText(buildCsv([
    entry('貸方', { account:'食品売上', code:'1', business:'2', reduced:'1', rate:'1', amount:1010 }),
    entry('借方', { account:'食品仕入', code:'5', reduced:'1', rate:'1', amount:505 })
  ]));
  assert.equal(result.salesByType.type2['1'], 1010);
  assert.equal(result.salesByType.type2['8'], 0);
  assert.equal(result.invoicePurchases['1'], 505);
  assert.equal(result.invoicePurchases['8'], 0);
  const resolved = resolveImportValues(result);
  assert.equal(resolved.values.salesByType.type2['1'], 1010);
  assert.equal(resolved.values.invoicePurchases['1'], 505);
  assert.equal(result.actualOnePercentEntries.length, 2);
  assert.deepEqual(result.actualOnePercentEntries.map(item => item.kind), ['sale','invoicePurchase']);
  assert.ok(result.actualOnePercentEntries.every(item => item.ratePercent === 1 && item.amountMode === 'included' && item.source === 'csvActual'));
});

test('[A01][A03] 免税仕入なしと返品による純額0を件数で区別する', () => {
  const none = analyzeTkcJournalText(buildCsv([
    entry('貸方', { account:'売上', code:'1', business:'2', rate:'8', reduced:'1', amount:1080 })
  ]));
  assert.equal(none.exemptTransactionCount, 0);
  const returned = analyzeTkcJournalText(buildCsv([
    entry('借方', { account:'免税仕入', code:'52', rate:'10', amount:1100, credit:80 }),
    entry('貸方', { account:'免税仕入返品', code:'53', rate:'10', amount:1100, credit:80 })
  ]));
  assert.equal(returned.exemptPurchases['80']['10'], 0);
  assert.equal(returned.exemptTransactionCount, 2);
});

test('免税仕入の値引き・返品は同じ課税区分・税率・控除割合へ符号付きで差引き、概算前提の件数と金額を残す', () => {
  const source = buildCsv([
    entry('借方',{code:'52',rate:'10',reduced:0,amount:110000,credit:80}),
    entry('貸方',{code:'52',rate:'10',reduced:0,amount:10000,credit:80}),
    entry('貸方',{code:'53',rate:'10',reduced:0,amount:5000,credit:80})
  ]);
  const analysis = analyzeTkcJournalText(source);
  assert.equal(resolveImportValues(analysis).ready,true);
  assert.equal(analysis.exemptPurchases['80']['10'],95000);
  assert.equal(analysis.purchaseAmountsByUse.taxableOnly.exempt['80']['10'],95000);
  assert.equal(analysis.recoverySummary.nettedExemptAdjustmentCount,2);
  assert.equal(analysis.recoverySummary.nettedExemptAdjustmentAbsAmount,15000);
  assert.equal(analysis.problemEntries.length,0,'正常な返品・値引きに補正操作を要求しない');
});

test('[F05] 正常な売上と返品の相殺0円は区分・税率ごとの有効明細2件として保持する', () => {
  const result = analyzeTkcJournalText(buildCsv([
    entry('貸方', {code:'1', business:'2', rate:10, reduced:0, amount:1100000}),
    entry('借方', {code:'11', business:'2', rate:10, reduced:0, amount:1100000}),
    entry('借方', {code:'5', rate:10, reduced:0, amount:550000})
  ]));
  assert.equal(result.salesByType.type2['10'], 0);
  assert.equal(result.salesEntryCountsByTypeRate.type2['10'], 2);
  assert.equal(result.salesEntryCountsByTypeRate.type2['8'], 0);
  const resolved = resolveImportValues(result);
  assert.equal(resolved.ready, true);
  assert.equal(resolved.values.salesByType.type2['10'], 0);
  assert.equal(resolved.values.salesEntryCountsByTypeRate.type2['10'], 2);
});

test('[F05] 売上明細なし・全除外・未読は取込済みでも確認済みの売上0円にしない', () => {
  const purchaseOnly = analyzeTkcJournalText(buildCsv([
    entry('借方', {code:'5', rate:10, reduced:0, amount:550000})
  ]));
  assert.equal(purchaseOnly.salesEntryCountsByTypeRate.type2['10'], 0);
  assert.equal(resolveImportValues(purchaseOnly).values.salesEntryCountsByTypeRate.type2['10'], 0);
  const unreadText = buildCsv([entry('貸方', {code:'1', business:'2', rate:10, reduced:0, amount:'不明'})]);
  const unread = analyzeTkcJournalText(unreadText);
  assert.equal(unread.salesEntryCountsByTypeRate.type2['10'], 0);
  const excluded = analyzeTkcJournalText(unreadText, {
    [unread.problemEntries[0].id]:{action:'exclude'}
  });
  assert.equal(excluded.salesEntryCountsByTypeRate.type2['10'], 0);
  assert.equal(resolveImportValues(excluded).values.salesEntryCountsByTypeRate.type2['10'], 0);
  assert.throws(() => analyzeTkcJournalText(REQUIRED_HEADERS.join(',')), /仕訳データ/);
});

test('[F05] 複数区分・税率の返品相殺と未分類売上の手動対応でも既知0円を移送する', () => {
  const mixed = analyzeTkcJournalText(buildCsv([
    entry('貸方', {code:'1', business:'2', rate:10, reduced:0, amount:1100}),
    entry('借方', {code:'11', business:'2', rate:10, reduced:0, amount:1100}),
    entry('貸方', {code:'1', business:'2', rate:8, reduced:1, amount:1080}),
    entry('借方', {code:'11', business:'2', rate:8, reduced:1, amount:1080}),
    entry('貸方', {code:'1', business:'3', rate:10, reduced:0, amount:3300}),
    entry('借方', {code:'11', business:'3', rate:10, reduced:0, amount:3300})
  ]));
  assert.equal(mixed.salesEntryCountsByTypeRate.type2['10'], 2);
  assert.equal(mixed.salesEntryCountsByTypeRate.type2['8'], 2);
  assert.equal(mixed.salesEntryCountsByTypeRate.type3['10'], 2);
  assert.equal(mixed.salesEntryCountsByTypeRate.type4['10'], 0);

  const unmapped = analyzeTkcJournalText(buildCsv([
    entry('貸方', {account:'対応待ち売上', code:'1', rate:10, reduced:0, amount:1100}),
    entry('借方', {account:'対応待ち売上', code:'11', rate:10, reduced:0, amount:1100})
  ]));
  assert.equal(unmapped.unclassifiedSales.length, 1);
  assert.equal(unmapped.unclassifiedSales[0].amounts['10'], 0);
  assert.equal(unmapped.unclassifiedSales[0].entryCounts['10'], 2);
  const resolved = resolveImportValues(unmapped, {[unmapped.unclassifiedSales[0].key]:'type4'});
  assert.equal(resolved.ready, true);
  assert.equal(resolved.values.salesEntryCountsByTypeRate.type4['10'], 2);
  assert.equal(resolved.values.salesByType.type4['10'], 0);
});

test('[F04] 元CSV全体と補正・除外後の有効明細で異なる取引日範囲を保持する', () => {
  const source = buildCsv([
    {...entry('貸方', {code:'1', business:'2', rate:10, reduced:0, amount:1100000}), 月日:'2025/01/15'},
    {...entry('借方', {code:'5', rate:'?', reduced:0, amount:550000}), 月日:'2025/02/15'},
    {...entry('借方', {code:'5', rate:'?', reduced:0, amount:77000}), 月日:'2027/03/15'}
  ]);
  const initial = analyzeTkcJournalText(source);
  assert.deepEqual(initial.dateRange, {start:'2025-01-15', end:'2027-03-15'});
  assert.deepEqual(initial.effectiveDateRange, {start:'2025-01-15', end:'2025-01-15'});
  const [corrected, excluded] = initial.problemEntries;
  const changed = analyzeTkcJournalText(source, {
    [corrected.id]:{action:'correct', overrides:{rate:'10'}},
    [excluded.id]:{action:'exclude'}
  });
  assert.deepEqual(changed.dateRange, {start:'2025-01-15', end:'2027-03-15'});
  assert.deepEqual(changed.effectiveDateRange, {start:'2025-01-15', end:'2025-02-15'});
  const resolved = resolveImportValues(changed);
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.values.dateRange, changed.dateRange);
  assert.deepEqual(resolved.values.effectiveDateRange, changed.effectiveDateRange);
  assert.equal(resolved.values.salesByType.type2['10'], 1100000);
  assert.equal(resolved.values.invoicePurchases['10'], 550000);
});

test('[A05][A07] 明示1％・8％・10％混在を元税率で別保持する', () => {
  const lines = [
    { ...entry('貸方', { account:'食品売上', code:'1', business:'2', rate:'1', reduced:'1', amount:1010000 }), 月日:'2028/01/15' },
    { ...entry('貸方', { account:'8％売上', code:'1', business:'2', rate:'8', reduced:'1', amount:1080000 }), 月日:'2028/01/16' },
    { ...entry('貸方', { account:'10％売上', code:'1', business:'4', rate:'10', amount:1100000 }), 月日:'2028/01/17' },
    { ...entry('借方', { account:'1％仕入', code:'5', rate:'1', reduced:'1', amount:505000 }), 月日:'2028/01/18' },
    { ...entry('借方', { account:'免税1％仕入', code:'52', rate:'1', reduced:'1', amount:101000, credit:50 }), 月日:'2028/01/19' }
  ];
  const result = analyzeTkcJournalText(buildCsv(lines));
  assert.equal(result.salesByType.type2['1'], 1010000);
  assert.equal(result.salesByType.type2['8'], 1080000);
  assert.equal(result.salesByType.type4['10'], 1100000);
  assert.equal(result.invoicePurchases['1'], 505000);
  assert.equal(result.exemptPurchases['50']['1'], 101000);
  assert.equal(result.actualOnePercentEntries.length, 3);
  assert.equal(result.actualOnePercentEntries[0].date, '2028-01-15');
});

test('[A07] 明示税率が不正なら軽減フラグへフォールバックしない', () => {
  const result = analyzeTkcJournalText(buildCsv([
    entry('貸方', { account:'売上', code:'1', business:'2', reduced:'1', rate:'不明', amount:1080 })
  ]));
  assert.equal(result.salesByType.type2['8'], 0);
  assert.equal(result.stats.invalidEntries, 1);
  assert.match(result.errors.join(' '), /税率/);
});

test('[E01] 正常CSVの概算準備は厳密取込と同じ数値を返す', () => {
  const text = buildCsv([
    entry('貸方',{code:'1',business:'2',rate:10,reduced:0,amount:1100000}),
    entry('借方',{code:'5',rate:10,reduced:0,amount:110000}),
    entry('借方',{code:'72',rate:8,reduced:1,credit:80,amount:10800})
  ]);
  const result = prepareEstimatedImport(text);
  assert.deepEqual(result.resolved,resolveImportValues(analyzeTkcJournalText(text)));
  assert.equal(result.recoverySummary.assumedDetailCount,0);
  assert.equal(result.recoverySummary.assumedBusinessCount,0);
  assert.equal(result.recoverySummary.negativeBucketCount,0);
  assert.equal(result.recoverySummary.temporaryExcludedCount,0);
});

test('[E02] 未選択売上区分だけを第6種と仮定し売上全額と手動対応を残す', () => {
  const text = buildCsv([
    entry('貸方',{account:'未選択',code:'1',rate:10,amount:1100000}),
    entry('貸方',{account:'選択済み',code:'1',rate:8,reduced:1,amount:108000})
  ]);
  const strict = analyzeTkcJournalText(text);
  const key = strict.unclassifiedSales.find(group => group.accountName==='選択済み').key;
  const mappings = {[key]:'type2'};
  const result = prepareEstimatedImport(text,{},mappings);
  assert.equal(result.resolved.ready,true);
  assert.equal(result.resolved.values.salesByType.type6['10'],1100000);
  assert.equal(result.resolved.values.salesByType.type2['8'],108000);
  assert.equal(result.recoverySummary.assumedBusinessCount,1);
  assert.equal(result.recoverySummary.assumedBusinessAmount,1100000);
  assert.equal(result.recoverySummary.temporaryExcludedCount,0);
  assert.equal(resolveImportValues(strict,mappings).ready,false);
  assert.deepEqual(mappings,{[key]:'type2'});
});

test('[E03] 税率と免税控除割合を保守的に仮定し重複件数を増やさない', () => {
  const text = buildCsv([
    entry('借方',{code:'52',rate:'?',amount:11000,credit:''}),
    entry('借方',{code:'7',rate:'不明',reduced:1,amount:10800})
  ]);
  const result = prepareEstimatedImport(text);
  assert.equal(result.resolved.ready,true);
  assert.equal(result.resolved.values.exemptPurchases['0']['10'],11000);
  assert.equal(result.resolved.values.taxableOnlyPurchaseTax,0);
  assert.equal(result.resolved.values.invoicePurchases['8'],10800);
  assert.equal(result.resolved.values.commonPurchaseTax,800);
  assert.equal(result.recoverySummary.assumedRate10Count,1);
  assert.equal(result.recoverySummary.assumedRate10Amount,11000);
  assert.equal(result.recoverySummary.assumedRate8Count,1);
  assert.equal(result.recoverySummary.assumedCreditCount,1);
  assert.equal(result.recoverySummary.assumedCreditAmount,11000);
  assert.equal(result.recoverySummary.assumedDetailCount,2);
  assert.equal(result.recoverySummary.correctedCount,0);
  assert.equal(resolveImportValues(analyzeTkcJournalText(text)).ready,false);
});

test('[E04] 金額・区分が不明な片側だけを除外し正常な反対側を残す', () => {
  const text = buildCsv([
    {...entry('借方',{code:'5',rate:10,amount:'不明'}),...entry('貸方',{code:'1',business:'2',rate:10,amount:110000})},
    entry('借方',{code:'9',rate:10,amount:1100})
  ]);
  const result = prepareEstimatedImport(text);
  assert.equal(result.resolved.ready,true);
  assert.equal(result.resolved.values.salesByType.type2['10'],110000);
  assert.equal(result.recoverySummary.temporaryExcludedCount,2);
  assert.equal(result.recoverySummary.unknownAmountCount,1);
  assert.equal(result.recoverySummary.excludedAbsAmount,1100);
  assert.equal(result.recoverySummary.assumedDetailCount,0);
  assert.equal(result.analysis.unsupportedEntries.length,0);
});

test('[E05] 手動補正と除外を保持し仮定結果を元の判断へ書き戻さない', () => {
  const text = buildCsv([
    entry('借方',{code:'52',rate:'?',amount:'不明',credit:''}),
    entry('借方',{code:'9',rate:'?',amount:1100}),
    entry('借方',{code:'5',rate:'?',amount:11000}),
    entry('借方',{code:'5',rate:'?',amount:22000})
  ]);
  const problems = analyzeTkcJournalText(text).problemEntries;
  const decisions = {
    [problems[0].id]:{action:'correct',overrides:{amount:'10800',rate:'8',creditRatio:'50'}},
    [problems[1].id]:{action:'correct',overrides:{category:'invoicePurchase',usage:'common',rate:'10'}},
    [problems[2].id]:{action:'confirmedExclude',reason:'対象外'},
    [problems[3].id]:{action:'exclude'}
  };
  const before = JSON.stringify(decisions);
  const result = prepareEstimatedImport(text,decisions);
  assert.equal(result.resolved.ready,true);
  assert.equal(result.resolved.values.exemptPurchases['50']['8'],10800);
  assert.equal(result.resolved.values.taxableOnlyPurchaseTax,400);
  assert.equal(result.resolved.values.commonPurchaseTax,100);
  assert.equal(result.recoverySummary.correctedCount,2);
  assert.equal(result.recoverySummary.confirmedExcludedCount,1);
  assert.equal(result.recoverySummary.temporaryExcludedCount,1);
  assert.equal(result.recoverySummary.assumedDetailCount,0);
  assert.equal(JSON.stringify(decisions),before);
  assert.deepEqual(prepareEstimatedImport(text,decisions),result);
});

test('[E06] 1％は明示実績だけを保持し不明税率から新たに作らない', () => {
  const text = buildCsv([
    entry('貸方',{code:'1',business:'2',rate:1,reduced:0,amount:1010}),
    entry('貸方',{code:'1',business:'2',rate:'?',reduced:1,amount:1080}),
    entry('貸方',{code:'1',business:'2',rate:'0.01',amount:1100})
  ]);
  const result = prepareEstimatedImport(text);
  assert.equal(result.resolved.ready,true);
  assert.deepEqual(result.resolved.values.salesByType.type2,{'1':1010,'8':1080,'10':1100});
  assert.equal(result.resolved.actualOnePercentEntries.length,1);
  assert.equal(result.resolved.actualOnePercentEntries[0].source,'csvActual');
  assert.equal(result.recoverySummary.assumedRate1Count,1);
  assert.equal(result.recoverySummary.assumedRate8Count,1);
  assert.equal(result.recoverySummary.assumedRate10Count,1);
});

test('[E07] 負の用途別仕入をゼロ仮定し全体額と用途別控除税額を整合させる', () => {
  const text = buildCsv([
    entry('借方',{code:'5',rate:10,amount:1100}),
    entry('貸方',{code:'71',rate:10,amount:110}),
    entry('借方',{code:'52',rate:8,reduced:1,credit:80,amount:1080}),
    entry('貸方',{code:'73',rate:8,reduced:1,credit:80,amount:108})
  ]);
  const strict = analyzeTkcJournalText(text);
  const before = JSON.stringify(strict);
  const result = prepareEstimatedImport(text);
  assert.equal(result.resolved.ready,true);
  assert.equal(result.resolved.values.invoicePurchases['10'],1100);
  assert.equal(result.resolved.values.exemptPurchases['80']['8'],1080);
  assert.equal(result.resolved.values.taxableOnlyPurchaseTax,164);
  assert.equal(result.resolved.values.commonPurchaseTax,0);
  assert.equal(result.analysis.purchaseAmountsByUse.common.invoice['10'],0);
  assert.equal(result.analysis.purchaseAmountsByUse.common.exempt['80']['8'],0);
  assert.equal(result.recoverySummary.negativeBucketCount,2);
  assert.equal(result.recoverySummary.negativeAbsAmount,218);
  assert.deepEqual(result.recoverySummary.negativeBuckets,[{kind:'invoicePurchase',rate:'10',amount:-110},{kind:'exemptPurchase',rate:'8',amount:-108}]);
  assert.equal(JSON.stringify(strict),before);
  assert.equal(resolveImportValues(strict).ready,false);
});

test('[E08] 負の事業別・未分類売上と非課税売上を明示的なゼロ仮定として記録する', () => {
  const text = buildCsv([
    entry('借方',{code:'11',business:'2',rate:10,amount:110}),
    entry('借方',{account:'未分類返品',code:'11',rate:8,reduced:1,amount:108}),
    entry('借方',{code:'31',amount:500})
  ]);
  const result = prepareEstimatedImport(text);
  assert.equal(result.resolved.ready,true);
  assert.equal(result.resolved.values.salesByType.type2['10'],0);
  assert.equal(result.resolved.values.salesByType.type6['8'],0);
  assert.equal(result.resolved.values.nonTaxableSales,0);
  assert.equal(result.recoverySummary.negativeBucketCount,3);
  assert.equal(result.recoverySummary.negativeAbsAmount,718);
  assert.equal(result.recoverySummary.assumedBusinessAmount,108);
  assert.ok(result.recoverySummary.negativeBuckets.every(item=>Object.keys(item).sort().join(',')==='amount,kind,rate'));
});

test('[E10] 取消済みの1％・分類・金額補正を概算準備で復活させない', () => {
  const text = buildCsv([entry('借方',{code:'52',rate:10,reduced:0,amount:1100,credit:''})]);
  const id = analyzeTkcJournalText(text).problemEntries[0].id;
  for(const action of ['', 'confirmedExclude']){
    const decisions = {[id]:{action,overrides:{rate:'1',creditRatio:'80',amount:'999999',category:'sales'}}};
    const result = prepareEstimatedImport(text,decisions);
    assert.equal(result.resolved.values.exemptPurchases['0']['10'],1100);
    assert.equal(result.resolved.actualOnePercentEntries.length,0);
    assert.equal(result.recoverySummary.assumedRate1Count,0);
    assert.equal(result.recoverySummary.assumedCreditCount,1);
    assert.equal(decisions[id].overrides.rate,'1');
  }
});

test('[E09] 負の明示1％実績を消さず未解決のままにし構造不良も停止する', () => {
  const text = buildCsv([
    entry('貸方',{code:'51',rate:1,reduced:1,amount:101}),
    entry('貸方',{code:'71',rate:10,amount:110}),
    entry('借方',{code:'5',rate:1,reduced:1,amount:50})
  ]);
  const result = prepareEstimatedImport(text);
  assert.equal(result.resolved.ready,false);
  assert.equal(result.resolved.values.invoicePurchases['1'],-51);
  assert.equal(result.resolved.actualOnePercentEntries.length,2);
  assert.equal(result.resolved.actualOnePercentEntries[0].amount,-101);
  assert.equal(result.recoverySummary.negativeBucketCount,1);
  assert.match(result.resolved.errors.join(' '),/明示1％/);
  assert.throws(()=>prepareEstimatedImport('月日,借方科目名\n2026/01/01,現金'),/必須列/);
  assert.throws(()=>prepareEstimatedImport(text+',extra'),/列数/);
});
