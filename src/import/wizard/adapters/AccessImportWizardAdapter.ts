import {
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
} from '../../batchImportSupport';
import { accessBatchImportConfig, mapImportTypeToAccessType } from '../../accessImporter';
import type { CreateTablePreviewInput, LoadSqlPreviewInput } from './DatabaseImportWizardAdapter';
import { BaseImportWizardAdapter } from './DatabaseImportWizardAdapter';

export class AccessImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'access' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        // Keep the wizard preview identical to batch execution; ACCDB is the
        // default target because the wizard cannot know the file extension
        // until execution, and BIGINT execution is validated there.
        return mapImportTypeToAccessType(typeName, true);
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
