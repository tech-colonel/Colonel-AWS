# 🏗️ ARCHITECTURE — Colonel-AWS (colonel-automation, Production)

> Full app architecture reference for **colonel-automation** — the production RECO branch served
> live on AWS/ngrok. This is the **superset** app (ahead of the port-3001 sandbox).
> Local path: `colonol git/colonel-automation/` · Frontend **:3000** · Backend **:8001** ·
> Python reco engine **:8765** · PostgreSQL **:5432**.
>
> Companion docs — [README.md](README.md) · [CLAUDE.md](CLAUDE.md) · [AWS.md](AWS.md) ·
> [SERVERS.md](SERVERS.md) · [RECO.md](RECO.md) · [DATABASES.md](DATABASES.md).
>
> ⚠️ The Mac copy is a **reference checkout** — editing it never deploys. The live app runs on EC2
> from `origin/RECO`. Never modify `colonol git/` as a deploy step.

---

## 1. Three-tier architecture at a glance

```
┌──────────────────────┐          ┌───────────────────────┐              ┌─────────────────────┐
│  React 18 SPA (craco) │  axios   │  Express REST API      │  axios proxy │  Python Reco Engine  │
│  frontend/  (:3000)   │ ───────▶ │  new-backend/ (:8001)  │ ───────────▶ │  stdlib http (:8765) │
│  Tailwind · Radix/ui  │ ◀─────── │  Sequelize + pg + JWT  │ ◀─────────── │  pandas/openpyxl/xlrd│
│  @xyflow · Recharts   │   JSON   └───────────┬───────────┘  Excel/JSON    └─────────────────────┘
└──────────────────────┘                      │ pg                  ▲
                                   ┌───────────▼────────────┐        │ subprocess: classify.py
                                   │ PostgreSQL (:5432)      │        │ (Universal Bank — NOT 8765)
                                   │ ONE unified DB          │
                                   │ colonel_agent_accountant│   ┌────┴──────────────────────────┐
                                   │ (brand_id column + RLS) │   │ External integrations          │
                                   └────────────────────────┘   │ Zoho Books · Fireflies · n8n · │
                                                                 │ Google Drive/Sheets · Shopify ·│
                                                                 │ Composio · marketplace parsers │
                                                                 └────────────────────────────────┘
```

- **On EC2 the Node backend (:8001) also serves the compiled React `build/`** — no separate frontend
  server, single origin for the ngrok tunnel. In local dev, craco serves `:3000` live.
- **Tier 1 → Tier 2**: `frontend/src/lib/api.js` axios instance. URL resolves at **runtime by hostname**
  (`localhost` → `http://localhost:8001`; any tunnel host → same-origin `''`). Never bake
  `REACT_APP_BACKEND_URL`.
- **Tier 2 → Tier 3**: `recoController` proxies to Python `http://localhost:8765/api/reconcile` for GST
  agents. `universal_bank_statement` runs `new-backend/scripts/classify.py` as a **subprocess** (does
  NOT use :8765).
- **Tier 2 → DB**: Sequelize (`config/database.js`) in **unified mode** (default: `USE_UNIFIED_DB !== 'false'`)
  — every brand shares ONE database `colonel_agent_accountant`. Tenant isolation is `brand_id` +
  `FORCE ROW LEVEL SECURITY`: the master connection uses the superuser (`postgres`) for boot DDL, while
  brand connections use the non-superuser `colonel_app` role and preset `app.brand_id` (via an
  `afterConnect` hook, looked up from `brands.db_name`) so RLS scopes every query and `brand_id`
  auto-stamps on insert via column DEFAULT. RLS bypass only works inside a `seq.transaction()`.
  Legacy one-DB-per-brand is an escape hatch (`USE_UNIFIED_DB=false`).

---

## 2. Frontend — `frontend/` (React 18 · craco/CRA · Tailwind · Radix `ui/` · @xyflow/react · Recharts)

