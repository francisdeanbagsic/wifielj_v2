import { useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BsBrowserEdge } from "react-icons/bs";
import { api } from "../api";
import "../components/shared.css";

const SITE_OPTIONS = [
  "google.com",
  "facebook.com",
  "youtube.com",
  "tiktok.com",
  "twitter.com",
  "instagram.com",
  "netflix.com",
  "gmail.com",
  "docs.google.com",
  "discord.com",
];

export default function RestrictSites() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState(SITE_OPTIONS[0]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");

  const load = () =>
    api
      .restrictSites()
      .then(setSites)
      .catch(() => setSites([]));

  useEffect(() => {
    load();
  }, []);

  /* ── search filter ────────────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sites;
    return sites.filter((s) => (s.url || "").toLowerCase().includes(q));
  }, [sites, query]);

  const isSearching = query.trim().length > 0;

  /* ── handlers ─────────────────────────────────────────────────────────── */
  const handleAdd = async (e) => {
    e.preventDefault();
    const siteToAdd = url.trim() || selectedSite;
    if (!siteToAdd) return;
    setLoading(true);
    setMessage("");
    try {
      await api.addRestrictSite(siteToAdd);
      setUrl("");
      await load();
      setMessage(` "${siteToAdd}" has been blocked.`);
    } catch (err) {
      setMessage(` ${err.message}`);
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(""), 4000);
    }
  };

  const handleRemove = async (siteUrl) => {
    setLoading(true);
    setMessage("");
    try {
      await api.removeRestrictSite(siteUrl);
      await load();
      setMessage(` "${siteUrl}" has been unblocked.`);
    } catch (err) {
      setMessage(` ${err.message}`);
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(""), 4000);
    }
  };

  const handleRemoveAll = async () => {
    if (!sites.length) return;
    if (
      !window.confirm(
        "Unblock all restricted sites? This will remove every blocked URL.",
      )
    )
      return;

    setLoading(true);
    setMessage("");
    try {
      await api.removeAllRestrictSites();
      await load();
      setMessage(" All blocked sites have been unblocked.");
    } catch (err) {
      setMessage(` ${err.message}`);
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(""), 4000);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>Restrict Sites</h2>
        <p>
          Block websites across the lab network using the ASUS-WRT URL filter
          (RT-AX53U)
        </p>
      </div>

      {/* ── add site form ─────────────────────────────────────────────────── */}
      <form className="form-row" onSubmit={handleAdd}>
        <select
          value={selectedSite}
          onChange={(e) => setSelectedSite(e.target.value)}
        >
          {SITE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Or type a custom domain, e.g. example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? "Blocking…" : "Block Site"}
        </button>
      </form>

      {/* ── status message banner ─────────────────────────────────────────── */}
      <AnimatePresence>
        {message && (
          <motion.div
            className={`message-banner ${message.startsWith("✅") ? "success" : "error"}`}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            {message}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── blocked URLs panel ────────────────────────────────────────────── */}
      <div className="panel">
        {/* panel header */}
        <div className="panel-title-row">
          <div className="panel-title">Blocked URLs</div>
          <div className="panel-actions">
            <span className="blocked-count">{sites.length} blocked</span>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleRemoveAll}
              disabled={loading || sites.length === 0}
            >
              Unblock All
            </button>
          </div>
        </div>

        {/* ── search bar ─────────────────────────────────────────────────── */}
        <div className="rs-search-wrap">
          <svg
            className="rs-search-icon"
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
            id="rs-search-input"
            type="text"
            className="rs-search-input"
            placeholder="Search blocked sites…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {isSearching && (
            <button
              type="button"
              className="rs-search-clear"
              onClick={() => setQuery("")}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* result count hint */}
        <AnimatePresence>
          {isSearching && (
            <motion.div
              className="search-result-hint"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              {filtered.length === 0
                ? "No blocked sites match your search."
                : `Showing ${filtered.length} of ${sites.length} blocked site${sites.length !== 1 ? "s" : ""}`}
            </motion.div>
          )}
        </AnimatePresence>

        {/* table */}
        <table className="data-table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => (
              <motion.tr
                key={s.url}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.04 }}
              >
                <td>
                  <span className="site-url-cell">
                    <span className="site-favicon">
                      <BsBrowserEdge />
                    </span>
                    {s.url}
                  </span>
                </td>
                <td>
                  <span className="status-badge blocked">Blocked</span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-control connect"
                    onClick={() => handleRemove(s.url)}
                    disabled={loading}
                  >
                    Unblock
                  </button>
                </td>
              </motion.tr>
            ))}

            {/* empty states */}
            {filtered.length === 0 && sites.length > 0 && (
              <tr>
                <td colSpan={3} className="empty-cell">
                  No blocked sites match <strong>"{query}"</strong>.{" "}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setQuery("")}
                  >
                    Clear search
                  </button>
                </td>
              </tr>
            )}
            {sites.length === 0 && (
              <tr>
                <td colSpan={3} className="empty-cell">
                  No sites are currently blocked.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
