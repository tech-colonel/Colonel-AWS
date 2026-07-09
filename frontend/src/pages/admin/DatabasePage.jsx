import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import api from '../../lib/api';
import { Database, KeyRound, Link2, Table2 } from 'lucide-react';

/* ── palette per layer (header colours, ERD-style like the reference) ── */
const GROUP_STYLE = {
  'Org / global':                    { bar: '#2f5fe0', soft: '#e6ecfd' },
  'Reconciliation':                  { bar: '#0f9d6b', soft: '#e2f5ec' },
  'GSTR-3B Tally':                   { bar: '#b9791a', soft: '#fbeecf' },
  'Marketplace / Sales (dynamic)':   { bar: '#7a49c9', soft: '#efe7fb' },
};
const styleFor = (g) => GROUP_STYLE[g] || { bar: '#5a6480', soft: '#eef2fa' };

/* ── DB root node ── */
function DbRootNode({ data }) {
  return (
    <div style={{background:'#0e1524',color:'#fff',borderRadius:14,padding:'14px 20px',minWidth:280,
      boxShadow:'0 8px 24px rgba(14,21,36,.25)',border:'1px solid #263149'}}>
      <div style={{display:'flex',alignItems:'center',gap:9}}>
        <Database size={18} color="#5c86ff"/>
        <span style={{fontFamily:'ui-monospace,Menlo,monospace',fontWeight:700,fontSize:15}}>{data.db}</span>
      </div>
      <div style={{marginTop:6,fontSize:12,color:'#93a0bd'}}>
        {data.tables} tables &middot; {data.rows.toLocaleString()} rows &middot; one shared database
      </div>
      <Handle type="source" position={Position.Bottom} style={{background:'#5c86ff'}}/>
    </div>
  );
}

/* ── layer/group node ── */
function GroupNode({ data }) {
  const s = styleFor(data.name);
  return (
    <div onClick={data.onToggle}
      style={{cursor:'pointer',background:'#fff',borderRadius:12,minWidth:260,border:`1px solid ${s.bar}`,
        boxShadow:'0 4px 14px rgba(14,21,36,.10)',overflow:'hidden'}}>
      <div style={{background:s.bar,color:'#fff',padding:'9px 13px',display:'flex',alignItems:'center',gap:8,fontWeight:700,fontSize:14}}>
        <span style={{transition:'transform .2s',transform:data.open?'rotate(90deg)':'none',display:'inline-block'}}>&#9656;</span>
        {data.name}
        <span style={{marginLeft:'auto',fontFamily:'ui-monospace,monospace',fontSize:11,background:'rgba(255,255,255,.22)',padding:'2px 8px',borderRadius:999}}>{data.count} tables</span>
      </div>
      <div style={{padding:'7px 13px',fontSize:11.5,color:'#5a6480',fontFamily:'ui-monospace,monospace'}}>
        {data.rls ? 'brand_id + RLS · isolated' : 'shared · no brand_id'} — click to {data.open?'collapse':'expand'}
      </div>
      <Handle type="target" position={Position.Top}/>
      <Handle type="source" position={Position.Bottom} style={{background:s.bar}}/>
    </div>
  );
}

