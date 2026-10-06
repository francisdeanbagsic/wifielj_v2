const MAX_HISTORY = 50;

function normalizeMac(mac) {
  return String(mac || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

export class AnnouncementHub {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, Set<import('socket.io').Socket>>} */
    this.agentsByMac = new Map();
    this.history = [];
  }

  registerAgent(socket) {
    const mac = normalizeMac(socket.mac);
    if (!mac) return;

    socket.mac = mac;
    socket.join(`lab:${mac}`);
    socket.join("lab:all");

    if (!this.agentsByMac.has(mac)) {
      this.agentsByMac.set(mac, new Set());
    }
    this.agentsByMac.get(mac).add(socket);

    socket.emit("lab:announce:registered", {
      mac,
      name: socket.labName || "",
      serverTime: Date.now(),
    });

    this._notifyAdminsAgentsChanged();
  }

  unregisterAgent(socket) {
    const mac = normalizeMac(socket.mac);
    if (!mac) return;

    const set = this.agentsByMac.get(mac);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.agentsByMac.delete(mac);
    }

    this._notifyAdminsAgentsChanged();
  }

  listConnectedAgents() {
    const list = [];
    for (const [mac, sockets] of this.agentsByMac) {
      const first = sockets.values().next().value;
      list.push({
        mac,
        name: first?.labName || "",
        connections: sockets.size,
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  getHistory() {
    return [...this.history].reverse();
  }

  /**
   * @param {{ title?: string, message: string, target: 'all' | 'selected', macs?: string[] }}
   */
  broadcast({ title, message, target, macs = [], sentBy = "admin" }) {
    const text = String(message || "").trim();
    if (!text) {
      throw new Error("Message is required.");
    }

    const payload = {
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: String(title || "Lab Announcement").trim() || "Lab Announcement",
      message: text,
      timestamp: new Date().toISOString(),
      from: sentBy,
    };

    let targetMacs = [];
    if (target === "all") {
      this.io.to("lab:all").emit("lab:announce", payload);
      targetMacs = ["*"];
    } else {
      targetMacs = [...new Set(macs.map(normalizeMac).filter(Boolean))];
      if (targetMacs.length === 0) {
        throw new Error("Select at least one workstation.");
      }
      for (const mac of targetMacs) {
        this.io.to(`lab:${mac}`).emit("lab:announce", payload);
      }
    }

    const agents = this.listConnectedAgents();
    const agentMacs = new Set(agents.map((a) => a.mac));

    let deliveredTo = 0;
    if (target === "all") {
      deliveredTo = agents.length;
    } else {
      deliveredTo = targetMacs.filter((m) => agentMacs.has(m)).length;
    }

    const record = {
      ...payload,
      target,
      targetMacs: target === "all" ? ["all"] : targetMacs,
      deliveredTo,
      requestedCount: target === "all" ? null : targetMacs.length,
    };

    this.history.push(record);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    this.io.to("admin").emit("lab:announce:sent", record);

    return record;
  }

  _notifyAdminsAgentsChanged() {
    this.io.to("admin").emit("lab:agents", {
      agents: this.listConnectedAgents(),
      timestamp: Date.now(),
    });
  }
}

export { normalizeMac };
