// i18n.js — UI 文言の日本語/英語辞書と、言語の検出・切替・DOM 反映。
// LLM へ渡すプロンプト類(システムプロンプト・指示テンプレ・サンプルコード)は
// 調整しやすさを優先して main.js 側に置く。ここは画面表示の文言だけを扱う。

const LS_LANG = 'chat3d.lang';               // 言語設定の localStorage キー
export const LANGS = ['ja', 'en'];

// ─────────────────────────────────────────────────────────────
// 辞書
// ─────────────────────────────────────────────────────────────
// キーは「領域.用途」のドット区切り。{name} は t() の第2引数で差し替える。

const JA = {
  // ── ドキュメント/共通 ──
  'doc.title': 'Chat 3D — テキスト/コードで作る STL ツール',
  'doc.desc': 'ブラウザだけで完結する、テキスト指示・コード実行による 3D モデル(STL)生成・編集ツール(PoC)。',
  'common.close': '閉じる',
  'unit.tris': '{n} 三角形',
  'time.ms': '{n} ミリ秒',
  'time.s': '{n} 秒',

  // ── 言語切替 ──
  'lang.label': 'EN',
  'lang.title': 'Switch to English / 英語に切り替える',
  'lang.switched': '表示言語を日本語に切り替えました。',

  // ── ビューポート ──
  'exec.title': '実行中…',
  'exec.warn': '計算中はブラウザの操作を受け付けません。<br>そのままお待ちください。',
  'exec.warnHeavy': '計算中はブラウザの操作を受け付けず、<b>中止もできません</b>。<br>' +
    'ブラウザが「応答しません」と表示したら<br><b>「待機」を選べば処理は続きます</b>。<br>' +
    '規模によっては数分かかり、失敗することもあります。',
  'confirm.cancel': 'やめる',
  'confirm.go': 'それでも実行する',
  'drop.main': 'STL / 3MF ファイルをここにドラッグ＆ドロップ',
  'drop.sub': 'または右パネルの指示だけでゼロから生成できます',
  'app.sub': 'テキスト指示・コード実行で作る 3D モデル(STL/3MF)ツール',
  'badge.modeEdit': 'モード: モデル編集',
  'badge.modeZero': 'モード: ゼロベース生成',
  'badge.mesh': 'メッシュ: {x} × {y} × {z} mm',
  'badge.meshNone': 'メッシュ: なし',

  // ── info パネル ──
  'info.btnTitle': 'このツールについて',
  'info.head': 'Chat 3D について',
  'info.body': `
    <p>ブラウザだけで完結する、テキスト指示 / コード実行による 3D モデル(STL)生成・編集ツールの PoC です。バックエンドは持ちません。</p>
    <ul>
      <li><b>STL 編集</b> — STL/3MF を Drag&amp;Drop で読み込み、チャット指示で CSG 加工(穴あけ・結合など)。</li>
      <li><b>ゼロベース生成</b> — 何も読み込まずチャット指示だけで基本図形 + CSG から生成。</li>
      <li><b>編集</b> — チャットを使わず、拡大縮小・消しゴム・パーツ分割・図形/文字の追加をマウスと数値で直接操作。</li>
      <li><b>コード直接入力</b> — 外部 LLM で作った JavaScript を貼り付けて実行。</li>
    </ul>

    <p class="info-h">CSG とは?</p>
    <p>立体どうしを<b>「足す・引く・重なりを取る」</b>演算のことです。たとえば立方体から円柱を「引く」と、そこに穴が開きます。3D プリンタ用のモデルを組み立てるときの、いちばん基本になる操作です。</p>
    <ul>
      <li><b>結合(union)</b> — 2 つの立体をくっつけて 1 つにする。</li>
      <li><b>削除(subtract)</b> — 片方の立体で削り取る。穴・溝・切り欠きはこれ。</li>
      <li><b>交差(intersect)</b> — 重なっている部分だけを残す。</li>
    </ul>

    <p class="info-h">単位と座標</p>
    <p>数値は <b>mm</b> として扱います(40 と書けば 40mm)。読み込んだモデルは<b>原点が中心</b>になるよう自動で移動されるので、「中心から 20mm 右」のように指示できます。</p>

    <p class="info-h">保存した STL はそのまま印刷できます</p>
    <p>「STL 保存」を押すと、書き出しの直前に<b>自動で水密化(修復)</b>を行います。CSG は原理上、つながっていない面(T ジャンクション)と厚みゼロの内部の壁を作ってしまい、そのまま出すとスライサーで「面が欠けている」「非多様体エッジ」と言われます。それを保存のたびに 1 回だけ直しています。</p>
    <p><b>形は 1 ミクロンも変わりません。</b>頂点は 1 つも動かさず、既存の辺の上にだけ角を足し、体積ゼロの面だけを取り除いているためです。</p>
    <ul>
      <li>実測(20mm のダイス): つながっていない辺 <b>1,316 → 0</b>、非多様体エッジ <b>17 → 0</b>、体積・外形寸法は完全に一致。</li>
      <li><b>Bambu Studio で読み込んでエラーが出ないことを確認済み</b>です(v0.9.1)。修復を促されずにそのままスライスできます。</li>
      <li>保存時に「🩹 面の欠けを修復しました」と出れば成功です。</li>
    </ul>

    <p class="info-h">「三角形が多すぎる」と言われたら</p>
    <p>CSG(穴あけ・結合など)を重ねると、見た目は変わらなくても<b>三角形の数だけが増えていきます</b>。スライサーで警告が出ることがありますが、<b>そのままスライスできるなら何もしないのが一番安全です</b>。</p>
    <ul>
      <li>⚠ <b>「簡略化(Simplify)」は使わないでください。</b>単純に間引く処理は閉じた立体(水密)としての整合性まで見てくれないため、モデルに穴が開いて壊れることがあります。</li>
      <li>どうしても減らしたい場合は、chat-3d 側で分割数を抑えて作り直すほうが確実です(丸みより面取り、円筒の分割は 12〜16 など)。</li>
    </ul>

    <p class="info-h">それでも修復を促されたら</p>
    <p>他のツールや、古いバージョンで保存した STL で修復が必要になったときの注意です。</p>
    <ul>
      <li>⚠ <b>修復は「意図して作った部分」まで消すことがあります。</b>細い突起・薄い板・小さな穴などは、修復する側から見ると「壊れた部分」と区別がつきません。</li>
      <li><b>修復の前後で形を見比べる</b>／<b>修復前の STL を別名で残しておく</b>。</li>
      <li>細部が消えてしまう場合は、修復に頼らず<b>chat-3d 側で作り直す</b>ほうが早いことが多いです(細い部分は 1.5mm 以上、小さすぎる穴はやめる)。</li>
    </ul>

    <p class="info-note">⚠ 貼り付けたコードは、中身を検査せずそのまま実行されます。何が書かれていても実行されてしまうため、出どころの分からないコードは貼り付けないでください。</p>
  `,

  // ── ヘッダ ──
  'head.undo': '元に戻す (Ctrl+Z)',
  'head.redo': 'やり直す (Ctrl+Y)',
  'head.clear': 'クリア',
  'head.clearTitle': 'シーンを空にする',
  'head.save': 'STL 保存',
  'head.saveTitle': '現在のメッシュを STL 保存',

  // ── タブ ──
  'tab.chat': 'チャット',
  'tab.chatTitle': '日本語で指示を出して、LLM にモデルを作らせる／直させるタブ',
  'tab.edit': '編集',
  'tab.editTitle': 'チャットを使わず、マウス操作と数値入力で直接編集するタブ',
  'tab.code': 'コード',
  'tab.codeTitle': 'LLM 側の JavaScript 回答を貼り付けて実行するタブ',
  'tab.settings': '設定',
  'tab.settingsTitle': 'Gemini API キー・モデル・システムプロンプトの設定',

  // ── チャットタブ ──
  'chat.modeCopy': '📋 コピペモード',
  'chat.modeApi': '🔌 API モード',
  'chat.hintSummary': '💡 指示のヒント — できること / できないこと',
  'chat.placeholder': '例: 一辺 40mm の立方体の中心に直径 20mm の貫通穴をあけて',
  'chat.sendCopy': 'プロンプトをコピー',
  'chat.sendApi': '送信',
  'chat.thinking': '生成中…',
  'paste.label': '③ 外部チャットの回答を貼り付け',
  'paste.placeholder': 'LLM の回答(コードを含む全文)をここに貼り付け',
  'paste.run': '貼り付けを実行',
  'guide.copy': '📋 コピペモード: ChatGPT / Claude など、お好きな LLM と手動でやりとりできます(Gemini 限定ではありません)。\n' +
    '① 下の入力欄に指示を書いて「プロンプトをコピー」を押す(クリップボードにコピーされます)。\n' +
    '② コピーした内容を外部チャットに貼り付けて送信する。\n' +
    '③ 返ってきた回答(コードを含む全文)を下の「外部チャットの回答を貼り付け」欄に貼り付け、' +
    '「貼り付けを実行」を押すとこのシーンに反映されます。',
  'guide.api': '🔌 API モード: 設定タブに登録した Gemini API キーを使い、指示の送信からコード実行まで自動で行います。',
  'copy.summary': '📋 送信用プロンプト(クリックで折りたたみ)',
  'copy.btn': '📋 コピー',
  'copy.ok': '✅ コピーしました',
  'copy.fail': '⚠ コピー失敗(手動で選択してください)',
  'hint.limitsTitle': 'できないこと(LLM は形を見ていません)',
  'hint.note': '形を指し示す指示は通りません。かわりに<b>寸法と座標(mm)</b>で伝えてください。' +
    '3D ビューを見て判断するのはあなたの役割です。',

  // ── 編集タブ ──
  'edit.hint': 'チャットを使わずに直接編集します。操作はすべてヘッダの <b>↶ / ↷</b>(Ctrl+Z / Ctrl+Y)で元に戻せます。',
  'edit.noModel': 'モデル未読み込み',
  'edit.readout': '寸法 {x} × {y} × {z} mm / {tris} 三角形',
  'edit.secScale': '拡大・縮小',
  'edit.scaleAll': '全体倍率',
  'edit.apply': '適用',
  'edit.noteXyz': 'XYZ 個別(1 のままの軸は変わりません)',
  'edit.applyXyz': 'XYZ を適用',
  'edit.noteSize': '寸法(mm)を直接指定して合わせることもできます',
  'edit.keepRatio': '比率を保つ',
  'edit.applySize': '寸法を適用',
  'edit.secEraser': '消しゴム(クリックで削る)',
  'edit.eraserNote': 'ON にしてモデルをクリックすると、その位置を球状に削ります。削るたびに CSG 計算が走るため、複雑なモデルでは数秒かかります。',
  'edit.eraserOn': '消しゴム: ON',
  'edit.eraserOff': '消しゴム: OFF',
  'edit.eraserGuide': 'モデルをクリックすると、その位置を球状に削ります。',
  'edit.radius': '半径',
  'edit.secParts': 'パーツ分割・個別編集',
  'edit.partsNote': 'つながっていない部分(板・部品など)を自動で認識して一覧にします。選んだパーツだけを拡大縮小・削除できます。',
  'edit.splitRun': 'パーツに分割して認識',
  'edit.partsOpsNote': '選択中のパーツを、そのパーツの中心を基準に拡大縮小します',
  'edit.partDelete': 'このパーツを削除',
  'edit.partApply': 'パーツに適用',
  'edit.partsFound': 'パーツを {n} 個認識しました(編集タブの一覧から選べます)。',
  'edit.secAdd': '図形・テキストを追加',
  'edit.shape': '図形',
  'edit.shapeBox': '直方体',
  'edit.shapeCylinder': '円柱',
  'edit.shapeSphere': '球',
  'edit.shapeCone': '円錐',
  'edit.dimW': '幅/径',
  'edit.dimH': '高さ',
  'edit.dimD': '奥行',
  'edit.posNote': '配置する位置(mm・原点が中心)',
  'edit.primSub': 'この形で削る',
  'edit.primAdd': '追加(結合)',
  'edit.textNote': 'テキスト(<b>半角英数字のみ</b>。日本語フォントは未対応です)',
  'edit.textSize': '文字高',
  'edit.textDepth': '厚み',
  'edit.textY': 'Y位置',
  'edit.textSub': '文字を彫る',
  'edit.textAdd': '文字を追加',

  // ── コードタブ ──
  'code.hint': '<b>LLM 側の JavaScript 回答</b>をここに貼り付けて「STL反映実行」を押すと、3D ビューに反映されます。' +
    'コードには <code>scene</code> / <code>THREE</code> / <code>CSG</code> / <code>targetMesh</code> / <code>setResult(mesh)</code> が渡されます。',
  'code.sample': 'サンプル挿入',
  'code.sampleTitle': '動作確認用のサンプルコードを入れ直す',
  'code.clear': 'クリア',
  'code.clearTitle': '入力欄を空にする',
  'code.run': 'STL反映実行',
  'code.runTitle': 'コードを実行して 3D ビューのメッシュを差し替える',
  'code.debugHead': '🔎 実行レポート',

  // ── 設定タブ ──
  'set.apiKey': 'Gemini API キー',
  'set.apiKeyNote': 'ブラウザの localStorage にのみ保存されます(サーバ送信なし)。',
  'set.model': 'モデル',
  'set.sysPrompt': 'システムプロンプト(編集可)',
  'set.resetPrompt': '既定に戻す',

  // ── 実行前ガード / 実行レポート ──
  'op.subtract': '削り取り',
  'op.union': '結合',
  'op.runCode': 'コード実行',
  'pre.noteTris': '対象 {n} 三角形',
  'pre.noteEst': '推定 約{t}(過去の実測より)',
  'pre.title': '⚠ {op}: 時間がかかります',
  'pre.lineTris': '対象は <b>{n} 三角形</b>あります。',
  'pre.lineEst': '過去の実測から <b>約{t}</b> かかる見込みです。',
  'pre.lineNoEst': '近い規模の実測データが無いため、所要時間は予測できません。',
  'pre.lineRisk': '<b>数分かかることがあり、ブラウザがタブを強制終了して作業が失われる場合があります。</b>',
  'pre.lineWait': '計算中は中止できません。「応答しません」と出たら<b>「待機」</b>を選んでください。',
  'pre.lineBackup': '先に「STL 保存」でバックアップしておくことを強くおすすめします。',
  'dbg.result': '結果',
  'dbg.ok': '✅ 反映しました',
  'dbg.ng': '⚠ 反映できませんでした',
  'dbg.elapsed': '所要時間',
  'dbg.est': '事前推定',
  'dbg.estApprox': '約{t}',
  'dbg.estOff': '(実測と乖離)',
  'dbg.in': '入力メッシュ',
  'dbg.out': '出力メッシュ',
  'dbg.zeroBase': 'なし(ゼロベース)',
  'dbg.nextTitle': '⚠ 次の実行',
  'dbg.next': 'この {n} 三角形が次回の入力になります。続けて加工すると、さらに時間がかかります。区切りで「STL 保存」をおすすめします。',

  // ── 進行中メッセージ ──
  'busy.scale': '拡大縮小を適用しています…',
  'busy.parts': 'パーツを認識しています…',
  'busy.partScale': 'パーツを変形しています…',
  'busy.partDelete': 'パーツを削除しています…',
  'busy.erase': '半径 {r}mm で削っています…',
  'busy.primUnion': '図形を結合しています…',
  'busy.primSub': '図形で削っています…',
  'busy.textUnion': '文字を結合しています…',
  'busy.textSub': '文字を彫っています…',
  'busy.watertight': 'STL を水密化しています(面の欠けを解消)…',

  // ── トースト(STL 保存) ──
  'toast.saved': '💾 保存しました({tris} 三角形)。',
  'toast.repaired': '<br>🩹 面の欠けを修復しました({in} → {out} 三角形{state})。形は変わりません。',
  'toast.watertight': '、<b>水密</b>',
  'toast.remain': '、未解消 {n} 箇所',
  'toast.heavy': '<br><b>スライサーで「三角形が多い」と警告が出る可能性があります。</b>' +
    '出ても<b>簡略化(Simplify)は使わず</b>、詳しくは右上「i」の「「三角形が多すぎる」と言われたら」をご確認ください。',

  // ── エラー ──
  'err.head': '⚠ 実行エラー',
  'err.default': '実行エラー',
  'err.editTitle': '編集処理でエラーが発生しました',
  'err.inputTitle': '入力エラー',
  'err.scalePositive': '倍率は 0 より大きい数値で指定してください。',
  'err.noMeshTitle': 'モデルがありません',
  'err.noMesh': '先に STL/3MF を読み込むか、図形を追加してモデルを用意してください。',
  'err.mergeNone': 'mergeMeshes: 合成できるメッシュが渡されていません。',
  'err.mergeFail': 'mergeMeshes: ジオメトリの合成に失敗しました。',
  'err.partMergeFail': 'パーツの再結合に失敗しました。',
  'err.partLastTitle': '削除できません',
  'err.partLast': '最後の1パーツは削除できません。「クリア」を使ってください。',
  'err.fontLoad': 'フォントの読み込みに失敗しました(ネットワークを確認してください)。',
  'err.textEmpty': '追加する文字を入力してください。',
  'err.textCharsTitle': 'この文字は使えません',
  'err.textChars': '半角英数字・記号のみ対応しています(日本語フォントは未対応)。',
  'err.unsupportedTitle': '未対応のファイル形式',
  'err.unsupported': '対応形式は STL / 3MF のみです: {name}',
  'err.loadFailTitle': 'モデルの読み込みに失敗しました',
  'err.readFileTitle': 'ファイル読み込みエラー',
  'err.no3mfMesh': '3MF 内にメッシュが見つかりませんでした。',
  'err.emptyCodeTitle': 'コードが空です',
  'err.emptyCode': '実行するコードがありません',
  'err.noResultTitle': 'メッシュを取得できませんでした',
  'err.noResult': 'setResult(mesh) が呼ばれず、メッシュも return されませんでした。\n完成メッシュを setResult(...) で登録してください。',
  'err.runtimeTitle': '実行時エラー',
  'err.apiKeyMissing': '設定タブで Gemini API キーを入力してください。',
  'err.geminiApi': 'Gemini API エラー {status}\n{detail}',
  'err.geminiEmpty': 'Gemini から空の応答が返りました。',
  'err.geminiTitle': 'Gemini 連携エラー',

  // ── システムメッセージ ──
  'msg.loaded': '{fmt} を読み込みました: {name}',
  'msg.errSeeBelow': 'エラーが発生しました。詳細は下部のエラー欄を参照してください。',
  'msg.copied': '✅ プロンプトをクリップボードにコピーしました。外部チャットに貼り付けて送信してください。',
  'msg.copyFail': '⚠ クリップボードへのコピーに失敗しました。下に表示したプロンプトを手動で選択してコピーしてください。',
  'msg.cleared': 'シーンをクリアしました(ゼロベース生成モード)。',
  'msg.welcome1': 'ようこそ。指示だけでゼロから生成、または STL/3MF を D&D して編集できます。',
  'msg.welcome2': 'チャットを使わずに直接編集したい場合は「編集」タブへ。拡大縮小・消しゴム・パーツ分割・図形/文字の追加ができます。',

  // ── フッター ──
  'foot.tip': 'チップ',
  'foot.feedback': 'ご意見・ご要望',
  'foot.sep': '・',
};

