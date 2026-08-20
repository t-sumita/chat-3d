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
- `runUserCode(code)` — `new Function('scene','THREE','CSG','targetMesh','setResult','mergeMeshes','createTextMesh', code)` で実行。
  - `setResult(mesh)` 優先、無ければ `return` 値をメッシュとして採用。
  - 例外は `showError()` で UI にスタックトレースを表示（握りつぶさない）。

### 立体テキストのヘルパー注入（`createTextMesh`）
実行コンテキストには `FontLoader` / `TextGeometry` / フォントを渡していないため、LLM や
貼り付けコードは自前で 3D 文字を作れない。そこで「文字列・サイズ・厚み・位置・向き」だけを
受け取り、フォント読込・グリフ幾何・分割数(印刷では効かないため `curveSegments:2` 固定)を
アプリ側で担う `createTextMesh(opts)` を注入する。凸(浮き彫り)/凹(彫り込み)は、返った
メッシュを呼び出し側が `CSG.union` / `CSG.subtract` のどちらに渡すかで選ぶ。
- フォントは起動時に `loadTextFont()` で事前ロードし、ヘルパーは**同期**で使える。
  未ロード(ネットワーク遅延など)なら `err.fontLoading` を投げて再実行を促す。
- 半角英数記号のみ(helvetiker に日本語グリフが無い)。編集タブの直接テキスト追加
  (`buildTextMesh`)と制約は共通だが、そちらは中央固定+Y位置のみ、こちらは任意の
  位置・向きを取れる点が異なる。システムプロンプト(`DEFAULT_SYSTEM_PROMPT_*`)に
  使い方を明記し、`PROMPT_VERSION` を上げて配布する。

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

### 三角形数の削減戦略（実測付き）
スライサー側の簡略化・修復では必要な形状まで削られ実用にならないことが分かったため
（`known-issues.md` A-5）、**増えてから減らすのではなく最初から作らせない**方針に振り切った。
`DEFAULT_SYSTEM_PROMPT` の「三角形数を最小化するルール」は、効果の大きい順に手順化してある。

| 手順 | 内容 | 狙い |
| --- | --- | --- |
| 1 | **CSG を使わない構成を先に検討** — 断面一定なら `Shape.holes` + `ExtrudeGeometry`、回転対称なら `LatheGeometry` | CSG 0 回 |
| 2 | **CSG 回数の最小化** — 切削体を `mergeMeshes()` でまとめ `subtract` は 1 回 | 再分割回数を削減 |
| 3 | **分割数を半径に応じて最小化** — 半径 2/5/10/25mm → 8/12/16/24 分割 | 入力を軽く |
| 4 | **形の妥協** — フィレットよりチャンファー、装飾を足さない | 曲面を減らす |
| 5 | 作法 — 貫通穴は 0.5mm 以上はみ出させる（同一平面を避ける） | 不正三角形の防止 |

60×40×5mm の板に φ5mm の穴を 4 つあける例での実測（node + three r160 + three-csg-ts 3.2.0）:

| 方式 | 三角形数 | 所要 |
| --- | --- | --- |
| A. 素朴版（32 分割・`subtract` 4 回） | 6,727 | 409 ms |
| B. 分割数のみ 12 に削減（`subtract` 4 回） | 1,254 | 38 ms |
| C. B + `mergeMeshes` で `subtract` 1 回 | **430** | 29 ms |
| D. `ExtrudeGeometry` + `holes`（CSG 0 回） | **412** | 24 ms |

A → C で三角形数は **6%（94% 削減）**。分割数の削減（A→B）だけでも効くが、
CSG 回数の削減（B→C）がさらに 3 分の 1 にしている。両方必要。

分割数の根拠は弦誤差。半径 r を N 角形で近似したときの誤差は `r(1-cos(π/N))`。
積層ピッチ以下（0.1〜0.2mm）の誤差は印刷結果に現れないため、そこを下回る最小の N を選ぶ。

