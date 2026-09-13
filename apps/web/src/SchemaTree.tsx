import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, DragEvent } from 'react';
import type { DatabaseKind, SchemaSearchResult, SchemaTreeNode } from '@justybase/contracts';
import { buildExplainQuery, buildTopRowsQuery, formatQueryObjectName, formatQuerySchemaName, quoteIdentifierForQuery } from '@justybase/dialect-utils';
import { useApiClient } from './api';
import { readLegacyWorkspaceValue, useWorkspaceStorage } from './workspacePersistence';

const ROOT = '__root__';

// ── Qualified name helpers ─────────────────────────────

/** One dialect-aware qualification rule used by copy, insert and drag/drop. */
export function qualifySchemaNode(node: SchemaTreeNode, databaseKind: DatabaseKind = 'netezza'): string {
  if (node.kind === 'database') return quoteIdentifierForQuery(node.database || node.label, databaseKind);
  if (node.kind === 'schema') {
    return formatQuerySchemaName(node.database, node.schema || node.label, databaseKind);
  }
  if (node.kind === 'object' || node.kind === 'column') {
    const objectName = formatQueryObjectName({ database: node.database, schema: node.schema, objectName: node.objectName || node.label }, databaseKind);
    return node.kind === 'column' ? `${objectName}.${quoteIdentifierForQuery(node.label, databaseKind)}` : objectName;
  }
  return quoteIdentifierForQuery(node.label, databaseKind);
}

export const buildExplainSql = buildExplainQuery;

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

function ConnectionIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 16V8l8 8V8" />
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
    case 'connection': return <ConnectionIcon />;
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

/** Compact column indicators used by the desktop schema tree. */
function typeIndicator(type: string): string {
  const normalized = type.toUpperCase();
  if (/^(DATE|TIME|TIMESTAMP|DATETIME|INTERVAL)/.test(normalized)) return '📅';
  if (/^(INT|BIGINT|SMALLINT|TINYINT|BYTEINT|INTEGER|SERIAL|DEC|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)/.test(normalized)) return '123';
  if (/^(BOOL|BOOLEAN)/.test(normalized)) return 'bool';
  if (/^(VARCHAR|CHAR|TEXT|CLOB|NCHAR|NVARCHAR)/.test(normalized)) return 'txt';
  return type;
}

// ── Column metadata tracked separately from SchemaTreeNode ──

interface ColumnMeta {
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

// ── Node type filter constants ─────────────────────────

const OBJECT_TYPES = [
  // These are also the labels used by the VS Code schema tree. Keep them
  // singular and uppercase; "TABLEs"/"Tables" is a web-only artefact.
  { key: 'TABLE', label: 'TABLE' },
  { key: 'VIEW', label: 'VIEW' },
  { key: 'PROCEDURE', label: 'PROCEDURE' },
  { key: 'SYNONYM', label: 'SYNONYM' },
] as const;

// ── Main SchemaTree component ───────────────────────────

export function SchemaTree({ connectionId, database, databaseKind = 'netezza', onInsert, onContextChange, onObjectSelect, onOpenDesigner, onOpenQuery, onImport }: {
  connectionId: string;
  database?: string;
  databaseKind?: DatabaseKind;
  onInsert(value: string): void;
  onContextChange(database?: string, schema?: string): void;
  onObjectSelect?(node: SchemaTreeNode): void;
  onOpenDesigner?(node: SchemaTreeNode): void;
  onOpenQuery?(sql: string, title: string, node: SchemaTreeNode): void;
  onImport?(node: SchemaTreeNode): void;
}): ReactElement {
  const api = useApiClient();
  const storage = useWorkspaceStorage();
  const [children, setChildren] = useState<Record<string, SchemaTreeNode[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchItems, setSearchItems] = useState<SchemaSearchResult[]>([]);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(OBJECT_TYPES.map(t => t.key)));
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [objectMenu, setObjectMenu] = useState<{ x: number; y: number; node: SchemaTreeNode } | null>(null);
  const [favorites, setFavorites] = useState<SchemaTreeNode[]>([]);
  const [recentObjects, setRecentObjects] = useState<SchemaTreeNode[]>([]);
  const [storageReadyKey, setStorageReadyKey] = useState<string | null>(null);
  // Separate store for column metadata not present on SchemaTreeNode
  const [columnMeta, setColumnMeta] = useState<Record<string, ColumnMeta>>({});
  const connectionNode: SchemaTreeNode = {
    id: `connection:${connectionId}`,
    kind: 'connection',
    label: databaseKind === 'netezza' ? 'NZ' : connectionId,
    description: `${databaseKind} connection`,
    hasChildren: true,
  };

