/**
 * 04-agent-workflows.js
 *
 * Agent-workflow delta seeder — adds the 4 workflows built locally in the
 * admin Workflow Manager to colonel-master's agent_workflows table:
 *   - Shopify urban        (agent: Sales-Shopify)
 *   - Firstcry M Brands    (agent: Sales-FirstCry)
 *   - shopify-koparo       (agent: Sales-Shopify)
 *   - koparo-cread         (agent: Sales-cread)
 *
 * Idempotent: ON CONFLICT (id) DO NOTHING — safe to re-run.
 *
 * The parent agent is resolved BY NAME (not a hardcoded id) because agent
 * ids are random UUIDv4 and are not guaranteed to match between the local
 * DB and AWS (see CLAUDE.md — 'Agent + brand IDs are now random UUIDv4').
 * Requires the parent agents (Sales-Shopify, Sales-FirstCry, Sales-cread)
 * to already exist in the agents table — they do on both local and AWS.
 *
 * Requires the agent_workflows.file_inputs column to exist — run
 * migrations/add-workflow-file-inputs.js first if seeding a DB that
 * predates the multi-file-input workflow feature.
 *
 * The JSONB payloads (sample_columns, columns, sheets, file_inputs) are
 * copied verbatim from the local agent_workflows rows — do not hand-edit.
 *
 * Usage:
 *   cd new-backend && node seed-agent-workflows.js
 */

