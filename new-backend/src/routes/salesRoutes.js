const express = require('express');
const router = express.Router();
const multer = require('multer');
const { flipkart, getWorkingFiles, deleteWorkingFile, downloadWorkingFile, addSkuMasterSingle, addMasterEntry, deleteSkuMasterSingle, getMasterDataAny, deleteMasterEntry, clearMasterEntries } = require('../controllers/salesController');
const salesAmazonController = require('../controllers/agents/sales-amazon/salesAmazonController');
const salesMyntraController = require('../controllers/agents/sales-myntra/salesMyntraController');
const salesShopifyController = require('../controllers/agents/sales-shopify/salesShopifyController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { reattachUserContext } = require('../utils/requestContext');

const upload = multer({ storage: multer.memoryStorage() });

// ─── Shared / Generic Working File Routes ─────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/working-files', authenticateToken, getWorkingFiles);
router.delete('/brands/:brandId/agents/:agentId/working-files/:fileId', authenticateToken, deleteWorkingFile);
router.get('/brands/:brandId/agents/:agentId/working-files/:fileId/download', authenticateToken, downloadWorkingFile);

// ─── Shared SKU Single Entry Routes (agent-agnostic) ──────────────────────────
router.post('/brands/:brandId/agents/:agentId/master/sku/add', authenticateToken, addSkuMasterSingle);
router.delete('/brands/:brandId/agents/:agentId/master/sku/delete', authenticateToken, deleteSkuMasterSingle);

// ─── Shared Master Data Routes (agent-agnostic, any sales portal) ────────────
// Used by the admin Brand Overview page to list + delete individual SKU/Ledger
// master rows, regardless of which portal-specific slug the agent uses.
router.get('/brands/:brandId/agents/:agentId/master', authenticateToken, getMasterDataAny);
router.post('/brands/:brandId/agents/:agentId/master/:type/add-entry', authenticateToken, addMasterEntry);
router.delete('/brands/:brandId/agents/:agentId/master/entry/:type/:index', authenticateToken, deleteMasterEntry);
router.delete('/brands/:brandId/agents/:agentId/master/:type/clear-all', authenticateToken, clearMasterEntries);

// ─── Amazon Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/amazon/master', authenticateToken, salesAmazonController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/amazon/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesAmazonController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/amazon/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesAmazonController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/amazon/generate', authenticateToken, upload.single('file'), reattachUserContext, salesAmazonController.generate);

const misController = require('../controllers/agents/common/misController');

// Two-phase generation: preview → verify → commit/discard
router.post('/brands/:brandId/agents/:agentId/amazon/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesAmazonController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/amazon/generate/commit',  authenticateToken, salesAmazonController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/amazon/generate/discard', authenticateToken, salesAmazonController.generateDiscard);

router.post('/brands/:brandId/agents/:agentId/amazon/mis', authenticateToken, misController.generateAmazonMIS);


// ─── Flipkart Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/flipkart/master', authenticateToken, flipkart.getMasterData);
router.post('/brands/:brandId/agents/:agentId/flipkart/master/sku', authenticateToken, upload.single('file'), reattachUserContext, flipkart.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/flipkart/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, flipkart.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/flipkart/generate', authenticateToken, upload.single('file'), reattachUserContext, flipkart.generate);

// Two-phase generation: preview → verify → commit/discard
router.post('/brands/:brandId/agents/:agentId/flipkart/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, flipkart.generatePreview);
router.post('/brands/:brandId/agents/:agentId/flipkart/generate/commit',  authenticateToken, flipkart.generateCommit);
router.post('/brands/:brandId/agents/:agentId/flipkart/generate/discard', authenticateToken, flipkart.generateDiscard);

const salesBlinkitController = require('../controllers/agents/sales-blinkit/salesBlinkitController');

// ─── Myntra Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/myntra/master', authenticateToken, salesMyntraController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/myntra/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesMyntraController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/myntra/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesMyntraController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/myntra/master/hsn', authenticateToken, upload.single('file'), reattachUserContext, salesMyntraController.uploadHsnMaster);
router.post('/brands/:brandId/agents/:agentId/myntra/generate', authenticateToken, upload.fields([
    { name: 'rtoFile', maxCount: 1 },
    { name: 'packedFile', maxCount: 1 },
    { name: 'rtFile', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), reattachUserContext, salesMyntraController.generate);

router.post('/brands/:brandId/agents/:agentId/myntra/generate/preview', authenticateToken, upload.fields([
    { name: 'rtoFile', maxCount: 1 },
    { name: 'packedFile', maxCount: 1 },
    { name: 'rtFile', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), reattachUserContext, salesMyntraController.generatePreview);

router.post('/brands/:brandId/agents/:agentId/myntra/generate/commit', authenticateToken, salesMyntraController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/myntra/generate/discard', authenticateToken, salesMyntraController.generateDiscard);

// ─── Blinkit Routes ────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/blinkit/master', authenticateToken, salesBlinkitController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/blinkit/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesBlinkitController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/blinkit/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesBlinkitController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/blinkit/generate', authenticateToken, upload.single('file'), reattachUserContext, salesBlinkitController.generate);

router.post('/brands/:brandId/agents/:agentId/blinkit/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesBlinkitController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/blinkit/generate/commit', authenticateToken, salesBlinkitController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/blinkit/generate/discard', authenticateToken, salesBlinkitController.generateDiscard);

const salesFirstcryController = require('../controllers/agents/sales-firstcry/salesFirstcryController');
const salesJiomartController = require('../controllers/agents/sales-jiomart/salesJiomartController');

// ─── FirstCry Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/firstcry/master', authenticateToken, salesFirstcryController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/firstcry/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesFirstcryController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/firstcry/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesFirstcryController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/firstcry/generate', authenticateToken, upload.single('file'), reattachUserContext, salesFirstcryController.generate);

router.post('/brands/:brandId/agents/:agentId/firstcry/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesFirstcryController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/firstcry/generate/commit', authenticateToken, salesFirstcryController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/firstcry/generate/discard', authenticateToken, salesFirstcryController.generateDiscard);

// ─── JioMart Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/jiomart/master', authenticateToken, salesJiomartController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/jiomart/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesJiomartController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/jiomart/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesJiomartController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/jiomart/generate', authenticateToken, upload.single('file'), reattachUserContext, salesJiomartController.generate);

router.post('/brands/:brandId/agents/:agentId/jiomart/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesJiomartController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/jiomart/generate/commit', authenticateToken, salesJiomartController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/jiomart/generate/discard', authenticateToken, salesJiomartController.generateDiscard);

const salesTatacliqController = require('../controllers/agents/sales-tatacliq/salesTatacliqController');

// ─── Tata Cliq Routes ──────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/tatacliq/master', authenticateToken, salesTatacliqController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/tatacliq/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesTatacliqController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/tatacliq/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesTatacliqController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/tatacliq/generate', authenticateToken, upload.single('file'), reattachUserContext, salesTatacliqController.generate);

router.post('/brands/:brandId/agents/:agentId/tatacliq/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesTatacliqController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/tatacliq/generate/commit', authenticateToken, salesTatacliqController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/tatacliq/generate/discard', authenticateToken, salesTatacliqController.generateDiscard);

// ─── Shopify Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/shopify/master', authenticateToken, salesShopifyController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/shopify/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesShopifyController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/shopify/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesShopifyController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/shopify/generate', authenticateToken, upload.single('file'), reattachUserContext, salesShopifyController.generate);

router.post('/brands/:brandId/agents/:agentId/shopify/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesShopifyController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/shopify/generate/commit', authenticateToken, salesShopifyController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/shopify/generate/discard', authenticateToken, salesShopifyController.generateDiscard);

const salesZeptoController = require('../controllers/agents/sales-zepto/salesZeptoController');

// ─── Zepto Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/zepto/master', authenticateToken, salesZeptoController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/zepto/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesZeptoController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/zepto/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesZeptoController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/zepto/generate', authenticateToken, upload.single('file'), reattachUserContext, salesZeptoController.generate);

router.post('/brands/:brandId/agents/:agentId/zepto/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesZeptoController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/zepto/generate/commit', authenticateToken, salesZeptoController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/zepto/generate/discard', authenticateToken, salesZeptoController.generateDiscard);

const salesNykaaController = require('../controllers/agents/sales-nykaa/salesNykaaController');

// ─── Nykaa Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/nykaa/master', authenticateToken, salesNykaaController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/nykaa/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesNykaaController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/nykaa/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesNykaaController.uploadLedgerMaster);

// Two-phase generation: upload cycle1File + cycle2File → preview → commit/discard
router.post('/brands/:brandId/agents/:agentId/nykaa/generate/preview', authenticateToken, upload.fields([
    { name: 'cycle1File', maxCount: 1 },   // May_01_15 (1–15 cycle)
    { name: 'cycle2File', maxCount: 1 },   // May_16_30 (16–30 cycle)
]), reattachUserContext, salesNykaaController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/nykaa/generate/commit',  authenticateToken, salesNykaaController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/nykaa/generate/discard', authenticateToken, salesNykaaController.generateDiscard);

const salesPepperfryController = require('../controllers/agents/sales-pepperfry/salesPepperfryController');

// ─── Pepperfry Routes ──────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/pepperfry/master', authenticateToken, salesPepperfryController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/pepperfry/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesPepperfryController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/pepperfry/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesPepperfryController.uploadLedgerMaster);

// Two-phase generation: upload salesFile (GSTR-1 Sales) + refundFile (GSTR-1 Refunds) → preview → commit/discard
router.post('/brands/:brandId/agents/:agentId/pepperfry/generate/preview', authenticateToken, upload.fields([
    { name: 'salesFile', maxCount: 1 },
    { name: 'refundFile', maxCount: 1 },
]), reattachUserContext, salesPepperfryController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/pepperfry/generate/commit',  authenticateToken, salesPepperfryController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/pepperfry/generate/discard', authenticateToken, salesPepperfryController.generateDiscard);

const totalSalesController = require('../controllers/agents/total-sales/totalSalesController');

// ─── Total Sales Routes ────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/total-sales-analyzer/master', authenticateToken, totalSalesController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/total-sales-analyzer/master/sku', authenticateToken, upload.single('file'), reattachUserContext, totalSalesController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/total-sales-analyzer/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, totalSalesController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/total-sales-analyzer/generate', authenticateToken, upload.single('file'), reattachUserContext, totalSalesController.generatePreview); // Use generatePreview for standard generate as well

router.post('/brands/:brandId/agents/:agentId/total-sales-analyzer/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, totalSalesController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/total-sales-analyzer/generate/commit', authenticateToken, totalSalesController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/total-sales-analyzer/generate/discard', authenticateToken, totalSalesController.generateDiscard);
router.post('/brands/:brandId/agents/:agentId/total-sales-analyzer/dashboard', authenticateToken, totalSalesController.getDashboardData);

const salesMirrowController = require('../controllers/agents/sales-mirrow/salesMirrowController');
const salesCreadController = require('../controllers/agents/sales-cread/salesCreadController');
const salesLimeroadController = require('../controllers/agents/sales-limeroad/salesLimeroadController');
const salesVareeController = require('../controllers/agents/sales-varee/salesVareeController');

// ─── Mirrow Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/mirrow/master', authenticateToken, salesMirrowController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/mirrow/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesMirrowController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/mirrow/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesMirrowController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/mirrow/generate', authenticateToken, upload.single('file'), reattachUserContext, salesMirrowController.generate);

router.post('/brands/:brandId/agents/:agentId/mirrow/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesMirrowController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/mirrow/generate/commit', authenticateToken, salesMirrowController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/mirrow/generate/discard', authenticateToken, salesMirrowController.generateDiscard);

// ─── cread Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/cread/master', authenticateToken, salesCreadController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/cread/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesCreadController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/cread/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesCreadController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/cread/generate', authenticateToken, upload.single('file'), reattachUserContext, salesCreadController.generate);

router.post('/brands/:brandId/agents/:agentId/cread/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesCreadController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/cread/generate/commit', authenticateToken, salesCreadController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/cread/generate/discard', authenticateToken, salesCreadController.generateDiscard);

// ─── LimeRoad Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/limeroad/master', authenticateToken, salesLimeroadController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/limeroad/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesLimeroadController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/limeroad/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesLimeroadController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/limeroad/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesLimeroadController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/limeroad/generate/commit',  authenticateToken, salesLimeroadController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/limeroad/generate/discard', authenticateToken, salesLimeroadController.generateDiscard);

// ─── Vaaree Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/varee/master', authenticateToken, salesVareeController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/varee/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesVareeController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/varee/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesVareeController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/varee/generate', authenticateToken, upload.single('file'), reattachUserContext, salesVareeController.generate);

router.post('/brands/:brandId/agents/:agentId/varee/generate/preview', authenticateToken, upload.single('file'), reattachUserContext, salesVareeController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/varee/generate/commit', authenticateToken, salesVareeController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/varee/generate/discard', authenticateToken, salesVareeController.generateDiscard);

const salesMeeshoController = require('../controllers/agents/sales-meesho/salesMeeshoController');

// ─── Meesho Routes ─────────────────────────────────────────────────────────────
// Two input files: salesFile (tcs_sales) + returnFile (tcs_sales_return).
const meeshoUpload = upload.fields([
    { name: 'salesFile', maxCount: 1 },
    { name: 'returnFile', maxCount: 1 },
]);

router.get('/brands/:brandId/agents/:agentId/meesho/master', authenticateToken, salesMeeshoController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/meesho/master/sku', authenticateToken, upload.single('file'), reattachUserContext, salesMeeshoController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/meesho/master/ledger', authenticateToken, upload.single('file'), reattachUserContext, salesMeeshoController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/meesho/generate', authenticateToken, meeshoUpload, reattachUserContext, salesMeeshoController.generate);

router.post('/brands/:brandId/agents/:agentId/meesho/generate/preview', authenticateToken, meeshoUpload, reattachUserContext, salesMeeshoController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/meesho/generate/commit', authenticateToken, salesMeeshoController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/meesho/generate/discard', authenticateToken, salesMeeshoController.generateDiscard);

module.exports = router;
