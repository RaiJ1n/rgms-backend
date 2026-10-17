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
const mongoose = require('mongoose');
const paymentQuery = require('../services/paymentQueryService');
const { parseRange } = require('../utils/dateRange');
const { formatLocalDateLabel, startOfLocalDay } = require('../utils/localDate');
const attendanceService = require('../services/attendanceService');
const memberAttendance = require('../services/memberAttendanceService');
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

// Members (MemberAccount.vue / EditMember.vue)

// One subscription lookup shared by getMembers/getMember
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

    const subscriptions = await Subscription.find({ userId: { $in: userIds } })
      .populate('planId', 'name')
      .sort({ endDate: -1 });

    const latestSubByUser = new Map();
    for (const sub of subscriptions) {
      const key = sub.userId.toString();
      if (!latestSubByUser.has(key)) latestSubByUser.set(key, sub);
    }

    const rowsByUser = new Map();
    for (const sub of subscriptions) {
      const key = sub.userId.toString();
      if (!rowsByUser.has(key)) rowsByUser.set(key, []);
      rowsByUser.get(key).push(sub);
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
        // spec's export requires Subscription Start/Expiration Date as separate columns from "Date Joined"
        subscriptionStart: (sub && subscriptionService.getCoverageWindow(rowsByUser.get(u._id.toString()))?.startDate) || sub?.startDate || null,
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
        // Medical fields
        medicalConditions: user.medicalConditions || '',
        medicalAllergies: user.medicalAllergies || '',
        emergencyContactName: user.emergencyContactName || '',
        emergencyContactPhone: user.emergencyContactPhone || '',
        medicalNotes: user.medicalNotes || '',
        medicalConsentGiven: user.medicalConsentGiven || false,
        // Metadata only
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

// Admin-only counterpart to userController.viewMedicalDocument — same "mint a fresh signed URL
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

// Separate from updateMember on purpose — this toggles login access (isActive)
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

    // Related records
    await User.findByIdAndDelete(req.params.id);
    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('member:deleted', { _id: req.params.id });
    res.json({ success: true, message: 'Member deleted' });
  } catch (error) {
    next(error);
  }
};

// Admin-initiated signup
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

// approveStudentId can turn studentPromoActive on, but there was previously no way to turn it back off
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

// Notifications (admin bell)

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

// Payment History list
const getPayments = async (req, res, next) => {
  try {
    const { page, limit, skip, isExport } = parsePagination(req.query);
    const result = await paymentQuery.listPayments(req.query, { page, limit, skip });
    if (result.error) return res.status(400).json({ success: false, message: result.error });

    res.json({
      success: true,
      data: result.data,
      page,
      limit,
      total: result.total,
      totalPages: isExport ? 1 : Math.ceil(result.total / limit),
      sortBy: result.sort.key,
      order: result.sort.order === 1 ? 'asc' : 'desc',
    });
  } catch (error) {
    next(error);
  }
};

