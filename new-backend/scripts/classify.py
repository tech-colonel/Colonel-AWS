"""
Universal Indian Bank Statement Classifier for Tally Ledger Entry Automation.

Supports any Indian bank (Canara, Kotak, HDFC, SBI, Axis, ICICI, Yes Bank, RBL, IDFC, etc.)
and any D2C brand. Only input required: a List of Ledgers Tally export + raw bank statement.

Usage:
    python classify.py --ledger <path> --bank <path> --output <path> [--brand <BrandName>]
"""

import os
import re
import sys
import pandas as pd
from thefuzz import process, fuzz
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ---------------------------------------------------------------------------
# D2C Ecosystem keyword map — used to scan ledger master for matching ledgers.
# Keys are canonical brand names; values are narration search terms (lowercase).
# ---------------------------------------------------------------------------
D2C_KEYWORDS = {
    "amazon":        ["amazon", "amzn", "amazon seller", "amazon pay", "intermedier"],
    "blinkit":       ["blinkit", "grofers", "blinkcommerce", "blinkcommer"],
    "zepto":         ["zepto", "kiranakart"],
    "razorpay":      ["razorpay", "razor pay"],
    "shiprocket":    ["shiprocket", "shiprock", "bigfoot"],
    "facebook":      ["facebook", "meta ads", "fb ads", "facebook india"],
    "google":        ["google", "gpay", "google ads", "adwords"],
    "cashfree":      ["cashfree"],
    "payu":          ["payu", "pay u"],
    "ccavenue":      ["ccavenue", "ccavenuef"],
    "paytm":         ["paytm", "one97"],
    "phonepe":       ["phonepe", "phone pe"],
    "jiomart":       ["jiomart", "reliance retail", "reliance jio"],
    "flipkart":      ["flipkart", "fkrt"],
    "bigbasket":     ["bigbasket", "innovative retail"],
    "swiggy":        ["swiggy", "bundl technologies"],
    "zomato":        ["zomato"],
    "bluedart":      ["bluedart", "blue dart"],
    "dtdc":          ["dtdc"],
    "gati":          ["gati"],
    "safexpress":    ["safexpress", "safe express"],
    "myntra":        ["myntra"],
    "nykaa":         ["nykaa"],
    "ajio":          ["ajio"],
    "cred":          ["cred", "dreamplug"],
    "shipway":       ["shipway"],
    "easyecom":      ["easyecom"],
    "unicommerce":   ["unicommerce"],
    "eunimart":      ["eunimart"],
    "shopify":       ["shopify"],
    "instamojo":     ["instamojo"],
    "pine labs":     ["pine labs", "pinelabs"],
    "billdesk":      ["billdesk", "bill desk"],
    "delhivery":     ["delhivery"],
    "ekart":         ["ekart"],
    "xpressbees":    ["xpressbees"],
    "shadowfax":     ["shadowfax"],
    "nykaa fashion": ["nykaa fashion", "fsn ecommerce"],
    "tata cliq":     ["tata cliq", "tata digital"],
    "meesho":        ["meesho", "fashnear"],
    "ugvcl":         ["ugvcl", "uttar gujrat vij"],
    "torrent power": ["torrent power"],
    "tata power":    ["tata power"],
    "bescom":        ["bescom"],
    "msedcl":        ["msedcl"],
    "uppcl":         ["uppcl"],
}

# Statutory BDP service codes → fuzzy search terms against the ledger master
BDP_STATUTORY = {
    "TIN":  "tds payable",
    "GSTN": "gst payable",
    "ESI":  "esic payable",
    "EPF":  "provident fund payable",
    "PT":   "professional tax payable",
}

# Common Indian business name abbreviations → expanded forms.
# Normalizing before fuzzy matching bridges mismatches like "PVT LTD" vs "Private Limited".
_ABBREV = [
    (re.compile(r'\bPVT\.?\b'),   'PRIVATE'),
    (re.compile(r'\bLTD\.?\b'),   'LIMITED'),
    (re.compile(r'\bCO\.?\b'),    'COMPANY'),
    (re.compile(r'\bCORP\.?\b'),  'CORPORATION'),
    (re.compile(r'\bMFG\.?\b'),   'MANUFACTURING'),
    (re.compile(r'\bMKTG\.?\b'),  'MARKETING'),
    (re.compile(r'\bINTL\.?\b'),  'INTERNATIONAL'),
    (re.compile(r'\bINDUS\.?\b'), 'INDUSTRIES'),
    (re.compile(r'\bEXPRES\.?\b'),'EXPRESS'),
    # Truncation expansions common in bank 50-char limits
    (re.compile(r'\bLIMI\b'),     'LIMITED'),
    (re.compile(r'\bPRIV\b'),     'PRIVATE'),
]

# Words that can be inadvertently merged by bank systems (e.g. "TRADESPRIVATE").
# Split them back before fuzzy matching.
_DEMERGE_PAT = re.compile(
    r'(?<=[A-Z])(PRIVATE|LIMITED|VENTURES|INDUSTRIES|MARKETING|LOGISTICS|SERVICES|'
    r'SOLUTIONS|TECHNOLOGIES|ENTERPRISES|INTERNATIONAL|PRODUCTS|EXPORTS|IMPORTS)')


def _expand_abbrevs(text: str) -> str:
    """Expand common business abbreviations and de-merge accidentally merged words
    (e.g. 'TRADESPRIVATE' → 'TRADES PRIVATE') for more accurate fuzzy matching."""
    t = text.upper()
    t = _DEMERGE_PAT.sub(r' \1', t)   # split merged words first
    for pat, repl in _ABBREV:
        t = pat.sub(repl, t)
    return t


# Words stripped when cleaning narrations for generic fuzzy matching
NOISE_WORDS = {
    "NEFT", "RTGS", "IMPS", "UPI", "MB", "TO", "FROM", "DR", "CR", "BANK",
    "TRANSFER", "REF", "REFERENCE", "UTR", "ID", "TXN", "BRANCH",
    "IB", "SC", "OTHER", "THAN", "SB", "IMB", "CNRBH", "ONLINE", "TRANSACTION",
    "BDP", "PAYMENT", "AGAINST", "INVOICE", "DUE", "CLEARED", "THROUGH",
    "BENEFICIARY", "ACCOUNT", "NSDL", "CHALLAN", "CHALLAN NO",
}


# ---------------------------------------------------------------------------
# Narration cleaning and parsing helpers
# ---------------------------------------------------------------------------

def clean_narration(narration: str) -> str:
    """Strip banking noise words, long numbers, and special chars for fuzzy matching."""
    if not narration or not isinstance(narration, str):
        return ""
    text = narration.upper()
    text = re.sub(r'\d{10,}', ' ', text)           # remove account numbers
    text = re.sub(r'[^A-Z0-9\s]', ' ', text)
    words = text.split()
    kept = [w for w in words
            if w not in NOISE_WORDS
            and not (any(c.isdigit() for c in w) and len(w) > 6)]
    return " ".join(kept)


