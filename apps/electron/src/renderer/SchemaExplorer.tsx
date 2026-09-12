import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import type { DatabaseKind, MetadataColumn, MetadataDdlResponse, SchemaSearchResult, SchemaTreeNode } from '@justybase/contracts';
import { buildExplainQuery, buildTopRowsQuery, formatQueryObjectName, formatQuerySchemaName, quoteIdentifierForQuery } from '@justybase/dialect-utils';
import { readSchemaExplorerShortcuts, rememberSchemaObject, schemaObjectIdentity, schemaExplorerStorageKey, toggleSchemaFavorite, writeSchemaExplorerShortcuts } from './schemaExplorerState';

interface SchemaApi {
  schemaTree(connectionId: string, parentId?: string): Promise<{ nodes: SchemaTreeNode[] }>;
  searchSchema(input: { connectionId: string; term: string; database?: string; objectTypes?: string[] }): Promise<{ items: SchemaSearchResult[] }>;
  columns(connectionId: string, database: string, schema: string, table: string): Promise<readonly MetadataColumn[]>;
  ddl(input: { connectionId: string; database: string; schema: string; objectName: string; objectType: string }): Promise<MetadataDdlResponse>;
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

function searchResultNode(item: SchemaSearchResult): SchemaTreeNode {
  return {
    id: `search:${item.database}.${item.schema}.${item.name}`,
    kind: 'object',
    label: item.name,
    database: item.database,
    schema: item.schema,
    objectName: item.name,
    objectType: item.objectType,
    hasChildren: false,
  };
}

export interface SchemaExplorerProps {
  readonly api: SchemaApi;
  readonly connectionId?: string;
  readonly database?: string;
  readonly databaseKind: DatabaseKind;
  readonly onInsert: (value: string) => void;
  readonly onObjectSelect?: (node: SchemaTreeNode) => void;
  readonly onOpenDesigner?: (node: SchemaTreeNode) => void;
  readonly onOpenQuery?: (sql: string, title: string, node: SchemaTreeNode) => void;
  readonly onOpenDdl?: (sql: string, title: string, node: SchemaTreeNode) => void;
  readonly onImport?: (node: SchemaTreeNode) => void;
  readonly refreshNonce?: number;
}

export function SchemaExplorer({ api, connectionId, database, databaseKind, onInsert, onObjectSelect, onOpenDesigner, onOpenQuery, onOpenDdl, onImport, refreshNonce = 0 }: SchemaExplorerProps): ReactElement {
  const [children, setChildren] = useState<Record<string, readonly SchemaTreeNode[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [searchItems, setSearchItems] = useState<readonly SchemaSearchResult[]>([]);
  const [activeFilters, setActiveFilters] = useState<ReadonlySet<string>>(new Set(OBJECT_FILTERS));
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<{ node: SchemaTreeNode; x: number; y: number } | undefined>(undefined);
  const [favorites, setFavorites] = useState<readonly SchemaTreeNode[]>([]);
  const [recentObjects, setRecentObjects] = useState<readonly SchemaTreeNode[]>([]);
  const [shortcutsReadyKey, setShortcutsReadyKey] = useState<string | undefined>(undefined);
  const generationRef = useRef(0);
  const requestSequenceRef = useRef(new Map<string, number>());

  const shortcutsKey = connectionId ? schemaExplorerStorageKey(connectionId) : undefined;

  useEffect(() => {
    setShortcutsReadyKey(undefined);
    if (!connectionId || !shortcutsKey) {
      setFavorites([]);
      setRecentObjects([]);
      return;
    }
    const stored = readSchemaExplorerShortcuts(connectionId);
    setFavorites(stored.favorites);
    setRecentObjects(stored.recent);
    setShortcutsReadyKey(shortcutsKey);
  }, [connectionId, shortcutsKey]);

  useEffect(() => {
    if (!connectionId || !shortcutsKey || shortcutsReadyKey !== shortcutsKey) return;
    writeSchemaExplorerShortcuts(connectionId, { favorites, recent: recentObjects });
  }, [connectionId, favorites, recentObjects, shortcutsKey, shortcutsReadyKey]);

  const setLoadingKey = useCallback((key: string, value: boolean): void => {
    setLoading(previous => {
      const next = new Set(previous);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const loadChildren = useCallback(async (parentId: string, node?: SchemaTreeNode): Promise<readonly SchemaTreeNode[]> => {
    if (!connectionId) return [];
    const generation = generationRef.current;
    const requestSequence = (requestSequenceRef.current.get(parentId) ?? 0) + 1;
    requestSequenceRef.current.set(parentId, requestSequence);
    setLoadingKey(parentId, true);
    setError(undefined);
    setNotice(undefined);
    const isCurrentRequest = (): boolean => generationRef.current === generation
      && requestSequenceRef.current.get(parentId) === requestSequence;
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
      if (!isCurrentRequest()) return [];
      setChildren(previous => ({ ...previous, [parentId]: nodes }));
      return nodes;
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not load schema metadata.');
      return [];
    } finally {
      if (isCurrentRequest()) setLoadingKey(parentId, false);
    }
  }, [api, connectionId, setLoadingKey]);

  useEffect(() => {
    generationRef.current += 1;
    requestSequenceRef.current.clear();
    setChildren({});
    setExpanded(new Set([ROOT]));
    setSearchItems([]);
    setError(undefined);
    setNotice(undefined);
    if (connectionId) void loadChildren(ROOT);
  }, [connectionId, loadChildren, refreshNonce]);

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
  }, [activeFilters, api, connectionId, database, refreshNonce, search]);

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
    const wasExpanded = expanded.has(node.id);
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
      return next;
    });
    if (!wasExpanded && !children[node.id]) void loadChildren(node.id, node);
  };

