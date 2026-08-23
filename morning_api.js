/**
 * Shared Rainmaker API base resolution.
 * Schwab OAuth is registered on prod only — localhost review uses prod for broker routes.
 */
(function (global) {
  "use strict";

  const PROD_API = "https://rainmaker-api-waqs.onrender.com";
  const LOCAL_API = "http://127.0.0.1:8765";
  const BROKER_CACHE_KEY = "rainmaker_broker_api_v1";

  function isLocalHost() {
    const h = (global.location && global.location.hostname) || "";
    return h === "localhost" || h === "127.0.0.1";
  }

  function explicitBase() {
    try {
      const meta = global.document && global.document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content && meta.content.trim()) {
        return meta.content.trim().replace(/\/$/, "");
      }
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (e) {}
    return "";
  }

  /** Chart/scan/general — prefer local on localhost. */
  function resolveApiBase() {
    const ex = explicitBase();
    if (ex) return ex;
    if (isLocalHost()) return LOCAL_API;
    if (global.RMAuthGate && global.RMAuthGate.getApiBase) {
      return global.RMAuthGate.getApiBase() || PROD_API;
    }
    return PROD_API;
  }

  /** Schwab OAuth + sync — prod on localhost (callback + secrets on Render). */
  function resolveBrokerApiBase() {
    const ex = explicitBase();
    if (ex) return ex;
    if (isLocalHost()) {
      try {
        const cached = global.sessionStorage && global.sessionStorage.getItem(BROKER_CACHE_KEY);
        if (cached === PROD_API || cached === LOCAL_API) return cached;
      } catch (e) {}
      return PROD_API;
    }
    return resolveApiBase();
  }

  async function probeBrokerApiBase() {
    const ex = explicitBase();
    if (ex) return ex;
    if (!isLocalHost()) return resolveApiBase();
    try {
      const localRes = await fetch(LOCAL_API + "/schwab/status", { method: "GET" });
      if (localRes.ok) {
        const body = await localRes.json();
        if (body && body.configured) {
          global.sessionStorage.setItem(BROKER_CACHE_KEY, LOCAL_API);
          return LOCAL_API;
        }
      }
    } catch (e) {}
    global.sessionStorage.setItem(BROKER_CACHE_KEY, PROD_API);
    return PROD_API;
  }

  function todayPt() {
    try {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  global.RMMorningApi = {
    PROD_API,
    LOCAL_API,
    resolveApiBase,
    resolveBrokerApiBase,
    probeBrokerApiBase,
    todayPt,
    isLocalHost,
  };
})(typeof window !== "undefined" ? window : this);
