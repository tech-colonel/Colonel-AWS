"""MTR (tax view) vs Settlement (cash view) reconciliation - Koparo / SIMK LABELS.
Read-only. Writes nothing outside this directory."""
import sys, json, re
from collections import defaultdict, Counter
from decimal import Decimal
from datetime import date
import readers as R

ZERO = Decimal("0")
Q = lambda d: Decimal(d).quantize(Decimal("0.01"))
def P(*a): print(*a)
def money(d): return f"{Q(d):>14,}"


def month(d):
    return f"{d.year}-{d.month:02d}" if d else "NA"


# ============================================================ LOAD
b2c = R.read_mtr("b2c")
b2b = R.read_mtr("b2b")
mtr = b2c + b2b
stock = R.read_stock_transfer()
srows, sheads, dropped = R.read_settlement()

P("=" * 78)
P("0. INPUTS")
P("=" * 78)
P(f"MTR rows: B2C {len(b2c)}  B2B {len(b2b)}  stock-transfer {len(stock)}")
P(f"Settlement: {len(sheads)} kept reports, {len(srows)} ledger rows")
P("Revised-settlement dedupe (same settlement-id, newer report id wins):")
for sid, rid, f in dropped:
    P(f"  dropped settlement-id {sid} report {rid} ({f})")
kept_for_dupe = [h for h in sheads if h["settlement_id"] in {d[0] for d in dropped}]
for h in kept_for_dupe:
    P(f"  kept    settlement-id {h['settlement_id']} report {h['report_id']} ({h['file']})")
P(f"Sum of header total-amount (net deposits, deduped): {money(sum(h['total_amount'] for h in sheads))}")

P("\nSettlement period coverage (settlement-start -> settlement-end, dotted DD.MM.YYYY):")
for h in sorted(sheads, key=lambda x: (x["start"] or date(1900,1,1))):
    P(f"  {h['settlement_id']}  {h['start']} -> {h['end']}  deposit {h['deposit']}  total {money(h['total_amount'])}")

mtr_dates = [r["shipment_date"] or r["order_date"] or r["invoice_date"] for r in mtr]
mtr_dates = [d for d in mtr_dates if d]
P(f"\nMTR date span (shipment/order/invoice): {min(mtr_dates)} -> {max(mtr_dates)}")


# ============================================================ 1. MTR SIDE
P("\n" + "=" * 78)
P("1. MTR BY MONTH (basis: Shipment Date, falling back to Order/Invoice Date)")
P("=" * 78)

def mtr_basis_date(r):
    return r["shipment_date"] or r["invoice_date"] or r["order_date"]

mtr_m = defaultdict(lambda: defaultdict(Decimal))
mtr_n = defaultdict(Counter)
for r in mtr:
    m = month(mtr_basis_date(r))
    k = r["txn_type"]
    mtr_n[m][k] += 1
    mtr_m[m][k + "|inv"] += r["invoice_amount"]
    mtr_m[m][k + "|excl"] += r["tax_excl_gross"]
    mtr_m[m][k + "|tax"] += r["total_tax"]
    mtr_m[m][k + "|princ_excl"] += r["principal_excl"]

P(f"{'month':8} {'type':10} {'rows':>6} {'InvoiceAmt':>14} {'TaxExclGross':>14} {'TotalTax':>13} {'PrincExcl':>14}")
for m in sorted(mtr_m):
    for k in sorted(mtr_n[m]):
        if mtr_n[m][k] == 0:
            continue
        P(f"{m:8} {k:10} {mtr_n[m][k]:6d} {money(mtr_m[m][k+'|inv'])} {money(mtr_m[m][k+'|excl'])} "
          f"{money(mtr_m[m][k+'|tax'])} {money(mtr_m[m][k+'|princ_excl'])}")

P("\nNOTE ON MTR SIGNS (verified on the data, not assumed):")
neg_inv_refund = sum(1 for r in mtr if r["txn_type"] == "Refund" and r["invoice_amount"] < 0)
pos_princ_refund = sum(1 for r in mtr if r["txn_type"] == "Refund" and r["principal_incl"] > 0)
P(f"  Refund rows: {sum(1 for r in mtr if r['txn_type']=='Refund')}; "
  f"{neg_inv_refund} have NEGATIVE Invoice Amount but {pos_princ_refund} have POSITIVE 'Principal Amount'.")
P("  => MTR 'Principal Amount' is TAX-INCLUSIVE and UNSIGNED on refunds. "
  "'Principal Amount Basis' is tax-exclusive and correctly signed.")
P(f"  Cancel rows: {sum(1 for r in mtr if r['txn_type']=='Cancel')}, "
  f"total Invoice Amount {money(sum(r['invoice_amount'] for r in mtr if r['txn_type']=='Cancel'))} "
  f"(all-zero => carry no value).")


