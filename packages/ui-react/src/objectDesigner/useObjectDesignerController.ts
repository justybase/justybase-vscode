import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DatabaseDesignerCapability,
  DatabaseDesignerCapabilityKey,
  DatabaseObjectSnapshot,
  DatabaseKind,
  DesignerCapabilitiesResponse,
  MetadataColumn,
  MetadataObject,
  QueryEvent,
  QueryPreviewResponse,
  SchemaTreeNode,
} from '@justybase/contracts';
import type { ObjectDesignerApi, ObjectDesignerQueryEventSubscription } from './types';
import { formatQueryObjectName } from '@justybase/dialect-utils';
import {
  buildObjectDesignerSql,
  type ClickHousePartitionOperationInput,
  type ClickHouseSkippingIndexInput,
  type DesignerForeignKeyInput,
  type DesignerRoutineInput,
  type DesignerTriggerInput,
  type NetezzaPhysicalDesignInput,
  type SnowflakeClusteringInput,
  type VerticaProjectionInput,
  type ObjectDesignerDraft,
} from '@justybase/designer-core';
import { getDesignerTargetFlags, isMutatingCapability, viewDefinitionFromMetadata, type DesignerTab } from './model';

function qualifyDesignerTarget(target: SchemaTreeNode, databaseKind: DatabaseKind, database: string): string {
  return formatQueryObjectName({
    database: target.database ?? database,
    schema: target.schema,
    objectName: target.objectName ?? target.label,
  }, databaseKind);
}

export interface ObjectDesignerControllerProps {
  api: ObjectDesignerApi;
  connectionId: string;
  database: string;
  databaseKind: DatabaseKind;
  target: SchemaTreeNode;
  onApplied(): void;
}

