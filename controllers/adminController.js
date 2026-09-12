const User = require('../models/User');
const { validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');
const StudentVerification = require('../models/studentVerification');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Notification = require('../models/Notification');
const socketUtil = require('../utils/socket');
const subscriptionService = require('../services/subscriptionService');
const adminService = require('../services/adminService');
const emailService = require('../services/emailService');
const escapeRegex = require('../utils/escapeRegex');
const { parsePagination } = require('../utils/paginate');
const generateReceiptNumber = require('../utils/generateReceiptNumber');
const ExcelJS = require('exceljs');
const { buildMedicalDocumentResponse } = require('./userController');

const getUsers = async (req, res) => {
  try {
    const getAllUsers = await User.find().select('-password');

    if (getAllUsers.length === 0) {
      return res.sendStatus(204);
    }
    res.status(200).json({
      message: 'This is all users',
      content: getAllUsers,
    });
  } catch (err) {
    res.status(400).json({
      content: err.message,
    });
  }
};

// ---- Members (MemberAccount.vue / EditMember.vue) ----

// One subscription lookup shared by getMembers/getMember so "Active" means
// the same thing in both the list and the detail view: a subscription
// that's marked active AND hasn't passed its end date yet.
const deriveStatus = (subscription) => {
  if (!subscription) return 'Inactive';
  const isCurrentlyActive = subscription.status === 'active' && subscription.endDate >= new Date();
  return isCurrentlyActive ? 'Active' : 'Inactive';
};

const getMembers = async (req, res, next) => {
  try {
    const { page, limit, skip, isExport } = parsePagination(req.query);
    const { search } = req.query;

    const filter = { role: 'user' };
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ fullname: re }, { email: re }];
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit);
    const userIds = users.map((u) => u._id);

    // Most recent subscription per user, newest endDate first, so the
    // first match per user in this sorted list is the one we want.
    const subscriptions = await Subscription.find({ userId: { $in: userIds } })
      .populate('planId', 'name')
      .sort({ endDate: -1 });

    const latestSubByUser = new Map();
    for (const sub of subscriptions) {
      const key = sub.userId.toString();
      if (!latestSubByUser.has(key)) latestSubByUser.set(key, sub);
    }

    const members = users.map((u) => {
      const sub = latestSubByUser.get(u._id.toString());
      return {
        _id: u._id,
        name: u.fullname,
        email: u.email,
        mobile: u.phone,
        address: u.address,
        plan: sub?.planId?.name || null,
        // Section C3: spec's export requires Subscription Start/Expiration
        // Date as separate columns from "Date Joined" (account creation) —
        // already fetched above for deriveStatus, just wasn't surfaced here.
        subscriptionStart: sub?.startDate || null,
        subscriptionExpiration: sub?.endDate || null,
        status: deriveStatus(sub),
        accountActive: u.isActive,
        studentPromoActive: u.studentPromoActive,
        joined: u.createdAt,
      };
    });

    res.json({
      success: true,
      data: members,
      page,
      limit,
      total,
      totalPages: isExport ? 1 : Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

const getMember = async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'user' }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    const [subscription, rfidCard, studentVerification] = await Promise.all([
      Subscription.findOne({ userId: user._id }).sort({ endDate: -1 }).populate('planId', 'name'),
      RFIDCard.findOne({ userId: user._id }),
      StudentVerification.findOne({ userId: user._id }).sort({ createdAt: -1 }),
    ]);

    res.json({
      success: true,
      data: {
        _id: user._id,
        name: user.fullname,
        email: user.email,
        mobile: user.phone,
        address: user.address,
        joined: user.createdAt,
        plan: subscription?.planId?.name || null,
        status: deriveStatus(subscription),
        accountActive: user.isActive,
        studentPromoActive: user.studentPromoActive,
        rfidCardId: rfidCard ? rfidCard.cardId : null,
        studentVerification: studentVerification || null,
        facebookUrl: user.facebookUrl || '',
        instagramUrl: user.instagramUrl || '',
        // Medical fields — deliberately only here (single-member detail,
        // already admin-only via adminRoutes.js's protect+admin), never
        // in getMembers' list response above. An admin/authorized staff
        // member opening one member's record is the "authorized
        // personnel, for program customization" case Section H allows;
        // seeing it embedded in a scrollable list of everyone would not be.
        medicalConditions: user.medicalConditions || '',
        medicalAllergies: user.medicalAllergies || '',
        emergencyContactName: user.emergencyContactName || '',
        emergencyContactPhone: user.emergencyContactPhone || '',
        medicalNotes: user.medicalNotes || '',
        medicalConsentGiven: user.medicalConsentGiven || false,
        // Metadata only — same contract MedicalDocumentCard.vue already
        // expects from the self-service profile endpoint. The signed,
        // actually-openable URL for any one of these is minted on demand
        // by GET /admin/members/:id/medical-document/:docId below, not
        // embedded here, so this response stays cheap even if nobody
        // clicks View. A member can have several on file (uploads are
        // additive) — see the medicalDocuments comment in User.js.
        medicalDocuments: (user.medicalDocuments || [])
          .filter((doc) => doc.public_id)
          .map((doc) => ({
            _id: doc._id,
            fileName: doc.fileName,
            fileType: doc.fileType,
            fileSize: doc.fileSize,
            uploadedAt: doc.uploadedAt,
          })),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Admin-only counterpart to userController.viewMedicalDocument — same
// "mint a fresh signed URL, never persist/hand out a raw one" approach
// (see buildMedicalDocumentResponse there), just scoped to the member
// in the URL param instead of the requester's own account. This route
// sits behind adminRoutes.js's blanket protect+admin, so reaching this
// function at all already proves the requester is an authenticated
// admin — the "authorized personnel, for program customization" case
// the medicalDocuments field's comment in User.js anticipates. Scoped
// to one document by :docId now that a member can have several on file.
const getMemberMedicalDocument = async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'user' }).select('medicalDocuments');
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    const document = user.medicalDocuments?.id(req.params.docId);
    const result = buildMedicalDocumentResponse(document);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Document not found for this member.' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const updateMember = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const user = await User.findOne({ _id: req.params.id, role: 'user' });
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    const { fullname, phone, address, email,
      medicalConditions, medicalAllergies, emergencyContactName, emergencyContactPhone, medicalNotes } = req.body;
    if (fullname) user.fullname = fullname;
    if (phone) user.phone = phone;
    if (address) user.address = address;

    // Medical fields: an admin/authorized staff member can update these
    // once the member has already given consent (via their own profile —
    // see userController.updateProfile), but consent itself is never
    // something an admin can grant on the member's behalf. If no consent
    // is on file yet, medical fields in this request are silently
    // ignored rather than erroring the whole save — an admin editing
    // someone's phone number shouldn't be blocked by an unrelated
    // missing consent checkbox.
    const medicalFieldsTouched = [medicalConditions, medicalAllergies, emergencyContactName, emergencyContactPhone, medicalNotes]
      .some((v) => v !== undefined);
    if (medicalFieldsTouched && user.medicalConsentGiven) {
      if (medicalConditions !== undefined) user.medicalConditions = medicalConditions;
      if (medicalAllergies !== undefined) user.medicalAllergies = medicalAllergies;
      if (emergencyContactName !== undefined) user.emergencyContactName = emergencyContactName;
      if (emergencyContactPhone !== undefined) user.emergencyContactPhone = emergencyContactPhone;
      if (medicalNotes !== undefined) user.medicalNotes = medicalNotes;
    }

    if (email && email.toLowerCase() !== user.email) {
      const existing = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email is already in use by another account' });
      }
      user.email = email.toLowerCase();
    }

    await user.save();
    socketUtil.emitToAdmins('member:updated', { _id: user._id });
    res.json({ success: true, message: 'Member updated', data: user });
  } catch (error) {
    next(error);
  }
};

