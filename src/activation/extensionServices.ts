import type { ConnectionManager } from "../core/connectionManager";
import type { MetadataCache } from "../metadataCache";
import type { SchemaProvider } from "../providers/schemaProvider";
import type { Logger } from "../utils/logger";
import type { runQueryRaw } from "../core/queryRunner";

export type QueryExecutor = typeof runQueryRaw;

/**
 * Lightweight service bag created during extension activation.
 * Passed to registrars instead of individual singleton lookups.
 */
export interface ExtensionServices {
  connectionManager: ConnectionManager;
  metadataCache: MetadataCache;
  schemaProvider: SchemaProvider;
  logger: Logger;
  queryExecutor: QueryExecutor;
}

export function createExtensionServices(
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
  schemaProvider: SchemaProvider,
  logger: Logger,
  queryExecutor: QueryExecutor,
): ExtensionServices {
  return {
    connectionManager,
    metadataCache,
    schemaProvider,
    logger,
    queryExecutor,
  };
}
