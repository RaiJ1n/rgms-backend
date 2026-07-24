const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
  dayOfWeek: { type: String },
  date: { type: Date },
  startTime: { type: String },
  endTime: { type: String },
});

const gymClassSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String },
  trainer: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer' },
  schedule: [scheduleSchema],
  capacity: { type: Number, default: 20 },
  fee: { type: Number, default: 0 },
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  image: {
    url: String,
    public_id: String,
  },
}, { timestamps: true });

module.exports = mongoose.model('GymClass', gymClassSchema);
