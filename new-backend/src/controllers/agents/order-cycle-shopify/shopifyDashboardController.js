/**
 * Shopify Dashboard Controller — "Operations" section
 *
 * A MyNorthStar-style drill-down analytics view layered on top of the data the
 * Shopify-Order-Cycle agent already reconciles and saves into the per-brand
 * `shopify_order_cycle` table. Unlike orderCycleShopifyController's per-file
 * report, this aggregates across EVERY uploaded file for the brand and slices it
 * by courier × payment method, with monthly columns and a current-vs-comparison
 * period.
 *
 * Endpoints (mounted under /brands/:brandId/agents/:agentId/order-cycle-shopify):
 *   GET  /shopify-dashboard/operations               → getOperationsData
 *   GET  /shopify-dashboard/operations/transactions   → getOperationsTransactions
 *   GET  /shopify-dashboard/operations/download        → downloadOperations
 *
 * Scope note: only "Operations" is built. Other Figma sections (Marketplaces /
 * Marketing / Traffic / Support / full P&L / Inventory) need data no uploaded
 * file carries today and are intentionally left out.
 */

const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const ExcelJS = require('exceljs');

// ─── Row-level helpers (shopify_order_cycle schema) ───────────────────────────

const toNum = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const toDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };

function paymentMethodOf(r) {
    // Explicit hints in the raw shipping-partner label win first
    const sp = (r.shipping_partner || '').toLowerCase();
    if (/prepaid|\bpre[\s_-]?paid\b/.test(sp)) return 'Prepaid';
    if (/\bcod\b|cash on delivery/.test(sp)) return 'COD';
    // A prepaid gateway settled (or is scheduled to settle) against this order
    if (toNum(r.snapmint_settlement_value) !== 0
        || toNum(r.bharatx_ledger_amount) !== 0
        || toNum(r.razorpay_settlement_amount) !== 0) return 'Prepaid';
    if (r.snapmint_settlement_date || r.bharatx_settlement_timestamp || r.razorpay_settlement_date) return 'Prepaid';
    // A courier remitted COD cash against this order
    if (toNum(r.ekart_cod_amount) !== 0 || toNum(r.delhivery_cod_amount) !== 0 || toNum(r.xpressbees_net_payment) !== 0) return 'COD';
    if ((r.reconciliation_status || '').toUpperCase().trim() === 'ADVANCE') return 'Prepaid';
    return 'COD';
}

/**
 * Normalise the free-text `shipping_partner` (raw carrier codes like
 * "DELHIVERY_FLO_HEAVY_SURFACE", "DLV2024_20KG", "E-Kart Logistics",
 * "XPRESSBESS2023", "DTDC2024_20KG(F)", "SELF_SHIPPING", "ATS", "DLV") into a
 * small CFO-friendly set.
 */
function courierOf(r) {
    const raw = (r.shipping_partner || '').trim();
    if (!raw) return 'Unknown';
    const s = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (s.includes('delhivery') || /^dlv/.test(s)) return 'Delhivery';
    if (s.includes('xpressb') || s.includes('busybee') || /^xb/.test(s)) return 'Xpressbees';
    if (s.includes('ekart') || s.includes('instakart')) return 'Ekart';
    if (s.includes('bluedart')) return 'Bluedart';
    if (s.includes('dtdc')) return 'DTDC';
    if (s.includes('selfship') || s.includes('selfshipping')) return 'Self Ship';
    if (s === 'ats') return 'ATS';
    return 'Other';
}

const dispatchDateOf = (r) => toDate(r.dispatch_or_cancellation_date) || toDate(r.date);

const deliveredDateOf = (r) =>
    toDate(r.delhivery_delivery_date) || toDate(r.xpressbees_delivery_date)
    || toDate(r.ekart_actual_remittance_date) || toDate(r.ekart_remittance_date);

const settlementDateOf = (r) =>
    toDate(r.ekart_actual_remittance_date) || toDate(r.ekart_remittance_date)
    || toDate(r.delhivery_delivery_date) || toDate(r.xpressbees_transaction_date) || toDate(r.xpressbees_delivery_date)
    || toDate(r.snapmint_settlement_date) || toDate(r.bharatx_settlement_timestamp) || toDate(r.razorpay_settlement_date);

function gatewayOf(r) {
    if (toNum(r.snapmint_settlement_value) !== 0) return 'Snapmint';
    if (toNum(r.bharatx_ledger_amount) !== 0) return 'BharatX';
    if (toNum(r.razorpay_settlement_amount) !== 0) return 'Razorpay';
    return null;
}

/**
 * Normalise the free-text `platform` (raw channel codes like "SHOPIFY",
 * "FLIPKART_Gurgaon", "AMZ_FLEX_API_XGN0_Mumbai…", "AMAZON_IN_API",
 * "ZEPTO_RETAIL", "CRED_BANGALORE", "Custom-RTO_&_Redispatch", "Influencers")
 * into a small channel set for the Shopify / Marketplaces sections.
 */
function channelOf(r) {
    const raw = (r.platform || '').trim();
    if (!raw) return 'Unknown';
    const s = raw.toLowerCase();
    if (s.includes('shopify')) return 'Shopify';
    if (s.includes('amazon') || s.includes('amz') || s.startsWith('flex_') || s.includes('_flex_')) return 'Amazon';
    if (s.includes('flipkart')) return 'Flipkart';
    if (s.includes('zepto')) return 'Zepto';
    if (s.includes('blinkit')) return 'Blinkit';
    if (s.includes('cred')) return 'Cred';
    if (s.includes('pepperfry')) return 'Pepperfry';
    if (s.includes('woodenstreet') || s.includes('wooden street')) return 'Woodenstreet';
    if (s.includes('snapmint')) return 'Snapmint';
    if (s.includes('influencer')) return 'Influencers';
    if (s.startsWith('custom') || s.includes('redispatch') || s.includes('re-dispatch')
        || s.includes('complementary') || s.includes('lapse') || s.includes('repair')
        || s.includes('modification') || s.includes('b2b')) return 'Custom / Adjustments';
    return 'Other';
}

