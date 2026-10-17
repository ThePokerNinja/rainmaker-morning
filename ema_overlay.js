/**
 * EMA practical guide overlay (Phase 8a) - 9 / 21 / 50 / 200 lines on price pane.
 * Config: config/ema_strategy.json (G7-B adaptive 200).
 */
(function (global) {
  const DEFAULT_MA = {
    type: "ema",
    periods: [9, 21, 50, 200],
    show_200_min_bars: 200,
    colors: {
      ema9: "#22c55e",
      ema21: "#eab308",
      ema50: "#3b82f6",
      ema200: "#a855f7",
    },
    hidden_200_chip: "Need longer range for 200 EMA",
  };

  let strategy = null;
  let loadPromise = null;

  function calcEMA(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = values[0];
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function loadConfig() {
    if (strategy) return Promise.resolve(strategy);
    if (loadPromise) return loadPromise;
    loadPromise = fetch("config/ema_strategy.json?v=20260601")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        strategy = json || { ma: DEFAULT_MA, version: "2026-06-01" };
        return strategy;
      });
    return loadPromise;
  }

  function getMaConfig() {
    return strategy?.ma || DEFAULT_MA;
  }

  function computeStack(fullBars) {
    if (!fullBars?.length) return null;
    const closes = fullBars.map((b) => b.close);
    if (closes.some((c) => c == null || !Number.isFinite(c))) return null;
    return {
      ema9: calcEMA(closes, 9),
      ema21: calcEMA(closes, 21),
      ema50: calcEMA(closes, 50),
      ema200: calcEMA(closes, 200),
      barCount: fullBars.length,
    };
  }

  function seriesForView(fullBars, viewBars, stack) {
    if (!stack || !viewBars?.length) return null;
    const idxByT = new Map(fullBars.map((b, i) => [b.t, i]));
    function pick(key) {
      return viewBars.map((b) => {
        const i = idxByT.get(b.t);
        if (i == null || i < 0) return NaN;
        return stack[key][i];
      });
    }
    return {
      ema9: pick("ema9"),
      ema21: pick("ema21"),
      ema50: pick("ema50"),
      ema200: pick("ema200"),
      barCount: stack.barCount,
    };
  }

  function lineDefs(ma) {
    const colors = ma.colors || DEFAULT_MA.colors;
    return [
      { key: "ema9", label: "EMA 9", color: colors.ema9, width: 1.25 },
      { key: "ema21", label: "EMA 21", color: colors.ema21, width: 1.35 },
      { key: "ema50", label: "EMA 50", color: colors.ema50, width: 1.5 },
      {
        key: "ema200",
        label: "EMA 200",
        color: colors.ema200,
        width: 1.6,
        minBars: ma.show_200_min_bars ?? 200,
      },
    ];
  }

  function includeInMetrics(m, viewSeries, mergeFn) {
    if (!viewSeries || !mergeFn) return m;
    let lo = Infinity;
    let hi = -Infinity;
    for (const def of lineDefs(getMaConfig())) {
      if (def.minBars && viewSeries.barCount < def.minBars) continue;
      const arr = viewSeries[def.key];
      if (!arr) continue;
      for (const v of arr) {
        if (!Number.isFinite(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (!Number.isFinite(lo)) return m;
    return mergeFn(m, lo, hi, 0.06);
  }

  const EMA_DESC = {
    ema9: "Fast trend - short-term momentum",
    ema21: "Swing trend - pullback support/resistance",
    ema50: "Intermediate trend - stage filter",
    ema200: "Long trend - major support/resistance",
  };

  function renderLine(values, bars, m, color, width, title, escapeAttr, svgTitle, trendHint, renderIndPath, defKey) {
    if (!values?.length || !bars?.length) return "";
    let d = "";
    for (let i = 0; i < bars.length; i++) {
      if (!Number.isFinite(values[i])) continue;
      d += (d ? " L" : "M") + m.x(bars[i].t) + " " + m.y(values[i]);
    }
    if (!d) return "";
    const tipTitle =
      title + (trendHint && title.indexOf("EMA 50") >= 0 ? " - " + trendHint : "");
    const desc = EMA_DESC[defKey] || "Exponential moving average";
    if (typeof renderIndPath === "function") {
      return renderIndPath(d, {
        color,
        width: width || 1.3,
        title: tipTitle,
        desc,
        stat: title,
        classExtra: "ca-ema-line-wrap",
      });
    }
    return (
      '<path class="ca-chart-line ca-ema-line" fill="none" stroke="' +
      color +
      '" stroke-width="' +
      (width || 1.3) +
      '" data-ema="' +
      escapeAttr(title) +
      '" d="' +
      d +
      '">' +
      svgTitle(tipTitle) +
      "</path>"
    );
  }

  function render(viewBars, viewSeries, m, helpers) {
    if (!viewBars?.length || !viewSeries || !helpers) return "";
    const ma = getMaConfig();
    const { escapeAttr, svgTitle, trendHint, renderIndPath } = helpers;
    let svg = '<g class="ca-ema-overlay">';
    for (const def of lineDefs(ma)) {
      if (def.minBars && viewSeries.barCount < def.minBars) continue;
      svg += renderLine(
        viewSeries[def.key],
        viewBars,
        m,
        def.color,
        def.width,
        def.label,
        escapeAttr,
        svgTitle,
        trendHint,
        renderIndPath,
        def.key
      );
    }
    return svg + "</g>";
  }

  function hint200Hidden(barCount) {
    const ma = getMaConfig();
    const min = ma.show_200_min_bars ?? 200;
    if (barCount >= min) return "";
    return ma.hidden_200_chip || DEFAULT_MA.hidden_200_chip;
  }

  global.RMEmaOverlay = {
    loadConfig,
    getMaConfig,
    computeStack,
    seriesForView,
    includeInMetrics,
    render,
    hint200Hidden,
    lineDefs,
  };
})(typeof window !== "undefined" ? window : globalThis);