def _parse_ib_neft(text: str) -> tuple:
    """
    Parse Canara Bank IB NEFT / SC NEFT / IB IFT narrations.
    Format: IB NEFT Dr CNRBH<UTR> <Entity Name>  <IFSC> <AccNo> <Remark>
    Entity = between UTR and IFSC code (separated by double-space).
    Returns (entity, remark).
    """
    orig = text.strip()
    ifsc_match = re.search(r'([A-Z]{4}0[A-Z0-9]{6})', orig)
    utr_match  = re.search(r'CNRBH[A-Z0-9]+', orig)

    entity = ""
    remark = ""

    if utr_match and ifsc_match and ifsc_match.start() > utr_match.end():
        entity = orig[utr_match.end():ifsc_match.start()].strip()
        remark = orig[ifsc_match.end():].strip()

    if not entity:
        # Fallback: strip prefix then split on double-space
        text_clean = re.sub(
            r'^(IB|SC)?\s*(NEFT|RTGS|IMPS|IFT|OAT|ITG)\s*(Dr|Cr)?\s*', '', orig, flags=re.I)
        text_clean = re.sub(r'^CNRBH[A-Z0-9]+\s+', '', text_clean, flags=re.I)
        parts = re.split(r'\s{2,}', text_clean)
        entity = parts[0].strip() if parts else text_clean
        remark = " ".join(parts[1:]).strip() if len(parts) > 1 else ""

    return entity, remark


def _parse_bdp(text: str) -> tuple:
    """
    Parse BDP payment gateway narrations.
    Format: BDP-<SERVICE>-<GATEWAY>-<txnid>-<clientref>
    Returns (service_code, gateway_code).
    """
    match = re.search(r'BDP-([A-Z0-9_]+)(?:-([A-Z0-9_]+))?', text)
    if match:
        return match.group(1), (match.group(2) or "")
    return "", ""


def _parse_upi(text: str) -> str:
    """Extract beneficiary name from UPI narration (4th slash-segment)."""
    parts = text.split('/')
    if len(parts) >= 4:
        name = parts[3].strip()
        name = re.sub(r'[*]{0,2}\d+@\w+', '', name)
        name = re.sub(r'PAY TO M.*', '', name, flags=re.I)
        return name.strip()
    return ""


def _parse_chq(text: str) -> str:
    """Extract payee from cheque / MICR inward clearing narration."""
    # Try explicit PAYEE- segment first
    match = re.search(r'PAYEE-([^-]+)', text, flags=re.I)
    if match:
        return match.group(1).strip()
    parts = text.split('-')
    if len(parts) >= 3:
        payee = parts[2].strip()
        # Don't return bank branch names
        if any(k in payee.upper() for k in ["STATE BANK", "CANARA", "HDFC", "ICICI", "KOTAK", "AXIS"]):
            return ""
        return payee
    return ""


def _parse_neft_return(text: str) -> str:
    """Extract original beneficiary from NEFT RETURN narration (3rd hyphen-segment)."""
    parts = text.split('-')
    return parts[2].strip() if len(parts) >= 3 else ""


def _parse_ift(text: str) -> str:
    """
    Parse Kotak IFT (Internal Fund Transfer) narrations.
    Format: IFT-<Entity Name>-<CODE>-<TransactionRef>
    E.g.: IFT-BVC TRADEPORT PRIVATE LIM-FCM-250428GDH9CV
    Returns entity name (segment between first and second dash, before the CODE segment).
    """
    # Strip leading "IFT-" then extract up to the alphanumeric code segment
    m = re.match(r'^IFT-([A-Z][A-Z0-9\s]+?)-[A-Z]{2,5}-', text.strip())
    if m:
        return m.group(1).strip()
    # Fallback: second dash-segment
    parts = text.split('-')
    if len(parts) >= 2:
        return parts[1].strip()
    return ""


# ---------------------------------------------------------------------------
# Core classifier
# ---------------------------------------------------------------------------

