const mongoose = require('mongoose');

const gymClassSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },

  // Plain-text instructor name. There's a Trainer model in this codebase,
  // but it has no controller/routes wired up yet, so classes just store
  // the instructor's name directly rather than a Trainer reference.
  instructor: { type: String, trim: true },

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