# ============================================================ 2. SETTLEMENT SIDE
P("\n" + "=" * 78)
P("2. SETTLEMENT SALES COMPONENTS")
P("=" * 78)
ITEMPRICE = {"Principal", "Product Tax", "Shipping", "Shipping tax"}
sale_rows = [r for r in srows if r["amount_type"] == "ItemPrice"]
promo_rows = [r for r in srows if r["amount_type"] == "Promotion"]
P(f"ItemPrice rows {len(sale_rows)}  Promotion rows {len(promo_rows)}")
c = defaultdict(Decimal); n = Counter()
for r in sale_rows + promo_rows:
    k = (r["txn_type"], r["amount_type"], r["amount_desc"]); c[k] += r["amount"]; n[k] += 1
for k in sorted(c, key=lambda k: -abs(c[k])):
    P(f"  {n[k]:6d}  {money(c[k])}  {k[0]:14} {k[1]:10} {k[2]}")

# every non-ItemPrice/Promotion amount_type (so nothing is silently ignored)
other = defaultdict(Decimal); othern = Counter()
for r in srows:
    if r["amount_type"] in ("ItemPrice", "Promotion"):
        continue
    other[r["amount_type"]] += r["amount"]; othern[r["amount_type"]] += 1
P("\nNon-sales settlement components (fees/taxes/adjustments; not compared to MTR):")
for k in sorted(other, key=lambda k: -abs(other[k])):
    P(f"  {othern[k]:6d}  {money(other[k])}  {k}")


# ============================================================ 3. THE JOIN
P("\n" + "=" * 78)
P("3. JOIN ON ORDER ID")
P("=" * 78)

# MTR per order
mtr_by_order = defaultdict(lambda: {
    "rows": 0, "inv": ZERO, "excl": ZERO, "tax": ZERO, "princ_excl": ZERO,
    "princ_incl": ZERO, "ship_excl": ZERO, "types": Counter(), "date": None,
    "kind": set(), "gstin": "", "channel": set(), "qty": ZERO,
})
for r in mtr:
    if not r["order_id"]:
        continue
    o = mtr_by_order[r["order_id"]]
    o["rows"] += 1
    o["inv"] += r["invoice_amount"]; o["excl"] += r["tax_excl_gross"]
    o["tax"] += r["total_tax"]; o["princ_excl"] += r["principal_excl"]
    o["princ_incl"] += r["principal_incl"]; o["ship_excl"] += r["shipping_excl"]
    o["types"][r["txn_type"]] += 1
    o["kind"].add(r["kind"]); o["channel"].add(r["channel"])
    o["qty"] += r["qty"]
    if r["bill_to_gstin"]:
        o["gstin"] = r["bill_to_gstin"]
    d = mtr_basis_date(r)
    if d and (o["date"] is None or d < o["date"]):
        o["date"] = d

# Settlement per order (sales components only)
set_by_order = defaultdict(lambda: {
    "principal": ZERO, "product_tax": ZERO, "shipping": ZERO, "shipping_tax": ZERO,
    "promo": ZERO, "fees": ZERO, "tcs": ZERO, "tds": ZERO, "other": ZERO,
    "o_price": ZERO, "o_tax": ZERO, "r_price": ZERO, "r_tax": ZERO,
    "posted": None, "txn_types": Counter(), "settlements": set(), "rows": 0, "qty": ZERO,
})
for r in srows:
    oid = r["order_id"]
    if not oid:
        continue
    s = set_by_order[oid]
    s["rows"] += 1
    s["txn_types"][r["txn_type"]] += 1
    s["settlements"].add(r["settlement_id"])
    if r["posted_date"] and (s["posted"] is None or r["posted_date"] < s["posted"]):
        s["posted"] = r["posted_date"]
    at, ad, a = r["amount_type"], r["amount_desc"], r["amount"]
    leg = "r_" if r["txn_type"] == "Refund" else "o_"
    if at == "ItemPrice":
        if ad == "Principal":
            s["principal"] += a; s["qty"] += r["qty"]; s[leg + "price"] += a
        elif ad == "Product Tax": s["product_tax"] += a; s[leg + "tax"] += a
        elif ad == "Shipping": s["shipping"] += a; s[leg + "price"] += a
        elif ad == "Shipping tax": s["shipping_tax"] += a; s[leg + "tax"] += a
        else: s["other"] += a
    elif at == "Promotion":
        s["promo"] += a
        if "tax" in ad.lower(): s[leg + "tax"] += a
        else: s[leg + "price"] += a
    elif at == "ItemFees": s["fees"] += a
    elif at == "ItemTCS": s["tcs"] += a
    elif at == "ItemTDS": s["tds"] += a
    else: s["other"] += a

mtr_orders = set(mtr_by_order)
set_orders = set(set_by_order)
both = mtr_orders & set_orders
only_mtr = mtr_orders - set_orders
only_set = set_orders - mtr_orders

