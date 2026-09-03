const { validationResult } = require('express-validator');
const Exercise = require('../models/Exercise');

// Every query here is scoped to req.coach._id (populated by
// protectCoach — see coachRoutes.js) — a coach can only ever see, edit,
// or delete their OWN exercises. Matches the exact ownership pattern
// coachPortalController.js already uses for classes/requests/clients.

const getMyExercises = async (req, res, next) => {
  try {
    const exercises = await Exercise.find({ coachId: req.coach._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: exercises });
  } catch (error) {
    next(error);
  }
};

const createExercise = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { name, category, description, muscleGroups, defaultSets, defaultReps } = req.body;

    const exercise = await Exercise.create({
      coachId: req.coach._id,
      name,
      category,
      description,
      muscleGroups: muscleGroups || [],
      defaultSets,
      defaultReps,
    });

    res.status(201).json({ success: true, message: 'Exercise added', data: exercise });
  } catch (error) {
    next(error);
  }
};

const updateExercise = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    // Scoped to coachId in the query itself, not just checked after
    // fetching — a coach can never even locate another coach's
    // exercise by guessing an id, let alone modify it.
    const exercise = await Exercise.findOne({ _id: req.params.id, coachId: req.coach._id });
    if (!exercise) return res.status(404).json({ success: false, message: 'Exercise not found' });

    const { name, category, description, muscleGroups, defaultSets, defaultReps } = req.body;
    if (name !== undefined) exercise.name = name;
    if (category !== undefined) exercise.category = category;
    if (description !== undefined) exercise.description = description;
    if (muscleGroups !== undefined) exercise.muscleGroups = muscleGroups;
    if (defaultSets !== undefined) exercise.defaultSets = defaultSets;
    if (defaultReps !== undefined) exercise.defaultReps = defaultReps;

    await exercise.save();
    res.json({ success: true, message: 'Exercise updated', data: exercise });
  } catch (error) {
    next(error);
  }
};

const deleteExercise = async (req, res, next) => {
  try {
    const exercise = await Exercise.findOneAndDelete({ _id: req.params.id, coachId: req.coach._id });
    if (!exercise) return res.status(404).json({ success: false, message: 'Exercise not found' });
    res.json({ success: true, message: 'Exercise deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getMyExercises, createExercise, updateExercise, deleteExercise };