import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Bot } from 'lucide-react';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';

// Myntra Ticket Finder — the tested in-browser tool is self-hosted at
// public/myntra-ticket-finder.html and embedded here. Raw Seller-Hub reports are
// processed entirely in the iframe (client-side); only a summary is persisted.
const MyntraTicketFinderWorkspace = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>
        <button
          onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/agents`)}
          style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 14, marginBottom: 12 }}
        >
          ← Back to Agents
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-heading, #0F172A)', margin: '0 0 4px' }}>
          Myntra Ticket Finder
        </h1>
        <p style={{ color: 'var(--text-muted, #64748B)', fontSize: 14, margin: '0 0 16px', lineHeight: 1.6 }}>
          Upload Myntra Seller Hub reports to automatically detect billing errors — commission not reversed,
          closed-box return claims, fixed-fee retention, commission overcharges — and generate proof files +
          ticket templates ready to paste into Myntra Seller Support. Raw reports stay in your browser.
        </p>
        <iframe
          title="Myntra Ticket Finder"
          src={`${process.env.PUBLIC_URL || ''}/myntra-ticket-finder.html`}
          style={{
            width: '100%',
            height: 'calc(100vh - 210px)',
            minHeight: 600,
            border: '1px solid var(--card-border, #E2E8F6)',
            borderRadius: 16,
            background: '#fff',
          }}
        />
      </div>
    </DashboardLayout>
  );
};

export default MyntraTicketFinderWorkspace;
