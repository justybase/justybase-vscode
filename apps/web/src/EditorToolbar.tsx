import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConnectionProfileSummary, MetadataDatabase } from '@justybase/contracts';

// ── SVG Icons ──────────────────────────────────────────

function SaveIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function PlayIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SplitIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M2 12h20" opacity=".4" />
    </svg>
  );
}

function FileIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function CommentIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      <line x1="10" y1="9" x2="14" y2="9" />
    </svg>
  );
}

function FormatIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

function CancelIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  );
}

// ── Run mode types ────────────────────────────────────

export type RunMode = 'run' | 'smart' | 'batch' | 'export-csv' | 'export-xlsx' | 'export-xlsb';

// ── Props ──────────────────────────────────────────────

export interface EditorToolbarProps {
  connectionId: string;
  database: string;
  connections: ConnectionProfileSummary[];
  databases: MetadataDatabase[];
  onSelectConnection: (id: string) => void;
  onSelectDatabase: (db: string) => void;
  onRun: (mode: RunMode) => void;
  onSave: () => void;
  onComment: () => void;
  onFormat: () => void;
  isRunning: boolean;
  onCancel: () => void;
}

// ── Component ──────────────────────────────────────────

export function EditorToolbar({
  connectionId,
  database,
  connections,
  databases,
  onSelectConnection,
  onSelectDatabase,
  onRun,
  onSave,
  onComment,
  onFormat,
  isRunning,
  onCancel,
}: EditorToolbarProps): ReactElement {
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const runMenuRef = useRef<HTMLDivElement | null>(null);
  const modKey = typeof navigator !== 'undefined' && /Mac|iP(hone|od|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl';

  // Close dropdown on outside click
  useEffect(() => {
    if (!runMenuOpen) return;
    function handler(e: MouseEvent) {
      if (runMenuRef.current && !runMenuRef.current.contains(e.target as Node)) {
        setRunMenuOpen(false);
      }
    }
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [runMenuOpen]);

  const runModes: { key: RunMode; label: string; icon: ReactElement }[] = [
    { key: 'run', label: 'Run', icon: <PlayIcon /> },
    { key: 'smart', label: 'Smart run (split by ;)', icon: <SplitIcon /> },
    { key: 'batch', label: 'Run as single batch', icon: <PlayIcon /> },
    { key: 'export-csv', label: 'Run → Export CSV', icon: <FileIcon /> },
    { key: 'export-xlsx', label: 'Run → Export XLSX', icon: <FileIcon /> },
    { key: 'export-xlsb', label: 'Run → Export XLSB (preferred, faster)', icon: <FileIcon /> },
  ];

  return (
    <div className="editor-toolbar">
      {/* Left group */}
      <div className="toolbar-left">
        <button className="tb-btn" title={`Save (${modKey}+S)`} onClick={onSave}>
          <SaveIcon />
        </button>

        <div className="tb-sep" />

        {/* Run button group split-button style */}
        <div className="tb-run-group" ref={runMenuRef}>
          <button
            className="tb-btn tb-run-btn"
            title={`Run (${modKey}+Enter)`}
            disabled={isRunning || !connectionId}
            onClick={() => { onRun('run'); setRunMenuOpen(false); }}
          >
            <PlayIcon />
            {isRunning ? <span className="running">Running…</span> : <span>Run</span>}
          </button>
          <button
            className="tb-btn tb-run-arrow"
            title="More run options"
            disabled={!connectionId}
            onClick={() => setRunMenuOpen(prev => !prev)}
          >
            <ChevronDownIcon />
          </button>
          {runMenuOpen && (
            <div className="tb-run-dropdown">
              {runModes.slice(1).map(mode => (
                <button
                  key={mode.key}
                  className="tb-run-option"
                  onClick={() => { onRun(mode.key); setRunMenuOpen(false); }}
                >
                  {mode.icon}
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {isRunning && (
          <button className="tb-btn tb-cancel-btn" title="Cancel (Esc)" onClick={onCancel}>
            <CancelIcon />
            Cancel
          </button>
        )}
      </div>

      {/* Center group */}
      <div className="toolbar-center">
        <button className="tb-btn" title={`Toggle comment (${modKey}+/)`} onClick={onComment}>
          <CommentIcon />
        </button>
        <button className="tb-btn" title={`Format SQL (${modKey}+Shift+F)`} onClick={onFormat}>
          <FormatIcon />
        </button>
      </div>

      {/* Right group */}
      <div className="toolbar-right">          <select
          className="tb-select"
          title="Connection"
          value={connectionId || ''}
          onChange={e => onSelectConnection(e.target.value)}
        >
          <option value="">{connections.length === 0 ? 'No connections' : '—'}</option>
          {connections.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <select
          className="tb-select"
          title="Database"
          value={database || ''}
          onChange={e => onSelectDatabase(e.target.value)}
          disabled={!connectionId}
        >
          {databases.length === 0
            ? <option value="">{connectionId ? 'No databases' : 'Select connection'}</option>
            : <option value="">—</option>
          }
          {databases.map(db => (
            <option key={db.name} value={db.name}>{db.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
