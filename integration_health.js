/** Account drawer integration health: API / Schwab / SMS. */
(function (global) {
  "use strict";

  const PROD_API = "https://rainmaker-api-waqs.onrender.com";

  function apiBase() {
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveBrokerApiBase) {
      return global.RMMorningApi.resolveBrokerApiBase();
    }
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
      const stored = global.localStorage?.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (_) {}
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return PROD_API;
    if (/\.github\.io$/i.test(h)) return PROD_API;
    return PROD_API;
  }

  function authHeaders() {
    const h = { "Content-Type": "application/json" };
    try {
      if (global.RMAuthGate?.authHeaders) Object.assign(h, global.RMAuthGate.authHeaders() || {});
    } catch (_) {}
    return h;
  }

  function chip(label, state, detail) {
    const cls =
      state === "ok" ? "rm-health--ok" : state === "warn" ? "rm-health--warn" : "rm-health--err";
    return (
      '<span class="rm-health-chip ' +
      cls +
      '" title="' +
      String(detail || "").replace(/"/g, "&quot;") +
      '"><span class="rm-health-dot"></span>' +
      label +
      "</span>"
    );
  }

  async function probe() {
    const base = apiBase();
    const out = {
      api: { state: "err", detail: "No API" },
      schwab: { state: "warn", detail: "" },
      sms: { state: "warn", detail: "" },
    };
    if (!base) return out;

    try {
      const res = await fetch(base + "/health", { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      out.api = res.ok
        ? { state: "ok", detail: "API online" }
        : { state: "err", detail: "Health " + res.status };
      if (data.schwabConfigured === false) {
        out.schwab = { state: "warn", detail: "Schwab keys not set on Render" };
      }
      if (data.notifyConfigured === false) {
        out.sms = { state: "warn", detail: "Twilio not configured" };
      }
    } catch (e) {
      out.api = { state: "err", detail: e?.message || "Unreachable" };
    }

    try {
      const res = await fetch(base + "/schwab/status", { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!data.configured) {
        out.schwab = { state: "warn", detail: "Register Schwab app + set env on Render" };
      } else if (data.connected) {
        const fills = data.fillCount ? " - " + data.fillCount + " fills" : "";
        out.schwab = { state: "ok", detail: "Connected" + fills };
      } else {
        out.schwab = { state: "warn", detail: "Configured - tap Connect Schwab" };
      }
    } catch (e) {
      if (out.schwab.state !== "warn") out.schwab = { state: "err", detail: e?.message || "Status failed" };
    }

    try {
      const res = await fetch(base + "/notify/status", { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!data.twilioConfigured) {
        out.sms = { state: "warn", detail: "Set RM_TWILIO_* on Render" };
      } else if (!data.publicUrlConfigured) {
        out.sms = { state: "warn", detail: "Set RM_API_PUBLIC_URL for MMS" };
      } else {
        out.sms = { state: "ok", detail: "SMS + MMS ready" };
      }
    } catch (e) {
      out.sms = { state: "warn", detail: e?.message || "Notify status failed" };
    }

    return out;
  }

  function render(probeResult) {
    const el = document.getElementById("integrationHealth");
    if (!el || !probeResult) return;
    el.innerHTML =
      chip("API", probeResult.api.state, probeResult.api.detail) +
      chip("Schwab", probeResult.schwab.state, probeResult.schwab.detail) +
      chip("SMS", probeResult.sms.state, probeResult.sms.detail);
  }

  async function refresh() {
    const el = document.getElementById("integrationHealth");
    if (el) el.innerHTML = '<span class="meta">Checking integrations...</span>';
    try {
      render(await probe());
    } catch (_) {
      if (el) el.innerHTML = chip("API", "err", "Probe failed");
    }
  }

  function wire() {
    document.addEventListener("rm:auth-ready", function () {
      void refresh();
    });
    document.addEventListener("rm:schwab-synced", function () {
      void refresh();
    });
    const drawer = document.getElementById("orderDrawer");
    if (drawer && !drawer.dataset.healthWired) {
      drawer.dataset.healthWired = "1";
      drawer.addEventListener("transitionend", function () {
        if (drawer.classList.contains("open")) void refresh();
      });
      const btn = document.getElementById("btnAccount");
      btn?.addEventListener("click", function () {
        setTimeout(function () {
          void refresh();
        }, 120);
      });
    }
  }

  wire();
  global.RMIntegrationHealth = { probe, refresh, render };
})(typeof window !== "undefined" ? window : globalThis);
