import type {
  MetadataDdlRequest,
  MetadataDdlResponse,
} from '@justybase/contracts';
import {
  buildNetezzaTableDdl,
  buildNetezzaViewDdl,
} from '@justybase/designer-core';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { StoredConnection } from './store';

export class SchemaDdlUnavailableError extends Error {
  public readonly code = 'SCHEMA_DDL_UNAVAILABLE';
  public readonly statusCode = 501;

  public constructor(message: string) {
    super(message);
    this.name = 'SchemaDdlUnavailableError';
  }
}

/**
 * Generates schema DDL through the dialect runtime and the shared pure
 * formatter. No web-specific reconstruction is allowed here: in particular,
 * missing Netezza type metadata must never turn into VARCHAR(1).
 */
export async function getSchemaObjectDdlResponse(
  profile: StoredConnection,
  request: MetadataDdlRequest,
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<MetadataDdlResponse> {
  if (profile.dbType !== 'netezza') {
    throw new SchemaDdlUnavailableError(`Exact DDL is not available for ${profile.dbType}.`);
  }
  const objectType = request.objectType.trim().toUpperCase();
  const runtime = runtimes.forProfile(profile);
  const objectInfo = {
    database: request.database,
    schema: request.schema,
    objectName: request.objectName,
    objectType,
  };

  if (objectType === 'TABLE') {
    if (!runtime.getTableDdlMetadata) {
      throw new SchemaDdlUnavailableError(`Exact TABLE DDL is not available for ${profile.dbType}.`);
    }
    const metadata = await runtime.getTableDdlMetadata(
      profile,
      request.database,
      request.schema,
      request.objectName,
    );
    if (metadata.metadataComplete === false
      || metadata.columns.length === 0
      || metadata.columns.some(column => !column.fullTypeName.trim())) {
      throw new SchemaDdlUnavailableError(
        `The catalog did not return complete column types for ${request.database}.${request.schema}.${request.objectName}.`,
      );
    }
    const keys = new Map(metadata.keys.map(entry => [entry.name, entry.info] as const));
    return {
      success: true,
      ddlCode: buildNetezzaTableDdl(
        request.database,
        request.schema,
        request.objectName,
        metadata.columns,
        metadata.distributionColumns,
        metadata.organizeColumns,
        keys,
        metadata.tableComment,
      ),
      objectInfo,
      ddlFidelity: 'exact',
    };
  }

  if (objectType === 'VIEW') {
    if (!runtime.getViewDefinition) {
      throw new SchemaDdlUnavailableError(`Exact VIEW DDL is not available for ${profile.dbType}.`);
    }
    const definition = await runtime.getViewDefinition(
      profile,
      request.database,
      request.schema,
      request.objectName,
    );
    return {
      success: true,
      ddlCode: buildNetezzaViewDdl(
        request.database,
        request.schema,
        request.objectName,
        definition,
      ),
      objectInfo,
      ddlFidelity: 'exact',
    };
  }

  throw new SchemaDdlUnavailableError(
    `Exact DDL for ${objectType || 'this object type'} is not available in the web schema explorer yet.`,
  );
}
