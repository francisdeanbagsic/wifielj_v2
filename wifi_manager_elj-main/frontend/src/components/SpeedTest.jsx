import { useState } from "react";
import { motion } from "framer-motion";
import { api } from "../api";
import "../components/shared.css";

export default function SpeedTest() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const runTest = async () => {
    setLoading(true);
    setResult(null);
    try {
      const data = await api.speedtest();
      setResult(data);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>Speedtest</h2>
        <p>Measure your lab's internet connection speed with a built-in speed test.</p>
      </div>

      <motion.div
        className="stat-card"
        style={{ maxWidth: 480, marginBottom: "1.5rem" }}
        whileHover={{ scale: 1.01 }}
      >
        <button
          type="button"
          className="btn-primary"
          onClick={runTest}
          disabled={loading}
        >
          {loading ? "Running speedtest..." : "Run Speed Test"}
        </button>
      </motion.div>

      {result && !result.error && (
        <motion.div
          className="stat-grid"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <div className="stat-card">
            <div className="label">Download</div>
            <div className="value gold">
              {result.downloadMbps?.toFixed(1)} Mbps
            </div>
          </div>
          <div className="stat-card">
            <div className="label">Upload</div>
            <div className="value">{result.uploadMbps?.toFixed(1)} Mbps</div>
          </div>
          <div className="stat-card">
            <div className="label">Ping</div>
            <div className="value">{result.pingMs} ms</div>
          </div>
        </motion.div>
      )}
      {result?.error && <p style={{ color: "#c62828" }}>{result.error}</p>}
    </div>
  );
}
