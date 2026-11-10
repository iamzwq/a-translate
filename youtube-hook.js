// Runs in the page's MAIN world: copies the player's own caption responses (they carry the POT token we can't forge).
(() => {
  if (window.__stYoutubeHook) return;
  window.__stYoutubeHook = true;

  const isCaption = (url) => typeof url === 'string' && url.includes('/api/timedtext');
  const post = (url, text) => {
    if (typeof text === 'string' && text) window.postMessage({ source: 'st-yt-captions', url, text }, location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.call(this, input, init);
    try {
      const url = input instanceof Request ? input.url : String(input);
      if (isCaption(url) && res.ok) res.clone().text().then((t) => post(url, t), () => {});
    } catch { /* never break the page's fetch */ }
    return res;
  };

  const { open, send } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__stUrl = String(url);
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isCaption(this.__stUrl)) {
      this.addEventListener('load', () => {
        if (this.status !== 200) return;
        const type = this.responseType;
        if (type === '' || type === 'text') post(this.__stUrl, this.responseText);
        else if (type === 'json') post(this.__stUrl, JSON.stringify(this.response));
      });
    }
    return send.apply(this, args);
  };

  // Shorts share one player; thumbnails' hover previews have players of their own that must not be followed.
  const activePlayer = () => (location.pathname.startsWith('/shorts/')
    ? document.querySelector('#shorts-player')
    : document.querySelector('#movie_player')
      || document.querySelector('.html5-video-player:not(#inline-preview-player)'));
  const call = (player, name, ...args) => {
    try { return player?.[name]?.(...args); } catch { return undefined; }
  };

  // Video id -> attempts at switching its captions on; Infinity once on (or given up), so turning them off by hand sticks.
  const autoTries = new Map();
  const MAX_AUTO_TRIES = 3;
  function autoEnableCaptions(player, videoId) {
    if (!videoId || !/^\/(?:watch|shorts\/|embed\/|live\/)/.test(location.pathname)) return;
    const tries = autoTries.get(videoId) || 0;
    if (tries > MAX_AUTO_TRIES || player.classList.contains('ad-showing')) return;
    const response = call(player, 'getPlayerResponse');
    // The response can still be the previous video's right after navigating.
    if (response?.videoDetails?.videoId !== videoId) return;
    const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return;
    const button = player.querySelector('.ytp-subtitles-button');
    const on = button ? button.getAttribute('aria-pressed') === 'true'
      : !!call(player, 'getOption', 'captions', 'track')?.languageCode;
    if (on || tries === MAX_AUTO_TRIES) {
      autoTries.set(videoId, Infinity);
      return;
    }
    autoTries.set(videoId, tries + 1);
    // Selecting a track affects this video only; the CC button may also flip YouTube's saved caption preference,
    // so it is the last resort.
    if (tries < MAX_AUTO_TRIES - 1) {
      const track = tracks.find((t) => t.kind !== 'asr') || tracks[0];
      call(player, 'loadModule', 'captions');
      call(player, 'setOption', 'captions', 'track', { languageCode: track.languageCode, kind: track.kind });
    } else if (typeof player.toggleSubtitles === 'function') {
      call(player, 'toggleSubtitles');
    } else {
      button?.click();
    }
  }

  // The selected track isn't visible from the isolated world; report it whenever it changes.
  let lastTrack = '';
  setInterval(() => {
    const player = activePlayer();
    if (!player) return;
    const data = call(player, 'getVideoData');
    if (document.documentElement.dataset.stAutoCc === '1') autoEnableCaptions(player, data?.video_id);
    const track = call(player, 'getOption', 'captions', 'track');
    const s = JSON.stringify(track?.languageCode ? {
      lang: track.languageCode,
      kind: track.kind || '',
      tlang: track.translationLanguage?.languageCode || '',
      live: !!(data?.isLive || call(player, 'getPlayerResponse')?.videoDetails?.isLive),
    } : null);
    if (s === lastTrack) return;
    lastTrack = s;
    window.postMessage({ source: 'st-yt-track', track: s }, location.origin);
  }, 1000);
})();
