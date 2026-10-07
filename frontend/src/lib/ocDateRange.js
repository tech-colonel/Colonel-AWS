// Shared, session-scoped date range for the Shopify-Order-Cycle screens.
//
// The range the user picks on the Reconciliation dashboard and on the Analytics
// Portal is one and the same: it survives navigating between them (and between
// the Portal's sections), and only changes when the user changes it. Stored per
// brand+agent in sessionStorage as month-boundary ISO strings, so it lasts for
// the tab session and is cleared with it.

const keyFor = (brandId, agentId) => `ocDateRange:${brandId}:${agentId}`;

export function loadOcDateRange(brandId, agentId) {
    try {
        const raw = sessionStorage.getItem(keyFor(brandId, agentId));
        if (!raw) return null;
        const v = JSON.parse(raw);
        return (v && typeof v.from === 'string' && typeof v.to === 'string') ? { from: v.from, to: v.to } : null;
    } catch {
        return null;
    }
}

export function saveOcDateRange(brandId, agentId, range) {
    try {
        const k = keyFor(brandId, agentId);
        if (range && range.from && range.to) {
            sessionStorage.setItem(k, JSON.stringify({ from: range.from, to: range.to }));
        } else {
            sessionStorage.removeItem(k);
        }
    } catch {
        /* storage unavailable — range just won't persist */
    }
}

// month/year selects → the exact ISO from/to (first day of `from` month → last day of `to` month)
export function monthRangeToIso(fromM, fromY, toM, toY) {
    const p2 = (n) => String(n).padStart(2, '0');
    const lastDay = new Date(toY, toM, 0).getDate();
    return { from: `${fromY}-${p2(fromM)}-01`, to: `${toY}-${p2(toM)}-${p2(lastDay)}` };
}
