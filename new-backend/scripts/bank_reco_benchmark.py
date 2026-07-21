# new-backend/scripts/bank_reco_benchmark.py
# Usage: python3 scripts/bank_reco_benchmark.py <RBL.xlsx> <Master.xlsx> [--table1-sheet "Table 1"]
import sys, os, json, tempfile, subprocess
import pandas as pd

def norm(s):
    return "" if s is None else str(s).upper().strip().replace("\n", " ").replace("  ", " ")

def main():
    rbl, coa = sys.argv[1], sys.argv[2]
    sheet = "Table 1"
    df = pd.read_excel(rbl, sheet_name=sheet, engine="openpyxl", header=1)
    # Resolve columns by name (dynamic)
    def col(*keys):
        for c in df.columns:
            cl = str(c).lower().replace(" ", "")
            if all(k in cl for k in keys): return c
        return None
    c_narr, c_wdr, c_dep, c_date, c_led = col("narration"), col("withdrawal"), col("deposit"), col("date"), col("ledger", "tally")
    gt = df[[c_narr, c_wdr, c_dep, c_date, c_led]].copy()
    gt = gt[gt[c_led].notna()]

    # Build a minimal bank-statement xlsx classify.py can parse: Date, Narration, Withdrawal, Deposit
    with tempfile.TemporaryDirectory() as td:
        bank_path = os.path.join(td, "bank.xlsx")
        out_path = os.path.join(td, "out.xlsx")
        bank = gt[[c_date, c_narr, c_wdr, c_dep]].copy()
        bank.columns = ["Date", "Narration", "Withdrawal", "Deposit"]
        bank.to_excel(bank_path, index=False)
        here = os.path.dirname(__file__)
        subprocess.run(["python3", os.path.join(here, "classify.py"),
                        "--ledger", coa, "--bank", bank_path, "--output", out_path,
                        "--brand", "FLO"], check=True)
        pred = pd.read_excel(out_path, sheet_name="Bank Statement", engine="openpyxl")

    # Align by row order (both derived from same rows in order)
    n = min(len(gt), len(pred))
    truth = gt[c_led].astype(str).map(norm).tolist()[:n]
    got = pred["Ledger Name"].astype(str).map(norm).tolist()[:n]
    hits = sum(1 for a, b in zip(truth, got) if a == b)
    print(f"rows compared: {n}")
    print(f"exact-ledger accuracy: {hits}/{n} = {100.0*hits/max(n,1):.1f}%")
    # Show 15 mismatches for inspection
    miss = [(gt[c_narr].iloc[i], truth[i], got[i]) for i in range(n) if truth[i] != got[i]]
    print(f"mismatches: {len(miss)} (showing 15)")
    for narr, t, g in miss[:15]:
        print(f"  NARR={str(narr)[:50]!r:52} truth={t[:28]!r:30} got={g[:28]!r}")

if __name__ == "__main__":
    main()
