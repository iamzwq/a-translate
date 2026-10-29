importScripts('config.js');

// v1.0 stored a single engine as top-level engine / apiBase / apiKey / model.
chrome.runtime.onInstalled.addListener(async () => {
  const old = await chrome.storage.sync.get(['engines', 'engine', 'apiBase', 'apiKey', 'model']);
  if (old.engines) return;
  const engines = old.apiKey ? [{
    ...AI_DEFAULTS,
    id: newEngineId(),
    apiBase: old.apiBase || AI_DEFAULTS.apiBase,
    apiKey: old.apiKey,
    model: old.model || AI_DEFAULTS.model,
  }] : [];
  const engineId = old.engine === 'openai' && engines.length ? engines[0].id : GOOGLE_ID;
  await chrome.storage.sync.set({ engines, engineId });
  await chrome.storage.sync.remove(['engine', 'apiBase', 'apiKey', 'model']);
});

// Returns the page state { active, started } after toggling; injects the content script into tabs opened before install.
async function toggleTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-window') {
    await openWindow('');
    return;
  }
  if (command !== 'toggle-translate') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || (tab.url && !/^https?:|^file:/.test(tab.url))) return;
    await toggleTab(tab.id);
  } catch (e) {
    console.warn('小 A 翻译: cannot run on this page', e);
  }
});

const handlers = {
  toggleTab: (msg) => toggleTab(msg.tabId),
  testOpenAI: (msg) => translateOpenAI(['Hello, world!'], { ...AI_DEFAULTS, ...msg.cfg }),
  translate: (msg) => translate(msg.texts),
  openWindow: (msg) => openWindow(msg.text || ''),
  takeWindowText: async () => {
    const text = pendingWindowText;
    pendingWindowText = '';
    return text;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg.type];
  if (!handler) return;
  handler(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: String(e.message || e) }),
  );
  return true;
});

// Standalone translate window: a popup-type browser window that outlives the page it was opened from.
const WINDOW_URL = chrome.runtime.getURL('window.html');
const WINDOW_BOUNDS_KEY = 'windowBounds';
// Text for a window that is still loading; it fetches this once ready.
let pendingWindowText = '';

async function findWindowId() {
  const [ctx] = await chrome.runtime.getContexts?.({ contextTypes: ['TAB'], documentUrls: [WINDOW_URL] }) || [];
  return ctx?.windowId;
}

async function openWindow(text) {
  const id = await findWindowId();
  if (id != null) {
    await chrome.windows.update(id, { focused: true });
    if (text) chrome.runtime.sendMessage({ type: 'windowText', text }).catch(() => {});
    return;
  }
  pendingWindowText = text;
  const { [WINDOW_BOUNDS_KEY]: bounds } = await chrome.storage.local.get(WINDOW_BOUNDS_KEY);
  await chrome.windows.create({ url: WINDOW_URL, type: 'popup', focused: true, width: 420, height: 520, ...bounds });
}

chrome.windows.onBoundsChanged.addListener(async (win) => {
  if (win.id !== await findWindowId()) return;
  const { left, top, width, height } = win;
  await chrome.storage.local.set({ [WINDOW_BOUNDS_KEY]: { left, top, width, height } });
});

async function translate(texts) {
  const { engineId, engines } = await loadSettings();
  const ai = engines.find((e) => e.id === engineId);
  const keys = await cacheKeys(ai ? `${ai.apiBase}|${ai.model}` : GOOGLE_ID, texts);
  const cached = await chrome.storage.session.get(keys);
  const missing = keys.flatMap((k, i) => (k in cached ? [] : [i]));
  if (missing.length) {
    const todo = missing.map((i) => texts[i]);
    const result = await (ai ? translateOpenAI(todo, ai) : translateGoogle(todo));
    const fresh = {};
    missing.forEach((i, j) => {
      cached[keys[i]] = result[j];
      if (result[j] && !result.unverified?.[j]) fresh[keys[i]] = result[j];
    });
    try {
      await chrome.storage.session.set(fresh);
    } catch {
      // Quota (10 MB) exceeded: start over rather than track LRU.
      await chrome.storage.session.clear();
      await chrome.storage.session.set(fresh).catch(() => {});
    }
  }
  return keys.map((k) => cached[k]);
}