### `mergeMeshes()`（CSG を使わない合成）
`subtract` は 1 回ごとにメッシュ全体を BSP で再分割するため、穴 N 個を N 回の
`subtract` で処理すると爆発的に重くなる。`mergeMeshes()` は各メッシュの行列を焼き込み、
`toNonIndexed()` で index の有無を揃え、`position`/`normal`/`uv` に属性を正規化してから
`mergeGeometries()` する（属性構成や index の有無が混在すると合成に失敗するため）。

**面を寄せ集めるだけなので、形状が重なっていると内部に面が残る。** 離れた切削体専用で、
重なる形状の合成には `CSG.union` が必要。この使い分けはプロンプトにも明記している。

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
`guide.html`(使い方ガイド)の「「三角形が多すぎる」と言われたら」節で、**簡略化を使わず、
そのままスライスできるなら何もしない**よう案内する。詳細は `docs/known-issues.md` の A-5。

v0.9.1 で `makeWatertight()` が水密化まで面倒を見るようになったため、この文面から
「スライサーの修復機能を先に試す」という案内は外した(保存した STL は既に水密で、
Bambu Studio がエラーを出さないことを実測で確認済み)。修復に関する注意は
`guide.html` の「それでも修復を促されたら」節へ降格してある。

### 水密化(`makeWatertight`) — STL 保存時の T ジャンクション修復

**なぜ必要か。** BSP 方式の CSG は、面を平面で切るときに「切られた面の**隣の面**」までは
切らない。その結果、辺の途中に他の面の頂点が乗った状態(**T ジャンクション**)が残る。
幾何的な隙間はないが、面どうしが頂点を共有しないため、スライサーからは
「つながっていない=面が欠けている」と見える。

これは我々の使い方の問題ではなく**ライブラリの性質**であることを実測で確認した
(`CSG.subtract` を 1 回掛けただけで境界エッジ 79 本。`three-bvh-csg` でも同様に発生)。
切削体を 0.5mm はみ出させても改善しない(むしろ増える)。詳細は `known-issues.md` の A-6。

**アルゴリズム(1 パス)。**
1. 頂点を `WELD_PRECISION`(1e4 = 0.0001mm)で量子化して溶接する。
2. 空間ハッシュ(`WELD_CELL` = 0.5mm)を張り、各辺の近傍頂点だけを候補にする。
3. 辺 (a,b) について、線分上への射影パラメータ `t` が (0,1) の内側で、かつ
   線分までの距離が `ON_EDGE_EPS`(1e-4mm)以下の頂点を「辺の上に乗っている」とみなす。
4. 3 辺それぞれの分割点を順に並べた多角形を作り、**扇状に貼り直す**
   (元の三角形は平面なので扇分割で形は変わらない)。
5. 最後に、**同じ 3 頂点で向きだけが逆の面の組**(厚みゼロの「内部の壁」)を組ごと削除する。
   表と裏が背中合わせに重なった膜で体積には寄与しないが、放置すると 1 本の辺を
   4 面以上が共有する**非多様体エッジ**になる(v0.9.1)。

**設計上の注意(実測に基づく、変更するとデグレする)。**
- **`ON_EDGE_EPS` を緩めてはいけない。** 1e-4 → 1e-2mm にすると三角形 +336%、
  境界エッジも 4 → 59 本に**増える**。
- **溶接は「グリッド量子化」のままにする。** 近傍セルまで見る「許容誤差つき溶接」は
  細い三角形を潰し、12 万三角形で境界エッジが 14 → 432 本に増える。
  小さいモデルだけで判断すると逆の結論が出るので、規模別に測ること。
- **面積ゼロの三角形を除去してはいけない。** 辺を分割した痕として位相をつないでおり、
  除去すると境界エッジが復活する(実測: 0 → 91)。
- **辺の分割点キャッシュは必ず `lo→hi` の向きで作る。** 呼ばれた順に向きが変わると
  多角形の頂点順が壊れ、面数は同じなのに境界エッジが残る(実装時に踏んだ)。
