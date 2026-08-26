const mongoose = require('mongoose');

const gymClassSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },

  // Was a plain-text `instructor` string. Now a real reference to a
  // Coach — but "Coach" is not a separate collection/model, it's a User
  // document with role: 'coach' (see models/User.js and
  // controllers/coachController.js, which already reads/writes User
  // scoped to role: 'coach'). So this ref must point at 'User', the
  // model Mongoose actually has registered — 'Coach' was the old,
  // now-deprecated standalone model (models/Coach.js exports {} and
  // never calls mongoose.model(...)), so ref: 'Coach' would make
  // .populate(INSTRUCTOR_POPULATE) throw "Schema hasn't been registered
  // for model 'Coach'" the moment any class with an instructor was read.
  //
  // classes.md checklist item J requires "Display the assigned
  // instructor in the class information" and "Prevent unauthorized
  // users from assigning themselves as instructors," which a free-text
  // field can't enforce (anyone typing in the admin form could put any
  // name, real coach or not) — hence a real reference rather than text.
  //
  // Migration note: existing classes have a string in the old
  // `instructor` field with no corresponding coach account. Those old
  // string values are NOT automatically carried over — this field
  // starts empty on existing documents until an admin re-assigns a real
  // coach via AdminClasses.vue.
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // One-time session — a single date + start/end time, not a recurring
  // weekly schedule (previously an array of {dayOfWeek, date, startTime,
  // endTime} slots).
  date: { type: Date, required: true },
  startTime: { type: String, required: true, trim: true },
  endTime: { type: String, required: true, trim: true },

  // Admin sets this manually via a dropdown. The member-facing class
  // list only shows classes that are 'Active' AND whose date hasn't
  // passed yet — see classController.getClasses — so a class quietly
  // drops off the member page once it's done, with or without the admin
  // remembering to mark it Completed.
  status: {
    type: String,
    enum: ['Active', 'Cancelled', 'Completed'],
    default: 'Active',
  },

  capacity: { type: Number, default: 20 },
  fee: { type: Number, default: 0 },
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  image: {
    url: String,
    public_id: String,
  },
}, { timestamps: true });

module.exports = mongoose.model('GymClass', gymClassSchema);