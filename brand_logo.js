/**
 * Header logo — static PNG by default; animated MP4 while app is loading or scanning.
 * Desktop: canvas white-only loop (knocks out MP4 black). Mobile perf: always static PNG.
 */
(function (global) {
  const BLACK_CUTOFF = 48;
  const POLL_MS = 320;

  let syncDisplay = () => {};
  let layoutSizeCanvas = () => {};
  let logoPollTimer = null;

  function isHeaderFxLite() {
    return document.documentElement.classList.contains("header-fx-lite");
  }

  function isNativeShell() {
    return (
      document.documentElement.classList.contains("is-native-app") ||
      (global.Capacitor &&
        global.Capacitor.isNativePlatform &&
        global.Capacitor.isNativePlatform())
    );
  }

  function isMobilePerfLogo() {
    if (isNativeShell()) return false;
    return (
      isHeaderFxLite() ||
      (typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf())
    );
  }

  function wireAnimatedStack(stack, video, canvas, opts) {
    const btn = opts?.btn || null;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return null;

    let showingAnimated = !!opts?.forceAnimated;
    let rafId = 0;

    function sizeCanvas() {
      const w = stack.clientWidth || 120;
      const h = stack.clientHeight || 120;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawVideoContained(boxW, boxH) {
      const vw = video.videoWidth || 180;
      const vh = video.videoHeight || 180;
      const scale = Math.min(boxW / vw, boxH / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (boxW - dw) * 0.5;
      const dy = (boxH - dh) * 0.5;
      ctx.clearRect(0, 0, boxW, boxH);
      ctx.drawImage(video, dx, dy, dw, dh);
    }

    function paintWhiteOnly() {
      if (!showingAnimated || video.readyState < 2) return;
      const w = stack.clientWidth || 120;
      const h = stack.clientHeight || 120;
      drawVideoContained(w, h);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = frame.data;
      const span = 255 - BLACK_CUTOFF;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (lum <= BLACK_CUTOFF) {
          d[i + 3] = 0;
          continue;
        }
        const t = Math.min(1, (lum - BLACK_CUTOFF) / span);
        const a = Math.round(Math.pow(t, 1.35) * 255);
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = a;
      }
      ctx.putImageData(frame, 0, 0);
    }

    function stopLoop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function loop() {
      paintWhiteOnly();
      rafId = requestAnimationFrame(loop);
    }

    function setShowingAnimated(on) {
      const next = !!on;
      if (showingAnimated === next) return;
      showingAnimated = next;
      stack.classList.toggle("is-animated", showingAnimated);
      stack.classList.remove("is-animated-css");
      if (btn) {
        btn.setAttribute(
          "aria-label",
          showingAnimated
            ? "Rainmaker loading"
            : "Rainmaker logo — double-click for guide"
        );
        btn.title = showingAnimated ? "Loading…" : "Double-click: Rainmaker guide";
      }
      if (showingAnimated) {
        video.classList.add("brand-logo--video-src");
        video.classList.remove("brand-logo--video");
        video.hidden = true;
        canvas.hidden = false;
        canvas.removeAttribute("hidden");
        sizeCanvas();
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
        stopLoop();
        rafId = requestAnimationFrame(loop);
      } else {
        stopLoop();
        video.pause();
        video.classList.add("brand-logo--video-src");
        video.classList.remove("brand-logo--video");
        video.hidden = true;
        canvas.hidden = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    return { setShowingAnimated, sizeCanvas, stopLoop };
  }

  function isAppLogoBusy() {
    if (isMobilePerfLogo()) return false;
    const ws = document.getElementById("morningWorkspace");
    if (ws?.classList.contains("morning-workspace--booting")) return false;
    if (document.body.classList.contains("rm-scan-active")) return true;
    if (global.RMChartHub?.state?.scanActive) return true;
    const prog = document.getElementById("newsProgress");
    if (prog && !prog.classList.contains("hidden")) return true;
    return false;
  }

  function mountAuthSplash() {
    const stack = document.getElementById("authGateLogoStack");
    if (!stack) return;
    const video = stack.querySelector("video");
    const canvas = stack.querySelector("canvas");
    if (!video || !canvas) return;
    const wired = wireAnimatedStack(stack, video, canvas, { forceAnimated: true });
    if (!wired) return;
    wired.setShowingAnimated(true);
    global.addEventListener("resize", () => wired.sizeCanvas());
  }

  function mount() {
    const btn = document.getElementById("btnBrandGuide");
    const stack = document.getElementById("brandLogoStack");
    const video = document.getElementById("brandLogoVideo");
    const canvas = document.getElementById("brandLogoCanvas");
    if (!btn || !stack || !video || !canvas) return;

    if (!btn.dataset.focusBlurBound) {
      btn.dataset.focusBlurBound = "1";
      btn.addEventListener("pointerup", () => {
        if (btn.matches(":focus")) btn.blur();
      });
    }

    const wired = wireAnimatedStack(stack, video, canvas, { btn });
    if (!wired) return;

    const setShowingAnimated = wired.setShowingAnimated;
    const sizeCanvas = wired.sizeCanvas;

    syncDisplay = function sync() {
      setShowingAnimated(isAppLogoBusy());
    };
    layoutSizeCanvas = sizeCanvas;

    const ws = document.getElementById("morningWorkspace");
    const obs = new MutationObserver(() => syncDisplay());
    if (ws) {
      obs.observe(ws, { attributes: true, attributeFilter: ["class"] });
    }
    obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const prog = document.getElementById("newsProgress");
    if (prog) {
      obs.observe(prog, { attributes: true, attributeFilter: ["class"] });
    }
    logoPollTimer = setInterval(syncDisplay, POLL_MS);

    syncDisplay();

    global.addEventListener("resize", () => {
      if (stack.classList.contains("is-animated")) sizeCanvas();
    });

    global.addEventListener("rm:workspace-row", () => {
      requestAnimationFrame(() => {
        syncDisplay();
        if (stack.classList.contains("is-animated")) sizeCanvas();
      });
    });

    document.addEventListener("rm:scan-active", syncDisplay);
    document.addEventListener("rm:scan-done", syncDisplay);
  }

  function onHeaderLayout() {
    syncDisplay();
    if (document.getElementById("brandLogoStack")?.classList.contains("is-animated")) {
      layoutSizeCanvas();
    }
  }

  global.RMBrandLogo = {
    mount,
    mountAuthSplash,
    sync: () => syncDisplay(),
    onHeaderLayout,
    get _pollTimer() {
      return logoPollTimer;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
