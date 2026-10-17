/* Schwab broker connection client (Schwab roadmap Phase A+).
 * Read-only: connect via OAuth popup, show status, sync fills, list positions,
 * balances, optional market-hours poll. Talks only to rm_api. */
(function (global) {
  "use strict";

  const POLL_KEY = "rainmaker_schwab_poll_v1";
  const POLL_MS = 60000;
  let pollTimer = null;
  let lastKnownFillCount = null;
  let brokerApiBase = null;

  async function ensureApiBase() {
    if (brokerApiBase) return brokerApiBase;
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.probeBrokerApiBase) {
      brokerApiBase = await global.RMMorningApi.probeBrokerApiBase();
    } else {
      const h = (typeof location !== "undefined" && location.hostname) || "";
      brokerApiBase =
        h === "localhost" || h === "127.0.0.1"
          ? "https://rainmaker-api-waqs.onrender.com"
          : "";
    }
    return brokerApiBase;
  }

  function apiBase() {
    if (brokerApiBase) return brokerApiBase;
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveBrokerApiBase) {
      return global.RMMorningApi.resolveBrokerApiBase();
    }
    return "";
  }

  function brokerApiLabel() {
    const base = apiBase();
    if (!base) return "";
    if (base.indexOf("127.0.0.1") >= 0 || base.indexOf("localhost") >= 0) return "local API";
    return "Rainmaker cloud";
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (typeof global.RMAuthGate !== "undefined" && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (e) {}
    return headers;
  }

  function hasSession() {
    try {
      return !!(global.RMAuthGate?.getToken?.() && global.RMAuthGate.getToken());
    } catch (e) {
      return false;
    }
  }

  function promptSignIn() {
    const statusEl = el("schwabStatus");
    if (statusEl) {
      statusEl.textContent = "Session expired — refresh the page to sign in.";
    }
  }

  async function getStatus() {
    const base = await ensureApiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + "/schwab/status", { headers: authHeaders() });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function connect() {
    if (!hasSession()) {
      promptSignIn();
      const statusEl = el("schwabStatus");
      if (statusEl) {
        statusEl.textContent = "Sign in first, then connect Schwab.";
      }
      return;
    }
    const base = await ensureApiBase();
    if (!base) return;
    try {
      const res = await fetch(base + "/schwab/authorize-url", { headers: authHeaders() });
      if (!res.ok) {
        const statusEl = el("schwabStatus");
        if (statusEl) {
          statusEl.textContent =
            res.status === 401
              ? "Sign in first, then connect Schwab."
              : "Could not start Schwab login (" + res.status + ").";
        }
        if (res.status === 401) promptSignIn();
        return;
      }
      const body = await res.json();
      if (!body || !body.url) return;
      const w = global.open(body.url, "schwab_oauth", "width=520,height=720");
      const timer = global.setInterval(function () {
        if (w && w.closed) {
          global.clearInterval(timer);
          render().then(function () {
            return autoSyncIfConnected();
          });
        }
      }, 1200);
    } catch (e) {
      const statusEl = el("schwabStatus");
      if (statusEl) statusEl.textContent = "Server unreachable.";
    }
  }

  async function sync(days) {
    const base = await ensureApiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + "/schwab/sync?days=" + (days || 90), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) return null;
      const body = await res.json();
      if (body && typeof global.RMSchwabData !== "undefined") {
        await global.RMSchwabData.onSyncComplete(body);
      }
      if (typeof global.RMResearch !== "undefined" && global.RMResearch.run) {
        global.RMResearch.run(true);
      }
      return body;
    } catch (e) {
      return null;
    }
  }

  async function positions() {
    const base = await ensureApiBase();
    if (!base) return [];
    try {
      const res = await fetch(base + "/schwab/positions", { headers: authHeaders() });
      if (!res.ok) return [];
      const body = await res.json();
      return (body && body.positions) || [];
    } catch (e) {
      return [];
    }
  }

  async function balances() {
    const base = await ensureApiBase();
    if (!base) return [];
    try {
      const res = await fetch(base + "/schwab/balances", { headers: authHeaders() });
      if (!res.ok) return [];
      const body = await res.json();
      return (body && body.balances) || [];
    } catch (e) {
      return [];
    }
  }

  async function disconnect() {
    const base = await ensureApiBase();
    if (!base) return;
    try {
      await fetch(base + "/schwab/disconnect", { method: "POST", headers: authHeaders() });
    } catch (e) {}
    stopPoll();
    render();
  }

  function el(id) {
    return document.getElementById(id);
  }

  function isPollEnabled() {
    try {
      return global.localStorage.getItem(POLL_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setPollEnabled(on) {
    try {
      global.localStorage.setItem(POLL_KEY, on ? "1" : "0");
    } catch (e) {}
    if (on) startPoll();
    else stopPoll();
  }

  function isMarketHoursEt() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find(function (p) {
      return p.type === "weekday";
    });
    if (weekday && (weekday.value === "Sat" || weekday.value === "Sun")) return false;
    const hour = Number(parts.find(function (p) {
      return p.type === "hour";
    })?.value || 0);
    const minute = Number(parts.find(function (p) {
      return p.type === "minute";
    })?.value || 0);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  }

  function notifyNewFill(count) {
    const msg = count === 1 ? "New Schwab fill synced" : count + " new Schwab fills synced";
    if (typeof global.rmStatus === "function") {
      global.rmStatus(msg);
    } else {
      document.dispatchEvent(new CustomEvent("rm:toast", { detail: { message: msg } }));
    }
  }

  function shouldPollRun() {
    if (!isPollEnabled()) return false;
    if (document.visibilityState === "hidden") return false;
    if (typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()) {
      const key = global.RMWorkspaceAccordion?.getActiveKey?.();
      if (key !== "scans") return false;
    }
    return true;
  }

  function syncPollState() {
    if (shouldPollRun()) startPoll();
    else stopPoll();
  }

  function startPoll() {
    if (pollTimer || !shouldPollRun()) return;
    pollTimer = global.setInterval(async function () {
      if (!isMarketHoursEt()) return;
      const status = await getStatus();
      if (!status || !status.connected || status.needsReconnect) return;
      const before = lastKnownFillCount;
      const r = await sync(7);
      if (r && r.inserted > 0) {
        notifyNewFill(r.inserted);
      }
      if (before != null && r && r.fills > before && !(r.inserted > 0)) {
        /* fills grew without insert count — still refresh UI */
      }
      if (r) lastKnownFillCount = r.fills;
    }, POLL_MS);
  }

  function stopPoll() {
    if (pollTimer) {
      global.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function autoSyncIfConnected() {
    const status = await getStatus();
    if (!status || !status.connected || status.needsReconnect) return null;
    return sync(90);
  }

  function renderBalances(list) {
    const wrap = el("schwabBalances");
    if (!wrap) return;
    if (!list || !list.length) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = list
      .map(function (b) {
        const bp = b.buyingPower != null ? "$" + Number(b.buyingPower).toFixed(0) : "—";
        const cash = b.cashBalance != null ? "$" + Number(b.cashBalance).toFixed(0) : "—";
        const acct = b.account ? " …" + String(b.account).slice(-4) : "";
        return (
          '<div class="rm-schwab-bal">' +
          "<span>Buying power" +
          acct +
          "</span><strong>" +
          bp +
          "</strong>" +
          '<span class="meta">Cash ' +
          cash +
          "</span></div>"
        );
      })
      .join("");
  }

  function renderLastSync(status) {
    const syncEl = el("schwabLastSync");
    if (!syncEl) return;
    let line =
      typeof global.RMSchwabData !== "undefined" ? global.RMSchwabData.formatSyncMeta() : "";
    if (status && status.fillCount != null) {
      line = (line ? line + " · " : "") + status.fillCount + " fill(s) on server";
    }
    syncEl.textContent = line || "";
  }

  function publishSchwabState(status) {
    const connected = !!(status?.connected && !status?.needsReconnect);
    if (typeof global.RMResultsHero !== "undefined" && global.RMResultsHero.updateSchwabStatus) {
      global.RMResultsHero.updateSchwabStatus(connected);
    }
    return connected;
  }

  async function bootstrapDashboard() {
    await ensureApiBase();
    if (!apiBase()) return null;
    const status = await getStatus();
    if (!status) {
      publishSchwabState(null);
      return null;
    }
    const connected = publishSchwabState(status);
    if (!connected) return status;
    const pos = await positions();
    const cached =
      typeof global.RMHoldings !== "undefined" && global.RMHoldings.getBrokerPositions
        ? global.RMHoldings.getBrokerPositions()
        : [];
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.setBrokerPositions) {
      if (pos.length || !cached.length) {
        global.RMHoldings.setBrokerPositions(pos);
      }
    }
    document.dispatchEvent(new CustomEvent("rm:schwab-positions", { detail: { positions: pos } }));
    return status;
  }

  async function render() {
    const section = el("drawerSchwab");
    if (!section) return;
    section.hidden = false;
    const statusEl = el("schwabStatus");
    const connectBtn = el("schwabConnect");
    const syncBtn = el("schwabSync");
    const disconnectBtn = el("schwabDisconnect");
    const posWrap = el("schwabPositions");
    const pollCb = el("schwabPoll");
    if (pollCb) pollCb.checked = isPollEnabled();

    await ensureApiBase();
    if (!apiBase()) {
      if (statusEl) {
        statusEl.textContent = "Broker API unreachable.";
      }
      if (connectBtn) connectBtn.disabled = true;
      return;
    }

    if (!hasSession()) {
      publishSchwabState(null);
      if (statusEl) {
        statusEl.textContent = "Not signed in — refresh the page to sign in.";
      }
      if (connectBtn) {
        connectBtn.hidden = false;
        connectBtn.disabled = true;
        connectBtn.textContent = "Connect Schwab";
      }
      if (syncBtn) syncBtn.hidden = true;
      if (disconnectBtn) disconnectBtn.hidden = true;
      if (posWrap) posWrap.innerHTML = '<p class="meta">Refresh to sign in, then connect Schwab.</p>';
      renderBalances([]);
      renderLastSync(null);
      stopPoll();
      return;
    }

    const status = await getStatus();
    if (!status) {
      publishSchwabState(null);
      if (statusEl) statusEl.textContent = "Server unreachable (" + brokerApiLabel() + ").";
      if (connectBtn) connectBtn.disabled = true;
      return;
    }
    if (!status.configured) {
      if (statusEl) {
        statusEl.textContent =
          "Schwab keys missing on this API host. Local review uses Rainmaker cloud — refresh the page.";
      }
      if (connectBtn) connectBtn.disabled = true;
      return;
    }
    const cloudHint =
      brokerApiLabel() === "Rainmaker cloud" ? " · via Rainmaker cloud" : "";
    if (status.needsReconnect || !status.connected) {
      publishSchwabState(status);
      if (statusEl) {
        statusEl.textContent =
          (status.connected ? "Reconnect required." : "Not connected.") + cloudHint;
      }
      if (connectBtn) {
        connectBtn.hidden = false;
        connectBtn.disabled = false;
        connectBtn.textContent = status.connected ? "Reconnect Schwab" : "Connect Schwab";
      }
      if (syncBtn) syncBtn.hidden = true;
      if (disconnectBtn) disconnectBtn.hidden = !status.connected;
      if (posWrap) posWrap.innerHTML = "";
      renderBalances([]);
      renderLastSync(status);
      stopPoll();
      return;
    }
    publishSchwabState(status);
    if (statusEl) {
      statusEl.textContent =
        "Connected" +
        (status.accessTokenValid ? "" : " (refreshing)") +
        cloudHint +
        ".";
    }
    if (connectBtn) connectBtn.hidden = true;
    if (syncBtn) syncBtn.hidden = false;
    if (disconnectBtn) disconnectBtn.hidden = false;
    lastKnownFillCount = status.fillCount != null ? status.fillCount : lastKnownFillCount;

    const pos = await positions();
    const cached =
      typeof global.RMHoldings !== "undefined" && global.RMHoldings.getBrokerPositions
        ? global.RMHoldings.getBrokerPositions()
        : [];
    const displayPos = pos.length ? pos : cached;
    renderPositions(displayPos);
    renderBalances(await balances());
    renderLastSync(status);

    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.setBrokerPositions) {
      if (pos.length || !cached.length) {
        global.RMHoldings.setBrokerPositions(pos);
      }
    }
    if (typeof global.renderDrawerHoldings === "function") {
      global.renderDrawerHoldings();
    }
    document.dispatchEvent(new CustomEvent("rm:schwab-positions", { detail: { positions: pos } }));

    if (isPollEnabled()) startPoll();
  }

  function renderPositions(list) {
    const posWrap = el("schwabPositions");
    if (!posWrap) return;
    if (!list || !list.length) {
      posWrap.innerHTML = '<p class="meta">No open positions.</p>';
      return;
    }
    const rows = list
      .filter(function (p) {
        return p.symbol && Math.abs(Number(p.qty) || 0) > 0;
      })
      .map(function (p) {
        const qty = Number(p.qty) || 0;
        const avg = p.avgPrice != null ? " @ $" + Number(p.avgPrice).toFixed(2) : "";
        const mv = p.marketValue != null ? " · $" + Number(p.marketValue).toFixed(0) : "";
        const symEsc = String(p.symbol).replace(/"/g, "&quot;");
        return (
          '<button type="button" class="rm-schwab-pos rm-schwab-pos--click" data-schwab-symbol="' +
          symEsc +
          '" title="View on chart">' +
          "<span>" +
          p.symbol +
          avg +
          "</span><span>" +
          qty +
          " sh" +
          mv +
          "</span></button>"
        );
      })
      .join("");
    posWrap.innerHTML = rows || '<p class="meta">No open positions.</p>';
    let posClickBusy = false;
    posWrap.querySelectorAll(".rm-schwab-pos--click").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (posClickBusy) return;
        const sym = btn.getAttribute("data-schwab-symbol");
        if (!sym) return;
        posClickBusy = true;
        const holdings = global.RMHoldings?.getDisplayOpen?.() || [];
        const h =
          holdings.find(function (row) {
            return String(row.symbol).toUpperCase() === String(sym).toUpperCase();
          }) || null;
        const done = function () {
          setTimeout(function () {
            posClickBusy = false;
          }, 700);
        };
        if (h && typeof global.openHoldingOnChart === "function") {
          Promise.resolve(global.openHoldingOnChart(h)).finally(done);
        } else if (typeof global.selectTicker === "function") {
          global.selectTicker(sym, { snapChart: true, openDrawer: false });
          done();
        } else {
          done();
        }
      });
    });
  }

  function wire() {
    const connectBtn = el("schwabConnect");
    const syncBtn = el("schwabSync");
    const disconnectBtn = el("schwabDisconnect");
    const pollCb = el("schwabPoll");
    if (connectBtn) connectBtn.addEventListener("click", connect);
    if (syncBtn) {
      syncBtn.addEventListener("click", async function () {
        syncBtn.disabled = true;
        const r = await sync(90);
        syncBtn.disabled = false;
        const statusEl = el("schwabStatus");
        if (statusEl && r) {
          statusEl.textContent = "Synced " + (r.inserted || 0) + " new fill(s).";
        }
        await render();
      });
    }
    if (disconnectBtn) disconnectBtn.addEventListener("click", disconnect);
    if (pollCb) {
      pollCb.addEventListener("change", function () {
        setPollEnabled(pollCb.checked);
      });
    }
    document.addEventListener("rm:workspace-row", syncPollState);
    document.addEventListener("visibilitychange", syncPollState);
    document.addEventListener("rm:schwab-synced", function () {
      if (typeof global.renderResultsClosedTrades === "function") {
        global.renderResultsClosedTrades();
      }
      renderLastSync();
    });
    ensureApiBase()
      .then(function () {
        return render();
      })
      .then(function () {
        return autoSyncIfConnected();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  global.RMSchwab = {
    getStatus: getStatus,
    connect: connect,
    sync: sync,
    positions: positions,
    balances: balances,
    disconnect: disconnect,
    render: render,
    bootstrapDashboard: bootstrapDashboard,
    autoSyncIfConnected: autoSyncIfConnected,
    syncPollState: syncPollState,
    get _pollTimer() {
      return pollTimer;
    },
  };
})(typeof window !== "undefined" ? window : this);