class BankClassifier:
    def __init__(self, master_ledgers: list):
        self.master_ledgers = [str(l).strip() for l in master_ledgers
                               if pd.notna(l) and str(l).strip()]
        self._build_indices()

    def _build_indices(self):
        """Pre-compute filtered ledger subsets for fast routing."""
        ml = self.master_ledgers

        # Salary / payroll
        self.salary_ledgers = [l for l in ml if any(
            k in l.lower() for k in
            ['salary', 'stipend', 'wages', 'remuneration', 'allowance', 'director sitting']
        )]
        self.salary_ledgers_broad = [l for l in ml if any(
            k in l.lower() for k in
            ['salary', 'stipend', 'wages', 'employee', 'payable', 'staff', 'reimbursement']
        )]

        # Statutory
        self.tds_ledgers   = [l for l in ml if 'tds' in l.lower() or 'tax deducted' in l.lower()]
        self.gst_ledgers   = [l for l in ml if any(
            k in l.lower() for k in ['gst', 'goods & service', 'cgst', 'sgst', 'igst']
        )]
        self.pf_ledgers    = [l for l in ml if 'provident' in l.lower() or 'pf' in l.lower() or 'epf' in l.lower()]
        self.esic_ledgers  = [l for l in ml if 'esic' in l.lower() or 'esi' in l.lower()]
        self.pt_ledgers    = [l for l in ml if 'professional tax' in l.lower()]

        # Bank charges & interest — broader matching to catch naming variations across firms
        self.bank_charge_ledgers = [l for l in ml if any(
            k in l.lower() for k in [
                'bank charge', 'bank fees', 'bank commission', 'bank expense',
                'neft charge', 'rtgs charge', 'imps charge', 'dd charge',
                'service charge', 'transaction charge', 'amb charge', 'penal charge',
                'cheque return charge', 'chq return charge', 'ecs return', 'nach return',
            ]
        ) and not any(
            k in l.lower() for k in [
                'amazon', 'flipkart', 'razorpay', 'shiprocket', 'zepto',
                'blinkit', 'swiggy', 'zomato', 'myntra', 'nykaa', 'meesho',
                'paytm', 'phonepe', 'cashfree', 'payu', 'ccavenue',
            ]
        )]
        self.interest_exp_ledgers = [l for l in ml if any(
            k in l.lower() for k in [
                'interest exp', 'interest paid', 'finance cost', 'finance charge',
                'interest on od', 'interest on cc', 'interest on loan',
                'od interest', 'cc interest', 'bank interest exp',
                'interest payable', 'interest capitali',
            ]
        )]
        self.interest_inc_ledgers = [l for l in ml if any(
            k in l.lower() for k in [
                'interest inc', 'interest rec', 'interest earn', 'interest on fdr',
                'interest on fd', 'fd interest', 'interest on deposit',
                'interest on saving', 'interest credit', 'interest income',
            ]
        )]

        # Pre-compute suspense ledger (avoid repeated master scan at runtime)
        self._suspense_ledger = next(
            (l for l in ml if 'suspense' in l.lower()), "Suspense A/c"
        )

        # Rent
        self.rent_ledgers = [l for l in ml
                             if ('rent' in l.lower() or 'godown' in l.lower() or 'lease' in l.lower())
                             and 'current' not in l.lower()]

        # Own-account bank ledgers (for Contra detection)
        self.own_account_ledgers = []
        self.own_account_numbers = set()
        skip_terms = {'charge', 'interest', 'commission', 'fees', 'expense',
                      'brand funded', 'marketing', 'received', 'income', 'tax', 'tds'}
        for l in ml:
            ll = l.lower()
            if any(k in ll for k in ['bank', 'cash', 'escrow', 'current a/c', 'od account', 'casa']):
                if not any(k in ll for k in skip_terms):
                    self.own_account_ledgers.append(l)
                    for num in re.findall(r'\d{8,}', l):
                        self.own_account_numbers.add(num)

        # D2C ledger subsets: for each brand keyword, find matching ledgers in master.
        # Use WORD-BOUNDARY matching for ledger lookup to avoid short terms like "cred"
        # matching "creditors", "ucredits", etc.
        self._d2c_ledger_map = {}
        for brand, terms in D2C_KEYWORDS.items():
            subset = [
                l for l in ml
                if any(re.search(r'\b' + re.escape(t) + r'\b', l.lower()) for t in terms)
            ]
            if subset:
                self._d2c_ledger_map[brand] = subset

    # ------------------------------------------------------------------
    def _find_master(self, keywords: list) -> str | None:
        """Find the first ledger in master that contains ANY of the given keywords (substring).

        This ensures returned ledger names always come from the user's actual chart of accounts,
        never hardcoded strings that might not exist in their master.
        """
        for kw in keywords:
            found = next((l for l in self.master_ledgers if kw.lower() in l.lower()), None)
            if found:
                return found
        return None

    # ------------------------------------------------------------------
    def _fuzzy_match(self, query: str, choices: list, threshold: int = 72) -> tuple:
        """
        Returns (matched_ledger, confidence_band, score).
        confidence_band: 'High' (≥87), 'Medium' (72–86), 'Low' (<72).

        Scoring strategy:
        - Expands common abbreviations (PVT→PRIVATE, LTD→LIMITED) before matching so
          bank narrations like "EKANEK NETWORKS PVT LTD" correctly match "Ekanek Network
          Private Limited" instead of a shorter ledger with a shared common word.
        - Uses a weighted blend: 0.6 × token_set_ratio + 0.4 × token_sort_ratio.
          Pure token_set_ratio inflates scores when a very short ledger shares one common
          token (e.g. "PF Charges" scoring 82 against a long narration containing "CHARGES").
          The blend preserves token_set's ability to handle word-order variation while
          giving enough weight to token_sort to penalise size mismatches.
        """
        if not choices or not query.strip():
            return "Suspense A/c", "Low", 0.0
        query_up = query.upper().strip()
        for c in choices:
            if c.upper().strip() == query_up:
                return c, "High", 100.0

        q_norm = _expand_abbrevs(query)

        def combined_score(choice):
            c_norm = _expand_abbrevs(choice)
            s1 = fuzz.token_set_ratio(q_norm, c_norm)
            s2 = fuzz.token_sort_ratio(q_norm, c_norm)
            # Weighted blend: token_set handles word-order freely, token_sort penalises
            # size mismatches (prevents short ledgers like "PF Charges" from scoring
            # artificially high against long narrations via a single shared token).
            # For very short queries (abbreviations like "VRL", "SBI", 3–8 chars),
            # token_sort_ratio is inherently low due to length disparity — use
            # token_set_ratio predominantly in those cases.
            if len(q_norm) <= 8:
                return round(0.85 * s1 + 0.15 * s2)
            return round(0.6 * s1 + 0.4 * s2)

        best = max(choices, key=combined_score)
        score = combined_score(best)
        conf = "High" if score >= 87 else ("Medium" if score >= 72 else "Low")
        return best, conf, score

    def _match_employee_ledger(self, entity: str, salary_ledgers: list) -> str:
        """
        Name-aware employee matching.
        Handles Indian name variations (order reversal, suffixes like 'bhai', 'kumar').
        Requires first-name overlap; prefers ledgers with 'salary' in the name.
        """
        noise = {'salary', 'payable', 'dr', 'cr', 'a/c', 'account', 'pvt', 'ltd', 'private', 'limited', 'factory'}
        suffixes = ['ben', 'bhai', 'kumar', 'kumari', 'lal', 'devi', 'prasad', 'singh', 'bai']

        def stem(word):
            for s in suffixes:
                if word.endswith(s) and len(word) > len(s) + 1:
                    return word[:-len(s)]
            return word

        entity_words = [stem(w) for w in entity.lower().replace('-', ' ').split()
                        if w not in noise and len(w) > 2]
        if not entity_words:
            return None

        best_ledger, best_score = None, 0
        for ledger in salary_ledgers:
            ledger_words = [stem(w) for w in ledger.lower().replace('-', ' ').split()
                            if w not in noise and len(w) > 2]
            if not ledger_words:
                continue
            # At least one word from the entity must match the first token of ledger (or vice versa)
            first_match = any(
                fuzz.ratio(ew, ledger_words[0]) >= 80 for ew in entity_words
            ) or any(
                fuzz.ratio(entity_words[0], lw) >= 80 for lw in ledger_words
            )
            if not first_match:
                continue
            overlaps = sum(
                1 for ew in entity_words
                if any(fuzz.ratio(ew, lw) >= 80 for lw in ledger_words)
            )
            if overlaps > 0:
                score = overlaps * 100 + fuzz.token_set_ratio(entity.lower(), ledger.lower())
                # Prefer "Salary A/c" or "Salary Payable" named ledgers
                if any(k in ledger.lower() for k in ['salary a/c', 'salary payable', 'salary - ']):
                    score += 50
                if score > best_score:
                    best_score = score
                    best_ledger = ledger

        return best_ledger if best_score >= 150 else None

    # ------------------------------------------------------------------
    def classify(self, narration: str, debit: float, credit: float) -> dict:
        orig  = str(narration).strip() if narration else ""
        orig_upper = orig.upper()
        is_credit  = credit > 0
        txn_type   = "Receipt" if is_credit else "Payment"

        # ------------------------------------------------------------------
        # STEP 1 — Own-account transfers → Contra
        # ------------------------------------------------------------------
        for acc_num in self.own_account_numbers:
            if acc_num in orig_upper:
                matched = next((l for l in self.own_account_ledgers if acc_num in l), None)
                if matched:
                    return {"ledger": matched, "type": "Contra",
                            "confidence": "High", "rule": "Own Account Transfer"}

        if "IB OAT" in orig_upper or "DRAWDOWN FROM CASA" in orig_upper:
            matched = next((l for l in self.own_account_ledgers if "bank" in l.lower()), None)
            if matched:
                return {"ledger": matched, "type": "Contra",
                        "confidence": "High", "rule": "OAT/CASA Contra"}

        # "RATNR" is RBL Bank's RTGS prefix (Ratnakar→RBL). When it appears in an RTGS
        # narration alongside the company's own name, it signals an inter-bank self-transfer.
        if "RATNR" in orig_upper and ("RTGS" in orig_upper or "NEFT" in orig_upper):
            rbl = next((l for l in self.own_account_ledgers if 'rbl' in l.lower()), None)
            if rbl:
                return {"ledger": rbl, "type": "Contra", "confidence": "High",
                        "rule": "RATNR RBL Contra"}

        # ------------------------------------------------------------------
        # STEP 2 — Statutory payments via BDP / ITG narration codes
        # ------------------------------------------------------------------
        if "BDP-" in orig_upper or "IB ITG" in orig_upper:
            service, _ = _parse_bdp(orig_upper)
            if service in BDP_STATUTORY:
                search = BDP_STATUTORY[service]
                pool = {
                    "TIN":  self.tds_ledgers,
                    "GSTN": self.gst_ledgers,
                    "EPF":  self.pf_ledgers,
                    "ESI":  self.esic_ledgers,
                    "PT":   self.pt_ledgers,
                }.get(service, [])
                if pool:
                    ledger, conf, _ = self._fuzzy_match(search, pool)
                    if conf != "Low":
                        return {"ledger": ledger, "type": txn_type,
                                "confidence": "High", "rule": f"BDP Statutory {service}"}
                # Fallback: first matching ledger by substring — always from master
                fallback = (
                    next((l for l in self.master_ledgers if search.split()[0] in l.lower()), None)
                    or self._fuzzy_match(search, self.master_ledgers)[0]
                )
                return {"ledger": fallback, "type": txn_type,
                        "confidence": "Medium", "rule": f"BDP Statutory {service} (fallback)"}

        # ------------------------------------------------------------------
        # STEP 3 — GSTN challan / raw GST keyword in narration
        # GSTN can appear as standalone (GSTN Payable) or with digits (GSTN1082...-...)
        # ------------------------------------------------------------------
        if "GSTN" in orig_upper:
            # Prefer exact "GST Payable" > any payable > any GST ledger
            gst = (
                next((l for l in self.gst_ledgers if l.lower().strip() in ('gst payable', 'gst payble')), None)
                or next((l for l in self.gst_ledgers if 'payable' in l.lower() and 'input' not in l.lower() and 'inward' not in l.lower()), None)
                or next((l for l in self.gst_ledgers), None)
                or self._find_master(['gst payable', 'gst liability', 'output gst', 'cgst payable', 'sgst payable', 'igst payable'])
                or self._suspense_ledger
            )
            return {"ledger": gst, "type": txn_type, "confidence": "High", "rule": "GSTN Match"}

        # ------------------------------------------------------------------
        # STEP 4 — TDS keyword
        # ------------------------------------------------------------------
        if re.search(r'\bTDS\b', orig_upper) or re.search(r'\bTIN\b', orig_upper):
            query = "TDS Receivable" if is_credit else "TDS Payable"
            if self.tds_ledgers:
                ledger, conf, _ = self._fuzzy_match(query, self.tds_ledgers)
                if conf != "Low":
                    return {"ledger": ledger, "type": txn_type, "confidence": "High", "rule": "TDS Match"}
            fallback = (
                next((l for l in self.tds_ledgers), None)
                or self._find_master(['tds payable', 'tds receivable', 'tax deducted', 'income tax'])
                or self._suspense_ledger
            )
            return {"ledger": fallback, "type": txn_type, "confidence": "Medium", "rule": "TDS Fallback"}

        # ------------------------------------------------------------------
        # STEP 5 — EPF / ESI keywords
        # Note: Kotak writes "ETAX EPFONEW" (EPF followed by letters) not bare "EPF"
        # ------------------------------------------------------------------
        if re.search(r'\bEPF', orig_upper) or "PROVIDENT FUND" in orig_upper or "EPFONEW" in orig_upper:
            # Prefer "PF Payable" or "Provident Fund Payable" over generic "PF Account"
            ledger = (
                next((l for l in self.pf_ledgers if 'payable' in l.lower()), None)
                or next((l for l in self.pf_ledgers), None)
                or self._find_master(['provident fund', 'pf payable', 'epf payable'])
                or self._suspense_ledger
            )
            return {"ledger": ledger, "type": txn_type, "confidence": "High", "rule": "EPF Match"}

        if re.search(r'\bESIC?', orig_upper):
            ledger = (
                next((l for l in self.esic_ledgers if 'payable' in l.lower()), None)
                or next((l for l in self.esic_ledgers), None)
                or self._find_master(['esic payable', 'esi payable', 'employee state insurance'])
                or self._suspense_ledger
            )
            return {"ledger": ledger, "type": txn_type, "confidence": "High", "rule": "ESIC Match"}

        # ------------------------------------------------------------------
        # STEP 6 — Rent / godown  (must run BEFORE bank charges to prevent
        #           "Periodic Godown SC charges" hitting the SC CHARGES rule).
        # IMPORTANT: Skip RENT keyword check for structured bank transfer narrations
        # (IB NEFT / IB IFT) — in those, "Rent" appears in the remark field
        # and the real ledger is the payee entity (e.g., "Indra Hassija - Rent").
        # GODOWN always signals a godown charge so it's safe regardless of format.
        # ------------------------------------------------------------------
        is_transfer_narration = any(k in orig_upper for k in ["IB NEFT", "SC NEFT", "IB IFT", "IB RTGS"])
        # Also skip the pure-RENT rule when "RENT" appears after a dash in the narration,
        # e.g. "ANU TUSHIR-ADV RENT APR25" or "EKANEK NETWORKS PVT LTD- RENT MAR25".
        # In those cases the entity precedes the dash and should be matched directly;
        # the rent remark will be caught later in STEP 12 (Rent remark routing).
        rent_in_remark = bool(re.search(r'[A-Z][A-Z\s]{2,}-\s*(?:\w+\s+)?RENT\b', orig_upper))
        if "GODOWN" in orig_upper or (re.search(r'\bRENT\b', orig_upper) and not is_transfer_narration and not rent_in_remark):
            ledger = (
                next((l for l in self.rent_ledgers if re.search(r'\brent exp', l.lower())), None)
                or next((l for l in self.rent_ledgers if 'rent' in l.lower() and 'deposit' not in l.lower() and 'allowance' not in l.lower()), None)
                or next((l for l in self.rent_ledgers), None)
                or self._find_master(['rent expense', 'rent paid', 'office rent', 'godown rent'])
                or self._suspense_ledger
            )
            return {"ledger": ledger, "type": txn_type, "confidence": "High", "rule": "Rent Match"}

        # ------------------------------------------------------------------
        # STEP 7 — Bank charges
        # ------------------------------------------------------------------
        if any(k in orig_upper for k in [
            "OTHER THAN SB IMB", "SC CHARGES", "BANK CHARGES",
            "IMPS CHARGES", "SC NEFT", "SMS CHARGES",
            "ANNUAL FEE", "AMB CHARGES",
            "CHQ DEPOSITED AND RETURN", "CHQ RETURN", "CHEQUE RETURN",
        ]) or orig_upper.startswith("CHRG:"):
            # Prefer an explicitly named "Bank Charges" ledger; fall back to "Bank Charges" text
            ledger = (
                next((l for l in self.bank_charge_ledgers if 'bank charge' in l.lower()), None)
                or next((l for l in self.master_ledgers if l.lower() == 'bank charges'), None)
                or next((l for l in self.bank_charge_ledgers), None)
                or self._find_master(['bank charge', 'bank fees', 'service charge', 'transaction charge'])
                or self._suspense_ledger
            )
            return {"ledger": ledger, "type": "Payment", "confidence": "High", "rule": "Bank Charges"}

        # ------------------------------------------------------------------
        # STEP 8 — Interest
        # Note: Kotak writes "Int.Coll:" for interest collection (credit side)
        # ------------------------------------------------------------------
        if "INTEREST" in orig_upper or "INT.COLL" in orig_upper or "INT COLL" in orig_upper:
            if is_credit:
                ledger = (
                    next((l for l in self.interest_inc_ledgers), None)
                    or self._find_master(['interest income', 'interest earned', 'interest received', 'interest on fd'])
                    or self._suspense_ledger
                )
            else:
                ledger = (
                    next((l for l in self.interest_exp_ledgers), None)
                    or self._find_master(['interest expense', 'finance cost', 'interest paid', 'interest on od'])
                    or self._suspense_ledger
                )
            return {"ledger": ledger, "type": txn_type, "confidence": "High", "rule": "Interest Match"}

        # ------------------------------------------------------------------
        # STEP 9 — NEFT Return: extract original beneficiary
        # ------------------------------------------------------------------
        if "NEFT RETURN" in orig_upper:
            entity = _parse_neft_return(orig_upper)
            if entity:
                ledger, conf, _ = self._fuzzy_match(entity, self.master_ledgers)
                return {"ledger": ledger, "type": "Receipt", "confidence": conf, "rule": "NEFT Return"}

        # ------------------------------------------------------------------
        # STEP 10 — Extract entity from narration prefix
        # ------------------------------------------------------------------
        entity = ""
        remark = ""
        is_upi = "UPI/" in orig_upper

        if "CHQ PAID" in orig_upper or "MICR INWARD" in orig_upper:
            entity = _parse_chq(orig_upper)
        elif is_upi:
            entity = _parse_upi(orig_upper)
        elif "IB NEFT" in orig_upper or "SC NEFT" in orig_upper or "IB IFT" in orig_upper:
            entity, remark = _parse_ib_neft(orig_upper)
        elif orig_upper.startswith("IFT-"):
            # Kotak IFT format: IFT-<Entity>-<Code>-<Ref>
            entity = _parse_ift(orig_upper)
        elif "BDP-" in orig_upper:
            entity = _parse_bdp(orig_upper)[0]  # service name as entity for D2C fuzzy
        elif re.match(r'^(?:NEFT|RTGS|IMPS)\s+[A-Z0-9]{8,}\s+', orig_upper):
            # Generic bank NEFT/RTGS format: "NEFT <UTR> <Beneficiary Name...>"
            # Handles formats from HSBC (HSBCN), ICICI (ICICINXXX), etc.
            # Strip anything from "(" onwards (value date annotations) and limit to 50 chars.
            m = re.match(r'^(?:NEFT|RTGS|IMPS)\s+[A-Z0-9]{8,}\s+(.+)', orig_upper)
            if m:
                raw = m.group(1).split('(')[0].strip()
                entity = raw[:50].strip()
        elif '-' in orig and not entity:
            # Fallback: "ENTITY NAME-DESCRIPTION" pattern used by many direct payments.
            # E.g. "EKANEK NETWORKS PVT LTD-APPX CHARGES" → entity = "EKANEK NETWORKS PVT LTD"
            # Only apply when the part before the first dash looks like a company/person name.
            _bank_prefixes = {'NEFT', 'RTGS', 'IMPS', 'UPI', 'IB', 'SC', 'CHQ', 'IFT',
                              'BDP', 'ETAX', 'GBO', 'INT', 'CHRG', 'JYOTI', 'VALUE'}
            dash_idx = orig_upper.index('-')
            possible = orig_upper[:dash_idx].strip()
            first_word = possible.split()[0] if possible.split() else ''
            if len(possible) > 5 and first_word not in _bank_prefixes and not possible[0].isdigit():
                entity = possible

        entity = entity.strip()

        # ------------------------------------------------------------------
        # STEP 11 — Salary / allowance routing
        # Note: REIMBURSEMENT payments (REIMB) go to the person's reimbursement ledger,
        # not Salary Payable. We skip salary matching for those and let the anchored
        # entity match (STEP 12b) find the correct "Person Reimbursement Payable" ledger.
        # ------------------------------------------------------------------
        salary_keywords = ["SALARY", "ALLOWANCE", "WAGES", "STIPEND",
                           "FACTORY MILK", "LABOUR", "TA DA", "TA/DA"]
        is_salary_narration = any(k in orig_upper for k in salary_keywords) or \
                              any(k in remark.upper() for k in salary_keywords)

        # Detect reimbursement narrations (short-form "REIMB" or full "REIMBURSEMENT")
        is_reimb_narration = "REIMB" in orig_upper or "REIMBURSEMENT" in orig_upper

        # For bare reimbursement narrations like "VIKASH KUMAR- REIMB MAR25" (not IB NEFT),
        # entity won't have been extracted by STEP 10 parsers — extract it here.
        if is_reimb_narration and not entity:
            reimb_match = re.match(r'^([A-Z][A-Z\s]+?)\s*-\s*REIMB', orig_upper)
            if reimb_match:
                entity = reimb_match.group(1).strip()

        if is_salary_narration and not is_reimb_narration and entity:
            matched = self._match_employee_ledger(entity, self.salary_ledgers) \
                      or self._match_employee_ledger(entity, self.salary_ledgers_broad)
            if matched:
                return {"ledger": matched, "type": txn_type, "confidence": "High", "rule": "Salary Match"}

        # ------------------------------------------------------------------
        # STEP 12 — Rent remark routing
        # Only checks the REMARK field (the decoded comment from IB NEFT narrations).
        # Narrations where "RENT" appears in the main body — like "ANU TUSHIR-ADV RENT APR25"
        # or "EKANEK NETWORKS PVT LTD- RENT MAR25" — are already handled upstream by
        # entity extraction + anchored fuzzy (the entity IS the payee, RENT is just context).
        # ------------------------------------------------------------------
        rent_keywords = ["RENT", "LEASE", "GODOWN CHARGES"]
        if any(k in remark.upper() for k in rent_keywords):
            if self.rent_ledgers:
                ledger, conf, _ = self._fuzzy_match(entity or remark, self.rent_ledgers)
                if conf != "Low":
                    return {"ledger": ledger, "type": txn_type, "confidence": conf, "rule": "Rent Remark"}

        # ------------------------------------------------------------------
        # STEP 12b — First-word-anchored entity match (before D2C scan)
        # When the entity is cleanly extracted from a structured NEFT/CHQ/IFT narration,
        # restrict candidates to ledgers containing the entity's FIRST WORD before fuzzy
        # scoring. This prevents false matches like "Sudhir Balgovind" → "Vijay Balgovind"
        # or "Alpino HealthFoods" → "WLDD Private Limited" due to common token overlap.
        # If no anchor candidates exist, fall through to D2C and general fuzzy.
        # ------------------------------------------------------------------
        # is_clean_neft gates the anchored entity match (STEP 12b).
        # Generic NEFT/RTGS is intentionally excluded — those narrations should still pass
        # through the D2C scan (which correctly handles marketplace receipts like Razorpay
        # Collection) before falling back to general fuzzy with the extracted entity.
        is_clean_neft = (
            any(k in orig_upper for k in ["IB NEFT", "SC NEFT", "IB IFT", "CHQ PAID", "IB RTGS"])
            or orig_upper.startswith("IFT-")
        )
        # Also run anchored match for reimbursement narrations extracted above
        if entity and len(entity) > 4 and (is_clean_neft or is_reimb_narration):
            first_word = entity.split()[0].lower() if entity.split() else ""
            anchored = [l for l in self.master_ledgers if first_word in l.lower()] if first_word else []
            if anchored:
                # Use a slightly lower threshold (68) for anchored matches — the first-word
                # constraint already filters out unrelated ledgers, so a score of 68+ within
                # the anchored set is more reliable than a 87 score in the full master.
                remark_upper = remark.upper()
                # Catch both "REIMB" (short form, e.g. "VIKASH KUMAR-REIMB MAR25")
                # and "REIMBURS" / "REIMBURSEMENT" (full form in remark)
                is_reimbursement = ("REIMB" in orig_upper or "REIMBURS" in remark_upper)

                # For expense reimbursements: prefer person/vendor ledger over salary ledgers.
                # NOTE: We exclude salary/wages but NOT "payable" — we want to find
                # "Vikash Kumar Reimbursement Payable", not exclude it.
                if is_reimbursement:
                    non_salary = [c for c in anchored
                                  if 'salary' not in c.lower() and 'wages' not in c.lower()]
                    anchored_effective = non_salary if non_salary else anchored
                else:
                    anchored_effective = anchored

                def combined(c):
                    s = max(fuzz.token_set_ratio(entity, c), fuzz.token_sort_ratio(entity, c))
                    # Boost ledgers whose name echoes a remark keyword (tolerates typos)
                    if is_reimbursement and fuzz.partial_ratio("reimburse", c.lower()) >= 70:
                        s += 20
                    # For credit (receipt) IFT transactions, strongly prefer Collection
                    # sub-ledgers over the plain company/3PL ledger.
                    # E.g.: IFT-BVC TRADEPORT... (receipt) → "BVC Tradeport Collection (Shopify)"
                    # not "BVC TRADEPORT PRIVATE LIMITED (Vamaship)".
                    ift_credit = is_credit and orig_upper.startswith("IFT-")
                    if ift_credit and any(k in c.lower() for k in ['collection', 'seller receipt']):
                        s += 30
                    elif is_credit and any(k in c.lower() for k in ['collection', 'seller receipt']):
                        s += 10
                    return s
                best_a = max(anchored_effective, key=combined)
                score_a = combined(best_a)
                if score_a >= 68:
                    conf_a = "High" if score_a >= 87 else "Medium"
                    return {"ledger": best_a, "type": txn_type, "confidence": conf_a,
                            "rule": "Anchored Entity Match"}

        # ------------------------------------------------------------------
        # STEP 13 — Customer Refund early exit (before D2C scan)
        # Narrations like "JYOTI K- SWIGGY CUSTOMER REFUND" are outgoing refunds to customers,
        # not D2C marketplace transactions. Detect this before D2C scan.
        # ------------------------------------------------------------------
        if "CUSTOMER REFUND" in orig_upper or "CUST REFUND" in orig_upper:
            refund_ledger = next(
                (l for l in self.master_ledgers if 'customer refund' in l.lower()), None
            ) or next(
                (l for l in self.master_ledgers if 'refund' in l.lower() and 'customer' in l.lower()), None
            )
            if refund_ledger:
                return {"ledger": refund_ledger, "type": txn_type, "confidence": "High",
                        "rule": "Customer Refund"}

        # ------------------------------------------------------------------
        # STEP 15 — D2C marketplace keyword scan
        #
        # For BDP narrations, ONLY scan the SERVICE segment (first BDP- token).
        # Scanning the full narration would match the gateway name (RAZORPAY, CCAVENUEF)
        # instead of the actual payee (e.g., BDP-SHIPROCK-RAZORPAY → should match
        # Shiprocket, not Razorpay).
        # ------------------------------------------------------------------
        if "BDP-" in orig_upper:
            bdp_service_name, _ = _parse_bdp(orig_upper)
            d2c_scan_text = bdp_service_name.lower()
        else:
            d2c_scan_text = orig_upper.lower()

        is_bdp_payment = "BDP-" in orig_upper and not is_credit
        for brand, terms in D2C_KEYWORDS.items():
            if any(t in d2c_scan_text for t in terms):
                subset = self._d2c_ledger_map.get(brand, [])
                if subset:
                    # Direction-aware D2C ledger preference:
                    # Outgoing (debit/payment) → prefer Settlement Clearing A/c or Creditors
                    # Incoming (credit/receipt) → prefer Collection, Seller Receipt, or Settlement
                    # This prevents receipts going to "Debtors" and payments going to "Debtors".
                    if is_bdp_payment or not is_credit:
                        preferred = (
                            next((l for l in subset if 'settlement' in l.lower() or 'clearing' in l.lower()), None)
                            or next((l for l in subset if 'creditor' in l.lower()), None)
                        )
                    else:
                        # Credit/receipt: prefer collection or seller receipt ledgers
                        preferred = (
                            next((l for l in subset if any(k in l.lower() for k in
                                  ['collection', 'seller receipt', 'settlement', 'clearing'])), None)
                        )
                    if preferred:
                        return {"ledger": preferred, "type": txn_type, "confidence": "High",
                                "rule": f"D2C Settlement Match ({brand})"}
                    ledger, conf, _ = self._fuzzy_match(brand, subset)
                    if conf != "Low":
                        return {"ledger": ledger, "type": txn_type, "confidence": conf,
                                "rule": f"D2C Match ({brand})"}
                # No ledger in master for this brand — try full master fuzzy with brand name
                max_term = max(terms, key=len)
                ledger, conf, _ = self._fuzzy_match(max_term, self.master_ledgers)
                if conf != "Low":
                    return {"ledger": ledger, "type": txn_type, "confidence": conf,
                            "rule": f"D2C Broad Match ({brand})"}

        # ------------------------------------------------------------------
        # STEP 14 — General fuzzy: try entity first, then full cleaned narration
        # ------------------------------------------------------------------
        if entity and len(entity) > 2:
            ledger, conf, _ = self._fuzzy_match(entity, self.master_ledgers)
            if conf != "Low":
                return {"ledger": ledger, "type": txn_type, "confidence": conf,
                        "rule": "Fuzzy Entity Match"}

        generic = clean_narration(orig)
        if generic and len(generic) > 3:
            ledger, conf, _ = self._fuzzy_match(generic, self.master_ledgers)
            if conf != "Low":
                return {"ledger": ledger, "type": txn_type, "confidence": conf,
                        "rule": "Fuzzy Generic Match"}

        # ------------------------------------------------------------------
        # FALLBACK — Suspense A/c (pre-computed from master during init)
        # ------------------------------------------------------------------
        return {"ledger": self._suspense_ledger, "type": txn_type, "confidence": "Low", "rule": "Suspense Fallback"}


