const form = document.querySelector("#reconForm");
const statusBox = document.querySelector("#status");
const summaryGrid = document.querySelector("#summaryGrid");
const resultsBody = document.querySelector("#resultsBody");
const filters = document.querySelector("#filters");
const exportLink = document.querySelector("#exportLink");
const selectedAgent = document.querySelector("#selectedAgent");
const recoTypeInput = form.querySelector('input[name="reco_type"]');
const agentCards = document.querySelectorAll(".agent-card:not(.locked)");
const fileDrops = document.querySelectorAll(".file-drop");
const fileModes = document.querySelectorAll(".file-mode");
const agentPrompt = document.querySelector("#agentPrompt");
const runButton = document.querySelector("#runButton");
const sourceOneHead = document.querySelector("#sourceOneHead");
const sourceTwoHead = document.querySelector("#sourceTwoHead");
const sourceThreeHead = document.querySelector("#sourceThreeHead");
const mismatchesHead = document.querySelector("#mismatchesHead");
const actionHead = document.querySelector("#actionHead");
const heroCardTitle = document.querySelector(".hero-card strong");
const heroCardSub = document.querySelector(".hero-card p");

const agentLabels = {
  gst_2b_purchase: "GST 2B Agent",
  gstr_2a_2b_books: "GSTR2 vs Books",
  gstr_3b_vs_2b: "3B vs 2B Agent",
  bank_reco: "Bank Statement Agent",
  gstr_1_vs_books: "GSTR-1 vs Books Agent",
};

const agentPrompts = {
  gst_2b_purchase:
    "I need the GSTR-2B Excel/JSON/CSV and your Purchase Register Excel/CSV. I will classify exact matches, tax mismatches, missing-in-books, and missing-in-2B.",
  gstr_2a_2b_books:
    "Upload GSTR-2B and Books files. I will match PAN+invoice UID, detect amount differences, and flag missing entries.",
  gstr_3b_vs_2b:
    "Upload the combined GSTR-2B (with B2B, CDNR, IMPG sheets) and your GSTR-3B working file. I will match ITC claimed in 3B against ITC available in 2B, flag entries not claimed, and build a month-wise pivot.",
  bank_reco:
    "Upload the OD Acc Excel statement file from the portal. Our AI engine will intelligently map transactions with our pre-loaded master ledgers with accountant-level accuracy.",
  gstr_1_vs_books:
    "Upload your Tally Sales Register and the GSTR-1 export (B2B + B2C sheets). Optionally add the Amazon Ready-to-File report — I will replace summarised Amazon entries with invoice-level data before matching.",
};

let allResults = [];
let activeCategory = "All";

agentCards.forEach((card) => {
  card.addEventListener("click", () => {
    agentCards.forEach((item) => item.classList.remove("selected"));
    card.classList.add("selected");
    const agent = card.dataset.agent;
    recoTypeInput.value = agent;
    selectedAgent.textContent = agentLabels[agent] || "Reco Agent";
    agentPrompt.textContent = agentPrompts[agent] || agentPrompts.gst_2b_purchase;
    const btnLabels = {
      gstr_2a_2b_books: "Run 2-Way Reco",
      gstr_3b_vs_2b: "Run 3B vs 2B Reco",
      bank_reco: "Run Process",
      gstr_1_vs_books: "Run GSTR-1 Reco",
    };
    runButton.textContent = btnLabels[agent] || "Run GST Reco";
    setMode(agent);
    const fileCount = agent === "gstr_1_vs_books" ? "three" : "two";
  statusBox.textContent = `${selectedAgent.textContent} selected. Attach the ${fileCount} source files to begin.`;
  });
});

