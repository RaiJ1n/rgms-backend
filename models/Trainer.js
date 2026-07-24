const mongoose = require('mongoose');

const trainerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String },
  email: { type: String },
  bio: { type: String },
  photo: {
    url: String,
    public_id: String,
  },
}, { timestamps: true });

module.exports = mongoose.model('Trainer', trainerSchema);