  const selectNode = (node: SchemaTreeNode): void => {
    onObjectSelect?.(node);
    if (node.kind === 'object') {
      setRecentObjects(previous => rememberSchemaObject(previous, node));
      onInsert(qualifiedName(node, databaseKind));
    } else if (node.kind === 'column') {
      onInsert(qualifiedName(node, databaseKind));
    }
  };

  const refreshSchema = (): void => {
    generationRef.current += 1;
    requestSequenceRef.current.clear();
    setChildren({});
    setExpanded(new Set([ROOT]));
    setError(undefined);
    setNotice(undefined);
    void loadChildren(ROOT);
  };

  const collapseAll = (): void => setExpanded(new Set([ROOT]));

  const expandAll = async (): Promise<void> => {
    const generation = generationRef.current;
    // A full expansion is an explicit request for a current tree. Do not
    // reuse nested children from before a schema mutation/refresh; those
    // nodes may have the same stable ids while their columns have changed.
    const loaded = new Map<string, readonly SchemaTreeNode[]>();
    const root = await loadChildren(ROOT);
    if (generationRef.current !== generation) return;
    loaded.set(ROOT, root);
    const nextExpanded = new Set<string>([ROOT]);

    const visit = async (nodes: readonly SchemaTreeNode[]): Promise<void> => {
      for (const node of nodes) {
        if (generationRef.current !== generation) return;
        if (node.kind !== 'object' && !node.hasChildren) continue;
        nextExpanded.add(node.id);
        let nodeChildren = loaded.get(node.id);
        if (!nodeChildren) {
          nodeChildren = await loadChildren(node.id, node);
          loaded.set(node.id, nodeChildren);
        }
        await visit(nodeChildren);
      }
    };

    await visit(root);
    if (generationRef.current === generation) setExpanded(nextExpanded);
  };

  const openDdl = async (node: SchemaTreeNode): Promise<void> => {
    setMenu(undefined);
    if (node.kind !== 'object' || !connectionId || !node.database || !node.schema || !node.objectName) return;
    try {
      const objectType = node.objectType?.toUpperCase() || 'TABLE';
      const result = await api.ddl({ connectionId, database: node.database, schema: node.schema, objectName: node.objectName, objectType });
      if (!result.success || !result.ddlCode) throw new Error(result.error ?? 'The database returned no DDL.');
      onOpenDdl?.(result.ddlCode, `DDL · ${node.label}`, node);
      setNotice(result.ddlFidelity === 'reconstructed'
        ? 'DDL opened. It was reconstructed from catalog metadata; inspect the warnings before executing it.'
        : 'DDL opened.');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not generate DDL.');
    }
  };

