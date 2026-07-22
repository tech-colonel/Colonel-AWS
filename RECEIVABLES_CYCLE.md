# 💰 Receivables Cycle — how every dashboard number is calculated

> Companion to [RECO.md](RECO.md) — that doc covers the per-run Receivable Cycle
> agent (upload → Main Sheet/COD sheets Excel). **This doc covers the global
> Receivable Dashboard** (`/brands/:brandId/receivables`, `ReceivableDashboard.jsx`)
> and the exact formula, source columns, and SQL behind every card and drill-down
> modal on it — written so a non-engineer can audit a number back to its source file.

---

## 1. Data flow

```
Raw Excel files (Tally GST, courier settlements, SRN registers)
        │  loaded verbatim, one JSON row per Excel row
        ▼
receivable_cycle_imports   (brand_id, source_file, sheet_name, row_index, row_data JSON)
        │  new-backend/scripts/buildReceivableLedger.js  (batch ETL, re-runnable)
        ▼
receivable_ledger          (ONE ROW PER ORDER — brand_id, awb, invoice_key, order_date,
                             payment_method, courier, channel, total_amount, settled_*,
                             returned_*)
        │  new-backend/src/controllers/dashboardController.js → getReceivableDashboard
        ▼
GET /api/dashboard/receivables/:brandId?month=&year=
        │
        ▼
ReceivableDashboard.jsx — KPI cards + drill-down modals + sheet browser
```

The ETL (`buildReceivableLedger.js`) is a **batch rebuild**, not a live sync: it
clears the ledger for the brand and rebuilds it from every file sitting in
`receivable_cycle_imports`. It does not touch the live per-upload Receivable Cycle
pipeline (`recoController.js`) — that still produces its own Excel output
unchanged, per the "never touch working reco logic" rule.

---

## 2. `receivable_ledger` — one row per order

| Column | Meaning |
|---|---|
| `awb` | Courier tracking number (normalized: uppercased, whitespace stripped, trailing `.0` from Excel float-ification removed). Primary match key. |
| `invoice_key` | Normalized invoice number. Fallback match key for orders with no AWB (e.g. Self Shipping). |
| `order_date` / `order_month` / `order_year` | The order's own sale date, from the Tally row's `Date` column. |
| `payment_method` | `COD` or `PREPAID`, from Tally's `Payment Method` column. |
| `courier` | Bucketed from Tally's `Shipping Provider` column (COD orders only — see §3). |
| `channel` | Bucketed from Tally's `Channel Ledger` column — which sales portal (see §3). |
| `total_amount` | **Sum** of the `Total` column across every product-line row sharing the same AWB/invoice (see §3 — the raw Tally sheet is one row per SKU, not per order). |
| `settled_flag`, `settled_amount`, `settled_month`, `settled_year`, `settled_source` | Whether/when/how much this order's COD amount was remitted, and by whom (`ekart` / `xpressbees` / `delhivery` / `prepaid`). |
| `returned_flag`, `returned_amount`, `returned_month`, `returned_year` | Whether/when this order was returned per the SRN/credit-note register, and for how much. |

`settled_*` and `returned_*` are **deliberately independent** — not one
`pending/settled/returned` status enum. An order can be settled in month X and
still returned in month Y afterwards; collapsing that into one status would
either block the return from posting or silently erase the settlement from its
own month's "received" total.

**"Still receivable" = `NOT settled_flag AND NOT returned_flag`.** Every pending/
receivable figure on the dashboard checks *both* flags, not just `settled_flag` —
a returned COD order is never real cash (RTO'd before collection, or collected
then refunded) and must stop counting as outstanding the moment `returned_flag`
is set, regardless of which month the return itself landed in. See §4 for the
worked examples this is built to satisfy.

---

## 3. How each column is derived — source files & business rules

### 3.1 Tally Main Sheet (`Combined Tally GST report FY 24-25 - Copy.xlsx` :: `Main Sheet`)