/** `Shopify` section = the Shopify channel only; `Marketplaces` = everything else. */
function inSection(r, section) {
    const ch = channelOf(r);
    if (section === 'shopify') return ch === 'Shopify';
    if (section === 'marketplaces') return ch !== 'Shopify';
    return true;
}

/** P&L / recovery facts for one order (channel-agnostic, evaluated as of `rangeEnd`). */
function pnlFactsOf(r, rangeEnd) {
    const status = (r.reconciliation_status || '').toUpperCase().trim();
    const ds = (r.delivery_status || '').toUpperCase().trim();
    const gross = toNum(r.total_amount);
    const ret = toNum(r.return_amount);
    const net = toNum(r.net_amount) || (gross - ret);
    const settled = toNum(r.total_settlement_received);
    const balance = toNum(r.balance_amount_receivable);
    const dispatchDate = dispatchDateOf(r);

    const isCancelled = ds === 'CANCELLED' || status === 'CANCELLED';
    const isReturned = ret > 0 || !!toDate(r.return_date);
    const isReconciled = status === 'RECONCILED' || (balance === 0 && settled > 0);
    const isAdvance = status === 'ADVANCE';
    // Refund owed back to the customer: order was returned AND we had already
    // taken the money (dispatched/settled or prepaid-collected) before it came back.
    const isPayable = isReturned && (isReconciled || isAdvance || settled > 0);
    const isReceivable = !isCancelled && balance > 0 && !isAdvance;

    return {
        dispatchDate,
        gross, ret, net, settled,
        balancePos: Math.max(0, balance),
        overpaid: Math.max(0, -balance),
        isCancelled, isReturned, isReconciled, isAdvance, isPayable, isReceivable,
        advanceAmount: isAdvance ? gross : 0,
        payableAmount: isPayable ? ret : 0,
        cancelledAmount: isCancelled ? gross : 0,
    };
}

/** Independent, non-exclusive facts about one order, evaluated as of `rangeEnd`. */
function factsOf(r, rangeEnd) {
    const ds = (r.delivery_status || '').toUpperCase().trim();
    const status = (r.reconciliation_status || '').toUpperCase().trim();
    const dispatchDate = dispatchDateOf(r);
    const delDate = deliveredDateOf(r);
    const setDate = settlementDateOf(r);

    const isCancelled = ds === 'CANCELLED' || status === 'CANCELLED';
    const isRTO = ds === 'RTO' || status === 'RTO';
    const dispatched = !!dispatchDate && !isCancelled;
    const deliveredAsOf = !isRTO && !isCancelled && (ds === 'DELIVERED' || (delDate && delDate <= rangeEnd));
    const notDelivered = dispatched && !isRTO && !isCancelled && !deliveredAsOf;

    const settledAsOf = !isCancelled && (status === 'RECONCILED'
        || (toNum(r.balance_amount_receivable) === 0 && toNum(r.total_settlement_received) > 0));
    const unsettled = dispatched && !isCancelled && !settledAsOf;

    return {
        dispatchDate, delDate, setDate,
        isCancelled, isRTO, dispatched,
        delivered: deliveredAsOf, notDelivered,
        settled: settledAsOf, unsettled,
        grossAmount: toNum(r.total_amount),
        netAmount: toNum(r.net_amount),
        settlementAmount: toNum(r.total_settlement_received),
        pendingAmount: Math.max(0, toNum(r.balance_amount_receivable)),
    };
}

// ─── Aging buckets ───────────────────────────────────────────────────────────

const EXACT_BUCKETS = ['0D', '1D', '2D', '3D', '4D', '5D', '6-8D', '9-12D', '13-18D', '19+D'];
const RANGE_BUCKETS = ['0-2D', '3-5D', '6-8D', '9-12D', '13-18D', '19+D'];
const DAY_MS = 86400000;

const dayDiff = (a, b) => Math.floor((b.getTime() - a.getTime()) / DAY_MS);

function exactBucket(d) {
    if (d < 0) d = 0;
    if (d <= 5) return `${d}D`;
    if (d <= 8) return '6-8D';
    if (d <= 12) return '9-12D';
    if (d <= 18) return '13-18D';
    return '19+D';
}
function rangeBucket(d) {
    if (d < 0) d = 0;
    if (d <= 2) return '0-2D';
    if (d <= 5) return '3-5D';
    if (d <= 8) return '6-8D';
    if (d <= 12) return '9-12D';
    if (d <= 18) return '13-18D';
    return '19+D';
}

// ─── Period helpers ──────────────────────────────────────────────────────────

function monthKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthsBetween(from, to) {
    const out = [];
    const d = new Date(from.getFullYear(), from.getMonth(), 1);
    const end = new Date(to.getFullYear(), to.getMonth(), 1);
    while (d <= end) {
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        d.setMonth(d.getMonth() + 1);
    }
    return out;
}
const pad2 = (n) => String(n).padStart(2, '0');
/** Window covering whole calendar months [fy-fm .. ty-tm], as local Date bounds + YYYY-MM-DD echo strings. */
function makeWindow(fy, fm, ty, tm) {
    const from = new Date(fy, fm - 1, 1, 0, 0, 0, 0);
    const to = new Date(ty, tm, 0, 23, 59, 59, 999); // day 0 of next month = last day of `tm`
    return {
        from, to,
        fromStr: `${fy}-${pad2(fm)}-01`,
        toStr: `${ty}-${pad2(tm)}-${pad2(to.getDate())}`,
    };
}
function windowFrom(q, prefix) {
    // prefix '' → fromMonth/fromYear/toMonth/toYear ; prefix 'cmp' → cmpFromMonth/…
    const k = (base) => (prefix ? `${prefix}${base[0].toUpperCase()}${base.slice(1)}` : base);
    const fm = parseInt(q[k('fromMonth')]);
    const fy = parseInt(q[k('fromYear')]);
    const tm = parseInt(q[k('toMonth')]);
    const ty = parseInt(q[k('toYear')]);
    if (!fm || !fy || !tm || !ty) return null;
    return makeWindow(fy, fm, ty, tm);
}

