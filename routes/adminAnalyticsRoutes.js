const express = require('express');
const router = express.Router();
const analytics = require('../controllers/adminAnalyticsController');

router.get('/summary', analytics.summary);
router.get('/sales', analytics.salesByRange);
router.get('/export/csv', analytics.exportCSV);
router.get('/export/pdf', analytics.exportPDF);

module.exports = router;
