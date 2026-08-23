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
