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
                              ▲                              ▼
  「編集」タブ ─► withBusy → commitGeometry ─┘  「STL 保存」→ STLExporter(binary)
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

### 実行前ガード（`preflight` / `askConfirm`）
CSG は同期処理なので、**始めてしまったら中止する手段が無い**。JS からブラウザの
ハング画面（`RESULT_CODE_HUNG`）を検知することも、「待機」を促すことも原理的にできない。
したがって**ユーザーに選択肢を出せるのは「始める前」だけ**であり、そこに全てを寄せている。

- `preflight(tris, opLabel)` が入力メッシュの三角形数で規模を判定する。
  - `tris < TRI_WARN(20,000)` — そのまま実行。
  - `TRI_WARN 〜 TRI_CONFIRM(60,000)` — 実行するが `heavy: true` を返し、
    オーバーレイの警告文を「中止できない/数分かかる/待機を選べば続く」に差し替える。
  - `tris >= TRI_CONFIRM` — `askConfirm()` で確認ダイアログを出し、
    承諾されなければ実行しない。既定フォーカスは「やめる」側（誤爆防止）。
- CSG を走らせる経路は 3 つだけで、すべて `preflight` を通る:
  `runUserCode()` / `subtractShape()` / `unionShape()`。
  消しゴムは `subtractShape()` を経由するので自動的にガードされる。
- **CSG は出力の三角形数を増やす**ため、加工を重ねると次の実行がさらに重くなる。
  この因果がユーザーに見えないと「1 回目は成功したのに 2 回目で固まった」としか
  分からないので、`showDebugReport()` に**増減（`+N / +X%`）**と、
  出力が `TRI_WARN` を超えたときの「次の実行はさらに重い」警告行を出している。

### LLM 側での負荷抑制（プロンプトによる予防）
実行前ガードは「重くなってから止める」対策であり、**そもそも重い形状を作らせない**方が
効く。そこで `DEFAULT_SYSTEM_PROMPT` に「計算負荷を抑えるルール」を置き、
分割数の明示（円筒 24 以下 / 球 16×12 程度）、CSG 回数の最小化、移動・回転・拡大縮小に
CSG を使わない（`geometry.translate/rotate/scale` を使う）ことを指示している。
`buildContext()` は**現在の三角形数**も渡し、`TRI_WARN` / `TRI_CONFIRM` を超えていれば
さらに保守的に生成するよう追記する。

ただしこれは**強制力のないソフトな制約**で、LLM が守る保証は無い。あくまで平均的な
悪化の抑制であり、実行前ガード（強制力あり）と併用して初めて意味を持つ。

`DEFAULT_SYSTEM_PROMPT` は `settings.systemPrompt` として localStorage に保存されるため、
既定を更新しても保存済みの環境には届かない。そこで `PROMPT_VERSION` を持たせ、
**ユーザーが手で編集していなければ（`promptEdited === false`）既定の更新に追従**させる。
編集済みの場合は上書きしない（設定タブの「既定に戻す」で追従を再開できる）。

### トースト通知(`showToast`)と STL 保存時の予告
確認を求めない軽い告知には、確認ダイアログ(`askConfirm`)とは別の、自動で消える
トースト(`#toast`)を使う。`downloadStl()` は保存直後に、現在の三角形数と
`TRI_WARN` 以上かどうかに応じて文面を変えて `showToast()` を呼ぶ。

これは実機での不具合報告(Bambu Studio で「三角形が多すぎる」警告 → スライサー側の
簡略化で穴あき発生)を受けて追加した。CSG は結果の三角形数を増やす(A-1)ため、
スライサー側が単純な間引きで簡略化すると水密性が壊れることがある。トーストと
info パネルの「保存した STL をスライサーで開くとき」節で、簡略化ではなく
修復(Repair)機能を先に試すよう案内する。詳細は `docs/known-issues.md` の A-5。

## 指示のヒント（`INSTRUCTION_TEMPLATES` / `INSTRUCTION_LIMITS`）
LLM は読み込んだ形状を見ていないため、指示できる範囲には原理的な制約がある。
チャットタブの「指示のヒント」欄で、成立する指示をクリック引用できるようにしつつ、
成立しない指示（フィレット・シェル化・部位指定など）を理由付きで併記して期待値を揃える。
- 成立する指示＝**全体変形 / bbox 基準 / パラメトリックなパターン / 座標指定**。
  いずれも「原点中心・mm 単位」という前提のみで書けるため、形状を知らなくても正確。
- 形を指し示す指示は通らないので、寸法と座標で伝える。**3D ビューを見て判断するのは
  ユーザーの役割**、という分担がこのツールの前提。

## 直接編集エンジン(「編集」タブ)
チャット/LLM を介さず、マウスと数値入力だけで形を直すための層。すべての操作は
最終的に `commitGeometry(geometry)` に集約される。

