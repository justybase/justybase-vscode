/** DDL/script files above this line count use extended lint debounce / EH guards. */
export const LARGE_SCRIPT_LINE_THRESHOLD = 500;

/** DDL/script files above this size skip extension-host lint when LSP owns diagnostics. */
export const LARGE_SCRIPT_CHAR_THRESHOLD = 150_000;

/** Debounce for large-script extension-host lint (ms). */
export const LARGE_SCRIPT_LINT_DEBOUNCE_MS = 2_000;

/** Default extension-host lint debounce (ms). */
export const DEFAULT_LINT_DEBOUNCE_MS = 400;

/** LSP diagnostics slow-path log threshold (ms). */
export const DIAGNOSTICS_SLOW_LOG_MS = 500;

/**
 * LSP diagnostics char cutoff. Kept separate from the extension-host
 * `LARGE_SCRIPT_CHAR_THRESHOLD`: the language server runs in its own process
 * and can afford a larger document than the extension-host features that share
 * the 150k guard (semantic tokens parser, decorations, code lens).
 */
export const LSP_DIAGNOSTICS_CHAR_THRESHOLD = 400_000;

/**
 * LSP diagnostics line cutoff. 10k lines / 281k chars measured ~270 ms in the
 * full diagnostics pipeline (cold, excluding the 2 s debounce); 15k lines
 * (~345 ms) stays on the explicit validation path for headroom.
 */
export const LSP_DIAGNOSTICS_LINE_THRESHOLD = 10_000;

/**
 * @deprecated Use `LSP_DIAGNOSTICS_LINE_THRESHOLD`. Retained for callers that
 * still import the historical name.
 */
export const HUGE_SCRIPT_LINE_THRESHOLD = LSP_DIAGNOSTICS_LINE_THRESHOLD;

/** LSP diagnostics use extended debounce above this line count. */
export const LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD = 1500;

export function isLargeScript(textLength: number): boolean {
  return textLength > LARGE_SCRIPT_CHAR_THRESHOLD;
}

/**
 * True when automatic LSP diagnostics are skipped for this document.
 *
 * The language server intentionally returns an empty diagnostic list above
 * these limits to avoid blocking completion/hover on very large documents. An
 * explicit, user-triggered validation must bypass this check instead of
 * pretending the LSP already published parser diagnostics.
 */
export function isLspDiagnosticsSkipExceeded(
  lineCount: number,
  textLength: number,
): boolean {
  return (
    textLength > LSP_DIAGNOSTICS_CHAR_THRESHOLD ||
    lineCount > LSP_DIAGNOSTICS_LINE_THRESHOLD
  );
}

/** True when line count or char size indicates a heavy SQL script. */
export function isLargeScriptDocument(
  lineCount: number,
  textLength: number,
): boolean {
  return (
    lineCount > LARGE_SCRIPT_LINE_THRESHOLD ||
    textLength > LARGE_SCRIPT_CHAR_THRESHOLD
  );
}

export function shouldIncludeParserDiagnosticsInExtensionLint(
  lspRunning: boolean,
  sqlLength: number,
): boolean {
  return !lspRunning && sqlLength <= LARGE_SCRIPT_CHAR_THRESHOLD;
}
