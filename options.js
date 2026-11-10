const $ = (id) => document.getElementById(id);

let initialEngineId = GOOGLE_ID;

loadSettings().then(({ engineId, engines }) => {
  initialEngineId = engineId;
  engines.forEach(addProfile);
  renderEngineSelect();
});

// Keep in step with switches made from the popup while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  const id = area === 'sync' && changes.engineId?.newValue;
  if (id && [...$('engine').options].some((o) => o.value === id)) {
    $('engine').value = id;
    markCurrent();
  }
});

function addProfile(p) {
  const node = $('profileTpl').content.firstElementChild.cloneNode(true);
  node.dataset.id = p.id;
  for (const input of node.querySelectorAll('[data-k]')) {
    input.value = p[input.dataset.k];
    input.addEventListener('input', () => {
      renderEngineSelect();
      scheduleSaveEngines();
    });
    input.addEventListener('change', saveEngines);
  }
  node.querySelector('.remove').addEventListener('click', () => {
    node.remove();
    renderEngineSelect();
    saveEngines();
  });
  node.querySelector('.reveal').addEventListener('click', (e) => {
    const key = node.querySelector('[data-k="apiKey"]');
    key.type = key.type === 'password' ? 'text' : 'password';
    e.currentTarget.textContent = key.type === 'password' ? '显示' : '隐藏';
  });
  node.querySelector('.test').addEventListener('click', () => testProfile(node));
  $('profiles').append(node);
  return node;
}

function readProfile(node) {
  const p = { id: node.dataset.id };
  for (const input of node.querySelectorAll('[data-k]')) {
    p[input.dataset.k] = input.value.trim() || AI_DEFAULTS[input.dataset.k];
  }
  return p;
}

const readProfiles = () => [...$('profiles').children].map(readProfile);

function renderEngineSelect() {
  const sel = $('engine');
  const current = sel.value || initialEngineId;
  sel.replaceChildren(
    new Option('Google 翻译（免费）', GOOGLE_ID),
    ...readProfiles().map((p) => new Option(engineLabel(p), p.id)),
  );
  sel.value = [...sel.options].some((o) => o.value === current) ? current : GOOGLE_ID;
  $('empty').hidden = $('profiles').children.length > 0;
  markCurrent();
}

function markCurrent() {
  for (const node of $('profiles').children) node.classList.toggle('current', node.dataset.id === $('engine').value);
}

// AI services save as you type; a missing key is flagged on its card rather than blocking the save.
let engineTimer;
function scheduleSaveEngines() {
  clearTimeout(engineTimer);
  engineTimer = setTimeout(saveEngines, 500);
}

function saveEngines() {
  clearTimeout(engineTimer);
  engineTimer = null;
  for (const node of $('profiles').children) flagMissingKey(node);
  return chrome.storage.sync.set({ engines: readProfiles(), engineId: $('engine').value });
}

function flagMissingKey(node) {
  const status = node.querySelector('.test-status');
  if (!node.querySelector('[data-k="apiKey"]').value.trim()) {
    status.className = 'test-status fail';
    status.textContent = '未填写 API Key，使用这项服务时会翻译失败';
    status.dataset.missingKey = '1';
  } else if (status.dataset.missingKey) {
    status.textContent = '';
    delete status.dataset.missingKey;
  }
}

$('engine').addEventListener('change', () => {
  markCurrent();
  saveEngines();
});
window.addEventListener('pagehide', () => { if (engineTimer) saveEngines(); });

$('add').addEventListener('click', () => {
  const node = addProfile({ ...AI_DEFAULTS, id: newEngineId() });
  renderEngineSelect();
  saveEngines();
  node.querySelector('[data-k="apiBase"]').focus();
});

// --- Settings saved on change ---
bindTargetLang($('targetLang'));
bindColor('trColor', $('trColor'), $('resetColor'));
bindColor('ytTrColor', $('ytTrColor'), $('resetYtColor'), YT_TR_COLOR);
for (const [key, fallback] of Object.entries(YT_DEFAULTS)) bindSetting(key, $(key), fallback);

