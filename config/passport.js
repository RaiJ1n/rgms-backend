const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: FacebookStrategy } = require('passport-facebook');
const oauthService = require('../services/oauthService');

// We never use passport's own session support (no serializeUser /
// req.session anywhere) — every route that uses these strategies is
// called with { session: false }, and authentication for the rest of
// the app continues to run entirely on the existing JWT
// (authMiddleware.protect). Passport here is only a well-tested OAuth2
// handshake implementation, not a session manager.

const callbackURL = (provider) =>
  `${process.env.SERVER_URL || 'http://localhost:4000'}/api/auth/${provider}/callback`;

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: callbackURL('google'),
      },
      // verify callback — runs after Google redirects back with a code
      // passport has already exchanged for a profile. We do no DB work
      // here beyond handing the raw profile to oauthService; done is
      // passport's standard (err, user) completion callback.
      async (accessToken, refreshToken, profile, done) => {
        try {
          const result = await oauthService.handleOAuthProfile({
            provider: 'google',
            providerUserId: profile.id,
            email: profile.emails?.[0]?.value || null,
            emailVerified: profile.emails?.[0]?.verified ?? true,
            name: profile.displayName || [profile.name?.givenName, profile.name?.familyName].filter(Boolean).join(' '),
            avatar: profile.photos?.[0]?.value || null,
          });
          done(null, result);
        } catch (err) {
          // oauthService throws OAuthAccountConflictError for the
          // "email already belongs to a different login method" case
          // (see that file) — passport forwards it through to done()
          // as an error, and oauthController's callback handler below
          // is what actually inspects err.isConflict and redirects the
          // user appropriately instead of a generic 500.
          done(err, null);
        }
      }
    )
  );
} else {
  console.warn('Google OAuth not configured: set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to enable it.');
}

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: callbackURL('facebook'),
        profileFields: ['id', 'displayName', 'name', 'emails', 'photos'],
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const result = await oauthService.handleOAuthProfile({
            provider: 'facebook',
            providerUserId: profile.id,
            email: profile.emails?.[0]?.value || null,
            emailVerified: true, // Facebook doesn't return a verified flag; email itself may be absent
            name: profile.displayName || [profile.name?.givenName, profile.name?.familyName].filter(Boolean).join(' '),
            avatar: profile.photos?.[0]?.value || null,
          });
          done(null, result);
        } catch (err) {
          done(err, null);
        }
      }
    )
  );
} else {
  console.warn('Facebook OAuth not configured: set FACEBOOK_APP_ID / FACEBOOK_APP_SECRET to enable it.');
}

module.exports = passport;