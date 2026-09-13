import {
  DockingManager,
  LayoutAnchorable,
  LayoutAnchorGroup,
  LayoutAnchorSide,
  LayoutAnchorableFloatingWindow,
  LayoutAnchorablePaneGroup,
  LayoutAnchorablePane,
  LayoutContent,
  LayoutDocument,
  LayoutDocumentFloatingWindow,
  LayoutDocumentPaneGroup,
  LayoutDocumentPane,
  LayoutFloatingWindow,
  LayoutGroup,
  LayoutPanel,
  LayoutRoot,
  contents,
} from 'avalondock-web';
import type { LayoutSnapshot, MenuEntry } from 'avalondock-web';
import type { WorkspaceStorage } from '../workspacePersistence';
import {
  loadDockyardLayout,
  parseDockyardLayout,
  resetDockyardLayout,
  saveDockyardLayout,
} from './dockyardLayout';

/**
 * Dockyard's upstream serializer uses constructor.name for record types. A
 * production bundler is allowed to minify those names (for example `Lt` for
 * LayoutDocument), which would make an otherwise valid saved layout unreadable
 * after reload. Canonicalize at this product boundary and leave the vendored
 * upstream snapshot untouched.
 */
const DOCKYARD_TYPE_NAMES = new Map<string, string>([
  [LayoutRoot.name, 'LayoutRoot'],
  [LayoutPanel.name, 'LayoutPanel'],
  [LayoutGroup.name, 'LayoutGroup'],
  [LayoutContent.name, 'LayoutContent'],
  [LayoutDocument.name, 'LayoutDocument'],
  [LayoutAnchorable.name, 'LayoutAnchorable'],
  [LayoutDocumentPane.name, 'LayoutDocumentPane'],
  [LayoutAnchorablePane.name, 'LayoutAnchorablePane'],
  [LayoutDocumentPaneGroup.name, 'LayoutDocumentPaneGroup'],
  [LayoutAnchorablePaneGroup.name, 'LayoutAnchorablePaneGroup'],
  [LayoutAnchorSide.name, 'LayoutAnchorSide'],
  [LayoutAnchorGroup.name, 'LayoutAnchorGroup'],
  [LayoutFloatingWindow.name, 'LayoutFloatingWindow'],
  [LayoutDocumentFloatingWindow.name, 'LayoutDocumentFloatingWindow'],
  [LayoutAnchorableFloatingWindow.name, 'LayoutAnchorableFloatingWindow'],
]);

function canonicalizeDockyardJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDockyardJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const canonical = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, canonicalizeDockyardJson(item)]));
  if (typeof canonical.type === 'string') canonical.type = DOCKYARD_TYPE_NAMES.get(canonical.type) ?? canonical.type;
  return canonical;
}

export function normalizeDockyardSnapshot(snapshot: LayoutSnapshot): LayoutSnapshot {
  return canonicalizeDockyardJson(snapshot) as LayoutSnapshot;
}

export const DOCKYARD_CONTENT_IDS = {
  connections: 'connections',
  schema: 'schema',
  inspector: 'inspector',
  history: 'history',
} as const;

export type DockyardToolId = typeof DOCKYARD_CONTENT_IDS[keyof typeof DOCKYARD_CONTENT_IDS];

export function queryDocumentId(tabId: string): string {
  return `query:${tabId}`;
}

export function explainToolId(tabId: string): string {
  return `explain:${tabId}`;
}

export type DockyardContentKind = 'document' | 'tool';

export interface DockyardContentDefinition {
  readonly id: string;
  readonly title: string;
  readonly kind: DockyardContentKind;
  readonly content: HTMLElement;
  readonly modified?: boolean;
  /** Initial placement in the SQL workspace. Hidden tools remain available
   * through the top-level tool buttons without stealing result-grid space. */
  readonly defaultDock?: 'left' | 'right' | 'hidden';
}

export interface DockyardManagerCallbacks {
  onActiveContentChanged?(contentId: string | undefined): void;
  /** Return false to cancel a document close (for example, a dirty tab). */
  onDocumentClosing?(tabId: string): boolean;
  onDocumentClosed?(tabId: string): void;
  onLayoutUpdated?(snapshot: LayoutSnapshot): void;
  onError?(error: Error): void;
}

export interface DockyardManagerAdapterOptions extends DockyardManagerCallbacks {
  host: HTMLElement;
  storage: WorkspaceStorage;
  definitions: readonly DockyardContentDefinition[];
  explorerWidth: number;
  rightWidth?: number;
}

export const DOCKYARD_LAYOUT_IDS = {
  root: 'dockyard-root',
  rootPanel: 'dockyard-root-panel',
  explorerPane: 'dockyard-explorer-pane',
  documentPane: 'dockyard-document-pane',
  toolsPane: 'dockyard-tools-pane',
} as const;

