import { Router } from "express";
import { authMiddleware, signToken } from "../middleware/auth.js";
import { asusRouter } from "../services/asusRouter.js";
import {
  authenticateAdmin,
  getAdminAuthLogs,
  getDailyBandwidth,
  getDeviceHistory,
  logAdminAuthAttempt,
  persistRealtimeSnapshot,
} from "../services/database.js";

const router = Router();

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  let user;
  try {
    user = await authenticateAdmin(String(username || ""), password);
  } catch (err) {
    console.error("[Auth] Database authentication failed:", err.message);
    return res.status(503).json({ message: "Authentication database unavailable" });
  }

  if (!user) {
    await logAdminAuthAttempt({
      username: String(username || "").slice(0, 100),
      success: false,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    return res.status(401).json({ message: "Invalid username or password" });
  }
  await logAdminAuthAttempt({
    username: user.username,
    success: true,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  const token = signToken(user);
  res.json({
    token,
    user,
    school: {
      name: "Eduardo L. JSON Memorial High School",
      tagline: "Excellence in Education Through Technology",
    },
  });
});

router.get("/auth/me", authMiddleware, (req, res) => {
  res.json({
    user: req.user,
    school: {
      name: "Eduardo L. JSON Memorial High School",
      tagline: "Excellence in Education Through Technology",
    },
  });
});

router.get("/workstations", authMiddleware, async (_req, res) => {
  const [overview, workstations] = await Promise.all([
    asusRouter.getNetworkOverview(),
    asusRouter.getConnectedClients(),
  ]);
  const devicesWithFirstSeen = await persistRealtimeSnapshot({
    workstations,
    traffic: [],
    timestamp: Date.now(),
  });
  res.json({ overview, workstations: devicesWithFirstSeen });
});

router.post("/workstations/:mac/toggle", authMiddleware, async (req, res) => {
  const { connect } = req.body;
  const result = await asusRouter.setClientConnection(
    req.params.mac,
    Boolean(connect),
  );
  res.json(result);
});

// Bulk connect / disconnect all workstations
router.post("/workstations/bulk-toggle", authMiddleware, async (req, res) => {
  const { connect } = req.body;
  const clients = await asusRouter.getConnectedClients();
  const targets = clients.filter((c) =>
    connect ? c.status === "blocked" : c.status === "online",
  );
  const results = await Promise.allSettled(
    targets.map((c) => asusRouter.setClientConnection(c.mac, Boolean(connect))),
  );
  res.json({
    total: targets.length,
    success: results.filter((r) => r.status === "fulfilled" && r.value?.success)
      .length,
    failed: results.filter((r) => r.status === "rejected" || !r.value?.success)
      .length,
  });
});

router.get("/traffic", authMiddleware, async (_req, res) => {
  res.json(await asusRouter.getTrafficStats());
});

router.get("/history/bandwidth", authMiddleware, async (req, res) => {
  const limit = Math.min(
    Math.max(Number.parseInt(req.query.limit, 10) || 90, 1),
    1000,
  );
  res.json(
    await getDailyBandwidth({
      from: req.query.from,
      to: req.query.to,
      mac: req.query.mac,
      limit,
    }),
  );
});

router.get("/history/devices", authMiddleware, async (req, res) => {
  const limit = Math.min(
    Math.max(Number.parseInt(req.query.limit, 10) || 100, 1),
    1000,
  );
  res.json(await getDeviceHistory({ mac: req.query.mac, limit }));
});

router.get("/history/admin-auth", authMiddleware, async (req, res) => {
  const limit = Math.min(
    Math.max(Number.parseInt(req.query.limit, 10) || 100, 1),
    1000,
  );
  res.json(await getAdminAuthLogs(limit));
});

router.get("/traffic/speed", authMiddleware, async (_req, res) => {
  res.json(await asusRouter.getCurrentTrafficSpeed());
});

router.get("/activity", authMiddleware, async (_req, res) => {
  res.json(await asusRouter.getInternetActivity());
});

router.post("/speedtest", authMiddleware, async (_req, res) => {
  res.json(await asusRouter.runSpeedTest());
});

router.get("/analytics", authMiddleware, async (_req, res) => {
  res.json(await asusRouter.getAnalytics());
});

router.get("/restrict-sites", authMiddleware, async (_req, res) => {
  res.json(await asusRouter.getRestrictedSites());
});

router.post("/restrict-sites", authMiddleware, async (req, res) => {
  try {
    const site = await asusRouter.addRestrictedSite(req.body.url);
    res.json(site);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

router.delete("/restrict-sites", authMiddleware, async (_req, res) => {
  await asusRouter.removeAllRestrictedSites();
  res.json({ success: true });
});

router.delete("/restrict-sites/:url", authMiddleware, async (req, res) => {
  await asusRouter.removeRestrictedSite(decodeURIComponent(req.params.url));
  res.json({ success: true });
});

router.get("/announcements/agents", authMiddleware, (req, res) => {
  const hub = req.app.get("announcementHub");
  res.json({ agents: hub.listConnectedAgents() });
});

router.get("/announcements/history", authMiddleware, (req, res) => {
  const hub = req.app.get("announcementHub");
  res.json({ history: hub.getHistory() });
});

router.post("/announcements", authMiddleware, async (req, res) => {
  const hub = req.app.get("announcementHub");
  const { title, message, target, macs } = req.body || {};

  try {
    const result = hub.broadcast({
      title,
      message,
      target: target === "selected" ? "selected" : "all",
      macs: Array.isArray(macs) ? macs : [],
      sentBy: req.user?.username || "admin",
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
