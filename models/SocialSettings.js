const mongoose = require('mongoose');

// Basic http/https URL check
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
    // GCash payment QR (#10)
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

// This collection is a singleton
socialSettingsSchema.statics.getOrCreate = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

module.exports = mongoose.model('SocialSettings', socialSettingsSchema);