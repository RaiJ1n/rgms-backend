const User = require('../models/User');
const generateToken = require('../utils/generateToken');

const createAdmin = async ({ fullname, email, password, phone }) => {
  const existing = await User.findOne({ email });
  if (existing) {
    throw new Error('Admin already exists');
  }

  // Create as a regular User but set role to 'admin'
  const admin = await User.create({ fullname, email, password, phone, role: 'admin' });
  const token = generateToken({ id: admin._id });
  return { admin, token };
};

const loginAdmin = async ({ email, password }) => {
  const admin = await User.findOne({ email, role: 'admin' });
  const httpError = (message, statusCode) => { const e = new Error(message); e.statusCode = statusCode; return e; };

  if (!admin || !(await admin.matchPassword(password))) {
    throw httpError('Invalid email or password', 401);
  }

  const token = generateToken({ id: admin._id });
  return { admin, token };
};

const getAdmins = async () => {
  return User.find({ role: 'admin' }).select('-password');
};

module.exports = { createAdmin, loginAdmin, getAdmins };