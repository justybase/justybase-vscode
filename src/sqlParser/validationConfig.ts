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
 * Above this line count, LSP skips publishing diagnostics entirely
 * (avoids multi-second full validation on huge scripts).
 */
export const HUGE_SCRIPT_LINE_THRESHOLD = 3000;

/** LSP diagnostics use extended debounce above this line count. */
export const LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD = 1500;

export function isLargeScript(textLength: number): boolean {
  return textLength > LARGE_SCRIPT_CHAR_THRESHOLD;
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
