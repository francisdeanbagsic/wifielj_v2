import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import https from "https";
import crypto from "crypto";
import dns from "dns";
import { Client as SSHClient } from "ssh2";
import { AsusWrt } from "node-asuswrt";

const MOCK_WORKSTATIONS = [];

const blockedMacs = new Set();
const restrictedSites = new Set([]);

function parseAsusToken(html) {
  const match = html.match(/asus_token\s*=\s*['"]([^'"]+)['"]/i);
  return match ? match[1] : "";
}

function formatBandwidth(kbps) {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} Kbps`;
}

const ROUTER_URL = "https://192.168.50.1:8443";
const ROUTER_USERNAME = process.env.ROUTER_USERNAME || "admin";
const ROUTER_PASSWORD = process.env.ROUTER_PASSWORD || "t5hfg5n7@f";
const ROUTER_MOCK = process.env.ROUTER_MOCK === "true";
const ROUTER_SSH_PORT = Number(process.env.ROUTER_SSH_PORT || 22);
const ROUTER_USE_SSH = process.env.ROUTER_USE_SSH !== "false";
const SSH_TIMEOUT_MS = Number(process.env.SSH_TIMEOUT_MS || 15000);
const SPEED_MEASURE_INTERVAL_MS = Number(
  process.env.SPEED_MEASURE_INTERVAL_MS || 1100,
);

const SPEEDTEST_DOWNLOAD_URLS = [
  "https://download.thinkbroadband.com/5MB.zip",
  "https://httpbin.org/bytes/5242880",
  "https://speed.hetzner.de/5MB.bin",
];
const SPEEDTEST_UPLOAD_URLS = [
  "https://httpbin.org/post",
  "https://postman-echo.com/post",
];
const SPEEDTEST_PING_URLS = [
  "https://www.google.com/generate_204",
  "https://www.cloudflare.com/cdn-cgi/trace",
];

export class AsusRouterService {
  constructor() {
    this.baseURL = ROUTER_URL.replace(/\/$/, "");
    this.username = ROUTER_USERNAME;
    this.password = ROUTER_PASSWORD;
    this.mockMode = ROUTER_MOCK;
    this.asusWrt = new AsusWrt({
      baseURL: this.baseURL,
      username: this.username,
      password: this.password,
      isSelfSignedCertificate: true,
    });
    this.routerClient = undefined;
    this.asusWrtReady = false;
    this.lastClientSnapshot = {
      timestamp: Date.now(),
      clients: new Map(),
    };
    this.jar = new CookieJar();
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    this.client = wrapper(
      axios.create({
        baseURL: this.baseURL,
        jar: this.jar,
        timeout: 12000,
        withCredentials: true,
        headers: { "User-Agent": "ELabNetMonitor/1.0" },
        validateStatus: (s) => s < 500,
      }),
    );
    this.routerSession = wrapper(
      axios.create({
        baseURL: this.baseURL,
        jar: this.jar,
        timeout: 12000,
        withCredentials: true,
        headers: {
          "User-Agent": "ELabNetMonitor/1.0",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        validateStatus: (s) => s < 500,
      }),
    );
    this.loggedIn = false;
    // Login concurrency guard — prevents parallel login storms
    this._loginPromise = null;
    this.lastTraffic = { download: 0, upload: 0, wanStatus: "Unknown" };
    this.dnsIpCache = new Map();
    this.clientDnsQueries = new Map();

    this._sshConn = null; // active SSHClient instance
    this._sshReady = false; // true once the 'ready' event fired
    this._sshConnecting = null; // Promise while connecting so concurrent
    // callers wait on the same handshake
    this._sshLastAttempt = 0; // timestamp of last connect attempt
    this._SSH_RECONNECT_COOLDOWN = 5000; // ms between reconnect tries

    this._sshFailures = 0;
    this._sshCbOpen = false;
    this._sshCbOpenedAt = 0;
    this._SSH_CB_THRESHOLD = 5; // failures before opening circuit
    this._SSH_CB_RESET_MS = 30000; // 30 s cooldown before re-trying
  }

  // ── SSH: circuit-breaker helpers ─────────────────────────────────────────
  _sshCircuitIsOpen() {
    if (!this._sshCbOpen) return false;
    if (Date.now() - this._sshCbOpenedAt >= this._SSH_CB_RESET_MS) {
      // Half-open: allow one probe attempt
      this._sshCbOpen = false;
      this._sshFailures = 0;
      console.log("[ASUS][SSH] Circuit breaker half-open — probing SSH...");
      return false;
    }
    return true;
  }

  _sshRecordSuccess() {
    this._sshFailures = 0;
    this._sshCbOpen = false;
  }

  _sshRecordFailure(err) {
    this._sshFailures++;
    if (this._sshFailures >= this._SSH_CB_THRESHOLD) {
      this._sshCbOpen = true;
      this._sshCbOpenedAt = Date.now();
      console.warn(
        `[ASUS][SSH] Circuit breaker OPEN after ${this._sshFailures} failures.`,
        `Will retry in ${this._SSH_CB_RESET_MS / 1000}s. Last error: ${err?.message}`,
      );
    }
  }

  // ── SSH: get (or create) the persistent connection ───────────────────────
  _openSshConnection() {
    // If a connection attempt is already in-flight, all callers share it.
    if (this._sshConnecting) return this._sshConnecting;

    const delay =
      this._SSH_RECONNECT_COOLDOWN - (Date.now() - this._sshLastAttempt);

    // Instead of rejecting on cooldown, wait it out transparently so the
    // caller never sees a spurious error that counts toward the circuit breaker.
    if (delay > 0) {
      this._sshConnecting = new Promise((resolve, reject) => {
        setTimeout(() => {
          this._sshConnecting = null;
          this._openSshConnection().then(resolve, reject);
        }, delay);
      });
      return this._sshConnecting;
    }

    this._sshLastAttempt = Date.now();

    this._sshConnecting = new Promise((resolve, reject) => {
      // Tear down any stale connection first
      if (this._sshConn) {
        try {
          this._sshConn.destroy();
        } catch (_) {}
        this._sshConn = null;
        this._sshReady = false;
      }

      const conn = new SSHClient();
      const onError = (err) => {
        this._sshConnecting = null;
        this._sshReady = false;
        reject(err);
      };

      conn
        .once("ready", () => {
          this._sshConn = conn;
          this._sshReady = true;
          this._sshConnecting = null;
          console.log("[ASUS][SSH] Persistent connection established.");
          resolve(conn);
        })
        .once("error", onError)
        .once("close", () => {
          if (this._sshConn === conn) {
            console.warn("[ASUS][SSH] Persistent connection closed.");
            this._sshConn = null;
            this._sshReady = false;
            this._sshConnecting = null;
          }
        })
        .connect({
          host: new URL(this.baseURL).hostname,
          port: ROUTER_SSH_PORT,
          username: this.username,
          password: this.password,
          readyTimeout: SSH_TIMEOUT_MS,
          tryKeyboard: false,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
        });
    });

    return this._sshConnecting;
  }

  async _getSshConn() {
    if (this._sshReady && this._sshConn) return this._sshConn;
    return this._openSshConnection();
  }

  recordClientDnsQuery(clientIp, domain) {
    if (!clientIp || !domain) return;
    const cleanDomain = String(domain).trim().toLowerCase();
    if (
      cleanDomain.endsWith(".arpa") ||
      cleanDomain === "router.asus.com" ||
      cleanDomain.includes("local")
    ) {
      return;
    }
    let queries = this.clientDnsQueries.get(clientIp);
    if (!queries) {
      queries = new Set();
      this.clientDnsQueries.set(clientIp, queries);
    }
    queries.add(cleanDomain);
    if (queries.size > 15) {
      const arr = Array.from(queries);
      arr.shift();
      this.clientDnsQueries.set(clientIp, new Set(arr));
    }
  }

  recordDnsResolution(ip, domain) {
    if (!ip || !domain) return;
    const cleanDomain = String(domain).trim().toLowerCase();
    this.dnsIpCache.set(ip, cleanDomain);
    if (this.dnsIpCache.size > 1000) {
      const firstKey = this.dnsIpCache.keys().next().value;
      this.dnsIpCache.delete(firstKey);
    }
  }

  getDomainForIp(ip) {
    return this.dnsIpCache.get(ip) || null;
  }

  async extractAndStoreToken(response) {
    if (!response) return false;

    // Check if the cookie jar already got some cookies (from Set-Cookie headers)
    const cookies = await this.jar.getCookies(this.baseURL);
    if (cookies.length > 0) {
      return true;
    }

    // If no cookies in jar, check response data for asus_token
    let token = "";
    if (response.data) {
      if (response.data.asus_token) {
        token = response.data.asus_token;
      } else if (typeof response.data === "object") {
        token = response.data.get_clientlist?.asus_token || "";
      } else if (typeof response.data === "string") {
        const match = response.data.match(
          /asus_token\s*[:=]\s*['"]([^'"]+)['"]/,
        );
        if (match) token = match[1];
      }
    }

    if (token) {
      console.log(
        "[ASUS] Extracted token from response data, manually saving to cookie jar.",
      );
      await this.jar.setCookie(`asus_token=${token}`, this.baseURL);
      return true;
    }

    // If the router sends cookies instead of a visible token, save them too.
    const setCookie = response.headers?.["set-cookie"];
    if (setCookie && setCookie.length > 0) {
      for (const rawCookie of setCookie) {
        await this.jar.setCookie(rawCookie, this.baseURL);
      }
      return true;
    }

    return false;
  }

  async loginToRouter() {
    if (this.mockMode) return true;
    if (this.loggedIn) return true;

    // Concurrency guard: if a login is already in-flight, wait for it instead
    // of spawning a second parallel login that causes "Attempting plain base64
    // login..." to appear multiple times simultaneously.
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._doLogin().finally(() => {
      this._loginPromise = null;
    });
    return this._loginPromise;
  }

  async _doLogin() {
    if (this.loggedIn) return true;

    // 1. Get the login page to check for a token
    let token = "";
    try {
      const loginPage = await this.routerSession.get("/Main_Login.asp");
      token = parseAsusToken(loginPage.data || "");
    } catch (e) {
      console.warn("[ASUS] Main_Login.asp fetch warning:", e.message);
    }

    let response;
    let success = false;

    // Try Method A: Hashed authentication (if token is present)
    if (token) {
      console.log("[ASUS] Attempting token-based hashed login...");
      const hash = crypto
        .createHash("md5")
        .update(this.password + token)
        .digest("hex");
      const authString = Buffer.from(`${this.username}:${hash}`).toString(
        "base64",
      );

      const loginData = new URLSearchParams({
        group_id: "0",
        action_mode: "login",
        action_script: "login",
        current_page: "Main_Login.asp",
        next_page: "index.asp",
        save_passwd: "0",
        login_authorization: authString,
      }).toString();

      try {
        response = await this.routerSession.post("/login.cgi", loginData, {
          headers: { Referer: `${this.baseURL}/Main_Login.asp` },
        });
        success = await this.extractAndStoreToken(response);
      } catch (err) {
        console.warn("[ASUS] Hashed login failed:", err.message);
      }
    }

    // Try Method B: Plain base64 login in standard form format
    if (!success) {
      console.log("[ASUS] Attempting plain base64 login...");
      const authString = Buffer.from(
        `${this.username}:${this.password}`,
      ).toString("base64");

      const loginData = new URLSearchParams({
        group_id: "0",
        action_mode: "login",
        action_script: "login",
        current_page: "Main_Login.asp",
        next_page: "index.asp",
        save_passwd: "0",
        login_authorization: authString,
      }).toString();

      try {
        response = await this.routerSession.post("/login.cgi", loginData, {
          headers: { Referer: `${this.baseURL}/Main_Login.asp` },
        });
        success = await this.extractAndStoreToken(response);
      } catch (err) {
        console.warn("[ASUS] Plain form login failed:", err.message);
      }
    }

    // Try Method C: Simplified query parameter (node-asuswrt style)
    if (!success) {
      console.log("[ASUS] Attempting simplified node-asuswrt style login...");
      const authString = Buffer.from(
        `${this.username}:${this.password}`,
      ).toString("base64");

      try {
        response = await this.routerSession.post(
          "/login.cgi",
          new URLSearchParams({
            login_authorization: authString,
          }).toString(),
          {
            headers: {
              Referer: `${this.baseURL}/Main_Login.asp`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          },
        );
        success = await this.extractAndStoreToken(response);
      } catch (err) {
        console.warn("[ASUS] Simplified login failed:", err.message);
      }
    }

    if (!success) {
      console.warn("[ASUS] All router login attempts failed.");
      throw new Error(
        "Authentication failed: no session cookie received from the router. Please verify your username and password.",
      );
    }

    // Attempt to access index.asp to solidify/confirm session
    try {
      await this.routerSession.get("/index.asp", {
        headers: { Referer: `${this.baseURL}/Main_Login.asp` },
      });
    } catch (e) {
      console.warn("[ASUS] Index load after login warning:", e.message);
    }

    this.loggedIn = true;
    return true;
  }

  async controlInternetAccess(mac, name, shouldBlock) {
    if (this.mockMode) return { success: true, mac, blocked: shouldBlock };

    await this.loginToRouter();

    const normalizedMac = String(mac).trim().toUpperCase();
    const deviceName = String(name || "Unknown").trim();
    const timeSchedule = shouldBlock
      ? "111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111>"
      : "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000>";

    const payload = new URLSearchParams({
      action_mode: "apply",
      action_script: "restart_firewall",
      action_wait: "5",
      current_page: "index.asp",
      MULTIFILTER_ALL: "1",
      MULTIFILTER_ENABLE: shouldBlock ? "1>" : "0>",
      MULTIFILTER_MAC: `${normalizedMac}>`,
      MULTIFILTER_DEVICENAME: `${deviceName}>`,
      MULTIFILTER_MACFILTER_DAYTIME: timeSchedule,
      MULTIFILTER_MAC_TARGET: normalizedMac,
    }).toString();

    const response = await this.routerSession.post("/apply.cgi", payload, {
      headers: {
        Referer: `${this.baseURL}/index.asp`,
      },
    });

    return {
      success: response.status === 200 || response.status === 302,
      status: response.status,
      responseBody:
        typeof response.data === "string"
          ? response.data.slice(0, 300)
          : response.data,
    };
  }

  async ensureLogin() {
    if (this.mockMode) return true;
    if (this.loggedIn) return true;
    return this.loginToRouter();
  }

  async executeSshCommand(command) {
    // ── Circuit breaker check ───────────────────────────────────────────────
    if (this._sshCircuitIsOpen()) {
      throw new Error(
        `SSH circuit breaker open — skipping command. ` +
          `Retry in ${Math.ceil((this._SSH_CB_RESET_MS - (Date.now() - this._sshCbOpenedAt)) / 1000)}s.`,
      );
    }

    const runOnConn = (conn) =>
      new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
          if (err) return reject(err);
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code) => {
              if (code === 0) {
                resolve({ stdout, stderr, code });
              } else {
                const error = new Error(
                  `SSH command failed (${code}): ${stderr || stdout}`,
                );
                error.code = code;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
              }
            })
            .on("data", (d) => {
              stdout += d.toString();
            })
            .stderr.on("data", (d) => {
              stderr += d.toString();
            });
        });
      });

    // Try on existing connection first; if it fails due to a connection-level
    // error, drop the stale conn and reconnect once before giving up.
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const conn = await this._getSshConn();
        const result = await runOnConn(conn);
        this._sshRecordSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        const msg = String(err.message || "");
        const isConnErr =
          msg.includes("ECONNRESET") ||
          msg.includes("Connection lost") ||
          msg.includes("Not connected") ||
          msg.includes("handshake") ||
          msg.includes("Timed out");

        if (isConnErr && attempt === 0) {
          // Force-drop stale connection so _getSshConn() reopens it.
          // Reset _sshLastAttempt so the cooldown doesn't block the retry.
          if (this._sshConn) {
            try {
              this._sshConn.destroy();
            } catch (_) {}
          }
          this._sshConn = null;
          this._sshReady = false;
          this._sshConnecting = null;
          this._sshLastAttempt = 0; // bypass cooldown for the immediate retry
          console.warn("[ASUS][SSH] Connection dropped, reconnecting...");
          continue;
        }
        // Only real SSH failures (not infra/cooldown) count toward the breaker.
        if (isConnErr) this._sshRecordFailure(err);
        break;
      }
    }

    // If we exhausted both attempts and the last error was a conn error, record it.
    if (lastErr) {
      const msg = String(lastErr.message || "");
      const isConnErr =
        msg.includes("ECONNRESET") ||
        msg.includes("Connection lost") ||
        msg.includes("Not connected") ||
        msg.includes("handshake") ||
        msg.includes("Timed out");
      if (isConnErr) this._sshRecordFailure(lastErr);
    }

    throw lastErr;
  }

  async blockDeviceViaSSH(mac) {
    const normalizedMac = String(mac || "")
      .trim()
      .toUpperCase();
    const checkCommand = `iptables -C FORWARD -m mac --mac-source ${normalizedMac} -j DROP`;
    try {
      await this.executeSshCommand(checkCommand);
      return { success: true, blocked: true, alreadyBlocked: true };
    } catch {
      const addCommand = `iptables -I FORWARD 1 -m mac --mac-source ${normalizedMac} -j DROP`;
      await this.executeSshCommand(addCommand);
      return { success: true, blocked: true, alreadyBlocked: false };
    }
  }

  async unblockDeviceViaSSH(mac) {
    const normalizedMac = String(mac || "")
      .trim()
      .toUpperCase();
    const checkCommand = `iptables -C FORWARD -m mac --mac-source ${normalizedMac} -j DROP`;
    try {
      await this.executeSshCommand(checkCommand);
    } catch {
      return { success: true, blocked: false, alreadyUnblocked: true };
    }

    const deleteCommand = `iptables -D FORWARD -m mac --mac-source ${normalizedMac} -j DROP`;
    try {
      await this.executeSshCommand(deleteCommand);
      return { success: true, blocked: false, alreadyUnblocked: false };
    } catch (err) {
      if (String(err.message).includes("No chain/target/match")) {
        return { success: true, blocked: false, alreadyUnblocked: true };
      }
      throw err;
    }
  }

  async parseProcNetDev(raw) {
    const lines = String(raw || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const result = { totalRx: 0, totalTx: 0, interfaces: {} };
    for (const line of lines.slice(2)) {
      const [ifacePart, dataPart] = line.split(":");
      if (!dataPart) continue;
      const iface = ifacePart.trim();
      if (
        iface === "lo" ||
        iface.startsWith("ifb") ||
        iface.startsWith("tun") ||
        iface.startsWith("veth") ||
        iface.startsWith("docker") ||
        iface.startsWith("br-") ||
        iface.startsWith("vmnet") ||
        iface.startsWith("sit") ||
        iface.startsWith("ip6tnl") ||
        iface.startsWith("bond")
      ) {
        continue;
      }
      const fields = dataPart.trim().split(/\s+/);
      const rx = Number(fields[0]) || 0;
      const tx = Number(fields[8]) || 0;
      result.interfaces[iface] = { rx, tx };
      result.totalRx += rx;
      result.totalTx += tx;
    }
    return result;
  }

  async getRouterInterfaceBytes() {
    const { stdout } = await this.executeSshCommand("cat /proc/net/dev");
    return this.parseProcNetDev(stdout);
  }

  async getCurrentTrafficSpeed() {
    if (this.mockMode) {
      return {
        downloadKBs: Number((Math.random() * 120 + 20).toFixed(2)),
        uploadKBs: Number((Math.random() * 40 + 10).toFixed(2)),
        downloadKbps: Number((Math.random() * 960 + 160).toFixed(2)),
        uploadKbps: Number((Math.random() * 320 + 80).toFixed(2)),
        source: "mock",
        timestamp: new Date().toISOString(),
      };
    }

    if (!ROUTER_USE_SSH) {
      throw new Error(
        "SSH speed measurement is disabled. Set ROUTER_USE_SSH=true.",
      );
    }

    const firstSample = await this.getRouterInterfaceBytes();
    await new Promise((resolve) =>
      setTimeout(resolve, SPEED_MEASURE_INTERVAL_MS),
    );
    const secondSample = await this.getRouterInterfaceBytes();

    const intervalSeconds = Math.max(SPEED_MEASURE_INTERVAL_MS / 1000, 0.001);
    const deltaRx = Math.max(secondSample.totalRx - firstSample.totalRx, 0);
    const deltaTx = Math.max(secondSample.totalTx - firstSample.totalTx, 0);

    const downloadKBs = Number((deltaRx / 1024 / intervalSeconds).toFixed(2));
    const uploadKBs = Number((deltaTx / 1024 / intervalSeconds).toFixed(2));
    const downloadKbps = Number(
      ((deltaRx * 8) / 1000 / intervalSeconds).toFixed(2),
    );
    const uploadKbps = Number(
      ((deltaTx * 8) / 1000 / intervalSeconds).toFixed(2),
    );

    return {
      downloadKBs,
      uploadKBs,
      downloadKbps,
      uploadKbps,
      source: "ssh",
      timestamp: new Date().toISOString(),
      interfaces: secondSample.interfaces,
    };
  }

  async ensureAsusWrtReady() {
    if (this.mockMode) return;
    if (this.asusWrtReady) return;

    await this.asusWrt.discoverClients();
    await this.asusWrt.updateConnectedDevices();
    this.routerClient = this.asusWrt.asusRouter || this.asusWrt.mainClient;
    this.asusWrtReady = true;
  }

  async refreshConnectedDevices() {
    if (this.mockMode) return;
    await this.ensureAsusWrtReady();
    await this.asusWrt.updateConnectedDevices();
  }

  async appGet(hook) {
    await this.ensureLogin();
    const res = await this.client.get("/appGet.cgi", {
      params: { hook },
    });
    return res.data;
  }

  async appSet(payload) {
    await this.ensureLogin();
    const res = await this.client.get("/appSet.cgi", { params: payload });
    return res.data;
  }

  normalizeMac(value) {
    return String(value || "")
      .trim()
      .toUpperCase();
  }

  getDeviceName(device) {
    if (!device) return "";
    const candidate =
      device.name ||
      device.nickName ||
      device.hostName ||
      device.hostname ||
      device.deviceName ||
      device.alias ||
      device.remark ||
      device.sysName ||
      device.model ||
      device.host ||
      "";
    return String(candidate || "")
      .trim()
      .replace(/[\u0000-\u001F]+/g, "")
      .replace(/\s+/g, " ");
  }

  isDeviceOnline(device) {
    if (!device) return false;
    if (
      device.online === true ||
      device.online === 1 ||
      device.online === "1"
    ) {
      return true;
    }
    if (String(device.online).toLowerCase() === "true") {
      return true;
    }
    if (device.status === 1 || device.status === "1") {
      return true;
    }
    if (Number(device.rssi) > 0) {
      return true;
    }
    if (String(device.ip || "").trim() !== "") {
      return true;
    }
    return false;
  }

  deriveDeviceActivity(device) {
    if (!device) return "Connected";
    const method =
      device.connectionMethod ||
      device.connectionType ||
      device.networkType ||
      device.apName ||
      device.mode ||
      "";
    return method ? `Connected (${method})` : "Connected";
  }

  resolveConnectionInfo(entry) {
    if (!entry) {
      return {
        linkType: "unknown",
        connectionMethod: "unknown",
        connectionLabel: "Unknown",
      };
    }

    let method = "unknown";

    if (entry.connectionMethod) {
      method = String(entry.connectionMethod).toLowerCase();
    } else if (entry.isWL !== undefined && entry.isWL !== "") {
      switch (parseInt(entry.isWL, 10)) {
        case 0:
          method = "wired";
          break;
        case 1:
          method = "2g";
          break;
        case 2:
          method = "5g";
          break;
        case 3:
        case 4:
        case 5:
        case 6:
        case 7:
          method = "6g";
          break;
        default:
          method = "wired";
      }
    } else if (entry.rssi !== undefined && entry.rssi !== "") {
      const rssi = Number(entry.rssi);
      if (rssi > 0) {
        method = "wireless";
      } else if (
        entry.online === true ||
        entry.isOnline === "1" ||
        entry.isOnline === 1
      ) {
        method = "wired";
      }
    }

    const linkType =
      method === "wired"
        ? "wired"
        : method === "unknown"
          ? "unknown"
          : "wireless";

    const labels = {
      wired: "Wired (Ethernet)",
      "2g": "Wireless (2.4 GHz)",
      "5g": "Wireless (5 GHz)",
      "6g": "Wireless (6 GHz)",
      "7g": "Wireless (6 GHz)",
      wireless: "Wireless",
      unknown: "Unknown",
    };

    return {
      linkType,
      connectionMethod: method,
      connectionLabel: labels[method] || labels.unknown,
    };
  }

  isClientListMetaKey(key) {
    return (
      key === "maclist" ||
      key === "namelist" ||
      key === "iplist" ||
      key === "rssiList" ||
      key === "macList"
    );
  }

  parseClientListEntries(raw) {
    const list = raw?.get_clientlist || raw || {};
    const clients = [];

    if (typeof list !== "object") return clients;

    for (const [key, entry] of Object.entries(list)) {
      if (this.isClientListMetaKey(key)) continue;
      if (!entry || typeof entry !== "object") continue;

      const mac = this.normalizeMac(entry.mac || key);
      if (!mac || mac.length < 11) continue;

      const conn = this.resolveConnectionInfo(entry);
      const online =
        entry.isOnline === "1" ||
        entry.isOnline === 1 ||
        entry.isOnline === true;

      clients.push({
        mac,
        name: this.getDeviceName(entry) || `Device-${mac.slice(-4)}`,
        ip: String(entry.ip || "").trim(),
        online,
        rx: Number(entry.curRx ?? entry.totalRx ?? 0) || 0,
        tx: Number(entry.curTx ?? entry.totalTx ?? 0) || 0,
        rssi: entry.rssi !== "" ? Number(entry.rssi) || 0 : 0,
        activity: online ? "Connected" : "Offline",
        blocked: blockedMacs.has(mac),
        ...conn,
      });
    }

    if (clients.length > 0) return clients;
    return this.parseClientList(raw);
  }

  dedupeClientsByMac(clients) {
    const merged = new Map();
    for (const client of clients) {
      const mac = this.normalizeMac(client.mac);
      if (!mac) continue;
      const current = merged.get(mac);
      if (!current) {
        merged.set(mac, { ...client, mac });
        continue;
      }

      const online = current.online || client.online;
      const blocked = current.blocked || client.blocked;
      const rx = Math.max(current.rx || 0, client.rx || 0);
      const tx = Math.max(current.tx || 0, client.tx || 0);
      const bandwidthKbps = Math.max(
        current.bandwidthKbps || 0,
        client.bandwidthKbps || 0,
      );
      const status = blocked ? "blocked" : online ? "online" : "offline";
      const name = current.name || client.name;
      const ip = current.ip || client.ip;
      const activity = current.activity || client.activity;
      const linkType =
        current.linkType !== "unknown" ? current.linkType : client.linkType;
      const connectionMethod =
        current.connectionMethod !== "unknown"
          ? current.connectionMethod
          : client.connectionMethod;
      const connectionLabel =
        current.connectionLabel !== "Unknown"
          ? current.connectionLabel
          : client.connectionLabel;

      merged.set(mac, {
        ...current,
        mac,
        name,
        ip,
        online,
        rx,
        tx,
        activity,
        blocked,
        status,
        bandwidthKbps,
        bandwidth:
          bandwidthKbps > 0 ? formatBandwidth(bandwidthKbps) : "0 Kbps",
        linkType: linkType || "unknown",
        connectionMethod: connectionMethod || "unknown",
        connectionLabel: connectionLabel || "Unknown",
      });
    }
    return Array.from(merged.values());
  }

  parseClientList(data) {
    const clients = [];
    if (!data || typeof data !== "object") return clients;

    const macList = data.maclist || data.get_clientlist?.maclist || "";
    const nameList = data.namelist || data.get_clientlist?.namelist || "";
    const ipList = data.iplist || data.get_clientlist?.iplist || "";
    const rssiList = data.rssiList || data.get_clientlist?.rssiList || "";

    const macs = String(macList).split("<").filter(Boolean);
    const names = String(nameList).split("<");
    const ips = String(ipList).split("<");
    const rssis = String(rssiList).split("<");

    macs.forEach((mac, i) => {
      const cleanMac = mac.trim().toUpperCase();
      const rssiVal = rssis[i] !== undefined ? Number(rssis[i]) : 0;
      const online =
        rssis[i] !== undefined && rssis[i] !== "" && rssis[i] !== "0";
      const conn = this.resolveConnectionInfo({
        rssi: rssiVal,
        isOnline: online ? "1" : "0",
        isWL: rssiVal > 0 ? "1" : online ? "0" : undefined,
      });
      clients.push({
        mac: cleanMac,
        name: this.getDeviceName({ name: names[i] }) || `Device-${i + 1}`,
        ip: (ips[i] || "").trim(),
        online,
        rx: 0,
        tx: 0,
        rssi: rssiVal,
        activity: online ? "Connected" : "Offline",
        blocked: blockedMacs.has(cleanMac),
        ...conn,
      });
    });

    return clients;
  }

  /**
   * Uses SSH + nf_conntrack to aggregate per-IP byte totals from active connections.
   * Each conntrack entry has bytes= and packets= counters per direction.
   * Returns a Map of IP -> { rx, tx } in bytes.
   */
  async fetchPerDeviceTrafficViaSSH(clientIps) {
    if (!clientIps || clientIps.length === 0) return new Map();
    try {
      const { stdout } = await this.executeSshCommand(
        "cat /proc/net/nf_conntrack 2>/dev/null || cat /proc/net/ip_conntrack 2>/dev/null || true",
      );
      const ipTraffic = new Map();
      const ipSet = new Set(clientIps.filter(Boolean));
      const lines = stdout.split("\n").filter(Boolean);

      for (const line of lines) {
        // Parse key=value tokens from each conntrack line
        const tokens = line.split(/\s+/);
        const props = {};
        for (const token of tokens) {
          const eq = token.indexOf("=");
          if (eq > 0) props[token.slice(0, eq)] = token.slice(eq + 1);
        }

        // Conntrack lines have two directions — first occurrence is "original" direction
        // We look for src (client sending) and dst (client receiving)
        const src = props.src;
        const dst = props.dst;
        const bytes = Number(props.bytes) || 0;

        if (!bytes || (!src && !dst)) continue;

        if (src && ipSet.has(src)) {
          const existing = ipTraffic.get(src) || { rx: 0, tx: 0 };
          // Client is source = upload (tx)
          ipTraffic.set(src, { rx: existing.rx, tx: existing.tx + bytes });
        }
        if (dst && ipSet.has(dst)) {
          const existing = ipTraffic.get(dst) || { rx: 0, tx: 0 };
          // Client is destination = download (rx)
          ipTraffic.set(dst, { rx: existing.rx + bytes, tx: existing.tx });
        }
      }

      return ipTraffic;
    } catch (err) {
      console.warn("[ASUS] fetchPerDeviceTrafficViaSSH failed:", err.message);
      return new Map();
    }
  }

  /**
   * Fetches a MAC -> { rx, tx } map using the full MAC-keyed get_clientlist response.
   * ASUS routers expose curRx/curTx (per-session bytes) and totalRx/totalTx per device.
   * Returns an empty map if the router does not expose these fields.
   */
  async fetchClientTrafficMap(clients = null) {
    try {
      const raw = await this.appGet("get_clientlist");
      const list = raw?.get_clientlist || raw || {};
      const trafficMap = new Map();

      // The full MAC-keyed object looks like { "AA:BB:...": { curRx, curTx, totalRx, totalTx, ... }, maclist: "..." }
      for (const [key, entry] of Object.entries(list)) {
        if (
          key === "maclist" ||
          key === "namelist" ||
          key === "iplist" ||
          key === "rssiList"
        )
          continue;
        if (!entry || typeof entry !== "object") continue;
        const mac = this.normalizeMac(key);
        if (!mac || mac.length < 11) continue; // skip non-MAC keys

        // curRx/curTx are current session bytes; totalRx/totalTx are cumulative
        const rx = Number(entry.curRx ?? entry.totalRx ?? entry.rx ?? 0) || 0;
        const tx = Number(entry.curTx ?? entry.totalTx ?? entry.tx ?? 0) || 0;
        trafficMap.set(mac, { rx, tx, ip: entry.ip || "" });
      }

      // If the router's clientlist has no traffic data but SSH is available,
      // try iptables-based per-IP traffic counting and merge by IP -> MAC
      const hasAnyTraffic = Array.from(trafficMap.values()).some(
        (v) => v.rx > 0 || v.tx > 0,
      );

      if (!hasAnyTraffic && ROUTER_USE_SSH && clients && clients.length > 0) {
        const onlineIps = clients
          .filter((c) => c.ip && c.online !== false)
          .map((c) => c.ip);

        if (onlineIps.length > 0) {
          const ipTraffic = await this.fetchPerDeviceTrafficViaSSH(onlineIps);

          if (ipTraffic.size > 0) {
            // Map the IP-keyed SSH data back onto MAC keys using the client list
            for (const client of clients) {
              if (!client.ip || !client.mac) continue;
              const ipData = ipTraffic.get(client.ip);
              if (ipData) {
                const mac = this.normalizeMac(client.mac);
                trafficMap.set(mac, {
                  rx: ipData.rx,
                  tx: ipData.tx,
                  ip: client.ip,
                });
              }
            }
          }
        }
      }

      return trafficMap;
    } catch (err) {
      console.warn("[ASUS] fetchClientTrafficMap failed:", err.message);
      return new Map();
    }
  }

  async getConnectedClientsFromAppGet() {
    await this.ensureLogin();
    const raw = await this.appGet("get_clientlist");
    const parsed = this.parseClientListEntries(raw);

    const basicClients = parsed.map((entry) => ({
      mac: this.normalizeMac(entry.mac),
      ip: String(entry.ip || "").trim(),
      online: Boolean(entry.online),
    }));

    const trafficMap = await this.fetchClientTrafficMap(basicClients);

    const clients = parsed.map((entry) => {
      const cleanMac = this.normalizeMac(entry.mac);
      const online = Boolean(entry.online);
      const traffic = trafficMap.get(cleanMac) || { rx: 0, tx: 0 };
      const rx = Number(entry.rx || traffic.rx) || 0;
      const tx = Number(entry.tx || traffic.tx) || 0;
      const bandwidthKbps = rx + tx;
      return {
        mac: cleanMac,
        name: this.getDeviceName(entry) || `Device-${cleanMac.slice(-4)}`,
        ip: String(entry.ip || "").trim(),
        online,
        rx,
        tx,
        rssi: entry.rssi || 0,
        linkType: entry.linkType || "unknown",
        connectionMethod: entry.connectionMethod || "unknown",
        connectionLabel: entry.connectionLabel || "Unknown",
        activity: entry.activity || (online ? "Connected" : "Offline"),
        blocked: blockedMacs.has(cleanMac),
        status: blockedMacs.has(cleanMac)
          ? "blocked"
          : online
            ? "online"
            : "offline",
        bandwidth: online ? formatBandwidth(bandwidthKbps) : "0 Kbps",
        bandwidthKbps,
      };
    });

    return this.dedupeClientsByMac(clients);
  }

  getMockClients() {
    return MOCK_WORKSTATIONS.map((pc) => ({
      ...pc,
      blocked: blockedMacs.has(pc.mac),
      status:
        pc.online && !blockedMacs.has(pc.mac)
          ? "online"
          : blockedMacs.has(pc.mac)
            ? "blocked"
            : "offline",
      bandwidth: formatBandwidth(pc.rx + pc.tx),
      bandwidthKbps: pc.rx + pc.tx,
    }));
  }

  async getConnectedClients() {
    if (this.mockMode) return this.getMockClients();

    try {
      await this.ensureAsusWrtReady();
      const devices = (this.asusWrt.allClients || []).flatMap(
        (client) => client.connectedDevices || [],
      );

      if (devices.length === 0) {
        return this.getConnectedClientsFromAppGet();
      }

      // Build a basic client list to pass as hint to fetchClientTrafficMap
      const basicClients = devices.map((device) => ({
        mac: this.normalizeMac(device.mac),
        ip: String(device.ip || device.host || "").trim(),
        online: this.isDeviceOnline(device),
      }));

      // The node-asuswrt library does NOT provide rx/tx — supplement with the
      // full MAC-keyed clientlist which has curRx/curTx per device.
      // If that also returns zeros, the SSH iptables fallback is triggered.
      const trafficMap = await this.fetchClientTrafficMap(basicClients);

      const clients = devices.map((device) => {
        const cleanMac = this.normalizeMac(device.mac);
        const online = this.isDeviceOnline(device);
        const traffic = trafficMap.get(cleanMac) || { rx: 0, tx: 0 };
        const rx = Number(device.rx || device.rxBytes || traffic.rx) || 0;
        const tx = Number(device.tx || device.txBytes || traffic.tx) || 0;
        const bandwidthKbps = rx + tx;
        const conn = this.resolveConnectionInfo(device);
        return {
          mac: cleanMac,
          name: this.getDeviceName(device) || `Device-${cleanMac.slice(-4)}`,
          ip: String(device.ip || device.host || "").trim(),
          online,
          rx,
          tx,
          rssi: Number(device.rssi) || 0,
          linkType: conn.linkType,
          connectionMethod: conn.connectionMethod,
          connectionLabel: conn.connectionLabel,
          activity: online ? this.deriveDeviceActivity(device) : "Offline",
          blocked: blockedMacs.has(cleanMac),
          status: blockedMacs.has(cleanMac)
            ? "blocked"
            : online
              ? "online"
              : "offline",
          bandwidth: online ? formatBandwidth(bandwidthKbps) : "0 Kbps",
          bandwidthKbps,
        };
      });

      return this.dedupeClientsByMac(clients);
    } catch (err) {
      console.warn(
        "[ASUS] AsusWrt library unreachable, using appGet fallback:",
        err.message,
      );
      return this.getConnectedClientsFromAppGet();
    }
  }

  async getNetworkOverview() {
    const clients = await this.getConnectedClients();
    const online = clients.filter((c) => c.status === "online");

    // Prefer live SSH-based speed measurement for the overview bandwidth card.
    // Falls back to the sum of per-device bandwidthKbps when SSH is unavailable.
    let totalBandwidthKbps = online.reduce(
      (sum, c) => sum + (c.bandwidthKbps || 0),
      0,
    );
    let totalBandwidthStr = formatBandwidth(totalBandwidthKbps);

    if (!this.mockMode && ROUTER_USE_SSH) {
      try {
        const speed = await this.getCurrentTrafficSpeed();
        if (speed && (speed.downloadKBs > 0 || speed.uploadKBs > 0)) {
          const combinedKBs = (speed.downloadKBs || 0) + (speed.uploadKBs || 0);
          // Convert KB/s -> Kbps (×8) for display consistency
          totalBandwidthKbps = Number((combinedKBs * 8).toFixed(2));
          totalBandwidthStr = `↓ ${speed.downloadKBs.toFixed(1)} KB/s · ↑ ${speed.uploadKBs.toFixed(1)} KB/s`;
        }
      } catch (err) {
        console.warn(
          "[ASUS] getNetworkOverview speed fetch failed:",
          err.message,
        );
      }
    }

    if (this.mockMode) {
      return {
        connectedCount: online.length,
        totalClients: clients.length,
        totalBandwidth: formatBandwidth(totalBandwidthKbps),
        totalBandwidthKbps,
        networkStatus: "Healthy",
        wanStatus: "Connected",
      };
    }

    try {
      await this.ensureAsusWrtReady();
      const wanInfo = (await this.routerClient?.getWANStatus()) || {};
      return {
        connectedCount: online.length,
        totalClients: clients.length,
        totalBandwidth: totalBandwidthStr,
        totalBandwidthKbps,
        networkStatus: online.length > 0 ? "Healthy" : "No active clients",
        wanStatus:
          wanInfo.status ?? wanInfo.link ?? wanInfo.wanlink ?? "Connected",
      };
    } catch {
      return {
        connectedCount: online.length,
        totalClients: clients.length,
        totalBandwidth: totalBandwidthStr,
        totalBandwidthKbps,
        networkStatus: "Healthy",
        wanStatus: "Unknown",
      };
    }
  }

  async getTrafficStats() {
    const now = Date.now();
    const elapsedSeconds = Math.max(
      (now - this.lastClientSnapshot.timestamp) / 1000,
      0.5,
    );
    const clients = await this.getConnectedClients();

    const trafficStats = clients
      .filter((c) => c.online)
      .map((c) => {
        const currentRx = Number(c.rx || 0);
        const currentTx = Number(c.tx || 0);
        const previous = this.lastClientSnapshot.clients.get(c.mac);

        const download = previous
          ? Number(
              (
                Math.max(currentRx - previous.rx, 0) /
                1024 /
                elapsedSeconds
              ).toFixed(2),
            )
          : 0;
        const upload = previous
          ? Number(
              (
                Math.max(currentTx - previous.tx, 0) /
                1024 /
                elapsedSeconds
              ).toFixed(2),
            )
          : 0;

        const bandwidthKbps = Number((download + upload).toFixed(2));

        return {
          name: c.name,
          mac: c.mac,
          ip: c.ip,
          status: c.status,
          download,
          upload,
          bandwidthKbps,
          bandwidth: formatBandwidth(bandwidthKbps),
        };
      })
      .sort((a, b) => b.bandwidthKbps - a.bandwidthKbps);

    this.lastClientSnapshot = {
      timestamp: now,
      clients: new Map(
        clients.map((c) => [
          c.mac,
          {
            rx: Number(c.rx || 0),
            tx: Number(c.tx || 0),
          },
        ]),
      ),
    };

    return trafficStats;
  }

  async isPrivateIp(address) {
    return /^(10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)/.test(
      String(address || ""),
    );
  }

  async resolveHost(ip) {
    try {
      const names = await dns.promises.reverse(ip);
      return names?.[0] || ip;
    } catch {
      return ip;
    }
  }

  async parseConntrackSites(raw, clientIps) {
    const sitesByIp = {};
    const ipSet = new Set(clientIps.filter(Boolean));
    const lines = String(raw || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const tokens = line.split(/\s+/);
      const props = {};
      for (const token of tokens) {
        const [key, value] = token.split("=");
        if (value !== undefined) props[key] = value;
      }

      const src = props.src;
      const dst = props.dst;
      if (!src || !dst) continue;

      const srcIsClient = ipSet.has(src);
      const dstIsClient = ipSet.has(dst);
      const srcPrivate = await this.isPrivateIp(src);
      const dstPrivate = await this.isPrivateIp(dst);

      let clientIp;
      let remoteIp;
      if (srcIsClient && dst && !dstPrivate) {
        clientIp = src;
        remoteIp = dst;
      } else if (dstIsClient && src && !srcPrivate) {
        clientIp = dst;
        remoteIp = src;
      } else {
        continue;
      }

      const port = props.dport || props.sport || props.port || "";
      const domainName = this.getDomainForIp(remoteIp);
      const display = domainName
        ? domainName
        : port
          ? `${remoteIp}:${port}`
          : remoteIp;

      sitesByIp[clientIp] = sitesByIp[clientIp] || new Set();
      sitesByIp[clientIp].add(display);
    }

    return Object.fromEntries(
      Object.entries(sitesByIp).map(([ip, hostSet]) => [
        ip,
        Array.from(hostSet).slice(0, 12),
      ]),
    );
  }

  async getClientOpenSites(clients) {
    return Object.fromEntries(clients.map((client) => [client.ip, []]));
  }

  async getInternetActivity() {
    const clients = await this.getConnectedClients();
    const onlineClients = clients.filter((c) => c.status === "online");

    return onlineClients.map((c) => ({
      workstation: c.name,
      ip: c.ip,
      activity: c.activity || "Browsing",
      bandwidth: c.bandwidth,
      sites: [],
    }));
  }

  async parseOoklaServers(raw) {
    if (!raw) return [];

    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return [];
      }
    }

    if (Array.isArray(raw)) return raw;

    const extractArray = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      if (value && typeof value === "object") {
        return Object.values(value).flatMap((v) => (Array.isArray(v) ? v : []));
      }
      return [];
    };

    const candidates = [
      raw.get_ookla_speedtest_get_servers,
      raw.ookla_speedtest_get_servers,
      raw.data,
      raw.result,
      raw.get_ookla_speedtest_get_servers?.data,
      raw.ookla_speedtest_get_servers?.data,
    ];

    for (const candidate of candidates) {
      const servers = extractArray(candidate);
      if (servers.length) return servers;
    }

    for (const key of Object.keys(raw)) {
      const servers = extractArray(raw[key]);
      if (servers.length) return servers;
    }

    return [];
  }

  async getOoklaServersSafe() {
    if (!this.routerClient) {
      throw new Error("Router client is not initialized");
    }

    try {
      return await this.routerClient.getOoklaServers();
    } catch (err) {
      const raw = await this.routerClient.appGet(
        "ookla_speedtest_get_servers()",
        (data) => data,
      );
      const servers = await this.parseOoklaServers(raw);
      if (servers.length) return servers;
      throw new Error(
        `Unable to parse Ookla servers from router response: ${JSON.stringify(raw)}`,
      );
    }
  }

  async measureDownload() {
    let lastError;
    for (const url of SPEEDTEST_DOWNLOAD_URLS) {
      const start = Date.now();
      try {
        const response = await axios.get(url, {
          timeout: 20000,
          maxRedirects: 5,
          responseType: "arraybuffer",
          validateStatus: (status) => status >= 200 && status < 300,
        });
        const bytes = response.data?.byteLength || 0;
        if (bytes === 0) {
          throw new Error(`Download request returned no data for ${url}`);
        }
        const durationSeconds = Math.max((Date.now() - start) / 1000, 0.001);
        return Number(((bytes * 8) / (durationSeconds * 1000000)).toFixed(2));
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `Download measurement failed: ${lastError?.message || "no endpoint available"}`,
    );
  }

  async measureUpload() {
    const size = 1 * 1024 * 1024;
    const body = Buffer.alloc(size, 0);
    let lastError;
    for (const url of SPEEDTEST_UPLOAD_URLS) {
      const start = Date.now();
      try {
        const response = await axios.post(url, body, {
          timeout: 20000,
          maxRedirects: 5,
          headers: { "Content-Type": "application/octet-stream" },
          responseType: "json",
          validateStatus: (status) => status >= 200 && status < 300,
        });
        if (!response.data) {
          throw new Error(`Upload request returned no data for ${url}`);
        }
        const durationSeconds = Math.max((Date.now() - start) / 1000, 0.001);
        return Number(((size * 8) / (durationSeconds * 1000000)).toFixed(2));
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `Upload measurement failed: ${lastError?.message || "no endpoint available"}`,
    );
  }

  async measurePing() {
    let lastError;
    for (const url of SPEEDTEST_PING_URLS) {
      const start = Date.now();
      try {
        const response = await axios.get(url, {
          timeout: 10000,
          maxRedirects: 5,
          responseType: "text",
          validateStatus: (status) => status === 204 || status === 200,
        });
        if (response.status !== 204 && response.status !== 200) {
          throw new Error(
            `Ping request failed (${response.status}) for ${url}`,
          );
        }
        return Date.now() - start;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `Ping measurement failed: ${lastError?.message || "no endpoint available"}`,
    );
  }

  async runSpeedTest() {
    if (this.mockMode) {
      await new Promise((r) => setTimeout(r, 2500));
      return {
        downloadMbps: 85.4 + Math.random() * 10,
        uploadMbps: 42.1 + Math.random() * 5,
        pingMs: 12 + Math.floor(Math.random() * 8),
        server: "Mock - PLDT Manila",
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const pingMs = await this.measurePing();
      const downloadMbps = await this.measureDownload();
      const uploadMbps = await this.measureUpload();
      return {
        downloadMbps,
        uploadMbps,
        pingMs,
        server: "Custom speed test",
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        downloadMbps: 0,
        uploadMbps: 0,
        pingMs: 0,
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async setClientConnection(mac, connect) {
    const normalized = String(mac || "")
      .trim()
      .toUpperCase();

    if (!normalized) {
      return {
        success: false,
        mac: normalized,
        connected: connect,
        error: "Invalid MAC address",
      };
    }

    if (connect) {
      blockedMacs.delete(normalized);
    } else {
      blockedMacs.add(normalized);
    }

    if (this.mockMode) {
      return { success: true, mac: normalized, connected: connect };
    }

    try {
      const clients = await this.getConnectedClients();
      const existing = clients.find((c) => c.mac === normalized);
      const deviceName = String(
        existing?.name || `Device-${normalized.slice(-4)}`,
      ).trim();
      let result;
      if (ROUTER_USE_SSH) {
        result = connect
          ? await this.unblockDeviceViaSSH(normalized)
          : await this.blockDeviceViaSSH(normalized);
      } else {
        result = await this.controlInternetAccess(
          normalized,
          deviceName,
          !connect,
        );
      }

      if (!result.success) {
        return {
          success: false,
          mac: normalized,
          connected: connect,
          error: result.error || `Router returned status ${result.status}`,
          response: result.responseBody || result.stderr || result.stdout,
        };
      }

      return { success: true, mac: normalized, connected: connect };
    } catch (err) {
      return {
        success: false,
        mac: normalized,
        connected: connect,
        error: err.message,
      };
    }
  }

  normalizeDomain(domain) {
    return String(domain || "")
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .replace(/\?.*$/, "")
      .replace(/#.*$/, "")
      .replace(/\.$/, "")
      .toLowerCase();
  }

  isValidDomain(domain) {
    const clean = String(domain || "")
      .trim()
      .toLowerCase();
    if (!clean) return false;
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(
      clean,
    );
  }

  buildUrlRulelist(sites) {
    return Array.from(new Set(sites))
      .map((site) => this.normalizeDomain(site))
      .filter((site) => site && this.isValidDomain(site))
      .map((site) => `<1>ALL>${site}`)
      .join("");
  }

  parseRestrictedSitesList(raw) {
    return Array.from(
      new Set(
        String(raw || "")
          .split("<")
          .map((item) => {
            // Remove the router prefix if it exists (e.g., "1>ALL>") by getting everything after the last ">"
            const cleanItem = item.trim().split(">").pop();
            return this.normalizeDomain(cleanItem);
          })
          .filter((item) => item && this.isValidDomain(item)),
      ),
    );
  }

  async writeRestrictedSitesViaSsh(sites) {
    const cleaned = this.buildUrlRulelist(sites);
    const safeList = cleaned.replace(/(["\\])/g, "\\$1");

    const enabled = sites.length ? 1 : 0;
    const command = `nvram set url_rulelist="${safeList}"
