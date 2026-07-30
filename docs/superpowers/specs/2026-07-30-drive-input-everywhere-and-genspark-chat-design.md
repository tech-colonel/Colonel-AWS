# Drive Input Everywhere + GenSpark Chat — Design

**Date:** 2026-07-30
**Where:** colonel-automation, LOCAL only (frontend :3000, backend `node server.js` :8001, reco-engine :8765). No GitHub push, no AWS. Commit each step to local `main`. Back up every shared file before editing (`cp -a <f> <f>.bak-$(date +%Y%m%d-%H%M%S)`). Never `git add -A` (other sessions have uncommitted files); commit only files touched here, by explicit path.

## Goal

1. On **every agent** (and Colonel AI chat), keep the existing manual file upload AND add a **"From Drive"** option: paste a Google Drive link (folder or single-file URL). The system **recognizes which file goes to which input slot**, shows an **editable mapping** for confirmation, then runs the agent.
2. In **Colonel AI chat**, remove the **Gemini** LLM and use **GenSpark** instead (same proxy the workflow builder already uses).

Decisions locked with the user:
- **Paste-a-link now; visual Google Drive Picker is a later follow-up.** (Reuses the existing service-account read path — zero new Google OAuth.)
- **Show the detected mapping and let the user confirm/fix before running** (no silent auto-run).

## What already exists (reuse — do not duplicate)

- `new-backend/src/services/driveService.js` — service-account Drive read path: `parseFolderId`, `listChildren`, `downloadFile`, `getMeta`, `isDescendant`, `uploadXlsxAsSheet`, `makeAnyoneReader`. Creds at `new-backend/config/google-credentials.json` (already configured).
- `new-backend/src/services/zeptoDrive.js` — Zepto-specific classifier: `collectZeptoFiles(folderUrl)` → `{counts, ignored, files}`, `downloadClassified(folderUrl)`. **Template** for the generic router.
- `frontend/src/pages/accountant/GoogleDriveFolderInput.jsx` — paste-URL → Analyze → `POST /api/reco/detect-files` (Zepto-only) → shows counts. Pattern to generalize.
- `frontend/src/pages/accountant/RecoWorkspace.jsx` — `RECO_SPECS[type].files[]` declares named slots per reco agent: `{ key, label, hint, accept?, required, multiple?, maxFiles? }`. ~10 reco types share this one file.
- `new-backend/src/controllers/workflowAiController.js` — **GenSpark LLM proxy** (OpenAI-compatible): `POST ${GSK_BASE_URL}/chat/completions`, `Authorization: Bearer ${GSK_API_KEY}`, model `GSK_MODEL` (`claude-opus-4-8`). `GSK_API_KEY` is SET in `.env`.
- `new-backend/src/controllers/chatController.js` — Colonel AI chat, currently **Gemini streaming** (`GEMINI_BASE` SSE). ~179 lines. To be switched to GenSpark.
- Agent-workspace dispatch (`frontend/src/pages/accountant/AgentDispatch.jsx`): `MtrWorkspace`, `RecoWorkspace`, `RecoMultiStateWorkspace`, `PdfBankExtractorWorkspace`, `MyntraTicketFinderWorkspace`, `Gstr3bTallyWorkspace`, `InvoiceAgentWorkspace`, generic `AgentWorkspace`.
- Per-brand saved central folder: `root_folder_url` via `PUT /api/brands/:brandId/drive-config` (can pre-fill the link field later).

## Architecture

### A. Slot registry (single source of truth for "what inputs does this agent have")
Each agent's input slots + **match hints** live in one shared place both front and back can read:
- Slot: `{ key, label, accept, required, multiple?, match: { keywords:[...], extensions:[...] } }`.
- The reco slots already exist in `RECO_SPECS` (frontend). Add a **backend registry** `new-backend/src/services/agentSlots.js` mapping `agent_type → slots[]` with `match` hints (keywords/extensions per slot), and add matching `match` hints to the frontend specs. Keep them consistent; the backend copy is authoritative for `/api/drive/route`.
- Example hints: `gstr2b` → keywords `['2b','gstr2b','gstr-2b']`; `purchase` → `['purchase','purchase register','pr']`; `bank_statement` → `['bank','statement']` ext `['.xlsx','.xls','.csv','.pdf']`.

### B. Generic Drive router (backend)
`new-backend/src/services/driveRouter.js` (new) — generalizes `zeptoDrive`:
- `scanFolder(folderUrl)` → `[{ fileId, name, mimeType, ext }]` via `driveService.parseFolderId` + `listChildren` (also accept a single-file URL → 1-element list).
- `route(files, slots)` → deterministic match: for each file, score against each slot's `match` (keyword hit in filename + extension allowed). Assign best slot; collect `unmatched` and `ambiguous` (file scoring equally for ≥2 slots, or slot with ≥2 candidate files).
- `resolveAmbiguous(ambiguous, slots)` — **GenSpark tie-breaker only for ambiguous cases** (small prompt: filenames + slot labels → best assignment). Deterministic path never calls the LLM.
- Returns `{ mapping: { slotKey: [{fileId,name}] }, unmatched: [{fileId,name}], usedLlm: bool }`.

