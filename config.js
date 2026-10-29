const TARGET_LANG = 'zh-CN';

// Google is built in; only AI engines are stored, as `engines: [{ id, ...AI_DEFAULTS }]` plus the selected `engineId`.
const GOOGLE_ID = 'google';

const AI_DEFAULTS = {
  name: '',
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

async function loadSettings() {
  const s = await chrome.storage.sync.get({ engineId: GOOGLE_ID, engines: [] });
  const engines = s.engines.map((e) => ({ ...AI_DEFAULTS, ...e }));
  const engineId = engines.some((e) => e.id === s.engineId) ? s.engineId : GOOGLE_ID;
  return { engineId, engines };
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
