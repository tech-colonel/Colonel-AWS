const { Op } = require('sequelize');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { markDone, markProgress, startRun, feedTick, completeRun, getState } = require('../../../utils/invoiceEvents');
const { addInvoiceId, clearExecution } = require('../../../utils/executionStore');

// Placeholder tokens the extractor writes when a field is empty — treat as missing.
// Defined once in invoiceMasterResolver and imported here so the resolver and the
// `status` derivation below can never disagree about what "missing" means.
const invoiceMasterResolver = require('../../../services/invoiceMasterResolver');
const { NA_TOKENS, isMissingField } = invoiceMasterResolver;

// ─── Helper: Parse Date ───────────────────────
const MONTH_MAP = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

const parseDate = (dString) => {
    if (!dString || dString === 'null' || dString === 'undefined' || String(dString).trim() === '') return null;
    const s = String(dString).trim();
    try {
        // Format: D-Mon-YY or DD-Mon-YYYY  e.g. "2-May-26", "15-Jan-2026"
        const nameMatch = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,9})[-\/\s](\d{2,4})$/);
        if (nameMatch) {
            const [, day, mon, yr] = nameMatch;
            const mm = MONTH_MAP[mon.toLowerCase().slice(0, 3)];
            if (mm) {
                const year = yr.length === 2 ? (parseInt(yr) >= 50 ? `19${yr}` : `20${yr}`) : yr;
                return new Date(`${year}-${mm}-${day.padStart(2, '0')}`);
            }
        }
        // Format: DD-MM-YYYY or DD/MM/YYYY
        const parts = s.split(/[-/]/);
        if (parts.length === 3 && parts[2].length === 4) {
            return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        }
        // ISO or other standard formats
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    } catch (err) {
        return null;
    }
};

// ─── Brand PAN checkpoint (self-learning, cross-brand via master brands table) ──
// On a PURCHASE invoice the buyer IS the brand, so buyer_gstin's PAN identifies the
// brand. We keep a learned {PAN: count} map per brand on brands.known_pans (master
// data → NOT RLS-scoped, unlike invoice_process). A PAN is OWNED by the brand that
// holds a strong majority (>= DOMINANCE) of its occurrences and >= MIN_OWN absolute —
// so a PAN has at most ONE owner (misfiled strays never win). Per incoming invoice:
//   • PAN owned by THIS brand → save
//   • PAN owned by ANOTHER brand → BLOCK (wrong brand — do not save here)
//   • PAN owned by nobody → learn it; flag "Needs Review" for an established brand,
//     stay silent while a brand-new brand is still bootstrapping its own PANs.
const MIN_OWN = 3;         // absolute floor to be considered an owner
const DOMINANCE = 0.8;     // owner must hold >= 80% of a PAN's occurrences
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const panOf = (gstin) => {
    if (!gstin) return null;
    const c = String(gstin).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (c.length < 15) return null;
    const p = c.substring(2, 12);
    return PAN_RE.test(p) ? p : null;
};
let _panCache = { at: 0, owner: null, names: null };
const PAN_CACHE_MS = 60000;
const getPanOwners = async () => {
    if (_panCache.owner && (Date.now() - _panCache.at) < PAN_CACHE_MS) return _panCache;
    const [rows] = await Brand.sequelize.query('SELECT id, name, known_pans FROM brands');
    const names = new Map();
    const perPan = new Map(); // PAN -> Map(brandId -> count)
    for (const r of rows) {
        names.set(r.id, r.name);
        const kp = r.known_pans || {};
        for (const [pan, cnt] of Object.entries(kp)) {
            const c = Number(cnt) || 0;
            if (c <= 0) continue;
            if (!perPan.has(pan)) perPan.set(pan, new Map());
            perPan.get(pan).set(r.id, c);
        }
    }
    const owner = new Map(); // PAN -> brandId (single dominant owner)
    for (const [pan, brandCounts] of perPan) {
        let total = 0, topId = null, topCnt = 0;
        for (const [bid, c] of brandCounts) { total += c; if (c > topCnt) { topCnt = c; topId = bid; } }
        if (topCnt >= MIN_OWN && total > 0 && (topCnt / total) >= DOMINANCE) owner.set(pan, topId);
    }
    _panCache = { at: Date.now(), owner, names };
    return _panCache;
};
// Increment THIS brand's learned counts for the PANs it legitimately received.
const learnPans = async (brandId, panCounts) => {
    if (!panCounts || !Object.keys(panCounts).length) return;
    try {
        const [rows] = await Brand.sequelize.query('SELECT known_pans FROM brands WHERE id = :bid', { replacements: { bid: brandId } });
        const kp = (rows && rows[0] && rows[0].known_pans) || {};
        for (const [p, c] of Object.entries(panCounts)) kp[p] = (Number(kp[p]) || 0) + c;
        await Brand.sequelize.query('UPDATE brands SET known_pans = CAST(:kp AS jsonb) WHERE id = :bid', { replacements: { kp: JSON.stringify(kp), bid: brandId } });
        _panCache.at = 0; // invalidate so freshly-learned PANs count on the next run
    } catch (e) {
        console.warn('[n8n feed] learnPans failed (non-fatal):', e.message);
    }
};

