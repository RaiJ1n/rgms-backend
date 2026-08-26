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

// loginAdmin was removed — admin login now goes through the single
// unified authController.login (POST /api/auth/login), which already
// authenticates against the same User collection admins live in. Keeping
// a second admin-only login handler around would let the two drift out
// of sync (e.g. one gets an isActive check updated, the other doesn't),
// which is exactly the bug class this whole change is meant to remove.

module.exports = { registerAdmin };