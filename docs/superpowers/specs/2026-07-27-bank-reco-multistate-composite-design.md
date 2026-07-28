# Bank Reco — Multi-State Ledger + Composite Voucher Fixes (FLO)

**Date:** 2026-07-27
**App:** colonel-automation (port 3000 / backend 8001 / reco-engine)
**Scope:** local only — **no AWS deploy** without explicit permission
**Files touched:** `new-backend/scripts/bank_reco.py`, `new-backend/scripts/classify.py`
**Backups:** `cp -a <file> <file>.bak-$(date +%Y%m%d-%H%M%S)` before editing each.

---

## Problem

The FLO Bank Reco (Universal Bank Statement → "Reconcile with Tally" → `bank_reco.py`) has three
linked defects, all rooted in how multi-state vendors (e.g. **Busybees Logistics Solutions
Pvt.Ltd.** with `-Delhi / -Telangana / -Bangalore` variants) and composite Tally vouchers are handled.

### ① Composite `(as per details)` vouchers are dropped → false "Bank-only → add"
Tally exports a multi-party payment as a **header row** (party = `(as per details)`, the *total* in
the Credit column) followed by **sub-rows** where each real party sits in Particulars (col C) and its
**amount is in the Vch No. column (H), not Debit/Credit**. Example (raw Tally file rows 22–24):

```
Row 22  Payment  (as per details)   Vch 5    Credit = 910973.87   ← lump total (header)
Row 23    Busybees Logistics Solutions Pvt.Ltd.     VchNo col = 392265.55   ← sub-line
Row 24    Busybees Logistics Solutions Pvt.Ltd.     VchNo col = 518708.32   ← sub-line
```
`parse_tally` skips any row with Debit==0 **and** Credit==0 (bank_reco.py:95), so the two Busybees
sub-lines are never read. Result: their bank counterparts (392265.55, 518708.32) fall to **Bank-only
→ add** even though they ARE in Tally. (392265.55 + 518708.32 = 910973.87 = the header total.)

### ② Universal Output guesses the state
`classify.py` matches the identical Busybees narration (`NEFT/…/UTIB/Busybees Logistics Solution`) to
*one* of the several `Busybees…-<State>` master ledgers. The NEFT text never names the state, so the
picked state is a guess and is frequently wrong.

### ③ Reconciliation can prove the state — from Tally — but doesn't use it
When a bank line matches a Tally entry by date+amount, the matched Tally party already carries the
correct state (e.g. `Busybees…(Delhi)`). Today the Reconciliation/Add-to-Tally output still shows the
classifier's guessed (or blank) ledger, not the Tally-proven state.

---

## Design

The three fixes chain: the **classifier blanks the unknowable state** (A) → **reco fills it back
where Tally proves it** (B) → **composite vouchers are exploded so those party lines can match at all**
(C). A single machine-readable marker string ties A and B together.

### Marker
```python
ADD_STATE = "⟨add state⟩"    # ⟨add state⟩  — inline, travels with the ledger name
```
A stateless multi-state ledger renders as `f"{base}- {ADD_STATE}"` (e.g.
`Busybees Logistics Solutions Pvt.Ltd.- ⟨add state⟩`), matching the format the user approved.

### Fix A — `classify.py`: stop guessing state (FLO-gated)
- Gate on `self._brand_name` resolving to FLO (same pattern as the M-Brands `side_map` gate). Other
  brands are unchanged for now.
- **Post-match guard** (runs after the row's ledger is chosen, before it's written): let `chosen` be
  the picked ledger.
  1. `base = strip_state(chosen)` — strip a trailing `-<State>` or `(<State>)` suffix. Reuse a
     location regex analogous to `bank_reco._LOC_SUFFIX` (dynamic; no hardcoded vendor names).
  2. `variants = [l for l in master_ledgers if strip_state(l) == base]`.
  3. If `len(variants) > 1` **and** the narration contains none of the variant states →
     replace the output ledger with `f"{base}- {ADD_STATE}"`.
     If the narration *does* name one variant's state, keep that specific variant (not ambiguous).