// ─── POST /api/n8n/invoice/feed ───────────────
const feedInvoicesFromN8n = async (req, res, next) => {
    try {
        // ─── Debug logging (helps diagnose n8n payload shape) ──────────
        console.log('[n8n feed] --- New Request Received ---');
        console.log('[n8n feed] req.query:', JSON.stringify(req.query));
        console.log('[n8n feed] req.body type:', typeof req.body, Array.isArray(req.body) ? `Array(len=${req.body.length})` : 'Object');
        if (req.body && !Array.isArray(req.body)) {
            console.log('[n8n feed] req.body keys:', Object.keys(req.body));
            console.log('[n8n feed] req.body (first 500 chars):', JSON.stringify(req.body).slice(0, 500));
        } else if (Array.isArray(req.body) && req.body.length > 0) {
            console.log('[n8n feed] req.body[0] keys:', Object.keys(req.body[0]));
            console.log('[n8n feed] req.body[0] (first 500 chars):', JSON.stringify(req.body[0]).slice(0, 500));
        }

        // ─── Extract brandId / agentId from every possible location ────
        // n8n might send: query params, body root, body.processed_invoices[0], or body[0]
        const brandId =
            req.query.brandId ||
            req.query.brand_id ||
            req.body.brandId ||
            req.body.brandid ||
            req.body.brand_id ||
            (Array.isArray(req.body)
                ? (req.body[0]?.brandId || req.body[0]?.brandid || req.body[0]?.brand_id)
                : (req.body.processed_invoices?.[0]?.brandId || req.body.processed_invoices?.[0]?.brand_id));

        const agentId =
            req.query.agentId ||
            req.query.agent_id ||
            req.body.agentId ||
            req.body.agentid ||
            req.body.agent_id ||
            (Array.isArray(req.body)
                ? (req.body[0]?.agentId || req.body[0]?.agentid || req.body[0]?.agent_id)
                : (req.body.processed_invoices?.[0]?.agentId || req.body.processed_invoices?.[0]?.agent_id));

        // ─── Also extract name-based identifiers (n8n may send names not UUIDs) ──
        const brandName =
            req.query.brandName ||
            req.query.brand_name ||
            req.body.brandName ||
            req.body.brand_name ||
            (Array.isArray(req.body)
                ? (req.body[0]?.brandName || req.body[0]?.brand_name)
                : (req.body.processed_invoices?.[0]?.brandName || req.body.processed_invoices?.[0]?.brand_name));

        const agentName =
            req.query.agentName ||
            req.query.agent_name ||
            req.body.agentName ||
            req.body.agent_name ||
            (Array.isArray(req.body)
                ? (req.body[0]?.agentName || req.body[0]?.agent_name)
                : (req.body.processed_invoices?.[0]?.agentName || req.body.processed_invoices?.[0]?.agent_name));

        console.log('[n8n feed] Extracted -> brandId:', brandId, '| agentId:', agentId);
        console.log('[n8n feed] Extracted -> brandName:', brandName, '| agentName:', agentName);

        // ─── Extract invoice array ──────────────────────────────────────
        // n8n stamps every POST of one execution with the same `$execution.id`, so
        // rows written across the many per-line-item calls of a single run share a
        // run_id. That is what "Latest run" filters on. Older rows (and any caller
        // that doesn't send it) stay NULL and are only reachable via "All data".
        const runId = String(
            req.query.run_id || req.body.run_id ||
            (Array.isArray(req.body)
                ? (req.body[0] && req.body[0].run_id)
                : (req.body.processed_invoices && req.body.processed_invoices[0]
                    && req.body.processed_invoices[0].run_id)) || ''
        ).trim() || null;

        let processed_invoices = [];
        if (Array.isArray(req.body)) {
            processed_invoices = req.body;
        } else if (req.body && Array.isArray(req.body.processed_invoices)) {
            processed_invoices = req.body.processed_invoices;
        }

        // ─── Validations ───────────────────────────────────────────────
        if (!brandId && !brandName) {
            return res.status(400).json({
                error: 'brandId or brandName is required. Supports: brandId, brandid, brand_id, brandName, brand_name in query or body.'
            });
        }

        if (!agentId && !agentName) {
            return res.status(400).json({
                error: 'agentId or agentName is required. Supports: agentId, agentid, agent_id, agentName, agent_name in query or body.'
            });
        }

        if (!Array.isArray(processed_invoices)) {
            return res.status(400).json({
                error: 'Invalid payload. Expected an array or { "processed_invoices": [...] }'
            });
        }

        if (processed_invoices.length === 0) {
            markDone(brandId || brandName, agentId || agentName, 0, 0);
            return res.json({
                success: true,
                message: 'No invoices to process',
                count: 0,
                corrupted: 0,
                data: []
            });
        }

        // ─── Fetch Master Data (UUID first, then name fallback) ────────
        let brand = brandId ? await Brand.findByPk(brandId) : null;
        if (!brand && brandName) {
            brand = await Brand.findOne({ where: { name: { [Op.iLike]: brandName } } });
            console.log('[n8n feed] UUID lookup failed, name fallback ->', brand ? `Found: ${brand.id}` : 'NOT FOUND');
        }

        let agent = agentId ? await Agent.findByPk(agentId) : null;
        if (!agent && agentName) {
            agent = await Agent.findOne({ where: { name: { [Op.iLike]: agentName } } });
            console.log('[n8n feed] UUID lookup failed, name fallback ->', agent ? `Found: ${agent.id}` : 'NOT FOUND');
        }

        if (!brand || !agent) {
            console.error(`[n8n feed] ❌ Not found. brandId=${brandId}, brandName=${brandName}, brandFound=${!!brand} | agentId=${agentId}, agentName=${agentName}, agentFound=${!!agent}`);
            return res.status(404).json({
                error: 'Brand or Agent not found',
                detail: {
                    brandId, brandName, brandFound: !!brand,
                    agentId, agentName, agentFound: !!agent
                }
            });
        }

        // Use resolved IDs for everything downstream (SSE keys, execution store)
        const resolvedBrandId = brand.id;
        const resolvedAgentId = agent.id;
        console.log(`[n8n feed] ✅ Resolved -> brand: ${brand.name} (${resolvedBrandId}) | agent: ${agent.name} (${resolvedAgentId})`);

        // ─── Dynamic DB + Model ────────────────────────────────────────
        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const InvoiceModel = getDynamicModel(brandDb, tableName, agent.columns);
        await InvoiceModel.sync({ alter: false });

        // ─── Data Mapping: split valid vs corrupted ────────────────────
        const corruptedRows = [];
        const validRows = [];

        processed_invoices.forEach((row) => {
            const isMissingCritical = !row.product_name || !row.invoice_number || !row.invoice_date;
            if (isMissingCritical) {
                corruptedRows.push({
                    processed_on: new Date(),
                    run_id: runId,
                    company: row.company || null,
                    vendor_name_tally: row.vendor_name_tally || null,
                    invoice_number: row.invoice_number || null,
                    invoice_date: parseDate(row.invoice_date),
                    due_date: parseDate(row.due_date),
                    seller_gstin: row.seller_gstin || null,
                    buyer_gstin: row.buyer_gstin || null,
                    voucher_type: row.voucher_type || null,
                    category: row.category || null,
                    product_name: row.product_name || null,
                    tds_section: row.tds_section || null,
                    tds_rate: parseFloat(row.tds_rate) || 0,
                    tds_amount: parseFloat(row.tds_amount) || 0,
                    invoice_link: row.Invoice_link || row.invoice_link || null,
                    // Scanned / image-based PDF that n8n could not extract → needs manual entry
                    status: 'Invalid'
                });
            } else {
                validRows.push(row);
            }
        });

        // ─── Brand checkpoint: keep only invoices that belong to THIS brand ─────
        // Reject invoices whose buyer PAN is positively owned by ANOTHER brand
        // (wrong-brand run — e.g. Baynine files dropped into Stroom's folder).
        const { owner: panOwner, names: brandNames } = await getPanOwners();
        const brandEstablished = [...panOwner.values()].some((id) => id === resolvedBrandId);
        const blockedRows = [];
        const savableRows = [];
        const learnCounts = {};
        let wrongBrandName = null;
        validRows.forEach((row) => {
            const p = panOf(row.buyer_gstin);
            const ownerId = p ? panOwner.get(p) : null;
            if (ownerId && ownerId !== resolvedBrandId) {
                wrongBrandName = brandNames.get(ownerId) || 'another brand';
                blockedRows.push(row);
                return;
            }
            if (p) learnCounts[p] = (learnCounts[p] || 0) + 1;   // own / unknown → learn
            // Flag a stranger PAN ONLY for an established brand — a brand-new brand is
            // still bootstrapping its own PANs, so don't nag its first batches.
            row.__brandFlag = (brandEstablished && !ownerId) ? 'Needs Review' : null;
            savableRows.push(row);
        });
        if (blockedRows.length) {
            console.warn(`[n8n feed] 🛑 Blocked ${blockedRows.length} invoice(s) belonging to ${wrongBrandName}, not ${brand.name} (${resolvedBrandId})`);
        }

        // Fill values n8n returned as "N/A" from masters an accountant taught us.
        // Placed HERE deliberately: after brand resolution (brandDb already carries
        // app.brand_id, so RLS scopes the master reads) and after the PAN guard (a
        // misfiled invoice is already in blockedRows and can never be scored against
        // another brand's master) — but BEFORE the `status` derivation below, which
        // reads the raw row. Hence it mutates rows in place, like row.__brandFlag above.
        //
        // Fail-open: this handler is the single ingestion choke point for all 12
        // brands, so a throw here would become a 500 and a lost line item.
        // No-op unless this brand is on INVOICE_MASTER_RESOLVER_BRANDS; default
        // mode is 'shadow', which logs what it would fill and writes nothing.
        try {
            await invoiceMasterResolver.resolveRowsInPlace(brandDb, resolvedBrandId, savableRows);
        } catch (e) {
            console.warn('[n8n feed] master resolve failed (non-fatal):', e.message);
        }

        const finalData = savableRows.map((row) => ({
            processed_on: new Date(),
            run_id: runId,
            company: row.company || null,
            vendor_name_tally: row.vendor_name_tally || null,
            invoice_number: row.invoice_number || null,
            invoice_date: parseDate(row.invoice_date),
            due_date: parseDate(row.due_date),
            seller_gstin: row.seller_gstin || null,
            buyer_gstin: row.buyer_gstin || null,
            voucher_type: row.voucher_type || null,
            category: row.category || null,
            product_name: row.product_name || null,
            hsn_code: row.hsn_code || null,
            batch_no: row.batch_no || null,
            quantity: parseInt(row.quantity) || 0,
            unit: row.unit || null,
            rate: parseFloat(row.rate) || 0,
            cgst_rate: parseFloat(row.cgst_rate) || 0,
            sgst_rate: parseFloat(row.sgst_rate) || 0,
            igst_rate: parseFloat(row.igst_rate) || 0,
            cgst_amount: parseFloat(row.cgst_amount) || 0,
            sgst_amount: parseFloat(row.sgst_amount) || 0,
            igst_amount: parseFloat(row.igst_amount) || 0,
            gst_amount: parseFloat(row.GST_AMOUNT || row.gst_amount) || 0,
            taxable_value: parseFloat(row['taxable value'] || row.taxable_value || row.amount) || 0,
            tds_section: row.tds_section || null,
            tds_rate: parseFloat(row.tds_rate) || 0,
            tds_amount: parseFloat(row.tds_amount) || 0,
            invoice_link: row.Invoice_link || row.invoice_link || null,
            // Auto-approve fully-done invoices; only those still missing the Tally vendor
            // name + category (accountant hasn't updated the vendor master) need review.
            // "N/A"/"Missing" placeholders count as missing. A stranger buyer-PAN on an
            // established brand also forces review (row.__brandFlag).
            status: row.__brandFlag
                || ((isMissingField(row.vendor_name_tally) && isMissingField(row.category)) ? 'Needs Review' : 'Approved')
        }));

        // ─── Dedupe: skip line items that already exist ────────────────
        // Re-processing the SAME invoice (a re-run, or a repeated test) must not
        // pile up duplicate rows. Match a line by its natural identity; invalid /
        // unextracted rows key on the SOURCE FILE so two different failed PDFs are
        // never collapsed. Pure skip (no deletes) — safe even though n8n feeds one
        // line item per call, and idempotent across runs.
        const _dk = (r) => {
            const inv = String(r.invoice_number || '').trim().toLowerCase();
            if (!inv || inv === 'invalid') return 'file::' + String(r.invoice_link || '').trim().toLowerCase();
            return [inv, String(r.company || '').trim().toLowerCase(), String(r.product_name || '').trim().toLowerCase(),
                Number(r.taxable_value) || 0, Number(r.gst_amount) || 0].join('|');
        };
        let existingKeys = new Set();
        try {
            const incomingInvNos = [...new Set([...finalData, ...corruptedRows].map((r) => r.invoice_number).filter(Boolean))];
            if (incomingInvNos.length) {
                const existing = await InvoiceModel.findAll({ where: { invoice_number: incomingInvNos }, raw: true });
                existingKeys = new Set(existing.map(_dk));
            }
        } catch (e) { console.warn('[n8n feed] dedupe lookup failed (non-fatal):', e.message); }
        const dedupFinal = finalData.filter((r) => !existingKeys.has(_dk(r)));
        const dedupCorrupt = corruptedRows.filter((r) => !existingKeys.has(_dk(r)));
        const _skipped = (finalData.length - dedupFinal.length) + (corruptedRows.length - dedupCorrupt.length);
        if (_skipped) console.log(`[n8n feed] ⏭️  Skipped ${_skipped} duplicate line item(s) already present.`);

        // ─── Insert Data ───────────────────────────────────────────────
        const validResult = await InvoiceModel.bulkCreate(dedupFinal, { returning: true });
        const corruptedResult = await InvoiceModel.bulkCreate(dedupCorrupt, { returning: true });
        [...validResult, ...corruptedResult].forEach((row) => addInvoiceId(resolvedBrandId, resolvedAgentId, row.id));

        // ─── Accumulate live progress across per-invoice feed calls ─────
        // (This workflow calls the feed once per invoice inside a loop, so we
        //  tally cumulatively; completion fires on the n8n 'done' ping or the
        //  debounce fallback — NOT on every single call.)
        const reviewCount = finalData.filter((r) => r.status === 'Needs Review').length;
        const approvedCount = validResult.length - reviewCount;
        // n8n sends batch_total (total invoices in this run) on every feed call, so the
        // first feed already gives the correct "of N" denominator.
        const batchTotal = Number(
            req.query.batch_total || req.body.batch_total ||
            (Array.isArray(req.body) ? (req.body[0] && req.body[0].batch_total)
                : (req.body.processed_invoices && req.body.processed_invoices[0] && req.body.processed_invoices[0].batch_total))
        ) || 0;
        // Feed live progress by DISTINCT invoice (not line-item rows). n8n loops per
        // line item, so one invoice can span several feed calls — dedupe by
        // invoice_number (fallback: Drive file link) so "X of N" counts invoices.
        const feedItems = [
            ...finalData.map((r) => ({ invoice_number: r.invoice_number, invoice_link: r.invoice_link, status: r.status })),
            ...corruptedRows.map((r) => ({ invoice_number: r.invoice_number, invoice_link: r.invoice_link, status: 'Invalid' })),
            // Blocked (wrong-brand) rows are NOT saved, but still count toward "of N" and
            // surface in the run summary so the accountant sees they were skipped.
            ...blockedRows.map((r) => ({ invoice_number: r.invoice_number, invoice_link: r.Invoice_link || r.invoice_link, status: 'Wrong Brand' })),
        ];
        feedTick(resolvedBrandId, resolvedAgentId, { items: feedItems, total: batchTotal, wrongBrandName });
        clearExecution(resolvedBrandId, resolvedAgentId);

        // Learn the buyer PANs this brand legitimately received (self-updating ownership).
        await learnPans(resolvedBrandId, learnCounts);

        console.log(`[n8n feed] ✅ Fed. +Approved: ${approvedCount}, +Needs Review: ${reviewCount}, +Invalid: ${corruptedResult.length}, 🛑 Blocked(wrong-brand): ${blockedRows.length}`);

        // ─── Response ──────────────────────────────────────────────────
        res.json({
            success: true,
            message: blockedRows.length
                ? `Stored ${validResult.length}; blocked ${blockedRows.length} belonging to ${wrongBrandName}`
                : 'Invoices stored successfully via n8n feed',
            count: validResult.length,
            corrupted: corruptedResult.length,
            blocked: blockedRows.length,
            wrongBrand: wrongBrandName || null,
            data: [...validResult, ...corruptedResult]
        });

    } catch (error) {
        console.error('❌ Invoice Feed Error:', error);
        next(error);
    }
};

