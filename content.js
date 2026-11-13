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
  // Inline elements kept in the translation: sent as <aN>…</aN> (the existing link syntax), N indexing serialize().els.
  const FORMAT_SELECTOR = 'a[href],b,strong,i,em,u,s,del,ins,mark,small,sub,sup,q,abbr,cite,dfn';
  // Beyond this many formatted spans only links keep their tags, so the text stays readable for the translator.
  const MAX_TAGS = 20;
  const TAG_RE = /<\s*(\/?)\s*a\s*(\d+)\s*>/gi;
  // Comment classes of highlight.js / Prism / CodeMirror, GitHub, Pygments / Rouge, plus our own wrapper.
  const COMMENT_SELECTOR = '[class*="comment"],.pl-c,.c,.c1,.cm,.ch,.cs,.st-comment-src';
  // Line/block comments in un-highlighted code; `#` and `--` must be followed by whitespace to skip #include, #fff, etc.
  const PLAIN_COMMENT_RE = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:\w"'\/])\/\/[^\n]*|(?<=^|\s)#(?=\s)[^\n]*|(?<=^|\s)--(?=\s)[^\n]*/gm;
  const MAX_BATCH_ITEMS = 16;
  const MAX_BATCH_CHARS = 2400;
  const MAX_CHARS = 3000;
  const MAX_CONCURRENT = 3;

  let active = false;
  let started = false;
  let targetLang = TARGET_LANG;
  // Base code of the page's main language; decides paragraphs too short to detect on their own.
  let pageLang = '';
  let pageLangReady = null;
  const done = new WeakSet();
  const queue = [];
  // Text length of queued elements, for packing batches by size.
  const lengths = new WeakMap();
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
  // Became visible while translation was toggled off; re-observed on the next activation.
  const deferred = [];
  let pendingScan = new Set();
  let scanTimer = null;
  const isOurs = (n) => n.nodeType === 1 && n.classList.contains('st-translation');
  const isFrame = window !== window.top;
  // Shadow trees we translate in: content.css doesn't reach into them, so they adopt these rules. Held weakly, as
  // infinite-scroll pages create and drop components all the time.
  const adopted = new WeakSet();
  const shadowRefs = new Set();
  const SHADOW_CSS = `.st-translation{display:block!important;margin-top:.25em;font:inherit;color:var(--st-tr-color,#6366f1)}
.st-translation.st-code{display:inline!important;margin:0;white-space:pre-wrap;font-style:italic;user-select:none}
.st-translation.st-loading{opacity:.4}
.st-translation.st-error{color:#d33!important;font-size:.85em;cursor:pointer}
:host-context(html.st-hidden) .st-translation:not(.st-hover){display:none!important}`;
  let shadowSheet = null;
  const MO_OPTIONS = { childList: true, subtree: true, characterData: true };
  // Closed roots need the extension API, and only custom elements are likely to have one; open ones are a plain read.
  const shadowOf = (el) => el.shadowRoot
    ?? (el.localName.includes('-') ? chrome.dom?.openOrClosedShadowRoot?.(el) ?? null : null);

  // Set on our own nodes rather than a page-level stylesheet, which the page could replace.
  let trColor = TR_COLOR;
  const paint = (n) => n.style.setProperty('--st-tr-color', trColor);
  const setColor = (c) => {
    trColor = isColor(c) ? c : TR_COLOR;
    [document, ...liveShadowRoots()].forEach((r) => r.querySelectorAll('.st-translation').forEach(paint));
  };
  chrome.storage.sync.get({ trColor: TR_COLOR }).then((s) => setColor(s.trColor)).catch(() => {});
  getTargetLang().then((l) => { targetLang = l; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.trColor) setColor(changes.trColor.newValue);
    if (changes.targetLang) targetLang = validLang(changes.targetLang.newValue);
  });

  const io = new IntersectionObserver(async (entries) => {
    const els = entries.filter((e) => e.isIntersecting).map((e) => e.target);
    els.forEach((el) => io.unobserve(el));
    if (!active) {
      deferred.push(...els);
      return;
    }
    const texts = els.map(textOf);
    const skip = await Promise.all(texts.map((t) => isInLang(stripCode(t), targetLang, pageLang)));
    els.forEach((el, i) => {
      if (skip[i] || source.has(el) || queue.includes(el)) return;
      lengths.set(el, texts[i].length);
      queue.push(el);
    });
    scheduleFlush();
  }, { rootMargin: '300px 0px' });

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Only our own holders were inserted: the page itself didn't change.
      if (m.addedNodes.length && !m.removedNodes.length && [...m.addedNodes].every(isOurs)) continue;
      markStale(m.target);
      if (!active) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !isOurs(n)) pendingScan.add(n);
      }
    }
    if (pendingScan.size && !scanTimer) scanTimer = setTimeout(scanPending, 50);
  });

  // SPAs add content in many small mutations: scan each new subtree once, skipping those nested in another.
  function scanPending() {
    scanTimer = null;
    const nodes = pendingScan;
    pendingScan = new Set();
    if (!active) return;
    for (const n of nodes) {
      let p = n.parentElement;
      while (p && !nodes.has(p)) p = p.parentElement;
      if (!p && n.isConnected) scan(n);
    }
  }

  function watch() {
    mo.observe(document.body, MO_OPTIONS);
  }

  // Mutations inside a shadow tree don't reach the observer on <body>, so each tree is observed too.
  function adoptShadow(root) {
    adoptSheet(root);
    if (adopted.has(root)) return;
    adopted.add(root);
    shadowRefs.add(new WeakRef(root));
    if (shadowRefs.size % 200 === 0) liveShadowRoots();
    mo.observe(root, MO_OPTIONS);
  }

  // Frameworks may reassign adoptedStyleSheets on re-render, dropping ours; checked again before each translation.
  function adoptSheet(root) {
    try {
      if (!shadowSheet) {
        shadowSheet = new CSSStyleSheet();
        shadowSheet.replaceSync(SHADOW_CSS);
      }
      if (!root.adoptedStyleSheets.includes(shadowSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, shadowSheet];
    } catch { /* unstyled translations are still readable */ }
  }

  // Roots still on the page; references to collected ones are dropped.
  function liveShadowRoots() {
    const roots = [];
    for (const ref of shadowRefs) {
      const root = ref.deref();
      if (!root) shadowRefs.delete(ref);
      else if (root.host.isConnected) roots.push(root);
    }
    return roots;
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
    return isCodeComment(el) ? commentText(el) : serialize(el).text;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'setActive') setActive(!!msg.active);
    if (msg.type === 'setActive' || msg.type === 'getState') sendResponse({ active, started });
  });
  // A frame loaded after its page was translated follows it; tiny frames are ads, trackers and widgets.
  const tinyFrame = () => isFrame && (innerWidth < 200 || innerHeight < 60);
  if (isFrame && !tinyFrame()) {
    chrome.runtime.sendMessage({ type: 'frameState' }).then((res) => { if (res?.result) setActive(true); }, () => {});
  }

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
    if (mouseX < 0 || !alive()) return;
    const deep = deepElementAt(mouseX, mouseY);
    const textNode = deep?.getRootNode() instanceof ShadowRoot ? null : textNodeAt(mouseX, mouseY);
    let target = textNode?.parentElement || deep;
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

  // elementFromPoint stops at shadow hosts; descend into their trees.
  function deepElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let root = el && shadowOf(el); root; root = shadowOf(el)) {
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
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
    const payload = serialize(wrap);
    return payload.text ? { ...payload, before: last?.nextSibling } : null;
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

  // Text for the translator plus shallow copies of its inline elements (els) and <code> elements (codes) to rebuild
  // them in the translation. Inline <code> is sent wrapped in backticks, formatted spans as <aN>…</aN>.
  function serialize(el) {
    const clone = el.cloneNode(true);
    // CSS-hidden spans would otherwise leak into the text; skipped while the whole block is hidden (collapsed, etc.).
    if (el.isConnected && el.checkVisibility?.()) {
      const copies = clone.querySelectorAll('*');
      el.querySelectorAll('*').forEach((n, i) => {
        if (n.checkVisibility && !n.checkVisibility()) copies[i].remove();
      });
    }
    clone.querySelectorAll(`.st-translation,script,style,${HIDDEN_SELECTOR}`).forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    const codes = [];
    clone.querySelectorAll('code').forEach((n) => {
      codes.push(n.cloneNode(true));
      n.replaceWith(`\`${n.textContent}\``);
    });
    let tags = [...clone.querySelectorAll(FORMAT_SELECTOR)];
    if (tags.length > MAX_TAGS) tags = tags.filter((t) => t.matches('a[href]'));
    const els = tags.map((t) => t.cloneNode(false));
    // Innermost first (reverse document order), so outer tags wrap the inner ones' markers.
    for (let i = tags.length - 1; i >= 0; i--) {
      const t = tags[i];
      t.replaceWith(t.textContent.trim() ? `<a${i}>${t.textContent}</a${i}>` : t.textContent);
    }
    const text = clone.textContent.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    return { text, els, codes };
  }

  function stripCode(text) {
    return text.replace(/`[^`]*`/g, '').replace(/<\s*\/?\s*a\s*\d+\s*>/gi, '');
  }

  async function setActive(on) {
    if (on === active || (on && tinyFrame())) return;
    active = on;
    document.documentElement.classList.toggle('st-hidden', !active);
    if (!active) return;
    if (!started) {
      started = true;
      watch();
    }
    pageLangReady ??= detectPageLang().then((l) => { pageLang = l; }, () => {});
    await pageLangReady;
    if (!active) return;
    // Rescan on every activation: content added while hidden was ignored by the observer.
    scan(document.body);
    deferred.splice(0).forEach((el) => el.isConnected && io.observe(el));
    flush();
  }

  // Detected from a sample of the main text; the lang attribute is often a template default.
  async function detectPageLang() {
    const root = document.querySelector('main,article,[role="main"]') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(PAGE_SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let sample = '';
    while (sample.length < 3000 && walker.nextNode()) sample += `${walker.currentNode.textContent} `;
    return (await detectLang(sample.replace(/\s+/g, ' '))) || baseLang(document.documentElement.lang);
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
    // Only ShadowRoot (nodeType 11) maps to its host; custom elements (e.g. YouTube) may define their own `host` prop.
    const s = (el.nodeType === 11 ? el.host : el).closest(PAGE_SKIP_SELECTOR);
    return !!s && s !== document.documentElement && s !== document.body;
  }

  // Group text nodes by their nearest block; a block that also holds nested blocks translates only its own text.
  // Shadow trees met on the way are scanned the same way.
  function scan(root) {
    const blocks = new Set();
    const shadows = [];
    if (!inPageSkip(root)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          if (n.nodeType === 1) {
            if (n.matches(PAGE_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            const shadow = shadowOf(n);
            if (shadow) shadows.push(shadow);
            return NodeFilter.FILTER_SKIP;
          }
          return /\p{L}/u.test(n.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      while (walker.nextNode()) {
        const block = blockOf(walker.currentNode.parentElement);
        if (block) blocks.add(block);
      }
    }
    for (const shadow of shadows) {
      adoptShadow(shadow);
      scan(shadow);
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

  function payloadOf(el) {
    if (partial.has(el)) return partial.get(el);
    if (isCodeComment(el)) return { text: commentText(el) };
    return el.querySelector(`code,${FORMAT_SELECTOR}`) ? serialize(el) : { text: el.innerText.trim() };
  }

  function textOf(el) {
    return payloadOf(el).text;
  }

  // Lets AI engines resolve ambiguous words; untrusted page data, fenced off as such in the prompt.
  function pageContext() {
    const meta = document.querySelector('meta[name="description"],meta[property="og:description"]');
    return { title: document.title, description: meta?.content || '' };
  }

  // Rebuilds the inline elements from <aN> tags (shallow clones of the source ones) and backtick code; built with
  // nodes, never HTML. Unknown, repeated or unmatched tags are dropped; a close tag also closes tags misnested in it.
  function renderTranslation(holder, text, { els = [], codes = [] } = {}) {
    holder.replaceChildren();
    const stack = [{ node: holder, i: -1 }];
    const append = (s) => stack.at(-1).node.append(...textNodes(s, codes));
    let last = 0;
    for (const m of text.matchAll(TAG_RE)) {
      append(text.slice(last, m.index));
      last = m.index + m[0].length;
      const i = Number(m[2]);
      const isOpen = stack.some((s) => s.i === i);
      if (!m[1]) {
        if (!els[i] || isOpen) continue;
        const node = els[i].cloneNode(false);
        node.removeAttribute('id');
        stack.at(-1).node.append(node);
        stack.push({ node, i });
      } else if (isOpen) {
        while (stack.pop().i !== i);
      }
    }
    append(text.slice(last));
  }

  // Backtick spans become copies of the source <code> with the same text (a plain <code> otherwise), newlines <br>.
  function textNodes(s, codes) {
    return s.split(/`([^`\n]+)`/).flatMap((part, i) => {
      if (i % 2) {
        const src = codes.find((c) => c.textContent === part);
        const code = src ? src.cloneNode(true) : document.createElement('code');
        if (src) code.removeAttribute('id');
        else code.textContent = part;
        return [code];
      }
      return part.split('\n').flatMap((line, j) => (j ? [document.createElement('br'), line] : [line]));
    });
  }

  // After the extension is reloaded or updated, this orphaned script can no longer reach chrome.* APIs.
  function alive() {
    if (chrome.runtime?.id) return true;
    io.disconnect();
    mo.disconnect();
    clearTimeout(flushTimer);
    clearTimeout(scanTimer);
    clearTimeout(staleTimer);
    queue.length = 0;
    return false;
  }

  // Throttled rather than debounced, so a steady stream of intersections during scrolling can't postpone it.
  function scheduleFlush() {
    flushTimer ??= setTimeout(flush, 100);
  }

  // Cap in-flight batches so fast scrolling on long pages doesn't trigger rate limits (HTTP 429).
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!alive() || !active || !queue.length || running >= MAX_CONCURRENT) return;
    prioritize();
    while (active && queue.length && running < MAX_CONCURRENT) {
      const batch = takeBatch();
      if (!batch.length) continue;
      running++;
      translateBatch(batch).finally(() => {
        running--;
        flush();
      });
    }
  }

  // On-screen paragraphs first in reading order, then those below, then above. Ones scrolled far away (or hidden)
  // go back to the observer, which queues them again when they come near.
  function prioritize() {
    const h = innerHeight;
    const far = Math.max(2 * h, 1000);
    const keyed = [];
    for (const el of queue.splice(0)) {
      // SPAs may have removed queued elements before their turn.
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const key = r.bottom <= 0 ? -r.bottom * 2 : r.top >= h ? r.top - h : r.top - h - 1;
      if ((!r.width && !r.height) || key > far) io.observe(el);
      else keyed.push([key, el]);
    }
    keyed.sort((a, b) => a[0] - b[0]);
    queue.push(...keyed.map(([, el]) => el));
  }

  // Packs short paragraphs together up to a size budget; a long one goes alone.
  function takeBatch() {
    const batch = [];
    let chars = 0;
    while (queue.length && batch.length < MAX_BATCH_ITEMS) {
      const len = lengths.get(queue[0]) ?? 200;
      if (batch.length && chars + len > MAX_BATCH_CHARS) break;
      chars += len;
      batch.push(queue.shift());
    }
    return batch.filter((el) => el.isConnected);
  }

  async function translateBatch(els, hover = false) {
    const payloads = els.map(payloadOf);
    const sigs = els.map(signature);
    els.forEach((el, i) => source.set(el, sigs[i]));
    const holders = els.map((el) => {
      const holder = document.createElement('font');
      holder.className = hover ? 'st-translation st-hover st-loading' : 'st-translation st-loading';
      if (isCodeComment(el)) holder.classList.add('st-code');
      paint(holder);
      holder.textContent = '…';
      // A retry may run after the page changed, so the stored anchor can be gone.
      const before = partial.get(el)?.before;
      el.insertBefore(holder, before?.parentNode === el ? before : null);
      const root = el.getRootNode();
      if (root instanceof ShadowRoot) adoptSheet(root);
      return holder;
    });
    const fill = (i, text) => {
      const h = holders[i];
      h.classList.remove('st-loading');
      if (h.classList.contains('st-code')) h.textContent = `\n${lineIndent(els[i])}${text}`;
      else renderTranslation(h, text, payloads[i]);
    };
    // AI engines stream: paragraphs fill in as they arrive, then the final reply settles them all.
    const res = await translateStream(payloads.map((p) => p.text), pageContext(), (i, text) => {
      if (text && holders[i]?.isConnected) fill(i, text);
    });
    if (!res.ok && !chrome.runtime?.id) res.error = '扩展已更新，请刷新页面';
    holders.forEach((h, i) => {
      // The page rewrote the paragraph while we waited: drop the reply, checkStale translates the new text.
      if (!h.isConnected) return;
      if (signature(els[i]) !== sigs[i]) {
        h.remove();
        return;
      }
      h.classList.remove('st-loading');
      if (res.ok) {
        fill(i, res.result[i] || '');
      } else {
        h.classList.add('st-error');
        h.textContent = `[翻译失败] ${res.error || ''}`;
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
