import { useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../api";
import { useSocket } from "../context/SocketContext";
import { maskIdentifier } from "../utils/privacy";
import "./AnnouncementPanel.css";

function normalizeMac(mac) {
  return String(mac || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

export default function AnnouncementPanel({ workstations, hideIdentifiers }) {
  const { connectedAgents } = useSocket();
  const [title, setTitle] = useState("Lab Announcement");
  const [message, setMessage] = useState("");
  const [targetMode, setTargetMode] = useState("all");
  const [selectedMacs, setSelectedMacs] = useState(new Set());
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const agentMacSet = useMemo(
    () => new Set((connectedAgents || []).map((a) => normalizeMac(a.mac))),
    [connectedAgents],
  );

  const onlineWorkstations = useMemo(
    () =>
      workstations.filter(
        (w) => w.status === "online" || w.online === true,
      ),
    [workstations],
  );

  useEffect(() => {
    if (!expanded) return;
    api.announcementAgents().catch(() => {});
  }, [expanded]);

  const toggleMac = (mac) => {
    const key = normalizeMac(mac);
    setSelectedMacs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllOnline = () => {
    setSelectedMacs(
      new Set(onlineWorkstations.map((w) => normalizeMac(w.mac))),
    );
  };

  const clearSelection = () => setSelectedMacs(new Set());

  const handleSend = async () => {
    const text = message.trim();
    if (!text) {
      setResult({ error: "Please enter a message." });
      return;
    }

    const macs =
      targetMode === "selected" ? Array.from(selectedMacs) : undefined;

    if (targetMode === "selected" && macs.length === 0) {
      setResult({ error: "Select at least one PC, or choose All online PCs." });
      return;
    }

    if (
      !window.confirm(
        targetMode === "all"
          ? "Send this announcement to ALL lab PCs with the receiver running?"
          : `Send to ${macs.length} selected PC(s)?`,
      )
    ) {
      return;
    }

    setSending(true);
    setResult(null);
    try {
      const res = await api.sendAnnouncement({
        title: title.trim() || "Lab Announcement",
        message: text,
        target: targetMode,
        macs,
      });
      setResult({
        success: true,
        deliveredTo: res.deliveredTo,
        requestedCount: res.requestedCount,
        target: res.target,
      });
      setMessage("");
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setSending(false);
      setTimeout(() => setResult(null), 6000);
    }
  };

  const agentsCount = connectedAgents?.length ?? 0;

  return (
    <motion.div
      className="announce-panel"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <button
        type="button"
        className="announce-panel-toggle"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="announce-panel-toggle-title">
          Broadcast announcement
        </span>
        <span className="announce-agent-badge">
          {agentsCount} receiver{agentsCount !== 1 ? "s" : ""} online
        </span>
        <span className="announce-chevron">{expanded ? "▲" : "▼"}</span>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            className="announce-panel-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <p className="announce-hint">
              Student PCs need the{" "}
              <strong>lab client</strong> or{" "}
              <strong>browser receiver</strong> running. Only those show a
              pop-up; others appear in the router list but will not get the
              message.
            </p>

            <div className="announce-fields">
              <label>
                Title
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={80}
                  placeholder="Lab Announcement"
                />
              </label>
              <label>
                Message
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="Type your message to students…"
                />
              </label>
            </div>

            <div className="announce-target-row">
              <span className="announce-target-label">Send to:</span>
              <label className="announce-radio">
                <input
                  type="radio"
                  name="announceTarget"
                  checked={targetMode === "all"}
                  onChange={() => setTargetMode("all")}
                />
                All PCs with receiver running
              </label>
              <label className="announce-radio">
                <input
                  type="radio"
                  name="announceTarget"
                  checked={targetMode === "selected"}
                  onChange={() => setTargetMode("selected")}
                />
                Selected PCs only
              </label>
            </div>

            {targetMode === "selected" && (
              <div className="announce-select-block">
                <div className="announce-select-actions">
                  <button type="button" className="link-btn" onClick={selectAllOnline}>
                    Select all online
                  </button>
                  <button type="button" className="link-btn" onClick={clearSelection}>
                    Clear
                  </button>
                  <span className="announce-select-count">
                    {selectedMacs.size} selected
                  </span>
                </div>
                <div className="announce-chip-grid">
                  {workstations.map((pc) => {
                    const mac = normalizeMac(pc.mac);
                    const checked = selectedMacs.has(mac);
                    const hasAgent = agentMacSet.has(mac);
                    return (
                      <label
                        key={mac}
                        className={`announce-chip ${checked ? "checked" : ""} ${!hasAgent ? "no-agent" : ""}`}
                        title={
                          hasAgent
                            ? "Receiver connected"
                            : "No receiver — message will not pop up"
                        }
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleMac(mac)}
                        />
                        <span>{pc.name || maskIdentifier(mac, hideIdentifiers)}</span>
                        {hasAgent && <span className="chip-dot" />}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="announce-send-row">
              <button
                type="button"
                className="btn-announce-send"
                disabled={sending || !message.trim()}
                onClick={handleSend}
              >
                {sending ? "Sending…" : "Send announcement"}
              </button>
            </div>

            <AnimatePresence>
              {result && (
                <motion.div
                  className={`announce-result ${result.error ? "error" : "success"}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  {result.error
                    ? result.error
                    : result.target === "all"
                      ? `Sent. ${result.deliveredTo} PC(s) with receiver got the pop-up.`
                      : `Sent to ${result.requestedCount} PC(s). ${result.deliveredTo} had receiver connected.`}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
