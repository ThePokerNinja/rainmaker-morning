/**
 * EMA signal engine (Phase 8b) — trend, stack, crosses, pullbacks.
 * Config: config/ema_strategy.json (G7–G12).
 */
(function (global) {
  const DEFAULT = {
    signals: {
      trend_filter: {
        uptrend: "close > ema50 && close > ema200",
        downtrend: "close < ema50 && close < ema200",
      },
      golden_cross: { fast: 9, slow: 21, require_uptrend: true },
      death_cross: { fast: 9, slow: 21, require_downtrend: true },
      pullback: {
        touch_tolerance_pct: 0.15,
        ema_levels: [9, 21],
        confirm_close_above_ema: true,
        swing_lookback_bars: 8,
      },
      tap_enabled: ["golden_cross", "pullback_buy"],
    },
    short_signals: { allow_short_signals: false, death_cross_chart_marker: true },
    primary_action: { default_rr: 2 },
    c2_chips: {
      trend_labels: {
        uptrend: "EMA: Uptrend",
        downtrend: "EMA: Downtrend",
        chop: "EMA: Chop",
      },
      event_labels: {
        golden_cross: "Golden cross",
        death_cross: "Death cross — wait",
        pullback_9: "Pullback 9",
        pullback_21: "Pullback 21",
        stack_aligned: "Stack aligned",
      },
    },
  };

  let strategy = null;

  function cfg() {
    return strategy || DEFAULT;
  }

  function loadConfig() {
    if (strategy) return Promise.resolve(strategy);
    return fetch("config/ema_strategy.json?v=20260601")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        strategy = json || DEFAULT;
        return strategy;
      });
  }

  function emaKey(period) {
    return period === 9 ? "ema9" : period === 21 ? "ema21" : period === 50 ? "ema50" : "ema200";
  }

  function trendAt(i, bar, stack) {
    const close = bar?.close;
    if (close == null || !stack) return "chop";
    const e50 = stack.ema50?.[i];
    const e200 = stack.ema200?.[i];
    const has200 = stack.barCount >= 200 && Number.isFinite(e200);
    if (has200 && close > e50 && close > e200) return "uptrend";
    if (has200 && close < e50 && close < e200) return "downtrend";
    if (!has200 && Number.isFinite(e50)) {
      if (close > e50 * 1.001) return "uptrend";
      if (close < e50 * 0.999) return "downtrend";
    }
    return "chop";
  }

  function stackAligned(i, stack, ma) {
    const look = ma?.slope_lookback_bars ?? 3;
    if (i < look || stack.barCount < 200) return false;
    const keys = ["ema9", "ema21", "ema50", "ema200"];
    for (let k = 0; k < keys.length - 1; k++) {
      if (!(stack[keys[k]][i] > stack[keys[k + 1]][i])) return false;
    }
    const signs = [];
    for (const key of keys) {
      const a = stack[key][i - look];
      const b = stack[key][i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      signs.push(Math.sign(b - a) || 0);
    }
    const s0 = signs[0];
    return s0 !== 0 && signs.every((s) => s === s0);
  }

  function crossUp(fast, slow, i) {
    return fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
  }

  function crossDown(fast, slow, i) {
    return fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
  }

  function nearEma(bar, emaVal, tolPct) {
    if (!Number.isFinite(emaVal) || emaVal === 0) return false;
    const low = bar.low ?? bar.close;
    const diff = Math.abs(low - emaVal) / emaVal * 100;
    return diff <= tolPct;
  }

  function detect(fullBars, stack) {
    if (!fullBars?.length || !stack) return { events: [], lastTrend: "chop", stackAligned: false };
    const c = cfg();
    const sig = c.signals || DEFAULT.signals;
    const labels = c.c2_chips?.event_labels || DEFAULT.c2_chips.event_labels;
    const trendLabels = c.c2_chips?.trend_labels || DEFAULT.c2_chips.trend_labels;
    const tapSet = new Set(sig.tap_enabled || ["golden_cross", "pullback_buy"]);
    const pb = sig.pullback || DEFAULT.signals.pullback;
    const tol = pb.touch_tolerance_pct ?? 0.15;
    const events = [];
    const lastIdx = fullBars.length - 1;

    for (let i = 1; i < fullBars.length; i++) {
      const bar = fullBars[i];
      const tr = trendAt(i, bar, stack);
      const e9 = stack.ema9;
      const e21 = stack.ema21;

      if (crossUp(e9, e21, i)) {
        const ok = !sig.golden_cross?.require_uptrend || tr === "uptrend";
        events.push({
          i,
          t: bar.t,
          type: "golden_cross",
          tap: ok && tapSet.has("golden_cross"),
          label: labels.golden_cross || "Golden cross",
          trend: tr,
          signalSource: "ema_golden_cross",
        });
      }
      if (crossDown(e9, e21, i)) {
        const ok = !sig.death_cross?.require_downtrend || tr === "downtrend";
        events.push({
          i,
          t: bar.t,
          type: "death_cross",
          tap: false,
          label: labels.death_cross || "Death cross — wait",
          trend: tr,
          marker: c.short_signals?.death_cross_chart_marker !== false,
          signalSource: "ema_death_cross",
        });
      }

      if (tr === "uptrend" && tapSet.has("pullback_buy")) {
        for (const period of pb.ema_levels || [9, 21]) {
          const key = emaKey(period);
          const emaVal = stack[key]?.[i];
          if (!nearEma(bar, emaVal, tol)) continue;
          if (pb.confirm_close_above_ema && bar.close <= emaVal) continue;
          const dedupe = events.some(
            (e) => e.i === i && e.type === "pullback_buy" && e.period === period
          );
          if (dedupe) continue;
          events.push({
            i,
            t: bar.t,
            type: "pullback_buy",
            period,
            tap: true,
            label: period === 9 ? labels.pullback_9 || "Pullback 9" : labels.pullback_21 || "Pullback 21",
            trend: tr,
            signalSource: period === 9 ? "ema_pullback_9" : "ema_pullback_21",
          });
        }
      }
    }

    const lastTrend = trendAt(lastIdx, fullBars[lastIdx], stack);
    const aligned = stackAligned(lastIdx, stack, sig.ema_stack);

    return {
      events,
      lastTrend,
      lastTrendLabel: trendLabels[lastTrend] || trendLabels.chop || "EMA: Chop",
      stackAligned: aligned,
      stackLabel: labels.stack_aligned || "Stack aligned",
      swingLookback: pb.swing_lookback_bars ?? 8,
      defaultRr: c.primary_action?.default_rr ?? 2,
    };
  }

  function eventsInWindow(events, vw) {
    if (!vw) return events;
    return events.filter((e) => e.t >= vw.tMin && e.t <= vw.tMax);
  }

  function tooltipForEvent(ev) {
    if (!ev) return "";
    if (ev.type === "golden_cross") return "EMA 9 crossed above 21 in uptrend. Tap to preview EMA plan.";
    if (ev.type === "pullback_buy") return "Pullback to EMA " + ev.period + " with close confirmation. Tap to preview EMA plan.";
    if (ev.type === "death_cross") return "EMA 9 crossed below 21. Wait — no short plan.";
    return ev.label || "";
  }

  function swingLow(bars, endIdx, lookback) {
    let lo = Infinity;
    for (let i = Math.max(0, endIdx - lookback + 1); i <= endIdx; i++) {
      const v = bars[i]?.low ?? bars[i]?.close;
      if (v != null && Number.isFinite(v)) lo = Math.min(lo, v);
    }
    return Number.isFinite(lo) ? lo : null;
  }

  global.RMEmaSignals = {
    loadConfig,
    detect,
    eventsInWindow,
    tooltipForEvent,
    trendAt,
    swingLow,
  };
})(typeof window !== "undefined" ? window : globalThis);