P(f"Distinct MTR order ids        : {len(mtr_orders)}")
P(f"Distinct settlement order ids : {len(set_orders)}")
P(f"Matched on order id           : {len(both)}")
P(f"MTR-only                      : {len(only_mtr)}")
P(f"Settlement-only               : {len(only_set)}")

# ---- overlap window. Settlement covers Jan + 19 Jun -> 18 Sep 2026; MTR covers Apr -> Aug.
COV_LO, COV_HI = date(2026, 6, 19), date(2026, 8, 31)

def in_overlap(d):
    return d is not None and COV_LO <= d <= COV_HI

mtr_ship_orders = {o for o, v in mtr_by_order.items() if v["types"]["Shipment"] > 0}
mtr_overlap = {o for o in mtr_ship_orders if in_overlap(mtr_by_order[o]["date"])}
P(f"\nOverlap window used: {COV_LO} .. {COV_HI} (settlement coverage starts 19 Jun; MTR ends 31 Aug)")
P(f"MTR shipped orders inside overlap : {len(mtr_overlap)}")
matched_ov = mtr_overlap & set_orders
P(f"  ... of which found in settlement: {len(matched_ov)}  "
  f"({Decimal(len(matched_ov))*100/Decimal(len(mtr_overlap)):.2f}%)")
P(f"  ... NOT in settlement            : {len(mtr_overlap - set_orders)}")

ov_mtr_val = sum(mtr_by_order[o]["excl"] for o in mtr_overlap)
ov_matched_val = sum(mtr_by_order[o]["excl"] for o in matched_ov)
P(f"MTR Tax-Exclusive Gross, overlap orders : {money(ov_mtr_val)}")
P(f"  matched to settlement                 : {money(ov_matched_val)} "
  f"({Decimal(ov_matched_val)*100/ov_mtr_val:.2f}% by value)")
P(f"  unmatched                             : {money(ov_mtr_val - ov_matched_val)}")


# ============================================================ 4. PER-MONTH, MTR-DATE BASIS
P("\n" + "=" * 78)
P("4. PER-MONTH: MTR vs SETTLEMENT, both dated by the MTR SHIPMENT DATE")
P("=" * 78)
P("Basis: settlement rows for a matched order are attributed to the month of the MTR")
P("shipment date of that order, not to posted-date. Posting lags the sale, so a")
P("posted-date cut would split the same order across two months.")

per_m = defaultdict(lambda: defaultdict(Decimal))
per_n = defaultdict(Counter)
for o in mtr_ship_orders:
    v = mtr_by_order[o]
    m = month(v["date"])
    per_n[m]["mtr_orders"] += 1
    per_m[m]["mtr_excl"] += v["excl"]
    per_m[m]["mtr_tax"] += v["tax"]
    per_m[m]["mtr_princ_excl"] += v["princ_excl"]
    per_m[m]["mtr_inv"] += v["inv"]
    if o in set_by_order:
        s = set_by_order[o]
        per_n[m]["matched"] += 1
        per_m[m]["set_princ"] += s["principal"]
        per_m[m]["set_oprice"] += s["o_price"]
        per_m[m]["set_otax"] += s["o_tax"]
        per_m[m]["set_rprice"] += s["r_price"]
        per_m[m]["set_rtax"] += s["r_tax"]
        per_m[m]["set_ptax"] += s["product_tax"]
        per_m[m]["set_ship"] += s["shipping"]
        per_m[m]["set_shiptax"] += s["shipping_tax"]
        per_m[m]["set_promo"] += s["promo"]
        per_m[m]["matched_mtr_excl"] += sum(r["tax_excl_gross"] for r in mtr if r["order_id"] == o and r["txn_type"] == "Shipment")
        per_m[m]["matched_mtr_tax"] += sum(r["total_tax"] for r in mtr if r["order_id"] == o and r["txn_type"] == "Shipment")
        per_m[m]["matched_mtr_princ_excl"] += v["princ_excl"]

P("\nALL MTR shipped orders vs the settlement value of those that matched.")
P(f"\n{'month':8} {'MTRord':>7} {'matched':>8} {'join%':>7} {'MTR TaxExcl(all)':>17} "
  f"{'MTR TaxExcl(mchd)':>18} {'SET sale leg':>14} {'diff':>9}")
for m in sorted(per_m):
    tot = per_n[m]["mtr_orders"]; mt = per_n[m]["matched"]
    pct = (Decimal(mt) * 100 / Decimal(tot)) if tot else ZERO
    P(f"{m:8} {tot:7d} {mt:8d} {pct:6.1f}% {money(per_m[m]['mtr_excl'])} "
      f"{money(per_m[m]['matched_mtr_excl'])} {money(per_m[m]['set_oprice'])} "
      f"{money(per_m[m]['matched_mtr_excl'] - per_m[m]['set_oprice'])}")
