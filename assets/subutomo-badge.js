/*
 * Subutomo site-selector badge (portable, dependency-free, ES5)
 *
 * Looks identical to the shared Subutomo Dev footer (official logo +
 * copyright) used across sites; clicking it toggles a panel listing
 * the other Subutomo Dev sites (lazy-fetched from the site ledger).
 *
 * Usage:
 *   <script>
 *     window.SUBUTOMO_BADGE_CONFIG = {
 *       currentSiteId: 'subuta-site',
 *       sitesJsonPath: './config/subutomo-sites.json',
 *       logoPath: './common/assets/logo.png',
 *       theme: 'light-bg',          // 'light-bg' | 'dark-bg'
 *       elementId: '',              // optional id for the badge element so
 *                                   // host scripts can bind extra handlers
 *       privacy: {                  // optional privacy notes shown at the
 *         localStorage: false,      // bottom of the panel; section is
 *         analytics: false          // hidden when omitted or all false
 *       },
 *       onSecretAction: null        // reserved hook, no auth implemented
 *     };
 *   </script>
 *   <script src="./assets/subutomo-badge.js"></script>
 *
 * Shift+click on the badge is ignored by the panel toggle, leaving it
 * free for host-site integrations (e.g. hidden admin entry).
 * Panel UI text auto-switches JA/EN by <html lang> (lang starts with
 * "ja" -> Japanese, otherwise English). Site titles/descriptions use the
 * ledger's *_ja fields when present, falling back to the English fields.
 * The language is re-read dynamically: the panel re-renders on open, on
 * <html lang> changes (MutationObserver), and on a "subu:langchange" event
 * dispatched on document -- so a host JP/EN toggle updates the badge live.
 * Brand name and copyright are not translated. No frameworks, no modules.
 */
