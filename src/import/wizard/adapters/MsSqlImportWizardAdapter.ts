import {
    buildCreateTableSql,
    buildInsertSql,
    parseMsSqlTargetTable,
} from '../../mssqlImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, getBaseImportTypeName, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class MsSqlImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'mssql' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);

        if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
            return 'DATETIME2';
        }
        if (baseType === 'BOOLEAN') {
            return 'BIT';
        }
        if (baseType === 'TEXT') {
            return 'NVARCHAR(4000)';
        }
        if (baseType === 'VARCHAR') {
            return normalized.replace(/^VARCHAR/i, 'NVARCHAR');
        }

        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        const target = parseMsSqlTargetTable(input.targetTable, input.connectionDetails);
        return buildCreateTableSql(target, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        if (input.previewRows.length === 0) {
            return undefined;
        }

        const target = parseMsSqlTargetTable(input.targetTable, input.connectionDetails);
        const sql = buildInsertSql(target, input.columns, input.previewRows.slice(0, 3), input.decimalDelimiter);
        return `${sql}\n-- Preview shows sample rows only. Execution inserts all selected rows in batches.`;
    }
}

export const msSqlImportWizardAdapter = new MsSqlImportWizardAdapter();
