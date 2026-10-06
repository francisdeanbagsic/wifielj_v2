import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { HiEye, HiEyeSlash } from 'react-icons/hi2';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import './Navbar.css';

export default function Navbar({ hideIdentifiers, onToggleIdentifiers }) {
  const { school, logout, user } = useAuth();
  const { connected } = useSocket();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <motion.header
      className="navbar"
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
    >
      <div className="navbar-left">
        <div className="navbar-logo">EL</div>
        <div>
          <h1 className="navbar-title">Computer Laboratory Network Monitoring Tools</h1>
          <p className="navbar-school">{school?.name || 'Eduardo L. JSON Memorial High School'}</p>
          <p className="navbar-tagline">{school?.tagline || 'Excellence in Education Through Technology'}</p>
        </div>
      </div>
      <div className="navbar-right">
        <span className={`live-dot ${connected ? 'on' : ''}`} title={connected ? 'Live' : 'Disconnected'} />
        <span className="navbar-user">{user?.username}</span>
        <button
          type="button"
          className="navbar-privacy-toggle"
          onClick={onToggleIdentifiers}
          aria-pressed={hideIdentifiers}
          aria-label={hideIdentifiers ? 'Show IP and MAC addresses' : 'Hide IP and MAC addresses'}
          title={hideIdentifiers ? 'Show IP and MAC addresses' : 'Hide IP and MAC addresses'}
        >
          {hideIdentifiers ? <HiEye /> : <HiEyeSlash />}
          <span>{hideIdentifiers ? 'Show IP/MAC' : 'Hide IP/MAC'}</span>
        </button>
        <button type="button" className="navbar-logout" onClick={handleLogout}>
          Logout
        </button>
      </div>
    </motion.header>
  );
}
