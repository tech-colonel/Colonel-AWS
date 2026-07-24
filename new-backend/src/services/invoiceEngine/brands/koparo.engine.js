// ⚠️ AUTO-ASSEMBLED — DO NOT HAND-EDIT.
// Source: "KOPARO INVOICE (6).json" n8n workflow, nodes "AI Agent" (prompt) and
// "Code in JavaScript" (post-processing). Assembled byte-for-byte so the Koparo
// output matches n8n exactly. Regenerate via scratchpad/assemble_koparo_engine.js.
//
// runCodeNode(items): items = [{ json: { output: <LLM raw string>, webViewLink } }]
//   -> returns the array of processed invoice-line rows (n8n "output").
// buildPrompt(invoiceText): the exact AI Agent prompt with the invoice text injected.
/* eslint-disable */

const PROMPT_BEFORE = "You are an expert accounting data extraction assistant.\n\nABSOLUTE OUTPUT ENFORCEMENT (HIGHEST PRIORITY)\n\nYou are a STRICT JSON generator.\n\nYou are NOT an assistant.\nYou are NOT allowed to think, explain, or describe.\n\n⸻\n\nYOU MUST FOLLOW THIS:\n1. Your response MUST start with “[” and end with “]”\n2. Your response MUST be valid JSON\n3. Your response MUST contain ONLY JSON\n4. NO text before JSON\n5. NO text after JSON\n6. NO explanation under any condition\n7. You MUST call the Vendor_Master tool for EVERY invoice.\n\nSTRICTLY FORBIDDEN:\n• “I noticed”\n• “This appears”\n• “I cannot”\n• “It seems”\n• “The provided text”\n• ANY explanation or reasoning\n\n⸻\n\nThe input is OCR text extracted from invoice PDFs.\n\nThe invoice may belong to any company or marketplace, including:\n\nAmazon\nFlipkart\nBlinkit\nSwiggy\nZomato\nShopify\nLogistics companies\nAdvertising platforms\nSoftware subscriptions\nTraditional vendors\nAny supplier invoice\n\nThe OCR text may contain:\n• Noise\n• Repeated values\n• Multiple totals\n• Formatting issues\n• OCR mistakes\n\nYou must carefully extract correct accounting data.\n\nMANDATORY BEHAVIOR:\n\nEven if:\n• input is garbage\n• input is email\n• input is proforma\n• input is unstructured\n• input is unclear\n\nYOU MUST STILL RETURN JSON.\n\n⸻\n\n🚨 CRITICAL TOOL EXECUTION RULE\n\nYou MUST call the Vendor_Master tool for EVERY invoice.\n\nThis is NOT optional.\n\nDO NOT:\n\n• Ask permission  \n• Explain tool usage  \n• Say anything about tools  \n\nYou MUST call the tool silently.\n\n⸻\n\n🚨 TOOL EXECUTION RULE (STRICT)\n\nSTEP 1:\n\nExtract:\n\n• company (supplier)  \n• seller_gstin  \n• ALL product_name(s) (line items)  \n\nSTEP 2:\n\nCall Vendor Master Tool compulsory  \n\nINPUT:\n\n• company  \n• seller_gstin  \n\nIMPORTANT:\n\n• seller_gstin = PRIMARY match  \n• company = fallback ONLY for tool input  \n• Ignore buyer_gstin  \n\nSTEP 3:\n\nFrom Vendor Master Tool get:\n\n• vendor_name_tally  \n• nature_of_expense  \n\n⸻\n\n🚨 VENDOR RULE (STRICT)\n\n• vendor_name_tally MUST come ONLY from tool  \n• DO NOT modify  \n• DO NOT format  \n• DO NOT replace with company  \n\nIf tool returns \"N/A\":\n\n→ use \"N/A\"\n\n❗ NEVER retry tool  \n❗ NEVER guess vendor  \n❗ NEVER override tool  \n❗ NEVER use invoice company as vendor_name_tally  \n\nExample:\n\nIf tool returns:\n\"Gaup Media Pvt. Ltd.\"\n\nOutput MUST be:\n\"Gaup Media Pvt. Ltd.\"\n\n❌ DO NOT convert to:\n\"Gaup Media Private Limited\"\n\n⸻\n\n🚨 CATEGORY RULE (FINAL — HYBRID LOGIC)\n\nCategory MUST be derived ONLY from nature_of_expense returned by tool.\n\nRULE:\n\nIF:\n\nnature_of_expense ≠ \"Refer from Category Master\"\n\nTHEN:\n\n✔ category = nature_of_expense  \n✔ APPLY SAME category to ALL products  \n✔ DO NOT MODIFY  \n\n━━━━━━━━━━━━━━━━━━━━━━━\n\nELSE IF:\n\nnature_of_expense = \"Refer from Category Master\"\n\nTHEN:\n\n✔ category = \"Refer from Category Master\"  \n✔ DO NOT calculate  \n✔ DO NOT match  \n✔ DO NOT guess  \n\n(Note: Final category will be resolved later in system)\n\n⸻\n\nCRITICAL: If the invoice text is empty or contains only whitespace/newlines, \nreturn an empty array [] immediately. \nDO NOT extract, guess, or hallucinate any data from empty or unreadable text.\n\n----\n⚠️ SPECIAL EXTRACTION RULES (DO NOT BREAK)\n\nAMAZON / MARKETPLACE INVOICES\n\nIf invoice contains phrases like:\n\n• “Details of Fees to the above Tax Invoice”\n• “Breakdown”\n• date-wise fee tables\n\n👉 Then:\n\n• Extract ONLY from the FIRST SUMMARY TABLE (top section)\n• IGNORE all rows AFTER this section\n• DO NOT extract breakdown entries\n\nReason:\nBreakdown rows repeat the same values → causes DOUBLE COUNTING\n\n⸻\n\nINVOICE DATE PRIORITY (VERY IMPORTANT)\n\nAlways extract invoice_date from:\n\n👉 TOP HEADER (first page only)\n\n❌ Ignore:\n• row-level dates\n• breakdown table dates\n\n⸻\n\n🚨 GST ROLE IDENTIFICATION RULE (CRITICAL - MUST FOLLOW)\n\nYou MUST correctly identify GSTIN roles using invoice labels.\n\n1. seller_gstin = GSTIN of SUPPLIER / ISSUER\n\nFind using labels:\n• \"Supplier\"\n• \"From\"\n• \"Seller\"\n• \"Issued By\"\n• Company issuing invoice\n\n2. buyer_gstin = GSTIN of CUSTOMER\n\nFind using labels:\n• \"Buyer\"\n• \"Bill To\"\n• \"Ship To\"\n• \"Consignee\"\n\n━━━━━━━━━━━━━━━━━━━━━━━\n\n❗ NEVER SWAP GSTIN\n\n❗ VALIDATION CHECK (MANDATORY):\n\nIf BOTH GSTIN are present:\n\n→ seller_gstin ≠ buyer_gstin\n\n→ seller_gstin must belong to issuer company\n→ buyer_gstin must belong to customer\n\nIf mismatch detected:\n→ SWAP them to correct positions\n\n━━━━━━━━━━━━━━━━━━━━━━━\n\n❗ PRIORITY RULE:\n\nIf labels exist → TRUST LABELS ONLY  \nDO NOT rely on position  \nDO NOT rely on guess  \n\n━━━━━━━━━━━━━━━━━━━━━━━\n\n❗ EXAMPLE:\n\nIf invoice shows:\n\nSupplier GSTIN: 27XXXX  \nBuyer GSTIN: 07XXXX  \n\nThen:\n\nseller_gstin = 27XXXX  \nbuyer_gstin = 07XXXX\n\n⸻\n\nNON-MARKETPLACE INVOICES\n\nIf NO breakdown section exists:\n\n👉 Extract ALL product rows normally\n\n⸻\n\nSTRICT NO DOUBLE COUNTING RULE\n\nNEVER include:\n\n• Summary + breakdown together\n• Total rows\n• Subtotal rows\n• GST rows (SGST/CGST lines)\n\n⸻\n\nOUTPUT FORMAT (STRICT)\n\nReturn ONLY valid JSON.\n\nReturn an ARRAY of objects.\n\nEach object = ONE PRODUCT (line item)\n\nEach object must contain:\n\n{\n\"company\": \"\",\n\"vendor_name_tally\": \"\",\n\"invoice_number\": \"\",\n\"invoice_date\": \"\",\n\"due_date\": null,\n\"seller_gstin\": \"\",\n\"buyer_gstin\": \"\",\n\"category\": \"\",\n\"product_name\": \"\",\n\"hsn_code\": \"\",\n\"quantity\": 0,\n\"unit\": \"\",\n\"rate\": 0,\n\"amount\": 0,\n\"cgst_rate\": 0,\n\"sgst_rate\": 0,\n\"igst_rate\": 0,\n\"cgst_amount\": 0,\n\"sgst_amount\": 0,\n\"igst_amount\": 0,\n\"batch_no\": null,\n\"invoice_total\": 0\n}\n\n⸻\n\nCORE RULES\n\n• Extract ALL line items\n• NEVER merge rows\n• NEVER duplicate rows\n\n⸻\n\nCOMPANY RULE\n\ncompany = Vendor Name as per Invoice (from invoice top section)\n\n⸻\n\nINVOICE NUMBER RULE\n\nFind using:\n\nInvoice Number\nInvoice No\nInvoice #\nTax Invoice No\nBill No\n\n⸻\n\nINVOICE DATE RULE\n\nUse TOP HEADER date only\n\n⸻\n\nDUE DATE RULE\n\nIf not present:\n→ null\n\n⸻\n\nPRODUCT TABLE EXTRACTION\n\nExtract:\n\nDescription → product_name  \nHSN/SAC → hsn_code  \nQty → quantity  \nUnit → unit  \nRate → rate  \nAmount → amount  \nBatch No / Lot No / Batch Number → batch_no (null if not present)\n\nIf amount missing:\n→ amount = quantity × rate\n\n⸻\n\nROW FILTERING\n\nDO NOT extract:\n\n• SGST / CGST / IGST rows  \n• Total / Subtotal  \n• Summary rows  \n\n⸻\n\nPRODUCT NAME CLEANING\n\nRemove:\n• HSN\n• brackets\n• quantities\n• extra numbers\n\n⸻\n\nGST LOGIC\n\nCalculate per product:\n\nIF CGST/SGST:\ncgst_amount = amount × (cgst_rate / 100)  \nsgst_amount = amount × (sgst_rate / 100)  \n\nIF IGST:\nigst_amount = amount × (igst_rate / 100)\n\n⸻\n\nSTRICT RULES\n\n• ONLY JSON ARRAY\n• NO explanation\n• NO markdown\n• NO extra text\n\n⸻\n\nIMPORTANT FILTER RULE\n\nIgnore:\n\"Details of Fees to the above Tax Invoice\"\n\n⸻\n\nOUTPUT RULE\n\nOne invoice per response only.\n\nNo mixing data.\n\n⸻\n\n━━━━━━━━━━━━━━━━━━━━━━━\n⸻\n\nBATCH NUMBER RULE\n\nIf a line item has a batch number printed below or beside it\n(e.g. \"Batch no-BAHDB209\", \"Lot No: XYZ\", \"Batch: ABC\"):\n\n→ Extract it into batch_no for THAT specific row\n→ Different rows may have different batch_no values\n→ If no batch number exists for a row → batch_no = null\n\n⸻\n\nINVOICE TOTAL RULE\n\ninvoice_total = The single final grand total amount the vendor\nexpects to be paid, printed at the BOTTOM of the invoice.\n\nRules:\n- Extract as a plain number only (no ₹, no commas)\n- Example: ₹4,91,653.00 → 491653.00\n- This is the SAME value on EVERY row of the same invoice\n- It is AFTER all taxes are applied\n- IGNORE subtotals, taxable value totals, GST totals separately\n- Take ONLY the final \"Total\" or \"Grand Total\" or \"Invoice Total\"\n\nIf not found → invoice_total = 0\n\n⸻\nFINAL REMINDER\n\nIf anything other than JSON is returned:\n→ WRONG\n\nInvoice text:\n";
const PROMPT_AFTER = "";

