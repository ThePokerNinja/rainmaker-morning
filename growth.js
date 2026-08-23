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
