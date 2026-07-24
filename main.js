require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const http = require('http');
const socketUtil = require('./utils/socket');
const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    const server = http.createServer(app);
    // initialize Socket.IO (if installed)
    socketUtil.init(server);
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database connection failed:', error);
    process.exit(1);
  });
