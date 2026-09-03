const { validationResult } = require('express-validator');
const WorkoutPlan = require('../models/WorkoutPlan');
const WorkoutPlanProgress = require('../models/WorkoutPlanProgress');
const Exercise = require('../models/Exercise');
const CoachRegistrationRequest = require('../models/CoachRegistrationRequest');

// ---------------------------------------------------------------------
// Shared helper — Section E4's actual enforcement point.
// ---------------------------------------------------------------------
// Returns the set of client User ids this coach is actually allowed to
// assign to (their own accepted clients — same query
// coachPortalController.getMyClients already uses). createPlan/
// updatePlan below check every id in the request's assignedTo against
// this on the SERVER, so manually POSTing another coach's client id
// is rejected regardless of what the frontend dropdown would have
// allowed.
async function getEligibleClientIds(coachId) {
  const accepted = await CoachRegistrationRequest.find({ coachId, status: 'accepted' }).select('clientId');
  return new Set(accepted.map((r) => r.clientId.toString()));
}

async function assertAssignedToEligible(coachId, assignedTo) {
  if (!assignedTo || assignedTo.length === 0) return;
  const eligible = await getEligibleClientIds(coachId);
  const ineligible = assignedTo.filter((id) => !eligible.has(id.toString()));
  if (ineligible.length > 0) {
    const err = new Error('One or more selected clients are not assigned to you');
    err.statusCode = 403;
    throw err;
  }
}

// ---------------------------------------------------------------------
// Coach-side (protectCoach) — mounted in coachRoutes.js
// ---------------------------------------------------------------------

const getMyPlans = async (req, res, next) => {
  try {
    const plans = await WorkoutPlan.find({ coachId: req.coach._id })
      .populate('assignedTo', 'fullname')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: plans });
  } catch (error) {
    next(error);
  }
};

const createPlan = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { name, type, duration, description, components, assignedTo } = req.body;

    await assertAssignedToEligible(req.coach._id, assignedTo);

    // Components can reference an exerciseId (pull name/sets/reps from
    // the coach's own library) or be typed directly — either way the
    // exercise, if referenced, must belong to this coach (same
    // ownership check as exerciseController).
    const resolvedComponents = await resolveComponents(req.coach._id, components);

    const plan = await WorkoutPlan.create({
      coachId: req.coach._id,
      name,
      type,
      duration,
      description,
      components: resolvedComponents,
      assignedTo: assignedTo || [],
    });

    const populated = await plan.populate('assignedTo', 'fullname');
    res.status(201).json({ success: true, message: 'Workout plan created', data: populated });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

const updatePlan = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const plan = await WorkoutPlan.findOne({ _id: req.params.id, coachId: req.coach._id });
    if (!plan) return res.status(404).json({ success: false, message: 'Workout plan not found' });

    const { name, type, duration, description, components, assignedTo } = req.body;

    if (assignedTo !== undefined) {
      await assertAssignedToEligible(req.coach._id, assignedTo);
      plan.assignedTo = assignedTo;
    }
    if (name !== undefined) plan.name = name;
    if (type !== undefined) plan.type = type;
    if (duration !== undefined) plan.duration = duration;
    if (description !== undefined) plan.description = description;
    if (components !== undefined) plan.components = await resolveComponents(req.coach._id, components);

    await plan.save();
    const populated = await plan.populate('assignedTo', 'fullname');
    res.json({ success: true, message: 'Workout plan updated', data: populated });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

const deletePlan = async (req, res, next) => {
  try {
    const plan = await WorkoutPlan.findOneAndDelete({ _id: req.params.id, coachId: req.coach._id });
    if (!plan) return res.status(404).json({ success: false, message: 'Workout plan not found' });
    // Clean up any progress tracked against this plan — otherwise
    // orphaned WorkoutPlanProgress rows sit around forever referencing
    // a planId that no longer resolves to anything.
    await WorkoutPlanProgress.deleteMany({ planId: plan._id });
    res.json({ success: true, message: 'Workout plan deleted' });
  } catch (error) {
    next(error);
  }
};

