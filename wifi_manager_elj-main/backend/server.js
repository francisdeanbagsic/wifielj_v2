import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import apiRoutes from "./routes/api.js";
import { socketAuthMiddleware } from "./middleware/socketAuth.js";
import { asusRouter } from "./services/asusRouter.js";
import { AnnouncementHub } from "./services/announcementHub.js";
import { startDnsServer } from "./services/dnsServer.js";
import {
  initializeDatabase,
  persistRealtimeSnapshot,
} from "./services/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5000;
const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
      /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
    ],
    methods: ["GET", "POST"],
  },
});

const announcementHub = new AnnouncementHub(io);
app.set("announcementHub", announcementHub);
let realtimeBroadcastInFlight = false;

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
      /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
    ],
  }),
);
app.use(express.json());
app.use("/api", apiRoutes);
app.use("/lab-receiver", express.static(path.join(__dirname, "public", "lab")));

async function broadcastRealtime() {
  if (realtimeBroadcastInFlight) return;
  realtimeBroadcastInFlight = true;

  try {
    await asusRouter.refreshConnectedDevices().catch((err) => {
      console.warn("[Socket] device refresh failed:", err.message);
    });

    const [overview, workstations, traffic, activity] = await Promise.all([
      asusRouter.getNetworkOverview(),
      asusRouter.getConnectedClients(),
      asusRouter.getTrafficStats(),
      asusRouter.getInternetActivity(),
    ]);

    const speed = await asusRouter.getCurrentTrafficSpeed().catch((err) => {
      console.warn("[Socket] speed fetch failed:", err.message);
      return null;
    });

    const workstationsWithFirstSeen = await persistRealtimeSnapshot({
      workstations,
      traffic,
      timestamp: Date.now(),
    }).catch((err) => {
      console.warn(
        "[Database] Snapshot persistence unavailable:",
        err.message,
      );
    });

    io.to("admin").emit("lab:update", {
      overview,
      workstations: workstationsWithFirstSeen,
      traffic,
      activity,
      speed,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[Socket] broadcast error:", err.message);
  } finally {
    realtimeBroadcastInFlight = false;
  }
}

io.use(socketAuthMiddleware);

io.on("connection", (socket) => {
  if (socket.role === "lab") {
    console.log(
      `[Socket] Lab agent: ${socket.labName || socket.mac} (${socket.mac})`,
    );
    announcementHub.registerAgent(socket);
    socket.on("disconnect", () => {
      announcementHub.unregisterAgent(socket);
      console.log(`[Socket] Lab agent disconnected: ${socket.mac}`);
    });
    return;
  }

  console.log(`[Socket] Admin connected: ${socket.user?.username}`);
  socket.join("admin");
  socket.emit("lab:agents", {
    agents: announcementHub.listConnectedAgents(),
    timestamp: Date.now(),
  });
  broadcastRealtime();

  socket.on("disconnect", () => {
    console.log(`[Socket] Admin disconnected: ${socket.user?.username}`);
  });
});

initializeDatabase();
startDnsServer();
setInterval(broadcastRealtime, 2000);

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the existing backend process or set PORT to a different value.`,
    );
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`ELabNet Monitor API running on http://localhost:${PORT}`);
  console.log(
    `Lab receiver (browser): http://localhost:${PORT}/lab-receiver/`,
  );
  console.log(
    `Router mode: ${asusRouter.mockMode ? "MOCK (set ROUTER_MOCK=false + credentials for RT-AX53U)" : "LIVE ASUS-WRT"}`,
  );
});
