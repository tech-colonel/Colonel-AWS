const express = require('express');

const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const {
  saveCorrections, getDirectory, deleteDirectoryEntry, getLedgers,
} = require('../controllers/creditCardController');

const auth = [authenticateToken, authorize('accountant', 'admin')];

// Reviewer fixes from the Working grid — persisted AND folded into the
// per-brand learned directory so the next statement books itself.
router.post('/:brandId/corrections', ...auth, saveCorrections);

// Chart of accounts for the review grid's ledger picker.
router.get('/:brandId/ledgers', ...auth, getLedgers);

// Inspect / prune what this brand has learned.
router.get('/:brandId/directory', ...auth, getDirectory);
router.delete('/:brandId/directory/:id', ...auth, deleteDirectoryEntry);

module.exports = router;
