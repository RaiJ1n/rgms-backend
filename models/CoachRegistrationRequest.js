const mongoose = require('mongoose');

// One answer to one questionnaire question, snapshotted at submission time
const answerSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoachQuestion' },
    question: { type: String, required: true, trim: true },
    answer: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const coachRegistrationRequestSchema = new mongoose.Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    answers: [answerSchema],
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

// Every coach-facing list (getMyRequests, getMyClients) filters by coachId + status
coachRegistrationRequestSchema.index({ coachId: 1, status: 1 });
coachRegistrationRequestSchema.index({ clientId: 1, coachId: 1 });

// Business rule
coachRegistrationRequestSchema.index(
  { clientId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['pending', 'accepted'] } },
  }
);

// Same double-registration guard as CoachQuestion.js — see the comment there for why
module.exports = mongoose.models.CoachRegistrationRequest || mongoose.model('CoachRegistrationRequest', coachRegistrationRequestSchema);