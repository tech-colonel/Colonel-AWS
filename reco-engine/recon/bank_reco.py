import re
import pandas as pd
from thefuzz import process, fuzz
import io
import datetime
from uuid import uuid4

IGNORE_KEYWORDS = [
    "NEFT", "RTGS", "IMPS", "UPI", "MB", "TO", "FROM", "DR", "CR", "BANK",
    "TRANSFER", "REF", "REFERENCE", "UTR", "ID", "TXN", "BRANCH",
    "IB", "SC", "OTHER", "THAN", "SB", "IMB", "CNRBH", "ONLINE", "TRANSACTION",
    "BDP", "PAYMENT", "AGAINST", "INVOICE", "DUE", "CLEARED"
]

def clean_narration(narration: str) -> str:
    if not narration or not isinstance(narration, str):
        return ""
    text = narration.upper()
    # Remove account numbers and long numeric strings
    text = re.sub(r'\d{10,}', ' ', text)
    text = re.sub(r'[^A-Z0-9\s]', ' ', text)
    words = text.split()
    cleaned_words = []
    for w in words:
        if w in IGNORE_KEYWORDS:
            continue
        if any(c.isdigit() for c in w) and len(w) > 6:
            continue
        cleaned_words.append(w)
    return " ".join(cleaned_words)

