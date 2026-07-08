import type { DatabaseImportWizardAdapter } from './adapters/DatabaseImportWizardAdapter';
import { getBaseImportTypeName } from './adapters/DatabaseImportWizardAdapter';
import type {
    ImportWizardCellIssue,
    ImportWizardColumn,
    ImportWizardValidationSummary,
} from './ImportWizardState';

function normalizeDateCandidate(value: string): string | null {
    const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    const localMatch = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!localMatch) {
        return null;
    }

    const [, day, month, year] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function normalizeTimestampCandidate(value: string): string | null {
    const normalized = value.replace('T', ' ').trim();
    const isoMatch = normalized.match(
        /^(\d{4}-\d{1,2}-\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
    );
    if (isoMatch) {
        const [, datePart, hour = '00', minute = '00', second = '00'] = isoMatch;
        const normalizedDate = normalizeDateCandidate(datePart);
        return normalizedDate
            ? `${normalizedDate} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`
            : null;
    }

    const localMatch = normalized.match(
        /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
    );
    if (!localMatch) {
        return null;
    }

    const [, day, month, year, hour = '00', minute = '00', second = '00'] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

function isRealDate(value: string): boolean {
    const normalized = normalizeDateCandidate(value);
    if (!normalized) {
        return false;
    }

    const [yearText, monthText, dayText] = normalized.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const parsed = new Date(`${normalized}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime())
        && parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() + 1 === month
        && parsed.getUTCDate() === day;
}

function isRealTimestamp(value: string): boolean {
    const normalized = normalizeTimestampCandidate(value);
    if (!normalized) {
        return false;
    }

    const parsed = new Date(normalized.replace(' ', 'T') + 'Z');
    return !Number.isNaN(parsed.getTime());
}

function validateValue(value: string, typeName: string): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const baseType = getBaseImportTypeName(typeName);

    if (['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'NUMBER'].includes(baseType)) {
        return /^[-+]?\d+$/.test(trimmed) ? null : 'Expected an integer value.';
    }

    if (
        [
            'NUMERIC',
            'DECIMAL',
            'REAL',
            'DOUBLE',
            'FLOAT',
            'DOUBLE PRECISION',
            'MONEY',
            'SMALLMONEY',
            'DECFLOAT',
        ].includes(baseType)
    ) {
        return /^[-+]?\d+(?:[.,]\d+)?$/.test(trimmed) ? null : 'Expected a numeric value.';
    }

    if (['BOOLEAN', 'BOOL', 'BIT'].includes(baseType)) {
        return /^(true|false|1|0|yes|no|y|n|t|f)$/i.test(trimmed) ? null : 'Expected a boolean value.';
    }

    if (baseType === 'DATE') {
        return isRealDate(trimmed) ? null : 'Expected a valid date value.';
    }

    if (['TIMESTAMP', 'DATETIME', 'DATETIME2', 'TIMESTAMP_NTZ'].includes(baseType)) {
        return isRealTimestamp(trimmed) ? null : 'Expected a valid timestamp value.';
    }

    return null;
}

export class ImportValidationService {
    public validate(
        columns: readonly ImportWizardColumn[],
        previewRows: readonly string[][],
        validationSampleSize: number,
        adapter: DatabaseImportWizardAdapter,
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
        for (let rowIndex = 0; rowIndex < rowLimit; rowIndex += 1) {
            const row = previewRows[rowIndex] || [];
            for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
                const column = columns[columnIndex];
                if (!column.included) {
                    continue;
                }

                const value = row[columnIndex] ?? '';
                const validationMessage = validateValue(value, column.selectedType);
                if (!validationMessage) {
                    continue;
                }

                issues.push({
                    rowIndex,
                    columnIndex,
                    sourceIndex: column.sourceIndex,
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