// ─── Metric aggregation ──────────────────────────────────────────────────────

const METRIC_KEYS = [
    'totalOrders', 'dispatched', 'delivered', 'notDelivered', 'rto', 'cancelled',
    'settledOrders', 'unsettledOrders',
    'grossAmount', 'netAmount', 'settlementAmount', 'pendingAmount',
];

const zeroMetrics = () => METRIC_KEYS.reduce((o, k) => (o[k] = 0, o), {});

function addFacts(acc, f) {
    acc.totalOrders += 1;
    if (f.dispatched) acc.dispatched += 1;
    if (f.delivered) acc.delivered += 1;
    if (f.notDelivered) acc.notDelivered += 1;
    if (f.isRTO) acc.rto += 1;
    if (f.isCancelled) acc.cancelled += 1;
    if (f.settled) acc.settledOrders += 1;
    if (f.unsettled) acc.unsettledOrders += 1;
    acc.grossAmount += f.grossAmount;
    acc.netAmount += f.netAmount;
    acc.settlementAmount += f.settlementAmount;
    acc.pendingAmount += f.pendingAmount;
}

/** Derived ratio metrics, computed after summation. */
function withRatios(m) {
    const base = m.dispatched || 0;
    const settleBase = (m.totalOrders - m.cancelled) || 0;
    return {
        ...m,
        deliveredPct: base ? Math.round((m.delivered / base) * 1000) / 10 : 0,
        rtoPct: base ? Math.round((m.rto / base) * 1000) / 10 : 0,
        notDeliveredPct: base ? Math.round((m.notDelivered / base) * 1000) / 10 : 0,
        settledPct: settleBase ? Math.round((m.settledOrders / settleBase) * 1000) / 10 : 0,
    };
}

function round2(m) {
    const o = { ...m };
    for (const k of ['grossAmount', 'netAmount', 'settlementAmount', 'pendingAmount']) {
        if (o[k] != null) o[k] = Math.round(o[k] * 100) / 100;
    }
    return o;
}

// ─── Shared loader ───────────────────────────────────────────────────────────

async function loadRows(brandId, agentId) {
    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent) return { error: 'Brand or Agent not found' };

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const Model = getDynamicModel(brandDb, tableName, agent.columns);
    await Model.sync();
    const rows = await Model.findAll({ raw: true });
    return { rows };
}

function availableRangeOf(rows) {
    const ds = rows.map(dispatchDateOf).filter(Boolean);
    if (!ds.length) return { from: null, to: null };
    return {
        from: new Date(Math.min(...ds.map(d => d.getTime()))).toISOString().slice(0, 10),
        to: new Date(Math.max(...ds.map(d => d.getTime()))).toISOString().slice(0, 10),
    };
}

function inWindow(r, win) {
    const d = dispatchDateOf(r);
    return !!d && d >= win.from && d <= win.to;
}

function passesPaymentFilter(r, pm) {
    if (!pm || pm === 'all') return true;
    return paymentMethodOf(r) === pm;
}

// ─── GET /shopify-dashboard/operations ───────────────────────────────────────