nvram set url_enable_x=${enabled}
nvram set url_filter_enable=${enabled}
nvram commit
/sbin/rc_service restart_firewall`;
    await this.executeSshCommand(command);
  }

  async syncRestrictedSitesFromRouter() {
    if (this.mockMode) return Array.from(restrictedSites);
    if (!ROUTER_USE_SSH) return Array.from(restrictedSites);

    const { stdout: listOutput } = await this.executeSshCommand(
      "nvram get url_rulelist || true",
    );
    const { stdout: enableXOutput } = await this.executeSshCommand(
      "nvram get url_enable_x || true",
    );
    const { stdout: filterEnableOutput } = await this.executeSshCommand(
      "nvram get url_filter_enable || true",
    );

    const sites = this.parseRestrictedSitesList(listOutput);
    const normalized = this.buildUrlRulelist(sites);
    const rawValue = String(listOutput || "").trim();
    const enableX = String(enableXOutput || "").trim();
    const filterEnable = String(filterEnableOutput || "").trim();
    const shouldRewrite =
      rawValue !== normalized ||
      (sites.length > 0 && (enableX !== "1" || filterEnable !== "1")) ||
      (sites.length === 0 && (enableX !== "0" || filterEnable !== "0"));

    if (shouldRewrite) {
      await this.writeRestrictedSitesViaSsh(sites);
    }
    restrictedSites.clear();
    sites.forEach((site) => restrictedSites.add(site));
    return sites;
  }

  isBlockedDomain(domain) {
    const clean = this.normalizeDomain(domain);
    if (!clean) return false;
    const matched = Array.from(restrictedSites).some(
      (blocked) => clean === blocked || clean.endsWith(`.${blocked}`),
    );
    if (matched) {
      console.log(`[ASUS] isBlockedDomain matched: ${domain} -> ${clean}`);
    }
    return matched;
  }

  getRestrictedSitesList() {
    return Array.from(restrictedSites).map((url) => ({ url }));
  }

  async getRestrictedSites() {
    if (this.mockMode) {
      return this.getRestrictedSitesList();
    }

    try {
      await this.syncRestrictedSitesFromRouter();
    } catch (err) {
      console.warn("[ASUS] Failed to sync restricted sites:", err.message);
    }

    return this.getRestrictedSitesList();
  }

  async addRestrictedSite(url) {
    const clean = this.normalizeDomain(url);
    if (!clean || !this.isValidDomain(clean)) {
      throw new Error(
        "Invalid URL or domain. Use a hostname like example.com.",
      );
    }
    if (restrictedSites.has(clean)) {
      return { url: clean, active: true, alreadyBlocked: true };
    }

    if (!this.mockMode && ROUTER_USE_SSH) {
      await this.addRestrictedSiteViaSsh(clean);
    } else if (!this.mockMode) {
      const urlList = this.buildUrlRulelist([...restrictedSites, clean]);
      try {
        await this.ensureLogin();
        await this.appSet({
          hook: "set_url_filter",
          url_list: urlList,
          enable: "1",
        });
      } catch (err) {
        console.warn("[ASUS] URL filter apply:", err.message);
        throw err;
      }
    }

    restrictedSites.add(clean);
    return { url: clean, active: true };
  }

  async addRestrictedSiteViaSsh(site) {
    const safeSite = site.replace(/(["\\])/g, "\\$1");
    const command = `current_list=$(nvram get url_rulelist || true)
