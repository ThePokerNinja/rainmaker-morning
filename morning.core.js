/* --- morning_metrics.js --- */
/**
 * Morning metrics - Phase 0 instrumentation substrate.
 *
 * A tiny, dependency-free event log so we can measure the product's north-star:
 *   Morning Active Rate = % of trading days the verdict is opened BEFORE 9:30 ET.
 * Secondary:
 *   Conviction-Follow Rate = % of non-neutral-verdict days a trade was also opened
 *   (v0 approximation - refine once trade side/direction is tracked).
 *
 * Storage: localStorage ring buffer `rm_events_v1` (500-event cap), mirroring the
 * `rm_morning_bias_log_v1` pattern. Optionally beacons each event to rm_api at
 * `/metrics/event` (best-effort, non-blocking, silently ignored if unavailable).
 *
 * Events: morning_open ? verdict_view ? trade_open ? trade_close.
 * `morning_open` and `verdict_view` are deduped to the FIRST occurrence per ET day
 * (so Active Rate is day-accurate and the buffer stays clean). Trades log every time.
 */
(function (global) {
  const STORAGE_KEY = "rm_events_v1";
  const MAX_EVENTS = 500;
  const ET_TZ = "America/New_York";
  const MARKET_OPEN_MIN = 9 * 60 + 30; // 9:30 ET

  /* ---- ET time helpers ---- */
  function etParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ET_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date || new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    let hour = Number(get("hour"));
    if (hour === 24) hour = 0; // some engines emit 24 at midnight
    const minute = Number(get("minute"));
    return {
      etDate: `${get("year")}-${get("month")}-${get("day")}`,
      weekday: get("weekday"),
      etMin: hour * 60 + minute,
    };
  }

  function isWeekday(weekday) {
    return weekday !== "Sat" && weekday !== "Sun";
  }

  /* ---- storage ---- */
  function load() {
    try {
      const raw = global.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function save(list) {
    try {
      const trimmed = list.slice(-MAX_EVENTS);
      global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch (_) {
      /* quota / disabled storage - metrics are best-effort */
    }
  }

  /* ---- rm_api beacon (best-effort) ---- */
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

  function beacon(ev) {
    const base = apiBase();
    if (!base) return;
    try {
      const url = base + "/metrics/event";
      const body = JSON.stringify(ev);
      if (global.navigator?.sendBeacon) {
        global.navigator.sendBeacon(url, body);
        return;
      }
      global.fetch?.(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (_) {
      /* endpoint may not exist yet - that's fine */
    }
  }

  /* ---- core ---- */
  function track(type, data) {
    if (!type) return null;
    const now = new Date();
    const { etDate, weekday, etMin } = etParts(now);
    const ev = {
      type,
      t: now.getTime(),
      iso: now.toISOString(),
      etDate,
      weekday,
      etMin,
      ...(data && typeof data === "object" ? data : {}),
    };
    const list = load();
    list.push(ev);
    save(list);
    beacon(ev);
    return ev;
  }

  function hasEventToday(type, etDate) {
    return load().some((e) => e.type === type && e.etDate === etDate);
  }

  /** Log the first verdict open of the ET day (deduped). */
  function markMorningOpen(meta) {
    const { etDate } = etParts();
    if (hasEventToday("morning_open", etDate)) return null;
    return track("morning_open", { ...(meta || {}) });
  }

  /** Log the first resolved verdict shown today (deduped). */
  function markVerdictView(verdict) {
    const { etDate } = etParts();
    if (hasEventToday("verdict_view", etDate)) return null;
    const tier = verdict?.tier || "neutral";
    const heat = Number(verdict?.heat ?? 0);
    return track("verdict_view", {
      tier,
      heat,
      direction: heat > 0 ? "bull" : heat < 0 ? "bear" : "neutral",
      mode: verdict?.mode || "auto",
    });
  }

  /** Snapshot the green-light contract at the moment a trade is opened. */
  function greenLitSnapshot() {
    try {
      const kpi =
        global.RMColumnKPI?.compute?.() ||
        global.RMHeaderMood?.getState?.()?.kpi ||
        null;
      if (!kpi) return {};
      return {
        green_lit: kpi.charge,
        c1_score: kpi.c1?.score ?? null,
        c2_score: kpi.c2?.score ?? null,
        c3_score: kpi.c3?.score ?? null,
        c1_lit: !!kpi.c1?.greenLit,
        c2_lit: !!kpi.c2?.greenLit,
        c3_lit: !!kpi.c3?.greenLit,
      };
    } catch (_) {
      return {};
    }
  }

  function markTradeOpen(trade) {
    return track("trade_open", {
      symbol: trade?.symbol || null,
      side: trade?.side || "long",
      session_id: trade?.session_id || null,
      ...greenLitSnapshot(),
    });
  }

  function markTradeClose(trade) {
    return track("trade_close", {
      symbol: trade?.symbol || null,
      filled: trade?.filled !== false,
      r_multiple: trade?.r_multiple ?? null,
      source: trade?.source || null,
    });
  }

  /* ---- metrics ---- */
  function dayKeysBack(nDays) {
    const keys = [];
    const today = new Date();
    for (let i = 0; i < nDays; i++) {
      const d = new Date(today.getTime() - i * 86400000);
      const { etDate, weekday } = etParts(d);
      keys.push({ etDate, weekday });
    }
    return keys;
  }

  /**
   * Morning Active Rate over the last `nDays` calendar days.
   * Denominator = ET weekdays in the window (holidays ignored - v0).
   * Numerator   = those weekdays with a morning_open before 9:30 ET.
   */
  function activeRate(nDays = 20) {
    const events = load();
    const window = dayKeysBack(nDays).filter((d) => isWeekday(d.weekday));
    const weekdays = window.length;
    if (!weekdays) return { rate: 0, hit: 0, weekdays: 0, nDays };
    const dates = new Set(window.map((d) => d.etDate));
    const hitDates = new Set();
    for (const e of events) {
      if (e.type !== "morning_open") continue;
      if (!dates.has(e.etDate)) continue;
      if (e.etMin != null && e.etMin < MARKET_OPEN_MIN) hitDates.add(e.etDate);
    }
    return {
      rate: hitDates.size / weekdays,
      hit: hitDates.size,
      weekdays,
      nDays,
    };
  }

  /**
   * Conviction-Follow Rate (v0): of ET days with a non-neutral verdict_view,
   * the fraction that also recorded a trade_open.
   */
  function convictionFollowRate(nDays = 30) {
    const events = load();
    const dates = new Set(dayKeysBack(nDays).map((d) => d.etDate));
    const verdictDays = new Map(); // etDate -> direction
    const tradeDays = new Set();
    for (const e of events) {
      if (!dates.has(e.etDate)) continue;
      if (e.type === "verdict_view" && e.direction && e.direction !== "neutral") {
        if (!verdictDays.has(e.etDate)) verdictDays.set(e.etDate, e.direction);
      }
      if (e.type === "trade_open") tradeDays.add(e.etDate);
    }
    const eligible = verdictDays.size;
    if (!eligible) return { rate: 0, followed: 0, eligible: 0, nDays };
    let followed = 0;
    for (const d of verdictDays.keys()) if (tradeDays.has(d)) followed++;
    return { rate: followed / eligible, followed, eligible, nDays };
  }

  /**
   * Green-light validation (#5): does diligence pay?
   * Correlates each closed trade with the green-light count stamped at open
   * (matching the most recent unmatched trade_open for the same symbol), then
   * buckets win% / avg R by 0-3 lit columns. This is the data proof artifact.
   */
  function greenLitValidation(nDays = 120) {
    const events = load();
    const dates = new Set(dayKeysBack(nDays).map((d) => d.etDate));
    const openStack = new Map(); // symbol -> [open events]
    const buckets = {
      0: { n: 0, wins: 0, sumR: 0, rs: [] },
      1: { n: 0, wins: 0, sumR: 0, rs: [] },
      2: { n: 0, wins: 0, sumR: 0, rs: [] },
      3: { n: 0, wins: 0, sumR: 0, rs: [] },
    };
    for (const e of events) {
      if (!dates.has(e.etDate)) continue;
      const sym = e.symbol || "?";
      if (e.type === "trade_open") {
        if (!openStack.has(sym)) openStack.set(sym, []);
        openStack.get(sym).push(e);
      } else if (e.type === "trade_close") {
        const stack = openStack.get(sym);
        const open = stack && stack.length ? stack.pop() : null;
        if (e.filled === false) continue;
        const r = e.r_multiple;
        if (r == null || Number.isNaN(Number(r))) continue;
        const lit = Math.max(0, Math.min(3, Number(open?.green_lit ?? 0)));
        const b = buckets[lit];
        b.n++;
        if (Number(r) > 0) b.wins++;
        b.sumR += Number(r);
        b.rs.push(Number(r));
      }
    }
    const out = {};
    let total = 0;
    for (const k of [0, 1, 2, 3]) {
      const b = buckets[k];
      total += b.n;
      out[k] = {
        lit: k,
        trades: b.n,
        winRate: b.n ? b.wins / b.n : null,
        avgR: b.n ? b.sumR / b.n : null,
      };
    }
    return { buckets: out, total, nDays };
  }

  function summary(nDays = 20) {
    const events = load();
    const ar = activeRate(nDays);
    const cf = convictionFollowRate(Math.max(nDays, 30));
    const lastOpen = [...events].reverse().find((e) => e.type === "morning_open");
    return {
      totalEvents: events.length,
      activeRate: ar,
      convictionFollowRate: cf,
      lastOpen: lastOpen?.iso || null,
    };
  }

  function getEvents() {
    return load();
  }

  function clear() {
    try {
      global.localStorage?.removeItem(STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  global.RMMetrics = {
    track,
    markMorningOpen,
    markVerdictView,
    markTradeOpen,
    markTradeClose,
    activeRate,
    convictionFollowRate,
    greenLitValidation,
    summary,
    getEvents,
    clear,
    STORAGE_KEY,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- column_kpi.js --- */
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

;
/* --- header_bg.js --- */
/**
 * Header background — self-hosted native <video> mood loops with cinematic treatment.
 *
 * Drop encoded loops into assets/header/ and they "just work":
 *   assets/header/bull.mp4      assets/header/bull-mobile.mp4 (optional)   assets/header/bull.webp (poster)
 *   assets/header/neutral.mp4   assets/header/neutral-mobile.mp4           assets/header/neutral.webp
 *   assets/header/bear.mp4      assets/header/bear-mobile.mp4              assets/header/bear.webp
 *
 * Mobile viewports load the *-mobile.mp4 variant when present and fall back to the
 * desktop file. Missing files degrade gracefully to the poster + gradient (never a
 * broken/blank header). Per-tier zoom + alignment + colour grade stay 100% in CSS.
 *
 * Forward-compat: set data-header-video-base on #headerBg (e.g. a CDN / R2 URL) to
 * serve the same filenames from elsewhere without code changes.
 */
(function (global) {
  const DEFAULT_BASE = "assets/header/";
  const MOBILE_MAX = 640;
  const DEFAULT_TREATMENT_ID = "soft-light";
  const REVEAL_DELAY_MS = 400;
  const REVEAL_FALLBACK_MS = 2800;

  function siteHeader() {
    return document.getElementById("siteHeader");
  }

  function headerBgHost() {
    return document.getElementById("headerBg");
  }

  function headerVideoEl() {
    const el = document.getElementById("headerBgPlayer");
    return el && el.tagName === "VIDEO" ? el : null;
  }

  function headerGifEl() {
    return document.getElementById("headerBgGif");
  }

  function headerPosterEl() {
    return document.getElementById("headerBgPoster");
  }

  function prefersReducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  function videoBase() {
    const host = headerBgHost();
    const base = host?.dataset.headerVideoBase;
    if (base) return base.replace(/\/?$/, "/");
    return DEFAULT_BASE;
  }

  function moodFamily(moodId) {
    const m = String(moodId || "neutral");
    if (m === "neutral") return "neutral";
    if (m.startsWith("bear")) return "bear";
    return "bull";
  }

  /** Signed conviction heat from a tier id (neutral=0, bull-2=+2, bear-3=-3). */
  function heatOf(moodId) {
    const m = String(moodId || "neutral");
    if (m === "neutral") return 0;
    const n = parseInt(m.split("-")[1] || "0", 10) || 0;
    return m.startsWith("bear") ? -n : n;
  }

  /** Extended-hours snow clip plays during pre/post when conviction is mild (|heat|<=1).
      Strong moves (|heat|>=2) escalate out to the real bull/bear footage. */
  function isExtendedSession() {
    const s = currentMarketSession();
    return s === "pre" || s === "post";
  }

  function extendedActive(moodId) {
    return isExtendedSession() && Math.abs(heatOf(moodId)) <= 1;
  }

  function resolveBgFamily(moodId) {
    if (extendedActive(moodId)) return "extended";
    return moodFamily(moodId);
  }

  function isMobileViewport() {
    try {
      return !!(global.matchMedia && global.matchMedia(`(max-width:${MOBILE_MAX}px)`).matches);
    } catch (_) {
      return false;
    }
  }

  function sourcesForFamily(fam) {
    const base = videoBase() + fam;
    const desktop = base + ".mp4";
    const mobile = base + "-mobile.mp4";
    return {
      primary: isMobileViewport() ? mobile : desktop,
      desktop,
      poster: base + ".webp",
      gif: base + "-lite.gif",
      preload: videoBase() + "neutral-preload.gif",
    };
  }

  function isMobileStaticMood() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function isWorkspaceBooting() {
    const ws = document.getElementById("morningWorkspace");
    return ws?.classList.contains("morning-workspace--booting");
  }

  /* ---- market session tint (unchanged) ---- */
  function getSessionFromClock() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find((p) => p.type === "weekday")?.value || "";
    if (weekday === "Sat" || weekday === "Sun") return "closed";
    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    const mins = hour * 60 + minute;
    if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
    if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
    if (mins >= 16 * 60 && mins < 20 * 60) return "post";
    return "closed";
  }

  let sessionOverride = null;

  function currentMarketSession() {
    if (sessionOverride) return sessionOverride;
    if (typeof global.RMChartHub !== "undefined" && RMChartHub.currentMarketSession) {
      return RMChartHub.currentMarketSession();
    }
    return getSessionFromClock();
  }

  let sessionTintTimer = null;
  let lastSessionTint = null;

  function applyMarketSessionTint() {
    const header = siteHeader();
    if (!header) return;
    const session = currentMarketSession();
    if (session === lastSessionTint) return;
    lastSessionTint = session;
    header.classList.remove(
      "header-session--pre",
      "header-session--post",
      "header-session--regular",
      "header-session--closed"
    );
    header.classList.add("header-session--" + (session || "closed"));
    header.dataset.marketSession = session;
    /* Session flip can change the extended/snow vs conviction clip — re-run the mood layer. */
    global.RMHeaderMood?.refresh?.();
  }

  function isHeaderFxLite() {
    return document.documentElement.classList.contains("header-fx-lite");
  }

  function startSessionTintWatch() {
    if (isHeaderFxLite()) return;
    applyMarketSessionTint();
    if (sessionTintTimer) return;
    sessionTintTimer = setInterval(applyMarketSessionTint, 60000);
    if (!global._rmHeaderSessionEvt) {
      global._rmHeaderSessionEvt = true;
      document.addEventListener("rm:market-session", applyMarketSessionTint);
    }
  }

  /* ---- sizing ---- */
  function headerVideoSize() {
    const header = siteHeader();
    const w = Math.max(320, header?.clientWidth || 320);
    const headerH = Math.max(80, header?.clientHeight || 0);
    const hByAspect = Math.round((w * 9) / 16);
    const h = Math.max(hByAspect, headerH);
    return { w, h };
  }

  function pinHeaderPlayerEl(el, h) {
    if (!el) return;
    el.classList.add("header-bg-yt-player");
    el.style.width = "100%";
    /* 16:9 box (taller than the band); object-fit:cover fills it, header overflow
       crops, and per-mood CSS anchors top/bottom/center. */
    el.style.height = h + "px";
    el.style.maxWidth = "none";
    /* Alignment + transform are CSS-only per data-mood. */
    el.style.removeProperty("position");
    el.style.removeProperty("top");
    el.style.removeProperty("bottom");
    el.style.removeProperty("left");
    el.style.removeProperty("right");
    el.style.removeProperty("transform");
    el.style.removeProperty("transform-origin");
  }

  function fitHeaderPlayer() {
    const { h } = headerVideoSize();
    const el = headerVideoEl();
    const wrap = el?.closest(".header-bg-yt-wrap");
    pinHeaderPlayerEl(el, h);
    pinHeaderPlayerEl(headerGifEl(), h);
    pinHeaderPlayerEl(headerPosterEl(), h);
    if (wrap) {
      wrap.style.width = "100%";
      wrap.style.height = "100%";
    }
  }

  /* ---- treatment + reveal (unchanged behaviour) ---- */
  function applyDefaultTreatment() {
    const header = siteHeader();
    if (!header) return;
    header.classList.remove(
      "header-treat--clean",
      "header-treat--multiply",
      "header-treat--screen",
      "header-treat--overlay",
      "header-treat--color-dodge",
      "header-treat--hard-light",
      "header-treat--aurora",
      "header-treat--ember",
      "header-treat--noir",
      "header-treat--hologram",
      "header-treat--scanline",
      "header-treat--difference",
      "header-treat--raincore"
    );
    header.classList.add("header-treat--" + DEFAULT_TREATMENT_ID);
    header.dataset.headerTreatment = DEFAULT_TREATMENT_ID;
  }

  function clearRevealState(host) {
    if (!host) return;
    host.classList.remove("is-revealed");
    delete host.dataset.revealed;
    siteHeader()?.classList.remove("header-shade-settling");
    if (host._rmRevealTimer) {
      clearTimeout(host._rmRevealTimer);
      host._rmRevealTimer = null;
    }
    if (host._rmRevealFallback) {
      clearTimeout(host._rmRevealFallback);
      host._rmRevealFallback = null;
    }
  }

  function revealHeaderBg(host) {
    if (!host || host.dataset.revealed === "1") return;
    host.dataset.revealed = "1";
    if (host._rmRevealFallback) {
      clearTimeout(host._rmRevealFallback);
      host._rmRevealFallback = null;
    }
    host._rmRevealTimer = setTimeout(() => {
      host._rmRevealTimer = null;
      host.classList.add("is-revealed");
      siteHeader()?.classList.add("header-shade-settling");
    }, REVEAL_DELAY_MS);
  }

  function scheduleRevealFallback(host) {
    if (!host || host.dataset.revealed === "1" || host._rmRevealFallback) return;
    host._rmRevealFallback = setTimeout(() => {
      host._rmRevealFallback = null;
      revealHeaderBg(host);
    }, REVEAL_FALLBACK_MS);
  }

  function mountClassicHeader(host) {
    if (!host) return;
    clearRevealState(host);
    host.innerHTML = '<div class="header-bg-fx" id="headerBgFx" aria-hidden="true"></div>';
    host.classList.remove("is-active");
    host.dataset.bgMode = "classic";
    const header = siteHeader();
    header?.classList.remove("has-header-video");
    header?.classList.remove("header-shade-settling");
    header?.classList.remove("header-treat--" + DEFAULT_TREATMENT_ID);
    header?.classList.remove(
      "header-session--pre",
      "header-session--post",
      "header-session--regular",
      "header-session--closed"
    );
    delete header?.dataset.marketSession;
    lastSessionTint = null;
  }

  /* ---- playback ---- */
  let videoPausedByApp = false;
  let requestedMediaTier = "full";
  let fpsForcedPoster = false;
  let appliedMediaTier = null;
  let mobilePreloadActive = false;
  let bootPreloadActive = false;

  function effectiveMediaTier() {
    if (document.visibilityState === "hidden" || prefersReducedMotion() || fpsForcedPoster) {
      return "poster";
    }
    if (isMobileStaticMood()) {
      if (mobilePreloadActive || isWorkspaceBooting()) return "preload";
      return "poster";
    }
    if (bootPreloadActive || isWorkspaceBooting()) return "preload";
    return requestedMediaTier;
  }

  function setGifSource(gifEl, src, posterFallback) {
    if (!gifEl) return;
    if (gifEl.dataset.src === src) return;
    gifEl.dataset.src = src;
    gifEl.src = src;
    gifEl.onerror = () => {
      const tier = effectiveMediaTier();
      const neutral = sourcesForFamily("neutral");
      const fallbacks =
        tier === "preload"
          ? [neutral.gif, neutral.poster]
          : posterFallback
            ? [posterFallback]
            : [];
      const next = fallbacks.find((fb) => fb && gifEl.dataset.src !== fb);
      if (next) {
        gifEl.dataset.src = "";
        setGifSource(gifEl, next, posterFallback);
        return;
      }
      gifEl.hidden = true;
      gifEl.classList.remove("is-active");
      if (posterFallback && (tier === "lite" || tier === "preload")) {
        const posterEl = headerPosterEl();
        setPosterSource(posterEl, posterFallback);
        posterEl?.classList.add("is-active");
        posterEl && (posterEl.hidden = false);
      }
    };
  }

  function setPosterSource(posterEl, src) {
    if (!posterEl) return;
    if (posterEl.dataset.src === src) return;
    posterEl.dataset.src = src;
    posterEl.src = src;
  }

  function applyMediaTier() {
    const host = headerBgHost();
    if (!host || host.dataset.bgMode !== "video") return;
    const tier = effectiveMediaTier();
    if (tier === appliedMediaTier) return;
    appliedMediaTier = tier;
    host.dataset.mediaTier = tier;

    const v = headerVideoEl();
    const wrap = v?.closest(".header-bg-yt-wrap");
    const gifEl = headerGifEl();
    const posterEl = headerPosterEl();
    const fam = host.dataset.moodFamily || resolveBgFamily(host.dataset.moodTier || "neutral");
    const src = sourcesForFamily(fam);
    const neutral = sourcesForFamily("neutral");

    wrap?.classList.toggle("is-tier-video-hidden", tier !== "full");
    wrap?.classList.toggle("is-tier-mobile-static", isMobileStaticMood());

    if (tier === "preload") {
      setGifSource(gifEl, src.preload, neutral.poster);
      if (gifEl) gifEl.hidden = false;
      gifEl?.classList.add("is-active");
      posterEl?.classList.remove("is-active");
      if (posterEl) posterEl.hidden = true;
      try {
        v?.pause();
      } catch (_) {}
      revealHeaderBg(host);
    } else if (tier === "lite") {
      gifEl?.classList.toggle("is-active", true);
      posterEl?.classList.toggle("is-active", false);
      setGifSource(gifEl, src.gif, src.poster);
      if (gifEl) gifEl.hidden = false;
      if (posterEl) posterEl.hidden = true;
      try {
        v?.pause();
      } catch (_) {}
    } else if (tier === "poster") {
      setPosterSource(posterEl, src.poster);
      if (posterEl) posterEl.hidden = false;
      posterEl?.classList.add("is-active");
      if (gifEl) {
        gifEl.classList.remove("is-active");
        gifEl.hidden = true;
      }
      try {
        v?.pause();
      } catch (_) {}
      revealHeaderBg(host);
    } else if (!videoPausedByApp && document.visibilityState !== "hidden") {
      gifEl?.classList.remove("is-active");
      posterEl?.classList.remove("is-active");
      playVideoSafe(v);
    }
  }

  function setMediaTier(tier) {
    if (isMobileStaticMood()) {
      if (tier === "preload") {
        mobilePreloadActive = true;
      } else {
        mobilePreloadActive = false;
        requestedMediaTier = "poster";
      }
      appliedMediaTier = null;
      applyMediaTier();
      return;
    }
    if (tier === "preload") {
      bootPreloadActive = true;
      appliedMediaTier = null;
      applyMediaTier();
      return;
    }
    bootPreloadActive = false;
    requestedMediaTier = tier === "lite" || tier === "poster" ? tier : "full";
    applyMediaTier();
  }

  function exitMobilePreload() {
    if (!isMobileStaticMood()) return;
    mobilePreloadActive = false;
    requestedMediaTier = "poster";
    appliedMediaTier = null;
    applyMediaTier();
  }

  function exitBootPreload() {
    if (isMobileStaticMood()) return;
    bootPreloadActive = false;
    requestedMediaTier = "full";
    appliedMediaTier = null;
    applyMediaTier();
  }

  function setFpsForcedPoster(forced) {
    fpsForcedPoster = !!forced;
    applyMediaTier();
  }

  function getMediaTier() {
    return effectiveMediaTier();
  }

  function playVideoSafe(v) {
    if (!v || videoPausedByApp || isMobileStaticMood() || effectiveMediaTier() !== "full") return;
    try {
      v.muted = true;
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  }

  function setVideoPaused(paused) {
    videoPausedByApp = !!paused;
    const v = headerVideoEl();
    if (!v) return;
    if (videoPausedByApp || effectiveMediaTier() !== "full") {
      try {
        v.pause();
      } catch (_) {}
    } else if (document.visibilityState !== "hidden") {
      playVideoSafe(v);
    }
  }

  function setPlaybackRate(rate) {
    if (isMobileStaticMood()) return;
    const v = headerVideoEl();
    if (!v) return;
    try {
      v.playbackRate = rate || 1;
    } catch (_) {}
  }

  function setVideoSource(v, primary, desktopFallback) {
    if (!v) return;
    v.dataset.fallback = desktopFallback || "";
    v.dataset.triedFallback = primary === desktopFallback ? "1" : "";
    v.src = primary;
    try {
      v.load();
    } catch (_) {}
    playVideoSafe(v);
  }

  function bindHeaderResize() {
    if (global._rmHeaderBgResize) return;
    global._rmHeaderBgResize = true;
    global.addEventListener("resize", () => {
      if (!document.querySelector(".header-bg.is-active")) return;
      fitHeaderPlayer();
    });
    /* Swap mobile/desktop variant when crossing the breakpoint. */
    try {
      const mql = global.matchMedia(`(max-width:${MOBILE_MAX}px)`);
      const onChange = () => {
        const host = headerBgHost();
        if (host && host.dataset.bgMode === "video") {
          const v = headerVideoEl();
          if (v) v.dataset.family = "";
          setVideoForMood(host.dataset.moodTier || "neutral");
        }
      };
      if (mql.addEventListener) mql.addEventListener("change", onChange);
      else if (mql.addListener) mql.addListener(onChange);
    } catch (_) {}
  }

  /* ---- mood → clip ---- */
  function currentMoodTier() {
    return (
      document.body?.dataset?.mood ||
      siteHeader()?.dataset?.mood ||
      headerBgHost()?.dataset?.moodTier ||
      "neutral"
    );
  }

  function setVideoForMood(moodId, opts) {
    const host = headerBgHost();
    if (!host) return;
    const tier = moodId || "neutral";
    host.dataset.moodTier = tier;
    if (host.dataset.bgMode !== "video") return;

    const v = headerVideoEl();
    if (!v) return;

    /* opts.family lets the mood layer force the snow clip for the clickable
       ext-bull/ext-bear preview states regardless of the clock. */
    const fam = opts?.family || resolveBgFamily(tier);
    const src = sourcesForFamily(fam);

    if (isMobileStaticMood()) {
      if (host.dataset.moodFamily !== fam) {
        host.dataset.moodFamily = fam;
        v.dataset.family = fam;
        setPosterSource(headerPosterEl(), src.poster);
        appliedMediaTier = null;
      }
      fitHeaderPlayer();
      applyMediaTier();
      return;
    }

    if (v.dataset.family !== fam) {
      v.dataset.family = fam;
      host.dataset.moodFamily = fam;
      v.poster = src.poster;
      setVideoSource(v, src.primary, src.desktop);
      setGifSource(headerGifEl(), src.gif, src.poster);
      setPosterSource(headerPosterEl(), src.poster);
      if (!host.classList.contains("is-revealed")) scheduleRevealFallback(host);
    } else {
      playVideoSafe(v);
    }
    fitHeaderPlayer();
    applyMediaTier();
    global.RMHeaderMood?.applyBgPlayback?.();
  }

  function activateHeaderBg(host) {
    host.classList.add("is-active");
    host.dataset.bgMode = "video";
    siteHeader()?.classList.add("has-header-video");
    applyDefaultTreatment();
    startSessionTintWatch();
  }

  function handleVideoError(v, host) {
    const fb = v.dataset.fallback;
    if (fb && v.dataset.triedFallback !== "1" && (v.currentSrc || v.src) !== fb) {
      v.dataset.triedFallback = "1";
      v.src = fb;
      try {
        v.load();
      } catch (_) {}
      playVideoSafe(v);
      return;
    }
    /* Both variants missing — keep structure (poster + gradient) and reveal so the
       header never sits hidden. Treatment/zoom/alignment CSS still apply. */
    revealHeaderBg(host);
  }

  function createVideo(host) {
    const fx = host.querySelector(".header-bg-fx");
    clearRevealState(host);
    host.innerHTML = "";
    if (fx) host.appendChild(fx);

    const wrap = document.createElement("div");
    wrap.className = "header-bg-yt-wrap";

    const v = document.createElement("video");
    v.id = "headerBgPlayer";
    v.className = "header-bg-yt-mount header-bg-yt-player";
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute("muted", "");
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.preload = "auto";
    v.tabIndex = -1;
    v.setAttribute("aria-hidden", "true");
    try {
      v.disablePictureInPicture = true;
    } catch (_) {}

    v.addEventListener("playing", () => {
      wrap.classList.add("is-ready");
      revealHeaderBg(host);
      global.RMHeaderMood?.applyBgPlayback?.();
    });
    v.addEventListener("canplay", () => {
      wrap.classList.add("is-ready");
      revealHeaderBg(host);
    });
    v.addEventListener("loadeddata", () => playVideoSafe(v));
    v.addEventListener("error", () => handleVideoError(v, host));
    v.addEventListener("stalled", () => playVideoSafe(v));

    wrap.appendChild(v);

    const gif = document.createElement("img");
    gif.id = "headerBgGif";
    gif.className = "header-bg-gif header-bg-yt-player";
    gif.alt = "";
    gif.hidden = true;
    gif.setAttribute("aria-hidden", "true");
    wrap.appendChild(gif);

    const poster = document.createElement("img");
    poster.id = "headerBgPoster";
    poster.className = "header-bg-poster header-bg-yt-player";
    poster.alt = "";
    poster.hidden = true;
    poster.setAttribute("aria-hidden", "true");
    wrap.appendChild(poster);

    host.insertBefore(wrap, host.firstChild);

    activateHeaderBg(host);
    host.dataset.mounted = "1";

    fitHeaderPlayer();
    bindHeaderResize();
    scheduleRevealFallback(host);

    /* Initial clip for the current mood. */
    const v0 = headerVideoEl();
    if (v0) v0.dataset.family = "";
    if (isMobileStaticMood()) {
      mobilePreloadActive = isWorkspaceBooting();
      requestedMediaTier = "poster";
    }
    setVideoForMood(currentMoodTier());
  }

  function mount(host) {
    if (!host || host.dataset.mounted === "1") return;
    host.dataset.mounted = "1";
    host.dataset.moodTier = currentMoodTier();
    createVideo(host);
  }

  function init() {
    startSessionTintWatch();
    mount(headerBgHost());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.RMHeaderBg = {
    init,
    mount,
    mountClassicHeader,
    fitHeaderPlayer,
    setVideoForMood,
    setVideoPaused,
    setMediaTier,
    setFpsForcedPoster,
    getMediaTier,
    exitMobilePreload,
    exitBootPreload,
    isMobileStaticMood,
    setPlaybackRate,
    moodFamily,
    resolveBgFamily,
    extendedActive,
    applyMarketSessionTint,
    currentMarketSession,
    __setSessionOverride(s) {
      sessionOverride = s || null;
      applyMarketSessionTint();
    },
    DEFAULT_TREATMENT_ID,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- header_mood.js --- */
/**
 * Header "Conviction Engine" — fuses Morning Pulse bias + chart setups + news-validated
 * scans into a single mood (heat -3..+3) that themes the header and the three panels.
 *
 * Boot: neutral → auto when workspace finishes loading.
 * Header background: click left/right of logo to step bear◄►bull; boot → auto.
 */
(function (global) {
  const POLL_MS = 4000;

  const TIERS = [
    {
      id: "bear-3",
      heat: -3,
      kicker: "Risk-off",
      line: "Every read says step back — pulse, charts and tape all against you.",
    },
    {
      id: "bear-2",
      heat: -2,
      kicker: "Defense up",
      line: "Pressure's building and the setups aren't paying today.",
    },
    {
      id: "bear-1",
      heat: -1,
      kicker: "Caution",
      line: "A bearish tilt is forming — keep size light.",
    },
    {
      id: "neutral",
      heat: 0,
      kicker: "Undecided",
      line: "Mixed signals. The tape hasn't picked a side yet.",
    },
    {
      id: "bull-1",
      heat: 1,
      kicker: "Warming up",
      line: "A bullish lean is forming — watch for confirmation.",
    },
    {
      id: "bull-2",
      heat: 2,
      kicker: "In your favour",
      line: "Pulse and setups agree — momentum is with you.",
    },
    {
      id: "bull-3",
      heat: 3,
      kicker: "Fully aligned",
      line: "Confirmed top to bottom — pulse, charts and news all agree.",
    },
  ];

  const BY_ID = Object.fromEntries(TIERS.map((t) => [t.id, t]));

  /** Preview ramp: center → bull +3 → bear -3 (one step per click). */
  const PREVIEW_RAMP = [
    "neutral",
    "bull-1",
    "bull-2",
    "bull-3",
    "bear-1",
    "bear-2",
    "bear-3",
  ];

  /** Clickable preview-only extended-hours treatments that flank neutral.
      Render as the snow clip with a mild lean (reuses bull-1 / bear-1 grade + copy). */
  const EXT_PREVIEW = {
    "ext-bull": { base: "bull-1", lean: "bull" },
    "ext-bear": { base: "bear-1", lean: "bear" },
  };

  /** Left→right thermometer for click-to-navigate. Extended (snow) treatments sit
      between neutral and the first conviction tier on each side. */
  const HEAT_AXIS = [
    "bear-3",
    "bear-2",
    "bear-1",
    "ext-bear",
    "neutral",
    "ext-bull",
    "bull-1",
    "bull-2",
    "bull-3",
  ];

  /** Extended-hours (pre/post) copy. Snow clip is a "varying neutral": mild lean only
      (heat -1/0/+1). Keyed by session then signed heat. Strong moves escalate to bull/bear. */
  const EXTENDED_COPY = {
    pre: {
      "1": { kicker: "Pre-market bid", line: "Early buyers are leaning in ahead of the open." },
      "0": { kicker: "Pre-market", line: "Futures are trading — the regular session hasn't opened yet." },
      "-1": { kicker: "Pre-market risk", line: "Sellers are pressing pre-open — keep size light into the bell." },
    },
    post: {
      "1": { kicker: "After-hours bid", line: "Buyers are carrying strength into the evening tape." },
      "0": { kicker: "After-hours", line: "Regular session's closed — extended tape is thin." },
      "-1": { kicker: "After-hours risk", line: "Late selling pressure — protect the day's gains." },
    },
  };

  /** Preview-only speed: ±1 + ±2 normal (CSS handles ±2 zoom), ±3 double-speed. Auto/neutral stay 1×. */
  const BG_PLAYBACK = {
    "bull-2": 1,
    "bull-3": 2,
    "bear-2": 1,
    "bear-3": 2,
  };

  let previewMode = "neutral";
  let rampDir = 1;
  let userHasPreviewed = false;
  let bootObserver = null;
  let currentTierId = "neutral";
  let pollTimer = null;

  function siteHeader() {
    return document.getElementById("siteHeader");
  }

  function isWorkspaceBooting() {
    return !!document
      .getElementById("morningWorkspace")
      ?.classList.contains("morning-workspace--booting");
  }

  function tierFromRaw(raw) {
    if (raw == null || Number.isNaN(raw)) return "neutral";
    if (raw >= 0.5) return "bull-3";
    if (raw >= 0.28) return "bull-2";
    if (raw >= 0.1) return "bull-1";
    if (raw <= -0.5) return "bear-3";
    if (raw <= -0.28) return "bear-2";
    if (raw <= -0.1) return "bear-1";
    return "neutral";
  }

  let lastKpi = null;

  function autoRaw() {
    // Preferred path: consume the explicit per-column KPI contract so the
    // header heat and the green-light charge share one source of truth.
    if (typeof global.RMColumnKPI !== "undefined") {
      const kpi = global.RMColumnKPI.compute();
      lastKpi = kpi;
      if (kpi) return kpi.raw;
    }

    // Fallback (KPI module absent): legacy DOM-count blend.
    lastKpi = null;
    let raw = 0;
    let have = false;

    const bias = global.RMMarket?.getLastMorningBias?.();
    if (bias?.market?.score != null && !Number.isNaN(bias.market.score)) {
      raw += bias.market.score * 0.6;
      have = true;
    }

    const picks = document.querySelectorAll(".pick-row").length;
    if (picks && bias?.h001?.score != null && !Number.isNaN(bias.h001.score)) {
      raw += bias.h001.score * 0.4;
      have = true;
    }

    const setups = document.querySelectorAll(
      ".ca-buy-bag, .chart-hub-unified .ca-entry, [data-trade-marker]"
    ).length;
    if (setups && raw !== 0) {
      raw += Math.sign(raw) * Math.min(0.15, setups * 0.03);
      have = true;
    }

    if (!have) return null;

    const newsValidated =
      !!document.querySelector(".pick-row .pick-news-ok, .pick-row[data-news='ok']") ||
      !!global.RMHeaderMood?._newsValidated;
    if (picks) raw *= newsValidated ? 1.3 : 1.12;

    return Math.max(-1, Math.min(1, raw));
  }

  function resolveTierId() {
    if (previewMode !== "auto") return previewMode;
    return tierFromRaw(autoRaw());
  }

  function renderCopy(tier, extendedSession) {
    const el = document.getElementById("headerMoodCopy");
    if (!el) return;
    const heat = tier.heat;
    let kicker = tier.kicker;
    let line = tier.line;
    if (extendedSession) {
      const ext = EXTENDED_COPY[extendedSession]?.[String(heat)];
      if (ext) {
        kicker = ext.kicker;
        line = ext.line;
      }
    }
    if (previewMode === "auto" && lastKpi?.stage) {
      const stageLabel = String(lastKpi.stage).replace(/^\w/, (c) => c.toUpperCase());
      kicker = stageLabel + " · " + kicker;
    }
    const pips = [-3, -2, -1, 1, 2, 3].map((slot) => {
      const side = slot < 0 ? "bear" : "bull";
      const on =
        (heat > 0 && slot > 0 && slot <= heat) ||
        (heat < 0 && slot < 0 && slot >= heat);
      return '<i class="hm-pip hm-pip--' + side + (on ? " is-on" : "") + '"></i>';
    });
    pips.splice(3, 0, '<i class="hm-core' + (heat === 0 ? " is-on" : "") + '"></i>');

    el.innerHTML =
      '<p class="hm-kicker">' +
      kicker +
      "</p>" +
      '<span class="hm-gauge" aria-hidden="true">' +
      pips.join("") +
      "</span>" +
      '<p class="hm-line">' +
      line +
      "</p>";
    el.setAttribute(
      "aria-label",
      "Market conviction: " + kicker + ". " + line
    );
  }

  const PANEL = {
    c1: ".ws-panel--market",
    c2: ".ws-panel--chart",
    c3: ".ws-panel--scans",
  };

  /** Remove Trade Story column/header chrome (not approved for live UI). */
  function clearTradeStoryChrome() {
    document.querySelectorAll(".ws-col-conf, .hm-readiness").forEach((el) => el.remove());
  }

  // Strip the legacy green-light dot if an older render left one behind.
  function removeLegacyDot(panelSel) {
    const dot = document.querySelector(panelSel + " .col-greenlight");
    if (dot) dot.remove();
  }

  // Remove the old "0/3 lit" charge meter if a previous build rendered it.
  function clearChargeMeter() {
    const copy = document.getElementById("headerMoodCopy");
    const meter = copy?.querySelector(".hm-charge");
    if (meter) meter.remove();
  }

  function applyChargeState() {
    const kpi = lastKpi;
    const header = siteHeader();
    const charge = kpi ? kpi.charge : 0;
    if (header) {
      header.dataset.charge = String(charge);
      header.classList.toggle("is-fully-charged", charge >= 3);
    }
    document.body.dataset.charge = String(charge);
    document.body.classList.toggle("is-fully-charged", charge >= 3);
    clearTradeStoryChrome();
    removeLegacyDot(PANEL.c1);
    removeLegacyDot(PANEL.c2);
    removeLegacyDot(PANEL.c3);
    clearChargeMeter();
  }

  function playbackRateForTier(tierId) {
    if (previewMode === "auto" || tierId === "neutral") return 1;
    return BG_PLAYBACK[tierId] ?? 1;
  }

  function setYtPlaybackRate(rate) {
    try {
      global.RMHeaderBg?.setPlaybackRate?.(rate);
    } catch (_) {}
  }

  let playbackApplyToken = 0;

  function isMobileStaticMood() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function applyBgPlaybackForTier(tierId) {
    if (isMobileStaticMood()) return;
    const rate = playbackRateForTier(tierId);
    const token = ++playbackApplyToken;
    const apply = () => {
      if (token !== playbackApplyToken) return;
      setYtPlaybackRate(rate);
    };
    apply();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(apply);
    }
    setTimeout(apply, 400);
  }

  function applyBgPlayback() {
    applyBgPlaybackForTier(currentTierId);
  }

  function applyTier(tierId) {
    const header = siteHeader();
    const extPreview = EXT_PREVIEW[tierId];
    const tier = BY_ID[extPreview ? extPreview.base : tierId] || BY_ID.neutral;
    currentTierId = tierId;

    /* Extended snow shows when explicitly previewed (ext-bull/ext-bear) OR, in
       auto/live mode, when the clock is pre/post and conviction is mild. */
    const extended =
      !!extPreview || global.RMHeaderBg?.resolveBgFamily?.(tier.id) === "extended";
    let extendedSession = null;
    if (extended) {
      const s = global.RMHeaderBg?.currentMarketSession?.();
      extendedSession = s === "post" ? "post" : "pre";
    }

    if (header) {
      header.dataset.mood = tier.id;
      header.dataset.moodHeat = String(tier.heat);
      header.classList.toggle("header-bg-extended", extended);
      if (extended) header.dataset.extendedSession = extendedSession;
      else delete header.dataset.extendedSession;
    }
    document.body.dataset.mood = tier.id;
    document.body.dataset.moodHeat = String(tier.heat);
    renderCopy(tier, extendedSession);
    applyChargeState();
    if (typeof global.RMHeaderBg !== "undefined") {
      global.RMHeaderBg.setVideoForMood(tier.id, extended ? { family: "extended" } : undefined);
      global.RMHeaderBg.fitHeaderPlayer?.();
    }
    applyBgPlaybackForTier(tier.id);
  }

  function refresh() {
    applyTier(resolveTierId());
  }

  function enterAutoFromBoot() {
    if (userHasPreviewed) return;
    if (previewMode !== "neutral") return;
    previewMode = "auto";
    rampDir = 1;

    const resumeHeaderMedia = () => {
      resumePoll();
      refresh();
      if (isMobileStaticMood()) {
        global.RMHeaderBg?.exitMobilePreload?.();
        global.dispatchEvent(new CustomEvent("rm:mobile-mood-resolved"));
      } else {
        global.RMHeaderBg?.exitBootPreload?.();
      }
      global.syncBackgroundActivity?.();
      if (typeof global.RMMetrics !== "undefined") {
        const base = EXT_PREVIEW[currentTierId]?.base || currentTierId;
        global.RMMetrics.markVerdictView({
          tier: currentTierId,
          heat: BY_ID[base]?.heat ?? 0,
          mode: "auto",
        });
      }
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(resumeHeaderMedia, { timeout: 450 });
    } else {
      setTimeout(resumeHeaderMedia, 400);
    }
  }

  function watchBootToAuto() {
    const ws = document.getElementById("morningWorkspace");
    if (!ws) {
      setTimeout(enterAutoFromBoot, 1200);
      return;
    }
    if (!ws.classList.contains("morning-workspace--booting")) {
      enterAutoFromBoot();
      return;
    }
    if (bootObserver) return;
    bootObserver = new MutationObserver(() => {
      if (!ws.classList.contains("morning-workspace--booting")) {
        bootObserver.disconnect();
        bootObserver = null;
        enterAutoFromBoot();
      }
    });
    bootObserver.observe(ws, { attributes: true, attributeFilter: ["class"] });
  }

  function setPreview(tierIdOrNull) {
    if (tierIdOrNull && (BY_ID[tierIdOrNull] || EXT_PREVIEW[tierIdOrNull])) {
      userHasPreviewed = true;
      previewMode = tierIdOrNull;
      const idx = PREVIEW_RAMP.indexOf(tierIdOrNull);
      if (idx >= 0) {
        rampDir = idx >= PREVIEW_RAMP.length - 1 ? -1 : 1;
      }
    } else {
      previewMode = "auto";
      rampDir = 1;
    }
    refresh();
  }

  /** Current spot on the bear◄►bull ladder (auto → wherever live signals resolve). */
  function currentAxisIndex() {
    const id = previewMode === "auto" ? resolveTierId() : previewMode;
    const idx = HEAT_AXIS.indexOf(id);
    return idx < 0 ? HEAT_AXIS.indexOf("neutral") : idx;
  }

  /** Step one tier toward bull (dir > 0) or bear (dir < 0), clamped at the ends. */
  function stepMood(dir) {
    if (!dir) return;
    const idx = currentAxisIndex();
    const next = Math.max(
      0,
      Math.min(HEAT_AXIS.length - 1, idx + (dir > 0 ? 1 : -1))
    );
    if (next === idx && previewMode !== "auto") return;
    setPreview(HEAT_AXIS[next]);
  }

  /** Click in the header background: right of the logo = hotter, left = cooler. */
  function onHeaderZoneClick(e) {
    if (e.target.closest("button, a, input, select, textarea, [role='button']")) {
      return;
    }
    const header = siteHeader();
    if (!header) return;
    const logo =
      document.getElementById("brandLogoStack") || header.querySelector(".brand");
    let centerX;
    if (logo) {
      const r = logo.getBoundingClientRect();
      centerX = r.left + r.width / 2;
    } else {
      const hr = header.getBoundingClientRect();
      centerX = hr.left + hr.width / 2;
    }
    stepMood(e.clientX >= centerX ? 1 : -1);
  }

  function pausePoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function resumePoll() {
    if (pollTimer || document.visibilityState === "hidden") return;
    pollTimer = setInterval(refresh, POLL_MS);
  }

  function mount() {
    const header = siteHeader();
    if (header && !header.dataset.zoneBound) {
      header.dataset.zoneBound = "1";
      header.classList.add("header-mood-zones");
      header.addEventListener("click", onHeaderZoneClick);
    }
    applyTier("neutral");
    watchBootToAuto();
    if (isWorkspaceBooting()) pausePoll();
    else resumePoll();
    if (!global._rmMoodEvt) {
      global._rmMoodEvt = true;
      document.addEventListener("rm:market-session", refresh);
      document.addEventListener("rm:trade-closed", refresh);
      document.addEventListener("rm:trade-story", refresh);
      document.addEventListener("rm:morning-brief", refresh);
    }
  }

  function init() {
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.RMHeaderMood = {
    init,
    mount,
    refresh,
    pausePoll,
    resumePoll,
    applyBgPlayback,
    setPreview,
    stepMood,
    get _pollTimer() {
      return pollTimer;
    },
    getState: () => {
      const ext = EXT_PREVIEW[currentTierId];
      const baseId = ext ? ext.base : currentTierId;
      return {
        previewMode,
        tier: currentTierId,
        heat: BY_ID[baseId]?.heat ?? 0,
        rampDir,
        charge: lastKpi ? lastKpi.charge : 0,
        storyReadiness: lastKpi?.storyReadiness ?? null,
        stage: lastKpi?.stage ?? null,
        kpi: lastKpi,
      };
    },
    TIERS,
    PREVIEW_RAMP,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- brand_logo.js --- */
/**
 * Header logo — static PNG by default; animated MP4 while app is loading or scanning.
 * Desktop: canvas white-only loop (knocks out MP4 black). Mobile perf: always static PNG.
 */
(function (global) {
  const BLACK_CUTOFF = 48;
  const POLL_MS = 320;

  let syncDisplay = () => {};
  let layoutSizeCanvas = () => {};
  let logoPollTimer = null;

  function isHeaderFxLite() {
    return document.documentElement.classList.contains("header-fx-lite");
  }

  function isNativeShell() {
    return (
      document.documentElement.classList.contains("is-native-app") ||
      (global.Capacitor &&
        global.Capacitor.isNativePlatform &&
        global.Capacitor.isNativePlatform())
    );
  }

  function isMobilePerfLogo() {
    if (isNativeShell()) return false;
    return (
      isHeaderFxLite() ||
      (typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf())
    );
  }

  function wireAnimatedStack(stack, video, canvas, opts) {
    const btn = opts?.btn || null;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return null;

    let showingAnimated = !!opts?.forceAnimated;
    let rafId = 0;

    function sizeCanvas() {
      const w = stack.clientWidth || 120;
      const h = stack.clientHeight || 120;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawVideoContained(boxW, boxH) {
      const vw = video.videoWidth || 180;
      const vh = video.videoHeight || 180;
      const scale = Math.min(boxW / vw, boxH / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (boxW - dw) * 0.5;
      const dy = (boxH - dh) * 0.5;
      ctx.clearRect(0, 0, boxW, boxH);
      ctx.drawImage(video, dx, dy, dw, dh);
    }

    function paintWhiteOnly() {
      if (!showingAnimated || video.readyState < 2) return;
      const w = stack.clientWidth || 120;
      const h = stack.clientHeight || 120;
      drawVideoContained(w, h);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = frame.data;
      const span = 255 - BLACK_CUTOFF;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (lum <= BLACK_CUTOFF) {
          d[i + 3] = 0;
          continue;
        }
        const t = Math.min(1, (lum - BLACK_CUTOFF) / span);
        const a = Math.round(Math.pow(t, 1.35) * 255);
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = a;
      }
      ctx.putImageData(frame, 0, 0);
    }

    function stopLoop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function loop() {
      paintWhiteOnly();
      rafId = requestAnimationFrame(loop);
    }

    function setShowingAnimated(on) {
      const next = !!on;
      if (showingAnimated === next) return;
      showingAnimated = next;
      stack.classList.toggle("is-animated", showingAnimated);
      stack.classList.remove("is-animated-css");
      if (btn) {
        btn.setAttribute(
          "aria-label",
          showingAnimated
            ? "Rainmaker loading"
            : "Rainmaker logo — double-click for guide"
        );
        btn.title = showingAnimated ? "Loading…" : "Double-click: Rainmaker guide";
      }
      if (showingAnimated) {
        video.classList.add("brand-logo--video-src");
        video.classList.remove("brand-logo--video");
        video.hidden = true;
        canvas.hidden = false;
        canvas.removeAttribute("hidden");
        sizeCanvas();
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
        stopLoop();
        rafId = requestAnimationFrame(loop);
      } else {
        stopLoop();
        video.pause();
        video.classList.add("brand-logo--video-src");
        video.classList.remove("brand-logo--video");
        video.hidden = true;
        canvas.hidden = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    return { setShowingAnimated, sizeCanvas, stopLoop };
  }

  function isAppLogoBusy() {
    if (isMobilePerfLogo()) return false;
    const ws = document.getElementById("morningWorkspace");
    if (ws?.classList.contains("morning-workspace--booting")) return false;
    if (document.body.classList.contains("rm-scan-active")) return true;
    if (global.RMChartHub?.state?.scanActive) return true;
    const prog = document.getElementById("newsProgress");
    if (prog && !prog.classList.contains("hidden")) return true;
    return false;
  }

  function mountAuthSplash() {
    const stack = document.getElementById("authGateLogoStack");
    if (!stack) return;
    const video = stack.querySelector("video");
    const canvas = stack.querySelector("canvas");
    if (!video || !canvas) return;
    const wired = wireAnimatedStack(stack, video, canvas, { forceAnimated: true });
    if (!wired) return;
    wired.setShowingAnimated(true);
    global.addEventListener("resize", () => wired.sizeCanvas());
  }

  function mount() {
    const btn = document.getElementById("btnBrandGuide");
    const stack = document.getElementById("brandLogoStack");
    const video = document.getElementById("brandLogoVideo");
    const canvas = document.getElementById("brandLogoCanvas");
    if (!btn || !stack || !video || !canvas) return;

    if (!btn.dataset.focusBlurBound) {
      btn.dataset.focusBlurBound = "1";
      btn.addEventListener("pointerup", () => {
        if (btn.matches(":focus")) btn.blur();
      });
    }

    const wired = wireAnimatedStack(stack, video, canvas, { btn });
    if (!wired) return;

    const setShowingAnimated = wired.setShowingAnimated;
    const sizeCanvas = wired.sizeCanvas;

    syncDisplay = function sync() {
      setShowingAnimated(isAppLogoBusy());
    };
    layoutSizeCanvas = sizeCanvas;

    const ws = document.getElementById("morningWorkspace");
    const obs = new MutationObserver(() => syncDisplay());
    if (ws) {
      obs.observe(ws, { attributes: true, attributeFilter: ["class"] });
    }
    obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const prog = document.getElementById("newsProgress");
    if (prog) {
      obs.observe(prog, { attributes: true, attributeFilter: ["class"] });
    }
    logoPollTimer = setInterval(syncDisplay, POLL_MS);

    syncDisplay();

    global.addEventListener("resize", () => {
      if (stack.classList.contains("is-animated")) sizeCanvas();
    });

    global.addEventListener("rm:workspace-row", () => {
      requestAnimationFrame(() => {
        syncDisplay();
        if (stack.classList.contains("is-animated")) sizeCanvas();
      });
    });

    document.addEventListener("rm:scan-active", syncDisplay);
    document.addEventListener("rm:scan-done", syncDisplay);
  }

  function onHeaderLayout() {
    syncDisplay();
    if (document.getElementById("brandLogoStack")?.classList.contains("is-animated")) {
      layoutSizeCanvas();
    }
  }

  global.RMBrandLogo = {
    mount,
    mountAuthSplash,
    sync: () => syncDisplay(),
    onHeaderLayout,
    get _pollTimer() {
      return logoPollTimer;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- chunk_loader.js --- */
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

;
/* --- scan_parser.js --- */
/** Client-side Stock Hacker CSV parser (matches import_scans.py). */
(function (global) {
  const SYMBOL_KEYS = ["symbol", "sym", "ticker"];
  const CONFIDENCE_KEYS = [
    "rm_confidence",
    "rm confidence",
    "custom 1",
    "custom1",
    "confidence",
    "custom quote",
  ];
  const LAST_KEYS = ["last", "price"];
  const PCT_KEYS = ["%change", "pct change", "percent change", "net chng %"];
  const GAP_KEYS = ["gap", "gap %", "gap%", "pre market gap"];
  const VOLUME_KEYS = ["volume", "vol"];

  function isMomentumBullPick(p) {
    if (p.pct_change != null && Number(p.pct_change) < 0) return false;
    if (p.gap_pct != null && Number(p.gap_pct) < 0) return false;
    return true;
  }

  function normKey(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function pick(row, keys) {
    const normalized = {};
    for (const [k, v] of Object.entries(row)) {
      if (k != null) normalized[normKey(k)] = v;
    }
    for (const key of keys) {
      const val = normalized[normKey(key)];
      if (val != null && String(val).trim() !== "") return String(val).trim();
    }
    return null;
  }

  function parseFloatVal(value) {
    if (value == null) return null;
    const cleaned = String(value).replace(/,/g, "").replace(/%/g, "").trim();
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return Number.isNaN(n) ? null : n;
  }

  function findHeaderLine(lines) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toLowerCase().startsWith("symbol,")) return i;
      const cols = line.split(",").map((c) => c.trim());
      if (cols.some((c) => normKey(c) === "symbol")) return i;
    }
    return null;
  }

  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === "," && !inQ) {
        out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function parseCsvText(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
    const headerIdx = findHeaderLine(lines);
    if (headerIdx == null) throw new Error("No Symbol column found in CSV");

    const headers = parseCsvLine(lines[headerIdx]);
    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const vals = parseCsvLine(lines[i]);
      if (!vals.some((v) => v)) continue;
      const row = {};
      headers.forEach((h, j) => {
        row[h] = vals[j] ?? "";
      });
      rows.push(row);
    }
    return rows;
  }

  function parseScanCsvText(text, fileName) {
    const rows = parseCsvText(text);
    const picks = [];
    for (const row of rows) {
      let symbol = pick(row, SYMBOL_KEYS);
      if (!symbol) continue;
      symbol = symbol.toUpperCase();
      const pctChange = parseFloatVal(pick(row, PCT_KEYS));
      let gapPct = parseFloatVal(pick(row, GAP_KEYS));
      if (gapPct != null && gapPct < 0) gapPct = null;
      picks.push({
        symbol,
        rm_confidence: parseFloatVal(pick(row, CONFIDENCE_KEYS)),
        last: parseFloatVal(pick(row, LAST_KEYS)),
        pct_change: pctChange,
        gap_pct: gapPct,
        pct_eod: pctChange,
        volume: parseFloatVal(pick(row, VOLUME_KEYS)),
        catalyst: {
          status: "pending",
          proxy_only: true,
          verified: null,
          headline: null,
          source_url: null,
          headlines: [],
          rm_confidence_adjusted: null,
        },
      });
    }
    const filtered = picks.filter(isMomentumBullPick);
    picks.length = 0;
    picks.push(...filtered);
    picks.sort((a, b) => {
      const ca = a.rm_confidence == null;
      const cb = b.rm_confidence == null;
      if (ca !== cb) return ca ? 1 : -1;
      return (b.rm_confidence || 0) - (a.rm_confidence || 0);
    });
    picks.forEach((p, i) => {
      p.rank = i + 1;
    });

    const stem = (fileName || "scan").replace(/\.csv$/i, "");
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    return {
      hypothesis_id: "H-001",
      session_id: stem + "-imported-" + stamp,
      scanned_at: new Date().toISOString(),
      source_file: fileName || "import.csv",
      session_label: "imported",
      pick_count: picks.length,
      picks,
    };
  }

  global.RMScanParser = { parseScanCsvText };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- news_scan.js --- */
/** Fetch and score recent stock-worthy news (Google News RSS via CORS proxy). */
(function (global) {
  const CATALYST_RE =
    /\b(earnings|fda|approval|cleared|merger|acqui|guidance|contract|awarded|offering|upgrade|downgrade|sec filing|8-k|10-k|phase\s*[123]|clinical trial|trial results|revenue|profit|loss|bankruptcy|lawsuit|partnership|ipo|dividend|buyback|short squeeze|analyst|price target|beat estimates|miss estimates|warn|halt|investigation|subpoena|ceo|cfo|resign|layoff|expansion|deal|billion|million shares)\b/i;

  const MARKET_RE = /\b(stock|shares|equity|nyse|nasdaq|premarket|after hours|trading|ticker)\b/i;

  const BULLISH_RE =
    /\b(surge|soar|soars|jump|jumps|rally|rallies|gain|gains|gained|rose|rises|rising|climb|climbs|beat|beats|exceed|record high|upgrade|upgraded|outperform|approval|cleared|breakthrough|partnership|deal|acquisition|merger|buyback|dividend|growth|strong|bullish|top pick)\b/i;

  const BEARISH_RE =
    /\b(fall|falls|fell|drop|drops|plunge|plunges|sink|sinks|slide|slides|decline|miss|misses|cut|cuts|downgrade|downgraded|underperform|warning|warns|lawsuit|investigation|halt|bankruptcy|layoff|loss|losses|weak|bearish|selloff|sell-off|crash|tumble|fraud|subpoena)\b/i;

  function headlineSentiment(title, summary) {
    const text = (title + " " + (summary || "")).toLowerCase();
    let up = 0;
    let down = 0;
    const um = text.match(BULLISH_RE);
    const dm = text.match(BEARISH_RE);
    if (um) up = um.length;
    if (dm) down = dm.length;
    if (up > down) return "up";
    if (down > up) return "down";
    return "neutral";
  }

  /** Only headlines from the current trading day window */
  const MAX_AGE_HOURS = 24;
  const MAX_HEADLINES = 5;
  const MAX_TIMELINE_HEADLINES = 15;

  function scoreHeadline(title, summary, symbol) {
    const text = (title + " " + (summary || "")).trim();
    const lower = text.toLowerCase();
    const sym = symbol.toLowerCase();
    let score = 0;
    if (lower.includes(sym)) score += 2;
    if (CATALYST_RE.test(text)) score += 3;
    if (MARKET_RE.test(text)) score += 1;
    if (text.length < 15) score -= 2;
    return { score, text, worthy: score >= 2 };
  }

  function symbolMatchesHeadline(text, symbol) {
    if (!symbol || !text) return false;
    return scoreHeadline(String(text), "", String(symbol)).score >= 2;
  }

  function matchSymbolsInHeadlines(headlines, symbols) {
    const syms = [...new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean))];
    const matched = new Set();
    const hits = [];
    for (const h of headlines || []) {
      const text = (h.title || "") + " " + (h.summary || "");
      for (const sym of syms) {
        if (symbolMatchesHeadline(text, sym)) {
          if (!matched.has(sym)) {
            matched.add(sym);
            hits.push({ symbol: sym, title: h.title || "" });
          }
        }
      }
    }
    return { matched: [...matched], count: matched.size, hits };
  }

  function parseRss(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const items = [...doc.querySelectorAll("item")];
    return items.map((item) => {
      const title = item.querySelector("title")?.textContent || "";
      const link = item.querySelector("link")?.textContent || "";
      const pubDate = item.querySelector("pubDate")?.textContent || "";
      const desc = item.querySelector("description")?.textContent || "";
      const summary = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { title, link, pubDate, summary, date: pubDate ? new Date(pubDate) : null };
    });
  }

  function isRecent(date) {
    if (!date || Number.isNaN(date.getTime())) return true;
    const ageMs = Date.now() - date.getTime();
    return ageMs <= MAX_AGE_HOURS * 3600 * 1000;
  }

  const FETCH_MS = 8000;
  const NEWS_BATCH_SIZE = 3;

  async function fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchViaProxies(targetUrl) {
    if (typeof RMYahooFetch !== "undefined") {
      return await RMYahooFetch.fetchTextViaProxies(targetUrl);
    }
    const encoded = encodeURIComponent(targetUrl);
    const urls = [
      "https://corsproxy.io/?" + encoded,
      "https://corsproxy.io/?url=" + encoded,
      "https://api.allorigins.win/raw?url=" + encoded,
    ];
    let lastErr = null;
    for (const proxyUrl of urls) {
      try {
        return await fetchText(proxyUrl);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("News fetch failed");
  }

  async function fetchRss(symbol) {
    const q = encodeURIComponent(symbol + " stock");
    const rssUrl =
      "https://news.google.com/rss/search?q=" +
      q +
      "&hl=en-US&gl=US&ceid=US:en";
    const xml = await fetchViaProxies(rssUrl);
    return parseRss(xml);
  }

  async function scanSymbolNews(symbol) {
    const raw = await fetchRss(symbol);
    const scored = raw
      .filter((a) => isRecent(a.date))
      .map((a) => {
        const { score, worthy } = scoreHeadline(a.title, a.summary, symbol);
        const sentiment = headlineSentiment(a.title, a.summary);
        return { ...a, score, worthy, sentiment };
      })
      .filter((a) => a.worthy)
      .sort((a, b) => b.score - a.score);

    const timeline = scored.slice(0, MAX_TIMELINE_HEADLINES);
    const top = timeline.slice(0, MAX_HEADLINES);
    return {
      symbol,
      articles: timeline,
      hasCatalyst: timeline.length > 0,
      topHeadline: timeline[0] || null,
    };
  }

  async function scanAll(symbols, handlers) {
    const onStart =
      typeof handlers === "function" ? handlers : handlers && handlers.onStart;
    const onDone = handlers && handlers.onDone;
    const onProgress = handlers && handlers.onProgress;

    const results = [];
    for (let i = 0; i < symbols.length; i += NEWS_BATCH_SIZE) {
      const batch = symbols.slice(i, i + NEWS_BATCH_SIZE);
      const fetched = await Promise.all(
        batch.map((sym) =>
          scanSymbolNews(sym).catch((e) => ({
            symbol: sym,
            articles: [],
            hasCatalyst: false,
            topHeadline: null,
            error: e.message,
          }))
        )
      );
      for (let j = 0; j < batch.length; j++) {
        const sym = batch[j];
        const n = i + j + 1;
        const result = fetched[j];
        results.push(result);
        if (onStart) onStart(sym, n, symbols.length);
        if (onProgress) onProgress(sym, n, symbols.length, 1);
        if (onDone) {
          const ret = onDone(result, n, symbols.length);
          if (ret && typeof ret.then === "function") await ret;
        }
      }
      if (i + NEWS_BATCH_SIZE < symbols.length) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return results;
  }

  function applyResultToPick(pick, result) {
    const cat = pick.catalyst || {};
    cat.headlines = (result.articles || []).map((a) => ({
      title: a.title,
      url: a.link,
      published: a.pubDate,
      score: a.score,
      sentiment: a.sentiment || headlineSentiment(a.title, a.summary),
    }));
    if (result.hasCatalyst && result.topHeadline) {
      cat.verified = true;
      cat.status = "verified";
      cat.proxy_only = false;
      cat.headline = result.topHeadline.title;
      cat.source_url = result.topHeadline.link;
      cat.headline_sentiment =
        result.topHeadline.sentiment ||
        headlineSentiment(result.topHeadline.title, result.topHeadline.summary);
    } else if (result.error) {
      cat.status = "news_error";
      cat.verified = null;
      cat.headline = "News unavailable (" + result.error + ")";
    } else {
      cat.verified = false;
      cat.status = "no_recent_catalyst";
      cat.proxy_only = true;
      cat.headline = null;
      cat.source_url = null;
    }
    pick.catalyst = cat;
  }

  function applyToSession(session, scanResults) {
    const bySym = Object.fromEntries(scanResults.map((r) => [r.symbol, r]));
    for (const pick of session.picks || []) {
      const r = bySym[pick.symbol];
      if (!r) continue;
      applyResultToPick(pick, r);
    }
    session.news_scanned_at = new Date().toISOString();
    return session;
  }

  /**
   * Apply news, then drop picks with no stock-worthy headline today.
   * Returns { kept, removed } counts.
   */
  function filterSessionToNewsPicks(session, scanResults) {
    applyToSession(session, scanResults);
    const bySym = Object.fromEntries(scanResults.map((r) => [r.symbol, r]));
    const removed = [];

    session.picks = (session.picks || []).filter((pick) => {
      const r = bySym[pick.symbol];
      const keep = r && (r.hasCatalyst || r.error);
      if (!keep) {
        removed.push({
          symbol: pick.symbol,
          rm_confidence: pick.rm_confidence,
          reason: r?.error ? "news_fetch_error" : "no_stock_worthy_news_today",
        });
      }
      return keep;
    });

    session.picks.forEach((pick, i) => {
      pick.rank = i + 1;
    });
    session.pick_count = session.picks.length;
    session.filtered_out = removed;
    session.news_filter_applied_at = new Date().toISOString();

    return {
      before: scanResults.length,
      kept: session.picks.length,
      removed: removed.length,
      removedSymbols: removed.map((x) => x.symbol),
    };
  }

  global.RMNewsScan = {
    scanAll,
    applyToSession,
    applyResultToPick,
    filterSessionToNewsPicks,
    scoreHeadline,
    symbolMatchesHeadline,
    matchSymbolsInHeadlines,
    headlineSentiment,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- scan_store.js --- */
/** Persist scan sessions in localStorage calendar (production DB later). */
(function (global) {
  const KEY = "rainmaker_scan_calendar_v1";
  const MAX_DAYS = 400;
  const SEARCH_LIMIT = 500;
  const LIST_LIMIT = 2000;

  function loadAll() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveAll(data) {
    const keys = Object.keys(data).sort();
    while (keys.length > MAX_DAYS) {
      delete data[keys.shift()];
    }
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function dayKey(iso) {
    return String(iso || new Date().toISOString()).slice(0, 10);
  }

  function entryId(session) {
    const sid = String(session?.session_id || "scan").trim();
    const at = String(session?.scanned_at || "").trim();
    return at ? sid + "--" + at : sid + "--" + Date.now();
  }

  function summarizeSession(session) {
    return {
      session_id: session.session_id,
      scanned_at: session.scanned_at,
      entry_type: session.entry_type || null,
      source_kind: session.source_kind || null,
      source_file: session.source_file,
      session_label: session.session_label,
      pick_count: session.pick_count,
      hypothesis_id: session.hypothesis_id,
      news_scanned_at: session.news_scanned_at || null,
      accuracy: session.accuracy || null,
      closed_trades: session.closed_trades || null,
      picks: (session.picks || []).map((p) => ({
        symbol: p.symbol,
        rank: p.rank,
        rm_confidence: p.rm_confidence,
        last: p.last,
        pct_change: p.pct_change,
        gap_pct: p.gap_pct,
        pct_eod: p.pct_eod,
        catalyst: p.catalyst
          ? {
              status: p.catalyst.status,
              verified: p.catalyst.verified,
              headline: p.catalyst.headline,
              source_url: p.catalyst.source_url || null,
              headlines: (p.catalyst.headlines || []).slice(0, 6).map((h) => ({
                title: h.title,
                url: h.url || null,
              })),
            }
          : null,
      })),
      filtered_out: session.filtered_out || [],
    };
  }

  function saveSession(session, opts) {
    if (!session?.session_id) return null;
    const data = loadAll();
    const dk = dayKey(session.scanned_at);
    const list = data[dk] || [];
    const id = opts?.entryId || entryId(session);
    const snap = summarizeSession(session);
    const entry = {
      id,
      saved_at: new Date().toISOString(),
      entry_type: opts?.entryType || session.entry_type || "session",
      source_kind: opts?.sourceKind || session.source_kind || "scan",
      summary: snap,
      session: snap,
    };
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    data[dk] = list;
    saveAll(data);
    return entry;
  }

  function listDays() {
    return Object.keys(loadAll()).sort().reverse();
  }

  function getDay(dateKey) {
    return loadAll()[dateKey] || [];
  }

  function listAllEntries(limit) {
    const cap = limit == null ? LIST_LIMIT : limit;
    const out = [];
    const data = loadAll();
    for (const dk of Object.keys(data).sort().reverse()) {
      for (const entry of data[dk]) {
        out.push({ dateKey: dk, entry });
      }
    }
    out.sort((a, b) => {
      const ta = a.entry.summary?.scanned_at || a.entry.saved_at || "";
      const tb = b.entry.summary?.scanned_at || b.entry.saved_at || "";
      return tb.localeCompare(ta);
    });
    return cap > 0 ? out.slice(0, cap) : out;
  }

  function countEntries() {
    let n = 0;
    const data = loadAll();
    for (const dk of Object.keys(data)) n += (data[dk] || []).length;
    return n;
  }

  function search(query) {
    const q = String(query || "")
      .trim()
      .toLowerCase();
    if (!q) return listAllEntries(SEARCH_LIMIT);
    const out = [];
    const data = loadAll();
    for (const dk of Object.keys(data).sort().reverse()) {
      for (const entry of data[dk]) {
        const syms = (entry.summary?.picks || [])
          .map((p) => p.symbol)
          .join(" ");
        const blob =
          dk +
          " " +
          (entry.summary?.session_id || "") +
          " " +
          (entry.summary?.source_file || "") +
          " " +
          (entry.summary?.session_label || "") +
          " " +
          syms;
        if (blob.toLowerCase().includes(q)) {
          out.push({ dateKey: dk, entry });
        }
      }
    }
    out.sort((a, b) => {
      const ta = a.entry.summary?.scanned_at || "";
      const tb = b.entry.summary?.scanned_at || "";
      return tb.localeCompare(ta);
    });
    return out.slice(0, SEARCH_LIMIT);
  }

  function loadEntry(dateKey, entryId) {
    const list = getDay(dateKey);
    const hit = list.find((e) => e.id === entryId);
    return hit?.session || null;
  }

  function hasEntry(session) {
    const id = entryId(session);
    const dk = dayKey(session.scanned_at);
    return (getDay(dk) || []).some((e) => e.id === id);
  }

  function importSession(session) {
    if (!session?.session_id || !session?.picks?.length) return false;
    if (hasEntry(session)) return false;
    saveSession(session);
    return true;
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Pull sessions/manifest.json + session.json into local calendar. */
  async function syncPublishedCatalog(baseHref) {
    const base = baseHref || (typeof location !== "undefined" ? location.href : "");
    let imported = 0;
    const root = new URL(base);

    const manifest = await fetchJson(new URL("sessions/manifest.json", root).href);
    if (manifest?.sessions?.length) {
      for (const row of manifest.sessions) {
        const file = row.output || row.session_id + ".json";
        const data = await fetchJson(new URL("sessions/" + file, root).href);
        if (data && importSession(data)) imported++;
      }
    }

    const latest = await fetchJson(new URL("session.json", root).href);
    if (latest && importSession(latest)) imported++;

    return { imported, total: countEntries() };
  }

  global.RMScanStore = {
    saveSession,
    listDays,
    getDay,
    listAllEntries,
    countEntries,
    search,
    loadEntry,
    importSession,
    syncPublishedCatalog,
    entryId,
    dayKey,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- yahoo_fetch.js --- */
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

;
/* --- buy_bag_fx.js --- */
/** Money-bag sway + coin burst + cashier ching on click (not hover).
 *  Sound: assets/cashier-drawer-ching.mp3 from https://www.youtube.com/watch?v=4kVTqUxJYBA
 */
(function (global) {
  function cashierSrc() {
    try {
      const scripts = document.getElementsByTagName("script");
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].src;
        if (src && /buy_bag_fx\.js/i.test(src)) {
          return new URL("assets/cashier-drawer-ching.mp3", src).href;
        }
      }
    } catch {
      /* use relative fallback */
    }
    return "assets/cashier-drawer-ching.mp3";
  }

  const CASHIER_SRC = cashierSrc();
  // Skip the leading silence in the clip so the "ching" fires the instant the
  // bag is clicked instead of a beat later (item 15).
  const CASHIER_TRIM = 0.1;
  let audioCtx = null;
  let cashierClip = null;
  let cashierLoad = null;
  let htmlAudioEl = null;

  function getAudioCtx() {
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  /** Fallback drawer "ching" — bell + register clunk. */
  function playCashierSynth() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.16, t0);
    master.connect(ctx.destination);

    const bell = ctx.createOscillator();
    const bellG = ctx.createGain();
    bell.type = "sine";
    bell.frequency.setValueAtTime(2480, t0);
    bell.frequency.exponentialRampToValueAtTime(1980, t0 + 0.12);
    bellG.gain.setValueAtTime(0.0001, t0);
    bellG.gain.exponentialRampToValueAtTime(0.9, t0 + 0.008);
    bellG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    bell.connect(bellG);
    bellG.connect(master);
    bell.start(t0);
    bell.stop(t0 + 0.24);

    const clunk = ctx.createOscillator();
    const clunkG = ctx.createGain();
    clunk.type = "triangle";
    clunk.frequency.setValueAtTime(420, t0 + 0.05);
    clunk.frequency.exponentialRampToValueAtTime(180, t0 + 0.18);
    clunkG.gain.setValueAtTime(0.0001, t0 + 0.05);
    clunkG.gain.exponentialRampToValueAtTime(0.35, t0 + 0.06);
    clunkG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    clunk.connect(clunkG);
    clunkG.connect(master);
    clunk.start(t0 + 0.05);
    clunk.stop(t0 + 0.22);
  }

  function loadCashierClip() {
    if (cashierLoad) return cashierLoad;
    const ctx = getAudioCtx();
    if (!ctx) return Promise.resolve(null);
    cashierLoad = fetch(CASHIER_SRC)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("fetch"))))
      .then((buf) => ctx.decodeAudioData(buf))
      .then((clip) => {
        cashierClip = clip;
        return clip;
      })
      .catch(() => null);
    return cashierLoad;
  }

  function playCashierFromClip() {
    const ctx = getAudioCtx();
    if (!ctx || !cashierClip) return false;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = cashierClip;
    gain.gain.value = 0.62;
    src.connect(gain);
    gain.connect(ctx.destination);
    const offset = Math.min(CASHIER_TRIM, (cashierClip.duration || 0) * 0.5);
    src.start(0, offset);
    return true;
  }

  // One reused, preloaded <audio> so the fallback path doesn't pay decode/network
  // latency on each click.
  function getHtmlAudio() {
    if (!htmlAudioEl) {
      htmlAudioEl = new Audio(CASHIER_SRC);
      htmlAudioEl.preload = "auto";
      htmlAudioEl.volume = 0.62;
    }
    return htmlAudioEl;
  }

  function playCashierHtmlAudio() {
    try {
      const a = getHtmlAudio();
      try {
        a.currentTime = CASHIER_TRIM;
      } catch (_) {
        /* currentTime may not be settable until metadata loads */
      }
      const p = a.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => playCashierSynth());
      }
      return true;
    } catch {
      return false;
    }
  }

  function playCashier() {
    if (global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    if (cashierClip && playCashierFromClip()) return;
    if (cashierLoad) {
      cashierLoad.then((clip) => {
        if (clip && playCashierFromClip()) return;
        playCashierHtmlAudio();
      });
      return;
    }
    loadCashierClip().then((clip) => {
      if (clip && playCashierFromClip()) return;
      playCashierHtmlAudio();
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        loadCashierClip();
        getHtmlAudio(); // warm the fallback element so its first play is instant
      },
      { once: true }
    );
    // Browsers block audio until a user gesture; resume the context + decode on
    // the first interaction so the very first bag click already has sound ready.
    const warm = () => {
      getAudioCtx();
      loadCashierClip();
    };
    document.addEventListener("pointerdown", warm, { once: true, capture: true });
  }

  function animate(el) {
    if (!el?.classList?.contains("ca-buy-bag")) return;
    const now = Date.now();
    if (el._bagFxAt && now - el._bagFxAt < 100) return;
    el._bagFxAt = now;
    el.classList.remove("ca-buy-bag--jingle");
    void el.getBoundingClientRect();
    el.classList.add("ca-buy-bag--jingle");
    clearTimeout(el._bagFxEnd);
    el._bagFxEnd = setTimeout(() => el.classList.remove("ca-buy-bag--jingle"), 720);
  }

  function pulse(el) {
    animate(el);
    playCashier();
  }

  global.RMBuyBagFx = { animate, pulse, playCashier, loadCashierClip };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- results_hero.js --- */
/** Results tab hero (r3/c3) — ticker dashboard + setup visualization. */
(function (global) {
  const LOGO_URL =
    "https://storage.googleapis.com/iexcloud-hl37opg/api/logos/";
  const quoteCache = new Map();
  let mode = "idle";
  let currentSym = null;
  let ctx = {
    getSession: () => null,
    getActivePick: () => null,
    getScanningSymbol: () => null,
    getTrades: () => [],
    getJournalTrades: () => [],
    collectOpenRows: () => [],
    renderOpenRow: () => "",
    openResultsTab: () => {},
    pickScore: () => null,
    onCtaAction: () => {},
  };

  const INDEX_SYMS = new Set(["SPY", "QQQ", "IWM", "VIX", "^VIX"]);

  function isIndexSymbol(sym) {
    const s = String(sym || "").toUpperCase().replace(/^\^/, "");
    return INDEX_SYMS.has(s) || INDEX_SYMS.has("^" + s);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fmtPrice(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    return v >= 1000 ? v.toFixed(2) : v.toFixed(2);
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }

  function fmtVol(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  }

  function fmtCap(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    if (v >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    return String(Math.round(v));
  }

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function sessionLabel(q) {
    if (!q?.session) return "";
    if (q.session === "pre") return "Pre-market";
    if (q.session === "post") return "After hours";
    if (q.session === "closed") return "Market closed";
    return "At close";
  }

  function findPick(sym) {
    const session = ctx.getSession?.();
    if (!session?.picks?.length) return null;
    return session.picks.find((p) => p.symbol === sym) || null;
  }

  function isCompareChart() {
    if (typeof RMAnalysisChart === "undefined") return false;
    return RMAnalysisChart.state?.symbol === RMAnalysisChart.COMPARE_SYM;
  }

  function resolveChartSelectSymbol(raw) {
    const key = String(raw || "").trim();
    if (!key) return "";
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartSymbolForSelectValue) {
      return global.RMHoldings.chartSymbolForSelectValue(key);
    }
    if (/^holding:/i.test(key)) return "";
    return key.toUpperCase();
  }

  function resolveFocusSymbol(preferred) {
    if (preferred) {
      if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartFocusFromSelectKey) {
        const f = global.RMHoldings.chartFocusFromSelectKey(preferred);
        if (f) return f.symbol || f.displayKey;
      }
      return resolveChartSelectSymbol(preferred) || String(preferred).toUpperCase();
    }
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol) {
      const raw = RMAnalysisChart.state.symbol;
      if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartFocusFromSelectKey) {
        const f = global.RMHoldings.chartFocusFromSelectKey(raw);
        if (f) return f.symbol || f.displayKey;
      }
    }
    const scanning = ctx.getScanningSymbol?.();
    if (scanning) return scanning;
    if (typeof RMChartHub !== "undefined") {
      if (RMChartHub.state?.scanningSym) return RMChartHub.state.scanningSym;
      if (RMChartHub.state?.candidateSym) return RMChartHub.state.candidateSym;
    }
    if (typeof RMAnalysisChart !== "undefined") {
      const sym = RMAnalysisChart.state?.symbol;
      const compare = RMAnalysisChart.COMPARE_SYM;
      if (sym && sym !== compare) {
        const resolved = resolveChartSelectSymbol(sym);
        if (resolved) return resolved;
      }
      if (sym === compare) return "SPY";
    }
    const active = ctx.getActivePick?.();
    if (active?.symbol) return active.symbol;
    return "SPY";
  }

  function chartBarsForSymbol(sym) {
    const s = String(sym || "").toUpperCase();
    if (typeof RMChartHub !== "undefined") {
      if (s === "SPY" && RMChartHub.state?.spyBars?.length) {
        return RMChartHub.state.spyBars;
      }
      const ov = RMChartHub.state?.overlays?.get?.(s);
      if (ov?.length) return ov;
      if (RMChartHub.state?.candidateSym === s && RMChartHub.state?.candidateSeries?.length) {
        return RMChartHub.state.candidateSeries.map((p) => ({
          close: p.pct,
          high: p.pct,
          low: p.pct,
          open: p.pct,
          t: p.t,
        }));
      }
    }
    if (typeof RMAnalysisChart !== "undefined") {
      const st = RMAnalysisChart.state;
      const chartSym = resolveChartSelectSymbol(st?.symbol);
      if (
        st?.bars?.length &&
        (chartSym === s || st.symbol === s || (s === "SPY" && isCompareChart()))
      ) {
        return st.bars;
      }
    }
    return null;
  }

  function quoteFromChart(sym, bars, pick) {
    if (!bars?.length) return null;
    const last = bars[bars.length - 1];
    const first = bars[0];
    let priorClose =
      typeof RMChartHub !== "undefined"
        ? RMChartHub.state?.barMeta?.[sym]?.priorClose
        : null;
    if (priorClose == null && typeof RMAnalysisChart !== "undefined") {
      priorClose = RMAnalysisChart.state?.barMeta?.priorClose ?? null;
    }
    if (priorClose == null) priorClose = first?.open ?? last.close;
    const price = last.close ?? last.open;
    let chg = null;
    if (price != null && priorClose != null && priorClose !== 0) {
      chg = ((price - priorClose) / priorClose) * 100;
    }
    const highs = bars.map((b) => b.high ?? b.close).filter(Number.isFinite);
    const lows = bars.map((b) => b.low ?? b.close).filter(Number.isFinite);
    return {
      symbol: sym,
      price,
      chg,
      session:
        typeof RMChartHub !== "undefined"
          ? RMChartHub.state?.marketSession || "unknown"
          : "unknown",
      prevClose: priorClose,
      open: first?.open ?? pick?.open ?? null,
      dayHigh: highs.length ? Math.max(...highs) : null,
      dayLow: lows.length ? Math.min(...lows) : null,
      volume: pick?.volume ?? null,
      gapPct: pick?.gap_pct ?? null,
      rm: pick
        ? (ctx.pickScore?.(pick) ?? pick.rm_confidence ?? null)
        : null,
      pick,
      bars,
      fromChart: true,
      at: Date.now(),
    };
  }

  function heroRoot() {
    return $("ttResultsHero");
  }

  function heroInner() {
    return $("ttResultsHeroInner");
  }

  function perfStripEl() {
    return $("ttResultsPerfStrip");
  }

  function openRailEl() {
    return $("ttResultsOpenRail");
  }

  function deskCtaEl() {
    return $("ttResultsDeskCta");
  }

  function commandCenterEl() {
    return $("ttResultsCommandCenter");
  }

  function setHeroMode(next) {
    mode = next;
    const root = heroRoot();
    if (!root) return;
    root.dataset.mode = next;
    root.classList.toggle("tt-results-hero--setup", next === "setup");
    root.classList.toggle("tt-results-hero--ticker", next === "ticker");
    root.classList.toggle("tt-results-hero--signal", next === "signal");
    root.classList.toggle("tt-results-hero--idle", next === "idle");
    root.classList.toggle("tt-results-hero--overview", next === "overview");
    root.classList.toggle("tt-results-hero--position", next === "position");
  }

  function holdingFromCtx(h) {
    return h || null;
  }

  function positionLabel(h) {
    if (typeof RMHoldings !== "undefined" && RMHoldings.formatOptionLabel) {
      const lbl = RMHoldings.formatOptionLabel(h?.symbol);
      if (lbl && lbl !== String(h?.symbol || "").trim()) return lbl;
    }
    return String(h?.symbol || "").trim();
  }

  function positionHeroHtml(h, q) {
    const sym = String(h?.symbol || "").trim();
    const isOpt =
      h?.instrument === "option" ||
      (typeof RMHoldings !== "undefined" && RMHoldings.isOptionSymbol?.(sym));
    const parsed =
      isOpt && typeof RMHoldings !== "undefined" && RMHoldings.parseOptionContract
        ? RMHoldings.parseOptionContract(sym)
        : null;
    const qty = Math.abs(Number(h?.quantity ?? h?.qty) || 0);
    const avg = h?.entry_price ?? h?.avgPrice;
    const mv = h?.market_value ?? h?.marketValue;
    const pnl =
      typeof RMHoldings !== "undefined" && RMHoldings.openPositionPnl
        ? RMHoldings.openPositionPnl(h)
        : null;
    const up = q?.chg != null && Number(q.chg) >= 0;
    const chgCls = up ? "tt-hero-price--up" : "tt-hero-price--down";
    const spark = sparklinePath(q?.bars, 320, 72);
    const title = positionLabel(h);
    let sub = parsed
      ? parsed.right +
        " · " +
        parsed.expiryShort +
        " · $" +
        parsed.strike +
        (parsed.right === "Call" ? " call" : " put")
      : isOpt
        ? "Option contract"
        : "Stock position";
    if (qty) sub += " · " + qty + (isOpt ? " contracts" : " shares");
    if (parsed?.underlying) sub = parsed.underlying + " · " + sub;
    const stats = [];
    if (avg != null) stats.push(["Avg", "$" + Number(avg).toFixed(2) + (isOpt ? " prem" : "")]);
    if (q?.price != null) stats.push(["Mark", fmtPrice(q.price)]);
    if (mv != null) stats.push(["Value", fmtUsd(Number(mv))]);
    if (pnl?.dollars != null) {
      stats.push([
        "Open P/L",
        (pnl.dollars >= 0 ? "+" : "") + fmtUsd(pnl.dollars),
      ]);
    }
    const grid = stats
      .map(([l, v]) => metricCell(l, v))
      .join("");
    return (
      '<div class="tt-hero-card tt-hero-card--position">' +
      '<header class="tt-hero-head">' +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">Open position</p>' +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(title) +
      "</h3>" +
      '<p class="tt-hero-exchange">' +
      escapeHtml(sub) +
      "</p></div>" +
      (q?.price != null
        ? '<div class="tt-hero-price-block ' +
          chgCls +
          '"><span class="tt-hero-price">' +
          escapeHtml(fmtPrice(q.price)) +
          '</span><span class="tt-hero-chg">' +
          escapeHtml(fmtPct(q.chg)) +
          "</span></div>"
        : "") +
      "</header>" +
      '<div class="tt-hero-chart-band">' +
      (spark
        ? '<svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg>'
        : '<div class="tt-hero-spark-placeholder rm-desk-spark-idle" aria-hidden="true"></div>') +
      "</div>" +
      (grid ? '<div class="tt-hero-metrics tt-hero-metrics--position">' + grid + "</div>" : "") +
      backToOverviewLinkHtml() +
      "</div>"
    );
  }

  async function showOpenPosition(holding) {
    const h = holdingFromCtx(holding);
    if (!h?.symbol) {
      requestOverviewRefresh({ soft: false });
      return;
    }
    const inner = heroInner();
    if (!inner) return;
    const quoteSym =
      typeof RMHoldings !== "undefined" && RMHoldings.quoteSymbolFor
        ? RMHoldings.quoteSymbolFor(h)
        : String(h.symbol).trim().toUpperCase();
    currentSym = quoteSym;
    setHeroMode("position");
    showPlanSlot(false);
    ctx.openResultsTab?.();
    const instant = safeQuoteFromChart(
      quoteSym,
      chartBarsForSymbol(quoteSym),
      null
    );
    if (hasQuoteData(instant)) {
      inner.innerHTML = positionHeroHtml(h, instant);
    } else {
      inner.innerHTML = positionHeroHtml(h, { symbol: quoteSym });
    }
    try {
      const q = await loadQuote(quoteSym);
      if (hasQuoteData(q)) {
        inner.innerHTML = positionHeroHtml(h, q);
      }
    } catch {
      /* keep instant */
    }
  }

  function readConvictionCopy() {
    const kickerEl = document.querySelector("#headerMoodCopy .hm-kicker");
    const lineEl = document.querySelector("#headerMoodCopy .hm-line");
    if (kickerEl?.textContent?.trim()) {
      return {
        kicker: kickerEl.textContent.trim(),
        line:
          lineEl?.textContent?.trim() ||
          "Mixed signals. The tape hasn't picked a side yet.",
      };
    }
    if (typeof RMHeaderMood !== "undefined" && RMHeaderMood.TIERS) {
      const st = RMHeaderMood.getState?.();
      const tier = RMHeaderMood.TIERS.find((t) => t.id === (st?.tier || "neutral"));
      if (tier) return { kicker: tier.kicker, line: tier.line };
    }
    return {
      kicker: "Undecided",
      line: "Mixed signals. The tape hasn't picked a side yet.",
    };
  }

  function indexChip(sym, indices) {
    const key = sym === "VIX" ? "^VIX" : sym;
    const hit =
      indices?.[sym] || indices?.[key] || indices?.[sym.replace("^", "")];
    if (!hit || hit.price == null) return "";
    const chg = hit.chg ?? hit.pct_change ?? null;
    const up = chg != null && Number(chg) >= 0;
    return (
      '<span class="rm-desk-index ' +
      (up ? "rm-desk-index--up" : chg != null ? "rm-desk-index--down" : "") +
      '">' +
      '<span class="rm-desk-index-sym">' +
      escapeHtml(sym.replace("^", "")) +
      "</span>" +
      '<span class="rm-desk-index-px">' +
      escapeHtml(fmtPrice(hit.price)) +
      "</span>" +
      (chg != null
        ? '<span class="rm-desk-index-chg">' + escapeHtml(fmtPct(chg)) + "</span>"
        : "") +
      "</span>"
    );
  }

  async function schwabConnectedAsync() {
    if (typeof RMSchwab === "undefined" || !RMSchwab.getStatus) return false;
    try {
      const st = await RMSchwab.getStatus();
      return !!(st?.connected && !st?.needsReconnect);
    } catch {
      return false;
    }
  }

  const schwabStatusCache = { at: 0, connected: false };
  let schwabStatusKnown = false;
  let schwabPrefetchInflight = null;

  function updateSchwabStatus(connected) {
    schwabStatusKnown = true;
    schwabStatusCache.at = Date.now();
    schwabStatusCache.connected = !!connected;
    if (mode === "overview" || mode === "idle") {
      requestOverviewRefresh({ soft: true });
    }
  }

  function schwabConnectedSync() {
    if (typeof RMHoldings !== "undefined" && RMHoldings.getBrokerPositions) {
      if (RMHoldings.getBrokerPositions().length) return true;
    }
    if (Date.now() - schwabStatusCache.at < 120000) return schwabStatusCache.connected;
    return schwabStatusCache.connected;
  }

  function prefetchSchwabStatusForOverview() {
    if (schwabStatusKnown || Date.now() - schwabStatusCache.at < 60000) return;
    if (schwabPrefetchInflight) return;
    schwabPrefetchInflight = ensureSchwabReadyForOverview().finally(() => {
      schwabPrefetchInflight = null;
    });
  }

  async function ensureSchwabReadyForOverview() {
    if (schwabStatusKnown) return;
    try {
      if (typeof RMChunkLoader !== "undefined") {
        await RMChunkLoader.ensureBroker();
      }
      if (typeof RMSchwab !== "undefined" && RMSchwab.bootstrapDashboard) {
        await RMSchwab.bootstrapDashboard();
        return;
      }
      if (typeof RMSchwab !== "undefined" && RMSchwab.getStatus) {
        const st = await RMSchwab.getStatus();
        updateSchwabStatus(!!(st?.connected && !st?.needsReconnect));
        return;
      }
      updateSchwabStatus(false);
    } catch {
      updateSchwabStatus(false);
    }
  }

  function collectOpenSymbols() {
    const syms = [];
    const seen = new Set();
    const trades = ctx.getTrades?.() || [];
    trades
      .filter((t) => t && t.status === "open")
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(b.opened_at || "") || 0) - (Date.parse(a.opened_at || "") || 0)
      )
      .forEach((t) => {
        const s = String(t.symbol || "").toUpperCase();
        if (!s || seen.has(s)) return;
        seen.add(s);
        syms.push(s);
      });
    if (typeof RMHoldings !== "undefined" && RMHoldings.getBrokerPositions) {
      RMHoldings.getBrokerPositions().forEach((p) => {
        const s = String(p.symbol || "").toUpperCase();
        if (!s || seen.has(s)) return;
        seen.add(s);
        syms.push(s);
      });
    }
    return syms;
  }

  function resolveResultsCta(bundle) {
    const overviewCtx = bundle || {};
    const openSyms = overviewCtx.openSyms || [];
    const pickN = overviewCtx.pickCount || 0;
    const pulseStop = overviewCtx.pulseGate === "stop" || overviewCtx.c1?.gate === "stop";
    if (openSyms.length) {
      const sym = openSyms[0];
      const label =
        typeof RMHoldings !== "undefined" &&
        RMHoldings.isOptionSymbol?.(sym) &&
        RMHoldings.formatOptionLabel
          ? RMHoldings.formatOptionLabel(sym)
          : sym;
      return {
        action: "review_symbol",
        label: "Review " + label + " on chart",
        symbol: sym,
      };
    }
    if (pickN > 0) {
      return { action: "compare_picks", label: "Compare " + pickN + " picks" };
    }
    if (!overviewCtx.schwabConnected) {
      return { action: "connect_schwab", label: "Connect Schwab" };
    }
    if (pulseStop) {
      const stage = overviewCtx.stage || overviewCtx.kpi?.stage;
      const closedN = (overviewCtx.tradesClosedToday || []).length;
      if (stage === "reflect" && closedN > 0) {
        return {
          action: "review_closed",
          label:
            "Review today's " + closedN + " close" + (closedN === 1 ? "" : "s"),
          hint: "Risk-off day — journal what worked before tomorrow.",
        };
      }
      return {
        action: "review_symbol",
        label: "Stand aside — watch SPY",
        symbol: "SPY",
        hint: "Pulse gate is stop. No new setups — watch tape or stay flat.",
      };
    }
    if (!pickN) {
      return { action: "load_scan", label: "Load morning scan" };
    }
    return { action: "chart_focus", label: "Open chart focus" };
  }

  function personalStripParts(overviewCtx) {
    const parts = [];
    const openN = overviewCtx.openSyms?.length || 0;
    if (openN) parts.push(openN + " open");
    if (overviewCtx.pickCount) parts.push(overviewCtx.pickCount + " picks");
    if (overviewCtx.charge != null && overviewCtx.charge > 0) {
      parts.push(overviewCtx.charge + " green-light" + (overviewCtx.charge === 1 ? "" : "s"));
    }
    if (overviewCtx.pulseLabel) parts.push(overviewCtx.pulseLabel);
    return parts;
  }

  function kpiSignalPills(data) {
    const pills = [];
    const c1 = data.c1;
    const c2 = data.c2;
    if (c1?.gate) {
      pills.push("C1 " + String(c1.gate).toUpperCase());
    }
    if (c2?.gate) {
      pills.push("C2 " + String(c2.gate).toUpperCase());
    }
    (c1?.signals || []).slice(0, 2).forEach((s) => pills.push(String(s)));
    return pills
      .slice(0, 5)
      .map((p) => '<span class="rm-desk-pill">' + escapeHtml(p) + "</span>")
      .join("");
  }

  function overviewHeroHtml(data) {
    const copy = data.conviction;
    const bias = data.bias;
    const indices = data.indices || {};
    const chips = ["SPY", "QQQ", "VIX"].map((s) => indexChip(s, indices)).filter(Boolean).join("");
    const spark = sparklinePath(data.bars, 320, 72);
    const drivers = (bias?.market?.drivers || []).slice(0, 3);
    const driverPills = drivers
      .map(
        (d) =>
          '<span class="rm-desk-pill">' + escapeHtml(String(d)) + "</span>"
      )
      .join("");
    const kpiPills = kpiSignalPills(data);
    const personal = personalStripParts(data);
    const narrative = data.deskNarrative || copy.line;
    return (
      '<section class="rm-results-desk">' +
      '<div class="rm-results-desk-bg" aria-hidden="true">' +
      '<div class="rm-results-desk-mesh"></div>' +
      '<div class="rm-results-desk-glow"></div>' +
      '<img class="rm-results-desk-mark" src="assets/rm-story-icon.svg" alt="" decoding="async" />' +
      "</div>" +
      '<div class="rm-results-desk-body">' +
      '<div class="rm-results-desk-top">' +
      "<div>" +
      '<p class="rm-results-desk-kicker">Morning desk</p>' +
      '<h3 class="rm-results-desk-title">' +
      escapeHtml(copy.kicker) +
      "</h3>" +
      '<p class="rm-results-desk-sub">' +
      escapeHtml(narrative) +
      "</p>" +
      (data.c1?.posture || data.c2?.posture
        ? '<p class="rm-results-desk-signals meta">' +
          escapeHtml(
            [data.c1?.posture, data.c2?.posture].filter((p) => p && p !== "—").join(" · ")
          ) +
          "</p>"
        : "") +
      "</div>" +
      (bias?.market?.label
        ? '<span class="rm-results-desk-pulse" title="Morning Pulse">' +
          escapeHtml(bias.market.label) +
          "</span>"
        : "") +
      "</div>" +
      (chips ? '<div class="rm-results-desk-indices">' + chips + "</div>" : "") +
      '<div class="rm-results-desk-chart-band">' +
      (spark
        ? '<svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg>'
        : '<div class="tt-hero-spark-placeholder rm-desk-spark-idle" aria-hidden="true"></div>') +
      "</div>" +
      (kpiPills || driverPills
        ? '<div class="rm-results-desk-pills">' + kpiPills + driverPills + "</div>"
        : "") +
      (personal.length
        ? '<p class="rm-results-desk-personal">' + escapeHtml(personal.join(" · ")) + "</p>"
        : "") +
      "</div></section>"
    );
  }

  function deskCtaHtml(cta) {
    if (!cta) return "";
    return (
      '<button type="button" class="primary rm-results-desk-cta" data-results-cta="' +
      escapeHtml(cta.action) +
      '"' +
      (cta.symbol ? ' data-results-symbol="' + escapeHtml(cta.symbol) + '"' : "") +
      (cta.focus ? ' data-results-focus="' + escapeHtml(cta.focus) + '"' : "") +
      ">" +
      escapeHtml(cta.label) +
      "</button>"
    );
  }

  function perfStripHtml(bundle) {
    const s = bundle?.journal;
    if (!s?.trades) return "";
    const chip = (label, value, cls) =>
      '<div class="rm-perf-chip">' +
      '<span class="rm-perf-chip-k">' +
      escapeHtml(label) +
      "</span>" +
      '<strong class="' +
      (cls || "") +
      '">' +
      escapeHtml(value) +
      "</strong></div>";
    const signR = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "R";
    const chips = [
      chip("Trades", String(s.trades)),
      s.winPct != null
        ? chip("Win rate", s.winPct + "%", s.winPct >= 50 ? "is-pos" : "is-neg")
        : "",
      s.avgR != null
        ? chip("Expectancy", signR(s.avgR), s.avgR >= 0 ? "is-pos" : "is-neg")
        : "",
      s.totalR != null
        ? chip("Total", signR(s.totalR), s.totalR >= 0 ? "is-pos" : "is-neg")
        : "",
      s.totalPnl != null
        ? chip("P&L", fmtUsd(s.totalPnl), s.totalPnl >= 0 ? "is-pos" : "is-neg")
        : "",
    ]
      .filter(Boolean)
      .join("");
    let followHtml = "";
    if (typeof RMMetrics !== "undefined" && RMMetrics.convictionFollowRate) {
      const cf = RMMetrics.convictionFollowRate(30);
      if (cf && cf.eligible > 0) {
        followHtml =
          '<p class="rm-perf-follow">Followed conviction <strong>' +
          cf.followed +
          "/" +
          cf.eligible +
          "</strong> day" +
          (cf.eligible === 1 ? "" : "s") +
          " · " +
          Math.round(cf.rate * 100) +
          "% follow-through</p>";
      }
    }
    const spark =
      typeof global.RMJournal !== "undefined" && global.RMJournal.equitySparklineSvg
        ? global.RMJournal.equitySparklineSvg(s.equity)
        : "";
    return (
      '<div class="rm-perf-head">' +
      '<h3 class="tt-results-section-title">Your account</h3>' +
      spark +
      "</div>" +
      '<div class="rm-perf-stats">' +
      chips +
      "</div>" +
      followHtml
    );
  }

  function renderPerfStrip(bundle) {
    const el = perfStripEl();
    if (!el) return;
    const html = perfStripHtml(bundle);
    if (!html) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = html;
  }

  function renderOpenRail(bundle) {
    const list = $("ttResultsOpenList");
    const meta = $("ttResultsOpenMeta");
    const rail = openRailEl();
    if (!list) return;
    const rows = ctx.collectOpenRows?.() || [];
    if (!rows.length) {
      list.innerHTML =
        '<p class="cal-list-empty meta">No open positions — connect Schwab or open a setup from the chart footer.</p>';
      if (meta) meta.textContent = "";
      if (rail) rail.classList.add("is-empty");
      document.dispatchEvent(new CustomEvent("rm:results-open-rendered"));
      return;
    }
    if (rail) rail.classList.remove("is-empty");
    const journalN = rows.filter((r) => r.kind === "journal").length;
    if (meta) {
      meta.textContent =
        rows.length +
        " open position" +
        (rows.length === 1 ? "" : "s") +
        (journalN ? " · " + journalN + " in journal" : "");
    }
    const renderRow = ctx.renderOpenRow;
    list.innerHTML = rows.map((row) => (renderRow ? renderRow(row) : "")).join("");
    document.dispatchEvent(new CustomEvent("rm:results-open-rendered"));
  }

  function renderCtaSlot(bundle) {
    const el = deskCtaEl();
    if (!el) return;
    const cta = bundle?.cta || resolveResultsCta(bundle);
    const hint = cta?.hint
      ? '<p class="meta rm-results-desk-cta-hint">' + escapeHtml(cta.hint) + "</p>"
      : "";
    el.innerHTML = hint + deskCtaHtml(cta);
    el.hidden = !cta;
  }

  function buildOverviewContextSync() {
    if (typeof RMResultsContext !== "undefined" && RMResultsContext.buildResultsContext) {
      const bundle = RMResultsContext.buildResultsContext({
        getSession: ctx.getSession,
        getTrades: ctx.getTrades,
        getJournalTrades: ctx.getJournalTrades || ctx.getTrades,
        schwabConnectedSync,
        collectOpenSymbols,
        readConvictionCopy,
      });
      if (!bundle.bars?.length) {
        bundle.bars = chartBarsForSymbol("SPY");
      }
      bundle.cta = resolveResultsCta(bundle);
      return bundle;
    }
    const conviction = readConvictionCopy();
    const bias =
      typeof RMMarket !== "undefined" && RMMarket.getLastMorningBias
        ? RMMarket.getLastMorningBias()
        : null;
    const indices =
      typeof RMMarket !== "undefined" && RMMarket.getCachedIndices
        ? RMMarket.getCachedIndices()
        : {};
    const session = ctx.getSession?.();
    const pickCount = session?.pick_count || session?.picks?.length || 0;
    const openSyms = collectOpenSymbols();
    let pulseGate = null;
    let pulseLabel = null;
    let charge = null;
    if (typeof RMColumnKPI !== "undefined" && RMColumnKPI.compute) {
      const kpi = RMColumnKPI.compute();
      pulseGate = kpi?.c1?.gate || null;
      charge = kpi?.charge ?? null;
    }
    if (bias?.market?.label) pulseLabel = bias.market.label.toLowerCase();
    const bars = chartBarsForSymbol("SPY");
    const overviewCtx = {
      conviction,
      bias,
      indices,
      bars,
      pickCount,
      openSyms,
      pulseGate,
      pulseLabel,
      charge,
      schwabConnected: schwabConnectedSync(),
    };
    overviewCtx.cta = resolveResultsCta(overviewCtx);
    return overviewCtx;
  }

  function renderCommandCenter(bundle) {
    const cc = commandCenterEl();
    if (cc) cc.classList.toggle("is-overview", mode === "overview");
    renderPerfStrip(bundle);
    renderOpenRail(bundle);
    if (mode === "overview") {
      renderCtaSlot(bundle);
    } else {
      const ctaEl = deskCtaEl();
      if (ctaEl) {
        ctaEl.innerHTML = "";
        ctaEl.hidden = true;
      }
    }
  }

  function refreshOpenRail() {
    renderOpenRail(buildOverviewContextSync());
  }

  function refreshPerfStrip() {
    renderPerfStrip(buildOverviewContextSync());
  }

  function overviewSkeletonHtml() {
    return (
      '<section class="rm-results-desk rm-results-desk--skeleton" aria-busy="true">' +
      '<div class="rm-results-desk-bg" aria-hidden="true">' +
      '<div class="rm-results-desk-mesh"></div>' +
      '<div class="rm-results-desk-glow"></div>' +
      "</div>" +
      '<div class="rm-results-desk-body">' +
      '<p class="rm-results-desk-kicker">Morning desk</p>' +
      '<div class="rm-desk-skel-line rm-desk-skel-line--title"></div>' +
      '<div class="rm-desk-skel-line rm-desk-skel-line--sub"></div>' +
      '<div class="rm-results-desk-chart-band rm-desk-skel-chart"></div>' +
      "</div></section>"
    );
  }

  function handleHeroActions(e) {
    const back = e.target.closest?.("[data-results-back]");
    if (back) {
      e.preventDefault();
      requestOverviewRefresh({ soft: false });
      return;
    }
    const btn = e.target.closest?.("[data-results-cta]");
    if (
      !btn ||
      (!btn.closest("#ttResultsHeroInner") && !btn.closest("#ttResultsDeskCta"))
    )
      return;
    const action = btn.getAttribute("data-results-cta");
    const sym = btn.getAttribute("data-results-symbol");
    const focus = btn.getAttribute("data-results-focus");
    ctx.onCtaAction?.({ action, symbol: sym, focus: focus || undefined });
  }

  function backToOverviewLinkHtml() {
    return (
      '<p class="rm-results-desk-back">' +
      '<button type="button" class="btn-link" data-results-back="1">Back to overview</button></p>'
    );
  }

  let overviewGen = 0;
  let lastOverviewHtml = "";
  let overviewRefreshTimer = null;
  let overviewRefreshSoft = false;

  function applyOverviewHtml(inner, html) {
    if (!inner || !html || inner.innerHTML === html) return false;
    inner.innerHTML = html;
    lastOverviewHtml = html;
    inner.classList.remove("is-desk-loading");
    return true;
  }

  function requestOverviewRefresh(opts) {
    const soft = !!opts?.soft;
    if (!soft) {
      overviewRefreshSoft = false;
      if (overviewRefreshTimer) {
        clearTimeout(overviewRefreshTimer);
        overviewRefreshTimer = null;
      }
    } else if (overviewRefreshTimer) {
      overviewRefreshSoft = true;
      return;
    }
    const delay = soft ? 360 : 0;
    overviewRefreshTimer = setTimeout(() => {
      const runSoft = overviewRefreshSoft;
      overviewRefreshTimer = null;
      overviewRefreshSoft = false;
      showOverview({ soft: runSoft });
    }, delay);
  }

  function showOverview(opts) {
    const inner = heroInner();
    if (!inner) return;
    const soft = !!opts?.soft;
    const gen = ++overviewGen;
    currentSym = null;
    setHeroMode("overview");
    showPlanSlot(false);

    const hasDesk = !!inner.querySelector(".rm-results-desk:not(.rm-results-desk--skeleton)");
    if (!hasDesk && !soft) {
      inner.classList.add("is-desk-loading");
      inner.innerHTML = overviewSkeletonHtml();
    } else if (soft && hasDesk) {
      inner.classList.add("is-desk-refreshing");
    }

    if (!schwabStatusKnown && !opts?.skipSchwabWait) {
      void ensureSchwabReadyForOverview().then(() => {
        if (gen === overviewGen) showOverview({ soft: true, skipSchwabWait: true });
      });
      if (!hasDesk) return;
    }

    const data = buildOverviewContextSync();
    if (gen !== overviewGen) return;
    renderCommandCenter(data);
    const html = overviewHeroHtml(data);
    if (html === lastOverviewHtml && hasDesk) {
      inner.classList.remove("is-desk-refreshing");
      prefetchSchwabStatusForOverview();
      return;
    }
    applyOverviewHtml(inner, html);
    inner.classList.remove("is-desk-refreshing");
    prefetchSchwabStatusForOverview();
  }

  function metricCell(label, value, sub) {
    return (
      '<div class="tt-hero-metric">' +
      '<span class="tt-hero-metric-label">' +
      escapeHtml(label) +
      "</span>" +
      '<span class="tt-hero-metric-value">' +
      escapeHtml(value) +
      "</span>" +
      (sub ? '<span class="tt-hero-metric-sub">' + escapeHtml(sub) + "</span>" : "") +
      "</div>"
    );
  }

  function sparklinePath(bars, w, h) {
    if (!bars?.length) return "";
    const closes = bars.map((b) => b.close).filter((c) => c != null);
    if (closes.length < 2) return "";
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const step = w / (closes.length - 1);
    const pts = closes.map((c, i) => {
      const x = i * step;
      const y = h - ((c - min) / span) * (h - 8) - 4;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return "M" + pts.join(" L");
  }

  function marketIndexQuote(sym) {
    if (typeof RMMarket === "undefined" || !RMMarket.getCachedIndices) return null;
    const hit = RMMarket.getCachedIndices()?.[sym];
    if (!hit || hit.price == null) return null;
    return {
      symbol: sym,
      price: hit.price,
      chg: hit.chg ?? hit.pct_change ?? null,
      prevClose: hit.prevClose ?? hit.previousClose ?? null,
      session: hit.session || "unknown",
      fromMarket: true,
    };
  }

  const prefetchInflight = new Map();

  async function loadQuote(sym) {
    const cached = quoteCache.get(sym);
    if (cached && Date.now() - cached.at < 45000) return cached.data;
    const pick = findPick(sym);
    let bars = chartBarsForSymbol(sym);
    let data = null;
    if (typeof RMYahooFetch !== "undefined") {
      try {
        data = await RMYahooFetch.fetchQuote(sym, { timeoutMs: 9000 });
      } catch {
        data = null;
      }
    }
    const market = marketIndexQuote(sym);
    if (!bars?.length && typeof RMYahooFetch !== "undefined") {
      try {
        const payload = await RMYahooFetch.fetchChartBars(sym, "5m", "1d", {
          includePrePost: true,
        });
        bars = payload?.bars || payload;
      } catch {
        bars = bars || null;
      }
    }
    const fromChart = quoteFromChart(sym, bars, pick);
    const dayHigh =
      bars?.length &&
      Math.max(...bars.map((b) => b.high ?? b.close).filter(Number.isFinite));
    const dayLow =
      bars?.length &&
      Math.min(...bars.map((b) => b.low ?? b.close).filter(Number.isFinite));
    const enriched = {
      symbol: sym,
      price:
        data?.price ?? fromChart?.price ?? market?.price ?? pick?.last ?? null,
      chg:
        data?.chg ?? fromChart?.chg ?? market?.chg ?? pick?.pct_change ?? null,
      session:
        data?.session ?? fromChart?.session ?? market?.session ?? "unknown",
      prevClose:
        data?.prevClose ?? fromChart?.prevClose ?? market?.prevClose ?? null,
      open: pick?.open ?? fromChart?.open ?? bars?.[0]?.open ?? null,
      dayHigh: dayHigh || fromChart?.dayHigh || null,
      dayLow: dayLow || fromChart?.dayLow || null,
      volume: pick?.volume ?? null,
      gapPct: pick?.gap_pct ?? null,
      rm: pick
        ? (ctx.pickScore?.(pick) ?? pick.rm_confidence ?? null)
        : null,
      pick,
      bars: bars || fromChart?.bars || null,
      at: Date.now(),
    };
    quoteCache.set(sym, { at: Date.now(), data: enriched });
    return enriched;
  }

  function hasQuoteData(q) {
    return !!(q && (q.price != null || (q.bars && q.bars.length >= 1)));
  }

  function newsCardHtml(pick) {
    const cat = pick?.catalyst;
    if (!cat?.headline) return "";
    const tone =
      cat.headline_sentiment === "up"
        ? "bullish"
        : cat.headline_sentiment === "down"
          ? "bearish"
          : "neutral";
    return (
      '<article class="tt-hero-news">' +
      '<span class="tt-hero-news-icon" aria-hidden="true">?</span>' +
      '<p class="tt-hero-news-text">' +
      escapeHtml(cat.headline) +
      "</p>" +
      '<p class="tt-hero-news-meta">Catalyst — ' +
      escapeHtml(tone) +
      (cat.source ? " — " + escapeHtml(cat.source) : "") +
      "</p></article>"
    );
  }

  function tickerHeroHtml(sym, q, opts) {
    const up = q.chg != null && Number(q.chg) >= 0;
    const chgCls = up ? "tt-hero-price--up" : "tt-hero-price--down";
    const scanning = opts?.scanning;
    const kicker = scanning
      ? "Scanning now"
      : q.pick
        ? "Rainmaker pick"
        : "Chart focus";
    const company = q.pick?.company || q.pick?.name || "";
    const title = company ? company + " (" + sym + ")" : sym;
    const logoSrc = LOGO_URL + sym + ".png";
    const spark = sparklinePath(q.bars, 320, 72);
    const rangeTxt =
      q.dayLow != null && q.dayHigh != null
        ? fmtPrice(q.dayLow) + " – " + fmtPrice(q.dayHigh)
        : "—";
    const hasPick = !!q.pick;
    const cols = hasPick
      ? [
          [
            ["Previous close", fmtPrice(q.prevClose)],
            ["Open", fmtPrice(q.open)],
            ["Gap", q.gapPct != null ? fmtPct(q.gapPct) : "—"],
            ["RM score", q.rm != null ? String(Math.round(q.rm)) : "—"],
          ],
          [
            ["Day range", rangeTxt],
            ["Volume", fmtVol(q.volume)],
            ["Session", sessionLabel(q)],
            ["EOD %", q.pick?.pct_eod != null ? fmtPct(q.pick.pct_eod) : "—"],
          ],
          [
            ["Last", fmtPrice(q.price)],
            ["Change", fmtPct(q.chg)],
            ["Float", q.pick?.float_m != null ? fmtVol(q.pick.float_m * 1e6) : "—"],
            ["Vol ratio", q.pick?.vol_ratio != null ? Number(q.pick.vol_ratio).toFixed(1) + "x" : "—"],
          ],
          [
            ["Catalyst", q.pick?.catalyst?.status === "ok" ? "Validated" : "Scan pick"],
            ["News", q.pick?.catalyst?.headline ? "Headline" : "—"],
            ["Sector", q.pick?.sector || "—"],
            ["Theme", q.pick?.theme || "—"],
          ],
        ]
      : [
          [
            ["Previous close", fmtPrice(q.prevClose)],
            ["Open", fmtPrice(q.open)],
            ["Day range", rangeTxt],
            ["Session", sessionLabel(q)],
          ],
          [
            ["Last", fmtPrice(q.price)],
            ["Change", fmtPct(q.chg)],
          ],
        ];
    const grid = cols
      .map(
        (col) =>
          '<div class="tt-hero-metrics-col">' +
          col.map(([l, v]) => metricCell(l, v)).join("") +
          "</div>"
      )
      .join("");

    return (
      '<div class="tt-hero-card tt-hero-card--ticker">' +
      '<header class="tt-hero-head">' +
      '<div class="tt-hero-brand">' +
      '<div class="tt-hero-logo-wrap">' +
      '<img class="tt-hero-logo" src="' +
      escapeHtml(logoSrc) +
      '" alt="" width="56" height="56" loading="lazy" onerror="this.classList.add(\'tt-hero-logo--fallback\');this.removeAttribute(\'src\');this.textContent=\'' +
      escapeHtml(sym.slice(0, 2)) +
      "'\">" +
      '<span class="tt-hero-logo-fallback" aria-hidden="true">' +
      escapeHtml(sym.slice(0, 2)) +
      "</span></div>" +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">' +
      escapeHtml(kicker) +
      "</p>" +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(title) +
      "</h3>" +
      '<p class="tt-hero-exchange">Nasdaq / NYSE — USD — Rainmaker tape</p></div></div>' +
      '<div class="tt-hero-price-block ' +
      chgCls +
      '">' +
      '<span class="tt-hero-price">' +
      escapeHtml(fmtPrice(q.price)) +
      "</span>" +
      '<span class="tt-hero-chg">' +
      escapeHtml(fmtPct(q.chg)) +
      "</span>" +
      '<span class="tt-hero-session">' +
      escapeHtml(sessionLabel(q)) +
      "</span></div></header>" +
      '<div class="tt-hero-chart-band">' +
      (spark
        ? '<svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg>'
        : '<div class="tt-hero-spark-placeholder">Loading intraday shape…</div>') +
      "</div>" +
      (opts?.buyMeta ? buyMetaBanner(opts.buyMeta) : "") +
      newsCardHtml(q.pick) +
      '<div class="tt-hero-metrics">' +
      grid +
      "</div>" +
      backToOverviewLinkHtml() +
      '<p class="tt-hero-footnote">Tap a money bag or map cell for this view — Tap the setup flag for trade levels</p></div>'
    );
  }

  function setupLadderSvg(plan, bars) {
    const prices = [
      plan.target2 ?? plan.target,
      plan.target1 ?? plan.target,
      plan.entry,
      plan.stop,
    ].filter((p) => p != null);
    if (!prices.length) return "";
    const min = Math.min(...prices, ...(bars || []).map((b) => b.low ?? b.close));
    const max = Math.max(...prices, ...(bars || []).map((b) => b.high ?? b.close));
    const span = max - min || 1;
    const yFor = (p) => 12 + (1 - (p - min) / span) * 136;
    const levels = [
      { p: plan.entry, label: "Entry", cls: "entry" },
      { p: plan.stop, label: "Stop", cls: "stop" },
      { p: plan.target1 ?? plan.target, label: "Sell 1", cls: "t1" },
      { p: plan.target2 ?? plan.target, label: "Sell 2", cls: "t2" },
    ];
    let svg =
      '<svg class="tt-hero-setup-svg" viewBox="0 0 280 160" xmlns="http://www.w3.org/2000/svg">';
    const spark = sparklinePath(bars, 200, 100);
    if (spark) {
      svg +=
        '<g transform="translate(64 24)"><path d="' +
        spark +
        '" fill="none" stroke="rgba(78,184,201,0.35)" stroke-width="1.5"/></g>';
    }
    levels.forEach((lv) => {
      if (lv.p == null) return;
      const y = yFor(lv.p);
      svg +=
        '<line x1="16" y1="' +
        y +
        '" x2="264" y2="' +
        y +
        '" class="tt-hero-setup-line tt-hero-setup-line--' +
        lv.cls +
        '"/>' +
        '<text x="20" y="' +
        (y - 4) +
        '" class="tt-hero-setup-lbl tt-hero-setup-lbl--' +
        lv.cls +
        '">' +
        escapeHtml(lv.label) +
        "</text>" +
        '<text x="240" y="' +
        (y + 4) +
        '" class="tt-hero-setup-val">$' +
        Number(lv.p).toFixed(2) +
        "</text>";
    });
    svg += "</svg>";
    return svg;
  }

  function setupHeroHtml(sym, plan, q) {
    const rr =
      plan.entry > plan.stop
        ? ((plan.target2 ?? plan.target) - plan.entry) / (plan.entry - plan.stop)
        : null;
    return (
      '<div class="tt-hero-card tt-hero-card--setup">' +
      '<header class="tt-hero-head tt-hero-head--setup">' +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">Morning setup</p>' +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(sym) +
      " trade plan</h3>" +
      '<p class="tt-hero-exchange">Levels drawn on chart — green entry — orange stop — cyan targets</p></div>' +
      (rr != null
        ? '<span class="tt-hero-rr-badge">' + rr.toFixed(1) + "R</span>"
        : "") +
      "</header>" +
      '<div class="tt-hero-setup-body">' +
      setupLadderSvg(plan, q?.bars) +
      '<div class="tt-hero-setup-levels">' +
      metricCell("Entry", "$" + Number(plan.entry).toFixed(2)) +
      metricCell("Stop", "$" + Number(plan.stop).toFixed(2)) +
      metricCell("Sell 1", "$" + Number(plan.target1 ?? plan.target).toFixed(2)) +
      metricCell("Sell 2", "$" + Number(plan.target2 ?? plan.target).toFixed(2)) +
      metricCell("Qty", String(plan.qty || 100)) +
      metricCell("R:R", (plan.rr ?? 2).toFixed(1) + "R") +
      "</div>" +
      (plan.entry > plan.stop
        ? (function () {
            const profit = Math.round(
              ((plan.target2 ?? plan.target) - plan.entry) * (plan.qty || 100)
            );
            const risk = Math.round((plan.entry - plan.stop) * (plan.qty || 100));
            return (
              '<p class="tt-hero-setup-stat">Proj profit $' +
              escapeHtml(String(profit)) +
              " &middot; Risk $" +
              escapeHtml(String(risk)) +
              "</p>"
            );
          })()
        : "") +
      "</div>" +
      backToOverviewLinkHtml() +
      "</div>"
    );
  }

  function signalHeroHtml(sym, meta, q) {
    const spark = sparklinePath(q?.bars, 320, 72);
    const src = meta?.signalSource || "macd_rsi";
    const isEma = src.startsWith("ema_");
    const title = meta?.title || sym + (isEma ? " EMA signal" : " buy signal");
    const up = q?.chg != null && Number(q.chg) >= 0;
    let kicker = "Buy flag";
    let exchange = sym + " · MACD + RSI · " + escapeHtml(meta?.time || "Intraday");
    let desc =
      meta?.desc ||
      "MACD histogram 2-bar pivot up with RSI oversold in the prior 4 bars.";
    let pills =
      '<span class="tt-hero-pill">Histogram pivot</span>' +
      '<span class="tt-hero-pill">RSI floor touch</span>' +
      '<span class="tt-hero-pill">Entry marker</span>';
    if (src === "ema_golden_cross") {
      kicker = "Golden cross";
      exchange = sym + " · EMA 9/21 · " + escapeHtml(meta?.time || "Intraday");
      desc = meta?.desc || "EMA 9 crossed above 21 in uptrend. Plan uses signal close, swing stop, 2R target.";
      pills =
        '<span class="tt-hero-pill">EMA cross</span>' +
        '<span class="tt-hero-pill">Uptrend filter</span>' +
        '<span class="tt-hero-pill">2R plan</span>';
    } else if (src === "ema_pullback_9" || src === "ema_pullback_21") {
      kicker = meta?.signalLabel || "Pullback buy";
      exchange = sym + " · EMA pullback · " + escapeHtml(meta?.time || "Intraday");
      desc =
        meta?.desc ||
        "Pullback to EMA with close confirmation. Plan uses signal close, swing stop, 2R target.";
      pills =
        '<span class="tt-hero-pill">Pullback</span>' +
        '<span class="tt-hero-pill">Swing stop</span>' +
        '<span class="tt-hero-pill">2R plan</span>';
    } else if (src === "ema_death_cross") {
      kicker = "Death cross";
      exchange = sym + " · EMA 9/21 · wait";
      desc = meta?.desc || "Bearish cross — visible for context. No short plan (long-first).";
      pills =
        '<span class="tt-hero-pill">Wait</span>' +
        '<span class="tt-hero-pill">No plan</span>' +
        '<span class="tt-hero-pill">Long-first</span>';
    }
    return (
      '<div class="tt-hero-card tt-hero-card--signal' +
      (isEma ? " tt-hero-card--ema" : "") +
      '">' +
      '<header class="tt-hero-head">' +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">' +
      escapeHtml(kicker) +
      "</p>" +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(title) +
      "</h3>" +
      '<p class="tt-hero-exchange">' +
      exchange +
      "</p></div>" +
      (q?.price != null
        ? '<div class="tt-hero-price-block ' +
          (up ? "tt-hero-price--up" : "tt-hero-price--down") +
          '"><span class="tt-hero-price">' +
          escapeHtml(fmtPrice(q.price)) +
          '</span><span class="tt-hero-chg">' +
          escapeHtml(fmtPct(q.chg)) +
          "</span></div>"
        : "") +
      "</header>" +
      (spark
        ? '<div class="tt-hero-chart-band"><svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg></div>'
        : "") +
      '<article class="tt-hero-news tt-hero-news--signal">' +
      '<span class="tt-hero-news-icon" aria-hidden="true">&#9889;</span>' +
      '<p class="tt-hero-news-text">' +
      escapeHtml(desc) +
      "</p></article>" +
      '<div class="tt-hero-signal-pills">' +
      pills +
      "</div>" +
      backToOverviewLinkHtml() +
      "</div>"
    );
  }

  function buyMetaBanner(meta) {
    if (!meta?.desc && !meta?.title) return "";
    return (
      '<article class="tt-hero-news tt-hero-news--buy">' +
      '<span class="tt-hero-news-icon" aria-hidden="true">&#9889;</span>' +
      '<p class="tt-hero-news-text">' +
      escapeHtml(meta.desc || meta.title) +
      "</p>" +
      (meta.time
        ? '<p class="tt-hero-news-meta">Buy marker &middot; ' + escapeHtml(meta.time) + "</p>"
        : "") +
      "</article>"
    );
  }

  function idleHeroHtml() {
    const sym = resolveFocusSymbol();
    return (
      '<div class="tt-hero-card tt-hero-card--idle">' +
      '<p class="tt-hero-kicker">Results focus</p>' +
      "<h3 class=\"tt-hero-title\">" +
      (sym ? escapeHtml(sym) + " on chart" : "Pick a ticker on the chart") +
      "</h3>" +
      '<p class="tt-hero-idle-copy">Click a <strong>money bag</strong> for the ticker story, or the <strong>setup flag</strong> to see entry, stop, and targets visualized here.</p></div>'
    );
  }

  function showPlanSlot(on) {
    const slot = $("ttResultsPlanSlot");
    if (!slot) return;
    slot.classList.toggle("hidden", !on);
    slot.hidden = !on;
  }

  function safeQuoteFromChart(sym, bars, pick) {
    try {
      return quoteFromChart(sym, bars, pick);
    } catch {
      return null;
    }
  }

  async function renderTicker(sym, opts) {
    const inner = heroInner();
    if (!inner) return;
    currentSym = sym;
    setHeroMode("ticker");
    showPlanSlot(false);
    const pick = findPick(sym);
    const bars = chartBarsForSymbol(sym);
    const instant = safeQuoteFromChart(sym, bars, pick);
    if (hasQuoteData(instant)) {
      inner.innerHTML = tickerHeroHtml(sym, instant, opts);
    } else {
      inner.innerHTML =
        '<div class="tt-hero-loading">Loading ' + escapeHtml(sym) + "...</div>";
    }
    ctx.openResultsTab?.();
    try {
      const q = await loadQuote(sym);
      if (hasQuoteData(q)) {
        inner.innerHTML = tickerHeroHtml(sym, q, opts);
        return;
      }
      if (hasQuoteData(instant)) return;
      inner.innerHTML =
        '<div class="tt-hero-card tt-hero-card--error"><p>Loading tape for ' +
        escapeHtml(sym) +
        "... refresh chart or try again.</p></div>";
    } catch {
      const fallback = safeQuoteFromChart(sym, chartBarsForSymbol(sym), pick);
      if (hasQuoteData(fallback)) {
        inner.innerHTML = tickerHeroHtml(sym, fallback, opts);
        return;
      }
      if (hasQuoteData(instant)) return;
      inner.innerHTML =
        '<div class="tt-hero-card tt-hero-card--error"><p>Could not load quote for ' +
        escapeHtml(sym) +
        ".</p></div>";
    }
  }

  async function showTicker(symbol, opts) {
    const sym = resolveFocusSymbol(symbol);
    if (!sym) {
      showDefault();
      return;
    }
    if (isIndexSymbol(sym) && !opts?.scanning && !findPick(sym)) {
      requestOverviewRefresh({ soft: false });
      return;
    }
    await renderTicker(sym, opts);
  }

  async function showSetup(symbol, planOverride) {
    const focus =
      typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartFocusFromSelectKey
        ? global.RMHoldings.chartFocusFromSelectKey(symbol)
        : null;
    const symKey = focus?.selectKey || String(symbol || "").trim();
    const sym =
      focus?.symbol ||
      resolveChartSelectSymbol(symbol) ||
      String(symbol || "").toUpperCase();
    let plan = planOverride;
    if (!plan && typeof RMAnalysisChart !== "undefined") {
      plan = RMAnalysisChart.state?.tradePlan;
    }
    if (!plan?.symbol || (plan.symbol !== symKey && plan.symbol !== sym)) {
      if (typeof RMTradeFooter !== "undefined") {
        const pick = findPick(sym) || { symbol: sym, last: null };
        plan =
          RMTradeFooter.recommendMorningSetup?.(pick) ||
          RMTradeFooter.recommendPlan?.(pick);
      }
    }
    if (!plan) {
      await showTicker(sym);
      return;
    }
    const inner = heroInner();
    if (!inner) return;
    currentSym = sym;
    setHeroMode("setup");
    showPlanSlot(false);
    const bars = chartBarsForSymbol(sym);
    const instant = safeQuoteFromChart(sym, bars, findPick(sym));
    inner.innerHTML = setupHeroHtml(sym, plan, instant || { bars });
    ctx.openResultsTab?.();
    const q = await loadQuote(sym);
    if (hasQuoteData(q) || q?.bars?.length) {
      inner.innerHTML = setupHeroHtml(sym, plan, q);
    }
    if (typeof RMUiTips !== "undefined") RMUiTips.hide?.();
  }

  async function showBuySignal(symbol, meta) {
    const sym = String(symbol || resolveFocusSymbol() || "SPY").toUpperCase();
    const inner = heroInner();
    if (!inner) return;
    currentSym = sym;
    setHeroMode("signal");
    showPlanSlot(false);
    ctx.openResultsTab?.();
    const pick = findPick(sym);
    const bars = chartBarsForSymbol(sym);
    const instant = safeQuoteFromChart(sym, bars, pick);
    if (hasQuoteData(instant)) {
      inner.innerHTML = signalHeroHtml(sym, meta, instant);
    } else {
      inner.innerHTML =
        '<div class="tt-hero-loading">Loading ' + escapeHtml(sym) + " signal...</div>";
    }
    const q = await loadQuote(sym);
    if (hasQuoteData(q)) {
      inner.innerHTML = signalHeroHtml(sym, meta, q);
      return;
    }
    if (!hasQuoteData(instant)) {
      const fallback = safeQuoteFromChart(sym, chartBarsForSymbol(sym), pick);
      inner.innerHTML = signalHeroHtml(sym, meta, fallback || q);
    }
  }

  function showDefault() {
    const inner = heroInner();
    const hasDesk = !!inner?.querySelector(".rm-results-desk:not(.rm-results-desk--skeleton)");
    requestOverviewRefresh({ soft: hasDesk });
  }

  function configure(options) {
    ctx = { ...ctx, ...options };
  }

  let refreshHeroTimer = null;
  let overviewPollTimer = null;
  let chartBarsRefreshTimer = null;

  function resultsTabVisible() {
    const panel = $("scansTabResults");
    return panel && !panel.hidden;
  }

  function refreshHero() {
    if (mode === "setup" && currentSym) void showSetup(currentSym);
    else if (mode === "position") return;
    else if (mode === "ticker" && currentSym) void showTicker(currentSym);
    else if (mode === "overview" || mode === "idle") {
      requestOverviewRefresh({ soft: true });
    } else if (currentSym) void showTicker(currentSym);
    else requestOverviewRefresh({ soft: true });
  }

  function startOverviewPoll() {
    if (overviewPollTimer) return;
    overviewPollTimer = setInterval(() => {
      if (!resultsTabVisible()) return;
      if (mode === "overview") requestOverviewRefresh({ soft: true });
    }, 30000);
  }

  function stopOverviewPoll() {
    if (!overviewPollTimer) return;
    clearInterval(overviewPollTimer);
    overviewPollTimer = null;
  }

  function scheduleRefreshHero() {
    if (refreshHeroTimer) clearTimeout(refreshHeroTimer);
    refreshHeroTimer = setTimeout(() => {
      refreshHeroTimer = null;
      refreshHero();
    }, 180);
  }

  function scheduleOverviewFromChartBars() {
    if (!resultsTabVisible() || mode !== "overview") return;
    if (chartBarsRefreshTimer) return;
    chartBarsRefreshTimer = setTimeout(() => {
      chartBarsRefreshTimer = null;
      requestOverviewRefresh({ soft: true });
    }, 700);
  }

  function wire() {
    document.addEventListener("click", handleHeroActions);
    document.addEventListener("rm:results-hero", (e) => {
      const d = e.detail || {};
      if (d.mode === "setup") void showSetup(d.symbol, d.plan);
      else if (d.mode === "signal") void showBuySignal(d.symbol, d.meta);
      else if (d.mode === "overview") requestOverviewRefresh({ soft: false });
      else void showTicker(d.symbol, d.opts);
    });
    document.addEventListener("rm:results-tab-shown", () => {
      startOverviewPoll();
    });
    document.addEventListener("rm:auth-ready", () => {
      schwabStatusKnown = false;
      void ensureSchwabReadyForOverview();
    });
    document.addEventListener("rm:schwab-positions", () => {
      if (mode === "overview") requestOverviewRefresh({ soft: true });
    });
    document.addEventListener("rm:trade-closed", () => {
      if (mode === "overview") requestOverviewRefresh({ soft: true });
      else {
        refreshPerfStrip();
        refreshOpenRail();
      }
    });
    document.addEventListener("rm:notes-updated", () => {
      if (mode === "overview") requestOverviewRefresh({ soft: true });
    });
    document.addEventListener("rm:results-content-updated", () => {
      refreshPerfStrip();
      refreshOpenRail();
    });
    document.addEventListener("rm:trade-journey", (e) => {
      const d = e.detail || {};
      const sym = String(d.symbol || d.selectKey || "").trim();
      if (!sym) return;
      if (d.stage === "plan") {
        void showSetup(sym, d.plan);
        return;
      }
      if (d.stage === "open") {
        const trades = ctx.getTrades?.() || [];
        const open = trades.find(
          (t) =>
            t.status === "open" &&
            (t.symbol === sym ||
              String(t.symbol || "").toUpperCase() === sym.toUpperCase())
        );
        if (open) {
          void showOpenPosition({
            symbol: open.symbol,
            entry_price: open.entry_price ?? open.entry_premium,
            quantity: open.quantity ?? open.contracts,
            instrument: open.instrument || "stock",
            source: open.source || "journal",
          });
        } else {
          void showSetup(sym, d.plan);
        }
        return;
      }
      if (d.stage === "manage" && d.holding) {
        void showOpenPosition(d.holding);
        return;
      }
      if (d.stage === "close") {
        requestOverviewRefresh({ soft: true });
      }
    });
    document.addEventListener("rm:scan-ticker", (e) => {
      const sym = e.detail?.symbol;
      if (!sym) return;
      const panel = $("scansTabResults");
      if (panel?.hidden) return;
      void showTicker(sym, { scanning: true });
    });
    document.addEventListener("rm:chart-bars", () => {
      const panel = $("scansTabResults");
      if (!panel || panel.hidden) return;
    if (mode === "overview") scheduleOverviewFromChartBars();
      else if (mode !== "position") scheduleRefreshHero();
    });
  }

  wire();

  function prefetchQuote(sym) {
    const s = String(sym || "")
      .trim()
      .toUpperCase();
    if (!s) return Promise.resolve(null);
    const cached = quoteCache.get(s);
    if (cached && Date.now() - cached.at < 45000) return Promise.resolve(cached.data);
    if (prefetchInflight.has(s)) return prefetchInflight.get(s);
    const p = loadQuote(s)
      .catch(() => null)
      .finally(() => {
        prefetchInflight.delete(s);
      });
    prefetchInflight.set(s, p);
    return p;
  }

  global.RMResultsHero = {
    configure,
    showTicker,
    showSetup,
    showBuySignal,
    showOverview,
    showOpenPosition,
    showDefault,
    updateSchwabStatus,
    ensureSchwabReadyForOverview,
    resolveFocusSymbol,
    refresh: refreshHero,
    refreshOpenRail,
    refreshPerfStrip,
    renderCommandCenter,
    prefetchQuote,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- ui_tips.js --- */
/** Shared floating hover tooltips (market map, chart hub, scan picks). */

(function (global) {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  let tipEl = null;
  let tipAnchor = null;
  let buyFlagDismissTimer = null;
  let hideTipTimer = null;
  const delegatedRoots = new WeakSet();

  function ensureTip() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "fvMapTip";
      tipEl.className = "fv-map-tip hidden";
      tipEl.setAttribute("role", "tooltip");
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function buildTipHtml(kicker, title, desc, stat, variant) {
    if (variant === "buy-flag") {
      return (
        '<div class="fv-buy-flag-tip">' +
        (kicker ? '<p class="fv-tip-kicker">' + escapeHtml(kicker) + "</p>" : "") +
        '<p class="fv-tip-title">' +
        escapeHtml(title) +
        "</p>" +
        (stat ? '<p class="fv-tip-stat">' + escapeHtml(stat) + "</p>" : "") +
        '<p class="fv-tip-desc">' +
        escapeHtml(desc) +
        "</p></div>"
      );
    }
    return (
      (kicker ? '<p class="fv-tip-kicker">' + escapeHtml(kicker) + "</p>" : "") +
      '<p class="fv-tip-title">' +
      escapeHtml(title) +
      "</p>" +
      (stat ? '<p class="fv-tip-stat">' + escapeHtml(stat) + "</p>" : "") +
      '<p class="fv-tip-desc">' +
      escapeHtml(desc) +
      "</p>"
    );
  }

  function tipAnchorRect(anchor) {
    if (anchor?.dataset?.fvVariant === "buy-flag") {
      const bag = anchor.querySelector(".ca-buy-bag__scene");
      if (bag) return bag.getBoundingClientRect();
    }
    return anchor.getBoundingClientRect();
  }

  function positionTip(anchor) {
    const tip = ensureTip();
    const rect = tipAnchorRect(anchor);
    const isBuyFlag = anchor?.dataset?.fvVariant === "buy-flag";
    const margin = isBuyFlag ? 0 : 10;
    const snapGap = isBuyFlag ? 1 : 0;
    tip.style.left = "0";
    tip.style.top = "0";
    tip.classList.remove("hidden");
    tip.classList.add("fv-map-tip--show");
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = isBuyFlag
      ? rect.top - tipRect.height - snapGap
      : rect.top - tipRect.height - margin;
    if (!isBuyFlag && top < margin) top = rect.bottom + margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  function showTip(anchor) {
    if (!anchor?.dataset?.fvTitle) return;
    if (
      anchor.closest(".ws-panel-head") ||
      anchor.closest(".ca-toolbar") ||
      anchor.closest(".ca-toolbar-wrap")
    ) {
      return;
    }
    if (
      anchor.dataset.fvVariant === "plan-flag" ||
      anchor.dataset.planFlag === "1"
    ) {
      return;
    }
    tipAnchor = anchor;
    anchor.classList.add("fv-tip-active");
    const tip = ensureTip();
    const variant = anchor.dataset.fvVariant || "";
    tip.classList.toggle("fv-map-tip--buy-flag", variant === "buy-flag");
    tip.innerHTML = buildTipHtml(
      anchor.dataset.fvKicker || "",
      anchor.dataset.fvTitle,
      anchor.dataset.fvDesc || "",
      anchor.dataset.fvStat || "",
      variant
    );
    tip.classList.remove("hidden");
    requestAnimationFrame(() => positionTip(anchor));
  }

  function hideTip() {
    if (hideTipTimer) {
      clearTimeout(hideTipTimer);
      hideTipTimer = null;
    }
    if (buyFlagDismissTimer) clearTimeout(buyFlagDismissTimer);
    buyFlagDismissTimer = null;
    tipAnchor = null;
    if (tipEl) {
      tipEl.classList.remove(
        "fv-map-tip--show",
        "fv-map-tip--buy-flag",
        "fv-map-tip--positioned"
      );
      tipEl.classList.add("hidden");
    }
    document.querySelectorAll(".fv-tip-active").forEach((el) => {
      el.classList.remove("fv-tip-active");
    });
  }

  function scheduleHideTip(delayMs) {
    if (hideTipTimer) clearTimeout(hideTipTimer);
    hideTipTimer = setTimeout(() => {
      hideTipTimer = null;
      if (!tipAnchor) return;
      const tip = tipEl;
      const overTip = tip && !tip.classList.contains("hidden") && tip.matches(":hover");
      const overAnchor = tipAnchor.matches(":hover");
      if (!overTip && !overAnchor) hideTip();
    }, delayMs == null ? 50 : delayMs);
  }

  function pointerOverTipTarget(el) {
    if (!el || !tipEl || tipEl.classList.contains("hidden")) return false;
    return el === tipAnchor || tipEl.contains(el);
  }

  function isClickTip(el) {
    return el?.dataset?.fvVariant === "buy-flag";
  }

  function isChartIndLineTip(el) {
    if (!el) return false;
    if (el.classList?.contains("ca-ind-hit") || el.classList?.contains("ca-fv-hit")) return true;
    return el.dataset?.fvVariant === "chart-ind-line";
  }

  function isPlanFlagTip(el) {
    return (
      el?.dataset?.planFlag === "1" ||
      el?.classList?.contains("ca-plan-flag")
    );
  }

  function tipTargetFromEvent(e) {
    const el = e.target?.closest?.(".fv-tip-target");
    if (!el || isPlanFlagTip(el)) return null;
    return el;
  }

  function animateBuyBag(el, withSound) {
    if (typeof global.RMBuyBagFx === "undefined") return;
    if (withSound) global.RMBuyBagFx.pulse(el);
    else global.RMBuyBagFx.animate(el);
  }

  function chartFocusSymbol() {
    if (typeof RMResultsHero !== "undefined") {
      return RMResultsHero.resolveFocusSymbol();
    }
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol) {
      const sym = RMAnalysisChart.state.symbol;
      const compare = RMAnalysisChart.COMPARE_SYM;
      if (sym && sym !== compare) return sym;
      if (sym === compare) return "SPY";
    }
    if (typeof RMChartHub !== "undefined") {
      if (RMChartHub.state?.scanningSym) return RMChartHub.state.scanningSym;
      if (RMChartHub.state?.candidateSym) return RMChartHub.state.candidateSym;
    }
    return "SPY";
  }

  function dispatchResultsHero(detail) {
    document.dispatchEvent(new CustomEvent("rm:results-hero", { detail }));
  }

  function buySignalMetaFrom(el) {
    return {
      kicker: el.dataset.fvKicker || "Buy",
      title: el.dataset.fvTitle || "",
      desc: el.dataset.fvDesc || "",
      time: el.dataset.fvStat || "",
    };
  }

  function onDelegatedPointerOver(e) {
    if (hideTipTimer) {
      clearTimeout(hideTipTimer);
      hideTipTimer = null;
    }
    const el = tipTargetFromEvent(e);
    if (!el) return;
    if (isClickTip(el)) {
      animateBuyBag(el, false);
      return;
    }
    showTip(el);
  }

  function onDelegatedPointerOut(e) {
    const el = tipTargetFromEvent(e);
    const rel = e.relatedTarget;
    if (rel && pointerOverTipTarget(rel)) return;
    if (el && rel && el.contains(rel)) return;
    if (isClickTip(el)) {
      if (tipAnchor === el) scheduleHideTip(80);
      return;
    }
    scheduleHideTip(40);
  }

  function onDelegatedClick(e) {
    const el = tipTargetFromEvent(e);
    if (!el) return;
    if (isClickTip(el)) {
      e.stopPropagation();
      e.preventDefault();
      const sym = chartFocusSymbol();
      animateBuyBag(el, true);
      dispatchResultsHero({
        mode: "signal",
        symbol: sym,
        meta: buySignalMetaFrom(el),
      });
      hideTip();
      showTip(el);
      return;
    }
    if (isChartIndLineTip(el)) {
      e.stopPropagation();
      showTip(el);
    }
  }

  function onDelegatedKeydown(e) {
    const el = tipTargetFromEvent(e);
    if (!el || !isClickTip(el)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onDelegatedClick(e);
  }

  function bindDelegatedTips(root) {
    if (!root || delegatedRoots.has(root)) return;
    delegatedRoots.add(root);
    root.addEventListener("pointerover", onDelegatedPointerOver);
    root.addEventListener("pointerout", onDelegatedPointerOut);
    root.addEventListener("click", onDelegatedClick);
    root.addEventListener("keydown", onDelegatedKeydown);
  }

  function bindGlobalTipDismiss() {
    if (typeof document === "undefined" || document.documentElement.dataset.rmTipDismiss === "1") {
      return;
    }
    document.documentElement.dataset.rmTipDismiss = "1";
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!tipAnchor || tipEl?.classList.contains("hidden")) return;
        if (tipAnchor.contains(e.target) || tipEl?.contains(e.target)) return;
        hideTip();
      },
      true
    );
    document.addEventListener("scroll", () => hideTip(), { passive: true, capture: true });
  }

  function bindPlanFlagToHero(root) {
    if (!root || root.dataset.planHeroBound === "1") return;
    root.dataset.planHeroBound = "1";
    root.addEventListener("click", (e) => {
      const flag = e.target?.closest?.(
        "[data-plan-flag], .ca-plan-flag-hit, .ca-plan-flag"
      );
      if (!flag) return;
      e.stopPropagation();
      e.preventDefault();
      hideTip();
      const sym =
        typeof RMAnalysisChart !== "undefined" &&
        RMAnalysisChart.state?.tradePlan?.symbol
          ? RMAnalysisChart.state.tradePlan.symbol
          : chartFocusSymbol();
      const plan =
        typeof RMAnalysisChart !== "undefined"
          ? RMAnalysisChart.state?.tradePlan
          : null;
      if (plan?.symbol) {
        dispatchResultsHero({ mode: "setup", symbol: plan.symbol, plan });
      }
    });
  }

  function bind(root) {
    if (!root) return;
    bindGlobalTipDismiss();
    bindPlanFlagToHero(root);
    bindDelegatedTips(root);
  }

  function fvTipData(kicker, title, desc, stat, variant) {
    let attrs =
      ' data-fv-kicker="' +
      escapeAttr(kicker || "") +
      '" data-fv-title="' +
      escapeAttr(title || "") +
      '" data-fv-desc="' +
      escapeAttr(desc || "") +
      '"';
    if (stat) attrs += ' data-fv-stat="' + escapeAttr(stat) + '"';
    if (variant) attrs += ' data-fv-variant="' + escapeAttr(variant) + '"';
    return attrs;
  }

  if (typeof window !== "undefined") {
    bindGlobalTipDismiss();
    window.addEventListener(
      "scroll",
      () => {
        if (tipAnchor && tipEl && !tipEl.classList.contains("hidden")) {
          hideTip();
        }
      },
      { passive: true }
    );
  }

  global.RMUiTips = {
    bind,
    hide: hideTip,
    show: showTip,
    fvTipData,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- market_themes.js --- */
/** Market themes heatmap — multi-RSS + scan symbol alignment + article reader. */
(function (global) {
  const FETCH_MS = 6000;
  const ARTICLE_FETCH_MS = 10000;
  const HEADLINE_CACHE_KEY = "rm_mkt_headlines_v2";
  const HEADLINE_CACHE_MS = 300000;
  const HOVER_COLLAPSE_MS = 420;

  const RSS_FEEDS = [
    {
      id: "cnbc",
      label: "CNBC",
      url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    },
    {
      id: "marketwatch",
      label: "MarketWatch",
      url: "https://feeds.marketwatch.com/marketwatch/topstories/",
    },
    {
      id: "cnbc-macro",
      label: "CNBC Economy",
      url: "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    },
  ];

  const THEMES = [
    {
      id: "macro",
      label: "Macro & rates",
      keywords: /fed|rate|inflation|treasury|gdp|jobs|cpi|ppi|economy|recession/i,
      sources: "CNBC · MW · Economy",
    },
    {
      id: "tech",
      label: "Tech & AI",
      keywords: /ai|chip|nvidia|semiconductor|cloud|software|apple|microsoft|google|meta/i,
      sources: "CNBC · MW",
    },
    {
      id: "earnings",
      label: "Earnings",
      keywords: /earnings|revenue|guidance|eps|beat|miss|quarter|results/i,
      sources: "CNBC · MW",
    },
    {
      id: "energy",
      label: "Energy & commodities",
      keywords: /oil|gas|opec|gold|copper|commodity|crude|energy|solar/i,
      sources: "CNBC · MW",
    },
    {
      id: "risk",
      label: "Risk & flows",
      keywords: /selloff|rally|volatility|vix|short|squeeze|bank|credit|geopolit|war|tariff/i,
      sources: "CNBC · MW",
    },
  ];

  let lastContext = null;
  let lastBuckets = [];
  let rootEl = null;
  let readerPortal = null;
  let marketBodyEl = null;
  let hoverBound = false;

  const ui = {
    phase: "idle",
    themeId: null,
    articleIdx: null,
    leaveTimer: null,
    fetchToken: 0,
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function normalizeTitle(title) {
    return String(title || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseDescriptionFields(raw) {
    const html = String(raw || "").trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const imgM = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    return {
      summaryHtml: html,
      summaryText: text,
      imageUrl: imgM ? imgM[1] : null,
    };
  }

  async function fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      if (typeof RMYahooFetch !== "undefined") {
        return await RMYahooFetch.fetchTextViaProxies(url, { timeoutMs: FETCH_MS });
      }
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchFeedXml(url) {
    const encoded = encodeURIComponent(url);
    const urls = [
      "https://corsproxy.io/?" + encoded,
      "https://api.allorigins.win/raw?url=" + encoded,
    ];
    for (const u of urls) {
      const xml = await fetchText(u);
      if (xml) return xml;
    }
    return null;
  }

  function parseRssItems(xml, sourceLabel) {
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    return [...doc.querySelectorAll("item")]
      .map((item) => {
        const desc = item.querySelector("description")?.textContent || "";
        const fields = parseDescriptionFields(desc);
        return {
          title: item.querySelector("title")?.textContent?.trim() || "",
          link: item.querySelector("link")?.textContent?.trim() || "",
          summary: fields.summaryText,
          summaryHtml: fields.summaryHtml,
          imageUrl: fields.imageUrl,
          source: sourceLabel,
        };
      })
      .filter((a) => a.title);
  }

  function readCachedHeadlines(limit) {
    try {
      const raw = sessionStorage.getItem(HEADLINE_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached?.at && Date.now() - cached.at < HEADLINE_CACHE_MS && cached.items?.length) {
          return cached.items.slice(0, limit || 48);
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function cacheHeadlines(items) {
    if (!items || !items.length) return;
    try {
      sessionStorage.setItem(
        HEADLINE_CACHE_KEY,
        JSON.stringify({ at: Date.now(), items: items.slice(0, 48) })
      );
    } catch {
      /* ignore */
    }
  }

  function sentimentFromTitle(title) {
    if (typeof RMNewsScan !== "undefined" && RMNewsScan.headlineSentiment) {
      return RMNewsScan.headlineSentiment(title, "");
    }
    if (/surge|rally|jump|gain|beat|soar|record high/i.test(title)) return "up";
    if (/fall|drop|sink|miss|cut|selloff|plunge|warning/i.test(title)) return "down";
    return "neutral";
  }

  function matchScanSymbols(headlines, picks) {
    const symbols = (picks || []).map((p) => p.symbol).filter(Boolean);
    if (typeof RMNewsScan !== "undefined" && RMNewsScan.matchSymbolsInHeadlines) {
      return RMNewsScan.matchSymbolsInHeadlines(headlines, symbols);
    }
    const matched = new Set();
    for (const h of headlines || []) {
      const text = (h.title || "") + " " + (h.summary || "");
      for (const sym of symbols) {
        if (new RegExp("\\b" + sym + "\\b", "i").test(text)) matched.add(sym.toUpperCase());
      }
    }
    return { matched: [...matched], count: matched.size, hits: [] };
  }

  function classifyHeadlines(headlines, picks) {
    const buckets = THEMES.map((t) => ({
      ...t,
      articles: [],
      buzz: 0,
      sentimentScore: 0,
      scanAlign: 0,
    }));
    for (const h of headlines) {
      const title = h.title || "";
      let placed = false;
      for (const b of buckets) {
        if (b.keywords.test(title)) {
          const sent = sentimentFromTitle(title);
          b.articles.push({ ...h, sentiment: sent });
          b.buzz += 1 + Math.min(3, title.length / 80);
          if (sent === "up") b.sentimentScore += 1;
          if (sent === "down") b.sentimentScore -= 1;
          placed = true;
          break;
        }
      }
      if (!placed) buckets[4].articles.push({ ...h, sentiment: "neutral" });
    }

    const symbolMatch = matchScanSymbols(headlines, picks);
    const alignedSyms = new Set();

    for (const sym of symbolMatch.matched) {
      for (const b of buckets) {
        const inBucket = b.articles.some((a) => {
          const text = (a.title || "") + " " + (a.summary || "");
          return typeof RMNewsScan !== "undefined" && RMNewsScan.symbolMatchesHeadline
            ? RMNewsScan.symbolMatchesHeadline(text, sym)
            : new RegExp("\\b" + sym + "\\b", "i").test(text);
        });
        if (inBucket) {
          b.scanAlign += 1;
          alignedSyms.add(sym);
          const pick = (picks || []).find((p) => String(p.symbol).toUpperCase() === sym);
          if (pick) pick.theme_id = b.id;
          break;
        }
      }
    }

    for (const p of picks || []) {
      if (alignedSyms.has(String(p.symbol).toUpperCase())) continue;
      const cat = p.catalyst || {};
      const top = cat.headline || cat.headlines?.[0]?.title;
      if (!top) continue;
      for (const b of buckets) {
        if (b.keywords.test(top)) {
          b.scanAlign += 1;
          alignedSyms.add(String(p.symbol).toUpperCase());
          p.theme_id = b.id;
          break;
        }
      }
    }

    const themeAligned = alignedSyms.size;
    const leading = [...buckets].sort(
      (a, b) => (b.scanAlign || 0) - (a.scanAlign || 0) || b.buzz - a.buzz
    )[0];

    lastContext = {
      scanNamesInNews: symbolMatch.count,
      matchedSymbols: symbolMatch.matched,
      themeAligned,
      leadingTheme: leading?.scanAlign > 0 || leading?.buzz > 0 ? leading.label : null,
      sources: RSS_FEEDS.map((f) => f.label).join(" · "),
    };

    return buckets;
  }

  function bucketById(themeId) {
    return lastBuckets.find((b) => b.id === themeId) || null;
  }

  function articleAt(themeId, idx) {
    const b = bucketById(themeId);
    if (!b || idx == null) return null;
    return b.articles[idx] || null;
  }

  function sentimentLabel(sent) {
    if (sent === "up") return "Bullish headline";
    if (sent === "down") return "Bearish headline";
    return "Neutral";
  }

  function isHighlightedArticle(a) {
    return a && (a.sentiment === "up" || a.sentiment === "down");
  }

  function sanitizeReaderHtml(html) {
    const doc = new DOMParser().parseFromString(
      "<div>" + String(html || "") + "</div>",
      "text/html"
    );
    const root = doc.body.firstElementChild;
    if (!root) return "";
    const allowed = new Set([
      "P",
      "A",
      "IMG",
      "H2",
      "H3",
      "H4",
      "UL",
      "OL",
      "LI",
      "STRONG",
      "EM",
      "BR",
      "FIGURE",
      "FIGCAPTION",
      "BLOCKQUOTE",
    ]);
    const walk = (node) => {
      [...node.childNodes].forEach((ch) => {
        if (ch.nodeType === 3) return;
        if (ch.nodeType !== 1) {
          ch.remove();
          return;
        }
        if (!allowed.has(ch.tagName)) {
          if (ch.tagName === "DIV" || ch.tagName === "SPAN") {
            walk(ch);
            while (ch.firstChild) ch.parentNode.insertBefore(ch.firstChild, ch);
            ch.remove();
            return;
          }
          ch.remove();
          return;
        }
        if (ch.tagName === "A") {
          ch.setAttribute("target", "_blank");
          ch.setAttribute("rel", "noopener noreferrer");
        }
        if (ch.tagName === "IMG") {
          const src = ch.getAttribute("src");
          if (!src || /^javascript:/i.test(src)) ch.remove();
          else ch.setAttribute("loading", "lazy");
        }
        walk(ch);
      });
    };
    walk(root);
    return root.innerHTML;
  }

  async function fetchArticleRich(article) {
    if (!article?.link) return { bodyHtml: "", heroImage: article?.imageUrl || null };
    if (article._reader) return article._reader;

    const encoded = encodeURIComponent(article.link);
    const proxyUrls = [
      "https://corsproxy.io/?" + encoded,
      "https://api.allorigins.win/raw?url=" + encoded,
    ];
    let html = null;
    for (const u of proxyUrls) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ARTICLE_FETCH_MS);
      try {
        if (typeof RMYahooFetch !== "undefined") {
          html = await RMYahooFetch.fetchTextViaProxies(article.link, {
            timeoutMs: ARTICLE_FETCH_MS,
          });
        } else {
          const res = await fetch(u, { cache: "no-store", signal: ctrl.signal });
          if (res.ok) html = await res.text();
        }
      } catch {
        html = null;
      } finally {
        clearTimeout(t);
      }
      if (html) break;
    }

    let bodyHtml = "";
    let heroImage = article.imageUrl || null;
    if (html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      heroImage =
        doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ||
        heroImage;
      const node =
        doc.querySelector("article") ||
        doc.querySelector('[class*="ArticleBody"]') ||
        doc.querySelector('[class*="article-body"]') ||
        doc.querySelector("main");
      if (node) bodyHtml = sanitizeReaderHtml(node.innerHTML);
      if (!bodyHtml) {
        const paras = [...doc.querySelectorAll("p")]
          .map((p) => p.textContent.trim())
          .filter((t) => t.length > 60)
          .slice(0, 12);
        bodyHtml = paras.map((t) => "<p>" + escapeHtml(t) + "</p>").join("");
      }
    }

    // Reader-mode fallback: r.jina.ai returns clean article text for sites whose
    // markup the proxies can't reach. Used only when extraction failed above.
    if (!bodyHtml) {
      const reader = await fetchText("https://r.jina.ai/" + article.link);
      if (reader) {
        const paras = String(reader)
          .split(/\n{2,}/)
          .map((t) => t.replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 60 && !/^https?:\/\//.test(t))
          .slice(0, 12);
        if (paras.length) {
          bodyHtml = paras.map((t) => "<p>" + escapeHtml(t) + "</p>").join("");
        }
      }
    }

    const hadFullBody = !!bodyHtml;
    if (!bodyHtml && article.summaryHtml) {
      bodyHtml = sanitizeReaderHtml(article.summaryHtml);
    } else if (!bodyHtml && article.summary) {
      bodyHtml = "<p>" + escapeHtml(article.summary) + "</p>";
    }

    article._reader = { bodyHtml, heroImage, failed: !hadFullBody };
    return article._reader;
  }

  function backButtonHtml(label) {
    return (
      '<button type="button" class="mkt-theme-back" aria-label="' +
      escapeAttr(label || "Back") +
      '">' +
      '<span class="mkt-theme-back-icon" aria-hidden="true">←</span>' +
      '<span class="mkt-theme-back-label">' +
      escapeHtml(label || "Back") +
      "</span></button>"
    );
  }

  function articleHeroHtml(article, reader) {
    const img = reader?.heroImage || article?.imageUrl;
    if (!img) return "";
    return (
      '<figure class="mkt-theme-hero">' +
      '<img src="' +
      escapeAttr(img) +
      '" alt="" loading="lazy" decoding="async"/>' +
      "</figure>"
    );
  }

  function renderReaderHtml(article, bucket, reader, loading) {
    const sent = article.sentiment || "neutral";
    const body = reader?.bodyHtml || "";
    return (
      '<div class="mkt-theme-reader mkt-theme-panel sent-' +
      sent +
      '" data-phase="full">' +
      backButtonHtml("Back to themes") +
      '<div class="mkt-theme-reader-scroll">' +
      (loading
        ? '<p class="mkt-theme-loading">Loading article…</p>'
        : "") +
      '<p class="mkt-theme-kicker">' +
      escapeHtml(bucket.label) +
      " · " +
      escapeHtml(article.source || bucket.sources) +
      "</p>" +
      (!loading ? articleHeroHtml(article, reader) : "") +
      '<h2 class="mkt-theme-article-title">' +
      escapeHtml(article.title) +
      "</h2>" +
      (!loading
        ? '<div class="mkt-theme-article-body">' +
          (body || "<p>" + escapeHtml(article.summary || "") + "</p>") +
          "</div>"
        : "") +
      (!loading && reader && reader.failed
        ? '<div class="mkt-theme-article-error">' +
          "<p>Couldn't load the full article.</p>" +
          '<button type="button" class="mkt-theme-retry">Retry</button>' +
          "</div>"
        : "") +
      (article.link
        ? '<a class="mkt-theme-ext-link" href="' +
          escapeAttr(article.link) +
          '" target="_blank" rel="noopener noreferrer">Read on publisher site ↗</a>'
        : "") +
      "</div></div>"
    );
  }

  function ensureReaderPortal() {
    marketBodyEl =
      marketBodyEl ||
      document.querySelector("#workspaceMarket .workspace-market-body");
    if (!marketBodyEl) return null;
    if (!readerPortal) {
      readerPortal = document.createElement("div");
      readerPortal.className = "mkt-theme-reader-portal";
      readerPortal.hidden = true;
      marketBodyEl.appendChild(readerPortal);
    }
    return readerPortal;
  }

  // Two phases only: "idle" (theme grid) and "full" (article reader overlay).
  function setPhase(phase) {
    ui.phase = phase;
    if (rootEl) rootEl.dataset.phase = phase;
    if (marketBodyEl) {
      marketBodyEl.classList.toggle("workspace-market-body--mkt-reader", phase === "full");
    }
    if (readerPortal) {
      readerPortal.hidden = phase !== "full";
      readerPortal.classList.toggle("mkt-theme-reader-portal--open", phase === "full");
    }
  }

  function clearLeaveTimer() {
    if (ui.leaveTimer) {
      clearTimeout(ui.leaveTimer);
      ui.leaveTimer = null;
    }
  }

  function collapseToIdle() {
    clearLeaveTimer();
    ui.themeId = null;
    ui.articleIdx = null;
    ui.fetchToken++;
    setPhase("idle");
    if (!rootEl) return;
    const grid = rootEl.querySelector(".mkt-theme-grid-view");
    const preview = rootEl.querySelector(".mkt-theme-preview-slot");
    if (grid) {
      grid.classList.remove("mkt-theme-grid-view--hidden");
      grid.hidden = false;
    }
    if (preview) {
      preview.innerHTML = "";
      preview.hidden = true;
      preview.classList.remove("mkt-theme-preview-slot--open");
    }
    if (readerPortal) readerPortal.innerHTML = "";
    renderHeatmapGrid(rootEl.querySelector(".mkt-theme-grid"), lastBuckets);
    bindChipClicks(rootEl);
  }

  async function openFull(themeId, articleIdx) {
    const article = articleAt(themeId, articleIdx);
    const bucket = bucketById(themeId);
    if (!article || !bucket) return;
    const portal = ensureReaderPortal();
    if (!portal) return;

    clearLeaveTimer();
    ui.themeId = themeId;
    ui.articleIdx = articleIdx;
    const token = ++ui.fetchToken;
    setPhase("full");

    portal.innerHTML = renderReaderHtml(article, bucket, null, true);
    bindReaderPortal(portal, themeId, articleIdx);

    const reader = await fetchArticleRich(article);
    if (token !== ui.fetchToken || ui.phase !== "full") return;
    portal.innerHTML = renderReaderHtml(article, bucket, reader, false);
    bindReaderPortal(portal, themeId, articleIdx);
  }

  function bindReaderPortal(portal, themeId, articleIdx) {
    portal.querySelector(".mkt-theme-back")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      collapseToIdle();
    });
    portal.querySelector(".mkt-theme-ext-link")?.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    portal.querySelector(".mkt-theme-retry")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const article = articleAt(themeId, articleIdx);
      if (article) delete article._reader; // force a fresh fetch
      openFull(themeId, articleIdx);
    });
  }

  // Two-state model (item 18): a chip click opens the full reader directly;
  // Back returns straight to the theme grid. No intermediate preview.
  function onChipClick(e) {
    const chip = e.target.closest(".mkt-theme-chip--hit");
    if (!chip || !rootEl) return;
    e.preventDefault();
    e.stopPropagation();
    const tile = chip.closest("[data-theme]");
    if (!tile) return;
    const themeId = tile.dataset.theme;
    const articleIdx = Number(chip.dataset.articleIdx);
    if (!themeId || Number.isNaN(articleIdx)) return;
    openFull(themeId, articleIdx);
  }

  function bindChipClicks(container) {
    if (!container) return;
    container.querySelectorAll(".mkt-theme-chip--hit").forEach((chip) => {
      if (chip.dataset.mktBound) return;
      chip.dataset.mktBound = "1";
      chip.addEventListener("click", onChipClick);
    });
  }

  function bindHoverCollapse() {
    if (hoverBound) return;
    const panel = document.getElementById("workspaceMarket");
    if (!panel) return;
    hoverBound = true;
    panel.addEventListener("mouseleave", () => {
      if (ui.phase === "idle") return;
      clearLeaveTimer();
      ui.leaveTimer = setTimeout(collapseToIdle, HOVER_COLLAPSE_MS);
    });
    panel.addEventListener("mouseenter", () => {
      clearLeaveTimer();
    });
  }

  function renderChipHtml(a, idx) {
    const sent = a.sentiment || "neutral";
    const hit = isHighlightedArticle(a);
    const label = (a.title || "").slice(0, 42) + (a.title && a.title.length > 42 ? "…" : "");
    if (hit) {
      return (
        '<button type="button" class="mkt-theme-chip mkt-theme-chip--hit sent-' +
        sent +
        '" data-article-idx="' +
        idx +
        '">' +
        escapeHtml(label) +
        "</button>"
      );
    }
    return '<span class="mkt-theme-chip sent-' + sent + '">' + escapeHtml(label) + "</span>";
  }

  function renderHeatmapGrid(gridEl, buckets) {
    if (!gridEl) return;
    const maxBuzz = Math.max(1, ...buckets.map((b) => b.buzz));
    gridEl.innerHTML = buckets
      .map((b, idx) => {
        const size = 0.85 + (b.buzz / maxBuzz) * 1.35;
        const minH = Math.round(88 + (b.buzz / maxBuzz) * 72);
        const articles = (b.articles || []).slice(0, 3);
        const shift =
          b.sentimentScore > 0
            ? "Bullish shift"
            : b.sentimentScore < 0
              ? "Bearish shift"
              : "Mixed tone";
        const chips = articles.map((a, i) => renderChipHtml(a, i)).join("");
        const scanBadge =
          b.scanAlign > 0
            ? '<span class="mkt-theme-scan">' + b.scanAlign + " scan</span>"
            : "";
        const tileSent =
          b.sentimentScore > 0 ? "up" : b.sentimentScore < 0 ? "down" : "neutral";
        // Empty bucket → keep a live shimmer chip so it reads as "still loading".
        const chipsHtml =
          chips ||
          '<span class="mkt-theme-chip mkt-theme-chip--loading" aria-hidden="true"></span>';
        return (
          '<div class="mkt-theme-tile sent-' +
          tileSent +
          '" role="listitem" data-theme="' +
          escapeAttr(b.id) +
          '" style="flex-grow:' +
          size.toFixed(2) +
          ";min-height:" +
          minH +
          "px;--i:" +
          idx +
          '">' +
          '<span class="mkt-theme-head">' +
          '<span class="mkt-theme-label">' +
          escapeHtml(b.label) +
          "</span>" +
          '<span class="mkt-theme-buzz">' +
          Math.round(b.buzz) +
          "</span>" +
          scanBadge +
          "</span>" +
          '<span class="mkt-theme-chips">' +
          chipsHtml +
          "</span>" +
          '<span class="mkt-theme-sources">' +
          escapeHtml(b.sources) +
          "</span>" +
          '<span class="mkt-theme-hover">' +
          escapeHtml(shift) +
          "</span></div>"
        );
      })
      .join("");
  }

  function renderHeatmap(container, buckets, opts) {
    if (!container) return;
    const animateIn = !!opts?.animateIn;
    lastBuckets = buckets;
    rootEl = container;
    container.classList.add("mkt-theme-root");
    container.dataset.phase = ui.phase;
    container.innerHTML =
      '<div class="mkt-theme-grid-view' +
      (animateIn ? " mkt-theme-grid-view--enter" : "") +
      '" role="list"><div class="mkt-theme-grid"></div></div>';
    const grid = container.querySelector(".mkt-theme-grid");
    renderHeatmapGrid(grid, buckets);
    if (ui.phase === "full" && ui.themeId != null && ui.articleIdx != null) {
      openFull(ui.themeId, ui.articleIdx);
    } else {
      setPhase("idle");
    }
    bindChipClicks(container);
    bindHoverCollapse();
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(container);
  }

  function renderSkeleton(container) {
    if (!container) return;
    container.classList.add("mkt-theme-root");
    // Varied grow/height for a tetris-packed placeholder grid.
    const cells = [
      { g: 2.1, h: 150 },
      { g: 1.3, h: 104 },
      { g: 1.7, h: 128 },
      { g: 1.0, h: 92 },
      { g: 1.5, h: 116 },
    ];
    const tiles = cells
      .map(
        (c) =>
          '<div class="mkt-theme-tile mkt-theme-tile--skeleton" style="flex-grow:' +
          c.g +
          ";min-height:" +
          c.h +
          'px" aria-hidden="true">' +
          '<span class="mkt-skel-line mkt-skel-line--head"></span>' +
          '<span class="mkt-skel-chip"></span>' +
          '<span class="mkt-skel-chip mkt-skel-chip--sm"></span>' +
          '<span class="mkt-skel-line mkt-skel-line--src"></span>' +
          "</div>"
      )
      .join("");
    container.innerHTML =
      '<div class="mkt-theme-grid-view mkt-theme-grid-view--loading" role="list" aria-busy="true">' +
      '<div class="mkt-theme-grid">' +
      tiles +
      "</div></div>";
  }

  function headlinesApiBase() {
    try {
      if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveApiBase) {
        return global.RMMorningApi.resolveApiBase();
      }
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
      const h = global.location?.hostname;
      if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    } catch {
      /* ignore */
    }
    return "";
  }

  async function fetchHeadlinesFromApi(opts) {
    const base = headlinesApiBase();
    if (!base) return null;
    const qs = opts?.refresh ? "?refresh=1" : "";
    try {
      const res = await fetch(base + "/pulse/headlines" + qs, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length) cacheHeadlines(items);
      return { items, stale: !!data?.stale, asOf: data?.asOf || null };
    } catch {
      return null;
    }
  }

  async function refreshRssFeeds(container, picks, hadCache, haveData) {
    const collected = [];
    const seen = new Set();
    let renderedLive = false;
    await Promise.all(
      RSS_FEEDS.map(async (feed) => {
        const xml = await fetchFeedXml(feed.url);
        const items = parseRssItems(xml, feed.label);
        let added = false;
        for (const item of items) {
          const key = normalizeTitle(item.title);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          collected.push(item);
          added = true;
        }
        if (added && ui.phase === "idle") {
          renderHeatmap(container, classifyHeadlines(collected.slice(), picks), {
            animateIn: !renderedLive && !hadCache,
          });
          renderedLive = true;
        }
      })
    );
    if (collected.length) {
      cacheHeadlines(collected);
      if (ui.phase === "idle") {
        renderHeatmap(container, classifyHeadlines(collected, picks), { animateIn: false });
      }
    } else if (!hadCache && ui.phase === "idle") {
      renderHeatmap(container, classifyHeadlines([], picks), { animateIn: false });
    }
    return collected;
  }

  async function refresh(container, opts) {
    if (!container) return lastContext;
    const picks = opts?.picks || [];
    const haveData =
      lastBuckets &&
      lastBuckets.length &&
      lastBuckets.some((b) => b.articles && b.articles.length);

    const apiPayload = await fetchHeadlinesFromApi();
    const cached = readCachedHeadlines(48);
    const apiItems = apiPayload?.items?.length ? apiPayload.items : null;
    const initialItems = apiItems || cached;
    const hadCache = !!(initialItems && initialItems.length);

    if (hadCache) {
      if (ui.phase !== "idle") collapseToIdle();
      renderHeatmap(container, classifyHeadlines(initialItems, picks), { animateIn: !haveData });
    } else if (ui.phase === "idle" && !haveData) {
      renderSkeleton(container);
    }

    if (apiItems && !apiPayload.stale) {
      return lastContext;
    }

    const base = headlinesApiBase();
    if (base) {
      const refreshed = await fetchHeadlinesFromApi({ refresh: true });
      if (refreshed?.items?.length) {
        renderHeatmap(container, classifyHeadlines(refreshed.items, picks), { animateIn: false });
        return lastContext;
      }
    } else {
      await refreshRssFeeds(container, picks, hadCache, haveData);
    }
    return lastContext;
  }

  function getLastContext() {
    return lastContext;
  }

  let visibleObserver = null;

  function scheduleWhenVisible(container, opts) {
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") {
      void refresh(container, opts);
      return;
    }
    if (visibleObserver) {
      visibleObserver.disconnect();
      visibleObserver = null;
    }
    visibleObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        visibleObserver?.disconnect();
        visibleObserver = null;
        void refresh(container, opts);
      },
      { root: null, rootMargin: "80px 0px", threshold: 0.05 }
    );
    visibleObserver.observe(container);
  }

  global.RMMarketThemes = {
    refresh,
    scheduleWhenVisible,
    THEMES,
    getLastContext,
    matchScanSymbols,
    collapseReader: collapseToIdle,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- pick_list_virtual.js --- */
/**
 * Virtualized Results pick list (30+ rows): only mounts visible rows + scroll spacers.
 */
(function (global) {
  const THRESHOLD = 30;
  const ROW_HEIGHT_PX = 56;
  const BUFFER_ROWS = 6;

  let host = null;
  let scrollEl = null;
  let topSpacer = null;
  let windowEl = null;
  let bottomSpacer = null;
  let bannerEl = null;
  let picks = [];
  let renderRow = null;
  let bindRoot = null;
  let active = false;
  let raf = null;
  let resizeObs = null;

  function scrollParent(el) {
    return (
      el.closest(".ws-scans-list") ||
      el.closest(".tt-results-scroll") ||
      el
    );
  }

  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      paintWindow();
    });
  }

  function bindVisible(root) {
    if (!root || !bindRoot) return;
    bindRoot(root);
    if (typeof RMChartHub === "undefined" || !RMChartHub.renderPickMini) return;
    root.querySelectorAll("[data-pick-chart]").forEach((el) => {
      const sym = el.dataset.pickChart;
      if (sym) RMChartHub.renderPickMini(sym, el);
    });
  }

  function paintWindow() {
    if (!active || !host || !windowEl || !scrollEl) return;
    const total = picks.length;
    if (!total) {
      windowEl.innerHTML = "";
      topSpacer.style.height = "0";
      bottomSpacer.style.height = "0";
      return;
    }
    const scrollTop = Math.max(0, scrollEl.scrollTop - (bannerEl?.offsetHeight || 0));
    const viewH = scrollEl.clientHeight || 400;
    let start = Math.floor(scrollTop / ROW_HEIGHT_PX) - BUFFER_ROWS;
    let end = Math.ceil((scrollTop + viewH) / ROW_HEIGHT_PX) + BUFFER_ROWS;
    start = Math.max(0, start);
    end = Math.min(total, end);
    topSpacer.style.height = start * ROW_HEIGHT_PX + "px";
    bottomSpacer.style.height = Math.max(0, (total - end) * ROW_HEIGHT_PX) + "px";
    windowEl.innerHTML = picks.slice(start, end).map((p) => renderRow(p)).join("");
    bindVisible(windowEl);
  }

  function mount(listEl, options) {
    destroy();
    if (!listEl) return;
    host = listEl;
    renderRow = options?.renderRow;
    bindRoot = options?.bind;
    scrollEl = scrollParent(listEl);
    listEl.innerHTML = "";
    listEl.classList.add("pick-list-virtual-host");
    bannerEl = null;
    topSpacer = document.createElement("div");
    topSpacer.className = "pick-list-virtual-top";
    topSpacer.setAttribute("aria-hidden", "true");
    windowEl = document.createElement("div");
    windowEl.className = "pick-list-virtual-window";
    bottomSpacer = document.createElement("div");
    bottomSpacer.className = "pick-list-virtual-bottom";
    bottomSpacer.setAttribute("aria-hidden", "true");
    listEl.append(topSpacer, windowEl, bottomSpacer);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(() => onScroll());
      resizeObs.observe(scrollEl);
    }
  }

  function setBanner(html) {
    if (!host) return;
    if (!html) {
      bannerEl?.remove();
      bannerEl = null;
      return;
    }
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.className = "pick-list-virtual-banner";
      host.insertBefore(bannerEl, topSpacer);
    }
    bannerEl.innerHTML = html;
  }

  function render(list, bannerHtml) {
    picks = list || [];
    active = picks.length >= THRESHOLD;
    if (!host) return false;
    if (!active) return false;
    setBanner(bannerHtml || "");
    paintWindow();
    return true;
  }

  function refresh(list, bannerHtml) {
    if (!host) return false;
    picks = list || [];
    if (picks.length < THRESHOLD) {
      active = false;
      return false;
    }
    active = true;
    setBanner(bannerHtml || "");
    paintWindow();
    return true;
  }

  function updateRow(symbol, html) {
    if (!active || !windowEl) return false;
    const esc =
      typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(String(symbol))
        : String(symbol).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const row = windowEl.querySelector('.pick-row[data-symbol="' + esc + '"]');
    if (!row) return false;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const next = wrap.firstElementChild;
    if (!next) return false;
    row.replaceWith(next);
    bindVisible(windowEl);
    return true;
  }

  function scrollToSymbol(symbol) {
    if (!active || !scrollEl) return;
    const idx = picks.findIndex((p) => p.symbol === symbol);
    if (idx < 0) return;
    scrollEl.scrollTop = idx * ROW_HEIGHT_PX;
    paintWindow();
  }

  function destroy() {
    active = false;
    picks = [];
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (scrollEl) scrollEl.removeEventListener("scroll", onScroll);
    scrollEl = null;
    if (host) {
      host.classList.remove("pick-list-virtual-host");
      host.innerHTML = "";
    }
    host = null;
    topSpacer = null;
    windowEl = null;
    bottomSpacer = null;
    bannerEl = null;
  }

  global.RMVirtualPickList = {
    THRESHOLD,
    shouldVirtualize: (n) => (n || 0) >= THRESHOLD,
    isActive: () => active,
    isMounted: () => !!host,
    mount,
    render,
    refresh,
    updateRow,
    scrollToSymbol,
    destroy,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- market_panel.js --- */
/** Finviz-style market map: indices, breadth, pick heatmap. */
(function (global) {
  const SETTINGS_KEY = "rainmaker_market_map_settings_v1";
  const DEFAULT_SETTINGS = {
    showIndices: true,
    showFutures: true,
    showMacroHint: true,
    showSignals: true,
    showBreadth: true,
    showTopMover: true,
    showPickMap: true,
    showMapCatalyst: true,
    showMapVsSpy: true,
    showMapVol: true,
    showMorningBias: true,
    showExchangeBreadth: true,
    mapSort: "gap",
    indices: ["SPY", "QQQ", "IWM", "DIA", "^VIX"],
  };

  const INDEX_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA", "^VIX"];
  const FUTURES_SYMBOLS = ["$ES=F", "$NQ=F"];

  const FUTURES_META = {
    "$ES=F": {
      name: "S&P 500 futures",
      desc: "Overnight / premarket risk tone for the broad market. Often leads cash at the open.",
      short: "ES",
    },
    "$NQ=F": {
      name: "Nasdaq 100 futures",
      desc: "Growth and mega-cap tech tone. Watch ES vs NQ divergence for narrow vs broad tape.",
      short: "NQ",
    },
  };

  const INDEX_META = {
    SPY: {
      name: "S&P 500",
      desc: "Broad US large-cap benchmark. Rainmaker normalizes pick moves against SPY on the unified chart.",
    },
    QQQ: {
      name: "Nasdaq 100",
      desc: "Mega-cap growth and tech. Often leads on gap-up momentum days when semis and AI names run.",
    },
    IWM: {
      name: "Russell 2000",
      desc: "Small-cap risk appetite gauge. Rising IWM with SPY confirms broad participation.",
    },
    DIA: {
      name: "Dow 30",
      desc: "Blue-chip industrials and financials. Steady tape here supports defensive gap-and-go setups.",
    },
    "^VIX": {
      name: "VIX",
      desc: "CBOE volatility index. Spikes signal fear and risk-off; calm VIX favors momentum longs.",
    },
    VIX: {
      name: "VIX",
      desc: "CBOE volatility index. Spikes signal fear and risk-off; calm VIX favors momentum longs.",
    },
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(next) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }

  function sentimentClass(b) {
    if (!b.total) return "fv-sentiment-neutral";
    const bull = b.advPct;
    const bear = b.decPct;
    if (bull >= bear + 15) return "fv-sentiment-bull";
    if (bear >= bull + 15) return "fv-sentiment-bear";
    return "fv-sentiment-neutral";
  }

  const SIGNAL_META = {
    adv: {
      label: "Advancing",
      desc: "Scan picks trading above prior close (day change > +0.05%). More advancers = bullish breadth.",
    },
    flat: {
      label: "Unchanged",
      desc: "Picks flat vs prior close (within ±0.05%). Often still gapping — check gap column.",
    },
    dec: {
      label: "Declining",
      desc: "Picks below prior close (day change < −0.05%). Heavy decliners = weak follow-through risk.",
    },
    scan: {
      label: "Scan count",
      desc: "Total tickers in the current scan after import or H-001 market pass (before news filter).",
    },
    avg: {
      label: "Average move",
      desc: "Mean day % across picks with a valid price change. Quick read on overall scan tone.",
    },
    rm: {
      label: "Avg RM score",
      desc: "Mean H-001 RM confidence (0–100). Weights float, gap proxy, volume, move %, daily %, and price band.",
    },
  };

  const HEAT_HINT = {
    "fv-hot-up": "Strong momentum — large positive day move.",
    "fv-up": "Bullish tape — positive vs prior close.",
    "fv-flat": "Neutral — little change vs prior close.",
    "fv-down": "Bearish tape — negative vs prior close.",
    "fv-hot-down": "Weak — large negative day move.",
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function bindMarketMapTips(root) {
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(root);
    (root || document).querySelectorAll(".fv-map-cell[data-symbol]").forEach((cell) => {
      if (cell.dataset.tfBound) return;
      cell.dataset.tfBound = "1";
      cell.style.cursor = "pointer";
      let prefetchTimer = null;
      cell.addEventListener(
        "pointerenter",
        () => {
          const sym = cell.dataset.symbol;
          if (!sym || typeof RMResultsHero === "undefined" || !RMResultsHero.prefetchQuote) {
            return;
          }
          if (prefetchTimer) clearTimeout(prefetchTimer);
          prefetchTimer = setTimeout(() => {
            prefetchTimer = null;
            RMResultsHero.prefetchQuote(sym);
          }, 50);
        },
        { passive: true }
      );
      cell.addEventListener("click", () => {
        document.dispatchEvent(
          new CustomEvent("rm:select-ticker", {
            detail: { symbol: cell.dataset.symbol },
          })
        );
      });
    });
  }

  function effectiveDayPct(p) {
    if (!p) return null;
    if (
      p.live_pct != null &&
      p.live_at != null &&
      Date.now() - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ) {
      return Number(p.live_pct);
    }
    if (p.pct_change != null && !Number.isNaN(Number(p.pct_change))) {
      return Number(p.pct_change);
    }
    return null;
  }

  function isGapFade(p) {
    const gap = p.gap_pct != null ? Number(p.gap_pct) : null;
    const day = effectiveDayPct(p);
    return gap != null && gap > 3 && day != null && day < 0;
  }

  function getEffectiveIndexCacheMs(indices) {
    const spy = indices?.SPY || cachedIndices?.SPY;
    if (spy?.session === "pre") return PREMARKET_INDEX_CACHE_MS;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }).formatToParts(new Date());
      const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
      const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
      if (hour < 10 || (hour === 10 && minute < 30)) return PREMARKET_INDEX_CACHE_MS;
    } catch {
      /* fall through */
    }
    return RTH_INDEX_CACHE_MS;
  }

  function getSpyDayPct(indices) {
    const spy = indices?.SPY;
    if (spy?.chg != null && !Number.isNaN(Number(spy.chg))) return Number(spy.chg);
    return null;
  }

  function pickVsSpy(p, spyPct) {
    const day = effectiveDayPct(p);
    if (day == null || spyPct == null || Number.isNaN(spyPct)) return null;
    return Math.round((day - spyPct) * 100) / 100;
  }

  function sessionBadge(session) {
    if (session === "pre") {
      return '<span class="fv-session fv-session--pre" title="Premarket quote">PM</span>';
    }
    if (session === "post") {
      return '<span class="fv-session fv-session--post" title="After-hours quote">AH</span>';
    }
    return "";
  }

  function catalystMapLabel(cat) {
    if (!cat) {
      return { text: "?", cls: "fv-cat-review", title: "Review — run news scan" };
    }
    if (cat.verified === true) {
      return { text: "✓", cls: "fv-cat-yes", title: "Verified catalyst" };
    }
    if (cat.verified === false) {
      return { text: "—", cls: "fv-cat-no", title: "No catalyst headlines" };
    }
    if (cat.status === "news_error") {
      return { text: "!", cls: "fv-cat-err", title: "News fetch error" };
    }
    return { text: "?", cls: "fv-cat-review", title: "Awaiting news verification" };
  }

  function sortPicksForMap(picks, sortKey, spyPct) {
    const list = [...(picks || [])];
    switch (sortKey) {
      case "day":
        return list.sort(
          (a, b) => (effectiveDayPct(b) ?? -999) - (effectiveDayPct(a) ?? -999)
        );
      case "rm":
        return list.sort(
          (a, b) => (Number(b.rm_confidence) || 0) - (Number(a.rm_confidence) || 0)
        );
      case "vsSpy":
        return list.sort(
          (a, b) => (pickVsSpy(b, spyPct) ?? -999) - (pickVsSpy(a, spyPct) ?? -999)
        );
      case "gap":
      default:
        return list.sort(
          (a, b) => (Number(b.gap_pct) || -1) - (Number(a.gap_pct) || -1)
        );
    }
  }

  function mapGridColumns(settings, opts) {
    const mobile = opts?.mobile;
    const cols = ["1.15fr", "0.8fr", "0.8fr"];
    if (!mobile && settings?.showMapCatalyst !== false) cols.push("0.42fr");
    if (settings?.showMapVsSpy !== false) cols.push("0.68fr");
    if (!mobile && settings?.showMapVol !== false) cols.push("0.55fr");
    cols.push("0.52fr");
    return cols.join(" ");
  }

  function parseFinvizBreadth(html) {
    if (!html) return null;
    const text = String(html)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const re =
      /Advancing \/ Declining[\s\S]*?Advancing<\/p><p>([\d.]+)% \((\d+)\)<\/p>[\s\S]*?Declining<\/p><p>\((\d+)\) ([\d.]+)%<\/p>[\s\S]*?center-bar" style="width: ([\d.]+)%"/i;
    const m = text.match(re);
    if (!m) return null;
    return {
      adv: Number(m[2]),
      dec: Number(m[3]),
      advPct: Math.round(Number(m[1]) * 10) / 10,
      decPct: Math.round(Number(m[4]) * 10) / 10,
      unchPct: Math.round(Number(m[5]) * 10) / 10,
      total: Number(m[2]) + Number(m[3]),
      source: "finviz",
      label: "NYSE · Nasdaq · AMEX",
      at: Date.now(),
    };
  }

  async function fetchExchangeBreadthBrowser() {
    const target = "https://finviz.com/";
    let html = null;
    try {
      if (typeof RMYahooFetch !== "undefined") {
        html = await RMYahooFetch.fetchTextViaProxies(target, { timeoutMs: FETCH_MS });
      } else {
        const enc = encodeURIComponent(target);
        const res = await fetch("https://corsproxy.io/?" + enc, { cache: "no-store" });
        if (res.ok) html = await res.text();
      }
    } catch {
      return null;
    }
    return parseFinvizBreadth(html);
  }

  async function fetchExchangeBreadthApi() {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(base + "/pulse/exchange-breadth", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.advPct == null) return null;
      return { ...data, at: data.at || Date.now() };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshExchangeBreadth() {
    if (
      cachedExchangeBreadth &&
      cachedExchangeBreadthAt &&
      Date.now() - cachedExchangeBreadthAt < EXCHANGE_BREADTH_CACHE_MS
    ) {
      return cachedExchangeBreadth;
    }
    let data = await fetchExchangeBreadthApi();
    if (!data) data = await fetchExchangeBreadthBrowser();
    if (data) {
      cachedExchangeBreadth = data;
      cachedExchangeBreadthAt = Date.now();
    }
    return cachedExchangeBreadth;
  }

  function getExchangeBreadth() {
    if (
      cachedExchangeBreadth &&
      cachedExchangeBreadthAt &&
      Date.now() - cachedExchangeBreadthAt < EXCHANGE_BREADTH_CACHE_MS
    ) {
      return cachedExchangeBreadth;
    }
    return null;
  }

  function exchangeBreadthScore(ex) {
    if (!ex || ex.advPct == null || ex.decPct == null) return null;
    return biasComponentScore((Number(ex.advPct) - Number(ex.decPct)) / 100, 0.12);
  }

  function renderExchangeBreadthBar(ex) {
    if (!ex || ex.advPct == null) return "";
    const unch = Math.max(
      0,
      ex.unchPct != null ? Number(ex.unchPct) : 100 - ex.advPct - ex.decPct
    );
    const stat =
      ex.advPct + "% adv · " + ex.decPct + "% dec · " + (ex.adv || "—") + " / " + (ex.dec || "—");
    return (
      '<div class="fv-exchange-breadth-wrap fv-tip-target" tabindex="0" data-fv-kicker="Market breadth" data-fv-title="Exchange advancers vs decliners" data-fv-desc="Total advancing vs declining issues on NYSE, Nasdaq, and AMEX (Finviz). Separate from your scan breadth below." data-fv-stat="' +
      escapeAttr(stat) +
      '">' +
      '<span class="fv-exchange-breadth-label">Market breadth · ' +
      escapeHtml(ex.label || "NYSE · Nasdaq · AMEX") +
      "</span>" +
      '<div class="fv-breadth-bar fv-exchange-breadth-bar">' +
      '<div class="fv-breadth-seg fv-up" style="width:' +
      ex.advPct +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-flat" style="width:' +
      unch +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-down" style="width:' +
      ex.decPct +
      '%"></div></div>' +
      '<span class="fv-breadth-meta">' +
      escapeHtml(stat) +
      "</span></div>"
    );
  }

  const BIAS_LOG_KEY = "rm_morning_bias_log_v1";
  const BIAS_LOG_MAX = 120;

  function biasComponentScore(chg, scale) {
    if (chg == null || Number.isNaN(Number(chg))) return null;
    const v = Number(chg);
    const s = scale || 0.35;
    return Math.max(-1, Math.min(1, v / s));
  }

  function biasSpreadScore(lead, base, scale) {
    if (lead == null || base == null) return null;
    return biasComponentScore(Number(lead) - Number(base), scale || 0.25);
  }

  function biasConfidence(components) {
    const scored = (components || []).filter(
      (c) => c.score != null && !Number.isNaN(c.score)
    );
    if (scored.length < 2) return "low";
    const signs = scored.map((c) =>
      c.score > 0.08 ? 1 : c.score < -0.08 ? -1 : 0
    );
    const pos = signs.filter((s) => s > 0).length;
    const neg = signs.filter((s) => s < 0).length;
    const neutral = signs.length - pos - neg;
    const dominant = Math.max(pos, neg, neutral);
    const ratio = dominant / signs.length;
    if (ratio >= 0.8) return "high";
    if (ratio >= 0.6) return "med";
    return "low";
  }

  function aggregateBiasTrack(components, kind) {
    let sum = 0;
    let weight = 0;
    const drivers = [];
    for (const c of components || []) {
      if (c.score == null || Number.isNaN(c.score)) continue;
      sum += c.score * c.weight;
      weight += c.weight;
      if (Math.abs(c.score) >= 0.12 && c.driver) drivers.push(c.driver);
    }
    const score = weight ? sum / weight : 0;
    const pct = Math.round((score + 1) * 50);
    const confidence = biasConfidence(components);
    let label;
    if (kind === "h001") {
      label = score > 0.12 ? "Favorable" : score < -0.12 ? "Unfavorable" : "Mixed";
    } else {
      label = score > 0.12 ? "Bullish lean" : score < -0.12 ? "Bearish lean" : "Neutral";
    }
    return {
      score,
      pct,
      label,
      confidence,
      drivers: drivers.slice(0, 5),
      components,
    };
  }

  function computeMorningBias(indices, picks, breadth, exchangeBreadth) {
    const idx = indices || {};
    const ex = exchangeBreadth || getExchangeBreadth();
    const spyPct = getSpyDayPct(idx);
    const qqqPct = idx.QQQ?.chg != null ? Number(idx.QQQ.chg) : null;
    const iwmPct = idx.IWM?.chg != null ? Number(idx.IWM.chg) : null;
    const vixPct =
      idx["^VIX"]?.chg != null
        ? Number(idx["^VIX"].chg)
        : idx.VIX?.chg != null
          ? Number(idx.VIX.chg)
          : null;
    const esPct = idx["$ES=F"]?.chg != null ? Number(idx["$ES=F"].chg) : null;
    const nqPct = idx["$NQ=F"]?.chg != null ? Number(idx["$NQ=F"].chg) : null;
    const futChgs = [esPct, nqPct].filter((v) => v != null && !Number.isNaN(v));
    const futAvg = futChgs.length
      ? futChgs.reduce((a, b) => a + b, 0) / futChgs.length
      : null;

    const narrowTape =
      qqqPct != null &&
      spyPct != null &&
      qqqPct > 0.3 &&
      qqqPct - spyPct >= 0.35;

    let marketScore = aggregateBiasTrack(
      [
        {
          weight: 0.24,
          score: biasComponentScore(futAvg, 0.4),
          driver: futAvg != null ? "Futures " + fmtPct(futAvg) : null,
        },
        {
          weight: 0.18,
          score: biasComponentScore(spyPct, 0.35),
          driver: spyPct != null ? "SPY " + fmtPct(spyPct) : null,
        },
        {
          weight: 0.12,
          score: biasComponentScore(qqqPct, 0.35),
          driver: qqqPct != null ? "QQQ " + fmtPct(qqqPct) : null,
        },
        {
          weight: 0.12,
          score: biasSpreadScore(iwmPct, spyPct, 0.25),
          driver:
            iwmPct != null && spyPct != null
              ? "IWM " + fmtPct(iwmPct - spyPct) + " vs SPY"
              : null,
        },
        {
          weight: 0.16,
          score: vixPct != null ? -biasComponentScore(vixPct, 2.5) : null,
          driver: vixPct != null ? "VIX " + fmtPct(vixPct) : null,
        },
        {
          weight: 0.18,
          score: exchangeBreadthScore(ex),
          driver:
            ex && ex.advPct != null
              ? "Market " + ex.advPct + "% adv / " + ex.decPct + "% dec"
              : null,
        },
      ],
      "market"
    );

    if (narrowTape && marketScore.score > 0) {
      marketScore = {
        ...marketScore,
        score: Math.max(-1, marketScore.score - 0.12),
        pct: Math.round((Math.max(-1, marketScore.score - 0.12) + 1) * 50),
        drivers: ["Narrow tape (QQQ > SPY)"].concat(marketScore.drivers).slice(0, 5),
        confidence: marketScore.confidence === "high" ? "med" : marketScore.confidence,
      };
    }

    const b = breadth || computeBreadth(picks);
    const list = picks || [];
    const gapFadeN = list.filter(isGapFade).length;
    const gapFadePct = list.length ? gapFadeN / list.length : 0;
    const listVsSpy =
      b.avgPct != null && spyPct != null ? b.avgPct - spyPct : null;
    const breadthSkew = b.total ? (b.advPct - b.decPct) / 100 : null;
    const gapHoldScore =
      list.length === 0
        ? null
        : gapFadePct <= 0.1
          ? 0.35
          : gapFadePct >= 0.35
            ? -0.8
            : -gapFadePct * 1.5;

    const h001 = aggregateBiasTrack(
      [
        {
          weight: 0.4,
          score: biasComponentScore(listVsSpy, 1.5),
          driver:
            listVsSpy != null ? "List " + fmtPct(listVsSpy) + " vs SPY" : null,
        },
        {
          weight: 0.35,
          score: biasComponentScore(breadthSkew, 0.3),
          driver:
            b.total
              ? "Scan " + b.advPct + "% adv / " + b.decPct + "% dec"
              : null,
        },
        {
          weight: 0.25,
          score: gapHoldScore,
          driver:
            list.length
              ? gapFadeN
                ? gapFadeN + " gap fade" + (gapFadeN === 1 ? "" : "s")
                : "Gaps holding"
              : null,
        },
      ],
      "h001"
    );

    const conflict =
      list.length > 0 &&
      Math.sign(marketScore.score || 0) !== 0 &&
      Math.sign(h001.score || 0) !== 0 &&
      Math.sign(marketScore.score) !== Math.sign(h001.score);

    return {
      at: Date.now(),
      market: marketScore,
      h001,
      exchangeBreadth: ex || null,
      narrowTape,
      conflict,
    };
  }

  function mergeMorningBias(serverBias, clientBias, picks) {
    if (!serverBias?.market) return clientBias;
    const list = picks || [];
    const merged = {
      at: serverBias.at || clientBias.at,
      market: serverBias.market,
      h001:
        serverBias.h001 && list.length ? serverBias.h001 : clientBias.h001,
      exchangeBreadth: clientBias.exchangeBreadth,
      narrowTape: serverBias.narrowTape ?? clientBias.narrowTape,
      conflict: false,
    };
    if (list.length && merged.h001) {
      merged.conflict =
        Math.sign(merged.market.score || 0) !== 0 &&
        Math.sign(merged.h001.score || 0) !== 0 &&
        Math.sign(merged.market.score) !== Math.sign(merged.h001.score);
    }
    return merged;
  }

  function resolveMorningBias(indices, picks, breadth, exchangeBreadth) {
    const client = computeMorningBias(indices, picks, breadth, exchangeBreadth);
    return mergeMorningBias(lastServerMorningBias, client, picks);
  }

  function logMorningBias(bias) {
    if (!bias?.market) return;
    try {
      const raw = localStorage.getItem(BIAS_LOG_KEY);
      const log = raw ? JSON.parse(raw) : [];
      const last = log[log.length - 1];
      const now = bias.at || Date.now();
      if (last && now - last.at < 120000) {
        if (
          last.marketPct === bias.market.pct &&
          last.h001Pct === (bias.h001?.pct ?? null)
        ) {
          return;
        }
      }
      log.push({
        at: now,
        marketPct: bias.market.pct,
        marketLabel: bias.market.label,
        marketConf: bias.market.confidence,
        h001Pct: bias.h001?.pct ?? null,
        h001Label: bias.h001?.label ?? null,
        h001Conf: bias.h001?.confidence ?? null,
        exchangeAdvPct: bias.exchangeBreadth?.advPct ?? null,
        exchangeDecPct: bias.exchangeBreadth?.decPct ?? null,
        conflict: !!bias.conflict,
      });
      while (log.length > BIAS_LOG_MAX) log.shift();
      localStorage.setItem(BIAS_LOG_KEY, JSON.stringify(log));
    } catch {
      /* ignore */
    }
  }

  function loadBiasLog() {
    try {
      const raw = localStorage.getItem(BIAS_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function normalizeBiasLogEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const at = raw.at ?? raw.loggedAt;
    if (at == null || !Number.isFinite(Number(at))) return null;
    return {
      at: Number(at),
      marketPct: raw.marketPct ?? null,
      marketLabel: raw.marketLabel ?? null,
      marketConf: raw.marketConf ?? null,
      h001Pct: raw.h001Pct ?? null,
      h001Label: raw.h001Label ?? null,
      h001Conf: raw.h001Conf ?? null,
      exchangeAdvPct: raw.exchangeAdvPct ?? null,
      exchangeDecPct: raw.exchangeDecPct ?? null,
      conflict: !!raw.conflict,
    };
  }

  function parseBiasLogPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload?.entries && Array.isArray(payload.entries)) return payload.entries;
    throw new Error("Invalid bias log JSON (expected { entries: [...] }).");
  }

  function mergeBiasLogEntries(existing, incoming) {
    const map = new Map();
    for (const e of existing || []) {
      const n = normalizeBiasLogEntry(e);
      if (n) map.set(n.at, n);
    }
    let added = 0;
    for (const e of incoming || []) {
      const n = normalizeBiasLogEntry(e);
      if (!n) continue;
      if (!map.has(n.at)) added++;
      map.set(n.at, n);
    }
    let log = [...map.values()].sort((a, b) => a.at - b.at);
    if (log.length > BIAS_LOG_MAX) log = log.slice(-BIAS_LOG_MAX);
    return { log, added };
  }

  function saveBiasLog(log) {
    localStorage.setItem(BIAS_LOG_KEY, JSON.stringify(log || []));
  }

  function updateBiasCalToggleLabel(root) {
    const btn = root?.querySelector("#fvBiasCalToggle");
    if (!btn) return;
    btn.textContent = "Learning details";
    btn.setAttribute("aria-label", loadBiasLog().length + " mornings in bias log");
  }

  function importBiasLogPayload(payload) {
    const incoming = parseBiasLogPayload(payload);
    const { log, added } = mergeBiasLogEntries(loadBiasLog(), incoming);
    saveBiasLog(log);
    engineAccuracyCache = null;
    return { added, total: log.length };
  }

  async function fetchBiasLogApi(limit) {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const lim = limit != null ? limit : BIAS_LOG_MAX;
      const res = await fetch(base + "/pulse/bias-log?limit=" + lim, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function pullBiasLogFromApi() {
    const data = await fetchBiasLogApi(BIAS_LOG_MAX);
    if (!data?.entries?.length) {
      return { added: 0, total: loadBiasLog().length };
    }
    const { log, added } = mergeBiasLogEntries(loadBiasLog(), data.entries);
    saveBiasLog(log);
    return { added, total: log.length };
  }

  function etDateKey(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }

  function sessionBiasLog(log) {
    const byDay = new Map();
    for (const e of log || []) {
      if (!e?.at) continue;
      const key = etDateKey(e.at);
      if (!byDay.has(key)) byDay.set(key, e);
    }
    return [...byDay.values()].sort((a, b) => a.at - b.at);
  }

  async function fetchSpyDailyChanges() {
    if (typeof RMYahooFetch === "undefined" || !RMYahooFetch.fetchChartBars) return null;
    const payload = await RMYahooFetch.fetchChartBars("SPY", "1d", "1y");
    const bars = payload?.bars || (Array.isArray(payload) ? payload : null);
    if (!bars?.length) return null;
    const spyByDate = {};
    const tradingDays = [];
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1].close;
      const cur = bars[i].close;
      if (!prev || !cur) continue;
      const key = etDateKey(bars[i].t);
      spyByDate[key] = Math.round(((cur - prev) / prev) * 1000) / 10;
      if (!tradingDays.includes(key)) tradingDays.push(key);
    }
    return { spyByDate, tradingDays };
  }

  function nextTradingDay(day, tradingDays) {
    const idx = tradingDays.indexOf(day);
    if (idx < 0 || idx >= tradingDays.length - 1) return null;
    return tradingDays[idx + 1];
  }

  function biasLeanSign(pct) {
    if (pct == null || Number.isNaN(Number(pct))) return 0;
    if (pct >= 58) return 1;
    if (pct <= 42) return -1;
    return 0;
  }

  // horizon "next" (default) grades the lean vs the next trading day's SPY move;
  // "same" grades it vs that same session's SPY move (was the morning read right today?).
  // opts.confVal + opts.confField filter to a confidence tier (e.g. only "high" reads).
  function directionalHitRate(sessions, pctKey, spyByDate, tradingDays, opts) {
    const horizon = opts?.horizon === "same" ? "same" : "next";
    const confVal = opts?.confVal || null;
    const confField = opts?.confField || "marketConf";
    let hits = 0;
    let n = 0;
    for (const e of sessions) {
      if (confVal && (e[confField] || "low") !== confVal) continue;
      const day = etDateKey(e.at);
      const target = horizon === "same" ? day : nextTradingDay(day, tradingDays);
      if (!target) continue;
      const spyChg = spyByDate[target];
      if (spyChg == null) continue;
      const lean = biasLeanSign(e[pctKey]);
      if (!lean) continue;
      n++;
      if ((lean > 0 && spyChg > 0) || (lean < 0 && spyChg < 0)) hits++;
    }
    return { hits, n, rate: n ? Math.round((hits / n) * 100) : null };
  }

  function pearsonCorrelation(xs, ys) {
    if (!xs?.length || xs.length !== ys.length || xs.length < 3) return null;
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let denX = 0;
    let denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    if (!denX || !denY) return null;
    return Math.round((num / Math.sqrt(denX * denY)) * 1000) / 1000;
  }

  function correlationTrack(sessions, pctKey, spyByDate, tradingDays) {
    const xs = [];
    const ys = [];
    for (const e of sessions) {
      if (e[pctKey] == null) continue;
      const day = etDateKey(e.at);
      const nxt = nextTradingDay(day, tradingDays);
      if (!nxt) continue;
      const spyChg = spyByDate[nxt];
      if (spyChg == null) continue;
      xs.push(Number(e[pctKey]) - 50);
      ys.push(spyChg);
    }
    return pearsonCorrelation(xs, ys);
  }

  /* Compact engine-verdict snapshot to durably stamp onto an opened trade, so
     "what did the engine say when I entered?" survives even if the bias log is
     cleared or re-synced. */
  function biasSnapshot(bias) {
    if (!bias?.market) return null;
    const pct = bias.market.pct;
    return {
      lean: biasLeanSign(pct),
      marketPct: pct ?? null,
      marketLabel: bias.market.label ?? null,
      marketConf: bias.market.confidence ?? null,
      h001Pct: bias.h001?.pct ?? null,
      at: bias.at || Date.now(),
    };
  }

  function currentBiasSnapshot() {
    return biasSnapshot(lastMorningBias);
  }

  function loadClosedTrades() {
    try {
      const key = "rainmaker_ytd_" + new Date().getFullYear();
      const arr = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(arr)) return [];
      return arr.filter((t) => t && t.status === "closed" && t.filled !== false);
    } catch {
      return [];
    }
  }

  function tradeWin(t) {
    const entry = t.entry_price ?? t.entry_premium;
    const exit = t.exit_price;
    if (entry == null || exit == null) return null;
    return exit > entry;
  }

  function tradeR(t) {
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.rMultiple) {
      const r = RMTradeMetrics.rMultiple(t);
      return r != null && Number.isFinite(r) ? r : null;
    }
    return t.r_multiple != null && Number.isFinite(t.r_multiple) ? t.r_multiple : null;
  }

  /* Join closed trades to the engine's morning call (stamp first, else by ET day)
     so we can answer "when the engine said bull, did MY trades work?" */
  function biasOutcomeJoin(sessions) {
    const sess = sessions || sessionBiasLog(loadBiasLog());
    const leanByDay = new Map();
    for (const e of sess) leanByDay.set(etDateKey(e.at), biasLeanSign(e.marketPct));
    const trades = loadClosedTrades();
    const mk = () => ({ trades: 0, wins: 0, winN: 0, rSum: 0, rN: 0 });
    const buckets = { bull: mk(), bear: mk(), neutral: mk() };
    let matched = 0;
    for (const t of trades) {
      let lean = null;
      if (t.engine_bias && typeof t.engine_bias.lean === "number") {
        lean = t.engine_bias.lean;
      } else {
        const ts = Date.parse(t.opened_at || t.closed_at || "");
        if (!Number.isFinite(ts)) continue;
        const day = etDateKey(ts);
        if (!leanByDay.has(day)) continue;
        lean = leanByDay.get(day);
      }
      if (lean == null) continue;
      const b = lean > 0 ? buckets.bull : lean < 0 ? buckets.bear : buckets.neutral;
      b.trades++;
      matched++;
      const win = tradeWin(t);
      if (win != null) {
        b.winN++;
        if (win) b.wins++;
      }
      const r = tradeR(t);
      if (r != null) {
        b.rN++;
        b.rSum += r;
      }
    }
    const fmt = (b) => ({
      trades: b.trades,
      winPct: b.winN ? Math.round((b.wins / b.winN) * 100) : null,
      avgR: b.rN ? Math.round((b.rSum / b.rN) * 100) / 100 : null,
    });
    return {
      matched,
      bull: fmt(buckets.bull),
      bear: fmt(buckets.bear),
      neutral: fmt(buckets.neutral),
    };
  }

  async function computeBiasCalibrationLocal(log) {
    const entries = log || loadBiasLog();
    const sessions = sessionBiasLog(entries);
    if (!sessions.length) {
      return {
        days: 0,
        entries: entries.length,
        recentRows: [],
        tradeOutcomes: biasOutcomeJoin(sessions),
      };
    }
    const spy = await fetchSpyDailyChanges();
    if (!spy) {
      throw new Error("Could not load SPY history for calibration.");
    }
    const { spyByDate, tradingDays } = spy;
    const marketNext = directionalHitRate(
      sessions,
      "marketPct",
      spyByDate,
      tradingDays
    );
    const marketSame = directionalHitRate(sessions, "marketPct", spyByDate, tradingDays, {
      horizon: "same",
    });
    const h001Next = directionalHitRate(
      sessions,
      "h001Pct",
      spyByDate,
      tradingDays
    );
    const tierBreakdown = ["high", "med", "low"]
      .map((tier) => {
        const same = directionalHitRate(sessions, "marketPct", spyByDate, tradingDays, {
          horizon: "same",
          confVal: tier,
        });
        const next = directionalHitRate(sessions, "marketPct", spyByDate, tradingDays, {
          horizon: "next",
          confVal: tier,
        });
        return {
          tier,
          sameHit: same.rate,
          sameN: same.n,
          nextHit: next.rate,
          nextN: next.n,
        };
      })
      .filter((row) => row.sameN > 0 || row.nextN > 0);
    const bullNext = [];
    const bearNext = [];
    for (const e of sessions) {
      const lean = biasLeanSign(e.marketPct);
      const nxt = nextTradingDay(etDateKey(e.at), tradingDays);
      if (!nxt) continue;
      const spyChg = spyByDate[nxt];
      if (spyChg == null) continue;
      if (lean > 0) bullNext.push(spyChg);
      else if (lean < 0) bearNext.push(spyChg);
    }
    const recentRows = sessions.slice(-8).map((e) => {
      const day = etDateKey(e.at);
      const nxt = nextTradingDay(day, tradingDays);
      return {
        date: day,
        marketPct: e.marketPct,
        h001Pct: e.h001Pct,
        nextSpyPct: nxt ? spyByDate[nxt] : null,
      };
    });
    return {
      days: sessions.length,
      entries: entries.length,
      marketNextHit: marketNext.rate,
      marketNextN: marketNext.n,
      marketSameHit: marketSame.rate,
      marketSameN: marketSame.n,
      h001NextHit: h001Next.rate,
      h001NextN: h001Next.n,
      tierBreakdown,
      tradeOutcomes: biasOutcomeJoin(sessions),
      marketCorr: correlationTrack(sessions, "marketPct", spyByDate, tradingDays),
      h001Corr: correlationTrack(sessions, "h001Pct", spyByDate, tradingDays),
      avgNextSpyWhenBull: bullNext.length
        ? Math.round((bullNext.reduce((a, b) => a + b, 0) / bullNext.length) * 100) / 100
        : null,
      avgNextSpyWhenBear: bearNext.length
        ? Math.round((bearNext.reduce((a, b) => a + b, 0) / bearNext.length) * 100) / 100
        : null,
      recentRows,
    };
  }

  async function fetchBiasCalibrationApi() {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(base + "/pulse/bias-log/calibration", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function exportBiasLogJson() {
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      entries: loadBiasLog(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      "rainmaker-bias-log-" + etDateKey(Date.now()) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function syncBiasLogApi() {
    const base = getRainmakerApiBase();
    if (!base) throw new Error("Set rainmaker_api_base or run rm_api locally.");
    const entries = loadBiasLog();
    let upload = null;
    if (entries.length) {
      const res = await fetch(base + "/pulse/bias-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries, clientId: "morning_app" }),
      });
      if (!res.ok) throw new Error("Sync failed (" + res.status + ").");
      upload = await res.json();
    }
    const pull = await pullBiasLogFromApi();
    if (!upload && !pull.total) {
      throw new Error("Nothing to upload and API log is empty.");
    }
    return {
      inserted: upload?.inserted ?? 0,
      updated: upload?.updated ?? 0,
      received: upload?.received ?? 0,
      pulled: pull.added,
      total: pull.total,
    };
  }

  function clearBiasLog() {
    localStorage.removeItem(BIAS_LOG_KEY);
    engineAccuracyCache = null;
  }

  function fmtCalRate(rate, n) {
    if (rate == null || !n) return "—";
    return rate + "% (" + n + "d)";
  }

  function renderBiasCalibrationActionsHtml() {
    return (
      '<div class="fv-bias-cal-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-export>Export JSON</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-import>Import JSON</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-sync>Sync API</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-clear>Clear log</button>' +
      "</div>"
    );
  }

  function fmtOutcome(o) {
    if (!o || !o.trades) return "—";
    const parts = [];
    if (o.avgR != null) parts.push((o.avgR >= 0 ? "+" : "") + o.avgR.toFixed(2) + "R");
    if (o.winPct != null) parts.push(o.winPct + "% win");
    parts.push(o.trades + (o.trades === 1 ? " trade" : " trades"));
    return parts.join(" · ");
  }

  function renderBiasOutcomesHtml(outcomes) {
    if (!outcomes) return "";
    const rowsDef = [
      ["Engine bull days", outcomes.bull],
      ["Engine bear days", outcomes.bear],
      ["Engine neutral days", outcomes.neutral],
    ].filter(([, o]) => o && o.trades > 0);
    if (!rowsDef.length) {
      return (
        '<p class="fv-bias-cal-note fv-bias-outcomes-empty">Close a few trades to see how your fills did under each engine call.</p>'
      );
    }
    return (
      '<div class="fv-bias-outcomes">' +
      '<p class="fv-bias-cal-title">Your trades by engine call</p>' +
      rowsDef
        .map(
          ([label, o]) =>
            '<div class="fv-bias-outcome-row"><span class="fv-bias-outcome-k">' +
            escapeHtml(label) +
            '</span><strong class="' +
            (o.avgR != null ? (o.avgR >= 0 ? "is-pos" : "is-neg") : "") +
            '">' +
            escapeHtml(fmtOutcome(o)) +
            "</strong></div>"
        )
        .join("") +
      "</div>"
    );
  }

  function renderBiasCalibrationPanel(stats, state) {
    if (state?.loading) {
      return (
        '<div class="fv-bias-cal fv-bias-cal--loading">' +
        "Loading SPY history…" +
        '<p class="fv-bias-cal-note">Use Import JSON to merge a file from another device.</p>' +
        renderBiasCalibrationActionsHtml() +
        "</div>"
      );
    }
    if (state?.error) {
      return (
        '<div class="fv-bias-cal fv-bias-cal--err">' +
        escapeHtml(state.error) +
        '<p class="fv-bias-cal-note">You can still import an exported bias log below.</p>' +
        renderBiasCalibrationActionsHtml() +
        "</div>"
      );
    }
    const s = stats || {};
    const rows = (s.recentRows || [])
      .map(
        (r) =>
          "<tr><td>" +
          escapeHtml(r.date) +
          "</td><td>" +
          (r.marketPct ?? "—") +
          "</td><td>" +
          (r.h001Pct ?? "—") +
          "</td><td>" +
          (r.nextSpyPct != null ? fmtPct(r.nextSpyPct) : "—") +
          "</td></tr>"
      )
      .join("");
    return (
      '<div class="fv-bias-cal">' +
      '<p class="fv-bias-cal-title">Calibration · ' +
      (s.days || 0) +
      " sessions · " +
      (s.entries || 0) +
      " samples</p>" +
      '<div class="fv-bias-cal-grid">' +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Market → same SPY</span><strong>' +
      escapeHtml(fmtCalRate(s.marketSameHit, s.marketSameN)) +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Market → next SPY</span><strong>' +
      escapeHtml(fmtCalRate(s.marketNextHit, s.marketNextN)) +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">H-001 → next SPY</span><strong>' +
      escapeHtml(fmtCalRate(s.h001NextHit, s.h001NextN)) +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Market ρ</span><strong>' +
      escapeHtml(s.marketCorr != null ? String(s.marketCorr) : "—") +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Avg next SPY</span><strong>' +
      escapeHtml(
        (s.avgNextSpyWhenBull != null ? "bull " + fmtPct(s.avgNextSpyWhenBull) : "—") +
          (s.avgNextSpyWhenBear != null ? " · bear " + fmtPct(s.avgNextSpyWhenBear) : "")
      ) +
      "</strong></div></div>" +
      (s.tierBreakdown && s.tierBreakdown.length
        ? '<table class="fv-bias-cal-table fv-bias-cal-tiers"><thead><tr><th>Conf</th><th>Same-day</th><th>Next-day</th></tr></thead><tbody>' +
          s.tierBreakdown
            .map(
              (t) =>
                "<tr><td>" +
                escapeHtml(String(t.tier || "").toUpperCase()) +
                "</td><td>" +
                escapeHtml(fmtCalRate(t.sameHit, t.sameN)) +
                "</td><td>" +
                escapeHtml(fmtCalRate(t.nextHit, t.nextN)) +
                "</td></tr>"
            )
            .join("") +
          "</tbody></table>"
        : "") +
      renderBiasOutcomesHtml(s.tradeOutcomes) +
      (rows
        ? '<table class="fv-bias-cal-table"><thead><tr><th>Date</th><th>Mkt</th><th>H-001</th><th>Next SPY</th></tr></thead><tbody>' +
          rows +
          "</tbody></table>"
        : '<p class="fv-bias-cal-note">Log a few morning sessions to build calibration stats.</p>') +
      renderBiasCalibrationActionsHtml() +
      "</div>"
    );
  }

  async function refreshBiasCalibrationPanel(wrap) {
    if (!wrap) return;
    wrap.classList.remove("hidden");
    wrap.innerHTML = renderBiasCalibrationPanel(null, { loading: true });
    const root = wrap.closest(".fv-market") || wrap.parentElement;
    try {
      if (getRainmakerApiBase()) {
        await pullBiasLogFromApi();
        updateBiasCalToggleLabel(root);
      }
      let stats = await fetchBiasCalibrationApi();
      if (!stats || !stats.days) {
        stats = await computeBiasCalibrationLocal();
      }
      wrap.innerHTML = renderBiasCalibrationPanel(stats, null);
    } catch (e) {
      wrap.innerHTML = renderBiasCalibrationPanel(null, {
        error: e?.message || "Calibration failed",
      });
    }
    bindBiasCalibrationActions(root);
  }

  function ensureBiasLogImportInput(root) {
    if (!root) return null;
    let inp = root.querySelector("#fvBiasLogImportInput");
    if (inp) return inp;
    inp = document.createElement("input");
    inp.type = "file";
    inp.id = "fvBiasLogImportInput";
    inp.accept = "application/json,.json";
    inp.hidden = true;
    inp.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      inp.value = "";
      if (!file) return;
      const host = inp.closest(".fv-market");
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const result = importBiasLogPayload(payload);
        updateBiasCalToggleLabel(host);
        const wrap = host?.querySelector("#fvBiasCalWrap");
        if (wrap && !wrap.classList.contains("hidden")) {
          await refreshBiasCalibrationPanel(wrap);
        }
        alert(
          "Imported " +
            result.added +
            " new · " +
            result.total +
            " total in this browser"
        );
      } catch (err) {
        alert(err?.message || "Import failed");
      }
    });
    root.appendChild(inp);
    return inp;
  }

  function bindBiasCalibrationActions(root) {
    if (!root) return;
    ensureBiasLogImportInput(root);
    if (root.dataset.biasCalActionsBound === "1") return;
    root.dataset.biasCalActionsBound = "1";
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-bias-export]")) {
        e.preventDefault();
        exportBiasLogJson();
        return;
      }
      if (e.target.closest("[data-bias-import]")) {
        e.preventDefault();
        ensureBiasLogImportInput(root)?.click();
        return;
      }
      if (e.target.closest("[data-bias-clear]")) {
        e.preventDefault();
        if (!confirm("Clear local bias log?")) return;
        clearBiasLog();
        updateBiasCalToggleLabel(root);
        const wrap = root.querySelector("#fvBiasCalWrap");
        if (wrap) {
          wrap.innerHTML = renderBiasCalibrationPanel(
            { days: 0, entries: 0, recentRows: [] },
            null
          );
        }
        return;
      }
      const syncBtn = e.target.closest("[data-bias-sync]");
      if (!syncBtn || syncBtn.disabled) return;
      e.preventDefault();
      void (async () => {
        syncBtn.disabled = true;
        try {
          const result = await syncBiasLogApi();
          updateBiasCalToggleLabel(root);
          syncBtn.textContent = "Synced " + (result.total ?? "");
          const wrap = root.querySelector("#fvBiasCalWrap");
          if (wrap) await refreshBiasCalibrationPanel(wrap);
        } catch (err) {
          alert(err?.message || "Sync failed");
          syncBtn.textContent = "Sync API";
        } finally {
          syncBtn.disabled = false;
        }
      })();
    });
  }

  /* ---- Always-visible engine trust line (Phase 1) ----
     Surfaces the morning-bias→next-day-SPY hit rate (already computed for the
     calibration panel) as a headline trust stat, with an honest low-sample guard.
     Cached so it never re-hammers the SPY history fetch. */
  const ENGINE_TRUST_MIN_SESSIONS = 5;
  const ENGINE_ACCURACY_TTL_MS = 30 * 60 * 1000;
  let engineAccuracyCache = null;
  let engineAccuracyInflight = null;

  function summarizeEngineAccuracy(stats) {
    const sessions = stats?.days || 0;
    const hit = stats?.marketNextHit;
    const samples = stats?.marketNextN || 0;
    const ready = hit != null && samples >= ENGINE_TRUST_MIN_SESSIONS;
    return {
      ready,
      sessions,
      samples,
      minSessions: ENGINE_TRUST_MIN_SESSIONS,
      hitRate: hit != null ? Number(hit) : null,
      corr: stats?.marketCorr ?? null,
    };
  }

  async function getEngineAccuracy(opts) {
    if (
      !opts?.force &&
      engineAccuracyCache &&
      Date.now() - engineAccuracyCache.at < ENGINE_ACCURACY_TTL_MS
    ) {
      return engineAccuracyCache.summary;
    }
    if (engineAccuracyInflight) return engineAccuracyInflight;
    engineAccuracyInflight = (async () => {
      let stats = null;
      try {
        stats = await fetchBiasCalibrationApi();
        if (!stats || !stats.days) stats = await computeBiasCalibrationLocal();
      } catch (_) {
        stats = null;
      }
      const summary = summarizeEngineAccuracy(stats);
      engineAccuracyCache = { at: Date.now(), summary };
      engineAccuracyInflight = null;
      return summary;
    })();
    return engineAccuracyInflight;
  }

  function engineTrustView(summary) {
    if (!summary || !summary.ready) {
      const have = summary?.samples || 0;
      const need = summary?.minSessions || ENGINE_TRUST_MIN_SESSIONS;
      return {
        cls: "is-building",
        text: "Morning read: " + have + " of " + need + " days logged — keep showing up",
        expandLabel: "How RainMaker is learning",
      };
    }
    const rate = summary.hitRate;
    const cls = rate >= 60 ? "is-strong" : rate >= 50 ? "is-fair" : "is-weak";
    const sess = summary.samples;
    return {
      cls,
      text:
        "Morning read: " +
        rate +
        "% direction match · " +
        sess +
        " day" +
        (sess === 1 ? "" : "s"),
      expandLabel: "How RainMaker is learning",
    };
  }

  async function refreshEngineTrustLine(root) {
    const el = (root || document).querySelector("#fvEngineTrust");
    if (!el) return;
    let summary;
    try {
      summary = await getEngineAccuracy();
    } catch (_) {
      summary = null;
    }
    const view = engineTrustView(summary);
    el.classList.remove("is-building", "is-strong", "is-fair", "is-weak");
    el.classList.add(view.cls);
    const txt = el.querySelector(".fv-engine-trust-text");
    if (txt) txt.textContent = view.text;
    el.dataset.fvStat = view.text;
  }

  function bindBiasCalibration(root) {
    void refreshEngineTrustLine(root);
    const toggle = root?.querySelector("#fvBiasCalToggle");
    const wrap = root?.querySelector("#fvBiasCalWrap");
    if (!toggle || !wrap || toggle.dataset.bound) return;
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", async () => {
      if (wrap.classList.contains("hidden")) {
        await refreshBiasCalibrationPanel(wrap);
        /* recompute the headline after a manual refresh / import */
        void refreshEngineTrustLine(root);
      } else {
        wrap.classList.add("hidden");
      }
    });
    bindBiasCalibrationActions(root);
  }

  function biasMarketSentimentClass(market) {
    if (!market) return "fv-sentiment-neutral";
    if (market.pct >= 58) return "fv-sentiment-bull";
    if (market.pct <= 42) return "fv-sentiment-bear";
    return "fv-sentiment-neutral";
  }

  function biasToneClass(pct) {
    if (pct >= 58) return "fv-bias--bull";
    if (pct <= 42) return "fv-bias--bear";
    return "fv-bias--neutral";
  }

  function renderBiasMeter(pct) {
    const p = Math.max(0, Math.min(100, pct ?? 50));
    return (
      '<div class="fv-bias-meter" aria-hidden="true">' +
      '<div class="fv-bias-meter-mid"></div>' +
      '<div class="fv-bias-meter-fill ' +
      biasToneClass(pct) +
      '" style="width:' +
      p +
      '%"></div></div>'
    );
  }

  function renderBiasTrack(kicker, track, emptyNote, opts) {
    const options = opts || {};
    if (!track || (track.pct == null && !track.label)) {
      return (
        '<div class="fv-bias-row fv-bias-row--empty">' +
        '<span class="fv-bias-kicker">' +
        escapeHtml(kicker) +
        "</span>" +
        '<span class="fv-bias-note">' +
        escapeHtml(emptyNote || "Waiting for quotes…") +
        "</span></div>"
      );
    }
    const conf = track.confidence || "low";
    return (
      '<div class="fv-bias-row">' +
      '<span class="fv-bias-kicker">' +
      escapeHtml(kicker) +
      "</span>" +
      '<span class="fv-bias-label ' +
      biasToneClass(track.pct) +
      '">' +
      escapeHtml(track.label) +
      "</span>" +
      '<span class="fv-bias-pct">' +
      track.pct +
      "</span>" +
      '<span class="fv-bias-conf fv-bias-conf--' +
      conf +
      '">' +
      escapeHtml(conf) +
      " conf</span>" +
      (options.settingsSlot || "") +
      renderBiasMeter(track.pct) +
      "</div>"
    );
  }

  function renderBiasMiniLead(kicker, track, emptyNote) {
    if (!track || (track.pct == null && !track.label)) {
      return (
        '<div class="fv-bias-mini-row fv-bias-mini-row--empty">' +
        '<span class="fv-bias-mini-k">' +
        escapeHtml(kicker) +
        "</span>" +
        '<span class="fv-bias-mini-note">' +
        escapeHtml(emptyNote || "…") +
        "</span></div>"
      );
    }
    return (
      '<div class="fv-bias-mini-row">' +
      '<span class="fv-bias-mini-k">' +
      escapeHtml(kicker) +
      "</span>" +
      '<span class="fv-bias-mini-label ' +
      biasToneClass(track.pct) +
      '">' +
      escapeHtml(track.label) +
      "</span>" +
      '<span class="fv-bias-mini-pct">' +
      track.pct +
      "</span></div>"
    );
  }

  function renderBiasMiniTail(track) {
    if (!track || track.pct == null) return "";
    return '<div class="fv-bias-mini-meter-wrap">' + renderBiasMeter(track.pct) + "</div>";
  }

  function renderMorningBiasMini(bias, picks) {
    if (!bias) return { copy: "", tail: "" };
    const hasPicks = (picks || []).length > 0;
    return {
      copy:
        '<div class="fv-bias-mini fv-bias-mini--copy">' +
        renderBiasMiniLead("Market", bias.market, "…") +
        (hasPicks ? renderBiasMiniLead("H-001", bias.h001, "—") : "") +
        "</div>",
      tail:
        '<div class="fv-bias-mini fv-bias-mini--tail">' +
        renderBiasMiniTail(bias.market) +
        (hasPicks ? renderBiasMiniTail(bias.h001) : "") +
        "</div>",
    };
  }

  function syncMorningBiasMini(bias, picks) {
    const slot = document.getElementById("fvBiasMini");
    const tail = document.getElementById("fvBiasMiniTail");
    if (!slot) return;
    const cfg = loadSettings();
    if (cfg.showMorningBias === false || !bias) {
      slot.innerHTML = "";
      slot.hidden = true;
      slot.setAttribute("aria-hidden", "true");
      if (tail) {
        tail.innerHTML = "";
        tail.hidden = true;
        tail.setAttribute("aria-hidden", "true");
      }
      return;
    }
    const mini = renderMorningBiasMini(bias, picks);
    slot.innerHTML = mini.copy;
    slot.hidden = false;
    slot.removeAttribute("aria-hidden");
    if (tail) {
      tail.innerHTML = mini.tail;
      tail.hidden = !mini.tail;
      if (mini.tail) tail.removeAttribute("aria-hidden");
      else tail.setAttribute("aria-hidden", "true");
    }
    if (slot.dataset.bound !== "1") {
      slot.dataset.bound = "1";
      const onMiniActivate = (e) => {
        e.stopPropagation();
        if (typeof global.RMWorkspaceAccordion !== "undefined") {
          global.RMWorkspaceAccordion.expand("market");
        }
      };
      slot.addEventListener("click", onMiniActivate);
      tail?.addEventListener("click", onMiniActivate);
    }
  }

  function renderMorningBias(bias, picks) {
    if (!bias) return "";
    const hasPicks = (picks || []).length > 0;
    const marketDrivers = (bias.market?.drivers || []).join(" · ") || "Index quotes loading";
    const h001Drivers = (bias.h001?.drivers || []).join(" · ") || "Import scan for setup read";
    const desc =
      "Weighted tape read (futures, SPY/QQQ/IWM, VIX). H-001 setup uses your scan vs SPY, breadth, and gap fades. Not a prediction — setup quality for gap-and-go.";
    const conflictNote = bias.conflict
      ? " Market and scan disagree — treat confidence as low."
      : "";
    const logN = loadBiasLog().length;
    return (
      '<div class="fv-bias-wrap fv-tip-target" tabindex="0" data-fv-kicker="Morning bias" data-fv-title="Market vs H-001 setup" data-fv-desc="' +
      escapeAttr(desc + conflictNote) +
      '" data-fv-stat="' +
      escapeAttr(
        "Market " +
          (bias.market?.pct ?? "—") +
          " · H-001 " +
          (hasPicks ? bias.h001?.pct ?? "—" : "—")
      ) +
      '">' +
      renderBiasTrack("Market", bias.market, "Need index/futures quotes", {
        settingsSlot:
          '<span class="fv-market-settings-slot" id="fvMarketSettingsSlot"></span>',
      }) +
      (hasPicks
        ? renderBiasTrack("H-001 setup", bias.h001, "Load a scan")
        : "") +
      (hasPicks
        ? '<p class="fv-bias-drivers fv-bias-drivers--h001">' +
          escapeHtml(h001Drivers) +
          "</p>"
        : "") +
      '<p class="fv-bias-drivers">' +
      escapeHtml(marketDrivers) +
      (bias.conflict ? " · ⚠ market vs scan conflict" : "") +
      "</p>" +
      '<div class="fv-engine-trust is-building fv-tip-target" id="fvEngineTrust" tabindex="0"' +
      ' data-fv-kicker="Platform trust" data-fv-title="How RainMaker learns"' +
      ' data-fv-desc="Tracks whether your morning market read matched the next session\'s SPY direction. Expand for Atlas edge and validation payoff."' +
      ' data-fv-stat="Building">' +
      '<span class="fv-engine-trust-dot" aria-hidden="true"></span>' +
      '<span class="fv-engine-trust-text">Morning read: building…</span>' +
      "</div>" +
      '<button type="button" class="fv-bias-cal-toggle btn btn-ghost btn-sm" id="fvBiasCalToggle">Learning details</button>' +
      '<div class="fv-bias-cal-wrap hidden" id="fvBiasCalWrap"></div></div>'
    );
  }

  function renderPulseContext() {
    if (typeof RMMarketThemes === "undefined" || !RMMarketThemes.getLastContext) return "";
    const ctx = RMMarketThemes.getLastContext();
    if (!ctx) return "";
    const parts = [];
    if (ctx.scanNamesInNews > 0) {
      parts.push(ctx.scanNamesInNews + " scan names in headlines");
    }
    if (ctx.leadingTheme) parts.push(ctx.leadingTheme + " leading");
    if (ctx.themeAligned > 0) {
      parts.push(ctx.themeAligned + " pick" + (ctx.themeAligned === 1 ? "" : "s") + " theme-aligned");
    }
    if (!parts.length) return "";
    return (
      '<p class="fv-pulse-context fv-tip-target" tabindex="0" data-fv-kicker="Scan context" data-fv-title="Headlines vs scan" data-fv-desc="Cross-check from multi-source RSS (' +
      escapeAttr(ctx.sources || "CNBC · MarketWatch") +
      '). Scan names = tickers from your list mentioned in today\'s headlines." data-fv-stat="' +
      escapeAttr(parts.join(" · ")) +
      '">' +
      escapeHtml(parts.join(" · ")) +
      "</p>"
    );
  }

  function fmtPulseTime(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }

  function getRainmakerApiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) {
        return meta.content.trim().replace(/\/$/, "");
      }
      const stored = localStorage.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch {
      /* ignore */
    }
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return "http://127.0.0.1:8765";
    }
    return "";
  }

  async function fetchPulseSnapshot(pickSymbols, opts) {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const pickRows = opts?.picks || [];
    const syms = [
      ...new Set(
        [...(pickSymbols || []), ...pickRows.map((p) => p.symbol)]
          .map((s) => String(s).toUpperCase())
          .filter(Boolean)
      ),
    ];
    const url = base + "/pulse/snapshot";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      let res;
      if (pickRows.length) {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: ctrl.signal,
          body: JSON.stringify({
            symbols: syms,
            picks: pickRows.map((p) => ({
              symbol: p.symbol,
              gap_pct: p.gap_pct != null ? Number(p.gap_pct) : null,
              pct_change: p.pct_change != null ? Number(p.pct_change) : null,
            })),
            futures: opts?.futures !== false,
          }),
        });
      } else {
        const params = new URLSearchParams();
        if (syms.length) params.set("symbols", syms.join(","));
        if (opts?.futures === false) params.set("futures", "0");
        const qs = params.toString();
        res = await fetch(url + (qs ? "?" + qs : ""), {
          cache: "no-store",
          signal: ctrl.signal,
        });
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function applySnapshotIndices(snapshot) {
    if (!snapshot) return false;
    const merged = { ...(snapshot.indices || {}), ...(snapshot.futures || {}) };
    if (!Object.keys(merged).length) return false;
    cachedIndices = { ...merged };
    cachedIndicesAt = Date.now();
    return true;
  }

  function applySnapshotPicks(picks, snapshot) {
    const list = picks || [];
    const pickQuotes = snapshot?.picks || {};
    if (!list.length) {
      return {
        at: snapshot?.asOf || null,
        ok: 0,
        fail: 0,
        stale: false,
        source: snapshot?.source || "rm_api",
      };
    }
    let ok = 0;
    let fail = 0;
    for (const p of list) {
      const q = pickQuotes[p.symbol] || pickQuotes[String(p.symbol).toUpperCase()];
      if (q && q.chg != null && !Number.isNaN(Number(q.chg))) {
        p.live_price = q.price != null ? Number(q.price) : null;
        p.live_pct = Math.round(Number(q.chg) * 100) / 100;
        p.live_at = q.at || snapshot.asOf || Date.now();
        p.live_session = q.session || "unknown";
        ok++;
      } else {
        fail++;
      }
    }
    const at = snapshot.asOf || Date.now();
    const freshN = list.filter(
      (p) => p.live_at != null && at - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ).length;
    return {
      at,
      ok,
      fail,
      stale: freshN < list.length,
      source: snapshot.source || "rm_api",
    };
  }

  async function refreshQuotesViaApi(picks, opts) {
    const list = picks || [];
    const snapshot = await fetchPulseSnapshot(
      list.map((p) => p.symbol),
      { futures: opts?.futures !== false, picks: list }
    );
    if (!snapshot) {
      lastServerMorningBias = null;
      return null;
    }
    applySnapshotIndices(snapshot);
    if (snapshot.exchangeBreadth) {
      cachedExchangeBreadth = snapshot.exchangeBreadth;
      cachedExchangeBreadthAt = Date.now();
    }
    if (snapshot.morningBias) {
      lastServerMorningBias = snapshot.morningBias;
    }
    const meta = applySnapshotPicks(list, snapshot);
    lastPulseQuoteMeta = meta;
    return { snapshot, meta };
  }

  function relAge(ms) {
    if (ms == null || !Number.isFinite(ms)) return null;
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    return Math.round(m / 60) + "h ago";
  }

  function fetchHealth() {
    if (typeof RMYahooFetch !== "undefined" && RMYahooFetch.getHealth) {
      return RMYahooFetch.getHealth();
    }
    return null;
  }

  function renderPulseMeta(picks, meta) {
    const list = picks || [];
    const health = fetchHealth();
    const rateLimited = !!health?.rateLimited;
    const degraded = !!health?.degraded;

    // No picks loaded: stay quiet unless the data source is visibly struggling,
    // so a reliability problem is never silently hidden.
    if (!list.length) {
      if (rateLimited || degraded) {
        const note = rateLimited
          ? "Data source rate-limited · retrying"
          : "Data source unreachable · showing cached";
        return (
          '<p class="fv-pulse-meta ' +
          (rateLimited ? "fv-pulse-meta--ratelimited" : "fv-pulse-meta--stale") +
          '">' +
          escapeHtml(note) +
          "</p>"
        );
      }
      return "";
    }

    const m = meta || lastPulseQuoteMeta || {};
    const at = m.at || null;
    const freshN = list.filter(
      (p) =>
        p.live_at != null && Date.now() - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ).length;
    const stale = m.stale || freshN < list.length || degraded;
    const age = relAge(at ? Date.now() - at : null);
    let text = stale
      ? "Quotes stale · last " +
        fmtPulseTime(at) +
        " PST" +
        (age ? " (" + age + ")" : "") +
        " · " +
        freshN +
        "/" +
        list.length +
        " live"
      : "As of " +
        fmtPulseTime(at) +
        " PST" +
        (age ? " (" + age + ")" : "") +
        " · " +
        freshN +
        "/" +
        list.length +
        " picks live";
    if (rateLimited) text += " · rate-limited, retrying";
    else if (degraded) text += " · source degraded";
    if (m.source === "rm_api") text += " · API";
    const cls = rateLimited
      ? "fv-pulse-meta--ratelimited"
      : stale
        ? "fv-pulse-meta--stale"
        : "";
    return (
      '<p class="fv-pulse-meta' +
      (cls ? " " + cls : "") +
      '">' +
      escapeHtml(text) +
      "</p>"
    );
  }

  async function fetchPickQuoteCached(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const hit = pickQuoteCache[sym];
    if (hit && hit.at && Date.now() - hit.at < PICK_QUOTE_CACHE_MS) {
      return hit.quote;
    }
    const q = await fetchYahooQuote(sym);
    if (q) {
      pickQuoteCache[sym] = { quote: q, at: Date.now() };
    }
    return q;
  }

  async function refreshPickQuotes(picks) {
    const list = picks || [];
    if (!list.length) {
      lastPulseQuoteMeta = { at: null, ok: 0, fail: 0, stale: true };
      return lastPulseQuoteMeta;
    }
    const viaApi = await refreshQuotesViaApi(list, { futures: false });
    if (viaApi?.meta) {
      return viaApi.meta;
    }
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < list.length; i += PICK_QUOTE_BATCH) {
      const batch = list.slice(i, i + PICK_QUOTE_BATCH);
      await Promise.all(
        batch.map(async (p) => {
          const q = await fetchPickQuoteCached(p.symbol);
          if (q && q.chg != null && !Number.isNaN(Number(q.chg))) {
            p.live_price = q.price != null ? Number(q.price) : null;
            p.live_pct = Math.round(Number(q.chg) * 100) / 100;
            p.live_at = q.at || Date.now();
            p.live_session = q.session || "unknown";
            ok++;
          } else {
            fail++;
          }
        })
      );
    }
    const at = Date.now();
    const freshN = list.filter(
      (p) => p.live_at != null && at - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ).length;
    lastPulseQuoteMeta = {
      at,
      ok,
      fail,
      stale: freshN < list.length,
      source: "browser",
    };
    return lastPulseQuoteMeta;
  }

  function patchPickMap(container, picks, opts) {
    const pulse = findPulseContainers(container);
    const mapRoot = pulse.highlights || pulse.core;
    if (!mapRoot) return;
    const highlightSym = opts?.highlightSym ?? mapScanHighlightSym;
    const heatRe = /\bfv-(hot-up|hot-down|up|down|flat)\b/g;
    mapRoot.querySelectorAll(".fv-map-cell[data-symbol]").forEach((cell) => {
      const sym = cell.dataset.symbol;
      if (highlightSym != null) {
        cell.classList.toggle("fv-map-cell--scanning", sym === highlightSym);
      }
      if (!opts?.updateQuotes) return;
      const p = (picks || []).find((x) => x.symbol === sym);
      if (!p) return;
      const dayEl = cell.querySelector(".fv-map-day");
      if (dayEl) dayEl.textContent = fmtPct(effectiveDayPct(p));
      const gapEl = cell.querySelector(".fv-map-gap");
      if (gapEl && p.gap_pct != null) gapEl.textContent = fmtPct(p.gap_pct);
      const vsEl = cell.querySelector(".fv-map-vs");
      if (vsEl && opts?.indices) {
        const vs = pickVsSpy(p, getSpyDayPct(opts.indices));
        vsEl.textContent = vs != null ? fmtPct(vs) : "—";
        vsEl.className =
          "fv-map-vs" +
          (vs == null
            ? ""
            : vs > 0.05
              ? " fv-map-vs--up"
              : vs < -0.05
                ? " fv-map-vs--down"
                : "");
      }
      const nextHeat = pickHeatClass(p);
      let cls = cell.className.replace(heatRe, " ").replace(/\s+/g, " ").trim();
      if (!/\bfv-map-cell\b/.test(cls)) cls = "fv-map-cell fv-tip-target " + cls;
      cell.className = cls + " " + nextHeat + (isGapFade(p) ? " fv-map-cell--gap-fade" : "");
      cell.classList.toggle("fv-map-cell--gap-fade", isGapFade(p));
      if (highlightSym != null) {
        cell.classList.toggle("fv-map-cell--scanning", sym === highlightSym);
      }
    });
  }

  function scheduleRefreshMarketPanel(container, picks, opts) {
    mapScheduleArgs = { container, picks, opts: opts || {} };
    if (mapScheduleTimer) return;
    mapScheduleTimer = setTimeout(() => {
      mapScheduleTimer = null;
      const args = mapScheduleArgs;
      mapScheduleArgs = null;
      if (!args?.container) return;
      if (args.opts.mapPatchOnly) {
        patchPickMap(args.container, args.picks, args.opts);
        return;
      }
      refreshMarketPanel(args.container, args.picks, args.opts).catch(() => {});
    }, MAP_REFRESH_MS);
  }

  function setMapScanHighlight(sym) {
    mapScanHighlightSym = sym || null;
  }

  function startLivePickRefresh(container, getPicks, intervalMs) {
    stopLivePickRefresh();
    if (!container || typeof getPicks !== "function") return;
    pickLivePollContainer = container;
    pickLivePollGetPicks = getPicks;
    const ms = intervalMs || PICK_LIVE_REFRESH_MS;
    pickLivePoll = setInterval(() => {
      const picks = getPicks();
      if (!picks?.length) return;
      scheduleRefreshMarketPanel(container, picks, {
        soft: true,
        refreshQuotes: false,
        refreshPickQuotes: true,
      });
    }, ms);
  }

  function stopLivePickRefresh() {
    if (pickLivePoll) {
      clearInterval(pickLivePoll);
      pickLivePoll = null;
    }
    pickLivePollContainer = null;
    pickLivePollGetPicks = null;
  }

  function computeBreadth(picks) {
    const list = picks || [];
    let up = 0;
    let down = 0;
    let flat = 0;
    let sumPct = 0;
    let pctN = 0;
    let sumRm = 0;
    let rmN = 0;
    let highRm = 0;
    let top = null;

    for (const p of list) {
      const pct = effectiveDayPct(p);
      if (pct != null && !Number.isNaN(pct)) {
        sumPct += pct;
        pctN++;
        if (pct > 0.05) up++;
        else if (pct < -0.05) down++;
        else flat++;
        if (!top || pct > top.pct) {
          top = { symbol: p.symbol, pct, rm: p.rm_confidence, gap: p.gap_pct };
        }
      }
      const rm = p.rm_confidence != null ? Number(p.rm_confidence) : null;
      if (rm != null && !Number.isNaN(rm)) {
        sumRm += rm;
        rmN++;
        if (rm >= 50) highRm++;
      }
    }

    const total = list.length;
    return {
      total,
      up,
      down,
      flat,
      advPct: total ? Math.round((up / total) * 100) : 0,
      decPct: total ? Math.round((down / total) * 100) : 0,
      avgPct: pctN ? sumPct / pctN : null,
      avgRm: rmN ? sumRm / rmN : null,
      highRm,
      top,
    };
  }

  const FETCH_MS = 10000;
  const QUOTE_FETCH_MS = 8000;
  const PREFETCH_DEADLINE_MS = 10000;
  const QUOTE_CACHE_MS = 120000;
  const PREMARKET_INDEX_CACHE_MS = 30000;
  const RTH_INDEX_CACHE_MS = 120000;
  const PICK_QUOTE_CACHE_MS = 45000;
  const PICK_QUOTE_STALE_MS = 60000;
  const PICK_QUOTE_BATCH = 4;
  const PICK_LIVE_REFRESH_MS = 45000;
  let cachedIndices = null;
  let cachedIndicesAt = 0;
  let pickQuoteCache = {};
  let pickLivePoll = null;
  let pickLivePollContainer = null;
  let pickLivePollGetPicks = null;
  let lastPulseQuoteMeta = null;
  const EXCHANGE_BREADTH_CACHE_MS = 120000;
  let cachedExchangeBreadth = null;
  let cachedExchangeBreadthAt = 0;
  let lastMorningBias = null;
  let lastServerMorningBias = null;
  let refreshToken = 0;
  let refreshQueue = Promise.resolve();
  const MAP_REFRESH_MS = 80;
  let mapScheduleTimer = null;
  let mapScheduleArgs = null;
  let mapScanHighlightSym = null;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function hasIndexData(indices) {
    return !!(indices && Object.keys(indices).length);
  }

  function hasQuoteData(q) {
    return (
      q != null &&
      ((q.price != null && !Number.isNaN(Number(q.price))) ||
        (q.chg != null && !Number.isNaN(Number(q.chg))))
    );
  }

  function hasBreadthData(b) {
    return !!(b && b.total > 0);
  }

  function offlineMarketHtml(message) {
    return (
      '<div class="fv-market fv-offline">' +
      '<p class="meta">' +
      escapeHtml(message || "Index quotes unavailable — breadth still updates from your scan.") +
      "</p></div>"
    );
  }

  async function fetchYahooQuoteCached(symbol) {
    const cacheMs = getEffectiveIndexCacheMs(cachedIndices);
    const hit = cachedIndices?.[symbol];
    if (hit && cachedIndicesAt && Date.now() - cachedIndicesAt < cacheMs) {
      return hit;
    }
    const q = await fetchYahooQuote(symbol);
    if (q) {
      if (!cachedIndices) cachedIndices = {};
      cachedIndices[symbol] = q;
      cachedIndicesAt = Date.now();
    }
    return q;
  }

  async function prefetchIndices(opts) {
    const settings = loadSettings();
    const snapshot = await fetchPulseSnapshot([], {
      futures: settings.showFutures !== false,
    });
    if (snapshot) {
      applySnapshotIndices(snapshot);
      if (snapshot.exchangeBreadth) {
        cachedExchangeBreadth = snapshot.exchangeBreadth;
        cachedExchangeBreadthAt = Date.now();
      }
      if (snapshot.morningBias) {
        lastServerMorningBias = snapshot.morningBias;
      }
      const cached = getCachedIndices();
      if (cached && hasIndexData(cached)) {
        return cached;
      }
    }

    const fetchSyms = [
      ...new Set([
        ...INDEX_SYMBOLS,
        ...(settings.indices || []),
        ...(settings.showFutures !== false ? FUTURES_SYMBOLS : []),
      ]),
    ];
    const deadlineMs = opts?.timeoutMs ?? PREFETCH_DEADLINE_MS;
    const indices = { ...(getCachedIndices() || {}) };

    await Promise.race([
      Promise.all(
        fetchSyms.map(async (sym) => {
          indices[sym] = await fetchYahooQuoteCached(sym);
        })
      ),
      sleep(deadlineMs),
    ]);

    cachedIndices = { ...indices };
    cachedIndicesAt = Date.now();
    return cachedIndices;
  }

  function getCachedIndices() {
    const cacheMs = getEffectiveIndexCacheMs(cachedIndices);
    if (cachedIndices && cachedIndicesAt && Date.now() - cachedIndicesAt < cacheMs) {
      return cachedIndices;
    }
    return null;
  }

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

  async function fetchYahooQuote(symbol) {
    if (typeof RMYahooFetch !== "undefined") {
      return await RMYahooFetch.fetchQuote(symbol, { timeoutMs: QUOTE_FETCH_MS });
    }
    return null;
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const v = Number(n);
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }

  function fmtPrice(n) {
    if (n == null) return "—";
    return Number(n).toFixed(2);
  }

  function fmtVolRatio(p) {
    const v = p?.vol_ratio != null ? Number(p.vol_ratio) : null;
    if (v == null || Number.isNaN(v)) return "—";
    return v.toFixed(1) + "x";
  }

  function heatClass(chg) {
    if (chg == null) return "fv-flat";
    if (chg >= 1.5) return "fv-hot-up";
    if (chg > 0.05) return "fv-up";
    if (chg <= -1.5) return "fv-hot-down";
    if (chg < -0.05) return "fv-down";
    return "fv-flat";
  }

  /** VIX rises = risk-off (orange); VIX falls = calmer tape (teal). */
  function indexHeatClass(sym, chg) {
    const isVix = sym === "^VIX" || sym === "VIX";
    if (isVix && chg != null) return heatClass(-Number(chg));
    return heatClass(chg);
  }

  function pickHeatClass(p) {
    const pct = effectiveDayPct(p);
    if (pct == null) return "fv-flat";
    if (isGapFade(p)) return "fv-hot-down";
    if (pct >= 10) return "fv-hot-up";
    if (pct > 0) return "fv-up";
    if (pct <= -2) return "fv-hot-down";
    if (pct < 0) return "fv-down";
    return "fv-flat";
  }

  function renderIndexStrip(indices, settings) {
    const syms = (settings?.indices || INDEX_SYMBOLS).filter((s) =>
      INDEX_SYMBOLS.includes(s)
    );
    const cells = syms
      .map((sym) => {
        const q = indices[sym] || indices[sym.replace("^", "")];
        if (!hasQuoteData(q)) return "";
        const cls = indexHeatClass(sym, q?.chg);
        const meta = INDEX_META[sym] || { name: sym, desc: "Live index quote." };
        const sessionNote =
          q?.session === "pre"
            ? " Premarket price vs prior close."
            : q?.session === "post"
              ? " After-hours price vs prior close."
              : " Regular session vs prior close.";
        const stat =
          fmtPct(q?.chg) + (q?.price != null ? " · $" + fmtPrice(q.price) : "");
        return (
          '<div class="fv-cell fv-index fv-tip-target ' +
          cls +
          '" tabindex="0" data-fv-kicker="Index tape" data-fv-title="' +
          escapeAttr(sym + " · " + meta.name) +
          '" data-fv-desc="' +
          escapeAttr(meta.desc + sessionNote) +
          '" data-fv-stat="' +
          escapeAttr(stat) +
          '">' +
          '<span class="fv-sym">' +
          sym.replace("^", "") +
          sessionBadge(q?.session) +
          "</span>" +
          '<span class="fv-val">' +
          fmtPrice(q?.price) +
          "</span>" +
          '<span class="fv-chg">' +
          fmtPct(q?.chg) +
          "</span></div>"
        );
      })
      .filter(Boolean);
    if (!cells.length) return "";
    return (
      '<div class="fv-index-strip" data-cols="' +
      cells.length +
      '">' +
      cells.join("") +
      "</div>"
    );
  }

  function renderFuturesStrip(indices) {
    const cells = FUTURES_SYMBOLS.map((sym) => {
      const q = indices?.[sym];
      if (!hasQuoteData(q)) return "";
      const meta = FUTURES_META[sym] || { name: sym, desc: "Futures quote.", short: sym };
      const cls = heatClass(q?.chg);
      const stat =
        fmtPct(q?.chg) + (q?.price != null ? " · $" + fmtPrice(q.price) : "");
      return (
        '<div class="fv-cell fv-future fv-tip-target ' +
        cls +
        '" tabindex="0" data-fv-kicker="Futures" data-fv-title="' +
        escapeAttr(meta.short + " · " + meta.name) +
        '" data-fv-desc="' +
        escapeAttr(meta.desc) +
        '" data-fv-stat="' +
        escapeAttr(stat) +
        '">' +
        '<span class="fv-sym">' +
        meta.short +
        sessionBadge(q?.session) +
        "</span>" +
        '<span class="fv-val">' +
        fmtPrice(q?.price) +
        "</span>" +
        '<span class="fv-chg">' +
        fmtPct(q?.chg) +
        "</span></div>"
      );
    }).filter(Boolean);
    if (!cells.length) return "";
    return (
      '<div class="fv-futures-strip" data-cols="' +
      cells.length +
      '">' +
      cells.join("") +
      "</div>"
    );
  }

  function renderMacroHint(indices) {
    const spy = indices?.SPY;
    const qqq = indices?.QQQ;
    if (!hasQuoteData(spy) || !hasQuoteData(qqq)) return "";
    const spyChg = Number(spy.chg);
    const qqqChg = Number(qqq.chg);
    if (Number.isNaN(spyChg) || Number.isNaN(qqqChg)) return "";
    const spread = qqqChg - spyChg;
    const narrow = qqqChg > 0.3 && spread >= 0.35;
    if (!narrow && Math.abs(spread) < 0.15) return "";
    const cls = narrow ? "fv-macro-hint--warn" : "fv-macro-hint--neutral";
    const text = narrow
      ? "Narrow tape — QQQ " +
        fmtPct(qqqChg) +
        " vs SPY " +
        fmtPct(spyChg) +
        " (+" +
        spread.toFixed(2) +
        " spread)"
      : "Macro — SPY " + fmtPct(spyChg) + " · QQQ " + fmtPct(qqqChg);
    const desc = narrow
      ? "Mega-cap growth leading while the broad index lags — participation may be narrow."
      : "Quick read on benchmark vs growth tone.";
    return (
      '<p class="fv-macro-hint fv-tip-target ' +
      cls +
      '" tabindex="0" data-fv-kicker="Macro tape" data-fv-title="SPY vs QQQ" data-fv-desc="' +
      escapeAttr(desc) +
      '" data-fv-stat="' +
      escapeAttr(fmtPct(spread) + " spread") +
      '">' +
      escapeHtml(text) +
      "</p>"
    );
  }

  function renderSignalCell(key, cls, num, label) {
    const meta = SIGNAL_META[key] || { label, desc: "" };
    return (
      '<div class="fv-signal fv-tip-target ' +
      cls +
      '" tabindex="0" data-fv-kicker="Scan breadth" data-fv-title="' +
      escapeAttr(meta.label) +
      '" data-fv-desc="' +
      escapeAttr(meta.desc) +
      '" data-fv-stat="' +
      escapeAttr(String(num)) +
      '"><span class="fv-signal-num">' +
      num +
      '</span><span class="fv-signal-lbl">' +
      label +
      "</span></div>"
    );
  }

  function renderSignalRow(b) {
    if (!hasBreadthData(b)) return "";
    const cells = [
      renderSignalCell("adv", "fv-up", b.up, "Adv"),
      renderSignalCell("flat", "fv-flat", b.flat, "Unch"),
      renderSignalCell("dec", "fv-down", b.down, "Dec"),
      renderSignalCell("scan", "fv-accent", b.total, "Scan"),
    ];
    if (b.avgPct != null) {
      cells.push(
        renderSignalCell(
          "avg",
          b.avgPct > 0 ? "fv-up" : b.avgPct < 0 ? "fv-down" : "fv-flat",
          fmtPct(b.avgPct),
          "Avg"
        )
      );
    }
    if (b.avgRm != null) {
      cells.push(
        renderSignalCell(
          "rm",
          "fv-accent",
          Math.round(b.avgRm),
          "RM"
        )
      );
    }
    return (
      '<div class="fv-signal-row" data-cols="' +
      cells.length +
      '">' +
      cells.join("") +
      "</div>"
    );
  }

  function renderBreadthBar(b, indices) {
    if (!hasBreadthData(b)) return "";
    const unch = Math.max(0, 100 - b.advPct - b.decPct);
    const stat = b.advPct + "% adv · " + b.decPct + "% dec";
    const spyPct = getSpyDayPct(indices);
    let meta =
      b.advPct + "% adv · " + b.decPct + "% dec · " + b.highRm + " RM≥50";
    if (b.avgPct != null && spyPct != null) {
      const listVs = Math.round((b.avgPct - spyPct) * 100) / 100;
      meta += " · list " + fmtPct(listVs) + " vs SPY";
    }
    return (
      '<div class="fv-breadth-wrap fv-tip-target" tabindex="0" data-fv-kicker="Scan breadth" data-fv-title="Scan advancers vs decliners" data-fv-desc="Share of your scan picks up vs down today (not full-market breadth). Uses live quotes when fresh. Teal = advancing, gray = unchanged, orange = declining." data-fv-stat="' +
      escapeAttr(stat) +
      '">' +
      '<div class="fv-breadth-bar">' +
      '<div class="fv-breadth-seg fv-up" style="width:' +
      b.advPct +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-flat" style="width:' +
      unch +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-down" style="width:' +
      b.decPct +
      '%"></div></div>' +
      '<span class="fv-breadth-meta">' +
      meta +
      "</span></div>"
    );
  }

  function isMobileMapView() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function renderPickMap(picks, settings, indices) {
    const cfg = settings || loadSettings();
    const mobileMap = isMobileMapView();
    const spyPct = getSpyDayPct(indices);
    const sorted = sortPicksForMap(picks, cfg.mapSort || "gap", spyPct);
    if (!sorted.length) return "";
    const gridCols = mapGridColumns(cfg, { mobile: mobileMap });
    const headParts = ["<span>Ticker</span>", "<span>Gap</span>", "<span>Day</span>"];
    if (!mobileMap && cfg.showMapCatalyst !== false) headParts.push("<span>Cat</span>");
    if (cfg.showMapVsSpy !== false) headParts.push("<span>α</span>");
    if (!mobileMap && cfg.showMapVol !== false) headParts.push("<span>Vol</span>");
    headParts.push("<span>RM</span>");
    return (
      '<div class="fv-map-head" style="grid-template-columns:' +
      gridCols +
      '">' +
      headParts.join("") +
      "</div>" +
      '<div class="fv-map-grid">' +
      sorted
        .map((p) => {
          const cls = pickHeatClass(p);
          const gap = p.gap_pct != null ? fmtPct(p.gap_pct) : "—";
          const dayPct = effectiveDayPct(p);
          const day = fmtPct(dayPct);
          const scanDay =
            p.pct_change != null && dayPct != null && Number(p.pct_change) !== dayPct
              ? " (scan " + fmtPct(p.pct_change) + ")"
              : "";
          const rm =
            p.rm_confidence != null ? Math.round(p.rm_confidence) : "—";
          const vs = pickVsSpy(p, spyPct);
          const vsText = vs != null ? fmtPct(vs) : "—";
          const vsCls =
            vs == null
              ? ""
              : vs > 0.05
                ? " fv-map-vs--up"
                : vs < -0.05
                  ? " fv-map-vs--down"
                  : "";
          const cat = catalystMapLabel(p.catalyst);
          const volText = fmtVolRatio(p);
          const heatNote = HEAT_HINT[cls] || HEAT_HINT["fv-flat"];
          const fadeNote = isGapFade(p) ? " Gap fading — day turned red." : "";
          const vsNote =
            vs != null && spyPct != null
              ? " vs SPY " + fmtPct(vs) + " (SPY " + fmtPct(spyPct) + ")."
              : "";
          const stat =
            "Gap " +
            gap +
            " · Day " +
            day +
            scanDay +
            (cfg.showMapVsSpy !== false ? " · α " + vsText : "") +
            (cfg.showMapVol !== false ? " · Vol " + volText : "") +
            " · RM " +
            rm;
          const desc =
            heatNote +
            fadeNote +
            vsNote +
            (cfg.showMapVol !== false ? " Vol = today vs 30-day avg volume at scan." : "") +
            " Gap = open vs prior close. Day = live quote when fresh, else scan. α = pick day % minus SPY day %. RM = H-001 confidence.";
          const cellParts = [
            '<span class="fv-map-sym">' + p.symbol + "</span>",
            '<span class="fv-map-gap">' + gap + "</span>",
            '<span class="fv-map-day">' + day + "</span>",
          ];
          if (!mobileMap && cfg.showMapCatalyst !== false) {
            cellParts.push(
              '<span class="fv-map-cat ' +
                cat.cls +
                ' fv-tip-target" tabindex="0" data-fv-kicker="Catalyst" data-fv-title="' +
                escapeAttr(cat.title) +
                '" data-fv-desc="News verification from scan pipeline." data-fv-stat="' +
                escapeAttr(cat.text) +
                '">' +
                cat.text +
                "</span>"
            );
          }
          if (cfg.showMapVsSpy !== false) {
            cellParts.push(
              '<span class="fv-map-vs' + vsCls + '">' + vsText + "</span>"
            );
          }
          if (!mobileMap && cfg.showMapVol !== false) {
            cellParts.push('<span class="fv-map-vol">' + volText + "</span>");
          }
          cellParts.push('<span class="fv-map-rm">' + rm + "</span>");
          return (
            '<div class="fv-map-cell fv-tip-target ' +
            cls +
            (isGapFade(p) ? " fv-map-cell--gap-fade" : "") +
            '" tabindex="0" data-symbol="' +
            escapeAttr(p.symbol) +
            '" style="grid-template-columns:' +
            gridCols +
            '" data-fv-kicker="Scan pick heatmap" data-fv-title="' +
            escapeAttr(p.symbol) +
            '" data-fv-desc="' +
            escapeAttr(desc) +
            '" data-fv-stat="' +
            escapeAttr(stat) +
            '">' +
            cellParts.join("") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderTopMoverHtml(b) {
    if (!b?.top) return "";
    return (
      '<div class="fv-top-mover fv-up fv-tip-target" tabindex="0" data-fv-kicker="Top mover" data-fv-title="' +
      escapeAttr(b.top.symbol + " leads the scan") +
      '" data-fv-desc="Highest day % among current picks. Gap shows premarket/open strength vs prior close." data-fv-stat="' +
      escapeAttr(
        fmtPct(b.top.pct) +
          (b.top.gap != null ? " · gap " + fmtPct(b.top.gap) : "") +
          (b.top.rm != null ? " · RM " + Math.round(b.top.rm) : "")
      ) +
      '">Top <strong>' +
      b.top.symbol +
      "</strong> " +
      fmtPct(b.top.pct) +
      (b.top.gap != null ? " · gap " + fmtPct(b.top.gap) : "") +
      "</div>"
    );
  }

  function wrapFinvizParts(parts, sent, emptyHtml) {
    if (!parts.length) return emptyHtml || "";
    return (
      '<div class="fv-market ' +
      sent +
      '" data-sections="' +
      parts.length +
      '">' +
      parts.join("") +
      "</div>"
    );
  }

  function findPulseContainers(container) {
    const body = container?.closest(".workspace-market-body");
    return {
      core: body?.querySelector("#marketPanel") || container,
      highlights: body?.querySelector("#marketHighlights"),
    };
  }

  function buildFinvizParts(indices, picks, settings, pulseMeta, exchangeBreadth) {
    const b = computeBreadth(picks);
    const cfg = settings || loadSettings();
    const ex = exchangeBreadth || getExchangeBreadth();
    const bias = resolveMorningBias(indices, picks, b, ex);
    lastMorningBias = bias;
    logMorningBias(bias);
    const sent = biasMarketSentimentClass(bias.market);
    const coreParts = [];
    const highlightParts = [];
    if (cfg.showMorningBias !== false && bias) {
      const biasHtml = renderMorningBias(bias, picks);
      if (biasHtml) coreParts.push(biasHtml);
    }
    if ((picks || []).length) {
      const metaLine = renderPulseMeta(picks, pulseMeta);
      if (metaLine) coreParts.push(metaLine);
      const ctxLine = renderPulseContext();
      if (ctxLine) coreParts.push(ctxLine);
    }
    if (cfg.showIndices) {
      const strip = renderIndexStrip(indices, cfg);
      if (strip) coreParts.push(strip);
    }
    if (cfg.showFutures !== false) {
      const futures = renderFuturesStrip(indices);
      if (futures) coreParts.push(futures);
    }
    if (cfg.showMacroHint !== false) {
      const hint = renderMacroHint(indices);
      if (hint) coreParts.push(hint);
    }
    if (cfg.showExchangeBreadth !== false) {
      const exBar = renderExchangeBreadthBar(ex);
      if (exBar) coreParts.push(exBar);
    }
    if (cfg.showSignals) {
      const row = renderSignalRow(b);
      if (row) coreParts.push(row);
    }
    if (cfg.showBreadth) {
      const bar = renderBreadthBar(b, indices);
      if (bar) coreParts.push(bar);
    }
    if (cfg.showTopMover && b.top) {
      const top = renderTopMoverHtml(b);
      if (top) highlightParts.push(top);
    }
    if (cfg.showPickMap) {
      const map = renderPickMap(picks, cfg, indices);
      if (map) highlightParts.push(map);
    }
    return { coreParts, highlightParts, sent, b, cfg, bias };
  }

  function renderFinviz(indices, picks, settings, pulseMeta, exchangeBreadth) {
    const { coreParts, highlightParts, sent } = buildFinvizParts(
      indices,
      picks,
      settings,
      pulseMeta,
      exchangeBreadth
    );
    const emptyHtml =
      '<div class="fv-market fv-empty fv-sentiment-neutral">' +
      '<p class="meta">No market data yet — load a scan or wait for index quotes.</p></div>';
    const core = wrapFinvizParts(coreParts, sent, emptyHtml);
    const highlights = wrapFinvizParts(highlightParts, sent, "");
    if (!core && !highlights) return emptyHtml;
    if (highlights) {
      return (
        core.replace(/<\/div>\s*$/, "") +
        highlightParts.join("") +
        "</div>"
      );
    }
    return core;
  }

  function applyFinvizHtml(containers, indices, picks, settings, pulseMeta, exchangeBreadth) {
    const { coreParts, highlightParts, sent, bias } = buildFinvizParts(
      indices,
      picks,
      settings,
      pulseMeta,
      exchangeBreadth
    );
    syncMorningBiasMini(bias, picks);
    const emptyHtml =
      '<div class="fv-market fv-empty fv-sentiment-neutral">' +
      '<p class="meta">No market data yet — load a scan or wait for index quotes.</p></div>';
    const coreEl = containers.core;
    const hiEl = containers.highlights;
    if (coreEl) {
      coreEl.innerHTML = wrapFinvizParts(
        coreParts,
        sent,
        coreParts.length ? "" : emptyHtml
      );
    }
    if (hiEl) {
      hiEl.innerHTML = wrapFinvizParts(highlightParts, sent, "");
      hiEl.classList.toggle("hidden", !highlightParts.length);
      hiEl.toggleAttribute("aria-hidden", !highlightParts.length);
    }
    return { coreParts, highlightParts, sent };
  }

  function settingsCheck(id, checked, label) {
    return (
      '<label class="fv-settings-check">' +
      '<input type="checkbox"' +
      (id ? ' id="' + escapeAttr(id) + '"' : "") +
      (checked ? " checked" : "") +
      '><span class="fv-settings-check-label">' +
      escapeHtml(label) +
      "</span></label>"
    );
  }

  function settingsSection(title, inner) {
    return (
      '<div class="fv-settings-section">' +
      '<p class="fv-settings-section-title">' +
      escapeHtml(title) +
      "</p>" +
      inner +
      "</div>"
    );
  }

  function settingsMenuHtml() {
    const cfg = loadSettings();
    const idxOpts = INDEX_SYMBOLS.map(
      (sym) =>
        '<label class="fv-settings-chip">' +
        '<input type="checkbox" data-idx="' +
        escapeAttr(sym) +
        '"' +
        (cfg.indices.includes(sym) ? " checked" : "") +
        "><span>" +
        escapeHtml(sym.replace("^", "")) +
        "</span></label>"
    ).join("");
    const mapSort =
      '<div class="fv-settings-field">' +
      '<span class="fv-settings-field-label">Sort heatmap</span>' +
      '<select id="fvMapSort">' +
      '<option value="gap"' +
      (cfg.mapSort === "gap" || !cfg.mapSort ? " selected" : "") +
      ">Gap</option>" +
      '<option value="day"' +
      (cfg.mapSort === "day" ? " selected" : "") +
      ">Live day</option>" +
      '<option value="rm"' +
      (cfg.mapSort === "rm" ? " selected" : "") +
      ">RM score</option>" +
      '<option value="vsSpy"' +
      (cfg.mapSort === "vsSpy" ? " selected" : "") +
      ">vs SPY</option></select></div>";
    return (
      '<div class="fv-settings-popover hidden" id="fvSettingsPopover" role="dialog" aria-label="Morning Pulse settings">' +
      '<div class="fv-settings-head">' +
      '<p class="fv-settings-title">Pulse settings</p>' +
      '<p class="fv-settings-sub">Choose what shows in Morning Pulse</p>' +
      "</div>" +
      '<div class="fv-settings-body">' +
      settingsSection(
        "Bias & tape",
        settingsCheck("fvSetMorningBias", cfg.showMorningBias !== false, "Morning bias") +
          settingsCheck("fvSetIndices", cfg.showIndices, "Index strip") +
          settingsCheck("fvSetFutures", cfg.showFutures !== false, "ES/NQ futures") +
          settingsCheck("fvSetMacro", cfg.showMacroHint !== false, "SPY/QQQ hint")
      ) +
      settingsSection(
        "Breadth",
        settingsCheck("fvSetExchange", cfg.showExchangeBreadth !== false, "Market breadth") +
          settingsCheck("fvSetSignals", cfg.showSignals, "Breadth signals") +
          settingsCheck("fvSetBreadth", cfg.showBreadth, "Scan breadth bar")
      ) +
      settingsSection(
        "Highlights",
        settingsCheck("fvSetTop", cfg.showTopMover, "Top mover")
      ) +
      settingsSection(
        "Pick heatmap",
        settingsCheck("fvSetPickMap", cfg.showPickMap, "Pick heatmap") +
          settingsCheck("fvSetMapCat", cfg.showMapCatalyst !== false, "Catalyst column") +
          settingsCheck("fvSetMapVs", cfg.showMapVsSpy !== false, "vs SPY column") +
          settingsCheck("fvSetMapVol", cfg.showMapVol !== false, "Rel vol column") +
          mapSort
      ) +
      settingsSection(
        "Index symbols",
        '<div class="fv-settings-chip-grid">' +
          idxOpts +
          "</div>" +
          '<p class="fv-settings-hint">At least one symbol stays enabled.</p>'
      ) +
      "</div>" +
      '<div class="fv-settings-foot">' +
      '<button type="button" class="btn btn-ghost btn-sm fv-settings-done" id="fvSettingsClose">Done</button>' +
      "</div></div>"
    );
  }

  function isMobileMarketRow() {
    return (
      global.matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-snap-market")
    );
  }

  function settingsMenuHost(container) {
    const wrap = container?.closest(".ws-panel--market") || container?.parentElement;
    if (!wrap) return null;
    if (isMobileMarketRow()) {
      return (
        wrap.querySelector(".fv-bias-wrap") ||
        wrap.querySelector(".ws-panel-head") ||
        wrap
      );
    }
    return wrap.querySelector(".ws-panel-head") || wrap;
  }

  function findSettingsPopover(container) {
    const wrap = container?.closest(".ws-panel--market") || container?.parentElement;
    return wrap?.querySelector("#fvSettingsPopover") || container?.querySelector("#fvSettingsPopover");
  }

  function syncMobileMarketSettings() {
    const btn = document.getElementById("btnMarketSettings");
    const slot = document.getElementById("fvMarketSettingsSlot");
    const headLead = document.querySelector("#workspaceMarket .ws-panel-head-lead");
    if (!btn) return;
    const inline = isMobileMarketRow() && !!slot;
    if (inline) {
      if (btn.parentElement !== slot) slot.appendChild(btn);
      btn.classList.add("fv-market-settings-btn");
      btn.hidden = false;
    } else {
      if (headLead && btn.parentElement !== headLead) headLead.appendChild(btn);
      btn.classList.remove("fv-market-settings-btn");
    }
    const pop = findSettingsPopover(document.getElementById("marketPanel"));
    const host = settingsMenuHost(document.getElementById("marketPanel"));
    if (pop && host && pop.parentElement !== host) host.appendChild(pop);
  }

  function closeSettingsMenu(pop) {
    if (!pop) return;
    pop.classList.add("hidden");
    if (pop._fvDismissClick) {
      document.removeEventListener("click", pop._fvDismissClick, true);
      pop._fvDismissClick = null;
    }
    if (pop._fvDismissKey) {
      document.removeEventListener("keydown", pop._fvDismissKey);
      pop._fvDismissKey = null;
    }
  }

  function openSettingsMenu(pop) {
    if (!pop) return;
    pop.classList.remove("hidden");
    if (pop._fvDismissClick) return;
    pop._fvDismissClick = (ev) => {
      if (pop.contains(ev.target) || ev.target.closest("#btnMarketSettings")) return;
      closeSettingsMenu(pop);
    };
    pop._fvDismissKey = (ev) => {
      if (ev.key === "Escape") closeSettingsMenu(pop);
    };
    setTimeout(() => {
      if (!pop.classList.contains("hidden")) {
        document.addEventListener("click", pop._fvDismissClick, true);
        document.addEventListener("keydown", pop._fvDismissKey);
      }
    }, 0);
  }

  function bindSettingsMenu(container, picks) {
    const pop = findSettingsPopover(container);
    if (!pop || pop.dataset.bound === "1") return;
    pop.dataset.bound = "1";
    const apply = () => {
      const cfg = {
        showIndices: !!pop.querySelector("#fvSetIndices")?.checked,
        showMorningBias: !!pop.querySelector("#fvSetMorningBias")?.checked,
        showFutures: !!pop.querySelector("#fvSetFutures")?.checked,
        showMacroHint: !!pop.querySelector("#fvSetMacro")?.checked,
        showExchangeBreadth: !!pop.querySelector("#fvSetExchange")?.checked,
        showSignals: !!pop.querySelector("#fvSetSignals")?.checked,
        showBreadth: !!pop.querySelector("#fvSetBreadth")?.checked,
        showTopMover: !!pop.querySelector("#fvSetTop")?.checked,
        showPickMap: !!pop.querySelector("#fvSetPickMap")?.checked,
        showMapCatalyst: !!pop.querySelector("#fvSetMapCat")?.checked,
        showMapVsSpy: !!pop.querySelector("#fvSetMapVs")?.checked,
        showMapVol: !!pop.querySelector("#fvSetMapVol")?.checked,
        mapSort: pop.querySelector("#fvMapSort")?.value || "gap",
        indices: [...pop.querySelectorAll("[data-idx]")]
          .filter((el) => el.checked)
          .map((el) => el.dataset.idx),
      };
      if (!cfg.indices.length) cfg.indices = DEFAULT_SETTINGS.indices;
      saveSettings(cfg);
      refreshMarketPanel(container, picks, { soft: true, refreshQuotes: true });
    };
    pop.querySelectorAll("input, select").forEach((el) => {
      el.addEventListener("change", apply);
    });
    pop.querySelector("#fvSettingsClose")?.addEventListener("click", () => {
      closeSettingsMenu(pop);
    });
    pop.addEventListener("click", (ev) => ev.stopPropagation());
  }

  function toggleSettingsMenu(container) {
    let pop = findSettingsPopover(container);
    if (!pop) {
      const host = settingsMenuHost(container);
      if (host) {
        host.insertAdjacentHTML("beforeend", settingsMenuHtml());
        pop = host.querySelector("#fvSettingsPopover");
        bindSettingsMenu(container, container._rmPicks || []);
      }
    }
    if (!pop) return;
    if (pop.classList.contains("hidden")) openSettingsMenu(pop);
    else closeSettingsMenu(pop);
  }

  async function refreshMarketPanelProgressive(container, picks, loadSlot, opts) {
    if (!container || typeof loadSlot !== "function") {
      await refreshMarketPanel(container, picks, opts);
      return;
    }
    const pulse = findPulseContainers(container);
    const coreEl = pulse.core;
    const hiEl = pulse.highlights;
    const section = opts?.section || "all";
    const renderCore = section === "all" || section === "core";
    const renderHighlights = section === "all" || section === "highlights";
    if (renderCore) {
      coreEl.classList.remove("ws-load-slot", "ws-load-slot--loading", "ws-load-slot--ready");
      coreEl.innerHTML = "";
    }
    if (renderHighlights && hiEl) {
      hiEl.classList.remove("ws-load-slot", "ws-load-slot--loading", "ws-load-slot--ready", "hidden");
      hiEl.removeAttribute("aria-hidden");
      hiEl.innerHTML = "";
    }
    coreEl._rmPicks = picks;
    const cfg = loadSettings();
    let indices = opts?.indices || getCachedIndices() || {};
    const needsFetch =
      !opts?.skipPrefetch && cfg.showIndices && !hasIndexData(indices);
    if (
      !opts?.skipPrefetch &&
      (needsFetch || (picks?.length && opts?.refreshPickQuotes !== false))
    ) {
      const viaApi = await refreshQuotesViaApi(picks || [], {
        futures: cfg.showFutures !== false,
      });
      if (viaApi?.snapshot) {
        indices = { ...(cachedIndices || {}), ...indices };
      } else if (picks?.length && opts?.refreshPickQuotes !== false) {
        await refreshPickQuotes(picks);
      }
    }
    let ex = getExchangeBreadth();
    const deferBreadth =
      opts?.mobilePerf ||
      (typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf());
    if (
      !deferBreadth &&
      !opts?.skipPrefetch &&
      (cfg.showExchangeBreadth !== false || cfg.showMorningBias !== false)
    ) {
      if (ex) {
        void refreshExchangeBreadth();
      } else {
        ex =
          (await Promise.race([refreshExchangeBreadth(), sleep(2000).then(() => ex)])) || ex;
      }
    }
    const b = computeBreadth(picks);
    const bias = resolveMorningBias(indices, picks, b, ex);
    lastMorningBias = bias;
    logMorningBias(bias);
    const sent = biasMarketSentimentClass(bias.market);
    const coreWrap = renderCore ? document.createElement("div") : null;
    if (coreWrap) {
      coreWrap.className = "fv-market " + sent;
      coreEl.appendChild(coreWrap);
    }
    const hiWrap = renderHighlights && hiEl ? document.createElement("div") : null;
    if (hiWrap) {
      hiWrap.className = "fv-market " + sent;
      hiEl.appendChild(hiWrap);
    }

    async function block(wrap, label, htmlFn, instant) {
      if (!wrap) return;
      let html = "";
      try {
        html = await htmlFn(indices);
      } catch {
        html = "";
      }
      if (!html || !String(html).trim()) return;

      const el = document.createElement("div");
      el.className = "fv-market-block";
      wrap.appendChild(el);
      if (instant) {
        el.innerHTML = html;
        el.classList.add("ws-load-slot", "ws-load-slot--ready");
        return;
      }
      await loadSlot(el, label, async (slot) => {
        slot.innerHTML = html;
      });
    }

    if (renderCore && picks?.length) {
      await block(
        coreWrap,
        "Quote freshness",
        async () => renderPulseMeta(picks, lastPulseQuoteMeta) + renderPulseContext(),
        true
      );
    }

    if (renderCore && cfg.showMorningBias !== false) {
      await block(coreWrap, "Morning bias", async () => renderMorningBias(bias, picks), true);
    }

    if (renderCore && cfg.showIndices) {
      await block(
        coreWrap,
        "Index quotes",
        async () => {
          if (needsFetch) {
            indices = (await prefetchIndices({ timeoutMs: QUOTE_FETCH_MS })) || indices;
          }
          return renderIndexStrip(indices, cfg);
        },
        !needsFetch
      );
    }

    if (renderCore && cfg.showFutures !== false) {
      await block(
        coreWrap,
        "Futures",
        async () => {
          if (needsFetch) {
            indices = (await prefetchIndices({ timeoutMs: QUOTE_FETCH_MS })) || indices;
          }
          return renderFuturesStrip(indices);
        },
        !needsFetch
      );
    }

    if (renderCore && cfg.showMacroHint !== false) {
      await block(coreWrap, "Macro tape", async () => renderMacroHint(indices), true);
    }

    if (renderCore && cfg.showExchangeBreadth !== false) {
      await block(
        coreWrap,
        "Market breadth",
        async () => renderExchangeBreadthBar(ex || getExchangeBreadth()),
        !!ex
      );
    }

    if (renderCore && (cfg.showSignals || cfg.showBreadth)) {
      await block(
        coreWrap,
        "Scan breadth",
        async () => {
          let html = "";
          if (cfg.showSignals) html += renderSignalRow(b);
          if (cfg.showBreadth) html += renderBreadthBar(b, indices);
          return html;
        },
        true
      );
    }

    if (renderHighlights && cfg.showTopMover && b.top) {
      await block(hiWrap, "Top mover", async () => renderTopMoverHtml(b), true);
    }

    if (renderHighlights && cfg.showPickMap) {
      await block(hiWrap, "Pick heatmap", async () => renderPickMap(picks, cfg, indices), true);
    }

    if (renderCore && coreWrap) {
      const coreBlocks = coreWrap.querySelectorAll(".fv-market-block").length;
      if (coreBlocks) coreWrap.dataset.sections = String(coreBlocks);
      else {
        coreWrap.classList.add("fv-empty");
        coreWrap.innerHTML =
          '<p class="meta">No market data yet — load a scan or wait for index quotes.</p>';
      }
    }

    if (renderHighlights && hiWrap) {
      const hiBlocks = hiWrap.querySelectorAll(".fv-market-block").length;
      if (hiBlocks) hiWrap.dataset.sections = String(hiBlocks);
      else {
        hiEl.classList.add("hidden");
        hiEl.setAttribute("aria-hidden", "true");
        hiEl.innerHTML = "";
      }
    }

    if (renderCore) {
      bindMarketMapTips(coreEl);
      bindBiasCalibration(coreEl);
      bindSettingsMenu(coreEl, picks);
    }
    if (renderHighlights && hiEl) bindMarketMapTips(hiEl);
  }

  async function refreshMarketPanel(container, picks, opts) {
    if (!container) return;
    const pulse = findPulseContainers(container);
    const coreEl = pulse.core;
    const seq = ++refreshToken;
    const soft = opts?.soft === true;
    const task = async () => {
      try {
        if (!soft) {
          global.RMWorkspaceAccordion?.setRowNavLoading?.("market", true);
          coreEl.innerHTML =
            '<div class="fv-market fv-loading">Loading market map…</div>';
          if (pulse.highlights) pulse.highlights.innerHTML = "";
        }
        const settings = loadSettings();
        let indices = opts?.indices || getCachedIndices() || {};
        const fetchSyms = [
          ...new Set([
            ...INDEX_SYMBOLS,
            ...(settings.indices || []),
            ...(settings.showFutures !== false ? FUTURES_SYMBOLS : []),
          ]),
        ];
        if (opts?.refreshQuotes || !hasIndexData(indices)) {
          const viaApi = await refreshQuotesViaApi(picks, {
            futures: settings.showFutures !== false,
          });
          if (viaApi?.snapshot) {
            indices = { ...(cachedIndices || {}), ...indices };
          } else {
            const next = { ...indices };
            await Promise.race([
              Promise.all(
                fetchSyms.map(async (sym) => {
                  next[sym] = await fetchYahooQuoteCached(sym);
                })
              ),
              sleep(PREFETCH_DEADLINE_MS),
            ]);
            indices = next;
            cachedIndices = { ...indices };
            cachedIndicesAt = Date.now();
          }
        }
        if (seq !== refreshToken) return;
        let pulseMeta = lastPulseQuoteMeta;
        if (
          picks?.length &&
          opts?.refreshPickQuotes !== false &&
          pulseMeta?.source !== "rm_api"
        ) {
          pulseMeta = await refreshPickQuotes(picks);
        }
        if (seq !== refreshToken) return;
        if (settings.showExchangeBreadth !== false || settings.showMorningBias !== false) {
          await refreshExchangeBreadth();
        }
        if (seq !== refreshToken) return;
        coreEl._rmPicks = picks;
        coreEl._cachedIndices = indices;
        coreEl.classList.remove(
          "ws-load-slot",
          "ws-load-slot--loading",
          "ws-load-slot--ready"
        );
        applyFinvizHtml(pulse, indices, picks, settings, pulseMeta, getExchangeBreadth());
        bindMarketMapTips(coreEl);
        if (pulse.highlights) bindMarketMapTips(pulse.highlights);
        bindBiasCalibration(coreEl);
        bindSettingsMenu(coreEl, picks);
        syncMobileMarketSettings();
        global.RMWorkspaceAccordion?.setRowNavLoading?.("market", false);
      } catch (e) {
        if (seq !== refreshToken) return;
        coreEl.classList.remove(
          "ws-load-slot",
          "ws-load-slot--loading",
          "ws-load-slot--ready"
        );
        global.RMWorkspaceAccordion?.setRowNavLoading?.("market", false);
        coreEl.innerHTML = offlineMarketHtml(
          "Market map offline — retry in a moment or refresh the page."
        );
        if (pulse.highlights) {
          pulse.highlights.innerHTML = "";
          pulse.highlights.classList.add("hidden");
          pulse.highlights.setAttribute("aria-hidden", "true");
        }
        bindMarketMapTips(coreEl);
        bindSettingsMenu(coreEl, picks);
      }
    };
    refreshQueue = refreshQueue.then(task, task);
    return refreshQueue;
  }

  global.RMMarket = {
    getCachedIndices,
    computeBreadth,
    computeMorningBias,
    getLastMorningBias: () => lastMorningBias,
    syncMorningBiasMini,
    syncMobileMarketSettings,
    loadBiasLog,
    exportBiasLogJson,
    importBiasLogPayload,
    pullBiasLogFromApi,
    syncBiasLogApi,
    computeBiasCalibrationLocal,
    getEngineAccuracy,
    refreshEngineTrustLine,
    biasSnapshot,
    currentBiasSnapshot,
    biasOutcomeJoin,
    renderPulseMeta,
    effectiveDayPct,
    getSpyDayPct,
    pickVsSpy,
    getRainmakerApiBase,
    refreshPickQuotes,
    refreshExchangeBreadth,
    getExchangeBreadth,
    refreshMarketPanel,
    scheduleRefreshMarketPanel,
    patchPickMap,
    setMapScanHighlight,
    refreshMarketPanelProgressive,
    prefetchIndices,
    bindMarketMapTips,
    toggleSettingsMenu,
    loadSettings,
    startLivePickRefresh,
    stopLivePickRefresh,
    get _liveRefreshTimer() {
      return pickLivePoll;
    },
    fmtPct,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- scan_config.js --- */
/** H-001 scanner criteria — editable locally, maps to MorningMomentumScanner.ts */
(function (global) {
  const STORAGE_KEY = "rainmaker_scan_config_v1";

  const DEFAULTS = {
    hypothesis_id: "H-001",
    name: "Morning Momentum",
    applyFloatPoints: true,
    volMultiple: 5,
    dailyPctMin: 10,
    movePctMin: 8,
    priceMin: 1,
    priceMax: 20,
    gapPctMin: 3,
    minScore: 50,
    weights: {
      float: 29,
      news: 24,
      vol: 19,
      move: 14,
      daily: 10,
      price: 4,
    },
    customFilters: [],
  };

  const CORE_WEIGHT_KEYS = ["float", "news", "vol", "move", "daily", "price"];
  /** Target Trades hero — five adjustable score weights (+ price band in full config). */
  const HERO_WEIGHT_KEYS = ["float", "news", "vol", "move", "daily"];

  function weightSum(weights, keys) {
    const list = keys || CORE_WEIGHT_KEYS;
    return list.reduce((s, k) => s + (Number(weights?.[k]) || 0), 0);
  }

  function heroWeightSum(weights) {
    return weightSum(weights, HERO_WEIGHT_KEYS);
  }

  function heroWeightBudget(weights) {
    const w = weights || DEFAULTS.weights;
    const price = Number(w.price);
    const pricePts = Number.isFinite(price) && price >= 0 ? price : DEFAULTS.weights.price;
    return Math.max(0, 100 - pricePts);
  }

  function defaultHeroWeights() {
    const out = {};
    HERO_WEIGHT_KEYS.forEach((k) => {
      out[k] = DEFAULTS.weights[k];
    });
    return out;
  }

  function mergeWeights(raw) {
    return { ...DEFAULTS.weights, ...(raw || {}) };
  }

  function rebalanceToTarget(weights, keys, target) {
    const out = mergeWeights(weights);
    const list = keys || HERO_WEIGHT_KEYS;
    const sum = weightSum(out, list);
    if (sum <= 0) {
      list.forEach((k) => {
        out[k] = DEFAULTS.weights[k] ?? 0;
      });
      return rebalanceToTarget(out, list, target);
    }
    if (sum === target) return out;
    let allocated = 0;
    list.forEach((k, i) => {
      if (i === list.length - 1) {
        out[k] = Math.max(0, target - allocated);
      } else {
        const v = Math.round(((Number(out[k]) || 0) / sum) * target);
        out[k] = v;
        allocated += v;
      }
    });
    return out;
  }

  /** Ensure five hero weights are valid; preserve price band weight (default +4). */
  function normalizeHeroWeights(weights) {
    const out = mergeWeights(weights);
    if (heroWeightSum(out) <= 0) {
      HERO_WEIGHT_KEYS.forEach((k) => {
        out[k] = DEFAULTS.weights[k];
      });
    }
    if (out.price == null || Number(out.price) < 0) {
      out.price = DEFAULTS.weights.price;
    }
    return out;
  }

  /** Split total equally across keys (remainder goes to last key). */
  function redistributeEqual(out, keys, total) {
    const list = keys || [];
    const n = list.length;
    if (n <= 0) return out;
    const goal = Math.max(0, Math.round(Number(total) || 0));
    const each = Math.floor(goal / n);
    let allocated = 0;
    list.forEach((k, i) => {
      if (i === n - 1) {
        out[k] = Math.max(0, goal - allocated);
      } else {
        out[k] = each;
        allocated += each;
      }
    });
    return out;
  }

  /** Redistribute listed keys so they sum to target (default 100). */
  function adjustWeight(weights, changedKey, nextVal, keys, target) {
    const list = keys || CORE_WEIGHT_KEYS;
    const goal = target != null ? target : 100;
    const out = mergeWeights(weights);
    nextVal = Math.max(0, Math.min(goal, Math.round(Number(nextVal) || 0)));
    out[changedKey] = nextVal;
    const others = list.filter((k) => k !== changedKey);
    return redistributeEqual(out, others, Math.max(0, goal - nextVal));
  }

  /** Hero sliders: moving one step redistributes the remainder equally across the other four. */
  function adjustHeroWeight(weights, changedKey, nextVal) {
    if (!HERO_WEIGHT_KEYS.includes(changedKey)) return normalizeHeroWeights(weights);
    const out = normalizeHeroWeights(weights);
    const budget = heroWeightBudget(out);
    nextVal = Math.max(0, Math.min(budget, Math.round(Number(nextVal) || 0)));
    out[changedKey] = nextVal;
    const others = HERO_WEIGHT_KEYS.filter((k) => k !== changedKey);
    redistributeEqual(out, others, Math.max(0, budget - nextVal));
    return out;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const cfg = { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
      cfg.weights = normalizeHeroWeights(cfg.weights);
      if (heroWeightSum(cfg.weights) < 1) {
        cfg.weights = mergeWeights(DEFAULTS.weights);
        save(cfg);
      }
      return cfg;
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  function save(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function maxScore(cfg) {
    const w = cfg.weights || {};
    let sum = 0;
    if (cfg.applyFloatPoints) sum += w.float || 0;
    sum += w.news || 0;
    sum += w.vol || 0;
    sum += w.move || 0;
    sum += w.daily || 0;
    sum += w.price || 0;
    (cfg.customFilters || []).forEach((f) => {
      sum += Number(f.points) || 0;
    });
    return sum;
  }

  function thinkScriptPreview(cfg) {
    const w = cfg.weights;
    const lines = [
      "# Rainmaker " + cfg.hypothesis_id + " — " + cfg.name,
      "input applyFloatPoints = " + (cfg.applyFloatPoints ? "yes" : "no") + ";",
      "input volMultiple = " + cfg.volMultiple + ";",
      "input dailyPctMin = " + cfg.dailyPctMin + ";",
      "input movePctMin = " + cfg.movePctMin + ";",
      "input priceMin = " + cfg.priceMin + ";",
      "input priceMax = " + cfg.priceMax + ";",
      "input gapPctMin = " + cfg.gapPctMin + ";",
      "",
      "def wFloat = " + w.float + ";",
      "def wNews = " + w.news + ";",
      "def wVol = " + w.vol + ";",
      "def wMove = " + w.move + ";",
      "def wDaily = " + w.daily + ";",
      "def wPrice = " + w.price + ";",
      "",
      "# Copy criteria into Stock Hacker / ThinkScript editor",
    ];
    (cfg.customFilters || []).forEach((f, i) => {
      lines.push(
        "# Custom " + (i + 1) + ": " + f.name + " (+" + f.points + ") — " + f.rule
      );
    });
    return lines.join("\n");
  }

  function criteriaRows() {
    return [
      {
        key: "float",
        label: "Float filter (Stock Hacker)",
        hint: "Applied when float filter passes in Stock Hacker",
        weightKey: "float",
        threshold: null,
      },
      {
        key: "news",
        label: "News proxy",
        hint: "Gap-up ≥ gapPctMin OR (volume spike AND daily ≥ 5%)",
        weightKey: "news",
        thresholdKey: "gapPctMin",
        thresholdLabel: "Min gap %",
      },
      {
        key: "vol",
        label: "Volume surge",
        hint: "Today vol ≥ volMultiple × 30-day avg",
        weightKey: "vol",
        thresholdKey: "volMultiple",
        thresholdLabel: "Vol multiple",
      },
      {
        key: "move",
        label: "Intraday move",
        hint: "Daily % change threshold",
        weightKey: "move",
        thresholdKey: "movePctMin",
        thresholdLabel: "Min move %",
      },
      {
        key: "daily",
        label: "Daily momentum",
        hint: "Strong daily % change",
        weightKey: "daily",
        thresholdKey: "dailyPctMin",
        thresholdLabel: "Min daily %",
      },
      {
        key: "price",
        label: "Price band",
        hint: "Share price within min/max",
        weightKey: "price",
        thresholdKeys: ["priceMin", "priceMax"],
        thresholdLabel: "Min / max $",
      },
    ];
  }

  global.RMScanConfig = {
    DEFAULTS,
    CORE_WEIGHT_KEYS,
    HERO_WEIGHT_KEYS,
    load,
    save,
    maxScore,
    weightSum,
    heroWeightSum,
    heroWeightBudget,
    defaultHeroWeights,
    adjustWeight,
    adjustHeroWeight,
    normalizeHeroWeights,
    thinkScriptPreview,
    criteriaRows,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- agent_plan_config.js --- */
/** Owner-editable overnight Atlas agent plan - scan settings drawer (Agent tab). */
(function (global) {
  "use strict";

  const STORAGE_KEY = "rainmaker_agent_plan_draft_v1";
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  function defaults() {
    return {
      version: "2026-06-13",
      api_base_url: "https://rainmaker-api-waqs.onrender.com",
      agent_enabled: true,
      schedule_window_minutes: 45,
      jobs: [
        { id: "premarket", label: "Premarket brief", hour: 4, minute: 0, enabled: true },
        { id: "atlas_premarket", label: "Atlas premarket scan", hour: 6, minute: 0, enabled: true },
        { id: "atlas_qualify", label: "Atlas qualify - war plan", hour: 7, minute: 45, enabled: true },
        { id: "open", label: "Open brief", hour: 8, minute: 0, enabled: true },
        { id: "atlas_agent", label: "Atlas agent (propose)", hour: 8, minute: 5, enabled: true },
        { id: "close", label: "Close ingest", hour: 16, minute: 5, enabled: true },
        { id: "agent_reflect", label: "Agent reflect (EOD)", hour: 16, minute: 10, enabled: true },
      ],
      agent: {
        strategy_id: "atlas",
        agent_id: "atlas_operator_v0",
        max_trades_per_day: 1,
        shadow_equity: 30000,
      },
      risk: {
        max_risk_per_trade_usd: 150,
        max_daily_loss_usd: 300,
        max_concurrent_positions: 3,
      },
      qualify: {
        min_confidence: 0.55,
        min_backtest_avg_r: 0.3,
        backtest_runs: 3,
      },
      changelog: [],
    };
  }

  function mergePlan(raw) {
    const base = defaults();
    if (!raw || typeof raw !== "object") return base;
    return {
      ...base,
      ...raw,
      agent: { ...base.agent, ...(raw.agent || {}) },
      risk: { ...base.risk, ...(raw.risk || {}) },
      qualify: { ...base.qualify, ...(raw.qualify || {}) },
      jobs: Array.isArray(raw.jobs) && raw.jobs.length ? raw.jobs : base.jobs,
      changelog: Array.isArray(raw.changelog) ? raw.changelog : [],
    };
  }

  function apiBase() {
    if (global.RMMorningApi && global.RMMorningApi.resolveApiBase) {
      return global.RMMorningApi.resolveApiBase();
    }
    return "https://rainmaker-api-waqs.onrender.com";
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    try {
      if (global.RMAuthGate && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (_) {}
    return headers;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(h, m) {
    const hr = Number(h) || 0;
    const min = Number(m) || 0;
    const ap = hr >= 12 ? "PM" : "AM";
    const h12 = hr % 12 || 12;
    return h12 + ":" + String(min).padStart(2, "0") + " " + ap + " ET";
  }

  function loadLocalDraft() {
    try {
      const raw = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "null");
      return raw ? mergePlan(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveLocalDraft(plan) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
    } catch (_) {}
  }

  async function fetchPlan() {
    const base = apiBase();
    try {
      const res = await fetch(base + "/trading/agent-plan", { headers: authHeaders() });
      if (res.ok) {
        const body = await res.json();
        if (body?.plan) {
          const plan = mergePlan(body.plan);
          saveLocalDraft(plan);
          return { ok: true, plan, source: "api" };
        }
      }
    } catch (_) {}
    const local = loadLocalDraft();
    if (local) return { ok: true, plan: local, source: "local" };
    return { ok: true, plan: defaults(), source: "defaults" };
  }

  async function savePlan(plan, note) {
    const base = apiBase();
    const res = await fetch(base + "/trading/agent-plan", {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ plan, note: note || "", actor: "owner" }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { raw: text };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data };
    }
    const saved = mergePlan(data?.plan || plan);
    saveLocalDraft(saved);
    return { ok: true, plan: saved, data };
  }

  function hourOptions(selected) {
    return HOURS.map(
      (h) =>
        '<option value="' +
        h +
        '"' +
        (Number(selected) === h ? " selected" : "") +
        ">" +
        String(h).padStart(2, "0") +
        "</option>"
    ).join("");
  }

  function minuteOptions(selected) {
    return MINUTES.map(
      (m) =>
        '<option value="' +
        m +
        '"' +
        (Number(selected) === m ? " selected" : "") +
        ">" +
        String(m).padStart(2, "0") +
        "</option>"
    ).join("");
  }

  function sliderRow(opts) {
    const display = opts.format(opts.value);
    return (
      '<div class="agent-plan-slider">' +
      '<div class="agent-plan-slider-head">' +
      '<span class="agent-plan-slider-label">' +
      escapeHtml(opts.label) +
      "</span>" +
      '<span id="' +
      opts.valId +
      '" class="agent-plan-slider-val">' +
      escapeHtml(display) +
      "</span></div>" +
      '<input type="range" id="' +
      opts.id +
      '" min="' +
      opts.min +
      '" max="' +
      opts.max +
      '" step="' +
      opts.step +
      '" value="' +
      opts.value +
      '" aria-label="' +
      escapeHtml(opts.label) +
      '" /></div>'
    );
  }

  function block(title, meta, body) {
    return (
      '<section class="agent-plan-block">' +
      '<h4 class="agent-plan-block-title">' +
      escapeHtml(title) +
      (meta ? '<span class="agent-plan-block-meta">' + escapeHtml(meta) + "</span>" : "") +
      "</h4>" +
      '<div class="agent-plan-block-body">' +
      body +
      "</div></section>"
    );
  }

  function renderJobsTable(jobs) {
    return (
      '<div class="agent-plan-jobs">' +
      (jobs || [])
        .map(function (j, idx) {
          const on = j.enabled !== false;
          const label = j.label || j.id;
          return (
            '<article class="agent-plan-job' +
            (on ? "" : " agent-plan-job--off") +
            '" data-job-idx="' +
            idx +
            '">' +
            '<label class="agent-plan-job-check">' +
            '<input type="checkbox" data-field="enabled" data-job-idx="' +
            idx +
            '"' +
            (on ? " checked" : "") +
            " />" +
            '<span class="agent-plan-job-name">' +
            escapeHtml(label) +
            "</span></label>" +
            '<div class="agent-plan-job-schedule">' +
            '<span class="agent-plan-job-schedule-label">Run at</span>' +
            '<div class="agent-plan-job-when">' +
            '<select data-field="hour" data-job-idx="' +
            idx +
            '" aria-label="' +
            escapeHtml(label + " hour") +
            '">' +
            hourOptions(j.hour) +
            "</select>" +
            '<span class="agent-plan-time-sep">:</span>' +
            '<select data-field="minute" data-job-idx="' +
            idx +
            '" aria-label="' +
            escapeHtml(label + " minute") +
            '">' +
            minuteOptions(j.minute) +
            "</select>" +
            '<span class="agent-plan-job-et">' +
            fmtTime(j.hour, j.minute) +
            "</span></div></div></article>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderChangelog(entries) {
    const list = (entries || []).slice(0, 5);
    if (!list.length) {
      return '<p class="agent-plan-empty">No changes logged yet.</p>';
    }
    return (
      '<ul class="agent-plan-changelog">' +
      list
        .map(function (e) {
          const note = e.note ? " - " + escapeHtml(e.note) : "";
          const changes = (e.changes || []).slice(0, 2).map(escapeHtml).join("; ");
          return (
            "<li><time>" +
            escapeHtml((e.at || "").slice(0, 16).replace("T", " ")) +
            "</time>" +
            note +
            (changes ? '<span class="agent-plan-change-delta">' + changes + "</span>" : "") +
            "</li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function renderPanelHtml(plan) {
    const p = mergePlan(plan);
    const ag = p.agent || {};
    const risk = p.risk || {};
    const qual = p.qualify || {};
    const enabled = p.agent_enabled !== false;

    const scheduleBody =
      renderJobsTable(p.jobs) +
      sliderRow({
        id: "agentPlanWindow",
        valId: "agentPlanWindowVal",
        label: "Schedule window (minutes either side of each slot)",
        min: 15,
        max: 60,
        step: 5,
        value: Number(p.schedule_window_minutes || 45),
        format: (v) => v + " min",
      });

    const sizingBody =
      '<div class="agent-plan-grid">' +
      '<label class="agent-plan-field">' +
      "<span>Paper equity (USD)</span>" +
      '<input type="number" id="agentPlanEquity" min="5000" max="1000000" step="1000" value="' +
      Number(ag.shadow_equity || 30000) +
      '" inputmode="decimal" /></label>' +
      '<label class="agent-plan-field">' +
      "<span>Max trades per day</span>" +
      '<select id="agentPlanMaxTrades">' +
      [1, 2, 3]
        .map(function (n) {
          return (
            '<option value="' +
            n +
            '"' +
            (Number(ag.max_trades_per_day) === n ? " selected" : "") +
            ">" +
            n +
            "</option>"
          );
        })
        .join("") +
      "</select></label></div>";

    const riskBody =
      sliderRow({
        id: "agentPlanRiskTrade",
        valId: "agentPlanRiskTradeVal",
        label: "Max risk per trade",
        min: 50,
        max: 500,
        step: 10,
        value: Number(risk.max_risk_per_trade_usd || 150),
        format: (v) => "$" + v,
      }) +
      sliderRow({
        id: "agentPlanRiskDaily",
        valId: "agentPlanRiskDailyVal",
        label: "Max daily loss",
        min: 100,
        max: 1000,
        step: 25,
        value: Number(risk.max_daily_loss_usd || 300),
        format: (v) => "$" + v,
      });

    const qualifyBody =
      sliderRow({
        id: "agentPlanMinConf",
        valId: "agentPlanMinConfVal",
        label: "Minimum confidence",
        min: 40,
        max: 90,
        step: 5,
        value: Math.round(Number(qual.min_confidence || 0.55) * 100),
        format: (v) => v + "%",
      }) +
      sliderRow({
        id: "agentPlanMinR",
        valId: "agentPlanMinRVal",
        label: "Minimum backtest average R",
        min: 10,
        max: 80,
        step: 5,
        value: Math.round(Number(qual.min_backtest_avg_r || 0.3) * 100),
        format: (v) => (Number(v) / 100).toFixed(2) + "R",
      });

    const advancedBody =
      '<label class="agent-plan-field">' +
      "<span>API base URL</span>" +
      '<input type="url" id="agentPlanApiBase" value="' +
      escapeHtml(p.api_base_url || "") +
      '" placeholder="https://rainmaker-api-waqs.onrender.com" autocapitalize="off" spellcheck="false" /></label>' +
      '<p class="agent-plan-hint">GitHub Actions cron reads this plan from the API. Changing ET slots may require a workflow update.</p>';

    return (
      '<section class="agent-plan">' +
      '<p id="agentPlanStatus" class="agent-plan-status" aria-live="polite"></p>' +
      block(
        "Overnight agent",
        "Shadow paper",
        '<label class="agent-plan-enable">' +
        '<input type="checkbox" id="agentPlanEnabled"' +
        (enabled ? " checked" : "") +
        " />" +
        "<span><strong>Enable overnight agent</strong>" +
        "<small>Weekday cron jobs propose shadow trades using the schedule below.</small></span></label>"
      ) +
      block("Schedule", "Eastern Time", scheduleBody) +
      block("Sizing", "", sizingBody) +
      block("Risk rails", "Reference limits", riskBody) +
      block("Qualify gates", "", qualifyBody) +
      block("Advanced", "", advancedBody) +
      block("Recent changes", "", renderChangelog(p.changelog)) +
      '<label class="agent-plan-field agent-plan-note">' +
      "<span>Change note</span>" +
      '<input type="text" id="agentPlanNote" maxlength="240" placeholder="Optional - why this tweak?" /></label>' +
      "</section>"
    );
  }

  function readPanel(root, draft) {
    const p = mergePlan(draft);
    const apiEl = root.querySelector("#agentPlanApiBase");
    const enabledEl = root.querySelector("#agentPlanEnabled");
    if (apiEl) p.api_base_url = apiEl.value.trim();
    if (enabledEl) p.agent_enabled = enabledEl.checked;
    const winEl = root.querySelector("#agentPlanWindow");
    if (winEl) p.schedule_window_minutes = Number(winEl.value) || 45;
    p.jobs = (p.jobs || []).map(function (j, idx) {
      const row = root.querySelector('.agent-plan-job[data-job-idx="' + idx + '"]');
      if (!row) return j;
      const enabledInput = row.querySelector('[data-field="enabled"]');
      const hour = row.querySelector('[data-field="hour"]');
      const minute = row.querySelector('[data-field="minute"]');
      return {
        ...j,
        enabled: enabledInput ? enabledInput.checked : j.enabled,
        hour: hour ? Number(hour.value) : j.hour,
        minute: minute ? Number(minute.value) : j.minute,
      };
    });
    p.agent = {
      ...p.agent,
      shadow_equity: Number(root.querySelector("#agentPlanEquity")?.value) || 30000,
      max_trades_per_day: Number(root.querySelector("#agentPlanMaxTrades")?.value) || 1,
    };
    p.risk = {
      ...p.risk,
      max_risk_per_trade_usd: Number(root.querySelector("#agentPlanRiskTrade")?.value) || 150,
      max_daily_loss_usd: Number(root.querySelector("#agentPlanRiskDaily")?.value) || 300,
    };
    p.qualify = {
      ...p.qualify,
      min_confidence: Number(root.querySelector("#agentPlanMinConf")?.value || 55) / 100,
      min_backtest_avg_r: Number(root.querySelector("#agentPlanMinR")?.value || 30) / 100,
    };
    return p;
  }

  function setPanelStatus(root, message, tone) {
    const el = root?.querySelector("#agentPlanStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("agent-plan-status--ok", "agent-plan-status--warn", "agent-plan-status--err");
    if (tone === "ok") el.classList.add("agent-plan-status--ok");
    else if (tone === "warn") el.classList.add("agent-plan-status--warn");
    else if (tone === "err") el.classList.add("agent-plan-status--err");
  }

  function wirePanel(root, draftRef) {
    if (!root || root.dataset.wired === "1") return;
    root.dataset.wired = "1";

    function syncLabels() {
      const w = root.querySelector("#agentPlanWindow");
      const wv = root.querySelector("#agentPlanWindowVal");
      if (w && wv) wv.textContent = w.value + " min";
      const rt = root.querySelector("#agentPlanRiskTrade");
      const rtv = root.querySelector("#agentPlanRiskTradeVal");
      if (rt && rtv) rtv.textContent = "$" + rt.value;
      const rd = root.querySelector("#agentPlanRiskDaily");
      const rdv = root.querySelector("#agentPlanRiskDailyVal");
      if (rd && rdv) rdv.textContent = "$" + rd.value;
      const mc = root.querySelector("#agentPlanMinConf");
      const mcv = root.querySelector("#agentPlanMinConfVal");
      if (mc && mcv) mcv.textContent = mc.value + "%";
      const mr = root.querySelector("#agentPlanMinR");
      const mrv = root.querySelector("#agentPlanMinRVal");
      if (mr && mrv) mrv.textContent = (Number(mr.value) / 100).toFixed(2) + "R";
      root.querySelectorAll(".agent-plan-job").forEach(function (row) {
        const h = row.querySelector('[data-field="hour"]');
        const m = row.querySelector('[data-field="minute"]');
        const et = row.querySelector(".agent-plan-job-et");
        const cb = row.querySelector('[data-field="enabled"]');
        if (h && m && et) et.textContent = fmtTime(h.value, m.value);
        if (cb) row.classList.toggle("agent-plan-job--off", !cb.checked);
      });
      if (draftRef) draftRef.current = readPanel(root, draftRef.current);
    }

    root.addEventListener("input", syncLabels);
    root.addEventListener("change", syncLabels);
    syncLabels();
  }

  function renderPanel(root, plan) {
    if (!root) return null;
    root.dataset.wired = "0";
    const draft = mergePlan(plan);
    root.innerHTML = renderPanelHtml(draft);
    const ref = { current: draft };
    wirePanel(root, ref);
    return ref;
  }

  global.RMAgentPlan = {
    defaults,
    mergePlan,
    fetchPlan,
    savePlan,
    renderPanel,
    readPanel,
    setPanelStatus,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- strategies.js --- */
/**
 * RMStrategies - strategy registry + active-strategy state (Phase 1).
 *
 * A "strategy" is a named recipe that bundles the scan filters, the trade
 * recipe (entry rule, stop rule, R:R) and sizing into one object. One strategy
 * is marked "active"; the active strategy drives the footer/chart trade plan.
 *
 * Phase 1 scope:
 *   - Built-in registry (read-only). Only "live" strategies can be made active
 *     and backtested; "soon" strategies are previews.
 *   - Active selection persists in localStorage and feeds RMTradeFooter.
 *   - Custom / prompt-authored strategies are NOT buildable yet, but the data
 *     schema below reserves the fields (source, prompt, custom list) so the
 *     authoring flow can be added later without a migration.
 */
(function (global) {
  const STORAGE_KEY = "rm_strategies_v1";
  const SCHEMA_VERSION = 1;
  const GE = "\u2265"; // greater-or-equal
  const MID = "\u00b7"; // middle dot
  const GT = "\u003e"; // greater-than

  /**
   * Built-in strategy recipes.
   * status: "live"  -> drives footer + backtests today's session
   *         "soon"  -> preview only (entry/stop engine not wired yet)
   * source: "builtin" | "clone" | "prompt"  (clone/prompt reserved for later)
   */
  const BUILTINS = [
    {
      id: "atlas",
      name: "Atlas",
      badge: "Atlas",
      kind: "options_momentum",
      source: "builtin",
      status: "live",
      rr: 2,
      entryRule: "orh",
      stopRule: "premium_50pct",
      filters: { gapPctMin: 3, minScore: 50 },
      sizing: { mode: "risk_pct", riskPct: 0.01, maxContracts: 10 },
      summary:
        "Options momentum on ORH break — delta 0.35–0.45, OCO bracket at fill, 2R target. Default Atlas operator.",
      rules: [
        "Gap " + GE + " 3% " + MID + " RM " + GE + " 50",
        "Calls delta 0.35–0.45, 5–15 DTE",
        "OCO stop 50% premium / limit 2R",
        "Trail milestones at 0.5R–2R",
      ],
      signalSource: "atlas",
      configPath: "config/atlas.json",
      prompt: null,
    },
    {
      id: "h001-orh-2r",
      name: "Gap-and-go " + MID + " ORH",
      badge: "H-001",
      kind: "momentum",
      source: "builtin",
      status: "live",
      rr: 2,
      entryRule: "orh", // opening-range high breakout
      stopRule: "orl", // below opening-range low
      filters: { gapPctMin: 3, minScore: 50 },
      sizing: { mode: "fixed_qty", qty: 100 },
      summary: "Limit buy ORH, stop below ORL, scale 1R / 2R. Default morning template.",
      rules: ["Gap " + GE + " 3% " + MID + " RM " + GE + " 50", "News or volume proxy", "Exit remainder at close"],
      prompt: null,
    },
    {
      id: "h001-orh-15r",
      name: "Gap-and-go " + MID + " ORH (1.5R)",
      badge: "H-001",
      kind: "momentum",
      source: "builtin",
      status: "live",
      rr: 1.5,
      entryRule: "orh",
      stopRule: "orl",
      filters: { gapPctMin: 3, minScore: 50 },
      sizing: { mode: "fixed_qty", qty: 100 },
      summary: "Same ORH trigger, conservative 1.5R target \u2014 books winners sooner.",
      rules: ["Gap " + GE + " 3% " + MID + " RM " + GE + " 50", "Target 1.5R", "Exit remainder at close"],
      prompt: null,
    },
    {
      id: "vwap-reclaim",
      name: "VWAP reclaim",
      badge: "Momentum",
      kind: "momentum",
      source: "builtin",
      status: "live",
      rr: 1.5,
      entryRule: "vwap",
      stopRule: "session_low",
      filters: { gapPctMin: 0, minScore: 50 },
      sizing: { mode: "fixed_qty", qty: 100 },
      summary: "Enter first 5m close back above VWAP after a dip; stop the session low.",
      rules: ["Reclaim of session VWAP", "Stop = session low", "Target " + GE + " 1.5R"],
      prompt: null,
    },
    {
      id: "fade-prior-close",
      name: "Fade to prior close",
      badge: "Mean rev",
      kind: "mean_reversion",
      source: "builtin",
      status: "soon",
      rr: 1,
      entryRule: "fade",
      stopRule: "gap_high",
      filters: { gapPctMin: 8, minScore: 50 },
      sizing: { mode: "fixed_qty", qty: 100 },
      summary: "Short extended gap when SPY weak and no catalyst.",
      rules: ["Gap " + GT + " 8% " + MID + " weak tape", "No headline"],
      prompt: null,
    },
  ];

  const DEFAULT_ACTIVE_ID = "atlas";

  /**
   * Personas (item 13): user-zero is the options day trader. A persona scopes
   * which setups/strategies surface first. Switchable + remembered alongside the
   * active strategy in the same rm_strategies_v1 state. "soon" personas preview.
   */
  const PERSONAS = [
    {
      id: "options-daytrader",
      name: "Options day trader",
      status: "live",
      blurb: "Morning momentum on liquid options names \u2014 user-zero default.",
      defaultStrategyId: "atlas",
    },
    {
      id: "equities-swing",
      name: "Equities swing",
      status: "soon",
      blurb: "Multi-day holds on trend continuation \u2014 coming soon.",
      defaultStrategyId: "vwap-reclaim",
    },
  ];
  const DEFAULT_PERSONA_ID = "options-daytrader";

  function clone(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : obj;
  }

  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw)
        return {
          version: SCHEMA_VERSION,
          activeId: DEFAULT_ACTIVE_ID,
          personaId: DEFAULT_PERSONA_ID,
          custom: [],
        };
      const parsed = JSON.parse(raw) || {};
      return {
        version: SCHEMA_VERSION,
        activeId: typeof parsed.activeId === "string" ? parsed.activeId : DEFAULT_ACTIVE_ID,
        personaId: typeof parsed.personaId === "string" ? parsed.personaId : DEFAULT_PERSONA_ID,
        custom: Array.isArray(parsed.custom) ? parsed.custom : [],
      };
    } catch {
      return {
        version: SCHEMA_VERSION,
        activeId: DEFAULT_ACTIVE_ID,
        personaId: DEFAULT_PERSONA_ID,
        custom: [],
      };
    }
  }

  function writeState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage disabled - active falls back to default in-memory */
    }
  }

  /** All strategies: built-ins followed by any (future) custom ones. */
  function list() {
    const state = readState();
    return BUILTINS.map(clone).concat((state.custom || []).map(clone));
  }

  function recommended() {
    return list().filter((s) => s.source === "builtin");
  }

  function custom() {
    return list().filter((s) => s.source !== "builtin");
  }

  function get(id) {
    return list().find((s) => s.id === id) || null;
  }

  function isLive(id) {
    const s = typeof id === "object" ? id : get(id);
    return !!s && s.status === "live";
  }

  function getActive() {
    const state = readState();
    return get(state.activeId) || get(DEFAULT_ACTIVE_ID) || clone(BUILTINS[0]);
  }

  /** Only "live" strategies may be activated. Returns true on success. */
  function setActive(id) {
    if (!isLive(id)) return false;
    const state = readState();
    state.activeId = typeof id === "object" ? id.id : id;
    writeState(state);
    return true;
  }

  function personas() {
    return PERSONAS.map(clone);
  }

  function getPersona() {
    const state = readState();
    return (
      PERSONAS.find((p) => p.id === state.personaId) ||
      PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID) ||
      clone(PERSONAS[0])
    );
  }

  /** Only "live" personas may be selected. Returns true on success. */
  function setPersona(id) {
    const pid = typeof id === "object" ? id.id : id;
    const p = PERSONAS.find((x) => x.id === pid);
    if (!p || p.status !== "live") return false;
    const state = readState();
    state.personaId = pid;
    writeState(state);
    return true;
  }

  /** Footer/chart plan inputs derived from a strategy (defaults to active). */
  function planParams(strategy) {
    const s = strategy || getActive();
    const rr = Number(s?.rr);
    return {
      id: s?.id || DEFAULT_ACTIVE_ID,
      rr: Number.isFinite(rr) && rr > 0 ? rr : 2,
      entryRule: s?.entryRule || "orh",
      stopRule: s?.stopRule || "orl",
      qty: s?.sizing?.qty || 100,
    };
  }

  /**
   * Derive a performance summary for a strategy from a backtest report.
   * Perf only attributes when the report was run for the SAME engine
   * (entry rule) and R:R as the strategy. Otherwise returns null and the
   * card shows "Backtest to score".
   */
  function perfFor(strategy, backtestReport) {
    const s = typeof strategy === "object" ? strategy : get(strategy);
    if (!s || s.status !== "live") return null;
    const sum = backtestReport?.summary;
    if (!sum || sum.n == null) return null;
    const reportRule = backtestReport.entry_rule || "orh";
    if (reportRule !== s.entryRule) return null;
    const reportRr = Number(backtestReport.rr);
    if (Number.isFinite(reportRr) && Number.isFinite(Number(s.rr)) && reportRr !== Number(s.rr)) {
      return null;
    }
    return {
      n: sum.n,
      avgR: sum.avgR != null ? sum.avgR : null,
      winRate: sum.winRate != null ? sum.winRate : null,
    };
  }

  /** Recommended ordering: scored live (by avgR desc) -> unscored live -> soon. */
  function rankRecommended(loadReportFn, sessionId) {
    return recommended()
      .map((s) => {
        const report =
          s.status === "live" && typeof loadReportFn === "function"
            ? loadReportFn(sessionId, s.id)
            : null;
        const perf = perfFor(s, report);
        return { strategy: s, perf };
      })
      .sort((a, b) => {
        const score = (x) => {
          if (x.strategy.status !== "live") return -2;
          if (!x.perf || x.perf.avgR == null) return -1;
          return x.perf.avgR;
        };
        return score(b) - score(a);
      });
  }

  global.RMStrategies = {
    SCHEMA_VERSION,
    DEFAULT_ACTIVE_ID,
    DEFAULT_PERSONA_ID,
    BUILTINS,
    PERSONAS,
    list,
    recommended,
    custom,
    get,
    isLive,
    getActive,
    setActive,
    personas,
    getPersona,
    setPersona,
    planParams,
    perfFor,
    rankRecommended,
    __reset() {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- market_scan.js --- */
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

;
/* --- trade_footer.js --- */
/** Sticky footer trade journey: Target -> Position -> Close. */
(function (global) {
  const STEP_ORDER = ["target", "position", "close"];
  let hooks = {};
  /** Per-symbol working plan so user edits survive progressive step re-renders. */
  const working = {};

  function applyWorking(symbol, plan) {
    const w = working[symbol];
    if (w && plan) Object.assign(plan, w);
    return plan;
  }

  function saveWorking(symbol) {
    if (!symbol) return;
    const w = working[symbol] || {};
    const e = num("tfEntry");
    if (e != null) w.entry = e;
    const s = num("tfStop");
    if (s != null) w.stop = s;
    const t = num("tfTarget");
    if (t != null) w.target = t;
    const q = num("tfQty");
    if (q != null) w.qty = q;
    working[symbol] = w;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function fmtPrice(n) {
    if (n == null || Number.isNaN(n)) return "?";
    return "$" + Number(n).toFixed(2);
  }

  function getStep(symbol) {
    const key = "rainmaker_trade_step_" + String(symbol || "").toUpperCase();
    try {
      return localStorage.getItem(key) || "target";
    } catch {
      return "target";
    }
  }

  function setStep(symbol, step) {
    const key = "rainmaker_trade_step_" + String(symbol || "").toUpperCase();
    try {
      localStorage.setItem(key, step);
    } catch {
      /* ignore */
    }
  }

  function openTrade(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const trades = hooks.getTrades?.() || [];
    const local = trades.find((t) => t.symbol === sym && t.status === "open");
    if (local) return local;
    const holding = hooks.getHolding?.(sym);
    if (holding && holding.entry_price != null) {
      return {
        symbol: sym,
        status: "open",
        source: holding.source || "schwab",
        entry_price: holding.entry_price,
        quantity: holding.quantity,
        stop_price: holding.stop_price ?? null,
        target_price: holding.target_price ?? null,
        execution_channel: holding.source === "schwab" ? "schwab" : "platform",
        opened_at: holding.entry_date || holding.opened_at || null,
      };
    }
    return null;
  }

  function schwabStepForSymbol(symbol) {
    if (openTrade(symbol)) return "close";
    return getStep(symbol);
  }

  function recommendationsFor(pick, plan, open) {
    if (typeof global.RMTradeRecommendations === "undefined") return [];
    const sym = pick?.symbol;
    if (!sym) return [];
    const holding = hooks.getHolding?.(sym);
    const last = pick.last ?? plan?.price ?? plan?.entry;
    return global.RMTradeRecommendations.evaluate({
      symbol: sym,
      entry: open?.entry_price ?? plan?.entry,
      stop: open?.stop_price ?? plan?.stop,
      target: open?.target_price ?? plan?.target,
      lastPrice: last,
      orh: plan?.orh,
      orl: plan?.orl,
      qty: open?.quantity ?? plan?.qty,
      holding,
    });
  }

  function recommendationsHtml(recs, pick, plan) {
    if (!recs?.length || typeof global.RMTradeRecommendations === "undefined") return "";
    return global.RMTradeRecommendations.stripHtml(recs);
  }

  function bindRecommendationActions(recs, pick, plan, open) {
    document.querySelectorAll("#tradeFooterJourney .tf-rec-accept").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.recType;
        const rec = recs.find((r) => r.type === type);
        if (!rec) return;
        if (typeof global.RMTradeRecommendations !== "undefined") {
          void global.RMTradeRecommendations.logRecommendation(rec, "accept", {
            planRevision: {
              symbol: pick.symbol,
              entry: plan.entry,
              stop: rec.type === "trail_stop" && plan.entry ? plan.entry : plan.stop,
              target: plan.target,
              qty: plan.qty,
            },
            reason: rec.type,
          });
        }
        hooks.status?.("Noted: " + rec.label + " — adjust plan in Position step.");
      });
    });
    document.querySelectorAll("#tradeFooterJourney .tf-rec-dismiss").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.recType;
        const rec = recs.find((r) => r.type === type);
        if (!rec) return;
        if (typeof global.RMTradeRecommendations !== "undefined") {
          void global.RMTradeRecommendations.logRecommendation(rec, "dismiss");
          global.RMTradeRecommendations.dismiss(rec.symbol, rec.type);
        }
        refresh(pick);
      });
    });
  }

  function srFromChart(symbol) {
    if (typeof RMAnalysisChart === "undefined") return null;
    const st = RMAnalysisChart.state;
    if (!st || st.symbol !== symbol || !st.srLines?.length) return null;
    const support = st.srLines.filter((l) => l.kind === "support").map((l) => l.price);
    const resistance = st.srLines.filter((l) => l.kind === "resistance").map((l) => l.price);
    return {
      support: support.length ? Math.max(...support) : null,
      resistance: resistance.length ? Math.min(...resistance) : null,
    };
  }

  function srFromLines(srLines) {
    if (!srLines?.length) return null;
    const support = srLines.filter((l) => l.kind === "support").map((l) => l.price);
    const resistance = srLines.filter((l) => l.kind === "resistance").map((l) => l.price);
    return {
      support: support.length ? Math.max(...support) : null,
      resistance: resistance.length ? Math.min(...resistance) : null,
    };
  }

  function ptDayKey(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  }

  function ptMinutes(ms) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date(ms));
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    return hour * 60 + minute;
  }

  function openingRangeFromBars(bars, rthStartMs, orMinutes = 5) {
    if (!bars?.length) return { orh: null, orl: null };
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    const dayBars = bars.filter((b) => ptDayKey(b.t) === lastDay);
    let orBars = [];
    if (rthStartMs) {
      const end = rthStartMs + orMinutes * 60 * 1000;
      orBars = dayBars.filter((b) => b.t >= rthStartMs && b.t < end);
    }
    if (!orBars.length) {
      const openMin = 6 * 60 + 30;
      orBars = dayBars.filter((b) => {
        const mins = ptMinutes(b.t);
        return mins >= openMin && mins < openMin + orMinutes;
      });
    }
    if (!orBars.length) return { orh: null, orl: null };
    return {
      orh: Math.max(...orBars.map((b) => b.high ?? b.close)),
      orl: Math.min(...orBars.map((b) => b.low ?? b.close)),
    };
  }

  function sessionLowFromBars(bars) {
    if (!bars?.length) return null;
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    const lows = bars
      .filter((b) => ptDayKey(b.t) === lastDay)
      .map((b) => b.low ?? b.close)
      .filter((v) => v != null && Number.isFinite(v));
    return lows.length ? Math.min(...lows) : null;
  }

  function chartContextForSymbol(symbol) {
    if (typeof RMAnalysisChart === "undefined") return null;
    const st = RMAnalysisChart.state;
    if (!st || st.symbol !== symbol || !st.bars?.length) return null;
    return {
      bars: st.bars,
      srLines: st.srLines,
      rthStartMs: st.hub?.sessionMeta?.periods?.regular?.startMs,
      lastPrice: st.bars[st.bars.length - 1]?.close,
    };
  }

  function pickForSymbol(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const active = hooks.getActivePick?.();
    if (active?.symbol === sym) return active;
    const session = hooks.getSession?.();
    return (session?.picks || []).find((p) => p.symbol === sym) || null;
  }

  function activeRr() {
    const rr =
      typeof RMStrategies !== "undefined" ? Number(RMStrategies.getActive()?.rr) : NaN;
    return Number.isFinite(rr) && rr > 0 ? rr : 2;
  }

  function applyTargets(plan, rr, resistance) {
    const risk = plan.entry - plan.stop;
    if (!risk || risk <= 0) return plan;
    let t1 = round2(plan.entry + risk);
    // Item 10: when a recent resistance sits just above entry, treat it as the
    // first limit-sell so the target tracks the most recent S/R line.
    if (resistance != null && resistance > plan.entry) {
      const ceiling = plan.entry + risk * (rr + 0.5);
      if (resistance <= ceiling) t1 = round2(resistance);
    }
    plan.target1 = t1;
    plan.target2 = round2(plan.entry + risk * rr);
    if (plan.target2 <= plan.target1) plan.target2 = round2(plan.target1 + risk);
    plan.target = plan.target2;
    plan.rr = rr;
    return plan;
  }

  function recommendMorningSetup(pickOrSymbol, ctx) {
    const sym = String(
      (typeof pickOrSymbol === "string" ? pickOrSymbol : pickOrSymbol?.symbol) || ""
    ).toUpperCase();
    if (!sym) return null;
    const pick = typeof pickOrSymbol === "object" ? pickOrSymbol : pickForSymbol(sym);
    const chartCtx = ctx || chartContextForSymbol(sym);
    const price = pick?.last ?? pick?.open ?? pick?.price ?? chartCtx?.lastPrice;
    if (price == null && !chartCtx?.bars?.length) return null;
    const lastPrice = price ?? chartCtx?.lastPrice;
    const sr = chartCtx?.srLines ? srFromLines(chartCtx.srLines) : srFromChart(sym);
    const support = sr?.support ?? round2(lastPrice * 0.99);
    const resistance = sr?.resistance ?? round2(lastPrice * 1.01);
    const { orh, orl } = openingRangeFromBars(chartCtx?.bars, chartCtx?.rthStartMs);
    const activeRule =
      (typeof RMStrategies !== "undefined" && RMStrategies.getActive()?.entryRule) || "orh";
    let entry;
    let stop;
    if (activeRule === "vwap") {
      // VWAP reclaim: enter at market on the reclaim; stop the session low.
      const lo = sessionLowFromBars(chartCtx?.bars);
      entry = round2(lastPrice ?? orh ?? support * 1.01);
      stop = lo != null ? round2(lo - 0.01) : round2(entry * 0.97);
      if (!Number.isFinite(stop) || stop >= entry) stop = round2(entry * 0.97);
    } else {
      entry = round2(orh ?? Math.min(lastPrice, support * 1.01));
      if (orl != null) stop = round2(orl - 0.01);
      else if (sr?.support) stop = round2(Math.min(support * 0.995, entry * 0.98));
      else stop = round2(entry * 0.92);
      if (!Number.isFinite(stop) || stop >= entry) stop = round2(entry * 0.92);
    }
    const plan = {
      symbol: sym,
      support,
      resistance,
      entry,
      stop,
      price: lastPrice,
      orh,
      orl,
      qty: 100,
      rr: activeRr(),
    };
    applyTargets(plan, plan.rr, resistance);
    return plan;
  }

  function recommendPlan(pick) {
    if (!pick?.symbol) return null;
    return recommendMorningSetup(pick, chartContextForSymbol(pick.symbol));
  }

  function stepIndex(step) {
    const i = STEP_ORDER.indexOf(step);
    return i >= 0 ? i : 0;
  }

  function tfRange(plan) {
    return (
      '<span class="tf-range" title="Support / resistance">' +
      fmtPrice(plan.support) +
      " – " +
      fmtPrice(plan.resistance) +
      "</span>"
    );
  }

  function targetFields(plan, pick) {
    return (
      '<div class="tf-fields tf-fields--compact">' +
      tfRange(plan) +
      '<label class="tf-lbl tf-lbl--inline">Entry<input type="number" step="0.01" id="tfEntry" value="' +
      (plan.entry ?? "") +
      '" inputmode="decimal"></label>' +
      '<label class="tf-lbl tf-lbl--inline">Qty<input type="number" step="1" id="tfQty" value="' +
      (plan.qty ?? 100) +
      '" inputmode="numeric"></label>' +
      '<button type="button" class="btn btn-sm tf-action" id="tfConfirmTarget">Confirm</button></div>'
    );
  }

  function positionFields(plan, pick) {
    return (
      '<div class="tf-fields tf-fields--compact">' +
      '<span class="tf-inline"><span class="tf-lbl">Entry</span><strong id="tfShowEntry">' +
      fmtPrice(plan.entry) +
      '</strong></span>' +
      '<label class="tf-lbl tf-lbl--inline">Stop<input type="number" step="0.01" id="tfStop" value="' +
      (plan.stop ?? "") +
      '" inputmode="decimal"></label>' +
      '<label class="tf-lbl tf-lbl--inline">Target<input type="number" step="0.01" id="tfTarget" value="' +
      (plan.target ?? "") +
      '" inputmode="decimal"></label>' +
      '<button type="button" class="btn btn-sm tf-action" id="tfEnterPosition">Enter</button></div>'
    );
  }

  function closeFields(pick, trade) {
    const exitDefault = trade?.target_price ?? trade?.entry_price ?? "";
    return (
      '<div class="tf-fields tf-fields--compact">' +
      '<span class="tf-inline"><span class="tf-lbl">Open</span><strong>' +
      fmtPrice(trade?.entry_price) +
      '</strong></span>' +
      '<label class="tf-lbl tf-lbl--inline">Fill<select id="tfFillStatus"><option value="filled">Filled</option><option value="not_filled">Not filled</option></select></label>' +
      '<label class="tf-lbl tf-lbl--inline">Exit<input type="number" step="0.01" id="tfExit" value="' +
      exitDefault +
      '" inputmode="decimal"></label>' +
      '<button type="button" class="btn btn-sm tf-action tf-action--close" id="tfCloseTrade">Close</button></div>'
    );
  }

  function stepBlock(step, num, label, bodyHtml) {
    return (
      '<div class="tf-step tf-step--' +
      step +
      '" data-step="' +
      step +
      '">' +
      '<div class="tf-step-row">' +
      '<header class="tf-step-head"><span class="tf-step-num">' +
      num +
      '</span><span class="tf-step-label">' +
      label +
      "</span></header>" +
      '<div class="tf-step-body">' +
      bodyHtml +
      "</div></div></div>"
    );
  }

  function dualTrackHtml(trade) {
    if (!trade || trade.status !== "closed" || typeof RMTradeMetrics === "undefined") {
      return "";
    }
    const line = RMTradeMetrics.fmtDualTrack(trade);
    if (!line) return "";
    const status = RMTradeMetrics.reconcileStatus(trade);
    const cls = status === "agreed" ? "tf-dual-r--agreed" : "tf-dual-r--delta";
    return (
      '<div class="tf-dual-r ' +
      cls +
      '" title="Plan R vs Realized R until broker reconcile agrees">' +
      escapeHtml(line) +
      "</div>"
    );
  }

  function stratHeadHtml(plan, pick, open) {
    let stratLabel = "";
    if (typeof RMStrategies !== "undefined") {
      const s = RMStrategies.getActive();
      if (s?.name) stratLabel = "\u26a1 " + escapeHtml(s.name);
    }
    const rr = plan.rr ?? 2;
    const rrTxt = Number.isInteger(rr) ? String(rr) : Number(rr).toFixed(1);
    const closed =
      !open &&
      (() => {
        const trades = hooks.getTrades?.() || [];
        return trades.find(
          (t) =>
            t.symbol === pick.symbol &&
            t.status === "closed" &&
            t.closed_at &&
            new Date(t.closed_at).toDateString() === new Date().toDateString()
        );
      })();
    return (
      '<div class="tf-head">' +
      (stratLabel ? '<span class="tf-head-strat">' + stratLabel + "</span>" : "") +
      '<span class="tf-head-sym">' +
      escapeHtml(pick.symbol) +
      "</span>" +
      '<span class="tf-head-rr">R:R ' +
      rrTxt +
      ":1</span>" +
      dualTrackHtml(closed) +
      "</div>"
    );
  }

  function stepSummary(step, plan, open) {
    if (step === "target") {
      const e = open?.entry_price ?? plan.entry;
      return e != null ? "Entry " + fmtPrice(e) : "";
    }
    if (step === "position") {
      const st = open?.stop_price ?? plan.stop;
      const tg = open?.target_price ?? plan.target;
      return (
        (st != null ? "Stop " + fmtPrice(st) : "") +
        (tg != null ? " \u00b7 Tgt " + fmtPrice(tg) : "")
      );
    }
    return "";
  }

  function stepChipHtml(step, num, label, summary, kind) {
    return (
      '<div class="tf-step tf-step--' +
      step +
      " tf-step--" +
      kind +
      '" data-step="' +
      step +
      '" role="button" tabindex="0">' +
      '<div class="tf-step-row">' +
      '<header class="tf-step-head"><span class="tf-step-num">' +
      (kind === "done" ? "\u2713" : num) +
      '</span><span class="tf-step-label">' +
      label +
      "</span></header>" +
      (summary ? '<span class="tf-chip-sum">' + summary + "</span>" : "") +
      "</div></div>"
    );
  }

  function activeStepBlock(step, num, label, bodyHtml) {
    return (
      '<div class="tf-step tf-step--active tf-step--' +
      step +
      '" data-step="' +
      step +
      '"><div class="tf-step-row">' +
      '<header class="tf-step-head"><span class="tf-step-num">' +
      num +
      '</span><span class="tf-step-label">' +
      label +
      "</span></header>" +
      '<div class="tf-step-body">' +
      bodyHtml +
      "</div></div></div>"
    );
  }

  function progressiveStepsHtml(activeStep, plan, pick, open) {
    const ai = stepIndex(activeStep);
    const labels = { target: "Target", position: "Position", close: "Close" };
    const nums = { target: "1", position: "2", close: "3" };
    return STEP_ORDER.map((s) => {
      const i = stepIndex(s);
      if (i === ai) {
        let body;
        if (s === "target") body = targetFields(plan, pick);
        else if (s === "position") body = positionFields(plan, pick);
        else
          body = open
            ? closeFields(pick, open)
            : '<span class="meta tf-step-hint">Enter position first.</span>';
        return activeStepBlock(s, nums[s], labels[s], body);
      }
      if (i < ai) return stepChipHtml(s, nums[s], labels[s], stepSummary(s, plan, open), "done");
      return stepChipHtml(s, nums[s], labels[s], "", "future");
    }).join("");
  }

  function render(pick) {
    const journey = $("tradeFooterJourney");
    if (!journey) return;
    // Idle = nothing actionable: hide entirely (CSS :empty -> display:none).
    if (!pick) {
      journey.innerHTML = "";
      journey.dataset.symbol = "";
      journey.classList.remove("tf-active");
      return;
    }

    const plan = applyWorking(pick.symbol, recommendPlan(pick));
    if (!plan) {
      journey.innerHTML =
        '<div class="tf-empty"><p class="meta">No price data for ' +
        escapeHtml(pick.symbol) +
        " \u2014 wait for quotes.</p></div>";
      journey.classList.remove("tf-active");
      return;
    }

    const open = openTrade(pick.symbol);
    let step = open ? "close" : getStep(pick.symbol);
    if (!STEP_ORDER.includes(step)) step = "target";
    if (open && open.source === "schwab" && step === "target") step = "close";
    setStep(pick.symbol, step);

    const recs = recommendationsFor(pick, plan, open);

    journey.dataset.symbol = pick.symbol;
    journey.classList.add("tf-active");
    journey.innerHTML =
      stratHeadHtml(plan, pick, open) +
      recommendationsHtml(recs, pick, plan) +
      '<div class="tf-steps">' +
      progressiveStepsHtml(step, plan, pick, open) +
      "</div>";

    bindStepActions(pick, plan, open);
    bindRecommendationActions(recs, pick, plan, open);
    pushPlanToChart(pick, plan);
    bindPlanFieldSync(pick, plan);
  }

  function num(id) {
    const v = parseFloat($(id)?.value);
    return Number.isNaN(v) ? null : v;
  }

  function readLivePlan(pick, plan) {
    const entry = num("tfEntry") ?? plan.entry;
    const stop = num("tfStop") ?? plan.stop;
    const rr = plan.rr ?? 2;
    const live = {
      symbol: pick.symbol,
      entry,
      stop,
      target: num("tfTarget") ?? plan.target,
      qty: Math.max(1, parseInt($("tfQty")?.value, 10) || 100),
      rr,
    };
    applyTargets(live, rr);
    if (num("tfTarget") != null) {
      live.target2 = num("tfTarget");
      live.target = live.target2;
    }
    return live;
  }

  function pushPlanToChart(pick, plan) {
    if (typeof RMAnalysisChart === "undefined" || !RMAnalysisChart.syncTradePlan) return;
    RMAnalysisChart.syncTradePlan(readLivePlan(pick, plan));
  }

  function emitTradeJourney(stage, pick, plan, source) {
    const live = plan ? readLivePlan(pick, plan) : null;
    const detail = {
      stage,
      symbol: pick?.symbol,
      selectKey: pick?.symbol,
      plan: live,
      source: source || "footer",
    };
    if (typeof global.dispatchTradeJourney === "function") {
      global.dispatchTradeJourney(detail);
    } else {
      document.dispatchEvent(new CustomEvent("rm:trade-journey", { detail }));
    }
  }

  function bindPlanFieldSync(pick, plan) {
    let planRevTimer = null;
    ["tfEntry", "tfStop", "tfTarget", "tfQty"].forEach((id) => {
      $(id)?.addEventListener("input", () => {
        saveWorking(pick.symbol);
        pushPlanToChart(pick, plan);
        if (getStep(pick.symbol) === "position" && typeof global.RMTradeStory !== "undefined") {
          clearTimeout(planRevTimer);
          planRevTimer = setTimeout(() => {
            void global.RMTradeStory.syncPlanRevision(readLivePlan(pick, plan), {
              reason: "footer_edit",
            });
          }, 600);
        }
      });
    });
  }

  function bindStepActions(pick, plan, openTradeRow) {
    $("tfConfirmTarget")?.addEventListener("click", () => {
      const entry = num("tfEntry") ?? plan.entry;
      plan.entry = entry;
      if (plan.orl != null) plan.stop = round2(plan.orl - 0.01);
      else if (plan.support) plan.stop = round2(Math.min(plan.support * 0.995, entry * 0.98));
      else plan.stop = round2(entry * 0.92);
      applyTargets(plan, plan.rr ?? 2);
      // Persist confirmed entry/stop/target so the position step re-renders with them.
      working[pick.symbol] = {
        ...(working[pick.symbol] || {}),
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        qty: num("tfQty") ?? working[pick.symbol]?.qty ?? plan.qty,
      };
      setStep(pick.symbol, "position");
      refresh(pick);
      pushPlanToChart(pick, plan);
      if (typeof global.RMTradeStory !== "undefined") {
        const sig =
          typeof global.RMStrategies !== "undefined"
            ? global.RMStrategies.getActive()?.signalSource ||
              (global.RMStrategies.getActive()?.id === "atlas" ? "atlas" : "orh")
            : "orh";
        void global.RMTradeStory.syncPlan(plan, { signal_source: sig });
      }
      emitTradeJourney("plan", pick, plan, "footer");
      hooks.status?.("Target set — adjust stop & target, then enter position.");
    });

    $("tfEnterPosition")?.addEventListener("click", () => {
      const entry = num("tfEntry") ?? plan.entry;
      const stopVal = num("tfStop") ?? plan.stop;
      const targetVal = num("tfTarget") ?? plan.target;
      const priorStop = plan.stop;
      const priorTarget = plan.target;
      const trade = {
        symbol: pick.symbol,
        session_id: hooks.getSession?.()?.session_id,
        instrument: "stock",
        rm_confidence: pick.rm_confidence,
        rm_confidence_adjusted: hooks.pickScore?.(pick),
        opened_at: new Date().toISOString(),
        status: "open",
        source: "footer",
        execution_channel: "platform",
        planned: true,
        entry_price: entry,
        quantity: num("tfQty") ?? 100,
        stop_price: num("tfStop") ?? plan.stop,
        target_price: num("tfTarget") ?? plan.target,
        support: plan.support,
        resistance: plan.resistance,
      };
      hooks.saveOpenTrade?.(trade);
      if (typeof global.RMTradeStory !== "undefined") {
        void global.RMTradeStory.syncEntry(trade);
      }
      if (
        (stopVal !== priorStop || targetVal !== priorTarget) &&
        typeof global.RMTradeStory !== "undefined"
      ) {
        void global.RMTradeStory.syncPlanRevision(
          {
            symbol: pick.symbol,
            entry,
            stop: stopVal,
            target: targetVal,
            qty: num("tfQty") ?? plan.qty,
          },
          { prior_stop: priorStop, prior_target: priorTarget, reason: "enter_position" }
        );
      }
      setStep(pick.symbol, "close");
      refresh(pick);
      emitTradeJourney("open", pick, plan, "footer");
      hooks.status?.("Position open ? record exit when you close.");
    });

    $("tfCloseTrade")?.addEventListener("click", () => {
      if (!openTradeRow && !openTrade(pick.symbol)) {
        hooks.status?.("No open position for " + pick.symbol);
        return;
      }
      const exitPrice = num("tfExit");
      hooks.closeTrade?.({
        symbol: pick.symbol,
        fill_status: $("tfFillStatus")?.value,
        exit_price: exitPrice,
        entry_price: openTradeRow?.entry_price ?? num("tfEntry") ?? plan.entry,
        stop_price: openTradeRow?.stop_price ?? num("tfStop") ?? plan.stop,
        target_price: openTradeRow?.target_price ?? num("tfTarget") ?? plan.target,
        quantity: openTradeRow?.quantity ?? num("tfQty") ?? 100,
        planned: true,
        source: "footer",
      });
      delete working[pick.symbol];
      setStep(pick.symbol, "target");
      refresh(null);
    });

    // Clicking a done/future chip jumps to that step (re-renders progressively).
    document.querySelectorAll("#tradeFooterJourney .tf-step--done, #tradeFooterJourney .tf-step--future").forEach((chip) => {
      const go = () => {
        const step = chip.dataset.step;
        if (!step) return;
        saveWorking(pick.symbol);
        setStep(pick.symbol, step);
        refresh(pick);
      };
      chip.addEventListener("click", go);
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    });
  }

  function refresh(pick) {
    render(pick || hooks.getActivePick?.());
  }

  function init(h) {
    hooks = h || {};
    const journey = $("tradeFooterJourney");
    if (journey && !journey.dataset.ready) {
      journey.dataset.ready = "1";
      journey.innerHTML = ""; // idle = hidden until a pick is actionable
    }
  }

  function selectPick(pick) {
    if (!pick) {
      refresh(null);
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
        RMAnalysisChart.refreshTradeOverlay();
      }
      return;
    }
    hooks.onSelect?.(pick);
    render(pick);
  }

  function onPlanChartEdit(plan) {
    const pick = hooks.getActivePick?.();
    if (!pick || pick.symbol !== plan.symbol) return;
    const entryEl = $("tfEntry");
    const stopEl = $("tfStop");
    const targetEl = $("tfTarget");
    const qtyEl = $("tfQty");
    if (entryEl && plan.entry != null) entryEl.value = plan.entry;
    if (stopEl && plan.stop != null) stopEl.value = plan.stop;
    if (targetEl && plan.target != null) targetEl.value = plan.target;
    if (qtyEl && plan.qty != null) qtyEl.value = plan.qty;
    saveWorking(plan.symbol);
  }

  function recommendFromEmaSignal(ctx) {
    const sym = String(ctx?.symbol || "").toUpperCase();
    if (!sym || ctx?.barIndex == null || !ctx?.bars?.length) return null;
    const i = ctx.barIndex;
    const bar = ctx.bars[i];
    if (!bar) return null;
    const lookback = ctx.swingLookback ?? 8;
    const rr = ctx.defaultRr ?? 2;
    let swingLo = null;
    if (typeof global.RMEmaSignals !== "undefined") {
      swingLo = global.RMEmaSignals.swingLow(ctx.bars, i, lookback);
    } else {
      for (let j = Math.max(0, i - lookback + 1); j <= i; j++) {
        const v = ctx.bars[j]?.low ?? ctx.bars[j]?.close;
        if (v != null) swingLo = swingLo == null ? v : Math.min(swingLo, v);
      }
    }
    const entry = round2(bar.close);
    let stop = swingLo != null ? round2(swingLo - 0.01) : round2(entry * 0.97);
    if (!Number.isFinite(stop) || stop >= entry) stop = round2(entry * 0.97);
    const plan = {
      symbol: sym,
      entry,
      stop,
      qty: 100,
      rr,
      signal_source: ctx.signalSource || "ema_golden_cross",
      signal_label: ctx.signalLabel || "EMA signal",
    };
    applyTargets(plan, rr, round2(entry * 1.04));
    return plan;
  }

  global.RMTradeFooter = {
    init,
    refresh,
    selectPick,
    render,
    recommendPlan,
    recommendMorningSetup,
    recommendFromEmaSignal,
    pickForSymbol,
    onPlanChartEdit,
    readLivePlan,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- trade_metrics.js --- */
/** R-multiple, expectancy, dual-track Plan R / Realized R (ADR-003 + Trade Story). */
(function (global) {
  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
  }

  function isPlannedTrade(trade) {
    if (trade.planned === false) return false;
    if (trade.planned === true) return true;
    return trade.source === "footer" || trade.source === "dashboard";
  }

  function rMultiple(trade) {
    if (trade.plan_r != null && Number.isFinite(trade.plan_r)) return trade.plan_r;
    if (trade.realized_r != null && Number.isFinite(trade.realized_r)) {
      return trade.realized_r;
    }
    if (trade.r_multiple != null && Number.isFinite(trade.r_multiple)) {
      return trade.r_multiple;
    }
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price;
    const stop = trade.stop_price ?? trade.stop_premium;
    if (entry == null || exit == null || stop == null) return null;
    const risk = entry - stop;
    if (!Number.isFinite(risk) || risk <= 0) return null;
    return (exit - entry) / risk;
  }

  function planR(trade) {
    if (trade.plan_r != null && Number.isFinite(trade.plan_r)) return trade.plan_r;
    if (trade.status !== "closed" || trade.filled === false) return null;
    return rMultiple(trade);
  }

  function realizedR(trade) {
    if (trade.realized_r != null && Number.isFinite(trade.realized_r)) {
      return trade.realized_r;
    }
    if (trade.reconcile_status === "agreed" && trade.r_multiple != null) {
      return trade.r_multiple;
    }
    return null;
  }

  function reconcileStatus(trade) {
    if (trade.reconcile_status === "agreed" || trade.reconcile_status === "delta") {
      return trade.reconcile_status;
    }
    const p = planR(trade);
    const r = realizedR(trade);
    if (p == null && r == null) return trade.reconciled ? "agreed" : null;
    if (r == null) return trade.reconciled ? "agreed" : "delta";
    const dp = Math.abs(p - r);
    return dp < 0.05 ? "agreed" : "delta";
  }

  function applyDualTrack(trade, opts) {
    const planned =
      opts?.planned != null ? opts.planned : isPlannedTrade(trade);
    const pr = planR(trade) ?? (opts?.exit_price != null ? rMultiple(trade) : null);
    const patch = {
      ...trade,
      planned,
      plan_r: pr != null ? round4(pr) : trade.plan_r ?? null,
      execution_channel:
        trade.execution_channel || opts?.execution_channel || "platform",
    };
    if (trade.reconciled && trade.realized_r == null && trade.r_multiple != null) {
      patch.realized_r = round4(trade.r_multiple);
      patch.reconcile_status = "agreed";
    } else if (patch.realized_r != null) {
      patch.reconcile_status = reconcileStatus(patch);
    } else {
      patch.reconcile_status = trade.reconcile_status || "delta";
    }
    return patch;
  }

  function contractMultiplier(trade) {
    if (trade.instrument === "option") return 100;
    if (
      typeof global.RMHoldings !== "undefined" &&
      global.RMHoldings.isOptionSymbol &&
      global.RMHoldings.isOptionSymbol(trade.symbol)
    ) {
      return 100;
    }
    return 1;
  }

  function pnlUsd(trade) {
    if (trade.pnl_usd != null && Number.isFinite(trade.pnl_usd)) {
      return trade.pnl_usd;
    }
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price ?? trade.exit_premium;
    const qty = trade.quantity ?? trade.contracts;
    if (entry == null || exit == null || qty == null) return null;
    return (exit - entry) * qty * contractMultiplier(trade);
  }

  function enrichClosedTrade(trade, opts) {
    if (trade.status !== "closed" || trade.filled === false) return trade;
    const planned =
      opts?.planned != null ? opts.planned : isPlannedTrade(trade);
    const r = rMultiple(trade);
    const pnl = pnlUsd(trade);
    const base = {
      ...trade,
      planned,
      reconciled: trade.reconciled !== false,
      r_multiple: r != null ? round4(r) : null,
      pnl_usd: pnl != null ? round2(pnl) : null,
      plan_r: trade.plan_r != null ? trade.plan_r : r != null ? round4(r) : null,
      execution_channel: trade.execution_channel || opts?.execution_channel || "platform",
    };
    return applyDualTrack(base, opts);
  }

  function fmtDualTrack(trade) {
    const pr = planR(trade);
    const rr = realizedR(trade);
    const status = reconcileStatus(trade);
    if (pr == null && rr == null) return "";
    const fmt = (v) => (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "R";
    if (rr == null || status === "delta") {
      return "Plan " + fmt(pr) + (rr != null ? " · Realized " + fmt(rr) : "") + " · Δ";
    }
    return "Plan " + fmt(pr) + " · Realized " + fmt(rr);
  }

  function sessionStats(trades, sessionId, opts) {
    if (!sessionId) return null;
    const onlyPlanned = opts?.onlyPlanned !== false;
    let closed = trades.filter(
      (t) =>
        t.session_id === sessionId &&
        t.status === "closed" &&
        t.filled !== false
    );
    if (onlyPlanned) closed = closed.filter(isPlannedTrade);
    if (!closed.length) return null;

    const rs = closed.map((t) => planR(t) ?? rMultiple(t)).filter((r) => r != null);
    let wins = 0;
    for (const t of closed) {
      const entry = t.entry_price ?? t.entry_premium;
      const exit = t.exit_price;
      if (entry != null && exit != null && exit > entry) wins++;
    }
    const avgR = rs.length
      ? rs.reduce((a, b) => a + b, 0) / rs.length
      : null;
    const totalR = rs.length ? rs.reduce((a, b) => a + b, 0) : null;
    const totalPnl = closed.reduce((s, t) => s + (pnlUsd(t) || 0), 0);
    const deltaCount = closed.filter((t) => reconcileStatus(t) === "delta").length;

    return {
      trades: closed.length,
      wins,
      pct: Math.round((wins / closed.length) * 100),
      avgR: avgR != null ? round2(avgR) : null,
      totalR: totalR != null ? round2(totalR) : null,
      totalPnl: round2(totalPnl),
      plannedCount: closed.filter(isPlannedTrade).length,
      reconcileDelta: deltaCount,
    };
  }

  function fmtExpectancy(stats) {
    if (!stats) return "";
    if (stats.avgR != null) {
      const sign = stats.avgR >= 0 ? "+" : "";
      let s =
        sign + stats.avgR.toFixed(2) + "R avg (" + stats.trades + " planned)";
      if (stats.reconcileDelta) s += " · " + stats.reconcileDelta + " Δ reconcile";
      return s;
    }
    return stats.pct + "% hit (" + stats.wins + "/" + stats.trades + ")";
  }

  function fmtBadge(stats) {
    if (!stats) return "";
    if (stats.avgR != null) {
      const sign = stats.avgR >= 0 ? "+" : "";
      return (
        sign +
        stats.avgR.toFixed(2) +
        "R (" +
        stats.wins +
        "/" +
        stats.trades +
        ")"
      );
    }
    return stats.pct + "% (" + stats.wins + "/" + stats.trades + ")";
  }

  global.RMTradeMetrics = {
    isPlannedTrade,
    rMultiple,
    planR,
    realizedR,
    reconcileStatus,
    applyDualTrack,
    pnlUsd,
    enrichClosedTrade,
    fmtDualTrack,
    sessionStats,
    fmtExpectancy,
    fmtBadge,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- trade_story.js --- */
/**
 * Trade Story client — sync plan/entry/exit events to rm_api (Phase 1).
 * Falls back to localStorage mirror when API offline.
 */
(function (global) {
  const LS_KEY = "rainmaker_trade_stories_v1";

  function apiBase() {
    const meta = document.querySelector('meta[name="rainmaker-api-base"]');
    if (meta?.content) return meta.content.replace(/\/$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  function todayStoryId() {
    try {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    } catch (_) {
      return {};
    }
  }

  function saveLocal(all) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (_) {}
  }

  function getLocalStory(storyId) {
    return loadLocal()[storyId] || null;
  }

  function mirrorLocal(story) {
    if (!story?.story_id) return;
    const all = loadLocal();
    all[story.story_id] = story;
    saveLocal(all);
  }

  async function fetchJson(path, opts) {
    const base = apiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + path, {
        ...opts,
        headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
      });
      if (!res.ok) return null;
      return res.json();
    } catch (_) {
      return null;
    }
  }

  async function getStory(storyId) {
    const sid = storyId || todayStoryId();
    const remote = await fetchJson("/stories/" + encodeURIComponent(sid));
    if (remote?.story) {
      mirrorLocal(remote.story);
      return remote.story;
    }
    return getLocalStory(sid);
  }

  async function appendEvent(event, opts) {
    const sid = opts?.storyId || todayStoryId();
    const payload = {
      event: {
        ...event,
        at: event.at || new Date().toISOString(),
      },
    };
    if (opts?.story) payload.story = opts.story;

    const remote = await fetchJson("/stories/" + encodeURIComponent(sid) + "/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (remote?.story) {
      mirrorLocal(remote.story);
      document.dispatchEvent(
        new CustomEvent("rm:trade-story", { detail: { story: remote.story, event } })
      );
      return remote.story;
    }

    const local = getLocalStory(sid) || { story_id: sid, events: [] };
    local.events = [...(local.events || []), payload.event];
    if (event.type === "plan") {
      local.stage = "plan";
      local.symbol = event.symbol;
      local.plan_r = event.plan_r ?? local.plan_r;
    } else if (event.type === "exit") {
      local.stage = "close";
      local.plan_r = event.plan_r ?? local.plan_r;
      local.reconcile_status = event.reconcile_status || "delta";
    } else if (event.type === "import") {
      local.stage = "reconcile";
      local.realized_r = event.realized_r ?? local.realized_r;
      local.reconcile_status = event.reconcile_status || local.reconcile_status;
    } else if (event.type === "note") {
      local.stage = "reflect";
    } else if (event.type === "recommendation") {
      local.stage = local.stage || "manage";
    } else if (event.type === "plan_revision") {
      local.stage = "manage";
      if (event.plan_r != null) local.plan_r = event.plan_r;
    } else if (event.type === "entry") {
      local.stage = "manage";
    }
    mirrorLocal(local);
    document.dispatchEvent(
      new CustomEvent("rm:trade-story", { detail: { story: local, event, offline: true } })
    );
    return local;
  }

  function planRFromLevels(entry, stop, target) {
    if (entry == null || stop == null || target == null) return null;
    const risk = entry - stop;
    if (!Number.isFinite(risk) || risk <= 0) return null;
    return Math.round(((target - entry) / risk) * 10000) / 10000;
  }

  async function syncPlan(plan, opts) {
    if (!plan?.symbol || plan.entry == null) return null;
    const pr =
      opts?.plan_r ??
      (typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.planR?.({
            entry_price: plan.entry,
            stop_price: plan.stop,
            target_price: plan.target,
            status: "open",
          })
        : planRFromLevels(plan.entry, plan.stop, plan.target));
    return appendEvent(
      {
        type: "plan",
        symbol: String(plan.symbol).toUpperCase(),
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        qty: plan.qty,
        signal_source: opts?.signal_source || plan.signal_source || "orh",
        plan_r: pr,
        thesis: opts?.thesis || null,
      },
      { storyId: opts?.storyId }
    );
  }

  async function syncEntry(trade, opts) {
    if (!trade?.symbol) return null;
    return appendEvent(
      {
        type: "entry",
        symbol: trade.symbol,
        price: trade.entry_price,
        qty: trade.quantity,
        execution_channel: trade.execution_channel || "platform",
      },
      { storyId: opts?.storyId }
    );
  }

  async function syncExit(trade, opts) {
    if (!trade?.symbol) return null;
    let planR = trade.plan_r;
    if (planR == null && typeof global.RMTradeMetrics !== "undefined") {
      planR = global.RMTradeMetrics.planR(trade);
    }
    return appendEvent(
      {
        type: "exit",
        symbol: trade.symbol,
        exit_price: trade.exit_price,
        plan_r: planR,
        realized_r: trade.realized_r ?? null,
        reconcile_status: trade.reconcile_status || "delta",
        execution_channel: trade.execution_channel || "platform",
        filled: trade.filled !== false,
      },
      {
        storyId: opts?.storyId,
        story: {
          plan_r: planR,
          reconcile_status: trade.reconcile_status || "delta",
        },
      }
    );
  }

  async function syncReconcile(trade, opts) {
    if (!trade?.symbol) return null;
    const realized = trade.realized_r ?? trade.r_multiple;
    const status =
      typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.reconcileStatus(trade)
        : trade.reconcile_status || "agreed";
    return appendEvent(
      {
        type: "import",
        symbol: trade.symbol,
        realized_r: realized,
        reconcile_status: status,
        source: opts?.source || "schwab",
      },
      {
        storyId: opts?.storyId,
        story: { realized_r: realized, reconcile_status: status, stage: "reconcile" },
      }
    );
  }

  async function syncPlanRevision(plan, opts) {
    if (!plan?.symbol) return null;
    const pr =
      opts?.plan_r ??
      (typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.planR?.({
            entry_price: plan.entry,
            stop_price: plan.stop,
            target_price: plan.target,
            status: "open",
          })
        : planRFromLevels(plan.entry, plan.stop, plan.target));
    return appendEvent(
      {
        type: "plan_revision",
        symbol: String(plan.symbol).toUpperCase(),
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        qty: plan.qty,
        plan_r: pr,
        reason: opts?.reason || "user_revision",
        prior_stop: opts?.prior_stop ?? null,
        prior_target: opts?.prior_target ?? null,
      },
      { storyId: opts?.storyId, story: { plan_r: pr, stage: "manage" } }
    );
  }

  async function syncRecommendation(rec, opts) {
    if (!rec?.symbol || !rec?.type) return null;
    return appendEvent(
      {
        type: "recommendation",
        subtype: rec.type,
        symbol: rec.symbol,
        label: rec.label,
        reason: rec.reason,
        confidence: rec.confidence,
        action: opts?.action || "shown",
      },
      { storyId: opts?.storyId }
    );
  }

  async function syncSchwabImport(payload, opts) {
    if (!payload) return null;
    const events = [];
    if (payload.entry && payload.symbol) {
      events.push(
        appendEvent(
          {
            type: "entry",
            symbol: payload.symbol,
            price: payload.entry.price,
            qty: payload.entry.qty,
            execution_channel: "schwab",
            source: "schwab_api",
          },
          { storyId: opts?.storyId }
        )
      );
    }
    if (payload.import) {
      events.push(
        appendEvent(
          {
            type: "import",
            symbol: payload.import.symbol,
            realized_r: payload.import.realized_r,
            reconcile_status: payload.import.reconcile_status || "agreed",
            source: "schwab",
            fill_ids: payload.import.fill_ids || [],
          },
          {
            storyId: opts?.storyId,
            story: {
              realized_r: payload.import.realized_r,
              reconcile_status: payload.import.reconcile_status,
              stage: "reconcile",
            },
          }
        )
      );
    }
    const results = await Promise.all(events);
    return results[results.length - 1] || null;
  }

  async function syncWhatHappened(debrief, opts) {
    if (!debrief?.symbol) return null;
    return appendEvent(
      {
        type: "note",
        subtype: "what_happened",
        trade_id: debrief.trade_id || null,
        symbol: debrief.symbol,
        tags: debrief.tags || [],
        summary: debrief.summary || "",
        learnings: debrief.learnings || [],
        snapshot: debrief.snapshot || {},
      },
      { storyId: opts?.storyId, story: { stage: "reflect" } }
    );
  }

  async function hydrateToday() {
    const story = await getStory(todayStoryId());
    if (story) {
      applyMarkersFromStory(story);
      document.dispatchEvent(
        new CustomEvent("rm:trade-story", { detail: { story, event: { type: "hydrate" } } })
      );
    }
    return story;
  }

  function applyMarkersFromStory(story) {
    if (!story?.events?.length || typeof global.RMAnalysisChart?.saveTradeMarker !== "function") {
      return 0;
    }
    let n = 0;
    for (const ev of story.events) {
      if (ev.type !== "chart_marker") continue;
      global.RMAnalysisChart.saveTradeMarker(
        {
          id: ev.marker_id || ev.id,
          symbol: ev.symbol,
          entry_price: ev.entry,
          exit_price: ev.exit ?? null,
          stop_price: ev.stop ?? null,
          target_price: ev.target ?? null,
          t: ev.t,
          exit_t: ev.exit_t ?? null,
          closed_at: ev.closed_at ?? null,
          label: ev.label ?? null,
          filled: ev.filled !== false,
        },
        { skipServerSync: true }
      );
      n++;
    }
    if (n && typeof global.RMAnalysisChart.refreshTradeOverlay === "function") {
      global.RMAnalysisChart.refreshTradeOverlay();
    }
    return n;
  }

  async function syncChartMarker(marker, opts) {
    if (!marker?.symbol) return null;
    return appendEvent(
      {
        type: "chart_marker",
        marker_id: marker.id,
        symbol: marker.symbol,
        entry: marker.entry,
        exit: marker.exit ?? null,
        stop: marker.stop ?? null,
        target: marker.target ?? null,
        t: marker.t,
        exit_t: marker.exit_t ?? null,
        closed_at: marker.closed_at ?? null,
        label: marker.label ?? null,
        filled: marker.filled !== false,
      },
      { storyId: opts?.storyId }
    );
  }

  global.RMTradeStory = {
    todayStoryId,
    apiBase,
    getStory,
    hydrateToday,
    appendEvent,
    syncPlan,
    syncEntry,
    syncExit,
    syncReconcile,
    syncPlanRevision,
    syncRecommendation,
    syncSchwabImport,
    syncWhatHappened,
    syncChartMarker,
    applyMarkersFromStory,
    getLocalStory,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- trade_recommendations.js --- */
/**
 * Rule-based trade recommendations v0  -  structured events for the learning loop.
 * No auto-execution; footer/chart surfaces accept / dismiss / revise.
 */
(function (global) {
  "use strict";

  const LS_DISMISSED = "rainmaker_rec_dismissed_v1";

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function loadDismissed() {
    try {
      return JSON.parse(localStorage.getItem(LS_DISMISSED) || "{}");
    } catch (_) {
      return {};
    }
  }

  function saveDismissed(all) {
    try {
      localStorage.setItem(LS_DISMISSED, JSON.stringify(all));
    } catch (_) {}
  }

  function dismissKey(symbol, type) {
    return String(symbol || "").toUpperCase() + "|" + type + "|" + new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }

  function isDismissed(symbol, type) {
    const all = loadDismissed();
    return !!all[dismissKey(symbol, type)];
  }

  function dismiss(symbol, type) {
    const all = loadDismissed();
    all[dismissKey(symbol, type)] = Date.now();
    saveDismissed(all);
  }

  function pctChange(entry, last) {
    if (entry == null || last == null || !entry) return null;
    return ((last - entry) / entry) * 100;
  }

  /**
   * @param {object} ctx  -  { symbol, entry, stop, target, lastPrice, orh, orl, qty, holding }
   * @returns {Array<{type,label,reason,confidence,priority}>}
   */
  function evaluate(ctx) {
    const sym = String(ctx?.symbol || "").toUpperCase();
    if (!sym) return [];
    const entry = ctx.entry ?? ctx.entry_price ?? ctx.holding?.entry_price;
    const stop = ctx.stop ?? ctx.stop_price;
    const target = ctx.target ?? ctx.target_price;
    const last = ctx.lastPrice ?? ctx.last ?? entry;
    const orh = ctx.orh;
    const orl = ctx.orl;
    const out = [];

    function push(type, label, reason, confidence, priority) {
      if (isDismissed(sym, type)) return;
      out.push({
        type,
        label,
        reason,
        confidence: confidence || "med",
        priority: priority || 50,
        symbol: sym,
      });
    }

    const chg = pctChange(entry, last);

    if (stop != null && last != null && last <= stop * 1.002) {
      push("cut_loss", "Cut loss", "Price at or below stop  -  honor risk plan.", "high", 90);
    } else if (stop != null && last != null && last <= stop * 1.015) {
      push("defensive", "Play defensive", "Within 1.5% of stop  -  tighten or reduce size.", "med", 70);
    }

    if (target != null && last != null && last >= target * 0.98) {
      push("take_profit", "Take profit", "At or near target  -  trim or move stop to breakeven.", "high", 85);
    }

    if (orh != null && last != null && last > orh && entry != null && last > entry) {
      push("trail_stop", "Trail stop", "Above ORH with profit  -  ratchet stop under structure.", "med", 75);
    }

    if (orl != null && last != null && last < orl && chg != null && chg > -3) {
      push("add_dip", "Buy the dip", "Pullback toward ORL while thesis intact  -  optional scale-in.", "low", 55);
    }

    if (chg != null && chg <= -5 && stop != null && last > stop) {
      push("defensive", "Reduce risk", "Down " + round2(Math.abs(chg)) + "%  -  consider trim before stop.", "med", 65);
    }

    if (ctx.holding?.instrument === "option" && chg != null && chg >= 25) {
      push("rollover", "Consider rollover", "Large option gain  -  roll or take premium off table.", "med", 60);
    }

    return out.sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 3);
  }

  async function logRecommendation(rec, action, opts) {
    if (typeof global.RMTradeStory === "undefined" || !rec?.type) return null;
    const event = {
      type: "recommendation",
      subtype: rec.type,
      symbol: rec.symbol,
      label: rec.label,
      reason: rec.reason,
      confidence: rec.confidence,
      action: action || "shown",
    };
    if (action === "dismiss") dismiss(rec.symbol, rec.type);
    if (action === "accept" && opts?.planRevision) {
      await global.RMTradeStory.syncPlanRevision(opts.planRevision, opts);
    }
    return global.RMTradeStory.appendEvent(event, opts);
  }

  function stripHtml(recs) {
    if (!recs?.length) return "";
    return (
      '<div class="tf-recs" role="list">' +
      recs
        .map(
          (r) =>
            '<div class="tf-rec" role="listitem" data-rec-type="' +
            r.type +
            '">' +
            '<span class="tf-rec-label">' +
            r.label +
            "</span>" +
            '<span class="tf-rec-reason meta">' +
            r.reason +
            "</span>" +
            '<span class="tf-rec-actions">' +
            '<button type="button" class="btn btn-sm tf-rec-accept" data-rec-type="' +
            r.type +
            '">Accept</button>' +
            '<button type="button" class="btn btn-sm btn-ghost tf-rec-dismiss" data-rec-type="' +
            r.type +
            '">Dismiss</button>' +
            "</span></div>"
        )
        .join("") +
      "</div>"
    );
  }

  global.RMTradeRecommendations = {
    evaluate,
    logRecommendation,
    dismiss,
    isDismissed,
    stripHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- workspace_load.js --- */
/** Staggered workspace boot — column + element loaders, top-to-bottom. */
(function (global) {
  const COLUMN_ORDER = ["market", "chart", "scans"];

  const COLS = {
    market: { id: "workspaceMarket", title: "Market map", index: 1 },
    chart: { id: "workspaceChart", title: "Unified chart", index: 2 },
    scans: { id: "workspaceScans", title: "Scan picks", index: 3 },
  };

  let booting = false;
  let activeColumn = null;
  let slotTotal = 0;
  let slotDone = 0;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function panel(key) {
    return document.getElementById(COLS[key]?.id);
  }

  function columnOrder() {
    return COLUMN_ORDER.slice();
  }

  function previousColumn(key) {
    const i = COLUMN_ORDER.indexOf(key);
    return i > 0 ? COLUMN_ORDER[i - 1] : null;
  }

  function mountColumnWaitLoader(key) {
    const el = panel(key);
    if (!el || el.classList.contains("ws-panel--ready") || el.classList.contains("ws-panel--active")) {
      return;
    }
    const body = el.querySelector(".ws-panel-body");
    if (!body) return;
    let loader = body.querySelector(".ws-col-loader");
    if (!loader) {
      loader = document.createElement("div");
      loader.className = "ws-col-loader";
      body.appendChild(loader);
    }
    const meta = COLS[key];
    const prev = previousColumn(key);
    const mobileLite = isMobilePerfLoader();
    loader.innerHTML = loaderShell({
      title: meta.title,
      step: mobileLite
        ? "Column " + meta.index + " — preparing…"
        : prev
          ? "Waiting for " + COLS[prev].title + "…"
          : "Queued…",
      kicker: "Column " + meta.index + " of 3",
      pct: mobileLite ? 4 : 0,
    });
  }

  function clearColumnWaitLoader(key) {
    panel(key)?.querySelector(".ws-col-loader")?.remove();
  }

  function scanProgressPanelHtml() {
    return (
      '<div class="ws-scan-progress scan-progress scan-progress--panel" aria-live="polite">' +
      '<p class="scan-progress-label ws-scan-progress-label">Starting scan…</p>' +
      '<div class="scan-progress-track ws-scan-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
      '<div class="scan-progress-fill ws-scan-progress-fill"></div></div>' +
      '<div class="scan-progress-segments ws-scan-progress-segments"></div></div>'
    );
  }

  function isMobilePerfLoader() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function loaderShell(opts) {
    const size = opts.size === "mini" ? "mini" : "column";
    if (isMobilePerfLoader() && size === "column") {
      const kicker = opts.kicker || "Rainmaker — initializing";
      const pct = opts.pct != null ? opts.pct : 8;
      return (
        '<div class="ws-load-shell ws-load-shell--mobile-lite" role="status" aria-live="polite" aria-busy="true">' +
        '<p class="ws-load-kicker">' +
        escapeHtml(kicker) +
        "</p>" +
        '<p class="ws-load-title">' +
        escapeHtml(opts.title || "Loading") +
        "</p>" +
        '<p class="ws-load-step">' +
        escapeHtml(opts.step || "Starting…") +
        "</p>" +
        '<div class="ws-load-track" aria-hidden="true"><span class="ws-load-track-fill" style="width:' +
        pct +
        '%"></span></div></div>'
      );
    }
    const cls = "ws-load-shell" + (size === "mini" ? " ws-load-shell--mini" : "");
    const kicker =
      opts.kicker ||
      (size === "mini" ? "Loading" : "Rainmaker — initializing");
    const showMeta = size === "column";
    const scanProgress = showMeta && opts.scanProgress;
    return (
      '<div class="' +
      cls +
      '" role="status" aria-live="polite" aria-busy="true">' +
      '<div class="ws-load-grid" aria-hidden="true"></div>' +
      '<div class="ws-load-orbit" aria-hidden="true"><span></span><span></span></div>' +
      '<div class="ws-load-scanline" aria-hidden="true"></div>' +
      (showMeta
        ? '<p class="ws-load-kicker">' + escapeHtml(kicker) + "</p>"
        : "") +
      '<p class="ws-load-title">' +
      escapeHtml(opts.title || "Loading") +
      "</p>" +
      '<p class="ws-load-step">' +
      escapeHtml(opts.step || "Starting…") +
      "</p>" +
      (scanProgress ? scanProgressPanelHtml() : "") +
      (showMeta
        ? '<div class="ws-load-track" aria-hidden="true"><span class="ws-load-track-fill" style="width:' +
          (opts.pct != null ? opts.pct : 8) +
          '%"></span></div>' +
          '<div class="ws-load-dots" aria-hidden="true"><span></span><span></span><span></span></div>'
        : "") +
      "</div>"
    );
  }

  function mountMiniLoader(el, label, step) {
    if (!el) return;
    el.classList.add("ws-load-slot", "ws-load-slot--loading");
    el.classList.remove("ws-load-slot--ready");
    el.innerHTML = loaderShell({
      size: "mini",
      title: label,
      step: step || "Loading…",
    });
  }

  function revealSlot(el) {
    if (!el) return;
    el.classList.remove("ws-load-slot--loading");
    el.classList.add("ws-load-slot--ready");
  }

  function ensureColumnLoader(body) {
    let loader = body.querySelector(":scope > .ws-col-loader");
    if (!loader) {
      loader = document.createElement("div");
      loader.className = "ws-col-loader";
      body.appendChild(loader);
    }
    return loader;
  }

  function updateColumnLoader(key, label, pct) {
    const el = panel(key);
    if (!el) return;
    const stepEl = el.querySelector(".ws-col-loader .ws-load-step");
    const fill = el.querySelector(".ws-col-loader .ws-load-track-fill");
    if (stepEl && label) stepEl.textContent = label;
    if (fill && pct != null) {
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }
  }

  function beginColumn(key) {
    activeColumn = key;
    if (key === "market") setMarketNavLoading(true);
    slotTotal = 0;
    slotDone = 0;
    const el = panel(key);
    if (!el) return;
    clearColumnWaitLoader(key);
    const meta = COLS[key];
    el.classList.remove("ws-panel--ready", "ws-panel--failed");
    el.classList.add("ws-panel--loading", "ws-panel--queued");
    const body = el.querySelector(".ws-panel-body");
    if (!body) return;

    body.querySelector(".ws-col-progress")?.remove();
    const loader = ensureColumnLoader(body);
    loader.innerHTML = loaderShell({
      title: meta.title,
      step: "Column " + meta.index + " — preparing…",
      kicker: "Column " + meta.index + " of 3",
      pct: 4,
    });
    loader.classList.remove("ws-col-loader--out");

    requestAnimationFrame(() => {
      el.classList.remove("ws-panel--queued");
      el.classList.add("ws-panel--active");
    });
  }

  function endColumn(key) {
    const el = panel(key);
    if (!el) return;
    if (key === "market") setMarketNavLoading(false);
    updateColumnLoader(key, "Ready", 100);
    const loader = el.querySelector(".ws-col-loader");
    if (loader) {
      loader.classList.add("ws-col-loader--out");
      setTimeout(() => loader.remove(), 420);
    }
    el.querySelector(".ws-col-progress")?.remove();
    el.classList.remove("ws-panel--loading", "ws-panel--active");
    el.classList.add("ws-panel--ready");
    activeColumn = null;
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.onColumnReady(key);
    }
  }

  function failColumn(key, msg) {
    const el = panel(key);
    if (!el) return;
    if (key === "market") setMarketNavLoading(false);
    updateColumnLoader(key, msg || "Offline — refresh to retry", 100);
    el.classList.remove("ws-panel--loading", "ws-panel--active");
    el.classList.add("ws-panel--failed");
    setTimeout(() => {
      el.querySelector(".ws-col-loader")?.remove();
      el.querySelector(".ws-col-progress")?.remove();
    }, 1200);
    activeColumn = null;
  }

  function refreshMobileHeaderLayout() {
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.sync?.();
    }
    global.RMBrandLogo?.onHeaderLayout?.();
    global.RMHeaderMood?.refresh?.();
  }

  function setMarketNavLoading(on) {
    global.RMWorkspaceAccordion?.setRowNavLoading?.("market", on);
  }

  function init() {
    booting = true;
    setMarketNavLoading(true);
    const ws = document.getElementById("morningWorkspace");
    if (ws) ws.classList.add("morning-workspace--booting");
    COLUMN_ORDER.forEach((key, i) => {
      const el = panel(key);
      if (el) el.style.setProperty("--ws-boot-i", String(i));
    });
    const queueCols =
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
        ? COLUMN_ORDER.filter((k) => k !== "market")
        : COLUMN_ORDER;
    queueCols.forEach((key) => mountColumnWaitLoader(key));
    void fetchMorningBrief();
    void hydrateTradeStory();
    document.addEventListener("rm:auth-ready", function () {
      morningBrief = null;
      void fetchMorningBrief();
    });
    requestAnimationFrame(() => {
      global.RMHeaderBg?.setMediaTier?.("preload");
      global.RMHeaderMood?.pausePoll?.();
      refreshMobileHeaderLayout();
    });
  }

  async function hydrateTradeStory() {
    if (typeof global.RMTradeStory === "undefined") return null;
    try {
      return await global.RMTradeStory.hydrateToday();
    } catch (_) {
      return null;
    }
  }

  function finish() {
    booting = false;
    setMarketNavLoading(false);
    const ws = document.getElementById("morningWorkspace");
    if (ws) {
      ws.classList.remove("morning-workspace--booting");
      ws.classList.add("morning-workspace--ready");
    }
    COLUMN_ORDER.forEach((key) => {
      const el = panel(key);
      if (!el) return;
      if (el.classList.contains("ws-panel--ready")) {
        el.classList.remove("ws-panel--queued", "ws-panel--loading", "ws-panel--active");
      }
    });
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.sync?.();
    }
    requestAnimationFrame(() => refreshMobileHeaderLayout());
  }

  function pause(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function loadSlot(el, label, fn) {
    if (!el) return;
    slotTotal += 1;
    const pct = slotTotal > 1 ? (slotDone / slotTotal) * 100 : 8;
    if (activeColumn) {
      updateColumnLoader(activeColumn, label + "…", Math.max(8, pct));
    }
    mountMiniLoader(el, label);
    try {
      await fn(el);
    } finally {
      revealSlot(el);
    }
    slotDone += 1;
    if (activeColumn) {
      const donePct = (slotDone / Math.max(slotDone, slotTotal)) * 100;
      updateColumnLoader(activeColumn, label + " ?", donePct);
    }
  }

  async function runColumn(key, runner) {
    beginColumn(key);
    try {
      await runner((el, label, fn) => loadSlot(el, label, fn));
      endColumn(key);
    } catch (e) {
      failColumn(key, e?.message || "Load failed");
      throw e;
    }
  }

  function showPanelLoader(key, opts) {
    const el = panel(key);
    const body = el?.querySelector(".ws-panel-body");
    if (!body) return;
    body.querySelector(".ws-col-progress")?.remove();
    const loader = ensureColumnLoader(body);
    const meta = COLS[key] || {};
    const mobile = global.matchMedia("(max-width: 640px)").matches;
    loader.innerHTML = loaderShell({
      title: opts?.title || meta.title || "Loading",
      step: opts?.step || "Loading…",
      kicker: opts?.kicker || "Rainmaker scan",
      pct: opts?.pct != null ? opts.pct : 14,
      scanProgress: mobile && opts?.scanProgress !== false,
    });
    loader.classList.remove("ws-col-loader--out");
    el.classList.add("ws-panel--scan-loading");
  }

  function hidePanelLoader(key) {
    const el = panel(key);
    if (!el) return;
    const loader = el.querySelector(".ws-col-loader");
    if (loader) {
      loader.classList.add("ws-col-loader--out");
      setTimeout(() => loader.remove(), 420);
    }
    el.classList.remove("ws-panel--scan-loading");
  }

  function isBooting() {
    return booting;
  }

  let morningBrief = null;

  function resolveApiBase() {
    try {
      if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveApiBase) {
        return global.RMMorningApi.resolveApiBase();
      }
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content) return meta.content.trim().replace(/\/$/, "");
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (_) {}
    const h = global.location && global.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (global.RMAuthGate && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (_) {}
    return headers;
  }

  async function fetchResearchDigest() {
    const base = resolveApiBase();
    if (!base) return [];
    try {
      const res = await fetch(base + "/research/digest?limit=5", { headers: authHeaders() });
      if (!res.ok) return [];
      const data = await res.json();
      return data.research_digest || [];
    } catch (_) {
      return [];
    }
  }

  async function fetchMorningBrief() {
    if (morningBrief) return morningBrief;
    const apiBase =
      typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveApiBase
        ? global.RMMorningApi.resolveApiBase()
        : "";
    if (apiBase) {
      try {
        const res = await fetch(apiBase + "/research/morning-brief?v=" + Date.now(), {
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.brief && typeof data.brief === "object") {
            morningBrief = data.brief;
          }
        }
      } catch (_) {
        /* fall through to static file */
      }
    }
    if (!morningBrief) {
      try {
        const res = await fetch("/morning_brief.json?v=" + Date.now());
        if (res.ok) {
          morningBrief = await res.json();
        }
      } catch (_) {
        /* stub optional */
      }
    }
    if (!morningBrief) morningBrief = {};
    const digest = await fetchResearchDigest();
    if (digest.length) {
      morningBrief.research_digest = digest;
    }
    if (typeof global.RMColumnKPI !== "undefined") {
      global.RMColumnKPI.setMorningBriefLoaded(true);
    }
    document.dispatchEvent(new CustomEvent("rm:morning-brief", { detail: morningBrief }));
    if (morningBrief.war_plan && typeof global.RMAtlas !== "undefined") {
      void global.RMAtlas.onMorningBrief(morningBrief);
    }
    if (digest.length) {
      document.dispatchEvent(new CustomEvent("rm:research-digest", { detail: digest }));
    }
    return morningBrief;
  }

  function getMorningBrief() {
    return morningBrief;
  }

  global.RMWorkspaceLoad = {
    init,
    finish,
    pause,
    columnOrder,
    runColumn,
    loadSlot,
    mountMiniLoader,
    revealSlot,
    loaderShell,
    mountColumnWaitLoader,
    clearColumnWaitLoader,
    updateColumnLoader,
    showPanelLoader,
    hidePanelLoader,
    beginColumn,
    endColumn,
    failColumn,
    isBooting,
    fetchMorningBrief,
    getMorningBrief,
    hydrateTradeStory,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- workspace_accordion.js --- */
/** Workspace panels — mobile snap rows; tablet/desktop collapsible column headers. */
(function (global) {
  const ROWS = [
    { key: "market", id: "workspaceMarket", label: "Morning Pulse" },
    { key: "chart", id: "workspaceChart", label: "Shape of Data" },
    { key: "scans", id: "workspaceScans", label: "Target Trades" },
  ];
  const ROW_KEYS = ROWS.map((r) => r.key);
  const ROW_LABEL = Object.fromEntries(ROWS.map((r) => [r.key, r.label]));

  const MOBILE_MQ = global.matchMedia("(max-width: 640px)");
  // 641px (not 640) so the wide/tablet band never overlaps MOBILE_MQ at exactly
  // 640px — keeps JS snap behavior and the CSS tablet grid (min-width:641px) in sync.
  const WIDE_MQ = global.matchMedia("(min-width: 641px)");
  const DESKTOP_MQ = global.matchMedia("(min-width: 1280px)");

  const EDGE_SLACK = 6;
  const SWIPE_MIN = 32;
  const PULL_MIN = 18;
  const RESULTS_STRATEGY_PULL = 8;
  const RESULTS_STRATEGY_SWIPE = 20;
  const HEAD_IGNORE =
    ".ws-panel-menu, .ws-panel-head-actions, .fv-bias-mini-slot, .fv-bias-mini-tail, .fv-settings-popover, .tt-tabs, .tt-tab, button, a, input, select, label";

  const COL_MARKET_OPEN = "minmax(220px, 22%)";
  const COL_CHART_OPEN = "minmax(0, 1fr)";
  const COL_SCANS_OPEN = "minmax(260px, 26%)";
  const COL_COLLAPSED = "56px";
  const ROW_CHART_OPEN = "minmax(0, 1.12fr)";
  const ROW_BOTTOM_OPEN = "minmax(0, 1fr)";
  const SNAP_TRANSITION_MS = 220;

  let activeKey = "market";
  let previousKey = "market";
  let snapTransitionTimer = null;
  const collapsed = { market: false, chart: false, scans: false };
  let wired = false;
  let snapLock = false;
  let snapLockTimer = null;
  let bumpersWired = false;
  let rowNavWired = false;

  const ROW_NAV_IDS = {
    market: "btnRowNavMarket",
    chart: "btnRowNavChart",
    scans: "btnRowNavScans",
  };
  let scrollBurstWired = false;
  let scrollBurstLit = false;
  let scansTabListenersWired = false;
  let touchStartY = 0;
  let touchStartX = 0;
  let touchLastY = 0;
  let touchScrollTop0 = 0;
  let touchEdgePull = 0;
  let touchBodyEl = null;
  let resultsScrollEl = null;
  let scansTouchActive = false;
  let resultsHandoffTimer = null;
  let mobileTouchWired = false;
  let activeScroller = null;

  function workspace() {
    return document.getElementById("morningWorkspace");
  }

  function siteHeader() {
    return document.getElementById("siteHeader");
  }

  function panelEl(key) {
    const row = ROWS.find((r) => r.key === key);
    return row ? document.getElementById(row.id) : null;
  }

  function activeBody() {
    return panelEl(activeKey)?.querySelector(".ws-panel-body") || null;
  }

  function scansActiveScroller() {
    if (activeScansTab() === "strategy") {
      return document.querySelector("#scansTabStrategy .tt-strategy-board");
    }
    return document.querySelector("#scansTabResults .tt-results-scroll");
  }

  function scrollTarget(body) {
    if (!body) return null;
    if (activeKey === "scans") {
      const scroller = scansActiveScroller();
      if (scroller) return scroller;
    }
    return body;
  }

  function touchScrollTarget() {
    if (activeKey === "scans") return scansActiveScroller();
    const body = activeBody();
    return touchBodyEl || scrollTarget(body);
  }

  function rowIndex(key) {
    return ROW_KEYS.indexOf(key);
  }

  let chartResizeNotifyTimer = null;

  function notifyChartResize() {
    clearTimeout(chartResizeNotifyTimer);
    chartResizeNotifyTimer = setTimeout(() => {
      chartResizeNotifyTimer = null;
      requestAnimationFrame(() => global.dispatchEvent(new Event("resize")));
    }, 150);
  }

  function lockSnap(ms) {
    snapLock = true;
    clearTimeout(snapLockTimer);
    snapLockTimer = setTimeout(() => {
      snapLock = false;
    }, ms || SNAP_TRANSITION_MS + 20);
  }

  function activeScansTab() {
    const strategy = document.getElementById("scansTabStrategy");
    const results = document.getElementById("scansTabResults");
    if (strategy && !strategy.hidden && !strategy.classList.contains("hidden")) {
      return "strategy";
    }
    if (results && !results.hidden && !results.classList.contains("hidden")) {
      return "results";
    }
    return "results";
  }

  function strategyBurstEligible() {
    return !!global._rmStrategyBurstEligible;
  }

  function trySwipeToStrategyTab(carryPx) {
    if (activeKey !== "scans" || activeScansTab() !== "results") return false;
    scrollBurstLit = false;
    const detail = { viaScrollDown: true, scrollCarryPx: carryPx || 0 };
    if (typeof global.__rmSetScansTab === "function") {
      global.__rmSetScansTab("strategy", detail);
    } else {
      global.dispatchEvent(new CustomEvent("rm:scans-swipe-strategy", { detail }));
    }
    activeScroller = document.querySelector("#scansTabStrategy .tt-strategy-board");
    touchScrollTop0 = 0;
    resetTouchEdge();
    requestAnimationFrame(() => bindBodyTouch());
    return true;
  }

  function trySwipeToResultsTab(carryPx) {
    if (activeKey !== "scans" || activeScansTab() !== "strategy") return false;
    scrollBurstLit = false;
    global._rmStrategyBurstEligible = false;
    const detail = { viaScrollUp: true, scrollCarryPx: carryPx || 0 };
    if (typeof global.__rmSetScansTab === "function") {
      global.__rmSetScansTab("results", detail);
    } else {
      global.dispatchEvent(new CustomEvent("rm:scans-swipe-results", { detail }));
    }
    activeScroller = resultsScroller();
    touchScrollTop0 = activeScroller ? activeScroller.scrollTop : 0;
    resetTouchEdge();
    requestAnimationFrame(() => bindBodyTouch());
    return true;
  }

  function touchInActiveRow(e) {
    const panel = panelEl(activeKey);
    return !!(panel && e.target instanceof Element && panel.contains(e.target));
  }

  function resultsScroller() {
    return document.querySelector("#scansTabResults .tt-results-scroll");
  }

  function strategyScroller() {
    return document.querySelector("#scansTabStrategy .tt-strategy-board");
  }

  function resolveActiveScroller(el) {
    if (activeKey === "scans") {
      return activeScansTab() === "strategy" ? strategyScroller() : resultsScroller();
    }
    return scrollTarget(activeBody());
  }

  function resultsHandoffReady(target) {
    if (activeKey !== "scans" || activeScansTab() !== "results" || !target) return false;
    return scrollState(target).atBottom;
  }

  function shouldHandoffResultsToStrategy(target, dy) {
    if (!resultsHandoffReady(target)) return false;
    return dy < -10 || touchEdgePull <= -RESULTS_STRATEGY_PULL;
  }

  function strategyHandoffReady(target) {
    if (activeKey !== "scans" || activeScansTab() !== "strategy" || !target) return false;
    return scrollState(target).atTop;
  }

  function shouldHandoffStrategyToResults(target, dy) {
    if (!strategyHandoffReady(target)) return false;
    return dy > 10 || touchEdgePull >= RESULTS_STRATEGY_PULL;
  }

  function scrollState(body) {
    if (!body) return { atTop: true, atBottom: true, overflow: 0 };
    const overflow = Math.max(0, body.scrollHeight - body.clientHeight);
    return {
      atTop: body.scrollTop <= EDGE_SLACK,
      atBottom: body.scrollTop >= overflow - EDGE_SLACK,
      overflow,
    };
  }

  function resetTouchEdge() {
    touchEdgePull = 0;
  }

  function mayStepToStrategyTab(body, dy) {
    if (activeKey !== "scans" || activeScansTab() !== "results") return false;
    const s = scrollState(body);
    if (!body || !s.atBottom) return false;
    return dy < -RESULTS_STRATEGY_SWIPE || touchEdgePull <= -RESULTS_STRATEGY_PULL;
  }

  function mayStepNext(body, dy) {
    const s = scrollState(body);
    if (!body || !s.atBottom) return false;
    if (activeKey === "scans" && activeScansTab() === "results") {
      return mayStepToStrategyTab(body, dy);
    }
    if (s.overflow > EDGE_SLACK) {
      return dy < -SWIPE_MIN || touchEdgePull <= -PULL_MIN;
    }
    return dy < -SWIPE_MIN || touchEdgePull <= -PULL_MIN;
  }

  function mayStepToResultsTab(body, dy) {
    if (activeKey !== "scans" || activeScansTab() !== "strategy") return false;
    const s = scrollState(body);
    if (!body || !s.atTop) return false;
    return dy > RESULTS_STRATEGY_SWIPE || touchEdgePull >= RESULTS_STRATEGY_PULL;
  }

  function mayStepPrev(body, dy) {
    const s = scrollState(body);
    if (!body || !s.atTop) return false;
    if (activeKey === "scans" && activeScansTab() === "strategy") {
      return mayStepToResultsTab(body, dy);
    }
    if (s.overflow > EDGE_SLACK) {
      return dy > SWIPE_MIN || touchEdgePull >= PULL_MIN;
    }
    return dy > SWIPE_MIN || touchEdgePull >= PULL_MIN;
  }

  function headIgnoresClick(e) {
    return !!e.target.closest(HEAD_IGNORE);
  }

  function clearSnapTransitionAttrs() {
    delete document.body.dataset.snapFrom;
    delete document.body.dataset.snapTo;
  }

  function setSnapTransitionAttrs(fromKey, toKey) {
    document.body.dataset.snapFrom = fromKey;
    document.body.dataset.snapTo = toKey;
    document.body.classList.add("snap-bumper-transitioning");
    clearTimeout(snapTransitionTimer);
    snapTransitionTimer = setTimeout(() => {
      snapTransitionTimer = null;
      document.body.classList.remove("snap-bumper-transitioning");
      clearSnapTransitionAttrs();
      notifyChartResize();
    }, SNAP_TRANSITION_MS);
  }

  function snapChromeEl() {
    return document.getElementById("mobileSnapChrome");
  }

  function rowNavEl() {
    return document.getElementById("mobileRowNav");
  }

  function setRowNavLoading(row, on) {
    const id = ROW_NAV_IDS[row];
    if (!id) return;
    document.getElementById(id)?.classList.toggle("is-loading", !!on);
  }

  function playSniperLockAnimation() {
    const btn = document.getElementById(ROW_NAV_IDS.scans);
    if (!btn || !MOBILE_MQ.matches) return;
    btn.classList.remove("is-scope-locking");
    void btn.offsetWidth;
    btn.classList.add("is-scope-locking");
    const clear = () => btn.classList.remove("is-scope-locking");
    btn.addEventListener("animationend", clear, { once: true });
    setTimeout(clear, 950);
  }

  function updateRowNav() {
    const nav = rowNavEl();
    if (!nav) return;
    if (!MOBILE_MQ.matches) {
      nav.hidden = true;
      nav.setAttribute("aria-hidden", "true");
      ROW_KEYS.forEach((key) => {
        document.getElementById(ROW_NAV_IDS[key])?.classList.remove("is-active", "is-loading");
      });
      return;
    }
    nav.hidden = false;
    nav.setAttribute("aria-hidden", "false");
    ROW_KEYS.forEach((key) => {
      const btn = document.getElementById(ROW_NAV_IDS[key]);
      if (btn) btn.classList.toggle("is-active", key === activeKey);
    });
  }

  function wireRowNav() {
    if (rowNavWired) return;
    rowNavWired = true;
    const nav = rowNavEl();
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-row-nav]");
      if (!btn || !nav.contains(btn)) return;
      const key = btn.getAttribute("data-row-nav");
      if (!ROW_KEYS.includes(key)) return;
      e.preventDefault();
      if (btn.classList.contains("mobile-row-nav-btn--sniper")) {
        btn.classList.add("is-firing");
        setTimeout(() => btn.classList.remove("is-firing"), 150);
      }
      if (activeKey !== key) {
        lockSnap();
        setActiveRow(key, { smooth: true });
      }
    });
  }

  function rowLabel(key) {
    return ROW_LABEL[key] || key;
  }

  function updateSnapBumpers() {
    const chrome = snapChromeEl();
    const up = document.getElementById("btnSnapBumperUp");
    const down = document.getElementById("btnSnapBumperDown");
    if (!chrome || !up || !down) return;

    if (!MOBILE_MQ.matches) {
      chrome.hidden = true;
      chrome.setAttribute("aria-hidden", "true");
      up.hidden = true;
      down.hidden = true;
      updateRowNav();
      return;
    }

    const idx = rowIndex(activeKey);
    const showDown = idx >= 0 && idx < ROW_KEYS.length - 1;

    chrome.hidden = false;
    chrome.setAttribute("aria-hidden", "false");
    up.hidden = true;
    down.hidden = !showDown;
    updateRowNav();
    if (showDown) {
      const next = ROW_KEYS[idx + 1];
      down.setAttribute("aria-label", "Next: " + rowLabel(next));
      down.title = rowLabel(next);
    }
  }

  function onBumperActivate(e, delta) {
    e.preventDefault();
    e.stopPropagation();
    stepRow(delta);
  }

  function scrollEndBurstEl() {
    return document.getElementById("mobileScrollEndBurst");
  }

  function playScrollEndBurst() {
    const el = scrollEndBurstEl();
    if (!el || !MOBILE_MQ.matches || activeKey !== "scans") return;
    if (global.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    el.classList.remove("is-active");
    void el.offsetWidth;
    el.classList.add("is-active");

    if (typeof global.RMBuyBagFx !== "undefined") global.RMBuyBagFx.playCashier();

    clearTimeout(playScrollEndBurst._doneTimer);
    playScrollEndBurst._doneTimer = setTimeout(() => {
      el.classList.remove("is-active");
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
    }, 920);
  }

  function maybeScrollEndBurst(scroller) {
    if (!MOBILE_MQ.matches || activeKey !== "scans") return;
    if (scroller?.closest("#scansTabResults")) return;
    if (activeScansTab() !== "strategy" || !strategyBurstEligible()) return;
    if (!scroller?.closest("#scansTabStrategy")) return;
    const s = scrollState(scroller);
    if (!s.atBottom) {
      scrollBurstLit = false;
      return;
    }
    if (s.overflow < 32 || scrollBurstLit) return;
    scrollBurstLit = true;
    global._rmStrategyBurstEligible = false;
    playScrollEndBurst();
  }

  function onScrollBurstCheck(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!t.closest("#workspaceScans")) return;
    if (t.scrollHeight <= t.clientHeight + EDGE_SLACK) return;
    maybeScrollEndBurst(t);
  }

  function bindScrollBurst() {
    if (scrollBurstWired) return;
    scrollBurstWired = true;
    document.addEventListener("scroll", onScrollBurstCheck, { capture: true, passive: true });
  }

  function onScansTabShown() {
    if (!MOBILE_MQ.matches || activeKey !== "scans") return;
    scrollBurstLit = false;
    bindBodyTouch();
  }

  function bindScansTabListeners() {
    if (scansTabListenersWired) return;
    scansTabListenersWired = true;
    document.addEventListener("rm:results-tab-shown", onScansTabShown);
    document.addEventListener("rm:strategy-tab-shown", onScansTabShown);
    document.addEventListener("rm:results-closed-rendered", onScansTabShown);
    document.addEventListener("rm:results-content-updated", onScansTabShown);
    global.addEventListener("resize", () => {
      if (activeKey === "scans" && MOBILE_MQ.matches) bindBodyTouch();
    });
  }

  function resetScrollBurst() {
    scrollBurstLit = false;
    global._rmStrategyBurstEligible = false;
    const el = scrollEndBurstEl();
    if (!el) return;
    el.classList.remove("is-active");
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
  }

  function wireBumpers() {
    if (bumpersWired) return;
    bumpersWired = true;
    const up = document.getElementById("btnSnapBumperUp");
    const down = document.getElementById("btnSnapBumperDown");
    up?.addEventListener("click", (e) => onBumperActivate(e, -1));
    down?.addEventListener("click", (e) => onBumperActivate(e, 1));
  }

  function updateSnapChrome() {
    const hdr = siteHeader();
    if (!MOBILE_MQ.matches) {
      document.body.classList.remove(
        "is-mobile-snap-market",
        "is-mobile-snap-chart",
        "is-mobile-snap-scans",
        "snap-bumper-transitioning"
      );
      clearSnapTransitionAttrs();
      updateSnapBumpers();
      hdr?.classList.remove(
        "site-header--snap-compact",
        "site-header--snap-hidden",
        "site-header--snap-hero",
        "site-header--compact-visual",
        "site-header--snap-compact-fixed"
      );
      return;
    }

    document.body.classList.toggle("is-mobile-snap-market", activeKey === "market");
    document.body.classList.toggle("is-mobile-snap-chart", activeKey === "chart");
    document.body.classList.toggle("is-mobile-snap-scans", activeKey === "scans");
    if (typeof global.syncMobilePickChrome === "function") {
      global.syncMobilePickChrome();
    }
    if (activeKey === "chart" && typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.ensureMobileIndicatorDefaults?.();
    }
    if (activeKey !== "chart") {
      document
        .querySelector("#workspaceChart .ca-toolbar-wrap")
        ?.classList.remove("ca-toolbar-wrap--tools-open");
      document.getElementById("btnChartSettings")?.setAttribute("aria-expanded", "false");
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.collapseTradePlanOnChart) {
        RMAnalysisChart.collapseTradePlanOnChart();
        RMAnalysisChart.paint?.();
      }
    }
    hdr?.classList.remove(
      "site-header--snap-compact",
      "site-header--snap-hidden",
      "site-header--snap-hero",
      "site-header--compact-visual",
      "site-header--snap-compact-fixed"
    );
    hdr?.classList.add("site-header--snap-compact-fixed");
    global.RMBrandLogo?.onHeaderLayout?.();
    requestAnimationFrame(() => global.RMBrandLogo?.onHeaderLayout?.());
    updateSnapBumpers();
    if (activeKey !== "scans") resetScrollBurst();
  }

  function resetToMarket() {
    activeKey = "market";
  }

  function scrollBodiesToTop() {
    ROWS.forEach(({ key }) => {
      const body = panelEl(key)?.querySelector(".ws-panel-body");
      if (body) body.scrollTop = 0;
    });
    resetTouchEdge();
  }

  function pokeRowWarm(key) {
    if (!MOBILE_MQ.matches || key === "market") return;
    const el = panelEl(key);
    if (!el || el.classList.contains("ws-panel--ready")) return;
    if (typeof global.RMMobilePerf !== "undefined") {
      void global.RMMobilePerf.warmRow(key);
    }
  }

  function setActiveRow(key, opts) {
    const options = opts || {};
    if (!MOBILE_MQ.matches || !ROW_KEYS.includes(key)) return false;
    if (activeKey === key) return false;

    const fromKey = activeKey;
    previousKey = fromKey;
    activeKey = key;
    if (fromKey !== key) resetScrollBurst();
    setSnapTransitionAttrs(fromKey, key);
    updateSnapChrome();
    syncPanels();
    pokeRowWarm(key);
    global.dispatchEvent(new CustomEvent("rm:workspace-row", { detail: { key: activeKey } }));
    if (typeof global.syncBackgroundActivity === "function") global.syncBackgroundActivity();
    if (activeKey === "market" && typeof global.RMHeaderMood !== "undefined") {
      global.RMHeaderMood.refresh?.();
    }
    if (key === "scans") {
      playSniperLockAnimation();
    }

    requestAnimationFrame(() => {
      const body = activeBody();
      if (body && options.scrollTop !== false) {
        body.scrollTo({ top: 0, behavior: options.smooth ? "smooth" : "auto" });
      }
      resetTouchEdge();
      if (key === "chart" || key === "scans") notifyChartResize();
      updateSnapChrome();
    });

    return true;
  }

  function stepRow(delta) {
    if (snapLock || !MOBILE_MQ.matches) return false;
    const next = ROW_KEYS[rowIndex(activeKey) + delta];
    if (!next) return false;
    lockSnap();
    return setActiveRow(next, { smooth: true });
  }

  function onWheel(e) {
    if (!MOBILE_MQ.matches || snapLock) return;
    const target = resolveActiveScroller(e.target);
    if (!target || !target.contains(e.target)) return;

    const s = scrollState(target);
    if (e.deltaY > 0 && s.atBottom) {
      if (activeKey === "scans" && activeScansTab() === "results" && trySwipeToStrategyTab(24)) {
        e.preventDefault();
      } else if (stepRow(1)) e.preventDefault();
    } else if (e.deltaY < 0 && s.atTop) {
      if (activeKey === "scans" && activeScansTab() === "strategy" && trySwipeToResultsTab(24)) {
        e.preventDefault();
      } else if (stepRow(-1)) e.preventDefault();
    }
  }

  function onResultsScrollHandoff() {
    if (!scansTouchActive || activeKey !== "scans" || activeScansTab() !== "results") return;
    const el = resultsScrollEl || resultsScroller();
    if (!el || !resultsHandoffReady(el)) return;
    trySwipeToStrategyTab(Math.abs(touchEdgePull));
  }

  function wireResultsScrollHandoff(el) {
    if (!el || el === resultsScrollEl) return;
    if (resultsScrollEl) {
      resultsScrollEl.removeEventListener("scroll", onResultsScrollHandoff);
    }
    resultsScrollEl = el;
    el.addEventListener("scroll", onResultsScrollHandoff, { passive: true });
  }

  function unwireResultsScrollHandoff() {
    if (!resultsScrollEl) return;
    resultsScrollEl.removeEventListener("scroll", onResultsScrollHandoff);
    resultsScrollEl = null;
  }

  function onTouchStart(e) {
    if (!MOBILE_MQ.matches || e.touches.length !== 1) return;
    if (!touchInActiveRow(e)) return;
    scansTouchActive = activeKey === "scans";
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchLastY = touchStartY;
    activeScroller = resolveActiveScroller(e.target);
    touchScrollTop0 = activeScroller ? activeScroller.scrollTop : 0;
    resetTouchEdge();
  }

  function onTouchMove(e) {
    if (!MOBILE_MQ.matches || snapLock || e.touches.length !== 1) return;
    if (!touchInActiveRow(e)) return;
    const target = activeScroller || resolveActiveScroller(e.target);
    if (!target) return;

    const y = e.touches[0].clientY;
    const stepDy = y - touchLastY;
    touchLastY = y;

    const s = scrollState(target);
    if (activeKey === "scans" && activeScansTab() === "strategy") {
      maybeScrollEndBurst(target);
    }
    if (s.atBottom && stepDy < 0) {
      touchEdgePull += stepDy;
      if (activeKey === "scans" && activeScansTab() === "results" && resultsHandoffReady(target)) {
        if (trySwipeToStrategyTab(Math.abs(touchEdgePull))) {
          e.preventDefault();
          return;
        }
      }
      if (s.overflow <= EDGE_SLACK) e.preventDefault();
    } else if (s.atTop && stepDy > 0) {
      touchEdgePull += stepDy;
      if (activeKey === "scans" && activeScansTab() === "strategy" && strategyHandoffReady(target)) {
        if (trySwipeToResultsTab(touchEdgePull)) {
          e.preventDefault();
          return;
        }
      }
      if (s.overflow <= EDGE_SLACK) e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (!MOBILE_MQ.matches || snapLock || e.changedTouches.length !== 1) return;
    if (!touchInActiveRow(e)) return;

    const target = activeScroller || resolveActiveScroller(e.target);
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dx = e.changedTouches[0].clientX - touchStartX;

    if (Math.abs(dx) <= Math.abs(dy)) {
      if (activeKey === "scans" && activeScansTab() === "results" && shouldHandoffResultsToStrategy(target, dy)) {
        trySwipeToStrategyTab(Math.abs(touchEdgePull));
      } else if (activeKey === "scans" && activeScansTab() === "strategy" && shouldHandoffStrategyToResults(target, dy)) {
        trySwipeToResultsTab(Math.abs(touchEdgePull));
      } else if (mayStepNext(target, dy)) {
        if (activeKey === "scans" && activeScansTab() === "results") {
          trySwipeToStrategyTab(Math.abs(touchEdgePull));
        } else {
          stepRow(1);
        }
      } else if (mayStepPrev(target, dy)) {
        if (activeKey === "scans" && activeScansTab() === "strategy") {
          trySwipeToResultsTab(Math.abs(touchEdgePull));
        } else {
          stepRow(-1);
        }
      } else if (activeKey === "scans" && activeScansTab() === "results" && target && resultsHandoffReady(target)) {
        clearTimeout(resultsHandoffTimer);
        resultsHandoffTimer = setTimeout(() => {
          resultsHandoffTimer = null;
          const el = resultsScroller();
          if (resultsHandoffReady(el)) trySwipeToStrategyTab(0);
        }, 240);
      }
    }

    scansTouchActive = false;
    activeScroller = null;
    resetTouchEdge();
  }

  function bindMobileTouchChain() {
    if (mobileTouchWired) return;
    mobileTouchWired = true;
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  }

  function toggleWideCollapsed(key) {
    if (!ROW_KEYS.includes(key)) return;
    collapsed[key] = !collapsed[key];
    syncPanels();
    requestAnimationFrame(() => {
      notifyChartResize();
      if (key === "chart" && typeof RMAnalysisChart !== "undefined") {
        RMAnalysisChart.refresh?.(
          panelEl("chart")?.querySelector(".chart-hub-unified"),
          global.RMChartHub
        );
      }
    });
  }

  function onHeadActivate(e) {
    if (headIgnoresClick(e)) return;
    const panel = e.currentTarget.closest(".ws-panel");
    const key = panel?.dataset.wsCol;
    if (!key) return;

    if (MOBILE_MQ.matches) {
      return;
    }

    if (WIDE_MQ.matches) {
      toggleWideCollapsed(key);
    }
  }

  function onHeadKeydown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onHeadActivate(e);
  }

  function unbindBodyTouch() {
    unwireResultsScrollHandoff();
    touchBodyEl = null;
  }

  function bindBodyTouch() {
    unbindBodyTouch();
    if (!MOBILE_MQ.matches) return;
    if (activeKey === "scans" && activeScansTab() === "results") {
      const scrollEl = resultsScroller();
      if (scrollEl) wireResultsScrollHandoff(scrollEl);
    }
  }

  function unbindSnapInput() {
    document.removeEventListener("wheel", onWheel, { capture: true });
    unbindBodyTouch();
    resetTouchEdge();
    updateSnapChrome();
  }

  function bindSnapInput() {
    unbindSnapInput();
    if (!MOBILE_MQ.matches) return;
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    bindBodyTouch();
  }

  function clearPanelChrome(el) {
    if (!el) return;
    el.classList.remove("ws-panel--expanded", "ws-panel--collapsed", "ws-panel--snap-active");
    const head = el.querySelector(".ws-panel-head");
    if (!head) return;
    head.removeAttribute("aria-expanded");
    head.removeAttribute("role");
    head.removeAttribute("tabindex");
  }

  function wirePanelHeads(interactive) {
    ROWS.forEach(({ key }) => {
      const head = panelEl(key)?.querySelector(".ws-panel-head");
      if (!head) return;
      if (interactive) {
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");
      } else {
        head.removeAttribute("role");
        head.removeAttribute("tabindex");
      }
    });
  }

  function hasWideCollapse() {
    return collapsed.market || collapsed.chart || collapsed.scans;
  }

  function clearWideGridVars(ws) {
    ws.classList.remove("morning-workspace--wide-collapse-active");
    ws.dataset.wsMarket = "";
    ws.dataset.wsChart = "";
    ws.dataset.wsScans = "";
    ws.style.removeProperty("--ws-col-market");
    ws.style.removeProperty("--ws-col-chart");
    ws.style.removeProperty("--ws-col-scans");
    ws.style.removeProperty("--ws-row-chart");
    ws.style.removeProperty("--ws-row-bottom");
  }

  function updateWideGrid(ws) {
    if (!hasWideCollapse()) {
      clearWideGridVars(ws);
      return;
    }

    ws.classList.add("morning-workspace--wide-collapse-active");
    ws.dataset.wsMarket = collapsed.market ? "collapsed" : "expanded";
    ws.dataset.wsChart = collapsed.chart ? "collapsed" : "expanded";
    ws.dataset.wsScans = collapsed.scans ? "collapsed" : "expanded";

    if (DESKTOP_MQ.matches) {
      ws.style.setProperty("--ws-col-market", collapsed.market ? COL_COLLAPSED : COL_MARKET_OPEN);
      ws.style.setProperty("--ws-col-chart", collapsed.chart ? COL_COLLAPSED : COL_CHART_OPEN);
      ws.style.setProperty("--ws-col-scans", collapsed.scans ? COL_COLLAPSED : COL_SCANS_OPEN);
      ws.style.removeProperty("--ws-row-chart");
      ws.style.removeProperty("--ws-row-bottom");
      return;
    }

    ws.style.removeProperty("--ws-col-market");
    ws.style.removeProperty("--ws-col-chart");
    ws.style.removeProperty("--ws-col-scans");
    ws.style.setProperty("--ws-row-chart", collapsed.chart ? COL_COLLAPSED : ROW_CHART_OPEN);
    const bottomCollapsed = collapsed.market && collapsed.scans;
    const bottomOne = collapsed.market || collapsed.scans;
    ws.style.setProperty(
      "--ws-row-bottom",
      bottomCollapsed ? COL_COLLAPSED : bottomOne ? "minmax(0, 1.35fr)" : ROW_BOTTOM_OPEN
    );
  }

  function clearWideState(ws) {
    ws.classList.remove("morning-workspace--wide-accordion", "morning-workspace--wide-collapse-active");
    document.body.classList.remove("is-wide-ws-accordion");
    clearWideGridVars(ws);
  }

  function syncWidePanels(ws) {
    clearWideState(ws);
    ws.classList.add("morning-workspace--wide-accordion");
    document.body.classList.add("is-wide-ws-accordion");
    updateWideGrid(ws);
    wirePanelHeads(true);

    ROWS.forEach(({ key }) => {
      const el = panelEl(key);
      if (!el) return;
      const isCollapsed = !!collapsed[key];
      el.classList.toggle("ws-panel--collapsed", isCollapsed);
      el.classList.toggle("ws-panel--expanded", !isCollapsed);
      el.classList.toggle("ws-panel--snap-active", !isCollapsed);
      const head = el.querySelector(".ws-panel-head");
      if (head) head.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    });

    if (!collapsed.market && typeof global.RMMarket !== "undefined") {
      const picks = document.getElementById("marketPanel")?._rmPicks;
      global.RMMarket.syncMorningBiasMini(global.RMMarket.getLastMorningBias(), picks);
    }
    if (!collapsed.chart) notifyChartResize();
  }

  function syncMobilePanels(ws) {
    clearWideState(ws);
    ws.classList.add("morning-workspace--mobile-accordion", "morning-workspace--mobile-snap");
    ws.dataset.snapRow = activeKey;
    document.body.classList.add("is-mobile-ws-accordion");
    wirePanelHeads(true);

    ROWS.forEach(({ key }) => {
      const el = panelEl(key);
      if (!el) return;
      const isActive = key === activeKey;
      el.classList.toggle("ws-panel--expanded", isActive);
      el.classList.toggle("ws-panel--collapsed", !isActive);
      el.classList.toggle("ws-panel--snap-active", isActive);
      const head = el.querySelector(".ws-panel-head");
      if (head) head.setAttribute("aria-expanded", isActive ? "true" : "false");
    });

    bindSnapInput();
    updateSnapChrome();
    if (activeKey !== "market" && typeof global.RMMarket !== "undefined") {
      const picks = document.getElementById("marketPanel")?._rmPicks;
      global.RMMarket.syncMorningBiasMini(global.RMMarket.getLastMorningBias(), picks);
    }
    if (activeKey === "chart" || activeKey === "scans") notifyChartResize();
  }

  function syncPanels() {
    const ws = workspace();
    if (!ws) return;

    ws.classList.remove("morning-workspace--mobile-accordion", "morning-workspace--mobile-snap");
    ws.dataset.snapRow = "";
    document.body.classList.remove("is-mobile-ws-accordion");
    unbindSnapInput();

    if (MOBILE_MQ.matches) {
      ROWS.forEach(({ key }) => clearPanelChrome(panelEl(key)));
      syncMobilePanels(ws);
      return;
    }

    ROWS.forEach(({ key }) => clearPanelChrome(panelEl(key)));

    if (WIDE_MQ.matches) {
      syncWidePanels(ws);
      return;
    }

    clearWideState(ws);
    wirePanelHeads(false);
  }

  function expand(key) {
    if (!ROW_KEYS.includes(key)) return;
    if (MOBILE_MQ.matches) {
      lockSnap();
      setActiveRow(key, { smooth: true });
      return;
    }
    if (WIDE_MQ.matches && collapsed[key]) {
      collapsed[key] = false;
      syncPanels();
      notifyChartResize();
    }
  }

  function toggle(key) {
    if (!ROW_KEYS.includes(key)) return;
    if (MOBILE_MQ.matches) {
      if (key !== activeKey) {
        lockSnap();
        setActiveRow(key, { smooth: true });
      }
      return;
    }
    if (WIDE_MQ.matches) toggleWideCollapsed(key);
  }

  function onColumnReady(key) {
    if (MOBILE_MQ.matches) {
      if (key === "market") {
        resetToMarket();
        syncPanels();
        requestAnimationFrame(() => {
          scrollBodiesToTop();
          updateSnapChrome();
        });
        if (typeof global.RMMobilePerf !== "undefined") {
          global.RMMobilePerf.warmAfterMarket();
        }
        if (typeof global.RMHeaderMood !== "undefined") {
          global.RMHeaderMood.refresh?.();
        }
      } else if ((key === "chart" || key === "scans") && activeKey === key) {
        notifyChartResize();
      }
      return;
    }
    if (WIDE_MQ.matches && (key === "chart" || key === "scans") && !collapsed[key]) {
      notifyChartResize();
    }
  }

  function onMqChange() {
    if (MOBILE_MQ.matches) {
      if (!ROW_KEYS.includes(activeKey)) activeKey = "market";
    } else {
      resetToMarket();
    }
    syncPanels();
  }

  function wire() {
    if (wired) return;
    wired = true;
    ROWS.forEach(({ key }) => {
      const head = panelEl(key)?.querySelector(".ws-panel-head");
      if (!head) return;
      head.addEventListener("click", onHeadActivate);
      head.addEventListener("keydown", onHeadKeydown);
    });
    MOBILE_MQ.addEventListener("change", onMqChange);
    WIDE_MQ.addEventListener("change", onMqChange);
    DESKTOP_MQ.addEventListener("change", onMqChange);
    syncPanels();
  }

  function getActiveKey() {
    return MOBILE_MQ.matches ? activeKey : null;
  }

  function init() {
    wireBumpers();
    wireRowNav();
    bindScrollBurst();
    bindMobileTouchChain();
    bindScansTabListeners();
    wire();
  }

  global.RMWorkspaceAccordion = {
    init,
    expand,
    toggle,
    sync: syncPanels,
    onColumnReady,
    getActiveKey,
    setRowNavLoading,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- share_card.js --- */
/**
 * Share card - one-tap export of the morning verdict + key levels as a PNG.
 *
 * Pure client-side: snapshots the current Conviction Engine verdict, the Morning
 * Pulse bias, and either the active trade plan levels or an index snapshot, then
 * renders a 1080x1350 card on a canvas. Uses the Web Share API (file share) on
 * capable devices and falls back to a download. No backend required.
 */
(function (global) {
  const W = 1080;
  const H = 1350;
  const PAD = 84;
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  const C = {
    bg0: "#0a0f15",
    panel: "rgba(255,255,255,0.04)",
    panelBorder: "rgba(255,255,255,0.10)",
    text: "#e8edf4",
    muted: "#8896ad",
    faint: "#5d6b81",
    teal: "#4eb8c9",
    orange: "#e8954f",
    green: "#3dba7a",
    red: "#e2574e",
    core: "#e8edf4",
  };

  let logoImg = null;
  let logoTried = false;

  function preloadLogo() {
    if (logoTried) return logoImg;
    logoTried = true;
    try {
      const im = new Image();
      im.onload = () => {
        logoImg = im;
      };
      im.src = "assets/rainmaker-header.png?v=37";
    } catch (_) {
      /* ignore */
    }
    return logoImg;
  }

  /* ---------- data collection ---------- */

  function textOf(sel, root) {
    const el = (root || document).querySelector(sel);
    return el ? (el.textContent || "").trim() : "";
  }

  function readVerdict() {
    const kicker = textOf("#headerMoodCopy .hm-kicker") || "Undecided";
    const line =
      textOf("#headerMoodCopy .hm-line") ||
      "Mixed signals. The tape hasn't picked a side yet.";
    let heat = 0;
    try {
      const st = global.RMHeaderMood?.getState?.();
      if (st && Number.isFinite(st.heat)) heat = st.heat;
    } catch (_) {
      /* ignore */
    }
    return { kicker, line, heat };
  }

  function readBias() {
    try {
      return global.RMMarket?.currentBiasSnapshot?.() || null;
    } catch (_) {
      return null;
    }
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function readIndices() {
    const out = [];
    const want = ["SPY", "QQQ", "VIX"];
    let cached = null;
    try {
      cached = global.RMMarket?.getCachedIndices?.() || null;
    } catch (_) {
      cached = null;
    }
    if (cached) {
      for (const sym of want) {
        const q = cached[sym] || cached["^" + sym] || cached[sym.replace("^", "")];
        const price = num(q?.price);
        if (price == null) continue;
        out.push({ sym, price, chg: num(q?.chg ?? q?.pct_change) });
      }
    }
    if (out.length) return out;
    // Fallback: scrape the rendered index strip so the card matches what's on screen.
    try {
      document.querySelectorAll(".fv-index").forEach((cell) => {
        const sym = (cell.querySelector(".fv-sym")?.textContent || "")
          .replace(/[^A-Za-z^]/g, "")
          .toUpperCase();
        if (!sym || !want.includes(sym.replace("^", ""))) return;
        const price = num((cell.querySelector(".fv-val")?.textContent || "").replace(/[^0-9.\-]/g, ""));
        const chg = num((cell.querySelector(".fv-chg")?.textContent || "").replace(/[^0-9.\-]/g, ""));
        if (price == null) return;
        out.push({ sym: sym.replace("^", ""), price, chg });
      });
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  function readPlan() {
    try {
      const p = global.RMAnalysisChart?.state?.tradePlan;
      if (!p || p.entry == null || p.stop == null) return null;
      return {
        symbol: String(p.symbol || "").toUpperCase(),
        entry: num(p.entry),
        stop: num(p.stop),
        target1: num(p.target1 ?? p.target),
        target2: num(p.target2),
        rr: num(p.rr),
      };
    } catch (_) {
      return null;
    }
  }

  function fmtDate(d) {
    try {
      return d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (_) {
      return "";
    }
  }

  function collectData() {
    const now = new Date();
    return {
      date: fmtDate(now),
      verdict: readVerdict(),
      bias: readBias(),
      indices: readIndices(),
      plan: readPlan(),
      logo: logoImg && logoImg.complete ? logoImg : null,
    };
  }

  /* ---------- drawing ---------- */

  function leanColor(heat) {
    if (heat > 0) return C.teal;
    if (heat < 0) return C.orange;
    return C.muted;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
    const words = String(text).split(/\s+/);
    let line = "";
    let lines = 0;
    for (let i = 0; i < words.length; i++) {
      const test = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, y);
        line = words[i];
        y += lineH;
        lines++;
        if (maxLines && lines >= maxLines - 1) {
          // last allowed line: dump remainder (trimmed)
          let rest = words.slice(i).join(" ");
          while (rest && ctx.measureText(rest + "\u2026").width > maxW) {
            rest = rest.slice(0, -1);
          }
          ctx.fillText(rest + (rest ? "\u2026" : ""), x, y);
          return y + lineH;
        }
      } else {
        line = test;
      }
    }
    if (line) {
      ctx.fillText(line, x, y);
      y += lineH;
    }
    return y;
  }

  function drawGauge(ctx, x, y, heat) {
    const slots = [-3, -2, -1, 0, 1, 2, 3];
    const gap = 26;
    const r = 11;
    let cx = x;
    for (const slot of slots) {
      const isCore = slot === 0;
      const on =
        isCore
          ? heat === 0
          : (heat > 0 && slot > 0 && slot <= heat) ||
            (heat < 0 && slot < 0 && slot >= heat);
      let col;
      if (isCore) col = on ? C.core : C.faint;
      else if (slot < 0) col = on ? C.orange : C.faint;
      else col = on ? C.teal : C.faint;
      const rad = isCore ? r + 2 : r;
      ctx.beginPath();
      ctx.arc(cx, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = on ? 1 : 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
      cx += rad * 2 + gap;
    }
  }

  function fmtPrice(n) {
    if (n == null) return "\u2014";
    return n >= 100 ? n.toFixed(2) : n.toFixed(2);
  }

  function fmtPct(n) {
    if (n == null) return "";
    const s = n >= 0 ? "+" : "";
    return s + n.toFixed(2) + "%";
  }

  function drawLevelChip(ctx, x, y, w, h, label, value, accent) {
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fill();
    ctx.strokeStyle = C.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText(label, x + 24, y + 30);
    ctx.fillStyle = accent || C.text;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillText(value, x + 24, y + 62);
  }

  function renderToCanvas(data, canvas) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const heat = data?.verdict?.heat || 0;
    const accent = leanColor(heat);

    // Background: dark base with a soft mood-tinted glow from the top.
    ctx.fillStyle = C.bg0;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, 120, 60, W / 2, 120, W);
    const tint =
      heat > 0
        ? "rgba(78,184,201,0.28)"
        : heat < 0
          ? "rgba(232,149,79,0.26)"
          : "rgba(120,140,170,0.18)";
    glow.addColorStop(0, tint);
    glow.addColorStop(1, "rgba(10,15,21,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // accent top rule
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 8);

    let y = PAD + 12;

    // Brand row
    const logo = data?.logo;
    let brandX = PAD;
    if (logo) {
      try {
        ctx.drawImage(logo, PAD, y - 4, 92, 92);
        brandX = PAD + 112;
      } catch (_) {
        brandX = PAD;
      }
    } else {
      ctx.beginPath();
      ctx.arc(PAD + 38, y + 42, 42, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.font = `800 44px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText("R", PAD + 38, y + 58);
      brandX = PAD + 112;
    }
    ctx.textAlign = "left";
    ctx.fillStyle = C.text;
    ctx.font = `800 46px ${FONT}`;
    ctx.fillText("RAINMAKER", brandX, y + 40);
    ctx.fillStyle = C.muted;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText("MORNING VERDICT", brandX, y + 76);
    // date (right)
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = `500 28px ${FONT}`;
    ctx.fillText(data?.date || "", W - PAD, y + 40);
    ctx.textAlign = "left";

    y += 200;

    // Verdict kicker (hero)
    const kicker = (data?.verdict?.kicker || "Undecided").toUpperCase();
    let kSize = 96;
    ctx.font = `800 ${kSize}px ${FONT}`;
    while (ctx.measureText(kicker).width > W - PAD * 2 && kSize > 52) {
      kSize -= 4;
      ctx.font = `800 ${kSize}px ${FONT}`;
    }
    ctx.fillStyle = accent;
    ctx.fillText(kicker, PAD, y);

    y += 56;
    drawGauge(ctx, PAD + 14, y, heat);

    y += 70;
    ctx.fillStyle = C.text;
    ctx.font = `400 40px ${FONT}`;
    y = wrapText(ctx, data?.verdict?.line || "", PAD, y, W - PAD * 2, 56, 3);

    // Divider
    y += 24;
    ctx.strokeStyle = C.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    y += 56;

    // Bias line
    const bias = data?.bias;
    if (bias && (bias.marketLabel || bias.lean)) {
      const leanWord =
        bias.lean > 0 ? "BULLISH LEAN" : bias.lean < 0 ? "BEARISH LEAN" : "NEUTRAL";
      ctx.font = `700 32px ${FONT}`;
      ctx.fillStyle = bias.lean > 0 ? C.teal : bias.lean < 0 ? C.orange : C.muted;
      ctx.fillText(leanWord, PAD, y);
      const lw = ctx.measureText(leanWord).width;
      const conf =
        (bias.marketConf ? String(bias.marketConf).toUpperCase() + " CONF" : "") +
        (bias.marketPct != null
          ? (bias.marketConf ? "  " : "") + Math.round(Math.abs(bias.marketPct)) + "%"
          : "");
      if (conf) {
        ctx.fillStyle = C.muted;
        ctx.font = `500 30px ${FONT}`;
        ctx.fillText("\u00b7  " + conf, PAD + lw + 22, y);
      }
      y += 64;
    }

    // Levels panel
    const plan = data?.plan;
    const panelX = PAD;
    const panelW = W - PAD * 2;
    if (plan && plan.symbol) {
      const panelH = 300;
      roundRect(ctx, panelX, y, panelW, panelH, 22);
      ctx.fillStyle = C.panel;
      ctx.fill();
      ctx.strokeStyle = C.panelBorder;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText("SETUP", panelX + 32, y + 48);
      ctx.fillStyle = C.text;
      ctx.font = `800 56px ${FONT}`;
      ctx.fillText(plan.symbol, panelX + 32, y + 104);
      if (plan.rr != null) {
        ctx.textAlign = "right";
        ctx.fillStyle = accent;
        ctx.font = `700 34px ${FONT}`;
        ctx.fillText(plan.rr.toFixed(1) + "R", panelX + panelW - 32, y + 96);
        ctx.textAlign = "left";
      }
      const gx = panelX + 24;
      const gy = y + 132;
      const cw = (panelW - 48 - 20) / 2;
      const rowH = 72;
      const rowGap = 14;
      drawLevelChip(ctx, gx, gy, cw, rowH, "ENTRY", "$" + fmtPrice(plan.entry), C.text);
      drawLevelChip(ctx, gx + cw + 20, gy, cw, rowH, "STOP", "$" + fmtPrice(plan.stop), C.red);
      drawLevelChip(ctx, gx, gy + rowH + rowGap, cw, rowH, "TARGET 1", "$" + fmtPrice(plan.target1), C.green);
      drawLevelChip(
        ctx,
        gx + cw + 20,
        gy + rowH + rowGap,
        cw,
        rowH,
        "TARGET 2",
        plan.target2 != null ? "$" + fmtPrice(plan.target2) : "\u2014",
        C.green
      );
      y += panelH;
    } else {
      const idx = data?.indices || [];
      if (idx.length) {
        const panelH = 180;
        roundRect(ctx, panelX, y, panelW, panelH, 22);
        ctx.fillStyle = C.panel;
        ctx.fill();
        ctx.strokeStyle = C.panelBorder;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const cols = idx.length;
        const cw = panelW / cols;
        idx.forEach((q, i) => {
          const cxp = panelX + cw * i + cw / 2;
          ctx.textAlign = "center";
          ctx.fillStyle = C.muted;
          ctx.font = `700 28px ${FONT}`;
          ctx.fillText(q.sym, cxp, y + 56);
          ctx.fillStyle = C.text;
          ctx.font = `700 52px ${FONT}`;
          ctx.fillText(fmtPrice(q.price), cxp, y + 110);
          if (q.chg != null) {
            ctx.fillStyle = q.chg >= 0 ? C.green : C.red;
            ctx.font = `600 30px ${FONT}`;
            ctx.fillText(fmtPct(q.chg), cxp, y + 150);
          }
          if (i > 0) {
            ctx.strokeStyle = C.panelBorder;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(panelX + cw * i, y + 36);
            ctx.lineTo(panelX + cw * i, y + panelH - 36);
            ctx.stroke();
          }
        });
        ctx.textAlign = "left";
        y += panelH;
      }
    }

    // Footer
    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    ctx.font = `600 28px ${FONT}`;
    ctx.fillText("Your morning verdict, one tap.", PAD, H - PAD - 6);
    ctx.textAlign = "right";
    ctx.fillStyle = C.faint;
    ctx.font = `500 26px ${FONT}`;
    ctx.fillText("rainmaker-morning", W - PAD, H - PAD - 6);
    ctx.textAlign = "left";

    return canvas;
  }

  function buildCanvas() {
    const canvas = document.createElement("canvas");
    return renderToCanvas(collectData(), canvas);
  }

  function toBlob() {
    return new Promise((resolve) => {
      try {
        buildCanvas().toBlob((b) => resolve(b), "image/png");
      } catch (_) {
        resolve(null);
      }
    });
  }

  /* ---------- preview overlay + share ---------- */

  function fileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `rainmaker-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.png`;
  }

  async function shareBlob(blob) {
    if (!blob) return false;
    try {
      const file = new File([blob], fileName(), { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        await navigator.share({
          files: [file],
          title: "Rainmaker Morning",
          text: "My morning verdict from Rainmaker.",
        });
        return true;
      }
    } catch (_) {
      /* user cancelled or unsupported - fall through to download */
    }
    return false;
  }

  function downloadBlob(blob) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function apiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content) return meta.content.replace(/\/$/, "");
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) return stored.replace(/\/$/, "");
    } catch (_) {}
    return "";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      try {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      } catch (_) {
        resolve(null);
      }
    });
  }

  // Text the card to the owner's phone via the backend MMS endpoint. The server
  // hosts the PNG and hands Twilio a public URL; no posting happens client-side.
  function alertPhone() {
    try {
      if (global.RMGrowth?.alertPhone) return global.RMGrowth.alertPhone();
      if (global.RMGrowth?.getAutomations) {
        return global.RMGrowth.getAutomations().phone || "";
      }
    } catch (_) {}
    return "";
  }

  function smsFailLabel(res) {
    if (res.data?.reason === "no_recipient") return "Add phone in Account";
    if (global.RMGrowth?.formatSmsError && res.data) {
      const msg = global.RMGrowth.formatSmsError(res.data, res.reason);
      return msg.length > 42 ? msg.slice(0, 40) + "…" : msg;
    }
    return res.data?.detail || res.data?.reason || res.reason || "Couldn't send";
  }

  async function textCard(blob) {
    const base = apiBase();
    if (!base) return { ok: false, reason: "no_api_base" };
    const image = await blobToDataUrl(blob);
    if (!image) return { ok: false, reason: "encode_failed" };
    const phone = alertPhone();
    try {
      const headers = { "Content-Type": "application/json" };
      if (typeof global.RMAuthGate !== "undefined") {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
      const res = await fetch(base + "/share/text", {
        method: "POST",
        headers,
        body: JSON.stringify({
          image,
          body: "My morning verdict from Rainmaker.",
          to: phone || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          data,
          reason: data.detail || "http_" + res.status,
        };
      }
      return { ok: !!data.sent, data };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  function closeOverlay() {
    const ov = document.getElementById("shareCardOverlay");
    if (ov) ov.remove();
  }

  async function open() {
    preloadLogo();
    const blob = await toBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    closeOverlay();

    const ov = document.createElement("div");
    ov.id = "shareCardOverlay";
    ov.className = "share-card-overlay";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Share your morning verdict");

    const canShareFiles = (() => {
      try {
        const f = new File([blob], fileName(), { type: "image/png" });
        return !!(navigator.canShare && navigator.canShare({ files: [f] }) && navigator.share);
      } catch (_) {
        return false;
      }
    })();

    ov.innerHTML =
      '<div class="share-card-modal">' +
      '<button type="button" class="share-card-close" id="shareCardClose" aria-label="Close">&times;</button>' +
      '<img class="share-card-img" id="shareCardImg" alt="Morning verdict card preview">' +
      '<div class="share-card-actions">' +
      (canShareFiles
        ? '<button type="button" class="share-card-btn share-card-btn--primary" id="shareCardShare">Share</button>'
        : "") +
      '<button type="button" class="share-card-btn" id="shareCardDownload">Download</button>' +
      (apiBase()
        ? '<button type="button" class="share-card-btn" id="shareCardText">Text it to me</button>'
        : "") +
      "</div></div>";

    document.body.appendChild(ov);
    ov.querySelector("#shareCardImg").src = url;

    const cleanup = () => {
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      closeOverlay();
    };
    ov.addEventListener("click", (e) => {
      if (e.target === ov) cleanup();
    });
    ov.querySelector("#shareCardClose").addEventListener("click", cleanup);
    ov.querySelector("#shareCardDownload").addEventListener("click", () => {
      downloadBlob(blob);
    });
    const shareBtn = ov.querySelector("#shareCardShare");
    if (shareBtn) {
      shareBtn.addEventListener("click", async () => {
        const ok = await shareBlob(blob);
        if (ok) cleanup();
      });
    }
    const textBtn = ov.querySelector("#shareCardText");
    if (textBtn) {
      textBtn.addEventListener("click", async () => {
        const prev = textBtn.textContent;
        textBtn.disabled = true;
        textBtn.textContent = "Sending…";
        const res = await textCard(blob);
        if (res.ok) {
          textBtn.textContent = res.data?.mms
            ? "Sent ✓"
            : res.data?.mmsFallback
              ? "Sent (link)"
              : "Sent (text)";
        } else {
          textBtn.textContent = smsFailLabel(res);
          textBtn.title = global.RMGrowth?.formatSmsError
            ? global.RMGrowth.formatSmsError(res.data || {}, res.reason)
            : smsFailLabel(res);
        }
        setTimeout(() => {
          textBtn.disabled = false;
          textBtn.textContent = prev;
        }, 2200);
      });
    }
  }

  function bindButton(btn) {
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
  }

  function bind() {
    preloadLogo();
    bindButton(document.getElementById("btnShareCard"));
    bindButton(document.getElementById("btnShareCardMobile"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  global.RMShareCard = {
    collectData,
    renderToCanvas,
    buildCanvas,
    toBlob,
    open,
    bind,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- morning_api.js --- */
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

;
/* --- growth.js --- */
/**
 * Growth & distribution client (Batch 4 - #10 / #6 / #11).
 *
 * - Loads Google Analytics (gtag) when a measurement ID is configured via the
 *   <meta name="rainmaker-ga-id"> tag (no-op when empty, so dev stays clean).
 * - Cookie/consent + email capture banner; emails beacon to rm_api
 *   /growth/email for retargeting audiences and the newsletter list.
 * - queueShareDraft(): pushes a social post into the server review queue
 *   (draft-only - no real autopost yet).
 */
(function (global) {
  const GA_META = "rainmaker-ga-id";
  const CONSENT_KEY = "rm_growth_consent_v1";
  const EMAIL_KEY = "rm_growth_email_v1";
  const AUTO_KEY = "rm_automations_v1";
  const NOTIF_KEY = "rm_notifications_v1";

  function metaContent(name) {
    const el = document.querySelector('meta[name="' + name + '"]');
    return el?.content?.trim() || "";
  }

  /** Twilio/MMS lives on Render — local rm_api has no SMS keys. */
  function notifyApiBase() {
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveBrokerApiBase) {
      return global.RMMorningApi.resolveBrokerApiBase();
    }
    const h = global.location?.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return "https://rainmaker-api-waqs.onrender.com";
    }
    return apiBase();
  }

  function apiBase() {
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveApiBase) {
      return global.RMMorningApi.resolveApiBase();
    }
    if (typeof global.RMAuthGate !== "undefined" && global.RMAuthGate.getApiBase) {
      return global.RMAuthGate.getApiBase();
    }
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
    return "https://rainmaker-api-waqs.onrender.com";
  }

  function getConsent() {
    try {
      return global.localStorage?.getItem(CONSENT_KEY) || "";
    } catch (_) {
      return "";
    }
  }
  function setConsent(v) {
    try {
      global.localStorage?.setItem(CONSENT_KEY, v);
    } catch (_) {}
  }

  /* ---- Google Analytics (gtag) ---- */
  function loadAnalytics() {
    const id = metaContent(GA_META);
    if (!id) return;
    if (getConsent() === "declined") return;
    if (global._rmGaLoaded) return;
    global._rmGaLoaded = true;
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    document.head.appendChild(s);
    global.dataLayer = global.dataLayer || [];
    function gtag() {
      global.dataLayer.push(arguments);
    }
    global.gtag = gtag;
    gtag("js", new Date());
    gtag("config", id, { anonymize_ip: true });
  }

  function trackEvent(name, params) {
    try {
      if (typeof global.gtag === "function") global.gtag("event", name, params || {});
    } catch (_) {}
  }

  /* ---- Email capture ---- */
  async function captureEmail(email, source) {
    const base = apiBase();
    const value = String(email || "").trim().toLowerCase();
    if (!value || !value.includes("@")) return { ok: false };
    try {
      global.localStorage?.setItem(EMAIL_KEY, value);
    } catch (_) {}
    if (!base) return { ok: true, stored: true };
    try {
      const res = await fetch(base + "/growth/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: value,
          source: source || "banner",
          consent: getConsent() === "granted",
          clientId: localStorage.getItem("rm_client_id") || null,
        }),
        keepalive: true,
      });
      return { ok: res.ok };
    } catch (_) {
      return { ok: false };
    }
  }

  /* ---- Share draft queue (#11) ---- */
  async function queueShareDraft(draft) {
    const base = apiBase();
    if (!base) return { ok: false, reason: "no_api" };
    try {
      const headers = { "Content-Type": "application/json" };
      if (typeof global.RMAuthGate !== "undefined") {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
      const res = await fetch(base + "/share/draft", {
        method: "POST",
        headers,
        body: JSON.stringify(draft || {}),
      });
      return { ok: res.ok, draft: res.ok ? await res.json() : null };
    } catch (_) {
      return { ok: false };
    }
  }

  /* ---- Automation / alert preferences ---- */
  function getAutomations() {
    try {
      return JSON.parse(global.localStorage?.getItem(AUTO_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }
  function setAutomations(prefs) {
    try {
      global.localStorage?.setItem(AUTO_KEY, JSON.stringify(prefs || {}));
    } catch (_) {}
  }

  function getNotifications() {
    try {
      return JSON.parse(global.localStorage?.getItem(NOTIF_KEY) || "[]") || [];
    } catch (_) {
      return [];
    }
  }

  function pushNotification(n) {
    const list = getNotifications();
    list.unshift({
      id: "n_" + Date.now(),
      at: Date.now(),
      title: n.title || "Rainmaker",
      body: n.body || "",
      kind: n.kind || "info",
      read: false,
    });
    try {
      global.localStorage?.setItem(NOTIF_KEY, JSON.stringify(list.slice(0, 40)));
    } catch (_) {}
    renderNotificationsList();
  }

  function markNotificationRead(id) {
    const list = getNotifications();
    const item = list.find(function (n) {
      return n.id === id;
    });
    if (!item) return null;
    item.read = true;
    try {
      global.localStorage?.setItem(NOTIF_KEY, JSON.stringify(list.slice(0, 40)));
    } catch (_) {}
    return item;
  }

  function setNotifStatus(text) {
    const el = document.getElementById("notifStatus");
    if (el) el.textContent = text || "";
  }

  function wireNotificationsList() {
    const el = document.getElementById("notificationsList");
    if (!el || el._rmWired) return;
    el._rmWired = true;
    el.addEventListener("click", function (ev) {
      const item = ev.target.closest("[data-notif-id]");
      if (!item) return;
      const id = item.getAttribute("data-notif-id");
      const n = markNotificationRead(id);
      renderNotificationsList();
      if (n) {
        setNotifStatus((n.title || "Notification") + (n.body ? " — " + n.body : ""));
        item.classList.add("rm-notif-item--active");
      }
    });
  }

  function renderNotificationsList() {
    const el = document.getElementById("notificationsList");
    if (!el) return;
    const items = getNotifications();
    if (!items.length) {
      el.innerHTML = '<p class="meta">No notifications yet. Enable morning brief below.</p>';
      return;
    }
    el.innerHTML = items
      .slice(0, 12)
      .map(function (n) {
        const when = new Date(n.at).toLocaleString();
        return (
          '<button type="button" class="rm-notif-item' +
          (n.read ? "" : " rm-notif-item--unread") +
          '" data-notif-id="' +
          n.id +
          '">' +
          '<strong>' +
          (n.title || "Update") +
          "</strong>" +
          '<p class="meta">' +
          (n.body || "") +
          "</p>" +
          '<span class="meta rm-notif-when">' +
          when +
          "</span></button>"
        );
      })
      .join("");
  }

  async function sendMorningEmailBrief() {
    const base = apiBase();
    const email =
      document.getElementById("autoEmail")?.value?.trim() ||
      (() => {
        try {
          return global.localStorage?.getItem(EMAIL_KEY) || "";
        } catch (_) {
          return "";
        }
      })();
    if (!email || !email.includes("@")) {
      return { ok: false, reason: "no_email" };
    }
    const verdict =
      document.querySelector(".header-verdict-text")?.textContent?.trim() ||
      document.querySelector("[data-mood-label]")?.textContent?.trim() ||
      "Morning brief";
    const picks = [];
    document.querySelectorAll(".pick-row[data-symbol]").forEach(function (row) {
      const sym = row.getAttribute("data-symbol");
      if (sym && picks.length < 5) picks.push(sym);
    });
    const body =
      "Rainmaker morning brief\n\nVerdict: " +
      verdict +
      (picks.length ? "\nPicks: " + picks.join(", ") : "") +
      "\n\nOpen: https://thepokerninja.github.io/rainmaker-morning/latest.html";
    if (!base) {
      pushNotification({ title: "Morning brief (local)", body: body.slice(0, 200), kind: "brief" });
      return { ok: true, local: true };
    }
    try {
      const res = await fetch(base + "/growth/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          source: "morning_brief",
          consent: getConsent() === "granted",
          message: body,
        }),
        keepalive: true,
      });
      const data = await res.json().catch(function () {
        return {};
      });
      const ok = res.ok;
      if (ok && data.sent) {
        pushNotification({
          title: "Morning brief sent",
          body: "Email delivered to " + email,
          kind: "brief",
        });
      } else if (ok) {
        const reason =
          data.reason === "email_not_configured"
            ? "Saved your address — enable RM_RESEND_API_KEY on the API to deliver email."
            : "Saved — email not sent" + (data.reason ? " (" + data.reason + ")" : ".");
        pushNotification({ title: "Morning brief saved", body: reason, kind: "brief" });
      }
      return { ok: ok, sent: !!data.sent, status: res.status, reason: data.reason };
    } catch (_) {
      pushNotification({ title: "Morning brief saved", body: body.slice(0, 180), kind: "brief" });
      return { ok: false, local: true };
    }
  }

  function maybeMorningBrief() {
    const prefs = getAutomations();
    if (!prefs.morningEmail && !prefs.morningText) return;
    const hour = new Date().getHours();
    if (hour < 6 || hour > 10) return;
    const key = "rm_morning_brief_" + new Date().toLocaleDateString("en-CA");
    try {
      if (global.localStorage?.getItem(key)) return;
      global.localStorage?.setItem(key, "1");
    } catch (_) {
      return;
    }
    if (prefs.morningEmail) void sendMorningEmailBrief();
  }

  function alertPhone() {
    const field = document.getElementById("autoPhone")?.value?.trim();
    if (field) return field;
    return getAutomations().phone || "";
  }

  const MSG_TWILIO_TOLL_FREE_30032 =
    "Your Twilio toll-free number is not verified yet (error 30032). In Twilio Console, complete Toll-Free Verification for RM_TWILIO_FROM, then try again.";

  function isTwilioTollFreeUnverified(text) {
    const d = String(text || "").toLowerCase();
    return (
      /30032/.test(d) ||
      /toll[- ]?free/.test(d) && /not verified|has not been verified/.test(d)
    );
  }

  function formatSmsError(data, fallback) {
    const detail = data?.detail || "";
    const why = data?.reason || detail || fallback || "not sent";
    if (isTwilioTollFreeUnverified(detail) || isTwilioTollFreeUnverified(why)) {
      return MSG_TWILIO_TOLL_FREE_30032;
    }
    if (why === "twilio_not_configured") {
      return "Server SMS not configured — set RM_TWILIO_* on Render.";
    }
    if (why === "no_recipient") {
      return "Enter your mobile number above and tap Save alert settings.";
    }
    if (String(why).startsWith("twilio_")) {
      return "Twilio rejected the message: " + (detail || why);
    }
    return "Text not sent: " + why + (detail ? " — " + detail : "");
  }

  function deliveryHint(data) {
    const hint = data?.toHint ? " (" + data.toHint + ")" : "";
    const sid = data?.sid ? " Ref: " + data.sid + "." : "";
    return (
      hint +
      sid +
      " If nothing arrives within a minute, check Twilio Messaging logs."
    );
  }

  async function refreshSmsStatus() {
    const status = document.getElementById("autoStatus");
    const base = notifyApiBase();
    if (!status || !base) return;
    try {
      const res = await fetch(base + "/notify/status");
      const data = await res.json().catch(() => ({}));
      if (!data.twilioConfigured) {
        status.textContent =
          "SMS not configured on the server yet (RM_TWILIO_SID, RM_TWILIO_TOKEN, RM_TWILIO_FROM on Render).";
        return;
      }
      if (!data.publicUrlConfigured) {
        status.textContent =
          "Twilio is on; set RM_API_PUBLIC_URL on Render so share-card images can be texted (MMS).";
        return;
      }
      status.textContent = "SMS ready. Save your number, then use Text share card to me.";
    } catch (_) {
      /* ignore */
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      try {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function postShareTextMms(phone, blob) {
    const base = notifyApiBase();
    if (!base) return { ok: false, reason: "no_api" };
    const image = await blobToDataUrl(blob);
    if (!image) return { ok: false, reason: "encode_failed" };
    const headers = { "Content-Type": "application/json" };
    if (typeof global.RMAuthGate !== "undefined") {
      Object.assign(headers, global.RMAuthGate.authHeaders() || {});
    }
    const body = {
      image,
      body: "Rainmaker morning verdict (test)",
      to: phone || undefined,
    };
    try {
      const res = await fetch(base + "/share/text", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok && !!data.sent, data };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  /* ---- Account-drawer controls (replaces the old bottom banner) ---- */
  function hydrateAccountControls() {
    const root = document.getElementById("drawerAutomations");
    if (!root) return;
    const prefs = getAutomations();
    const email = (() => {
      try {
        return global.localStorage?.getItem(EMAIL_KEY) || "";
      } catch (_) {
        return "";
      }
    })();
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val || "";
    };
    const check = (id, on) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!on;
    };
    set("autoEmail", email);
    set("autoPhone", prefs.phone);
    check("autoSmsOptIn", prefs.smsOptIn);
    check("autoMorningText", prefs.morningText);
    check("autoMorningEmail", prefs.morningEmail);
    check("autoGeneralText", prefs.generalText);
    check("autoNewScan", prefs.newScan);
    check("autoConsent", getConsent() === "granted");
    syncSmsToggleGate();
    void refreshSmsStatus();
    renderNotificationsList();
  }

  function smsOptInGranted() {
    return !!document.getElementById("autoSmsOptIn")?.checked;
  }

  function syncSmsToggleGate() {
    const allowed = smsOptInGranted();
    ["autoMorningText", "autoGeneralText"].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = !allowed;
      const row = el.closest(".rm-auto-toggle");
      if (row) row.classList.toggle("rm-auto-toggle--disabled", !allowed);
    });
    if (!allowed) {
      const morning = document.getElementById("autoMorningText");
      const general = document.getElementById("autoGeneralText");
      if (morning) morning.checked = false;
      if (general) general.checked = false;
    }
  }

  async function sendTestSms() {
    const status = document.getElementById("autoStatus");
    if (!smsOptInGranted()) {
      if (status) {
        status.textContent =
          "Check the SMS consent box above, enter your mobile number, then Save alert settings before sending a test text.";
      }
      return { ok: false, reason: "sms_opt_in_required" };
    }
    const base = notifyApiBase();
    if (!base) {
      if (status) {
        status.textContent =
          "Rainmaker API URL missing. Hard-refresh or republish with RM_API_PUBLIC_URL set.";
      }
      return { ok: false, reason: "no_api" };
    }
    if (
      typeof global.RMAuthGate !== "undefined" &&
      (!global.RMAuthGate.getToken || !global.RMAuthGate.getToken())
    ) {
      if (status) {
        status.textContent =
          "Not signed in — refresh the page to sign in, then retry.";
      }
      return { ok: false, reason: "auth_required" };
    }
    const phone = alertPhone();
    if (!phone) {
      if (status) {
        status.textContent =
          "Enter your mobile number above, then save. Texts go to that number in E.164 form (e.g. +1 555 123 4567).";
      }
      return { ok: false, reason: "no_phone" };
    }
    const headers = { "Content-Type": "application/json" };
    if (typeof global.RMAuthGate !== "undefined") {
      Object.assign(headers, global.RMAuthGate.authHeaders() || {});
    }
    if (status) status.textContent = "Sending share card to your phone…";
    try {
      let blob = null;
      if (global.RMShareCard?.toBlob) {
        blob = await global.RMShareCard.toBlob();
      }
      if (blob) {
        const mms = await postShareTextMms(phone, blob);
        if (mms.ok) {
          if (status) {
            const kind = mms.data?.mms
              ? "Share card MMS sent"
              : mms.data?.mmsFallback
                ? "Card link texted (MMS failed, sent SMS with link)"
                : "Share card text sent";
            status.textContent = kind + deliveryHint(mms.data);
          }
          trackEvent("sms_test", { ok: true, kind: "mms" });
          return { ok: true, data: mms.data };
        }
        if (status) {
          const mmsErr = mms.data || { reason: mms.reason };
          status.textContent =
            formatSmsError(mmsErr, mms.reason || "unknown") + " Trying plain test SMS…";
        }
      }
      const res = await fetch(base + "/notify/test-sms", {
        method: "POST",
        headers,
        body: JSON.stringify({ to: phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        let msg = data.detail || "Test text failed (" + res.status + ").";
        if (res.status === 404 && /localhost|127\.0\.0\.1/.test(base)) {
          msg =
            "Local API is outdated — restart rm_api on port 8765 (see tools/rm_api/README.md).";
        } else if (res.status === 401) {
          msg = "Sign in required to send a test text.";
        }
        if (status) status.textContent = msg;
        return { ok: false, data };
      }
      if (data.sent) {
        if (status) {
          status.textContent =
            "Plain test SMS accepted by Twilio" +
            deliveryHint(data) +
            " Open Share in the header for the full verdict card.";
        }
        trackEvent("sms_test", { ok: true, kind: "sms" });
        return { ok: true, data };
      }
      if (status) status.textContent = formatSmsError(data, "not sent");
      trackEvent("sms_test", { ok: false, reason: data.reason || "not sent" });
      return { ok: false, data };
    } catch (e) {
      const fetchFailed =
        e?.name === "TypeError" && /fetch|Failed to fetch|NetworkError/i.test(String(e?.message || ""));
      const localApi = /127\.0\.0\.1:8765|localhost:8765/.test(base || "");
      if (status) {
        status.textContent = fetchFailed
          ? localApi
            ? "Cannot reach rm_api on port 8765. Run .\\start-morning.ps1 (starts API + app) or see tools/rm_api/README.md."
            : "Network error reaching the API. Check connection and sign-in."
          : "Test text failed: " + String(e?.message || e).slice(0, 80);
      }
      return { ok: false, reason: String(e) };
    }
  }

  async function saveAccountControls() {
    const status = document.getElementById("autoStatus");
    const val = (id) => document.getElementById(id)?.value?.trim() || "";
    const on = (id) => !!document.getElementById(id)?.checked;
    const smsOptIn = on("autoSmsOptIn");
    const wantsSms = on("autoMorningText") || on("autoGeneralText");
    if (wantsSms && !smsOptIn) {
      if (status) {
        status.textContent =
          "Check the SMS consent box before enabling morning or general text alerts.";
      }
      syncSmsToggleGate();
      return { ok: false, reason: "sms_opt_in_required" };
    }
    const prefs = {
      phone: val("autoPhone"),
      smsOptIn: smsOptIn,
      smsOptInAt: smsOptIn ? Date.now() : null,
      morningText: smsOptIn && on("autoMorningText"),
      morningEmail: on("autoMorningEmail"),
      generalText: smsOptIn && on("autoGeneralText"),
      newScan: on("autoNewScan"),
      updatedAt: Date.now(),
    };
    setAutomations(prefs);
    const consentGranted = on("autoConsent");
    setConsent(consentGranted ? "granted" : "declined");
    if (consentGranted) loadAnalytics();
    const email = val("autoEmail");
    let emailOk = true;
    if (email) {
      const r = await captureEmail(email, "account");
      emailOk = r.ok;
      trackEvent("email_capture", { ok: r.ok, source: "account" });
    }
    if (status) {
      status.textContent = email && !emailOk
        ? "Saved locally - email sync will retry when the API is reachable."
        : "Alert settings saved.";
    }
    return { ok: true, prefs, emailOk };
  }

  function initAccountControls() {
    hydrateAccountControls();
    const smsOptInEl = document.getElementById("autoSmsOptIn");
    if (smsOptInEl && !smsOptInEl._rmBound) {
      smsOptInEl._rmBound = true;
      smsOptInEl.addEventListener("change", syncSmsToggleGate);
    }
    const saveBtn = document.getElementById("autoSave");
    if (saveBtn && !saveBtn._rmBound) {
      saveBtn._rmBound = true;
      saveBtn.addEventListener("click", () => {
        saveAccountControls();
      });
    }
    const testBtn = document.getElementById("autoTestSms");
    if (testBtn && !testBtn._rmBound) {
      testBtn._rmBound = true;
      testBtn.addEventListener("click", () => {
        sendTestSms();
      });
    }
    const briefBtn = document.getElementById("btnSendMorningBrief");
    if (briefBtn && !briefBtn._rmBound) {
      briefBtn._rmBound = true;
      briefBtn.addEventListener("click", async () => {
        setNotifStatus("Sending morning brief…");
        const status = document.getElementById("autoStatus");
        if (status) status.textContent = "Sending morning brief…";
        const r = await sendMorningEmailBrief();
        const msg = r.ok
          ? r.local
            ? "Brief saved to notifications (API offline)."
            : "Morning brief sent to your email."
          : "Add your email above and save, then retry.";
        setNotifStatus(msg);
        if (status) status.textContent = msg;
        renderNotificationsList();
      });
    }
    wireNotificationsList();
    const acctBtn = document.getElementById("btnAccount");
    if (acctBtn && !acctBtn._rmGrowthBound) {
      acctBtn._rmGrowthBound = true;
      acctBtn.addEventListener("click", () => setTimeout(hydrateAccountControls, 50));
    }
  }

  function init() {
    if (getConsent() === "granted") loadAnalytics();
    initAccountControls();
    renderNotificationsList();
    wireNotificationsList();
    setTimeout(maybeMorningBrief, 4000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.RMGrowth = {
    loadAnalytics,
    trackEvent,
    captureEmail,
    queueShareDraft,
    sendTestSms,
    getAutomations,
    setAutomations,
    alertPhone,
    formatSmsError,
    isTwilioTollFreeUnverified,
    MSG_TWILIO_TOLL_FREE_30032,
    hydrateAccountControls,
    saveAccountControls,
    refreshSmsStatus,
    sendMorningEmailBrief,
    pushNotification,
    getNotifications,
    renderNotificationsList,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- holdings.js --- */
/** Open positions, price history, and recommendation tracking (localStorage). */
(function (global) {
  const STORAGE_KEY = "rainmaker_holdings_v1";

  function parseOptionUnderlying(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return "";
    const compact = s.replace(/\s+/g, "");
    const occ = compact.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
    if (occ) return occ[1].trim();
    const spaced = s.match(/^([A-Z]{1,6})\s+(\d{6}[CP]\d{8})$/i);
    if (spaced) return spaced[1].trim();
    return compact;
  }

  function isOptionSymbol(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return false;
    const compact = s.replace(/\s+/g, "");
    return /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(compact);
  }

  function compactOptionSymbol(raw) {
    return String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  }

  function parseOptionContract(raw) {
    const compact = compactOptionSymbol(raw);
    const occ = compact.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
    if (!occ) return null;
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const mi = parseInt(occ[3], 10) - 1;
    return {
      underlying: occ[1],
      expiry: "20" + occ[2] + "-" + occ[3] + "-" + occ[4],
      expiryShort:
        (months[mi] || occ[3]) + " " + parseInt(occ[4], 10) + " '" + occ[2],
      right: occ[5] === "C" ? "Call" : "Put",
      strike: Number(occ[6]) / 1000,
      compact,
    };
  }

  function formatOptionLabel(raw) {
    const p = parseOptionContract(raw);
    if (!p) return String(raw || "").trim();
    return (
      p.underlying +
      " " +
      p.expiryShort +
      " $" +
      p.strike +
      (p.right === "Call" ? "C" : "P")
    );
  }

  /** Yahoo / chart bars symbol — option contracts use OCC, not underlying. */
  function quoteSymbolFor(h) {
    if (!h) return "";
    if (h.quoteSymbol) return String(h.quoteSymbol).toUpperCase();
    const sym = String(h.symbol || "").trim().toUpperCase();
    if (!sym) return "";
    if (h.instrument === "option" || isOptionSymbol(sym)) {
      return compactOptionSymbol(sym);
    }
    return sym;
  }

  function restoreSymbolFromSchwabKey(tail) {
    let t = String(tail || "").replace(/^schwab_/i, "");
    const idx = t.indexOf("_");
    if (idx > 0) {
      const root = t.slice(0, idx);
      const rest = t.slice(idx + 1);
      if (/^[A-Z]{1,6}$/.test(root) && /^\d{6}[CP]\d{8}$/.test(rest)) {
        return root + rest;
      }
    }
    return compactOptionSymbol(t.replace(/_/g, ""));
  }

  function barsSymbolForSelectValue(val) {
    const key = normalizeHoldingSelectKey(String(val || "").trim());
    if (!key) return "";
    const h = findDisplayHoldingBySelectValue(key);
    if (h) return quoteSymbolFor(h);
    if (isHoldingSelectKey(key)) {
      return restoreSymbolFromSchwabKey(key.slice(8));
    }
    if (isOptionSymbol(key)) return compactOptionSymbol(key);
    return key.toUpperCase();
  }

  function openPositionPnl(h) {
    if (!h) return null;
    const isOpt =
      h.instrument === "option" || isOptionSymbol(String(h.symbol || ""));
    const mult = isOpt ? 100 : 1;
    const qty = Math.abs(Number(h.quantity ?? h.qty) || 0);
    const avg = Number(h.entry_price ?? h.avgPrice);
    const mv = Number(h.market_value ?? h.marketValue);
    if (!qty || !Number.isFinite(avg) || !Number.isFinite(mv)) return null;
    const cost = avg * qty * mult;
    if (!Number.isFinite(cost) || cost === 0) return null;
    const dollars = mv - cost;
    return {
      dollars: Math.round(dollars * 100) / 100,
      pct: Math.round(((dollars / cost) * 100) * 10) / 10,
    };
  }

  function chartSymbolFor(h) {
    if (!h) return "";
    if (h.chartSymbol) return String(h.chartSymbol).toUpperCase();
    const sym = String(h.symbol || "").trim().toUpperCase();
    if (!sym) return "";
    if (h.instrument === "option" || isOptionSymbol(sym)) {
      return parseOptionUnderlying(sym) || sym;
    }
    return sym;
  }

  function normalizeHoldingSelectKey(val) {
    const s = String(val || "").trim();
    const m = s.match(/^holding:(.+)$/i);
    if (m) return "holding:" + m[1];
    return s;
  }

  function isHoldingSelectKey(val) {
    return /^holding:/i.test(String(val || ""));
  }

  function holdingSelectValue(h) {
    if (!h) return "";
    const chart = chartSymbolFor(h);
    const sym = String(h.symbol || "").trim().toUpperCase();
    if (h.instrument === "option" || isOptionSymbol(sym)) return "holding:" + h.id;
    return chart;
  }

  function findDisplayHoldingBySelectValue(val) {
    const norm = normalizeHoldingSelectKey(val);
    if (!isHoldingSelectKey(norm)) return null;
    const id = norm.slice(8);
    const rows = getDisplayOpen();
    const direct =
      rows.find((h) => h.id === id) ||
      rows.find((h) => String(h.id).toLowerCase() === id.toLowerCase()) ||
      null;
    if (direct) return direct;
    const compactId = compactOptionSymbol(restoreSymbolFromSchwabKey(id));
    return (
      rows.find((h) => compactOptionSymbol(h.symbol) === compactId) ||
      rows.find((h) => String(h.id).replace(/\s+/g, "_") === id.replace(/\s+/g, "_")) ||
      null
    );
  }

  function chartSymbolForSelectValue(val) {
    const key = normalizeHoldingSelectKey(String(val || "").trim());
    if (!key) return "";
    const h = findDisplayHoldingBySelectValue(key);
    if (h) return chartSymbolFor(h);
    if (isHoldingSelectKey(key)) {
      const tail = key.slice(8);
      const fromId = tail.replace(/^schwab_/i, "").replace(/_/g, " ");
      if (isOptionSymbol(fromId)) return parseOptionUnderlying(fromId);
      const root = tail.replace(/^schwab_/i, "").split("_")[0];
      if (root && /^[A-Z]{1,6}$/.test(root)) return root;
    }
    if (isOptionSymbol(key)) return parseOptionUnderlying(key);
    return key.toUpperCase();
  }

  function labelForSelectValue(val) {
    const h = findDisplayHoldingBySelectValue(normalizeHoldingSelectKey(val));
    if (h) {
      const sym = String(h.symbol).trim();
      const label =
        h.instrument === "option" || isOptionSymbol(sym)
          ? formatOptionLabel(sym)
          : sym;
      return label + " · holding";
    }
    const rows = getDisplayOpen();
    for (const row of rows) {
      if (holdingSelectValue(row) === val) {
        const sym = String(row.symbol).trim();
        const label =
          row.instrument === "option" || isOptionSymbol(sym)
            ? formatOptionLabel(sym)
            : sym;
        return label + " · holding";
      }
    }
    return val;
  }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function save(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function getOpen() {
    return load().filter((h) => h.status === "open");
  }

  function getClosed() {
    return load().filter((h) => h.status === "closed");
  }

  function findById(id) {
    return load().find((h) => h.id === id);
  }

  function findOpenBySymbol(symbol) {
    return load().find(
      (h) => h.status === "open" && h.symbol === String(symbol).toUpperCase()
    );
  }

  function uid() {
    return "h_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
  }

  function addHolding(data) {
    const list = load();
    const symbol = String(data.symbol || "").toUpperCase();
    if (!symbol) throw new Error("Symbol required");
    const entry = Number(data.entry_price);
    const h = {
      id: uid(),
      symbol,
      instrument: data.instrument === "option" ? "option" : "stock",
      entry_price: Number.isNaN(entry) ? null : entry,
      quantity: data.quantity != null ? Number(data.quantity) : null,
      entry_date: data.entry_date || new Date().toISOString(),
      rm_confidence: data.rm_confidence != null ? Number(data.rm_confidence) : null,
      session_id: data.session_id || null,
      notes: data.notes || "",
      status: "open",
      price_history: [
        {
          at: new Date().toISOString(),
          price: Number.isNaN(entry) ? null : entry,
          source: "entry",
        },
      ],
    };
    list.push(h);
    save(list);
    return h;
  }

  function appendPrice(symbol, price, source) {
    if (price == null || Number.isNaN(Number(price))) return null;
    const list = load();
    const sym = String(symbol).toUpperCase();
    const h = list.find((x) => x.status === "open" && x.symbol === sym);
    if (!h) return null;
    h.price_history = h.price_history || [];
    const last = h.price_history[h.price_history.length - 1];
    const p = Number(price);
    if (last && last.price === p && last.source === source) return h;
    h.price_history.push({
      at: new Date().toISOString(),
      price: p,
      source: source || "scan",
    });
    if (h.price_history.length > 120) {
      h.price_history = h.price_history.slice(-120);
    }
    save(list);
    return h;
  }

  function syncPricesFromPicks(picks) {
    if (!picks || !picks.length) return;
    const map = {};
    picks.forEach((p) => {
      if (p.symbol && p.last != null) map[p.symbol.toUpperCase()] = Number(p.last);
    });
    Object.keys(map).forEach((sym) => appendPrice(sym, map[sym], "scan"));
  }

  function currentPrice(h) {
    const hist = h.price_history || [];
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].price != null) return Number(hist[i].price);
    }
    return h.entry_price != null ? Number(h.entry_price) : null;
  }

  function calcPnL(h, mark) {
    const entry = h.entry_price != null ? Number(h.entry_price) : null;
    const px = mark != null ? Number(mark) : currentPrice(h);
    if (entry == null || px == null || entry === 0) return null;
    const qty = h.quantity != null ? Number(h.quantity) : 1;
    const pct = ((px - entry) / entry) * 100;
    const dollars = (px - entry) * qty;
    return { pct, dollars, mark: px };
  }

  function upsertFromTrade(data) {
    const symbol = String(data.symbol || "").toUpperCase();
    if (!symbol) return null;
    const entry = data.entry_price != null ? Number(data.entry_price) : null;
    const existing = findOpenBySymbol(symbol);
    if (existing) {
      if (entry != null && !Number.isNaN(entry)) {
        appendPrice(symbol, entry, "trade");
      }
      if (data.quantity != null) existing.quantity = Number(data.quantity);
      if (data.instrument) existing.instrument = data.instrument;
      if (data.rm_confidence != null) existing.rm_confidence = data.rm_confidence;
      if (data.session_id) existing.session_id = data.session_id;
      save(load());
      return existing;
    }
    return addHolding(data);
  }

  function closeHolding(id, exitPrice) {
    const list = load();
    const h = list.find((x) => x.id === id);
    if (!h) return null;
    const px = exitPrice != null ? Number(exitPrice) : currentPrice(h);
    h.status = "closed";
    h.closed_at = new Date().toISOString();
    h.exit_price = px;
    if (px != null) {
      h.price_history = h.price_history || [];
      h.price_history.push({
        at: h.closed_at,
        price: px,
        source: "exit",
      });
    }
    const pnl = calcPnL(h, px);
    h.realized_pnl_pct = pnl ? pnl.pct : null;
    save(list);
    return h;
  }

  function stats() {
    const closed = getClosed();
    const wins = closed.filter((h) => (h.realized_pnl_pct || 0) > 0);
    const losses = closed.filter((h) => (h.realized_pnl_pct || 0) < 0);
    const highRm = closed.filter((h) => (h.rm_confidence || 0) >= 50);
    const highRmWins = highRm.filter((h) => (h.realized_pnl_pct || 0) > 0);
    return {
      open: getOpen().length,
      closed: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      avgRmWin: wins.length
        ? wins.reduce((s, h) => s + (h.rm_confidence || 0), 0) / wins.length
        : null,
      avgRmLoss: losses.length
        ? losses.reduce((s, h) => s + (h.rm_confidence || 0), 0) / losses.length
        : null,
      highRmHitRate: highRm.length
        ? (highRmWins.length / highRm.length) * 100
        : null,
    };
  }

  let brokerPositions = [];

  function setBrokerPositions(positions) {
    brokerPositions = (positions || [])
      .filter((p) => p.symbol && Math.abs(Number(p.qty) || 0) > 0)
      .map((p) => {
        const symbol = String(p.symbol).trim().toUpperCase();
        const isOpt =
          String(p.assetType || "").toUpperCase() === "OPTION" || isOptionSymbol(symbol);
        const quoteSymbol = isOpt ? compactOptionSymbol(symbol) : symbol;
        return {
        id: "schwab_" + symbol.replace(/\s+/g, "_"),
        symbol,
        quoteSymbol,
        chartSymbol: chartSymbolFor({ symbol, instrument: isOpt ? "option" : "stock" }),
        instrument: isOpt ? "option" : "stock",
        entry_price: p.avgPrice != null ? Number(p.avgPrice) : null,
        quantity: Number(p.qty) || 0,
        market_value: p.marketValue != null ? Number(p.marketValue) : null,
        account: p.account || null,
        status: "open",
        source: "schwab",
        readOnly: true,
        entry_date: p.entryDate || p.openDate || new Date().toISOString(),
        notes: "",
        rm_confidence: null,
        session_id: null,
        price_history: [],
      };
      });
  }

  function getBrokerPositions() {
    return brokerPositions.slice();
  }

  function getBrokerSymbols() {
    const set = {};
    brokerPositions.forEach((p) => {
      if (p.symbol) set[p.symbol] = true;
    });
    return set;
  }

  function displayKeyForSymbol(sym, h) {
    const s = String(sym || "").trim();
    if ((h && h.instrument === "option") || isOptionSymbol(s)) {
      return formatOptionLabel(s);
    }
    return s.toUpperCase();
  }

  function chartFocusFromHolding(h) {
    if (!h) return null;
    const selectKey = holdingSelectValue(h);
    return {
      selectKey,
      quoteKey: quoteSymbolFor(h),
      displayKey: displayKeyForSymbol(h.symbol, h),
      chartKey: chartSymbolFor(h),
      kind: "holding",
      holding: h,
      symbol: chartSymbolFor(h),
    };
  }

  function chartFocusFromSelectKey(raw) {
    const key = String(raw || "").trim();
    if (!key) return null;
    if (isHoldingSelectKey(key)) {
      const norm = normalizeHoldingSelectKey(key);
      const h = findDisplayHoldingBySelectValue(norm);
      if (h) return chartFocusFromHolding(h);
    }
    const upper = key.toUpperCase().replace(/[^A-Z0-9.-]/g, "");
    if (!upper) return null;
    return {
      selectKey: upper,
      quoteKey: upper,
      displayKey: upper,
      chartKey: upper,
      kind: "pick",
      symbol: upper,
    };
  }

  function chartFocusFromPick(pick) {
    if (!pick?.symbol) return null;
    const sym = String(pick.symbol).trim();
    if (isHoldingSelectKey(sym)) {
      return chartFocusFromSelectKey(sym);
    }
    if (pick._holding) return chartFocusFromHolding(pick._holding);
    const upper = sym.toUpperCase();
    return {
      selectKey: upper,
      quoteKey: upper,
      displayKey: upper,
      chartKey: pick.chartSymbol || upper,
      kind: "pick",
      symbol: upper,
    };
  }

  /** Local thesis overlay merged with read-only Schwab broker rows. */
  function getDisplayOpen() {
    const local = getOpen();
    const localBySym = {};
    local.forEach((h) => {
      localBySym[h.symbol] = h;
    });
    const out = [];
    const seen = {};
    brokerPositions.forEach((bp) => {
      const overlay = localBySym[bp.symbol];
      seen[bp.symbol] = true;
      if (overlay) {
        out.push({
          ...bp,
          id: overlay.id,
          notes: overlay.notes,
          rm_confidence: overlay.rm_confidence,
          session_id: overlay.session_id,
          price_history: overlay.price_history,
          hasThesis: true,
        });
      } else {
        out.push({ ...bp, hasThesis: false });
      }
    });
    /* Real-only: show Schwab broker rows (+ thesis overlay), not orphan manual rows. */
    return out;
  }

  global.RMHoldings = {
    load,
    save,
    getOpen,
    getClosed,
    findById,
    findOpenBySymbol,
    addHolding,
    appendPrice,
    syncPricesFromPicks,
    currentPrice,
    calcPnL,
    closeHolding,
    upsertFromTrade,
    stats,
    setBrokerPositions,
    getBrokerPositions,
    getBrokerSymbols,
    getDisplayOpen,
    parseOptionUnderlying,
    parseOptionContract,
    formatOptionLabel,
    compactOptionSymbol,
    quoteSymbolFor,
    barsSymbolForSelectValue,
    openPositionPnl,
    isOptionSymbol,
    chartSymbolFor,
    holdingSelectValue,
    chartSymbolForSelectValue,
    labelForSelectValue,
    findDisplayHoldingBySelectValue,
    normalizeHoldingSelectKey,
    isHoldingSelectKey,
    chartFocusFromHolding,
    chartFocusFromSelectKey,
    chartFocusFromPick,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- perf_debug.js --- */
/**
 * Lightweight perf diagnostics for local debugging (console + Playwright).
 * window.RMPerf.snapshot() after load.
 */
(function (global) {
  function timerFlags() {
    const hub = global.RMChartHub?.state;
    return {
      chartHeaderPoll: !!(hub && hub.headerPoll),
      chartLivePoll: !!(hub && hub.livePoll),
      chartLiveRefreshing: !!(hub && hub.liveRefreshing),
      headerMoodPoll: !!global.RMHeaderMood?._pollTimer,
      brandLogoPoll: !!global.RMBrandLogo?._pollTimer,
      marketLiveRefresh: !!global.RMMarket?._liveRefreshTimer,
      schwabStatusPoll: !!global.RMSchwab?._pollTimer,
      greenlitRenderPoll: !!global.RMGreenLitPanel && !!global.RMGreenLitPanel._pollTimer,
    };
  }

  function snapshot() {
    const chart = global.RMAnalysisChart?.state;
    const fps = global.RMAnalysisChart?.fpsMeter?.();
    return {
      at: new Date().toISOString(),
      timers: timerFlags(),
      headerMediaTier: global.RMHeaderBg?.getMediaTier?.() || null,
      chartFps: global.RMAnalysisChart?.peekHeaderFpsSample?.() || fps?.fps || null,
      chart: chart
        ? {
            symbol: chart.symbol,
            barCount: chart.bars?.length || 0,
            chartLoading: chart.chartLoading,
            w: chart.w,
            h: chart.h,
          }
        : null,
      fps: fps || null,
      memoryMb:
        performance.memory && performance.memory.usedJSHeapSize
          ? Math.round(performance.memory.usedJSHeapSize / 1048576)
          : null,
    };
  }

  function log(label) {
    const row = snapshot();
    console.info("[RMPerf]" + (label ? " " + label : ""), row);
    return row;
  }

  function exportRow(label) {
    const row = snapshot();
    return {
      label: label || "snapshot",
      at: row.at,
      timers: row.timers,
      chartFps: row.chartFps,
      memoryMb: row.memoryMb,
      chart: row.chart,
    };
  }

  function chartInteraction(label) {
    const mount = document.querySelector(".ca-chart-mount");
    const wrap = document.querySelector(".ca-chart-svg-wrap");
    const brush = document.querySelector(".ca-time-brush:not([hidden])");
    const row = {
      label: label || "chart-interaction",
      at: new Date().toISOString(),
      interacting: !!mount?.classList.contains("is-chart-interacting"),
      panning: !!wrap?.classList.contains("is-chart-panning"),
      brushVisible: !!brush,
      chartFps: global.RMAnalysisChart?.peekHeaderFpsSample?.() || null,
      candleShadowOff:
        !!mount?.classList.contains("is-chart-interacting") ||
        !!wrap?.classList.contains("is-chart-panning"),
    };
    console.info("[RMPerf] chartInteraction", row);
    return row;
  }

  global.RMPerf = { snapshot, log, export: exportRow, timerFlags, chartInteraction };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- auth_gate.js --- */
/** Login gate — blocks boot until Rainmaker API auth succeeds. */
(function (global) {
  /* GitHub Pages app lives under /rainmaker-morning/; OAuth must return there. */
  (function fixGithubPagesAppPath() {
    try {
      if (!/thepokerninja\.github\.io$/i.test(location.hostname)) return;
      const p = location.pathname.replace(/\/$/, "") || "/";
      if (p === "/latest.html" || p === "/index.html") {
        location.replace(
          "/rainmaker-morning/latest.html" + location.search + location.hash
        );
      }
    } catch (_) {}
  })();

  const TOKEN_KEY = "rainmaker_auth_token";
  const USER_KEY = "rainmaker_auth_user";
  const GATE_ID = "authGate";
  const HEADER_VIDEO_BASE = "assets/header/";
  const MOBILE_MAX = 640;
  const HANDOFF_MS = 1100;
  const NATIVE_SPLASH_MS = 1000;
  const NATIVE_LOADER_MS = 750;
  const PROD_API_BASE = "https://rainmaker-api-waqs.onrender.com";
  const GHPAGES_APP_URL =
    "https://thepokerninja.github.io/rainmaker-morning/latest.html";

  function isNativeShell() {
    return (
      document.documentElement.classList.contains("is-native-app") ||
      (global.Capacitor &&
        global.Capacitor.isNativePlatform &&
        global.Capacitor.isNativePlatform()) ||
      /[?&]native=1(?:&|$)/.test(location.search)
    );
  }

  function isApkBeta() {
    if (/[?&]apkBeta=1(?:&|$)/.test(location.search)) return true;
    try {
      return sessionStorage.getItem("rm_apk_beta") === "1";
    } catch (_) {
      return false;
    }
  }

  function oauthReturnUrl() {
    if (/thepokerninja\.github\.io$/i.test(location.hostname)) {
      const params = new URLSearchParams(location.search);
      if (isNativeShell() && !params.has("native")) params.set("native", "1");
      const q = params.toString();
      return GHPAGES_APP_URL + (q ? "?" + q : "");
    }
    return location.origin + location.pathname + location.search;
  }

  function $(id) {
    return document.getElementById(id);
  }

  const OWNER_EMAIL = "michaelstewman@gmail.com";

  function normalizeLoginEmail(raw) {
    let email = String(raw || "").trim().toLowerCase();
    if (email.endsWith("@gmail.cc")) {
      email = email.replace(/@gmail\.cc$/, "@gmail.com");
    }
    return email;
  }

  function formatApiDetail(detail) {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail.length) {
      return detail.map((d) => d.msg || JSON.stringify(d)).join(" · ");
    }
    if (detail && typeof detail === "object") {
      try {
        return JSON.stringify(detail);
      } catch (_) {
        return "Request failed";
      }
    }
    return "Request failed";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isLocalApiBase(url) {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(String(url || ""));
  }

  function getApiBase() {
    const h = location.hostname;
    const onGithubPages = /\.github\.io$/i.test(h);
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      const metaUrl = meta?.content?.trim().replace(/\/$/, "") || "";
      if (metaUrl && !(onGithubPages && isLocalApiBase(metaUrl))) {
        return metaUrl;
      }
      const stored = localStorage.getItem("rainmaker_api_base");
      const storedUrl = stored ? String(stored).replace(/\/$/, "") : "";
      if (storedUrl && !(onGithubPages && isLocalApiBase(storedUrl))) {
        return storedUrl;
      }
    } catch (_) {
      /* ignore */
    }
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    if (onGithubPages) return PROD_API_BASE;
    return PROD_API_BASE;
  }

  function getAuthApiBase() {
    return getApiBase();
  }

  function authRequired() {
    const meta = document.querySelector('meta[name="rainmaker-auth-required"]');
    if (meta && meta.content.trim().toLowerCase() === "false") return false;
    if (/[?&]smoke=1/.test(location.search)) return false;
    return true;
  }

  function isMobile() {
    // Canonical mobile breakpoint across the app is 640px (app.js,
    // workspace_accordion.js, chart_analysis.js, header_bg.js). Keep in sync.
    return global.matchMedia("(max-width: 640px)").matches;
  }

  function supportsWebAuthn() {
    return !!(global.PublicKeyCredential && navigator.credentials);
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function getUser() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user || null));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function authHeaders(extra) {
    const h = { ...(extra || {}) };
    const token = getToken();
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }

  async function apiFetch(path, opts) {
    const base = getAuthApiBase();
    if (!base) throw new Error("Rainmaker API not configured");
    const res = await fetch(base + path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(opts?.headers),
      },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      throw new Error(formatApiDetail((data && data.detail) || text || "Request failed"));
    }
    return data;
  }

  function bufferToB64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlToBuffer(value) {
    const pad = "=".repeat((4 - (value.length % 4)) % 4);
    const b64 = (value + pad).replace(/-/g, "+").replace(/_/g, "/");
    const str = atob(b64);
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
    return out.buffer;
  }

  function prepPublicKeyOptions(options) {
    const out = { ...options };
    if (out.challenge) out.challenge = b64urlToBuffer(out.challenge);
    if (out.user && out.user.id) out.user.id = b64urlToBuffer(out.user.id);
    if (Array.isArray(out.allowCredentials)) {
      out.allowCredentials = out.allowCredentials.map((c) => ({
        ...c,
        id: b64urlToBuffer(c.id),
      }));
    }
    if (Array.isArray(out.excludeCredentials)) {
      out.excludeCredentials = out.excludeCredentials.map((c) => ({
        ...c,
        id: b64urlToBuffer(c.id),
      }));
    }
    return out;
  }

  function credToJson(cred) {
    const res = cred.response;
    return {
      id: cred.id,
      rawId: bufferToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToB64url(res.clientDataJSON),
        attestationObject: res.attestationObject
          ? bufferToB64url(res.attestationObject)
          : undefined,
        authenticatorData: res.authenticatorData
          ? bufferToB64url(res.authenticatorData)
          : undefined,
        signature: res.signature ? bufferToB64url(res.signature) : undefined,
        userHandle: res.userHandle ? bufferToB64url(res.userHandle) : undefined,
      },
    };
  }

  function isAuthRejectedError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return (
      /401|403/.test(msg) ||
      /invalid|expired|missing bearer|not authorized|unauthorized/.test(msg)
    );
  }

  let lastSessionError = "";

  function formatSessionFailMessage() {
    const msg = String(lastSessionError || "");
    const local =
      location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return local
        ? "Cannot reach the prod API from this page (network/CORS). Use the published app, or wait for Render to finish deploying RM_CORS_ORIGINS with :8787."
        : "Cannot reach the Rainmaker API. Check connection and try again.";
    }
    if (/email_not_allowlisted|not authorized for access/i.test(msg)) {
      return "This account is not authorized for access.";
    }
    if (/user_not_found/i.test(msg)) {
      return "Signed in but no user record on the server — try signing in again.";
    }
    if (/401|403|invalid|expired|unauthorized/i.test(msg)) {
      return "Session rejected (" + msg + "). Sign in again.";
    }
    return msg ? "Session check failed: " + msg : "Session check failed. Sign in again.";
  }

  async function validateSession(opts) {
    const token = getToken();
    lastSessionError = "";
    if (!token || !getAuthApiBase()) return false;
    const retries = opts?.retries ?? 1;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const data = await apiFetch("/auth/me", { method: "GET" });
        if (data?.user) {
          setSession(token, data.user);
          return true;
        }
        lastSessionError = "no user in response";
      } catch (err) {
        lastSessionError = err?.message || String(err);
        if (isAuthRejectedError(err)) {
          clearSession();
          return false;
        }
        if (attempt >= retries) return false;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (!lastSessionError) lastSessionError = "session check failed";
    return false;
  }

  function loaderBits(title) {
    return (
      '<div class="auth-gate-loader ws-load-shell ws-load-shell--auth" role="status">' +
      '<div class="ws-load-grid auth-gate-loader-grid" aria-hidden="true"></div>' +
      '<div class="ws-load-orbit" aria-hidden="true"><span></span><span></span></div>' +
      '<div class="ws-load-scanline" aria-hidden="true"></div>' +
      '<p class="ws-load-kicker">Rainmaker access</p>' +
      '<p class="ws-load-title">' +
      escapeHtml(title) +
      "</p>" +
      "</div>"
    );
  }

  function headerVideoSrc(family) {
    const base = HEADER_VIDEO_BASE + family;
    const mobile =
      typeof matchMedia !== "undefined" &&
      matchMedia("(max-width: " + MOBILE_MAX + "px)").matches;
    return {
      primary: mobile ? base + "-mobile.mp4" : base + ".mp4",
      fallback: base + ".mp4",
      poster: base + ".webp",
    };
  }

  function mountAuthBackdrop(gate) {
    if (gate.querySelector(".auth-gate-backdrop")) return;
    const reduced =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    const backdrop = document.createElement("div");
    backdrop.className = "auth-gate-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    const src = headerVideoSrc("neutral");
    if (!reduced) {
      const v = document.createElement("video");
      v.className = "auth-gate-backdrop-video";
      v.muted = true;
      v.defaultMuted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.preload = "auto";
      v.poster = src.poster;
      v.src = src.primary;
      v.addEventListener("error", () => {
        if (v.src !== src.fallback) {
          v.src = src.fallback;
          try {
            v.load();
          } catch (_) {}
        }
      });
      backdrop.appendChild(v);
      v.play().catch(() => {});
    } else {
      const img = document.createElement("img");
      img.className = "auth-gate-backdrop-poster";
      img.src = src.poster;
      img.alt = "";
      backdrop.appendChild(img);
    }
    const vignette = document.createElement("div");
    vignette.className = "auth-gate-backdrop-vignette";
    backdrop.appendChild(vignette);
    gate.insertBefore(backdrop, gate.firstChild);
  }

  function syncHeaderVideoTime(t) {
    if (!Number.isFinite(t) || t <= 0) return;
    const hv = document.getElementById("headerBgPlayer");
    if (!hv) return;
    const apply = () => {
      try {
        hv.currentTime = t;
      } catch (_) {}
    };
    if (hv.readyState >= 1) apply();
    else hv.addEventListener("loadedmetadata", apply, { once: true });
  }

  function renderNativeBootHtml() {
    return (
      '<div class="auth-gate-stage auth-gate-stage--native">' +
      '<div class="auth-gate-splash auth-gate-splash--native" id="authGateSplash" aria-hidden="false">' +
      '<span class="auth-gate-splash-logo-stack brand-logo-stack is-animated" id="authGateLogoStack" aria-hidden="true">' +
      '<video class="brand-logo--video-src" muted loop playsinline preload="auto" src="assets/animated-logo.mp4?v=2" width="120" height="120" aria-hidden="true"></video>' +
      '<canvas class="brand-logo--video auth-gate-splash-canvas" width="120" height="120" aria-hidden="true"></canvas>' +
      "</span></div>" +
      '<div class="auth-gate-card auth-gate-card--native hidden" id="authGateCard">' +
      loaderBits("Loading Rainmaker") +
      "</div></div>"
    );
  }

  function renderGateHtml() {
    return (
      '<div class="auth-gate-stage">' +
      '<div class="auth-gate-splash" id="authGateSplash" role="button" tabindex="0" aria-label="Tap Rainmaker logo to sign in">' +
      '<img class="auth-gate-splash-logo" src="assets/rainmaker-logo.png" alt="Rainmaker" width="120" height="120">' +
      '<p class="auth-gate-tagline">Morning verdict · planned trades</p>' +
      "</div>" +
      '<div class="auth-gate-card auth-gate-card--enter hidden" id="authGateCard">' +
      loaderBits("Sign in to Rainmaker") +
      '<div class="auth-gate-form-wrap">' +
      '<div class="auth-gate-panel auth-gate-panel--standard">' +
      '<p class="auth-gate-kicker">Investor access</p>' +
      '<p class="auth-gate-lead">Sign in to sync Schwab, research inbox, and morning briefs.</p>' +
      '<form id="authLoginForm" class="auth-gate-form" autocomplete="on">' +
      '<label>Email<input type="email" id="authEmail" name="email" autocomplete="username" required autocapitalize="off" spellcheck="false" inputmode="email" value="' +
      OWNER_EMAIL +
      '"></label>' +
      '<label>Password<input type="password" id="authPassword" name="password" autocomplete="current-password" required></label>' +
      '<button type="submit" class="primary auth-gate-submit" id="authLoginBtn">Sign in</button>' +
      "</form>" +
      '<p class="auth-gate-error hidden" id="authGateError" role="alert"></p>' +
      "</div></div></div></div>"
    );
  }

  function revealLoginCard(gate) {
    const splash = gate.querySelector("#authGateSplash");
    const card = gate.querySelector("#authGateCard");
    if (splash) splash.classList.add("hidden");
    if (card) {
      card.classList.remove("hidden");
      card.classList.add("auth-gate-card--enter");
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function finishNativeHandoff() {
    const gate = $(GATE_ID);
    if (!gate) return;
    const vid = gate.querySelector(".auth-gate-backdrop-video");
    const syncT = vid && Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
    document.documentElement.classList.remove("auth-gate-open");
    if (global.RMHeaderBg) {
      try {
        global.RMHeaderBg.setVideoForMood("neutral");
      } catch (_) {}
    }
    if (global.RMHeaderMood?.setPreview) {
      try {
        global.RMHeaderMood.setPreview("neutral");
      } catch (_) {}
    }
    syncHeaderVideoTime(syncT);
    gate.classList.add("hidden");
    gate.classList.remove("auth-gate-handoff", "auth-gate-leave");
    gate.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("auth-gate-handoff");
  }

  function showNativeBootGate() {
    document.documentElement.classList.add("auth-gate-open");
    const gate = $(GATE_ID);
    if (!gate) return;
    gate.classList.remove("hidden", "auth-gate-handoff", "auth-gate-leave");
    gate.setAttribute("aria-hidden", "false");
    mountAuthBackdrop(gate);
    gate.querySelector(".auth-gate-stage")?.remove();
    const stage = document.createElement("div");
    stage.innerHTML = renderNativeBootHtml();
    const inner = stage.firstElementChild;
    if (inner) gate.appendChild(inner);
    global.RMBrandLogo?.mountAuthSplash?.();
  }

  async function runNativeShellBoot() {
    showNativeBootGate();
    await delay(NATIVE_SPLASH_MS);
    revealLoginCard($(GATE_ID));
    await delay(NATIVE_LOADER_MS);
    const gate = $(GATE_ID);
    document.documentElement.classList.add("auth-gate-handoff");
    gate?.classList.add("auth-gate-handoff");
    await delay(HANDOFF_MS);
    finishNativeHandoff();
    if (onSuccess) onSuccess(null);
    emitAuthReady(null);
  }

  function showError(msg) {
    const el = $("authGateError");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  }

  async function submitPasswordLogin(gate) {
    const emailInput = gate.querySelector("#authEmail");
    const email = normalizeLoginEmail(emailInput?.value);
    if (emailInput && emailInput.value.trim().toLowerCase() !== email) {
      emailInput.value = email;
    }
    const password = gate.querySelector("#authPassword")?.value || "";
    if (!email || !password) {
      showError("Enter email and password.");
      return;
    }
    if (!getAuthApiBase()) {
      showError("Rainmaker API offline. Set rainmaker_api_base or use the published app.");
      return;
    }
    const btn = gate.querySelector("#authLoginBtn");
    if (btn) btn.disabled = true;
    showError("");
    try {
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!data?.token) {
        showError("Sign in failed — no session token.");
        return;
      }
      setSession(data.token, data.user);
      if (await validateSession({ retries: 2 })) {
        admitAuthenticated(true);
      } else {
        admitAuthenticated(true);
        refreshSessionInBackground();
      }
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        showError(
          "Cannot reach Rainmaker API. If you are on prod, hard-refresh — a bad localhost API URL may be cached."
        );
        return;
      }
      if (/invalid username|invalid email/i.test(msg)) {
        showError(
          email === OWNER_EMAIL
            ? "Invalid email or password. If this is prod, the API may need a deploy — try local at 127.0.0.1:8787."
            : "Invalid email or password."
        );
        return;
      }
      showError(msg);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wireGate(gate) {
    const openSplash = () => revealLoginCard(gate);
    gate.querySelector("#authGateSplash")?.addEventListener("click", openSplash);
    gate.querySelector("#authGateSplash")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openSplash();
      }
    });

    gate.querySelector("#authLoginForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void submitPasswordLogin(gate);
    });
  }

  let onSuccess = null;

  function completeLogin(token, user) {
    setSession(token, user);
    const gate = $(GATE_ID);
    if (!gate || !authRequired()) {
      hideGate();
      if (onSuccess) onSuccess(user);
      return;
    }
    const vid = gate.querySelector(".auth-gate-backdrop-video");
    const syncT = vid && Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
    document.documentElement.classList.add("auth-gate-handoff");
    gate.classList.add("auth-gate-handoff");
    setTimeout(() => {
      document.documentElement.classList.remove("auth-gate-open");
      if (global.RMHeaderBg) {
        try {
          global.RMHeaderBg.setVideoForMood("neutral");
        } catch (_) {}
      }
      if (global.RMHeaderMood?.setPreview) {
        try {
          global.RMHeaderMood.setPreview("neutral");
        } catch (_) {}
      }
      syncHeaderVideoTime(syncT);
      gate.classList.add("hidden");
      gate.classList.remove("auth-gate-handoff", "auth-gate-leave");
      gate.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("auth-gate-handoff");
      if (onSuccess) onSuccess(user);
    }, HANDOFF_MS);
  }

  function showGate() {
    document.documentElement.classList.add("auth-gate-open");
    const gate = $(GATE_ID);
    if (!gate) return;
    gate.classList.remove("hidden", "auth-gate-handoff", "auth-gate-leave");
    gate.setAttribute("aria-hidden", "false");
    mountAuthBackdrop(gate);
    gate.querySelector(".auth-gate-stage")?.remove();
    const stage = document.createElement("div");
    stage.innerHTML = renderGateHtml();
    const inner = stage.firstElementChild;
    if (inner) gate.appendChild(inner);
    wireGate(gate);
    revealLoginCard(gate);
    if (!getAuthApiBase()) {
      showError("Rainmaker API offline. Set rainmaker_api_base or use the published app.");
    }
  }

  function hideGate() {
    const gate = $(GATE_ID);
    if (!gate) return;
    gate.classList.add("auth-gate-leave");
    setTimeout(() => {
      gate.classList.add("hidden");
      gate.classList.remove("auth-gate-leave", "auth-gate-handoff");
      gate.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("auth-gate-open", "auth-gate-handoff");
    }, 420);
  }

  async function fetchRecentUsers() {
    try {
      const data = await apiFetch("/auth/recent-users?limit=20", { method: "GET" });
      return data?.users || [];
    } catch (_) {
      return [];
    }
  }

  async function registerPasskey() {
    if (!supportsWebAuthn() || !getToken()) return false;
    try {
      const optRes = await apiFetch("/auth/webauthn/register/options?appOrigin=" + encodeURIComponent(location.origin), {
        method: "POST",
        body: "{}",
      });
      const pub = prepPublicKeyOptions(optRes.options);
      const cred = await navigator.credentials.create({ publicKey: pub });
      if (!cred) return false;
      await apiFetch("/auth/webauthn/register/verify?appOrigin=" + encodeURIComponent(location.origin), {
        method: "POST",
        body: JSON.stringify({ credential: credToJson(cred) }),
      });
      return true;
    } catch (e) {
      console.warn("passkey register", e);
      return false;
    }
  }

  function b64urlJsonToObject(blob) {
    const pad = "=".repeat((4 - (blob.length % 4)) % 4);
    const b64 = blob.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return JSON.parse(atob(b64));
  }

  /** @returns {"error"|"fresh"|false} */
  function consumeOAuthReturn() {
    const params = new URLSearchParams(location.search);
    const err = params.get("rm_oauth_error");
    if (err) {
      if (authRequired()) showGate();
      showError(decodeURIComponent(err.replace(/\+/g, " ")));
      params.delete("rm_oauth_error");
      const q = params.toString();
      history.replaceState(
        null,
        "",
        location.pathname + (q ? "?" + q : "") + location.hash
      );
      return "error";
    }
    const hash = location.hash || "";
    if (!hash.startsWith("#rm_auth=")) return false;
    try {
      const blob = decodeURIComponent(hash.slice(9));
      const data = b64urlJsonToObject(blob);
      if (data.token) {
        history.replaceState(null, "", location.pathname + location.search);
        setSession(data.token, data.user);
        return "fresh";
      }
    } catch (_) {
      if (authRequired()) showGate();
      showError("Sign-in response could not be read. Try again.");
      history.replaceState(null, "", location.pathname + location.search);
      return "error";
    }
    return false;
  }

  let startPromise = null;

  function emitAuthReady(user) {
    document.dispatchEvent(
      new CustomEvent("rm:auth-ready", { detail: { user: user || getUser() } })
    );
  }

  function admitAuthenticated(freshOAuth) {
    const user = getUser();
    if (freshOAuth) {
      completeLogin(getToken(), user);
      emitAuthReady(user);
      return;
    }
    hideGate();
    if (onSuccess) onSuccess(user);
    emitAuthReady(user);
  }

  function trustFreshLoginHandoff() {
    return !!(getToken() && getUser()?.email);
  }

  function refreshSessionInBackground() {
    void validateSession({ retries: 1 }).catch(() => {});
  }

  async function start(callback) {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      onSuccess = callback;
      if (!authRequired()) {
        if (callback) callback(null);
        emitAuthReady(null);
        return;
      }

      const oauth = consumeOAuthReturn();
      if (oauth === "error") return;

      if (!getAuthApiBase()) {
        showGate();
        showError("Rainmaker API offline. Set rainmaker_api_base or use the published app.");
        return;
      }

      const freshOAuth = oauth === "fresh";
      if (await validateSession({ retries: freshOAuth ? 2 : 1 })) {
        admitAuthenticated(freshOAuth);
        return;
      }

      if (freshOAuth && trustFreshLoginHandoff()) {
        admitAuthenticated(true);
        refreshSessionInBackground();
        return;
      }

      if (freshOAuth) {
        showGate();
        showError(formatSessionFailMessage());
        return;
      }

      showGate();
    })();
    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function logout() {
    clearSession();
    location.reload();
  }

  global.RMAuthGate = {
    start,
    logout,
    getToken,
    getUser,
    authHeaders,
    getApiBase,
    authRequired,
    openSignIn: function () {
      /* Login only at boot — not from Account drawer. */
    },
    fetchRecentUsers,
    registerPasskey,
    validateSession,
    clearSession,
  };

})(typeof window !== "undefined" ? window : globalThis);

;
/* --- app.js --- */
(function () {
  const STORAGE_KEY = "rainmaker_ytd_" + new Date().getFullYear();
  const WS_COL_TITLE = {
    market: "Morning Pulse",
    chart: "Shape of Data",
    scans: "Target Trades",
  };

  let session = null;
  let activePick = null;
  let activeHolding = null;
  let instrument = "stock";
  let newsScanRunning = false;
  let marketScanRunning = false;
  let pickChartObserver = null;
  let pickListScanningSym = null;
  let historySelection = null;
  const SCANS_TAB_KEY = "rainmaker_scans_tab_v1";
  const SCANS_DISMISSED_KEY = "rainmaker_scans_dismissed_v1";
  let scansTab = "results";
  let schwabClosedTrades = [];

  const $ = (id) => document.getElementById(id);

  function loadScansTabPref() {
    try {
      const t = localStorage.getItem(SCANS_TAB_KEY);
      if (t === "results" || t === "strategy") scansTab = t;
      else if (t === "scan") scansTab = "results";
    } catch {
      /* ignore */
    }
  }

  function saveScansTabPref() {
    try {
      localStorage.setItem(SCANS_TAB_KEY, scansTab);
    } catch {
      /* ignore */
    }
  }

  function setScansTab(tab, opts) {
    const next = tab === "strategy" ? "strategy" : "results";
    scansTab = next;
    if (!opts?.skipSave) saveScansTabPref();
    document.querySelectorAll("[data-scans-tab]").forEach((btn) => {
      const on = btn.dataset.scansTab === next;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const panels = {
      results: $("scansTabResults"),
      strategy: $("scansTabStrategy"),
    };
    Object.keys(panels).forEach((key) => {
      const el = panels[key];
      if (!el) return;
      const on = key === next;
      el.classList.toggle("hidden", !on);
      el.hidden = !on;
    });
    if (next === "strategy") {
      const afterLearning = () => {
        renderStrategyTemplatesTab();
        refreshStrategyLearning();
        if (typeof RMResearch !== "undefined" && RMResearch.run) RMResearch.run(false);
        if (typeof RMGreenLitPanel !== "undefined" && RMGreenLitPanel.render) RMGreenLitPanel.render();
      };
      if (typeof RMChunkLoader !== "undefined") {
        void RMChunkLoader.ensureLearning().then(afterLearning);
      } else {
        afterLearning();
      }
      if (opts?.viaScrollDown) {
        window._rmStrategyBurstEligible = true;
      } else {
        window._rmStrategyBurstEligible = false;
      }
      document.dispatchEvent(new CustomEvent("rm:strategy-tab-shown"));
      if (opts?.viaScrollDown) {
        const carry = Math.max(0, Number(opts.scrollCarryPx) || 0);
        const scrollStrategyTop = () => {
          const scroll = document.querySelector("#scansTabStrategy .tt-strategy-scroll");
          if (!scroll) return;
          const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          scroll.scrollTop = carry > 0 ? Math.min(max, carry) : 0;
        };
        requestAnimationFrame(() => requestAnimationFrame(scrollStrategyTop));
      }
    }
    if (next === "results") {
      window._rmStrategyBurstEligible = false;
      renderResultsTab();
      if (typeof RMResultsHero !== "undefined" && !opts?.skipHero) {
        RMResultsHero.showDefault();
      }
      document.dispatchEvent(new CustomEvent("rm:results-tab-shown"));
      const scrollResults = () => {
        const scroll = document.querySelector("#scansTabResults .tt-results-scroll");
        if (!scroll) return;
        if (opts?.viaScrollUp) {
          const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          const carry = Math.max(0, Number(opts.scrollCarryPx) || 0);
          scroll.scrollTop = carry > 0 ? Math.max(0, max - carry) : max;
        } else {
          scroll.scrollTop = 0;
        }
      };
      if (opts?.viaScrollUp) {
        requestAnimationFrame(() => requestAnimationFrame(scrollResults));
      } else {
        requestAnimationFrame(scrollResults);
      }
    }
    updateResultsTabBadge();
  }

  function updateResultsTabBadge() {
    const btn = $("scansTabBtnResults");
    if (!btn) return;
    const n = session?.pick_count || session?.picks?.length || 0;
    const base = "Results";
    btn.textContent = n > 0 ? base + " · " + n : base;
  }

  function scansPanelDismissed() {
    try {
      return localStorage.getItem(SCANS_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setScansPanelDismissed(on) {
    const panel = $("workspaceScans");
    if (!panel) return;
    panel.classList.toggle("ws-panel--dismissed", !!on);
    panel.setAttribute("aria-hidden", on ? "true" : "false");
    try {
      if (on) localStorage.setItem(SCANS_DISMISSED_KEY, "1");
      else localStorage.removeItem(SCANS_DISMISSED_KEY);
    } catch {
      /* ignore */
    }
  }

  function clearScanSession() {
    session = null;
    activePick = null;
    historySelection = null;
    if (typeof RMChartHub !== "undefined") {
      RMChartHub.resetOverlays?.();
      RMChartHub.state.sessionPicks = [];
    }
    if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.state.symbol = "SPY";
      RMAnalysisChart.state.tradePlan = null;
      RMAnalysisChart.reload?.({ resetView: true });
    }
    setPickListHtml("");
    updateResultsActiveSection();
    if (typeof RMResultsHero !== "undefined") RMResultsHero.showDefault();
    renderCalendarUi(undefined, "drawer");
    renderCalendarUi(undefined, "results");
    refreshMarketAfterSessionClear();
    const picksHeading = $("picksHeading");
    if (picksHeading) picksHeading.textContent = WS_COL_TITLE.scans;
    setPageTitle("Rainmaker Morning");
    setHeaderMeta("");
    refreshScanButton();
  }

  function refreshMarketAfterSessionClear() {
    if (typeof RMMarket !== "undefined") {
      RMMarket.stopLivePickRefresh?.();
      const mp = $("marketPanel");
      if (mp) {
        void RMMarket.refreshMarketPanel(mp, [], { soft: false }).catch(() => {});
      }
    }
    const hi = $("marketHighlights");
    if (hi) {
      hi.innerHTML = "";
      hi.classList.add("hidden");
      hi.setAttribute("aria-hidden", "true");
    }
    refreshMarketThemes();
    refreshChartHub({ compare: false });
  }

  function dismissScansPanel() {
    clearScanSession();
    setScansTab("results");
    setScansPanelDismissed(true);
    status("Scan cleared · Target Trades hidden — use footer Import or Rainmaker scan");
    if (typeof RMWorkspaceAccordion !== "undefined") {
      RMWorkspaceAccordion.expand("chart");
    }
  }

  function showScansPanel() {
    setScansPanelDismissed(false);
  }

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function estimatePickPlan(p) {
    const entry = Number(p.last ?? p.open ?? p.price);
    if (!Number.isFinite(entry) || entry <= 0) return null;
    const stop = Math.round(entry * 0.98 * 100) / 100;
    const risk = entry - stop;
    const target = Math.round((entry + risk * 2) * 100) / 100;
    const qty = 100;
    const cost = entry * qty;
    const eodPct = Number(p.pct_eod ?? p.pct_change);
    const closePx = Number.isFinite(eodPct) ? entry * (1 + eodPct / 100) : null;
    const gainClose = closePx != null ? (closePx - entry) * qty : null;
    return { entry, stop, target, qty, cost, gainClose, eodPct };
  }

  function renderScanMetricsStrip() {
    const strip = $("scanMetricsStrip");
    if (!strip || !session?.picks?.length) {
      if (strip) strip.hidden = true;
      return;
    }
    const picks = sortPicksByGapUp(session.picks).slice(0, 12);
    let totalCost = 0;
    let totalGain = 0;
    let gainN = 0;
    let entrySum = 0;
    for (const p of picks) {
      const plan = estimatePickPlan(p);
      if (!plan) continue;
      entrySum += plan.entry;
      totalCost += plan.cost;
      if (plan.gainClose != null) {
        totalGain += plan.gainClose;
        gainN++;
      }
    }
    const avgEntry = picks.length ? entrySum / picks.length : null;
    const realized =
      typeof RMTradeMetrics !== "undefined"
        ? RMTradeMetrics.sessionStats(getTrades(), session.session_id)
        : null;
    strip.hidden = false;
    let html = "";
    if (realized) {
      html +=
        '<p class="tt-metrics-label">Realized · planned closes</p>' +
        '<div class="tt-metrics-grid tt-metrics-grid--realized">' +
        '<article class="tt-metric-card"><span class="tt-metric-kicker">Closed</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(String(realized.trades)) +
        '</strong><span class="tt-metric-sub">footer / drawer</span></article>' +
        '<article class="tt-metric-card"><span class="tt-metric-kicker">Expectancy</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(
          realized.avgR != null
            ? (realized.avgR >= 0 ? "+" : "") + realized.avgR.toFixed(2) + "R"
            : realized.pct + "%"
        ) +
        '</strong><span class="tt-metric-sub">' +
        escapeHtml(
          realized.avgR != null
            ? realized.wins + "/" + realized.trades + " winners"
            : "win rate (no stop data)"
        ) +
        "</span></article>" +
        '<article class="tt-metric-card"><span class="tt-metric-kicker">Total R</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(
          realized.totalR != null
            ? (realized.totalR >= 0 ? "+" : "") + realized.totalR.toFixed(2) + "R"
            : "—"
        ) +
        '</strong><span class="tt-metric-sub">sum of R-multiples</span></article>' +
        '<article class="tt-metric-card tt-metric-card--gain"><span class="tt-metric-kicker">P&amp;L</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(fmtUsd(realized.totalPnl)) +
        '</strong><span class="tt-metric-sub">realized $</span></article></div>';
    }
    html +=
      '<p class="tt-metrics-label">' +
      (realized ? "Model · scan prices" : "Session model") +
      "</p>" +
      '<div class="tt-metrics-grid">' +
      '<article class="tt-metric-card"><span class="tt-metric-kicker">Session</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(String(session.pick_count || picks.length)) +
      '</strong><span class="tt-metric-sub">gap-up picks</span></article>' +
      '<article class="tt-metric-card"><span class="tt-metric-kicker">Avg entry</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(avgEntry != null ? fmtUsd(avgEntry) : "—") +
      '</strong><span class="tt-metric-sub">model @ last</span></article>' +
      '<article class="tt-metric-card"><span class="tt-metric-kicker">Cost @ 100 sh</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(fmtUsd(totalCost)) +
      '</strong><span class="tt-metric-sub">notional deploy</span></article>' +
      '<article class="tt-metric-card tt-metric-card--gain"><span class="tt-metric-kicker">Gain @ close</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(gainN ? fmtUsd(totalGain) : "—") +
      '</strong><span class="tt-metric-sub">' +
      (gainN ? "sum EOD % × 100 sh" : "needs EOD %") +
      "</span></article></div>";
    strip.innerHTML = html;
  }

  function h001BacktestFootHtml(report) {
    if (!report?.summary) {
      return (
        '<span id="h001BacktestStat">Backtest · run on session picks</span>' +
        '<button type="button" class="btn-sm secondary" id="btnRunH001Backtest">Run backtest</button>'
      );
    }
    const s = report.summary;
    const avg =
      s.avgR != null
        ? (s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(2) + "R avg"
        : "no fills";
    const detail =
      s.n +
      " sim · " +
      s.hitTarget +
      " target · " +
      s.hitStop +
      " stop · " +
      s.noEntry +
      " no break";
    return (
      '<span id="h001BacktestStat">' +
      escapeHtml(avg) +
      " · " +
      escapeHtml(detail) +
      "</span>" +
      '<button type="button" class="btn-sm secondary" id="btnRunH001Backtest">Re-run</button>'
    );
  }

  function refreshStrategyBacktest() {
    const foot = $("h001BacktestFoot");
    if (!foot) return;
    const report =
      typeof RMBacktestH001 !== "undefined"
        ? RMBacktestH001.loadReport(backtestScopeId())
        : null;
    foot.innerHTML = h001BacktestFootHtml(report);
    $("btnRunH001Backtest")?.addEventListener("click", () => void runAllChartStrategyBacktests());
  }

  function renderCalibrationPanel() {
    const panel = $("ttCalibrationPanel");
    if (!panel || typeof RMCalibration === "undefined") return;
    const backtestRaw =
      typeof RMBacktestH001 !== "undefined"
        ? RMBacktestH001.loadReport(backtestScopeId())
        : null;
    panel.innerHTML =
      '<h4 class="tt-learning-title">Scanner calibration</h4>' +
      '<p class="meta">RM decile vs 1R hit rate — compare backtest simulation to live planned closes.</p>' +
      RMCalibration.renderPanel(session?.picks, backtestRaw, getTrades());
  }

  function renderMonthlyReviewPanel() {
    const panel = $("ttMonthlyReviewPanel");
    if (!panel || typeof RMMonthlyReview === "undefined") return;
    const backtestRaw =
      typeof RMBacktestH001 !== "undefined"
        ? RMBacktestH001.loadReport(backtestScopeId())
        : null;
    const m = RMMonthlyReview.autoMetrics(getTrades, session, backtestRaw);
    const driftWarn =
      m.driftR != null && Math.abs(m.driftR) >= 0.5
        ? '<p class="tt-review-warn">Drift live−backtest ' +
          (m.driftR >= 0 ? "+" : "") +
          m.driftR.toFixed(2) +
          "R — review assumptions before changing weights.</p>"
        : "";
    const drafts = RMMonthlyReview.loadDrafts();
    const draftOpts = drafts
      .map(
        (d) =>
          '<option value="' +
          escapeHtml(d.id) +
          '">' +
          escapeHtml(d.month || d.saved_at?.slice(0, 10) || d.id) +
          "</option>"
      )
      .join("");
    panel.innerHTML =
      '<h4 class="tt-learning-title">Monthly review</h4>' +
      '<p class="meta">One documented change per month → paste into <code>DECISIONS.log.md</code>.</p>' +
      driftWarn +
      '<div class="tt-review-metrics">' +
      '<span>Backtest: ' +
      escapeHtml(
        m.backtestAvgR != null
          ? (m.backtestAvgR >= 0 ? "+" : "") + m.backtestAvgR.toFixed(2) + "R (N=" + m.backtestN + ")"
          : "—"
      ) +
      "</span>" +
      '<span>Live: ' +
      escapeHtml(
        m.liveAvgR != null
          ? (m.liveAvgR >= 0 ? "+" : "") + m.liveAvgR.toFixed(2) + "R (N=" + m.liveN + ")"
          : "—"
      ) +
      "</span></div>" +
      (m.calibrationNote
        ? '<p class="meta tt-review-cal">' + escapeHtml(m.calibrationNote) + "</p>"
        : "") +
      '<label class="tt-review-field"><span>Decision (one change)</span>' +
      '<textarea id="reviewDecision" rows="3" placeholder="e.g. Raise RM gate to ≥55 — RM 50–69 band underperformed in live closes."></textarea></label>' +
      '<label class="tt-review-field"><span>After change (optional)</span>' +
      '<input type="text" id="reviewAfter" placeholder="e.g. Re-run backtest next session; target +0.3R avg" /></label>' +
      '<div class="tt-review-actions">' +
      '<button type="button" class="btn-sm primary" id="btnCopyReview">Copy DECISIONS entry</button>' +
      '<button type="button" class="btn-sm secondary" id="btnCopySetupCalib">Copy setup weight proposal</button>' +
      '<button type="button" class="btn-sm secondary" id="btnSaveReviewDraft">Save draft</button>' +
      (drafts.length
        ? '<select id="reviewDraftPick" class="tt-review-select"><option value="">Load draft…</option>' +
          draftOpts +
          "</select>"
        : "") +
      "</div>" +
      '<pre id="reviewPreview" class="tt-review-preview hidden" aria-live="polite"></pre>';
    $("btnCopyReview")?.addEventListener("click", () => copyMonthlyReviewEntry(m));
    $("btnCopySetupCalib")?.addEventListener("click", () => copySetupCalibrationEntry());
    $("btnSaveReviewDraft")?.addEventListener("click", () => saveMonthlyReviewDraft(m));
    $("reviewDraftPick")?.addEventListener("change", (e) => {
      const id = e.target.value;
      if (!id) return;
      const d = drafts.find((x) => x.id === id);
      if (d?.decision) $("reviewDecision").value = d.decision;
      if (d?.changeAfter) $("reviewAfter").value = d.changeAfter;
    });
  }

  function reviewFormValues() {
    return {
      decision: ($("reviewDecision")?.value || "").trim(),
      changeAfter: ($("reviewAfter")?.value || "").trim(),
    };
  }

  async function copySetupCalibrationEntry() {
    if (typeof RMMonthlyReview === "undefined" || !RMMonthlyReview.buildSetupCalibrationMarkdown) {
      status("Setup calibration unavailable");
      return;
    }
    const md = RMMonthlyReview.buildSetupCalibrationMarkdown(getTrades, {
      month: RMMonthlyReview.monthKey(),
    });
    const preview = $("reviewPreview");
    if (preview) {
      preview.textContent = md;
      preview.classList.remove("hidden");
    }
    const ok = await RMMonthlyReview.copyMarkdown(md);
    status(ok ? "Setup weight proposal copied" : "Copy failed — see preview below");
  }

  async function copyMonthlyReviewEntry(metrics) {
    if (typeof RMMonthlyReview === "undefined") return;
    const form = reviewFormValues();
    const md = RMMonthlyReview.buildDecisionsMarkdown({
      ...metrics,
      ...form,
      month: RMMonthlyReview.monthKey(),
    });
    const preview = $("reviewPreview");
    if (preview) {
      preview.textContent = md;
      preview.classList.remove("hidden");
    }
    const ok = await RMMonthlyReview.copyMarkdown(md);
    status(ok ? "DECISIONS entry copied — paste into DECISIONS.log.md" : "Copy failed — see preview below");
  }

  function saveMonthlyReviewDraft(metrics) {
    if (typeof RMMonthlyReview === "undefined") return;
    const form = reviewFormValues();
    RMMonthlyReview.saveDraft({
      month: RMMonthlyReview.monthKey(),
      ...metrics,
      ...form,
    });
    status("Review draft saved locally");
    renderMonthlyReviewPanel();
  }

  function refreshStrategyLearning(opts) {
    refreshStrategyCards();
    renderCalibrationPanel();
    renderMonthlyReviewPanel();
    if (!opts?.light && typeof scheduleChartStrategyBacktests === "function") {
      scheduleChartStrategyBacktests();
    }
  }

  let journeyFocus = null;

  function chartFocusCurrent() {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol) {
      const raw = RMAnalysisChart.state.symbol;
      if (typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromSelectKey) {
        return RMHoldings.chartFocusFromSelectKey(raw);
      }
    }
    if (activePick && typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromPick) {
      return RMHoldings.chartFocusFromPick(activePick);
    }
    return null;
  }

  function highlightJourneyOpenRow(detail) {
    const list = $("ttResultsOpenList");
    if (!list || !detail) return;
    list.querySelectorAll(".trade-item--active").forEach((el) => {
      el.classList.remove("trade-item--active");
    });
    const sym = String(detail.symbol || "")
      .trim()
      .toUpperCase();
    const selectKey = detail.selectKey;
    let row = null;
    if (selectKey) {
      row = list.querySelector(
        '[data-open-select-key="' + CSS.escape(String(selectKey)) + '"]'
      );
    }
    if (!row && sym) {
      row = [...list.querySelectorAll("[data-open-symbol]")].find(
        (el) =>
          String(el.getAttribute("data-open-symbol") || "")
            .trim()
            .toUpperCase() === sym
      );
    }
    if (row) row.classList.add("trade-item--active");
  }

  function dispatchTradeJourney(detail) {
    const focus = chartFocusCurrent();
    const sym =
      detail.symbol ||
      focus?.symbol ||
      focus?.displayKey ||
      (detail.selectKey ? String(detail.selectKey).toUpperCase() : null);
    const selectKey = detail.selectKey || focus?.selectKey || sym;
    const payload = {
      stage: detail.stage || "plan",
      symbol: sym,
      selectKey,
      plan: detail.plan,
      holding: detail.holding,
      source: detail.source || "app",
      ...detail,
    };
    if (payload.stage === "close") {
      journeyFocus = null;
      window.__rmJourneyFocus = null;
    } else {
      journeyFocus = { selectKey, symbol: sym, stage: payload.stage };
      window.__rmJourneyFocus = journeyFocus;
    }
    document.dispatchEvent(new CustomEvent("rm:trade-journey", { detail: payload }));
    if (payload.stage === "plan" || payload.stage === "close") {
      refreshStrategyLearning({ light: payload.stage === "plan" });
    }
    if (payload.stage === "open" || payload.stage === "plan") {
      highlightJourneyOpenRow(payload);
    }
  }

  window.dispatchTradeJourney = dispatchTradeJourney;
  window.chartFocusCurrent = chartFocusCurrent;

  let chartBtGen = 0;
  let chartBtTimer = null;
  let chartBtLastSym = "";

  function chartSymbolForBacktest() {
    if (typeof RMAnalysisChart === "undefined") return null;
    const raw = RMAnalysisChart.state?.symbol;
    if (!raw || raw === RMAnalysisChart.COMPARE_SYM) return null;
    if (typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolForSelectValue) {
      return RMHoldings.chartSymbolForSelectValue(raw) || null;
    }
    if (/^holding:/i.test(String(raw))) return null;
    return String(raw).toUpperCase();
  }

  function backtestScopeId() {
    const sym = chartSymbolForBacktest();
    if (sym) return "chart:" + sym;
    if (session?.session_id) return session.session_id;
    return "last";
  }

  function picksForBacktest() {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol === RMAnalysisChart.COMPARE_SYM) {
      return [];
    }
    const sym = chartSymbolForBacktest();
    if (sym) return [{ symbol: sym }];
    if (session?.picks?.length) return session.picks;
    return [];
  }

  function scheduleChartStrategyBacktests() {
    clearTimeout(chartBtTimer);
    chartBtTimer = setTimeout(() => {
      void runAllChartStrategyBacktests({ silent: true });
    }, 650);
  }

  async function runAllChartStrategyBacktests(opts) {
    if (typeof RMStrategies === "undefined" || typeof RMBacktestH001 === "undefined") return;
    const picks = picksForBacktest();
    const sym = picks[0]?.symbol;
    if (!picks.length || !sym) return;
    const live = RMStrategies.list().filter((s) => s.status === "live");
    if (!live.length) return;
    const gen = ++chartBtGen;
    if (!opts?.silent) status("Backtesting " + sym + " · " + live.length + " strategies…");
    for (const s of live) {
      if (gen !== chartBtGen) return;
      await runH001BacktestForSession(s.id, { silent: true, picks });
    }
    if (gen !== chartBtGen) return;
    refreshStrategyLearning();
    if (!opts?.silent) status("Strategy backtests updated · " + sym);
  }

  async function runH001BacktestForSession(strategyId, opts) {
    const picks = opts?.picks || picksForBacktest();
    if (!picks.length) {
      if (!opts?.silent) status("Select a symbol on the chart or load a scan to backtest");
      return;
    }
    const chartOnly = !!chartSymbolForBacktest() && picks.length === 1 && picks[0].symbol === chartSymbolForBacktest();
    const strat =
      typeof RMStrategies !== "undefined"
        ? typeof strategyId === "string"
          ? RMStrategies.get(strategyId)
          : RMStrategies.getActive()
        : null;
    const rr = strat?.rr ?? 2;
    const entryRule = strat?.entryRule || "orh";
    if (!opts?.silent) {
      status(
        "Backtest \u00b7 " +
          (strat?.name || "ORH") +
          (chartOnly ? " \u00b7 " + picks[0].symbol + " (chart)" : "") +
          " \u00b7 1mo \u00b7 5m \u00b7 fetching\u2026"
      );
    }
    try {
      if (typeof RMBacktestH001 === "undefined") throw new Error("backtest module missing");
      const runFn = RMBacktestH001.runSessionPreferred || RMBacktestH001.runSession;
      let report;
      let offline = false;
      if (RMBacktestH001.runSessionPreferred) {
        const out = await RMBacktestH001.runSessionPreferred(picks, {
          sessionId: backtestScopeId(),
          limit: 8,
          rr,
          entryRule,
          strategyId: strat?.id,
          range: "1mo",
          interval: "5m",
        });
        report = out.report;
        offline = out.offline;
      } else {
        report = await runFn(picks, {
          sessionId: backtestScopeId(),
          limit: 8,
          rr,
          entryRule,
          strategyId: strat?.id,
        });
      }
      if (!opts?.silent) refreshStrategyLearning();
      const s = report.summary;
      const symCount =
        report.symbolCount ??
        new Set((report.results || []).map((r) => r.symbol).filter(Boolean)).size;
      const tradeLabel = (s.n || 0) + " trade" + (s.n === 1 ? "" : "s");
      const symLabel = symCount + " symbol" + (symCount === 1 ? "" : "s");
      if (!opts?.silent) {
        status(
          (offline ? "Backtest (offline, today only) \u00b7 " : "Backtest done \u00b7 ") +
            (s.avgR != null ? (s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(2) + "R avg" : "no entries") +
            " (" +
            tradeLabel +
            " \u00b7 " +
            symLabel +
            ")"
        );
      }
      return report;
    } catch (e) {
      if (!opts?.silent) status("Backtest error: " + (e.message || e));
      throw e;
    }
  }

  function fmtRr(rr) {
    return Number.isInteger(rr) ? String(rr) : Number(rr).toFixed(1);
  }

  // 2-state strategy board (item 18, mirrors the news list<->full pattern): the
  // Scan>Strategy tab shows a card list by default; clicking a card opens a full
  // detail view; "Back" returns to the list. No middle/preview state.
  let strategyDetailId = null;

  function strategyPerfLabel(perf) {
    if (!perf || perf.n == null || perf.n === 0) return null;
    const parts = [];
    if (perf.avgR != null) parts.push((perf.avgR >= 0 ? "+" : "") + perf.avgR.toFixed(2) + "R");
    if (perf.winRate != null) parts.push(perf.winRate + "% win");
    parts.push(perf.n + " trade" + (perf.n === 1 ? "" : "s"));
    return parts.join(" \u00b7 ");
  }

  function strategyCardHtml(s, activeId, perf) {
    const isActive = s.id === activeId;
    const live = s.status === "live";
    const rrLabel = "R:R " + fmtRr(s.rr) + ":1";
    const rules = (s.rules || []).map((r) => "<li>" + escapeHtml(r) + "</li>").join("");
    let foot;
    if (!live) {
      foot = '<span class="tt-strategy-perf tt-strategy-perf--soon">Coming soon</span>';
    } else {
      const label = strategyPerfLabel(perf);
      const perfSpan =
        '<span class="tt-strategy-perf' +
        (label ? " tt-strategy-perf--has" : "") +
        '">' +
        (label ? escapeHtml(label) : "Backtest to score") +
        "</span>";
      const useBtn = isActive
        ? '<button type="button" class="btn-sm tt-strat-use is-active" disabled>Active</button>'
        : '<button type="button" class="btn-sm tt-strat-use" data-strat-use="' +
          s.id +
          '">Use</button>';
      const btBtn =
        '<button type="button" class="btn-sm secondary" data-strat-backtest="' +
        s.id +
        '">Backtest</button>';
      foot = perfSpan + '<span class="tt-strategy-foot-actions">' + useBtn + btBtn + "</span>";
    }
    return (
      '<article class="tt-strategy-card' +
      (isActive ? " tt-strategy-card--active" : "") +
      (live ? "" : " tt-strategy-card--soon") +
      '" data-strat-id="' +
      s.id +
      '">' +
      '<header class="tt-strategy-card-head"><span class="tt-strategy-badge">' +
      escapeHtml(s.badge) +
      '</span><span class="tt-strategy-risk">' +
      rrLabel +
      "</span></header>" +
      "<h4>" +
      escapeHtml(s.name) +
      "</h4>" +
      '<p class="meta">' +
      escapeHtml(s.summary) +
      "</p>" +
      (rules ? '<ul class="tt-strategy-rules">' + rules + "</ul>" : "") +
      '<footer class="tt-strategy-foot">' +
      foot +
      "</footer></article>"
    );
  }

  // Persona + Setup context for the Scan>Strategy tab (item 13). The OOTB setup
  // is "Rainmaker Morning Momentum" (the H-001 active strategy). Persona is
  // switchable and remembered via RMStrategies.setPersona.
  function strategyPersonaBarHtml(active) {
    if (typeof RMStrategies?.getPersona !== "function") return "";
    const persona = RMStrategies.getPersona();
    const personaList = RMStrategies.personas ? RMStrategies.personas() : [];
    const opts = personaList
      .map(
        (p) =>
          '<option value="' +
          escapeHtml(p.id) +
          '"' +
          (p.id === persona.id ? " selected" : "") +
          (p.status !== "live" ? " disabled" : "") +
          ">" +
          escapeHtml(p.name) +
          (p.status !== "live" ? " (soon)" : "") +
          "</option>"
      )
      .join("");
    const setupName = active?.id === RMStrategies.DEFAULT_ACTIVE_ID ? "Rainmaker Morning Momentum" : active?.name;
    return (
      '<div class="tt-persona-bar">' +
      '<label class="tt-persona-field"><span class="tt-persona-label">Persona</span>' +
      '<select class="tt-persona-select" data-persona-select>' +
      opts +
      "</select></label>" +
      '<div class="tt-persona-field"><span class="tt-persona-label">Setup</span>' +
      '<span class="tt-persona-setup">' +
      escapeHtml(setupName || "\u2014") +
      "</span></div>" +
      "</div>"
    );
  }

  function strategyDetailHtml(s, activeId, perf) {
    const isActive = s.id === activeId;
    const live = s.status === "live";
    const rules = (s.rules || []).map((r) => "<li>" + escapeHtml(r) + "</li>").join("");
    const label = live ? strategyPerfLabel(perf) : null;
    const useBtn = !live
      ? '<span class="tt-strategy-perf tt-strategy-perf--soon">Coming soon</span>'
      : isActive
        ? '<button type="button" class="btn-sm tt-strat-use is-active" disabled>Active</button>'
        : '<button type="button" class="btn-sm tt-strat-use" data-strat-use="' +
          s.id +
          '">Use this strategy</button>';
    const btBtn = live
      ? '<button type="button" class="btn-sm secondary" data-strat-backtest="' + s.id + '">Backtest</button>'
      : "";
    // Item 14: desktop-only "learn" affordance - a data-bearing element that can
    // push itself into the Results hero scan tab. Mobile flow deferred.
    const isDesktop =
      typeof global.matchMedia === "function" ? global.matchMedia("(min-width: 641px)").matches : true;
    const heroBtn =
      live && isDesktop
        ? '<button type="button" class="btn-sm tt-strat-learn" data-strat-hero="' +
          s.id +
          '">\u26a1 Preview in hero</button>'
        : "";
    return (
      '<div class="tt-strategy-detail" data-strat-id="' +
      s.id +
      '">' +
      '<button type="button" class="tt-strategy-back" data-strat-back="1">\u2190 All strategies</button>' +
      '<header class="tt-strategy-detail-head">' +
      '<span class="tt-strategy-badge">' +
      escapeHtml(s.badge) +
      "</span>" +
      "<h3>" +
      escapeHtml(s.name) +
      "</h3>" +
      '<span class="tt-strategy-risk">R:R ' +
      fmtRr(s.rr) +
      ":1</span>" +
      "</header>" +
      '<p class="tt-strategy-detail-summary">' +
      escapeHtml(s.summary) +
      "</p>" +
      (label
        ? '<p class="tt-strategy-perf tt-strategy-perf--has">' + escapeHtml(label) + "</p>"
        : live
          ? '<p class="meta">Runs automatically for the chart symbol · tap Backtest to refresh.</p>'
          : "") +
      (rules ? '<ul class="tt-strategy-rules tt-strategy-rules--detail">' + rules + "</ul>" : "") +
      '<footer class="tt-strategy-detail-foot">' +
      useBtn +
      btBtn +
      heroBtn +
      "</footer>" +
      "</div>"
    );
  }

  function strategyBacktestMetaHtml() {
    const sym = chartSymbolForBacktest();
    const label = sym || (session?.picks?.length ? "session picks" : "\u2014");
    return (
      '<div class="tt-strategy-bt-meta">' +
      '<span class="meta">Backtests follow the chart' +
      (sym ? " · <strong>" + escapeHtml(sym) + "</strong>" : "") +
      " · auto-refresh on load</span>" +
      '<button type="button" class="btn-sm secondary" id="btnRefreshChartBacktests">Refresh</button>' +
      "</div>"
    );
  }

  function renderStrategyTemplatesTab() {
    const root = $("pickListStrategy");
    if (!root || typeof RMStrategies === "undefined") return;
    const scope = backtestScopeId();
    const active = RMStrategies.getActive();
    // Detail (full) state: a single strategy expanded with a Back button.
    if (strategyDetailId) {
      const s = RMStrategies.get(strategyDetailId);
      if (s) {
        const report =
          typeof RMBacktestH001 !== "undefined" && s.status === "live"
            ? RMBacktestH001.loadReport(scope, s.id)
            : null;
        const perf = typeof RMStrategies.perfFor === "function" ? RMStrategies.perfFor(s, report) : null;
        root.innerHTML = strategyDetailHtml(s, active.id, perf);
        bindStrategyBoard(root);
        return;
      }
      strategyDetailId = null;
    }
    const ranked =
      typeof RMBacktestH001 !== "undefined"
        ? RMStrategies.rankRecommended(RMBacktestH001.loadReport, scope)
        : RMStrategies.recommended().map((s) => ({ strategy: s, perf: null }));
    const cards = ranked
      .map(({ strategy, perf }) => strategyCardHtml(strategy, active.id, perf))
      .join("");
    root.innerHTML =
      strategyPersonaBarHtml(active) +
      strategyBacktestMetaHtml() +
      '<div class="tt-strategy-active">' +
      '<div class="tt-strategy-active-copy"><span class="tt-strategy-active-kicker">Active strategy</span>' +
      '<span class="tt-strategy-active-name">\u26a1 ' +
      escapeHtml(active.name) +
      " \u00b7 R:R " +
      fmtRr(active.rr) +
      ":1</span></div>" +
      '<span class="tt-strategy-active-hint">Drives the target-trade footer</span></div>' +
      '<div class="tt-strategy-section-head"><h3 class="tt-strategy-title">Recommended</h3>' +
      '<span class="meta">ORH / VWAP engines scored on chart symbol · 1mo when API is up · today-only offline fallback.</span></div>' +
      '<div class="tt-strategy-grid">' +
      cards +
      "</div>" +
      '<div class="tt-strategy-section-head"><h3 class="tt-strategy-title">My strategies</h3></div>' +
      '<div class="tt-strategy-mine">' +
      '<p class="meta">Build your own from a template or a prompt \u2014 coming soon.</p>' +
      '<button type="button" class="btn-sm secondary" data-strat-new="1">+ New strategy</button>' +
      "</div>" +
      setupAttributionSectionHtml(active.id);
    bindStrategyBoard(root);
  }

  function setupAttributionSectionHtml(playId) {
    if (typeof RMSetupAttribution === "undefined") {
      return "";
    }
    const report = RMSetupAttribution.buildReport(getTrades(), { play_id: playId });
    return RMSetupAttribution.renderWinnersTable(report);
  }

  function bindStrategyBoard(root) {
    if (!root) return;
    if (root._stratChange) root.removeEventListener("change", root._stratChange);
    root._stratChange = (e) => {
      const sel = e.target.closest("[data-persona-select]");
      if (!sel) return;
      if (RMStrategies.setPersona(sel.value)) {
        const p = RMStrategies.getPersona();
        status("Persona \u2192 " + p.name);
      } else {
        status("That persona isn\u2019t available yet");
      }
      renderStrategyTemplatesTab();
    };
    root.addEventListener("change", root._stratChange);
    if (root._stratClick) root.removeEventListener("click", root._stratClick);
    root._stratClick = (e) => {
      if (e.target.closest("#btnRefreshChartBacktests")) {
        void runAllChartStrategyBacktests();
        return;
      }
      if (e.target.closest("[data-strat-back]")) {
        strategyDetailId = null;
        renderStrategyTemplatesTab();
        return;
      }
      const useId = e.target.closest("[data-strat-use]")?.dataset.stratUse;
      if (useId) return useStrategy(useId);
      const btId = e.target.closest("[data-strat-backtest]")?.dataset.stratBacktest;
      if (btId) return void runH001BacktestForSession(btId);
      const heroId = e.target.closest("[data-strat-hero]")?.dataset.stratHero;
      if (heroId) return previewStrategyInHero(heroId);
      if (e.target.closest("[data-strat-new]")) {
        status("Custom strategies \u2014 coming soon");
        return;
      }
      const card = e.target.closest(".tt-strategy-card[data-strat-id]");
      if (card) {
        strategyDetailId = card.dataset.stratId;
        renderStrategyTemplatesTab();
      }
    };
    root.addEventListener("click", root._stratClick);
  }

  // Item 14: make the strategy "alive" - set it active and push the resolved
  // focus symbol into the Results hero (which opens the Results tab).
  function previewStrategyInHero(id) {
    if (typeof RMStrategies === "undefined") return;
    RMStrategies.setActive(id);
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh();
    const hero = global.RMResultsHero;
    if (!hero || typeof hero.showSetup !== "function") {
      status("Hero preview unavailable");
      return;
    }
    let sym = "";
    try {
      sym = hero.resolveFocusSymbol ? hero.resolveFocusSymbol() : "";
    } catch (_) {}
    if (!sym) sym = (session?.picks && session.picks[0]?.symbol) || "SPY";
    void hero.showSetup(sym);
    const s = RMStrategies.get(id);
    status("Previewing " + (s ? s.name : "strategy") + " in hero \u2192 " + sym);
  }

  function useStrategy(id) {
    if (typeof RMStrategies === "undefined") return;
    if (!RMStrategies.setActive(id)) {
      status("That strategy isn\u2019t available yet");
      return;
    }
    renderStrategyTemplatesTab();
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh();
    const s = RMStrategies.getActive();
    status("Active strategy \u2192 " + s.name + " (R:R " + fmtRr(s.rr) + ":1)");
  }

  function refreshStrategyCards() {
    if (!$("scansTabStrategy")?.hidden) renderStrategyTemplatesTab();
  }

  let publishedSessionCache = null;
  let publishedSessionCacheDone = false;

  async function getPublishedSessionOffer() {
    if (publishedSessionCacheDone) return publishedSessionCache;
    publishedSessionCacheDone = true;
    publishedSessionCache = await fetchPublishedSession();
    return publishedSessionCache;
  }

  function publishedEntryHtml(data) {
    if (!data?.picks?.length) return "";
    const label = (data.scanned_at || "").slice(0, 16).replace("T", " ") || "Published";
    return (
      '<button type="button" class="calendar-entry calendar-entry--published" id="ttLoadPublishedScan">' +
      '<span class="cal-entry-kind">Published</span> ' +
      escapeHtml(label) +
      " · " +
      (data.pick_count || data.picks.length) +
      " picks · session.json" +
      '<span class="cal-entry-hint">Tap to load into Results</span></button>'
    );
  }

  function bindPublishedEntry() {
    $("ttLoadPublishedScan")?.addEventListener("click", () => loadPublishedSessionInteractive());
  }

  function renderResultsTab() {
    updateResultsActiveSection();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    renderCalibrationPanel();
    renderMonthlyReviewPanel();
    document.dispatchEvent(new CustomEvent("rm:results-content-updated"));
    /* Hero is driven by RMResultsHero (setScansTab / chart clicks), not reset here. */
  }

  function collectOpenPositionRows() {
    const rows = [];
    const seen = new Set();
    const display =
      typeof RMHoldings !== "undefined" && RMHoldings.getDisplayOpen
        ? RMHoldings.getDisplayOpen()
        : [];
    display.forEach((h) => {
      const sym = String(h.symbol || "").toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      rows.push({ kind: "holding", holding: h, symbol: sym });
    });
    getTrades()
      .filter((t) => t && t.status === "open")
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(b.opened_at || "") || 0) - (Date.parse(a.opened_at || "") || 0)
      )
      .forEach((t) => {
        const sym = String(t.symbol || "").toUpperCase();
        if (!sym || seen.has(sym)) return;
        seen.add(sym);
        rows.push({ kind: "journal", trade: t, symbol: sym });
      });
    return rows;
  }

  function openRowDisplaySym(sym) {
    if (
      typeof RMHoldings !== "undefined" &&
      RMHoldings.isOptionSymbol?.(sym) &&
      RMHoldings.formatOptionLabel
    ) {
      return RMHoldings.formatOptionLabel(sym);
    }
    return sym;
  }

  function openRowPnlSpan(holdingOrTrade, kind) {
    let pnl = null;
    if (kind === "holding" && typeof RMHoldings !== "undefined" && RMHoldings.openPositionPnl) {
      pnl = RMHoldings.openPositionPnl(holdingOrTrade);
    }
    if (pnl == null || pnl.dollars == null) return "";
    const cls = pnl.dollars >= 0 ? "rm-open-pnl--pos" : "rm-open-pnl--neg";
    const sign = pnl.dollars >= 0 ? "+" : "";
    return (
      '<span class="rm-open-row-pnl rm-open-pnl ' +
      cls +
      '">' +
      sign +
      fmtUsd(pnl.dollars) +
      "</span>"
    );
  }

  function renderOpenPositionRow(row) {
    const sym = row.symbol;
    const title = escapeHtml(openRowDisplaySym(sym));
    let rowId = "";
    let selectKey = sym;
    let meta = "";
    let pnl = "";

    if (row.kind === "holding") {
      const h = row.holding;
      rowId = h.id || "";
      selectKey =
        typeof RMHoldings !== "undefined" && RMHoldings.holdingSelectValue
          ? RMHoldings.holdingSelectValue(h)
          : sym;
      const isOpt =
        h.instrument === "option" ||
        (typeof RMHoldings !== "undefined" && RMHoldings.isOptionSymbol?.(sym));
      const parts = [];
      const qty = Math.abs(Number(h.quantity) || 0);
      if (qty) parts.push(qty + (isOpt ? " ct" : " sh"));
      if (h.entry_price != null) {
        parts.push("avg $" + Number(h.entry_price).toFixed(2) + (isOpt ? " prem" : ""));
      }
      meta = escapeHtml(parts.join(" · "));
      pnl = openRowPnlSpan(h, "holding");
    } else {
      const t = row.trade;
      rowId = t.id || "";
      const isOpt = t.instrument === "option";
      const parts = [];
      const entry = isOpt ? t.entry_premium ?? t.entry_price : t.entry_price;
      if (entry != null) {
        parts.push("entry $" + Number(entry).toFixed(2) + (isOpt ? " prem" : ""));
      }
      const when = (t.opened_at || "").slice(0, 10);
      if (when) parts.push(when);
      meta = escapeHtml(parts.join(" · "));
    }

    return (
      '<div class="rm-open-row trade-item trade-item--click" data-open-row-id="' +
      escapeHtml(rowId) +
      '" data-open-kind="' +
      escapeHtml(row.kind) +
      '" data-open-symbol="' +
      escapeHtml(sym) +
      '" data-open-select-key="' +
      escapeHtml(selectKey) +
      '" role="button" tabindex="0" title="Show on chart">' +
      '<div class="rm-open-row-head">' +
      '<span class="rm-open-row-title">' +
      title +
      "</span>" +
      pnl +
      "</div>" +
      (meta ? '<div class="rm-open-row-meta">' + meta + "</div>" : "") +
      "</div>"
    );
  }

  function renderResultsOpenTrades() {
    if (typeof RMResultsHero !== "undefined" && RMResultsHero.refreshOpenRail) {
      RMResultsHero.refreshOpenRail();
    }
    if (journeyFocus) highlightJourneyOpenRow(journeyFocus);
  }

  function resolveOpenRowHolding(rowEl) {
    const kind = rowEl.getAttribute("data-open-kind");
    const rowId = rowEl.getAttribute("data-open-row-id");
    const rowSym = rowEl.getAttribute("data-open-symbol");
    if (kind === "holding" && typeof RMHoldings !== "undefined") {
      const rows = RMHoldings.getDisplayOpen?.() || [];
      if (rowId) {
        const hit =
          rows.find((h) => String(h.id) === String(rowId)) ||
          rows.find((h) => String(h.id).toLowerCase() === String(rowId).toLowerCase());
        if (hit) return hit;
      }
      if (rowSym) {
        const symKey = String(rowSym).trim().toUpperCase();
        const hit = rows.find((h) => String(h.symbol || "").trim().toUpperCase() === symKey);
        if (hit) return hit;
      }
    }
    if (kind === "journal" && rowId) {
      const t = getTrades().find((x) => String(x.id) === String(rowId));
      if (!t) return null;
      return {
        id: t.id,
        symbol: t.symbol,
        instrument: t.instrument || "stock",
        entry_price: t.entry_premium ?? t.entry_price,
        quantity: t.quantity,
        source: t.source || "journal",
        status: "open",
      };
    }
    return null;
  }

  function focusOpenPositionOnChart(h) {
    if (!h?.symbol) return;
    showScansPanel();
    if (scansTab !== "results") setScansTab("results", { skipHero: true });
    void openHoldingOnChart(h);
  }

  function initOpenListDelegation() {
    const list = $("ttResultsOpenList");
    if (!list || list.dataset.openWired === "1") return;
    list.dataset.openWired = "1";
    list.addEventListener("click", (ev) => {
      const row = ev.target.closest(".trade-item[data-open-row-id]");
      if (!row) return;
      const h = resolveOpenRowHolding(row);
      if (!h) return;
      list.querySelectorAll(".trade-item--active").forEach((el) => {
        el.classList.remove("trade-item--active");
      });
      row.classList.add("trade-item--active");
      focusOpenPositionOnChart(h);
    });
    list.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest(".trade-item[data-open-row-id]");
      if (!row) return;
      ev.preventDefault();
      row.click();
    });
  }

  function tradeRMultiple(t) {
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.rMultiple) {
      const r = RMTradeMetrics.rMultiple(t);
      return r != null && Number.isFinite(r) ? r : null;
    }
    return t.r_multiple != null && Number.isFinite(t.r_multiple) ? t.r_multiple : null;
  }

  function tradePnl(t) {
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.pnlUsd) {
      const p = RMTradeMetrics.pnlUsd(t);
      return p != null && Number.isFinite(p) ? p : null;
    }
    return t.pnl_usd != null && Number.isFinite(t.pnl_usd) ? t.pnl_usd : null;
  }

  function computeJournalStats(trades) {
    const closed = (trades || [])
      .filter((t) => t && t.status === "closed" && t.filled !== false)
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(a.closed_at || a.opened_at || "") || 0) -
          (Date.parse(b.closed_at || b.opened_at || "") || 0)
      );
    let wins = 0;
    let winN = 0;
    let rSum = 0;
    let rN = 0;
    let pnl = 0;
    let pnlSeen = false;
    let cum = 0;
    const equity = [];
    for (const t of closed) {
      const r = tradeRMultiple(t);
      if (r != null) {
        cum += r;
        rSum += r;
        rN++;
        equity.push(Math.round(cum * 100) / 100);
      }
      const entry = t.entry_price ?? t.entry_premium;
      const exit = t.exit_price;
      if (entry != null && exit != null) {
        winN++;
        if (exit > entry) wins++;
      }
      const p = tradePnl(t);
      if (p != null) {
        pnl += p;
        pnlSeen = true;
      }
    }
    return {
      trades: closed.length,
      winPct: winN ? Math.round((wins / winN) * 100) : null,
      winN,
      wins,
      avgR: rN ? Math.round((rSum / rN) * 100) / 100 : null,
      totalR: rN ? Math.round(rSum * 100) / 100 : null,
      totalPnl: pnlSeen ? Math.round(pnl * 100) / 100 : null,
      equity,
    };
  }

  function equitySparklineSvg(values, w, h) {
    if (!values || values.length < 2) return "";
    const width = w || 200;
    const height = h || 40;
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = max - min || 1;
    const stepX = width / (values.length - 1);
    const y = (v) => height - ((v - min) / range) * height;
    const pts = values
      .map((v, i) => (i * stepX).toFixed(1) + "," + y(v).toFixed(1))
      .join(" ");
    const last = values[values.length - 1];
    const cls = last >= 0 ? "is-pos" : "is-neg";
    return (
      '<svg class="rm-equity ' +
      cls +
      '" viewBox="0 0 ' +
      width +
      " " +
      height +
      '" preserveAspectRatio="none" role="img" aria-label="Cumulative R equity curve">' +
      '<line class="rm-equity-zero" x1="0" y1="' +
      y(0).toFixed(1) +
      '" x2="' +
      width +
      '" y2="' +
      y(0).toFixed(1) +
      '"></line>' +
      '<polyline points="' +
      pts +
      '"></polyline>' +
      "</svg>"
    );
  }

  function renderResultsPerformance() {
    if (typeof RMResultsHero !== "undefined" && RMResultsHero.refreshPerfStrip) {
      RMResultsHero.refreshPerfStrip();
      return;
    }
    const el = $("ttResultsPerfStrip") || $("ttResultsPerf");
    if (!el) return;
    const s = computeJournalStats(getJournalTrades());
    if (!s.trades) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
  }

  function renderResultsClosedTrades() {
    renderResultsPerformance();
    const el = $("ttResultsClosedList");
    const meta = $("ttResultsClosedMeta");
    if (!el) return;
    const closed = getJournalTrades().filter((t) => t.status === "closed");
    if (!closed.length) {
      el.innerHTML =
        '<p class="cal-list-empty">No closed trades yet. Connect Schwab and sync fills, or close a setup in the footer.</p>';
      if (meta) meta.textContent = "";
      return;
    }
    const schwabN = closed.filter((t) => t.source === "schwab_api").length;
    const recentSchwabN =
      typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
        ? closed.filter((t) => RMSchwabData.isRecentSchwabClose(t)).length
        : 0;
    if (meta) {
      meta.textContent =
        closed.length +
        " closed · YTD log" +
        (schwabN ? " · " + schwabN + " from Schwab" : "") +
        (recentSchwabN ? " · " + recentSchwabN + " this week" : "");
    }
    const sorted = closed.slice().sort((a, b) => {
      const aRecent =
        typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
          ? RMSchwabData.isRecentSchwabClose(a)
          : false;
      const bRecent =
        typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
          ? RMSchwabData.isRecentSchwabClose(b)
          : false;
      if (aRecent !== bRecent) return aRecent ? -1 : 1;
      return (
        (Date.parse(b.closed_at || b.opened_at || "") || 0) -
        (Date.parse(a.closed_at || a.opened_at || "") || 0)
      );
    });
    el.innerHTML = sorted
      .map((t) => {
        const isOpt = t.instrument === "option";
        const isRecent =
          typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
            ? RMSchwabData.isRecentSchwabClose(t)
            : false;
        let line =
          "<strong>" +
          escapeHtml(t.symbol) +
          "</strong> " +
          escapeHtml(t.instrument || "stock");
        if (t.source === "schwab_api") line += ' <span class="rm-schwab-badge">Schwab</span>';
        if (isRecent) line += ' <span class="rm-debrief-recent-badge">This week</span>';
        const entry = isOpt ? t.entry_premium ?? t.entry_price : t.entry_price;
        const exit = isOpt ? t.exit_premium ?? t.exit_price : t.exit_price;
        if (entry != null) line += " · entry " + Number(entry).toFixed(2) + (isOpt ? " prem" : "");
        if (exit != null) line += " · exit " + Number(exit).toFixed(2) + (isOpt ? " prem" : "");
        const pr = typeof RMTradeMetrics !== "undefined" ? RMTradeMetrics.planR(t) : null;
        const rr =
          typeof RMTradeMetrics !== "undefined"
            ? RMTradeMetrics.realizedR(t) ?? tradeRMultiple(t)
            : tradeRMultiple(t);
        if (pr != null && rr != null && typeof RMTradeMetrics !== "undefined") {
          line +=
            ' · <span class="rm-dual-r">' +
            escapeHtml(RMTradeMetrics.fmtDualTrack(t)) +
            "</span>";
        } else if (rr != null) {
          line += " · " + (rr >= 0 ? "+" : "") + Number(rr).toFixed(2) + "R";
        } else if (!isPlannedTrade(t) && isOpt) {
          line += " · R N/A";
        }
        if (t.pnl_usd != null) line += " · " + fmtUsd(t.pnl_usd);
        const when = (t.closed_at || t.opened_at || "").slice(0, 10);
        if (when) line += " · " + escapeHtml(when);
        const debriefBtn =
          t.id &&
          ((isRecent && t.source === "schwab_api") ||
            (t.planned !== false && (t.source === "footer" || t.source === "dashboard")))
            ? ' <button type="button" class="btn-link rm-debrief-btn" data-debrief-id="' +
              escapeHtml(t.id || "") +
              '">What happened?</button>'
            : "";
        const rowClass =
          "trade-item trade-item--click" +
          (isRecent ? " trade-item--recent-schwab" : "");
        return (
          '<div class="' +
          rowClass +
          '" data-trade-id="' +
          escapeHtml(t.id || "") +
          '" role="button" tabindex="0" title="Show on chart">' +
          line +
          debriefBtn +
          "</div>"
        );
      })
      .join("");
    document.dispatchEvent(new CustomEvent("rm:results-closed-rendered"));
  }

  function isPlannedTrade(t) {
    return typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.isPlannedTrade
      ? RMTradeMetrics.isPlannedTrade(t)
      : t.planned !== false && t.source !== "schwab_api";
  }

  function updateResultsActiveSection() {
    const block = $("ttResultsActive");
    const title = $("ttResultsActiveTitle");
    const meta = $("ttResultsActiveMeta");
    if (!block) return;
    const has = !!(session?.picks?.length);
    block.classList.toggle("hidden", !has);
    block.hidden = !has;
    if (!has) {
      delete block.dataset.actionsWired;
      if ($("scanMetricsStrip")) {
        $("scanMetricsStrip").hidden = true;
        $("scanMetricsStrip").innerHTML = "";
      }
      updateResultsTabBadge();
      return;
    }
    const scanned = (session.scanned_at || "").slice(0, 16).replace("T", " ");
    if (title) {
      title.textContent = session.source_file || session.session_label || "Active scan";
    }
    if (meta) {
      meta.textContent =
        scanned +
        " · " +
        (session.pick_count || session.picks.length) +
        " picks · " +
        (session.source_kind || "scan");
    }
    renderScanMetricsStrip();
    updateResultsTabBadge();
    const active = $("ttResultsActive");
    if (active && active.dataset.actionsWired !== "1") {
      active.dataset.actionsWired = "1";
      $("btnResultsCompare")?.addEventListener("click", () => {
        if (typeof RMChartHub === "undefined" || !session?.picks?.length) return;
        void RMChartHub.syncFromSession(session.picks).then(() => {
          if (typeof RMAnalysisChart !== "undefined") {
            RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
            if (RMAnalysisChart.syncToolbarFromHub) {
              RMAnalysisChart.syncToolbarFromHub();
            }
            void RMAnalysisChart.render(RMChartHub, {
              fit: true,
              preserveView: false,
            });
          }
          status(session.pick_count + " picks on compare chart");
        });
      });
      $("btnClearLoadedScan")?.addEventListener("click", () => {
        clearScanSession();
        setScansTab("results");
        renderCalendarUi(undefined, "results");
        status("Scan cleared — pick another from history");
      });
    }
  }

  async function loadPublishedSessionInteractive() {
    showScansPanel();
    if (!(await loadPublishedSession())) {
      status("No published session.json found");
      return;
    }
    try {
      await onSessionLoaded({
        runNewsScan: false,
        entryType: "published",
        sourceKind: "published",
        focusResults: true,
      });
      publishedSessionCacheDone = false;
      publishedSessionCache = session;
      status(session.pick_count + " picks · published scan loaded");
    } catch (e) {
      status(e.message || "Could not load published scan");
    }
  }

  function refreshScanButton() {
    const busy = marketScanRunning || newsScanRunning;
    document.body.classList.toggle("rm-scan-active", busy);
    if (typeof RMBrandLogo !== "undefined") RMBrandLogo.sync();
    if (typeof RMHeaderMood !== "undefined") RMHeaderMood.refresh();
    const btn = $("btnCustomScan");
    if (!btn) return;
    btn.classList.toggle("is-scanning", busy);
    btn.setAttribute("aria-busy", busy ? "true" : "false");
    const active = btn.querySelector(".btn-rm-scan-active");
    const idle = btn.querySelector(".btn-rm-scan-idle");
    if (active) {
      if (busy) {
        const base = active.getAttribute("data-src") || "assets/scan-progress.gif?v=2";
        active.src = base.split("&t=")[0] + "&t=" + Date.now();
      }
      active.hidden = !busy;
    }
    if (idle) idle.hidden = busy;
  }

  const REMOVE_REASON_LABELS = {
    no_stock_worthy_news_today: "no catalyst headlines today",
    news_fetch_error: "news unavailable (kept)",
    below_news_rank_cutoff: "outside top news rank",
    gap_down: "gap down (bull scan only)",
    gap_down_or_negative_day: "gap down or negative day %",
  };

  /** Only top N picks by RM score get RSS catalyst checks. */
  const NEWS_TOP_N = 15;

  function showToast(message, type) {
    const stack = $("toastStack");
    if (!stack || !message) return;
    const el = document.createElement("div");
    el.className =
      "toast toast--" + (type === "success" ? "success" : type === "info" ? "info" : "warn");
    el.setAttribute("role", "status");
    el.textContent = message;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast--show"));
    const dismiss = () => {
      el.classList.remove("toast--show");
      setTimeout(() => el.remove(), 280);
    };
    setTimeout(dismiss, 4200);
    el.addEventListener("click", dismiss);
  }

  function removalReasonLabel(reason) {
    return REMOVE_REASON_LABELS[reason] || String(reason || "filtered out").replace(/_/g, " ");
  }

  function sortPicksByGapUp(picks) {
    return [...picks].sort((a, b) => {
      const ga = a.gap_pct != null ? Number(a.gap_pct) : -1;
      const gb = b.gap_pct != null ? Number(b.gap_pct) : -1;
      if (gb !== ga) return gb - ga;
      const ra = a.rm_confidence != null ? Number(a.rm_confidence) : 0;
      const rb = b.rm_confidence != null ? Number(b.rm_confidence) : 0;
      if (rb !== ra) return rb - ra;
      return (a.rank || 99) - (b.rank || 99);
    });
  }

  function sessionAccuracyStats(sessionId) {
    if (!sessionId) return null;
    if (typeof RMTradeMetrics !== "undefined") {
      return RMTradeMetrics.sessionStats(getTrades(), sessionId);
    }
    const closed = getTrades().filter(
      (t) =>
        t.session_id === sessionId &&
        t.status === "closed" &&
        t.filled !== false
    );
    if (!closed.length) return null;
    let wins = 0;
    for (const t of closed) {
      const entry = t.entry_price ?? t.entry_premium;
      const exit = t.exit_price;
      if (entry != null && exit != null && exit > entry) wins++;
    }
    return {
      trades: closed.length,
      wins,
      pct: Math.round((wins / closed.length) * 100),
    };
  }

  function formatAccuracyBadge(sessionId, stored) {
    const a = sessionAccuracyStats(sessionId) || stored;
    if (!a) return "";
    const label =
      typeof RMTradeMetrics !== "undefined"
        ? RMTradeMetrics.fmtBadge(a)
        : a.pct + "% (" + a.wins + "/" + a.trades + ")";
    return ' · <span class="cal-accuracy">' + escapeHtml(label) + "</span>";
  }

  function persistScanSession(opts) {
    if (!session || typeof RMScanStore === "undefined") return;
    const acc = sessionAccuracyStats(session.session_id);
    if (acc) session.accuracy = acc;
    session.closed_trades = getTrades().filter(
      (t) => t.session_id === session.session_id && t.status === "closed"
    );
    if (!session.source_kind && session.source_file) {
      session.source_kind = /import/i.test(session.source_file) ? "import" : "scan";
    }
    RMScanStore.saveSession(session, {
      entryType: opts?.entryType || session.entry_type || session.source_kind || "session",
      sourceKind: opts?.sourceKind || session.source_kind || "scan",
    });
    const searchVal = $("drawerCalSearch")?.value || "";
    if ($("scanDrawer")?.classList.contains("open")) {
      renderCalendarUi(searchVal, "drawer");
    }
    if (!$("scansTabResults")?.hidden) {
      renderCalendarUi($("ttResultsCalSearch")?.value || "", "results");
    }
  }

  function focusChartSymbol(symbol) {
    if (!symbol || typeof RMAnalysisChart === "undefined") return;
    const raw = String(symbol).trim();
    const sym =
      typeof RMHoldings !== "undefined" && RMHoldings.isHoldingSelectKey?.(raw)
        ? RMHoldings.normalizeHoldingSelectKey(raw)
        : String(raw)
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9.-]/g, "");
    RMAnalysisChart.state.symbol = sym;
    RMAnalysisChart.state.activeNoteId = null;
    RMAnalysisChart.state.noteEditorAnchor = null;
    if (RMAnalysisChart.syncSymbolOptions) RMAnalysisChart.syncSymbolOptions();
    const symEl = $("caSymbol");
    if (symEl) {
      let hasOpt = false;
      symEl.querySelectorAll("option").forEach((o) => {
        if (o.value === sym) hasOpt = true;
      });
      if (!hasOpt) {
        const opt = document.createElement("option");
        opt.value = sym;
        opt.textContent =
          typeof RMHoldings !== "undefined" && RMHoldings.labelForSelectValue
            ? RMHoldings.labelForSelectValue(sym)
            : sym;
        symEl.appendChild(opt);
      }
      symEl.value = sym;
    }
    if (typeof RMAnalysisChart.syncSymbolInputFromView === "function") {
      RMAnalysisChart.syncSymbolInputFromView();
    }
    if (RMAnalysisChart.reload) RMAnalysisChart.reload({ preserveView: true });
  }

  function assertChartViewSymbol(symbol) {
    if (!symbol || typeof RMAnalysisChart === "undefined") return;
    const sym =
      typeof RMHoldings !== "undefined" && RMHoldings.isHoldingSelectKey?.(symbol)
        ? RMHoldings.normalizeHoldingSelectKey(symbol)
        : String(symbol).trim();
    RMAnalysisChart.state.symbol = sym;
    if (RMAnalysisChart.syncSymbolOptions) RMAnalysisChart.syncSymbolOptions();
    const symEl = $("caSymbol");
    if (symEl) {
      let hasOpt = false;
      symEl.querySelectorAll("option").forEach((o) => {
        if (o.value === sym) hasOpt = true;
      });
      if (!hasOpt) {
        const opt = document.createElement("option");
        opt.value = sym;
        opt.textContent =
          typeof RMHoldings !== "undefined" && RMHoldings.labelForSelectValue
            ? RMHoldings.labelForSelectValue(sym)
            : sym;
        symEl.appendChild(opt);
      }
      symEl.value = sym;
    }
    if (typeof RMAnalysisChart.syncSymbolInputFromView === "function") {
      RMAnalysisChart.syncSymbolInputFromView();
    }
  }

  let holdingNavToken = 0;

  function pickFromHolding(h, selectKey) {
    if (!h) return null;
    const sel =
      selectKey ||
      (typeof RMHoldings !== "undefined" && RMHoldings.holdingSelectValue
        ? RMHoldings.holdingSelectValue(h)
        : String(h.symbol || "").trim().toUpperCase());
    const chartSym =
      typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolFor
        ? RMHoldings.chartSymbolFor(h)
        : String(h.symbol || "").trim().toUpperCase();
    const last =
      (typeof RMHoldings !== "undefined" && RMHoldings.currentPrice
        ? RMHoldings.currentPrice(h)
        : null) ??
      h.entry_price ??
      null;
    if (last == null && h.entry_price == null) return null;
    return {
      symbol: String(sel).trim(),
      chartSymbol: chartSym,
      last: last ?? Number(h.entry_price),
      rm_confidence: h.rm_confidence,
      catalyst: { status: h.source === "schwab" ? "schwab" : "holding" },
      _holding: h,
      _fromSchwab: h.source === "schwab",
    };
  }

  function waitForChartReady(selectKey, quoteSym) {
    return new Promise(function (resolve) {
      const timeoutMs = 12000;
      const matches = function () {
        if (typeof RMAnalysisChart === "undefined") return false;
        const st = RMAnalysisChart.state || {};
        const cur = String(st.symbol || "");
        const expectedBars =
          typeof RMHoldings !== "undefined" && RMHoldings.barsSymbolForSelectValue
            ? RMHoldings.barsSymbolForSelectValue(selectKey || cur)
            : String(quoteSym || selectKey || "").toUpperCase();
        const curBars =
          typeof RMHoldings !== "undefined" && RMHoldings.barsSymbolForSelectValue
            ? RMHoldings.barsSymbolForSelectValue(cur)
            : typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolForSelectValue
              ? RMHoldings.chartSymbolForSelectValue(cur) || cur.toUpperCase()
              : cur.toUpperCase();
        const symOk =
          cur === selectKey ||
          curBars === expectedBars ||
          cur.toUpperCase() === String(quoteSym || "").toUpperCase();
        return symOk && Array.isArray(st.bars) && st.bars.length > 0;
      };
      if (matches()) {
        resolve();
        return;
      }
      const timer = setTimeout(function () {
        document.removeEventListener("rm:chart-bars", onBars);
        resolve();
      }, timeoutMs);
      const onBars = function () {
        if (matches()) {
          clearTimeout(timer);
          document.removeEventListener("rm:chart-bars", onBars);
          resolve();
        }
      };
      document.addEventListener("rm:chart-bars", onBars);
    });
  }

  function ensureHoldingChartMarker(h, chartSym) {
    if (
      !h ||
      typeof RMAnalysisChart === "undefined" ||
      !RMAnalysisChart.saveTradeMarker ||
      h.entry_price == null
    ) {
      return;
    }
    const entryMs = Date.parse(h.entry_date || h.opened_at || "");
    RMAnalysisChart.saveTradeMarker({
      id: "holding-open-" + String(h.id || chartSym).replace(/\s+/g, "_"),
      symbol: chartSym,
      entry_price: Number(h.entry_price),
      exit_price: null,
      t: Number.isFinite(entryMs) ? entryMs : Date.now(),
      session_id: h.session_id || null,
      filled: true,
      source: h.source || "holding",
    });
  }

  async function openHoldingOnChart(h) {
    if (!h?.symbol) return;
    const navToken = ++holdingNavToken;
    try {
      const drawer = $("orderDrawer");
      if (drawer?.classList.contains("open")) {
        drawer.classList.remove("open");
        drawer.classList.add("is-closed");
        drawer.setAttribute("aria-hidden", "true");
        $("orderBackdrop")?.classList.add("hidden");
      }
      if (typeof RMWorkspaceAccordion !== "undefined") RMWorkspaceAccordion.expand("chart");
      const sel =
        typeof RMHoldings !== "undefined" && RMHoldings.holdingSelectValue
          ? RMHoldings.holdingSelectValue(h)
          : h.symbol;
      const chartSym =
        typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolFor
          ? RMHoldings.chartSymbolFor(h)
          : h.symbol;
      const quoteSym =
        typeof RMHoldings !== "undefined" && RMHoldings.quoteSymbolFor
          ? RMHoldings.quoteSymbolFor(h)
          : chartSym;
      focusChartSymbol(sel);
      await waitForChartReady(sel, quoteSym);
      if (navToken !== holdingNavToken) return;
      assertChartViewSymbol(sel);
      ensureHoldingChartMarker(h, quoteSym);
      const pick = pickFromHolding(h, sel);
      if (navToken !== holdingNavToken) return;
      if (pick) {
        activePick = pick;
        if (pick.chartSymbol) highlightTicker(pick.chartSymbol);
        if (typeof RMTradeFooter !== "undefined") {
          if (typeof RMTradeFooter.refresh === "function") RMTradeFooter.refresh(pick);
          else RMTradeFooter.selectPick(pick);
        }
      }
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
        RMAnalysisChart.refreshTradeOverlay();
      } else if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.paint) {
        RMAnalysisChart.paint();
      }
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setActiveTradeMarker) {
        RMAnalysisChart.setActiveTradeMarker(
          null,
          chartSym !== String(h.symbol || "").trim().toUpperCase() ? h.symbol : null
        );
      }
      if (navToken !== holdingNavToken) return;
      assertChartViewSymbol(sel);
      syncMobilePickChrome();
      if (typeof RMResultsHero !== "undefined" && RMResultsHero.showOpenPosition) {
        void RMResultsHero.showOpenPosition(h);
      }
      const focus =
        typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromHolding
          ? RMHoldings.chartFocusFromHolding(h)
          : null;
      dispatchTradeJourney({
        stage: "manage",
        symbol: focus?.symbol || chartSym,
        selectKey: focus?.selectKey || sel,
        holding: h,
        source: "holding",
      });
      const symLabel =
        typeof RMHoldings !== "undefined" && RMHoldings.formatOptionLabel
          ? RMHoldings.formatOptionLabel(h.symbol)
          : String(h.symbol || "").trim();
      const isOptView =
        typeof RMHoldings !== "undefined" && RMHoldings.isOptionSymbol?.(h.symbol);
      status(isOptView ? "Chart → " + symLabel : "Chart → " + h.symbol);
    } finally {
      /* latest click wins via holdingNavToken */
    }
  }

  function syncChartHoldingSymbols() {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.syncSymbolOptions) {
      RMAnalysisChart.syncSymbolOptions();
    }
  }

  function syncLivePickRefresh() {
    const mp = $("marketPanel");
    if (!mp || typeof RMMarket === "undefined") return;
    if (session?.picks?.length) {
      RMMarket.startLivePickRefresh(mp, () => session?.picks || []);
    } else {
      RMMarket.stopLivePickRefresh();
    }
  }

  function syncLiveChartRefresh() {
    const el = $("chartHubView");
    if (!el || typeof RMChartHub === "undefined") return;
    RMChartHub.startLiveChartRefresh(el);
  }

  function stopLiveChartRefresh() {
    if (typeof RMChartHub !== "undefined") RMChartHub.stopLiveChartRefresh();
  }

  function syncBackgroundActivity() {
    const hidden = document.visibilityState === "hidden";
    const mobile =
      isMobileWorkspace() ||
      (typeof RMMobilePerf !== "undefined" && RMMobilePerf.isMobilePerf());
    const activeKey =
      typeof RMWorkspaceAccordion !== "undefined" && RMWorkspaceAccordion.getActiveKey
        ? RMWorkspaceAccordion.getActiveKey()
        : null;

    if (mobile && activeKey !== "chart") {
      RMHeaderBg?.setFpsForcedPoster?.(false);
    }

    const booting = document
      .getElementById("morningWorkspace")
      ?.classList.contains("morning-workspace--booting");
    let mediaTier = "full";
    if (hidden) {
      mediaTier = "poster";
    } else if (booting) {
      mediaTier = "preload";
    } else if (mobile) {
      mediaTier = "poster";
    }
    RMHeaderBg?.setMediaTier?.(mediaTier);

    if (!hidden && (booting || mobile)) {
      RMHeaderMood?.pausePoll?.();
    } else if (!hidden) {
      RMHeaderMood?.resumePoll?.();
    } else {
      RMHeaderMood?.pausePoll?.();
    }

    if (hidden) {
      RMHeaderBg?.setVideoPaused?.(true);
    } else {
      RMHeaderBg?.setVideoPaused?.(false);
    }

    syncHeaderFpsWatch(mobile, activeKey, hidden);

    const chartAllowed = !hidden && (!mobile || activeKey === "chart");
    const chartPanelReady = !!document
      .getElementById("workspaceChart")
      ?.classList.contains("ws-panel--ready");
    if (chartAllowed && chartPanelReady) {
      syncLiveChartRefresh();
    } else {
      stopLiveChartRefresh();
    }

    const mp = $("marketPanel");
    const marketAllowed = !hidden && (!mobile || activeKey === "market");
    if (marketAllowed && session?.picks?.length && mp && typeof RMMarket !== "undefined") {
      RMMarket.startLivePickRefresh(mp, () => session?.picks || []);
    } else if (typeof RMMarket !== "undefined") {
      RMMarket.stopLivePickRefresh();
    }
  }

  let headerFpsWatchTimer = null;
  let headerLowFpsSecs = 0;

  function syncHeaderFpsWatch(mobile, activeKey, hidden) {
    const watch =
      mobile && activeKey === "chart" && !hidden && typeof RMAnalysisChart !== "undefined";
    if (!watch) {
      if (headerFpsWatchTimer) {
        clearInterval(headerFpsWatchTimer);
        headerFpsWatchTimer = null;
      }
      headerLowFpsSecs = 0;
      if (typeof RMAnalysisChart !== "undefined") {
        RMAnalysisChart.startHeaderFpsSample?.(false);
      }
      return;
    }
    RMAnalysisChart?.startHeaderFpsSample?.(true);
    if (headerFpsWatchTimer) return;
    headerFpsWatchTimer = setInterval(() => {
      const fps = RMAnalysisChart.getHeaderFpsSample?.() ?? 60;
      if (fps > 0 && fps < 24) {
        headerLowFpsSecs += 1;
        if (headerLowFpsSecs >= 2) {
          RMHeaderBg?.setFpsForcedPoster?.(true);
        }
      } else {
        headerLowFpsSecs = 0;
      }
    }, 1000);
  }

  function syncLiveRefresh() {
    syncBackgroundActivity();
  }

  function refreshMarketThemes() {
    const el = $("marketThemes");
    if (el && typeof RMMarketThemes !== "undefined") {
      RMMarketThemes.refresh(el, { picks: session?.picks || [] }).catch(() => {});
    }
  }

  function highlightTicker(symbol) {
    document.querySelectorAll(".pick-row-selected").forEach((el) => {
      el.classList.remove("pick-row-selected");
    });
    document.querySelectorAll(".fv-map-cell--selected").forEach((el) => {
      el.classList.remove("fv-map-cell--selected");
    });
    document.querySelectorAll(".chart-hub-legend-item--selected").forEach((el) => {
      el.classList.remove("chart-hub-legend-item--selected");
    });
    if (!symbol) return;
    const row = document.querySelector('.pick-row[data-symbol="' + symbol + '"]');
    if (row) row.classList.add("pick-row-selected");
    document
      .querySelectorAll('.fv-map-cell[data-symbol="' + symbol + '"]')
      .forEach((el) => el.classList.add("fv-map-cell--selected"));
    document.querySelectorAll(".chart-hub-legend-item").forEach((el) => {
      if (el.textContent.trim().startsWith(symbol)) {
        el.classList.add("chart-hub-legend-item--selected");
      }
    });
  }

  function clearPickTradeInsight() {
    document.querySelectorAll(".pick-trade-insight").forEach((el) => {
      el.hidden = true;
      el.textContent = "";
    });
    const orphan = $("pickSetupInsight");
    if (orphan) {
      orphan.hidden = true;
      orphan.innerHTML = "";
    }
    const planSlot = $("ttResultsPlanSlot");
    if (planSlot) {
      planSlot.classList.add("hidden");
      planSlot.hidden = true;
    }
  }

  function formatPickTradeInsightHtml(p, plan) {
    const rm = pickScore(p);
    let profitTxt = "—";
    let rrTxt = "";
    if (plan && plan.entry > plan.stop) {
      const qty = plan.qty || 100;
      const profit = ((plan.target2 ?? plan.target) - plan.entry) * qty;
      const rr = ((plan.target2 ?? plan.target) - plan.entry) / (plan.entry - plan.stop);
      profitTxt = "$" + Math.round(profit);
      rrTxt = rr.toFixed(1) + "R";
    }
    return (
      "<strong>RM " +
      (rm != null ? Math.round(rm) : "—") +
      "</strong> · Proj " +
      escapeHtml(profitTxt) +
      (rrTxt ? " · " + escapeHtml(rrTxt) : "") +
      "<br>LMT $" +
      (plan?.entry != null ? Number(plan.entry).toFixed(2) : "—") +
      " · Stop $" +
      (plan?.stop != null ? Number(plan.stop).toFixed(2) : "—") +
      " · Sell1 $" +
      (plan?.target1 != null ? Number(plan.target1).toFixed(2) : "—") +
      " · Sell2 $" +
      (plan?.target2 != null ? Number(plan.target2).toFixed(2) : "—")
    );
  }

  function resolvePickForSelect(symbol) {
    let raw = String(symbol || "").trim();
    if (!raw) return null;
    let sym = raw.toUpperCase();
    if (/^holding:/i.test(raw) && typeof RMHoldings !== "undefined") {
      sym = RMHoldings.chartSymbolForSelectValue(raw) || sym;
    }
    const fromSession = (session?.picks || []).find((x) => x.symbol === sym);
    if (fromSession) return fromSession;
    if (typeof RMHoldings !== "undefined") {
      const holdings = RMHoldings.getDisplayOpen() || [];
      const h = holdings.find((row) => {
        const cs = RMHoldings.chartSymbolFor(row);
        return cs === sym || String(row.symbol).toUpperCase() === sym;
      });
      if (h) {
        const last = RMHoldings.currentPrice(h) ?? h.entry_price;
        if (last != null || h.entry_price != null) {
          return {
            symbol: sym,
            last: last ?? Number(h.entry_price),
            rm_confidence: h.rm_confidence,
            catalyst: { status: h.source === "schwab" ? "schwab" : "holding" },
            _holding: h,
            _fromSchwab: h.source === "schwab",
          };
        }
      }
    }
    let last = null;
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol === sym) {
      const bars = RMAnalysisChart.state.bars;
      last = bars?.length ? bars[bars.length - 1].close : null;
    }
    const plan =
      typeof RMTradeFooter !== "undefined"
        ? RMTradeFooter.recommendMorningSetup?.(sym) || RMTradeFooter.recommendPlan?.({ symbol: sym, last })
        : null;
    last = last ?? plan?.price ?? plan?.entry;
    if (last == null) return null;
    return {
      symbol: sym,
      last,
      rm_confidence: null,
      catalyst: { status: "chart" },
      _chartOnly: true,
    };
  }

  function updatePickTradeInsight(symbol) {
    clearPickTradeInsight();
    if (!symbol) return;
    const sym = String(symbol).toUpperCase();
    const p = resolvePickForSelect(sym);
    if (!p) return;
    const plan =
      typeof RMTradeFooter !== "undefined"
        ? RMTradeFooter.recommendMorningSetup?.(p) || RMTradeFooter.recommendPlan(p)
        : null;
    const html = formatPickTradeInsightHtml(p, plan);
    const row = document.querySelector('.pick-row[data-symbol="' + sym + '"]');
    if (row) {
      let insight = row.querySelector(".pick-trade-insight");
      if (!insight) {
        insight = document.createElement("div");
        insight.className = "pick-trade-insight";
        row.querySelector(".pick-accordion-summary")?.appendChild(insight);
      }
      insight.innerHTML = html;
      insight.hidden = false;
      if (row.tagName === "DETAILS") row.open = true;
    }
    if (
      typeof RMAnalysisChart !== "undefined" &&
      RMAnalysisChart.state?.tradePlan?.symbol === sym
    ) {
      RMAnalysisChart.showResultsPlanPanel?.();
      return;
    }
  }

  function scrollPickIntoView(symbol) {
    const row = document.querySelector('.pick-row[data-symbol="' + symbol + '"]');
    if (row) {
      if (row.tagName === "DETAILS") row.open = true;
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    const hero = $("ttResultsHero");
    if (hero) {
      hero.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const orphan = $("pickSetupInsight");
    if (orphan && !orphan.hidden) {
      orphan.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    $("workspaceScans")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function isMobileWorkspace() {
    return (
      typeof matchMedia !== "undefined" &&
      matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-ws-accordion")
    );
  }

  function syncMobilePickChrome() {
    const chartSym =
      typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol
        ? String(RMAnalysisChart.state.symbol)
        : "";
    const hasChartContext =
      !!activePick?.symbol ||
      (chartSym && chartSym !== "SPY" && chartSym !== "COMPARE");
    const showJourney =
      isMobileWorkspace() &&
      document.body.classList.contains("is-mobile-snap-chart") &&
      hasChartContext;
    document.body.classList.toggle("is-mobile-chart-pick", showJourney);
    if (typeof RMMarket !== "undefined") RMMarket.syncMobileMarketSettings?.();
    if (typeof RMChartHub !== "undefined") RMChartHub.syncMobileChartChrome?.();
  }

  function getHoldingForSymbol(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym || typeof RMHoldings === "undefined") return null;
    const holdings = RMHoldings.getDisplayOpen() || [];
    return (
      holdings.find((h) => {
        const cs = RMHoldings.chartSymbolFor(h);
        return cs === sym || String(h.symbol).toUpperCase() === sym;
      }) || null
    );
  }

  function clearTickerSelection() {
    holdingNavToken++;
    activePick = null;
    highlightTicker(null);
    clearPickTradeInsight();
    syncMobilePickChrome();
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setMapHighlight) {
      RMAnalysisChart.setMapHighlight(null);
    }
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(null);
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
      RMAnalysisChart.refreshTradeOverlay();
    } else if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.syncTradePlan) {
      RMAnalysisChart.syncTradePlan(null);
    }
  }

  function selectTicker(symbol, opts) {
    const p = resolvePickForSelect(symbol);
    if (!p) {
      status(String(symbol || "").toUpperCase() + " — no quote data for trade setup.");
      return;
    }
    const focus =
      typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromPick
        ? RMHoldings.chartFocusFromPick(p)
        : null;
    const sym = focus?.selectKey || String(symbol || "").toUpperCase();
    if (opts?.toggle && activePick?.symbol === sym) {
      clearTickerSelection();
      return;
    }
    holdingNavToken++;
    activePick = p;
    highlightTicker(sym);
    focusChartSymbol(sym);
    updatePickTradeInsight(sym);
    if (typeof RMResultsHero !== "undefined" && !opts?.skipHero) {
      void RMResultsHero.showTicker(sym);
    }
    scrollPickIntoView(sym);
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setMapHighlight) {
      RMAnalysisChart.setMapHighlight(sym, p);
    }
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.selectPick(p);
    syncMobilePickChrome();
    if (isMobileWorkspace() && opts?.snapChart !== false) {
      if (typeof RMWorkspaceAccordion !== "undefined") {
        RMWorkspaceAccordion.expand("chart");
      }
    }
    if (opts?.openDrawer) showDrawerTrade(p);
    if (opts?.fromSetup) {
      status(p._chartOnly ? sym + " setup · chart symbol (add to scan for RM score)" : sym + " setup · see Target Trades");
    }
  }

  function surfacingTradePlanToResults(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return;
    showScansPanel();
    setScansTab("results", { skipHero: true });
    if (typeof RMWorkspaceAccordion !== "undefined" && isMobileWorkspace()) {
      RMWorkspaceAccordion.expand("scans");
    }
    if (typeof RMResultsHero !== "undefined") {
      void RMResultsHero.showSetup(sym);
    } else if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.showResultsPlanPanel?.();
    }
    selectTicker(sym, {
      toggle: false,
      fromSetup: true,
      snapChart: false,
      skipHero: true,
    });
    requestAnimationFrame(() => {
      $("ttResultsHero")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function selectTradeSetup(symbol) {
    const sym = String(symbol || activePick?.symbol || "").toUpperCase();
    if (!sym) return;
    surfacingTradePlanToResults(sym);
  }

  function saveOpenTradeFromPlan(plan) {
    if (
      plan.engine_bias == null &&
      typeof RMMarket !== "undefined" &&
      RMMarket.currentBiasSnapshot
    ) {
      plan.engine_bias = RMMarket.currentBiasSnapshot();
    }
    const trades = getTrades().filter(
      (t) => !(t.symbol === plan.symbol && t.status === "open")
    );
    if (plan.planned == null && (plan.source === "footer" || plan.source === "dashboard")) {
      plan.planned = true;
    }
    if (!plan.id) {
      plan.id = "journal-" + String(plan.symbol || "sym") + "-" + Date.now();
    }
    trades.push(plan);
    saveTrades(trades);
    if (typeof RMHoldings !== "undefined") {
      RMHoldings.upsertFromTrade({
        symbol: plan.symbol,
        instrument: plan.instrument || "stock",
        entry_price: plan.entry_price ?? plan.entry_premium,
        quantity: plan.quantity ?? plan.contracts,
        rm_confidence: plan.rm_confidence_adjusted ?? plan.rm_confidence,
        session_id: plan.session_id,
      });
    }
    renderHoldings();
    renderDrawerYtd();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    refreshPickRow(plan.symbol);
    persistScanSession();
    if (typeof RMMetrics !== "undefined") {
      RMMetrics.markTradeOpen({ symbol: plan.symbol, session_id: plan.session_id });
    }
    status("Trade entered · " + plan.symbol + " added to holdings");
  }

  // Single source of truth for fill interpretation across BOTH close UIs (the
  // footer stepper and the order drawer). Accepts a raw <select> value
  // ("filled" / "not_filled"), an explicit boolean, or undefined (defaults to
  // filled). Keeping this in one place stops the two UIs from drifting.
  function isFilledFromInput(input) {
    const raw = input?.fill_status != null ? input.fill_status : input?.filled;
    return raw !== false && raw !== "not_filled";
  }

  function closeTradeFromPlan(opts) {
    const sym = opts.symbol;
    const pick =
      (session?.picks || []).find((x) => x.symbol === sym) || activePick;
    const filled = isFilledFromInput(opts);
    const exitPrice = opts.exit_price;
    const trades = getTrades();
    const idx = trades.findIndex((t) => t.symbol === sym && t.status === "open");
    const patch = {
      closed_at: new Date().toISOString(),
      status: filled ? "closed" : "not_filled",
      filled,
      exit_price: exitPrice,
      reconciled: false,
      reconcile_status: "delta",
      execution_channel: opts.execution_channel || "platform",
      source: opts.source || "footer",
    };
    let entryPrice = opts.entry_price;
    let stopPrice = opts.stop_price;
    let targetPrice = opts.target_price;
    let tradeIdx = idx;
    if (idx >= 0) {
      entryPrice = entryPrice ?? trades[idx].entry_price;
      stopPrice = stopPrice ?? trades[idx].stop_price;
      targetPrice = targetPrice ?? trades[idx].target_price;
      trades[idx] = { ...trades[idx], ...patch };
    } else {
      trades.push({
        id: "journal-" + sym + "-" + Date.now(),
        symbol: sym,
        session_id: session?.session_id,
        instrument: "stock",
        rm_confidence: pick?.rm_confidence,
        entry_price: entryPrice,
        stop_price: stopPrice,
        target_price: targetPrice,
        quantity: opts.quantity,
        source: opts.source || "footer",
        planned: opts.planned !== false,
        ...patch,
      });
      tradeIdx = trades.length - 1;
    }
    if (filled && typeof RMTradeMetrics !== "undefined" && tradeIdx >= 0) {
      trades[tradeIdx] = RMTradeMetrics.enrichClosedTrade(trades[tradeIdx], {
        planned: opts.planned !== false,
      });
    }
    if (filled && typeof RMSetupFingerprint !== "undefined" && tradeIdx >= 0) {
      trades[tradeIdx] = RMSetupFingerprint.finalizeOnClose(
        trades[tradeIdx],
        pick,
        null,
        {}
      );
    }
    saveTrades(trades);
    if (filled && typeof RMTradeStory !== "undefined" && tradeIdx >= 0) {
      void RMTradeStory.syncExit(trades[tradeIdx]);
    }
    if (typeof RMHoldings !== "undefined" && filled) {
      const open = RMHoldings.findOpenBySymbol(sym);
      if (open) RMHoldings.closeHolding(open.id, exitPrice);
    }
    if (filled && typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.saveTradeMarker) {
      RMAnalysisChart.saveTradeMarker({
        symbol: sym,
        entry_price: entryPrice,
        exit_price: exitPrice,
        stop_price: stopPrice,
        target_price: targetPrice,
        session_id: session?.session_id,
        filled,
        t: Date.now(),
        closed_at: patch.closed_at,
      });
    }
    renderHoldings();
    renderLearningStats();
    renderDrawerYtd();
    renderScanMetricsStrip();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    refreshPickRow(sym);
    if ($("ttCalibrationPanel")) refreshStrategyLearning();
    persistScanSession();
    activePick = null;
    highlightTicker(null);
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setMapHighlight) {
      RMAnalysisChart.setMapHighlight(null);
    }
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(null);
    if (typeof RMMetrics !== "undefined") {
      RMMetrics.markTradeClose({
        symbol: sym,
        filled,
        r_multiple: tradeIdx >= 0 ? trades[tradeIdx]?.r_multiple ?? null : null,
        source: patch.source,
      });
      document.dispatchEvent(new CustomEvent("rm:trade-closed", { detail: { symbol: sym } }));
    }
    const focus =
      typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromSelectKey
        ? RMHoldings.chartFocusFromSelectKey(sym)
        : null;
    dispatchTradeJourney({
      stage: "close",
      symbol: focus?.symbol || sym,
      selectKey: focus?.selectKey || sym,
      source: patch.source || "footer",
    });
    status((filled ? "Closed (filled)" : "Not filled") + " — " + sym);
  }

  function wireTradeFooter() {
    if (typeof RMTradeFooter === "undefined") return;
    RMTradeFooter.init({
      getSession: () => session,
      getTrades: getJournalTrades,
      getActivePick: () => activePick,
      getHolding: getHoldingForSymbol,
      pickScore,
      status,
      saveOpenTrade: saveOpenTradeFromPlan,
      closeTrade: closeTradeFromPlan,
      onSelect: (pick) => {
        activePick = pick;
        highlightTicker(pick.symbol);
      },
    });
  }

  function getHeroWeightConfig() {
    if (typeof RMScanConfig === "undefined") return {};
    const cfg = scanConfigDraft || RMScanConfig.load();
    return RMScanConfig.normalizeHeroWeights(cfg.weights || RMScanConfig.DEFAULTS.weights);
  }

  function pickHeroStepsHtml() {
    const shortLabels = {
      float: "Float filter",
      news: "News proxy",
      vol: "Volume surge",
      move: "Intraday move",
      daily: "Daily momentum",
    };
    const weights = getHeroWeightConfig();
    const rows =
      typeof RMScanConfig !== "undefined"
        ? RMScanConfig.criteriaRows().slice(0, 5)
        : RM_WEIGHTS.slice(0, 5).map((w) => ({
            key: w.id,
            hint: w.label,
            weightKey: w.id,
          }));
    return rows
      .map((row, i) => {
        const step = i + 1;
        const key = row.weightKey || row.key;
        const pts = Math.round(Number(weights[key]) || 0);
        const title = shortLabels[row.key] || row.label || "Criterion";
        const hint = row.hint || title;
        return (
          '<li class="pick-hero-step" data-weight-key="' +
          escapeAttr(key) +
          '">' +
          '<span class="pick-hero-step-num" aria-hidden="true">' +
          step +
          "</span>" +
          '<div class="pick-hero-step-body">' +
          '<div class="pick-hero-step-head">' +
          '<span class="pick-hero-step-title">' +
          escapeHtml(title) +
          "</span>" +
          '<span class="pick-hero-step-pts">+' +
          pts +
          "</span>" +
          '<button type="button" class="pick-hero-step-info" aria-label="' +
          escapeAttr(title + " details") +
          '">' +
          '<span class="pick-hero-step-info-icon" aria-hidden="true">i</span>' +
          '<span class="pick-hero-step-tip" role="tooltip">' +
          escapeHtml(hint) +
          "</span></button></div>" +
          '<div class="pick-hero-step-slider">' +
          '<input type="range" class="pick-hero-weight-slider" data-weight-key="' +
          escapeAttr(key) +
          '" min="0" max="50" step="1" value="' +
          pts +
          '" aria-label="' +
          escapeAttr(title + " score weight") +
          '">' +
          '<span class="pick-hero-step-slider-val">' +
          pts +
          "%</span></div></div></li>"
        );
      })
      .join("");
  }

  function pickHeroWeightFooterHtml() {
    if (typeof RMScanConfig === "undefined") return "";
    const weights = getHeroWeightConfig();
    const heroTotal = RMScanConfig.heroWeightSum(weights);
    const budget = RMScanConfig.heroWeightBudget(weights);
    const price = Math.round(Number(weights.price) || 0);
    return (
      '<div class="pick-hero-weight-foot">' +
      '<button type="button" class="pick-hero-weight-reset secondary btn-sm">Reset to defaults</button>' +
      '<p class="pick-hero-weight-total' +
      (heroTotal === budget ? "" : " pick-hero-weight-total--warn") +
      '">Score allocation: <strong>' +
      heroTotal +
      "%</strong> across five signals · Price band +" +
      price +
      " = <strong>100%</strong> RM score</p>" +
      "</div>"
    );
  }

  function persistPickHeroWeights(nextWeights) {
    if (typeof RMScanConfig === "undefined") return;
    const cfg = scanConfigDraft || RMScanConfig.load();
    cfg.weights = RMScanConfig.normalizeHeroWeights({
      ...(cfg.weights || {}),
      ...nextWeights,
    });
    scanConfigDraft = cfg;
    RMScanConfig.save(cfg);
    syncRmWeightPts(cfg.weights);
  }

  function syncRmWeightPts(weights) {
    if (!weights) return;
    for (const w of RM_WEIGHTS) {
      if (weights[w.id] != null) w.pts = Math.round(Number(weights[w.id]));
    }
  }

  function updatePickHeroWeightDisplay() {
    if (typeof RMScanConfig === "undefined") return;
    const weights = getHeroWeightConfig();
    const active = document.activeElement;
    document.querySelectorAll(".pick-hero-weight-slider").forEach((slider) => {
      const key = slider.dataset.weightKey;
      if (!key) return;
      const val = Math.round(Number(weights[key]) || 0);
      if (slider !== active) slider.value = String(val);
      const row = slider.closest(".pick-hero-step, .pick-weight-row");
      const valEl = row?.querySelector(".pick-hero-step-slider-val, .pick-weight-val");
      if (valEl) valEl.textContent = val + "%";
    });
    document.querySelectorAll(".pick-hero-step[data-weight-key]").forEach((step) => {
      const key = step.dataset.weightKey;
      if (!key) return;
      const val = Math.round(Number(weights[key]) || 0);
      const badge = step.querySelector(".pick-hero-step-pts");
      if (badge) badge.textContent = "+" + val;
    });
    const total = RMScanConfig.heroWeightSum(weights);
    const budget = RMScanConfig.heroWeightBudget(weights);
    document.querySelectorAll(".pick-hero-weight-foot .pick-hero-weight-total").forEach((el) => {
      el.classList.toggle("pick-hero-weight-total--warn", total !== budget);
      const strong = el.querySelector("strong");
      if (strong) strong.textContent = total + "%";
    });
  }

  function resetHeroWeightsToDefaults() {
    if (typeof RMScanConfig === "undefined") return;
    const cfg = scanConfigDraft || RMScanConfig.load();
    cfg.weights = { ...RMScanConfig.DEFAULTS.weights };
    scanConfigDraft = cfg;
    RMScanConfig.save(cfg);
    syncRmWeightPts(cfg.weights);
    updatePickHeroWeightDisplay();
    const rankPanel = $("scanRankPanel");
    if (rankPanel?.querySelector(".pick-hero-copy")) {
      renderScanRankPanel(rankPanel);
    }
    status("Score weights reset to H-001 defaults (29/24/19/14/10 +4)");
  }

  function wirePickHeroWeightSliders(root) {
    const scope = root || document;
    scope.querySelectorAll(".pick-hero-weight-slider").forEach((input) => {
      if (input.dataset.wired === "1") return;
      input.dataset.wired = "1";
      input.addEventListener("input", () => {
        const key = input.dataset.weightKey;
        if (!key || typeof RMScanConfig === "undefined") return;
        const cfg = scanConfigDraft || RMScanConfig.load();
        const next = RMScanConfig.adjustHeroWeight(cfg.weights || {}, key, input.value);
        persistPickHeroWeights(next);
        updatePickHeroWeightDisplay();
      });
    });
  }

  function wirePickHeroWeightControls(root) {
    wirePickHeroWeightSliders(root);
    const scope = root || document;
    scope.querySelectorAll(".pick-hero-weight-reset").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", resetHeroWeightsToDefaults);
    });
  }

  function renderScanRankPanelHtml() {
    const steps = pickHeroStepsHtml();
    return (
      '<div class="pick-hero pick-hero--weights-edit pick-hero--drawer">' +
      '<div class="pick-hero-main">' +
      '<div class="pick-hero-visual" aria-hidden="true">' +
      '<div class="pick-hero-glow"></div>' +
      '<div class="pick-hero-scanline"></div>' +
      '<svg class="pick-hero-svg" viewBox="0 0 360 220" xmlns="http://www.w3.org/2000/svg">' +
      "<defs>" +
      '<linearGradient id="phg" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#4eb8c9"/><stop offset="55%" stop-color="#2db8a8"/><stop offset="100%" stop-color="#8b7fd4"/></linearGradient>' +
      '<linearGradient id="phFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="rgba(78,184,201,0.28)"/><stop offset="100%" stop-color="rgba(78,184,201,0)"/></linearGradient>' +
      '<filter id="phGlow" x="-30%" y="-30%" width="160%" height="160%">' +
      '<feGaussianBlur stdDeviation="2.5" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<pattern id="phGrid" width="24" height="24" patternUnits="userSpaceOnUse">' +
      '<path d="M24 0H0V24" fill="none" stroke="rgba(78,184,201,0.08)" stroke-width="1"/></pattern>' +
      "</defs>" +
      '<rect width="360" height="220" rx="18" fill="#0b1018"/>' +
      '<rect width="360" height="220" rx="18" fill="url(#phGrid)"/>' +
      '<rect x="18" y="18" width="324" height="184" rx="12" fill="rgba(0,0,0,0.22)" stroke="rgba(78,184,201,0.12)"/>' +
      '<path d="M36 156 L84 142 L128 148 L172 108 L216 114 L252 78 L292 86 L324 58 L324 184 L36 184 Z" fill="url(#phFill)"/>' +
      '<path class="pick-hero-line" d="M36 156 L84 142 L128 148 L172 108 L216 114 L252 78 L292 86 L324 58" fill="none" stroke="url(#phg)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#phGlow)"/>' +
      '<circle class="pick-hero-dot pick-hero-dot--lead" cx="324" cy="58" r="6" fill="#4eb8c9"/>' +
      '<circle class="pick-hero-dot" cx="252" cy="78" r="4.5" fill="#2db8a8"/>' +
      '<circle class="pick-hero-dot" cx="172" cy="108" r="4" fill="#d4a24a"/>' +
      '<g class="pick-hero-tags">' +
      '<rect x="28" y="28" width="78" height="30" rx="8" fill="rgba(78,184,201,0.14)" stroke="rgba(78,184,201,0.55)"/>' +
      '<text x="67" y="47" text-anchor="middle" fill="#8ae4d8" font-size="11" font-weight="700">RM 82+</text>' +
      '<rect x="118" y="28" width="88" height="30" rx="8" fill="rgba(232,149,79,0.12)" stroke="rgba(232,149,79,0.45)"/>' +
      '<text x="162" y="47" text-anchor="middle" fill="#f5c99a" font-size="11" font-weight="700">GAP ↑</text>' +
      '<rect x="218" y="28" width="108" height="30" rx="8" fill="rgba(139,127,212,0.14)" stroke="rgba(139,127,212,0.45)"/>' +
      '<text x="272" y="47" text-anchor="middle" fill="#c4b8f0" font-size="11" font-weight="700">NEWS ✓</text>' +
      "</g></svg></div>" +
      '<div class="pick-hero-copy">' +
      '<p class="pick-hero-kicker">H-001 · Breakout morning scan</p>' +
      "<h3 class=\"pick-hero-title\">Find gap-and-go winners backed by catalyst strength</h3>" +
      '<ol class="pick-hero-steps" aria-label="H-001 scan criteria">' +
      steps +
      "</ol>" +
      pickHeroWeightFooterHtml() +
      "</div></div></div>"
    );
  }

  function renderScanRankPanel(root) {
    if (!root) return;
    root.innerHTML = renderScanRankPanelHtml();
    wirePickHeroWeightControls(root);
    updatePickHeroWeightDisplay();
  }

  function status(msg) {
    const el = $("headerMeta");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function setHeaderMeta(msg) {
    status(msg);
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function isMobileWsAccordion() {
    return (
      window.matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-ws-accordion")
    );
  }

  function isMobileSnapScans() {
    return isMobileWsAccordion() && document.body.classList.contains("is-mobile-snap-scans");
  }

  function scansPanelLoader() {
    return document.querySelector("#workspaceScans .ws-col-loader");
  }

  function setScanProgressLabel(text) {
    setText("scanProgressLabel", text);
    if (!isMobileSnapScans()) return;
    const panelLabel = scansPanelLoader()?.querySelector(".ws-scan-progress-label");
    if (panelLabel) panelLabel.textContent = text;
  }

  function mirrorScanProgressToPanel() {
    if (!isMobileSnapScans()) return;
    const loader = scansPanelLoader();
    if (!loader) return;
    const srcFill = $("scanProgressFill");
    const dstFill = loader.querySelector(".ws-scan-progress-fill");
    const srcTrack = document.querySelector("#newsProgress .scan-progress-track");
    const dstTrack = loader.querySelector(".ws-scan-progress-track");
    const srcSeg = $("scanProgressSegments");
    const dstSeg = loader.querySelector(".ws-scan-progress-segments");
    const srcLabel = $("scanProgressLabel");
    const dstLabel = loader.querySelector(".ws-scan-progress-label");
    if (srcLabel && dstLabel) dstLabel.textContent = srcLabel.textContent;
    if (srcFill && dstFill) {
      dstFill.style.width = srcFill.style.width;
      dstFill.classList.toggle("is-estimated", srcFill.classList.contains("is-estimated"));
      dstFill.classList.toggle("no-transition", srcFill.classList.contains("no-transition"));
    }
    if (srcTrack && dstTrack) {
      dstTrack.setAttribute("aria-valuenow", srcTrack.getAttribute("aria-valuenow") || "0");
    }
    if (srcSeg && dstSeg) dstSeg.innerHTML = srcSeg.innerHTML;
  }

  function updateScansPanelLoaderStep(step, pct) {
    if (!isMobileSnapScans() || typeof RMWorkspaceLoad === "undefined") return;
    RMWorkspaceLoad.showPanelLoader("scans", {
      step: step || "Scanning…",
      kicker: "Rainmaker scan",
      pct: pct != null ? pct : scanProgressPct || 14,
      scanProgress: true,
    });
    mirrorScanProgressToPanel();
  }

  function setPageTitle(text) {
    document.title = text;
  }

  function setPickListHtml(html) {
    const el = $("pickList");
    if (!el) return;
    if (typeof RMVirtualPickList !== "undefined" && RMVirtualPickList.isMounted()) {
      RMVirtualPickList.destroy();
    }
    el.innerHTML = html;
  }

  function pickListBannerHtml() {
    const removed = session?.filtered_out || [];
    if (!removed.length) return "";
    return (
      '<p class="status-msg pick-removed-banner">Removed ' +
      removed.length +
      " without news today: " +
      escapeHtml(removed.map((x) => x.symbol).join(", ")) +
      "</p>"
    );
  }

  function bindPickListSubtree(root) {
    bindPickAccordions(root);
    bindRmScoreTooltips(root);
    bindUiTips(root);
    if (!root) return;
    root.querySelectorAll("[data-pick-chart]").forEach((el) => {
      observePickChartElement(el);
    });
  }

  function renderPickListContent(picks, banner) {
    const listRoot = $("pickList");
    if (!listRoot) return;
    const b = banner != null ? banner : pickListBannerHtml();
    if (
      typeof RMVirtualPickList !== "undefined" &&
      RMVirtualPickList.shouldVirtualize(picks.length)
    ) {
      if (!RMVirtualPickList.isMounted()) {
        RMVirtualPickList.mount(listRoot, {
          renderRow: renderPickRow,
          bind: bindPickListSubtree,
        });
      }
      RMVirtualPickList.refresh(picks, b);
      return;
    }
    if (typeof RMVirtualPickList !== "undefined" && RMVirtualPickList.isMounted()) {
      RMVirtualPickList.destroy();
    }
    listRoot.innerHTML = b + picks.map(renderPickRow).join("");
    bindPickListSubtree(listRoot);
  }

  function fmt(n) {
    if (n == null || n === "") return "—";
    return Number(n).toFixed(0);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function fvTipData(kicker, title, desc, stat) {
    if (typeof RMUiTips === "undefined") return "";
    return RMUiTips.fvTipData(kicker, title, desc, stat);
  }

  function bindUiTips(root) {
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(root);
  }

  function tipTruncate(s, max) {
    s = String(s || "").trim();
    if (!s || s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  function catalystTipMeta(cat) {
    if (!cat) {
      return {
        kicker: "Catalyst",
        title: "Review",
        desc: "Run news scan to verify whether recent headlines support the gap.",
        stat: "",
      };
    }
    if (cat.verified === true) {
      const n =
        (cat.headlines && cat.headlines.length) || (cat.headline ? 1 : 0);
      return {
        kicker: "Catalyst",
        title: "Verified",
        desc: "Headline found in the scan window that matches this symbol.",
        stat: n ? n + " headline(s)" : "verified",
      };
    }
    if (cat.verified === false) {
      return {
        kicker: "Catalyst",
        title: "None",
        desc: "News scan ran; no qualifying headline in the window.",
        stat: "",
      };
    }
    if (cat.status === "news_error") {
      return {
        kicker: "Catalyst",
        title: "Fetch error",
        desc: "News provider failed; retry scan or check your connection.",
        stat: "",
      };
    }
    return {
      kicker: "Catalyst",
      title: "Review",
      desc: "Awaiting or incomplete news verification.",
      stat: "",
    };
  }

  function catalystPill(cat) {
    const meta = catalystTipMeta(cat);
    const tip = fvTipData(meta.kicker, meta.title, meta.desc, meta.stat);
    if (!cat) {
      return (
        '<span class="pill pill-review fv-tip-target" tabindex="0"' +
        tip +
        ">review</span>"
      );
    }
    if (cat.verified === true) {
      return (
        '<span class="pill pill-yes fv-tip-target" tabindex="0"' +
        tip +
        ">catalyst</span>"
      );
    }
    if (cat.verified === false) {
      return (
        '<span class="pill pill-no fv-tip-target" tabindex="0"' +
        tip +
        ">none</span>"
      );
    }
    if (cat.status === "news_error") {
      return (
        '<span class="pill pill-review fv-tip-target" tabindex="0"' +
        tip +
        ">error</span>"
      );
    }
    return (
      '<span class="pill pill-review fv-tip-target" tabindex="0"' +
      tip +
      ">review</span>"
    );
  }

  function pickScore(p) {
    if (!p) return null;
    if (p.rm_confidence_adjusted != null) return p.rm_confidence_adjusted;
    const c = p.catalyst;
    if (c && c.rm_confidence_adjusted != null) return c.rm_confidence_adjusted;
    return p.rm_confidence;
  }

  /** Matches thinkorswim/scanners/MorningMomentumScanner.ts */
  const RM_WEIGHTS = [
    {
      id: "float",
      pts: 29,
      label: "Float filter (Stock Hacker)",
      hintKey: "float",
    },
    {
      id: "news",
      pts: 24,
      label: "News proxy (gap-up ≥3% or vol + daily ≥5%)",
      hintKey: "news",
    },
    {
      id: "vol",
      pts: 19,
      label: "Volume ≥5× 30-day average",
      hintKey: "vol",
    },
    {
      id: "move",
      pts: 14,
      label: "Move ≥8%",
      hintKey: "move",
    },
    {
      id: "daily",
      pts: 10,
      label: "Daily change ≥10%",
      hintKey: "daily",
    },
    {
      id: "price",
      pts: 4,
      label: "Price $1–$20",
      hintKey: "price",
    },
  ];
  const RM_NEWS_WEIGHT = 24;

  function rmComponentHints(p) {
    const last = p.last != null ? Number(p.last) : null;
    const pct = p.pct_change != null ? Number(p.pct_change) : null;
    return {
      float: true,
      price: last != null && last >= 1 && last <= 20,
      daily: pct != null && pct >= 10,
      move: pct != null && pct >= 8,
      vol: null,
      news: null,
    };
  }

  function findRmBreakdown(rm, hints) {
    if (rm == null || Number.isNaN(Number(rm))) return null;
    const target = Number(rm);
    const candidates = [];
    for (let mask = 0; mask < 1 << RM_WEIGHTS.length; mask++) {
      let sum = 0;
      const parts = [];
      for (let i = 0; i < RM_WEIGHTS.length; i++) {
        if (mask & (1 << i)) {
          sum += RM_WEIGHTS[i].pts;
          parts.push(RM_WEIGHTS[i]);
        }
      }
      if (Math.abs(sum - target) > 0.01) continue;
      let consistency = 0;
      for (const part of parts) {
        if (!part.hintKey) continue;
        const h = hints[part.hintKey];
        if (h === true) consistency += 2;
        if (h === false) consistency -= 1;
      }
      candidates.push({ parts, sum, consistency });
    }
    if (!candidates.length) return null;
    candidates.sort(
      (a, b) =>
        b.consistency - a.consistency || a.parts.length - b.parts.length
    );
    return candidates[0];
  }

  function rmHintNote(hints, hintKey) {
    const h = hints[hintKey];
    if (h === true) return " · matches %/price in export";
    if (h === false) return " · export %/price below threshold";
    if (hintKey === "vol" || hintKey === "news") {
      return " · confirmed in ToS scan only";
    }
    return "";
  }

  function buildRmScoreTooltipHtml(p) {
    const base = p.rm_confidence;
    const shown = pickScore(p);
    const cat = p.catalyst || {};
    const hints = rmComponentHints(p);
    const parts = p.rm_score_parts;
    const fracs = p.rm_score_fractions;
    const breakdown = base != null && !parts ? findRmBreakdown(base, hints) : null;
    const onIds = new Set((breakdown?.parts || []).map((x) => x.id));

    let rows =
      '<p class="rm-tip-title">RM confidence (H-001)</p>' +
      '<p class="rm-tip-sub">Sliding score · weighted signal strength (not pass/fail)</p>' +
      '<ul class="rm-tip-list">';

    for (const w of RM_WEIGHTS) {
      let pts;
      let cls;
      if (parts && parts[w.id] != null) {
        const earned = parts[w.id];
        const frac = fracs?.[w.id];
        pts =
          earned > 0
            ? "+" + (Number.isInteger(earned) ? earned : earned.toFixed(1))
            : "0";
        if (frac != null && frac > 0 && frac < 0.95) {
          pts += " (" + Math.round(frac * 100) + "%)";
        }
        cls = earned > 0 ? "rm-tip-on" : "rm-tip-off";
      } else {
        const on = onIds.has(w.id);
        pts = on ? "+" + w.pts : "0";
        cls = on ? "rm-tip-on" : "rm-tip-off";
      }
      const note =
        parts && parts[w.id] > 0 ? rmHintNote(hints, w.hintKey) : onIds.has(w.id) ? rmHintNote(hints, w.hintKey) : "";
      rows +=
        '<li class="' +
        cls +
        '"><span class="rm-tip-pts">' +
        pts +
        '</span> ' +
        escapeHtml(w.label) +
        (note ? '<span class="rm-tip-note">' + escapeHtml(note) + "</span>" : "") +
        "</li>";
    }
    rows += "</ul>";

    rows +=
      '<p class="rm-tip-total">Scan export: <strong>' +
      fmt(base) +
      "</strong>";
    if (p.rm_rank_pct != null) {
      rows += " · session rank <strong>top " + p.rm_rank_pct + "%</strong>";
    }
    if (breakdown) {
      rows += " (= " + breakdown.parts.map((x) => x.pts).join(" + ") + ")";
    }
    rows += "</p>";

    const newsWeight = RM_WEIGHTS.find((w) => w.id === "news")?.pts ?? RM_NEWS_WEIGHT;
    if (cat.verified === false && base != null) {
      rows +=
        '<p class="rm-tip-adj">No verified catalyst: <strong>−' +
        newsWeight +
        "</strong> news proxy removed → display <strong>" +
        fmt(shown) +
        "</strong></p>";
    } else if (shown != null && base != null && shown !== base) {
      rows +=
        '<p class="rm-tip-adj">Adjusted display: <strong>' +
        fmt(shown) +
        "</strong></p>";
    }

    return rows;
  }

  function rmScorePct(p) {
    const shown = pickScore(p);
    if (shown == null || Number.isNaN(Number(shown))) return 0;
    return Math.min(100, Math.max(0, Number(shown)));
  }

  function rmMeterTier(pct) {
    if (pct >= 70) return "high";
    if (pct >= 45) return "mid";
    return "low";
  }

  function renderRmScoreMeter(p, size) {
    const shown = pickScore(p);
    const pct = rmScorePct(p);
    const tier = rmMeterTier(pct);
    const sz = size || "row";
    return (
      '<div class="rm-meter rm-meter-' +
      sz +
      " rm-tier-" +
      tier +
      ' rm-score-tip" tabindex="0" data-symbol="' +
      escapeAttr(p.symbol) +
      '">' +
      '<div class="rm-meter-head">' +
      '<span class="rm-meter-num">' +
      fmt(shown) +
      '</span><span class="rm-meter-pct">' +
      Math.round(pct) +
      "%</span></div>" +
      '<div class="rm-meter-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      Math.round(pct) +
      '">' +
      '<div class="rm-meter-fill" style="width:' +
      pct +
      '%"></div>' +
      '<div class="rm-meter-glow"></div>' +
      "</div>" +
      '<span class="rm-meter-label">RM confidence</span>' +
      "</div>"
    );
  }

  function renderRmScoreSpan(p) {
    return renderRmScoreMeter(p, "compact");
  }

  let rmTooltipEl = null;
  let rmTooltipPick = null;

  function ensureRmTooltip() {
    if (!rmTooltipEl) {
      rmTooltipEl = document.createElement("div");
      rmTooltipEl.id = "rmScoreTooltip";
      rmTooltipEl.className = "rm-score-tooltip hidden";
      rmTooltipEl.setAttribute("role", "tooltip");
      document.body.appendChild(rmTooltipEl);
    }
    return rmTooltipEl;
  }

  function positionRmTooltip(anchor) {
    const tip = ensureRmTooltip();
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    tip.style.left = "0";
    tip.style.top = "0";
    tip.classList.remove("hidden");
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - margin;
    if (top < margin) top = rect.bottom + margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top + window.scrollY) + "px";
  }

  function showRmTooltip(anchor, pick) {
    rmTooltipPick = pick;
    const tip = ensureRmTooltip();
    tip.innerHTML = buildRmScoreTooltipHtml(pick);
    tip.classList.remove("hidden");
    positionRmTooltip(anchor);
  }

  function hideRmTooltip() {
    rmTooltipPick = null;
    if (rmTooltipEl) rmTooltipEl.classList.add("hidden");
  }

  function bindRmScoreTooltips(root) {
    if (!root) return;
    root.querySelectorAll(".rm-score-tip, .rm-meter").forEach((el) => {
      if (el.dataset.rmTipBound) return;
      el.dataset.rmTipBound = "1";
      const sym =
        el.closest(".pick-row")?.dataset.symbol ||
        el.dataset.symbol ||
        activePick?.symbol;
      const show = () => {
        const p = (session?.picks || []).find((x) => x.symbol === sym) || activePick;
        if (p) showRmTooltip(el, p);
      };
      el.addEventListener("mouseenter", show);
      el.addEventListener("focus", show);
      el.addEventListener("mouseleave", hideRmTooltip);
      el.addEventListener("blur", hideRmTooltip);
    });
  }

  function showDrawerPanel(which) {
    const stack = $("drawerAccountStack");
    const trade = $("drawerTradeView");
    if (stack) stack.classList.toggle("hidden", which === "trade");
    if (trade) trade.classList.toggle("hidden", which !== "trade");
  }

  function openAccountDrawer() {
    activePick = null;
    activeHolding = null;
    setText("drawerTitle", "Account");
    setText("drawerSubtitle", "Schwab · holdings · YTD");
    showDrawerPanel("account");
    renderDrawerHoldings();
    renderDrawerYtd();
    if (typeof RMAuthGate !== "undefined") renderDrawerAuth();
    const renderSchwab = () => {
      if (typeof RMSchwab !== "undefined" && RMSchwab.render) {
        void RMSchwab.render();
      }
    };
    if (typeof RMChunkLoader !== "undefined") {
      void RMChunkLoader.ensureBroker().then(renderSchwab).catch(renderSchwab);
    } else {
      renderSchwab();
    }
    openOrderDrawer();
  }

  function formatAuthTime(ms) {
    if (!ms) return "";
    try {
      return new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }

  async function renderDrawerAuth() {
    const userEl = $("drawerAuthUser");
    const listEl = $("drawerRecentUsers");
    const user =
      typeof RMAuthGate !== "undefined" ? RMAuthGate.getUser() : null;
    if (userEl) {
      userEl.textContent = user
        ? (user.displayName || user.email) + " · " + (user.email || "")
        : "Signed out — refresh to sign in again.";
    }
    if (!listEl || typeof RMAuthGate === "undefined") return;
    listEl.innerHTML = '<p class="meta drawer-recent-user-row">Loading recent users…</p>';
    const rows = await RMAuthGate.fetchRecentUsers();
    if (!rows.length) {
      listEl.innerHTML =
        '<p class="meta drawer-recent-user-row">No recent sign-ins yet.</p>';
      return;
    }
    listEl.innerHTML = rows
      .map(
        (row) =>
          '<div class="drawer-recent-user-row" role="listitem">' +
          '<span class="drawer-recent-user-name">' +
          escapeHtml(row.displayName || row.email || row.userId) +
          "</span>" +
          '<span class="drawer-recent-user-meta">' +
          escapeHtml(row.method || "login") +
          "</span>" +
          '<span class="drawer-recent-user-email">' +
          escapeHtml(row.email || "") +
          (row.loggedAt ? " · " + escapeHtml(formatAuthTime(row.loggedAt)) : "") +
          "</span></div>"
      )
      .join("");
  }

  function showDrawerHoldings() {
    openAccountDrawer();
  }

  function showDrawerTrade(p) {
    activePick = p;
    activeHolding = null;
    setText("drawerTitle", p.symbol);
    setText("drawerSubtitle", "Plan trade");
    showDrawerPanel("trade");
    populateOrderDrawer(p);
    openOrderDrawer();
  }

  function renderSparkline(history) {
    const pts = (history || []).filter((h) => h.price != null);
    if (pts.length < 2) return "";
    const prices = pts.map((h) => Number(h.price));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const w = 200;
    const h = 48;
    const coords = prices
      .map((pr, i) => {
        const x = (i / (prices.length - 1)) * w;
        const y = h - ((pr - min) / range) * (h - 4) - 2;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    return (
      '<svg class="hold-spark" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" preserveAspectRatio="none">' +
      '<polyline fill="none" stroke="currentColor" stroke-width="2" points="' +
      coords +
      '"/></svg>'
    );
  }

  function renderHoldingCard(h, compact) {
    const px = RMHoldings.currentPrice(h);
    const pnl = RMHoldings.calcPnL(h, px);
    const pnlCls =
      pnl && pnl.pct > 0 ? "up" : pnl && pnl.pct < 0 ? "down" : "";
  const pnlTxt =
      pnl && pnl.pct != null
        ? (pnl.pct >= 0 ? "+" : "") + pnl.pct.toFixed(2) + "%"
        : "—";
    const spark = compact ? "" : renderSparkline(h.price_history);
    const manageBtn = h.readOnly
      ? ""
      : '<button type="button" class="holding-manage-btn secondary btn-sm" data-holding-id="' +
        escapeAttr(h.id) +
        '">Manage</button>';
    return (
      '<div class="holding-card' +
      (compact ? " holding-card-compact" : "") +
      '" data-holding-id="' +
      escapeAttr(h.id) +
      '" title="View on chart" role="button" tabindex="0">' +
      '<div class="holding-card-top">' +
      "<strong>" +
      escapeHtml(h.symbol) +
      "</strong>" +
      (h.source === "schwab"
        ? ' <span class="rm-schwab-badge" title="Live Schwab position">Schwab</span>'
        : "") +
      '<span class="holding-pnl ' +
      pnlCls +
      '">' +
      pnlTxt +
      "</span></div>" +
      '<p class="meta">Entry $' +
      (h.entry_price != null ? Number(h.entry_price).toFixed(2) : "—") +
      (px != null ? " · Now $" + px.toFixed(2) : "") +
      (h.quantity != null ? " · Qty " + h.quantity : "") +
      (h.market_value != null ? " · MV $" + Number(h.market_value).toFixed(0) : "") +
      (h.rm_confidence != null ? " · RM " + Math.round(h.rm_confidence) : "") +
      "</p>" +
      spark +
      manageBtn +
      "</div>"
    );
  }

  function findDisplayHolding(id) {
    if (typeof RMHoldings === "undefined") return null;
    const local = RMHoldings.findById(id);
    if (local) return local;
    return (RMHoldings.getDisplayOpen() || []).find((h) => h.id === id) || null;
  }

  function renderDrawerHoldings() {
    const open =
      typeof RMHoldings !== "undefined" ? RMHoldings.getDisplayOpen() : [];
    const empty = $("holdingsEmpty");
    const list = $("drawerHoldingsList");
    const add = $("drawerAddHolding");
    const detail = $("drawerHoldingDetail");
    if (add) add.classList.add("hidden");
    if (detail) {
      detail.classList.add("hidden");
      detail.innerHTML = "";
    }
    if (!open.length) {
      if (empty) {
        empty.classList.remove("hidden");
        const brokerN =
          typeof RMHoldings !== "undefined" && RMHoldings.getBrokerPositions
            ? RMHoldings.getBrokerPositions().length
            : 0;
        const p = empty.querySelector("p");
        if (p) {
          p.textContent = brokerN
            ? "No manual holdings — Schwab positions appear above after sync."
            : "No open positions. Connect Schwab above, sync fills, or add a holding.";
        }
      }
      if (list) {
        list.classList.add("hidden");
        list.innerHTML = "";
      }
      return;
    }
    if (empty) empty.classList.add("hidden");
    if (list) {
      list.classList.remove("hidden");
      list.innerHTML =
        open.map((h) => renderHoldingCard(h, true)).join("") +
        '<button type="button" id="btnShowAddHoldingList" class="btn-block secondary">+ Add holding</button>';
      list.querySelectorAll(".holding-card").forEach((el) => {
        el.addEventListener("click", () => {
          const id = el.dataset.holdingId;
          const h = findDisplayHolding(id);
          if (h) openHoldingOnChart(h);
        });
        el.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          const h = findDisplayHolding(el.dataset.holdingId);
          if (h) openHoldingOnChart(h);
        });
      });
      list.querySelectorAll(".holding-manage-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const h = findDisplayHolding(btn.dataset.holdingId);
          if (h) showHoldingDetail(h);
        });
      });
      const btn = $("btnShowAddHoldingList");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          showAddHoldingForm();
        });
      }
    }
    syncChartHoldingSymbols();
  }

  function showHoldingDetail(h) {
    activeHolding = h;
    const px = RMHoldings.currentPrice(h);
    const pnl = RMHoldings.calcPnL(h, px);
    const empty = $("holdingsEmpty");
    const list = $("drawerHoldingsList");
    const detail = $("drawerHoldingDetail");
    if (empty) empty.classList.add("hidden");
    if (list) list.classList.add("hidden");
    if (!detail) return;
    detail.classList.remove("hidden");
    const pnlCls =
      pnl && pnl.pct > 0 ? "up" : pnl && pnl.pct < 0 ? "down" : "";
    detail.innerHTML =
      '<button type="button" class="secondary btn-sm drawer-back" id="btnHoldingsBack">← All holdings</button>' +
      '<button type="button" class="btn-block secondary" id="btnViewHoldingChart">View on chart</button>' +
      "<h3>" +
      escapeHtml(h.symbol) +
      "</h3>" +
      renderSparkline(h.price_history) +
      '<p class="holding-pnl-big ' +
      pnlCls +
      '">' +
      (pnl && pnl.pct != null
        ? (pnl.pct >= 0 ? "+" : "") + pnl.pct.toFixed(2) + "%"
        : "—") +
      (pnl && pnl.dollars != null
        ? " · " + (pnl.dollars >= 0 ? "+" : "") + "$" + pnl.dollars.toFixed(2)
        : "") +
      "</p>" +
      '<p class="meta">Entry $' +
      (h.entry_price != null ? Number(h.entry_price).toFixed(2) : "—") +
      " · Qty " +
      (h.quantity != null ? h.quantity : "—") +
      " · RM " +
      (h.rm_confidence != null ? Math.round(h.rm_confidence) : "—") +
      "</p>" +
      '<p class="meta">' +
      escapeHtml(h.notes || "") +
      "</p>" +
      '<label>Update price</label>' +
      '<input type="number" step="0.01" id="holdMark" inputmode="decimal" value="' +
      (px != null ? px : "") +
      '">' +
      '<button type="button" id="btnUpdateMark">Update mark</button>' +
      '<label>Exit price (sell)</label>' +
      '<input type="number" step="0.01" id="holdExit" inputmode="decimal">' +
      '<button type="button" id="btnSellHolding" class="danger">Record sale</button>';
    $("btnHoldingsBack").addEventListener("click", renderDrawerHoldings);
    $("btnViewHoldingChart")?.addEventListener("click", () => openHoldingOnChart(h));
    $("btnUpdateMark").addEventListener("click", () => {
      const v = num("holdMark");
      if (v != null) {
        RMHoldings.appendPrice(h.symbol, v, "manual");
        renderHoldings();
        showHoldingDetail(RMHoldings.findById(h.id));
      }
    });
    $("btnSellHolding").addEventListener("click", () => {
      const exit = num("holdExit") ?? num("holdMark");
      RMHoldings.closeHolding(h.id, exit);
      renderHoldings();
      renderLearningStats();
      renderDrawerHoldings();
    });
  }

  function showAddHoldingForm(prefill) {
    const empty = $("holdingsEmpty");
    const list = $("drawerHoldingsList");
    const add = $("drawerAddHolding");
    const detail = $("drawerHoldingDetail");
    if (empty) empty.classList.add("hidden");
    if (list) list.classList.add("hidden");
    if (detail) detail.classList.add("hidden");
    if (add) {
      add.classList.remove("hidden");
      if (prefill) {
        if (prefill.symbol) $("holdSymbol").value = prefill.symbol;
        if (prefill.entry_price != null) $("holdEntry").value = prefill.entry_price;
        if (prefill.quantity != null) $("holdQty").value = prefill.quantity;
      }
    }
  }

  function renderHoldings() {
    renderLearningStats();
  }

  function plannedTradeStatsYtd() {
    if (typeof RMTradeMetrics === "undefined") return null;
    const year = String(new Date().getFullYear());
    const closed = getTrades().filter((t) => {
      const d = t.closed_at || t.opened_at || "";
      return (
        d.startsWith(year) &&
        t.status === "closed" &&
        t.filled !== false &&
        RMTradeMetrics.isPlannedTrade(t)
      );
    });
    if (!closed.length) return null;
    const rs = closed.map((t) => RMTradeMetrics.rMultiple(t)).filter((r) => r != null);
    const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    return { n: closed.length, avgR };
  }

  function renderLearningStats() {
    const el = $("drawerLearningStats") || $("learningStats");
    if (!el) return;
    const parts = [];
    const ytd = plannedTradeStatsYtd();
    if (ytd?.avgR != null) {
      parts.push(
        "YTD expectancy " +
          (ytd.avgR >= 0 ? "+" : "") +
          ytd.avgR.toFixed(2) +
          "R (" +
          ytd.n +
          " planned)"
      );
    }
    if (typeof RMTradeMetrics !== "undefined") {
      const closed = getTrades().filter(
        (t) => t.status === "closed" && RMTradeMetrics.isPlannedTrade(t)
      );
      const deltas = closed.filter((t) => RMTradeMetrics.reconcileStatus(t) === "delta").length;
      if (deltas) parts.push(deltas + " pending reconcile");
      if (closed.length >= 30 && ytd?.avgR != null) {
        parts.push("Expectancy meaningful (30+ n)");
      }
    }
    if (typeof RMHoldings !== "undefined") {
      const s = RMHoldings.stats();
      if (s.closed > 0) {
        parts.push(
          s.winRate != null
            ? "Holdings win " + s.winRate.toFixed(0) + "% (" + s.closed + ")"
            : s.closed + " holdings closed"
        );
        if (s.highRmHitRate != null) {
          parts.push("RM≥50 hit " + s.highRmHitRate.toFixed(0) + "%");
        }
      } else if (!ytd) {
        parts.push("Close planned trades or holdings to build stats");
      }
      if (s.open > 0) parts.unshift(s.open + " open");
    } else if (!ytd) {
      parts.push("Close planned trades to build learning stats");
    }
    el.textContent = parts.join(" · ");
  }

  function saveHoldingFromForm() {
    const sym = ($("holdSymbol").value || "").trim().toUpperCase();
    if (!sym) {
      status("Enter a symbol");
      return;
    }
    const h = RMHoldings.addHolding({
      symbol: sym,
      entry_price: num("holdEntry"),
      quantity: num("holdQty"),
      instrument: $("holdInstrument").value,
      notes: $("holdNotes").value,
      rm_confidence: activePick ? activePick.rm_confidence : null,
      session_id: session ? session.session_id : null,
    });
    $("holdSymbol").value = "";
    $("holdEntry").value = "";
    $("holdQty").value = "1";
    $("holdNotes").value = "";
    status("Holding added: " + h.symbol);
    renderHoldings();
    renderLearningStats();
    renderDrawerHoldings();
  }

  function getTrades() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function getJournalTrades() {
    if (typeof RMSchwabData !== "undefined" && RMSchwabData.getAllTradesForJournal) {
      return RMSchwabData.getAllTradesForJournal(getTrades(), schwabClosedTrades);
    }
    return getTrades();
  }

  async function refreshSchwabJournalTrades() {
    if (typeof RMSchwabData === "undefined" || !RMSchwabData.refreshSchwabTrades) return;
    schwabClosedTrades = await RMSchwabData.refreshSchwabTrades(true);
    if (typeof RMTradeStory !== "undefined" && schwabClosedTrades?.length) {
      for (const t of schwabClosedTrades) {
        if (t.reconciled && (t.realized_r != null || t.r_multiple != null)) {
          void RMTradeStory.syncReconcile(t, { source: "schwab_api" });
        }
      }
    }
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    renderLearningStats();
  }

  function saveTrades(trades) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  }

  function showNewsProgressBar() {
    const wrap = $("newsProgress");
    if (wrap) wrap.classList.remove("hidden");
  }

  let scanProgressPct = 0;
  let scanProgressRaf = null;

  const customScanEta = {
    active: false,
    raf: 0,
    startMs: 0,
    durationMs: 90000,
    fromPct: 0,
    toPct: 92,
    currentPct: 0,
  };

  function stopCustomScanEta() {
    customScanEta.active = false;
    if (customScanEta.raf) {
      cancelAnimationFrame(customScanEta.raf);
      customScanEta.raf = 0;
    }
    const fill = $("scanProgressFill");
    if (fill) fill.classList.remove("is-estimated");
  }

  function tickCustomScanEta(now) {
    if (!customScanEta.active) return;
    const elapsed = now - customScanEta.startMs;
    const t = Math.min(1, elapsed / customScanEta.durationMs);
    const eased = 1 - Math.pow(1 - t, 2.4);
    const pct =
      customScanEta.fromPct + eased * (customScanEta.toPct - customScanEta.fromPct);
    customScanEta.currentPct = Math.max(customScanEta.currentPct, pct);
    applyScanProgressPct(customScanEta.currentPct, { skipTransition: true });
    if (t < 1) {
      customScanEta.raf = requestAnimationFrame(tickCustomScanEta);
    }
  }

  /** Smooth left→right bar sized to approximate time remaining */
  function startCustomScanEta({ durationMs, fromPct = 0, toPct = 92, label }) {
    stopCustomScanEta();
    customScanEta.active = true;
    customScanEta.startMs = performance.now();
    customScanEta.durationMs = Math.max(4000, durationMs);
    customScanEta.fromPct = fromPct;
    customScanEta.toPct = toPct;
    customScanEta.currentPct = fromPct;
    const fill = $("scanProgressFill");
    if (fill) fill.classList.add("is-estimated");
    applyScanProgressPct(fromPct, { skipTransition: true });
    if (label) setScanProgressLabel(label);
    customScanEta.raf = requestAnimationFrame(tickCustomScanEta);
  }

  function extendCustomScanEta({ addMs, toPct, label }) {
    if (!customScanEta.active) return;
    if (customScanEta.raf) cancelAnimationFrame(customScanEta.raf);
    customScanEta.fromPct = customScanEta.currentPct;
    if (toPct != null) customScanEta.toPct = toPct;
    customScanEta.startMs = performance.now();
    customScanEta.durationMs = Math.max(3000, addMs ?? 20000);
    if (label) setScanProgressLabel(label);
    customScanEta.raf = requestAnimationFrame(tickCustomScanEta);
  }

  function finishCustomScanEta(label) {
    stopCustomScanEta();
    applyScanProgressPct(100);
    if (label) setScanProgressLabel(label);
    mirrorScanProgressToPanel();
  }

  function applyScanProgressPct(pct, opts) {
    scanProgressPct = Math.min(100, Math.max(0, pct));
    const fill = $("scanProgressFill");
    const track = document.querySelector(".scan-progress-track");
    if (fill) {
      if (opts?.skipTransition) fill.classList.add("no-transition");
      fill.style.width = scanProgressPct.toFixed(1) + "%";
      if (opts?.skipTransition) {
        fill.offsetWidth;
        fill.classList.remove("no-transition");
      }
    }
    if (track) track.setAttribute("aria-valuenow", String(Math.round(scanProgressPct)));
    mirrorScanProgressToPanel();
  }

  /** index = 1-based symbol index; subFraction 0–1 within that symbol's slot */
  function setScanProgress(index, total, subFraction) {
    if (customScanEta.active) return;
    if (!total) return;
    const slot = 1 / total;
    const base = (index - 1) * slot;
    const pct = (base + slot * Math.min(1, subFraction || 0)) * 100;
    applyScanProgressPct(pct);
  }

  function refreshChartHub(opts) {
    const el = $("chartHubView");
    if (!el || typeof RMChartHub === "undefined") return;
    if (RMChartHub.state?.scanActive) return;
    if (
      opts?.compare !== false &&
      RMChartHub.state?.morningScanViewLock &&
      RMChartHub.state?.overlays?.size > 0 &&
      session?.news_filter_applied_at
    ) {
      return;
    }
    const useCompare =
      opts?.compare === false
        ? false
        : opts?.compare === true ||
          !!(session?.picks?.length && session.news_filter_applied_at);
    void (async () => {
      if (typeof RMAnalysisChart !== "undefined" && !useCompare) {
        RMAnalysisChart.state.symbol = "SPY";
      }
      if (session?.picks?.length && useCompare) {
        if (typeof RMAnalysisChart !== "undefined") {
          RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
        }
        await RMChartHub.renderComparison(el);
        await RMChartHub.syncFromSession(session.picks, { preserveView: true });
      } else {
        await RMChartHub.renderComparison(el, { fit: useCompare });
        if (session?.picks?.length && RMChartHub.preloadSessionOverlays) {
          await RMChartHub.preloadSessionOverlays(session.picks);
        }
      }
    })();
  }

  async function onSessionLoaded(options) {
    if (!session || !session.picks || !session.picks.length) {
      throw new Error("No symbols found in scan — check CSV has a Symbol column");
    }
    const histLabel = options?.fromHistory
      ? (session.scanned_at || "").slice(0, 16).replace("T", " ") + " · history"
      : null;
    setHeaderMeta(
      histLabel ||
        "Loaded " + (session.pick_count || 0) + " picks — checking news…"
    );
    const mp = $("marketPanel");
    if (mp) {
      mp.classList.remove("hidden");
      mp.removeAttribute("aria-hidden");
    }
    if (typeof RMHoldings !== "undefined") {
      RMHoldings.syncPricesFromPicks(session.picks);
    }
    renderHoldings();
    // Render scan rows immediately — never block on market or news fetches.
    filterMomentumBullSession(session);
    const keepMobileScanLoader = isMobileSnapScans() && options?.fromCustomScan;
    if (typeof RMWorkspaceLoad !== "undefined") {
      if (keepMobileScanLoader) {
        updateScansPanelLoaderStep(
          (session.pick_count || 0) + " picks · checking news…",
          Math.max(42, scanProgressPct || 42)
        );
      } else {
        RMWorkspaceLoad.hidePanelLoader("scans");
      }
    }
    renderPicks();
    if (
      typeof RMWorkspaceAccordion !== "undefined" &&
      (options?.fromCustomScan || options?.runNewsScan)
    ) {
      RMWorkspaceAccordion.expand("scans");
    }
    activePick = null;
    const runNewsScan =
      options?.runNewsScan === true || options?.fromCustomScan === true;
    showScansPanel();
    setScansTab("results", { skipSave: runNewsScan });
    updateResultsActiveSection();
    renderCalendarUi(undefined, "drawer");
    renderCalendarUi(undefined, "results");
    if (!runNewsScan) {
      refreshChartHub({ compare: false });
    }
    persistScanSession({
      entryType: options?.entryType,
      sourceKind: options?.sourceKind,
    });

    if (!options?.skipSidePanels) {
      if (typeof RMMarket !== "undefined" && mp) {
        RMMarket.refreshMarketPanel(mp, session.picks, { soft: true }).catch(() => {});
        syncLiveRefresh();
      }
      refreshMarketThemes();
    }

    if (!runNewsScan) {
      status(
        session.pick_count +
          " picks" +
          (session.news_filter_applied_at
            ? " · catalyst scan saved"
            : options?.fromHistory
              ? " · from history"
              : " · ready")
      );
      return;
    }
    try {
      await searchNews(options?.fromCustomScan ? { estimatedProgress: true } : undefined);
    } catch (e) {
      status(e.message || "News scan failed");
      newsScanRunning = false;
      renderPicks();
    }
  }

  function handleFileSelect(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    if (!file) return;
    showScansPanel();
    setPickListHtml(
      '<p class="status-msg">Reading ' + escapeHtml(file.name) + "…</p>"
    );
    const pickList = $("pickList");
    status("Reading " + file.name + "…");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (typeof RMScanParser === "undefined") {
          throw new Error("Parser failed to load — refresh the page");
        }
        session = RMScanParser.parseScanCsvText(reader.result, file.name);
        session.source_kind = "import";
        session.entry_type = "import";
        onSessionLoaded({ runNewsScan: true, entryType: "import", sourceKind: "import" })
          .catch((e) => {
            status(e.message || "Could not load scan");
            if (pickList) {
              pickList.innerHTML =
                '<p class="status-msg pick-error">' +
                escapeHtml(e.message || "Could not load scan") +
                "</p>";
            }
          })
          .finally(() => {
            input.value = "";
          });
      } catch (e) {
        status(e.message || "Could not parse CSV");
        if (pickList) {
          pickList.innerHTML =
            '<p class="status-msg pick-error">' +
            escapeHtml(e.message || "Could not parse CSV") +
            "</p>";
        }
        input.value = "";
      }
    };
    reader.onerror = () => {
      status("Could not read file");
      input.value = "";
    };
    reader.readAsText(file);
  }

  function publishedSessionUrl() {
    return new URL("session.json", window.location.href).href;
  }

  /** Fetch session.json without assigning global session (probe / optional load). */
  async function fetchPublishedSession() {
    const url = publishedSessionUrl();
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.picks || !data.picks.length) return null;
    return data;
  }

  async function loadPublishedSession() {
    const data = await fetchPublishedSession();
    if (!data) return false;
    session = data;
    return true;
  }

  function latestHistoryEntry() {
    if (typeof RMScanStore === "undefined") return null;
    for (const dateKey of RMScanStore.listDays()) {
      const entries = RMScanStore.getDay(dateKey);
      if (entries.length) return { dateKey, entry: entries[0] };
    }
    return null;
  }

  function applyHistorySnapshot(snap, meta) {
    if (!snap?.picks?.length) return false;
    session = {
      hypothesis_id: snap.hypothesis_id || "H-001",
      session_id: snap.session_id,
      scanned_at: snap.scanned_at,
      source_file: snap.source_file || "history",
      session_label: snap.session_label || "history",
      pick_count: snap.picks.length,
      picks: snap.picks,
      filtered_out: snap.filtered_out || [],
      news_scanned_at: snap.news_scanned_at || null,
      news_filter_applied_at: snap.news_scanned_at || null,
      accuracy: snap.accuracy || null,
    };
    if (meta?.dateKey && meta?.entryId) {
      historySelection = { dateKey: meta.dateKey, entryId: meta.entryId };
    }
    return true;
  }

  function scrollToHomeResults() {
    if (typeof RMWorkspaceAccordion !== "undefined") {
      RMWorkspaceAccordion.expand("chart");
    }
    ($("workspaceChart") || $("morningWorkspace"))?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  async function loadHistorySession(dateKey, entryId, opts) {
    if (typeof RMScanStore === "undefined") return false;
    const snap = RMScanStore.loadEntry(dateKey, entryId);
    if (!applyHistorySnapshot(snap, { dateKey, entryId })) {
      status("Could not load scan snapshot");
      return false;
    }
    const focusResults = opts?.focusResults === true;
    const keepDrawer = !focusResults && opts?.keepDrawer !== false;
    if (keepDrawer) {
      if (!$("scanDrawer")?.classList.contains("open")) {
        openScanSettingsDrawer();
      } else {
        setScanDrawerTab("scan");
      }
    }
    if (focusResults) {
      showScansPanel();
      setScansTab("results");
    }
    try {
      await onSessionLoaded({
        fromHistory: true,
        runNewsScan: false,
        focusResults,
      });
      renderCalendarUi(undefined, "drawer");
      renderCalendarUi(undefined, "results");
      if (!focusResults) scrollToHomeResults();
      else {
        $("ttResultsActive")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      const label = (snap.scanned_at || dateKey).slice(0, 16).replace("T", " ");
      showToast("Loaded scan · " + label, "info");
      return true;
    } catch (e) {
      status(e.message || "Load failed");
      return false;
    }
  }

  async function bootRenderPicksProgressive(loadSlot, listRoot) {
    const picks = sortPicksByGapUp(session.picks || []);
    const label = session.session_label ? " · " + session.session_label : "";
    setPageTitle("Rainmaker Morning" + label);
    setHeaderMeta(
      (session.scanned_at || "").slice(0, 16).replace("T", " ") +
        " · " +
        (session.source_file || "") +
        " · " +
        (session.pick_count || 0) +
        " picks"
    );
    const picksHeading = $("picksHeading");
    if (picksHeading) {
      const base = session.news_filter_applied_at
        ? "Scan + news (catalyst only)"
        : WS_COL_TITLE.scans;
      picksHeading.textContent = base + " · gap ↑";
    }

    listRoot.innerHTML = "";
    const removed = session.filtered_out || [];
    if (removed.length) {
      await loadSlot(listRoot, "Scan status", async (slot) => {
        slot.innerHTML =
          '<p class="status-msg pick-removed-banner">Removed ' +
          removed.length +
          " without news today: " +
          escapeHtml(removed.map((x) => x.symbol).join(", ")) +
          "</p>";
      });
    }

    if (!picks.length) {
      await loadSlot(listRoot, WS_COL_TITLE.scans, async (slot) => {
        slot.innerHTML = '<p class="status-msg">No picks to show.</p>';
      });
      return;
    }

    let bannerHtml = "";
    if (removed.length) {
      bannerHtml =
        '<p class="status-msg pick-removed-banner">Removed ' +
        removed.length +
        " without news today: " +
        escapeHtml(removed.map((x) => x.symbol).join(", ")) +
        "</p>";
    }
    if (
      typeof RMVirtualPickList !== "undefined" &&
      RMVirtualPickList.shouldVirtualize(picks.length)
    ) {
      await loadSlot(listRoot, WS_COL_TITLE.scans, async (slot) => {
        RMVirtualPickList.mount(slot, {
          renderRow: renderPickRow,
          bind: bindPickListSubtree,
        });
        RMVirtualPickList.render(picks, bannerHtml);
      });
      renderScanMetricsStrip();
      if (!newsScanRunning) refreshChartHub();
      return;
    }

    const stream = document.createElement("div");
    stream.className = "pick-list-stream";
    listRoot.appendChild(stream);

    for (const p of picks) {
      const rowSlot = document.createElement("div");
      stream.appendChild(rowSlot);
      await loadSlot(rowSlot, p.symbol, async (slot) => {
        slot.outerHTML = renderPickRow(p);
      });
    }

    bindPickAccordions(listRoot);
    bindRmScoreTooltips(listRoot);
    bindUiTips(listRoot);
    renderScanMetricsStrip();
    if (!newsScanRunning) refreshChartHub();
  }

  function isMobilePerfBoot() {
    return typeof RMMobilePerf !== "undefined" && RMMobilePerf.isMobilePerf();
  }

  const noopLoadSlot = async (el, _label, fn) => {
    if (el) await fn(el);
  };

  function registerMobileWarmHooks() {
    if (typeof RMMobilePerf === "undefined") return;
    RMMobilePerf.registerWarmHooks({
      warmChart: async () => {
        const panel = document.getElementById("workspaceChart");
        if (panel?.classList.contains("ws-panel--ready")) return;
        if (typeof RMWorkspaceLoad !== "undefined") {
          await RMWorkspaceLoad.runColumn("chart", bootChartColumn);
        } else {
          await bootChartColumn(noopLoadSlot);
        }
      },
      warmScans: async () => {
        const panel = document.getElementById("workspaceScans");
        if (panel?.classList.contains("ws-panel--ready")) return;
        if (typeof RMWorkspaceLoad !== "undefined") {
          await RMWorkspaceLoad.runColumn("scans", bootScansColumn);
        } else {
          await bootScansColumn(noopLoadSlot);
        }
      },
    });
  }

  async function awaitMarketThemesRefresh(themesEl) {
    if (!themesEl || typeof RMMarketThemes === "undefined") return;
    await RMMarketThemes.refresh(themesEl, { picks: session?.picks || [] });
  }

  async function bootMarketColumn(loadSlot) {
    const themes = $("marketThemes");
    const mp = $("marketPanel");
    if (mp) {
      mp.classList.remove("hidden");
      mp.removeAttribute("aria-hidden");
    }

    const indicesJob =
      typeof RMMarket !== "undefined" ? RMMarket.prefetchIndices() : Promise.resolve({});

    const indices = await indicesJob;
    await loadSlot(mp, WS_COL_TITLE.market, async (el) => {
      if (typeof RMMarket !== "undefined") {
        try {
          await RMMarket.refreshMarketPanelProgressive(
            el,
            session?.picks || [],
            loadSlot,
            { indices, mobilePerf: isMobilePerfBoot() }
          );
        } catch {
          el.innerHTML =
            '<div class="mkt-grid"><div class="mkt-tile"><span class="mkt-tile-label">Market</span><span class="mkt-tile-val">Offline</span></div></div>';
        }
      }
    });
    syncLiveRefresh();

    await loadSlot(themes, "Theme heat", async (el) => {
      await awaitMarketThemesRefresh(el);
    });
  }

  async function bootChartColumn(loadSlot) {
    const el = $("chartHubView");
    try {
      globalThis.__rmChartBootApiOnly = true;
      if (typeof RMChartHub !== "undefined" && RMChartHub.renderComparisonProgressive) {
        await RMChartHub.renderComparisonProgressive(el, loadSlot);
        syncBackgroundActivity();
        await bootstrapSchwabForDashboard();
        return;
      }
      if (typeof RMChartHub !== "undefined") {
        await loadSlot(el, WS_COL_TITLE.chart, async (slot) => {
          await RMChartHub.renderComparison(slot);
        });
      }
      syncBackgroundActivity();
      await bootstrapSchwabForDashboard();
    } finally {
      globalThis.__rmChartBootApiOnly = false;
    }
  }

  async function bootScansColumn(loadSlot) {
    const listRoot = $("pickList");
    loadScansTabPref();

    if (!session?.picks?.length) {
      session = null;
      setScansPanelDismissed(false);
    }

    await loadSlot(listRoot, "Getting started", async () => {
      setScansTab(scansTab, { skipSave: true });
      if (typeof RMResultsHero !== "undefined") RMResultsHero.showDefault();
    });
    status("SPY chart ready · Import or scan to load picks");
  }

  function ensureCleanBootState() {
    session = null;
    activePick = null;
    historySelection = null;
    if (typeof RMChartHub !== "undefined") {
      RMChartHub.resetOverlays?.();
      RMChartHub.state.sessionPicks = [];
    }
    if (typeof RMMarket !== "undefined") RMMarket.stopLivePickRefresh?.();
  }

  function bootstrapSchwabForDashboard() {
    if (typeof RMChunkLoader === "undefined") return Promise.resolve();
    return RMChunkLoader.ensureBroker()
      .then(() => {
        if (typeof RMSchwab !== "undefined" && RMSchwab.bootstrapDashboard) {
          return RMSchwab.bootstrapDashboard();
        }
        if (typeof RMSchwab !== "undefined" && RMSchwab.render) {
          return RMSchwab.render();
        }
      })
      .catch(() => {});
  }

  async function boot() {
    if (typeof RMMetrics !== "undefined") {
      RMMetrics.markMorningOpen({ embed: document.body.classList.contains("is-embed") });
    }
    if (typeof RMSchwabData !== "undefined" && RMSchwabData.applyRealJournalCutover) {
      RMSchwabData.applyRealJournalCutover();
    }
    ensureCleanBootState();
    ensureDrawersClosed();
    loadScansTabPref();
    if (typeof RMWorkspaceLoad !== "undefined") RMWorkspaceLoad.init();
    if (typeof RMBrandLogo !== "undefined") RMBrandLogo.mount();
    if (typeof RMChunkLoader !== "undefined") {
      RMChunkLoader.preloadNonCritical();
    }
    if (typeof RMAgent !== "undefined") RMAgent.mount();
    renderDrawerYtd();
    renderHoldings();
    void refreshSchwabJournalTrades();

    if (typeof RMScanStore !== "undefined") {
      void RMScanStore.syncPublishedCatalog(window.location.href).catch((e) => {
        console.warn("scan catalog sync", e);
      });
    }

    const runners = {
      market: bootMarketColumn,
      chart: bootChartColumn,
      scans: bootScansColumn,
    };

    registerMobileWarmHooks();

    try {
      if (typeof RMWorkspaceLoad !== "undefined") {
        if (isMobilePerfBoot()) {
          await RMWorkspaceLoad.runColumn("market", runners.market);
          if (typeof RMWorkspaceAccordion !== "undefined") {
            RMWorkspaceAccordion.onColumnReady("market");
          }
          if (typeof RMWorkspaceLoad !== "undefined") RMWorkspaceLoad.finish();
          if (typeof RMMobilePerf !== "undefined") RMMobilePerf.warmAfterMarket();
          syncBackgroundActivity();
          return;
        }
        for (const col of RMWorkspaceLoad.columnOrder()) {
          await RMWorkspaceLoad.runColumn(col, runners[col]);
        }
        return;
      }

      const directSlot = async (el, _label, fn) => {
        if (el) await fn(el);
      };
      await bootMarketColumn(directSlot);
      if (typeof RMWorkspaceAccordion !== "undefined") {
        RMWorkspaceAccordion.onColumnReady("market");
      }
      await bootChartColumn(directSlot);
      if (typeof RMWorkspaceAccordion !== "undefined") {
        RMWorkspaceAccordion.onColumnReady("chart");
      }
      await bootScansColumn(directSlot);
    } finally {
      if (typeof RMWorkspaceLoad !== "undefined") RMWorkspaceLoad.finish();
      if (typeof RMWorkspaceAccordion !== "undefined") RMWorkspaceAccordion.sync?.();
      syncBackgroundActivity();
    }
  }

  function formatPct(n) {
    if (n == null || n === "") return null;
    const v = Number(n);
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }

  function priceMoveClass(v) {
    if (v > 0.05) return "move-up";
    if (v < -0.05) return "move-down";
    return "move-flat";
  }

  function formatGapBadge(gapPct) {
    if (gapPct == null || gapPct === "") return "";
    const v = Number(gapPct);
    if (Number.isNaN(v) || v <= 0) return "";
    return (
      '<span class="pick-gap price-move move-up fv-tip-target" tabindex="0"' +
      fvTipData(
        "Gap up",
        "Opening gap",
        "Percent above prior close at the open. Morning momentum filter favors gap-up names.",
        "Gap " + formatPct(v)
      ) +
      '">' +
      '<span class="move-arrow" aria-hidden="true">↑</span>' +
      '<span class="move-pct">Gap ' +
      formatPct(v) +
      "</span></span>"
    );
  }

  function formatEodBadge(pctEod, pctChange) {
    const v =
      pctEod != null && pctEod !== ""
        ? Number(pctEod)
        : pctChange != null
          ? Number(pctChange)
          : null;
    if (v == null || Number.isNaN(v)) return "";
    const cls = priceMoveClass(v);
    const label = pctEod != null ? "EOD" : "Day";
    return (
      '<span class="pick-eod price-move ' +
      cls +
      ' fv-tip-target" tabindex="0"' +
      fvTipData(
        "Session move",
        label + " change",
        "Percent vs prior close through session close or latest quote.",
        label + " " + formatPct(v)
      ) +
      '">' +
      '<span class="move-pct">' +
      label +
      " " +
      formatPct(v) +
      "</span></span>"
    );
  }

  function isConfirmedPick(p) {
    const cat = p.catalyst || {};
    return cat.verified === true || (cat.headlines && cat.headlines.length > 0);
  }

  function filterMomentumBullSession(sess) {
    if (!sess?.picks) return sess;
    const removed = [];
    sess.picks = sess.picks.filter((p) => {
      if (p.pct_change != null && Number(p.pct_change) < 0) {
        removed.push({ symbol: p.symbol, reason: "gap_down_or_negative_day" });
        return false;
      }
      if (p.gap_pct != null && Number(p.gap_pct) < 0) {
        removed.push({ symbol: p.symbol, reason: "gap_down" });
        return false;
      }
      return true;
    });
    if (removed.length) {
      sess.filtered_out = (sess.filtered_out || []).concat(removed);
      showToast(
        "Removed " +
          removed.length +
          " non-bull names: " +
          removed.map((x) => x.symbol).join(", "),
        "warn"
      );
    }
    sess.pick_count = sess.picks.length;
    return sess;
  }

  function renderPriceMove(pctChange) {
    if (pctChange == null || pctChange === "") return "";
    const v = Number(pctChange);
    if (Number.isNaN(v)) return "";
    const cls = priceMoveClass(v);
    const arrow = v > 0.05 ? "▲" : v < -0.05 ? "▼" : "■";
    const text = formatPct(v);
    return (
      '<span class="price-move ' +
      cls +
      ' fv-tip-target" tabindex="0"' +
      fvTipData(
        "Day move",
        "Session change",
        "Percent change vs prior close through the latest quote.",
        text
      ) +
      '"><span class="move-arrow" aria-hidden="true">' +
      arrow +
      '</span><span class="move-pct">' +
      text +
      "</span></span>"
    );
  }

  function headlineSentiment(title, summary, stored) {
    if (stored) return stored;
    if (typeof RMNewsScan !== "undefined" && RMNewsScan.headlineSentiment) {
      return RMNewsScan.headlineSentiment(title, summary || "");
    }
    return "neutral";
  }

  function renderTrendArrow(sentiment, titleAttr) {
    const tip = titleAttr ? ' title="' + escapeAttr(titleAttr) + '"' : "";
    if (sentiment === "up") {
      return (
        '<span class="trend-arrow trend-up"' +
        tip +
        ' aria-label="Bullish news tone">▲</span>'
      );
    }
    if (sentiment === "down") {
      return (
        '<span class="trend-arrow trend-down"' +
        tip +
        ' aria-label="Bearish news tone">▼</span>'
      );
    }
    return (
      '<span class="trend-arrow trend-neutral"' +
      tip +
      ' aria-label="Neutral news tone">◆</span>'
    );
  }

  function renderHeadlineItem(h) {
    const title = h.title || "";
    const sentiment = headlineSentiment(title, h.summary, h.sentiment);
    const sentLabel =
      sentiment === "up"
        ? "Bullish tone"
        : sentiment === "down"
          ? "Bearish tone"
          : "Neutral tone";
    const arrow = renderTrendArrow(sentiment);
    const safeTitle = escapeHtml(title);
    const tip = fvTipData(
      "Headline",
      tipTruncate(title, 72),
      tipTruncate(h.summary || title, 180),
      sentLabel
    );
    const url = h.url || h.source_url;
    if (url) {
      return (
        '<li class="pick-news-item trend-' +
        sentiment +
        ' fv-tip-target" tabindex="0"' +
        tip +
        ">" +
        arrow +
        '<a href="' +
        escapeAttr(url) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
        safeTitle +
        "</a></li>"
      );
    }
    return (
      '<li class="pick-news-item trend-' +
      sentiment +
      ' fv-tip-target" tabindex="0"' +
      tip +
      ">" +
      arrow +
      safeTitle +
      "</li>"
    );
  }

  function formatVol(n) {
    if (n == null) return null;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  function pickHeadlines(cat) {
    if (!cat) return [];
    if (cat.headlines && cat.headlines.length) return cat.headlines;
    if (cat.headline) {
      return [{ title: cat.headline, url: cat.source_url || null }];
    }
    return [];
  }

  function renderPickCollapsedStats(p) {
    const gap =
      p.gap_pct != null && Number(p.gap_pct) > 0
        ? "Gap " + formatPct(Number(p.gap_pct))
        : "Gap —";
    const eodVal =
      p.pct_eod != null && p.pct_eod !== ""
        ? Number(p.pct_eod)
        : p.pct_change != null
          ? Number(p.pct_change)
          : null;
    const eod = eodVal != null && !Number.isNaN(eodVal) ? "EOD " + formatPct(eodVal) : "EOD —";
    const rm = pickScore(p);
    const rmTxt =
      rm != null && !Number.isNaN(Number(rm)) ? "RM " + Math.round(Number(rm)) : "RM —";
    let base = gap + " · " + eod + " · " + rmTxt;
    const closed = latestJournalTradeForPick(p, "closed");
    if (closed && closed.filled !== false && closed.status !== "not_filled") {
      const rTxt = pickClosedRText(closed);
      if (rTxt) base += " · " + rTxt;
    }
    return base;
  }

  function tradeMatchesPickSession(t, p) {
    const sym = String(p?.symbol || "").toUpperCase();
    if (String(t?.symbol || "").toUpperCase() !== sym) return false;
    const sid = session?.session_id;
    if (sid && t.session_id && t.session_id !== sid) return false;
    return true;
  }

  function latestJournalTradeForPick(p, status) {
    if (!p?.symbol) return null;
    const want = status ? String(status) : null;
    return (
      getJournalTrades()
        .filter((t) => {
          if (!tradeMatchesPickSession(t, p)) return false;
          if (want === "closed") {
            return t.status === "closed" || t.status === "not_filled";
          }
          if (want && t.status !== want) return false;
          return true;
        })
        .sort(
          (a, b) =>
            (Date.parse(b.closed_at || b.opened_at || "") || 0) -
            (Date.parse(a.closed_at || a.opened_at || "") || 0)
        )[0] || null
    );
  }

  function pickClosedRText(trade) {
    if (!trade || (trade.status !== "closed" && trade.status !== "not_filled")) return null;
    if (trade.filled === false || trade.status === "not_filled") return null;
    if (typeof RMTradeMetrics !== "undefined") {
      const rr = RMTradeMetrics.realizedR(trade) ?? RMTradeMetrics.rMultiple?.(trade);
      if (rr != null && Number.isFinite(rr)) {
        return (rr >= 0 ? "+" : "") + Number(rr).toFixed(2) + "R";
      }
    }
    const legacy = tradeRMultiple(trade);
    if (legacy != null && Number.isFinite(legacy)) {
      return (legacy >= 0 ? "+" : "") + Number(legacy).toFixed(2) + "R";
    }
    return null;
  }

  function pickClosedSummaryHtml(trade) {
    if (!trade) return "";
    if (trade.filled === false || trade.status === "not_filled") {
      return '<p class="meta pick-closed-summary">Closed not filled</p>';
    }
    const parts = [];
    const rTxt = pickClosedRText(trade);
    parts.push(rTxt ? "Closed " + rTxt : "Closed · R N/A");
    let pnl = trade.pnl_usd;
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.pnlUsd) {
      const computed = RMTradeMetrics.pnlUsd(trade);
      if (computed != null && Number.isFinite(computed)) pnl = computed;
    }
    if (pnl != null && Number.isFinite(pnl)) {
      parts.push((pnl >= 0 ? "+" : "") + fmtUsd(pnl));
    }
    return '<p class="meta pick-closed-summary">' + escapeHtml(parts.join(" · ")) + "</p>";
  }

  function pickTradeActionHtml(p) {
    const closed = latestJournalTradeForPick(p, "closed");
    if (closed) {
      return (
        pickClosedSummaryHtml(closed) +
        '<button type="button" class="btn btn-ghost btn-sm pick-view-result-btn">View result</button>'
      );
    }
    if (latestJournalTradeForPick(p, "open")) {
      return (
        '<button type="button" class="btn btn-ghost btn-sm pick-trade-btn pick-manage-btn">Manage trade</button>'
      );
    }
    return '<button type="button" class="btn btn-ghost btn-sm pick-trade-btn">Plan trade</button>';
  }

  function focusClosedTradeResult(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return;
    const pick = (session?.picks || []).find((x) => x.symbol === sym) || { symbol: sym };
    const trade = latestJournalTradeForPick(pick, "closed");
    showScansPanel();
    setScansTab("results", { skipHero: true });
    renderResultsClosedTrades();
    if (trade?.id && typeof RMTradeDebrief !== "undefined") {
      RMTradeDebrief.highlightClosedTradeRow?.(trade.id);
      void RMTradeDebrief.focusChartForDebrief?.(trade);
    } else if (trade) {
      selectTicker(sym, { skipHero: true, snapChart: true });
    }
    $("ttResultsClosed")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const PICK_FB_KEY = "rainmaker_pick_feedback_v1";
  const THUMB_UP_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 21h2.5a1 1 0 0 0 1-1V11a1 1 0 0 0-1-1H2zM21.7 11.3a1.6 1.6 0 0 0-1.2-.5H14l.9-4.3a1.7 1.7 0 0 0-1.7-2.1c-.5 0-1 .2-1.3.6L7.5 10v10h10a1.7 1.7 0 0 0 1.7-1.4l1.3-5.6a1.6 1.6 0 0 0-.8-1.7z"/></svg>';
  const THUMB_DOWN_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M22 3h-2.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H22zM2.3 12.7a1.6 1.6 0 0 0 1.2.5H10l-.9 4.3a1.7 1.7 0 0 0 1.7 2.1c.5 0 1-.2 1.3-.6L16.5 14V4h-10A1.7 1.7 0 0 0 4.8 5.4L3.5 11a1.6 1.6 0 0 0 .8 1.7z"/></svg>';

  function loadPickFeedback() {
    try {
      return JSON.parse(localStorage.getItem(PICK_FB_KEY)) || {};
    } catch {
      return {};
    }
  }
  function pickFbId(sym) {
    const s = session?.session_id || session?.scanned_at || "session";
    return s + ":" + String(sym || "").toUpperCase();
  }
  function getPickFeedback(sym) {
    return loadPickFeedback()[pickFbId(sym)] || null;
  }
  function savePickFeedback(sym, vote, note) {
    const all = loadPickFeedback();
    const id = pickFbId(sym);
    const prev = all[id] || {};
    if (vote == null && !note && !prev.vote) {
      delete all[id];
    } else {
      all[id] = {
        symbol: String(sym || "").toUpperCase(),
        vote: vote !== undefined ? vote : prev.vote || null,
        note: note != null ? note : prev.note || "",
        at: Date.now(),
      };
    }
    try {
      localStorage.setItem(PICK_FB_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
    if (typeof RMMetrics !== "undefined" && RMMetrics.track) {
      RMMetrics.track("pick_feedback", {
        symbol: String(sym || "").toUpperCase(),
        vote: all[id]?.vote || null,
        note: all[id]?.note || "",
      });
    }
  }

  function pickFeedbackHtml(p) {
    const fb = getPickFeedback(p.symbol);
    return (
      '<div class="pick-feedback" role="group" aria-label="Rate ' +
      escapeAttr(p.symbol) +
      '">' +
      '<button type="button" class="pick-fb-btn pick-fb-up' +
      (fb?.vote === "up" ? " is-active" : "") +
      '" data-fb="up" aria-label="Good call">' +
      THUMB_UP_SVG +
      "</button>" +
      '<button type="button" class="pick-fb-btn pick-fb-down' +
      (fb?.vote === "down" ? " is-active" : "") +
      '" data-fb="down" aria-label="Not for me — hide">' +
      THUMB_DOWN_SVG +
      "</button>" +
      '<input type="text" class="pick-fb-note" placeholder="Why? (optional)" value="' +
      escapeAttr(fb?.note || "") +
      '"/>' +
      "</div>"
    );
  }

  function renderPickRow(p) {
    const cat = p.catalyst || {};
    const headlines = pickHeadlines(cat);
    const metricsParts = [];
    if (p.last != null) {
      metricsParts.push(
        '<span class="pick-price">$' + Number(p.last).toFixed(2) + "</span>"
      );
    }
    const gapHtml = formatGapBadge(p.gap_pct);
    if (gapHtml) metricsParts.push(gapHtml);
    const dayHtml = renderPriceMove(p.pct_change);
    if (dayHtml) metricsParts.push(dayHtml);
    const eodHtml = formatEodBadge(p.pct_eod, p.pct_change);
    if (eodHtml) metricsParts.push(eodHtml);
    const vol = formatVol(p.volume);
    if (vol) metricsParts.push('<span class="pick-vol">vol ' + vol + "</span>");

    const metricsHtml = metricsParts.length
      ? '<div class="pick-metrics">' + metricsParts.join("") + "</div>"
      : "";

    const topSent = cat.headline_sentiment;
    const catalystExtra = topSent
      ? " " +
        renderTrendArrow(
          topSent,
          topSent === "up"
            ? "Top headline tone: bullish"
            : topSent === "down"
              ? "Top headline tone: bearish"
              : "Top headline tone: neutral"
        )
      : "";

    let newsHtml = "";
    if (headlines.length) {
      newsHtml =
        '<ul class="pick-news-list">' +
        headlines.map(renderHeadlineItem).join("") +
        "</ul>";
    } else if (session && session.news_scanned_at) {
      newsHtml =
        '<p class="pick-sub">No stock-worthy headlines in scan window.</p>';
    }

    const rm = pickScore(p);
    const rmStat =
      rm != null && !Number.isNaN(Number(rm)) ? "RM " + Math.round(Number(rm)) : "";
    const inAccount =
      typeof RMHoldings !== "undefined" &&
      RMHoldings.getBrokerSymbols &&
      RMHoldings.getBrokerSymbols()[p.symbol]
        ? '<span class="pick-in-account" title="Open in your Schwab account">In account</span>'
        : "";

    return (
      '<details class="pick-accordion pick-row' +
      (pickListScanningSym === p.symbol ? " pick-row-scanning" : "") +
      '" data-symbol="' +
      escapeAttr(p.symbol) +
      '">' +
      '<summary class="pick-accordion-summary">' +
      '<span class="pick-acc-left">' +
      '<span class="sym fv-tip-target" tabindex="0"' +
      fvTipData(
        "Pick",
        p.symbol,
        "Expand for news and metrics, or open trade plan.",
        rmStat
      ) +
      ">" +
      escapeHtml(p.symbol) +
      "</span>" +
      inAccount +
      '<span class="pick-collapsed-stats">' +
      escapeHtml(renderPickCollapsedStats(p)) +
      "</span></span>" +
      renderRmScoreMeter(p, "row") +
      "</summary>" +
      '<div class="pick-accordion-body">' +
      '<div class="pick-row-top">' +
      '<div class="pick-row-title">' +
      metricsHtml +
      catalystExtra +
      "</div></div>" +
      newsHtml +
      '<div class="pick-row-actions">' +
      pickTradeActionHtml(p) +
      pickFeedbackHtml(p) +
      "</div>" +
      "</div></details>"
    );
  }

  function bindPickAccordions(root) {
    if (!root) return;
    root.querySelectorAll(".pick-accordion").forEach((el) => {
      el.querySelector(".pick-trade-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPick(el.dataset.symbol);
      });
      el.querySelector(".pick-manage-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPick(el.dataset.symbol);
      });
      el.querySelector(".pick-view-result-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        focusClosedTradeResult(el.dataset.symbol);
      });
      el.querySelector(".sym")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPick(el.dataset.symbol);
      });
      el.querySelectorAll(".pick-fb-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const vote = btn.dataset.fb;
          const noteEl = el.querySelector(".pick-fb-note");
          savePickFeedback(el.dataset.symbol, vote, noteEl?.value || "");
          el.querySelectorAll(".pick-fb-btn").forEach((b) =>
            b.classList.toggle("is-active", b === btn)
          );
          if (vote === "down") {
            // Hide from the UI; the vote persists (and is reported via track).
            el.classList.add("pick-row--dismissed");
            setTimeout(() => el.remove(), 260);
          }
        });
      });
      const noteEl = el.querySelector(".pick-fb-note");
      if (noteEl) {
        ["click", "keydown", "pointerdown"].forEach((evt) =>
          noteEl.addEventListener(evt, (e) => e.stopPropagation())
        );
        noteEl.addEventListener("input", () =>
          savePickFeedback(el.dataset.symbol, undefined, noteEl.value)
        );
      }
    });
  }

  function mountPickInlineCharts() {
    if (typeof RMChartHub === "undefined") return;
    const listRoot = $("pickList");
    if (!listRoot) return;

    if (pickChartObserver) {
      pickChartObserver.disconnect();
      pickChartObserver = null;
    }

    if (typeof IntersectionObserver === "undefined") {
      listRoot.querySelectorAll("[data-pick-chart]").forEach((el) => {
        const sym = el.dataset.pickChart;
        if (sym) RMChartHub.renderPickMini(sym, el);
      });
      return;
    }

    listRoot.querySelectorAll("[data-pick-chart]").forEach((el) => {
      observePickChartElement(el);
    });
  }

  function renderPicks() {
    if (!session) return;
    const label = session.session_label ? " · " + session.session_label : "";
    setPageTitle("Rainmaker Morning" + label);
    setHeaderMeta(
      (session.scanned_at || "").slice(0, 16).replace("T", " ") +
        " · " +
        (session.source_file || "") +
        " · " +
        (session.pick_count || 0) +
        " picks"
    );

    // Thumbs-down picks are hidden from the UI but stay in session/storage.
    const picks = sortPicksByGapUp(session.picks || []).filter(
      (p) => getPickFeedback(p.symbol)?.vote !== "down"
    );
    const picksHeading = $("picksHeading");
    if (picksHeading) {
      const base = session.news_filter_applied_at
        ? "Scan + news (catalyst only)"
        : WS_COL_TITLE.scans;
      picksHeading.textContent = base + " · gap ↑";
    }

    let banner = "";
    const removed = session.filtered_out || [];
    if (removed.length) {
      banner =
        '<p class="status-msg pick-removed-banner">Removed ' +
        removed.length +
        " without news today: " +
        escapeHtml(removed.map((x) => x.symbol).join(", ")) +
        "</p>";
    }

    if (!picks.length) {
      setPickListHtml(banner + '<p class="status-msg">No picks to show.</p>');
      return;
    }

    renderPickListContent(picks, banner);

    const listRoot = $("pickList");
    if (!listRoot) return;
    renderScanMetricsStrip();
    updateResultsActiveSection();
    renderCalendarUi(undefined, "results");
    if (!newsScanRunning) {
      const skipHubRefresh =
        RMChartHub?.state?.morningScanViewLock &&
        RMChartHub?.state?.overlays?.size > 0 &&
        session?.news_filter_applied_at;
      if (!skipHubRefresh) refreshChartHub();
    }
    document.dispatchEvent(new CustomEvent("rm:results-content-updated"));
  }

  function setInstrumentTab(kind) {
    instrument = kind === "option" ? "option" : "stock";
    const stock = $("tabStock");
    const opt = $("tabOption");
    if (!stock || !opt) return;
    const isStock = instrument === "stock";
    stock.classList.toggle("active", isStock);
    stock.setAttribute("aria-selected", isStock ? "true" : "false");
    opt.classList.toggle("active", !isStock);
    opt.setAttribute("aria-selected", !isStock ? "true" : "false");
    renderPlanFields();
  }

  function openOrderDrawer() {
    const backdrop = $("orderBackdrop");
    const drawer = $("orderDrawer");
    if (!backdrop || !drawer) return;
    drawer.inert = false;
    backdrop.classList.remove("hidden");
    backdrop.setAttribute("aria-hidden", "false");
    drawer.classList.remove("is-closed");
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("drawer-open");
  }

  function blurDrawerFocus(drawer) {
    const ae = document.activeElement;
    if (ae && drawer?.contains(ae)) ae.blur();
    if (drawer) drawer.inert = true;
  }

  function closeOrderDrawer() {
    const backdrop = $("orderBackdrop");
    const drawer = $("orderDrawer");
    if (!backdrop || !drawer) return;
    blurDrawerFocus(drawer);
    backdrop.classList.add("hidden");
    backdrop.setAttribute("aria-hidden", "true");
    drawer.classList.remove("open");
    drawer.classList.add("is-closed");
    drawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("drawer-open");
    document.querySelectorAll(".pick-row-selected").forEach((el) => {
      el.classList.remove("pick-row-selected");
    });
    activePick = null;
    if (!$("scanDrawer")?.classList.contains("open")) {
      document.body.classList.remove("drawer-open");
    }
  }

  function populateOrderDrawer(p) {
    const symbol = p.symbol;
    const meter = $("drawerRmMeter");
    if (meter) {
      meter.innerHTML = renderRmScoreMeter(p, "drawer");
      bindRmScoreTooltips(meter);
    }
    const cat = p.catalyst || {};
    const newsEl = $("drawerNews");
    if (newsEl) {
      if (cat.headline && cat.source_url) {
        newsEl.innerHTML =
          '<a href="' +
          escapeAttr(cat.source_url) +
          '" target="_blank" rel="noopener">' +
          escapeHtml(cat.headline) +
          "</a>";
      } else if (cat.headline) {
        newsEl.textContent = cat.headline;
      } else if (cat.status === "news_error") {
        newsEl.textContent = "News fetch failed — pick kept for manual review.";
      } else {
        newsEl.textContent = "No catalyst headlines loaded yet.";
      }
    }
    setInstrumentTab("stock");
    $("closePanel").classList.add("hidden");
  }

  function openPick(symbol) {
    selectTicker(symbol);
  }

  function renderPlanFields() {
    const isOpt = instrument === "option";
    const stock = $("stockFields");
    const opt = $("optionFields");
    if (stock) stock.classList.toggle("hidden", isOpt);
    if (opt) opt.classList.toggle("hidden", !isOpt);
  }

  function initNewsProgress(symbols, opts) {
    const wrap = $("newsProgress");
    const seg = $("scanProgressSegments");
    const fill = $("scanProgressFill");
    const track = wrap && wrap.querySelector(".scan-progress-track");
    if (!wrap || !seg || !fill) return;

    seg.innerHTML = symbols
      .map(
        (s) =>
          '<div class="scan-segment pending" data-symbol="' +
          escapeAttr(s) +
          '" title="' +
          escapeAttr(s) +
          '"><span>' +
          escapeHtml(s) +
          "</span></div>"
      )
      .join("");

    if (!opts?.keepProgress) {
      applyScanProgressPct(0);
    }
    if (track) {
      track.setAttribute("aria-valuemax", "100");
    }
    setScanProgressLabel("Starting news scan…");
    wrap.classList.remove("hidden");
    mirrorScanProgressToPanel();
    const nr = $("newsResults");
    if (nr) nr.innerHTML = "";
  }

  function updateNewsProgress(sym, n, total, result) {
    if (result) {
      setScanProgress(n, total, 1);
    }

    if (result) {
      const el = document.querySelector(
        '.scan-segment[data-symbol="' + sym + '"]'
      );
      if (el) {
        el.classList.remove("pending", "active");
        if (result.error) el.classList.add("done-error");
        else if (result.hasCatalyst) el.classList.add("done-ok");
        else el.classList.add("done-none");
      }
      setScanProgressLabel(
        "Scanned " + sym + " (" + n + " of " + total + ")"
      );
    } else {
      document.querySelectorAll(".scan-segment").forEach((el) => {
        el.classList.remove("active");
        if (el.dataset.symbol === sym) el.classList.add("active");
      });
      setScanProgressLabel(
        "Scanning " + sym + "… (" + n + " of " + total + ")"
      );
    }
    mirrorScanProgressToPanel();
  }

  function hideNewsProgress() {
    const wrap = $("newsProgress");
    if (wrap) wrap.classList.add("hidden");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findPickRow(symbol) {
    return document.querySelector(
      '.pick-row[data-symbol="' + symbol + '"]'
    );
  }

  function findScanSegment(symbol) {
    return document.querySelector(
      '.scan-segment[data-symbol="' + symbol + '"]'
    );
  }

  function animateRemoveSymbol(symbol) {
    return new Promise((resolve) => {
      const row = findPickRow(symbol);
      const seg = findScanSegment(symbol);
      if (!row && !seg) {
        resolve();
        return;
      }
      if (row) row.classList.add("pick-row-exit");
      if (seg) seg.classList.add("segment-exit");
      setTimeout(() => {
        if (row) row.remove();
        if (seg) seg.remove();
        resolve();
      }, 520);
    });
  }

  function removePickFromSession(result) {
    const pick = (session.picks || []).find((p) => p.symbol === result.symbol);
    if (!pick) return;
    session.filtered_out = session.filtered_out || [];
    session.filtered_out.push({
      symbol: result.symbol,
      rm_confidence: pick.rm_confidence,
      reason:
        result.reason ||
        (result.error ? "news_fetch_error" : "no_stock_worthy_news_today"),
    });
    session.picks = session.picks.filter((p) => p.symbol !== result.symbol);
    session.pick_count = session.picks.length;
    if (activePick && activePick.symbol === result.symbol) {
      closeOrderDrawer();
      activePick = null;
    }
  }

  function updateRemovedBannerLive() {
    const banner = document.getElementById("pickRemovedBanner");
    const removed = session.filtered_out || [];
    if (!removed.length) {
      if (banner) banner.remove();
      return;
    }
    const html =
      "Removed " +
      removed.length +
      " (no catalyst): " +
      removed.map((x) => x.symbol).join(", ");
    if (banner) {
      banner.textContent = html;
    } else {
      const el = document.createElement("p");
      el.id = "pickRemovedBanner";
      el.className = "status-msg pick-removed-banner";
      el.textContent = html;
      const list = $("pickList");
      if (list) list.insertBefore(el, list.firstChild);
    }
  }

  function refreshPickRow(symbol) {
    const pick = (session.picks || []).find((p) => p.symbol === symbol);
    if (!pick) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = renderPickRow(pick);
    const newRow = wrap.firstElementChild;
    if (!newRow) return;
    if (
      typeof RMVirtualPickList !== "undefined" &&
      RMVirtualPickList.isActive() &&
      RMVirtualPickList.updateRow(symbol, newRow.outerHTML)
    ) {
      const win = $("pickList")?.querySelector(".pick-list-virtual-window");
      if (win) bindPickListSubtree(win);
      return;
    }
    const row = findPickRow(symbol);
    if (!row) return;
    row.replaceWith(newRow);
    bindPickListSubtree(newRow.parentElement);
  }

  function observePickChartElement(el) {
    if (!el || typeof RMChartHub === "undefined") return;
    if (typeof IntersectionObserver === "undefined") {
      const sym = el.dataset.pickChart;
      if (sym) RMChartHub.renderPickMini(sym, el);
      return;
    }
    if (!pickChartObserver) {
      pickChartObserver = new IntersectionObserver(
        (entries) => {
          for (const ent of entries) {
            if (!ent.isIntersecting) continue;
            const node = ent.target;
            if (node.dataset.chartLoaded === "1") continue;
            node.dataset.chartLoaded = "1";
            const sym = node.dataset.pickChart;
            if (sym) RMChartHub.renderPickMini(sym, node);
            pickChartObserver.unobserve(node);
          }
        },
        { root: null, rootMargin: "100px 0px", threshold: 0.05 }
      );
    }
    delete el.dataset.chartLoaded;
    pickChartObserver.observe(el);
  }

  function updateSessionMeta() {
    if (!session) return;
    setHeaderMeta(
      (session.scanned_at || "").slice(0, 16).replace("T", " ") +
        " · " +
        (session.source_file || "") +
        " · " +
        (session.pick_count || 0) +
        " picks"
    );
  }

  async function handleScanDone(result, n, total) {
    updateNewsProgress(result.symbol, n, total, result);

    const pick = (session.picks || []).find((p) => p.symbol === result.symbol);
    if (!pick) return;

    if (result.error) {
      RMNewsScan.applyResultToPick(pick, result);
      if (typeof RMChartHub !== "undefined") {
        await RMChartHub.dismissCandidate(result.symbol);
      }
      refreshPickRow(result.symbol);
      showToast(
        result.symbol + " — news unavailable (pick kept for review)",
        "warn"
      );
      persistScanSession();
      return;
    }

    if (result.hasCatalyst) {
      RMNewsScan.applyResultToPick(pick, result);
      if (typeof RMChartHub !== "undefined") {
        await RMChartHub.resolveCandidate(result.symbol, true, {
          catalyst: pick.catalyst,
          pick,
        });
      }
      refreshPickRow(result.symbol);
      showToast(result.symbol + " confirmed — catalyst news", "success");
      persistScanSession();
      return;
    }

    const reason = "no_stock_worthy_news_today";
    if (typeof RMChartHub !== "undefined") {
      await RMChartHub.resolveCandidate(result.symbol, false);
    }
    showToast(
      result.symbol + " removed — " + removalReasonLabel(reason),
      "warn"
    );
    await delay(280);
    await animateRemoveSymbol(result.symbol);
    removePickFromSession({ ...result, reason });
    updateRemovedBannerLive();
    updateSessionMeta();
    renderPicks();
  }

  async function searchNews(opts) {
    if (!session || !session.picks || !session.picks.length) return;
    if (newsScanRunning) return;

    const { targets, skipped } = picksForNewsScan(session.picks);
    if (skipped.length) {
      for (const pick of skipped) {
        removePickFromSession({ symbol: pick.symbol, reason: "below_news_rank_cutoff" });
      }
      updateSessionMeta();
      renderPicks();
      showToast(
        skipped.length +
          " lower-ranked pick" +
          (skipped.length === 1 ? "" : "s") +
          " skipped (top " +
          NEWS_TOP_N +
          " only)",
        "info"
      );
    }
    if (!session.picks.length) {
      newsScanRunning = false;
      refreshScanButton();
      status("No picks left after news rank cutoff");
      return;
    }

    const symbols = targets.map((p) => p.symbol);
    const useEta = !!opts?.estimatedProgress && customScanEta.active;
    session.filtered_out = [];
    session.news_filter_applied_at = null;

    if (typeof RMChartHub !== "undefined") {
      await RMChartHub.prepareScanIntroPan();
    }

    newsScanRunning = true;
    refreshScanButton();
    if (typeof RMWorkspaceLoad !== "undefined") {
      if (isMobileSnapScans()) {
        updateScansPanelLoaderStep("Checking news…", Math.max(50, scanProgressPct || 50));
      } else {
        RMWorkspaceLoad.hidePanelLoader("scans");
      }
    }
    const picksHeading = $("picksHeading");
    if (picksHeading) picksHeading.textContent = WS_COL_TITLE.scans + " · checking news…";
    showNewsProgressBar();
    if (useEta) {
      initNewsProgress(symbols, { keepProgress: true });
      extendCustomScanEta({
        addMs: 12000 + symbols.length * 4200,
        toPct: 96,
        label: "Checking news for " + symbols.length + " picks…",
      });
    } else {
      initNewsProgress(symbols);
    }
    if (typeof RMChartHub !== "undefined") {
      await RMChartHub.beginScanSequence(symbols, { skipIntroPan: true });
    }
    renderPicks();
    if (typeof RMWorkspaceAccordion !== "undefined") {
      RMWorkspaceAccordion.expand("scans");
    }

    let results = [];
    try {
      results = await runNewsScan(symbols, {
        async onStart(sym, n, total) {
          if (!useEta) setScanProgress(n, total, 0.08);
          if (typeof RMChartHub !== "undefined") {
            await RMChartHub.previewCandidate(sym);
          }
          document.querySelectorAll(".scan-segment").forEach((el) => {
            el.classList.remove("active");
            if (el.dataset.symbol === sym) el.classList.add("active");
          });
          pickListScanningSym = sym;
          if (
            typeof RMVirtualPickList !== "undefined" &&
            RMVirtualPickList.isActive()
          ) {
            RMVirtualPickList.refresh(session.picks, pickListBannerHtml());
          } else {
            document.querySelectorAll(".pick-row").forEach((el) => {
              el.classList.toggle("pick-row-scanning", el.dataset.symbol === sym);
            });
          }
          if (typeof RMMarket !== "undefined") {
            RMMarket.setMapScanHighlight?.(sym);
            const mpScan = $("marketPanel");
            if (mpScan && RMMarket.scheduleRefreshMarketPanel) {
              RMMarket.scheduleRefreshMarketPanel(mpScan, session.picks, {
                soft: true,
                mapPatchOnly: true,
                highlightSym: sym,
              });
            }
          }
          setScanProgressLabel(
            "Scanning " + sym + "… (" + n + " of " + total + ")"
          );
          mirrorScanProgressToPanel();
        },
        onProgress(sym, n, total, sub) {
          if (!useEta) setScanProgress(n, total, sub);
        },
        onDone(result, n, total) {
          return handleScanDone(result, n, total);
        },
      });
    } finally {
      newsScanRunning = false;
      refreshScanButton();
      pickListScanningSym = null;
      document.querySelectorAll(".pick-row-scanning").forEach((el) => {
        el.classList.remove("pick-row-scanning");
      });
      if (
        typeof RMVirtualPickList !== "undefined" &&
        RMVirtualPickList.isActive()
      ) {
        RMVirtualPickList.refresh(session.picks, pickListBannerHtml());
      }
      if (typeof RMMarket !== "undefined") {
        RMMarket.setMapScanHighlight?.(null);
        const mpDone = $("marketPanel");
        if (mpDone && RMMarket.scheduleRefreshMarketPanel) {
          RMMarket.scheduleRefreshMarketPanel(mpDone, session.picks, {
            soft: true,
            mapPatchOnly: true,
          });
        }
      }
      if (typeof RMChartHub !== "undefined") {
        await RMChartHub.finishScanSequence();
      }
    }

    if (!useEta) {
      applyScanProgressPct(100);
      setScanProgressLabel("News scan complete");
      mirrorScanProgressToPanel();
    }

    session.news_scanned_at = new Date().toISOString();
    session.news_filter_applied_at = new Date().toISOString();
    RMNewsScan.applyToSession(session, results);
    const nr = $("newsResults");
    if (nr) nr.innerHTML = "";
    renderPicks();
    session.entry_type = session.entry_type || "news";
    persistScanSession({ entryType: "news", sourceKind: session.source_kind || "scan" });
    if (typeof RMMarket !== "undefined") {
      const mp = $("marketPanel");
      if (mp) {
        const refreshFn =
          RMMarket.scheduleRefreshMarketPanel || RMMarket.refreshMarketPanel;
        refreshFn(mp, session.picks, { soft: true });
      }
      syncLiveRefresh();
    }
    refreshMarketThemes();

    const removed = (session.filtered_out || []).length;
    if (picksHeading) {
      picksHeading.textContent =
        session.picks.length && removed
          ? "Scan + news (catalyst only)"
          : session.picks.length
            ? WS_COL_TITLE.scans
            : WS_COL_TITLE.scans;
    }
    if (session.picks.length === 0) {
      status(
        removed
          ? "No picks left — none had stock-worthy news today."
          : "No picks in scan."
      );
    } else {
      status(
        session.picks.length +
          " picks with catalyst news" +
          (removed ? " (removed " + removed + ")" : "")
      );
    }
    if (typeof RMHoldings !== "undefined") {
      RMHoldings.syncPricesFromPicks(session.picks);
      renderHoldings();
    }
    if (!useEta) {
      setTimeout(hideNewsProgress, 1200);
    }
  }

  function readPlan() {
    const base = {
      symbol: activePick.symbol,
      session_id: session.session_id,
      instrument,
      rm_confidence: activePick.rm_confidence,
      rm_confidence_adjusted: pickScore(activePick),
      opened_at: new Date().toISOString(),
      status: "open",
      source: "dashboard",
      planned: true,
      reconciled: false,
    };
    if (instrument === "stock") {
      return {
        ...base,
        entry_price: num("entryStock"),
        quantity: num("qtyStock"),
        stop_price: num("stopStock"),
        target_price: num("targetStock"),
      };
    }
    return {
      ...base,
      entry_premium: num("entryOpt"),
      contracts: num("contractsOpt"),
      stop_premium: num("stopOpt"),
      target_premium: num("targetOpt"),
    };
  }

  function num(id) {
    const v = parseFloat($(id).value);
    return isNaN(v) ? null : v;
  }

  function saveOpenTrade() {
    if (!activePick) return;
    saveOpenTradeFromPlan(readPlan());
    closeOrderDrawer();
  }

  function closeTrade() {
    if (!activePick) return;
    closeTradeFromPlan({
      symbol: activePick.symbol,
      fill_status: $("fillStatus").value,
      exit_price: num("exitPrice"),
      source: "drawer",
    });
    closeOrderDrawer();
  }

  function renderYtdHtml() {
    const year = String(new Date().getFullYear());
    const ytd = getTrades().filter((t) => {
      const d = t.closed_at || t.opened_at || "";
      return d.startsWith(year);
    });
    if (!ytd.length) {
      return '<p class="status-msg">No trades logged yet this year.</p>';
    }
    return ytd
      .slice()
      .reverse()
      .map((t) => {
        let line =
          "<strong>" +
          escapeHtml(t.symbol) +
          "</strong> " +
          escapeHtml(t.instrument || "stock") +
          " · " +
          escapeHtml(t.status || "open");
        if (t.entry_price != null) line += " · entry " + t.entry_price;
        if (t.entry_premium != null) line += " · prem " + t.entry_premium;
        if (t.exit_price != null) line += " · exit " + t.exit_price;
        if (t.r_multiple != null) {
          line +=
            " · " +
            (t.r_multiple >= 0 ? "+" : "") +
            Number(t.r_multiple).toFixed(2) +
            "R";
        }
        if (typeof RMTradeMetrics !== "undefined") {
          const dual = RMTradeMetrics.fmtDualTrack(t);
          if (dual) line += " · " + escapeHtml(dual);
        }
        if (t.pnl_usd != null) line += " · " + fmtUsd(t.pnl_usd);
        if (RMTradeMetrics?.reconcileStatus?.(t) === "delta") {
          line += " · <em>reconcile Δ</em>";
        } else if (!t.reconciled) line += " · <em>pending reconcile</em>";
        return '<div class="trade-item">' + line + "</div>";
      })
      .join("");
  }

  function renderYtd() {
    const el = $("ytdList");
    if (el) el.innerHTML = renderYtdHtml();
  }

  function renderDrawerYtd() {
    const el = $("drawerYtdList");
    if (el) el.innerHTML = renderYtdHtml();
    renderLearningStats();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
  }

  let scanConfigDraft = null;
  let agentPlanDraftRef = null;

  function getRainmakerApiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) {
        return meta.content.trim().replace(/\/$/, "");
      }
      const stored = localStorage.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (_) {
      /* ignore */
    }
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return "http://127.0.0.1:8765";
    }
    return "";
  }

  function picksForNewsScan(picks) {
    const sorted = [...(picks || [])].sort(
      (a, b) => (b.rm_confidence || 0) - (a.rm_confidence || 0)
    );
    return {
      targets: sorted.slice(0, NEWS_TOP_N),
      skipped: sorted.slice(NEWS_TOP_N),
    };
  }

  async function runNewsScan(symbols, handlers) {
    const apiBase = getRainmakerApiBase();
    if (apiBase && symbols.length) {
      try {
        if (handlers?.onPhase) handlers.onPhase("Rainmaker API · news scan…");
        const res = await fetch(apiBase + "/scan/news", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof RMAuthGate !== "undefined"
              ? RMAuthGate.authHeaders()
              : {}),
          },
          body: JSON.stringify({ symbols, maxAgeHours: 24 }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(
            "API " + res.status + (errText ? ": " + errText.slice(0, 100) : "")
          );
        }
        const data = await res.json();
        const results = data.results || [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const n = i + 1;
          const total = results.length;
          if (handlers?.onStart) {
            await handlers.onStart(result.symbol, n, total);
          }
          if (handlers?.onProgress) handlers.onProgress(result.symbol, n, total, 1);
          if (handlers?.onDone) {
            const ret = handlers.onDone(result, n, total);
            if (ret && typeof ret.then === "function") await ret;
          }
        }
        return results;
      } catch (e) {
        console.warn("Rainmaker API news scan failed, falling back to browser", e);
        if (handlers?.onPhase) handlers.onPhase("API unavailable — browser news scan…");
      }
    }
    if (typeof RMNewsScan === "undefined") {
      throw new Error("News scan module failed to load — refresh the page");
    }
    return RMNewsScan.scanAll(symbols, handlers);
  }

  function cfgToApiPayload(cfg) {
    const w = cfg.weights || (RMScanConfig && RMScanConfig.DEFAULTS.weights) || {};
    return {
      hypothesis_id: cfg.hypothesis_id || "H-001",
      applyFloatPoints: !!cfg.applyFloatPoints,
      volMultiple: cfg.volMultiple ?? 5,
      dailyPctMin: cfg.dailyPctMin ?? 10,
      movePctMin: cfg.movePctMin ?? 8,
      priceMin: cfg.priceMin ?? 1,
      priceMax: cfg.priceMax ?? 20,
      gapPctMin: cfg.gapPctMin ?? 3,
      minScore: cfg.minScore ?? 50,
      weights: w,
    };
  }

  async function runH001Scan(cfg, handlers) {
    const apiBase = getRainmakerApiBase();
    if (apiBase) {
      try {
        if (handlers?.onPhase) handlers.onPhase("Rainmaker API · H-001 scan…");
        const res = await fetch(apiBase + "/scan/h001", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof RMAuthGate !== "undefined"
              ? RMAuthGate.authHeaders()
              : {}),
          },
          body: JSON.stringify(cfgToApiPayload(cfg)),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(
            "API " + res.status + (errText ? ": " + errText.slice(0, 100) : "")
          );
        }
        const data = await res.json();
        return {
          session: data.session,
          screened: data.screened,
          scored: data.scored,
          skipped: data.skipped,
          minScore: data.min_score ?? data.minScore ?? cfg.minScore ?? 50,
          viaApi: true,
          durationMs: data.duration_ms ?? data.durationMs,
        };
      } catch (e) {
        console.warn("Rainmaker API scan failed, falling back to browser", e);
        if (handlers?.onPhase) {
          handlers.onPhase("API unavailable — browser scan…");
        }
      }
    }
    if (typeof RMMarketScan === "undefined") {
      throw new Error("Market scan module failed to load — refresh the page");
    }
    return RMMarketScan.runMarketScan(cfg, handlers);
  }

  async function runRainmakerMarketScan() {
    if (typeof RMMarketScan === "undefined" && !getRainmakerApiBase()) {
      status("Market scan module failed to load — refresh the page");
      return;
    }
    if (marketScanRunning || newsScanRunning) return;

    const cfg = scanConfigDraft || RMScanConfig.load();
    RMScanConfig.save(cfg);

    const useApi = !!getRainmakerApiBase();
    marketScanRunning = true;
    refreshScanButton();
    closeScanDrawer();
    if (typeof RMWorkspaceLoad !== "undefined") {
      RMWorkspaceLoad.showPanelLoader("scans", {
        step: useApi ? "Server H-001 scan…" : "Scanning market (gainers + actives)…",
        kicker: "Rainmaker scan",
        pct: 12,
        scanProgress: true,
      });
      mirrorScanProgressToPanel();
    } else {
      setPickListHtml(
        '<p class="status-msg">Running Rainmaker H-001' +
          (useApi ? " (server)" : "") +
          "…</p>"
      );
    }
    status(useApi ? "Server H-001 scan…" : "Scanning market (gainers + actives)…");
    showNewsProgressBar();
    setScanProgressLabel("Starting Rainmaker scan…");
    const seg = $("scanProgressSegments");
    if (seg) seg.innerHTML = "";
    startCustomScanEta({
      durationMs: useApi ? 45000 : 90000,
      toPct: 88,
      label: useApi
        ? "Server scan in progress…"
        : "Starting Rainmaker scan… (~1–2 min)",
    });

    try {
      const minScoreThreshold = cfg.minScore ?? RMMarketScan.DEFAULT_MIN_SCORE ?? 50;
      let symbolTotal = 0;
      const scanResult = await runH001Scan(cfg, {
        onPhase(msg) {
          setScanProgressLabel(msg);
          updateScansPanelLoaderStep(msg, scanProgressPct || undefined);
        },
        onProgress(sym, n, total, sub) {
          if (total && total !== symbolTotal) {
            symbolTotal = total;
            extendCustomScanEta({
              addMs: 8000 + total * 900,
              toPct: 78,
              label: "Scoring " + total + " candidates (batched)…",
            });
          }
          setScanProgressLabel(
            "Scoring " +
              sym +
              "… (" +
              n +
              " of " +
              total +
              ", RM≥" +
              minScoreThreshold +
              ")"
          );
          updateScansPanelLoaderStep(
            "Scoring " + sym + "… (" + n + "/" + total + ")",
            scanProgressPct || undefined
          );
        },
      });

      const scanned = scanResult.session;
      const screened = scanResult.screened;
      const minScore = scanResult.minScore;

      session = scanned;
      session.source_kind = "market_scan";
      session.entry_type = "scan";

      if (!session.picks.length) {
        finishCustomScanEta("Scan complete — no picks matched");
        setPickListHtml(
          '<p class="status-msg">No symbols met H-001 criteria (screened ' +
            screened +
            ", min RM " +
            minScore +
            "). Try lowering min score or thresholds.</p>"
        );
        status("Scan finished — 0 picks");
        return;
      }

      extendCustomScanEta({
        addMs: 10000,
        toPct: 82,
        label: session.pick_count + " picks found · checking news…",
      });

      await onSessionLoaded({
        fromCustomScan: true,
        entryType: "scan",
        sourceKind: "market_scan",
      });
      finishCustomScanEta("Rainmaker scan complete");
      const apiNote = scanResult.viaApi
        ? " · API " + Math.round((scanResult.durationMs || 0) / 1000) + "s"
        : "";
      const skipNote =
        scanResult.skipped != null ? " · " + scanResult.skipped + " pre-filtered" : "";
      status(
        "Rainmaker scan: " +
          session.pick_count +
          " picks from " +
          screened +
          " symbols (RM≥" +
          minScore +
          ")" +
          apiNote +
          skipNote
      );
    } catch (e) {
      stopCustomScanEta();
      applyScanProgressPct(0);
      status(e.message || "Market scan failed");
      setPickListHtml(
        '<p class="status-msg pick-error">' +
          escapeHtml(e.message || "Market scan failed") +
          "</p>"
      );
    } finally {
      marketScanRunning = false;
      refreshScanButton();
      if (typeof RMWorkspaceLoad !== "undefined") {
        RMWorkspaceLoad.hidePanelLoader("scans");
      }
      setTimeout(hideNewsProgress, 1200);
    }
  }

  function setScanDrawerTab(tab) {
    const isScan = tab !== "agent";
    const tabScan = $("scanDrawerTabScan");
    const tabAgent = $("scanDrawerTabAgent");
    const paneScan = $("scanDrawerPaneScan");
    const paneAgent = $("scanDrawerPaneAgent");
    const saveScan = $("btnSaveScanRanks");
    const saveAgent = $("btnSaveAgentPlan");
    tabScan?.classList.toggle("active", isScan);
    tabAgent?.classList.toggle("active", !isScan);
    tabScan?.setAttribute("aria-selected", isScan ? "true" : "false");
    tabAgent?.setAttribute("aria-selected", !isScan ? "true" : "false");
    if (paneScan) {
      paneScan.classList.toggle("hidden", !isScan);
      paneScan.hidden = !isScan;
    }
    if (paneAgent) {
      paneAgent.classList.toggle("hidden", isScan);
      paneAgent.hidden = isScan;
    }
    if (saveScan) {
      saveScan.classList.toggle("hidden", !isScan);
      saveScan.hidden = !isScan;
    }
    if (saveAgent) {
      saveAgent.classList.toggle("hidden", isScan);
      saveAgent.hidden = isScan;
    }
    if (isScan) {
      renderCalendarUi($("drawerCalSearch")?.value || "", "drawer");
    }
  }

  function openScanSettingsDrawer() {
    if (typeof RMScanConfig === "undefined") return;
    scanConfigDraft = RMScanConfig.load();
    renderScanRankPanel($("scanRankPanel"));
    loadAgentPlanPanel();
    setScanDrawerTab("scan");
    renderCalendarUi($("drawerCalSearch")?.value || "", "drawer");
    const backdrop = $("scanBackdrop");
    const drawer = $("scanDrawer");
    if (backdrop) {
      backdrop.classList.remove("hidden");
      backdrop.setAttribute("aria-hidden", "false");
    }
    if (drawer) {
      drawer.inert = false;
      drawer.classList.remove("is-closed");
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("drawer-open");
    $("btnScanSettings")?.classList.add("is-active");
    $("btnScanSettings")?.setAttribute("aria-pressed", "true");
  }

  function closeScanDrawer() {
    const backdrop = $("scanBackdrop");
    const drawer = $("scanDrawer");
    if (drawer) blurDrawerFocus(drawer);
    if (backdrop) {
      backdrop.classList.add("hidden");
      backdrop.setAttribute("aria-hidden", "true");
    }
    if (drawer) {
      drawer.classList.remove("open");
      drawer.classList.add("is-closed");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (!$("orderDrawer")?.classList.contains("open")) {
      document.body.classList.remove("drawer-open");
    }
    $("btnScanSettings")?.classList.remove("is-active");
    $("btnScanSettings")?.setAttribute("aria-pressed", "false");
  }

  function saveScanRanks() {
    if (typeof RMScanConfig === "undefined") return;
    const cfg = scanConfigDraft || RMScanConfig.load();
    RMScanConfig.save(cfg);
    syncRmWeightPts(cfg.weights);
    status("Score weights saved");
    closeScanDrawer();
  }

  async function loadAgentPlanPanel() {
    const panel = $("agentPlanPanel");
    if (!panel || typeof RMAgentPlan === "undefined") return;
    panel.innerHTML = '<p class="agent-plan-hint">Loading agent plan…</p>';
    RMAgentPlan.setPanelStatus?.(panel, "Loading…", "warn");
    const res = await RMAgentPlan.fetchPlan();
    agentPlanDraftRef = RMAgentPlan.renderPanel(panel, res.plan);
    const sourceMsg =
      res.source === "api"
        ? "Loaded from server"
        : res.source === "local"
          ? "Using local draft (sign in to sync)"
          : "Using defaults (sign in to sync)";
    RMAgentPlan.setPanelStatus?.(panel, sourceMsg, res.source === "api" ? "ok" : "warn");
  }

  async function saveAgentPlan() {
    if (typeof RMAgentPlan === "undefined") return;
    const panel = $("agentPlanPanel");
    if (!panel) return;
    const draft = RMAgentPlan.readPanel(panel, agentPlanDraftRef?.current || RMAgentPlan.defaults());
    const note = panel.querySelector("#agentPlanNote")?.value?.trim() || "";
    RMAgentPlan.setPanelStatus?.(panel, "Saving…", "warn");
    status("Saving agent plan…");
    const res = await RMAgentPlan.savePlan(draft, note);
    if (!res.ok) {
      const detail =
        res.status === 401
          ? "Sign in required"
          : res.data?.detail
            ? String(res.data.detail)
            : "HTTP " + (res.status || "?");
      RMAgentPlan.setPanelStatus?.(panel, "Save failed — " + detail, "err");
      status("Agent plan save failed (" + (res.status || "?") + ")");
      return;
    }
    agentPlanDraftRef = RMAgentPlan.renderPanel(panel, res.plan);
    RMAgentPlan.setPanelStatus?.(panel, "Saved to server" + (note ? " · " + note : ""), "ok");
    status("Agent plan saved" + (note ? " — " + note : ""));
  }

  let scanDrawerFooterWired = false;

  function wireScanDrawerFooter() {
    if (scanDrawerFooterWired) return;
    scanDrawerFooterWired = true;
    safeOn("scanDrawerTabScan", "click", () => setScanDrawerTab("scan"));
    safeOn("scanDrawerTabAgent", "click", () => setScanDrawerTab("agent"));
    safeOn("btnSaveScanRanks", "click", saveScanRanks);
    safeOn("btnSaveAgentPlan", "click", () => {
      saveAgentPlan().catch((e) => status(e.message || "Agent plan save failed"));
    });
    safeOn("btnDismissScanSettings", "click", closeScanDrawer);
  }

  let calendarViewMonth = new Date();
  let calendarSelectedDay = null;

  function calendarEls(surface) {
    if (surface === "results") {
      return {
        grid: $("ttResultsCalGrid"),
        list: $("ttResultsCalList"),
        nav: $("ttResultsCalMonthNav"),
        search: $("ttResultsCalSearch"),
      };
    }
    return {
      grid: $("drawerCalGrid"),
      list: $("drawerCalList"),
      nav: $("drawerCalMonthNav"),
      search: $("drawerCalSearch"),
    };
  }

  async function renderScanHistoryList(items, heading, listEl, surface) {
    const list = listEl || calendarEls(surface).list;
    if (!list) return;
    const total =
      typeof RMScanStore !== "undefined" ? RMScanStore.countEntries() : 0;
    const head =
      '<p class="meta cal-list-head">' +
      escapeHtml(heading || "All scans") +
      (total ? " · " + total + " saved" : "") +
      "</p>";
    let publishedHtml = "";
    if (
      (surface === "results" || surface === "drawer") &&
      !String(heading || "").startsWith("Search")
    ) {
      const pub = await getPublishedSessionOffer();
      if (pub?.picks?.length) publishedHtml = publishedEntryHtml(pub);
    }
    const body =
      publishedHtml +
      (items.length
        ? items.map((h) => calendarEntryHtml(h.dateKey, h.entry)).join("")
        : publishedHtml
          ? ""
          : '<p class="meta cal-list-empty">No saved scans yet. Run Rainmaker scan or Import a CSV from the footer.</p>');
    list.innerHTML = head + body;
    bindCalendarEntries(list);
    if (publishedHtml) bindPublishedEntry();
  }

  function renderCalendarUi(query, surface) {
    if (typeof RMScanStore === "undefined") return;
    surface = surface || "drawer";
    const { grid, list, nav, search } = calendarEls(surface);
    if (!grid || !list) return;

    const q = String(query ?? search?.value ?? "").trim();
    const prevId = surface === "results" ? "ttCalPrev" : "calPrev";
    const nextId = surface === "results" ? "ttCalNext" : "calNext";

    if (q) {
      if (surface === "drawer" || !calendarEls("drawer").search?.value) {
        calendarSelectedDay = null;
      }
      const hits = RMScanStore.search(q);
      grid.innerHTML = "";
      if (nav) nav.textContent = "Search";
      void renderScanHistoryList(
        hits,
        hits.length ? "Search results" : "No matches",
        list,
        surface
      );
      return;
    }

    const y = calendarViewMonth.getFullYear();
    const m = calendarViewMonth.getMonth();
    if (nav) {
      nav.innerHTML =
        '<button type="button" class="btn btn-ghost btn-sm" id="' +
        prevId +
        '">‹</button>' +
        "<span>" +
        calendarViewMonth.toLocaleString(undefined, {
          month: "long",
          year: "numeric",
        }) +
        "</span>" +
        '<button type="button" class="btn btn-ghost btn-sm" id="' +
        nextId +
        '">›</button>';
      $(prevId)?.addEventListener("click", () => {
        calendarViewMonth = new Date(y, m - 1, 1);
        calendarSelectedDay = null;
        renderCalendarUi(undefined, "drawer");
        renderCalendarUi(undefined, "results");
      });
      $(nextId)?.addEventListener("click", () => {
        calendarViewMonth = new Date(y, m + 1, 1);
        calendarSelectedDay = null;
        renderCalendarUi(undefined, "drawer");
        renderCalendarUi(undefined, "results");
      });
    }

    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const firstDow = new Date(y, m, 1).getDay();
    let cells = "";
    for (let i = 0; i < firstDow; i++) cells += '<span class="cal-pad"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const key =
        y +
        "-" +
        String(m + 1).padStart(2, "0") +
        "-" +
        String(d).padStart(2, "0");
      const count = (RMScanStore.getDay(key) || []).length;
      const has = count > 0 ? " cal-has-scan" : "";
      const selected = calendarSelectedDay === key ? " cal-day--selected" : "";
      cells +=
        '<button type="button" class="cal-day' +
        has +
        selected +
        '" data-date="' +
        key +
        '">' +
        d +
        (count ? '<em>' + count + "</em>" : "") +
        "</button>";
    }
    grid.innerHTML = cells;
    grid.querySelectorAll(".cal-day.cal-has-scan").forEach((btn) => {
      btn.addEventListener("click", () => showCalendarDay(btn.dataset.date, surface));
    });
    if (calendarSelectedDay) {
      const dayEntries = RMScanStore.getDay(calendarSelectedDay).map((entry) => ({
        dateKey: calendarSelectedDay,
        entry,
      }));
      void renderScanHistoryList(
        dayEntries,
        calendarSelectedDay + " · " + dayEntries.length + " scan(s)",
        list,
        surface
      );
    } else {
      void renderScanHistoryList(RMScanStore.listAllEntries(), "All scans", list, surface);
    }
  }

  function calendarEntryHtml(dateKey, entry) {
    const selected =
      historySelection &&
      historySelection.dateKey === dateKey &&
      historySelection.entryId === entry.id;
    const kind =
      entry.entry_type ||
      entry.summary?.source_kind ||
      entry.summary?.entry_type ||
      "scan";
    const kindLabel =
      kind === "import"
        ? "Import"
        : kind === "news"
          ? "News"
          : kind === "market_scan"
            ? "H-001"
            : "Scan";
    return (
      '<button type="button" class="calendar-entry' +
      (selected ? " is-selected" : "") +
      '" data-date="' +
      escapeAttr(dateKey) +
      '" data-id="' +
      escapeAttr(entry.id) +
      '">' +
      '<span class="cal-entry-kind">' +
      escapeHtml(kindLabel) +
      "</span> " +
      escapeHtml((entry.summary?.scanned_at || "").slice(0, 16)) +
      " · " +
      (entry.summary?.pick_count || 0) +
      " picks" +
      formatAccuracyBadge(entry.summary?.session_id, entry.summary?.accuracy) +
      (entry.summary?.session_label
        ? " · " + escapeHtml(entry.summary.session_label)
        : "") +
      " · " +
      escapeHtml(entry.summary?.source_file || "") +
      "</button>"
    );
  }

  function showCalendarDay(dateKey, surface) {
    if (typeof RMScanStore === "undefined") return;
    calendarSelectedDay = dateKey;
    const entries = RMScanStore.getDay(dateKey);
    const list = calendarEls(surface).list;
    void renderScanHistoryList(
      entries.map((entry) => ({ dateKey, entry })),
      dateKey + " · " + entries.length + " scan(s)",
      list,
      surface
    );
    renderCalendarUi(undefined, "drawer");
    renderCalendarUi(undefined, "results");
  }

  function bindCalendarEntries(listEl) {
    const root = listEl || $("drawerCalList");
    if (!root) return;
    root.querySelectorAll(".calendar-entry:not(.calendar-entry--published)").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const fromResults = !!btn.closest("#ttResultsCalList");
        loadHistorySession(btn.dataset.date, btn.dataset.id, {
          keepDrawer: !fromResults,
          focusResults: fromResults,
        });
      });
    });
  }

  function safeOn(id, event, fn) {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
  }

  function initEmbedMode() {
    const params = new URLSearchParams(location.search);
    const embedded =
      params.get("embed") === "1" || window.self !== window.top;
    if (!embedded) return;
    document.documentElement.classList.add("is-embed");
    document.body.classList.add("is-embed");
    const banner = $("embedOpenBanner");
    const link = $("embedOpenLink");
    if (banner) banner.hidden = false;
    if (link && !link.href.includes("http")) {
      link.href =
        "https://thepokerninja.github.io/rainmaker-morning/latest.html?embed=0";
    }
  }

  function wire() {
    if (typeof RMResultsHero !== "undefined") {
      RMResultsHero.configure({
        getSession: () => session,
        getActivePick: () => activePick,
        getScanningSymbol: () =>
          newsScanRunning ? RMChartHub?.state?.scanningSym || null : null,
        getTrades,
        getJournalTrades,
        collectOpenRows: collectOpenPositionRows,
        renderOpenRow: renderOpenPositionRow,
        openResultsTab: () => {
          showScansPanel();
          if (scansTab !== "results") {
            setScansTab("results", { skipHero: true });
          }
        },
        pickScore: (p) => pickScore(p),
        onCtaAction: ({ action, symbol, focus }) => {
          if (action === "review_symbol" && symbol) {
            const sym = String(symbol).toUpperCase();
            const chartPlan =
              typeof RMAnalysisChart !== "undefined"
                ? RMAnalysisChart.state?.tradePlan
                : null;
            const planSym = chartPlan?.symbol
              ? String(chartPlan.symbol).toUpperCase()
              : "";
            if (
              chartPlan &&
              (planSym === sym ||
                String(chartPlan.symbol || "").trim() === String(symbol).trim())
            ) {
              showScansPanel();
              setScansTab("results", { skipHero: true });
              void RMResultsHero.showSetup(sym, chartPlan);
              selectTicker(symbol, { toggle: false, snapChart: true, skipHero: true });
              return;
            }
            selectTicker(symbol, { toggle: false, snapChart: true });
            return;
          }
          if (action === "compare_picks") {
            $("btnResultsCompare")?.click();
            return;
          }
          if (action === "connect_schwab") {
            openAccountDrawer();
            return;
          }
          if (action === "load_scan") {
            void loadPublishedSessionInteractive();
            return;
          }
          if (action === "strategy_tab") {
            setScansTab("strategy");
            if (focus) {
              const panelId = {
                research: "ttResearchPanel",
                greenlit: "ttGreenLitPanel",
                calibration: "ttCalibrationPanel",
                monthly: "ttMonthlyReviewPanel",
              }[focus];
              requestAnimationFrame(() => {
                document
                  .getElementById(panelId)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              });
            }
            return;
          }
          if (action === "review_closed") {
            showScansPanel();
            setScansTab("results", { skipHero: true });
            requestAnimationFrame(() => {
              $("ttResultsClosed")?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            });
            return;
          }
          if (action === "chart_focus") {
            document
              .querySelector(".morning-workspace")
              ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        },
      });
      document.addEventListener("click", (e) => {
        const cell = e.target.closest?.(".fv-map-cell[data-symbol]");
        if (!cell) return;
        const sym = cell.dataset.symbol;
        if (!sym) return;
        showScansPanel();
        setScansTab("results");
        void RMResultsHero.showTicker(sym);
        selectTicker(sym, { toggle: false, snapChart: false });
      });
    }
    wireScanDrawerFooter();
    if (typeof RMScanConfig !== "undefined") {
      const cfg = RMScanConfig.load();
      scanConfigDraft = cfg;
      syncRmWeightPts(cfg.weights);
    }
    const fileInput = $("fileScan");
    if (!fileInput) {
      status("Import control missing — refresh the page");
      return;
    }
    safeOn("btnImport", "click", () => fileInput.click());
    fileInput.addEventListener("change", handleFileSelect);
    safeOn("btnAccount", "click", openAccountDrawer);
    safeOn("btnAccountMobile", "click", openAccountDrawer);
    safeOn("btnAuthLogout", "click", (e) => {
      // Keyboard Space/Enter synthesize click with detail === 0; ignore to stop reload loops
      // when Sign out retains focus inside a closed/hidden drawer.
      if (e && e.detail === 0) return;
      if (typeof RMAuthGate !== "undefined") RMAuthGate.logout();
    });
    safeOn("btnMarketSettings", "click", () => {
      const mp = $("marketPanel");
      if (mp && typeof RMMarket !== "undefined" && RMMarket.toggleSettingsMenu) {
        RMMarket.toggleSettingsMenu(mp);
      }
    });
    safeOn("btnChartSettings", "click", () => {
      const hub = $("chartHubView");
      const wrap = hub?.querySelector(".ca-toolbar-wrap");
      if (document.body.classList.contains("is-mobile-snap-chart") && wrap) {
        const open = wrap.classList.toggle("ca-toolbar-wrap--tools-open");
        const btn = $("btnChartSettings");
        if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
          wrap.querySelector(".ca-toolbar--secondary")?.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
        }
        return;
      }
      const toolbar = hub?.querySelector(".ca-toolbar");
      if (toolbar) {
        toolbar.scrollIntoView({ behavior: "smooth", block: "nearest" });
        toolbar.classList.add("ca-toolbar--flash");
        setTimeout(() => toolbar.classList.remove("ca-toolbar--flash"), 1200);
      }
    });
    safeOn("btnChartFullscreen", "click", () => {
      const hub = $("chartHubView");
      if (typeof RMChartHub !== "undefined" && RMChartHub.openFullscreen) {
        RMChartHub.openFullscreen(hub);
      }
    });
    safeOn("btnScanSettings", "click", openScanSettingsDrawer);
    safeOn("btnDismissScans", "click", dismissScansPanel);
    document.querySelectorAll("[data-scans-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setScansTab(btn.dataset.scansTab));
    });
    document.addEventListener("rm:scans-swipe-strategy", (e) => {
      setScansTab("strategy", {
        viaScrollDown: true,
        scrollCarryPx: e.detail?.scrollCarryPx,
      });
    });
    document.addEventListener("rm:scans-swipe-results", (e) => {
      setScansTab("results", {
        viaScrollUp: true,
        scrollCarryPx: e.detail?.scrollCarryPx,
        skipHero: true,
      });
    });
    window.__rmSetScansTab = setScansTab;
    safeOn("btnImport", "click", () => showScansPanel());
    wireTradeFooter();
    document.addEventListener("mousedown", (e) => {
      const t = e.target;
      if (
        typeof RMAnalysisChart !== "undefined" &&
        RMAnalysisChart.state?.tradePlanExpanded &&
        !t.closest(
          ".ca-plan-flag, .ca-plan-flag-hit, [data-plan-flag], .ca-plan-panel, #caPlanPanelBackdrop, #caPlanDismiss"
        )
      ) {
        RMAnalysisChart.dismissExpandedTradePlan?.();
      }
      if (!activePick) return;
      if (
        t.closest(
          ".pick-row, #tradeFooterJourney, #appFooter, .ca-toolbar-wrap, .ca-plan-panel, .ca-chart-node, .fv-tip-layer, .ca-pane-resizer, .ca-rm-rec, .ca-plan-flag, .ca-trade-plan, [data-plan-flag]"
        )
      ) {
        return;
      }
      if (t.closest("#workspaceChart .ca-chart-svg-wrap, #workspaceChart .chart-hub-legend-wrap")) {
        if (t.closest(".ca-plan-flag, .ca-trade-plan, [data-plan-flag]")) return;
        clearTickerSelection();
        return;
      }
      if (!t.closest("#workspaceScans")) {
        clearTickerSelection();
      }
    });
    document.addEventListener("rm:select-ticker", (e) => {
      if (e.detail?.symbol) {
        selectTicker(e.detail.symbol, {
          toggle: e.detail.toggle !== false,
          skipHero: !!e.detail.skipHero,
        });
      }
    });
    safeOn("drawerCalSearch", "input", (e) => {
      renderCalendarUi(e.target.value, "drawer");
    });
    safeOn("btnCustomScan", "click", () => runRainmakerMarketScan());
    safeOn("btnCloseScanDrawer", "click", closeScanDrawer);
    safeOn("scanBackdrop", "click", closeScanDrawer);
    safeOn("btnShowAddHolding", "click", () => showAddHoldingForm());
    safeOn("btnSaveHolding", "click", saveHoldingFromForm);
    safeOn("btnCancelAddHolding", "click", renderDrawerHoldings);
    safeOn("tabStock", "click", (e) => {
      e.stopPropagation();
      setInstrumentTab("stock");
    });
    safeOn("tabOption", "click", (e) => {
      e.stopPropagation();
      setInstrumentTab("option");
    });
    safeOn("btnCloseDrawer", "click", closeOrderDrawer);
    safeOn("orderBackdrop", "click", closeOrderDrawer);
    safeOn("btnClosePosition", "click", () => {
      const panel = $("closePanel");
      if (panel) panel.classList.remove("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("scanDrawer")?.classList.contains("open")) closeScanDrawer();
      else closeOrderDrawer();
    });
    safeOn("btnSavePlan", "click", saveOpenTrade);
    safeOn("btnClose", "click", closeTrade);
  }

  function ensureDrawersClosed() {
    closeOrderDrawer();
    closeScanDrawer();
  }

  initEmbedMode();
  window.selectTradeSetup = selectTradeSetup;
  window.surfacingTradePlanToResults = surfacingTradePlanToResults;
  window.RMJournal = {
    computeJournalStats,
    renderResultsPerformance,
    equitySparklineSvg,
  };
  window.RMTrades = {
    getTrades,
    getJournalTrades,
    saveOpenTradeFromPlan,
    closeTradeFromPlan,
    isFilledFromInput,
  };
  window.renderDrawerHoldings = renderDrawerHoldings;
  window.renderResultsOpenTrades = renderResultsOpenTrades;
  window.renderResultsClosedTrades = renderResultsClosedTrades;
  window.openHoldingOnChart = openHoldingOnChart;
  window.closeOrderDrawer = closeOrderDrawer;
  window.selectTicker = selectTicker;
  window.rmStatus = status;
  document.addEventListener("rm:auth-ready", () => {
    void bootstrapSchwabForDashboard();
    void refreshSchwabJournalTrades();
    if (typeof RMTradeStory !== "undefined") {
      void RMTradeStory.hydrateToday();
    }
    if (typeof RMSchwabData !== "undefined" && RMSchwabData.applyCachedChartMarkers) {
      RMSchwabData.applyCachedChartMarkers();
    }
  });
  document.addEventListener("rm:chart-markers-updated", () => {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
      RMAnalysisChart.refreshTradeOverlay();
    }
  });
  document.addEventListener("rm:schwab-synced", () => {
    void refreshSchwabJournalTrades();
    renderDrawerHoldings();
    renderResultsOpenTrades();
    if (typeof renderPicks === "function") renderPicks();
    if (activePick && typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(activePick);
  });
  document.addEventListener("rm:schwab-positions", () => {
    renderDrawerHoldings();
    renderResultsOpenTrades();
    if (typeof renderPicks === "function") renderPicks();
    if (activePick && typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(activePick);
  });
  document.addEventListener("rm:results-open-rendered", initOpenListDelegation);
  initOpenListDelegation();
  document.addEventListener("rm:chart-bars", (e) => {
    if (e.detail?.compare) return;
    const sym = chartSymbolForBacktest();
    if (!sym) return;
    if (sym === chartBtLastSym && !e.detail?.force) return;
    chartBtLastSym = sym;
    scheduleChartStrategyBacktests();
  });
  document.addEventListener("rm:trade-closed", (e) => {
    const sym = e.detail?.symbol;
    if (sym) refreshPickRow(String(sym).toUpperCase());
  });
  document.addEventListener("rm:chart-trade-focus", (e) => {
    const markerId = e.detail?.markerId;
    if (!markerId || typeof RMTradeDebrief === "undefined") return;
    if (String(markerId).startsWith("debrief-")) {
      RMTradeDebrief.highlightClosedTradeRow(String(markerId).slice(8));
      return;
    }
    const trades = getJournalTrades().filter((t) => t.status === "closed");
    const tm =
      typeof RMAnalysisChart !== "undefined"
        ? RMAnalysisChart.tradeMarkersForSymbol?.(RMAnalysisChart.state?.symbol || "SPY")?.find(
            (m) => m.id === markerId
          )
        : null;
    if (!tm?.label) return;
    const trade = trades.find(
      (t) => String(t.symbol || "").trim().toUpperCase() === String(tm.label).trim().toUpperCase()
    );
    if (trade?.id) RMTradeDebrief.highlightClosedTradeRow(trade.id);
  });
  document.addEventListener("rm:toast", (e) => {
    if (e.detail?.message) status(e.detail.message);
  });
  wire();
  const _orderDrawer = $("orderDrawer");
  const _scanDrawer = $("scanDrawer");
  if (_orderDrawer && !_orderDrawer.classList.contains("open")) _orderDrawer.inert = true;
  if (_scanDrawer && !_scanDrawer.classList.contains("open")) _scanDrawer.inert = true;
  if (typeof RMWorkspaceAccordion !== "undefined") RMWorkspaceAccordion.init();
  document.addEventListener("rm:workspace-row", () => syncBackgroundActivity());
  document.addEventListener("visibilitychange", () => syncBackgroundActivity());
  window.syncMobilePickChrome = syncMobilePickChrome;
  window.syncBackgroundActivity = syncBackgroundActivity;
  async function startApp() {
    if (typeof RMAuthGate !== "undefined" && RMAuthGate.authRequired()) {
      await RMAuthGate.start(() => {});
    } else if (typeof RMAuthGate !== "undefined" && RMAuthGate.getToken()) {
      await RMAuthGate.validateSession({ retries: 1 });
      document.dispatchEvent(
        new CustomEvent("rm:auth-ready", { detail: { user: RMAuthGate.getUser() } })
      );
    }
    await boot();
  }
  startApp().catch((e) => {
    status(e.message || "Startup failed — refresh the page");
    console.error(e);
  });

  window.addEventListener("error", (e) => {
    if (e.message) status("Error: " + e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    status("Error: " + msg);
  });
  window.getMorningSession = () => session;
})();

