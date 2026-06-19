import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, ArrowLeft, ChevronRight, TrendingUp, Zap, Shield, Activity, ClipboardList } from 'lucide-react';

const RECO_AGENTS = [
  {
    id: 'gstr_2b_books', category: 'GST Reconciliation',
    name: 'GSTR-2B vs Books', icon: '📂',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8',
    description: 'Reconcile GSTR-2B (B2B, B2BA, B2B-CDNR, B2B-CDNRA sheets) against your Purchase Register and Debit Note Register combined.',
    fields: ['GSTR-2B File', 'Purchase Register', 'Debit Note Register'], accuracy: '99.5%',
  },
  {
    id: 'gstr_2b_books_multistate', category: 'GST Reconciliation',
    name: 'GSTR-2B vs Books (Multi-State)', icon: '🗺️',
    color: '#7C3AED', bg: '#F5F3FF', border: '#C4B5FD',
    description: 'Reconcile across multiple GSTINs / states simultaneously. Detects cross-state booking errors and explains them in Remark 3.',
    fields: ['GSTR-2B × N States', 'Purchase Register × N States', 'Debit Note × N States'], accuracy: '99.5%',
  },
  {
    id: 'gstr_3b_tally_entry', category: 'Journal Entry',
    name: 'GSTR-3B Tally Entry', icon: '📒',
    color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4',
    description: 'Parses a GSTR-3B file and generates ready-to-post Tally journal entries for ITC credit ledger transfer, output liability set-off, and RCM.',
    fields: ['GSTR-3B File'], accuracy: '99.9%',
  },
  {
    id: 'universal_bank_statement', category: 'Bank & Finance',
    name: 'Universal Bank Statement', icon: '🌍',
    color: '#059669', bg: '#ECFDF5', border: '#A7F3D0',
    description: 'Brand-agnostic classifier that maps transactions from any Indian bank statement format to your exported Tally chart of accounts.',
    fields: ['Bank Statement', 'Ledger Master'], accuracy: '100.0%',
  },
  {
    id: 'pdf_bank_extract', category: 'Bank & Finance',
    name: 'PDF → Bank Statement', icon: '📄',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8',
    description: 'Convert any Indian bank statement PDF (HDFC, ICICI, SBI, Axis, Kotak) to Excel with Check Point validation columns — ready for the Universal Bank Statement classifier.',
    fields: ['Bank Statement PDF'], accuracy: 'Auto-detect',
    route: 'pdf-bank',
  },
];

