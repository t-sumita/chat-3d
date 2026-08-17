// main.js — Chat 3D の中核ロジック
// 3D プレビュー / STL 入出力 / 動的コード実行エンジン / Gemini 連携をまとめる。
// バックエンドは一切持たず、すべてブラウザ内で完結する。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
// 標準の 3MFLoader は複数パート構成の 3MF で component 参照が解決できず落ちるため、
// パッチ版(vendor/3MFLoader.js)を使う。詳細はファイル冒頭のコメントを参照。
import { ThreeMFLoader } from './vendor/3MFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { CSG } from 'three-csg-ts';

// ─────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────

const LS_KEY = 'chat3d.settings.v1';          // localStorage キー
const MODEL_COLOR = 0x9ec5ff;                  // 生成メッシュの既定色
const EXEC_HISTORY_MAX = 20;                   // 所要時間の推定に使う実行履歴の保持件数
const UNDO_MAX = 12;                           // undo 履歴の保持段数(ジオメトリ実体を持つため控えめ)
const PROMPT_VERSION = 3;                      // DEFAULT_SYSTEM_PROMPT を更新したら上げる
const TRI_WARN = 20000;                        // これを超えたら「重い処理」として強い警告を出す
const TRI_CONFIRM = 60000;                     // これを超えたら実行前に明示的な確認を求める
const WELD_PRECISION = 1e4;                    // パーツ分割時に頂点を同一視する量子化精度
const TEXT_FONT_URL =                          // テキスト生成用フォント(半角英数のみ)
  'https://unpkg.com/three@0.160.0/examples/fonts/helvetiker_regular.typeface.json';

// LLM にコードを書かせるためのシステムプロンプト・テンプレート。
// 開発者が後から調整しやすいよう、ここに定数として明示的に定義する。
// {{CONTEXT}} は送信直前にシーン状態(空 or targetMesh あり)で差し替える。
const DEFAULT_SYSTEM_PROMPT = `あなたは Three.js と three-csg-ts に精通した 3D モデリングアシスタントです。
ユーザーの日本語指示を、ブラウザ上で即実行できる JavaScript コードに変換します。

# 実行環境
- コードは new Function 経由で実行され、次の引数が渡されます:
  - scene      : THREE.Scene(表示中のシーン)
  - THREE      : Three.js 名前空間(r160)
  - CSG        : three-csg-ts の CSG クラス
  - targetMesh : 現在の操作対象メッシュ(存在しない場合は null)
  - setResult  : setResult(mesh) で最終メッシュを1つ登録する関数
  - mergeMeshes: mergeMeshes([mesh, ...]) で複数メッシュを CSG を使わず1つに合成する関数
                 (重なっていない形状専用。複数の切削体をまとめて subtract を1回に減らす用途)
- 単位は mm を 1 とみなして数値を組み立ててください(例: 40mm = 40)。

# 厳守するルール
1. 最終的な完成メッシュを必ず setResult(mesh) で 1 つだけ登録すること。
   scene への add / remove は自分で行わず、setResult に任せること。
2. CSG 演算(union/subtract/intersect)の前に、関与する各メッシュで
   必ず mesh.updateMatrix() を呼び、位置・回転を行列へ反映すること。
   例: CSG.subtract(box, hole)  ※ box, hole ともに updateMatrix 済み。
3. マテリアルは付けても付けなくても構いません(未指定なら側で付与)。
4. import 文・関数定義の外枠・説明文・markdown 見出しは書かないこと。
   返答は次の1つの \`\`\`js コードブロックのみ。前後に文章を付けないこと。

# 三角形数を最小化するルール(最重要)
生成物は 3D プリンタで印刷されます。積層される以上 0.1〜0.2mm より細かい凹凸は
印刷結果に現れないため、滑らかさに三角形を使っても無駄になります。
一方、三角形が多いと(1) 実行が数分かかりブラウザが落ちる (2) スライサーが警告を出し、
そこで簡略化すると穴が開いて壊れる、という実害が出ています。

**多少カクついても、三角形数が少ない形を優先してください。** 次の順に検討します。

## 手順1: そもそも CSG を使わずに作れないか、最初に検討する(効果が最大)
CSG は 1 回ごとにメッシュ全体を再分割するため、使わずに済むならそれが常に最良です。
- **断面が一定の形**(板・ブラケット・スペーサー・ガスケット・押し出し形状)
  → THREE.Shape に .holes を付けて ExtrudeGeometry。**穴あき板が CSG 0 回で作れます。**
- **回転対称の形**(パイプ・筒・ノブ・カップ・段付き軸)
  → THREE.LatheGeometry。中空でも CSG 0 回です。
- 移動・回転・拡大縮小・反転 → geometry.translate() / rotateX() / scale() を使う。
  これらに CSG は不要です。

穴が4つある板を CSG 0 回で作る例:
  const s = new THREE.Shape();
  s.moveTo(-30, -20); s.lineTo(30, -20); s.lineTo(30, 20); s.lineTo(-30, 20);
  for (const [x, y] of [[-20,-10],[20,-10],[-20,10],[20,10]]) {
    const h = new THREE.Path();
    h.absarc(x, y, 2.5, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  const g = new THREE.ExtrudeGeometry(s,
    { depth: 5, bevelEnabled: false, steps: 1, curveSegments: 12 });

## 手順2: CSG が必要なら、呼び出し回数を最小にする
- **穴・切り欠きが複数あるときは、切削体を mergeMeshes([...]) で 1 つにまとめ、
  subtract は 1 回だけ**にすること。3 回の subtract より 1 回の方が圧倒的に軽い。
  ※ mergeMeshes は互いに重なっていない形状専用(重なる場合のみ CSG.union)。
- ループで多数のメッシュを作り 1 つずつ CSG するのは絶対に避けること。

## 手順3: 分割数(segments)は必ず明示し、半径に応じた最小値にする
既定値(32 等)は装飾用途で過剰です。次を守ってください。
- CylinderGeometry / ConeGeometry / 円弧の radialSegments:
    半径 2mm 以下 → 8 / 5mm 以下 → 12 / 10mm 以下 → 16 / 25mm 以下 → 24 / それ超 → 32
- SphereGeometry は (半径, 12, 8)。大きい球でも (16, 10) まで。
- BoxGeometry / PlaneGeometry の分割数は 1(既定のまま。増やす理由はありません)。
- CylinderGeometry / ConeGeometry の heightSegments は 1。
- ExtrudeGeometry は steps: 1、bevelEnabled: false。
- TextGeometry は curveSegments: 2、bevelEnabled: false。
- TorusGeometry など元から分割数が多い形状は避ける。使うなら (8, 16) 程度。

## 手順4: 形の要求は軽い方に倒す
- **フィレット(丸み)より面取り(チャンファー)を優先すること。**
  丸みは分割数ぶん三角形を消費しますが、面取りは平面なのでほぼ無料です。
  「角を丸めて」と言われても、丸みが明確に必要でなければ面取りで実現して構いません。
- ローレット・ネジ山・細かい模様・装飾ディテールは三角形数が爆発するため、
  指示に明示が無ければ足さないこと。

## 手順5: CSG を使うときの作法
- 貫通穴の切削体は、両端を 0.5mm 以上はみ出させること。面がぴったり重なると
  不正な三角形が生まれ、STL が壊れる原因になります。
- openEnded は false のままにすること(CSG には閉じた立体が必要です)。

# 出力フォーマット
\`\`\`js
// ここに実行可能な処理本体だけを書く(トップレベル文として)
\`\`\`

{{CONTEXT}}`;

// 指示のヒント。LLM は形状を直接見られないため、「形を見なくても成立する指示」＝
// 全体変形 / bbox 基準 / パラメトリックなパターン / 座標指定 に限って例を出す。
// クリックでチャット入力欄に引用される。
const INSTRUCTION_TEMPLATES = [
  {
    title: '全体変形(確実に動く)',
    items: [
      '全体を 1.2 倍に拡大して',
      'Z 方向だけ 1.5 倍に引き伸ばして',
      'X 軸まわりに 90 度回転して',
      '左右反転(ミラー)して',
    ],
  },
  {
    title: 'bbox 基準の加工(ほぼ確実)',
    items: [
      '中心に直径 20mm の貫通穴をあけて',
      '上面の中央に直径 10mm・深さ 5mm のザグリを入れて',
      'Z=0 の平面で切って、上半分だけ残して',
      '底面に厚さ 3mm・一回り大きい台座を追加して',
      '一辺 50mm の立方体で intersect して、はみ出しを削って',
    ],
  },
  {
    title: 'パターン(確実に動く)',
    items: [
      '中心から半径 25mm の円周上に、直径 5mm の穴を 6 個等間隔であけて',
      '10mm ピッチの格子状に直径 3mm の穴を並べて',
      '側面に幅 2mm のリブを 4 本、90 度おきに追加して',
    ],
  },
  {
    title: '座標を指定して追加・削除(確実に動く)',
    items: [
      '(15, 0, 20) に直径 8mm・高さ 10mm の円柱を生やして',
      '(0, 10, 0) を中心に一辺 12mm の立方体を引いて',
    ],
  },
];

