import type { MetadataIdentifierPolicy } from './types';

/** Netezza identifier folding used by both desktop and API metadata adapters. */
export const netezzaMetadataIdentifierPolicy: MetadataIdentifierPolicy = {
  normalizeUser(value: string, quoted = false): string {
    const trimmed = value.trim();
    if (!quoted) return trimmed.toUpperCase();
    return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1).replace(/""/g, '"')
      : trimmed;
  },
  normalizeCatalog(value: string): string {
    return value;
  },
};

export function createNetezzaMetadataIdentifierPolicy(): MetadataIdentifierPolicy {
  return netezzaMetadataIdentifierPolicy;
}
