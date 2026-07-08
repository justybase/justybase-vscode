import type { DatabaseKind } from '../../../contracts/database';
import type { ConnectionDetails } from '../../../types';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../../utils/identifierUtils';
import type {
    ImportColumnDescriptor,
    ImportColumnOptions,
    ImportResult,
    ProgressCallback,
} from '../../dataImporter';
import { importDataForConnection } from '../../importDispatcher';
import { normalizeImportedHeader } from '../../importHeaderUtils';
import type { TabularDataImporter } from '../../tabularDataImporter';
import type {
    ImportExecutionPlan,
    ImportWizardExecutionMode,
    ImportWizardIssueSeverity,
} from '../ImportWizardState';

const FORCED_DATA_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;

const DEFAULT_TYPE_OPTIONS_BY_KIND: Record<DatabaseKind, string[]> = {
    netezza: ['INTEGER', 'BIGINT', 'NUMERIC(18,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'NVARCHAR(255)', 'NVARCHAR(1024)'],
    postgresql: ['INTEGER', 'BIGINT', 'NUMERIC(18,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR(255)', 'TEXT'],
    vertica: ['INTEGER', 'BIGINT', 'NUMERIC(18,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR(255)', 'LONG VARCHAR'],
    db2: ['INTEGER', 'BIGINT', 'DECIMAL(31,10)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR(255)', 'CLOB'],
    mssql: ['INT', 'BIGINT', 'DECIMAL(28,10)', 'DATE', 'DATETIME2', 'BIT', 'NVARCHAR(255)', 'NVARCHAR(4000)'],
    snowflake: ['INTEGER', 'BIGINT', 'NUMERIC(18,2)', 'DATE', 'TIMESTAMP_NTZ', 'BOOLEAN', 'VARCHAR(255)', 'TEXT'],
    oracle: ['NUMBER(10,0)', 'NUMBER(19,0)', 'NUMBER(18,2)', 'DATE', 'TIMESTAMP', 'NUMBER(1)', 'VARCHAR2(255 CHAR)', 'CLOB'],
    mysql: ['INTEGER', 'BIGINT', 'DECIMAL(18,2)', 'DATE', 'DATETIME', 'BOOLEAN', 'VARCHAR(255)', 'TEXT'],
    sqlite: ['INTEGER', 'NUMERIC', 'REAL', 'DATE', 'TIMESTAMP', 'TEXT'],
    duckdb: ['INTEGER', 'BIGINT', 'DECIMAL(18,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR', 'DOUBLE'],
};

export interface ImportWizardValidationIssue {
    severity: ImportWizardIssueSeverity;
    message: string;
}

export interface CreateTablePreviewInput {
    filePath: string;
    targetTable: string;
    connectionDetails: ConnectionDetails;
    columns: ImportColumnDescriptor[];
    columnOptions?: ImportColumnOptions;
    importer?: TabularDataImporter;
}

export interface LoadSqlPreviewInput extends CreateTablePreviewInput {
    previewRows: string[][];
    detectedDelimiter?: string;
    decimalDelimiter: string;
}

export interface ImportExecutionInput {
    filePath: string;
    targetTable: string;
    connectionDetails: ConnectionDetails;
    columnOptions?: ImportColumnOptions;
    progressCallback?: ProgressCallback;
    timeoutSeconds?: number;
}

export interface DatabaseImportWizardAdapter {
    readonly kind: DatabaseKind;
    normalizeTargetColumnName(name: string): string;
    getSupportedTypeOptions(): string[];
    mapInferredType(typeName: string): string;
    validateTypeOverride(typeName: string): ImportWizardValidationIssue[];
    buildCreateTableSql(input: CreateTablePreviewInput): string;
    buildLoadSql?(input: LoadSqlPreviewInput): string | undefined;
    buildExecutionPlan(input: LoadSqlPreviewInput): ImportExecutionPlan;
    execute?(input: ImportExecutionInput): Promise<ImportResult>;
    getExecutionMode(): ImportWizardExecutionMode;
}

export function normalizeImportTypeName(typeName: string): string {
    return typeName.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function getBaseImportTypeName(typeName: string): string {
    const normalized = normalizeImportTypeName(typeName);
    const parenIndex = normalized.indexOf('(');
    return (parenIndex >= 0 ? normalized.slice(0, parenIndex) : normalized).trim();
}

export function getDefaultImportWizardTypeOptions(kind: DatabaseKind): string[] {
    return [...DEFAULT_TYPE_OPTIONS_BY_KIND[kind]];
}

export function formatQualifiedImportTarget(targetTable: string, kind: DatabaseKind): string {
    const parts = targetTable
        .split('.')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (parts.length === 0 || parts.length > 3) {
        throw new Error('Invalid target table format. Use TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE.');
    }

    if (parts.length === 1) {
        return formatIdentifierForSql(parts[0], kind);
    }

    if (parts.length === 2) {
        return formatQualifiedObjectName(undefined, parts[0], parts[1], kind);
    }

    return formatQualifiedObjectName(parts[0], parts[1], parts[2], kind);
}

export abstract class BaseImportWizardAdapter implements DatabaseImportWizardAdapter {
    public abstract readonly kind: DatabaseKind;

    protected constructor(private readonly executionMode: ImportWizardExecutionMode = 'direct') {}

    public normalizeTargetColumnName(name: string): string {
        return normalizeImportedHeader(name, this.kind);
    }

    public getSupportedTypeOptions(): string[] {
        return getDefaultImportWizardTypeOptions(this.kind);
    }

    public validateTypeOverride(typeName: string): ImportWizardValidationIssue[] {
        const normalized = normalizeImportTypeName(typeName);
        if (!normalized || !FORCED_DATA_TYPE_PATTERN.test(normalized)) {
            return [{ severity: 'error', message: `Invalid data type override: ${typeName}` }];
        }

        return [];
    }

    public getExecutionMode(): ImportWizardExecutionMode {
        return this.executionMode;
    }

    public buildExecutionPlan(input: LoadSqlPreviewInput): ImportExecutionPlan {
        return {
            mode: this.getExecutionMode(),
            createTableSql: this.buildCreateTableSql(input),
            loadSql: this.buildLoadSql?.(input),
            warnings: [],
        };
    }

    public async execute(input: ImportExecutionInput): Promise<ImportResult> {
        return importDataForConnection(
            input.filePath,
            input.targetTable,
            input.connectionDetails,
            input.progressCallback,
            input.timeoutSeconds,
            input.columnOptions,
        );
    }

    public abstract mapInferredType(typeName: string): string;
    public abstract buildCreateTableSql(input: CreateTablePreviewInput): string;
    public buildLoadSql?(input: LoadSqlPreviewInput): string | undefined;
}