// LLM は読み込んだ形状を「見て」いないため、原理的に指示できないこと。
// 期待値をあらかじめ揃えるために UI 上で明示する。
const INSTRUCTION_LIMITS = [
  { what: 'この突起を削除して', why: '形状認識の仕組みが無く、部分を指し示せない' },
  { what: '角を丸めて(フィレット)', why: 'three-csg-ts にフィレット機能が無い' },
  { what: '肉厚 2mm でシェル化して', why: 'オフセット形状の生成に対応していない' },
  { what: '一番大きい面に穴を', why: '面を認識・選択できない' },
  { what: '元の形に合わせていい感じに', why: '元形状が見えないので「合わせる」判断ができない' },
];

// コード直接入力タブに最初から入れておくサンプル(Box ∪ Sphere)。
const SAMPLE_CODE = `// 60x40x6mm の板に、直径6mm の穴を2つあける例。
// 穴ごとに subtract せず、切削体をまとめて CSG は1回だけにする(三角形数の抑制)。
const plate = new THREE.Mesh(new THREE.BoxGeometry(60, 40, 6));

// 半径3mm なので分割は12で十分。板(厚6)より長い10mm にして確実に貫通させる
const holes = [-18, 18].map((x) => {
  const h = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 10, 12));
  h.rotation.x = Math.PI / 2;      // 円柱の軸(Y)を Z 方向へ倒す
  h.position.set(x, 0, 0);
  return h;
});

// 離れた切削体は CSG を使わず合成できる(こちらは軽い)
const cutter = mergeMeshes(holes);

// CSG 前に行列を確定させる(重要)
plate.updateMatrix();
cutter.updateMatrix();

setResult(CSG.subtract(plate, cutter));`;

// ─────────────────────────────────────────────────────────────
// 状態
// ─────────────────────────────────────────────────────────────

let scene, camera, renderer, controls;
let targetMesh = null;                          // 現在の操作対象メッシュ
let settings = loadSettings();

// ─────────────────────────────────────────────────────────────
// Three.js セットアップ
// ─────────────────────────────────────────────────────────────

function initThree() {
  const viewport = document.getElementById('viewport');

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    45, viewport.clientWidth / viewport.clientHeight, 0.1, 5000);
  camera.position.set(80, 80, 120);

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // ライト: 環境光 + 方向光2灯で立体感を出す
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(60, 100, 80);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
  fill.position.set(-80, -30, -60);
  scene.add(fill);

  // 補助グリッドと軸(モデリングの基準)。グレー背景でも視認できる明るさにする。
  const grid = new THREE.GridHelper(200, 20, 0x8890a0, 0x4a4f5c);
  grid.material.opacity = 0.6;
  grid.material.transparent = true;
  scene.add(grid);
  scene.add(new THREE.AxesHelper(30));

  window.addEventListener('resize', onResize);
  animate();
}

function onResize() {
  const viewport = document.getElementById('viewport');
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────
// メッシュ管理
// ─────────────────────────────────────────────────────────────

/** 既定マテリアルを生成する(両面描画で CSG の断面も見えるように) */
function defaultMaterial() {
  return new THREE.MeshStandardMaterial({
    color: MODEL_COLOR, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide,
    flatShading: false,
  });
}

/** メッシュの geometry / material を破棄してメモリを解放する */
function disposeMesh(mesh) {
  if (!mesh) return;
  if (mesh.geometry) mesh.geometry.dispose();
  if (mesh.material) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => m.dispose());
  }
}

/**
 * 操作対象メッシュを差し替える。旧メッシュはシーンから外して破棄する。
 * @param {THREE.Mesh|null} mesh 新しい対象(null でクリア)
 * @param {boolean} frame カメラを新メッシュにフィットさせるか
 */
function setTargetMesh(mesh, frame = true) {
  if (targetMesh) {
    scene.remove(targetMesh);
    disposeMesh(targetMesh);
  }
  targetMesh = mesh || null;

  if (targetMesh) {
    if (!targetMesh.material || targetMesh.material.isMeshBasicMaterial) {
      targetMesh.material = defaultMaterial();
    }
    // ジオメトリを原点中心へ寄せておくと以降の操作が扱いやすい
    targetMesh.geometry.computeVertexNormals();
    scene.add(targetMesh);
    if (frame) frameObject(targetMesh);
  }
  updateBadges();
}

/** 対象メッシュのバウンディングボックスサイズ(mm)を返す */
function meshSize(mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  box.getSize(size);
  return size;
}

/** カメラを対象オブジェクトにフィットさせる */
function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 50;
  const dist = maxDim * 2.4;
  camera.position.copy(center).add(new THREE.Vector3(dist, dist * 0.8, dist));
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// ─────────────────────────────────────────────────────────────
// undo / redo(ジオメトリのスナップショットを保持する)
// ─────────────────────────────────────────────────────────────

/** @type {Array<THREE.BufferGeometry|null>} undoStack[undoIndex] が常に現在の状態 */
const undoStack = [];
let undoIndex = -1;

/** 履歴を初期化する(モデル読み込み・クリア時)。現在状態を最初の1件として積む */
function resetHistory() {
  undoStack.forEach((g) => g && g.dispose());
  undoStack.length = 0;
  undoStack.push(targetMesh ? targetMesh.geometry.clone() : null);
  undoIndex = 0;
  updateHistoryButtons();
}

/** 現在のジオメトリを履歴に積む。redo 分岐は破棄される */
function pushHistory() {
  // 現在位置より先(redo 側)を捨ててから積む
  undoStack.splice(undoIndex + 1).forEach((g) => g && g.dispose());
  undoStack.push(targetMesh ? targetMesh.geometry.clone() : null);
  // 上限超過分は古い方から捨てる
  while (undoStack.length > UNDO_MAX) {
    const old = undoStack.shift();
    if (old) old.dispose();
  }
  undoIndex = undoStack.length - 1;
  updateHistoryButtons();
}

/** 履歴の指定位置を画面に反映する(スナップショットは複製して渡す) */
function applyHistoryAt(index) {
  const snap = undoStack[index];
  undoIndex = index;
  if (!snap) {
    setTargetMesh(null);
  } else {
    setTargetMesh(new THREE.Mesh(snap.clone(), defaultMaterial()), false);
  }
  clearParts();
  updateHistoryButtons();
  updateEditReadout();
}

function undo() {
  if (undoIndex <= 0) return;
  applyHistoryAt(undoIndex - 1);
}

function redo() {
  if (undoIndex >= undoStack.length - 1) return;
  applyHistoryAt(undoIndex + 1);
}

/** undo/redo ボタンの活性状態を更新する */
function updateHistoryButtons() {
  const u = document.getElementById('btn-undo');
  const r = document.getElementById('btn-redo');
  if (!u || !r) return;
  u.disabled = undoIndex <= 0;
  r.disabled = undoIndex >= undoStack.length - 1;
}

// ─────────────────────────────────────────────────────────────
// 直接編集(チャット不要の WYSIWYG 操作)
// ─────────────────────────────────────────────────────────────

/**
 * 重い同期処理をオーバーレイ付きで実行する。
 * 実行前に1フレーム描画を挟み、「固まった」という誤認を防ぐ。
 */
async function withBusy(note, fn, heavy) {
  setExecOverlay(true, note, heavy);
  await nextPaint();
  try {
    return fn();
  } catch (err) {
    showError(err, '編集処理でエラーが発生しました');
    return null;
  } finally {
    setExecOverlay(false);
  }
}

/** 現在のメッシュのジオメトリを差し替え、履歴に積む */
function commitGeometry(geometry) {
  geometry.computeVertexNormals();
  setTargetMesh(new THREE.Mesh(geometry, defaultMaterial()), false);
  pushHistory();
  clearParts();
  updateEditReadout();
}

