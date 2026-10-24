# r36-dev クラウド実装・検証記録

> この文書は公開前の実装・検証記録を保持しています。公開確認は[r36.0公開記録](release-r36.0.md)を参照してください。未対応範囲の分類は維持します。

作業日: 2026-10-23 UTC / 2026-10-24 JST。対象リポジトリ `takatrp/shohizei-kazei-houshiki`。公開用完成版ではなく、制度・資料の未確認範囲を残す開発版。

## 1. 開発起点

- 起点: fetchした最新 `origin/main` = `9e88cf25551e814ac69dc49244583713040e73ec`、r35.9 / 35.9.0。提供環境の元ブランチworkはr35.8で変更なし。元ブランチを変更せず `codex/cloud-six-features-20261024` を新設。
- AGENTS.mdは対象ツリー・上位に存在しなかった。README、履歴、保存schema21、既存798テスト、共有前期・元CSV状態、主要計算経路を確認。
- 開始時に実行した `npm test`: 798成功・失敗0。`npm run build`・`git diff --check`成功。過去結果の転記ではない。
- ローカルPCは使わず、クラウドNode v24.19.0とChromium / Playwrightを使用。ブラウザは匿名架空データ・localhost、外部リクエスト遮断で検証。
- 本節は実装・検証時点の記録。公開確認と実際の税務申告・届出を区別する。

## 2. 実装内容と制度確認待ち

| 要求 | 実装した範囲 | 残る制限・再開条件 |
| --- | --- | --- |
| ①複数期 | 当期の下の任意表示。期間毎に食品税率を再計算、終了後まで必要最小延長、売上・仕入増減/設備追加、参照期間完全一致、届出効力/予定/未確認を分離。nullを0円にしない。 | 最長16期。終了後を含まない時は未完結と表示。特定期間や資産履歴が足りない方式は未確認。短期/決算期変更の法人の法定参照期間は履歴待ち。 |
| ②中間特例 | 実前期取引から開始・終了を別再計算。通常回数・期限固定、A/B別明示利用、通常/特例金額・年税額精算。共有された同一前期CSVを再利用。 | 元税率・課税状態が分かる返品は対応範囲を再計算。複雑な負基礎・輸入等は特例のみ未算定。正確方式/控除関係が不明な時は補足。成立法令・正式端数/様式を再照合。 |
| ③免税経路 | 現在申告方式と対象期義務を分離。免税維持、期首課税選択、登録後取引、別拘束状態・取消・資産制限。取引期間と税額を併記。 | 期中登録は正式な同一CSVの日別実額を優先。旧月別は月境界限定、それ以外は理由付き日数概算。移行時棚卸・固定資産調整は未実装。取消提出は当初の提出と別入力。 |
| ④CSV対象額 | 元CSV ID/正式期間/全月網羅/現在行との対応を照合し、税額計算前に食品対象額を推計。食品明細/前年/グループ代理を区別。STEP4へ同じ月別額を再利用。 | 現行CSV parserは食品明細の月別属性を持たず、通常は課税区分グループ代理。食品明細APIは独立テスト済み、実CSVの食品別自動分類は行わない。月途中は日数概算。 |
| ⑤負額・返品 | 内部食品同額控除の符号、元8％返品、区分11反転一度、明示1％の別管理、非食品純負額の方式別未算定。通常行と調整を分離。 | 純負額UIの全面開放は行わない。元取引不明・通常と調整を分離不能な集約は理由付き停止。複雑な負基礎の正式簡易計算は未確定。 |
| ⑥4金額 | 業種候補+税込4金額→通常行へ自動反映。詳細・CSV保護、明示0/空欄、保存復元、要約読取。 | 食品は8％実績からの政策予測。その他10％・課税売上対応等は明示仮定。例外は詳細行で保持、事実確認済みへ変換しない。 |

食品制度は[一次資料記録](continuation-primary-sources.md)のとおり審議中法案・改正案。2026年9月Q&A、10月9日ドラフト様式を正式法令・正式申告様式と扱わない。未確定のため無関係な税額・通常納付まで停止しない。

## 3. ファイルと互換性

主な変更: `index.html`、`tax-engine.js`、`tax-entry-rows.js`、`release-history.js`、`package.json`、`scripts/validate-static.js`。

