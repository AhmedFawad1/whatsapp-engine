/*************************************************
 * WhatsApp Engine – SINGLE SOURCE OF TRUTH
 * Ultra-Stable | Deterministic | WS-Driven
 *************************************************/

process.env.CHROME_LOG_FILE = "NUL";
process.env.CHROME_LOG_LEVEL = "3";


const { Client, LocalAuth } = require("whatsapp-web.js");
const WebSocket = require("ws");
const qrcode = require("qrcode-terminal");
const dns = require("dns").promises;
const fs = require("fs");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, ".env.production") });
/* -------------------------------------------------
 * CONFIG
 * ------------------------------------------------- */
const WS_PORT = 8810;
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 15_000);
const STARTUP_READY_TIMEOUT_MS = 60_000;
const RESTART_COOLDOWN_MS = 60_000;

console.log(process.env.headless);
/* -------------------------------------------------
 * PATHS
 * ------------------------------------------------- */
const appData = process.env.APPDATA;
if (!appData) {
  console.error("❌ APPDATA missing");
  process.exit(1);
}

const baseDir = path.join(appData, "com.fitopscentral.app");
const sessionDir = path.join(baseDir, "whatsapp-session");
const queueFile = path.join(baseDir, "message-queue.json");

fs.mkdirSync(sessionDir, { recursive: true });

/* -------------------------------------------------
 * SESSION — SINGLE SOURCE OF TRUTH
 * ------------------------------------------------- */
const session = {
  enginePhase: "BOOTING", // BOOTING | NEED_QR | AUTHENTICATED | READY | RECONNECTING | ERROR | SHUTDOWN
  waState: null,

  ready: false,
  reconnecting: false,
  internetUp: true,

  qr: null,
  queueSize: 0,

  lastError: null,
  startedAt: Date.now(),
  lastSuccessfulSendAt: null,
};

/* -------------------------------------------------
 * WS SERVER
 * ------------------------------------------------- */
const wss = new WebSocket.Server({ port: WS_PORT });
const wsClients = new Set();

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/* -------------------------------------------------
 * SESSION SNAPSHOT (🔥 CORE)
 * ------------------------------------------------- */
function emitSessionSnapshot(reason = "periodic") {
  broadcast({
    type: "SESSION_SNAPSHOT",
    enginePhase: session.enginePhase,
    waState: session.waState,
    ready: session.ready,
    reconnecting: session.reconnecting,
    internetUp: session.internetUp,
    qrAvailable: !!session.qr,
    queueSize: session.queueSize,
    lastError: session.lastError,
    uptimeSec: Math.floor((Date.now() - session.startedAt) / 1000),
    lastSuccessfulSendAt: session.lastSuccessfulSendAt,
    reason,
  });
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      console.log("✅ Using Chrome:", p);
      return p;
    }
  }

  throw new Error("❌ Chrome not found. Set CHROME_PATH env variable.");
}

setInterval(() => emitSessionSnapshot("heartbeat"), 5000);

/* -------------------------------------------------
 * QUEUE (disk-backed, simple)
 * ------------------------------------------------- */
let queue = [];

function loadQueue() {
  try {
    if (!fs.existsSync(queueFile)) return [];
    return JSON.parse(fs.readFileSync(queueFile, "utf8")) || [];
  } catch {
    return [];
  }
}

function persistQueue() {
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
}

queue = loadQueue();
session.queueSize = queue.length;

/* -------------------------------------------------
 * INTERNET WATCHDOG
 * ------------------------------------------------- */
async function checkInternet() {
  try {
    await dns.resolve("google.com");
    return true;
  } catch {
    return false;
  }
}

setInterval(async () => {
  const up = await checkInternet();
  if (up !== session.internetUp) {
    session.internetUp = up;
    emitSessionSnapshot("internet_change");
    if (up && !session.ready && client) hardReconnect("internet_restored");
  }
}, 3000);

/* -------------------------------------------------
 * QUEUE WATCHDOG (🔥 REQUIRED)
 * ------------------------------------------------- */
// Periodically retry queued messages if engine is READY.
// This prevents "queued but never flushed" timing gaps.
setInterval(() => {
  try {
    if (
      session.ready &&
      session.internetUp &&
      client &&
      queue.length > 0
    ) {
      console.log("🔁 Queue watchdog flush");
      flushQueue("watchdog");
    }
  } catch (e) {
    console.error("Queue watchdog error:", e);
  }
}, 10_000);

/* -------------------------------------------------
 * WHATSAPP CLIENT
 * ------------------------------------------------- */
let client = null;
let lastRestartAt = 0;

function setPhase(phase, err = null) {
  session.enginePhase = phase;
  session.lastError = err;
  emitSessionSnapshot(`phase:${phase}`);
}

