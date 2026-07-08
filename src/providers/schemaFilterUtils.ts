import type { ColumnMetadata } from '../metadata/types';

export function buildSchemaFilterRegex(filter: string): RegExp | undefined {
    const trimmed = filter.trim();
    if (!trimmed) {
        return undefined;
    }

    try {
        const regexPattern = trimmed
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(regexPattern, 'i');
    } catch {
        return undefined;
    }
}

export function matchesSchemaFilter(
    regex: RegExp | undefined,
    ...values: Array<string | undefined | null>
): boolean {
    if (!regex) {
        return true;
    }

    return values.some((value) => {
        const trimmed = value?.trim();
        return trimmed ? regex.test(trimmed) : false;
    });
}

export function getColumnFilterTexts(column: ColumnMetadata): string[] {
    const name = column.label || column.ATTNAME;
    const description =
        (typeof column.documentation === 'string' ? column.documentation : undefined)
        ?? (typeof column.DESCRIPTION === 'string' ? column.DESCRIPTION : undefined);
    const dataType = column.detail || column.FORMAT_TYPE;
    return [name, description, dataType].filter((value): value is string => Boolean(value));
}

export function columnMatchesSchemaFilter(
    regex: RegExp | undefined,
    column: ColumnMetadata,
): boolean {
    if (!regex) {
        return true;
    }

    return matchesSchemaFilter(regex, ...getColumnFilterTexts(column));
}

export function tableMatchesSchemaFilter(options: {
    regex: RegExp | undefined;
    tableName: string;
    tableDescription?: string;
    columns?: ColumnMetadata[];
}): boolean {
    if (!options.regex) {
        return true;
    }

    if (matchesSchemaFilter(options.regex, options.tableName, options.tableDescription)) {
        return true;
    }

    return options.columns?.some((column) => columnMatchesSchemaFilter(options.regex, column)) ?? false;
}

export function columnVisibleInSchemaFilter(options: {
    regex: RegExp | undefined;
    tableName: string;
    tableDescription?: string;
    column: ColumnMetadata;
}): boolean {
    if (!options.regex) {
        return true;
    }

    if (matchesSchemaFilter(options.regex, options.tableName, options.tableDescription)) {
        return true;
    }

    return columnMatchesSchemaFilter(options.regex, options.column);
}
