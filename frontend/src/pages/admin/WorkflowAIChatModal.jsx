import React, { useState, useRef, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Badge } from '../../components/ui/badge';
import { Sparkles, Send, Loader2, Plus, X, Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

const makeFileInputId = (i) => `file_${i}`;

const WorkflowAIChatModal = ({ agent, open, onClose, onHandoff }) => {
  const [step, setStep] = useState('upload'); // 'upload' | 'chat'
  const [fileInputs, setFileInputs] = useState([{ id: 'file_0', label: 'Input File' }]);
  const [sampleFiles, setSampleFiles] = useState({});
  const [perFileSheets, setPerFileSheets] = useState({});
  const [extracting, setExtracting] = useState(false);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingDraft, setPendingDraft] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setStep('upload');
      setFileInputs([{ id: 'file_0', label: 'Input File' }]);
      setSampleFiles({});
      setPerFileSheets({});
      setMessages([]);
      setInput('');
      setPendingDraft(null);
    }
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  const addFileInput = () => {
    const newId = makeFileInputId(fileInputs.length);
    setFileInputs(prev => [...prev, { id: newId, label: `File ${prev.length + 1}` }]);
  };

  const removeFileInput = (id) => {
    if (fileInputs.length <= 1) return;
    setFileInputs(prev => prev.filter(fi => fi.id !== id));
    setSampleFiles(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const updateFileInputLabel = (id, label) =>
    setFileInputs(prev => prev.map(fi => fi.id === id ? { ...fi, label } : fi));

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
      setStep('chat');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to extract columns');
    } finally {
      setExtracting(false);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    try {
      const res = await api.post('/api/workflows/ai/chat', {
        fileInputs,
        fileSheetsMap: perFileSheets,
        messages: nextMessages
      });
      const data = res.data?.data;
      if (!data) throw new Error('Empty response');

      if (data.type === 'question') {
        setMessages(prev => [...prev, { role: 'assistant', content: data.question }]);
      } else if (data.type === 'draft') {
        setPendingDraft(data.draft);
        setMessages(prev => [...prev, { role: 'assistant', content: data.summary || 'Draft ready.', draft: true }]);
      } else {
        const errText = (data.errors || []).map(e => e.message || e.path).join('; ') || 'Something went wrong.';
        setMessages(prev => [...prev, { role: 'assistant', content: errText, error: true }]);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reach the AI');
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong talking to the model. Try again.', error: true }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReviewInBuilder = () => {
    if (!pendingDraft) return;
    const firstSheets = perFileSheets[fileInputs[0]?.id] || [];
    const draftObj = {
      name: pendingDraft.name,
      description: pendingDraft.description,
      sample_columns: firstSheets[0]?.columns || [],
      fileInputs,
      sheets: pendingDraft.sheets
    };
    onHandoff(draftObj);
  };

  const uploadView = (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Upload a sample file for each input this workflow needs. The AI will map your SOP onto the real column names it finds.
      </p>
      <div className="space-y-2">
        {fileInputs.map((fi, i) => (
          <div key={fi.id} className="border border-slate-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={fi.label}
                onChange={(e) => updateFileInputLabel(fi.id, e.target.value)}
                className="h-8 text-sm flex-1"
                placeholder={`File ${i + 1}`}
              />
              {fileInputs.length > 1 && (
                <button onClick={() => removeFileInput(fi.id)} className="text-slate-400 hover:text-red-500">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => setSampleFiles(prev => ({ ...prev, [fi.id]: e.target.files[0] }))}
              className="text-xs w-full"
            />
            {sampleFiles[fi.id] && (
              <p className="text-xs text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> {sampleFiles[fi.id].name}
              </p>
            )}
          </div>
        ))}
      </div>
      <button
        onClick={addFileInput}
        className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add another file input
      </button>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleExtract} disabled={extracting}>
          {extracting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
          {extracting ? 'Reading columns...' : 'Continue'}
        </Button>
      </div>
    </div>
  );

  const chatView = (
    <div className="flex flex-col h-[70vh]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-1 pb-2">
        {messages.length === 0 && (
          <div className="text-sm text-slate-400 py-8 text-center">
            Describe the workflow's SOP — the steps, filters, formulas, and outputs it should produce.
            The AI may ask a clarifying question before drafting the workflow.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-indigo-600 text-white'
                  : m.error
                    ? 'bg-red-50 text-red-700 border border-red-200'
                    : 'bg-slate-100 text-slate-800'
              }`}
            >
              {m.error && <AlertTriangle className="h-3.5 w-3.5 inline mr-1 -mt-0.5" />}
              {m.content}
              {m.draft && i === messages.length - 1 && pendingDraft && (
                <div className="mt-2">
                  <Button size="sm" onClick={handleReviewInBuilder} className="h-7 text-xs">
                    Review in Builder
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-100 text-slate-500 rounded-lg px-3 py-2 text-sm flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking...
            </div>
          </div>
        )}
      </div>
      <div className="flex items-end gap-2 pt-2 border-t border-slate-100">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the SOP, or answer the clarifying question..."
          className="min-h-[44px] max-h-40 text-sm"
          disabled={loading}
        />
        <Button onClick={handleSend} disabled={loading || !input.trim()} className="h-9 shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent onClose={onClose} className="max-w-xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-600" />
            Create Workflow with AI — {agent?.name}
            {step === 'chat' && <Badge variant="secondary" className="text-xs ml-1">SOP chat</Badge>}
          </DialogTitle>
        </DialogHeader>
        {step === 'upload' ? uploadView : chatView}
      </DialogContent>
    </Dialog>
  );
};

export default WorkflowAIChatModal;
