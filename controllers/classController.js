const GymClass = require('../models/GymClass');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

exports.createClass = async (req, res, next) => {
  try {
    const payload = req.body;
    const gymClass = new GymClass(payload);
    await gymClass.save();
    res.status(201).json({ gymClass });
  } catch (err) { next(err); }
};

exports.getClasses = async (req, res, next) => {
  try {
    const classes = await GymClass.find().populate('trainer', 'name');
    res.json({ data: classes });
  } catch (err) { next(err); }
};

exports.getClass = async (req, res, next) => {
  try {
    const gymClass = await GymClass.findById(req.params.id).populate('trainer', 'name');
    if (!gymClass) return res.status(404).json({ message: 'Not found' });
    res.json({ data: gymClass });
  } catch (err) { next(err); }
};

exports.updateClass = async (req, res, next) => {
  try {
    const updated = await GymClass.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ data: updated });
  } catch (err) { next(err); }
};

exports.deleteClass = async (req, res, next) => {
  try {
    await GymClass.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
};

exports.registerMember = async (req, res, next) => {
  try {
    const { memberId } = req.body;
    const gymClass = await GymClass.findById(req.params.id);
    if (!gymClass) return res.status(404).json({ message: 'Class not found' });
    if (gymClass.attendees.includes(memberId)) return res.status(400).json({ message: 'Already registered' });
    if (gymClass.attendees.length >= gymClass.capacity) return res.status(400).json({ message: 'Class full' });
    gymClass.attendees.push(memberId);
    await gymClass.save();
    await AuditLog.create({ action: 'class_register', userId: memberId, meta: { classId: gymClass._id } });
    res.json({ message: 'Registered', gymClass });
  } catch (err) { next(err); }
};

exports.cancelRegistration = async (req, res, next) => {
  try {
    const { memberId } = req.body;
    const gymClass = await GymClass.findById(req.params.id);
    if (!gymClass) return res.status(404).json({ message: 'Class not found' });
    gymClass.attendees = gymClass.attendees.filter(a => a.toString() !== memberId);
    await gymClass.save();
    await AuditLog.create({ action: 'class_cancel', userId: memberId, meta: { classId: gymClass._id } });
    res.json({ message: 'Cancelled', gymClass });
  } catch (err) { next(err); }
};
