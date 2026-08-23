/** H-001 market scan — mirrors thinkorswim/scanners/MorningMomentumScanner.ts */
(function (global) {
  const SCREENS = ["day_gainers", "most_actives", "small_cap_gainers"];
  /** Per-request cap; proxies are slow — 8s fails fast vs hanging the UI */
  const FETCH_MS = 8000;
  const DEFAULT_MIN_SCORE = 50;
  const MAX_PER_SCREEN = 80;
  const CHART_BATCH_SIZE = 12;

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchViaProxies(targetUrl) {
    const encoded = encodeURIComponent(targetUrl);
    const urls = [
      "https://api.allorigins.win/raw?url=" + encoded,
      "https://corsproxy.io/?" + encoded,
    ];
    for (const proxyUrl of urls) {
      const data = await fetchJson(proxyUrl);
      if (data) return data;
    }
    return null;
  }

  async function fetchScreenerQuotes(scrId) {
    const target =
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=" +
      MAX_PER_SCREEN +
      "&scrIds=" +
      encodeURIComponent(scrId);
    const data = await fetchViaProxies(target);
    const quotes = data?.finance?.result?.[0]?.quotes;
    return Array.isArray(quotes) ? quotes : [];
  }

  async function fetchChartMetrics(symbol) {
    const target =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=1d&range=1mo";
    const data = await fetchViaProxies(target);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta || {};
    const q = result.indicators?.quote?.[0] || {};
    const vols = (q.volume || []).filter((v) => v != null && v > 0);
    const avgVol30 = vols.length
      ? vols.reduce((a, b) => a + b, 0) / vols.length
      : null;
    const closes = q.close || [];
    const opens = q.open || [];
    const priorClose =
      meta.chartPreviousClose ||
      meta.previousClose ||
      (closes.length > 1 ? closes[closes.length - 2] : null);
    const openToday = opens.length ? opens[opens.length - 1] : meta.regularMarketPrice;
    return {
      priorClose,
      open: openToday,
      avgVol30,
    };
  }

  async function fetchFloatShares(symbol) {
    const target =
      "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" +
      encodeURIComponent(symbol) +
      "?modules=defaultKeyStatistics";
    const data = await fetchViaProxies(target);
    const stats =
      data?.quoteSummary?.result?.[0]?.defaultKeyStatistics ||
      data?.quoteSummary?.result?.[0]?.summaryDetail;
    const f = stats?.floatShares?.raw ?? stats?.sharesOutstanding?.raw;
    return f != null ? Number(f) : null;
  }

  function normalizeChangePct(raw) {
    if (raw == null || raw === "") return null;
    const v = Number(raw);
    if (Number.isNaN(v)) return null;
    return Math.abs(v) <= 1.5 ? v * 100 : v;
  }

  /** Gap-up % only (open above prior close). Gap-down returns null. */
  function gapUpPct(m) {
    const prior = m.priorClose;
    const open = m.open;
    if (prior == null || prior <= 0 || open == null || open <= prior) return null;
    return ((open - prior) / prior) * 100;
  }

  function isGapDown(m) {
    const prior = m.priorClose;
    const open = m.open ?? m.price;
    if (prior == null || prior <= 0 || open == null) return false;
    return open < prior;
  }

  /**
   * Skip Yahoo chart/float calls when screener fields cannot reach minScore
   * (optimistic upper bound — real score may still fail after chart).
   */
  function passesH001Prefilter(m, cfg) {
    const minScore = cfg.minScore ?? DEFAULT_MIN_SCORE;
    const w = cfg.weights || {};
    const priceMin = cfg.priceMin ?? 1;
    const priceMax = cfg.priceMax ?? 20;
    const moveMin = cfg.movePctMin ?? 8;
    const dailyMin = cfg.dailyPctMin ?? 10;
    const gapMin = cfg.gapPctMin ?? 3;

    const price = m.price;
    if (price == null || price < priceMin || price > priceMax) return false;
    if (isGapDown(m)) return false;

    let upper = 0;
    if (cfg.applyFloatPoints) upper += w.float || 0;
    upper += w.price || 0;

    const dailyPct = normalizeChangePct(m.changePct);
    const gapPct = gapUpPct(m);

    if (dailyPct != null && dailyPct < 0) return false;

    if (dailyPct != null) {
      if (dailyPct >= moveMin) upper += w.move || 0;
      if (dailyPct >= dailyMin) upper += w.daily || 0;
    }

    const newsViaGap = gapPct != null && gapPct >= gapMin;
    const newsViaVolProxy = dailyPct != null && dailyPct >= 5;
    if (newsViaGap || newsViaVolProxy) upper += w.news || 0;

    if (upper < minScore) return false;

    if (dailyPct != null && dailyPct < moveMin && !newsViaGap && dailyPct < 5) {
      const withoutVolNews =
        (cfg.applyFloatPoints ? w.float || 0 : 0) + (w.price || 0);
      if (withoutVolNews < minScore) return false;
    }

    return true;
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  /** Sliding credit: 0 below floor, ramps to 1 at threshold, small bonus above. */
  function gradAbove(value, threshold, floorRatio) {
    if (value == null || threshold == null || threshold <= 0) return 0;
    const floor = threshold * (floorRatio ?? 0.55);
    if (value <= floor) return 0;
    if (value >= threshold) {
      const bonus = Math.min(threshold, value - threshold) / threshold;
      return clamp01(1 + bonus * 0.12);
    }
    return clamp01((value - floor) / (threshold - floor));
  }

  function computeRmScore(m, cfg) {
    const w = cfg.weights || {};
    const price = m.price;
    const priorClose = m.priorClose;
    const dailyPct =
      price != null && priorClose > 0
        ? ((price - priorClose) / priorClose) * 100
        : normalizeChangePct(m.changePct);

    const moveMin = cfg.movePctMin ?? 8;
    const dailyMin = cfg.dailyPctMin ?? 10;
    const gapMin = cfg.gapPctMin ?? 3;
    const volMultiple = cfg.volMultiple ?? 5;
    const priceMin = cfg.priceMin ?? 1;
    const priceMax = cfg.priceMax ?? 20;

    const dailyOk = dailyPct != null && dailyPct >= dailyMin;
    const moveOk = dailyPct != null && dailyPct >= moveMin;
    const priceOk =
      price != null && price >= priceMin && price <= priceMax;

    const vol = m.volume;
    const avgVol30 = m.avgVol30;
    const volRatio =
      vol != null && avgVol30 != null && avgVol30 > 0 ? vol / avgVol30 : null;
    const volOk = volRatio != null && volRatio >= volMultiple;

    const gapPct = gapUpPct(m);
    const gapFrac = gradAbove(gapPct, gapMin, 0.4);
    const volDailyFrac =
      volRatio != null && dailyPct != null && dailyPct >= 5
        ? gradAbove(dailyPct, 5, 0.45) * gradAbove(volRatio, volMultiple, 0.65)
        : 0;
    const newsFrac = Math.max(gapFrac, volDailyFrac);
    const newsProxyOk = newsFrac >= 0.85;

    const floatOk =
      m.floatShares != null ? m.floatShares > 0 && m.floatShares < 10_000_000 : null;
    let floatFrac = 0;
    if (cfg.applyFloatPoints) {
      if (floatOk === true || floatOk === null) floatFrac = 1;
    }

    const fractions = {
      float: floatFrac,
      news: newsFrac,
      vol: gradAbove(volRatio, volMultiple, 0.65),
      move: gradAbove(dailyPct, moveMin, 0.5),
      daily: gradAbove(dailyPct, dailyMin, 0.5),
      price: priceOk ? 1 : 0,
    };

    const scoreParts = {};
    let score = 0;
    for (const key of ["float", "news", "vol", "move", "daily", "price"]) {
      const earned = (w[key] || 0) * (fractions[key] || 0);
      scoreParts[key] = Math.round(earned * 10) / 10;
      score += earned;
    }

    return {
      score,
      scoreParts,
      fractions,
      dailyPct,
      volRatio,
      volOk,
      moveOk,
      dailyOk,
      priceOk,
      newsProxyOk,
      floatOk,
      gapPct,
    };
  }

  function quoteToMetrics(q) {
    return {
      symbol: String(q.symbol || "").toUpperCase(),
      price: q.regularMarketPrice ?? q.price,
      volume: q.regularMarketVolume ?? q.volume,
      changePct: normalizeChangePct(
        q.regularMarketChangePercent ?? q.percentchange
      ),
      priorClose: q.regularMarketPreviousClose ?? q.previousClose,
      open: q.regularMarketOpen ?? q.open,
      avgVol30: null,
      floatShares: null,
    };
  }

  async function enrichSymbol(sym, base, cfg, minScore) {
    const chart = await fetchChartMetrics(sym);
    if (chart) {
      base.priorClose = chart.priorClose ?? base.priorClose;
      base.open = chart.open ?? base.open;
      base.avgVol30 = chart.avgVol30;
    }

    let scored = computeRmScore(base, cfg);
    if (
      cfg.applyFloatPoints &&
      scored.score >= minScore - (cfg.weights?.float || 0) &&
      base.floatShares == null
    ) {
      base.floatShares = await fetchFloatShares(sym);
      scored = computeRmScore(base, cfg);
    }

    return { base, scored };
  }

  async function buildSession(cfg, handlers) {
    const minScore = cfg.minScore ?? DEFAULT_MIN_SCORE;
    const bySym = new Map();

    const screenResults = await Promise.all(
      SCREENS.map(async (scrId) => {
        if (handlers?.onPhase) {
          handlers.onPhase("Loading " + scrId.replace(/_/g, " ") + "…");
        }
        return fetchScreenerQuotes(scrId);
      })
    );
    for (const quotes of screenResults) {
      for (const q of quotes) {
        const sym = String(q.symbol || "").toUpperCase();
        if (!sym || sym.length > 6 || sym.includes(".")) continue;
        if (!bySym.has(sym)) bySym.set(sym, quoteToMetrics(q));
      }
    }

    const allSymbols = [...bySym.keys()];
    const candidates = allSymbols.filter((sym) =>
      passesH001Prefilter(bySym.get(sym), cfg)
    );
    const skipped = allSymbols.length - candidates.length;

    if (handlers?.onPhase) {
      handlers.onPhase(
        "H-001 pre-filter: " +
          candidates.length +
          " to score" +
          (skipped ? " (" + skipped + " skipped)" : "") +
          "…"
      );
    }

    const picks = [];
    let n = 0;

    for (let i = 0; i < candidates.length; i += CHART_BATCH_SIZE) {
      const batch = candidates.slice(i, i + CHART_BATCH_SIZE);
      const rows = await Promise.all(
        batch.map(async (sym) => {
          n++;
          if (handlers?.onProgress) handlers.onProgress(sym, n, candidates.length, 0.1);

          const base = bySym.get(sym);
          const { scored } = await enrichSymbol(sym, base, cfg, minScore);

          if (handlers?.onProgress) handlers.onProgress(sym, n, candidates.length, 1);

          if (scored.score < minScore) return null;
          if (isGapDown(base)) return null;
          if (scored.dailyPct != null && scored.dailyPct < 0) return null;

          const pctEod =
            scored.dailyPct != null ? Math.round(scored.dailyPct * 100) / 100 : null;

          return {
            symbol: sym,
            rm_confidence: Math.round(scored.score * 10) / 10,
            rm_score_parts: scored.scoreParts,
            rm_score_fractions: scored.fractions,
            last: base.price != null ? Number(base.price) : null,
            pct_change:
              scored.dailyPct != null ? Math.round(scored.dailyPct * 100) / 100 : null,
            gap_pct:
              scored.gapPct != null ? Math.round(scored.gapPct * 100) / 100 : null,
            pct_eod: pctEod,
            volume: base.volume != null ? Number(base.volume) : null,
            vol_ratio:
              scored.volRatio != null
                ? Math.round(scored.volRatio * 10) / 10
                : null,
            catalyst: {
              status: "pending",
              proxy_only: true,
              verified: null,
              headline: null,
              source_url: null,
              headlines: [],
              rm_confidence_adjusted: null,
            },
          };
        })
      );
      for (const row of rows) {
        if (row) picks.push(row);
      }
    }

    picks.sort((a, b) => (b.rm_confidence || 0) - (a.rm_confidence || 0));
    const pickN = picks.length;
    picks.forEach((p, i) => {
      p.rank = i + 1;
      p.rm_rank_pct =
        pickN <= 1 ? 100 : Math.round((1 - i / (pickN - 1)) * 100);
    });

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "").slice(0, 15);
    const session = {
      hypothesis_id: cfg.hypothesis_id || "H-001",
      session_id: "market-scan-" + stamp,
      scanned_at: now.toISOString(),
      source_file: "Rainmaker H-001 market scan",
      session_label: "market",
      pick_count: picks.length,
      picks,
    };

    return {
      session,
      screened: allSymbols.length,
      scored: candidates.length,
      skipped,
      minScore,
    };
  }

  /** Resolve the rm_api base (meta tag, stored override, or localhost dev). */
  function apiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
      const stored = global.localStorage?.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (_) {
      /* ignore */
    }
    const h = global.location?.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  /**
   * Server-backed H-001 scan (#8/#15): scoring runs in rm_api so the public
   * client never ships the scan logic. Returns the same session shape as the
   * client path, or null if the server is unavailable / errors.
   */
  async function runServerScan(cfg, handlers) {
    const base = apiBase();
    if (!base) return null;
    if (handlers?.onPhase) handlers.onPhase("Scanning on rm_api…");
    const c = cfg || {};
    const body = {
      hypothesisId: c.hypothesis_id || "H-001",
      applyFloatPoints: c.applyFloatPoints,
      volMultiple: c.volMultiple,
      dailyPctMin: c.dailyPctMin,
      movePctMin: c.movePctMin,
      priceMin: c.priceMin,
      priceMax: c.priceMax,
      gapPctMin: c.gapPctMin,
      minScore: c.minScore ?? DEFAULT_MIN_SCORE,
    };
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    const headers = { "Content-Type": "application/json" };
    try {
      if (typeof global.RMAuthGate !== "undefined") {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (_) {
      /* ignore */
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(base + "/scan/h001", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.session?.picks) return null;
      return {
        session: data.session,
        screened: data.screened ?? 0,
        scored: data.scored ?? 0,
        skipped: data.skipped ?? 0,
        minScore: data.min_score ?? body.minScore,
        source: data.source || "rm_api",
      };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runMarketScan(cfg, handlers) {
    const resolved = cfg || (global.RMScanConfig && RMScanConfig.load()) || {};
    // Prefer the server scan when an API is configured; fall back to the
    // in-browser proxy scan so local/offline use still works.
    const server = await runServerScan(resolved, handlers);
    if (server) return server;
    return buildSession(resolved, handlers);
  }

  global.RMMarketScan = {
    runMarketScan,
    runServerScan,
    computeRmScore,
    passesH001Prefilter,
    DEFAULT_MIN_SCORE,
    FETCH_MS,
    CHART_BATCH_SIZE,
  };
})(typeof window !== "undefined" ? window : globalThis);
