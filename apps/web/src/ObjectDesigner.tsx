import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
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
import { api, connectToQueryEvents, type QueryEventSubscription } from './api';
import { qualifySchemaNode } from './SchemaTree';
import {
  buildAddColumnSql,
  buildCheckConstraintSql,
  buildClickHousePartitionOperationSql,
  buildClickHouseSkippingIndexSql,
  buildClickHouseSkippingIndexDropSql,
  buildDropIndexSql,
  buildDropConstraintSql,
  buildDropTriggerSql,
  buildForeignKeySql,
  buildNetezzaRoutineSql,
  buildTriggerSql,
  buildNetezzaOrganizationSql,
  buildNetezzaPhysicalDesignSql,
  buildRelationalIndexSql,
  buildSnowflakeClusteringSql,
  buildSnowflakeClusteringDropSql,
  buildViewSql,
  buildVerticaProjectionSql,
  buildVerticaProjectionDropSql,
  type ClickHousePartitionOperationInput,
  type ClickHouseSkippingIndexInput,
  type DesignerCheckConstraintInput,
  type DesignerColumnInput,
  type DesignerForeignKeyInput,
  type DesignerRoutineInput,
  type DesignerTriggerInput,
  type DesignerViewInput,
  type DesignerRelationalIndexInput,
  type NetezzaPhysicalDesignInput,
  type SnowflakeClusteringInput,
  type VerticaProjectionInput,
} from './objectDesignerSql';

type DesignerTab = 'overview' | 'definition' | 'columns' | 'indexes' | 'partitions' | 'triggers' | 'constraints';

const CAPABILITY_ROWS: ReadonlyArray<{ key: DatabaseDesignerCapabilityKey; label: string }> = [
  { key: 'alterTable', label: 'Table structure' },
  { key: 'indexes', label: 'Indexes / physical design' },
  { key: 'partitions', label: 'Partitions / distribution' },
  { key: 'foreignKeys', label: 'Foreign keys' },
  { key: 'checks', label: 'CHECK constraints' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'views', label: 'Views' },
  { key: 'materializedViews', label: 'Materialized views' },
  { key: 'procedures', label: 'Procedures / functions' },
  { key: 'sequences', label: 'Sequences' },
  { key: 'usersRoles', label: 'Users / roles' },
];

interface ObjectDesignerProps {
  connectionId: string;
  database: string;
  databaseKind: DatabaseKind;
  target: SchemaTreeNode;
  onClose(): void;
  onApplied(): void;
}

function capabilityClass(capability: DatabaseDesignerCapability): string {
  return `object-designer-capability object-designer-capability-${capability.level}`;
}

function capabilityLabel(level: DatabaseDesignerCapability['level']): string {
  switch (level) {
    case 'supported': return 'Supported';
    case 'limited': return 'Limited';
    case 'alternative': return 'Native alternative';
    case 'privilege-blocked': return 'Read-only';
    case 'runtime-unavailable': return 'Runtime unavailable';
    default: return 'Unsupported';
  }
}

function isMutatingCapability(capability: DatabaseDesignerCapability | undefined, operation: 'alter' | 'create' | 'drop' | 'replace'): boolean {
  return Boolean(capability && capability.operations.includes(operation)
    && (capability.level === 'supported' || capability.level === 'limited'));
}

function viewDefinitionFromMetadata(viewSql: string | undefined, description?: string): string {
  const source = (viewSql ?? description)?.trim() ?? '';
  if (!/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(source)) return '';
  const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b[\s\S]*?\bAS\s+([\s\S]*?)\s*;?$/i.exec(source);
  return match?.[1]?.trim().replace(/;\s*$/u, '') ?? '';
}

