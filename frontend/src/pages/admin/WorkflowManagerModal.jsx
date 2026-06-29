import React, { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import {
  Plus, Trash2, Edit2, Loader2, GitBranch, Upload, ChevronLeft,
  X, Check, TableIcon, PenLine
} from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeSheetId = () => `sheet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const makeColId  = () => `col_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

function makeSheet(name, order) {
  return { id: makeSheetId(), name, order, columns: [], filters: [] };
}

// Available columns for formula builder in a given sheet
// Returns [{ key, label, insertText }]
function getFormulaColumns(sheetIndex, allSheets, upToColIndex) {
  const result = [];

  // Previous sheets — all their columns
  for (let i = 0; i < sheetIndex; i++) {
    const s = allSheets[i];
    const sName = s.name || `Sheet${i + 1}`;
    s.columns.forEach(col => {
      result.push({
        key:        `${sName}.${col.label}`,
        label:      `${sName} → ${col.label}`,
        insertText: `{${sName}.${col.label}}`,
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
  const [label,        setLabel]        = useState('');
  const [masterType,   setMasterType]   = useState('sku');
  const [lookupColumn, setLookupColumn] = useState(rawColumns[0] || '');
  const [matchField,   setMatchField]   = useState('');
  const [returnField,  setReturnField]  = useState('');
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
    if (!label.trim())       { toast.error('Column name required'); return; }
    if (!lookupColumn)       { toast.error('Select a lookup column'); return; }
    if (!matchField.trim())  { toast.error('Match field is required'); return; }
    if (!returnField.trim()) { toast.error('Return field is required'); return; }
    onAdd({ label: label.trim(), type: 'master_lookup', masterType, lookupColumn, matchField: matchField.trim(), returnField: returnField.trim() });
  };

  return (
    <div className="border border-violet-200 bg-violet-50 rounded-lg p-3 space-y-2.5">
      <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide">New Master Data Column</p>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-slate-600">Column Name *</Label>
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Product Category" className="mt-1 h-8 text-sm" />
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
        <Label className="text-xs text-slate-600">Lookup Column (from raw file) *</Label>
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

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-slate-600">Match Field (in master) *</Label>
          <div className="mt-1">
            <FieldSuggestInput
              value={matchField}
              onChange={setMatchField}
              suggestions={fields}
              placeholder="e.g. salesPortalSku"
              className="h-8 text-xs"
            />
          </div>
        </div>
        <div>
          <Label className="text-xs text-slate-600">Return Field (from master) *</Label>
          <div className="mt-1">
            <FieldSuggestInput
              value={returnField}
              onChange={setReturnField}
              suggestions={fields}
              placeholder="e.g. category"
              className="h-8 text-xs"
            />
          </div>
        </div>
      </div>

      {matchField && returnField && lookupColumn && (
        <p className="text-xs text-violet-600 bg-violet-100 rounded px-2 py-1">
          Row's <strong>{lookupColumn}</strong> → matches master's <strong>{matchField}</strong> → returns <strong>{returnField}</strong>
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleAdd} className="h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white">
          <Check className="h-3 w-3 mr-1" /> Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-xs">
          <X className="h-3 w-3 mr-1" /> Cancel
        </Button>
      </div>
    </div>
  );
};

// ─── Sheet Editor Panel ────────────────────────────────────────────────────────

const SheetEditor = ({ sheet, sheetIndex, allSheets, rawColumns, agentId, onChange }) => {
  const [showAddComputed, setShowAddComputed] = useState(false);
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

  // All columns from previous sheets, grouped by sheet name
  const prevSheetGroups = allSheets.slice(0, sheetIndex).map(s => ({
    sheetId:   s.id,
    sheetName: s.name,
    columns:   s.columns.filter(c => c.label) // skip unnamed cols
  })).filter(g => g.columns.length > 0);

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

  const computedCols = sheet.columns.filter(c => c.type === 'computed');
  const masterCols   = sheet.columns.filter(c => c.type === 'master_lookup');

  // For the formula builder: up to end of current computed col list (or end for new)
  const formulaColumnsForNew = getFormulaColumns(sheetIndex, allSheets, sheet.columns.length);
  const formulaColumnsForEdit = (colId) => {
    const idx = sheet.columns.findIndex(c => c.id === colId);
    return getFormulaColumns(sheetIndex, allSheets, idx);
  };

  return (
    <div className="space-y-4">
      {/* Row filters */}
      <FiltersSection
        filters={sheet.filters || []}
        rawColumns={rawColumns}
        onChange={updateFilters}
      />

      {/* Source columns from raw file */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
            Source Columns from File
          </Label>
          <span className="text-xs text-slate-400">
            {selectedSourceKeys.size}/{rawColumns.length} selected
          </span>
        </div>

        {rawColumns.length === 0 ? (
          <p className="text-xs text-slate-400 py-2">No file uploaded yet</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-36 overflow-y-auto border border-slate-200 rounded-lg p-2.5 bg-slate-50">
            {rawColumns.map(col => (
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

      {/* Computed columns */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
            Computed Columns
          </Label>
          <button
            type="button"
            onClick={() => { setShowAddComputed(true); setEditingColId(null); }}
            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
          >
            <Plus className="h-3 w-3" /> Add Computed Column
          </button>
        </div>

        {computedCols.length === 0 && !showAddComputed && (
          <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">
            No computed columns yet. Click "Add Computed Column" to define one.
          </div>
        )}

        <div className="space-y-1.5">
          {computedCols.map((col) => (
            <div key={col.id} className="border border-amber-200 bg-amber-50 rounded-lg p-2.5">
              {editingColId === col.id ? (
                <div className="space-y-2">
                  <Input
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    className="h-7 text-sm"
                    placeholder="Column name"
                  />
                  <FormulaBuilder
                    formula={editFormula}
                    onChange={setEditFormula}
                    availableColumns={formulaColumnsForEdit(col.id)}
                  />
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
                    <span className="text-sm font-medium text-amber-900">{col.label}</span>
                    <p className="text-xs text-amber-600 font-mono mt-0.5 break-all">{col.formula}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEditComputed(col)}
                      className="p-1 rounded hover:bg-amber-100 text-amber-500"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteComputed(col.id)}
                      className="p-1 rounded hover:bg-red-100 text-amber-500 hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {showAddComputed && (
            <AddComputedColumnForm
              availableColumns={formulaColumnsForNew}
              onAdd={addComputed}
              onCancel={() => setShowAddComputed(false)}
            />
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
            disabled={rawColumns.length === 0}
            className="inline-flex items-center gap-1 text-xs text-violet-600 hover:text-violet-800 font-medium disabled:opacity-40"
          >
            <Plus className="h-3 w-3" /> Add Lookup Column
          </button>
        </div>

        {masterCols.length === 0 && !showAddMaster && (
          <div className="text-xs text-slate-400 py-2 text-center border border-dashed border-slate-200 rounded-lg">
            No master lookups. Click "Add Lookup Column" to map SKU/Ledger data.
          </div>
        )}

        <div className="space-y-1.5">
          {masterCols.map(col => (
            <div key={col.id} className="flex items-start justify-between gap-2 border border-violet-200 bg-violet-50 rounded-lg p-2.5">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-violet-900">{col.label}</span>
                <p className="text-xs text-violet-600 mt-0.5">
                  {col.masterType === 'sku' ? 'SKU' : 'Ledger'} master · match <em>{col.lookupColumn}</em> → <em>{col.matchField}</em> · return <em>{col.returnField}</em>
                </p>
              </div>
              <button
                type="button"
                onClick={() => deleteMasterCol(col.id)}
                className="p-1 rounded hover:bg-red-100 text-violet-400 hover:text-red-500 shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

          {showAddMaster && (
            <AddMasterColumnForm
              rawColumns={rawColumns}
              agentId={agentId}
              onAdd={addMasterColumn}
              onCancel={() => setShowAddMaster(false)}
            />
          )}
        </div>
      </div>

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
                        : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {col.type === 'computed' ? '✦ ' : col.type === 'master_lookup' ? '⬡ ' : ''}{col.label}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Workflow Builder ──────────────────────────────────────────────────────────

const WorkflowBuilder = ({ agent, workflow, onSaved, onCancel }) => {
  const isEdit = !!workflow;

  const [step,         setStep]         = useState(isEdit ? 2 : 1);
  const [sampleFile,   setSampleFile]   = useState(null);
  const [extracting,   setExtracting]   = useState(false);
  const [rawColumns,   setRawColumns]   = useState(workflow?.sample_columns || []);
  const [sheets,       setSheets]       = useState(() => {
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

  // ── Step 1: extract columns ──

  const handleExtract = async () => {
    if (!sampleFile) { toast.error('Please select a file'); return; }
    setExtracting(true);
    try {
      const fd = new FormData();
      fd.append('file', sampleFile);
      const res = await api.post('/api/workflows/extract-columns', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setRawColumns(res.data.columns);
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
    const emptySheets = sheets.filter(s => s.columns.length === 0);
    if (emptySheets.length > 0) {
      toast.error(`Sheet "${emptySheets[0].name}" has no columns selected`);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        sample_columns: rawColumns,
        sheets: sheets.map((s, i) => ({
          ...s,
          order: i,
          columns: s.columns.map((c, j) => ({ ...c, order: j }))
        }))
      };
      if (isEdit) {
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
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-slate-100">
          <ChevronLeft className="h-4 w-4 text-slate-500" />
        </button>
        <div>
          <h3 className="font-semibold text-slate-900 text-sm">
            {isEdit ? 'Edit Workflow' : 'New Workflow'} — {agent.name}
          </h3>
          <p className="text-xs text-slate-500">
            {step === 1 ? 'Step 1 of 2: Upload sample file' : 'Step 2 of 2: Define sheets & columns'}
          </p>
        </div>
      </div>

      {/* Step bar */}
      <div className="flex gap-2">
        <div className={`h-1.5 flex-1 rounded-full ${step >= 1 ? 'bg-indigo-500' : 'bg-slate-200'}`} />
        <div className={`h-1.5 flex-1 rounded-full ${step >= 2 ? 'bg-indigo-500' : 'bg-slate-200'}`} />
      </div>

      {/* ── Step 1 ── */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center">
            <Upload className="h-8 w-8 text-slate-300 mx-auto mb-3" />
            <p className="text-sm text-slate-600 mb-1">Upload a sample file to extract column headers</p>
            <p className="text-xs text-slate-400 mb-4">Supports .xlsx, .xls, .csv</p>
            <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Upload className="h-4 w-4" />
              {sampleFile ? sampleFile.name : 'Choose File'}
              <input
                type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => setSampleFile(e.target.files[0] || null)}
              />
            </label>
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
            <Button onClick={handleExtract} disabled={!sampleFile || extracting} className="flex-1">
              {extracting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Extracting...</> : 'Extract Columns →'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div className="space-y-4">
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
                          ? 'border-indigo-500 text-indigo-700 bg-indigo-50'
                          : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <TableIcon className="h-3 w-3" />
                      {sheet.name}
                      <span className={`ml-1 text-xs ${activeId === sheet.id ? 'text-indigo-400' : 'text-slate-300'}`}>
                        ({sheet.columns.length})
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
              <button
                type="button"
                onClick={addSheet}
                className="flex items-center gap-1 px-3 py-2 text-xs text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border-b-2 border-transparent shrink-0"
              >
                <Plus className="h-3 w-3" /> Add Sheet
              </button>
            </div>

            {/* Active sheet editor */}
            {activeSheet && (
              <div className="border border-slate-200 border-t-0 rounded-b-lg p-4 bg-white max-h-[400px] overflow-y-auto">
                <SheetEditor
                  key={activeSheet.id}
                  sheet={activeSheet}
                  sheetIndex={activeSheetIdx}
                  allSheets={sheets}
                  rawColumns={rawColumns}
                  agentId={agent.id}
                  onChange={updateSheet}
                />
              </div>
            )}
          </div>

          {/* Save / Cancel */}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="flex-1">
              {saving
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Saving...</>
                : isEdit ? 'Update Workflow' : 'Save Workflow'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main Modal ────────────────────────────────────────────────────────────────

const WorkflowManagerModal = ({ agent, open, onClose }) => {
  const [workflows,   setWorkflows]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [view,        setView]        = useState('list');
  const [editTarget,  setEditTarget]  = useState(null);
  const [deletingId,  setDeletingId]  = useState(null);

  useEffect(() => {
    if (!open || !agent) return;
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

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent onClose={onClose} className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-indigo-600" />
            Workflows — {agent?.name}
          </DialogTitle>
        </DialogHeader>

        {view === 'list' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-500">
                {workflows.length === 0
                  ? 'No workflows yet.'
                  : `${workflows.length} workflow${workflows.length > 1 ? 's' : ''}`}
              </p>
              <Button size="sm" onClick={() => { setEditTarget(null); setView('build'); }} className="h-8">
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Workflow
              </Button>
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
                              {computedCount} computed
                            </Badge>
                          )}
                        </div>
                        {wf.description && (
                          <p className="text-xs text-slate-400 mt-0.5 truncate">{wf.description}</p>
                        )}
                        {/* Sheet names preview */}
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {(wf.sheets || []).map(s => (
                            <span key={s.id} className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-600">
                              <TableIcon className="h-2.5 w-2.5" /> {s.name}
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

            <div className="flex justify-end pt-1">
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : (
          <WorkflowBuilder
            agent={agent}
            workflow={editTarget}
            onSaved={handleSaved}
            onCancel={() => { setView('list'); setEditTarget(null); }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

export default WorkflowManagerModal;
