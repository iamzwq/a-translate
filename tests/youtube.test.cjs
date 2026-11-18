const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'youtube.js'), 'utf8');

function setup() {
  const nodes = [];
  const events = {};
  const windowEvents = {};
  const classes = new Set();
  const video = { currentTime: 0 };
  const cc = { on: true, getAttribute() { return String(this.on); } };
  const player = {
    classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s) },
    querySelector: (s) => s === 'video' ? video : s === '.ytp-subtitles-button' ? cc : null,
    append(n) { n.parentElement = this; },
  };
  const document = {
    title: 'Test - YouTube',
    documentElement: { dataset: {} },
    addEventListener: (type, fn) => { events[type] = fn; },
    querySelector: () => player,
    querySelectorAll: () => classes.has('st-yt-on') ? [player] : [],
    createElement() {
      const n = {
        hidden: false,
        children: [],
        style: { setProperty() {}, removeProperty() {} },
        setAttribute() {},
        addEventListener() {},
        append(child) { child.parentElement = this; this.children.push(child); },
        querySelectorAll() { return this.children.map((line) => line.children[0]); },
      };
      nodes.push(n);
      return n;
    },
  };
  // Storage is left pending so these tests control track changes without unrelated initialization.
  const storage = { get: () => new Promise(() => {}) };
  const window = { addEventListener: (type, fn) => { windowEvents[type] = fn; } };
  vm.runInNewContext(source, {
    window, document,
    location: { pathname: '/watch', search: '?v=abcdefghijk', href: 'https://www.youtube.com/watch?v=abcdefghijk' },
    chrome: { storage: { sync: storage, local: storage, onChanged: { addListener() {} } } },
    ResizeObserver: class { observe() {} disconnect() {} },
    URL, URLSearchParams,
  });
  const post = (data) => windowEvents.message({ source: window, data });
  return {
    track: (track) => post({ source: 'st-yt-track', track: JSON.stringify(track) }),
    captions: (data) => post({
      source: 'st-yt-captions',
      url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr',
      text: JSON.stringify(data),
    }),
    notice: () => nodes.find((n) => n.className === 'st-yt-native-notice'),
    disableCC() { cc.on = false; events['yt-navigate-finish'](); },
    classes,
  };
}

test('missing caption data shows the reported language without hiding native captions', () => {
  const page = setup();
  page.track({ lang: 'ar', kind: 'asr', tlang: '', live: false });
  assert.match(page.notice().textContent, /字幕语言：ar/);
  assert.match(page.notice().textContent, /尚未获取到可用的字幕数据/);
  assert.equal(page.notice().hidden, false);
  assert.equal(page.classes.has('st-yt-on'), false);
});

test('YouTube auto-translation and target-language captions have distinct reasons', () => {
  const page = setup();
  page.track({ lang: 'en', kind: 'asr', tlang: 'ar' });
  assert.match(page.notice().textContent, /YouTube 自动翻译已开启（目标语言：ar）/);
  page.track({ lang: 'zh-CN', kind: '', tlang: '' });
  assert.match(page.notice().textContent, /当前字幕已是目标语言（zh-CN）/);
  assert.doesNotMatch(page.notice().textContent, /自动翻译已开启/);
});

test('turning captions off hides the fallback notice', () => {
  const page = setup();
  page.track({ lang: 'en', kind: 'asr' });
  assert.equal(page.notice().hidden, false);
  page.disableCC();
  assert.equal(page.notice().hidden, true);
});

test('captured captions replace the notice with the extension overlay', () => {
  const page = setup();
  page.track({ lang: 'en', kind: 'asr' });
  // Outside the look-ahead window so rendering can be tested without translation requests.
  page.captions({ events: [{ tStartMs: 120000, dDurationMs: 3000, segs: [{ utf8: 'Hello world.' }] }] });
  assert.equal(page.notice().hidden, true);
  assert.equal(page.classes.has('st-yt-on'), true);
});
