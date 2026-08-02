const express = require('express');
const router = express.Router();
const analytics = require('../controllers/adminAnalyticsController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');

// This route exposes revenue totals, member PII (names/emails), and raw
// payment exports (CSV/PDF) — it must never be reachable without a valid
// admin session. Previously had no auth middleware at all.
router.use(protect, admin);

router.get('/summary', analytics.summary);
router.get('/sales', analytics.salesByRange);
router.get('/export/csv', analytics.exportCSV);
router.get('/export/pdf', analytics.exportPDF);

module.exports = router;