class ClassifierEngine:
    def __init__(self, master_ledgers: list[str]):
        self.master_ledgers = [l for l in master_ledgers if l]
        self.salary_ledgers = [l for l in self.master_ledgers if any(k in l.lower() for k in ['salary', 'stipend', 'wages'])]
        self.tds_ledgers = [l for l in self.master_ledgers if 'tds' in l.lower()]
        self.bank_charge_ledgers = [l for l in self.master_ledgers if any(k in l.lower() for k in ['bank', 'charge'])]
        # Own accounts (for Contra logic)
        self.own_account_ledgers = [
            l for l in self.master_ledgers
            if any(k in l.lower() for k in ['bank', 'cash', '120001771174', '170006544612'])
            and not any(k in l.lower() for k in ['charge', 'interest', 'commission', 'fees', 'expense', 'brand funded', 'marketing'])
        ]
        # Canonical suspense ledger — prefer exact "Suspense A/c" over variants
        # like "Suspenses" that some CoA exports include.
        self._suspense_ledger = (
            next((l for l in self.master_ledgers if l.strip().lower() == 'suspense a/c'), None)
            or next((l for l in self.master_ledgers if 'suspense' in l.lower()), None)
            or "Suspense A/c"
        )

    def _fuzzy_match(self, query: str, choices: list[str], threshold: int = 85) -> tuple[str, str]:
        if not choices or not query.strip():
            return "Unknown", "Low"
        
        query_upper = query.upper()
        # Try exact match first
        for choice in choices:
            if choice.upper() == query_upper:
                return choice, "High"
                
        best_match, score = process.extractOne(query, choices, scorer=fuzz.token_set_ratio)
        if score >= threshold: confidence = "High"
        elif score >= 70: confidence = "Medium"
        else: confidence = "Low"
        return best_match, confidence

    def is_clean_name(self, name: str) -> bool:
        if not name or len(name) > 60:
            return False
        if re.search(r'[/@*#%{}()\[\]\\]', name):
            return False
        if sum(c.isdigit() for c in name) > 5:
            return False
        if name.count('-') > 2:
            return False
        # If it's a known non-name string
        if any(k in name.upper() for k in ["PAYMENT", "SALARY", "ALLOWANCE", "LABOUR", "WAGES"]):
            return False
        return True

    def extract_entity_name(self, narration: str) -> tuple[str, bool]:
        text = str(narration).strip()
        is_upi = False
        
        if 'UPI/' in text:
            is_upi = True
            parts = text.split('/')
            if len(parts) >= 4:
                name = parts[3].strip()
                name = re.sub(r'[*]{0,2}\d+@\w+', '', name)
                name = re.sub(r'PAY TO M.*', '', name, flags=re.IGNORECASE)
                return name.strip(), True
                
        # Remove banking prefixes
        text = re.sub(r'^(IB|SC)?\s*(NEFT|RTGS|IMPS|IFT|OAT|ITG)\s*(Dr|Cr)?\s*[A-Z0-9]{4,20}\s*', '', text, flags=re.IGNORECASE)
        # Clean common noise
        noise_patterns = [
            r'(?i)^\s*Online Transaction\s*',
            r'(?i)Payment against.*',
            r'(?i)Advance on.*',
            r'(?i)Drips Foods.*',
            r'(?i)^BDP-',
            r'(?i)\s+Payment\s*$',
            r'(?i)\s+Paid\s*$',
            r'(?i)\s+Due\s*$'
        ]
        for pat in noise_patterns:
            text = re.sub(pat, '', text).strip()
        
        # Split and remove gateways
        parts = re.split(r'[-\s/]', text)
        cleaned_parts = []
        gateways = ["CCAVENUEF", "CASHFREE", "RAZORPAY", "PAYTM", "BILLDESK", "PAYU", "ITG", "BDP", "CLIENTCODE"]
        for p in parts:
            p_s = p.strip()
            if not p_s or p_s.upper() in gateways: continue
            if re.match(r'[A-Z]{4}0[A-Z0-9]{6}', p_s.upper()): continue
            if p_s.isdigit() and len(p_s) > 6: continue
            cleaned_parts.append(p_s)
        
        return " ".join(cleaned_parts).strip(), is_upi

    def _match_acronym(self, text: str) -> str:
        for ledger in self.master_ledgers:
            clean_ledger = re.sub(r'[/()\-]', ' ', ledger.upper())
            words = [w for w in clean_ledger.split() if w]
            if len(words) < 2: continue
            acronym = "".join([w[0] for w in words])
            if acronym and len(acronym) >= 3:
                tokens = re.split(r'[\s\-]', text.upper())
                if acronym in tokens:
                    return ledger
        return ""

    def classify_transaction(self, narration: str, debit: float, credit: float) -> dict:
        # Safely coerce debit and credit to floats to handle any string values in Excel
        try:
            debit = float(debit) if (debit is not None and not pd.isna(debit)) else 0.0
        except (ValueError, TypeError):
            debit = 0.0
        try:
            credit = float(credit) if (credit is not None and not pd.isna(credit)) else 0.0
        except (ValueError, TypeError):
            credit = 0.0

        result = self._classify_logic(narration, debit, credit)
        orig_upper = str(narration).upper() if narration else ""
        
        # Final Type Override (Contra Logic)
        if result['ledger'] in self.own_account_ledgers or "IB OAT" in orig_upper:
            # Exclude charges and interest from being marked as Contra
            if not any(k in result['ledger'].lower() for k in ['charge', 'interest', 'tax', 'tds']):
                result['type'] = "Contra"
        
        return result

    def _classify_logic(self, narration: str, debit: float, credit: float) -> dict:
        orig_upper = str(narration).upper() if narration else ""
        txn_type = "Payment" if (debit and float(debit) > 0) else "Receipt"
        
        # 1. Context-Aware Hard Mappings (Accountant Priority)
        context_mappings = [
            (r"SHIVEN CHATURVEDI.*SALARY", "Salary Payable - Shiven Chaturvedi"),
            (r"SHIVEN CHATURVEDI", "Shiven Chaturvedi Reimbrusement"),
            (r"VAIBHAV.*TOSHNIWAL.*SALARY", "Salary Payable - Vaibhav Vinay Toshniwal"),
            (r"VAIBHAV.*TOSHNIWAL", "Vaibhav Vinay Toshniwal"),
            (r"NITIN BORANA", "Nitin Borana"),
            (r"KRISHNA Ramchandani", "Krishna Ramchandani"),
            (r"KRISHNA PRODUCTS.*00126646698|00126646698.*KRISHNA PRODUCTS", "Krishna Products"),
            (r"KRISHNA PRODUCTS", "Krishna Enterprise"),
            (r"ASHA RAM.*DUE CLEARED", "Asha Ram and Sons Pvt Ltd"),
            (r"ASHA RAM", "Asha Ram and Sons Pvt Ltd"),
            (r"BLINKIT|BLINKCOMMERCE", "Blinkit Settlement Clearing A/c"),
            (r"FACEBOOK", "FACEBOOK INDIA ONLINE SERVICES PRIVATE LIMITED"),
            (r"SHIPROCKET|SHIPROCK", "Shiprocket Limited"),
            (r"GODOWN SC CHARGES", "Rent"),
            (r"\bCRED\b", "Suspense A/c"),
            (r"GSTN", "GST Payable"),
            (r"INTEREST CAPITALIZED|CASA DEBIT INTEREST", "Interest Exp"),
            (r"\bESI\b", "ESIC Payable"),
            (r"\bEPF\b", "Provident Fund Payable"),
            (r"NSDL|NATIONAL SECURITIES DEPOSITORY", "NSDL E-GOVERNANCE INFRASTRUCTURE LIMITED"),
            (r"VRL", "VRL Logistics Limited"),
            (r"ZEPTO", "Zepto Private Limited Gujarat"),
            (r"FLAVAROMA", "Flavaroma Flavours and Fragrances"),
            (r"ORCHESTRADE", "ORCHESTRADE TECHNOLOGIES PRIVATE LIMITED"),
            (r"UGVCL", "Uttar Gujrat Vij Company Limited"),
            (r"COLONEL CONSULTING", "Colonel Consulting Partners LLP"),
            (r"MISTRY RAHUL", "Mistry Rahul Jagdishbhai-Salary A/c"),
            (r"RATHOD GEETABEN", "Salary Payable - Geeta Ben Rathod"),
            (r"KINJALBEN.*WAGHELA", "Salary Payable - Kinjal Vaghela"),
            (r"PARMAR JAYKUMAR", "Salary Payable - Jay Parmar"),
            (r"SUDHIR BALGOVIND GUPTA", "Salary Payable - Sudhir Gupta"),
            (r"VIJAY BALGOVIND GUPTA", "Vijay Balgovind Gupta-Salary A/c"),
            (r"HEMANT PAL SINGH", "Salary Payable-Hemant"),
            (r"AAKASH YADAV", "Salary Payable-Akash"),
            (r"RAMANANDI", "Suspense A/c"),
            (r"NANDINI S", "Suspense A/c"),
            (r"SHREYA", "Suspense A/c"),
            (r"LABOUR|FACTORY MILK", "Riteshbhai Ganpatbhai Parmar-Salary A/c"),
            (r"PARTH BAHERAWALA|AC REPAIR", "Parth Bharewala"),
            (r"CHANDRASHEKAR DATTATRAY", "Salary Payable - Chandrashekhar Shinde"),
            (r"ROYAL FABRIC BAGS", "Royal Fabric Bags"),
            (r"ALPINO.*HEALTHFOODS", "Alpino Health Foods Private Limited")
        ]
        
        for pattern, ledger in context_mappings:
            if re.search(pattern, orig_upper):
                return {"ledger": ledger, "type": txn_type, "confidence": "High", "cleaned": ledger}

        # 2. Bank Account Fallback (Priority)
        acc_match = re.search(r'\d{10,16}', orig_upper)
        if acc_match:
            acc_no = acc_match.group(0)
            match = next((l for l in self.master_ledgers if acc_no in l), None)
            if match:
                return {"ledger": match, "type": txn_type, "confidence": "High", "cleaned": match}

        # 3. Bank Charges
        if any(k in orig_upper for k in ["OTHER THAN SB IMB", "SC CHARGES", "BANK CHARGES"]):
            ledger = next((l for l in self.master_ledgers if l.lower() == 'bank charges'), "Bank Charges")
            return {"ledger": ledger, "type": "Payment", "confidence": "High", "cleaned": "Bank Charges"}

        # 3. Interest
        if "INTEREST" in orig_upper:
            return {"ledger": "Interest Exp", "type": txn_type, "confidence": "High", "cleaned": "Interest"}

        # 4. Salary/Wages Logic
        is_salary = any(sk in orig_upper for sk in ["SALARY", "WAGES", "STIPEND", "TA DA", "HONORARIUM", "REIMBURSEMENT", "EXPENSE REIMB", "ALLOWANCE", "LABOUR"])
        name, is_upi = self.extract_entity_name(narration)
        
        # Account Number Fallback
        acc_match = re.search(r'\d{10,16}', narration)
        if acc_match:
            acc_no = acc_match.group(0)
            match = next((l for l in self.master_ledgers if acc_no in l), None)
            if match:
                return {"ledger": match, "type": txn_type, "confidence": "High", "cleaned": acc_no}

        # Fuzzy Match
        ledger, conf = self._fuzzy_match(name, self.master_ledgers)
        
        if len(name) < 4 and conf == "High":
            if not any(re.search(rf'\b{re.escape(name)}\b', l, re.I) for l in [ledger]):
                conf = "Low"

        if is_salary:
            sal_ledger, sal_conf = self._fuzzy_match(name, self.salary_ledgers, threshold=80)
            if sal_conf != "Low":
                return {"ledger": sal_ledger, "type": txn_type, "confidence": "High", "cleaned": name}
            if self.is_clean_name(name) and conf == "Low":
                return {"ledger": name, "type": txn_type, "confidence": "Medium", "cleaned": name}
            if any(k in orig_upper for k in ["LABOUR", "WAGES", "FACTORY MILK"]):
                return {"ledger": "Wages Expense", "type": txn_type, "confidence": "Medium", "cleaned": name}

        if ("TDS" in orig_upper or "194" in orig_upper or "TIN" in orig_upper) and conf == "Low" and not is_salary:
            return {"ledger": "TDS Payable", "type": txn_type, "confidence": "Medium", "cleaned": "TDS"}

        # Final Fallback
        if conf == "Low":
            if is_upi or len(name) > 35 or not self.is_clean_name(name):
                return {"ledger": self._suspense_ledger, "type": txn_type, "confidence": "Low", "cleaned": name}
            if len(name) > 3:
                return {"ledger": name, "type": txn_type, "confidence": "Low", "cleaned": name}
            else:
                return {"ledger": self._suspense_ledger, "type": txn_type, "confidence": "Low", "cleaned": name}
            
        return {"ledger": ledger, "type": txn_type, "confidence": conf, "cleaned": name}

