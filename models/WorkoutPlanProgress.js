const mongoose = require('mongoose');

// One document per (plan, member) pair — deliberately NOT stored inline on WorkoutPlan.components
const progressEntrySchema = new mongoose.Schema(
  {
    componentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    done: { type: Boolean, default: false },
    completedSets: [{ type: Number }],
    // Free-text notes the member can leave against a specific exercise
    // "used 20kg dumbbells" / "felt easy, increase next time")
    notes: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const workoutPlanProgressSchema = new mongoose.Schema(
  {
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkoutPlan', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    entries: [progressEntrySchema],
    // Daily refresh history
    history: [
      {
        date: { type: Date, default: Date.now },
        entries: [progressEntrySchema],
      },
    ],
    lastResetAt: { type: Date },
  },
  { timestamps: true }
);

// One progress document per member per plan
workoutPlanProgressSchema.index({ planId: 1, memberId: 1 }, { unique: true });

module.exports = mongoose.model('WorkoutPlanProgress', workoutPlanProgressSchema);