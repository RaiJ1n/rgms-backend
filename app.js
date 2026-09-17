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
const coachRoutes = require('./routes/coachRoutes');
const coachAuthRoutes = require('./routes/coachAuthRoutes');
const coachDirectoryRoutes = require('./routes/coachDirectoryRoutes'); // NEW — Client/User browsing & registering to coaches
const rfidRoutes = require('./routes/rfidRoutes');
const classRoutes = require('./routes/classRoutes');
const adminAnalyticsRoutes = require('./routes/adminAnalyticsRoutes');
const studentIdRoutes = require('./routes/studentIdRoutes'); // NEW
const settingsRoutes = require('./routes/settingsRoutes'); // NEW — Social Accounts (#8)

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' || 'http:localhost:5175' , credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', adminRoutes);
// Auth (public) must be mounted before the portal router below —
// coachRoutes.js applies protectCoach to everything under it via
// router.use(), so if it were mounted first at the same prefix it
// would swallow /api/coach/auth/login and 401 it before it ever
// reached coachAuthController.
app.use('/api/coach/auth', coachAuthRoutes);
app.use('/api/coach', coachRoutes); // was '/api/coaches' — didn't match the frontend's '/coach/*' calls
// '/api/coaches' (plural) is a distinct mount from '/api/coach' above —
// Express matches mount paths on a segment boundary, so a request to
// /api/coaches/... is never swallowed by the /api/coach router. Client/
// User-facing browsing + registration for the Coach Management system.
app.use('/api/coaches', coachDirectoryRoutes); // NEW
app.use('/api/rfid', rfidRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);
app.use('/api/student-id', studentIdRoutes); // NEW — was completely unmounted
app.use('/api/settings', settingsRoutes); // NEW — Social Accounts (#8): GET is public, PUT is admin-only


app.use(errorMiddleware);

module.exports = app;