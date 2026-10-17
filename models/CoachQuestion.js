const mongoose = require('mongoose');

// Admin-authored questions shown to a Client/User on the Coach Registration Questionnaire
// Admin-authored questions shown to a Client/User on the Coach Registration Questionnaire (Section 10 of the spec)
const coachQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true },
    type: { type: String, enum: ['text', 'choice', 'multi_choice'], default: 'text' },
    // Only meaningful when type is 'choice'/'multi_choice'
    options: [{ type: String, trim: true }],
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Guarded against double-registration
module.exports = mongoose.models.CoachQuestion || mongoose.model('CoachQuestion', coachQuestionSchema);
