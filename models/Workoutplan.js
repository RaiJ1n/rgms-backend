const mongoose = require('mongoose');

// A single prescribed exercise within a plan. References the Exercise
// library entry it came from (so "which exercise is this" stays a real
// relationship, queryable/reportable), but SNAPSHOTS name/sets/reps at
// the moment it's added to the plan. Two reasons for the snapshot
// rather than always reading through to the live Exercise document:
//   1. A coach can prescribe different sets/reps for this plan than the
//      exercise's own defaultSets/defaultReps (matches the existing
//      WorkoutPlans.vue UI, which lets a coach type per-component
//      sets/reps).
//   2. If the coach edits or deletes the underlying Exercise later, a
//      plan a client is actively following shouldn't retroactively
//      change or break.
const workoutComponentSchema = new mongoose.Schema(
  {
    exerciseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exercise' },
    name: { type: String, required: true, trim: true },
    sets: { type: Number, required: true, min: 1 },
    reps: { type: Number, required: true, min: 1 },
  },
  { _id: true } // keep the auto _id — WorkoutPlanProgress references it per-member
);

const workoutPlanSchema = new mongoose.Schema(
  {
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['Strength', 'Cardio', 'Flexibility', 'HIIT', 'Mixed'],
      required: true,
    },
    // Free text ("4 weeks") to match the existing WorkoutPlans.vue UI
    // rather than forcing it into a structured start/end date the
    // frontend doesn't currently collect.
    duration: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: '' },
    components: [workoutComponentSchema],
    // Section E4: every id in here MUST be one of this coach's own
    // accepted clients (CoachRegistrationRequest, status: 'accepted').
    // That's enforced in workoutPlanController.js at create/update time
    // — never trusted from the request body alone, and never populated
    // here from a raw client-supplied id without that check.
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

workoutPlanSchema.index({ coachId: 1 });
workoutPlanSchema.index({ assignedTo: 1 });

module.exports = mongoose.model('WorkoutPlan', workoutPlanSchema);