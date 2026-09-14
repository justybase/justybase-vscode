import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiIdentity } from '@justybase/contracts';
import {
  DockyardManagerAdapter,
  explainToolId,
  queryDocumentId,
  type DockyardContentDefinition,
  type DockyardStorage,
} from '@justybase/dockyard-layout';

export interface ElectronDockyardDocument {
  readonly id: string;
  readonly title: string;
  readonly dirty?: boolean;
  readonly content: ReactNode;
}

export interface ElectronDockyardTool {
  readonly id: string;
  readonly title: string;
  readonly content: ReactNode;
  readonly defaultDock?: 'left' | 'right' | 'hidden';
}

export interface ElectronDockyardWorkspaceProps {
  readonly documents?: readonly ElectronDockyardDocument[];
  readonly tools?: readonly ElectronDockyardTool[];
  readonly activeDocumentId?: string;
  /** Compatibility inputs for the first Electron migration step. */
  readonly title?: string;
  readonly activeSurface?: string;
  readonly surfaces?: readonly { readonly id: string; readonly label: string }[];
  onSurfaceChange?(surface: string): void;
  readonly sidebar?: ReactNode;
  readonly children?: ReactNode;
  readonly headerActions?: ReactNode;
  readonly footer?: ReactNode;
  onNewDocument?(): void;
  onActiveDocumentChanged?(documentId: string): void;
  onToolActivated?(toolId: string): void;
  onDocumentClosing?(documentId: string): boolean;
  onDocumentClosed?(documentId: string): void;
  onResetLayout?(): void;
}

const ELECTRON_DOCKYARD_IDENTITY: UiIdentity = {
  productId: 'electron',
  workspaceId: 'electron-profile',
  storageId: 'electron-profile:dockyard',
};

function createDockyardStorage(): DockyardStorage {
  const fallback = new Map<string, string>();
  const keyFor = (key: string): string => `justybase:electron:dockyard:${key}`;
  return {
    get: key => {
      try { return globalThis.localStorage?.getItem(keyFor(key)) ?? fallback.get(key) ?? null; } catch { return fallback.get(key) ?? null; }
    },
    set: (key, value) => {
      fallback.set(key, value);
      try { globalThis.localStorage?.setItem(keyFor(key), value); } catch { /* Electron storage can be disabled in a test shell. */ }
    },
    remove: key => {
      fallback.delete(key);
      try { globalThis.localStorage?.removeItem(keyFor(key)); } catch { /* Best effort; memory reset remains valid. */ }
    },
  };
}

function contentIdForDocument(documentId: string): string {
  return queryDocumentId(documentId);
}