const getOperationsData = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const subtab = req.query.subtab === 'settlements' ? 'settlements' : 'delivery';
        const pmFilter = req.query.paymentMethod || 'all';

        const { rows, error } = await loadRows(brandId, agentId);
        if (error) return res.status(404).json({ error });

        const availableRange = availableRangeOf(rows);
        if (!availableRange.from) {
            return res.json({ availableRange, months: [], subtab, groups: [], totalsRow: null });
        }

        // Default (no period params): the full span of months the data covers.
        const af = availableRange.from.split('-').map(Number);
        const at = availableRange.to.split('-').map(Number);
        const cur = windowFrom(req.query, '') || makeWindow(af[0], af[1], at[0], at[1]);
        const cmp = windowFrom(req.query, 'cmp');

        const months = monthsBetween(cur.from, cur.to);

        // group key → { courier, paymentMethod, metrics, monthly:{month:metrics}, aging }
        const groups = new Map();
        const ensure = (courier, pm) => {
            const key = `${courier}||${pm}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    courier, paymentMethod: pm,
                    metrics: zeroMetrics(),
                    monthly: months.reduce((o, mth) => (o[mth] = zeroMetrics(), o), {}),
                    comparison: cmp ? zeroMetrics() : null,
                    aging: subtab === 'settlements'
                        ? { settled: bucketObj(EXACT_BUCKETS), unsettled: bucketObj(RANGE_BUCKETS) }
                        : { delivered: bucketObj(EXACT_BUCKETS), notDelivered: bucketObj(RANGE_BUCKETS) },
                });
            }
            return groups.get(key);
        };

        for (const r of rows) {
            if (!passesPaymentFilter(r, pmFilter)) continue;
            const courier = courierOf(r);
            const pm = paymentMethodOf(r);

            if (inWindow(r, cur)) {
                const f = factsOf(r, cur.to);
                const g = ensure(courier, pm);
                addFacts(g.metrics, f);
                const mk = monthKey(f.dispatchDate);
                if (g.monthly[mk]) addFacts(g.monthly[mk], f);

                // aging
                if (subtab === 'delivery') {
                    if (f.delivered && f.delDate && f.dispatchDate && f.delDate <= cur.to) {
                        g.aging.delivered[exactBucket(dayDiff(f.dispatchDate, f.delDate))] += 1;
                    }
                    if (f.notDelivered && f.dispatchDate) {
                        g.aging.notDelivered[rangeBucket(dayDiff(f.dispatchDate, cur.to))] += 1;
                    }
                } else {
                    if (f.settled && f.setDate && f.dispatchDate && f.setDate <= cur.to) {
                        g.aging.settled[exactBucket(dayDiff(f.dispatchDate, f.setDate))] += 1;
                    }
                    if (f.unsettled && f.dispatchDate) {
                        g.aging.unsettled[rangeBucket(dayDiff(f.dispatchDate, cur.to))] += 1;
                    }
                }
            }

            if (cmp && inWindow(r, cmp)) {
                const f = factsOf(r, cmp.to);
                const g = ensure(courier, pm);
                addFacts(g.comparison, f);
            }
        }

        // finalise
        const totalsCur = zeroMetrics();
        const totalsCmp = cmp ? zeroMetrics() : null;
        const groupList = [...groups.values()]
            .sort((a, b) => (b.metrics.totalOrders - a.metrics.totalOrders))
            .map(g => {
                for (const k of METRIC_KEYS) {
                    totalsCur[k] += g.metrics[k];
                    if (totalsCmp) totalsCmp[k] += g.comparison[k];
                }
                return {
                    courier: g.courier,
                    paymentMethod: g.paymentMethod,
                    metrics: round2(withRatios(g.metrics)),
                    monthly: Object.fromEntries(months.map(m => [m, round2(withRatios(g.monthly[m]))])),
                    comparison: g.comparison ? round2(withRatios(g.comparison)) : null,
                    aging: g.aging,
                };
            });

        res.json({
            availableRange,
            subtab,
            paymentMethod: pmFilter,
            months,
            currentRange: { from: cur.fromStr, to: cur.toStr },
            comparisonRange: cmp ? { from: cmp.fromStr, to: cmp.toStr } : null,
            groups: groupList,
            totalsRow: {
                metrics: round2(withRatios(totalsCur)),
                comparison: totalsCmp ? round2(withRatios(totalsCmp)) : null,
            },
        });
    } catch (error) {
        console.error('[ShopifyDashboard] getOperationsData Error:', error);
        next(error);
    }
};

function bucketObj(keys) { return keys.reduce((o, k) => (o[k] = 0, o), {}); }

// ─── Transaction filtering (shared by transactions + download) ───────────────

/**
 * metric ∈ totalOrders|dispatched|delivered|notDelivered|rto|cancelled|settled|unsettled
 * agingOf ∈ delivered|notDelivered|settled|unsettled  (+ bucket) — optional aging cell drill
 */
function matchesMetric(f, metric) {
    switch (metric) {
        case 'dispatched': return f.dispatched;
        case 'delivered': return f.delivered;
        case 'notDelivered': return f.notDelivered;
        case 'rto': return f.isRTO;
        case 'cancelled': return f.isCancelled;
        case 'settled': return f.settled;
        case 'unsettled': return f.unsettled;
        case 'totalOrders':
        default: return true;
    }
}

function agingCellOf(f, agingOf) {
    if (agingOf === 'delivered') {
        if (!(f.delivered && f.delDate && f.dispatchDate)) return null;
        return exactBucket(dayDiff(f.dispatchDate, f.delDate));
    }
    if (agingOf === 'settled') {
        if (!(f.settled && f.setDate && f.dispatchDate)) return null;
        return exactBucket(dayDiff(f.dispatchDate, f.setDate));
    }
    if (agingOf === 'notDelivered') {
        if (!(f.notDelivered && f.dispatchDate)) return null;
        return rangeBucket(dayDiff(f.dispatchDate, f.rangeEnd));
    }
    if (agingOf === 'unsettled') {
        if (!(f.unsettled && f.dispatchDate)) return null;
        return rangeBucket(dayDiff(f.dispatchDate, f.rangeEnd));
    }
    return null;
}

function filterTransactionRows(rows, opts) {
    const { win, paymentMethod, courier, month, metric, agingOf, bucket, search } = opts;
    const q = (search || '').toLowerCase().trim();
    const out = [];
    for (const r of rows) {
        if (!inWindow(r, win)) continue;
        if (!passesPaymentFilter(r, paymentMethod)) continue;
        if (courier && courier !== 'all' && courierOf(r) !== courier) continue;
        if (paymentMethod && paymentMethod !== 'all' && paymentMethodOf(r) !== paymentMethod) continue;

        const f = factsOf(r, win.to);
        f.rangeEnd = win.to;

        if (month && monthKey(f.dispatchDate) !== month) continue;

        if (agingOf) {
            const cell = agingCellOf(f, agingOf);
            if (cell == null) continue;
            if (bucket && cell !== bucket) continue;
        } else if (!matchesMetric(f, metric || 'totalOrders')) {
            continue;
        }

        if (q) {
            const hay = `${r.sale_order_number || ''} ${r.invoice_number || ''} ${r.awb_number || ''}`.toLowerCase();
            if (!hay.includes(q)) continue;
        }
        out.push(r);
    }
    return out;
}

/** Self-contained scenario for the drill-down expander (no receivable_ledger dependency). */
function miniScenario(r) {
    const pm = paymentMethodOf(r);
    const ds = (r.delivery_status || '').toUpperCase().trim();
    const returned = !!toDate(r.return_date);
    let bucket = 'PENDING';
    let holder = null;
    if (ds === 'DELIVERED') bucket = 'FULFILLED';
    else if (ds === 'CANCELLED' || ds === 'RTO') { bucket = 'CANCELLED'; holder = returned ? 'Customer' : 'Delivery Partner'; }
    const gw = gatewayOf(r);
    const settledSource = gw
        || (toNum(r.ekart_cod_amount) ? 'Ekart'
            : toNum(r.delhivery_cod_amount) ? 'Delhivery'
                : toNum(r.xpressbees_net_payment) ? 'Xpressbees' : null);
    return {
        bucket,
        holder,
        courier: courierOf(r),
        paymentMethod: pm.toUpperCase(),
        srnStatus: r.srn ? 'Generated' : 'Missing',
        settledSource,
        settledAmount: toNum(r.total_settlement_received),
        refundDue: (bucket === 'CANCELLED' && pm === 'Prepaid') ? toNum(r.total_amount) : 0,
    };
}

const TX_OMIT = new Set(['year', 'month', 'filename', 'file_type', 'inventory_type', 'created_at']);
function toTxRow(r) {
    const out = {};
    for (const k of Object.keys(r)) if (!TX_OMIT.has(k)) out[k] = r[k];
    out.payment_method = paymentMethodOf(r);
    out.courier_group = courierOf(r);
    out.channel_group = channelOf(r);
    out.scenario = miniScenario(r);
    return out;
}

// ═══ Shopify / Marketplaces — P&L + Recovery ═════════════════════════════════

const PNL_METRIC_KEYS = [
    'orders', 'grossSales', 'returns', 'netSales', 'settledAmount',
    'receivableAmount', 'overpaidAmount',
    'cancelledOrders', 'cancelledAmount', 'returnedOrders',
    'advanceOrders', 'advanceAmount', 'payableOrders', 'payableAmount',
];
const zeroPnl = () => PNL_METRIC_KEYS.reduce((o, k) => (o[k] = 0, o), {});

function addPnl(acc, f) {
    acc.orders += 1;
    acc.grossSales += f.gross;
    acc.returns += f.ret;
    acc.netSales += f.net;
    acc.settledAmount += f.settled;
    acc.receivableAmount += f.isReceivable ? f.balancePos : 0;
    acc.overpaidAmount += f.overpaid;
    if (f.isCancelled) { acc.cancelledOrders += 1; acc.cancelledAmount += f.gross; }
    if (f.isReturned) acc.returnedOrders += 1;
    if (f.isAdvance) { acc.advanceOrders += 1; acc.advanceAmount += f.advanceAmount; }
    if (f.isPayable) { acc.payableOrders += 1; acc.payableAmount += f.payableAmount; }
}

function withPnlRatios(m) {
    return {
        ...m,
        returnPct: m.grossSales ? Math.round((m.returns / m.grossSales) * 1000) / 10 : 0,
        aov: m.orders ? Math.round((m.grossSales / m.orders) * 100) / 100 : 0,
        settledPct: m.netSales ? Math.round((m.settledAmount / m.netSales) * 1000) / 10 : 0,
        recoveryGapPct: m.netSales ? Math.round((m.receivableAmount / m.netSales) * 1000) / 10 : 0,
    };
}
function round2Pnl(m) {
    const o = { ...m };
    for (const k of ['grossSales', 'returns', 'netSales', 'settledAmount', 'receivableAmount',
        'overpaidAmount', 'cancelledAmount', 'advanceAmount', 'payableAmount', 'aov']) {
        if (o[k] != null) o[k] = Math.round(o[k] * 100) / 100;
    }
    return o;
}

/** Which population a P&L drill cell maps to. */
function matchesPnlMetric(f, metric) {
    switch (metric) {
        case 'cancelledOrders': case 'cancelledAmount': return f.isCancelled;
        case 'returnedOrders': case 'returns': return f.isReturned;
        case 'advanceOrders': case 'advanceAmount': return f.isAdvance;
        case 'payableOrders': case 'payableAmount': return f.isPayable;
        case 'receivableAmount': return f.isReceivable;
        case 'settledAmount': return f.settled > 0;
        case 'overpaidAmount': return f.overpaid > 0;
        default: return true; // orders / grossSales / netSales → every order in the group
    }
}

function filterPnlRows(rows, opts) {
    const { section, win, channel, paymentMethod, month, metric, search } = opts;
    const q = (search || '').toLowerCase().trim();
    const out = [];
    for (const r of rows) {
        if (!inSection(r, section)) continue;
        if (!inWindow(r, win)) continue;
        if (channel && channel !== 'all' && channelOf(r) !== channel) continue;
        if (paymentMethod && paymentMethod !== 'all' && paymentMethodOf(r) !== paymentMethod) continue;
        const f = pnlFactsOf(r, win.to);
        if (month && (!f.dispatchDate || monthKey(f.dispatchDate) !== month)) continue;
        if (!matchesPnlMetric(f, metric || 'orders')) continue;
        if (q) {
            const hay = `${r.sale_order_number || ''} ${r.invoice_number || ''} ${r.awb_number || ''} ${r.platform || ''}`.toLowerCase();
            if (!hay.includes(q)) continue;
        }
        out.push(r);
    }
    return out;
}

// ─── GET /shopify-dashboard/:section  (section = shopify | marketplaces) ──────

async function getPnlData(req, res, next) {
    try {
        const { brandId, agentId } = req.params;
        const section = req.pnlSection; // injected by the route wrapper
        const pmFilter = req.query.paymentMethod || 'all';

        const { rows, error } = await loadRows(brandId, agentId);
        if (error) return res.status(404).json({ error });

        const sectionRows = rows.filter(r => inSection(r, section));
        const availableRange = availableRangeOf(sectionRows);
        if (!availableRange.from) {
            return res.json({ availableRange, months: [], section, groups: [], totalsRow: null });
        }
        const af = availableRange.from.split('-').map(Number);
        const at = availableRange.to.split('-').map(Number);
        const cur = windowFrom(req.query, '') || makeWindow(af[0], af[1], at[0], at[1]);
        const cmp = windowFrom(req.query, 'cmp');
        const months = monthsBetween(cur.from, cur.to);

        // group key = the section's grouping dimension
        // shopify → payment method ; marketplaces → channel
        const groupOf = (r) => (section === 'marketplaces' ? channelOf(r) : paymentMethodOf(r));
        const groups = new Map();
        const ensure = (name) => {
            if (!groups.has(name)) {
                groups.set(name, {
                    group: name,
                    metrics: zeroPnl(),
                    monthly: months.reduce((o, m) => (o[m] = zeroPnl(), o), {}),
                    comparison: cmp ? zeroPnl() : null,
                });
            }
            return groups.get(name);
        };

        for (const r of sectionRows) {
            if (pmFilter !== 'all' && paymentMethodOf(r) !== pmFilter) continue;
            if (inWindow(r, cur)) {
                const f = pnlFactsOf(r, cur.to);
                const g = ensure(groupOf(r));
                addPnl(g.metrics, f);
                if (f.dispatchDate && g.monthly[monthKey(f.dispatchDate)]) addPnl(g.monthly[monthKey(f.dispatchDate)], f);
            }
            if (cmp && inWindow(r, cmp)) {
                const f = pnlFactsOf(r, cmp.to);
                addPnl(ensure(groupOf(r)).comparison, f);
            }
        }

        const totalsCur = zeroPnl();
        const totalsCmp = cmp ? zeroPnl() : null;
        const groupList = [...groups.values()]
            .sort((a, b) => b.metrics.grossSales - a.metrics.grossSales)
            .map(g => {
                for (const k of PNL_METRIC_KEYS) {
                    totalsCur[k] += g.metrics[k];
                    if (totalsCmp) totalsCmp[k] += g.comparison[k];
                }
                return {
                    group: g.group,
                    metrics: round2Pnl(withPnlRatios(g.metrics)),
                    monthly: Object.fromEntries(months.map(m => [m, round2Pnl(withPnlRatios(g.monthly[m]))])),
                    comparison: g.comparison ? round2Pnl(withPnlRatios(g.comparison)) : null,
                };
            });

        res.json({
            availableRange,
            section,
            paymentMethod: pmFilter,
            months,
            currentRange: { from: cur.fromStr, to: cur.toStr },
            comparisonRange: cmp ? { from: cmp.fromStr, to: cmp.toStr } : null,
            groups: groupList,
            totalsRow: {
                metrics: round2Pnl(withPnlRatios(totalsCur)),
                comparison: totalsCmp ? round2Pnl(withPnlRatios(totalsCmp)) : null,
            },
        });
    } catch (error) {
        console.error('[ShopifyDashboard] getPnlData Error:', error);
        next(error);
    }
}

async function getPnlTransactions(req, res, next) {
    try {
        const { brandId, agentId } = req.params;
        const section = req.pnlSection;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize) || 50));

        const { rows, error } = await loadRows(brandId, agentId);
        if (error) return res.status(404).json({ error });
        const win = windowFrom(req.query, '');
        if (!win) return res.status(400).json({ error: 'period (fromMonth/fromYear/toMonth/toYear) is required' });

        const filtered = filterPnlRows(rows, {
            section, win,
            channel: req.query.channel || 'all',
            paymentMethod: req.query.paymentMethod || 'all',
            month: req.query.month || null,
            metric: req.query.metric || 'orders',
            search: req.query.search || '',
        });
        filtered.sort((a, b) => {
            const da = dispatchDateOf(a), db = dispatchDateOf(b);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });
        const total = filtered.length;
        const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize).map(toTxRow);
        res.json({ rows: pageRows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    } catch (error) {
        console.error('[ShopifyDashboard] getPnlTransactions Error:', error);
        next(error);
    }
}

async function downloadPnl(req, res, next) {
    try {
        const { brandId, agentId } = req.params;
        const section = req.pnlSection;
        const pmFilter = req.query.paymentMethod || 'all';

        const { rows, error } = await loadRows(brandId, agentId);
        if (error) return res.status(404).json({ error });
        const sectionRows = rows.filter(r => inSection(r, section));
        const availableRange = availableRangeOf(sectionRows);
        let cur = windowFrom(req.query, '');
        if (!cur) {
            const af = (availableRange.from || '2024-01-01').split('-').map(Number);
            const at = (availableRange.to || '2024-12-31').split('-').map(Number);
            cur = makeWindow(af[0], af[1], at[0], at[1]);
        }
        const groupOf = (r) => (section === 'marketplaces' ? channelOf(r) : paymentMethodOf(r));
        const groups = new Map();
        for (const r of sectionRows) {
            if (pmFilter !== 'all' && paymentMethodOf(r) !== pmFilter) continue;
            if (!inWindow(r, cur)) continue;
            const key = groupOf(r);
            if (!groups.has(key)) groups.set(key, zeroPnl());
            addPnl(groups.get(key), pnlFactsOf(r, cur.to));
        }
        const workbook = new ExcelJS.Workbook();
        const cols = [
            { header: section === 'marketplaces' ? 'Channel' : 'Payment Method', key: 'g', width: 20 },
            { header: 'Orders', key: 'orders', width: 12 },
            { header: 'Gross Sales', key: 'grossSales', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Returns', key: 'returns', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Net Sales', key: 'netSales', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Return %', key: 'returnPct', width: 10 },
            { header: 'AOV', key: 'aov', width: 12, style: { numFmt: '#,##0.00' } },
            { header: 'Settled Amount', key: 'settledAmount', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Receivable', key: 'receivableAmount', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Cancelled Orders', key: 'cancelledOrders', width: 14 },
            { header: 'Cancelled Amount', key: 'cancelledAmount', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Advance Orders', key: 'advanceOrders', width: 14 },
            { header: 'Advance Amount', key: 'advanceAmount', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Payable Orders', key: 'payableOrders', width: 14 },
            { header: 'Payable Amount', key: 'payableAmount', width: 16, style: { numFmt: '#,##0.00' } },
        ];
        const sheet = workbook.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF3B82F6' } } });
        sheet.columns = cols;
        const hr = sheet.getRow(1); hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
        for (const [g, m] of groups) sheet.addRow({ g, ...round2Pnl(withPnlRatios(m)) });

        const txRows = filterPnlRows(rows, {
            section, win: cur,
            channel: req.query.channel || 'all',
            paymentMethod: pmFilter,
            month: req.query.month || null,
            metric: req.query.metric || 'orders',
            search: req.query.search || '',
        });
        const txCols = [
            { header: 'Order ID', key: 'orderId', width: 20 },
            { header: 'Invoice No.', key: 'invoiceNo', width: 20 },
            { header: 'Channel', key: 'channel', width: 16 },
            { header: 'Payment', key: 'pm', width: 12 },
            { header: 'Gross', key: 'gross', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Return', key: 'ret', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Net', key: 'net', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Settled', key: 'settled', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Balance', key: 'balance', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Order Date', key: 'orderDate', width: 14, style: { numFmt: 'dd-mmm-yyyy' } },
            { header: 'Reco Status', key: 'reco', width: 18 },
        ];
        const txSheet = workbook.addWorksheet('Transactions', { properties: { tabColor: { argb: 'FF10B981' } } });
        txSheet.columns = txCols;
        const hr2 = txSheet.getRow(1); hr2.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
        for (const r of txRows) txSheet.addRow({
            orderId: r.sale_order_number || '', invoiceNo: r.invoice_number || '',
            channel: channelOf(r), pm: paymentMethodOf(r),
            gross: toNum(r.total_amount), ret: toNum(r.return_amount), net: toNum(r.net_amount),
            settled: toNum(r.total_settlement_received), balance: toNum(r.balance_amount_receivable),
            orderDate: dispatchDateOf(r), reco: r.reconciliation_status || '',
        });

        res.setHeader('Content-Disposition', `attachment; filename="shopify_dashboard_${section}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('[ShopifyDashboard] downloadPnl Error:', error);
        next(error);
    }
}

