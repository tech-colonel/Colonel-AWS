import React, { useState, useRef, useEffect } from 'react';
import { SlidersHorizontal, Plus, X, Check, ChevronDown } from 'lucide-react';
import {
  FILTER_FIELDS, FILTER_OPERATORS, STATUTORY_CATEGORIES, STATUTORY_STATUS_COLUMNS,
  ALL_STATES, PERIOD_TYPES, matchesCondition,
} from '../lib/statutoryMeta';

/* Resolve an optionSet name → [{value,label}] */
const optionSet = (name, brandStates) => {
  switch (name) {
    case 'categories':  return STATUTORY_CATEGORIES.map(c => ({ value: c.key, label: c.name, color: c.color }));
    case 'statuses':    return STATUTORY_STATUS_COLUMNS.map(s => ({ value: s.key, label: s.label, color: s.color }));
    case 'states':      return (brandStates && brandStates.length ? brandStates : ALL_STATES).map(s => ({ value: s, label: s }));
    case 'periodTypes': return PERIOD_TYPES.map(p => ({ value: p.key, label: p.label }));
    default:            return [];
  }
};
const FIELD_BY_KEY = Object.fromEntries(FILTER_FIELDS.map(f => [f.key, f]));
const labelFor = (name, val, brandStates) => optionSet(name, brandStates).find(o => o.value === val)?.label || val;

/* Client-side filter: quick chips (AND) + custom conditions (AND). */
export function applyStatutoryFilters(rows, value) {
  const q = value?.quick || {};
  const conds = value?.conditions || [];
  return rows.filter(r => {
    if (q.state && r.state !== q.state) return false;
    if (q.periodType && r.period_type !== q.periodType) return false;
    if (q.status && r.status !== q.status) return false;
    for (const c of conds) {
      const field = c.field === 'category' ? 'compliance_type' : c.field;
      if (!matchesCondition(r, { field, op: c.op, value: c.value })) return false;
    }
    return true;
  });
}

