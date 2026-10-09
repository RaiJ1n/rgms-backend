// Temporary RFID cards for members who forgot their card, plus the combined
// spare-card inventory. All routes sit behind protect + admin (see
// routes/rfidRoutes.js); every rule below is enforced here / in
// tempCardService, never left to the frontend.
const tempCards = require('../services/tempCardService');

// Service errors carry .status; anything else is unexpected and goes to the
// shared error handler.
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err && err.status && err.status < 500) {
      return res.status(err.status).json({ success: false, message: err.message, errorType: err.errorType });
    }
    return next(err);
  }
};

// GET /api/rfid/temporary/members?search=
exports.searchMembers = handle(async (req, res) => {
  const data = await tempCards.searchMembers(req.query.search);
  res.json({ success: true, data });
});

// POST /api/rfid/temporary/member-assignments
// Body: { memberId, tempCardUid, originalCardUid?, originalNotPresent? }
exports.issueToMember = handle(async (req, res) => {
  const b = req.body || {};
  const data = await tempCards.issueToMember({
    memberId: b.memberId,
    tempUid: b.tempCardUid,
    originalUid: b.originalCardUid,
    originalNotPresent: b.originalNotPresent,
    adminId: req.user._id,
  });
  res.status(201).json({ success: true, message: 'Temporary card issued', data });
});

// POST /api/rfid/temporary/return   Body: { id } or { uid }
exports.returnCard = handle(async (req, res) => {
  const b = req.body || {};
  if (b.id === undefined && b.uid === undefined) {
    return res.status(400).json({ success: false, message: 'id or uid is required' });
  }
  const data = await tempCards.returnCard({ id: b.id, uid: b.uid, adminId: req.user._id });
  res.json({ success: true, message: data.alreadyAvailable ? 'Card is already available' : 'Temporary card returned', data });
});

// POST /api/rfid/temporary/member-assignments/:id/revoke   Body: { reason }
exports.revokeAssignment = handle(async (req, res) => {
  const data = await tempCards.revokeAssignment({
    assignmentId: req.params.id,
    reason: (req.body || {}).reason,
    adminId: req.user._id,
  });
  res.json({ success: true, message: 'Temporary card revoked', data });
});

// GET /api/rfid/temporary/inventory?state=&limit=
exports.inventory = handle(async (req, res) => {
  const data = await tempCards.listInventory({
    state: req.query.state,
    limit: parseInt(req.query.limit, 10) || 100,
  });
  res.json({ success: true, data });
});