新規計算: `sales-scenario.js`、`food-period-estimator.js`、`food-interim-comparison.js`、`prior-actual-evidence.js`、`tax-obligation.js`、`four-amount-entry.js`。DOM接続は `continuation-ui.js`。方式ごとの税額は既存の税計算関数を呼び、表示層は共通結果を画面/コピー/CSV/印刷へ渡す。

初回の保存schema22と追補のschema23は同じ保存キーを維持する。schema23は匿名日別分類・日付・金額のみを追加し、旧保存に日別がなければ月別又は理由付き概算へ戻す。新しい前期補足・将来仮定は期間に結び付け、前期の別完成期間では流用しない。以前の補足は期間別に保持し、元期間へ戻しても国税額の旧実績を自動復活させない。旧regular分類から正確一般課税を推定しない。旧共有候補の競合は既存の候補選択を維持。4金額生成行は出所と署名を保存し、詳細編集後は簡略側で上書きしない。保存は明示設定が有効な時だけ、CSV原文・摘要・取引先や解析送信は追加していない。

既存期待値変更は、④のCSV優先文言、開発版履歴の追加、⑤の旧8％仕入返品を1％へ変換しない値、および元売上返還の負額税を保持する検算値。追補の資産テストは、初期の明示免税状態と後の取得制限を期間別に設定するよう前提を明確化した。区分11の負入力による返品取消の既存期待値は保持した。

## 4. 自動検証

変更後の最終結果は下の追記に記載する。通常の `npm test` の分離条件を変更していない。Nodeの `--test-isolation=none` 対応を確認し、件数確認用の追加実行としてのみ使用する。

追加テストは、符号・元税率・食品同額控除、月別推計と境界/符号0、前期特例と国地方・精算、資料同一性、将来経路・1,000万/5,000万境界・免税拘束、4金額変換/保護を扱う。独立手計算・国税庁例示・既存制度の不変条件を用い、同じ関数の結果を期待値へ転記するだけにはしていない。

## 5. 実ブラウザ検証

再実行:

```sh
PLAYWRIGHT_MODULE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright CHROMIUM_PATH=/usr/bin/chromium KAZEI_BASELINE_REPORT=/tmp/kazei-browser-evidence/baseline-report.json node scripts/continuation-browser-smoke.cjs
PLAYWRIGHT_MODULE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright CHROMIUM_PATH=/usr/bin/chromium node scripts/continuation-browser-expanded.cjs
```

- 食品販売型/食品仕入型を4ステップで操作。4金額→詳細金額、コピー/CSV、明示保存→実reload、詳細修正後の4金額保護、390px表示、Chromium PDFを確認。4金額の一般税額は独立手計算−5,000円、詳細修正後は5,000円をPDF抽出でも確認。
- native日付の年を1字ずつ入力（0002→0020→0202→2028）して警告0。blur取消だけ1回、日付と食品確認復元。期間編集中に売上だけ変更すると、その変更は保持し売上unknown、仕入confirmedへ復元。
- 季節CSV: 2027年の年税額26,500円（売上83,000−仕入56,500）を独立検算。April売上差−7,000円/仕入資金増+3,500円、Jan0円で二重按分なし。
- 将来売上増加が2期後の基準期間へ反映され、5,000万円超で簡易不可。措置終了後2030年の一般税額30,000円を計算継続。
- 中間特例開始: 通常700,000→特例350,000。終了: 通常4,200,000→特例7,000,000。増額も表示。A維持/B明示切替、年税額不変、中間+確定−還付を円単位照合。コピー/CSV/印刷の特例前提を確認。
- 現在免税と対象期義務を別保持。免税維持/課税選択/登録経由、2028全年と7月1日以後取引、取消予定を操作。
- 前期の途中入力は補足を維持。別の完成前期へ変更→旧補足不使用・通常へ。保存reload後に元期間へ戻す→補足復元、国税の再入力まで算定停止。

追加のCSV資料再利用・将来免税閾値・追加印刷の最終ブラウザ結果は下に追記する。証跡はリポジトリ外の `/tmp/kazei-continuation-browser-r4/`、`/tmp/kazei-expanded-browser-r5/` 等に保存。実ブラウザで確認した範囲を単体テストと区別している。

## 6. 入力・遷移

同じ既存食品販売型サンプル: STEP2の可視有効入力20→20、必須表示18→18、画面遷移3→3。4金額新規経路は業種候補+4金額を入力すれば自動で通常行へ反映し、新たなモード選択・反映ボタン・追加遷移は不要。免税/中間特例の不足事実は関係箇所だけに表示する。