if printf '%s\n' "$current_list" | tr '<' '\n' | grep -xF -- "1>ALL>${safeSite}" >/dev/null 2>&1; then
  nvram set url_enable_x=1
  nvram set url_filter_enable=1
  nvram commit
  /sbin/rc_service restart_firewall
  echo "already-enabled"
else
  if [ -z "$current_list" ]; then
    nvram set url_rulelist="<1>ALL>${safeSite}"
  else
    nvram set url_rulelist="\${current_list}<1>ALL>${safeSite}"
  fi
  nvram set url_enable_x=1
  nvram set url_filter_enable=1
  nvram commit
  /sbin/rc_service restart_firewall
  echo "added"
fi`;

    const { stdout } = await this.executeSshCommand(command);
    return stdout.includes("added")
      ? { success: true, added: true }
      : { success: true, added: false };
  }

  async removeRestrictedSite(url) {
    const clean = this.normalizeDomain(url);
    if (!clean || !this.isValidDomain(clean)) {
      throw new Error(
        "Invalid URL or domain. Use a hostname like example.com.",
      );
    }
    if (!restrictedSites.has(clean) && this.mockMode) {
      return { success: true };
    }

    const remainingSites = Array.from(restrictedSites).filter(
      (item) => item !== clean,
    );

    if (!this.mockMode && ROUTER_USE_SSH) {
      await this.removeRestrictedSiteViaSsh(clean);
    } else if (!this.mockMode) {
      const urlList = this.buildUrlRulelist(remainingSites);
      try {
        await this.ensureLogin();
        await this.appSet({
          hook: "set_url_filter",
          url_list: urlList,
          enable: urlList ? "1" : "0",
        });
      } catch (err) {
        console.warn("[ASUS] URL filter remove:", err.message);
        throw err;
      }
    }

    restrictedSites.delete(clean);
    return { success: true };
  }

  async removeAllRestrictedSites() {
    if (this.mockMode) {
      restrictedSites.clear();
      return { success: true };
    }

    if (!this.mockMode && ROUTER_USE_SSH) {
      await this.writeRestrictedSitesViaSsh([]);
    } else if (!this.mockMode) {
      try {
        await this.ensureLogin();
        await this.appSet({
          hook: "set_url_filter",
          url_list: "",
          enable: "0",
        });
      } catch (err) {
        console.warn("[ASUS] URL filter clear:", err.message);
        throw err;
      }
    }

    restrictedSites.clear();
    return { success: true };
  }

  async removeRestrictedSiteViaSsh(site) {
    const safeSite = site.replace(/(["\\])/g, "\\$1");
    const command = `current_list=$(nvram get url_rulelist || true)
