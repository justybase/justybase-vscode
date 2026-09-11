import type { RedactedConnectionProfile } from '@justybase/contracts';

/** Builds an allowlisted profile projection; no spread of host objects. */
export function redactConnectionProfile(value: unknown): RedactedConnectionProfile {
  if (typeof value !== 'object' || value === null) throw new Error('Connection profile is invalid.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.host !== 'string'
    || typeof candidate.port !== 'number' || typeof candidate.database !== 'string' || typeof candidate.user !== 'string'
    || typeof candidate.dbType !== 'string' || typeof candidate.readOnly !== 'boolean') {
    throw new Error('Connection profile is invalid.');
  }
  return {
    id: candidate.id,
    name: candidate.name,
    host: candidate.host,
    port: candidate.port,
    database: candidate.database,
    user: candidate.user,
    dbType: candidate.dbType,
    readOnly: candidate.readOnly,
  };
}

export function redactConnectionProfiles(values: readonly unknown[]): readonly RedactedConnectionProfile[] {
  return values.map(redactConnectionProfile);
}
