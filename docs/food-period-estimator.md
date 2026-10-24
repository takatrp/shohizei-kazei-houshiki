# 食品対象期間額とCSV月別構成

`food-period-estimator.js` は、税額計算**前**に8％実績の食品内数のうち政策対象期間に属する金額を作る純粋関数です。税額計算済みの年額を月へ配る既存の `cashflow-adapter.js` とは役割が異なります。制度の成立を認定するものではなく、政策シナリオの期間・金額配分を扱います。

## 入出力と接続

ブラウザでは `tax-engine.js` の後にモジュールを読み込みます。

```js
const estimate = ShohizeiFoodPeriodEstimator.estimate({
  amount: foodInputAmount, // 税込の年間食品内数。manual時だけ対象期間額
  kind: 'sales',
  businessType: type.key, // 未分類売上は空文字
  rows: taxEntryRows,
  monthlyGroups: importedCsvMonthlyGroups,
  sourceFacts: sharedCaseFacts.csvSource,
  currentSourceId: importedCsvOriginalSourceId,
  currentAggregateId: importedCsvCashflowScopeKey,
  monthlyAggregateId: importedCsvCashflowScopeKey,
  dateUnknownCount: importedCsvMonthlyDateUnknownCount,
  periodStart: ctx.start,
  periodEnd: ctx.end,
  mode: ctx.foodForecastMethod
});
const foodOneOriginalAmount = estimate.amount;
```

元CSVの同一性は `currentSourceId`、補正後月別集計との対応は `currentAggregateId` と `monthlyAggregateId` で別々に検査します。月別集計が作られた時の集計IDを保持し、現在のIDと照合するのが標準接続です。同じ正式期間というだけでは一致しません。

`estimate()` は `{amount,method,label,reason,notes,monthly,parts,alreadyPeriodAmount:true}` を返します。`monthly` は政策対象額を対象期の月列で持つ税込・元価格の内数です。税額や価格換算は行いません。`amount:null` は未算定であり、0円へ補完しません。日数按分へのフォールバック理由は `reason` と `notes` に残ります。

集約経路では、売上は `businessType`、仕入は `purchaseKind:'invoice'|'exempt'`、免税仕入はさらに `creditRatio`、必要なら `usage` で抽出します。行計算の `aggregateScenarioPurchases` へは `row` 又は `rowId` を渡せます。単行結果の対象額を使用し、旧 `food.value * fraction` を重ねて適用しません。

8％の売上返還行（区分11）は元取引税率を保持するため、単行では常に対象額0円を返します。売上集約では通常取引の食品内数を別に集めてから呼び出してください。返品込みの差引食品額を通常取引の予測対象額と取り違えないためです。1％実績は既存サイドカーを使い、ここへ混ぜません。

## 採用根拠

| method | 意味 |
| --- | --- |
| `direct-food` | 同じ対象期の食品別月次集計を直接使用 |
| `prior-food` | 前年の食品別月次構成による予測 |
| `group-proxy` | 同じ対象期の食品を含む課税区分グループの構成を代理使用 |
| `prior-group-proxy` | 前年の課税区分グループの構成を代理使用 |
| `uniform` | 資料の安全条件を満たさず、理由付きで日数按分 |
| `manual` | 明示された対象期間額をそのまま使用 |
| `original-rate-return` | 元8％取引の返還として税率を保持 |
| `outside` | 食品1％政策期間との重なりがないため対象額0円 |
| `unavailable` | 金額又は期間が不正・未入力 |

現在の仕訳CSVパーサーには食品商品別の月次識別がないため、通常の既存CSVは `group-proxy` 又は `prior-group-proxy` です。食品実額とは表示しません。食品別資料が確定できる将来の入力経路では、同じ元資料の匿名月次集計を `foodMonthlyGroups` に渡せます。その場合も元グループの月額の内数・同符号かを検算します。

現在行の税込総額・食品内数・区分、税率、事業区分、用途、控除割合の対応が必要です。元CSV・正式期間・全月網羅の確認、取引日不明0件を共有状態から再利用し、新規の全員必須確認は設けません。行金額の修正で月次総額と合わなくなった部分は採用しません。

## 期間と符号

同じ対象期の月次実額は、短期・月途中開始終了にも対応します。月途中の政策境界は、その月の対象期内日数による概算です。日次実額の精度は主張しません。前年資料は開始・終了の月日と月数が同じ前年同月に限定し、決算期変更や別の短期、うるう日の端点が対応しない場合は日数按分へ戻します。暦年同士の前年対応では2月28日・29日の差を対象年の実際の日数で按分します。

正負が混在した部分食品グループや分母0円の部分食品は比率計算しません。全グループを食品と仮定する経路では月別の符号を直接保持し、年間差引0円でも売上と調整月を消しません。明示0円の食品内数（`foodAmountSource:'manual'`）は0円のままです。

## STEP4との共用

採用した `estimate` オブジェクトを再利用し、税込価格差だけを月次へ変換できます。

```js
const sales = ShohizeiFoodPeriodEstimator.transactionDeltas({
  estimates: salesPeriodEstimates,
  priceBasis: ctx.foodSalesPriceBasis,
  annualDelta: Math.round(calc.sales.totalAmount - current.sales.totalAmount)
});
```

税抜価格据置では元8％税込額の `-7/108`、税込価格据置では0円です。政策対象期間割合は再適用しません。年額と一致する通常の円丸め残差だけ最終の有額月へ置き、別の税額・古い期間・異なる前提による大きな差は `ready:false` で拒否します。`sales.monthly` / 仕入の同じ結果を `cashflow-adapter.create()` の既存 `transactionBasis.salesDeltas` / `purchaseDeltas` へ渡すことで、年税額と資金側が同じ対象期間額を共有できます。

輸入支出差や旧1％実績をここへ混ぜないでください。既存アダプターの輸入差額経路との二重計上を避ける必要があります。月次共有が未接続の場合、CSV対象期間推計の税額と旧日数配賦の組合せを「同じ構成」と表現しないでください。

## 検証

`node --test tests/food-period-estimator.test.js` は季節偏重、食品明細と代理グループの違い、同一資料と補正後集計IDの違い、明示手入力・0円、短期・月途中・うるう年、開始終了の端点、旧8％返品、年間差引0円、用途・控除割合の分離、税額と資金の円単位照合を確認します。実ブラウザ接続の検証は別途必要です。


追補: 日付不明の匿名集計が別の分類に特定できる時は、対応する食品行の月別構成を解除しない。同じ分類又は不明箇所を特定できない旧保存は、その食品部分だけ理由付き日数按分へ戻す。
