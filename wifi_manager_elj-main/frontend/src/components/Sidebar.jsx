import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  HiBolt,
  HiChartBarSquare,
  HiChartPie,
  HiComputerDesktop,
  HiGlobeAlt,
  HiShieldCheck,
} from "react-icons/hi2";
import "./Sidebar.css";

const STORAGE_KEY = "elab-sidebar-collapsed";

const MENU = [
  { id: "workstations", label: "Student Workstation", Icon: HiComputerDesktop },
  { id: "traffic", label: "Network Traffic", Icon: HiChartBarSquare },
  { id: "activity", label: "Internet Activity", Icon: HiGlobeAlt },
  { id: "speedtest", label: "Speedtest", Icon: HiBolt },
  { id: "analytics", label: "Reports & Analytics", Icon: HiChartPie },
  { id: "restrict", label: "Restrict Sites", Icon: HiShieldCheck },
];

function SidebarToggle({ collapsed, onToggle }) {
  return (
    <div className="sidebar-header">
      <AnimatePresence mode="wait">
        {!collapsed && (
          <motion.span
            key="title"
            className="sidebar-header-title"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.18 }}
          >
            Menu
          </motion.span>
        )}
      </AnimatePresence>

      <button
        type="button"
        className={`sidebar-toggle ${collapsed ? "is-collapsed" : ""}`}
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar menu" : "Collapse sidebar menu"}
        aria-expanded={!collapsed}
        aria-controls="sidebar-nav"
        data-tooltip={collapsed ? "Expand menu" : undefined}
      >
        <span className="sidebar-burger" aria-hidden>
          <span className="sidebar-burger-line" />
          <span className="sidebar-burger-line" />
          <span className="sidebar-burger-line" />
        </span>
        <span className="sidebar-toggle-label">
          {collapsed ? "Open menu" : "Collapse"}
        </span>
      </button>
    </div>
  );
}

export default function Sidebar({ activeView, onNavigate }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  const handleToggle = () => setCollapsed((c) => !c);

  return (
    <aside
      className={`sidebar ${collapsed ? "sidebar--collapsed" : ""}`}
      aria-label="Main navigation"
    >
      <SidebarToggle collapsed={collapsed} onToggle={handleToggle} />

      <nav id="sidebar-nav" className="sidebar-nav">
        {MENU.map((item, i) => {
          const Icon = item.Icon;
          const isActive = activeView === item.id;

          return (
            <motion.button
              key={item.id}
              type="button"
              className={`sidebar-item ${isActive ? "active" : ""}`}
              onClick={() => onNavigate(item.id)}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              whileHover={collapsed ? { scale: 1.04 } : { x: 4 }}
              whileTap={{ scale: 0.98 }}
              data-tooltip={item.label}
            >
              <span className="sidebar-icon">
                <Icon aria-hidden />
              </span>
              <span className="sidebar-label">{item.label}</span>
              {isActive && (
                <span className="sidebar-active-indicator" aria-hidden />
              )}
            </motion.button>
          );
        })}
      </nav>

      <p className="sidebar-hint" aria-live="polite">
        {collapsed ? "Hover icons for names" : "Click Collapse for icon-only view"}
      </p>
    </aside>
  );
}
