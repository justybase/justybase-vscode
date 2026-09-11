type Listener<T> = (sender: unknown, args: T) => void;

class TestEvent<T> {
  private readonly listeners = new Set<Listener<T>>();

  public add(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(sender: unknown, args: T): void {
    for (const listener of this.listeners) listener(sender, args);
  }

  public clear(): void {
    this.listeners.clear();
  }
}

class TestCollection<T extends TestElement> {
  private readonly items: T[] = [];
  public constructor(private readonly owner: TestElement) {}
  public get length(): number { return this.items.length; }
  public get Count(): number { return this.items.length; }
  public [Symbol.iterator](): Iterator<T> { return this.items[Symbol.iterator](); }
  public Add(item: T): void { this.Insert(this.items.length, item); }
  public AddRange(items: Iterable<T>): void { for (const item of items) this.Add(item); }
  public Insert(index: number, item: T): void {
    item.Parent = this.owner;
    this.items.splice(Math.max(0, Math.min(index, this.items.length)), 0, item);
  }
  public Remove(item: T): boolean {
    const index = this.items.indexOf(item);
    if (index < 0) return false;
    this.items.splice(index, 1);
    item.Parent = null;
    return true;
  }
  public RemoveAt(index: number): T | undefined {
    const item = this.items[index];
    if (item) this.Remove(item);
    return item;
  }
  public Contains(item: T): boolean { return this.items.includes(item); }
  public IndexOf(item: T): number { return this.items.indexOf(item); }
  public Clear(): void { for (const item of [...this.items]) this.Remove(item); }
  public ToArray(): T[] { return [...this.items]; }
}

class TestElement {
  public Id = '';
  public Parent: TestElement | null = null;
  public constructor(options: Record<string, unknown> = {}) {
    this.Id = typeof options.Id === 'string' ? options.Id : `test-${Math.random().toString(36).slice(2)}`;
  }
  public get Root(): LayoutRoot | null {
    if (this instanceof LayoutRoot) return this;
    let current: TestElement | null = this.Parent;
    while (current && !(current instanceof LayoutRoot)) current = current.Parent;
    return current as LayoutRoot | null;
  }
  public Descendents(): Iterable<TestElement> { return []; }
}

class TestGroup extends TestElement {
  public readonly Children: TestCollection<TestElement>;
  public constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.Children = new TestCollection(this);
    const children = options.Children;
    if (children && typeof children !== 'string' && Symbol.iterator in Object(children)) this.Children.AddRange(children as Iterable<TestElement>);
  }
  public get ChildrenCount(): number { return this.Children.Count; }
  public IndexOf(item: TestElement): number { return this.Children.IndexOf(item); }
  public RemoveChild(item: TestElement): boolean { return this.Children.Remove(item); }
  public Descendents(): Iterable<TestElement> {
    const result: TestElement[] = [];
    for (const child of this.Children) result.push(child, ...child.Descendents());
    return result;
  }
}

export class LayoutContent extends TestElement {
  public ContentId: string | null = null;
  public Content: unknown = null;
  public Title = '';
  public IsModified = false;
  public CanClose = true;
  public CanFloat = true;
  public CanMove = true;
  public CanDock = true;
  public CanHide = true;
  public CanAutoHide = true;
  public IsSelected = false;
  public IsActive = false;
  public constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.ContentId = typeof options.ContentId === 'string' ? options.ContentId : this.Id;
    this.Content = options.Content;
    this.Title = typeof options.Title === 'string' ? options.Title : '';
    this.IsModified = options.IsModified === true;
    this.CanClose = options.CanClose !== false;
    this.CanFloat = options.CanFloat !== false;
    this.CanMove = options.CanMove !== false;
    this.CanDock = options.CanDock !== false;
  }
}

export class LayoutDocument extends LayoutContent {}
export class LayoutAnchorable extends LayoutContent {}

export class LayoutGroup extends TestGroup {}
export class LayoutDocumentPane extends LayoutGroup {}
export class LayoutAnchorablePane extends LayoutGroup {}
export class LayoutDocumentPaneGroup extends LayoutGroup {}
export class LayoutAnchorablePaneGroup extends LayoutGroup {}
export class LayoutAnchorSide extends LayoutGroup {}
export class LayoutAnchorGroup extends LayoutGroup {}
export class LayoutFloatingWindow extends LayoutGroup {}
export class LayoutDocumentFloatingWindow extends LayoutFloatingWindow {}
export class LayoutAnchorableFloatingWindow extends LayoutFloatingWindow {}
export class LayoutPanel extends LayoutGroup {}

