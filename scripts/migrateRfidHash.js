// scripts/migrateRfidHash.js
//
// Moves EXISTING RFID cards onto keyed UID hashing (utils/uidHash.js).
// Run on the VPS, from the backend folder, with the production .env loaded.
//
//   node scripts/migrateRfidHash.js                  # DRY RUN: reports only, writes nothing
//   node scripts/migrateRfidHash.js --apply          # step 1: add uidHash to every card
//                                                    #         (cardId stays raw — fully reversible)
//   node scripts/migrateRfidHash.js --apply --redact --i-have-a-backup
//                                                    # step 2: replace the raw UID in cardId with
//                                                    #         the opaque CARD-XXXXXXXXXXXX reference
//
// Recommended order:
//   1. Back up the database.  2. Set RFID_HASH_SECRET (32+ random chars) in the
//   VPS .env and restart.  3. --apply.  4. Tap a few real cards, confirm
//   attendance still works.  5. Only then --redact.
//
// After --redact the raw UIDs are gone from the cards collection and CANNOT be
// recovered — and the hashes only mean something while RFID_HASH_SECRET is
// unchanged. Keep a copy of the secret outside the server; if it is lost, every
// card has to be re-bound.
//
// Not touched: old AuditLog entries and attendance history that already contain
// raw UIDs in their `meta`. Those are history; scrub them separately if your
// policy requires it.
const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  /* dotenv optional */
}
const { hashUid, refFromHash, isEnabled } = require('../utils/uidHash');
const { isValidUid } = require('../utils/normalizeUid');

/**
 * Pure-ish core (takes the model) so it can be tested without a database.
 * Returns a report; throws on any condition that must stop the migration.
 */
async function migrate({ RFIDCard, apply = false, redact = false, log = console.log }) {
  if (!isEnabled()) {
    throw new Error('RFID_HASH_SECRET is not set (or shorter than 16 characters). Nothing to do — set it first.');
  }
  if (redact && !apply) throw new Error('--redact requires --apply.');

  // select('+uidHash'): the field is select:false by default.
  const cards = await RFIDCard.find({}).select('+uidHash');
  const report = { total: cards.length, alreadyHashed: 0, toHash: 0, skippedInvalid: [], redacted: 0, collisions: [] };

  const seen = new Map(); // uidHash -> cardId, to catch two cards with the same UID
  for (const c of cards) {
    const alreadyOpaque = /^CARD-[0-9A-F]{12}$/.test(c.cardId);
    const hash = c.uidHash || (alreadyOpaque ? null : hashUid(c.cardId));

    if (!c.uidHash && !hash) {
      report.skippedInvalid.push(c.cardId);
      continue;
    }
    if (!c.uidHash && !isValidUid(c.cardId)) {
      report.skippedInvalid.push(c.cardId);
      continue;
    }
    const h = c.uidHash || hash;
    if (seen.has(h)) {
      report.collisions.push([seen.get(h), c.cardId]);
      continue;
    }
    seen.set(h, c.cardId);

    if (c.uidHash) report.alreadyHashed += 1;
    else report.toHash += 1;

    if (!apply) continue;

    let dirty = false;
    if (!c.uidHash) {
      c.uidHash = h;
      dirty = true;
    }
    if (redact && !alreadyOpaque) {
      c.cardId = refFromHash(h);
      report.redacted += 1;
      dirty = true;
    }
    if (dirty) await c.save();
  }

  log(`Cards found:              ${report.total}`);
  log(`Already hashed:           ${report.alreadyHashed}`);
  log(`${apply ? 'Hashed now:' : 'Would be hashed:'}`.padEnd(26) + report.toHash);
  if (redact) log(`Raw UID redacted:         ${report.redacted}`);
  if (report.skippedInvalid.length) log(`Skipped (not a valid UID): ${report.skippedInvalid.length} -> ${report.skippedInvalid.join(', ')}`);
  if (report.collisions.length) log(`DUPLICATE UIDs (left untouched): ${report.collisions.map((x) => x.join(' / ')).join('; ')}`);
  if (!apply) log('\nDRY RUN — nothing was written. Re-run with --apply to proceed.');
  return report;
}

module.exports = { migrate };

if (require.main === module) {
  (async () => {
    const mongoose = require('mongoose');
    const RFIDCard = require('../models/RFIDCard');
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const redact = args.includes('--redact');
    if (redact && !args.includes('--i-have-a-backup')) {
      console.error('Refusing --redact without --i-have-a-backup. Redaction is irreversible: back up the database first.');
      process.exit(1);
    }
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
      console.error('MONGODB_URI is not set.');
      process.exit(1);
    }
    await mongoose.connect(uri);
    try {
      await migrate({ RFIDCard, apply, redact });
    } catch (e) {
      console.error(`\nSTOPPED: ${e.message}`);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}