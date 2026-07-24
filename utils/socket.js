let io = null;

exports.init = (server) => {
  try {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: process.env.CLIENT_URL || 'http://localhost:5173', methods: ['GET','POST'] } });
    io.on('connection', (socket) => {
      // connection established
    });
    return io;
  } catch (err) {
    console.warn('Socket.IO not available:', err.message);
    return null;
  }
};

exports.getIO = () => io;
