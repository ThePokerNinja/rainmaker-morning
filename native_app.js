/**
 * Native shell hooks (Capacitor Android/iOS). Loaded when ?native=1 or is-native-app.
 */
(function (global) {
  function isNativeShell() {
    return (
      document.documentElement.classList.contains("is-native-app") ||
      (global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform())
    );
  }

  function wireBackButton() {
    const cap = global.Capacitor;
    const App = cap?.Plugins?.App;
    if (!App?.addListener) return;

    App.addListener("backButton", function () {
      const acc = global.RMWorkspaceAccordion;
      const key = acc?.getActiveKey?.();
      if (key === "scans" && acc.setActiveRow) {
        acc.setActiveRow("chart");
        return;
      }
      if (key === "chart" && acc.setActiveRow) {
        acc.setActiveRow("market");
        return;
      }
      if (global.history.length > 1) {
        global.history.back();
        return;
      }
      App.minimizeApp?.();
    });
  }

  function wireStatusBar() {
    const StatusBar = global.Capacitor?.Plugins?.StatusBar;
    if (!StatusBar) return;
    StatusBar.setOverlaysWebView?.({ overlay: true }).catch(function () {});
    StatusBar.setStyle?.({ style: "DARK" }).catch(function () {});
  }

  function wireResume() {
    const App = global.Capacitor?.Plugins?.App;
    if (!App?.addListener) return;
    App.addListener("appStateChange", function (state) {
      if (!state.isActive) return;
      global.dispatchEvent(new Event("resize"));
      global.RMChartHub?.renderChartView?.();
      global.syncBackgroundActivity?.();
    });
  }

  function init() {
    if (!isNativeShell()) return;
    document.documentElement.classList.add("is-native-app");

    function boot() {
      if (!global.Capacitor?.Plugins) {
        global.setTimeout(boot, 120);
        return;
      }
      wireStatusBar();
      wireBackButton();
      wireResume();
    }
    boot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : globalThis);
