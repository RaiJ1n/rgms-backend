const User = require('../models/User');
const generateToken = require('../utils/generateToken');

// Coach login — same collection as member/admin auth, scoped to
// role: 'coach'. Coaches never self-register (see coachRoutes.js
// comment: account creation lives under adminRoutes.js), so there's
// no register handler here, only login/logout.
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(422).json({ success: false, message: 'Email and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail, role: 'coach' });

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'This account has been deactivated. Please contact the gym.',
      });
    }

    // type: 'coach' claim is redundant right now (protectCoach checks
    // role on the fetched user, not the token), but keeping it costs
    // nothing and future-proofs the token if middleware logic changes.
    const token = generateToken({ id: user._id, type: 'coach' });

    const safeUser = user.toObject();
    delete safeUser.password;

    res.json({ success: true, message: 'Login successful', data: { coach: safeUser, token } });
  } catch (error) {
    next(error);
  }
};

const logout = async (req, res) => {
  res.json({ success: true, message: 'Logout successful' });
};

module.exports = { login, logout };