/**
 * Lazy-load optional script bundles (learning, broker, agent).
 */
(function (global) {
  const CACHE_BUST = "10";
  const loaded = {};

  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  function ensureLearning() {
    return loadScript("morning.learning.js?v=" + CACHE_BUST);
  }

  function ensureBroker() {
    return loadScript("morning.broker.js?v=" + CACHE_BUST);
  }

  function ensureAgent() {
    return ensureLearning().then(() => {
      if (typeof global.RMAgent !== "undefined" && global.RMAgent.mount) {
        global.RMAgent.mount();
      }
    });
  }

  function preloadNonCritical() {
    if (typeof global.RMMobilePerf === "undefined" || !global.RMMobilePerf.isMobilePerf()) {
      return;
    }
    const run = () => {
      void ensureLearning().catch(() => {});
    };
    if (typeof global.requestIdleCallback === "function") {
      global.requestIdleCallback(run, { timeout: 4000 });
    } else {
      global.setTimeout(run, 2000);
    }
  }

  global.RMChunkLoader = {
    loadScript,
    ensureLearning,
    ensureBroker,
    ensureAgent,
    preloadNonCritical,
  };
})(typeof window !== "undefined" ? window : globalThis);
