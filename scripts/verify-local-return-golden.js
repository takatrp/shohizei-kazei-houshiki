'use strict';

// Local-only verification. Never copies, writes, logs or fixtures the source CSV.
const fs = require('node:fs');
const journal = require('../journal-csv.js');
const returns = require('../tax-return-engine.js');
const {rowsFromJournalAnalysis} = require('../tax-entry-csv.js');

function argument(name){
  const position = process.argv.indexOf(name);
  return position < 0 ? '' : process.argv[position + 1] || '';
}
const csvPath = argument('--csv');
const adjustmentText = argument('--adjust10');
const exclusions = process.argv.flatMap((value,index) => value === '--exclude' ? [process.argv[index + 1] || ''] : []);
if(!csvPath || !/^[+-]?\d+$/.test(adjustmentText)){
  console.error('Usage: node scripts/verify-local-return-golden.js --csv <local path> --adjust10 <signed integer yen> [--exclude <record:side> ...]');
  process.exit(2);
}
const adjustment = Number(adjustmentText);
if(!Number.isSafeInteger(adjustment)) throw new TypeError('調整額は安全な整数円で指定してください。');
const decoded = journal.decodeCsvBytes(fs.readFileSync(csvPath));
const before = journal.analyzeTkcJournalText(decoded.text);
const decisions = {};
for(const locator of exclusions){
  const [record,side] = locator.split(':');
  const match = before.problemEntries.find(item => String(item.row) === record && item.side === side);
  if(!match || !['借方','貸方'].includes(side)) throw new Error('除外指定が未処理明細と一致しません。');
  decisions[match.id] = {action:'confirmedExclude',reason:'元帳・申告書照合のうえ明示除外'};
}
const analysis = journal.analyzeTkcJournalText(decoded.text,decisions);
const resolved = journal.resolveImportValues(analysis,{}, {allowUnclassifiedSales:true,allowReturnOnlySales:true});
if(!resolved.ready){
  console.error(JSON.stringify({errorCount:resolved.errors.length,
    unresolved:analysis.recoverySummary.unresolvedCount,
    unclassified:analysis.unclassifiedSales.length,
    negativeAggregate:Boolean(analysis.negativeAggregateError),
    categories:resolved.errors.map(error => error.includes('事業区分') ? 'business' :
      error.includes('マイナス') ? 'negative' : error.includes('判定できません') ? 'classification' : 'other')},null,2));
  throw new Error('CSVの行反映に未解決の集計があります。');
}
const rows = rowsFromJournalAnalysis(analysis,resolved);
const built = returns.aggregateReturnRows(rows,{
  knownNonTaxableZero:analysis.nonTaxableSales === 0,
  unsupportedCodes:(analysis.unsupportedEntries || []).map(item => item.code),
  unresolvedCount:analysis.recoverySummary.unresolvedCount,
  temporaryExcludedCount:analysis.recoverySummary.temporaryExcludedCount
});
if(built.reasons.length) throw new Error(`行入力の再集計が未完了: ${built.reasons.join(' / ')}`);
const input = built.input;
input.invoiceByUse.taxableOnly['10'] += adjustment;
const result = returns.calculateCurrentLawReturn(input,'individual');
if(!result.complete){
  console.error(`申告書再現は未完了: ${result.reasons.join(' / ')}`);
  process.exit(1);
}
const actual = {
  '付表2-3①B':result.schedule23.fields['①B'],
  '付表2-3⑦C':result.schedule23.fields['⑦C'],
  '付表2-3⑨B':result.schedule23.fields['⑨B'],
  '付表2-3㉖C':result.schedule23.fields['㉖C'],
  '付表1-3①B':result.schedule13.fields['①B'],
  '付表1-3②B':result.schedule13.fields['②B'],
  '付表1-3④C':result.schedule13.fields['④C'],
  '付表1-3⑤B':result.schedule13.fields['⑤B'],
  '付表1-3⑨C':result.schedule13.fields['⑨C'],
  '付表1-3⑬C':result.schedule13.fields['⑬C'],
  '第一表当期税額':result.mainReturn.totalBeforeInterim
};
const expected = {
  '付表2-3①B':546123667,'付表2-3⑦C':557089282,'付表2-3⑨B':284161210,'付表2-3㉖C':21773615,
  '付表1-3①B':546150000,'付表1-3②B':42599700,'付表1-3④C':21773615,'付表1-3⑤B':2090,
  '付表1-3⑨C':20823900,'付表1-3⑬C':5873400,'第一表当期税額':26697300
};
const comparisons = Object.entries(expected).map(([field,want]) => ({field,expected:want,actual:actual[field],difference:actual[field] - want}));
console.log(JSON.stringify({rawPurchase10:before.invoicePurchases['10'],adjustment,adjustedPurchase10:result.schedule23.fields['⑨B'],
  unresolved:analysis.recoverySummary.unresolvedCount,confirmedExcluded:analysis.recoverySummary.confirmedExcludedCount,comparisons},null,2));
if(comparisons.some(item => item.difference !== 0)) process.exit(1);
