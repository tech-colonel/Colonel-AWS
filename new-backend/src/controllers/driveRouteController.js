/* ──────────────────────────────────────────────────────────────────────────────
   driveRouteController.js — POST /api/drive/route

   Generic "recognize which Drive file goes to which slot" preview for any
   slot-based agent. Body: { folder_url, agent_type }.
   Returns { slots, mapping, unmatched, ambiguous, usedLlm } so the UI can show
   an editable mapping the user confirms before running. No download, no run.
   ────────────────────────────────────────────────────────────────────────────── */

const driveService = require('../services/driveService');
const agentSlots = require('../services/agentSlots');
const driveRouter = require('../services/driveRouter');

async function routeDriveFiles(req, res) {
  try {
    const folderUrl = req.body?.folder_url || req.body?.folderLink || req.body?.url;
    const agentType = req.body?.agent_type || req.body?.agentType;
    if (!folderUrl) return res.status(400).json({ error: 'folder_url is required' });
    if (!agentType) return res.status(400).json({ error: 'agent_type is required' });

    if (!driveService.isConfigured()) {
      return res.status(400).json({ error: 'Google Drive is not configured on this server.' });
    }
    const slots = agentSlots.get(agentType);
    if (!slots) {
      return res.status(422).json({ error: `Drive input is not available for "${agentType}" yet.` });
    }

    // Multi-state: group ONE folder's files per state (GSTIN code / state name).
    if (agentType === 'gstr_2b_books_multistate') {
      const ms = await driveRouter.previewMultiState(folderUrl, slots);
      return res.json({
        multistate: true,
        states: ms.states,
        unassigned: ms.unassigned,
        files: ms.files,
        serviceAccountEmail: driveService.serviceAccountEmail ? driveService.serviceAccountEmail() : null,
      });
    }

    const result = await driveRouter.preview(folderUrl, slots);
    // Return slot metadata the UI needs to render the editable mapping table.
    const slotMeta = slots.map((s) => ({ key: s.key, label: s.label, required: !!s.required, multiple: !!s.multiple }));
    return res.json({
      slots: slotMeta,
      mapping: result.mapping,
      unmatched: result.unmatched,
      ambiguous: result.ambiguous,
      files: result.files,            // every detected file: [{fileId,name}] — powers the dropdowns
      usedLlm: !!result.usedLlm,
      serviceAccountEmail: driveService.serviceAccountEmail ? driveService.serviceAccountEmail() : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to scan the Drive link.' });
  }
}

module.exports = { routeDriveFiles };
