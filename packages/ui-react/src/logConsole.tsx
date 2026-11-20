import { useEffect, useRef, type ReactNode } from 'react';
import { compactSqlErrorMessage } from '@justybase/ui-core';
import type { DataGridColumn } from './dataGridTypes';

export interface LogConsoleProps {
  readonly rows: readonly (readonly unknown[])[];
  readonly columns?: readonly DataGridColumn[];
  readonly emptyLabel?: string;
}

type LogLineKind = 'info' | 'error' | 'warning' | 'success' | 'separator' | 'empty' | 'running' | 'cancelled' | 'retrying';
type RunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'retrying';

interface ParsedRunMessage {
  readonly status: RunStatus;
  readonly sqlPreview?: string;
  readonly connection?: string;
  readonly duration?: string;
  readonly rowCount?: string;
  readonly errorText?: string;
}

const STATUS_ICONS: Record<RunStatus, string> = {
  running: '▶',
  success: '✓',
  error: '✗',
  cancelled: '⊘',
  retrying: '↻',
};

const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'RUNNING',
  success: 'SUCCESS',
  error: 'ERROR',
  cancelled: 'CANCELLED',
  retrying: 'RETRYING',
};

const STATUS_PREFIX_RE = /^[▶✓✗⊘↻]\s+(\w+):\s*/u;
const DURATION_RE = /^(\d+\s*ms|\d+(\.\d+)?\s*s|\d+\s*m\s*\d+\s*s)$/iu;
const ROW_COUNT_RE = /^\d[\d\s,]*\s+rows?$/iu;
const LABEL_TO_STATUS: Record<string, RunStatus> = {
  running: 'running',
  success: 'success',
  error: 'error',
  cancelled: 'cancelled',
  retrying: 'retrying',
};

function messageKind(message: string): LogLineKind {
  if (message.trim() === '') return 'empty';
  if (message.startsWith('---')) return 'separator';
  if (/\b(error|failed|failure|fatal|exception)\b/iu.test(message)) return 'error';
  if (/\b(warn|warning)\b/iu.test(message)) return 'warning';
  if (/\b(success|succeeded|completed|done|ok)\b/iu.test(message)) return 'success';
  return 'info';
}

/** Mirrors the legacy `STATUS: sql | conn | duration | rows | error` parser. */
export function parseRunLogMessage(message: string): ParsedRunMessage | undefined {
  const match = message.match(STATUS_PREFIX_RE);
  if (!match) return undefined;
  const status = LABEL_TO_STATUS[match[1]?.toLocaleLowerCase() ?? ''];
  if (!status) return undefined;
  const rest = message.slice(match[0].length);
  const parts = rest.split(' | ');
  const parsed: { status: RunStatus; sqlPreview?: string; connection?: string; duration?: string; rowCount?: string; errorText?: string } = {
    status,
    sqlPreview: parts[0]?.trim() || undefined,
  };
  const leftovers: string[] = [];
  for (const part of parts.slice(1)) {
    const text = part.trim();
    if (!text) continue;
    if (parsed.duration === undefined && DURATION_RE.test(text)) { parsed.duration = text; continue; }
    if (parsed.rowCount === undefined && ROW_COUNT_RE.test(text)) { parsed.rowCount = text; continue; }
    if (parsed.connection === undefined) { parsed.connection = text; continue; }
    leftovers.push(text);
  }
  if (leftovers.length > 0) parsed.errorText = leftovers.join(' | ');
  return parsed;
}

function columnIndex(columns: readonly DataGridColumn[] | undefined, pattern: RegExp, fallback: number): number {
  const index = columns?.findIndex(column => pattern.test(column.name)) ?? -1;
  return index >= 0 ? index : fallback;
}

function cellText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Legacy-compatible log console for result sets marked as logs. It reuses the
 * exact DOM structure and class names of the legacy `createLogLineElement`
 * (`console-view` / `console-line` / `console-time` / `console-msg` /
 * `log-status` / `log-line-sql` / `log-meta-inline` / `log-error-hint`) so the
 * shared panel looks identical to the legacy panel. It follows streaming
 * output while the user stays at the bottom, and stops following as soon as
 * they scroll up to inspect history.
 */
export function LogConsole({ rows, columns, emptyLabel = 'No log messages yet.' }: LogConsoleProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const previousRowCount = useRef(rows.length);
  const timeIndex = columnIndex(columns, /time|timestamp/iu, 0);
  const messageIndex = columnIndex(columns, /message|text|log|detail/iu, 1);

  useEffect(() => {
    const element = scroller.current;
    if (!element || rows.length === previousRowCount.current) return;
    previousRowCount.current = rows.length;
    if (followOutput.current) element.scrollTop = element.scrollHeight;
  }, [rows.length]);

  const handleScroll = (): void => {
    const element = scroller.current;
    if (!element) return;
    followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };

  return <div className="console-view" ref={scroller} onScroll={handleScroll} role="log" aria-label="Query log">
    {rows.length === 0
      ? <div className="console-line console-line--empty" role="status"><span className="console-time" /><span className="console-msg">{emptyLabel}</span></div>
      : rows.map((row, index) => {
        const time = cellText(row[timeIndex]);
        const message = cellText(row[messageIndex]);
        if (message === '') {
          return <div className="console-line console-line--empty" key={index}><span className="console-time">{time}</span><span className="console-msg">{'\u00A0'}</span></div>;
        }
        if (message.startsWith('---')) {
          return <div className="console-line separator" key={index}><span className="console-time">{time}</span><span className="console-msg">{message}</span></div>;
        }
        const parsed = parseRunLogMessage(message);
        if (!parsed) {
          const kind = messageKind(message);
          const lineClass = kind === 'info' ? 'console-line' : `console-line console-line--${kind}`;
          return <div className={lineClass} key={index}><span className="console-time">{time}</span><span className="console-msg">{message}</span></div>;
        }
        const meta = [parsed.connection, parsed.duration, parsed.rowCount].filter((part): part is string => !!part);
        return <div className={`console-line status-${parsed.status}`} key={index}>
          <span className="console-time">{time}</span>
          <span className={`log-status log-status--${parsed.status}`}><span className="log-status-icon" aria-hidden="true">{STATUS_ICONS[parsed.status]}</span><span>{STATUS_LABELS[parsed.status]}</span></span>
          <span className="console-msg">
            {parsed.sqlPreview && <span className="log-line-sql">{parsed.sqlPreview}</span>}
            {meta.length > 0 && <span className="log-meta-inline">{meta.join('  ·  ')}</span>}
            {parsed.errorText && <span className="log-error-hint">{compactSqlErrorMessage(parsed.errorText)}</span>}
          </span>
        </div>;
      })}
  </div>;
}