```
frontend/src/
├── App.js                        ← router + all route definitions
├── index.js
├── context/AuthContext.js        ← JWT auth state (role read from localStorage.user.role)
├── hooks/use-toast.js
├── lib/
│   ├── adminNav.js               ← sidebarFor(): ADMIN_SIDEBAR / DEVELOPER_SIDEBAR / accountant base
│   ├── api.js                    ← axios instance, runtime hostname → backend URL
│   ├── recoAgentSpecs.js         ← reco agent metadata/specs for the UI
│   ├── demoSamples.js            ← sample auto-load data
│   ├── sampleCalendar.js         ← meetings/calendar sample data
│   └── utils.js
├── components/
│   ├── ProtectedRoute.jsx        ← role/route guard (/admin/* is admin-only)
│   ├── BrandLogos.jsx
│   ├── MeetingDetailModal.jsx    ← Fireflies meeting detail
│   ├── AdminChatPanel.jsx        ← admin ↔ accountant chat panel
│   ├── StatutoryFilters.jsx      ← premium filters for statutory tracker
│   ├── layout/DashboardLayout.jsx ← sidebar (from adminNav.sidebarFor) + navbar shell
│   ├── reco/ToolResultDashboard.jsx ← reco result viewer
│   └── ui/                       ← ~50 shadcn/Radix primitives (button, dialog, table, tabs, …)
└── pages/
    ├── Login.jsx
    ├── ColonelChat.jsx           ← Colonel AI chat (chat/conversation/mcp controllers)
    ├── accountant/
    │   ├── AgentDispatch.jsx      ← routes /agents/:agentId → correct workspace by UUID
    │   ├── AgentWorkspace.jsx     ← generic agent run UI (+ BrandSwitcher bar to change brand on sales agents)
    │   ├── ../../components/BrandSwitcher.jsx ← persistent brand-context switcher
    │   ├── BrandSelection.jsx · BrandDashboard.jsx
    │   ├── BrandAgentsInventory.jsx ← ★ rich CATEGORIZED agents grid (see §5)
    │   ├── RecoSuite.jsx · RecoWorkspace.jsx · RecoMultiStateWorkspace.jsx · RecoJobDashboard.jsx
    │   ├── Gstr1Dashboard.jsx · Gstr3bTallyWorkspace.jsx
    │   ├── PdfBankExtractorWorkspace.jsx · MtrWorkspace.jsx
    │   ├── InvoiceAgentWorkspace.jsx · OrderCycleShopifyWorkspace.jsx
    │   ├── SettlementAmazonWorkspace.jsx · TotalSalesAnalyzerModal.jsx
    │   ├── MyntraTicketFinderWorkspace.jsx · NykaaWorkspace.jsx
    │   ├── ZohoBooksPage.jsx       ← Zoho Books mirror drill-down
    │   ├── MeetingsPage.jsx        ← Fireflies meetings (3-tab)
    │   ├── ComplianceTracker.jsx   ← per-brand+user monthly workflow board
    │   ├── StatutoryTracker.jsx    ← private owner-gated statutory filing tracker
    │   ├── GoogleDriveFolderInput.jsx ← Drive folder picker (used by workspaces)
    │   └── WorkflowApplyModal.jsx
    ├── developer/
    │   └── FeedbackPage.jsx        ← developer feedback queue
    ├── admin/
    │   ├── AdminDashboard.jsx      ← real-time cross-brand analytics
    │   ├── BrandsPage.jsx · BrandOverviewPage.jsx (drill-down sections)
    │   ├── AgentsPage.jsx · AssignmentsPage.jsx · UsersPage.jsx
    │   ├── TasksPage.jsx · AdminChats.jsx
    │   ├── AdminStatutory.jsx      ← cross-brand statutory view (admin)
    │   ├── IntegrationsPage.jsx    ← integration status/config
    │   ├── ComposioMarketplace.jsx ← 1000+ app Composio marketplace (connect/showcase)
    │   ├── PlansPage.jsx · PlanEditor.jsx  ← plan builder
    │   ├── DatabasePage.jsx        ← Database explorer (@xyflow/react ERD, route /database)
    │   ├── WorkflowManagerModal.jsx ← @xyflow flow builder ("Manage Workflows")
    │   ├── WorkflowAIChatModal.jsx ← AI-drafted workflow generation
    │   ├── AdminUserDetailPage.jsx ← per-user analytics drill-down (/analysis/user/:userId)
    │   └── ToolDetails.jsx
    └── cfo/
        ├── CFODashboardLauncher.jsx · AmazonCFODashboard.jsx · BrandFinancialDetails.jsx
```

