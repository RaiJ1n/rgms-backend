const sendMail = require('../config/mailer');

const sendWelcomeEmail = async (user) => {
  const html = `<p>Hi ${user.fullname},</p><p>Welcome to the gym! Your account has been created successfully.</p>`;
  await sendMail({ to: user.email, subject: 'Welcome to Gym System', html });
};

const sendVerificationEmail = async (user, verifyUrl) => {
  const html = `<p>Hi ${user.fullname},</p><p>Please confirm your email address by clicking the link below:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`;
  await sendMail({ to: user.email, subject: 'Verify Your Email', html });
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

const sendStudentVerificationEmail = async (user, approved, reason) => {
  const html = approved
    ? `<p>Hi ${user.fullname},</p><p>Your student ID has been verified. Your student promo is now active.</p>`
    : `<p>Hi ${user.fullname},</p><p>Your student ID submission was not approved.${reason ? ` Reason: ${reason}` : ''} Please submit a clearer photo and try again.</p>`;
  await sendMail({
    to: user.email,
    subject: approved ? 'Student Discount Verified' : 'Student ID Verification Update',
    html,
  });
};

module.exports = {
  sendWelcomeEmail,
  sendVerificationEmail,
  sendForgotPasswordEmail,
  sendSubscriptionConfirmation,
  sendPaymentStatusEmail,
  sendStudentVerificationEmail,
};