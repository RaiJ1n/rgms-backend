const mongoose = require('mongoose');

// One document per (provider, providerUserId) pair, always pointing
// back at a single application User. Kept separate from User.js
// (rather than adding googleId/facebookId fields directly on User) so
// that:
//   - a user can have Google AND Facebook AND email/password all at
//     once, without a growing set of provider-specific columns on User
//   - "does this provider identity already exist" is one indexed
//     lookup, independent of anything else on the user's account
//   - linking/unlinking a provider never touches the User document
//     itself
const authAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, enum: ['google', 'facebook'], required: true },
    // The provider's own stable identifier for the account (Google
    // "sub", Facebook "id") — never the email, since email can change
    // on the provider's side or be missing/unverified entirely.
    providerUserId: { type: String, required: true, trim: true },
    // Snapshot of what the provider returned at (re)auth time, for
    // display/debugging only — never used as the lookup key.
    email: { type: String, trim: true, lowercase: true },
  },
  { timestamps: true }
);

// The actual uniqueness guarantee: this exact provider account can
// only ever be linked to one User. Prevents a race where two
// near-simultaneous callbacks for the same Google account both try to
// create a fresh link.
authAccountSchema.index({ provider: 1, providerUserId: 1 }, { unique: true });
// Fast "does this user already have Google linked" checks (Settings
// page, unlink flow).
authAccountSchema.index({ userId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('AuthAccount', authAccountSchema);