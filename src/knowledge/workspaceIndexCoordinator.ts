/**
 * VS Code adapter for the workspace SQL index.
 *
 * Responsibilities split deliberately:
 * - selection: workspace SQL files, excludes, `.gitignore`, Git window, open/dirty files;
 * - lifecycle: watchers, debounce, branch switch, enable/disable, rebuild;
 * - publication: full snapshots and affected-key upserts to the LSP bridge.
 *
 * Parsing and aggregation live in `WorkspaceIndexEngine`; completion never
 * touches this module.
 */

import { execFile } from "node:child_process";
import { watchFile, unwatchFile } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type {
  JoinKnowledgeIndexDelta,
  WorkspaceIndexSnapshot,
  WorkspaceIndexStats,
  WorkspaceSkipReason,
} from "@justybase/sql-core/joinKnowledge";
import type { DatabaseKind } from "../contracts/database";
import {
  createIgnoreFilter,
  excludeSettingsToGlobs,
} from "../services/fileSearchService";
import {
  FileWorkspaceIndexPersistence,
} from "./workspaceIndexPersistence";
import {
  hashWorkspaceContent,
  WorkspaceIndexEngine,
  type WorkspaceFileInput,
  type WorkspaceIndexGitMode,
} from "./workspaceIndexEngine";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.eggs/**",
];

export interface WorkspaceIndexLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface WorkspaceIndexGitInfo {
  mode: WorkspaceIndexGitMode;
  head?: string;
  windowDays: number;
  dirtyFiles: Set<string>;
  untrackedFiles: Set<string>;
  windowFiles: Set<string>;
  headPaths: string[];
}

export interface WorkspaceIndexStatus {
  enabled: boolean;
  running: boolean;
  filesSelected: number;
  filesIndexed: number;
  relations: WorkspaceIndexStats["relations"];
  objects: WorkspaceIndexStats["objects"];
  /** Eligible column usage published for column ordering. */
  columns?: WorkspaceIndexStats["columns"];
  skipped: Partial<Record<WorkspaceSkipReason, number>>;
  truncated: boolean;
  truncationReasons: string[];
  git: {
    mode: WorkspaceIndexGitMode | "disabled";
    windowDays: number;
    head?: string;
    dirty: number;
    untracked: number;
    open: number;
  };
  lastIndexedAt?: string;
  lastError?: string;
}

export interface WorkspaceIndexCoordinatorOptions {
  storageRoot: string;
  logger?: WorkspaceIndexLogger;
  now?: () => string;
  databaseKind?: DatabaseKind;
  /** Called with no delta for a full snapshot and with a delta for an upsert. */
  onDidChangeIndex?: (delta?: JoinKnowledgeIndexDelta) => void;
}

interface WorkspaceFileCandidate {
  uri: vscode.Uri;
  relPath: string;
  priority: number;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

function readExcludeGlobs(): string[] {
  const filesExclude = vscode.workspace
    .getConfiguration("files")
    .get<Record<string, unknown>>("exclude");
  const searchExclude = vscode.workspace
    .getConfiguration("search")
    .get<Record<string, unknown>>("exclude");
  return excludeSettingsToGlobs(filesExclude, searchExclude);
}

function buildExcludeGlob(): string {
  const extra = readExcludeGlobs().flatMap((value) => {
    const normalized = normalizeSlashes(value).replace(/\/$/u, "/**");
    return normalized.endsWith("/**")
      ? [normalized]
      : [normalized, `${normalized}/**`];
  });
  return `{${[...DEFAULT_EXCLUDES, ...extra].join(",")}}`;
}

async function loadGitignoreFilter(
  excludeGlob: string,
): Promise<(relPath: string) => boolean> {
  try {
    const uris = await vscode.workspace.findFiles("**/.gitignore", excludeGlob);
    const entries = await Promise.all(uris.map(async (uri) => {
      const dir = normalizeSlashes(vscode.workspace.asRelativePath(uri, true))
        .replace(/\/?\.gitignore$/u, "");
      const content = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(uri),
      );
      return { dir, content };
    }));
    const filter = createIgnoreFilter(entries);
    return (relPath) => filter(normalizeSlashes(relPath));
  } catch {
    return () => false;
  }
}

function folderPrefix(folder: vscode.WorkspaceFolder): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 1 ? `${folder.name}/` : "";
}

