import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { DatabaseKind, MetadataColumn, SchemaSearchResult, SchemaTreeNode } from '@justybase/contracts';
import { buildExplainQuery, buildTopRowsQuery, formatQueryObjectName, formatQuerySchemaName, quoteIdentifierForQuery } from '@justybase/dialect-utils';

interface SchemaApi {
  schemaTree(connectionId: string, parentId?: string): Promise<{ nodes: SchemaTreeNode[] }>;
  searchSchema(input: { connectionId: string; term: string; database?: string; objectTypes?: string[] }): Promise<{ items: SchemaSearchResult[] }>;
  columns(connectionId: string, database: string, schema: string, table: string): Promise<readonly MetadataColumn[]>;
  ddl(input: { connectionId: string; database: string; schema: string; objectName: string; objectType: string }): Promise<{ success: boolean; ddlCode?: string; error?: string }>;
}

const ROOT = '__root__';
const OBJECT_FILTERS = ['TABLE', 'VIEW', 'PROCEDURE', 'SYNONYM'] as const;

function qualifiedName(node: SchemaTreeNode, databaseKind: DatabaseKind): string {
  if (node.kind === 'column') {
    const object = qualifiedName({ ...node, kind: 'object', label: node.objectName ?? node.label }, databaseKind);
    return `${object}.${quoteIdentifierForQuery(node.label, databaseKind)}`;
  }
  if (node.kind === 'object') {
    return formatQueryObjectName({ database: node.database, schema: node.schema, objectName: node.objectName ?? node.label }, databaseKind);
  }
  if (node.kind === 'schema') return formatQuerySchemaName(node.database, node.schema ?? node.label, databaseKind);
  return quoteIdentifierForQuery(node.label, databaseKind);
}

function nodeGlyph(node: SchemaTreeNode): string {
  if (node.kind === 'database') return '◉';
  if (node.kind === 'schema') return '▦';
  if (node.kind === 'column') return '·';
  if (node.kind === 'group') return '▰';
  if (node.objectType?.toUpperCase() === 'VIEW') return '◌';
  if (node.objectType?.toUpperCase() === 'PROCEDURE') return 'ƒ';
  return '▤';
}

function objectSql(node: SchemaTreeNode, databaseKind: DatabaseKind): string {
  return qualifiedName(node, databaseKind);
}

export interface SchemaExplorerProps {
  readonly api: SchemaApi;
  readonly connectionId?: string;
  readonly database?: string;
  readonly databaseKind: DatabaseKind;
  readonly onInsert: (value: string) => void;
  readonly onObjectSelect?: (node: SchemaTreeNode) => void;
  readonly onOpenQuery?: (sql: string, title: string, node: SchemaTreeNode) => void;
  readonly onOpenDdl?: (sql: string, title: string, node: SchemaTreeNode) => void;
  readonly onImport?: (node: SchemaTreeNode) => void;
}

