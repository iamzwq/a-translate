(() => {
  if (window.__simpleTranslateLoaded) return;
  window.__simpleTranslateLoaded = true;

  const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,td,th,blockquote,figcaption,summary,caption,div';
  const SKIP_SELECTOR = 'script,style,noscript,code,pre,textarea,input,select,svg,math,[contenteditable="true"],.st-translation,.ytp-caption-window-container,.st-yt-overlay';
  // Skipped by whole-page translation only; hovering still translates them on request.
  const PAGE_SKIP_SELECTOR = `${SKIP_SELECTOR},button,nav,footer,[translate="no"],.notranslate`;
  const HIDDEN_SELECTOR = '[hidden],[aria-hidden="true"],.sr-only,.visually-hidden,.screen-reader-text';
  const INLINE_TAGS = new Set(['A', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'INS', 'SMALL', 'SUB', 'SUP',
    'MARK', 'ABBR', 'TIME', 'FONT', 'LABEL', 'CODE', 'KBD', 'BR', 'IMG', 'CITE', 'Q', 'DFN', 'VAR', 'BDI', 'BDO', 'WBR']);
  // A text that is entirely a URL, email, version, @handle, path or file name.
  const NON_PROSE_RE = /^(?:(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|v?\d+(?:\.\d+)+[\w.-]*|@[\w.-]+|\S*[\/\\]\S*|[\w-]+\.[a-z0-9]{1,5})$/i;
  const LINK_TAG_RE = /<\s*a\s*(\d+)\s*>([\s\S]*?)<\s*\/\s*a\s*\1\s*>/gi;
  // Comment classes of highlight.js / Prism / CodeMirror, GitHub, Pygments / Rouge, plus our own wrapper.
  const COMMENT_SELECTOR = '[class*="comment"],.pl-c,.c,.c1,.cm,.ch,.cs,.st-comment-src';
  // Line/block comments in un-highlighted code; `#` and `--` must be followed by whitespace to skip #include, #fff, etc.
  const PLAIN_COMMENT_RE = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:\w"'\/])\/\/[^\n]*|(?<=^|\s)#(?=\s)[^\n]*|(?<=^|\s)--(?=\s)[^\n]*/gm;
  const BATCH_SIZE = 8;
  const MAX_CHARS = 3000;
  const MAX_CONCURRENT = 3;

  let active = false;
  let started = false;
  const done = new WeakSet();
  const queue = [];
  let flushTimer = null;
  let running = 0;
  // Hover target that contains nested blocks: translate only its own text, placed before the first nested block.
  const partial = new WeakMap();
  // Translated element -> its source text at request time, to notice when the page rewrites it.
  const source = new WeakMap();
  // Retranslations per element, capped so live-updating text (clocks, tickers) can't loop forever.
  const rewrites = new WeakMap();
  const MAX_REWRITES = 3;
  const stale = new Set();
  let staleTimer = null;
  const blockCache = new WeakMap();

  const io = new IntersectionObserver(async (entries) => {
    const els = entries.filter((e) => e.isIntersecting).map((e) => e.target);
    els.forEach((el) => io.unobserve(el));
    const skip = await Promise.all(els.map((el) => isChinese(stripCode(textOf(el)))));
    queue.push(...els.filter((el, i) => !skip[i] && !source.has(el)));
    scheduleFlush();
  }, { rootMargin: '300px 0px' });

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      markStale(m.target);
      if (!active) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !n.classList.contains('st-translation')) scan(n);
      }
    }
  });

  function watch() {
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function markStale(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el.closest('.st-translation')) return;
    for (; el && el !== document.body; el = el.parentElement) {
      if (source.has(el)) stale.add(el);
    }
    if (stale.size && !staleTimer) staleTimer = setTimeout(checkStale, 200);
  }

  // Drop translations whose source text changed or that the page's re-render removed, then translate again.
  function checkStale() {
    staleTimer = null;
    for (const el of stale) {
      if (!el.isConnected || !source.has(el)) continue;
      const old = [...el.children].filter((c) => c.classList.contains('st-translation'));
      if (old.length && signature(el) === source.get(el)) continue;
      old.forEach((c) => c.remove());
      source.delete(el);
      partial.delete(el);
      const n = (rewrites.get(el) || 0) + 1;
      rewrites.set(el, n);
      if (n > MAX_REWRITES) continue;
      done.delete(el);
      if (active) scan(isCodeComment(el) ? el.closest('pre') : el);
    }
    stale.clear();
  }

  function signature(el) {
    if (partial.has(el)) return ownTextOf(el)?.text;
    return isCodeComment(el) ? commentText(el) : textWithCode(el);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'toggle') toggle();
    if (msg.type === 'toggle' || msg.type === 'getState') sendResponse({ active, started });
  });

  // Hover + press Ctrl alone (not as part of a shortcut like Ctrl+C) to translate a paragraph.
  let mouseX = -1;
  let mouseY = -1;
  let ctrlAlone = false;
  document.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; }, { passive: true });
  const resetCtrl = () => { ctrlAlone = false; };
  // Ctrl+click and Ctrl+wheel (zoom) are not a bare Ctrl press.
  document.addEventListener('mousedown', resetCtrl, true);
  document.addEventListener('wheel', resetCtrl, { capture: true, passive: true });
  window.addEventListener('blur', resetCtrl);
  document.addEventListener('keydown', (e) => {
    // Windows auto-repeats a held Ctrl; that is still the same bare press.
    if (e.repeat) return;
    ctrlAlone = e.key === 'Control' && !e.altKey && !e.shiftKey && !e.metaKey;
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Control' || !ctrlAlone) return;
    ctrlAlone = false;
    hoverTranslate();
  }, true);

  function hoverTranslate() {
    if (mouseX < 0) return;
    const textNode = textNodeAt(mouseX, mouseY);
    let target = textNode?.parentElement || document.elementFromPoint(mouseX, mouseY);
    if (!target) return;
    const pre = target.closest('pre');
    let el;
    if (pre) {
      el = getComments(pre).find((c) => [...c.getClientRects()].some((r) => (
        mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom)));
      if (!el) return;
    } else {
      const existing = target.closest('.st-translation');
      if (existing) target = existing.parentElement;
      el = blockOf(target);
      if (!el || el.closest(SKIP_SELECTOR)) return;
      el = inlineItemAt(el, target);
      if (!el) return;
    }
    const old = [...el.children].filter((c) => c.classList.contains('st-translation'));
    if (old.length) {
      // A page translation hidden by toggle is revealed first instead of being removed unseen.
      const visible = active || old.some((c) => c.classList.contains('st-hover'));
      if (visible) source.delete(el);
      old.forEach((c) => (visible ? c.remove() : c.classList.add('st-hover')));
      return;
    }
    // Container with nested blocks: only when the cursor is on its own text, so padding doesn't translate a whole section.
    if (!pre && hasNestedBlock(el)) {
      const own = textNode && ownTextOf(el);
      if (!own) return;
      partial.set(el, own);
    }
    const text = textOf(el);
    if (!text || text.length > MAX_CHARS || !/\p{L}/u.test(stripCode(text))) return;
    done.add(el);
    io.unobserve(el);
    const idx = queue.indexOf(el);
    if (idx >= 0) queue.splice(idx, 1);
    watch();
    translateBatch([el], true);
  }

  // A div holding only side-by-side inline items (nav links, tags, buttons): pick the hovered item, null for the gaps.
  // Divs with their own text are sentences with inline markup; `lang` marks text blocks like tweetText.
  function inlineItemAt(el, target) {
    if (el.tagName !== 'DIV' || el.lang) return el;
    if ([...el.childNodes].some((n) => (n.nodeType === 3 && /\p{L}/u.test(n.textContent))
      || n.classList?.contains('st-translation'))) return el;
    const items = [...el.children].filter((c) => c.textContent.trim());
    return items.length > 1 ? items.find((c) => c.contains(target)) || null : el;
  }

  function textNodeAt(x, y) {
    const range = document.caretRangeFromPoint?.(x, y);
    const node = range?.startContainer;
    if (node?.nodeType !== 3 || !node.textContent.trim()) return null;
    // caretRangeFromPoint snaps to the nearest text, so confirm the cursor is really over it.
    const r = document.createRange();
    r.selectNodeContents(node);
    const hit = [...r.getClientRects()].some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
    return hit ? node : null;
  }

  function ownTextOf(el) {
    const own = [...el.childNodes].filter((n) => (n.nodeType === 3
      || (n.nodeType === 1 && !n.matches('script,style,.st-translation') && !isBlock(n) && !hasNestedBlock(n))));
    const last = [...own].reverse().find((n) => n.textContent.trim());
    const wrap = document.createElement('div');
    wrap.append(...own.map((n) => n.cloneNode(true)));
    const text = textWithCode(wrap);
    const links = own.flatMap((n) => (n.nodeType !== 1 ? []
      : n.matches('a[href]') ? [n] : [...n.querySelectorAll('a[href]')]));
    return text ? { text, before: last?.nextSibling, links } : null;
  }

  // Selector match first; unknown and custom elements fall back to their computed display.
  function isBlock(el) {
    if (el.matches(BLOCK_SELECTOR)) return true;
    if (INLINE_TAGS.has(el.tagName) || el.classList.contains('st-translation')) return false;
    let block = blockCache.get(el);
    if (block === undefined) {
      const d = getComputedStyle(el).display;
      block = d !== 'none' && d !== 'contents' && !d.startsWith('inline');
      blockCache.set(el, block);
    }
    return block;
  }

  function blockOf(el) {
    for (; el && el !== document.body; el = el.parentElement) {
      if (isBlock(el)) return el;
    }
    return null;
  }

  function hasNestedBlock(el) {
    return !!el.querySelector(BLOCK_SELECTOR) || [...el.querySelectorAll('*')].some(isBlock);
  }

  function linksOf(el) {
    return partial.get(el)?.links ?? [...el.querySelectorAll('a[href]')].filter((a) => !a.closest('.st-translation'));
  }

  // Inline <code> is sent wrapped in backticks and links as <aN>…</aN>, N indexing linksOf(el).
  function textWithCode(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.st-translation,script,style').forEach((n) => n.remove());
    const anchors = [...clone.querySelectorAll('a[href]')];
    clone.querySelectorAll(HIDDEN_SELECTOR).forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    clone.querySelectorAll('code').forEach((n) => n.replaceWith(`\`${n.textContent}\``));
    anchors.forEach((a, i) => {
      if (!clone.contains(a)) return;
      a.replaceWith(a.textContent.trim() ? `<a${i}>${a.textContent}</a${i}>` : a.textContent);
    });
    return clone.textContent.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  }

  function stripCode(text) {
    return text.replace(/`[^`]*`/g, '').replace(/<\s*\/?\s*a\s*\d+\s*>/gi, '');
  }

  function toggle() {
    active = !active;
    document.documentElement.classList.toggle('st-hidden', !active);
    if (!active) return;
    // Rescan on every activation: content added while hidden was ignored by the observer.
    scan(document.body);
    if (!started) {
      started = true;
      watch();
    }
  }

  async function isChinese(text) {
    try {
      const { isReliable, languages } = await chrome.i18n.detectLanguage(text);
      if (isReliable) return !!languages[0]?.language.startsWith('zh');
    } catch { /* detection unavailable: use the script heuristic */ }
    // Kana or Hangul means Japanese/Korean even when Han characters dominate.
    if (/[\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
    const cjk = text.match(/[\u4e00-\u9fff]/g);
    return !!cjk && cjk.length / text.replace(/\s/g, '').length > 0.3;
  }

  function hasOwnText(el) {
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  }

  function isTranslatable(text) {
    const prose = stripCode(text).trim();
    return prose.length >= 2 && text.length <= MAX_CHARS && /\p{L}/u.test(prose) && !NON_PROSE_RE.test(prose);
  }

  function isCandidate(el) {
    const text = el.innerText?.trim() || '';
    // Div/custom block with text only in inline children (e.g. tweetText): require lang or length to skip buttons/labels.
    if ((el.tagName === 'DIV' || !el.matches(BLOCK_SELECTOR)) && !hasOwnText(el) && !el.lang && text.length < 20) return false;
    return isTranslatable(textOf(el));
  }

  // `translate="no"` / .notranslate on <html> or <body> must not block the whole page.
  function inPageSkip(el) {
    const s = el.closest(PAGE_SKIP_SELECTOR);
    return !!s && s !== document.documentElement && s !== document.body;
  }

  // Group text nodes by their nearest block; a block that also holds nested blocks translates only its own text.
  function scan(root) {
    const blocks = new Set();
    if (!inPageSkip(root)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          if (n.nodeType === 1) return n.matches(PAGE_SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          return /\p{L}/u.test(n.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      while (walker.nextNode()) {
        const block = blockOf(walker.currentNode.parentElement);
        if (block) blocks.add(block);
      }
    }
    for (const el of blocks) {
      if (done.has(el)) continue;
      if (hasNestedBlock(el)) {
        const own = ownTextOf(el);
        if (!own || own.text.length < 20 || !isTranslatable(own.text)) continue;
        partial.set(el, own);
      } else if (!isCandidate(el)) {
        continue;
      }
      done.add(el);
      io.observe(el);
    }
    const inPre = root.closest?.('pre');
    const pres = inPre ? [inPre] : root.querySelectorAll('pre');
    for (const pre of pres) {
      for (const c of getComments(pre)) {
        if (done.has(c) || !isTranslatable(commentText(c))) continue;
        done.add(c);
        io.observe(c);
      }
    }
  }

  function getComments(pre) {
    if (pre.isContentEditable || pre.closest('.CodeMirror,.monaco-editor')) return [];
    const list = [...pre.querySelectorAll(COMMENT_SELECTOR)].filter((c) => {
      if (c.closest('.st-translation')) return false;
      const outer = c.parentElement.closest(COMMENT_SELECTOR);
      return !outer || outer === pre || !pre.contains(outer);
    });
    // No highlighter spans: find comments in raw text and wrap them.
    if (!list.length && !pre.querySelector('span')) {
      wrapPlainComments(pre);
      return [...pre.querySelectorAll('.st-comment-src')];
    }
    return list;
  }

  function wrapPlainComments(pre) {
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const matches = [...node.textContent.matchAll(PLAIN_COMMENT_RE)];
      for (const m of matches.reverse()) {
        const mid = node.splitText(m.index);
        mid.splitText(m[0].length);
        const span = document.createElement('span');
        span.className = 'st-comment-src';
        mid.replaceWith(span);
        span.appendChild(mid);
      }
    }
  }

  function commentText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.st-translation').forEach((t) => t.remove());
    return clone.textContent
      .replace(/^\s*(\/\*+|<!--|\/\/+|#+|--)/, '')
      .replace(/(\*+\/|-->)\s*$/, '')
      .split('\n')
      .map((l) => l.replace(/^\s*(\*+|\/\/+|#+|--)\s?/, '').trim())
      .filter(Boolean)
      .join(' ');
  }

  function isCodeComment(el) {
    return !!el.closest('pre');
  }

  // Leading whitespace of the code line where the comment starts, so the translation aligns with it.
  function lineIndent(el) {
    const pre = el.closest('pre');
    const range = document.createRange();
    range.setStart(pre, 0);
    range.setEndBefore(el);
    const before = range.toString();
    return before.slice(before.lastIndexOf('\n') + 1).match(/^[ \t]*/)[0];
  }

  function textOf(el) {
    if (partial.has(el)) return partial.get(el).text;
    if (isCodeComment(el)) return commentText(el);
    return el.querySelector('code,a[href]') ? textWithCode(el) : el.innerText.trim();
  }

  // Backtick spans become <code> and <aN> tags shallow clones of the source links; built with nodes, never HTML.
  function renderTranslation(holder, text, links) {
    const codeNodes = (s) => s.replace(/<\s*\/?\s*a\s*\d+\s*>/gi, '').split(/`([^`\n]+)`/).map((part, i) => {
      if (i % 2 === 0) return part;
      const code = document.createElement('code');
      code.textContent = part;
      return code;
    });
    const parts = text.split(LINK_TAG_RE);
    const nodes = [];
    for (let i = 0; i < parts.length; i += 3) {
      nodes.push(...codeNodes(parts[i]));
      if (i + 1 >= parts.length) break;
      const src = links[parts[i + 1]];
      if (!src) {
        nodes.push(...codeNodes(parts[i + 2]));
        continue;
      }
      const a = src.cloneNode(false);
      a.removeAttribute('id');
      a.append(...codeNodes(parts[i + 2]));
      nodes.push(a);
    }
    holder.replaceChildren(...nodes);
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 100);
  }

  // Cap in-flight batches so fast scrolling on long pages doesn't trigger rate limits (HTTP 429).
  function flush() {
    while (queue.length && running < MAX_CONCURRENT) {
      // SPAs may have removed queued elements before their turn.
      const batch = queue.splice(0, BATCH_SIZE).filter((el) => el.isConnected);
      if (!batch.length) continue;
      running++;
      translateBatch(batch).finally(() => {
        running--;
        flush();
      });
    }
  }

  async function translateBatch(els, hover = false) {
    const texts = els.map(textOf);
    const links = els.map(linksOf);
    els.forEach((el) => source.set(el, signature(el)));
    const holders = els.map((el) => {
      const holder = document.createElement('font');
      holder.className = hover ? 'st-translation st-hover st-loading' : 'st-translation st-loading';
      if (isCodeComment(el)) holder.classList.add('st-code');
      holder.textContent = '…';
      // A retry may run after the page changed, so the stored anchor can be gone.
      const before = partial.get(el)?.before;
      el.insertBefore(holder, before?.parentNode === el ? before : null);
      return holder;
    });
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    holders.forEach((h, i) => {
      h.classList.remove('st-loading');
      if (res?.ok) {
        const text = res.result[i] || '';
        if (h.classList.contains('st-code')) h.textContent = `\n${lineIndent(els[i])}${text}`;
        else renderTranslation(h, text, links[i]);
      } else {
        h.classList.add('st-error');
        h.textContent = `[翻译失败] ${res?.error || ''}`;
        h.title = '点击重试';
        h.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          holders.forEach((x) => x.remove());
          translateBatch(els, hover);
        };
      }
    });
  }
})();
