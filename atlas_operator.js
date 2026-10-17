/**
 * Atlas operator  -  paper trade workflow from war plan through Trade Story.
 * M0: plan ? propose (shadow/paper) ? entry/exit events on RM_TRADING_MODE=paper.
 */
(function (global) {
  "use strict";

  const ATLAS_ID = "atlas";
  const STORAGE_KEY = "rainmaker_atlas_operator_v1";

  function apiBase() {
    const meta = document.querySelector('meta[name="rainmaker-api-base"]');
    if (meta?.content) return meta.content.replace(/\/$/, "");
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (global.RMAuthGate?.authHeaders) Object.assign(headers, global.RMAuthGate.authHeaders() || {});
    } catch (_) {}
    return headers;
  }

  function readState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch, updated_at: new Date().toISOString() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
    return next;
  }

  function getWarPlan() {
    const brief = global.RMWorkspaceLoad?.getMorningBrief?.() || {};
    return brief.war_plan || null;
  }

  function planFromSetup(setup) {
    if (!setup?.symbol) return null;
    const entry = Number(setup.entry ?? setup.orh ?? setup.premium_entry);
    const stop = Number(setup.stop ?? setup.orl ?? entry * 0.8);
    const rr = Number(setup.target_rr ?? 2);
    const risk = entry - stop;
    const target = Number(setup.target ?? (risk > 0 ? entry + risk * rr : entry * 1.04));
    return {
      symbol: String(setup.symbol).toUpperCase(),
      contract: setup.contract || null,
      entry,
      stop,
      target,
      qty: Number(setup.qty ?? setup.contracts ?? 1),
      thesis: setup.thesis || "Atlas ORH options momentum",
      signal_source: "atlas",
      strategyId: ATLAS_ID,
    };
  }

  async function proposePaper(plan, opts) {
    const base = apiBase();
    if (!base || !plan?.symbol) return null;
    try {
      const res = await fetch(base + "/trading/propose", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          symbol: plan.symbol,
          entry: plan.entry,
          stop: plan.stop,
          target: plan.target,
          strategyId: ATLAS_ID,
          rmConfidence: opts?.confidence ?? null,
          notify: false,
        }),
      });
      if (!res.ok) return null;
      return res.json();
    } catch (_) {
      return null;
    }
  }

  async function runPaperWorkflow(warPlan, opts) {
    if (!warPlan || warPlan.regime === "stop") {
      writeState({ last_skip: { reason: "regime_stop", at: new Date().toISOString() } });
      return { ok: false, reason: "regime_stop" };
    }
    const setup = warPlan.atlas_setup;
    if (!setup?.symbol) {
      writeState({ last_skip: { reason: "no_setup", at: new Date().toISOString() } });
      return { ok: false, reason: "no_setup" };
    }

    const plan = planFromSetup(setup);
    if (!plan || !Number.isFinite(plan.entry) || !Number.isFinite(plan.stop)) {
      return { ok: false, reason: "invalid_plan" };
    }

    let story = null;
    if (typeof global.RMTradeStory !== "undefined") {
      story = await global.RMTradeStory.syncPlan(plan, {
        signal_source: "atlas",
        thesis: plan.thesis,
        storyId: warPlan.date,
      });
    }

    const proposal = await proposePaper(plan, { confidence: setup.confidence });
    writeState({
      last_run: {
        date: warPlan.date,
        symbol: plan.symbol,
        proposal_id: proposal?.proposalId || proposal?.code || null,
        shadow: proposal?.shadow !== false,
        mode: proposal?.mode || "paper",
        at: new Date().toISOString(),
      },
    });

    if (proposal?.ok && typeof global.RMTradeStory !== "undefined") {
      await global.RMTradeStory.appendEvent(
        {
          type: "note",
          subtype: "atlas_proposal",
          symbol: plan.symbol,
          summary: proposal.shadow
            ? "Atlas paper proposal logged (shadow mode)"
            : "Atlas paper proposal submitted",
          proposal_id: proposal.proposalId || null,
          mode: proposal.mode,
        },
        { storyId: warPlan.date }
      );
    }

    document.dispatchEvent(
      new CustomEvent("rm:atlas-workflow", {
        detail: { warPlan, plan, story, proposal },
      })
    );
    return { ok: true, plan, story, proposal };
  }

  async function onMorningBrief(brief) {
    if (!brief?.war_plan) return null;
    const state = readState();
    if (state.last_run?.date === brief.war_plan.date) return state.last_run;
    return runPaperWorkflow(brief.war_plan, { auto: true });
  }

  function start() {
    document.addEventListener("rm:morning-brief", (ev) => {
      void onMorningBrief(ev.detail);
    });
    const existing = global.RMWorkspaceLoad?.getMorningBrief?.();
    if (existing?.war_plan) void onMorningBrief(existing);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  global.RMAtlas = {
    ATLAS_ID,
    getWarPlan,
    planFromSetup,
    proposePaper,
    runPaperWorkflow,
    onMorningBrief,
    readState,
  };
})(typeof window !== "undefined" ? window : globalThis);