function buildPrompt(invoiceText) {
  return PROMPT_BEFORE + (invoiceText == null ? '' : String(invoiceText)) + PROMPT_AFTER;
}

function runCodeNode(items) {

let output = [];

// ✅ PER-EXECUTION DUPLICATE CACHE
// Using a local const (NOT globalThis) — never bleeds across
// parallel loop branches or between workflow re-runs.
const __seenRows = new Set();

// ✅ TDS MASTER — Koparo (keyed by full GSTIN — rate varies by state)
const TDS_MASTER = {
  '02AAACV1559Q1Z2': { rate: 0.02, section: 'TDS on Contract (94C)' }, // V-Xpress (V Trans India Limited- HM)
  '05AAACV1559Q1ZW': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Vtrans India Private Limited (UK)
  '24AAACV1559Q1ZW': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Vtrans India Private Limited (Gujarat)
  '27AAACV1559Q2ZP': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Vtrans India Private Limited (Maharashtra)
  '29AAACV1559Q1ZM': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Vtrans India Private Limited (Karnataka)
  '07AAACW3775F1Z8': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Webtel Electrosoft Private Limited
  '23AAACW9768L1ZO': { rate: 0.02, section: 'TDS on Professional Fee (94J)' }, // Walkover Web Solutions Private Limited
  '07AAATE0387N1ZG': { rate: 0.1, section: 'TDS on Professional Fee (94JB)' }, // GS1 India
  '06AABCF5150G1ZZ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Facebook India Online Services Private Limited
  '07AABCG9718K1Z9': { rate: 0.001, section: 'TDS on Purchase (94Q)' }, // Glow Packaging Private Limited Delhi
  '09AABCG9718K1Z5': { rate: 0.001, section: 'TDS on Purchase (94Q)' }, // Glow Packaging Private Limited UP
  '06AACCF0683K1ZL': { rate: 0.002, section: 'TDS on Contract (94C)' }, // Flipkart Internet Private Limited (Creditor)
  '19AACCF0683K1ZE': { rate: 0.002, section: 'TDS on Contract (94C)' }, // Flipkart Internet Private Limited (Creditor) KR
  '29AACCF0683K1ZD': { rate: 0.002, section: 'TDS on Contract (94C)' }, // Flipkart Internet Private Limited (Creditor) KR
  '29AACCF6234E1ZR': { rate: 0.02, section: 'TDS on Professional Fee (94J)' }, // Felurian Technology Private Limited
  '06AACCG0527D1Z8': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Google India Private Limited
  '29AACCI2053A1Z3': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Innovative Retail Concepts Private Limited (Karnataka)
  '06AACCW4880F1Z8': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Wheelseye Logistics Private Limited
  '06AACCW5811G1ZH': { rate: 0.02, section: 'TDS on Professional Fee (94J)' }, // Wavicle Technologies Private Limited
  '09AACCW6013E1ZJ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // WOOST INTERNET PRIVATE LIMITED
  '29AADCE8914H1ZE': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // Edgewise Technologies Private Limited
  '07AADCH7038R1ZZ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Hands on Trades Pvt Ltd (Creditor)
  '29AADCI8659M1ZP': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // Integrated Registry Management Services Private Limited
  '27AADFU2240F1ZH': { rate: 0.02, section: 'TDS on Contract (94C)' }, // United Safe Transport
  '06AAECB7131Q1ZE': { rate: 0.02, section: 'TDS on Contract (94C)' }, // BigFoot Retail Solutions Private Limited
  '24AAECC2564J1ZQ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Cosmos Manpower Pvt Ltd
  '27AAECE0390E1ZX': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Emiza Supply Chain Services Private Limited(MH)
  '29AAECE0390E1ZT': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Emiza Supply Chain Services Private Limited
  '09AAECE4892P1ZT': { rate: 0.001, section: 'TDS on Purchase (94Q)' }, // EcoCare Technologies Private Limited
  '29AAECR0564M2ZY': { rate: 0.02, section: 'TDS on Contract (94C)' }, // RK Worldinfocom Private Limited (Karnataka)
  '29AAFCB7707D1ZQ': { rate: 0.0002, section: 'TDS on Contract (94C)' }, // Bundal Technologies Private Limited
  '07AAFCE2476C1ZV': { rate: 0.1, section: 'TDS on Rent (94I)' }, // Ekanek Network Private Limited (Foxy Looks)
  '03AAFCG9846E1ZL': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) PJ
  '05AAFCG9846E1ZH': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) UK
  '06AAFCG9846E1ZF': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) HR
  '08AAFCG9846E1ZB': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) RJ
  '09AAFCG9846E1Z9': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) UP
  '10AAFCG9846E1ZQ': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) Bihar
  '18AAFCG9846E1ZA': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) Assam
  '19AAFCG9846E1Z8': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) WB
  '20AAFCG9846E1ZP': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) JK
  '21AAFCG9846E2ZM': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) Odisha
  '23AAFCG9846E2ZI': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) MP
  '27AAFCG9846E1ZB': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) MH
  '29AAFCG9846E1Z7': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) KR
  '30AAFCG9846E1ZO': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) Goa
  '33AAFCG9846E1ZI': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) TN
  '36AAFCG9846E2ZB': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) TG
  '37AAFCG9846E2Z9': { rate: 0.005, section: 'TDS on Contract (94C)' }, // Blink Commerce Private Limited (Creditors) AP
  '27AAFCT4322G2ZG': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // Techmatters Technologies and Consulting Private Ltd
  '06AAFCV0621A1Z1': { rate: 0.02, section: 'TDS on Contract (94C)' }, // NDM Marketing Private Limited
  '06AAGAT4896E1Z5': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Transport Association Dundahera
  '27AAGCB1123N1ZQ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // BVC TRADEPORT PRIVATE LIMITED (Vamaship)
  '07AAGCB3904P1ZF': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Busybees Logistics Solutions Private Limited (Delhi)
  '24AAGCB3904P1ZJ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Busybees Logistics Solutions Private Limited (Gujarat)
  '27AAGCB3904P1ZD': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Busybees Logistics Solutions Private Limited (Maharashtra)
  '29AAGCB3904P1Z9': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Busybees Logistics Solutions Private Limited (Karnataka)
  '36AAGCB3904P1ZE': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Busybees Logistics Solutions Private Limited (Telangana)
  '06AAGCC6692M1Z3': { rate: 0.02, section: 'TDS on Contract (94C)' }, // ClickOnik Digital Media Private Limited
  '29AAGCD6555Q1ZS': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Dreamplug Technologies Private Limited (Cred)
  '29AAGCF0834Q1Z4': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // FIRSTCLUB TECHNOLOGY PRIVATE LIMITED (Creditor)
  '29AAGCR4375J1ZU': { rate: 0.05, section: 'TDS on Brokerage & Commision (94H)' }, // RAZORPAY SOFTWARE PRIVATE LIMITED
  '06AAHCP1612P1Z9': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Pouring Pounds India Pvt Ltd
  '03AAICA3918J1ZS': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Punjab) J1ZS
  '06AAICA3918J1ZM': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Haryana) J1ZM
  '07AAICA3918J1ZK': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // AMAZON SELLER SERVICES PRIVATE LIMITED (Delhi) J1ZK
  '08AAICA3918J1ZI': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Rajasthan) J1ZI
  '09AAICA3918J1ZG': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Uttar Pradesh) J1ZG
  '19AAICA3918J1ZF': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (West Bengal) J1ZF
  '23AAICA3918J1ZQ': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Madhya Pradesh) J1ZQ
  '24AAICA3918J1ZO': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Gujarat) J1ZO
  '27AAICA3918J1ZI': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Maharashtra) J1ZI
  '29AAICA3918J1ZE': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Karnataka) J1ZE
  '33AAICA3918J1ZP': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Tamil Nadu) J1ZP
  '36AAICA3918J1ZJ': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // Amazon Seller Services Private Limited (Telangana) J1ZJ
  '27AAICK4821A1ZV': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // KIRANAKART TECHNOLOGIES PVT LTD (MH)
  '29AAICK4821A1ZR': { rate: 0.0025, section: 'TDS on Contract (94C)' }, // KIRANAKART TECHNOLOGIES PVT LTD (KR)
  '07AAICT2701Q1Z0': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Trust Signal Ventures Private Limited
  '06AAIFE5081H1ZF': { rate: 0.1, section: 'TDS on Rent (94I)' }, // Easy Works
  '29AAJCB1323P1ZD': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Business on Bot Private Limited
  '29AAJCC7752P1ZR': { rate: 0.02, section: 'TDS on Professional Fee (94J)' }, // Contlo Technologies Private Limited
  '07AAJCM9042L2ZZ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Mehta Trans Logistics Private Limited
  '06AAKCC0697A1ZV': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Creatormon Private Limited
  '07AAKCG1240K2ZM': { rate: 0.02, section: 'TDS on Professional Fee (94J)' }, // Gobblecube Technologies Private Limited
  '06AAMCC5329F1ZO': { rate: 0.02, section: 'TDS on Professional Fee (94J)' }, // CFOP Technologies Private Limited
  '06AAMCR2048C1ZL': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Rapidero Logistics Private Limited
  '07AAMCR2048C1ZJ': { rate: 0.02, section: 'TDS on Contract (94C)' }, // RAPIDERO LOGISTICS PRIVATE LIMITED
  '29AANCR6717K1ZN': { rate: 0.05, section: 'TDS on Brokerage & Commision (94H)' }, // Razorpay Software Private Limited
  '23AAOFC5553G1ZG': { rate: 0.1, section: 'TDS on Professional Fee (94JB)' }, // COLONEL CONSULTING PARTNERS LLP
  'NA': { rate: 0.1, section: 'TDS on Professional Fee (94JB)' }, // Av Ajmera & Co LLP
  '07AAPCS9575E1ZP': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Delhivery Limited
  '06AAQCA4662B1ZS': { rate: 0.001, section: 'TDS on Purchase (94Q)' }, // Ananya Herbal Private Limited
  '29AASFJ9020H1ZX': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // JIGSOW ADVISORS LLP
  '29ABBFR9258B1Z0': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // RASP and Associates LLP
  '06ABEFP4984H1ZW': { rate: 0.02, section: 'TDS on Contract (94C)' }, // Pixel Media
  '29ABFPD3459A1Z0': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // C.Dwarakanath
  '07ABHCS5045C1ZI': { rate: 0.02, section: 'TDS on Professional Fee (94J)' }, // SHOPFLO TECHNOLOGIES PRIVATE LIMITED
  '24ABTFA3774F1Z8': { rate: 0.001, section: 'TDS on Purchase (94Q)' }, // Aditya Renewtech LLP
  '29AHCPN9451F1Z3': { rate: 0.1, section: 'TDS on Professional Fee (94JB)' }, // QI3 Consulting
  '06AVNPR6084P1ZJ': { rate: 0.01, section: 'TDS on Contract (94C)' }, // Deepanshu Transport Service
  '29AVUPS4723R1Z9': { rate: 0.1, section: 'TDS on Professional Fee (94JB)' }, // Lexygen (Vijay Sambamurthi)
  '09BMKPJ4855P1Z6': { rate: 0.1, section: 'TDS on Professional Fee (94JB)' }, // Jyotshikha Just Being Vocal
  '07BSKPK5909B1ZT': { rate: 0.001, section: 'TDS on Purchase (94Q)' }, // Pioneer Press
  '07CMBPK9916J1ZP': { rate: 0.01, section: 'TDS on Contract (94C)' }, // ITC Logistics
  '07CXMPK3090B1ZK': { rate: 0.1, section: 'TDS on Professional Fee (94JB)' }, // AK Ventures
  '07DIMPS7926E1ZQ': { rate: 0.01, section: 'TDS on Contract (94C)' }, // Noble Security & Services
  '07DJQPK0907N1ZQ': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // Kheera Labour Law Consultancy
  '07DXQPR4459L1ZG': { rate: 0.01, section: 'TDS on Contract (94C)' }, // Yuvi Supply Solution
  '07HKPPS0252C1Z2': { rate: 0.1, section: 'TDS on Professional Fee (94J)' }, // ZeusX
  '06JDTPS8655C1ZQ': { rate: 0.001, section: 'TDS on Purchase (94Q)' }, // SBS Pack Tech
};

