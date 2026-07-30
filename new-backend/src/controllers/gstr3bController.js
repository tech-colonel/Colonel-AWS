const path = require('path');
const fs = require('fs');
const { getBrandConnection } = require('../config/database');
const { Brand } = require('../models/master');
const drive = require('../services/driveService');

// Guess a mimetype from a filename extension (for Drive-sourced files).
const mimeForName = (name) => {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (n.endsWith('.xls')) return 'application/vnd.ms-excel';
  return 'application/octet-stream';
};

const PYTHON_URL = process.env.PYTHON_RECO_URL || 'http://localhost:8765';
const OUTPUT_DIR = path.join(__dirname, '../../output/gstr3b');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── DB helpers ────────────────────────────────────────────────────────────────

const withBypass = async (seq, fn) => {
  return seq.transaction(async (t) => {
    await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    return fn(t);
  });
};

const ensureTables = async (seq) => {
  try {
    await withBypass(seq, async (t) => {
      await seq.query(`
        CREATE TABLE IF NOT EXISTS gstr3b_coa_master (
          id SERIAL PRIMARY KEY,
          brand_id UUID NOT NULL,
          ledger_name VARCHAR(300) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT gstr3b_coa_uq UNIQUE (brand_id, ledger_name)
        )`, { transaction: t });
      await seq.query(`
        CREATE TABLE IF NOT EXISTS gstr3b_vt_master (
          id SERIAL PRIMARY KEY,
          brand_id UUID NOT NULL,
          voucher_name VARCHAR(200) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT gstr3b_vt_uq UNIQUE (brand_id, voucher_name)
        )`, { transaction: t });
      await seq.query(`
        CREATE TABLE IF NOT EXISTS gstr3b_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          brand_id UUID NOT NULL,
          job_id VARCHAR(100),
          period TEXT,
          excel_path VARCHAR(500),
          total_entries INT DEFAULT 0,
          total_debit NUMERIC(18,2) DEFAULT 0,
          total_credit NUMERIC(18,2) DEFAULT 0,
          monthly_data JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`, { transaction: t });
    });
  } catch (_) { /* tables may already exist */ }
};

// ── Upload + run ──────────────────────────────────────────────────────────────

const upload = async (req, res) => {
  try {
    const { brandId } = req.params;
    const files = req.files || {};

    // "From Drive": body.drive = { slotKey: [{fileId,name}] } → download via the
    // service account and merge into the files object (keyed by fieldname), so the
    // rest of this handler works unchanged. Alternate file SOURCE only.
    if (req.body && req.body.drive) {
      let driveSel;
      try { driveSel = JSON.parse(req.body.drive); } catch (_) { driveSel = null; }
      if (driveSel && typeof driveSel === 'object') {
        for (const [slotKey, items] of Object.entries(driveSel)) {
          files[slotKey] = files[slotKey] || [];
          for (const it of (Array.isArray(items) ? items : [items])) {
            if (!it || !it.fileId) continue;
            const buffer = await drive.downloadFile(it.fileId);
            files[slotKey].push({ buffer, originalname: it.name || slotKey, mimetype: mimeForName(it.name) });
          }
        }
      }
    }

    const gstr3bFiles = files['gstr3b'] || [];
    if (gstr3bFiles.length === 0) {
      return res.status(400).json({ error: 'At least one GSTR-3B file is required' });
    }

    // Build multipart form for Python engine
    const form = new FormData();
    form.append('reco_type', 'gstr_3b_tally_entry');
    if (brandId) form.append('brand_id', brandId);

    for (const f of gstr3bFiles) {
      form.append('gstr3b', new Blob([f.buffer], { type: f.mimetype }), f.originalname);
    }

    const coaFile = (files['coa'] || [])[0];
    if (coaFile) {
      form.append('coa', new Blob([coaFile.buffer], { type: coaFile.mimetype }), coaFile.originalname);
    } else {
      // Try DB-backed COA
      await tryAttachSavedCoa(form, brandId);
    }

    const vtFile = (files['vouchertype'] || [])[0];
    if (vtFile) {
      form.append('vouchertype', new Blob([vtFile.buffer], { type: vtFile.mimetype }), vtFile.originalname);
    } else {
      await tryAttachSavedVt(form, brandId);
    }

    // Call Python engine
    const pyRes = await fetch(`${PYTHON_URL}/api/reconcile`, { method: 'POST', body: form });
    if (!pyRes.ok) {
      const errText = await pyRes.text();
      return res.status(pyRes.status).json({ error: errText || 'Python engine error' });
    }

    const data = await pyRes.json();
    res.json(data);

    // Fire-and-forget: persist COA/VT, save run record
    setImmediate(() => persistAfterRun(data, brandId, coaFile, vtFile).catch(e =>
      console.error('[GSTR3B] Persist error:', e.message)
    ));

  } catch (err) {
    console.error('[GSTR3B] upload error:', err.message);
    if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
      return res.status(503).json({ error: 'Python reco engine is not running (port 8765)' });
    }
    res.status(500).json({ error: err.message });
  }
};

