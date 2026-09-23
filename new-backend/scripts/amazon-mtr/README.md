# Amazon India MTR parser (Merchant Tax Report)

Deterministic parser + sales register for Amazon India GST MTR exports.
Python 3, stdlib + `openpyxl`. No LLM, no n8n, no network.

```
python3 mtr_parser.py        "<folder-of-csvs>"                     # verification report
python3 mtr_parser.py        "<folder-of-csvs>" --json               # typed rows as JSON
python3 build_sales_register.py "<folder-of-csvs>" out.xlsx          # the workbook
```

`mtr_parser.py` exits non-zero if any row fails a check.

Built and verified against **SIMK LABELS PRIVATE LIMITED (Koparo)**, 13 files,
April–August 2026, 7,113 rows.

---

## What the data actually is

Three report flavours, detected from the columns and the content — never from
the file name, because the names here are folder paths a human typed.

| Flavour | Cols | Tells it apart |
|---|---|---|
| `B2B` | 89 | has `Bill To *`, `Customer Bill To Gstid`, `Buyer Name`, `Irn *` |
| `B2C` | 78 | none of the above |
| `STOCK_TRANSFER` | 37–38 | `Gstin Of Receiver`, `Ship From Fc` — a completely different vocabulary |

`Transaction Type` values found across all 13 files:

| Flavour | Value | Rows |
|---|---|---|
| B2B | Shipment / Cancel / Refund / **EInvoiceCancel** | 177 / 37 / 3 / 2 |
| B2C | Shipment / Cancel / Refund | 5,507 / 1,199 / 144 |
| STOCK_TRANSFER | FC_REMOVAL / FC_TRANSFER / **FC_REMOVAL-Cancel** | 36 / 6 / 2 |

---

## The surprising things

**1. Three files do not start with their header.**
`MTR_B2B-MAY`, `MTR_B2C-MAY` and `MTR_B2B-JUNE` were opened in Excel and
re-saved with a hand-typed totals row pasted *above* the header, plus a blank
line. A reader that trusts line 1 takes the totals row as the header, gets 89
empty column names, and every field comes back blank — while still reporting a
plausible row count (two too many). The header is therefore **found** by
looking for `Transaction Type`, and the preamble is kept and footed against our
own roll-up rather than discarded. All four preamble subtotals in the May B2B
file agree to the paisa; the June B2B ones were typed rounded to whole rupees
and agree within ₹0.34.

**2. Two timestamp formats, and the second one is ambiguous-looking.**
Amazon writes `YYYY-MM-DD HH:MM:SS` (Apr B2C, Jul B2B, Jul B2C). The
Excel-touched files were rewritten to `DD-MM-YYYY HH:MM`. It is day-first, not
US month-first: the first field reaches 31 and the second field always equals
the report month. Both are parsed; neither is assumed.

**3. Refunds are already negative. Do not flip them.**
On a `Refund` row, `Invoice Amount`, `Tax Exclusive Gross`, every tax head and
every `* Amount Basis` column arrive negative. Negating them "to make them
returns" double-counts the wrong way. Verified: 147/147 refunds negative,
5,684/5,684 shipments positive, 1,236/1,236 cancels exactly nil.

**4. …but `Principal Amount`, `Shipping Amount` and `Quantity` are *not* signed.**
A refund of ₹199 shows `Principal Amount = 199` and
`Principal Amount Basis = -168.64`. **Taxable value must come from the `* Basis`
columns**, never from `Principal Amount`. Proved on every row:
`Tax Exclusive Gross == principal + shipping + giftwrap + the three promo bases`,
0 failures in 7,069. `quantity_signed` is derived from the sign of the money,
because the quantity itself is not signed.

**5. A refund carries the *original* invoice date, sometimes months old.**
All 147 refunds have an invoice date from an earlier month (up to three months
back) and a `Credit Note Date` inside the report period — 147/147. Grouping on
invoice date posts returns into months already filed. The parser exposes
`doc_date` = credit-note date for a refund, invoice date otherwise, and every
sale row's invoice date is in-period, so `doc_date` is always the right key.

