const express = require('express');
const { body } = require('express-validator');
const settingsController = require('../controllers/settingsController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Public — HomeView.vue's footer reads this without a token
router.get('/social', settingsController.getSocialLinks);

// Admin-only
router.put(
  '/social',
  protect,
  admin,
  [
    body('facebook')
      .optional({ checkFalsy: true })
      .isString()
      .trim()
      .isURL({ protocols: ['http', 'https'], require_protocol: true })
      .withMessage('Enter a valid Facebook URL (starting with http:// or https://)'),
    body('instagram')
      .optional({ checkFalsy: true })
      .isString()
      .trim()
      .isURL({ protocols: ['http', 'https'], require_protocol: true })
      .withMessage('Enter a valid Instagram URL (starting with http:// or https://)'),
  ],
  settingsController.updateSocialLinks
);

// Public
router.get('/payment-qr', settingsController.getPaymentQr);

// Admin-only
router.put(
  '/payment-qr',
  protect,
  admin,
  upload.single('qrImage'),
  settingsController.updatePaymentQr
);

module.exports = router;