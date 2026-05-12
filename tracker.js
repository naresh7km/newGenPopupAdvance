/**
 * tracker.js — drop this on any frontend page you want to monitor.
 *
 * Usage (replace the backend URL):
 *   <script>window.__TRACKER_BACKEND__ = "https://your-backend.com";</script>
 *   <script src="tracker.js"></script>
 *
 * Or inline the config before the IIFE below and hardcode BACKEND directly.
 */
(function () {
  var BACKEND = (window.__TRACKER_BACKEND__ || "https://popupmax-dmc5.onrender.com").replace(/\/$/, "");

  // ── Session ID — fresh every page load so each visit is its own row ──
  var sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  var startTime = Date.now();
  var clickCount = 0;

  // ── gclid: grab from URL once, persist in sessionStorage ────────────
  function getGclid() {
    var stored = sessionStorage.getItem("_t_gc");
    if (stored) return stored;
    try {
      var p = new URLSearchParams(window.location.search).get("gclid");
      if (p) { sessionStorage.setItem("_t_gc", p); return p; }
    } catch (_) {}
    return "";
  }
  getGclid(); // run on load so it's captured even before first send

  // ── Core send ────────────────────────────────────────────────────────
  function send(event, extra) {
    var payload = Object.assign(
      {
        sessionId: sid,
        event: event,
        timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || "",
        gclid: getGclid(),
        url: window.location.href,
        referrer: document.referrer || "",
        screenWidth: screen.width,
        screenHeight: screen.height,
        language: navigator.language || "",
        duration: Math.floor((Date.now() - startTime) / 1000),
        clicks: clickCount,
        isFullscreen: !!(
          document.fullscreenElement ||
          document.webkitFullscreenElement ||
          document.mozFullScreenElement
        ),
        isHidden: document.hidden,
      },
      extra || {}
    );
    try {
      fetch(BACKEND + "/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  // ── Events ───────────────────────────────────────────────────────────
  send("init");

  document.addEventListener("click", function () {
    clickCount++;
  });

  document.addEventListener("fullscreenchange", function () {
    send("fullscreen");
  });
  document.addEventListener("webkitfullscreenchange", function () {
    send("fullscreen");
  });
  document.addEventListener("mozfullscreenchange", function () {
    send("fullscreen");
  });

  document.addEventListener("visibilitychange", function () {
    send("visibility");
  });

  // Heartbeat every 30 s — keeps duration + click count fresh
  setInterval(function () {
    send("heartbeat");
  }, 30000);

  // Best-effort final snapshot before the tab closes
  window.addEventListener("beforeunload", function () {
    send("end");
  });
})();
