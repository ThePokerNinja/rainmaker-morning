/**
 * API-base guard — runs before every other Morning module.
 *
 * Public-surface rule: on a public origin, no URL / hash / storage value may
 * choose the network destination. Morning modules read
 * `meta[name="rainmaker-api-base"]` and `localStorage.rainmaker_api_base`;
 * both are developer conveniences for localhost. Off localhost we pin them to
 * the allowlist so a poisoned storage key or a tampered meta tag cannot route
 * the owner JWT or scan data to a foreign host.
 *
 * Exposes `RMApiBaseGuard.isAllowed(url)` for tests and future readers.
 */
(function (global) {
  "use strict";

  const PROD_API = "https://rainmaker-api-waqs.onrender.com";
  const STORAGE_KEY = "rainmaker_api_base";
  const META_NAME = "rainmaker-api-base";
  const ALLOWED = [/^https:\/\/rainmaker-api(-[a-z0-9]+)?\.onrender\.com$/i];

  function hostname() {
    try {
      return String((global.location && global.location.hostname) || "").toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function isLocalHost() {
    const h = hostname();
    return h === "localhost" || h === "127.0.0.1" || h === "";
  }

  function normalize(url) {
    return String(url || "")
      .trim()
      .replace(/\/+$/, "");
  }

  function isAllowed(url) {
    const u = normalize(url);
    if (!u) return false;
    if (u === PROD_API) return true;
    return ALLOWED.some((re) => re.test(u));
  }

  function enforce() {
    if (isLocalHost()) return { enforced: false };
    const result = { enforced: true, storageCleared: false, metaReset: false };
    try {
      const stored = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (stored && !isAllowed(stored)) {
        global.localStorage.removeItem(STORAGE_KEY);
        result.storageCleared = true;
        if (global.console && global.console.warn) {
          global.console.warn("[rm] dropped rainmaker_api_base override on public origin");
        }
      }
    } catch (_) {
      /* storage unavailable */
    }
    try {
      const meta = global.document && global.document.querySelector('meta[name="' + META_NAME + '"]');
      if (meta && meta.content && !isAllowed(meta.content)) {
        meta.content = PROD_API;
        result.metaReset = true;
      }
    } catch (_) {
      /* no DOM */
    }
    return result;
  }

  const outcome = enforce();

  global.RMApiBaseGuard = {
    PROD_API: PROD_API,
    isAllowed: isAllowed,
    enforce: enforce,
    outcome: outcome,
  };
})(typeof window !== "undefined" ? window : globalThis);
