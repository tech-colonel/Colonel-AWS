import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/modal';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import api from '../../lib/api';
import { toast } from 'sonner';

// Shared across every sales agent + the Workflow Builder: when a generate/apply call comes back
// with `missingMasterValues` (a raw SKU or ledger/state value not found in this brand's
// sku_master/ledger_master), this lets the user add it on the spot or explicitly continue with
// that field left blank. See new-backend/src/utils/missingMasterTracker.js for the item shape.

const itemKey = (item) =>
  `${item.masterType}::${item.matchField || ''}::${item.value}`.toLowerCase();

const normalizeKey = (k) => k.trim().toLowerCase().replace(/[\s_-]+/g, '');

function buildInitialFields(item, masterData) {
  const rows = item.masterType === 'sku' ? masterData?.sku_master : masterData?.ledger_master;
  const template = rows && rows.length > 0 ? Object.keys(rows[0]) : [];

  if (template.length > 0) {
    return template.map((k) => ({
      key: k,
      value: normalizeKey(k) === normalizeKey(item.matchField || '') ? item.value : ''
    }));
  }
  return [
    { key: item.matchField || 'Value', value: item.value },
    { key: '', value: '' }
  ];
}

const MissingMasterDataModal = ({
  open,
  onOpenChange,
  missingValues = [],
  brandId,
  agentId,
  masterData,
  onProceed,
  onResolved
}) => {
  const [resolvedKeys, setResolvedKeys] = useState(new Set());
  const [savingKey, setSavingKey] = useState(null);
  const [fieldsByKey, setFieldsByKey] = useState({});

  if (!open) return null;

  const getFields = (item) => {
    const key = itemKey(item);
    return fieldsByKey[key] || buildInitialFields(item, masterData);
  };

  const updateField = (item, idx, part, val) => {
    const key = itemKey(item);
    const current = getFields(item);
    const next = current.map((f, i) => (i === idx ? { ...f, [part]: val } : f));
    setFieldsByKey((prev) => ({ ...prev, [key]: next }));
  };

  const addField = (item) => {
    const key = itemKey(item);
    const current = getFields(item);
    setFieldsByKey((prev) => ({ ...prev, [key]: [...current, { key: '', value: '' }] }));
  };

  const removeField = (item, idx) => {
    const key = itemKey(item);
    const current = getFields(item);
    setFieldsByKey((prev) => ({ ...prev, [key]: current.filter((_, i) => i !== idx) }));
  };

  const handleSave = async (item) => {
    const key = itemKey(item);
    const fields = {};
    getFields(item).forEach(({ key: k, value: v }) => {
      if (k && k.trim()) fields[k.trim()] = v;
    });
    if (Object.keys(fields).length === 0) {
      toast.error('Add at least one field before saving');
      return;
    }

    setSavingKey(key);
    try {
      await api.post(
        `/api/brands/${brandId}/agents/${agentId}/master/${item.masterType}/add-entry`,
        { fields }
      );
      toast.success(`Added to ${item.masterType === 'sku' ? 'SKU' : 'Ledger'} master`);
      setResolvedKeys((prev) => new Set(prev).add(key));
      onResolved?.();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to save entry');
    } finally {
      setSavingKey(null);
    }
  };

  const allResolved = missingValues.length > 0 && resolvedKeys.size === missingValues.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Missing Master Data
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-slate-500 -mt-2">
          {missingValues.length} value{missingValues.length === 1 ? '' : 's'} from the uploaded
          file could not be matched in your SKU/Ledger master. Add them below, or continue and
          leave those fields blank for now.
        </p>

        <div className="space-y-3">
          {missingValues.map((item) => {
            const key = itemKey(item);
            const isResolved = resolvedKeys.has(key);
            const fields = getFields(item);

            return (
              <div
                key={key}
                className={`rounded-lg border p-3 ${
                  isResolved ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      "{item.value}" not found in {item.masterType === 'sku' ? 'SKU' : 'Ledger'} Master
                      {item.matchField ? ` (matched on "${item.matchField}")` : ''}
                    </p>
                    <p className="text-xs text-slate-500">
                      Seen in {item.occurrences} row{item.occurrences === 1 ? '' : 's'}
                    </p>
                  </div>
                  {isResolved && <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />}
                </div>

                {!isResolved && (
                  <div className="mt-3 space-y-2">
                    {fields.map((f, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          className="w-1/3"
                          placeholder="Field name"
                          value={f.key}
                          onChange={(e) => updateField(item, idx, 'key', e.target.value)}
                        />
                        <Input
                          className="flex-1"
                          placeholder="Value"
                          value={f.value}
                          onChange={(e) => updateField(item, idx, 'value', e.target.value)}
                        />
                        {fields.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeField(item, idx)}
                            className="text-slate-400 hover:text-red-500"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        onClick={() => addField(item)}
                        className="flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                      >
                        <Plus className="h-3 w-3" /> Add field
                      </button>
                      <Button size="sm" disabled={savingKey === key} onClick={() => handleSave(item)}>
                        {savingKey === key ? 'Saving...' : 'Save to Master'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onProceed?.()}>
            {allResolved ? 'Continue' : 'Continue (leave remaining blank)'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MissingMasterDataModal;
