import type {
    ImportExistingTableState,
    ImportTargetColumn,
    ImportWizardColumn,
    ImportWizardState,
} from './ImportWizardState';

export interface ExistingTableMappingValidation {
    /** True when the wizard is actively appending to an existing table. */
    active: boolean;
    errors: string[];
    warnings: string[];
}

export interface ImportTargetValidationOverride {
    dataType: string;
    nullable: boolean;
    targetName: string;
}

function targetKey(name: string): string {
    return name.trim().toUpperCase();
}

export function isExistingTableMappingActive(
    state: Pick<ImportWizardState, 'createTable' | 'canMapExistingTableColumns'>,
): boolean {
    return !state.createTable && state.canMapExistingTableColumns;
}

export function findTargetColumn(
    targetColumns: readonly ImportTargetColumn[],
    name: string,
): ImportTargetColumn | undefined {
    const key = targetKey(name);
    return targetColumns.find((column) => targetKey(column.name) === key);
}

function targetLookup(
    targetColumns: readonly ImportTargetColumn[],
): Map<string, ImportTargetColumn> {
    const lookup = new Map<string, ImportTargetColumn>();
    for (const column of targetColumns) {
        const key = targetKey(column.name);
        if (!lookup.has(key)) {
            lookup.set(key, column);
        }
    }
    return lookup;
}

/**
 * Map source columns onto an existing target catalog.
 *
 * Manual mappings are preserved when the target still exists. Otherwise the
 * source column falls back to its normalized header name and then its raw
 * source name. Columns with no match stay visible but are excluded until the
 * user maps them explicitly.
 */
export function applyAutoTargetMapping(
    columns: readonly ImportWizardColumn[],
    targetColumns: readonly ImportTargetColumn[],
): void {
    const lookup = targetLookup(targetColumns);
    const used = new Set<string>();

    for (const column of columns) {
        if (!column.included) {
            continue;
        }

        const current = lookup.get(targetKey(column.targetName));
        if (current && !used.has(targetKey(current.name))) {
            column.targetName = current.name;
            used.add(targetKey(current.name));
            continue;
        }

        const byDefault = lookup.get(targetKey(column.defaultTargetName));
        const bySource = lookup.get(targetKey(column.sourceName));
        const target = byDefault ?? bySource;
        if (target && !used.has(targetKey(target.name))) {
            column.targetName = target.name;
            used.add(targetKey(target.name));
            continue;
        }

        column.included = false;
        column.targetName = column.defaultTargetName;
    }
}

/**
 * Map one source column to a catalog target. An empty target unmaps the
 * source column. Mapping to a target that is already used unmaps the previous
 * source so the generated INSERT never lists a target twice.
 */
export function mapSourceColumnToTarget(
    columns: readonly ImportWizardColumn[],
    targetColumns: readonly ImportTargetColumn[],
    sourceIndex: number,
    targetName: string | undefined,
): ImportWizardColumn {
    const column = columns.find((item) => item.sourceIndex === sourceIndex);
    if (!column) {
        throw new Error(`Unknown import column: ${sourceIndex}`);
    }

    const normalizedTargetName = targetName?.trim() ?? '';
    if (!normalizedTargetName) {
        column.included = false;
        column.targetName = column.defaultTargetName;
        return column;
    }

    const target = findTargetColumn(targetColumns, normalizedTargetName);
    if (!target) {
        throw new Error(`Target column ${normalizedTargetName} was not found in the destination table.`);
    }

    const key = targetKey(target.name);
    for (const other of columns) {
        if (
            other !== column
            && other.included
            && targetKey(other.targetName) === key
        ) {
            other.included = false;
            other.targetName = other.defaultTargetName;
        }
    }

    column.targetName = target.name;
    column.included = true;
    return column;
}

/** Target type/nullability for every mapped source column. */
export function buildTargetValidationOverrides(
    state: ImportWizardState,
): Map<number, ImportTargetValidationOverride> {
    const overrides = new Map<number, ImportTargetValidationOverride>();
    if (!isExistingTableMappingActive(state) || state.existingTable.status !== 'ready') {
        return overrides;
    }

    const lookup = targetLookup(state.existingTable.columns);
    for (const column of state.columns) {
        if (!column.included) {
            continue;
        }
        const target = lookup.get(targetKey(column.targetName));
        if (!target) {
            continue;
        }
        overrides.set(column.sourceIndex, {
            dataType: target.dataType,
            nullable: target.nullable,
            targetName: target.name,
        });
    }
    return overrides;
}

/**
 * Structural preflight for an existing-table import.
 *
 * The target catalog is authoritative: mapped names must exist, a target may
 * only be written once, and every NOT NULL target without a default must be
 * mapped. Optional unmapped targets and ignored source columns are warnings,
 * matching the web/Rust import contract.
 */
export function validateExistingTableMapping(
    state: ImportWizardState,
): ExistingTableMappingValidation {
    if (!isExistingTableMappingActive(state)) {
        return { active: false, errors: [], warnings: [] };
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const existing: ImportExistingTableState = state.existingTable;

    if (existing.status === 'loading') {
        errors.push('Loading the target table columns. Wait for the mapping to finish.');
        return { active: true, errors, warnings };
    }
    if (existing.status === 'idle') {
        errors.push('Load the target table columns before importing into an existing table.');
        return { active: true, errors, warnings };
    }
    if (existing.status === 'error') {
        errors.push(existing.error || 'Could not load the target table columns.');
        return { active: true, errors, warnings };
    }
    if (existing.columns.length === 0) {
        errors.push('The target table has no columns. Check the table name and refresh the metadata cache.');
        return { active: true, errors, warnings };
    }

    const included = state.columns.filter((column) => column.included);

    const lookup = targetLookup(existing.columns);
    const mappedTargets = new Map<string, ImportWizardColumn>();
    for (const column of included) {
        const key = targetKey(column.targetName);
        const target = lookup.get(key);
        if (!target) {
            errors.push(`Target column ${column.targetName} does not exist in ${state.targetTable}.`);
            continue;
        }
        if (mappedTargets.has(key)) {
            errors.push(`Target column ${target.name} is mapped from more than one source column.`);
            continue;
        }
        mappedTargets.set(key, column);
    }

    for (const target of existing.columns) {
        const key = targetKey(target.name);
        if (mappedTargets.has(key)) {
            continue;
        }
        if (!target.nullable && !target.hasDefault) {
            errors.push(`Target column ${target.name} is NOT NULL and has no default; map a source column.`);
        } else if (target.hasDefault) {
            warnings.push(`Target column ${target.name} is not mapped; its default will be used.`);
        } else {
            warnings.push(`Target column ${target.name} is not mapped; NULL will be stored.`);
        }
    }

    if (included.length === 0) {
        errors.push('Map at least one source column to the target table.');
    }

    const unmappedSources = state.columns
        .filter((column) => !column.included)
        .map((column) => column.sourceName);
    if (unmappedSources.length > 0) {
        const preview = unmappedSources.slice(0, 5).join(', ');
        const suffix = unmappedSources.length > 5
            ? ` and ${unmappedSources.length - 5} more`
            : '';
        warnings.push(
            `Source column${unmappedSources.length === 1 ? '' : 's'} ${preview}${suffix} ${unmappedSources.length === 1 ? 'is' : 'are'} not mapped and will be ignored.`,
        );
    }

    return { active: true, errors, warnings };
}
