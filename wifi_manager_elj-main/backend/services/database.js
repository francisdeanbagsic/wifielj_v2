import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "wifi_manager",
  waitForConnections: true,
  connectionLimit: 5,
  timezone: "Z",
});

let previousSnapshotAt = null;
const previousPresence = new Map();
let databaseReady = false;
let initializationPromise = null;

export async function initializeDatabase() {
  if (databaseReady) return true;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      await pool.query("SELECT 1");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
          username VARCHAR(100) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
            ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (username)
        ) ENGINE=InnoDB
      `);

      const [[{ adminCount }]] = await pool.query(
        "SELECT COUNT(*) AS adminCount FROM admin_users",
      );
      if (Number(adminCount) === 0) {
        const username = process.env.ADMIN_USERNAME || "admin";
        const password = process.env.ADMIN_PASSWORD || "admin123";
        const passwordHash = await bcrypt.hash(password, 12);
        await pool.execute(
          "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
          [username, passwordHash],
        );
        console.log(`[Database] Created initial admin account: ${username}`);
      }

      databaseReady = true;
      console.log(`[Database] Connected to ${process.env.DB_NAME || "wifi_manager"}`);
      return true;
    } catch (err) {
      console.warn("[Database] Initialization failed; check XAMPP and database settings:", err.message);
      return false;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

export async function authenticateAdmin(username, password) {
  if (!(await initializeDatabase())) {
    throw new Error("Database is unavailable or has not been created");
  }

  const [rows] = await pool.execute(
    `SELECT username, password_hash AS passwordHash
     FROM admin_users
     WHERE username = ? AND is_active = TRUE
     LIMIT 1`,
    [username],
  );
  const admin = rows[0];
  const candidatePassword = typeof password === "string" ? password : "";
  if (!admin || !(await bcrypt.compare(candidatePassword, admin.passwordHash))) {
    return null;
  }
  return { username: admin.username, role: "admin" };
}

export async function persistRealtimeSnapshot({ workstations, traffic, timestamp }) {
  const devices = workstations || [];
  const observedAt = new Date(timestamp);
  const elapsedSeconds = previousSnapshotAt
    ? Math.max(0, (observedAt.getTime() - previousSnapshotAt) / 1000)
    : 0;
  previousSnapshotAt = observedAt.getTime();
  const trafficByMac = new Map(
    (traffic || []).map((item) => [
      String(item.mac || "").toUpperCase().replace(/-/g, ":"),
      item,
    ]),
  );
  let connection;
  const presenceUpdates = [];
  const deviceMacs = [];

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    for (const device of workstations || []) {
      if (!device.mac) continue;

      const mac = String(device.mac).toUpperCase().replace(/-/g, ":");
      const isOnline = device.status === "online" || device.online === true;
      await connection.execute(
        `INSERT INTO devices (mac_address, device_name, ip_address, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           device_name = VALUES(device_name),
           ip_address = VALUES(ip_address),
           last_seen_at = VALUES(last_seen_at)`,
        [mac, device.name || null, device.ip || null, observedAt],
      );
      deviceMacs.push(mac);

      const previousOnline = previousPresence.get(mac);
      if (previousOnline !== isOnline) {
        await connection.execute(
          `INSERT INTO device_presence_events (mac_address, event_type, occurred_at)
           VALUES (?, ?, ?)`,
          [mac, isOnline ? "online" : "offline", observedAt],
        );
        presenceUpdates.push([mac, isOnline]);
      }

      const sample = trafficByMac.get(mac);
      if (elapsedSeconds > 0 && sample && isOnline) {
        const downloadBytes =
          Math.max(0, Number(sample.download) || 0) * 1024 * elapsedSeconds;
        const uploadBytes =
          Math.max(0, Number(sample.upload) || 0) * 1024 * elapsedSeconds;

        if (downloadBytes + uploadBytes > 0) {
          await connection.execute(
            `INSERT INTO daily_bandwidth
               (mac_address, usage_date, download_bytes, upload_bytes, sample_count)
             VALUES (?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
               download_bytes = download_bytes + VALUES(download_bytes),
               upload_bytes = upload_bytes + VALUES(upload_bytes),
               sample_count = sample_count + 1`,
            [mac, observedAt.toISOString().slice(0, 10), downloadBytes, uploadBytes],
          );
        }
      }
    }

    const uniqueMacs = [...new Set(deviceMacs)];
    const firstSeenByMac = new Map();
    if (uniqueMacs.length > 0) {
      const placeholders = uniqueMacs.map(() => "?").join(", ");
      const [rows] = await connection.execute(
        `SELECT mac_address, first_seen_at
         FROM devices
         WHERE mac_address IN (${placeholders})`,
        uniqueMacs,
      );
      for (const row of rows) {
        const firstSeenAt = row.first_seen_at instanceof Date
          ? row.first_seen_at.toISOString()
          : new Date(`${String(row.first_seen_at).replace(" ", "T")}Z`).toISOString();
        firstSeenByMac.set(row.mac_address, firstSeenAt);
      }
    }

    await connection.commit();
    for (const [mac, isOnline] of presenceUpdates) {
      previousPresence.set(mac, isOnline);
    }
    return devices.map((device) => ({
      ...device,
      firstSeenAt:
        firstSeenByMac.get(
          String(device.mac || "").toUpperCase().replace(/-/g, ":"),
        ) || null,
    }));
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.warn("[Database] Snapshot persistence failed:", err.message);
    return devices;
  } finally {
    connection?.release();
  }
}

export async function logAdminAuthAttempt({
  username,
  success,
  ipAddress,
  userAgent,
}) {
  try {
    await pool.execute(
      `INSERT INTO admin_auth_logs (username, event_type, ip_address, user_agent)
       VALUES (?, ?, ?, ?)`,
      [
        String(username || "").slice(0, 100),
        success ? "login_success" : "login_failure",
        ipAddress || null,
        String(userAgent || "").slice(0, 500) || null,
      ],
    );
  } catch (err) {
    console.warn("[Database] Admin auth log failed:", err.message);
  }
}

export async function getDailyBandwidth({ from, to, mac, limit }) {
  const conditions = [];
  const values = [];
  if (from) {
    conditions.push("usage_date >= ?");
    values.push(from);
  }
  if (to) {
    conditions.push("usage_date <= ?");
    values.push(to);
  }
  if (mac) {
    conditions.push("daily_bandwidth.mac_address = ?");
    values.push(mac.toUpperCase().replace(/-/g, ":"));
  }
  values.push(limit);

  const [rows] = await pool.execute(
    `SELECT daily_bandwidth.mac_address AS mac, devices.device_name AS name,
            usage_date AS date, download_bytes AS downloadBytes,
            upload_bytes AS uploadBytes, sample_count AS sampleCount
     FROM daily_bandwidth
     JOIN devices ON devices.mac_address = daily_bandwidth.mac_address
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY usage_date DESC, daily_bandwidth.mac_address ASC
     LIMIT ?`,
    values,
  );
  return rows;
}

export async function getDeviceHistory({ mac, limit }) {
  const values = [];
  const condition = mac ? "WHERE events.mac_address = ?" : "";
  if (mac) values.push(mac.toUpperCase().replace(/-/g, ":"));
  values.push(limit);
  const [rows] = await pool.execute(
    `SELECT events.id, events.mac_address AS mac, devices.device_name AS name,
            events.event_type AS event, events.occurred_at AS occurredAt
     FROM device_presence_events AS events
     JOIN devices ON devices.mac_address = events.mac_address
     ${condition}
     ORDER BY events.occurred_at DESC
     LIMIT ?`,
    values,
  );
  return rows;
}

export async function getAdminAuthLogs(limit) {
  const [rows] = await pool.execute(
    `SELECT id, username, event_type AS event, ip_address AS ipAddress,
            user_agent AS userAgent, occurred_at AS occurredAt
     FROM admin_auth_logs
     ORDER BY occurred_at DESC
     LIMIT ?`,
    [limit],
  );
  return rows;
}