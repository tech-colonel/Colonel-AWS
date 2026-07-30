/* ──────────────────────────────────────────────────────────────────────────────
   driveRouter.js — generic "which Drive file goes to which agent slot" engine.

   Generalizes the Zepto-specific zeptoDrive.js so ANY slot-based agent can accept
   a pasted Drive link (folder OR single-file URL). Flow:
     scanFolder(url)  → [{ fileId, name, mimeType, ext }]
     route(files, slots) → { mapping, unmatched, ambiguous }   (deterministic)
     resolveAmbiguous(...) → GenSpark tie-breaker, ONLY for ambiguous files.

   Deterministic-first: the LLM is never called unless a file scores equally for
   two+ slots. The caller shows the mapping for user confirmation before any run,
   so this is a preview, not an irreversible action. Agent logic is untouched.
   ────────────────────────────────────────────────────────────────────────────── */

const drive = require('./driveService');
const { extractState } = require('./gstStates');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Parse a folder OR single-file id from anything the user pastes. */
function parseAnyId(input) {
  if (!input) return null;
  const s = String(input).trim();
  // Single-file link: /file/d/<ID>/
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'file' };
  // Folder link (delegate to the shared folder parser, which also handles ?id=)
  const folderId = drive.parseFolderId(s);
  if (folderId) {
    // Distinguish a bare/open?id id — treat as unknown kind; scanFolder will getMeta.
    return { id: folderId, kind: /\/folders\//.test(s) ? 'folder' : 'unknown' };
  }
  return null;
}

/** Lowercased file extension incl. dot, or '' if none. */
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * Scan whatever the link points at into a flat file list.
 *  - folder  → recurse subfolders, collect every non-folder file
 *  - file    → that single file
 *  - unknown → getMeta to decide, then handle as above
 * @returns {Promise<Array<{fileId,name,mimeType,ext}>>}
 */
async function scanFolder(url) {
  const parsed = parseAnyId(url);
  if (!parsed) throw new Error('Could not read a Google Drive link from that input.');

  let kind = parsed.kind;
  if (kind === 'unknown') {
    const meta = await drive.getMeta(parsed.id, 'id,name,mimeType');
    kind = meta.mimeType === FOLDER_MIME ? 'folder' : 'file';
  }

  const out = [];
  if (kind === 'file') {
    const meta = await drive.getMeta(parsed.id, 'id,name,mimeType');
    if (meta.mimeType !== FOLDER_MIME) {
      out.push({ fileId: meta.id, name: meta.name, mimeType: meta.mimeType, ext: extOf(meta.name) });
    }
    return out;
  }

  // folder → recurse
  const walk = async (folderId) => {
    const children = await drive.listChildren(folderId);
    for (const c of children) {
      if (c.mimeType === FOLDER_MIME) await walk(c.id);
      else out.push({ fileId: c.id, name: c.name, mimeType: c.mimeType, ext: extOf(c.name) });
    }
  };
  await walk(parsed.id);
  return out;
}

/** Keyword-match score of a filename against one slot. 0 = no match. */
function scoreFileForSlot(file, slot) {
  const m = slot.match || {};
  const exts = m.extensions || [];
  if (exts.length && !exts.includes(file.ext)) return 0; // extension gate
  const name = String(file.name || '').toLowerCase();
  let score = 0;
  for (const kw of (m.keywords || [])) {
    if (name.includes(String(kw).toLowerCase())) {
      // longer, more specific keywords weigh more than a bare token like "2b"
      score += Math.max(1, String(kw).trim().length);
    }
  }
  return score;
}

/**
 * Deterministically assign files to slots.
 * @returns {{ mapping: Object<string, Array>, unmatched: Array, ambiguous: Array }}
 *   mapping[slotKey]  = [{fileId,name}]  (confident assignments)
 *   unmatched         = [{fileId,name}]  (no slot matched)
 *   ambiguous         = [{fileId,name,candidates:[slotKey,...]}]  (tie between slots,
 *                        OR extra files competing for a single-value slot)
 */
function route(files, slots) {
  const mapping = {};
  for (const s of slots) mapping[s.key] = [];
  const unmatched = [];
  const ambiguous = [];

  // 1) Best slot(s) per file.
  const perFile = [];
  for (const f of files) {
    let best = 0;
    let bestSlots = [];
    for (const s of slots) {
      const sc = scoreFileForSlot(f, s);
      if (sc > best) { best = sc; bestSlots = [s.key]; }
      else if (sc > 0 && sc === best) { bestSlots.push(s.key); }
    }
    if (best === 0) { unmatched.push({ fileId: f.fileId, name: f.name }); continue; }
    if (bestSlots.length > 1) { ambiguous.push({ fileId: f.fileId, name: f.name, candidates: bestSlots }); continue; }
    perFile.push({ file: f, slotKey: bestSlots[0], score: best });
  }

  // 2) Assign to slots; enforce single-value slots (keep top score, others ambiguous).
  const bySlot = {};
  for (const pf of perFile) (bySlot[pf.slotKey] = bySlot[pf.slotKey] || []).push(pf);
  for (const s of slots) {
    const list = (bySlot[s.key] || []).sort((a, b) => b.score - a.score);
    if (!list.length) continue;
    if (s.multiple) {
      for (const pf of list) mapping[s.key].push({ fileId: pf.file.fileId, name: pf.file.name });
    } else {
      mapping[s.key].push({ fileId: list[0].file.fileId, name: list[0].file.name });
      for (const pf of list.slice(1)) {
        ambiguous.push({ fileId: pf.file.fileId, name: pf.file.name, candidates: [s.key] });
      }
    }
  }

  return { mapping, unmatched, ambiguous };
}