export function ElectronDockyardWorkspace({
  documents,
  tools,
  activeDocumentId,
  title,
  activeSurface,
  surfaces,
  onSurfaceChange,
  sidebar,
  children,
  headerActions,
  footer,
  onNewDocument,
  onActiveDocumentChanged,
  onToolActivated,
  onDocumentClosing,
  onDocumentClosed,
  onResetLayout,
}: ElectronDockyardWorkspaceProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<DockyardManagerAdapter | null>(null);
  const storageRef = useRef<DockyardStorage | undefined>(undefined);
  const contentHostsRef = useRef(new Map<string, HTMLElement>());
  const callbacksRef = useRef({ onActiveDocumentChanged, onToolActivated, onDocumentClosing, onDocumentClosed });
  callbacksRef.current = { onActiveDocumentChanged, onToolActivated, onDocumentClosing, onDocumentClosed };
  const [adapter, setAdapter] = useState<DockyardManagerAdapter | null>(null);
  const [initializationError, setInitializationError] = useState<string | undefined>(undefined);

  if (!storageRef.current) storageRef.current = createDockyardStorage();

  const dockyardDocuments = useMemo<readonly ElectronDockyardDocument[]>(() => documents ?? [{
    id: 'electron-main',
    title: title ?? 'Workspace',
    content: children,
  }], [children, documents, title]);
  const dockyardTools = useMemo<readonly ElectronDockyardTool[]>(() => tools ?? (sidebar ? [{
    id: 'electron-explorer',
    title: 'Explorer',
    defaultDock: 'left' as const,
    content: sidebar,
  }] : []), [sidebar, tools]);

  const hostFor = useCallback((contentId: string): HTMLElement => {
    const existing = contentHostsRef.current.get(contentId);
    if (existing) return existing;
    const host = (hostRef.current?.ownerDocument ?? document).createElement('div');
    host.className = 'electron-dockyard-react-content-host';
    contentHostsRef.current.set(contentId, host);
    return host;
  }, []);

  function attachTestHosts(nextDefinitions: readonly DockyardContentDefinition[]): void {
    const host = hostRef.current;
    // The production Dockyard manager creates its own .ad-manager chrome and
    // reparents content hosts into panes. The Jest shim intentionally models
    // only the layout API, so keep the React portals visible in that boundary.
    if (!host || host.querySelector('.ad-manager')) return;
    for (const definition of nextDefinitions) {
      if (!definition.content.parentElement) host.appendChild(definition.content);
    }
  }

  const definitionSignature = useMemo(
    () => [...dockyardDocuments.map(document => `d:${document.id}`), ...dockyardTools.map(tool => `t:${tool.id}`)].join('\u0001'),
    [dockyardDocuments, dockyardTools],
  );
  const definitions = useMemo<DockyardContentDefinition[]>(() => [
    ...dockyardTools.map(tool => ({
      id: tool.id,
      title: tool.title,
      kind: 'tool' as const,
      defaultDock: tool.defaultDock ?? 'hidden',
      content: hostFor(tool.id),
    })),
    ...dockyardDocuments.map(document => ({
      id: contentIdForDocument(document.id),
      title: document.title,
      kind: 'document' as const,
      modified: document.dirty,
      content: hostFor(contentIdForDocument(document.id)),
    })),
  ], [definitionSignature, dockyardDocuments, dockyardTools, hostFor]);

  const presentationDefinitions = useMemo<DockyardContentDefinition[]>(() => dockyardDocuments.map(document => ({
    id: contentIdForDocument(document.id),
    title: document.title,
    kind: 'document' as const,
    modified: document.dirty,
    content: hostFor(contentIdForDocument(document.id)),
  })), [dockyardDocuments, hostFor]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || adapterRef.current || !storageRef.current) return undefined;
    try {
      const next = new DockyardManagerAdapter({
        host,
        storage: storageRef.current,
        identity: ELECTRON_DOCKYARD_IDENTITY,
        definitions,
        explorerWidth: 360,
        onActiveContentChanged: contentId => {
          if (!contentId) return;
          if (contentId.startsWith('query:')) callbacksRef.current.onActiveDocumentChanged?.(contentId.slice('query:'.length));
          else callbacksRef.current.onToolActivated?.(contentId);
        },
        onDocumentClosing: onDocumentClosing ? documentId => callbacksRef.current.onDocumentClosing?.(documentId) ?? false : undefined,
        onDocumentClosed: documentId => callbacksRef.current.onDocumentClosed?.(documentId),
        onError: reason => setInitializationError(reason.message),
      });
      adapterRef.current = next;
      setAdapter(next);
      attachTestHosts(definitions);
    } catch (reason: unknown) {
      setInitializationError(reason instanceof Error ? reason.message : 'Dockyard initialization failed.');
    }
    return undefined;
  }, [definitions]);

  useEffect(() => {
    if (!adapter) return;
    adapter.syncDefinitions(definitions, activeDocumentId ? contentIdForDocument(activeDocumentId) : undefined);
    attachTestHosts(definitions);
  }, [activeDocumentId, adapter, definitions]);

  useEffect(() => {
    if (!adapter) return;
    adapter.updateDefinitionPresentation(presentationDefinitions);
  }, [adapter, presentationDefinitions]);

  useEffect(() => () => {
    adapterRef.current?.dispose();
    adapterRef.current = null;
    contentHostsRef.current.clear();
  }, []);

  const contentById = useMemo(() => {
    const map = new Map<string, ReactNode>();
    for (const tool of dockyardTools) map.set(tool.id, tool.content);
    for (const document of dockyardDocuments) map.set(contentIdForDocument(document.id), document.content);
    return map;
  }, [dockyardDocuments, dockyardTools]);

  const activate = (contentId: string): void => { adapter?.activate(contentId); };

  return <div className="electron-dockyard-shell">
    <header className="electron-dockyard-topbar">
      <h1 className="electron-dockyard-brand">JustyBase</h1>
      <div className="electron-dockyard-title">Netezza SQL Workspace</div>
      <nav className="electron-dockyard-tool-buttons" aria-label="Dockyard tools">
        {dockyardTools.map(tool => <button type="button" className="electron-dockyard-button" data-dockyard-tool={tool.id} key={tool.id} onClick={() => activate(tool.id)}>{tool.title}</button>)}
        {surfaces?.map(surface => <button type="button" className="electron-dockyard-button" aria-current={surface.id === activeSurface ? 'page' : undefined} key={surface.id} onClick={() => onSurfaceChange?.(surface.id)}>{surface.label}</button>)}
        {onNewDocument && <button type="button" className="electron-dockyard-button" onClick={onNewDocument}>New query</button>}
        {onResetLayout && <button type="button" className="electron-dockyard-button" onClick={() => { adapter?.resetLayout(); onResetLayout(); }}>Reset layout</button>}
      </nav>
      <div className="electron-dockyard-actions">{headerActions}</div>
    </header>
    <main className="electron-dockyard-workspace-shell">
      <div className="electron-dockyard-host" ref={hostRef} />
      {initializationError
        ? <div className="electron-dockyard-init-error" role="alert"><strong>Dockyard could not initialize.</strong><span>{initializationError}</span><button type="button" onClick={() => window.location.reload()}>Reload workspace</button></div>
        : adapter && definitions.map(definition => {
          const content = contentById.get(definition.id);
          return content === undefined ? null : createPortal(content, definition.content, definition.id);
        })}
    </main>
    {footer && <footer className="electron-dockyard-statusbar">{footer}</footer>}
  </div>;
}

export { explainToolId };
