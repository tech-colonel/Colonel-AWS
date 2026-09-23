# Amazon fee invoices

Amazon deducts its fees from the payout and separately issues monthly tax
invoices for the same fees. The payout tells you what was taken; only the
invoice supports the input credit. These scripts read the invoices and hold the
two against each other.

    python3 amazon_fee_invoice.py <pdf>...                         # parse -> JSON
    python3 build_fee_register.py <out.xlsx> "<period>" <pdf>...   # 3-sheet register
    python3 reconcile_with_settlement.py <ledger-dir> <pdf-dir> MM YYYY

`<ledger-dir>` is `new-backend/outputs/amazon-ledgers`, where the settlement
importer retains the raw TSV for every settlement it fetches.

## What is checked

Every document must tie to the totals Amazon printed on it before anything is
reported — 10 checks per document, including the front summary table against
the back detail ledger, and the tax head against the place of supply. A
document that fails its own arithmetic is rejected, not half-booked.

## Two things the layout will do to you

A credit note prints its minus sign in the column header's row, not beside the
figure, so extraction loses it. Every amount on a credit note is negative by
definition; that is what the parser uses.

Columns interleave. A credit-note row can render as
`Fixed Closing KA-2627- 998599 Fee842383`, where `842383` is the tail of the
original invoice number and looks exactly like a valid 6-digit SAC. The parser
reads the front summary table first to learn which SAC codes and fee
descriptions this document actually uses, and reads the detail rows against it.

Amazon's document-number prefix is its own issuing series, not the state:
`KA-2627-1685246` is a Delhi invoice. Never derive state from the prefix.
