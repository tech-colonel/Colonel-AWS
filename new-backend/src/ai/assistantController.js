/* ── Colonel AI — "Ask Colonel AI" assistant controller ─────────────────────
   POST /api/ai/ask            — auth required. Streams the answer as SSE.
     Body: { messages:[{role,content}], screen?, conversationId?, model? }
     screen = { route, agentType, agentLabel, brandId, brandName, hasResult, resultSummary? }
   GET  /api/ai/suggestions    — auth required. { route?, agentType?, hasResult? }

   Router (cheapest gate first), reusing the GenSpark chat + per-user history:
     [0] pre-gate (NO LLM)   — secrets/infra + code requests → canned refusal, 0 tokens.
     [1] heuristic intent    — app_help / finance / general → scoped system prompt.
     [ ] data / run_agent    — DEFERRED (read-only DB tool + reco-engine dispatch are
                               follow-on plans). Until then those questions are answered
                               by the scoped model WITHOUT inventing data, and the prompt
                               tells the user to use the agent's Run flow for processing.

   Additive: no agent/reco logic touched. Read-only w.r.t. the DB except the
   fire-and-forget append of the assistant turn to the caller's own conversation
   (same pattern + same per-user scoping as chatController).                    */

const path = require('path');
const os = require('os');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { streamGenspark, pickModel } = require('./genspark');
const { preGate, heuristicIntent } = require('./router');
const { resolveScope } = require('./scope');
const { getHelp } = require('./help/screenHelp');
const { buildSystemPrompt } = require('./prompts');
const { detectReport } = require('./reports/detectReport');
const { buildReport, ADMIN_ONLY } = require('./reports/reportService');
const driveService = require('../services/driveService');
const { Conversation } = require('../models/master');

/* Non-admins may never run an admin-only (cross-user) report — silently
   downgraded to their own usage. Returns { key, note }. */
function scopeReportKey(rawKey, isAdmin) {
  if (!isAdmin && ADMIN_ONLY.has(rawKey)) {
    return { key: 'my_usage', note: 'You can only see your own usage — here it is.' };
  }
  return { key: rawKey, note: '' };
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/* Coerce incoming messages → {role:'user'|'assistant', content} (drop empties). */
const toMessages = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    }))
    .filter((m) => m.content.trim().length > 0);

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
};

/* Fire-and-forget: append the assistant turn to the OWNER's conversation only.
   Never widens scope — mirrors chatController's persistence + per-user rule. */
const persistAssistant = (conversationId, userId, text, model) => {
  if (!conversationId || !text) return;
  setImmediate(async () => {
    try {
      const c = await Conversation.findOne({ where: { id: conversationId, user_id: userId } });
      if (!c) return;
      const next = [...(c.messages || []), { role: 'assistant', content: text }];
      await c.update({ messages: next, model });
    } catch (e) {
      console.warn('[ai] persist failed:', e.message);
    }
  });
};

