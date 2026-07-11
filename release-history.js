(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiRelease = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const RELEASE_HISTORY = Object.freeze([
    Object.freeze({
      version:'r13',
      date:'2026-07-11',
      title:'4期最適化の届出経路と判定前提を改善',
      category:'calculation',
      recalcRecommended:true,
      changes:Object.freeze([
        '2割・3割適用中に将来の簡易課税選択届出を行う経路を4期最適化へ追加',
        '当期の簡易課税不適用届出と将来届出の期限確認を分離',
        '1年未満の課税期間における5億円判定用課税売上高の年換算を追加',
        '調整対象固定資産100万円以上の別途制限と期首棚卸資産調整の注意を追加',
        '消費税率の前提を標準10％・軽減8％と明示'
      ])
    }),
    Object.freeze({
      version:'r12',
      date:'2026-07-11',
      title:'詳細試算と4期累計最適化を追加',
      category:'calculation',
      recalcRecommended:true,
      changes:Object.freeze([
        '簡易課税の届出経路と原則2年継続を反映した4期累計最適化を追加',
        '課税売上割合、全額控除要件、個別対応方式、一括比例配分方式の詳細試算を追加',
        '高額特定資産等の金額・資産区分による段階式判定補助を追加',
        '税率別課税標準、国税・地方税の申告書段階の端数処理を追加',
        '通常画面の入力数を増やさず、必要な案件だけ詳細項目を表示'
      ])
    }),
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
    '4期試算は現在の売上・仕入構成が続く仮定です。実際の届出提出日、過去の適用履歴、将来の取引予測は原資料で確認してください。',
    '課税売上割合に準ずる割合、非課税資産の輸出、特定課税仕入れ等がある場合は個別確認が必要です。',
    '自己建設高額特定資産、棚卸資産調整、居住用賃貸建物、相続・合併等は判定補助にとどまり、自動確定しません。',
    '申告書端数処理は入力済み集計額による試算です。返品、貸倒れ、中間納付、旧税率、請求書単位の積上げ計算等は別途確認してください。'
  ]);

  const APP_META = Object.freeze({
    name:'消費税課税方式検討ツール（所内での一次試算用）',
    audience:'税理士等の専門家向け一次試算',
    version:RELEASE_HISTORY[0].version,
    updatedAt:RELEASE_HISTORY[0].date,
    lawBasisDate:'2026-07-11',
    lawBasisLabel:'2026年7月11日時点（国税庁公表資料ベース）',
    latestReleaseTitle:RELEASE_HISTORY[0].title
  });

  return Object.freeze({ RELEASE_HISTORY, DEFERRED_LIMITATIONS, APP_META });
});
