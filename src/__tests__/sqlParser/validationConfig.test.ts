/**
 * Regression guards for large-script / LSP diagnostic thresholds used by
 * progressive semantic tokens and diagnosticsHandler.
 */

import {
  HUGE_SCRIPT_LINE_THRESHOLD,
  isLargeScript,
  isLargeScriptDocument,
  isLspDiagnosticsSkipExceeded,
  LARGE_SCRIPT_CHAR_THRESHOLD,
  LARGE_SCRIPT_LINE_THRESHOLD,
  LSP_DIAGNOSTICS_CHAR_THRESHOLD,
  LSP_DIAGNOSTICS_LINE_THRESHOLD,
  LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD,
} from '../../sqlParser/validationConfig';

describe('validationConfig large-script thresholds', () => {
  it('keeps the shared line/char thresholds used by editor UX guards', () => {
    expect(LARGE_SCRIPT_LINE_THRESHOLD).toBe(500);
    expect(LARGE_SCRIPT_CHAR_THRESHOLD).toBe(150_000);
    expect(isLargeScript(LARGE_SCRIPT_CHAR_THRESHOLD)).toBe(false);
    expect(isLargeScript(LARGE_SCRIPT_CHAR_THRESHOLD + 1)).toBe(true);
    expect(isLargeScriptDocument(LARGE_SCRIPT_LINE_THRESHOLD, 1)).toBe(false);
    expect(isLargeScriptDocument(LARGE_SCRIPT_LINE_THRESHOLD + 1, 1)).toBe(true);
  });

  it('uses separate extension-host and LSP diagnostics thresholds', () => {
    expect(LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD).toBe(1500);
    expect(LSP_DIAGNOSTICS_LINE_THRESHOLD).toBe(10_000);
    expect(LSP_DIAGNOSTICS_CHAR_THRESHOLD).toBe(400_000);
    expect(HUGE_SCRIPT_LINE_THRESHOLD).toBe(LSP_DIAGNOSTICS_LINE_THRESHOLD);
    expect(LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD).toBeLessThan(
      LSP_DIAGNOSTICS_LINE_THRESHOLD,
    );
    expect(LARGE_SCRIPT_CHAR_THRESHOLD).toBeLessThan(
      LSP_DIAGNOSTICS_CHAR_THRESHOLD,
    );
  });

  it('identifies documents the LSP will not validate automatically', () => {
    expect(isLspDiagnosticsSkipExceeded(LSP_DIAGNOSTICS_LINE_THRESHOLD, 1)).toBe(false);
    expect(isLspDiagnosticsSkipExceeded(LSP_DIAGNOSTICS_LINE_THRESHOLD + 1, 1)).toBe(true);
    expect(isLspDiagnosticsSkipExceeded(1, LSP_DIAGNOSTICS_CHAR_THRESHOLD)).toBe(false);
    expect(isLspDiagnosticsSkipExceeded(1, LSP_DIAGNOSTICS_CHAR_THRESHOLD + 1)).toBe(true);
    // The extension-host guard stays at the old, more conservative size.
    expect(isLargeScript(LARGE_SCRIPT_CHAR_THRESHOLD + 1)).toBe(true);
  });
});