function gitPathToRelPath(folder: vscode.WorkspaceFolder, gitPath: string): string {
  return normalizeSlashes(
    `${folderPrefix(folder)}${gitPath.replace(/^\.\//u, "")}`,
  );
}

async function runGit(
  folder: vscode.WorkspaceFolder,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: folder.uri.fsPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Parse `git status --porcelain=v1 -z` including rename records. */
export function parseGitStatusPorcelainZ(
  output: string,
): Array<{ path: string; status: string }> {
  const chunks = output.split("\u0000");
  const result: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) {
      continue;
    }
    const status = chunk.slice(0, 2);
    let filePath = chunk.length > 3 ? chunk.slice(3) : "";
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1;
      filePath = chunks[index] ?? filePath;
    }
    if (filePath) {
      result.push({ path: filePath, status });
    }
  }
  return result;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * Git is a file-selection shortcut only. Open, dirty and untracked files are
 * always included; `all`/`unavailable` select every workspace SQL file.
 */
export function isWorkspaceFileSelected(input: {
  open: boolean;
  dirty: boolean;
  untracked: boolean;
  inWindow: boolean;
  gitMode: WorkspaceIndexGitMode;
}): boolean {
  if (input.gitMode === "all" || input.gitMode === "unavailable") {
    return true;
  }
  return input.open || input.dirty || input.untracked || input.inWindow;
}

export class WorkspaceIndexCoordinator {
  private readonly persistence: FileWorkspaceIndexPersistence;
  private readonly engine: WorkspaceIndexEngine;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fileTimers = new Map<string, NodeJS.Timeout>();
  private readonly headPaths = new Set<string>();
  private readonly changeListeners = new Set<() => void>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private documentTimer: NodeJS.Timeout | undefined;
  private enabled = false;
  private running = false;
  private pendingRefresh = false;
  private cancelRequested = false;
  private disposed = false;
  private initialized = false;
  private filesSelected = 0;
  private truncationReasons: string[] = [];
  private lastIndexedAt: string | undefined;
  private lastError: string | undefined;
  private gitMode: WorkspaceIndexGitMode | "disabled" = "disabled";
  private gitWindowDays = 365;
  private gitHead: string | undefined;
  private gitDirty = 0;
  private gitUntracked = 0;
  private openCount = 0;

  constructor(
    private readonly options: WorkspaceIndexCoordinatorOptions,
  ) {
    this.persistence = new FileWorkspaceIndexPersistence(options.storageRoot);
    this.engine = new WorkspaceIndexEngine({
      databaseKind: options.databaseKind,
      now: options.now,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxFiles: MAX_FILES,
      checkpointEvery: 1,
      isCancelled: () => this.cancelRequested || this.disposed,
      onCheckpoint: async (state) => {
        await this.persistence.save(state);
      },
      onProgress: undefined,
    });
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const state = await this.persistence.load(this.options.databaseKind);
    this.engine.load(state);
    this.gitMode = state.gitMode ?? "disabled";
    this.gitHead = state.head;
  }

