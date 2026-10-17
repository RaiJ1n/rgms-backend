const crypto = require('crypto');
const User = require('../models/User');
const AuthAccount = require('../models/AuthAccount');
const Notification = require('../models/Notification');
const socketUtil = require('../utils/socket');
const generateToken = require('../utils/generateToken');

// Thrown when the provider's email belongs to an existing account that does NOT already have
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

// Short-lived, single-use, in-memory stores
// Neither the raw JWT nor any provider identity ever goes into a URL query string that a browser would keep in history

const EXCHANGE_TTL_MS = 60 * 1000;
const LINK_TICKET_TTL_MS = 10 * 60 * 1000;

const exchangeCodes = new Map();
const linkTickets = new Map();

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

// One-time
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

// Provider profile -> application user

// Called from each passport strategy's verify callback
const handleOAuthProfile = async ({ provider, providerUserId, email, name, avatar }) => {
  // Scenario 2 / 4
  const existingLink = await AuthAccount.findOne({ provider, providerUserId });
  if (existingLink) {
    const user = await User.findById(existingLink.userId);
    if (!user) {
      // The linked User was deleted out from under the AuthAccount record
      return createNewOAuthUser({ provider, providerUserId, email, name, avatar });
    }
    if (!user.isActive) {
      const err = new Error('This account has been deactivated. Please contact the gym.');
      err.statusCode = 403;
      throw err;
    }
    return { user, isNewUser: false };
  }

  // No link yet for this provider account
  if (email) {
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      // Scenario 5
      const existingProviders = (await AuthAccount.find({ userId: existingUser._id })).map((a) => a.provider);
      throw new OAuthAccountConflictError('An account with this email already exists.', {
        email: email.toLowerCase(),
        provider,
        providerUserId,
        existingProviders: existingUser.password ? [...existingProviders, 'password'] : existingProviders,
      });
    }
  }

  return createNewOAuthUser({ provider, providerUserId, email, name, avatar });
};

const createNewOAuthUser = async ({ provider, providerUserId, email, name, avatar }) => {
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
    // No password field at all for an OAuth-only signup
    role: 'user',
    isActive: true,
    isVerified: true,
    // Section D1's privacy-notice gate still applies to everything ELSE an OAuth signup can do next
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

// Called once the user has proven ownership of the pre-existing account by logging
// Called once the user has proven ownership of the pre-existing account by logging in with their password
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