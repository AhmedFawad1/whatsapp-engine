/************************
 * WhatsApp Engine – ULTRA STABLE (DIAG + TAKEOVER + NO CACHE)
 ************************/

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const dns = require("dns").promises;

// -----------------------------------------------------
// 0) Runtime Flags
// -----------------------------------------------------
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";
const STARTUP_READY_TIMEOUT_MS = Number(process.env.STARTUP_READY_TIMEOUT_MS || 60_000);
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 15_000);

console.log("⚙️ FLAGS:", { HEADLESS, STARTUP_READY_TIMEOUT_MS, SEND_DELAY_MS });

// -----------------------------------------------------
// 1) Paths
// -----------------------------------------------------
const appData = process.env.APPDATA;
if (!appData) {
  console.error("❌ APPDATA env var missing.");
  process.exit(1);
}

const baseDir = path.resolve(appData, "com.fitopscentral.com");
const sessionDir = path.join(baseDir, "whatsapp-session");
const queueFile = path.join(baseDir, "message-queue.json");

fs.mkdirSync(sessionDir, { recursive: true });

console.log("ENGINE START PATH:", __dirname);
console.log("BASE DIR:", baseDir);
console.log("SESSION DIR:", sessionDir);
console.log("QUEUE FILE:", queueFile);

// -----------------------------------------------------
// 2) Chrome Auto Detection
// -----------------------------------------------------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      console.log("Using Chrome:", p);
      return p;
    }
  }
  throw new Error("❌ Chrome executable not found. Set CHROME_PATH env var.");
}
const chromePath = findChrome();

// -----------------------------------------------------
// 3) WebSocket Server
// -----------------------------------------------------
let wss;
try {
  wss = new WebSocket.Server({ port: 8810 });
} catch (e) {
  if (e.code === "EADDRINUSE") {
    console.error("🚫 Port 8810 already in use. Engine already running.");
    process.exit(0);
  }
  throw e;
}
const wsClients = new Set();

function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// -----------------------------------------------------
// 4) State + Queue
// -----------------------------------------------------
const startTime = Date.now();

const state = {
  ready: false,
  lastQr: null,
  reconnecting: false,
  internetUp: true,
  phase: "BOOTING",
  lastError: null,
  lastWaState: null,
};

const engineMetrics = {
  restartsTotal: 0,
  lastRestartAt: null,
  restartReasons: {},
  lastSuccessfulSendAt: null,
};

const RESTART_COOLDOWN_MS = 60_000;
let lastRestartAttemptAt = 0;
let scheduledCooldownRetry = null;

let queue = loadQueue();

function loadQueue() {
  try {
    if (!fs.existsSync(queueFile)) return [];
    const raw = fs.readFileSync(queueFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    console.log(`📦 Loaded queue from disk: ${parsed.length}`);
    return parsed;
  } catch (e) {
    console.error("Queue load failed:", e.message);
    return [];
  }
}

function persistQueue() {
  try {
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");
  } catch (e) {
    console.error("Queue persist failed:", e.message);
  }
}

function enqueue(job) {
  if (!job.number || !job.text) return;
  queue.push(job);
  persistQueue();
  broadcast({ type: "health", ...getHealthSnapshot() });
}

function getHealthSnapshot() {
  return {
    ready: state.ready,
    phase: state.phase,
    reconnecting: state.reconnecting,
    internetUp: state.internetUp,
    queueSize: queue.length,
    uptimeSec: Math.floor((Date.now() - startTime) / 1000),
    lastError: state.lastError,
    lastWaState: state.lastWaState,
    headless: true,
  };
}

function setPhase(phase, message = null, extra = {}) {
  state.phase = phase;
  if (message) state.lastError = message;
  broadcast({ type: "status", phase, message, ...extra });
  broadcast({ type: "health", ...getHealthSnapshot() });
}

setInterval(() => {
  broadcast({ type: "health", ...getHealthSnapshot() });
}, 5000);

// -----------------------------------------------------
// 5) Internet Heartbeat
// -----------------------------------------------------
async function checkInternet() {
  try {
    await dns.resolve("google.com");
    return true;
  } catch {
    return false;
  }
}

let lastInternet = true;
setInterval(async () => {
  const ok = await checkInternet();
  if (ok !== lastInternet) {
    lastInternet = ok;
    state.internetUp = ok;
    console.log(ok ? "🌐 Internet is BACK" : "🌑 Internet seems DOWN");
    broadcast({ type: "internet", up: ok });
    broadcast({ type: "health", ...getHealthSnapshot() });

    if (ok) {
      flushQueue("internet_back");
      if (!state.ready && client && !state.reconnecting) hardReconnect("internet_back_force");
    }
  }
}, 3000);

// -----------------------------------------------------
// 6) WhatsApp Client
// -----------------------------------------------------
let client = null;
let flushLock = false;
let flushStartedAt = null;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)),
  ]);
}