// Separate from updateMember on purpose — this toggles login access
// (isActive), a distinct concept from the subscription-derived status
// shown in the member list. See User.js for the field's comment.
const setMemberStatus = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { isActive } = req.body;
    const user = await User.findOne({ _id: req.params.id, role: 'user' });
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    user.isActive = !!isActive;
    await user.save();
    socketUtil.emitToAdmins('member:updated', { _id: user._id });
    res.json({
      success: true,
      message: user.isActive ? 'Account activated' : 'Account deactivated — this member can no longer log in',
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

const deleteMember = async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'user' });
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    // Related records (payments, subscriptions, attendance, RFID card)
    // are intentionally left in place for historical/audit purposes —
    // only the account itself is removed.
    await User.findByIdAndDelete(req.params.id);
    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('member:deleted', { _id: req.params.id });
    res.json({ success: true, message: 'Member deleted' });
  } catch (error) {
    next(error);
  }
};

// Admin-initiated signup — e.g. a walk-in registering at the front desk
// without going through the public /signup flow. Skips email verification
// since the admin is looking at a real person; still checks for a
// duplicate email the same way updateMember does.
const createMember = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { fullname, email, password, phone, address } = req.body;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A member with this email already exists' });
    }

    const user = await User.create({
      fullname,
      email: email.toLowerCase(),
      password,
      phone,
      address,
      role: 'user',
      isVerified: true,
    });

    if (emailService.sendWelcomeEmail) {
      emailService.sendWelcomeEmail(user).catch((err) =>
        console.error('Failed to send welcome email:', err.message)
      );
    }

    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('member:updated', { _id: user._id });

    const safeUser = user.toObject();
    delete safeUser.password;

    res.status(201).json({ success: true, message: 'Member created', data: safeUser });
  } catch (error) {
    next(error);
  }
};

