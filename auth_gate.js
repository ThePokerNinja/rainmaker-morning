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
