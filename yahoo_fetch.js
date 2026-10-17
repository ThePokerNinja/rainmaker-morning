/** Shared Yahoo / RSS fetch with CORS proxy fallbacks (browser morning app). */
(function (global) {
  const FETCH_MS = 14000;
  const RETRY_DELAY_MS = 400;
  const ATTEMPTS_PER_PROXY = 2;
  const MAX_BACKOFF_MS = 8000;
  const RATE_LIMIT_COOLOFF_MS = 60000; // treat as rate-limited for ~1m after a 429

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ---- fetch health (for honest freshness/staleness UI) ---- */
  const health = {
    lastOkAt: 0,
    lastErrAt: 0,
    lastStatus: 0,
    consecutiveFailures: 0,
    rateLimitedUntil: 0,
  };

  function markOk() {
    health.lastOkAt = Date.now();
    health.consecutiveFailures = 0;
    health.lastStatus = 200;
  }

  function markErr(status) {
    health.lastErrAt = Date.now();
    health.consecutiveFailures += 1;
    if (status) health.lastStatus = status;
    if (status === 429) health.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLOFF_MS;
  }

  function getHealth() {
    const now = Date.now();
    return {
      lastOkAt: health.lastOkAt || null,
      lastErrAt: health.lastErrAt || null,
      lastStatus: health.lastStatus || null,
      consecutiveFailures: health.consecutiveFailures,
      rateLimited: now < health.rateLimitedUntil,
      // offline-ish: several misses in a row and nothing fresh recently
      degraded: health.consecutiveFailures >= 3,
      ageMs: health.lastOkAt ? now - health.lastOkAt : null,
    };
  }

  // Exponential backoff with jitter; honors Retry-After and backs off harder on 429.
  function backoffMs(attempt, status, retryAfterSec) {
    if (retryAfterSec) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
    const base = status === 429 || status === 503 ? 1200 : RETRY_DELAY_MS;
    const exp = base * Math.pow(2, attempt);
    const jitter = Math.random() * base * 0.5;
    return Math.min(exp + jitter, MAX_BACKOFF_MS);
  }

  function parseRetryAfter(res) {
    const h = res?.headers?.get?.("retry-after");
    if (!h) return null;
    const secs = Number(h);
    if (Number.isFinite(secs)) return secs;
    const when = Date.parse(h);
    if (Number.isFinite(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
    return null;
  }

  async function fetchRaw(url, opts) {
    const ms = opts?.timeoutMs || FETCH_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: ctrl.signal,
        headers: opts?.headers || {},
      });
      if (!res.ok) {
        const err = new Error("HTTP " + res.status);
        err.status = res.status;
        if (res.status === 429 || res.status === 503) {
          err.retryAfter = parseRetryAfter(res);
        }
        throw err;
      }
      return opts?.asText ? await res.text() : await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function proxyUrls(target) {
    const enc = encodeURIComponent(target);
    return [
      target,
      "https://corsproxy.io/?" + enc,
      "https://corsproxy.io/?url=" + enc,
      "https://api.allorigins.win/raw?url=" + enc,
    ];
  }

  // Try one proxy up to ATTEMPTS_PER_PROXY times with backoff. Returns
  // { data } on success or { err, rotate } telling the caller to move on.
  async function tryProxy(url, opts, asText) {
    let lastErr = null;
    for (let attempt = 0; attempt < ATTEMPTS_PER_PROXY; attempt++) {
      try {
        const data = await fetchRaw(url, { ...opts, asText });
        if (data || asText) return { data };
        return { data: null };
      } catch (e) {
        lastErr = e;
        // A rate-limited / unavailable proxy won't recover on immediate retry —
        // back off and rotate to the next proxy instead of hammering it.
        if (e.status === 429 || e.status === 503) {
          await sleep(backoffMs(attempt, e.status, e.retryAfter));
          return { err: e, rotate: true };
        }
      }
      if (attempt < ATTEMPTS_PER_PROXY - 1) {
        await sleep(backoffMs(attempt, lastErr?.status));
      }
    }
    return { err: lastErr };
  }

  async function fetchJsonViaProxies(target, opts) {
    let lastErr = null;
    const urls = proxyUrls(target);
    const maxProxies = opts?.maxProxies != null ? opts.maxProxies : urls.length;
    for (const url of urls.slice(0, maxProxies)) {
      const r = await tryProxy(url, opts, false);
      if (r.data) {
        markOk();
        return r.data;
      }
      if (r.err) lastErr = r.err;
      if (opts?.maxProxies != null) continue;
      try {
        const wrap = await fetchRaw(
          "https://api.allorigins.win/get?url=" + encodeURIComponent(target),
          { ...opts, asText: false }
        );
        if (wrap?.contents) {
          try {
            const parsed = JSON.parse(wrap.contents);
            markOk();
            return parsed;
          } catch {
            /* continue */
          }
        }
      } catch (e) {
        lastErr = e;
      }
    }
    markErr(lastErr?.status);
    if (lastErr) throw lastErr;
    return null;
  }

  async function fetchTextViaProxies(target, opts) {
    let lastErr = null;
    for (const url of proxyUrls(target)) {
      const r = await tryProxy(url, opts, true);
      if (r.data != null) {
        markOk();
        return r.data;
      }
      if (r.err) lastErr = r.err;
    }
    markErr(lastErr?.status);
    throw lastErr || new Error("Fetch failed");
  }

  function parseChartResult(data) {
    return data?.chart?.result?.[0] || null;
  }

  function barsFromResult(result) {
    if (!result) return null;
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null || Number.isNaN(c)) continue;
      bars.push({
        t: ts[i] * 1000,
        open: q.open?.[i] ?? c,
        high: q.high?.[i] ?? c,
        low: q.low?.[i] ?? c,
        close: c,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return bars.length ? bars : null;
  }

  function periodMs(period) {
    if (!period?.start && !period?.end) return null;
    return {
      startMs: Number(period.start || 0) * 1000,
      endMs: Number(period.end || 0) * 1000,
    };
  }

  function sessionFromState(raw) {
    const stateRaw = String(raw || "").toUpperCase();
    if (stateRaw === "REGULAR") return "regular";
    if (stateRaw === "PRE") return "pre";
    if (stateRaw === "POST") return "post";
    if (stateRaw === "CLOSED") return "closed";
    return stateRaw ? stateRaw.toLowerCase() : "unknown";
  }

  function metaFromChartResult(result) {
    const meta = result?.meta;
    if (!meta) return null;
    const ctp = meta.currentTradingPeriod || {};
    const marketState = sessionFromState(
      meta.marketState || ctp.state || meta.regularMarketState
    );
    return {
      marketState,
      symbol: meta.symbol || null,
      priorClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      exchangeTimezone: meta.exchangeTimezoneName || "America/New_York",
      periods: {
        pre: periodMs(ctp.pre),
        regular: periodMs(ctp.regular),
        post: periodMs(ctp.post),
      },
      at: Date.now(),
    };
  }

  function resolveApiBase() {
    try {
      const meta =
        typeof document !== "undefined" &&
        document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
      if (typeof localStorage !== "undefined") {
        const stored = localStorage.getItem("rainmaker_api_base");
        if (stored) return String(stored).replace(/\/$/, "");
      }
    } catch {
      /* ignore */
    }
    const h = (typeof location !== "undefined" && location.hostname) || "";
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  // Prefer the rm_api backend for chart bars when configured. The server fetches
  // Yahoo directly (no CORS proxy), so this is far more reliable than the public
  // proxy fallbacks below. Returns null when no base is set or the call fails,
  // so callers transparently fall back to the proxy path.
  async function fetchBarsViaApi(symbol, interval, range, includePrePost, opts) {
    const base = resolveApiBase();
    if (!base) return null;
    let url =
      base +
      "/chart/bars?symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" +
      encodeURIComponent(interval || "5m") +
      "&range=" +
      encodeURIComponent(range || "1d") +
      "&prepost=" +
      (includePrePost ? "1" : "0");
    const src = opts?.source;
    if (src && src !== "auto") {
      url += "&source=" + encodeURIComponent(src);
    }
    try {
      const data = await fetchRaw(url, { timeoutMs: 9000, asText: false });
      if (data?.bars?.length) {
        markOk();
        return {
          bars: data.bars,
          meta: { ...(data.meta || {}), source: data.source || data.meta?.source || "api" },
          source: data.source || data.meta?.source || "api",
        };
      }
    } catch {
      /* fall through to proxy path */
    }
    return null;
  }

  async function fetchChartBars(symbol, interval, range, opts) {
    const includePrePost = opts?.includePrePost !== false;
    const viaApi = await fetchBarsViaApi(symbol, interval, range, includePrePost, opts);
    if (viaApi) return viaApi;
    const apiOnly =
      opts?.apiOnly === true ||
      (typeof global !== "undefined" &&
        global.__rmChartBootApiOnly &&
        resolveApiBase());
    if (apiOnly) return null;
    const sym = encodeURIComponent(symbol);
    const iv = encodeURIComponent(interval || "5m");
    const rg = encodeURIComponent(range || "1d");
    const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
    for (const host of hosts) {
      const target =
        "https://" +
        host +
        "/v8/finance/chart/" +
        sym +
        "?interval=" +
        iv +
        "&range=" +
        rg +
        (includePrePost ? "&includePrePost=true" : "");
      try {
        const data = await fetchJsonViaProxies(target);
        const result = parseChartResult(data);
        const bars = barsFromResult(result);
        if (bars) {
          return { bars, meta: metaFromChartResult(result) };
        }
      } catch {
        /* try next host */
      }
    }
    return null;
  }

  async function fetchQuote(symbol, opts) {
    const timeoutMs = opts?.timeoutMs ?? 8000;
    const sym = encodeURIComponent(symbol);
    const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
    const deadline = Date.now() + timeoutMs;
    for (const host of hosts) {
      const remaining = deadline - Date.now();
      if (remaining < 1200) break;
      const target =
        "https://" + host + "/v8/finance/chart/" + sym + "?interval=1d&range=2d";
      try {
        const data = await fetchJsonViaProxies(target, {
          timeoutMs: Math.min(6000, remaining),
          maxProxies: 2,
        });
        const meta = parseChartResult(data)?.meta;
        if (!meta) continue;
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        const stateRaw = String(
          meta.marketState || meta.currentTradingPeriod?.state || ""
        ).toUpperCase();
        let price = meta.regularMarketPrice;
        if (stateRaw === "PRE" && meta.preMarketPrice != null) {
          price = meta.preMarketPrice;
        } else if (stateRaw === "POST" && meta.postMarketPrice != null) {
          price = meta.postMarketPrice;
        }
        let chg = null;
        if (price != null && prev != null && prev !== 0) {
          chg = ((price - prev) / prev) * 100;
        }
        const session = stateRaw
          ? stateRaw === "REGULAR"
            ? "regular"
            : stateRaw === "PRE"
              ? "pre"
              : stateRaw === "POST"
                ? "post"
                : stateRaw === "CLOSED"
                  ? "closed"
                  : stateRaw.toLowerCase()
          : "unknown";
        return { symbol, price, chg, session, prevClose: prev, at: Date.now() };
      } catch {
        /* next */
      }
    }
    return null;
  }

  global.RMYahooFetch = {
    fetchChartBars,
    fetchQuote,
    fetchTextViaProxies,
    fetchJsonViaProxies,
    getHealth,
    backoffMs,
    // test seam: deterministically set/reset fetch health (see test_smoke.mjs)
    __setHealth(partial) {
      if (!partial) {
        health.lastOkAt = Date.now();
        health.lastErrAt = 0;
        health.lastStatus = 200;
        health.consecutiveFailures = 0;
        health.rateLimitedUntil = 0;
      } else {
        Object.assign(health, partial);
      }
      return getHealth();
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