const EN = {
  // ── Document / shared ──
  'doc.title': 'Chat 3D — build STL files from text or code',
  'doc.desc': 'A browser-only proof of concept for generating and editing 3D models (STL) from text instructions or executable code.',
  'common.close': 'Close',
  'unit.tris': '{n} triangles',
  'time.ms': '{n} ms',
  'time.s': '{n} s',

  // ── Language switch ──
  'lang.label': '日本語',
  'lang.title': '日本語に切り替える / Switch to Japanese',
  'lang.switched': 'Display language switched to English.',

  // ── Viewport ──
  'exec.title': 'Working…',
  'exec.warn': 'The browser will not respond while this runs.<br>Please wait.',
  'exec.warnHeavy': 'The browser will not respond while this runs, and <b>it cannot be cancelled</b>.<br>' +
    'If your browser says the page is unresponsive,<br><b>choose “Wait” and the job will continue</b>.<br>' +
    'Large models can take several minutes, and may fail.',
  'confirm.cancel': 'Cancel',
  'confirm.go': 'Run anyway',
  'drop.main': 'Drag & drop an STL / 3MF file here',
  'drop.sub': 'Or generate one from scratch using the panel on the right',
  'app.sub': 'Build 3D models (STL/3MF) from text instructions or code',
  'badge.modeEdit': 'Mode: editing a model',
  'badge.modeZero': 'Mode: generate from scratch',
  'badge.mesh': 'Mesh: {x} × {y} × {z} mm',
  'badge.meshNone': 'Mesh: none',

  // ── Info panel ──
  'info.btnTitle': 'About this tool',
  'info.head': 'About Chat 3D',
  'info.body': `
    <p>A browser-only proof of concept for generating and editing 3D models (STL) from text instructions or executable code. There is no backend.</p>
    <ul>
      <li><b>Edit an STL</b> — drag &amp; drop an STL/3MF, then reshape it with CSG through chat instructions (drill holes, merge parts, …).</li>
      <li><b>Generate from scratch</b> — start from an empty scene and build with primitives + CSG using chat alone.</li>
      <li><b>Edit tab</b> — no chat needed: scale, erase, split into parts, add shapes and text using the mouse and numeric fields.</li>
      <li><b>Paste code</b> — run JavaScript you produced with any external LLM.</li>
    </ul>

    <p class="info-h">What is CSG?</p>
    <p>CSG means <b>adding, subtracting and intersecting</b> solids. Subtract a cylinder from a cube and you get a hole. It is the most basic operation for assembling a printable model.</p>
    <ul>
      <li><b>union</b> — fuse two solids into one.</li>
      <li><b>subtract</b> — carve one solid out of another. Holes, slots and notches are all this.</li>
      <li><b>intersect</b> — keep only the overlapping region.</li>
    </ul>

    <p class="info-h">Units and coordinates</p>
    <p>Numbers are <b>millimetres</b> (write 40 and you get 40&nbsp;mm). A loaded model is automatically moved so that <b>the origin is at its centre</b>, so you can say things like “20&nbsp;mm to the right of the centre”.</p>

    <p class="info-h">Saved STL files are ready to print</p>
    <p>When you press “Save STL”, the mesh is <b>made watertight automatically</b> just before export. By design, CSG leaves faces that do not share their corners (T-junctions) and zero-thickness internal walls; exported as-is, a slicer reports “missing faces” and “non-manifold edges”. That is repaired once, on every save.</p>
    <p><b>The shape does not change by even a micron.</b> No vertex is moved — corners are only added along edges that already exist, and only faces with zero volume are removed.</p>
    <ul>
      <li>Measured on a 20&nbsp;mm die: unconnected edges <b>1,316 → 0</b>, non-manifold edges <b>17 → 0</b>, volume and bounding box identical.</li>
      <li><b>Verified to load in Bambu Studio with no errors</b> (v0.9.1). It slices directly, with no repair prompt.</li>
      <li>If the toast says “🩹 Repaired missing faces” after saving, it worked.</li>
    </ul>

    <p class="info-h">If your slicer says “too many triangles”</p>
    <p>Every CSG operation (holes, merges, …) increases <b>the triangle count</b> even when the shape looks the same, so a slicer may warn you. <b>If it still slices, the safest action is to do nothing.</b></p>
    <ul>
      <li>⚠ <b>Do not use “Simplify”.</b> Naive decimation ignores watertightness, so it can punch holes in the model and break it.</li>
      <li>If you really must reduce the count, rebuild it here with fewer segments instead (prefer chamfers over fillets, 12–16 segments for cylinders, and so on).</li>
    </ul>

    <p class="info-h">If something still asks you to repair</p>
    <p>Notes for other tools, or for STL files saved with an older version.</p>
    <ul>
      <li>⚠ <b>Repair can delete parts you meant to keep.</b> Thin pins, thin plates and small holes look exactly like damage to a repair algorithm.</li>
      <li><b>Compare the shape before and after</b>, and <b>keep the pre-repair STL under a different name</b>.</li>
      <li>If detail disappears, rebuilding it here is usually faster than fighting the repair (keep thin features at 1.5&nbsp;mm or more, and avoid very small holes).</li>
    </ul>

    <p class="info-note">⚠ Pasted code is executed as-is, with no inspection whatsoever. Anything it contains will run, so never paste code you do not trust.</p>
  `,

  // ── Header ──
  'head.undo': 'Undo (Ctrl+Z)',
  'head.redo': 'Redo (Ctrl+Y)',
  'head.clear': 'Clear',
  'head.clearTitle': 'Empty the scene',
  'head.save': 'Save STL',
  'head.saveTitle': 'Save the current mesh as STL',

  // ── Tabs ──
  'tab.chat': 'Chat',
  'tab.chatTitle': 'Describe what you want and let an LLM build or fix the model',
  'tab.edit': 'Edit',
  'tab.editTitle': 'Edit directly with the mouse and numeric fields, without chat',
  'tab.code': 'Code',
  'tab.codeTitle': 'Paste the JavaScript an LLM returned and run it',
  'tab.settings': 'Settings',
  'tab.settingsTitle': 'Gemini API key, model and system prompt',

  // ── Chat tab ──
  'chat.modeCopy': '📋 Copy & paste',
  'chat.modeApi': '🔌 API mode',
  'chat.hintSummary': '💡 Instruction hints — what works, what does not',
  'chat.placeholder': 'e.g. Drill a 20 mm through-hole in the centre of a 40 mm cube',
  'chat.sendCopy': 'Copy prompt',
  'chat.sendApi': 'Send',
  'chat.thinking': 'Generating…',
  'paste.label': '③ Paste the reply from your external chat',
  'paste.placeholder': 'Paste the LLM reply here (the whole answer, code included)',
  'paste.run': 'Run pasted reply',
  'guide.copy': '📋 Copy & paste mode: works with any LLM you like — ChatGPT, Claude and others, not just Gemini.\n' +
    '1. Type your instruction below and press “Copy prompt” (it goes to your clipboard).\n' +
    '2. Paste it into your external chat and send it.\n' +
    '3. Paste the reply (the whole answer, code included) into the “Paste the reply” box below and press ' +
    '“Run pasted reply” to apply it to this scene.',
  'guide.api': '🔌 API mode: uses the Gemini API key from the Settings tab to send your instruction and run the returned code automatically.',
  'copy.summary': '📋 Prompt to send (click to collapse)',
  'copy.btn': '📋 Copy',
  'copy.ok': '✅ Copied',
  'copy.fail': '⚠ Copy failed — please select it manually',
  'hint.limitsTitle': 'What does not work (the LLM cannot see the shape)',
  'hint.note': 'Instructions that point at a feature will not work. Describe it with <b>dimensions and coordinates (mm)</b> instead. ' +
    'Judging the shape in the 3D view is your job.',

  // ── Edit tab ──
  'edit.hint': 'Edit directly, without chat. Everything here can be undone with <b>↶ / ↷</b> in the header (Ctrl+Z / Ctrl+Y).',
  'edit.noModel': 'No model loaded',
  'edit.readout': 'Size {x} × {y} × {z} mm / {tris} triangles',
  'edit.secScale': 'Scale',
  'edit.scaleAll': 'Uniform factor',
  'edit.apply': 'Apply',
  'edit.noteXyz': 'Per axis (an axis left at 1 is unchanged)',
  'edit.applyXyz': 'Apply XYZ',
  'edit.noteSize': 'You can also enter the target size in mm directly',
  'edit.keepRatio': 'Keep proportions',
  'edit.applySize': 'Apply size',
  'edit.secEraser': 'Eraser (click to carve)',
  'edit.eraserNote': 'Turn it on and click the model to carve a sphere out at that point. Each click runs a CSG operation, so complex models take a few seconds.',
  'edit.eraserOn': 'Eraser: ON',
  'edit.eraserOff': 'Eraser: OFF',
  'edit.eraserGuide': 'Click the model to carve a sphere out at that point.',
  'edit.radius': 'Radius',
  'edit.secParts': 'Split into parts',
  'edit.partsNote': 'Detects disconnected pieces (plates, components, …) and lists them. You can scale or delete a single part.',
  'edit.splitRun': 'Detect parts',
  'edit.partsOpsNote': 'Scales the selected part around its own centre',
  'edit.partDelete': 'Delete this part',
  'edit.partApply': 'Apply to part',
  'edit.partsFound': 'Found {n} parts (pick one from the list in the Edit tab).',
  'edit.secAdd': 'Add a shape or text',
  'edit.shape': 'Shape',
  'edit.shapeBox': 'Box',
  'edit.shapeCylinder': 'Cylinder',
  'edit.shapeSphere': 'Sphere',
  'edit.shapeCone': 'Cone',
  'edit.dimW': 'Width/⌀',
  'edit.dimH': 'Height',
  'edit.dimD': 'Depth',
  'edit.posNote': 'Position (mm, origin at the centre)',
  'edit.primSub': 'Carve with this',
  'edit.primAdd': 'Add (union)',
  'edit.textNote': 'Text (<b>ASCII only</b> — Japanese fonts are not supported)',
  'edit.textSize': 'Cap height',
  'edit.textDepth': 'Depth',
  'edit.textY': 'Y offset',
  'edit.textSub': 'Engrave text',
  'edit.textAdd': 'Add text',

  // ── Code tab ──
  'code.hint': 'Paste <b>the JavaScript an LLM returned</b> here and press “Run” to apply it to the 3D view. ' +
    'The code receives <code>scene</code> / <code>THREE</code> / <code>CSG</code> / <code>targetMesh</code> / <code>setResult(mesh)</code>.',
  'code.sample': 'Insert sample',
  'code.sampleTitle': 'Restore the sample code',
  'code.clear': 'Clear',
  'code.clearTitle': 'Empty the editor',
  'code.run': 'Run',
  'code.runTitle': 'Run the code and replace the mesh in the 3D view',
  'code.debugHead': '🔎 Run report',

  // ── Settings tab ──
  'set.apiKey': 'Gemini API key',
  'set.apiKeyNote': 'Stored only in your browser’s localStorage (never sent to our servers).',
  'set.model': 'Model',
  'set.sysPrompt': 'System prompt (editable)',
  'set.resetPrompt': 'Restore default',

  // ── Preflight / run report ──
  'op.subtract': 'Carve',
  'op.union': 'Union',
  'op.runCode': 'Run code',
  'pre.noteTris': '{n} triangles in',
  'pre.noteEst': 'est. {t} (from past runs)',
  'pre.title': '⚠ {op}: this will take a while',
  'pre.lineTris': 'The input has <b>{n} triangles</b>.',
  'pre.lineEst': 'Past runs suggest this will take <b>about {t}</b>.',
  'pre.lineNoEst': 'There is no measurement at a comparable size, so the duration cannot be predicted.',
  'pre.lineRisk': '<b>It can take several minutes, and the browser may kill the tab and lose your work.</b>',
  'pre.lineWait': 'It cannot be cancelled once started. If the browser says “unresponsive”, choose <b>“Wait”</b>.',
  'pre.lineBackup': 'Saving a backup with “Save STL” first is strongly recommended.',
  'dbg.result': 'Result',
  'dbg.ok': '✅ Applied',
  'dbg.ng': '⚠ Not applied',
  'dbg.elapsed': 'Elapsed',
  'dbg.est': 'Estimate',
  'dbg.estApprox': 'about {t}',
  'dbg.estOff': ' (off vs. measured)',
  'dbg.in': 'Input mesh',
  'dbg.out': 'Output mesh',
  'dbg.zeroBase': 'none (from scratch)',
  'dbg.nextTitle': '⚠ Next run',
  'dbg.next': 'These {n} triangles become the input next time. Further operations will take even longer — consider saving the STL here.',

  // ── Progress ──
  'busy.scale': 'Scaling…',
  'busy.parts': 'Detecting parts…',
  'busy.partScale': 'Transforming the part…',
  'busy.partDelete': 'Deleting the part…',
  'busy.erase': 'Carving with a {r} mm radius…',
  'busy.primUnion': 'Merging the shape…',
  'busy.primSub': 'Carving with the shape…',
  'busy.textUnion': 'Merging the text…',
  'busy.textSub': 'Engraving the text…',
  'busy.watertight': 'Making the STL watertight (fixing missing faces)…',

  // ── Save toast ──
  'toast.saved': '💾 Saved ({tris} triangles).',
  'toast.repaired': '<br>🩹 Repaired missing faces ({in} → {out} triangles{state}). The shape is unchanged.',
  'toast.watertight': ', <b>watertight</b>',
  'toast.remain': ', {n} left unresolved',
  'toast.heavy': '<br><b>Your slicer may warn that the triangle count is high.</b> ' +
    'If it does, <b>do not use “Simplify”</b> — see “If your slicer says too many triangles” under the “i” button.',

  // ── Errors ──
  'err.head': '⚠ Error',
  'err.default': 'Error',
  'err.editTitle': 'The edit operation failed',
  'err.inputTitle': 'Invalid input',
  'err.scalePositive': 'The factor must be a number greater than 0.',
  'err.noMeshTitle': 'No model',
  'err.noMesh': 'Load an STL/3MF first, or add a shape to create one.',
  'err.mergeNone': 'mergeMeshes: no mergeable mesh was passed.',
  'err.mergeFail': 'mergeMeshes: failed to merge the geometries.',
  'err.partMergeFail': 'Failed to reassemble the parts.',
  'err.partLastTitle': 'Cannot delete',
  'err.partLast': 'The last remaining part cannot be deleted. Use “Clear” instead.',
  'err.fontLoad': 'Failed to load the font (please check your network connection).',
  'err.textEmpty': 'Enter the text you want to add.',
  'err.textCharsTitle': 'Unsupported characters',
  'err.textChars': 'Only ASCII letters, digits and symbols are supported (no Japanese font).',
  'err.unsupportedTitle': 'Unsupported file type',
  'err.unsupported': 'Only STL and 3MF are supported: {name}',
  'err.loadFailTitle': 'Failed to load the model',
  'err.readFileTitle': 'File read error',
  'err.no3mfMesh': 'No mesh was found inside the 3MF.',
  'err.emptyCodeTitle': 'No code',
  'err.emptyCode': 'There is no code to run',
  'err.noResultTitle': 'No mesh was produced',
  'err.noResult': 'setResult(mesh) was never called and no mesh was returned.\nRegister the finished mesh with setResult(...).',
  'err.runtimeTitle': 'Runtime error',
  'err.apiKeyMissing': 'Enter your Gemini API key in the Settings tab.',
  'err.geminiApi': 'Gemini API error {status}\n{detail}',
  'err.geminiEmpty': 'Gemini returned an empty response.',
  'err.geminiTitle': 'Gemini request failed',

  // ── System messages ──
  'msg.loaded': 'Loaded {fmt}: {name}',
  'msg.errSeeBelow': 'Something went wrong. See the error box below for details.',
  'msg.copied': '✅ Prompt copied to the clipboard. Paste it into your external chat and send it.',
  'msg.copyFail': '⚠ Could not write to the clipboard. Select the prompt shown below and copy it manually.',
  'msg.cleared': 'Scene cleared (generate-from-scratch mode).',
  'msg.welcome1': 'Welcome. Generate a model from instructions alone, or drag & drop an STL/3MF to edit it.',
  'msg.welcome2': 'To edit without chat, open the “Edit” tab: scaling, eraser, part splitting and adding shapes or text.',

  // ── Footer ──
  'foot.tip': 'Tip',
  'foot.feedback': 'Feedback',
  'foot.sep': '·',
};