const tryAttachSavedCoa = async (form, brandId) => {
  if (!brandId || brandId === 'demo') return;
  try {
    const brand = await Brand.findByPk(brandId);
    if (!brand) return;
    const seq = getBrandConnection(brand.db_name);
    await ensureTables(seq);
    const [rows] = await seq.query(
      `SELECT ledger_name FROM gstr3b_coa_master WHERE brand_id = $1 ORDER BY ledger_name`,
      { bind: [brandId] }
    );
    if (rows.length > 0) {
      form.append('coa_ledgers', JSON.stringify(rows.map(r => r.ledger_name)));
      console.log(`[GSTR3B-COA] Attached ${rows.length} saved COA ledgers`);
    }
  } catch (e) {
    console.warn('[GSTR3B-COA] DB lookup failed (non-fatal):', e.message);
  }
};

const tryAttachSavedVt = async (form, brandId) => {
  if (!brandId || brandId === 'demo') return;
  try {
    const brand = await Brand.findByPk(brandId);
    if (!brand) return;
    const seq = getBrandConnection(brand.db_name);
    await ensureTables(seq);
    const [rows] = await seq.query(
      `SELECT voucher_name FROM gstr3b_vt_master WHERE brand_id = $1 ORDER BY voucher_name`,
      { bind: [brandId] }
    );
    if (rows.length > 0) {
      form.append('vt_ledgers', JSON.stringify(rows.map(r => r.voucher_name)));
      console.log(`[GSTR3B-VT] Attached ${rows.length} saved Voucher Types`);
    }
  } catch (e) {
    console.warn('[GSTR3B-VT] DB lookup failed (non-fatal):', e.message);
  }
};