### Roles & sidebar (`lib/adminNav.js → sidebarFor(brandItems)`)

Role is read from `localStorage.user.role`; any `/admin/*` path is treated as an authoritative admin
signal (guards against a lagging role read).

| Role | Constant | Sidebar items |
|---|---|---|
| **admin** | `ADMIN_SIDEBAR` | Dashboard · Colonel AI · Brands · Agents · Users · Database · Tasks · Chats · Statutory · Plans · Feedback · Integrations · Assignments |
| **accountant** | base array | Dashboard · Agents · Tracker · **(Statutory Compliance — owner email only)** · Colonel AI · Meetings · Tasks · Feedback · Integrations · Zoho Books · Plans · Switch brands |
| **developer** | `DEVELOPER_SIDEBAR` | Colonel AI · Feedback · Plans |

- The **accountant base menu is identical on every page** — brand-scoped items (Dashboard/Agents/
  Tracker) link to `lastBrandId` (fall back to the brand picker). Pages may override brand-scoped
  paths by label but must not inject their own Brands/Tasks/Plans (Switch brands wins).
- **Statutory Compliance** nav is gated to `STATUTORY_OWNER_EMAIL = chauhandhaval932@gmail.com`
  (an accountant who owns the gated Statutory/Zoho/Composio surfaces).
- **cfo / brand** are entities/pages, not sidebar roles in this file.

---

## 3. Backend — `new-backend/` (Express · Sequelize/pg · JWT/bcryptjs)

```
new-backend/
├── server.js                     ← ENTRY — app.listen(8001); runs migrations on boot
└── src/
    ├── app.js                     ← EXPORTS app; mounts EVERY route group (see §4)
    │                                + serves frontend/build (express.static) + SPA fallback LAST
    ├── config/database.js         ← unified-DB Sequelize (default); superuser master + colonel_app
    │                                brand conns (RLS via app.brand_id); createBrandDatabase = no-op in unified
    ├── middleware/                ← auth (JWT), upload (multer), error handler
    ├── routes/                    ← 24 route files (mount list in §4)
    ├── controllers/               ← see §4 + agents/ subfolders in §5
    ├── services/                  ← integration + processing services (see §6)
    ├── models/                    ← master / brand / reco / task (see §7)
    ├── db/migrations/             ← 001_reco_tables.sql (idempotent, runs every boot)
    │                                + 3000-only tables (zoho_*, meetings, compliance, plans, …)
    ├── scripts/classify.py        ← Universal Bank Statement CLI (subprocess, not :8765)
    └── data/ · output/ · utils/   ← output/ (+ output/ledgers/<brandId>.xlsx CoA) is gitignored
```

Backend entry is **`server.js`** (not `src/app.js` directly). `app.js` is imported, mounts routes, and
serves the SPA.

---

## 4. `app.js` route-mount list (VERIFIED — must stay COMPLETE)

> ⚠️ A stripped `app.js` returns the SPA HTML for API calls → empty UI (the bug that "broke the site").
> All groups mount on bare `/api` **except** where noted. Order matters: **static build + SPA fallback
> come LAST**, after every `/api` route.

