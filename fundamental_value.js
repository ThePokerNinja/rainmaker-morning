/**
 * Fundamental Value overlay - stepped fair P/E series (overlay only; never scales chart).
 */
(function (global) {
  const DEFAULT_CFG = {
    line: { color: "#facc15", width: 2.5, dash: "", label: "Fair Value" },
    shading: { enabled: false, opacity: 0.08, undervalued: "#22c55e", overvalued: "#ef4444" },
    cacheTtlMs: 86400000,
    unavailableMessage: "Fundamentals unavailable",
  };

  let cfg = null;
  let loadPromise = null;
  const memCache = new Map();
  let resolvedApiBase = null;

  function defaultApiBase() {
    const h = typeof location !== "undefined" ? location.hostname : "";
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return PROD_API;
  }

  function fvPayloadScore(payload) {
    if (!payload || payload.error) return 0;
    if (!hasHistoricalSeries(payload)) return 0;
    let score = 1;
    if (payload.dataSource === "yahoo") score = 2;
    const series = payload.series || [];
    const last = series[series.length - 1];
    if (
      Number.isFinite(payload.fairValue) &&
      last &&
      Math.abs(last.fairValue - payload.fairValue) < 1
    ) {
      score += 1;
    }
    return score;
  }

  async function resolveApiBase() {
    if (resolvedApiBase) return resolvedApiBase;
    const candidates =
      typeof location !== "undefined" &&
      (location.hostname === "localhost" || location.hostname === "127.0.0.1")
        ? ["http://127.0.0.1:8765", "http://127.0.0.1:8767", "http://127.0.0.1:8788", PROD_API]
        : [PROD_API];
    let bestBase = null;
    let bestScore = 0;
    for (const base of candidates) {
      try {
        const r = await fetch(base + "/fundamentals/valuation?symbol=META&range=5y", {
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const j = await r.json();
        const score = fvPayloadScore(j);
        if (score > bestScore) {
          bestScore = score;
          bestBase = base;
        }
        if (score >= 3) break;
      } catch {
        /* try next */
      }
    }
    resolvedApiBase = bestBase || defaultApiBase();
    return resolvedApiBase;
  }

  function apiBase() {
    return resolvedApiBase || defaultApiBase();
  }

  const PROD_API = "https://rainmaker-api.onrender.com";

  function cacheKey(symbol, range) {
    return String(symbol || "").toUpperCase() + "|" + String(range || "5y");
  }

  function hasHistoricalSeries(payload) {
    return Array.isArray(payload?.series) && payload.series.length >= 2;
  }

  function readSessionCache(key) {
    try {
      const raw = sessionStorage.getItem("rm_fv_cache_v8:" + key);
      if (!raw) return null;
      const row = JSON.parse(raw);
      if (!row || !row.at || !row.payload) return null;
      const ttl = cfg?.cacheTtlMs ?? DEFAULT_CFG.cacheTtlMs;
      if (Date.now() - row.at > ttl) return null;
      if (!hasHistoricalSeries(row.payload) && !row.payload?.error) return null;
      return row.payload;
    } catch {
      return null;
    }
  }

  function writeSessionCache(key, payload) {
    try {
      sessionStorage.setItem(
        "rm_fv_cache_v8:" + key,
        JSON.stringify({ at: Date.now(), payload })
      );
    } catch {
      /* quota */
    }
  }

  function loadConfig() {
    if (cfg) return Promise.resolve(cfg);
    if (loadPromise) return loadPromise;
    loadPromise = fetch("config/fundamental_value.json?v=20260602")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        cfg = json || DEFAULT_CFG;
        return cfg;
      });
    return loadPromise;
  }

  function getConfig() {
    return cfg || DEFAULT_CFG;
  }

  const GDF_PE_MIN = 5;

  function fairPE(growthPct) {
    const g = Number(growthPct);
    if (!Number.isFinite(g)) return { pe: 15, tag: "PE15" };
    if (g <= 5) return { pe: Math.max(GDF_PE_MIN, Math.min(15, 8.5 + 2 * g)), tag: "GDF" };
    if (g < 15) return { pe: 15, tag: "PE15" };
    return { pe: g, tag: "PE_EQ_G" };
  }

  function gapLabel(gapPct) {
    if (gapPct == null || !Number.isFinite(gapPct)) return "";
    const abs = Math.abs(gapPct);
    if (abs < 3) return "Fairly valued vs earnings";
    if (gapPct < 0) return "Undervalued vs earnings";
    return "Extended vs earnings";
  }

  function fmtMoney(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    return "$" + v.toFixed(2);
  }

  function fmtPct(v, signed) {
    if (v == null || !Number.isFinite(v)) return "-";
    const n = Math.abs(v).toFixed(1);
    if (!signed) return n + "%";
    if (v > 0) return n + "% above";
    if (v < 0) return n + "% below";
    return "on fair value";
  }

  function tooltipPayload(valuation, lastClose) {
    const c = getConfig();
    if (!valuation || valuation.error) {
      const detail =
        valuation?.error === "no_eps"
          ? "No trailing EPS for this symbol (common for ETFs)."
          : "Start rm_api locally or retry later.";
      return {
        kicker: "Fundamentals",
        title: c.unavailableMessage,
        desc: detail,
        stat: "",
        variant: "fv-unavailable",
      };
    }
    const fv = valuation.fairValue;
    const g = valuation.growthPct;
    const label = valuation.formulaLabel || valuation.formula || "";
    const price = lastClose != null ? lastClose : valuation.lastPrice;
    let gapPct = valuation.gapPct;
    if ((gapPct == null || !Number.isFinite(gapPct)) && fv > 0 && price != null) {
      gapPct = ((price - fv) / fv) * 100;
    }
    const gStr = g != null && Number.isFinite(g) ? "g=" + g.toFixed(1) + "%" : "";
    const title =
      "Fair value " + fmtMoney(fv) + " - " + label + (gStr ? " (" + gStr + ")" : "");
    const desc =
      price != null
        ? "Price " + fmtPct(gapPct, true) + " - " + gapLabel(gapPct)
        : gapLabel(gapPct);
    let stat = "";
    if (valuation.forwardEps != null && Number.isFinite(valuation.forwardEps)) {
      stat = "Forward EPS " + fmtMoney(valuation.forwardEps);
    }
    return {
      kicker: "Fair Value",
      title,
      desc,
      stat,
      variant: gapPct != null && gapPct < -3 ? "fv-under" : gapPct > 3 ? "fv-over" : "fv-fair",
      gapPct,
      fairValue: fv,
    };
  }

  async function fetchValuationFrom(base, symbol, range) {
    const url =
      base +
      "/fundamentals/valuation?symbol=" +
      encodeURIComponent(symbol) +
      "&range=" +
      encodeURIComponent(range);
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchValuation(symbol, range) {
    const sym = String(symbol || "").toUpperCase();
    const rg = String(range || "5y").trim().toLowerCase() || "5y";
    const key = cacheKey(sym, rg);
    if (memCache.has(key)) {
      const row = memCache.get(key);
      const ttl = cfg?.cacheTtlMs ?? DEFAULT_CFG.cacheTtlMs;
      if (Date.now() - row.at < ttl && hasHistoricalSeries(row.payload)) {
        return row.payload;
      }
      memCache.delete(key);
    }
    const sess = readSessionCache(key);
    if (sess) {
      memCache.set(key, { at: Date.now(), payload: sess });
      return sess;
    }
    await loadConfig();
    const localBase = await resolveApiBase();
    let payload = null;
    try {
      payload = await fetchValuationFrom(localBase, sym, rg);
    } catch {
      payload = null;
    }
    if (!payload?.error && !hasHistoricalSeries(payload)) {
      if (localBase !== PROD_API) {
        try {
          const prod = await fetchValuationFrom(PROD_API, sym, rg);
          if (prod && hasHistoricalSeries(prod)) payload = prod;
        } catch {
          /* prod unavailable */
        }
      }
    }
    if (!payload) return { error: "network", symbol: sym, range: rg, series: [] };
    if (payload.error) {
      if (!Array.isArray(payload.series)) payload.series = [];
      return payload;
    }
    if (hasHistoricalSeries(payload)) {
      memCache.set(key, { at: Date.now(), payload });
      writeSessionCache(key, payload);
    }
    return payload;
  }

  function normalizeSeries(valuation) {
    if (!valuation) return [];
    if (valuation.series?.length) return valuation.series;
    if (Number.isFinite(valuation.fairValue) && valuation.asOf) {
      return [{ t: valuation.asOf, fairValue: valuation.fairValue, period: "current" }];
    }
    return [];
  }

  function fvKnots(valuation) {
    const knots = normalizeSeries(valuation)
      .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.fairValue))
      .map((p) => ({ t: p.t, fv: p.fairValue }))
      .sort((a, b) => a.t - b.t);
    const anchorT = valuation?.asOf || Date.now();
    const anchorFv = valuation?.fairValue;
    if (Number.isFinite(anchorFv)) {
      const last = knots[knots.length - 1];
      if (!last || last.t < anchorT - 86400000 || Math.abs(last.fv - anchorFv) > 0.01) {
        if (last && last.t >= anchorT - 86400000) {
          last.fv = anchorFv;
          last.t = anchorT;
        } else {
          knots.push({ t: anchorT, fv: anchorFv });
        }
      }
    }
    return knots;
  }

  function interpolateFvAt(t, knots) {
    if (!knots.length) return NaN;
    if (t <= knots[0].t) return knots[0].fv;
    if (t >= knots[knots.length - 1].t) return knots[knots.length - 1].fv;
    for (let i = 1; i < knots.length; i++) {
      const a = knots[i - 1];
      const b = knots[i];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        if (span <= 0) return b.fv;
        const w = (t - a.t) / span;
        return a.fv + (b.fv - a.fv) * w;
      }
    }
    return knots[knots.length - 1].fv;
  }

  function smoothValuesForView(viewBars, valuation) {
    const knots = fvKnots(valuation);
    if (!knots.length || !viewBars?.length) return null;
    const values = viewBars.map((bar) => interpolateFvAt(bar.t, knots));
    const unique = new Set(values.filter(Number.isFinite));
    return { values, pointCount: knots.length, uniqueCount: unique.size, knots };
  }

  function seriesForView(viewBars, valuation) {
    return smoothValuesForView(viewBars, valuation);
  }

  /** Price + FV data extents for Y-axis (FAST Graphs: both lines visible). */
  function valueExtents(viewBars, valuation) {
    const pack = seriesForView(viewBars, valuation);
    if (!pack) return null;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const b of viewBars) {
      const hi = b.high ?? b.close;
      const lo = b.low ?? b.close;
      if (hi != null) yMax = Math.max(yMax, hi);
      if (lo != null) yMin = Math.min(yMin, lo);
    }
    for (const v of pack.values) {
      if (Number.isFinite(v)) {
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
    return { yMin, yMax, uniqueCount: pack.uniqueCount, pointCount: pack.pointCount };
  }

  function mapY(m, price, top, floor) {
    const raw = m.y(price);
    if (raw >= top && raw <= floor) return { y: raw, clamp: null };
    return { y: null, clamp: raw < top ? "above" : "below" };
  }

  function buildSmoothPath(values, bars, m) {
    const top = m.pad.t;
    const floor = m.mainH - m.pad.b;
    const xLeft = m.pad.l;
    const xRight = m.w - m.pad.r;
    const pts = [];
    let anyClamped = null;
    for (let i = 0; i < bars.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      let x = m.x(bars[i].t);
      if (!Number.isFinite(x)) x = i === 0 ? xLeft : xRight;
      x = Math.max(xLeft, Math.min(xRight, x));
      const mapped = mapY(m, v, top, floor);
      if (mapped.clamp) anyClamped = mapped.clamp;
      if (mapped.y != null) pts.push({ x, y: mapped.y, v });
    }
    if (pts.length < 2) return null;
    let d = "M" + pts[0].x + " " + pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      d += " L" + pts[i].x + " " + pts[i].y;
    }
    const last = pts[pts.length - 1];
    return {
      d,
      lastY: last.y,
      lastV: last.v,
      clamp: anyClamped,
      xLeft,
      xRight,
    };
  }

  function buildStepLines(values, bars, m) {
    const top = m.pad.t;
    const floor = m.mainH - m.pad.b;
    const xLeft = m.pad.l;
    const xRight = m.w - m.pad.r;
    const horizontals = [];
    let i = 0;
    let anyClamped = null;
    while (i < bars.length) {
      if (!Number.isFinite(values[i])) {
        i++;
        continue;
      }
      const v = values[i];
      let j = i;
      while (j + 1 < bars.length && values[j + 1] === v) j++;
      let x0 = m.x(bars[i].t);
      let x1 = m.x(bars[j].t);
      if (!Number.isFinite(x0)) x0 = xLeft;
      if (!Number.isFinite(x1)) x1 = xRight;
      x0 = Math.max(xLeft, Math.min(xRight, x0));
      x1 = Math.max(xLeft, Math.min(xRight, x1));
      if (x1 < x0) {
        const tmp = x0;
        x0 = x1;
        x1 = tmp;
      }
      const mapped = mapY(m, v, top, floor);
      if (mapped.clamp) anyClamped = mapped.clamp;
      if (mapped.y != null) {
        horizontals.push({ x0, x1, y: mapped.y, v, clamp: null });
      }
      i = j + 1;
    }
    if (!horizontals.length) {
      return anyClamped ? { horizontals: [], verticals: [], offScaleOnly: true, clamp: anyClamped } : null;
    }

    const verticals = [];
    for (let k = 1; k < horizontals.length; k++) {
      const prev = horizontals[k - 1];
      const cur = horizontals[k];
      if (prev.y !== cur.y) {
        verticals.push({ x: cur.x0, y0: prev.y, y1: cur.y });
      }
    }

    const last = horizontals[horizontals.length - 1];
    return {
      horizontals,
      verticals,
      lastY: last.y,
      lastV: last.v,
      clamp: anyClamped,
      offScaleOnly: false,
      xLeft,
      xRight,
    };
  }

  function fvOffScaleClamp(m, fv) {
    if (!m || !Number.isFinite(fv) || !Number.isFinite(m.yMin) || !Number.isFinite(m.yMax)) {
      return null;
    }
    if (fv < m.yMin) return "below";
    if (fv > m.yMax) return "above";
    return null;
  }

  function renderOffScaleFv(m, valuation, lastClose, helpers, clamp) {
    const c = getConfig();
    const tip = tooltipPayload(helpers.tooltipValuation || valuation, lastClose);
    const { escapeAttr, fvTipData, displayFairValue } = helpers;
    const lineCfg = c.line || DEFAULT_CFG.line;
    const color = lineCfg.color || "#facc15";
    const width = lineCfg.width || 2;
    const dash = "6 4";
    const displayFv =
      Number.isFinite(displayFairValue) ? displayFairValue
      : Number.isFinite(valuation?.fairValue) ? valuation.fairValue
      : NaN;
    if (!Number.isFinite(displayFv)) return "";

    const top = m.pad.t;
    const floor = m.mainH - m.pad.b;
    const y = clamp === "above" ? top + 10 : floor - 4;
    const x0 = m.pad.l;
    const x1 = m.w - m.pad.r;
    const d = "M" + x0 + " " + y + " L" + x1 + " " + y;
    const tipAttr =
      typeof fvTipData === "function"
        ? fvTipData(tip.kicker, tip.title, tip.desc, tip.stat, tip.variant)
        : "";
    const edge =
      clamp === "above" ? "above chart scale" : "below chart scale";
    const labelText =
      (lineCfg.label || "Fair Value") +
      " " +
      fmtMoney(displayFv) +
      " (" +
      edge +
      ")";

    let svg =
      '<g class="ca-fv-overlay ca-fv-overlay--off-scale" data-fv-clamp="' +
      escapeAttr(clamp) +
      '">';
    svg +=
      '<path class="ca-fv-line ca-fv-line--off-scale ca-ind-visible" fill="none" d="' +
      d +
      '" stroke="' +
      color +
      '" stroke-width="' +
      width +
      '" stroke-opacity="0.72" stroke-dasharray="' +
      dash +
      '" vector-effect="non-scaling-stroke" pointer-events="none"/>';
    svg +=
      '<path class="ca-ind-hit ca-fv-hit fv-tip-target" tabindex="0"' +
      tipAttr +
      ' fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" d="' +
      d +
      '"/>';
    svg +=
      '<text class="ca-fv-label ca-fv-label--off-scale" x="' +
      (m.w - m.pad.r - 4) +
      '" y="' +
      (clamp === "above" ? y + 11 : y - 5) +
      '" text-anchor="end" fill="' +
      color +
      '" font-size="9" pointer-events="none">' +
      escapeAttr(labelText) +
      "</text>";
    svg += "</g>";
    return svg;
  }

  function render(viewBars, m, valuation, lastClose, helpers) {
    if (!viewBars?.length || !m || !helpers) return "";
    const pack = seriesForView(viewBars, valuation);
    if (!pack) return "";

    const displayFv =
      Number.isFinite(helpers.displayFairValue) ? helpers.displayFairValue
      : Number.isFinite(valuation?.fairValue) ? valuation.fairValue
      : NaN;
    const path = buildSmoothPath(pack.values, viewBars, m);
    if (!path) {
      const clamp = fvOffScaleClamp(m, displayFv);
      if (clamp) {
        return renderOffScaleFv(m, valuation, lastClose, helpers, clamp);
      }
      return "";
    }

    const c = getConfig();
    const tip = tooltipPayload(helpers.tooltipValuation || valuation, lastClose);
    const { escapeAttr, fvTipData, displayFairValue } = helpers;
    const lineCfg = c.line || DEFAULT_CFG.line;
    const color = lineCfg.color || "#facc15";
    const width = lineCfg.width || 2.5;
    const dash = lineCfg.dash || "";

    const tipAttr =
      typeof fvTipData === "function"
        ? fvTipData(tip.kicker, tip.title, tip.desc, tip.stat, tip.variant)
        : "";

    const labelFv = Number.isFinite(displayFairValue) ? displayFairValue : path.lastV;
    const labelText = (lineCfg.label || "Fair Value") + " " + fmtMoney(labelFv);

    let svg = '<g class="ca-fv-overlay">';
    svg +=
      '<path class="ca-fv-line ca-ind-visible" fill="none" d="' +
      path.d +
      '" stroke="' +
      color +
      '" stroke-width="' +
      width +
      '" stroke-opacity="0.92"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : "") +
      ' vector-effect="non-scaling-stroke" pointer-events="none"/>';
    svg +=
      '<path class="ca-ind-hit ca-fv-hit fv-tip-target" tabindex="0"' +
      tipAttr +
      ' fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" d="' +
      path.d +
      '"/>';
    svg +=
      '<text class="ca-fv-label" x="' +
      (m.w - m.pad.r - 4) +
      '" y="' +
      (path.lastY - 5) +
      '" text-anchor="end" fill="' +
      color +
      '" font-size="9" pointer-events="none">' +
      escapeAttr(labelText) +
      "</text>";
    svg += "</g>";
    return svg;
  }

  global.RMFundamentalValue = {
    loadConfig,
    getConfig,
    fairPE,
    fetchValuation,
    tooltipPayload,
    seriesForView,
    valueExtents,
    render,
    gapLabel,
    hasHistoricalSeries,
    normalizeSeries,
    buildStepLines,
    buildSmoothPath,
    smoothValuesForView,
    fvKnots,
  };
})(typeof window !== "undefined" ? window : globalThis);