### C. Route-preview endpoint (backend)
`POST /api/drive/route` (new) — body `{ folder_url, agent_type }`:
- Look up `slots = agentSlots.get(agent_type)`; `files = driveRouter.scanFolder(folder_url)`; `result = driveRouter.route(files, slots)`.
- Respond `{ slots, mapping, unmatched, usedLlm }`. Auth: same `flexibleAuth` middleware as `/reco/detect-files`.
- The existing `/api/reco/detect-files` (Zepto) stays as-is for back-compat.

### D. Run-time Drive ingestion (backend)
Each agent's run endpoint gains an **optional** Drive path alongside multipart:
- Accept `drive: { slotKey: fileId, ... }` (JSON) in the run request. When present, backend downloads each `fileId` via `driveService.downloadFile` into the **same in-memory buffer / temp path the agent already consumes**, then proceeds unchanged.
- **Agent logic is not modified** — only the file-acquisition step gains a Drive branch (additive). Fire-and-forget DB writes unchanged.
- Start with `recoController.runReco` (covers all `RECO_SPECS` agents), then MTR/PDF-bank/Myntra/GSTR-3B-Tally/invoice/generic as each is wired.

### E. Reusable frontend input `<DriveOrUpload>`
`frontend/src/components/DriveOrUpload.jsx` (new). Props: `{ slots, values, onChange, agentType }`.
- Renders the **existing per-slot uploader** unchanged as the default `Upload` tab.
- Adds a small pill toggle `Upload | From Drive`. Drive tab = link input + **Analyze** → calls `/api/drive/route` → renders an **editable mapping table** (each slot: a dropdown of detected files, pre-selected to the guess; unmatched files listed; required-but-unmatched flagged). On confirm, it sets the slots' Drive fileIds so the workspace's existing Run button submits `drive:{...}`.
- Pure CSS variables (light/dark), no hardcoded hex. Backup each workspace file before the 1-line swap.
- Wired into: `RecoWorkspace` (covers ~10 reco agents), `RecoMultiStateWorkspace`, `MtrWorkspace`, `PdfBankExtractorWorkspace`, `MyntraTicketFinderWorkspace`, `Gstr3bTallyWorkspace`, `InvoiceAgentWorkspace`, generic `AgentWorkspace`.

### F. Colonel AI chat
1. **Gemini → GenSpark**: rewrite `chatController.js` to call the GenSpark proxy (reuse `workflowAiController`'s constants/pattern; keep the existing SSE streaming contract to the frontend so `ColonelChat.jsx` is untouched). System prompt preserved. Gemini left in place elsewhere (reco LLM gate) — only the chat switches. No Gemini fallback (per approval).
2. **Drive in chat (Agent mode)**: when the user pastes a Drive link in Agent mode, call `/api/drive/route` for the chosen agent, render the same mapping inline, run the agent, show results inline (existing Agent-mode result rendering).

## Rollout (each step: backup → build → verify → commit to local `main`)
1. `agentSlots.js` registry + `driveRouter.js` + `POST /api/drive/route` (+ unit tests for `route`/deterministic matching).
2. `<DriveOrUpload>` component + wire into `RecoWorkspace`; verify end-to-end on one reco agent (paste folder → mapping → run).
3. Wire remaining workspaces.
4. Run-time Drive ingestion in run endpoints (reco first, then the rest).
5. Chat: Gemini→GenSpark swap (verify streaming still works).
6. Chat: Drive-link recognize + run in Agent mode.

## Testing
- **Unit:** `driveRouter.route()` deterministic matching (exact slot, extension filter, unmatched, ambiguous detection) with fixture filename lists — no network.
- **Integration (manual, local):** paste a shared Drive folder on a reco agent → correct mapping shown → run produces the same output as manual upload. Chat: send a message (GenSpark reply streams); paste a Drive link in Agent mode → agent runs.
- **No-regression:** manual upload path unchanged on every wired workspace.

## Risks / caveats
- **Filename-based matching** is heuristic; the confirm-mapping step is the safety net. GenSpark tie-breaker only fires on ambiguity.
- **LOCAL only.** For AWS later: the box needs its own SA creds + `GSK_API_KEY`, and brand folders shared with the SA. Out of scope now.
- Drive folders must be shared with the service account email (existing requirement, already surfaced in `GoogleDriveFolderInput` copy).

## Guardrails
LOCAL :3000 only; no GitHub/AWS. Additive; back up before editing shared files; never change agent logic (Drive is an alternate file source only); commit per step by explicit path (no `git add -A`).