export class LayoutRoot extends TestElement {
  public RootPanel: LayoutPanel;
  public readonly FloatingWindows = new TestCollection<TestElement>(this);
  public readonly Hidden = new TestCollection<LayoutAnchorable>(this);
  public constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.RootPanel = options.RootPanel instanceof LayoutPanel ? options.RootPanel : new LayoutPanel();
    this.RootPanel.Parent = this;
  }
  public get Children(): Iterable<TestElement> { return [this.RootPanel, ...this.FloatingWindows, ...this.Hidden]; }
  public Descendents(): Iterable<TestElement> {
    const result: TestElement[] = [this.RootPanel, ...this.RootPanel.Descendents()];
    for (const floating of this.FloatingWindows) result.push(floating, ...floating.Descendents());
    for (const hidden of this.Hidden) result.push(hidden);
    return result;
  }
  public RemoveChild(item: TestElement): boolean {
    if (item === this.RootPanel) return false;
    if (this.FloatingWindows.Remove(item)) return true;
    return this.Hidden.Remove(item as LayoutAnchorable);
  }
  public CollectGarbage(): void {}
}

export function contents(root: LayoutElement): LayoutContent[] {
  return [root, ...root.Descendents()].filter((item): item is LayoutContent => item instanceof LayoutContent);
}

export type LayoutElement = TestElement;

interface ManagerOptions {
  Layout?: LayoutRoot;
}

export class DockingManager {
  public readonly ActiveContentChanged = new TestEvent<{ Model: LayoutContent | null }>();
  public readonly DocumentClosing = new TestEvent<{ Document: LayoutDocument; Cancel: boolean }>();
  public readonly DocumentClosed = new TestEvent<{ Document: LayoutDocument }>();
  public readonly LayoutUpdated = new TestEvent<Record<string, never>>();
  public readonly Error = new TestEvent<{ Error: Error }>();
  public Layout: LayoutRoot;
  public readonly Host: HTMLElement | null;
  public constructor(host: HTMLElement, options: ManagerOptions = {}) {
    this.Host = host;
    this.Layout = options.Layout ?? new LayoutRoot({ RootPanel: new LayoutPanel({ Children: [new LayoutDocumentPane()] }) });
  }
  public BeginUpdate(): { Dispose(): void } { return { Dispose: () => undefined }; }
  public Find(contentId: string): LayoutContent | null { return contents(this.Layout).find(item => item.ContentId === contentId) ?? null; }
  public AddDocument(document: LayoutDocument, pane?: LayoutDocumentPane | null): LayoutDocument {
    const target = pane ?? [...this.Layout.RootPanel.Descendents()].find(item => item instanceof LayoutDocumentPane) as LayoutDocumentPane | undefined;
    (target ?? this.ensureDocumentPane()).Children.Add(document);
    this.Activate(document);
    return document;
  }
  public AddAnchorable(anchorable: LayoutAnchorable): LayoutAnchorable {
    this.ensureAnchorablePane().Children.Add(anchorable);
    this.Activate(anchorable);
    return anchorable;
  }
  public Activate(value: LayoutContent | string | null): boolean {
    const model = typeof value === 'string' ? this.Find(value) : value;
    if (!model) return false;
    for (const item of contents(this.Layout)) item.IsActive = item === model;
    this.ActiveContentChanged.emit(this, { Model: model });
    return true;
  }
  public Close(model: LayoutContent): boolean {
    if (!model.CanClose) return false;
    const args = { Document: model as LayoutDocument, Cancel: false };
    if (model instanceof LayoutDocument) this.DocumentClosing.emit(this, args);
    if (args.Cancel) return false;
    if (model.Parent instanceof TestGroup) model.Parent.RemoveChild(model);
    else model.Root?.RemoveChild(model);
    if (model instanceof LayoutDocument) this.DocumentClosed.emit(this, { Document: model });
    return true;
  }
  public ReleaseContent(contentId: string): boolean { void contentId; return true; }
  public Float(model: LayoutContent): object { void model; return {}; }
  public Dock(model: LayoutContent): boolean { void model; return true; }
  public Hide(model: LayoutAnchorable): boolean { void model; return true; }
  public Show(model: LayoutAnchorable): boolean { void model; return true; }
  public ToggleAutoHide(model: LayoutAnchorable): boolean { void model; return true; }
  public SaveLayout(): string { return JSON.stringify({ format: 'avalondock-web', version: 1, layout: { type: 'LayoutRoot', props: { Id: this.Layout.Id }, rootPanel: { type: 'LayoutPanel', props: { Id: this.Layout.RootPanel.Id } } } }); }
  public LoadLayout(snapshot: unknown): LayoutRoot { void snapshot; return this.Layout; }
  public Dispose(): void { this.ActiveContentChanged.clear(); this.DocumentClosing.clear(); this.DocumentClosed.clear(); this.LayoutUpdated.clear(); this.Error.clear(); }
  private ensureDocumentPane(): LayoutDocumentPane {
    const pane = new LayoutDocumentPane();
    this.Layout.RootPanel.Children.Add(pane);
    return pane;
  }
  private ensureAnchorablePane(): LayoutAnchorablePane {
    const pane = [...this.Layout.RootPanel.Descendents()].find(item => item instanceof LayoutAnchorablePane) as LayoutAnchorablePane | undefined;
    if (pane) return pane;
    const next = new LayoutAnchorablePane();
    this.Layout.RootPanel.Children.Add(next);
    return next;
  }
}
