# MySQL database setup (XAMPP)

The backend uses the MySQL/MariaDB service bundled with XAMPP. Start **MySQL** in the XAMPP Control Panel, create the database and tables below, then configure the backend environment variables. Daily bandwidth values are estimated from the router's per-device download/upload rates and accumulated in UTC.

## Create database and tables

In phpMyAdmin, open the **SQL** tab and run this script. The same SQL can be run from a MySQL command prompt.

```sql
CREATE DATABASE IF NOT EXISTS wifi_manager
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE wifi_manager;

CREATE TABLE IF NOT EXISTS admin_users (
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (username)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS devices (
  mac_address CHAR(17) NOT NULL,
  device_name VARCHAR(150) NULL,
  ip_address VARCHAR(45) NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (mac_address),
  INDEX idx_devices_last_seen (last_seen_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS daily_bandwidth (
  mac_address CHAR(17) NOT NULL,
  usage_date DATE NOT NULL,
  download_bytes DOUBLE UNSIGNED NOT NULL DEFAULT 0,
  upload_bytes DOUBLE UNSIGNED NOT NULL DEFAULT 0,
  sample_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (mac_address, usage_date),
  INDEX idx_bandwidth_date (usage_date),
  CONSTRAINT fk_bandwidth_device
    FOREIGN KEY (mac_address) REFERENCES devices (mac_address)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS device_presence_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mac_address CHAR(17) NOT NULL,
  event_type ENUM('online', 'offline') NOT NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_presence_device_time (mac_address, occurred_at),
  CONSTRAINT fk_presence_device
    FOREIGN KEY (mac_address) REFERENCES devices (mac_address)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admin_auth_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(100) NOT NULL,
  event_type ENUM('login_success', 'login_failure') NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_admin_auth_time (occurred_at),
  INDEX idx_admin_auth_username_time (username, occurred_at)
) ENGINE=InnoDB;
```

`admin_users` stores usernames and bcrypt password hashes. The backend creates the initial account from `ADMIN_USERNAME` and `ADMIN_PASSWORD` when there are no admin records; it never stores plaintext passwords. `devices` is the normalized device directory. `daily_bandwidth` stores one daily total per device; `device_presence_events` stores online/offline transitions; and `admin_auth_logs` stores login outcomes and request metadata.

## Configure the backend

Copy `backend/.env.example` to `backend/.env` and set:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=wifi_manager
DB_USER=root
DB_PASSWORD=
```

Set `DB_PASSWORD` to the MySQL root password if one is configured in XAMPP. If `backend/.env` is absent, the backend defaults to `127.0.0.1:3306`, database `wifi_manager`, user `root`, and an empty DB password. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before the first startup to choose the initial admin login; the example values are `admin` / `admin123`. Install backend dependencies and restart the backend:

```powershell
cd backend
npm install
npm run dev
```

The backend continues to run without MySQL if `DB_HOST` is unset. Once configured, it retries persistence on subsequent realtime updates if MySQL is temporarily unavailable.

## History API

All endpoints require the admin bearer token:

- `GET /api/history/bandwidth?from=2026-10-01&to=2026-10-31&mac=AA:BB:CC:DD:EE:FF&limit=90`
- `GET /api/history/devices?mac=AA:BB:CC:DD:EE:FF&limit=100`
- `GET /api/history/admin-auth?limit=100`

Bandwidth rows return byte totals by device and UTC date. Device history returns presence transitions. Admin auth history records username, success/failure, IP address, user agent, and timestamp, but never the submitted password.