  useEffect(() => {
    const closeMenu = (): void => setObjectMenu(null);
    const handleKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setObjectMenu(null); };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('click', closeMenu); document.removeEventListener('keydown', handleKeyDown); };
  }, []);

  const storageKey = `schema_${connectionId}`;
  useEffect(() => {
    setStorageReadyKey(null);
    try {
      const stored = JSON.parse(storage.get(storageKey) ?? readLegacyWorkspaceValue(`jwb_schema_${connectionId}`) ?? '{}') as { favorites?: SchemaTreeNode[]; recent?: SchemaTreeNode[] };
      setFavorites(Array.isArray(stored.favorites) ? stored.favorites.filter(node => node?.kind === 'object') : []);
      setRecentObjects(Array.isArray(stored.recent) ? stored.recent.filter(node => node?.kind === 'object') : []);
    } catch {
      setFavorites([]);
      setRecentObjects([]);
    }
    setStorageReadyKey(storageKey);
  }, [storageKey]);
  useEffect(() => {
    if (storageReadyKey !== storageKey) return;
    storage.set(storageKey, JSON.stringify({ favorites, recent: recentObjects }));
  }, [favorites, recentObjects, storage, storageKey, storageReadyKey]);

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
    setExpanded({ [ROOT]: true, [connectionNode.id]: true });
    setColumnMeta({});
    setError('');
    void loadFn(ROOT);
  }, [loadFn]);

  // Keep the whole database catalog visible, like the VS Code explorer. Only
  // the active document database is opened automatically; the database
  // selector in the query toolbar is an authoring context, not a schema-tree
  // filter. Each level remains lazy, so this does not materialise the catalog.
  const rootNodes = children[ROOT];
  const databaseNode = rootNodes?.find(node => node.kind === 'database' && node.database?.toLocaleLowerCase() === ((database ?? '').trim() || 'just_data').toLocaleLowerCase());
  const databaseNodes = databaseNode ? children[databaseNode.id] : undefined;
  const schemaNode = databaseNodes?.find(node => node.kind === 'schema' && node.schema?.toLocaleLowerCase() === 'admin') ?? databaseNodes?.find(node => node.kind === 'schema');
  const objectGroupNodes = schemaNode ? children[schemaNode.id] : databaseNodes;
  const tableGroupNode = objectGroupNodes?.find(node => node.kind === 'group' && node.objectType?.toLocaleUpperCase() === 'TABLE');

  useEffect(() => {
    if (!databaseNode) return;
    setExpanded(previous => previous[connectionNode.id] && previous[databaseNode.id]
      ? previous
      : ({ ...previous, [connectionNode.id]: true, [databaseNode.id]: true }));
    if (!children[databaseNode.id] && !loading[databaseNode.id]) void loadFn(databaseNode.id);
  }, [connectionNode.id, databaseNode, children, loading, loadFn]);

  useEffect(() => {
    if (!schemaNode) return;
    setExpanded(previous => previous[schemaNode.id] ? previous : ({ ...previous, [schemaNode.id]: true }));
    if (!children[schemaNode.id] && !loading[schemaNode.id]) void loadFn(schemaNode.id);
  }, [children, loading, loadFn, schemaNode]);

  useEffect(() => {
    if (!tableGroupNode) return;
    setExpanded(previous => previous[tableGroupNode.id] ? previous : ({ ...previous, [tableGroupNode.id]: true }));
    if (!children[tableGroupNode.id] && !loading[tableGroupNode.id]) void loadFn(tableGroupNode.id);
  }, [children, loading, loadFn, tableGroupNode]);

  // Debounced search
  useEffect(() => {
    const term = search.trim();
    if (!term) { setSearchItems([]); return; }
    const timer = window.setTimeout(() => {
      void api.searchSchema({
        connectionId,
        // Schema search is intentionally connection-wide. The database
        // dropdown belongs to the active SQL document and must not hide other
        // databases from the explorer.
        searchAllDatabases: true,
        term,
        objectTypes: Array.from(activeFilters),
      }).then(response => setSearchItems(response.items)).catch(reason =>
        setError(reason instanceof Error ? reason.message : 'Schema search failed.')
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [connectionId, search, activeFilters]);

  // Refresh
  function refresh(): void {
    setChildren({});
    setExpanded({ [ROOT]: true, [connectionNode.id]: true });
    setColumnMeta({});
    void loadFn(ROOT);
  }

  // Expand all — recursively loads and expands databases and schemas (2 levels deep)
  async function expandAll(): Promise<void> {
    // 1. Ensure root is loaded
    if (!children[ROOT] && !loading[ROOT]) {
      await loadFn(ROOT);
    }

    const newExpanded: Record<string, boolean> = { [ROOT]: true, [connectionNode.id]: true };

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
    setExpanded({ [ROOT]: true, [connectionNode.id]: true });
  }

  // Load columns for an object node
  async function loadColumns(node: SchemaTreeNode): Promise<SchemaTreeNode[]> {
    if (!node.database || !node.schema || !node.objectName) return [];
    setLoading(prev => ({ ...prev, [node.id]: true }));
    setError('');
    try {
      const cols = await api.columns(connectionId, node.database, node.schema, node.objectName);
      const colNodes: SchemaTreeNode[] = cols.map((col, columnIndex) => ({
        id: `col:${node.database}.${node.schema}.${node.objectName}.${columnIndex}`,
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
      for (const [columnIndex, col] of cols.entries()) {
        const colId = `col:${node.database}.${node.schema}.${node.objectName}.${columnIndex}`;
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
    if (node.kind === 'connection') {
      const isExpanded = expanded[node.id] === true;
      setExpanded(previous => ({ ...previous, [node.id]: !isExpanded }));
      return;
    }
    if (node.kind === 'database') {
      onContextChange(node.database, undefined);
    }
    if (node.kind === 'schema') {
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
      setRecentObjects(previous => [node, ...previous.filter(item => item.id !== node.id)].slice(0, 8));
      onObjectSelect?.(node);
      onInsert(qualifySchemaNode(node, databaseKind));
    }
    if (node.kind === 'column') {
      onInsert(node.label);
    }
  }

  function insertSearchResult(item: SchemaSearchResult): void {
    onInsert(qualifySchemaNode({ id: `search:${item.database}.${item.schema}.${item.name}`, kind: 'object', label: item.name, database: item.database, schema: item.schema, objectName: item.name, hasChildren: false }, databaseKind));
  }

  function selectNode(node: SchemaTreeNode): void {
    if (node.kind === 'database') {
      onContextChange(node.database, undefined);
    } else if (node.kind === 'schema') {
      onContextChange(node.database, node.schema);
    } else if (node.kind === 'object') {
      onContextChange(node.database, node.schema);
      onObjectSelect?.(node);
    }
  }

  function objectSqlName(node: SchemaTreeNode): string { return qualifySchemaNode(node, databaseKind); }

  function toggleFavorite(node: SchemaTreeNode): void {
    setFavorites(previous => previous.some(item => item.id === node.id) ? previous.filter(item => item.id !== node.id) : [...previous, node].slice(-20));
    setObjectMenu(null);
  }

  function openObjectMenu(event: React.MouseEvent<HTMLElement>, node: SchemaTreeNode): void {
    event.preventDefault();
    event.stopPropagation();
    selectNode(node);
    setObjectMenu({ x: event.clientX, y: event.clientY, node });
  }

  function openKeyboardMenu(event: React.KeyboardEvent<HTMLElement>, node: SchemaTreeNode): void {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(node);
    const bounds = event.currentTarget.getBoundingClientRect();
    setObjectMenu({ x: bounds.left + 8, y: bounds.bottom + 2, node });
  }

  async function refreshNode(node: SchemaTreeNode): Promise<void> {
    if (node.kind === 'connection') {
      refresh();
      setObjectMenu(null);
      return;
    }
    setChildren(previous => {
      const next = { ...previous };
      delete next[node.id];
      return next;
    });
    await loadFn(node.id);
    setExpanded(previous => ({ ...previous, [node.id]: true }));
    setObjectMenu(null);
  }

  async function copyNodeName(node: SchemaTreeNode): Promise<void> {
    try {
      await navigator.clipboard.writeText(objectSqlName(node));
      setError(`Copied ${objectSqlName(node)}.`);
    } catch {
      setError('Could not copy the qualified name.');
    } finally {
      setObjectMenu(null);
    }
  }

  function insertQualifiedNode(node: SchemaTreeNode): void {
    onInsert(objectSqlName(node));
    setObjectMenu(null);
  }

  function openObjectData(node: SchemaTreeNode): void {
    onOpenQuery?.(buildTopRowsQuery({ database: node.database, schema: node.schema, objectName: node.objectName || node.label }, databaseKind), `Top 1000 · ${node.label}`, node);
    setObjectMenu(null);
  }

  function openDesigner(node: SchemaTreeNode): void {
    onOpenDesigner?.(node);
    setObjectMenu(null);
  }

  function explainObject(node: SchemaTreeNode): void {
    try {
      onOpenQuery?.(buildExplainQuery(buildTopRowsQuery({ database: node.database, schema: node.schema, objectName: node.objectName || node.label }, databaseKind), databaseKind), `Explain · ${node.label}`, node);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Explain plans are not available for this connection.');
    }
    setObjectMenu(null);
  }

  async function copyObjectDdl(node: SchemaTreeNode): Promise<void> {
    try {
      const objectType = node.objectType?.trim().toUpperCase() || 'TABLE';
      const result = await api.ddl({
        connectionId,
        database: node.database ?? database ?? '',
        schema: node.schema ?? '',
        objectName: node.objectName ?? node.label,
        objectType,
      });
      if (!result.success || !result.ddlCode) throw new Error(result.error ?? 'The database returned no DDL.');
      const ddl = result.ddlCode;
      await navigator.clipboard.writeText(ddl);
      setError(result.ddlFidelity === 'reconstructed'
        ? 'Reconstructed DDL copied to clipboard; inspect the metadata warnings before executing it.'
        : 'DDL copied to clipboard.');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not generate DDL.');
    } finally {
      setObjectMenu(null);
    }
  }

  // Drag & Drop handlers
  function handleDragStart(event: DragEvent<HTMLDivElement>, node: SchemaTreeNode): void {
    // Columns drag just their own name; objects drag the qualified name
    const name = node.kind === 'column'
      ? node.label
      : qualifySchemaNode(node, databaseKind);
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

      {(favorites.length > 0 || recentObjects.length > 0) && <div className="schema-shortcuts">
        {favorites.length > 0 && <div><div className="schema-shortcuts-title">Favorites</div>{favorites.map(node => <button key={node.id} className="schema-shortcut" onClick={() => insertNode(node)} onContextMenu={event => openObjectMenu(event, node)}><span>★</span>{node.label}<small>{node.schema}</small></button>)}</div>}
        {recentObjects.length > 0 && <div><div className="schema-shortcuts-title">Recent</div>{recentObjects.slice(0, 5).map(node => <button key={node.id} className="schema-shortcut" onClick={() => insertNode(node)} onContextMenu={event => openObjectMenu(event, node)}><span>↻</span>{node.label}<small>{node.schema}</small></button>)}</div>}
      </div>}

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
            <TreeNode
              node={connectionNode}
              depth={0}
              childrenMap={{
                ...children,
                [connectionNode.id]: rootNodes ?? [],
                ...(databaseNode && objectGroupNodes ? { [databaseNode.id]: objectGroupNodes } : {}),
              }}
              expanded={expanded}
              loading={{ ...loading, [connectionNode.id]: loading[ROOT] ?? false }}
              dragOverId={dragOverId}
              columnMeta={columnMeta}
              onToggle={toggle}
              onSelect={selectNode}
              onInsert={insertNode}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onContextMenu={openObjectMenu}
              onKeyboardMenu={openKeyboardMenu}
              databaseKind={databaseKind}
            />
          )}
        </div>
      )}
      {objectMenu && <div className="schema-context-menu" role="menu" aria-label={`Actions for ${objectMenu.node.label}`} style={{ left: objectMenu.x, top: objectMenu.y }} onClick={event => event.stopPropagation()}>
        <strong>{objectMenu.node.label}</strong>
        <small>{objectMenu.node.kind === 'object' ? objectMenu.node.objectType ?? 'Object' : objectMenu.node.kind}</small>
        {(objectMenu.node.kind === 'database' || objectMenu.node.kind === 'schema') && <button type="button" role="menuitem" onClick={() => { selectNode(objectMenu.node); setObjectMenu(null); }}>Set as active context</button>}
        {objectMenu.node.hasChildren && <button type="button" role="menuitem" onClick={() => void refreshNode(objectMenu.node)}>Refresh children</button>}
        {(objectMenu.node.kind === 'database' || objectMenu.node.kind === 'schema' || objectMenu.node.kind === 'object' || objectMenu.node.kind === 'column') && <button type="button" role="menuitem" onClick={() => insertQualifiedNode(objectMenu.node)}>Insert qualified name</button>}
        {(objectMenu.node.kind === 'database' || objectMenu.node.kind === 'schema' || objectMenu.node.kind === 'column') && <button type="button" role="menuitem" onClick={() => void copyNodeName(objectMenu.node)}>Copy qualified name</button>}
        {objectMenu.node.kind === 'column' && <button type="button" role="menuitem" onClick={() => { onInsert(objectMenu.node.label); setObjectMenu(null); }}>Insert column name</button>}
        {objectMenu.node.kind === 'object' && <>
          <button type="button" role="menuitem" onClick={() => openDesigner(objectMenu.node)}>Open Object Designer</button>
          <button type="button" role="menuitem" onClick={() => openObjectData(objectMenu.node)}>View top 1000</button>
          <button type="button" role="menuitem" onClick={() => explainObject(objectMenu.node)}>Explain plan</button>
          <button type="button" role="menuitem" onClick={() => void copyObjectDdl(objectMenu.node)}>Copy DDL</button>
          <button type="button" role="menuitem" onClick={() => { onImport?.(objectMenu.node); setObjectMenu(null); }}>Import CSV/XLSX</button>
          <button type="button" role="menuitem" onClick={() => toggleFavorite(objectMenu.node)}>{favorites.some(item => item.id === objectMenu.node.id) ? 'Remove from favorites' : 'Add to favorites'}</button>
        </>}
      </div>}
    </div>
  );
}

// ── TreeNode recursive component ───────────────────────

function TreeNode({ node, depth, childrenMap, expanded, loading, dragOverId, columnMeta, onToggle, onSelect, onInsert, onDragStart, onDragOver, onDragLeave, onDrop, onContextMenu, onKeyboardMenu, databaseKind }: {
  node: SchemaTreeNode;
  depth: number;
  childrenMap: Record<string, SchemaTreeNode[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  dragOverId: string | null;
  columnMeta: Record<string, ColumnMeta>;
  onToggle(node: SchemaTreeNode): Promise<void>;
  onSelect(node: SchemaTreeNode): void;
  onInsert(node: SchemaTreeNode): void;
  onDragStart(event: DragEvent<HTMLDivElement>, node: SchemaTreeNode): void;
  onDragOver(event: DragEvent<HTMLDivElement>, nodeId: string): void;
  onDragLeave(): void;
  onDrop(event: DragEvent<HTMLDivElement>, node: SchemaTreeNode): void;
  onContextMenu(event: React.MouseEvent<HTMLElement>, node: SchemaTreeNode): void;
  onKeyboardMenu(event: React.KeyboardEvent<HTMLElement>, node: SchemaTreeNode): void;
  databaseKind: DatabaseKind;
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
      await navigator.clipboard.writeText(qualifySchemaNode(node, databaseKind));
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
        onContextMenu={e => onContextMenu(e, node)}
        onKeyDown={e => onKeyboardMenu(e, node)}
        tabIndex={0}
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
          onClick={() => { onSelect(node); if (node.kind === 'object' || node.hasChildren) void onToggle(node); }}
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
                <span className={`schema-col-type schema-col-type--${typeClass(node.columnType)}`} title={node.columnType}>
                  {typeIndicator(node.columnType)}
                </span>
              )}
            </>
          ) : (
            <>
              {node.kind === 'object' && node.schema && <small className="schema-object-schema">({node.schema})</small>}
              {node.columnType && <small className="schema-label-type" title={node.columnType}>{typeIndicator(node.columnType)}</small>}
            </>
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
            onSelect={onSelect}
            onInsert={onInsert}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
                onDrop={onDrop}
            onContextMenu={onContextMenu}
            onKeyboardMenu={onKeyboardMenu}
            databaseKind={databaseKind}
              />
        ))}
      </div>
    </div>
  );
}
