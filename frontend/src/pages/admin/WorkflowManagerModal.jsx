import React, { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import {
  Plus, Trash2, Edit2, Loader2, GitBranch, Upload, ChevronLeft,
  X, Check, TableIcon, PenLine, GitMerge, Layers, Sparkles
} from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';
import WorkflowAIChatModal from './WorkflowAIChatModal';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeSheetId = () => `sheet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const makeColId  = () => `col_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

function makeSheet(name, order) {
  return { id: makeSheetId(), name, order, sourceType: 'raw', rawSheetName: null, prevSheetName: null, columns: [], filters: [], groupBy: { enabled: false, columns: [], aggregations: {} } };
}

// Returns the output column name-strings for any sheet type (normal or merge)
function getPrevSheetOutputCols(s) {
  if (s.type === 'merge') {
    const seen = new Set();
    return (s.mergeConfig?.sources || [])
      .flatMap(src => src.columns || [])
      .filter(col => { if (seen.has(col)) return false; seen.add(col); return true; });
  }
  return (s.columns || []).filter(c => c.label).map(c => c.label);
}

function makeMergeSheet(name, order) {
  return {
    id: makeSheetId(), name, order,
    type: 'merge',
    mergeConfig: {
      mergeType: 'join',
      commonJoinKey: '',
      sources: [
        { type: 'raw', sheetName: '', columns: [], joinKey: '' },
        { type: 'raw', sheetName: '', columns: [], joinKey: '' },
      ]
    },
    columns: [], filters: [], groupBy: { enabled: false, columns: [], aggregations: {} }
  };
}

// Available columns for formula builder in a given sheet
// Returns [{ key, label, insertText }]
function getFormulaColumns(sheetIndex, allSheets, upToColIndex) {
  const result = [];

  // Previous sheets — all their output columns (handles merge sheets too)
  for (let i = 0; i < sheetIndex; i++) {
    const s     = allSheets[i];
    const sName = s.name || `Sheet${i + 1}`;
    getPrevSheetOutputCols(s).forEach(label => {
      result.push({
        key:        `${sName}.${label}`,
        label:      `${sName} → ${label}`,
        insertText: `{${sName}.${label}}`,
        fromSheet:  sName
      });
    });
  }

  // Current sheet — selected source cols + computed cols above insertion point
  const current = allSheets[sheetIndex];
  current.columns.slice(0, upToColIndex).forEach(col => {
    result.push({
      key:        col.label,
      label:      col.label,
      insertText: `{${col.label}}`,
      fromSheet:  null
    });
  });

  return result;
}

// ─── Formula Builder ──────────────────────────────────────────────────────────

const FormulaBuilder = ({ formula, onChange, availableColumns }) => {
  const inputRef = useRef(null);

  const insertAt = (text) => {
    const el = inputRef.current;
    if (!el) { onChange(formula + text); return; }
    const start = el.selectionStart;
    const end   = el.selectionEnd;
    const next  = formula.slice(0, start) + text + formula.slice(end);
    onChange(next);
    setTimeout(() => {
      el.setSelectionRange(start + text.length, start + text.length);
      el.focus();
    }, 0);
  };

  const ownCols   = availableColumns.filter(c => !c.fromSheet);
  const sheetCols = availableColumns.filter(c =>  c.fromSheet);

  // Group sheetCols by sheet name
  const sheetGroups = sheetCols.reduce((acc, c) => {
    if (!acc[c.fromSheet]) acc[c.fromSheet] = [];
    acc[c.fromSheet].push(c);
    return acc;
  }, {});

  return (
    <div className="space-y-2">
      {/* Column chips */}
      {availableColumns.length > 0 && (
        <div className="p-2 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
          {ownCols.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {ownCols.map(c => (
                <button
                  key={c.key} type="button"
                  onClick={() => insertAt(c.insertText)}
                  className="rounded px-1.5 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 hover:bg-indigo-200 cursor-pointer"
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {Object.entries(sheetGroups).map(([sName, cols]) => (
            <div key={sName} className="flex flex-wrap gap-1 items-center">
              <span className="text-xs text-slate-400 shrink-0">{sName}:</span>
              {cols.map(c => (
                <button
                  key={c.key} type="button"
                  onClick={() => insertAt(c.insertText)}
                  className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 cursor-pointer"
                >
                  {c.label}
                </button>
              ))}
            </div>
          ))}
          <p className="text-xs text-slate-400">↑ click column to insert reference</p>
        </div>
      )}

      {/* Formula input */}
      <Input
        ref={inputRef}
        value={formula}
        onChange={e => onChange(e.target.value)}
        placeholder='e.g. {Revenue} - {Cost}  or  IF({Qty} > 0, {Price} * {Qty}, 0)'
        className="font-mono text-sm"
      />

      {/* Operator buttons */}
      <div className="flex flex-wrap gap-1">
        {['+', '-', '*', '/', '(', ')', '>', '<', '=', 'IF(,,)'].map(sym => (
          <button
            key={sym} type="button"
            onClick={() => insertAt(sym === 'IF(,,)' ? 'IF(, , )' : sym)}
            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-mono text-slate-600 hover:bg-slate-50"
          >
            {sym}
          </button>
        ))}
      </div>
    </div>
  );
};

// ─── Inline Add Computed Column Form ─────────────────────────────────────────

const AddComputedColumnForm = ({ availableColumns, onAdd, onCancel }) => {
  const [label,   setLabel]   = useState('');
  const [formula, setFormula] = useState('');

  const handleAdd = () => {
    if (!label.trim())   { toast.error('Column name is required'); return; }
    if (!formula.trim()) { toast.error('Formula is required');     return; }
    onAdd({ label: label.trim(), formula: formula.trim() });
    setLabel('');
    setFormula('');
  };

  return (
    <div className="border border-indigo-200 bg-indigo-50 rounded-lg p-3 space-y-2.5">
      <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide">New Computed Column</p>
      <div>
        <Label className="text-xs text-slate-600">Column Name *</Label>
        <Input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Net Revenue"
          className="mt-1 h-8 text-sm"
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
      </div>
      <div>
        <Label className="text-xs text-slate-600">Formula *</Label>
        <div className="mt-1">
          <FormulaBuilder formula={formula} onChange={setFormula} availableColumns={availableColumns} />
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleAdd} className="h-7 text-xs">
          <Check className="h-3 w-3 mr-1" /> Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-xs">
          <X className="h-3 w-3 mr-1" /> Cancel
        </Button>
      </div>
    </div>
  );
};

// ─── Excel Formula Builder ────────────────────────────────────────────────────

const EXCEL_FUNCTIONS = [
  { label: 'SUMIF',     tpl: 'SUMIF("RangeCol", , "SumCol")',              hint: 'Sum where range matches criteria' },
  { label: 'SUMIFS',    tpl: 'SUMIFS("SumCol", "Range1", , "Range2", )',   hint: 'Sum with multiple conditions' },
  { label: 'COUNTIF',   tpl: 'COUNTIF("RangeCol", )',                      hint: 'Count rows matching criteria' },
  { label: 'COUNTIFS',  tpl: 'COUNTIFS("Range1", , "Range2", )',           hint: 'Count with multiple conditions' },
  { label: 'AVERAGEIF', tpl: 'AVERAGEIF("RangeCol", , "AvgCol")',          hint: 'Average where range matches' },
  { label: 'VLOOKUP',   tpl: 'VLOOKUP(, "LookupCol", "ReturnCol")',        hint: 'Lookup value across rows' },
  { label: 'MAXIF',     tpl: 'MAXIF("RangeCol", , "MaxCol")',              hint: 'Max value where range matches' },
  { label: 'MINIF',     tpl: 'MINIF("RangeCol", , "MinCol")',              hint: 'Min value where range matches' },
];

const ExcelFormulaBuilder = ({ formula, onChange, availableColumns }) => {
  const inputRef = useRef(null);

  const insertAt = (text) => {
    const el = inputRef.current;
    if (!el) { onChange(formula + text); return; }
    const start = el.selectionStart;
    const end   = el.selectionEnd;
    const next  = formula.slice(0, start) + text + formula.slice(end);
    onChange(next);
    setTimeout(() => { el.setSelectionRange(start + text.length, start + text.length); el.focus(); }, 0);
  };

  const ownCols = availableColumns.filter(c => !c.fromSheet);
  const sheetGroups = availableColumns.filter(c => c.fromSheet).reduce((acc, c) => {
    if (!acc[c.fromSheet]) acc[c.fromSheet] = [];
    acc[c.fromSheet].push(c);
    return acc;
  }, {});

  return (
    <div className="space-y-2">
      {/* Syntax hint */}
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700 leading-relaxed">
        <strong>Syntax:</strong> Use <code className="bg-sky-100 px-1 rounded font-mono">"Column Name"</code> for whole-column references (range/lookup args) and <code className="bg-sky-100 px-1 rounded font-mono">{'{Column Name}'}</code> for current-row values (criteria args).<br />
        <span className="text-sky-500">Example: <code className="font-mono">SUMIF("SKU", {'{SKU}'}, "Revenue")</code></span>
      </div>

      {/* Function template buttons */}
      <div className="p-2 bg-sky-50 border border-sky-200 rounded-lg">
        <p className="text-xs font-semibold text-sky-700 mb-1.5">Insert function:</p>
        <div className="flex flex-wrap gap-1">
          {EXCEL_FUNCTIONS.map(f => (
            <button key={f.label} type="button" title={f.hint}
              onClick={() => insertAt(f.tpl)}
              className="rounded px-2 py-0.5 text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Column chips — two groups */}
      {availableColumns.length > 0 && (
        <div className="p-2 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
          {/* Whole-column refs */}
          <div>
            <p className="text-xs text-slate-500 mb-1">Whole-column <span className="font-mono text-amber-700">"Name"</span> (for range/lookup args):</p>
            <div className="flex flex-wrap gap-1">
              {ownCols.map(c => (
                <button key={`str-${c.key}`} type="button"
                  onClick={() => insertAt(`"${c.label}"`)}
                  className="rounded px-1.5 py-0.5 text-xs font-mono font-medium bg-amber-100 text-amber-800 hover:bg-amber-200 cursor-pointer">
                  "{c.label}"
                </button>
              ))}
            </div>
          </div>
          {/* Current-row value refs */}
          <div>
            <p className="text-xs text-slate-500 mb-1">Current-row <span className="font-mono text-indigo-700">{'{Name}'}</span> (for criteria/lookup values):</p>
            <div className="flex flex-wrap gap-1">
              {ownCols.map(c => (
                <button key={`ref-${c.key}`} type="button"
                  onClick={() => insertAt(c.insertText)}
                  className="rounded px-1.5 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 hover:bg-indigo-200 cursor-pointer">
                  {c.label}
                </button>
              ))}
              {Object.entries(sheetGroups).map(([sName, cols]) => cols.map(c => (
                <button key={`ref-${c.key}`} type="button"
                  onClick={() => insertAt(c.insertText)}
                  className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 cursor-pointer">
                  {c.label}
                </button>
              )))}
            </div>
          </div>
        </div>
      )}

      {/* Formula input */}
      <Input ref={inputRef} value={formula} onChange={e => onChange(e.target.value)}
        placeholder='e.g. SUMIF("Transaction Type", {Transaction Type}, "Amount")'
        className="font-mono text-sm" />

      {/* Basic math operators */}
      <div className="flex flex-wrap gap-1">
        {['+', '-', '*', '/', '(', ')'].map(sym => (
          <button key={sym} type="button" onClick={() => insertAt(sym)}
            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-mono text-slate-600 hover:bg-slate-50">
            {sym}
          </button>
        ))}
      </div>
    </div>
  );
};

// ─── Add Excel Formula Column Form ────────────────────────────────────────────

const AddExcelColumnForm = ({ availableColumns, onAdd, onCancel }) => {
  const [label,   setLabel]   = useState('');
  const [formula, setFormula] = useState('');

  const handleAdd = () => {
    if (!label.trim())   { toast.error('Column name is required'); return; }
    if (!formula.trim()) { toast.error('Formula is required');     return; }
    onAdd({ label: label.trim(), formula: formula.trim() });
    setLabel(''); setFormula('');
  };

  return (
    <div className="border border-sky-200 bg-sky-50 rounded-lg p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold bg-sky-600 text-white px-2 py-0.5 rounded tracking-wide">Σ EXCEL</span>
        <p className="text-xs text-sky-700 font-medium">Cross-row formula column</p>
      </div>
      <div>
        <Label className="text-xs text-slate-600">Column Name *</Label>
        <Input value={label} onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Total SKU Revenue" className="mt-1 h-8 text-sm"
          onKeyDown={e => e.key === 'Enter' && handleAdd()} />
      </div>
      <div>
        <Label className="text-xs text-slate-600">Formula *</Label>
        <div className="mt-1">
          <ExcelFormulaBuilder formula={formula} onChange={setFormula} availableColumns={availableColumns} />
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleAdd} className="h-7 text-xs bg-sky-600 hover:bg-sky-700 text-white">
          <Check className="h-3 w-3 mr-1" /> Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-xs">
          <X className="h-3 w-3 mr-1" /> Cancel
        </Button>
      </div>
    </div>
  );
};

// ─── Row Filters Section ──────────────────────────────────────────────────────

const FILTER_OPERATORS = [
  { value: 'equals',       label: 'equals' },
  { value: 'not_equals',   label: 'not equals' },
  { value: 'contains',     label: 'contains' },
  { value: 'not_contains', label: 'not contains' },
  { value: 'gt',           label: 'greater than' },
  { value: 'lt',           label: 'less than' },
  { value: 'is_empty',     label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const needsValue = (op) => !['is_empty', 'is_not_empty'].includes(op);

const FiltersSection = ({ filters, rawColumns, onChange }) => {
  const addFilter = () => {
    onChange([...filters, {
      id:       `filter_${Date.now()}`,
      column:   rawColumns[0] || '',
      operator: 'equals',
      value:    ''
    }]);
  };

  const updateFilter = (id, field, val) =>
    onChange(filters.map(f => f.id === id ? { ...f, [field]: val } : f));

  const removeFilter = (id) =>
    onChange(filters.filter(f => f.id !== id));

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
          Row Filters
          {filters.length > 0 && (
            <span className="ml-2 normal-case font-normal text-emerald-600">
              ({filters.length} active)
            </span>
          )}
        </Label>
        <button
          type="button"
          onClick={addFilter}
          disabled={rawColumns.length === 0}
          className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-800 font-medium disabled:opacity-40"
        >
          <Plus className="h-3 w-3" /> Add Filter
        </button>
      </div>

      {filters.length === 0 ? (
        <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">
          No filters — all rows included
        </div>
      ) : (
        <div className="space-y-1.5">
          {filters.map((f, i) => (
            <div key={f.id} className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 rounded-lg px-2.5 py-2">
              <span className="text-xs font-semibold text-emerald-700 shrink-0 w-10">
                {i === 0 ? 'WHERE' : 'AND'}
              </span>
              <select
                value={f.column}
                onChange={e => updateFilter(f.id, 'column', e.target.value)}
                className="flex-1 min-w-0 h-7 text-xs border border-emerald-200 rounded bg-white px-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              >
                {rawColumns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={f.operator}
                onChange={e => updateFilter(f.id, 'operator', e.target.value)}
                className="shrink-0 h-7 text-xs border border-emerald-200 rounded bg-white px-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              >
                {FILTER_OPERATORS.map(op => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
              {needsValue(f.operator) && (
                <input
                  type="text"
                  value={f.value}
                  onChange={e => updateFilter(f.id, 'value', e.target.value)}
                  placeholder="value"
                  className="w-24 h-7 text-xs border border-emerald-200 rounded bg-white px-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
              )}
              <button
                type="button"
                onClick={() => removeFilter(f.id)}
                className="p-1 rounded hover:bg-red-100 text-emerald-400 hover:text-red-500 shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Field Suggest Input ──────────────────────────────────────────────────────

const FieldSuggestInput = ({ value, onChange, suggestions, placeholder, className }) => {
  const [open, setOpen] = useState(false);
  const filtered = suggestions.filter(s =>
    !value || s.toLowerCase().includes(value.toLowerCase())
  );

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className={className}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-0.5 left-0 right-0 bg-white border border-violet-200 rounded-lg shadow-lg max-h-36 overflow-y-auto">
          {filtered.map(f => (
            <button
              key={f}
              type="button"
              onMouseDown={() => { onChange(f); setOpen(false); }}
              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-violet-50 text-slate-700"
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Add Master Data Column Form ──────────────────────────────────────────────

const AddMasterColumnForm = ({ rawColumns, agentId, onAdd, onCancel }) => {
  const [mode,         setMode]         = useState('lookup'); // 'lookup' | 'validate'
  const [label,        setLabel]        = useState('');
  const [masterType,   setMasterType]   = useState('sku');
  const [lookupColumn, setLookupColumn] = useState(rawColumns[0] || '');
  const [matchField,   setMatchField]   = useState('');
  const [returnField,  setReturnField]  = useState('');
  const [matchLabel,   setMatchLabel]   = useState('Matched');
  const [noMatchLabel, setNoMatchLabel] = useState('Not Matched');
  const [schema,       setSchema]       = useState({ sku: [], ledger: [] });
  const [loadingSchema, setLoadingSchema] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    setLoadingSchema(true);
    api.get(`/api/agents/${agentId}/master-schema`)
      .then(res => setSchema(res.data || { sku: [], ledger: [] }))
      .catch(() => {})
      .finally(() => setLoadingSchema(false));
  }, [agentId]);

  const fields = masterType === 'sku' ? schema.sku : schema.ledger;

  const handleAdd = () => {
    if (!label.trim())      { toast.error('Column name required'); return; }
    if (!lookupColumn)      { toast.error('Select a lookup column'); return; }
    if (!matchField.trim()) { toast.error('Match field is required'); return; }
    if (mode === 'lookup') {
      if (!returnField.trim()) { toast.error('Return field is required'); return; }
      onAdd({ label: label.trim(), type: 'master_lookup', masterType, lookupColumn, matchField: matchField.trim(), returnField: returnField.trim() });
    } else {
      onAdd({ label: label.trim(), type: 'master_validate', masterType, lookupColumn, matchField: matchField.trim(), matchLabel: matchLabel.trim() || 'Matched', noMatchLabel: noMatchLabel.trim() || 'Not Matched' });
    }
  };

  return (
    <div className="border border-violet-200 bg-violet-50 rounded-lg p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide">New Master Data Column</p>
        {/* Mode toggle */}
        <div className="flex rounded-md overflow-hidden border border-violet-300 text-xs">
          <button type="button"
            onClick={() => setMode('lookup')}
            className={`px-2.5 py-1 font-medium transition-colors ${mode === 'lookup' ? 'bg-violet-600 text-white' : 'bg-white text-violet-600 hover:bg-violet-50'}`}>
            Lookup
          </button>
          <button type="button"
            onClick={() => setMode('validate')}
            className={`px-2.5 py-1 font-medium transition-colors ${mode === 'validate' ? 'bg-teal-600 text-white' : 'bg-white text-teal-600 hover:bg-teal-50'}`}>
            Validate
          </button>
        </div>
      </div>

      {mode === 'validate' && (
        <p className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded px-2 py-1">
          Checks if the sheet column value exists in master data — returns a matched/not-matched label.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-slate-600">Column Name *</Label>
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. State Check" className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs text-slate-600">Master Type *</Label>
          <select
            value={masterType}
            onChange={e => { setMasterType(e.target.value); setMatchField(''); setReturnField(''); }}
            className="mt-1 w-full h-8 text-sm border border-slate-200 rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-violet-400 bg-white"
          >
            <option value="sku">SKU Master</option>
            <option value="ledger">Ledger Master</option>
          </select>
        </div>
      </div>

      <div>
        <Label className="text-xs text-slate-600">Sheet Column to Compare *</Label>
        <select
          value={lookupColumn}
          onChange={e => setLookupColumn(e.target.value)}
          className="mt-1 w-full h-8 text-xs border border-slate-200 rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-violet-400 bg-white"
        >
          {rawColumns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Master field pills */}
      {loadingSchema ? (
        <p className="text-xs text-violet-400 flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading master fields…
        </p>
      ) : fields.length > 0 ? (
        <div className="rounded-lg border border-violet-200 bg-white/70 p-2">
          <p className="text-xs text-violet-500 mb-1.5">
            Available fields in {masterType === 'sku' ? 'SKU' : 'Ledger'} master:
          </p>
          <div className="flex flex-wrap gap-1">
            {fields.map(f => (
              <span key={f} className="rounded px-2 py-0.5 text-xs font-medium bg-violet-100 text-violet-700 select-all cursor-text">
                {f}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-400">
          No master data uploaded for this agent yet — type field names manually.
        </p>
      )}

      <div>
        <Label className="text-xs text-slate-600">Master Field to Compare Against *</Label>
        <div className="mt-1">
          <FieldSuggestInput
            value={matchField}
            onChange={setMatchField}
            suggestions={fields}
            placeholder="e.g. States"
            className="h-8 text-xs"
          />
        </div>
      </div>

      {mode === 'lookup' ? (
        <div>
          <Label className="text-xs text-slate-600">Return Field (from master) *</Label>
          <div className="mt-1">
            <FieldSuggestInput
              value={returnField}
              onChange={setReturnField}
              suggestions={fields}
              placeholder="e.g. Ledger"
              className="h-8 text-xs"
            />
          </div>
          {matchField && returnField && lookupColumn && (
            <p className="text-xs text-violet-600 bg-violet-100 rounded px-2 py-1 mt-1.5">
              Row's <strong>{lookupColumn}</strong> → matches master's <strong>{matchField}</strong> → returns <strong>{returnField}</strong>
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-slate-600">If Found</Label>
            <Input value={matchLabel} onChange={e => setMatchLabel(e.target.value)} placeholder="Matched" className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs text-slate-600">If Not Found</Label>
            <Input value={noMatchLabel} onChange={e => setNoMatchLabel(e.target.value)} placeholder="Not Matched" className="mt-1 h-8 text-xs" />
          </div>
          {matchField && lookupColumn && (
            <p className="col-span-2 text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded px-2 py-1">
              Checks if <strong>{lookupColumn}</strong> exists in master's <strong>{matchField}</strong> column → <strong>{matchLabel || 'Matched'}</strong> / <strong>{noMatchLabel || 'Not Matched'}</strong>
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleAdd} className={`h-7 text-xs text-white ${mode === 'validate' ? 'bg-teal-600 hover:bg-teal-700' : 'bg-violet-600 hover:bg-violet-700'}`}>
          <Check className="h-3 w-3 mr-1" /> Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-xs">
          <X className="h-3 w-3 mr-1" /> Cancel
        </Button>
      </div>
    </div>
  );
};

// ─── Group By Section ─────────────────────────────────────────────────────────

const AGG_OPTIONS = [
  { value: 'sum',    label: 'Sum' },
  { value: 'avg',    label: 'Average' },
  { value: 'count',  label: 'Count' },
  { value: 'min',    label: 'Min' },
  { value: 'max',    label: 'Max' },
  { value: 'first',  label: 'First' },
  { value: 'last',   label: 'Last' },
  { value: 'concat', label: 'Concat' },
];

const GroupBySection = ({ sheet, onChange }) => {
  const groupBy     = sheet.groupBy || { enabled: false, columns: [], aggregations: {} };
  const allColLabels = [...(sheet.columns || [])].sort((a, b) => a.order - b.order).map(c => c.label).filter(Boolean);
  const groupCols    = groupBy.columns || [];
  const nonGroupCols = allColLabels.filter(l => !groupCols.includes(l));

  const update = (patch) => onChange({ ...sheet, groupBy: { ...groupBy, ...patch } });

  const toggleGroupCol = (label) => {
    const next = groupCols.includes(label)
      ? groupCols.filter(c => c !== label)
      : [...groupCols, label];
    update({ columns: next });
  };

  const setAgg = (label, method) =>
    update({ aggregations: { ...(groupBy.aggregations || {}), [label]: method } });

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
          Group By
          {groupBy.enabled && groupCols.length > 0 && (
            <span className="ml-2 normal-case font-normal text-teal-600">
              ({groupCols.length} column{groupCols.length !== 1 ? 's' : ''})
            </span>
          )}
        </Label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={!!groupBy.enabled}
            onChange={e => update({ enabled: e.target.checked })}
            disabled={allColLabels.length === 0}
            className="rounded border-slate-300 text-teal-600 h-3.5 w-3.5 cursor-pointer"
          />
          <span className="text-xs text-slate-500">Enable</span>
        </label>
      </div>

      {!groupBy.enabled ? (
        <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">
          Disabled — all rows output individually
        </div>
      ) : allColLabels.length === 0 ? (
        <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">
          Add columns first
        </div>
      ) : (
        <div className="space-y-2">
          {/* Group-key columns */}
          <div className="border border-teal-200 bg-teal-50 rounded-lg p-2.5">
            <p className="text-xs font-semibold text-teal-800 mb-1.5">Group by these columns:</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-28 overflow-y-auto">
              {allColLabels.map(col => (
                <label key={col} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={groupCols.includes(col)}
                    onChange={() => toggleGroupCol(col)}
                    className="rounded border-teal-300 text-teal-600 h-3.5 w-3.5 cursor-pointer"
                  />
                  <span className="text-xs text-teal-900 truncate">{col}</span>
                </label>
              ))}
            </div>
            {groupCols.length === 0 && (
              <p className="text-xs text-teal-400 mt-1.5">Select at least one column</p>
            )}
          </div>

          {/* Aggregation for remaining columns */}
          {groupCols.length > 0 && nonGroupCols.length > 0 && (
            <div className="border border-slate-200 bg-slate-50 rounded-lg p-2.5">
              <p className="text-xs font-semibold text-slate-600 mb-1.5">Aggregate remaining columns:</p>
              <div className="space-y-1">
                {nonGroupCols.map(col => (
                  <div key={col} className="flex items-center gap-2">
                    <span className="text-xs text-slate-700 flex-1 min-w-0 truncate">{col}</span>
                    <select
                      value={(groupBy.aggregations || {})[col] || 'sum'}
                      onChange={e => setAgg(col, e.target.value)}
                      className="shrink-0 h-6 text-xs border border-slate-200 rounded bg-white px-1.5 focus:outline-none focus:ring-1 focus:ring-teal-400"
                    >
                      {AGG_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Sheet Editor Panel ────────────────────────────────────────────────────────

const SheetEditor = ({ sheet, sheetIndex, allSheets, rawColumns, availableRawSheets = [], agentId, fileInputs = [], perFileSheets = {}, onChange }) => {
  // When multiple file inputs exist, derive which file's sheets to show
  const activeFileInputId = sheet.fileInputId || fileInputs[0]?.id || 'file_0';
  const activeFileSheets  = fileInputs.length > 1
    ? (perFileSheets[activeFileInputId] || [])
    : availableRawSheets;

  const effectiveRawCols = React.useMemo(() => {
    if (sheet.sourceType === 'prev_sheet' && sheet.prevSheetName) {
      const prev = allSheets.slice(0, sheetIndex).find(s => s.name === sheet.prevSheetName);
      return prev ? getPrevSheetOutputCols(prev) : [];
    }
    const sheetsToSearch = fileInputs.length > 1 ? activeFileSheets : availableRawSheets;
    if (sheet.rawSheetName && sheetsToSearch.length > 0) {
      return sheetsToSearch.find(s => s.name === sheet.rawSheetName)?.columns || rawColumns;
    }
    return sheetsToSearch[0]?.columns || rawColumns;
  }, [sheet.sourceType, sheet.prevSheetName, sheet.rawSheetName, activeFileSheets, availableRawSheets, rawColumns, allSheets, sheetIndex, fileInputs.length]);
  const [showAddComputed, setShowAddComputed] = useState(false);
  const [showAddExcel,    setShowAddExcel]    = useState(false);
  const [showAddMaster,   setShowAddMaster]   = useState(false);
  const [editingColId,    setEditingColId]    = useState(null);
  const [editLabel,       setEditLabel]       = useState('');
  const [editFormula,     setEditFormula]     = useState('');

  const selectedSourceKeys = new Set(
    sheet.columns.filter(c => c.type === 'source').map(c => c.key)
  );

  // Track which prev-sheet columns are already included (by their refKey = "SheetName.ColLabel")
  const includedPrevRefs = new Set(
    sheet.columns
      .filter(c => c.type === 'computed' && c._prevSheetRef)
      .map(c => c._prevSheetRef)
  );

  // All columns from previous sheets, including merge sheets
  const prevSheetGroups = allSheets.slice(0, sheetIndex).map(s => {
    const colLabels = getPrevSheetOutputCols(s);
    const columns   = colLabels.map(lbl => ({ id: lbl, key: lbl, label: lbl, type: s.type === 'merge' ? 'source' : (s.columns.find(c => c.label === lbl)?.type || 'source') }));
    return { sheetId: s.id, sheetName: s.name, isMerge: s.type === 'merge', columns };
  }).filter(g => g.columns.length > 0);

  // Toggle a raw-file column in/out of this sheet
  const toggleSource = (rawKey) => {
    if (selectedSourceKeys.has(rawKey)) {
      onChange({
        ...sheet,
        columns: sheet.columns
          .filter(c => !(c.type === 'source' && c.key === rawKey))
          .map((c, i) => ({ ...c, order: i }))
      });
    } else {
      onChange({
        ...sheet,
        columns: [
          ...sheet.columns,
          { id: makeColId(), key: rawKey, label: rawKey, type: 'source', order: sheet.columns.length }
        ]
      });
    }
  };

  // Toggle a prev-sheet column in/out of this sheet (adds as computed col with reference formula)
  const togglePrevSheetCol = (sheetName, colLabel) => {
    const refKey = `${sheetName}.${colLabel}`;
    if (includedPrevRefs.has(refKey)) {
      // Remove it
      onChange({
        ...sheet,
        columns: sheet.columns
          .filter(c => !(c.type === 'computed' && c._prevSheetRef === refKey))
          .map((c, i) => ({ ...c, order: i }))
      });
    } else {
      // Add as computed col with direct reference formula
      const key = `ref_${refKey.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
      onChange({
        ...sheet,
        columns: [
          ...sheet.columns,
          {
            id:            makeColId(),
            key,
            label:         colLabel,
            type:          'computed',
            formula:       `{${refKey}}`,
            _prevSheetRef: refKey,
            order:         sheet.columns.length
          }
        ]
      });
    }
  };

  const addComputed = ({ label, formula }) => {
    const key = `computed_${label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}_${Date.now()}`;
    onChange({
      ...sheet,
      columns: [
        ...sheet.columns,
        { id: makeColId(), key, label, type: 'computed', formula, order: sheet.columns.length }
      ]
    });
    setShowAddComputed(false);
  };

  const addExcel = ({ label, formula }) => {
    const key = `excel_${label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}_${Date.now()}`;
    onChange({
      ...sheet,
      columns: [
        ...sheet.columns,
        { id: makeColId(), key, label, type: 'excel', formula, order: sheet.columns.length }
      ]
    });
    setShowAddExcel(false);
  };

  const addMasterColumn = (colDef) => {
    const key = `master_${colDef.label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}_${Date.now()}`;
    onChange({
      ...sheet,
      columns: [
        ...sheet.columns,
        { id: makeColId(), key, order: sheet.columns.length, ...colDef }
      ]
    });
    setShowAddMaster(false);
  };

  const deleteMasterCol = (colId) => {
    onChange({
      ...sheet,
      columns: sheet.columns.filter(c => c.id !== colId).map((c, i) => ({ ...c, order: i }))
    });
  };

  const updateFilters = (newFilters) => {
    onChange({ ...sheet, filters: newFilters });
  };

  const deleteComputed = (colId) => {
    onChange({
      ...sheet,
      columns: sheet.columns.filter(c => c.id !== colId).map((c, i) => ({ ...c, order: i }))
    });
  };

  const startEditComputed = (col) => {
    setEditingColId(col.id);
    setEditLabel(col.label);
    setEditFormula(col.formula || '');
  };

  const saveEditComputed = () => {
    if (!editLabel.trim())   { toast.error('Column name required'); return; }
    if (!editFormula.trim()) { toast.error('Formula required');     return; }
    onChange({
      ...sheet,
      columns: sheet.columns.map(c =>
        c.id === editingColId ? { ...c, label: editLabel.trim(), formula: editFormula.trim() } : c
      )
    });
    setEditingColId(null);
  };

  const derivedCols = sheet.columns.filter(c => c.type === 'computed' || c.type === 'excel');
  const masterCols  = sheet.columns.filter(c => c.type === 'master_lookup' || c.type === 'master_validate');

  // For the formula builder: up to end of current computed col list (or end for new)
  const formulaColumnsForNew = getFormulaColumns(sheetIndex, allSheets, sheet.columns.length);
  const formulaColumnsForEdit = (colId) => {
    const idx = sheet.columns.findIndex(c => c.id === colId);
    return getFormulaColumns(sheetIndex, allSheets, idx);
  };

  return (
    <div className="space-y-4">
      {/* Source file selector (only when workflow has multiple file inputs) */}
      {fileInputs.length > 1 && (
        <div>
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide block mb-1.5">
            Source File
          </Label>
          <div className="flex gap-2 flex-wrap">
            {fileInputs.map((fi, i) => (
              <button
                key={fi.id}
                type="button"
                onClick={() => onChange({ ...sheet, fileInputId: fi.id, rawSheetName: null, columns: [] })}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                  activeFileInputId === fi.id
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-indigo-300'
                }`}
              >
                <span className="w-4 h-4 rounded-full bg-indigo-200 text-indigo-800 text-[10px] font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                {fi.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Source rows picker */}
      {(activeFileSheets.length > 1 || sheetIndex > 0) && (
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide block">
            Source Rows From
          </Label>
          <div className="flex gap-2">
            <button type="button"
              onClick={() => onChange({ ...sheet, sourceType: 'raw', prevSheetName: null, columns: [] })}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                (sheet.sourceType || 'raw') === 'raw' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-500 hover:border-indigo-300'
              }`}>
              Raw Input File
            </button>
            {sheetIndex > 0 && (
              <button type="button"
                onClick={() => onChange({ ...sheet, sourceType: 'prev_sheet', rawSheetName: null, columns: [] })}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                  sheet.sourceType === 'prev_sheet' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-500 hover:border-indigo-300'
                }`}>
                Previous Sheet Output
              </button>
            )}
          </div>

          {(sheet.sourceType || 'raw') === 'raw' && activeFileSheets.length > 1 && (
            <select value={sheet.rawSheetName || ''}
              onChange={e => onChange({ ...sheet, rawSheetName: e.target.value || null, columns: [] })}
              className="w-full h-8 text-xs border border-slate-200 rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white">
              <option value="">— auto (first sheet) —</option>
              {activeFileSheets.map(s => (
                <option key={s.name} value={s.name}>{s.name} ({s.columns.length} cols)</option>
              ))}
            </select>
          )}

          {sheet.sourceType === 'prev_sheet' && (
            <select value={sheet.prevSheetName || ''}
              onChange={e => onChange({ ...sheet, prevSheetName: e.target.value || null, columns: [] })}
              className="w-full h-8 text-xs border border-slate-200 rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white">
              <option value="">— select sheet —</option>
              {allSheets.slice(0, sheetIndex).map(s => (
                <option key={s.id} value={s.name}>
                  {s.type === 'merge' ? '⊕ ' : ''}{s.name} ({getPrevSheetOutputCols(s).length} cols)
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Row filters */}
      <FiltersSection
        filters={sheet.filters || []}
        rawColumns={effectiveRawCols}
        onChange={updateFilters}
      />

      {/* Source columns from raw file */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
            {sheet.sourceType === 'prev_sheet' ? `Columns from "${sheet.prevSheetName || '...'}"` : 'Source Columns from File'}
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">{selectedSourceKeys.size}/{effectiveRawCols.length} selected</span>
            {effectiveRawCols.length > 0 && (
              <button type="button"
                onClick={() => {
                  const allSelected = effectiveRawCols.every(col => selectedSourceKeys.has(col));
                  if (allSelected) {
                    onChange({ ...sheet, columns: sheet.columns.filter(c => c.type !== 'source').map((c, i) => ({ ...c, order: i })) });
                  } else {
                    const existing = sheet.columns.filter(c => c.type !== 'source');
                    const newSrc   = effectiveRawCols
                      .filter(col => !selectedSourceKeys.has(col))
                      .map((col, i) => ({ id: makeColId(), key: col, label: col, type: 'source', order: existing.length + i }));
                    onChange({ ...sheet, columns: [...existing, ...newSrc].map((c, i) => ({ ...c, order: i })) });
                  }
                }}
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
                {effectiveRawCols.every(col => selectedSourceKeys.has(col)) ? 'Deselect all' : 'Select all'}
              </button>
            )}
          </div>
        </div>

        {effectiveRawCols.length === 0 ? (
          <p className="text-xs text-slate-400 py-2">
            {sheet.sourceType === 'prev_sheet' ? 'Select a previous sheet above' : availableRawSheets.length > 1 ? 'Select a source sheet above' : 'No file uploaded yet'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-36 overflow-y-auto border border-slate-200 rounded-lg p-2.5 bg-slate-50">
            {effectiveRawCols.map(col => (
              <label key={col} className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={selectedSourceKeys.has(col)}
                  onChange={() => toggleSource(col)}
                  className="rounded border-slate-300 text-indigo-600 h-3.5 w-3.5 cursor-pointer"
                />
                <span className="text-xs text-slate-700 truncate group-hover:text-slate-900">{col}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Columns from previous sheets (only when sheetIndex > 0 and prev sheets have columns) */}
      {prevSheetGroups.length > 0 && (
        <div>
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5 block">
            Columns from Previous Sheets
          </Label>
          <div className="space-y-2">
            {prevSheetGroups.map(group => (
              <div key={group.sheetId} className="border border-amber-200 rounded-lg p-2.5 bg-amber-50">
                <p className="text-xs font-semibold text-amber-800 mb-1.5 flex items-center gap-1">
                  <TableIcon className="h-3 w-3" /> {group.sheetName}
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {group.columns.map(col => {
                    const refKey  = `${group.sheetName}.${col.label}`;
                    const checked = includedPrevRefs.has(refKey);
                    return (
                      <label key={col.id || col.key} className="flex items-center gap-2 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePrevSheetCol(group.sheetName, col.label)}
                          className="rounded border-amber-300 text-amber-600 h-3.5 w-3.5 cursor-pointer"
                        />
                        <span className="text-xs text-amber-900 truncate group-hover:text-amber-700 flex items-center gap-1">
                          {col.type === 'computed' && <span className="text-amber-500">✦</span>}
                          {col.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-1.5">
            Checked columns are included as-is from that sheet's output.
          </p>
        </div>
      )}

      {/* Computed columns — Math + Excel */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
            Computed Columns
          </Label>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => { setShowAddComputed(true); setShowAddExcel(false); setEditingColId(null); }}
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded px-2 py-0.5 bg-white hover:bg-indigo-50"
            >
              <Plus className="h-3 w-3" /> Math
            </button>
            <button
              type="button"
              onClick={() => { setShowAddExcel(true); setShowAddComputed(false); setEditingColId(null); }}
              className="inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:text-sky-800 border border-sky-200 rounded px-2 py-0.5 bg-white hover:bg-sky-50"
            >
              <Plus className="h-3 w-3" /> Excel
            </button>
          </div>
        </div>

        {derivedCols.length === 0 && !showAddComputed && !showAddExcel && (
          <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">
            No computed columns. Add a <strong>Math</strong> column for per-row formulas or an <strong>Excel</strong> column for SUMIF / VLOOKUP.
          </div>
        )}

        <div className="space-y-1.5">
          {derivedCols.map((col) => {
            const isExcel = col.type === 'excel';
            return (
              <div key={col.id} className={`border rounded-lg p-2.5 ${isExcel ? 'border-sky-200 bg-sky-50' : 'border-amber-200 bg-amber-50'}`}>
                {editingColId === col.id ? (
                  <div className="space-y-2">
                    <Input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                      className="h-7 text-sm" placeholder="Column name" />
                    {isExcel ? (
                      <ExcelFormulaBuilder formula={editFormula} onChange={setEditFormula}
                        availableColumns={formulaColumnsForEdit(col.id)} />
                    ) : (
                      <FormulaBuilder formula={editFormula} onChange={setEditFormula}
                        availableColumns={formulaColumnsForEdit(col.id)} />
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveEditComputed} className="h-6 text-xs">
                        <Check className="h-3 w-3 mr-1" /> Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingColId(null)} className="h-6 text-xs">
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {isExcel && (
                          <span className="text-[10px] font-bold bg-sky-600 text-white px-1 py-px rounded leading-none">Σ</span>
                        )}
                        <span className={`text-sm font-medium ${isExcel ? 'text-sky-900' : 'text-amber-900'}`}>{col.label}</span>
                      </div>
                      <p className={`text-xs font-mono mt-0.5 break-all ${isExcel ? 'text-sky-600' : 'text-amber-600'}`}>{col.formula}</p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button type="button" onClick={() => startEditComputed(col)}
                        className={`p-1 rounded ${isExcel ? 'hover:bg-sky-100 text-sky-500' : 'hover:bg-amber-100 text-amber-500'}`}>
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => deleteComputed(col.id)}
                        className={`p-1 rounded hover:bg-red-100 ${isExcel ? 'text-sky-400' : 'text-amber-500'} hover:text-red-500`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {showAddComputed && (
            <AddComputedColumnForm availableColumns={formulaColumnsForNew}
              onAdd={addComputed} onCancel={() => setShowAddComputed(false)} />
          )}
          {showAddExcel && (
            <AddExcelColumnForm availableColumns={formulaColumnsForNew}
              onAdd={addExcel} onCancel={() => setShowAddExcel(false)} />
          )}
        </div>
      </div>

      {/* Master data columns */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
            Master Data Columns
          </Label>
          <button
            type="button"
            onClick={() => { setShowAddMaster(true); setShowAddComputed(false); }}
            disabled={effectiveRawCols.length === 0}
            className="inline-flex items-center gap-1 text-xs text-violet-600 hover:text-violet-800 font-medium disabled:opacity-40"
          >
            <Plus className="h-3 w-3" /> Add Lookup Column
          </button>
        </div>

        {masterCols.length === 0 && !showAddMaster && (
          <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">
            No master lookups or validations. Click "Add Lookup Column" to map SKU/Ledger data.
          </div>
        )}

        <div className="space-y-1.5">
          {masterCols.map(col => {
            const isValidate = col.type === 'master_validate';
            return (
              <div key={col.id} className={`flex items-start justify-between gap-2 border rounded-lg p-2.5 ${isValidate ? 'border-teal-200 bg-teal-50' : 'border-violet-200 bg-violet-50'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-sm font-medium ${isValidate ? 'text-teal-900' : 'text-violet-900'}`}>{col.label}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-px rounded ${isValidate ? 'bg-teal-200 text-teal-700' : 'bg-violet-200 text-violet-700'}`}>
                      {isValidate ? 'VALIDATE' : 'LOOKUP'}
                    </span>
                  </div>
                  <p className={`text-xs mt-0.5 ${isValidate ? 'text-teal-600' : 'text-violet-600'}`}>
                    {col.masterType === 'sku' ? 'SKU' : 'Ledger'} master · compare <em>{col.lookupColumn}</em> → <em>{col.matchField}</em>
                    {isValidate
                      ? <> · <strong>{col.matchLabel || 'Matched'}</strong> / <strong>{col.noMatchLabel || 'Not Matched'}</strong></>
                      : <> · return <em>{col.returnField}</em></>}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteMasterCol(col.id)}
                  className={`p-1 rounded hover:bg-red-100 shrink-0 ${isValidate ? 'text-teal-400' : 'text-violet-400'} hover:text-red-500`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}

          {showAddMaster && (
            <AddMasterColumnForm
              rawColumns={effectiveRawCols}
              agentId={agentId}
              onAdd={addMasterColumn}
              onCancel={() => setShowAddMaster(false)}
            />
          )}
        </div>
      </div>

      {/* Group by */}
      <GroupBySection sheet={sheet} onChange={onChange} />

      {/* Preview of column order */}
      {sheet.columns.length > 0 && (
        <div>
          <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
            Output Column Order
          </Label>
          <div className="flex flex-wrap gap-1">
            {[...sheet.columns]
              .sort((a, b) => a.order - b.order)
              .map(col => (
                <span
                  key={col.id}
                  className={`rounded px-2 py-0.5 text-xs ${
                    col.type === 'source'
                      ? 'bg-slate-100 text-slate-600'
                      : col.type === 'master_lookup'
                        ? 'bg-violet-100 text-violet-700'
                        : col.type === 'master_validate'
                          ? 'bg-teal-100 text-teal-700'
                          : col.type === 'excel'
                            ? 'bg-sky-100 text-sky-700'
                            : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {col.type === 'computed' ? '✦ ' : col.type === 'excel' ? 'Σ ' : col.type === 'master_lookup' ? '⬡ ' : col.type === 'master_validate' ? '✓ ' : ''}{col.label}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Merge Sheet Editor ───────────────────────────────────────────────────────

const MERGE_TYPES = [
  { value: 'join',           label: 'JOIN',    desc: 'Match rows by a key column (left join)' },
  { value: 'stack',          label: 'STACK',   desc: 'Append rows from all sources top-to-bottom' },
  { value: 'column_combine', label: 'COMBINE', desc: 'Zip rows side-by-side (same row index)' },
];

const MergeSheetEditor = ({ sheet, sheetIndex, allSheets, availableRawSheets, onChange }) => {
  const mc = sheet.mergeConfig || {
    mergeType: 'join',
    sources: [
      { type: 'raw', sheetName: '', columns: [], joinKey: '' },
      { type: 'raw', sheetName: '', columns: [], joinKey: '' },
    ]
  };

  const updateMC     = (patch) => onChange({ ...sheet, mergeConfig: { ...mc, ...patch } });
  const updateSource = (idx, patch) => {
    const sources = mc.sources.map((s, i) => i === idx ? { ...s, ...patch } : s);
    updateMC({ sources });
  };
  const addSource    = () => updateMC({ sources: [...mc.sources, { type: 'raw', sheetName: '', columns: [], joinKey: '' }] });
  const removeSource = (idx) => {
    if (mc.sources.length <= 2) { toast.error('At least 2 sources required'); return; }
    updateMC({ sources: mc.sources.filter((_, i) => i !== idx) });
  };

  const getAvailableSheetNames = (srcType) => {
    if (srcType === 'raw') return availableRawSheets.map(s => s.name);
    return allSheets.slice(0, sheetIndex).filter(s => s.type !== 'merge').map(s => s.name);
  };

  const getSourceCols = (src) => {
    if (!src.sheetName) return [];
    if (src.type === 'raw') return availableRawSheets.find(s => s.name === src.sheetName)?.columns || [];
    const prev = allSheets.slice(0, sheetIndex).find(s => s.name === src.sheetName);
    return prev ? prev.columns.map(c => c.label).filter(Boolean) : [];
  };

  const toggleCol = (srcIdx, col) => {
    const cols = mc.sources[srcIdx].columns || [];
    updateSource(srcIdx, { columns: cols.includes(col) ? cols.filter(c => c !== col) : [...cols, col] });
  };

  const srcLabels = ['Source A', 'Source B', 'Source C', 'Source D'];
  const srcColors = [
    { border: 'border-blue-200',   bg: 'bg-blue-50',   badge: 'bg-blue-100 text-blue-700',   check: 'text-blue-600' },
    { border: 'border-orange-200', bg: 'bg-orange-50', badge: 'bg-orange-100 text-orange-700', check: 'text-orange-600' },
    { border: 'border-green-200',  bg: 'bg-green-50',  badge: 'bg-green-100 text-green-700',  check: 'text-green-600' },
    { border: 'border-rose-200',   bg: 'bg-rose-50',   badge: 'bg-rose-100 text-rose-700',    check: 'text-rose-600' },
  ];

  return (
    <div className="space-y-4">
      {/* Merge type */}
      <div>
        <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5 block">Merge Type</Label>
        <div className="grid grid-cols-3 gap-2">
          {MERGE_TYPES.map(t => (
            <button key={t.value} type="button"
              onClick={() => updateMC({ mergeType: t.value })}
              className={`rounded-lg border p-2.5 text-left transition-all ${
                mc.mergeType === t.value ? 'border-purple-400 bg-purple-50' : 'border-slate-200 bg-white hover:border-purple-200'
              }`}>
              <div className={`text-xs font-bold mb-0.5 ${mc.mergeType === t.value ? 'text-purple-700' : 'text-slate-600'}`}>{t.label}</div>
              <div className="text-xs text-slate-400 leading-tight">{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Common join column (JOIN type only) */}
      {mc.mergeType === 'join' && (
        <div>
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5 block">
            Common Join Column *
          </Label>
          <p className="text-xs text-purple-600 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 mb-2">
            The column that exists in <strong>all</strong> sheets with matching values — rows are joined where this column's value matches (e.g. "SKU", "Invoice No").
          </p>
          <FieldSuggestInput
            value={mc.commonJoinKey || ''}
            onChange={val => updateMC({ commonJoinKey: val })}
            suggestions={getSourceCols(mc.sources[0])}
            placeholder="e.g. SKU or Invoice No"
            className="h-8 text-sm"
          />
          {mc.commonJoinKey && mc.sources.length > 1 && mc.sources.every(s => s.sheetName) && (
            <p className="text-xs text-purple-500 mt-1.5">
              Joining {mc.sources.length} sheets on <strong>{mc.commonJoinKey}</strong> (sequential left join)
            </p>
          )}
        </div>
      )}

      {/* Sources */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Sources</Label>
          {(mc.mergeType === 'stack' || mc.mergeType === 'join') && (
            <button type="button" onClick={addSource}
              className="inline-flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 font-medium">
              <Plus className="h-3 w-3" /> Add Source
            </button>
          )}
        </div>

        {mc.sources.map((src, srcIdx) => {
          const avail    = getSourceCols(src);
          const selected = src.columns || [];
          const color    = srcColors[srcIdx] || srcColors[0];
          const lbl      = srcLabels[srcIdx] || `Source ${srcIdx + 1}`;

          return (
            <div key={srcIdx} className={`border ${color.border} ${color.bg} rounded-lg p-3 space-y-2.5`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">{lbl}</span>
                {mc.sources.length > 2 && (
                  <button type="button" onClick={() => removeSource(srcIdx)}
                    className="p-1 rounded hover:bg-red-100 text-slate-400 hover:text-red-500">
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>

              {/* Source type */}
              <div className="flex gap-2">
                {['raw', 'output'].map(t => (
                  <button key={t} type="button"
                    onClick={() => updateSource(srcIdx, { type: t, sheetName: '', columns: [], joinKey: '' })}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      src.type === t ? 'bg-purple-600 text-white' : 'bg-white border border-purple-200 text-purple-600 hover:bg-purple-50'
                    }`}>
                    {t === 'raw' ? 'Raw Input Sheet' : 'Processed Output Sheet'}
                  </button>
                ))}
              </div>

              {/* Sheet picker */}
              <div>
                <Label className="text-xs text-slate-600">{src.type === 'raw' ? 'Input sheet' : 'Output sheet'} *</Label>
                <select value={src.sheetName}
                  onChange={e => updateSource(srcIdx, { sheetName: e.target.value, columns: [], joinKey: '' })}
                  className="mt-1 w-full h-8 text-xs border border-slate-200 rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white">
                  <option value="">— select sheet —</option>
                  {getAvailableSheetNames(src.type).map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>

              {/* Join key — only for legacy 2-source joins without a commonJoinKey */}
              {mc.mergeType === 'join' && !mc.commonJoinKey && avail.length > 0 && (
                <div>
                  <Label className="text-xs text-slate-600">Join key column *</Label>
                  <select value={src.joinKey || ''}
                    onChange={e => updateSource(srcIdx, { joinKey: e.target.value })}
                    className="mt-1 w-full h-8 text-xs border border-slate-200 rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white">
                    <option value="">— select key —</option>
                    {avail.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}
              {/* Show which common key will be used for this source */}
              {mc.mergeType === 'join' && mc.commonJoinKey && src.sheetName && (
                <p className="text-xs text-purple-600 bg-purple-50 rounded px-2 py-1">
                  Joins on <strong>{mc.commonJoinKey}</strong>
                </p>
              )}

              {/* Column selection */}
              {avail.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-xs text-slate-600">Include columns</Label>
                    <button type="button"
                      onClick={() => updateSource(srcIdx, { columns: selected.length === avail.length ? [] : [...avail] })}
                      className="text-xs text-purple-600 hover:text-purple-800">
                      {selected.length === avail.length ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-32 overflow-y-auto border border-slate-200 rounded-lg p-2 bg-white/70">
                    {avail.map(col => (
                      <label key={col} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={selected.includes(col)}
                          onChange={() => toggleCol(srcIdx, col)}
                          className={`rounded h-3.5 w-3.5 cursor-pointer ${color.check}`} />
                        <span className="text-xs text-slate-700 truncate">{col}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {src.sheetName && avail.length === 0 && (
                <p className="text-xs text-slate-400">No columns available for this sheet</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Output preview */}
      {mc.sources.some(s => (s.columns || []).length > 0) && (
        <div>
          <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
            Output Columns Preview
          </Label>
          <div className="flex flex-wrap gap-1">
            {/* Show join key first if set (from any source) */}
            {mc.mergeType === 'join' && mc.commonJoinKey && (
              <span className="rounded px-2 py-0.5 text-xs font-semibold bg-purple-200 text-purple-800 ring-1 ring-purple-400">
                🔑 {mc.commonJoinKey}
              </span>
            )}
            {mc.sources.flatMap((src, i) => {
              const isJoin = mc.mergeType === 'join';
              return (src.columns || [])
                .filter(col => !(isJoin && mc.commonJoinKey && col === mc.commonJoinKey))
                .map(col => (
                  <span key={`${i}-${col}`}
                    className={`rounded px-2 py-0.5 text-xs ${(srcColors[i] || srcColors[0]).badge}`}>
                    {col}
                  </span>
                ));
            })}
          </div>
          {mc.mergeType === 'join' && mc.commonJoinKey && mc.sources.length > 2 && (
            <p className="text-xs text-slate-400 mt-1">
              {mc.sources.length} sheets joined on "{mc.commonJoinKey}" — all rows from Sheet 1 are kept
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const makeFileInputId = (i) => `file_${i}`;

// ─── Workflow Builder ──────────────────────────────────────────────────────────

const WorkflowBuilder = ({ agent, workflow, onSaved, onCancel }) => {
  // `workflow` is truthy both for a genuine edit AND for an AI-generated draft handed
  // off for review (which has no `id` yet) — isEdit only decides whether to hydrate
  // state and skip to step 2; isPersisted decides POST vs PUT and the header/button text.
  const isEdit = !!workflow;
  const isPersisted = !!workflow?.id;

  const [step,        setStep]        = useState(isEdit ? 2 : 1);
  const [extracting,  setExtracting]  = useState(false);
  const [rawColumns,  setRawColumns]  = useState(workflow?.sample_columns || []);

  // fileInputs: [{id, label}] — one slot per required upload
  const [fileInputs, setFileInputs] = useState(() => {
    if (workflow?.fileInputs?.length) return workflow.fileInputs;
    return [{ id: 'file_0', label: 'Input File' }];
  });
  // sampleFiles: { [fileInputId]: File }
  const [sampleFiles, setSampleFiles] = useState({});
  // perFileSheets: { [fileInputId]: [{name, columns}] }
  const [perFileSheets, setPerFileSheets] = useState({});

  // Flatten all sheets across all file inputs for backwards compat
  const availableRawSheets = Object.values(perFileSheets).flat();

  const [sheets, setSheets] = useState(() => {
    if (workflow?.sheets?.length) return workflow.sheets;
    return [makeSheet('Sheet 1', 0)];
  });
  const [activeId,     setActiveId]     = useState(() =>
    (workflow?.sheets?.[0]?.id) || sheets[0]?.id
  );
  const [name,         setName]         = useState(workflow?.name || '');
  const [description,  setDescription]  = useState(workflow?.description || '');
  const [saving,       setSaving]       = useState(false);
  const [renamingId,   setRenamingId]   = useState(null);
  const [renameValue,  setRenameValue]  = useState('');

  const activeSheet    = sheets.find(s => s.id === activeId) || sheets[0];
  const activeSheetIdx = sheets.findIndex(s => s.id === activeId);

  // ── Sheet management ──

  const addSheet = () => {
    const newSheet = makeSheet(`Sheet ${sheets.length + 1}`, sheets.length);
    setSheets(prev => [...prev, newSheet]);
    setActiveId(newSheet.id);
  };

  const addMergeSheet = () => {
    const mergeCount = sheets.filter(s => s.type === 'merge').length;
    const newSheet   = makeMergeSheet(`Merge ${mergeCount + 1}`, sheets.length);
    setSheets(prev => [...prev, newSheet]);
    setActiveId(newSheet.id);
  };

  const deleteSheet = (id) => {
    if (sheets.length === 1) { toast.error('At least one sheet is required'); return; }
    const next = sheets.filter(s => s.id !== id).map((s, i) => ({ ...s, order: i }));
    setSheets(next);
    if (activeId === id) setActiveId(next[0].id);
  };

  const startRename = (sheet) => {
    setRenamingId(sheet.id);
    setRenameValue(sheet.name);
  };

  const saveRename = () => {
    if (!renameValue.trim()) { toast.error('Sheet name cannot be empty'); return; }
    setSheets(prev => prev.map(s => s.id === renamingId ? { ...s, name: renameValue.trim() } : s));
    setRenamingId(null);
  };

  const updateSheet = (updatedSheet) => {
    setSheets(prev => prev.map(s => s.id === updatedSheet.id ? updatedSheet : s));
  };

  // ── File input management ──

  const updateFileInputLabel = (id, label) =>
    setFileInputs(prev => prev.map(fi => fi.id === id ? { ...fi, label } : fi));

  const addFileInput = () => {
    const newId = makeFileInputId(fileInputs.length);
    setFileInputs(prev => [...prev, { id: newId, label: `File ${prev.length + 1}` }]);
  };

  const removeFileInput = (id) => {
    if (fileInputs.length <= 1) return;
    setFileInputs(prev => prev.filter(fi => fi.id !== id));
    setSampleFiles(prev => { const n = { ...prev }; delete n[id]; return n; });
    setPerFileSheets(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  // ── Step 1: extract columns ──

  const handleExtract = async () => {
    const missing = fileInputs.filter(fi => !sampleFiles[fi.id]);
    if (missing.length > 0) {
      toast.error(`Please select a file for: ${missing.map(fi => fi.label).join(', ')}`);
      return;
    }
    setExtracting(true);
    try {
      const results = {};
      for (const fi of fileInputs) {
        const fd = new FormData();
        fd.append('file', sampleFiles[fi.id]);
        const res = await api.post('/api/workflows/extract-columns', fd, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
        results[fi.id] = res.data.sheets || [];
      }
      setPerFileSheets(results);
      // rawColumns = first file's first sheet (for backwards compat)
      const firstSheets = results[fileInputs[0]?.id] || [];
      setRawColumns(firstSheets[0]?.columns || []);
      setStep(2);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to extract columns');
    } finally {
      setExtracting(false);
    }
  };

  // ── Save ──

  const handleSave = async () => {
    if (!name.trim())       { toast.error('Workflow name is required'); return; }
    if (sheets.length === 0){ toast.error('Add at least one sheet');    return; }
    const emptySheets = sheets.filter(s => s.type !== 'merge' && (s.columns || []).length === 0);
    if (emptySheets.length > 0) {
      toast.error(`Sheet "${emptySheets[0].name}" has no columns selected`);
      return;
    }
    const badMerge = sheets.find(s => s.type === 'merge' && !(s.mergeConfig?.sources || []).every(src => src.sheetName));
    if (badMerge) {
      toast.error(`Merge sheet "${badMerge.name}" has sources with no sheet selected`);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        sample_columns: rawColumns,
        fileInputs,
        sheets: sheets.map((s, i) => ({
          ...s,
          order: i,
          columns: (s.columns || []).map((c, j) => ({ ...c, order: j }))
        }))
      };
      if (isPersisted) {
        await api.put(`/api/workflows/${workflow.id}`, payload);
        toast.success('Workflow updated');
      } else {
        await api.post(`/api/agents/${agent.id}/workflows`, payload);
        toast.success('Workflow created');
      }
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Back + title + top actions */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-slate-100">
            <ChevronLeft className="h-4 w-4 text-slate-500" />
          </button>
          <div>
            <h3 className="font-semibold text-slate-900 text-sm">
              {isPersisted ? 'Edit Workflow' : 'New Workflow'} — {agent.name}
            </h3>
            <p className="text-xs text-slate-500">
              {step === 1 ? 'Step 1 of 2: Upload sample file' : 'Step 2 of 2: Define sheets & columns'}
            </p>
          </div>
        </div>
        {step === 2 && (
          <div className="flex gap-2 shrink-0">
            <Button variant="secondary" size="sm" onClick={onCancel} className="h-8">Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="h-8">
              {saving
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Saving...</>
                : isPersisted ? 'Update Workflow' : 'Save Workflow'}
            </Button>
          </div>
        )}
      </div>

      {/* Step bar */}
      <div className="flex gap-2">
        <div className={`h-1.5 flex-1 rounded-full ${step >= 1 ? 'bg-indigo-500' : 'bg-slate-200'}`} />
        <div className={`h-1.5 flex-1 rounded-full ${step >= 2 ? 'bg-indigo-500' : 'bg-slate-200'}`} />
      </div>

      {/* ── Step 1 ── */}
      {step === 1 && (
        <div className="space-y-4">
          {/* How many files */}
          <div>
            <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide block mb-2">
              How many input files does this workflow need?
            </Label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => removeFileInput(fileInputs[fileInputs.length - 1]?.id)}
                disabled={fileInputs.length <= 1}
                className="w-8 h-8 rounded-lg border border-slate-200 bg-white text-slate-500 font-bold text-lg hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center"
              >
                −
              </button>
              <span className="w-8 text-center text-sm font-bold text-slate-800">{fileInputs.length}</span>
              <button
                type="button"
                onClick={addFileInput}
                className="w-8 h-8 rounded-lg border border-slate-200 bg-white text-slate-500 font-bold text-lg hover:border-indigo-300 hover:text-indigo-600 transition-all flex items-center justify-center"
              >
                +
              </button>
            </div>
          </div>

          {/* Per-file upload areas */}
          <div className="space-y-3">
            {fileInputs.map((fi, i) => (
              <div key={fi.id} className="border border-slate-200 rounded-xl p-4 space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold shrink-0">
                    {i + 1}
                  </span>
                  <input
                    value={fi.label}
                    onChange={e => updateFileInputLabel(fi.id, e.target.value)}
                    className="flex-1 text-sm font-medium text-slate-800 border-none outline-none bg-transparent"
                    placeholder={`File ${i + 1} label`}
                  />
                  {fileInputs.length > 1 && (
                    <button type="button" onClick={() => removeFileInput(fi.id)}
                      className="p-1 rounded hover:bg-red-100 text-slate-400 hover:text-red-500">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <label className="flex items-center gap-3 border border-dashed border-slate-200 rounded-lg px-4 py-3 cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-all">
                  <Upload className="h-4 w-4 text-slate-300 shrink-0" />
                  <span className={`text-sm ${sampleFiles[fi.id] ? 'text-slate-800 font-medium' : 'text-slate-400'}`}>
                    {sampleFiles[fi.id] ? sampleFiles[fi.id].name : 'Choose .xlsx / .xls / .csv'}
                  </span>
                  <input
                    type="file" accept=".xlsx,.xls,.csv" className="hidden"
                    onChange={e => setSampleFiles(prev => ({ ...prev, [fi.id]: e.target.files[0] || undefined }))}
                  />
                </label>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
            <Button
              onClick={handleExtract}
              disabled={fileInputs.some(fi => !sampleFiles[fi.id]) || extracting}
              className="flex-1"
            >
              {extracting
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Extracting...</>
                : `Extract Columns →`}
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          {/* Workflow name + description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Workflow Name *</Label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. GST Summary"
                className="mt-1 h-8 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Optional"
                className="mt-1 h-8 text-sm"
              />
            </div>
          </div>

          {/* Sheet tabs */}
          <div>
            <div className="flex items-center gap-0 border-b border-slate-200 overflow-x-auto">
              {sheets.map((sheet, idx) => (
                <div key={sheet.id} className="flex items-center shrink-0">
                  {renamingId === sheet.id ? (
                    <div className="flex items-center gap-1 px-2 py-1.5 border-b-2 border-indigo-500">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenamingId(null); }}
                        className="w-24 text-xs border-none outline-none bg-transparent font-medium text-indigo-700"
                      />
                      <button type="button" onClick={saveRename} className="text-indigo-500 hover:text-indigo-700">
                        <Check className="h-3 w-3" />
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)} className="text-slate-400 hover:text-slate-600">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActiveId(sheet.id)}
                      className={`group flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                        activeId === sheet.id
                          ? sheet.type === 'merge'
                            ? 'border-purple-500 text-purple-700 bg-purple-50'
                            : 'border-indigo-500 text-indigo-700 bg-indigo-50'
                          : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {sheet.type === 'merge'
                        ? <GitMerge className="h-3 w-3 text-purple-500" />
                        : <TableIcon className="h-3 w-3" />}
                      {sheet.name}
                      <span className={`ml-1 text-xs ${activeId === sheet.id ? 'text-indigo-400' : 'text-slate-300'}`}>
                        {sheet.type === 'merge'
                          ? `(${sheet.mergeConfig?.mergeType || 'merge'})`
                          : `(${(sheet.columns || []).length})`}
                      </span>
                      <span className="flex items-center gap-0.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span
                          onClick={e => { e.stopPropagation(); startRename(sheet); }}
                          className="p-0.5 rounded hover:bg-slate-200 cursor-pointer"
                        >
                          <PenLine className="h-2.5 w-2.5 text-slate-400" />
                        </span>
                        {sheets.length > 1 && (
                          <span
                            onClick={e => { e.stopPropagation(); deleteSheet(sheet.id); }}
                            className="p-0.5 rounded hover:bg-red-100 cursor-pointer"
                          >
                            <X className="h-2.5 w-2.5 text-slate-400 hover:text-red-500" />
                          </span>
                        )}
                      </span>
                    </button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addSheet}
                className="flex items-center gap-1 px-3 py-2 text-xs text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border-b-2 border-transparent shrink-0">
                <Plus className="h-3 w-3" /> Sheet
              </button>
              <button type="button" onClick={addMergeSheet}
                className="flex items-center gap-1 px-3 py-2 text-xs text-slate-400 hover:text-purple-600 hover:bg-purple-50 border-b-2 border-transparent shrink-0">
                <GitMerge className="h-3 w-3" /> Merge
              </button>
            </div>

            {/* Active sheet editor */}
            {activeSheet && (
              <div className="border border-slate-200 border-t-0 rounded-b-lg p-4 bg-white max-h-[calc(100vh-360px)] overflow-y-auto">
                {activeSheet.type === 'merge' ? (
                  <MergeSheetEditor
                    key={activeSheet.id}
                    sheet={activeSheet}
                    sheetIndex={activeSheetIdx}
                    allSheets={sheets}
                    availableRawSheets={availableRawSheets}
                    onChange={updateSheet}
                  />
                ) : (
                  <SheetEditor
                    key={activeSheet.id}
                    sheet={activeSheet}
                    sheetIndex={activeSheetIdx}
                    allSheets={sheets}
                    rawColumns={rawColumns}
                    availableRawSheets={availableRawSheets}
                    agentId={agent.id}
                    fileInputs={fileInputs}
                    perFileSheets={perFileSheets}
                    onChange={updateSheet}
                  />
                )}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
};

// ─── Main Modal ────────────────────────────────────────────────────────────────

const WorkflowManagerModal = ({ agent, open, onClose, inline = false }) => {
  const [workflows,   setWorkflows]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [view,        setView]        = useState('list');
  const [editTarget,  setEditTarget]  = useState(null);
  const [deletingId,  setDeletingId]  = useState(null);
  const [aiChatOpen,  setAiChatOpen]  = useState(false);

  useEffect(() => {
    if (!agent) return;
    if (!inline && !open) return;
    setView('list');
    setEditTarget(null);
    fetchWorkflows();
  }, [open, agent]);

  const fetchWorkflows = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/api/agents/${agent.id}/workflows`);
      setWorkflows(res.data || []);
    } catch {
      toast.error('Failed to load workflows');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (wf) => {
    setDeletingId(wf.id);
    try {
      await api.delete(`/api/workflows/${wf.id}`);
      toast.success(`"${wf.name}" deleted`);
      setWorkflows(prev => prev.filter(w => w.id !== wf.id));
    } catch {
      toast.error('Failed to delete workflow');
    } finally {
      setDeletingId(null);
    }
  };

  const handleSaved = () => {
    setView('list');
    setEditTarget(null);
    fetchWorkflows();
  };

  const listView = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {workflows.length === 0
            ? 'No workflows yet.'
            : `${workflows.length} workflow${workflows.length > 1 ? 's' : ''}`}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setAiChatOpen(true)} className="h-8">
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Create with AI
          </Button>
          <Button size="sm" onClick={() => { setEditTarget(null); setView('build'); }} className="h-8">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Workflow
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="py-12 flex items-center justify-center text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
        </div>
      ) : workflows.length === 0 ? (
        <div className="py-12 text-center text-slate-400">
          <GitBranch className="h-10 w-10 text-slate-200 mx-auto mb-3" />
          <p className="text-sm">No workflows defined for this agent</p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
          {workflows.map(wf => {
            const sheetCount    = (wf.sheets || []).length;
            const computedCount = (wf.sheets || []).reduce((n, s) => n + (s.columns || []).filter(c => c.type === 'computed').length, 0);
            const excelCount    = (wf.sheets || []).reduce((n, s) => n + (s.columns || []).filter(c => c.type === 'excel').length, 0);
            return (
              <div key={wf.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex-1 min-w-0 mr-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-slate-900">{wf.name}</span>
                    <Badge variant="secondary" className="text-xs">
                      {sheetCount} sheet{sheetCount !== 1 ? 's' : ''}
                    </Badge>
                    {computedCount > 0 && (
                      <Badge variant="outline" className="text-xs text-amber-700 border-amber-200">
                        {computedCount} math
                      </Badge>
                    )}
                    {excelCount > 0 && (
                      <Badge variant="outline" className="text-xs text-sky-700 border-sky-200">
                        {excelCount} excel
                      </Badge>
                    )}
                  </div>
                  {wf.description && (
                    <p className="text-xs text-slate-400 mt-0.5 truncate">{wf.description}</p>
                  )}
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {(wf.sheets || []).map(s => (
                      <span key={s.id} className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-600">
                        <TableIcon className="h-2.5 w-2.5" /> {s.name}
                        {s.groupBy?.enabled && s.groupBy?.columns?.length > 0 && (
                          <span className="ml-0.5 text-teal-600 font-medium">·G</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => { setEditTarget(wf); setView('build'); }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    <Edit2 className="h-3 w-3" /> Edit
                  </button>
                  <button
                    onClick={() => handleDelete(wf)}
                    disabled={deletingId === wf.id}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                  >
                    {deletingId === wf.id
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Trash2 className="h-3 w-3" />}
                    {deletingId === wf.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!inline && (
        <div className="flex justify-end pt-1">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      )}
    </div>
  );

  const buildView = (
    <WorkflowBuilder
      agent={agent}
      workflow={editTarget}
      onSaved={handleSaved}
      onCancel={() => { setView('list'); setEditTarget(null); }}
    />
  );

  const innerContent = view === 'list' ? listView : buildView;

  const aiChatModal = (
    <WorkflowAIChatModal
      agent={agent}
      open={aiChatOpen}
      onClose={() => setAiChatOpen(false)}
      onHandoff={(draftObj) => {
        setAiChatOpen(false);
        setEditTarget(draftObj);
        setView('build');
      }}
    />
  );

  if (inline) return (<>{innerContent}{aiChatModal}</>);

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent onClose={onClose} className="max-w-2xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-indigo-600" />
              Workflows — {agent?.name}
            </DialogTitle>
          </DialogHeader>
          {innerContent}
        </DialogContent>
      </Dialog>
      {aiChatModal}
    </>
  );
};

export default WorkflowManagerModal;