/** 編集タブ上部の寸法表示を更新する */
function updateEditReadout() {
  const el = document.getElementById('edit-size');
  if (!el) return;
  if (!targetMesh) {
    el.textContent = 'モデル未読み込み';
    return;
  }
  const s = meshSize(targetMesh);
  el.textContent =
    `寸法 ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm` +
    ` / ${triangleCount(targetMesh).toLocaleString()} 三角形`;

  // 寸法入力欄にも現在値を流し込んでおく(そのまま編集して適用できる)
  const set = (id, v) => {
    const i = document.getElementById(id);
    if (i && document.activeElement !== i) i.value = v.toFixed(1);
  };
  set('size-x', s.x); set('size-y', s.y); set('size-z', s.z);
}

/** targetMesh のジオメトリを XYZ 倍率で拡大縮小する(原点中心) */
async function scaleModel(sx, sy, sz) {
  if (!requireMesh()) return;
  if (![sx, sy, sz].every((v) => Number.isFinite(v) && v > 0)) {
    showError(new Error('倍率は 0 より大きい数値で指定してください。'), '入力エラー');
    return;
  }
  if (sx === 1 && sy === 1 && sz === 1) return;
  await withBusy('拡大縮小を適用しています…', () => {
    const g = targetMesh.geometry.clone();
    g.scale(sx, sy, sz);
    commitGeometry(g);
  });
}

/** 目標寸法(mm)に合わせて拡大縮小する */
async function resizeModel(tx, ty, tz, keepRatio) {
  if (!requireMesh()) return;
  const s = meshSize(targetMesh);
  const ratio = (target, cur) =>
    (Number.isFinite(target) && target > 0 && cur > 0.0001) ? target / cur : 1;
  let rx = ratio(tx, s.x), ry = ratio(ty, s.y), rz = ratio(tz, s.z);
  if (keepRatio) {
    // 変更された軸のうち最初のものを全軸に適用する
    const changed = [rx, ry, rz].find((r) => Math.abs(r - 1) > 1e-6) || 1;
    rx = ry = rz = changed;
  }
  await scaleModel(rx, ry, rz);
}

/** targetMesh が無い場合にエラーを出す共通ガード */
function requireMesh() {
  if (targetMesh) return true;
  showError(
    new Error('先に STL/3MF を読み込むか、図形を追加してモデルを用意してください。'),
    'モデルがありません');
  return false;
}

/**
 * 2つのメッシュを CSG 演算し、結果ジオメトリを返す。
 * three-csg-ts は結果を「a のローカル空間 + a の行列」で返すため、
 * 行列をジオメトリへ焼き込んでワールド空間に揃えてから返す
 * (targetMesh に移動・回転が入っていてもズレないようにするため)。
 */
function csgOp(op, a, b) {
  a.updateMatrix();
  b.updateMatrix();
  const res = CSG[op](a, b);
  return res.geometry.clone().applyMatrix4(res.matrix);
}

/**
 * 複数メッシュを CSG を使わずに 1 つのメッシュへ合成する。
 *
 * CSG は 1 回ごとにメッシュ全体を再分割して三角形数を増やすため、
 * 「穴を N 個あける」を N 回の subtract で行うと爆発的に重くなる。
 * 切削体を先にこれで 1 つへまとめ、subtract を 1 回に減らすのが狙い。
 *
 * 単なる面の寄せ集めなので、形状どうしが重なっていると内部に面が残る。
 * 重なる形状の合成には CSG.union が必要(用途を切り分けること)。
 * @param {THREE.Mesh[]} meshes 合成するメッシュ(各自の位置・回転は焼き込む)
 * @returns {THREE.Mesh} 合成後のメッシュ
 */
function mergeMeshes(meshes) {
  const list = (Array.isArray(meshes) ? meshes : [meshes])
    .filter((m) => m && m.geometry && m.geometry.getAttribute('position'));
  if (list.length === 0) {
    throw new Error('mergeMeshes: 合成できるメッシュが渡されていません。');
  }

  const geos = list.map((m) => {
    m.updateMatrix();
    let g = m.geometry.clone().applyMatrix4(m.matrix);
    if (g.index) g = g.toNonIndexed();          // index の有無が混ざると合成に失敗する
    if (!g.getAttribute('normal')) g.computeVertexNormals();

    // 属性の構成が違うと mergeGeometries が失敗するため position/normal/uv に揃える
    const pos = g.getAttribute('position');
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', pos.clone());
    out.setAttribute('normal', g.getAttribute('normal').clone());
    const uv = g.getAttribute('uv');
    out.setAttribute('uv', uv
      ? uv.clone()
      : new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    g.dispose();
    return out;
  });

  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (!merged) throw new Error('mergeMeshes: ジオメトリの合成に失敗しました。');
  if (geos.length > 1) geos.forEach((g) => g.dispose());
  return new THREE.Mesh(merged, defaultMaterial());
}

/** 指定ジオメトリを targetMesh から削る(target が無ければ何もしない) */
async function subtractShape(mesh, note) {
  if (!requireMesh()) return;
  // 消しゴムもここを通る。CSG は規模に応じて急激に重くなるため必ずガードする
  const pre = await preflight(triangleCount(targetMesh), '削り取り');
  if (!pre.ok) { disposeMesh(mesh); return; }
  await withBusy(`${note}${pre.note ? ` (${pre.note})` : ''}`, () => {
    const g = csgOp('subtract', targetMesh, mesh);
    disposeMesh(mesh);
    commitGeometry(g);
  }, pre.heavy);
}

/** 指定ジオメトリを targetMesh に結合する(target が無ければそのまま採用) */
async function unionShape(mesh, note) {
  // シーンが空なら CSG は不要。指定位置を焼き込んでそのまま採用する
  if (!targetMesh) {
    mesh.updateMatrix();
    commitGeometry(mesh.geometry.clone().applyMatrix4(mesh.matrix));
    disposeMesh(mesh);
    frameObject(targetMesh);
    return;
  }
  const pre = await preflight(triangleCount(targetMesh), '結合');
  if (!pre.ok) { disposeMesh(mesh); return; }
  await withBusy(`${note}${pre.note ? ` (${pre.note})` : ''}`, () => {
    const g = csgOp('union', targetMesh, mesh);
    disposeMesh(mesh);
    commitGeometry(g);
  }, pre.heavy);
}

// ── パーツ分割(連結成分の自動認識)──

/** @type {Array<{geometry: THREE.BufferGeometry, tris: number, size: THREE.Vector3}>} */
let parts = [];
let selectedPart = -1;
let partHighlight = null;                       // 選択パーツを強調表示するメッシュ

/**
 * ジオメトリを「頂点を共有してつながっている塊」ごとに分割する。
 * STL は頂点が重複した非インデックス形式で来るため、まず座標を量子化して
 * 溶接(weld)し、Union-Find で三角形をグループ化する。
 * @returns {THREE.BufferGeometry[]} 分割後のジオメトリ(三角形数の多い順)
 */
function splitConnectedComponents(geometry) {
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  const corners = index ? index.count : pos.count;   // 三角形の頂点参照数
  const triCount = Math.floor(corners / 3);
  if (triCount === 0) return [];

  // 1) 座標を量子化して同一頂点をまとめ、連番 ID を振る
  const idOf = new Map();
  const cornerId = new Int32Array(corners);
  let nextId = 0;
  for (let c = 0; c < corners; c++) {
    const vi = index ? index.getX(c) : c;
    const key =
      Math.round(pos.getX(vi) * WELD_PRECISION) + ',' +
      Math.round(pos.getY(vi) * WELD_PRECISION) + ',' +
      Math.round(pos.getZ(vi) * WELD_PRECISION);
    let id = idOf.get(key);
    if (id === undefined) { id = nextId++; idOf.set(key, id); }
    cornerId[c] = id;
  }

  // 2) Union-Find。三角形の3頂点を同じ集合に併合する
  const parent = new Int32Array(nextId);
  for (let i = 0; i < nextId; i++) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n; }  // 経路圧縮
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let t = 0; t < triCount; t++) {
    const a = cornerId[t * 3], b = cornerId[t * 3 + 1], c = cornerId[t * 3 + 2];
    union(a, b);
    union(b, c);
  }

  // 3) 三角形を根ごとにまとめる
  const buckets = new Map();
  for (let t = 0; t < triCount; t++) {
    const root = find(cornerId[t * 3]);
    let arr = buckets.get(root);
    if (!arr) { arr = []; buckets.set(root, arr); }
    arr.push(t);
  }

  // 4) 各グループを非インデックスの BufferGeometry として切り出す
  const out = [];
  for (const tris of buckets.values()) {
    const arr = new Float32Array(tris.length * 9);
    let o = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
        arr[o++] = pos.getX(vi);
        arr[o++] = pos.getY(vi);
        arr[o++] = pos.getZ(vi);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.computeVertexNormals();
    out.push(g);
  }
  // 大きいパーツから並べた方が一覧で選びやすい
  out.sort((a, b) => b.getAttribute('position').count - a.getAttribute('position').count);
  return out;
}

