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
