import type {
  DatabaseDesignerCapabilities,
  DatabaseDesignerCapabilityKey,
  DatabaseKind,
} from '@justybase/contracts';
import {
  buildAddColumnSql,
  buildCheckConstraintSql,
  buildClickHousePartitionOperationSql,
  buildClickHouseSkippingIndexDropSql,
  buildClickHouseSkippingIndexSql,
  buildDropConstraintSql,
  buildDropIndexSql,
  buildDropTriggerSql,
  buildForeignKeySql,
  buildNetezzaOrganizationSql,
  buildNetezzaPhysicalDesignSql,
  buildNetezzaRoutineSql,
  buildRelationalIndexSql,
  buildSnowflakeClusteringDropSql,
  buildSnowflakeClusteringSql,
  buildTriggerSql,
  buildVerticaProjectionDropSql,
  buildVerticaProjectionSql,
  buildViewSql,
  type ClickHousePartitionOperationInput,
  type ClickHouseSkippingIndexInput,
  type DesignerCheckConstraintInput,
  type DesignerColumnInput,
  type DesignerForeignKeyInput,
  type DesignerRelationalIndexInput,
  type DesignerRoutineInput,
  type DesignerTriggerInput,
  type DesignerViewInput,
  type NetezzaPhysicalDesignInput,
  type SnowflakeClusteringInput,
  type VerticaProjectionInput,
} from './objectDesignerSql';
import { getDesignerTargetFlags, type DesignerTab } from './objectDesignerModel';

export interface ObjectDesignerDraft {
  activeTab: DesignerTab;
  columnName: string;
  columnType: string;
  columnNotNull: boolean;
  columnDefault: string;
  indexName: string;
  indexColumns: string;
  indexUnique: boolean;
  indexOperation: 'create' | 'drop';
  distributionChanged: boolean;
  distributionMethod: NetezzaPhysicalDesignInput['distributionMethod'];
  distributionColumns: string;
  organizationColumns: string;
  organizationNone: boolean;
  organizationMaxRowsPerZone: string;
  clickHouseIndex: ClickHouseSkippingIndexInput;
  clickHousePartition: ClickHousePartitionOperationInput;
  verticaProjection: VerticaProjectionInput;
  snowflakeClustering: SnowflakeClusteringInput;
  constraintType: 'foreignKey' | 'check';
  constraintOperation: 'create' | 'drop';
  constraintName: string;
  foreignKeyColumns: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string;
  foreignKeyMatch: DesignerForeignKeyInput['match'];
  foreignKeyOnDelete: DesignerForeignKeyInput['onDelete'];
  foreignKeyOnUpdate: DesignerForeignKeyInput['onUpdate'];
  foreignKeyDeferrable: boolean;
  foreignKeyInitiallyDeferred: boolean;
  foreignKeyNotValid: boolean;
  checkExpression: string;
  checkNotValid: boolean;
  triggerName: string;
  triggerOperation: 'create' | 'drop';
  triggerTiming: DesignerTriggerInput['timing'];
  triggerEvent: DesignerTriggerInput['event'];
  triggerUpdateColumns: string;
  triggerLevel: DesignerTriggerInput['level'];
  triggerWhen: string;
  triggerBody: string;
  viewDefinition: string;
  viewReplace: boolean;
  routineParameters: string;
  routineReturnType: string;
  routineExecuteAs: DesignerRoutineInput['executeAs'];
  routineBody: string;
}

export interface ObjectDesignerSqlInput {
  targetSql: string;
  databaseKind: DatabaseKind;
  targetObjectType?: string;
  capabilities?: DatabaseDesignerCapabilities | null;
  draft: ObjectDesignerDraft;
}

function targetFlags(targetObjectType: string | undefined) {
  return getDesignerTargetFlags({
    id: 'designer-target',
    kind: 'object',
    label: '',
    objectType: targetObjectType ?? 'TABLE',
    hasChildren: false,
  });
}

function capabilityKeyForDraft(draft: ObjectDesignerDraft, isViewTarget: boolean): DatabaseDesignerCapabilityKey {
  if (draft.activeTab === 'definition') return isViewTarget ? 'views' : 'procedures';
  if (draft.activeTab === 'columns') return 'alterTable';
  if (draft.activeTab === 'indexes') return 'indexes';
  if (draft.activeTab === 'partitions') return 'partitions';
  if (draft.activeTab === 'triggers') return 'triggers';
  return draft.constraintType === 'foreignKey' ? 'foreignKeys' : 'checks';
}

/**
 * Selects the same dialect builder previously embedded in the React hook.
 * It intentionally owns no I/O and throws the builder validation errors to
 * let each UI adapter decide how to present them.
 */
