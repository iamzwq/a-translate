const $ = (id) => document.getElementById(id);
let seq = 0;
let timer = null;
let lastText = '';
let lastEngineChoice = '';
let globalEngineId = GOOGLE_ID;
let activeEngineId = GOOGLE_ID;

async function translate() {
  clearTimeout(timer);
  const text = $('input').value.trim();
  if (text === lastText) return;
  lastText = text;
  const id = ++seq;
  const result = $('result');
  if (!text) {
    result.className = 'result';
    result.textContent = '';
    $('lang').options[0].textContent = '自动';
    return;
  }
  result.className = 'result loading';
  result.textContent = '翻译中…';
  let res;
  try {
    const lang = await targetLang(text);
    if (id !== seq) return;
    res = await chrome.runtime.sendMessage({ type: 'translate', texts: [text], lang, engineId: $('engine').value });
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (id !== seq) return;
  result.className = res?.ok ? 'result' : 'result error';
  result.textContent = res?.ok ? res.result[0] || '' : `[翻译失败] ${res?.error || ''}`;
  // Allow retrying the same text after a failure.
  if (!res?.ok) lastText = '';
}

// "auto": the target language, or English (Chinese for English targets) when the text is already in it.
async function targetLang(text) {
  const select = $('lang');
  if (select.value !== 'auto') return select.value;
  const target = await getTargetLang();
  const lang = !(await isInLang(text, target)) ? target : baseLang(target) === 'en' ? 'zh-CN' : 'en';
  select.options[0].textContent = `自动（${select.querySelector(`[value="${lang}"]`).textContent}）`;
  return lang;
}

function show(text) {
  $('input').value = text;
  translate();
}

$('input').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(translate, 800);
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    lastText = '';
    translate();
  }
});
$('copy').addEventListener('click', async () => {
  const result = $('result');
  if (!result.textContent || result.classList.contains('loading') || result.classList.contains('error')) return;
  await navigator.clipboard.writeText(result.textContent).catch(() => {});
  $('copy').textContent = '已复制 ✓';
  setTimeout(() => { $('copy').textContent = '复制译文'; }, 1200);
});

$('lang').addEventListener('change', () => {
  chrome.storage.local.set({ windowLang: $('lang').value }).catch(() => {});
  lastText = '';
  translate();
});

// The window keeps its own engine (`windowEngineId`) once one is picked here; until then it follows the global one.
async function renderEngines() {
  const [{ engineId, engines }, { windowEngineId }] = await Promise.all([
    loadSettings(),
    chrome.storage.local.get('windowEngineId'),
  ]);
  const sel = $('engine');
  const globalEngine = engines.find((e) => e.id === engineId);
  sel.replaceChildren(
    new Option(`默认（${globalEngine ? engineLabel(globalEngine) : 'Google 翻译'}）`, ''),
    ...engineOptions(engines),
  );
  const choice = isValidEngineId(engines, windowEngineId) ? windowEngineId : '';
  sel.value = choice;
  lastEngineChoice = choice;
  globalEngineId = engineId;
  sel.title = `翻译服务：${sel.selectedOptions[0].text}`;
  activeEngineId = choice || engineId;
  return activeEngineId;
}

$('engine').addEventListener('change', () => {
  const sel = $('engine');
  if (sel.value === ADD_ENGINE) {
    sel.value = lastEngineChoice;
    chrome.runtime.openOptionsPage();
    return;
  }
  lastEngineChoice = sel.value;
  activeEngineId = sel.value || globalEngineId;
  sel.title = `翻译服务：${sel.selectedOptions[0].text}`;
  chrome.storage.local.set({ windowEngineId: sel.value }).catch(() => {});
  lastText = '';
  translate();
});

// Services added, renamed or removed in the options page, or a new global choice while following it.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !(changes.engines || changes.engineId)) return;
  const before = activeEngineId;
  const after = await renderEngines();
  if (after !== before) {
    lastText = '';
    translate();
  }
});

// Text sent from a page's selection box while this window is already open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'windowText') show(msg.text);
});

// Restore the language and engine before taking the pending text, so it is translated only once.
$('lang').append(...Object.entries(LANG_LABELS).map(([code, label]) => new Option(`译为${label}`, code)));
Promise.all([
  chrome.storage.local.get({ windowLang: 'auto' })
    .then((s) => { $('lang').value = Object.hasOwn(LANG_NAMES, s.windowLang) ? s.windowLang : 'auto'; }, () => {}),
  renderEngines().catch(() => {}),
])
  .then(() => chrome.runtime.sendMessage({ type: 'takeWindowText' }))
  .then((res) => { if (res?.ok && res.result) show(res.result); })
  .catch(() => {});
