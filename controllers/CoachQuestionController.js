const { validationResult } = require('express-validator');
const CoachQuestion = require('../models/coachQuestion');

// All of these sit behind adminRoutes.js's router.use(protect, admin) —
// same pattern as coachController.js. Only an authenticated admin can
// create/edit/delete/enable/disable a registration question.

const getQuestions = async (req, res, next) => {
  try {
    // Admin management view sees every question, active or not, so
    // disabled questions can still be re-enabled/edited later. The
    // client-facing questionnaire (coachDirectoryController.getActiveQuestions)
    // is the one that filters to isActive: true.
    const questions = await CoachQuestion.find().sort({ order: 1, createdAt: 1 });
    res.json({ success: true, data: questions });
  } catch (error) {
    next(error);
  }
};

const createQuestion = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { question, type, options, isActive, order } = req.body;

    const question_ = await CoachQuestion.create({
      question,
      type: type || 'text',
      // Only 'choice'/'multi_choice' questions need options — dropping
      // them for 'text' keeps stray data from lingering on a later
      // type switch.
      options: type === 'choice' || type === 'multi_choice' ? (options || []) : [],
      isActive: isActive !== undefined ? !!isActive : true,
      order: order || 0,
    });

    res.status(201).json({ success: true, message: 'Question created', data: question_ });
  } catch (error) {
    next(error);
  }
};

const updateQuestion = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const question = await CoachQuestion.findById(req.params.id);
    if (!question) return res.status(404).json({ success: false, message: 'Question not found' });

    const { question: text, type, options, isActive, order } = req.body;
    if (text !== undefined) question.question = text;
    if (type !== undefined) question.type = type;
    if (options !== undefined) question.options = options;
    if (isActive !== undefined) question.isActive = !!isActive;
    if (order !== undefined) question.order = order;

    // Keep options consistent with the (possibly just-changed) type —
    // same reasoning as createQuestion.
    if (question.type === 'text') question.options = [];

    await question.save();
    res.json({ success: true, message: 'Question updated', data: question });
  } catch (error) {
    next(error);
  }
};

const deleteQuestion = async (req, res, next) => {
  try {
    const question = await CoachQuestion.findById(req.params.id);
    if (!question) return res.status(404).json({ success: false, message: 'Question not found' });

    // Hard delete. Existing CoachRegistrationRequest.answers keep their
    // own snapshotted `question` text (see the model comment), so past
    // submissions remain fully readable even after their source
    // question is removed.
    await question.deleteOne();
    res.json({ success: true, message: 'Question deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getQuestions, createQuestion, updateQuestion, deleteQuestion };
