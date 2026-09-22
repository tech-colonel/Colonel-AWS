import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/modal';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

// GSTR-2B vs Books: the GST portal export merges the Trade/Legal Name cell across
// every invoice belonging to one supplier, so only the first row of that block
// actually carries a name — the rest are genuinely blank in the file. The engine
// no longer silently inherits the name from the row above; instead it reports the
// affected GSTINs here so the user can type the correct name (applied to every row
// for that GSTIN) or continue and leave it blank.

const MissingTradeNameModal = ({ open, onOpenChange, missingNames = [], submitting, onContinue }) => {
  const [namesByGstin, setNamesByGstin] = useState({});

  if (!open) return null;

  const setName = (gstin, value) =>
    setNamesByGstin((prev) => ({ ...prev, [gstin]: value }));

  const filledCount = Object.values(namesByGstin).filter((v) => v && v.trim()).length;

  const handleContinue = () => {
    const corrections = {};
    Object.entries(namesByGstin).forEach(([gstin, name]) => {
      if (name && name.trim()) corrections[gstin] = name.trim();
    });
    onContinue(corrections);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto" onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Missing Trade/Legal Name
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-slate-500 -mt-2">
          {missingNames.length} supplier{missingNames.length === 1 ? '' : 's'} in the uploaded GSTR-2B
          file {missingNames.length === 1 ? 'has' : 'have'} no Trade/Legal Name. Enter it below to apply
          to every invoice for that GSTIN, or continue and leave it blank.
        </p>

        <div className="space-y-3">
          {missingNames.map((item) => (
            <div key={item.gstin} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-slate-800">GSTIN {item.gstin}</p>
              <p className="text-xs text-slate-500">
                Seen in {item.occurrences} row{item.occurrences === 1 ? '' : 's'}
                {item.sample_doc_no ? ` (e.g. invoice ${item.sample_doc_no})` : ''}
              </p>
              <Input
                className="mt-2"
                placeholder="Trade/Legal Name"
                value={namesByGstin[item.gstin] || ''}
                onChange={(e) => setName(item.gstin, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleContinue} disabled={submitting}>
            {submitting
              ? 'Continuing…'
              : filledCount > 0
                ? `Continue (${filledCount} added, rest blank)`
                : 'Continue (leave blank)'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MissingTradeNameModal;
