import { useState, type ReactElement } from 'react';
import type { PlacedTable, VisualQueryBuilderTable } from './hostContracts.js';
import {
    GRID_AGGREGATE_FUNCTIONS,
    GRID_CRITERIA_ROWS,
    isAggregateFunction,
    type QueryGridAggregate,
    type QueryGridColumn,
    type QueryGridSort,
} from './filterSort.js';

export interface FilterSortGridProps {
    columns: QueryGridColumn[];
    placedTables: PlacedTable[];
    getTable: (source: PlacedTable) => VisualQueryBuilderTable | undefined;
    onAddColumn: (field?: { tableInstanceId: string; columnName: string }) => void;
    onUpdateColumn: (columnId: string, patch: Partial<Omit<QueryGridColumn, 'id'>>) => void;
    onRemoveColumn: (columnId: string) => void;
    onMoveColumn: (columnId: string, delta: -1 | 1) => void;
    onClearColumns: () => void;
}

const OR_ROW_COUNT = GRID_CRITERIA_ROWS - 1;

function fieldOptionKey(tableInstanceId: string, columnName: string): string {
    return `${tableInstanceId}\u0000${columnName}`;
}

function parseFieldOptionKey(key: string): { tableInstanceId: string; columnName: string } | undefined {
    const separator = key.indexOf('\u0000');
    if (separator < 0) return undefined;
    return {
        tableInstanceId: key.slice(0, separator),
        columnName: key.slice(separator + 1),
    };
}

function selectedFieldKey(column: QueryGridColumn): string {
    return column.tableInstanceId && column.columnName
        ? fieldOptionKey(column.tableInstanceId, column.columnName)
        : '';
}

