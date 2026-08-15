let io = null;

// Room naming:
//   - `user:<id>` — every connected socket joins its own room, so any
//     controller can push an update to exactly one member/admin
//     (e.g. "your payment was approved") without broadcasting to everyone.
//   - `admins` — every connected admin also joins this shared room, used
//     for things every admin session should see (notification bell,
//     live attendance feed, dashboard refresh pings, RFID scan events).
exports.init = (server) => {
  try {
    const { Server } = require('socket.io');
    const jwt = require('jsonwebtoken');
    const User = require('../models/User');

    io = new Server(server, { cors: { origin: process.env.CLIENT_URL || 'http://localhost:5173', methods: ['GET','POST'] } });

    // Any authenticated user (member or admin) may connect — each only
    // ever receives events addressed to their own `user:<id>` room, plus
    // `admins` if their role qualifies. CORS restricts which *browser*
    // origins can connect, but a raw WebSocket client (curl, Postman, a
    // script) ignores CORS entirely — so the handshake itself still needs
    // to check for a real JWT, the same as any other protected route.
    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!token) {
          console.warn('[SOCKET] Rejected connection: no token in handshake.auth');
          return next(new Error('Not authorized'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');
        if (!user) {
          console.warn(`[SOCKET] Rejected connection: token decoded to id ${decoded.id}, but no matching User found`);
          return next(new Error('Not authorized'));
        }

        socket.user = user;
        next();
      } catch (err) {
        // This is what was silently swallowing bad/expired tokens before —
        // now it actually tells you why a connection was rejected.
        console.warn('[SOCKET] Rejected connection:', err.message);
        next(new Error('Not authorized'));
      }
    });

    io.on('connection', (socket) => {
      socket.join(`user:${socket.user._id}`);
      const isAdmin = socket.user.role === 'admin';
      if (isAdmin) {
        socket.join('admins');
      }
      // This line is the key diagnostic: it tells you definitively whether
      // a given connection actually landed in the `admins` room (and
      // therefore will receive rfid:scanned/rfid:status/etc.) or not.
      console.log(
        `[SOCKET] Connected: ${socket.user.fullname} (${socket.user._id}), role=${socket.user.role}, joined admins room=${isAdmin}`
      );

      socket.on('disconnect', (reason) => {
        console.log(`[SOCKET] Disconnected: ${socket.user.fullname} (${socket.user._id}) — ${reason}`);
      });
    });
    return io;
  } catch (err) {
    console.warn('Socket.IO not available:', err.message);
    return null;
  }
};

exports.getIO = () => io;

// ---- Emit helpers ----
// Controllers/services call these instead of reaching into getIO()
// directly, so a socket-less environment (io still initializing, or the
// package genuinely missing) never turns a request into a 500 — the
// real-time push is best-effort on top of the normal HTTP response.

exports.emitToAdmins = (event, payload) => {
  if (io) io.to('admins').emit(event, payload);
};

exports.emitToUser = (userId, event, payload) => {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
};

exports.emitToAll = (event, payload) => {
  if (io) io.emit(event, payload);
};