```
express.json / urlencoded (50mb) · cors
/api/files            → express.static('../output')      (static reco output files)
GET /api/health       → health check
──────────────────────── route groups ────────────────────────
/api/auth             → authRoutes
/api                  → brandRoutes
/api                  → userRoutes
/api                  → agentRoutes
/api                  → recoRoutes          (GST reco + GSTR-3B-vs-2B + 2A/2B live here)
/api                  → dashboardRoutes     (job history, analytics, getJobById)
/api/bank-reco        → bankCorrectionsRoutes
/api                  → taskRoutes
/api                  → gstr3bRoutes         (dedicated GSTR-3B routes — present on 3000)
/api                  → salesRoutes
/api                  → invoiceRoutes
/api                  → orderCycleRoutes
/api                  → settlementRoutes
/api                  → cfoAnalyticsRoutes   (cfoRoutes.js exists but is UNMOUNTED/dead)
/api                  → mtrRoutes
/api                  → plansRoutes
/api                  → integrationRoutes
/api                  → chatRoutes           (Colonel AI)
/api                  → workflowRoutes
/api                  → meetingRoutes         (Fireflies)
/api                  → zohoRoutes            (Zoho Books mirror)
/api                  → composioRoutes        (Composio marketplace)
/api                  → complianceRoutes
/api                  → attachmentsRoutes
/api                  → statutoryRoutes       (owner-gated statutory tracker)
/api                  → databaseRoutes         (admin Database explorer / ERD data)
──────────────────────── tail (LAST) ─────────────────────────
error-handling middleware
if fs.existsSync(frontendBuild):
  express.static(frontendBuild)
  GET /{*path} → sendFile(frontendBuild/index.html)    ← SPA fallback, must be LAST
```

> Note: on 3000 there **is** a dedicated `gstr3bRoutes` mount (differs from the 3001 sandbox note that
> GSTR-3B lives only inside recoRoutes). `cfoRoutes.js` is present but not mounted — only
> `cfoAnalyticsRoutes` is live.

### Controllers (`new-backend/src/controllers/`)

`authController` · `brandController` · `userController` · `agentController` · `recoController`
(upload handler, Python proxy, DB saves, Layer 0 corrections; also the ephemeral master-data reset for
the catch-all **"Other"** brand — no-op for real brands) · `dashboardController` ·
`bankCorrectionsController` · `taskController` · `gstr3bController` · `salesController` ·
`cfoAnalyticsController` · (`cfoController` — dead) · `mtrController` · `plansController` ·
`integrationController` · `attachmentsController` · `complianceController` · `statutoryController` ·
`composioController` · `workflowController` · `workflowAiController` (AI-drafted workflows) ·
`databaseController` (Database explorer / ERD) · `meetingController` (Fireflies) · `zohoController`
(Zoho Books) · **Colonel-AI stack**: `chatController` · `conversationController` · `mcpController`.

---

## 5. Agents — controllers/agents/ subfolders + categorized UI

### `new-backend/src/controllers/agents/` subfolders
```
common/                 ← misController.js (shared MIS helpers)
invoice-process/        ← invoiceController.js · n8n-invoice-feed-db.js
order-cycle-shopify/    ← orderCycleShopifyController.js
settlement-amazon/      ← settlementAmazonController.js
total-sales/            ← totalSalesController.js
sales-amazon/  sales-blinkit/  sales-cread/  sales-firstcry/  sales-flipkart/  sales-jiomart/
sales-limeroad/  sales-mirrow/  sales-myntra/  sales-nykaa/  sales-shopify/  sales-zepto/
                        ← 12 marketplace sales channels, one <channel>Controller.js each
```

### Rich categorized Agents UI → `frontend/src/pages/accountant/BrandAgentsInventory.jsx`
This page renders agents grouped into **category sections** (mirrors the admin Agents page). Section
order + accent colors:

| Section key | Label | Accent |
|---|---|---|
| `reco` | GST Reconciliation | `#0748EE` |
| `bank` | Bank & Finance | `#059669` |
| `invoice` | Invoice | `#7C3AED` |
| `marketplace` | Marketplace MIS | `#D97706` |
| `other` | Other | `#64748B` |

Rich per-agent metadata (matched by DB `name`) supplies displayName, icon, category and file-slot
fields; sales/marketplace agents without rich meta are synthesized from their section + a per-channel
color chip (`channelIcon`). `isRecoOnly()` (tunnel host) trims the grid to the RECO-only accountant
view; `localhost` shows all agents.

---

## 6. Agent inventory (33 agents), grouped by category

