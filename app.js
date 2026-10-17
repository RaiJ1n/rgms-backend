const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
// Loads/registers the Google + Facebook strategies (config/passport.js)
const passport = require('./config/passport');
const errorMiddleware = require('./middleware/errorMiddleware');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const adminAuthRoutes = require('./routes/adminAuthRoutes');
const coachRoutes = require('./routes/coachRoutes');
const coachAuthRoutes = require('./routes/coachAuthRoutes');
const coachDirectoryRoutes = require('./routes/coachDirectoryRoutes');
const rfidRoutes = require('./routes/rfidRoutes');
const classRoutes = require('./routes/classRoutes');
const adminAnalyticsRoutes = require('./routes/adminAnalyticsRoutes');
const studentIdRoutes = require('./routes/studentIdRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const clientOrigins = require('./config/clientOrigins');

const app = express();

// Behind Nginx
app.set('trust proxy', 1);

// Unauthenticated liveness probe
app.get('/api/health', (req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || clientOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', adminRoutes);
// Auth (public) must be mounted before the portal router below
app.use('/api/coach/auth', coachAuthRoutes);
app.use('/api/coach', coachRoutes);
// '/api/coaches' (plural) is a distinct mount from '/api/coach' above
app.use('/api/coaches', coachDirectoryRoutes);
app.use('/api/rfid', rfidRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);
app.use('/api/student-id', studentIdRoutes);
app.use('/api/settings', settingsRoutes);


app.use(errorMiddleware);

module.exports = app;