/** パーツ一覧・選択状態・強調表示をすべて破棄する */
function clearParts() {
  parts.forEach((p) => p.geometry.dispose());
  parts = [];
  selectedPart = -1;
  removePartHighlight();
  const list = document.getElementById('parts-list');
  const ops = document.getElementById('parts-ops');
  if (list) { list.innerHTML = ''; list.classList.add('hidden'); }
  if (ops) ops.classList.add('hidden');
}

function removePartHighlight() {
  if (!partHighlight) return;
  scene.remove(partHighlight);
  disposeMesh(partHighlight);
  partHighlight = null;
}

/** パーツを分割して一覧 UI を作る */
async function runSplitParts() {
  if (!requireMesh()) return;
  await withBusy('パーツを認識しています…', () => {
    clearParts();
    const geoms = splitConnectedComponents(targetMesh.geometry);
    parts = geoms.map((g) => {
      g.computeBoundingBox();
      const size = new THREE.Vector3();
      g.boundingBox.getSize(size);
      return { geometry: g, tris: Math.floor(g.getAttribute('position').count / 3), size };
    });
    renderPartsList();
  });
}

/** パーツ一覧を描画する */
function renderPartsList() {
  const list = document.getElementById('parts-list');
  list.innerHTML = parts.map((p, i) =>
    `<button class="part-item" type="button" data-i="${i}">` +
    `<span class="part-no">#${i + 1}</span>` +
    `<span>${p.size.x.toFixed(1)}×${p.size.y.toFixed(1)}×${p.size.z.toFixed(1)}mm</span>` +
    `<span class="part-meta">${p.tris.toLocaleString()} 三角形</span></button>`).join('');
  list.classList.remove('hidden');
  list.querySelectorAll('.part-item').forEach((btn) => {
    btn.addEventListener('click', () => selectPart(Number(btn.dataset.i)));
  });
  logChat('sys', `パーツを ${parts.length} 個認識しました(編集タブの一覧から選べます)。`);
}

/** パーツを選択し、ビューポート上で強調表示する */
function selectPart(i) {
  selectedPart = i;
  document.querySelectorAll('.part-item').forEach((b) =>
    b.classList.toggle('part-item-active', Number(b.dataset.i) === i));
  document.getElementById('parts-ops').classList.toggle('hidden', i < 0);

  removePartHighlight();
  if (i < 0 || !parts[i]) return;
  partHighlight = new THREE.Mesh(
    parts[i].geometry.clone(),
    new THREE.MeshBasicMaterial({ color: 0xffb347, wireframe: true, transparent: true, opacity: 0.9 }));
  scene.add(partHighlight);
}

/** 選択中パーツだけを、そのパーツの中心を基準に拡大縮小して全体を組み直す */
async function scaleSelectedPart(sx, sy, sz) {
  if (selectedPart < 0 || !parts[selectedPart]) return;
  if (![sx, sy, sz].every((v) => Number.isFinite(v) && v > 0)) {
    showError(new Error('倍率は 0 より大きい数値で指定してください。'), '入力エラー');
    return;
  }
  await withBusy('パーツを変形しています…', () => {
    const target = parts[selectedPart];
    const g = target.geometry.clone();
    // パーツ自身の中心を原点に持っていってから拡大し、元の位置へ戻す
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);
    g.scale(sx, sy, sz);
    g.translate(c.x, c.y, c.z);

    const merged = mergeGeometries(
      parts.map((p, i) => (i === selectedPart ? g : p.geometry)), false);
    if (!merged) throw new Error('パーツの再結合に失敗しました。');
    g.dispose();
    commitGeometry(merged);
  });
}

/** 選択中パーツを削除して全体を組み直す */
async function deleteSelectedPart() {
  if (selectedPart < 0 || !parts[selectedPart]) return;
  if (parts.length <= 1) {
    showError(new Error('最後の1パーツは削除できません。「クリア」を使ってください。'), '削除できません');
    return;
  }
  await withBusy('パーツを削除しています…', () => {
    const rest = parts.filter((_, i) => i !== selectedPart).map((p) => p.geometry);
    const merged = mergeGeometries(rest, false);
    if (!merged) throw new Error('パーツの再結合に失敗しました。');
    commitGeometry(merged);
  });
}

// ── 消しゴム ──

let eraserOn = false;
const eraserRay = new THREE.Raycaster();
const eraserPointer = new THREE.Vector2();

/** 消しゴムモードの ON/OFF を切り替える */
function setEraser(on) {
  eraserOn = on;
  const btn = document.getElementById('btn-eraser');
  btn.textContent = `消しゴム: ${on ? 'ON' : 'OFF'}`;
  btn.classList.toggle('btn-primary', on);
  btn.classList.toggle('btn-ghost', !on);
  document.getElementById('viewport').classList.toggle('erasing', on);
  if (on) logChat('sys', 'モデルをクリックすると、その位置を球状に削ります。');
}

/** クリック位置のモデル表面を球で削る */
async function eraseAtPointer(ev) {
  if (!eraserOn || !targetMesh) return;
  const rect = renderer.domElement.getBoundingClientRect();
  eraserPointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  eraserPointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  eraserRay.setFromCamera(eraserPointer, camera);
  const hit = eraserRay.intersectObject(targetMesh, false)[0];
  if (!hit) return;

  const r = Math.max(0.5, Number(document.getElementById('eraser-size').value) || 5);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16));
  ball.position.copy(hit.point);
  await subtractShape(ball, `半径 ${r}mm で削っています…`);
}

// ── 図形・テキストの追加 ──

/** 入力値から基本図形メッシュを組み立てる */
function buildPrimitive() {
  const num = (id, min) => Math.max(min, Number(document.getElementById(id).value) || min);
  const kind = document.getElementById('prim-kind').value;
  const w = num('prim-w', 0.1), h = num('prim-h', 0.1), d = num('prim-d', 0.1);

  let geo;
  switch (kind) {
    case 'cylinder': geo = new THREE.CylinderGeometry(w / 2, w / 2, h, 48); break;
    case 'sphere':   geo = new THREE.SphereGeometry(w / 2, 48, 24); break;
    case 'cone':     geo = new THREE.ConeGeometry(w / 2, h, 48); break;
    default:         geo = new THREE.BoxGeometry(w, h, d); break;
  }
  const mesh = new THREE.Mesh(geo);
  mesh.position.set(
    Number(document.getElementById('prim-x').value) || 0,
    Number(document.getElementById('prim-y').value) || 0,
    Number(document.getElementById('prim-z').value) || 0);
  return mesh;
}

let cachedFont = null;

/** テキスト用フォントを遅延ロードする(半角英数のみ対応) */
async function loadTextFont() {
  if (cachedFont) return cachedFont;
  cachedFont = await new Promise((resolve, reject) => {
    new FontLoader().load(TEXT_FONT_URL, resolve, undefined,
      () => reject(new Error('フォントの読み込みに失敗しました(ネットワークを確認してください)。')));
  });
  return cachedFont;
}

/** 入力値から立体テキストのメッシュを組み立てる */
async function buildTextMesh() {
  const value = document.getElementById('text-value').value.trim();
  if (!value) {
    showError(new Error('追加する文字を入力してください。'), '入力エラー');
    return null;
  }
  // helvetiker は日本語グリフを持たないため、非対応文字は明示的に弾く
  if (!/^[\x20-\x7E]+$/.test(value)) {
    showError(
      new Error('半角英数字・記号のみ対応しています(日本語フォントは未対応)。'),
      'この文字は使えません');
    return null;
  }
  const font = await loadTextFont();
  const size = Math.max(1, Number(document.getElementById('text-size').value) || 10);
  const depth = Math.max(0.1, Number(document.getElementById('text-depth').value) || 3);

  const geo = new TextGeometry(value, { font, size, height: depth, curveSegments: 8, bevelEnabled: false });
  geo.center();
  const mesh = new THREE.Mesh(geo);
  mesh.position.y = Number(document.getElementById('text-y').value) || 0;
  return mesh;
}

