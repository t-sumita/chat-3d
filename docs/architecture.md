# アーキテクチャ / 設計メモ

Chat 3D は「UI 骨格(index.html)」「中核ロジック(main.js)」「テーマ(style.css)」の
3 ファイルで構成される。ビルド工程は無く、依存は importmap で CDN から解決する。

## 処理フロー

```
                ┌─────────────────────────────┐
  STL D&D  ──►  │  loadStlFile → setTargetMesh │
                └─────────────┬───────────────┘
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