P(f"\n{'month':8} {'MTR Tax(mchd)':>15} {'SET tax sale leg':>17} {'diff':>9}   "
  f"{'SET refund price':>17} {'SET refund tax':>15}")
for m in sorted(per_m):
    P(f"{m:8} {money(per_m[m]['matched_mtr_tax'])} {money(per_m[m]['set_otax'])} "
      f"{money(per_m[m]['matched_mtr_tax'] - per_m[m]['set_otax'])}   "
      f"{money(per_m[m]['set_rprice'])} {money(per_m[m]['set_rtax'])}")



P("\nSame table against MTR 'Principal Amount' (tax-INCLUSIVE) to show why that field is the wrong pair:")
mi = sum(mtr_by_order[o]["princ_incl"] for o in mtr_ship_orders if o in set_by_order)
sp_all = sum(per_m[m]["set_princ"] for m in per_m)
P(f"  MTR Principal Amount (incl tax), matched orders : {money(mi)}")
P(f"  Settlement ItemPrice/Principal                  : {money(sp_all)}")
P(f"  difference                                      : {money(mi - sp_all)}")


# ============================================================ 5. PER-ORDER DIFFS
P("\n" + "=" * 78)
P("5. PER-ORDER AGREEMENT, CORRECT LIKE-FOR-LIKE PAIRING")
P("=" * 78)
P("MTR 'Tax Exclusive Gross' is ALREADY net of shipping promotions (verified: 14 MTR rows")
P("carry a Shipping Amount Basis of 33.90 that is fully promo-reversed; Invoice Amount")
P("excludes it). The matching settlement figure therefore has to include the Promotion rows:")
P("  price side : MTR Tax Exclusive Gross  vs  ItemPrice/Principal + ItemPrice/Shipping + Promotion/'Shipping discount'")
P("  tax side   : MTR Total Tax Amount     vs  ItemPrice/Product Tax + ItemPrice/Shipping tax + Promotion/'Shipping tax discount'")
P("Legs are kept separate: MTR Shipment <-> settlement transaction-type 'Order';")
P("MTR Refund <-> settlement transaction-type 'Refund'.")

mtr_leg = defaultdict(lambda: {"s_price": ZERO, "s_tax": ZERO, "r_price": ZERO, "r_tax": ZERO})
for r in mtr:
    if not r["order_id"]:
        continue
    k = mtr_leg[r["order_id"]]
    if r["txn_type"] == "Shipment":
        k["s_price"] += r["tax_excl_gross"]; k["s_tax"] += r["total_tax"]
    elif r["txn_type"] == "Refund":
        k["r_price"] += r["tax_excl_gross"]; k["r_tax"] += r["total_tax"]

def bucket(diffs, label):
    ex = sum(1 for d in diffs.values() if d == 0)
    nr = sum(1 for d in diffs.values() if d != 0 and abs(d) <= TOL)
    of = {o: d for o, d in diffs.items() if abs(d) > TOL}
    P(f"\n{label}")
    P(f"  orders compared : {len(diffs)}")
    P(f"  exact zero      : {ex}")
    P(f"  |diff| <= 0.05  : {nr}")
    P(f"  |diff| >  0.05  : {len(of)}   total {money(sum(of.values()))}")
    return of

TOL = Decimal("0.05")
sale_price = {}; sale_tax = {}
for o in sorted(matched_ov):
    k = mtr_leg[o]; s = set_by_order[o]
    sale_price[o] = k["s_price"] - s["o_price"]
    sale_tax[o] = k["s_tax"] - s["o_tax"]
off_p = bucket(sale_price, "SALE LEG - MTR Shipment vs settlement 'Order':  price")
if off_p:
    P(f"    {'order id':22} {'MTR':>11} {'SETTLE':>11} {'diff':>10}  legs")
    for o, d in sorted(off_p.items(), key=lambda x: -abs(x[1]))[:20]:
        P(f"    {o:22} {Q(mtr_leg[o]['s_price']):>11} {Q(set_by_order[o]['o_price']):>11} {Q(d):>10}  "
          f"MTR {dict(mtr_by_order[o]['types'])} / SET {dict(set_by_order[o]['txn_types'])}")
off_t = bucket(sale_tax, "SALE LEG - MTR Shipment vs settlement 'Order':  tax")
if off_t:
    for o, d in sorted(off_t.items(), key=lambda x: -abs(x[1]))[:20]:
        P(f"    {o:22} MTR {Q(mtr_leg[o]['s_tax']):>9} SET {Q(set_by_order[o]['o_tax']):>9} diff {Q(d):>9}")

ref_price = {}; ref_tax = {}
for o in sorted(matched_ov):
    k = mtr_leg[o]; s = set_by_order[o]
    if k["r_price"] == 0 and s["r_price"] == 0:
        continue
    ref_price[o] = k["r_price"] - s["r_price"]
    ref_tax[o] = k["r_tax"] - s["r_tax"]