- Confidence for a blanked row stays as-is (still a real, if partial, identification).

### Fix C — `bank_reco.py` `parse_tally`: explode composite vouchers
Restructure the row loop to be stateful:
- A row is a **voucher header** if it has a parseable date OR a non-empty Vch Type.
- Header whose party normalizes to `as per details` → **composite parent**: remember
  `{date, direction, vch_type, vch_no, narration}`; do **not** emit it (it's a lump).
- Header with a real party → emit normally (unchanged); clear any pending composite parent.
- **Sub-line** = row with no date, no Vch Type, Debit==0, Credit==0, a party present, and
  `_num(vch_no_cell) > 0`, while a composite parent is pending → emit one row:
  - `date/narration/vch_type/vch_no/direction` inherited from the parent,
  - `party` from col C,
  - amount from the Vch No. cell: parent direction `out` ⇒ `credit = amt`; `in` ⇒ `debit = amt`.
- Opening/closing/grand-total rows stay excluded (existing party-text filter; no composite parent
  pending at those rows anyway).

Net effect: Tally rows 23–24 become two matchable Busybees payment lines of 392265.55 and 518708.32,
which then match their bank counterparts instead of showing as Bank-only.

### Fix B — `bank_reco.py`: resolve state from Tally, else keep the marker
Keys entirely off the marker, so it's automatically consistent (and bank_reco is FLO-only anyway):
- In the **Reconciliation** sheet + `_build_results` + **Add to Tally**, when the bank row's Ledger
  Name contains `ADD_STATE`:
  - **Matched** to a Tally party that has a state qualifier → display the **matched Tally party** as
    the resolved ledger (authoritative, exists in COA). e.g. bank `Busybees…- ⟨add state⟩` + Tally
    `Busybees…(Delhi)` → `Busybees…(Delhi)`.
  - **Matched** to a Tally party with **no** state (e.g. the exploded `Busybees…` sub-lines, which
    themselves carry no state) → **keep the `⟨add state⟩` marker** (Tally can't prove it either).
  - **Unmatched** (Bank-only) → keep the marker; the Add-to-Tally Dr Ledger shows
    `Busybees…- ⟨add state⟩` so the human knows to set the state on paste.
- Ledgers without the marker are untouched. Tally-only / Date Updates already use the Tally party
  (correct state) — no change.

---

## Non-goals / invariants (per CLAUDE.md golden rules)
- No hardcoded vendor names, sheet names, row indices, or state lists beyond a generic location regex.
- Reco logic stays dynamic; the 9-sheet workbook layout and tab order are preserved (no new sheet;
  the marker is inline per the approved choice).
- `.xls`→`.xlsx` in-memory read path unchanged. DB-persistence path (fire-and-forget) untouched.
- classifier change gated to FLO; every other brand's Universal output is byte-for-byte unchanged.

## Verification
Re-run against the real FLO files in `/Users/dhavalchauhan/Dhaval/Bank RECO/`
(`Bank Statement Apr 24-25 Tally.xls`, `Bank Statement RBL.xlsx` classified → Universal output),
tolerance ₹1.0, and confirm:
1. **Composite fix:** Busybees 392265.55 and 518708.32 move from **Bank-only → Matched** (Reconciliation).
2. **Classifier:** Universal Output Busybees rows read `Busybees Logistics Solutions Pvt.Ltd.- ⟨add state⟩`
   (no guessed state); non-multi-state ledgers unchanged.
3. **State resolution:** matched Busybees lines whose Tally party has a state show that state
   (e.g. `…(Delhi)`); unmatched / stateless-in-Tally lines keep `⟨add state⟩`.
4. **No regression:** overall Matched count rises (composite lines now match), Summary money-in/out
   unchanged, other brands' classifier output identical (spot check one non-FLO run).
5. Diff the counts against the current `FLO_Bank_Reco_Output.xlsx` baseline to quantify the shift.