// Kept in storage.local: a long glossary would exceed storage.sync's per-item quota.
chrome.storage.local.get({ glossary: '' }).then((s) => { $('glossary').value = s.glossary; });
let glossaryTimer;
const saveGlossary = () => {
  clearTimeout(glossaryTimer);
  chrome.storage.local.set({ glossary: $('glossary').value });
};
$('glossary').addEventListener('input', () => {
  clearTimeout(glossaryTimer);
  glossaryTimer = setTimeout(saveGlossary, 800);
});
$('glossary').addEventListener('change', saveGlossary);

let toastTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' && !(area === 'local' && changes.glossary)) return;
  $('toast').textContent = '已保存 ✓';
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1500);
});

// --- Live previews of the web page and YouTube styles ---
const PREVIEW_DEFAULTS = { trColor: TR_COLOR, ytTrColor: YT_TR_COLOR, ...YT_DEFAULTS };
let preview = { ...PREVIEW_DEFAULTS };

function renderPreviews() {
  $('webPreview').style.setProperty('--st-tr-color', isColor(preview.trColor) ? preview.trColor : TR_COLOR);
  const yt = $('ytPreview');
  yt.style.setProperty('--st-tr-color', isColor(preview.ytTrColor) ? preview.ytTrColor : YT_TR_COLOR);
  yt.style.setProperty('--st-yt-bg-alpha', preview.ytBgOpacity);
  // The lower part of a typical player (~550px tall); on YouTube the size follows the player.
  yt.style.fontSize = `${22 * preview.ytFontScale}px`;
  yt.querySelector('.st-yt-src').hidden = !!preview.ytTrOnly;
}

chrome.storage.sync.get(PREVIEW_DEFAULTS).then((s) => {
  preview = s;
  renderPreviews();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const k of Object.keys(PREVIEW_DEFAULTS)) {
    if (changes[k]) preview[k] = changes[k].newValue ?? PREVIEW_DEFAULTS[k];
  }
  renderPreviews();
});
// Color pickers save with a delay; follow them while dragging.
for (const key of ['trColor', 'ytTrColor']) {
  $(key).addEventListener('input', () => {
    preview[key] = $(key).value;
    renderPreviews();
  });
}

// --- Shortcuts, data, about ---
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
chrome.commands.getAll().then((commands) => {
  for (const el of document.querySelectorAll('[data-command]')) {
    const shortcut = commands.find((c) => c.name === el.dataset.command)?.shortcut;
    const keys = shortcut ? shortcut.split('+') : [];
    el.replaceChildren(...keys.map((k) => Object.assign(document.createElement('kbd'), { textContent: k })));
    if (!keys.length) el.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: '未设置' }));
  }
});

const showCacheSize = async () => { $('cacheSize').textContent = `（${await cacheSizeLabel()}）`; };
$('clearCache').addEventListener('click', async () => {
  await clearCache();
  await showCacheSize();
});
showCacheSize();
$('version').textContent = chrome.runtime.getManifest().version;

// Highlights the nav entry of the section in view.
const navLinks = [...document.querySelectorAll('.nav a')];
const navObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    navLinks.forEach((a) => a.classList.toggle('active', a.hash === `#${e.target.id}`));
  }
}, { rootMargin: '-20% 0px -70% 0px' });
document.querySelectorAll('main > section').forEach((s) => navObserver.observe(s));

async function testProfile(node) {
  const status = node.querySelector('.test-status');
  const button = node.querySelector('.test');
  const cfg = readProfile(node);
  status.className = 'test-status';
  if (!cfg.apiKey) {
    status.classList.add('fail');
    status.textContent = '请先填写 API Key';
    return;
  }
  status.textContent = '测试中…';
  button.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'testOpenAI', cfg });
    if (res?.ok) {
      status.textContent = `测试通过 ✓ “Hello, world!” → “${res.result[0]}”`;
    } else {
      status.classList.add('fail');
      status.textContent = `测试失败：${res?.error || '未知错误'}`;
    }
  } catch (e) {
    status.classList.add('fail');
    status.textContent = `测试失败：${e.message || e}`;
  } finally {
    button.disabled = false;
  }
}
