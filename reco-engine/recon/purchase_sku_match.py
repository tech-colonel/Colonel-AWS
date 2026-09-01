"""
purchase_sku_match.py — map a vendor invoice line to the Tally stock item, using
every available signal and a self-improving learned layer.

LADDER (cheapest/surest first; nothing wrong ever auto-fills):
  0. LEARNED   a prior manual pick for THIS vendor+description(+rate)   → auto (conf 1.0)
  1. SKU       the invoice line text itself is a master SKU code        → auto (conf 1.0)
  2. EXACT     normalized description, single Tally name                → auto (conf 1.0)
  3. FUZZY     rapidfuzz over description AND sku, single clear winner  → auto (conf=score)
  4. GEMINI    ambiguous / sub-AUTO: batched once per invoice, given rich
               context (rate, HSN, qty) + candidate {tally, sku} rows   → suggest (conf .8)
  5. MANUAL    no safe answer → status 'unmatched'|'ambiguous', J blank, UI resolves:
                 • ambiguous → dropdown of `candidates`
                 • unmatched (needs_add) → "add to master" form
               EVERY manual resolution is written back (learned / new master row),
               so the same line is an EXACT hit next time.

Master rows: {description, sku, tally}. Learned rows (from the per-brand
`purchase_sku_learned` DB table): {vendor_gstin, description, rate, sku, tally}.
"""
import re
from rapidfuzz import fuzz, process

AUTO_SCORE = 90
REVIEW_MIN = 60
RATE_TOL   = 0.5     # ₹ tolerance when matching a learned pick by rate
TOP_K      = 6


def norm(s):
    s = str(s or '').lower().replace('₹', ' ')
    s = re.sub(r'\s+\d{1,2}\s*%\s*$', '', s)     # drop trailing tax "5%"
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