# ---------------------------------------------------------------------------
# File loaders
# ---------------------------------------------------------------------------

def load_ledger_master(filepath: str) -> list:
    """
    Load ledger names from a Tally 'List of Ledgers' export.
    Auto-detects the right sheet and reads column A.
    Filters out header rows, totals, and group summary lines.
    """
    xl = pd.ExcelFile(filepath)

    # Prefer sheet with ledger/list/master in name
    target = next(
        (s for s in xl.sheet_names
         if any(k in s.lower() for k in ["ledger", "list", "master", "account", "chart"])),
        xl.sheet_names[0]
    )

    df = pd.read_excel(filepath, sheet_name=target, header=None)
    raw = df[0].dropna().astype(str).tolist()

    # Standard Tally group names that appear in hierarchical Chart of Accounts exports —
    # these are not ledgers and should be excluded from the master list.
    _TALLY_GROUPS = {
        "capital account", "reserves & surplus", "current liabilities",
        "loans (liability)", "branch / divisions", "suspense a/c",
        "fixed assets", "investments", "current assets", "misc. expenses (asset)",
        "profit & loss a/c", "purchase accounts", "sales accounts",
        "direct incomes", "indirect incomes", "direct expenses", "indirect expenses",
        "sundry debtors", "sundry creditors", "bank accounts", "bank od a/c",
        "cash-in-hand", "loans & advances (asset)", "deposits (asset)",
        "duties & taxes", "provisions",
        "stock-in-hand", "secured loans", "unsecured loans",
        # One-word accounting terms that are never standalone ledger names
        "assets", "liabilities", "income", "expenses", "equity",
    }

    skip_exact = {"total", "grand total", "list of ledgers", "ledger name", "name"}
    cleaned = []
    for l in raw:
        l = l.strip()
        if not l:
            continue
        if l.lower() in skip_exact:
            continue
        if l.lower() in _TALLY_GROUPS:
            continue
        if l.isdigit():
            continue
        cleaned.append(l)

    return cleaned


