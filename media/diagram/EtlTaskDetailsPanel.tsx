import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
    getContainerChildCount,
    isContainerNode,
} from '../../src/etl/projectStructure';
import type {
    ContainerNodeConfig,
    EtlNode,
    EtlNodeConfig,
    EtlProject,
    ExportNodeConfig,
    ImportNodeConfig,
    PythonNodeConfig,
    SqlNodeConfig,
    VariableNodeConfig,
} from '../../src/etl/etlTypes';

export interface EtlConnectionOption {
    name: string;
    database?: string;
    dbType?: string;
}

interface DetailsDraft {
    name: string;
    description: string;
    config: EtlNodeConfig;
}

interface EtlTaskDetailsPanelProps {
    node: EtlNode;
    project: EtlProject;
    connectionOptions: readonly EtlConnectionOption[];
    activeConnectionName?: string;
    onSave: (nodeId: string, updates: Partial<EtlNode>) => void;
    onDelete: (node: EtlNode) => void;
    onRemoveFromContainer: (node: EtlNode) => void;
}

function createDraft(node: EtlNode): DetailsDraft {
    return {
        name: node.name,
        description: node.description || '',
        config: { ...node.config } as EtlNodeConfig,
    };
}

function optionalNumber(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeConnection(value: string): string | undefined {
    const trimmed = value.trim();
    return !trimmed || trimmed === 'default' ? undefined : trimmed;
}

function normalizeConfig(config: EtlNodeConfig): EtlNodeConfig {
    switch (config.type) {
        case 'sql':
            return { ...config, connection: normalizeConnection(config.connection || '') };
        case 'import':
            return { ...config, connection: normalizeConnection(config.connection || '') };
        case 'export':
            return { ...config, connection: normalizeConnection(config.connection || '') };
        default:
            return { ...config } as EtlNodeConfig;
    }
}

function Field({ label, children, hint }: { label: string; children: ReactElement; hint?: string }): ReactElement {
    return (
        <label className="etl-detail-field">
            <span className="etl-detail-label">{label}</span>
            {children}
            {hint && <small className="etl-detail-hint">{hint}</small>}
        </label>
    );
}

function ConnectionField({
    value,
    options,
    activeConnectionName,
    onChange,
}: {
    value?: string;
    options: readonly EtlConnectionOption[];
    activeConnectionName?: string;
    onChange: (value: string) => void;
}): ReactElement {
    const selectedValue = value && value !== 'default' ? value : '';
    const hasSelectedOption = !selectedValue || options.some(option => option.name === selectedValue);

    return (
        <Field
            label="Database connection"
            hint={activeConnectionName ? `Run fallback: ${activeConnectionName}` : 'Select a connection or configure one as the run fallback.'}
        >
            <select
                className="etl-detail-control"
                value={selectedValue}
                onChange={event => onChange(event.target.value)}
            >
                <option value="">Use active/run connection</option>
                {!hasSelectedOption && <option value={selectedValue}>{selectedValue} (not available)</option>}
                {options.map(option => (
                    <option key={option.name} value={option.name}>
                        {option.name}{option.database ? ` · ${option.database}` : ''}
                    </option>
                ))}
            </select>
        </Field>
    );
}

function TimeoutField({ value, onChange }: { value?: number; onChange: (value: number | undefined) => void }): ReactElement {
    return (
        <Field label="Timeout (seconds)">
            <input
                className="etl-detail-control"
                type="number"
                min="0"
                step="1"
                value={value ?? ''}
                placeholder="No limit"
                onChange={event => onChange(optionalNumber(event.target.value))}
            />
        </Field>
    );
}

function FormatField({ value, onChange }: { value: 'csv' | 'xlsb' | 'parquet'; onChange: (value: 'csv' | 'xlsb' | 'parquet') => void }): ReactElement {
    return (
        <Field label="Format">
            <select className="etl-detail-control" value={value} onChange={event => onChange(event.target.value as typeof value)}>
                <option value="csv">CSV</option>
                <option value="xlsb">Excel Binary (XLSB)</option>
                <option value="parquet">Parquet</option>
            </select>
        </Field>
    );
}

function SelectSourceField({
    value,
    project,
    currentNodeId,
    onChange,
}: {
    value?: string;
    project: EtlProject;
    currentNodeId: string;
    onChange: (value: string) => void;
}): ReactElement {
    const sourceNodes = project.nodes.filter(node => node.id !== currentNodeId && node.type !== 'container');
    return (
        <Field label="Source task" hint="Use a query below, or select a task output when supported by the executor.">
            <select className="etl-detail-control" value={value || ''} onChange={event => onChange(event.target.value)}>
                <option value="">Use SQL query</option>
                {sourceNodes.map(sourceNode => <option key={sourceNode.id} value={sourceNode.id}>{sourceNode.name}</option>)}
            </select>
        </Field>
    );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }): ReactElement {
    return <input className="etl-detail-control" value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />;
}

