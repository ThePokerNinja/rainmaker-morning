/**
 * Server-side research: inbox queue + walk-forward backtest + live expectancy.
 */
(function (global) {
  "use strict";

  const CACHE_KEY = "rainmaker_research_wf_v1";
  const INBOX_CACHE_KEY = "rainmaker_research_inbox_v1";
  const BASE_SYMBOLS = ["SPY", "QQQ"];
  const PROD_API = "https://rainmaker-api-waqs.onrender.com";
  let selectedIdeaId = null;
  let inboxIdeas = [];
  let queueBusy = false;
  let queueFlash = "";
  let queueFlashKind = "";
  let drawerDetail = null;
  let drawerWired = false;
  let researchDeepLinkOpened = false;
  let inboxPollTimer = null;
  let lastInboxSyncAt = 0;

  function isLocalHost() {
    const h = location.hostname;
    return h === "localhost" || h === "127.0.0.1";
  }

  function isLocalApiUrl(url) {
    return /127\.0\.0\.1:8765|localhost:8765/i.test(url || "");
  }

  function apiBase() {
    // Research inbox is open on local rm_api; avoid stale prod overrides on :8787.
    if (isLocalHost()) return "http://127.0.0.1:8765";
    try {
      if (global.RMMorningApi && typeof global.RMMorningApi.resolveApiBase === "function") {
        const shared = global.RMMorningApi.resolveApiBase();
        if (shared) return String(shared).replace(/\/$/, "");
      }
    } catch (e) {}
    try {
      if (global.RMAuthGate && typeof global.RMAuthGate.getApiBase === "function") {
        const gate = global.RMAuthGate.getApiBase();
        if (gate) return String(gate).replace(/\/$/, "");
      }
    } catch (e) {}
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content) return meta.content.trim().replace(/\/$/, "");
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) {
        const normalized = stored.replace(/\/$/, "");
        if (!isLocalApiUrl(normalized)) return normalized;
      }
    } catch (e) {}
    return PROD_API;
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (global.RMAuthGate && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (e) {}
    return headers;
  }

  function authHeadersMultipart() {
    const headers = {};
    try {
      if (global.RMAuthGate && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (e) {}
    return headers;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch (e) {
      return "—";
    }
  }

  function statusClass(st) {
    if (st === "done") return "is-good";
    if (st === "failed") return "is-weak";
    if (st === "running") return "is-running";
    return "";
  }

  function parseResearchDeepLink() {
    try {
      const p = new URLSearchParams(global.location.search);
      const id = p.get("research");
      if (id) selectedIdeaId = id;
    } catch (e) {}
  }

  function needsLogin() {
    try {
      const base = apiBase();
      const prodApi = base && !isLocalApiUrl(base);
      if (prodApi) {
        return !global.RMAuthGate?.getToken?.() || !global.RMAuthGate.getToken();
      }
      if (!global.RMAuthGate?.authRequired?.()) return false;
      return !global.RMAuthGate.getToken?.() || !global.RMAuthGate.getToken();
    } catch (e) {
      return false;
    }
  }

  function queueErrorMessage(err, resStatus) {
    const msg = String((err && err.message) || err || "");
    if (
      msg === "Failed to fetch" ||
      msg.includes("NetworkError") ||
      msg === "The user aborted a request."
    ) {
      if (!isLocalHost()) {
        return "Rainmaker API offline — Render may be waking up. Wait 30s and try again.";
      }
      return "API unreachable — start rm_api locally (port 8765).";
    }
    if (msg === "Invalid admin token" || msg.includes("Invalid admin token")) {
      if (needsLogin()) {
        return "Not signed in — refresh the page to sign in, then try Process next again.";
      }
      return "Process next needs the latest API on Render — redeploy rm_api, then hard-refresh.";
    }
    if (resStatus === 401) {
      const base = apiBase();
      if (isLocalApiUrl(base)) {
        return "Local rm_api rejected the request — restart rm_api without RM_CRON_TOKEN set.";
      }
      if (global.RMAuthGate?.getToken?.()) {
        return "Session expired — open Account, sign out, and sign in again.";
      }
      return "Not signed in — refresh the page to sign in, then try again.";
    }
    if (resStatus === 404) {
      const base = apiBase();
      if (base && (base.includes("127.0.0.1") || base.includes("localhost"))) {
        return "Research API not on local rm_api — restart it from tools/rm_api (port 8765).";
      }
      return "Research API not on Render yet — push latest rm_api and redeploy.";
    }
    if (resStatus === 405) {
      return "Delete not on API yet — wait for deploy, then hard-refresh.";
    }
    if (msg === "no_api") {
      return "No API URL — set rainmaker-api-base or use the published app.";
    }
    return msg;
  }

  async function fetchInbox(force) {
    const base = apiBase();
    if (!base) {
      return { ideas: [], error: "no_api" };
    }
    if (!force) {
      try {
        const cached = JSON.parse(global.sessionStorage.getItem(INBOX_CACHE_KEY) || "null");
        if (cached && cached.at && Date.now() - cached.at < 60000) {
          inboxIdeas = cached.ideas || [];
          return { ideas: inboxIdeas, error: null };
        }
      } catch (e) {}
    }
    const res = await apiFetch("/research/ideas?limit=30", { headers: authHeaders() });
    if (!res.ok) {
      return { ideas: [], error: queueErrorMessage(null, res.status) };
    }
    const data = await res.json();
    inboxIdeas = data.ideas || [];
    try {
      const capRes = await apiFetch("/capture/today?limit=20", { headers: authHeaders() });
      if (capRes.ok) {
        const capData = await capRes.json();
        const extras = (capData.captures || []).map(function (c) {
          return {
            id: c.id,
            prompt: "[" + (c.kind || "note") + "] " + (c.body || ""),
            status: c.status || "open",
            source: "capture",
          };
        });
        inboxIdeas = extras.concat(inboxIdeas);
      }
    } catch (e) {}
    try {
      global.sessionStorage.setItem(
        INBOX_CACHE_KEY,
        JSON.stringify({ at: Date.now(), ideas: inboxIdeas })
      );
    } catch (e) {}
    return { ideas: inboxIdeas, error: null };
  }

  async function fetchIdeaDetail(id) {
    const base = apiBase();
    if (!base || !id) return null;
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(id), {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  }

  async function apiFetch(path, opts) {
    const base = apiBase();
    if (!base) throw new Error("no_api");
    const timeoutMs = isLocalHost() ? 15000 : 45000;
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, timeoutMs);
    try {
      return await fetch(base + path, { ...(opts || {}), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function queueIdea(payload) {
    const res = await apiFetch("/research/ideas", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(function () {
        return {};
      });
      const e = new Error(err.detail || "queue_failed");
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    await fetchInbox(true);
    return data;
  }

  async function attachToIdea(id, payload) {
    const base = apiBase();
    if (!base) return null;
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(id) + "/attachments", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload || {}),
    });
    return res.ok ? await res.json() : null;
  }

  async function uploadToIdea(id, file, title) {
    const base = apiBase();
    if (!base || !file) return null;
    const fd = new FormData();
    fd.append("file", file);
    if (title) fd.append("title", title);
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(id) + "/upload", {
      method: "POST",
      headers: authHeadersMultipart(),
      body: fd,
    });
    return res.ok ? await res.json() : null;
  }

  async function processNextInbox() {
    const base = apiBase();
    if (!base) throw new Error("API offline");
    const res = await fetch(base + "/research/process", {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    if (!res.ok) {
      const err = await res.json().catch(function () {
        return {};
      });
      const e = new Error(err.detail || "Process failed (" + res.status + ")");
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  function inboxQueueBarHtml(ideas) {
    const queued = (ideas || []).filter(function (i) {
      return i.status === "queued";
    }).length;
    const running = (ideas || []).some(function (i) {
      return i.status === "running";
    });
    if (!queued && !running) return "";
    const label = running
      ? "Research running on server…"
      : queued + " queued · auto-runs every ~15m";
    return (
      '<div class="rm-research-queue-bar">' +
      '<span class="rm-research-queue-bar-copy">' +
      escapeHtml(label) +
      "</span>" +
      (queued
        ? '<button type="button" class="btn-sm primary" id="btnInboxProcess">Process now</button>'
        : '<span class="rm-research-queue-bar-pulse" aria-hidden="true"></span>') +
      "</div>"
    );
  }

  function inboxSyncLabelHtml() {
    if (!lastInboxSyncAt) {
      return '<span class="rm-research-sync-label">Syncing…</span>';
    }
    const sec = Math.max(0, Math.floor((Date.now() - lastInboxSyncAt) / 1000));
    const text =
      sec < 8 ? "Live" : sec < 60 ? sec + "s ago" : Math.floor(sec / 60) + "m ago";
    return '<span class="rm-research-sync-label">' + escapeHtml(text) + "</span>";
  }

  function syncInboxPoll(ideas) {
    const needs = (ideas || []).some(function (i) {
      return i.status === "queued" || i.status === "running";
    });
    if (needs && !inboxPollTimer) {
      inboxPollTimer = global.setInterval(function () {
        void refreshInbox(true);
      }, 60000);
    } else if (!needs && inboxPollTimer) {
      global.clearInterval(inboxPollTimer);
      inboxPollTimer = null;
    }
  }

  const TRASH_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
    "</svg>";

  function canDeleteIdea(idea) {
    return idea && (idea.status === "done" || idea.status === "failed");
  }

  function deleteButtonHtml(ideaId) {
    return (
      '<button type="button" class="btn-icon rm-research-delete" data-idea-id="' +
      escapeHtml(ideaId) +
      '" title="Delete report" aria-label="Delete report">' +
      TRASH_ICON_SVG +
      "</button>"
    );
  }

  async function deleteIdea(ideaId) {
    const res = await apiFetch("/research/ideas/" + encodeURIComponent(ideaId), {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(function () {
        return {};
      });
      const e = new Error(err.detail || "Delete failed (" + res.status + ")");
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  async function submitFeedback(ideaId, feedback) {
    const base = apiBase();
    if (!base) throw new Error("API offline");
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(ideaId) + "/feedback", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ feedback: feedback }),
    });
    if (!res.ok) throw new Error("Feedback failed");
    return res.json();
  }

  function feedbackHtml(idea) {
    if (!idea || idea.status !== "done") return "";
    const fb = idea.feedback || "";
    return (
      '<div class="rm-research-feedback" role="group" aria-label="Rate this research">' +
      '<button type="button" class="btn-sm secondary rm-research-fb' +
      (fb === "up" ? " is-active" : "") +
      '" data-fb="up" title="Helpful">👍</button>' +
      '<button type="button" class="btn-sm secondary rm-research-fb' +
      (fb === "down" ? " is-active" : "") +
      '" data-fb="down" title="Not helpful">👎</button>' +
      "</div>"
    );
  }

  function reportsEmptyHtml() {
    return (
      '<div class="rm-research-empty">' +
      '<div class="rm-research-empty-graphic" aria-hidden="true">' +
      '<svg viewBox="0 0 120 72" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 56h104" stroke="currentColor" stroke-opacity="0.2"/>' +
      '<path d="M16 48l18-14 16 10 22-26 30 30" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>' +
      '<circle cx="88" cy="18" r="4" fill="currentColor" opacity="0.35"/>' +
      "</svg></div>" +
      '<p class="rm-research-empty-title">No reports yet</p>' +
      '<p class="meta rm-research-empty-copy">Submit a question in the desk above — finished reports appear here.</p>' +
      "</div>"
    );
  }

  function reportsAccordionHtml(ideas) {
    if (!ideas.length) {
      return reportsEmptyHtml();
    }
    return (
      '<div class="rm-research-acc-list">' +
      ideas
        .map(function (idea) {
          const sid = idea.short_id || (idea.id || "").slice(0, 8);
          const canOpen = idea.status === "done" || idea.status === "failed";
          const openLabel = idea.status === "done" ? "Open report" : "View";
          const deleteBtn = canDeleteIdea(idea) ? deleteButtonHtml(idea.id) : "";
          return (
            '<article class="rm-research-acc" data-idea-id="' +
            escapeHtml(idea.id) +
            '">' +
            '<p class="rm-research-acc-prompt">' +
            escapeHtml(idea.prompt || "Research prompt") +
            "</p>" +
            '<p class="rm-research-acc-meta meta">' +
            '<span class="rm-research-inbox-status ' +
            statusClass(idea.status) +
            '">' +
            escapeHtml(idea.status || "queued") +
            "</span> #" +
            escapeHtml(sid) +
            " · " +
            fmtTime(idea.updated_at || idea.created_at) +
            "</p>" +
            (canOpen || deleteBtn
              ? '<div class="rm-research-acc-actions">' +
                (canOpen
                  ? '<button type="button" class="btn-sm secondary rm-research-open" data-idea-id="' +
                    escapeHtml(idea.id) +
                    '">' +
                    openLabel +
                    "</button>"
                  : "") +
                deleteBtn +
                "</div>"
              : "") +
            "</article>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  async function downloadResearchReport(idea, report, detail) {
    const body = (report && report.body) || "";
    if (!body) return;
    if (!global.RMResearchPdf || !global.RMResearchPdf.download) {
      throw new Error("PDF export unavailable");
    }
    await global.RMResearchPdf.download(idea, report, detail);
  }

  function emailResearchReport(idea, report) {
    const body = (report && report.body) || idea.summary || "";
    const prompt = idea.prompt || "Research report";
    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    let link = "";
    try {
      link =
        location.origin +
        location.pathname +
        "?research=" +
        encodeURIComponent(idea.id);
    } catch (e) {}
    const excerpt = body.slice(0, 1200);
    const mailBody =
      "Rainmaker research #" +
      sid +
      "\n\n" +
      prompt +
      "\n\n" +
      excerpt +
      (body.length > 1200
        ? "\n\n[Truncated in email — download PDF in app for full report]"
        : "") +
      (link ? "\n\nOpen in app: " + link : "");
    const subject = "Rainmaker research: " + prompt.slice(0, 60);
    location.href =
      "mailto:?subject=" +
      encodeURIComponent(subject) +
      "&body=" +
      encodeURIComponent(mailBody);
  }

  function ensureResearchDrawer() {
    if (document.getElementById("researchReportDrawer")) return;
    const backdrop = document.createElement("div");
    backdrop.id = "researchBackdrop";
    backdrop.className = "drawer-backdrop hidden";
    backdrop.setAttribute("aria-hidden", "true");
    const drawer = document.createElement("aside");
    drawer.id = "researchReportDrawer";
    drawer.className = "side-drawer is-closed";
    drawer.setAttribute("aria-hidden", "true");
    drawer.innerHTML =
      '<div class="side-drawer-inner research-drawer-inner">' +
      '<header class="side-drawer-header">' +
      "<div><h2 id=\"researchDrawerTitle\">Research</h2>" +
      '<p class="meta" id="researchDrawerSubtitle">Report</p></div>' +
      '<button type="button" id="btnCloseResearchDrawer" class="side-drawer-close" aria-label="Close">×</button>' +
      "</header>" +
      '<div class="research-drawer-scroll" id="researchDrawerBody"></div>' +
      '<footer class="research-drawer-footer" id="researchDrawerFooter" hidden>' +
      '<button type="button" class="btn-sm secondary" id="btnResearchDownload">Download PDF</button>' +
      '<button type="button" class="btn-sm secondary" id="btnResearchShare">Share</button>' +
      '<button type="button" class="btn-icon rm-research-delete-detail" id="btnResearchDelete" title="Delete report" aria-label="Delete report">' +
      TRASH_ICON_SVG +
      "</button></footer></div>";
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    backdrop.addEventListener("click", closeResearchDrawer);
    drawer.querySelector("#btnCloseResearchDrawer")?.addEventListener("click", closeResearchDrawer);
  }

  function wireResearchDrawer() {
    if (drawerWired) return;
    drawerWired = true;
    ensureResearchDrawer();
    document.getElementById("btnResearchDownload")?.addEventListener("click", function () {
      if (!drawerDetail || !drawerDetail.report || !drawerDetail.report.body) return;
      const btn = document.getElementById("btnResearchDownload");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Preparing PDF…";
      }
      downloadResearchReport(drawerDetail.idea, drawerDetail.report, drawerDetail)
        .catch(function (e) {
          console.warn("research pdf", e);
          setQueueFlash("PDF export failed — check connection and try again.", "err");
        })
        .finally(function () {
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Download PDF";
          }
        });
    });
    document.getElementById("btnResearchShare")?.addEventListener("click", function () {
      if (!drawerDetail) return;
      emailResearchReport(drawerDetail.idea, drawerDetail.report);
    });
    document.getElementById("btnResearchDelete")?.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (!drawerDetail || !drawerDetail.idea) return;
      void handleDeleteIdea(drawerDetail.idea.id);
    });
  }

  function closeResearchDrawer() {
    const backdrop = document.getElementById("researchBackdrop");
    const drawer = document.getElementById("researchReportDrawer");
    if (backdrop) {
      backdrop.classList.add("hidden");
      backdrop.setAttribute("aria-hidden", "true");
    }
    if (drawer) {
      drawer.classList.remove("open");
      drawer.classList.add("is-closed");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (
      !document.getElementById("orderDrawer")?.classList.contains("open") &&
      !document.getElementById("scanDrawer")?.classList.contains("open") &&
      !document.getElementById("tradeDebriefDrawer")?.classList.contains("open")
    ) {
      document.body.classList.remove("drawer-open");
    }
    drawerDetail = null;
  }

  function openResearchDrawer(detail) {
    if (!detail || !detail.idea) return;
    wireResearchDrawer();
    drawerDetail = detail;
    const idea = detail.idea;
    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    const titleEl = document.getElementById("researchDrawerTitle");
    const subEl = document.getElementById("researchDrawerSubtitle");
    const bodyEl = document.getElementById("researchDrawerBody");
    const footerEl = document.getElementById("researchDrawerFooter");
    if (titleEl) titleEl.textContent = (idea.prompt || "Research").slice(0, 120);
    if (subEl) {
      subEl.textContent =
        "#" + sid + " · " + (idea.status || "queued") + " · " + fmtTime(idea.updated_at || idea.created_at);
    }
    if (bodyEl) bodyEl.innerHTML = drawerBodyHtml(detail);
    if (footerEl) {
      const hasReport = !!(detail.report && detail.report.body);
      footerEl.hidden = !hasReport;
      const dl = document.getElementById("btnResearchDownload");
      const sh = document.getElementById("btnResearchShare");
      if (dl) dl.hidden = !hasReport;
      if (sh) sh.hidden = !hasReport;
    }
    const backdrop = document.getElementById("researchBackdrop");
    const drawer = document.getElementById("researchReportDrawer");
    if (backdrop) {
      backdrop.classList.remove("hidden");
      backdrop.setAttribute("aria-hidden", "false");
    }
    if (drawer) {
      drawer.classList.remove("is-closed");
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("drawer-open");
    bodyEl?.querySelectorAll(".rm-research-fb").forEach(function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        const id = idea.id;
        const fb = btn.getAttribute("data-fb");
        if (!id || !fb) return;
        try {
          await submitFeedback(id, fb);
          const refreshed = await fetchIdeaDetail(id);
          openResearchDrawer(refreshed);
          await refreshInbox(true);
        } catch (e) {
          console.warn("research feedback", e);
        }
      });
    });
    bindAttachHandlers(drawer, idea.id);
  }

  async function handleDeleteIdea(ideaId) {
    if (!ideaId) return;
    try {
      await deleteIdea(ideaId);
      try {
        global.sessionStorage.removeItem(INBOX_CACHE_KEY);
      } catch (e) {}
      if (selectedIdeaId === ideaId) selectedIdeaId = null;
      closeResearchDrawer();
      setQueueFlash("Report deleted.", "ok");
      const panel = document.getElementById("ttResearchPanel");
      await refreshInbox(true);
    } catch (e) {
      setQueueFlash(queueErrorMessage(e, e.status), "err");
      const panel = document.getElementById("ttResearchPanel");
      renderInbox(panel, inboxIdeas, false, null);
    }
  }

  function drawerBodyHtml(detail) {
    if (!detail || !detail.idea) {
      return '<p class="meta">No report loaded.</p>';
    }
    const idea = detail.idea;
    const report = detail.report;
    const artifacts = detail.artifacts || [];
    let html = '<div class="rm-research-detail">';
    if (idea.summary) {
      html += "<p>" + escapeHtml(idea.summary) + "</p>";
    }
    html += feedbackHtml(idea);
    if (idea.error) {
      html += '<p class="is-weak">' + escapeHtml(idea.error) + "</p>";
    }
    if (report && report.body) {
      html += '<pre class="rm-research-report">' + escapeHtml(report.body) + "</pre>";
    }
    const snippets = artifacts.filter(function (a) {
      return a.kind === "snippet" || a.kind === "attachment" || a.kind === "raw_doc";
    });
    if (snippets.length) {
      html += "<h5>Sources</h5><ul class='rm-research-sources'>";
      snippets.slice(0, 8).forEach(function (a) {
        html +=
          "<li><strong>" +
          escapeHtml(a.title || "source") +
          "</strong> — " +
          escapeHtml((a.body || "").slice(0, 160)) +
          "</li>";
      });
      html += "</ul>";
    }
    if (idea.status === "queued" || idea.status === "failed") {
      html +=
        '<div class="rm-research-attach">' +
        '<textarea id="researchAttachText" rows="3" placeholder="Paste paywalled notes or URLs…"></textarea>' +
        '<input type="file" id="researchAttachFile" accept=".pdf,.txt,.md" />' +
        '<button type="button" class="btn-sm secondary" id="btnResearchAttach">Attach</button>' +
        "</div>";
    }
    html += "</div>";
    return html;
  }

  function queueStatusHtml() {
    if (!queueFlash) return '<p class="rm-research-queue-status meta" id="researchQueueStatus" hidden></p>';
    const cls =
      "rm-research-queue-status meta rm-research-queue-status--" + (queueFlashKind || "info");
    return '<p class="' + cls + '" id="researchQueueStatus" role="status">' + escapeHtml(queueFlash) + "</p>";
  }

  function inboxComposeHtml() {
    const btnLabel = queueBusy ? "Queuing…" : "Submit";
    const btnDisabled = queueBusy ? " disabled" : "";
    return (
      '<div class="rm-research-compose">' +
      queueStatusHtml() +
      '<label class="rm-research-field">' +
      '<span class="rm-research-field-label">Your question</span>' +
      '<textarea id="researchPrompt" rows="2" placeholder="e.g. Is ZS a good buy right now?"></textarea>' +
      "</label>" +
      '<div class="rm-research-compose-row">' +
      '<label class="rm-research-field rm-research-field--symbols">' +
      '<span class="rm-research-field-label">Tickers <span class="rm-research-optional">optional</span></span>' +
      '<input type="text" id="researchSymbols" placeholder="ZS, SPY" />' +
      "</label>" +
      '<button type="button" class="btn-sm primary rm-research-queue-btn" id="btnResearchQueue"' +
      btnDisabled +
      ">" +
      btnLabel +
      "</button>" +
      "</div></div>"
    );
  }

  function researchHeroHtml(ideas, errBlock) {
    const doneN = (ideas || []).filter(function (i) {
      return i.status === "done";
    }).length;
    return (
      '<section class="rm-research-hero">' +
      '<div class="rm-research-hero-bg" aria-hidden="true">' +
      '<div class="rm-research-hero-mesh"></div>' +
      '<div class="rm-research-hero-glow"></div>' +
      '<img class="rm-research-hero-mark" src="assets/rm-story-icon.svg" alt="" decoding="async" />' +
      "</div>" +
      '<div class="rm-research-hero-body">' +
      '<div class="rm-research-hero-top">' +
      "<div>" +
      '<p class="rm-research-kicker">Concierge research</p>' +
      '<h3 class="rm-research-hero-title">Research desk</h3>' +
      '<p class="rm-research-hero-sub">Ask once — we gather sources, synthesize a report, and open it in your drawer.</p>' +
      "</div>" +
      '<div class="rm-research-sync" id="researchSyncStatus" title="Auto-syncs when you open Strategy">' +
      '<span class="rm-research-sync-dot" aria-hidden="true"></span>' +
      inboxSyncLabelHtml() +
      (doneN ? '<span class="rm-research-sync-count">' + doneN + " ready</span>" : "") +
      "</div></div>" +
      errBlock +
      inboxComposeHtml() +
      inboxQueueBarHtml(ideas) +
      "</div></section>"
    );
  }

  function renderInbox(root, ideas, loading, inboxError) {
    if (!root) return;
    const inboxRoot = root.querySelector(".rm-research-inbox") || root;
    if (loading) {
      inboxRoot.innerHTML =
        '<div class="rm-research-inbox-inner rm-research-inbox-inner--loading">' +
        '<section class="rm-research-hero rm-research-hero--loading">' +
        '<div class="rm-research-hero-body">' +
        '<p class="rm-research-kicker">Concierge research</p>' +
        '<h3 class="rm-research-hero-title">Research desk</h3>' +
        '<span class="tt-learning-tag">loading</span></div></section></div>';
      return;
    }
    const errBlock = inboxError
      ? '<p class="rm-research-queue-status rm-research-queue-status--err">' +
        escapeHtml(inboxError) +
        "</p>"
      : "";
    const reportCount = (ideas || []).length;
    inboxRoot.innerHTML =
      '<div class="rm-research-inbox-inner">' +
      researchHeroHtml(ideas, errBlock) +
      '<section class="rm-research-reports-panel">' +
      '<header class="rm-research-reports-head">' +
      '<h4 class="rm-research-reports-title">Your reports</h4>' +
      '<span class="rm-research-reports-count meta">' +
      (reportCount ? reportCount + " total" : "Waiting for first submission") +
      "</span></header>" +
      reportsAccordionHtml(ideas) +
      "</section></div>";

    inboxRoot.querySelector("#btnInboxProcess")?.addEventListener("click", async function () {
      const btn = inboxRoot.querySelector("#btnInboxProcess");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Processing…";
      }
      setQueueFlash("Running research on server…", "info");
      try {
        const out = await processNextInbox();
        if (out.skipped) {
          setQueueFlash(
            out.reason === "job_already_running"
              ? "Another job is running — we'll sync when it finishes."
              : "Nothing queued to process.",
            "warn"
          );
        } else if (out.status === "done") {
          setQueueFlash("Report ready — open it from Your reports.", "ok");
          if (out.idea_id) selectedIdeaId = out.idea_id;
        } else if (out.status === "failed") {
          setQueueFlash("Research failed — tap View below.", "err");
          if (out.idea_id) selectedIdeaId = out.idea_id;
        } else {
          setQueueFlash("Processed — refresh list.", "ok");
        }
        await refreshInbox(true);
        if (selectedIdeaId) await showDetail(selectedIdeaId);
      } catch (e) {
        setQueueFlash(queueErrorMessage(e, e.status), "err");
        await refreshInbox(true);
      }
    });
    inboxRoot.querySelector("#btnResearchQueue")?.addEventListener("click", function () {
      void submitQueue();
    });
    inboxRoot.querySelectorAll(".rm-research-open").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        const id = btn.getAttribute("data-idea-id");
        selectedIdeaId = id;
        void showDetail(id);
      });
    });
    inboxRoot.querySelectorAll(".rm-research-delete").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute("data-idea-id");
        void handleDeleteIdea(id);
      });
    });
  }

  function bindAttachHandlers(root, ideaId) {
    const btn = root.querySelector("#btnResearchAttach");
    if (!btn || !ideaId) return;
    btn.addEventListener("click", async function () {
      const text = root.querySelector("#researchAttachText")?.value?.trim();
      const file = root.querySelector("#researchAttachFile")?.files?.[0];
      if (text) {
        await attachToIdea(ideaId, { text: text, title: "User paste" });
      }
      if (file) {
        await uploadToIdea(ideaId, file, file.name);
      }
      await showDetail(ideaId);
    });
  }

  function setQueueFlash(message, kind) {
    queueFlash = message || "";
    queueFlashKind = kind || "info";
  }

  async function submitQueue() {
    const panel = document.getElementById("ttResearchPanel");
    const inboxRoot = panel?.querySelector(".rm-research-inbox");
    const prompt = inboxRoot?.querySelector("#researchPrompt")?.value?.trim();
    if (!prompt) {
      setQueueFlash("Enter a research prompt first.", "warn");
      renderInbox(panel, inboxIdeas, false, null);
      return;
    }
    if (needsLogin()) {
      setQueueFlash("Not signed in — refresh the page to sign in first.", "err");
      renderInbox(panel, inboxIdeas, false, null);
      return;
    }
    const symRaw = inboxRoot?.querySelector("#researchSymbols")?.value || "";
    const symbols = symRaw
      .split(/[,\s]+/)
      .map(function (s) {
        return s.trim().toUpperCase();
      })
      .filter(Boolean);
    queueBusy = true;
    setQueueFlash("Queuing on server…", "info");
    renderInbox(panel, inboxIdeas, false, null);
    try {
      const data = await queueIdea({
        prompt: prompt,
        symbols: symbols,
        tags: ["inbox"],
        continuity: false,
        parent_id: selectedIdeaId || undefined,
      });
      selectedIdeaId = data.id;
      const ahead = data.queued_ahead != null ? Number(data.queued_ahead) : 0;
      const sid = data.short_id || (data.id || "").slice(0, 8);
      setQueueFlash(
        "Queued #" +
          sid +
          (ahead > 0 ? " — " + ahead + " ahead in line." : " — next up.") +
          " Cron runs every ~15 min.",
        "ok"
      );
      if (inboxRoot?.querySelector("#researchPrompt")) inboxRoot.querySelector("#researchPrompt").value = "";
      await refreshInbox(true);
      document
        .getElementById("ttResearchPanel")
        ?.querySelector('.rm-research-acc[data-idea-id="' + selectedIdeaId + '"]')
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      setQueueFlash(queueErrorMessage(e, e.status), "err");
      console.warn("research queue", e);
    } finally {
      queueBusy = false;
      renderInbox(panel, inboxIdeas, false, null);
    }
  }

  async function showDetail(id) {
    if (!id) return;
    selectedIdeaId = id;
    const detail = await fetchIdeaDetail(id);
    openResearchDrawer(detail);
  }

  async function refreshInbox(force) {
    const panel = document.getElementById("ttResearchPanel");
    if (!panel) return;
    renderInbox(panel, [], true, null);
    const result = await fetchInbox(force);
    const ideas = result.ideas || [];
    inboxIdeas = ideas;
    lastInboxSyncAt = Date.now();
    syncInboxPoll(ideas);
    renderInbox(
      panel,
      ideas,
      false,
      result.error ? queueErrorMessage({ message: result.error }, null) : null
    );
    if (selectedIdeaId && /[?&]research=/.test(location.search) && !researchDeepLinkOpened) {
      researchDeepLinkOpened = true;
      await showDetail(selectedIdeaId);
    }
    const wfSlot = panel.querySelector(".rm-research-wf-slot");
    if (wfSlot && panel._wfData) {
      renderWalkForward(wfSlot, panel._wfData, false, panel._wfEntryRule);
    }
  }

  async function queueFromChartScan(scan, analysis) {
    const sym = scan?.symbol || "SPY";
    const prompt =
      "Explain price action in " +
      sym +
      " from chart scan region (" +
      new Date(scan.tMin).toLocaleTimeString() +
      "–" +
      new Date(scan.tMax).toLocaleTimeString() +
      ")";
    return queueIdea({
      prompt: prompt,
      symbols: [sym],
      tags: ["chart_scan"],
      context: {
        tMin: scan.tMin,
        tMax: scan.tMax,
        confidence: scan.confidence || analysis?.confidenceLevel,
        technicals: analysis?.technicals,
        catalyst: analysis?.catalyst,
      },
    });
  }

  function activeEntryRule() {
    try {
      if (global.RMStrategies && global.RMStrategies.getActive) {
        return global.RMStrategies.getActive().entryRule || "orh";
      }
    } catch (e) {}
    return "orh";
  }

  function entryRuleLabel(rule) {
    if (rule === "vwap") return "VWAP reclaim";
    return "ORH";
  }

  function walkForwardSymbols() {
    const syms = BASE_SYMBOLS.slice();
    try {
      const picks =
        typeof global.getMorningSession === "function"
          ? global.getMorningSession()?.picks
          : null;
      const first = picks?.[0]?.symbol;
      if (first) {
        const key = String(first).toUpperCase();
        if (!syms.includes(key)) syms.push(key);
      }
    } catch (e) {}
    return syms;
  }

  function fmtR(v) {
    if (v == null || Number.isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "R";
  }

  function loadCache() {
    try {
      return JSON.parse(global.sessionStorage.getItem(CACHE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function saveCache(data) {
    try {
      global.sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  async function walkForward(symbol, entryRule) {
    const base = apiBase();
    if (!base) return { symbol, error: "no_api" };
    const res = await fetch(base + "/backtest/walk-forward", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        symbol,
        entryRule: entryRule || "orh",
        range: "1mo",
        interval: "5m",
        source: "auto",
      }),
    });
    if (!res.ok) {
      return { symbol, error: "http_" + res.status };
    }
    return await res.json();
  }

  async function fetchExpectancy() {
    const base = apiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + "/trade/expectancy", { headers: authHeaders() });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function cardHtml(wf, entryRule) {
    if (wf.error) {
      return (
        '<article class="rm-research-card rm-research-card--err">' +
        "<h4>" +
        wf.symbol +
        '</h4><p class="meta">' +
        wf.error +
        "</p></article>"
      );
    }
    const is = wf.inSample || {};
    const oos = wf.outSample || {};
    const gap = wf.overfitGap;
    const gapWarn = gap != null && gap > 0.5;
    const oosN = oos.n || 0;
    const beats = oos.avgR != null && oos.avgR > 0;
    const ruleLabel = entryRuleLabel(entryRule || wf.entryRule);
    return (
      '<article class="rm-research-card' +
      (gapWarn ? " rm-research-card--warn" : "") +
      '">' +
      "<header><h4>" +
      wf.symbol +
      '</h4><span class="rm-research-rr">' +
      ruleLabel +
      " · best R:R " +
      (wf.bestRr != null ? wf.bestRr : "—") +
      ":1</span></header>" +
      '<div class="rm-research-grid">' +
      '<div><span class="rm-research-k">In-sample</span><strong>' +
      fmtR(is.avgR) +
      "</strong><span class=\"meta\">" +
      (is.n || 0) +
      " days · " +
      (is.winRate != null ? is.winRate + "% win" : "") +
      "</span></div>" +
      '<div><span class="rm-research-k">Out-of-sample</span><strong class="' +
      (beats ? "is-good" : "is-weak") +
      '">' +
      fmtR(oos.avgR) +
      "</strong><span class=\"meta\">" +
      oosN +
      " days · " +
      (oos.winRate != null ? oos.winRate + "% win" : "") +
      "</span></div>" +
      '<div><span class="rm-research-k">Overfit gap</span><strong>' +
      (gap != null ? gap.toFixed(2) + "R" : "—") +
      "</strong>" +
      (gapWarn ? '<span class="rm-research-flag">high · treat in-sample with caution</span>' : "") +
      "</div></div>" +
      '<p class="meta rm-research-src">Bars: ' +
      (typeof RMSchwabData !== "undefined"
        ? RMSchwabData.formatBarsSource(wf.source || "yahoo")
        : wf.source || "yahoo") +
      " · " +
      (wf.inSampleDays || 0) +
      "+" +
      (wf.outSampleDays || 0) +
      " trading days</p></article>"
    );
  }

  function renderWalkForward(root, data, loading, entryRule) {
    if (!root) return;
    const rule = entryRule || data?.entryRule || activeEntryRule();
    if (!apiBase()) {
      root.innerHTML =
        '<div class="tt-learning-head"><h3>Walk-forward</h3></div>' +
        '<p class="meta">Set <code>rainmaker-api-base</code> to load walk-forward backtests.</p>';
      return;
    }
    if (loading) {
      root.innerHTML =
        '<div class="tt-learning-head"><h3>Walk-forward</h3><span class="tt-learning-tag">loading</span></div>' +
        '<p class="meta">SPY, QQQ' +
        (walkForwardSymbols().length > 2 ? ", + session pick" : "") +
        " (1mo, 5m, " +
        entryRuleLabel(rule) +
        ")…</p>";
      return;
    }
    const cards = (data.walkForward || []).map(function (wf) {
      return cardHtml(wf, rule);
    }).join("");
    const exp = data.expectancy;
    let liveBlock = "";
    if (exp && exp.ok) {
      const e = exp.expectancy || {};
      liveBlock =
        '<div class="rm-research-live">' +
        "<h4>Your realized trades (server store)</h4>" +
        "<p><strong>$" +
        (exp.realizedPnl != null ? Number(exp.realizedPnl).toFixed(0) : "—") +
        "</strong> realized · " +
        (exp.roundTrips || 0) +
        " round trips · win " +
        (e.winRate != null ? e.winRate + "% win" : "—") +
        " · avg R " +
        fmtR(e.avgR) +
        "</p>" +
        '<p class="meta">' +
        (exp.note || "") +
        " Sync Schwab fills in Account → Schwab.</p></div>";
    }
    const updated =
      data && data.at
        ? Math.max(0, Math.floor((Date.now() - data.at) / 60000))
        : null;
    const freshMeta =
      updated == null
        ? "Auto-updates when you open Strategy"
        : updated < 1
          ? "Updated just now"
          : "Updated " + updated + "m ago";
    root.innerHTML =
      '<section class="rm-research-wf">' +
      '<header class="rm-research-wf-head">' +
      "<div>" +
      '<p class="rm-research-kicker">Validation</p>' +
      "<h3>Walk-forward</h3>" +
      '<p class="meta">In/out sample on SPY/QQQ · ' +
      entryRuleLabel(rule) +
      ".</p></div>" +
      '<span class="rm-research-wf-meta meta">' +
      escapeHtml(freshMeta) +
      "</span></header>" +
      '<div class="rm-research-cards">' +
      cards +
      "</div>" +
      liveBlock +
      "</section>";
  }

  function ensurePanelStructure(panel) {
    if (!panel) return;
    panel.classList.add("rm-research-shell");
    if (!panel.querySelector(".rm-research-inbox")) {
      panel.innerHTML =
        '<div class="rm-research-inbox"></div><div class="rm-research-wf-slot"></div>';
    }
  }

  function renderPanel(root, data, loading, entryRule) {
    if (!root) return;
    const isMainInbox = root.id === "ttResearchPanel";
    if (isMainInbox) {
      ensurePanelStructure(root);
      const inboxEl = root.querySelector(".rm-research-inbox");
      const wfEl = root.querySelector(".rm-research-wf-slot");
      root._wfData = data;
      root._wfEntryRule = entryRule;
      if (inboxEl && !inboxEl.dataset.mounted) {
        inboxEl.dataset.mounted = "1";
        void refreshInbox(false);
      }
      renderWalkForward(wfEl, data, loading, entryRule);
      return;
    }
    root._wfData = data;
    root._wfEntryRule = entryRule;
    renderWalkForward(root, data, loading, entryRule);
  }

  async function run(force) {
    const panel = document.getElementById("ttResearchPanel");
    const stratSlot = document.getElementById("ttResearchStrategySlot");
    const entryRule = activeEntryRule();
    ensurePanelStructure(panel);
    if (!force) {
      const cached = loadCache();
      if (cached && cached.at && Date.now() - cached.at < 3600000 && cached.entryRule === entryRule) {
        renderPanel(panel, cached, false, entryRule);
        if (stratSlot) renderPanel(stratSlot, cached, false, entryRule);
        return;
      }
    }
    renderPanel(panel, null, true, entryRule);
    if (stratSlot) renderPanel(stratSlot, null, true, entryRule);
    const walkForwardResults = [];
    for (const sym of walkForwardSymbols()) {
      try {
        walkForwardResults.push(await walkForward(sym, entryRule));
      } catch (e) {
        walkForwardResults.push({ symbol: sym, error: String(e.message || e) });
      }
    }
    const expectancy = await fetchExpectancy();
    const payload = {
      at: Date.now(),
      entryRule,
      walkForward: walkForwardResults,
      expectancy,
    };
    saveCache(payload);
    renderPanel(panel, payload, false, entryRule);
    if (stratSlot) renderPanel(stratSlot, payload, false, entryRule);
  }

  function mountStrategySlot() {
    const board = document.getElementById("pickListStrategy");
    if (!board || document.getElementById("ttResearchStrategySlot")) return;
    const slot = document.createElement("section");
    slot.id = "ttResearchStrategySlot";
    slot.className = "tt-learning-panel rm-research-strategy-slot";
    board.appendChild(slot);
  }

  function init() {
    parseResearchDeepLink();
    const panel = document.getElementById("ttResearchPanel");
    if (panel) run(false);
    document.addEventListener("rm:auth-ready", function () {
      void refreshInbox(true);
    });
    document.addEventListener("rm:research-digest", function () {
      void refreshInbox(true);
    });
    document.addEventListener("rm:strategy-tab-shown", function () {
      ensurePanelStructure(panel);
      void refreshInbox(true);
      run(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.RMResearch = {
    run,
    walkForward,
    fetchExpectancy,
    renderPanel,
    activeEntryRule,
    walkForwardSymbols,
    queueIdea,
    queueFromChartScan,
    refreshInbox,
    fetchInbox,
  };
})(typeof window !== "undefined" ? window : this);