// The Schema tree contains a search field, type filters and a VS Code-like
// object tree. 250px is technically valid for Dockyard, but it is too narrow
// once those controls are rendered; 360px keeps the tree readable while
// leaving the query editor/results area dominant.
export const DEFAULT_DOCKYARD_EXPLORER_WIDTH = 360;

function definitionModel(definition: DockyardContentDefinition): LayoutContent {
  if (definition.kind === 'document') {
    return new LayoutDocument({
      Id: definition.id,
      ContentId: definition.id,
      Title: definition.title,
      Content: definition.content,
      IsModified: definition.modified === true,
      CanClose: true,
      CanFloat: true,
      CanMove: true,
      CanDock: true,
    });
  }
  return new LayoutAnchorable({
    Id: definition.id,
    ContentId: definition.id,
    Title: definition.title,
    Content: definition.content,
    CanClose: false,
    CanHide: true,
    CanAutoHide: true,
    CanFloat: true,
    CanMove: true,
    CanDock: true,
    AutoHideWidth: 320,
    AutoHideHeight: 260,
  });
}

function definitionsOf(definitions: readonly DockyardContentDefinition[], kind: DockyardContentKind): LayoutContent[] {
  return definitions.filter(definition => definition.kind === kind).map(definitionModel);
}

/** Creates the safe initial Dockyard layout used when no valid snapshot exists. */
export function createDefaultDockyardLayout(
  definitions: readonly DockyardContentDefinition[],
  explorerWidth: number,
  rightWidth = 320,
): LayoutRoot {
  const leftTools = definitions.filter(definition => definition.kind === 'tool' && (
    definition.defaultDock === 'left'
    || (definition.defaultDock === undefined && (definition.id === DOCKYARD_CONTENT_IDS.connections || definition.id === DOCKYARD_CONTENT_IDS.schema))
  ));
  const rightTools = definitions.filter(definition => definition.kind === 'tool'
    && !leftTools.some(left => left.id === definition.id)
    && definition.defaultDock !== 'hidden');
  const explorerPane = new LayoutAnchorablePane({
    Id: DOCKYARD_LAYOUT_IDS.explorerPane,
    Name: 'Explorer',
    DockWidth: Math.max(160, Math.min(500, explorerWidth)),
    Children: leftTools.map(definitionModel) as LayoutAnchorable[],
  });
  const documentPane = new LayoutDocumentPane({
    Id: DOCKYARD_LAYOUT_IDS.documentPane,
    Name: 'Queries',
    Children: definitionsOf(definitions, 'document') as LayoutDocument[],
  });
  const toolsPane = new LayoutAnchorablePane({
    Id: DOCKYARD_LAYOUT_IDS.toolsPane,
    Name: 'Tools',
    DockWidth: Math.max(220, Math.min(500, rightWidth)),
    Children: rightTools.map(definitionModel) as LayoutAnchorable[],
  });
  return new LayoutRoot({
    Id: DOCKYARD_LAYOUT_IDS.root,
    RootPanel: new LayoutPanel({
      Id: DOCKYARD_LAYOUT_IDS.rootPanel,
      Orientation: 'Horizontal',
      Children: [explorerPane, documentPane, toolsPane],
    }),
  });
}

function tabIdFromDocumentId(contentId: string | null): string | undefined {
  return contentId?.startsWith('query:') ? contentId.slice('query:'.length) : undefined;
}

