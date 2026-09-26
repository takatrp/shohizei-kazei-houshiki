# 入力項目の必須・任意対応表

2026-09-26。`input-requirements.js` の `evaluate(context)` を表示と検証の共通判定とする。ここでの「必須」は**選択した操作・結果にその値が必要**という入力案内であり、制度上の適用確認ではない。初期値が入力済みでも必須表示を維持し、「未確認」を選べる確認項目を肯定回答に変えない。対象外セル、読取専用結果、ボタン、タブ、開閉、削除はバッジ対象外。各入力のバッジはラベル／グループ見出し／行セルに一度だけ表示し、顧客向け出力には入れない。

## 判定契約

`context` は `{values, comparisonMethods, entityType, individualYearApplies, taxScenario, step4Active, cashflowMode, interimMode, autoBasis, autoRequiresCorporateExtension, settlement, rows, recoveryEntries, csvApplying, csvRequireResolution, extraCostsEnabled}`。`values` はDOM id→現在値（チェックは真偽値）、`cashflowMode` は `rateImpact`／`methodImpact`、`settlement` は `{baseQ, changedQ}`（精算前の符号付き Q。未算定は `null`）とする。`rows` は現在の行データの `{sales,purchases}`。`recoveryEntries` はCSV補正明細の選択・上書き値を保持する。`evaluate` は `fields[id]`・`rows[side][index].fields[field]`・`recovery[index].fields[field]` に `visible, enabled, badge, requiredFor, reason, allowUnknown, emptyMeaning, pending` を返す。

`validate(evaluation, context, target)` は同じ判定結果から対象結果だけの不足を返す。`target` は `inputFlow`、`csvApply`、`regularTax`、`simplifiedTax`、`foodTax`、`rateCashflow`、`methodCashflow`、`extraCostResult`、`fourPeriod`。STEP4の不足はSTEP3の `regularTax`／`simplifiedTax` を停止しない。入力済み0円は空欄でない。入力した任意値の形式不正、制度適用の詳細判定、数値の大小や日付前後は既存の本番バリデーションで扱う。単一の `checkValidity()` で全画面を止めない。

以下の「標準／空欄」は既定値と未入力の意味。**未確認可**は空欄や `unknown` を確認済みに変換しないこと。通常ラベル右側、ラジオ・複数チェックはグループ見出し、行ごとに違う要否はセル付近、CSV補正は各明細フィールドのラベルに付ける。

## STEP1・対象期・方式

| 安定キー／DOM id（ラジオはグループ） | 表示・有効条件／必須先 | 標準／空欄・未確認 | 検証・テスト |
|---|---|---|---|
| `workflowPurpose`／`purposeRegular`, `purposeFoodSwitch` | 入口。任意 | 通常比較／追加費用比較を選ぶ導線 | BGC14, RQ20 |
| `entityType`／`entityIndividual`, `entityCorporation` | 常時必須 `inputFlow`。グループに一つ | 個人初期値。どちらか1つ必要 | BGC13, RQ03 |
| `periodStart`, `periodEnd` | 正式な対象期。必須 `inputFlow` | 画面初期日付。空欄は期間未設定。開始≤終了は既存 `validateTaxPeriod` | RQ03 |
| `individualYear` | 個人・通常暦年入力の場合に必須 `inputFlow`。法人・変則期間なら対象外 | 年から開始／終了へ連動。読取専用の日付を二重入力させない | RQ03 |
| `currentReturnMethod` | 常時任意 | `unknown`＝現在方式未確認。継続方式を推測しない | BGC20, RQ19 |
| `comparisonMethods`／`compareRegular`, `compareSimplified`, `compareSpecial2`, `compareSpecial3` | 常時グループ必須 `inputFlow`。1つ以上で成立 | 全方式選択不要。方法ごとの適用可否は別判定 | BGC01–03, RQ02–04 |
| `amountMode`／`modeTaxIncluded`, `modeTaxExcluded` | 常時グループ必須 `inputFlow` | 税込初期値。行入力は税込に固定 | RQ01 |
| `taxScenario`／`taxScenarioCurrent`, `taxScenarioFood1` | 常時グループ必須 `inputFlow` | 現行税率初期値。食品試算を強制しない | BGC16–17, RQ05 |
| `viewMode`／`viewModeSingle`, `viewModeProjection` | 任意 | 単期初期値。4期を選ぶと既存の届出・経路判定を利用 | RQ01 |
| `advancedMode`, `declarationRounding` | 任意 | 詳細表示／申告書段階計算条件。変更時のみ効果 | RQ01 |
| `saveToDevice` | 任意 | オフでも試算可能。オンの時だけ端末保存 | BGC14, RQ20–21 |

