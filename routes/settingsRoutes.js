const express = require('express');
const { body } = require('express-validator');
const settingsController = require('../controllers/settingsController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Public — HomeView.vue's footer reads this without a token.
router.get('/social', settingsController.getSocialLinks);

// Admin-only — same protect+admin pair adminRoutes.js applies everywhere
// else, just scoped to this one route instead of the whole router since
// the GET above must stay public.
router.put(
  '/social',
  protect,
  admin,
  [
    // checkFalsy: true lets an admin submit an empty string to clear a
    // link back to unset, without that empty string failing the isURL
    // check — only a non-empty, malformed value should be rejected.
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

// Public — GcashConfirmation.vue reads this without a token, same
// reasoning as GET /social above.
router.get('/payment-qr', settingsController.getPaymentQr);

// Admin-only — same protect+admin pair as PUT /social. upload.single
// pushes the file to Cloudinary via uploadMiddleware (already used for
// Student ID and profile photo uploads) before updatePaymentQr runs, so
// req.file.path / req.file.filename are populated by the time the
// controller sees the request.
router.put(
  '/payment-qr',
  protect,
  admin,
  upload.single('qrImage'),
  settingsController.updatePaymentQr
);

module.exports = router;