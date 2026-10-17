const mongoose = require('mongoose');

// A single prescribed exercise within a plan
const workoutComponentSchema = new mongoose.Schema(
  {
    exerciseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exercise' },
    name: { type: String, required: true, trim: true },
    sets: { type: Number, required: true, min: 1 },
    reps: { type: Number, required: true, min: 1 },
  },
  { _id: true }
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
    duration: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: '' },
    components: [workoutComponentSchema],
    // Every id in here MUST be one of this coach's own accepted clients
    // Section E4: every id in here MUST be one of this coach's own accepted clients
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

workoutPlanSchema.index({ coachId: 1 });
workoutPlanSchema.index({ assignedTo: 1 });

module.exports = mongoose.model('WorkoutPlan', workoutPlanSchema);