function createClient() {
  session.ready = false;
  session.reconnecting = false;
  session.qr = null;
  session.waState = null;
  setPhase("BOOTING");

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDir }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    webVersionCache: { type: "none" },
    puppeteer: {
      headless: process.env.headless === "true",
      executablePath: findChromeExecutable(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },

  });

  registerEvents();
  client.initialize();

  setTimeout(async () => {
    if (!session.ready && client) {
      try {
        const s = await client.getState();
        if (s === "CONNECTED") promoteConnected();
      } catch {}
    }
  }, STARTUP_READY_TIMEOUT_MS);
}

function registerEvents() {
  client.on("qr", (qr) => {
    session.qr = qr;
    setPhase("NEED_QR");
    qrcode.generate(qr, { small: true });
    broadcast({ type: "qr", qr }); // legacy
  });

  client.on("authenticated", () => {
    session.qr = null;
    setPhase("AUTHENTICATED");

    // 🔥 SAFETY NET: READY sometimes never fires
    setTimeout(() => {
      maybePromoteReady("post_authenticated");
    }, 3000);
  });


  client.on("ready", () => promoteConnected());

  client.on("change_state", (s) => {
    session.waState = s;
    emitSessionSnapshot("wa_state");
  });

  client.on("disconnected", (r) => {
    session.ready = false;
    setPhase("RECONNECTING", r);
    hardReconnect("wa_disconnected");
  });

  client.on("auth_failure", (m) => {
    setPhase("ERROR", m);
    hardReconnect("auth_failure");
  });
}

async function promoteConnected() {
  session.ready = true;
  session.reconnecting = false;
  session.qr = null;

  setPhase("READY");

  // 🔥 IMPORTANT: always attempt flush on READY
  setImmediate(() => flushQueue("ready"));
}

async function maybePromoteReady(source) {
  if (session.ready || !client) return;

  try {
    const waState = await client.getState();
    session.waState = waState;
    emitSessionSnapshot("wa_state_probe");

    if (waState === "CONNECTED") {
      console.warn(`⚠️ READY event missing — forcing READY (${source})`);
      promoteConnected();
    }
  } catch (e) {
    console.log("getState() failed:", e.message);
  }
}



/* -------------------------------------------------
 * RECONNECT
 * ------------------------------------------------- */
async function hardReconnect(reason) {
  if (session.reconnecting) return;

  const now = Date.now();
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) return;
  lastRestartAt = now;

  session.reconnecting = true;
  session.ready = false;
  setPhase("RECONNECTING", reason);

  try {
    if (client) await client.destroy();
  } catch {}

  client = null;

  setTimeout(() => {
    session.reconnecting = false;
    createClient();
  }, 3000);
}

/* -------------------------------------------------
 * QUEUE FLUSHER
 * ------------------------------------------------- */
async function flushQueue(trigger) {
  if (!client || !session.ready || !session.internetUp) return;

  while (queue.length) {
    const job = queue.shift();
    try {
      const id = await client.getNumberId(job.number);
      if (!id) throw new Error("Not on WhatsApp");

      await client.sendMessage(id._serialized, job.text, { sendSeen: false });
      session.lastSuccessfulSendAt = new Date().toISOString();
      broadcast({ type: "sent", id: job.id });
      await sleep(SEND_DELAY_MS);
    } catch (e) {
      job.attempts++;
      if (job.attempts < 3) queue.push(job);
      else broadcast({ type: "send_failed", id: job.id, error: e.message });
      break;
    } finally {
      session.queueSize = queue.length;
      persistQueue();
      emitSessionSnapshot("flush");
    }
  }
}

/* -------------------------------------------------
 * WS HANDLERS
 * ------------------------------------------------- */
wss.on("connection", (ws) => {
  wsClients.add(ws);
  emitSessionSnapshot("ws_connect");

  ws.on("close", () => wsClients.delete(ws));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "send") {
      const job = {
        id: Date.now() + "_" + Math.random().toString(16).slice(2),
        number: msg.number.replace("+", ""),
        text: msg.text,
        attempts: 0,
      };
      queue.push(job);
      session.queueSize = queue.length;
      persistQueue();
      emitSessionSnapshot("enqueue");
      flushQueue("enqueue");
    }

    if (msg.type === "restart_engine") hardReconnect("ws_command");
  });
});

/* -------------------------------------------------
 * SHUTDOWN
 * ------------------------------------------------- */
async function shutdown(reason) {
  session.enginePhase = "SHUTDOWN";
  emitSessionSnapshot(reason);
  try { persistQueue(); } catch {}
  try { if (client) await client.destroy(); } catch {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* -------------------------------------------------
 * UTIL
 * ------------------------------------------------- */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------
 * START
 * ------------------------------------------------- */
console.log("🚀 WhatsApp Engine starting...");
createClient();
setTimeout(() => {
  if (!session.ready) {
    console.warn("⚠️ READY event missing after startup timeout — forcing READY");
    maybePromoteReady("startup_watchdog");
  }
}, 15_000);
