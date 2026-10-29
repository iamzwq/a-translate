const $ = (id) => document.getElementById(id);
const ADD_ENGINE = '__add__';
let tabId;

function render(state) {
  const label = !state?.started ? '翻译此页' : state.active ? '显示原文' : '显示译文';
  $('toggleLabel').textContent = label;
}

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = false;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (!tabId || !/^https?:|^file:/.test(tab.url || '')) {
    $('toggle').disabled = true;
    $('toggleLabel').textContent = '当前页面不支持翻译';
  } else {
    // No content script yet (e.g. tab opened before install) means the page is untranslated.
    const state = await chrome.tabs.sendMessage(tabId, { type: 'getState' }).catch(() => null);
    render(state);
  }

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === 'toggle-translate')?.shortcut || '';
  $('shortcutTip').hidden = !!shortcut;

  const { engineId, engines } = await loadSettings();
  const sel = $('engine');
  sel.replaceChildren(
    new Option('Google 翻译', GOOGLE_ID),
    ...engines.map((e) => new Option(engineLabel(e), e.id)),
    new Option('＋ 添加 AI 服务…', ADD_ENGINE),
  );
  sel.value = engineId;
  sel.title = sel.selectedOptions[0].text;
}

// Takes effect for paragraphs translated afterwards; existing translations stay.
$('engine').addEventListener('change', async (e) => {
  const sel = e.target;
  if (sel.value === ADD_ENGINE) {
    chrome.runtime.openOptionsPage();
    window.close();
    return;
  }
  sel.title = sel.selectedOptions[0].text;
  await chrome.storage.sync.set({ engineId: sel.value });
});

$('toggle').addEventListener('click', async () => {
  $('error').hidden = true;
  const res = await chrome.runtime.sendMessage({ type: 'toggleTab', tabId });
  if (res?.ok) render(res.result);
  else showError(`无法在此页面运行：${res?.error || '未知错误'}`);
});

$('setShortcut').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('openWindow').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'openWindow' });
  window.close();
});

const showCacheSize = async () => { $('cacheSize').textContent = await cacheSizeLabel(); };
$('clearCache').addEventListener('click', async () => {
  await clearCache();
  await showCacheSize();
});
showCacheSize();

init();
