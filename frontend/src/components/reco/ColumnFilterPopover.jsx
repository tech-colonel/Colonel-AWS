import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Filter, Search, X } from 'lucide-react';

const COLOR_PRIMARY = '#4F46E5';

/**
 * Excel-style "click header -> search + checkbox list -> pick values" filter
 * popover. Renders via a portal so it never gets clipped by the table's own
 * `overflow-x-auto` scroll wrapper. Position is computed from the trigger
 * button's bounding rect and recalculated on open.
 */
const ColumnFilterPopover = ({ label, selected, fetchValues, formatValue, onApply }) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(new Set());
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const active = selected.length > 0;

  const load = useCallback((q) => {
    setLoading(true);
    fetchValues(q)
      .then(({ values, truncated: t }) => {
        setOptions(values);
        setTruncated(!!t);
      })
      .finally(() => setLoading(false));
  }, [fetchValues]);

  // Fixed chrome above/below the scrollable checkbox list: search box + "select
  // all" row + footer (Clear/Apply). Used to size the list so the footer always
  // stays on-screen instead of being pushed past the viewport edge.
  const CHROME_HEIGHT = 128;
  const MARGIN = 8;

  const openPopover = () => {
    const rect = btnRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const placeAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const available = Math.max(160, placeAbove ? spaceAbove : spaceBelow);
    setAnchor({
      left: Math.min(rect.left, window.innerWidth - 260),
      top: placeAbove ? undefined : rect.bottom + 4,
      bottom: placeAbove ? window.innerHeight - rect.top + 4 : undefined,
      listMaxHeight: Math.max(60, Math.min(192, available - CHROME_HEIGHT)),
    });
    setChecked(new Set(selected));
    setSearch('');
    setOpen(true);
    load('');
  };

  // Debounced search-as-you-type against the backend distinct-values endpoint.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => load(search), search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // Ignore scrolls inside the popover itself (e.g. the checkbox list) — only
    // close when the page/table behind the popover scrolls, since the anchor
    // position would otherwise go stale.
    const onScroll = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const toggle = (v) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
  };

  const allVisibleChecked = options.length > 0 && options.every((v) => checked.has(v));
  const toggleAllVisible = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allVisibleChecked) options.forEach((v) => next.delete(v));
      else options.forEach((v) => next.add(v));
      return next;
    });
  };

  const apply = () => { onApply(Array.from(checked)); setOpen(false); };
  const clear = () => { onApply([]); setOpen(false); };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPopover())}
        className="ml-1 p-0.5 rounded align-middle"
        style={{ color: active ? COLOR_PRIMARY : 'var(--text-muted)' }}
        aria-label={`Filter ${label}`}
      >
        <Filter className="w-3 h-3" fill={active ? COLOR_PRIMARY : 'none'} />
      </button>

      {open && anchor && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 rounded-xl shadow-lg text-xs normal-case"
          style={{
            top: anchor.top,
            bottom: anchor.bottom,
            left: anchor.left,
            width: 240,
            background: 'var(--surface)',
            border: '1px solid var(--card-border)',
            fontWeight: 400,
            letterSpacing: 'normal',
          }}
        >
          <div className="p-2" style={{ borderBottom: '1px solid var(--card-border)' }}>
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}...`}
                className="text-xs pl-6 pr-2 py-1.5 rounded-lg w-full"
                style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
              />
            </div>
          </div>

          <div className="px-2 py-1.5" style={{ borderBottom: '1px solid var(--card-border)' }}>
            <label className="flex items-center gap-1.5 cursor-pointer py-0.5">
              <input type="checkbox" checked={allVisibleChecked} onChange={toggleAllVisible} disabled={!options.length} />
              <span className="font-semibold" style={{ color: 'var(--text-heading)' }}>Select all {search ? 'matching' : ''}</span>
            </label>
          </div>

          <div className="overflow-y-auto px-2 py-1" style={{ maxHeight: anchor.listMaxHeight }}>
            {loading && <p className="py-3 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</p>}
            {!loading && !options.length && <p className="py-3 text-center" style={{ color: 'var(--text-muted)' }}>No values found.</p>}
            {!loading && options.map((v) => (
              <label key={v} className="flex items-center gap-1.5 cursor-pointer py-0.5">
                <input type="checkbox" checked={checked.has(v)} onChange={() => toggle(v)} />
                <span className="truncate" style={{ color: 'var(--text-body)' }}>{formatValue ? formatValue(v) : v}</span>
              </label>
            ))}
            {truncated && (
              <p className="pt-1 pb-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Showing first {options.length} — search to narrow further.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 p-2" style={{ borderTop: '1px solid var(--card-border)' }}>
            <button
              onClick={clear}
              className="text-[11px] font-semibold px-2 py-1 rounded-lg flex items-center gap-1"
              style={{ color: 'var(--text-muted)' }}
            >
              <X className="w-3 h-3" /> Clear
            </button>
            <button
              onClick={apply}
              className="text-[11px] font-bold px-3 py-1 rounded-lg"
              style={{ background: COLOR_PRIMARY, color: '#fff' }}
            >
              Apply
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default ColumnFilterPopover;