// approveStudentId can turn studentPromoActive on, but there was
// previously no way to turn it back off — e.g. a member's eligibility
// lapses, or an ID was approved in error. This is the missing other half
// of that toggle. Deliberately doesn't touch the original
// StudentVerification submission's status — that record stays an
// immutable log of what was reviewed and when; this only affects whether
// the discount is currently in effect.
const setStudentPromoActive = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { studentPromoActive } = req.body;
    const user = await User.findOne({ _id: req.params.id, role: 'user' });
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    user.studentPromoActive = !!studentPromoActive;
    await user.save();
    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('member:updated', { _id: user._id });
    res.json({
      success: true,
      message: user.studentPromoActive ? 'Student discount activated' : 'Student discount revoked',
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

// ---- Notifications (admin bell) ----

const getNotifications = async (req, res, next) => {
  try {
    const notifications = await Notification.find().sort({ createdAt: -1 }).limit(30);
    const unreadCount = await Notification.countDocuments({ read: false });
    res.json({ success: true, data: notifications, unreadCount });
  } catch (error) {
    next(error);
  }
};

const markNotificationRead = async (req, res, next) => {
  try {
    const notification = await Notification.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
    if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });
    socketUtil.emitToAdmins('notification:read', { _id: notification._id });
    res.json({ success: true, data: notification });
  } catch (error) {
    next(error);
  }
};

const markAllNotificationsRead = async (req, res, next) => {
  try {
    await Notification.updateMany({ read: false }, { read: true });
    socketUtil.emitToAdmins('notification:all-read', {});
    res.json({ success: true, message: 'All notifications marked read' });
  } catch (error) {
    next(error);
  }
};

const getPayments = async (req, res, next) => {
  try {
    const { page, limit, skip, isExport } = parsePagination(req.query);
    const { search, method, status } = req.query;

    const filter = {};
    if (method && method !== 'All') filter.paymentMethod = method;
    if (status && status !== 'All') filter.status = status;
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      // referenceNumber lives on Payment itself; name lives on the
      // referenced User, which Mongo can't match directly in one query —
      // so look up matching user ids first, then match either field.
      const matchingUsers = await User.find({ fullname: re }).select('_id');
      filter.$or = [
        { referenceNumber: re },
        { transactionNumber: re },
        { userId: { $in: matchingUsers.map((u) => u._id) } },
      ];
    }

    const total = await Payment.countDocuments(filter);
    const payments = await Payment.find(filter)
      .populate('userId', 'fullname email phone')
      .populate('planId', 'name duration')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: payments,
      page,
      limit,
      total,
      totalPages: isExport ? 1 : Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

// C2 — Payment History Excel Export. Mirrors getPayments' own
// search/method/status filtering exactly, so the export always matches
// what the admin is currently looking at, plus a required date range.
// Cash ("Walk-in") rows never have an external reference — the
// system-generated transactionNumber is the receipt of record for
// those; GCash keeps its member-provided referenceNumber.
const exportPaymentsXLSX = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { startDate, endDate, search, method, status } = req.query;

    // Spec: "Start date cannot be later than end date."
    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ success: false, message: 'Start date cannot be later than end date.' });
    }

    const filter = {
      createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
    };
    if (method && method !== 'All') filter.paymentMethod = method;
    if (status && status !== 'All') filter.status = status;
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      const matchingUsers = await User.find({ fullname: re }).select('_id');
      filter.$or = [
        { referenceNumber: re },
        { transactionNumber: re },
        { userId: { $in: matchingUsers.map((u) => u._id) } },
      ];
    }

    const payments = await Payment.find(filter)
      .populate('userId', 'fullname email')
      .populate('planId', 'name')
      .sort({ createdAt: 1 });

    // Spec: "Handle empty date ranges gracefully. Display an appropriate
    // message if no records exist." A 200 with an empty XLSX attachment
    // gives the browser a file to save with no indication anything was
    // wrong — this returns a normal JSON error instead, which the
    // frontend can show as a message rather than downloading a blank file.
    if (payments.length === 0) {
      return res.status(404).json({ success: false, message: 'No payment records found for the selected range and filters.' });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Payments');

    sheet.columns = [
      { header: 'Payment ID', key: 'paymentId', width: 26 },
      { header: 'Member ID', key: 'memberId', width: 26 },
      { header: 'Member Name', key: 'memberName', width: 24 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Payment Date', key: 'paymentDate', width: 22 },
      { header: 'Payment Method', key: 'paymentMethod', width: 16 },
      { header: 'Membership Plan', key: 'plan', width: 20 },
      { header: 'Approval Status', key: 'status', width: 16 },
      { header: 'Receipt / Transaction Number', key: 'receiptNumber', width: 28 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const p of payments) {
      const receiptNumber = p.paymentMethod === 'Walk-in'
        ? (p.transactionNumber || '—')
        : (p.referenceNumber || p.transactionNumber || '—');

      sheet.addRow({
        paymentId: p._id.toString(),
        memberId: p.userId?._id?.toString() || '',
        memberName: p.userId?.fullname || '',
        amount: p.amount,
        paymentDate: p.createdAt.toISOString(),
        paymentMethod: p.paymentMethod,
        plan: p.planId?.name || '—',
        status: p.status,
        receiptNumber,
      });
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="payment-history-${startDate}-to-${endDate}.xlsx"`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

const approvePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (payment.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Payment already ${payment.status}` });
    }

    payment.status = 'approved';
    await payment.save();
    await emailService.sendPaymentStatusEmail(await User.findById(payment.userId), payment);

    let subscription = null;
    let subscriptionError = null;
    if (payment.planId) {
      try {
        subscription = await subscriptionService.createSubscription({
          userId: payment.userId,
          planId: payment.planId,
          paymentId: payment._id,
        });
      } catch (subErr) {

        subscriptionError = subErr.message;
      }
    }

    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('payment:updated', payment);
    socketUtil.emitToUser(payment.userId, 'payment:updated', payment);
    socketUtil.emitToAdmins('member:updated', { _id: payment.userId });

    res.json({
      success: true,
      message: subscription ? 'Payment approved and membership activated' : 'Payment approved',
      data: payment,
      subscription,
      subscriptionError,
    });
  } catch (error) {
    next(error);
  }
};

const rejectPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (payment.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Payment already ${payment.status}` });
    }

    payment.status = 'rejected';
    await payment.save();
    await emailService.sendPaymentStatusEmail(await User.findById(payment.userId), payment);
    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('payment:updated', payment);
    socketUtil.emitToUser(payment.userId, 'payment:updated', payment);

    res.json({ success: true, message: 'Payment rejected', data: payment });
  } catch (error) {
    next(error);
  }
};

const createManualPayment = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { userId, amount, planId, paymentMethod, referenceNumber } = req.body;

    const user = await User.findOne({ _id: userId, role: 'user' });
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    const plan = await MembershipPlan.findById(planId);
    if (!plan) return res.status(404).json({ success: false, message: 'Membership plan not found' });

    const payment = await Payment.create({
      userId,
      planId,
      referenceNumber: referenceNumber || undefined,
      transactionNumber: generateReceiptNumber(),
      paymentMethod: paymentMethod || 'Walk-in',
      amount,
      status: 'approved',
    });
    await payment.populate('planId', 'name duration');

    let subscriptionError = null;
    try {
      subscription = await subscriptionService.createSubscription({
        userId: payment.userId,
        planId: payment.planId,
        paymentId: payment._id,
      });
    } catch (subErr) {
      subscriptionError = subErr.message;
    }

    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('payment:updated', payment);
    socketUtil.emitToUser(payment.userId, 'payment:updated', payment);
    // Membership status/plan on the member list & detail page is derived
    // from the subscription this may have just created/extended.
    socketUtil.emitToAdmins('member:updated', { _id: payment.userId });

    res.status(201).json({
      success: true,
      message: subscription ? 'Payment recorded and membership updated' : 'Payment recorded',
      data: payment,
      subscription,
      subscriptionError,
    });
  } catch (error) {
    next(error);
  }
};

const getSubscriptions = async (req, res, next) => {
  try {
    const subscriptions = await Subscription.find().populate('planId').populate('userId', 'fullname email');
    res.json({ success: true, data: subscriptions });
  } catch (error) {
    next(error);
  }
};
const createManualAttendance = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { userId, guestName, memberType, notes } = req.body;

    // Exactly one of userId / guestName: an existing member picked by
    // search, or a free-text name for someone with no account. The route
    // validation allows either to be absent individually, so this is the
    // one place enforcing that precisely one of them is actually set.
    if (!userId && !guestName) {
      return res.status(400).json({ success: false, message: 'Select a member or enter a name' });
    }
    if (userId && guestName) {
      return res.status(400).json({ success: false, message: 'Provide either a member or a guest name, not both' });
    }

    let user = null;
    if (userId) {
      user = await User.findOne({ _id: userId, role: 'user' });
      if (!user) return res.status(404).json({ success: false, message: 'Member not found' });
    }

    const attendance = await Attendance.create({
      userId: userId || undefined,
      guestName: userId ? undefined : guestName.trim(),
      memberType: memberType === 'Student' ? 'Student' : 'Regular',
      checkIn: new Date(),
      notes: notes || 'Manually recorded by admin',
    });
    await attendance.populate('userId', 'fullname email phone');

    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('attendance', {
      type: 'checkin',
      user: { fullname: user ? user.fullname : attendance.guestName },
      data: attendance,
    });

    res.status(201).json({ success: true, message: 'Attendance recorded', data: attendance });
  } catch (error) {
    next(error);
  }
};

const createPlan = async (req, res, next) => {
  try {
    const plan = await MembershipPlan.create(req.body);
    res.status(201).json({ success: true, message: 'Plan created', data: plan });
  } catch (error) {
    next(error);
  }
};

const updatePlan = async (req, res, next) => {
  try {
    const plan = await MembershipPlan.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: 'Plan updated', data: plan });
  } catch (error) {
    next(error);
  }
};

const deletePlan = async (req, res, next) => {
  try {
    const plan = await MembershipPlan.findByIdAndDelete(req.params.id);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: 'Plan deleted' });
  } catch (error) {
    next(error);
  }
};

const getStudentIdSubmissions = async (req, res, next) => {
  try {
    const { status, userId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (userId) filter.userId = userId;
    const submissions = await StudentVerification.find(filter)
      .populate('userId', 'fullname email')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: submissions });
  } catch (error) {
    next(error);
  }
};

const approveStudentId = async (req, res, next) => {
  try {
    const submission = await StudentVerification.findById(req.params.id);
    if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Submission already ${submission.status}` });
    }

    submission.status = 'approved';
    submission.reviewedBy = req.user._id;
    await submission.save();

    const user = await User.findByIdAndUpdate(submission.userId, { studentPromoActive: true }, { new: true });
    if (user) {
      await emailService.sendStudentVerificationEmail(user, true);
      const safeUser = user.toObject();
      delete safeUser.password;
      socketUtil.emitToUser(submission.userId, 'user:profile-updated', safeUser);
    }
    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('member:updated', { _id: submission.userId });

    res.json({ success: true, message: 'Student ID approved, promo activated', data: submission });
  } catch (error) {
    next(error);
  }
};