const withSection = (section, handler) => (req, res, next) => { req.pnlSection = section; return handler(req, res, next); };

// ─── GET /shopify-dashboard/operations/transactions ──────────────────────────

const getOperationsTransactions = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize) || 50));

        const { rows, error } = await loadRows(brandId, agentId);
        if (error) return res.status(404).json({ error });

        const win = windowFrom(req.query, '');
        if (!win) return res.status(400).json({ error: 'period (fromMonth/fromYear/toMonth/toYear) is required' });

        const filtered = filterTransactionRows(rows, {
            win,
            paymentMethod: req.query.paymentMethod || 'all',
            courier: req.query.courier || 'all',
            month: req.query.month || null,
            metric: req.query.metric || 'totalOrders',
            agingOf: req.query.agingOf || null,
            bucket: req.query.bucket || null,
            search: req.query.search || '',
        });

        filtered.sort((a, b) => {
            const da = dispatchDateOf(a), db = dispatchDateOf(b);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });

        const total = filtered.length;
        const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize).map(toTxRow);

        res.json({ rows: pageRows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    } catch (error) {
        console.error('[ShopifyDashboard] getOperationsTransactions Error:', error);
        next(error);
    }
};

// ─── GET /shopify-dashboard/operations/download ──────────────────────────────