fileDrops.forEach((drop) => {
  const input = drop.querySelector("input");
  const label = drop.dataset.fileLabel;
  input.addEventListener("change", () => {
    const file = input.files[0];
    drop.classList.toggle("has-file", Boolean(file));
    drop.querySelector("strong").textContent = file ? file.name : label;
    drop.querySelector("em").textContent = file ? "Replace file" : "Choose file";
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const agent = recoTypeInput.value;
    const runningMsg = {
      gstr_2a_2b_books: "2B / Books Agent is reading Excel sheets and building matches...",
      gstr_3b_vs_2b: "3B vs 2B Agent is matching ITC claimed against ITC available...",
      bank_reco: "Bank Statement Agent is classifying transactions against internal master ledgers...",
      gstr_1_vs_books: "GSTR-1 vs Books Agent is merging Amazon data, running B2B invoice match and B2C state-wise match...",
    };
  statusBox.textContent = runningMsg[agent] || "GST 2B Agent is reading Excel files and running GSTN-style matching...";
  exportLink.classList.add("disabled");
  exportLink.setAttribute("aria-disabled", "true");

  const data = new FormData(form);
  try {
    const response = await fetch("/api/reconcile", {
      method: "POST",
      body: data,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Reconciliation failed.");
    }
    allResults = payload.results;
    activeCategory = "All";
    statusBox.textContent = statusMessage(payload);
    exportLink.href = `/api/jobs/${payload.job_id}/export.xlsx`;
    exportLink.classList.remove("disabled");
    exportLink.setAttribute("aria-disabled", "false");
    renderSummary(payload.summary);
    renderFilters(payload.summary);
    renderResults();
    document.querySelector("#results").scrollIntoView({ block: "start" });
    // Render pivot table for 3B vs 2B
    if (payload.reco_type === "gstr_3b_vs_2b" && payload.pivot) {
      renderPivot(payload.pivot);
    }
    // Render monthly summary for GSTR-1 vs Books
    if (payload.reco_type === "gstr_1_vs_books" && payload.monthly_summary) {
      renderMonthlySummary(payload.monthly_summary);
    }
  } catch (error) {
    statusBox.textContent = error.message;
  }
});

function renderSummary(summary) {
  summaryGrid.innerHTML = "";
  // Clear any previous auxiliary sections
  const existingPivot = document.querySelector("#pivotSection");
  if (existingPivot) existingPivot.remove();
  const existingMonthly = document.querySelector("#monthlySummarySection");
  if (existingMonthly) existingMonthly.remove();
  Object.entries(summary).forEach(([category, count]) => {
    const card = document.createElement("article");
    card.className = "summary-card";
    card.innerHTML = `<strong>${count}</strong><span>${escapeHtml(category)}</span>`;
    summaryGrid.appendChild(card);
  });
}

function renderFilters(summary) {
  filters.innerHTML = "";
  const categories = ["All", ...Object.keys(summary)];
  categories.forEach((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter ${category === activeCategory ? "active" : ""}`;
    button.textContent = category;
    button.addEventListener("click", () => {
      activeCategory = category;
      renderFilters(summary);
      renderResults();
    });
    filters.appendChild(button);
  });
}

function renderResults() {
  const rows = activeCategory === "All" ? allResults : allResults.filter((row) => row.category === activeCategory);
  if (!rows.length) {
    resultsBody.innerHTML = '<tr><td colspan="7" class="empty">No rows in this bucket.</td></tr>';
    return;
  }
  resultsBody.innerHTML = rows.map(renderRow).join("");
}

function renderRow(row) {
  if (recoTypeInput.value === "gstr_1_vs_books") {
    if (row.reco_level === "B2B") {
      const bk = row.books || {};
      const g1 = row.gstr1 || {};
      return `
        <tr>
          <td class="category ${categoryClass(row.category)}">${escapeHtml(row.category)}</td>
          <td>${row.confidence}%</td>
          <td>
            <div class="doc">
              <strong>${escapeHtml(bk.doc_no || "-")}</strong>
              <div>${escapeHtml(bk.party_name || "-")}</div>
              <div class="muted">${escapeHtml(bk.buyer_gstin || "-")} | ${escapeHtml(bk.doc_date || "-")} | Taxable ${money(bk.taxable_value)}</div>
            </div>
          </td>
          <td>
            <div class="doc">
              <strong>${escapeHtml(g1.doc_no || "-")}</strong>
              <div>${escapeHtml(g1.party_name || "-")}</div>
              <div class="muted">${escapeHtml(g1.buyer_gstin || "-")} | ${escapeHtml(g1.doc_date || "-")} | Taxable ${money(g1.taxable_value)}</div>
            </div>
          </td>
          <td class="optional-col is-hidden"></td>
          <td>${escapeHtml(row.mismatch_fields.join(", ") || "-")}</td>
          <td>
            <strong>${escapeHtml(row.suggested_action)}</strong>
            <div class="muted">${escapeHtml(row.explanation)}</div>
          </td>
        </tr>
      `;
    }
    // B2C row
    return `
      <tr>
        <td class="category ${categoryClass(row.category)}">${escapeHtml(row.category)}</td>
        <td>B2C</td>
        <td>
          <div class="doc">
            <strong>${escapeHtml(row.place_of_supply || "-")}</strong>
            <div class="muted">Rate: ${row.tax_rate || 0}% | Taxable ${money(row.books_taxable)}</div>
          </div>
        </td>
        <td>
          <div class="doc">
            <strong>${escapeHtml(row.place_of_supply || "-")}</strong>
            <div class="muted">Rate: ${row.tax_rate || 0}% | Taxable ${money(row.gstr1_taxable)}</div>
          </div>
        </td>
        <td class="optional-col is-hidden"></td>
        <td>Taxable diff: ${money(row.diff_taxable)}</td>
        <td><strong>${escapeHtml(row.suggested_action)}</strong></td>
      </tr>
    `;
  }
  if (recoTypeInput.value === "bank_reco") {
    return `
      <tr>
        <td class="category ${categoryClass(row.category)}">${escapeHtml(row.category)}</td>
        <td>${row.confidence}</td>
        <td>${escapeHtml(row.txn_date || "")}</td>
        <td>
          <strong>${escapeHtml(row.predicted_ledger || "-")}</strong>
          <div class="muted">${escapeHtml(row.predicted_type || "-")}</div>
        </td>
        <td>
          <div class="doc" title="${escapeHtml(row.original_description)}">
            <div>${escapeHtml(row.cleaned_description || "-")}</div>
            <div class="muted">Orig: ${escapeHtml(row.original_description || "-").substring(0, 50)}...</div>
          </div>
        </td>
        <td class="optional-col">
          <div style="text-align: right">
            <div>${row.debit ? `Dr: ${money(row.debit)}` : ''}</div>
            <div>${row.credit ? `Cr: ${money(row.credit)}` : ''}</div>
            <div class="muted">Bal: ${money(row.balance)}</div>
          </div>
        </td>
        <td>
          <strong>Auto Classified</strong>
          <div class="muted">Based on rules/AI</div>
        </td>
      </tr>
    `;
  }
  if (recoTypeInput.value === "gstr_3b_vs_2b") {
    const rec_2b = row.rec_2b;
    const rec_3b = row.rec_3b;
    return `
      <tr>
        <td class="category ${categoryClass(row.category)}">${escapeHtml(row.category)}</td>
        <td>${row.confidence}%</td>
        <td>${render3BDoc(rec_2b, "2B")}</td>
        <td>${render3BDoc(rec_3b, "3B")}</td>
        <td class="optional-col is-hidden"></td>
        <td>${escapeHtml(row.mismatch_fields.join(", ") || "-")}</td>
        <td>
          <strong>${escapeHtml(row.suggested_action)}</strong>
          <div class="muted">${escapeHtml(row.explanation)}</div>
        </td>
      </tr>
    `;
  }
  if (recoTypeInput.value === "gstr_2a_2b_books") {
  return `
    <tr>
      <td class="category ${categoryClass(row.category)}">${escapeHtml(row.category)}</td>
      <td>${row.confidence}%</td>
      <td>${renderDoc(row.gstr2b)}</td>
      <td>${renderDoc(row.books)}</td>
      <td>${escapeHtml(row.mismatch_fields.join(", ") || "-")}</td>
      <td>
        <strong>${escapeHtml(row.suggested_action)}</strong>
        <div class="muted">${escapeHtml(row.explanation)}</div>
      </td>
    </tr>
  `;
}
  return `
    <tr>
      <td class="category ${categoryClass(row.category)}">${escapeHtml(row.category)}</td>
      <td>${row.confidence}%</td>
      <td>${renderDoc(row.gstr2b)}</td>
      <td>${renderDoc(row.purchase)}</td>
      <td class="optional-col is-hidden"></td>
      <td>${escapeHtml(row.mismatch_fields.join(", ") || "-")}</td>
      <td>
        <strong>${escapeHtml(row.suggested_action)}</strong>
        <div class="muted">${escapeHtml(row.explanation)}</div>
      </td>
    </tr>
  `;
}

function renderDoc(record) {
  if (!record) {
    return '<span class="muted">Not found</span>';
  }
  return `
    <div class="doc">
      <strong>${escapeHtml(record.doc_no || "-")}</strong>
      <div>${escapeHtml(record.supplier_gstin || "-")}</div>
      <div class="muted">${escapeHtml(record.doc_date || "-")} | Taxable ${money(record.taxable_value)} | Tax ${money(record.total_tax)}</div>
    </div>
  `;
}

function renderThreeWayDoc(record) {
  if (!record) {
    return '<span class="muted">Not found</span>';
  }
  return `
    <div class="doc">
      <strong>${escapeHtml(record.doc_no || "-")}</strong>
      <div>${escapeHtml(record.pan || record.supplier_gstin || "-")}</div>
      <div class="muted">${escapeHtml(record.month || record.doc_date || "-")} | Value ${money(record.doc_value)}</div>
    </div>
  `;
}

function setMode(agent) {
  fileModes.forEach((mode) => {
    mode.classList.toggle("active", mode.dataset.mode === agent);
    mode.querySelectorAll("input[type='file']").forEach((input) => {
      input.disabled = mode.dataset.mode !== agent;
      input.required = false;
    });
  });

  if (agent === "gstr_2a_2b_books") {
  sourceOneHead.textContent = "GSTR-2B";
  sourceTwoHead.textContent = "Books";
  sourceThreeHead.textContent = "";
  sourceThreeHead.classList.add("is-hidden");
  mismatchesHead.textContent = "Mismatches";
  actionHead.textContent = "Suggested Action";
  heroCardTitle.textContent = "GSTR2 vs Books Agent";
  heroCardSub.textContent = "Ready for GSTR-2B vs Books reconciliation";
  // Ensure required inputs for this mode
  document.querySelector('input[name="gstr2b"]').required = true;
  document.querySelector('input[name="books"]').required = true;
} else if (agent === "gstr_3b_vs_2b") {
    sourceOneHead.textContent = "GSTR-2B";
    sourceTwoHead.textContent = "GSTR-3B Working";
    sourceThreeHead.textContent = "";
    sourceThreeHead.classList.add("is-hidden");
    mismatchesHead.textContent = "Mismatches";
    actionHead.textContent = "Suggested Action";
    heroCardTitle.textContent = "3B vs 2B Agent";
    heroCardSub.textContent = "Ready for GSTR-3B vs GSTR-2B";
  } else if (agent === "bank_reco") {
    sourceOneHead.textContent = "Bank Statement";
    sourceTwoHead.textContent = "Prediction";
    sourceThreeHead.textContent = "";
    sourceThreeHead.classList.add("is-hidden");
    mismatchesHead.textContent = "Values";
    actionHead.textContent = "Status";
    heroCardTitle.textContent = "Bank Statement Process";
    heroCardSub.textContent = "Ready to classify bank transactions";
    document.querySelectorAll(".file-mode[data-mode='bank_reco'] input[type='file']").forEach(i => i.required = true);
  } else if (agent === "gstr_1_vs_books") {
    sourceOneHead.textContent = "Books";
    sourceTwoHead.textContent = "GSTR-1";
    sourceThreeHead.textContent = "";
    sourceThreeHead.classList.add("is-hidden");
    mismatchesHead.textContent = "Mismatches";
    actionHead.textContent = "Suggested Action";
    heroCardTitle.textContent = "GSTR-1 vs Books Agent";
    heroCardSub.textContent = "Ready for GSTR-1 vs Sales Register";
    document.querySelector('input[name="tally_sales"]').required = true;
    document.querySelector('input[name="gstr1"]').required = true;
  } else {
    sourceOneHead.textContent = "GSTR-2B";
    sourceTwoHead.textContent = "Purchase Register";
    sourceThreeHead.textContent = "Books";
    sourceThreeHead.classList.add("is-hidden");
    mismatchesHead.textContent = "Mismatches";
    actionHead.textContent = "Suggested Action";
    heroCardTitle.textContent = "GST 2B Agent";
    heroCardSub.textContent = "Ready for GSTR-2B vs Purchase Register";
    form.querySelector('input[name="gstr2b"]').required = true;
    form.querySelector('input[name="purchase"]').required = true;
  }
}

function statusMessage(payload) {
  if (payload.reco_type === "gstr_2a_2b_books") {
    return `Done. Compared ${payload.counts.gstr2b_records} GSTR-2B records and ${payload.counts.books_records} books records.`;
  }
  if (payload.reco_type === "gstr_3b_vs_2b") {
    return `Done. Matched ${payload.counts.gstr2b_records} GSTR-2B records against ${payload.counts.gstr3b_records} GSTR-3B working records. ${payload.counts.result_rows} result rows.`;
  }
  if (payload.reco_type === "bank_reco") {
    return `Done. Classified ${payload.counts.bank_rows} bank transactions against ${payload.counts.master_ledgers} master ledgers.`;
  }
  if (payload.reco_type === "gstr_1_vs_books") {
    return `Done. Matched ${payload.counts.books_records} books records against ${payload.counts.gstr1_b2b_records} GSTR-1 B2B and ${payload.counts.gstr1_b2c_records} B2C entries.`;
  }
  return `Done. Matched ${payload.counts.gstr2b_records} GSTR-2B records against ${payload.counts.purchase_records} purchase records.`;
}

function categoryClass(category) {
  if (category === "Exact Match" || category === "Matched") return "cat-exact";
  if (category === "Cross-Matched") return "cat-cross";
  if (category.includes("not in") || category.includes("Mismatch") || category.includes("Not in")) return "cat-danger";
  return "cat-warn";
}

function money(value) {
  return Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render3BDoc(record, label) {
  if (!record) {
    return '<span class="muted">Not found</span>';
  }
  return `
    <div class="doc">
      <strong>${escapeHtml(record.invoice_no || "-")}</strong>
      <div>${escapeHtml(record.party_name || record.supplier_gstin || "-")}</div>
      <div class="muted">${escapeHtml(record.month || "-")} | ${escapeHtml(record.date || "-")} | Value ${money(record.value)} | IGST ${money(record.igst)} | CGST ${money(record.cgst)} | SGST ${money(record.sgst)}</div>
    </div>
  `;
}

function renderMonthlySummary(monthly) {
  if (!monthly || !monthly.length) return;
  let existing = document.querySelector("#monthlySummarySection");
  if (existing) existing.remove();

  const section = document.createElement("section");
  section.id = "monthlySummarySection";
  section.className = "panel results-panel";
  section.innerHTML = `
    <div class="results-head">
      <div>
        <p class="eyebrow">Monthly Summary</p>
        <h2>Books vs GSTR-1 — month-wise totals</h2>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Month</th><th>Status</th>
            <th>Books Taxable</th><th>GSTR-1 Taxable</th><th>Diff</th>
            <th>Books CGST</th><th>GSTR-1 CGST</th><th>Diff</th>
            <th>Books SGST</th><th>GSTR-1 SGST</th><th>Diff</th>
            <th>Books IGST</th><th>GSTR-1 IGST</th><th>Diff</th>
          </tr>
        </thead>
        <tbody>
          ${monthly.map(r => `
            <tr>
              <td><strong>${escapeHtml(r.month)}</strong></td>
              <td class="${r.status === 'Matched' ? 'cat-exact' : 'cat-danger'}">${escapeHtml(r.status)}</td>
              <td>${money(r.books_taxable)}</td><td>${money(r.gstr1_taxable)}</td><td class="${r.diff_taxable === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.diff_taxable)}</td>
              <td>${money(r.books_cgst)}</td><td>${money(r.gstr1_cgst)}</td><td class="${r.diff_cgst === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.diff_cgst)}</td>
              <td>${money(r.books_sgst)}</td><td>${money(r.gstr1_sgst)}</td><td class="${r.diff_sgst === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.diff_sgst)}</td>
              <td>${money(r.books_igst)}</td><td>${money(r.gstr1_igst)}</td><td class="${r.diff_igst === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.diff_igst)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  summaryGrid.after(section);
}

function renderPivot(pivot) {
  if (!pivot || !pivot.length) return;
  let existing = document.querySelector("#pivotSection");
  if (existing) existing.remove();

  const section = document.createElement("section");
  section.id = "pivotSection";
  section.className = "panel results-panel";
  section.innerHTML = `
    <div class="results-head">
      <div>
        <p class="eyebrow">Month-wise Pivot</p>
        <h2>IGST / CGST / SGST variance by month</h2>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>2B IGST</th><th>3B IGST</th><th>IGST Diff</th>
            <th>2B CGST</th><th>3B CGST</th><th>CGST Diff</th>
            <th>2B SGST</th><th>3B SGST</th><th>SGST Diff</th>
            <th>2B Value</th><th>3B Value</th><th>Value Diff</th>
          </tr>
        </thead>
        <tbody>
          ${pivot.map(r => `
            <tr>
              <td><strong>${escapeHtml(r.month)}</strong></td>
              <td>${money(r.igst_2b)}</td><td>${money(r.igst_3b)}</td><td class="${r.igst_diff === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.igst_diff)}</td>
              <td>${money(r.cgst_2b)}</td><td>${money(r.cgst_3b)}</td><td class="${r.cgst_diff === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.cgst_diff)}</td>
              <td>${money(r.sgst_2b)}</td><td>${money(r.sgst_3b)}</td><td class="${r.sgst_diff === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.sgst_diff)}</td>
              <td>${money(r.value_2b)}</td><td>${money(r.value_3b)}</td><td class="${r.value_diff === 0 ? 'cat-exact' : 'cat-danger'}">${money(r.value_diff)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  summaryGrid.after(section);
}

setMode(recoTypeInput.value);
