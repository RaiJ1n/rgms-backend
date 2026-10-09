const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');
const rfidService = require('../services/rfidService');
const { normalizeUid, isValidUid } = require('../utils/normalizeUid');
const cardLookup = require('../services/rfidCardLookup');
const rfidBinding = require('../services/rfidBinding');
const { identityFor, logUid } = require('../utils/uidHash');
const visitorPassService = require('../services/visitorPassService');

exports.registerCard = async (req, res, next) => {
  try {
    const { userId, coachId } = req.body;
    // Accept `uid` as an alias — some hardware/clients send { uid }
    // while the documented contract is { cardId }.
    const rawCardId = req.body.cardId ?? req.body.uid;

    if (!rawCardId) {
      return res.status(400).json({
        success: false,
        message: 'cardId is required',
      });
    }
    if (!userId && !coachId) {
      return res.status(400).json({
        success: false,
        message: 'Either userId or coachId is required',
      });
    }
    if (userId && coachId) {
      return res.status(400).json({
        success: false,
        message: 'A card can belong to a member or an employee, not both',
      });
    }

    // Normalize on BIND side (same util as SCAN side): strips spaces,
    // dashes, colons, trims \r\n, uppercases. "A1 B2 C3 D4" and
    // "a1b2c3d4" both bind as "A1B2C3D4".
    const cardId = normalizeUid(rawCardId);
    console.log(`[RFID] Bind request — incoming: ${logUid(rawCardId)} → normalized: ${logUid(cardId)}`);

    // Validate UID format (hexadecimal, 8-14 characters)
    if (!/^[0-9A-F]{8,14}$/i.test(cardId)) {
      return res.status(400).json({
        success: false,
        message: 'cardId must be valid hexadecimal (8-14 characters)',
      });
    }

    // Check if card already registered (normalized, so "A1 B2 C3 D4"
    // can never silently duplicate "A1B2C3D4"). An existing document only
    // blocks the bind when it is a REAL assignment - see services/rfidBinding.js.
    const existing = await cardLookup.findByUid(cardId);
    let reclaimable = null;
    if (existing) {
      const kind = await rfidBinding.classifyExisting(existing, { userId, coachId });
      if (kind === rfidBinding.KIND.SAME) {
        // Idempotent: the bridge auto-bind may have created it a moment ago.
        return res.status(200).json({
          success: true,
          alreadyBound: true,
          message: rfidBinding.MESSAGES.same,
          data: existing,
          lcd: { line1: 'RFID BOUND', line2: existing.cardId.slice(0, 16) },
        });
      }
      if (kind !== rfidBinding.KIND.ORPHAN) {
        return res.status(409).json({ success: false, message: rfidBinding.MESSAGES[kind] });
      }
      reclaimable = existing;
    }

    // Verify the owner exists in the right collection
    let ownerName;
    if (userId) {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      ownerName = user.fullname;
    } else {
      const coach = await Coach.findById(coachId);
      if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });
      ownerName = coach.fullname;
    }

    // Create RFID card document (or re-point an orphan left by a deleted owner)
    let card;
    if (reclaimable) {
      card = await rfidBinding.reclaimOrphan(reclaimable, { userId, coachId, adminId: req.user._id, via: 'register' });
    } else {
      card = new RFIDCard({
        ...identityFor(cardId), // opaque reference + keyed hash when RFID_HASH_SECRET is set
        userId: userId || undefined,
        coachId: coachId || undefined,
        active: true,
        assignedAt: new Date(),
      });
      try {
        await card.save();
      } catch (saveErr) {
        // Lost a race with the bridge/serial auto-bind for the same tap: the
        // unique index fired. Re-read and answer from what is really stored.
        if (saveErr && saveErr.code === 11000) {
          const raced = await cardLookup.findByUid(cardId);
          if (raced) {
            const kind = await rfidBinding.classifyExisting(raced, { userId, coachId });
            if (kind === rfidBinding.KIND.SAME) {
              return res.status(200).json({
                success: true,
                alreadyBound: true,
                message: rfidBinding.MESSAGES.same,
                data: raced,
                lcd: { line1: 'RFID BOUND', line2: raced.cardId.slice(0, 16) },
              });
            }
            return res.status(409).json({ success: false, message: rfidBinding.MESSAGES[kind] || rfidBinding.MESSAGES.other });
          }
        }
        throw saveErr;
      }
    }

    // Audit log (reclaimOrphan already wrote its own, richer entry)
    if (!reclaimable) {
      await AuditLog.create({
        action: 'rfid_register',
        userId: req.user._id, // Admin who registered
        meta: { cardId: card.cardId, ownerId: userId || coachId, ownerType: userId ? 'member' : 'employee' },
      });
    }

    // Notify member (if Socket.IO connected) — employees don't have a
    // member-side session to notify, so this only fires for userId.
    if (userId) {
      socketUtil.emitToUser(userId, 'rfid:updated', {
        bound: true,
        cardId: card.cardId,
        active: card.active,
      });
    }
    // All admins (drives the bind modal + any serial bridge relay).
    socketUtil.emitToAdmins('rfid:bound', {
      cardId: card.cardId,
      ownerId: userId || coachId,
      ownerType: userId ? 'member' : 'employee',
      at: new Date(),
    });

    console.log(`[RFID] Card registered: ${cardId} → ${ownerName}`);

    // Push the binding result to the physical LCD when a serial reader is
    // attached to THIS backend instance. Without this, a successful bind
    // left the LCD sitting on the earlier "Card detected" ack with no
    // confirmation. No-op when no serial port is open (e.g. VPS
    // deployment — see scripts/rfidBridge.js, which relays the `rfid:bound`
    // socket event to its local Arduino instead).
    rfidService.sendToArduino(`RFID BOUND|${card.cardId.slice(0, 16)}`);
    // Split deployment: the bridge polls /device-status and shows this on its LCD.
    rfidService.noteBound(card.cardId, userId || coachId);

    res.status(201).json({
      success: true,
      message: 'Card registered successfully',
      data: card,
      lcd: { line1: 'RFID BOUND', line2: card.cardId.slice(0, 16) },
    });
  } catch (err) {
    next(err);
  }
};