function renderSqlFields(
    config: SqlNodeConfig,
    updateConfig: (patch: Record<string, unknown>) => void,
    connectionOptions: readonly EtlConnectionOption[],
    activeConnectionName?: string,
): ReactElement {
    return (
        <>
            <ConnectionField value={config.connection} options={connectionOptions} activeConnectionName={activeConnectionName} onChange={connection => updateConfig({ connection })} />
            <Field label="SQL query">
                <textarea className="etl-detail-control etl-detail-textarea etl-detail-code" rows={10} value={config.query} placeholder="SELECT ..." onChange={event => updateConfig({ query: event.target.value })} />
            </Field>
            <TimeoutField value={config.timeout} onChange={timeout => updateConfig({ timeout })} />
        </>
    );
}

function renderImportFields(
    config: ImportNodeConfig,
    updateConfig: (patch: Record<string, unknown>) => void,
    connectionOptions: readonly EtlConnectionOption[],
    activeConnectionName?: string,
): ReactElement {
    return (
        <>
            <ConnectionField value={config.connection} options={connectionOptions} activeConnectionName={activeConnectionName} onChange={connection => updateConfig({ connection })} />
            <FormatField value={config.format} onChange={format => updateConfig({ format })} />
            <Field label="Input file">
                <TextInput value={config.inputPath} placeholder="C:\\data\\input.csv" onChange={inputPath => updateConfig({ inputPath })} />
            </Field>
            <Field label="Target schema">
                <TextInput value={config.targetSchema || ''} placeholder="Optional schema" onChange={targetSchema => updateConfig({ targetSchema })} />
            </Field>
            <Field label="Target table">
                <TextInput value={config.targetTable} placeholder="SCHEMA.TABLE_NAME" onChange={targetTable => updateConfig({ targetTable })} />
            </Field>
            <Field label="Delimiter">
                <TextInput value={config.delimiter || ''} placeholder="," onChange={delimiter => updateConfig({ delimiter })} />
            </Field>
            <Field label="Skip rows">
                <input className="etl-detail-control" type="number" min="0" step="1" value={config.skipRows ?? ''} onChange={event => updateConfig({ skipRows: optionalNumber(event.target.value) })} />
            </Field>
            <label className="etl-detail-checkbox"><input type="checkbox" checked={config.createTable ?? false} onChange={event => updateConfig({ createTable: event.target.checked })} /><span>Create table if missing</span></label>
            <TimeoutField value={config.timeout} onChange={timeout => updateConfig({ timeout })} />
        </>
    );
}

