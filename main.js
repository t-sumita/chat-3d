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
import { CSG } from 'three-csg-ts';

// ─────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────

const LS_KEY = 'chat3d.settings.v1';          // localStorage キー
const MODEL_COLOR = 0x9ec5ff;                  // 生成メッシュの既定色
const EXEC_HISTORY_MAX = 20;                   // 所要時間の推定に使う実行履歴の保持件数

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
const SAMPLE_CODE = `// Box と Sphere を結合(union)して1つのメッシュにする例
const box = new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30));
const sphere = new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16));
sphere.position.set(15, 15, 15);

// CSG 前に行列を確定させる(重要)
box.updateMatrix();
sphere.updateMatrix();

const merged = CSG.union(box, sphere);
setResult(merged);`;

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

/** 実行中オーバーレイの表示/非表示。note は推定所要時間などの補足 */
function setExecOverlay(visible, note) {
  const ov = document.getElementById('exec-overlay');
  document.getElementById('exec-note').textContent = note || '';
  ov.classList.toggle('hidden', !visible);
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

  // 実行前に規模から所要時間を見積もり、オーバーレイに出す
  const inTris = triangleCount(targetMesh);
  const est = estimateRunTime(inTris);
  const note = est !== null
    ? `推定 約${formatMs(est)}(過去の実測より)`
    : (inTris > 0 ? `対象 ${inTris.toLocaleString()} 三角形` : '');
  setExecOverlay(true, note);
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
      'scene', 'THREE', 'CSG', 'targetMesh', 'setResult',
      '"use strict";\n' + code);
    const ret = fn(scene, THREE, CSG, targetMesh, setResult);
    elapsed = performance.now() - t0;

    // setResult 優先。無ければ return 値をメッシュとして扱う
    const mesh = result || ret;
    if (mesh && mesh.isMesh) {
      setTargetMesh(mesh);
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

  const rows = [
    ['結果', ok ? '✅ 反映しました' : '⚠ 反映できませんでした'],
    ['所要時間', formatMs(elapsed)],
    ['事前推定', estText],
    ['入力メッシュ', inTris > 0 ? `${inTris.toLocaleString()} 三角形` : 'なし(ゼロベース)'],
    ['出力メッシュ', outTris > 0 ? `${outTris.toLocaleString()} 三角形` : '—'],
  ];
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
    return `# 現在の状態\n` +
      `targetMesh が存在します(バウンディングボックス: ` +
      `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm、原点中心)。\n` +
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
  };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return Object.assign(defaults, JSON.parse(raw));
  } catch (_) { /* 破損時は既定値 */ }
  return defaults;
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

  // ヘッダ操作
  document.getElementById('btn-download').addEventListener('click', downloadStl);
  document.getElementById('btn-reset').addEventListener('click', () => {
    setTargetMesh(null);
    clearError();
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
  sysPrompt.addEventListener('change', () => { settings.systemPrompt = sysPrompt.value; saveSettings(); });
  document.getElementById('btn-reset-prompt').addEventListener('click', () => {
    settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
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
  logChat('sys', 'ようこそ。指示だけでゼロから生成、または STL/3MF を D&D して編集できます。');
  setChatMode('copy');
}

main();
