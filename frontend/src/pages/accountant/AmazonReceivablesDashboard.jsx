/* Amazon Receivables — FAKE demo page (no backend). See ReceivablesDemoDashboard. */
import React from 'react';
import ReceivablesDemoDashboard from './ReceivablesDemoDashboard';

const AMAZON_CONFIG = {
  marketplace: 'Amazon',
  icon: '📦',
  accent: '#FF9900',
  gradient: 'linear-gradient(135deg, #FF9900, #F115F8)',
  seed: 20260807,
  count: 54,
  terms: {
    marketplace: 'Amazon',
    teamName: 'Amazon Seller Support Team',
    po: 'Order ID', grn: 'Shipment ID', pod: 'Settlement ID',
    invPfx: 'AMZ-INV', poPfx: '408-', grnPfx: 'FBA', podPfx: 'STL-',
  },
  names: [
    'Amazon.in — Prime Order', 'Amazon Retail India', 'FBA Fulfilment', 'Amazon Business (B2B)',
    'Amazon.in — SPN', 'Cloudtail India', 'Appario Retail', 'Amazon Easy Store',
  ],
};

export default function AmazonReceivablesDashboard() {
  return <ReceivablesDemoDashboard config={AMAZON_CONFIG} />;
}
