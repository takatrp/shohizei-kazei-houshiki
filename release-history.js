(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiRelease = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const RELEASE_HISTORY = Object.freeze([
    Object.freeze({
      version:'r11',
      date:'2026-07-11',
      title:'判定の安全性と計算精度を改善',
      category:'calculation',
      recalcRecommended:true,
      changes:Object.freeze([
        '0円を有効な入力として扱うよう修正',
        '売上ゼロ・仕入ありの本則課税による還付試算に対応',
        '簡易課税の1事業・2事業の75％特例に対応',
        '適用要件を確認済み候補・要確認・適用不可に区分',
        '4期比較を各期単独比較と明確化',
        '将来期の免税事業者仕入控除割合を日数按分へ変更',
        '入力値の端末保存を任意選択へ変更',
        'コピー・CSV・印刷へ前提条件と未確認事項を追加'
      ])
    })
  ]);

  const DEFERRED_LIMITATIONS = Object.freeze([
    '4年間の届出選択経路と簡易課税の2年継続を反映した累計最適化には未対応です。',
    '課税売上割合・個別対応方式・一括比例配分方式の完全計算には未対応です。',
    '調整対象固定資産、高額特定資産、居住用賃貸建物等の完全判定には未対応です。',
    '端数処理を含む申告書レベルの厳密計算には未対応です。'
  ]);

  const APP_META = Object.freeze({
    name:'消費税課税方式検討ツール',
    audience:'税理士等の専門家向け一次試算',
    version:RELEASE_HISTORY[0].version,
    updatedAt:RELEASE_HISTORY[0].date,
    lawBasisDate:'2026-06-10',
    lawBasisLabel:'2026年6月10日時点（国税庁 令和8年度税制改正特集ベース）',
    latestReleaseTitle:RELEASE_HISTORY[0].title
  });

  return Object.freeze({ RELEASE_HISTORY, DEFERRED_LIMITATIONS, APP_META });
});
