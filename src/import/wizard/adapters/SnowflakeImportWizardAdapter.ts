import * as path from 'node:path';
import type { SnowflakePlannedImportColumn } from '../../../../extensions/snowflake/src/snowflakeImportPlanner';
import {
    buildCreateTableSql,
    buildDefaultStageLocation,
    buildInlineCsvFileFormat,
    buildWorkflowNextSteps,
    buildWorkflowWarnings,
    createSnowflakeStagedImportResult,
    mapImportTypeToSnowflake,
} from '../../../../extensions/snowflake/src/snowflakeImportPlanner';
import { buildSnowflakeCopyIntoTableSql } from '../../../../extensions/snowflake/src/snowflakeImportExport';
import type {
    CreateTablePreviewInput,
    ImportExecutionInput,
    LoadSqlPreviewInput,
} from './DatabaseImportWizardAdapter';
import {
    BaseImportWizardAdapter,
    getBaseImportTypeName,
    type ImportWizardValidationIssue,
    normalizeImportTypeName,
} from './DatabaseImportWizardAdapter';

const DIRECT_STAGE_LOAD_EXTENSIONS = new Set(['.csv', '.txt']);

export class SnowflakeImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'snowflake' as const;

    public constructor() {
        super('workflow');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);

        if (baseType === 'DATETIME') {
            return 'TIMESTAMP_NTZ';
        }
        if (baseType === 'NVARCHAR') {
            return normalized.replace(/^NVARCHAR/i, 'VARCHAR');
        }

        return mapImportTypeToSnowflake(normalized);
    }

    public validateTypeOverride(typeName: string): ImportWizardValidationIssue[] {
        const issues = super.validateTypeOverride(typeName);
        if (issues.length > 0) {
            return issues;
        }

        return [];
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        const columns: SnowflakePlannedImportColumn[] = input.columns.map((column) => ({
            sourceColumn: column.columnName,
            targetColumn: column.columnName,
            sourceType: column.dataType,
            snowflakeType: mapImportTypeToSnowflake(column.dataType),
        }));
        return buildCreateTableSql(input.targetTable, columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        const sourceFormat = path.extname(input.filePath).toLowerCase();
        if (!DIRECT_STAGE_LOAD_EXTENSIONS.has(sourceFormat)) {
            return undefined;
        }

        const stage = buildDefaultStageLocation(input.filePath);
        return buildSnowflakeCopyIntoTableSql({
            tableName: input.targetTable,
            columns: input.columns.map((column) => column.columnName),
            stage,
            inlineFileFormat: buildInlineCsvFileFormat(input.detectedDelimiter),
            onError: 'ABORT_STATEMENT',
        });
    }

    public buildExecutionPlan(input: LoadSqlPreviewInput) {
        const sourceFormat = path.extname(input.filePath).toLowerCase();
        const loadSql = this.buildLoadSql(input);
        const stage = buildDefaultStageLocation(input.filePath);
        return {
            mode: this.getExecutionMode(),
            createTableSql: this.buildCreateTableSql(input),
            loadSql,
            warnings: buildWorkflowWarnings(sourceFormat),
            nextSteps: buildWorkflowNextSteps(stage, Boolean(loadSql)),
        };
    }

    public async execute(input: ImportExecutionInput) {
        return createSnowflakeStagedImportResult(input.filePath, input.targetTable, input.columnOptions);
    }
}

export const snowflakeImportWizardAdapter = new SnowflakeImportWizardAdapter();