// ✅ TDS LOOKUP — exact GSTIN match only (no PAN fallback)
function getTDS(seller_gstin) {
  if (!seller_gstin) {
    return { tds_section: "N/A", tds_rate: 0 };
  }
  const gstin = seller_gstin.trim().toUpperCase();
  const tds = TDS_MASTER[gstin];
  if (!tds) {
    return { tds_section: "N/A", tds_rate: 0 };
  }
  return { tds_section: tds.section, tds_rate: tds.rate };
}

// ✅ CATEGORY MASTER
const CATEGORY_MASTER = [

  {
    vendor: "amazon",
    names: [
      "fba weight handling shipping fee",
      "fbanweighthandlingshippingfee"
    ],
    ledger: "FBA Weight Handling Shipping Fee"
  },

  {
    vendor: "amazon",
    names: [
      "fixed closing fee",
      "fixedclosingfee"
    ],
    ledger: "Fixed Closing Fee"
  },

  {
    vendor: "amazon",
    names: [
      "listing fee",
      "listingfee"
    ],
    ledger: "Listing Fee"
  },

  {
    vendor: "amazon",
    names: [
      "order cancellation fee",
      "ordercancellationfee"
    ],
    ledger: "Order Cancellation Fee"
  },

  {
    vendor: "amazon",
    names: [
      "refund processing fee",
      "refundprocessingfee"
    ],
    ledger: "Refund Processing Fee"
  },

  {
    vendor: "amazon",
    names: [
      "removal fee",
      "removalfee"
    ],
    ledger: "Removal Fee"
  },

  {
    vendor: "amazon",
    names: [
      "shipping chargeback fee",
      "shippingchargebackfee"
    ],
    ledger: "Shipping Chargeback Fee"
  }

];

