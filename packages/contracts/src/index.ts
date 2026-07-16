export type { DatabaseKind, DatabaseCapabilities, DatabaseDialect, DatabaseSqlAuthoring } from './database';
export { DEFAULT_DATABASE_KIND, DATABASE_KIND_DISPLAY_NAMES, SUPPORTED_DATABASE_KINDS, createDatabaseCapabilities, createDatabaseDialectTraits } from './database';
export type { DatabaseConnection, DatabaseCommand, DatabaseDataReader } from './database';
export type { DatabaseConnectionConfig, DatabaseConnectionConstructor, DatabaseConnectionStaticConstructor } from './database';
export type { DatabaseConnectionFormSchema, DatabaseConnectionOptions, DatabaseConnectionFieldSchema, DatabaseConnectionFieldType, DatabaseConnectionFieldOption, DatabaseConnectionOptionValue } from './database';
export type { DatabaseMetadataProvider, DatabaseColumnQueryOptions, DatabaseColumnLookupParams, DatabaseMirroredSystemCatalog, DatabaseSourceSearchQueryOptions } from './database';
export type { DatabaseDialectTraits, DatabaseIdentifierTraits, DatabaseQualificationTraits, DatabaseCompletionTraits, DatabaseObjectSupportTraits, DatabaseDialectTraitsOverrides } from './database';

export type { DatabaseAdvancedFeatures, DatabaseDdlProvider, DatabaseDdlColumnInfo, DatabaseDdlKeyInfo, DatabaseDdlResult, DatabaseProcedureInfo, DatabaseExternalTableInfo, DatabaseBatchDDLOptions, DatabaseBatchDDLResult, DatabaseImportDataType, DatabaseColumnTypeChooser, DatabaseImportTypeMapper, DatabaseTuningAdvisor, DatabaseTuningAdvisorInput, DatabaseMaintenanceProvider, DatabaseMaintenanceTarget, DatabaseMaintenanceServices, DatabasePartitionInfo, DatabaseCreatePartitionOptions, DatabaseAttachPartitionOptions, DatabaseIndexInfo, DatabaseCreateIndexOptions, DatabaseSessionMonitorProvider, DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from './database';

export type { ConnectionDetails, NamedConnectionDetails } from './connectionDetails';

export type { TuningReport, TuningRecommendation, TuningEvidence, TuningSeverity, TuningRisk, TuningEvidenceSource, TuningReportMetadata } from './tuning/types';
export { clampConfidence, buildTuningSummary, createTuningReport } from './tuning/types';

export type {
  ApiError,
  AuthResponse,
  ConnectionProfileInput,
  ConnectionProfileUpdate,
  ConnectionProfileSummary,
  HistoryEntry,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
  EditorPreferences,
  EditorPreferencesPatch,
  QueryColumnFilterSpec,
  QueryPageRequest,
  QueryPageResponse,
  QueryProgressEvent,
  QuerySessionEvent,
  QuerySortSpec,
  QueryExportFormat,
  QueryExportRequest,
  SchemaNodeKind,
  SchemaSearchRequest,
  SchemaSearchResponse,
  SchemaSearchResult,
  SchemaTreeNode,
  SchemaTreeResponse,
  QueryCancelledEvent,
  QueryColumnsEvent,
  QueryColumn,
  QueryCompleteEvent,
  QueryErrorEvent,
  QueryEvent,
  QueryRowsEvent,
  QueryStartRequest,
  QueryStartResponse,
  QueryStartedEvent,
  SqlCompletionItem,
  SqlCompletionRequest,
  SqlCompletionResponse,
  SqlDiagnostic,
  SqlDiagnosticsRequest,
  SqlDiagnosticsResponse,
  SqlDiagnosticPosition,
  SqlLanguageContext,
  WebUser,
} from './webApi';