| Ledger column | Tally source column(s) | Rule |
|---|---|---|
| `awb` | `AWB num` | Normalized (uppercase, no whitespace, `.0` stripped) |
| `invoice_key` | `Invoice number` | Normalized |
| `sale_order_number` | `Sale Order Number` | as-is |
| `order_date`/`month`/`year` | `Date` | Parsed; rows with no parseable date are skipped entirely (can't be bucketed) |
| `payment_method` | `Payment Method` | Uppercased; defaults to `COD` if blank |
| `courier` | `Shipping Provider` | Only set for COD rows — see bucketing rule below. Blank for PREPAID. |
| `channel` | `Channel Ledger` | See bucketing rule below |
| `total_amount` | `Total` | **Summed** across every row sharing the same `awb` (or `invoice_key` when no AWB) |

**Why `total_amount` is a SUM, not a single value:** the Main Sheet is one row
per *product line*, not per invoice — a multi-item order has the same
AWB/invoice repeated once per SKU, each with its own line-level `Total`.
Confirmed against real data: one real invoice had 11 line rows summing to its
true invoice value; taking just the first row would have undercounted that
order by ~87%. Every order's `total_amount` is the sum of all its line rows.

**Courier bucketing** (`courierBucket()` in `buildReceivableLedger.js`), applied
to `Shipping Provider`, uppercased, substring match:

| Contains | → Bucket |
|---|---|
| `DELHIVERY` | Delivery |
| `EKART` | Ekart |
| `XPRESSB` | Xpressbees |
| `DTDC` | DTDC |
| `SELF` | Self shipping |
| *(none of the above)* | Other COD |

**Channel/portal bucketing** (`channelBucket()`), applied to `Channel Ledger`,
uppercased, substring match, in this priority order:

| Contains | → Portal |
|---|---|
| `SHOPIFY` | Shopify |
| `FLIPKART` | Flipkart |
| `AMAZON`, `AMZ`, or `FLEX` | Amazon |
| `PEPPERFRY` | Pepperfry |
| `ZEPTO` | Zepto |
| `WOODENSTREET` | WoodenStreet |
| `SNAPMINT` | Snapmint |
| `CRED` | CRED |
| `HUSH` | Hush B2B |
| `INFLUENCER` | Influencers |
| starts with `CUSTOM`, or contains `QC LAPSE` | Custom / Manual |
| *(none of the above)* | Other |

(33 distinct raw `Channel Ledger` values exist in the real data — mostly
regional Amazon Flex/Flipkart warehouse variants — which is why this buckets
into portals rather than showing all 33.)

**Prepaid rule:** immediately after loading, every `PREPAID` row is marked
`settled_flag = TRUE`, `settled_amount = total_amount`, `settled_month/year =
order_month/year`, `settled_source = 'prepaid'` — prepaid is always treated as
received in the same month as the sale (confirmed product decision; no
Razorpay-file verification in this phase).

### 3.2 Courier settlement files → `settled_*`

| Source | File :: sheet | AWB column | Amount column | Date column (priority order) |
|---|---|---|---|---|
| `ekart` | `combined ekart settelment report.xlsx` :: `Combined` | `TRACKING_ID`, fallback `SHIPMENT_ID` | `COD_AMOUNT` | `DELIVERY_DATE`, fallback `date` |
| `xpressbees` | `Xpressbees combined.xlsx` :: `Combined` | `Shipping Id`, fallback `POID` | `Net Payment` | `Delivery Date` → `Shipping Date` → `Transaction Date` → `date` |
| `delhivery` | `combined delhivery remmittance.xlsx` :: `Delhi vary 25-26` | `waybill_num` | `payable`, fallback `cod_amount`, fallback `cod` | `pickup_date`, fallback `status_date` |

Matching: each settlement row's normalized AWB is matched against
`receivable_ledger.awb` **for that brand only, across every month ever
loaded** — this is what lets a Feb settlement clear a Dec order. Only rows
where `settled_flag = FALSE` are eligible (first-match-wins; a duplicate AWB
within one settlement file also resolves last-wins before matching). A
settlement AWB with no match in the ledger is logged to
`receivable_ledger_unmatched` (source = courier name) instead of silently
dropped — usually because that order's original Tally file hasn't been loaded
yet.

### 3.3 SRN / returns files → `returned_*`

| File :: sheet | Match column(s) | Amount | Date (priority order) |
|---|---|---|---|
| `Combine SRN Apr-25 to Oct-25.xlsx` :: `Sheet1` | `Original Invoice No`, fallback `Original Invoice No.1`; AWB fallback via `AWB num` | `Total` | `Date` → `Return Date` → `Credit Note Date` → `Invoice Date` |
| `Unicommerce Refunds Working FY 24-25.xlsx` :: `Refunds` | `Original Invoice No` / `.1` (no AWB column in this file) | `Total` | same priority order |

Matching precedence: **invoice number first** (against `receivable_ledger.invoice_key`),
**AWB as fallback** for rows with no invoice match — mirrors the same
precedence the per-job engine (`reco-engine/recon/receivable_cycle.py`,
`parse_srn`) uses. Only rows where `returned_flag = FALSE` are eligible. An
unmatched SRN row is logged to `receivable_ledger_unmatched` (source = `srn`).

---

## 4. Dashboard cards — exact formula

All queries below run against `receivable_ledger` scoped to `brand_id = $1`,
with `$2` = selected month, `$3` = selected year. "As of date" comparisons use
`(order_year * 12 + order_month)` so month/year pairs compare correctly across
year boundaries.

**Optional "cycle start" (`$4` in every query below):** the dashboard has a
second picker, above the "as of" month/year one, letting the user set a
`startMonth`/`startYear`. When set, `$4 = startYear*12 + startMonth`
(otherwise `$4 = 0`, a sentinel below every real order index so it's always
satisfied) and **every single query in this endpoint** adds
`AND (order_year * 12 + order_month) >= $4` — an order sold before the cycle
start is treated as if it never existed, for sales, receivable, settlements,
and returns alike, not merely excluded from carried-forward. This exists
because some months' source data is known-incomplete (e.g. the missing
Delhivery FY24-25 settlement file, §6) — setting a cycle start lets a CFO say
"only count from the month our data is trustworthy onward." If the *selected*
month/year itself is before the cycle start, the endpoint short-circuits and
returns `{ beforeCycleStart: true, cycleStart: {month,year}, kpis: null, ... }`
before running any of the queries below — there is no partial view of a month
that predates the cycle's own origin.

