import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, DragEvent } from 'react';
import type { SchemaSearchResult, SchemaTreeNode } from '@justybase/contracts';
import { api } from './api';

const ROOT = '__root__';

// ── Qualified name helpers ─────────────────────────────

/** Build a dot-separated qualified name for any tree node. */
function qualifiedName(node: SchemaTreeNode): string {
  switch (node.kind) {
    case 'database':
      return node.database || node.label;
    case 'schema':
      return [node.database, node.schema || node.label].filter(Boolean).join('.');
    case 'object':
      return [node.database, node.schema, node.objectName || node.label].filter(Boolean).join('.');
    case 'column':
      return `${node.objectName || ''}.${node.label}`;
    default:
      return node.label;
  }
}

// ── SVG Icons ──────────────────────────────────────────

function DatabaseIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function SchemaIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M3 9h18" />
    </svg>
  );
}

function TableIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 3v18" />
    </svg>
  );
}

function ViewIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ProcedureIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f472b6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  );
}

function ColumnIcon({ isPk }: { isPk?: boolean }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isPk ? '#fbbf24' : '#94a3b8'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M2 12h20" opacity=".3" />
    </svg>
  );
}

function FolderIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 3h9a2 2 0 012 2v7a2 2 0 01-2 2H5z" />
    </svg>
  );
}

function SearchIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function ExpandIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function CollapseIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function CopyIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#86efac" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SpinnerIcon(): ReactElement {
  return (
    <svg className="schema-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
    </svg>
  );
}

// ── Icon selector ──────────────────────────────────────

function nodeIcon(node: SchemaTreeNode, isPk?: boolean): ReactElement {
  switch (node.kind) {
    case 'database': return <DatabaseIcon />;
    case 'schema': return <SchemaIcon />;
    case 'group': return <FolderIcon />;
    case 'column': return <ColumnIcon isPk={isPk} />;
    case 'object':
      switch (node.objectType?.toUpperCase()) {
        case 'VIEW': return <ViewIcon />;
        case 'PROCEDURE': return <ProcedureIcon />;
        case 'SYNONYM': return <FolderIcon />;
        default: return <TableIcon />;
      }
    default: return <TableIcon />;
  }
}

// ── Type badge CSS class ──────────────────────────────

/** Maps a SQL data type to a CSS class for color-coded badges. */
export function typeClass(type: string): string {
  const t = type.toUpperCase();
  if (/^(INT|BIGINT|SMALLINT|TINYINT|BYTEINT|INTEGER|SERIAL)/.test(t)) return 'int';
  if (/^(VARCHAR|CHAR|TEXT|CLOB|NCHAR|NVARCHAR)/.test(t)) return 'str';
  if (/^(DEC|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)/.test(t)) return 'num';
  if (/^(DATE|TIME|TIMESTAMP|DATETIME)/.test(t)) return 'date';
  if (/^(BOOL|BOOLEAN)/.test(t)) return 'bool';
  return 'other';
}

// ── Column metadata tracked separately from SchemaTreeNode ──

interface ColumnMeta {
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

// ── Node type filter constants ─────────────────────────

const OBJECT_TYPES = [
  { key: 'TABLE', label: 'Tables' },
  { key: 'VIEW', label: 'Views' },
  { key: 'PROCEDURE', label: 'Procedures' },
  { key: 'SYNONYM', label: 'Synonyms' },
] as const;

// ── Main SchemaTree component ───────────────────────────

export function SchemaTree({ connectionId, database, onInsert, onContextChange, onObjectSelect }: {
  connectionId: string;
  database?: string;
  onInsert(value: string): void;
  onContextChange(database?: string, schema?: string): void;
  onObjectSelect?(node: SchemaTreeNode): void;
}): ReactElement {
  const [children, setChildren] = useState<Record<string, SchemaTreeNode[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchItems, setSearchItems] = useState<SchemaSearchResult[]>([]);
  const [activeDatabase, setActiveDatabase] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(OBJECT_TYPES.map(t => t.key)));
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Separate store for column metadata not present on SchemaTreeNode
  const [columnMeta, setColumnMeta] = useState<Record<string, ColumnMeta>>({});

