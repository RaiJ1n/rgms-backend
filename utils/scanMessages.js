// utils/scanMessages.js
// Both the Arduino LCD (rfidService.js's handleRFIDData) and anything HTTP/socket-facing
const SCAN_MESSAGES = {
  success_checkin: {
    lcdLine1: 'WELCOME',
    lcdStage2: { lcdLine1: 'TIME IN', lcdLine2: 'SUCCESS' },
    buzzer: 'short_1',
    title: 'Attendance Recorded Successfully',
    body: (name, time) => `Welcome, ${name}\nTime In: ${time}`,
  },
  success_checkout: {
    lcdLine1: 'GOODBYE',
    lcdStage2: { lcdLine1: 'TIME OUT', lcdLine2: 'SUCCESS' },
    buzzer: 'short_1',
    title: 'Attendance Recorded Successfully',
    body: (name, time) => `Goodbye, ${name}\nTime Out: ${time}`,
  },
  card_unregistered: {
    lcdLine1: 'RFID NOT',
    lcdLine2: 'REGISTERED',
    buzzer: 'continuous_error',
    title: 'RFID Card Not Registered',
    body: 'Please register this RFID card before use.',
  },
  card_deactivated: {
    lcdLine1: 'ACCESS',
    lcdLine2: 'DENIED',
    buzzer: 'short_3',
    title: 'Attendance Denied',
    body: 'This RFID card has been deactivated. Please contact the gym staff.',
  },
  no_subscription: {
    lcdLine1: 'NO ACTIVE',
    lcdLine2: 'SUBSCRIPTION',
    buzzer: 'long_1',
    title: 'Attendance Denied',
    body: 'This member does not currently have an active subscription. Please contact the gym staff.',
  },
  subscription_inactive: {
    lcdLine1: 'NO ACTIVE',
    lcdLine2: 'SUBSCRIPTION',
    buzzer: 'long_1',
    title: 'Attendance Denied',
    body: 'This membership is not currently active. Please contact the gym staff.',
  },
  subscription_expired: {
    lcdLine1: 'SUBSCRIPTION',
    lcdLine2: 'EXPIRED',
    buzzer: 'short_2',
    title: 'Attendance Denied',
    body: 'This membership has expired. Please renew your subscription.',
  },
  member_inactive: {
    lcdLine1: 'ACCOUNT',
    lcdLine2: 'INACTIVE',
    buzzer: 'short_3',
    title: 'Attendance Denied',
    body: 'Your membership is inactive or expired. Please contact the gym administrator.',
  },
  employee_inactive: {
    lcdLine1: 'ACCOUNT',
    lcdLine2: 'INACTIVE',
    buzzer: 'short_3',
    title: 'Attendance Denied',
    body: 'This employee account has been deactivated. Please contact the gym administrator.',
  },
  temp_card_expired: {
    lcdLine1: 'CARD EXPIRED',
    lcdLine2: 'SEE FRONT DESK',
    buzzer: 'short_3',
    title: 'Temporary Card Expired',
    body: 'This temporary card has expired. Please see the front desk.',
  },
  temp_card_not_assigned: {
    lcdLine1: 'CARD NOT',
    lcdLine2: 'ASSIGNED',
    buzzer: 'short_3',
    title: 'Card Not Assigned',
    body: 'This temporary card is not assigned to anyone. Please see the front desk.',
  },
  // The reader re-sent the same card while it was still on the reader
  // This is normal and frequent, so callers keep it SILENT (no LCD change, no admin popup)
  duplicate_signal: {
    lcdLine1: 'DUPLICATE',
    lcdLine2: 'SCAN IGNORED',
    buzzer: null,
    title: 'Duplicate Scan Ignored',
    body: 'This card was already read a moment ago. Lift the card and tap again to record another action.',
  },
  duplicate_scan: {
    lcdLine1: 'PLEASE WAIT',
    lcdLine2: 'TRY AGAIN',
    buzzer: null,
    title: 'Scan Too Soon',
    body: 'Please wait a few seconds and scan again.',
  },
  daily_attendance_completed: {
    lcdLine1: 'ALREADY',
    lcdLine2: 'CHECKED OUT',
    buzzer: 'short_2',
    title: 'Attendance Already Completed',
    body: 'You have already completed your check-in and check-out for today.',
  },
  visitor_pass_expired: {
    lcdLine1: 'VISITOR PASS',
    lcdLine2: 'EXPIRED',
    buzzer: 'short_3',
    title: 'Visitor Pass Expired',
    body: 'This visitor pass is no longer valid. Please ask the front desk for a new one.',
  },
  visitor_pass_not_yet_valid: {
    lcdLine1: 'VISITOR PASS',
    lcdLine2: 'NOT VALID YET',
    buzzer: 'short_3',
    title: 'Visitor Pass Not Valid Yet',
    body: 'This visitor pass is not valid until its issued date.',
  },
  invalid_format: {
    lcdLine1: 'READ ERROR',
    lcdLine2: 'TRY AGAIN',
    buzzer: 'continuous_error',
    title: 'Card Read Error',
    body: 'Could not read this card. Please try scanning again.',
  },
};

// Fallback for any errorType not in the map above
const DEFAULT_MESSAGE = {
  lcdLine1: 'ACCESS',
  lcdLine2: 'DENIED',
  buzzer: 'short_3',
  title: 'Attendance Denied',
  body: 'This scan could not be processed. Please contact the gym staff.',
};

function getScanMessage(key) {
  return SCAN_MESSAGES[key] || DEFAULT_MESSAGE;
}

module.exports = { SCAN_MESSAGES, getScanMessage };