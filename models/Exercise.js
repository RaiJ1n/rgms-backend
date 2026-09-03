const mongoose = require('mongoose');
const { MUSCLE_GROUPS } = require('../utils/muscleGroups');

// Each coach maintains their own private exercise library — NOT a
// shared catalog. Every query in exerciseController.js filters on
// coachId so one coach can never see, edit, or delete another coach's
// exercises, mirroring the same ownership pattern coachPortalController.js
// already uses for classes/requests/clients.
const exerciseSchema = new mongoose.Schema(
  {
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['Strength', 'Cardio', 'Flexibility', 'Balance', 'HIIT'],
      required: true,
    },
    description: { type: String, trim: true, default: '' },
    // Tag-based muscle group selection (Section E3) — a fixed list, not
    // free text, so it can render as chips/tags on the frontend and stay
    // queryable/consistent rather than accumulating near-duplicate
    // free-text variants ("Quad" vs "Quads" vs "Quadriceps").
    muscleGroups: [{ type: String, enum: MUSCLE_GROUPS }],
    // Defaults a coach can start from when adding this exercise to a
    // plan; WorkoutPlan.components stores its own sets/reps per-plan
    // (see WorkoutPlan.js) so editing an exercise's defaults later never
    // silently changes sets/reps on a plan that already prescribed this
    // exercise.
    defaultSets: { type: Number, min: 1, required: true },
    defaultReps: { type: Number, min: 1, required: true },
  },
  { timestamps: true }
);

exerciseSchema.index({ coachId: 1, name: 1 });

module.exports = mongoose.model('Exercise', exerciseSchema);