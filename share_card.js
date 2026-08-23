/**
 * Share card - one-tap export of the morning verdict + key levels as a PNG.
 *
 * Pure client-side: snapshots the current Conviction Engine verdict, the Morning
 * Pulse bias, and either the active trade plan levels or an index snapshot, then
 * renders a 1080x1350 card on a canvas. Uses the Web Share API (file share) on
 * capable devices and falls back to a download. No backend required.
 */
(function (global) {
  const W = 1080;
  const H = 1350;
  const PAD = 84;
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  const C = {
    bg0: "#0a0f15",
    panel: "rgba(255,255,255,0.04)",
    panelBorder: "rgba(255,255,255,0.10)",
    text: "#e8edf4",
    muted: "#8896ad",
    faint: "#5d6b81",
    teal: "#4eb8c9",
    orange: "#e8954f",
    green: "#3dba7a",
    red: "#e2574e",
    core: "#e8edf4",
  };

  let logoImg = null;
  let logoTried = false;

  function preloadLogo() {
    if (logoTried) return logoImg;
    logoTried = true;
    try {
      const im = new Image();
      im.onload = () => {
        logoImg = im;
      };
      im.src = "assets/rainmaker-header.png?v=37";
    } catch (_) {
      /* ignore */
    }
    return logoImg;
  }

  /* ---------- data collection ---------- */

  function textOf(sel, root) {
    const el = (root || document).querySelector(sel);
    return el ? (el.textContent || "").trim() : "";
  }

  function readVerdict() {
    const kicker = textOf("#headerMoodCopy .hm-kicker") || "Undecided";
    const line =
      textOf("#headerMoodCopy .hm-line") ||
      "Mixed signals. The tape hasn't picked a side yet.";
    let heat = 0;
    try {
      const st = global.RMHeaderMood?.getState?.();
      if (st && Number.isFinite(st.heat)) heat = st.heat;
    } catch (_) {
      /* ignore */
    }
    return { kicker, line, heat };
  }

  function readBias() {
    try {
      return global.RMMarket?.currentBiasSnapshot?.() || null;
    } catch (_) {
      return null;
    }
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function readIndices() {
    const out = [];
    const want = ["SPY", "QQQ", "VIX"];
    let cached = null;
    try {
      cached = global.RMMarket?.getCachedIndices?.() || null;
    } catch (_) {
      cached = null;
    }
    if (cached) {
      for (const sym of want) {
        const q = cached[sym] || cached["^" + sym] || cached[sym.replace("^", "")];
        const price = num(q?.price);
        if (price == null) continue;
        out.push({ sym, price, chg: num(q?.chg ?? q?.pct_change) });
      }
    }
    if (out.length) return out;
    // Fallback: scrape the rendered index strip so the card matches what's on screen.
    try {
      document.querySelectorAll(".fv-index").forEach((cell) => {
        const sym = (cell.querySelector(".fv-sym")?.textContent || "")
          .replace(/[^A-Za-z^]/g, "")
          .toUpperCase();
        if (!sym || !want.includes(sym.replace("^", ""))) return;
        const price = num((cell.querySelector(".fv-val")?.textContent || "").replace(/[^0-9.\-]/g, ""));
        const chg = num((cell.querySelector(".fv-chg")?.textContent || "").replace(/[^0-9.\-]/g, ""));
        if (price == null) return;
        out.push({ sym: sym.replace("^", ""), price, chg });
      });
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  function readPlan() {
    try {
      const p = global.RMAnalysisChart?.state?.tradePlan;
      if (!p || p.entry == null || p.stop == null) return null;
      return {
        symbol: String(p.symbol || "").toUpperCase(),
        entry: num(p.entry),
        stop: num(p.stop),
        target1: num(p.target1 ?? p.target),
        target2: num(p.target2),
        rr: num(p.rr),
      };
    } catch (_) {
      return null;
    }
  }

  function fmtDate(d) {
    try {
      return d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (_) {
      return "";
    }
  }

  function collectData() {
    const now = new Date();
    return {
      date: fmtDate(now),
      verdict: readVerdict(),
      bias: readBias(),
      indices: readIndices(),
      plan: readPlan(),
      logo: logoImg && logoImg.complete ? logoImg : null,
    };
  }

  /* ---------- drawing ---------- */

  function leanColor(heat) {
    if (heat > 0) return C.teal;
    if (heat < 0) return C.orange;
    return C.muted;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
    const words = String(text).split(/\s+/);
    let line = "";
    let lines = 0;
    for (let i = 0; i < words.length; i++) {
      const test = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, y);
        line = words[i];
        y += lineH;
        lines++;
        if (maxLines && lines >= maxLines - 1) {
          // last allowed line: dump remainder (trimmed)
          let rest = words.slice(i).join(" ");
          while (rest && ctx.measureText(rest + "\u2026").width > maxW) {
            rest = rest.slice(0, -1);
          }
          ctx.fillText(rest + (rest ? "\u2026" : ""), x, y);
          return y + lineH;
        }
      } else {
        line = test;
      }
    }
    if (line) {
      ctx.fillText(line, x, y);
      y += lineH;
    }
    return y;
  }

  function drawGauge(ctx, x, y, heat) {
    const slots = [-3, -2, -1, 0, 1, 2, 3];
    const gap = 26;
    const r = 11;
    let cx = x;
    for (const slot of slots) {
      const isCore = slot === 0;
      const on =
        isCore
          ? heat === 0
          : (heat > 0 && slot > 0 && slot <= heat) ||
            (heat < 0 && slot < 0 && slot >= heat);
      let col;
      if (isCore) col = on ? C.core : C.faint;
      else if (slot < 0) col = on ? C.orange : C.faint;
      else col = on ? C.teal : C.faint;
      const rad = isCore ? r + 2 : r;
      ctx.beginPath();
      ctx.arc(cx, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = on ? 1 : 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
      cx += rad * 2 + gap;
    }
  }

  function fmtPrice(n) {
    if (n == null) return "\u2014";
    return n >= 100 ? n.toFixed(2) : n.toFixed(2);
  }

  function fmtPct(n) {
    if (n == null) return "";
    const s = n >= 0 ? "+" : "";
    return s + n.toFixed(2) + "%";
  }

  function drawLevelChip(ctx, x, y, w, h, label, value, accent) {
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fill();
    ctx.strokeStyle = C.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText(label, x + 24, y + 30);
    ctx.fillStyle = accent || C.text;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillText(value, x + 24, y + 62);
  }

  function renderToCanvas(data, canvas) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const heat = data?.verdict?.heat || 0;
    const accent = leanColor(heat);

    // Background: dark base with a soft mood-tinted glow from the top.
    ctx.fillStyle = C.bg0;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, 120, 60, W / 2, 120, W);
    const tint =
      heat > 0
        ? "rgba(78,184,201,0.28)"
        : heat < 0
          ? "rgba(232,149,79,0.26)"
          : "rgba(120,140,170,0.18)";
    glow.addColorStop(0, tint);
    glow.addColorStop(1, "rgba(10,15,21,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // accent top rule
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 8);

    let y = PAD + 12;

    // Brand row
    const logo = data?.logo;
    let brandX = PAD;
    if (logo) {
      try {
        ctx.drawImage(logo, PAD, y - 4, 92, 92);
        brandX = PAD + 112;
      } catch (_) {
        brandX = PAD;
      }
    } else {
      ctx.beginPath();
      ctx.arc(PAD + 38, y + 42, 42, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.font = `800 44px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText("R", PAD + 38, y + 58);
      brandX = PAD + 112;
    }
    ctx.textAlign = "left";
    ctx.fillStyle = C.text;
    ctx.font = `800 46px ${FONT}`;
    ctx.fillText("RAINMAKER", brandX, y + 40);
    ctx.fillStyle = C.muted;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText("MORNING VERDICT", brandX, y + 76);
    // date (right)
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = `500 28px ${FONT}`;
    ctx.fillText(data?.date || "", W - PAD, y + 40);
    ctx.textAlign = "left";

    y += 200;

    // Verdict kicker (hero)
    const kicker = (data?.verdict?.kicker || "Undecided").toUpperCase();
    let kSize = 96;
    ctx.font = `800 ${kSize}px ${FONT}`;
    while (ctx.measureText(kicker).width > W - PAD * 2 && kSize > 52) {
      kSize -= 4;
      ctx.font = `800 ${kSize}px ${FONT}`;
    }
    ctx.fillStyle = accent;
    ctx.fillText(kicker, PAD, y);

    y += 56;
    drawGauge(ctx, PAD + 14, y, heat);

    y += 70;
    ctx.fillStyle = C.text;
    ctx.font = `400 40px ${FONT}`;
    y = wrapText(ctx, data?.verdict?.line || "", PAD, y, W - PAD * 2, 56, 3);

    // Divider
    y += 24;
    ctx.strokeStyle = C.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    y += 56;

    // Bias line
    const bias = data?.bias;
    if (bias && (bias.marketLabel || bias.lean)) {
      const leanWord =
        bias.lean > 0 ? "BULLISH LEAN" : bias.lean < 0 ? "BEARISH LEAN" : "NEUTRAL";
      ctx.font = `700 32px ${FONT}`;
      ctx.fillStyle = bias.lean > 0 ? C.teal : bias.lean < 0 ? C.orange : C.muted;
      ctx.fillText(leanWord, PAD, y);
      const lw = ctx.measureText(leanWord).width;
      const conf =
        (bias.marketConf ? String(bias.marketConf).toUpperCase() + " CONF" : "") +
        (bias.marketPct != null
          ? (bias.marketConf ? "  " : "") + Math.round(Math.abs(bias.marketPct)) + "%"
          : "");
      if (conf) {
        ctx.fillStyle = C.muted;
        ctx.font = `500 30px ${FONT}`;
        ctx.fillText("\u00b7  " + conf, PAD + lw + 22, y);
      }
      y += 64;
    }

    // Levels panel
    const plan = data?.plan;
    const panelX = PAD;
    const panelW = W - PAD * 2;
    if (plan && plan.symbol) {
      const panelH = 300;
      roundRect(ctx, panelX, y, panelW, panelH, 22);
      ctx.fillStyle = C.panel;
      ctx.fill();
      ctx.strokeStyle = C.panelBorder;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText("SETUP", panelX + 32, y + 48);
      ctx.fillStyle = C.text;
      ctx.font = `800 56px ${FONT}`;
      ctx.fillText(plan.symbol, panelX + 32, y + 104);
      if (plan.rr != null) {
        ctx.textAlign = "right";
        ctx.fillStyle = accent;
        ctx.font = `700 34px ${FONT}`;
        ctx.fillText(plan.rr.toFixed(1) + "R", panelX + panelW - 32, y + 96);
        ctx.textAlign = "left";
      }
      const gx = panelX + 24;
      const gy = y + 132;
      const cw = (panelW - 48 - 20) / 2;
      const rowH = 72;
      const rowGap = 14;
      drawLevelChip(ctx, gx, gy, cw, rowH, "ENTRY", "$" + fmtPrice(plan.entry), C.text);
      drawLevelChip(ctx, gx + cw + 20, gy, cw, rowH, "STOP", "$" + fmtPrice(plan.stop), C.red);
      drawLevelChip(ctx, gx, gy + rowH + rowGap, cw, rowH, "TARGET 1", "$" + fmtPrice(plan.target1), C.green);
      drawLevelChip(
        ctx,
        gx + cw + 20,
        gy + rowH + rowGap,
        cw,
        rowH,
        "TARGET 2",
        plan.target2 != null ? "$" + fmtPrice(plan.target2) : "\u2014",
        C.green
      );
      y += panelH;
    } else {
      const idx = data?.indices || [];
      if (idx.length) {
        const panelH = 180;
        roundRect(ctx, panelX, y, panelW, panelH, 22);
        ctx.fillStyle = C.panel;
        ctx.fill();
        ctx.strokeStyle = C.panelBorder;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const cols = idx.length;
        const cw = panelW / cols;
        idx.forEach((q, i) => {
          const cxp = panelX + cw * i + cw / 2;
          ctx.textAlign = "center";
          ctx.fillStyle = C.muted;
          ctx.font = `700 28px ${FONT}`;
          ctx.fillText(q.sym, cxp, y + 56);
          ctx.fillStyle = C.text;
          ctx.font = `700 52px ${FONT}`;
          ctx.fillText(fmtPrice(q.price), cxp, y + 110);
          if (q.chg != null) {
            ctx.fillStyle = q.chg >= 0 ? C.green : C.red;
            ctx.font = `600 30px ${FONT}`;
            ctx.fillText(fmtPct(q.chg), cxp, y + 150);
          }
          if (i > 0) {
            ctx.strokeStyle = C.panelBorder;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(panelX + cw * i, y + 36);
            ctx.lineTo(panelX + cw * i, y + panelH - 36);
            ctx.stroke();
          }
        });
        ctx.textAlign = "left";
        y += panelH;
      }
    }

    // Footer
    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    ctx.font = `600 28px ${FONT}`;
    ctx.fillText("Your morning verdict, one tap.", PAD, H - PAD - 6);
    ctx.textAlign = "right";
    ctx.fillStyle = C.faint;
    ctx.font = `500 26px ${FONT}`;
    ctx.fillText("rainmaker-morning", W - PAD, H - PAD - 6);
    ctx.textAlign = "left";

    return canvas;
  }

  function buildCanvas() {
    const canvas = document.createElement("canvas");
    return renderToCanvas(collectData(), canvas);
  }

  function toBlob() {
    return new Promise((resolve) => {
      try {
        buildCanvas().toBlob((b) => resolve(b), "image/png");
      } catch (_) {
        resolve(null);
      }
    });
  }

  /* ---------- preview overlay + share ---------- */

  function fileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `rainmaker-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.png`;
  }

  async function shareBlob(blob) {
    if (!blob) return false;
    try {
      const file = new File([blob], fileName(), { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        await navigator.share({
          files: [file],
          title: "Rainmaker Morning",
          text: "My morning verdict from Rainmaker.",
        });
        return true;
      }
    } catch (_) {
      /* user cancelled or unsupported - fall through to download */
    }
    return false;
  }

  function downloadBlob(blob) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function apiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content) return meta.content.replace(/\/$/, "");
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) return stored.replace(/\/$/, "");
    } catch (_) {}
    return "";
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

  // Text the card to the owner's phone via the backend MMS endpoint. The server
  // hosts the PNG and hands Twilio a public URL; no posting happens client-side.
  function alertPhone() {
    try {
      if (global.RMGrowth?.alertPhone) return global.RMGrowth.alertPhone();
      if (global.RMGrowth?.getAutomations) {
        return global.RMGrowth.getAutomations().phone || "";
      }
    } catch (_) {}
    return "";
  }

  function smsFailLabel(res) {
    if (res.data?.reason === "no_recipient") return "Add phone in Account";
    if (global.RMGrowth?.formatSmsError && res.data) {
      const msg = global.RMGrowth.formatSmsError(res.data, res.reason);
      return msg.length > 42 ? msg.slice(0, 40) + "…" : msg;
    }
    return res.data?.detail || res.data?.reason || res.reason || "Couldn't send";
  }

  async function textCard(blob) {
    const base = apiBase();
    if (!base) return { ok: false, reason: "no_api_base" };
    const image = await blobToDataUrl(blob);
    if (!image) return { ok: false, reason: "encode_failed" };
    const phone = alertPhone();
    try {
      const headers = { "Content-Type": "application/json" };
      if (typeof global.RMAuthGate !== "undefined") {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
      const res = await fetch(base + "/share/text", {
        method: "POST",
        headers,
        body: JSON.stringify({
          image,
          body: "My morning verdict from Rainmaker.",
          to: phone || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          data,
          reason: data.detail || "http_" + res.status,
        };
      }
      return { ok: !!data.sent, data };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  function closeOverlay() {
    const ov = document.getElementById("shareCardOverlay");
    if (ov) ov.remove();
  }

  async function open() {
    preloadLogo();
    const blob = await toBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    closeOverlay();

    const ov = document.createElement("div");
    ov.id = "shareCardOverlay";
    ov.className = "share-card-overlay";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Share your morning verdict");

    const canShareFiles = (() => {
      try {
        const f = new File([blob], fileName(), { type: "image/png" });
        return !!(navigator.canShare && navigator.canShare({ files: [f] }) && navigator.share);
      } catch (_) {
        return false;
      }
    })();

    ov.innerHTML =
      '<div class="share-card-modal">' +
      '<button type="button" class="share-card-close" id="shareCardClose" aria-label="Close">&times;</button>' +
      '<img class="share-card-img" id="shareCardImg" alt="Morning verdict card preview">' +
      '<div class="share-card-actions">' +
      (canShareFiles
        ? '<button type="button" class="share-card-btn share-card-btn--primary" id="shareCardShare">Share</button>'
        : "") +
      '<button type="button" class="share-card-btn" id="shareCardDownload">Download</button>' +
      (apiBase()
        ? '<button type="button" class="share-card-btn" id="shareCardText">Text it to me</button>'
        : "") +
      "</div></div>";

    document.body.appendChild(ov);
    ov.querySelector("#shareCardImg").src = url;

    const cleanup = () => {
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      closeOverlay();
    };
    ov.addEventListener("click", (e) => {
      if (e.target === ov) cleanup();
    });
    ov.querySelector("#shareCardClose").addEventListener("click", cleanup);
    ov.querySelector("#shareCardDownload").addEventListener("click", () => {
      downloadBlob(blob);
    });
    const shareBtn = ov.querySelector("#shareCardShare");
    if (shareBtn) {
      shareBtn.addEventListener("click", async () => {
        const ok = await shareBlob(blob);
        if (ok) cleanup();
      });
    }
    const textBtn = ov.querySelector("#shareCardText");
    if (textBtn) {
      textBtn.addEventListener("click", async () => {
        const prev = textBtn.textContent;
        textBtn.disabled = true;
        textBtn.textContent = "Sending…";
        const res = await textCard(blob);
        if (res.ok) {
          textBtn.textContent = res.data?.mms
            ? "Sent ✓"
            : res.data?.mmsFallback
              ? "Sent (link)"
              : "Sent (text)";
        } else {
          textBtn.textContent = smsFailLabel(res);
          textBtn.title = global.RMGrowth?.formatSmsError
            ? global.RMGrowth.formatSmsError(res.data || {}, res.reason)
            : smsFailLabel(res);
        }
        setTimeout(() => {
          textBtn.disabled = false;
          textBtn.textContent = prev;
        }, 2200);
      });
    }
  }

  function bindButton(btn) {
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
  }

  function bind() {
    preloadLogo();
    bindButton(document.getElementById("btnShareCard"));
    bindButton(document.getElementById("btnShareCardMobile"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  global.RMShareCard = {
    collectData,
    renderToCanvas,
    buildCanvas,
    toBlob,
    open,
    bind,
  };
})(typeof window !== "undefined" ? window : globalThis);
