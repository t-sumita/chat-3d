// main.js — Chat 3D の中核ロジック
// 3D プレビュー / STL 入出力 / 動的コード実行エンジン / Gemini 連携をまとめる。
// バックエンドは一切持たず、すべてブラウザ内で完結する。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSG } from 'three-csg-ts';

// ─────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────

const LS_KEY = 'chat3d.settings.v1';          // localStorage キー
const MODEL_COLOR = 0x9ec5ff;                  // 生成メッシュの既定色

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
  const fenced = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * 抽出済み JS を new Function で実行し、結果メッシュでシーンを更新する。
 * scene / THREE / CSG / targetMesh / setResult を引数として渡す。
 * @returns {boolean} 成功したか
 */
function runUserCode(code) {
  clearError();
  if (!code) {
    showError(new Error('実行するコードがありません'), 'コードが空です');
    return false;
  }

  let result = null;
  const setResult = (mesh) => { result = mesh; };

  try {
    // 'use strict' を付けて、暗黙のグローバル汚染を防ぐ
    const fn = new Function(
      'scene', 'THREE', 'CSG', 'targetMesh', 'setResult',
      '"use strict";\n' + code);
    const ret = fn(scene, THREE, CSG, targetMesh, setResult);

    // setResult 優先。無ければ return 値をメッシュとして扱う
    const mesh = result || ret;
    if (mesh && mesh.isMesh) {
      setTargetMesh(mesh);
      return true;
    }
    // メッシュが返らなかった: scene 直接操作とみなし、警告のみ
    showError(
      new Error('setResult(mesh) が呼ばれず、メッシュも return されませんでした。\n' +
        '完成メッシュを setResult(...) で登録してください。'),
      'メッシュを取得できませんでした');
    return false;
  } catch (err) {
    showError(err, '実行時エラー');
    return false;
  }
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
    runUserCode(code);
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
  return esc(text).replace(/```(?:js|javascript)?\s*([\s\S]*?)```/gi,
    (_, code) => `<pre>${code.trim()}</pre>`);
}

// ─────────────────────────────────────────────────────────────
// 設定の保存/復元(localStorage)
// ─────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { /* 破損時は既定値 */ }
  return { apiKey: '', model: 'gemini-2.5-flash', systemPrompt: DEFAULT_SYSTEM_PROMPT };
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

  // チャット送信
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    handleChatSend(text);
  });
  // Ctrl/Cmd+Enter で送信
  chatInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // コード直接入力
  const codeInput = document.getElementById('code-input');
  codeInput.value = SAMPLE_CODE;
  document.getElementById('btn-run').addEventListener('click', () => {
    runUserCode(extractCode(codeInput.value));
  });
  document.getElementById('btn-sample').addEventListener('click', () => {
    codeInput.value = SAMPLE_CODE;
  });

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
  logChat('sys', 'ようこそ。指示だけでゼロから生成、または STL を D&D して編集できます。');
}

main();