/** 画面上のモード/メッシュ状態バッジを更新する */
function updateBadges() {
  const modeBadge = document.getElementById('mode-badge');
  const meshBadge = document.getElementById('mesh-badge');
  const viewport = document.getElementById('viewport');

  if (targetMesh) {
    const s = meshSize(targetMesh);
    modeBadge.textContent = 'モード: モデル編集';
    meshBadge.textContent =
      `メッシュ: ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm`;
    viewport.classList.add('has-mesh');
  } else {
    modeBadge.textContent = 'モード: ゼロベース生成';
    meshBadge.textContent = 'メッシュ: なし';
    viewport.classList.remove('has-mesh');
  }
  document.getElementById('btn-download').disabled = !targetMesh;
}

// ─────────────────────────────────────────────────────────────
// STL 読み込み(ドラッグ&ドロップ)
// ─────────────────────────────────────────────────────────────

function initDragAndDrop() {
  const viewport = document.getElementById('viewport');

  ['dragenter', 'dragover'].forEach((ev) =>
    viewport.addEventListener(ev, (e) => {
      e.preventDefault();
      viewport.classList.add('dragover');
    }));
  ['dragleave', 'dragend'].forEach((ev) =>
    viewport.addEventListener(ev, (e) => {
      e.preventDefault();
      if (e.target === viewport) viewport.classList.remove('dragover');
    }));

  viewport.addEventListener('drop', (e) => {
    e.preventDefault();
    viewport.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadModelFile(file);
  });
}

/** File(STL/3MF) を読み込んで対象メッシュにする。拡張子で処理を分岐する。 */
function loadModelFile(file) {
  const name = file.name.toLowerCase();
  const isStl = name.endsWith('.stl');
  const is3mf = name.endsWith('.3mf');
  if (!isStl && !is3mf) {
    showError(new Error('対応形式は STL / 3MF のみです: ' + file.name), '未対応のファイル形式');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      let geometry;
      if (isStl) {
        geometry = new STLLoader().parse(e.target.result);
        geometry.center();                     // 原点中心へ寄せる
      } else {
        geometry = parse3mfGeometry(e.target.result);
      }
      const mesh = new THREE.Mesh(geometry, defaultMaterial());
      setTargetMesh(mesh);
      // 読み込み直後を履歴の起点にする(以降の編集はここまで戻せる)
      clearParts();
      resetHistory();
      updateEditReadout();
      logChat('sys', `${isStl ? 'STL' : '3MF'} を読み込みました: ${file.name}`);
    } catch (err) {
      showError(err, 'モデルの読み込みに失敗しました');
    }
  };
  reader.onerror = () => showError(reader.error, 'ファイル読み込みエラー');
  reader.readAsArrayBuffer(file);
}

/**
 * 3MF バイナリを解析し、色・マテリアル情報を無視して形状だけを 1 つの
 * ジオメトリに統合する(要件により色情報は不要なため position のみ採用)。
 * @param {ArrayBuffer} buffer
 * @returns {THREE.BufferGeometry}
 */
function parse3mfGeometry(buffer) {
  const group = new ThreeMFLoader().parse(buffer);
  group.updateMatrixWorld(true);

  const geometries = [];
  group.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const pos = child.geometry.getAttribute('position');
    if (!pos) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', pos.clone());
    if (child.geometry.index) g.setIndex(child.geometry.index.clone());
    g.applyMatrix4(child.matrixWorld);          // 3MF の配置変換を形状へ焼き込む
    geometries.push(g);
  });

  if (geometries.length === 0) {
    throw new Error('3MF 内にメッシュが見つかりませんでした。');
  }
  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
  merged.computeVertexNormals();
  merged.center();
  return merged;
}

// ─────────────────────────────────────────────────────────────
// STL 書き出し(ダウンロード)
// ─────────────────────────────────────────────────────────────