/* POST /api/ai/ask */
async function ask(req, res) {
  const { screen, conversationId } = req.body || {};
  const messages = toMessages(req.body?.messages);
  if (messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }
  const userText = lastUserText(messages);

  // [0] Pre-gate — canned refusal, NO LLM call (0 tokens). This is the
  // security fence: secrets/infra fishing and code-writing never reach the model.
  const gate = preGate(userText);
  if (gate) {
    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    send('delta', { text: gate.text });
    send('done', { text: gate.text, model: 'guard' });
    res.end();
    persistAssistant(conversationId, req.user.id, gate.text, 'guard');
    return;
  }

  // [0.5] Report bucket — canned, role-scoped usage reports run by OUR code
  // (never LLM SQL). Non-admins are restricted to their own usage. Emits a
  // `report` SSE event (chart + table) + a templated summary — 0 LLM tokens.
  const rep = detectReport(userText);
  if (rep) {
    const isAdmin = req.user?.role === 'admin';
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // A broad "who uses which tools on which brands" ask explodes into one row
    // per user×tool×brand (users repeat) — confusing. Ask HOW to group it first,
    // then show a clean grouped summary from the follow-up.
    if (rep.key === 'who_uses_what') {
      res.writeHead(200, SSE_HEADERS);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const text = isAdmin
        ? 'How would you like the usage summary grouped?'
        : 'Here’s your own usage — how would you like it grouped?';
      const options = isAdmin
        ? [
            { label: 'Brand-wise', prompt: 'brand-wise usage report' },
            { label: 'User-wise', prompt: 'usage report by user' },
            { label: 'Tool-wise', prompt: 'which tools are most used' },
          ]
        : [
            { label: 'Brand-wise', prompt: 'my usage by brand' },
            { label: 'Tool-wise', prompt: 'my usage report' },
          ];
      send('choices', { options });
      send('done', { text, model: 'report' });
      res.end();
      persistAssistant(conversationId, req.user.id, text, 'report');
      return;
    }

    const { key, note } = scopeReportKey(rep.key, isAdmin);
    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    try {
      const report = await buildReport(key, { userId: req.user.id, isAdmin });
      const text = (note ? `${note}\n\n` : '') + report.summary;
      send('report', report);
      send('done', { text, model: 'report' });
      res.end();
      persistAssistant(conversationId, req.user.id, text, 'report');
    } catch (err) {
      console.error('[ai] report error:', err);
      send('error', { error: 'Could not build that report.' });
      res.end();
    }
    return;
  }

  // [1] Scope + intent → scoped, guardrailed system prompt (no DB in this plan).
  const scope = resolveScope({ screen, user: req.user });
  const intent = heuristicIntent(userText);
  const help =
    intent === 'app_help'
      ? getHelp({ route: screen?.route, agentType: screen?.agentType, hasResult: screen?.hasResult })
      : null;
  const system = buildSystemPrompt({ scope: scope.mode, screen, helpBlurb: help?.blurb, intent });
  const model = pickModel(req.body?.model);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const { fullText } = await streamGenspark({
      res,
      model,
      system,
      messages,
      isAborted: () => aborted,
    });
    persistAssistant(conversationId, req.user.id, fullText, model);
  } catch (err) {
    console.error('[ai] ask error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Colonel AI failed' });
    } else if (!res.writableEnded) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err?.message || 'Colonel AI failed' })}\n\n`);
      } catch (_) { /* ignore */ }
      res.end();
    }
  }
}

/* GET /api/ai/suggestions?route=&agentType=&hasResult= */
async function suggestions(req, res) {
  const { route, agentType, hasResult } = req.query || {};
  const h = getHelp({ route, agentType, hasResult: hasResult === 'true' });
  res.json({ title: h.title, suggestions: h.suggestions });
}

/* POST /api/ai/report/sheet  { reportKey }
   Re-runs the report SERVER-SIDE with the caller's own role scope (never trusts
   client rows), writes an .xlsx, uploads it as a Google Sheet, returns the URL. */
async function reportSheet(req, res) {
  try {
    const isAdmin = req.user?.role === 'admin';
    const { key } = scopeReportKey(String(req.body?.reportKey || 'usage_by_tool'), isAdmin);
    const report = await buildReport(key, { userId: req.user.id, isAdmin });

    // Build a BEAUTIFUL, on-brand workbook with ExcelJS (Google Sheets preserves
    // merges/fills/fonts/widths on import). No client data trusted — re-built here.
    const cols = report.columns;
    const ncol = Math.max(cols.length, 1);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Colonel AI';
    const ws = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 4 }] });

    const PURPLE = 'FF6D28D9';      // header
    const INDIGO = 'FF4F46E5';      // banner
    const LIGHT = 'FFEDE9FE';       // title band
    const ZEBRA = 'FFF5F3FF';       // alt rows
    const DARKV = 'FF4C1D95';       // dark violet text

    // Row 1 — brand banner (blue→purple wordmark).
    ws.mergeCells(1, 1, 1, ncol);
    const b = ws.getCell(1, 1);
    b.value = '🪖  COLONEL AI';
    b.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
    b.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    b.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INDIGO } };
    ws.getRow(1).height = 36;

    // Row 2 — report title band.
    ws.mergeCells(2, 1, 2, ncol);
    const t = ws.getCell(2, 1);
    t.value = report.title;
    t.font = { bold: true, size: 13, color: { argb: DARKV } };
    t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
    ws.getRow(2).height = 24;

    // Row 3 — generated stamp.
    ws.mergeCells(3, 1, 3, ncol);
    const g = ws.getCell(3, 1);
    g.value = `Generated by Colonel AI  •  ${new Date().toLocaleString('en-IN')}`;
    g.font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
    g.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

    // Row 4 — column headers.
    const hr = ws.getRow(4);
    cols.forEach((c, i) => {
      const cell = hr.getCell(i + 1);
      cell.value = c.label;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PURPLE } };
      cell.alignment = { vertical: 'middle', indent: 1 };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF5B21B6' } } };
    });
    hr.height = 22;

    // Data rows (zebra + light borders).
    report.rows.forEach((r, ri) => {
      const row = ws.getRow(5 + ri);
      cols.forEach((c, ci) => {
        const cell = row.getCell(ci + 1);
        const v = r[c.key];
        cell.value = v === null || v === undefined ? '' : v;
        cell.alignment = { vertical: 'middle', indent: 1 };
        if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } } };
      });
    });

    // Auto-ish column widths.
    cols.forEach((c, i) => {
      const maxLen = Math.max(
        String(c.label).length,
        ...report.rows.map((r) => String(r[c.key] ?? '').length),
      );
      ws.getColumn(i + 1).width = Math.min(Math.max(maxLen + 3, 12), 46);
    });

    const safe = report.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    const tmp = path.join(os.tmpdir(), `colonel_report_${safe}_${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(tmp);
    try {
      const result = await driveService.uploadXlsxAsSheetOAuth(tmp, `${report.title} — Colonel AI`);
      if (!result || !result.webViewLink) {
        return res.status(503).json({ error: 'Google is not connected — connect a Google account in Integrations to export to Sheets.' });
      }
      res.json({ url: result.webViewLink });
    } finally {
      fs.unlink(tmp, () => {});
    }
  } catch (err) {
    console.error('[ai] reportSheet error:', err);
    res.status(500).json({ error: err?.message || 'Could not export the report to Google Sheets.' });
  }
}

module.exports = { ask, suggestions, reportSheet };
