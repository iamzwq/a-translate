// Default target language, overridden by `targetLang` in storage.sync.
const TARGET_LANG = 'zh-CN';
// Target languages: Google `tl` code -> name used in the AI prompt.
const LANG_NAMES = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
  ru: 'Russian',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  ar: 'Arabic',
};
// Names shown in the UI.
const LANG_LABELS = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  ru: 'Русский',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  id: 'Bahasa Indonesia',
  ar: 'العربية',
};

const validLang = (lang) => (Object.hasOwn(LANG_NAMES, lang) ? lang : TARGET_LANG);

async function getTargetLang() {
  const { targetLang } = await chrome.storage.sync.get({ targetLang: TARGET_LANG });
  return validLang(targetLang);
}
// Default color of translations on web pages, stored as `trColor` in storage.sync.
const TR_COLOR = '#6366f1';
// Default color of translated YouTube subtitles (`ytTrColor`); youtube.css holds the same value.
const YT_TR_COLOR = '#ffffff';
// Other YouTube subtitle settings in storage.sync; youtube.js keeps its own copy of these defaults.
const YT_DEFAULTS = { ytTrOnly: false, ytAutoCC: true, ytFontScale: 1, ytBgOpacity: 0.75 };

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
