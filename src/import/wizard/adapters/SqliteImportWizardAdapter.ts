import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { sqliteBatchImportConfig } from '../../sqliteImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, getBaseImportTypeName, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class SqliteImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'sqlite' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);
        if (baseType === 'BOOLEAN') {
            return 'INTEGER';
        }
        if (baseType === 'VARCHAR' || baseType === 'NVARCHAR') {
            return 'TEXT';
        }
        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return buildBatchCreateTablePreview(sqliteBatchImportConfig, input.targetTable, input.connectionDetails, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return buildBatchLoadPreview(
            sqliteBatchImportConfig,
            input.targetTable,
            input.connectionDetails,
            input.columns,
            input.previewRows,
            input.decimalDelimiter,
        );
    }
}

export const sqliteImportWizardAdapter = new SqliteImportWizardAdapter();
