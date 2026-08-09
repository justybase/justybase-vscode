import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { accessBatchImportConfig } from '../../accessImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, getBaseImportTypeName, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class AccessImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'access' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);
        if (baseType === 'BOOLEAN' || baseType === 'BIT') {
            return 'BOOLEAN';
        }
        if (baseType === 'VARCHAR' || baseType === 'NVARCHAR') {
            return 'TEXT(255)';
        }
        if (baseType === 'DATE' || baseType === 'TIMESTAMP' || baseType === 'DATETIME') {
            return 'DATETIME';
        }
        if (baseType === 'BIGINT' || baseType === 'INT' || baseType === 'INTEGER') {
            return 'INTEGER';
        }
        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return buildBatchCreateTablePreview(accessBatchImportConfig, input.targetTable, input.connectionDetails, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return buildBatchLoadPreview(
            accessBatchImportConfig,
            input.targetTable,
            input.connectionDetails,
            input.columns,
            input.previewRows,
            input.decimalDelimiter,
        );
    }
}

export const accessImportWizardAdapter = new AccessImportWizardAdapter();
