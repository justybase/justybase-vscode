import type { ReactElement } from 'react';
import type { MetadataColumn, SchemaTreeNode } from '@justybase/contracts';
import { typeClass } from './SchemaTree';

// ── Column icon SVG ────────────────────────────────────

function ColumnSvgIcon({ isPk }: { isPk?: boolean }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke={isPk ? '#fbbf24' : '#94a3b8'} strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M2 12h20" opacity=".3" />
    </svg>
  );
}

// ── Database icon ──────────────────────────────────────

function DatabaseSvgIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function SchemaSvgIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M3 9h18" />
    </svg>
  );
}

// ── InspectorPanel props ────────────────────────────────

export interface InspectorPanelProps {
  database: string;
  schema: string;
  columns: MetadataColumn[];
  selectedObject?: SchemaTreeNode | null;
  onInsertColumn(column: MetadataColumn): void;
  connectionName?: string;
}

// ── InspectorPanel component ─────────────────────────────

export function InspectorPanel({
  database,
  schema,
  columns,
  selectedObject,
  onInsertColumn,
  connectionName,
}: InspectorPanelProps): ReactElement {
  // Sort columns: PK first, then by name
  const sorted = [...columns].sort((a, b) => {
    if (a.isPk && !b.isPk) return -1;
    if (!a.isPk && b.isPk) return 1;
    return a.name.localeCompare(b.name);
  });

  const pkCount = columns.filter(c => c.isPk).length;

  return (
    <div className="inspector-panel">
      {/* ── Context section ── */}
      <div className="inspector-section">
        <div className="inspector-section-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
          Context
        </div>
        <div className="inspector-context-card">
          {connectionName && (
            <div className="inspector-context-row">
              <DatabaseSvgIcon />
              <div className="inspector-context-text">
                <span className="inspector-context-label">Connection</span>
                <strong>{connectionName}</strong>
              </div>
            </div>
          )}
          <div className="inspector-context-row">
            <DatabaseSvgIcon />
            <div className="inspector-context-text">
              <span className="inspector-context-label">Database</span>
              <strong>{database || (
                <span className="inspector-muted">Not selected</span>
              )}</strong>
            </div>
          </div>
          <div className="inspector-context-row">
            <SchemaSvgIcon />
            <div className="inspector-context-text">
              <span className="inspector-context-label">Schema</span>
              <strong>{schema || (
                <span className="inspector-muted">Not selected</span>
              )}</strong>
            </div>
          </div>
          {selectedObject && (
            <div className="inspector-context-row">
              <span className="inspector-context-icon">
                {selectedObject.objectType === 'VIEW' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18" />
                    <path d="M9 3v18" />
                  </svg>
                )}
              </span>
              <div className="inspector-context-text">
                <span className="inspector-context-label">Object</span>
                <strong>{selectedObject.label}</strong>
                <span className="inspector-col-badge" data-kind={selectedObject.objectType?.toUpperCase() === 'VIEW' ? 'view' : 'table'}>
                  {selectedObject.objectType || 'TABLE'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Columns section ── */}
      <div className="inspector-section">
        <div className="inspector-section-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="2" x2="12" y2="22" />
            <path d="M2 12h20" opacity=".3" />
          </svg>
          Columns
          <span className="inspector-count-badge">{columns.length}</span>
          {pkCount > 0 && (
            <span className="inspector-pk-badge">{pkCount} PK</span>
          )}
        </div>

        {columns.length === 0 ? (
          <div className="inspector-empty">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 6 }}>
              <line x1="12" y1="2" x2="12" y2="22" />
              <path d="M2 12h20" opacity=".4" />
            </svg>
            <p className="inspector-muted">Select a table to inspect its columns.</p>
          </div>
        ) : (
          <div className="inspector-columns-list">
            {sorted.map(column => (
              <button
                className="inspector-column-row"
                key={column.name}
                onClick={() => onInsertColumn(column)}
                title={`Insert ${column.name} into editor`}
              >
                <span className="inspector-col-icon">
                  <ColumnSvgIcon isPk={column.isPk} />
                </span>
                <div className="inspector-col-info">
                  <div className="inspector-col-name-row">
                    <strong className="inspector-col-name">{column.name}</strong>
                    {column.isPk && <span className="inspector-col-pk-badge" title="Primary key">PK</span>}
                    {column.isFk && <span className="inspector-col-fk-badge" title="Foreign key">FK</span>}
                  </div>
                  {column.description && (
                    <span className="inspector-col-desc">{column.description}</span>
                  )}
                </div>
                {column.type && (
                  <span className={`inspector-col-type inspector-col-type--${typeClass(column.type)}`}>
                    {column.type}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
