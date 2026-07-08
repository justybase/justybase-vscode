import { getRequiredDatabaseImportTypeMapper } from '../../../core/connectionFactory';
import {
    buildCopyFromSql,
    buildCreateTableSql,
    mapImportColumnsToPostgreSql,
    parsePostgreSqlTargetTable,
} from '../../postgresqlImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, getBaseImportTypeName, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class PostgreSqlImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'postgresql' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);

        if (baseType === 'DATETIME') {
            return 'TIMESTAMP';
        }
        if (baseType === 'NVARCHAR') {
            return normalized.replace(/^NVARCHAR/i, 'VARCHAR');
        }

        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        const mapper = getRequiredDatabaseImportTypeMapper(this.kind);
        const mappedColumns = mapImportColumnsToPostgreSql(input.columns, mapper);
        const target = parsePostgreSqlTargetTable(input.targetTable, input.connectionDetails);
        return buildCreateTableSql(target, mappedColumns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string {
        const mapper = getRequiredDatabaseImportTypeMapper(this.kind);
        const mappedColumns = mapImportColumnsToPostgreSql(input.columns, mapper);
        const target = parsePostgreSqlTargetTable(input.targetTable, input.connectionDetails);
        return `${buildCopyFromSql(target, mappedColumns, input.detectedDelimiter || ',', 'advanced_preview_stream')}\n-- Execution streams all selected rows via COPY FROM STDIN.`;
    }
}

export const postgreSqlImportWizardAdapter = new PostgreSqlImportWizardAdapter();
