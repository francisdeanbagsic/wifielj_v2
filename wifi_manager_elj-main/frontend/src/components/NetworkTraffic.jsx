import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSocket } from "../context/SocketContext";
import { api } from "../api";
import { maskIdentifier } from "../utils/privacy";
import "../components/shared.css";

export default function NetworkTraffic({ hideIdentifiers }) {
  const { liveData } = useSocket();
  const [traffic, setTraffic] = useState([]);
  const [speed, setSpeed] = useState(null);

  useEffect(() => {
    api.traffic().then(setTraffic);
  }, []);

  useEffect(() => {
    if (liveData?.traffic) setTraffic(liveData.traffic);
    if (liveData?.speed) setSpeed(liveData.speed);
  }, [liveData]);

  const totalDownload = traffic.reduce((sum, t) => sum + (t.download || 0), 0);
  const totalUpload = traffic.reduce((sum, t) => sum + (t.upload || 0), 0);
  const totalBandwidth = totalDownload + totalUpload;
  const max = Math.max(
    ...traffic.map((t) => (t.download || 0) + (t.upload || 0)),
    1,
  );

  const speedActive =
    speed && (Number(speed.downloadKBs) > 0 || Number(speed.uploadKBs) > 0);
  const activeDownload = speedActive ? speed.downloadKBs : totalDownload;
  const activeUpload = speedActive ? speed.uploadKBs : totalUpload;
  const activeTotal = activeDownload + activeUpload;

  const formatBandwidth = (kbps) => {
    if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} MB/s`;
    return `${Number(kbps).toFixed(2)} kB/s`;
  };

  const formatSpeed = (kb) => {
    if (kb === null || kb === undefined) return "—";
    return `${Number(kb).toFixed(2)} kB/s`;
  };

  return (
    <div>
      <div className="page-header">
        <h2>Network Traffic</h2>
        <p>Real-time download and upload usage breakdown per workstation</p>
      </div>

      <div className="panel" style={{ marginBottom: "1.25rem" }}>
        <div className="panel-title">Total Bandwidth</div>
        <div
          style={{
            display: "flex",
            gap: "1rem",
            flexWrap: "wrap",
            padding: "1.25rem",
          }}
        >
          <div style={{ minWidth: 180 }}>
            <div style={{ color: "#888", marginBottom: 6 }}>Active devices</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {traffic.length}
            </div>
          </div>
          <div style={{ minWidth: 180 }}>
            <div style={{ color: "#888", marginBottom: 6 }}>Current speed</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              ↓ {speedActive ? formatSpeed(speed.downloadKBs) : "—"} · ↑{" "}
              {speedActive ? formatSpeed(speed.uploadKBs) : "—"}
            </div>
          </div>
          <div style={{ minWidth: 180 }}>
            <div style={{ color: "#888", marginBottom: 6 }}>Download</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {formatBandwidth(activeDownload)}
            </div>
          </div>
          <div style={{ minWidth: 180 }}>
            <div style={{ color: "#888", marginBottom: 6 }}>Upload</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {formatBandwidth(activeUpload)}
            </div>
          </div>
          <div style={{ minWidth: 180 }}>
            <div style={{ color: "#888", marginBottom: 6 }}>Total</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {formatBandwidth(activeTotal)}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Traffic by Device</div>
        <div style={{ padding: "1.25rem" }}>
          {traffic.map((t, i) => (
            <motion.div
              key={t.mac}
              style={{ marginBottom: "1rem" }}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 4,
                  fontSize: "0.9rem",
                }}
              >
                <div>
                  <strong>{t.name}</strong>
                  <div style={{ fontSize: "0.8rem", color: "#888" }}>
                    {maskIdentifier(t.ip || t.mac, hideIdentifiers)}
                  </div>
                </div>
                <span style={{ color: "#5a6f5e" }}>
                  ↓ {formatBandwidth(t.download)} · ↑{" "}
                  {formatBandwidth(t.upload)} · Total {t.bandwidth}
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  background: "#eef5ef",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <motion.div
                  style={{
                    height: "100%",
                    background: "linear-gradient(90deg, #0f5520, #f5c800)",
                    borderRadius: 4,
                  }}
                  initial={{ width: 0 }}
                  animate={{
                    width: `${(((t.download || 0) + (t.upload || 0)) / max) * 100}%`,
                  }}
                />
              </div>
            </motion.div>
          ))}
          {traffic.length === 0 && (
            <p style={{ color: "#888" }}>No active traffic data.</p>
          )}
        </div>
      </div>
    </div>
  );
}
