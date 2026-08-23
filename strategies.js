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