**6. B2B tax follows the BILL-TO state, not the ship-to state.**
Nine B2B rows are taxed on `Bill From → Bill To` while the carton went
somewhere else (bill-to/ship-to, s.10(1)(b) IGST Act). Six more rows are AFN
(Amazon-fulfilled) and are taxed on the **fulfilment centre's** state, not the
seller's nominal Delhi address. The rule that holds on **all 5,833 taxed rows
with zero exceptions** is:

> origin = `Ship From State` (fallback `Bill From State`);
> destination = `Bill To State` if present else `Ship To State`.
> Same → CGST+SGST/UTGST. Different → IGST.

A naive `Ship From → Ship To` rule produces 9 false positives; a naive
`Bill From → Bill To` rule produces 6 different ones.

**7. `Total Tax Amount` is net of promotional tax, so the plain head sum does
not always foot.** 15 rows disagree. 14 of them are a ₹40 shipping charge fully
absorbed by a ₹40 shipping promotion: Amazon prints `Shipping Igst Tax = +6.10`
*and* `Shipping Promo Tax = -6.10`, and `Total Tax Amount` is net of both. The
identity that does hold is `Total Tax = heads + promo tax`. Both checks are run
and reported separately, because a GSTR-1 preparer footing the five heads will
hit the first one.

**8. `EInvoiceCancel` is a ±pair, not a nil row.** May B2B lines 64–65 are
invoice `IN-3479` emitted twice, −296.01 and +296.01, netting nil. It is given
its own `kind` so the "a cancel is nil" assertion does not fire on a correct
pair.

**9. 1,222 taxed rows have no HSN code.** ₹641,082.59 of taxable value, 36.6%
of five-month turnover, across 8 SKUs
(`FABCON-5L`, `TOILETCLEANER`, `06-TEPP-REP4`, `1H-BZR6-20OZ`, `90-X8YV-Q3DM`,
`BB-82F6-CB35`, `HB-LBSM-HP4K`, `NC-ZBW2-D0JV`). Those 8 SKUs carry no HSN
anywhere in the five months, so this cannot be back-filled from the data — it
needs the client's item master. GSTR-1 Table 12 cannot be completed without it.

**10. Every single supply in these files is at 18%.** Rate combinations found:
`(0,0,0)` × 1,236 (cancels), `(0,0,0.18)` × 5,417, `(0.09,0.09,0)` × 416.
Zero cess anywhere. Rates are stored as **fractions** (`0.18`), not percentages.

**11. Six registrations.** Seller GSTIN state code always equals `Ship From
State` (7,113/7,113): 07 Delhi (7,026), 19 West Bengal (31), 29 Karnataka (4),
06 Haryana (3), 24 Gujarat (3), 27 Maharashtra (2).

**12. Column names differ between B2B and B2C.** B2C calls it
`Shipping Cess Tax Amount`; B2B calls it `Shipping Cess Tax`. B2C also emits
`Igst Tax` before `Utgst Tax` (B2B is the other way round). Everything is
looked up by normalised name, never by position.

---

## Checks run on every row

1. `Invoice Amount == Tax Exclusive Gross + Total Tax Amount`
2. `Tax Exclusive Gross ==` sum of the six `* Amount Basis` columns
3. `Total Tax Amount ==` cgst+sgst+utgst+igst+cess across item/shipping/giftwrap
4. `Total Tax Amount ==` the above **+ promo tax** (the identity that holds)
5. each head `== rate × its own block's basis`, ±0.05
6. place of supply vs tax head (rule in point 6 above)
7. sign convention: refund negative, shipment positive, cancel nil
8. seller GSTIN state code `==` ship-from state
9. `doc_date` inside the report period

Nothing that fails is dropped. Failures land in the workbook's **Exceptions**
sheet and in the CLI report, with file, line number and amounts.

## Money

`Decimal` end to end. Floats appear only in `build_sales_register.f()`, at the
moment of writing a cell, because openpyxl cannot store a `Decimal`. Money cells
use `#,##0.00;-#,##0.00`; rate cells are real numbers under `0.00%` — never the
string `"18%"` and never a bare `0.18` under General, which is how a 0.18% rate
ends up in a return.

## Files

| File | What |
|---|---|
| `mtr_parser.py` | reader, type detection, normalisation, all nine checks, CLI report |
| `build_sales_register.py` | the workbook (Summary / State-wise / Detail / Stock Transfers / Exceptions) |
