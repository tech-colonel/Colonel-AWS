import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Bot, Upload, FileText, CreditCard,
  CheckCircle2, AlertTriangle, Download, X, Save, Sparkles,
} from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import api from '../../lib/api';
import DriveOrUpload from '../../components/DriveOrUpload';
import OpenInSheetsButton from '../../components/OpenInSheetsButton';
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';

const CARD_SLOTS = [{ key: 'card_statement', label: 'Credit Card Statement', required: true }];

// The chart of accounts is written in exactly one place: uploading a Ledger
// Master to the Universal Bank Statement agent. This agent only reads it, so the
// page points there rather than offering a second write path for the same table.
const UNIVERSAL_BANK_AGENT_ID = '93d027ac-4333-403b-b448-9c637ebfc13c';

const fmt = (n) =>
  (n == null ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Where each booked row's ledger came from. Shown so a reviewer can tell a
// remembered mapping from a model's suggestion and knows which to check.
const LAYER_STYLE = {
  'Learned DB': { bg: '#ECFDF5', fg: '#047857', border: '#A7F3D0', label: 'Learned' },
  'Card Rule':  { bg: '#EEF2FF', fg: '#4338CA', border: '#C7D2FE', label: 'Rule' },
  'COA Fuzzy':  { bg: '#F0F9FF', fg: '#0369A1', border: '#BAE6FD', label: 'Matched' },
  Claude:       { bg: '#FAF5FF', fg: '#7E22CE', border: '#E9D5FF', label: 'AI' },
  Suspense:     { bg: '#FEF3C7', fg: '#92400E', border: '#FDE68A', label: 'Unmapped' },
};

export default function CreditCardWorkspace() {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const [file, setFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [driveFiles, setDriveFiles] = useState(null);   // { card_statement: [{fileId,name}] }
  const [sourceMode, setSourceMode] = useState('upload');

  const [ledgers, setLedgers] = useState([]);
  const [coa, setCoa] = useState({ count: null, updatedAt: null });
  const [cardLedger, setCardLedger] = useState('Yes Bank Credit Card');
  const [voucherType, setVoucherType] = useState('');

  // row index -> ledger the reviewer chose
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);

  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!brandId || brandId === 'demo') return;
    api.get(`/api/credit-card/${brandId}/ledgers`)
      .then((r) => {
        setLedgers(r.data?.ledgers || []);
        // Only claim a COA count when the response actually carried one. A
        // failed call (an unmounted route returns the SPA's HTML, not JSON)
        // otherwise fell through to `?? 0` and rendered "No chart of accounts
        // for this brand" — a confident, wrong statement about the brand's data
        // when the truth was that we never reached the server.
        setCoa(typeof r.data?.count === 'number'
          ? { count: r.data.count, updatedAt: r.data.updatedAt || null, error: false }
          : { count: null, updatedAt: null, error: true });
        const cards = r.data?.cardLedgers || [];
        // Prefer the plain card ledger; the "… Purchase" variant is a different
        // account and must never be picked by accident.
        const preferred = cards.find((l) => /^yes bank credit card$/i.test(l))
          || cards.find((l) => !/purchase/i.test(l))
          || cards[0];
        if (preferred) setCardLedger(preferred);
      })
      .catch(() => setCoa({ count: null, updatedAt: null, error: true }));
  }, [brandId]);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const acceptFile = useCallback((f) => {
    if (!f) return;
    if (!/\.(pdf|xlsx|xls)$/i.test(f.name)) {
      setError('Upload the statement as PDF or Excel (.pdf, .xlsx, .xls).');
      return;
    }
    setFile(f);
    setResult(null);
    setEdits({});
    setError('');
    setSaveMsg('');
  }, []);

  const handleRun = async () => {
    const useDrive = !file && driveFiles;
    if (!file && !useDrive) return;
    setIsProcessing(true);
    setError('');
    setResult(null);
    setEdits({});
    setUploadProgress(0);

    const form = new FormData();
    form.append('reco_type', 'credit_card_booking');
    form.append('brand_id', brandId || 'demo');
    form.append('is_demo', 'false');
    if (useDrive) form.append('drive', JSON.stringify(driveFiles));
    else form.append('card_statement', file);
    if (cardLedger) form.append('card_ledger', cardLedger);
    if (voucherType) form.append('voucher_type', voucherType);
    if (password) form.append('pdf_password', password);

    try {
      const res = await api.post('/api/reco/run', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => { if (e.total) setUploadProgress(Math.round((e.loaded / e.total) * 100)); },
        // Scanned statements go through OCR before booking — give that room.
        timeout: 600000,
      });
      setResult(res.data);
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Booking failed.';
      setError(msg.includes('ECONNREFUSED') || msg.includes('503')
        ? 'Reco engine is not running. Start it on port 8765.'
        : msg);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = async () => {
    if (!result?.job_id) return;
    try {
      const res = await api.get(`/api/reco/export/${result.job_id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `credit_card_booking_${result.job_id.slice(0, 8)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Download failed. Try again.');
    }
  };

  // Only rows the reviewer actually changed are sent — re-teaching a mapping the
  // agent already got right would add nothing and bloat the directory.
  const pendingCorrections = useMemo(() => {
    if (!result?.results) return [];
    return Object.entries(edits)
      .map(([idx, ledger]) => {
        const row = result.results[Number(idx)];
        if (!row || !ledger || ledger === row.debit) return null;
        return { narration: row.narration, correct_ledger: ledger, previous_ledger: row.debit, card_ledger: row.credit };
      })
      .filter(Boolean);
  }, [edits, result]);

  const handleSaveCorrections = async () => {
    if (!pendingCorrections.length) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await api.post(`/api/credit-card/${brandId}/corrections`, {
        corrections: pendingCorrections,
        job_id: result?.job_id,
      });
      const { saved, keys_learned: learned, rejected = [] } = res.data || {};
      setSaveMsg(`Saved ${saved} correction${saved === 1 ? '' : 's'} — ${learned} keys learned.`
        + (rejected.length ? ` Rejected (not in chart of accounts): ${rejected.join(', ')}` : ''));
      if (rejected.length === 0) setEdits({});
    } catch (err) {
      setSaveMsg(err.response?.data?.error || 'Could not save corrections.');
    } finally {
      setSaving(false);
    }
  };

  const counts = result?.counts || {};
  // Memoised so the analytics below aren't recomputed on every keystroke in the
  // review grid — `result?.results || []` is a new array identity each render.
  const rows = useMemo(() => result?.results || [], [result]);
  const visibleRows = onlyUnmapped ? rows.filter((r) => r.is_suspense) : rows;

  // Post-run analytics. Derived from the booked rows already in hand — no extra
  // request, and it stays in step with any correction the reviewer makes.
  const analytics = useMemo(() => {
    if (!rows.length) return null;
    const byLedger = new Map();
    const byLayer = new Map();
    let total = 0;
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      total += amt;
      byLedger.set(r.debit, (byLedger.get(r.debit) || 0) + amt);
      byLayer.set(r.layer, (byLayer.get(r.layer) || 0) + 1);
    }
    const topLedgers = [...byLedger.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    const layerSplit = [...byLayer.entries()]
      .map(([name, value]) => ({ name: LAYER_STYLE[name]?.label || name, value, key: name }))
      .sort((a, b) => b.value - a.value);
    // Share booked without a human or a model deciding — the number that should
    // climb month over month as the directory learns.
    // What an accountant has to act on before posting: entries with no ledger,
    // and entries whose value was lost. Both are counted AND valued — a count
    // alone doesn't tell you whether it's ₹200 or ₹2 lakh sitting unresolved.
    let openValue = 0; let openCount = 0; let charges = 0;
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (r.is_suspense || r.no_amount) { openCount += 1; openValue += amt; }
      if (/bank charge/i.test(r.debit || '')) charges += amt;
    }
    return {
      total,
      topLedgers,
      layerSplit,
      rowCount: rows.length,
      openCount,
      openValue,
      charges,
    };
  }, [rows]);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl">
        <button
          onClick={() => navigate(`/brands/${brandId}/agents`)}
          className="text-sm mb-4 hover:text-blue-600"
          style={{ color: '#64748B' }}
        >
          ← All Agents
        </button>

        {/* ── Header ─────────────────────────────────────────────
            The T-account line states what this tool produces before you
            upload anything: every row it writes is one double entry, and the
            Credit side is already known. */}
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg,#4338CA,#6366F1)' }}>
            <CreditCard className="w-6 h-6" style={{ color: '#FFFFFF' }} />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold tracking-widest mb-0.5" style={{ color: '#94A3B8' }}>
              BANK &amp; FINANCE
            </div>
            <h1 className="text-2xl font-black leading-tight"
              style={{ color: '#0F172A', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
              Credit Card Booking
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-xs">
              <span style={{ color: '#64748B' }}>Each transaction becomes one entry:</span>
              <span className="font-bold" style={{ color: '#94A3B8' }}>Dr</span>
              <span className="px-2 py-0.5 rounded-md font-semibold"
                style={{ background: '#F1F5F9', color: '#475569' }}>merchant ledger</span>
              <span style={{ color: '#CBD5E1' }}>&rarr;</span>
              <span className="font-bold" style={{ color: '#94A3B8' }}>Cr</span>
              <span className="px-2 py-0.5 rounded-md font-semibold"
                style={{ background: '#EEF2FF', color: '#4338CA' }}>
                {cardLedger || 'card ledger'}
              </span>
            </div>
          </div>
        </div>

        {/* ── Inputs: source on the left, settings on the right ─────── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="glass-card p-5 lg:col-span-3">
            <div className="flex items-center gap-1 mb-4">
              {[['upload', 'Upload file'], ['drive', 'From Google Drive']].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSourceMode(mode)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold transition-colors"
                  style={sourceMode === mode
                    ? { background: '#EEF2FF', color: '#4338CA' }
                    : { background: 'transparent', color: '#94A3B8' }}
                >
                  {label}
                </button>
              ))}
            </div>

            {sourceMode === 'upload' ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => { e.preventDefault(); setIsDragging(false); acceptFile(e.dataTransfer.files?.[0]); }}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl px-6 py-10 text-center cursor-pointer transition-all"
                style={{
                  border: `1.5px dashed ${isDragging ? '#4338CA' : '#CBD5E1'}`,
                  background: isDragging ? '#EEF2FF' : '#FBFCFE',
                }}
                data-testid="cc-dropzone"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => acceptFile(e.target.files?.[0])}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileText className="w-4 h-4 flex-shrink-0" style={{ color: '#4338CA' }} />
                    <span className="text-sm font-semibold truncate" style={{ color: '#0F172A' }}>{file.name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setFile(null); setResult(null); }}
                      aria-label="Remove file"
                    >
                      <X className="w-3.5 h-3.5" style={{ color: '#94A3B8' }} />
                    </button>
                  </div>
                ) : (
                  <>
                    <Upload className="w-5 h-5 mx-auto mb-2" style={{ color: '#94A3B8' }} />
                    <div className="text-sm font-semibold" style={{ color: '#334155' }}>
                      Drop the statement, or click to browse
                    </div>
                    <div className="text-xs mt-1" style={{ color: '#94A3B8' }}>
                      PDF or Excel &middot; scanned PDFs are read automatically
                    </div>
                  </>
                )}
              </div>
            ) : (
              <DriveOrUpload
                slots={CARD_SLOTS}
                agentType="credit_card_booking"
                uploadNode={null}
                onDriveConfirmed={(f) => { setDriveFiles(f); setFile(null); setResult(null); }}
              />
            )}

            {isProcessing && uploadProgress > 0 && uploadProgress < 100 && (
              <div className="mt-4">
                <div className="h-1 rounded-full overflow-hidden" style={{ background: '#E2E8F0' }}>
                  <div style={{ width: `${uploadProgress}%`, height: '100%', background: '#4338CA', transition: 'width .2s' }} />
                </div>
              </div>
            )}

            {error && (
              <div className="mt-3 text-sm px-3 py-2 rounded-lg"
                style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA' }}>
                {error}
              </div>
            )}
          </div>

          <div className="glass-card p-5 lg:col-span-2 flex flex-col">
            <div className="text-xs font-bold mb-3" style={{ color: '#0F172A' }}>Booking settings</div>

            {/* Each field says what the accountant is choosing and what it does
                to the output — a label alone ("Card ledger") names the system,
                not the decision. */}
            <label className="text-xs font-semibold block" style={{ color: '#475569' }}>
              Which ledger is this card?
              <input
                list="cc-ledger-list"
                value={cardLedger}
                onChange={(e) => setCardLedger(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg text-sm font-normal"
                style={{ border: '1px solid #E2E8F0', color: '#0F172A' }}
                placeholder="Yes Bank Credit Card"
                data-testid="cc-card-ledger"
              />
              <span className="font-normal block mt-1 leading-relaxed" style={{ color: '#94A3B8' }}>
                Pick it from your Tally chart of accounts. Every spend on the statement is
                <strong style={{ color: '#64748B' }}> credited</strong> to this ledger, and the
                merchant is debited.
              </span>
            </label>

            <label className="text-xs font-semibold block mt-4" style={{ color: '#475569' }}>
              Tally voucher type <span className="font-normal" style={{ color: '#94A3B8' }}>— optional</span>
              <input
                value={voucherType}
                onChange={(e) => setVoucherType(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg text-sm font-normal"
                style={{ border: '1px solid #E2E8F0', color: '#0F172A' }}
                placeholder="e.g. Journal Delhi"
              />
              <span className="font-normal block mt-1 leading-relaxed" style={{ color: '#94A3B8' }}>
                The voucher these entries post under in Tally. Fills a Voucher Type column in the
                output. Leave blank to set it while importing.
              </span>
            </label>

            <label className="text-xs font-semibold block mt-4" style={{ color: '#475569' }}>
              Statement password <span className="font-normal" style={{ color: '#94A3B8' }}>— optional</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg text-sm font-normal"
                style={{ border: '1px solid #E2E8F0', color: '#0F172A' }}
                placeholder="Only if the PDF is locked"
              />
              <span className="font-normal block mt-1 leading-relaxed" style={{ color: '#94A3B8' }}>
                Banks often lock card statements. Skip this for Excel files.
              </span>
            </label>

            <datalist id="cc-ledger-list">
              {ledgers.map((l) => <option key={l} value={l} />)}
            </datalist>

            {/* COA freshness — this agent reads ledger_master, never writes it. */}
            {coa.error && (
              <div className="mt-4 px-3 py-2 rounded-lg text-xs"
                style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B' }}>
                Could not load this brand&apos;s chart of accounts. The booking will still run, but
                ledgers cannot be checked — reload, or check that the backend is running.
              </div>
            )}
            {coa.count != null && (
              <div className="mt-4 px-3 py-2 rounded-lg text-xs"
                style={{ background: coa.count > 0 ? '#F8FAFC' : '#FFFBEB',
                  border: `1px solid ${coa.count > 0 ? '#E2E8F0' : '#FDE68A'}` }}>
                {coa.count > 0 ? (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <span style={{ color: '#475569' }}>Chart of accounts</span>
                      <span className="font-bold" style={{ color: '#0F172A' }}>
                        {coa.count.toLocaleString('en-IN')} ledgers
                      </span>
                    </div>
                    <div className="mt-1" style={{ color: '#94A3B8' }}>
                      {coa.updatedAt && <>Updated {new Date(coa.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. </>}
                      To update it, upload a Ledger Master on{' '}
                      <button
                        type="button"
                        onClick={() => navigate(`/brands/${brandId}/agents/${UNIVERSAL_BANK_AGENT_ID}`)}
                        className="font-semibold"
                        style={{ color: '#0748EE', background: 'none', padding: 0 }}
                      >
                        Universal Bank Statement
                      </button>.
                    </div>
                  </>
                ) : (
                  <div style={{ color: '#92400E' }}>
                    No chart of accounts for this brand — every row will come back unmapped. Upload a
                    Ledger Master on{' '}
                    <button
                      type="button"
                      onClick={() => navigate(`/brands/${brandId}/agents/${UNIVERSAL_BANK_AGENT_ID}`)}
                      className="font-semibold underline"
                      style={{ color: '#92400E', background: 'none', padding: 0 }}
                    >
                      Universal Bank Statement
                    </button>.
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleRun}
              disabled={(!file && !driveFiles) || isProcessing}
              className="mt-auto w-full px-5 py-2.5 rounded-lg text-sm font-bold text-white transition-opacity"
              style={{ background: '#0748EE', opacity: ((!file && !driveFiles) || isProcessing) ? 0.35 : 1, marginTop: 16 }}
              data-testid="cc-run"
            >
              {isProcessing ? `Booking… ${uploadProgress}%` : 'Book statement'}
            </button>
          </div>
        </div>

        {/* Pre-run: say what comes back, so the page below isn't dead space. */}
        {!result && !isProcessing && (
          <div className="glass-card p-5 mt-4">
            <div className="text-xs font-bold mb-3" style={{ color: '#0F172A' }}>What you get back</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { tab: 'Credit Card', body: 'Every transaction exactly as the statement prints it, under its own column headings.' },
                { tab: 'Working', body: 'The booking entries — merchant ledger on Debit, your card on Credit. Credits and card payments are left out so nothing double-counts.' },
              ].map((x) => (
                <div key={x.tab} className="rounded-xl p-4" style={{ background: '#FBFCFE', border: '1px solid #EEF2F7' }}>
                  <div className="text-xs font-bold mb-1" style={{ color: '#4338CA' }}>{x.tab}</div>
                  <div className="text-xs leading-relaxed" style={{ color: '#64748B' }}>{x.body}</div>
                </div>
              ))}
            </div>
            <div className="text-xs mt-3" style={{ color: '#94A3B8' }}>
              Anything the agent can&apos;t place is flagged for you to set. Whatever you fix is remembered,
              so the same merchant books itself next month.
            </div>
          </div>
        )}

        {/* ── Results ────────────────────────────────────────────── */}
        {result && (
          <>
            {result.verification && (
              <div className="glass-card p-4 mt-6"
                style={{ borderLeft: `3px solid ${
                  result.verification.status === 'verified' ? '#047857'
                    : result.verification.status === 'mismatch' ? '#B91C1C' : '#B45309'}` }}>
                <div className="flex items-start gap-2">
                  {result.verification.status === 'verified'
                    ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#047857' }} />
                    : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5"
                        style={{ color: result.verification.status === 'mismatch' ? '#B91C1C' : '#B45309' }} />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold" style={{ color: '#0F172A' }}>
                      {result.verification.status === 'verified' ? 'Checked against the statement'
                        : result.verification.status === 'mismatch' ? 'Does not match the statement'
                          : 'Could not check this statement'}
                    </div>
                    {/* The arithmetic, not a verdict — two numbers to compare and
                        one difference to read. */}
                    {result.verification.computed_closing != null ? (
                      <table className="mt-2 text-xs" style={{ color: '#475569' }}>
                        <tbody>
                          {[
                            ['Opening balance', result.verification.previous_balance],
                            ['Total debits', result.verification.total_debits],
                            ['Total credits', result.verification.total_credits],
                            ['Comes to', result.verification.computed_closing],
                            ['Statement says', result.verification.total_amount_due],
                          ].map(([l, v]) => (
                            <tr key={l}>
                              <td className="pr-6 py-0.5">{l}</td>
                              <td className="text-right font-semibold" style={{ color: '#0F172A' }}>₹{fmt(v)}</td>
                            </tr>
                          ))}
                          <tr style={{ borderTop: '1px solid #E2E8F0' }}>
                            <td className="pr-6 py-1 font-bold">Difference</td>
                            <td className="text-right font-black"
                              style={{ color: Math.abs(result.verification.difference) <= 2 ? '#047857' : '#B91C1C' }}>
                              ₹{fmt(Math.abs(result.verification.difference))}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-xs mt-1 leading-relaxed" style={{ color: '#64748B' }}>
                        {result.verification.reason}
                      </div>
                    )}
                    {result.blocked && (
                      <div className="text-xs mt-2 font-semibold" style={{ color: '#991B1B' }}>
                        No booking entries were produced. Nothing here should be posted — use the
                        Credit Card tab to see what was read, then re-run with a cleaner file.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6">
              {[
                { label: 'Extracted', value: counts.extracted, color: '#0F172A' },
                { label: 'Booked', value: counts.booked, color: '#047857' },
                { label: 'Unmapped', value: counts.suspense, color: '#92400E' },
                { label: 'Credits excluded', value: counts.excluded_credits, color: '#64748B' },
                { label: 'Payments excluded', value: counts.excluded_payments, color: '#64748B' },
              ].map((s) => (
                <div key={s.label} className="stat-card">
                  <div className="text-xl font-black" style={{ color: s.color, fontFamily: 'Barlow' }}>
                    {s.value ?? 0}
                  </div>
                  <div className="text-xs font-semibold" style={{ color: '#64748B' }}>{s.label}</div>
                </div>
              ))}
            </div>

            {counts.zero_amount > 0 && (
              <div className="mt-3 text-sm px-3 py-2 rounded-lg flex items-start gap-2"
                style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA' }}>
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  <strong>{counts.zero_amount} entr{counts.zero_amount === 1 ? 'y has' : 'ies have'} no amount.</strong>{' '}
                  The value could not be read from the statement for {counts.zero_amount === 1 ? 'this row' : 'these rows'}.
                  Check {counts.zero_amount === 1 ? 'it' : 'them'} against the PDF and fix the amount before
                  posting — a zero-value voucher imports without complaint.
                </span>
              </div>
            )}

            {result.card_ledger_resolved === false && (
              <div className="mt-3 text-sm px-3 py-2 rounded-lg flex items-center gap-2"
                style={{ background: '#FFFBEB', color: '#92400E', border: '1px solid #FDE68A' }}>
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>
                  <strong>{result.card_ledger || 'The card ledger'}</strong> is not in this brand&apos;s
                  chart of accounts. Pick the correct card ledger above and run again, or the Credit side
                  will not import into Tally.
                </span>
              </div>
            )}

            {analytics && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6">
                <div className="glass-card p-4">
                  <div className="text-xs font-bold mb-1" style={{ color: '#475569' }}>Total booked</div>
                  <div className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>
                    ₹{fmt(analytics.total)}
                  </div>
                  <div className="mt-4 pt-3" style={{ borderTop: '1px solid #EEF2F7' }}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-bold" style={{ color: '#475569' }}>
                        Needs you before posting
                      </span>
                      <span className="text-sm font-black"
                        style={{ color: analytics.openCount ? '#B45309' : '#047857' }}>
                        {analytics.openCount}
                      </span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                      {analytics.openCount
                        ? <>₹{fmt(analytics.openValue)} of {analytics.rowCount} entries has no ledger or no amount.</>
                        : <>Every entry has a ledger and an amount.</>}
                    </div>
                  </div>

                  <div className="mt-3 pt-3" style={{ borderTop: '1px solid #EEF2F7' }}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-bold" style={{ color: '#475569' }}>Bank charges</span>
                      <span className="text-sm font-black" style={{ color: '#0F172A' }}>
                        ₹{fmt(analytics.charges)}
                      </span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                      Markup fees, DCC and GST on the card, already separated out.
                    </div>
                  </div>
                </div>

                <div className="glass-card p-4">
                  <div className="text-xs font-bold mb-2" style={{ color: '#475569' }}>How each row was mapped</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={analytics.layerSplit} dataKey="value" nameKey="name"
                        innerRadius={40} outerRadius={70} paddingAngle={2}>
                        {analytics.layerSplit.map((d) => (
                          <Cell key={d.key} fill={LAYER_STYLE[d.key]?.fg || '#94A3B8'} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v, n) => [`${v} rows`, n]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {analytics.layerSplit.map((d) => (
                      <span key={d.key} className="text-xs flex items-center gap-1" style={{ color: '#64748B' }}>
                        <span className="w-2 h-2 rounded-full inline-block"
                          style={{ background: LAYER_STYLE[d.key]?.fg || '#94A3B8' }} />
                        {d.name} ({d.value})
                      </span>
                    ))}
                  </div>
                </div>

                <div className="glass-card p-4">
                  <div className="text-xs font-bold mb-2" style={{ color: '#475569' }}>Top ledgers by spend</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={analytics.topLedgers} layout="vertical"
                      margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#EEF2F7" />
                      <XAxis type="number" tick={{ fontSize: 10, fill: '#94A3B8' }}
                        tickFormatter={(v) => (v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : `${Math.round(v / 1000)}k`)} />
                      <YAxis type="category" dataKey="name" width={130}
                        tick={{ fontSize: 10, fill: '#475569' }}
                        tickFormatter={(v) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)} />
                      <Tooltip formatter={(v) => `₹${fmt(v)}`} />
                      <Bar dataKey="value" fill="#4338CA" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between mt-6 mb-3">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-bold" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>
                  {result.blocked ? 'Working — not produced' : 'Working — booking entries'}
                </h2>
                {!result.blocked && (
                  <label className="flex items-center gap-1.5 text-xs" style={{ color: '#64748B' }}>
                    <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} />
                    Only unmapped ({counts.suspense ?? 0})
                  </label>
                )}
              </div>
              <div className="flex items-center gap-2">
                {pendingCorrections.length > 0 && (
                  <button
                    onClick={handleSaveCorrections}
                    disabled={saving}
                    className="px-4 py-2 rounded-lg text-sm font-bold text-white flex items-center gap-1.5 disabled:opacity-40"
                    style={{ background: '#047857' }}
                    data-testid="cc-save-corrections"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? 'Saving…' : `Save ${pendingCorrections.length} correction${pendingCorrections.length === 1 ? '' : 's'}`}
                  </button>
                )}
                {!result.blocked && (
                  <OpenInSheetsButton jobId={result.job_id} name="Credit Card Booking" />
                )}
                <button
                  onClick={handleDownload}
                  className="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1.5"
                  style={{ background: '#E8EFFE', color: '#0748EE', border: '1px solid #A3BFF8' }}
                  data-testid="cc-download"
                >
                  <Download className="w-3.5 h-3.5" />
                  {result.blocked ? 'Download what was read' : 'Download Excel'}
                </button>
              </div>
            </div>

            {saveMsg && (
              <div className="mb-3 text-sm px-3 py-2 rounded-lg flex items-center gap-2"
                style={{ background: '#ECFDF5', color: '#065F46', border: '1px solid #A7F3D0' }}>
                <Sparkles className="w-4 h-4 flex-shrink-0" />
                {saveMsg} Next month these merchants book themselves.
              </div>
            )}

            <div className="glass-card overflow-x-auto">
              <table className="w-full text-xs" style={{ minWidth: '900px' }}>
                <thead>
                  <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' }}>
                    {['Date', 'Transaction Details', 'Debit (ledger)', 'Credit', 'Amount', 'Source'].map((h) => (
                      <th key={h} className="text-left px-3 py-2 font-bold" style={{ color: '#475569' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const style = LAYER_STYLE[r.layer] || LAYER_STYLE.Suspense;
                    const edited = edits[r.row] != null && edits[r.row] !== r.debit;
                    return (
                      <tr key={r.row}
                        style={{
                          borderBottom: '1px solid #F1F5F9',
                          background: r.is_suspense ? '#FFFBEB' : (edited ? '#F0FDF4' : 'transparent'),
                        }}>
                        <td className="px-3 py-2 whitespace-nowrap" style={{ color: '#475569' }}>{r.date}</td>
                        <td className="px-3 py-2" style={{ color: '#0F172A', maxWidth: 380 }}>{r.narration}</td>
                        <td className="px-3 py-2">
                          <input
                            list="cc-ledger-list"
                            defaultValue={r.debit}
                            onBlur={(e) => setEdits((p) => ({ ...p, [r.row]: e.target.value.trim() }))}
                            className="w-full px-2 py-1 rounded"
                            style={{
                              border: `1px solid ${edited ? '#047857' : '#E2E8F0'}`,
                              color: r.is_suspense ? '#92400E' : '#0F172A',
                              fontWeight: r.is_suspense ? 700 : 400,
                            }}
                            data-testid={`cc-ledger-${r.row}`}
                          />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap" style={{ color: '#64748B' }}>{r.credit}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap"
                          style={{ color: r.no_amount ? '#B91C1C' : '#0F172A', fontWeight: r.no_amount ? 700 : 400 }}>
                          {r.no_amount ? 'no amount' : fmt(r.amount)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="px-2 py-0.5 rounded-full font-semibold whitespace-nowrap"
                            style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}>
                            {style.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visibleRows.length === 0 && (
                <div className="p-6 text-center text-sm flex items-center justify-center gap-2"
                  style={{ color: '#64748B' }}>
                  {result.blocked ? (
                    <>
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: '#B91C1C' }} />
                      No entries to review — the statement did not reconcile, so none were produced.
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" style={{ color: '#047857' }} />
                      Nothing unmapped — every row found a ledger.
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
