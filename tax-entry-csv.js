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

  function row(id, code, amount, {businessType = '', rate = '', creditRatio = '', provenance = null} = {}){
    return {id, code, businessType, rate, amount:String(safeAmount(amount)), foodAmount:'', creditRatio, source:'csv',
      ...(provenance ? {
        sourceDateStart:provenance.sourceDateStart,
        sourceDateEnd:provenance.sourceDateEnd,
        sourceAdjustmentCount:provenance.sourceAdjustmentCount,
        sourceDateUnknownCount:provenance.sourceDateUnknownCount
      } : {})};
  }

  function saleProvenance(analysis,values,code,rate,businessType=''){
    const groups=Array.isArray(analysis.dailyGroups)&&analysis.dailyGroups.length ? analysis.dailyGroups : analysis.monthlyGroups;
    if(!Array.isArray(groups)) return null;
    // Mapping an account to a business type happens after the anonymous
    // daily/monthly summaries were made. If that mapping absorbed an
    // unclassified adjustment, preserve the warning on the affected mapped
    // rate group rather than silently treating its signed net as ordinary.
    const mapped=businessType && safeAmount(values.salesEntryCountsByTypeRate?.[businessType]?.[rate])
      > safeAmount(analysis.salesEntryCountsByTypeRate?.[businessType]?.[rate]);
    const matches=groups.filter(group=>group.kind==='sales' && String(group.code)===code
      && String(group.rate)===rate && (String(group.businessType||'')===businessType
        || mapped && !group.businessType && (group.transactionKind==='adjustment'||Number(group.amount)<0)));
    if(!matches.length) return null;
    const dates=matches.filter(group=>/^\d{4}-\d{2}-\d{2}$/.test(String(group.date||''))).map(group=>group.date).sort();
    return {sourceDateStart:dates[0]||'',sourceDateEnd:dates.at(-1)||'',
      // These are anonymous aggregate groups, so the count is a nonzero
      // provenance signal, not a claim about the original journal row count.
      sourceAdjustmentCount:matches.filter(group=>group.transactionKind==='adjustment'||Number(group.amount)<0).length,
      sourceDateUnknownCount:matches.filter(group=>!group.date&&!group.month).length};
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
        const net = safeAmount(values.salesByType?.[businessType]?.[rate]);
        const returned = safeAmount(values.returnGrossByType?.[businessType]?.[rate]);
        const amount = net + returned;
        const count = safeAmount(values.salesEntryCountsByTypeRate?.[businessType]?.[rate]);
        // A return and sale may cancel exactly: a known zero is still input.
        if(amount !== 0 || count > 0){
          sales.push(row(`csv-sale-1-${businessType}-${rate}`, '1', amount, {businessType, rate,
            provenance:saleProvenance(analysis,values,'1',rate,businessType)}));
        }
        if(returned !== 0) sales.push(row(`csv-sale-11-${businessType}-${rate}`, '11', returned, {businessType, rate,
          provenance:saleProvenance(analysis,values,'11',rate,businessType)}));
      }
    }
    // Keep unmapped sales visibly unknown, but combine account-level groups
    // for STEP2 by code and rate. Account mappings and monthly evidence remain
    // in the resolved/parser data; a sale and its return stay separate rows.
    for(const rate of RATES){
      let amount = 0;
      let returned = 0;
      let count = 0;
      for(const group of resolved.unclassifiedSales || []){
        const groupReturn = safeAmount(group.returnGross?.[rate]);
        amount += safeAmount(group.amounts?.[rate]) + groupReturn;
        returned += groupReturn;
        count += safeAmount(group.entryCounts?.[rate]);
      }
      if(amount !== 0 || count > 0){
        sales.push(row(`csv-sale-1-unclassified-${rate}`, '1', amount, {rate,
          provenance:saleProvenance(analysis,values,'1',rate)}));
      }
      if(returned !== 0) sales.push(row(`csv-sale-11-unclassified-${rate}`, '11', returned, {rate,
        provenance:saleProvenance(analysis,values,'11',rate)}));
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
            const provenance = analysis.exemptPurchaseProvenanceByUse?.[usage]?.[creditRatio]?.[rate];
            if(!provenance) throw new TypeError(`CSVの免税仕入日付情報がありません: ${usage}/${creditRatio}/${rate}`);
            purchases.push(row(`csv-purchase-${codes.exempt}-${creditRatio}-${rate}`, codes.exempt, amount, {rate, creditRatio, provenance}));
          }
        }
      }
    }
    // The existing import sidecar is the only source for 1% actuals. They
    // must not become ordinary forecast rows or be added to 8% amounts.
    const actualOnePercentEntries = (resolved.actualOnePercentEntries || analysis.actualOnePercentEntries || [])
      .map(({accountName, mappingKey, ...entry}) => ({...entry}));
    const imports=new Map();
    for(const entry of analysis.importEntries || []){
      const key=[entry.code,entry.rate,entry.importComponent||'unknown'].join('-');
      const current=imports.get(key)||{...entry,id:'csv-import-'+key,amount:'0',sourceCount:0,foodAmount:'',creditRatio:'',businessType:''};
      current.amount=String(safeAmount(current.amount)+safeAmount(entry.amount));current.sourceCount++;
      current.importAssumed ||= entry.importAssumed;
      if(entry.importRule&&!String(current.importRule||'').includes(entry.importRule))current.importRule=[current.importRule,entry.importRule].filter(Boolean).join('／');
      if(entry.importAssumed)current.importBasis='candidate';
      if(current.sourceCount>1){current.sourceRow=null;current.sourceImportTax='複数行';current.sourceImportNet='複数行';}
      imports.set(key,current);
    }
    purchases.push(...imports.values());
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

