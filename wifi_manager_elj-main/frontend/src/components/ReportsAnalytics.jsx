import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { HiArrowDownTray } from "react-icons/hi2";
import { api } from "../api";
import { maskIdentifier } from "../utils/privacy";
import "../components/shared.css";
import "./ReportsAnalytics.css";

export default function ReportsAnalytics({ hideIdentifiers }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.analytics().then(setData);
  }, []);

  if (!data) return <p>Loading analytics...</p>;

  const { summary, topBandwidth } = data;

  const exportPdf = async () => {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
    ]);
    const doc = new jsPDF();
    const generatedAt = new Date();
    const reportDate = generatedAt.toISOString().slice(0, 10);

    doc.setProperties({ title: "Network Analytics Report" });
    doc.setFontSize(16);
    doc.text("Computer Laboratory Network Monitoring Tools", 14, 18);
    doc.setFontSize(11);
    doc.text("Eduardo L. JSON Memorial High School", 14, 26);
    doc.setFontSize(10);
    doc.text("Excellence in Education Through Technology", 14, 33);
    doc.setFontSize(12);
    doc.text("Network Analytics Report", 14, 43);
    doc.setFontSize(9);
    doc.text(`Generated: ${generatedAt.toLocaleString()}`, 14, 50);

    autoTable(doc, {
      startY: 56,
      head: [["Network Summary", "Total"]],
      body: [
        ["Total bandwidth", summary.totalBandwidth || "0 Kbps"],
        ["Connected devices", String(summary.online)],
        ["Total devices", String(summary.totalWorkstations)],
        ["Offline devices", String(summary.offline)],
        ["Blocked devices", String(summary.blocked)],
        ["Restricted sites", String(summary.restrictedSites)],
      ],
      headStyles: { fillColor: [15, 85, 32] },
      styles: { fontSize: 9 },
    });

    const tableStartY = doc.lastAutoTable.finalY + 12;
    doc.setFontSize(12);
    doc.text("Top Bandwidth Devices", 14, tableStartY);
    autoTable(doc, {
      startY: tableStartY + 4,
      head: [["Device", "IP Address", "Bandwidth", "Status"]],
      body: topBandwidth.length
        ? topBandwidth.map((device) => [
            device.name || "Unknown device",
            maskIdentifier(device.ip, hideIdentifiers),
            device.bandwidth || "0 Kbps",
            device.status || "unknown",
          ])
        : [["No devices available", "—", "—", "—"]],
      headStyles: { fillColor: [15, 85, 32] },
      styles: { fontSize: 9 },
    });

    doc.save(`network-report-${reportDate}.pdf`);
  };

  return (
    <div>
      <div className="page-header reports-header">
        <div>
          <h2>Reports & Analytics</h2>
          <p>
            Lab network summary and usage trends across all connected workstations
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary reports-export-button"
          onClick={exportPdf}
        >
          <HiArrowDownTray aria-hidden />
          Export PDF
        </button>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">Total Workstations</div>
          <div className="value">{summary.totalWorkstations}</div>
        </div>
        <div className="stat-card">
          <div className="label">Online</div>
          <div className="value">{summary.online}</div>
        </div>
        <div className="stat-card">
          <div className="label">Total Bandwidth</div>
          <div className="value">{summary.totalBandwidth || "0 Kbps"}</div>
        </div>
        <div className="stat-card">
          <div className="label">Offline</div>
          <div className="value">{summary.offline}</div>
        </div>
        <div className="stat-card">
          <div className="label">Blocked</div>
          <div className="value">{summary.blocked}</div>
        </div>
        <div className="stat-card">
          <div className="label">Restricted Sites</div>
          <div className="value gold">{summary.restrictedSites}</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: "1.5rem" }}>
        <div className="panel-title">Top Bandwidth Users</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Computer</th>
              <th>IP</th>
              <th>Bandwidth</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {topBandwidth.map((pc) => (
              <tr key={pc.mac}>
                <td>{pc.name}</td>
                <td>{maskIdentifier(pc.ip, hideIdentifiers)}</td>
                <td>{pc.bandwidth}</td>
                <td>
                  <span className={`status-badge ${pc.status}`}>
                    {pc.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
