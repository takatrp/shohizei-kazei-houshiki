# r36.0.3 マニュアル動画の導線

起点mainはr36.0.2 `ed483d5946a3686819d983ab6ea836fe89da58e4`。変更は上部マニュアル導線と、その静的動画資産・検証・更新履歴に限定する。税計算、保存形式、通常の4ステップは変更しない。

主ボタンを再生アイコン付き「マニュアル動画」へ変更し、標準controls・playsinline・preload metadataを持つページ内dialogを開く。自動再生は行わない。閉じるボタンとEscは動画を停止し、開いたボタンへフォーカスを戻す。390px幅と横向きでも収まる表示。文章マニュアルのPDFは削除せず、dialog内から新しいタブで参照できる。

動画は強調表示版v1を `manual/csv-import-guide.mp4` として既存サイト配下から配信する。指定仕様は8,126,620 bytes、約2分55秒、1920×1080、H264/AAC。実画面・架空データ、日本語字幕・合成音声、黄色の枠・矢印を含む。旧版やプレビューを混在させない。私的なダウンロードURLや期限付きURLをHTMLへ埋め込まない。

## 検証状況

開始時は959テスト成功、build・diff検査成功。関連4テストは、導線・文章PDF保持・閉じた際の停止/フォーカス・色のコントラストを確認。通常色・ホバーの白文字は4.5以上、フォーカス色の白背景とのコントラストは3以上。

素材取得前の独立したChromium検証では、Enterで開く、標準controls等の属性、自動再生なし、Esc/閉じる、フォーカス復帰、390px縦/横向きの表示の4群が成功、ページ例外0。動画本体が未取得のため、実際の再生、duration、MIME/bytes、Range配信の検証は未実施。`npm run build` は動画資産がない状態で公開を進めないよう、MP4の存在も検査する。

最終の素材同一性・メディア仕様の実測、全テスト、動画再生と停止、Pages実行、公開配信のMIME/bytesは、素材取得後に追記する。

動画取得待ち時点の通常テストは962成功・失敗0・skip0、diff検査成功。通常導線6群と既存税額概要式3群も成功。動画UI4群を加えて13群のUI確認を実施したが、動画再生の検証は成功扱いにしない。buildは `manual/csv-import-guide.mp4` の欠落で停止しており、素材取得までmain統合・公開は行わない。

記録は `/tmp/kazei-manual-video-tests.log`、`/tmp/kazei-manual-video-ui/report.json`、`/tmp/kazei-manual-video-basic/report.json`、`/tmp/kazei-manual-video-summary/report.json`。