exports.listCards = async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    // Visitor passes have their own list (GET /temporary); keep them out of
    // the member/employee card list. `$ne` (not `=== 'MEMBER'`) so cards
    // created before cardType existed are still returned.
    const cards = await RFIDCard.find({ cardType: { $ne: 'TEMPORARY' } })
      .populate('userId', 'fullname email')
      .populate('coachId', 'fullname email')
      .sort({ createdAt: -1 })
      .limit(limitNum);

    res.json({ success: true, data: cards });
  } catch (err) {
    next(err);
  }
};

const attendanceService = require('../services/attendanceService');
const { getScanMessage } = require('../utils/scanMessages');
const { startOfLocalDay, endOfLocalDay, formatLocalDateLabel } = require('../utils/localDate');

// Auto-bind a tap captured in binding mode when the admin already picked an
// owner (EditMember bind modal). Mirrors rfidService.handleRFIDData's serial
// auto-bind so the REST/bridge path binds WITHOUT depending on the browser's
// socket round-trip (rfid:scanned → POST /register). If the browser also
// POSTs /register it converges: "already assigned to this account" is
// treated as success by EditMember.vue.
async function autoBindCaptured(cardId, session) {
  const ownerId = session.userId || session.coachId;
  const ownerType = session.userId ? 'member' : 'employee';

  const existing = await cardLookup.findByUid(cardId);
  let reclaimable = null;
  if (existing) {
    const kind = await rfidBinding.classifyExisting(existing, { userId: session.userId, coachId: session.coachId });
    if (kind === rfidBinding.KIND.SAME) {
      rfidService.noteBound(existing.cardId, ownerId);
      socketUtil.emitToAdmins('rfid:bound', { cardId: existing.cardId, ownerId, ownerType, at: new Date() });
      return { status: 200, bound: true, message: 'Card already bound to this account', lcd: { line1: 'RFID BOUND', line2: existing.cardId.slice(0, 16) } };
    }
    if (kind !== rfidBinding.KIND.ORPHAN) {
      socketUtil.emitToAdmins('rfid:error', {
        title: 'RFID Already Registered',
        message: rfidBinding.MESSAGES[kind],
        timestamp: new Date(),
        uid: logUid(cardId),
      });
      return { status: 409, bound: false, message: 'RFID already registered', lcd: { line1: 'ALREADY', line2: 'REGISTERED' } };
    }
    reclaimable = existing;
  }

  let ownerName;
  if (session.userId) {
    const user = await User.findById(session.userId);
    if (!user) return { status: 404, bound: false, message: 'Selected member not found', lcd: { line1: 'BIND FAILED', line2: 'NO MEMBER' } };
    ownerName = user.fullname;
  } else {
    const coach = await Coach.findById(session.coachId);
    if (!coach) return { status: 404, bound: false, message: 'Selected employee not found', lcd: { line1: 'BIND FAILED', line2: 'NO MEMBER' } };
    ownerName = coach.fullname;
  }

  let created;
  if (reclaimable) {
    created = await rfidBinding.reclaimOrphan(reclaimable, {
      userId: session.userId, coachId: session.coachId, adminId: session.startedBy, via: 'bridge-auto-bind',
    });
  } else {
    try {
      created = await RFIDCard.create({
        ...identityFor(cardId),
        userId: session.userId || undefined,
        coachId: session.coachId || undefined,
        active: true,
        assignedAt: new Date(),
      });
    } catch (e) {
      // The browser's POST /register won the race for the same tap.
      if (e && e.code === 11000) {
        const raced = await cardLookup.findByUid(cardId);
        if (raced && (await rfidBinding.classifyExisting(raced, { userId: session.userId, coachId: session.coachId })) === rfidBinding.KIND.SAME) {
          rfidService.noteBound(raced.cardId, ownerId);
          return { status: 200, bound: true, message: 'Card already bound to this account', lcd: { line1: 'RFID BOUND', line2: raced.cardId.slice(0, 16) } };
        }
        return { status: 409, bound: false, message: 'RFID already registered', lcd: { line1: 'ALREADY', line2: 'REGISTERED' } };
      }
      throw e;
    }
    await AuditLog.create({
      action: 'rfid_register',
      userId: session.startedBy || undefined,
      meta: { cardId: created.cardId, ownerId, ownerType, via: 'bridge-auto-bind' },
    }).catch(() => {});
  }
  if (session.userId) socketUtil.emitToUser(session.userId, 'rfid:updated', { bound: true, cardId: created.cardId, active: true });
  socketUtil.emitToAdmins('rfid:bound', { cardId: created.cardId, ownerId, ownerType, at: new Date() });
  rfidService.noteBound(created.cardId, ownerId);
  console.log(`[RFID] Binding successful (REST) — ${created.cardId} → ${ownerName}`);
  return { status: 201, bound: true, message: 'Card registered successfully', lcd: { line1: 'RFID BOUND', line2: created.cardId.slice(0, 16) } };
}