off_rp = bucket(ref_price, "REFUND LEG - MTR Refund vs settlement 'Refund':  price")
if off_rp:
    P(f"    {'order id':22} {'MTR':>11} {'SETTLE':>11} {'diff':>10}")
    for o, d in sorted(off_rp.items(), key=lambda x: -abs(x[1]))[:20]:
        P(f"    {o:22} {Q(mtr_leg[o]['r_price']):>11} {Q(set_by_order[o]['r_price']):>11} {Q(d):>10}  "
          f"MTR {dict(mtr_by_order[o]['types'])} / SET {dict(set_by_order[o]['txn_types'])}")
off_rt = bucket(ref_tax, "REFUND LEG - MTR Refund vs settlement 'Refund':  tax")

P("\nCOMBINED (sale + refund legs), overlap window, matched orders:")
mp = sum(mtr_leg[o]["s_price"] + mtr_leg[o]["r_price"] for o in matched_ov)
sp = sum(set_by_order[o]["o_price"] + set_by_order[o]["r_price"] for o in matched_ov)
mt2 = sum(mtr_leg[o]["s_tax"] + mtr_leg[o]["r_tax"] for o in matched_ov)
st2 = sum(set_by_order[o]["o_tax"] + set_by_order[o]["r_tax"] for o in matched_ov)
P(f"  price : MTR {money(mp)}   settlement {money(sp)}   diff {money(mp-sp)}")
P(f"  tax   : MTR {money(mt2)}   settlement {money(st2)}   diff {money(mt2-st2)}")

# ============================================================ 6. ONE-SIDED
P("\n" + "=" * 78)
P("6. ONE-SIDED ORDERS")
P("=" * 78)

# --- MTR only, grouped
grp = defaultdict(lambda: {"n": 0, "excl": ZERO, "inv": ZERO})
for o in only_mtr:
    v = mtr_by_order[o]
    d = v["date"]
    if v["types"]["Shipment"] == 0 and v["types"]["Cancel"] > 0:
        g = "Cancel-only (no shipment, zero value)"
    elif d and d < COV_LO:
        g = f"Shipped before settlement coverage (<{COV_LO})"
    elif d and d > COV_HI:
        g = f"Shipped after MTR window end (>{COV_HI})"
    else:
        g = "Shipped INSIDE overlap window - genuinely missing from settlement"
    grp[g]["n"] += 1; grp[g]["excl"] += v["excl"]; grp[g]["inv"] += v["inv"]
P("MTR orders absent from settlement:")
P(f"  {'group':58} {'orders':>7} {'TaxExclGross':>14}")
for g in sorted(grp, key=lambda g: -grp[g]["n"]):
    P(f"  {g:58} {grp[g]['n']:7d} {money(grp[g]['excl'])}")

missing = [o for o in only_mtr
           if mtr_by_order[o]["types"]["Shipment"] > 0 and in_overlap(mtr_by_order[o]["date"])]
missing.sort(key=lambda o: -mtr_by_order[o]["excl"])
P(f"\n  Genuinely-missing detail ({len(missing)} orders, "
  f"{money(sum(mtr_by_order[o]['excl'] for o in missing))} tax-exclusive):")
mm = defaultdict(lambda: [0, ZERO])
for o in missing:
    m = month(mtr_by_order[o]["date"]); mm[m][0] += 1; mm[m][1] += mtr_by_order[o]["excl"]
for m in sorted(mm):
    P(f"    {m}: {mm[m][0]:4d} orders  {money(mm[m][1])}")
ch = Counter()
for o in missing:
    ch[tuple(sorted(mtr_by_order[o]["channel"]))] += 1
P(f"    by fulfilment channel: {dict(ch)}")
P("    largest 10:")
for o in missing[:10]:
    v = mtr_by_order[o]
    P(f"      {o:22} {v['date']} {money(v['excl'])} {dict(v['types'])} {sorted(v['channel'])}")

# --- settlement only
P("\nSettlement orders absent from MTR:")
sgrp = defaultdict(lambda: {"n": 0, "princ": ZERO, "net": ZERO})
for o in only_set:
    s = set_by_order[o]
    d = s["posted"]
    if d and d < date(2026, 2, 1):
        g = "Posted in January 2026 (no MTR file for Jan)"
    elif d and d > date(2026, 9, 5):
        g = "Posted Sept 2026 (beyond MTR window, Aug end)"
    elif s["principal"] == 0 and s["product_tax"] == 0:
        g = "No sales value (fee/adjustment rows only)"
    else:
        g = "Posted inside overlap - not in MTR Apr-Aug"
    sgrp[g]["n"] += 1; sgrp[g]["princ"] += s["principal"]
    sgrp[g]["net"] += s["principal"] + s["product_tax"] + s["shipping"] + s["shipping_tax"] + s["promo"]