function downloadStl() {
  if (!targetMesh) return;
  // ワールド行列を反映してからバイナリ STL として書き出す
  targetMesh.updateMatrixWorld(true);
  const data = new STLExporter().parse(targetMesh, { binary: true });
  const blob = new Blob([data], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-3d-${stamp()}.stl`;
  a.click();
  URL.revokeObjectURL(url);

  // CSG を重ねたモデルはスライサー側で「三角形が多い」警告が出ることがあり、
  // そこで安易に簡略化すると穴が開くことがある。保存の瞬間に軽く予告しておく。
  const tris = triangleCount(targetMesh);
  const heavy = tris >= TRI_WARN;
  showToast(
    `💾 保存しました(${tris.toLocaleString()} 三角形)。` +
    (heavy
      ? '<br><b>スライサーで「三角形が多い」と警告が出る可能性があります。</b>' +
        '出ても<b>簡略化(Simplify)は使わず</b>、詳しくは右上「i」の' +
        '「保存した STL をスライサーで開くとき」をご確認ください。'
      : 'スライサーで警告が出た場合は、右上「i」の説明もご確認ください。'),
    { warn: heavy });
}

let toastTimer = null;

/**
 * 画面下部に軽い通知を一定時間だけ表示する(確認は求めない、邪魔にならない告知用)。
 * クリックすると即座に消える。
 */
function showToast(html, { warn = false, ms = 9000 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove('hidden');
  el.classList.toggle('toast-warn', warn);
  clearTimeout(toastTimer);
  const hide = () => el.classList.add('hidden');
  el.onclick = hide;
  toastTimer = setTimeout(hide, ms);
}

/** ファイル名用のタイムスタンプ(YYYYMMDD-HHMMSS) */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ─────────────────────────────────────────────────────────────
// 動的コード実行エンジン
// ─────────────────────────────────────────────────────────────

/**
 * LLM 返却テキスト or 直接入力から実行可能な JS を取り出す。
 * ```js ... ``` フェンスがあればその中身、無ければ全文を返す。
 */
function extractCode(text) {
  if (!text) return '';
  const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** メッシュの三角形数を返す(index があればそちらを優先) */
function triangleCount(mesh) {
  const g = mesh && mesh.geometry;
  if (!g) return 0;
  if (g.index) return Math.floor(g.index.count / 3);
  const pos = g.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * 過去の実行実績(三角形数 → 所要 ms)から所要時間を見積もる。
 * 実測ベースなので、履歴が無い/規模が違いすぎる場合は null を返す(推測しない)。
 * @returns {number|null} 推定ミリ秒
 */
function estimateRunTime(tris) {
  const hist = settings.execHistory || [];
  if (!hist.length || tris <= 0) return null;
  // 三角形数が近い順に最大3件を採り、1三角形あたりの実測コストを平均する
  const near = hist
    .filter((h) => h.tris > 0)
    .sort((a, b) => Math.abs(a.tris - tris) - Math.abs(b.tris - tris))
    .slice(0, 3);
  if (!near.length) return null;
  const closest = near[0];
  // 規模が10倍以上離れていたら外挿の信頼性が無いので出さない
  const ratio = Math.max(closest.tris, tris) / Math.min(closest.tris, tris);
  if (ratio > 10) return null;
  const perTri = near.reduce((s, h) => s + h.ms / h.tris, 0) / near.length;
  return perTri * tris;
}

/** 実行実績を localStorage に記録する(直近 EXEC_HISTORY_MAX 件) */
function recordRunTime(tris, ms) {
  if (tris <= 0) return;
  const hist = settings.execHistory || [];
  hist.push({ tris, ms });
  settings.execHistory = hist.slice(-EXEC_HISTORY_MAX);
  saveSettings();
}

/** 所要時間を人間向けに整形する */
function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ミリ秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * 実行中オーバーレイの表示/非表示。
 * @param {boolean} visible 表示するか
 * @param {string} [note] 推定所要時間などの補足
 * @param {boolean} [heavy] 重い処理なら、待たされる可能性の警告を強める
 */
function setExecOverlay(visible, note, heavy) {
  const ov = document.getElementById('exec-overlay');
  document.getElementById('exec-note').textContent = note || '';
  const warn = document.getElementById('exec-warn');
  if (warn) {
    warn.innerHTML = heavy
      ? '計算中はブラウザの操作を受け付けず、<b>中止もできません</b>。<br>' +
        'ブラウザが「応答しません」と表示したら<br><b>「待機」を選べば処理は続きます</b>。<br>' +
        '規模によっては数分かかり、失敗することもあります。'
      : '計算中はブラウザの操作を受け付けません。<br>そのままお待ちください。';
    warn.classList.toggle('exec-warn-strong', !!heavy);
  }
  ov.classList.toggle('hidden', !visible);
}

/**
 * 確認ダイアログを出して、ユーザーの選択を待つ。
 * window.confirm と違い、テーマに合わせた表示と HTML 本文が使える。
 * @returns {Promise<boolean>} 「それでも実行する」なら true
 */
function askConfirm(title, bodyHtml) {
  return new Promise((resolve) => {
    const ov = document.getElementById('confirm-overlay');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').innerHTML = bodyHtml;
    const go = document.getElementById('btn-confirm-go');
    const no = document.getElementById('btn-confirm-cancel');

    const done = (v) => {
      ov.classList.add('hidden');
      go.removeEventListener('click', onGo);
      no.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onGo = () => done(true);
    const onNo = () => done(false);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };

    go.addEventListener('click', onGo);
    no.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    ov.classList.remove('hidden');
    no.focus();                       // 既定は「やめる」。誤爆で重い処理に入らせない
  });
}

/**
 * 重い処理の実行前ガード。
 * 三角形数から規模を判定し、危険域なら実行前に確認を求める。
 * CSG は同期処理で中止できないため、「止められないことを始める前」が
 * ユーザーに選択肢を出せる唯一のタイミングになる。
 * @param {number} tris 入力メッシュの三角形数
 * @param {string} opLabel 処理名(ダイアログのタイトルに使う)
 * @returns {Promise<{ok:boolean, est:number|null, heavy:boolean, note:string}>}
 */
async function preflight(tris, opLabel) {
  const est = estimateRunTime(tris);
  const heavy = tris >= TRI_WARN;

  const noteParts = [];
  if (tris > 0) noteParts.push(`対象 ${tris.toLocaleString()} 三角形`);
  if (est !== null) noteParts.push(`推定 約${formatMs(est)}(過去の実測より)`);
  const note = noteParts.join(' / ');

  // 危険域でなければ、そのまま進む(注意はオーバーレイ側で出す)
  if (tris < TRI_CONFIRM) return { ok: true, est, heavy, note };

  const lines = [
    `対象は <b>${tris.toLocaleString()} 三角形</b>あります。`,
    est !== null
      ? `過去の実測から <b>約${formatMs(est)}</b> かかる見込みです。`
      : '近い規模の実測データが無いため、所要時間は予測できません。',
    '<b>数分かかることがあり、ブラウザがタブを強制終了して作業が失われる場合があります。</b>',
    '計算中は中止できません。「応答しません」と出たら<b>「待機」</b>を選んでください。',
    '先に「STL 保存」でバックアップしておくことを強くおすすめします。',
  ];
  const ok = await askConfirm(`⚠ ${opLabel}: 時間がかかります`, lines.join('<br>'));
  return { ok, est, heavy, note };
}

/** ブラウザに1フレーム描画させてから次に進む(オーバーレイを確実に見せるため) */
function nextPaint() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/**
 * 抽出済み JS を new Function で実行し、結果メッシュでシーンを更新する。
 * scene / THREE / CSG / targetMesh / setResult を引数として渡す。
 *
 * CSG は同期処理でメインスレッドを占有するため、実行中の進捗更新はできない。
 * そのため「実行前にオーバーレイを描画 → 実行 → 実測値を報告」という形にしている。
 * @returns {Promise<boolean>} 成功したか
 */
async function runUserCode(code) {
  clearError();
  if (!code) {
    showError(new Error('実行するコードがありません'), 'コードが空です');
    return false;
  }

  // 実行前ガード。規模が大きければ、始める前に確認を取る
  const inTris = triangleCount(targetMesh);
  const pre = await preflight(inTris, 'コード実行');
  if (!pre.ok) return false;
  const est = pre.est;

  setExecOverlay(true, pre.note, pre.heavy);
  await nextPaint();               // ← ここでオーバーレイが実際に描画される

  let result = null;
  const setResult = (mesh) => { result = mesh; };

  // 実行コード内の console 出力を拾ってデバッグ欄に出す
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const cap = (level) => (...args) => {
    logs.push(`[${level}] ` + args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' '));
    orig[level].apply(console, args);
  };
  console.log = cap('log'); console.warn = cap('warn'); console.error = cap('error');

  const t0 = performance.now();
  let elapsed = 0;
  try {
    // 'use strict' を付けて、暗黙のグローバル汚染を防ぐ
    const fn = new Function(
      'scene', 'THREE', 'CSG', 'targetMesh', 'setResult', 'mergeMeshes',
      '"use strict";\n' + code);
    const ret = fn(scene, THREE, CSG, targetMesh, setResult, mergeMeshes);
    elapsed = performance.now() - t0;

    // setResult 優先。無ければ return 値をメッシュとして扱う
    const mesh = result || ret;
    if (mesh && mesh.isMesh) {
      setTargetMesh(mesh);
      // コード実行結果も undo 対象にする
      clearParts();
      pushHistory();
      updateEditReadout();
      recordRunTime(inTris || triangleCount(mesh), elapsed);
      showDebugReport({ ok: true, elapsed, inTris, outTris: triangleCount(mesh), logs, est });
      return true;
    }
    // メッシュが返らなかった: scene 直接操作とみなし、警告のみ
    showDebugReport({ ok: false, elapsed, inTris, outTris: 0, logs, est });
    showError(
      new Error('setResult(mesh) が呼ばれず、メッシュも return されませんでした。\n' +
        '完成メッシュを setResult(...) で登録してください。'),
      'メッシュを取得できませんでした');
    return false;
  } catch (err) {
    elapsed = performance.now() - t0;
    showDebugReport({ ok: false, elapsed, inTris, outTris: 0, logs, est });
    showError(err, '実行時エラー');
    return false;
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    setExecOverlay(false);
  }
}

/** 実行レポート(所要時間・三角形数・console 出力)をデバッグ欄に表示する */
function showDebugReport({ ok, elapsed, inTris, outTris, logs, est }) {
  const box = document.getElementById('debug-box');
  const stats = document.getElementById('debug-stats');
  const logEl = document.getElementById('debug-log');

  // 推定と実測が2倍以上ずれたら、その旨も添える(見積りを過信させない)
  let estText = '—';
  if (est !== null) {
    const off = Math.max(est, elapsed) / Math.max(1, Math.min(est, elapsed));
    estText = `約${formatMs(est)}` + (off >= 2 ? '(実測と乖離)' : '');
  }

  // CSG は結果の三角形数を増やす。増分を明示しないと
  // 「1回目は成功したのに2回目で固まる」理由がユーザーに分からない
  let outText = outTris > 0 ? `${outTris.toLocaleString()} 三角形` : '—';
  if (outTris > 0 && inTris > 0 && outTris !== inTris) {
    const d = outTris - inTris;
    const pct = Math.round((d / inTris) * 100);
    outText += d > 0
      ? ` <span class="dbg-grow">(+${d.toLocaleString()} / +${pct}%)</span>`
      : ` (${d.toLocaleString()} / ${pct}%)`;
  }

  const rows = [
    ['結果', ok ? '✅ 反映しました' : '⚠ 反映できませんでした'],
    ['所要時間', formatMs(elapsed)],
    ['事前推定', estText],
    ['入力メッシュ', inTris > 0 ? `${inTris.toLocaleString()} 三角形` : 'なし(ゼロベース)'],
    ['出力メッシュ', outText],
  ];
  if (outTris >= TRI_WARN) {
    rows.push(['⚠ 次の実行', `この ${outTris.toLocaleString()} 三角形が次回の入力になります。` +
      `続けて加工すると、さらに時間がかかります。区切りで「STL 保存」をおすすめします。`]);
  }
  stats.innerHTML = rows.map(([k, v]) =>
    `<dt>${k}</dt><dd${k === '所要時間' && elapsed >= 5000 ? ' class="dbg-slow"' : ''}>${v}</dd>`
  ).join('');

  if (logs.length) {
    logEl.textContent = logs.join('\n');
    logEl.classList.remove('hidden');
  } else {
    logEl.classList.add('hidden');
  }
  box.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────
// エラー表示(トレースをそのまま UI に出す)
// ─────────────────────────────────────────────────────────────

function showError(err, title) {
  const box = document.getElementById('error-box');
  const trace = document.getElementById('error-trace');
  const head = box.querySelector('.error-head span');
  head.textContent = '⚠ ' + (title || '実行エラー');
  const msg = err && err.stack ? err.stack : String(err);
  trace.textContent = msg;
  box.classList.remove('hidden');
  console.error('[chat-3d]', title, err);
}

function clearError() {
  document.getElementById('error-box').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────
// Gemini API 連携
// ─────────────────────────────────────────────────────────────

/**
 * 現在のシーン状態に応じたコンテキスト文を組み立てる。
 * targetMesh の有無で「ゼロから生成」/「CSG で加工して置換」を切り替える。
 */
function buildContext() {
  if (targetMesh) {
    const s = meshSize(targetMesh);
    const tris = triangleCount(targetMesh);
    // 三角形数を伝えると、LLM が分割数や CSG 回数を規模に合わせて調整できる
    const load = tris >= TRI_CONFIRM
      ? `\n**このモデルは既に非常に重い状態です。三角形数をこれ以上増やさないことを最優先し、` +
        `分割数は最小限(円筒 12〜16)、CSG は 1 回だけにしてください。**`
      : tris >= TRI_WARN
        ? `\n**このモデルは既に重い部類です。分割数を抑え、CSG の回数を最小にしてください。**`
        : '';
    return `# 現在の状態\n` +
      `targetMesh が存在します(バウンディングボックス: ` +
      `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm、原点中心)。\n` +
      `現在の三角形数: ${tris.toLocaleString()}。${load}\n` +
      `この targetMesh を CSG で加工し、加工後のメッシュを setResult() で登録してください。\n` +
      `元の targetMesh は自動で置換されます。`;
  }
  return `# 現在の状態\n` +
    `targetMesh は存在しません(空のシーン)。\n` +
    `THREE の基本図形(Box/Cylinder/Sphere 等)と CSG を用いて、\n` +
    `指示された形状をゼロから生成し、setResult() で登録してください。`;
}

