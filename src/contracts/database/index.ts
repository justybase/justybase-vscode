import type { DatabaseSqlAuthoring } from "../../sql/authoring/types";
import type {
  DatabaseKind as DatabaseKindType,
  DatabaseDialectTraits,
  DatabaseDesignerCapabilities,
  DatabaseAdvancedFeatures,
  DatabaseMetadataProvider,
  DatabaseConnectionFormSchema,
  DatabaseCapabilities,
} from "@justybase/contracts";

export type {
  DatabaseConnection,
  DatabaseCommand,
  DatabaseDataReader,
} from "@justybase/contracts";
export {
  DEFAULT_DATABASE_KIND,
  DATABASE_KIND_DISPLAY_NAMES,
  SUPPORTED_DATABASE_KINDS,
  createDatabaseCapabilities,
  createDatabaseDialectTraits,
  DATABASE_DESIGNER_CAPABILITY_MANIFESTS,
  DESIGNER_CAPABILITY_KEYS,
  DESIGNER_OPERATIONS,
  getDatabaseDesignerCapabilities,
  getDesignerCapability,
  resolveDatabaseDesignerCapabilities,
  normalizeDatabaseKind,
  tryNormalizeDatabaseKind,
} from "@justybase/contracts";
export { UnsupportedDesignerOperationError } from "@justybase/contracts";

export type {
  DatabaseKind,
  DatabaseCapabilities,
  DatabaseConnectionConfig,
  DatabaseConnectionConstructor,
  DatabaseConnectionStaticConstructor,
  DatabaseConnectionFormSchema,
  DatabaseConnectionOptions,
  DatabaseTunnelConfig,
  DatabaseConnectionFieldSchema,
  DatabaseConnectionFieldType,
  DatabaseConnectionFieldOption,
  DatabaseConnectionOptionValue,
  DatabaseMetadataProvider,
  DatabaseColumnQueryOptions,
  DatabaseColumnsWithKeysQuerySet,
  DatabaseColumnLookupParams,
  DatabaseMirroredSystemCatalog,
  DatabaseSourceSearchQueryOptions,
  DatabaseDialectTraits,
  DatabaseIdentifierTraits,
  DatabaseQualificationTraits,
  DatabaseThreePartNamePrefix,
  DatabaseCompletionTraits,
  DatabaseObjectSupportTraits,
  DatabaseDialectTraitsOverrides,
  DatabaseAdvancedFeatures,
  DatabaseDdlProvider,
  DatabaseDdlColumnInfo,
  DatabaseDdlKeyInfo,
  DatabaseDdlResult,
  DatabaseTableDefinitionMetadata,
  DatabaseProcedureInfo,
  DatabaseExternalTableInfo,
  DatabaseBatchDDLOptions,
  DatabaseBatchDDLResult,
  DatabaseImportDataType,
  DatabaseColumnTypeChooser,
  DatabaseImportTypeMapper,
  DatabaseTuningAdvisor,
  DatabaseTuningAdvisorInput,
  DatabaseMaintenanceProvider,
  DatabaseMaintenanceTarget,
  DatabaseMaintenanceServices,
  DatabasePartitionInfo,
  DatabaseCreatePartitionOptions,
  DatabaseAttachPartitionOptions,
  DatabaseIndexInfo,
  DatabaseCreateIndexOptions,
  DatabaseSessionMonitorServices,
  DatabaseSessionMonitorProvider,
  DatabaseCopilotReferenceProvider,
  DatabaseReferenceTopic,
  DatabaseExplainOptions,
  DatabaseExplainProvider,
  DatabaseQueryProfileProvider,
  DatabaseStageLocation,
  DatabaseInlineFileFormatOptions,
  DatabaseCopyIntoTableOptions,
  DatabaseCopyIntoStageOptions,
  DatabaseStageWorkflowProvider,
  DatabaseImportWizardInput,
  DatabaseImportExecutionPlan,
  DatabaseImportWizardProvider,
  DatabaseDesignerCapabilities,
  DatabaseDesignerCapability,
  DatabaseDesignerCapabilityKey,
  DatabaseDesignerColumn,
  DatabaseDesignerConstraint,
  DatabaseDesignerDefinition,
  DatabaseViewDesignerDefinition,
  DatabaseTableDesignerDefinition,
  DatabaseDesignerDiagnostic,
  DatabaseDesignerIndex,
  DatabaseDesignerNativeDefinition,
  DatabaseDesignerPartition,
  DatabaseDesignerProvider,
  DatabaseDesignerRelationalIndex,
  DatabaseDesignerRequirement,
  DatabaseDesignerRuntimeContext,
  DatabaseDesignerTarget,
  DatabaseDesignerTrigger,
  DatabaseDesignerTriggerCapability,
  DatabaseDesignerViewCapability,
  DatabaseDesignerRoutineCapability,
  DatabaseObjectSnapshot,
  DatabaseSchemaChangePlan,
  DatabaseSchemaChangeStatement,
  DesignerCapabilityReasonCode,
  DesignerNativeFeature,
  DesignerOperation,
  DesignerSupportLevel,
  DesignerTriggerBodyStyle,
  DesignerRoutineBodyStyle,
  DesignerTriggerEvent,
  DesignerTriggerLevel,
  DesignerTriggerTiming,
  DesignerViewReplaceStyle,
} from "@justybase/contracts";

export interface DatabaseDialect {
  kind: DatabaseKindType;
  displayName: string;
  defaultPort?: number;
  capabilities: DatabaseCapabilities;
  /** Static baseline; providers may refine this after runtime introspection. */
  designerCapabilities?: DatabaseDesignerCapabilities;
  connectionForm?: DatabaseConnectionFormSchema;
  traits: DatabaseDialectTraits;
  metadataProvider: DatabaseMetadataProvider;
  sqlAuthoring: DatabaseSqlAuthoring;
  advancedFeatures?: DatabaseAdvancedFeatures;
  /** Whether the driver speaks a transparent TCP protocol suitable for the core tunnel. */
  supportsRawTcpTunnel?: boolean;
  getConnectionConstructor(): import("@justybase/contracts").DatabaseConnectionStaticConstructor;
  createConnection(
    config: import("@justybase/contracts").DatabaseConnectionConfig,
  ): import("@justybase/contracts").DatabaseConnection;
}
