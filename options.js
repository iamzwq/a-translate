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
    input.addEventListener('input', renderEngineSelect);
  }
  node.querySelector('.remove').addEventListener('click', () => {
    node.remove();
    renderEngineSelect();
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

let dirty = false;
function setDirty(value) {
  dirty = value;
  if (!value) return;
  $('status').className = 'dirty';
  $('status').textContent = '有未保存的更改';
}

$('profiles').addEventListener('input', () => setDirty(true));
$('profiles').addEventListener('click', (e) => { if (e.target.closest('.remove')) setDirty(true); });
$('engine').addEventListener('change', () => {
  markCurrent();
  setDirty(true);
});
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

$('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

const showCacheSize = async () => { $('cacheSize').textContent = `（${await cacheSizeLabel()}）`; };
$('clearCache').addEventListener('click', async () => {
  await clearCache();
  await showCacheSize();
});
showCacheSize();

chrome.storage.sync.get({ ytTrOnly: false }).then((s) => { $('ytTrOnly').value = s.ytTrOnly ? '1' : ''; });
$('ytTrOnly').addEventListener('change', (e) => chrome.storage.sync.set({ ytTrOnly: !!e.target.value }));

$('add').addEventListener('click', () => {
  const node = addProfile({ ...AI_DEFAULTS, id: newEngineId() });
  renderEngineSelect();
  setDirty(true);
  node.querySelector('[data-k="apiBase"]').focus();
});

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

$('save').addEventListener('click', async () => {
  const status = $('status');
  const missing = [...$('profiles').children].find((n) => !n.querySelector('[data-k="apiKey"]').value.trim());
  if (missing) {
    status.className = 'fail';
    status.textContent = '有 AI 服务未填写 API Key';
    missing.querySelector('[data-k="apiKey"]').focus();
    return;
  }
  await chrome.storage.sync.set({ engines: readProfiles(), engineId: $('engine').value });
  setDirty(false);
  status.className = '';
  status.textContent = '已保存 ✓';
  setTimeout(() => { if (!dirty) status.textContent = ''; }, 2000);
});
