/**
 * Header background — self-hosted native <video> mood loops with cinematic treatment.
 *
 * Drop encoded loops into assets/header/ and they "just work":
 *   assets/header/bull.mp4      assets/header/bull-mobile.mp4 (optional)   assets/header/bull.webp (poster)
 *   assets/header/neutral.mp4   assets/header/neutral-mobile.mp4           assets/header/neutral.webp
 *   assets/header/bear.mp4      assets/header/bear-mobile.mp4              assets/header/bear.webp
 *
 * Mobile viewports load the *-mobile.mp4 variant when present and fall back to the
 * desktop file. Missing files degrade gracefully to the poster + gradient (never a
 * broken/blank header). Per-tier zoom + alignment + colour grade stay 100% in CSS.
 *
 * Forward-compat: set data-header-video-base on #headerBg (e.g. a CDN / R2 URL) to
 * serve the same filenames from elsewhere without code changes.
 */
(function (global) {
  const DEFAULT_BASE = "assets/header/";
  const MOBILE_MAX = 640;
  const DEFAULT_TREATMENT_ID = "soft-light";
  const REVEAL_DELAY_MS = 400;
  const REVEAL_FALLBACK_MS = 2800;

  function siteHeader() {
    return document.getElementById("siteHeader");
  }

  function headerBgHost() {
    return document.getElementById("headerBg");
  }

  function headerVideoEl() {
    const el = document.getElementById("headerBgPlayer");
    return el && el.tagName === "VIDEO" ? el : null;
  }

  function headerGifEl() {
    return document.getElementById("headerBgGif");
  }

  function headerPosterEl() {
    return document.getElementById("headerBgPoster");
  }

  function prefersReducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  function videoBase() {
    const host = headerBgHost();
    const base = host?.dataset.headerVideoBase;
    if (base) return base.replace(/\/?$/, "/");
    return DEFAULT_BASE;
  }

  function moodFamily(moodId) {
    const m = String(moodId || "neutral");
    if (m === "neutral") return "neutral";
    if (m.startsWith("bear")) return "bear";
    return "bull";
  }

  /** Signed conviction heat from a tier id (neutral=0, bull-2=+2, bear-3=-3). */
  function heatOf(moodId) {
    const m = String(moodId || "neutral");
    if (m === "neutral") return 0;
    const n = parseInt(m.split("-")[1] || "0", 10) || 0;
    return m.startsWith("bear") ? -n : n;
  }

  /** Extended-hours snow clip plays during pre/post when conviction is mild (|heat|<=1).
      Strong moves (|heat|>=2) escalate out to the real bull/bear footage. */
  function isExtendedSession() {
    const s = currentMarketSession();
    return s === "pre" || s === "post";
  }

  function extendedActive(moodId) {
    return isExtendedSession() && Math.abs(heatOf(moodId)) <= 1;
  }

  function resolveBgFamily(moodId) {
    if (extendedActive(moodId)) return "extended";
    return moodFamily(moodId);
  }

  function isMobileViewport() {
    try {
      return !!(global.matchMedia && global.matchMedia(`(max-width:${MOBILE_MAX}px)`).matches);
    } catch (_) {
      return false;
    }
  }

  function sourcesForFamily(fam) {
    const base = videoBase() + fam;
    const desktop = base + ".mp4";
    const mobile = base + "-mobile.mp4";
    return {
      primary: isMobileViewport() ? mobile : desktop,
      desktop,
      poster: base + ".webp",
      gif: base + "-lite.gif",
      preload: videoBase() + "neutral-preload.gif",
    };
  }

  function isMobileStaticMood() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function isWorkspaceBooting() {
    const ws = document.getElementById("morningWorkspace");
    return ws?.classList.contains("morning-workspace--booting");
  }

  /* ---- market session tint (unchanged) ---- */
  function getSessionFromClock() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find((p) => p.type === "weekday")?.value || "";
    if (weekday === "Sat" || weekday === "Sun") return "closed";
    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    const mins = hour * 60 + minute;
    if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
    if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
    if (mins >= 16 * 60 && mins < 20 * 60) return "post";
    return "closed";
  }

  let sessionOverride = null;

  function currentMarketSession() {
    if (sessionOverride) return sessionOverride;
    if (typeof global.RMChartHub !== "undefined" && RMChartHub.currentMarketSession) {
      return RMChartHub.currentMarketSession();
    }
    return getSessionFromClock();
  }

  let sessionTintTimer = null;
  let lastSessionTint = null;

  function applyMarketSessionTint() {
    const header = siteHeader();
    if (!header) return;
    const session = currentMarketSession();
    if (session === lastSessionTint) return;
    lastSessionTint = session;
    header.classList.remove(
      "header-session--pre",
      "header-session--post",
      "header-session--regular",
      "header-session--closed"
    );
    header.classList.add("header-session--" + (session || "closed"));
    header.dataset.marketSession = session;
    /* Session flip can change the extended/snow vs conviction clip — re-run the mood layer. */
    global.RMHeaderMood?.refresh?.();
  }

  function isHeaderFxLite() {
    return document.documentElement.classList.contains("header-fx-lite");
  }

  function startSessionTintWatch() {
    if (isHeaderFxLite()) return;
    applyMarketSessionTint();
    if (sessionTintTimer) return;
    sessionTintTimer = setInterval(applyMarketSessionTint, 60000);
    if (!global._rmHeaderSessionEvt) {
      global._rmHeaderSessionEvt = true;
      document.addEventListener("rm:market-session", applyMarketSessionTint);
    }
  }

  /* ---- sizing ---- */
  function headerVideoSize() {
    const header = siteHeader();
    const w = Math.max(320, header?.clientWidth || 320);
    const headerH = Math.max(80, header?.clientHeight || 0);
    const hByAspect = Math.round((w * 9) / 16);
    const h = Math.max(hByAspect, headerH);
    return { w, h };
  }

  function pinHeaderPlayerEl(el, h) {
    if (!el) return;
    el.classList.add("header-bg-yt-player");
    el.style.width = "100%";
    /* 16:9 box (taller than the band); object-fit:cover fills it, header overflow
       crops, and per-mood CSS anchors top/bottom/center. */
    el.style.height = h + "px";
    el.style.maxWidth = "none";
    /* Alignment + transform are CSS-only per data-mood. */
    el.style.removeProperty("position");
    el.style.removeProperty("top");
    el.style.removeProperty("bottom");
    el.style.removeProperty("left");
    el.style.removeProperty("right");
    el.style.removeProperty("transform");
    el.style.removeProperty("transform-origin");
  }

  function fitHeaderPlayer() {
    const { h } = headerVideoSize();
    const el = headerVideoEl();
    const wrap = el?.closest(".header-bg-yt-wrap");
    pinHeaderPlayerEl(el, h);
    pinHeaderPlayerEl(headerGifEl(), h);
    pinHeaderPlayerEl(headerPosterEl(), h);
    if (wrap) {
      wrap.style.width = "100%";
      wrap.style.height = "100%";
    }
  }

  /* ---- treatment + reveal (unchanged behaviour) ---- */
  function applyDefaultTreatment() {
    const header = siteHeader();
    if (!header) return;
    header.classList.remove(
      "header-treat--clean",
      "header-treat--multiply",
      "header-treat--screen",
      "header-treat--overlay",
      "header-treat--color-dodge",
      "header-treat--hard-light",
      "header-treat--aurora",
      "header-treat--ember",
      "header-treat--noir",
      "header-treat--hologram",
      "header-treat--scanline",
      "header-treat--difference",
      "header-treat--raincore"
    );
    header.classList.add("header-treat--" + DEFAULT_TREATMENT_ID);
    header.dataset.headerTreatment = DEFAULT_TREATMENT_ID;
  }

  function clearRevealState(host) {
    if (!host) return;
    host.classList.remove("is-revealed");
    delete host.dataset.revealed;
    siteHeader()?.classList.remove("header-shade-settling");
    if (host._rmRevealTimer) {
      clearTimeout(host._rmRevealTimer);
      host._rmRevealTimer = null;
    }
    if (host._rmRevealFallback) {
      clearTimeout(host._rmRevealFallback);
      host._rmRevealFallback = null;
    }
  }

  function revealHeaderBg(host) {
    if (!host || host.dataset.revealed === "1") return;
    host.dataset.revealed = "1";
    if (host._rmRevealFallback) {
      clearTimeout(host._rmRevealFallback);
      host._rmRevealFallback = null;
    }
    host._rmRevealTimer = setTimeout(() => {
      host._rmRevealTimer = null;
      host.classList.add("is-revealed");
      siteHeader()?.classList.add("header-shade-settling");
    }, REVEAL_DELAY_MS);
  }

  function scheduleRevealFallback(host) {
    if (!host || host.dataset.revealed === "1" || host._rmRevealFallback) return;
    host._rmRevealFallback = setTimeout(() => {
      host._rmRevealFallback = null;
      revealHeaderBg(host);
    }, REVEAL_FALLBACK_MS);
  }

  function mountClassicHeader(host) {
    if (!host) return;
    clearRevealState(host);
    host.innerHTML = '<div class="header-bg-fx" id="headerBgFx" aria-hidden="true"></div>';
    host.classList.remove("is-active");
    host.dataset.bgMode = "classic";
    const header = siteHeader();
    header?.classList.remove("has-header-video");
    header?.classList.remove("header-shade-settling");
    header?.classList.remove("header-treat--" + DEFAULT_TREATMENT_ID);
    header?.classList.remove(
      "header-session--pre",
      "header-session--post",
      "header-session--regular",
      "header-session--closed"
    );
    delete header?.dataset.marketSession;
    lastSessionTint = null;
  }

  /* ---- playback ---- */
  let videoPausedByApp = false;
  let requestedMediaTier = "full";
  let fpsForcedPoster = false;
  let appliedMediaTier = null;
  let mobilePreloadActive = false;
  let bootPreloadActive = false;

  function effectiveMediaTier() {
    if (document.visibilityState === "hidden" || prefersReducedMotion() || fpsForcedPoster) {
      return "poster";
    }
    if (isMobileStaticMood()) {
      if (mobilePreloadActive || isWorkspaceBooting()) return "preload";
      return "poster";
    }
    if (bootPreloadActive || isWorkspaceBooting()) return "preload";
    return requestedMediaTier;
  }

  function setGifSource(gifEl, src, posterFallback) {
    if (!gifEl) return;
    if (gifEl.dataset.src === src) return;
    gifEl.dataset.src = src;
    gifEl.src = src;
    gifEl.onerror = () => {
      const tier = effectiveMediaTier();
      const neutral = sourcesForFamily("neutral");
      const fallbacks =
        tier === "preload"
          ? [neutral.gif, neutral.poster]
          : posterFallback
            ? [posterFallback]
            : [];
      const next = fallbacks.find((fb) => fb && gifEl.dataset.src !== fb);
      if (next) {
        gifEl.dataset.src = "";
        setGifSource(gifEl, next, posterFallback);
        return;
      }
      gifEl.hidden = true;
      gifEl.classList.remove("is-active");
      if (posterFallback && (tier === "lite" || tier === "preload")) {
        const posterEl = headerPosterEl();
        setPosterSource(posterEl, posterFallback);
        posterEl?.classList.add("is-active");
        posterEl && (posterEl.hidden = false);
      }
    };
  }

  function setPosterSource(posterEl, src) {
    if (!posterEl) return;
    if (posterEl.dataset.src === src) return;
    posterEl.dataset.src = src;
    posterEl.src = src;
  }

  function applyMediaTier() {
    const host = headerBgHost();
    if (!host || host.dataset.bgMode !== "video") return;
    const tier = effectiveMediaTier();
    if (tier === appliedMediaTier) return;
    appliedMediaTier = tier;
    host.dataset.mediaTier = tier;

    const v = headerVideoEl();
    const wrap = v?.closest(".header-bg-yt-wrap");
    const gifEl = headerGifEl();
    const posterEl = headerPosterEl();
    const fam = host.dataset.moodFamily || resolveBgFamily(host.dataset.moodTier || "neutral");
    const src = sourcesForFamily(fam);
    const neutral = sourcesForFamily("neutral");

    wrap?.classList.toggle("is-tier-video-hidden", tier !== "full");
    wrap?.classList.toggle("is-tier-mobile-static", isMobileStaticMood());

    if (tier === "preload") {
      setGifSource(gifEl, src.preload, neutral.poster);
      if (gifEl) gifEl.hidden = false;
      gifEl?.classList.add("is-active");
      posterEl?.classList.remove("is-active");
      if (posterEl) posterEl.hidden = true;
      try {
        v?.pause();
      } catch (_) {}
      revealHeaderBg(host);
    } else if (tier === "lite") {
      gifEl?.classList.toggle("is-active", true);
      posterEl?.classList.toggle("is-active", false);
      setGifSource(gifEl, src.gif, src.poster);
      if (gifEl) gifEl.hidden = false;
      if (posterEl) posterEl.hidden = true;
      try {
        v?.pause();
      } catch (_) {}
    } else if (tier === "poster") {
      setPosterSource(posterEl, src.poster);
      if (posterEl) posterEl.hidden = false;
      posterEl?.classList.add("is-active");
      if (gifEl) {
        gifEl.classList.remove("is-active");
        gifEl.hidden = true;
      }
      try {
        v?.pause();
      } catch (_) {}
      revealHeaderBg(host);
    } else if (!videoPausedByApp && document.visibilityState !== "hidden") {
      gifEl?.classList.remove("is-active");
      posterEl?.classList.remove("is-active");
      playVideoSafe(v);
    }
  }

  function setMediaTier(tier) {
    if (isMobileStaticMood()) {
      if (tier === "preload") {
        mobilePreloadActive = true;
      } else {
        mobilePreloadActive = false;
        requestedMediaTier = "poster";
      }
      appliedMediaTier = null;
      applyMediaTier();
      return;
    }
    if (tier === "preload") {
      bootPreloadActive = true;
      appliedMediaTier = null;
      applyMediaTier();
      return;
    }
    bootPreloadActive = false;
    requestedMediaTier = tier === "lite" || tier === "poster" ? tier : "full";
    applyMediaTier();
  }

  function exitMobilePreload() {
    if (!isMobileStaticMood()) return;
    mobilePreloadActive = false;
    requestedMediaTier = "poster";
    appliedMediaTier = null;
    applyMediaTier();
  }

  function exitBootPreload() {
    if (isMobileStaticMood()) return;
    bootPreloadActive = false;
    requestedMediaTier = "full";
    appliedMediaTier = null;
    applyMediaTier();
  }

  function setFpsForcedPoster(forced) {
    fpsForcedPoster = !!forced;
    applyMediaTier();
  }

  function getMediaTier() {
    return effectiveMediaTier();
  }

  function playVideoSafe(v) {
    if (!v || videoPausedByApp || isMobileStaticMood() || effectiveMediaTier() !== "full") return;
    try {
      v.muted = true;
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  }

  function setVideoPaused(paused) {
    videoPausedByApp = !!paused;
    const v = headerVideoEl();
    if (!v) return;
    if (videoPausedByApp || effectiveMediaTier() !== "full") {
      try {
        v.pause();
      } catch (_) {}
    } else if (document.visibilityState !== "hidden") {
      playVideoSafe(v);
    }
  }

  function setPlaybackRate(rate) {
    if (isMobileStaticMood()) return;
    const v = headerVideoEl();
    if (!v) return;
    try {
      v.playbackRate = rate || 1;
    } catch (_) {}
  }

  function setVideoSource(v, primary, desktopFallback) {
    if (!v) return;
    v.dataset.fallback = desktopFallback || "";
    v.dataset.triedFallback = primary === desktopFallback ? "1" : "";
    v.src = primary;
    try {
      v.load();
    } catch (_) {}
    playVideoSafe(v);
  }

  function bindHeaderResize() {
    if (global._rmHeaderBgResize) return;
    global._rmHeaderBgResize = true;
    global.addEventListener("resize", () => {
      if (!document.querySelector(".header-bg.is-active")) return;
      fitHeaderPlayer();
    });
    /* Swap mobile/desktop variant when crossing the breakpoint. */
    try {
      const mql = global.matchMedia(`(max-width:${MOBILE_MAX}px)`);
      const onChange = () => {
        const host = headerBgHost();
        if (host && host.dataset.bgMode === "video") {
          const v = headerVideoEl();
          if (v) v.dataset.family = "";
          setVideoForMood(host.dataset.moodTier || "neutral");
        }
      };
      if (mql.addEventListener) mql.addEventListener("change", onChange);
      else if (mql.addListener) mql.addListener(onChange);
    } catch (_) {}
  }

  /* ---- mood → clip ---- */
  function currentMoodTier() {
    return (
      document.body?.dataset?.mood ||
      siteHeader()?.dataset?.mood ||
      headerBgHost()?.dataset?.moodTier ||
      "neutral"
    );
  }

  function setVideoForMood(moodId, opts) {
    const host = headerBgHost();
    if (!host) return;
    const tier = moodId || "neutral";
    host.dataset.moodTier = tier;
    if (host.dataset.bgMode !== "video") return;

    const v = headerVideoEl();
    if (!v) return;

    /* opts.family lets the mood layer force the snow clip for the clickable
       ext-bull/ext-bear preview states regardless of the clock. */
    const fam = opts?.family || resolveBgFamily(tier);
    const src = sourcesForFamily(fam);

    if (isMobileStaticMood()) {
      if (host.dataset.moodFamily !== fam) {
        host.dataset.moodFamily = fam;
        v.dataset.family = fam;
        setPosterSource(headerPosterEl(), src.poster);
        appliedMediaTier = null;
      }
      fitHeaderPlayer();
      applyMediaTier();
      return;
    }

    if (v.dataset.family !== fam) {
      v.dataset.family = fam;
      host.dataset.moodFamily = fam;
      v.poster = src.poster;
      setVideoSource(v, src.primary, src.desktop);
      setGifSource(headerGifEl(), src.gif, src.poster);
      setPosterSource(headerPosterEl(), src.poster);
      if (!host.classList.contains("is-revealed")) scheduleRevealFallback(host);
    } else {
      playVideoSafe(v);
    }
    fitHeaderPlayer();
    applyMediaTier();
    global.RMHeaderMood?.applyBgPlayback?.();
  }

  function activateHeaderBg(host) {
    host.classList.add("is-active");
    host.dataset.bgMode = "video";
    siteHeader()?.classList.add("has-header-video");
    applyDefaultTreatment();
    startSessionTintWatch();
  }

  function handleVideoError(v, host) {
    const fb = v.dataset.fallback;
    if (fb && v.dataset.triedFallback !== "1" && (v.currentSrc || v.src) !== fb) {
      v.dataset.triedFallback = "1";
      v.src = fb;
      try {
        v.load();
      } catch (_) {}
      playVideoSafe(v);
      return;
    }
    /* Both variants missing — keep structure (poster + gradient) and reveal so the
       header never sits hidden. Treatment/zoom/alignment CSS still apply. */
    revealHeaderBg(host);
  }

  function createVideo(host) {
    const fx = host.querySelector(".header-bg-fx");
    clearRevealState(host);
    host.innerHTML = "";
    if (fx) host.appendChild(fx);

    const wrap = document.createElement("div");
    wrap.className = "header-bg-yt-wrap";

    const v = document.createElement("video");
    v.id = "headerBgPlayer";
    v.className = "header-bg-yt-mount header-bg-yt-player";
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute("muted", "");
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.preload = "auto";
    v.tabIndex = -1;
    v.setAttribute("aria-hidden", "true");
    try {
      v.disablePictureInPicture = true;
    } catch (_) {}

    v.addEventListener("playing", () => {
      wrap.classList.add("is-ready");
      revealHeaderBg(host);
      global.RMHeaderMood?.applyBgPlayback?.();
    });
    v.addEventListener("canplay", () => {
      wrap.classList.add("is-ready");
      revealHeaderBg(host);
    });
    v.addEventListener("loadeddata", () => playVideoSafe(v));
    v.addEventListener("error", () => handleVideoError(v, host));
    v.addEventListener("stalled", () => playVideoSafe(v));

    wrap.appendChild(v);

    const gif = document.createElement("img");
    gif.id = "headerBgGif";
    gif.className = "header-bg-gif header-bg-yt-player";
    gif.alt = "";
    gif.hidden = true;
    gif.setAttribute("aria-hidden", "true");
    wrap.appendChild(gif);

    const poster = document.createElement("img");
    poster.id = "headerBgPoster";
    poster.className = "header-bg-poster header-bg-yt-player";
    poster.alt = "";
    poster.hidden = true;
    poster.setAttribute("aria-hidden", "true");
    wrap.appendChild(poster);

    host.insertBefore(wrap, host.firstChild);

    activateHeaderBg(host);
    host.dataset.mounted = "1";

    fitHeaderPlayer();
    bindHeaderResize();
    scheduleRevealFallback(host);

    /* Initial clip for the current mood. */
    const v0 = headerVideoEl();
    if (v0) v0.dataset.family = "";
    if (isMobileStaticMood()) {
      mobilePreloadActive = isWorkspaceBooting();
      requestedMediaTier = "poster";
    }
    setVideoForMood(currentMoodTier());
  }

  function mount(host) {
    if (!host || host.dataset.mounted === "1") return;
    host.dataset.mounted = "1";
    host.dataset.moodTier = currentMoodTier();
    createVideo(host);
  }

  function init() {
    startSessionTintWatch();
    mount(headerBgHost());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.RMHeaderBg = {
    init,
    mount,
    mountClassicHeader,
    fitHeaderPlayer,
    setVideoForMood,
    setVideoPaused,
    setMediaTier,
    setFpsForcedPoster,
    getMediaTier,
    exitMobilePreload,
    exitBootPreload,
    isMobileStaticMood,
    setPlaybackRate,
    moodFamily,
    resolveBgFamily,
    extendedActive,
    applyMarketSessionTint,
    currentMarketSession,
    __setSessionOverride(s) {
      sessionOverride = s || null;
      applyMarketSessionTint();
    },
    DEFAULT_TREATMENT_ID,
  };
})(typeof window !== "undefined" ? window : globalThis);