exports.scanCard = async (req, res, next) => {
  try {
    // Accept `uid` alias (hardware often sends { uid }) alongside { cardId }.
    const rawCardId = req.body.cardId ?? req.body.uid;
    if (!rawCardId) {
      return res.status(400).json({ success: false, message: 'cardId is required' });
    }
    const cardId = normalizeUid(rawCardId);
    const source = req.headers['x-bridge-id'] || req.ip;
    console.log(`[RFID] REST scan — source: ${source} — incoming: ${logUid(rawCardId)} → normalized: ${logUid(cardId)}`);

    // A tap that is not a real hex UID (stray serial text, debug lines) must
    // never be broadcast as a "detected card" nor reach the binding UI.
    if (!isValidUid(cardId)) {
      const msg = getScanMessage('invalid_format');
      console.log(`[RFID] REST scan rejected — not a valid UID: "${String(rawCardId).trim().slice(0, 40)}"`);
      return res.status(400).json({
        success: false,
        message: msg.title,
        detail: msg.body,
        lcd: { line1: msg.lcdLine1, line2: msg.lcdLine2 },
      });
    }

    // Binding-mode router (mirrors the serial path in
    // services/rfidService.js handleRFIDData): while an admin has binding
    // mode enabled, a tap is a registration candidate — NOT an attendance
    // scan.
    const status = rfidService.getStatus();
    if (status.registrationMode) {
      socketUtil.emitToAdmins('rfid:scanned', { cardId, at: new Date() });
      const session = status.binding || {};
      const hasOwner = !!(session.userId || session.coachId);
      console.log(`[RFID] OPERATION: BINDING (REST) — captured ${cardId}, owner=${hasOwner ? (session.userId || session.coachId) : '(none — capture only)'}`);

      if (!hasOwner) {
        return res.json({
          success: true,
          bindingMode: true,
          bound: false,
          message: 'Card detected — ready to bind',
          data: { cardId },
          lcd: { line1: 'Card detected', line2: cardId.slice(0, 16) },
        });
      }

      const result = await autoBindCaptured(cardId, session);
      return res.status(result.status).json({
        success: result.bound,
        bindingMode: true,
        bound: result.bound,
        message: result.message,
        data: { cardId },
        lcd: result.lcd,
      });
    }

    const { action, attendance, user } = await attendanceService.processScan(cardId);

    // Same message map the Arduino LCD reads from (utils/scanMessages.js)
    // — this REST fallback (used when no serial device is connected, or
    // by any other client that hits /rfid/scan directly) says exactly
    // the same thing a member would see on the physical reader.
    const msg = getScanMessage(action === 'checkin' ? 'success_checkin' : 'success_checkout');
    const eventTime = (action === 'checkin' ? attendance.checkIn : attendance.checkOut) || new Date();

    res.json({
      success: true,
      message: msg.title,
      detail: msg.body(user.fullname, eventTime.toLocaleTimeString()),
      data: attendance,
      lcd:
        action === 'checkin'
          ? { line1: msg.lcdLine1, line2: user.fullname.slice(0, 16), stage2: msg.lcdStage2 }
          : { line1: msg.lcdLine1, line2: user.fullname.slice(0, 16), stage2: msg.lcdStage2 },
    });
  } catch (err) {
    // errors thrown by processScan already carry statusCode + a clean message
    if (err.statusCode) {
      const msg = getScanMessage(err.errorType);
      return res.status(err.statusCode).json({
        success: false,
        message: msg.title,
        detail: msg.body,
        lcd: { line1: msg.lcdLine1, line2: msg.lcdLine2 },
      });
    }
    next(err);
  }
};