/** システムプロンプト(テンプレの {{CONTEXT}} を現在状態で差し替え) */
function buildSystemPrompt() {
  const tmpl = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  return tmpl.replace('{{CONTEXT}}', buildContext());
}

/** Gemini REST API を呼んで応答テキストを返す */
async function callGemini(userText) {
  const key = settings.apiKey;
  const model = settings.model || 'gemini-2.5-flash';
  if (!key) throw new Error('設定タブで Gemini API キーを入力してください。');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.4 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー ${res.status}\n${detail}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini から空の応答が返りました。');
  return text;
}

/** チャット送信フロー: API 呼び出し → コード抽出 → 実行 */
async function handleChatSend(userText) {
  logChat('user', userText);
  const sendBtn = document.getElementById('btn-send');
  sendBtn.disabled = true;
  const thinking = logChat('ai', '生成中…');

  try {
    const reply = await callGemini(userText);
    thinking.remove();
    logChat('ai', reply);
    const code = extractCode(reply);
    await runUserCode(code);
  } catch (err) {
    thinking.remove();
    showError(err, 'Gemini 連携エラー');
    logChat('sys', 'エラーが発生しました。詳細は下部のエラー欄を参照してください。');
  } finally {
    sendBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// チャットログ描画
// ─────────────────────────────────────────────────────────────

/** チャットログに1件追加して、その要素を返す */
function logChat(role, text) {
  const log = document.getElementById('chat-log');
  const el = document.createElement('div');
  el.className = 'msg msg-' + role;
  if (role === 'ai' && /```/.test(text)) {
    el.innerHTML = renderAiText(text);
  } else {
    el.textContent = text;
  }
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/** AI 応答の ```js``` ブロックを <pre> に整形(簡易・XSS 対策で必ずエスケープ) */
function renderAiText(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(text).replace(/```(?:\w+)?\s*([\s\S]*?)```/gi,
    (_, code) => `<pre>${code.trim()}</pre>`);
}

// ─────────────────────────────────────────────────────────────
// チャットモード(コピペ / API)
// ─────────────────────────────────────────────────────────────

/** @type {'copy'|'api'} 現在のチャットモード */
let chatMode = 'copy';
const modeGuideShown = { copy: false, api: false };

/**
 * チャットログに「コピー用プロンプト」を折りたたみ + ワンクリックコピーで表示する。
 * 一度コピーに失敗した場合や、後から再送したい場合にここから何度でもコピーできる。
 */
function logCopyPrompt(prompt) {
  const log = document.getElementById('chat-log');
  const el = document.createElement('div');
  el.className = 'msg msg-ai';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  el.innerHTML =
    '<details open><summary>📋 送信用プロンプト(クリックで折りたたみ)</summary>' +
    `<pre>${esc(prompt)}</pre></details>` +
    '<div class="msg-tools"><button class="btn-copy" type="button">📋 コピー</button></div>';

  // ワンクリックコピー。成否をボタン自身のラベルで即座にフィードバックする
  const btn = el.querySelector('.btn-copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      btn.textContent = '✅ コピーしました';
      btn.classList.add('copied');
    } catch (_) {
      btn.textContent = '⚠ コピー失敗(手動で選択してください)';
    }
    setTimeout(() => {
      btn.textContent = '📋 コピー';
      btn.classList.remove('copied');
    }, 2000);
  });

  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/** コピペモード/API モードの切替。初回切替時のみガイドメッセージをチャットログに流す */
function setChatMode(mode) {
  chatMode = mode;
  document.querySelectorAll('.mode-btn').forEach((btn) =>
    btn.classList.toggle('mode-btn-active', btn.dataset.mode === mode));
  document.getElementById('paste-back').classList.toggle('hidden', mode !== 'copy');
  document.getElementById('btn-send').textContent =
    mode === 'copy' ? 'プロンプトをコピー' : '送信';

  if (modeGuideShown[mode]) return;
  modeGuideShown[mode] = true;
  if (mode === 'copy') {
    logChat('sys',
      '📋 コピペモード: ChatGPT / Claude など、お好きな LLM と手動でやりとりできます(Gemini 限定ではありません)。\n' +
      '① 下の入力欄に指示を書いて「プロンプトをコピー」を押す(クリップボードにコピーされます)。\n' +
      '② コピーした内容を外部チャットに貼り付けて送信する。\n' +
      '③ 返ってきた回答(コードを含む全文)を下の「外部チャットの回答を貼り付け」欄に貼り付け、' +
      '「貼り付けを実行」を押すとこのシーンに反映されます。');
  } else {
    logChat('sys',
      '🔌 API モード: 設定タブに登録した Gemini API キーを使い、指示の送信からコード実行まで自動で行います。');
  }
}

/** 編集タブの配線。数値入力 → ジオメトリ操作 → 履歴 という流れに統一する */
function initEditUI() {
  const num = (id) => Number(document.getElementById(id).value);

  // 全体倍率 / XYZ 個別倍率
  document.getElementById('btn-scale-all').addEventListener('click', () => {
    const s = num('scale-all');
    scaleModel(s, s, s);
  });
  document.getElementById('btn-scale-xyz').addEventListener('click', () => {
    scaleModel(num('scale-x'), num('scale-y'), num('scale-z'));
  });
  // 目標寸法(mm)を指定して合わせる
  document.getElementById('btn-size-apply').addEventListener('click', () => {
    resizeModel(num('size-x'), num('size-y'), num('size-z'),
      document.getElementById('size-keep-ratio').checked);
  });

  // 消しゴム
  document.getElementById('btn-eraser').addEventListener('click', () => setEraser(!eraserOn));

  // パーツ分割
  document.getElementById('btn-split').addEventListener('click', runSplitParts);
  document.getElementById('btn-part-scale').addEventListener('click', () => {
    scaleSelectedPart(num('part-sx'), num('part-sy'), num('part-sz'));
  });
  document.getElementById('btn-part-delete').addEventListener('click', deleteSelectedPart);

  // 図形の追加 / 削り
  document.getElementById('btn-prim-add').addEventListener('click', () => {
    unionShape(buildPrimitive(), '図形を結合しています…');
  });
  document.getElementById('btn-prim-sub').addEventListener('click', () => {
    subtractShape(buildPrimitive(), '図形で削っています…');
  });

  // テキストの追加 / 彫り込み
  document.getElementById('btn-text-add').addEventListener('click', async () => {
    const m = await buildTextMesh();
    if (m) unionShape(m, '文字を結合しています…');
  });
  document.getElementById('btn-text-sub').addEventListener('click', async () => {
    const m = await buildTextMesh();
    if (m) subtractShape(m, '文字を彫っています…');
  });

  // undo / redo(ボタンとショートカット)
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    // 入力欄での Ctrl+Z はブラウザ標準のテキスト取り消しに任せる
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // 消しゴムのクリック判定。ドラッグ(視点回転)と区別するため移動量を見る
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved < 5) eraseAtPointer(e);
  });

  updateEditReadout();
}

/**
 * 指示のヒント欄を生成する。テンプレートはクリックで入力欄に引用でき、
 * 「できないこと」は引用不可の情報として併記して期待値を先に揃える。
 */
function initHintLibrary() {
  const body = document.getElementById('hint-lib-body');
  const chatInput = document.getElementById('chat-input');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const groups = INSTRUCTION_TEMPLATES.map((g) =>
    `<div class="hint-group"><div class="hint-group-title">${esc(g.title)}</div>` +
    '<div class="hint-chips">' +
    g.items.map((t) =>
      `<button class="hint-chip" type="button" data-tpl="${esc(t)}">${esc(t)}</button>`).join('') +
    '</div></div>').join('');

  const limits =
    '<div class="hint-group"><div class="hint-group-title">できないこと(LLM は形を見ていません)</div>' +
    '<ul class="hint-no">' +
    INSTRUCTION_LIMITS.map((l) =>
      `<li>✕ <b>「${esc(l.what)}」</b> — ${esc(l.why)}</li>`).join('') +
    '</ul>' +
    '<p class="hint-note">形を指し示す指示は通りません。かわりに<b>寸法と座標(mm)</b>で伝えてください。' +
    '3D ビューを見て判断するのはあなたの役割です。</p></div>';

  body.innerHTML = groups + limits;

  // クリックで入力欄へ引用(既存の入力があれば置き換えず、続けて書けるよう末尾に追記)
  body.querySelectorAll('.hint-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tpl = chip.dataset.tpl;
      const cur = chatInput.value.trim();
      chatInput.value = cur ? `${cur}\n${tpl}` : tpl;
      chatInput.focus();
      chatInput.selectionStart = chatInput.selectionEnd = chatInput.value.length;
    });
  });
}

/** コピペモードの送信フロー: プロンプトを組み立ててクリップボードにコピーし、ログに残す */
async function handleChatCopy(userText) {
  logChat('user', userText);
  const prompt = buildSystemPrompt() + '\n\n# 指示\n' + userText;

  try {
    await navigator.clipboard.writeText(prompt);
    logChat('sys', '✅ プロンプトをクリップボードにコピーしました。外部チャットに貼り付けて送信してください。');
  } catch (_) {
    logChat('sys', '⚠ クリップボードへのコピーに失敗しました。下に表示したプロンプトを手動で選択してコピーしてください。');
  }
  logCopyPrompt(prompt);
}

/** コピペモードの「貼り付けを実行」: 貼り付けたテキストからコードを抽出して実行する */
async function handlePasteRun() {
  const pasteInput = document.getElementById('paste-input');
  const btn = document.getElementById('btn-paste-run');
  const text = pasteInput.value.trim();
  if (!text) return;
  logChat('ai', text);
  const code = extractCode(text);
  btn.disabled = true;
  try {
    if (await runUserCode(code)) pasteInput.value = '';
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 設定の保存/復元(localStorage)
// ─────────────────────────────────────────────────────────────

function loadSettings() {
  const defaults = {
    apiKey: '', model: 'gemini-2.5-flash',
    systemPrompt: DEFAULT_SYSTEM_PROMPT, execHistory: [],
    promptVersion: PROMPT_VERSION, promptEdited: false,
  };
  let s = defaults;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) s = Object.assign({}, defaults, JSON.parse(raw));
  } catch (_) { /* 破損時は既定値 */ }

  // 保存済みプロンプトをユーザーが編集していなければ、既定の更新に追従させる。
  // これが無いと、一度でも設定を保存した環境に新しい既定プロンプトが届かない。
  if (!s.promptEdited && s.promptVersion !== PROMPT_VERSION) {
    s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    s.promptVersion = PROMPT_VERSION;
  }
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch (_) { /* 容量超過等は黙って無視 */ }
}

// ─────────────────────────────────────────────────────────────
// UI 配線
// ─────────────────────────────────────────────────────────────

function initUI() {
  // タブ切替
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) =>
        t.classList.toggle('tab-active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.toggle('tab-panel-active', p.dataset.panel === name));
    });
  });

  // チャットモード切替(コピペ / API)
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setChatMode(btn.dataset.mode));
  });

  // チャット送信(モードに応じて分岐)
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    if (chatMode === 'api') {
      handleChatSend(text);
    } else {
      handleChatCopy(text);
    }
  });
  // Ctrl/Cmd+Enter で送信
  chatInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // コピペモード: 外部チャットの回答を貼り付けて実行
  document.getElementById('btn-paste-run').addEventListener('click', handlePasteRun);

  // コード直接入力(= LLM 側の JavaScript 回答を貼り付けて実行する)
  const codeInput = document.getElementById('code-input');
  const runBtn = document.getElementById('btn-run');
  codeInput.value = SAMPLE_CODE;
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try {
      await runUserCode(extractCode(codeInput.value));
    } finally {
      runBtn.disabled = false;
    }
  });
  document.getElementById('btn-sample').addEventListener('click', () => {
    codeInput.value = SAMPLE_CODE;
  });
  document.getElementById('btn-code-clear').addEventListener('click', () => {
    codeInput.value = '';
    codeInput.focus();
  });
  document.getElementById('btn-debug-close').addEventListener('click', () => {
    document.getElementById('debug-box').classList.add('hidden');
  });

  // 指示のヒント(できること / できないこと)
  initHintLibrary();

  // 編集タブ(チャット不要の直接操作)
  initEditUI();

  // ヘッダ操作
  document.getElementById('btn-download').addEventListener('click', downloadStl);
  document.getElementById('btn-reset').addEventListener('click', () => {
    setTargetMesh(null);
    clearError();
    clearParts();
    setEraser(false);
    resetHistory();
    updateEditReadout();
    logChat('sys', 'シーンをクリアしました(ゼロベース生成モード)。');
  });

  // エラーを閉じる
  document.getElementById('btn-error-close').addEventListener('click', clearError);

  // 目的・機能仕様の info パネル開閉
  const infoBtn = document.getElementById('btn-info');
  const infoPanel = document.getElementById('info-panel');
  const setInfoOpen = (open) => {
    infoPanel.classList.toggle('hidden', !open);
    infoBtn.setAttribute('aria-expanded', String(open));
  };
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setInfoOpen(infoPanel.classList.contains('hidden'));
  });
  document.getElementById('btn-info-close').addEventListener('click', () => setInfoOpen(false));
  document.addEventListener('click', (e) => {
    if (!infoPanel.classList.contains('hidden') &&
      !infoPanel.contains(e.target) && e.target !== infoBtn) {
      setInfoOpen(false);
    }
  });

  // 設定タブ
  const apiKey = document.getElementById('api-key');
  const apiModel = document.getElementById('api-model');
  const sysPrompt = document.getElementById('sys-prompt');
  apiKey.value = settings.apiKey || '';
  apiModel.value = settings.model || 'gemini-2.5-flash';
  sysPrompt.value = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  apiKey.addEventListener('change', () => { settings.apiKey = apiKey.value.trim(); saveSettings(); });
  apiModel.addEventListener('change', () => { settings.model = apiModel.value; saveSettings(); });
  sysPrompt.addEventListener('change', () => {
    settings.systemPrompt = sysPrompt.value;
    // 手で編集した以降は、既定プロンプトの更新で上書きしない
    settings.promptEdited = sysPrompt.value !== DEFAULT_SYSTEM_PROMPT;
    settings.promptVersion = PROMPT_VERSION;
    saveSettings();
  });
  document.getElementById('btn-reset-prompt').addEventListener('click', () => {
    settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    settings.promptEdited = false;
    settings.promptVersion = PROMPT_VERSION;
    sysPrompt.value = DEFAULT_SYSTEM_PROMPT;
    saveSettings();
  });
}

// ─────────────────────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────────────────────

function main() {
  initThree();
  initDragAndDrop();
  initUI();
  updateBadges();
  resetHistory();
  logChat('sys', 'ようこそ。指示だけでゼロから生成、または STL/3MF を D&D して編集できます。');
  logChat('sys', 'チャットを使わずに直接編集したい場合は「編集」タブへ。拡大縮小・消しゴム・パーツ分割・図形/文字の追加ができます。');
  setChatMode('copy');
}

main();