// Validates/snapshots each component. If exerciseId is given, it must
// belong to this coach (mirrors exerciseController's ownership check) —
// a coach can't reference another coach's private exercise. If no
// exerciseId is given, the component is still accepted as a one-off
// typed entry (matches the existing free-text UI), just without a
// library link.
async function resolveComponents(coachId, components) {
  if (!Array.isArray(components)) return [];
  const resolved = [];
  for (const c of components) {
    if (c.exerciseId) {
      const exercise = await Exercise.findOne({ _id: c.exerciseId, coachId });
      if (!exercise) {
        const err = new Error('One or more selected exercises were not found in your library');
        err.statusCode = 400;
        throw err;
      }
      resolved.push({
        exerciseId: exercise._id,
        name: c.name || exercise.name,
        sets: c.sets || exercise.defaultSets,
        reps: c.reps || exercise.defaultReps,
      });
    } else {
      resolved.push({ name: c.name, sets: c.sets, reps: c.reps });
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------
// Member-side (protect) — mounted in userRoutes.js
// ---------------------------------------------------------------------

const getMyAssignedPlans = async (req, res, next) => {
  try {
    const plans = await WorkoutPlan.find({ assignedTo: req.user._id })
      .populate('coachId', 'fullname')
      .sort({ createdAt: -1 });

    const progressDocs = await WorkoutPlanProgress.find({
      planId: { $in: plans.map((p) => p._id) },
      memberId: req.user._id,
    });
    const progressByPlan = new Map(progressDocs.map((p) => [p.planId.toString(), p]));

    const withProgress = plans.map((plan) => attachProgress(plan, progressByPlan.get(plan._id.toString())));

    res.json({ success: true, data: withProgress });
  } catch (error) {
    next(error);
  }
};

const getMyAssignedPlanDetail = async (req, res, next) => {
  try {
    const plan = await WorkoutPlan.findOne({ _id: req.params.id, assignedTo: req.user._id }).populate(
      'coachId',
      'fullname'
    );
    if (!plan) return res.status(404).json({ success: false, message: 'Workout plan not found' });

    const progress = await WorkoutPlanProgress.findOne({ planId: plan._id, memberId: req.user._id });
    res.json({ success: true, data: attachProgress(plan, progress) });
  } catch (error) {
    next(error);
  }
};

// Merges a plan document with this member's progress into the same
// { components: [{..., done, completedSets}], progress: percent } shape
// ClientWorkoutSelection.vue / ClientExerciseView.vue already render
// from their mock data — no frontend shape change needed beyond
// swapping the data source.
function attachProgress(plan, progressDoc) {
  const entriesByComponent = new Map((progressDoc?.entries || []).map((e) => [e.componentId.toString(), e]));
  const components = plan.components.map((c) => {
    const entry = entriesByComponent.get(c._id.toString());
    return {
      _id: c._id,
      exerciseId: c.exerciseId,
      name: c.name,
      sets: c.sets,
      reps: c.reps,
      done: entry?.done || false,
      completedSets: entry?.completedSets || [],
      notes: entry?.notes || '',
    };
  });
  const doneCount = components.filter((c) => c.done).length;
  const progress = components.length ? Math.round((doneCount / components.length) * 100) : 0;

  return {
    _id: plan._id,
    name: plan.name,
    type: plan.type,
    duration: plan.duration,
    description: plan.description,
    coach: plan.coachId,
    components,
    progress,
    status: progress === 100 ? 'Completed' : 'Active',
  };
}

// One tap = toggle a single set for one component; done is derived
// server-side from completedSets vs the component's own `sets` count,
// same rule ClientExerciseView.vue's toggleSet() already applies
// client-side — kept identical so persisted state matches what the UI
// shows before/after a reload.
const updateProgress = async (req, res, next) => {
  try {
    const { componentId, completedSets, notes } = req.body;
    if (!componentId || !Array.isArray(completedSets)) {
      return res.status(400).json({ success: false, message: 'componentId and completedSets are required' });
    }

    const plan = await WorkoutPlan.findOne({ _id: req.params.id, assignedTo: req.user._id });
    if (!plan) return res.status(404).json({ success: false, message: 'Workout plan not found' });

    const component = plan.components.id(componentId);
    if (!component) return res.status(404).json({ success: false, message: 'Exercise not found in this plan' });

    const done = completedSets.length >= component.sets;

    // Preserve the existing note when this call doesn't include one
    // (e.g. a "Mark Done" tap that isn't editing notes) rather than
    // wiping it out on every set/done toggle.
    const existing = await WorkoutPlanProgress.findOne(
      { planId: plan._id, memberId: req.user._id, 'entries.componentId': componentId },
      { 'entries.$': 1 }
    );
    const resolvedNotes = notes !== undefined ? notes : existing?.entries?.[0]?.notes || '';

    await WorkoutPlanProgress.findOneAndUpdate(
      { planId: plan._id, memberId: req.user._id },
      {
        $pull: { entries: { componentId } },
      }
    );
    await WorkoutPlanProgress.findOneAndUpdate(
      { planId: plan._id, memberId: req.user._id },
      {
        $push: { entries: { componentId, done, completedSets, notes: resolvedNotes } },
        $setOnInsert: { planId: plan._id, memberId: req.user._id },
      },
      { upsert: true }
    );

    const progressDoc = await WorkoutPlanProgress.findOne({ planId: plan._id, memberId: req.user._id });
    res.json({ success: true, data: attachProgress(plan, progressDoc) });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getMyAssignedPlans,
  getMyAssignedPlanDetail,
  updateProgress,
};