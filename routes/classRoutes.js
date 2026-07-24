const express = require('express');
const router = express.Router();
const classCtrl = require('../controllers/classController');

router.post('/', classCtrl.createClass);
router.get('/', classCtrl.getClasses);
router.get('/:id', classCtrl.getClass);
router.put('/:id', classCtrl.updateClass);
router.delete('/:id', classCtrl.deleteClass);
router.post('/:id/register', classCtrl.registerMember);
router.post('/:id/cancel', classCtrl.cancelRegistration);

module.exports = router;
