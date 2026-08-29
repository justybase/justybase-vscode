import {
    buildClickHouseCreateTablePreview,
    buildClickHouseLoadPreview,
    importDataToClickHouse,
} from '../../clickhouseImporter';
import type { CreateTablePreviewInput, ImportExecutionInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import {
    BaseImportWizardAdapter,
    getBaseImportTypeName,
    normalizeImportTypeName,
} from './DatabaseImportWizardAdapter';

const CLICKHOUSE_NATIVE_TYPE_PATTERN = /^(?:Nullable|LowCardinality|Array|Map|Tuple|FixedString|Decimal(?:32|64|128|256)?|Enum(?:8|16)|U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Bool|Boolean|String|UUID|Date(?:32)?|DateTime(?:64)?|IPv4|IPv6|JSON)(?:\s*\([\s\S]*\))?$/i;

export class ClickHouseImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'clickhouse' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const nativeType = typeName.trim();
        if (CLICKHOUSE_NATIVE_TYPE_PATTERN.test(nativeType)) {
            return nativeType;
        }

        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);
        if (['INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT'].includes(baseType)) return 'Int64';
        if (['FLOAT', 'REAL', 'DOUBLE'].includes(baseType)) return 'Float64';
        if (['NUMERIC', 'DECIMAL', 'NUMBER'].includes(baseType)) return normalized.replace(/^(NUMERIC|NUMBER)/, 'Decimal');
        if (baseType === 'BOOLEAN' || baseType === 'BIT') return 'Bool';
        if (baseType === 'DATE') return 'Date';
        if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') return 'DateTime64(3)';
        if (baseType === 'UUID') return 'UUID';
        return 'String';
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return buildClickHouseCreateTablePreview(
            input.targetTable,
            input.connectionDetails,
            input.columns.map(column => ({ ...column, dataType: this.mapInferredType(column.dataType) })),
        );
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return buildClickHouseLoadPreview(
            input.targetTable,
            input.connectionDetails,
            input.columns.map(column => ({ ...column, dataType: this.mapInferredType(column.dataType) })),
            input.previewRows,
            input.decimalDelimiter,
        );
    }

    public async execute(input: ImportExecutionInput) {
        return importDataToClickHouse(
            input.filePath,
            input.targetTable,
            input.connectionDetails,
            input.progressCallback,
            input.timeoutSeconds,
            input.columnOptions,
        );
    }
}

export const clickHouseImportWizardAdapter = new ClickHouseImportWizardAdapter();