## STEP1の食品・適用確認と本則条件

| 安定キー／DOM id | 表示・有効条件／必須先 | 標準／空欄・未確認 | 検証・テスト |
|---|---|---|---|
| `foodForecastMethod`, `foodSalesPriceBasis`, `foodPurchasePriceBasis` | 食品1％試算時のみ必須 `foodTax` | 画面の既定仮定で進めるが確認済みではない | RQ05 |
| `proposalFoodClassificationState`, `proposalPurchaseClassificationState` | 食品試算時に任意の確認 | `unknown`を許す。食品区分の適用確認は別判定 | BGC20, RQ19 |
| `purchaseFood1`; `exemptPurchase${ratio}_1`（80/70/50/30/0） | 旧集計形式の食品内数。行入力では重複要求しない | 空欄は未確認、明示0円と区別 | RQ05 |
| `simpleElectionStatus`, `futureElectionPlan`, `currentDiscontinuanceReady` | 簡易課税を比較する場合に任意 | 届出履歴・計画は `unknown` 可。適用可否は既存判定 | RQ19 |
| `priorTaxMethod`, `electionFilingStatus`, `priorPeriodStart`, `priorPeriodEnd`, `electionFilingDate`, `electionAsOfDate`, `consumptionTaxExtension`, `confirmedReturnDeadline` | 簡易課税の期限確認時に使用。任意 | 空欄・未確認は期限未確定。肯定へ補完しない | V03回帰、RQ19 |
| `regularDetailMethod` | 本則課税比較時に必須 `regularTax` | 自動／一括／個別の選択。実際の控除は既存計算 | RQ04 |
| `nonTaxableSales`, `taxableOnlyPurchaseTax`, `commonPurchaseTax` | 本則の用途・課売割合確認時に使用。行入力では集計表示 | 空欄は0円ではなく未入力。必要に応じ結果を未算定 | RQ04 |
| `creditMode`／`creditModeUnknown`, `creditModeConfirmed`, `creditModeEstimate` | 本則結果の確認。未確認可 | `unknown`を許し概算率へ勝手に変更しない | RQ19 |
| `creditPercent` | `creditMode=estimate` のとき必須 `regularTax` | 空欄＝概算率未設定。0〜100等の範囲は既存検証 | RQ04 |
| `regularAdjustment` | 本則で任意 | 空欄は調整額の指定なし。入力時は既存の符号・根拠検証 | RQ19 |
| `purchase10`, `purchase8`, `exemptPurchase80_10/80_8`, `exemptPurchase70_10/70_8`, `exemptPurchase50_10/50_8`, `exemptPurchase30_10/30_8`, `exemptPurchase0_10/0_8`, `exemptPurchaseState` | 本則仕入の旧欄／状態。行入力では集計値。該当仕入があるときだけ確認 | 空欄は0円と区別。状態は未確認可 | RQ04 |
| `highAssetState`／3ラジオ、`highAssetAmount`, `highAssetType`, `highAssetSelfConstructed`, `baseTaxableSales`, `specificTaxableSales`, `specificPayrollAmount`, `invoiceRegisteredState`／3ラジオ, `invoiceTransitionState`／3ラジオ, `noSpecialExclusionState`／3ラジオ, `simpleNoticeReadyState`／3ラジオ | 制度適用の確認欄。原則任意。関連方式の算定・適用判定は既存結果単位で管理 | 不明は不明のまま。空欄を0円・なし・はいへ補完しない | BGC20, RQ19 |

