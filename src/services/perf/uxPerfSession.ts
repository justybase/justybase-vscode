/**
 * Session-scoped UX performance probe.
 * Writes NDJSON to workspace `.cursor/ux-perf-<sessionId>.ndjson` and mirrors to Output.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  isUxPerfBudgetPhase,
  isUxPerfSlow,
  UX_PERF_CHANGE_TO_TOKENS_MAX_MS,
  UX_PERF_DOC_CHANGE_SAMPLE_EVERY,
  UX_PERF_INTER_KEY_GAP_MAX_MS,
  UX_PERF_INTER_KEY_SLOW_MS,
  UX_PERF_TYPING_BURST_IDLE_MS,
} from './uxPerfThresholds';

export type UxPerfMetaValue = string | number | boolean | null;

export interface UxPerfDocContext {
  uri?: string;
  chars?: number;
  lines?: number;
  ver?: number;
}

export interface UxPerfEmitInput {
  op: string;
  phase: string;
  traceId?: string;
  durationMs?: number;
  doc?: UxPerfDocContext;
  meta?: Record<string, UxPerfMetaValue>;
}

export interface UxPerfEvent extends UxPerfEmitInput {
  ts: string;
  sessionId: string;
  slow: boolean;
}

export interface UxPerfSessionSummary {
  sessionId: string;
  logPath: string;
  eventCount: number;
  byOp: Record<
    string,
    { count: number; maxMs: number; p95Ms: number; slowCount: number }
  >;
}

export interface UxPerfSessionStartResult {
  sessionId: string;
  logPath: string;
}

type WebviewNotifier = (active: boolean) => void;

interface TypingBurstState {
  keystrokes: number;
  interKeySum: number;
  interKeyMax: number;
  interKeySamples: number;
  chars: number;
  lines: number;
  ver: number;
  uriBasename: string;
  timer?: ReturnType<typeof setTimeout>;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function basenameFromUri(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  try {
    const parsed = vscode.Uri.parse(uri);
    const parts = parsed.fsPath.split(/[\\/]/);
    return parts[parts.length - 1] || uri;
  } catch {
    const parts = uri.split(/[\\/]/);
    return parts[parts.length - 1] || uri;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function shortId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSqlDoc(doc: vscode.TextDocument | undefined): doc is vscode.TextDocument {
  if (!doc) {
    return false;
  }
  const languageId = doc.languageId.toLowerCase();
  return languageId === 'sql' || languageId === 'netezza-sql' || languageId.includes('sql');
}

export class UxPerfSession {
  private static _instance: UxPerfSession | undefined;

  static get instance(): UxPerfSession {
    if (!this._instance) {
      this._instance = new UxPerfSession();
    }
    return this._instance;
  }

  /** Test helper */
  static resetInstanceForTests(): void {
    this._instance?.disposeInternal();
    this._instance = undefined;
  }

  private active = false;
  private sessionId = '';
  private logPath = '';
  private output: vscode.OutputChannel | undefined;
  private eventCount = 0;
  private durationsByOp = new Map<string, number[]>();
  private slowCountByOp = new Map<string, number>();
  private webviewNotifier: WebviewNotifier | undefined;
  private lastDocChangeAt = new Map<string, number>();
  private docChangeCounters = new Map<string, number>();
  private typingBursts = new Map<string, TypingBurstState>();
  private docChangeDisposable: vscode.Disposable | undefined;
  private extensionContext: vscode.ExtensionContext | undefined;

  private constructor() {}

  isActive(): boolean {
    return this.active;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getLogPath(): string | undefined {
    return this.active ? this.logPath : undefined;
  }

  setWebviewNotifier(notifier: WebviewNotifier | undefined): void {
    this.webviewNotifier = notifier;
  }

  attachExtensionContext(context: vscode.ExtensionContext): void {
    this.extensionContext = context;
  }

  startTrace(op: string): string {
    const traceId = shortId();
    if (this.active) {
      this.emit({
        op,
        phase: 'start',
        traceId,
        durationMs: 0,
      });
    }
    return traceId;
  }

  emit(input: UxPerfEmitInput): void {
    if (!this.active) {
      return;
    }

    const durationMs =
      input.durationMs === undefined ? undefined : roundMs(Math.max(0, input.durationMs));
    const event: UxPerfEvent = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      op: input.op,
      phase: input.phase,
      traceId: input.traceId,
      durationMs,
      slow: isUxPerfSlow(input.op, durationMs, input.phase),
      doc: input.doc
        ? {
            uri: input.doc.uri ? basenameFromUri(input.doc.uri) ?? input.doc.uri : undefined,
            chars: input.doc.chars,
            lines: input.doc.lines,
            ver: input.doc.ver,
          }
        : undefined,
      meta: input.meta,
    };

    this.eventCount += 1;
    if (
      durationMs !== undefined &&
      isUxPerfBudgetPhase(input.op, input.phase)
    ) {
      const list = this.durationsByOp.get(input.op) ?? [];
      list.push(durationMs);
      this.durationsByOp.set(input.op, list);
      if (event.slow) {
        this.slowCountByOp.set(input.op, (this.slowCountByOp.get(input.op) ?? 0) + 1);
      }
    }

    const line = JSON.stringify(event);
    try {
      fs.appendFileSync(this.logPath, `${line}\n`, 'utf8');
    } catch (error) {
      this.output?.appendLine(
        `[ux_perf] failed to write log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.output?.appendLine(`[ux_perf] ${line}`);
  }

  noteDocChange(document: vscode.TextDocument, charsDelta: number): void {
    if (!this.active || !isSqlDoc(document)) {
      return;
    }

    const uri = document.uri.toString();
    const now = performance.now();
    const previous = this.lastDocChangeAt.get(uri);
    const rawInterKeyMs = previous === undefined ? undefined : roundMs(now - previous);
    // Idle pauses (user stopped typing) must not look like extension lag.
    const isIdleGap =
      rawInterKeyMs !== undefined && rawInterKeyMs > UX_PERF_INTER_KEY_GAP_MAX_MS;
    const interKeyMs = isIdleGap ? undefined : rawInterKeyMs;
    this.lastDocChangeAt.set(uri, now);

    if (isIdleGap) {
      // Close the previous burst before starting a fresh one after the pause.
      this.flushTypingBurst(uri);
    }

    const count = (this.docChangeCounters.get(uri) ?? 0) + 1;
    this.docChangeCounters.set(uri, count);

    const isLarge =
      document.lineCount > 500 || document.getText().length > 150_000;
    const typingLagSample =
      interKeyMs !== undefined && interKeyMs >= UX_PERF_INTER_KEY_SLOW_MS;
    const shouldSample =
      count % UX_PERF_DOC_CHANGE_SAMPLE_EVERY === 0 || typingLagSample;

    if (shouldSample) {
      this.emit({
        op: 'editor.doc_change',
        phase: 'sample',
        durationMs: interKeyMs,
        doc: {
          uri,
          chars: document.getText().length,
          lines: document.lineCount,
          ver: document.version,
        },
        meta: {
          changeCount: count,
          charsDelta,
          isLarge,
          interKeyMs: interKeyMs ?? null,
          idleGapMs: isIdleGap ? rawInterKeyMs ?? null : null,
        },
      });
    }

    let burst = this.typingBursts.get(uri);
    if (!burst) {
      burst = {
        keystrokes: 0,
        interKeySum: 0,
        interKeyMax: 0,
        interKeySamples: 0,
        chars: document.getText().length,
        lines: document.lineCount,
        ver: document.version,
        uriBasename: basenameFromUri(uri) ?? uri,
      };
      this.typingBursts.set(uri, burst);
    }

    burst.keystrokes += 1;
    burst.chars = document.getText().length;
    burst.lines = document.lineCount;
    burst.ver = document.version;
    if (interKeyMs !== undefined) {
      burst.interKeySum += interKeyMs;
      burst.interKeyMax = Math.max(burst.interKeyMax, interKeyMs);
      burst.interKeySamples += 1;
    }

    if (burst.timer) {
      clearTimeout(burst.timer);
    }
    burst.timer = setTimeout(() => {
      this.flushTypingBurst(uri);
    }, UX_PERF_TYPING_BURST_IDLE_MS);
  }

  /**
   * Ms since last doc change, only when still within the typing-relevance window.
   * Returns undefined for idle / tab-switch / cache-refresh noise.
   */
  getRecentDocChangeMs(
    documentUri: string,
    maxMs: number = UX_PERF_CHANGE_TO_TOKENS_MAX_MS,
  ): number | undefined {
    const at = this.lastDocChangeAt.get(documentUri);
    if (at === undefined) {
      return undefined;
    }
    const elapsed = roundMs(performance.now() - at);
    if (elapsed > maxMs) {
      return undefined;
    }
    return elapsed;
  }

  /** @deprecated Prefer getRecentDocChangeMs — raw wall time includes idle pauses. */
  getMsSinceLastDocChange(documentUri: string): number | undefined {
    return this.getRecentDocChangeMs(documentUri, Number.POSITIVE_INFINITY);
  }

  docContextFromDocument(document: vscode.TextDocument): UxPerfDocContext {
    return {
      uri: document.uri.toString(),
      chars: document.getText().length,
      lines: document.lineCount,
      ver: document.version,
    };
  }

  async startSession(): Promise<UxPerfSessionStartResult> {
    if (this.active) {
      await this.stopSession();
    }

    this.sessionId = shortId();
    this.eventCount = 0;
    this.durationsByOp.clear();
    this.slowCountByOp.clear();
    this.lastDocChangeAt.clear();
    this.docChangeCounters.clear();
    this.clearTypingBursts();

    const dir = this.resolveLogDirectory();
    fs.mkdirSync(dir, { recursive: true });
    this.logPath = path.join(dir, `ux-perf-${this.sessionId}.ndjson`);
    fs.writeFileSync(this.logPath, '', 'utf8');

    if (!this.output) {
      this.output = vscode.window.createOutputChannel('JustyBase UX Perf');
    }
    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`[ux_perf] session started id=${this.sessionId} log=${this.logPath}`);

    this.active = true;
    this.ensureDocChangeListener();
    this.webviewNotifier?.(true);

    this.emit({
      op: 'session',
      phase: 'start',
      durationMs: 0,
      meta: { logPath: this.logPath },
    });

    return { sessionId: this.sessionId, logPath: this.logPath };
  }

  async stopSession(): Promise<UxPerfSessionSummary | undefined> {
    if (!this.active) {
      return undefined;
    }

    for (const uri of [...this.typingBursts.keys()]) {
      this.flushTypingBurst(uri);
    }

    const summary = this.buildSummary();
    this.emit({
      op: 'session',
      phase: 'stop',
      durationMs: 0,
      meta: {
        eventCount: summary.eventCount,
        logPath: summary.logPath,
      },
    });

    this.active = false;
    this.webviewNotifier?.(false);
    this.docChangeDisposable?.dispose();
    this.docChangeDisposable = undefined;

    this.output?.appendLine(`[ux_perf] session stopped id=${summary.sessionId}`);
    this.output?.appendLine(`[ux_perf] summary ${JSON.stringify(summary.byOp)}`);

    return summary;
  }

  async openLog(): Promise<void> {
    const logPath = this.logPath;
    if (!logPath || !fs.existsSync(logPath)) {
      void vscode.window.showWarningMessage('No UX perf log available. Start a session first.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private flushTypingBurst(uri: string): void {
    const burst = this.typingBursts.get(uri);
    if (!burst || burst.keystrokes === 0) {
      this.typingBursts.delete(uri);
      return;
    }
    if (burst.timer) {
      clearTimeout(burst.timer);
      burst.timer = undefined;
    }

    const avgInterKeyMs =
      burst.interKeySamples > 0
        ? roundMs(burst.interKeySum / burst.interKeySamples)
        : undefined;

    this.emit({
      op: 'editor.typing_burst',
      phase: 'end',
      durationMs: burst.interKeyMax || avgInterKeyMs,
      doc: {
        uri,
        chars: burst.chars,
        lines: burst.lines,
        ver: burst.ver,
      },
      meta: {
        keystrokes: burst.keystrokes,
        avgInterKeyMs: avgInterKeyMs ?? null,
        maxInterKeyMs: burst.interKeyMax,
        docChars: burst.chars,
      },
    });

    this.typingBursts.delete(uri);
  }

  private clearTypingBursts(): void {
    for (const burst of this.typingBursts.values()) {
      if (burst.timer) {
        clearTimeout(burst.timer);
      }
    }
    this.typingBursts.clear();
  }

  private ensureDocChangeListener(): void {
    if (this.docChangeDisposable) {
      return;
    }
    this.docChangeDisposable = vscode.workspace.onDidChangeTextDocument(event => {
      if (!this.active || !isSqlDoc(event.document) || event.contentChanges.length === 0) {
        return;
      }
      let charsDelta = 0;
      for (const change of event.contentChanges) {
        charsDelta += change.text.length - change.rangeLength;
      }
      this.noteDocChange(event.document, charsDelta);
    });
    this.extensionContext?.subscriptions.push(this.docChangeDisposable);
  }

  private resolveLogDirectory(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
      return path.join(folder, '.cursor');
    }
    if (this.extensionContext) {
      return path.join(this.extensionContext.globalStorageUri.fsPath, 'ux-perf');
    }
    return path.join(process.cwd(), '.cursor');
  }

  private buildSummary(): UxPerfSessionSummary {
    const byOp: UxPerfSessionSummary['byOp'] = {};
    for (const [op, durations] of this.durationsByOp.entries()) {
      byOp[op] = {
        count: durations.length,
        maxMs: roundMs(Math.max(...durations)),
        p95Ms: roundMs(percentile(durations, 95)),
        slowCount: this.slowCountByOp.get(op) ?? 0,
      };
    }
    return {
      sessionId: this.sessionId,
      logPath: this.logPath,
      eventCount: this.eventCount,
      byOp,
    };
  }

  private disposeInternal(): void {
    this.clearTypingBursts();
    this.docChangeDisposable?.dispose();
    this.docChangeDisposable = undefined;
    this.active = false;
    this.output?.dispose();
    this.output = undefined;
  }
}

export function getUxPerfSession(): UxPerfSession {
  return UxPerfSession.instance;
}