export function buildObjectDesignerSql(input: ObjectDesignerSqlInput): string {
  const { draft, targetSql, databaseKind } = input;
  const { isTableTarget, isViewTarget, isRoutineTarget } = targetFlags(input.targetObjectType);
  if (!isTableTarget && !isViewTarget && !isRoutineTarget) return '';

  const capabilityKey = capabilityKeyForDraft(draft, isViewTarget);
  const capability = input.capabilities?.constructs[capabilityKey];

  if (draft.activeTab === 'definition') {
    if (isViewTarget) {
      const viewInput: DesignerViewInput = {
        definition: draft.viewDefinition,
        replace: draft.viewReplace && capability?.view?.replaceStyle !== 'create',
      };
      return buildViewSql(targetSql, viewInput, capability);
    }
    const routineInput: DesignerRoutineInput = {
      parameters: draft.routineParameters,
      returnType: draft.routineReturnType,
      executeAs: draft.routineExecuteAs,
      body: draft.routineBody,
    };
    return buildNetezzaRoutineSql(targetSql, routineInput, capability);
  }

  if (draft.activeTab === 'columns') {
    const columnInput: DesignerColumnInput = {
      name: draft.columnName,
      dataType: draft.columnType,
      notNull: draft.columnNotNull,
      defaultExpression: draft.columnDefault,
    };
    return buildAddColumnSql(targetSql, databaseKind, columnInput, capability);
  }

  if (draft.activeTab === 'indexes') {
    if (databaseKind === 'netezza') {
      return buildNetezzaOrganizationSql(targetSql, {
        organizationColumns: draft.organizationColumns,
        organizationNone: draft.organizationNone,
        organizationMaxRowsPerZone: draft.organizationMaxRowsPerZone,
      }, capability);
    }
    if (databaseKind === 'clickhouse') {
      return draft.indexOperation === 'drop'
        ? buildClickHouseSkippingIndexDropSql(targetSql, draft.clickHouseIndex.name, capability)
        : buildClickHouseSkippingIndexSql(targetSql, draft.clickHouseIndex, capability);
    }
    if (databaseKind === 'vertica') {
      return draft.indexOperation === 'drop'
        ? buildVerticaProjectionDropSql(draft.verticaProjection.name, capability)
        : buildVerticaProjectionSql(targetSql, draft.verticaProjection, capability);
    }
    if (databaseKind === 'snowflake') {
      return draft.indexOperation === 'drop'
        ? buildSnowflakeClusteringDropSql(targetSql, capability)
        : buildSnowflakeClusteringSql(targetSql, draft.snowflakeClustering, capability);
    }
    const indexInput: DesignerRelationalIndexInput = {
      name: draft.indexName,
      columns: draft.indexColumns,
      unique: draft.indexUnique,
    };
    return draft.indexOperation === 'drop'
      ? buildDropIndexSql(targetSql, databaseKind, draft.indexName, capability)
      : buildRelationalIndexSql(targetSql, databaseKind, indexInput, capability);
  }

  if (draft.activeTab === 'constraints' && draft.constraintType === 'foreignKey') {
    if (draft.constraintOperation === 'drop') {
      return buildDropConstraintSql(targetSql, databaseKind, draft.constraintName, 'foreignKey', capability);
    }
    const foreignKeyInput: DesignerForeignKeyInput = {
      name: draft.constraintName,
      columns: draft.foreignKeyColumns,
      referencedSchema: draft.referencedSchema,
      referencedTable: draft.referencedTable,
      referencedColumns: draft.referencedColumns,
      match: draft.foreignKeyMatch,
      onDelete: draft.foreignKeyOnDelete,
      onUpdate: draft.foreignKeyOnUpdate,
      deferrable: draft.foreignKeyDeferrable,
      initiallyDeferred: draft.foreignKeyInitiallyDeferred,
      notValid: draft.foreignKeyNotValid,
    };
    return buildForeignKeySql(targetSql, databaseKind, foreignKeyInput, capability);
  }

  if (draft.activeTab === 'constraints') {
    if (draft.constraintOperation === 'drop') {
      return buildDropConstraintSql(targetSql, databaseKind, draft.constraintName, 'check', capability);
    }
    const checkInput: DesignerCheckConstraintInput = {
      name: draft.constraintName,
      expression: draft.checkExpression,
      notValid: draft.checkNotValid,
    };
    return buildCheckConstraintSql(targetSql, databaseKind, checkInput, capability);
  }

  if (draft.activeTab === 'partitions' && databaseKind === 'netezza') {
    const physicalDesignInput: NetezzaPhysicalDesignInput = {
      distributionChanged: draft.distributionChanged,
      distributionMethod: draft.distributionMethod,
      distributionColumns: draft.distributionColumns,
      organizationColumns: draft.organizationColumns,
      organizationNone: draft.organizationNone,
      organizationMaxRowsPerZone: draft.organizationMaxRowsPerZone,
    };
    return buildNetezzaPhysicalDesignSql(targetSql, physicalDesignInput, capability);
  }

  if (draft.activeTab === 'partitions' && databaseKind === 'clickhouse') {
    return buildClickHousePartitionOperationSql(targetSql, draft.clickHousePartition, capability);
  }

  if (draft.activeTab === 'triggers') {
    if (draft.triggerOperation === 'drop') {
      return buildDropTriggerSql(targetSql, databaseKind, { name: draft.triggerName }, capability);
    }
    const triggerInput: DesignerTriggerInput = {
      name: draft.triggerName,
      timing: draft.triggerTiming,
      event: draft.triggerEvent,
      updateColumns: draft.triggerUpdateColumns,
      level: draft.triggerLevel,
      whenExpression: draft.triggerWhen,
      body: draft.triggerBody,
      objectType: input.targetObjectType,
    };
    return buildTriggerSql(targetSql, databaseKind, triggerInput, capability);
  }

  return '';
}