const AGENT_WORKFLOWS = [
  {
    id: "231e59e7-f217-4805-b728-5511ee513512",
    agentName: "Sales-Shopify",
    name: "Shopify urban",
    description: "",
    sample_columns: [
      "Seller Gstin",
      "Invoice Number",
      "Invoice Date",
      "Transaction Type",
      "Order Id",
      "Shipment Id",
      "Shipment Date",
      "Order Date",
      "Shipment Item Id",
      "Quantity",
      "Item Description",
      "Asin",
      "Hsn/sac",
      "Sku",
      "Product Tax Code",
      "Bill From City",
      "Bill From State",
      "Bill From Country",
      "Bill From Postal Code",
      "Ship From City",
      "Ship From State",
      "Ship From Country",
      "Ship From Postal Code",
      "Ship To City",
      "Ship To State",
      "Ship To Country",
      "Ship To Postal Code",
      "Invoice Amount",
      "Tax Exclusive Gross",
      "Total Tax Amount",
      "Cgst Rate",
      "Sgst Rate",
      "Utgst Rate",
      "Igst Rate",
      "Compensatory Cess Rate",
      "Principal Amount",
      "Principal Amount Basis",
      "Cgst Tax",
      "Sgst Tax",
      "Igst Tax",
      "Utgst Tax",
      "Compensatory Cess Tax",
      "Shipping Amount",
      "Shipping Amount Basis",
      "Shipping Cgst Tax",
      "Shipping Sgst Tax",
      "Shipping Utgst Tax",
      "Shipping Igst Tax",
      "Shipping Cess Tax Amount",
      "Gift Wrap Amount",
      "Gift Wrap Amount Basis",
      "Gift Wrap Cgst Tax",
      "Gift Wrap Sgst Tax",
      "Gift Wrap Utgst Tax",
      "Gift Wrap Igst Tax",
      "Gift Wrap Compensatory Cess Tax",
      "Item Promo Discount",
      "Item Promo Discount Basis",
      "Item Promo Tax",
      "Shipping Promo Discount",
      "Shipping Promo Discount Basis",
      "Shipping Promo Tax",
      "Gift Wrap Promo Discount",
      "Gift Wrap Promo Discount Basis",
      "Gift Wrap Promo Tax",
      "Tcs Cgst Rate",
      "Tcs Cgst Amount",
      "Tcs Sgst Rate",
      "Tcs Sgst Amount",
      "Tcs Utgst Rate",
      "Tcs Utgst Amount",
      "Tcs Igst Rate",
      "Tcs Igst Amount",
      "Warehouse Id",
      "Fulfillment Channel",
      "Payment Method Code",
      "Credit Note No",
      "Credit Note Date"
    ],
    columns: [],
    sheets: [
      {
        "id": "sheet_1785158836983_lh8tw",
        "name": "working",
        "order": 0,
        "columns": [
          {
            "id": "col_1785158858430_4m84p",
            "key": "Seller Gstin",
            "type": "source",
            "label": "Seller Gstin",
            "order": 0
          },
          {
            "id": "col_1785158858430_9kw0t",
            "key": "Invoice Number",
            "type": "source",
            "label": "Invoice Number",
            "order": 1
          },
          {
            "id": "col_1785158858430_hnpmx",
            "key": "Invoice Date",
            "type": "source",
            "label": "Invoice Date",
            "order": 2
          },
          {
            "id": "col_1785158858430_utwrc",
            "key": "Transaction Type",
            "type": "source",
            "label": "Transaction Type",
            "order": 3
          },
          {
            "id": "col_1785158858430_v6cnp",
            "key": "Order Id",
            "type": "source",
            "label": "Order Id",
            "order": 4
          },
          {
            "id": "col_1785158858430_2kox2",
            "key": "Shipment Id",
            "type": "source",
            "label": "Shipment Id",
            "order": 5
          },
          {
            "id": "col_1785158858430_s857q",
            "key": "Order Date",
            "type": "source",
            "label": "Order Date",
            "order": 6
          },
          {
            "id": "col_1785158858430_ksjsm",
            "key": "Shipment Item Id",
            "type": "source",
            "label": "Shipment Item Id",
            "order": 7
          },
          {
            "id": "col_1785158858430_t6okx",
            "key": "Quantity",
            "type": "source",
            "label": "Quantity",
            "order": 8
          },
          {
            "id": "col_1785158858430_givuj",
            "key": "Item Description",
            "type": "source",
            "label": "Item Description",
            "order": 9
          },
          {
            "id": "col_1785158858430_4ym8m",
            "key": "Asin",
            "type": "source",
            "label": "Asin",
            "order": 10
          },
          {
            "id": "col_1785158858430_rv6su",
            "key": "Hsn/sac",
            "type": "source",
            "label": "Hsn/sac",
            "order": 11
          },
          {
            "id": "col_1785158858430_d1t4t",
            "key": "Sku",
            "type": "source",
            "label": "Sku",
            "order": 12
          },
          {
            "id": "col_1785158858430_hvdgi",
            "key": "Product Tax Code",
            "type": "source",
            "label": "Product Tax Code",
            "order": 13
          },
          {
            "id": "col_1785158858430_notj5",
            "key": "Bill From City",
            "type": "source",
            "label": "Bill From City",
            "order": 14
          },
          {
            "id": "col_1785158858430_ieu6b",
            "key": "Bill From State",
            "type": "source",
            "label": "Bill From State",
            "order": 15
          },
          {
            "id": "col_1785158858430_2j1kq",
            "key": "Bill From Country",
            "type": "source",
            "label": "Bill From Country",
            "order": 16
          },
          {
            "id": "col_1785158858430_etvhn",
            "key": "Bill From Postal Code",
            "type": "source",
            "label": "Bill From Postal Code",
            "order": 17
          },
          {
            "id": "col_1785158858430_m5xo5",
            "key": "Ship From City",
            "type": "source",
            "label": "Ship From City",
            "order": 18
          },
          {
            "id": "col_1785158858430_39qzd",
            "key": "Ship From State",
            "type": "source",
            "label": "Ship From State",
            "order": 19
          },
          {
            "id": "col_1785158858430_tjd04",
            "key": "Ship From Country",
            "type": "source",
            "label": "Ship From Country",
            "order": 20
          },
          {
            "id": "col_1785158858430_0xfok",
            "key": "Ship From Postal Code",
            "type": "source",
            "label": "Ship From Postal Code",
            "order": 21
          },
          {
            "id": "col_1785158858430_cwt1m",
            "key": "Ship To City",
            "type": "source",
            "label": "Ship To City",
            "order": 22
          },
          {
            "id": "col_1785158858430_unu6b",
            "key": "Ship To State",
            "type": "source",
            "label": "Ship To State",
            "order": 23
          },
          {
            "id": "col_1785158858430_k7jbb",
            "key": "Ship To Country",
            "type": "source",
            "label": "Ship To Country",
            "order": 24
          },
          {
            "id": "col_1785158858430_p7tdk",
            "key": "Ship To Postal Code",
            "type": "source",
            "label": "Ship To Postal Code",
            "order": 25
          },
          {
            "id": "col_1785158858430_hz427",
            "key": "Invoice Amount",
            "type": "source",
            "label": "Invoice Amount",
            "order": 26
          },
          {
            "id": "col_1785158858430_syy2k",
            "key": "Tax Exclusive Gross",
            "type": "source",
            "label": "Tax Exclusive Gross",
            "order": 27
          },
          {
            "id": "col_1785158858430_rnpc9",
            "key": "Total Tax Amount",
            "type": "source",
            "label": "Total Tax Amount",
            "order": 28
          },
          {
            "id": "col_1785158858430_pfwmp",
            "key": "Cgst Rate",
            "type": "source",
            "label": "Cgst Rate",
            "order": 29
          },
          {
            "id": "col_1785158858430_k5iiw",
            "key": "Sgst Rate",
            "type": "source",
            "label": "Sgst Rate",
            "order": 30
          },
          {
            "id": "col_1785158858430_fbcor",
            "key": "Utgst Rate",
            "type": "source",
            "label": "Utgst Rate",
            "order": 31
          },
          {
            "id": "col_1785158858430_wluaq",
            "key": "Igst Rate",
            "type": "source",
            "label": "Igst Rate",
            "order": 32
          },
          {
            "id": "col_1785158858430_6rasq",
            "key": "Compensatory Cess Rate",
            "type": "source",
            "label": "Compensatory Cess Rate",
            "order": 33
          },
          {
            "id": "col_1785158858430_h2754",
            "key": "Principal Amount",
            "type": "source",
            "label": "Principal Amount",
            "order": 34
          },
          {
            "id": "col_1785158858430_scrby",
            "key": "Principal Amount Basis",
            "type": "source",
            "label": "Principal Amount Basis",
            "order": 35
          },
          {
            "id": "col_1785158858430_6jvqv",
            "key": "Cgst Tax",
            "type": "source",
            "label": "Cgst Tax",
            "order": 36
          },
          {
            "id": "col_1785158858430_rd3d4",
            "key": "Sgst Tax",
            "type": "source",
            "label": "Sgst Tax",
            "order": 37
          },
          {
            "id": "col_1785158858430_5qi5v",
            "key": "Igst Tax",
            "type": "source",
            "label": "Igst Tax",
            "order": 38
          },
          {
            "id": "col_1785158858430_fnk0c",
            "key": "Utgst Tax",
            "type": "source",
            "label": "Utgst Tax",
            "order": 39
          },
          {
            "id": "col_1785158858430_5vwfq",
            "key": "Compensatory Cess Tax",
            "type": "source",
            "label": "Compensatory Cess Tax",
            "order": 40
          },
          {
            "id": "col_1785158858430_hcllk",
            "key": "Shipping Amount",
            "type": "source",
            "label": "Shipping Amount",
            "order": 41
          },
          {
            "id": "col_1785158858430_agiw7",
            "key": "Shipping Amount Basis",
            "type": "source",
            "label": "Shipping Amount Basis",
            "order": 42
          },
          {
            "id": "col_1785158858430_o9raa",
            "key": "Shipping Cgst Tax",
            "type": "source",
            "label": "Shipping Cgst Tax",
            "order": 43
          },
          {
            "id": "col_1785158858430_n6hiu",
            "key": "Shipping Sgst Tax",
            "type": "source",
            "label": "Shipping Sgst Tax",
            "order": 44
          },
          {
            "id": "col_1785158858430_f2vif",
            "key": "Shipping Utgst Tax",
            "type": "source",
            "label": "Shipping Utgst Tax",
            "order": 45
          },
          {
            "id": "col_1785158858430_ci5p2",
            "key": "Shipping Igst Tax",
            "type": "source",
            "label": "Shipping Igst Tax",
            "order": 46
          },
          {
            "id": "col_1785158858430_ef7eg",
            "key": "Shipping Cess Tax Amount",
            "type": "source",
            "label": "Shipping Cess Tax Amount",
            "order": 47
          },
          {
            "id": "col_1785158858430_fm3e5",
            "key": "Gift Wrap Amount",
            "type": "source",
            "label": "Gift Wrap Amount",
            "order": 48
          },
          {
            "id": "col_1785158858430_3lcf8",
            "key": "Gift Wrap Amount Basis",
            "type": "source",
            "label": "Gift Wrap Amount Basis",
            "order": 49
          },
          {
            "id": "col_1785158858430_a2s64",
            "key": "Gift Wrap Cgst Tax",
            "type": "source",
            "label": "Gift Wrap Cgst Tax",
            "order": 50
          },
          {
            "id": "col_1785158858430_30xmu",
            "key": "Gift Wrap Sgst Tax",
            "type": "source",
            "label": "Gift Wrap Sgst Tax",
            "order": 51
          },
          {
            "id": "col_1785158858430_virz3",
            "key": "Gift Wrap Utgst Tax",
            "type": "source",
            "label": "Gift Wrap Utgst Tax",
            "order": 52
          },
          {
            "id": "col_1785158858430_ehxsu",
            "key": "Gift Wrap Igst Tax",
            "type": "source",
            "label": "Gift Wrap Igst Tax",
            "order": 53
          },
          {
            "id": "col_1785158858430_dycur",
            "key": "Gift Wrap Compensatory Cess Tax",
            "type": "source",
            "label": "Gift Wrap Compensatory Cess Tax",
            "order": 54
          },
          {
            "id": "col_1785158858430_fnit8",
            "key": "Item Promo Discount",
            "type": "source",
            "label": "Item Promo Discount",
            "order": 55
          },
          {
            "id": "col_1785158858430_ylwep",
            "key": "Item Promo Discount Basis",
            "type": "source",
            "label": "Item Promo Discount Basis",
            "order": 56
          },
          {
            "id": "col_1785158858430_wz3gu",
            "key": "Item Promo Tax",
            "type": "source",
            "label": "Item Promo Tax",
            "order": 57
          },
          {
            "id": "col_1785158858430_60fq1",
            "key": "Shipping Promo Discount",
            "type": "source",
            "label": "Shipping Promo Discount",
            "order": 58
          },
          {
            "id": "col_1785158858430_fvscu",
            "key": "Shipping Promo Discount Basis",
            "type": "source",
            "label": "Shipping Promo Discount Basis",
            "order": 59
          },
          {
            "id": "col_1785158858430_2ha9b",
            "key": "Shipping Promo Tax",
            "type": "source",
            "label": "Shipping Promo Tax",
            "order": 60
          },
          {
            "id": "col_1785158858430_cd0pq",
            "key": "Gift Wrap Promo Discount",
            "type": "source",
            "label": "Gift Wrap Promo Discount",
            "order": 61
          },
          {
            "id": "col_1785158858430_ezbq1",
            "key": "Gift Wrap Promo Discount Basis",
            "type": "source",
            "label": "Gift Wrap Promo Discount Basis",
            "order": 62
          },
          {
            "id": "col_1785158858430_zmjgl",
            "key": "Gift Wrap Promo Tax",
            "type": "source",
            "label": "Gift Wrap Promo Tax",
            "order": 63
          },
          {
            "id": "col_1785158858430_1gl7i",
            "key": "Tcs Cgst Rate",
            "type": "source",
            "label": "Tcs Cgst Rate",
            "order": 64
          },
          {
            "id": "col_1785158858430_lingh",
            "key": "Tcs Cgst Amount",
            "type": "source",
            "label": "Tcs Cgst Amount",
            "order": 65
          },
          {
            "id": "col_1785158858430_suebz",
            "key": "Tcs Sgst Rate",
            "type": "source",
            "label": "Tcs Sgst Rate",
            "order": 66
          },
          {
            "id": "col_1785158858430_gh5jj",
            "key": "Tcs Sgst Amount",
            "type": "source",
            "label": "Tcs Sgst Amount",
            "order": 67
          },
          {
            "id": "col_1785158858430_thkq2",
            "key": "Tcs Utgst Rate",
            "type": "source",
            "label": "Tcs Utgst Rate",
            "order": 68
          },
          {
            "id": "col_1785158858430_044j4",
            "key": "Tcs Utgst Amount",
            "type": "source",
            "label": "Tcs Utgst Amount",
            "order": 69
          },
          {
            "id": "col_1785158858430_hnebh",
            "key": "Tcs Igst Rate",
            "type": "source",
            "label": "Tcs Igst Rate",
            "order": 70
          },
          {
            "id": "col_1785158858430_044l1",
            "key": "Tcs Igst Amount",
            "type": "source",
            "label": "Tcs Igst Amount",
            "order": 71
          },
          {
            "id": "col_1785158858430_zg2ih",
            "key": "Warehouse Id",
            "type": "source",
            "label": "Warehouse Id",
            "order": 72
          },
          {
            "id": "col_1785158858430_z4dn2",
            "key": "Fulfillment Channel",
            "type": "source",
            "label": "Fulfillment Channel",
            "order": 73
          },
          {
            "id": "col_1785158858430_12lw2",
            "key": "Payment Method Code",
            "type": "source",
            "label": "Payment Method Code",
            "order": 74
          },
          {
            "id": "col_1785158858430_ppa1j",
            "key": "Credit Note No",
            "type": "source",
            "label": "Credit Note No",
            "order": 75
          },
          {
            "id": "col_1785158858430_jpvag",
            "key": "Credit Note Date",
            "type": "source",
            "label": "Credit Note Date",
            "order": 76
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "raw",
        "rawSheetName": null,
        "prevSheetName": null
      }
    ],
    file_inputs: [],
    createdAt: "2026-07-27T13:27:54.485Z",
    updatedAt: "2026-07-27T13:27:54.485Z",
  },
  {
    id: "8a220322-c633-4abd-8d83-5951affa9ac7",
    agentName: "Sales-FirstCry",
    name: "Firstcry M Brands",
    description: "FirstCry vendor reconciliation -> M Brands Tally-ready Sales working file. Maps Invoice Date from the FirstCry portal invoice sheet by FC Ref. no., resolves SKU from Product ID and Stock Name/Cost from SKU via the M Brands FirstCry SKU master, and appends the fixed Tally ledger/GST/address columns.",
    sample_columns: [],
    columns: [],
    sheets: [
      {
        "id": "s1",
        "name": "Invoice Dates",
        "columns": [
          {
            "id": "c1",
            "key": "FC Reference No",
            "type": "source",
            "label": "FC Ref. no.",
            "order": 1
          },
          {
            "id": "c2",
            "key": "Invoice Date",
            "type": "source",
            "label": "Invoice Date",
            "order": 2
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "raw",
        "fileInputId": "file_1",
        "rawSheetName": "VendorInvoice"
      },
      {
        "id": "s2",
        "name": "Merged",
        "type": "merge",
        "fileInputId": "file_0",
        "mergeConfig": {
          "sources": [
            {
              "type": "raw",
              "columns": [],
              "sheetName": "ExportVendorReconciliation"
            },
            {
              "type": "sheet",
              "columns": [
                "Invoice Date"
              ],
              "sheetName": "Invoice Dates"
            }
          ],
          "mergeType": "join",
          "commonJoinKey": "FC Ref. no."
        }
      },
      {
        "id": "s3",
        "name": "SKU Lookup",
        "columns": [
          {
            "id": "c1",
            "key": "SrNo.",
            "type": "source",
            "label": "SrNo.",
            "order": 1
          },
          {
            "id": "c2",
            "key": "FC Ref. no.",
            "type": "source",
            "label": "FC Ref. no.",
            "order": 2
          },
          {
            "id": "c3",
            "key": "Order Ids",
            "type": "source",
            "label": "Order Ids",
            "order": 3
          },
          {
            "id": "c4",
            "key": "Invoice Date",
            "type": "source",
            "label": "Invoice Date",
            "order": 4
          },
          {
            "id": "c5",
            "key": "Order Date",
            "type": "source",
            "label": "Order Date",
            "order": 5
          },
          {
            "id": "c6",
            "key": "Shipping Date",
            "type": "source",
            "label": "Shipping Date",
            "order": 6
          },
          {
            "id": "c7",
            "key": "Delivery date",
            "type": "source",
            "label": "Delivery date",
            "order": 7
          },
          {
            "id": "c8",
            "key": "SR/RTO date",
            "type": "source",
            "label": "SR/RTO date",
            "order": 8
          },
          {
            "id": "c9",
            "key": "Product ID",
            "type": "source",
            "label": "Product ID",
            "order": 9
          },
          {
            "id": "c10",
            "key": "HSN Code",
            "type": "source",
            "label": "HSN Code",
            "order": 10
          },
          {
            "id": "c11",
            "key": "Qty",
            "type": "source",
            "label": "Qty",
            "order": 11
          },
          {
            "id": "c12",
            "key": "MRP",
            "type": "source",
            "label": "MRP",
            "order": 12
          },
          {
            "id": "c13",
            "key": "Base Cost",
            "type": "source",
            "label": "Base Cost",
            "order": 13
          },
          {
            "id": "c14",
            "key": "Gross Amount",
            "type": "source",
            "label": "Gross Amount",
            "order": 14
          },
          {
            "id": "c15",
            "key": "CGST %",
            "type": "source",
            "label": "CGST %",
            "order": 15
          },
          {
            "id": "c16",
            "key": "CGST Amount",
            "type": "source",
            "label": "CGST Amount",
            "order": 16
          },
          {
            "id": "c17",
            "key": "SGST %",
            "type": "source",
            "label": "SGST %",
            "order": 17
          },
          {
            "id": "c18",
            "key": "SGST Amount",
            "type": "source",
            "label": "SGST Amount",
            "order": 18
          },
          {
            "id": "c19",
            "key": "Total",
            "type": "source",
            "label": "Total",
            "order": 19
          },
          {
            "id": "c20",
            "key": "Vendor Invoice no.",
            "type": "source",
            "label": "Vendor Invoice no.",
            "order": 20
          },
          {
            "id": "c21",
            "key": "Payment advice no",
            "type": "source",
            "label": "Payment advice no",
            "order": 21
          },
          {
            "id": "c22",
            "key": "Debit note no.",
            "type": "source",
            "label": "Debit note no.",
            "order": 22
          },
          {
            "id": "c23",
            "key": "WHPOID",
            "type": "source",
            "label": "WHPOID",
            "order": 23
          },
          {
            "id": "c24",
            "key": "Vendor Style Code",
            "type": "source",
            "label": "Vendor Style Code",
            "order": 24
          },
          {
            "id": "c25",
            "key": "AWB No",
            "type": "source",
            "label": "AWB No",
            "order": 25
          },
          {
            "id": "c26",
            "key": "SR Qty",
            "type": "source",
            "label": "SR Qty",
            "order": 26
          },
          {
            "id": "c27",
            "key": "SR Total Amount",
            "type": "source",
            "label": "SR Total Amount",
            "order": 27
          },
          {
            "id": "c28",
            "key": "SR Gross Amount",
            "type": "source",
            "label": "SR Gross Amount",
            "order": 28
          },
          {
            "id": "c29",
            "key": "RTO Qty",
            "type": "source",
            "label": "RTO Qty",
            "order": 29
          },
          {
            "id": "c30",
            "key": "RTO Total Amount",
            "type": "source",
            "label": "RTO Total Amount",
            "order": 30
          },
          {
            "id": "c31",
            "key": "RTO Gross Amount",
            "type": "source",
            "label": "RTO Gross Amount",
            "order": 31
          },
          {
            "id": "c32",
            "type": "master_lookup",
            "label": "SKU",
            "order": 32,
            "masterType": "sku",
            "matchField": "Product ID",
            "returnField": "SKU",
            "lookupColumn": "Product ID"
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "prev_sheet",
        "prevSheetName": "Merged"
      },
      {
        "id": "s4",
        "name": "Sales",
        "columns": [
          {
            "id": "c1",
            "key": "SrNo.",
            "type": "source",
            "label": "SrNo.",
            "order": 1
          },
          {
            "id": "c2",
            "key": "FC Ref. no.",
            "type": "source",
            "label": "FC Ref. no.",
            "order": 2
          },
          {
            "id": "c3",
            "key": "Order Ids",
            "type": "source",
            "label": "Order Ids",
            "order": 3
          },
          {
            "id": "c4",
            "key": "Invoice Date",
            "type": "source",
            "label": "Invoice Date",
            "order": 4
          },
          {
            "id": "c5",
            "key": "Order Date",
            "type": "source",
            "label": "Order Date",
            "order": 5
          },
          {
            "id": "c6",
            "key": "Shipping Date",
            "type": "source",
            "label": "Shipping Date",
            "order": 6
          },
          {
            "id": "c7",
            "key": "Delivery date",
            "type": "source",
            "label": "Delivery date",
            "order": 7
          },
          {
            "id": "c8",
            "key": "SR/RTO date",
            "type": "source",
            "label": "SR/RTO date",
            "order": 8
          },
          {
            "id": "c9",
            "key": "Product ID",
            "type": "source",
            "label": "Product ID",
            "order": 9
          },
          {
            "id": "c10",
            "key": "HSN Code",
            "type": "source",
            "label": "HSN Code",
            "order": 10
          },
          {
            "id": "c11",
            "key": "Qty",
            "type": "source",
            "label": "Qty",
            "order": 11
          },
          {
            "id": "c12",
            "key": "MRP",
            "type": "source",
            "label": "MRP",
            "order": 12
          },
          {
            "id": "c13",
            "key": "Base Cost",
            "type": "source",
            "label": "Base Cost",
            "order": 13
          },
          {
            "id": "c14",
            "key": "Gross Amount",
            "type": "source",
            "label": "Gross Amount",
            "order": 14
          },
          {
            "id": "c15",
            "key": "CGST %",
            "type": "source",
            "label": "CGST %",
            "order": 15
          },
          {
            "id": "c16",
            "key": "CGST Amount",
            "type": "source",
            "label": "CGST Amount",
            "order": 16
          },
          {
            "id": "c17",
            "key": "SGST %",
            "type": "source",
            "label": "SGST %",
            "order": 17
          },
          {
            "id": "c18",
            "key": "SGST Amount",
            "type": "source",
            "label": "SGST Amount",
            "order": 18
          },
          {
            "id": "c19",
            "key": "Total",
            "type": "source",
            "label": "Total",
            "order": 19
          },
          {
            "id": "c20",
            "key": "Vendor Invoice no.",
            "type": "source",
            "label": "Vendor Invoice no.",
            "order": 20
          },
          {
            "id": "c21",
            "key": "Payment advice no",
            "type": "source",
            "label": "Payment advice no",
            "order": 21
          },
          {
            "id": "c22",
            "key": "Debit note no.",
            "type": "source",
            "label": "Debit note no.",
            "order": 22
          },
          {
            "id": "c23",
            "key": "WHPOID",
            "type": "source",
            "label": "WHPOID",
            "order": 23
          },
          {
            "id": "c24",
            "key": "Vendor Style Code",
            "type": "source",
            "label": "Vendor Style Code",
            "order": 24
          },
          {
            "id": "c25",
            "key": "AWB No",
            "type": "source",
            "label": "AWB No",
            "order": 25
          },
          {
            "id": "c26",
            "key": "SR Qty",
            "type": "source",
            "label": "SR Qty",
            "order": 26
          },
          {
            "id": "c27",
            "key": "SR Total Amount",
            "type": "source",
            "label": "SR Total Amount",
            "order": 27
          },
          {
            "id": "c28",
            "key": "SR Gross Amount",
            "type": "source",
            "label": "SR Gross Amount",
            "order": 28
          },
          {
            "id": "c29",
            "key": "RTO Qty",
            "type": "source",
            "label": "RTO Qty",
            "order": 29
          },
          {
            "id": "c30",
            "key": "RTO Total Amount",
            "type": "source",
            "label": "RTO Total Amount",
            "order": 30
          },
          {
            "id": "c31",
            "key": "RTO Gross Amount",
            "type": "source",
            "label": "RTO Gross Amount",
            "order": 31
          },
          {
            "id": "c32",
            "key": "SKU",
            "type": "source",
            "label": "SKU",
            "order": 32
          },
          {
            "id": "c33",
            "type": "computed",
            "label": "Voucher Type",
            "order": 33,
            "formula": "\"Sales\""
          },
          {
            "id": "c34",
            "type": "computed",
            "label": "GSTN",
            "order": 34,
            "formula": "\"27AADCD8136E1ZR\""
          },
          {
            "id": "c35",
            "type": "computed",
            "label": "Party Ledger",
            "order": 35,
            "formula": "\"Digital Age Retail Pvt. Ltd.\""
          },
          {
            "id": "c36",
            "type": "computed",
            "label": "Sales Ledger",
            "order": 36,
            "formula": "\"Firstcry Sales-B2B @\"+({CGST %}+{SGST %})+\"%\""
          },
          {
            "id": "c37",
            "type": "master_lookup",
            "label": "Stock Name as per tally",
            "order": 37,
            "masterType": "sku",
            "matchField": "SKU",
            "returnField": "Stock Name",
            "lookupColumn": "SKU"
          },
          {
            "id": "c38",
            "type": "computed",
            "label": "Output CGST Ledger",
            "order": 38,
            "formula": "{CGST Amount}"
          },
          {
            "id": "c39",
            "type": "computed",
            "label": "Output SGST Ledger",
            "order": 39,
            "formula": "{SGST Amount}"
          },
          {
            "id": "c40",
            "type": "master_lookup",
            "label": "COST",
            "order": 40,
            "masterType": "sku",
            "matchField": "SKU",
            "returnField": "Cost",
            "lookupColumn": "SKU"
          },
          {
            "id": "c41",
            "type": "computed",
            "label": "Cost*Qty",
            "order": 41,
            "formula": "{COST}*{Qty}"
          },
          {
            "id": "c42",
            "type": "computed",
            "label": "MRP*qty",
            "order": 42,
            "formula": "{MRP}*{Qty}"
          },
          {
            "id": "c43",
            "type": "computed",
            "label": "State",
            "order": 43,
            "formula": "\"Maharastra\""
          },
          {
            "id": "c44",
            "type": "computed",
            "label": "Party Address1",
            "order": 44,
            "formula": "\"GATNUMBER 51/1,51/2,51/3,52,53,54,56,57,58,59,\""
          },
          {
            "id": "c45",
            "type": "computed",
            "label": "Party Address2",
            "order": 45,
            "formula": "\"VILLAGE BHAMBOLI, TALUKA KHED,Pune, Maharashtra, 410507\""
          },
          {
            "id": "c46",
            "type": "computed",
            "label": "PIN Code",
            "order": 46,
            "formula": "410507"
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "prev_sheet",
        "prevSheetName": "SKU Lookup"
      }
    ],
    file_inputs: [
      {
        "id": "file_0",
        "label": "FirstCry Reconciliation Sheet (ExportVendorReconciliation)"
      },
      {
        "id": "file_1",
        "label": "FirstCry Invoice Date Sheet (VendorInvoice)"
      }
    ],
    createdAt: "2026-07-29T11:36:28.967Z",
    updatedAt: "2026-07-29T11:41:07.663Z",
  },
  {
    id: "61608940-dad5-4be0-a697-5f77c35eff66",
    agentName: "Sales-Shopify",
    name: "shopify-koparo",
    description: "Koparo Shopify sales -> Tally-ready GST working (MIS + Return, SKU/state master mapping, GST bucketing, pivot by Tally ledger/invoice/FG). Built from client SOP (test input files/koparo shopify/Shopify SOP Final.docx).",
    sample_columns: [
      "Name",
      "Subtotal",
      "Shipping",
      "Total",
      "Lineitem quantity",
      "Lineitem name",
      "Lineitem price",
      "Lineitem compare at price",
      "GMV",
      "Lineitem sku",
      "SKU CLASSIFIER",
      "UNIT CLASSIFIER",
      "FINAL QTY",
      "Cancelled at",
      "Tags",
      "Source",
      "Shipping Province Name",
      "Price Excl. Tax",
      "Selling  Price"
    ],
    columns: [],
    sheets: [
      {
        "id": "sheet_MIS_working",
        "name": "MIS working",
        "order": 0,
        "columns": [
          {
            "id": "c_name",
            "key": "Name",
            "type": "source",
            "label": "Name",
            "order": 0
          },
          {
            "id": "c_ship",
            "key": "Shipping",
            "type": "source",
            "label": "Shipping",
            "order": 1
          },
          {
            "id": "c_liname",
            "key": "Lineitem name",
            "type": "source",
            "label": "Lineitem name",
            "order": 2
          },
          {
            "id": "c_sku",
            "key": "Lineitem sku",
            "type": "source",
            "label": "Lineitem sku",
            "order": 3
          },
          {
            "id": "c_skucls",
            "key": "SKU CLASSIFIER",
            "type": "source",
            "label": "SKU CLASSIFIER",
            "order": 4
          },
          {
            "id": "c_unitcls",
            "key": "UNIT CLASSIFIER",
            "type": "source",
            "label": "UNIT CLASSIFIER",
            "order": 5
          },
          {
            "id": "c_finqty_raw",
            "key": "FINAL QTY",
            "type": "source",
            "label": "Raw Final Qty",
            "order": 5.5
          },
          {
            "id": "c_shipprov",
            "key": "Shipping Province Name",
            "type": "source",
            "label": "Shipping Province Name",
            "order": 7
          },
          {
            "id": "c_priceexcl",
            "key": "Price Excl. Tax",
            "type": "source",
            "label": "Price Excl. Tax",
            "order": 8
          },
          {
            "id": "c_sellprice_raw",
            "key": "Selling  Price",
            "type": "source",
            "label": "Raw Selling Price",
            "order": 8.5
          },
          {
            "id": "c_finqty",
            "type": "computed",
            "label": "FINAL QTY",
            "order": 6,
            "formula": "1 * {Raw Final Qty}"
          },
          {
            "id": "c_sellprice",
            "type": "computed",
            "label": "Selling Price",
            "order": 9,
            "formula": "1 * {Raw Selling Price}"
          },
          {
            "id": "c_totfinqty",
            "type": "excel",
            "label": "Total Final Qty",
            "order": 10,
            "formula": "SUMIF(\"Name\",{Name},\"FINAL QTY\")"
          },
          {
            "id": "c_peritem",
            "type": "excel",
            "label": "Per-Item Shipping Cost",
            "order": 11,
            "formula": "VLOOKUP({Name},\"Name\",\"Shipping\") / {Total Final Qty}"
          },
          {
            "id": "c_shipalloc",
            "type": "computed",
            "label": "Shipping Allocation",
            "order": 12,
            "formula": "{Per-Item Shipping Cost} * {FINAL QTY}"
          },
          {
            "id": "c_spesc",
            "type": "computed",
            "label": "Selling Price Excluding Shipping Cost",
            "order": 13,
            "formula": "{Selling Price} - {Shipping Allocation}"
          },
          {
            "id": "c_vch",
            "type": "computed",
            "label": "Voucher Type",
            "order": 14,
            "formula": "'Sales'"
          },
          {
            "id": "c_skukey",
            "type": "computed",
            "label": "SKU Match Key",
            "order": 15,
            "formula": "/^\\d+$/.test(String({Lineitem sku})) ? {SKU CLASSIFIER} : {Lineitem sku}"
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "raw",
        "fileInputId": "file_0",
        "rawSheetName": "MIS"
      },
      {
        "id": "sheet_Return_working",
        "name": "Return working",
        "order": 1,
        "columns": [
          {
            "id": "c_name",
            "key": "Name",
            "type": "source",
            "label": "Name",
            "order": 0
          },
          {
            "id": "c_ship",
            "key": "Shipping",
            "type": "source",
            "label": "Shipping",
            "order": 1
          },
          {
            "id": "c_liname",
            "key": "Lineitem name",
            "type": "source",
            "label": "Lineitem name",
            "order": 2
          },
          {
            "id": "c_sku",
            "key": "Lineitem sku",
            "type": "source",
            "label": "Lineitem sku",
            "order": 3
          },
          {
            "id": "c_skucls",
            "key": "SKU CLASSIFIER",
            "type": "source",
            "label": "SKU CLASSIFIER",
            "order": 4
          },
          {
            "id": "c_unitcls",
            "key": "UNIT CLASSIFIER",
            "type": "source",
            "label": "UNIT CLASSIFIER",
            "order": 5
          },
          {
            "id": "c_finqty_raw",
            "key": "FINAL QTY",
            "type": "source",
            "label": "Raw Final Qty",
            "order": 5.5
          },
          {
            "id": "c_shipprov",
            "key": "Shipping Province Name",
            "type": "source",
            "label": "Shipping Province Name",
            "order": 7
          },
          {
            "id": "c_priceexcl",
            "key": "Price Excl. Tax",
            "type": "source",
            "label": "Price Excl. Tax",
            "order": 8
          },
          {
            "id": "c_sellprice_raw",
            "key": "Selling  Price",
            "type": "source",
            "label": "Raw Selling Price",
            "order": 8.5
          },
          {
            "id": "c_finqty",
            "type": "computed",
            "label": "FINAL QTY",
            "order": 6,
            "formula": "-1 * {Raw Final Qty}"
          },
          {
            "id": "c_sellprice",
            "type": "computed",
            "label": "Selling Price",
            "order": 9,
            "formula": "-1 * {Raw Selling Price}"
          },
          {
            "id": "c_totfinqty",
            "type": "excel",
            "label": "Total Final Qty",
            "order": 10,
            "formula": "SUMIF(\"Name\",{Name},\"FINAL QTY\")"
          },
          {
            "id": "c_peritem",
            "type": "excel",
            "label": "Per-Item Shipping Cost",
            "order": 11,
            "formula": "VLOOKUP({Name},\"Name\",\"Shipping\") / {Total Final Qty}"
          },
          {
            "id": "c_shipalloc",
            "type": "computed",
            "label": "Shipping Allocation",
            "order": 12,
            "formula": "{Per-Item Shipping Cost} * {FINAL QTY}"
          },
          {
            "id": "c_spesc",
            "type": "computed",
            "label": "Selling Price Excluding Shipping Cost",
            "order": 13,
            "formula": "{Selling Price} - {Shipping Allocation}"
          },
          {
            "id": "c_vch",
            "type": "computed",
            "label": "Voucher Type",
            "order": 14,
            "formula": "'Return'"
          },
          {
            "id": "c_skukey",
            "type": "computed",
            "label": "SKU Match Key",
            "order": 15,
            "formula": "/^\\d+$/.test(String({Lineitem sku})) ? {SKU CLASSIFIER} : {Lineitem sku}"
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "raw",
        "fileInputId": "file_0",
        "rawSheetName": "Return"
      },
      {
        "id": "sheet_Combined",
        "name": "Combined",
        "type": "merge",
        "order": 2,
        "mergeConfig": {
          "sources": [
            {
              "type": "sheet",
              "columns": [
                "Name",
                "Lineitem name",
                "Lineitem sku",
                "SKU CLASSIFIER",
                "UNIT CLASSIFIER",
                "FINAL QTY",
                "Shipping Province Name",
                "Price Excl. Tax",
                "Selling Price",
                "Total Final Qty",
                "Per-Item Shipping Cost",
                "Shipping Allocation",
                "Selling Price Excluding Shipping Cost",
                "Voucher Type",
                "SKU Match Key"
              ],
              "sheetName": "MIS working"
            },
            {
              "type": "sheet",
              "columns": [
                "Name",
                "Lineitem name",
                "Lineitem sku",
                "SKU CLASSIFIER",
                "UNIT CLASSIFIER",
                "FINAL QTY",
                "Shipping Province Name",
                "Price Excl. Tax",
                "Selling Price",
                "Total Final Qty",
                "Per-Item Shipping Cost",
                "Shipping Allocation",
                "Selling Price Excluding Shipping Cost",
                "Voucher Type",
                "SKU Match Key"
              ],
              "sheetName": "Return working"
            }
          ],
          "mergeType": "stack"
        }
      },
      {
        "id": "sheet_FillMap",
        "name": "Fill & Map",
        "order": 3,
        "columns": [
          {
            "id": "fm_src_0",
            "key": "Name",
            "type": "source",
            "label": "Name",
            "order": 0
          },
          {
            "id": "fm_src_1",
            "key": "Lineitem name",
            "type": "source",
            "label": "Lineitem name",
            "order": 1
          },
          {
            "id": "fm_src_2",
            "key": "Lineitem sku",
            "type": "source",
            "label": "Lineitem sku",
            "order": 2
          },
          {
            "id": "fm_src_3",
            "key": "SKU CLASSIFIER",
            "type": "source",
            "label": "SKU CLASSIFIER",
            "order": 3
          },
          {
            "id": "fm_src_4",
            "key": "UNIT CLASSIFIER",
            "type": "source",
            "label": "UNIT CLASSIFIER",
            "order": 4
          },
          {
            "id": "fm_src_5",
            "key": "FINAL QTY",
            "type": "source",
            "label": "FINAL QTY",
            "order": 5
          },
          {
            "id": "fm_src_6",
            "key": "Shipping Province Name",
            "type": "source",
            "label": "Shipping Province Name",
            "order": 6
          },
          {
            "id": "fm_src_7",
            "key": "Price Excl. Tax",
            "type": "source",
            "label": "Price Excl. Tax",
            "order": 7
          },
          {
            "id": "fm_src_8",
            "key": "Selling Price",
            "type": "source",
            "label": "Selling Price",
            "order": 8
          },
          {
            "id": "fm_src_9",
            "key": "Total Final Qty",
            "type": "source",
            "label": "Total Final Qty",
            "order": 9
          },
          {
            "id": "fm_src_10",
            "key": "Per-Item Shipping Cost",
            "type": "source",
            "label": "Per-Item Shipping Cost",
            "order": 10
          },
          {
            "id": "fm_src_11",
            "key": "Shipping Allocation",
            "type": "source",
            "label": "Shipping Allocation",
            "order": 11
          },
          {
            "id": "fm_src_12",
            "key": "Selling Price Excluding Shipping Cost",
            "type": "source",
            "label": "Selling Price Excluding Shipping Cost",
            "order": 12
          },
          {
            "id": "fm_src_13",
            "key": "Voucher Type",
            "type": "source",
            "label": "Voucher Type",
            "order": 13
          },
          {
            "id": "fm_src_14",
            "key": "SKU Match Key",
            "type": "source",
            "label": "SKU Match Key",
            "order": 14
          },
          {
            "id": "fm_fill_state",
            "type": "excel",
            "label": "Shipping Province Name",
            "order": 100,
            "formula": "{Shipping Province Name} !== 0 ? {Shipping Province Name} : VLOOKUP({Name},\"Name\",\"Shipping Province Name\")"
          },
          {
            "id": "fm_fg",
            "type": "master_lookup",
            "label": "FG",
            "order": 101,
            "masterType": "sku",
            "matchField": "Sales portal SKU",
            "returnField": "Tally new SKU",
            "lookupColumn": "SKU Match Key"
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "prev_sheet",
        "prevSheetName": "Combined"
      },
      {
        "id": "sheet_GstTax",
        "name": "GST & Tax",
        "order": 4,
        "columns": [
          {
            "id": "gt_src_0",
            "key": "Name",
            "type": "source",
            "label": "Name",
            "order": 0
          },
          {
            "id": "gt_src_1",
            "key": "Lineitem name",
            "type": "source",
            "label": "Lineitem name",
            "order": 1
          },
          {
            "id": "gt_src_2",
            "key": "Lineitem sku",
            "type": "source",
            "label": "Lineitem sku",
            "order": 2
          },
          {
            "id": "gt_src_3",
            "key": "SKU CLASSIFIER",
            "type": "source",
            "label": "SKU CLASSIFIER",
            "order": 3
          },
          {
            "id": "gt_src_4",
            "key": "UNIT CLASSIFIER",
            "type": "source",
            "label": "UNIT CLASSIFIER",
            "order": 4
          },
          {
            "id": "gt_src_5",
            "key": "FINAL QTY",
            "type": "source",
            "label": "FINAL QTY",
            "order": 5
          },
          {
            "id": "gt_src_6",
            "key": "Shipping Province Name",
            "type": "source",
            "label": "Shipping Province Name",
            "order": 6
          },
          {
            "id": "gt_src_7",
            "key": "Price Excl. Tax",
            "type": "source",
            "label": "Price Excl. Tax",
            "order": 7
          },
          {
            "id": "gt_src_8",
            "key": "Selling Price",
            "type": "source",
            "label": "Selling Price",
            "order": 8
          },
          {
            "id": "gt_src_9",
            "key": "Total Final Qty",
            "type": "source",
            "label": "Total Final Qty",
            "order": 9
          },
          {
            "id": "gt_src_10",
            "key": "Per-Item Shipping Cost",
            "type": "source",
            "label": "Per-Item Shipping Cost",
            "order": 10
          },
          {
            "id": "gt_src_11",
            "key": "Shipping Allocation",
            "type": "source",
            "label": "Shipping Allocation",
            "order": 11
          },
          {
            "id": "gt_src_12",
            "key": "Selling Price Excluding Shipping Cost",
            "type": "source",
            "label": "Selling Price Excluding Shipping Cost",
            "order": 12
          },
          {
            "id": "gt_src_13",
            "key": "Voucher Type",
            "type": "source",
            "label": "Voucher Type",
            "order": 13
          },
          {
            "id": "gt_src_14",
            "key": "SKU Match Key",
            "type": "source",
            "label": "SKU Match Key",
            "order": 14
          },
          {
            "id": "gt_src_15",
            "key": "FG",
            "type": "source",
            "label": "FG",
            "order": 15
          },
          {
            "id": "gt_tallyname",
            "type": "master_lookup",
            "label": "Tally Name",
            "order": 200,
            "masterType": "ledger",
            "matchField": "States",
            "returnField": "Ledger",
            "lookupColumn": "Shipping Province Name"
          },
          {
            "id": "gt_invno",
            "type": "master_lookup",
            "label": "Invoice Number",
            "order": 201,
            "masterType": "ledger",
            "matchField": "States",
            "returnField": "Invoice No.",
            "lookupColumn": "Shipping Province Name"
          },
          {
            "id": "gt_gstrate",
            "type": "computed",
            "label": "GST Rate",
            "order": 202,
            "formula": "String({FG}).toLowerCase().includes('sponge wipes') ? 0.05 : 0.18"
          },
          {
            "id": "gt_shiptaxable",
            "type": "computed",
            "label": "Shipping Taxable",
            "order": 203,
            "formula": "{Shipping Allocation} / (1 + {GST Rate})"
          },
          {
            "id": "gt_salestaxable",
            "type": "computed",
            "label": "Taxable Sales Value",
            "order": 204,
            "formula": "{Selling Price Excluding Shipping Cost} / (1 + {GST Rate})"
          },
          {
            "id": "gt_shipcgst",
            "type": "computed",
            "label": "Shipping CGST",
            "order": 205,
            "formula": "{Shipping Province Name} === 'Delhi' ? {Shipping Taxable} * {GST Rate} / 2 : 0"
          },
          {
            "id": "gt_shipsgst",
            "type": "computed",
            "label": "Shipping SGST",
            "order": 206,
            "formula": "{Shipping Province Name} === 'Delhi' ? {Shipping Taxable} * {GST Rate} / 2 : 0"
          },
          {
            "id": "gt_shipigst",
            "type": "computed",
            "label": "Shipping IGST",
            "order": 207,
            "formula": "{Shipping Province Name} !== 'Delhi' ? {Shipping Taxable} * {GST Rate} : 0"
          },
          {
            "id": "gt_salescgst",
            "type": "computed",
            "label": "Sales CGST",
            "order": 208,
            "formula": "{Shipping Province Name} === 'Delhi' ? {Taxable Sales Value} * {GST Rate} / 2 : 0"
          },
          {
            "id": "gt_salessgst",
            "type": "computed",
            "label": "Sales SGST",
            "order": 209,
            "formula": "{Shipping Province Name} === 'Delhi' ? {Taxable Sales Value} * {GST Rate} / 2 : 0"
          },
          {
            "id": "gt_salesigst",
            "type": "computed",
            "label": "Sales IGST",
            "order": 210,
            "formula": "{Shipping Province Name} !== 'Delhi' ? {Taxable Sales Value} * {GST Rate} : 0"
          },
          {
            "id": "gt_igst18",
            "type": "computed",
            "label": "IGST 18%",
            "order": 211,
            "formula": "{GST Rate} === 0.18 ? {Sales IGST} : 0"
          },
          {
            "id": "gt_cgst9",
            "type": "computed",
            "label": "CGST 9%",
            "order": 212,
            "formula": "{GST Rate} === 0.18 ? {Sales CGST} : 0"
          },
          {
            "id": "gt_sgst9",
            "type": "computed",
            "label": "SGST 9%",
            "order": 213,
            "formula": "{GST Rate} === 0.18 ? {Sales SGST} : 0"
          },
          {
            "id": "gt_igst5",
            "type": "computed",
            "label": "IGST 5%",
            "order": 214,
            "formula": "{GST Rate} === 0.05 ? {Sales IGST} : 0"
          },
          {
            "id": "gt_cgst25",
            "type": "computed",
            "label": "CGST 2.5%",
            "order": 215,
            "formula": "{GST Rate} === 0.05 ? {Sales CGST} : 0"
          },
          {
            "id": "gt_sgst25",
            "type": "computed",
            "label": "SGST 2.5%",
            "order": 216,
            "formula": "{GST Rate} === 0.05 ? {Sales SGST} : 0"
          },
          {
            "id": "gt_shipigst18",
            "type": "computed",
            "label": "Shipping IGST 18%",
            "order": 217,
            "formula": "{GST Rate} === 0.18 ? {Shipping IGST} : 0"
          },
          {
            "id": "gt_shipcgst9",
            "type": "computed",
            "label": "Shipping CGST 9%",
            "order": 218,
            "formula": "{GST Rate} === 0.18 ? {Shipping CGST} : 0"
          },
          {
            "id": "gt_shipsgst9",
            "type": "computed",
            "label": "Shipping SGST 9%",
            "order": 219,
            "formula": "{GST Rate} === 0.18 ? {Shipping SGST} : 0"
          },
          {
            "id": "gt_shipigst5",
            "type": "computed",
            "label": "Shipping IGST 5%",
            "order": 220,
            "formula": "{GST Rate} === 0.05 ? {Shipping IGST} : 0"
          },
          {
            "id": "gt_shipcgst25",
            "type": "computed",
            "label": "Shipping CGST 2.5%",
            "order": 221,
            "formula": "{GST Rate} === 0.05 ? {Shipping CGST} : 0"
          },
          {
            "id": "gt_shipsgst25",
            "type": "computed",
            "label": "Shipping SGST 2.5%",
            "order": 222,
            "formula": "{GST Rate} === 0.05 ? {Shipping SGST} : 0"
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "prev_sheet",
        "prevSheetName": "Fill & Map"
      },
      {
        "id": "sheet_Pivot",
        "name": "Pivot",
        "order": 5,
        "columns": [
          {
            "id": "pv_src_0",
            "key": "Tally Name",
            "type": "source",
            "label": "Tally Name",
            "order": 0
          },
          {
            "id": "pv_src_1",
            "key": "Invoice Number",
            "type": "source",
            "label": "Invoice Number",
            "order": 1
          },
          {
            "id": "pv_src_2",
            "key": "FG",
            "type": "source",
            "label": "FG",
            "order": 2
          },
          {
            "id": "pv_src_3",
            "key": "FINAL QTY",
            "type": "source",
            "label": "FINAL QTY",
            "order": 3
          },
          {
            "id": "pv_src_4",
            "key": "Taxable Sales Value",
            "type": "source",
            "label": "Taxable Sales Value",
            "order": 4
          },
          {
            "id": "pv_src_5",
            "key": "IGST 18%",
            "type": "source",
            "label": "IGST 18%",
            "order": 5
          },
          {
            "id": "pv_src_6",
            "key": "CGST 9%",
            "type": "source",
            "label": "CGST 9%",
            "order": 6
          },
          {
            "id": "pv_src_7",
            "key": "SGST 9%",
            "type": "source",
            "label": "SGST 9%",
            "order": 7
          },
          {
            "id": "pv_src_8",
            "key": "IGST 5%",
            "type": "source",
            "label": "IGST 5%",
            "order": 8
          },
          {
            "id": "pv_src_9",
            "key": "CGST 2.5%",
            "type": "source",
            "label": "CGST 2.5%",
            "order": 9
          },
          {
            "id": "pv_src_10",
            "key": "SGST 2.5%",
            "type": "source",
            "label": "SGST 2.5%",
            "order": 10
          },
          {
            "id": "pv_src_11",
            "key": "Shipping Taxable",
            "type": "source",
            "label": "Shipping Taxable",
            "order": 11
          },
          {
            "id": "pv_src_12",
            "key": "Shipping IGST 18%",
            "type": "source",
            "label": "Shipping IGST 18%",
            "order": 12
          },
          {
            "id": "pv_src_13",
            "key": "Shipping CGST 9%",
            "type": "source",
            "label": "Shipping CGST 9%",
            "order": 13
          },
          {
            "id": "pv_src_14",
            "key": "Shipping SGST 9%",
            "type": "source",
            "label": "Shipping SGST 9%",
            "order": 14
          },
          {
            "id": "pv_src_15",
            "key": "Shipping IGST 5%",
            "type": "source",
            "label": "Shipping IGST 5%",
            "order": 15
          },
          {
            "id": "pv_src_16",
            "key": "Shipping CGST 2.5%",
            "type": "source",
            "label": "Shipping CGST 2.5%",
            "order": 16
          },
          {
            "id": "pv_src_17",
            "key": "Shipping SGST 2.5%",
            "type": "source",
            "label": "Shipping SGST 2.5%",
            "order": 17
          },
          {
            "id": "pv_src_18",
            "key": "GST Rate",
            "type": "source",
            "label": "GST Rate",
            "order": 18
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [
            "Tally Name",
            "Invoice Number",
            "FG",
            "GST Rate"
          ],
          "enabled": true,
          "aggregations": {
            "CGST 9%": "sum",
            "IGST 5%": "sum",
            "SGST 9%": "sum",
            "IGST 18%": "sum",
            "CGST 2.5%": "sum",
            "FINAL QTY": "sum",
            "SGST 2.5%": "sum",
            "Shipping CGST 9%": "sum",
            "Shipping IGST 5%": "sum",
            "Shipping SGST 9%": "sum",
            "Shipping Taxable": "sum",
            "Shipping IGST 18%": "sum",
            "Shipping CGST 2.5%": "sum",
            "Shipping SGST 2.5%": "sum",
            "Taxable Sales Value": "sum"
          }
        },
        "sourceType": "prev_sheet",
        "prevSheetName": "GST & Tax"
      },
      {
        "id": "sheet_Final",
        "name": "Pivot + Rate",
        "order": 6,
        "columns": [
          {
            "id": "fn_src_0",
            "key": "Tally Name",
            "type": "source",
            "label": "Tally Name",
            "order": 0
          },
          {
            "id": "fn_src_1",
            "key": "Invoice Number",
            "type": "source",
            "label": "Invoice Number",
            "order": 1
          },
          {
            "id": "fn_src_2",
            "key": "FG",
            "type": "source",
            "label": "FG",
            "order": 2
          },
          {
            "id": "fn_src_3",
            "key": "GST Rate",
            "type": "source",
            "label": "GST Rate",
            "order": 3
          },
          {
            "id": "fn_src_4",
            "key": "FINAL QTY",
            "type": "source",
            "label": "FINAL QTY",
            "order": 4
          },
          {
            "id": "fn_src_5",
            "key": "Taxable Sales Value",
            "type": "source",
            "label": "Taxable Sales Value",
            "order": 5
          },
          {
            "id": "fn_src_6",
            "key": "IGST 18%",
            "type": "source",
            "label": "IGST 18%",
            "order": 6
          },
          {
            "id": "fn_src_7",
            "key": "CGST 9%",
            "type": "source",
            "label": "CGST 9%",
            "order": 7
          },
          {
            "id": "fn_src_8",
            "key": "SGST 9%",
            "type": "source",
            "label": "SGST 9%",
            "order": 8
          },
          {
            "id": "fn_src_9",
            "key": "IGST 5%",
            "type": "source",
            "label": "IGST 5%",
            "order": 9
          },
          {
            "id": "fn_src_10",
            "key": "CGST 2.5%",
            "type": "source",
            "label": "CGST 2.5%",
            "order": 10
          },
          {
            "id": "fn_src_11",
            "key": "SGST 2.5%",
            "type": "source",
            "label": "SGST 2.5%",
            "order": 11
          },
          {
            "id": "fn_src_12",
            "key": "Shipping Taxable",
            "type": "source",
            "label": "Shipping Taxable",
            "order": 12
          },
          {
            "id": "fn_src_13",
            "key": "Shipping IGST 18%",
            "type": "source",
            "label": "Shipping IGST 18%",
            "order": 13
          },
          {
            "id": "fn_src_14",
            "key": "Shipping CGST 9%",
            "type": "source",
            "label": "Shipping CGST 9%",
            "order": 14
          },
          {
            "id": "fn_src_15",
            "key": "Shipping SGST 9%",
            "type": "source",
            "label": "Shipping SGST 9%",
            "order": 15
          },
          {
            "id": "fn_src_16",
            "key": "Shipping IGST 5%",
            "type": "source",
            "label": "Shipping IGST 5%",
            "order": 16
          },
          {
            "id": "fn_src_17",
            "key": "Shipping CGST 2.5%",
            "type": "source",
            "label": "Shipping CGST 2.5%",
            "order": 17
          },
          {
            "id": "fn_src_18",
            "key": "Shipping SGST 2.5%",
            "type": "source",
            "label": "Shipping SGST 2.5%",
            "order": 18
          },
          {
            "id": "fn_itemrate",
            "type": "computed",
            "label": "Item Rate",
            "order": 100,
            "formula": "{FINAL QTY} !== 0 ? {Taxable Sales Value} / {FINAL QTY} : 0"
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "prev_sheet",
        "prevSheetName": "Pivot"
      }
    ],
    file_inputs: [
      {
        "id": "file_0",
        "label": "Shopify Sales Report (MIS + Return sheets)"
      }
    ],
    createdAt: "2026-08-14T11:09:16.934Z",
    updatedAt: "2026-08-14T11:09:16.934Z",
  },
  {
    id: "dd36cbf8-9995-4b1a-b8ba-4a54d9915181",
    agentName: "Sales-cread",
    name: "koparo-cread",
    description: "Cred (CRED app) sales report -> Tally-ready working file for Koparo. Built from Cred Sales SOP (1).docx: SKU + buyer-state (ledger) master mapping, GST split (Delhi seller state: CGST+SGST for Delhi buyers, IGST otherwise), pivoted by Invoice No. / Party Name / Tally SKU. Sample reference: Cred Sales Report Jul25.xlsx / Cred Sales Report Working Jul25.xlsx. Known deviations from the hardcoded Sales-cread agent: no GST-rate slab-snapping (uses the raw Tax column directly), Invoice No. has no month suffix (no runtime month parameter in this builder), no X2Beta export sheet, and the raw sheet name 'Final-Jul25' is hardcoded so a new sheet name each month will need re-pointing in the builder.",
    sample_columns: [],
    columns: [],
    sheets: [
      {
        "id": "sheet_main",
        "name": "Main",
        "order": 0,
        "columns": [
          {
            "id": "c1",
            "key": "Reference Code",
            "type": "source",
            "label": "Reference Code",
            "order": 0
          },
          {
            "id": "c2",
            "key": "EE Invoice No",
            "type": "source",
            "label": "EE Invoice No",
            "order": 1
          },
          {
            "id": "c3",
            "key": "Order Status",
            "type": "source",
            "label": "Order Status",
            "order": 2
          },
          {
            "id": "c4",
            "key": "Shipping Status",
            "type": "source",
            "label": "Shipping Status",
            "order": 3
          },
          {
            "id": "c5",
            "key": "Order Date",
            "type": "source",
            "label": "Order Date",
            "order": 4
          },
          {
            "id": "c6",
            "key": "AWB No",
            "type": "source",
            "label": "AWB No",
            "order": 5
          },
          {
            "id": "c7",
            "key": "Suborder Quantity",
            "type": "source",
            "label": "Suborder Quantity",
            "order": 6
          },
          {
            "id": "c8",
            "key": "Item Quantity",
            "type": "source",
            "label": "Item Quantity",
            "order": 7
          },
          {
            "id": "c9",
            "key": "SKU",
            "type": "source",
            "label": "SKU",
            "order": 8
          },
          {
            "id": "c10",
            "key": "MIS SKU",
            "type": "source",
            "label": "MIS SKU",
            "order": 9
          },
          {
            "id": "c11",
            "key": "Shipping Zip Code",
            "type": "source",
            "label": "Shipping Zip Code",
            "order": 10
          },
          {
            "id": "c12",
            "key": "Shipping State",
            "type": "source",
            "label": "Shipping State",
            "order": 11
          },
          {
            "id": "c13",
            "key": "Order Invoice Amount",
            "type": "source",
            "label": "Order Invoice Amount",
            "order": 12
          },
          {
            "id": "c14",
            "key": "Tax",
            "type": "source",
            "label": "Tax",
            "order": 13
          },
          {
            "id": "c15",
            "key": "Item Price Excluding Tax",
            "type": "source",
            "label": "Item Price Excluding Tax",
            "order": 14
          },
          {
            "id": "c16",
            "key": "Cred Status",
            "type": "source",
            "label": "Cred Status",
            "order": 15
          },
          {
            "id": "c17",
            "key": "Final Status",
            "type": "source",
            "label": "Final Status",
            "order": 16
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "raw",
        "fileInputId": "file_0",
        "rawSheetName": "Final-Jul25",
        "prevSheetName": null
      },
      {
        "id": "sheet_working",
        "name": "Working",
        "order": 1,
        "columns": [
          {
            "id": "w1",
            "key": "Reference Code",
            "type": "source",
            "label": "Reference Code",
            "order": 0
          },
          {
            "id": "w2",
            "key": "EE Invoice No",
            "type": "source",
            "label": "EE Invoice No",
            "order": 1
          },
          {
            "id": "w3",
            "key": "Order Status",
            "type": "source",
            "label": "Order Status",
            "order": 2
          },
          {
            "id": "w4",
            "key": "Shipping Status",
            "type": "source",
            "label": "Shipping Status",
            "order": 3
          },
          {
            "id": "w5",
            "key": "Order Date",
            "type": "source",
            "label": "Order Date",
            "order": 4
          },
          {
            "id": "w6",
            "key": "AWB No",
            "type": "source",
            "label": "AWB No",
            "order": 5
          },
          {
            "id": "w7",
            "key": "Suborder Quantity",
            "type": "source",
            "label": "Suborder Quantity",
            "order": 6
          },
          {
            "id": "w8",
            "key": "Item Quantity",
            "type": "source",
            "label": "Item Quantity",
            "order": 7
          },
          {
            "id": "w9",
            "key": "SKU",
            "type": "source",
            "label": "SKU",
            "order": 8
          },
          {
            "id": "w10",
            "type": "master_lookup",
            "label": "Final SKU",
            "order": 9,
            "masterType": "sku",
            "matchField": "Sales Portal SKU",
            "returnField": "Tally new SKU",
            "lookupColumn": "SKU"
          },
          {
            "id": "w11",
            "key": "MIS SKU",
            "type": "source",
            "label": "MIS SKU",
            "order": 10
          },
          {
            "id": "w12",
            "key": "Shipping Zip Code",
            "type": "source",
            "label": "Shipping Zip Code",
            "order": 11
          },
          {
            "id": "w13",
            "key": "Shipping State",
            "type": "source",
            "label": "Shipping States",
            "order": 12
          },
          {
            "id": "w14",
            "type": "master_lookup",
            "label": "Party Name",
            "order": 13,
            "masterType": "ledger",
            "matchField": "States",
            "returnField": "Ledger",
            "lookupColumn": "Shipping State"
          },
          {
            "id": "w15",
            "type": "master_lookup",
            "label": "Invoice No.",
            "order": 14,
            "masterType": "ledger",
            "matchField": "States",
            "returnField": "Invoice No.",
            "lookupColumn": "Shipping State"
          },
          {
            "id": "w16",
            "key": "Order Invoice Amount",
            "type": "source",
            "label": "Order Invoice Amount",
            "order": 15
          },
          {
            "id": "w17",
            "key": "Tax",
            "type": "source",
            "label": "Tax",
            "order": 16
          },
          {
            "id": "w18",
            "key": "Item Price Excluding Tax",
            "type": "source",
            "label": "Item Price Excluding Tax",
            "order": 17
          },
          {
            "id": "w19",
            "key": "Cred Status",
            "type": "source",
            "label": "Cred Status",
            "order": 18
          },
          {
            "id": "w20",
            "type": "computed",
            "label": "Taxable Amount",
            "order": 19,
            "formula": "{Item Price Excluding Tax}"
          },
          {
            "id": "w21",
            "type": "computed",
            "label": "CGST",
            "order": 20,
            "formula": "IF({Shipping States} == \"Delhi\", {Tax} / 2, 0)"
          },
          {
            "id": "w22",
            "type": "computed",
            "label": "SGST",
            "order": 21,
            "formula": "IF({Shipping States} == \"Delhi\", {Tax} / 2, 0)"
          },
          {
            "id": "w23",
            "type": "computed",
            "label": "IGST",
            "order": 22,
            "formula": "IF({Shipping States} == \"Delhi\", 0, {Tax})"
          },
          {
            "id": "w24",
            "key": "Final Status",
            "type": "source",
            "label": "Final Status",
            "order": 23
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [],
          "enabled": false,
          "aggregations": {}
        },
        "sourceType": "prev_sheet",
        "fileInputId": null,
        "rawSheetName": null,
        "prevSheetName": "Main"
      },
      {
        "id": "sheet_pivot",
        "name": "Pivot",
        "order": 2,
        "columns": [
          {
            "id": "p1",
            "key": "Invoice No.",
            "type": "source",
            "label": "Invoice No.",
            "order": 0
          },
          {
            "id": "p2",
            "key": "Party Name",
            "type": "source",
            "label": "Party Name",
            "order": 1
          },
          {
            "id": "p3",
            "key": "Final SKU",
            "type": "source",
            "label": "Tally Sku",
            "order": 2
          },
          {
            "id": "p4",
            "key": "Suborder Quantity",
            "type": "source",
            "label": "Sum of Suborder Quantity",
            "order": 3
          },
          {
            "id": "p5",
            "key": "Taxable Amount",
            "type": "source",
            "label": "Sum of Taxable Amount",
            "order": 4
          },
          {
            "id": "p6",
            "key": "CGST",
            "type": "source",
            "label": "Sum of CGST",
            "order": 5
          },
          {
            "id": "p7",
            "key": "SGST",
            "type": "source",
            "label": "Sum of SGST",
            "order": 6
          },
          {
            "id": "p8",
            "key": "IGST",
            "type": "source",
            "label": "Sum of IGST",
            "order": 7
          }
        ],
        "filters": [],
        "groupBy": {
          "columns": [
            "Invoice No.",
            "Party Name",
            "Tally Sku"
          ],
          "enabled": true,
          "aggregations": {
            "Sum of CGST": "sum",
            "Sum of IGST": "sum",
            "Sum of SGST": "sum",
            "Sum of Taxable Amount": "sum",
            "Sum of Suborder Quantity": "sum"
          }
        },
        "sourceType": "prev_sheet",
        "fileInputId": null,
        "rawSheetName": null,
        "prevSheetName": "Working"
      }
    ],
    file_inputs: [
      {
        "id": "file_0",
        "label": "Cred Sales Report"
      }
    ],
    createdAt: "2026-08-14T11:42:02.683Z",
    updatedAt: "2026-08-14T11:51:04.771Z",
  }
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    let inserted = 0;

    for (const wf of AGENT_WORKFLOWS) {
      const [, rowCount] = await sequelize.query(`
        INSERT INTO agent_workflows
          (id, agent_id, name, description, sample_columns, columns, sheets, file_inputs, "createdAt", "updatedAt")
        SELECT :id, a.id, :name, :description, :sample_columns::jsonb, :columns::jsonb, :sheets::jsonb, :file_inputs::jsonb, :createdAt, :updatedAt
        FROM agents a
        WHERE a.name = :agentName
        ON CONFLICT (id) DO NOTHING
      `, {
        replacements: {
          id: wf.id,
          name: wf.name,
          description: wf.description,
          sample_columns: JSON.stringify(wf.sample_columns),
          columns: JSON.stringify(wf.columns),
          sheets: JSON.stringify(wf.sheets),
          file_inputs: JSON.stringify(wf.file_inputs),
          createdAt: wf.createdAt,
          updatedAt: wf.updatedAt,
          agentName: wf.agentName,
        },
      });

      if (typeof rowCount === 'number' && rowCount > 0) {
        inserted++;
        console.log(`  [SEED] agent_workflows — inserted ${wf.name}`);
      } else {
        console.log(`  [SEED] agent_workflows — skipped ${wf.name} (already present, or agent '${wf.agentName}' not found)`);
      }
    }

    console.log(`  [SEED] agent_workflows — ${inserted}/${AGENT_WORKFLOWS.length} workflow(s) newly inserted`);
  },
};
