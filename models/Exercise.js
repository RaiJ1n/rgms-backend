const mongoose = require('mongoose');
const { MUSCLE_GROUPS } = require('../utils/muscleGroups');

// Each coach maintains their own private exercise library — NOT a shared catalog
// Every query in exerciseController.js filters on coachId so one coach can never see, edit
const exerciseSchema = new mongoose.Schema(
  {
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['Strength', 'Cardio', 'Flexibility', 'Balance', 'HIIT', 'Calisthenics'],
      required: true,
    },
    description: { type: String, trim: true, default: '' },
    // Tag-based muscle group selection (Section E3) — a fixed list, not free text
    muscleGroups: [{ type: String, enum: MUSCLE_GROUPS }],
    // Defaults a coach can start from when adding this exercise to a plan
    defaultSets: { type: Number, min: 1, required: true },
    defaultReps: { type: Number, min: 1, required: true },
  },
  { timestamps: true }
);

exerciseSchema.index({ coachId: 1, name: 1 });

module.exports = mongoose.model('Exercise', exerciseSchema);