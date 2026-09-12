// One-off script to seed a starter exercise library (Section 13/14 of
// the spec) into one or more coaches' PRIVATE exercise collections.
// Exercise.js is deliberately per-coach (Section 16 — no shared/global
// catalog), so this always writes real Exercise documents scoped to a
// real coachId, never a separate "template" table a coach would have
// to copy from manually.
//
// Usage (run from the backend project root):
//   node scripts/seedExercises.js coach@example.com   // seed just this coach
//   node scripts/seedExercises.js --all                // seed every existing coach
//
// Safe to re-run: exercises are matched by (coachId, name) before
// inserting, so running this twice for the same coach never creates
// duplicates — it just reports what's already there and skips it.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Exercise = require('../models/Exercise');

// Section 13: Strength + Calisthenics, the two categories explicitly
// required. Section 14: recommended the category list stay at
// Strength/Cardio/Flexibility/Balance/HIIT/Calisthenics — full coverage
// of what a gym's exercise library actually needs without padding it
// with categories for their own sake — so this seed only populates the
// two categories the spec actually asked to be pre-filled; Cardio/
// Flexibility/Balance/HIIT stay available for coaches to add their own
// into, same as before this script existed.
//
// muscleGroups values are drawn from utils/muscleGroups.js's fixed
// enum, matching the frontend's tag picker exactly.
const STARTER_EXERCISES = [
  // ---- Strength ----
  { name: 'Bench Press', category: 'Strength', muscleGroups: ['Chest', 'Triceps', 'Shoulders'], defaultSets: 4, defaultReps: 8, description: 'Barbell press lying on a flat bench.' },
  { name: 'Squat', category: 'Strength', muscleGroups: ['Quadriceps', 'Glutes', 'Hamstrings'], defaultSets: 4, defaultReps: 8, description: 'Barbell back squat.' },
  { name: 'Deadlift', category: 'Strength', muscleGroups: ['Back', 'Hamstrings', 'Glutes'], defaultSets: 4, defaultReps: 6, description: 'Conventional barbell deadlift.' },
  { name: 'Overhead Press', category: 'Strength', muscleGroups: ['Shoulders', 'Triceps'], defaultSets: 4, defaultReps: 8, description: 'Standing barbell or dumbbell press overhead.' },
  { name: 'Dumbbell Row', category: 'Strength', muscleGroups: ['Back', 'Biceps'], defaultSets: 4, defaultReps: 10, description: 'Single-arm dumbbell row, supported on a bench.' },
  { name: 'Bicep Curl', category: 'Strength', muscleGroups: ['Biceps', 'Forearms'], defaultSets: 3, defaultReps: 12, description: 'Dumbbell or barbell curl.' },
  { name: 'Tricep Extension', category: 'Strength', muscleGroups: ['Triceps'], defaultSets: 3, defaultReps: 12, description: 'Overhead or cable tricep extension.' },
  { name: 'Leg Press', category: 'Strength', muscleGroups: ['Quadriceps', 'Glutes', 'Hamstrings'], defaultSets: 4, defaultReps: 10, description: 'Machine leg press.' },

  // ---- Calisthenics ----
  { name: 'Push-Up', category: 'Calisthenics', muscleGroups: ['Chest', 'Triceps', 'Shoulders'], defaultSets: 3, defaultReps: 15, description: 'Standard bodyweight push-up.' },
  { name: 'Pull-Up', category: 'Calisthenics', muscleGroups: ['Back', 'Biceps'], defaultSets: 3, defaultReps: 8, description: 'Overhand grip, full range of motion.' },
  { name: 'Chin-Up', category: 'Calisthenics', muscleGroups: ['Back', 'Biceps'], defaultSets: 3, defaultReps: 8, description: 'Underhand grip pull-up variation.' },
  { name: 'Bodyweight Squat', category: 'Calisthenics', muscleGroups: ['Quadriceps', 'Glutes'], defaultSets: 3, defaultReps: 15, description: 'No-load squat, full depth.' },
  { name: 'Dips', category: 'Calisthenics', muscleGroups: ['Chest', 'Triceps'], defaultSets: 3, defaultReps: 10, description: 'Parallel bar or bench dips.' },
  { name: 'Lunges', category: 'Calisthenics', muscleGroups: ['Quadriceps', 'Glutes', 'Hamstrings'], defaultSets: 3, defaultReps: 12, description: 'Alternating forward or walking lunges, per leg.' },
  // defaultReps has no separate "hold duration" field in the schema —
  // recorded as 1 rep per set here, with the actual hold time called
  // out in the description, rather than adding a duration field this
  // seed alone would need (out of scope for Section 13).
  { name: 'Plank', category: 'Calisthenics', muscleGroups: ['Core'], defaultSets: 3, defaultReps: 1, description: 'Forearm plank, 30–60 second hold per set.' },
];

async function seedForCoach(coach) {
  const existingNames = new Set(
    (await Exercise.find({ coachId: coach._id }).select('name')).map((e) => e.name)
  );

  const toInsert = STARTER_EXERCISES
    .filter((ex) => !existingNames.has(ex.name))
    .map((ex) => ({ ...ex, coachId: coach._id }));

  if (toInsert.length === 0) {
    console.log(`  ${coach.email}: already has all starter exercises, nothing to do.`);
    return;
  }

  await Exercise.insertMany(toInsert);
  console.log(`  ${coach.email}: added ${toInsert.length} exercise(s), skipped ${STARTER_EXERCISES.length - toInsert.length} already-present.`);
}

async function run() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/seedExercises.js <coach-email>   OR   node scripts/seedExercises.js --all');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  let coaches;
  if (arg === '--all') {
    coaches = await User.find({ role: 'coach' });
    if (coaches.length === 0) {
      console.log('No coach accounts found — nothing to seed.');
    } else {
      console.log(`Seeding starter exercises for ${coaches.length} coach(es):`);
    }
  } else {
    const coach = await User.findOne({ email: arg, role: 'coach' });
    if (!coach) {
      console.log(`No coach account found with email ${arg}.`);
      coaches = [];
    } else {
      coaches = [coach];
    }
  }

  for (const coach of coaches) {
    await seedForCoach(coach);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
