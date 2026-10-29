// Selection translation: a button next to selected text opens a draggable, resizable box that can be pinned.
(() => {
  if (window.__stSelectionLoaded) return;
  window.__stSelectionLoaded = true;

  const MAX_CHARS = 3000;
  const STORE_KEY = 'selectionBox';
  const ICONS = {
    pin: ['M12 17v5', 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z'],
    copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'],
    check: ['M20 6 9 17l-5-5'],
    popout: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    close: ['M18 6 6 18', 'm6 6 12 12'],
  };
  const CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .btn, .box {
      position: fixed; z-index: 2147483647; box-sizing: border-box;
      --bg: #fff; --fg: #18181b; --muted: #71717a; --border: #e4e4e7; --hover: #f4f4f5;
      background: var(--bg); color: var(--fg); border: 1px solid var(--border);
      font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      .btn, .box { --bg: #18181b; --fg: #fafafa; --muted: #a1a1aa; --border: #3f3f46; --hover: #27272a; }
    }
    .btn {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0; border-radius: 8px;
      font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgb(0 0 0 / .15);
    }
    .btn:hover { background: var(--hover); }
    .box {
      display: flex; flex-direction: column;
      width: 360px; min-width: 220px; min-height: 100px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
      border-radius: 10px; box-shadow: 0 10px 30px rgb(0 0 0 / .18);
      resize: both; overflow: hidden;
    }
    .box.pinned { border-color: var(--muted); }
    .head {
      display: flex; align-items: center; gap: 2px; padding: 4px 4px 4px 12px;
      border-bottom: 1px solid var(--border); cursor: move; user-select: none; touch-action: none;
    }
    .title { flex: 1; color: var(--muted); font-size: 12px; font-weight: 500; }
    .head button {
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px;
      background: transparent; color: var(--muted); cursor: pointer;
    }
    .head button:hover, .head button[aria-pressed="true"] { background: var(--hover); color: var(--fg); }
    .head button[aria-pressed="true"] svg { fill: currentColor; }
    .head svg { width: 15px; height: 15px; }
    .body { flex: 1; overflow: auto; padding: 8px 12px 12px; }
    .src { max-height: 6.4em; overflow: auto; margin-bottom: 6px; color: var(--muted); font-size: 13px; white-space: pre-wrap; }
    .tr { white-space: pre-wrap; overflow-wrap: anywhere; }
    .tr.loading { color: var(--muted); }
    .tr.error { color: #dc2626; }
  `;

  // Built with DOM APIs, not HTML strings: some pages enforce Trusted Types.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    Object.assign(el, props);
    el.append(...children);
    return el;
  }

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  const host = document.createElement('a-translate-selection');
  const root = host.attachShadow({ mode: 'closed' });
  const btn = h('button', { className: 'btn', title: '翻译选中文字', hidden: true }, '译');
  const pinBtn = h('button', { title: '固定' }, icon('pin'));
  const copyBtn = h('button', { title: '复制译文' }, icon('copy'));
  const popoutBtn = h('button', { title: '在独立窗口中打开（可离开当前网页）' }, icon('popout'));
  const closeBtn = h('button', { title: '关闭（Esc）' }, icon('close'));
  const head = h('div', { className: 'head' }, h('span', { className: 'title' }, '小 A 翻译'), pinBtn, copyBtn, popoutBtn, closeBtn);
  const src = h('div', { className: 'src' });
  const tr = h('div', { className: 'tr' });
  const box = h('div', { className: 'box', hidden: true }, head, h('div', { className: 'body' }, src, tr));
  root.append(h('style', { textContent: CSS }), btn, box);
  document.documentElement.append(host);

  // { x, y, w, h, pinned }: where the user last left the box.
  let saved = {};
  let pinned = false;
  let pending = '';
  let anchor = null;
  let seq = 0;
  chrome.storage.local.get(STORE_KEY).then((s) => {
    saved = s[STORE_KEY] || {};
    setPinned(!!saved.pinned);
  });

  function save() {
    if (!alive()) return;
    const r = box.getBoundingClientRect();
    saved = { x: r.left, y: r.top, w: box.style.width ? r.width : undefined, h: box.style.height ? r.height : undefined, pinned };
    chrome.storage.local.set({ [STORE_KEY]: saved }).catch(() => {});
  }

  // After the extension is reloaded or updated, this orphaned script can no longer reach chrome.* APIs.
  function alive() {
    if (chrome.runtime?.id) return true;
    host.remove();
    return false;
  }

  function setPinned(value) {
    pinned = value;
    box.classList.toggle('pinned', pinned);
    pinBtn.setAttribute('aria-pressed', String(pinned));
    pinBtn.title = pinned ? '取消固定' : '固定（点击页面其他位置不关闭，新选中的文字直接在此翻译）';
  }

  function place(x, y) {
    const maxX = Math.max(0, innerWidth - box.offsetWidth);
    const maxY = Math.max(0, innerHeight - box.offsetHeight);
    box.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
    box.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
  }

  function selectedText() {
    const sel = getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return null;
    const active = document.activeElement;
    if (active?.matches?.('input,textarea') || active?.isContentEditable) return null;
    const text = sel.toString().trim();
    if (!text || text.length > MAX_CHARS || !/\p{L}/u.test(text)) return null;
    const rects = sel.getRangeAt(0).getClientRects();
    return { text, rect: sel.getRangeAt(0).getBoundingClientRect(), last: rects[rects.length - 1] };
  }

  function onSelect() {
    const s = selectedText();
    if (!s) return;
    if (pinned && !box.hidden) {
      // A double-click fires several mouseups for the same selection.
      if (s.text !== src.textContent || tr.classList.contains('error')) translate(s.text);
      return;
    }
    pending = s.text;
    anchor = s.rect;
    const end = s.last || s.rect;
    btn.hidden = false;
    btn.style.left = `${Math.min(end.right + 4, innerWidth - 32)}px`;
    btn.style.top = `${Math.min(end.bottom + 4, innerHeight - 32)}px`;
  }

  function open(text) {
    btn.hidden = true;
    box.hidden = false;
    if (saved.w) box.style.width = `${saved.w}px`;
    if (saved.h) box.style.height = `${saved.h}px`;
    if (pinned && saved.x != null) {
      place(saved.x, saved.y);
    } else {
      // Below the selection, or above it when there's no room.
      const below = anchor.bottom + 8;
      const y = below + box.offsetHeight > innerHeight ? anchor.top - box.offsetHeight - 8 : below;
      place(anchor.left, y);
    }
    translate(text);
  }

  async function translate(text) {
    const id = ++seq;
    src.textContent = text;
    tr.className = 'tr loading';
    tr.textContent = '翻译中…';
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts: [text] });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (id !== seq) return;
    tr.className = res?.ok ? 'tr' : 'tr error';
    tr.textContent = res?.ok ? res.result[0] || '' : `[翻译失败] ${res?.error || ''}`;
  }

  function close() {
    box.hidden = true;
    seq++;
  }

  // Keep the page selection when clicking our controls.
  root.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  btn.addEventListener('click', () => open(pending));
  pinBtn.addEventListener('click', () => {
    setPinned(!pinned);
    save();
  });
  closeBtn.addEventListener('click', close);
  popoutBtn.addEventListener('click', () => {
    if (alive()) chrome.runtime.sendMessage({ type: 'openWindow', text: src.textContent }).catch(() => {});
    close();
  });
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(tr.textContent).catch(() => {});
    copyBtn.replaceChildren(icon('check'));
    setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1200);
  });

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = box.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', () => {
      head.removeEventListener('pointermove', move);
      save();
    }, { once: true });
  });

  // CSS `resize` writes inline width/height; persist them once the user stops dragging the corner.
  let resizeTimer = null;
  new ResizeObserver(() => {
    if (box.hidden || !box.style.height) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(save, 300);
  }).observe(box);

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || e.composedPath().includes(host) || !alive()) return;
    // The selection is final only after the mouseup has been handled.
    setTimeout(onSelect, 0);
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (e.composedPath().includes(host)) return;
    btn.hidden = true;
    if (!pinned) close();
  }, true);
  document.addEventListener('scroll', () => { btn.hidden = true; }, { capture: true, passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (btn.hidden && box.hidden)) return;
    btn.hidden = true;
    close();
  }, true);
  window.addEventListener('resize', () => {
    if (!box.hidden) place(box.offsetLeft, box.offsetTop);
  });
})();
