# CLAUDE.md — Chat 3D プロジェクトルール

## プロジェクト概要
Chat 3D は、ブラウザだけで完結する「テキスト指示 / コード実行による 3D モデル(STL)
生成・編集ツール」の PoC。バックエンドを持たず、すべて HTML/CSS/Vanilla JS で動く。
Subutomo Dev のツール系サイト群の一員として、共有フッター/バッジ/favicon を踏襲する。

対応ユースケース:
1. **STL 編集モード** — STL/3MF を D&D 読み込みし、チャット指示で CSG 加工する。
2. **ゼロベース生成モード** — 空シーンから、チャット指示のみで基本図形 + CSG で生成する。
3. **マニュアルコード実行モード** — 外部 LLM で作った JS を貼り付けて実行する。

チャットでの LLM とのやりとりは **コピペモード**(Gemini に限らず任意の LLM と手動で
コピペ、既定)/ **API モード**(Gemini API を直接呼び出し)の 2 種類から選べる。
詳細は `docs/architecture.md` の「チャットの 2 モード」を参照。

## 技術スタック
- UI/構成: HTML5 / CSS3 / Vanilla JavaScript(ES Modules)
- 3D 描画: Three.js r160(CDN + importmap)
- ブーリアン演算: three-csg-ts 3.2.0(CDN)
- LLM: Gemini API(REST、ブラウザから直接 fetch)

## ファイル構成
- `index.html` — エントリ。UI 骨格 / importmap / フッター / バッジ。
- `main.js` — 中核ロジック(Three.js / STL 入出力 / 動的実行エンジン / Gemini)。
- `style.css` — レイアウトとダークテーマ。
- `vendor/` — 上流ライブラリのバグ修正のためにローカルへ持ち込んだ改変版
  (現状: `3MFLoader.js`。ライセンス表記と改変理由をファイル冒頭コメントに残すこと)。
- `assets/` — favicon 一式と `subutomo-badge.js`(spctrl-site から踏襲・複製)。
- `common/assets/logo.png` — バッジ用ロゴ(同上)。
- `config/subutomo-sites.json` — サイト台帳(バッジのリンク元。正本はテンプレ側)。
- `docs/` — 設計・使い方の補足ドキュメント。

## コーディングルール
- ファイル冒頭に、そのファイルの役割を 1 行コメントで書く。
- 関数には JSDoc(日本語)を書く。
- ハードコードは避け、数値・文字列・プロンプトは定数化する。
  - システムプロンプトは `main.js` の `DEFAULT_SYSTEM_PROMPT` に集約(調整しやすさ優先)。
- 動的実行(`new Function`)したコードのエラーは、握りつぶさず UI のエラー欄に
  スタックトレースをそのまま表示する。
- `requestAnimationFrame` ループ内でオブジェクトを生成しない。
- 破棄したメッシュは `geometry.dispose()` / `material.dispose()` する。

## 動的実行エンジンの契約(重要)
ユーザー/LLM のコードには次が引数として渡される。仕様を変える場合はシステム
プロンプト(`DEFAULT_SYSTEM_PROMPT`)とサンプル(`SAMPLE_CODE`)も同時に更新する。
- `scene` / `THREE` / `CSG` / `targetMesh` / `setResult(mesh)` / `mergeMeshes(meshes)`
- 完成メッシュは `setResult(mesh)` で 1 つだけ登録する(scene への add は側が行う)。
- CSG 演算の前に各メッシュで `updateMatrix()` を呼ぶ(位置・回転の反映)。
- `mergeMeshes([...])` は CSG を使わない合成。複数の切削体を 1 つにまとめて
  `subtract` の回数を減らし、三角形数を抑えるためのもの(重なる形状には使えない)。

## 三角形数の抑制(方針)
CSG は結果の三角形数を増やし、多いと(a)実行が数分かかりブラウザが落ちる
(b)スライサーで簡略化され穴が開く、という実害が出ている。**増えてから減らすのではなく、
最初から作らせない**のが方針。`DEFAULT_SYSTEM_PROMPT` の「三角形数を最小化するルール」に
優先順位付きで集約する(CSG を使わない構成 > CSG 回数の削減 > 分割数の削減 > 形の妥協)。
プロンプトを更新したら `PROMPT_VERSION` を上げること(保存済み環境へ配るため)。

## 水密化(`makeWatertight`)の注意
BSP 方式の CSG は T ジャンクション(辺の途中に他の面の頂点が乗る)を必ず生む。これが
スライサーでの「面が欠けている」の正体で、`three-bvh-csg` に替えても解決しない。
`downloadStl()` で 1 パスの修復を掛けている。**次は実測で確認済みの罠。変更するとデグレする。**
- `ON_EDGE_EPS`(1e-4mm)を緩めない。緩めると三角形数も境界エッジも増える。
- 面積ゼロの三角形を除去しない。位相をつないでおり、消すと境界エッジが復活する。
- 辺の分割点キャッシュは必ず `lo→hi` の向きで作る(呼ばれた順に依存させない)。
- `mergeVertices` では直らない(頂点のずれが原因ではないため)。
- CSG のたびには掛けない(三角形増加が複利で効く)。保存時のみ。

## セキュリティ上の注意
- `new Function` によるコード実行は本質的に任意コード実行。PoC 前提の設計であり、
  信頼できないコードを他人に実行させる用途には使わないこと。README にも明記する。
- Gemini API キーは localStorage にのみ保存し、Subutomo のサーバには送らない。

## バージョン管理ルール
**コミット前に必ず `package.json` のバージョンを更新する。更新なしのコミットは禁止。**
- SemVer 管理(破壊的=メジャー / 後方互換機能=マイナー / 修正=パッチ)。
- コミットメッセージにバージョンを含める(例: `feat: v0.2.0 CSG 面取り対応`)。
- **`index.html` の `SUBUTOMO_BADGE_CONFIG.version` を `package.json` と必ず同期する。**
  - 左下バッジ表示、および `badge.js` / `main.js` の `?v=` キャッシュバスティングに使う。
- 初期バージョンは `0.1.0`。

## 言語ルール
- CC への指示・コミットメッセージ: 日本語
- コード内コメント・JSDoc: 日本語
- サイト表示テキスト: 日本語(ツールの一次ユーザーが日本語想定のため)

## デプロイ
- GitHub Pages(静的配信)。`main` ブランチのルートをそのまま公開する。
- ビルド工程なし。CDN + importmap で依存を解決するため、`git push` = デプロイ。
