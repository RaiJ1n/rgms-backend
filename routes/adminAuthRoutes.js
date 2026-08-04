const express = require('express');
const { body } = require('express-validator');
const adminAuthController = require('../controllers/adminAuthController');
const { requireAdminIfExists } = require('../middleware/adminBootstrapMiddleware');

const router = express.Router();

router.post(
  '/register',
  requireAdminIfExists,
  [
    body('fullname').notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  adminAuthController.registerAdmin
);

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  adminAuthController.loginAdmin
);

module.exports = router;