/**
 * Per-column KPI contract v2 (Trade Story Platform).
 *
 * Charter-driven stage + posture + gate for Morning Pulse / Shape of Data / Target Trades.
 * Legacy adapter keeps score/greenLit/confidence for header metrics and RMMetrics.
 *
 * New shape:
 *   { stage, posture, lean, signals, gate, internalSigned }
 */
(function (global) {
  const CHARTER_URL = "config/column_charter.json";
  const LEAN_EPS = 0.1;

  let charter = null;
  let charterLoad = null;

  const DEFAULT_CHARTER = {
    version: "2026-05-31",
    fusion: {
      session_weights: {
        pre: { c1: 0.55, c2: 0.15, c3: 0.3 },
        rth: { c1: 0.4, c2: 0.35, c3: 0.25 },
        post: { c1: 0.3, c2: 0.2, c3: 0.5 },
      },
      gate_lean_map: { go_bull: 0.35, go_bear: -0.35, wait: 0, stop: -0.55 },
      charge_from_gates: true,
    },
    header: {
      story_readiness: false,
      readiness_weights: {
        pulse_gate_go: 0.35,
        shape_plan_defined: 0.25,
        trades_pick_validated: 0.25,
        brief_generated: 0.15,
      },
    },
    columns: {
      c1_pulse: {
        greenlit_signed: 0.24,
        bands: { strong: 0.35, moderate: 0.12, weak: -0.12 },
        gates: { stop_signed_below: -0.35, go_signed_above: 0.18 },
      },
      c2_shape: {
        greenlit_signed: 0.22,
        bands: { strong: 0.3, moderate: 0.1, weak: -0.1 },
        gates: { wait_without_plan: true, go_signals_min: 2 },
      },
      c3_trades: {
        greenlit_signed: 0.2,
        bands: { strong: 0.28, moderate: 0.08, weak: -0.08 },
        gates: { stop_when_pulse_stop: true, go_rm_min: 55, go_news_required: true },
      },
    },
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function signedToScore(signed) {
    return Math.round((clamp(signed, -1, 1) + 1) * 50);
  }

  function leanFromSigned(signed) {
    if (signed >= LEAN_EPS) return "bull";
    if (signed <= -LEAN_EPS) return "bear";
    return "neutral";
  }

  function loadCharter() {
    if (charter) return Promise.resolve(charter);
    if (charterLoad) return charterLoad;
    charterLoad = fetch(CHARTER_URL + "?v=20260602")
      .then((r) => (r.ok ? r.json() : DEFAULT_CHARTER))
      .catch(() => DEFAULT_CHARTER)
      .then((c) => {
        charter = c;
        return charter;
      });
    return charterLoad;
  }

  function getCharter() {
    return charter || DEFAULT_CHARTER;
  }

  function sessionBucket() {
    try {
      const s = global.RMHeaderBg?.currentMarketSession?.();
      if (s === "post") return "post";
      if (s === "pre") return "pre";
    } catch (_) {}
    return "rth";
  }

  /** Map clock + footer/chart state to Trade Story stage. */
  function resolveTradeStoryStage() {
    const bucket = sessionBucket();
    if (bucket === "post") return "reflect";
    if (bucket === "pre") return "research";

    const sym = document.getElementById("tradeFooterJourney")?.dataset?.symbol;
    let hasOpen = false;
    try {
      const trades = JSON.parse(
        localStorage.getItem("rainmaker_ytd_" + new Date().getFullYear()) || "[]"
      );
      hasOpen = trades.some(
        (t) => t.status === "open" && (!sym || t.symbol === sym)
      );
    } catch (_) {}
    if (!hasOpen && global.RMHoldings?.getDisplayOpen) {
      const holdings = global.RMHoldings.getDisplayOpen() || [];
      hasOpen = holdings.some((h) => {
        const cs = global.RMHoldings.chartSymbolFor?.(h) || h.symbol;
        return !sym || cs === sym || h.symbol === sym;
      });
    }

    if (hasOpen) return "manage";

    const plan = global.RMAnalysisChart?.state?.tradePlan;
    if (plan?.entry != null && plan?.stop != null) return "plan";

    const mins = new Date().getHours() * 60 + new Date().getMinutes();
    if (mins >= 16 * 60) return "close";
    if (mins >= 9 * 60 + 30 && mins < 10 * 60) return "open";

    return "plan";
  }

  function bandLabel(signed, bands) {
    const b = bands || { strong: 0.3, moderate: 0.1, weak: -0.1 };
    if (signed >= b.strong) return "Strong";
    if (signed >= b.moderate) return "Moderate";
    if (signed <= b.weak) return "Weak";
    return "Neutral";
  }

  function leanLabel(lean) {
    if (lean === "bull") return "Risk-on";
    if (lean === "bear") return "Risk-off";
    return "Mixed";
  }

  function legacyConfidence(signed, signalCount) {
    const abs = Math.abs(signed);
    if (abs >= 0.32 && signalCount >= 3) return "high";
    if (abs >= 0.12 || signalCount >= 2) return "med";
    return "low";
  }

  function buildContract(opts) {
    const {
      signed,
      stage,
      posture,
      signals,
      gate,
      colKey,
      signalCount,
    } = opts;
    const c = getCharter();
    const col = c.columns?.[colKey] || {};
    const lean = leanFromSigned(signed);
    const internalSigned = clamp(signed, -1, 1);
    const score = signedToScore(internalSigned);
    const conf = legacyConfidence(internalSigned, signalCount || signals?.length || 0);
    const greenLit =
      gate === "go" &&
      lean === "bull" &&
      internalSigned >= (col.greenlit_signed ?? 0.2);

    return {
      stage,
      posture,
      lean,
      signals: (signals || []).slice(0, 4),
      gate,
      internalSigned,
      score,
      greenLit,
      confidence: conf,
      signed: internalSigned,
    };
  }

  function emptyContract(stage) {
    return buildContract({
      signed: 0,
      stage: stage || "research",
      posture: "—",
      signals: [],
      gate: "wait",
      colKey: "c1_pulse",
      signalCount: 0,
    });
  }

  function morningBias() {
    try {
      return global.RMMarket?.getLastMorningBias?.() || null;
    } catch (_) {
      return null;
    }
  }

  function newsValidated() {
    return (
      !!document.querySelector(".pick-row .pick-news-ok, .pick-row[data-news='ok']") ||
      !!global.RMHeaderMood?._newsValidated
    );
  }

  function computeC1(bias, stage) {
    const col = getCharter().columns?.c1_pulse || {};
    const m = bias?.market;
    if (!m || m.score == null || Number.isNaN(m.score)) return emptyContract(stage);

    const signed = clamp(m.score, -1, 1);
    const band = bandLabel(signed, col.bands);
    const gates = col.gates || {};
    let gate = "wait";
    if (signed <= (gates.stop_signed_below ?? -0.35)) gate = "stop";
    else if (signed >= (gates.go_signed_above ?? 0.18)) gate = "go";

    const signals = [];
    if (m.kicker) signals.push(String(m.kicker));
    signals.push(leanLabel(leanFromSigned(signed)));

    let posture;
    if (stage === "research") posture = "Overnight: " + band;
    else if (stage === "reflect") posture = "Bias: " + band;
    else posture = band + " · " + leanLabel(leanFromSigned(signed));

    return buildContract({
      signed,
      stage,
      posture,
      signals,
      gate,
      colKey: "c1_pulse",
      signalCount: signals.length,
    });
  }

  function computeC3(bias, stage, pulseGate) {
    const col = getCharter().columns?.c3_trades || {};
    const h = bias?.h001;
    const picks = document.querySelectorAll(".pick-row").length;
    if (!picks || !h || h.score == null || Number.isNaN(h.score)) return emptyContract(stage);

    const newsOk = newsValidated();
    let signed = h.score * (newsOk ? 1 : 0.85);
    signed = clamp(signed, -1, 1);
    const band = bandLabel(signed, col.bands);
    const gates = col.gates || {};
    const topRm = document.querySelector(".pick-row")?.dataset?.rm;
    const rmVal = topRm ? parseFloat(topRm, 10) : null;

    let gate = "wait";
    if (pulseGate === "stop" && gates.stop_when_pulse_stop) gate = "stop";
    else if (!newsOk && gates.go_news_required) gate = "wait";
    else if (rmVal != null && rmVal < (gates.go_rm_min ?? 55)) gate = "wait";
    else if (signed >= (col.greenlit_signed ?? 0.2)) gate = "go";

    const signals = [picks + " names", newsOk ? "News OK" : "News pending"];
    if (rmVal != null) signals.push("RM " + Math.round(rmVal));

    let posture;
    if (stage === "research") posture = "Scan: " + picks + " names";
    else if (stage === "plan") posture = "Pick: " + band + (rmVal ? " · RM " + Math.round(rmVal) : "");
    else if (stage === "reflect") posture = "Setups: " + band;
    else posture = "Active: " + picks + " planned";

    return buildContract({
      signed,
      stage,
      posture,
      signals,
      gate,
      colKey: "c3_trades",
      signalCount: signals.length,
    });
  }

  function sessionVwap(bars) {
    let pv = 0;
    let vol = 0;
    for (const b of bars) {
      const v = Number(b.volume) || 0;
      const typical = ((b.high ?? b.close) + (b.low ?? b.close) + (b.close ?? 0)) / 3;
      pv += typical * v;
      vol += v;
    }
    return vol > 0 ? pv / vol : null;
  }

  function computeC2(stage) {
    const col = getCharter().columns?.c2_shape || {};
    const chart = global.RMAnalysisChart;
    const st = chart?.state;
    const bars = st?.bars;

    if (stage === "research") {
      return buildContract({
        signed: 0,
        stage,
        posture: "—",
        signals: ["No symbol"],
        gate: "wait",
        colKey: "c2_shape",
        signalCount: 0,
      });
    }

    if (!st || !bars || bars.length < 4) return emptyContract(stage);

    const last = bars[bars.length - 1];
    const lastClose = last?.close;
    const first = bars[0];
    if (lastClose == null || !first) return emptyContract(stage);

    let signed = 0;
    let signalCount = 0;
    const signals = [];

    const base = first.open ?? first.close;
    if (base) {
      const trend = (lastClose - base) / base;
      signed += clamp(trend * 18, -0.35, 0.35);
      signalCount++;
      signals.push(lastClose >= base ? "Above open" : "Below open");
    }

    const vwap = sessionVwap(bars);
    if (vwap) {
      signed += lastClose >= vwap ? 0.22 : -0.22;
      signalCount++;
      signals.push(lastClose >= vwap ? "Above VWAP" : "Below VWAP");
    }

    const orh = st.tradePlan?.orh;
    if (orh != null) {
      signed += lastClose >= orh ? 0.2 : -0.12;
      signalCount++;
      signals.push(lastClose >= orh ? "ORH break" : "Below ORH");
    }

    const plan = st.tradePlan;
    const hasPlan = plan?.entry != null && plan?.stop != null;
    signed = clamp(signed, -1, 1);
    const band = bandLabel(signed, col.bands);
    const gates = col.gates || {};

    let gate = "wait";
    if (gates.wait_without_plan && !hasPlan && (stage === "plan" || stage === "open")) {
      gate = "wait";
    } else if (signalCount >= (gates.go_signals_min ?? 2) && signed >= (col.greenlit_signed ?? 0.2)) {
      gate = "go";
    } else if (signed <= -0.25) gate = "stop";

    let posture;
    if (stage === "plan") posture = hasPlan ? "Plan: ORH defined" : "Plan: define entry/stop";
    else if (stage === "reflect") posture = "Process: " + band;
    else posture = "Structure: " + band;

    return buildContract({
      signed,
      stage,
      posture,
      signals,
      gate,
      colKey: "c2_shape",
      signalCount,
    });
  }

  function fuseRaw(c1, c2, c3, charge) {
    const c = getCharter();
    const bucket = sessionBucket();
    const w = c.fusion?.session_weights?.[bucket] || { c1: 0.4, c2: 0.35, c3: 0.25 };
    const gateMap = c.fusion?.gate_lean_map || DEFAULT_CHARTER.fusion.gate_lean_map;

    function gateSigned(col) {
      if (col.gate === "stop") return gateMap.stop ?? -0.55;
      if (col.gate === "wait") return gateMap.wait ?? 0;
      if (col.gate === "go") {
        return col.lean === "bear" ? (gateMap.go_bear ?? -0.35) : (gateMap.go_bull ?? 0.35);
      }
      return col.internalSigned ?? 0;
    }

    const cols = [
      { col: c1, weight: w.c1 ?? 0.4 },
      { col: c2, weight: w.c2 ?? 0.35 },
      { col: c3, weight: w.c3 ?? 0.25 },
    ];

    let raw = 0;
    let wsum = 0;
    let have = false;
    cols.forEach(({ col, weight }) => {
      const g = gateSigned(col);
      const blend = c.fusion?.charge_from_gates
        ? g * 0.65 + (col.internalSigned ?? 0) * 0.35
        : col.internalSigned ?? 0;
      if (col.gate !== "wait" || col.internalSigned !== 0) {
        raw += blend * weight;
        wsum += weight;
        have = true;
      }
    });

    if (!have) return null;
    raw = wsum > 0 ? raw / wsum : raw;
    if (charge >= 3) raw = clamp(raw * 1.15, -1, 1);
    return clamp(raw, -1, 1);
  }

  function storyReadiness(c1, c2, c3, briefLoaded) {
    const hw = getCharter().header?.readiness_weights || DEFAULT_CHARTER.header.readiness_weights;
    if (!getCharter().header?.story_readiness) return null;
    let pct = 0;
    if (c1.gate === "go") pct += (hw.pulse_gate_go ?? 0.35) * 100;
    const plan = global.RMAnalysisChart?.state?.tradePlan;
    if (plan?.entry != null && plan?.stop != null) pct += (hw.shape_plan_defined ?? 0.25) * 100;
    if (newsValidated() && document.querySelectorAll(".pick-row").length) {
      pct += (hw.trades_pick_validated ?? 0.25) * 100;
    }
    if (briefLoaded) pct += (hw.brief_generated ?? 0.15) * 100;
    return Math.round(Math.min(100, pct));
  }

  let lastBriefLoaded = false;

  function setMorningBriefLoaded(loaded) {
    lastBriefLoaded = !!loaded;
  }

  function compute() {
    const stage = resolveTradeStoryStage();
    const bias = morningBias();
    const c1 = computeC1(bias, stage);
    const c2 = computeC2(stage);
    const c3 = computeC3(bias, stage, c1.gate);

    const cols = [c1, c2, c3];
    const charge = cols.filter((c) => c.greenLit).length;
    const raw = fuseRaw(c1, c2, c3, charge);
    if (raw == null) return null;

    const readiness = storyReadiness(c1, c2, c3, lastBriefLoaded);

    return {
      c1,
      c2,
      c3,
      columns: cols,
      charge,
      raw,
      stage,
      storyReadiness: readiness,
    };
  }

  loadCharter();

  global.RMColumnKPI = {
    compute,
    computeC1,
    computeC2,
    computeC3,
    loadCharter,
    getCharter,
    resolveTradeStoryStage,
    setMorningBriefLoaded,
    sessionBucket,
    GREENLIT_SCORE: 62,
  };
})(typeof window !== "undefined" ? window : globalThis);
