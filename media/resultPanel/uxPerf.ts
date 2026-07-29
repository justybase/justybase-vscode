/**
 * Webview-side UX perf helper. Posts NDJSON-shaped events to the extension host
 * only while a dogfood session is active (host notifies via uxPerfSession).
 */

import { postHostMessage } from './protocol.js';

export type UxPerfMetaValue = string | number | boolean | null;

export interface UxPerfDocContext {
  uri?: string;
  chars?: number;
  lines?: number;
  ver?: number;
}

let sessionActive = false;

/**
 * Monotonic token so only the latest scheduled source_switch `end` reports.
 * Prevents stale rAF callbacks (setActiveSource then hydrate) from emitting
 * multi-second false positives.
 */
let sourceSwitchEndToken = 0;

export function setUxPerfSessionActive(active: boolean): void {
  sessionActive = active;
  if (!active) {
    sourceSwitchEndToken += 1;
  }
}

export function isUxPerfSessionActive(): boolean {
  return sessionActive;
}

export function reportUxPerf(input: {
  op: string;
  phase: string;
  traceId?: string;
  durationMs?: number;
  doc?: UxPerfDocContext;
  meta?: Record<string, UxPerfMetaValue>;
}): void {
  if (!sessionActive) {
    return;
  }
  postHostMessage({
    command: 'reportUxPerf',
    event: {
      op: input.op,
      phase: input.phase,
      traceId: input.traceId,
      durationMs: input.durationMs,
      doc: input.doc,
      meta: input.meta,
    },
  });
}

/** Invalidate any pending source_switch end rAF (call when a newer mark starts). */
export function invalidateSourceSwitchEnd(): void {
  sourceSwitchEndToken += 1;
}

/** Claim a token for an upcoming source_switch end (same frame or next rAF). */
export function beginSourceSwitchEndSchedule(): number {
  sourceSwitchEndToken += 1;
  return sourceSwitchEndToken;
}

/**
 * Emit `end` only if this schedule is still current; otherwise `end_superseded`.
 */
export function completeSourceSwitchEnd(
  token: number,
  mark: UxPerfMark,
  meta?: Record<string, UxPerfMetaValue>,
  doc?: UxPerfDocContext,
  extras?: { frameDelayMs?: number },
): void {
  if (token !== sourceSwitchEndToken) {
    reportUxPerf({
      op: mark.op,
      phase: 'end_superseded',
      traceId: mark.traceId,
      durationMs: performance.now() - mark.startedAt,
      doc,
      meta: {
        ...meta,
        stale: true,
        frameDelayMs: extras?.frameDelayMs ?? null,
      },
    });
    return;
  }
  mark.phase(
    'end',
    {
      ...meta,
      frameDelayMs: extras?.frameDelayMs ?? null,
    },
    doc,
  );
}

/**
 * Schedule source_switch `end` on the next animation frame.
 * Superseded if another source_switch mark schedules end / starts hydrate.
 */
export function scheduleSourceSwitchEnd(
  mark: UxPerfMark,
  meta?: Record<string, UxPerfMetaValue>,
  doc?: UxPerfDocContext,
): void {
  const token = beginSourceSwitchEndSchedule();
  const scheduledAt = performance.now();
  requestAnimationFrame(() => {
    completeSourceSwitchEnd(token, mark, meta, doc, {
      frameDelayMs: Math.round((performance.now() - scheduledAt) * 10) / 10,
    });
  });
}

/** Simple phase timer for click→visible flows. */
export class UxPerfMark {
  readonly startedAt: number;
  readonly op: string;
  readonly traceId: string;
  private lastPhaseAt: number;

  constructor(op: string, traceId?: string) {
    this.op = op;
    this.traceId = traceId ?? `w-${Math.random().toString(36).slice(2, 9)}`;
    this.startedAt = performance.now();
    this.lastPhaseAt = this.startedAt;
  }

  phase(
    phase: string,
    meta?: Record<string, UxPerfMetaValue>,
    doc?: UxPerfDocContext,
  ): void {
    const now = performance.now();
    reportUxPerf({
      op: this.op,
      phase,
      traceId: this.traceId,
      durationMs: now - this.startedAt,
      doc,
      meta: {
        ...meta,
        phaseDeltaMs: Math.round((now - this.lastPhaseAt) * 10) / 10,
      },
    });
    this.lastPhaseAt = now;
  }
}
