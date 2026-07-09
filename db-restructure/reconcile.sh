#!/usr/bin/env bash
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
NEW=colonel_agent_accountant
H=(-U postgres -h localhost)
q() { psql "${H[@]}" -d "$1" -tAc "$2" 2>/dev/null; }

MASTER=(agent_workflows agents brand_agents brand_users brands compliance_attachments compliance_categories compliance_chat_messages compliance_tasks conversations integrations mcp_servers meeting_pins plans statutory_filings task_messages tasks user_google_accounts users zoho_accounts zoho_bank_accounts zoho_bank_transactions zoho_contacts zoho_items zoho_organizations zoho_sync_log zoho_vouchers)
BRANDTBL=(reco_jobs bank_reco_results bank_reco_corrections bank_payee_directory gstr_2b_results gstr_2a_2b_results gstr_3b_results gstr_1_results gstr_3b_tally_results ledger_master gstr3b_runs gstr3b_coa_master gstr3b_vt_master invoice_process invoice_agent flipkart amazon nykaa myntra meesho sales_amazon ajio sales_cread total_sales_analyzer shopify_order_cycle settlement_amazon sales_shopify sales_mirrow sales_zepto sales_myntra sales_jiomart sales_flipkart sales_blinkit gstr_2b_books)

BRANDS=$(q colonel-master "SELECT datname FROM pg_database WHERE datname LIKE 'colonel%' AND datname NOT IN ('colonel-master','colonel_v2','colonel_agent_accountant') ORDER BY 1")

fail=0; totS=0; totN=0
printf "%-26s %8s %8s  %s\n" "TABLE" "SOURCE" "NEW" "STATUS"
echo "-- MASTER (vs colonel-master) --"
for t in "${MASTER[@]}"; do
  s=$(q colonel-master "SELECT count(*) FROM \"$t\"" || echo 0); s=${s:-0}
  n=$(q "$NEW" "SELECT count(*) FROM \"$t\"" || echo 0); n=${n:-0}
  st="OK"; [ "$s" != "$n" ] && { st="MISMATCH"; fail=$((fail+1)); }
  totS=$((totS+s)); totN=$((totN+n))
  [ "$s" != "0" -o "$n" != "0" ] && printf "%-26s %8s %8s  %s\n" "$t" "$s" "$n" "$st"
done
echo "-- BRAND tables (source = SUM across brand DBs) --"
for t in "${BRANDTBL[@]}"; do
  s=0
  while IFS= read -r db; do [ -z "$db" ] && continue
    if [ "$(q "$db" "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='$t'")" = "1" ]; then
      c=$(q "$db" "SELECT count(*) FROM \"$t\""); s=$((s + ${c:-0})); fi
  done <<< "$BRANDS"
  n=$(q "$NEW" "SELECT count(*) FROM \"$t\""); n=${n:-0}
  st="OK"; [ "$s" != "$n" ] && { st="MISMATCH"; fail=$((fail+1)); }
  totS=$((totS+s)); totN=$((totN+n))
  [ "$s" != "0" -o "$n" != "0" ] && printf "%-26s %8s %8s  %s\n" "$t" "$s" "$n" "$st"
done
echo "-------------------------------------------------"
printf "%-26s %8s %8s\n" "TOTAL ROWS" "$totS" "$totN"
echo "MISMATCHES: $fail"
