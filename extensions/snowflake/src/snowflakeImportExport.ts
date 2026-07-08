import { formatIdentifierForSql, formatQualifiedObjectName } from '../../../src/utils/identifierUtils';

export interface SnowflakeStageLocation {
    stageName: string;
    stagePath?: string;
}

export interface SnowflakeCopyIntoTableOptions {
    database?: string;
    schema?: string;
    tableName: string;
    columns?: readonly string[];
    stage: SnowflakeStageLocation;
    fileFormatName?: string;
    inlineFileFormat?: SnowflakeInlineFileFormatOptions;
    pattern?: string;
    onError?: 'ABORT_STATEMENT' | 'CONTINUE' | 'SKIP_FILE' | 'SKIP_FILE_1' | 'SKIP_FILE_10';
    matchByColumnName?: 'CASE_SENSITIVE' | 'CASE_INSENSITIVE' | 'NONE';
    purge?: boolean;
}

export interface SnowflakeCopyIntoStageOptions {
    database?: string;
    schema?: string;
    tableName: string;
    stage: SnowflakeStageLocation;
    fileFormatName?: string;
    inlineFileFormat?: SnowflakeInlineFileFormatOptions;
    header?: boolean;
    overwrite?: boolean;
    single?: boolean;
    maxFileSize?: number;
}

export interface SnowflakeInlineFileFormatOptions {
    type?: 'CSV' | 'JSON' | 'AVRO' | 'ORC' | 'PARQUET' | 'XML';
    fieldDelimiter?: string;
    skipHeader?: number;
    parseHeader?: boolean;
    fieldOptionallyEnclosedBy?: string;
    trimSpace?: boolean;
    skipBlankLines?: boolean;
    emptyFieldAsNull?: boolean;
    nullIf?: readonly string[];
    encoding?: string;
    compression?: 'AUTO' | 'GZIP' | 'BZ2' | 'BROTLI' | 'ZSTD' | 'DEFLATE' | 'RAW_DEFLATE' | 'NONE';
}

function normalizeStageReference(stage: SnowflakeStageLocation): string {
    const normalizedStageName = stage.stageName.trim();
    const normalizedPath = stage.stagePath?.trim().replace(/^\/+/, '');
    return normalizedPath ? `@${normalizedStageName}/${normalizedPath}` : `@${normalizedStageName}`;
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function formatBooleanLiteral(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
}

function formatCharacterLiteral(value: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.toUpperCase() === 'NONE') {
        return 'NONE';
    }
    return quoteLiteral(normalized);
}

export function formatSnowflakeObjectReference(reference: string, database?: string, schema?: string): string {
    const normalizedReference = reference.trim();
    if (normalizedReference.includes('.')) {
        return normalizedReference
            .split('.')
            .map((part) => formatIdentifierForSql(part.trim(), 'snowflake'))
            .join('.');
    }

    return formatQualifiedObjectName(database, schema, normalizedReference, 'snowflake');
}

function buildInlineFileFormatClause(options?: SnowflakeInlineFileFormatOptions): string {
    if (!options) {
        return '';
    }

    const formatType = options.type?.trim().toUpperCase() || 'CSV';
    const entries = [`TYPE = ${formatType}`];

    if (options.fieldDelimiter !== undefined) {
        entries.push(`FIELD_DELIMITER = ${quoteLiteral(options.fieldDelimiter)}`);
    }

    if (typeof options.skipHeader === 'number' && options.skipHeader >= 0) {
        entries.push(`SKIP_HEADER = ${Math.floor(options.skipHeader)}`);
    }

    if (typeof options.parseHeader === 'boolean') {
        entries.push(`PARSE_HEADER = ${formatBooleanLiteral(options.parseHeader)}`);
    }

    if (options.fieldOptionallyEnclosedBy !== undefined) {
        entries.push(`FIELD_OPTIONALLY_ENCLOSED_BY = ${formatCharacterLiteral(options.fieldOptionallyEnclosedBy)}`);
    }

    if (typeof options.trimSpace === 'boolean') {
        entries.push(`TRIM_SPACE = ${formatBooleanLiteral(options.trimSpace)}`);
    }

    if (typeof options.skipBlankLines === 'boolean') {
        entries.push(`SKIP_BLANK_LINES = ${formatBooleanLiteral(options.skipBlankLines)}`);
    }

    if (typeof options.emptyFieldAsNull === 'boolean') {
        entries.push(`EMPTY_FIELD_AS_NULL = ${formatBooleanLiteral(options.emptyFieldAsNull)}`);
    }

    if (options.nullIf && options.nullIf.length > 0) {
        entries.push(`NULL_IF = (${options.nullIf.map((value) => quoteLiteral(value)).join(', ')})`);
    }

    if (options.encoding?.trim()) {
        entries.push(`ENCODING = ${quoteLiteral(options.encoding.trim())}`);
    }

    if (options.compression?.trim()) {
        entries.push(`COMPRESSION = ${options.compression.trim().toUpperCase()}`);
    }

    return `\nFILE_FORMAT = (\n    ${entries.join('\n    ')}\n)`;
}