- **`mergeVertices` では直らない。** 頂点の微小なずれが原因ではないため、
  溶接精度を 1e-6〜1e-2mm まで振っても境界エッジはほとんど減らない。

**適用箇所は `downloadStl()` のみ。** 作業中のメッシュは軽いまま保ちたいので、
CSG のたびには掛けない(掛けると三角形増加が複利で効いてしまう)。
メインスレッドを占有するので `withBusy()` でオーバーレイを出す。

**実測(v0.9.1)。** 20mm ダイス(2,240 面): 境界エッジ 1,316 → **0**、
非多様体エッジ 17 → **0**、三角形 +31%、
体積 7767.1081 → 7767.1081 mm³(差 1.2e-5)、bbox 完全一致。
12 万三角形: 残存 14 本 / 三角形 +3% / 約 4 秒。

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

### 表示補助(グリッド/軸)と座標ピック(v0.11.0)
LLM は形を見ていないため、位置は座標(mm)でしか伝えられない。その座標を目分量ではなく
モデル表面のクリックから読み取れるようにしたもの。

- **グリッド/軸**: `initThree()` で作った `GridHelper` / `AxesHelper` をモジュール変数
  (`gridHelper` / `axesHelper`)に持ち、`setGuides(on)` が `visible` を切り替える。
  寸法は `GRID_SIZE` / `GRID_DIV` / `AXES_LENGTH` の定数。凡例(`view.legend`)へ出す
  「1 マス = N mm」は `GRID_SIZE / GRID_DIV` から算出するので、定数を変えれば表示も追従する。
- **座標ピック**: **Shift + クリック**で `pickAtPointer()`。`Raycaster` の交点(`hit.point`)を
  `pickPoint` に控え、マーカー(`pickMarker`)を置いて吹き出し(`#pick-callout`)を出す。
- **なぜモードにしないか**: 消しゴムと座標ピックはどちらもクリックを消費する。両方を ON/OFF の
  モードにすると、排他にしたところで「今どちらが動くか」を利用者が覚えていられない。修飾キーなら
  押している間だけ切り替わるので取り合いが起きず、消しゴム ON のままでも座標を読める。
  修飾キーに **Shift** を選んだのは、Ctrl が macOS で右クリック扱いになること、
  Ctrl+Z / Ctrl+Y を undo/redo で使っていること、OrbitControls が Shift を使わないため。
  `pointerdown` / `pointerup` のどちらかで Shift を握っていればピックとみなす(取りこぼし防止)。
- **修飾キーは画面に出ない**ため、代わりの手がかりを 2 つ置く。凡例の常設案内
  (`view.pickHint`、グリッドを消しても残す)と、Shift 押下中だけ変わるカーソル
  (`#viewport.picking canvas { cursor: cell }`。消しゴムの `crosshair` に勝つよう CSS の
  後ろに置く)。`keydown` / `keyup` に加えて `blur` でもクラスを外す(Alt+Tab で
  `keyup` が来ず、押しっぱなし表示のまま残るため)。
- 使い方の案内(`view.pickGuide`)とモデル未読み込みの案内(`view.pickNoMesh`)は、
  `pickGuideShown` / `pickNoMeshShown` で**セッション中 1 回だけ**ログへ出す。
  モードの ON 契機が無いぶんログに出す回数を絞らないとうるさい。
- **吹き出しの追従**: `animate()` から毎フレーム `updatePickCallout()` を呼び、`pickPoint` を
  `camera` で投影して `left` / `top` を書き換える。**rAF 内で Vector3 を作らない**ため
  投影用の `pickProj` はモジュール定数、ビューポートのサイズも毎フレーム計測せず
  `vpW` / `vpH`(`initThree` / `onResize` で更新)を使う。`pickProj.z > 1`(カメラの裏)なら
  `.behind` を付けて隠す。