## 7. 未実施と残る作業

成立後の正式法令/施行政省令/正式様式による再照合、実際の税務申告・届出、全てのCSV方言・全ての16ケース組合せの実ブラウザ網羅、実案件資料との照合、Firefox/WebKit・実端末/実プリンター、上記停止対象の複雑計算は未実施。純負額・輸入・資産調整を含む全6項目が完全対応したとは扱わない。根拠・資料が揃った範囲から局所的に再開する。

## 8. 公開

実装・検証の結果と公開後の確認結果を分け、r36.0公開記録と対応PRを参照する。

## 初回実装 a65643d の実行結果（後続追記を優先）

- `npm test`: **889成功、失敗0、skip0**。ログ `/tmp/kazei-final-tests.log`。
- `npm run build`: 成功（静的参照・全追加モジュールの構文を含む）。`git diff --check`: 成功。
- 補助実行 `node --test --test-isolation=none --test-reporter=spec`: **889成功、失敗0、skip0**。通常テストの代替ではない。ログ `/tmp/kazei-final-unisolated-tests.log`。
- 最終Chromium: basic **6群成功**（`/tmp/kazei-final-browser-basic/report.json`）、expanded **8群成功**（`/tmp/kazei-final-browser-expanded/report.json`）、各JavaScriptエラー0件。
- expandedでは共有実前期CSVの4金額再入力不要、別CSV/1円修正で再利用停止、2期前11百万円予測による2029年の免税維持不可、当期給与を将来期へコピーしないこと、DOM更新前の最新計算額がコピー/CSV/印刷へ一致することも確認。追加比較PDFから2030年・110,000円・追加検討の記載を確認した。
- 明示1％実績の将来仮定は、税込価格据置と税抜価格据置を区別する追加手計算テストも成功。1％返品は将来の通常取引へ変換せず、元取引確認を要求する。
- Node試験件数は開始時798→変更後889。件数自体を税務上の正確性の根拠とはしない。

全6項目の標準・基本経路を実装したが、本記録2・7の制度確認待ち/対応外を含む案件まで完全対応と表示しない。公開は行っていない。


## 追補の最終結果と基盤切断後の回収確認

初回a65643dの889件と、下記追補の936件を区別する。途中の922/929件や先行ブラウザ結果を最終結果として流用していない。

| 実行段階 | 保存済み証拠 | 結果・復旧後の確認 |
| --- | --- | --- |
| 最終コードの通常テスト | `/tmp/kazei-final-complete-tests.log` | 936成功、失敗0、skip0。2026-10-23 23:46:16 UTC完了のログを復旧後に確認。通常分離条件を維持。 |
| 件数確認用の補助実行 | `/tmp/kazei-final-complete-unisolated-tests.log` | `node --test --test-isolation=none --test-reporter=spec`、936成功、失敗0、skip0。23:46:19 UTC完了。通常テストの代替ではない。 |
| 切断直前までに取得できたブラウザ結果 | `/tmp/kazei-final-complete-basic/`・`expanded/`・`review/` の各 `report.json` | 計25群成功（6+8+11）、ページ例外0。最終再実行とは別の記録。 |
| 結果取得中に基盤が切断した最終再実行 | `/tmp/kazei-final-frozen-basic/report.json`、`/tmp/kazei-final-frozen-expanded/report.json`、`/tmp/kazei-final-frozen-review/report.json` | 復旧後に完成したJSONと終了ログを先に回収。6+8+11＝25群すべてPASS、全ページ例外0。23:46:57〜23:47:03 UTC完了。結果を推測して再実行していない。 |
| 復旧後の静的確認 | `npm run build`、`git diff --check` | 両方成功。最終コードについて結果を取り切れていなかったbuildのみ再確認。通常テスト・ブラウザは結果を回収できたため重複実行しなかった。 |

最新計算コードの最終更新は `food-interim-comparison.js` の2026-10-23 23:45:47 UTCで、上記テスト・最終ブラウザ結果はその後のもの。復旧時に元ブランチ `codex/cloud-six-features-20261024`、HEAD a65643dと38ファイルの未コミット差分を確認した。checkout/reset/cleanを行わず、パッチ・変更ファイル全体・SHA-256 manifestを `/tmp/kazei-resume-preservation-k69bo1sp/` に退避してから、この記録を追記した。復旧後の計算コードの変更はない。

