const { validationResult } = require('express-validator');
const adminService = require('../services/adminService');
const emailService = require('../services/emailService');

const registerAdmin = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { fullname, email, password, phone } = req.body;

    const { admin, token } = await adminService.createAdmin({ fullname, email, password, phone });
    if (emailService && emailService.sendWelcomeEmail) await emailService.sendWelcomeEmail(admin);
    const safeAdmin = admin.toObject();
    delete safeAdmin.password;
    res.status(201).json({ success: true, message: 'Admin registered', data: { admin: safeAdmin, token } });
  } catch (error) {
    next(error);
  }
};

const loginAdmin = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { email, password } = req.body;
    const { admin, token } = await adminService.loginAdmin({ email, password });
    const safeAdmin = admin.toObject();
    delete safeAdmin.password;
    res.json({ success: true, message: 'Login successful', data: { admin: safeAdmin, token } });
  } catch (error) {
    next(error);
  }
};

module.exports = { registerAdmin, loginAdmin };