Agent IDs are **random UUIDv4** (query the `agents` table by `name`) — the old sequential
`d0000000-0000-0000-0000-0000000000NN` pattern was regenerated for security (mappings in
`db-restructure/008-agent-id-remap.json`; brand IDs likewise in `009-brand-id-remap.json`). Agents are
seeded by `seeders/01-reco-agents.js`; sales channels via `seed-sales-*.js` / DB rows. The stable key
is the DB `name`; `AgentDispatch.jsx` maps each agent's UUID → workspace component. The `…-0000000000NN`
suffixes shown below are the **old** IDs kept only as a legacy cross-reference — the live values are random.

### GST Reconciliation
| Agent (DB `name`) | UUID | Notes |
|---|---|---|
| `gstr_2b_books` | `…-000000000001` | GSTR-2B vs Purchase + Debit-Note register (single-state) |
| `gstr_2b_books_multistate` | `…-000000000002` | Multi-GSTIN; adds Remark 3 |
| `gstr_1_vs_books` | `…-000000000005` | GSTR-1 outward vs Tally sales + Amazon RTF |
| `einvoice_reco` | **`…-000000000008`** | E-Invoice reconciliation |
| `gstr_3b_vs_2b` / `gstr_2a_2b_books` | (engine-level) | Live inside recoController/recoRoutes + Python engine |

### Journal Entry
| `gstr_3b_tally_entry` | `…-000000000003` | Parses GSTR-3B → ready-to-post Tally journal entries |

### Bank & Finance
| `universal_bank_statement` | `…-000000000004` | Any Indian bank stmt → CoA (subprocess `classify.py`, Layer 0 corrections) |
| `pdf_bank_extract` | `…-000000000007` | PDF → Bank Statement (dynamic, deterministic pdfplumber) |

### Marketplace MIS — sales channels (12) + consolidators
Amazon · Blinkit · Cread · Firstcry · Flipkart · JioMart · Limeroad · Mirrow · Myntra · Nykaa ·
Shopify · Zepto — plus:
| `amazon_mtr_consolidator` | `…-000000000006` | Amazon MTR consolidator (single B2C/B2B/Log workbook, all months) |
| `settlement-amazon` | — | Amazon settlement reco |
| `total-sales` | — | Total Sales analyzer (cross-channel MIS) |
| `zepto_receivables` | **`…-000000000010`** | Zepto receivables reco (Drive-folder input, GRN-gate PO match) |

### Invoice
| `invoice-process` | — | Invoice processing (n8n webhook feed → DB) |

### Other
| `Shopify-Order-Cycle` (order-cycle-shopify) | seeded via `02-order-cycle-agent.js` | Order-cycle tracking across carriers/lenders |
| Colonel AI chat | — | chat/conversation/mcp controllers |
| Fireflies Meetings · Zoho Books mirror · Compliance Tracker · Workflow builder | — | Platform surfaces (not run-per-file agents) |

> Reco engine logic (Python) lives in `reco-engine/recon/` — see [RECO.md](RECO.md). Deep GSTR-2B
> edge-case pipeline lives in `RECO CLAUDE.md`.

---

## 7. Models — `new-backend/src/models/`

> In **unified mode** (default) all four bundles resolve to the single `colonel_agent_accountant`
> database: master/org tables have no RLS (superuser connection), while brand-scoped tables carry a
> `brand_id` column + RLS and are reached over the `colonel_app` brand connections. The "DB" column
> below reflects the legacy per-brand-DB model; unified collapses it to one DB + `brand_id`.

| Bundle | Exports | DB (legacy) → unified |
|---|---|---|
| `master/index.js` | `User`, `Brand`, `Agent`, `BrandUser`, `BrandAgent`, `Plan`, `Integration`, `Conversation`, `McpServer`, `AgentWorkflow` | `colonel-master` → unified (no RLS) |
| `brand/index.js` | brand-agent + dynamic per-upload models (sales/MIS tables) | per-brand DBs → unified (`brand_id` + RLS) |
| `reco/index.js` | factories: `getRecoJobModel` (`reco_jobs`), `getBankRecoResultModel` (`bank_reco_results`), `getGstr2bResultModel` (`gstr_2b_results`) — all `underscored` | per-brand DBs → unified (`brand_id` + RLS) |
| `task/index.js` | `Task`, `TaskMessage` (+ `syncTaskTables`) | `colonel-master` → unified (no RLS) |

