/** DDL/script files above this line count use extended lint debounce. */
export const LARGE_SCRIPT_LINE_THRESHOLD = 500;

/** DDL/script files above this size skip extension-host lint when LSP owns diagnostics. */
export const LARGE_SCRIPT_CHAR_THRESHOLD = 150_000;

/** Debounce for large-script extension-host lint (ms). */
export const LARGE_SCRIPT_LINT_DEBOUNCE_MS = 2_000;

/** Default extension-host lint debounce (ms). */
export const DEFAULT_LINT_DEBOUNCE_MS = 400;

/** LSP diagnostics slow-path log threshold (ms). */
export const DIAGNOSTICS_SLOW_LOG_MS = 500;

export function isLargeScript(textLength: number): boolean {
  return textLength > LARGE_SCRIPT_CHAR_THRESHOLD;
}

export function shouldIncludeParserDiagnosticsInExtensionLint(
  lspRunning: boolean,
  sqlLength: number,
): boolean {
  return !lspRunning && sqlLength <= LARGE_SCRIPT_CHAR_THRESHOLD;
}