ラジオの「3ラジオ」は各 `Unknown/Yes/No`（高額資産は `Unknown/No/Yes`、控除率は `Unknown/Confirmed/Estimate`）のDOM id群を指す。バッジは選択群に一つだけ置く。

## STEP2・行入力とCSV

| 安定キー／DOM id・行フィールド | 表示・有効条件／必須先 | 標準／空欄・未確認 | 検証・テスト |
|---|---|---|---|
| 売上・仕入行 `code`, `amount`／`data-row-field` | 入力開始した行だけ必須 `inputFlow`。未使用の末尾行は対象外 | 課税区分・税込金額。明示0円は入力済み | BGC18, RQ07, `aggregateTaxRows` |
| 売上・仕入行 `rate` | 課税取引に必須。TKC 3非課税売上は非入力 | 10／軽減8。非課税行は「—」 | BGC17, RQ06 |
| 売上行 `businessType` | 簡易課税選択中のTKC 1・11に必須 `simplifiedTax`。一般のみなら非適用 | 未選択は簡易課税結果だけの不足 | BGC02–03, RQ04 |
| 売上・仕入行 `foodAmount` | 食品試算・軽減8％・対象コードの行で必須 `foodTax` | 空欄は未確認。文字列 `0` は明示0円。10％・非課税は非入力 | BGC16–17, RQ05–06 |
| 仕入行 `creditRatio` | TKC 52/62/72で本則結果に必須 `regularTax`。簡易のみなら任意 | 対象期・元CSV日付と整合する割合。通常仕入は非入力 | BGC16–17, RQ06 |
| `addBusinessType` | 簡易区分を追加表示するときのみ任意 | 行があるだけでは0円扱いしない | RQ01 |
| 従来売上行 `${type.key}Sale10`, `${type.key}Sale8`, `${type.key}SaleFood1` | 従来集計形式で使う動的欄。現在の行入力と重複要求しない | 金額・食品内数の入力状態を従来検証へ | RQ01, RQ05 |
| `journalCsvFile` | 通常は任意。CSV反映操作 `csvApply` では必須 | 手入力はCSV不要。ファイル未選択を手入力エラーにしない | BGC15, RQ08 |
| `journalImportMode` | CSV反映操作時に必須 `csvApply` | 置換が既定、追加も選択可 | RQ08 |
| `applyCsvDateRange` | 任意 | 正式な課税期間と照合してから反映 | RQ08 |
| `returnPurchaseAdjustment10`, `returnAdjustmentConfirmed` | 調整額は任意。値を指定してCSVへ反映するとき確認チェック必須 `csvApply` | 空欄は調整指定なし。0円は入力あり。根拠・符号は既存検証 | RQ09 |
| CSV明細 `data-recovery-field="action"` | 未処理を明示解消する操作だけ必須 `csvApply`。通常は任意 | 空欄は未処理を保持。仮除外・対象外確認を推測しない | RQ09 |
| CSV明細 `category`, `usage`, `amount` | 補正を選択し、原分類／用途／金額が不明なら該当欄だけ必須 `csvApply` | 金額空欄と明示0円を区別 | RQ09 |
| CSV明細 `rate`, `creditRatio` | 補正で必要な場合だけ表示。原値を判定できないエラーなら必須、原値を保持できるなら任意 | 空欄は原値保持。根拠なき税率・割合を推測しない | RQ09 |
| CSV明細 `reason` | 「試算対象外と確認済み」を選んだ場合だけ必須 `csvApply` | 仮除外には理由を強制しない。出力へ仮除外前提を残す | RQ09 |