const rejectStudentId = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const submission = await StudentVerification.findById(req.params.id);
    if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Submission already ${submission.status}` });
    }

    submission.status = 'rejected';
    submission.reviewedBy = req.user._id;
    submission.reviewNote = reason;
    await submission.save();

    const user = await User.findById(submission.userId);
    if (user) await emailService.sendStudentVerificationEmail(user, false, reason);
    socketUtil.emitToAdmins('member:updated', { _id: submission.userId });

    res.json({ success: true, message: 'Student ID rejected', data: submission });
  } catch (error) {
    next(error);
  }
};

// ---- Admin Settings: password-change OTP ----
// req.user._id is the admin's own id here — protect+admin (applied to
// this whole router in adminRoutes.js) guarantees that.

const sendPasswordChangeOtp = async (req, res, next) => {
  try {
    const result = await adminService.requestPasswordChangeOtp(req.user._id);
    res.json({ success: true, message: `Verification code sent to ${result.sentTo}`, data: result });
  } catch (error) {
    next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { currentPassword, newPassword, otp } = req.body;
    await adminService.verifyAndChangePassword({
      adminId: req.user._id,
      currentPassword,
      newPassword,
      otp,
    });

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  getMembers,
  getMember,
  getMemberMedicalDocument,
  createMember,
  updateMember,
  setMemberStatus,
  setStudentPromoActive,
  deleteMember,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getPayments,
  exportPaymentsXLSX,
  createManualPayment,
  approvePayment,
  rejectPayment,
  getSubscriptions,
  createPlan,
  updatePlan,
  deletePlan,
  getStudentIdSubmissions,
  approveStudentId,
  rejectStudentId,
  createManualAttendance,
  sendPasswordChangeOtp,
  changePassword,
};