const persistAfterRun = async (data, brandId, coaFile, vtFile) => {
  if (!brandId || brandId === 'demo') return;
  try {
    const brand = await Brand.findByPk(brandId);
    if (!brand) return;
    const seq = getBrandConnection(brand.db_name);
    await ensureTables(seq);

    // Save COA if newly uploaded
    const coaParsed = data?.coa_ledgers_parsed;
    if (coaFile && Array.isArray(coaParsed) && coaParsed.length > 0) {
      await withBypass(seq, async (t) => {
        await seq.query(`DELETE FROM gstr3b_coa_master WHERE brand_id = $1`, { bind: [brandId], transaction: t });
        for (const name of coaParsed) {
          await seq.query(
            `INSERT INTO gstr3b_coa_master (brand_id, ledger_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            { bind: [brandId, name], transaction: t }
          );
        }
      });
      console.log(`[GSTR3B-COA] Saved ${coaParsed.length} ledgers`);
    }

    // Save VT if newly uploaded
    const vtParsed = data?.vt_ledgers_parsed;
    if (vtFile && Array.isArray(vtParsed) && vtParsed.length > 0) {
      await withBypass(seq, async (t) => {
        await seq.query(`DELETE FROM gstr3b_vt_master WHERE brand_id = $1`, { bind: [brandId], transaction: t });
        for (const name of vtParsed) {
          await seq.query(
            `INSERT INTO gstr3b_vt_master (brand_id, voucher_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            { bind: [brandId, name], transaction: t }
          );
        }
      });
      console.log(`[GSTR3B-VT] Saved ${vtParsed.length} voucher types`);
    }

    // Save run summary
    const monthlyData = data?.monthly_data || [];
    const allEntries = (data?.results || []).filter(e => e._type === 'data');
    const totalDebit = allEntries.reduce((s, e) => s + (typeof e.debit === 'number' ? e.debit : 0), 0);
    const totalCredit = allEntries.reduce((s, e) => s + (typeof e.credit === 'number' ? e.credit : 0), 0);
    const period = monthlyData.map(m => m.period).join(', ');

    await withBypass(seq, async (t) => {
      await seq.query(
        `INSERT INTO gstr3b_runs (brand_id, job_id, period, total_entries, total_debit, total_credit, monthly_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        {
          bind: [brandId, data?.job_id || null, period, allEntries.length,
                 totalDebit, totalCredit, JSON.stringify(monthlyData)],
          transaction: t
        }
      );
    });
    console.log(`[GSTR3B] Run saved: ${allEntries.length} entries, debit=${totalDebit}`);
  } catch (e) {
    console.error('[GSTR3B] persistAfterRun error:', e.message);
  }
};

// ── Download Excel ────────────────────────────────────────────────────────────

const download = async (req, res) => {
  try {
    const { jobId } = req.params;
    const pyRes = await fetch(`${PYTHON_URL}/api/jobs/${jobId}/export.xlsx`);
    if (!pyRes.ok) {
      return res.status(pyRes.status).json({ error: 'File not found on reco engine' });
    }
    const contentDisposition = pyRes.headers.get('content-disposition') || `attachment; filename="gstr3b_${jobId}.xlsx"`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', contentDisposition);
    const buf = await pyRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[GSTR3B] download error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── COA / VT status ───────────────────────────────────────────────────────────

const getCoaStatus = async (req, res) => {
  try {
    const { brandId } = req.params;
    if (!brandId || brandId === 'demo') return res.json({ hasLedger: false, count: 0, hasVt: false, vtCount: 0 });
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.json({ hasLedger: false, count: 0, hasVt: false, vtCount: 0 });
    const seq = getBrandConnection(brand.db_name);
    await ensureTables(seq);
    const [[coaRow]] = await seq.query(`SELECT count(*)::int AS n FROM gstr3b_coa_master WHERE brand_id = $1`, { bind: [brandId] });
    const [[vtRow]] = await seq.query(`SELECT count(*)::int AS n FROM gstr3b_vt_master WHERE brand_id = $1`, { bind: [brandId] });
    res.json({ hasLedger: coaRow.n > 0, count: coaRow.n, hasVt: vtRow.n > 0, vtCount: vtRow.n });
  } catch (e) {
    res.json({ hasLedger: false, count: 0, hasVt: false, vtCount: 0 });
  }
};

// ── History ───────────────────────────────────────────────────────────────────

const getHistory = async (req, res) => {
  try {
    const { brandId } = req.params;
    if (!brandId || brandId === 'demo') return res.json([]);
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.json([]);
    const seq = getBrandConnection(brand.db_name);
    await ensureTables(seq);
    const [rows] = await seq.query(
      `SELECT id, job_id, period, total_entries, total_debit, total_credit, monthly_data, created_at
       FROM gstr3b_runs WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 20`,
      { bind: [brandId] }
    );
    res.json(rows);
  } catch (e) {
    res.json([]);
  }
};

module.exports = { upload, download, getCoaStatus, getHistory };
