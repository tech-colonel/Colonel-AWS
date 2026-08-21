import { X } from 'lucide-react';

// Shared by every place on the Advance Amount Dashboard that shows one order's
// details: "Track an order" search results and the "orders with advance
// received" order browser rows. Keeping this in one file means both render an
// order identically.
//
// No lifecycle/stage timeline here (there used to be one) — the Advance Amount
// Dashboard's population is now exactly "gateway amount received, order never
// found in the Sales Order Combined file" (2026-08-19), so there is no dispatch/
// delivery/return date on these rows to build a timeline from in the first
// place. This is a flat detail card instead.

const COLOR_PENDING = '#D97706';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth() + 1]} ${dt.getFullYear()}`;
};
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
const money = (n) => `₹${fmt(n)}`;

const DetailRow = ({ label, value }) => (
  <div className="flex items-center justify-between py-1.5">
    <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span className="text-xs font-semibold" style={{ color: 'var(--text-heading)' }}>{value}</span>
  </div>
);

// One order's detail card — header + the handful of facts this population
// actually carries (gateway, amount, received date, order total, days pending).
export const OrderJourneyCard = ({ order }) => (
  <div className="p-4 rounded-xl" style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
    <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
      <div>
        <p className="text-sm font-black" style={{ color: 'var(--text-heading)' }}>
          Order #{order.sale_order_number}
          {order.invoice_number && <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}> · {order.invoice_number}</span>}
        </p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          AWB {order.awb_number || '—'} · {order.platform || '—'}
        </p>
      </div>
      <span
        className="text-[11px] font-bold px-2.5 py-1 rounded-full flex-shrink-0"
        style={{ background: `${COLOR_PENDING}15`, color: COLOR_PENDING }}
      >
        Advance — not found in Sales Order Combined
      </span>
    </div>
    <div style={{ borderTop: '1px solid var(--card-border)' }} className="mt-2 pt-1">
      <DetailRow label="Gateway" value={order.gateway || '—'} />
      <DetailRow label="Advance received" value={money(order.gateway_amount)} />
      <DetailRow label="Received on" value={fmtDate(order.advance_received_date)} />
      <DetailRow label="Order total" value={money(order.total_amount)} />
      {order.days_pending != null && <DetailRow label="Days pending" value={Number(order.days_pending).toLocaleString('en-IN')} />}
    </div>
  </div>
);

// Single-order popup — used where a caller already has one full order row (e.g.
// clicking a row in the order browser) and just needs to show its details.
export const OrderJourneyModal = ({ order, title, onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.45)' }} onClick={onClose}>
    <div
      className="w-fit min-w-[24rem] max-w-[92vw] rounded-2xl overflow-hidden flex flex-col"
      style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', maxHeight: '88vh' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--card-border)' }}>
        <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
          {title || `Order #${order.sale_order_number}`}
        </h3>
        <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-6 py-4 overflow-y-auto">
        <OrderJourneyCard order={order} />
      </div>
    </div>
  </div>
);