  const copyToClipboard = async (value: string): Promise<void> => {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this Electron window.');
    await navigator.clipboard.writeText(value);
  };

  const copyName = async (node: SchemaTreeNode): Promise<void> => {
    setMenu(undefined);
    try {
      await copyToClipboard(objectSql(node, databaseKind));
      setNotice('Qualified name copied to clipboard.');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not copy the qualified name.');
    }
  };

  const copyDdl = async (node: SchemaTreeNode): Promise<void> => {
    setMenu(undefined);
    if (!connectionId || node.kind !== 'object' || !node.database || !node.schema) return;
    try {
      const result = await api.ddl({
        connectionId,
        database: node.database,
        schema: node.schema,
        objectName: node.objectName ?? node.label,
        objectType: node.objectType?.toUpperCase() || 'TABLE',
      });
      if (!result.success || !result.ddlCode) throw new Error(result.error ?? 'The database returned no DDL.');
      await copyToClipboard(result.ddlCode);
      setNotice(result.ddlFidelity === 'reconstructed'
        ? 'Reconstructed DDL copied. Inspect the metadata warnings before executing it.'
        : 'DDL copied to clipboard.');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not generate DDL.');
    }
  };

  const toggleFavorite = (node: SchemaTreeNode): void => {
    setFavorites(previous => toggleSchemaFavorite(previous, node));
    setMenu(undefined);
  };

  const openObjectMenu = (event: ReactMouseEvent<HTMLElement>, node: SchemaTreeNode): void => {
    if (node.kind !== 'object') return;
    event.preventDefault();
    event.stopPropagation();
    onObjectSelect?.(node);
    setMenu({ node, x: event.clientX, y: event.clientY });
  };

  const selectSearchResult = (item: SchemaSearchResult): void => selectNode(searchResultNode(item));

  const visibleRootNodes = useMemo(() => rootNodes.filter(node => node.kind !== 'object' || !node.objectType || activeFilters.has(node.objectType.toUpperCase())), [activeFilters, rootNodes]);