import os

def process_bank_statement(file_content: bytes) -> tuple[dict, list[dict]]:
    # Load Master Ledgers from internal data folder
    base_dir = os.path.dirname(os.path.abspath(__file__))
    master_path = os.path.join(base_dir, "data", "Master.xlsx")
    df_ledgers = pd.read_excel(master_path, sheet_name='List of Ledgers ', header=None)
    master_ledgers = df_ledgers[0].dropna().astype(str).tolist()
    
    # Read the uploaded bank statement
    # We will try 'OD Acc' first, but if it doesn't exist, we fallback to the first sheet
    try:
        df_od = pd.read_excel(io.BytesIO(file_content), sheet_name='OD Acc', header=None)
    except ValueError:
        df_od = pd.read_excel(io.BytesIO(file_content), header=None)
        
    header_idx = None
    for i, row in df_od.iterrows():
        if 'Txn Date' in row.values:
            header_idx = i
            break
            
    if header_idx is None:
        raise ValueError("Could not find header 'Txn Date' in OD Acc sheet")
        
    df_od.columns = df_od.iloc[header_idx]
    df_od = df_od.iloc[header_idx + 1:].reset_index(drop=True)
    engine = ClassifierEngine(master_ledgers)
    
    review_data = []
    summary = {"High": 0, "Medium": 0, "Low": 0}
    
    for idx, row in df_od.iterrows():
        txn_date = row.get('Txn Date')
        desc = row.get('Description')
        if pd.isna(txn_date) and pd.isna(desc):
            continue
            
        debit = row.get('Debit', 0)
        credit = row.get('Credit', 0)
        balance = row.get('Balance', 0)
        if pd.isna(debit): debit = 0
        if pd.isna(credit): credit = 0
        if pd.isna(balance): balance = 0
        desc_str = "" if pd.isna(desc) else str(desc)
            
        result = engine.classify_transaction(desc_str, debit, credit)
        conf = result['confidence']
        summary[conf] += 1
        
        review_data.append({
            'category': f"{conf} Confidence",
            'confidence': conf,
            'txn_date': str(txn_date),
            'original_description': desc_str,
            'cleaned_description': result['cleaned'],
            'debit': float(debit) if debit else 0.0,
            'credit': float(credit) if credit else 0.0,
            'predicted_type': result['type'],
            'predicted_ledger': result['ledger'],
            'balance': balance
        })
        
    job_id = uuid4().hex
    
    payload = {
        "job_id": job_id,
        "reco_type": "bank_reco",
        "summary": {f"{k} Confidence": v for k, v in summary.items() if v > 0},
        "counts": {
            "master_ledgers": len(master_ledgers),
            "bank_rows": len(review_data),
            "result_rows": len(review_data),
        },
        "results": review_data
    }
    return payload
