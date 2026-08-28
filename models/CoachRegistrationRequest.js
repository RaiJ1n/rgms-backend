const mongoose = require('mongoose');

// One answer to one questionnaire question, snapshotted at submission
// time. `question` is copied from CoachQuestion.question rather than
// only stored by reference — if an admin later edits or deletes that
// question, this request should still show exactly what the client was
// actually asked when they answered, not whatever the question reads
// today.
const answerSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoachQuestion' },
    question: { type: String, required: true, trim: true },
    // String for 'text'/'choice' questions, array of strings for
    // 'multi_choice'. Mixed here rather than splitting into two fields
    // so the questionnaire can grow new question types without a
    // schema migration.
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
    // Set when the coach accepts or rejects — lets both sides see when
    // the decision was made, distinct from createdAt/updatedAt.
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

// Every coach-facing list (getMyRequests, getMyClients) filters by
// coachId + status, and duplicate-request checks filter by
// clientId + coachId + status — this index serves both.
coachRegistrationRequestSchema.index({ coachId: 1, status: 1 });
coachRegistrationRequestSchema.index({ clientId: 1, coachId: 1 });

// Same double-registration guard as CoachQuestion.js — see the comment
// there for why.
module.exports = mongoose.models.CoachRegistrationRequest || mongoose.model('CoachRegistrationRequest', coachRegistrationRequestSchema);
