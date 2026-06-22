import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge, Handle, Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toPng } from 'html-to-image';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Building2, Workflow, ArrowLeft, Save, Share2, Download, Plus, StickyNote, Bot, BarChart3, X } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor, isAdminUser, isDeveloperUser } from '../../lib/adminNav';

/* ── Custom nodes ─────────────────────────────────────────────────────────── */
const baseHandle = { width: 8, height: 8, background: '#94A3B8', border: '1.5px solid #fff' };
const NodeShell = ({ children, bg, border }) => (
  <div style={{ background: bg, border: `1.5px solid ${border}`, borderRadius: 12, padding: '10px 14px', minWidth: 150, maxWidth: 240, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
    <Handle type="target" position={Position.Left} style={baseHandle} />
    {children}
    <Handle type="source" position={Position.Right} style={baseHandle} />
  </div>
);
const StepNode = ({ data }) => (
  <NodeShell bg="#E8EFFE" border="#A3BFF8">
    <div style={{ fontSize: 10, fontWeight: 700, color: '#0748EE', textTransform: 'uppercase', marginBottom: 2 }}>Step</div>
    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{data.label || 'Untitled step'}</div>
  </NodeShell>
);
const NoteNode = ({ data }) => (
  <NodeShell bg="#FEF9C3" border="#FDE68A">
    <div style={{ fontSize: 13, color: '#713F12', whiteSpace: 'pre-wrap' }}>{data.label || 'Note…'}</div>
  </NodeShell>
);
const AgentNode = ({ data }) => (
  <NodeShell bg="#ECFDF5" border="#A7F3D0">
    <div style={{ fontSize: 10, fontWeight: 700, color: '#059669', textTransform: 'uppercase', marginBottom: 2 }}>🤖 Agent</div>
    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{data.label || 'Pick an agent'}</div>
  </NodeShell>
);
const MetricNode = ({ data }) => (
  <NodeShell bg="#F5F3FF" border="#C4B5FD">
    <div style={{ fontSize: 10, fontWeight: 700, color: '#7C3AED', textTransform: 'uppercase', marginBottom: 2 }}>Metric</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: '#0F172A', lineHeight: 1 }}>{data.value || '—'}</div>
    <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>{data.label || 'metric'}</div>
  </NodeShell>
);
const nodeTypes = { step: StepNode, note: NoteNode, agent: AgentNode, metric: MetricNode };

let idSeq = 1;
const newId = () => `n${Date.now()}_${idSeq++}`;