// The worker is short-lived, so the cache lives in storage.session until the browser closes.
function cacheKeys(engineKey, texts) {
  return Promise.all(texts.map(async (text) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${engineKey}\0${text}`));
    return `tc:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }));
}

async function translateGoogle(texts) {
  // Pack texts into ~4500-char requests separated by numbered markers.
  const groups = [];
  let len = Infinity;
  texts.forEach((t, i) => {
    if (len + t.length > 4500) {
      groups.push([]);
      len = 0;
    }
    groups.at(-1).push(i);
    len += t.length + 8;
  });
  const out = [];
  await Promise.all(groups.map(async (idx) => {
    let parts = null;
    if (idx.length > 1) {
      const joined = idx.map((i, k) => (k ? `\n⟦${k}⟧\n` : '') + texts[i]).join('');
      parts = (await googleRequest(joined)).split(/\s*⟦\s*\d+\s*⟧\s*/);
    }
    // A mangled marker breaks the split; fall back to one request per text.
    if (parts?.length !== idx.length) parts = await Promise.all(idx.map((i) => googleRequest(texts[i])));
    idx.forEach((i, k) => { out[i] = parts[k].trim(); });
  }));
  return out;
}

async function googleRequest(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=${TARGET_LANG}`;
  // POST keeps long non-Latin texts from exceeding the URL length limit.
  const res = await fetchRetry(url, { method: 'POST', body: new URLSearchParams({ q: text }) });
  if (!res.ok) throw new Error(`Google 翻译请求失败: HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0]).join('');
}

// Retries 429/503 after Retry-After (seconds or HTTP date), else exponential backoff.
async function fetchRetry(url, init, retries = 3) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, init);
    if (i >= retries || (res.status !== 429 && res.status !== 503)) return res;
    const after = res.headers.get('Retry-After');
    let wait = after === null ? NaN : /^\d+$/.test(after) ? after * 1000 : Date.parse(after) - Date.now();
    if (!(wait > 0)) wait = 1000 * 2 ** i;
    await new Promise((r) => setTimeout(r, Math.min(wait, 10000)));
  }
}

// Vendor-specific switches to disable thinking: Qwen / GLM, Doubao, DeepSeek / vLLM, SGLang, Ollama.
const NO_THINKING_PARAMS = {
  enable_thinking: false,
  thinking: { type: 'disabled' },
  chat_template_kwargs: { enable_thinking: false, thinking: false },
};
// Endpoints (apiBase|model) that rejected NO_THINKING_PARAMS, e.g. the official OpenAI API.
const noThinkingUnsupported = new Set();

async function translateOpenAI(texts, cfg) {
  if (!cfg.apiKey) throw new Error('请先在扩展设置中填写 API Key');
  const url = `${cfg.apiBase.replace(/\/+$/, '')}/chat/completions`;
  const key = `${url}|${cfg.model}`;
  const body = {
    model: cfg.model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'You are a professional translator. Translate each string in the given JSON array into Simplified Chinese. '
          + 'Text wrapped in backticks is code: keep it verbatim, including the backticks. '
          + 'Tags like <a1>...</a1> mark links: keep each tag pair, wrapped around the matching translated words. '
          + 'Return ONLY a JSON array of strings with exactly the same length and order. Do not add explanations.',
      },
      { role: 'user', content: JSON.stringify(texts) },
    ],
  };
  const send = (b) => fetchRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(b),
  });
  let res;
  if (noThinkingUnsupported.has(key)) {
    res = await send(body);
  } else {
    res = await send({ ...body, ...NO_THINKING_PARAMS });
    if (res.status === 400 || res.status === 422) {
      const retry = await send(body);
      if (retry.ok) noThinkingUnsupported.add(key);
      res = retry;
    }
  }
  if (!res.ok) throw new Error(`API 请求失败: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const match = content.match(/\[[\s\S]*\]/);
  let arr;
  try { arr = JSON.parse(match ? match[0] : content); } catch { arr = null; }
  if (Array.isArray(arr) && arr.length === texts.length) return arr.map(String);
  // Model broke the array format; fall back to one request per text.
  if (texts.length > 1) {
    const parts = await Promise.all(texts.map((t) => translateOpenAI([t], cfg)));
    return Object.assign(parts.map((r) => r[0]), { unverified: parts.map((r) => !!r.unverified?.[0]) });
  }
  // Raw reply is shown but not cached, in case it isn't a clean translation.
  return Object.assign([content.trim()], { unverified: [true] });
}