export function FilterSortGrid({
    columns,
    placedTables,
    getTable,
    onAddColumn,
    onUpdateColumn,
    onRemoveColumn,
    onMoveColumn,
    onClearColumns,
}: FilterSortGridProps): ReactElement {
    const [collapsed, setCollapsed] = useState(false);

    const hasAggregate = columns.some(column =>
        column.aggregate === 'EXPRESSION' || isAggregateFunction(column.aggregate),
    );

    const handleFieldChange = (columnId: string, key: string): void => {
        const field = parseFieldOptionKey(key);
        onUpdateColumn(columnId, field
            ? { tableInstanceId: field.tableInstanceId, columnName: field.columnName }
            : { tableInstanceId: '', columnName: '' });
    };

    const handleTableChange = (columnId: string, tableInstanceId: string): void => {
        const current = columns.find(column => column.id === columnId);
        const source = placedTables.find(candidate => candidate.instanceId === tableInstanceId);
        const table = source ? getTable(source) : undefined;
        const keepColumn = !!current
            && !!table?.columns.some(column => column.name === current.columnName);
        onUpdateColumn(columnId, {
            tableInstanceId,
            columnName: keepColumn && current ? current.columnName : '',
        });
    };

    const handleCriteriaChange = (columnId: string, rowIndex: number, value: string): void => {
        const current = columns.find(column => column.id === columnId);
        if (!current) return;
        const criteriaRows = [...current.criteriaRows];
        criteriaRows[rowIndex] = value;
        onUpdateColumn(columnId, { criteriaRows });
    };

    const handleAggregateChange = (columnId: string, aggregate: QueryGridAggregate): void => {
        onUpdateColumn(columnId, { aggregate });
    };

    const renderFieldControl = (column: QueryGridColumn): ReactElement => (
        column.aggregate === 'EXPRESSION' ? (
            <input
                aria-label={`Expression for ${column.columnName || 'field'}`}
                className="vqb-grid-input"
                onChange={event => onUpdateColumn(column.id, { columnName: event.target.value })}
                placeholder="e.g. AMOUNT * 1.23"
                value={column.columnName}
            />
        ) : (
            <select
                aria-label="Field"
                className="vqb-grid-select"
                onChange={event => handleFieldChange(column.id, event.target.value)}
                value={selectedFieldKey(column)}
            >
                <option value="">—</option>
                {placedTables.map(source => {
                    const table = getTable(source);
                    if (!table) return null;
                    return (
                        <optgroup key={source.instanceId} label={`${source.alias} · ${source.tableName}`}>
                            {table.columns.map(tableColumn => (
                                <option
                                    key={tableColumn.name}
                                    value={fieldOptionKey(source.instanceId, tableColumn.name)}
                                >
                                    {source.alias}.{tableColumn.name}
                                </option>
                            ))}
                        </optgroup>
                    );
                })}
            </select>
        )
    );

    const renderTableSelect = (column: QueryGridColumn): ReactElement => (
        <select
            aria-label="Table"
            className="vqb-grid-select"
            disabled={column.aggregate === 'EXPRESSION'}
            onChange={event => handleTableChange(column.id, event.target.value)}
            value={column.tableInstanceId}
        >
            <option value="">—</option>
            {placedTables.map(source => (
                <option key={source.instanceId} value={source.instanceId}>
                    {source.alias} · {source.tableName}
                </option>
            ))}
        </select>
    );

    const renderShowCheckbox = (column: QueryGridColumn): ReactElement => (
        <input
            aria-label={`Show ${column.columnName || 'field'}`}
            checked={column.show}
            className="vqb-grid-checkbox"
            onChange={event => onUpdateColumn(column.id, { show: event.target.checked })}
            type="checkbox"
        />
    );

    const renderTotalSelect = (column: QueryGridColumn): ReactElement => (
        <select
            aria-label="Total"
            className="vqb-grid-select"
            onChange={event => handleAggregateChange(column.id, event.target.value as QueryGridAggregate)}
            value={column.aggregate}
        >
            <option value="NONE">—</option>
            <option value="GROUP BY">Group By</option>
            <option value="WHERE">Where</option>
            {GRID_AGGREGATE_FUNCTIONS.map(aggregate => (
                <option key={aggregate} value={aggregate}>{aggregate}</option>
            ))}
            <option value="EXPRESSION">Expression</option>
        </select>
    );

    const renderSortSelect = (column: QueryGridColumn): ReactElement => (
        <select
            aria-label="Sort"
            className="vqb-grid-select"
            onChange={event => onUpdateColumn(column.id, { sort: event.target.value as QueryGridSort })}
            value={column.sort}
        >
            <option value="NONE">—</option>
            <option value="ASC">Ascending</option>
            <option value="DESC">Descending</option>
        </select>
    );

    const renderCriteriaInput = (column: QueryGridColumn, rowIndex: number, label: string): ReactElement => (
        <input
            aria-label={`${label} for ${column.columnName || 'field'}`}
            className="vqb-grid-input"
            onChange={event => handleCriteriaChange(column.id, rowIndex, event.target.value)}
            placeholder={rowIndex === 0 ? "e.g. = 'ACTIVE' or > 100" : 'or'}
            value={column.criteriaRows[rowIndex] ?? ''}
        />
    );

    const hasSources = placedTables.length > 0;

    return (
        <section className="vqb-filter-grid" aria-label="Filter and sort">
            <div className="vqb-grid-header">
                <span className="vqb-grid-title">Filter & Sort</span>
                <div className="vqb-grid-header-actions">
                    <button
                        className="diagram-button"
                        disabled={!hasSources}
                        onClick={() => onAddColumn()}
                        type="button"
                    >
                        + Field
                    </button>
                    <button
                        className="diagram-button"
                        disabled={columns.length === 0}
                        onClick={onClearColumns}
                        type="button"
                    >
                        Clear
                    </button>
                    <button
                        aria-label={collapsed ? 'Expand filter grid' : 'Collapse filter grid'}
                        className="diagram-icon-button"
                        onClick={() => setCollapsed(value => !value)}
                        type="button"
                    >
                        {collapsed ? '▸' : '▾'}
                    </button>
                </div>
            </div>
            {!collapsed && (
                <div className="vqb-grid-body">
                    {!hasSources ? (
                        <p className="vqb-grid-empty">Add sources to the canvas to build filters and sorting.</p>
                    ) : columns.length === 0 ? (
                        <p className="vqb-grid-empty">
                            No filter fields. Click + Field, or double-click a column on a source card.
                        </p>
                    ) : (
                        <>
                            <div className="vqb-grid-row">
                                <span className="vqb-grid-row-label" aria-hidden="true" />
                                <div className="vqb-grid-row-cells">
                                    {columns.map((column, index) => (
                                        <div className="vqb-grid-cell vqb-grid-reorder-cell" key={column.id}>
                                            <div className="vqb-grid-reorder-actions">
                                                <button
                                                    aria-label={`Move ${column.columnName || 'field'} up`}
                                                    className="diagram-icon-button"
                                                    disabled={index === 0}
                                                    onClick={() => onMoveColumn(column.id, -1)}
                                                    title="Move up (earlier in ORDER BY / GROUP BY)"
                                                    type="button"
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    aria-label={`Move ${column.columnName || 'field'} down`}
                                                    className="diagram-icon-button"
                                                    disabled={index === columns.length - 1}
                                                    onClick={() => onMoveColumn(column.id, 1)}
                                                    title="Move down (later in ORDER BY / GROUP BY)"
                                                    type="button"
                                                >
                                                    ↓
                                                </button>
                                                <button
                                                    aria-label={`Remove ${column.columnName || 'field'}`}
                                                    className="diagram-icon-button"
                                                    onClick={() => onRemoveColumn(column.id)}
                                                    title="Remove field"
                                                    type="button"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="vqb-grid-row">
                                <span className="vqb-grid-row-label">Field</span>
                                <div className="vqb-grid-row-cells">
                                    {columns.map(column => (
                                        <div className="vqb-grid-cell" key={column.id}>
                                            {renderFieldControl(column)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="vqb-grid-row">
                                <span className="vqb-grid-row-label">Table</span>
                                <div className="vqb-grid-row-cells">
                                    {columns.map(column => (
                                        <div className="vqb-grid-cell" key={column.id}>
                                            {renderTableSelect(column)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="vqb-grid-row">
                                <span className="vqb-grid-row-label">Show</span>
                                <div className="vqb-grid-row-cells">
                                    {columns.map(column => (
                                        <div className="vqb-grid-cell vqb-grid-show-cell" key={column.id}>
                                            {renderShowCheckbox(column)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="vqb-grid-row">
                                <span className="vqb-grid-row-label">Total</span>
                                <div className="vqb-grid-row-cells">
                                    {columns.map(column => (
                                        <div className="vqb-grid-cell" key={column.id}>
                                            {renderTotalSelect(column)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="vqb-grid-row">
                                <span className="vqb-grid-row-label">Sort</span>
                                <div className="vqb-grid-row-cells">
                                    {columns.map(column => (
                                        <div className="vqb-grid-cell" key={column.id}>
                                            {renderSortSelect(column)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="vqb-grid-row">
                                <span
                                    className="vqb-grid-row-label"
                                    title={hasAggregate
                                        ? 'Criteria on aggregated fields becomes HAVING; other fields filter in WHERE'
                                        : undefined}
                                >
                                    Criteria
                                </span>
                                <div className="vqb-grid-row-cells">
                                    {columns.map(column => (
                                        <div className="vqb-grid-cell" key={column.id}>
                                            {renderCriteriaInput(column, 0, 'Criteria')}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {Array.from({ length: OR_ROW_COUNT }, (_, rowIndex) => (
                                <div className="vqb-grid-row" key={rowIndex}>
                                    <span className="vqb-grid-row-label">Or</span>
                                    <div className="vqb-grid-row-cells">
                                        {columns.map(column => (
                                            <div className="vqb-grid-cell" key={column.id}>
                                                {renderCriteriaInput(column, rowIndex + 1, 'Or')}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            )}
        </section>
    );
}