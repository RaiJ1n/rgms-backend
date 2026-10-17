const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: FacebookStrategy } = require('passport-facebook');
const oauthService = require('../services/oauthService');

// We never use passport's own session support (no serializeUser / req.session anywhere)

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
            emailVerified: true,
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