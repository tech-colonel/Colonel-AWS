# 🖥️ SERVERS.md — Ports, Startup & Process Management

> Deep-dive companion to [CLAUDE.md](CLAUDE.md) and [README.md](README.md). Covers **which service runs where** and **how to start/restart** each for the **Colonel-AWS** repo.
> Python reco-engine internals (API, `reco_type` dispatch, agent files) live in [RECO.md](RECO.md). Databases in [DATABASES.md](DATABASES.md). AWS/EC2 process topology in [AWS.md](AWS.md). System-wide layout in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Service topology (Colonel-AWS = superset)

Colonel-AWS is the single superset repo. It has **four tiers**: a React frontend, a Node backend, a Python reco engine, and PostgreSQL.

```
                  FRONTEND            NODE BACKEND         PYTHON RECO       DATABASE
                  (React SPA)         (Express)            (stdlib http)     (PostgreSQL)
 ┌──────────────┬───────────────────┬───────────────────┬─────────────────┬────────────┐
 │ Local (dev)  │ :3000  craco       │ :8001  pm2         │ :8765  pm2      │ :5432      │
 │              │ frontend/          │ new-backend/       │ reco-engine/    │ local pg   │
 ├──────────────┼───────────────────┼───────────────────┼─────────────────┼────────────┤
 │ AWS EC2      │ served by :8001    │ :8001  pm2         │ :8765  pm2      │ :5432      │
 │ (live)       │ (build/ via Node)  │ + pm2: ngrok       │ reco-engine     │ local pg   │
 └──────────────┴───────────────────┴───────────────────┴─────────────────┴────────────┘
```

```
 pm2 process tree (EC2 live):
   colonel-backend (8001) · reco-engine (8765) · ngrok → 8001
```

> **Port 8765 is shared** — only ONE Python engine can bind it at a time. On EC2 there is **no separate frontend server**: the Node backend (8001) serves the compiled React `build/` (see [AWS.md](AWS.md)).

---

## Ports at a glance

| Service | Port | How to run (from repo root) | Notes |
|---|---|---|---|
| **React frontend** | 3000 | `cd frontend && npx craco start` | Dev only; on EC2 it's a compiled `build/` served by Node |
| **Node backend** | 8001 | `cd new-backend && node server.js` | Entry = `new-backend/server.js` (**NOT** `src/app.js`); runs DB migrations on boot |
| **Python reco engine** | 8765 | `cd reco-engine && python3 server.py` | Handles GST reco agents; **shared port** |
| **PostgreSQL** | 5432 | system service | See [DATABASES.md](DATABASES.md) |

- **Backend entry is `new-backend/server.js`** — not `src/app.js`. The backend **runs migrations on boot**, so a fresh clone self-provisions its schema once the DB is restored/reachable.
- **Reco engine** (`reco-engine/server.py`) serves the GST reconciliation agents on 8765. The `universal_bank_statement` agent is the exception — it runs via a `new-backend/scripts/classify.py` subprocess spawned by the Node backend, not through the 8765 engine. See [RECO.md](RECO.md).
- **Port 8765 is shared** — only ONE engine process can bind it at a time. Kill any stale listener before starting a new one.
- On EC2 there is **no separate frontend server** — the Node backend (8001) serves both the API and the compiled React `build/`. See [AWS.md](AWS.md).

---

## Fresh-machine bring-up

Clone and stand up the whole stack from scratch, **in this order**:

```bash
# 0. Clone
git clone <colonel-aws-repo-url> colonel-aws
cd colonel-aws

# 1. Restore the database (seed data + schema baseline)
cd db-seed && ./restore.sh
cd ..

# 2. Backend: env + dependencies
cd new-backend
cp .env.example .env          # then fill in secrets / DB creds
npm install
cd ..

# 3. Python reco engine: dependencies
cd reco-engine
pip install -r requirements.txt
cd ..

# 4. Start the services (each in its own terminal, or via pm2 below)
#    a) Python reco engine (bind 8765)
cd reco-engine && python3 server.py
#    b) Node backend (8001) — runs migrations on boot
cd new-backend && node server.js
#    c) React frontend (3000, dev only)
cd frontend && npx craco start
```

Order matters: **DB first** (backend migrations on boot need a reachable DB), then the reco engine (so the backend can reach 8765), then the backend, then the frontend.

> On EC2 you skip the frontend dev server — build once (`cd frontend && npm run build`) and the Node backend serves `build/`. See [AWS.md](AWS.md).

---

## Process management (pm2)

Run all long-lived services under **pm2** so they auto-restart on crash and survive terminal close. **Never** use bare `node server.js &` (dies when terminal closes).

```bash
# Node backend (8001)
cd new-backend
pm2 start server.js --name colonel-backend      # first time
pm2 restart colonel-backend                      # after code changes

# Python reco engine (8765) — kill any stale listener first (shared port)
cd reco-engine
kill -9 $(lsof -t -i:8765) 2>/dev/null
pm2 start server.py --name reco-engine --interpreter python3   # first time
pm2 restart reco-engine                          # after editing recon/*.py

# Frontend (dev only) — not under pm2; on EC2 it's a static build/
cd frontend && npx craco start

pm2 save                                          # persist process list across reboot
pm2 status                                        # list all managed processes
```

- **Restart the right process after a change**: backend code → `pm2 restart colonel-backend`; reco agent code (`recon/*.py`) → `pm2 restart reco-engine`; frontend → rebuild (`npm run build` on EC2) or restart the dev server locally.
- **On EC2, back up `build/` before rebuilding** the frontend (see [AWS.md](AWS.md)).
- **Reco engine memory**: on small boxes (EC2 2 GB) the engine can balloon RAM — a `gc` / `malloc_trim` fix is applied; multi-state is the heavy case.

---

## Health checks

| Service | Check | Healthy response |
|---|---|---|
| Node backend | `curl -s http://localhost:8001/api/health` | JSON `{ status: "ok" ... }` |
| Python reco engine | `curl -s http://localhost:8765/` | engine banner / OK |
| EC2 pm2 processes | `pm2 status` | `colonel-backend`, `reco-engine`, `ngrok` all `online` |

> If login or data looks broken, **check `pm2 status` / the backend first** — it's almost always the backend being down, not an auth-code bug.