  public getSnapshot(): WorkspaceIndexSnapshot | undefined {
    if (!this.enabled) {
      return {
        version: 1,
        relations: [],
        objects: [],
        truncated: false,
        generatedAt: this.now(),
      };
    }
    return this.engine.getSnapshot();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getStatus(): WorkspaceIndexStatus {
    const stats = this.engine.getStats();
    return {
      enabled: this.enabled,
      running: this.running,
      filesSelected: this.filesSelected,
      filesIndexed: this.engine.getFileCount(),
      relations: stats.relations,
      objects: stats.objects,
      columns: stats.columns,
      skipped: stats.skipped,
      truncated: this.truncationReasons.length > 0
        || this.engine.getSnapshot().truncated,
      truncationReasons: [...this.truncationReasons],
      git: {
        mode: this.gitMode,
        windowDays: this.gitWindowDays,
        ...(this.gitHead ? { head: this.gitHead } : {}),
        dirty: this.gitDirty,
        untracked: this.gitUntracked,
        open: this.openCount,
      },
      ...(this.lastIndexedAt ? { lastIndexedAt: this.lastIndexedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  public async reloadConfiguration(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("justybase.sql");
    const nextEnabled = configuration.get<boolean>("joinKnowledgeIndex", false);
    this.gitWindowDays = Math.max(
      0,
      configuration.get<number>("joinKnowledgeIndexGitWindowDays", 365),
    );
    if (nextEnabled === this.enabled) {
      if (nextEnabled) {
        await this.refresh({ reason: "configuration" });
      }
      return;
    }
    this.enabled = nextEnabled;
    if (!nextEnabled) {
      this.cancelRequested = true;
      this.publishFull();
      return;
    }
    await this.initialize();
    this.startWatchers();
    await this.refresh({ reason: "enable" });
  }

  public async start(): Promise<void> {
    await this.initialize();
    const configuration = vscode.workspace.getConfiguration("justybase.sql");
    this.gitWindowDays = Math.max(
      0,
      configuration.get<number>("joinKnowledgeIndexGitWindowDays", 365),
    );
    this.enabled = configuration.get<boolean>("joinKnowledgeIndex", false);
    // Configuration listeners must exist even while disabled so enabling the
    // setting starts indexing without a window reload.
    this.startWatchers();
    if (!this.enabled) {
      this.publishFull();
      return;
    }
    await this.refresh({ reason: "start" });
  }

  public async rebuild(): Promise<WorkspaceIndexStatus> {
    if (!this.enabled) {
      throw new Error(
        "Workspace JOIN indexing is disabled. Enable `justybase.sql.joinKnowledgeIndex` first.",
      );
    }
    await this.cancelAndWait();
    await this.engine.clear({ keepSalt: true });
    await this.refresh({ reason: "rebuild" });
    return this.getStatus();
  }

  public cancel(): void {
    this.cancelRequested = true;
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelRequested = true;
    this.stopWatchers();
    if (this.documentTimer) {
      clearTimeout(this.documentTimer);
      this.documentTimer = undefined;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const timer of this.fileTimers.values()) {
      clearTimeout(timer);
    }
    this.fileTimers.clear();
    for (const headPath of this.headPaths) {
      unwatchFile(headPath);
    }
    this.headPaths.clear();
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private async cancelAndWait(): Promise<void> {
    this.cancelRequested = true;
    for (let attempt = 0; attempt < 100 && this.running; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    this.cancelRequested = false;
  }

  private startWatchers(): void {
    if (this.disposables.length > 0) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.sql");
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => this.scheduleFile(uri, "change")),
      watcher.onDidCreate((uri) => this.scheduleFile(uri, "change")),
      watcher.onDidDelete((uri) => this.scheduleFile(uri, "delete")),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === "sql") {
          this.scheduleOpenDocument(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId === "sql") {
          this.scheduleOpenDocument(document, 0);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.languageId === "sql") {
          this.scheduleOpenDocument(document, 0);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleRefresh("workspace-folders");
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("justybase.sql.joinKnowledgeIndex")
          || event.affectsConfiguration("justybase.sql.joinKnowledgeIndexGitWindowDays")
        ) {
          void this.reloadConfiguration();
        }
      }),
    );
  }

  private stopWatchers(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    for (const headPath of this.headPaths) {
      unwatchFile(headPath);
    }
    this.headPaths.clear();
  }

  private scheduleRefresh(reason: string, delay = 500): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh({ reason });
    }, delay);
  }

  private scheduleFile(uri: vscode.Uri, kind: "change" | "delete"): void {
    if (!this.enabled || this.disposed || uri.scheme !== "file") {
      return;
    }
    const relPath = normalizeSlashes(vscode.workspace.asRelativePath(uri, true));
    const existing = this.fileTimers.get(relPath);
    if (existing) {
      clearTimeout(existing);
    }
    this.fileTimers.set(relPath, setTimeout(() => {
      this.fileTimers.delete(relPath);
      if (kind === "delete") {
        void this.removeFile(relPath);
      } else {
        void this.indexFile(uri, relPath);
      }
    }, 300));
  }

