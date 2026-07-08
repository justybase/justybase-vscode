import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImportColumnDescriptor, ImportColumnOptions, ImportResult } from '../../../src/import/dataImporter';
import { createTabularDataImporter } from '../../../src/import/tabularDataImporter';
import { formatIdentifierForSql } from '../../../src/utils/identifierUtils';
import {
    buildSnowflakeCopyIntoTableSql,
    formatSnowflakeObjectReference,
    type SnowflakeInlineFileFormatOptions,
    type SnowflakeStageLocation,
} from './snowflakeImportExport';
import { SnowflakeImportDataType } from './snowflakeImportTypeMapper';

export interface SnowflakePlannedImportColumn {
    sourceColumn: string;
    targetColumn: string;
    sourceType: string;
    snowflakeType: string;
}

export interface SnowflakeStageImportPlan {
    sourceFile: string;
    sourceFormat: string;
    targetTable: string;
    rowCountEstimate: number;
    detectedDelimiter?: string;
    detectedDecimalDelimiter?: string;
    columns: SnowflakePlannedImportColumn[];
    createTableSql: string;
    copyIntoSql?: string;
    stage: SnowflakeStageLocation;
    warnings: string[];
    nextSteps: string[];
}

interface ParsedGenericImportType {
    raw: string;
    baseType: string;
    precision?: number;
    scale?: number;
    length?: number;
}

const STAGE_PLACEHOLDER_NAME = 'MY_STAGE';
const DIRECT_STAGE_LOAD_EXTENSIONS = new Set(['.csv', '.txt']);
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xlsb']);

