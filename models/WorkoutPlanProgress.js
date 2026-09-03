const mongoose = require('mongoose');

// One document per (plan, member) pair — deliberately NOT stored inline
// on WorkoutPlan.components, because a plan can be assigned to several
// clients (assignedTo is an array) who each need their own independent
// done/completedSets state. Storing progress on the plan itself would
// mean every assigned client shared (and clobbered) the same progress.
const progressEntrySchema = new mongoose.Schema(
  {
    // Matches a WorkoutPlan.components[i]._id — not the exercise id,
    // since the same exercise could theoretically appear twice in one
    // plan with different sets/reps, and each occurrence needs its own
    // progress.
    componentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    done: { type: Boolean, default: false },
    completedSets: [{ type: Number }],
    // Free-text notes the member can leave against a specific exercise
    // (e.g. "used 20kg dumbbells" / "felt easy, increase next time") —
    // was in the original mock UI as a local-only field with no
    // persistence; added here rather than left to silently vanish on
    // reload.
    notes: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const workoutPlanProgressSchema = new mongoose.Schema(
  {
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkoutPlan', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    entries: [progressEntrySchema],
  },
  { timestamps: true }
);

// One progress document per member per plan — updateProgress in
// workoutPlanController.js upserts against this rather than ever
// creating a second one.
workoutPlanProgressSchema.index({ planId: 1, memberId: 1 }, { unique: true });

module.exports = mongoose.model('WorkoutPlanProgress', workoutPlanProgressSchema);