  const loadFn = useCallback(async (parentId: string): Promise<SchemaTreeNode[]> => {
    setLoading(prev => ({ ...prev, [parentId]: true }));
    setError('');
    try {
      const response = await api.schemaTree(connectionId, parentId === ROOT ? undefined : parentId);
      setChildren(prev => ({ ...prev, [parentId]: response.nodes }));
      return response.nodes;
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not load schema tree.');
      return [];
    } finally {
      setLoading(prev => ({ ...prev, [parentId]: false }));
    }
  }, [connectionId]);

  // Load root on connection change
  useEffect(() => {
    setChildren({});
    setExpanded({ [ROOT]: true });
    setColumnMeta({});
    setActiveDatabase('');
    setError('');
    void loadFn(ROOT);
  }, [loadFn]);

  // Debounced search
  useEffect(() => {
    const term = search.trim();
    if (!term) { setSearchItems([]); return; }
    const timer = window.setTimeout(() => {
      void api.searchSchema({
        connectionId,
        database: database || activeDatabase || undefined,
        term,
        objectTypes: Array.from(activeFilters),
      }).then(response => setSearchItems(response.items)).catch(reason =>
        setError(reason instanceof Error ? reason.message : 'Schema search failed.')
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [connectionId, database, activeDatabase, search, activeFilters]);

  // Refresh
  function refresh(): void {
    setChildren({});
    setExpanded({ [ROOT]: true });
    setColumnMeta({});
    void loadFn(ROOT);
  }

  // Expand all — recursively loads and expands databases and schemas (2 levels deep)
  async function expandAll(): Promise<void> {
    // 1. Ensure root is loaded
    if (!children[ROOT] && !loading[ROOT]) {
      await loadFn(ROOT);
    }

    const newExpanded: Record<string, boolean> = { [ROOT]: true };

    // 2. Expand level 1 (databases / first-level nodes) + load their children
    const level1 = children[ROOT] ?? await loadFn(ROOT);
    for (const n1 of level1) {
      newExpanded[n1.id] = true;
      let level2 = children[n1.id];
      if (!children[n1.id] && n1.hasChildren && !loading[n1.id]) {
        if (n1.kind === 'object' && n1.objectName) {
          level2 = await loadColumns(n1);
        } else {
          level2 = await loadFn(n1.id);
        }
      }

      // 3. Expand level 2 (schemas / second-level nodes) + load their children
      for (const n2 of level2 ?? []) {
        newExpanded[n2.id] = true;
        if (!children[n2.id] && n2.hasChildren && !loading[n2.id]) {
          if (n2.kind === 'object' && n2.objectName) {
            await loadColumns(n2);
          } else {
            await loadFn(n2.id);
          }
        }
      }
    }

    setExpanded(prev => ({ ...prev, ...newExpanded }));
  }

  function collapseAll(): void {
    setExpanded({ [ROOT]: true });
  }

  // Load columns for an object node
  async function loadColumns(node: SchemaTreeNode): Promise<SchemaTreeNode[]> {
    if (!node.database || !node.schema || !node.objectName) return [];
    setLoading(prev => ({ ...prev, [node.id]: true }));
    setError('');
    try {
      const cols = await api.columns(connectionId, node.database, node.schema, node.objectName);
      const colNodes: SchemaTreeNode[] = cols.map(col => ({
        id: `col:${node.database}.${node.schema}.${node.objectName}.${col.name}`,
        parentId: node.id,
        kind: 'column' as const,
        label: col.name,
        columnType: col.type,
        description: col.description,
        database: node.database,
        schema: node.schema,
        objectName: node.objectName,
        hasChildren: false,
      }));
      // Store PK/FK metadata separately
      const metaEntries: Record<string, ColumnMeta> = {};
      for (const col of cols) {
        const colId = `col:${node.database}.${node.schema}.${node.objectName}.${col.name}`;
        if (col.isPk || col.isFk) {
          metaEntries[colId] = { isPrimaryKey: col.isPk, isForeignKey: col.isFk };
        }
      }
      setColumnMeta(prev => ({ ...prev, ...metaEntries }));
      setChildren(prev => ({ ...prev, [node.id]: colNodes }));
      return colNodes;
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not load columns.');
      return [];
    } finally {
      setLoading(prev => ({ ...prev, [node.id]: false }));
    }
  }

  // Toggle expand/collapse
  async function toggle(node: SchemaTreeNode): Promise<void> {
    if (node.kind === 'database') {
      setActiveDatabase(node.database ?? '');
      onContextChange(node.database, undefined);
    }
    if (node.kind === 'schema') {
      setActiveDatabase(node.database ?? '');
      onContextChange(node.database, node.schema);
    }
    const isExpanded = expanded[node.id] === true;
    setExpanded(prev => ({ ...prev, [node.id]: !isExpanded }));
    if (!isExpanded && !children[node.id]) {
      if (node.kind === 'object' && node.objectName) {
        await loadColumns(node);
      } else if (node.hasChildren) {
        await loadFn(node.id);
      }
    }
  }

  // Insert object name into editor
  function insertNode(node: SchemaTreeNode): void {
    if (node.database || node.schema) onContextChange(node.database, node.schema);
    if (node.kind === 'object' && node.objectName) {
      onObjectSelect?.(node);
      onInsert([node.database, node.schema, node.objectName].filter(Boolean).join('.'));
    }
    if (node.kind === 'column') {
      onInsert(node.label);
    }
  }

  function insertSearchResult(item: SchemaSearchResult): void {
    onInsert([item.database, item.schema, item.name].filter(Boolean).join('.'));
  }

  // Drag & Drop handlers
  function handleDragStart(event: DragEvent<HTMLDivElement>, node: SchemaTreeNode): void {
    // Columns drag just their own name; objects drag the qualified name
    const name = node.kind === 'column'
      ? node.label
      : [node.database, node.schema, node.objectName || node.label].filter(Boolean).join('.');
    event.dataTransfer.setData('text/plain', name);
    event.dataTransfer.effectAllowed = 'copy';
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, nodeId: string): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragOverId(nodeId);
  }

  function handleDragLeave(): void {
    setDragOverId(null);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, node: SchemaTreeNode): void {
    event.preventDefault();
    setDragOverId(null);
    insertNode(node);
  }

  // Filter toggle
  function toggleFilter(type: string): void {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <div className="schema-explorer">
      {/* Search bar */}
      <div className="schema-search">
        <span className="schema-search-icon"><SearchIcon /></span>
        <input
          placeholder="Search tables, views…"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <button className="schema-refresh-btn" title="Collapse all" onClick={collapseAll}>
          <CollapseIcon />
        </button>
        <button className="schema-refresh-btn" title="Expand all (databases and schemas)" onClick={() => void expandAll()}>
          <ExpandIcon />
        </button>
        <button className="schema-refresh-btn" title="Refresh schema" onClick={refresh}>
          <RefreshIcon />
        </button>
      </div>

      {/* Object type filters */}
      <div className="schema-filters">
        {OBJECT_TYPES.map(ot => (
          <button
            key={ot.key}
            className={`schema-filter-chip ${activeFilters.has(ot.key) ? 'active' : ''}`}
            onClick={() => toggleFilter(ot.key)}
          >
            {ot.label}
          </button>
        ))}
      </div>

      {error && <div className="error schema-error">{error}</div>}

      {/* Search results or tree */}
      {search.trim() ? (
        <div className="schema-search-results">
          {searchItems.length === 0
            ? <p className="muted">No matching objects.</p>
            : searchItems.map(item => (
                <button
                  className="schema-search-result"
                  key={`${item.database}.${item.schema}.${item.name}`}
                  onClick={() => insertSearchResult(item)}
                >
                  <span className="schema-search-result-icon">
                    {item.objectType === 'VIEW' ? <ViewIcon /> :
                     item.objectType === 'PROCEDURE' ? <ProcedureIcon /> : <TableIcon />}
                  </span>
                  <div className="schema-search-result-text">
                    <strong>{item.name}</strong>
                    <span>{item.database}.{item.schema} · {item.objectType}</span>
                  </div>
                </button>
              ))}
        </div>
      ) : (
        <div className="schema-tree">
          {loading[ROOT] ? (
            <div className="schema-tree-loading">
              <SpinnerIcon />
              <span>Loading schema…</span>
            </div>
          ) : (
            (children[ROOT] ?? []).map(nodeItem => (
              <TreeNode
                key={nodeItem.id}
                node={nodeItem}
                depth={0}
                childrenMap={children}
                expanded={expanded}
                loading={loading}
                dragOverId={dragOverId}
                columnMeta={columnMeta}
                onToggle={toggle}
                onInsert={insertNode}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── TreeNode recursive component ───────────────────────

function TreeNode({ node, depth, childrenMap, expanded, loading, dragOverId, columnMeta, onToggle, onInsert, onDragStart, onDragOver, onDragLeave, onDrop }: {
  node: SchemaTreeNode;
  depth: number;
  childrenMap: Record<string, SchemaTreeNode[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  dragOverId: string | null;
  columnMeta: Record<string, ColumnMeta>;
  onToggle(node: SchemaTreeNode): Promise<void>;
  onInsert(node: SchemaTreeNode): void;
  onDragStart(event: DragEvent<HTMLDivElement>, node: SchemaTreeNode): void;
  onDragOver(event: DragEvent<HTMLDivElement>, nodeId: string): void;
  onDragLeave(): void;
  onDrop(event: DragEvent<HTMLDivElement>, node: SchemaTreeNode): void;
}): ReactElement {
  const [showCopied, setShowCopied] = useState(false);
  const open = expanded[node.id] === true;
  const isLoading = loading[node.id] === true;
  const isDragOver = dragOverId === node.id;
  const isObject = node.kind === 'object' || node.kind === 'column';
  const meta = columnMeta[node.id];

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(qualifiedName(node));
      setShowCopied(true);
      window.setTimeout(() => setShowCopied(false), 1200);
    } catch {
      // Clipboard API not available
    }
  }

  const classNames = [
    'schema-node-row',
    isDragOver ? 'drag-over' : '',
    isObject ? 'schema-object-row' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="schema-node">
      <div
        className={classNames}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        draggable={isObject}
        onDragStart={isObject ? (e => onDragStart(e, node)) : undefined}
        onDragOver={e => onDragOver(e, node.id)}
        onDragLeave={onDragLeave}
        onDrop={e => onDrop(e, node)}
      >
        {/* Expander */}
        <button
          className="schema-expander"
          disabled={node.kind !== 'object' && !node.hasChildren}
          onClick={() => void onToggle(node)}
        >
          {node.kind === 'object' || node.hasChildren ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`chevron ${open ? 'open' : ''}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          ) : (
            <span className="schema-expander-spacer" />
          )}
        </button>

        {/* Label */}
        <button
          className="schema-label"
          title={isObject ? `Insert: ${node.label}` : node.description || node.label}
          onClick={() => { onInsert(node); if (node.kind === 'object' || node.hasChildren) void onToggle(node); }}
        >
          <span className="schema-label-icon">{nodeIcon(node, meta?.isPrimaryKey)}</span>
          <span className="schema-label-text">{node.label}</span>
          {node.kind === 'column' ? (
            <>
              {meta?.isPrimaryKey && (
                <span className="schema-col-pk" title="Primary key">PK</span>
              )}
              {meta?.isForeignKey && (
                <span className="schema-col-fk" title="Foreign key">FK</span>
              )}
              {node.columnType && (
                <span className={`schema-col-type schema-col-type--${typeClass(node.columnType)}`}>
                  {node.columnType}
                </span>
              )}
            </>
          ) : (
            node.columnType && <small className="schema-label-type">{node.columnType}</small>
          )}
        </button>

        {/* Copy name button — visible on hover */}
        <button
          className="schema-copy-btn"
          title="Copy qualified name"
          onClick={event => void handleCopy(event)}
        >
          {showCopied ? <CheckIcon /> : <CopyIcon />}
          {showCopied && <span className="schema-copy-feedback">Copied!</span>}
        </button>

        {/* Loading spinner */}
        {isLoading && <SpinnerIcon />}
      </div>

      {/* Children */}
      <div className={`schema-children ${open ? 'expanded' : ''}`}>
        {open && (childrenMap[node.id] ?? []).map(child => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            childrenMap={childrenMap}
            expanded={expanded}
            loading={loading}
            dragOverId={dragOverId}
            columnMeta={columnMeta}
            onToggle={onToggle}
            onInsert={onInsert}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          />
        ))}
      </div>
    </div>
  );
}
