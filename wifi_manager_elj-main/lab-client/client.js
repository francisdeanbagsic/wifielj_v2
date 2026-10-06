import "dotenv/config";
import { io } from "socket.io-client";
import notifier from "node-notifier";
import { execSync } from "child_process";
import os from "os";

const SERVER_URL = "http://localhost:5000".replace(/\/$/, "");
const LAB_CLIENT_SECRET =
  process.env.LAB_CLIENT_SECRET || "elab-lab-client-change-me";
const LAB_MAC = normalizeMac(process.env.LAB_MAC || detectMac());
const LAB_NAME = process.env.LAB_NAME || os.hostname();

function normalizeMac(mac) {
  return String(mac || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

function detectMac() {
  if (process.env.LAB_MAC) return process.env.LAB_MAC;

  if (process.platform === "win32") {
    try {
      const out = execSync("getmac /fo csv /nh", { encoding: "utf8" });
      const line = out
        .split("\n")
        .find((l) => l.includes("-") || l.includes(":"));
      if (line) {
        const match = line.match(/([0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}/);
        if (match) return normalizeMac(match[0]);
      }
    } catch {
      /* fall through */
    }
  }

  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface || []) {
      if (!addr.mac || addr.mac === "00:00:00:00:00:00") continue;
      if (addr.internal) continue;
      return normalizeMac(addr.mac);
    }
  }

  console.error(
    "[elab-client] Could not detect MAC. Set LAB_MAC in .env (e.g. AA:BB:CC:DD:EE:FF)",
  );
  process.exit(1);
}

function showToast(title, message) {
  notifier.notify(
    {
      title: title || "Lab Announcement",
      message: message || "",
      sound: true,
      wait: false,
      timeout: 30,
      appID: "ELabNetMonitor",
    },
    (err) => {
      if (err) console.error("[elab-client] Notification error:", err.message);
    },
  );
  console.log(`[elab-client] ${title}: ${message}`);
}

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(LAB_MAC)) {
  console.error(`[elab-client] Invalid LAB_MAC: ${LAB_MAC}`);
  process.exit(1);
}

console.log(
  `[elab-client] Connecting as ${LAB_NAME} (${LAB_MAC}) → ${SERVER_URL}`,
);

const socket = io(SERVER_URL, {
  auth: {
    lab: {
      secret: LAB_CLIENT_SECRET,
      mac: LAB_MAC,
      name: LAB_NAME,
    },
  },
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionDelay: 2000,
});

socket.on("connect", () => {
  console.log("[elab-client] Connected — ready for announcements.");
});

socket.on("lab:announce:registered", (data) => {
  console.log("[elab-client] Registered on server:", data.mac);
});

socket.on("lab:announce", (payload) => {
  showToast(payload.title || "Lab Announcement", payload.message || "");
});

socket.on("connect_error", (err) => {
  console.error("[elab-client] Connection error:", err.message);
});

socket.on("disconnect", (reason) => {
  console.warn("[elab-client] Disconnected:", reason);
});