class SkuMatcher:
    def __init__(self, master_rows, learned_rows=None):
        self.desc_index = {}     # norm(description) -> [ {tally, sku} ... ] (unique by tally)
        self.sku_index  = {}     # norm(sku)         -> {tally, sku, description}
        for r in master_rows:
            d, sku, t = r.get('description'), r.get('sku'), r.get('tally')
            if d and t:
                bucket = self.desc_index.setdefault(norm(d), [])
                if not any(b['tally'] == str(t).strip() for b in bucket):
                    bucket.append({'tally': str(t).strip(), 'sku': (str(sku).strip() if sku else None)})
            if sku and t and norm(sku):
                self.sku_index.setdefault(norm(sku),
                                          {'tally': str(t).strip(), 'sku': str(sku).strip(),
                                           'description': (str(d).strip() if d else None)})
        self.desc_keys = list(self.desc_index.keys())
        self.sku_keys  = list(self.sku_index.keys())
        # learned layer: (vendor_gstin, norm desc) -> [ {rate, tally, sku} ... ]
        self.learned = {}
        for r in (learned_rows or []):
            key = (r.get('vendor_gstin'), norm(r.get('description')))
            self.learned.setdefault(key, []).append(
                {'rate': r.get('rate'), 'tally': str(r.get('tally')).strip(),
                 'sku': (str(r.get('sku')).strip() if r.get('sku') else None)})

    # ── deterministic tiers (no LLM) ─────────────────────────────────────────
    def deterministic(self, desc, vendor_gstin=None, rate=None):
        nd = norm(desc)
        # 0. learned
        lrows = self.learned.get((vendor_gstin, nd))
        if lrows:
            if rate is not None:
                for lr in lrows:
                    if lr['rate'] is not None and abs(float(lr['rate']) - float(rate)) <= RATE_TOL:
                        return dict(status='learned', tally=lr['tally'], sku=lr['sku'],
                                    confidence=1.0, candidates=self._as_cands(lrows), needs_add=False)
            if len({lr['tally'] for lr in lrows}) == 1:
                return dict(status='learned', tally=lrows[0]['tally'], sku=lrows[0]['sku'],
                            confidence=1.0, candidates=self._as_cands(lrows), needs_add=False)
            return dict(status='ambiguous', tally=None, sku=None, confidence=0.0,
                        candidates=self._as_cands(lrows), needs_add=False)
        # 1. invoice text is itself a master SKU code
        if nd in self.sku_index:
            hit = self.sku_index[nd]
            return dict(status='sku', tally=hit['tally'], sku=hit['sku'], confidence=1.0,
                        candidates=[{'tally': hit['tally'], 'sku': hit['sku']}], needs_add=False)
        # 2. exact description
        if nd in self.desc_index:
            bucket = self.desc_index[nd]
            if len(bucket) == 1:
                return dict(status='exact', tally=bucket[0]['tally'], sku=bucket[0]['sku'],
                            confidence=1.0, candidates=list(bucket), needs_add=False)
            return dict(status='ambiguous', tally=None, sku=None, confidence=0.0,
                        candidates=list(bucket), needs_add=False)
        # 3. fuzzy over description + sku keys
        cands, best = self._fuzzy_candidates(nd)
        if best and best[1] >= AUTO_SCORE:
            top_name = cands[0]['tally'] if cands else None
            # single clear winner (next candidate materially worse OR only one distinct name)
            distinct = {c['tally'] for c in cands}
            if top_name and (len(distinct) == 1 or best[2] < AUTO_SCORE):
                return dict(status='fuzzy', tally=top_name, sku=(cands[0]['sku'] if cands else None),
                            confidence=round(best[1] / 100.0, 3), candidates=cands, needs_add=False)
        conf = round((best[1] / 100.0) if best else 0.0, 3)
        if len(cands) == 1:
            # a single plausible candidate → auto-fill it as a SUGGESTION (still
            # changeable in the UI) rather than forcing a pick for one option
            return dict(status='suggested', tally=cands[0]['tally'], sku=cands[0].get('sku'),
                        confidence=conf, candidates=cands, needs_add=False)
        if cands:
            return dict(status='ambiguous', tally=None, sku=None,
                        confidence=conf, candidates=cands, needs_add=False)
        return dict(status='unmatched', tally=None, sku=None, confidence=0.0,
                    candidates=[], needs_add=True)

    def _fuzzy_candidates(self, nd):
        """Top-K candidates across description + SKU keys. Returns (candidates, best_tuple)."""
        pool = []
        for key, score, _ in process.extract(nd, self.desc_keys, scorer=fuzz.token_set_ratio, limit=TOP_K):
            if score >= REVIEW_MIN:
                for b in self.desc_index[key]:
                    pool.append((score, b['tally'], b['sku']))
        for key, score, _ in process.extract(nd, self.sku_keys, scorer=fuzz.token_set_ratio, limit=3):
            if score >= AUTO_SCORE:
                h = self.sku_index[key]
                pool.append((score, h['tally'], h['sku']))
        pool.sort(key=lambda x: -x[0])
        cands, seen = [], set()
        for score, tally, sku in pool:
            if tally in seen:
                continue
            seen.add(tally)
            cands.append({'tally': tally, 'sku': sku})
        best = (None, pool[0][0], (pool[1][0] if len(pool) > 1 else 0)) if pool else None
        if best:
            best = (cands[0]['tally'], pool[0][0], (pool[1][0] if len(pool) > 1 else 0))
        return cands[:TOP_K], best

    @staticmethod
    def _as_cands(lrows):
        out, seen = [], set()
        for lr in lrows:
            if lr['tally'] in seen:
                continue
            seen.add(lr['tally'])
            out.append({'tally': lr['tally'], 'sku': lr.get('sku')})
        return out

    # ── full ladder incl. batched Gemini for the subset ──────────────────────
    def map_lines(self, items, use_gemini=True):
        """items = [{desc, vendor_gstin?, rate?, hsn?, qty?}]. Returns aligned results."""
        results = [self.deterministic(it['desc'], it.get('vendor_gstin'), it.get('rate'))
                   for it in items]
        subset = [(i, items[i], results[i]['candidates'])
                  for i, r in enumerate(results)
                  if r['status'] in ('ambiguous',) and r['candidates']]
        if use_gemini and subset:
            for i, name in self._gemini_resolve(subset).items():
                if name:
                    results[i] = dict(results[i], status='gemini', tally=name,
                                      confidence=0.8, needs_add=False)
        return results

    def _gemini_resolve(self, subset):
        try:
            from recon.gemini_client import generate_json, available
        except Exception:
            return {}
        if not available():
            return {}
        blocks = []
        for n, (i, it, cands) in enumerate(subset):
            ctx = f"rate={it.get('rate')}, HSN={it.get('hsn')}, qty={it.get('qty')}"
            opts = "\n".join(f"      [{j}] {c['tally']}  (SKU {c.get('sku') or '-'})"
                             for j, c in enumerate(cands))
            blocks.append(f"  ITEM {n}: \"{it['desc']}\"  ({ctx})\n{opts}")
        prompt = (
            "You map an Indian vendor's purchase-invoice lines to our Tally stock-item "
            "master. For EACH item pick the ONE option index for the same physical product "
            "(match on product type, model/SKU code, colour, pack/set size; the rate and HSN "
            "are corroborating signals). Return null when no option clearly matches — do NOT "
            "guess.\n\n" + "\n".join(blocks) +
            "\n\nReturn ONLY JSON like [{\"item\":0,\"choice\":2},{\"item\":1,\"choice\":null}]."
        )
        data = generate_json(prompt)
        out = {}
        if isinstance(data, list):
            for row in data:
                try:
                    n = int(row['item']); ch = row.get('choice')
                    i, it, cands = subset[n]
                    out[i] = cands[int(ch)]['tally'] if ch is not None and 0 <= int(ch) < len(cands) else None
                except Exception:
                    continue
        return out


# ── master health report (lever #3) ──────────────────────────────────────────
def master_health(master_rows):
    """Which descriptions map to conflicting Tally names (true ambiguity to clean)."""
    idx = {}
    for r in master_rows:
        d, t = r.get('description'), r.get('tally')
        if d and t:
            idx.setdefault(norm(d), set()).add(str(t).strip())
    conflicts = {k: sorted(v) for k, v in idx.items() if len(v) > 1}
    return dict(total_descriptions=len(idx), conflicting=len(conflicts), conflicts=conflicts)


def load_master_from_xlsx(path):
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True).active
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        desc, sku, tally = (tuple(r) + (None, None, None))[:3]
        rows.append(dict(description=desc, sku=sku, tally=tally))
    return rows