const DICT = { ja: JA, en: EN };

// ─────────────────────────────────────────────────────────────
// 言語の状態
// ─────────────────────────────────────────────────────────────

let current = 'ja';
const listeners = [];

/**
 * 保存済みの選択、無ければブラウザの言語設定から初期言語を決める。
 * 日本語環境のみ 'ja'、それ以外は 'en'(英語しか読めない人を締め出さないため)。
 * @returns {'ja'|'en'}
 */
export function detectLang() {
  try {
    const saved = localStorage.getItem(LS_LANG);
    if (saved && LANGS.includes(saved)) return saved;
  } catch (_) { /* プライベートモード等では読めない */ }
  const nav = (navigator.language || 'ja').toLowerCase();
  return nav.startsWith('ja') ? 'ja' : 'en';
}

/** 現在の言語コードを返す */
export function getLang() {
  return current;
}

/**
 * 言語を切り替えて localStorage に保存し、登録済みリスナーへ通知する。
 * @param {'ja'|'en'} lang
 */
export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : 'ja';
  try { localStorage.setItem(LS_LANG, current); } catch (_) { /* 保存できなくても続行 */ }
  applyStaticI18n();
  listeners.forEach((fn) => fn(current));
}

/** 言語切替時に呼ばれるコールバックを登録する(動的に描画した部分の再生成用) */
export function onLangChange(fn) {
  listeners.push(fn);
}

/**
 * 文言を引く。{name} を params の値で差し替える。
 * 未定義キーは日本語へフォールバックし、それも無ければキー名をそのまま返す
 * (画面上で欠落に気づけるようにするため、握りつぶさない)。
 * @param {string} key 辞書キー
 * @param {Object<string,*>} [params] 差し替える値
 * @returns {string}
 */
export function t(key, params) {
  let s = DICT[current][key];
  if (s === undefined) s = JA[key];
  if (s === undefined) return key;
  if (params) {
    for (const k of Object.keys(params)) s = s.split(`{${k}}`).join(params[k]);
  }
  return s;
}

/**
 * data-i18n 系の属性が付いた要素へ、現在の言語の文言を流し込む。
 * - data-i18n       … textContent
 * - data-i18n-html  … innerHTML(タグを含む文言用)
 * - data-i18n-title … title 属性
 * - data-i18n-ph    … placeholder 属性
 * @param {ParentNode} [root=document]
 */
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-ph'));
  });
  if (root === document) {
    document.documentElement.lang = current;
    document.title = t('doc.title');
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.content = t('doc.desc');
    const foot = document.querySelector('.su-foot');
    if (foot) foot.setAttribute('data-lang', current);
  }
}

current = detectLang();
