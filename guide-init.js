// guide-init.js — 使い方ガイド(guide.html)の初期化。i18n.js の適用と言語切替のみを行う。
// index.html は 3D 描画を含む main.js を読み込むが、guide.html には Three.js 等は不要なため分けている。

// i18n.js は guide.html が自分に付けられた ?v=(index.html の main.js と同じ仕組み)を
// 引き継いで読み込む。静的 import では ?v= が付かず、バージョンを上げても
// 古い辞書がキャッシュから使われることがある(main.js と同じ理由)。
const { applyStaticI18n, getLang, setLang, onLangChange, t } =
  await import(new URL('./i18n.js' + new URL(import.meta.url).search, import.meta.url).href);

/** doc.title/doc.desc は index.html 用のキーなので、ガイドページ独自のタイトルへ上書きする */
function applyGuideTitle() {
  document.title = t('gp.docTitle');
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.content = t('gp.docDesc');
}

applyStaticI18n();
applyGuideTitle();
onLangChange(applyGuideTitle);

document.getElementById('btn-lang').addEventListener('click', () => {
  setLang(getLang() === 'ja' ? 'en' : 'ja');
});
