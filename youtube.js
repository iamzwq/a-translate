// Bilingual YouTube subtitles: captured json3 track -> sentences -> look-ahead translation -> overlay on the player.
(() => {
  if (window.__stYoutubeLoaded) return;
  window.__stYoutubeLoaded = true;

  const LOOKAHEAD_MS = 60000;
  const BATCH_SIZE = 20;
  const MAX_TRACKS = 5;
  const END_RE = /[.!?。！？…]["'”’)\]]*$/;
  const PAUSE_RE = /[,，、;；:：]$/;
  const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/;

  // videoId -> { latest, byKey: Map(`lang|kind` -> sentences) } of every caption track the player loaded.
  const tracks = new Map();
  // Track selected in the player ({ lang, kind, tlang }), polled by youtube-hook.js; null if unknown.
  let selected = null;
  let video = null;
  let overlay = null;
  let shown = null;
  let shownTr = null;
  let pumping = false;
  let retryAt = 0;
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
      if (!e.target.matches?.('video.html5-main-video')) return;
      video = e.target;
      update();
    }, true);
  }
  document.addEventListener('yt-navigate-finish', () => update());

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
    // YouTube's own auto-translation or a Chinese track: leave the native captions alone.
    if (params.get('tlang') || isNativeLang(params.get('lang'))) {
      entry.latest = null;
      update();
      return;
    }
    entry.latest = key;
    if (!entry.byKey.has(key)) {
      let data;
      try { data = JSON.parse(text); } catch { return; }
      const sentences = segment(data.events || []);
      if (!sentences.length) return;
      entry.byKey.set(key, sentences);
    }
    update();
  }

  function isNativeLang(lang) {
    return /^zh/i.test(lang || '');
  }

  // Prefer the player's selected track: switching back from YouTube's translation may reuse its cache without a request.
  function sentencesFor(videoId) {
    const entry = tracks.get(videoId);
    if (!entry) return null;
    if (selected?.tlang || isNativeLang(selected?.lang)) return null;
    return entry.byKey.get(`${selected?.lang}|${selected?.kind}`) || entry.byKey.get(entry.latest) || null;
  }

  function currentVideoId() {
    return new URLSearchParams(location.search).get('v')
      || location.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1];
  }

  // Flatten events into timed tokens: whole cues for uploaded captions, single words for ASR.
  function tokensOf(events) {
    const tokens = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const start = ev.tStartMs || 0;
      const end = start + (ev.dDurationMs || 0);
      ev.segs.forEach((seg, i) => {
        const text = (seg.utf8 || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        const next = ev.segs[i + 1]?.tOffsetMs;
        tokens.push({ text, start: start + (seg.tOffsetMs || 0), end: next != null ? start + next : end });
      });
    }
    return tokens.sort((a, b) => a.start - b.start);
  }

  function join(a, b) {
    return CJK_RE.test(a.at(-1)) && CJK_RE.test(b[0]) ? a + b : `${a} ${b}`;
  }

  // Rule-based sentence breaks: end punctuation, pauses over 1s, sound tags, and length / duration caps.
  function segment(events) {
    const sentences = [];
    let cur = null;
    for (const tk of tokensOf(events)) {
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
    // Close short gaps so lines don't blink, and remove overlaps so lookup by time is unambiguous.
    sentences.forEach((s, i) => {
      const next = sentences[i + 1];
      if (next && next.start > s.start && next.start - s.end < 1000) s.end = next.start;
    });
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

  function update() {
    const v = video?.isConnected ? video : document.querySelector('video.html5-main-video');
    const player = v?.closest('.html5-video-player');
    const sentences = sentencesFor(currentVideoId());
    const ccButton = player?.querySelector('.ytp-subtitles-button');
    if (!player || !sentences || ccButton?.getAttribute('aria-pressed') === 'false') {
      hide();
      return;
    }
    const t = v.currentTime * 1000;
    render(player, find(sentences, t));
    pump(sentences, t);
  }

  function hide() {
    document.querySelectorAll('.st-yt-on').forEach((p) => p.classList.remove('st-yt-on'));
    if (overlay) overlay.hidden = true;
    shown = null;
  }

  function render(player, s) {
    if (!overlay) {
      // Built with nodes: YouTube enforces Trusted Types on innerHTML.
      overlay = document.createElement('div');
      overlay.className = 'st-yt-overlay';
      for (const cls of ['st-yt-src', 'st-yt-tr']) {
        const line = document.createElement('div');
        line.className = `st-yt-line ${cls}`;
        line.append(document.createElement('span'));
        overlay.append(line);
      }
    }
    if (overlay.parentElement !== player) {
      hide();
      player.append(overlay);
      resizeObserver.disconnect();
      resizeObserver.observe(player);
    }
    player.classList.add('st-yt-on');
    if (s === shown && s?.tr === shownTr) return;
    shown = s;
    shownTr = s?.tr;
    const [src, tr] = overlay.querySelectorAll('span');
    src.textContent = s?.text || '';
    tr.textContent = s?.tr || '';
    tr.parentElement.hidden = !s?.tr;
    overlay.hidden = !s;
  }

  function fitFont() {
    const player = overlay?.parentElement;
    if (player) overlay.style.fontSize = `${Math.min(36, Math.max(14, player.clientHeight * 0.04))}px`;
  }

  // One request in flight, nearest untranslated sentences first.
  async function pump(sentences, t) {
    if (pumping || Date.now() < retryAt) return;
    const batch = sentences
      .filter((s) => s.tr === undefined && s.end > t - 1000 && s.start < t + LOOKAHEAD_MS)
      .slice(0, BATCH_SIZE);
    if (!batch.length) return;
    pumping = true;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts: batch.map((s) => s.text) });
    } catch {
      res = null;
    }
    pumping = false;
    if (res?.ok) batch.forEach((s, i) => { s.tr = res.result[i] || ''; });
    else retryAt = Date.now() + 5000;
    update();
  }
})();
