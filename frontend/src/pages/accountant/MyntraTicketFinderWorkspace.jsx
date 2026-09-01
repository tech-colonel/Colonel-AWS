import React, { useCallback, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Bot } from 'lucide-react';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';
import DriveFilePicker from '../../components/DriveFilePicker';

// Marketplace Ticket Generator (Myntra reports today) — the tested in-browser
// tool is self-hosted at
// public/myntra-ticket-finder.html and embedded here. Raw Seller-Hub reports are
// processed entirely in the iframe (client-side); only a summary is persisted.
//
// Drive input: unlike the server-side agents (which use DriveOrUpload +
// /api/drive/route to map filenames to slots), this tool detects each report's
// type from its HEADERS. So we simply list the folder, download the picked
// files' bytes and postMessage them into the iframe, which routes them through
// its own processFile(). The iframe's manual upload keeps working unchanged.
const SHEET_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

const MyntraTicketFinderWorkspace = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const iframeRef = useRef(null);
  const [driveNote, setDriveNote] = useState('');

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  // Hand the downloaded bytes to the tool and wait for its acknowledgement.
  const sendToTool = useCallback((files) => new Promise((resolve) => {
    const frame = iframeRef.current;
    if (!frame || !frame.contentWindow) { setDriveNote('The tool is still loading — try again in a moment.'); resolve(); return; }

    let settled = false;
    const finish = (note) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onAck);
      clearTimeout(timer);
      setDriveNote(note);
      resolve();
    };
    const onAck = (ev) => {
      if (ev.origin !== window.location.origin) return;
      if (ev.source !== frame.contentWindow) return;
      if (!ev.data || ev.data.type !== 'COLONEL_DRIVE_FILES_RESULT') return;
      const failed = ev.data.failed || [];
      finish(
        failed.length
          ? `Loaded ${ev.data.loaded} of ${files.length}. Couldn’t read: ${failed.join(', ')}.`
          : `Loaded ${ev.data.loaded} file${ev.data.loaded === 1 ? '' : 's'} into the report cards below.`
      );
    };
    // The tool may ask you to identify an undetected report — don't hang on that.
    const timer = setTimeout(() => finish('Files sent to the tool — check the report cards below.'), 60000);

    window.addEventListener('message', onAck);
    frame.contentWindow.postMessage(
      { type: 'COLONEL_DRIVE_FILES', files: files.map((f) => ({ name: f.name, bytes: f.bytes })) },
      window.location.origin,
    );
  }), []);

  const handleDriveFiles = useCallback(async (files) => {
    setDriveNote('');
    await sendToTool(files);
  }, [sendToTool]);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>
        <button
          onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/agents`)}
          style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 14, marginBottom: 12 }}
        >
          ← Back to Agents
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-heading, #0F172A)', margin: '0 0 4px' }}>
          Marketplace Ticket Generator
        </h1>
        <p style={{ color: 'var(--text-muted, #64748B)', fontSize: 14, margin: '0 0 16px', lineHeight: 1.6 }}>
          Upload Myntra Seller Hub reports to automatically detect billing errors — commission not reversed,
          closed-box return claims, fixed-fee retention, commission overcharges — and generate proof files +
          ticket templates ready to paste into Myntra Seller Support. Raw reports stay in your browser.
        </p>

        <DriveFilePicker
          extensions={SHEET_EXTENSIONS}
          onFiles={handleDriveFiles}
          subtitle="Paste a folder link — the reports are matched to the right cards automatically."
          actionLabel="Load into the tool"
        />

        {driveNote && (
          <p style={{ color: 'var(--text-muted, #64748B)', fontSize: 12.5, margin: '10px 2px 0' }}>{driveNote}</p>
        )}

        <iframe
          ref={iframeRef}
          title="Marketplace Ticket Generator"
          src={`${process.env.PUBLIC_URL || ''}/myntra-ticket-finder.html`}
          style={{
            marginTop: 16,
            width: '100%',
            height: 'calc(100vh - 210px)',
            minHeight: 600,
            border: '1px solid var(--card-border, #E2E8F6)',
            borderRadius: 16,
            background: '#fff',
          }}
        />
      </div>
    </DashboardLayout>
  );
};

export default MyntraTicketFinderWorkspace;