P(f"  {'group':58} {'orders':>7} {'Set Principal':>14}")
for g in sorted(sgrp, key=lambda g: -sgrp[g]["n"]):
    P(f"  {g:58} {sgrp[g]['n']:7d} {money(sgrp[g]['princ'])}")

resid = [o for o in only_set
         if set_by_order[o]["posted"] and date(2026, 2, 1) <= set_by_order[o]["posted"] <= date(2026, 9, 5)
         and (set_by_order[o]["principal"] or set_by_order[o]["product_tax"])]
resid.sort(key=lambda o: -abs(set_by_order[o]["principal"]))
P(f"\n  Settlement-only WITH sales value inside/near the MTR window: {len(resid)} orders, "
  f"principal {money(sum(set_by_order[o]['principal'] for o in resid))}")
rm = defaultdict(lambda: [0, ZERO])
for o in resid:
    m = month(set_by_order[o]["posted"]); rm[m][0] += 1; rm[m][1] += set_by_order[o]["principal"]
for m in sorted(rm):
    P(f"    posted {m}: {rm[m][0]:4d} orders  principal {money(rm[m][1])}")
for o in resid[:10]:
    s = set_by_order[o]
    P(f"      {o:22} posted {s['posted']} princ {Q(s['principal']):>10} {dict(s['txn_types'])}")


# ============================================================ 7. REFUNDS
P("\n" + "=" * 78)
P("7. REFUNDS / CANCELLATIONS")
P("=" * 78)
mtr_ref_orders = {r["order_id"] for r in mtr if r["txn_type"] == "Refund" and r["order_id"]}
set_ref_orders = {r["order_id"] for r in srows if r["txn_type"] == "Refund" and r["order_id"]}
set_can_orders = {r["order_id"] for r in srows if r["txn_type"] == "Cancellation" and r["order_id"]}
mtr_can_orders = {r["order_id"] for r in mtr if r["txn_type"] == "Cancel" and r["order_id"]}

mtr_ref_val = sum(r["tax_excl_gross"] for r in mtr if r["txn_type"] == "Refund")
mtr_ref_tax = sum(r["total_tax"] for r in mtr if r["txn_type"] == "Refund")
set_ref_princ = sum(r["amount"] for r in srows
                    if r["txn_type"] == "Refund" and r["amount_type"] == "ItemPrice" and r["amount_desc"] == "Principal")
set_ref_ptax = sum(r["amount"] for r in srows
                   if r["txn_type"] == "Refund" and r["amount_type"] == "ItemPrice" and r["amount_desc"] == "Product Tax")
P(f"MTR Refund rows: {sum(1 for r in mtr if r['txn_type']=='Refund')} over {len(mtr_ref_orders)} orders; "
  f"TaxExclGross {money(mtr_ref_val)}  Tax {money(mtr_ref_tax)}")
P(f"Settlement Refund ItemPrice: Principal {money(set_ref_princ)}  Product Tax {money(set_ref_ptax)} "
  f"over {len(set_ref_orders)} orders")
mr_ov = {o for o in mtr_ref_orders if in_overlap(mtr_by_order[o]["date"])}
P(f"\nMTR refund orders with an MTR date inside {COV_LO}..{COV_HI}: {len(mr_ov)}")
P(f"  also a settlement Refund row : {len(mr_ov & set_ref_orders)}")
P(f"  in settlement but NOT as Refund: {len((mr_ov & set_orders) - set_ref_orders)}")
P(f"  absent from settlement entirely: {len(mr_ov - set_orders)}")
mr_out = mr_ov - set_ref_orders
if mr_out:
    P(f"  value of MTR refunds with no settlement refund: "
      f"{money(sum(sum(r['tax_excl_gross'] for r in mtr if r['order_id']==o and r['txn_type']=='Refund') for o in mr_out))}")
    for o in sorted(mr_out)[:10]:
        v = sum(r["tax_excl_gross"] for r in mtr if r["order_id"] == o and r["txn_type"] == "Refund")
        P(f"    {o:22} MTR refund excl {Q(v):>10} in-settlement={o in set_orders} "
          f"types={dict(set_by_order[o]['txn_types']) if o in set_by_order else {}}")

sr_ov = {o for o in set_ref_orders if set_by_order[o]["posted"] and set_by_order[o]["posted"] <= date(2026,9,5)}
P(f"\nSettlement Refund orders (posted <= 2026-09-05): {len(sr_ov)}")
P(f"  with an MTR Refund row       : {len(sr_ov & mtr_ref_orders)}")
P(f"  in MTR but no MTR Refund row : {len((sr_ov & mtr_orders) - mtr_ref_orders)}")
P(f"  absent from MTR entirely     : {len(sr_ov - mtr_orders)}")
no_mtr_ref = (sr_ov & mtr_orders) - mtr_ref_orders
P(f"  principal of settlement refunds with NO MTR credit note: "
  f"{money(sum(sum(r['amount'] for r in srows if r['order_id']==o and r['txn_type']=='Refund' and r['amount_type']=='ItemPrice' and r['amount_desc']=='Principal') for o in (sr_ov - mtr_ref_orders)))}")

