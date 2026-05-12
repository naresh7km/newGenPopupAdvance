/**
 * tracker.js — drop this on any frontend page you want to monitor.
 *
 * Usage:
 *   <script src="https://popupmax-dmc5.onrender.com/tracker.js"></script>
 *
 * Override backend:
 *   <script>window.__TRACKER_BACKEND__ = "https://other.com";</script>
 *   <script src="...tracker.js"></script>
 */
(function () {
  var BACKEND = (window.__TRACKER_BACKEND__ || "https://popupmax-dmc5.onrender.com").replace(/\/$/, "");

  // Fresh session ID every page load — every visit is its own row
  var sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var startTime = Date.now();
  var clickCount = 0;

  // ── Timeline event buffer ─────────────────────────────────────────────
  var eventBuffer = [];
  var flushTimer = null;

  function recordEvent(type, data) {
    eventBuffer.push({ t: Date.now(), type: type, data: data || {} });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushEvents, 2000);
  }

  function flushEvents() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!eventBuffer.length) return;
    var events = eventBuffer.splice(0);
    try {
      fetch(BACKEND + "/track/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, events: events }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  // ── gclid ─────────────────────────────────────────────────────────────
  function getGclid() {
    var stored = sessionStorage.getItem("_t_gc");
    if (stored) return stored;
    try {
      var p = new URLSearchParams(window.location.search).get("gclid");
      if (p) { sessionStorage.setItem("_t_gc", p); return p; }
    } catch (_) {}
    return "";
  }
  getGclid();

  // ── Session-level send (state snapshot) ───────────────────────────────
  function send(event, extra) {
    var payload = Object.assign({
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
      isFullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement),
      isHidden: document.hidden,
    }, extra || {});
    try {
      fetch(BACKEND + "/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  // ── Init ─────────────────────────────────────────────────────────────
  send("init");
  recordEvent("init", { url: window.location.href, referrer: document.referrer || "" });

  // ── Clicks ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    clickCount++;
    recordEvent("click", { x: Math.round(e.clientX), y: Math.round(e.clientY) });
  });

  // ── Keyboard ─────────────────────────────────────────────────────────
  // Single-char keys typed inside inputs are masked as "[text]" to avoid
  // capturing passwords/form data. Navigation keys (Enter, Arrows, etc.)
  // are always logged regardless of focus.
  var SKIP_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1, Dead: 1, Unidentified: 1 };
  document.addEventListener("keydown", function (e) {
    if (SKIP_KEYS[e.key]) return;
    var tag = ((document.activeElement || {}).tagName || "").toUpperCase();
    var isInput = tag === "INPUT" || tag === "TEXTAREA" || !!(document.activeElement || {}).isContentEditable;
    var isSpecial = e.key.length > 1; // "Enter", "ArrowDown", "F5", etc.
    var key = (isInput && !isSpecial) ? "[text]" : e.key;
    recordEvent("key", { key: key });
  });

  // ── Fullscreen ────────────────────────────────────────────────────────
  function onFullscreenChange() {
    // Capture state first — some browsers fire the event before updating
    // document.fullscreenElement, so we pass it explicitly rather than
    // letting send() re-read it internally.
    var isFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
    send("fullscreen", { isFullscreen: isFS });
    recordEvent(isFS ? "fullscreen_enter" : "fullscreen_exit", {});
  }
  document.addEventListener("fullscreenchange",       onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("mozfullscreenchange",    onFullscreenChange);

  // ── Visibility ────────────────────────────────────────────────────────
  document.addEventListener("visibilitychange", function () {
    send("visibility");
    recordEvent(document.hidden ? "page_hidden" : "page_visible", {});
  });

  // ── Heartbeat — 15 s so stale sessions go gray within ~35 s of closing ─
  setInterval(function () {
    send("heartbeat");
    flushEvents();
  }, 15000);

  // ── End ───────────────────────────────────────────────────────────────
  window.addEventListener("beforeunload", function () {
    recordEvent("end", {});
    flushEvents();
    send("end");
  });
})();
