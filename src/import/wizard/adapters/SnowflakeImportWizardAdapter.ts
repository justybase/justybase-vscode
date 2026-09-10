import { getRequiredDatabaseImportWizardProvider } from '../../../core/connectionFactory';
import type { DatabaseImportWizardInput } from '../../../contracts/database';
import type {
    CreateTablePreviewInput,
    ImportExecutionInput,
    LoadSqlPreviewInput,
} from './DatabaseImportWizardAdapter';
import {
    BaseImportWizardAdapter,
    type ImportWizardValidationIssue,
} from './DatabaseImportWizardAdapter';

export class SnowflakeImportWizardAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'snowflake' as const;

    public constructor() {
        super('workflow');
    }

    public mapInferredType(typeName: string): string {
        return getRequiredDatabaseImportWizardProvider(this.kind).mapInferredType(typeName);
    }

    public validateTypeOverride(typeName: string): ImportWizardValidationIssue[] {
        const issues = super.validateTypeOverride(typeName);
        if (issues.length > 0) {
            return issues;
        }

        return [];
    }

    public buildCreateTableSql(input: CreateTablePreviewInput): string {
        return getRequiredDatabaseImportWizardProvider(this.kind).buildCreateTableSql(
            this.toProviderInput(input),
        );
    }

    public buildLoadSql(input: LoadSqlPreviewInput): string | undefined {
        return getRequiredDatabaseImportWizardProvider(this.kind).buildLoadSql?.(
            this.toProviderInput(input),
        );
    }

    public buildExecutionPlan(input: LoadSqlPreviewInput) {
        return getRequiredDatabaseImportWizardProvider(this.kind).buildExecutionPlan(
            this.toProviderInput(input),
        );
    }

    public async execute(input: ImportExecutionInput) {
        const provider = getRequiredDatabaseImportWizardProvider(this.kind);
        if (provider.createResult) {
            return provider.createResult({
                filePath: input.filePath,
                targetTable: input.targetTable,
                columnOptions: input.columnOptions,
            });
        }

        return super.execute(input);
    }

    private toProviderInput(input: CreateTablePreviewInput): DatabaseImportWizardInput {
        const loadInput = input as LoadSqlPreviewInput;
        return {
            filePath: input.filePath,
            targetTable: input.targetTable,
            columns: input.columns,
            columnOptions: input.columnOptions,
            detectedDelimiter: loadInput.detectedDelimiter,
            decimalDelimiter: loadInput.decimalDelimiter,
        };
    }
}

export const snowflakeImportWizardAdapter = new SnowflakeImportWizardAdapter();