function addSheet(workbook, name, tabColor, columns, rows) {
    const sheet = workbook.addWorksheet(name, { properties: { tabColor: { argb: `FF${tabColor}` } } });
    sheet.columns = columns;
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    for (const r of rows) sheet.addRow(r);
    return sheet;
}

const downloadOperations = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const subtab = req.query.subtab === 'settlements' ? 'settlements' : 'delivery';
        const pmFilter = req.query.paymentMethod || 'all';

        const { rows, error } = await loadRows(brandId, agentId);
        if (error) return res.status(404).json({ error });

        const availableRange = availableRangeOf(rows);
        let cur = windowFrom(req.query, '');
        if (!cur) {
            const af = (availableRange.from || '2024-01-01').split('-').map(Number);
            const at = (availableRange.to || '2024-12-31').split('-').map(Number);
            cur = makeWindow(af[0], af[1], at[0], at[1]);
        }

        // Aggregate per courier × payment
        const groups = new Map();
        for (const r of rows) {
            if (!passesPaymentFilter(r, pmFilter)) continue;
            if (!inWindow(r, cur)) continue;
            const key = `${courierOf(r)}||${paymentMethodOf(r)}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    courier: courierOf(r), paymentMethod: paymentMethodOf(r),
                    metrics: zeroMetrics(),
                    aging: subtab === 'settlements'
                        ? { a: bucketObj(EXACT_BUCKETS), b: bucketObj(RANGE_BUCKETS) }
                        : { a: bucketObj(EXACT_BUCKETS), b: bucketObj(RANGE_BUCKETS) },
                });
            }
            const g = groups.get(key);
            const f = factsOf(r, cur.to);
            addFacts(g.metrics, f);
            if (subtab === 'delivery') {
                if (f.delivered && f.delDate && f.dispatchDate && f.delDate <= cur.to) g.aging.a[exactBucket(dayDiff(f.dispatchDate, f.delDate))] += 1;
                if (f.notDelivered && f.dispatchDate) g.aging.b[rangeBucket(dayDiff(f.dispatchDate, cur.to))] += 1;
            } else {
                if (f.settled && f.setDate && f.dispatchDate && f.setDate <= cur.to) g.aging.a[exactBucket(dayDiff(f.dispatchDate, f.setDate))] += 1;
                if (f.unsettled && f.dispatchDate) g.aging.b[rangeBucket(dayDiff(f.dispatchDate, cur.to))] += 1;
            }
        }

        const workbook = new ExcelJS.Workbook();

        const summaryCols = [
            { header: 'Courier', key: 'courier', width: 16 },
            { header: 'Payment', key: 'pm', width: 12 },
            { header: 'Total Orders', key: 'totalOrders', width: 14 },
            { header: 'Dispatched', key: 'dispatched', width: 12 },
            { header: 'Delivered', key: 'delivered', width: 12 },
            { header: 'Not Delivered', key: 'notDelivered', width: 14 },
            { header: 'RTO', key: 'rto', width: 10 },
            { header: 'Cancelled', key: 'cancelled', width: 12 },
            { header: 'Settled', key: 'settledOrders', width: 12 },
            { header: 'Unsettled', key: 'unsettledOrders', width: 12 },
            { header: 'Delivered %', key: 'deliveredPct', width: 12 },
            { header: 'Settled %', key: 'settledPct', width: 12 },
            { header: 'Gross Amount', key: 'grossAmount', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Net Amount', key: 'netAmount', width: 16, style: { numFmt: '#,##0.00' } },
            { header: 'Settlement Amount', key: 'settlementAmount', width: 18, style: { numFmt: '#,##0.00' } },
            { header: 'Pending Amount', key: 'pendingAmount', width: 16, style: { numFmt: '#,##0.00' } },
        ];
        const summaryRows = [...groups.values()].map(g => {
            const m = round2(withRatios(g.metrics));
            return { courier: g.courier, pm: g.paymentMethod, ...m };
        });
        addSheet(workbook, 'Summary', '3B82F6', summaryCols, summaryRows);

        const exactCols = subtab === 'settlements' ? 'Settled' : 'Delivered';
        const rangeCols = subtab === 'settlements' ? 'Unsettled' : 'Not Delivered';
        const agingCols = [
            { header: 'Courier', key: 'courier', width: 16 },
            { header: 'Payment', key: 'pm', width: 12 },
            ...EXACT_BUCKETS.map(b => ({ header: `${exactCols} ${b}`, key: `a_${b}`, width: 12 })),
            ...RANGE_BUCKETS.map(b => ({ header: `${rangeCols} ${b}`, key: `b_${b}`, width: 14 })),
        ];
        const agingRows = [...groups.values()].map(g => {
            const row = { courier: g.courier, pm: g.paymentMethod };
            EXACT_BUCKETS.forEach(b => { row[`a_${b}`] = g.aging.a[b]; });
            RANGE_BUCKETS.forEach(b => { row[`b_${b}`] = g.aging.b[b]; });
            return row;
        });
        addSheet(workbook, 'Aging', 'F59E0B', agingCols, agingRows);

        // Transactions honouring the current filters
        const txWin = windowFrom(req.query, '') || cur;
        const txRows = filterTransactionRows(rows, {
            win: txWin,
            paymentMethod: pmFilter,
            courier: req.query.courier || 'all',
            month: req.query.month || null,
            metric: req.query.metric || 'totalOrders',
            agingOf: req.query.agingOf || null,
            bucket: req.query.bucket || null,
            search: req.query.search || '',
        });
        const txCols = [
            { header: 'Order ID', key: 'orderId', width: 20 },
            { header: 'Invoice No.', key: 'invoiceNo', width: 20 },
            { header: 'AWB', key: 'awb', width: 18 },
            { header: 'Courier', key: 'courier', width: 14 },
            { header: 'Payment', key: 'pm', width: 12 },
            { header: 'Order Value', key: 'orderValue', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Settlement', key: 'settlement', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Balance', key: 'balance', width: 14, style: { numFmt: '#,##0.00' } },
            { header: 'Dispatch Date', key: 'dispatchDate', width: 14, style: { numFmt: 'dd-mmm-yyyy' } },
            { header: 'Delivered/Settled Date', key: 'endDate', width: 18, style: { numFmt: 'dd-mmm-yyyy' } },
            { header: 'Delivery Status', key: 'ds', width: 14 },
            { header: 'Reco Status', key: 'reco', width: 18 },
        ];
        const txSheetRows = txRows.map(r => ({
            orderId: r.sale_order_number || '',
            invoiceNo: r.invoice_number || '',
            awb: r.awb_number || '',
            courier: courierOf(r),
            pm: paymentMethodOf(r),
            orderValue: toNum(r.total_amount),
            settlement: toNum(r.total_settlement_received),
            balance: toNum(r.balance_amount_receivable),
            dispatchDate: dispatchDateOf(r),
            endDate: subtab === 'settlements' ? settlementDateOf(r) : deliveredDateOf(r),
            ds: r.delivery_status || '',
            reco: r.reconciliation_status || '',
        }));
        addSheet(workbook, 'Transactions', '10B981', txCols, txSheetRows);

        const outName = `shopify_dashboard_operations_${subtab}.xlsx`;
        res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('[ShopifyDashboard] downloadOperations Error:', error);
        next(error);
    }
};

module.exports = {
    getOperationsData,
    getOperationsTransactions,
    downloadOperations,
    // Shopify / Marketplaces (P&L + Recovery) — section injected by the route
    shopifyData: withSection('shopify', getPnlData),
    shopifyTransactions: withSection('shopify', getPnlTransactions),
    downloadShopify: withSection('shopify', downloadPnl),
    marketplacesData: withSection('marketplaces', getPnlData),
    marketplacesTransactions: withSection('marketplaces', getPnlTransactions),
    downloadMarketplaces: withSection('marketplaces', downloadPnl),
};
