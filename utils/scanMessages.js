// utils/scanMessages.js
//
// Single source of truth for "what does a scan outcome look like to a
// human" — mirrors the same "single source of truth" idea
// attendanceService.js already uses for check-in/check-out decisions,
// just for messaging instead of logic. Both the Arduino LCD
// (rfidService.js's handleRFIDData) and anything HTTP/socket-facing
// (rfidController.js, attendanceService.js's rfid:error payloads) pull
// from this one map, so the wording a member sees on the physical
// reader and the wording an admin sees on screen never drift apart.
//
// lcdLine1/lcdLine2 are kept to a handful of characters — this is a
// standard 16x2 LCD, so anything longer gets truncated by the sketch's
// own truncation logic (see the comment in rfidService.js's
// handleRFIDData). title/body are the fuller wording for the REST
// response / admin UI, where there's no 16-column limit.
//
// NOTE on buzzer patterns: the spec calls for distinct buzzer patterns
// per outcome (1 long beep, 2 short beeps, etc.), but sketch_aug7d.ino
// has no buzzer wired up at all — no pin defined, no tone() calls. This
// is a hardware gap, not just a missing software feature, so `buzzer`
// here is metadata only and is not currently sent over serial. If a
// piezo buzzer gets wired later: pins 9-13 (MFRC522/SPI) and A4/A5
// (LCD/I2C) are taken, so pick a free digital pin (e.g. 8), add a
// tone()-based handler in the sketch for a 3rd "|"-separated segment on
// the existing scan-result message, and read `buzzer` from here to send
// it — e.g. `${msg.lcdLine1}|${msg.lcdLine2}|${msg.buzzer}`.
const SCAN_MESSAGES = {
  success_checkin: {
    lcdLine1: 'WELCOME',
    // lcdLine2 is filled in with the member's name at send time.
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
  duplicate_scan: {
    lcdLine1: 'PLEASE WAIT',
    lcdLine2: 'TRY AGAIN',
    buzzer: null,
    title: 'Scan Too Soon',
    body: 'Please wait a few seconds and scan again.',
  },
  invalid_format: {
    lcdLine1: 'READ ERROR',
    lcdLine2: 'TRY AGAIN',
    buzzer: 'continuous_error',
    title: 'Card Read Error',
    body: 'Could not read this card. Please try scanning again.',
  },
};

// Fallback for any errorType not in the map above (defensive — keeps a
// future new errorType from crashing message lookup instead of just
// looking slightly generic).
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