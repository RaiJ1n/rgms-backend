const mongoose = require('mongoose');

// One document per (provider, providerUserId) pair, always pointing back at a single application User
// Kept separate from User.js (rather than adding googleId/facebookId fields directly on User) so that
const authAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, enum: ['google', 'facebook'], required: true },
    // The provider's own stable identifier for the account (Google "sub", Facebook "id") — never the email
    providerUserId: { type: String, required: true, trim: true },
    // Snapshot of what the provider returned at (re)auth time, for display/debugging only — never
    email: { type: String, trim: true, lowercase: true },
  },
  { timestamps: true }
);

// The actual uniqueness guarantee
authAccountSchema.index({ provider: 1, providerUserId: 1 }, { unique: true });
// Fast "does this user already have Google linked" checks (Settings page, unlink flow)
authAccountSchema.index({ userId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('AuthAccount', authAccountSchema);