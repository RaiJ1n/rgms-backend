const User = require('../models/User');

const getProfile = async (req, res, next) => {
  try {
    res.json({ success: true, data: req.user });
  } catch (error) {
    next(error);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { fullname, phone } = req.body;
    if (fullname) user.fullname = fullname;
    if (phone) user.phone = phone;
    await user.save();
    res.json({ success: true, message: 'Profile updated', data: user });
  } catch (error) {
    next(error);
  }
};

const getSubscriptions = async (req, res, next) => {
  try {
    const subscriptions = await require('../models/Subscription').find({ userId: req.user._id }).populate('planId').populate('paymentId');
    res.json({ success: true, data: subscriptions });
  } catch (error) {
    next(error);
  }
};

const getPayments = async (req, res, next) => {
  try {
    const payments = await require('../models/Payment').find({ userId: req.user._id });
    res.json({ success: true, data: payments });
  } catch (error) {
    next(error);
  }
};

module.exports = { getProfile, updateProfile, getSubscriptions, getPayments };
