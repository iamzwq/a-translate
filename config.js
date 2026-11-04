const TARGET_LANG = 'zh-CN';
// Target languages: Google `tl` code -> name used in the AI prompt.
const LANG_NAMES = { 'zh-CN': 'Simplified Chinese', en: 'English' };
// Default color of translations (web page and YouTube), stored as `trColor` in storage.sync.
const TR_COLOR = '#6366f1';

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
