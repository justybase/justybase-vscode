import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { oracleBatchImportConfig } from '../../oracleImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, getBaseImportTypeName, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class OracleImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'oracle' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);

        if (baseType === 'BIGINT') {
            return 'NUMBER(19,0)';
        }
        if (baseType === 'INTEGER' || baseType === 'INT') {
            return 'NUMBER(10,0)';
        }
        if (baseType === 'BOOLEAN') {
            return 'NUMBER(1)';
        }
        if (baseType === 'VARCHAR' || baseType === 'NVARCHAR') {
            return 'VARCHAR2(255 CHAR)';
        }
        if (baseType === 'TEXT') {
            return 'CLOB';
        }
        if (baseType === 'DATETIME') {
            return 'TIMESTAMP';
        }

        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return buildBatchCreateTablePreview(oracleBatchImportConfig, input.targetTable, input.connectionDetails, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return buildBatchLoadPreview(
            oracleBatchImportConfig,
            input.targetTable,
            input.connectionDetails,
            input.columns,
            input.previewRows,
            input.decimalDelimiter,
        );
    }
}

export const oracleImportWizardAdapter = new OracleImportWizardAdapter();