The dashboard's top row is one deliberate equation, read left to right, so a
CFO can see the whole story without opening a single modal:
```
Net sales − Received = Receivable          (all three, this month's own sale)
```
All three cards below share the exact same population (COD+Prepaid) and the
exact same time semantic (status of this month's own orders, **as of today**
— not "as of the end of that month"), which is what makes the subtraction
land exactly on the third number, every month, to the rupee. A secondary row
below it ("All-time position & cash flow") holds four more figures that are
deliberately **not** part of this equation — see the note at the end of this
section for why.

### Net sales — {month} (1st card in the equation)
```sql
sales_this_month = SUM(total_amount) WHERE order_month = $2 AND order_year = $3   -- gross

returned_of_this_months_sales =
  SUM(total_amount) FILTER (WHERE order_month = $2 AND order_year = $3 AND returned_flag)

net_sales_this_month = sales_this_month − returned_of_this_months_sales   -- ← card shows THIS
```
COD + Prepaid combined, this month's orders only (by `order_date`, not by when
money moved). The KPI card's headline number is the **net** figure; the gross
`sales_this_month` and the returned amount are both shown in its subtitle,
never hidden.

`returned_of_this_months_sales` counts a return regardless of which month the
return itself was *processed* in — an order sold in March that gets returned
in April still reduces March's net figure once the return lands. This is a
different slice than the "Returns (SRN)" card in the secondary row, which
counts returns *processed* in the selected month regardless of the original
sale's month.

