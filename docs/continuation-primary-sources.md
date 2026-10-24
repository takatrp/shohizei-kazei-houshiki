# r36-dev 一次資料の確認

確認日: 2026-10-23 UTC / 2026-10-24 JST。検索と各原本の本文を確認した。制度の成立を前提にした説明と現行法を区別する。以下の確認だけで個別案件の申告適用を保証しない。

| 論点 | 一次資料・日付・箇所 | 法的位置付けと実装への影響 |
| --- | --- | --- |
| 成立・施行状況 | [衆議院・第222回閣法1審議経過](https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DE342E.htm)、10月9日受理・10月20日財務金融委員会付託。[議案一覧](https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/menu.htm) | 閲覧時点で審議中。成立・公布欄に記録なし。成立法令として実装しない。 |
| 公表内容の更新・正式様式 | [国税庁特設サイト](https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/zeiritsuhikisage.htm)、2026年9月15日、10月9日様式追加 | 改正案の説明。Q&Aは9月版、[様式PDF](https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0026010-002-01.pdf)は10月9日のドラフト。正式様式として扱わない。 |
| 現行税率との区別 | [財務省・消費税の使途](https://www.mof.go.jp/tax_policy/summary/consumption/d05.htm)、注4（資料に更新日の明記なし） | 現行の食品・新聞8％の国地方内訳を確認。食品1％へ現行計算を置き換えない。 |
| 期間・対象・国地方 | [国税庁Q&A・2026年9月](https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0026008-127_qa.pdf)、本文1〜2頁・問1-1/1-2 | 改正案の2027-04-01〜2029-03-31、食品1％（国0.78％・地方0.22％）を政策定数に使用。新聞等を除外。 |
| 境界・旧税率・返品 | 同Q&A、本文3〜4頁・問1-3〜1-6 | 旧取引の税率を保持。発生日だけで返品を1％へ変えない。経過措置の該当性は食品内数から除外するか内訳確認。 |
| 免税からの選択と拘束 | 同Q&A、本文10〜13頁・問3-1/3-2 | 通常届出と食品の期限例外を分離。選択の課税期間は期首から。資産調整等は個別資料待ち。 |
| 登録日からの課税 | 同Q&A、本文15〜16頁・問3-4 | 選択届出と登録経路の開始日・取引期間・拘束・取消を別判定。期中登録は登録日以後のCSV日別実額を優先し、資料不足時だけ理由付き日数概算。 |
| 簡易不適用・復帰 | 同Q&A、本文17頁・問3-5 | 開始日を含む期だけの例外。売上基準超過で効力が残る状態と不適用届出で効力が消える状態を分離。終了後の復帰は新届出等の条件次第。 |
| 食品同額控除・75％ | 同Q&A、本文18〜20頁・問3-6/3-7、ドラフト付表 | 食品の売上税額と返還額の差引を保持。食品以外の負基礎・元取引不明を無理に75％計算へ渡さない。 |
| 中間特例 | 同Q&A、本文20〜22頁・問3-8 | 通常の義務回数と特例額を分離。前期取引を再計算。開始・終了の適用回を分け、増額も表示。国地方端数は既存申告段階計算の政策参考値。 |
| 現行の納税義務・参照期間 | [国税庁No.6501](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm)、[No.6503](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6503.htm)、2026-04-01現在法令等 | 各期の実績・明示予測を完全一致の参照期間に結び付ける。短期・決算期変更の法人は一律2年前の期間へ置換せず未確認。 |
| 現行の返品控除と原免税取引 | [No.6359](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6359.htm)「調整不可取引」「計算式」、[No.6363](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6363.htm)「調整方法」、2026-04-01現在法令等 | 元取引時の免税が明示された返還は控除対象外。課税/免税不明と旧課税区分による入力を区別し、返品取消の正負を保持。 |
| 免税年の基準期間売上 | [国税庁質疑22/05](https://www.nta.go.jp/law/shitsugi/shohi/22/05.htm)、2025-08-01法令通達・回答要旨 | 免税年の課税資産譲渡対価は税抜換算しない。維持/課税/期中登録の状態に応じて履歴を組み立て、状態不明の年は確定基準額を作らない。 |
| 移行時棚卸と固定資産調整 | [No.6491](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6491.htm)内容1・2、[No.6421](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6421.htm)概要・注・計算式、2026-04-01現在法令等 | 現行制度として確定した要件。資料不足(b)と詳細申告計算の範囲を区別する。取得・保有・原税率・複数年割合等がない場合、調整0円とは断定しない。 |
| 資産取得による復帰/届出制限 | [No.6501](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm)課税選択・調整対象固定資産、[No.6505](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm)対象・基本式、2026-04-01現在法令等 | 資産の既知取得・制限不明と将来設備仮定を共用。単位額・取得方式が不足した集計額を取得済み適用制限へ格上げせず、必要な期の可否を未確認に保つ。 |

2026年9月Q&Aの改訂版・正式様式への差替えは確認できなかった。成立法令・施行政省令・正式様式が出た時に、例外、端数、負額、届出期限、開始終了境界を再照合する。成立前のため税務申告・届出には使用しない。

詳細な算式・手計算・停止条件は [返品](food-returns-policy.md)、[月別推計](food-period-estimator.md)、[中間](food-interim-policy.md)、[複数期と免税](continuation-routes-policy.md) に記録した。
