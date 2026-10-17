const passport = require('passport');
const oauthService = require('../services/oauthService');

function safeUser(user) {
  const obj = user.toObject();
  delete obj.password;
  return obj;
}

// clientOrigins.js already collects every allowed frontend origin from CLIENT_URL
const clientOrigins = require('../config/clientOrigins');
const CLIENT_URL = clientOrigins[0] || 'http://localhost:5173';

// Shared handler for both providers
function callbackHandler(provider) {
  return (req, res, next) => {
    passport.authenticate(provider, { session: false }, async (err, result) => {
      try {
        if (err && err.isConflict) {
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
          // User cancelled at the provider's consent screen
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

// Calls this immediately with the `code` it received, trading the one-time code for the actual
// Calls this immediately with the `code` it received, trading the one-time code for the actual { user, token } JSON
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

// The user has just proven ownership of their existing email/password
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

// The rest of the app already had GET /users/profile for the fuller profile payload
const me = async (req, res) => {
  res.json({ success: true, data: { user: safeUser(req.user) } });
};

module.exports = { googleCallback, facebookCallback, exchangeCode, linkAccount, me };