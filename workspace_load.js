/** Staggered workspace boot — column + element loaders, top-to-bottom. */
(function (global) {
  const COLUMN_ORDER = ["market", "chart", "scans"];

  const COLS = {
    market: { id: "workspaceMarket", title: "Market map", index: 1 },
    chart: { id: "workspaceChart", title: "Unified chart", index: 2 },
    scans: { id: "workspaceScans", title: "Scan picks", index: 3 },
  };

  let booting = false;
  let activeColumn = null;
  let slotTotal = 0;
  let slotDone = 0;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function panel(key) {
    return document.getElementById(COLS[key]?.id);
  }

  function columnOrder() {
    return COLUMN_ORDER.slice();
  }

  function previousColumn(key) {
    const i = COLUMN_ORDER.indexOf(key);
    return i > 0 ? COLUMN_ORDER[i - 1] : null;
  }

  function mountColumnWaitLoader(key) {
    const el = panel(key);
    if (!el || el.classList.contains("ws-panel--ready") || el.classList.contains("ws-panel--active")) {
      return;
    }
    const body = el.querySelector(".ws-panel-body");
    if (!body) return;
    let loader = body.querySelector(".ws-col-loader");
    if (!loader) {
      loader = document.createElement("div");
      loader.className = "ws-col-loader";
      body.appendChild(loader);
    }
    const meta = COLS[key];
    const prev = previousColumn(key);
    const mobileLite = isMobilePerfLoader();
    loader.innerHTML = loaderShell({
      title: meta.title,
      step: mobileLite
        ? "Column " + meta.index + " — preparing…"
        : prev
          ? "Waiting for " + COLS[prev].title + "…"
          : "Queued…",
      kicker: "Column " + meta.index + " of 3",
      pct: mobileLite ? 4 : 0,
    });
  }

  function clearColumnWaitLoader(key) {
    panel(key)?.querySelector(".ws-col-loader")?.remove();
  }

  function scanProgressPanelHtml() {
    return (
      '<div class="ws-scan-progress scan-progress scan-progress--panel" aria-live="polite">' +
      '<p class="scan-progress-label ws-scan-progress-label">Starting scan…</p>' +
      '<div class="scan-progress-track ws-scan-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
      '<div class="scan-progress-fill ws-scan-progress-fill"></div></div>' +
      '<div class="scan-progress-segments ws-scan-progress-segments"></div></div>'
    );
  }

  function isMobilePerfLoader() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function loaderShell(opts) {
    const size = opts.size === "mini" ? "mini" : "column";
    if (isMobilePerfLoader() && size === "column") {
      const kicker = opts.kicker || "Rainmaker — initializing";
      const pct = opts.pct != null ? opts.pct : 8;
      return (
        '<div class="ws-load-shell ws-load-shell--mobile-lite" role="status" aria-live="polite" aria-busy="true">' +
        '<p class="ws-load-kicker">' +
        escapeHtml(kicker) +
        "</p>" +
        '<p class="ws-load-title">' +
        escapeHtml(opts.title || "Loading") +
        "</p>" +
        '<p class="ws-load-step">' +
        escapeHtml(opts.step || "Starting…") +
        "</p>" +
        '<div class="ws-load-track" aria-hidden="true"><span class="ws-load-track-fill" style="width:' +
        pct +
        '%"></span></div></div>'
      );
    }
    const cls = "ws-load-shell" + (size === "mini" ? " ws-load-shell--mini" : "");
    const kicker =
      opts.kicker ||
      (size === "mini" ? "Loading" : "Rainmaker — initializing");
    const showMeta = size === "column";
    const scanProgress = showMeta && opts.scanProgress;
    return (
      '<div class="' +
      cls +
      '" role="status" aria-live="polite" aria-busy="true">' +
      '<div class="ws-load-grid" aria-hidden="true"></div>' +
      '<div class="ws-load-orbit" aria-hidden="true"><span></span><span></span></div>' +
      '<div class="ws-load-scanline" aria-hidden="true"></div>' +
      (showMeta
        ? '<p class="ws-load-kicker">' + escapeHtml(kicker) + "</p>"
        : "") +
      '<p class="ws-load-title">' +
      escapeHtml(opts.title || "Loading") +
      "</p>" +
      '<p class="ws-load-step">' +
      escapeHtml(opts.step || "Starting…") +
      "</p>" +
      (scanProgress ? scanProgressPanelHtml() : "") +
      (showMeta
        ? '<div class="ws-load-track" aria-hidden="true"><span class="ws-load-track-fill" style="width:' +
          (opts.pct != null ? opts.pct : 8) +
          '%"></span></div>' +
          '<div class="ws-load-dots" aria-hidden="true"><span></span><span></span><span></span></div>'
        : "") +
      "</div>"
    );
  }

  function mountMiniLoader(el, label, step) {
    if (!el) return;
    el.classList.add("ws-load-slot", "ws-load-slot--loading");
    el.classList.remove("ws-load-slot--ready");
    el.innerHTML = loaderShell({
      size: "mini",
      title: label,
      step: step || "Loading…",
    });
  }

  function revealSlot(el) {
    if (!el) return;
    el.classList.remove("ws-load-slot--loading");
    el.classList.add("ws-load-slot--ready");
  }

  function ensureColumnLoader(body) {
    let loader = body.querySelector(":scope > .ws-col-loader");
    if (!loader) {
      loader = document.createElement("div");
      loader.className = "ws-col-loader";
      body.appendChild(loader);
    }
    return loader;
  }

  function updateColumnLoader(key, label, pct) {
    const el = panel(key);
    if (!el) return;
    const stepEl = el.querySelector(".ws-col-loader .ws-load-step");
    const fill = el.querySelector(".ws-col-loader .ws-load-track-fill");
    if (stepEl && label) stepEl.textContent = label;
    if (fill && pct != null) {
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }
  }

  function beginColumn(key) {
    activeColumn = key;
    if (key === "market") setMarketNavLoading(true);
    slotTotal = 0;
    slotDone = 0;
    const el = panel(key);
    if (!el) return;
    clearColumnWaitLoader(key);
    const meta = COLS[key];
    el.classList.remove("ws-panel--ready", "ws-panel--failed");
    el.classList.add("ws-panel--loading", "ws-panel--queued");
    const body = el.querySelector(".ws-panel-body");
    if (!body) return;

    body.querySelector(".ws-col-progress")?.remove();
    const loader = ensureColumnLoader(body);
    loader.innerHTML = loaderShell({
      title: meta.title,
      step: "Column " + meta.index + " — preparing…",
      kicker: "Column " + meta.index + " of 3",
      pct: 4,
    });
    loader.classList.remove("ws-col-loader--out");

    requestAnimationFrame(() => {
      el.classList.remove("ws-panel--queued");
      el.classList.add("ws-panel--active");
    });
  }

  function endColumn(key) {
    const el = panel(key);
    if (!el) return;
    if (key === "market") setMarketNavLoading(false);
    updateColumnLoader(key, "Ready", 100);
    const loader = el.querySelector(".ws-col-loader");
    if (loader) {
      loader.classList.add("ws-col-loader--out");
      setTimeout(() => loader.remove(), 420);
    }
    el.querySelector(".ws-col-progress")?.remove();
    el.classList.remove("ws-panel--loading", "ws-panel--active");
    el.classList.add("ws-panel--ready");
    activeColumn = null;
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.onColumnReady(key);
    }
  }

  function failColumn(key, msg) {
    const el = panel(key);
    if (!el) return;
    if (key === "market") setMarketNavLoading(false);
    updateColumnLoader(key, msg || "Offline — refresh to retry", 100);
    el.classList.remove("ws-panel--loading", "ws-panel--active");
    el.classList.add("ws-panel--failed");
    setTimeout(() => {
      el.querySelector(".ws-col-loader")?.remove();
      el.querySelector(".ws-col-progress")?.remove();
    }, 1200);
    activeColumn = null;
  }

  function refreshMobileHeaderLayout() {
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.sync?.();
    }
    global.RMBrandLogo?.onHeaderLayout?.();
    global.RMHeaderMood?.refresh?.();
  }

  function setMarketNavLoading(on) {
    global.RMWorkspaceAccordion?.setRowNavLoading?.("market", on);
  }

  function init() {
    booting = true;
    setMarketNavLoading(true);
    const ws = document.getElementById("morningWorkspace");
    if (ws) ws.classList.add("morning-workspace--booting");
    COLUMN_ORDER.forEach((key, i) => {
      const el = panel(key);
      if (el) el.style.setProperty("--ws-boot-i", String(i));
    });
    const queueCols =
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
        ? COLUMN_ORDER.filter((k) => k !== "market")
        : COLUMN_ORDER;
    queueCols.forEach((key) => mountColumnWaitLoader(key));
    void fetchMorningBrief();
    void hydrateTradeStory();
    document.addEventListener("rm:auth-ready", function () {
      morningBrief = null;
      void fetchMorningBrief();
    });
    requestAnimationFrame(() => {
      global.RMHeaderBg?.setMediaTier?.("preload");
      global.RMHeaderMood?.pausePoll?.();
      refreshMobileHeaderLayout();
    });
  }

  async function hydrateTradeStory() {
    if (typeof global.RMTradeStory === "undefined") return null;
    try {
      return await global.RMTradeStory.hydrateToday();
    } catch (_) {
      return null;
    }
  }

  function finish() {
    booting = false;
    setMarketNavLoading(false);
    const ws = document.getElementById("morningWorkspace");
    if (ws) {
      ws.classList.remove("morning-workspace--booting");
      ws.classList.add("morning-workspace--ready");
    }
    COLUMN_ORDER.forEach((key) => {
      const el = panel(key);
      if (!el) return;
      if (el.classList.contains("ws-panel--ready")) {
        el.classList.remove("ws-panel--queued", "ws-panel--loading", "ws-panel--active");
      }
    });
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.sync?.();
    }
    requestAnimationFrame(() => refreshMobileHeaderLayout());
  }

  function pause(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function loadSlot(el, label, fn) {
    if (!el) return;
    slotTotal += 1;
    const pct = slotTotal > 1 ? (slotDone / slotTotal) * 100 : 8;
    if (activeColumn) {
      updateColumnLoader(activeColumn, label + "…", Math.max(8, pct));
    }
    mountMiniLoader(el, label);
    try {
      await fn(el);
    } finally {
      revealSlot(el);
    }
    slotDone += 1;
    if (activeColumn) {
      const donePct = (slotDone / Math.max(slotDone, slotTotal)) * 100;
      updateColumnLoader(activeColumn, label + " ?", donePct);
    }
  }

  async function runColumn(key, runner) {
    beginColumn(key);
    try {
      await runner((el, label, fn) => loadSlot(el, label, fn));
      endColumn(key);
    } catch (e) {
      failColumn(key, e?.message || "Load failed");
      throw e;
    }
  }

  function showPanelLoader(key, opts) {
    const el = panel(key);
    const body = el?.querySelector(".ws-panel-body");
    if (!body) return;
    body.querySelector(".ws-col-progress")?.remove();
    const loader = ensureColumnLoader(body);
    const meta = COLS[key] || {};
    const mobile = global.matchMedia("(max-width: 640px)").matches;
    loader.innerHTML = loaderShell({
      title: opts?.title || meta.title || "Loading",
      step: opts?.step || "Loading…",
      kicker: opts?.kicker || "Rainmaker scan",
      pct: opts?.pct != null ? opts.pct : 14,
      scanProgress: mobile && opts?.scanProgress !== false,
    });
    loader.classList.remove("ws-col-loader--out");
    el.classList.add("ws-panel--scan-loading");
  }

  function hidePanelLoader(key) {
    const el = panel(key);
    if (!el) return;
    const loader = el.querySelector(".ws-col-loader");
    if (loader) {
      loader.classList.add("ws-col-loader--out");
      setTimeout(() => loader.remove(), 420);
    }
    el.classList.remove("ws-panel--scan-loading");
  }

  function isBooting() {
    return booting;
  }

  let morningBrief = null;

  function resolveApiBase() {
    try {
      if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveApiBase) {
        return global.RMMorningApi.resolveApiBase();
      }
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content) return meta.content.trim().replace(/\/$/, "");
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (_) {}
    const h = global.location && global.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (global.RMAuthGate && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (_) {}
    return headers;
  }

  async function fetchResearchDigest() {
    const base = resolveApiBase();
    if (!base) return [];
    try {
      const res = await fetch(base + "/research/digest?limit=5", { headers: authHeaders() });
      if (!res.ok) return [];
      const data = await res.json();
      return data.research_digest || [];
    } catch (_) {
      return [];
    }
  }

  async function fetchMorningBrief() {
    if (morningBrief) return morningBrief;
    const apiBase =
      typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveApiBase
        ? global.RMMorningApi.resolveApiBase()
        : "";
    if (apiBase) {
      try {
        const res = await fetch(apiBase + "/research/morning-brief?v=" + Date.now(), {
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.brief && typeof data.brief === "object") {
            morningBrief = data.brief;
          }
        }
      } catch (_) {
        /* fall through to static file */
      }
    }
    if (!morningBrief) {
      try {
        const res = await fetch("/morning_brief.json?v=" + Date.now());
        if (res.ok) {
          morningBrief = await res.json();
        }
      } catch (_) {
        /* stub optional */
      }
    }
    if (!morningBrief) morningBrief = {};
    const digest = await fetchResearchDigest();
    if (digest.length) {
      morningBrief.research_digest = digest;
    }
    if (typeof global.RMColumnKPI !== "undefined") {
      global.RMColumnKPI.setMorningBriefLoaded(true);
    }
    document.dispatchEvent(new CustomEvent("rm:morning-brief", { detail: morningBrief }));
    if (morningBrief.war_plan && typeof global.RMAtlas !== "undefined") {
      void global.RMAtlas.onMorningBrief(morningBrief);
    }
    if (digest.length) {
      document.dispatchEvent(new CustomEvent("rm:research-digest", { detail: digest }));
    }
    return morningBrief;
  }

  function getMorningBrief() {
    return morningBrief;
  }

  global.RMWorkspaceLoad = {
    init,
    finish,
    pause,
    columnOrder,
    runColumn,
    loadSlot,
    mountMiniLoader,
    revealSlot,
    loaderShell,
    mountColumnWaitLoader,
    clearColumnWaitLoader,
    updateColumnLoader,
    showPanelLoader,
    hidePanelLoader,
    beginColumn,
    endColumn,
    failColumn,
    isBooting,
    fetchMorningBrief,
    getMorningBrief,
    hydrateTradeStory,
  };
})(typeof window !== "undefined" ? window : globalThis);
