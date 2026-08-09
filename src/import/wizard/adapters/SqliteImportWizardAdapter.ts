import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { sqliteBatchImportConfig } from '../../sqliteImporter';
import { sqliteImportTypeMapper } from '../../../dialects/sqlite/importTypeMapper';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class SqliteImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'sqlite' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        return sqliteImportTypeMapper.createDataType(normalized).toString();
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
