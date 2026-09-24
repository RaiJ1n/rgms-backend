const sendMail = require('../config/mailer');

const sendWelcomeEmail = async (user) => {
  const html = `<p>Hi ${user.fullname},</p><p>Welcome to the gym! Your account has been created successfully.</p>`;
  await sendMail({ to: user.email, subject: 'Welcome to Gym System', html });
};

const sendVerificationEmail = async (user, verifyUrl) => {
  const html = `<p>Hi ${user.fullname},</p><p>Please confirm your email address by clicking the link below:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`;
  await sendMail({ to: user.email, subject: 'Verify Your Email', html });
};

const sendForgotPasswordOtpEmail = async (user, otp) => {
  const html = `<p>Hi ${user.fullname},</p><p>Your password reset code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${otp}</p><p>This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>`;
  await sendMail({ to: user.email, subject: 'Your Password Reset Code', html });
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

// Password-change OTP (Admin Settings). The code itself is the only
// sensitive value here — no link, nothing else to click — so the email
// stays short and states the expiry plainly.
const sendPasswordChangeOtpEmail = async (user, otp) => {
  const html = `<p>Hi ${user.fullname},</p><p>Your verification code to change your password is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${otp}</p><p>This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>`;
  await sendMail({ to: user.email, subject: 'Your Password Change Verification Code', html });
};

// Coach Settings -> Notification -> personal notification email (Group
// 8). Unlike the OTP flows above, the destination here is a brand-new
// address the coach just typed, not their own existing account email —
// that's the whole point (proving they actually own that inbox before
// it's allowed to become where client/request notifications go), so
// this takes the target email directly rather than reading it off a
// User document.
const sendNotificationEmailOtpEmail = async (toEmail, fullname, otp) => {
  const html = `<p>Hi ${fullname},</p><p>Your verification code to confirm this as your notification email is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${otp}</p><p>This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>`;
  await sendMail({ to: toEmail, subject: 'Your Notification Email Verification Code', html });
};

module.exports = {
  sendWelcomeEmail,
  sendVerificationEmail,
  sendForgotPasswordOtpEmail,
  sendSubscriptionConfirmation,
  sendPaymentStatusEmail,
  sendStudentVerificationEmail,
  sendPasswordChangeOtpEmail,
  sendNotificationEmailOtpEmail,
};