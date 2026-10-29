const $ = (id) => document.getElementById(id);
let seq = 0;
let timer = null;
let lastText = '';

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
    return;
  }
  result.className = 'result loading';
  result.textContent = '翻译中…';
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'translate', texts: [text] });
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (id !== seq) return;
  result.className = res?.ok ? 'result' : 'result error';
  result.textContent = res?.ok ? res.result[0] || '' : `[翻译失败] ${res?.error || ''}`;
  // Allow retrying the same text after a failure.
  if (!res?.ok) lastText = '';
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

// Text sent from a page's selection box while this window is already open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'windowText') show(msg.text);
});

chrome.runtime.sendMessage({ type: 'takeWindowText' }).then((res) => {
  if (res?.ok && res.result) show(res.result);
}).catch(() => {});