// Adds a reliable `attendanceType` (MEMBER | VISITOR | EMPLOYEE | GUEST) to a
// row: the stored field when present, otherwise derived server-side for rows
// written before the field existed. The frontend never has to guess.
function withAttendanceType(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return { ...o, attendanceType: Attendance.resolveType(o, o.rfidCardId) };
}

exports.getLogs = async (req, res, next) => {
  try {
    const { startDate, endDate, page = 1, limit = 50 } = req.query;
    
    // Build filter
    const filter = {};
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    
    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;
    
    // Query — populate both possible owner fields; only one will ever be
    // set per document, so this is one query rather than branching per row.
    const logs = await Attendance.find(filter)
      .populate('userId', 'fullname email phone')
      .populate('coachId', 'fullname email')
      .populate('rfidCardId', 'cardType')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    // Total count
    const total = await Attendance.countDocuments(filter);
    
    res.json({
      success: true,
      data: logs.map(withAttendanceType),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.todayAttendance = async (req, res, next) => {
  try {
    const start = startOfLocalDay();
    const end = endOfLocalDay();

    const logs = await Attendance.find({
      createdAt: { $gte: start, $lte: end },
    })
      .populate('userId', 'fullname email phone')
      .populate('coachId', 'fullname email')
      .populate('rfidCardId', 'cardType')
      .sort({ checkIn: 1 }); // Sort by check-in time

    res.json({
      success: true,
      data: logs.map(withAttendanceType),
      date: formatLocalDateLabel(start),
      count: logs.length,
    });
  } catch (err) {
    next(err);
  }
};

exports.getStatus = async (req, res, next) => {
  try {
    const status = rfidService.getStatus();

    res.json({
      success: true,
      data: status,
    });
  } catch (err) {
    next(err);
  }
};

// Minimal binding-mode status for the serial bridge (device-key auth, no
// admin JWT). See the route comment in routes/rfidRoutes.js for why this
// exists separately from getStatus.
exports.getDeviceStatus = async (req, res, next) => {
  try {
    // Heartbeat: every bridge poll proves the bridge PC is alive and that
    // its device key is accepted. Surfaced to admins as `bridgeConnected`.
    rfidService.noteBridgeSeen({
      id: req.headers['x-bridge-id'] || null,
      version: req.headers['x-bridge-version'] || null,
      serial: req.headers['x-bridge-serial'] || null,
    });
    const status = rfidService.getStatus();
    res.json({
      success: true,
      data: {
        registrationMode: status.registrationMode,
        binding: status.binding,
        lastBound: rfidService.getLastBound(),
      },
    });
  } catch (err) {
    next(err);
  }
};

// Device-key connectivity probe used by scripts/rfidDiagnose.js and the
// bridge start-up self-test. Proves: DNS + TLS + Nginx + Express + device
// key + backend mode, without touching attendance or card data.
exports.ping = (req, res) => {
  const status = rfidService.getStatus();
  res.json({
    success: true,
    message: 'pong',
    serverTime: new Date().toISOString(),
    registrationMode: status.registrationMode,
    bindingMode: status.binding && status.binding.mode,
    serialConnected: status.connected,
  });
};

exports.listPorts = async (req, res, next) => {
  try {
    const ports = await rfidService.listPorts();
    res.json({ success: true, data: ports });
  } catch (err) {
    next(err);
  }
};

exports.connectPort = async (req, res, next) => {
  try {
    const { port, baudRate } = req.body;
    if (!port) {
      return res.status(400).json({ success: false, message: 'port is required' });
    }

    const status = await rfidService.connectToPort(port, baudRate);
    res.json({ success: true, message: `Connected to ${port}`, data: status });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
};

exports.disconnectPort = async (req, res, next) => {
  try {
    const status = await rfidService.disconnectPort();
    res.json({ success: true, message: 'RFID disconnected', data: status });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
};

exports.setRegistrationMode = async (req, res, next) => {
  try {
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const enabled = body.enabled;
    // Optional binding context: which flow + which pre-selected owner.
    // EditMember bind modal sends { enabled:true, mode:'bind', userId };
    // the Register page sends { enabled:true, mode:'register' } and updates
    // userId/coachId later once an owner is picked (capture-only until then).
    const mode = body.mode === 'bind' ? 'bind' : 'register';
    const userId = body.userId || null;
    const coachId = body.coachId || null;
    if (userId && coachId) {
      return res.status(400).json({ success: false, message: 'Provide userId or coachId, not both' });
    }
    rfidService.setRegistrationMode(!!enabled, {
      mode,
      userId,
      coachId,
      startedBy: req.user?._id,
    });
    res.json({ success: true, data: rfidService.getStatus().binding });
  } catch (err) {
    next(err);
  }
};

exports.getMemberRFID = async (req, res, next) => {
  try {
    const { userId } = req.params;
    
    const card = await RFIDCard.findOne({ userId }).populate('userId', 'fullname email');
    
    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'No RFID card assigned to this member',
      });
    }
    
    res.json({
      success: true,
      data: card,
    });
  } catch (err) {
    next(err);
  }
};

exports.getEmployeeRFID = async (req, res, next) => {
  try {
    const { coachId } = req.params;

    const card = await RFIDCard.findOne({ coachId }).populate('coachId', 'fullname email');

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'No RFID card assigned to this employee',
      });
    }

    res.json({
      success: true,
      data: card,
    });
  } catch (err) {
    next(err);
  }
};


