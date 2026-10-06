import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "elabnet-dev-secret";
const LAB_CLIENT_SECRET =
  process.env.LAB_CLIENT_SECRET || "elab-lab-client-change-me";

export function socketAuthMiddleware(socket, next) {
  const lab = socket.handshake.auth?.lab;

  if (lab?.mac && lab?.secret) {
    if (lab.secret !== LAB_CLIENT_SECRET) {
      return next(new Error("Invalid lab client secret"));
    }
    socket.role = "lab";
    socket.mac = String(lab.mac).trim().toUpperCase().replace(/-/g, ":");
    socket.labName = String(lab.name || "").trim();
    return next();
  }

  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error("Unauthorized"));
  }

  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    socket.role = "admin";
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
}

export { LAB_CLIENT_SECRET };
