/* Shopify Receivables — FAKE demo page (no backend). See ReceivablesDemoDashboard. */
import React from 'react';
import ReceivablesDemoDashboard from './ReceivablesDemoDashboard';

const SHOPIFY_CONFIG = {
  marketplace: 'Shopify',
  icon: '🛍️',
  accent: '#5E8E3E',
  gradient: 'linear-gradient(135deg, #5E8E3E, #95BF47)',
  seed: 77770807,
  count: 48,
  terms: {
    marketplace: 'Shopify',
    teamName: 'Shopify Payments Team',
    po: 'Order ID', grn: 'Fulfillment ID', pod: 'Payout ID',
    invPfx: 'SHOP-INV', poPfx: '#10', grnPfx: 'FUL-', podPfx: 'PO-',
  },
  names: [
    'Shopify Store — DTC', 'Online Store Order', 'Shopify Payments', 'Shop Pay Installments',
    'Shopify POS', 'Buy Button Order', 'Shopify Markets', 'Draft Order',
  ],
};

export default function ShopifyReceivablesDashboard() {
  return <ReceivablesDemoDashboard config={SHOPIFY_CONFIG} />;
}
