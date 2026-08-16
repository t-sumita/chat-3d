# アーキテクチャ / 設計メモ

Chat 3D は「UI 骨格(index.html)」「中核ロジック(main.js)」「テーマ(style.css)」の
3 ファイルで構成される。ビルド工程は無く、依存は importmap で CDN から解決する。

## 処理フロー

```
                ┌───────────────────────────────┐
  STL/3MF D&D ► │  loadModelFile → setTargetMesh │
                └─────────────┬─────────────────┘
                              ▼
  チャット指示 ─► callGemini(system+context) ─► extractCode ─┐
                                                             ▼
  コード直接入力 ──────────────────────────────► runUserCode(new Function)
                                                             ▼
                                        setResult(mesh) → setTargetMesh → 再描画
                                                             ▼
                              「STL ダウンロード」→ STLExporter(binary)
```

## 状態管理: `targetMesh`
- シーンの「操作対象メッシュ」を 1 つだけ保持する（`main.js` の `targetMesh`）。
- 有無で 2 モードを切り替える:
  - `null` → **ゼロベース生成**。system プロンプトに「空なのでゼロから生成せよ」を付与。
  - 存在 → **STL 編集**。「targetMesh(サイズ X×Y×Z)を CSG で加工して置換せよ」を付与。
- コンテキスト文の生成は `buildContext()`、system プロンプト合成は `buildSystemPrompt()`。

## 動的コード実行エンジン
- `extractCode(text)` — ` ```js ... ``` ` フェンスがあれば中身、無ければ全文。
- `runUserCode(code)` — `new Function('scene','THREE','CSG','targetMesh','setResult', code)` で実行。
  - `setResult(mesh)` 優先、無ければ `return` 値をメッシュとして採用。
  - 例外は `showError()` で UI にスタックトレースを表示（握りつぶさない）。

### 実行中の進捗表示（重要な制約）
CSG は**同期処理でメインスレッドを占有する**ため、実行中に JS から進捗を更新することは
原理的にできない（真のパーセンテージ表示は不可能）。そのため次の構成にしている。

- `runUserCode()` は `async` 化し、`setExecOverlay(true)` → `await nextPaint()`
  （二重 `requestAnimationFrame`）で**オーバーレイを確実に描画してから**ブロッキング処理に入る。
- `.exec-spinner` は `transform` アニメーション。transform/opacity のアニメーションは
  コンポジタスレッドで処理されるため、**メインスレッドがブロック中でも回り続ける**。
  これが「フリーズした」という誤認を防ぐ主要な仕掛け。
- 所要時間は `performance.now()` で実測し、`recordRunTime()` が
  `settings.execHistory`（直近 `EXEC_HISTORY_MAX` 件、localStorage）へ記録する。
- `estimateRunTime(tris)` は履歴から「1 三角形あたりの実測コスト」を平均して推定する。
  履歴が無い / 規模が 10 倍以上離れている場合は **`null` を返して推定を出さない**
  （根拠のない数字を見せないため）。
- 実行後は `showDebugReport()` が所要時間・入出力の三角形数・推定との乖離・
  実行コード内の `console.log/warn/error` 出力を「実行レポート」欄に表示する。
  console は実行中だけ差し替え、`finally` で必ず復元する。

## 指示のヒント（`INSTRUCTION_TEMPLATES` / `INSTRUCTION_LIMITS`）
LLM は読み込んだ形状を見ていないため、指示できる範囲には原理的な制約がある。
チャットタブの「指示のヒント」欄で、成立する指示をクリック引用できるようにしつつ、
成立しない指示（フィレット・シェル化・部位指定など）を理由付きで併記して期待値を揃える。
- 成立する指示＝**全体変形 / bbox 基準 / パラメトリックなパターン / 座標指定**。
  いずれも「原点中心・mm 単位」という前提のみで書けるため、形状を知らなくても正確。
- 形を指し示す指示は通らないので、寸法と座標で伝える。**3D ビューを見て判断するのは
  ユーザーの役割**、という分担がこのツールの前提。

## 3MF 読み込み
- `ThreeMFLoader.parse(buffer)` はシーンに追加していない `THREE.Group` を同期的に返す。
- `group.updateMatrixWorld(true)` を呼んでから各 `Mesh` を走査し、`position` 属性(と
  `index`)だけを取り出して `matrixWorld` を焼き込む。色・マテリアルは要件により不要
  なため意図的に破棄する。
- 複数メッシュがあれば `BufferGeometryUtils.mergeGeometries` で 1 つに統合し、
  `computeVertexNormals()` で法線を再計算してから `center()` する(STL 読み込みと
  同じ「原点中心に寄せる」挙動に揃えるため)。
- `ThreeMFLoader` は CDN の three.js 標準実装ではなく `vendor/3MFLoader.js`(three@0.160.0
  からの改変版・MIT)を使う。標準実装は複数 `.model` パート構成の 3MF で、他パートに
  定義された objectId への `<component>` 参照を解決できずに例外を投げるバグがあるため、
  全パート横断の `objectId → modelData` マップ(`allObjectData`)を先に構築してから
  `buildObject` で解決するよう patch している。詳細は同ファイル冒頭のコメントを参照。

## チャットの 2 モード(コピペ / API)
- `chatMode`(`'copy'` | `'api'`、既定 `'copy'`)で挙動を分岐する。`setChatMode()` が
  トグルボタンの見た目・送信ボタンのラベル・`#paste-back` の表示/非表示を切り替え、
  各モード初回切替時のみガイドメッセージを `logChat('sys', ...)` でチャットログに流す。
- **コピペモード**: `handleChatCopy()` が `buildSystemPrompt() + 指示` を組み立てて
  `navigator.clipboard.writeText()` でコピーし、`logCopyPrompt()` で `<details>` に
  折りたたんだプロンプト全文をログへ残す。外部 LLM の回答は `#paste-input` に貼り付け、
  `handlePasteRun()` が `extractCode()` → `runUserCode()` で反映する。
- **API モード**: 既存の `handleChatSend()`(Gemini REST 呼び出し)をそのまま使う。
- `extractCode()` / `renderAiText()` のコードフェンス正規表現は ` ```js ` 等の言語タグに
  限らず ` ```\w*` 全般にマッチするよう緩めてあり、他 LLM が付与するタグ違いのフェンスや
  タグなしフェンスも扱える。

## Gemini 連携
- エンドポイント: `POST /v1beta/models/{model}:generateContent?key=...`
- `systemInstruction` に system プロンプト、`contents` にユーザー指示を入れる。
- 応答 `candidates[0].content.parts[].text` を結合し、コード抽出 → 実行。
- API キー・モデル・system プロンプトは localStorage（`chat3d.settings.v1`）に保存。

## Subutomo 共有 UI
- 左下バッジ: `assets/subutomo-badge.js` + `SUBUTOMO_BADGE_CONFIG`（spctrl-site と同一挙動）。
- 右下フッター: `.su-foot--overlay`（Tip / Sponsors / Feedback）。
- favicon: `assets/favicon.svg` / `favicon-32.png` / `favicon-180.png`。
- `version` は `package.json` と同期し、`?v=` キャッシュバスティングに使う。

## 今後の拡張候補
- 複数メッシュ（部品）管理と選択 UI。
- 生成コード履歴の保存 / 再実行。
- three-csg-ts の演算失敗（非多様体メッシュ等）に対するリカバリ提示。
- glTF / OBJ など STL 以外の入出力。