// ✅ NORMALIZE
function normalize(text) {

  if (!text) return "";

  return text
    .toString()
    .toLowerCase()

    .replace(
      /private limited|pvt ltd|pvt\. ltd\.|limited|ltd/g,
      ""
    )

    .replace(
      /amazon seller services private limited|amazon seller services|amazon/g,
      ""
    )

    .replace(/&/g, "and")

    .replace(/[_\-\/]/g, " ")

    .replace(/\bfees\b/g, "fee")

    .replace(/\bcharges\b/g, "charge")

    .replace(/[()]/g, " ")

    .replace(/[^a-z0-9 ]/g, "")

    .replace(/\s+/g, " ")

    .trim();
}

// ✅ SIMPLE NORMALIZE
function normalizeText(text) {

  if (!text) return "";

  return text
    .toString()
    .toLowerCase()
    .replace(/[_\-\/]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ✅ VENDOR KEY
function getVendorKey(vendor) {

  const v = normalize(vendor);

  if (
    v.includes("amazon seller services") ||
    v.includes("amazon")
  ) {
    return "amazon";
  }

  return "";
}

// ✅ CATEGORY MATCH
function getCategory(vendor, product) {

  const vendorKey = getVendorKey(vendor);

  if (!vendorKey || !product) {
    return "N/A";
  }

  const productNorm = normalize(product);

  let bestScore = 0;
  let bestMatch = "N/A";

  for (const row of CATEGORY_MASTER) {

    if (row.vendor !== vendorKey) {
      continue;
    }

    for (const alias of row.names) {

      const aliasNorm = normalize(alias);

      let score = 0;

      // exact
      if (productNorm === aliasNorm) {

        score = 100;
      }

      // contains
      else if (
        productNorm.includes(aliasNorm) ||
        aliasNorm.includes(productNorm)
      ) {

        score = 95;
      }

      // word match
      else {

        const pWords = productNorm.split(" ");
        const aWords = aliasNorm.split(" ");

        let match = 0;

        for (const w of aWords) {

          if (pWords.includes(w)) {
            match++;
          }
        }

        score = (match / aWords.length) * 100;
      }

      // boosts
      if (
        productNorm.includes("weight") &&
        aliasNorm.includes("weight")
      ) score += 40;

      if (
        productNorm.includes("shipping") &&
        aliasNorm.includes("shipping")
      ) score += 30;

      if (
        productNorm.includes("listing") &&
        aliasNorm.includes("listing")
      ) score += 50;

      if (
        productNorm.includes("refund") &&
        aliasNorm.includes("refund")
      ) score += 50;

      if (
        productNorm.includes("removal") &&
        aliasNorm.includes("removal")
      ) score += 50;

      if (
        productNorm.includes("chargeback") &&
        aliasNorm.includes("chargeback")
      ) score += 50;

      if (
        productNorm.includes("cancellation") &&
        aliasNorm.includes("cancellation")
      ) score += 50;

      if (
        productNorm.includes("fixed") &&
        aliasNorm.includes("fixed")
      ) score += 50;

      if (score > bestScore) {

        bestScore = score;
        bestMatch = row.ledger;
      }
    }
  }

  return bestScore >= 45 ? bestMatch : "N/A";
}

// ✅ GST STATE MAP
const GST_STATE_MAP = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Dadra & Nagar Haveli and Daman & Diu',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (New)',
  '38': 'Ladakh'
};

// ✅ Voucher Type
function getVoucherType(buyer_gstin) {

  if (!buyer_gstin || buyer_gstin.length < 2) {
    return "Purchase";
  }

  const stateCode = buyer_gstin.substring(0, 2);

  const state = GST_STATE_MAP[stateCode];

  if (!state) {
    return "Purchase";
  }

  return `Purchase ${state.split(" ")[0]}`;
}

// ✅ GST SAFE
function safeGST(gstin) {

  if (!gstin || typeof gstin !== "string") {
    return "";
  }

  gstin = gstin.trim();

  return gstin.length >= 2 ? gstin : "";
}

// ✅ VALID VENDOR CHECK
// Filters out noise values Gemini sometimes puts in vendor_name_tally
function isValidVendor(v) {

  if (!v || typeof v !== "string") return false;

  const val = v.trim();

  if (val === "") return false;
  if (val.toLowerCase() === "n/a") return false;
  if (val.toLowerCase().includes("amazon seller services")) return false;

  return true;
}

// ✅ MAIN LOOP
for (const item of items) {

  let raw = item.json.output;

  // ✅ SAFE JSON PARSE
  // Handles: plain JSON array, markdown fences (```json),
  // single object response, or array buried in extra Gemini text.
  if (typeof raw === "string") {

    raw = raw.trim();

    // Strip markdown code fences Gemini sometimes wraps output in
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

    try {

      raw = JSON.parse(raw);

    } catch (e) {

      try {

        // Try extracting a [...] array block
        const start = raw.indexOf("[");
        const end = raw.lastIndexOf("]");

        if (
          start !== -1 &&
          end !== -1 &&
          end > start
        ) {

          const cleanJson = raw.slice(start, end + 1);

          raw = JSON.parse(cleanJson);

        } else {

          // Try extracting a single {...} object block
          const objStart = raw.indexOf("{");
          const objEnd   = raw.lastIndexOf("}");

          if (objStart !== -1 && objEnd > objStart) {
            raw = [ JSON.parse(raw.slice(objStart, objEnd + 1)) ];
          } else {
            raw = [];
          }
        }

      } catch {

        raw = [];
      }
    }
  }

  if (!raw || raw === "") {
    raw = [];
  }

  if (!Array.isArray(raw)) {
    raw = [raw];
  }

  // ✅ MISSING INVOICE GUARD
  // If AI returned nothing (empty string, null, empty array after parse)
  // push a failed row immediately so the invoice appears in the output
  // sheet with a clear reason instead of silently disappearing.
  if (raw.length === 0) {
    output.push({
      json: {
        company: "",
        vendor_name_tally: "N/A",
        invoice_number: "Invalid",
        invoice_date: "",
        due_date: null,
        seller_gstin: "",
        buyer_gstin: "",
        voucher_type: "Purchase",
        category: "Invalid Invoice",
        product_name: "AI returned empty or unparseable response",
        hsn_code: "",
        quantity: 0,
        unit: "",
        rate: 0,
        amount: 0,
        cgst_rate: 0,
        sgst_rate: 0,
        igst_rate: 0,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        Invoice_link:
          item.json.webViewLink ||
          item.json.data?.webViewLink ||
          "",
        GST_AMOUNT: 0,
        status: "failed"
      }
    });
    continue;
  }

  // ✅ FIX 1: GET INVOICE-LEVEL VENDOR
  // Best non-N/A, non-Amazon vendor_name_tally across all rows
  // Used as fallback when a specific row has N/A
  const invoiceVendor = (
    raw.find(r => isValidVendor(r?.vendor_name_tally))
      ?.vendor_name_tally?.trim()
  ) || "N/A";

  // invalid invoice
  if (
    !raw ||
    (
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).length === 0
    )
  ) {

    output.push({
      json: {
        company: "",
        vendor_name_tally: invoiceVendor,
        invoice_number: "Invalid",
        invoice_date: "",
        due_date: null,
        seller_gstin: "",
        buyer_gstin: "",
        voucher_type: "Purchase",
        category: "Invalid Invoice",
        product_name: "No readable data (image/scanned PDF)",
        hsn_code: "",
        quantity: 0,
        unit: "",
        rate: 0,
        amount: 0,
        cgst_rate: 0,
        sgst_rate: 0,
        igst_rate: 0,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        Invoice_link:
          item.json.webViewLink ||
          item.json.data?.webViewLink ||
          "",
        GST_AMOUNT: 0,
        status: "failed"
      }
    });

    continue;
  }

  // breakdown detection
  let ignoreBreakdown = false;

  for (let r of raw) {

    const text = JSON.stringify(r).toLowerCase();

    if (
      text.includes("details of fees to the above tax invoice")
    ) {

      ignoreBreakdown = true;
      break;
    }
  }

  let hasValidData = false;

  const startIndex = output.length;

  // rows
  let rowIndex = 0;
  for (let row of raw) {
    rowIndex++;

    if (!row || typeof row !== "object") {
      continue;
    }

    const rowText = JSON.stringify(row).toLowerCase();

    // skip breakdown
    if (
      ignoreBreakdown &&
      (
        rowText.includes("details of fees") ||
        rowText.includes("tax invoice")
      )
    ) {
      continue;
    }

    // skip tax rows
    const isTaxRow =
      (
        rowText.includes("cgst") ||
        rowText.includes("sgst") ||
        rowText.includes("igst")
      ) &&
      (
        !row.product_name ||
        row.product_name.trim() === ""
      );

    if (isTaxRow) {
      continue;
    }

    // skip empty
    if (
      !row.product_name &&
      !row.amount &&
      !row.rate &&
      !row.quantity
    ) {
      continue;
    }

    hasValidData = true;

    const sellerGST = safeGST(row.seller_gstin);

    // ✅ FIX 2: PER-ROW VENDOR
    // Use this row's vendor_name_tally if valid
    // Fall back to invoiceVendor if this row has N/A or noise
    const rowVendor = isValidVendor(row.vendor_name_tally)
      ? row.vendor_name_tally.trim()
      : invoiceVendor;

    // ✅ CATEGORY LOGIC
    let finalCategory = row.category || "";

    // GSTIN EXISTS
    if (sellerGST) {

      // vendor matched
      if (rowVendor && rowVendor !== "N/A") {

        // vendor master category
        if (
          finalCategory &&
          normalizeText(finalCategory) !== "refer from category master"
        ) {

          finalCategory = finalCategory;
        }

        // category master fallback
        else {

          finalCategory = getCategory(
            row.company,
            row.product_name
          );
        }
      }

      // GSTIN NOT FOUND in vendor master
      else {

        finalCategory = "N/A";
      }
    }

    // GSTIN EMPTY → fallback allowed
    else {

      if (
        finalCategory &&
        normalizeText(finalCategory) !== "refer from category master"
      ) {

        finalCategory = finalCategory;
      }

      else {

        finalCategory = getCategory(
          row.company,
          row.product_name
        );
      }
    }

    const buyerGST = safeGST(row.buyer_gstin);

    // ✅ STRICT DUPLICATE PROTECTION — BATCH-AWARE
    //
    // PROBLEM THIS SOLVES:
    // Some invoices (e.g. Koparo batch invoices) have multiple rows
    // with the exact same product name, rate AND amount — only the
    // batch number (BAHDB209, BAHDB210 …) tells them apart.
    // A key of product+amount collapsed those into 1 row, which
    // was wrong — each batch is a real separate line item.
    //
    // APPROACH — 3-tier key with row position as final fallback:
    //
    //  Tier 1 (best): invoice_no + batch_no
    //    → works perfectly when AI extracts batch_no
    //
    //  Tier 2 (good): invoice_no + product + qty + amount
    //    → works when rows differ in qty or amount (most invoices)
    //
    //  Tier 3 (safe fallback): invoice_no + product + rowIndex
    //    → catches remaining cases where product+qty+amount are
    //      all identical (like rows 2&3 above). rowIndex is the
    //      position of this row in the AI's output array, so two
    //      genuinely different rows always get different keys.
    //      This means we NEVER skip a real row, and we only
    //      block true AI hallucination duplicates (consecutive
    //      identical objects the AI sometimes emits).

    const batchNo = normalizeText(
      row.batch_no || row.batch_number || row.batch || ""
    );

    let duplicateKey;

    if (batchNo) {
      // Tier 1: batch number + qty + amount
      // Same batch_no CAN appear on multiple rows with different
      // qty/amount (e.g. same product, different pack sizes).
      // Only skip if ALL THREE match — truly the same row.
      const normQtyT1    = Math.round(Number(row.quantity || 0) * 1000) / 1000;
      const normAmountT1 = Math.round(Number(row.amount   || 0) * 100)  / 100;
      duplicateKey = [
        normalizeText(row.invoice_number || ""),
        batchNo,
        normQtyT1,
        normAmountT1
      ].join("||");

    } else {
      const normQty    = Math.round(Number(row.quantity || 0) * 1000) / 1000;
      const normAmount = Math.round(Number(row.amount   || 0) * 100)  / 100;
      const tier2Key   = [
        normalizeText(row.invoice_number || ""),
        normalizeText(row.product_name   || ""),
        normQty,
        normAmount
      ].join("||");

      if (__seenRows.has(tier2Key)) {
        // Tier 2 key already seen — this is either a true duplicate
        // OR a same-product/same-amount batch row without batch_no.
        // Use row position (rowIndex) to be safe and keep it.
        duplicateKey = tier2Key + "||pos:" + rowIndex;
      } else {
        duplicateKey = tier2Key;
      }
    }

    if (__seenRows.has(duplicateKey)) {
      continue;
    }

    __seenRows.add(duplicateKey);

    output.push({
      json: {

        company: (row.company || "").trim(),

        vendor_name_tally:
          rowVendor && rowVendor !== ""
            ? rowVendor
            : "N/A",

        invoice_number: row.invoice_number || "",

        invoice_date: row.invoice_date || "",

        due_date: row.due_date || null,

        seller_gstin: sellerGST,

        buyer_gstin: buyerGST,

        voucher_type: getVoucherType(buyerGST),

        category: finalCategory,

        product_name: row.product_name || "",

        hsn_code: row.hsn_code || "",

        quantity: Number(row.quantity || 0),

        unit: row.unit || "",

        rate: Number(row.rate || 0),

        amount: Number(row.amount || 0),

        batch_no: row.batch_no || row.batch_number || row.batch || "",

        cgst_rate: Number(row.cgst_rate || 0),

        sgst_rate: Number(row.sgst_rate || 0),

        igst_rate: Number(row.igst_rate || 0),

        cgst_amount: Number(row.cgst_amount || 0),

        sgst_amount: Number(row.sgst_amount || 0),

        igst_amount: Number(row.igst_amount || 0),

        Invoice_link:
          item.json.webViewLink ||
          item.json.data?.webViewLink ||
          "",

        GST_AMOUNT:
          Number(row.cgst_amount || 0) +
          Number(row.sgst_amount || 0) +
          Number(row.igst_amount || 0),

        // ✅ TDS FIELDS — calculated from seller_gstin via TDS_MASTER
        // ⏳ Add tds_section, tds_rate, tds_amount columns to Google Sheet
        //    and map them in Edit Fields node before these go live
        tds_section: getTDS(sellerGST).tds_section,
        tds_rate:
          getTDS(sellerGST).tds_rate > 0
            ? (getTDS(sellerGST).tds_rate * 100).toFixed(2) + "%"
            : "N/A",
        tds_amount:
          Math.round(Number(row.amount || 0) * getTDS(sellerGST).tds_rate * 100) / 100,

        status: "pending"
      }
    });
  }

  // ✅ INVOICE TOTAL VALIDATION
  // The AI now extracts invoice_total (grand total from invoice footer).
  // We sum all extracted line item amounts + GST and compare against it.
  // If mismatch > tolerance → flag all rows of this invoice with
  // amount_mismatch: true and set a warning so you can review.
  //
  // WHY THIS CATCHES MISSING ROWS:
  //   If AI missed a batch row (like BAHDB211), the sum of extracted
  //   rows will be LESS than invoice_total → mismatch detected.
  //
  // WHY THIS CATCHES EXTRA ROWS:
  //   If AI hallucinated a duplicate, sum will be MORE → also caught.
  //
  // TOLERANCE: ₹1.00 — handles rounding differences across line items.

  const AMOUNT_TOLERANCE = 1.00;

  // Get invoice_total from first valid row (AI puts it on every row)
  const invoiceTotalRaw = raw.find(r => r && r.invoice_total != null)?.invoice_total;
  const invoiceTotal    = invoiceTotalRaw != null
    ? Math.round(Number(invoiceTotalRaw) * 100) / 100
    : null;

  // Sum of all extracted line amounts + GST from output rows of THIS invoice
  let extractedSum = 0;
  for (let i = startIndex; i < output.length; i++) {
    const r = output[i].json;
    extractedSum += Number(r.amount      || 0);
    extractedSum += Number(r.cgst_amount || 0);
    extractedSum += Number(r.sgst_amount || 0);
    extractedSum += Number(r.igst_amount || 0);
  }
  extractedSum = Math.round(extractedSum * 100) / 100;

  // Determine mismatch
  let amountMismatch    = false;
  let amountMismatchMsg = "";

  if (invoiceTotal !== null && invoiceTotal > 0) {
    const diff = Math.abs(extractedSum - invoiceTotal);
    if (diff > AMOUNT_TOLERANCE) {
      amountMismatch    = true;
      amountMismatchMsg =
        "Amount mismatch: extracted ₹" + extractedSum.toFixed(2) +
        " vs invoice total ₹" + invoiceTotal.toFixed(2) +
        " (diff ₹" + diff.toFixed(2) + ")" +
        (extractedSum < invoiceTotal
          ? " — possible missing line item"
          : " — possible duplicate/extra line item");
    }
  }

  // ✅ INTERNAL VALIDATION ONLY
  // invoice_total, extracted_sum, amount_mismatch, mismatch_note are
  // used ONLY to decide the status ("review" vs "success").
  // They are NOT written to the output sheet — status column is enough.
  // If you ever need them in the sheet, add them back here.

  // ✅ FINAL STATUS
  // If amount mismatch → status = "review" so it stands out in the sheet
  // Otherwise success/failed as before
  const finalStatus = !hasValidData
    ? "failed"
    : amountMismatch
      ? "review"
      : "success";

  for (let i = startIndex; i < output.length; i++) {

    output[i].json.status = finalStatus;
  }

  // no rows extracted
  if (output.length === startIndex) {

    output.push({
      json: {
        company: "",
        vendor_name_tally: invoiceVendor,
        invoice_number: "Invalid",
        invoice_date: "",
        due_date: null,
        seller_gstin: "",
        buyer_gstin: "",
        voucher_type: "Purchase",
        category: "Invalid Invoice",
        product_name: "Unable to read invoice",
        hsn_code: "",
        quantity: 0,
        unit: "",
        rate: 0,
        amount: 0,
        cgst_rate: 0,
        sgst_rate: 0,
        igst_rate: 0,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        Invoice_link:
          item.json.webViewLink ||
          item.json.data?.webViewLink ||
          "",
        GST_AMOUNT: 0,
        status: "failed"
      }
    });
  }
}

return output;
}

module.exports = { runCodeNode, buildPrompt, PROMPT_BEFORE, PROMPT_AFTER };