/**
 * GenSpark tie-breaker for ambiguous files only. Returns an updated result where
 * resolvable ambiguous files are moved into `mapping`. Never throws — on any
 * error it returns the input unchanged (deterministic result still stands and
 * the user can fix it in the confirm UI). No LLM call when nothing is ambiguous.
 */
async function resolveAmbiguous(result, slots, files) {
  if (!result.ambiguous || result.ambiguous.length === 0) return { ...result, usedLlm: false };
  if (!process.env.GSK_API_KEY) return { ...result, usedLlm: false };

  const GSK_BASE_URL = process.env.GSK_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1';
  const GSK_MODEL = process.env.GSK_MODEL || 'claude-opus-4-8';

  const slotLines = slots.map((s) => `- ${s.key}: ${s.label}${s.multiple ? ' (can take multiple)' : ''}`).join('\n');
  const fileLines = result.ambiguous.map((a, i) => `${i + 1}. "${a.name}" (candidate slots: ${a.candidates.join(', ')})`).join('\n');
  const prompt =
    `You assign files to input slots for an accounting tool. Slots:\n${slotLines}\n\n` +
    `Assign each ambiguous file below to exactly one slot key from its candidate list, ` +
    `based on the filename. Reply ONLY with compact JSON: {"assignments":[{"file":"<name>","slot":"<key>"}]}.\n\n` +
    `Files:\n${fileLines}`;

  try {
    const resp = await fetch(`${GSK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GSK_API_KEY}` },
      body: JSON.stringify({ model: GSK_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    });
    if (!resp.ok) return { ...result, usedLlm: false };
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...result, usedLlm: false };
    const parsed = JSON.parse(jsonMatch[0]);
    const assignments = Array.isArray(parsed.assignments) ? parsed.assignments : [];

    const mapping = { ...result.mapping };
    const stillAmbiguous = [];
    const validKeys = new Set(slots.map((s) => s.key));
    for (const amb of result.ambiguous) {
      const a = assignments.find((x) => x && x.file === amb.name && amb.candidates.includes(x.slot) && validKeys.has(x.slot));
      if (a) {
        mapping[a.slot] = (mapping[a.slot] || []).concat({ fileId: amb.fileId, name: amb.name });
      } else {
        stillAmbiguous.push(amb);
      }
    }
    return { ...result, mapping, ambiguous: stillAmbiguous, usedLlm: true };
  } catch (_) {
    return { ...result, usedLlm: false };
  }
}

/**
 * End-to-end preview: scan the link, route deterministically, then LLM-resolve
 * any ambiguity. Returns { mapping, unmatched, ambiguous, usedLlm, files }.
 */
async function preview(url, slots) {
  const files = await scanFolder(url);
  const det = route(files, slots);
  const resolved = await resolveAmbiguous(det, slots, files);
  return { ...resolved, files: files.map((f) => ({ fileId: f.fileId, name: f.name })) };
}

/** Best type (gstr2b | purchase | debit) for a file among the 3 multistate slots. */
function _typeOf(file, slots) {
  let best = 0; let bestKey = null;
  for (const s of slots) {
    const sc = scoreFileForSlot(file, s);
    if (sc > best) { best = sc; bestKey = s.key; }
  }
  return best > 0 ? bestKey : null;
}

/**
 * Multi-state grouping: from ONE folder with every state's files, group them into
 * per-state {gstr2b, purchase, debit} using the GSTIN state code / state name in
 * each filename (see gstStates.extractState). Files whose type or state can't be
 * determined go to `unassigned`.
 *
 * @returns {{ states: Array, unassigned: Array, files: Array }}
 *   states[] = { code, label, gstr2b:[{fileId,name}], purchase:[...], debit:[...] }
 */
function routeMultiState(files, slots) {
  const byState = new Map(); // code -> { code, label, gstr2b:[], purchase:[], debit:[] }
  const unassigned = [];

  const ensure = (code, label) => {
    if (!byState.has(code)) byState.set(code, { code, label: label || code, gstr2b: [], purchase: [], debit: [] });
    return byState.get(code);
  };

  for (const f of files) {
    const type = _typeOf(f, slots);
    const st = extractState(f.name);
    if (!type || !st) { unassigned.push({ fileId: f.fileId, name: f.name, type: type || null, state: st ? st.code : null }); continue; }
    ensure(st.code, st.label)[type].push({ fileId: f.fileId, name: f.name });
  }

  // Stable order by state code.
  const states = [...byState.values()].sort((a, b) => a.code.localeCompare(b.code));
  return { states, unassigned, files: files.map((f) => ({ fileId: f.fileId, name: f.name })) };
}

/** End-to-end multi-state preview from a folder link. */
async function previewMultiState(url, slots) {
  const files = await scanFolder(url);
  return routeMultiState(files, slots);
}

module.exports = { parseAnyId, extOf, scanFolder, scoreFileForSlot, route, resolveAmbiguous, preview, routeMultiState, previewMultiState };
