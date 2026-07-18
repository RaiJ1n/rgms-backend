const sendMail = require('../config/mailer');

const sendWelcomeEmail = async (user) => {
  const html = `<p>Hi ${user.fullname},</p><p>Welcome to the gym! Your account has been created successfully.</p>`;
  await sendMail({ to: user.email, subject: 'Welcome to Gym System', html });
};

const sendForgotPasswordEmail = async (user, resetUrl) => {
  const html = `<p>Hi ${user.fullname},</p><p>Click the link below to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`;
  await sendMail({ to: user.email, subject: 'Password Reset Request', html });
};

const sendSubscriptionConfirmation = async (user, plan) => {
  const html = `<p>Hi ${user.fullname},</p><p>Your subscription to ${plan.name} is active.</p>`;
  await sendMail({ to: user.email, subject: 'Subscription Activated', html });
};

const sendPaymentStatusEmail = async (user, payment) => {
  const html = `<p>Hi ${user.fullname},</p><p>Your payment with reference ${payment.referenceNumber} is ${payment.status}.</p>`;
  await sendMail({ to: user.email, subject: 'Payment Status Update', html });
};

module.exports = {
  sendWelcomeEmail,
  sendForgotPasswordEmail,
  sendSubscriptionConfirmation,
  sendPaymentStatusEmail,
};