function buildFileFormatClause(
    fileFormatName?: string,
    inlineFileFormat?: SnowflakeInlineFileFormatOptions,
): string {
    if (!fileFormatName?.trim()) {
        return buildInlineFileFormatClause(inlineFileFormat);
    }

    return `\nFILE_FORMAT = (FORMAT_NAME = ${formatIdentifierForSql(fileFormatName.trim(), 'snowflake')})`;
}

export function buildSnowflakeCopyIntoTableSql(options: SnowflakeCopyIntoTableOptions): string {
    const qualifiedTableName = formatSnowflakeObjectReference(options.tableName, options.database, options.schema);
    const normalizedColumns = (options.columns ?? []).map((column) => column.trim()).filter(Boolean);
    const columnClause =
        normalizedColumns.length > 0
            ? ` (${normalizedColumns.map((column) => formatIdentifierForSql(column, 'snowflake')).join(', ')})`
            : '';
    const lines = [`COPY INTO ${qualifiedTableName}${columnClause}`, `FROM ${normalizeStageReference(options.stage)}`];

    const fileFormatClause = buildFileFormatClause(options.fileFormatName, options.inlineFileFormat);
    if (fileFormatClause) {
        lines.push(fileFormatClause.trim());
    }

    if (options.pattern?.trim()) {
        lines.push(`PATTERN = '${options.pattern.trim().replace(/'/g, "''")}'`);
    }

    if (options.matchByColumnName && options.matchByColumnName !== 'NONE') {
        lines.push(`MATCH_BY_COLUMN_NAME = ${options.matchByColumnName}`);
    }

    if (options.onError) {
        lines.push(`ON_ERROR = ${options.onError}`);
    }

    if (options.purge) {
        lines.push('PURGE = TRUE');
    }

    return `${lines.join('\n')};`;
}

export function buildSnowflakeCopyIntoStageSql(options: SnowflakeCopyIntoStageOptions): string {
    const qualifiedTableName = formatSnowflakeObjectReference(options.tableName, options.database, options.schema);
    const lines = [`COPY INTO ${normalizeStageReference(options.stage)}`, `FROM ${qualifiedTableName}`];

    const fileFormatClause = buildFileFormatClause(options.fileFormatName, options.inlineFileFormat);
    if (fileFormatClause) {
        lines.push(fileFormatClause.trim());
    }

    lines.push(`HEADER = ${options.header ? 'TRUE' : 'FALSE'}`);
    lines.push(`OVERWRITE = ${options.overwrite ? 'TRUE' : 'FALSE'}`);
    lines.push(`SINGLE = ${options.single ? 'TRUE' : 'FALSE'}`);

    if (typeof options.maxFileSize === 'number' && options.maxFileSize > 0) {
        lines.push(`MAX_FILE_SIZE = ${Math.round(options.maxFileSize)}`);
    }

    return `${lines.join('\n')};`;
}

export function buildSnowflakeCreateStageTemplate(stage: SnowflakeStageLocation, url?: string): string {
    const qualifiedStage = stage.stageName.includes('.')
        ? stage.stageName
              .split('.')
              .map((part) => formatIdentifierForSql(part, 'snowflake'))
              .join('.')
        : formatIdentifierForSql(stage.stageName, 'snowflake');

    const lines = [`CREATE OR REPLACE STAGE ${qualifiedStage}`];

    if (url?.trim()) {
        lines.push(`URL = '${url.trim().replace(/'/g, "''")}'`);
    }

    lines.push(`COMMENT = 'Managed from JustyBase Snowflake workflow';`);
    return lines.join('\n');
}

export function buildSnowflakeStageUsageGuide(stage: SnowflakeStageLocation): string {
    const stageRef = normalizeStageReference(stage);
    return [
        '# Snowflake Stage Workflow',
        '',
        `- Preferred upload target: \`${stageRef}\``,
        '- Recommended path: use external stages backed by S3/GCS/Azure and upload with your cloud-native tooling or presigned links.',
        '- Local `PUT` is not executed by this extension because it requires SnowSQL/CLI access outside the bundled runtime.',
        '- Keep stage credentials out of the repository and prefer IAM roles, scoped storage integrations, or short-lived credentials.',
        '',
        '## Example Import',
        '',
        '```sql',
        buildSnowflakeCopyIntoTableSql({
            tableName: 'TARGET_TABLE',
            stage,
            fileFormatName: 'MY_CSV_FORMAT',
            onError: 'ABORT_STATEMENT',
            matchByColumnName: 'CASE_INSENSITIVE',
        }),
        '```',
        '',
        '## Example Export',
        '',
        '```sql',
        buildSnowflakeCopyIntoStageSql({
            tableName: 'TARGET_TABLE',
            stage,
            fileFormatName: 'MY_CSV_FORMAT',
            header: true,
            overwrite: true,
            single: false,
        }),
        '```',
    ].join('\n');
}
