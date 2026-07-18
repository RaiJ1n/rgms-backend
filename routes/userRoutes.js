const express = require('express');
const { body } = require('express-validator');
const userController = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/profile', userController.getProfile);
router.put(
  '/profile',
  [body('fullname').optional().notEmpty(), body('phone').optional().isMobilePhone()],
  userController.updateProfile
);
router.get('/subscriptions', userController.getSubscriptions);
router.get('/payments', userController.getPayments);

module.exports = router;