exports.deactivateCard = async (req, res, next) => {
  try {
    const cardId = cardLookup.paramToRef(req.params.cardId);
    
    const card = await cardLookup.findByCardParam(cardId);
    
    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Card not found',
      });
    }
    
    card.active = false;
    await card.save();
    
    await AuditLog.create({
      action: 'rfid_deactivate',
      userId: req.user._id,
      meta: { cardId: card.cardId },
    });
    
    res.json({
      success: true,
      message: 'Card deactivated',
      data: card,
    });
  } catch (err) {
    next(err);
  }
};


exports.reassignCard = async (req, res, next) => {
  try {
    const cardId = cardLookup.paramToRef(req.params.cardId);
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required',
      });
    }
    
    const card = await cardLookup.findByCardParam(cardId);
    
    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Card not found',
      });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }
    
    const oldUserId = card.userId;
    card.userId = userId;
    card.assignedAt = new Date();
    await card.save();
    
    await AuditLog.create({
      action: 'rfid_reassign',
      userId: req.user._id,
      meta: { cardId, from: oldUserId, to: userId },
    });
    
    // Notify both members
    socketUtil.emitToUser(oldUserId, 'rfid:updated', { bound: false });
    socketUtil.emitToUser(userId, 'rfid:updated', {
      bound: true,
      cardId: card.cardId,
      active: card.active,
    });
    
    res.json({
      success: true,
      message: 'Card reassigned',
      data: card,
    });
  } catch (err) {
    next(err);
  }
};

