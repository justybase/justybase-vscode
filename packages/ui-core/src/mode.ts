import type { UiMode } from '@justybase/contracts';

/** Runtime switch used by product composition roots during the strangler migration. */
export function resolveUiMode(value: unknown): UiMode {
  return value === 'shared' ? 'shared' : 'legacy';
}
