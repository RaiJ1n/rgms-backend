let io = null;
const clientOrigins = require('../config/clientOrigins');

// Room naming: - `user:<id>`
exports.init = (server) => {
  try {
    const { Server } = require('socket.io');
    const jwt = require('jsonwebtoken');
    const User = require('../models/User');

    io = new Server(server, { cors: { origin: clientOrigins, methods: ['GET', 'POST'] } });

    // Any authenticated user (member or admin) may connect
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
        // This is what was silently swallowing bad/expired tokens before
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
      // This line is the key diagnostic
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

// Emit helpers Controllers/services call these instead of reaching into getIO() directly

exports.emitToAdmins = (event, payload) => {
  if (io) io.to('admins').emit(event, payload);
};

exports.emitToUser = (userId, event, payload) => {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
};

exports.emitToAll = (event, payload) => {
  if (io) io.emit(event, payload);
};