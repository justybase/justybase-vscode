import { formatIdentifierForSql } from '../../../utils/identifierUtils';
import {
    importDataToNetezzaAdvanced,
    normalizeDataType,
} from '../../dataImporter';
import type { CreateTablePreviewInput, ImportExecutionInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import {
    BaseImportWizardAdapter,
    formatQualifiedImportTarget,
    getBaseImportTypeName,
} from './DatabaseImportWizardAdapter';

export class NetezzaImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'netezza' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        const normalized = normalizeDataType(typeName);
        const baseType = getBaseImportTypeName(normalized);

        if (baseType === 'DATETIME') {
            return 'TIMESTAMP';
        }
        if (baseType === 'VARCHAR') {
            return normalized.replace(/^VARCHAR/i, 'NVARCHAR');
        }
        if (baseType === 'TEXT') {
            return 'NVARCHAR(1024)';
        }

        return normalized;
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        const delegate = input.importer?.getDelegate();
        if (delegate && typeof delegate.generateStandaloneCreateTableSql === 'function') {
            return delegate.generateStandaloneCreateTableSql();
        }

        const columnSql = input.columns
            .map((column) => `    ${formatIdentifierForSql(column.columnName, this.kind)} ${normalizeDataType(column.dataType)}`)
            .join(',\n');
        return `CREATE TABLE ${formatQualifiedImportTarget(input.targetTable, this.kind)} (\n${columnSql}\n) DISTRIBUTE ON RANDOM;`;
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        const delegate = input.importer?.getDelegate();
        if (delegate && typeof delegate.generateLoadIntoExistingTableSql === 'function') {
            return delegate.generateLoadIntoExistingTableSql();
        }

        return undefined;
    }

    public async execute(input: ImportExecutionInput) {
        return importDataToNetezzaAdvanced(
            input.filePath,
            input.targetTable,
            input.connectionDetails,
            input.progressCallback,
            input.timeoutSeconds,
            input.columnOptions,
        );
    }
}

export const netezzaImportWizardAdapter = new NetezzaImportWizardAdapter();