  private scheduleOpenDocument(document: vscode.TextDocument, delay = 750): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    if (document.uri.scheme !== "file") {
      return;
    }
    if (this.documentTimer) {
      clearTimeout(this.documentTimer);
    }
    this.documentTimer = setTimeout(() => {
      this.documentTimer = undefined;
      void this.indexDocument(document);
    }, delay);
  }

  private async indexDocument(document: vscode.TextDocument): Promise<void> {
    if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
      return;
    }
    const relPath = normalizeSlashes(
      vscode.workspace.asRelativePath(document.uri, true),
    );
    if (document.isClosed) {
      const input = await this.buildDiskInput(document.uri, relPath);
      if (input) {
        const mutation = await this.engine.indexFile(input);
        this.publishDelta(mutation.delta);
      } else {
        this.publishDelta(await this.engine.removeFile(relPath));
      }
      return;
    }
    const text = document.getText();
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_FILE_BYTES) {
      this.truncationReasons = uniqueSorted([
        ...this.truncationReasons,
        `file-too-large:${relPath}`,
      ]);
      this.publishDelta(await this.engine.removeFile(relPath));
      return;
    }
    const input: WorkspaceFileInput = {
      relPath,
      size,
      mtimeMs: 0,
      dirty: document.isDirty,
      open: true,
      contentHash: hashWorkspaceContent(text),
      loadText: () => text,
    };
    const mutation = await this.engine.indexFile(input);
    this.publishDelta(mutation.delta);
  }

  private async indexFile(uri: vscode.Uri, relPath: string): Promise<void> {
    try {
      const openDocument = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === uri.toString(),
      );
      if (openDocument) {
        await this.indexDocument(openDocument);
        return;
      }
      const input = await this.buildDiskInput(uri, relPath);
      if (!input) {
        this.publishDelta(await this.engine.removeFile(relPath));
        return;
      }
      const mutation = await this.engine.indexFile(input);
      this.publishDelta(mutation.delta);
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(
        `Workspace JOIN index could not parse ${relPath}: ${this.lastError}`,
      );
    }
  }

  private async removeFile(relPath: string): Promise<void> {
    try {
      this.publishDelta(await this.engine.removeFile(relPath));
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(
        `Workspace JOIN index could not remove ${relPath}: ${this.lastError}`,
      );
    }
  }

  private async buildDiskInput(
    uri: vscode.Uri,
    relPath: string,
  ): Promise<WorkspaceFileInput | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        this.truncationReasons = uniqueSorted([
          ...this.truncationReasons,
          `file-too-large:${relPath}`,
        ]);
        return undefined;
      }
      return {
        relPath,
        size: stat.size,
        mtimeMs: stat.mtime,
        dirty: false,
        open: false,
        loadText: async () => {
          const bytes = await vscode.workspace.fs.readFile(uri);
          return new TextDecoder().decode(bytes);
        },
      };
    } catch {
      return undefined;
    }
  }

  private async refresh(options: { reason: string }): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    if (this.running) {
      this.pendingRefresh = true;
      return;
    }
    this.running = true;
    this.cancelRequested = false;
    try {
      const selection = await this.collectWorkspaceFiles();
      this.filesSelected = selection.inputs.length;
      this.truncationReasons = selection.truncationReasons;
      this.gitMode = selection.gitMode;
      this.gitHead = selection.gitHead;
      this.gitWindowDays = selection.windowDays;
      this.gitDirty = selection.dirtyCount;
      this.gitUntracked = selection.untrackedCount;
      this.openCount = selection.openCount;
      this.engine.setGitState({
        head: selection.gitHead,
        truncated: selection.truncationReasons.length > 0,
        gitMode: selection.gitMode,
      });
      this.watchGitHeads(selection.headPaths);
      await this.engine.reconcile(selection.inputs, {
        head: selection.gitHead,
        truncated: selection.truncationReasons.length > 0,
        gitMode: selection.gitMode,
      });
      this.lastIndexedAt = this.now();
      this.lastError = undefined;
      this.publishFull();
      this.options.logger?.info(
        `Workspace JOIN index ${options.reason}: ${selection.inputs.length} file(s), `
        + `${this.engine.getStats().relations.eligible} eligible relation(s), `
        + `${this.engine.getStats().objects.eligible} eligible object(s).`,
      );
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(
        `Workspace JOIN index failed: ${this.lastError}`,
      );
    } finally {
      this.running = false;
      if (this.pendingRefresh && this.enabled && !this.disposed) {
        this.pendingRefresh = false;
        this.scheduleRefresh("queued", 0);
      }
    }
  }

  /** Manager UI subscription; fires for every snapshot or delta publication. */
  public onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  /** Remove observed workspace evidence for one relation (manual decisions stay). */
  public async deleteRelationEvidence(
    relationKey: string,
  ): Promise<JoinKnowledgeIndexDelta> {
    const delta = await this.engine.deleteRelationEvidence(relationKey);
    this.publishDelta(delta);
    return delta;
  }

  /** Remove observed workspace usage for one FROM object (manual decisions stay). */
  public async deleteObjectEvidence(
    objectKey: string,
  ): Promise<JoinKnowledgeIndexDelta> {
    const delta = await this.engine.deleteObjectEvidence(objectKey);
    this.publishDelta(delta);
    return delta;
  }

  private publishFull(): void {
    this.options.onDidChangeIndex?.();
    this.notifyChange();
  }

  private publishDelta(delta: JoinKnowledgeIndexDelta): void {
    this.options.onDidChangeIndex?.(delta);
    this.notifyChange();
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // A broken manager listener must not stop LSP publication.
      }
    }
  }

  private watchGitHeads(headPaths: readonly string[]): void {
    const next = new Set(headPaths);
    for (const headPath of this.headPaths) {
      if (!next.has(headPath)) {
        unwatchFile(headPath);
        this.headPaths.delete(headPath);
      }
    }
    for (const headPath of next) {
      if (this.headPaths.has(headPath)) {
        continue;
      }
      this.headPaths.add(headPath);
      watchFile(headPath, { interval: 2000 }, (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs) {
          this.scheduleRefresh("git-head", 250);
        }
      });
    }
  }

  private async collectWorkspaceFiles(): Promise<{
    inputs: WorkspaceFileInput[];
    truncationReasons: string[];
    gitMode: WorkspaceIndexGitMode;
    gitHead?: string;
    windowDays: number;
    headPaths: string[];
    dirtyCount: number;
    untrackedCount: number;
    openCount: number;
  }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return {
        inputs: [],
        truncationReasons: [],
        gitMode: "unavailable",
        windowDays: this.gitWindowDays,
        headPaths: [],
        dirtyCount: 0,
        untrackedCount: 0,
        openCount: 0,
      };
    }
    const excludeGlob = buildExcludeGlob();
    const ignored = await loadGitignoreFilter(excludeGlob);
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles("**/*.sql", excludeGlob);
    } catch (error: unknown) {
      this.options.logger?.warn(
        `Workspace JOIN index could not list SQL files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const openDocuments = new Map<string, vscode.TextDocument>();
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.languageId !== "sql"
        || document.uri.scheme !== "file"
        || !vscode.workspace.getWorkspaceFolder(document.uri)
      ) {
        continue;
      }
      const relPath = normalizeSlashes(
        vscode.workspace.asRelativePath(document.uri, true),
      );
      openDocuments.set(relPath, document);
    }
    const byRelPath = new Map<string, vscode.Uri>();
    for (const uri of uris) {
      const relPath = normalizeSlashes(vscode.workspace.asRelativePath(uri, true));
      if (!ignored(relPath)) {
        byRelPath.set(relPath, uri);
      }
    }
    for (const [relPath, document] of openDocuments) {
      if (!ignored(relPath) && !byRelPath.has(relPath)) {
        byRelPath.set(relPath, document.uri);
      }
    }

    const dirty = new Set<string>();
    const untracked = new Set<string>();
    const windowFiles = new Set<string>();
    let gitMode: WorkspaceIndexGitMode = "window";
    let gitHead: string | undefined;
    const headPaths: string[] = [];
    for (const folder of folders) {
      const info = await this.collectGitSelection(folder);
      if (info.mode === "unavailable") {
        gitMode = "unavailable";
      } else if (info.mode === "all" && gitMode !== "unavailable") {
        gitMode = "all";
      }
      gitHead ??= info.head;
      for (const file of info.dirtyFiles) {
        dirty.add(file);
      }
      for (const file of info.untrackedFiles) {
        untracked.add(file);
      }
      for (const file of info.windowFiles) {
        windowFiles.add(file);
      }
      headPaths.push(...info.headPaths);
    }

    const candidates: WorkspaceFileCandidate[] = [];
    for (const [relPath, uri] of byRelPath) {
      if (ignored(relPath)) {
        continue;
      }
      const isOpen = openDocuments.has(relPath);
      const isDirty = dirty.has(relPath);
      const isUntracked = untracked.has(relPath);
      const inWindow = windowFiles.has(relPath);
      if (!isWorkspaceFileSelected({
        open: isOpen,
        dirty: isDirty,
        untracked: isUntracked,
        inWindow,
        gitMode,
      })) {
        continue;
      }
      const priority = isOpen ? 0 : isDirty || isUntracked ? 1 : inWindow ? 2 : 3;
      candidates.push({ uri, relPath, priority });
    }
    candidates.sort((left, right) =>
      left.priority - right.priority
      || left.relPath.localeCompare(right.relPath, "en"),
    );

    const truncationReasons: string[] = [];
    const inputs: WorkspaceFileInput[] = [];
    const mtimeCutoff = gitMode === "unavailable" && this.gitWindowDays > 0
      ? Date.now() - this.gitWindowDays * 24 * 60 * 60 * 1000
      : undefined;
    let totalBytes = 0;
    for (const candidate of candidates) {
      if (inputs.length >= MAX_FILES) {
        truncationReasons.push(`file-cap:${MAX_FILES}`);
        break;
      }
      const openDocument = openDocuments.get(candidate.relPath);
      if (openDocument) {
        const text = openDocument.getText();
        const size = Buffer.byteLength(text, "utf8");
        if (size > MAX_FILE_BYTES) {
          truncationReasons.push(`file-too-large:${candidate.relPath}`);
          continue;
        }
        if (totalBytes + size > MAX_TOTAL_BYTES) {
          truncationReasons.push(`byte-cap:${MAX_TOTAL_BYTES}`);
          break;
        }
        totalBytes += size;
        inputs.push({
          relPath: candidate.relPath,
          size,
          mtimeMs: 0,
          dirty: openDocument.isDirty,
          open: true,
          contentHash: hashWorkspaceContent(text),
          loadText: () => text,
        });
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(candidate.uri);
        if (mtimeCutoff !== undefined && stat.mtime < mtimeCutoff) {
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) {
          truncationReasons.push(`file-too-large:${candidate.relPath}`);
          continue;
        }
        if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
          truncationReasons.push(`byte-cap:${MAX_TOTAL_BYTES}`);
          break;
        }
        totalBytes += stat.size;
        inputs.push({
          relPath: candidate.relPath,
          size: stat.size,
          mtimeMs: stat.mtime,
          dirty: false,
          open: false,
          loadText: async () => {
            const bytes = await vscode.workspace.fs.readFile(candidate.uri);
            return new TextDecoder().decode(bytes);
          },
        });
      } catch {
        // The file disappeared between listing and stat; reconcile removes any
        // stale record because it is absent from `inputs`.
      }
    }

    return {
      inputs,
      truncationReasons: uniqueSorted(truncationReasons),
      gitMode,
      ...(gitHead ? { gitHead } : {}),
      windowDays: this.gitWindowDays,
      headPaths: uniqueSorted(headPaths),
      dirtyCount: dirty.size,
      untrackedCount: untracked.size,
      openCount: openDocuments.size,
    };
  }

  private async collectGitSelection(
    folder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceIndexGitInfo> {
    const head = (await runGit(folder, ["rev-parse", "HEAD"]))?.trim();
    if (!head) {
      return {
        mode: "unavailable",
        windowDays: this.gitWindowDays,
        dirtyFiles: new Set(),
        untrackedFiles: new Set(),
        windowFiles: new Set(),
        headPaths: [],
      };
    }
    const statusOutput = await runGit(folder, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--relative",
      "--",
      "*.sql",
    ]);
    const dirtyFiles = new Set<string>();
    const untrackedFiles = new Set<string>();
    for (const entry of parseGitStatusPorcelainZ(statusOutput ?? "")) {
      const relPath = gitPathToRelPath(folder, entry.path);
      if (entry.status.includes("?")) {
        untrackedFiles.add(relPath);
      } else {
        dirtyFiles.add(relPath);
      }
    }
    let windowFiles = new Set<string>();
    let mode: WorkspaceIndexGitMode = "window";
    if (this.gitWindowDays <= 0) {
      mode = "all";
    } else {
      const logOutput = await runGit(folder, [
        "log",
        `--since=${this.gitWindowDays} days ago`,
        "--name-only",
        "--pretty=format:",
        "--relative",
        "--",
        "*.sql",
      ]);
      if (logOutput === undefined) {
        return {
          mode: "unavailable",
          windowDays: this.gitWindowDays,
          dirtyFiles,
          untrackedFiles,
          windowFiles: new Set(),
          headPaths: [],
        };
      }
      windowFiles = new Set(
        logOutput
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => gitPathToRelPath(folder, line)),
      );
    }
    const headPathOutput = await runGit(folder, ["rev-parse", "--git-path", "HEAD"]);
    const headPath = headPathOutput?.trim()
      ? path.resolve(folder.uri.fsPath, headPathOutput.trim())
      : path.join(folder.uri.fsPath, ".git", "HEAD");
    return {
      mode,
      head,
      windowDays: this.gitWindowDays,
      dirtyFiles,
      untrackedFiles,
      windowFiles,
      headPaths: [headPath],
    };
  }
}
