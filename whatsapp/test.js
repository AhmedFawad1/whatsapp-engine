/**
 * test.js — WhatsApp Engine Send Test
 *
 * Purpose:
 * - Connect to WS engine
 * - Observe SESSION_SNAPSHOT
 * - Send a test message once READY
 */

const WebSocket = require("ws");

const WS_URL = "ws://localhost:8810";

// ⚠️ CHANGE THIS NUMBER
const TEST_NUMBER = "923328266209"; // international format, no +
const TEST_MESSAGE = "Hello from test.js 🚀";

let sent = false;

console.log("🔌 Connecting to WhatsApp Engine...");

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("✅ WS connected");
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  // 🔥 Log session truth
  if (msg.type === "SESSION_SNAPSHOT") {
    console.log(
      `📡 SNAPSHOT | phase=${msg.enginePhase} ready=${msg.ready} queue=${msg.queueSize}`
    );

    // Send only once, only when READY
    if (msg.ready && !sent) {
      console.log("📤 Engine READY — sending test message...");
      sent = true;

      ws.send(
        JSON.stringify({
          type: "send",
          number: TEST_NUMBER,
          text: TEST_MESSAGE,
        })
      );
    }
  }

  // Message lifecycle events
  if (msg.type === "sent") {
    console.log("✅ MESSAGE SENT:", msg);
  }

  if (msg.type === "send_failed") {
    console.error("❌ MESSAGE FAILED:", msg);
  }

  if (msg.type === "qr") {
    console.log("📱 QR RECEIVED — scan it in WhatsApp");
  }
});

ws.on("close", () => {
  console.log("🔌 WS disconnected");
});

ws.on("error", (err) => {
  console.error("❌ WS error:", err.message);
});