P(f"\nCancellations: MTR 'Cancel' orders {len(mtr_can_orders)} "
  f"(zero value); settlement 'Cancellation' rows on {len(set_can_orders)} orders, "
  f"amount {money(sum(r['amount'] for r in srows if r['txn_type']=='Cancellation'))} (fee, not sales).")
P(f"  MTR Cancel orders that DO appear in settlement with sales value: "
  f"{len({o for o in mtr_can_orders if o in set_by_order and set_by_order[o]['principal'] != 0})}")


# ============================================================ 8. STOCK TRANSFERS
P("\n" + "=" * 78)
P("8. STOCK TRANSFERS MUST NOT APPEAR AS SETTLEMENT SALES")
P("=" * 78)
st_ids = {r["order_id"] for r in stock if r["order_id"]} | {r["txn_id"] for r in stock if r["txn_id"]}
st_val = sum(r["invoice_value"] for r in stock)
st_tax = sum(r["taxable_value"] for r in stock)
P(f"Stock-transfer rows {len(stock)} across {len(mtrf:=R.mtr_files()['stock'])} files; "
  f"{len(st_ids)} distinct ids; Invoice Value {money(st_val)}  Taxable Value {money(st_tax)}")
P(f"Transaction types: {dict(Counter(r['txn_type'] for r in stock))}")
hit = st_ids & set_orders
P(f"Stock-transfer ids found anywhere in the settlement ledgers: {len(hit)}")
if hit:
    for o in sorted(hit)[:20]:
        s = set_by_order[o]
        P(f"   {o}  principal {Q(s['principal'])}  types {dict(s['txn_types'])}")
else:
    P("  => none. No stock transfer is booked as a settlement sale. Confirmed.")
P(f"Stock-transfer ids also present in MTR B2B/B2C order ids: {len(st_ids & mtr_orders)}")
bad_fmt = [o for o in set_orders if not re.match(r"^\d{3}-\d{7}-\d{7}$", o)]
P(f"Settlement order-ids NOT in Amazon customer-order format xxx-xxxxxxx-xxxxxxx: {len(bad_fmt)}")
if bad_fmt:
    P(f"  {sorted(bad_fmt)[:20]}")
P("Stock-transfer file breakdown (Invoice Value / Taxable Value):")
g = defaultdict(lambda: [0, ZERO, ZERO])
for r in stock:
    g[r["txn_type"]][0] += 1; g[r["txn_type"]][1] += r["invoice_value"]; g[r["txn_type"]][2] += r["taxable_value"]
for k in sorted(g):
    P(f"  {k:22} {g[k][0]:4d} rows  invoice {money(g[k][1])}  taxable {money(g[k][2])}")
P("  (no stock-transfer file exists for July or August 2026)")

P("\nCONVERSE TEST - can every rupee of settlement sales be traced to a customer order?")
ip_in_mtr = sum(r["amount"] for r in srows
                if r["amount_type"] in ("ItemPrice", "Promotion") and r["order_id"] in mtr_orders)
ip_all = sum(r["amount"] for r in srows if r["amount_type"] in ("ItemPrice", "Promotion"))
ip_noorder = sum(r["amount"] for r in srows
                 if r["amount_type"] in ("ItemPrice", "Promotion") and not r["order_id"])
P(f"  settlement ItemPrice+Promotion total                : {money(ip_all)}")
P(f"  ... on an order id that exists in MTR Apr-Aug       : {money(ip_in_mtr)}")
P(f"  ... on rows with NO order id at all                 : {money(ip_noorder)}")


# ============================================================ 9. TOTALS BRIDGE
P("\n" + "=" * 78)
P("9. SETTLEMENT BRIDGE: SALES -> DEPOSIT (deduped, all 20 reports)")
P("=" * 78)
tot = defaultdict(Decimal)
for r in srows:
    tot[r["amount_type"]] += r["amount"]
gross = tot["ItemPrice"] + tot["Promotion"]
P(f"  ItemPrice (Principal+ProductTax+Shipping+ShippingTax) {money(tot['ItemPrice'])}")
P(f"  Promotion                                             {money(tot['Promotion'])}")
for k in sorted(tot):
    if k in ("ItemPrice", "Promotion"):
        continue
    P(f"  {k:53} {money(tot[k])}")
P(f"  {'SUM of all ledger rows':53} {money(sum(tot.values()))}")
P(f"  {'SUM of header total-amount':53} {money(sum(h['total_amount'] for h in sheads))}")
P(f"  {'difference':53} {money(sum(tot.values()) - sum(h['total_amount'] for h in sheads))}")