  return <section className="electron-schema-explorer" aria-label="Database schema" aria-busy={loading.has(ROOT) ? 'true' : 'false'}>
    <div className="electron-schema-heading"><strong>Schema</strong><div className="electron-schema-actions"><button type="button" aria-label="Refresh schema" title="Refresh schema" onClick={refreshSchema}>↻</button><button type="button" aria-label="Expand all schema nodes" title="Expand all" disabled={loading.has(ROOT)} onClick={() => void expandAll()}>＋</button><button type="button" aria-label="Collapse all schema nodes" title="Collapse all" onClick={collapseAll}>−</button></div></div>
    <label className="electron-schema-search"><span>⌕</span><input aria-label="Search schema" placeholder="Search tables, views…" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="electron-schema-filters">{OBJECT_FILTERS.map(filter => <button type="button" key={filter} className={activeFilters.has(filter) ? 'active' : ''} onClick={() => toggleFilter(filter)}>{filter}</button>)}</div>
    {error && <div className="electron-schema-error" role="alert">{error}</div>}
    {notice && <div className="electron-schema-notice" role="status">{notice}</div>}
    {(favorites.length > 0 || recentObjects.length > 0) && <div className="electron-schema-shortcuts">
      {favorites.length > 0 && <div><div className="electron-schema-shortcuts-title">Favorites</div>{favorites.map(node => <button type="button" className="electron-schema-shortcut" key={`favorite:${schemaObjectIdentity(node)}`} onClick={() => selectNode(node)} onContextMenu={event => openObjectMenu(event, node)}><span>★</span><span>{node.label}</span><small>{node.schema}</small></button>)}</div>}
      {recentObjects.length > 0 && <div><div className="electron-schema-shortcuts-title">Recent</div>{recentObjects.slice(0, 5).map(node => <button type="button" className="electron-schema-shortcut" key={`recent:${schemaObjectIdentity(node)}`} onClick={() => selectNode(node)} onContextMenu={event => openObjectMenu(event, node)}><span>↻</span><span>{node.label}</span><small>{node.schema}</small></button>)}</div>}
    </div>}
    {search.trim() ? <div className="electron-schema-search-results">{searchItems.length === 0 ? <span className="electron-schema-empty">No matching objects.</span> : searchItems.map(item => <button type="button" key={`${item.database}.${item.schema}.${item.name}`} onClick={() => selectSearchResult(item)}><span>{item.objectType === 'VIEW' ? '◌' : '▤'}</span><span><strong>{item.name}</strong><small>{item.database}.{item.schema} · {item.objectType}</small></span></button>)}</div>
      : <div className="electron-schema-tree">{loading.has(ROOT) && rootNodes.length === 0 ? <span className="electron-schema-loading">Loading schema…</span> : visibleRootNodes.map(node => <SchemaNode key={node.id} node={node} depth={0} children={children} expanded={expanded} loading={loading} databaseKind={databaseKind} onToggle={toggleNode} onSelect={selectNode} onContextMenu={openObjectMenu} />)}</div>}
    {menu && <div className="electron-schema-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}><strong>{menu.node.label}</strong><button type="button" onClick={() => { onInsert(objectSql(menu.node, databaseKind)); setMenu(undefined); }}>Insert qualified name</button><button type="button" onClick={() => void copyName(menu.node)}>Copy qualified name</button><button type="button" onClick={() => { onOpenQuery?.(buildTopRowsQuery({ database: menu.node.database, schema: menu.node.schema, objectName: menu.node.objectName ?? menu.node.label }, databaseKind), `Top 1000 · ${menu.node.label}`, menu.node); setMenu(undefined); }}>View top 1000</button><button type="button" onClick={() => { try { onOpenQuery?.(buildExplainQuery(buildTopRowsQuery({ database: menu.node.database, schema: menu.node.schema, objectName: menu.node.objectName ?? menu.node.label }, databaseKind), databaseKind), `Explain · ${menu.node.label}`, menu.node); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Explain plans are not available for this connection.'); } setMenu(undefined); }}>Explain plan</button>{onOpenDesigner && <button type="button" onClick={() => { onOpenDesigner(menu.node); setMenu(undefined); }}>Open Object Designer</button>}<button type="button" onClick={() => void openDdl(menu.node)}>Open DDL</button><button type="button" onClick={() => void copyDdl(menu.node)}>Copy DDL</button>{onImport && <button type="button" onClick={() => { onImport(menu.node); setMenu(undefined); }}>Import CSV/XLSX</button>}<button type="button" onClick={() => toggleFavorite(menu.node)}>{favorites.some(item => schemaObjectIdentity(item) === schemaObjectIdentity(menu.node)) ? 'Remove from favorites' : 'Add to favorites'}</button></div>}
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
  readonly onContextMenu: (event: ReactMouseEvent<HTMLElement>, node: SchemaTreeNode) => void;
}): ReactElement {
  const isExpandable = node.kind === 'object' || node.hasChildren;
  const open = expanded.has(node.id);
  return <div className="electron-schema-node"><div className="electron-schema-row" style={{ paddingLeft: `${6 + depth * 13}px` }} onContextMenu={event => onContextMenu(event, node)}><button type="button" className="electron-schema-expander" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.label}`} aria-expanded={isExpandable ? open : undefined} disabled={!isExpandable} onClick={() => onToggle(node)}>{isExpandable ? open ? '▾' : '▸' : ' '}</button><button type="button" className="electron-schema-label" title={node.kind === 'object' || node.kind === 'column' ? `Insert ${qualifiedName(node, databaseKind)}` : node.description ?? node.label} onClick={() => onSelect(node)}><span className="electron-schema-glyph">{nodeGlyph(node)}</span><span>{node.label}</span>{node.kind === 'column' && node.columnType && <small>{node.columnType}</small>}</button>{loading.has(node.id) && <span className="electron-schema-spinner">…</span>}</div>{open && <div>{(children[node.id] ?? []).map(child => <SchemaNode key={child.id} node={child} depth={depth + 1} children={children} expanded={expanded} loading={loading} databaseKind={databaseKind} onToggle={onToggle} onSelect={onSelect} onContextMenu={onContextMenu} />)}</div>}</div>;
}
