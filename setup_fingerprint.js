/**
 * Setup fingerprint  -  pillar scores + step sequence at plan/close (setup grading v1).
 */
(function (global) {
  const CONFIG_URL = "config/setup_grading.json";
  const BAND_LABELS = { 1: "Prime", 2: "Solid", 3: "Thin", 4: "Skip" };

  let config = null;
  let configLoad = null;

  const DEFAULT_CONFIG = {
    version: "2026-06-08",
    pillar_weights: { context: 0.25, universe: 0.3, structure: 0.3, trigger: 0.15 },
    bands: { prime_min_score: 78, solid_min_score: 58, thin_min_score: 38 },
    hard_gates: { pulse_stop_blocks: true, rm_min: 55, news_required: true },
    structure_rules: {
      orh: { entry_above_orh_full: 1, entry_near_orh_pct: 0.5, near_orh_within_pct: 1.5 },
      vwap: { entry_above_vwap_full: 1 },
    },
    trigger_map: {
      orh: ["orh", "manual"],
      vwap: ["vwap", "manual"],
      ema_pullback: ["ema_pullback_9", "ema_pullback_21", "ema_golden_cross"],
      macd_rsi: ["macd_rsi_buy"],
    },
    min_calibration_n: 30,
  };

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
  }

  function loadConfig() {
    if (config) return Promise.resolve(config);
    if (configLoad) return configLoad;
    configLoad = fetch(CONFIG_URL + "?v=20260608")
      .then((r) => (r.ok ? r.json() : DEFAULT_CONFIG))
      .catch(() => DEFAULT_CONFIG)
      .then((c) => {
        config = c;
        return config;
      });
    return configLoad;
  }

  function getConfig() {
    return config || DEFAULT_CONFIG;
  }

  function activePlayId() {
    if (typeof global.RMStrategies !== "undefined") {
      return global.RMStrategies.getActive()?.id || "h001-orh-2r";
    }
    return "h001-orh-2r";
  }

  function activeEntryRule() {
    if (typeof global.RMStrategies !== "undefined") {
      return global.RMStrategies.getActive()?.entryRule || "orh";
    }
    return "orh";
  }

  function pickRm(pick) {
    if (!pick) return null;
    if (pick.rm_confidence_adjusted != null) return pick.rm_confidence_adjusted;
    const c = pick.catalyst;
    if (c?.rm_confidence_adjusted != null) return c.rm_confidence_adjusted;
    return pick.rm_confidence;
  }

  function catalystVerified(pick) {
    if (!pick) return false;
    const cat = pick.catalyst || {};
    return cat.verified === true || (Array.isArray(cat.headlines) && cat.headlines.length > 0);
  }

  function pulseSnapshot() {
    if (typeof global.RMColumnKPI === "undefined" || !global.RMColumnKPI.compute) {
      return { gate: "wait", band: null };
    }
    const kpi = global.RMColumnKPI.compute();
    const c1 = kpi?.c1 || {};
    return { gate: c1.gate || "wait", band: c1.posture || null, signed: c1.internalSigned };
  }

  function structureLevels(plan, symbol) {
    const out = { orh: plan?.orh ?? null, orl: plan?.orl ?? null, vwap: plan?.vwap ?? null };
    if (typeof global.RMAnalysisChart !== "undefined" && global.RMAnalysisChart.state) {
      const st = global.RMAnalysisChart.state;
      if (String(st.symbol || "").toUpperCase() === String(symbol || "").toUpperCase()) {
        const tp = st.tradePlan || st.plan;
        if (tp) {
          out.orh = out.orh ?? tp.orh;
          out.orl = out.orl ?? tp.orl;
          out.vwap = out.vwap ?? tp.vwap;
        }
      }
    }
    return out;
  }

  function scoreContext(ctx) {
    const snap = ctx.pulse || pulseSnapshot();
    const gate = snap.gate || "wait";
    let score = 0.5;
    if (gate === "go") score = 1;
    else if (gate === "wait") score = 0.55;
    else if (gate === "stop") score = 0;
    return { score: clamp01(score), gate, band: snap.band };
  }

  function scoreUniverse(ctx) {
    const pick = ctx.pick;
    const cfg = getConfig();
    const rm = pickRm(pick);
    const rmMin = cfg.hard_gates?.rm_min ?? 55;
    let score = 0;
    if (rm != null && Number.isFinite(rm)) {
      score = clamp01((rm - 40) / 60);
    }
    const verified = catalystVerified(pick);
    if (verified) score = clamp01(score + 0.12);
    const gap = pick?.gap_pct ?? pick?.pct_change;
    if (gap != null && gap >= 3) score = clamp01(score + 0.08);
    const onScan = ctx.onScan !== false;
    if (!onScan) score *= 0.6;
    return {
      score: clamp01(score),
      rm,
      gap_pct: gap,
      catalyst_verified: verified,
      on_scan: onScan,
      rm_meets_min: rm != null && rm >= rmMin,
    };
  }

  function scoreStructure(ctx) {
    const plan = ctx.plan || {};
    const entry = plan.entry ?? plan.entry_price;
    const stop = plan.stop ?? plan.stop_price;
    const target = plan.target ?? plan.target_price;
    const levels = structureLevels(plan, ctx.symbol || plan.symbol);
    const entryRule = ctx.entryRule || activeEntryRule();
    const rules = getConfig().structure_rules || {};
    let structScore = 0;
    let entryVsOrh = null;

    if (entry != null && stop != null && target != null) structScore += 0.35;
    if (entry != null && stop != null && entry > stop) structScore += 0.2;

    if (entryRule === "orh" && entry != null && levels.orh != null) {
      if (entry >= levels.orh) {
        structScore += rules.orh?.entry_above_orh_full ?? 1;
        entryVsOrh = "above";
      } else {
        const pct = ((levels.orh - entry) / levels.orh) * 100;
        const within = rules.orh?.near_orh_within_pct ?? 1.5;
        if (pct <= within) {
          structScore += rules.orh?.entry_near_orh_pct ?? 0.5;
          entryVsOrh = "near";
        } else {
          entryVsOrh = "below";
        }
      }
    } else if (entryRule === "vwap" && entry != null && levels.vwap != null) {
      structScore += entry >= levels.vwap ? (rules.vwap?.entry_above_vwap_full ?? 1) : 0.35;
      entryVsOrh = entry >= levels.vwap ? "above_vwap" : "below_vwap";
    } else if (entry != null) {
      structScore += 0.4;
    }

    return {
      score: clamp01(structScore / 1.55),
      entry,
      stop,
      target,
      orh: levels.orh,
      orl: levels.orl,
      entry_vs_level: entryVsOrh,
      entry_rule: entryRule,
    };
  }

  function scoreTrigger(ctx) {
    const signal = (ctx.signal_source || "orh").toLowerCase();
    const entryRule = ctx.entryRule || activeEntryRule();
    const map = getConfig().trigger_map || {};
    const allowed = map[entryRule] || map.orh || ["orh", "manual"];
    const match = allowed.some((s) => String(s).toLowerCase() === signal);
    return {
      score: match ? 1 : 0.35,
      signal_source: signal,
      entry_rule: entryRule,
      matched: match,
    };
  }

  function evaluateHardGates(ctx, pillars) {
    const cfg = getConfig().hard_gates || {};
    const failed = [];
    const pulse = ctx.pulse || pulseSnapshot();
    if (cfg.pulse_stop_blocks && pulse.gate === "stop") failed.push("pulse_stop");
    const uni = pillars.universe || {};
    if (uni.rm != null && uni.rm < (cfg.rm_min ?? 55)) failed.push("rm_below_min");
    if (cfg.news_required && !uni.catalyst_verified) failed.push("news_unverified");
    const plan = ctx.plan || {};
    const entry = plan.entry ?? plan.entry_price;
    const stop = plan.stop ?? plan.stop_price;
    if (entry == null || stop == null) failed.push("plan_incomplete");
    else if (!(entry > stop)) failed.push("invalid_risk");
    return { pass: failed.length === 0, failed };
  }

  function buildSteps(ctx, pillars, hard) {
    const plan = ctx.plan || {};
    const entry = plan.entry ?? plan.entry_price;
    const stop = plan.stop ?? plan.stop_price;
    return {
      regime_ok: (ctx.pulse || pulseSnapshot()).gate !== "stop",
      universe_ok: !!(pillars.universe?.on_scan !== false && pillars.universe?.rm_meets_min),
      plan_written: entry != null && stop != null && (plan.target ?? plan.target_price) != null,
      structure_ok: (pillars.structure?.score ?? 0) >= 0.55,
      trigger_fired: pillars.trigger?.matched === true,
      entry_filled: ctx.entry_filled === true,
      stop_defined: entry != null && stop != null && entry > stop,
      exit_rule: ctx.exit_rule || null,
    };
  }

  function bandFromScore(setupScore, hard) {
    const b = getConfig().bands || {};
    if (!hard.pass) return 4;
    if (setupScore >= (b.prime_min_score ?? 78)) return 1;
    if (setupScore >= (b.solid_min_score ?? 58)) return 2;
    if (setupScore >= (b.thin_min_score ?? 38)) return 3;
    return 4;
  }

  function weightedScore(pillars) {
    const w = getConfig().pillar_weights || DEFAULT_CONFIG.pillar_weights;
    const raw =
      (pillars.context?.score ?? 0) * (w.context ?? 0.25) +
      (pillars.universe?.score ?? 0) * (w.universe ?? 0.3) +
      (pillars.structure?.score ?? 0) * (w.structure ?? 0.3) +
      (pillars.trigger?.score ?? 0) * (w.trigger ?? 0.15);
    return Math.round(raw * 100);
  }

  async function scoreViaApi(ctx) {
    const base = apiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + "/learning/setup-fingerprints/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: ctx }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.fingerprint || null;
    } catch {
      return null;
    }
  }

  async function buildFingerprintAsync(ctx) {
    const remote = await scoreViaApi(ctx);
    if (remote) {
      const cfg = getConfig();
      const pick = ctx.pick || {};
      return {
        ...remote,
        steps: buildSteps(ctx, remote.pillars || {}, remote.hard_gates || {}),
        snapshots: {
          pulse: ctx.pulse || pulseSnapshot(),
          pick: {
            symbol: pick.symbol || ctx.symbol,
            rm: pickRm(pick),
            gap_pct: pick.gap_pct ?? pick.pct_change,
            catalyst_verified: catalystVerified(pick),
          },
          shape: {
            entry_rule: ctx.entryRule || activeEntryRule(),
            signal_source: ctx.signal_source || null,
          },
        },
        at: new Date().toISOString(),
        source: remote.source || "rm_api",
      };
    }
    return buildFingerprint(ctx);
  }

  function buildFingerprint(ctx) {
    const cfg = getConfig();
    const pillars = {
      context: scoreContext(ctx),
      universe: scoreUniverse(ctx),
      structure: scoreStructure(ctx),
      trigger: scoreTrigger(ctx),
    };
    const hard = evaluateHardGates(ctx, pillars);
    const setup_score = weightedScore(pillars);
    const setup_band = bandFromScore(setup_score, hard);
    const steps = buildSteps(ctx, pillars, hard);
    const pick = ctx.pick || {};
    return {
      version: cfg.version || "2026-06-08",
      play_id: ctx.play_id || activePlayId(),
      setup_score,
      setup_band,
      setup_band_label: BAND_LABELS[setup_band] || "Skip",
      pillars,
      steps,
      hard_gates: hard,
      snapshots: {
        pulse: ctx.pulse || pulseSnapshot(),
        pick: {
          symbol: pick.symbol || ctx.symbol,
          rm: pickRm(pick),
          gap_pct: pick.gap_pct ?? pick.pct_change,
          catalyst_verified: catalystVerified(pick),
        },
        shape: {
          entry_rule: ctx.entryRule || activeEntryRule(),
          signal_source: ctx.signal_source || null,
        },
      },
      at: new Date().toISOString(),
    };
  }

  function inferExitRule(trade, plan) {
    if (!trade || trade.status !== "closed") return null;
    const r =
      typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.rMultiple(trade)
        : trade.r_multiple;
    const target = trade.target_price ?? plan?.target;
    const entry = trade.entry_price ?? plan?.entry;
    const stop = trade.stop_price ?? plan?.stop;
    if (r == null || entry == null || stop == null) return "discretionary";
    const risk = entry - stop;
    if (risk <= 0) return "discretionary";
    const targetR = target != null ? (target - entry) / risk : 2;
    if (r >= targetR * 0.95) return "hit_target";
    if (r >= 1.95) return "hit_2r";
    if (r >= 0.95) return "hit_1r";
    if (r <= -0.95) return "stopped";
    return "session_close";
  }

  function buildContextFromPlan(plan, pick, opts) {
    return {
      plan,
      pick: pick || { symbol: plan?.symbol },
      symbol: plan?.symbol,
      play_id: opts?.play_id || activePlayId(),
      entryRule: opts?.entryRule || activeEntryRule(),
      signal_source: opts?.signal_source || plan?.signal_source || "orh",
      pulse: opts?.pulse,
      onScan: opts?.onScan !== false,
      entry_filled: opts?.entry_filled === true,
      exit_rule: opts?.exit_rule || null,
    };
  }

  function attachToTrade(trade, fingerprint) {
    if (!trade || !fingerprint) return trade;
    return { ...trade, setup_fingerprint: fingerprint };
  }

  function apiBase() {
    const meta = document.querySelector('meta[name="rainmaker-api-base"]');
    if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "https://rainmaker-api-waqs.onrender.com";
  }

  async function syncFingerprint(trade, fingerprint) {
    const base = apiBase();
    if (!base || !fingerprint) return { ok: false };
    const r =
      typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.rMultiple(trade)
        : trade?.r_multiple;
    try {
      const res = await fetch(base + "/learning/setup-fingerprints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprints: [
            {
              trade_id: trade?.id || trade?.symbol + "-" + (trade?.closed_at || Date.now()),
              symbol: trade?.symbol,
              session_id: trade?.session_id,
              play_id: fingerprint.play_id,
              setup_score: fingerprint.setup_score,
              setup_band: fingerprint.setup_band,
              fingerprint,
              plan_r: trade?.plan_r,
              realized_r: trade?.realized_r,
              r_multiple: r,
              planned: trade?.planned !== false,
              closed_at: trade?.closed_at || null,
            },
          ],
        }),
        keepalive: true,
      });
      return { ok: res.ok };
    } catch (_) {
      return { ok: false };
    }
  }

  function fingerprintForPlan(plan, pick, opts) {
    const ctx = buildContextFromPlan(plan, pick, opts);
    return buildFingerprint(ctx);
  }

  async function fingerprintForPlanAsync(plan, pick, opts) {
    const ctx = buildContextFromPlan(plan, pick, opts);
    return buildFingerprintAsync(ctx);
  }

  function finalizeOnClose(trade, pick, plan, opts) {
    const fp =
      trade?.setup_fingerprint ||
      fingerprintForPlan(
        {
          symbol: trade?.symbol,
          entry: trade?.entry_price,
          stop: trade?.stop_price,
          target: trade?.target_price,
          orh: plan?.orh,
          orl: plan?.orl,
        },
        pick,
        {
          ...opts,
          entry_filled: true,
          exit_rule: inferExitRule(trade, plan),
        }
      );
    const merged = {
      ...fp,
      steps: {
        ...fp.steps,
        entry_filled: true,
        exit_rule: inferExitRule(trade, plan),
      },
      at: new Date().toISOString(),
    };
    const enriched = attachToTrade(trade, merged);
    void syncFingerprint(enriched, merged);
    return enriched;
  }

  loadConfig();

  global.RMSetupFingerprint = {
    loadConfig,
    getConfig,
    buildFingerprint,
    buildFingerprintAsync,
    fingerprintForPlan,
    fingerprintForPlanAsync,
    finalizeOnClose,
    attachToTrade,
    syncFingerprint,
    inferExitRule,
    BAND_LABELS,
  };
})(typeof window !== "undefined" ? window : globalThis);
