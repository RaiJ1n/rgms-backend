const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const errorMiddleware = require('./middleware/errorMiddleware');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const adminAuthRoutes = require('./routes/adminAuthRoutes');
const rfidRoutes = require('./routes/rfidRoutes');
const classRoutes = require('./routes/classRoutes');
const adminAnalyticsRoutes = require('./routes/adminAnalyticsRoutes');
const studentIdRoutes = require('./routes/studentIdRoutes'); // NEW

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rfid', rfidRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);
app.use('/api/student-id', studentIdRoutes); // NEW — was completely unmounted


app.use(errorMiddleware);

module.exports = app;