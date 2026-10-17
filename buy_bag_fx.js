/** Money-bag sway + coin burst + cashier ching on click (not hover).
 *  Sound: assets/cashier-drawer-ching.mp3 from https://www.youtube.com/watch?v=4kVTqUxJYBA
 */
(function (global) {
  function cashierSrc() {
    try {
      const scripts = document.getElementsByTagName("script");
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].src;
        if (src && /buy_bag_fx\.js/i.test(src)) {
          return new URL("assets/cashier-drawer-ching.mp3", src).href;
        }
      }
    } catch {
      /* use relative fallback */
    }
    return "assets/cashier-drawer-ching.mp3";
  }

  const CASHIER_SRC = cashierSrc();
  // Skip the leading silence in the clip so the "ching" fires the instant the
  // bag is clicked instead of a beat later (item 15).
  const CASHIER_TRIM = 0.1;
  let audioCtx = null;
  let cashierClip = null;
  let cashierLoad = null;
  let htmlAudioEl = null;

  function getAudioCtx() {
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  /** Fallback drawer "ching" — bell + register clunk. */
  function playCashierSynth() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.16, t0);
    master.connect(ctx.destination);

    const bell = ctx.createOscillator();
    const bellG = ctx.createGain();
    bell.type = "sine";
    bell.frequency.setValueAtTime(2480, t0);
    bell.frequency.exponentialRampToValueAtTime(1980, t0 + 0.12);
    bellG.gain.setValueAtTime(0.0001, t0);
    bellG.gain.exponentialRampToValueAtTime(0.9, t0 + 0.008);
    bellG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    bell.connect(bellG);
    bellG.connect(master);
    bell.start(t0);
    bell.stop(t0 + 0.24);

    const clunk = ctx.createOscillator();
    const clunkG = ctx.createGain();
    clunk.type = "triangle";
    clunk.frequency.setValueAtTime(420, t0 + 0.05);
    clunk.frequency.exponentialRampToValueAtTime(180, t0 + 0.18);
    clunkG.gain.setValueAtTime(0.0001, t0 + 0.05);
    clunkG.gain.exponentialRampToValueAtTime(0.35, t0 + 0.06);
    clunkG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    clunk.connect(clunkG);
    clunkG.connect(master);
    clunk.start(t0 + 0.05);
    clunk.stop(t0 + 0.22);
  }

  function loadCashierClip() {
    if (cashierLoad) return cashierLoad;
    const ctx = getAudioCtx();
    if (!ctx) return Promise.resolve(null);
    cashierLoad = fetch(CASHIER_SRC)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("fetch"))))
      .then((buf) => ctx.decodeAudioData(buf))
      .then((clip) => {
        cashierClip = clip;
        return clip;
      })
      .catch(() => null);
    return cashierLoad;
  }

  function playCashierFromClip() {
    const ctx = getAudioCtx();
    if (!ctx || !cashierClip) return false;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = cashierClip;
    gain.gain.value = 0.62;
    src.connect(gain);
    gain.connect(ctx.destination);
    const offset = Math.min(CASHIER_TRIM, (cashierClip.duration || 0) * 0.5);
    src.start(0, offset);
    return true;
  }

  // One reused, preloaded <audio> so the fallback path doesn't pay decode/network
  // latency on each click.
  function getHtmlAudio() {
    if (!htmlAudioEl) {
      htmlAudioEl = new Audio(CASHIER_SRC);
      htmlAudioEl.preload = "auto";
      htmlAudioEl.volume = 0.62;
    }
    return htmlAudioEl;
  }

  function playCashierHtmlAudio() {
    try {
      const a = getHtmlAudio();
      try {
        a.currentTime = CASHIER_TRIM;
      } catch (_) {
        /* currentTime may not be settable until metadata loads */
      }
      const p = a.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => playCashierSynth());
      }
      return true;
    } catch {
      return false;
    }
  }

  function playCashier() {
    if (global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    if (cashierClip && playCashierFromClip()) return;
    if (cashierLoad) {
      cashierLoad.then((clip) => {
        if (clip && playCashierFromClip()) return;
        playCashierHtmlAudio();
      });
      return;
    }
    loadCashierClip().then((clip) => {
      if (clip && playCashierFromClip()) return;
      playCashierHtmlAudio();
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        loadCashierClip();
        getHtmlAudio(); // warm the fallback element so its first play is instant
      },
      { once: true }
    );
    // Browsers block audio until a user gesture; resume the context + decode on
    // the first interaction so the very first bag click already has sound ready.
    const warm = () => {
      getAudioCtx();
      loadCashierClip();
    };
    document.addEventListener("pointerdown", warm, { once: true, capture: true });
  }

  function animate(el) {
    if (!el?.classList?.contains("ca-buy-bag")) return;
    const now = Date.now();
    if (el._bagFxAt && now - el._bagFxAt < 100) return;
    el._bagFxAt = now;
    el.classList.remove("ca-buy-bag--jingle");
    void el.getBoundingClientRect();
    el.classList.add("ca-buy-bag--jingle");
    clearTimeout(el._bagFxEnd);
    el._bagFxEnd = setTimeout(() => el.classList.remove("ca-buy-bag--jingle"), 720);
  }

  function pulse(el) {
    animate(el);
    playCashier();
  }

  global.RMBuyBagFx = { animate, pulse, playCashier, loadCashierClip };
})(typeof window !== "undefined" ? window : globalThis);