function errorValue(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Browser windows are outside the web workspace lifecycle and bypass the
 * in-page Dockyard recovery/teardown contract. Keep the upstream context
 * menu useful while removing only that unsupported action.
 */
export function filterDockyardContextMenu(_model: LayoutContent, _manager: DockingManager, defaults: (MenuEntry | null)[]): (MenuEntry | null)[] {
  return defaults.filter(entry => {
    const label = entry?.Label ?? entry?.label;
    return label !== 'Open in browser window';
  });
}

/**
 * DOM/React boundary for the vendored Dockyard model. ui-core owns portable
 * state and persistence rules; this adapter owns only Dockyard models,
 * content hosts, browser listeners, and layout serialization.
 */
export class DockyardManagerAdapter {
  public readonly manager: DockingManager;
  private readonly storage: WorkspaceStorage;
  private readonly hosts = new Map<string, HTMLElement>();
  private readonly models = new Map<string, LayoutContent>();
  private readonly subscriptions: Array<() => void> = [];
  private callbacks: DockyardManagerCallbacks;
  private definitions = new Map<string, DockyardContentDefinition>();
  private synchronizing = false;
  private disposed = false;
  private explorerWidth: number;
  private readonly rightWidth: number;

  public constructor(options: DockyardManagerAdapterOptions) {
    this.storage = options.storage;
    this.callbacks = options;
    this.explorerWidth = Number.isFinite(options.explorerWidth) ? options.explorerWidth : 250;
    this.rightWidth = options.rightWidth ?? 320;
    this.replaceDefinitions(options.definitions);
    const manager = new DockingManager(options.host, {
      Layout: createDefaultDockyardLayout(options.definitions, this.explorerWidth, this.rightWidth),
      Theme: 'dark',
      AllowMixedOrientation: true,
      EnableHistory: true,
      AutoSave: false,
      RestoreOnLoad: false,
      DocumentContextMenu: filterDockyardContextMenu,
      AnchorableContextMenu: filterDockyardContextMenu,
    });
    this.manager = manager;
    try {
      this.subscribeToManager();
      const saved = loadDockyardLayout(this.storage);
      if (saved) {
        try {
          this.manager.LoadLayout(normalizeDockyardSnapshot(saved));
        } catch {
          // Persisted layout is user data. A stale/corrupt snapshot must not
          // prevent the workspace from opening; discard it and retain the safe
          // layout supplied to the manager constructor.
          try {
            resetDockyardLayout(this.storage);
          } catch {
            // Storage is optional. The in-memory safe layout is still usable.
          }
        }
      }
      this.syncDefinitions(options.definitions);
    } catch (reason: unknown) {
      this.unsubscribeFromManager();
      try {
        manager.Dispose();
      } finally {
        this.models.clear();
        this.hosts.clear();
        this.definitions.clear();
      }
      throw reason;
    }
  }

  public setCallbacks(callbacks: DockyardManagerCallbacks): void {
    if (this.disposed) return;
    this.callbacks = callbacks;
  }

  public syncDefinitions(definitions: readonly DockyardContentDefinition[], activeContentId?: string): void {
    if (this.disposed) return;
    this.replaceDefinitions(definitions);
    this.synchronizing = true;
    let update: { Dispose(): void } | undefined;
    try {
      update = this.manager.BeginUpdate();
      for (const definition of definitions) {
        this.hosts.set(definition.id, definition.content);
        let model = this.manager.Find(definition.id);
        const expectedDocument = definition.kind === 'document';
        if (!model || (expectedDocument ? !(model instanceof LayoutDocument) : !(model instanceof LayoutAnchorable))) {
          if (model) this.removeModel(model);
          model = definitionModel(definition);
          if (expectedDocument) this.manager.AddDocument(model as LayoutDocument); // pane selection is owned by Dockyard.
          else {
            this.manager.AddAnchorable(model as LayoutAnchorable, definition.defaultDock === 'left' ? 'Left' : 'Right');
            if (definition.defaultDock === 'hidden') this.manager.Hide(model as LayoutAnchorable, false);
          }
        }
        model.Title = definition.title;
        model.Content = definition.content;
        model.IsModified = definition.modified === true;
        this.models.set(definition.id, model);
      }

      // A persisted layout can contain a document that was closed before the
      // snapshot was saved. Prune it after hydration, while suppressing the
      // close callback so React does not receive a duplicate tab transition.
      for (const model of contents(this.manager.Layout)) {
        if (!model.ContentId || this.definitions.has(model.ContentId)) continue;
        this.removeModel(model);
        this.manager.ReleaseContent(model.ContentId);
        this.models.delete(model.ContentId);
        this.hosts.delete(model.ContentId);
      }
      if (activeContentId && this.manager.Find(activeContentId)) this.manager.Activate(activeContentId);
    } catch (reason: unknown) {
      this.callbacks.onError?.(errorValue(reason));
    } finally {
      update?.Dispose();
      this.synchronizing = false;
    }
    this.persistLayout();
  }

  /**
   * Updates tab captions/dirty markers without touching the Dockyard layout
   * tree. This is intentionally separate from syncDefinitions: SQL editors
   * report a dirty-state change while the user types, and rebuilding the
   * docking tree at that point would detach Monaco's input surface/focus.
   */
  public updateDefinitionPresentation(definitions: readonly DockyardContentDefinition[]): void {
    if (this.disposed) return;
    for (const definition of definitions) {
      const model = this.models.get(definition.id) ?? this.manager.Find(definition.id);
      if (!model) continue;
      this.definitions.set(definition.id, definition);
      if (model.Title !== definition.title) model.Title = definition.title;
      if (model.IsModified !== (definition.modified === true)) model.IsModified = definition.modified === true;
    }
  }

  public getContentHost(contentId: string): HTMLElement | undefined {
    return this.hosts.get(contentId);
  }

  public activate(contentId: string): boolean {
    const model = this.manager.Find(contentId);
    return model ? this.manager.Activate(model) : false;
  }

  public float(contentId: string): boolean {
    const model = this.manager.Find(contentId);
    return model ? Boolean(this.manager.Float(model)) : false;
  }

  public dock(contentId: string): boolean {
    const model = this.manager.Find(contentId);
    return model ? Boolean(this.manager.Dock(model)) : false;
  }

  public hide(contentId: string): boolean {
    const model = this.manager.Find(contentId);
    return model instanceof LayoutAnchorable ? this.manager.Hide(model) : false;
  }

  public show(contentId: string): boolean {
    const model = this.manager.Find(contentId);
    return model instanceof LayoutAnchorable ? this.manager.Show(model) : false;
  }

  public toggleAutoHide(contentId: string): boolean {
    const model = this.manager.Find(contentId);
    return model instanceof LayoutAnchorable ? this.manager.ToggleAutoHide(model) : false;
  }

  public resetLayout(): void {
    if (this.disposed) return;
    this.explorerWidth = DEFAULT_DOCKYARD_EXPLORER_WIDTH;
    this.synchronizing = true;
    try {
      this.manager.Layout = createDefaultDockyardLayout([...this.definitions.values()], this.explorerWidth, this.rightWidth);
    } catch (reason: unknown) {
      this.callbacks.onError?.(errorValue(reason));
    } finally {
      this.synchronizing = false;
    }
    this.syncDefinitions([...this.definitions.values()]);
  }

  public saveLayout(): void {
    this.persistLayout();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFromManager();
    try {
      this.manager.Dispose();
    } finally {
      this.models.clear();
      this.hosts.clear();
      this.definitions.clear();
      this.callbacks = {};
    }
  }

  private unsubscribeFromManager(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Teardown is best effort for individual vendor subscriptions; the
        // manager itself is still disposed immediately afterwards.
      }
    }
  }

  private replaceDefinitions(definitions: readonly DockyardContentDefinition[]): void {
    const nextDefinitions = new Map(definitions.map(definition => [definition.id, definition]));
    for (const contentId of this.hosts.keys()) {
      if (!nextDefinitions.has(contentId)) this.hosts.delete(contentId);
    }
    for (const contentId of this.models.keys()) {
      if (!nextDefinitions.has(contentId)) this.models.delete(contentId);
    }
    this.definitions = nextDefinitions;
    for (const definition of definitions) this.hosts.set(definition.id, definition.content);
  }

  private removeModel(model: LayoutContent): void {
    if (this.manager.Close(model)) return;
    // Tool windows are intentionally not closable through the user-facing
    // chrome, but stale persisted tools still need to be removed when their
    // stable definition disappears (for example after a tab is closed).
    const parent = model.Parent as { RemoveChild?(child: LayoutContent): boolean } | null;
    parent?.RemoveChild?.(model);
  }

  private subscribeToManager(): void {
    this.subscriptions.push(this.manager.ActiveContentChanged.add((_sender, args) => {
      if (this.synchronizing || this.disposed) return;
      this.callbacks.onActiveContentChanged?.(args.Model?.ContentId ?? undefined);
    }));
    this.subscriptions.push(this.manager.DocumentClosing.add((_sender, args) => {
      if (this.synchronizing || this.disposed) return;
      const tabId = tabIdFromDocumentId(args.Document.ContentId);
      if (tabId && this.callbacks.onDocumentClosing && !this.callbacks.onDocumentClosing(tabId)) args.Cancel = true;
    }));
    this.subscriptions.push(this.manager.DocumentClosed.add((_sender, args) => {
      if (this.synchronizing || this.disposed) return;
      const tabId = tabIdFromDocumentId(args.Document.ContentId);
      if (tabId) this.callbacks.onDocumentClosed?.(tabId);
    }));
    this.subscriptions.push(this.manager.LayoutUpdated.add(() => {
      if (this.synchronizing || this.disposed) return;
      this.persistLayout();
    }));
    this.subscriptions.push(this.manager.Error.add((_sender, args) => {
      if (!this.disposed) this.callbacks.onError?.(errorValue(args.Error));
    }));
  }

  private persistLayout(): void {
    if (this.disposed) return;
    try {
      const snapshot = parseDockyardLayout(this.manager.SaveLayout());
      if (!snapshot) throw new Error('Dockyard returned an invalid layout snapshot.');
      const canonicalSnapshot = normalizeDockyardSnapshot(snapshot);
      saveDockyardLayout(this.storage, canonicalSnapshot);
      this.callbacks.onLayoutUpdated?.(canonicalSnapshot);
    } catch (reason: unknown) {
      this.callbacks.onError?.(errorValue(reason));
    }
  }
}