- **マーカー**: 使い回す 1 個の球。`depthTest: false` + `renderOrder = 999` でモデルに埋もれない。
  半径はモデル最大辺の `PICK_MARKER_RATIO` 倍(最小 `PICK_MARKER_MIN` mm)。
- `setTargetMesh()` は `hidePick()` を呼ぶ。差し替え後の表面に同じ点があるとは限らないため。

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
- 既定は `'copy'`(コピペモード)。API モードは単純な指示向けという位置づけで、
  `guide.api` のガイド文言に「複雑な指示(寸法の調べ物・計算が要るもの)は応答に
  時間がかかり、Gemini 混雑時に 503 になりやすいのでコピペモード推奨」と明記する
  (v0.12.1)。実装は文言での案内のみで、複雑さの自動判定はしない(誤判定を避けるため)。
  503 発生時は `callGemini()` が `err.status = 503` を付けて投げ、`handleChatSend()` の
  catch でコピペモードへの切替を促す `msg.geminiBusy` をチャットログに追加で出す。
  なお `contents` には毎回そのユーザー指示 1 件だけを送っており、過去の会話履歴は
  含めていない(トークン量は指示の長さに比例するだけで、やり取りを重ねても増えない)。

## Gemini 連携
- エンドポイント: `POST /v1beta/models/{model}:generateContent?key=...`
- `systemInstruction` に system プロンプト、`contents` にユーザー指示を入れる。
- 応答 `candidates[0].content.parts[].text` を結合し、コード抽出 → 実行。
- API キー・system プロンプトは localStorage（`chat3d.settings.v1`）に保存。

### モデル名は固定文字列で持たない(v0.12.0)
Google は個別のモデル ID(`gemini-2.5-flash` 等)を新規ユーザー向けに随時廃止しており、
固定文字列やエイリアス(`gemini-flash-latest` 等)をコードに埋め込んでも、いずれ同じ
404 で壊れる。そのため実在するモデルは `GET /v1beta/models?key=...`
(`listGeminiModels()`)から毎回取得し、次のルールで解決する。
- `settings.model` が空文字列(既定・「自動」)なら、一覧から `generateContent` 対応 かつ
  `flash` 系(TTS/画像/音声/ライブ/embedding/vision 系は除外)のうち、バージョン番号が
  最大のものを `pickLatestFlashModel()` で選ぶ(`preview`/`exp`/`thinking`/`-lite` は
  同点なら劣後させる)。結果はページ読み込み中だけ `cachedAutoModel` に保持し、
  **localStorage には保存しない**(保存すると解決結果自体が新たな固定文字列になり、
  廃止されたときに今回と同じ問題を繰り返すため)。
- 設定タブの「モデル」欄でユーザーが具体的なモデルを選んだ場合のみ `settings.model` に
  保存する(明示的な選択は尊重してよい意図的な上書きのため)。この一覧も
  `listGeminiModels()` の結果で動的に作る(`refreshModelOptions()`、API キー入力時と
  更新ボタンで再取得)。保存済みの選択が一覧から消えていたら(廃止された等)自動で
  「自動」へ戻す。

## 多言語化(`i18n.js`、v0.10.0)

### 文言の置き場所を 2 つに分けている
| 置き場所 | 対象 | 理由 |
| --- | --- | --- |
| `i18n.js` の `JA` / `EN` 辞書 | **画面表示の文言**(ボタン・ラベル・トースト・エラー・`guide.html` 本文) | 対訳が 1 対 1 で並ぶので抜けに気づける |
| `main.js` の `*_JA` / `*_EN` 定数 | **LLM に渡すもの**(`DEFAULT_SYSTEM_PROMPT` / `INSTRUCTION_TEMPLATES` / `INSTRUCTION_LIMITS` / `SAMPLE_CODE`) | 三角形数を抑えるルールの調整はプロンプトの本文と一緒に読めた方が速い(CLAUDE.md のルール) |