new_list=$(printf '%s\n' "$current_list" | tr '<' '\n' | awk -v site="1>ALL>${safeSite}" 'BEGIN{first=1} $0!=site && $0!=""{ if(!first) printf "<"; printf $0; first=0 }')
if [ -n "$new_list" ]; then
  new_list="<$new_list"
fi
if [ "$new_list" != "$current_list" ]; then
  nvram set url_rulelist="$new_list"
  if [ -z "$new_list" ]; then
    nvram set url_enable_x=0
    nvram set url_filter_enable=0
  fi
  nvram commit
  /sbin/rc_service restart_firewall
  echo "removed"
else
  echo "notfound"
fi`;

    const { stdout } = await this.executeSshCommand(command);
    return stdout.includes("removed")
      ? { success: true, removed: true }
      : { success: true, removed: false };
  }

  async getAnalytics() {
    const clients = await this.getConnectedClients();
    const connectedClients = clients.filter((c) => c.status === "online");
    const online = connectedClients.length;
    const blocked = clients.filter((c) => c.status === "blocked").length;
    const totalBandwidthKbps = connectedClients.reduce(
      (total, client) => total + (Number(client.bandwidthKbps) || 0),
      0,
    );
    const topBandwidth = [...clients]
      .sort((a, b) => (b.bandwidthKbps || 0) - (a.bandwidthKbps || 0))
      .slice(0, 5);

    return {
      summary: {
        totalWorkstations: clients.length,
        online,
        offline: clients.length - online - blocked,
        blocked,
        restrictedSites: restrictedSites.size,
        totalBandwidthKbps,
        totalBandwidth: formatBandwidth(totalBandwidthKbps),
      },
      topBandwidth,
    };
  }
}

export const asusRouter = new AsusRouterService();