function renderExportFields(
    config: ExportNodeConfig,
    updateConfig: (patch: Record<string, unknown>) => void,
    project: EtlProject,
    currentNodeId: string,
    connectionOptions: readonly EtlConnectionOption[],
    activeConnectionName?: string,
): ReactElement {
    return (
        <>
            <ConnectionField value={config.connection} options={connectionOptions} activeConnectionName={activeConnectionName} onChange={connection => updateConfig({ connection })} />
            <FormatField value={config.format} onChange={format => updateConfig({ format })} />
            <Field label="Output file">
                <TextInput value={config.outputPath} placeholder="C:\\data\\output.csv" onChange={outputPath => updateConfig({ outputPath })} />
            </Field>
            <SelectSourceField value={config.sourceNodeId} project={project} currentNodeId={currentNodeId} onChange={sourceNodeId => updateConfig({ sourceNodeId })} />
            <Field label="SQL query">
                <textarea className="etl-detail-control etl-detail-textarea etl-detail-code" rows={9} value={config.query || ''} placeholder="SELECT ..." onChange={event => updateConfig({ query: event.target.value })} />
            </Field>
            <Field label="Delimiter">
                <TextInput value={config.delimiter || ''} placeholder="," onChange={delimiter => updateConfig({ delimiter })} />
            </Field>
            <Field label="Encoding">
                <TextInput value={config.encoding || ''} placeholder="UTF-8" onChange={encoding => updateConfig({ encoding })} />
            </Field>
            <TimeoutField value={config.timeout} onChange={timeout => updateConfig({ timeout })} />
        </>
    );
}

