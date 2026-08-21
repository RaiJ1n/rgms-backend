const GymClass = require('../models/GymClass');

// Everything here runs behind protectCoach (see coachRoutes.js) — req.coach
// is the authenticated coach, never taken from a param or body. A coach
// can only ever see their own classes, never another coach's, and never
// by guessing an id — getMyClassRoster below double-checks this even
// though the query itself already scopes to req.coach._id.

const getMyClasses = async (req, res, next) => {
  try {
    const classes = await GymClass.find({ instructorId: req.coach._id })
      .sort({ date: -1, startTime: 1 });

    res.json({ success: true, data: classes });
  } catch (error) {
    next(error);
  }
};

// Roster for one of this coach's own classes. Reuses the same
// attendees->members shape as adminController.getClassMembers so the
// frontend list-rendering logic can be shared/consistent, but this is a
// deliberately separate endpoint (not the admin one reused with a looser
// middleware) — a coach must never be able to view another coach's roster
// by id-guessing, which is why instructorId is checked explicitly below
// rather than trusting that only assigned coaches would know a class id.
const getMyClassRoster = async (req, res, next) => {
  try {
    const gymClass = await GymClass.findById(req.params.id)
      .populate('attendees', 'fullname email phone');

    if (!gymClass) return res.status(404).json({ success: false, message: 'Class not found' });

    if (!gymClass.instructorId || gymClass.instructorId.toString() !== req.coach._id.toString()) {
      return res.status(403).json({ success: false, message: 'You are not assigned to this class' });
    }

    const members = gymClass.attendees.map((u) => ({
      _id: u._id,
      name: u.fullname,
      email: u.email,
      phone: u.phone,
    }));

    res.json({
      success: true,
      data: {
        class: {
          _id: gymClass._id,
          name: gymClass.name,
          date: gymClass.date,
          startTime: gymClass.startTime,
          endTime: gymClass.endTime,
          status: gymClass.status,
          capacity: gymClass.capacity,
        },
        members,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getMyClasses, getMyClassRoster };