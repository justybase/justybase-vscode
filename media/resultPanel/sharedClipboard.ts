import { createDataGridClipboardPayload } from '@justybase/ui-react';
import type { DataGridClipboardFormat, DataGridCopyPayload } from '@justybase/ui-react';
import { postHostMessage } from './protocol.js';

/** Formats the legacy result grid can select for the plain-text clipboard part. */
export type SharedCopyFormat = 'tabbed' | 'markdown' | 'csv' | 'csv-semicolon';

/** The grid's context-menu formats plus the setting-driven plain-text formats. */
export type SharedClipboardFormat = DataGridClipboardFormat | SharedCopyFormat;

export interface SharedClipboardPayload {
  /** HTML table that rich targets (Excel, Word, browsers) should paste. */
  readonly html: string;
  /** Plain-text fallback selected by the configured copy format. */
  readonly plainText: string;
}

export function isSharedCopyFormat(value: unknown): value is SharedCopyFormat {
  return value === 'tabbed' || value === 'markdown' || value === 'csv' || value === 'csv-semicolon';
}

/**
 * Builds both clipboard representations from one typed grid payload. The
 * receiving application decides whether to use the HTML table or the text
 * fallback; VS Code and browsers expose both for paste targets such as Excel,
 * Markdown editors, and plain-text fields.
 *
 * JSON and SQL are intentionally plain-text only: rich editors would paste the
 * HTML table instead of the requested INSERT/JSON text.
 */
export function resolveSharedClipboardPayload(
  payload: DataGridCopyPayload,
  format: SharedClipboardFormat | undefined,
): SharedClipboardPayload {
  const formatted = createDataGridClipboardPayload(payload, {
    includeHeaders: payload.includeHeaders ?? true,
  });
  const html = formatted.html;
  switch (format) {
    case 'json':
      return { html: '', plainText: formatted.json };
    case 'sql':
      return { html: '', plainText: formatted.sql };
    case 'markdown':
      return { html, plainText: formatted.markdown };
    case 'csv':
      return { html, plainText: formatted.csv };
    case 'csv-semicolon':
      return { html, plainText: formatted.csvSemicolon };
    case 'html':
      return { html, plainText: formatted.text };
    default:
      return { html, plainText: formatted.text };
  }
}

function copyDescription(payload: DataGridCopyPayload): string {
  const rowCount = payload.rows.length;
  return rowCount === 1 ? '1 row' : `${rowCount.toLocaleString()} rows`;
}

function notifyCopied(description: string): void {
  postHostMessage({ command: 'info', text: `Copied ${description} to clipboard` });
}

/**
 * Writes HTML + plain text through the async Clipboard API. If the webview has
 * no multi-format clipboard support (or the write is denied), it falls back to
 * the host clipboard with the configured plain-text representation.
 */
export function writeSharedClipboard(
  payload: DataGridCopyPayload,
  format: SharedClipboardFormat | undefined,
  description = copyDescription(payload),
): void {
  const resolved = resolveSharedClipboardPayload(payload, format);
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  const clipboardItemConstructor = typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem;

  if (clipboardItemConstructor !== undefined && typeof clipboard?.write === 'function' && resolved.html) {
    const item = new clipboardItemConstructor({
      'text/html': new Blob([resolved.html], { type: 'text/html' }),
      'text/plain': new Blob([resolved.plainText], { type: 'text/plain' }),
    });
    void clipboard.write([item]).then(
      () => notifyCopied(description),
      () => writePlainText(resolved.plainText, description),
    );
    return;
  }

  writePlainText(resolved.plainText, description);
}

function writePlainText(text: string, description: string): void {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (typeof clipboard?.writeText === 'function') {
    void clipboard.writeText(text).then(
      () => notifyCopied(description),
      () => postHostMessage({ command: 'copyToClipboard', text }),
    );
    return;
  }
  postHostMessage({ command: 'copyToClipboard', text });
}
