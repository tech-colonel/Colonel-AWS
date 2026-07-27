# Universal Bank Statement Classifier — Side Rules & Learning Redesign

**Date:** 2026-07-27
**Scope:** `colonel-automation` (local port 3000) — **Urban Plant and M Brands only**
**Status:** Design approved, awaiting implementation plan

---

## 1. Problem

Two accountant-audited runs from 2026-07-27 (both by Varshita, on the live box):

| Run | Brand | Rows | Correct | Accuracy |
|---|---|---|---|---|
| `b2398b78-2d6e-4d53-a5f3-18577e582438` | Urban Plant | 261 | 84 | **32.2 %** |
| `62c41ab8-bc37-4a93-a096-a921da0de352` | M Brands | 225 | 190 | **84.4 %** |

Both workbooks carry a hand-added `Correct Ledger Name` column (J) and a `=H=J` comparison
column (K). Column H in the accountant's copies is byte-identical to the box's original
output, so the audits grade our output, not an edited copy.

Three independent defects produce those numbers.

### Defect 1 — the learning loop writes keys that can never match again

`extractPayeeKeys` (JS, writes) and `extract_payee_keys` (Python, reads) emit only an
`exact` key for every narration format these two banks produce:

```
NEFT-AXISP00804036529-DELHIVERY  LIMITED-1062026466-91602005  → {exact: <whole string>}
NEFT AXISCN1389928147 RAZORPAY PAYMENTS PVT LTD P             → {exact: <whole string>}
INF/NEFT/IN42615451081832/SBIN0003/AZAD/AZADSALARY            → {exact: <whole string>}
BIL/ONL/001211144556/DELHIVERYL                               → {exact: <whole string>}
MMT/IMPS/615207439303/DAS4ZU26NBXIRD6/Amazon Sel/HSBC Bank    → {exact: <whole string>}
UPI/BIGFOOT RETAIL/ICIC/053382310720/ShiprocketRe             → {exact: <whole string>}
```

Every `exact` key embeds a one-time transaction reference, so it can never recur.

Stored key inventory (`bank_payee_directory`, all brands):

| brand | exact | phone | vpa | neft_name | name |
|---|---|---|---|---|---|
| Urban Plant | 554 | 44 | 0 | 0 | 0 |
| Zaydn | 496 | 49 | 92 | 74 | 84 |
| M Brands | 478 | 19 | 0 | 0 | 0 |
| FLO | 0 | 190 | 362 | 537 | 0 |

539 of 554 (Urban Plant) and 355 of 478 (M Brands) `exact` keys contain an 8+ digit
reference. Of the `phone` keys, only 7 of 44 and 3 of 19 are real Indian mobiles — the rest
are NEFT reference numbers leaked in before the `[6-9]` constraint was added (commit
`7a712d9`), and they are still live in the DB.

Measured effect — replaying all 598 learned Urban Plant entries against her June statement:

```
Urban Plant June — 598 learned entries:
   NO MATCH   261 rows (100.0 %)
```

**Zero hits out of 261.** Months of accountant corrections have never influenced a single
downstream row. This is the largest defect and the reason accuracy does not improve month
over month.

Zaydn and FLO do have generalizable keys because slash-NEFT and IMPS-FROM patterns were
added for FLO earlier. Nobody has ever added ICICI or Kotak patterns, which is why Urban
Plant and M Brands have none.

### Defect 2 — Claude arbitration overrides the side-map

`classify.py` step 3.6 re-opens rows already marked *High* and lets Claude replace the
ledger with any COA name, unless the deciding rule is whitelisted:

```python
AUTHORITATIVE = ('Stored Correction', 'Payee Directory', 'Own Account', 'OAT',
                 'Sweep', 'Contra', 'BDP Statutory', 'GSTN', 'TDS', 'EPF',
                 'ESIC', 'PT ', 'NEFT Return', 'Bank Charges', 'Interest')
```

`'Side Ledger'` is absent. The side-map assigns correctly, then arbitration discards it:

| entity | side-map (correct) | arbitration picked |
|---|---|---|
| DELHIVERY | Receipt From Delhivery | DELHIVERY LIMITED-DL / -Payment |
| RAZORPAY | Receipt From Razorpay | RAZORPAY SOFTWARE PRIVATE LIMITED |
| BUSYBEES | Receipt From Busy Bees | BUSYBEES LOGISTICS…LIMITED-DL |
| FLIPKART | Flipkart Debtors Receipt | Flipkart Sales |

