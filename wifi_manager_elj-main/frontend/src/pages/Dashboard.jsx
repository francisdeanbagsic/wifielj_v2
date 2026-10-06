import { useState } from 'react';
import Navbar from '../components/Navbar';
import Sidebar from '../components/Sidebar';
import StudentWorkstation from '../components/StudentWorkstation';
import NetworkTraffic from '../components/NetworkTraffic';
import InternetActivity from '../components/InternetActivity';
import SpeedTest from '../components/SpeedTest';
import ReportsAnalytics from '../components/ReportsAnalytics';
import RestrictSites from '../components/RestrictSites';
import './Dashboard.css';

const VIEWS = {
  workstations: StudentWorkstation,
  traffic: NetworkTraffic,
  activity: InternetActivity,
  speedtest: SpeedTest,
  analytics: ReportsAnalytics,
  restrict: RestrictSites,
};

export default function Dashboard() {
  const [activeView, setActiveView] = useState('workstations');
  const [hideIdentifiers, setHideIdentifiers] = useState(false);
  const ActiveComponent = VIEWS[activeView] || StudentWorkstation;

  return (
    <div className="dashboard">
      <Navbar
        hideIdentifiers={hideIdentifiers}
        onToggleIdentifiers={() => setHideIdentifiers((hidden) => !hidden)}
      />
      <div className="dashboard-body">
        <Sidebar activeView={activeView} onNavigate={setActiveView} />
        <main className="dashboard-main">
          <ActiveComponent hideIdentifiers={hideIdentifiers} />
        </main>
      </div>
    </div>
  );
}
