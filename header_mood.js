/**
 * Header "Conviction Engine" — fuses Morning Pulse bias + chart setups + news-validated
 * scans into a single mood (heat -3..+3) that themes the header and the three panels.
 *
 * Boot: neutral → auto when workspace finishes loading.
 * Header background: click left/right of logo to step bear◄►bull; boot → auto.
 */
(function (global) {
  const POLL_MS = 4000;

  const TIERS = [
    {
      id: "bear-3",
      heat: -3,
      kicker: "Risk-off",
      line: "Every read says step back — pulse, charts and tape all against you.",
    },
    {
      id: "bear-2",
      heat: -2,
      kicker: "Defense up",
      line: "Pressure's building and the setups aren't paying today.",
    },
    {
      id: "bear-1",
      heat: -1,
      kicker: "Caution",
      line: "A bearish tilt is forming — keep size light.",
    },
    {
      id: "neutral",
      heat: 0,
      kicker: "Undecided",
      line: "Mixed signals. The tape hasn't picked a side yet.",
    },
    {
      id: "bull-1",
      heat: 1,
      kicker: "Warming up",
      line: "A bullish lean is forming — watch for confirmation.",
    },
    {
      id: "bull-2",
      heat: 2,
      kicker: "In your favour",
      line: "Pulse and setups agree — momentum is with you.",
    },
    {
      id: "bull-3",
      heat: 3,
      kicker: "Fully aligned",
      line: "Confirmed top to bottom — pulse, charts and news all agree.",
    },
  ];

  const BY_ID = Object.fromEntries(TIERS.map((t) => [t.id, t]));

  /** Preview ramp: center → bull +3 → bear -3 (one step per click). */
  const PREVIEW_RAMP = [
    "neutral",
    "bull-1",
    "bull-2",
    "bull-3",
    "bear-1",
    "bear-2",
    "bear-3",
  ];

  /** Clickable preview-only extended-hours treatments that flank neutral.
      Render as the snow clip with a mild lean (reuses bull-1 / bear-1 grade + copy). */
  const EXT_PREVIEW = {
    "ext-bull": { base: "bull-1", lean: "bull" },
    "ext-bear": { base: "bear-1", lean: "bear" },
  };

  /** Left→right thermometer for click-to-navigate. Extended (snow) treatments sit
      between neutral and the first conviction tier on each side. */
  const HEAT_AXIS = [
    "bear-3",
    "bear-2",
    "bear-1",
    "ext-bear",
    "neutral",
    "ext-bull",
    "bull-1",
    "bull-2",
    "bull-3",
  ];

  /** Extended-hours (pre/post) copy. Snow clip is a "varying neutral": mild lean only
      (heat -1/0/+1). Keyed by session then signed heat. Strong moves escalate to bull/bear. */
  const EXTENDED_COPY = {
    pre: {
      "1": { kicker: "Pre-market bid", line: "Early buyers are leaning in ahead of the open." },
      "0": { kicker: "Pre-market", line: "Futures are trading — the regular session hasn't opened yet." },
      "-1": { kicker: "Pre-market risk", line: "Sellers are pressing pre-open — keep size light into the bell." },
    },
    post: {
      "1": { kicker: "After-hours bid", line: "Buyers are carrying strength into the evening tape." },
      "0": { kicker: "After-hours", line: "Regular session's closed — extended tape is thin." },
      "-1": { kicker: "After-hours risk", line: "Late selling pressure — protect the day's gains." },
    },
  };

  /** Preview-only speed: ±1 + ±2 normal (CSS handles ±2 zoom), ±3 double-speed. Auto/neutral stay 1×. */
  const BG_PLAYBACK = {
    "bull-2": 1,
    "bull-3": 2,
    "bear-2": 1,
    "bear-3": 2,
  };

  let previewMode = "neutral";
  let rampDir = 1;
  let userHasPreviewed = false;
  let bootObserver = null;
  let currentTierId = "neutral";
  let pollTimer = null;

  function siteHeader() {
    return document.getElementById("siteHeader");
  }

  function isWorkspaceBooting() {
    return !!document
      .getElementById("morningWorkspace")
      ?.classList.contains("morning-workspace--booting");
  }

  function tierFromRaw(raw) {
    if (raw == null || Number.isNaN(raw)) return "neutral";
    if (raw >= 0.5) return "bull-3";
    if (raw >= 0.28) return "bull-2";
    if (raw >= 0.1) return "bull-1";
    if (raw <= -0.5) return "bear-3";
    if (raw <= -0.28) return "bear-2";
    if (raw <= -0.1) return "bear-1";
    return "neutral";
  }

  let lastKpi = null;

  function autoRaw() {
    // Preferred path: consume the explicit per-column KPI contract so the
    // header heat and the green-light charge share one source of truth.
    if (typeof global.RMColumnKPI !== "undefined") {
      const kpi = global.RMColumnKPI.compute();
      lastKpi = kpi;
      if (kpi) return kpi.raw;
    }

    // Fallback (KPI module absent): legacy DOM-count blend.
    lastKpi = null;
    let raw = 0;
    let have = false;

    const bias = global.RMMarket?.getLastMorningBias?.();
    if (bias?.market?.score != null && !Number.isNaN(bias.market.score)) {
      raw += bias.market.score * 0.6;
      have = true;
    }

    const picks = document.querySelectorAll(".pick-row").length;
    if (picks && bias?.h001?.score != null && !Number.isNaN(bias.h001.score)) {
      raw += bias.h001.score * 0.4;
      have = true;
    }

    const setups = document.querySelectorAll(
      ".ca-buy-bag, .chart-hub-unified .ca-entry, [data-trade-marker]"
    ).length;
    if (setups && raw !== 0) {
      raw += Math.sign(raw) * Math.min(0.15, setups * 0.03);
      have = true;
    }

    if (!have) return null;

    const newsValidated =
      !!document.querySelector(".pick-row .pick-news-ok, .pick-row[data-news='ok']") ||
      !!global.RMHeaderMood?._newsValidated;
    if (picks) raw *= newsValidated ? 1.3 : 1.12;

    return Math.max(-1, Math.min(1, raw));
  }

  function resolveTierId() {
    if (previewMode !== "auto") return previewMode;
    return tierFromRaw(autoRaw());
  }

  function renderCopy(tier, extendedSession) {
    const el = document.getElementById("headerMoodCopy");
    if (!el) return;
    const heat = tier.heat;
    let kicker = tier.kicker;
    let line = tier.line;
    if (extendedSession) {
      const ext = EXTENDED_COPY[extendedSession]?.[String(heat)];
      if (ext) {
        kicker = ext.kicker;
        line = ext.line;
      }
    }
    if (previewMode === "auto" && lastKpi?.stage) {
      const stageLabel = String(lastKpi.stage).replace(/^\w/, (c) => c.toUpperCase());
      kicker = stageLabel + " · " + kicker;
    }
    const pips = [-3, -2, -1, 1, 2, 3].map((slot) => {
      const side = slot < 0 ? "bear" : "bull";
      const on =
        (heat > 0 && slot > 0 && slot <= heat) ||
        (heat < 0 && slot < 0 && slot >= heat);
      return '<i class="hm-pip hm-pip--' + side + (on ? " is-on" : "") + '"></i>';
    });
    pips.splice(3, 0, '<i class="hm-core' + (heat === 0 ? " is-on" : "") + '"></i>');

    el.innerHTML =
      '<p class="hm-kicker">' +
      kicker +
      "</p>" +
      '<span class="hm-gauge" aria-hidden="true">' +
      pips.join("") +
      "</span>" +
      '<p class="hm-line">' +
      line +
      "</p>";
    el.setAttribute(
      "aria-label",
      "Market conviction: " + kicker + ". " + line
    );
  }

  const PANEL = {
    c1: ".ws-panel--market",
    c2: ".ws-panel--chart",
    c3: ".ws-panel--scans",
  };

  /** Remove Trade Story column/header chrome (not approved for live UI). */
  function clearTradeStoryChrome() {
    document.querySelectorAll(".ws-col-conf, .hm-readiness").forEach((el) => el.remove());
  }

  // Strip the legacy green-light dot if an older render left one behind.
  function removeLegacyDot(panelSel) {
    const dot = document.querySelector(panelSel + " .col-greenlight");
    if (dot) dot.remove();
  }

  // Remove the old "0/3 lit" charge meter if a previous build rendered it.
  function clearChargeMeter() {
    const copy = document.getElementById("headerMoodCopy");
    const meter = copy?.querySelector(".hm-charge");
    if (meter) meter.remove();
  }

  function applyChargeState() {
    const kpi = lastKpi;
    const header = siteHeader();
    const charge = kpi ? kpi.charge : 0;
    if (header) {
      header.dataset.charge = String(charge);
      header.classList.toggle("is-fully-charged", charge >= 3);
    }
    document.body.dataset.charge = String(charge);
    document.body.classList.toggle("is-fully-charged", charge >= 3);
    clearTradeStoryChrome();
    removeLegacyDot(PANEL.c1);
    removeLegacyDot(PANEL.c2);
    removeLegacyDot(PANEL.c3);
    clearChargeMeter();
  }

  function playbackRateForTier(tierId) {
    if (previewMode === "auto" || tierId === "neutral") return 1;
    return BG_PLAYBACK[tierId] ?? 1;
  }

  function setYtPlaybackRate(rate) {
    try {
      global.RMHeaderBg?.setPlaybackRate?.(rate);
    } catch (_) {}
  }

  let playbackApplyToken = 0;

  function isMobileStaticMood() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function applyBgPlaybackForTier(tierId) {
    if (isMobileStaticMood()) return;
    const rate = playbackRateForTier(tierId);
    const token = ++playbackApplyToken;
    const apply = () => {
      if (token !== playbackApplyToken) return;
      setYtPlaybackRate(rate);
    };
    apply();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(apply);
    }
    setTimeout(apply, 400);
  }

  function applyBgPlayback() {
    applyBgPlaybackForTier(currentTierId);
  }

  function applyTier(tierId) {
    const header = siteHeader();
    const extPreview = EXT_PREVIEW[tierId];
    const tier = BY_ID[extPreview ? extPreview.base : tierId] || BY_ID.neutral;
    currentTierId = tierId;

    /* Extended snow shows when explicitly previewed (ext-bull/ext-bear) OR, in
       auto/live mode, when the clock is pre/post and conviction is mild. */
    const extended =
      !!extPreview || global.RMHeaderBg?.resolveBgFamily?.(tier.id) === "extended";
    let extendedSession = null;
    if (extended) {
      const s = global.RMHeaderBg?.currentMarketSession?.();
      extendedSession = s === "post" ? "post" : "pre";
    }

    if (header) {
      header.dataset.mood = tier.id;
      header.dataset.moodHeat = String(tier.heat);
      header.classList.toggle("header-bg-extended", extended);
      if (extended) header.dataset.extendedSession = extendedSession;
      else delete header.dataset.extendedSession;
    }
    document.body.dataset.mood = tier.id;
    document.body.dataset.moodHeat = String(tier.heat);
    renderCopy(tier, extendedSession);
    applyChargeState();
    if (typeof global.RMHeaderBg !== "undefined") {
      global.RMHeaderBg.setVideoForMood(tier.id, extended ? { family: "extended" } : undefined);
      global.RMHeaderBg.fitHeaderPlayer?.();
    }
    applyBgPlaybackForTier(tier.id);
  }

  function refresh() {
    applyTier(resolveTierId());
  }

  function enterAutoFromBoot() {
    if (userHasPreviewed) return;
    if (previewMode !== "neutral") return;
    previewMode = "auto";
    rampDir = 1;

    const resumeHeaderMedia = () => {
      resumePoll();
      refresh();
      if (isMobileStaticMood()) {
        global.RMHeaderBg?.exitMobilePreload?.();
        global.dispatchEvent(new CustomEvent("rm:mobile-mood-resolved"));
      } else {
        global.RMHeaderBg?.exitBootPreload?.();
      }
      global.syncBackgroundActivity?.();
      if (typeof global.RMMetrics !== "undefined") {
        const base = EXT_PREVIEW[currentTierId]?.base || currentTierId;
        global.RMMetrics.markVerdictView({
          tier: currentTierId,
          heat: BY_ID[base]?.heat ?? 0,
          mode: "auto",
        });
      }
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(resumeHeaderMedia, { timeout: 450 });
    } else {
      setTimeout(resumeHeaderMedia, 400);
    }
  }

  function watchBootToAuto() {
    const ws = document.getElementById("morningWorkspace");
    if (!ws) {
      setTimeout(enterAutoFromBoot, 1200);
      return;
    }
    if (!ws.classList.contains("morning-workspace--booting")) {
      enterAutoFromBoot();
      return;
    }
    if (bootObserver) return;
    bootObserver = new MutationObserver(() => {
      if (!ws.classList.contains("morning-workspace--booting")) {
        bootObserver.disconnect();
        bootObserver = null;
        enterAutoFromBoot();
      }
    });
    bootObserver.observe(ws, { attributes: true, attributeFilter: ["class"] });
  }

  function setPreview(tierIdOrNull) {
    if (tierIdOrNull && (BY_ID[tierIdOrNull] || EXT_PREVIEW[tierIdOrNull])) {
      userHasPreviewed = true;
      previewMode = tierIdOrNull;
      const idx = PREVIEW_RAMP.indexOf(tierIdOrNull);
      if (idx >= 0) {
        rampDir = idx >= PREVIEW_RAMP.length - 1 ? -1 : 1;
      }
    } else {
      previewMode = "auto";
      rampDir = 1;
    }
    refresh();
  }

  /** Current spot on the bear◄►bull ladder (auto → wherever live signals resolve). */
  function currentAxisIndex() {
    const id = previewMode === "auto" ? resolveTierId() : previewMode;
    const idx = HEAT_AXIS.indexOf(id);
    return idx < 0 ? HEAT_AXIS.indexOf("neutral") : idx;
  }

  /** Step one tier toward bull (dir > 0) or bear (dir < 0), clamped at the ends. */
  function stepMood(dir) {
    if (!dir) return;
    const idx = currentAxisIndex();
    const next = Math.max(
      0,
      Math.min(HEAT_AXIS.length - 1, idx + (dir > 0 ? 1 : -1))
    );
    if (next === idx && previewMode !== "auto") return;
    setPreview(HEAT_AXIS[next]);
  }

  /** Click in the header background: right of the logo = hotter, left = cooler. */
  function onHeaderZoneClick(e) {
    if (e.target.closest("button, a, input, select, textarea, [role='button']")) {
      return;
    }
    const header = siteHeader();
    if (!header) return;
    const logo =
      document.getElementById("brandLogoStack") || header.querySelector(".brand");
    let centerX;
    if (logo) {
      const r = logo.getBoundingClientRect();
      centerX = r.left + r.width / 2;
    } else {
      const hr = header.getBoundingClientRect();
      centerX = hr.left + hr.width / 2;
    }
    stepMood(e.clientX >= centerX ? 1 : -1);
  }

  function pausePoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function resumePoll() {
    if (pollTimer || document.visibilityState === "hidden") return;
    pollTimer = setInterval(refresh, POLL_MS);
  }

  function mount() {
    const header = siteHeader();
    if (header && !header.dataset.zoneBound) {
      header.dataset.zoneBound = "1";
      header.classList.add("header-mood-zones");
      header.addEventListener("click", onHeaderZoneClick);
    }
    applyTier("neutral");
    watchBootToAuto();
    if (isWorkspaceBooting()) pausePoll();
    else resumePoll();
    if (!global._rmMoodEvt) {
      global._rmMoodEvt = true;
      document.addEventListener("rm:market-session", refresh);
      document.addEventListener("rm:trade-closed", refresh);
      document.addEventListener("rm:trade-story", refresh);
      document.addEventListener("rm:morning-brief", refresh);
    }
  }

  function init() {
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.RMHeaderMood = {
    init,
    mount,
    refresh,
    pausePoll,
    resumePoll,
    applyBgPlayback,
    setPreview,
    stepMood,
    get _pollTimer() {
      return pollTimer;
    },
    getState: () => {
      const ext = EXT_PREVIEW[currentTierId];
      const baseId = ext ? ext.base : currentTierId;
      return {
        previewMode,
        tier: currentTierId,
        heat: BY_ID[baseId]?.heat ?? 0,
        rampDir,
        charge: lastKpi ? lastKpi.charge : 0,
        storyReadiness: lastKpi?.storyReadiness ?? null,
        stage: lastKpi?.stage ?? null,
        kpi: lastKpi,
      };
    },
    TIERS,
    PREVIEW_RAMP,
  };
})(typeof window !== "undefined" ? window : globalThis);