Measured on Urban Plant: the side-map decided 148 rows; arbitration broke **89** of them —
half of all 177 errors. Protecting those rows alone moves Urban Plant from
**32.2 % → 66.3 %**. M Brands loses 5 Flipkart rows the same way.

Verified by reproduction: running `classify.py` locally with the identical 891-ledger COA
and 598-entry directory but **no** Anthropic key (so arbitration never fires) yields
`Receipt From Delhivery`, `Receipt From Razorpay`, `Receipt From Busy Bees`,
`Receipt From Flipkart` — all correct.

Petty Cash survives only by luck: its top COA candidate happens to be the assigned ledger,
so Claude picks it back.

### Defect 3 — uploading an audited file teaches the wrong column

`bankCorrectionsController.js:376` (`uploadOutputExcel`) binds `colIndex.ledgerName` to the
**first** header containing "ledger", scanning left to right. In Varshita's workbooks that is
column H (`Ledger Name`, the agent's answer), not column J (`Correct Ledger Name`, her fix).

Uploading an audited file therefore re-learns the agent's own mistakes and reinforces them.

The same function never reads the Debit/Credit amounts, so it cannot know which side a
correction applies to.

---

## 2. Goals and non-goals

**Goals**

1. Accountant corrections generalize — a correction made in June fires in July.
2. A row never lands *High* on an unverified guess.
3. Debit/credit side rules are data, not files: editable, learnable, per-brand.
4. Urban Plant and M Brands both above **95 %** on the June statements, scored cold.

**Non-goals**

- No changes for the other 15 brands in this pass. Extractor patterns are bank-format based
  and will benefit them, but no other brand is backfilled or given side rules here.
- No change to the 3001 sandbox.
- No AWS deployment. That is a separate conversation with explicit permission.
- Not solving genuinely new vendors (`G P INDUSTRIES`, `ZEE COMPUTERS`, `Porter`, `Indeed`).
  They correctly land in review the first time; the learning loop handles them from the
  second month on.

---

## 3. Target architecture

Runtime layer order. Side rules first, then the DB directory, then everything already built:

```
1. Side rules       (DB, side-aware, per-brand)  → Claude confirm / flip / not-this-vendor
2. Stored exact     (DB, narration_key)
3. Payee directory  (DB: name / neft_name / vpa / phone)   ← fed by the fixed extractor
4. Statutory, own-account, contra rules          (unchanged)
5. Keyword / fuzzy COA match                     (unchanged)
6. Claude fallback on Low + Medium               (unchanged)
7. Claude arbitration — layers 1-4 AUTHORITATIVE and exempt; only 5-6 arbitrable
8. Suspense
```

A layer-1 miss — no token match, or Claude answering `NOT-THIS-VENDOR` — drops the row into
layer 2 exactly as today. No new code path; brands without side rules are unaffected.

**Confidence contract**

| Bucket | Meaning |
|---|---|
| **High** | A deterministic rule fired **and**, where applicable, Claude agreed |
| **Medium** | A rule fired but Claude abstained or disagreed; **or** no rule fired and Claude picked |
| **Low** | No rule, no confident pick → Suspense |

---

## 4. Component 1 — extractor and backfill

### 4.1 Shared specification

`extractPayeeKeys` (JS) and `extract_payee_keys` (Python) must agree, or learning fails
silently — that is the current failure mode. Both implement a single
`payee-keys.spec.json` of named patterns, and both test suites run one shared fixture file.
Drift becomes a test failure rather than a 0 % match rate.

### 4.2 Patterns to add

Each derived from a real row in the two June statements:

| Rail / bank | Narration shape | Key |
|---|---|---|
| ICICI NEFT | `NEFT-<REF>-<NAME>-<digits>-<digits>` | `neft_name` |
| Kotak NEFT | `NEFT <REF> <NAME>` | `neft_name` |
| ICICI IMPS | `MMT/IMPS/<ref>/<utr>/<NAME>/<BANK>` | `name` |
| ICICI netbanking | `INF/NEFT/<ref>/<IFSC>/<NAME>/<purpose>` | `name` |
| ICICI bill-pay | `BIL/ONL/<ref>/<VENDOR>` | `name` |
| Kotak UPI | `UPI/<NAME>/<BANK>/<ref>/<note>` | `name` |
| NACH | `NACH-<n>-<DR\|CR>-<SPONSOR>-<COUNTERPARTY>` | `name` = **counterparty** |

The NACH rule resolves `NACH-10-DR-RAZORPAYSOFTWAREPRIV-STRATEGIC FINVEST…` at the key
level: the counterparty is `STRATEGIC FINVEST PRIVATE LIMITED` (Varshita's correction, and
present in the M Brands COA), not the sponsoring bank `RAZORPAYSOFTWAREPRIV`.

### 4.3 Guard rails

A wrong key is worse than no key. Reject any candidate that is all digits, matches
`^[A-Z]{4}$` (bank code), is shorter than 3 characters, or appears in `NOISE_WORDS`. The
fixture file asserts these negatives explicitly.

### 4.4 Backfill

**Source table.** For these two brands the stored corrections live in
`bank_payee_directory` under `key_type='exact'` (Urban Plant 554, M Brands 478 = **1,032
rows**), *not* in `bank_reco_corrections` — that table holds zero rows for both brands
(its 15,020 rows belong to FLO 14,017, Stroom 580, Koparo 423). The backfill must read
`bank_payee_directory WHERE key_type='exact'`. Reading `bank_reco_corrections` would
process nothing.

Re-run the new extractor over those 1,032 `exact` rows, derive `name` / `vpa` /
`neft_name` keys from `key_value` (which holds the full uppercased narration), and upsert
the results back into `bank_payee_directory` with `source='backfill'`. The same pass
deletes the 53 `phone` rows (37 Urban Plant + 16 M Brands) that are leaked references
rather than mobile numbers.

The existing `exact` rows are **left in place** — they are harmless, and a re-run of the
same statement should still match them.

**Conflict rule.** Two corrections yielding the same key with different ledgers: keep the
most recent and log the conflict. A key contested more than twice is **not** written and is
listed for review — a contested vendor is precisely the signal that it is really a *side*
rule, which feeds Component 2.

Properties: idempotent (running twice produces the same rows), reversible (one `DELETE`
on `source='backfill'`), and run manually against a local DB copy with the diff reviewed
before anything else happens.

---

## 5. Component 2 — side rules in the database

### 5.1 Schema

New table in the brand DB, beside `bank_payee_directory`:

```sql
CREATE TABLE bank_side_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL,
  tokens        text[] NOT NULL,      -- uppercase match tokens
  credit_ledger text NOT NULL,        -- money IN  → Receipt
  debit_ledger  text NOT NULL,        -- money OUT → Payment
  fixed_type    text,                 -- e.g. 'Contra', overrides Receipt/Payment
  tier          text NOT NULL DEFAULT 'primary',   -- 'primary' | 'fallback'
  priority      int  NOT NULL DEFAULT 100,         -- lower checked first
  status        text NOT NULL DEFAULT 'active',    -- 'active' | 'suggested' | 'disabled'
  source        text NOT NULL DEFAULT 'manual',    -- 'seed' | 'learned' | 'manual'
  evidence      jsonb,                -- {credit_rows, debit_rows, samples[]}
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

Additive only. No alter or drop on `bank_reco_corrections` or `bank_payee_directory`.

### 5.2 Minimal blast radius

`classify.py` keeps consuming `--side-map` as a JSON file in the shape it already parses.
The only change: `recoController.runUniversalClassifier` **generates** that file from
`bank_side_rules` instead of reading a static one. If the table is empty or the query
fails, it falls back to the checked-in JSON, so Urban Plant and M Brands can never be worse
off than today.

### 5.3 Match ordering

Sort candidate rules by `priority ASC, longest-token DESC`. The longer, more specific token
wins, so `STRATEGIC FINVEST` beats a bare `RAZORPAY` without hand-maintained ordering. This
property has a dedicated unit test.

### 5.4 Seed data

The two existing JSON files import as `source='seed', status='active'` — 10 M Brands rules,
9 Urban Plant rules — giving identical day-one behaviour. Two additions from the audit:

- **Split `BIGFOOT RETAIL` from `SHIPROCKET`.** `SHIPROCKET COD CRF` narrations keep the COD
  ledger on the credit side; `BIGFOOT RETAIL` narrations map to
  `Bigfoot Retail Solution(Shiprocket)-HR` on both sides. This matches every Bigfoot row in
  the M Brands file, including the one Receipt Varshita corrected to the `-HR` ledger.
- **`STRATEGIC FINVEST`** at a higher priority than `RAZORPAY`, as a belt-and-braces
  companion to the NACH extractor rule.

### 5.5 Claude on a side-rule row

Candidates are only ever `{credit_ledger, debit_ledger, ABSTAIN, NOT-THIS-VENDOR}`. Claude
physically cannot write an unrelated COA name onto a side-rule row, which is the structural
guarantee that Defect 2 cannot recur.

| Claude answers | Outcome |
|---|---|
| the amount-implied side | **High**, `rule='Side Ledger'` |
| the other side | **High**, `rule='Side Ledger (flipped)'` |
| `ABSTAIN` | keep the rule's ledger, **Medium**, flagged for review |
| `NOT-THIS-VENDOR` | falls through to layer 2 onward |
| call fails / key missing | **stays High** on the rule's own answer, and logs a warning |

The failure mode is deliberate: the rule is accountant-authored and was right roughly 95 %
of the time unaided. Claude catches exceptions; it does not license the rule. An outage must
not dump ~150 rows into the review queue.

**Cost control.** Verdicts cache on `(token, side, payee_key)`, not per narration. Urban
Plant's 148 side-rule rows collapse to roughly 8-10 Claude calls. The Bigfoot refund has a
different payee key from the Bigfoot UPI payments, so it still gets its own call — which is
exactly why it is caught.

### 5.6 Learning

After every corrections ingestion, `deriveSideRules(brandId)` groups confirmed corrections
by extracted vendor key and splits them by side:

- **≥2 rows on each side**, different majority ledger per side, no existing rule
  → create `status='active', source='learned'`
- fewer than 2 rows on a side, **or** contradicts a `seed` / `manual` rule
  → create `status='suggested'`, requiring one accountant click
- accountants may add, edit, disable and reorder rules by hand, with a bulk paste for
  loading many at once

Run against Varshita's audited file this mints the Delhivery, Razorpay, BusyBees and
Flipkart rules automatically — replacing the hand-written JSON work done in July.

---

## 6. Component 3 — correction ingestion

### 6.1 Column precedence

Replace first-match header binding with explicit precedence:

1. header matching `correct|revised|final|actual|changes` **and** mentioning a ledger
   → the **correction** column
2. otherwise a plain `ledger name` / `tally` / `chart of account` header
3. when both exist, (1) is the correction and (2) is read as the **predicted** value

This binds `Correct Ledger Name` (Urban Plant) and `Correct Ledger Names` (M Brands)
correctly.

### 6.2 New inputs

- **Debit / Credit amounts.** Without the side, `deriveSideRules` has no input. This is what
  makes Component 2's learning possible at all.
- **Both ledger columns.** Rows where predicted and corrected *agree* are confirmations
  (evidence a rule is right); rows where they differ are corrections. Both are signal,
  stored with different `source` values.

### 6.3 What gets stored per corrected row

The exact narration (as today), **plus** the generalizable keys from Component 1,
**plus** the side. That is what turns one accountant edit into something that fires the
following month.

---

## 7. Component 4 — confidence and provenance

1. Add `'Side Ledger'` to `AUTHORITATIVE` — **primary tier only**. The `fallback` tier
   (Salary / Stipend / Employee → `Salary Payable`) stays arbitrable, preserving Claude's
   corrections to named ledgers such as `Azad-Salary A/c`. After this, arbitration only ever
   touches keyword and fuzzy-COA rows, which is what it was built for.

2. Add a **`Source`** column to the output workbook: `Side Rule`, `Side Rule (flipped)`,
   `Stored`, `Directory (name)`, `Statutory`, `Keyword`, `Fuzzy COA`, `Claude`, `Suspense`.
   Today "High" is unfalsifiable from the accountant's seat. Provenance lets a bad layer be
   spotted in one glance instead of by auditing 261 rows, and it yields a per-layer accuracy
   report every month.

3. **A row with no rule, where Claude picks a ledger, lands Medium — not High.** On Urban
   Plant that is roughly 60 rows moving into review on the first run. The cost is
   front-loaded and self-liquidating: as the directory learns from those same corrections,
   the vendors resolve via layer 3 next month and return to High on their own.

---

## 8. Testing

| Component | Test | Location |
|---|---|---|
| 1 Extractor | Shared fixture of real narrations → expected keys, run by **both** suites; negative cases assert no key | extend `new-backend/scripts/tests/test_payee_keys.py` + new JS mirror |
| 1 Backfill | Idempotent; conflict rule keeps most recent; contested keys skipped and listed | new script test |
| 2 Side rules | Longest-token-wins ordering; empty table falls back to seed JSON; ledger missing from COA is skipped | new unit test |
| 2 Claude verdicts | Mocked: agree → High · flip → High+flipped · abstain → Medium · not-this-vendor → falls through · **error → High + log** | new unit test |
| 3 Ingestion | Correction column wins over predicted; Dr/Cr captured; agreements and corrections stored distinctly | new controller test |
| 4 Confidence | Side-rule rows survive arbitration; unruled Claude picks land Medium | extend `bank_reco_benchmark.py` |

### Acceptance test

Not a re-run of June — exact-match would score ~100 % and prove nothing.

1. Backfill Urban Plant and M Brands from `bank_payee_directory` rows with
   `updated_at` **before 2026-06-01**, so nothing learned from the June statements
   themselves can leak into the score.
2. Run the **June** statements cold:
   - `1646119491_statement.csv` (M Brands, Kotak)
   - `OpTransactionHistoryUX301-07-2026 (1).xls` (Urban Plant, ICICI)
3. Score against Varshita's `Correct Ledger Name` column.

Baselines: Urban Plant **32.2 %**, M Brands **84.4 %**. Target **> 95 %** on both.
`bank_reco_benchmark.py` prints a per-layer breakdown so a shortfall identifies the leaking
layer rather than requiring a guess.

---

## 9. Rollout

1. `cp -a <file>.bak-$(date +%Y%m%d-%H%M%S)` for every file touched: `classify.py`,
   `recoController.js`, `bankCorrectionsController.js`, and both side-map JSONs.
2. All work on **local 3000** (`colonel-automation`). The 3001 sandbox is untouched.
3. DB changes additive only; backfill writes `source='backfill'` so undo is one `DELETE`.
4. Backfill runs against a **local copy** of the two brands' data first; the diff is
   reviewed before anything further.
5. Run the benchmark; report the accuracy table.
6. **Stop.** No AWS. Deployment is a separate conversation requiring explicit permission,
   and when it happens: `pg_dump` first, file backups on the box, rollback by restoring the
   `.bak-` files and deleting the `source='backfill'` rows.

---

## 9a. Implementation status (2026-07-27, local 3000 only)

All four components are built. Nothing has been deployed to AWS.

| Component | Status |
|---|---|
| 1 Extractor (Python + JS) | Done. 7 new rails, shared `payee_key_fixtures.json` asserted by BOTH suites |
| 1 Backfill | Done — `new-backend/scripts/backfill_payee_keys.js`, dry-run by default. Applied locally: Urban Plant 84 keys, M Brands 103, 53 leaked phone rows deleted |
| 2 `bank_side_rules` | Done — `db-restructure/023_bank_side_rules.sql` (RLS + grants), applied locally; 21 rules seeded from the JSON |
| 2 DB-first side map | Done — `recoController.resolveSideMapPath()`, falls back to seed JSON, then to no map |
| 2 Learning | Done — `deriveSideRules()` runs after every corrections upload |
| 3 Ingestion | Done — correction column wins by precedence; Dr/Cr captured; agreements vs corrections distinguished |
| 4 Confidence | Done — `Side Ledger (credit/debit)` whitelisted; unruled Claude picks land Medium |
| 4 `Source` column | Done — appended as column 10, invisible to recoController's fixed 1-9 reads |

### Measured results

Rules only, no Claude (reproducible without an API key):

| Brand | Live (Varshita) | New rules-only |
|---|---|---|
| Urban Plant | 32.2 % (84/261) | **77.4 %** (202/261) |
| M Brands | 84.0 % (189/225) | 79.6 % (179/225) |

M Brands' live 84.0 % *included* Claude's fallback and arbitration, so it is not a
rules-only baseline; against the same bar both numbers are 79.6 %.

With Claude (one real API run, on the build before the last three key fixes — provisional
until re-run): Urban Plant **80.5 %**, M Brands **89.3 %**. Side-verdict pass reported
132/135 and 135/135 CONFIRM with **0 flips and 0 disowns**, i.e. the arbitration failure
cannot recur.

Month-over-month learning (train on the first half of the statement, score the second half
cold) — the loop that had never once fired before:

| Brand | Month 2 cold | After month-1 corrections |
|---|---|---|
| Urban Plant | 79.4 % | **87.8 %** (+8.4 pp) |
| M Brands | 75.2 % | 75.2 % (only 21 generalizable keys from 112 rows) |

**The > 95 % target is not met.** The largest remaining block is Amazon: the key
`amazon sel` maps to *both* `Receipt From Amazon (Shopify)` (16 rows) and
`Receipt From Amazon` (4) in the accountant's own corrections — genuinely ambiguous from
the narration, so no extractor or rule can separate them. It needs either a second key
dimension or an accountant-authored rule.

### Bugs found by the acceptance test (all fixed)

1. The side-verdict prompt never stated the bank's Dr/Cr, so Claude inferred direction from
   wording and flipped 43 M Brands rows — an 84.0 % → 69.3 % regression, caught before it
   could ship.
2. `bank account xx` — a bank placeholder became a payee key, collapsing three unrelated
   payees onto one ledger.
3. `ubin` — an IFSC prefix leaked once the 4-letter guard was relaxed to save the real
   4-letter name `AZAD`.
4. Rejecting bank prefixes outright then cost 14 correct rows, because
   `INF/NEFT/<ref>/HDFC0000044/HDFC` is a transfer to the brand's own HDFC account. Final
   rule: a bank prefix loses to a real payee that follows it, and is used only when it is
   alone in the payee slot.

### Regression status

`test_payee_keys.py` (5 tests incl. 14 shared fixtures), `test_payee_keys_parity.js`
(14 fixtures), `test_bank_reco.py` (9 tests) — all pass. FLO's and Zaydn's existing keys
are untouched.

### Cross-brand impact

Only one change reaches the other 15 brands: unruled Claude picks now land **Medium**
instead of High (§7.3). Everything else is gated on a brand having side rules — only Urban
Plant and M Brands do.

---

## 10. Evidence appendix

All figures verified during the 2026-07-27 investigation.

- Job `4e8cab91-c2c9-46e5-9d9f-95155be30c96`, output `b2398b78…`, Urban Plant, 261 rows,
  2026-07-27 07:07 UTC, `varshita.colonel@gmail.com`.
- Job `1d0fb5b4-b219-4320-a32c-b2e48d01293f`, output `62c41ab8…`, M Brands, 225 rows,
  2026-07-27 07:54 UTC, same user.
- Backend log confirms `[RECO] Side-ledger map attached` for both runs, and
  `[RECO-CORRECTIONS] Wrote 598 Layer 0 corrections` for Urban Plant.
- Urban Plant COA: 891 ledgers, `source='coa_upload'`, unchanged since 2026-07-06. It
  contains `Receipt From Delhivery`, `Receipt From Razorpay`, `Receipt From Busy Bees`,
  `Receipt From Flipkart` and `Petty Cash` — so the side-map entries were valid at run time.
- Local reproduction with the identical COA and directory but no Anthropic key yields the
  correct side-map ledgers, isolating arbitration as the cause.
- Side-map decided 148 Urban Plant rows; 89 were broken by arbitration; protecting them
  gives 173/261 = 66.3 %.
- The 598 learned Urban Plant entries match 0 of 261 June rows.
- `bank_payee_directory` totals 2,979 rows across 4 of 17 brands.
- `bank_reco_corrections` totals 15,020 rows, but **none** belong to Urban Plant or
  M Brands: FLO 14,017, Stroom 580, Koparo 423. Both in-scope brands keep their stored
  corrections in `bank_payee_directory` under `key_type='exact'`.
- Of the `phone` keys, 37 of 44 (Urban Plant) and 16 of 19 (M Brands) fail
  `^[6-9]\d{9}$` — 53 rows to delete.
