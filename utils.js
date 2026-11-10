// Shared helpers; load after config.js wherever it is loaded.

const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c);

const baseLang = (code) => (code || '').toLowerCase().split(/[-_]/)[0];

// Script a text must contain to possibly be in a language; anything else needs Latin letters.
const LANG_SCRIPTS = {
  zh: /\p{Script=Han}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  ru: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  th: /\p{Script=Thai}/u,
};

// Base language code ('zh', 'en', …) of the text, or '' when unsure.
async function detectLang(text) {
  try {
    const { isReliable, languages } = await chrome.i18n.detectLanguage(text);
    if (isReliable && languages[0]) return baseLang(languages[0].language);
  } catch { /* detection unavailable: use the script heuristic */ }
  // Kana or Hangul means Japanese/Korean even when Han characters dominate.
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  const han = text.match(/\p{Script=Han}/gu);
  return han && han.length / text.replace(/\s/g, '').length > 0.3 ? 'zh' : '';
}

// `fallback` (e.g. the page language) decides texts too short for a reliable detection.
async function isInLang(text, lang, fallback = '') {
  const base = baseLang(lang);
  if (!(LANG_SCRIPTS[base] || /\p{Script=Latin}/u).test(text)) return false;
  return ((await detectLang(text)) || fallback) === base;
}

function newEngineId() {
  return crypto.randomUUID().slice(0, 8);
}

// Translates over a port so AI replies can stream: onItem(index, text) fires as items arrive (and for cache hits).
// Resolves to { ok, result } or { ok: false, error }.
function translateStream(texts, context, onItem) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'translate' });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
      return;
    }
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    port.onMessage.addListener((m) => {
      if (m.type === 'item') onItem?.(m.i, m.text);
      else if (m.type === 'done') finish({ ok: true, result: m.result });
      else if (m.type === 'error') finish({ ok: false, error: m.error });
    });
    port.onDisconnect.addListener(() => finish({ ok: false, error: chrome.runtime.lastError?.message || '连接已断开' }));
    port.postMessage({ texts, context });
  });
}

function engineLabel(e) {
  return e.name || e.model;
}

// Wires a color input and its reset button to `key` in storage.sync.
function bindColor(key, input, reset, fallback = TR_COLOR) {
  const show = (c) => { input.value = isColor(c) ? c : fallback; };
  chrome.storage.sync.get({ [key]: fallback }).then((s) => show(s[key]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[key]) show(changes[key].newValue);
  });
  // Debounced so dragging the picker stays within storage.sync's write quota; `change` flushes at once.
  let timer;
  const save = () => {
    clearTimeout(timer);
    chrome.storage.sync.set({ [key]: input.value });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(save, 300);
  });
  input.addEventListener('change', save);
  reset.addEventListener('click', () => {
    input.value = fallback;
    save();
  });
}

// Wires a <select> to `key` in storage.sync. Option values are '1' / '' for boolean settings and text for numbers;
// `normalize` cleans up stored values.
function bindSetting(key, select, fallback, normalize = (v) => v) {
  const show = (v) => {
    const value = normalize(v ?? fallback);
    select.value = typeof fallback === 'boolean' ? (value ? '1' : '') : String(value);
  };
  chrome.storage.sync.get({ [key]: fallback }).then((s) => show(s[key]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[key]) show(changes[key].newValue);
  });
  select.addEventListener('change', () => {
    const v = select.value;
    chrome.storage.sync.set({ [key]: typeof fallback === 'boolean' ? !!v : typeof fallback === 'number' ? Number(v) : v });
  });
}

function bindTargetLang(select) {
  select.replaceChildren(...Object.entries(LANG_LABELS).map(([code, label]) => new Option(label, code)));
  bindSetting('targetLang', select, TARGET_LANG, validLang);
}
