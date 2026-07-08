import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { mysqlBatchImportConfig } from '../../mysqlImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class MySqlImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'mysql' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        return normalizeImportTypeName(typeName);
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return buildBatchCreateTablePreview(mysqlBatchImportConfig, input.targetTable, input.connectionDetails, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return buildBatchLoadPreview(
            mysqlBatchImportConfig,
            input.targetTable,
            input.connectionDetails,
            input.columns,
            input.previewRows,
            input.decimalDelimiter,
        );
    }
}

export const mySqlImportWizardAdapter = new MySqlImportWizardAdapter();