const AgentCard = ({ agent, brandId, navigate, idx }) => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), idx * 70 + 80);
    return () => clearTimeout(t);
  }, [idx]);

  return (
    <button
      onClick={() => navigate(agent.route ? `/brands/${brandId}/${agent.route}` : `/brands/${brandId}/reco/${agent.id}`)}
      className="glass-card p-5 text-left group"
      data-testid={`reco-card-${agent.id}`}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'none' : 'translateY(16px)',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
          style={{ background: agent.bg, border: `1px solid ${agent.border}` }}>
          {agent.icon}
        </div>
        <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full"
          style={{ background: agent.bg, color: agent.color, border: `1px solid ${agent.border}` }}>
          <TrendingUp className="w-2.5 h-2.5" /> {agent.accuracy}
        </span>
      </div>

      <h3 className="text-sm font-bold mb-1.5" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>{agent.name}</h3>
      <p className="text-xs leading-relaxed mb-4" style={{ color: '#64748B' }}>{agent.description}</p>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {agent.fields.map(f => (
          <span key={f} className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#64748B' }}>
            {f}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
          style={{ background: agent.bg, color: agent.color, border: `1px solid ${agent.border}` }}>
          {agent.category === 'Bank & Finance' ? 'Bank' : 'GSTR'}
        </span>
        <div className="flex items-center gap-1 text-xs font-semibold transition-all group-hover:gap-1.5"
          style={{ color: agent.color }}>
          Run Agent
          <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </div>
      </div>
    </button>
  );
};

const RecoSuite = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
    { path: `/brands/${brandId}/reco`, label: 'Reconciliation', icon: ClipboardList, testId: 'nav-reco' },
  ];

  const gstAgents     = RECO_AGENTS.filter(a => a.category === 'GST Reconciliation');
  const journalAgents = RECO_AGENTS.filter(a => a.category === 'Journal Entry');
  const bankAgents    = RECO_AGENTS.filter(a => a.category === 'Bank & Finance');

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl">

        {/* Back */}
        <button onClick={() => navigate(`/brands/${brandId}/dashboard`)}
          className="flex items-center gap-1.5 text-sm mb-6 group transition-colors hover:text-blue-600"
          style={{ color: '#64748B' }}>
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          Dashboard
        </button>

        {/* Hero Header */}
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full mb-3 badge-blue">
            <Zap className="w-3 h-3" /> {RECO_AGENTS.length} Agents Active
          </div>
          <h1 className="text-3xl font-black mb-2" style={{ color: '#0F172A', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
            Reconciliation{' '}
            <span style={{ background: 'linear-gradient(135deg, #0748EE, #F115F8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
              Suite
            </span>
          </h1>
          <p className="text-sm" style={{ color: '#64748B', maxWidth: '520px' }}>
            Automated reconciliation agents built for Indian accounting workflows.
            Upload files, run matching, download Excel — GST &amp; Bank in one place.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Total Runs', value: '1,000+', icon: Activity, color: '#0748EE', bg: '#E8EFFE', border: '#C7D8FC' },
            { label: 'Agents', value: '4', icon: Zap, color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
            { label: 'Avg Accuracy', value: '99.7%', icon: Shield, color: '#059669', bg: '#ECFDF5', border: '#A7F3D0' },
          ].map(stat => (
            <div key={stat.label} className="stat-card">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: stat.bg, border: `1px solid ${stat.border}` }}>
                  <stat.icon className="w-4 h-4" style={{ color: stat.color }} />
                </div>
                <div>
                  <div className="text-xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>{stat.value}</div>
                  <div className="text-xs font-semibold" style={{ color: '#64748B' }}>{stat.label}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* GST Reconciliation */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-1 h-5 rounded-full bg-blue-500" />
              <h2 className="text-sm font-bold" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>GST Reconciliation</h2>
            </div>
            <div className="flex-1 h-px" style={{ background: '#E2E8F0' }} />
            <span className="text-xs" style={{ color: '#94A3B8' }}>{gstAgents.length} agents</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {gstAgents.map((agent, idx) => (
              <AgentCard key={agent.id} agent={agent} brandId={brandId} navigate={navigate} idx={idx} />
            ))}
          </div>
        </div>

        {/* Journal Entry */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-1 h-5 rounded-full bg-teal-500" />
              <h2 className="text-sm font-bold" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>Journal Entry</h2>
            </div>
            <div className="flex-1 h-px" style={{ background: '#E2E8F0' }} />
            <span className="text-xs" style={{ color: '#94A3B8' }}>{journalAgents.length} agent</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {journalAgents.map((agent, idx) => (
              <AgentCard key={agent.id} agent={agent} brandId={brandId} navigate={navigate} idx={gstAgents.length + idx} />
            ))}
          </div>
        </div>

        {/* Bank & Finance */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-1 h-5 rounded-full bg-rose-500" />
              <h2 className="text-sm font-bold" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>Bank &amp; Finance</h2>
            </div>
            <div className="flex-1 h-px" style={{ background: '#E2E8F0' }} />
            <span className="text-xs" style={{ color: '#94A3B8' }}>{bankAgents.length} agent</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {bankAgents.map((agent, idx) => (
              <AgentCard key={agent.id} agent={agent} brandId={brandId} navigate={navigate} idx={gstAgents.length + journalAgents.length + idx} />
            ))}
          </div>
        </div>

      </div>
    </DashboardLayout>
  );
};

export default RecoSuite;
