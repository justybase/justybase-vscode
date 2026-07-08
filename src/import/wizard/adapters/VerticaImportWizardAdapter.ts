import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { verticaBatchImportConfig } from '../../verticaImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, getBaseImportTypeName, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class VerticaImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'vertica' as const;

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
        if (baseType === 'TEXT') {
            return 'LONG VARCHAR';
        }
        if (baseType === 'TIMESTAMP WITH TIME ZONE') {
            return 'TIMESTAMPTZ';
        }

        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return buildBatchCreateTablePreview(verticaBatchImportConfig, input.targetTable, input.connectionDetails, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return buildBatchLoadPreview(
            verticaBatchImportConfig,
            input.targetTable,
            input.connectionDetails,
            input.columns,
            input.previewRows,
            input.decimalDelimiter,
        );
    }
}

export const verticaImportWizardAdapter = new VerticaImportWizardAdapter();