// ─── Live per-invoice progress ping (called by n8n as each invoice lands) ──────
// n8n should POST this once per invoice it finishes writing to the sheet:
//   POST /api/n8n/progress  { brandName|brandId, agentName|agentId, done, total }
// (or send { increment: true, total } to bump the running counter by one).
// This drives the genuine "X of N done" counter — the numbers are always the
// real values n8n sends, never fabricated.
const progressFromN8n = async (req, res, next) => {
    try {
        const src = Array.isArray(req.body) ? (req.body[0] || {}) : (req.body || {});
        const q = req.query || {};

        const brandId = q.brandId || q.brand_id || src.brandId || src.brandid || src.brand_id;
        const agentId = q.agentId || q.agent_id || src.agentId || src.agentid || src.agent_id;
        const brandName = q.brandName || q.brand_name || src.brandName || src.brand_name;
        const agentName = q.agentName || q.agent_name || src.agentName || src.agent_name;

        let brand = brandId ? await Brand.findByPk(brandId) : null;
        if (!brand && brandName) brand = await Brand.findOne({ where: { name: { [Op.iLike]: brandName } } });
        let agent = agentId ? await Agent.findByPk(agentId) : null;
        if (!agent && agentName) agent = await Agent.findOne({ where: { name: { [Op.iLike]: agentName } } });

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found', detail: { brandId, brandName, agentId, agentName } });
        }

        const phase = String(q.phase || src.phase || '').toLowerCase();
        const total = Number(q.total || src.total || 0) || 0;

        // phase=start → reset the run and set the known total (so the UI shows "of N")
        if (phase === 'start') {
            startRun(brand.id, agent.id, total);
            return res.json({ success: true, phase: 'start', total });
        }
        // phase=done/complete → finish the run and emit the cumulative summary
        if (phase === 'done' || phase === 'complete') {
            completeRun(brand.id, agent.id);
            return res.json({ success: true, phase: 'done' });
        }

        // manual/testing tick — absolute done/total if provided, else +1 increment
        let done;
        if (q.done !== undefined || src.done !== undefined) {
            done = Number(q.done !== undefined ? q.done : src.done) || 0;
            markProgress(brand.id, agent.id, done, total);
        } else {
            feedTick(brand.id, agent.id, { approved: 1 });
            done = (getState(brand.id, agent.id).done) || 0;
        }
        return res.json({ success: true, done, total });
    } catch (error) {
        console.error('❌ Invoice Progress Error:', error);
        next(error);
    }
};

module.exports = {
    feedInvoicesFromN8n,
    progressFromN8n
};