def load_bank_statement(filepath: str) -> tuple:
    """
    Auto-detect the bank statement sheet and header row.
    Returns (DataFrame, col_map dict, sheet_name).
    col_map keys: txn_date, description, debit, credit, balance.
    """
    xl = pd.ExcelFile(filepath)

    # Prefer sheet with 'od acc', 'raw', 'statement', 'bank', 'transactions' in name
    target = next(
        (s for s in xl.sheet_names
         if any(k in s.lower() for k in ["od acc", "raw", "statement", "bank", "transactions", "account"])),
        xl.sheet_names[0]
    )

    df_raw = pd.read_excel(filepath, sheet_name=target, header=None)

    header_idx = None
    for i, row in df_raw.iterrows():
        if i > 30:
            break
        vals = [str(v).lower().strip() for v in row.values if pd.notna(v)]
        has_date  = any("date" in v or "txn" in v for v in vals)
        has_desc  = any("desc" in v or "narration" in v or "particulars" in v for v in vals)
        has_amt   = any(any(k in v for k in ["debit", "credit", "withdrawal", "deposit", "amount"]) for v in vals)
        if (has_date and has_desc) or (has_desc and has_amt):
            header_idx = i
            break

    if header_idx is None:
        header_idx = 0

    df_raw.columns = df_raw.iloc[header_idx]
    df = df_raw.iloc[header_idx + 1:].reset_index(drop=True)
    cols = [str(c).strip() for c in df.columns]

    col_map = {}
    for c in cols:
        cl = c.lower()
        if "txn_date" not in col_map and any(k in cl for k in ["txn date", "transaction date", "value date", "date"]):
            col_map["txn_date"] = c
        elif "description" not in col_map and any(k in cl for k in ["description", "narration", "particulars", "details"]):
            col_map["description"] = c
        elif "debit" not in col_map and any(k in cl for k in ["withdrawal", "debit", "dr amount"]):
            col_map["debit"] = c
        elif "credit" not in col_map and any(k in cl for k in ["deposit", "credit", "cr amount"]):
            col_map["credit"] = c
        elif "balance" not in col_map and "balance" in cl:
            col_map["balance"] = c

    return df, col_map, target


