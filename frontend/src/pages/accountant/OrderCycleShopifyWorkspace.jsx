import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/modal';
import {
    Loader2, Plus, Download, Trash2, FileText, RefreshCw,
    ChevronRight, ChevronLeft, Upload, CheckCircle2,
    Package, CreditCard, ShoppingBag
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '../../lib/api';

// ─── Fixed partner lists ──────────────────────────────────────────────────────
const LOGISTICS_PARTNERS = [
    { id: 'delhivery',   label: 'Delhivery' },
    { id: 'xpressbees',  label: 'Xpressbees (Busybees)' },
    { id: 'ekart',       label: 'Instakart (Ekart)' },
    { id: 'bluedart',    label: 'Bluedart' },
];

const PAYMENT_GATEWAYS = [
    { id: 'razorpay',  label: 'Razorpay' },
    { id: 'snapmint',  label: 'Snapmint' },
    { id: 'bharatx',   label: 'BharatX (AuroraX)' },
];

// ─── Step constants ───────────────────────────────────────────────────────────
const STEP_SELECT  = 1;   // choose gateways & logistics from list
const STEP_UPLOAD  = 2;   // upload shopify + one file per selection
const STEP_PREVIEW = 3;   // summary before commit

const MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
];
const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => currentYear - i);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(d) {
    if (!d) return '—';
    try { return format(new Date(d), 'dd MMM yyyy'); }
    catch { return d; }
}

const initModal = () => ({
    open: false,
    step: STEP_SELECT,
    month: MONTHS[new Date().getMonth()],
    year: String(currentYear),
    selectedGateways:  [],   // array of ids
    selectedLogistics: [],   // array of ids
    unicommerceFile: null,
    salesOrderReportFile: null,
    gatewayFiles:  {},    // { [id]: File }
    logisticsFiles: {},   // { [id]: File }
});