### Received — {month} (2nd card in the equation)
```sql
settled_of_this_months_sales =
  SUM(total_amount) FILTER (WHERE settled_flag AND NOT returned_flag AND order_month = $2 AND order_year = $3)
```
**This is an accrual figure, not a cash figure**: how much of *this month's
own orders* has been settled **as of today**, no matter which calendar month
the settlement itself happened in (next month's courier remittance run still
counts here). It is deliberately not `SUM(settled_amount) WHERE settled_month
= $2` (that's the "Cash collected" card in the secondary row below) — using
`order_month` instead of `settled_month` as the anchor is exactly what makes
`Net sales − Received = Receivable` hold. Click it for the by-source
breakdown (`settledOfThisMonthsSalesBySource`, §5) — how much, and from
where (Ekart / Xpressbees / Delhivery / Prepaid).

### Receivable — {month} (3rd card in the equation)
```sql
this_month_own_receivable =
  SUM(total_amount) FILTER (WHERE NOT settled_flag AND NOT returned_flag AND order_month = $2 AND order_year = $3)
```
COD + Prepaid combined — still uncollected, from this month's own sale,
**as of today**. This is the exact complement of the first two cards:
```
sales_this_month − returned_of_this_months_sales − settled_of_this_months_sales
  = this_month_own_receivable
```
Verified against real data (March 2025, Flo Mattress): ₹19,63,06,631.58 −
₹2,90,16,093.75 − ₹15,91,34,994.53 = ₹81,55,543.30, exactly. Click it for the
by-partner breakdown (`thisMonthPendingByCourier`, §5) — COD only there,
since Prepaid has no courier, but it sums to the same total because Prepaid
always nets to ₹0 (§6).

**Why `NOT returned_flag` matters** (for both this card and the secondary
row's all-time figures below): a returned COD order is never real cash —
either it was RTO'd before the courier ever collected it, or it was collected
and later refunded. Either way it must stop counting as outstanding, or a
returned order would sit in "pending" forever. Two worked examples (both hold
exactly against real data):
- Sale ₹100 in Jan, ₹20 settled in Jan, the remaining ₹80 returned in Feb →
  Jan's receivable is **₹0** (100 − 20 settled − 80 returned).
- Sale ₹100 in Jan, ₹20 settled in Jan, ₹40 returned in Jan (same month) →
  Jan's receivable is **₹40** (100 − 20 − 40).

Because `settled_flag` and `returned_flag` are independent facts, an order can
even be both (courier remitted it, then it was returned later) — that order
still correctly drops out of "pending" either way.

---

### Secondary row: "All-time position & cash flow"

These four cards are deliberately **not** part of the equation above — mixing
either of them into it would break the exact reconciliation, so they're kept
visually separate underneath instead.

**Total receivable as of {month}** — every month's sale combined (not just
this month's own), still uncollected today:
```sql
SUM(total_amount) WHERE NOT settled_flag AND NOT returned_flag
  AND (order_year * 12 + order_month) <= ($3 * 12 + $2)
```
Prepaid orders are always marked `settled_flag = TRUE` the same month they're
sold (§3.1 — Razorpay settles same-day), so they always fail this filter and
contribute exactly ₹0 — same reasoning as the "Receivable" card above, just
extended across every month up to the selected one instead of just this one.

**Carried forward (from earlier months)** — the slice of the total above that
predates this month:
```sql
SUM(total_amount) WHERE NOT settled_flag AND NOT returned_flag
  AND (order_year * 12 + order_month) < ($3 * 12 + $2)
```
`Total receivable = Carried forward + Receivable (this month's own)` always
holds exactly (both queries partition the same universe by the same
boundary).

**Cash collected — {month}** — actual cash that physically arrived this
calendar month, regardless of which month the underlying order was sold in:
```sql
SUM(settled_amount) WHERE settled_month = $2 AND settled_year = $3
```
This is the figure the equation above deliberately avoids: it mixes in old
carried-forward collections and excludes this month's sale not yet paid, so
`Net sales − Cash collected` will **never** equal `Receivable` by simple
subtraction — that gap is the COD settlement lag, not a bug (§6). Split into
two sub-figures shown in the drill-down:
- **From this month's own sales**: adds `AND order_month = $2 AND order_year = $3`
- **Collected from earlier months**: adds `AND (order_year*12+order_month) < ($3*12+$2)`

**Returns (SRN) — {month}**:
```sql
SUM(returned_amount), COUNT(*) WHERE returned_month = $2 AND returned_year = $3
```

---

## 5. Drill-down modals — exact formula

### "Total receivable" → by origin month + by partner
- **By origin month** (`receivableByMonth`): `GROUP BY order_month, order_year` of every COD order up to the selected month (`<=`) — `cod_sales`, `settled_amount`, `returned_amount`, `pending`, using the **mutually-exclusive partition** described below, so `cod_sales = settled_amount + returned_amount + pending` exactly, every row.
- **By partner/courier** (`receivableByCourierAsOfDate`): same "still pending" universe (`NOT settled_flag AND NOT returned_flag`, `<=` selected month), `GROUP BY courier` instead of by month.

**The partition** (used identically by `receivableByMonth`, `courierAging`, and `thisMonthPendingByCourier`):
```sql
settled_amount  = SUM(total_amount) FILTER (WHERE settled_flag AND NOT returned_flag)
returned_amount = SUM(total_amount) FILTER (WHERE returned_flag)
pending         = SUM(total_amount) FILTER (WHERE NOT settled_flag AND NOT returned_flag)
```
This is deliberately **not** `SUM(settled_amount)` / `SUM(returned_amount)` (the
ledger's own per-order amount columns) — an order that was settled and *then*
returned would get counted in both sums, double-subtracting it and breaking
`cod_sales = settled + returned + pending`. Using `total_amount` gated by the
flags instead keeps the three buckets strictly non-overlapping.

### "Carried forward" → by origin month
Same `receivableByMonth` array, filtered client-side in `ReceivableDashboard.jsx`
to exclude the row matching the selected month/year (no separate backend query —
it's the same dataset, one row removed).

### "This month's own receivable" → by partner
```sql
SELECT courier, COUNT(*) total_orders, SUM(total_amount) total_amount,
       COUNT(*) FILTER (WHERE settled_flag AND NOT returned_flag) settled_orders,
       SUM(total_amount) FILTER (WHERE settled_flag AND NOT returned_flag) settled_amount,
       COUNT(*) FILTER (WHERE returned_flag) returned_orders,
       SUM(total_amount) FILTER (WHERE returned_flag) returned_amount,
       COUNT(*) FILTER (WHERE NOT settled_flag AND NOT returned_flag) pending_orders,
       SUM(total_amount) FILTER (WHERE NOT settled_flag AND NOT returned_flag) pending_amount
FROM receivable_ledger
WHERE payment_method = 'COD' AND order_month = $2 AND order_year = $3
GROUP BY courier
```
The modal sums these rows client-side into `COD sales − Settled − Returned =
Pending` and shows it as an explicit arithmetic row above the table. This
per-courier breakdown is **COD only by necessity** — Prepaid has no courier,
it's collected instantly via Razorpay — but because Prepaid always nets to
₹0 pending (§4), this COD-only sum is numerically identical to the
COD+Prepaid `this_month_own_receivable` KPI shown on the main "Receivable"
card in the headline equation. See §6 for the full breakdown of which figure
uses which population and time semantic.

### "Received" (headline equation card) → by source
```sql
SELECT COALESCE(settled_source, 'unknown') AS source, COUNT(*) AS count, SUM(total_amount) AS amount
FROM receivable_ledger
WHERE order_month = $2 AND order_year = $3 AND settled_flag AND NOT returned_flag
GROUP BY 1 ORDER BY amount DESC
```
COD + Prepaid combined — `settled_source` is one of `ekart` / `xpressbees` /
`delhivery` / `prepaid` (§3). **Not filtered by `settled_month`/`settled_year`**
— unlike `receivedBySource` behind the "Received" card, an order sold this
month but settled via Ekart next month still counts here under `ekart`. Rows
sum to exactly `settled_of_this_months_sales` (§4) — verified against real
data (March 2025, Flo Mattress): prepaid ₹13,44,91,880 + ekart ₹2,31,79,053 +
delhivery ₹14,59,892 + xpressbees ₹4,169 = ₹15,91,34,995.

### "Total sales" → by portal/channel
```sql
SELECT COALESCE(NULLIF(channel,''),'Unknown') channel, COUNT(*), SUM(total_amount)
FROM receivable_ledger
WHERE order_month = $2 AND order_year = $3
GROUP BY 1
```

### "Received" → by source
```sql
SELECT COALESCE(settled_source,'unknown') source, COUNT(*), SUM(settled_amount)
FROM receivable_ledger
WHERE settled_month = $2 AND settled_year = $3
GROUP BY 1
```
`settled_source` is one of `ekart` / `xpressbees` / `delhivery` / `prepaid` (§3).

### "Returns (SRN)" → by origin month + by source
- **By origin month** (`returnsByMonth`): `GROUP BY order_month, order_year` of every return processed this month — grouped by the month the ORIGINAL sale happened in, not the month the return was recorded. A return processed this month is very often for an earlier month's sale (in real data, Feb's sales accounted for a bigger share of March's processed returns than March's own sales did). The frontend tags each row "this month's own" or "carried forward" by comparing to the selected period.
```sql
SELECT order_month AS month, order_year AS year, COUNT(*), SUM(returned_amount)
FROM receivable_ledger
WHERE returned_month = $2 AND returned_year = $3
GROUP BY order_month, order_year
```
- **By source** (`returnsBySource`):
```sql
SELECT CASE WHEN payment_method = 'PREPAID' THEN 'Prepaid'
            ELSE COALESCE(NULLIF(courier,''), 'Other COD') END AS source,
       COUNT(*), SUM(returned_amount)
FROM receivable_ledger
WHERE returned_month = $2 AND returned_year = $3
GROUP BY 1
```
Prepaid orders get returned too (not just COD), so the source list includes
"Prepaid" alongside the couriers. Both breakdowns sum to the same
`returns_this_month_amount` total.

### "Receivable aging by courier" (all-time table on the main page)
```sql
SELECT courier, COUNT(*) total_orders, SUM(total_amount) total_amount,
       COUNT(*) FILTER (WHERE settled_flag AND NOT returned_flag) settled_orders,
       SUM(total_amount) FILTER (WHERE settled_flag AND NOT returned_flag) settled_amount,
       COUNT(*) FILTER (WHERE returned_flag) returned_orders,
       SUM(total_amount) FILTER (WHERE returned_flag) returned_amount,
       SUM(total_amount) FILTER (WHERE NOT settled_flag AND NOT returned_flag) pending_amount
FROM receivable_ledger
WHERE payment_method = 'COD'
GROUP BY courier
```
**Not** month-filtered — this is what surfaces data-completeness gaps (e.g. a
courier missing its settlement file shows as high pending) as a visible
"check data" flag (pending % > 85%, > 20 orders) rather than a false business
signal. Note this flag now fires less often than before the returns fix below,
because a real chunk of what used to look like "pending due to a missing
settlement file" turned out to actually be **returned** orders, correctly
reclassified out of pending.

### 12-month trend chart
```sql
SELECT order_month, order_year,
       SUM(total_amount) AS sales,
       SUM(settled_amount) FILTER (WHERE settled_month = order_month AND settled_year = order_year) AS received_same_month,
       SUM(returned_amount) AS returned_amount,
       SUM(total_amount) FILTER (WHERE payment_method='COD' AND NOT settled_flag AND NOT returned_flag) AS still_pending
FROM receivable_ledger
WHERE (order_year*12+order_month) BETWEEN ($3*12+$2-11) AND ($3*12+$2)
GROUP BY order_month, order_year
```
"Still pending" per month is *today's* state for orders sold in that month —
"of what we sold in month X, how much is still stuck today" — not a rewind to
what was pending as of that month's own end.

### "View sheet data" row browser (Main Sheet / COD main sheet / per-courier tabs)
Each tab filters the same `receivable_ledger` table for the selected month:

| Tab | Filter |
|---|---|
| Main Sheet | *(no extra filter)* |
| COD main sheet | `payment_method = 'COD'` |
| Delivery / Ekart / Xpressbees / DTDC / Self shipping / Other COD | `payment_method = 'COD' AND courier = '<name>'` |

Plus an optional status filter (`pending` → `NOT settled_flag`, `settled` →
`settled_flag`, `returned` → `returned_flag`) and search
(`invoice_number/awb/sale_order_number ILIKE '%term%'`), paginated 25 rows/page.

---

## 6. COD-only vs COD+Prepaid — why every headline KPI uses the same population now

**Every card on this dashboard — the headline equation and the secondary
row alike — is COD + Prepaid combined.** There is no COD-only headline
number anywhere. Prepaid is included everywhere for one reason: it is always
marked settled the same month it's sold (§3.1 — Razorpay settles same-day),
so wherever a query asks "is this still unsettled and not returned," Prepaid
orders always answer no and contribute exactly ₹0. Including it costs
nothing numerically and buys real consistency: every card is drawn from the
same universe of orders, so arithmetic across cards means something instead
of silently comparing two different populations that happen to look similar.

The one exception is deliberate, not an inconsistency: the **per-courier/
partner breakdown tables** (`courierAging`, `thisMonthPendingByCourier`,
`receivableByCourierAsOfDate`, `receivableByMonth`) stay **COD only**, because
"courier" is meaningless for Prepaid — it was never collected by a courier,
it was collected by Razorpay instantly. These tables are drill-downs *behind*
a COD+Prepaid headline number, not competing headline numbers themselves, and
because Prepaid nets to ₹0 they sum to the exact same total as the headline
card above them.

**The population is identical everywhere; the one axis that genuinely
differs is time semantic — accrual vs cash.** The three headline equation
cards (Net sales, Received, Receivable) and the "Total receivable"/"Carried
forward" cards in the secondary row are all **accrual**: status of an
order *as of today*, regardless of which calendar month a settlement or
return actually happened in. **"Cash collected — {month}"**, in the secondary
row, is the one deliberately **cash** figure: money that physically arrived
in this calendar month, from orders sold in any month. That's why `Net sales
− Cash collected` will never simplify to `Receivable` — it isn't supposed to;
using accrual-vs-accrual (`Net sales − Received`) is what makes the headline
equation hold, to the rupee, every month:
```
Net sales this month − Returned − Received (accrual) = Receivable
```
Verified against real data (March 2025, Flo Mattress): ₹19,63,06,631.58 −
₹2,90,16,093.75 − ₹15,91,34,994.53 = ₹81,55,543.30, exactly. See §4 for the
full SQL.

### Why three different "returns" numbers can show for the same month

The dashboard shows a return figure in three places for the same month, and
**they are not meant to match** — each answers a different question, along
two independent axes: (a) COD-only vs COD+Prepaid combined, and (b) returns
*dated in this calendar month* vs *ever recorded for a sale made this month*
(a return can be dated a month or more after its sale).

| Card | Scope | Time window |
|---|---|---|
| **Returns (SRN)** (`returns_this_month_amount`) | COD + Prepaid | Returns **dated/processed** in the selected month, regardless of the sale's own month |
| **Total Sales** modal (`returned_of_this_months_sales`) | COD + Prepaid | ALL returns ever recorded for a sale **made** in the selected month, regardless of when the return itself was dated |
| **This Month's Own Receivable** modal (`thisMonthPendingByCourier.returned_amount`) | **COD only** | Same "ever recorded for a sale made this month" window as above — this is the COD-only subset of that figure |

Worked example against real data (Feb 2025, with cycle start = Feb so no
earlier months exist): Returns (SRN) showed ₹71,62,272 (returns dated in Feb);
Total Sales' returns showed ₹2,82,67,614 (every return ever recorded for a
Feb sale, COD+Prepaid, including ones dated March or later); This Month's Own
Receivable showed ₹1,04,31,315 (the COD-only slice of that same ₹2,82,67,614).
None of these are wrong — the gap between the first and the other two is
returns of Feb sales that hadn't happened yet by Feb's own end but are known
today; the gap between the last two is Prepaid returns. Every modal on the
dashboard that shows a "returns" figure now states in its own footnote which
of these three it is and how it relates to the other two.

---

## 7. Known data-completeness caveats

- **Delhivery FY24-25 settlement file is not loaded** (only FY25-26, Apr–Jun25,
  is) — Delhivery/Other-COD/DTDC/Self-shipping showing ~99–100% pending is a
  **data gap**, not a real collections failure. The courier-aging table flags
  this with a "check data" badge (pending % > 85% and > 20 orders).
- **`receivable_ledger_unmatched`** holds every settlement/SRN row that
  couldn't be matched to a known order (surfaced in the dashboard's "Data
  quality" panel) — these amounts are **excluded** from every figure above
  rather than guessed at.
- A **corrected re-upload** of an already-processed month (same AWBs, edited
  amounts) does not retroactively update the ledger today — insert is
  `ON CONFLICT DO NOTHING` and settle/return updates only touch rows not yet
  settled/returned. Re-running `buildReceivableLedger.js` from scratch is the
  only way to pick up a corrected file today.
