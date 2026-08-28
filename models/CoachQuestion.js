const mongoose = require('mongoose');

// Admin-authored questions shown to a Client/User on the Coach
// Registration Questionnaire (Section 10 of the spec). Every currently
// active question is pulled in at registration time by
// coachDirectoryController.getActiveQuestions / registerToCoach — there
// is deliberately no per-coach set of questions, the same questionnaire
// is used across every coach, matching "The Admin should be able to
// create questions that Clients must answer when registering to a Coach."
const coachQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true },
    // 'text'    -> free-form answer (e.g. "Do you have any allergies?")
    // 'choice'  -> pick exactly one of `options`
    // 'multi_choice' -> pick one or more of `options`
    type: { type: String, enum: ['text', 'choice', 'multi_choice'], default: 'text' },
    // Only meaningful when type is 'choice'/'multi_choice'. Left empty
    // for 'text' questions.
    options: [{ type: String, trim: true }],
    isActive: { type: Boolean, default: true },
    // Controls display order on the questionnaire; lower shows first.
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Guarded against double-registration (mongoose.models.CoachQuestion ||
// ...) rather than a bare mongoose.model(...) call — on Windows,
// nodemon doesn't always fully tear down the previous process before
// restarting, which can re-execute this file in a process that already
// has 'CoachQuestion' registered and throw OverwriteModelError. This is
// the standard safe pattern for that, with no downside in a normal
// single-execution boot either.
module.exports = mongoose.models.CoachQuestion || mongoose.model('CoachQuestion', coachQuestionSchema);
