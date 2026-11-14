import type { DatabaseImportWizardAdapter } from './adapters/DatabaseImportWizardAdapter';
import type {
    ImportWizardCellIssue,
    ImportWizardColumn,
    ImportWizardValidationSummary,
} from './ImportWizardState';
import { createImportCellValidator } from './importCellValidation';
import type { ImportTargetValidationOverride } from './existingTableTargets';

export interface ImportValidationOptions {
    /** Existing-table target types, keyed by source column index. */
    targetOverrides?: ReadonlyMap<number, ImportTargetValidationOverride>;
}

export class ImportValidationService {
    public validate(
        columns: readonly ImportWizardColumn[],
        previewRows: readonly string[][],
        validationSampleSize: number,
        adapter: DatabaseImportWizardAdapter,
        decimalDelimiter?: string,
        options?: ImportValidationOptions,
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

            const targetOverride = options?.targetOverrides?.get(column.sourceIndex);
            // Catalog types are authoritative for existing-table imports, so
            // do not validate the client-side inferred type in that mode.
            if (!targetOverride) {
                const typeIssues = adapter.validateTypeOverride(column.selectedType);
                for (const typeIssue of typeIssues) {
                    warnings.push(`${column.targetName}: ${typeIssue.message}`);
                    if (typeIssue.severity === 'error') {
                        hasErrors = true;
                    }
                }
            }
        }

        const rowLimit = Math.min(validationSampleSize, previewRows.length);
        const validators = columns.map(column => {
            if (!column.included) {
                return null;
            }
            const targetOverride = options?.targetOverrides?.get(column.sourceIndex);
            return createImportCellValidator(
                targetOverride?.dataType ?? column.selectedType,
                decimalDelimiter,
            );
        });
        for (let rowIndex = 0; rowIndex < rowLimit; rowIndex += 1) {
            const row = previewRows[rowIndex] || [];
            for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
                const column = columns[columnIndex];
                const validator = validators[columnIndex];
                const targetOverride = options?.targetOverrides?.get(column.sourceIndex);
                const notNull = targetOverride?.nullable === false;
                if (!validator && !notNull) {
                    continue;
                }

                const value = row[columnIndex] ?? '';
                let validationMessage = validator ? validator(value) : null;
                if (!validationMessage && notNull && !value.trim()) {
                    validationMessage = 'Column is NOT NULL but the value is empty.';
                }
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
