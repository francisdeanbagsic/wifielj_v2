const API_BASE = import.meta.env.VITE_API_URL || "/api";

function headers() {
  const token = localStorage.getItem("token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: headers(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Request failed");
  }
  return res.json();
}

export const api = {
  login: (username, password) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request("/auth/me"),
  workstations: () => request("/workstations"),
  toggleWorkstation: (mac, connect) =>
    request(`/workstations/${encodeURIComponent(mac)}/toggle`, {
      method: "POST",
      body: JSON.stringify({ connect }),
    }),
  bulkToggle: (connect) =>
    request("/workstations/bulk-toggle", {
      method: "POST",
      body: JSON.stringify({ connect }),
    }),
  traffic: () => request("/traffic"),
  activity: () => request("/activity"),
  speedtest: () => request("/speedtest", { method: "POST" }),
  analytics: () => request("/analytics"),
  restrictSites: () => request("/restrict-sites"),
  addRestrictSite: (url) =>
    request("/restrict-sites", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  removeRestrictSite: (url) =>
    request(`/restrict-sites/${encodeURIComponent(url)}`, { method: "DELETE" }),
  removeAllRestrictSites: () =>
    request("/restrict-sites", { method: "DELETE" }),
  sendAnnouncement: (body) =>
    request("/announcements", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  announcementAgents: () => request("/announcements/agents"),
  announcementHistory: () => request("/announcements/history"),
};