// Unbind (fully remove) an RFID card so the old UID no longer
// authenticates anyone. DELETE /api/rfid/:cardId (admin only).
// Distinct from deactivate (which keeps the row, active=false):
// unbind deletes the RFIDCard document and verifies removal.
exports.unbindCard = async (req, res, next) => {
  try {
    const cardId = cardLookup.paramToRef(req.params.cardId);
    console.log(`[RFID] OPERATION: UNBIND — card ${logUid(cardId)}`);
    const card = await cardLookup.findByCardParam(cardId);
    if (!card) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }
    // UNBIND has its own rules: it detaches a MEMBER/EMPLOYEE card. A visitor
    // pass is not bound to anyone — it is revoked (history is kept), never deleted.
    if (card.cardType === 'TEMPORARY') {
      return res.status(400).json({ success: false, message: 'This is a visitor pass. Revoke it from the Visitor Passes page instead.' });
    }
    const ownerId = card.userId || card.coachId;
    const ref = card.cardId;
    await card.deleteOne();
    await AuditLog.create({
      action: 'rfid_unbind',
      userId: req.user._id,
      meta: { cardId: ref },
    });
    if (ownerId) socketUtil.emitToUser(ownerId, 'rfid:updated', { bound: false });
    console.log(`[RFID] Card unbound: ${ref}`);
    res.json({ success: true, message: 'Card unbound — it will no longer authenticate', data: { cardId: ref } });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Visitor / temporary passes (valid for one Manila-local day)
// ---------------------------------------------------------------------------
const MAX_PASS_DAYS_AHEAD = 30;

// Status / availability rules live in services/visitorPassService.js so the
// scan flow, this controller and the repair script all agree.
const { passStatus, presentPass, availableFilter, reconcilePass } = visitorPassService;

// POST /api/rfid/temporary
// Body: { cardId, visitorName, validDate? }   validDate = 'YYYY-MM-DD' (Manila), default today
exports.issueTemporaryCard = async (req, res, next) => {
  try {
    const rawCardId = req.body.cardId ?? req.body.uid;
    const visitorName = typeof req.body.visitorName === 'string' ? req.body.visitorName.trim() : '';
    if (!rawCardId) return res.status(400).json({ success: false, message: 'cardId is required' });
    if (!visitorName) return res.status(400).json({ success: false, message: 'Enter the visitor name' });
    if (visitorName.length > 60) return res.status(400).json({ success: false, message: 'Visitor name is too long (max 60 characters)' });

    const cardId = normalizeUid(rawCardId);
    if (!isValidUid(cardId)) {
      return res.status(400).json({ success: false, message: 'That is not a valid RFID UID' });
    }

    // Date rule (Asia/Manila, decided on the server — the browser date is
    // never trusted): today or a near-future day only. A past day makes no
    // sense for a pass that grants access.
    const now = new Date();
    let day = startOfLocalDay(now);
    if (req.body.validDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.validDate))) {
        return res.status(400).json({ success: false, message: 'validDate must be YYYY-MM-DD' });
      }
      const parsed = new Date(`${req.body.validDate}T00:00:00+08:00`);
      if (Number.isNaN(parsed.getTime()) || formatLocalDateLabel(parsed) !== req.body.validDate) {
        return res.status(400).json({ success: false, message: 'That is not a valid date' });
      }
      day = startOfLocalDay(parsed);
    }
    if (day < startOfLocalDay(now)) {
      return res.status(400).json({ success: false, message: 'This date has already passed. Please select a current or future date.' });
    }
    if (day.getTime() - startOfLocalDay(now).getTime() > MAX_PASS_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, message: `A visitor pass can be issued at most ${MAX_PASS_DAYS_AHEAD} days ahead` });
    }
    const validFrom = day;
    const validUntil = endOfLocalDay(day);

    const existing = await cardLookup.findByUid(cardId);
    let card;
    if (existing) {
      // A member/employee card can never be converted into a visitor pass.
      if (existing.cardType !== 'TEMPORARY') {
        return res.status(409).json({ success: false, message: 'This card is registered to a member/employee and cannot be used as a visitor pass' });
      }
      // Visitor hardware is reused. A card is released for the next visitor
      // when the previous visit is CHECKED OUT (or revoked / past its day) —
      // never while it is still PENDING / UPCOMING / ACTIVE.
      if (existing.memberAssignmentId) {
        return res.status(409).json({ success: false, message: 'This card is currently lent to a member as a temporary card. Return it first.' });
      }
      await reconcilePass(existing); // heal a checkout whose card write was lost
      if (!visitorPassService.isCardAvailable(existing, now)) {
        const st = passStatus(existing, now);
        return res.status(409).json({
          success: false,
          message: st === 'ACTIVE'
            ? `This card is currently in use by ${existing.visitorName} (checked in). It becomes available after they check out.`
            : `This card is currently assigned to ${existing.visitorName} (valid ${formatLocalDateLabel(existing.validFrom)}). Revoke it first or wait until the visit is checked out.`,
        });
      }
      // Atomic claim: the filter re-checks availability inside the write, so
      // two admins assigning the same card at the same moment cannot both win.
      card = await RFIDCard.findOneAndUpdate(
        { _id: existing._id, ...availableFilter(now) },
        {
          $set: {
            visitorName, validFrom, validUntil, active: true,
            assignedAt: now, issuedBy: req.user._id,
          },
          $unset: { lastScannedAt: 1, checkedInAt: 1, checkedOutAt: 1 },
        },
        { new: true },
      );
      if (!card) {
        return res.status(409).json({ success: false, message: 'This card was just assigned to another visitor. Choose a different card.' });
      }
    } else {
      card = await RFIDCard.create({
        ...identityFor(cardId),
        cardType: 'TEMPORARY',
        visitorName,
        validFrom,
        validUntil,
        active: true,
        assignedAt: now,
        issuedBy: req.user._id,
      });
    }

    await AuditLog.create({
      action: 'rfid_visitor_pass_issued',
      userId: req.user._id,
      meta: { cardId: card.cardId, visitorName, validDate: formatLocalDateLabel(validFrom), reissued: !!existing },
    }).catch(() => {});
    console.log(`[RFID] Visitor pass issued — ${card.cardId} → "${visitorName}" valid ${formatLocalDateLabel(validFrom)} (Asia/Manila)`);

    res.status(201).json({ success: true, message: 'Visitor pass issued', data: presentPass(card, now) });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: 'This card was just registered. Please try again.' });
    }
    next(err);
  }
};