- **Access gating**: `brand_users` rows gate brand access (`GET /api/brands/my-brands`);
  `brand_agents` rows gate per-brand agent runnability.
- **Brand-scoped reco tables** (created by `db/migrations/001_reco_tables.sql`, idempotent, runs on every
  boot): `reco_jobs`, `bank_reco_results`, `gstr_2b_results`, `gstr_2a_2b_results`, `gstr_3b_results`,
  `gstr_1_results`, `gstr_3b_tally_results`, `bank_reco_corrections` — each carries a `brand_id` and is
  under `FORCE ROW LEVEL SECURITY`. Dynamic sales/agent tables (`db-restructure/002_dynamic_agent_tables.sql`)
  likewise carry `brand_id` + RLS + `colonel_app` grants — brand is no longer implicit in "which DB".
- Full schema, RLS rules, `IS NOT DISTINCT FROM` and `toSqlDate()` conventions → [DATABASES.md](DATABASES.md).

---

## 8. Services — `new-backend/src/services/`

```
agentRunTracker.js        ← tracks agent runs
cfoAnalyticsService.js     ← CFO analytics aggregation
composioClient.js          ← Composio marketplace API client
driveService.js            ← Google Drive service-account file I/O
googleClient.js            ← Google API auth client
mtrProcessor.js            ← Amazon MTR consolidation engine
pendingGenerationsStore.js ← in-flight generation state
salesService.js            ← shared sales-agent processing
zohoClient.js · zohoSync.js ← Zoho Books auth + read-only mirror sync
zeptoDrive.js              ← Zepto receivables Drive folder fetch
processors/
  ├── amazon/ blinkit/ cread/ firstcry/ flipkart/ jiomart/ limeroad/ mirrow/ myntra/ nykaa/
  │   shopify/ zepto/                    ← per-channel sales processors
  ├── orderCycleShopifyProcessor.js
  ├── macrosProcessorB2B.js · macrosProcessorB2C.js   ← MTR B2B/B2C macros
```

---

## 9. External integrations

| Integration | Direction / role | Backend surface |
|---|---|---|
| **Zoho Books** | Read-only mirror → master DB (`zoho_*` tables); refresh-token auth, India DC | `zohoController` · `zohoClient`/`zohoSync` · `/zoho` page |
| **Fireflies** | Per-user meeting notes (workspace fetch, filter by attendee email) | `meetingController` · `/meetings` (3-tab) |
| **n8n** | Invoice webhooks → DB feed | `agents/invoice-process/n8n-invoice-feed-db.js` |
| **Google Drive + Sheets** | Service-account file I/O; per-brand output; folder-input agents (MTR, Zepto) | `driveService` · `googleClient` · `GoogleDriveFolderInput.jsx` |
| **Shopify** | Order-cycle order pulls | `orderCycleShopifyController` + processor |
| **Composio** | 1000+ app marketplace (connect/showcase Layer 1) | `composioController` · `composioClient` · `ComposioMarketplace.jsx` |
| Marketplace parsers | Amazon/Flipkart/Myntra/Nykaa/Zepto/… settlement + sales file formats | per-channel `processors/` |

---

## 10. Cross-reference

| Doc | Read it for |
|---|---|
| [README.md](README.md) | Repo overview / getting started |
| [CLAUDE.md](CLAUDE.md) | RECO branch rules, agent UUIDs, RLS, adding-an-agent checklist |
| [AWS.md](AWS.md) | Live EC2 deploy, ngrok, SSH, crons, the Nov 7 2026 deadline |
| [SERVERS.md](SERVERS.md) | Ports, pm2/nohup, starting/restarting the 3 services |
| [RECO.md](RECO.md) | Python reco engine + all reco/agent logic |
| [DATABASES.md](DATABASES.md) | PostgreSQL schema, models, migration, RLS/persistence |