/* ── table (ERD card) node ── */
function TableNode({ data }) {
  const s = styleFor(data.group);
  const [open, setOpen] = useState(null); // field name whose sample is shown
  return (
    <div style={{background:'#fff',borderRadius:12,width:300,border:'1px solid #d7deee',
      boxShadow:'0 4px 14px rgba(14,21,36,.09)',overflow:'hidden',fontSize:12.5}}>
      <div style={{background:s.bar,color:'#fff',padding:'8px 12px',display:'flex',alignItems:'center',gap:7,fontWeight:700}}>
        <Table2 size={14}/>
        <span style={{fontFamily:'ui-monospace,monospace',fontSize:13}}>{data.name}</span>
        <span style={{marginLeft:'auto',fontFamily:'ui-monospace,monospace',fontSize:10.5,background:'rgba(255,255,255,.22)',padding:'2px 7px',borderRadius:999}}>
          {data.rows > 0 ? data.rows.toLocaleString()+' rows' : 'empty'}
        </span>
      </div>
      <div style={{maxHeight:230,overflowY:'auto'}}>
        <div style={{display:'flex',padding:'5px 12px',fontSize:10,letterSpacing:'.05em',textTransform:'uppercase',color:'#8a94ad',borderBottom:'1px solid #eef2fa'}}>
          <span style={{flex:1}}>Name</span><span>Type</span>
        </div>
        {data.fields.map((f) => {
          const has = data.sample && Object.prototype.hasOwnProperty.call(data.sample, f.name);
          const val = has ? data.sample[f.name] : null;
          const isBrand = f.name === 'brand_id';
          return (
            <div key={f.name}>
              <div onClick={() => setOpen(open === f.name ? null : f.name)}
                style={{display:'flex',alignItems:'center',gap:6,padding:'6px 12px',cursor:'pointer',
                  borderBottom:'1px solid #f3f6fc',background: open===f.name?s.soft:'transparent'}}>
                {f.pk ? <KeyRound size={12} color="#b9791a"/> : f.fk ? <Link2 size={12} color="#2f5fe0"/> : <span style={{width:12}}/>}
                <span style={{flex:1,fontFamily:'ui-monospace,monospace',color:isBrand?'#0f9d6b':'#0e1524',fontWeight:(f.pk||isBrand)?700:500}}>{f.name}</span>
                <span style={{fontFamily:'ui-monospace,monospace',color:'#8a94ad',fontSize:11}}>{f.type.replace('character varying','varchar').replace(' with time zone','tz').replace('timestamp','ts')}</span>
              </div>
              {open === f.name && (
                <div style={{padding:'7px 12px',background:s.soft,borderBottom:'1px solid #eef2fa'}}>
                  <div style={{fontSize:9.5,letterSpacing:'.08em',textTransform:'uppercase',color:s.bar,marginBottom:2}}>sample value{f.fk?` · FK → ${f.fk}`:''}</div>
                  <div style={{fontFamily:'ui-monospace,monospace',fontSize:11.5,color:'#0e1524',wordBreak:'break-word'}}>
                    {(val===null||val===undefined) ? <span style={{color:'#8a94ad',fontStyle:'italic'}}>— no rows yet / null</span> : String(val)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Handle type="target" position={Position.Top}/>
      <Handle type="source" position={Position.Bottom}/>
      <Handle type="target" position={Position.Left} id="l"/>
      <Handle type="source" position={Position.Right} id="r"/>
    </div>
  );
}

const nodeTypes = { dbroot: DbRootNode, group: GroupNode, table: TableNode };
const COL_GAP = 380, ROW_GAP = 300;

export default function DatabasePage() {
  const [schema, setSchema] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    api.get('/api/database/schema')
      .then((r) => { setSchema(r.data); const e = {}; r.data.groups.forEach((g) => { e[g.name] = false; }); setExpanded(e); })
      .catch((err) => setError(err?.response?.data?.error || err.message));
  }, []);

  const toggle = useCallback((name) => setExpanded((p) => ({ ...p, [name]: !p[name] })), []);

  // re-frame the canvas whenever a layer expands/collapses (zoom to what's visible)
  const rfRef = React.useRef(null);
  useEffect(() => {
    const t = setTimeout(() => { if (rfRef.current) rfRef.current.fitView({ padding: 0.22, duration: 450, maxZoom: 1 }); }, 70);
    return () => clearTimeout(t);
  }, [expanded, schema]);

  const { nodes, edges } = useMemo(() => {
    if (!schema) return { nodes: [], edges: [] };
    const nodes = [], edges = [];
    const nGroups = schema.groups.length;
    const centerX = ((nGroups - 1) * COL_GAP) / 2;
    nodes.push({ id: 'db', type: 'dbroot', position: { x: centerX, y: 0 }, data: { db: schema.db, tables: schema.totalTables, rows: schema.totalRows } });
    const tableNode = {}; // name -> id
    schema.groups.forEach((g, gi) => {
      const gx = gi * COL_GAP;
      const gid = 'g' + gi;
      const open = !!expanded[g.name];
      nodes.push({ id: gid, type: 'group', position: { x: gx, y: 150 }, data: { name: g.name, count: g.tables.length, rls: g.rls, open, onToggle: () => toggle(g.name) } });
      edges.push({ id: 'e-db-' + gid, source: 'db', target: gid, type: 'smoothstep', animated: true, style: { stroke: '#c3ccdf', strokeWidth: 1.5 } });
      if (!open) return;
      g.tables.forEach((t, ti) => {
        const id = 't-' + t.name; tableNode[t.name] = id;
        nodes.push({ id, type: 'table', position: { x: gx, y: 320 + ti * ROW_GAP }, data: { name: t.name, rows: t.rows, fields: t.fields, sample: t.sample, group: g.name } });
        edges.push({ id: 'e-' + (ti === 0 ? gid : 't-' + g.tables[ti - 1].name) + '-' + id, source: ti === 0 ? gid : 't-' + g.tables[ti - 1].name, target: id, type: 'smoothstep', style: { stroke: styleFor(g.name).bar, strokeWidth: 1.5, opacity: .5 } });
      });
    });
    // FK relationship wires (only when both ends are rendered)
    (schema.edges || []).forEach((fk, i) => {
      const s = tableNode[fk.from], t = tableNode[fk.to];
      if (s && t && s !== t) edges.push({ id: 'fk' + i, source: s, sourceHandle: 'r', target: t, targetHandle: 'l', type: 'bezier', animated: false, style: { stroke: '#f0736d', strokeWidth: 1, strokeDasharray: '4 3' }, label: fk.col });
    });
    return { nodes, edges };
  }, [schema, expanded, toggle]);

  return (
    <DashboardLayout sidebarItems={sidebarFor()}>
      <div style={{ padding: '20px 24px 8px' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-.02em' }}>Database</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--muted,#5a6480)', fontSize: 14 }}>
          Live schema of the unified database — <b>colonel_agent_accountant</b>. Expand a layer, then click any field in a table to see a real sample value. Wires show foreign-key relationships.
        </p>
      </div>
      <div style={{ height: 'calc(100vh - 150px)', margin: '8px 16px 16px', border: '1px solid #d7deee', borderRadius: 16, overflow: 'hidden', background: '#f7f9fe' }}>
        {error ? (
          <div style={{ padding: 40, color: '#c73d38', fontFamily: 'ui-monospace,monospace' }}>Failed to load schema: {error}</div>
        ) : !schema ? (
          <div style={{ padding: 40, color: '#5a6480' }}>Loading live schema…</div>
        ) : (
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
            onInit={(inst) => { rfRef.current = inst; }}
            fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
            minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'smoothstep' }}>
            <Background color="#d7deee" gap={22} />
            <Controls />
            <MiniMap pannable zoomable nodeColor={(n) => n.type === 'dbroot' ? '#0e1524' : styleFor(n.data?.group || n.data?.name).bar} style={{ background: '#fff' }} />
          </ReactFlow>
        )}
      </div>
    </DashboardLayout>
  );
}
