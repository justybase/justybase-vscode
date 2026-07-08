import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { duckdbBatchImportConfig } from '../../duckdbImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class DuckDbImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'duckdb' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        return normalizeImportTypeName(typeName);
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return buildBatchCreateTablePreview(duckdbBatchImportConfig, input.targetTable, input.connectionDetails, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return buildBatchLoadPreview(
            duckdbBatchImportConfig,
            input.targetTable,
            input.connectionDetails,
            input.columns,
            input.previewRows,
            input.decimalDelimiter,
        );
    }
}

export const duckDbImportWizardAdapter = new DuckDbImportWizardAdapter();
