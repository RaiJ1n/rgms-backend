const crypto = require('crypto');
const User = require('../models/User');
const AuthAccount = require('../models/AuthAccount');
const Notification = require('../models/Notification');
const socketUtil = require('../utils/socket');
const generateToken = require('../utils/generateToken');

// Thrown when the provider's email belongs to an existing account that
// does NOT already have this provider linked (Scenario 5 in the spec).
// oauthController catches this specifically and sends the user down
// the link-ticket flow below instead of a generic error page.
class OAuthAccountConflictError extends Error {
  constructor(message, { email, provider, providerUserId, existingProviders }) {
    super(message);
    this.name = 'OAuthAccountConflictError';
    this.isConflict = true;
    this.email = email;
    this.provider = provider;
    this.providerUserId = providerUserId;
    this.existingProviders = existingProviders;
  }
}

// ---------------------------------------------------------------------
// Short-lived, single-use, in-memory stores.
//
// Neither the raw JWT nor any provider identity ever goes into a URL
// query string that a browser would keep in history — the callback
// redirect only ever carries an opaque random code/ticket that's
// useless once exchanged and expires quickly on its own. This is
// intentionally in-process (a plain Map) rather than a new
// MongoDB collection: entries live for well under a minute in the
// normal flow and there's nothing here worth persisting across a
// restart. NOTE for production behind more than one server instance:
// swap this for a shared store (Redis, or a capped Mongo collection
// with a TTL index) so a code minted on one instance can be redeemed
// on another.
// ---------------------------------------------------------------------

const EXCHANGE_TTL_MS = 60 * 1000; // one minute to complete the redirect + exchange
const LINK_TICKET_TTL_MS = 10 * 60 * 1000; // ten minutes to go log in and link

const exchangeCodes = new Map(); // code -> { user, token, isNewUser, expiresAt }
const linkTickets = new Map(); // ticket -> { provider, providerUserId, email, name, avatar, expiresAt }

function sweepExpired(store) {
  const now = Date.now();
  for (const [key, value] of store) {
    if (value.expiresAt <= now) store.delete(key);
  }
}

function createExchangeCode(payload) {
  sweepExpired(exchangeCodes);
  const code = crypto.randomBytes(32).toString('hex');
  exchangeCodes.set(code, { ...payload, expiresAt: Date.now() + EXCHANGE_TTL_MS });
  return code;
}