function renderPythonFields(config: PythonNodeConfig, updateConfig: (patch: Record<string, unknown>) => void): ReactElement {
    return (
        <>
            <Field label="Script path">
                <TextInput value={config.scriptPath || ''} placeholder="Optional .py file" onChange={scriptPath => updateConfig({ scriptPath })} />
            </Field>
            <Field label="Inline script">
                <textarea className="etl-detail-control etl-detail-textarea etl-detail-code" rows={10} value={config.script} placeholder="print('Hello ETL')" onChange={event => updateConfig({ script: event.target.value })} />
            </Field>
            <Field label="Python interpreter">
                <TextInput value={config.interpreter || ''} placeholder="python" onChange={interpreter => updateConfig({ interpreter })} />
            </Field>
            <Field label="Interpreter arguments" hint="One argument per line.">
                <textarea className="etl-detail-control etl-detail-textarea" rows={3} value={(config.interpreterArgs || []).join('\n')} onChange={event => updateConfig({ interpreterArgs: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} />
            </Field>
            <Field label="Script arguments" hint="One argument per line.">
                <textarea className="etl-detail-control etl-detail-textarea" rows={3} value={(config.arguments || []).join('\n')} onChange={event => updateConfig({ arguments: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} />
            </Field>
            <TimeoutField value={config.timeout} onChange={timeout => updateConfig({ timeout })} />
        </>
    );
}

function renderVariableFields(config: VariableNodeConfig, updateConfig: (patch: Record<string, unknown>) => void): ReactElement {
    return (
        <>
            <Field label="Variable name">
                <TextInput value={config.variableName} placeholder="variable_name" onChange={variableName => updateConfig({ variableName })} />
            </Field>
            <Field label="Value source">
                <select className="etl-detail-control" value={config.source} onChange={event => updateConfig({ source: event.target.value as VariableNodeConfig['source'] })}>
                    <option value="prompt">Prompt at runtime</option>
                    <option value="static">Static value</option>
                    <option value="sql">SQL query</option>
                </select>
            </Field>
            {config.source === 'prompt' && <>
                <Field label="Prompt message"><TextInput value={config.promptMessage || ''} placeholder="Enter value" onChange={promptMessage => updateConfig({ promptMessage })} /></Field>
                <Field label="Default value"><TextInput value={config.defaultValue || ''} onChange={defaultValue => updateConfig({ defaultValue })} /></Field>
            </>}
            {config.source === 'static' && <Field label="Value"><TextInput value={config.value || ''} onChange={value => updateConfig({ value })} /></Field>}
            {config.source === 'sql' && <Field label="SQL query"><textarea className="etl-detail-control etl-detail-textarea etl-detail-code" rows={8} value={config.query || ''} placeholder="SELECT ..." onChange={event => updateConfig({ query: event.target.value })} /></Field>}
            {config.source === 'sql' && <TimeoutField value={config.timeout} onChange={timeout => updateConfig({ timeout })} />}
        </>
    );
}

function renderContainerFields(config: ContainerNodeConfig, project: EtlProject, nodeId: string, updateConfig: (patch: Record<string, unknown>) => void): ReactElement {
    return (
        <>
            <div className="etl-detail-summary"><span>Tasks in container</span><strong>{getContainerChildCount(project, nodeId)}</strong></div>
            <Field label="Width"><input className="etl-detail-control" type="number" min="360" step="10" value={config.width || ''} onChange={event => updateConfig({ width: optionalNumber(event.target.value) })} /></Field>
            <Field label="Height"><input className="etl-detail-control" type="number" min="240" step="10" value={config.height || ''} onChange={event => updateConfig({ height: optionalNumber(event.target.value) })} /></Field>
            <p className="etl-detail-hint">Drag tasks onto this boundary to group them. Connections crossing the boundary are routed automatically.</p>
        </>
    );
}

export function EtlTaskDetailsPanel({
    node,
    project,
    connectionOptions,
    activeConnectionName,
    onSave,
    onDelete,
    onRemoveFromContainer,
}: EtlTaskDetailsPanelProps): ReactElement {
    const [draft, setDraft] = useState<DetailsDraft>(() => createDraft(node));
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setDraft(createDraft(node));
        setSaved(false);
    }, [node]);

    const updateConfig = (patch: Record<string, unknown>): void => {
        setDraft(current => ({
            ...current,
            config: { ...current.config, ...patch } as EtlNodeConfig,
        }));
        setSaved(false);
    };

    const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(createDraft(node)), [draft, node]);
    const save = (): void => {
        const name = draft.name.trim();
        if (!name) return;
        onSave(node.id, {
            name,
            description: draft.description.trim() || undefined,
            config: normalizeConfig(draft.config),
        });
        setSaved(true);
    };

    return (
        <div className="etl-details-form">
            <section className="etl-detail-section">
                <div className="etl-detail-section-title">General</div>
                <Field label="Name">
                    <TextInput value={draft.name} placeholder="Task name" onChange={name => { setDraft(current => ({ ...current, name })); setSaved(false); }} />
                </Field>
                <Field label="Description">
                    <textarea className="etl-detail-control etl-detail-textarea" rows={3} value={draft.description} placeholder="Optional description" onChange={event => { setDraft(current => ({ ...current, description: event.target.value })); setSaved(false); }} />
                </Field>
                <div className="etl-detail-summary"><span>Task type</span><strong>{node.type}</strong></div>
                <div className="etl-detail-summary"><span>Scope</span><strong>{node.containerId ? project.nodes.find(item => item.id === node.containerId)?.name || node.containerId : 'Canvas'}</strong></div>
            </section>

            <section className="etl-detail-section">
                <div className="etl-detail-section-title">Configuration</div>
                {draft.config.type === 'sql' && renderSqlFields(draft.config, updateConfig, connectionOptions, activeConnectionName)}
                {draft.config.type === 'import' && renderImportFields(draft.config, updateConfig, connectionOptions, activeConnectionName)}
                {draft.config.type === 'export' && renderExportFields(draft.config, updateConfig, project, node.id, connectionOptions, activeConnectionName)}
                {draft.config.type === 'python' && renderPythonFields(draft.config, updateConfig)}
                {draft.config.type === 'variable' && renderVariableFields(draft.config, updateConfig)}
                {draft.config.type === 'container' && renderContainerFields(draft.config, project, node.id, updateConfig)}
            </section>

            <div className="etl-detail-actions">
                <button className="diagram-button diagram-button-primary" type="button" disabled={!isDirty || !draft.name.trim()} onClick={save}>Save changes</button>
                <button className="diagram-button" type="button" disabled={!isDirty} onClick={() => { setDraft(createDraft(node)); setSaved(false); }}>Revert</button>
                {saved && <span className="etl-detail-saved">Saved</span>}
            </div>

            {node.containerId && <button className="diagram-button etl-detail-wide-button" type="button" onClick={() => onRemoveFromContainer(node)}>Move to canvas</button>}
            <button className="diagram-button etl-detail-danger-button" type="button" onClick={() => onDelete(node)}>{isContainerNode(node) ? 'Delete container and tasks' : 'Delete task'}</button>
        </div>
    );
}
