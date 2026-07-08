import { buildColumnCacheKey } from '../metadata/columnRowMapping';
import type { MetadataCache } from '../metadataCache';
import type { ColumnMetadata } from '../metadata/types';
import type { SchemaSearchResultItem } from '../contracts/webviews/schemaSearchContracts';
import { formatQualifiedObjectName } from '../utils/identifierUtils';
import type { DatabaseKind } from '../contracts/database';

export interface SchemaObjectPreviewOptions {
    connectionName: string;
    databaseKind?: DatabaseKind;
}

export function buildQualifiedSearchObjectName(
    item: SchemaSearchResultItem,
    databaseKind?: DatabaseKind,
): string {
    if (item.TYPE === 'COLUMN' && item.PARENT) {
        const tableQualified = formatQualifiedObjectName(
            item.DATABASE,
            item.SCHEMA,
            item.PARENT,
            databaseKind,
        );
        return `${tableQualified}.${item.NAME}`;
    }

    return formatQualifiedObjectName(
        item.DATABASE,
        item.SCHEMA,
        item.NAME,
        databaseKind,
    );
}

export function buildSchemaObjectPreview(
    metadataCache: MetadataCache,
    item: SchemaSearchResultItem,
    options: SchemaObjectPreviewOptions,
): string | undefined {
    const lines: string[] = [];
    const qualifiedName = buildQualifiedSearchObjectName(item, options.databaseKind);
    lines.push(qualifiedName);
    lines.push(`${item.TYPE}${item.MATCH_TYPE ? ` · ${item.MATCH_TYPE}` : ''}`);

    if (item.DESCRIPTION && item.DESCRIPTION !== 'Result from Cache' && item.DESCRIPTION !== 'Recent object') {
        lines.push(`Description: ${item.DESCRIPTION}`);
    }

    const tableName = item.TYPE === 'COLUMN' ? item.PARENT : item.NAME;
    if (!tableName || !item.DATABASE) {
        return lines.length > 2 ? lines.join('\n') : undefined;
    }

    const columnKey = buildColumnCacheKey(item.DATABASE, item.SCHEMA || undefined, tableName);
    const columns = metadataCache.getColumns(options.connectionName, columnKey);
    if (!columns || columns.length === 0) {
        return lines.length > 2 ? lines.join('\n') : undefined;
    }

    if (item.TYPE === 'COLUMN') {
        const column = columns.find((entry) => matchesColumnName(entry, item.NAME));
        if (column) {
            appendColumnPreviewLines(lines, column);
        }
        return lines.join('\n');
    }

    const pkColumns = columns.filter((column) => column.isPk).map((column) => column.label || column.ATTNAME);
    const distColumns = columns
        .filter((column) => column.isDistributionKey)
        .map((column) => column.label || column.ATTNAME);

    if (pkColumns.length > 0) {
        lines.push(`Primary key: ${pkColumns.join(', ')}`);
    }
    if (distColumns.length > 0) {
        lines.push(`Distribution: ${distColumns.join(', ')}`);
    }

    lines.push(`Columns (${columns.length}):`);
    const previewColumns = columns.slice(0, 12);
    for (const column of previewColumns) {
        lines.push(`  • ${formatColumnPreviewLine(column)}`);
    }
    if (columns.length > previewColumns.length) {
        lines.push(`  … +${columns.length - previewColumns.length} more`);
    }

    return lines.join('\n');
}

function matchesColumnName(column: ColumnMetadata, name: string): boolean {
    const normalized = name.toUpperCase();
    const candidates = [column.label, column.ATTNAME].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return candidates.some((value) => value.toUpperCase() === normalized);
}

function appendColumnPreviewLines(lines: string[], column: ColumnMetadata): void {
    const dataType = column.detail || column.FORMAT_TYPE;
    if (dataType) {
        lines.push(`Type: ${dataType}`);
    }
    if (column.isPk) {
        lines.push('Primary key');
    }
    if (column.isFk) {
        lines.push('Foreign key');
    }
    if (column.isDistributionKey) {
        lines.push('Distribution key');
    }
    const description =
        (typeof column.documentation === 'string' && column.documentation.trim())
            ? column.documentation
            : typeof column.DESCRIPTION === 'string'
              ? column.DESCRIPTION
              : undefined;
    if (description) {
        lines.push(`Description: ${description}`);
    }
}

function formatColumnPreviewLine(column: ColumnMetadata): string {
    const name = column.label || column.ATTNAME;
    const dataType = column.detail || column.FORMAT_TYPE || '';
    const badges: string[] = [];
    if (column.isPk) {
        badges.push('PK');
    }
    if (column.isFk) {
        badges.push('FK');
    }
    if (column.isDistributionKey) {
        badges.push('DIST');
    }
    const badgeText = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
    return dataType ? `${name} (${dataType})${badgeText}` : `${name}${badgeText}`;
}