// GET /api/rfid/temporary?status=PENDING|ACTIVE|CHECKED_OUT|EXPIRED|REVOKED|UPCOMING&available=true&limit=50
exports.listTemporaryCards = async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    // Visitor passes only. Member loans and blank spare cards are listed by
    // the temporary-card inventory (GET /rfid/temporary/inventory).
    const cards = await RFIDCard.find({ cardType: 'TEMPORARY', memberAssignmentId: null, visitorName: { $ne: null } })
      .sort({ validFrom: -1, createdAt: -1 }).limit(limit);
    for (const c of cards) await reconcilePass(c);
    const now = new Date();
    let data = cards.map((c) => presentPass(c, now));
    const wanted = String(req.query.status || '').toUpperCase();
    if (['PENDING', 'ACTIVE', 'CHECKED_OUT', 'EXPIRED', 'REVOKED', 'UPCOMING'].includes(wanted)) {
      data = data.filter((c) => c.status === wanted);
    } else if (String(req.query.available || '') === 'true') {
      data = data.filter((c) => c.cardAvailable);
    }
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/rfid/temporary/:id/revoke
exports.revokeTemporaryCard = async (req, res, next) => {
  try {
    const card = await RFIDCard.findById(req.params.id);
    if (!card || card.cardType !== 'TEMPORARY') {
      return res.status(404).json({ success: false, message: 'Visitor pass not found' });
    }
    if (card.memberAssignmentId) {
      return res.status(409).json({ success: false, message: 'This card is lent to a member. Use the temporary-card return/revoke action instead.' });
    }
    if (!card.active) {
      return res.status(409).json({ success: false, message: 'This visitor pass is already revoked' });
    }
    card.active = false;
    await card.save();
    await AuditLog.create({
      action: 'rfid_visitor_pass_revoked',
      userId: req.user._id,
      meta: { cardId: card.cardId, visitorName: card.visitorName },
    }).catch(() => {});
    res.json({ success: true, message: 'Visitor pass revoked', data: presentPass(card) });
  } catch (err) {
    next(err);
  }
};