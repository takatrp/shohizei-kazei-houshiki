(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiTaxEntryCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const BUSINESS_TYPES = ['type1','type2','type3','type4','type5','type6'];
  const RATES = ['10','8'];
  const RATIOS = ['80','70','50','30','0'];
  const CODES_BY_USAGE = {
    taxableOnly:{ invoice:'5', exempt:'52' },
    nonTaxableOnly:{ invoice:'6', exempt:'62' },
    common:{ invoice:'7', exempt:'72' }
  };

  function safeAmount(value){
    const amount = Number(value ?? 0);
    if(!Number.isFinite(amount)) throw new TypeError('CSVの集計金額が有限数ではありません。');
    return amount;
  }

  function row(id, code, amount, {businessType = '', rate = '', creditRatio = ''} = {}){
    return {id, code, businessType, rate, amount:String(safeAmount(amount)), foodAmount:'', creditRatio, source:'csv'};
  }

  // The journal parser owns correction, exclusion, assumptions and signed
  // debit/credit aggregation. Convert only its *resolved* summary, never raw
  // journal lines or the legacy DOM totals (which have already lost usage).
  function rowsFromJournalAnalysis(analysis, resolved){
    if(!analysis || !resolved || resolved.ready === false || !resolved.values){
      throw new TypeError('反映可能なCSV集計結果が必要です。');
    }
    const values = resolved.values;
    const sales = [];
    const purchases = [];
    for(const businessType of BUSINESS_TYPES){
      for(const rate of RATES){
        const amount = safeAmount(values.salesByType?.[businessType]?.[rate]);
        const count = safeAmount(values.salesEntryCountsByTypeRate?.[businessType]?.[rate]);
        // A return and sale may cancel exactly: a known zero is still input.
        if(amount !== 0 || count > 0){
          sales.push(row(`csv-sale-1-${businessType}-${rate}`, '1', amount, {businessType, rate}));
        }
      }
    }
    const nonTaxableSales = safeAmount(values.nonTaxableSales);
    if(nonTaxableSales !== 0){
      sales.push(row('csv-sale-3', '3', nonTaxableSales));
    }
    for(const [usage, codes] of Object.entries(CODES_BY_USAGE)){
      const group = analysis.purchaseAmountsByUse?.[usage];
      if(!group) throw new TypeError(`CSVの仕入用途別集計がありません: ${usage}`);
      for(const rate of RATES){
        const amount = safeAmount(group.invoice?.[rate]);
        if(amount !== 0){
          purchases.push(row(`csv-purchase-${codes.invoice}-${rate}`, codes.invoice, amount, {rate}));
        }
      }
      for(const creditRatio of RATIOS){
        for(const rate of RATES){
          const amount = safeAmount(group.exempt?.[creditRatio]?.[rate]);
          if(amount !== 0){
            purchases.push(row(`csv-purchase-${codes.exempt}-${creditRatio}-${rate}`, codes.exempt, amount, {rate, creditRatio}));
          }
        }
      }
    }
    // The existing import sidecar is the only source for 1% actuals. They
    // must not become ordinary forecast rows or be added to 8% amounts.
    const actualOnePercentEntries = (resolved.actualOnePercentEntries || analysis.actualOnePercentEntries || [])
      .map(({accountName, mappingKey, ...entry}) => ({...entry}));
    return {
      sales,
      purchases,
      actualOnePercentEntries,
      // The current parser has no code/rate entry counts for purchases or
      // non-taxable sales. Zero aggregates cannot be assigned a code safely.
      unrecoverable:['zero-purchase-code-counts','zero-non-taxable-sales-count']
    };
  }

  return Object.freeze({rowsFromJournalAnalysis});
});