const EditorInner = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const admin = isAdminUser() || isDeveloperUser();  // "admin" here = can edit the canvas
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [accountants, setAccountants] = useState([]);
  const [sharedWith, setSharedWith] = useState([]);
  const wrapRef = useRef(null);

  const sidebarItems = sidebarFor([
    { path: '/brands', label: 'Brands', icon: Building2 },
    { path: '/plans', label: 'Plans', icon: Workflow },
  ]);

  useEffect(() => {
    api.get(`/api/plans/${id}`)
      .then(r => {
        setPlan(r.data);
        setNodes(r.data.graph?.nodes || []);
        setEdges(r.data.graph?.edges || []);
        setSharedWith(r.data.shared_with || []);
      })
      .catch(() => toast.error('Failed to load plan'))
      .finally(() => setLoading(false));
    if (isAdminUser()) api.get('/api/users').then(r => setAccountants(r.data.filter(u => u.role === 'accountant'))).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onConnect = useCallback((params) => setEdges(eds => addEdge({ ...params, animated: true }, eds)), [setEdges]);

  const addNode = (type) => {
    const labels = { step: 'New step', note: 'Note…', agent: 'Pick an agent', metric: 'metric' };
    const node = {
      id: newId(), type,
      position: { x: 80 + (nodes.length % 6) * 60, y: 80 + (nodes.length % 8) * 50 },
      data: type === 'metric' ? { label: 'metric', value: '0' } : { label: labels[type] },
    };
    setNodes(nds => [...nds, node]);
  };

  const onNodeDoubleClick = (_e, node) => {
    if (!admin) return;
    const label = window.prompt('Label', node.data.label || '');
    if (label === null) return;
    let value = node.data.value;
    if (node.type === 'metric') { const v = window.prompt('Value', node.data.value || ''); if (v !== null) value = v; }
    setNodes(nds => nds.map(n => n.id === node.id ? { ...n, data: { ...n.data, label, value } } : n));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/plans/${id}`, { graph: { nodes, edges } });
      toast.success('Plan saved');
    } catch { toast.error('Save failed'); }
    finally { setSaving(false); }
  };

  const saveShare = async () => {
    try {
      await api.put(`/api/plans/${id}`, { shared_with: sharedWith });
      toast.success('Sharing updated');
      setShowShare(false);
    } catch { toast.error('Could not update sharing'); }
  };

  const downloadPng = async () => {
    const el = wrapRef.current?.querySelector('.react-flow__viewport');
    const host = wrapRef.current?.querySelector('.react-flow');
    if (!host) return;
    try {
      const dataUrl = await toPng(host, { backgroundColor: '#ffffff', filter: (n) => !(n.classList?.contains('react-flow__minimap') || n.classList?.contains('react-flow__controls')) });
      const a = document.createElement('a'); a.href = dataUrl; a.download = `${plan?.name || 'plan'}.png`; a.click();
    } catch { toast.error('PNG export failed'); }
    void el;
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify({ name: plan?.name, nodes, edges }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${plan?.name || 'plan'}.json`; a.click(); URL.revokeObjectURL(url);
  };

  if (loading) {
    return <DashboardLayout sidebarItems={sidebarItems}><div className="p-6 flex items-center justify-center h-64"><Workflow className="w-8 h-8 animate-pulse text-slate-300" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
        {/* Toolbar */}
        <div className="px-5 py-3 border-b bg-white flex items-center gap-3 flex-wrap" style={{ borderColor: '#E2E8F0' }}>
          <button onClick={() => navigate(isAdminUser() ? '/admin/plans' : '/plans')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft className="w-4 h-4" /> Plans
          </button>
          <span className="text-sm font-bold text-slate-900">{plan?.name}</span>
          {!admin && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">read-only</span>}

          <div className="flex-1" />

          {admin && (
            <>
              <span className="text-xs text-slate-400 mr-1">Add:</span>
              <button onClick={() => addNode('step')}   className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border flex items-center gap-1" style={{ borderColor: '#A3BFF8', color: '#0748EE', background: '#E8EFFE' }}><Plus className="w-3 h-3" />Step</button>
              <button onClick={() => addNode('note')}   className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border flex items-center gap-1" style={{ borderColor: '#FDE68A', color: '#B45309', background: '#FEF9C3' }}><StickyNote className="w-3 h-3" />Note</button>
              <button onClick={() => addNode('agent')}  className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border flex items-center gap-1" style={{ borderColor: '#A7F3D0', color: '#059669', background: '#ECFDF5' }}><Bot className="w-3 h-3" />Agent</button>
              <button onClick={() => addNode('metric')} className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border flex items-center gap-1" style={{ borderColor: '#C4B5FD', color: '#7C3AED', background: '#F5F3FF' }}><BarChart3 className="w-3 h-3" />Metric</button>
              <div className="w-px h-6 bg-slate-200 mx-1" />
              <button onClick={() => setShowShare(true)} className="text-xs font-semibold px-3 py-1.5 rounded-lg border flex items-center gap-1.5 text-slate-600" style={{ borderColor: '#E2E8F0' }}><Share2 className="w-3.5 h-3.5" />Share</button>
            </>
          )}
          <button onClick={downloadPng} className="text-xs font-semibold px-3 py-1.5 rounded-lg border flex items-center gap-1.5 text-slate-600" style={{ borderColor: '#E2E8F0' }}><Download className="w-3.5 h-3.5" />PNG</button>
          <button onClick={downloadJson} className="text-xs font-semibold px-3 py-1.5 rounded-lg border flex items-center gap-1.5 text-slate-600" style={{ borderColor: '#E2E8F0' }}>JSON</button>
          {admin && (
            <button onClick={save} disabled={saving} className="text-xs font-bold px-4 py-1.5 rounded-lg text-white flex items-center gap-1.5" style={{ background: '#0748EE', opacity: saving ? 0.6 : 1 }}><Save className="w-3.5 h-3.5" />{saving ? 'Saving…' : 'Save'}</button>
          )}
        </div>

        {/* Canvas */}
        <div ref={wrapRef} className="flex-1" style={{ minHeight: 480, height: 'calc(100vh - 128px)', position: 'relative' }}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={admin ? onNodesChange : undefined}
            onEdgesChange={admin ? onEdgesChange : undefined}
            onConnect={admin ? onConnect : undefined}
            onNodeDoubleClick={onNodeDoubleClick}
            nodeTypes={nodeTypes}
            nodesDraggable={admin} nodesConnectable={admin} elementsSelectable={admin}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} color="#E2E8F0" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {admin && nodes.length === 0 && (
            <div className="absolute" style={{ left: '50%', top: '55%', transform: 'translate(-50%,-50%)', pointerEvents: 'none' }}>
              <p className="text-sm text-slate-400">Add nodes from the toolbar · drag to connect · double-click to edit</p>
            </div>
          )}
        </div>
      </div>

      {/* Share modal */}
      {showShare && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={e => e.target === e.currentTarget && setShowShare(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-slate-900">Share plan</h3>
              <button onClick={() => setShowShare(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Select users who can view this plan (read-only).</p>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {accountants.map(u => {
                const on = sharedWith.includes(u.id);
                return (
                  <button key={u.id} onClick={() => setSharedWith(s => on ? s.filter(x => x !== u.id) : [...s, u.id])}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-slate-50">
                    <div className="w-4 h-4 rounded border flex items-center justify-center" style={{ borderColor: on ? '#0748EE' : '#CBD5E1', background: on ? '#0748EE' : '#fff' }}>
                      {on && <span className="text-white text-[10px]">✓</span>}
                    </div>
                    <span className="text-sm text-slate-700">{u.name || u.email}</span>
                  </button>
                );
              })}
              {accountants.length === 0 && <p className="text-xs text-slate-400 text-center py-3">No accountants found</p>}
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowShare(false)} className="flex-1 px-3 py-2 rounded-lg border text-sm" style={{ borderColor: '#E2E8F0' }}>Cancel</button>
              <button onClick={saveShare} className="flex-1 px-3 py-2 rounded-lg text-white text-sm font-semibold" style={{ background: '#0748EE' }}>Save sharing</button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
};

const PlanEditor = () => (
  <ReactFlowProvider>
    <EditorInner />
  </ReactFlowProvider>
);

export default PlanEditor;
