import { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

export function SocketProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [liveData, setLiveData] = useState(null);
  const [connected, setConnected] = useState(false);
  const [connectedAgents, setConnectedAgents] = useState([]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const token = localStorage.getItem('token');
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('lab:update', (data) => setLiveData(data));
    socket.on('lab:agents', (data) => {
      if (data?.agents) setConnectedAgents(data.agents);
    });

    return () => socket.disconnect();
  }, [isAuthenticated]);

  return (
    <SocketContext.Provider value={{ liveData, connected, connectedAgents }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