export function SchemaExplorer({ api, connectionId, database, databaseKind, onInsert, onObjectSelect, onOpenQuery, onOpenDdl, onImport }: SchemaExplorerProps): ReactElement {
  const [children, setChildren] = useState<Record<string, readonly SchemaTreeNode[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [searchItems, setSearchItems] = useState<readonly SchemaSearchResult[]>([]);
  const [activeFilters, setActiveFilters] = useState<ReadonlySet<string>>(new Set(OBJECT_FILTERS));
  const [error, setError] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<{ node: SchemaTreeNode; x: number; y: number } | undefined>(undefined);

  const setLoadingKey = useCallback((key: string, value: boolean): void => {
    setLoading(previous => {
      const next = new Set(previous);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const loadChildren = useCallback(async (parentId: string, node?: SchemaTreeNode): Promise<readonly SchemaTreeNode[]> => {
    if (!connectionId) return [];
    setLoadingKey(parentId, true);
    setError(undefined);
    try {
      let nodes: readonly SchemaTreeNode[];
      if (node?.kind === 'object' && node.database && node.schema && node.objectName) {
        const response = await api.columns(connectionId, node.database, node.schema, node.objectName);
        nodes = (Array.isArray(response) ? response : []).map((column, index) => ({
          id: `${node.id}:column:${index}`,
          parentId: node.id,
          kind: 'column' as const,
          label: column.name,
          description: column.description,
          columnType: column.type,
          database: node.database,
          schema: node.schema,
          objectName: node.objectName,
          hasChildren: false,
        }));
      } else {
        const response = await api.schemaTree(connectionId, parentId === ROOT ? undefined : parentId);
        nodes = Array.isArray(response.nodes) ? response.nodes : [];
      }
      setChildren(previous => ({ ...previous, [parentId]: nodes }));
      return nodes;
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not load schema metadata.');
      return [];
    } finally {
      setLoadingKey(parentId, false);
    }
  }, [api, connectionId, setLoadingKey]);

  useEffect(() => {
    setChildren({});
    setExpanded(new Set([ROOT]));
    setSearchItems([]);
    if (connectionId) void loadChildren(ROOT);
  }, [connectionId, loadChildren]);

  useEffect(() => {
    const term = search.trim();
    if (!term || !connectionId) {
      setSearchItems([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void api.searchSchema({ connectionId, term, database: database || undefined, objectTypes: [...activeFilters] })
        .then(response => setSearchItems(Array.isArray(response.items) ? response.items : []))
        .catch(reason => setError(reason instanceof Error ? reason.message : 'Schema search failed.'));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeFilters, api, connectionId, database, search]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (): void => setMenu(undefined);
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKeyDown); };
  }, [menu]);

  const rootNodes = children[ROOT] ?? [];
  const toggleFilter = (filter: string): void => {
    setActiveFilters(previous => {
      const next = new Set(previous);
      if (next.has(filter)) next.delete(filter); else next.add(filter);
      return next;
    });
  };

  const toggleNode = (node: SchemaTreeNode): void => {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
      return next;
    });
    if (!expanded.has(node.id) && !children[node.id]) void loadChildren(node.id, node);
  };

  const selectNode = (node: SchemaTreeNode): void => {
    onObjectSelect?.(node);
    if (node.kind === 'object' || node.kind === 'column') onInsert(qualifiedName(node, databaseKind));
  };

  const openDdl = async (node: SchemaTreeNode): Promise<void> => {
    setMenu(undefined);
    if (node.kind !== 'object' || !connectionId || !node.database || !node.schema || !node.objectName) return;
    try {
      const objectType = node.objectType?.toUpperCase() || 'TABLE';
      const result = await api.ddl({ connectionId, database: node.database, schema: node.schema, objectName: node.objectName, objectType });
      if (!result.success || !result.ddlCode) throw new Error(result.error ?? 'The database returned no DDL.');
      onOpenDdl?.(result.ddlCode, `DDL · ${node.label}`, node);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not generate DDL.');
    }
  };

  const visibleRootNodes = useMemo(() => rootNodes.filter(node => node.kind !== 'object' || !node.objectType || activeFilters.has(node.objectType.toUpperCase())), [activeFilters, rootNodes]);

  return <section className="electron-schema-explorer" aria-label="Database schema">
    <div className="electron-schema-heading"><strong>Schema</strong><button type="button" title="Refresh schema" onClick={() => void loadChildren(ROOT)}>↻</button></div>
    <label className="electron-schema-search"><span>⌕</span><input aria-label="Search schema" placeholder="Search tables, views…" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="electron-schema-filters">{OBJECT_FILTERS.map(filter => <button type="button" key={filter} className={activeFilters.has(filter) ? 'active' : ''} onClick={() => toggleFilter(filter)}>{filter}</button>)}</div>
    {error && <div className="electron-schema-error" role="alert">{error}</div>}
    {search.trim() ? <div className="electron-schema-search-results">{searchItems.length === 0 ? <span className="electron-schema-empty">No matching objects.</span> : searchItems.map(item => <button type="button" key={`${item.database}.${item.schema}.${item.name}`} onClick={() => onInsert(qualifiedName({ id: `search:${item.name}`, kind: 'object', label: item.name, database: item.database, schema: item.schema, objectName: item.name, objectType: item.objectType, hasChildren: false }, databaseKind))}><span>{item.objectType === 'VIEW' ? '◌' : '▤'}</span><span><strong>{item.name}</strong><small>{item.database}.{item.schema} · {item.objectType}</small></span></button>)}</div>
      : <div className="electron-schema-tree">{loading.has(ROOT) && rootNodes.length === 0 ? <span className="electron-schema-loading">Loading schema…</span> : visibleRootNodes.map(node => <SchemaNode key={node.id} node={node} depth={0} children={children} expanded={expanded} loading={loading} databaseKind={databaseKind} onToggle={toggleNode} onSelect={selectNode} onContextMenu={(event, item) => { if (item.kind === 'object') { event.preventDefault(); event.stopPropagation(); onObjectSelect?.(item); setMenu({ node: item, x: event.clientX, y: event.clientY }); } }} />)}</div>}
    {menu && <div className="electron-schema-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}><strong>{menu.node.label}</strong><button type="button" onClick={() => onInsert(objectSql(menu.node, databaseKind))}>Insert qualified name</button><button type="button" onClick={() => { onOpenQuery?.(buildTopRowsQuery({ database: menu.node.database, schema: menu.node.schema, objectName: menu.node.objectName ?? menu.node.label }, databaseKind), `Top 1000 · ${menu.node.label}`, menu.node); setMenu(undefined); }}>View top 1000</button><button type="button" onClick={() => { try { onOpenQuery?.(buildExplainQuery(buildTopRowsQuery({ database: menu.node.database, schema: menu.node.schema, objectName: menu.node.objectName ?? menu.node.label }, databaseKind), databaseKind), `Explain · ${menu.node.label}`, menu.node); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Explain plans are not available for this connection.'); } setMenu(undefined); }}>Explain plan</button><button type="button" onClick={() => void openDdl(menu.node)}>Open DDL</button>{onImport && <button type="button" onClick={() => { onImport(menu.node); setMenu(undefined); }}>Import CSV/XLSX</button>}</div>}
  </section>;
}

function SchemaNode({ node, depth, children, expanded, loading, databaseKind, onToggle, onSelect, onContextMenu }: {
  readonly node: SchemaTreeNode;
  readonly depth: number;
  readonly children: Record<string, readonly SchemaTreeNode[]>;
  readonly expanded: ReadonlySet<string>;
  readonly loading: ReadonlySet<string>;
  readonly databaseKind: DatabaseKind;
  readonly onToggle: (node: SchemaTreeNode) => void;
  readonly onSelect: (node: SchemaTreeNode) => void;
  readonly onContextMenu: (event: React.MouseEvent<HTMLDivElement>, node: SchemaTreeNode) => void;
}): ReactElement {
  const isExpandable = node.kind === 'object' || node.hasChildren;
  const open = expanded.has(node.id);
  return <div className="electron-schema-node"><div className="electron-schema-row" style={{ paddingLeft: `${6 + depth * 13}px` }} onContextMenu={event => onContextMenu(event, node)}><button type="button" className="electron-schema-expander" disabled={!isExpandable} onClick={() => onToggle(node)}>{isExpandable ? open ? '▾' : '▸' : ' '}</button><button type="button" className="electron-schema-label" title={node.kind === 'object' || node.kind === 'column' ? `Insert ${qualifiedName(node, databaseKind)}` : node.description ?? node.label} onClick={() => onSelect(node)}><span className="electron-schema-glyph">{nodeGlyph(node)}</span><span>{node.label}</span>{node.kind === 'column' && node.columnType && <small>{node.columnType}</small>}</button>{loading.has(node.id) && <span className="electron-schema-spinner">…</span>}</div>{open && <div>{(children[node.id] ?? []).map(child => <SchemaNode key={child.id} node={child} depth={depth + 1} children={children} expanded={expanded} loading={loading} databaseKind={databaseKind} onToggle={onToggle} onSelect={onSelect} onContextMenu={onContextMenu} />)}</div>}</div>;
}
