import { getNumericTypeInfo } from './utils.js';

/** Strip grouping separators so "123 456" / "123,456" match compact search "123456". */
const FILTER_SEARCH_GROUPING_PATTERN = /[\s\u00A0\u202F,]/g;

export function compactFilterSearchText(value: string): string {
    return String(value).toLowerCase().replace(FILTER_SEARCH_GROUPING_PATTERN, '');
}

export interface FilterValueSearchText {
    lower: string;
    compact: string;
}

export function createFilterValueSearchText(value: string): FilterValueSearchText {
    const lower = String(value).toLowerCase();
    return {
        lower,
        compact: lower.replace(FILTER_SEARCH_GROUPING_PATTERN, ''),
    };
}

export function matchesFilterValueSearchText(
    displayValue: FilterValueSearchText,
    searchTerm: FilterValueSearchText,
): boolean {
    if (displayValue.lower.includes(searchTerm.lower)) {
        return true;
    }

    return Boolean(searchTerm.compact) && displayValue.compact.includes(searchTerm.compact);
}

export type FilterValueMatcher = (displayValue: string) => boolean;

/** Create a reusable matcher so the search term is normalized only once per filter query. */
export function createFilterValueMatcher(searchTerm: string): FilterValueMatcher {
    const normalizedSearchTerm = createFilterValueSearchText(searchTerm);

    return (displayValue: string): boolean => matchesFilterValueSearchText(
        createFilterValueSearchText(displayValue),
        normalizedSearchTerm,
    );
}

export function parseFilterNumericValue(value: string): number | null {
    if (value === 'NULL') {
        return null;
    }
    const parsed = Number(String(value).replace(FILTER_SEARCH_GROUPING_PATTERN, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

/** Match filter dropdown search against display text, including compact numeric forms (e.g. 20101228 vs 2010 12 28, 123456 vs 123 456). */
export function matchesFilterValueSearch(displayValue: string, searchTerm: string): boolean {
    return createFilterValueMatcher(searchTerm)(displayValue);
}

export function startsWithFilterValueSearch(displayValue: string, searchTerm: string): boolean {
    const normalizedDisplayValue = createFilterValueSearchText(displayValue);
    const normalizedSearchTerm = createFilterValueSearchText(searchTerm);
    if (normalizedDisplayValue.lower.startsWith(normalizedSearchTerm.lower)) {
        return true;
    }

    return Boolean(normalizedSearchTerm.compact)
        && normalizedDisplayValue.compact.startsWith(normalizedSearchTerm.compact);
}

export function endsWithFilterValueSearch(displayValue: string, searchTerm: string): boolean {
    const normalizedDisplayValue = createFilterValueSearchText(displayValue);
    const normalizedSearchTerm = createFilterValueSearchText(searchTerm);
    if (normalizedDisplayValue.lower.endsWith(normalizedSearchTerm.lower)) {
        return true;
    }

    return Boolean(normalizedSearchTerm.compact)
        && normalizedDisplayValue.compact.endsWith(normalizedSearchTerm.compact);
}

function shouldSortFilterValuesNumerically(values: string[], dataType: string | undefined): boolean {
    if (getNumericTypeInfo(dataType).isNumeric) {
        return true;
    }

    return values.some((value) => {
        if (value === 'NULL') {
            return false;
        }
        const parsed = parseFilterNumericValue(value);
        return parsed !== null;
    });
}

export function sortFilterValues(values: string[], dataType: string | undefined): string[] {
    if (!shouldSortFilterValuesNumerically(values, dataType)) {
        return values.sort((a, b) => a.localeCompare(b));
    }

    return values.sort((a, b) => {
        const aNum = parseFilterNumericValue(a);
        const bNum = parseFilterNumericValue(b);
        if (aNum === null && bNum === null) {
            return a.localeCompare(b);
        }
        if (aNum === null) {
            return 1;
        }
        if (bNum === null) {
            return -1;
        }
        return aNum - bNum;
    });
}