// One-time: the code is deleted as soon as it's read, whether or not
// the read "succeeds", so it can never be replayed.
function consumeExchangeCode(code) {
  sweepExpired(exchangeCodes);
  const entry = exchangeCodes.get(code);
  if (!entry) return null;
  exchangeCodes.delete(code);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

function createLinkTicket(payload) {
  sweepExpired(linkTickets);
  const ticket = crypto.randomBytes(32).toString('hex');
  linkTickets.set(ticket, { ...payload, expiresAt: Date.now() + LINK_TICKET_TTL_MS });
  return ticket;
}

function peekLinkTicket(ticket) {
  sweepExpired(linkTickets);
  const entry = linkTickets.get(ticket);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

function consumeLinkTicket(ticket) {
  const entry = peekLinkTicket(ticket);
  linkTickets.delete(ticket);
  return entry;
}

// ---------------------------------------------------------------------
// Provider profile -> application user
// ---------------------------------------------------------------------

// Called from each passport strategy's verify callback. Returns
// { user, isNewUser: boolean } on success, or throws
// OAuthAccountConflictError if the provider's email already belongs to
// a different login method and shouldn't be silently merged.
const handleOAuthProfile = async ({ provider, providerUserId, email, name, avatar }) => {
  // Scenario 2 / 4 — this exact provider account has signed in before.
  const existingLink = await AuthAccount.findOne({ provider, providerUserId });
  if (existingLink) {
    const user = await User.findById(existingLink.userId);
    if (!user) {
      // The linked User was deleted out from under the AuthAccount
      // record — treat as a fresh signup rather than a dead end.
      return createNewOAuthUser({ provider, providerUserId, email, name, avatar });
    }
    if (!user.isActive) {
      const err = new Error('This account has been deactivated. Please contact the gym.');
      err.statusCode = 403;
      throw err;
    }
    return { user, isNewUser: false };
  }

  // No link yet for this provider account. If the provider gave us an
  // email, check whether it already belongs to some application user
  // (email/password signup, or a different provider).
  if (email) {
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      // Scenario 5 — same email, different/no login method linked yet.
      // Never auto-merge. Find out what login methods it already has
      // (for the message shown to the user) and hand back a conflict.
      const existingProviders = (await AuthAccount.find({ userId: existingUser._id })).map((a) => a.provider);
      throw new OAuthAccountConflictError('An account with this email already exists.', {
        email: email.toLowerCase(),
        provider,
        providerUserId,
        existingProviders: existingUser.password ? [...existingProviders, 'password'] : existingProviders,
      });
    }
  }

  // Scenario 1 / 3 — genuinely new person.
  return createNewOAuthUser({ provider, providerUserId, email, name, avatar });
};

const createNewOAuthUser = async ({ provider, providerUserId, email, name, avatar }) => {
  // Google/Facebook accounts without a public email are rare but
  // possible (Facebook in particular). The User model requires a
  // unique email, so we can't create a normal account without one —
  // surface this as a plain error rather than inventing a fake email.
  if (!email) {
    const err = new Error(
      `Your ${provider === 'google' ? 'Google' : 'Facebook'} account did not share an email address, so we can't create an account from it. Please allow email access and try again.`
    );
    err.statusCode = 400;
    throw err;
  }

  const user = await User.create({
    fullname: name || email.split('@')[0],
    email: email.toLowerCase(),
    // No password field at all for an OAuth-only signup — see
    // User.js's matchPassword()/hasPassword() for how the rest of the
    // app treats that.
    role: 'user',
    isActive: true,
    isVerified: true, // the provider already verified this email for us
    // Section D1's privacy-notice gate still applies to everything
    // ELSE an OAuth signup can do next (profile edits, medical uploads,
    // etc.) — it's just not collected again here since there's no
    // signup form step to attach it to for this flow. It's asked for
    // the first time any of those gated actions is attempted, same as
    // any pre-existing account created before this field existed.
    photo: avatar ? { url: avatar } : undefined,
  });

  await AuthAccount.create({ userId: user._id, provider, providerUserId, email: email.toLowerCase() });

  Notification.create({
    type: 'signup',
    message: `${user.fullname} just signed up with ${provider === 'google' ? 'Google' : 'Facebook'}`,
    userId: user._id,
  })
    .then((notification) => socketUtil.emitToAdmins('notification:new', notification))
    .catch((err) => console.error('Failed to create signup notification:', err.message));
  socketUtil.emitToAdmins('stats:refresh');

  return { user, isNewUser: true };
};

// Called once the user has proven ownership of the pre-existing
// account by logging in with their password (or an already-linked
// provider) — req.user is populated by authMiddleware.protect by the
// time this runs. Cross-checks the ticket's email against the
// now-authenticated user as a second guard against linking the wrong
// account.
const linkProviderToUser = async ({ user, ticket }) => {
  const pending = consumeLinkTicket(ticket);
  if (!pending) {
    const err = new Error('This link request has expired. Please try connecting the account again.');
    err.statusCode = 400;
    throw err;
  }
  if (pending.email && pending.email !== user.email.toLowerCase()) {
    const err = new Error('That account does not match the email you are logged in with.');
    err.statusCode = 400;
    throw err;
  }

  const alreadyLinked = await AuthAccount.findOne({ provider: pending.provider, providerUserId: pending.providerUserId });
  if (alreadyLinked) {
    const err = new Error('That account is already linked to a different user.');
    err.statusCode = 409;
    throw err;
  }

  await AuthAccount.create({
    userId: user._id,
    provider: pending.provider,
    providerUserId: pending.providerUserId,
    email: pending.email,
  });

  return pending.provider;
};

const listLinkedProviders = async (userId) => {
  const accounts = await AuthAccount.find({ userId }).select('provider createdAt');
  return accounts.map((a) => ({ provider: a.provider, linkedAt: a.createdAt }));
};

const mintTokenFor = (user) => generateToken({ id: user._id, tokenVersion: user.tokenVersion || 0 });

module.exports = {
  OAuthAccountConflictError,
  handleOAuthProfile,
  createExchangeCode,
  consumeExchangeCode,
  createLinkTicket,
  peekLinkTicket,
  consumeLinkTicket,
  linkProviderToUser,
  listLinkedProviders,
  mintTokenFor,
};