# AI Everywhere — Colonel AI Assistant (design)

**Date:** 2026-07-31
**Where:** colonel-automation, LOCAL only (frontend :3000, backend `node server.js` :8001, Python reco :8765, unified Postgres). No GitHub push, no AWS. Commit each step to local `main`; back up shared files before editing; never `git add -A`.

## Goal
A context‑aware **"✨ Ask Colonel AI"** assistant available on **every screen** (floating button, bottom‑right) that:
1. Knows **which screen / agent / brand** the user is on.
2. Answers from **our data/DB** (e.g. "why are 466 invoices issues?").
3. Answers **app how‑to / troubleshooting** ("how do I use this tool / paste a Drive link / why isn't it fetching?").
4. Answers **general Indian finance questions** (GST / TDS / tax) — model knowledge first, web search only for current facts.
5. **Refuses off‑scope** (write code, chit‑chat) cheaply, to not waste API.
6. Offers **2–3 suggested questions** relevant to the current screen.

Runs on our existing **GenSpark → Claude** integration (chat is already on `claude-haiku-4-5`). Reuses the existing `chatController` / `ColonelChat` where possible.

## Decisions locked with the user
- Assistant lives as a **floating button on every screen** (not only `/chat`).
- **Data‑only + refuse code**: it answers about the user's data / app / finance domain; it must **not** write code or do general‑purpose tasks (canned refusal, no LLM call where possible).
- Finance knowledge = **model‑first, web‑search‑on‑demand**; do **not** preload a finance knowledge DB (stale + token cost).
- Helical Insight's **code is not used** (AGPL + Java); we adopt only its *methods* (below). AI‑generated ad‑hoc charts/dashboards = **Phase 2**, out of scope now.

## Architecture — one router, four buckets
Every user message is classified (cheapest gate first) and routed to exactly one bucket:

```
message + screenContext
        │
   [0] pre-gate (no LLM)  ── obvious code/chit-chat ─▶ canned refusal (0 tokens)
        │ else
   [1] intent route (cheap: haiku, 1 short call)
        ├─ app_help      ▶ curated help KB (screen-scoped) ─▶ answer
        ├─ data          ▶ DB tool (staged NL→SQL, guarded) ─▶ answer + capped sample
        ├─ finance       ▶ model knowledge; web_search only if "current/latest" ─▶ answer
        └─ off_scope     ▶ canned refusal
```

### Bucket 1 — App help / how‑to (screen‑aware)
- A small **curated help KB**: one short markdown blurb per tool + shared topics (Drive link, "file not fetching", "Open in Sheets", login). Lives in the repo (`new-backend/src/ai/help/*.md` or a JS map) — tiny, versioned, no DB.
- Only the **current screen's** blurb (+ a couple of shared ones) is injected → cheap.
- Answers the non‑tech accountant questions: how to use this tool, how to paste a Drive link, why isn't it working (troubleshooting checklist), what the output means.

