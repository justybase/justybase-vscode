/**
 * Regression guards for large-script / LSP diagnostic thresholds used by
 * progressive semantic tokens and diagnosticsHandler.
 */

import {
  HUGE_SCRIPT_LINE_THRESHOLD,
  isLargeScript,
  isLargeScriptDocument,
  LARGE_SCRIPT_CHAR_THRESHOLD,
  LARGE_SCRIPT_LINE_THRESHOLD,
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

  it('uses 1500-line LSP debounce threshold and 3000-line diagnostics skip', () => {
    expect(LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD).toBe(1500);
    expect(HUGE_SCRIPT_LINE_THRESHOLD).toBe(3000);
    expect(LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD).toBeLessThan(HUGE_SCRIPT_LINE_THRESHOLD);
  });
});
