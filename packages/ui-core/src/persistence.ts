import type { PersistenceEnvelope, PersistenceScope, UiIdentity } from '@justybase/contracts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface PersistenceCodecOptions<T> {
  readonly schemaVersion: number;
  readonly scope: PersistenceScope;
  readonly identity: UiIdentity;
  readonly migrations?: Readonly<Record<number, (payload: unknown) => unknown>>;
  readonly validatePayload?: (payload: unknown) => payload is T;
}

export interface LegacyPersistenceRead<T> {
  readonly envelope: PersistenceEnvelope<T>;
  readonly migratedFromLegacy: boolean;
}

export class PersistenceDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PersistenceDecodeError';
  }
}

const persistenceScopes: readonly PersistenceScope[] = ['user', 'profile', 'workspace', 'global'];
const identityKeys: readonly (keyof UiIdentity)[] = [
  'productId',
  'userId',
  'workspaceId',
  'documentId',
  'connectionId',
  'sourceId',
  'executionId',
  'resultSetId',
  'storageId',
];
const persistenceSecretKeyPattern = /password|passphrase|secret|credential|master.?key|access.?token|refresh.?token|api.?key|(?:^|[_-])token(?:$|[_-])|token$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown, path = '$'): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new PersistenceDecodeError(`Persistence value at ${path} must be finite.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (persistenceSecretKeyPattern.test(key)) {
        throw new PersistenceDecodeError(`Persistence value at ${path}.${key} is not allowed.`);
      }
      if (/^(?:rows|resultRows|rowData|resultData)$/iu.test(key)) {
        throw new PersistenceDecodeError(`Result buffers cannot be persisted at ${path}.${key}.`);
      }
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new PersistenceDecodeError(`Persistence value at ${path} is not JSON serializable.`);
}

function assertIdentity(identity: unknown): asserts identity is UiIdentity {
  if (!isRecord(identity) || typeof identity.productId !== 'string' || identity.productId.length === 0) {
    throw new PersistenceDecodeError('Persistence envelope identity is invalid.');
  }
  for (const key of Object.keys(identity)) {
    if (!identityKeys.includes(key as keyof UiIdentity) || persistenceSecretKeyPattern.test(key)) {
      throw new PersistenceDecodeError(`Persistence identity field '${key}' is not allowed.`);
    }
  }
  for (const value of Object.values(identity)) {
    if (value !== undefined && typeof value !== 'string') throw new PersistenceDecodeError('Persistence identity values must be strings.');
  }
}

function assertScope(scope: unknown): asserts scope is PersistenceScope {
  if (typeof scope !== 'string' || !persistenceScopes.includes(scope as PersistenceScope)) {
    throw new PersistenceDecodeError('Persistence envelope scope is invalid.');
  }
}

export function identitiesMatch(expected: UiIdentity, actual: UiIdentity): boolean {
  const keys: (keyof UiIdentity)[] = [
    'productId',
    'userId',
    'workspaceId',
    'documentId',
    'connectionId',
    'sourceId',
    'executionId',
    'resultSetId',
    'storageId',
  ];
  // A legacy envelope may not have acquired every newer identity axis yet.
  // Missing axes are therefore tolerated, while a concrete value from the
  // stored envelope must always agree with the active identity.
  return keys.every(key => actual[key] === undefined || expected[key] === actual[key]);
}

function parseRaw(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new PersistenceDecodeError(`Persistence envelope is corrupted: ${message}`);
  }
}

export function createPersistenceEnvelope<T>(payload: T, options: Omit<PersistenceCodecOptions<T>, 'migrations' | 'validatePayload'>): PersistenceEnvelope<T> {
  if (!Number.isInteger(options.schemaVersion) || options.schemaVersion < 1) throw new PersistenceDecodeError('Persistence schemaVersion must be a positive integer.');
  assertScope(options.scope);
  assertIdentity(options.identity);
  assertJsonValue(payload);
  return {
    schemaVersion: options.schemaVersion,
    scope: options.scope,
    identity: { ...options.identity },
    payload,
  };
}

/** Encodes only validated JSON and is safe for browser/profile/host storage. */
export function encodePersistenceEnvelope<T>(envelope: PersistenceEnvelope<T>): string {
  if (!Number.isInteger(envelope.schemaVersion) || envelope.schemaVersion < 1) throw new PersistenceDecodeError('Persistence schemaVersion must be a positive integer.');
  assertScope(envelope.scope);
  assertJsonValue(envelope);
  assertIdentity(envelope.identity);
  try {
    return JSON.stringify(envelope);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'serialization failed';
    throw new PersistenceDecodeError(`Persistence envelope cannot be encoded: ${message}`);
  }
}

/**
 * Decodes and migrates an envelope. A scope or identity mismatch is treated as
 * foreign data and rejected before the payload reaches a product adapter.
 */
export function decodePersistenceEnvelope<T>(value: unknown, options: PersistenceCodecOptions<T>): PersistenceEnvelope<T> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = parseRaw(value);
  const rawSchemaVersion = isRecord(raw) ? raw.schemaVersion : undefined;
  if (!isRecord(raw)
    || typeof rawSchemaVersion !== 'number'
    || !Number.isInteger(rawSchemaVersion)
    || rawSchemaVersion < 1
    || typeof raw.scope !== 'string'
    || !isRecord(raw.identity)
    || !Object.prototype.hasOwnProperty.call(raw, 'payload')) {
    throw new PersistenceDecodeError('Persistence envelope is malformed.');
  }
  assertScope(raw.scope);
  assertIdentity(raw.identity);
  if (raw.scope !== options.scope) throw new PersistenceDecodeError('Persistence envelope scope does not match the active product scope.');
  if (!identitiesMatch(options.identity, raw.identity)) throw new PersistenceDecodeError('Persistence envelope belongs to a different identity.');
  if (rawSchemaVersion > options.schemaVersion) throw new PersistenceDecodeError('Persistence envelope is newer than this UI can read.');

  let version = rawSchemaVersion;
  let payload: unknown = raw.payload;
  while (version < options.schemaVersion) {
    const migrate = options.migrations?.[version];
    if (!migrate) throw new PersistenceDecodeError(`No migration is registered for persistence schema ${version}.`);
    payload = migrate(payload);
    assertJsonValue(payload);
    version += 1;
  }
  assertJsonValue(payload);
  if (options.validatePayload && !options.validatePayload(payload)) throw new PersistenceDecodeError('Persistence payload failed validation.');
  return {
    schemaVersion: version,
    scope: options.scope,
    identity: { ...raw.identity },
    payload: payload as T,
  };
}

/** Reads current storage first, then a legacy payload for one-way migration. */
export function decodeWithLegacyFallback<T>(current: unknown, legacy: unknown, options: PersistenceCodecOptions<T>): LegacyPersistenceRead<T> | undefined {
  const currentEnvelope = decodePersistenceEnvelope<T>(current, options);
  if (currentEnvelope) return { envelope: currentEnvelope, migratedFromLegacy: false };
  if (legacy === undefined || legacy === null || legacy === '') return undefined;
  const legacyPayload = parseRaw(legacy);
  assertJsonValue(legacyPayload);
  if (options.validatePayload && !options.validatePayload(legacyPayload)) throw new PersistenceDecodeError('Legacy persistence payload failed validation.');
  return {
    envelope: createPersistenceEnvelope(legacyPayload as T, {
      schemaVersion: options.schemaVersion,
      scope: options.scope,
      identity: options.identity,
    }),
    migratedFromLegacy: true,
  };
}

export class PersistenceCodec<T> {
  private readonly options: PersistenceCodecOptions<T>;

  public constructor(options: PersistenceCodecOptions<T>) {
    this.options = { ...options };
  }

  public encode(payload: T): string {
    return encodePersistenceEnvelope(createPersistenceEnvelope(payload, this.options));
  }

  public decode(value: unknown): PersistenceEnvelope<T> | undefined {
    return decodePersistenceEnvelope(value, this.options);
  }

  public decodeWithLegacy(current: unknown, legacy: unknown): LegacyPersistenceRead<T> | undefined {
    return decodeWithLegacyFallback(current, legacy, this.options);
  }
}