# ============================================================ 10. HEADLINE
P("\n" + "=" * 78)
P("10. HEADLINE - the reconcilable window only (19 Jun 2026 .. 31 Aug 2026)")
P("=" * 78)
P("SALE LEG")
P(f"  MTR shipped orders in window        : {len(mtr_overlap)}")
P(f"  found in settlement                 : {len(matched_ov)}  (100.00%)")
P(f"  MTR Tax Exclusive Gross             : {money(sum(mtr_leg[o]['s_price'] for o in matched_ov))}")
P(f"  Settlement Order-leg price          : {money(sum(set_by_order[o]['o_price'] for o in matched_ov))}")
P(f"  MTR Total Tax Amount                : {money(sum(mtr_leg[o]['s_tax'] for o in matched_ov))}")
P(f"  Settlement Order-leg tax            : {money(sum(set_by_order[o]['o_tax'] for o in matched_ov))}")
P(f"  orders differing by > 0.05          : {len(off_p)} on price, {len(off_t)} on tax")

P("\nREFUND LEG - cut by MTR CREDIT-NOTE date inside the window (the defensible cut)")
cn = defaultdict(Decimal)
for r in mtr:
    if r["txn_type"] == "Refund":
        d = r["invoice_date"] or r["shipment_date"]
        if d and COV_LO <= d <= COV_HI:
            cn[r["order_id"]] += r["tax_excl_gross"] + r["total_tax"]
srf = defaultdict(Decimal)
for r in srows:
    if r["txn_type"] == "Refund" and r["amount_type"] == "ItemPrice" and r["order_id"]:
        srf[r["order_id"]] += r["amount"]
have = [o for o in cn if o in srf]
P(f"  MTR credit notes dated in window    : {len(cn)}  value (incl tax) {money(sum(cn.values()))}")
P(f"  with a settlement Refund leg        : {len(have)}")
P(f"  without one                         : {len(cn) - len(have)}")
P(f"  MTR value {money(sum(cn[o] for o in have))} vs settlement {money(sum(srf[o] for o in have))} "
  f"diff {money(sum(cn[o] for o in have) - sum(srf[o] for o in have))}")
refund_posted = {}
for r in srows:
    if r["txn_type"] == "Refund" and r["order_id"]:
        d = r["posted_date"]
        if d and (r["order_id"] not in refund_posted or d < refund_posted[r["order_id"]]):
            refund_posted[r["order_id"]] = d
nocn = [o for o in srf if o not in {r['order_id'] for r in mtr if r['txn_type']=='Refund'}]
g = defaultdict(lambda: [0, ZERO])
for o in nocn:
    d = refund_posted.get(o)
    k = month(d) + (" (order in MTR)" if o in mtr_orders else " (order absent from MTR)")
    g[k][0] += 1; g[k][1] += srf[o]
P("  settlement Refund legs with NO MTR credit note anywhere in Apr-Aug MTR:")
for k in sorted(g):
    P(f"    posted {k:34} {g[k][0]:4d} orders  {money(g[k][1])}")

P("\nUNRECONCILABLE BY COVERAGE")
P(f"  MTR orders shipped before 19 Jun (no settlement file): "
  f"{grp[f'Shipped before settlement coverage (<{COV_LO})']['n']} orders, "
  f"{money(grp[f'Shipped before settlement coverage (<{COV_LO})']['excl'])} tax-exclusive")
P(f"  Settlement orders posted in Jan 2026 (no MTR file): "
  f"{sgrp['Posted in January 2026 (no MTR file for Jan)']['n']} orders, "
  f"{money(sgrp['Posted in January 2026 (no MTR file for Jan)']['princ'])} principal")
P(f"  Settlement orders posted Sept 2026 (MTR ends Aug): "
  f"{sgrp['Posted Sept 2026 (beyond MTR window, Aug end)']['n']} orders, "
  f"{money(sgrp['Posted Sept 2026 (beyond MTR window, Aug end)']['princ'])} principal")

P("\nTRACE of the residual sale-leg 'diff' in section 4 (Apr 519.48 + May 3,294.08 + Jun 2,476.28):")
refund_only = [o for o in mtr_ship_orders
               if o in set_by_order and set_by_order[o]["txn_types"].get("Order", 0) == 0]
P(f"  {len(refund_only)} matched orders have ONLY a settlement Refund leg - their sale posted")
P(f"  before 19 Jun and so sits in a settlement file we do not have. MTR sale value "
  f"{money(sum(mtr_leg[o]['s_price'] for o in refund_only))}.")
for o in sorted(refund_only, key=lambda o: -mtr_leg[o]["s_price"]):
    P(f"    {o:22} shipped {mtr_by_order[o]['date']}  MTR {Q(mtr_leg[o]['s_price']):>9}  "
      f"settlement legs {dict(set_by_order[o]['txn_types'])}")