(function () {
  'use strict';

  var cfg = window.SUBUTOMO_BADGE_CONFIG || {};
  var currentSiteId = cfg.currentSiteId || '';
  var sitesJsonPath = cfg.sitesJsonPath || './config/subutomo-sites.json';
  var logoPath      = cfg.logoPath || './common/assets/logo.png';
  var theme         = cfg.theme === 'dark-bg' ? 'dark-bg' : 'light-bg';
  var elementId     = cfg.elementId || '';
  var privacy       = cfg.privacy || null;
  // Reserved for future secret actions; intentionally unused for now.
  var onSecretAction =
    typeof cfg.onSecretAction === 'function' ? cfg.onSecretAction : null;

  var COPYRIGHT = '© ' + new Date().getFullYear() + ' Subutomo Dev';
  var versionSuffix = cfg.version ? ' (v' + cfg.version + ')' : '';
  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

  // ── i18n: <html lang> で自動切替("ja*" → 日本語 / それ以外 → 英語)──
  // ブランド名(Subutomo Dev)とコピーライトは不訳。サイト説明は台帳の
  // *_ja フィールド優先・無ければ英語にフォールバック。
  // 言語は読み込み時固定ではなく動的に読み直す(refreshLang)。後からの
  // JP/EN トグルに追従させるため、パネル開閉・<html lang>変更・subu:langchange
  // を契機に再評価して再描画する。
  var STR = {
    en: {
      loading: 'Loading...',
      failed: 'Failed to load links',
      empty: 'No other sites yet',
      privacyLocal: 'Settings are saved in your browser only.',
      privacyAnalytics: 'Anonymous, cookieless analytics by Cloudflare.'
    },
    ja: {
      loading: '読み込み中…',
      failed: 'リンクを読み込めませんでした',
      empty: 'ほかのサイトはまだありません',
      privacyLocal: '設定はお使いのブラウザ内にのみ保存されます。',
      privacyAnalytics: 'Cloudflare による匿名・Cookie 不使用のアクセス解析を行っています。'
    }
  };
  var lang, T;
  // 現在の <html lang> を読み直して lang / T を更新。変化があれば true を返す。
  function refreshLang() {
    var L = (document.documentElement.lang || '')
      .toLowerCase().indexOf('ja') === 0 ? 'ja' : 'en';
    var changed = (L !== lang);
    lang = L;
    T = STR[lang] || STR.en;
    return changed;
  }
  refreshLang();

  // パネルの title / description を言語選択。次のいずれの形でも安全に扱う:
  //   ・文字列(英語)            例: "QIX-style ..."
  //   ・{en, ja} オブジェクト     例: { en: "...", ja: "..." }
  //   ・"*_ja" 併記フィールド     例: description + description_ja
  function pickText(val, valJa) {
    if (val && typeof val === 'object') {
      return val[lang] || val.en || val.ja || '';
    }
    if (lang === 'ja' && valJa) return valJa;
    return val || '';
  }

  // colors matching the shared subutomo-footer component
  var textColor = theme === 'light-bg'
    ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.5)';
  var textHover = theme === 'light-bg'
    ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';
  var lineColor = theme === 'light-bg'
    ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)';

  // ── styles (su- prefixed, injected once) ──────────────────────────
  var style = document.createElement('style');
  style.textContent =
    '.su-badge{position:fixed;bottom:16px;left:16px;display:flex;' +
    'align-items:center;gap:8px;cursor:pointer;z-index:9999;' +
    'user-select:none;-webkit-user-select:none;}' +
    '.su-badge img{width:24px;height:24px;opacity:0.6;' +
    'transition:opacity 0.3s;}' +
    '.su-badge span{font-family:monospace;font-size:11px;' +
    'letter-spacing:1px;color:' + textColor + ';position:relative;' +
    'transition:color 0.3s;}' +
    '.su-badge span::after{content:"";position:absolute;bottom:-2px;' +
    'left:0;width:0;height:1px;background:' + lineColor + ';' +
    'transition:width 0.4s ease;}' +
    '.su-badge:hover img{opacity:1.0;}' +
    '.su-badge:hover span{color:' + textHover + ';}' +
    '.su-badge:hover span::after{width:100%;}' +
    '.su-panel{position:fixed;left:16px;bottom:48px;width:264px;' +
    'max-height:60vh;overflow-y:auto;background:rgba(28,28,38,0.96);' +
    'border-radius:10px;padding:14px 16px;z-index:9999;color:#eee;' +
    'font-family:' + FONT + ';font-size:13px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.35);' +
    'opacity:0;pointer-events:none;transform:translateY(6px);' +
    'transition:opacity 0.25s,transform 0.25s;}' +
    '.su-panel.su-open{opacity:1;pointer-events:auto;transform:translateY(0);}' +
    '.su-head{font-weight:bold;font-size:14px;letter-spacing:1px;' +
    'margin-bottom:10px;color:#fff;}' +
    '.su-item{display:block;text-decoration:none;padding:7px 8px;' +
    'border-radius:6px;transition:background 0.2s;}' +
    '.su-item:hover{background:rgba(255,255,255,0.08);}' +
    '.su-title{color:#9ec5ff;font-weight:bold;}' +
    '.su-desc{color:rgba(220,220,230,0.75);font-size:12px;margin-top:2px;}' +
    '.su-msg{color:rgba(225,205,165,0.9);font-size:12px;}' +
    '.su-privacy{margin-top:10px;padding-top:8px;' +
    'border-top:1px solid rgba(255,255,255,0.12);}' +
    '.su-privacy div{color:rgba(200,200,210,0.55);font-size:10.5px;' +
    'line-height:1.5;}';
  document.head.appendChild(style);

  // ── badge: official logo + copyright (shared footer appearance) ───
  var badge = document.createElement('div');
  badge.className = 'su-badge';
  badge.title = 'Subutomo Dev';
  if (elementId) badge.id = elementId;

  var logo = document.createElement('img');
  logo.src = logoPath;
  logo.alt = 'Subutomo Dev';
  logo.onerror = function () { logo.style.display = 'none'; };

  var label = document.createElement('span');
  label.textContent = COPYRIGHT + versionSuffix;

  badge.appendChild(logo);
  badge.appendChild(label);

  var panel = document.createElement('div');
  panel.className = 'su-panel';

  function addHead() {
    var head = document.createElement('div');
    head.className = 'su-head';
    head.textContent = 'Subutomo Dev';
    panel.appendChild(head);
  }

  // privacy notes at the bottom of the panel (hidden when all flags off)
  function addPrivacy() {
    if (!privacy) return;
    var lines = [];
    if (privacy.localStorage) {
      lines.push(T.privacyLocal);
    }
    if (privacy.analytics) {
      lines.push(T.privacyAnalytics);
    }
    if (lines.length === 0) return;
    var box = document.createElement('div');
    box.className = 'su-privacy';
    for (var i = 0; i < lines.length; i++) {
      var line = document.createElement('div');
      line.textContent = lines[i];
      box.appendChild(line);
    }
    panel.appendChild(box);
  }

  function renderMessage(msg) {
    panel.innerHTML = '';
    addHead();
    var m = document.createElement('div');
    m.className = 'su-msg';
    m.textContent = msg;
    panel.appendChild(m);
    addPrivacy();
  }

  function renderSites(list) {
    panel.innerHTML = '';
    addHead();
    var shown = 0;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || s.status !== 'visible' || s.id === currentSiteId) continue;
      // only sister sites (id ending in "-site") are selectable here
      if (!/-site$/.test(s.id)) continue;
      var a = document.createElement('a');
      a.className = 'su-item';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      var t = document.createElement('div');
      t.className = 'su-title';
      t.textContent = pickText(s.title, s.title_ja) || s.id;
      var d = document.createElement('div');
      d.className = 'su-desc';
      d.textContent = pickText(s.description, s.description_ja);
      a.appendChild(t);
      a.appendChild(d);
      panel.appendChild(a);
      shown++;
    }
    if (shown === 0) {
      renderMessage(T.empty);
      return;
    }
    addPrivacy();
  }

  // ── lazy fetch on first open; degrade quietly on failure ──────────
  // 取得結果は保持し、言語切替時に再フェッチせず再描画できるようにする。
  var loaded = false, sitesData = null, loadFailed = false;
  function loadSites() {
    if (loaded) return;
    loaded = true;
    renderMessage(T.loading);
    fetch(sitesJsonPath)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (list) { sitesData = list; renderSites(list); })
      .catch(function () { loadFailed = true; renderMessage(T.failed); });
  }

  // 現在の表示状態を、最新言語で描き直す(再フェッチなし)
  function rerender() {
    if (sitesData) renderSites(sitesData);
    else if (loadFailed) renderMessage(T.failed);
    else if (loaded) renderMessage(T.loading);
  }

  function isOpen() {
    return panel.className.indexOf('su-open') >= 0;
  }
  function setOpen(open) {
    panel.className = open ? 'su-panel su-open' : 'su-panel';
  }

  badge.addEventListener('click', function (e) {
    if (e.shiftKey) return;  // shift+click is reserved for host integrations
    e.stopPropagation();
    if (isOpen()) {
      setOpen(false);
    } else {
      refreshLang();   // 開く直前に現在の <html lang> を読み直す
      loadSites();
      rerender();      // 既ロードなら最新言語で再描画してから開く
      setOpen(true);
    }
  });

  // ── 言語切替への追従 ──────────────────────────────────────────────
  // <html lang> の変化(MutationObserver)と subu:langchange を購読し、
  // パネルが開いていれば最新言語で再描画する(ホストの JP/EN トグルに即追従)。
  function onLangMaybeChanged() {
    if (refreshLang() && isOpen()) rerender();
  }
  if (window.MutationObserver) {
    new MutationObserver(onLangMaybeChanged).observe(
      document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }
  document.addEventListener('subu:langchange', onLangMaybeChanged);

  // close when clicking anywhere outside the panel
  document.addEventListener('click', function (e) {
    if (isOpen() && !panel.contains(e.target) && !badge.contains(e.target)) {
      setOpen(false);
    }
  });

  document.body.appendChild(badge);
  document.body.appendChild(panel);
}());
