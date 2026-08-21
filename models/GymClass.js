const mongoose = require('mongoose');

const gymClassSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },

  // Was a plain-text `instructor` string. Now a real reference to the
  // Coach model (see models/Coach.js) — classes.md checklist item J
  // requires "Display the assigned instructor in the class information"
  // and "Prevent unauthorized users from assigning themselves as
  // instructors," which a free-text field can't enforce (anyone typing
  // in the admin form could put any name, real coach or not).
  //
  // Migration note: existing classes have a string in the old
  // `instructor` field with no corresponding Coach account (Coach is a
  // brand-new model with zero rows). Those old string values are NOT
  // automatically carried over — this field starts empty on existing
  // documents until an admin re-assigns a real coach via AdminClasses.vue.
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach' },

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