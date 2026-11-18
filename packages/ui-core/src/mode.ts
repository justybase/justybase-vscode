import type { UiMode } from '@justybase/contracts';

/**
 * Runtime switch used by product composition roots during the strangler
 * migration. The shared React result grid is the default surface; `legacy`
 * remains an explicit rollback until the DOM renderer is deleted.
 */
export function resolveUiMode(value: unknown): UiMode {
  return value === 'legacy' ? 'legacy' : 'shared';
}
