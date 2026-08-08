const mongoose = require('mongoose');

// Basic http/https URL check. Intentionally permissive about path/query
// structure — we only need to guard against non-URLs (e.g. "n/a",
// "@remersgym") being saved, not enforce that the link points at a real
// Facebook/Instagram profile.
const urlPattern = /^https?:\/\/[^\s]+$/i;

const socialSettingsSchema = new mongoose.Schema(
  {
    facebook: {
      type: String,
      trim: true,
      default: '',
      match: [urlPattern, 'Facebook link must be a valid URL starting with http:// or https://'],
    },
    instagram: {
      type: String,
      trim: true,
      default: '',
      match: [urlPattern, 'Instagram link must be a valid URL starting with http:// or https://'],
    },
    // GCash payment QR (#10). Stored alongside the social links since this
    // is already the app's one "site settings" singleton document.
    // gcashQrUrl is the Cloudinary-hosted image URL served to members;
    // gcashQrPublicId is kept so the old Cloudinary asset can be removed
    // when the admin uploads a replacement, same pattern as other
    // Cloudinary-backed uploads in this app.
    gcashQrUrl: {
      type: String,
      trim: true,
      default: '',
    },
    gcashQrPublicId: {
      type: String,
      trim: true,
      default: '',
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// This collection is a singleton — the app only ever reads/writes one
// document. getOrCreate() centralizes that "find the one doc, or make it
// if this is the very first time anyone touches Settings" logic so
// settingsController doesn't have to duplicate it across handlers.
socialSettingsSchema.statics.getOrCreate = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

module.exports = mongoose.model('SocialSettings', socialSettingsSchema);