import type {
  MetadataIdentifier,
  MetadataKeyCodec,
  MetadataKeyParts,
  MetadataIdentifierPolicy,
  ParsedMetadataKey,
} from './types';
import { identifierValue } from './types';

const KEY_VERSION = 'm1';

function encode(value: string | undefined): string {
  return value === undefined ? '' : encodeURIComponent(value);
}

function decode(value: string): string | undefined {
  if (value === '') return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizedPart(
  value: MetadataIdentifier | undefined,
  policy: MetadataIdentifierPolicy,
): string | undefined {
  return value === undefined ? undefined : identifierValue(value, policy);
}

/**
 * Creates a tagged, encoded key codec. Empty schema is represented by an
 * empty segment, so DB..TABLE remains distinct from DB.SCHEMA.TABLE.
 */
export function createMetadataKeyCodec(policy: MetadataIdentifierPolicy): MetadataKeyCodec {
  return {
    build(parts: MetadataKeyParts): string {
      const values = [
        KEY_VERSION,
        parts.namespace,
        parts.ownerId,
        parts.connectionId,
        parts.layer,
        normalizedPart(parts.database, policy),
        normalizedPart(parts.schema, policy),
        parts.objectType,
        normalizedPart(parts.objectName, policy),
        normalizedPart(parts.columnName, policy),
      ];
      return values.map(value => encode(value)).join('|');
    },
    parse(key: string): ParsedMetadataKey | null {
      const parts = key.split('|');
      if (parts.length !== 10) return null;
      const decoded = parts.map(decode);
      if (decoded[0] !== KEY_VERSION || !decoded[3] || !decoded[4]) return null;
      return {
        namespace: decoded[1],
        ownerId: decoded[2],
        connectionId: decoded[3]!,
        layer: decoded[4]!,
        database: decoded[5],
        schema: decoded[6],
        objectType: decoded[7],
        objectName: decoded[8],
        columnName: decoded[9],
      };
    },
  };
}

export function buildMetadataKey(
  parts: MetadataKeyParts,
  policy: MetadataIdentifierPolicy,
): string {
  return createMetadataKeyCodec(policy).build(parts);
}

export function metadataIdentifier(
  value: string,
  source: 'user' | 'catalog' = 'user',
  quoted = false,
): MetadataIdentifier {
  return { value, source, quoted };
}