`main.js` からは直に定数を参照せず、`defaultSystemPrompt()` / `sampleCode()` /
`instructionTemplates()` / `instructionLimits()` 経由で現在言語のものを取る。
「未編集かどうか」の判定は `isDefaultPrompt()` / `isSampleCode()` が**両言語と突き合わせる**
(ja の既定文のまま en に切り替えたとき「編集済み」と誤判定しないため)。

### DOM への反映
- `index.html` の静的な文言は `data-i18n`(textContent)/ `data-i18n-html`(innerHTML)/
  `data-i18n-title`(title)/ `data-i18n-ph`(placeholder)属性で指定し、
  `applyStaticI18n()` が一括で書き換える。`<html lang>` / `<title>` / meta description も更新する。
- JS が組み立てる文言は `t(key, params)`。`{name}` 形式のプレースホルダを置換する。
  キーが両辞書に無ければ**キー名をそのまま返す**(空文字にすると欠落に気づけない)。

### 切り替えは「再読み込みしない」
`setLang()` は localStorage に保存 → `applyStaticI18n()` → `onLangChange()` の購読者を呼ぶ。
**ページはリロードしない。**リロードすると作業中のメッシュと undo 履歴が消えるため。
購読側の `relocalize()` が、JS が組み立てた部分だけを作り直す:
`updateBadges()` / `updateEditReadout()` / `setEraser(eraserOn, false)` /
`setChatMode(chatMode, false)` / `initHintLibrary()` / `renderPartsList(false)`。
第 2 引数の `announce` はチャットログへの通知を抑えるためのもので、
**これが無いと言語を切り替えるたびに同じガイドがログへ積み上がる。**

### 注意点
- `i18n.js` は `index.html` が `main.js` に、`guide.html` が `guide-init.js` に付けた
  `?v=` を引き継いで**動的 import** する。静的 `import` だと `?v=` が付かず、
  バージョンを上げても古い辞書がキャッシュから使われる。
- 文言を追加するときは **ja と en の両方に必ず入れる**。片方だけだと `t()` が JA へ
  フォールバックし、英語 UI に日本語が混ざる。
- `textContent` に入る値に `&amp;` のような HTML 実体参照を書かない(そのまま表示される)。
  実体参照が要るのは `data-i18n-html` の値だけ。
- コールバックの仮引数に `t` を使わない(i18n の `t()` を隠す)。

## 使い方ガイド(guide.html、v0.14.0)
以前は `index.html` 右上の「i」ボタンから開く小さな info パネル(280px 幅・70vh 上限の
ドロップダウン)だった。CSG・座標・水密化・三角形数対策・立体テキストなど内容が
増え続け、小さなパネルに収まらなくなったため、別ページ `guide.html` に切り出した。

- ボタンは `#btn-guide`(`.guide-btn`、「?」)。トグルではなく `<a href="guide.html"
  target="_blank">` の**ただのリンク**なので、開閉状態を管理する JS が不要になった
  (以前の `setInfoOpen()` / クリック外側判定は削除済み)。
- `guide.html` は `main.js`(Three.js / CSG / 動的実行エンジン)を読み込まない。
  作業中のシーンとは無関係な静的ページのため、3D 関連の依存を持ち込む理由がない。
  文言の適用と言語切替だけを行う `guide-init.js` を読む。
- `style.css` を共有する。ただし `html, body { overflow: hidden; height: 100% }` は
  `#app` の固定ビューポート前提の指定なので、`guide.html` 側は `body.gp-page` で
  上書きして通常の縦スクロール記事にしている。
- 見出し・注記のクラス名は `.info-h` / `.info-note`(info パネル時代の名残)から
  `.gp-h` / `.gp-note` に変更した。
- 本文は 1 つの `data-i18n-html` キー(`gp.body`)にまとめている(info パネル時代と
  同じ構成)。セクションを増やすときは `<p class="gp-h">見出し</p>` を追加するだけでよい。
- 共有フッター/バッジ/favicon は `index.html` と同様に持たせる(CLAUDE.md の方針どおり、
  単独ページでも Subutomo サイト群の一員として振る舞う)。

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
