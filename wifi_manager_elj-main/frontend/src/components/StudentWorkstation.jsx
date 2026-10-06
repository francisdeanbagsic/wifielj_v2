import { useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  HiChevronDown,
  HiComputerDesktop,
  HiQuestionMarkCircle,
} from "react-icons/hi2";
import { FaNetworkWired } from "react-icons/fa";
import { RiWirelessChargingFill } from "react-icons/ri";
import { api } from "../api";
import { useSocket } from "../context/SocketContext";
import { maskIdentifier } from "../utils/privacy";
import AnnouncementPanel from "./AnnouncementPanel";
import "../components/shared.css";
import "./StudentWorkstation.css";

function normalizeMac(mac) {
  return String(mac || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

function getBandLabel(pc) {
  const method = pc.connectionMethod;
  if (method === "2g") return "2.4 GHz";
  if (method === "5g") return "5 GHz";
  if (method === "6g" || method === "7g") return "6 GHz";
  if (pc.linkType === "wireless") return "Wi‑Fi";
  return null;
}

function getSignalBars(rssi) {
  const value = Number(rssi) || 0;
  if (value <= 0) return 0;
  if (value >= 70) return 4;
  if (value >= 55) return 3;
  if (value >= 40) return 2;
  return 1;
}

function countByStatus(devices) {
  return devices.reduce(
    (acc, d) => {
      const status = d.status || (d.online ? "online" : "offline");
      if (status === "online") acc.online += 1;
      else if (status === "blocked") acc.blocked += 1;
      else acc.offline += 1;
      return acc;
    },
    { online: 0, offline: 0, blocked: 0 },
  );
}

function DeviceRow({
  pc,
  hideIdentifiers,
  variant,
  showConnectionColumn,
  agentMacSet,
  toggling,
  bulking,
  onToggle,
}) {
  const isOnline = pc.status === "online";
  const firstSeenAt = pc.firstSeenAt ? Date.parse(pc.firstSeenAt) : NaN;
  const isNewDevice =
    isOnline &&
    Number.isFinite(firstSeenAt) &&
    Date.now() - firstSeenAt >= 0 &&
    Date.now() - firstSeenAt < 60 * 60 * 1000;
  const band = getBandLabel(pc);
  const signalBars = getSignalBars(pc.rssi);

  return (
    <motion.tr
      key={pc.mac}
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="ws-device-row"
    >
      <td>
        <div className="ws-device-name-cell">
          <span className={`ws-device-avatar ${variant}`} aria-hidden>
            {(pc.name || "?").charAt(0).toUpperCase()}
          </span>
          <div className="ws-device-meta">
            <strong>{pc.name}</strong>
            {variant !== "wireless" && (
              <span className="ws-device-mac">
                {maskIdentifier(pc.mac, hideIdentifiers)}
              </span>
            )}
          </div>
        </div>
      </td>
      <td>
        <code className="ws-device-ip">
          {maskIdentifier(pc.ip, hideIdentifiers)}
        </code>
      </td>
      {variant === "wireless" && (
        <td>
          <code
            className="ws-device-mac-cell"
            title={maskIdentifier(pc.mac || "Unknown MAC", hideIdentifiers)}
          >
            {maskIdentifier(pc.mac, hideIdentifiers)}
          </code>
        </td>
      )}
      {showConnectionColumn && (
        <td>
          <span className={`link-type-badge ${pc.linkType || "unknown"}`}>
            {pc.connectionLabel || "Unknown"}
          </span>
        </td>
      )}
      {variant === "wireless" && (
        <td>
          <div className="ws-signal-cell">
            {band && <span className="ws-band-badge">{band}</span>}
            {signalBars > 0 ? (
              <span
                className="ws-signal-bars"
                title={`Signal: ${pc.rssi} dBm`}
                aria-label={`Signal strength ${signalBars} of 4`}
              >
                {[1, 2, 3, 4].map((level) => (
                  <span
                    key={level}
                    className={`ws-signal-bar ${level <= signalBars ? "active" : ""}`}
                  />
                ))}
              </span>
            ) : (
              <span className="ws-signal-na">—</span>
            )}
          </div>
        </td>
      )}
      <td>
        <div className="ws-device-status-cell">
          <span
            className={`status-badge ${pc.status || (pc.online ? "online" : "offline")}`}
          >
            {pc.status || (pc.online ? "online" : "offline")}
          </span>
          {isNewDevice && <span className="ws-new-device-badge">NEW</span>}
        </div>
      </td>
      <td className="ws-bandwidth-cell ws-col-bandwidth">{pc.bandwidth || "0 Kbps"}</td>
      {variant !== "wireless" && (
        <td className="ws-col-receiver">
          {agentMacSet.has(normalizeMac(pc.mac)) ? (
            <span className="receiver-badge on" title="Can receive announcements">
              Ready
            </span>
          ) : (
            <span className="receiver-badge off" title="Install lab client">
              —
            </span>
          )}
        </td>
      )}
      <td>
        <button
          type="button"
          id={`btn-toggle-${pc.mac.replace(/:/g, "")}`}
          className={`btn-control ${isOnline ? "disconnect" : "connect"}`}
          disabled={toggling === pc.mac || !!bulking}
          onClick={() => onToggle(pc.mac, isOnline)}
          title={
            isOnline
              ? "Disconnect this device from the network"
              : "Restore internet access for this device"
          }
        >
          {toggling === pc.mac ? (
            <span className="btn-spinner" />
          ) : isOnline ? (
            <>
              <span className="btn-dot red" />
              Disconnect
            </>
          ) : (
            <>
              <span className="btn-dot green" />
              Connect
            </>
          )}
        </button>
      </td>
    </motion.tr>
  );
}

function ConnectionDevicePanel({
  variant,
  hideIdentifiers,
  title,
  subtitle,
  icon,
  devices,
  emptyMessage,
  emptyHint,
  collapsed,
  onToggleCollapse,
  showCollapse,
  showConnectionColumn,
  agentMacSet,
  toggling,
  bulking,
  onToggle,
}) {
  const counts = countByStatus(devices);
  const isWireless = variant === "wireless";

  return (
    <section
      className={`ws-connection-panel ws-connection-panel--${variant} ${collapsed ? "is-collapsed" : ""}`}
    >
      <header className="ws-connection-panel-header">
        <div className={`ws-connection-panel-icon ${variant}`}>{icon}</div>
        <div className="ws-connection-panel-titles">
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className="ws-connection-panel-stats">
          <span className="ws-mini-stat online">{counts.online} online</span>
          {counts.blocked > 0 && (
            <span className="ws-mini-stat blocked">{counts.blocked} blocked</span>
          )}
          {counts.offline > 0 && (
            <span className="ws-mini-stat offline">{counts.offline} offline</span>
          )}
        </div>
        <span className="ws-connection-panel-count">{devices.length}</span>
        {showCollapse && (
          <button
            type="button"
            className="ws-panel-collapse-btn"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          >
            <HiChevronDown />
          </button>
        )}
      </header>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            className="ws-connection-panel-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            {devices.length === 0 ? (
              <div className="ws-panel-empty">
                <div className="ws-panel-empty-icon">{icon}</div>
                <p className="ws-panel-empty-title">{emptyMessage}</p>
                {emptyHint && <p className="ws-panel-empty-hint">{emptyHint}</p>}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table ws-device-table">
                  <thead>
                    <tr>
                      <th>Computer</th>
                      <th>IP Address</th>
                      {isWireless && <th>MAC Address</th>}
                      {showConnectionColumn && <th>Connection</th>}
                      {isWireless && <th>Band / Signal</th>}
                      <th>Status</th>
                      <th className="ws-col-bandwidth">Bandwidth</th>
                      {!isWireless && (
                        <th className="ws-col-receiver" title="Announcement receiver">
                          Receiver
                        </th>
                      )}
                      <th>Control</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((pc) => (
                      <DeviceRow
                        key={pc.mac}
                        pc={pc}
                        hideIdentifiers={hideIdentifiers}
                        variant={variant}
                        showConnectionColumn={showConnectionColumn}
                        agentMacSet={agentMacSet}
                        toggling={toggling}
                        bulking={bulking}
                        onToggle={onToggle}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

const FILTER_TABS = [
  { id: "all", label: "All devices", icon: HiComputerDesktop },
  { id: "wireless", label: "Wireless", icon: RiWirelessChargingFill },
  { id: "wired", label: "Wired", icon: FaNetworkWired },
  { id: "unknown", label: "Unknown", icon: HiQuestionMarkCircle },
];

export default function StudentWorkstation({ hideIdentifiers }) {
  const { liveData, connectedAgents } = useSocket();
  const [overview, setOverview] = useState(null);
  const [workstations, setWorkstations] = useState([]);
  const [toggling, setToggling] = useState(null);
  const [bulking, setBulking] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);
  const [query, setQuery] = useState("");
  const [connectionFilter, setConnectionFilter] = useState("all");
  const [collapsedPanels, setCollapsedPanels] = useState({
    wireless: false,
    wired: false,
    unknown: false,
  });

  useEffect(() => {
    api.workstations().then((d) => {
      setOverview(d.overview);
      setWorkstations(d.workstations);
    });
  }, []);

  useEffect(() => {
    if (liveData?.overview) setOverview(liveData.overview);
    if (liveData?.workstations) setWorkstations(liveData.workstations);
  }, [liveData]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workstations;
    return workstations.filter(
      (w) =>
        (w.name || "").toLowerCase().includes(q) ||
        (w.ip || "").toLowerCase().includes(q) ||
        (w.mac || "").toLowerCase().includes(q) ||
        (w.status || "").toLowerCase().includes(q) ||
        (w.connectionLabel || "").toLowerCase().includes(q) ||
        (w.linkType || "").toLowerCase().includes(q),
    );
  }, [workstations, query]);

  const wirelessDevices = useMemo(
    () => filtered.filter((w) => w.linkType === "wireless"),
    [filtered],
  );

  const wiredDevices = useMemo(
    () => filtered.filter((w) => w.linkType === "wired"),
    [filtered],
  );

  const unknownDevices = useMemo(
    () =>
      filtered.filter(
        (w) => w.linkType !== "wireless" && w.linkType !== "wired",
      ),
    [filtered],
  );

  const tabCounts = useMemo(
    () => ({
      all: filtered.length,
      wireless: wirelessDevices.length,
      wired: wiredDevices.length,
      unknown: unknownDevices.length,
    }),
    [filtered, wirelessDevices, wiredDevices, unknownDevices],
  );

  const handleToggle = async (mac, currentlyConnected) => {
    setToggling(mac);
    try {
      await api.toggleWorkstation(mac, !currentlyConnected);
      const data = await api.workstations();
      setOverview(data.overview);
      setWorkstations(data.workstations);
    } finally {
      setToggling(null);
    }
  };

  const handleBulk = async (connect) => {
    const label = connect ? "connect all devices" : "disconnect all devices";
    if (!window.confirm(`Are you sure you want to ${label}?`)) return;

    setBulking(connect ? "connect" : "disconnect");
    setBulkResult(null);
    try {
      const result = await api.bulkToggle(connect);
      setBulkResult(result);
      const data = await api.workstations();
      setOverview(data.overview);
      setWorkstations(data.workstations);
    } catch (err) {
      setBulkResult({ error: err.message });
    } finally {
      setBulking(null);
      setTimeout(() => setBulkResult(null), 4000);
    }
  };

  const togglePanel = (key) => {
    setCollapsedPanels((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const onlineCount = workstations.filter((w) => w.status === "online").length;
  const blockedCount = workstations.filter(
    (w) => w.status === "blocked",
  ).length;
  const wirelessCount = workstations.filter(
    (w) => w.linkType === "wireless",
  ).length;
  const wiredCount = workstations.filter((w) => w.linkType === "wired").length;
  const isSearching = query.trim().length > 0;

  const agentMacSet = useMemo(
    () =>
      new Set((connectedAgents || []).map((a) => normalizeMac(a.mac))),
    [connectedAgents],
  );

  const stats = [
    { label: "Connected PCs", value: overview?.connectedCount ?? "—" },
    {
      label: "Wireless",
      value: wirelessCount,
      accent: "wireless",
      onClick: () => setConnectionFilter("wireless"),
    },
    {
      label: "Wired",
      value: wiredCount,
      accent: "wired",
      onClick: () => setConnectionFilter("wired"),
    },
    {
      label: "Total Bandwidth",
      value: overview?.totalBandwidth ?? "—",
      gold: true,
    },
    { label: "Network Status", value: overview?.networkStatus ?? "—" },
    { label: "WAN Status", value: overview?.wanStatus ?? "—" },
  ];

  const tableProps = {
    agentMacSet,
    hideIdentifiers,
    toggling,
    bulking,
    onToggle: handleToggle,
  };

  const showAllLayout = connectionFilter === "all";
  const showUnknownTab = tabCounts.unknown > 0 || connectionFilter === "unknown";

  const panels = [
    {
      key: "wireless",
      variant: "wireless",
      title: "Wireless Devices",
      subtitle: "Wi‑Fi connected lab PCs and mobile devices",
      icon: <RiWirelessChargingFill aria-hidden />,
      devices: wirelessDevices,
      emptyMessage: isSearching
        ? "No wireless devices match your search"
        : "No wireless devices connected",
      emptyHint: "Devices on Wi‑Fi will appear here automatically.",
      visible: showAllLayout || connectionFilter === "wireless",
    },
    {
      key: "wired",
      variant: "wired",
      title: "Wired Devices",
      subtitle: "Ethernet connected lab workstations",
      icon: <FaNetworkWired aria-hidden />,
      devices: wiredDevices,
      emptyMessage: isSearching
        ? "No wired devices match your search"
        : "No wired devices connected",
      emptyHint: "Lab PCs plugged into the router LAN ports show here.",
      visible: showAllLayout || connectionFilter === "wired",
    },
    {
      key: "unknown",
      variant: "unknown",
      title: "Unknown Connection",
      subtitle: "Devices the router could not classify",
      icon: <HiQuestionMarkCircle aria-hidden />,
      devices: unknownDevices,
      emptyMessage: "No devices with unknown connection type",
      emptyHint: null,
      visible:
        (showAllLayout && unknownDevices.length > 0) ||
        connectionFilter === "unknown",
      showConnectionColumn: true,
    },
  ];

  return (
    <div>
      <div className="page-header">
        <h2>Student Workstation</h2>
        <p>
          Monitor lab PCs by connection type — filter wireless and wired devices
          for faster classroom management
        </p>
      </div>

      <div className="stat-grid">
        {stats.map((s, i) => {
          const content = (
            <>
              <div className="label">{s.label}</div>
              <div className={`value ${s.gold ? "gold" : ""}`}>{s.value}</div>
              {s.onClick && (
                <span className="stat-card-hint">Click to filter</span>
              )}
            </>
          );

          if (s.onClick) {
            return (
              <motion.button
                key={s.label}
                type="button"
                className={`stat-card stat-card--${s.accent} stat-card--clickable`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}
                onClick={s.onClick}
              >
                {content}
              </motion.button>
            );
          }

          return (
            <motion.div
              key={s.label}
              className="stat-card"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
            >
              {content}
            </motion.div>
          );
        })}
      </div>

      <AnnouncementPanel
        workstations={workstations}
        hideIdentifiers={hideIdentifiers}
      />

      <motion.div
        className="panel ws-devices-panel"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
      >
        <div className="panel-header-row">
          <span className="panel-title-inline">Connected Devices</span>

          <div className="ws-search-wrap">
            <svg
              className="ws-search-icon"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                clipRule="evenodd"
              />
            </svg>
            <input
              id="ws-search-input"
              type="text"
              className="ws-search-input"
              placeholder="Search name, IP, MAC, or status…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
            {isSearching && (
              <button
                type="button"
                className="ws-search-clear"
                onClick={() => setQuery("")}
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <div className="bulk-actions">
            <button
              id="btn-connect-all"
              type="button"
              className="btn-bulk connect-all"
              disabled={!!bulking || blockedCount === 0}
              onClick={() => handleBulk(true)}
            >
              {bulking === "connect" ? (
                <span className="bulk-spinner" />
              ) : (
                <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path
                    fillRule="evenodd"
                    d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              Connect All
              {blockedCount > 0 && (
                <span className="bulk-count">{blockedCount}</span>
              )}
            </button>

            <button
              id="btn-disconnect-all"
              type="button"
              className="btn-bulk disconnect-all"
              disabled={!!bulking || onlineCount === 0}
              onClick={() => handleBulk(false)}
            >
              {bulking === "disconnect" ? (
                <span className="bulk-spinner" />
              ) : (
                <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path
                    fillRule="evenodd"
                    d="M4 10a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H4.75A.75.75 0 014 10z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              Disconnect All
              {onlineCount > 0 && (
                <span className="bulk-count">{onlineCount}</span>
              )}
            </button>
          </div>
        </div>

        <div className="ws-filter-tabs" role="tablist" aria-label="Connection type">
          {FILTER_TABS.filter(
            (tab) => tab.id !== "unknown" || showUnknownTab,
          ).map((tab) => {
            const Icon = tab.icon;
            const active = connectionFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`ws-filter-tab ${active ? "active" : ""} ${tab.id !== "all" ? `ws-filter-tab--${tab.id}` : ""}`}
                onClick={() => setConnectionFilter(tab.id)}
              >
                <Icon className="ws-filter-tab-icon" aria-hidden />
                <span>{tab.label}</span>
                <span className="ws-filter-tab-count">{tabCounts[tab.id]}</span>
              </button>
            );
          })}
        </div>

        <AnimatePresence>
          {isSearching && (
            <motion.div
              className="search-result-hint"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              {filtered.length === 0
                ? "No devices match your search."
                : `Showing ${filtered.length} of ${workstations.length} devices · ${wirelessDevices.length} wireless · ${wiredDevices.length} wired`}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {bulkResult && (
            <motion.div
              className={`bulk-result-banner ${bulkResult.error ? "error" : "success"}`}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              {bulkResult.error
                ? ` Error: ${bulkResult.error}`
                : ` Done — ${bulkResult.success} of ${bulkResult.total} device(s) updated successfully.`}
            </motion.div>
          )}
        </AnimatePresence>

        {workstations.length === 0 ? (
          <div className="ws-empty-all">
            <HiComputerDesktop className="ws-empty-all-icon" aria-hidden />
            <p>No workstations found</p>
            <span>Check your router connection and refresh the page.</span>
          </div>
        ) : (
          <div
            className={`ws-panels-layout ${showAllLayout ? "ws-panels-layout--split" : "ws-panels-layout--single"}`}
          >
            {panels
              .filter((p) => p.visible)
              .map((panel) => (
                <ConnectionDevicePanel
                  key={panel.key}
                  variant={panel.variant}
                  title={panel.title}
                  subtitle={panel.subtitle}
                  icon={panel.icon}
                  devices={panel.devices}
                  emptyMessage={panel.emptyMessage}
                  emptyHint={panel.emptyHint}
                  collapsed={collapsedPanels[panel.key]}
                  onToggleCollapse={() => togglePanel(panel.key)}
                  showCollapse={showAllLayout && panel.variant === "unknown"}
                  showConnectionColumn={panel.showConnectionColumn || false}
                  {...tableProps}
                />
              ))}
          </div>
        )}
      </motion.div>
    </div>
  );
}