// Summary/report for the SAME filters as the list (backend is the only place totals are computed)
const getPaymentSummary = async (req, res, next) => {
  try {
    const built = await paymentQuery.buildFilter(req.query);
    if (built.error) return res.status(400).json({ success: false, message: built.error });
    const summary = await paymentQuery.summarize(built.filter);
    res.json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};

// Payment History Excel export
const EXPORT_MAX_ROWS = 5000;
const exportPaymentsXLSX = async (req, res, next) => {
  try {
    const built = await paymentQuery.buildFilter(req.query);
    if (built.error) return res.status(400).json({ success: false, message: built.error });
    const sort = paymentQuery.parseSort(req.query);

    const payments = await Payment.aggregate(paymentQuery.listPipeline(built.filter, sort, 0, EXPORT_MAX_ROWS));

    if (payments.length === 0) {
      return res.status(404).json({ success: false, message: 'No payment records found for the selected range and filters.' });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Payments');
    sheet.columns = [
      { header: 'Transaction Number', key: 'transactionNumber', width: 24 },
      { header: 'Date (Asia/Manila)', key: 'date', width: 20 },
      { header: 'Customer', key: 'customer', width: 26 },
      { header: 'Customer Type', key: 'customerType', width: 15 },
      { header: 'Membership / Package', key: 'plan', width: 20 },
      { header: 'Payment Method', key: 'paymentMethod', width: 16 },
      { header: 'Reference Number', key: 'referenceNumber', width: 24 },
      { header: 'Amount', key: 'amount', width: 14, style: { numFmt: '#,##0.00' } },
      { header: 'Payment Status', key: 'status', width: 16 },
      { header: 'Payment ID', key: 'paymentId', width: 26 },
      { header: 'Member ID', key: 'memberId', width: 26 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const manilaStamp = (d) => {
      const shifted = new Date(new Date(d).getTime() + 8 * 60 * 60 * 1000);
      return shifted.toISOString().slice(0, 16).replace('T', ' ');
    };

    for (const p of payments) {
      sheet.addRow({
        transactionNumber: p.transactionNumber || '—',
        date: manilaStamp(p.createdAt),
        customer: p.customerName || p.userId?.fullname || '',
        customerType: p.customerType === 'WALK_IN' ? 'Walk-in (non-member)' : 'Member',
        plan: p.planId?.name || '—',
        paymentMethod: p.paymentMethod,
        // Cash has no external reference — the transaction number is its receipt
        referenceNumber: p.referenceNumber || '',
        amount: p.amount,
        status: p.status,
        paymentId: p._id.toString(),
        memberId: p.userId?._id?.toString() || '',
      });
    }

    const summary = await paymentQuery.summarize(built.filter);
    const sum = workbook.addWorksheet('Summary');
    sum.columns = [{ width: 34 }, { width: 18 }, { width: 18 }];
    const addPair = (label, value, fmt) => {
      const row = sum.addRow([label, value]);
      if (fmt) row.getCell(2).numFmt = fmt;
      return row;
    };
    const filterBits = [];
    if (req.query.startDate || req.query.endDate) filterBits.push(`${req.query.startDate || '…'} to ${req.query.endDate || '…'}`);
    for (const k of ['method', 'status', 'customerType', 'search']) if (typeof req.query[k] === 'string' && req.query[k] && req.query[k] !== 'All') filterBits.push(`${k}: ${req.query[k]}`);
    sum.addRow(['Payment History Summary']).font = { bold: true, size: 14 };
    sum.addRow(['Filters', filterBits.join(' | ') || 'None']);
    sum.addRow([]);
    addPair('Total transactions', summary.totalTransactions);
    addPair('Total revenue (approved)', summary.totalRevenue, '#,##0.00');
    addPair('Total cash (approved)', summary.totalCash, '#,##0.00');
    addPair('Total GCash (approved)', summary.totalGcash, '#,##0.00');
    if (summary.totalOtherMethods) addPair('Other methods (approved)', summary.totalOtherMethods, '#,##0.00');
    addPair('Pending (count)', summary.byStatus.pending.count);
    addPair('Rejected (count)', summary.byStatus.rejected.count);
    sum.addRow([]);
    const head = sum.addRow(['Package', 'Transactions', 'Revenue (approved)']);
    head.font = { bold: true };
    for (const p of summary.byPackage) {
      const row = sum.addRow([p.name, p.transactions, p.revenue]);
      row.getCell(3).numFmt = '#,##0.00';
    }
    sum.addRow([]);
    sum.addRow(['Members — revenue', summary.byCustomerType.MEMBER.revenue]).getCell(2).numFmt = '#,##0.00';
    sum.addRow(['Walk-in (non-member) — revenue', summary.byCustomerType.WALK_IN.revenue]).getCell(2).numFmt = '#,##0.00';

    const tag = (req.query.startDate && req.query.endDate) ? `${req.query.startDate}-to-${req.query.endDate}` : formatLocalDateLabel(new Date());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payment-history-${String(tag).replace(/[^0-9A-Za-z-]/g, '')}.xlsx"`);
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

// Records a payment taken at the front desk
const createManualPayment = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { userId, amount, planId, paymentMethod, referenceNumber } = req.body;
    const isWalkIn = req.body.customerType === 'WALK_IN';

    const plan = await MembershipPlan.findById(planId);
    if (!plan) return res.status(404).json({ success: false, message: 'Membership plan not found' });

    let payment;
    if (isWalkIn) {
      const customerName = typeof req.body.customerName === 'string' ? req.body.customerName.trim() : '';
      if (customerName.length < 2 || customerName.length > 60) {
        return res.status(400).json({ success: false, message: 'Enter the customer name (2–60 characters).' });
      }
      if (!subscriptionService.isDayPassPlan(plan)) {
        return res.status(400).json({
          success: false,
          message: 'Walk-in (non-member) customers can only buy a 1-day pass. Create a member account for longer memberships.',
        });
      }
      // Cashier double-click guard
      const dup = await Payment.findOne({
        customerType: 'WALK_IN',
        customerName: new RegExp(`^${escapeRegex(customerName)}$`, 'i'),
        planId,
        amount,
        createdAt: { $gte: new Date(Date.now() - 15 * 1000) },
      });
      if (dup) {
        return res.status(409).json({ success: false, message: `This walk-in payment was just recorded (${dup.transactionNumber}).` });
      }
      payment = await createPaymentWithReceipt({
        customerType: 'WALK_IN',
        customerName,
        planId,
        paymentMethod: 'Walk-in',
        amount,
        status: 'approved',
      });
      await payment.populate('planId', 'name duration');

      socketUtil.emitToAdmins('stats:refresh');
      socketUtil.emitToAdmins('payment:updated', payment);
      return res.status(201).json({ success: true, message: 'Walk-in payment recorded', data: payment, subscription: null, subscriptionError: null });
    }

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'A member must be selected' });
    }
    const user = await User.findOne({ _id: userId, role: 'user' });
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    payment = await createPaymentWithReceipt({
      userId,
      planId,
      referenceNumber: referenceNumber || undefined,
      paymentMethod: paymentMethod || 'Walk-in',
      amount,
      status: 'approved',
    });
    await payment.populate('planId', 'name duration');

    let subscriptionError = null;
    let subscription = null;
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

// Receipt numbers are random + date-prefixed, with a unique index as the backstop
async function createPaymentWithReceipt(fields, attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await Payment.create({ ...fields, transactionNumber: generateReceiptNumber() });
    } catch (err) {
      const isReceiptCollision = err && err.code === 11000 && /transactionNumber/.test(String(err.message));
      if (!isReceiptCollision || i === attempts - 1) throw err;
    }
  }
  return null;
}

const getSubscriptions = async (req, res, next) => {
  try {
    const subscriptions = await Subscription.find().populate('planId').populate('userId', 'fullname email');
    res.json({ success: true, data: subscriptions });
  } catch (error) {
    next(error);
  }
};
// Admin "Add Attendance"
const createManualAttendance = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { userId, guestName, visitorPassId, memberType, notes } = req.body;
    const action = req.body.action === 'checkout' ? 'checkout' : 'checkin';

    const given = [userId, guestName, visitorPassId].filter(Boolean).length;
    if (given === 0) {
      return res.status(400).json({ success: false, message: 'Select a member, a visitor pass, or enter a name' });
    }
    if (given > 1) {
      return res.status(400).json({ success: false, message: 'Choose only one: a member, a visitor pass, or a guest name' });
    }

    if (visitorPassId) {
      try {
        const result = await attendanceService.manualVisitorAttendance({
          passId: visitorPassId,
          action,
          adminId: req.user._id,
        });
        await result.attendance.populate('rfidCardId', 'cardType');
        return res.status(201).json({
          success: true,
          message: action === 'checkout' ? 'Visitor checked out — card is available again' : 'Visitor attendance recorded',
          data: result.attendance,
        });
      } catch (err) {
        if (err.statusCode && err.statusCode < 500) {
          return res.status(err.statusCode).json({ success: false, message: err.message, errorType: err.errorType });
        }
        throw err;
      }
    }


    // Member
    if (userId) {
      const user = await User.findOne({ _id: userId, role: 'user' });
      if (!user) return res.status(404).json({ success: false, message: 'Member not found' });
      if (!user.isActive) {
        return res.status(403).json({ success: false, message: 'This member account has been deactivated' });
      }

      // Shared with the RFID tap: many sessions per day, one open at a time, server clock, idempotent
      const requestId = req.body.requestId || req.get('Idempotency-Key') || undefined;
      try {
        if (action === 'checkout') {
          const out = await memberAttendance.checkOut({ user, now: new Date(), requestId });
          await out.attendance.populate('userId', 'fullname email phone');
          if (!out.replayed) {
            socketUtil.emitToAdmins('stats:refresh');
            socketUtil.emitToAdmins('attendance', {
              type: 'checkout', subjectType: 'member', attendanceType: 'MEMBER',
              attendance: { _id: out.attendance._id, checkIn: out.attendance.checkIn, checkOut: out.attendance.checkOut },
              user: { _id: user._id, fullname: user.fullname },
            });
          }
          return res.status(200).json({
            success: true,
            message: out.replayed ? 'Member was already checked out (this request was already processed)' : 'Member checked out',
            replayed: out.replayed,
            data: out.attendance,
          });
        }

        const inn = await memberAttendance.checkIn({
          user,
          now: new Date(),
          memberType,
          notes: notes || 'Manually recorded by admin',
          requestId,
        });
        await inn.attendance.populate('userId', 'fullname email phone');
        if (!inn.replayed) {
          socketUtil.emitToAdmins('stats:refresh');
          socketUtil.emitToAdmins('attendance', {
            type: 'checkin', subjectType: 'member', attendanceType: 'MEMBER',
            attendance: { _id: inn.attendance._id, checkIn: inn.attendance.checkIn },
            user: { _id: user._id, fullname: user.fullname },
            data: inn.attendance,
          });
        }
        return res.status(inn.replayed ? 200 : 201).json({
          success: true,
          message: inn.replayed ? 'Attendance was already recorded (this request was already processed)' : 'Attendance recorded',
          replayed: inn.replayed,
          ...(inn.warning ? { warning: inn.warning } : {}),
          data: inn.attendance,
        });
      } catch (err) {
        if (err.statusCode && err.statusCode < 500) {
          return res.status(err.statusCode).json({ success: false, message: err.message, errorType: err.errorType });
        }
        throw err;
      }
    }

    // Walk-in guest (no account, no pass)
    if (action === 'checkout') {
      return res.status(400).json({ success: false, message: 'Walk-in guests have no check-out. Use a visitor pass to track a visit.' });
    }
    const attendance = await Attendance.create({
      guestName: guestName.trim(),
      subjectType: 'member',
      attendanceType: 'GUEST',
      memberType: memberType === 'Student' ? 'Student' : 'Regular',
      checkIn: new Date(),
      notes: notes || 'Manually recorded by admin',
    });
    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('attendance', {
      type: 'checkin', subjectType: 'member', attendanceType: 'GUEST',
      attendance: { _id: attendance._id, checkIn: attendance.checkIn },
      user: { fullname: attendance.guestName },
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

// The other half of approveStudentId: lets an admin undo a previous approval
// Only ever operates on the most recent APPROVED submission for this member — never a 'rejected' one
const unverifyStudentId = async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'user' });
    if (!user) return res.status(404).json({ success: false, message: 'Member not found' });

    const submission = await StudentVerification.findOne({ userId: user._id, status: 'approved' }).sort({
      createdAt: -1,
    });
    if (!submission) {
      return res.status(400).json({ success: false, message: 'This member has no verified Student ID to unverify' });
    }

    submission.status = 'pending';
    submission.reviewedBy = undefined;
    submission.reviewNote = undefined;
    await submission.save();

    user.studentPromoActive = false;
    await user.save();

    socketUtil.emitToAdmins('stats:refresh');
    socketUtil.emitToAdmins('member:updated', { _id: user._id });

    res.json({
      success: true,
      message: 'Student ID returned to pending review',
      data: { submission, user },
    });
  } catch (error) {
    next(error);
  }
};

// Admin Settings

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
  getPaymentSummary,
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
  unverifyStudentId,
  createManualAttendance,
  sendPasswordChangeOtp,
  changePassword,
};