export function useObjectDesignerController({
  api,
  connectionId,
  database,
  databaseKind,
  target,
  onApplied,
}: ObjectDesignerControllerProps) {
  const [activeTab, setActiveTab] = useState<DesignerTab>('overview');
  const [context, setContext] = useState<DesignerCapabilitiesResponse | null>(null);
  const [snapshot, setSnapshot] = useState<DatabaseObjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState('VARCHAR(255)');
  const [columnNotNull, setColumnNotNull] = useState(false);
  const [columnDefault, setColumnDefault] = useState('');
  const [columns, setColumns] = useState<MetadataColumn[]>([]);
  const [referenceTables, setReferenceTables] = useState<MetadataObject[]>([]);
  const [referenceTableColumns, setReferenceTableColumns] = useState<MetadataColumn[]>([]);
  const [indexName, setIndexName] = useState('');
  const [indexColumns, setIndexColumns] = useState('');
  const [indexUnique, setIndexUnique] = useState(false);
  const [indexOperation, setIndexOperation] = useState<'create' | 'drop'>('create');
  const [distributionChanged, setDistributionChanged] = useState(false);
  const [distributionMethod, setDistributionMethod] = useState<NetezzaPhysicalDesignInput['distributionMethod']>('RANDOM');
  const [distributionColumns, setDistributionColumns] = useState('');
  const [organizationColumns, setOrganizationColumns] = useState('');
  const [organizationNone, setOrganizationNone] = useState(false);
  const [organizationMaxRowsPerZone, setOrganizationMaxRowsPerZone] = useState('');
  const [clickHouseIndex, setClickHouseIndex] = useState<ClickHouseSkippingIndexInput>({ name: '', expression: '', indexType: 'minmax', granularity: '1' });
  const [clickHousePartition, setClickHousePartition] = useState<ClickHousePartitionOperationInput>({ action: 'DROP', partition: '' });
  const [verticaProjection, setVerticaProjection] = useState<VerticaProjectionInput>({ name: '', columns: '', orderBy: '', segmentation: '', kSafety: '1' });
  const [snowflakeClustering, setSnowflakeClustering] = useState<SnowflakeClusteringInput>({ expressions: '' });
  const [constraintType, setConstraintType] = useState<'foreignKey' | 'check'>('foreignKey');
  const [constraintOperation, setConstraintOperation] = useState<'create' | 'drop'>('create');
  const [constraintName, setConstraintName] = useState('');
  const [foreignKeyColumns, setForeignKeyColumns] = useState('');
  const [referencedSchema, setReferencedSchema] = useState(target.schema ?? '');
  const [referencedTable, setReferencedTable] = useState('');
  const [referencedColumns, setReferencedColumns] = useState('');
  const [foreignKeyMatch, setForeignKeyMatch] = useState<DesignerForeignKeyInput['match']>('');
  const [foreignKeyOnDelete, setForeignKeyOnDelete] = useState<DesignerForeignKeyInput['onDelete']>('');
  const [foreignKeyOnUpdate, setForeignKeyOnUpdate] = useState<DesignerForeignKeyInput['onUpdate']>('');
  const [foreignKeyDeferrable, setForeignKeyDeferrable] = useState(false);
  const [foreignKeyInitiallyDeferred, setForeignKeyInitiallyDeferred] = useState(false);
  const [foreignKeyNotValid, setForeignKeyNotValid] = useState(false);
  const [checkExpression, setCheckExpression] = useState('');
  const [checkNotValid, setCheckNotValid] = useState(false);
  const [triggerName, setTriggerName] = useState('');
  const [triggerOperation, setTriggerOperation] = useState<'create' | 'drop'>('create');
  const [triggerTiming, setTriggerTiming] = useState<DesignerTriggerInput['timing']>('BEFORE');
  const [triggerEvent, setTriggerEvent] = useState<DesignerTriggerInput['event']>('INSERT');
  const [triggerUpdateColumns, setTriggerUpdateColumns] = useState('');
  const [triggerLevel, setTriggerLevel] = useState<DesignerTriggerInput['level']>('ROW');
  const [triggerWhen, setTriggerWhen] = useState('');
  const [triggerBody, setTriggerBody] = useState('');
  const [viewDefinition, setViewDefinition] = useState('');
  const [viewReplace, setViewReplace] = useState(true);
  const [routineParameters, setRoutineParameters] = useState('');
  const [routineReturnType, setRoutineReturnType] = useState('INTEGER');
  const [routineExecuteAs, setRoutineExecuteAs] = useState<DesignerRoutineInput['executeAs']>('OWNER');
  const [routineBody, setRoutineBody] = useState('RETURN 1;');
  const [draftSql, setDraftSql] = useState('');
  const [previewSql, setPreviewSql] = useState('');
  const [preview, setPreview] = useState<QueryPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const subscriptionRef = useRef<ObjectDesignerQueryEventSubscription | null>(null);

  const targetWithContext = useMemo(() => ({
    ...target,
    kind: 'object' as const,
    database: target.database ?? database,
  }), [database, target]);
  const targetSql = useMemo(() => qualifyDesignerTarget(targetWithContext, databaseKind, database), [database, databaseKind, targetWithContext]);
  const { isTableTarget, isViewTarget, isRoutineTarget } = getDesignerTargetFlags(target);
  const tableDefinition = snapshot?.definition.kind === 'table' ? snapshot.definition : undefined;

  const generatedSql = useMemo(() => {
    try {
      const draft: ObjectDesignerDraft = {
        activeTab,
        columnName,
        columnType,
        columnNotNull,
        columnDefault,
        indexName,
        indexColumns,
        indexUnique,
        indexOperation,
        distributionChanged,
        distributionMethod,
        distributionColumns,
        organizationColumns,
        organizationNone,
        organizationMaxRowsPerZone,
        clickHouseIndex,
        clickHousePartition,
        verticaProjection,
        snowflakeClustering,
        constraintType,
        constraintOperation,
        constraintName,
        foreignKeyColumns,
        referencedSchema,
        referencedTable,
        referencedColumns,
        foreignKeyMatch,
        foreignKeyOnDelete,
        foreignKeyOnUpdate,
        foreignKeyDeferrable,
        foreignKeyInitiallyDeferred,
        foreignKeyNotValid,
        checkExpression,
        checkNotValid,
        triggerName,
        triggerOperation,
        triggerTiming,
        triggerEvent,
        triggerUpdateColumns,
        triggerLevel,
        triggerWhen,
        triggerBody,
        viewDefinition,
        viewReplace,
        routineParameters,
        routineReturnType,
        routineExecuteAs,
        routineBody,
      };
      return buildObjectDesignerSql({
        targetSql,
        databaseKind,
        targetObjectType: target.objectType,
        capabilities: context?.capabilities,
        draft,
      });
    } catch {
      return '';
    }
  }, [activeTab, checkExpression, checkNotValid, clickHouseIndex, clickHousePartition, columnDefault, columnName, columnNotNull, columnType, constraintName, constraintOperation, constraintType, context, databaseKind, distributionChanged, distributionColumns, distributionMethod, foreignKeyColumns, foreignKeyDeferrable, foreignKeyInitiallyDeferred, foreignKeyMatch, foreignKeyNotValid, foreignKeyOnDelete, foreignKeyOnUpdate, indexColumns, indexName, indexOperation, indexUnique, isRoutineTarget, isTableTarget, isViewTarget, organizationColumns, organizationMaxRowsPerZone, organizationNone, referencedColumns, referencedSchema, referencedTable, routineBody, routineExecuteAs, routineParameters, routineReturnType, snowflakeClustering, target.objectType, targetSql, triggerBody, triggerEvent, triggerLevel, triggerName, triggerOperation, triggerTiming, triggerUpdateColumns, triggerWhen, verticaProjection, viewDefinition, viewReplace]);

  useEffect(() => {
    let disposed = false;
    const requiresSnapshot = (isTableTarget || isViewTarget)
      && (databaseKind === 'sqlite' || databaseKind === 'duckdb')
      && Boolean(target.schema && (target.objectName ?? target.label));
    let capabilitiesLoaded = false;
    let snapshotLoaded = !requiresSnapshot;
    const finishLoading = (): void => {
      if (!disposed && capabilitiesLoaded && snapshotLoaded) setLoading(false);
    };
    setLoading(true);
    setActiveTab('overview');
    setContext(null);
    setSnapshot(null);
    setError('');
    setNotice('');
    setColumns([]);
    setReferenceTables([]);
    setReferenceTableColumns([]);
    setColumnName('');
    setColumnType('VARCHAR(255)');
    setColumnNotNull(false);
    setColumnDefault('');
    setIndexName('');
    setIndexColumns('');
    setIndexUnique(false);
    setIndexOperation('create');
    setDistributionChanged(false);
    setDistributionMethod('RANDOM');
    setDistributionColumns('');
    setOrganizationColumns('');
    setOrganizationNone(false);
    setOrganizationMaxRowsPerZone('');
    setClickHouseIndex({ name: '', expression: '', indexType: 'minmax', granularity: '1' });
    setClickHousePartition({ action: 'DROP', partition: '' });
    setVerticaProjection({ name: '', columns: '', orderBy: '', segmentation: '', kSafety: '1' });
    setSnowflakeClustering({ expressions: '' });
    setPreview(null);
    setPreviewSql('');
    setDraftSql('');
    setConstraintType('foreignKey');
    setConstraintOperation('create');
    setConstraintName('');
    setForeignKeyColumns('');
    setReferencedSchema(target.schema ?? '');
    setReferencedTable('');
    setReferencedColumns('');
    setForeignKeyMatch('');
    setForeignKeyOnDelete('');
    setForeignKeyOnUpdate('');
    setForeignKeyDeferrable(false);
    setForeignKeyInitiallyDeferred(false);
    setForeignKeyNotValid(false);
    setCheckExpression('');
    setCheckNotValid(false);
    setTriggerName('');
    setTriggerOperation('create');
    setTriggerTiming('BEFORE');
    setTriggerEvent('INSERT');
    setTriggerUpdateColumns('');
    setTriggerLevel('ROW');
    setTriggerWhen('');
    setTriggerBody('');
    setViewDefinition(viewDefinitionFromMetadata(target.viewSql, target.description));
    setViewReplace(true);
    setRoutineParameters('');
    setRoutineReturnType('INTEGER');
    setRoutineExecuteAs('OWNER');
    setRoutineBody('RETURN 1;');
    void api.designerCapabilities({
      connectionId,
      database: target.database ?? database,
      schema: target.schema,
      objectName: target.objectName ?? target.label,
      objectType: target.objectType ?? 'TABLE',
    }).then(response => {
      if (disposed) return;
      setContext(response);
    }).catch(reason => {
      if (disposed) return;
      setError(reason instanceof Error ? reason.message : 'Could not load designer capabilities.');
    }).finally(() => {
      capabilitiesLoaded = true;
      finishLoading();
    });
    if (isTableTarget && target.schema && (target.objectName ?? target.label)) {
      void api.columns(connectionId, target.database ?? database, target.schema, target.objectName ?? target.label)
        .then(response => { if (!disposed) setColumns([...response]); })
        .catch(() => { if (!disposed) setColumns([]); });
    }
    if (requiresSnapshot) {
      void api.designerSnapshot({
        connectionId,
        database: target.database ?? database,
        schema: target.schema,
        objectName: target.objectName ?? target.label,
        objectType: isViewTarget ? 'VIEW' : 'TABLE',
      }).then(response => {
        if (disposed) return;
        setSnapshot(response.snapshot);
        if (response.snapshot.definition.kind === 'view') setViewDefinition(response.snapshot.definition.query);
      }).catch(() => { if (!disposed) setSnapshot(null); }).finally(() => {
        snapshotLoaded = true;
        finishLoading();
      });
    }
    return () => {
      disposed = true;
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
    };
  }, [api, connectionId, database, databaseKind, isTableTarget, target.database, target.description, target.label, target.objectName, target.objectType, target.schema, target.viewSql]);

  useEffect(() => {
    let disposed = false;
    setReferenceTables([]);
    setReferenceTableColumns([]);
    if (!isTableTarget || !referencedSchema.trim()) return () => { disposed = true; };
    void api.objects(connectionId, target.database ?? database, referencedSchema.trim())
      .then(objects => {
        if (disposed) return;
        setReferenceTables(objects.filter(object => (object.objectType ?? '').toUpperCase() === 'TABLE'));
      })
      .catch(() => { if (!disposed) setReferenceTables([]); });
    return () => { disposed = true; };
  }, [api, connectionId, database, isTableTarget, referencedSchema, target.database]);

  useEffect(() => {
    let disposed = false;
    setReferenceTableColumns([]);
    const table = referencedTable.trim();
    if (!isTableTarget || !referencedSchema.trim() || !table) return () => { disposed = true; };
    void api.columns(connectionId, target.database ?? database, referencedSchema.trim(), table)
      .then(nextColumns => { if (!disposed) setReferenceTableColumns([...nextColumns]); })
      .catch(() => { if (!disposed) setReferenceTableColumns([]); });
    return () => { disposed = true; };
  }, [api, connectionId, database, isTableTarget, referencedSchema, referencedTable, target.database]);

  useEffect(() => {
    const triggerCapability = context?.capabilities.constructs.triggers.trigger;
    if (!triggerCapability) return;
    const objectKind = (target.objectType ?? 'TABLE').toUpperCase();
    const timings = triggerCapability.timingsByObjectKind?.[objectKind] ?? triggerCapability.timings;
    const nextTiming = timings.includes(triggerTiming) ? triggerTiming : timings[0];
    if (nextTiming && nextTiming !== triggerTiming) setTriggerTiming(nextTiming);
    const levels = triggerCapability.levelsByTiming?.[nextTiming ?? triggerTiming] ?? triggerCapability.levels;
    if (levels.length > 0 && !levels.includes(triggerLevel)) setTriggerLevel(levels[0]!);
  }, [context, target.objectType, triggerLevel, triggerTiming]);

  useEffect(() => {
    if (!generatedSql || preview || applying) return;
    setDraftSql(generatedSql);
  }, [generatedSql, preview, applying]);

  function currentCapability(key: DatabaseDesignerCapabilityKey): DatabaseDesignerCapability | undefined {
    return context?.capabilities.constructs[key];
  }

  function resetMessage(): void {
    setError('');
    setNotice('');
  }

  async function requestPreview(): Promise<void> {
    resetMessage();
    const sql = draftSql.trim() || generatedSql.trim();
    if (!sql) {
      setError('Complete the active designer form before requesting SQL preview.');
      return;
    }
    if (!context?.runtimeAvailable) {
      setError('This database runtime is not available in the web API.');
      return;
    }
    setPreviewing(true);
    try {
      const response = await api.previewQuery({
        connectionId,
        database: target.database ?? database,
        sql,
        mode: 'script',
        ...(snapshot ? { designer: { target: snapshot.target, baseFingerprint: snapshot.fingerprint } } : {}),
      });
      setPreview(response);
      setPreviewSql(sql);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'SQL preview failed.');
    } finally {
      setPreviewing(false);
    }
  }

  function handleQueryEvent(event: QueryEvent): void {
    if (event.type === 'complete') {
      if ((event.statementCount ?? 1) > 1) {
        setNotice(`Statement ${(event.statementIndex ?? 0) + 1} completed; waiting for the rest of the change plan.`);
        return;
      }
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      setApplying(false);
      setNotice('Database change applied successfully. Metadata will refresh when the designer is reopened.');
      setPreview(null);
      setPreviewSql('');
      onApplied();
      return;
    }
    if (event.type === 'batch-complete') {
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      setApplying(false);
      if (event.status === 'complete') {
        setNotice('Database change applied successfully. Metadata will refresh when the designer is reopened.');
        setPreview(null);
        setPreviewSql('');
        onApplied();
      } else if (event.status === 'cancelled') {
        setError('Database change was cancelled.');
      } else {
        setError(event.message ?? 'Database change failed.');
      }
      return;
    }
    if (event.type === 'error') {
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      setApplying(false);
      setError(event.message);
      return;
    }
    if (event.type === 'cancelled') {
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      setApplying(false);
      setError('Database change was cancelled.');
    }
  }

  async function applyPreview(): Promise<void> {
    resetMessage();
    if (!preview || preview.statements.length === 0) {
      setError('Preview the exact SQL before applying it.');
      return;
    }
    if (preview.readOnly || context?.readOnly) {
      setError('The selected connection is read-only.');
      return;
    }
    setApplying(true);
    try {
      const started = await api.startQuery({
        connectionId,
        database: target.database ?? database,
        sql: previewSql,
        mode: 'script',
        writeConfirmed: true,
        writePreviewToken: preview.previewToken,
        ...(snapshot ? { designer: { target: snapshot.target, baseFingerprint: snapshot.fingerprint } } : {}),
      });
      subscriptionRef.current?.close();
      subscriptionRef.current = api.connectToQueryEvents(started.queryId, handleQueryEvent, reason => {
        setApplying(false);
        setError(reason.message);
      });
    } catch (reason: unknown) {
      setApplying(false);
      setError(reason instanceof Error ? reason.message : 'Database change failed.');
    }
  }

  return {
    activeTab,
    setActiveTab,
    context,
    snapshot,
    loading,
    error,
    notice,
    targetSql,
    isTableTarget,
    isViewTarget,
    isRoutineTarget,
    tableDefinition,
    generatedSql,
    draftSql,
    setDraftSql,
    preview,
    setPreview,
    previewSql,
    previewing,
    applying,
    columns,
    referenceTables,
    referenceTableColumns,
    columnName,
    setColumnName,
    columnType,
    setColumnType,
    columnNotNull,
    setColumnNotNull,
    columnDefault,
    setColumnDefault,
    indexName,
    setIndexName,
    indexColumns,
    setIndexColumns,
    indexUnique,
    setIndexUnique,
    indexOperation,
    setIndexOperation,
    distributionChanged,
    setDistributionChanged,
    distributionMethod,
    setDistributionMethod,
    distributionColumns,
    setDistributionColumns,
    organizationColumns,
    setOrganizationColumns,
    organizationNone,
    setOrganizationNone,
    organizationMaxRowsPerZone,
    setOrganizationMaxRowsPerZone,
    clickHouseIndex,
    setClickHouseIndex,
    clickHousePartition,
    setClickHousePartition,
    verticaProjection,
    setVerticaProjection,
    snowflakeClustering,
    setSnowflakeClustering,
    constraintType,
    setConstraintType,
    constraintOperation,
    setConstraintOperation,
    constraintName,
    setConstraintName,
    foreignKeyColumns,
    setForeignKeyColumns,
    referencedSchema,
    setReferencedSchema,
    referencedTable,
    setReferencedTable,
    referencedColumns,
    setReferencedColumns,
    foreignKeyMatch,
    setForeignKeyMatch,
    foreignKeyOnDelete,
    setForeignKeyOnDelete,
    foreignKeyOnUpdate,
    setForeignKeyOnUpdate,
    foreignKeyDeferrable,
    setForeignKeyDeferrable,
    foreignKeyInitiallyDeferred,
    setForeignKeyInitiallyDeferred,
    foreignKeyNotValid,
    setForeignKeyNotValid,
    checkExpression,
    setCheckExpression,
    checkNotValid,
    setCheckNotValid,
    triggerName,
    setTriggerName,
    triggerOperation,
    setTriggerOperation,
    triggerTiming,
    setTriggerTiming,
    triggerEvent,
    setTriggerEvent,
    triggerUpdateColumns,
    setTriggerUpdateColumns,
    triggerLevel,
    setTriggerLevel,
    triggerWhen,
    setTriggerWhen,
    triggerBody,
    setTriggerBody,
    viewDefinition,
    setViewDefinition,
    viewReplace,
    setViewReplace,
    routineParameters,
    setRoutineParameters,
    routineReturnType,
    setRoutineReturnType,
    routineExecuteAs,
    setRoutineExecuteAs,
    routineBody,
    setRoutineBody,
    currentCapability,
    requestPreview,
    applyPreview,
    resetMessage,
    isMutatingCapability,
  };
}
