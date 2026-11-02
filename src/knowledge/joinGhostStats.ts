import type { JoinGhostSuggestion } from "../lsp/protocol";

/** Global-state key; counters only, never SQL text or table names. */
export const JOIN_GHOST_STATS_KEY = "justybase.joinKnowledge.ghostStats";

export type JoinGhostSlot = "afterJoinTarget" | "condition" | "newLineJoin" | "groupBy";

export interface JoinGhostSlotCounts {
  shown: number;
  accepted: number;
}

export type JoinGhostStatsSnapshot = Record<JoinGhostSlot, JoinGhostSlotCounts>;

export interface JoinGhostStatsMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const SLOTS: readonly JoinGhostSlot[] = ["afterJoinTarget", "condition", "newLineJoin", "groupBy"];

/** Which position produced a ghost: the whole JOIN on a new line starts with `JOIN `. */
export function joinGhostSlotOf(ghost: Pick<JoinGhostSuggestion, "kind" | "insertText">): JoinGhostSlot {
  if (ghost.kind === "predicate") {
    return "condition";
  }
  if (ghost.kind === "groupBy") {
    return "groupBy";
  }
  return ghost.insertText.startsWith("JOIN ") ? "newLineJoin" : "afterJoinTarget";
}

function emptySnapshot(): JoinGhostStatsSnapshot {
  return {
    afterJoinTarget: { shown: 0, accepted: 0 },
    condition: { shown: 0, accepted: 0 },
    newLineJoin: { shown: 0, accepted: 0 },
    groupBy: { shown: 0, accepted: 0 },
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Local shown/accepted counters for JOIN ghost text, used to judge whether a
 * ghost position is precise enough in real use (e.g. before enabling the
 * new-line mode by default). A ghost re-offered at the same position with the
 * same text is counted once.
 */
export class JoinGhostStats {
  private lastShownKey: string | undefined;

  constructor(private readonly memento: JoinGhostStatsMemento) {}

  snapshot(): JoinGhostStatsSnapshot {
    const stored = this.memento.get<Partial<Record<JoinGhostSlot, Partial<JoinGhostSlotCounts>>>>(
      JOIN_GHOST_STATS_KEY,
    );
    const result = emptySnapshot();
    for (const slot of SLOTS) {
      result[slot] = {
        shown: count(stored?.[slot]?.shown),
        accepted: count(stored?.[slot]?.accepted),
      };
    }
    return result;
  }

  recordShown(slot: JoinGhostSlot, positionKey: string): Thenable<void> | undefined {
    if (positionKey === this.lastShownKey) {
      return undefined;
    }
    this.lastShownKey = positionKey;
    return this.increment(slot, "shown");
  }

  recordAccepted(slot: JoinGhostSlot): Thenable<void> {
    this.lastShownKey = undefined;
    return this.increment(slot, "accepted");
  }

  reset(): Thenable<void> {
    this.lastShownKey = undefined;
    return this.memento.update(JOIN_GHOST_STATS_KEY, undefined);
  }

  private increment(slot: JoinGhostSlot, field: keyof JoinGhostSlotCounts): Thenable<void> {
    const next = this.snapshot();
    next[slot][field] += 1;
    return this.memento.update(JOIN_GHOST_STATS_KEY, next);
  }
}

/** Status lines: shown, accepted and acceptance rate per ghost position. */
export function formatJoinGhostStats(snapshot: JoinGhostStatsSnapshot): string[] {
  const labels: Record<JoinGhostSlot, string> = {
    afterJoinTarget: "target after JOIN",
    condition: "ON condition",
    newLineJoin: "JOIN on a new line",
    groupBy: "GROUP BY list",
  };
  return SLOTS.map((slot) => {
    const { shown, accepted } = snapshot[slot];
    const rate = shown > 0 ? ` (${Math.round((accepted / shown) * 100)}%)` : "";
    return `Ghost text, ${labels[slot]}: ${shown} shown, ${accepted} accepted${rate}`;
  });
}
