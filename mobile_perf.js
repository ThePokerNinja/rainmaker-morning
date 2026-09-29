/**
 * Mobile performance profile - row warm state, idle preload, shared breakpoint gate.
 */
(function (global) {
  const MOBILE_MAX = 640;
  const ROW_KEYS = ["market", "chart", "scans"];

  const rowWarm = { chart: false, scans: false };
  const rowWarming = { chart: false, scans: false };
  let warmChain = Promise.resolve();

  function isMobilePerf() {
    try {
      return !!global.matchMedia("(max-width: " + MOBILE_MAX + "px)").matches;
    } catch (_) {
      return false;
    }
  }

  function isNativeShell() {
    return (
      document.documentElement.classList.contains("is-native-app") ||
      (global.Capacitor &&
        global.Capacitor.isNativePlatform &&
        global.Capacitor.isNativePlatform())
    );
  }

  function applyMobileDefaults() {
    if (!isMobilePerf()) return;
    if (!isNativeShell()) {
      document.documentElement.classList.add("header-fx-lite");
    }
    document.documentElement.classList.add("mobile-perf-active");
    document.documentElement.classList.add("mobile-static-mood");
  }

  function isRowWarm(key) {
    return !!rowWarm[key];
  }

  function markRowWarm(key) {
    if (!ROW_KEYS.includes(key) || key === "market") return;
    rowWarm[key] = true;
    rowWarming[key] = false;
    global.dispatchEvent(
      new CustomEvent("rm:row-warm", { detail: { key, warm: rowWarm } })
    );
    updateBumperReadyHint();
  }

  function updateBumperReadyHint() {
    const down = document.getElementById("btnSnapBumperDown");
    if (!down || !isMobilePerf()) return;
    const acc = global.RMWorkspaceAccordion;
    const active = acc?.getActiveKey?.() || "market";
    const next =
      active === "market" ? "chart" : active === "chart" ? "scans" : null;
    down.classList.remove("snap-bumper--row-ready");
  }

  function scheduleIdle(fn, timeoutMs) {
    const run = () => {
      try {
        fn();
      } catch (e) {
        console.warn("[RMMobilePerf] idle task", e);
      }
    };
    if (typeof global.requestIdleCallback === "function") {
      global.requestIdleCallback(run, { timeout: timeoutMs || 2500 });
    } else {
      global.setTimeout(run, 0);
    }
  }

  function withWarmPanel(key, fn) {
    const row = ROWS_PANEL[key];
    const panel = row ? document.getElementById(row) : null;
    if (!panel) return fn();
    const activeKey =
      typeof global.RMWorkspaceAccordion !== "undefined"
        ? global.RMWorkspaceAccordion.getActiveKey?.()
        : null;
    const hideWhileWarm = activeKey !== key;
    if (hideWhileWarm) panel.classList.add("ws-panel--warm-pending");
    return Promise.resolve()
      .then(fn)
      .finally(() => panel.classList.remove("ws-panel--warm-pending"));
  }

  const ROWS_PANEL = {
    chart: "workspaceChart",
    scans: "workspaceScans",
  };

  function warmRow(key) {
    if (!isMobilePerf() || !ROW_KEYS.includes(key) || key === "market") {
      return Promise.resolve(false);
    }
    if (rowWarm[key] || rowWarming[key]) {
      return Promise.resolve(rowWarm[key]);
    }
    rowWarming[key] = true;

    const task = () =>
      withWarmPanel(key, async () => {
        const hooks = global._rmMobileWarmHooks;
        if (!hooks) {
          rowWarming[key] = false;
          return false;
        }
        if (key === "chart" && hooks.warmChart) {
          await hooks.warmChart();
          markRowWarm("chart");
          return true;
        }
        if (key === "scans" && hooks.warmScans) {
          await hooks.warmScans();
          markRowWarm("scans");
          return true;
        }
        rowWarming[key] = false;
        return false;
      });

    warmChain = warmChain.then(task, task);
    return warmChain;
  }

  function warmAfterMarket() {
    if (!isMobilePerf()) return;
    scheduleIdle(() => {
      warmRow("chart").then(() => scheduleIdle(() => warmRow("scans"), 1200));
    }, 800);
  }

  function registerWarmHooks(hooks) {
    global._rmMobileWarmHooks = { ...(global._rmMobileWarmHooks || {}), ...hooks };
  }

  function resetRowWarm() {
    rowWarm.chart = false;
    rowWarm.scans = false;
    rowWarming.chart = false;
    rowWarming.scans = false;
    updateBumperReadyHint();
  }

  applyMobileDefaults();

  global.addEventListener("rm:workspace-row", () => updateBumperReadyHint());
  document.addEventListener("visibilitychange", updateBumperReadyHint);

  global.RMMobilePerf = {
    isMobilePerf,
    applyMobileDefaults,
    isRowWarm,
    markRowWarm,
    warmRow,
    warmAfterMarket,
    registerWarmHooks,
    resetRowWarm,
    get rowWarm() {
      return { ...rowWarm };
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
