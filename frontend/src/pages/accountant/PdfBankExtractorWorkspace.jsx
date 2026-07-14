import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Bot, Upload, FileText,
  CheckCircle2, AlertTriangle, AlertCircle, Download,
  X, ArrowRight,
} from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import api from '../../lib/api';

const fmt = (n) =>
  n == null ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PdfBankExtractorWorkspace() {
  const { brandId } = useParams();
  const navigate    = useNavigate();

  const [brands,         setBrands]         = useState([]);
  const [pdfFile,        setPdfFile]        = useState(null);
  const [isDragging,     setIsDragging]     = useState(false);
  const [isProcessing,   setIsProcessing]   = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [result,         setResult]         = useState(null);
  const [error,          setError]          = useState('');
  const [password,       setPassword]       = useState('');
  const [needsPassword,  setNeedsPassword]  = useState(false);

  const fileInputRef = useRef(null);

  useEffect(() => {
    api.get('/api/brands')
      .then(r => setBrands(r.data?.brands || r.data || []))
      .catch(() => {});
  }, []);

  const brandName = brands.find(b => String(b.id) === String(brandId))?.name || '';

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard',  icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`,    label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  // ── Drop handling ──────────────────────────────────────────────
  const acceptFile = useCallback((file) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please upload a PDF file.');
      return;
    }
    setPdfFile(file);
    setResult(null);
    setError('');
    setPassword('');
    setNeedsPassword(false);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    acceptFile(e.dataTransfer.files[0]);
  }, [acceptFile]);

  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);

  // ── Convert ────────────────────────────────────────────────────
  const handleConvert = async (pwd = '') => {
    if (!pdfFile || isProcessing) return;
    setIsProcessing(true);
    setUploadProgress(0);
    setError('');
    setResult(null);

    const form = new FormData();
    form.append('reco_type', 'pdf_bank_extract');
    form.append('brand_id', brandId || 'demo');
    form.append('is_demo', 'false');
    form.append('bank_pdf', pdfFile);
    if (pwd) form.append('pdf_password', pwd);

    try {
      const res = await api.post('/api/reco/run', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          if (evt.total) setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        },
        timeout: 600000, // 10 min — covers large scanned PDFs that go through OCR (+ retry)
      });
      // Password-protected / unreadable PDF → prompt for the password instead of showing a result.
      if (res.data?.validation?.verify_method === 'unreadable') {
        setNeedsPassword(true);
        setResult(null);
        if (pwd) setError('Incorrect password — please check it and try again.');
      } else {
        setNeedsPassword(false);
        setResult(res.data);
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Conversion failed.';
      setError(msg.includes('ECONNREFUSED') || msg.includes('503')
        ? 'Python reco engine is not running. Start it on port 8765.'
        : msg);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Download ───────────────────────────────────────────────────
  const handleDownload = async () => {
    if (!result?.job_id) return;
    try {
      const res = await api.get(`/api/reco/export/${result.job_id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `bank_statement_${result.account_no || result.job_id.slice(0, 8)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Download failed. Try again.');
    }
  };

  // ── Validation badge ───────────────────────────────────────────
  const ValidationBadge = ({ v }) => {
    if (!v) return null;
    // Verified by PDF totals OR by balance reconciliation → green.
    if (v.verified) {
      const byBalance = v.verify_method === 'balance';
      return (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 12px', borderRadius: 20,
          background: '#ECFDF5', border: '1px solid #6EE7B7',
          fontSize: 12, color: '#065F46', fontFamily: 'DM Sans', fontWeight: 600,
        }}>
          <CheckCircle2 size={13} color="#10B981" />
          Totals Verified ✓ {byBalance ? '(balance reconciled)' : ''} &nbsp;—&nbsp;
          Debit ₹{fmt(v.computed_total_debit)} | Credit ₹{fmt(v.computed_total_credit)}
        </span>
      );
    }
    // No PDF totals row and balance didn't reconcile → neutral "verify manually".
    if (!v.totals_found_in_pdf) {
      return (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 12px', borderRadius: 20,
          background: 'var(--surface)', border: '1px solid var(--card-border)',
          fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Sans',
        }}>
          <AlertCircle size={13} /> Totals: verify manually — Debit ₹{fmt(v.computed_total_debit)} | Credit ₹{fmt(v.computed_total_credit)}
        </span>
      );
    }
    const debitDelta  = Math.abs((v.computed_total_debit  || 0) - (v.pdf_total_debit  || 0));
    const creditDelta = Math.abs((v.computed_total_credit || 0) - (v.pdf_total_credit || 0));
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 12px', borderRadius: 20,
        background: '#FFFBEB', border: '1px solid #FCD34D',
        fontSize: 12, color: '#92400E', fontFamily: 'DM Sans', fontWeight: 600,
      }}>
        <AlertTriangle size={13} color="#F59E0B" />
        Totals Mismatch ⚠ &nbsp;—&nbsp;
        {!v.debit_match  && `Debit delta ₹${fmt(debitDelta)} `}
        {!v.credit_match && `Credit delta ₹${fmt(creditDelta)}`}
        — check before proceeding
      </span>
    );
  };

  // ── Preview table ──────────────────────────────────────────────
  const previewCols = [
    { key: 'date',        label: 'Txn Date',      align: 'left',  w: 90 },
    { key: 'description', label: 'Description',   align: 'left',  w: 340 },
    { key: 'ref_no',      label: 'Chq./Ref.No.',  align: 'left',  w: 160 },
    { key: 'debit',       label: 'Debit',         align: 'right', w: 110 },
    { key: 'credit',      label: 'Credit',        align: 'right', w: 110 },
    { key: 'balance',     label: 'Balance',       align: 'right', w: 120 },
  ];

  // ── Render ─────────────────────────────────────────────────────
  return (
    <DashboardLayout sidebarItems={sidebarItems} title="PDF Bank Statement → Excel">
      <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>

        {/* ── Page header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
          <div>
            <h1 style={{
              fontSize: 26, fontWeight: 900, fontFamily: 'Barlow',
              color: 'var(--text-heading)', margin: 0, lineHeight: 1.2,
            }}>
              PDF → Bank Statement Excel
            </h1>
            <p style={{ marginTop: 6, fontSize: 14, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
              Upload any Indian bank statement PDF — extracts all transactions and exports a clean Excel
              ready for the Universal Bank Statement classifier.
            </p>
          </div>
          {brandName && (
            <span style={{
              background: '#EEF3FF', border: '1px solid #A3BFF8',
              borderRadius: 20, padding: '4px 14px',
              fontSize: 13, fontWeight: 600, color: '#0748EE', fontFamily: 'DM Sans',
            }}>
              {brandName}
            </span>
          )}
        </div>

        {/* ── Upload card ── */}
        <div style={{
          background: 'var(--surface)', border: `1px solid ${isDragging ? '#0748EE' : 'var(--card-border)'}`,
          borderRadius: 16, padding: 32, marginBottom: 20,
          boxShadow: isDragging ? '0 0 0 3px rgba(7,72,238,0.12)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}>
          {/* Drop zone */}
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${isDragging ? '#0748EE' : pdfFile ? '#10B981' : 'var(--card-border)'}`,
              borderRadius: 12, padding: '40px 24px', textAlign: 'center',
              cursor: 'pointer', transition: 'all 0.15s',
              background: isDragging ? 'rgba(7,72,238,0.04)' : pdfFile ? 'rgba(16,185,129,0.04)' : 'var(--page-bg)',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              style={{ display: 'none' }}
              onChange={e => acceptFile(e.target.files[0])}
            />

            {pdfFile ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <FileText size={28} color="#10B981" />
                <div style={{ textAlign: 'left' }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700, fontFamily: 'Barlow', color: 'var(--text-heading)' }}>
                    {pdfFile.name}
                  </p>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
                    {(pdfFile.size / 1024 / 1024).toFixed(1)} MB &nbsp;·&nbsp; Click to change
                  </p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setPdfFile(null); setResult(null); setError(''); }}
                  style={{
                    marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)', padding: 4, borderRadius: 6,
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                <Upload size={32} color={isDragging ? '#0748EE' : 'var(--text-muted)'} style={{ marginBottom: 12 }} />
                <p style={{ margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'Barlow', color: 'var(--text-heading)' }}>
                  Drag & drop your bank statement PDF
                </p>
                <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
                  or click to browse &nbsp;·&nbsp; PDF only, max 50 MB
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
                  Supports: HDFC · ICICI · SBI · Axis · Kotak · PNB · IndusInd
                </p>
              </>
            )}
          </div>

          {/* Upload progress */}
          {isProcessing && uploadProgress > 0 && uploadProgress < 100 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>Uploading…</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>{uploadProgress}%</span>
              </div>
              <div style={{ height: 4, background: 'var(--card-border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${uploadProgress}%`, background: '#0748EE', borderRadius: 4, transition: 'width 0.2s' }} />
              </div>
            </div>
          )}
          {isProcessing && uploadProgress >= 100 && (
            <p style={{ textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
              Extracting transactions from PDF… this may take up to 60 seconds for large files.
            </p>
          )}

          {/* Error message */}
          {error && (
            <div style={{
              marginTop: 16, padding: '10px 14px', borderRadius: 8,
              background: '#FEF2F2', border: '1px solid #FCA5A5',
              fontSize: 13, color: '#991B1B', fontFamily: 'DM Sans',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <AlertTriangle size={15} color="#EF4444" style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}

          {/* Password prompt — shown when the PDF is locked / password-protected */}
          {needsPassword && (
            <div style={{
              marginTop: 16, padding: '16px 18px', borderRadius: 10,
              background: '#FFFBEB', border: '1px solid #FCD34D',
            }}>
              <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, fontFamily: 'Barlow', color: '#92400E' }}>
                🔒 This PDF is password-protected
              </p>
              <p style={{ margin: '0 0 12px', fontSize: 12.5, color: '#92400E', fontFamily: 'DM Sans' }}>
                Enter the password to open the statement (e.g. the one your bank sends with the file).
                It’s used only to open this PDF and is never saved.
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && password && !isProcessing) handleConvert(password); }}
                  placeholder="PDF password"
                  autoFocus
                  style={{
                    flex: '1 1 220px', padding: '9px 12px', borderRadius: 8,
                    border: '1px solid #FCD34D', fontSize: 13, fontFamily: 'DM Sans',
                    background: 'var(--surface)', color: 'var(--text-primary)',
                  }}
                />
                <button
                  onClick={() => handleConvert(password)}
                  disabled={!password || isProcessing}
                  style={{
                    padding: '9px 22px', borderRadius: 8, border: 'none',
                    cursor: password && !isProcessing ? 'pointer' : 'not-allowed',
                    background: password && !isProcessing ? '#0748EE' : 'var(--card-border)',
                    color: password && !isProcessing ? '#fff' : 'var(--text-muted)',
                    fontSize: 13, fontWeight: 700, fontFamily: 'Barlow',
                  }}
                >
                  {isProcessing ? 'Unlocking…' : 'Unlock & Extract'}
                </button>
              </div>
            </div>
          )}

          {/* Convert button */}
          <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={() => handleConvert()}
              disabled={!pdfFile || isProcessing}
              style={{
                padding: '11px 36px', borderRadius: 10, border: 'none', cursor: pdfFile && !isProcessing ? 'pointer' : 'not-allowed',
                background: pdfFile && !isProcessing ? '#0748EE' : 'var(--card-border)',
                color: pdfFile && !isProcessing ? '#fff' : 'var(--text-muted)',
                fontSize: 14, fontWeight: 700, fontFamily: 'Barlow', letterSpacing: 0.3,
                transition: 'all 0.15s',
              }}
            >
              {isProcessing ? 'Converting…' : 'Convert to Excel'}
            </button>
          </div>
        </div>

        {/* ── Results ── */}
        {result && (
          <>
            {/* Metadata strip */}
            <div style={{
              background: 'var(--surface)', border: '1px solid var(--card-border)',
              borderRadius: 16, padding: '20px 28px', marginBottom: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
                {/* Bank + account info */}
                <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                  {result.bank_name && (
                    <div>
                      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Sans', textTransform: 'uppercase', letterSpacing: 0.5 }}>Bank</p>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>{result.bank_name}</p>
                    </div>
                  )}
                  {result.account_no && (
                    <div>
                      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Sans', textTransform: 'uppercase', letterSpacing: 0.5 }}>Account (last 4)</p>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>XXXX{result.account_no}</p>
                    </div>
                  )}
                  {(result.period_from || result.period_to) && (
                    <div>
                      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Sans', textTransform: 'uppercase', letterSpacing: 0.5 }}>Period</p>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>{result.period_from} – {result.period_to}</p>
                    </div>
                  )}
                  <div>
                    <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Sans', textTransform: 'uppercase', letterSpacing: 0.5 }}>Transactions</p>
                    <p style={{ margin: 0, fontSize: 22, fontWeight: 900, color: '#0748EE', fontFamily: 'Barlow', lineHeight: 1.1 }}>{result.transaction_count?.toLocaleString()}</p>
                  </div>
                </div>

                {/* Download button */}
                <button
                  onClick={handleDownload}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 24px', borderRadius: 10, border: 'none',
                    background: '#0748EE', color: '#fff',
                    fontSize: 14, fontWeight: 700, fontFamily: 'Barlow', cursor: 'pointer',
                  }}
                >
                  <Download size={16} />
                  Download Excel
                </button>
              </div>

              {/* Validation badge */}
              {result.validation && (
                <div style={{ marginTop: 14 }}>
                  <ValidationBadge v={result.validation} />
                </div>
              )}

              {/* Open in Universal Bank Statement */}
              {result.transaction_count > 0 && (
                <div style={{ marginTop: 14 }}>
                  <button
                    onClick={() => navigate(`/brands/${brandId}/reco/universal_bank_statement`)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: 'none', border: '1px solid var(--card-border)',
                      borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
                      fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Sans',
                    }}
                  >
                    <ArrowRight size={13} />
                    Open Universal Bank Statement classifier
                    <span style={{ fontSize: 11, opacity: 0.7 }}>(upload the downloaded Excel there)</span>
                  </button>
                </div>
              )}
            </div>

            {/* Preview table */}
            {result.preview_rows?.length > 0 && (
              <div style={{
                background: 'var(--surface)', border: '1px solid var(--card-border)',
                borderRadius: 16, overflow: 'hidden',
              }}>
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--card-border)' }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, fontFamily: 'Barlow', color: 'var(--text-heading)' }}>
                    Preview — first {result.preview_rows.length} rows
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                      ({result.transaction_count} total in Excel)
                    </span>
                  </p>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'DM Sans' }}>
                    <thead>
                      <tr style={{ background: 'var(--page-bg)' }}>
                        {previewCols.map(c => (
                          <th key={c.key} style={{
                            padding: '8px 12px', textAlign: c.align,
                            color: 'var(--text-muted)', fontWeight: 600, fontSize: 11,
                            borderBottom: '1px solid var(--card-border)',
                            whiteSpace: 'nowrap', minWidth: c.w,
                          }}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.preview_rows.map((row, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--page-bg)' }}>
                          {previewCols.map(c => {
                            const val = row[c.key];
                            const isAmt = ['debit', 'credit', 'balance'].includes(c.key);
                            return (
                              <td key={c.key} style={{
                                padding: '7px 12px', textAlign: c.align,
                                color: c.key === 'debit' && val ? '#DC2626'
                                     : c.key === 'credit' && val ? '#059669'
                                     : 'var(--text-primary)',
                                borderBottom: '1px solid var(--card-border)',
                                maxWidth: c.key === 'description' ? 320 : undefined,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                fontWeight: isAmt && val ? 600 : 400,
                              }}>
                                {isAmt ? (val ? fmt(val) : '') : (val || '')}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.transaction_count > 10 && (
                  <p style={{ textAlign: 'center', padding: '10px 0', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Sans', margin: 0 }}>
                    … and {(result.transaction_count - 10).toLocaleString()} more rows in the Excel download
                  </p>
                )}
              </div>
            )}

            {/* Empty state */}
            {result.transaction_count === 0 && (
              <div style={{
                background: 'var(--surface)', border: '1px solid var(--card-border)',
                borderRadius: 16, padding: 32, textAlign: 'center',
              }}>
                <AlertCircle size={32} color="var(--text-muted)" style={{ marginBottom: 12 }} />
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
                  {result.validation?.verify_method === 'rejected' ? 'Not a bank / credit-card statement' : 'No transactions extracted'}
                </p>
                <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
                  {result.validation?.error
                    || 'The PDF format may not be supported yet. Try a text-based (not scanned) PDF.'}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