CSV補正欄は `renderJournalRecovery`、行は `renderTaxEntryRows` で再生成されるため、再描画後に同じ判定を適用し、既存値・元CSV出典・手修正フラグ・dirty状態を変更しない。バッジを付けるためのblur再計算は禁止。

## STEP3・追加費用・4期

| 安定キー／DOM id | 表示・有効条件／必須先 | 標準／空欄・未確認 | 検証・テスト |
|---|---|---|---|
| `viewMode=projection` と届出等の既存詳細欄 | 4期を選択した場合に既存経路判定を行う | 4期経路の未確認は未確認。STEP4設定を要求しない | RQ10, RQ19 |
| `switchFoodSalesState`, `switchSimplifiedAppliedState`, `switchFilingStatus`, `switchFilingDate`, `switchNoOtherRestrictionsState` | 追加費用比較を使う場合の条件確認。任意・未確認可 | 届出や制度を自動肯定しない | RQ19–20 |
| `switchAdditionalFee`, `switchFeeTaxBasis` | 追加費用比較を使う場合だけ必須 `extraCostResult` | 報酬額は0円を明示可。税込基準が初期値 | BGC14, RQ20 |
| `switchOtherCostsNone`, `switchOtherCosts` | なしチェックは任意。チェックを外し支出ありなら金額必須 `extraCostResult` | なしが既定。空欄を勝手に0円としない | RQ20 |
| `switchTimeEvaluation`, `switchCustomerHours`, `switchHourlyRate` | 工数参考額を含めるときだけ時間・単価必須 `extraCostResult` | チェックオフでは対象外 | RQ20 |
| `switchCreditState`, `switchCreditIncludedInBTax`, `switchAdditionalCredit` | 控除状態・二重計上確認は任意。確認済み控除額を指定するときだけ額必須 `extraCostResult` | 不明は不明のまま。A/B税額の既反映分を再加算しない | RQ20 |
| `switchCustomerComment`, `officeHours`, `officeHourlyCost`, `officeOtherCost`, `officeInternalMemo` | 追加費用比較を使う場合の任意記録 | 空欄可。所内値は顧客向け出力へ入れない | RQ20, RQ24 |

`legacyAdditionalFeeValue` と `officeAdditionalFeeExTax` は非表示の旧版互換値であり、利用者が操作する入力には含めない。

## STEP4・資金推移

