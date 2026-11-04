// Shared helpers; load after config.js wherever it is loaded.

const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c);

async function isChinese(text) {
  try {
    const { isReliable, languages } = await chrome.i18n.detectLanguage(text);
    if (isReliable) return !!languages[0]?.language.startsWith('zh');
  } catch { /* detection unavailable: use the script heuristic */ }
  // Kana or Hangul means Japanese/Korean even when Han characters dominate.
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
  const cjk = text.match(/[\u4e00-\u9fff]/g);
  return !!cjk && cjk.length / text.replace(/\s/g, '').length > 0.3;
}

function newEngineId() {
  return crypto.randomUUID().slice(0, 8);
}

function engineLabel(e) {
  return e.name || e.model;
}

// Translation cache lives in storage.session (see background.js), readable from extension pages.
async function cacheSizeLabel() {
  const bytes = await chrome.storage.session.getBytesInUse(null);
  if (!bytes) return '空';
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clearCache() {
  return chrome.storage.session.clear();
}

// Wires the #trColor / #resetColor / #ytTrOnly controls shared by the popup and options pages.
function bindDisplaySettings() {
  const color = document.getElementById('trColor');
  const ytTrOnly = document.getElementById('ytTrOnly');
  const show = (s) => {
    if ('trColor' in s) color.value = isColor(s.trColor) ? s.trColor : TR_COLOR;
    if ('ytTrOnly' in s) ytTrOnly.value = s.ytTrOnly ? '1' : '';
  };
  chrome.storage.sync.get({ trColor: TR_COLOR, ytTrOnly: false }).then(show);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const s = {};
    for (const k of ['trColor', 'ytTrOnly']) if (changes[k]) s[k] = changes[k].newValue;
    show(s);
  });

  // Debounced so dragging the picker stays within storage.sync's write quota; `change` flushes at once.
  let timer;
  const saveColor = () => {
    clearTimeout(timer);
    chrome.storage.sync.set({ trColor: color.value });
  };
  color.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(saveColor, 300);
  });
  color.addEventListener('change', saveColor);
  document.getElementById('resetColor').addEventListener('click', () => {
    color.value = TR_COLOR;
    saveColor();
  });
  ytTrOnly.addEventListener('change', () => chrome.storage.sync.set({ ytTrOnly: !!ytTrOnly.value }));
}
