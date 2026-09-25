const passport = require('passport');
const oauthService = require('../services/oauthService');

function safeUser(user) {
  const obj = user.toObject();
  delete obj.password;
  return obj;
}

// clientOrigins.js already collects every allowed frontend origin from
// CLIENT_URL — reuse the first one as "the" frontend URL to redirect
// back to, same convention the rest of the backend uses for
// verify-email/reset-password links (see authController.register's
// verifyUrl and emailService's reset link).
const clientOrigins = require('../config/clientOrigins');
const CLIENT_URL = clientOrigins[0] || 'http://localhost:5173';

// Shared handler for both providers' /callback routes. Rather than the
// plain `passport.authenticate('google', {session:false})` middleware
// form (which has no good hook for "redirect to the frontend with a
// friendly message" on failure), this uses passport's callback form so
// we can turn every outcome — success, conflict, real error, or the
// user hitting "Cancel" on Google/Facebook's consent screen — into an
// appropriate redirect back into the Vue app instead of a raw JSON
// error page.
function callbackHandler(provider) {
  return (req, res, next) => {
    passport.authenticate(provider, { session: false }, async (err, result) => {
      try {
        if (err && err.isConflict) {
          // Scenario 5 — do not create or merge anything. Hand the
          // frontend just enough to explain the situation and offer
          // the link flow, via an opaque ticket rather than exposing
          // the provider's raw id in the URL.
          const ticket = oauthService.createLinkTicket({
            provider: err.provider,
            providerUserId: err.providerUserId,
            email: err.email,
          });
          const params = new URLSearchParams({
            oauthConflict: '1',
            provider: err.provider,
            email: err.email,
            ticket,
            existingMethods: (err.existingProviders || []).join(','),
          });
          return res.redirect(`${CLIENT_URL}/login?${params.toString()}`);
        }

        if (err) {
          console.error(`${provider} OAuth error:`, err.message);
          const params = new URLSearchParams({ oauthError: '1', provider });
          return res.redirect(`${CLIENT_URL}/login?${params.toString()}`);
        }

        if (!result) {
          // User cancelled at the provider's consent screen — passport
          // calls back with no error and no user in that case.
          const params = new URLSearchParams({ oauthCancelled: '1', provider });
          return res.redirect(`${CLIENT_URL}/login?${params.toString()}`);
        }

        const { user, isNewUser } = result;
        const token = oauthService.mintTokenFor(user);
        const code = oauthService.createExchangeCode({ user: safeUser(user), token, isNewUser });

        const params = new URLSearchParams({ code });
        return res.redirect(`${CLIENT_URL}/oauth/callback?${params.toString()}`);
      } catch (handlerErr) {
        next(handlerErr);
      }
    })(req, res, next);
  };
}

const googleCallback = callbackHandler('google');
const facebookCallback = callbackHandler('facebook');

// POST /auth/oauth/exchange — the frontend's /oauth/callback route
// calls this immediately with the `code` it received, trading the
// one-time code for the actual { user, token } JSON. Keeps the JWT
// itself out of the redirect URL/browser history entirely.
const exchangeCode = async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ success: false, message: 'Missing code' });
  }
  const entry = oauthService.consumeExchangeCode(code);
  if (!entry) {
    return res.status(400).json({ success: false, message: 'This login link has expired. Please try again.' });
  }
  res.json({
    success: true,
    message: entry.isNewUser ? 'Account created' : 'Login successful',
    data: { user: entry.user, token: entry.token, isNewUser: entry.isNewUser },
  });
};

// POST /auth/link — protected (runs behind authMiddleware.protect).
// The user has just proven ownership of their existing
// email/password (or already-linked-provider) account by logging in
// normally; this call redeems the ticket handed to them on the
// oauthConflict redirect and actually creates the AuthAccount link.
const linkAccount = async (req, res, next) => {
  try {
    const { ticket } = req.body;
    if (!ticket) return res.status(400).json({ success: false, message: 'Missing link ticket' });
    const provider = await oauthService.linkProviderToUser({ user: req.user, ticket });
    res.json({ success: true, message: `${provider === 'google' ? 'Google' : 'Facebook'} account linked`, data: { provider } });
  } catch (error) {
    next(error);
  }
};

// GET /auth/me — protected. Simple "who am I" endpoint per the spec;
// the rest of the app already had GET /users/profile for the fuller
// profile payload, this is the lightweight session-check counterpart
// used right after login/OAuth and on app boot.
const me = async (req, res) => {
  res.json({ success: true, data: { user: safeUser(req.user) } });
};

module.exports = { googleCallback, facebookCallback, exchangeCode, linkAccount, me };