/* ── a premium pill dropdown ──────────────────────────────────────────────── */
function PillSelect({ label, value, options, onChange, accent = '#0748EE' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const selected = options.find(o => o.value === value);
  const active = !!value;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 999,
        fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${active ? accent : 'var(--card-border)'}`,
        background: active ? `${accent}12` : 'var(--surface)',
        color: active ? accent : 'var(--text-heading)',
      }}>
        <span style={{ color: active ? accent : 'var(--text-muted)' }}>{label}</span>
        {active && <span>· {selected?.label || value}</span>}
        <ChevronDown style={{ width: 13, height: 13, opacity: 0.7 }} />
      </button>
      {open && (
        <div className="glass-card" style={{
          position: 'absolute', top: '112%', left: 0, zIndex: 50, minWidth: 190,
          maxHeight: 300, overflowY: 'auto', padding: 6,
        }}>
          <button onClick={() => { onChange(''); setOpen(false); }} style={menuItem(!value)}>All {label.toLowerCase()}</button>
          {options.map(o => (
            <button key={o.value} onClick={() => { onChange(o.value); setOpen(false); }} style={menuItem(o.value === value)}>
              {o.color && <span style={{ width: 8, height: 8, borderRadius: 999, background: o.color, marginRight: 8 }} />}
              {o.label}
              {o.value === value && <Check style={{ width: 13, height: 13, marginLeft: 'auto', color: '#0748EE' }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const menuItem = (on) => ({
  width: '100%', display: 'flex', alignItems: 'center', textAlign: 'left', gap: 2,
  padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5,
  fontWeight: on ? 700 : 500, color: on ? '#0748EE' : 'var(--text-heading)',
  background: on ? '#0748EE0f' : 'transparent',
});

/* ── the custom-filter builder popover ────────────────────────────────────── */
function AddFilter({ brandStates, onAdd }) {
  const [open, setOpen] = useState(false);
  const [fieldKey, setFieldKey] = useState(FILTER_FIELDS[0].key);
  const [op, setOp] = useState(FILTER_OPERATORS[FILTER_FIELDS[0].type][0].key);
  const [val, setVal] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const field = FIELD_BY_KEY[fieldKey];
  const ops = FILTER_OPERATORS[field.type] || FILTER_OPERATORS.text;
  const needsValue = !['is_empty', 'is_not_empty'].includes(op);

  const pickField = (k) => {
    setFieldKey(k);
    const t = FIELD_BY_KEY[k].type;
    setOp((FILTER_OPERATORS[t] || FILTER_OPERATORS.text)[0].key);
    setVal('');
  };
  const apply = () => {
    if (needsValue && val === '') return;
    onAdd({ field: fieldKey, op, value: needsValue ? val : '' });
    setOpen(false); setVal('');
  };

  const inputEl = () => {
    if (!needsValue) return null;
    if (field.type === 'select') {
      const opts = optionSet(field.optionSet, brandStates);
      return (
        <select value={val} onChange={e => setVal(e.target.value)} style={ctrl}>
          <option value="">Select…</option>
          {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    if (field.type === 'date') return <input type="date" value={val} onChange={e => setVal(e.target.value)} style={ctrl} />;
    if (field.type === 'month') return (
      <select value={val} onChange={e => setVal(e.target.value)} style={ctrl}>
        <option value="">Month…</option>
        {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => (
          <option key={m} value={i + 1}>{m}</option>
        ))}
      </select>
    );
    return <input value={val} onChange={e => setVal(e.target.value)} placeholder="Value" style={ctrl} />;
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999,
        fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px dashed var(--card-border)',
        background: 'var(--surface)', color: 'var(--text-muted)',
      }}>
        <Plus style={{ width: 13, height: 13 }} /> Add filter
      </button>
      {open && (
        <div className="glass-card" style={{ position: 'absolute', top: '112%', left: 0, zIndex: 50, width: 300, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 8 }}>
            Custom filter
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <select value={fieldKey} onChange={e => pickField(e.target.value)} style={ctrl}>
              {FILTER_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select value={op} onChange={e => setOp(e.target.value)} style={ctrl}>
              {ops.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            {inputEl()}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={apply} style={{ ...applyBtn, flex: 1 }}><Check style={{ width: 14, height: 14 }} /> Apply</button>
            <button onClick={() => setOpen(false)} style={cancelBtn}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── main filter bar ──────────────────────────────────────────────────────── */
export default function StatutoryFilters({ value, onChange, brandStates }) {
  const quick = value?.quick || { state: '', periodType: '', status: '' };
  const conditions = value?.conditions || [];
  const setQuick = (k, v) => onChange({ ...value, quick: { ...quick, [k]: v } });
  const addCond = (c) => onChange({ ...value, conditions: [...conditions, { ...c, id: `${c.field}-${c.op}-${conditions.length}` }] });
  const removeCond = (id) => onChange({ ...value, conditions: conditions.filter(c => c.id !== id) });
  const clearAll = () => onChange({ quick: { state: '', periodType: '', status: '' }, conditions: [] });
  const anyActive = quick.state || quick.periodType || quick.status || conditions.length;

  const condLabel = (c) => {
    const f = FIELD_BY_KEY[c.field];
    const opLabel = (FILTER_OPERATORS[f.type] || FILTER_OPERATORS.text).find(o => o.key === c.op)?.label || c.op;
    let v = c.value;
    if (f.type === 'select') v = labelFor(f.optionSet, c.value, brandStates);
    if (f.type === 'month') v = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(c.value)] || c.value;
    return `${f.label} ${opLabel}${v !== '' ? ` ${v}` : ''}`;
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '10px 12px', borderRadius: 14, background: 'var(--surface)',
      border: '1px solid var(--card-border)', boxShadow: 'var(--card-shadow)',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12.5, fontWeight: 700, paddingRight: 4 }}>
        <SlidersHorizontal style={{ width: 15, height: 15 }} /> Filters
      </span>
      <PillSelect label="State"  value={quick.state}      options={optionSet('states', brandStates)} onChange={v => setQuick('state', v)} accent="#14B8A6" />
      <PillSelect label="Cadence" value={quick.periodType} options={optionSet('periodTypes')}         onChange={v => setQuick('periodType', v)} accent="#7C3AED" />
      <PillSelect label="Status" value={quick.status}     options={optionSet('statuses')}             onChange={v => setQuick('status', v)} accent="#0748EE" />
      <AddFilter brandStates={brandStates} onAdd={addCond} />

      {conditions.map(c => (
        <span key={c.id} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999,
          fontSize: 12, fontWeight: 600, background: '#0748EE12', color: '#0748EE', border: '1px solid #0748EE33',
        }}>
          {condLabel(c)}
          <button onClick={() => removeCond(c.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#0748EE', display: 'inline-flex' }}>
            <X style={{ width: 13, height: 13 }} />
          </button>
        </span>
      ))}

      {anyActive ? (
        <button onClick={clearAll} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
          Clear all
        </button>
      ) : null}
    </div>
  );
}

const ctrl = {
  width: '100%', padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 9,
  background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 12.5, outline: 'none', fontFamily: 'inherit',
};
const applyBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 12px',
  borderRadius: 9, border: 'none', background: '#0748EE', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
};
const cancelBtn = {
  padding: '9px 12px', borderRadius: 9, border: '1px solid var(--card-border)', background: 'var(--surface)',
  color: 'var(--text-muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
