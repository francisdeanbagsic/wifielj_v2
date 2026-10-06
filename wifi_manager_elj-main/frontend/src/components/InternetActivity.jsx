import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSocket } from "../context/SocketContext";
import { api } from "../api";
import { maskIdentifier } from "../utils/privacy";
import "../components/shared.css";

export default function InternetActivity({ hideIdentifiers }) {
  const { liveData } = useSocket();
  const [activity, setActivity] = useState([]);

  useEffect(() => {
    api.activity().then(setActivity);
  }, []);

  useEffect(() => {
    if (liveData?.activity) setActivity(liveData.activity);
  }, [liveData]);

  return (
    <div>
      <div className="page-header">
        <h2>Internet Activity</h2>
        <p>Monitor real-time browsing activity and bandwidth usage per connected workstation</p>
      </div>

      <div className="panel">
        <table className="data-table">
          <thead>
            <tr>
              <th>Workstation</th>
              <th>IP Address</th>
              <th>Activity</th>
              <th>Bandwidth</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((row, i) => (
              <motion.tr
                key={row.ip + row.workstation}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.04 }}
              >
                <td>
                  <strong>{row.workstation}</strong>
                </td>
                <td>{maskIdentifier(row.ip, hideIdentifiers)}</td>
                <td>{row.activity}</td>
                <td>{row.bandwidth}</td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
