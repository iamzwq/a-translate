// Bilingual YouTube subtitles: captured json3 track -> sentences -> look-ahead translation -> overlay on the player.
(() => {
  if (window.__stYoutubeLoaded) return;
  window.__stYoutubeLoaded = true;

  const LOOKAHEAD_MS = 60000;
  const BATCH_SIZE = 20;
  // A batch due now is kept small so it returns fast, e.g. right after a seek.
  const URGENT_BATCH_SIZE = 6;
  const MAX_INFLIGHT = 2;
  // Lines before / after a batch sent along as context (used by AI engines).
  const CONTEXT_LINES = 3;
  const MAX_TRACKS = 5;
  const END_RE = /[.!?。！？…]["'”’)\]]*$/;
  const PAUSE_RE = /[,，、;；:：]$/;
  const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/;
  // Words that rarely end an English sentence; ASR breaks right after them are penalized.
  const NO_END_RE = /^(?:a|an|the|and|or|but|so|to|of|in|on|at|for|with|from|by|as|is|are|was|were|be|i|my|your|our|their|his|her|its|this|that|which|who|if|because|than|very|just|not|can|will|would|could|should|have|has|had|do|does|did)$/i;
  const ASR = { minUnits: 5, maxUnits: 22, maxMs: 8000, hardPauseMs: 1500, threshold: 2 };
  const DEFAULTS = { ytTrOnly: false, ytTrColor: '', targetLang: 'zh-CN', ytAutoCC: true, ytFontScale: 1, ytBgOpacity: 0.75 };

  // videoId -> { latest, byKey: Map(`lang|kind` -> sentences) } of every caption track the player loaded.
  const tracks = new Map();
  // Track selected in the player ({ lang, kind, tlang, live }), polled by youtube-hook.js; null if unknown.
  let selected = null;
  let overlay = null;
  let shownKey = null;
  let inflight = 0;
  let retryAt = 0;
  let trOnly = false;
  // No config.js / utils.js here (they would be loaded twice next to content.js); youtube.css holds the default color.
  let trColor = '';
  let fontScale = 1;
  let bgOpacity = 0.75;
  // Base code of the target language; tracks already in it keep YouTube's native captions.
  let targetBase = 'zh';
  // Bumped on target changes so replies to requests sent before are dropped.
  let targetGen = 0;
  // Dragged overlay heights, % of the player from its bottom, per player kind: { watch, shorts }.
  let positions = {};
  // Live streams: caption text on screen, the text last sent for translation and its translation.
  const live = { text: '', changedAt: 0, reqText: '', reqAt: 0, busy: false, tr: '' };
  const baseOf = (code) => (code || '').toLowerCase().split(/[-_]/)[0];
  chrome.storage.sync.get(DEFAULTS).then((s) => {
    targetBase = baseOf(s.targetLang);
    setColor(s.ytTrColor);
    setStyle(s.ytFontScale, s.ytBgOpacity);
    setAutoCC(s.ytAutoCC);
    setTrOnly(s.ytTrOnly);
  }).catch(() => {});
  chrome.storage.local.get({ ytPos: {} }).then((s) => {
    positions = s.ytPos || {};
    applyPosition();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ytPos) {
      positions = changes.ytPos.newValue || {};
      applyPosition();
    }
    if (area !== 'sync') return;
    if (changes.ytTrColor) setColor(changes.ytTrColor.newValue);
    if (changes.ytTrOnly) setTrOnly(changes.ytTrOnly.newValue);
    if (changes.targetLang) setTarget(changes.targetLang.newValue);
    if (changes.ytAutoCC) setAutoCC(changes.ytAutoCC.newValue);
    if (changes.ytFontScale || changes.ytBgOpacity) {
      setStyle(changes.ytFontScale?.newValue ?? fontScale, changes.ytBgOpacity?.newValue ?? bgOpacity);
    }
  });
  const resizeObserver = new ResizeObserver(() => fitFont());

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const { source, url, text, track } = e.data || {};
    if (source === 'st-yt-captions' && typeof url === 'string' && typeof text === 'string') onCaptions(url, text);
    if (source === 'st-yt-track' && typeof track === 'string') {
      try { selected = JSON.parse(track); } catch { selected = null; }
      update();
    }
  });

  for (const type of ['timeupdate', 'seeking', 'seeked', 'play']) {
    document.addEventListener(type, (e) => {
      if (e.target.matches?.('video') && e.target.closest('.html5-video-player') === activePlayer()) update();
    }, true);
  }
  document.addEventListener('yt-navigate-finish', () => update());

  // Shorts share one player; thumbnails' hover previews have players of their own that must not be followed.
  function activePlayer() {
    if (location.pathname.startsWith('/shorts/')) return document.querySelector('#shorts-player');
    return document.querySelector('#movie_player')
      || document.querySelector('.html5-video-player:not(#inline-preview-player)');
  }

  // Read by youtube-hook.js in the page's world, which can't access extension storage.
  function setAutoCC(value) {
    document.documentElement.dataset.stAutoCc = value === false ? '' : '1';
  }

  // Without the unread-notification count and the site name.
  function videoTitle() {
    return document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
  }

  function onCaptions(url, text) {
    let params;
    try { params = new URL(url, location.href).searchParams; } catch { return; }
    const videoId = params.get('v');
    if (!videoId) return;
    if (!tracks.has(videoId)) {
      tracks.set(videoId, { latest: null, byKey: new Map() });
      if (tracks.size > MAX_TRACKS) tracks.delete(tracks.keys().next().value);
    }
    const entry = tracks.get(videoId);
    const key = `${params.get('lang')}|${params.get('kind') || ''}`;
    // YouTube's own auto-translation or a track in the target language: leave the native captions alone.
    if (params.get('tlang') || isNativeLang(params.get('lang'))) {
      entry.latest = null;
      update();
      return;
    }
    entry.latest = key;
    if (!entry.byKey.has(key)) {
      let data;
      try { data = JSON.parse(text); } catch { return; }
      const sentences = segment(data.events || [], params.get('kind') === 'asr');
      if (!sentences.length) return;
      entry.byKey.set(key, sentences);
    }
    update();
  }

  function isNativeLang(lang) {
    return baseOf(lang) === targetBase;
  }

  // Prefer the player's selected track: switching back from YouTube's translation may reuse its cache without a request.
  function sentencesFor(videoId) {
    const entry = tracks.get(videoId);
    if (!entry) return null;
    return entry.byKey.get(`${selected?.lang}|${selected?.kind}`) || entry.byKey.get(entry.latest) || null;
  }

  function currentVideoId() {
    return new URLSearchParams(location.search).get('v')
      || location.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1];
  }

  // Flatten events into timed tokens: whole cues for uploaded captions, single words for ASR. `cue` is the event index.
  function tokensOf(events) {
    const tokens = [];
    events.forEach((ev, cue) => {
      if (!ev.segs) return;
      const start = ev.tStartMs || 0;
      const end = start + (ev.dDurationMs || 0);
      ev.segs.forEach((seg, i) => {
        const text = (seg.utf8 || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        const next = ev.segs[i + 1]?.tOffsetMs;
        tokens.push({ text, cue, start: start + (seg.tOffsetMs || 0), end: next != null ? start + next : end });
      });
    });
    return tokens.sort((a, b) => a.start - b.start);
  }

  function join(a, b) {
    return CJK_RE.test(a.at(-1)) && CJK_RE.test(b[0]) ? a + b : `${a} ${b}`;
  }

  const isSoundTag = (text) => /^[[(♪]/.test(text) || /[\])♪]$/.test(text);

  function segment(events, asr) {
    const tokens = tokensOf(events);
    const sentences = asr ? segmentAsr(tokens) : segmentCues(tokens);
    // Close short gaps so lines don't blink, and remove overlaps so lookup by time is unambiguous.
    sentences.forEach((s, i) => {
      const next = sentences[i + 1];
      if (next && next.start > s.start && next.start - s.end < 1000) s.end = next.start;
    });
    return sentences;
  }

  // Uploaded captions: merge cues into sentences at end punctuation, pauses over 1s, sound tags and length caps.
  function segmentCues(tokens) {
    // Without sentence punctuation the author's own cues are the best split there is; a styled cue has several segs.
    if (tokens.filter((tk) => END_RE.test(tk.text)).length < tokens.length * 0.15) {
      const cues = [];
      for (const tk of tokens) {
        const same = cues.at(-1)?.cue === tk.cue && cues.at(-1);
        if (same) {
          same.text = join(same.text, tk.text);
          same.end = Math.max(same.end, tk.end);
        } else {
          cues.push({ ...tk });
        }
      }
      return cues;
    }
    const sentences = [];
    let cur = null;
    for (const tk of tokens) {
      if (cur && (tk.start - cur.end > 1000 || /^[[(♪]/.test(tk.text))) {
        sentences.push(cur);
        cur = null;
      }
      if (cur) {
        cur.text = join(cur.text, tk.text);
        cur.end = Math.max(cur.end, tk.end);
      } else {
        cur = { start: tk.start, end: tk.end, text: tk.text };
      }
      const cjk = CJK_RE.test(cur.text);
      const len = cur.text.length;
      if (END_RE.test(tk.text) || /[\])♪]$/.test(tk.text) || len >= (cjk ? 40 : 120)
        || cur.end - cur.start >= 10000 || (PAUSE_RE.test(tk.text) && len >= (cjk ? 20 : 60))) {
        sentences.push(cur);
        cur = null;
      }
    }
    if (cur) sentences.push(cur);
    return sentences;
  }

  // Two CJK characters count about as much as one word.
  const unitsOf = (text) => (CJK_RE.test(text) ? Math.ceil(text.length / 2) : 1);

  // Word-timed ASR captions mostly lack punctuation. Each gap is scored by how unusual its pause is for this video
  // (robust z-score) plus punctuation, a capital next and words that can't end a sentence; a sentence ends at the first
  // gap over a threshold that drops as it grows, or at its best gap once it is too long.
  function segmentAsr(tokens) {
    const n = tokens.length;
    // Pause after each word: time to the next one beyond what saying it takes.
    const pauses = tokens.map((tk, i) => (i + 1 < n
      ? Math.max(0, tokens[i + 1].start - tk.start - (CJK_RE.test(tk.text) ? 180 : 60) * tk.text.length) : Infinity));
    const finite = pauses.filter(Number.isFinite).sort((a, b) => a - b);
    const median = finite[finite.length >> 1] || 0;
    const devs = finite.map((p) => Math.abs(p - median)).sort((a, b) => a - b);
    const sigma = Math.max(80, 1.4826 * (devs[devs.length >> 1] || 0));
    const scores = tokens.map((tk, i) => {
      const next = tokens[i + 1];
      if (!next || pauses[i] >= ASR.hardPauseMs || isSoundTag(tk.text) || isSoundTag(next.text)
        || next.text.startsWith('>>')) return Infinity;
      let s = Math.min(6, Math.max(-2, (pauses[i] - median) / sigma)) * 0.6;
      if (END_RE.test(tk.text)) s += 3;
      else if (PAUSE_RE.test(tk.text)) s += 1;
      if (/^\p{Lu}/u.test(next.text) && !/^I\b/.test(next.text)) s += 0.8;
      if (NO_END_RE.test(tk.text)) s -= 1.5;
      return s;
    });
    const sentences = [];
    for (let start = 0, end; start < n; start = end) {
      end = n;
      let size = 0;
      let best = -1;
      for (let i = start; i < n; i++) {
        size += unitsOf(tokens[i].text);
        const s = scores[i];
        const ms = tokens[i].start - tokens[start].start;
        if (s === Infinity || (size >= ASR.minUnits && ms >= 1000 && s >= ASR.threshold - 1.5 * size / ASR.maxUnits)) {
          end = i + 1;
          break;
        }
        if (size >= ASR.minUnits && (best < 0 || s > scores[best])) best = i;
        if (size >= ASR.maxUnits || ms >= ASR.maxMs) {
          end = (best >= 0 ? best : i) + 1;
          break;
        }
      }
      const words = tokens.slice(start, end);
      const text = words.map((w) => w.text).reduce(join).replace(/^>>\s*/, '');
      sentences.push({ start: words[0].start, end: words.at(-1).end, text });
    }
    return sentences;
  }

  function find(list, t) {
    let lo = 0;
    let hi = list.length - 1;
    let hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= t) {
        hit = list[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hit && t < hit.end ? hit : null;
  }

  // Index of the first sentence still on screen or ahead at time t.
  function firstAt(list, t) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].end <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function update() {
    const player = activePlayer();
    const v = player?.querySelector('video');
    const ccOff = player?.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'false';
    if (!v || ccOff || selected?.tlang || isNativeLang(selected?.lang)) {
      hide();
      return;
    }
    const t = v.currentTime * 1000;
    const sentences = sentencesFor(currentVideoId());
    if (sentences) {
      render(player, find(sentences, t));
      pump(sentences, t);
    } else if (selected?.live) {
      updateLive(player);
    } else {
      hide();
    }
  }

  // Live streams have no caption track to fetch: read YouTube's own (hidden) caption lines and translate them once
  // they stop changing for a moment, or every few seconds while they keep growing.
  function updateLive(player) {
    const text = [...player.querySelectorAll('.ytp-caption-segment')].map((n) => n.textContent).join(' ')
      .replace(/\s+/g, ' ').trim();
    const now = Date.now();
    if (text !== live.text) {
      live.text = text;
      live.changedAt = now;
      if (!text) live.tr = '';
    }
    if (text && text !== live.reqText && !live.busy && now >= retryAt
      && (now - live.changedAt >= 600 || now - live.reqAt >= 2500)) translateLive(text);
    render(player, text ? { text, tr: live.tr } : null);
  }

  async function translateLive(text) {
    Object.assign(live, { busy: true, reqText: text, reqAt: Date.now() });
    const gen = targetGen;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts: [text], context: { title: videoTitle() } });
    } catch {
      res = null;
    }
    live.busy = false;
    if (gen !== targetGen) return;
    if (res?.ok) {
      live.tr = res.result[0] || '';
    } else {
      live.reqText = '';
      retryAt = Date.now() + 5000;
    }
  }

  function setTrOnly(value) {
    trOnly = !!value;
    shownKey = null;
    update();
  }

  // Earlier translations were in the old language; they are fetched again as playback reaches them.
  function setTarget(lang) {
    targetBase = baseOf(lang || 'zh-CN');
    targetGen++;
    for (const entry of tracks.values()) {
      for (const sentences of entry.byKey.values()) sentences.forEach((s) => { s.tr = undefined; });
    }
    Object.assign(live, { reqText: '', tr: '' });
    shownKey = null;
    update();
  }

  function setColor(value) {
    trColor = /^#[0-9a-f]{6}$/i.test(value) ? value : '';
    overlay?.style.setProperty('--st-tr-color', trColor || null);
  }

  function setStyle(scale, opacity) {
    fontScale = Math.min(2, Math.max(0.5, Number(scale) || 1));
    bgOpacity = Math.min(1, Math.max(0, Number(opacity ?? 0.75)));
    overlay?.style.setProperty('--st-yt-bg-alpha', bgOpacity);
    fitFont();
  }

  function hide() {
    document.querySelectorAll('.st-yt-on').forEach((p) => p.classList.remove('st-yt-on'));
    if (overlay) overlay.hidden = true;
    shownKey = null;
  }

  function render(player, s) {
    if (!overlay) createOverlay();
    if (overlay.parentElement !== player) {
      hide();
      player.append(overlay);
      resizeObserver.disconnect();
      resizeObserver.observe(player);
      applyPosition();
    }
    player.classList.add('st-yt-on');
    const key = s ? `${s.text}\0${s.tr ?? ''}` : '';
    if (key === shownKey) return;
    shownKey = key;
    const [src, tr] = overlay.querySelectorAll('span');
    src.textContent = s?.text || '';
    tr.textContent = s?.tr || '';
    tr.parentElement.hidden = !s?.tr;
    // In translation-only mode, fall back to the source line until its translation arrives.
    src.parentElement.hidden = trOnly && !!s?.tr;
    overlay.hidden = !s;
  }

  function createOverlay() {
    // Built with nodes: YouTube enforces Trusted Types on innerHTML.
    overlay = document.createElement('div');
    overlay.className = 'st-yt-overlay';
    setColor(trColor);
    overlay.style.setProperty('--st-yt-bg-alpha', bgOpacity);
    for (const cls of ['st-yt-src', 'st-yt-tr']) {
      const line = document.createElement('div');
      line.className = `st-yt-line ${cls}`;
      line.append(document.createElement('span'));
      overlay.append(line);
    }
    overlay.addEventListener('pointerdown', startDrag);
    // Clicks on the subtitles must not reach the player, where they would pause or toggle fullscreen.
    overlay.addEventListener('click', (e) => e.stopPropagation());
    overlay.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      savePosition(undefined);
    });
  }

  const playerKind = () => (overlay?.parentElement?.id === 'shorts-player' ? 'shorts' : 'watch');

  function applyPosition() {
    const pos = positions[playerKind()];
    if (typeof pos === 'number') overlay?.style.setProperty('--st-yt-bottom', `${pos}%`);
    else overlay?.style.removeProperty('--st-yt-bottom');
  }

  function savePosition(pos) {
    positions = { ...positions, [playerKind()]: pos };
    applyPosition();
    chrome.storage.local.set({ ytPos: positions }).catch(() => {});
  }

  // Vertical drag within the player, by mouse or touch; the height is kept as a share of the player so it survives
  // resizing.
  function startDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = overlay.parentElement.getBoundingClientRect();
    const startY = e.clientY;
    const startBottom = rect.bottom - overlay.getBoundingClientRect().bottom;
    const max = Math.max(0, rect.height - overlay.offsetHeight);
    let pos = (startBottom / rect.height) * 100;
    overlay.style.setProperty('--st-yt-bottom', `${pos}%`);
    overlay.classList.add('st-yt-dragging');
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      ev.stopPropagation();
      const bottom = Math.min(max, Math.max(0, startBottom - (ev.clientY - startY)));
      pos = (bottom / rect.height) * 100;
      overlay.style.setProperty('--st-yt-bottom', `${pos}%`);
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.stopPropagation();
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      overlay.classList.remove('st-yt-dragging');
      if (ev.type === 'pointerup' && ev.clientY !== startY) savePosition(Math.round(pos * 10) / 10);
      else applyPosition();
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  }

  // Follows the player size (Shorts are narrow), scaled by the user's setting.
  function fitFont() {
    const player = overlay?.parentElement;
    if (!player) return;
    const base = Math.min(36, Math.max(14, Math.min(player.clientHeight * 0.04, player.clientWidth * 0.045)));
    overlay.style.fontSize = `${base * fontScale}px`;
  }

  // Contiguous untranslated sentences from the playback position on, so each batch reads as a passage. A batch due
  // now may run beside the look-ahead ones, so a seek doesn't wait for them; their results are still kept.
  function pump(sentences, t) {
    if (Date.now() < retryAt) return;
    let i = firstAt(sentences, t);
    while (i < sentences.length && sentences[i].tr !== undefined) i++;
    const first = sentences[i];
    if (!first || first.start >= t + LOOKAHEAD_MS) return;
    const urgent = first.start <= t + 2000;
    // One extra slot for the line due now, so a seek doesn't queue behind requests for the old position.
    if (inflight >= MAX_INFLIGHT + (urgent ? 1 : 0)) return;
    const batch = [];
    for (let j = i; j < sentences.length && batch.length < (urgent ? URGENT_BATCH_SIZE : BATCH_SIZE); j++) {
      if (sentences[j].tr !== undefined || sentences[j].start >= t + LOOKAHEAD_MS) break;
      batch.push(sentences[j]);
    }
    translateBatch(sentences, i, batch);
  }

  async function translateBatch(sentences, i, batch) {
    // null marks a request in flight.
    batch.forEach((s) => { s.tr = null; });
    inflight++;
    const gen = targetGen;
    const end = i + batch.length;
    const texts = batch.map((s) => s.text);
    const context = {
      title: videoTitle(),
      before: sentences.slice(Math.max(0, i - CONTEXT_LINES), i).map((s) => s.text),
      after: sentences.slice(end, end + CONTEXT_LINES).map((s) => s.text),
    };
    const onItem = (k, text) => {
      if (gen !== targetGen || !text || !batch[k]) return;
      batch[k].tr = text;
      update();
    };
    // translateStream comes from utils.js, which loads later (document_idle) than this script.
    const res = typeof translateStream === 'function'
      ? await translateStream(texts, context, onItem)
      : await chrome.runtime.sendMessage({ type: 'translate', texts, context }).catch(() => null);
    inflight--;
    if (gen === targetGen) {
      if (res?.ok) {
        batch.forEach((s, k) => { s.tr = res.result[k] || ''; });
      } else {
        batch.forEach((s) => { s.tr = undefined; });
        retryAt = Date.now() + 5000;
      }
    }
    update();
  }
})();