setInterval(() => {
  if (flushLock && flushStartedAt && Date.now() - flushStartedAt > 60000) {
    console.warn("🚨 Flush stuck >60s, forcing unlock + reconnect");
    flushLock = false;
    flushStartedAt = null;
    if (!state.reconnecting) hardReconnect("flush_stuck_watchdog");
  }
}, 10000);

let startupTimer = null;
function armStartupReadyWatchdog() {
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = setTimeout(() => {
    if (!state.ready && !state.reconnecting) {
      console.warn(`⏳ Not READY after ${STARTUP_READY_TIMEOUT_MS}ms → diagnostics + reconnect`);
      dumpDiagnostics("startup_timeout").finally(() => hardReconnect("startup_timeout"));
    }
  }, STARTUP_READY_TIMEOUT_MS);
}

// 🔥 NEW: dump diagnostics when stuck
async function dumpDiagnostics(tag) {
  try {
    setPhase("ERROR", `diag:${tag}`);
    if (!client) return;

    // 1) WA state
    try {
      const waState = await withTimeout(client.getState(), 10_000, "getState");
      state.lastWaState = waState;
  if (waState === "CONNECTED") {
  await promoteConnectedToReady("startup_timeout");
  return;
}
      console.log("🧾 WA getState():", waState);
      broadcast({ type: "wa_state", value: waState });
      broadcast({ type: "health", ...getHealthSnapshot() });
    } catch (e) {
      console.log("🧾 WA getState() failed:", e.message);
    }

    // 2) Try screenshot + html if pupPage exists (it usually does)
    const page = client.pupPage;
    if (page) {
      const diagDir = path.join(baseDir, "diag");
      fs.mkdirSync(diagDir, { recursive: true });

      const ts = Date.now();
      const shotPath = path.join(diagDir, `stuck_${tag}_${ts}.png`);
      const htmlPath = path.join(diagDir, `stuck_${tag}_${ts}.html`);

      try {
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log("📸 Screenshot saved:", shotPath);
      } catch (e) {
        console.log("📸 Screenshot failed:", e.message);
      }

      try {
        const html = await page.content();
        fs.writeFileSync(htmlPath, html, "utf8");
        console.log("🧾 HTML saved:", htmlPath);
      } catch (e) {
        console.log("🧾 HTML dump failed:", e.message);
      }
    } else {
      console.log("🧾 No pupPage available for screenshot/html.");
    }
  } catch (e) {
    console.log("Diagnostics dump failed:", e.message);
  }
}

async function fullEngineRestart(reason = "manual") {
  console.warn("🔄 FULL ENGINE RESTART:", reason);

  state.ready = false;
  state.lastQr = null;
  state.reconnecting = false;
  flushLock = false;
  flushStartedAt = null;

  setPhase("RECONNECTING", "engine_restart", { reason });

  try {
    if (client) await client.destroy();
  } catch {}

  client = null;

  setTimeout(() => createClient(), 3000);
}

function createClient() {
  console.log("🚀 Creating WhatsApp client...");

  state.ready = false;
  state.lastQr = null;
  state.lastError = null;
  state.lastWaState = null;
  setPhase("BOOTING", "creating_client");

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: sessionDir,
      clientId: "default",
    }),

    // ✅ FIX 1: takeover conflict
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,

    // ✅ FIX 2: disable WA web version caching (stops “authenticated but never ready”)
    webVersionCache: { type: "none" },

    puppeteer: {
      headless: true,
      executablePath: chromePath,
      dumpio: true, // ✅ show chrome logs in terminal
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    },
  });

  registerEvents();
  armStartupReadyWatchdog();

  try {
    client.initialize();
    setPhase("BOOTING", "initializing");
  } catch (e) {
    console.error("Initialize failed:", e.message);
    setPhase("ERROR", `initialize_failed: ${e.message}`);
    hardReconnect("initialize_failed");
  }
}