### 追補で確認した実画面・独立計算

- 基本6群: 食品販売型/仕入型の4ステップ、4金額から詳細、詳細修正後の保護、保存reload、390px表示、Chromium PDF。日付の年逐次入力で警告0、blur取消後に日付・変更のない食品確認を復元。
- 展開8群: 季節CSVを年税額/STEP4へ共用、終了後の将来税率と2期前参照、中間開始/終了、A/B明示利用と確定精算、共有前期補足の期間切替、同一正式CSV再利用/別資料停止、最新出力、免税/選択/登録経路。
- 独立レビュー11群: 不正4金額の旧税額を出力/保存へ残さない、対象期確認の別年非流用、返品/取消の符号、明示1％将来増減と用途、nullの0円化防止、実CSV取込から登録日実額・旧月額・日数概算・保存reload、既存義務判定事実の共用、免税年売上の将来基準、現在/将来資産と出口、返品元取引補足の実操作。
- 独立値: 旧8％売上返還と1％売上の混在で一般▲6,000円、仕入返還で16,000円。7/15登録後CSVの一般税額5,000円。前期返品の補足で一般中間特例310,000円・単一第二種簡易191,900円となり、コピー/CSV/印刷/保存reload一致、精算reconciledを確認。
- 国税丸めの査読例: 返品なしと国税0円となる1円返品ありの両方で、簡易/2割は国1,700＋地方400＝2,100円、3割は3,200円。複数業種の通常・75％計算も国税段階へ統一し、現行申告段階エンジンとの固定例・独立照合を実施。
- 使わない仕入情報を簡易/2割/3割の停止理由にしない一方、一般課税・不正売上・不明sideは必要な停止を維持。未使用仕入は確認済みに格上げしない。未算定/選択未確認を最適化の0円・利用可能へ変換しないことを独立再査読した。

通常案件の同じサンプルで可視入力20→20、必須表示18→18、遷移3→3。schema23は同じ明示保存設定と保存キーを使い、匿名日別分類・日付・金額のみ追加。旧schema22以前は日別がなければ月境界の月額又は理由付き概算に戻す。CSV原文・摘要・取引先の追加保存/送信はない。

未対応の(a)/(b)分類、申告書作成までの資産台帳機能との範囲差は [最終レビュー](continuation-final-review.md) を維持。食品制度の確認日は2026-10-24 JST。成立後の正式資料照合、特殊計算、実案件・全CSV方言/組合せ、他ブラウザ・実端末/実プリンター、本番稼働、届出/申告は未実施。基盤切断は復旧済みで、実装・検証で未確定だった結果は回収できた。

### 追補コミットの変更ファイル

- `README.md`
- `continuation-ui.js`
- `docs/continuation-final-review.md`
- `docs/continuation-primary-sources.md`
- `docs/continuation-routes-policy.md`
- `docs/continuation-usage.md`
- `docs/continuation-verification.md`
- `docs/food-interim-policy.md`
- `docs/food-period-estimator.md`
- `docs/taxable-window-rows.md`
- `food-interim-comparison.js`
- `food-period-estimator.js`
- `four-amount-entry.js`
- `index.html`
- `journal-csv.js`
- `package.json`
- `prior-actual-evidence.js`
- `release-history.js`
- `sales-scenario.js`
- `scripts/continuation-browser-expanded.cjs`
- `scripts/continuation-browser-review.cjs`
- `scripts/validate-static.js`
- `tax-engine.js`
- `tax-entry-csv.js`
- `tax-entry-rows.js`
- `tax-obligation.js`
- `tax-return-engine.js`
- `taxable-window-rows.js`
- `tests/continuation-routes.test.js`
- `tests/food-interim-comparison.test.js`
- `tests/food-period-estimator.test.js`
- `tests/food-signed-returns.test.js`
- `tests/four-amount-entry.test.js`
- `tests/prior-actual-evidence.test.js`
- `tests/sales-scenario.test.js`
- `tests/tax-engine.test.js`
- `tests/taxable-window-rows.test.js`
- `tests/tkc-row-csv.test.js`

初回実装a65643dを保持し、この追補を別のローカルコミットへまとめる。コミット識別子はGit履歴を参照。公開結果はr36.0公開記録と対応PRで確認できる。
