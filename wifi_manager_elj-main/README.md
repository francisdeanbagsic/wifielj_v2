# Computer Laboratory Network Monitoring Tools

**Eduardo L. JSON Memorial High School**

Web app for monitoring student lab workstations via **ASUS RT-AX53U** (ASUS-WRT). Stack: React + Framer Motion + Socket.io (frontend), Node.js + Express (backend).

## Features

- Login (school branding: `#0f5520`, `#f5c800`, `#1a7a2e`)
- Dashboard with navbar, sidebar, and sections:
  - **Student Workstation** — connected PCs, bandwidth, status table, connect/disconnect
  - **Network Traffic** — per-device usage
  - **Internet Activity** — what each PC is doing
  - **Speedtest** — WAN speed via router
  - **Reports & Analytics** — summaries and charts
  - **Restrict Sites** — URL filtering via ASUS-WRT
  - **Broadcast announcement** — pop-up message to all or selected lab PCs (lab client required on each PC)

## Quick Start

### 1. Backend

```bash
cd backend
copy .env.example .env
npm install
npm run dev
```

API: `http://localhost:5000`

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

App: `http://localhost:5173`

**Login:** `admin` / `admin123` (change in `.env`)

## ASUS RT-AX53U Setup

Edit `backend/.env`:

```env
ROUTER_URL=http://192.168.50.1
ROUTER_USERNAME=admin
ROUTER_PASSWORD=your-router-password
ROUTER_MOCK=false
```

- Use your router’s LAN IP (often `192.168.50.1` or `192.168.1.1`).
- Enable **Web Access from LAN** in router admin.
- **Mock mode** (`ROUTER_MOCK=true`) simulates 6 lab PCs when the router is offline.

The backend talks to ASUS-WRT HTTP APIs (`login.cgi`, `appGet.cgi`, parental control / URL filter) — same interface used by tools like Home Assistant’s ASUSWRT integration.

## Project Structure

```
wifi_manager_2.0/
├── backend/
│   ├── server.js
│   ├── routes/api.js
│   └── services/asusRouter.js
└── frontend/
    └── src/
        ├── pages/Login.jsx, Dashboard.jsx
        └── components/...
```

## Real-time Updates

Socket.io broadcasts lab data every 5 seconds to all logged-in dashboards.

## Broadcast announcements

Teachers send messages from **Student Workstation → Broadcast announcement** (all PCs with receiver, or selected MACs).

### Option A — Windows lab client (recommended)

On each student PC:

```bash
cd lab-client
copy .env.example .env
# Edit SERVER_URL (lab server IP), LAB_CLIENT_SECRET, LAB_MAC, LAB_NAME
npm install
npm start
```

Set the same `LAB_CLIENT_SECRET` in `backend/.env`. Use `install-startup.ps1` (Admin) to run at logon.

### Option B — Browser receiver

Open on each PC (keep tab open; allow notifications):

`http://<server-ip>:5000/lab-receiver/`

Enter server URL, secret, and this PC’s MAC address.

### Dashboard

- **Receiver** column shows **Ready** when that PC’s client is connected.
- Green dot on selected chips = receiver online (message will pop up).