function registerEvents() {
  client.on("qr", (qr) => {
    console.log("📱 Scan QR");
    qrcode.generate(qr, { small: true });
    state.lastQr = qr;
    state.ready = false;
    setPhase("NEED_QR", "qr_generated");
    broadcast({ type: "qr", qr });
  });

  client.on("authenticated", () => {
  console.log("🔐 Authenticated");
  setPhase("AUTHENTICATED", "authenticated");

  setTimeout(() => {
    promoteConnectedToReady("post_authenticated");
  }, 3000);
});


  // 🔥 MORE SIGNALS
  client.on("loading_screen", (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
    broadcast({ type: "loading", percent, message });
  });

  client.on("change_state", (s) => {
    console.log(`🔄 WA change_state: ${s}`);
    state.lastWaState = s;
    broadcast({ type: "wa_state", value: s });
    broadcast({ type: "health", ...getHealthSnapshot() });
  });

  client.on("ready", () => {
    console.log("✅ WhatsApp READY");
    state.ready = true;
    state.reconnecting = false;
    state.lastQr = null;

    setPhase("READY", "wa_ready");
    broadcast({ type: "ready" });

    flushQueue("wa_ready");
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ AUTH FAILURE: ${msg}`);
    state.ready = false;
    state.lastQr = null;
    setPhase("ERROR", `auth_failure: ${msg}`);
    hardReconnect("auth_failure");
  });

  client.on("disconnected", async (reason) => {
    console.error(`⚠️ WhatsApp DISCONNECTED: ${reason}`);
    state.ready = false;
    state.lastQr = null;
    setPhase("RECONNECTING", `disconnected: ${reason}`);
    hardReconnect(`disconnected:${reason}`);
  });
}

async function hardReconnect(tag) {
  if (state.reconnecting) return;

  const now = Date.now();
  const elapsed = now - lastRestartAttemptAt;

  if (elapsed < RESTART_COOLDOWN_MS) {
    const waitMs = RESTART_COOLDOWN_MS - elapsed;
    console.warn(`🧊 Restart cooldown active. Retrying in ${Math.ceil(waitMs / 1000)}s`);

    if (!scheduledCooldownRetry) {
      scheduledCooldownRetry = setTimeout(() => {
        scheduledCooldownRetry = null;
        hardReconnect("cooldown_retry");
      }, waitMs);
    }

    broadcast({ type: "status", message: "reconnect_cooldown", waitMs, tag });
    return;
  }

  lastRestartAttemptAt = now;

  engineMetrics.restartsTotal += 1;
  engineMetrics.lastRestartAt = new Date().toISOString();
  engineMetrics.restartReasons[tag] = (engineMetrics.restartReasons[tag] || 0) + 1;

  state.reconnecting = true;
  state.ready = false;

  setPhase("RECONNECTING", "hard_reconnect", { tag });
  broadcast({ type: "engine_metrics", ...engineMetrics });

  try {
    if (client) {
      try {
        await client.destroy();
      } catch {}
    }
  } finally {
    client = null;
  }

  setTimeout(() => {
    try {
      state.reconnecting = false;
      createClient();
    } catch (e) {
      console.error(`Client recreate failed: ${e.message}`);
      state.reconnecting = false;
      setPhase("ERROR", `recreate_failed: ${e.message}`);
      setTimeout(() => hardReconnect("recreate_retry"), 5000);
    }
  }, 3000);
}

// -----------------------------------------------------
// 7) Queue Flusher
// -----------------------------------------------------
async function flushQueue(trigger) {
  if (flushLock) return;
  if (!state.internetUp || !state.ready || !client || queue.length === 0) return;

  flushLock = true;
  flushStartedAt = Date.now();

  console.log(`📤 Flushing queue (${queue.length}) [trigger=${trigger}]`);

  const MAX_ATTEMPTS = 3;

  try {
    while (queue.length > 0 && state.ready && state.internetUp && client) {
      const job = queue.shift();

      try {
        job.attempts = (job.attempts || 0) + 1;

        const numberId = await withTimeout(client.getNumberId(job.number), 15000, "getNumberId");
        if (!numberId) {
          job.lastError = "Number not on WhatsApp";
          broadcast({ type: "send_failed", id: job.id, number: job.number, error: job.lastError });
          console.log("❌ Not on WhatsApp:", job.number);
          persistQueue();
          continue;
        }

        await withTimeout(
          client.sendMessage(numberId._serialized, job.text, { sendSeen: false }),
          15000,
          "sendMessage"
        );

        engineMetrics.lastSuccessfulSendAt = new Date().toISOString();
        broadcast({ type: "engine_metrics", ...engineMetrics });

        broadcast({ type: "sent", id: job.id, number: job.number, meta: job.meta || {} });
        console.log("✅ Sent:", job.number);

        persistQueue();
        broadcast({ type: "health", ...getHealthSnapshot() });

        await sleep(SEND_DELAY_MS);
      } catch (e) {
        job.lastError = e?.message || "Unknown send error";
        console.error("Send error:", job.lastError);

        const m = job.lastError.toLowerCase();
        const looksLikeConn =
          m.includes("execution context") ||
          m.includes("target closed") ||
          m.includes("session closed") ||
          m.includes("navigation") ||
          m.includes("socket") ||
          m.includes("disconnected") ||
          m.includes("protocol error") ||
          m.includes("timeout");

        if (looksLikeConn) {
          console.warn("🔌 Connection issue detected, pausing flush");
          queue.unshift(job);
          persistQueue();
          hardReconnect("send_connection_error");
          break;
        }

        if (job.attempts >= MAX_ATTEMPTS) {
          broadcast({ type: "send_failed", id: job.id, number: job.number, attempts: job.attempts, error: job.lastError });
          console.log("💀 Max retries reached:", job.number);
          persistQueue();
          continue;
        }

        queue.push(job);
        persistQueue();
        broadcast({ type: "send_retry", id: job.id, number: job.number, attempts: job.attempts, error: job.lastError });

        await sleep(Math.min(3000 * job.attempts, 15000));
      }
    }
  } finally {
    flushLock = false;
    flushStartedAt = null;
  }
}

// -----------------------------------------------------
// 8) Graceful Shutdown
// -----------------------------------------------------
async function shutdown(reason) {
  console.log(`🧯 Shutting down (${reason})...`);
  broadcast({ type: "status", message: "shutdown", reason });

  try { persistQueue(); } catch {}
  try { if (client) await client.destroy(); } catch {}

  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", e);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection:", e);
  shutdown("unhandledRejection");
});

// -----------------------------------------------------
// 9) WebSocket handlers
// -----------------------------------------------------
wss.on("connection", (ws) => {
  wsClients.add(ws);
  console.log("WS client connected, total:", wsClients.size);

  wsSend(ws, { type: "status", message: "engine_connected", phase: state.phase });

  if (state.lastQr && !state.ready) wsSend(ws, { type: "qr", qr: state.lastQr });
  if (state.ready) wsSend(ws, { type: "ready" });

  wsSend(ws, { type: "health", ...getHealthSnapshot() });
  wsSend(ws, { type: "engine_metrics", ...engineMetrics });

  ws.on("close", () => {
    wsClients.delete(ws);
    console.log("WS client disconnected, total:", wsClients.size);
  });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return wsSend(ws, { type: "error", error: "Invalid JSON" });
    }

    if (msg.type === "send") {
      let number = msg.number;
      if (number.startsWith("+")) number = number.slice(1);

      const job = {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        number,
        text: msg.text,
        meta: msg.meta || {},
        createdAt: new Date().toISOString(),
        attempts: 0,
        lastError: null,
      };

      enqueue(job);
      wsSend(ws, { type: "queued", id: job.id, number: job.number });

      flushQueue("ws_send");
    }

    if (msg.type === "queue_status") {
      wsSend(ws, { type: "queue_status", size: queue.length, oldest: queue[0]?.createdAt || null });
    }

    if (msg.type === "queue_clear") {
      queue = [];
      persistQueue();
      wsSend(ws, { type: "queue_cleared" });
      broadcast({ type: "health", ...getHealthSnapshot() });
    }

    if (msg.type === "restart_engine") {
      wsSend(ws, { type: "status", message: "engine_restarting" });
      await fullEngineRestart("ws_command");
    }

    if (msg.type === "status") {
      wsSend(ws, { type: "health", ...getHealthSnapshot() });
    }
  });
});

// -----------------------------------------------------
// 10) Start
// -----------------------------------------------------
console.log("Initializing WhatsApp Engine...");
async function promoteConnectedToReady(source) {
  try {
    const waState = await client.getState();
    if (waState === "CONNECTED" && !state.ready) {
      console.warn(`⚠️ READY event missing — promoting CONNECTED → READY (${source})`);

      state.ready = true;
      state.reconnecting = false;
      state.lastQr = null;

      setPhase("READY", `forced_ready:${source}`);
      broadcast({ type: "ready", forced: true });

      flushQueue("forced_ready");
    }
  } catch (e) {
    console.log("promoteConnectedToReady failed:", e.message);
  }
}

createClient();