# ---------------------------------------------------------------------------
# Output writer
# ---------------------------------------------------------------------------

def write_output(rows: list, summary: dict, brand: str, output_path: str):
    """
    Write classified rows to a color-coded Excel workbook.
    Sheet 1: Bank Statement (7 columns + Confidence)
    Sheet 2: Summary metrics
    """
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Bank Statement"

    # Fills
    GREEN  = PatternFill(start_color="C8E6C9", end_color="C8E6C9", fill_type="solid")
    YELLOW = PatternFill(start_color="FFF9C4", end_color="FFF9C4", fill_type="solid")
    RED    = PatternFill(start_color="FFCDD2", end_color="FFCDD2", fill_type="solid")
    HEADER = PatternFill(start_color="263238", end_color="263238", fill_type="solid")

    WHITE_BOLD = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    BOLD       = Font(name="Calibri", size=11, bold=True)
    REGULAR    = Font(name="Calibri", size=11)
    THIN       = Border(
        left=Side(style='thin', color='CCCCCC'),   right=Side(style='thin', color='CCCCCC'),
        top=Side(style='thin', color='CCCCCC'),    bottom=Side(style='thin', color='CCCCCC'),
    )

    headers = ["Txn Date", "Description", "Debit", "Credit", "Balance", "Type", "Ledger Name", "Confidence"]
    ws.append(headers)
    ws.row_dimensions[1].height = 25
    for ci, _ in enumerate(headers, 1):
        cell = ws.cell(row=1, column=ci)
        cell.fill, cell.font, cell.border = HEADER, WHITE_BOLD, THIN
        cell.alignment = Alignment(horizontal="center", vertical="center")

    for r in rows:
        ws.append([
            r.get("txn_date", ""),
            r.get("description", ""),
            r.get("debit") or "",
            r.get("credit") or "",
            r.get("balance") or "",
            r.get("predicted_type", ""),
            r.get("predicted_ledger", ""),
            r.get("confidence", ""),
        ])
        row_num = ws.max_row
        ws.row_dimensions[row_num].height = 20
        conf   = r.get("confidence", "Low")
        fill   = GREEN if conf == "High" else (YELLOW if conf == "Medium" else RED)

        for ci in range(1, len(headers) + 1):
            cell = ws.cell(row=row_num, column=ci)
            cell.font, cell.border = REGULAR, THIN
            if ci in (3, 4, 5):
                cell.number_format = '#,##0.00'
                cell.alignment = Alignment(horizontal="right", vertical="center")
            elif ci in (1, 6, 8):
                cell.alignment = Alignment(horizontal="center", vertical="center")
            else:
                cell.alignment = Alignment(horizontal="left", vertical="center")
            if ci in (7, 8):
                cell.fill = fill

    # Auto-width
    for col in ws.columns:
        ltr = get_column_letter(col[0].column)
        ws.column_dimensions[ltr].width = min(max(max(len(str(c.value or '')) for c in col) + 3, 10), 55)

    # --- Summary sheet ---
    ws2 = wb.create_sheet("Summary")
    ws2.append([f"Bank Statement Classification — {brand}"])
    ws2.cell(1, 1).font = Font(name="Calibri", size=16, bold=True)
    ws2.row_dimensions[1].height = 30
    ws2.append([])

    hdrs2 = ["Metric", "Count", "Percentage"]
    ws2.append(hdrs2)
    ws2.row_dimensions[3].height = 22
    for ci, _ in enumerate(hdrs2, 1):
        c = ws2.cell(row=3, column=ci)
        c.fill, c.font, c.border = HEADER, WHITE_BOLD, THIN
        c.alignment = Alignment(horizontal="center", vertical="center")

    total = sum(summary.values())
    for lvl, fill in [("High", GREEN), ("Medium", YELLOW), ("Low", RED)]:
        cnt = summary.get(lvl, 0)
        pct = f"{cnt/total*100:.1f}%" if total else "0%"
        ws2.append([f"{lvl} Confidence", cnt, pct])
        rn = ws2.max_row
        ws2.row_dimensions[rn].height = 20
        for ci, v in enumerate([fill, None, None], 1):
            c = ws2.cell(row=rn, column=ci)
            c.font, c.border = (BOLD, THIN)
            c.alignment = Alignment(horizontal="center" if ci > 1 else "left", vertical="center")
            if ci == 1:
                c.fill = fill

    ws2.append(["Total Transactions", total, "100%"])
    rn = ws2.max_row
    ws2.row_dimensions[rn].height = 22
    for ci in range(1, 4):
        c = ws2.cell(row=rn, column=ci)
        c.font, c.border = BOLD, THIN
        c.alignment = Alignment(horizontal="center" if ci > 1 else "left", vertical="center")

    for col in ws2.columns:
        ltr = get_column_letter(col[0].column)
        ws2.column_dimensions[ltr].width = max(max(len(str(c.value or '')) for c in col) + 5, 20)

    wb.save(output_path)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Universal Tally Bank Statement Classifier")
    parser.add_argument("--ledger", required=True,
                        help="Path to List of Ledgers Tally export (Excel)")
    parser.add_argument("--bank",   required=True,
                        help="Path to raw Bank Statement file (Excel or CSV)")
    parser.add_argument("--output", required=True,
                        help="Path to save the classified output Excel file")
    parser.add_argument("--brand",  default="Brand",
                        help="Brand name for the output filename/summary (default: Brand)")
    args = parser.parse_args()

    print(f"[1/4] Loading ledger master: {args.ledger}")
    ledgers = load_ledger_master(args.ledger)
    print(f"      → {len(ledgers)} ledgers loaded.")

    print(f"[2/4] Loading bank statement: {args.bank}")
    df_bank, col_map, sheet = load_bank_statement(args.bank)
    print(f"      → Sheet: '{sheet}' | Columns: {col_map}")

    if not col_map.get("description"):
        print("ERROR: Could not detect a Description/Narration column. "
              "Check that the bank file has a clear header row within the first 30 rows.", file=sys.stderr)
        sys.exit(1)

    print("[3/4] Classifying transactions …")
    classifier = BankClassifier(ledgers)
    rows, summary = [], {"High": 0, "Medium": 0, "Low": 0}

    date_col  = col_map.get("txn_date")
    desc_col  = col_map.get("description")
    debit_col = col_map.get("debit")
    credit_col = col_map.get("credit")
    bal_col   = col_map.get("balance")

    for _, row in df_bank.iterrows():
        txn_date = row.get(date_col, "") if date_col else ""
        desc     = row.get(desc_col)
        if pd.isna(desc) and pd.isna(txn_date):
            continue

        def format_excel_date(val):
            import datetime
            if pd.isna(val) or val == "":
                return ""
            if isinstance(val, (datetime.datetime, datetime.date, pd.Timestamp)):
                return val.strftime("%d-%m-%Y")
            try:
                num = float(val)
                if 30000 <= num <= 60000:
                    base = datetime.datetime(1899, 12, 30)
                    delta = datetime.timedelta(days=num)
                    return (base + delta).strftime("%d-%m-%Y")
            except Exception:
                pass
            val_str = str(val).strip()
            for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"]:
                try:
                    dt = datetime.datetime.strptime(val_str.split(".")[0], fmt)
                    return dt.strftime("%d-%m-%Y")
                except Exception:
                    continue
            if " 00:00:00" in val_str:
                val_str = val_str.replace(" 00:00:00", "")
            return val_str

        formatted_date = format_excel_date(txn_date)

        def safe_float(v):
            try:
                return float(v) if pd.notna(v) and v != "" else 0.0
            except (ValueError, TypeError):
                return 0.0

        debit   = safe_float(row.get(debit_col))  if debit_col  else 0.0
        credit  = safe_float(row.get(credit_col)) if credit_col else 0.0
        balance = safe_float(row.get(bal_col))    if bal_col    else 0.0
        desc_str = str(desc).strip() if pd.notna(desc) else ""

        result = classifier.classify(desc_str, debit, credit)
        summary[result["confidence"]] += 1
        rows.append({
            "txn_date":       formatted_date,
            "description":    desc_str,
            "debit":          debit,
            "credit":         credit,
            "balance":        balance,
            "predicted_type": result["type"],
            "predicted_ledger": result["ledger"],
            "confidence":     result["confidence"],
        })

    total = len(rows)
    print(f"      → {total} rows processed.")
    print(f"         High:   {summary['High']}  ({summary['High']/total*100:.1f}%)")
    print(f"         Medium: {summary['Medium']}  ({summary['Medium']/total*100:.1f}%)")
    print(f"         Low:    {summary['Low']}  ({summary['Low']/total*100:.1f}%)")

    print(f"[4/4] Writing output: {args.output}")
    write_output(rows, summary, args.brand, args.output)
    print(f"\n✅ Done! Output saved to: {args.output}")
    print(f"   Open the file and review any RED (Low confidence) rows manually.")


if __name__ == "__main__":
    main()