function ObjectDesigner({ connectionId, database, databaseKind, target, onClose, onApplied }: ObjectDesignerProps): ReactElement {
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
  const subscriptionRef = useRef<QueryEventSubscription | null>(null);

  const targetWithContext = useMemo(() => ({
    ...target,
    kind: 'object' as const,
    database: target.database ?? database,
  }), [database, target]);
  const targetSql = useMemo(() => qualifySchemaNode(targetWithContext, databaseKind), [databaseKind, targetWithContext]);
  const isTableTarget = (target.objectType ?? 'TABLE').toUpperCase() === 'TABLE';
  const isViewTarget = (target.objectType ?? '').toUpperCase() === 'VIEW';
  const isRoutineTarget = ['PROCEDURE', 'FUNCTION'].includes((target.objectType ?? '').toUpperCase());
  const tableDefinition = snapshot?.definition.kind === 'table' ? snapshot.definition : undefined;

  const generatedSql = useMemo(() => {
    try {
      if (!isTableTarget && !isViewTarget && !isRoutineTarget) return '';
      const capabilityKey: DatabaseDesignerCapabilityKey = activeTab === 'definition'
        ? isViewTarget ? 'views' : 'procedures'
        : activeTab === 'columns'
        ? 'alterTable'
        : activeTab === 'indexes' ? 'indexes'
          : activeTab === 'partitions' ? 'partitions'
            : activeTab === 'triggers' ? 'triggers'
              : constraintType === 'foreignKey' ? 'foreignKeys' : 'checks';
      const capability = context?.capabilities.constructs[capabilityKey];
      if (activeTab === 'definition') {
        if (isViewTarget) {
          const input: DesignerViewInput = {
            definition: viewDefinition,
            replace: viewReplace && capability?.view?.replaceStyle !== 'create',
          };
          return buildViewSql(targetSql, input, capability);
        }
        return buildNetezzaRoutineSql(targetSql, {
          parameters: routineParameters,
          returnType: routineReturnType,
          executeAs: routineExecuteAs,
          body: routineBody,
        }, capability);
      }
      if (activeTab === 'columns') {
        const input: DesignerColumnInput = {
          name: columnName,
          dataType: columnType,
          notNull: columnNotNull,
          defaultExpression: columnDefault,
        };
        return buildAddColumnSql(targetSql, databaseKind, input, capability);
      }
      if (activeTab === 'indexes') {
        if (databaseKind === 'netezza') return buildNetezzaOrganizationSql(targetSql, { organizationColumns, organizationNone, organizationMaxRowsPerZone }, capability);
        if (databaseKind === 'clickhouse') return indexOperation === 'drop'
          ? buildClickHouseSkippingIndexDropSql(targetSql, clickHouseIndex.name, capability)
          : buildClickHouseSkippingIndexSql(targetSql, clickHouseIndex, capability);
        if (databaseKind === 'vertica') return indexOperation === 'drop'
          ? buildVerticaProjectionDropSql(verticaProjection.name, capability)
          : buildVerticaProjectionSql(targetSql, verticaProjection, capability);
        if (databaseKind === 'snowflake') return indexOperation === 'drop'
          ? buildSnowflakeClusteringDropSql(targetSql, capability)
          : buildSnowflakeClusteringSql(targetSql, snowflakeClustering, capability);
        const input: DesignerRelationalIndexInput = { name: indexName, columns: indexColumns, unique: indexUnique };
        return indexOperation === 'drop'
          ? buildDropIndexSql(targetSql, databaseKind, indexName, capability)
          : buildRelationalIndexSql(targetSql, databaseKind, input, capability);
      }
      if (activeTab === 'constraints' && constraintType === 'foreignKey') {
        if (constraintOperation === 'drop') return buildDropConstraintSql(targetSql, databaseKind, constraintName, 'foreignKey', capability);
        const input: DesignerForeignKeyInput = {
          name: constraintName,
          columns: foreignKeyColumns,
          referencedSchema,
          referencedTable,
          referencedColumns,
          match: foreignKeyMatch,
          onDelete: foreignKeyOnDelete,
          onUpdate: foreignKeyOnUpdate,
          deferrable: foreignKeyDeferrable,
          initiallyDeferred: foreignKeyInitiallyDeferred,
          notValid: foreignKeyNotValid,
        };
        return buildForeignKeySql(targetSql, databaseKind, input, capability);
      }
      if (activeTab === 'constraints') {
        if (constraintOperation === 'drop') return buildDropConstraintSql(targetSql, databaseKind, constraintName, 'check', capability);
        const input: DesignerCheckConstraintInput = {
          name: constraintName,
          expression: checkExpression,
          notValid: checkNotValid,
        };
        return buildCheckConstraintSql(targetSql, databaseKind, input, capability);
      }
      if (activeTab === 'partitions' && databaseKind === 'netezza') {
        const input: NetezzaPhysicalDesignInput = {
          distributionChanged,
          distributionMethod,
          distributionColumns,
          organizationColumns,
          organizationNone,
          organizationMaxRowsPerZone,
        };
        return buildNetezzaPhysicalDesignSql(targetSql, input, capability);
      }
      if (activeTab === 'partitions' && databaseKind === 'clickhouse') {
        return buildClickHousePartitionOperationSql(targetSql, clickHousePartition, capability);
      }
      if (activeTab === 'triggers') {
        if (triggerOperation === 'drop') return buildDropTriggerSql(targetSql, databaseKind, { name: triggerName }, capability);
        return buildTriggerSql(targetSql, databaseKind, {
          name: triggerName,
          timing: triggerTiming,
          event: triggerEvent,
          updateColumns: triggerUpdateColumns,
          level: triggerLevel,
          whenExpression: triggerWhen,
          body: triggerBody,
          objectType: target.objectType,
        }, capability);
      }
      return '';
    } catch {
      return '';
    }
  }, [activeTab, checkExpression, checkNotValid, clickHouseIndex, clickHousePartition, columnDefault, columnName, columnNotNull, columnType, constraintName, constraintOperation, constraintType, context, databaseKind, distributionChanged, distributionColumns, distributionMethod, foreignKeyColumns, foreignKeyDeferrable, foreignKeyInitiallyDeferred, foreignKeyMatch, foreignKeyNotValid, foreignKeyOnDelete, foreignKeyOnUpdate, indexColumns, indexName, indexOperation, indexUnique, isRoutineTarget, isTableTarget, isViewTarget, organizationColumns, organizationMaxRowsPerZone, organizationNone, referencedColumns, referencedSchema, referencedTable, routineBody, routineExecuteAs, routineParameters, routineReturnType, snowflakeClustering, target.objectType, targetSql, triggerBody, triggerEvent, triggerLevel, triggerName, triggerOperation, triggerTiming, triggerUpdateColumns, triggerWhen, verticaProjection, viewDefinition, viewReplace]);

  useEffect(() => {
    let disposed = false;
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
      setLoading(false);
    }).catch(reason => {
      if (disposed) return;
      setError(reason instanceof Error ? reason.message : 'Could not load designer capabilities.');
      setLoading(false);
    });
    if (isTableTarget && target.schema && (target.objectName ?? target.label)) {
      void api.columns(connectionId, target.database ?? database, target.schema, target.objectName ?? target.label)
        .then(response => { if (!disposed) setColumns(response); })
        .catch(() => { if (!disposed) setColumns([]); });
    }
    if ((isTableTarget || isViewTarget) && (databaseKind === 'sqlite' || databaseKind === 'duckdb') && target.schema && (target.objectName ?? target.label)) {
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
      })
        .catch(() => { if (!disposed) setSnapshot(null); });
    }
    return () => {
      disposed = true;
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
    };
  }, [connectionId, database, databaseKind, isTableTarget, target.database, target.description, target.label, target.objectName, target.objectType, target.schema, target.viewSql]);

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
  }, [connectionId, database, isTableTarget, referencedSchema, target.database]);

  useEffect(() => {
    let disposed = false;
    setReferenceTableColumns([]);
    const table = referencedTable.trim();
    if (!isTableTarget || !referencedSchema.trim() || !table) return () => { disposed = true; };
    void api.columns(connectionId, target.database ?? database, referencedSchema.trim(), table)
      .then(nextColumns => { if (!disposed) setReferenceTableColumns(nextColumns); })
      .catch(() => { if (!disposed) setReferenceTableColumns([]); });
    return () => { disposed = true; };
  }, [connectionId, database, isTableTarget, referencedSchema, referencedTable, target.database]);

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
      subscriptionRef.current = connectToQueryEvents(started.queryId, handleQueryEvent, reason => {
        setApplying(false);
        setError(reason.message);
      });
    } catch (reason: unknown) {
      setApplying(false);
      setError(reason instanceof Error ? reason.message : 'Database change failed.');
    }
  }

  function renderCapabilityRow(key: DatabaseDesignerCapabilityKey, label: string): ReactElement {
    const capability = currentCapability(key);
    if (!capability) return <div className="object-designer-capability-row" key={key}><span>{label}</span><span className="muted">Not reported</span></div>;
    return (
      <div className="object-designer-capability-row" key={key}>
        <span>{label}</span>
        <span className={capabilityClass(capability)}>{capabilityLabel(capability.level)}</span>
        {capability.reason && <small>{capability.reason}</small>}
      </div>
    );
  }

  function renderForm(): ReactElement {
    if (!isTableTarget && !isViewTarget && !isRoutineTarget) {
      return (
        <section className="object-designer-card">
          <h3>Native object designer</h3>
          <p className="muted">This object is currently limited to capability/status inspection. Table structure, local view definitions, and trigger forms are enabled only on their supported target/runtime combinations.</p>
          {CAPABILITY_ROWS.map(row => renderCapabilityRow(row.key, row.label))}
        </section>
      );
    }
    if (isViewTarget && activeTab === 'definition') {
      const capability = currentCapability('views');
      const enabled = Boolean(capability && isMutatingCapability(capability, 'create'));
      const replaceStyle = capability?.view?.replaceStyle ?? 'create';
      return (
        <section className="object-designer-card">
          <div className="object-designer-card-heading"><h3>View designer</h3><span className="muted">Reviewed view definition</span></div>
          {!enabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'View changes are not available for this target.'}</div>}
          {replaceStyle === 'drop-and-create' && <div className="object-designer-inline-warning">Replacing this view uses DROP VIEW followed by CREATE VIEW. Review dependent objects and the exact script before applying.</div>}
          {replaceStyle === 'create' && <div className="object-designer-inline-warning">This dialect supports creating views but has no portable replace statement. The form is create-only.</div>}
          <label>SELECT definition<textarea value={viewDefinition} onChange={event => { setViewDefinition(event.target.value); setPreview(null); }} disabled={!enabled} spellCheck={false} placeholder="SELECT customer_id, count(*) AS order_count\nFROM orders\nGROUP BY customer_id" /></label>
          <label className="object-designer-checkbox"><input type="checkbox" checked={viewReplace} onChange={event => { setViewReplace(event.target.checked); setPreview(null); }} disabled={!enabled || replaceStyle === 'create'} /> Replace existing view</label>
          <p className="muted">Target: {targetSql}. Provider-backed source-definition loading and dependency validation remain on the next adapter slice.</p>
        </section>
      );
    }
    if (isRoutineTarget && activeTab === 'definition') {
      const capability = currentCapability('procedures');
      const enabled = Boolean(capability && isMutatingCapability(capability, 'create') && capability.routine?.bodyStyle === 'netezza-nzplsql');
      return (
        <section className="object-designer-card">
          <div className="object-designer-card-heading"><h3>Netezza NZPLSQL routine designer</h3><span className="muted">Reviewed CREATE OR REPLACE PROCEDURE</span></div>
          {!enabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'This routine adapter is not available for the selected target.'}</div>}
          <div className="object-designer-form-grid">
            <label>Parameters (types)<input value={routineParameters} onChange={event => { setRoutineParameters(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="INTEGER, VARCHAR(100)" /></label>
            <label>Returns<input value={routineReturnType} onChange={event => { setRoutineReturnType(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="INTEGER" /></label>
            <label>Execute as<select value={routineExecuteAs} onChange={event => { setRoutineExecuteAs(event.target.value as DesignerRoutineInput['executeAs']); setPreview(null); }} disabled={!enabled}><option value="OWNER">OWNER</option><option value="CALLER">CALLER</option></select></label>
          </div>
          <label>NZPLSQL body<textarea value={routineBody} onChange={event => { setRoutineBody(event.target.value); setPreview(null); }} disabled={!enabled} spellCheck={false} placeholder="RETURN 1;" /></label>
          <p className="muted">The body is wrapped in `BEGIN_PROC`/`END_PROC`. Provider-backed argument metadata, function-specific returns, and desktop adapters remain dialect-specific work.</p>
          <p className="muted">Target: {targetSql}</p>
        </section>
      );
    }
    if (activeTab === 'columns') {
      const capability = currentCapability('alterTable');
      const enabled = Boolean(capability && isMutatingCapability(capability, 'alter'));
      return (
        <section className="object-designer-card">
          <h3>Add column</h3>
          {!enabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'Column alteration is not available for this target.'}</div>}
          {columns.length > 0 && <div className="object-designer-existing-columns">
            <div className="object-designer-subheading">Current columns</div>
            {columns.map(column => <div className="object-designer-existing-column" key={column.name}><span>{column.name}</span><span className="muted">{column.type ?? 'unknown type'}</span></div>)}
          </div>}
          <div className="object-designer-form-grid">
            <label>Column name<input value={columnName} onChange={event => { setColumnName(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="customer_id" /></label>
            <label>Data type<input value={columnType} onChange={event => { setColumnType(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="INTEGER" /></label>
            <label>Default expression<input value={columnDefault} onChange={event => { setColumnDefault(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="0 or CURRENT_TIMESTAMP" /></label>
            <label className="object-designer-checkbox"><input type="checkbox" checked={columnNotNull} onChange={event => { setColumnNotNull(event.target.checked); setPreview(null); }} disabled={!enabled} /> NOT NULL</label>
          </div>
          <p className="muted">Target: {targetSql}</p>
        </section>
      );
    }
    if (activeTab === 'indexes') {
      const capability = currentCapability('indexes');
      const nativeAlternative = capability?.level === 'alternative';
      const enabled = Boolean(capability && isMutatingCapability(capability, indexOperation === 'drop' ? 'drop' : 'create'));
      if (databaseKind === 'netezza') {
        const nativeEnabled = Boolean(capability && capability.operations.includes('alter') && capability.level !== 'unsupported' && capability.level !== 'runtime-unavailable' && capability.level !== 'privilege-blocked');
        return (
          <section className="object-designer-card">
            <h3>Netezza zone-map editor</h3>
            {!nativeEnabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'ORGANIZE ON is not available for this target.'}</div>}
            <p className="muted">Netezza does not use user-managed B-tree indexes. ORGANIZE ON controls zone-map locality.</p>
            <div className="object-designer-form-grid">
              <label>Organization columns<input value={organizationColumns} onChange={event => { setOrganizationColumns(event.target.value); setOrganizationNone(false); setPreview(null); }} disabled={!nativeEnabled} placeholder="created_at, customer_id" /></label>
              <label>MAX_ROWS_PER_ZONE<input value={organizationMaxRowsPerZone} onChange={event => { setOrganizationMaxRowsPerZone(event.target.value); setPreview(null); }} disabled={!nativeEnabled || organizationNone} inputMode="numeric" placeholder="Optional" /></label>
              <label className="object-designer-checkbox"><input type="checkbox" checked={organizationNone} onChange={event => { setOrganizationNone(event.target.checked); setPreview(null); }} disabled={!nativeEnabled} /> ORGANIZE ON NONE</label>
            </div>
            <p className="muted">Target: {targetSql}</p>
          </section>
        );
      }
      if (databaseKind === 'clickhouse') {
        const nativeEnabled = Boolean(capability && capability.operations.includes(indexOperation) && capability.level !== 'unsupported' && capability.level !== 'runtime-unavailable' && capability.level !== 'privilege-blocked');
        return (
          <section className="object-designer-card">
            <h3>ClickHouse data-skipping index</h3>
            {!nativeEnabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'Data-skipping indexes are not available for this target.'}</div>}
            <div className="object-designer-form-grid">
              <label>Operation<select value={indexOperation} onChange={event => { setIndexOperation(event.target.value as 'create' | 'drop'); setPreview(null); }} disabled={!nativeEnabled}><option value="create">Create index</option><option value="drop">Drop index</option></select></label>
              <label>Index name<input value={clickHouseIndex.name} onChange={event => { setClickHouseIndex(previous => ({ ...previous, name: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} placeholder="idx_bloom" /></label>
              {indexOperation === 'create' && <label>Expression<input value={clickHouseIndex.expression} onChange={event => { setClickHouseIndex(previous => ({ ...previous, expression: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} placeholder="customer_id" /></label>}
              {indexOperation === 'create' && <label>Index type<select value={clickHouseIndex.indexType} onChange={event => { setClickHouseIndex(previous => ({ ...previous, indexType: event.target.value })); setPreview(null); }} disabled={!nativeEnabled}><option value="minmax">minmax</option><option value="set(100)">set(100)</option><option value="bloom_filter">bloom_filter</option><option value="tokenbf_v1(1024, 3, 0)">tokenbf_v1</option></select></label>}
              {indexOperation === 'create' && <label>Granularity<input value={clickHouseIndex.granularity} onChange={event => { setClickHouseIndex(previous => ({ ...previous, granularity: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} inputMode="numeric" placeholder="1" /></label>}
            </div>
          </section>
        );
      }
      if (databaseKind === 'vertica') {
        const nativeEnabled = Boolean(capability && capability.operations.includes(indexOperation) && capability.level !== 'unsupported' && capability.level !== 'runtime-unavailable' && capability.level !== 'privilege-blocked');
        return (
          <section className="object-designer-card">
            <h3>Vertica projection designer</h3>
            {!nativeEnabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'Projections are not available for this target.'}</div>}
            <div className="object-designer-form-grid">
              <label>Operation<select value={indexOperation} onChange={event => { setIndexOperation(event.target.value as 'create' | 'drop'); setPreview(null); }} disabled={!nativeEnabled}><option value="create">Create projection</option><option value="drop">Drop projection</option></select></label>
              <label>Projection name<input value={verticaProjection.name} onChange={event => { setVerticaProjection(previous => ({ ...previous, name: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} placeholder="sales_super" /></label>
              {indexOperation === 'create' && <label>Columns<input value={verticaProjection.columns} onChange={event => { setVerticaProjection(previous => ({ ...previous, columns: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} placeholder="customer_id, created_at, amount" /></label>}
              {indexOperation === 'create' && <label>ORDER BY<input value={verticaProjection.orderBy} onChange={event => { setVerticaProjection(previous => ({ ...previous, orderBy: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} placeholder="created_at, customer_id" /></label>}
              {indexOperation === 'create' && <label>SEGMENTED BY<input value={verticaProjection.segmentation} onChange={event => { setVerticaProjection(previous => ({ ...previous, segmentation: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} placeholder="HASH(customer_id)" /></label>}
              {indexOperation === 'create' && <label>K-safety<input value={verticaProjection.kSafety} onChange={event => { setVerticaProjection(previous => ({ ...previous, kSafety: event.target.value })); setPreview(null); }} disabled={!nativeEnabled} inputMode="numeric" /></label>}
            </div>
          </section>
        );
      }
      if (databaseKind === 'snowflake') {
        const nativeEnabled = Boolean(capability && capability.operations.includes(indexOperation === 'drop' ? 'drop' : 'alter') && capability.level !== 'unsupported' && capability.level !== 'runtime-unavailable' && capability.level !== 'privilege-blocked');
        return (
          <section className="object-designer-card">
            <h3>Snowflake clustering-key editor</h3>
            {!nativeEnabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'Clustering keys are not available for this target.'}</div>}
            <label>Operation<select value={indexOperation} onChange={event => { setIndexOperation(event.target.value as 'create' | 'drop'); setPreview(null); }} disabled={!nativeEnabled}><option value="create">Set clustering key</option><option value="drop">Drop clustering key</option></select></label>
            {indexOperation === 'create' && <label>Clustering expressions<input value={snowflakeClustering.expressions} onChange={event => { setSnowflakeClustering({ expressions: event.target.value }); setPreview(null); }} disabled={!nativeEnabled} placeholder="LINEAR(TO_DATE(created_at)), customer_id" /></label>}
            <p className="muted">Snowflake micro-partitions remain automatic; this changes the table clustering key.</p>
          </section>
        );
      }
      return (
        <section className="object-designer-card">
          <h3>Relational index</h3>
          {nativeAlternative && <div className="object-designer-inline-warning">{capability?.reason ?? 'Use the native physical-design panel for this dialect.'}</div>}
          {!enabled && !nativeAlternative && <div className="object-designer-inline-warning">{capability?.reason ?? 'Index creation is not available for this target.'}</div>}
          <div className="object-designer-form-grid">
            <label>Operation<select value={indexOperation} onChange={event => { setIndexOperation(event.target.value as 'create' | 'drop'); setPreview(null); }} disabled={!enabled}><option value="create">Create index</option><option value="drop">Drop index</option></select></label>
            <label>Index name<input list="object-designer-index-names" value={indexName} onChange={event => { setIndexName(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="ix_customer_id" /><datalist id="object-designer-index-names">{tableDefinition?.indexes.flatMap(index => 'name' in index ? [<option key={index.name} value={index.name} />] : [])}</datalist></label>
            {indexOperation === 'create' && <label>Columns<input value={indexColumns} onChange={event => { setIndexColumns(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="customer_id, created_at" /></label>}
            {indexOperation === 'create' && <label className="object-designer-checkbox"><input type="checkbox" checked={indexUnique} onChange={event => { setIndexUnique(event.target.checked); setPreview(null); }} disabled={!enabled} /> UNIQUE</label>}
          </div>
          {tableDefinition && tableDefinition.indexes.length > 0 && <div className="object-designer-existing-columns">
            <div className="object-designer-subheading">Current indexes</div>
            {tableDefinition.indexes.map(index => <div className="object-designer-existing-column" key={`${index.kind}-${'name' in index ? index.name : index.kind}`}><span>{'name' in index ? index.name : index.kind}</span><span className="muted">{index.kind === 'relational' ? index.columns.map(column => column.expression).join(', ') : index.kind}</span></div>)}
          </div>}
          <p className="muted">The preview is the source of truth; no statement is executed from this form directly.</p>
        </section>
      );
    }
    if (activeTab === 'triggers') {
      const capability = currentCapability('triggers');
      const triggerCapability = capability?.trigger;
      const canCreate = Boolean(capability && triggerCapability && isMutatingCapability(capability, 'create'));
      const canDrop = Boolean(capability && triggerCapability && isMutatingCapability(capability, 'drop'));
      const enabled = triggerOperation === 'drop' ? canDrop : canCreate;
      const objectKind = (target.objectType ?? 'TABLE').toUpperCase();
      const timings = triggerCapability?.timingsByObjectKind
        ? triggerCapability.timingsByObjectKind[objectKind] ?? []
        : triggerCapability?.timings ?? [];
      const events = triggerCapability?.events ?? [];
      const levels = triggerCapability?.levels ?? [];
      const levelOptions = triggerCapability?.levelsByTiming?.[triggerTiming] ?? levels;
      const bodyLabel = triggerCapability?.bodyStyle === 'postgresql-function' ? 'Function call' : 'Body';
      const bodyPlaceholder = triggerCapability?.bodyStyle === 'postgresql-function'
        ? 'audit_orders()'
        : "INSERT INTO audit_log(id, action) VALUES (NEW.id, 'changed');";
      return (
        <section className="object-designer-card">
          <div className="object-designer-card-heading"><h3>Trigger designer</h3><span className="muted">Reviewed CREATE TRIGGER</span></div>
          {!enabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'Triggers are not available for this target.'}</div>}
          <div className="object-designer-form-grid">
            <label>Operation<select value={triggerOperation} onChange={event => { setTriggerOperation(event.target.value as 'create' | 'drop'); setPreview(null); }} disabled={!canCreate && !canDrop}><option value="create" disabled={!canCreate}>Create trigger</option><option value="drop" disabled={!canDrop}>Drop trigger</option></select></label>
            <label>Trigger name<input list="object-designer-trigger-names" value={triggerName} onChange={event => { setTriggerName(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="orders_audit_trigger" /><datalist id="object-designer-trigger-names">{snapshot?.definition.triggers.map(trigger => <option key={trigger.name} value={trigger.name} />)}</datalist></label>
            {triggerOperation === 'create' && <label>Timing<select value={triggerTiming} onChange={event => { setTriggerTiming(event.target.value as DesignerTriggerInput['timing']); setPreview(null); }} disabled={!enabled || timings.length === 0}>{timings.map(timing => <option key={timing} value={timing}>{timing}</option>)}</select></label>}
            {triggerOperation === 'create' && <label>Event<select value={triggerEvent} onChange={event => { setTriggerEvent(event.target.value as DesignerTriggerInput['event']); setPreview(null); }} disabled={!enabled || events.length === 0}>{events.map(event => <option key={event} value={event}>{event}</option>)}</select></label>}
            {triggerOperation === 'create' && <label>Level<select value={triggerLevel} onChange={event => { setTriggerLevel(event.target.value as DesignerTriggerInput['level']); setPreview(null); }} disabled={!enabled || levelOptions.length === 0}>{levelOptions.map(level => <option key={level} value={level}>{level}</option>)}</select></label>}
          </div>
          {triggerOperation === 'create' && enabled && timings.length === 0 && <div className="object-designer-inline-warning">No trigger timing is valid for this object type.</div>}
          {triggerOperation === 'create' && triggerEvent === 'UPDATE' && triggerCapability?.supportsUpdateColumns && <label>UPDATE OF columns<input value={triggerUpdateColumns} onChange={event => { setTriggerUpdateColumns(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="status, updated_at" /></label>}
          {triggerOperation === 'create' && triggerCapability?.supportsWhen && <label>WHEN predicate<input value={triggerWhen} onChange={event => { setTriggerWhen(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="NEW.status <> OLD.status" /></label>}
          {triggerOperation === 'create' && <label>{bodyLabel}<textarea value={triggerBody} onChange={event => { setTriggerBody(event.target.value); setPreview(null); }} disabled={!enabled} placeholder={bodyPlaceholder} /></label>}
          {triggerOperation === 'drop' && <div className="object-designer-inline-warning">Dropping a trigger is destructive. Review the exact statement before applying.</div>}
          {snapshot && snapshot.definition.triggers.length > 0 && <div className="object-designer-existing-columns">
            <div className="object-designer-subheading">Current triggers</div>
            {snapshot.definition.triggers.map(trigger => <div className="object-designer-existing-column" key={trigger.name}><span>{trigger.name}</span><span className="muted">{trigger.timing} {trigger.events.join(' / ')}</span></div>)}
          </div>}
          <p className="muted">The dialect-specific trigger body is rendered as reviewed SQL. Review the exact statement and server warnings before applying.</p>
          <p className="muted">Target: {targetSql}</p>
        </section>
      );
    }
    if (activeTab === 'constraints') {
      const foreignKeyCapability = currentCapability('foreignKeys');
      const checkCapability = currentCapability('checks');
      const selectedCapability = constraintType === 'foreignKey' ? foreignKeyCapability : checkCapability;
      const canCreate = Boolean(selectedCapability && isMutatingCapability(selectedCapability, 'create'));
      const canDrop = Boolean(selectedCapability && isMutatingCapability(selectedCapability, 'drop'));
      const enabled = constraintOperation === 'drop' ? canDrop : canCreate;
      const canDefer = databaseKind === 'postgresql' || databaseKind === 'oracle' || databaseKind === 'db2';
      return (
        <section className="object-designer-card">
          <div className="object-designer-card-heading"><h3>Constraint designer</h3><span className="muted">Reviewed ALTER TABLE</span></div>
          <div className="object-designer-form-grid">
            <label>Operation<select value={constraintOperation} onChange={event => { setConstraintOperation(event.target.value as 'create' | 'drop'); setPreview(null); }} disabled={!canCreate && !canDrop}><option value="create" disabled={!canCreate}>Create constraint</option><option value="drop" disabled={!canDrop}>Drop constraint</option></select></label>
            <label>Constraint type<select value={constraintType} onChange={event => { setConstraintType(event.target.value as 'foreignKey' | 'check'); setPreview(null); }}>
              <option value="foreignKey" disabled={!isMutatingCapability(foreignKeyCapability, 'create')}>Foreign key</option>
              <option value="check" disabled={!isMutatingCapability(checkCapability, 'create')}>CHECK</option>
            </select></label>
            <label>Constraint name<input list="object-designer-constraint-names" value={constraintName} onChange={event => { setConstraintName(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="fk_orders_customer" /><datalist id="object-designer-constraint-names">{tableDefinition?.constraints.flatMap(constraint => constraint.name ? [<option key={constraint.name} value={constraint.name} />] : [])}</datalist></label>
          </div>
          {!enabled && <div className="object-designer-inline-warning">{selectedCapability?.reason ?? 'This constraint type is not available for the selected target.'}</div>}
          {selectedCapability?.enforced === false && <div className="object-designer-inline-warning">This database stores the declaration but does not guarantee referential or CHECK enforcement for this table type.</div>}
          {constraintOperation === 'drop' && <div className="object-designer-inline-warning">Dropping a constraint is destructive. Select an existing named constraint and review the exact statement before applying.</div>}
          {tableDefinition && tableDefinition.constraints.length > 0 && <div className="object-designer-existing-columns">
            <div className="object-designer-subheading">Current constraints</div>
            {tableDefinition.constraints.map((constraint, index) => <div className="object-designer-existing-column" key={`${constraint.kind}-${constraint.name ?? index}`}><span>{constraint.name ?? constraint.kind}</span><span className="muted">{constraint.kind}</span></div>)}
          </div>}
          {constraintOperation === 'create' && constraintType === 'foreignKey' ? (
            <>
              <div className="object-designer-form-grid">
                <label>Local columns<input value={foreignKeyColumns} onChange={event => { setForeignKeyColumns(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="customer_id" /></label>
                <label>Referenced schema<input value={referencedSchema} onChange={event => { setReferencedSchema(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="public" /></label>
                <label>Referenced table<input list="object-designer-reference-tables" value={referencedTable} onChange={event => { setReferencedTable(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="customers" /><datalist id="object-designer-reference-tables">{referenceTables.map(table => <option key={`${table.schema ?? ''}.${table.name}`} value={table.name}>{table.description ?? ''}</option>)}</datalist></label>
                <label>Referenced columns<input list="object-designer-reference-columns" value={referencedColumns} onChange={event => { setReferencedColumns(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="id" /><datalist id="object-designer-reference-columns">{referenceTableColumns.map(column => <option key={column.name} value={column.name}>{column.type ?? ''}</option>)}</datalist></label>
                <label>ON DELETE<select value={foreignKeyOnDelete} onChange={event => { setForeignKeyOnDelete(event.target.value as DesignerForeignKeyInput['onDelete']); setPreview(null); }} disabled={!enabled}><option value="">Default</option><option>NO ACTION</option><option>RESTRICT</option><option>CASCADE</option><option>SET NULL</option><option>SET DEFAULT</option></select></label>
                <label>ON UPDATE<select value={foreignKeyOnUpdate} onChange={event => { setForeignKeyOnUpdate(event.target.value as DesignerForeignKeyInput['onUpdate']); setPreview(null); }} disabled={!enabled}><option value="">Default</option><option>NO ACTION</option><option>RESTRICT</option><option>CASCADE</option><option>SET NULL</option><option>SET DEFAULT</option></select></label>
                <label>MATCH<select value={foreignKeyMatch} onChange={event => { setForeignKeyMatch(event.target.value as DesignerForeignKeyInput['match']); setPreview(null); }} disabled={!enabled}><option value="">Default</option><option>SIMPLE</option><option>FULL</option><option>PARTIAL</option></select></label>
              </div>
              {canDefer && <div className="object-designer-checkbox-row">
                <label className="object-designer-checkbox"><input type="checkbox" checked={foreignKeyDeferrable} onChange={event => { setForeignKeyDeferrable(event.target.checked); if (!event.target.checked) setForeignKeyInitiallyDeferred(false); setPreview(null); }} disabled={!enabled} /> DEFERRABLE</label>
                <label className="object-designer-checkbox"><input type="checkbox" checked={foreignKeyInitiallyDeferred} onChange={event => { setForeignKeyInitiallyDeferred(event.target.checked); setForeignKeyDeferrable(true); setPreview(null); }} disabled={!enabled} /> INITIALLY DEFERRED</label>
              </div>}
              {databaseKind === 'postgresql' && <label className="object-designer-checkbox"><input type="checkbox" checked={foreignKeyNotValid} onChange={event => { setForeignKeyNotValid(event.target.checked); setPreview(null); }} disabled={!enabled} /> NOT VALID (validate later)</label>}
            </>
          ) : constraintOperation === 'create' ? (
            <>
              <label>CHECK expression<textarea value={checkExpression} onChange={event => { setCheckExpression(event.target.value); setPreview(null); }} disabled={!enabled} placeholder="amount >= 0" /></label>
              {databaseKind === 'postgresql' && <label className="object-designer-checkbox"><input type="checkbox" checked={checkNotValid} onChange={event => { setCheckNotValid(event.target.checked); setPreview(null); }} disabled={!enabled} /> NOT VALID (validate later)</label>}
            </>
          ) : null}
          <p className="muted">Columns are comma-separated. The server-issued preview token is required before execution.</p>
          <p className="muted">Target: {targetSql}</p>
        </section>
      );
    }
    if (activeTab === 'partitions') {
      const capability = currentCapability('partitions');
      if (databaseKind === 'netezza') {
        const nativeEnabled = Boolean(capability && capability.operations.includes('alter') && capability.level !== 'unsupported' && capability.level !== 'runtime-unavailable' && capability.level !== 'privilege-blocked');
        return (
          <section className="object-designer-card">
            <h3>Netezza distribution and organization</h3>
            {!nativeEnabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'Distribution changes are not available for this target.'}</div>}
            <p className="muted">Netezza uses hash distribution and zone-map organization instead of user-managed table partitions. Distribution remains unchanged unless explicitly selected below.</p>
            <div className="object-designer-form-grid">
              <label className="object-designer-checkbox"><input type="checkbox" checked={distributionChanged} onChange={event => { setDistributionChanged(event.target.checked); setPreview(null); }} disabled={!nativeEnabled} /> Change distribution</label>
              <label>Distribution method<select value={distributionMethod} onChange={event => { setDistributionMethod(event.target.value as NetezzaPhysicalDesignInput['distributionMethod']); setPreview(null); }} disabled={!nativeEnabled || !distributionChanged}><option value="RANDOM">RANDOM</option><option value="HASH">HASH</option></select></label>
              <label>Distribution columns<input value={distributionColumns} onChange={event => { setDistributionColumns(event.target.value); setDistributionMethod('HASH'); setDistributionChanged(true); setPreview(null); }} disabled={!nativeEnabled || !distributionChanged || distributionMethod === 'RANDOM'} placeholder="customer_id" /></label>
              <label>Organization columns<input value={organizationColumns} onChange={event => { setOrganizationColumns(event.target.value); setOrganizationNone(false); setPreview(null); }} disabled={!nativeEnabled || organizationNone} placeholder="created_at" /></label>
              <label>MAX_ROWS_PER_ZONE<input value={organizationMaxRowsPerZone} onChange={event => { setOrganizationMaxRowsPerZone(event.target.value); setPreview(null); }} disabled={!nativeEnabled || organizationNone} inputMode="numeric" placeholder="Optional" /></label>
              <label className="object-designer-checkbox"><input type="checkbox" checked={organizationNone} onChange={event => { setOrganizationNone(event.target.checked); setPreview(null); }} disabled={!nativeEnabled} /> ORGANIZE ON NONE</label>
            </div>
          </section>
        );
      }
      if (databaseKind === 'clickhouse') {
        const enabled = Boolean(capability && capability.operations.includes('drop') && capability.level !== 'unsupported' && capability.level !== 'runtime-unavailable' && capability.level !== 'privilege-blocked');
        return (
          <section className="object-designer-card">
            <h3>ClickHouse partition manager</h3>
            {!enabled && <div className="object-designer-inline-warning">{capability?.reason ?? 'MergeTree partition operations are not available for this target.'}</div>}
            <p className="muted">Partition keys are MergeTree expressions. Existing data is managed with explicit DROP, DETACH, ATTACH, and OPTIMIZE operations.</p>
            <div className="object-designer-form-grid">
              <label>Operation<select value={clickHousePartition.action} onChange={event => { setClickHousePartition(previous => ({ ...previous, action: event.target.value as ClickHousePartitionOperationInput['action'] })); setPreview(null); }} disabled={!enabled}><option value="DROP">DROP partition</option><option value="DETACH">DETACH partition</option><option value="ATTACH">ATTACH partition</option><option value="OPTIMIZE">OPTIMIZE … FINAL</option></select></label>
              <label>Partition expression/value<input value={clickHousePartition.partition} onChange={event => { setClickHousePartition(previous => ({ ...previous, partition: event.target.value })); setPreview(null); }} disabled={!enabled} placeholder="202401 or tuple('2024', 1)" /></label>
            </div>
            {clickHousePartition.action === 'DROP' && <div className="object-designer-inline-warning">DROP PARTITION is destructive. Review the exact statement and server warning before applying.</div>}
            <p className="muted">Target: {targetSql}</p>
          </section>
        );
      }
      return (
        <section className="object-designer-card">
          <h3>Partitions / distribution</h3>
          <div className="object-designer-inline-warning">{capability?.reason ?? 'Partition capability was not reported.'}</div>
          <p className="muted">The dialect-specific provider will supply partition strategy, boundaries, attach/detach, split, and merge operations. Generic DDL is intentionally not emitted here.</p>
        </section>
      );
    }
    return (
      <section className="object-designer-card">
        <h3>Designer overview</h3>
        <p className="muted">Select a section to prepare a change. Existing object metadata is intentionally refreshed before each future edit flow.</p>
        {CAPABILITY_ROWS.map(row => renderCapabilityRow(row.key, row.label))}
      </section>
    );
  }

  const canPreview = Boolean(draftSql.trim() || generatedSql.trim()) && !previewing && !applying;
  const availableTabs: readonly DesignerTab[] = isTableTarget
    ? ['overview', 'columns', 'indexes', 'partitions', 'triggers', 'constraints']
    : isViewTarget ? ['overview', 'definition', 'triggers']
      : isRoutineTarget ? ['overview', 'definition'] : ['overview'];

  return (
    <div className="modal-backdrop object-designer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !applying) onClose(); }}>
      <section className="object-designer-modal" role="dialog" aria-modal="true" aria-labelledby="object-designer-title">
        <header className="object-designer-header">
          <div>
            <span className="muted">Object Designer</span>
            <h2 id="object-designer-title">{target.label}</h2>
            <p className="muted">{target.schema ? `${target.schema}.` : ''}{target.objectType ?? 'TABLE'} · {databaseKind}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close object designer" onClick={onClose} disabled={applying}>×</button>
        </header>

        {loading ? <div className="object-designer-loading">Loading capabilities…</div> : (
          <>
            {context && <div className="object-designer-statusbar"><span className={context.runtimeAvailable ? 'status-ok' : 'status-warning'}>{context.runtimeAvailable ? 'Runtime available' : 'Runtime unavailable'}</span><span>{context.readOnly ? 'Read-only connection' : 'Writable connection'}</span></div>}
            <nav className="object-designer-tabs" aria-label="Object designer sections">
              {availableTabs.map(tab => <button type="button" key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => { setActiveTab(tab); setPreview(null); }}>{tab === 'overview' ? 'Overview' : tab[0]!.toUpperCase() + tab.slice(1)}</button>)}
            </nav>
            <main className="object-designer-content">
              {error && <div className="error object-designer-message" role="alert">{error}</div>}
              {notice && <div className="object-designer-notice" role="status">{notice}</div>}
              {renderForm()}
              {(isTableTarget || isViewTarget || isRoutineTarget) && activeTab !== 'overview' && <section className="object-designer-card object-designer-preview-card">
                <div className="object-designer-card-heading"><h3>SQL preview</h3><span className="muted">Preview exact SQL before apply</span></div>
                <textarea value={draftSql} onChange={event => { setDraftSql(event.target.value); setPreview(null); }} spellCheck={false} aria-label="SQL preview" placeholder="Generated SQL will appear here." />
                <div className="object-designer-actions">
                  <button type="button" className="secondary" onClick={() => void requestPreview()} disabled={!canPreview}>{previewing ? 'Previewing…' : 'Preview SQL'}</button>
                  <button type="button" onClick={() => void applyPreview()} disabled={!preview || applying || context?.readOnly === true}>{applying ? 'Applying…' : 'Apply preview'}</button>
                </div>
                {preview && <div className="object-designer-preview-meta"><span>{preview.statements.length} statement(s)</span>{preview.statements.flatMap(statement => statement.warnings).map((warning, index) => <span key={`${warning}-${index}`} className="status-warning">{warning}</span>)}</div>}
              </section>}
            </main>
          </>
        )}
      </section>
    </div>
  );
}

export { ObjectDesigner };