### Bucket 2 — Your data (read‑only DB access)
Adopts Helical's staged NL→SQL + sqlglot guard, on our stack:
- **Read‑only DB role** (`colonel_ai_ro` or reuse `colonel_app` with a read‑only, RLS‑scoped session) — SELECT only, `statement_timeout`, `default_transaction_read_only=on`.
- **Curated catalog** (semantic layer): hand‑written descriptions of the queryable tables/columns + **business metrics** ("matched rate", "issues = rows where remark ≠ matched") + **synonyms**. Start with the analytics‑safe set: `reco_jobs` and the per‑run `*_results` tables. NOT the whole schema.
- **Staged generation** (lightweight version of `SqlFlowGraph`): (a) pick relevant tables/columns from the catalog for this question, (b) generate a single SELECT with the catalog + few‑shot examples.
- **Guard (sqlglot‑style):** parse the generated SQL; **reject unless it is one read‑only `SELECT`** referencing only catalog tables; force a `LIMIT`. (Node: `node-sql-parser`, or a tiny Python validator reusing sqlglot — TBD in plan.)
- **Scope:** always filtered by the current **brand_id** via RLS (`app.brand_id`), matching the app's existing RLS. Admin may cross‑brand only if their role allows.
- **Answer:** run the SELECT, take a **capped sample** (≤50 rows, Helical's cap) + counts, feed to the LLM to phrase the answer. Show the numbers; optionally reveal the SQL on request.

### Bucket 3 — Finance knowledge (GST / TDS / Tax)
- **Model‑first:** Claude answers fundamentals directly (no fetch).
- **Web search only when the question needs current/latest** info (rate change, latest notification, due dates). A `web_search` tool the model may call; results summarized with source links.
- **Provider (OPEN DECISION):** GenSpark API may expose a search tool (key on hand) — else Tavily/Serper/Bing. Confirm before wiring; the bucket works model‑only until search is added.

### Bucket 4 — Off‑scope
- Code‑writing, general programming, unrelated chit‑chat → **short canned refusal**. Obvious cases caught by the pre‑gate (regex/keywords) with **no LLM call**; borderline cases refused by the router.

## Screen context + suggested prompts
- Frontend passes `screen` context on every request: `{ route, agentType, agentLabel, brandId, brandName, hasResult, resultSummary? }`.
- A **static map** `screen → [2–3 suggested questions]` (e.g. E‑Invoice → "How do I use this tool?", "How do I paste a Drive link?", "Why is my file not fetching?"; a results screen → "Summarize this run", "Why are so many issues?", "Which vendors cause most issues?").
- Chips render above the input; clicking one sends it.

## Methods adopted from Helical Insight (patterns only — no AGPL code)
- Staged NL→SQL (narrow tables/columns → generate) instead of one‑shot.
- Curated **semantic catalog** (descriptions + business metrics + synonyms) instead of raw schema.
- **sqlglot** parse/validate + dialect handling as the SQL guard.
- **Capped sample** (≤50 rows) fed back for the natural‑language answer.
- **Domain/intent gate** before answering (our router).
- **Token‑usage logging** per call (from their TokenUsage audit idea).
- Explicitly NOT: their Java platform, LangChain/LangGraph dependency, viz engine, report designer.

## Guardrails (consolidated)
1. **Pre‑gate**, no LLM, for obvious code/off‑scope → 0 tokens.
2. **Scoped system prompt**: answer only from Colonel data / app / Indian‑finance domain; refuse code + general tasks.
3. **Schema fence**: SQL may reference only catalog tables.
4. **Execution fence**: read‑only role, `SELECT`‑only (sqlglot‑validated), RLS brand scope, `LIMIT`, statement timeout.
5. **Token caps**: screen‑scoped help injection, ≤50‑row samples, web search only on demand, cheap model (haiku) for routing/help/answers.
6. **No writes ever** from the assistant to the DB.

## Backend design (additive; new files)
- `new-backend/src/ai/router.js` — pre‑gate + intent classification → bucket.
- `new-backend/src/ai/help/` — curated help KB (per‑tool markdown/JS) + `screenHelp.js` (screen → blurb + suggested prompts).
- `new-backend/src/ai/dbTool/` — `catalog.js` (semantic catalog), `generateSql.js` (staged), `validateSql.js` (sqlglot/parser guard), `runReadonly.js` (read‑only, RLS, LIMIT).
- `new-backend/src/ai/webSearch.js` — optional provider wrapper (gated by env; no‑op until configured).
- Extend `chatController.js` (or a new `assistantController.js`) with a `POST /api/ai/ask` that takes `{ message, screen, conversationId }`, runs the router, streams the answer via the existing SSE contract. Reuse GenSpark call + `claude-haiku-4-5`.
- Token‑usage logging (lightweight).

## Frontend design (additive)
- `frontend/src/components/AskColonelAI.jsx` — floating "✨ Ask Colonel AI" button + slide‑over panel, mounted app‑wide (in `App.js` or a layout wrapper) so it appears on every screen. Reuses the chat message UI where practical.
- Passes screen context (from `react-router` location + current agent/brand + last result if present).
- Renders suggested‑prompt chips from the backend (or the static map).
- Hidden on the public Landing/Login screens.

## Rollout (each step: backup → build → verify → commit local `main`)
1. Backend router + pre‑gate + scoped system prompt + off‑scope refusal (no DB yet). Wire `POST /api/ai/ask` (help + finance‑model‑only + refusal).
2. Frontend floating `AskColonelAI` widget on every screen + screen context + suggested prompts. Verify help/finance/refuse end‑to‑end.
3. Curated help KB per tool + screen‑prompt map (fill content).
4. DB tool: read‑only role + catalog + validateSql + runReadonly + staged generateSql; wire the `data` bucket. Verify on real reco data with guardrail tests.
5. Web search provider (decide GenSpark vs Tavily) → wire the `finance` current‑info path.
6. (Phase 2, later) AI‑generated ad‑hoc charts.

## Testing
- **Unit:** `validateSql` (rejects INSERT/UPDATE/DELETE/DDL, multi‑statement, non‑catalog tables; accepts a scoped SELECT), router classification on sample questions, pre‑gate refusals.
- **Guardrail:** attempt a write / cross‑brand / non‑catalog query → blocked. Confirm RLS scoping returns only the current brand's rows.
- **Integration (local):** ask a data question on a real reco result → correct numbers; ask "how to use this tool" on E‑Invoice → screen‑correct help; ask "write me a python script" → refused with 0 LLM cost.

## Risks / caveats
- **LLM + DB access** is the sensitive part — the read‑only role + SELECT‑only validation + RLS are mandatory, not optional.
- **Text‑to‑SQL accuracy** depends on the catalog quality; start with a narrow, well‑described table set and expand.
- **Web search** adds a dependency/cost; keep it on‑demand and behind an env flag.
- **AWS parity:** like the Drive/chat work, this needs env on the box (GenSpark key already required for chat; DB read‑only role; optional search key). Out of scope now (LOCAL only).

## Guardrails (project rules)
LOCAL :3000 only; no GitHub/AWS. Additive; back up before editing shared files; the assistant is read‑only w.r.t. the DB and never changes agent logic; commit per step by explicit path.
