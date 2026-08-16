# Chat 3D

ブラウザだけで完結する、**テキスト指示 / コード実行による 3D モデル(STL)生成・編集ツール**の PoC です。
バックエンドはありません。すべて HTML / CSS / Vanilla JavaScript で動きます。

🔗 **公開版:** https://t-sumita.github.io/chat-3d/

## 3 つの使い方

| モード | 概要 |
| --- | --- |
| **STL 編集** | STL / 3MF ファイルをプレビュー領域に **ドラッグ&ドロップ**し、チャット指示で穴あけ・結合などの CSG 加工を行う。3MF は形状のみ読み込み、色情報は無視される。 |
| **ゼロベース生成** | STL を読み込まず、チャット指示だけで Box / Cylinder / Sphere などの基本図形 + CSG からモデルを生成する。 |
| **マニュアルコード実行** | ChatGPT 等で作った JavaScript を「コード直接入力」タブに貼り付け、「実行」でシーンに反映する(Gemini 不使用)。 |

「STL ダウンロード」ボタンで、現在のメッシュをいつでもバイナリ STL として保存できます。

## 使いはじめ

1. リポジトリを開く（ローカルなら任意の静的サーバで配信）。
   ```bash
   # 例: Python の簡易サーバ
   python -m http.server 8000
   # → http://localhost:8000/ を開く
   ```
   > `importmap` と ES Modules を使うため、`file://` 直開きではなく **HTTP 配信**が必要です。
2. **チャット(Gemini)を使う場合**は「設定」タブで Gemini API キーを入力
   （[Google AI Studio](https://aistudio.google.com/app/apikey) で取得）。
   キーは **ブラウザの localStorage にのみ保存**され、Subutomo のサーバには送信されません。
3. チャットに日本語で指示するか、STL を D&D して編集を始めます。

### 指示の例（ゼロベース生成）
- 「一辺 40mm の立方体の中心に、直径 20mm の貫通穴をあけて」
- 「外径 30mm・内径 20mm・高さ 15mm のパイプを作って」

### 指示の例（STL 編集）
- 「上面の中央に直径 10mm の穴を深さ 5mm であけて」
- 「全体を 1.2 倍に拡大して」

## 技術スタック
- **3D 描画:** [Three.js](https://threejs.org/) r160（CDN + importmap）
- **ブーリアン演算:** [three-csg-ts](https://github.com/samalexander/three-csg-ts) 3.2.0
- **LLM:** Gemini API（REST、ブラウザから直接呼び出し）

依存はすべて CDN から解決するため、**ビルド不要**。`index.html` を静的配信するだけで動きます。

## 動的コード実行の契約
チャット/コード直接入力で実行される JS には、次が引数として渡されます。

| 変数 | 内容 |
| --- | --- |
| `scene` | 表示中の `THREE.Scene` |
| `THREE` | Three.js 名前空間 |
| `CSG` | three-csg-ts の `CSG` クラス（`union` / `subtract` / `intersect`） |
| `targetMesh` | 現在の操作対象メッシュ（無ければ `null`） |
| `setResult(mesh)` | 完成メッシュを 1 つ登録する関数 |

- 完成メッシュは必ず `setResult(mesh)` で登録します（`scene` への add は不要）。
- CSG 演算の前に、関与する各メッシュで `mesh.updateMatrix()` を呼んでください。

```js
// 立方体に貫通穴をあける例
const box = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40));
const hole = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 60, 32));
box.updateMatrix();
hole.updateMatrix();
setResult(CSG.subtract(box, hole));
```

## ⚠ セキュリティに関する注意
本ツールは指示された JavaScript を `new Function` で**そのまま実行**します。これは本質的に
任意コード実行であり、PoC としての利便性を優先した設計です。**信頼できないコードを貼り付けて
実行しない**でください。第三者に公開・共有する用途は想定していません。

## 開発
プロジェクトのルール・設計方針は [`CLAUDE.md`](./CLAUDE.md) を参照してください。
補足ドキュメントは [`docs/`](./docs/) にあります。

## ライセンス
MIT © Subutomo Dev