function normalizeImportType(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function parseGenericImportType(typeName: string): ParsedGenericImportType {
    const normalized = normalizeImportType(typeName);
    const sizedTypeMatch = normalized.match(/^([A-Z0-9_ ]+)\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/);
    if (!sizedTypeMatch) {
        return { raw: normalized, baseType: normalized };
    }

    const baseType = sizedTypeMatch[1].trim();
    const firstNumber = Number(sizedTypeMatch[2]);
    const secondNumber = sizedTypeMatch[3] !== undefined ? Number(sizedTypeMatch[3]) : undefined;

    if (baseType === 'NVARCHAR' || baseType === 'VARCHAR' || baseType === 'CHAR') {
        return {
            raw: normalized,
            baseType,
            length: firstNumber,
        };
    }

    return {
        raw: normalized,
        baseType,
        precision: firstNumber,
        scale: secondNumber,
    };
}

export function mapImportTypeToSnowflake(typeName: string): string {
    const parsedType = parseGenericImportType(typeName);

    if (parsedType.baseType === 'BIGINT' || parsedType.baseType === 'INTEGER' || parsedType.baseType === 'INT') {
        return new SnowflakeImportDataType('BIGINT').toString();
    }

    if (parsedType.baseType === 'NUMERIC' || parsedType.baseType === 'DECIMAL') {
        return new SnowflakeImportDataType(parsedType.baseType, parsedType.precision, parsedType.scale).toString();
    }

    if (parsedType.baseType === 'DATE') {
        return new SnowflakeImportDataType('DATE').toString();
    }

    if (parsedType.baseType === 'DATETIME') {
        return new SnowflakeImportDataType('DATETIME').toString();
    }

    if (parsedType.baseType === 'NVARCHAR' || parsedType.baseType === 'VARCHAR' || parsedType.baseType === 'CHAR') {
        return new SnowflakeImportDataType(parsedType.baseType, undefined, undefined, parsedType.length).toString();
    }

    return parsedType.raw;
}

export function buildDefaultStageLocation(sourceFile: string): SnowflakeStageLocation {
    return {
        stageName: STAGE_PLACEHOLDER_NAME,
        stagePath: path.basename(sourceFile),
    };
}

export function buildInlineCsvFileFormat(delimiter: string | undefined): SnowflakeInlineFileFormatOptions {
    return {
        type: 'CSV',
        fieldDelimiter: delimiter && delimiter.length > 0 ? delimiter : ',',
        skipHeader: 1,
        fieldOptionallyEnclosedBy: '"',
        trimSpace: true,
        skipBlankLines: true,
        emptyFieldAsNull: true,
        nullIf: ['', 'NULL', 'null'],
        encoding: 'UTF8',
        compression: 'AUTO',
    };
}

export function buildCreateTableSql(targetTable: string, columns: readonly SnowflakePlannedImportColumn[]): string {
    const quotedTable = formatSnowflakeObjectReference(targetTable);
    const columnSql = columns
        .map((column) => `    ${formatIdentifierForSql(column.targetColumn, 'snowflake')} ${column.snowflakeType}`)
        .join(',\n');
    return `CREATE TABLE IF NOT EXISTS ${quotedTable} (\n${columnSql}\n);`;
}

export function buildWorkflowWarnings(sourceFormat: string): string[] {
    if (SPREADSHEET_EXTENSIONS.has(sourceFormat)) {
        return [
            'Snowflake COPY INTO does not load Excel workbooks directly. Convert the workbook to CSV or Parquet before uploading it to a stage.',
        ];
    }

    return [
        'The extension does not upload local files to Snowflake automatically. Upload the file to a user, table, named internal, or external stage before executing the generated COPY INTO statement.',
    ];
}

export function buildWorkflowNextSteps(
    stage: SnowflakeStageLocation,
    hasCopyIntoSql: boolean,
): string[] {
    const stageReference = stage.stagePath ? `@${stage.stageName}/${stage.stagePath}` : `@${stage.stageName}`;
    if (!hasCopyIntoSql) {
        return [
            'Convert the workbook to CSV or Parquet.',
            `Upload the converted file to ${stageReference} or adjust the placeholder stage reference.`,
            'Review and execute the generated CREATE TABLE statement.',
            'Generate or adjust a COPY INTO statement for the converted file format before loading data.',
        ];
    }

    return [
        `Upload the source file to ${stageReference} or replace the placeholder stage reference with your real stage.`,
        'Review and execute the generated CREATE TABLE statement if the target table does not already exist.',
        'Run the generated COPY INTO statement on the intended warehouse.',
        'Validate the load with COUNT(*), NULL checks, and LOAD_HISTORY / VALIDATE queries if needed.',
    ];
}

function renderColumnPreview(plan: SnowflakeStageImportPlan): string {
    const lines = [
        '| Source column | Target column | Inferred type | Snowflake type |',
        '| --- | --- | --- | --- |',
    ];

    for (const column of plan.columns) {
        lines.push(
            `| ${column.sourceColumn} | ${column.targetColumn} | ${column.sourceType} | ${column.snowflakeType} |`,
        );
    }

    return lines.join('\n');
}

export function renderSnowflakeStageImportPlanMarkdown(plan: SnowflakeStageImportPlan): string {
    const lines = [
        '# Snowflake staged import workflow',
        '',
        'This workflow was generated from a local file. No data has been uploaded to Snowflake and no rows have been loaded yet.',
        '',
        '## Source analysis',
        '',
        `- File: \`${plan.sourceFile}\``,
        `- Format: \`${plan.sourceFormat}\``,
        `- Estimated rows: \`${plan.rowCountEstimate}\``,
        `- Columns: \`${plan.columns.length}\``,
    ];

    if (plan.detectedDelimiter) {
        lines.push(`- Detected delimiter: \`${plan.detectedDelimiter}\``);
    }

    if (plan.detectedDecimalDelimiter) {
        lines.push(`- Detected decimal delimiter: \`${plan.detectedDecimalDelimiter}\``);
    }

    lines.push('', '## Recommended column mapping', '', renderColumnPreview(plan), '');

    if (plan.warnings.length > 0) {
        lines.push('## Warnings', '');
        for (const warning of plan.warnings) {
            lines.push(`- ${warning}`);
        }
        lines.push('');
    }

    lines.push('## Generated CREATE TABLE SQL', '', '```sql', plan.createTableSql, '```', '');

    if (plan.copyIntoSql) {
        lines.push('## Generated COPY INTO SQL', '', '```sql', plan.copyIntoSql, '```', '');
    } else {
        lines.push(
            '## COPY INTO status',
            '',
            'No COPY INTO statement was generated because the source file format must be converted before Snowflake can load it.',
            '',
        );
    }

    lines.push('## Next steps', '');
    for (const step of plan.nextSteps) {
        lines.push(`1. ${step}`);
    }

    return lines.join('\n');
}

function createPlanColumns(
    descriptors: readonly ImportColumnDescriptor[],
    sourceHeaders: readonly string[],
): SnowflakePlannedImportColumn[] {
    return descriptors.map((descriptor) => ({
        sourceColumn: sourceHeaders[descriptor.sourceIndex] || descriptor.columnName,
        targetColumn: descriptor.columnName,
        sourceType: descriptor.dataType,
        snowflakeType: mapImportTypeToSnowflake(descriptor.dataType),
    }));
}

export async function planSnowflakeStageImport(
    filePath: string,
    targetTable: string,
    columnOptions?: ImportColumnOptions,
): Promise<SnowflakeStageImportPlan> {
    const sourceFile = filePath.trim();
    if (!fs.existsSync(sourceFile)) {
        throw new Error(`Source file not found: ${sourceFile}`);
    }

    const normalizedTargetTable = targetTable.trim();
    if (!normalizedTargetTable) {
        throw new Error('Target table name is required.');
    }

    const importer = createTabularDataImporter(sourceFile, normalizedTargetTable);
    await importer.analyzeDataTypes();
    importer.applyColumnOptions(columnOptions);

    const sourceFormat = path.extname(sourceFile).toLowerCase();
    const stage = buildDefaultStageLocation(sourceFile);
    const sourceHeaders = importer.getSourceHeaders();
    const descriptors = importer.getEffectiveColumnDescriptors();
    const columns = createPlanColumns(descriptors, sourceHeaders);
    if (columns.length === 0) {
        throw new Error('No columns were detected for Snowflake import planning.');
    }

    const createTableSql = buildCreateTableSql(normalizedTargetTable, columns);
    const copyIntoSql = DIRECT_STAGE_LOAD_EXTENSIONS.has(sourceFormat)
        ? buildSnowflakeCopyIntoTableSql({
              tableName: normalizedTargetTable,
              columns: columns.map((column) => column.targetColumn),
              stage,
              inlineFileFormat: buildInlineCsvFileFormat(importer.getCsvDelimiter()),
              onError: 'ABORT_STATEMENT',
          })
        : undefined;
    const warnings = buildWorkflowWarnings(sourceFormat);
    const nextSteps = buildWorkflowNextSteps(stage, Boolean(copyIntoSql));

    return {
        sourceFile,
        sourceFormat,
        targetTable: normalizedTargetTable,
        rowCountEstimate: importer.getRowsCount(),
        detectedDelimiter: importer.getCsvDelimiter(),
        detectedDecimalDelimiter: importer.getDecimalDelimiter(),
        columns,
        createTableSql,
        copyIntoSql,
        stage,
        warnings,
        nextSteps,
    };
}

export async function createSnowflakeStagedImportResult(
    filePath: string,
    targetTable: string,
    columnOptions?: ImportColumnOptions,
): Promise<ImportResult> {
    const plan = await planSnowflakeStageImport(filePath, targetTable, columnOptions);
    const workflowMarkdown = renderSnowflakeStageImportPlanMarkdown(plan);

    return {
        success: false,
        message: plan.copyIntoSql
            ? 'Snowflake local-file imports require a staged COPY INTO workflow. A ready-to-review import plan was generated.'
            : 'Snowflake does not load spreadsheet files directly with COPY INTO. Convert the workbook to CSV or Parquet, upload it to a stage, and then use the generated workflow.',
        details: {
            sourceFile: plan.sourceFile,
            targetTable: plan.targetTable,
            format: plan.sourceFormat,
            rowsProcessed: plan.rowCountEstimate,
            columns: plan.columns.length,
            detectedDelimiter: plan.detectedDelimiter,
            snowflakeWorkflow: {
                workflowMarkdown,
                createTableSql: plan.createTableSql,
                copyIntoSql: plan.copyIntoSql,
                warnings: plan.warnings,
                nextSteps: plan.nextSteps,
                stageName: plan.stage.stageName,
                stagePath: plan.stage.stagePath,
                sourceFormat: plan.sourceFormat,
            },
        },
    };
}

export function createSnowflakeClipboardImportResult(targetTable: string): ImportResult {
    const normalizedTargetTable = targetTable.trim();
    const workflowMarkdown = [
        '# Snowflake clipboard import guidance',
        '',
        'Snowflake clipboard import is not executed directly by this extension.',
        '',
        '## Recommended workflow',
        '',
        '1. Save the clipboard contents to a CSV file.',
        '2. Use `Import Data to Table` to generate a staged Snowflake load workflow for that file.',
        '3. Upload the file to a Snowflake stage and run the generated COPY INTO SQL.',
        '',
        `- Target table: \`${normalizedTargetTable}\``,
    ].join('\n');

    return {
        success: false,
        message:
            'Snowflake clipboard import is not executed directly. Save the clipboard contents to CSV and use the staged Snowflake import workflow instead.',
        details: {
            targetTable: normalizedTargetTable,
            snowflakeWorkflow: {
                workflowMarkdown,
                warnings: ['Snowflake loads staged files rather than raw clipboard payloads.'],
                nextSteps: [
                    'Save the clipboard contents to a CSV file.',
                    'Run Import Data to Table for that CSV file to generate a Snowflake staged load workflow.',
                ],
            },
        },
    };
}
