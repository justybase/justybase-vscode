export interface TableMetadataCommentColumn {
    name: string;
    dataType: string;
    description?: string;
    isPk?: boolean;
    isFk?: boolean;
    isDistributionKey?: boolean;
}

export interface TableMetadataCommentInput {
    tableName: string;
    qualifiedName: string;
    tableDescription?: string;
    objectType?: string;
    columns: TableMetadataCommentColumn[];
}

const BULLET = '•';
const SUB_BULLET = '└─';

export function getColumnTypeSymbol(dataType: string | undefined): string {
    if (!dataType?.trim()) {
        return '○';
    }

    const normalizedType = dataType.toUpperCase();
    if (/\b(BOOL|BOOLEAN)\b/.test(normalizedType)) {
        return '☑';
    }
    if (/\b(TIMESTAMP|DATE|TIME|INTERVAL)\b/.test(normalizedType)) {
        return '📅';
    }
    if (
        /\b(BYTEINT|SMALLINT|INTEGER|BIGINT|DECIMAL|NUMERIC|NUMBER|REAL|DOUBLE|FLOAT|MONEY|INT)\b/.test(
            normalizedType,
        )
    ) {
        return '🔢';
    }
    if (/\b(CHARACTER|VARCHAR|NVARCHAR|CHAR|NCHAR|TEXT|CLOB|XML|JSON)\b/.test(normalizedType)) {
        return '📝';
    }
    if (/\b(BYTE|BINARY|VARBINARY|BLOB|RAW)\b/.test(normalizedType)) {
        return '⬛';
    }

    return '◆';
}

function getObjectTypeSymbol(objectType?: string): string {
    switch ((objectType || 'TABLE').toUpperCase()) {
        case 'VIEW':
            return '👁';
        case 'EXTERNAL TABLE':
            return '📂';
        case 'SYNONYM':
            return '🔗';
        case 'NICKNAME':
        case 'ALIAS':
            return '↪';
        default:
            return '🗃';
    }
}

function formatColumnKeyBadges(column: TableMetadataCommentColumn): string {
    const badges: string[] = [];
    if (column.isPk) {
        badges.push('🔑 PK');
    }
    if (column.isFk) {
        badges.push('🔗 FK');
    }
    if (column.isDistributionKey) {
        badges.push('⚡ DIST');
    }
    return badges.join(' · ');
}

function formatColumnLines(column: TableMetadataCommentColumn): string[] {
    const type = column.dataType.trim() || 'unknown';
    const typeSymbol = getColumnTypeSymbol(type);
    const badges = formatColumnKeyBadges(column);
    const badgeSuffix = badges ? `  ·  ${badges}` : '';
    const lines = [`  ${BULLET} ${typeSymbol} ${column.name}  ·  \`${type}\`${badgeSuffix}`];

    const description = column.description?.trim();
    if (description) {
        lines.push(`    ${SUB_BULLET} ${description}`);
    }

    return lines;
}

export function buildTableMetadataCommentBlock(
    input: TableMetadataCommentInput,
): string {
    const objectSymbol = getObjectTypeSymbol(input.objectType);
    const lines: string[] = [
        '/*',
        '════════════════════════════════════════',
        `${objectSymbol}  ${(input.objectType || 'TABLE').toUpperCase()}  ${input.tableName}`,
    ];

    if (input.qualifiedName.toUpperCase() !== input.tableName.toUpperCase()) {
        lines.push(`   ${SUB_BULLET} ${input.qualifiedName}`);
    }

    const tableDescription = input.tableDescription?.trim();
    if (tableDescription) {
        lines.push(`   ${SUB_BULLET} ${tableDescription}`);
    }

    if (input.columns.length > 0) {
        lines.push('');
        lines.push('COLUMNS');
        lines.push('───────');
        for (const column of input.columns) {
            lines.push(...formatColumnLines(column));
        }
    }

    const primaryKeys = input.columns.filter((column) => column.isPk).map((column) => column.name);
    const foreignKeys = input.columns.filter((column) => column.isFk).map((column) => column.name);
    const distributionKeys = input.columns
        .filter((column) => column.isDistributionKey)
        .map((column) => column.name);

    const summaryLines: string[] = [];
    if (primaryKeys.length > 0) {
        summaryLines.push(`  ${BULLET} 🔑 Primary key: ${primaryKeys.join(', ')}`);
    }
    if (foreignKeys.length > 0) {
        summaryLines.push(`  ${BULLET} 🔗 Foreign keys: ${foreignKeys.join(', ')}`);
    }
    if (distributionKeys.length > 0) {
        summaryLines.push(`  ${BULLET} ⚡ Distribution: ${distributionKeys.join(', ')}`);
    }

    if (summaryLines.length > 0) {
        lines.push('');
        lines.push('KEYS & DISTRIBUTION');
        lines.push('───────────────────');
        lines.push(...summaryLines);
    }

    lines.push('════════════════════════════════════════');
    lines.push('*/');
    return lines.join('\n');
}
