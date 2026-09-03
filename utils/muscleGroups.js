// Single source of truth for the predefined muscle-group tag list
// (Section E3 of the spec). Both the Exercise schema's enum below and
// the frontend tag picker in ExerciseManagement.vue need the exact
// same list — kept here rather than hardcoded in two places so they
// can't drift apart.
const MUSCLE_GROUPS = [
  'Chest',
  'Back',
  'Shoulders',
  'Biceps',
  'Triceps',
  'Forearms',
  'Core',
  'Glutes',
  'Quadriceps',
  'Hamstrings',
  'Calves',
];

module.exports = { MUSCLE_GROUPS };