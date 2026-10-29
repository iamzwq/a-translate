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

  // The selected track isn't visible from the isolated world; report it whenever it changes.
  let lastTrack = '';
  setInterval(() => {
    const player = document.querySelector('video.html5-main-video')?.closest('.html5-video-player');
    let track = null;
    try { track = player?.getOption?.('captions', 'track') || null; } catch { /* player not ready */ }
    const s = JSON.stringify(track && {
      lang: track.languageCode || '',
      kind: track.kind || '',
      tlang: track.translationLanguage?.languageCode || '',
    });
    if (s === lastTrack) return;
    lastTrack = s;
    window.postMessage({ source: 'st-yt-track', track: s }, location.origin);
  }, 1000);
})();
