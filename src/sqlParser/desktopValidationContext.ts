import { getDatabaseSqlAuthoring } from '../core/connectionFactory';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { createMetadataCacheSchemaProvider } from './metadataCacheAdapter';
import { SqlCoreBackedValidator } from './sqlCoreBackedValidator';
import { SqlValidator } from './validator';
import type { SchemaProvider } from './schemaProvider';
import type { SqlValidationService } from './validationService';

export interface SqlValidationContext {
  metadataCache: MetadataCache;
  connectionManager: ConnectionManager;
}

let validatorInstance: SqlValidationService | undefined;
let validationContext: SqlValidationContext | undefined;

export function initializeDesktopSqlValidator(
  metadataCache: MetadataCache,
  connectionManager: ConnectionManager,
): void {
  validationContext = { metadataCache, connectionManager };
  validatorInstance = createDesktopSqlValidatorForDocument();
}

export function getDesktopSqlValidationContext(): SqlValidationContext | undefined {
  return validationContext;
}

export function getDesktopSqlAuthoringForDocument(documentUri?: string) {
  const databaseKind = validationContext?.connectionManager.getExecutionDatabaseKind?.(documentUri);
  return getDatabaseSqlAuthoring(databaseKind);
}

export function createDesktopSqlValidatorForDocument(
  documentUri?: string,
  schemaProvider?: SchemaProvider,
): SqlValidationService {
  const authoring = getDesktopSqlAuthoringForDocument(documentUri);
  const databaseKind = validationContext?.connectionManager.getExecutionDatabaseKind?.(documentUri);
  // Keep every non-Netezza authoring profile on its established validator
  // until its dialect pack is migrated. Netezza is the first native semantic
  // sql-core consumer and still presents the same desktop facade.
  const Validator = !databaseKind || databaseKind === 'netezza'
    ? SqlCoreBackedValidator
    : SqlValidator;

  if (schemaProvider) {
    return new Validator(schemaProvider, authoring.validation);
  }

  if (!validationContext) {
    return new Validator(undefined, authoring.validation);
  }

  const connectionName = validationContext.connectionManager.resolveConnectionName?.(documentUri);
  if (!connectionName) {
    return new Validator(undefined, authoring.validation);
  }

  const resolvedSchemaProvider = createMetadataCacheSchemaProvider(
    validationContext.metadataCache,
    validationContext.connectionManager,
    connectionName,
    documentUri,
  );

  return new Validator(resolvedSchemaProvider, authoring.validation);
}

export function getInitializedDesktopSqlValidator(
  documentUri?: string,
): SqlValidationService | undefined {
  if (documentUri && validationContext) {
    return createDesktopSqlValidatorForDocument(documentUri);
  }

  return validatorInstance;
}
