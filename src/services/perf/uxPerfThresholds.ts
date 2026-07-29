/**
 * UX latency budgets (ms). Events at/above the threshold for their op get slow=true.
 * Tuned for user-perceived lag, not DB query time.
 */

export const UX_PERF_THRESHOLDS_MS: Readonly<Record<string, number>> = {
  'result_panel.tab_switch': 50,
  'result_panel.source_switch': 100,
  'editor.doc_change': 50,
  'editor.typing_burst': 80,
  'editor.semantic_tokens': 50,
  'editor.change_to_tokens': 200,
  'editor.ext_lint': 100,
  'editor.highlight': 50,
  'lsp.diagnostics': 400,
};

/** Inter-keystroke gap that suggests the extension host was blocked. */
export const UX_PERF_INTER_KEY_SLOW_MS = 80;

/**
 * Gaps larger than this are treated as idle pauses (user stopped typing),
 * not extension-host lag. Excluded from doc_change slow samples and typing bursts.
 */
export const UX_PERF_INTER_KEY_GAP_MAX_MS = 1000;

/**
 * change_to_tokens is only meaningful shortly after a keystroke.
 * Larger values are idle / tab-switch / cache refresh noise.
 */
export const UX_PERF_CHANGE_TO_TOKENS_MAX_MS = 2000;

/** Quiet period after which a typing burst is summarized. */
export const UX_PERF_TYPING_BURST_IDLE_MS = 300;

/** Sample every N doc changes even when inter-key is fine. */
export const UX_PERF_DOC_CHANGE_SAMPLE_EVERY = 25;

/**
 * Phases that never count toward slow=true / duration aggregates
 * (markers, host posts, intentional deferred paint).
 */
const UX_PERF_NON_BUDGET_PHASES = new Set([
  'start',
  'editor_focus',
  'host_set_active',
  'lightweight_posted',
  'hydrate_posted',
  'hydrate_start',
  'webview_set_active',
  'cache_hit',
  'cache_miss',
  'cache_miss_executing',
  'noop_same_source',
  'scroll_restore',
  'end_visible', // includes intentional setTimeout(50) — use sync `end` / `dom_visible`
  'end_superseded',
]);

/**
 * Whether this phase should contribute to slow flags and per-op duration stats.
 */
export function isUxPerfBudgetPhase(op: string, phase: string): boolean {
  if (UX_PERF_NON_BUDGET_PHASES.has(phase)) {
    return false;
  }
  if (op === 'result_panel.tab_switch') {
    return phase === 'dom_visible' || phase === 'end';
  }
  if (op === 'result_panel.source_switch') {
    return phase === 'grids_rendered' || phase === 'end';
  }
  return phase === 'end' || phase === 'sample';
}

export function isUxPerfSlow(
  op: string,
  durationMs: number | undefined,
  phase?: string,
): boolean {
  if (durationMs === undefined || Number.isNaN(durationMs)) {
    return false;
  }
  if (phase !== undefined && !isUxPerfBudgetPhase(op, phase)) {
    return false;
  }
  const threshold = UX_PERF_THRESHOLDS_MS[op];
  if (threshold === undefined) {
    return false;
  }
  return durationMs >= threshold;
}