| 安定キー／DOM id | 表示・有効条件／必須先 | 標準／空欄・未確認 | 検証・テスト |
|---|---|---|---|
| `cashflowComparisonType` | STEP4の選択群で必須 `rateCashflow`／`methodCashflow` | 税率変更が旧保存・新規初期値。2モードの中間納付・月・確認状態は分離保存し、STEP3は非依存 | BGC04, RQ10–11, B03 |
| `cashflowMethod` | 税率比較だけ必須 `rateCashflow` | STEP3候補1方式。方式別モードでは非適用 | RQ11 |
| `cashflowBaseMethod`, `cashflowChangedMethod` | 方式別比較だけ両方必須 `methodCashflow` | STEP3候補から異なる2方式。同一方式の検証は本番側 | BGC04, RQ11 |
| `cashflowDistribution`, `cashflowSalesLag`, `cashflowPurchaseLag` | 税率比較だけ必須 `rateCashflow` | 均等配分・当月決済が初期値。方式別では非適用 | BGC04, RQ11 |
| `cashflowSourceStart`, `cashflowSourceEnd`, `cashflowSourceConfirmed` | 税率比較でCSV月別配分を選んだときのみ必須 `rateCashflow` | CSV元期間と網羅性。方式別では非適用 | BGC04, RQ11 |
| `cashflowInterimStatus` | STEP4で必須。両モード共通 | 自動設定が初期値。`unknown`を0回確定と扱わない | BGC05–06, RQ12–13 |
| `cashflowAutoBasis`, `cashflowPeriodShortening`, `cashflowSpecialCircumstances` | 中間autoなら必須 `rateCashflow`／`methodCashflow` | STEP3代理・短縮未確認・通常事情の初期値。未確認なら予定未算定 | BGC05–06, RQ12 |
| `cashflowPriorProxyMethod` | 方式別・中間auto・STEP3代理額を選んだ場合だけ必須 `methodCashflow` | 両案共通の代理方式。表示税額自体は読取専用 | RQ12 |
| `cashflowPriorNationalTax`, `cashflowPriorStart`, `cashflowPriorEnd` | 中間auto・前期実績直接入力で必須 | 代理額使用時は非適用。国税額の0円は明示入力 | BGC06, RQ12 |
| `cashflowAutoSeparate`, `cashflowPriorChangedNationalTax` | 別前期仮定は任意。直接入力で別額を選んだとき変更案額必須 | オフを保持。旧r32の判別不能チェックは確認を要求 | N01回帰, RQ12 |
| `cashflowCorporateExtension` | 法人auto時のみ表示。11回等で期限判定に必要なら必須（`autoRequiresCorporateExtension`）。個人では対象外 | `unknown`を延長なしにしない。未確認なら自動予定は未算定 | 中間期限回帰, RQ12 |
| `cashflowSameInterim`, `cashflowBaseNoInterim`, `cashflowChangedNoInterim` | 手入力予定時のみ。選択・明示0回は任意 | 確認済み0回と未確認を区別 | N02回帰, RQ13 |
| `cashflowBaseInterim`, `cashflowChangedInterim` | 手入力予定で該当案が明示0回でない場合だけ必須。共通予定では変更案入力不要 | 未確認の空欄は0回と扱わない | N02回帰, RQ13 |
| `cashflowSameSettlement` | 方式別の共通／案別予定月切替。任意 | 共通が初期値。案別へ展開時は値と出典を複写し、異なる案別月を共通へ戻す際は採用値を確認 | B06, R33-06 |
| `cashflowSettlementMonth`, `cashflowRefundMonth` | 税率比較の共通予定月。Q>0案があれば納付月必須、Q<0案があれば還付月必須 | Q=0なら両方任意。Q未算定なら要否未判定。初期値も法定期限確認ではない | BGC07–09,11–13, RQ14–18 |
| `cashflowBaseSettlementMonth`, `cashflowBaseRefundMonth`, `cashflowChangedSettlementMonth`, `cashflowChangedRefundMonth` | 方式別で共通月をオフにした場合の案別予定月。各案のQの符号でその案の月だけ必須 | 共通月オン、他案・他種別の月は任意で今回は未使用。Q未算定なら要否未判定 | BGC10, RQ16–18, B04 |

STEP4の「A/Bを入れ替える」「標準月へ戻す」は入力欄ではなく操作ボタン。入替えは案に付く中間納付・0回確認・予定月の値と出典を合わせて動かし、共通の前期代理額は動かさない。標準月へ戻す操作は選択中モードで使用する予定月のみ対象にする。食品1％行内数の必須は上記の表示バッジだけでなく、当該STEP3税額の未算定およびSTEP4・出力へ同じ状態で伝える。

**検証の境界：** この判定層はバッジの要否と「必要値が空か」を共有する。課税方式の適用可否、税額、CSV分類の確からしさ、中間納付の回数・日付・金額、精算 Q は各既存エンジンの結果を受け取る。バッジから税額・届出・法定期限を逆算しない。`input-requirements.test.js` は添付 `field_badge_cases.json` のBGC01〜20とDOM入力棚卸しを固定値で検証する。画面上の位置、390px幅、キーボード、再描画重複、顧客出力非混入は結合・ブラウザ試験で別途確認する。