// ─── Main Component ───────────────────────────────────────────────────────────
const OrderCycleShopifyWorkspace = ({ agent }) => {
    const { brandId, agentId } = useParams();

    const [modal, setModal]             = useState(initModal());
    const [isGenerating, setIsGenerating] = useState(false);
    const [previewData, setPreviewData]   = useState(null);
    const [files, setFiles]             = useState([]);
    const [filesLoading, setFilesLoading] = useState(true);

    // ─── Fetch generated files ──────────────────────────────────────────────
    const fetchFiles = useCallback(async () => {
        setFilesLoading(true);
        try {
            const res = await api.get(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files`
            );
            setFiles(res.data || []);
        } catch (err) {
            console.error('Failed to fetch order cycle files:', err);
            setFiles([]);
        } finally {
            setFilesLoading(false);
        }
    }, [brandId, agentId]);

    useEffect(() => { fetchFiles(); }, [fetchFiles]);

    // ─── Modal open / close ─────────────────────────────────────────────────
    const openModal = () => setModal({ ...initModal(), open: true });

    const closeModal = () => {
        if (isGenerating) return;
        setModal(initModal());
        setPreviewData(null);
    };

    const setField = (key, value) =>
        setModal(prev => ({ ...prev, [key]: value }));

    // ─── Toggle selection helpers ───────────────────────────────────────────
    const toggleGateway = (id) => {
        setModal(prev => {
            const exists = prev.selectedGateways.includes(id);
            return {
                ...prev,
                selectedGateways: exists
                    ? prev.selectedGateways.filter(g => g !== id)
                    : [...prev.selectedGateways, id],
                // Clear any uploaded file if deselected
                gatewayFiles: exists
                    ? { ...prev.gatewayFiles, [id]: null }
                    : prev.gatewayFiles,
            };
        });
    };

    const toggleLogistics = (id) => {
        setModal(prev => {
            const exists = prev.selectedLogistics.includes(id);
            return {
                ...prev,
                selectedLogistics: exists
                    ? prev.selectedLogistics.filter(l => l !== id)
                    : [...prev.selectedLogistics, id],
                logisticsFiles: exists
                    ? { ...prev.logisticsFiles, [id]: null }
                    : prev.logisticsFiles,
            };
        });
    };

    const setGatewayFile  = (id, file) => setModal(prev => ({
        ...prev, gatewayFiles: { ...prev.gatewayFiles, [id]: file }
    }));
    const setLogisticsFile = (id, file) => setModal(prev => ({
        ...prev, logisticsFiles: { ...prev.logisticsFiles, [id]: file }
    }));

    // ─── Validations ────────────────────────────────────────────────────────
    const validateStep1 = () => {
        if (!modal.month) { toast.error('Please select a month'); return false; }
        if (!modal.year)  { toast.error('Please select a year');  return false; }
        if (modal.selectedGateways.length === 0) {
            toast.error('Select at least one payment gateway'); return false;
        }
        if (modal.selectedLogistics.length === 0) {
            toast.error('Select at least one logistics partner'); return false;
        }
        return true;
    };

    const validateStep2 = () => {
        if (!modal.unicommerceFile) {
            toast.error('Please upload the Unicommerce file'); return false;
        }
        if (!modal.salesOrderReportFile) {
            toast.error('Please upload the Sales Order Report file'); return false;
        }
        for (const id of modal.selectedGateways) {
            if (!modal.gatewayFiles[id]) {
                const label = PAYMENT_GATEWAYS.find(g => g.id === id)?.label || id;
                toast.error(`Upload file for ${label}`); return false;
            }
        }
        for (const id of modal.selectedLogistics) {
            if (!modal.logisticsFiles[id]) {
                const label = LOGISTICS_PARTNERS.find(l => l.id === id)?.label || id;
                toast.error(`Upload file for ${label}`); return false;
            }
        }
        return true;
    };

    // ─── Step navigation ────────────────────────────────────────────────────
    const nextStep = () => {
        if (modal.step === STEP_SELECT && !validateStep1()) return;
        setModal(prev => ({ ...prev, step: prev.step + 1 }));
    };

    const prevStep = () => {
        if (modal.step > STEP_SELECT)
            setModal(prev => ({ ...prev, step: prev.step - 1 }));
    };

    // ─── Phase 1: Generate Preview ──────────────────────────────────────────
    const handleGeneratePreview = async () => {
        if (!validateStep2()) return;

        const gwNames = modal.selectedGateways.map(
            id => PAYMENT_GATEWAYS.find(g => g.id === id)?.label || id
        );
        const lpNames = modal.selectedLogistics.map(
            id => LOGISTICS_PARTNERS.find(l => l.id === id)?.label || id
        );

        // Build FormData
        const formData = new FormData();
        formData.append('month', modal.month);
        formData.append('year',  modal.year);
        formData.append('gatewayNames',  JSON.stringify(gwNames));
        formData.append('logisticsNames', JSON.stringify(lpNames));
        formData.append('unicommerceFile', modal.unicommerceFile);
        formData.append('salesOrderReportFile', modal.salesOrderReportFile);

        modal.selectedGateways.forEach((id, i) => {
            if (modal.gatewayFiles[id])
                formData.append(`paymentGateway_${i}`, modal.gatewayFiles[id]);
        });
        modal.selectedLogistics.forEach((id, i) => {
            if (modal.logisticsFiles[id])
                formData.append(`logistics_${i}`, modal.logisticsFiles[id]);
        });

        setIsGenerating(true);
        try {
            const res = await api.post(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/generate/preview`,
                formData,
                { headers: { 'Content-Type': 'multipart/form-data' } }
            );
            setPreviewData(res.data);
            setModal(prev => ({ ...prev, step: STEP_PREVIEW }));
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to process files');
        } finally {
            setIsGenerating(false);
        }
    };

    // ─── Phase 2a: Commit ───────────────────────────────────────────────────
    const handleCommit = async () => {
        if (!previewData?.taskId) return;
        setIsGenerating(true);
        try {
            await api.post(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/generate/commit`,
                { taskId: previewData.taskId }
            );
            toast.success('Order Cycle file saved successfully ✅');
            closeModal();
            fetchFiles();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to save file');
        } finally {
            setIsGenerating(false);
        }
    };

    // ─── Phase 2b: Discard ──────────────────────────────────────────────────
    const handleDiscard = async () => {
        if (previewData?.taskId) {
            try {
                await api.post(
                    `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/generate/discard`,
                    { taskId: previewData.taskId }
                );
            } catch { /* TTL cleans up */ }
        }
        toast.info('Generation discarded');
        closeModal();
    };

    // ─── Download ───────────────────────────────────────────────────────────
    const handleDownload = async (filename) => {
        try {
            const safe = encodeURIComponent(filename);
            const res = await api.get(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files/${safe}/download`,
                { responseType: 'blob' }
            );
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a');
            a.href = url;
            a.setAttribute('download', filename);
            document.body.appendChild(a);
            a.click();
            a.remove();
            toast.success('Downloaded');
        } catch { toast.error('Download failed'); }
    };

    // ─── Delete ─────────────────────────────────────────────────────────────
    const handleDelete = async (filename) => {
        if (!window.confirm(`Delete "${filename}"? This cannot be undone.`)) return;
        try {
            await api.delete(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files`,
                { data: { filename } }
            );
            toast.success('File deleted');
            fetchFiles();
        } catch { toast.error('Delete failed'); }
    };

    // ─── Step labels ────────────────────────────────────────────────────────
    const stepLabels = ['Select Partners', 'Upload Files', 'Preview & Save'];

    // ─── Render ──────────────────────────────────────────────────────────────
    return (
        <div className="space-y-6">

            {/* Top Action Bar */}
            <div className="flex items-center gap-3">
                <Button
                    onClick={openModal}
                    data-testid="oc-generate-button"
                >
                    <Plus className="mr-2 h-4 w-4" />
                    Generate File
                </Button>
                <Button variant="outline" onClick={fetchFiles} disabled={filesLoading}>
                    <RefreshCw className={`mr-2 h-4 w-4 ${filesLoading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            {/* Generated Files Table */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <FileText className="h-5 w-5" />
                        Generated Files
                        {!filesLoading && (
                            <Badge variant="secondary" className="ml-1">{files.length}</Badge>
                        )}
                    </CardTitle>
                    <CardDescription>
                        Order Cycle output files for {agent?.name}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {filesLoading ? (
                        <div className="flex items-center justify-center py-16">
                            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                            <span className="ml-3 text-slate-500 text-sm">Loading…</span>
                        </div>
                    ) : files.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                            <FileText className="h-12 w-12 text-slate-300 mb-4" />
                            <p className="text-base font-medium">No files generated yet</p>
                            <p className="text-sm text-slate-400 mt-1">
                                Click "Generate File" to begin
                            </p>
                        </div>
                    ) : (
                        <div className="border border-slate-200 rounded-lg overflow-hidden">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-slate-50">
                                        <TableHead className="font-semibold">Filename</TableHead>
                                        <TableHead className="font-semibold">Month</TableHead>
                                        <TableHead className="font-semibold">Year</TableHead>
                                        <TableHead className="font-semibold">Rows</TableHead>
                                        <TableHead className="font-semibold">Created</TableHead>
                                        <TableHead className="text-right font-semibold">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {files.map((file, idx) => (
                                        <TableRow key={idx} className="hover:bg-slate-50">
                                            <TableCell
                                                className="font-mono text-xs text-slate-600 max-w-[260px] truncate"
                                                title={file.filename}
                                            >
                                                {file.filename}
                                            </TableCell>
                                            <TableCell>{file.month}</TableCell>
                                            <TableCell>{file.year}</TableCell>
                                            <TableCell>
                                                <Badge variant="secondary">{file.row_count ?? '—'}</Badge>
                                            </TableCell>
                                            <TableCell className="text-sm text-slate-500">
                                                {formatDate(file.created_at)}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <Button
                                                        size="sm" variant="secondary"
                                                        onClick={() => handleDownload(file.filename)}
                                                        data-testid={`oc-download-${idx}`}
                                                    >
                                                        <Download className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        size="sm" variant="destructive"
                                                        onClick={() => handleDelete(file.filename)}
                                                        data-testid={`oc-delete-${idx}`}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ─── Multi-Step Generate Modal ────────────────────────────────── */}
            <Dialog
                open={modal.open}
                onOpenChange={(open) => { if (!open) closeModal(); }}
            >
                <DialogContent
                    onClose={closeModal}
                    className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
                >
                    <DialogHeader>
                        <DialogTitle>Generate Order Cycle File</DialogTitle>
                        <DialogDescription>
                            {agent?.name} — {modal.month} {modal.year}
                        </DialogDescription>
                    </DialogHeader>

                    {/* ── Step indicator ──────────────────────────────────── */}
                    <div className="flex items-center gap-0 mb-2 select-none shrink-0">
                        {stepLabels.map((label, i) => {
                            const stepNum = i + 1;
                            const isActive = modal.step === stepNum;
                            const isDone   = modal.step > stepNum;
                            return (
                                <React.Fragment key={label}>
                                    <div className="flex flex-col items-center min-w-[60px]">
                                        <div className={`
                                            flex items-center justify-center w-8 h-8 rounded-full
                                            text-xs font-bold transition-colors
                                            ${isDone   ? 'bg-green-600 text-white' : ''}
                                            ${isActive ? 'bg-slate-900 text-white' : ''}
                                            ${!isActive && !isDone ? 'bg-slate-200 text-slate-500' : ''}
                                        `}>
                                            {isDone
                                                ? <CheckCircle2 className="h-4 w-4" />
                                                : stepNum}
                                        </div>
                                        <span className={`
                                            text-[10px] mt-1 font-medium text-center leading-tight
                                            ${isActive ? 'text-slate-900' : 'text-slate-400'}
                                        `}>
                                            {label}
                                        </span>
                                    </div>
                                    {i < stepLabels.length - 1 && (
                                        <div className={`
                                            flex-1 h-0.5 mx-2 mb-4 transition-colors
                                            ${modal.step > stepNum ? 'bg-green-500' : 'bg-slate-200'}
                                        `} />
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </div>

                    {/* ══════════════════════════════════════════════════════
                        STEP 1 — Select Partners
                    ══════════════════════════════════════════════════════ */}
                    {modal.step === STEP_SELECT && (
                        <div className="flex-1 overflow-y-auto space-y-5 py-2 pr-1">

                            {/* Period */}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <Label htmlFor="oc-month" className="text-sm font-medium">
                                        Month *
                                    </Label>
                                    <select
                                        id="oc-month"
                                        className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white"
                                        value={modal.month}
                                        onChange={e => setField('month', e.target.value)}
                                    >
                                        <option value="">— Select Month —</option>
                                        {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <Label htmlFor="oc-year" className="text-sm font-medium">
                                        Year *
                                    </Label>
                                    <select
                                        id="oc-year"
                                        className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white"
                                        value={modal.year}
                                        onChange={e => setField('year', e.target.value)}
                                    >
                                        {YEARS.map(y => (
                                            <option key={y} value={String(y)}>{y}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            {/* Payment Gateways */}
                            <div className="border border-blue-200 rounded-xl p-4 bg-blue-50/50">
                                <div className="flex items-center gap-2 mb-3">
                                    <CreditCard className="h-5 w-5 text-blue-600" />
                                    <p className="font-semibold text-slate-800">
                                        Payment Gateways
                                    </p>
                                    {modal.selectedGateways.length > 0 && (
                                        <Badge className="ml-auto bg-blue-600 text-white text-xs">
                                            {modal.selectedGateways.length} selected
                                        </Badge>
                                    )}
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                    {PAYMENT_GATEWAYS.map(gw => {
                                        const selected = modal.selectedGateways.includes(gw.id);
                                        return (
                                            <button
                                                key={gw.id}
                                                type="button"
                                                onClick={() => toggleGateway(gw.id)}
                                                className={`
                                                    flex items-center gap-3 w-full px-4 py-3 rounded-lg border-2
                                                    text-left text-sm font-medium transition-all
                                                    ${selected
                                                        ? 'border-blue-500 bg-blue-100 text-blue-900'
                                                        : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50'
                                                    }
                                                `}
                                                data-testid={`gw-toggle-${gw.id}`}
                                            >
                                                <span className={`
                                                    w-5 h-5 rounded shrink-0 flex items-center justify-center
                                                    border-2 transition-colors
                                                    ${selected ? 'bg-blue-600 border-blue-600' : 'border-slate-300 bg-white'}
                                                `}>
                                                    {selected && (
                                                        <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                                                            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                                        </svg>
                                                    )}
                                                </span>
                                                {gw.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Logistics Partners */}
                            <div className="border border-orange-200 rounded-xl p-4 bg-orange-50/50">
                                <div className="flex items-center gap-2 mb-3">
                                    <Package className="h-5 w-5 text-orange-600" />
                                    <p className="font-semibold text-slate-800">
                                        Logistics Partners
                                    </p>
                                    {modal.selectedLogistics.length > 0 && (
                                        <Badge className="ml-auto bg-orange-500 text-white text-xs">
                                            {modal.selectedLogistics.length} selected
                                        </Badge>
                                    )}
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                    {LOGISTICS_PARTNERS.map(lp => {
                                        const selected = modal.selectedLogistics.includes(lp.id);
                                        return (
                                            <button
                                                key={lp.id}
                                                type="button"
                                                onClick={() => toggleLogistics(lp.id)}
                                                className={`
                                                    flex items-center gap-3 w-full px-4 py-3 rounded-lg border-2
                                                    text-left text-sm font-medium transition-all
                                                    ${selected
                                                        ? 'border-orange-500 bg-orange-100 text-orange-900'
                                                        : 'border-slate-200 bg-white text-slate-600 hover:border-orange-300 hover:bg-orange-50'
                                                    }
                                                `}
                                                data-testid={`lp-toggle-${lp.id}`}
                                            >
                                                <span className={`
                                                    w-5 h-5 rounded shrink-0 flex items-center justify-center
                                                    border-2 transition-colors
                                                    ${selected ? 'bg-orange-500 border-orange-500' : 'border-slate-300 bg-white'}
                                                `}>
                                                    {selected && (
                                                        <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                                                            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                                        </svg>
                                                    )}
                                                </span>
                                                {lp.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ══════════════════════════════════════════════════════
                        STEP 2 — Upload Files
                    ══════════════════════════════════════════════════════ */}
                    {modal.step === STEP_UPLOAD && (
                        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">

                            {/* Unicommerce File */}
                            <div className="border-2 border-slate-200 rounded-xl p-4">
                                <div className="flex items-center gap-2 mb-3">
                                    <ShoppingBag className="h-5 w-5 text-slate-600" />
                                    <p className="font-semibold text-slate-800 text-sm">
                                        Upload Unicommerce File *
                                    </p>
                                    {modal.unicommerceFile && (
                                        <Badge className="ml-auto bg-green-100 text-green-700 border border-green-300 text-xs">
                                            <CheckCircle2 className="h-3 w-3 mr-1 inline" />
                                            {modal.unicommerceFile.name}
                                        </Badge>
                                    )}
                                </div>
                                <Input
                                    id="oc-unicommerce-file"
                                    type="file"
                                    accept=".xlsx,.xls,.csv"
                                    onChange={e => setField('unicommerceFile', e.target.files[0] || null)}
                                    className="h-9 text-sm"
                                />
                            </div>

                            {/* Sales Order Report File */}
                            <div className="border-2 border-slate-200 rounded-xl p-4 mt-4">
                                <div className="flex items-center gap-2 mb-3">
                                    <FileText className="h-5 w-5 text-slate-600" />
                                    <p className="font-semibold text-slate-800 text-sm">
                                        Upload Sales Order Report *
                                    </p>
                                    {modal.salesOrderReportFile && (
                                        <Badge className="ml-auto bg-green-100 text-green-700 border border-green-300 text-xs">
                                            <CheckCircle2 className="h-3 w-3 mr-1 inline" />
                                            {modal.salesOrderReportFile.name}
                                        </Badge>
                                    )}
                                </div>
                                <Input
                                    id="oc-sales-order-file"
                                    type="file"
                                    accept=".xlsx,.xls,.csv"
                                    onChange={e => setField('salesOrderReportFile', e.target.files[0] || null)}
                                    className="h-9 text-sm"
                                />
                            </div>

                            {/* Payment Gateway Files */}
                            {modal.selectedGateways.length > 0 && (
                                <div>
                                    <div className="flex items-center gap-2 mb-2">
                                        <CreditCard className="h-4 w-4 text-blue-600" />
                                        <p className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                                            Payment Gateway Files
                                        </p>
                                    </div>
                                    <div className="space-y-3">
                                        {modal.selectedGateways.map(id => {
                                            const gw = PAYMENT_GATEWAYS.find(g => g.id === id);
                                            const file = modal.gatewayFiles[id];
                                            return (
                                                <div
                                                    key={id}
                                                    className="border-2 border-blue-100 rounded-xl p-3 bg-blue-50/40"
                                                >
                                                    <div className="flex items-center justify-between mb-2">
                                                        <Label
                                                            htmlFor={`gw-file-${id}`}
                                                            className="text-sm font-medium text-blue-800 flex items-center gap-2"
                                                        >
                                                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-200 text-blue-800 text-xs font-bold">
                                                                {modal.selectedGateways.indexOf(id) + 1}
                                                            </span>
                                                            {gw?.label} *
                                                        </Label>
                                                        {file && (
                                                            <span className="text-xs text-green-700 font-medium flex items-center gap-1">
                                                                <CheckCircle2 className="h-3 w-3" />
                                                                {file.name}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <Input
                                                        id={`gw-file-${id}`}
                                                        type="file"
                                                        accept=".xlsx,.xls,.csv"
                                                        onChange={e => setGatewayFile(id, e.target.files[0] || null)}
                                                        className="h-9 text-sm"
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Logistics Partner Files */}
                            {modal.selectedLogistics.length > 0 && (
                                <div>
                                    <div className="flex items-center gap-2 mb-2">
                                        <Package className="h-4 w-4 text-orange-600" />
                                        <p className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                                            Logistics Partner Files
                                        </p>
                                    </div>
                                    <div className="space-y-3">
                                        {modal.selectedLogistics.map(id => {
                                            const lp = LOGISTICS_PARTNERS.find(l => l.id === id);
                                            const file = modal.logisticsFiles[id];
                                            return (
                                                <div
                                                    key={id}
                                                    className="border-2 border-orange-100 rounded-xl p-3 bg-orange-50/40"
                                                >
                                                    <div className="flex items-center justify-between mb-2">
                                                        <Label
                                                            htmlFor={`lp-file-${id}`}
                                                            className="text-sm font-medium text-orange-800 flex items-center gap-2"
                                                        >
                                                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-200 text-orange-800 text-xs font-bold">
                                                                {modal.selectedLogistics.indexOf(id) + 1}
                                                            </span>
                                                            {lp?.label} *
                                                        </Label>
                                                        {file && (
                                                            <span className="text-xs text-green-700 font-medium flex items-center gap-1">
                                                                <CheckCircle2 className="h-3 w-3" />
                                                                {file.name}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <Input
                                                        id={`lp-file-${id}`}
                                                        type="file"
                                                        accept=".xlsx,.xls,.csv"
                                                        onChange={e => setLogisticsFile(id, e.target.files[0] || null)}
                                                        className="h-9 text-sm"
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ══════════════════════════════════════════════════════
                        STEP 3 — Preview & Confirm
                    ══════════════════════════════════════════════════════ */}
                    {modal.step === STEP_PREVIEW && (
                        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
                            {isGenerating ? (
                                <div className="flex flex-col items-center justify-center py-16 gap-4">
                                    <Loader2 className="h-10 w-10 animate-spin text-slate-500" />
                                    <p className="text-slate-600 font-medium">Processing all files…</p>
                                    <p className="text-xs text-slate-400">This may take a moment</p>
                                </div>
                            ) : previewData ? (
                                <>
                                    {/* Unicommerce rows */}
                                    <div className="flex items-center justify-between px-4 py-3 bg-slate-50 rounded-lg border border-slate-200">
                                        <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                                            <ShoppingBag className="h-4 w-4 text-slate-500" />
                                            Unicommerce Rows Parsed
                                        </span>
                                        <Badge variant="secondary" className="text-base font-bold px-3 py-1">
                                            {previewData.summary?.unicommerceRows ?? '—'}
                                        </Badge>
                                    </div>

                                    {/* Sales Order Report rows */}
                                    <div className="flex items-center justify-between px-4 py-3 bg-slate-50 rounded-lg border border-slate-200 mt-2">
                                        <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                                            <FileText className="h-4 w-4 text-slate-500" />
                                            Sales Order Rows Parsed
                                        </span>
                                        <Badge variant="secondary" className="text-base font-bold px-3 py-1">
                                            {previewData.summary?.salesOrderRows ?? '—'}
                                        </Badge>
                                    </div>

                                    {/* Gateway breakdowns */}
                                    {previewData.summary?.gateways &&
                                        Object.entries(previewData.summary.gateways).map(([name, count]) => (
                                            <div key={name} className="flex items-center justify-between px-4 py-3 bg-blue-50 rounded-lg border border-blue-200">
                                                <span className="flex items-center gap-2 text-sm font-medium text-blue-700">
                                                    <CreditCard className="h-4 w-4" /> {name}
                                                </span>
                                                <Badge className="bg-blue-600 text-white px-3 py-1">
                                                    {count} rows
                                                </Badge>
                                            </div>
                                        ))
                                    }

                                    {/* Logistics breakdowns */}
                                    {previewData.summary?.logistics &&
                                        Object.entries(previewData.summary.logistics).map(([name, count]) => (
                                            <div key={name} className="flex items-center justify-between px-4 py-3 bg-orange-50 rounded-lg border border-orange-200">
                                                <span className="flex items-center gap-2 text-sm font-medium text-orange-700">
                                                    <Package className="h-4 w-4" /> {name}
                                                </span>
                                                <Badge className="bg-orange-500 text-white px-3 py-1">
                                                    {count} rows
                                                </Badge>
                                            </div>
                                        ))
                                    }

                                    {/* Output rows */}
                                    <div className="flex items-center justify-between px-4 py-3 bg-green-50 rounded-lg border border-green-200">
                                        <span className="flex items-center gap-2 text-sm font-medium text-green-700">
                                            <CheckCircle2 className="h-4 w-4" />
                                            Output Rows (Order Cycle)
                                        </span>
                                        <Badge className="bg-green-600 text-white text-base font-bold px-3 py-1">
                                            {previewData.rowCount ?? '—'}
                                        </Badge>
                                    </div>

                                    <p className="text-xs text-slate-400 text-center pt-1">
                                        Review the file parse counts above. Click{' '}
                                        <strong>Confirm &amp; Save</strong> to write the file,
                                        or <strong>Discard</strong> to cancel.
                                    </p>
                                </>
                            ) : null}
                        </div>
                    )}

                    {/* ── Footer ──────────────────────────────────────────── */}
                    <div className="flex items-center justify-between pt-4 border-t mt-2 shrink-0">
                        {/* Back */}
                        <div>
                            {modal.step > STEP_SELECT && !isGenerating && (
                                <Button variant="outline" onClick={prevStep}>
                                    <ChevronLeft className="mr-1 h-4 w-4" /> Back
                                </Button>
                            )}
                        </div>

                        <div className="flex gap-2">
                            {/* Step 1 → Next */}
                            {modal.step === STEP_SELECT && (
                                <Button onClick={nextStep} data-testid="oc-next-btn">
                                    Next <ChevronRight className="ml-1 h-4 w-4" />
                                </Button>
                            )}

                            {/* Step 2 → Generate (call preview API) */}
                            {modal.step === STEP_UPLOAD && (
                                <Button
                                    onClick={handleGeneratePreview}
                                    disabled={isGenerating}
                                    data-testid="oc-generate-preview-btn"
                                >
                                    {isGenerating
                                        ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processing…</>
                                        : <><Upload className="mr-2 h-4 w-4" />Generate</>
                                    }
                                </Button>
                            )}

                            {/* Step 3 → Discard / Confirm */}
                            {modal.step === STEP_PREVIEW && previewData && !isGenerating && (
                                <>
                                    <Button variant="outline" onClick={handleDiscard}>
                                        Discard
                                    </Button>
                                    <Button
                                        onClick={handleCommit}
                                        className="bg-green-700 hover:bg-green-800"
                                        data-testid="oc-confirm-btn"
                                    >
                                        <CheckCircle2 className="mr-2 h-4 w-4" />
                                        Confirm &amp; Save
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default OrderCycleShopifyWorkspace;
