import type { DatabaseImportWizardAdapter } from './adapters/DatabaseImportWizardAdapter';
import type {
    ImportWizardCellIssue,
    ImportWizardColumn,
    ImportWizardValidationSummary,
} from './ImportWizardState';
import { createImportCellValidator } from './importCellValidation';

export class ImportValidationService {
    public validate(
        columns: readonly ImportWizardColumn[],
        previewRows: readonly string[][],
        validationSampleSize: number,
        adapter: DatabaseImportWizardAdapter,
        decimalDelimiter?: string,
    ): ImportWizardValidationSummary {
        const warnings: string[] = [];
        const issues: ImportWizardCellIssue[] = [];
        let hasErrors = false;

        const includedColumns = columns.filter((column) => column.included);
        if (includedColumns.length === 0) {
            warnings.push('Select at least one column to import.');
            hasErrors = true;
        }

        const seenTargetNames = new Map<string, string>();
        for (const column of includedColumns) {
            const normalizedTarget = column.targetName.trim().toUpperCase();
            if (!normalizedTarget) {
                warnings.push(`Column "${column.sourceName}" must have a target name.`);
                hasErrors = true;
                continue;
            }

            const existing = seenTargetNames.get(normalizedTarget);
            if (existing) {
                warnings.push(`Duplicate target column name detected: ${column.targetName}.`);
                hasErrors = true;
            } else {
                seenTargetNames.set(normalizedTarget, column.targetName);
            }

            const typeIssues = adapter.validateTypeOverride(column.selectedType);
            for (const typeIssue of typeIssues) {
                warnings.push(`${column.targetName}: ${typeIssue.message}`);
                if (typeIssue.severity === 'error') {
                    hasErrors = true;
                }
            }
        }

        const rowLimit = Math.min(validationSampleSize, previewRows.length);
        const validators = columns.map(column =>
            column.included
                ? createImportCellValidator(column.selectedType, decimalDelimiter)
                : null,
        );
        for (let rowIndex = 0; rowIndex < rowLimit; rowIndex += 1) {
            const row = previewRows[rowIndex] || [];
            for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
                const validator = validators[columnIndex];
                if (!validator) {
                    continue;
                }

                const value = row[columnIndex] ?? '';
                const validationMessage = validator(value);
                if (!validationMessage) {
                    continue;
                }

                issues.push({
                    rowIndex,
                    columnIndex,
                    sourceIndex: columns[columnIndex].sourceIndex,
                    severity: 'error',
                    message: validationMessage,
                    value,
                });
                hasErrors = true;
            }
        }

        return { issues, warnings, hasErrors };
    }
}