```
  UI 操作 ─► withBusy(note, fn) ─► ジオメトリ加工 ─► commitGeometry()
                  │                                       │
       オーバーレイ表示 + nextPaint()        computeVertexNormals
       例外は showError()、finally で解除     → setTargetMesh → pushHistory
                                              → clearParts → updateEditReadout
```

- `withBusy()` は `runUserCode()` と同じ「先に描画してからブロックする」手順を共有する。
  CSG を伴う編集(消しゴム・図形の結合/削り)は同期処理で重いため、この層を必ず通す。
- `updateEditReadout()` は現在の bbox を `#edit-size` に出し、`size-x/y/z` 入力へ
  逆流させる。ただし**フォーカス中の入力は上書きしない**(編集中の値を壊さないため)。

### undo / redo
- `undoStack` はジオメトリのスナップショット配列で、`undoStack[undoIndex]` が**常に現在の
  状態**を指す(差分ではなく実体を持つ)。空シーンは `null` として積む。
- `pushHistory()` は redo 側(`undoIndex` より後ろ)を破棄し、あふれた分は `dispose()` する。
  実体を持つため段数は `UNDO_MAX = 12` に制限している。
- `applyHistoryAt()` はスナップショットを clone して新しいメッシュを作る(スタック内の
  ジオメトリを直接シーンに渡すと、以後の編集で履歴が壊れるため)。
- 入り口は ↶/↷ ボタンと Ctrl+Z / Ctrl+Y。キーハンドラは `e.target` が
  `textarea` / `input` のときは何もせず、ブラウザ標準のテキスト undo を邪魔しない。

### CSG 結果の座標系(`csgOp`)
`three-csg-ts` の `toMesh` は**演算子 A のローカル空間**でジオメトリを返し、`mesh.matrix` に
A の行列を入れて返す。行列を捨てると `targetMesh` が変換を持っていた場合に形がずれるため、
`csgOp()` は必ず `res.geometry.clone().applyMatrix4(res.matrix)` で焼き込んでから返す。

### パーツ分割(`splitConnectedComponents`)
1. 頂点座標を `WELD_PRECISION` で量子化してキー化し、同一座標の頂点を溶接する
   （STL は頂点が三角形ごとに重複しているため、この溶接が無いと分割できない）。
2. 三角形の 3 頂点を Union-Find(経路圧縮)で連結し、連結成分を求める。
3. 根ごとに三角形をバケット分けし、成分ごとの非 index BufferGeometry を作る。
   頂点数の降順に並べるので、一覧の先頭が最大の塊になる。

選択中パーツは橙のワイヤフレーム(`partHighlight`)で重ね描きする。パーツ単位の拡大縮小は
**そのパーツ自身の中心**へ平行移動 → スケール → 戻す、で行い、最後に `mergeGeometries` で
全パーツを 1 つに戻す。ジオメトリを変更すると分割状態は無効になるため、`commitGeometry()`
から `clearParts()` を呼んで一覧を解除する（再度「分割」を押してもらう）。

### 消しゴム
`Raycaster` で交点を取り、その位置に半径指定の球メッシュを置いて `subtractShape()` する。
視点のドラッグ回転と区別するため、`pointerdown` → `pointerup` の移動量が **5px 未満**の
ときだけクリックとみなす。1 クリックごとに CSG が 1 回走るので、密なメッシュでは遅い。

### 図形・テキスト追加
- `buildPrimitive()` — Box / Cylinder / Sphere / Cone をサイズと位置(mm)から生成。
- `buildTextMesh()` — `FontLoader` で helvetiker を 1 度だけ取得してキャッシュし
  (`cachedFont`)、`TextGeometry` で押し出す。r160 の `TextGeometry` は `height` を
  内部で `depth` に読み替えるため `height` を渡す。日本語グリフを持たないフォントなので、
  入力が半角英数記号以外なら実行せずエラーを出す。
- いずれも「結合(`unionShape`)」「削り取り(`subtractShape`)」の両方に流せる。
  空シーンで結合した場合は CSG を通さず、そのメッシュ自体を最初の `targetMesh` にする。

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
- **CSG の Web Worker 化**。メインスレッドが空くのでハング画面が原理的に出なくなり、
  現状は作れない「中止」ボタンも実現できる。実行前ガードはその代替（次善策）である。
- **IndexedDB への自動保存**。現状はリロード/タブ強制終了で作業内容が消える。
- 日本語フォント対応(現状のテキスト追加は半角英数記号のみ)。
- パーツの平行移動・回転(現状は拡大縮小と削除のみ)。
- 生成コード履歴の保存 / 再実行。
- three-csg-ts の演算失敗（非多様体メッシュ等）に対するリカバリ提示。
- glTF / OBJ など STL 以外の入出力。
