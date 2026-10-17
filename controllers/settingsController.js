const { validationResult } = require('express-validator');
const SocialSettings = require('../models/SocialSettings');
const cloudinary = require('../config/cloudinary');

// Public — no auth
// Always returns a 200 with (possibly empty) strings rather than 404ing
const getSocialLinks = async (req, res, next) => {
  try {
    const settings = await SocialSettings.getOrCreate();
    res.json({
      success: true,
      data: {
        facebook: settings.facebook || '',
        instagram: settings.instagram || '',
      },
    });
  } catch (error) {
    next(error);
  }
};

// Admin-only (protect, admin applied in adminRoutes.js, same as every other admin endpoint)
const updateSocialLinks = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { facebook, instagram } = req.body;
    const settings = await SocialSettings.getOrCreate();

    if (facebook !== undefined) settings.facebook = facebook.trim();
    if (instagram !== undefined) settings.instagram = instagram.trim();
    settings.updatedBy = req.user._id;

    await settings.save();

    res.json({
      success: true,
      message: 'Social links updated',
      data: {
        facebook: settings.facebook || '',
        instagram: settings.instagram || '',
      },
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(422).json({ success: false, message: messages[0], errors: messages });
    }
    next(error);
  }
};

// Public — no auth
// Same "always 200, empty string until configured" contract as getSocialLinks
const getPaymentQr = async (req, res, next) => {
  try {
    const settings = await SocialSettings.getOrCreate();
    res.json({
      success: true,
      data: {
        gcashQrUrl: settings.gcashQrUrl || '',
      },
    });
  } catch (error) {
    next(error);
  }
};

// Admin-only (protect, admin applied in settingsRoutes.js, same pairing used for PUT /social)
const updatePaymentQr = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'QR image is required' });
    }

    const settings = await SocialSettings.getOrCreate();
    const previousPublicId = settings.gcashQrPublicId;

    settings.gcashQrUrl = req.file.path;
    settings.gcashQrPublicId = req.file.filename;
    settings.updatedBy = req.user._id;
    await settings.save();

    if (previousPublicId) {
      cloudinary.uploader.destroy(previousPublicId).catch((err) => {
        console.error('Failed to remove previous GCash QR from Cloudinary:', err.message);
      });
    }

    res.json({
      success: true,
      message: 'GCash QR code updated',
      data: {
        gcashQrUrl: settings.gcashQrUrl,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSocialLinks,
  updateSocialLinks,
  getPaymentQr,
  updatePaymentQr,
};