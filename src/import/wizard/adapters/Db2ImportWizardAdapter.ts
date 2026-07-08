import {
    buildCreateTableSql,
    buildInsertSql,
    parseDb2TargetTable,
} from '../../db2Importer';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter, getBaseImportTypeName, normalizeImportTypeName } from './DatabaseImportWizardAdapter';

export class Db2ImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'db2' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeImportTypeName(typeName);
        const baseType = getBaseImportTypeName(normalized);

        if (baseType === 'DATETIME') {
            return 'TIMESTAMP';
        }
        if (baseType === 'TEXT') {
            return 'VARCHAR(32672)';
        }
        if (baseType === 'NVARCHAR') {
            return normalized.replace(/^NVARCHAR/i, 'VARCHAR');
        }

        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        const target = parseDb2TargetTable(input.targetTable, input.connectionDetails);
        return buildCreateTableSql(target, input.columns);
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        if (input.previewRows.length === 0) {
            return undefined;
        }

        const target = parseDb2TargetTable(input.targetTable, input.connectionDetails);
        const sql = buildInsertSql(target, input.columns, input.previewRows.slice(0, 3), input.decimalDelimiter);
        return `${sql}\n-- Preview shows sample rows only. Execution inserts all selected rows in batches.`;
    }
}

export const db2ImportWizardAdapter = new Db2ImportWizardAdapter();
