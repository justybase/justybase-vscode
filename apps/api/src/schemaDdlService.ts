import type {
  MetadataDdlRequest,
  MetadataDdlResponse,
} from '@justybase/contracts';
import {
  buildReconstructedTableDdl,
  buildReconstructedViewDdl,
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
 * formatter. Exact Netezza output stays on its native catalog path; local
 * generic runtimes use an explicitly labelled reconstruction path.
 */
export async function getSchemaObjectDdlResponse(
  profile: StoredConnection,
  request: MetadataDdlRequest,
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<MetadataDdlResponse> {
  const objectType = request.objectType.trim().toUpperCase();
  const runtime = runtimes.forProfile(profile);
  const objectInfo = {
    database: request.database,
    schema: request.schema,
    objectName: request.objectName,
    objectType,
  };

  if (profile.dbType === 'netezza') {
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
      if (!definition.trim()) {
        throw new SchemaDdlUnavailableError(
          `The catalog did not return a definition for ${request.database}.${request.schema}.${request.objectName}.`,
        );
      }
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

  // The API currently executes only these local runtimes. Other dialects are
  // valid authoring profiles, but must not receive a fake DDL response until a
  // native runtime/catalog adapter is registered for them.
  if (runtime.kind !== 'sqlite' && runtime.kind !== 'duckdb') {
    throw new SchemaDdlUnavailableError(`DDL is not available for ${profile.dbType}.`);
  }

  if (objectType === 'TABLE') {
    let reconstructed: ReturnType<typeof buildReconstructedTableDdl>;
    try {
      const columns = await runtime.listColumns(
        profile,
        request.database,
        request.schema,
        request.objectName,
      );
      reconstructed = buildReconstructedTableDdl({
        database: request.database,
        schema: request.schema,
        tableName: request.objectName,
        databaseKind: runtime.kind,
        columns,
      });
    } catch (reason: unknown) {
      throw new SchemaDdlUnavailableError(
        reason instanceof Error ? reason.message : `Complete TABLE metadata is not available for ${request.objectName}.`,
      );
    }
    return {
      success: true,
      ddlCode: reconstructed.ddl,
      objectInfo,
      ddlFidelity: 'reconstructed',
      note: `DDL was reconstructed from ${runtime.kind} metadata.`,
      warnings: reconstructed.warnings,
    };
  }

  if (objectType === 'VIEW') {
    let objects;
    try {
      objects = await runtime.listObjects(profile, request.database, request.schema);
    } catch (reason: unknown) {
      throw new SchemaDdlUnavailableError(
        reason instanceof Error ? reason.message : `Complete VIEW metadata is not available for ${request.objectName}.`,
      );
    }
    const requestedName = request.objectName.trim().toLowerCase();
    const view = objects.find(item => item.objectType?.trim().toUpperCase() === 'VIEW'
      && item.name.trim().toLowerCase() === requestedName);
    const sourceSql = view?.viewSql?.trim();
    if (!sourceSql) {
      throw new SchemaDdlUnavailableError(
        `The catalog did not return a complete VIEW definition for ${request.database}.${request.schema}.${request.objectName}.`,
      );
    }
    let reconstructed: ReturnType<typeof buildReconstructedViewDdl>;
    try {
      reconstructed = buildReconstructedViewDdl({
        database: request.database,
        schema: request.schema,
        viewName: request.objectName,
        databaseKind: runtime.kind,
        sourceSql,
      });
    } catch (reason: unknown) {
      throw new SchemaDdlUnavailableError(
        reason instanceof Error ? reason.message : `Complete VIEW metadata is not available for ${request.objectName}.`,
      );
    }
    return {
      success: true,
      ddlCode: reconstructed.ddl,
      objectInfo,
      ddlFidelity: 'reconstructed',
      note: `DDL was reconstructed from ${runtime.kind} metadata.`,
      warnings: reconstructed.warnings,
    };
  }

  throw new SchemaDdlUnavailableError(
    `DDL for ${objectType || 'this object type'} is not available in the web schema explorer yet.`,
  );
}
