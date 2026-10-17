const mongoose = require('mongoose');

const gymClassSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },

  // Was a plain-text `instructor` string
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // One-time session
  date: { type: Date, required: true },
  startTime: { type: String, required: true, trim: true },
  endTime: { type: String, required: true, trim: true },

  // Admin sets this manually via a dropdown
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